import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const EMULATOR_HOST = '127.0.0.1:8088';
const EMULATOR_PROJECT_ID = 'demo-caffix-emulator';

process.env.FIRESTORE_EMULATOR_HOST = EMULATOR_HOST;
process.env.FIREBASE_PROJECT_ID = EMULATOR_PROJECT_ID;
delete process.env.VERCEL;
delete process.env.VERCEL_ENV;
delete process.env.STRICT_FIREBASE_VALIDATION;
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'phase_vps_relay_jwt_secret_123456';
process.env.KIOSK_SECRET = 'phase_vps_relay_kiosk_secret_123456';
process.env.CRON_SECRET = 'phase_vps_relay_cron_secret_123456';
delete process.env.RAZORPAY_KEY_ID;
delete process.env.RAZORPAY_KEY_SECRET;
delete process.env.RAZORPAY_WEBHOOK_SECRET;

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { initDB, getDB } = require('../config/db');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const {
  ensureFirebaseReady,
  getFirestoreInstance,
  resetFirestoreSeedStateForTesting
} = require('../utils/firebase');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { clearSyncedRefundsStore, getRefundsByOrderId } = require('../utils/refunds');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const {
  executeGatewayRefund,
  setRazorpayRefundClientForTesting,
  setRefundRelayTransportForTesting
} = require('../utils/razorpayRefundClient');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const {
  processAutoRefundForOrder,
  reconcilePendingRefundsForOrder
} = require('../services/autoRefundService');

async function clearEmulatorDatabase(): Promise<void> {
  const res = await fetch(
    `http://${EMULATOR_HOST}/emulator/v1/projects/${EMULATOR_PROJECT_ID}/databases/(default)/documents`,
    { method: 'DELETE' }
  );
  if (!res.ok) {
    throw new Error(`Failed to clear emulator: HTTP ${res.status}`);
  }
}

async function seedOrder(firestore: any, order: Record<string, any>): Promise<void> {
  await firestore.collection('orders').doc(order.id).set(order);
}

async function runTests(): Promise<void> {
  console.log('\n======================================================================');
  console.log('Running CAFFIX — Ubuntu VPS Refund Relay Integration Tests');
  console.log('======================================================================\n');

  await initDB();
  const db = getDB();
  ensureFirebaseReady();
  const firestore = getFirestoreInstance();
  assert.ok(firestore, 'Firestore Emulator must be running on 127.0.0.1:8088');

  const testSecret = 'vps_relay_hmac_secret_min_32_chars_ok';
  const relayUrl = 'https://relay.caffix.test';

  try {
    setRazorpayRefundClientForTesting(null);

    // 1. Missing REFUND_RELAY_URL fails closed
    delete process.env.REFUND_RELAY_URL;
    process.env.REFUND_RELAY_SECRET = testSecret;
    process.env.RAZORPAY_REFUNDS_ENABLED = 'true';
    await assert.rejects(
      () =>
        executeGatewayRefund({
          orderId: 'ORD-CFG-1',
          paymentId: 'pay_live_cfg1',
          amountPaise: 10000,
          idempotencyKey: 'auto_refund:ORD-CFG-1:PRE_DISPENSE'
        }),
      (err: any) => err?.statusCode === 503 && String(err?.message).includes('REFUND_RELAY_URL')
    );

    // 2. Missing REFUND_RELAY_SECRET fails closed
    process.env.REFUND_RELAY_URL = relayUrl;
    delete process.env.REFUND_RELAY_SECRET;
    await assert.rejects(
      () =>
        executeGatewayRefund({
          orderId: 'ORD-CFG-2',
          paymentId: 'pay_live_cfg2',
          amountPaise: 10000,
          idempotencyKey: 'auto_refund:ORD-CFG-2:PRE_DISPENSE'
        }),
      (err: any) => err?.statusCode === 503 && String(err?.message).includes('REFUND_RELAY_SECRET')
    );

    // 3. RAZORPAY_REFUNDS_ENABLED=false prevents submission
    process.env.REFUND_RELAY_URL = relayUrl;
    process.env.REFUND_RELAY_SECRET = testSecret;
    process.env.RAZORPAY_REFUNDS_ENABLED = 'false';
    let relayCalls = 0;
    setRefundRelayTransportForTesting(async () => {
      relayCalls += 1;
      return { status: 200, text: async () => '{}' };
    });
    await assert.rejects(
      () =>
        executeGatewayRefund({
          orderId: 'ORD-CFG-3',
          paymentId: 'pay_live_cfg3',
          amountPaise: 10000,
          idempotencyKey: 'auto_refund:ORD-CFG-3:PRE_DISPENSE'
        }),
      (err: any) => err?.statusCode === 503 && String(err?.message).includes('RAZORPAY_REFUNDS_ENABLED')
    );
    assert.strictEqual(relayCalls, 0);

    // 4. Missing RAZORPAY_REFUNDS_ENABLED prevents submission
    delete process.env.RAZORPAY_REFUNDS_ENABLED;
    await assert.rejects(
      () =>
        executeGatewayRefund({
          orderId: 'ORD-CFG-4',
          paymentId: 'pay_live_cfg4',
          amountPaise: 10000,
          idempotencyKey: 'auto_refund:ORD-CFG-4:PRE_DISPENSE'
        }),
      (err: any) => err?.statusCode === 503
    );
    assert.strictEqual(relayCalls, 0);
    console.log('   PASS (1-4): Fail-closed config & RAZORPAY_REFUNDS_ENABLED gate verified.');

    // Enable for mocked VPS relay transport tests (zero real HTTP calls!)
    process.env.RAZORPAY_REFUNDS_ENABLED = 'true';

    // 5 & 6. HMAC timestamp, lowercase hex signature on exact raw JSON body, redirect: 'error', no unsupported fields
    let capturedRequest: { url: string; headers: Record<string, string>; body: string; redirect?: string } | null = null as any;
    setRefundRelayTransportForTesting(
      async (url: string, init: { headers: Record<string, string>; body: string; redirect: string }) => {
        capturedRequest = { url, headers: init.headers, body: init.body, redirect: init.redirect };
      return {
        status: 200,
        text: async () =>
          JSON.stringify({
            status: 'CONFIRMED',
            refund: {
              id: 'rfnd_vps_hmac_1',
              payment_id: 'pay_live_hmac_1',
              amount: 10000,
              status: 'processed'
            }
          })
      };
    });

    const hmacRes = await executeGatewayRefund({
      orderId: 'ORD-HMAC-1',
      paymentId: 'pay_live_hmac_1',
      amountPaise: 10000,
      receipt: 'RFND-ORD-HMAC-1',
      idempotencyKey: 'auto_refund:ORD-HMAC-1:CONFIRMED_PRE_DISPENSE_FAILURE',
      notes: { extra: 'ignored_not_sent_to_vps' }
    });
    assert.strictEqual(hmacRes.success, true);
    assert.strictEqual(hmacRes.status, 'PROCESSED');
    assert.strictEqual(hmacRes.razorpayRefundId, 'rfnd_vps_hmac_1');
    assert.ok(capturedRequest);
    assert.strictEqual(capturedRequest!.url, `${relayUrl}/v1/refunds`);
    assert.strictEqual(capturedRequest!.redirect, 'error', 'fetch must set redirect: error');
    const ts = capturedRequest!.headers['X-Relay-Timestamp'];
    const sig = capturedRequest!.headers['X-Relay-Signature'];
    assert.ok(/^\d{10,}$/.test(ts), 'Timestamp must be Unix seconds');
    assert.ok(/^[0-9a-f]{64}$/.test(sig), 'Signature must be lowercase 64-char hex');
    const expectedSig = crypto
      .createHmac('sha256', testSecret)
      .update(Buffer.concat([Buffer.from(ts, 'utf8'), Buffer.from('.', 'utf8'), Buffer.from(capturedRequest!.body, 'utf8')]))
      .digest('hex');
    assert.strictEqual(sig, expectedSig, 'HMAC must match exact raw body bytes');
    assert.deepStrictEqual(Object.keys(JSON.parse(capturedRequest!.body)).sort(), [
      'amount',
      'idempotency_key',
      'payment_id'
    ]);
    console.log('   PASS (5-7): HMAC-SHA256 signing on exact raw JSON body & HTTP 200 CONFIRMED verified.');

    // 8. HTTP 202 UNCERTAIN
    setRefundRelayTransportForTesting(async () => ({
      status: 202,
      text: async () =>
        JSON.stringify({
          status: 'UNCERTAIN',
          message: 'Do not retry. Reconcile this request.',
          idempotency_key: 'auto_refund:ORD-202:PRE'
        })
    }));
    const res202 = await executeGatewayRefund({
      orderId: 'ORD-202',
      paymentId: 'pay_live_202',
      amountPaise: 10000,
      idempotencyKey: 'auto_refund:ORD-202:PRE'
    });
    assert.strictEqual(res202.success, false);
    assert.strictEqual(res202.status, 'PENDING');
    assert.strictEqual(res202.isUncertain, true);

    // 9. HTTP 409 conflict (payment lock -> PENDING) vs HTTP 409 REJECTED (-> FAILED)
    setRefundRelayTransportForTesting(async () => ({
      status: 409,
      text: async () => JSON.stringify({ status: 'RESERVED', message: 'Payment locked' })
    }));
    const res409Lock = await executeGatewayRefund({
      orderId: 'ORD-409-LOCK',
      paymentId: 'pay_live_409_lock',
      amountPaise: 10000,
      idempotencyKey: 'auto_refund:ORD-409-LOCK:PRE'
    });
    assert.strictEqual(res409Lock.status, 'PENDING');
    assert.strictEqual(res409Lock.isUncertain, true);

    setRefundRelayTransportForTesting(async () => ({
      status: 409,
      text: async () => JSON.stringify({ status: 'REJECTED', error_code: 'BAD_REQUEST_ERROR', message: 'Already refunded' })
    }));
    const res409Reject = await executeGatewayRefund({
      orderId: 'ORD-409-REJ',
      paymentId: 'pay_live_409_rej',
      amountPaise: 10000,
      idempotencyKey: 'auto_refund:ORD-409-REJ:PRE'
    });
    assert.strictEqual(res409Reject.status, 'FAILED');

    // 10. HTTP 403 disabled
    setRefundRelayTransportForTesting(async () => ({
      status: 403,
      text: async () => JSON.stringify({ detail: 'Live refund submission disabled' })
    }));
    const res403 = await executeGatewayRefund({
      orderId: 'ORD-403',
      paymentId: 'pay_live_403',
      amountPaise: 10000,
      idempotencyKey: 'auto_refund:ORD-403:PRE'
    });
    assert.strictEqual(res403.status, 'PENDING');
    assert.strictEqual(res403.httpStatusCode, 403);
    assert.strictEqual(res403.isUncertain, true);

    // 11. Network timeout
    setRefundRelayTransportForTesting(async () => {
      const e: any = new Error('The operation was aborted due to timeout');
      e.name = 'AbortError';
      throw e;
    });
    const resTimeout = await executeGatewayRefund({
      orderId: 'ORD-TMO',
      paymentId: 'pay_live_tmo',
      amountPaise: 10000,
      idempotencyKey: 'auto_refund:ORD-TMO:PRE'
    });
    assert.strictEqual(resTimeout.status, 'PENDING');
    assert.strictEqual(resTimeout.isTimeout, true);

    // 12. Connection reset & invalid JSON
    setRefundRelayTransportForTesting(async () => {
      const e: any = new Error('socket hang up');
      e.code = 'ECONNRESET';
      throw e;
    });
    const resReset = await executeGatewayRefund({
      orderId: 'ORD-RST',
      paymentId: 'pay_live_rst',
      amountPaise: 10000,
      idempotencyKey: 'auto_refund:ORD-RST:PRE'
    });
    assert.strictEqual(resReset.status, 'PENDING');
    assert.strictEqual(resReset.isTimeout, true);

    setRefundRelayTransportForTesting(async () => ({
      status: 502,
      text: async () => '<html>Bad Gateway</html>'
    }));
    const resInvalidJson = await executeGatewayRefund({
      orderId: 'ORD-JSON',
      paymentId: 'pay_live_json',
      amountPaise: 10000,
      idempotencyKey: 'auto_refund:ORD-JSON:PRE'
    });
    assert.strictEqual(resInvalidJson.status, 'PENDING');
    assert.strictEqual(resInvalidJson.isUncertain, true);
    console.log('   PASS (8-12): 202 UNCERTAIN, 409 lock vs REJECTED, 403, timeout, reset & invalid JSON verified.');

    // 13-18. Firestore Emulator: Idempotency, CFX-MC-01 & CFX-MC-02, and Reconciliation (CONFIRMED/REJECTED/UNCERTAIN)
    await clearEmulatorDatabase();
    resetFirestoreSeedStateForTesting();
    clearSyncedRefundsStore();

    const oldIso = new Date(Date.now() - 10 * 60_000).toISOString();
    await seedOrder(firestore, {
      id: 'CFX-VPS-MC1',
      machine_id: 'CFX-MC-01',
      product_id: 1,
      amount: 100,
      captured_amount_paise: 10000,
      status: 'PAID',
      dispense_status: 'FAILED',
      dispensed: false,
      dispense_outcome: 'NOT_DISPENSED',
      failure_stage: 'PRE_DISPENSE',
      command_transmitted: false,
      refund_status: 'NONE',
      total_refunded_amount_paise: 0,
      pending_refund_amount_paise: 0,
      razorpay_order_id: 'order_vps_mc1',
      razorpay_payment_id: 'pay_vps_mc1',
      created_at: oldIso,
      paid_at: oldIso,
      updated_at: oldIso
    });
    await seedOrder(firestore, {
      id: 'CFX-VPS-MC2',
      machine_id: 'CFX-MC-02',
      product_id: 1,
      amount: 100,
      captured_amount_paise: 10000,
      status: 'PAID',
      dispense_status: 'FAILED',
      dispensed: false,
      dispense_outcome: 'NOT_DISPENSED',
      failure_stage: 'PRE_DISPENSE',
      command_transmitted: false,
      refund_status: 'NONE',
      total_refunded_amount_paise: 0,
      pending_refund_amount_paise: 0,
      razorpay_order_id: 'order_vps_mc2',
      razorpay_payment_id: 'pay_vps_mc2',
      created_at: oldIso,
      paid_at: oldIso,
      updated_at: oldIso
    });

    // MC-01 returns 202 UNCERTAIN first -> stays PENDING, duplicate processAutoRefundForOrder makes 0 extra VPS calls
    let mc1RefundCalls = 0;
    const hitEndpoints: string[] = [];
    setRefundRelayTransportForTesting(async (url: string) => {
      hitEndpoints.push(url);
      if (url.endsWith('/v1/refunds')) {
        mc1RefundCalls += 1;
        return {
          status: 202,
          text: async () => JSON.stringify({ status: 'UNCERTAIN', message: 'Reconcile later' })
        };
      }
      return {
        status: 202,
        text: async () => JSON.stringify({ status: 'UNCERTAIN' })
      };
    });

    const mc1First = await processAutoRefundForOrder(db, 'CFX-VPS-MC1');
    assert.strictEqual(mc1First.status, 'pending'); // timeout/uncertain leaves PENDING reservation
    assert.strictEqual(mc1RefundCalls, 1);

    const mc1Dup = await processAutoRefundForOrder(db, 'CFX-VPS-MC1');
    assert.strictEqual(mc1Dup.status, 'skipped');
    assert.strictEqual(mc1RefundCalls, 1, 'Duplicate call must not resubmit POST /v1/refunds');

    // 15 & 16. Reconcile UNCERTAIN -> stillPending=1 and NEVER calls /v1/refunds
    const mc1Doc = (await firestore.collection('orders').doc('CFX-VPS-MC1').get()).data();
    const recUnc = await reconcilePendingRefundsForOrder(db, mc1Doc);
    assert.strictEqual(recUnc.stillPending, 1);
    assert.strictEqual(mc1RefundCalls, 1, 'Reconciliation must never call /v1/refunds');

    // 13. Reconcile CONFIRMED -> settles PROCESSED
    setRefundRelayTransportForTesting(async (url: string) => {
      assert.ok(url.endsWith('/v1/refunds/reconcile'));
      return {
        status: 200,
        text: async () =>
          JSON.stringify({
            status: 'CONFIRMED',
            refund: {
              id: 'rfnd_vps_rec_mc1',
              payment_id: 'pay_vps_mc1',
              amount: 10000,
              currency: 'INR',
              status: 'processed'
            }
          })
      };
    });
    const recConf = await reconcilePendingRefundsForOrder(db, mc1Doc);
    assert.strictEqual(recConf.settledProcessed, 1);
    const mc1Settled = (await firestore.collection('orders').doc('CFX-VPS-MC1').get()).data();
    assert.strictEqual(mc1Settled?.refund_status, 'FULL');

    // 14 & 18. CFX-MC-02 returns 202 then reconcile REJECTED -> settles FAILED
    setRefundRelayTransportForTesting(async (url: string) => {
      if (url.endsWith('/v1/refunds')) {
        return { status: 202, text: async () => JSON.stringify({ status: 'UNCERTAIN' }) };
      }
      assert.ok(url.endsWith('/v1/refunds/reconcile'));
      return {
        status: 200,
        text: async () =>
          JSON.stringify({
            status: 'REJECTED',
            error_code: 'BAD_REQUEST_ERROR',
            message: 'Gateway confirmed rejection'
          })
      };
    });
    await processAutoRefundForOrder(db, 'CFX-VPS-MC2');
    const mc2Doc = (await firestore.collection('orders').doc('CFX-VPS-MC2').get()).data();
    const recRej = await reconcilePendingRefundsForOrder(db, mc2Doc);
    assert.strictEqual(recRej.settledFailed, 1);
    const mc2AfterRej = (await firestore.collection('orders').doc('CFX-VPS-MC2').get()).data();
    assert.strictEqual(mc2AfterRej?.refund_status, 'FAILED');
    assert.strictEqual((await getRefundsByOrderId(db, 'CFX-VPS-MC2'))[0].status, 'FAILED');
    console.log('   PASS (13-18): Idempotency, CFX-MC-01/MC-02, and reconcile CONFIRMED/REJECTED/UNCERTAIN verified.');

    // 19. Verify no direct Razorpay refund SDK calls remain in razorpayRefundClient.ts or autoRefundService.ts
    const clientSrc = fs.readFileSync(path.join(__dirname, '../../src/utils/razorpayRefundClient.ts'), 'utf8');
    const serviceSrc = fs.readFileSync(path.join(__dirname, '../../src/services/autoRefundService.ts'), 'utf8');
    assert.ok(!clientSrc.includes("require('razorpay')"), 'razorpayRefundClient.ts must not require razorpay SDK');
    assert.ok(!clientSrc.includes('new Razorpay'), 'razorpayRefundClient.ts must not instantiate Razorpay SDK');
    assert.ok(!serviceSrc.includes('razorpayClient.refunds.fetch'), 'autoRefundService.ts must not call razorpayClient.refunds.fetch');
    assert.ok(!serviceSrc.includes('razorpayClient.payments.fetchRefunds'), 'autoRefundService.ts must not call razorpayClient.payments.fetchRefunds');
    console.log('   PASS (19): Verified zero direct Razorpay refund SDK calls remain in execution/reconciliation paths.');

    // 20. Production HTTPS enforcement & redirect rejection
    const prevNodeEnv = process.env.NODE_ENV;
    const prevVercelEnv = process.env.VERCEL_ENV;
    const prevKeyId = process.env.RAZORPAY_KEY_ID;
    const prevKeySec = process.env.RAZORPAY_KEY_SECRET;
    try {
      process.env.NODE_ENV = 'production';
      process.env.VERCEL_ENV = 'production';
      process.env.RAZORPAY_KEY_ID = 'rzp_live_relay_test_12345';
      process.env.RAZORPAY_KEY_SECRET = 'live_secret_relay_test_12345';
      process.env.RAZORPAY_REFUNDS_ENABLED = 'true';
      process.env.REFUND_RELAY_SECRET = testSecret;

      // 20a. HTTP URL rejected in production
      process.env.REFUND_RELAY_URL = 'http://129.121.184.18';
      await assert.rejects(
        () =>
          executeGatewayRefund({
            orderId: 'ORD-PROD-HTTP',
            paymentId: 'pay_live_prod_http',
            amountPaise: 10000,
            idempotencyKey: 'auto_refund:ORD-PROD-HTTP:PRE'
          }),
        (err: any) => err?.statusCode === 503 && String(err?.message).includes('https://')
      );

      // 20b. HTTPS URL accepted in production
      process.env.REFUND_RELAY_URL = 'https://relay.caffix.test';
      setRefundRelayTransportForTesting(async (_url: string, init: { redirect: string }) => {
        assert.strictEqual(init.redirect, 'error');
        return {
          status: 200,
          text: async () =>
            JSON.stringify({
              status: 'CONFIRMED',
              refund: { id: 'rfnd_prod_https_1', payment_id: 'pay_live_prod_https', amount: 10000, status: 'processed' }
            })
        };
      });
      const prodHttpsRes = await executeGatewayRefund({
        orderId: 'ORD-PROD-HTTPS',
        paymentId: 'pay_live_prod_https',
        amountPaise: 10000,
        idempotencyKey: 'auto_refund:ORD-PROD-HTTPS:PRE'
      });
      assert.strictEqual(prodHttpsRes.success, true);
      assert.strictEqual(prodHttpsRes.status, 'PROCESSED');

      // 20c. Redirect error from fetch(redirect: 'error') rejected safely as PENDING/uncertain
      setRefundRelayTransportForTesting(async () => {
        throw new TypeError('unexpected redirect');
      });
      const prodRedirectRes = await executeGatewayRefund({
        orderId: 'ORD-PROD-REDIR',
        paymentId: 'pay_live_prod_redir',
        amountPaise: 10000,
        idempotencyKey: 'auto_refund:ORD-PROD-REDIR:PRE'
      });
      assert.strictEqual(prodRedirectRes.success, false);
      assert.strictEqual(prodRedirectRes.status, 'PENDING');
      assert.strictEqual(prodRedirectRes.isUncertain, true);
      console.log('   PASS (20): Production HTTPS enforcement & redirect rejection verified.');
    } finally {
      process.env.NODE_ENV = prevNodeEnv;
      if (prevVercelEnv !== undefined) process.env.VERCEL_ENV = prevVercelEnv;
      else delete process.env.VERCEL_ENV;
      if (prevKeyId !== undefined) process.env.RAZORPAY_KEY_ID = prevKeyId;
      else delete process.env.RAZORPAY_KEY_ID;
      if (prevKeySec !== undefined) process.env.RAZORPAY_KEY_SECRET = prevKeySec;
      else delete process.env.RAZORPAY_KEY_SECRET;
    }

    console.log('\nALL UBUNTU VPS REFUND RELAY INTEGRATION TESTS PASSED SUCCESSFULLY!\n');
  } finally {
    setRefundRelayTransportForTesting(null);
    setRazorpayRefundClientForTesting(null);
    delete process.env.REFUND_RELAY_URL;
    delete process.env.REFUND_RELAY_SECRET;
    delete process.env.RAZORPAY_REFUNDS_ENABLED;
  }
}

runTests().catch((err) => {
  console.error('\nVPS REFUND RELAY TESTS FAILED:', err);
  process.exit(1);
});
