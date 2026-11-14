import assert from 'node:assert/strict';
import {
  isOrderPaidOrActive,
  verifyPaymentWithRetry,
  safeCheckAndCancelOrder,
  classifyDispenseProgress,
  pollOrderDispenseProgress,
  finalizeDispensedOrder
} from '../utils/paymentLifecycle.js';

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

async function runTests() {
  // 1. Exponential backoff retry succeeds after transient 503 pending-capture / network error
  {
    const delays = [];
    const urls = [];
    let verifyCalls = 0;

    const fakeFetch = async (url) => {
      urls.push(url);
      if (url.endsWith('/payments/verify')) {
        verifyCalls += 1;
        if (verifyCalls === 1) {
          throw new Error('ECONNRESET');
        }
        if (verifyCalls === 2) {
          return jsonResponse(503, { status: 'error', message: 'Payment not captured yet' });
        }
        return jsonResponse(200, {
          status: 'success',
          data: { id: 'ord_1', status: 'PAID', dispense_status: 'QUEUED' }
        });
      }
      throw new Error(`Unexpected URL: ${url}`);
    };

    const result = await verifyPaymentWithRetry({
      apiBase: 'http://localhost:5000/api',
      token: 'kiosk-tok',
      payload: {
        order_id: 'ord_1',
        razorpay_order_id: 'rp_1',
        razorpay_payment_id: 'pay_1',
        razorpay_signature: 'sig_1'
      },
      fetchImpl: fakeFetch,
      sleepImpl: async (ms) => {
        delays.push(ms);
      },
      maxAttempts: 4,
      initialDelayMs: 500,
      backoffFactor: 2
    });

    assert.equal(result.outcome, 'VERIFIED');
    assert.equal(result.attempts, 3);
    assert.equal(result.order?.status, 'PAID');
    assert.deepEqual(delays, [500, 1000]);
    assert.equal(urls.filter((u) => u.endsWith('/payments/verify')).length, 3);
    console.log('✓ 1. verifyPaymentWithRetry retries 503/network with exponential backoff and succeeds');
  }

  // 2. Bounded exhaustion recovers via authoritative GET /orders/:id if webhook/prior verify settled
  {
    const calls = [];
    const delays = [];
    const fakeFetch = async (url) => {
      calls.push(url);
      if (url.endsWith('/payments/verify')) {
        return jsonResponse(503, { status: 'error', message: 'Gateway timeout' });
      }
      if (url.endsWith('/orders/ord_2')) {
        return jsonResponse(200, {
          status: 'success',
          data: { id: 'ord_2', status: 'PAID', dispense_status: 'QUEUED' }
        });
      }
      throw new Error(`Unexpected URL: ${url}`);
    };

    const result = await verifyPaymentWithRetry({
      apiBase: 'http://localhost:5000/api',
      token: 'kiosk-tok',
      payload: { order_id: 'ord_2' },
      fetchImpl: fakeFetch,
      sleepImpl: async (ms) => delays.push(ms),
      maxAttempts: 3,
      initialDelayMs: 200,
      backoffFactor: 2
    });

    assert.equal(result.outcome, 'VERIFIED');
    assert.equal(result.recoveredViaStatusCheck, true);
    assert.deepEqual(delays, [200, 400]);
    assert.equal(calls.filter((u) => u.endsWith('/payments/verify')).length, 3);
    assert.equal(calls.filter((u) => u.endsWith('/orders/ord_2')).length, 1);
    console.log('✓ 2. verifyPaymentWithRetry recovers PAID order from authoritative status check after bounded retries');
  }

  // 3. Exhausted retries + still PENDING returns UNCERTAIN and never calls /cancel
  {
    const calls = [];
    const fakeFetch = async (url) => {
      calls.push(url);
      if (url.endsWith('/payments/verify')) {
        return jsonResponse(503, { status: 'error', message: 'Temporary verification delay' });
      }
      if (url.endsWith('/orders/ord_3')) {
        return jsonResponse(200, {
          status: 'success',
          data: { id: 'ord_3', status: 'PENDING', dispense_status: 'PENDING' }
        });
      }
      throw new Error(`Unexpected URL: ${url}`);
    };

    const result = await verifyPaymentWithRetry({
      apiBase: 'http://localhost:5000/api',
      token: 'kiosk-tok',
      payload: { order_id: 'ord_3' },
      fetchImpl: fakeFetch,
      sleepImpl: async () => {},
      maxAttempts: 3
    });

    assert.equal(result.outcome, 'UNCERTAIN');
    assert.equal(calls.some((u) => u.includes('/cancel')), false);
    console.log('✓ 3. Transient failure yields UNCERTAIN without calling /cancel');
  }

  // 4. Definitive 400 signature/amount mismatch stops retrying immediately
  {
    let verifyCount = 0;
    const fakeFetch = async (url) => {
      if (url.endsWith('/payments/verify')) {
        verifyCount += 1;
        return jsonResponse(400, { status: 'error', message: 'Invalid signature' });
      }
      if (url.endsWith('/orders/ord_4')) {
        return jsonResponse(200, {
          status: 'success',
          data: { id: 'ord_4', status: 'PENDING' }
        });
      }
      throw new Error(`Unexpected URL: ${url}`);
    };

    const result = await verifyPaymentWithRetry({
      apiBase: 'http://localhost:5000/api',
      token: 'kiosk-tok',
      payload: { order_id: 'ord_4' },
      fetchImpl: fakeFetch,
      sleepImpl: async () => {
        throw new Error('Should not sleep on definitive 400');
      },
      maxAttempts: 4
    });

    assert.equal(verifyCount, 1);
    assert.equal(result.outcome, 'FAILED');
    assert.equal(result.statusCode, 400);
    console.log('✓ 4. Definitive 400 stops retry loop immediately and verifies authoritative status');
  }

  // 5. safeCheckAndCancelOrder blocks /cancel when order is PAID or hasPendingVerification or network fails
  {
    const cancelCallsA = [];
    const resPaid = await safeCheckAndCancelOrder({
      apiBase: 'http://localhost:5000/api',
      token: 'kiosk-tok',
      orderId: 'ord_5a',
      razorpayOrderId: 'rp_5a',
      fetchImpl: async (url) => {
        cancelCallsA.push(url);
        return jsonResponse(200, {
          status: 'success',
          data: { id: 'ord_5a', status: 'PAID', dispense_status: 'QUEUED' }
        });
      }
    });
    assert.equal(resPaid.action, 'ALREADY_PAID');
    assert.equal(cancelCallsA.some((u) => u.endsWith('/cancel')), false);

    const cancelCallsB = [];
    const resPending = await safeCheckAndCancelOrder({
      apiBase: 'http://localhost:5000/api',
      token: 'kiosk-tok',
      orderId: 'ord_5b',
      razorpayOrderId: 'rp_5b',
      hasPendingVerification: true,
      fetchImpl: async (url) => {
        cancelCallsB.push(url);
        return jsonResponse(200, {
          status: 'success',
          data: { id: 'ord_5b', status: 'PENDING' }
        });
      }
    });
    assert.equal(resPending.action, 'UNCERTAIN');
    assert.equal(cancelCallsB.some((u) => u.endsWith('/cancel')), false);

    const cancelCallsC = [];
    const resNetErr = await safeCheckAndCancelOrder({
      apiBase: 'http://localhost:5000/api',
      token: 'kiosk-tok',
      orderId: 'ord_5c',
      razorpayOrderId: 'rp_5c',
      fetchImpl: async (url) => {
        cancelCallsC.push(url);
        throw new Error('offline');
      }
    });
    assert.equal(resNetErr.action, 'UNCERTAIN');
    assert.equal(cancelCallsC.some((u) => u.endsWith('/cancel')), false);

    const cancelCallsD = [];
    const resCancelled = await safeCheckAndCancelOrder({
      apiBase: 'http://localhost:5000/api',
      token: 'kiosk-tok',
      orderId: 'ord_5d',
      razorpayOrderId: 'rp_5d',
      reason: 'customer_cancelled',
      fetchImpl: async (url) => {
        cancelCallsD.push(url);
        if (url.endsWith('/orders/ord_5d')) {
          return jsonResponse(200, { status: 'success', data: { id: 'ord_5d', status: 'PENDING' } });
        }
        if (url.endsWith('/orders/ord_5d/cancel')) {
          return jsonResponse(200, { status: 'success', data: { id: 'ord_5d', status: 'CANCELLED' } });
        }
        throw new Error(`Unexpected URL: ${url}`);
      }
    });
    assert.equal(resCancelled.action, 'CANCELLED');
    assert.deepEqual(cancelCallsD, [
      'http://localhost:5000/api/orders/ord_5d',
      'http://localhost:5000/api/orders/ord_5d/cancel'
    ]);
    console.log('✓ 5. safeCheckAndCancelOrder protects PAID/pending/uncertain orders and only cancels confirmed PENDING orders');
  }

  // 6. S-3 Dispense progress classification, polling, and finalization gate
  {
    assert.equal(classifyDispenseProgress({ status: 'PAID', dispense_status: 'QUEUED' }), 'QUEUED');
    assert.equal(classifyDispenseProgress({ status: 'PREPARING', dispense_status: 'CLAIMING' }), 'DISPENSING');
    assert.equal(classifyDispenseProgress({ status: 'PAID', dispense_status: 'DISPENSING' }), 'DISPENSING');
    assert.equal(classifyDispenseProgress({ status: 'PAID', dispense_status: 'DISPENSED', dispensed: true }), 'DISPENSED');
    assert.equal(classifyDispenseProgress({ status: 'PAID', dispense_status: 'FAILED' }), 'DISPENSE_FAILED');
    assert.equal(classifyDispenseProgress({ status: 'PAID', dispense_status: 'QUEUED', refund_status: 'FULL' }), 'DISPENSE_FAILED');
    assert.equal(isOrderPaidOrActive({ status: 'PENDING', dispense_status: 'DISPENSING' }), true);
    assert.equal(isOrderPaidOrActive({ status: 'FAILED', dispense_status: 'FAILED' }), false);

    const polled = await pollOrderDispenseProgress({
      apiBase: 'http://localhost:5000/api',
      token: 'kiosk-tok',
      orderId: 'ord_6',
      fetchImpl: async () =>
        jsonResponse(200, {
          status: 'success',
          data: { id: 'ord_6', status: 'PAID', dispense_status: 'FAILED' }
        })
    });
    assert.equal(polled.ok, true);
    assert.equal(polled.state, 'DISPENSE_FAILED');

    let finalizeBody = null;
    const finalized = await finalizeDispensedOrder({
      apiBase: 'http://localhost:5000/api',
      token: 'kiosk-tok',
      orderId: 'ord_6',
      fetchImpl: async (url, init) => {
        finalizeBody = JSON.parse(init.body);
        assert.equal(url, 'http://localhost:5000/api/orders/ord_6/status');
        assert.equal(init.method, 'PUT');
        return jsonResponse(200, {
          status: 'success',
          data: { id: 'ord_6', status: 'COMPLETED', dispense_status: 'DISPENSED', dispensed: true }
        });
      }
    });
    assert.equal(finalized.ok, true);
    assert.deepEqual(finalizeBody, { status: 'COMPLETED' });
    assert.equal(finalized.order?.status, 'COMPLETED');
    console.log('✓ 6. S-3 classifyDispenseProgress, pollOrderDispenseProgress, and finalizeDispensedOrder gate COMPLETED until DISPENSED');
  }

  console.log('\nAll kiosk payment lifecycle S-3/S-4 unit tests PASSED.');
}

runTests().catch((err) => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});

