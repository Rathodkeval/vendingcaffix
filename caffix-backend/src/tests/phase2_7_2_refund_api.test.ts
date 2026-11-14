import assert from 'assert';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { getDB, initDB } from '../config/db';
import { getJwtSecret } from '../utils/security';
import {
  calculateRemainingRefundableBalance,
  reconcileOrderRefundRecords,
  reconcileAuthoritativeGatewayRefundOutcome,
  createPendingRefundReservation,
  markRefundProcessed,
  markRefundFailed,
  getRefundById,
  getOrderRefundUnsafeStatus,
  clearOrderRefundUnsafe,
  clearSyncedRefundsStore,
  getRefundsByOrderId,
  RefundRecord
} from '../utils/refunds';
import {
  sanitizeWebhookPayload,
  claimWebhookEvent,
  markWebhookEventProcessed,
  markWebhookEventFailed,
  getWebhookEvent
} from '../utils/webhookLedger';
import { setFirestoreForTesting, isFirestoreActive } from '../utils/firebase';
import {
  executeGatewayRefund,
  resolveRazorpayRefundConfig,
  setRazorpayRefundClientForTesting
} from '../utils/razorpayRefundClient';
import {
  refundOrder,
  updateOrderStatus,
  executeOrderStatusUpdate
} from '../controllers/orderController';
import { handleRazorpayWebhook } from '../controllers/paymentController';
import { ConflictError, BadRequestError, ServiceUnavailableError } from '../utils/errors';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'phase2_7_2_test_secret_key_2026_very_strong';

function generateAuthToken(payload: { id: string | number; email: string; role: 'admin' | 'owner' | 'kiosk'; portal?: 'admin' | 'owner'; scope?: 'kiosk_admin'; machine_id?: string }) {
  const secret = getJwtSecret();
  return jwt.sign(payload, secret, { expiresIn: '1h' });
}

function mockResponse() {
  const res: any = {};
  res.statusCode = 200;
  res.status = (code: number) => {
    res.statusCode = code;
    return res;
  };
  res.json = (data: any) => {
    res.body = data;
    return res;
  };
  return res;
}

async function runPhase2_7_2Tests() {
  console.log('\n========================================================================');
  console.log('Running CAFFIX Phase 2.7.2.1 — Razorpay Refund API & Integration Tests');
  console.log('========================================================================\n');

  const db = await initDB();
  clearSyncedRefundsStore();

  // Test Fixture Teardown: Clean up in strict foreign key order (inventory_ledger -> refunds -> orders)
  await db.run("DELETE FROM inventory_ledger WHERE order_id LIKE 'ORD-%'").catch(() => {});
  await db.run("DELETE FROM refunds WHERE order_id LIKE 'ORD-%'").catch(() => {});
  await db.run("DELETE FROM orders WHERE id LIKE 'ORD-%'").catch(() => {});

  // --------------------------------------------------------------------------
  // Audit Warning W-1: Tombstone on PROCESSED vs PENDING Records
  // --------------------------------------------------------------------------
  console.log('Scenario 1 [W-1 Tombstone on PROCESSED]: Settled refund must NEVER be flipped to FAILED...');
  {
    const orderId = 'ORD-W1-PROC';
    await db.run(
      `INSERT OR REPLACE INTO orders (
        id, product_id, amount, status, machine_id, created_at, razorpay_payment_id, captured_amount_paise
      ) VALUES (?, 1, 100, 'PAID', 'CFX-MC-01', ?, ?, ?)`,
      [orderId, new Date().toISOString(), 'pay_mock_w1', 10000]
    );
    await db.run('DELETE FROM inventory_ledger WHERE order_id = ?', [orderId]).catch(() => {});
    await db.run('DELETE FROM refunds WHERE order_id = ?', [orderId]);
    await db.run(
      `INSERT INTO refunds (
        id, order_id, machine_id, razorpay_payment_id, razorpay_refund_id,
        amount_paise, currency, status, reason, notes, initiated_by,
        source, idempotency_key, error_code, error_description,
        created_at, updated_at, processed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        'RFND-W1-P1', orderId, 'CFX-MC-01', 'pay_mock_w1', 'rfnd_settled_123',
        5000, 'INR', 'PROCESSED', 'test', null, 'admin',
        'SUPER_ADMIN_PORTAL', 'idem_w1_p1', null, null,
        new Date().toISOString(), new Date().toISOString(), new Date().toISOString()
      ]
    );

    // Mock Firestore returning empty list but order has tombstone for RFND-W1-P1
    const mockFsEmpty = {
      collection: () => ({
        doc: () => ({
          collection: () => ({
            get: async () => ({ empty: true, docs: [] })
          })
        })
      })
    };

    const res = await reconcileOrderRefundRecords(
      orderId,
      { id: orderId, captured_amount_paise: 10000, tombstones: ['RFND-W1-P1'] },
      db,
      mockFsEmpty
    );

    const row = await db.get('SELECT * FROM refunds WHERE id = ?', ['RFND-W1-P1']);
    assert.strictEqual(row.status, 'PROCESSED', 'Local settled refund MUST remain PROCESSED');
    assert.strictEqual(res.resolvedTotal, 5000, 'Resolved total must preserve 5000 paise');

    const unsafeStatus = getOrderRefundUnsafeStatus(orderId);
    assert.strictEqual(unsafeStatus.isUnsafe, true, 'Order must be flagged unsafe due to illegal tombstone on settled refund');
    clearOrderRefundUnsafe(orderId);
    console.log('   PASS [W-1 PROCESSED Tombstone]: Settled refund preserved and illegal tombstone flagged unsafe.');
  }

  console.log('Scenario 2 [W-1 Tombstone on PENDING]: Pending reservation transitions cleanly to FAILED...');
  {
    const orderId = 'ORD-W1-PEND';
    await db.run(
      `INSERT OR REPLACE INTO orders (
        id, product_id, amount, status, machine_id, created_at, razorpay_payment_id, captured_amount_paise
      ) VALUES (?, 1, 100, 'PAID', 'CFX-MC-01', ?, ?, ?)`,
      [orderId, new Date().toISOString(), 'pay_mock_w1_pend', 10000]
    );
    await db.run('DELETE FROM inventory_ledger WHERE order_id = ?', [orderId]).catch(() => {});
    await db.run('DELETE FROM refunds WHERE order_id = ?', [orderId]);
    await db.run(
      `INSERT INTO refunds (
        id, order_id, machine_id, razorpay_payment_id, razorpay_refund_id,
        amount_paise, currency, status, reason, notes, initiated_by,
        source, idempotency_key, error_code, error_description,
        created_at, updated_at, processed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        'RFND-W1-PEND-1', orderId, 'CFX-MC-01', 'pay_mock_w1_pend', null,
        3000, 'INR', 'PENDING', 'test', null, 'admin',
        'SUPER_ADMIN_PORTAL', 'idem_w1_pend_1', null, null,
        new Date().toISOString(), new Date().toISOString(), null
      ]
    );

    const mockFsEmpty = {
      collection: () => ({
        doc: () => ({
          collection: () => ({
            get: async () => ({ empty: true, docs: [] })
          })
        })
      })
    };

    const res = await reconcileOrderRefundRecords(
      orderId,
      { id: orderId, captured_amount_paise: 10000, tombstones: ['RFND-W1-PEND-1'] },
      db,
      mockFsEmpty
    );

    const row = await db.get('SELECT * FROM refunds WHERE id = ?', ['RFND-W1-PEND-1']);
    assert.strictEqual(row.status, 'FAILED', 'Pending reservation must transition to FAILED');
    assert.strictEqual(row.error_code, 'TOMBSTONE', 'Error code must be TOMBSTONE');
    assert.strictEqual(res.resolvedPending, 0, 'Pending balance must be released to zero');
    console.log('   PASS [W-1 PENDING Tombstone]: Pending reservation safely cancelled via tombstone.');
  }

  // --------------------------------------------------------------------------
  // Audit Warning W-2: Authoritative Gateway Settlement Override
  // --------------------------------------------------------------------------
  console.log('Scenario 3 [W-2 Gateway Override]: Previously FAILED record promoted with audit trail...');
  {
    const orderId = 'ORD-W2-OVERRIDE';
    await db.run('DELETE FROM inventory_ledger WHERE order_id = ?', [orderId]).catch(() => {});
    await db.run('DELETE FROM refunds WHERE order_id = ?', [orderId]);
    await db.run(
      `INSERT OR REPLACE INTO orders (
        id, product_id, amount, status, machine_id, created_at, razorpay_payment_id, captured_amount_paise
      ) VALUES (?, 1, 100, 'PAID', 'CFX-MC-01', ?, ?, ?)`,
      [orderId, new Date().toISOString(), 'pay_mock_w2', 10000]
    );

    await db.run(
      `INSERT INTO refunds (
        id, order_id, machine_id, razorpay_payment_id, razorpay_refund_id,
        amount_paise, currency, status, reason, notes, initiated_by,
        source, idempotency_key, error_code, error_description,
        created_at, updated_at, processed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        'RFND-W2-TIMEOUT', orderId, 'CFX-MC-01', 'pay_mock_w2', null,
        5000, 'INR', 'FAILED', 'client_refund', 'Initial timeout on edge', 'admin',
        'SUPER_ADMIN_PORTAL', 'idem_w2_timeout', 'GATEWAY_TIMEOUT', 'Socket hangup',
        new Date().toISOString(), new Date().toISOString(), null
      ]
    );

    // Reconcile authoritative gateway outcome
    const gatewayRes = await reconcileAuthoritativeGatewayRefundOutcome(db, {
      orderId,
      refundId: 'RFND-W2-TIMEOUT',
      razorpayPaymentId: 'pay_mock_w2',
      razorpayRefundId: 'rfnd_verified_w2_999',
      amount_paise: 5000,
      processed_at: new Date().toISOString(),
      notes: 'Authoritative Razorpay settlement confirmed'
    });

    assert.strictEqual(gatewayRes.refund.status, 'PROCESSED');
    assert.strictEqual(gatewayRes.refund.razorpay_refund_id, 'rfnd_verified_w2_999');
    assert.ok(gatewayRes.refund.notes?.includes('[AUTHORITATIVE_GATEWAY_OVERRIDE]'), 'Audit trail must contain override header');
    assert.ok(gatewayRes.refund.notes?.includes('Previous status was FAILED'), 'Audit trail must record previous FAILED status');

    const updatedOrder = await db.get('SELECT * FROM orders WHERE id = ?', [orderId]);
    assert.strictEqual(Number(updatedOrder.total_refunded_amount_paise), 5000, 'Order total refunded must accurately reflect 5000 paise');
    assert.strictEqual(updatedOrder.refund_status, 'PARTIAL');
    console.log('   PASS [W-2 Gateway Override]: Previous FAILED promoted to PROCESSED with full audit trail.');
  }

  // --------------------------------------------------------------------------
  // Refund API Client Wrapper Tests (executeGatewayRefund)
  // --------------------------------------------------------------------------
  console.log('Scenario 4 [Refund Client Success]: Instant simulated gateway refund...');
  {
    const res = await executeGatewayRefund({
      orderId: 'ORD-CLIENT-01',
      paymentId: 'pay_mock_client_success',
      amountPaise: 4000,
      receipt: 'RFND-REC-01'
    });
    assert.strictEqual(res.success, true);
    assert.strictEqual(res.status, 'PROCESSED');
    assert.ok(res.razorpayRefundId?.startsWith('rfnd_mock_'));
    assert.strictEqual(res.amountPaise, 4000);
    console.log('   PASS [Refund Client Success]: Successful gateway refund simulated.');
  }

  console.log('Scenario 5 [Refund Client Rejection]: Gateway rejection mapped cleanly...');
  {
    const res = await executeGatewayRefund({
      orderId: 'ORD-CLIENT-02',
      paymentId: 'pay_mock_fail_test',
      amountPaise: 3000
    });
    assert.strictEqual(res.success, false);
    assert.strictEqual(res.status, 'FAILED');
    assert.strictEqual(res.isTimeout, false);
    assert.strictEqual(res.errorCode, 'BAD_REQUEST_ERROR');
    console.log('   PASS [Refund Client Rejection]: Gateway error mapped without crashing.');
  }

  console.log('Scenario 6 [Refund Client Timeout]: Network timeout preserves uncertain status...');
  {
    const res = await executeGatewayRefund({
      orderId: 'ORD-CLIENT-03',
      paymentId: 'pay_mock_timeout_test',
      amountPaise: 2500
    });
    assert.strictEqual(res.success, false);
    assert.strictEqual(res.isTimeout, true);
    assert.strictEqual(res.status, 'PENDING');
    assert.strictEqual(res.errorCode, 'GATEWAY_TIMEOUT');
    console.log('   PASS [Refund Client Timeout]: Timeout returned with isTimeout: true.');
  }

  // --------------------------------------------------------------------------
  // Controller Endpoint (POST /api/orders/:id/refund) Authorization & Guards
  // --------------------------------------------------------------------------
  const adminToken = generateAuthToken({ id: 'admin_1', email: 'admin@caffix.com', role: 'admin', portal: 'admin' });
  const ownerToken = generateAuthToken({ id: 'owner_1', email: 'owner@caffix.com', role: 'owner', portal: 'owner' });
  const kioskToken = generateAuthToken({ id: 'kiosk_1', email: 'kiosk@caffix.com', role: 'kiosk', machine_id: 'CFX-MC-01' });
  const kioskAdminToken = generateAuthToken({ id: 'kiosk_adm', email: 'kiosk_admin@caffix.com', role: 'admin', scope: 'kiosk_admin' });

  console.log('Scenario 7 [RBAC Super Admin]: Super Admin allowed, Owner/Kiosk rejected (403)...');
  {
    const testOrderId = 'ORD-RBAC-07';
    await db.run(
      `INSERT OR REPLACE INTO orders (
        id, product_id, amount, status, machine_id, created_at, razorpay_payment_id, captured_amount_paise
      ) VALUES (?, 1, 100, 'PAID', 'CFX-MC-01', ?, ?, ?)`,
      [testOrderId, new Date().toISOString(), 'pay_mock_rbac_07', 10000]
    );

    // 1. Owner attempt -> 403 Forbidden
    let ownerError: any = null;
    const reqOwner: any = {
      params: { id: testOrderId },
      body: { amount_paise: 2000, reason: 'owner_attempt' },
      user: { role: 'owner', email: 'owner@caffix.com' }
    };
    await refundOrder(reqOwner, mockResponse(), (err) => { ownerError = err; });
    assert.strictEqual(ownerError?.statusCode, 403, 'Owner must be rejected with 403');

    // 2. Kiosk attempt -> 403 Forbidden
    let kioskError: any = null;
    const reqKiosk: any = {
      params: { id: testOrderId },
      body: { amount_paise: 2000, reason: 'kiosk_attempt' },
      user: { role: 'kiosk', machine_id: 'CFX-MC-01' }
    };
    await refundOrder(reqKiosk, mockResponse(), (err) => { kioskError = err; });
    assert.strictEqual(kioskError?.statusCode, 403, 'Kiosk must be rejected with 403');

    // 3. Kiosk Admin attempt -> 403 Forbidden
    let kioskAdmError: any = null;
    const reqKioskAdm: any = {
      params: { id: testOrderId },
      body: { amount_paise: 2000, reason: 'kiosk_admin_attempt' },
      user: { role: 'admin', scope: 'kiosk_admin' }
    };
    await refundOrder(reqKioskAdm, mockResponse(), (err) => { kioskAdmError = err; });
    assert.strictEqual(kioskAdmError?.statusCode, 403, 'Kiosk Admin must be rejected with 403');

    // 4. Super Admin attempt -> 200 Success
    const reqAdmin: any = {
      params: { id: testOrderId },
      body: { amount_paise: 2000, reason: 'super_admin_refund', idempotency_key: 'idem_rbac_07_ok' },
      user: { role: 'admin', email: 'admin@caffix.com' }
    };
    const resAdmin = mockResponse();
    await refundOrder(reqAdmin, resAdmin, () => {});
    assert.strictEqual(resAdmin.statusCode, 200, 'Super admin must receive HTTP 200');
    assert.strictEqual(resAdmin.body.data.refund.amount_paise, 2000);
    console.log('   PASS [RBAC Super Admin]: Strict role enforcement verified.');
  }

  console.log('Scenario 8 [Unverified Capture Fail-Closed]: Order with NULL capture rejected (409)...');
  {
    const nullCapOrderId = 'ORD-NULL-CAP-08';
    await db.run(
      `INSERT OR REPLACE INTO orders (
        id, product_id, amount, status, machine_id, created_at, razorpay_payment_id, captured_amount_paise
      ) VALUES (?, 1, 100, 'PAID', 'CFX-MC-01', ?, ?, NULL)`,
      [nullCapOrderId, new Date().toISOString(), 'pay_mock_null_cap']
    );

    let captureError: any = null;
    const req: any = {
      params: { id: nullCapOrderId },
      body: { amount_paise: 5000, reason: 'null_cap_test' },
      user: { role: 'admin', email: 'admin@caffix.com' }
    };
    await refundOrder(req, mockResponse(), (err) => { captureError = err; });
    assert.strictEqual(captureError?.statusCode, 409, 'Unverified capture must fail closed with 409');
    console.log('   PASS [Unverified Capture Fail-Closed]: Blocked refund for unverified captured amount.');
  }

  console.log('Scenario 9 [Hardware Safety Dispensing]: Order actively dispensing rejected (409)...');
  {
    const dispensingOrderId = 'ORD-DISP-09';
    await db.run(
      `INSERT OR REPLACE INTO orders (
        id, product_id, amount, status, dispense_status, machine_id, created_at, razorpay_payment_id, captured_amount_paise
      ) VALUES (?, 1, 100, 'PREPARING', 'DISPENSING', 'CFX-MC-01', ?, ?, 10000)`,
      [dispensingOrderId, new Date().toISOString(), 'pay_mock_disp_09']
    );

    let dispError: any = null;
    const req: any = {
      params: { id: dispensingOrderId },
      body: { amount_paise: 3000, reason: 'hardware_safety_test' },
      user: { role: 'admin', email: 'admin@caffix.com' }
    };
    await refundOrder(req, mockResponse(), (err) => { dispError = err; });
    assert.strictEqual(dispError?.statusCode, 409, 'Actively dispensing order must fail closed with 409');
    console.log('   PASS [Hardware Safety Dispensing]: Hardware lock strictly enforced.');
  }

  console.log('Scenario 10 [Partial & Full Refund Pipeline]: Progression from ₹40 to FULL ₹100...');
  {
    const orderId = 'ORD-FULL-PIPE-10';
    await db.run('DELETE FROM inventory_ledger WHERE order_id = ?', [orderId]).catch(() => {});
    await db.run('DELETE FROM refunds WHERE order_id = ?', [orderId]);
    await db.run(
      `INSERT OR REPLACE INTO orders (
        id, product_id, amount, status, machine_id, created_at, razorpay_payment_id, captured_amount_paise,
        total_refunded_amount_paise, pending_refund_amount_paise, refund_status
      ) VALUES (?, 1, 100, 'PAID', 'CFX-MC-01', ?, ?, 10000, 0, 0, 'NONE')`,
      [orderId, new Date().toISOString(), 'pay_mock_pipe_10']
    );

    // 1. Partial refund of ₹40 (4000 paise)
    const req1: any = {
      params: { id: orderId },
      body: { amount_paise: 4000, reason: 'partial_refund_1', idempotency_key: 'idem_pipe_10_part1' },
      user: { role: 'admin', email: 'admin@caffix.com' }
    };
    const res1 = mockResponse();
    await refundOrder(req1, res1, () => {});
    assert.strictEqual(res1.statusCode, 200);
    assert.strictEqual(res1.body.data.order.refund_status, 'PARTIAL');
    assert.strictEqual(Number(res1.body.data.order.total_refunded_amount_paise), 4000);

    // 2. Over-refund attempt: trying to refund ₹70 when only ₹60 remains -> 400 Bad Request
    let overError: any = null;
    const reqOver: any = {
      params: { id: orderId },
      body: { amount_paise: 7000, reason: 'over_refund_attempt' },
      user: { role: 'admin', email: 'admin@caffix.com' }
    };
    await refundOrder(reqOver, mockResponse(), (err) => { overError = err; });
    assert.strictEqual(overError?.statusCode, 400, 'Exceeding balance must reject with 400');

    // 3. Complete full remaining refund (omit amount -> defaults to full remaining 6000 paise)
    const req2: any = {
      params: { id: orderId },
      body: { reason: 'remaining_full_refund', idempotency_key: 'idem_pipe_10_part2' },
      user: { role: 'admin', email: 'admin@caffix.com' }
    };
    const res2 = mockResponse();
    await refundOrder(req2, res2, () => {});
    assert.strictEqual(res2.statusCode, 200);
    assert.strictEqual(res2.body.data.order.refund_status, 'FULL');
    assert.strictEqual(Number(res2.body.data.order.total_refunded_amount_paise), 10000);
    assert.strictEqual(Number(res2.body.data.order.pending_refund_amount_paise), 0);
    console.log('   PASS [Partial & Full Pipeline]: Seamless transition to FULL refund.');
  }

  console.log('Scenario 11 [Gateway Failure & Release]: Rejection releases pending reservation hold...');
  {
    const orderId = 'ORD-GW-FAIL-11';
    await db.run('DELETE FROM inventory_ledger WHERE order_id = ?', [orderId]).catch(() => {});
    await db.run('DELETE FROM refunds WHERE order_id = ?', [orderId]);
    await db.run(
      `INSERT OR REPLACE INTO orders (
        id, product_id, amount, status, machine_id, created_at, razorpay_payment_id, captured_amount_paise,
        total_refunded_amount_paise, pending_refund_amount_paise, refund_status
      ) VALUES (?, 1, 100, 'PAID', 'CFX-MC-01', ?, ?, 10000, 0, 0, 'NONE')`,
      [orderId, new Date().toISOString(), 'pay_mock_fail_test']
    );

    const req: any = {
      params: { id: orderId },
      body: { amount_paise: 5000, reason: 'simulated_failure_test', idempotency_key: 'idem_fail_11' },
      user: { role: 'admin', email: 'admin@caffix.com' }
    };
    const res = mockResponse();
    await refundOrder(req, res, () => {});
    assert.strictEqual(res.statusCode, 422, 'Gateway rejection must return HTTP 422');
    assert.strictEqual(res.body.data.refund.status, 'FAILED');
    assert.strictEqual(res.body.data.order.pending_refund_amount_paise, 0, 'Pending hold must be released to 0');

    // Order remains capable of accepting another refund
    const bal = calculateRemainingRefundableBalance(res.body.data.order);
    assert.strictEqual(bal.remainingRefundablePaise, 10000, 'Full capacity must be preserved after rejection');
    console.log('   PASS [Gateway Failure & Release]: Rejected refund released reservation hold.');
  }

  console.log('Scenario 12 [Gateway Timeout Retention]: Timeout holds reservation in PENDING...');
  {
    const orderId = 'ORD-GW-TIMEOUT-12';
    await db.run('DELETE FROM inventory_ledger WHERE order_id = ?', [orderId]).catch(() => {});
    await db.run('DELETE FROM refunds WHERE order_id = ?', [orderId]);
    await db.run(
      `INSERT OR REPLACE INTO orders (
        id, product_id, amount, status, machine_id, created_at, razorpay_payment_id, captured_amount_paise,
        total_refunded_amount_paise, pending_refund_amount_paise, refund_status
      ) VALUES (?, 1, 100, 'PAID', 'CFX-MC-01', ?, ?, 10000, 0, 0, 'NONE')`,
      [orderId, new Date().toISOString(), 'pay_mock_timeout_test']
    );

    const req: any = {
      params: { id: orderId },
      body: { amount_paise: 5000, reason: 'timeout_test', idempotency_key: 'idem_timeout_12' },
      user: { role: 'admin', email: 'admin@caffix.com' }
    };
    const res = mockResponse();
    await refundOrder(req, res, () => {});
    assert.strictEqual(res.statusCode, 504, 'Gateway timeout must return HTTP 504');
    assert.strictEqual(res.body.data.refund.status, 'PENDING');
    assert.strictEqual(res.body.data.order.pending_refund_amount_paise, 5000, 'Pending hold must remain locked');

    // Balance capacity is locked: only 5000 paise remaining
    const bal = calculateRemainingRefundableBalance(res.body.data.order);
    assert.strictEqual(bal.remainingRefundablePaise, 5000, 'Pending reservation protects against double refund');
    console.log('   PASS [Gateway Timeout Retention]: Timeout safely held reservation pending reconciliation.');
  }

  console.log('Scenario 13 [Duplicate Request Replay]: Idempotent replay returns 200 without second refund...');
  {
    const orderId = 'ORD-IDEM-REPLAY-13';
    await db.run('DELETE FROM inventory_ledger WHERE order_id = ?', [orderId]).catch(() => {});
    await db.run('DELETE FROM refunds WHERE order_id = ?', [orderId]);
    await db.run(
      `INSERT OR REPLACE INTO orders (
        id, product_id, amount, status, machine_id, created_at, razorpay_payment_id, captured_amount_paise,
        total_refunded_amount_paise, pending_refund_amount_paise, refund_status
      ) VALUES (?, 1, 100, 'PAID', 'CFX-MC-01', ?, ?, 10000, 0, 0, 'NONE')`,
      [orderId, new Date().toISOString(), 'pay_mock_idem_13']
    );

    const idempotencyKey = 'idem_fixed_key_13';
    const req1: any = {
      params: { id: orderId },
      body: { amount_paise: 3500, reason: 'first_call', idempotency_key: idempotencyKey },
      user: { role: 'admin', email: 'admin@caffix.com' }
    };
    const res1 = mockResponse();
    await refundOrder(req1, res1, () => {});
    assert.strictEqual(res1.statusCode, 200);
    const refundId = res1.body.data.refund.id;

    // Second call with same idempotency key
    const req2: any = {
      params: { id: orderId },
      body: { amount_paise: 3500, reason: 'second_call', idempotency_key: idempotencyKey },
      user: { role: 'admin', email: 'admin@caffix.com' }
    };
    const res2 = mockResponse();
    await refundOrder(req2, res2, () => {});
    assert.strictEqual(res2.statusCode, 200);
    assert.strictEqual(res2.body.data.is_replay, true);
    assert.strictEqual(res2.body.data.refund.id, refundId);

    // Total refunded in DB must remain exactly 3500, NOT 7000!
    const rowOrder = await db.get('SELECT * FROM orders WHERE id = ?', [orderId]);
    assert.strictEqual(Number(rowOrder.total_refunded_amount_paise), 3500, 'Duplicate replay must NOT double-deduct');
    console.log('   PASS [Duplicate Request Replay]: Idempotent replay protected balance.');
  }

  console.log('Scenario 14 [Webhook Refund Settlement]: Webhook settles refund accurately...');
  {
    const orderId = 'ORD-WH-SETTLE-14';
    await db.run('DELETE FROM inventory_ledger WHERE order_id = ?', [orderId]).catch(() => {});
    await db.run('DELETE FROM refunds WHERE order_id = ?', [orderId]);
    await db.run(
      `INSERT OR REPLACE INTO orders (
        id, product_id, amount, status, machine_id, created_at, razorpay_payment_id, captured_amount_paise,
        total_refunded_amount_paise, pending_refund_amount_paise, refund_status
      ) VALUES (?, 1, 100, 'PAID', 'CFX-MC-01', ?, ?, 10000, 0, 5000, 'PENDING')`,
      [orderId, new Date().toISOString(), 'pay_mock_wh_14']
    );

    await db.run(
      `INSERT INTO refunds (
        id, order_id, machine_id, razorpay_payment_id, razorpay_refund_id,
        amount_paise, currency, status, reason, notes, initiated_by,
        source, idempotency_key, error_code, error_description,
        created_at, updated_at, processed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        'RFND-WH-14', orderId, 'CFX-MC-01', 'pay_mock_wh_14', null,
        5000, 'INR', 'PENDING', 'pending_refund', null, 'admin',
        'SUPER_ADMIN_PORTAL', 'idem_wh_14', null, null,
        new Date().toISOString(), new Date().toISOString(), null
      ]
    );

    // Simulate verified Razorpay webhook payload for refund.processed
    const webhookReq: any = {
      headers: { 'x-razorpay-signature': 'mock' },
      body: {
        event: 'refund.processed',
        payload: {
          refund: {
            entity: {
              id: 'rfnd_webhook_processed_777',
              payment_id: 'pay_mock_wh_14',
              amount: 5000,
              currency: 'INR',
              status: 'processed',
              receipt: 'RFND-WH-14',
              created_at: Math.floor(Date.now() / 1000)
            }
          }
        }
      }
    };
    const webhookRes = mockResponse();
    await handleRazorpayWebhook(webhookReq, webhookRes, () => {});
    assert.strictEqual(webhookRes.statusCode, 200);

    const updatedRow = await db.get('SELECT * FROM refunds WHERE id = ?', ['RFND-WH-14']);
    assert.strictEqual(updatedRow.status, 'PROCESSED');
    assert.strictEqual(updatedRow.razorpay_refund_id, 'rfnd_webhook_processed_777');

    const updatedOrder = await db.get('SELECT * FROM orders WHERE id = ?', [orderId]);
    assert.strictEqual(Number(updatedOrder.total_refunded_amount_paise), 5000);
    assert.strictEqual(Number(updatedOrder.pending_refund_amount_paise), 0);
    console.log('   PASS [Webhook Refund Settlement]: Webhook successfully promoted pending refund to PROCESSED.');
  }

  // =========================================================================
  // PHASE 2.7.2.2 SUITE: DISPENSING SAFETY (E-1), GATEWAY AMOUNT (A-1), LEDGER (D-1)
  // =========================================================================

  // Scenario 15: [E-1 Dispensing Safety: Fully Refunded Order Cannot Dispense]
  {
    console.log('\nScenario 15 [E-1 Dispensing Safety]: Fully refunded order CANNOT dispense...');
    const orderId = 'ORD-E1-FULL-15';
    await db.run('DELETE FROM inventory_ledger WHERE order_id = ?', [orderId]).catch(() => {});
    await db.run('DELETE FROM refunds WHERE order_id = ?', [orderId]);
    await db.run('DELETE FROM orders WHERE id = ?', [orderId]);
    await db.run(
      `INSERT INTO orders (id, machine_id, product_id, amount, status, dispense_status, razorpay_order_id, razorpay_payment_id, captured_amount_paise, refund_status, total_refunded_amount_paise, pending_refund_amount_paise, created_at, updated_at)
       VALUES (?, 'CFX-MC-01', 1, 100, 'PAID', 'PENDING', 'order_e1_15', 'pay_mock_e1_15', 10000, 'FULL', 10000, 0, ?, ?)`,
      [orderId, new Date().toISOString(), new Date().toISOString()]
    );

    // 1. Controller endpoint check: PUT /api/orders/:id/status { status: 'PREPARING' }
    const req: any = {
      params: { id: orderId },
      body: { status: 'PREPARING' },
      user: { role: 'admin', email: 'admin@caffix.com' }
    };
    const res = mockResponse();
    let caughtError: any = null;
    await updateOrderStatus(req, res, (err: any) => {
      caughtError = err;
    });

    assert.ok(caughtError instanceof ConflictError, 'Must reject with ConflictError');
    assert.ok(caughtError.message.includes('fully refunded'), 'Must explain order is fully refunded');

    // 2. Direct core execution check: executeOrderStatusUpdate
    let coreErr: any = null;
    try {
      await executeOrderStatusUpdate(orderId, 'PREPARING');
    } catch (e) {
      coreErr = e;
    }
    assert.ok(coreErr instanceof ConflictError, 'Core status transition must reject fully refunded order');
    console.log('   PASS [E-1 Dispensing Safety]: Fully refunded order blocked from PREPARING/DISPENSING.');
  }

  // Scenario 16: [E-1 Dispensing Safety: Pending Refund Reservation Cannot Dispense]
  {
    console.log('\nScenario 16 [E-1 Dispensing Safety]: Order with pending refund reservation CANNOT dispense...');
    const orderId = 'ORD-E1-PEND-16';
    await db.run('DELETE FROM inventory_ledger WHERE order_id = ?', [orderId]).catch(() => {});
    await db.run('DELETE FROM refunds WHERE order_id = ?', [orderId]);
    await db.run('DELETE FROM orders WHERE id = ?', [orderId]);
    await db.run(
      `INSERT INTO orders (id, machine_id, product_id, amount, status, dispense_status, razorpay_order_id, razorpay_payment_id, captured_amount_paise, refund_status, total_refunded_amount_paise, pending_refund_amount_paise, created_at, updated_at)
       VALUES (?, 'CFX-MC-01', 1, 100, 'PAID', 'PENDING', 'order_e1_16', 'pay_mock_e1_16', 10000, 'PARTIAL', 0, 5000, ?, ?)`,
      [orderId, new Date().toISOString(), new Date().toISOString()]
    );

    const req: any = {
      params: { id: orderId },
      body: { status: 'PREPARING' },
      user: { role: 'admin', email: 'admin@caffix.com' }
    };
    const res = mockResponse();
    let caughtError: any = null;
    await updateOrderStatus(req, res, (err: any) => {
      caughtError = err;
    });

    assert.ok(caughtError instanceof ConflictError, 'Must reject with ConflictError');
    assert.ok(caughtError.message.includes('pending refund reservation'), 'Must explain pending refund');

    let coreErr: any = null;
    try {
      await executeOrderStatusUpdate(orderId, 'PREPARING');
    } catch (e) {
      coreErr = e;
    }
    assert.ok(coreErr instanceof ConflictError, 'Core transition must reject pending refund order');
    console.log('   PASS [E-1 Dispensing Safety]: Order with pending refund reservation blocked from dispensing.');
  }

  // Scenario 17: [E-1 Dispensing Safety: Partial Refund With No Pending Reservation Follows Business Rule]
  {
    console.log('\nScenario 17 [E-1 Dispensing Safety]: Partial refund with 0 pending reservations CAN dispense...');
    const orderId = 'ORD-E1-PARTIAL-17';
    await db.run('DELETE FROM inventory_ledger WHERE order_id = ?', [orderId]).catch(() => {});
    await db.run('DELETE FROM refunds WHERE order_id = ?', [orderId]);
    await db.run('DELETE FROM orders WHERE id = ?', [orderId]);
    await db.run(
      `INSERT INTO orders (id, machine_id, product_id, amount, status, dispense_status, razorpay_order_id, razorpay_payment_id, captured_amount_paise, refund_status, total_refunded_amount_paise, pending_refund_amount_paise, created_at, updated_at)
       VALUES (?, 'CFX-MC-01', 1, 100, 'PAID', 'PENDING', 'order_e1_17', 'pay_mock_e1_17', 10000, 'PARTIAL', 3000, 0, ?, ?)`,
      [orderId, new Date().toISOString(), new Date().toISOString()]
    );

    // Business rule: Partial refund with 0 in-flight reservation permits remaining beverage dispensing
    const updated = await executeOrderStatusUpdate(orderId, 'PREPARING');
    assert.strictEqual(updated.status, 'PREPARING');
    console.log('   PASS [E-1 Dispensing Safety]: Partial refund with 0 pending reservations dispensed per business rule.');
  }

  // Scenario 18: [E-1 Dispensing Safety: Normal Paid Order Can Dispense]
  {
    console.log('\nScenario 18 [E-1 Dispensing Safety]: Normal paid order can dispense cleanly...');
    const orderId = 'ORD-E1-NORMAL-18';
    await db.run('DELETE FROM inventory_ledger WHERE order_id = ?', [orderId]).catch(() => {});
    await db.run('DELETE FROM refunds WHERE order_id = ?', [orderId]);
    await db.run('DELETE FROM orders WHERE id = ?', [orderId]);
    await db.run(
      `INSERT INTO orders (id, machine_id, product_id, amount, status, dispense_status, razorpay_order_id, razorpay_payment_id, captured_amount_paise, refund_status, total_refunded_amount_paise, pending_refund_amount_paise, created_at, updated_at)
       VALUES (?, 'CFX-MC-01', 1, 100, 'PAID', 'PENDING', 'order_e1_18', 'pay_mock_e1_18', 10000, 'NONE', 0, 0, ?, ?)`,
      [orderId, new Date().toISOString(), new Date().toISOString()]
    );

    const updated = await executeOrderStatusUpdate(orderId, 'PREPARING');
    assert.strictEqual(updated.status, 'PREPARING');
    console.log('   PASS [E-1 Dispensing Safety]: Normal paid order successfully transitioned to PREPARING.');
  }

  // Scenario 19: [E-1 Dispensing Safety: Cross-Machine Isolation]
  {
    console.log('\nScenario 19 [E-1 Dispensing Safety]: Cross-machine isolation verified...');
    const orderMC1 = 'ORD-E1-MC1-19';
    const orderMC2 = 'ORD-E1-MC2-19';
    await db.run('DELETE FROM inventory_ledger WHERE order_id IN (?, ?)', [orderMC1, orderMC2]).catch(() => {});
    await db.run('DELETE FROM refunds WHERE order_id IN (?, ?)', [orderMC1, orderMC2]);
    await db.run('DELETE FROM orders WHERE id IN (?, ?)', [orderMC1, orderMC2]);

    // Order 1 on CFX-MC-01 is FULLY refunded
    await db.run(
      `INSERT INTO orders (id, machine_id, product_id, amount, status, dispense_status, razorpay_order_id, razorpay_payment_id, captured_amount_paise, refund_status, total_refunded_amount_paise, pending_refund_amount_paise, created_at, updated_at)
       VALUES (?, 'CFX-MC-01', 1, 100, 'PAID', 'PENDING', 'order_e1_mc1', 'pay_mock_mc1', 10000, 'FULL', 10000, 0, ?, ?)`,
      [orderMC1, new Date().toISOString(), new Date().toISOString()]
    );

    // Order 2 on CFX-MC-02 is NORMAL PAID
    await db.run(
      `INSERT INTO orders (id, machine_id, product_id, amount, status, dispense_status, razorpay_order_id, razorpay_payment_id, captured_amount_paise, refund_status, total_refunded_amount_paise, pending_refund_amount_paise, created_at, updated_at)
       VALUES (?, 'CFX-MC-02', 1, 100, 'PAID', 'PENDING', 'order_e1_mc2', 'pay_mock_mc2', 10000, 'NONE', 0, 0, ?, ?)`,
      [orderMC2, new Date().toISOString(), new Date().toISOString()]
    );

    // Machine 1 order cannot dispense
    let mc1Err: any = null;
    try {
      await executeOrderStatusUpdate(orderMC1, 'PREPARING');
    } catch (e) {
      mc1Err = e;
    }
    assert.ok(mc1Err instanceof ConflictError, 'MC1 refunded order must be blocked');

    // Machine 2 order dispenses without interference
    const updatedMC2 = await executeOrderStatusUpdate(orderMC2, 'PREPARING');
    assert.strictEqual(updatedMC2.status, 'PREPARING');
    console.log('   PASS [E-1 Dispensing Safety]: Cross-machine isolation strictly preserved.');
  }

  // Scenario 20: [A-1 Gateway Amount Verification: Exact Match]
  {
    console.log('\nScenario 20 [A-1 Gateway Amount]: Exact amount & INR match successfully settles...');
    const orderId = 'ORD-A1-EXACT-20';
    await db.run('DELETE FROM inventory_ledger WHERE order_id = ?', [orderId]).catch(() => {});
    await db.run('DELETE FROM refunds WHERE order_id = ?', [orderId]);
    await db.run('DELETE FROM orders WHERE id = ?', [orderId]);
    await db.run(
      `INSERT INTO orders (id, machine_id, product_id, amount, status, dispense_status, razorpay_order_id, razorpay_payment_id, captured_amount_paise, refund_status, total_refunded_amount_paise, pending_refund_amount_paise, created_at, updated_at)
       VALUES (?, 'CFX-MC-01', 1, 100, 'PAID', 'PENDING', 'order_a1_20', 'pay_mock_a1_exact', 10000, 'NONE', 0, 0, ?, ?)`,
      [orderId, new Date().toISOString(), new Date().toISOString()]
    );

    const token = generateAuthToken({ id: 1, email: 'admin@caffix.com', role: 'admin' });
    const req: any = {
      params: { id: orderId },
      body: { amount_paise: 4000, reason: 'Exact match test' },
      user: { role: 'admin', email: 'admin@caffix.com' },
      headers: { authorization: `Bearer ${token}` }
    };
    const res = mockResponse();
    await refundOrder(req, res, (err: any) => {
      if (err) throw err;
    });

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.data.refund.status, 'PROCESSED');
    assert.strictEqual(res.body.data.refund.amount_paise, 4000);
    console.log('   PASS [A-1 Gateway Amount]: Exact match correctly marked PROCESSED.');
  }

  // Scenario 21: [A-1 Gateway Amount Verification: Lower Amount Discrepancy]
  {
    console.log('\nScenario 21 [A-1 Gateway Amount]: Lower amount discrepancy held in PENDING (502)...');
    const orderId = 'ORD-A1-LOWER-21';
    await db.run('DELETE FROM inventory_ledger WHERE order_id = ?', [orderId]).catch(() => {});
    await db.run('DELETE FROM refunds WHERE order_id = ?', [orderId]);
    await db.run('DELETE FROM orders WHERE id = ?', [orderId]);
    await db.run(
      `INSERT INTO orders (id, machine_id, product_id, amount, status, dispense_status, razorpay_order_id, razorpay_payment_id, captured_amount_paise, refund_status, total_refunded_amount_paise, pending_refund_amount_paise, created_at, updated_at)
       VALUES (?, 'CFX-MC-01', 1, 100, 'PAID', 'PENDING', 'order_a1_21', 'pay_mock_amount_lower_test', 10000, 'NONE', 0, 0, ?, ?)`,
      [orderId, new Date().toISOString(), new Date().toISOString()]
    );

    const token = generateAuthToken({ id: 1, email: 'admin@caffix.com', role: 'admin' });
    const req: any = {
      params: { id: orderId },
      body: { amount_paise: 5000, reason: 'Lower amount test' },
      user: { role: 'admin', email: 'admin@caffix.com' },
      headers: { authorization: `Bearer ${token}` }
    };
    const res = mockResponse();
    await refundOrder(req, res, () => {});

    assert.strictEqual(res.statusCode, 502, 'Discrepancy must return 502 Bad Gateway');
    assert.strictEqual(res.body.code, 'GATEWAY_AMOUNT_MISMATCH');

    // Invariant: reservation must be retained in PENDING to prevent over-allocation or phantom refund
    const order = await db.get('SELECT * FROM orders WHERE id = ?', [orderId]);
    assert.strictEqual(Number(order.pending_refund_amount_paise), 5000, 'Reservation held in PENDING');
    assert.strictEqual(Number(order.total_refunded_amount_paise), 0, 'Must NOT mark processed');

    const refund = await db.get('SELECT * FROM refunds WHERE order_id = ?', [orderId]);
    assert.strictEqual(refund.status, 'PENDING', 'Refund record must remain PENDING');
    console.log('   PASS [A-1 Gateway Amount]: Lower amount discrepancy safely held in PENDING exception.');
  }

  // Scenario 22: [A-1 Gateway Amount Verification: Higher Amount Discrepancy]
  {
    console.log('\nScenario 22 [A-1 Gateway Amount]: Higher amount discrepancy held in PENDING (502)...');
    const orderId = 'ORD-A1-HIGHER-22';
    await db.run('DELETE FROM inventory_ledger WHERE order_id = ?', [orderId]).catch(() => {});
    await db.run('DELETE FROM refunds WHERE order_id = ?', [orderId]);
    await db.run('DELETE FROM orders WHERE id = ?', [orderId]);
    await db.run(
      `INSERT INTO orders (id, machine_id, product_id, amount, status, dispense_status, razorpay_order_id, razorpay_payment_id, captured_amount_paise, refund_status, total_refunded_amount_paise, pending_refund_amount_paise, created_at, updated_at)
       VALUES (?, 'CFX-MC-01', 1, 100, 'PAID', 'PENDING', 'order_a1_22', 'pay_mock_amount_higher_test', 10000, 'NONE', 0, 0, ?, ?)`,
      [orderId, new Date().toISOString(), new Date().toISOString()]
    );

    const token = generateAuthToken({ id: 1, email: 'admin@caffix.com', role: 'admin' });
    const req: any = {
      params: { id: orderId },
      body: { amount_paise: 3000, reason: 'Higher amount test' },
      user: { role: 'admin', email: 'admin@caffix.com' },
      headers: { authorization: `Bearer ${token}` }
    };
    const res = mockResponse();
    await refundOrder(req, res, () => {});

    assert.strictEqual(res.statusCode, 502);
    assert.strictEqual(res.body.code, 'GATEWAY_AMOUNT_MISMATCH');

    const order = await db.get('SELECT * FROM orders WHERE id = ?', [orderId]);
    assert.strictEqual(Number(order.pending_refund_amount_paise), 3000);
    assert.strictEqual(Number(order.total_refunded_amount_paise), 0);
    console.log('   PASS [A-1 Gateway Amount]: Higher amount discrepancy safely held in PENDING exception.');
  }

  // Scenario 23: [A-1 Gateway Amount Verification: Missing Amount]
  {
    console.log('\nScenario 23 [A-1 Gateway Amount]: Missing amount in gateway response rejected (502)...');
    const orderId = 'ORD-A1-MISSING-23';
    await db.run('DELETE FROM inventory_ledger WHERE order_id = ?', [orderId]).catch(() => {});
    await db.run('DELETE FROM refunds WHERE order_id = ?', [orderId]);
    await db.run('DELETE FROM orders WHERE id = ?', [orderId]);
    await db.run(
      `INSERT INTO orders (id, machine_id, product_id, amount, status, dispense_status, razorpay_order_id, razorpay_payment_id, captured_amount_paise, refund_status, total_refunded_amount_paise, pending_refund_amount_paise, created_at, updated_at)
       VALUES (?, 'CFX-MC-01', 1, 100, 'PAID', 'PENDING', 'order_a1_23', 'pay_mock_missing_amount_test', 10000, 'NONE', 0, 0, ?, ?)`,
      [orderId, new Date().toISOString(), new Date().toISOString()]
    );

    const token = generateAuthToken({ id: 1, email: 'admin@caffix.com', role: 'admin' });
    const req: any = {
      params: { id: orderId },
      body: { amount_paise: 5000, reason: 'Missing amount test' },
      user: { role: 'admin', email: 'admin@caffix.com' },
      headers: { authorization: `Bearer ${token}` }
    };
    const res = mockResponse();
    await refundOrder(req, res, () => {});

    assert.strictEqual(res.statusCode, 502);
    assert.strictEqual(res.body.code, 'GATEWAY_AMOUNT_MISMATCH');
    console.log('   PASS [A-1 Gateway Amount]: Missing amount in gateway response blocked.');
  }

  // Scenario 24: [A-1 Gateway Amount Verification: Invalid Currency (non-INR)]
  {
    console.log('\nScenario 24 [A-1 Gateway Amount]: Non-INR currency rejected (502)...');
    const orderId = 'ORD-A1-CURR-24';
    await db.run('DELETE FROM inventory_ledger WHERE order_id = ?', [orderId]).catch(() => {});
    await db.run('DELETE FROM refunds WHERE order_id = ?', [orderId]);
    await db.run('DELETE FROM orders WHERE id = ?', [orderId]);
    await db.run(
      `INSERT INTO orders (id, machine_id, product_id, amount, status, dispense_status, razorpay_order_id, razorpay_payment_id, captured_amount_paise, refund_status, total_refunded_amount_paise, pending_refund_amount_paise, created_at, updated_at)
       VALUES (?, 'CFX-MC-01', 1, 100, 'PAID', 'PENDING', 'order_a1_24', 'pay_mock_invalid_currency_test', 10000, 'NONE', 0, 0, ?, ?)`,
      [orderId, new Date().toISOString(), new Date().toISOString()]
    );

    const token = generateAuthToken({ id: 1, email: 'admin@caffix.com', role: 'admin' });
    const req: any = {
      params: { id: orderId },
      body: { amount_paise: 4000, reason: 'Currency test' },
      user: { role: 'admin', email: 'admin@caffix.com' },
      headers: { authorization: `Bearer ${token}` }
    };
    const res = mockResponse();
    await refundOrder(req, res, () => {});

    assert.strictEqual(res.statusCode, 502);
    assert.strictEqual(res.body.code, 'GATEWAY_CURRENCY_MISMATCH');
    console.log('   PASS [A-1 Gateway Amount]: Non-INR currency rejected.');
  }

  // Scenario 25: [A-1 Gateway Amount Verification: Malformed Values (Decimal, Negative, Zero)]
  {
    console.log('\nScenario 25 [A-1 Gateway Amount]: Decimal, negative, and zero amounts rejected...');
    for (const malformedCase of [
      { trigger: 'pay_mock_decimal_amount', label: 'decimal 49.99' },
      { trigger: 'pay_mock_negative_amount', label: 'negative -5000' },
      { trigger: 'pay_mock_zero_amount', label: 'zero 0' }
    ]) {
      const orderId = `ORD-A1-MAL-${Date.now()}`;
      await db.run('DELETE FROM inventory_ledger WHERE order_id = ?', [orderId]).catch(() => {});
    await db.run('DELETE FROM refunds WHERE order_id = ?', [orderId]);
      await db.run('DELETE FROM orders WHERE id = ?', [orderId]);
      await db.run(
        `INSERT INTO orders (id, machine_id, product_id, amount, status, dispense_status, razorpay_order_id, razorpay_payment_id, captured_amount_paise, refund_status, total_refunded_amount_paise, pending_refund_amount_paise, created_at, updated_at)
         VALUES (?, 'CFX-MC-01', 1, 100, 'PAID', 'PENDING', 'order_mal', ?, 10000, 'NONE', 0, 0, ?, ?)`,
        [orderId, malformedCase.trigger, new Date().toISOString(), new Date().toISOString()]
      );

      const token = generateAuthToken({ id: 1, email: 'admin@caffix.com', role: 'admin' });
      const req: any = {
        params: { id: orderId },
        body: { amount_paise: 5000, reason: `Malformed ${malformedCase.label}` },
        user: { role: 'admin', email: 'admin@caffix.com' },
        headers: { authorization: `Bearer ${token}` }
      };
      const res = mockResponse();
      await refundOrder(req, res, () => {});

      assert.strictEqual(res.statusCode, 502, `Malformed ${malformedCase.label} must return 502`);
      assert.strictEqual(res.body.code, 'GATEWAY_AMOUNT_MISMATCH');
    }
    console.log('   PASS [A-1 Gateway Amount]: Malformed decimal, negative, and zero values safely rejected.');
  }

  // Scenario 26: [D-1 Durable Webhook Event Ledger: Recording & Duplicate Deduplication]
  {
    console.log('\nScenario 26 [D-1 Webhook Ledger]: Webhook recording & duplicate delivery deduplication...');
    const orderId = 'ORD-D1-LEDGER-26';
    const eventId = `evt_d1_test_${Date.now()}`;
    await db.run('DELETE FROM inventory_ledger WHERE order_id = ?', [orderId]).catch(() => {});
    await db.run('DELETE FROM refunds WHERE order_id = ?', [orderId]);
    await db.run('DELETE FROM orders WHERE id = ?', [orderId]);
    await db.run('DELETE FROM webhook_events WHERE event_id = ?', [eventId]);
    await db.run(
      `INSERT INTO orders (id, machine_id, product_id, amount, status, dispense_status, razorpay_order_id, razorpay_payment_id, captured_amount_paise, refund_status, total_refunded_amount_paise, pending_refund_amount_paise, created_at, updated_at)
       VALUES (?, 'CFX-MC-01', 1, 100, 'PENDING', 'PENDING', 'order_d1_26', 'pay_mock_d1_26', NULL, 'NONE', 0, 0, ?, ?)`,
      [orderId, new Date().toISOString(), new Date().toISOString()]
    );

    const webhookBody = {
      id: eventId,
      entity: 'event',
      event: 'payment.captured',
      created_at: Math.floor(Date.now() / 1000),
      payload: {
        payment: {
          entity: {
            id: 'pay_mock_d1_26',
            order_id: 'order_d1_26',
            amount: 10000,
            currency: 'INR',
            status: 'captured'
          }
        }
      }
    };

    const webhookReq: any = {
      headers: {
        'x-razorpay-signature': 'mock'
      },
      body: webhookBody
    };
    const webhookRes = mockResponse();
    await handleRazorpayWebhook(webhookReq, webhookRes, () => {});
    assert.strictEqual(webhookRes.statusCode, 200);

    // Verify ledger record
    const ledgerRow = await db.get('SELECT * FROM webhook_events WHERE event_id = ?', [eventId]);
    assert.ok(ledgerRow, 'Event must be recorded in webhook_events ledger');
    assert.strictEqual(ledgerRow.status, 'PROCESSED');
    assert.strictEqual(ledgerRow.event_type, 'payment.captured');

    // Replay duplicate delivery
    const dupRes = mockResponse();
    await handleRazorpayWebhook(webhookReq, dupRes, () => {});
    assert.strictEqual(dupRes.statusCode, 200);
    assert.strictEqual(dupRes.body.deduplicated, true, 'Replayed event must be marked deduplicated');
    console.log('   PASS [D-1 Webhook Ledger]: Webhook recording & idempotent deduplication verified.');
  }

  // Scenario 27: [D-1 Webhook Ledger: Unverified Webhook Never Recorded]
  {
    console.log('\nScenario 27 [D-1 Webhook Ledger]: Unverified webhook fails closed without ledger insertion...');
    const fakeEventId = `evt_fake_${Date.now()}`;
    process.env.RAZORPAY_WEBHOOK_SECRET = 'live_webhook_secret_key_12345';

    const unverifiedReq: any = {
      headers: {
        'x-razorpay-signature': 'invalid_forged_signature_hex'
      },
      rawBody: Buffer.from(JSON.stringify({ id: fakeEventId })),
      body: {
        id: fakeEventId,
        event: 'payment.captured',
        payload: { payment: { entity: { id: 'pay_hacked', amount: 10000, currency: 'INR' } } }
      }
    };
    const unverifiedRes = mockResponse();
    await handleRazorpayWebhook(unverifiedReq, unverifiedRes, () => {});
    assert.strictEqual(unverifiedRes.statusCode, 400);

    // Verify nothing recorded in ledger
    const ledgerRow = await db.get('SELECT * FROM webhook_events WHERE event_id = ?', [fakeEventId]);
    assert.ok(!ledgerRow, 'Unverified webhook must NEVER be recorded in ledger');

    // Reset secret
    delete process.env.RAZORPAY_WEBHOOK_SECRET;
    console.log('   PASS [D-1 Webhook Ledger]: Unverified webhook signature failed closed.');
  }

  // =========================================================================
  // PHASE 2.7.2.3 SUITE: WEBHOOK FINANCIAL SAFETY & DISTRIBUTED IDEMPOTENCY
  // =========================================================================

  // Scenario 28: [Phase 2.7.2.3 Fix 1: Webhook Refund Amount Verification & Mismatch Handling]
  {
    console.log('\nScenario 28 [Fix 1: Webhook Amount Verification]: Mismatched and invalid webhook amounts...');
    const orderId = 'ORD-WH-MISMATCH-28';
    const refundId = 'RFND-28-RES';
    const rpPaymentId = 'pay_mock_wh_28';
    await db.run('DELETE FROM inventory_ledger WHERE order_id = ?', [orderId]).catch(() => {});
    await db.run('DELETE FROM refunds WHERE order_id = ?', [orderId]);
    await db.run('DELETE FROM orders WHERE id = ?', [orderId]);
    await db.run(
      `INSERT INTO orders (id, machine_id, product_id, amount, status, dispense_status, razorpay_order_id, razorpay_payment_id, captured_amount_paise, refund_status, total_refunded_amount_paise, pending_refund_amount_paise, created_at, updated_at)
       VALUES (?, 'CFX-MC-01', 1, 100, 'PAID', 'PENDING', 'order_wh_28', ?, 10000, 'PARTIAL', 0, 5000, ?, ?)`,
      [orderId, rpPaymentId, new Date().toISOString(), new Date().toISOString()]
    );
    await db.run(
      `INSERT INTO refunds (id, order_id, machine_id, razorpay_payment_id, razorpay_refund_id, amount_paise, currency, status, reason, initiated_by, source, idempotency_key, created_at, updated_at)
       VALUES (?, ?, 'CFX-MC-01', ?, NULL, 5000, 'INR', 'PENDING', 'Testing webhook amount mismatch', 'admin@caffix.com', 'SUPER_ADMIN_PORTAL', 'idem_28_res', ?, ?)`,
      [refundId, orderId, rpPaymentId, new Date().toISOString(), new Date().toISOString()]
    );

    // 28a: Lower amount discrepancy (Gateway reports 3000 paise instead of 5000 paise)
    const lowerEvtId = `evt_lower_28_${Date.now()}`;
    const lowerReq: any = {
      headers: { 'x-razorpay-signature': 'mock' },
      body: {
        id: lowerEvtId,
        event: 'refund.processed',
        payload: {
          refund: {
            entity: {
              id: 'rfnd_lower_gw_28',
              payment_id: rpPaymentId,
              receipt: refundId,
              amount: 3000,
              currency: 'INR',
              created_at: Math.floor(Date.now() / 1000)
            }
          }
        }
      }
    };
    let lowerCaughtErr: any = null;
    await handleRazorpayWebhook(lowerReq, mockResponse(), (err) => { lowerCaughtErr = err; });
    assert.ok(lowerCaughtErr instanceof ConflictError, 'Must fail with ConflictError on amount mismatch');
    assert.ok(lowerCaughtErr.message.includes('GATEWAY_AMOUNT_MISMATCH'), 'Error must specify amount mismatch');

    // Invariant: reservation must remain in PENDING and pending balance retained
    const orderAfterLower = await db.get('SELECT * FROM orders WHERE id = ?', [orderId]);
    assert.strictEqual(Number(orderAfterLower.pending_refund_amount_paise), 5000, 'Pending hold retained');
    assert.strictEqual(Number(orderAfterLower.total_refunded_amount_paise), 0, 'Total refunded must not increment');
    const refundAfterLower = await db.get('SELECT * FROM refunds WHERE id = ?', [refundId]);
    assert.strictEqual(refundAfterLower.status, 'PENDING', 'Refund status must remain PENDING');
    assert.strictEqual(refundAfterLower.error_code, 'GATEWAY_AMOUNT_MISMATCH');
    assert.ok(refundAfterLower.notes.includes('DIAG_GATEWAY_AMOUNT_MISMATCH'), 'Diagnostic note recorded');

    // 28b: Higher amount discrepancy (Gateway reports 7000 paise)
    const higherEvtId = `evt_higher_28_${Date.now()}`;
    const higherReq: any = {
      headers: { 'x-razorpay-signature': 'mock' },
      body: {
        id: higherEvtId,
        event: 'refund.processed',
        payload: {
          refund: {
            entity: {
              id: 'rfnd_higher_gw_28',
              payment_id: rpPaymentId,
              receipt: refundId,
              amount: 7000,
              currency: 'INR',
              created_at: Math.floor(Date.now() / 1000)
            }
          }
        }
      }
    };
    let higherCaughtErr: any = null;
    await handleRazorpayWebhook(higherReq, mockResponse(), (err) => { higherCaughtErr = err; });
    assert.ok(higherCaughtErr instanceof ConflictError, 'Must fail on higher amount discrepancy');

    // 28c: Non-INR currency, negative, decimal, zero, unsafe integer
    for (const malformed of [
      { amount: 5000, currency: 'USD', label: 'non-INR currency USD' },
      { amount: -5000, currency: 'INR', label: 'negative amount' },
      { amount: 0, currency: 'INR', label: 'zero amount' },
      { amount: 49.99, currency: 'INR', label: 'decimal amount' },
      { amount: Number.MAX_SAFE_INTEGER + 10, currency: 'INR', label: 'unsafe integer' }
    ]) {
      const malReq: any = {
        headers: { 'x-razorpay-signature': 'mock' },
        body: {
          id: `evt_mal_28_${Date.now()}_${Math.random()}`,
          event: 'refund.processed',
          payload: {
            refund: {
              entity: {
                id: 'rfnd_mal_gw',
                payment_id: rpPaymentId,
                receipt: refundId,
                amount: malformed.amount,
                currency: malformed.currency,
                created_at: Math.floor(Date.now() / 1000)
              }
            }
          }
        }
      };
      let malErr: any = null;
      await handleRazorpayWebhook(malReq, mockResponse(), (err) => { malErr = err; });
      assert.ok(malErr instanceof BadRequestError, `Must reject ${malformed.label} with BadRequestError`);
    }

    console.log('   PASS [Fix 1: Webhook Amount Verification]: Amount & currency checks enforced; reservations safely held.');
  }

  // Scenario 29: [Phase 2.7.2.3 Fix 3: Handle refund.failed & Release Pending Reservation]
  {
    console.log('\nScenario 29 [Fix 3: Webhook refund.failed]: Release pending reservation hold...');
    const orderId = 'ORD-WH-FAIL-29';
    const refundId = 'RFND-29-FAIL';
    const rpPaymentId = 'pay_mock_wh_29';
    await db.run('DELETE FROM inventory_ledger WHERE order_id = ?', [orderId]).catch(() => {});
    await db.run('DELETE FROM refunds WHERE order_id = ?', [orderId]);
    await db.run('DELETE FROM orders WHERE id = ?', [orderId]);
    await db.run(
      `INSERT INTO orders (id, machine_id, product_id, amount, status, dispense_status, razorpay_order_id, razorpay_payment_id, captured_amount_paise, refund_status, total_refunded_amount_paise, pending_refund_amount_paise, created_at, updated_at)
       VALUES (?, 'CFX-MC-01', 1, 100, 'PAID', 'PENDING', 'order_wh_29', ?, 10000, 'PARTIAL', 0, 4000, ?, ?)`,
      [orderId, rpPaymentId, new Date().toISOString(), new Date().toISOString()]
    );
    await db.run(
      `INSERT INTO refunds (id, order_id, machine_id, razorpay_payment_id, razorpay_refund_id, amount_paise, currency, status, reason, initiated_by, source, idempotency_key, created_at, updated_at)
       VALUES (?, ?, 'CFX-MC-01', ?, 'rfnd_fail_gw_29', 4000, 'INR', 'PENDING', 'Testing refund failure release', 'admin@caffix.com', 'SUPER_ADMIN_PORTAL', 'idem_29_fail', ?, ?)`,
      [refundId, orderId, rpPaymentId, new Date().toISOString(), new Date().toISOString()]
    );

    const failReq: any = {
      headers: { 'x-razorpay-signature': 'mock' },
      body: {
        id: `evt_fail_29_${Date.now()}`,
        event: 'refund.failed',
        payload: {
          refund: {
            entity: {
              id: 'rfnd_fail_gw_29',
              payment_id: rpPaymentId,
              receipt: refundId,
              amount: 4000,
              currency: 'INR',
              error_code: 'BANK_DECLINED',
              error_description: 'Card issuer declined refund transaction'
            }
          }
        }
      }
    };
    const failRes = mockResponse();
    await handleRazorpayWebhook(failReq, failRes, () => {});
    assert.strictEqual(failRes.statusCode, 200);

    const refund = await db.get('SELECT * FROM refunds WHERE id = ?', [refundId]);
    assert.strictEqual(refund.status, 'FAILED');
    assert.strictEqual(refund.error_code, 'BANK_DECLINED');
    assert.ok(refund.error_description.includes('Card issuer declined'));

    const order = await db.get('SELECT * FROM orders WHERE id = ?', [orderId]);
    assert.strictEqual(Number(order.pending_refund_amount_paise), 0, 'Pending hold must be released to 0');
    assert.strictEqual(Number(order.total_refunded_amount_paise), 0);

    // Order can now dispense cleanly because pending hold was released
    const dispRes = await executeOrderStatusUpdate(orderId, 'PREPARING');
    assert.strictEqual(dispRes.status, 'PREPARING');
    console.log('   PASS [Fix 3: Webhook refund.failed]: Pending reservation cleanly released and beverage dispense unblocked.');
  }

  // Scenario 30: [Phase 2.7.2.3 Fix 3: refund.failed Arriving After refund.processed]
  {
    console.log('\nScenario 30 [Fix 3: Terminal Protection]: Late refund.failed cannot downgrade PROCESSED...');
    const orderId = 'ORD-WH-TERM-30';
    const refundId = 'RFND-30-PROC';
    const rpPaymentId = 'pay_mock_wh_30';
    await db.run('DELETE FROM inventory_ledger WHERE order_id = ?', [orderId]).catch(() => {});
    await db.run('DELETE FROM refunds WHERE order_id = ?', [orderId]);
    await db.run('DELETE FROM orders WHERE id = ?', [orderId]);
    await db.run(
      `INSERT INTO orders (id, machine_id, product_id, amount, status, dispense_status, razorpay_order_id, razorpay_payment_id, captured_amount_paise, refund_status, total_refunded_amount_paise, pending_refund_amount_paise, created_at, updated_at)
       VALUES (?, 'CFX-MC-01', 1, 100, 'PAID', 'PENDING', 'order_wh_30', ?, 10000, 'PARTIAL', 5000, 0, ?, ?)`,
      [orderId, rpPaymentId, new Date().toISOString(), new Date().toISOString()]
    );
    await db.run(
      `INSERT INTO refunds (id, order_id, machine_id, razorpay_payment_id, razorpay_refund_id, amount_paise, currency, status, reason, initiated_by, source, idempotency_key, created_at, updated_at, processed_at)
       VALUES (?, ?, 'CFX-MC-01', ?, 'rfnd_proc_gw_30', 5000, 'INR', 'PROCESSED', 'Already settled refund', 'admin@caffix.com', 'SUPER_ADMIN_PORTAL', 'idem_30_term', ?, ?, ?)`,
      [refundId, orderId, rpPaymentId, new Date().toISOString(), new Date().toISOString(), new Date().toISOString()]
    );

    const lateFailReq: any = {
      headers: { 'x-razorpay-signature': 'mock' },
      body: {
        id: `evt_late_fail_30_${Date.now()}`,
        event: 'refund.failed',
        payload: {
          refund: {
            entity: {
              id: 'rfnd_proc_gw_30',
              payment_id: rpPaymentId,
              receipt: refundId,
              amount: 5000,
              currency: 'INR',
              error_code: 'OUT_OF_ORDER_FAILURE'
            }
          }
        }
      }
    };
    const lateFailRes = mockResponse();
    await handleRazorpayWebhook(lateFailReq, lateFailRes, () => {});
    assert.strictEqual(lateFailRes.statusCode, 200);

    const refund = await db.get('SELECT * FROM refunds WHERE id = ?', [refundId]);
    assert.strictEqual(refund.status, 'PROCESSED', 'Terminal PROCESSED status must NOT be downgraded');
    const order = await db.get('SELECT * FROM orders WHERE id = ?', [orderId]);
    assert.strictEqual(Number(order.total_refunded_amount_paise), 5000, 'Total refunded amount must remain intact');
    console.log('   PASS [Fix 3: Terminal Protection]: Settled PROCESSED refund preserved against out-of-order refund.failed.');
  }

  // Scenario 31: [Phase 2.7.2.3 Fix 4: Two Simultaneous Deliveries of Same Event]
  {
    console.log('\nScenario 31 [Fix 4: Concurrency]: Two simultaneous deliveries of identical event...');
    const orderId = 'ORD-CONC-DELIV-31';
    const eventId = `evt_simult_31_${Date.now()}`;
    await db.run('DELETE FROM inventory_ledger WHERE order_id = ?', [orderId]).catch(() => {});
    await db.run('DELETE FROM refunds WHERE order_id = ?', [orderId]);
    await db.run('DELETE FROM orders WHERE id = ?', [orderId]);
    await db.run('DELETE FROM webhook_events WHERE event_id = ?', [eventId]);
    await db.run(
      `INSERT INTO orders (id, machine_id, product_id, amount, status, dispense_status, razorpay_order_id, razorpay_payment_id, captured_amount_paise, refund_status, total_refunded_amount_paise, pending_refund_amount_paise, created_at, updated_at)
       VALUES (?, 'CFX-MC-01', 1, 100, 'PENDING', 'PENDING', 'order_simult_31', 'pay_simult_31', NULL, 'NONE', 0, 0, ?, ?)`,
      [orderId, new Date().toISOString(), new Date().toISOString()]
    );

    const body = {
      id: eventId,
      event: 'payment.captured',
      created_at: Math.floor(Date.now() / 1000),
      payload: {
        payment: {
          entity: {
            id: 'pay_simult_31',
            order_id: 'order_simult_31',
            amount: 10000,
            currency: 'INR',
            status: 'captured'
          }
        }
      }
    };

    const req1: any = { headers: { 'x-razorpay-signature': 'mock' }, body };
    const req2: any = { headers: { 'x-razorpay-signature': 'mock' }, body };
    const res1 = mockResponse();
    const res2 = mockResponse();

    // Execute concurrently
    await Promise.all([
      handleRazorpayWebhook(req1, res1, () => {}),
      handleRazorpayWebhook(req2, res2, () => {})
    ]);

    // One must succeed with 200, the other must be deduplicated (200) or rejected with conflict (409)
    assert.ok(res1.statusCode === 200 || res1.statusCode === 409);
    assert.ok(res2.statusCode === 200 || res2.statusCode === 409);
    const hasDeduplicatedOrConflict = res1.body?.deduplicated || res2.body?.deduplicated || res1.statusCode === 409 || res2.statusCode === 409;
    assert.ok(hasDeduplicatedOrConflict, 'At least one request must be detected as duplicate or in-flight');

    const order = await db.get('SELECT * FROM orders WHERE id = ?', [orderId]);
    assert.strictEqual(order.status, 'PAID');
    assert.strictEqual(Number(order.captured_amount_paise), 10000);
    console.log('   PASS [Fix 4: Concurrency]: Simultaneous event delivery serialized without duplicate processing.');
  }

  // Scenario 32: [Phase 2.7.2.3 Fix 3: Out-of-Order: refund.processed After refund.failed]
  {
    console.log('\nScenario 32 [Fix 3: Out-of-Order]: refund.processed overrides previous FAILED with audit trail...');
    const orderId = 'ORD-OOO-32';
    const refundId = 'RFND-32-OOO';
    const rpPaymentId = 'pay_mock_wh_32';
    await db.run('DELETE FROM inventory_ledger WHERE order_id = ?', [orderId]).catch(() => {});
    await db.run('DELETE FROM refunds WHERE order_id = ?', [orderId]);
    await db.run('DELETE FROM orders WHERE id = ?', [orderId]);
    await db.run(
      `INSERT INTO orders (id, machine_id, product_id, amount, status, dispense_status, razorpay_order_id, razorpay_payment_id, captured_amount_paise, refund_status, total_refunded_amount_paise, pending_refund_amount_paise, created_at, updated_at)
       VALUES (?, 'CFX-MC-01', 1, 100, 'PAID', 'PENDING', 'order_wh_32', ?, 10000, 'NONE', 0, 0, ?, ?)`,
      [orderId, rpPaymentId, new Date().toISOString(), new Date().toISOString()]
    );
    await db.run(
      `INSERT INTO refunds (id, order_id, machine_id, razorpay_payment_id, razorpay_refund_id, amount_paise, currency, status, reason, initiated_by, source, idempotency_key, error_code, error_description, created_at, updated_at)
       VALUES (?, ?, 'CFX-MC-01', ?, 'rfnd_ooo_fail_32', 5000, 'INR', 'FAILED', 'Premature client failure', 'admin@caffix.com', 'SUPER_ADMIN_PORTAL', 'idem_32_ooo', 'GATEWAY_TIMEOUT', 'Gateway timed out', ?, ?)`,
      [refundId, orderId, rpPaymentId, new Date().toISOString(), new Date().toISOString()]
    );

    const procReq: any = {
      headers: { 'x-razorpay-signature': 'mock' },
      body: {
        id: `evt_ooo_proc_32_${Date.now()}`,
        event: 'refund.processed',
        payload: {
          refund: {
            entity: {
              id: 'rfnd_ooo_proc_32',
              payment_id: rpPaymentId,
              receipt: refundId,
              amount: 5000,
              currency: 'INR',
              created_at: Math.floor(Date.now() / 1000)
            }
          }
        }
      }
    };
    const procRes = mockResponse();
    await handleRazorpayWebhook(procReq, procRes, () => {});
    assert.strictEqual(procRes.statusCode, 200);

    const refund = await db.get('SELECT * FROM refunds WHERE id = ?', [refundId]);
    assert.strictEqual(refund.status, 'PROCESSED');
    assert.ok(refund.notes.includes('AUTHORITATIVE_GATEWAY_OVERRIDE'), 'Must record authoritative override note');
    const order = await db.get('SELECT * FROM orders WHERE id = ?', [orderId]);
    assert.strictEqual(Number(order.total_refunded_amount_paise), 5000);
    console.log('   PASS [Fix 3: Out-of-Order]: refund.processed safely promoted FAILED record with audit trail.');
  }

  // Scenario 33: [Phase 2.7.2.3 Fix 2: Two Simulated Serverless Instances Sharing Firestore Ledger]
  {
    console.log('\nScenario 33 [Fix 2: Distributed Ledger]: Multi-instance Firestore claiming...');
    const sharedFirestoreMap = new Map<string, any>();
    const mockFirestoreInstance: any = {
      collection: (colName: string) => ({
        doc: (docId: string) => ({
          get: async () => ({
            exists: sharedFirestoreMap.has(`${colName}/${docId}`),
            data: () => sharedFirestoreMap.get(`${colName}/${docId}`)
          }),
          set: async (data: any, options?: any) => {
            if (options?.merge && sharedFirestoreMap.has(`${colName}/${docId}`)) {
              sharedFirestoreMap.set(`${colName}/${docId}`, {
                ...sharedFirestoreMap.get(`${colName}/${docId}`),
                ...data
              });
            } else {
              sharedFirestoreMap.set(`${colName}/${docId}`, data);
            }
          }
        })
      }),
      runTransaction: async (updateFn: any) => {
        const tx = {
          get: async (ref: any) => await ref.get(),
          set: async (ref: any, data: any, options?: any) => await ref.set(data, options)
        };
        return await updateFn(tx);
      }
    };

    setFirestoreForTesting({ firestoreInstance: mockFirestoreInstance });

    const eventId = `evt_dist_${Date.now()}`;
    // Instance 1 claims event
    const claim1 = await claimWebhookEvent(db, {
      provider: 'razorpay',
      eventId,
      eventType: 'payment.captured'
    });
    assert.strictEqual(claim1.shouldProcess, true, 'Instance 1 must successfully claim new event');
    assert.strictEqual(claim1.status, 'PROCESSING');

    // Instance 2 attempts to claim same event while lease is active
    const claim2 = await claimWebhookEvent(db, {
      provider: 'razorpay',
      eventId,
      eventType: 'payment.captured'
    });
    assert.strictEqual(claim2.shouldProcess, false, 'Instance 2 must be rejected while lease is active');
    assert.strictEqual(claim2.isConcurrentInFlight, true, 'Instance 2 must detect active concurrent claim');

    // Instance 1 marks event PROCESSED
    await markWebhookEventProcessed(db, 'razorpay', eventId);

    // Instance 3 attempts to claim after settlement: receives idempotent duplicate
    const claim3 = await claimWebhookEvent(db, {
      provider: 'razorpay',
      eventId,
      eventType: 'payment.captured'
    });
    assert.strictEqual(claim3.shouldProcess, false);
    assert.strictEqual(claim3.isDuplicate, true);

    // Reset test firestore instance
    setFirestoreForTesting({ firestoreInstance: null });
    console.log('   PASS [Fix 2: Distributed Ledger]: Multi-instance Firestore atomic claims verified.');
  }

  // Scenario 34: [Phase 2.7.2.3 Fix 2: Crash After Claim But Before Processing & Lease Recovery]
  {
    console.log('\nScenario 34 [Fix 2: Crash Recovery]: Recovery of event after crash before processing...');
    const orderId = 'ORD-CRASH-34';
    const eventId = `evt_crash_before_proc_34_${Date.now()}`;
    await db.run('DELETE FROM inventory_ledger WHERE order_id = ?', [orderId]).catch(() => {});
    await db.run('DELETE FROM refunds WHERE order_id = ?', [orderId]);
    await db.run('DELETE FROM orders WHERE id = ?', [orderId]);
    await db.run('DELETE FROM webhook_events WHERE event_id = ?', [eventId]);
    await db.run(
      `INSERT INTO orders (id, machine_id, product_id, amount, status, dispense_status, razorpay_order_id, razorpay_payment_id, captured_amount_paise, refund_status, total_refunded_amount_paise, pending_refund_amount_paise, created_at, updated_at)
       VALUES (?, 'CFX-MC-01', 1, 100, 'PENDING', 'PENDING', 'order_crash_34', 'pay_crash_34', NULL, 'NONE', 0, 0, ?, ?)`,
      [orderId, new Date().toISOString(), new Date().toISOString()]
    );

    // Instance 1 claims event with a 50ms short lease, then "crashes" immediately
    const claim1 = await claimWebhookEvent(db, {
      provider: 'razorpay',
      eventId,
      eventType: 'payment.captured',
      leaseDurationMs: 50
    });
    assert.strictEqual(claim1.shouldProcess, true);

    // Confirm order is still in original PENDING status
    const orderUntouched = await db.get('SELECT status FROM orders WHERE id = ?', [orderId]);
    assert.strictEqual(orderUntouched.status, 'PENDING');

    // Wait 60ms for lease to expire
    await new Promise((r) => setTimeout(r, 60));

    // Instance 2 receives retry and recovers the claim
    const claim2 = await claimWebhookEvent(db, {
      provider: 'razorpay',
      eventId,
      eventType: 'payment.captured',
      leaseDurationMs: 60000
    });
    assert.strictEqual(claim2.shouldProcess, true, 'Instance 2 must recover expired claim');
    assert.strictEqual(claim2.isRecovery, true, 'Must be flagged as lease recovery');

    // Instance 2 executes order transition
    await executeOrderStatusUpdate(orderId, 'PAID', { capturedAmountPaise: 10000 });
    await markWebhookEventProcessed(db, 'razorpay', eventId);

    const orderFinal = await db.get('SELECT * FROM orders WHERE id = ?', [orderId]);
    assert.strictEqual(orderFinal.status, 'PAID');
    console.log('   PASS [Fix 2: Crash Recovery]: Expired lease safely recovered and processed without duplication.');
  }

  // Scenario 35: [Phase 2.7.2.3 Fix 2: Crash After Financial Mutation But Before Ledger Completion]
  {
    console.log('\nScenario 35 [Fix 2: Crash Recovery]: Idempotent retry when crash occurs after financial write...');
    const orderId = 'ORD-CRASH-35';
    const eventId = `evt_crash_after_fin_35_${Date.now()}`;
    await db.run('DELETE FROM inventory_ledger WHERE order_id = ?', [orderId]).catch(() => {});
    await db.run('DELETE FROM refunds WHERE order_id = ?', [orderId]);
    await db.run('DELETE FROM orders WHERE id = ?', [orderId]);
    await db.run('DELETE FROM webhook_events WHERE event_id = ?', [eventId]);
    await db.run(
      `INSERT INTO orders (id, machine_id, product_id, amount, status, dispense_status, razorpay_order_id, razorpay_payment_id, captured_amount_paise, refund_status, total_refunded_amount_paise, pending_refund_amount_paise, created_at, updated_at)
       VALUES (?, 'CFX-MC-01', 1, 100, 'PENDING', 'PENDING', 'order_crash_35', 'pay_crash_35', NULL, 'NONE', 0, 0, ?, ?)`,
      [orderId, new Date().toISOString(), new Date().toISOString()]
    );

    // Instance 1 claims event with 50ms lease
    await claimWebhookEvent(db, {
      provider: 'razorpay',
      eventId,
      eventType: 'payment.captured',
      leaseDurationMs: 50
    });

    // Instance 1 successfully mutates financial state (marks PAID)
    await executeOrderStatusUpdate(orderId, 'PAID', {
      capturedAmountPaise: 10000,
      razorpayPaymentId: 'pay_crash_35'
    });

    // Instance 1 crashes right here before calling markWebhookEventProcessed!
    // Wait 60ms for lease to expire
    await new Promise((r) => setTimeout(r, 60));

    // Gateway retries webhook delivery to Instance 2
    const webhookReq: any = {
      headers: { 'x-razorpay-signature': 'mock' },
      body: {
        id: eventId,
        event: 'payment.captured',
        created_at: Math.floor(Date.now() / 1000),
        payload: {
          payment: {
            entity: {
              id: 'pay_crash_35',
              order_id: 'order_crash_35',
              amount: 10000,
              currency: 'INR',
              status: 'captured'
            }
          }
        }
      }
    };
    const webhookRes = mockResponse();
    await handleRazorpayWebhook(webhookReq, webhookRes, () => {});
    assert.strictEqual(webhookRes.statusCode, 200);

    // Ledger must now be PROCESSED
    const ledgerRow = await db.get('SELECT * FROM webhook_events WHERE event_id = ?', [eventId]);
    assert.strictEqual(ledgerRow.status, 'PROCESSED');

    // Order must still be PAID without duplicate deductions
    const order = await db.get('SELECT * FROM orders WHERE id = ?', [orderId]);
    assert.strictEqual(order.status, 'PAID');
    console.log('   PASS [Fix 2: Crash Recovery]: Idempotent recovery verified when crash occurs after financial mutation.');
  }

  // Scenario 36: [Phase 2.7.2.3 Fix 4: Explicit Lease Expiration & Claim Transitions]
  {
    console.log('\nScenario 36 [Fix 4: Lease Transitions]: Comprehensive lease state transitions...');
    const eventId = `evt_trans_${Date.now()}`;
    await db.run('DELETE FROM webhook_events WHERE event_id = ?', [eventId]);

    // 1. Initial claim: status = PROCESSING
    const c1 = await claimWebhookEvent(db, { provider: 'razorpay', eventId, eventType: 'order.paid', leaseDurationMs: 50 });
    assert.strictEqual(c1.shouldProcess, true);
    assert.strictEqual(c1.isNew, true);

    // 2. Immediate second claim: rejected with isConcurrentInFlight
    const c2 = await claimWebhookEvent(db, { provider: 'razorpay', eventId, eventType: 'order.paid' });
    assert.strictEqual(c2.shouldProcess, false);
    assert.strictEqual(c2.isConcurrentInFlight, true);

    // 3. Mark FAILED: retry claim succeeds
    await markWebhookEventFailed(db, 'razorpay', eventId, 'Simulated transient network drop');
    const c3 = await claimWebhookEvent(db, { provider: 'razorpay', eventId, eventType: 'order.paid' });
    assert.strictEqual(c3.shouldProcess, true);
    assert.strictEqual(c3.isRetry, true);

    // 4. Mark PROCESSED: subsequent claim returns duplicate replay
    await markWebhookEventProcessed(db, 'razorpay', eventId);
    const c4 = await claimWebhookEvent(db, { provider: 'razorpay', eventId, eventType: 'order.paid' });
    assert.strictEqual(c4.shouldProcess, false);
    assert.strictEqual(c4.isDuplicate, true);
    console.log('   PASS [Fix 4: Lease Transitions]: Full state lifecycle (NEW -> IN_FLIGHT -> FAILED -> RETRY -> PROCESSED -> DUP) verified.');
  }

  // Scenario 37: [Phase 2.7.2.3 Fix 5: Webhook Payload Privacy & PII Redaction]
  {
    console.log('\nScenario 37 [Fix 5: PII Redaction]: Sensitive customer details sanitized before storage...');
    const rawPayload = {
      id: `evt_pii_${Date.now()}`,
      event: 'payment.captured',
      payload: {
        payment: {
          entity: {
            id: 'pay_pii_999',
            amount: 10000,
            currency: 'INR',
            email: 'customer.vip@example.com',
            contact: '+919876543210',
            vpa: 'customer@okaxis',
            card_number: '4111111111111111',
            notes: {
              customer_email: 'backup.customer@example.com',
              customer_phone: '+919999988888',
              non_sensitive_tag: 'coffee_break'
            }
          }
        }
      }
    };

    // 1. Direct unit check of sanitizeWebhookPayload
    const sanitized = sanitizeWebhookPayload(rawPayload);
    assert.strictEqual(sanitized.payload.payment.entity.email, '[REDACTED]');
    assert.strictEqual(sanitized.payload.payment.entity.contact, '[REDACTED]');
    assert.strictEqual(sanitized.payload.payment.entity.vpa, '[REDACTED]');
    assert.strictEqual(sanitized.payload.payment.entity.card_number, '[REDACTED]');
    assert.strictEqual(sanitized.payload.payment.entity.notes.customer_email, '[REDACTED]');
    assert.strictEqual(sanitized.payload.payment.entity.notes.customer_phone, '[REDACTED]');
    // Non-sensitive fields preserved
    assert.strictEqual(sanitized.payload.payment.entity.id, 'pay_pii_999');
    assert.strictEqual(sanitized.payload.payment.entity.amount, 10000);
    assert.strictEqual(sanitized.payload.payment.entity.notes.non_sensitive_tag, 'coffee_break');

    // 2. Integration check: verify persisted row in webhook_events
    const eventId = `evt_pii_integ_${Date.now()}`;
    const orderId = 'ORD-PII-37';
    await db.run('DELETE FROM inventory_ledger WHERE order_id = ?', [orderId]).catch(() => {});
    await db.run('DELETE FROM refunds WHERE order_id = ?', [orderId]);
    await db.run('DELETE FROM orders WHERE id = ?', [orderId]);
    await db.run('DELETE FROM webhook_events WHERE event_id = ?', [eventId]);
    await db.run(
      `INSERT INTO orders (id, machine_id, product_id, amount, status, dispense_status, razorpay_order_id, razorpay_payment_id, captured_amount_paise, refund_status, total_refunded_amount_paise, pending_refund_amount_paise, created_at, updated_at)
       VALUES (?, 'CFX-MC-01', 1, 100, 'PENDING', 'PENDING', 'order_pii_37', 'pay_pii_integ_37', NULL, 'NONE', 0, 0, ?, ?)`,
      [orderId, new Date().toISOString(), new Date().toISOString()]
    );

    const piiWebhookReq: any = {
      headers: { 'x-razorpay-signature': 'mock' },
      body: {
        id: eventId,
        event: 'payment.captured',
        created_at: Math.floor(Date.now() / 1000),
        payload: {
          payment: {
            entity: {
              id: 'pay_pii_integ_37',
              order_id: 'order_pii_37',
              amount: 10000,
              currency: 'INR',
              email: 'secret.buyer@caffix.test',
              contact: '+919123456789'
            }
          }
        }
      }
    };
    const piiWebhookRes = mockResponse();
    await handleRazorpayWebhook(piiWebhookReq, piiWebhookRes, () => {});
    assert.strictEqual(piiWebhookRes.statusCode, 200);

    const persistedRow = await db.get('SELECT * FROM webhook_events WHERE event_id = ?', [eventId]);
    assert.ok(persistedRow);
    assert.ok(!persistedRow.payload.includes('secret.buyer@caffix.test'), 'Plaintext email must NOT exist in persisted ledger');
    assert.ok(!persistedRow.payload.includes('+919123456789'), 'Plaintext contact phone must NOT exist in persisted ledger');
    assert.ok(persistedRow.payload.includes('[REDACTED]'), 'Must contain [REDACTED] markers');
    console.log('   PASS [Fix 5: PII Redaction]: Sensitive customer PII strictly redacted from persisted webhook ledger.');
  }

  // --------------------------------------------------------------------------
  // Phase 2.7.2.4 Hardening Tests (F-1 through F-4)
  // --------------------------------------------------------------------------

  // Scenario 38: [F-1 Fencing: Stale Worker Financial Mutation Rejection]
  {
    console.log('\nScenario 38 [F-1 Fencing]: Stale worker rejected at transaction boundary...');
    const orderId = 'ORD-FENCE-38';
    const eventId = `evt_fence_38_${Date.now()}`;
    const refundId = 'RFND-FENCE-38';
    await db.run('DELETE FROM inventory_ledger WHERE order_id = ?', [orderId]).catch(() => {});
    await db.run('DELETE FROM refunds WHERE order_id = ?', [orderId]);
    await db.run('DELETE FROM orders WHERE id = ?', [orderId]);
    await db.run('DELETE FROM webhook_events WHERE event_id = ?', [eventId]);

    await db.run(
      `INSERT INTO orders (id, machine_id, product_id, amount, status, dispense_status, razorpay_order_id, razorpay_payment_id, captured_amount_paise, refund_status, total_refunded_amount_paise, pending_refund_amount_paise, created_at, updated_at)
       VALUES (?, 'CFX-MC-01', 1, 100, 'PAID', 'PENDING', 'order_fence_38', 'pay_fence_38', 10000, 'NONE', 0, 0, ?, ?)`,
      [orderId, new Date().toISOString(), new Date().toISOString()]
    );

    // 1. Worker A claims with 50ms lease (generation 1)
    const claimA = await claimWebhookEvent(db, {
      provider: 'razorpay',
      eventId,
      eventType: 'refund.processed',
      leaseDurationMs: 50
    });
    assert.strictEqual(claimA.claimCount, 1, 'Worker A must have claim generation 1');

    // 2. Worker A pauses beyond lease expiry (60ms)
    await new Promise((r) => setTimeout(r, 60));

    // 3. Worker B reclaims (generation 2)
    const claimB = await claimWebhookEvent(db, {
      provider: 'razorpay',
      eventId,
      eventType: 'refund.processed',
      leaseDurationMs: 60000
    });
    assert.strictEqual(claimB.claimCount, 2, 'Worker B must have claim generation 2');
    assert.strictEqual(claimB.isRecovery, true);

    // 4. Worker B successfully reconciles refund
    const resB = await reconcileAuthoritativeGatewayRefundOutcome(db, {
      orderId,
      razorpayRefundId: 'rfnd_fence_38_b',
      razorpayPaymentId: 'pay_fence_38',
      amount_paise: 5000,
      currency: 'INR',
      refundId,
      machineId: 'CFX-MC-01',
      webhookFencing: { provider: 'razorpay', eventId, claimCount: claimB.claimCount! }
    });
    assert.strictEqual(resB.refund.status, 'PROCESSED');
    await markWebhookEventProcessed(db, 'razorpay', eventId, { claimCount: claimB.claimCount });

    // Verify order total was updated by Worker B
    const orderAfterB = await db.get('SELECT * FROM orders WHERE id = ?', [orderId]);
    assert.strictEqual(Number(orderAfterB.total_refunded_amount_paise), 5000);

    // 5. Worker A wakes up and attempts financial settlement with stale generation 1
    let workerARejected = false;
    try {
      await reconcileAuthoritativeGatewayRefundOutcome(db, {
        orderId,
        razorpayRefundId: 'rfnd_fence_38_a',
        razorpayPaymentId: 'pay_fence_38',
        amount_paise: 5000,
        currency: 'INR',
        refundId: 'RFND-STALE-A',
        machineId: 'CFX-MC-01',
        webhookFencing: { provider: 'razorpay', eventId, claimCount: claimA.claimCount! }
      });
    } catch (err: any) {
      if (err instanceof ConflictError && err.message.includes('[STALE_WEBHOOK_WORKER]')) {
        workerARejected = true;
      }
    }
    assert.strictEqual(workerARejected, true, 'Worker A must be strictly rejected by fencing check');

    // Prove that Worker A did not double-increment totals
    const orderFinal = await db.get('SELECT * FROM orders WHERE id = ?', [orderId]);
    assert.strictEqual(Number(orderFinal.total_refunded_amount_paise), 5000, 'Order total must remain 5000 without double refund');

    console.log('   PASS [F-1 Fencing: Stale Worker Financial Mutation Rejection]: Superseded worker rejected at transaction boundary.');
  }

  // Scenario 39: [F-1 Fencing: Stale Worker Cannot Overwrite PROCESSED or Demote to FAILED]
  {
    console.log('\nScenario 39 [F-1 Fencing]: Stale worker ledger immutability...');
    const eventId = `evt_fence_39_${Date.now()}`;
    await db.run('DELETE FROM webhook_events WHERE event_id = ?', [eventId]);

    // 1. Initial claim generation 1
    const c1 = await claimWebhookEvent(db, { provider: 'razorpay', eventId, eventType: 'refund.processed', leaseDurationMs: 50 });
    assert.strictEqual(c1.claimCount, 1);

    // Wait for lease expiry
    await new Promise((r) => setTimeout(r, 60));

    // 2. Recovery claim generation 2
    const c2 = await claimWebhookEvent(db, { provider: 'razorpay', eventId, eventType: 'refund.processed' });
    assert.strictEqual(c2.claimCount, 2);

    // 3. Worker B marks PROCESSED
    await markWebhookEventProcessed(db, 'razorpay', eventId, { claimCount: c2.claimCount });
    const rowProcessed = await db.get('SELECT * FROM webhook_events WHERE event_id = ?', [eventId]);
    assert.strictEqual(rowProcessed.status, 'PROCESSED');
    assert.strictEqual(rowProcessed.claim_count, 2);

    // 4. Stale Worker A attempts to mark FAILED with generation 1
    await markWebhookEventFailed(db, 'razorpay', eventId, 'Stale worker A error', c1.claimCount);
    const rowAfterFailAttempt = await db.get('SELECT * FROM webhook_events WHERE event_id = ?', [eventId]);
    assert.strictEqual(rowAfterFailAttempt.status, 'PROCESSED', 'Must NOT demote PROCESSED to FAILED');
    assert.strictEqual(rowAfterFailAttempt.claim_count, 2, 'claim_count must remain 2');

    // 5. Stale Worker A attempts to mark PROCESSED with generation 1
    await markWebhookEventProcessed(db, 'razorpay', eventId, { claimCount: c1.claimCount });
    const rowAfterProcAttempt = await db.get('SELECT * FROM webhook_events WHERE event_id = ?', [eventId]);
    assert.strictEqual(rowAfterProcAttempt.claim_count, 2, 'claim_count must remain 2');

    console.log('   PASS [F-1 Fencing: Stale Worker Ledger Immutability]: Stale worker blocked from demoting or overwriting ledger.');
  }

  // Scenario 40: [F-2: Cold-Start Order Lookup via Firestore]
  {
    console.log('\nScenario 40 [F-2 Cold Start]: Webhook hydrates order from Firestore when local SQLite misses...');
    const orderId = 'ORD-COLD-40';
    const eventId = `evt_cold_40_${Date.now()}`;
    const paymentId = 'pay_cold_40_999';

    // Clear SQLite
    await db.run('DELETE FROM inventory_ledger WHERE order_id = ?', [orderId]).catch(() => {});
    await db.run('DELETE FROM refunds WHERE order_id = ?', [orderId]);
    await db.run('DELETE FROM orders WHERE id = ?', [orderId]);
    await db.run('DELETE FROM webhook_events WHERE event_id = ?', [eventId]);

    // Setup Firestore mock holding authoritative order
    const firestoreDb = new Map<string, any>();
    firestoreDb.set(`orders/${orderId}`, {
      id: orderId,
      machine_id: 'CFX-MC-01',
      product_id: 1,
      amount: 100,
      captured_amount_paise: 10000,
      status: 'PAID',
      dispense_status: 'PENDING',
      razorpay_order_id: 'order_cold_40',
      razorpay_payment_id: paymentId,
      total_refunded_amount_paise: 0,
      pending_refund_amount_paise: 0,
      refund_status: 'NONE',
      refund_version: 1
    });

    const mockFs: any = {
      collection: (colName: string) => ({
        doc: (docId: string) => ({
          get: async () => ({
            exists: firestoreDb.has(`${colName}/${docId}`),
            data: () => firestoreDb.get(`${colName}/${docId}`)
          }),
          set: async (data: any, options?: any) => {
            const key = `${colName}/${docId}`;
            if (options?.merge && firestoreDb.has(key)) {
              firestoreDb.set(key, { ...firestoreDb.get(key), ...data });
            } else {
              firestoreDb.set(key, data);
            }
          },
          collection: (subCol: string) => ({
            doc: (subDocId: string) => ({
              set: async (data: any, options?: any) => {
                const subKey = `${colName}/${docId}/${subCol}/${subDocId}`;
                if (options?.merge && firestoreDb.has(subKey)) {
                  firestoreDb.set(subKey, { ...firestoreDb.get(subKey), ...data });
                } else {
                  firestoreDb.set(subKey, data);
                }
              }
            })
          })
        }),
        where: (field: string, op: string, val: any) => ({
          limit: (n: number) => ({
            get: async () => {
              const matches: any[] = [];
              for (const [k, v] of firestoreDb.entries()) {
                if (k.startsWith(`${colName}/`) && !k.includes('/', colName.length + 1)) {
                  if (v[field] === val) {
                    matches.push({
                      id: v.id || k.split('/')[1],
                      data: () => v
                    });
                  }
                }
              }
              return { empty: matches.length === 0, docs: matches };
            }
          })
        })
      }),
      runTransaction: async (updateFn: any) => {
        const tx = {
          get: async (ref: any) => await ref.get(),
          set: async (ref: any, data: any, options?: any) => await ref.set(data, options)
        };
        return await updateFn(tx);
      }
    };

    setFirestoreForTesting({ firestoreInstance: mockFs });

    // Send refund.processed webhook with payment ID only (empty SQLite database!)
    const req: any = {
      headers: { 'x-razorpay-signature': 'mock' },
      body: {
        id: eventId,
        event: 'refund.processed',
        created_at: Math.floor(Date.now() / 1000),
        payload: {
          refund: {
            entity: {
              id: 'rfnd_cold_40_gw',
              payment_id: paymentId,
              amount: 5000,
              currency: 'INR'
            }
          }
        }
      }
    };
    const res = mockResponse();
    await handleRazorpayWebhook(req, res, () => {});
    assert.strictEqual(res.statusCode, 200, 'Webhook must succeed by hydrating order from Firestore');

    // Verify refund document was recorded in Firestore
    const orderAfter = firestoreDb.get(`orders/${orderId}`);
    assert.strictEqual(Number(orderAfter.total_refunded_amount_paise), 5000);
    assert.strictEqual(orderAfter.refund_status, 'PARTIAL');

    setFirestoreForTesting({ firestoreInstance: null });
    console.log('   PASS [F-2 Cold Start]: Webhook successfully hydrated order from Firestore when local SQLite was empty.');
  }

  // Scenario 41: [F-2: Fail-Closed Behavior on Firestore Unavailability in Vercel/Preview]
  {
    console.log('\nScenario 41 [F-2 Fail-Closed]: Strict fail-closed when Firestore unavailable in Vercel/Preview...');
    process.env.VERCEL = '1';
    setFirestoreForTesting({ firestoreInstance: null });

    const req: any = {
      headers: { 'x-razorpay-signature': 'mock' },
      body: {
        id: `evt_fc_41_${Date.now()}`,
        event: 'refund.processed',
        payload: {
          refund: {
            entity: { id: 'rfnd_fc_41', payment_id: 'pay_fc_41', amount: 5000, currency: 'INR' }
          }
        }
      }
    };
    let errorPassed: any = null;
    await handleRazorpayWebhook(req, mockResponse(), (err) => {
      errorPassed = err;
    });

    assert.ok(errorPassed instanceof ServiceUnavailableError, 'Must fail closed with ServiceUnavailableError');
    delete process.env.VERCEL;
    console.log('   PASS [F-2 Fail-Closed]: Strict fail-closed verified when Firestore unavailable in Vercel/Preview.');
  }

  // Scenario 42: [F-3: Machine ID Inheritance on Unreserved Gateway Refund]
  {
    console.log('\nScenario 42 [F-3 Machine ID Inheritance]: Unreserved refund inherits machine ID...');
    const orderId = 'ORD-UNRES-42';
    await db.run('DELETE FROM inventory_ledger WHERE order_id = ?', [orderId]).catch(() => {});
    await db.run('DELETE FROM refunds WHERE order_id = ?', [orderId]);
    await db.run('DELETE FROM orders WHERE id = ?', [orderId]);

    await db.run(
      `INSERT INTO orders (id, machine_id, product_id, amount, status, dispense_status, razorpay_order_id, razorpay_payment_id, captured_amount_paise, refund_status, total_refunded_amount_paise, pending_refund_amount_paise, created_at, updated_at)
       VALUES (?, 'CFX-MC-02', 1, 100, 'PAID', 'PENDING', 'order_unres_42', 'pay_unres_42', 10000, 'NONE', 0, 0, ?, ?)`,
      [orderId, new Date().toISOString(), new Date().toISOString()]
    );

    const res = await reconcileAuthoritativeGatewayRefundOutcome(db, {
      orderId,
      razorpayRefundId: 'rfnd_unres_gw_42',
      razorpayPaymentId: 'pay_unres_42',
      amount_paise: 4000,
      currency: 'INR',
      machineId: 'CFX-MC-02'
    });

    assert.strictEqual(res.refund.machine_id, 'CFX-MC-02', 'Refund must inherit CFX-MC-02');
    const dbRow = await db.get('SELECT * FROM refunds WHERE razorpay_refund_id = ?', ['rfnd_unres_gw_42']);
    assert.strictEqual(dbRow.machine_id, 'CFX-MC-02', 'Persisted SQLite row must have machine_id CFX-MC-02');
    console.log('   PASS [F-3 Machine ID Inheritance]: Unreserved refund correctly inherited authoritative machine ID.');
  }

  // Scenario 43: [F-3: Cross-Machine Owner Isolation for Refunds]
  {
    console.log('\nScenario 43 [F-3 Machine Isolation]: Strict owner dashboard machine isolation...');
    const order1 = 'ORD-ISO-M1';
    const order2 = 'ORD-ISO-M2';
    await db.run('DELETE FROM inventory_ledger WHERE order_id IN (?, ?)', [order1, order2]).catch(() => {});
    await db.run('DELETE FROM refunds WHERE order_id IN (?, ?)', [order1, order2]);
    await db.run('DELETE FROM orders WHERE id IN (?, ?)', [order1, order2]);

    await db.run(
      `INSERT INTO orders (id, machine_id, product_id, amount, status, dispense_status, razorpay_order_id, razorpay_payment_id, captured_amount_paise, refund_status, total_refunded_amount_paise, pending_refund_amount_paise, created_at, updated_at)
       VALUES (?, 'CFX-MC-01', 1, 100, 'PAID', 'PENDING', 'order_iso_1', 'pay_iso_1', 10000, 'NONE', 0, 0, ?, ?)`,
      [order1, new Date().toISOString(), new Date().toISOString()]
    );
    await db.run(
      `INSERT INTO orders (id, machine_id, product_id, amount, status, dispense_status, razorpay_order_id, razorpay_payment_id, captured_amount_paise, refund_status, total_refunded_amount_paise, pending_refund_amount_paise, created_at, updated_at)
       VALUES (?, 'CFX-MC-02', 1, 100, 'PAID', 'PENDING', 'order_iso_2', 'pay_iso_2', 10000, 'NONE', 0, 0, ?, ?)`,
      [order2, new Date().toISOString(), new Date().toISOString()]
    );

    await reconcileAuthoritativeGatewayRefundOutcome(db, {
      orderId: order1,
      razorpayRefundId: 'rfnd_iso_1',
      amount_paise: 3000,
      currency: 'INR',
      machineId: 'CFX-MC-01'
    });

    await reconcileAuthoritativeGatewayRefundOutcome(db, {
      orderId: order2,
      razorpayRefundId: 'rfnd_iso_2',
      amount_paise: 7000,
      currency: 'INR',
      machineId: 'CFX-MC-02'
    });

    const m1Refunds = await db.all('SELECT * FROM refunds WHERE machine_id = ? AND order_id = ?', ['CFX-MC-01', order1]);
    assert.strictEqual(m1Refunds.length, 1);
    assert.strictEqual(m1Refunds[0].razorpay_refund_id, 'rfnd_iso_1');

    // Verify machine 1 cannot see machine 2's refund
    const m1CrossCheck = await db.all('SELECT * FROM refunds WHERE machine_id = ? AND order_id = ?', ['CFX-MC-01', order2]);
    assert.strictEqual(m1CrossCheck.length, 0, 'Machine 1 must not see refunds for order 2');

    const m2Refunds = await db.all('SELECT * FROM refunds WHERE machine_id = ? AND order_id = ?', ['CFX-MC-02', order2]);
    assert.strictEqual(m2Refunds.length, 1);
    assert.strictEqual(m2Refunds[0].razorpay_refund_id, 'rfnd_iso_2');

    // Verify machine 2 cannot see machine 1's refund
    const m2CrossCheck = await db.all('SELECT * FROM refunds WHERE machine_id = ? AND order_id = ?', ['CFX-MC-02', order1]);
    assert.strictEqual(m2CrossCheck.length, 0, 'Machine 2 must not see refunds for order 1');

    console.log('   PASS [F-3 Machine Isolation]: Strict owner dashboard machine isolation verified for refunds.');
  }

  // Scenario 44: [F-4: Expanded PII Scrubbing Across Nested Structures & Metadata]
  {
    console.log('\nScenario 44 [F-4 Expanded PII Redaction]: Deep recursive scrubbing across all sensitive fields...');
    const rawData = {
      event: 'payment.captured',
      payload: {
        payment: {
          entity: {
            id: 'pay_deep_pii_44',
            amount: 15000,
            currency: 'INR',
            name: 'Robert Customer',
            customer_name: 'Robert Customer',
            email: 'robert@customer.com',
            contact: '+919876543210',
            account_number: '123456789012',
            bank_account: 'HDFC0001234',
            address: '42 Galaxy Road',
            billing_address: '42 Galaxy Road, Suite 5',
            shipping_address: '42 Galaxy Road, Suite 5',
            upi_id: 'robert@upi',
            notes: {
              Customer_Name: 'Robert Alternate',
              Billing_Address: 'Alternate Street 10',
              UPI_ID: 'robert_notes@okicici',
              drink_type: 'Cappuccino'
            },
            tags: [
              { user_name: 'user_tag', account_number: '987654321098' }
            ]
          }
        }
      }
    };

    const sanitized = sanitizeWebhookPayload(rawData);
    const p = sanitized.payload.payment.entity;

    // Direct assertions on all expanded PII fields
    assert.strictEqual(p.name, '[REDACTED]');
    assert.strictEqual(p.customer_name, '[REDACTED]');
    assert.strictEqual(p.email, '[REDACTED]');
    assert.strictEqual(p.contact, '[REDACTED]');
    assert.strictEqual(p.account_number, '[REDACTED]');
    assert.strictEqual(p.bank_account, '[REDACTED]');
    assert.strictEqual(p.address, '[REDACTED]');
    assert.strictEqual(p.billing_address, '[REDACTED]');
    assert.strictEqual(p.shipping_address, '[REDACTED]');
    assert.strictEqual(p.upi_id, '[REDACTED]');

    // Case-insensitive nested metadata
    assert.strictEqual(p.notes.Customer_Name, '[REDACTED]');
    assert.strictEqual(p.notes.Billing_Address, '[REDACTED]');
    assert.strictEqual(p.notes.UPI_ID, '[REDACTED]');

    // Array traversal
    assert.strictEqual(p.tags[0].account_number, '[REDACTED]');

    // Operational fields preserved
    assert.strictEqual(p.id, 'pay_deep_pii_44');
    assert.strictEqual(p.amount, 15000);
    assert.strictEqual(p.currency, 'INR');
    assert.strictEqual(p.notes.drink_type, 'Cappuccino');

    console.log('   PASS [F-4 Expanded PII Redaction]: Deep recursive scrubbing across all sensitive fields verified.');
  }

  // Scenario 45: [L-2 Production Mock Payment ID Protection & Ambiguous Env Fail-Closed]
  {
    console.log('\nScenario 45 [L-2 Production Mock Protection]: Production rejects mock/test payment IDs & ambiguous Vercel config...');
    const savedEnv = {
      NODE_ENV: process.env.NODE_ENV,
      VERCEL: process.env.VERCEL,
      VERCEL_ENV: process.env.VERCEL_ENV,
      RAZORPAY_KEY_ID: process.env.RAZORPAY_KEY_ID,
      RAZORPAY_KEY_SECRET: process.env.RAZORPAY_KEY_SECRET
    };

    try {
      // 1. Ambiguous VERCEL=1 without VERCEL_ENV fails closed
      process.env.VERCEL = '1';
      delete process.env.VERCEL_ENV;
      delete process.env.RAZORPAY_KEY_ID;
      delete process.env.RAZORPAY_KEY_SECRET;

      let ambiguousErr: any = null;
      try {
        resolveRazorpayRefundConfig();
      } catch (e) {
        ambiguousErr = e;
      }
      assert.ok(ambiguousErr instanceof ServiceUnavailableError, 'Ambiguous VERCEL=1 without VERCEL_ENV must fail closed with ServiceUnavailableError');

      // 2. Production rejects pay_mock_* and test_* cleanly
      process.env.VERCEL = '1';
      process.env.VERCEL_ENV = 'production';
      process.env.RAZORPAY_KEY_ID = 'rzp_live_valid_prod_key';
      process.env.RAZORPAY_KEY_SECRET = 'live_prod_secret_123456';

      for (const badPayId of ['pay_mock_12345', 'test_pay_12345']) {
        let mockErr: any = null;
        try {
          await executeGatewayRefund({
            orderId: 'ORD-L2-PROD',
            paymentId: badPayId,
            amountPaise: 5000,
            receipt: `rcpt_l2_${badPayId}`,
            notes: { reason: 'Prod mock rejection test' }
          });
        } catch (e) {
          mockErr = e;
        }
        assert.ok(mockErr instanceof BadRequestError, `Production must reject '${badPayId}' with BadRequestError`);
        assert.ok(
          mockErr.message.includes('not allowed for refund execution in Production'),
          `Unexpected BadRequestError message: ${mockErr.message}`
        );
      }

      // 3. Non-production local/test mock still functions normally
      delete process.env.VERCEL;
      delete process.env.VERCEL_ENV;
      process.env.NODE_ENV = 'test';
      delete process.env.RAZORPAY_KEY_ID;
      delete process.env.RAZORPAY_KEY_SECRET;
      const nonProdCfg = resolveRazorpayRefundConfig();
      assert.strictEqual(nonProdCfg.isMockMode, true);
      const okMock = await executeGatewayRefund({
        orderId: 'ORD-L2-LOCAL',
        paymentId: 'pay_mock_l2_ok',
        amountPaise: 2500,
        receipt: `rcpt_l2_local_${Date.now()}`,
        notes: { reason: 'Local mock verification' }
      });
      assert.strictEqual(okMock.isMock, true);
      assert.strictEqual(okMock.success, true);
      assert.strictEqual(okMock.amountPaise, 2500);
      console.log('   PASS [L-2 Production Mock Protection]: Production blocks mock/test IDs & ambiguous env fails closed.');
    } finally {
      if (savedEnv.NODE_ENV === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = savedEnv.NODE_ENV;
      if (savedEnv.VERCEL === undefined) delete process.env.VERCEL;
      else process.env.VERCEL = savedEnv.VERCEL;
      if (savedEnv.VERCEL_ENV === undefined) delete process.env.VERCEL_ENV;
      else process.env.VERCEL_ENV = savedEnv.VERCEL_ENV;
      if (savedEnv.RAZORPAY_KEY_ID === undefined) delete process.env.RAZORPAY_KEY_ID;
      else process.env.RAZORPAY_KEY_ID = savedEnv.RAZORPAY_KEY_ID;
      if (savedEnv.RAZORPAY_KEY_SECRET === undefined) delete process.env.RAZORPAY_KEY_SECRET;
      else process.env.RAZORPAY_KEY_SECRET = savedEnv.RAZORPAY_KEY_SECRET;
    }
  }

  console.log('\n========================================================================');
  console.log('ALL Phase 2.7.2.1, 2.7.2.2 & 2.7.2.4 Hardening Tests PASSED!');
  console.log('========================================================================\n');
}

runPhase2_7_2Tests()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('\nTest failed with error:', err);
    process.exit(1);
  });
