import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import type http from 'node:http';
import { Firestore } from 'firebase-admin/firestore';

const EMULATOR_HOST = '127.0.0.1:8088';
const EMULATOR_PROJECT_ID = 'demo-caffix-emulator';
const TEST_PORT = 5099;
const TEST_CRON_SECRET = 'phase_h4_cron_secret_alpha_999';

// Configure isolated Firebase Firestore Emulator environment BEFORE importing backend modules
process.env.FIRESTORE_EMULATOR_HOST = EMULATOR_HOST;
process.env.FIREBASE_PROJECT_ID = EMULATOR_PROJECT_ID;
delete process.env.VERCEL;
delete process.env.VERCEL_ENV;
delete process.env.STRICT_FIREBASE_VALIDATION;
process.env.NODE_ENV = 'test';
process.env.PORT = String(TEST_PORT);
process.env.CRON_SECRET = TEST_CRON_SECRET;
process.env.JWT_SECRET = 'phase_h4_jwt_secret_123456';
process.env.KIOSK_SECRET = 'phase_h4_shared_kiosk_secret';
process.env.ENFORCE_PER_MACHINE_SECRETS = 'true';
process.env.RAZORPAY_KEY_ID = 'mock_test_key_isolated';
process.env.RAZORPAY_KEY_SECRET = 'mock_test_secret_isolated';
process.env.RAZORPAY_WEBHOOK_SECRET = 'h4_prep_wh_secret_abc456';
delete process.env.BLOCK_OFFLINE_MACHINE_ORDERS;
delete process.env.AUTO_REFUND_QUEUED_EXPIRY_MINUTES;

// Load db.ts with VERCEL unset so sqlite3 loads natively, then briefly set VERCEL=1 while
// requiring ../index so it does not auto-listen on port 5000.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { initDB, getDB } = require('../config/db');
process.env.VERCEL = '1';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const app = require('../index').default;
delete process.env.VERCEL;
delete process.env.RAZORPAY_KEY_ID;
delete process.env.RAZORPAY_KEY_SECRET;
delete process.env.BLOCK_OFFLINE_MACHINE_ORDERS;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const {
  DEFAULT_AUTO_REFUND_QUEUED_EXPIRY_MINUTES,
  runAutoRefundSweep
} = require('../services/autoRefundService');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const {
  AUTO_REFUND_CRON_LOCK_DOC_ID,
  DEFAULT_CRON_LEASE_TTL_MS,
  ORDER_RECONCILIATION_LOCK_DOC_ID,
  acquireAutoRefundLeaseInFirebase,
  enrichAuthoritativeOrderRecord,
  ensureFirebaseReady,
  getFirestoreInstance,
  getPaidOrdersForAutoRefundFromFirebase,
  releaseAutoRefundLeaseInFirebase,
  resetFirestoreSeedStateForTesting,
  setFirestoreForTesting
} = require('../utils/firebase');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const jwt = require('jsonwebtoken');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { runPendingOrderReconciliation } = require('../controllers/cronController');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { setRazorpayClientForTesting } = require('../controllers/orderController');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const {
  executeGatewayRefund,
  setRazorpayRefundClientForTesting
} = require('../utils/razorpayRefundClient');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { reconcileOrderRecord } = require('../services/reconciliationService');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { clearSyncedRefundsStore } = require('../utils/refunds');

async function clearEmulatorDatabase(): Promise<void> {
  const url = `http://${EMULATOR_HOST}/emulator/v1/projects/${EMULATOR_PROJECT_ID}/databases/(default)/documents`;
  const res = await fetch(url, { method: 'DELETE' });
  if (!res.ok) {
    throw new Error(`Failed to clear Firestore Emulator database: HTTP ${res.status}`);
  }
}

async function seedOrdersBatch(
  firestore: Firestore,
  orders: Record<string, any>[]
): Promise<void> {
  const chunkSize = 400;
  for (let i = 0; i < orders.length; i += chunkSize) {
    const batch = firestore.batch();
    for (const order of orders.slice(i, i + chunkSize)) {
      batch.set(firestore.collection('orders').doc(order.id), order);
    }
    await batch.commit();
  }
}

async function httpJson(
  baseUrl: string,
  method: string,
  path: string,
  options?: {
    token?: string;
    headers?: Record<string, string>;
    body?: any;
  }
): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options?.headers || {})
  };
  if (options?.token) {
    headers.Authorization = `Bearer ${options.token}`;
  }
  const res = await fetch(`${baseUrl}/api${path}`, {
    method,
    headers,
    body: options?.body !== undefined ? JSON.stringify(options.body) : undefined
  });
  const text = await res.text();
  let parsed: any = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    // leave as text
  }
  return { status: res.status, body: parsed };
}

async function runTests(): Promise<void> {
  console.log('\n==============================================================');
  console.log('CAFFIX Phase H.4 Automated Refund Preparation Emulator Tests');
  console.log('==============================================================\n');

  await clearEmulatorDatabase();
  resetFirestoreSeedStateForTesting();
  clearSyncedRefundsStore();

  await initDB();
  const db = getDB();
  ensureFirebaseReady();
  const firestore = getFirestoreInstance();
  assert.ok(firestore, 'Firestore Emulator instance must be active');

  // Seed products and machines cleanly
  await firestore.collection('machines').doc('CFX-MC-01').set({
    id: 'CFX-MC-01',
    machine_name: 'Caffix Demo 1',
    location: 'Lab A',
    desired_mode: 'RUNNING',
    status: 'online',
    kiosk_token: 'tok_mc01_h4',
    last_seen: new Date().toISOString()
  });
  await firestore.collection('machines').doc('CFX-MC-02').set({
    id: 'CFX-MC-02',
    machine_name: 'Caffix Demo 2',
    location: 'Lab B',
    desired_mode: 'RUNNING',
    status: 'online',
    kiosk_token: 'tok_mc02_h4',
    last_seen: new Date().toISOString()
  });
  await db.run('UPDATE machines SET kiosk_token = ?, desired_mode = ? WHERE id = ?', [
    'tok_mc01_h4',
    'RUNNING',
    'CFX-MC-01'
  ]);
  await db.run('UPDATE machines SET kiosk_token = ?, desired_mode = ? WHERE id = ?', [
    'tok_mc02_h4',
    'RUNNING',
    'CFX-MC-02'
  ]);
  await firestore.collection('products').doc('1').set({
    id: 1,
    name: 'Classic Crest',
    price: 100,
    available: true
  });

  const server: http.Server = await new Promise((resolve) => {
    const srv = app.listen(TEST_PORT, () => resolve(srv));
  });
  const baseUrl = `http://127.0.0.1:${TEST_PORT}`;

  try {
    const kioskRes = await httpJson(baseUrl, 'GET', '/kiosk/verify?kiosk=tok_mc01_h4&machine_id=CFX-MC-01');
    assert.strictEqual(kioskRes.status, 200);
    const mc1Jwt = kioskRes.body.token;
    assert.ok(mc1Jwt, 'Kiosk JWT must be issued');

    // =========================================================================
    // TEST 1: Starvation resistance past 200 orders & bounded cron limit = 20
    // =========================================================================
    console.log('1. Testing query starvation resistance (>220 blocking orders) and bounded cron limit (20)...');
    const refundCallReceipts: string[] = [];
    setRazorpayRefundClientForTesting({
      payments: {
        refund: async (paymentId: string, payload: any) => {
          refundCallReceipts.push(String(payload?.receipt || paymentId));
          return {
            id: `rfnd_h4_${crypto.randomBytes(4).toString('hex')}`,
            payment_id: paymentId,
            amount: Number(payload.amount),
            currency: 'INR',
            status: 'processed',
            receipt: payload.receipt,
            notes: payload.notes,
            created_at: Math.floor(Date.now() / 1000)
          };
        },
        fetchRefunds: async () => ({ items: [] })
      },
      refunds: {
        fetch: async () => null
      }
    });

    const baseTimeMs = Date.now() - 24 * 60 * 60_000;
    const blockingOrders: Record<string, any>[] = [];

    // 120 older PAID orders already FULL-refunded
    for (let i = 0; i < 120; i++) {
      const ts = new Date(baseTimeMs + i * 1000).toISOString();
      blockingOrders.push({
        id: `CFX-H4-FULL-${String(i).padStart(3, '0')}`,
        machine_id: 'CFX-MC-02',
        product_id: 1,
        product_name: 'Classic Crest',
        coffee: 'Classic Crest',
        amount: 100,
        captured_amount_paise: 10000,
        status: 'PAID',
        dispense_status: 'FAILED',
        dispensed: false,
        refund_status: 'FULL',
        total_refunded_amount_paise: 10000,
        pending_refund_amount_paise: 0,
        razorpay_order_id: `order_full_${i}`,
        razorpay_payment_id: `pay_full_${i}`,
        created_at: ts,
        paid_at: ts,
        expires_at: new Date(Date.parse(ts) + 5 * 60_000).toISOString(),
        updated_at: ts
      });
    }

    // 100 older PAID orders already DISPENSED with refund_status=NONE
    for (let i = 0; i < 100; i++) {
      const ts = new Date(baseTimeMs + (200 + i) * 1000).toISOString();
      blockingOrders.push({
        id: `CFX-H4-DISP-${String(i).padStart(3, '0')}`,
        machine_id: 'CFX-MC-02',
        product_id: 1,
        product_name: 'Classic Crest',
        coffee: 'Classic Crest',
        amount: 100,
        captured_amount_paise: 10000,
        status: 'PAID',
        dispense_status: 'DISPENSED',
        dispensed: true,
        refund_status: 'NONE',
        total_refunded_amount_paise: 0,
        pending_refund_amount_paise: 0,
        razorpay_order_id: `order_disp_${i}`,
        razorpay_payment_id: `pay_disp_${i}`,
        created_at: ts,
        paid_at: ts,
        expires_at: new Date(Date.parse(ts) + 5 * 60_000).toISOString(),
        updated_at: ts
      });
    }

    // 50 older PAID + EXPIRED orders whose prior auto-refund FAILED at gateway (refund_status=FAILED)
    const failedRefundIds: string[] = [];
    for (let i = 0; i < 50; i++) {
      const ts = new Date(baseTimeMs + (300 + i) * 1000).toISOString();
      const id = `CFX-H4-RFFAIL-${String(i).padStart(3, '0')}`;
      failedRefundIds.push(id);
      blockingOrders.push({
        id,
        machine_id: 'CFX-MC-02',
        product_id: 1,
        product_name: 'Classic Crest',
        coffee: 'Classic Crest',
        amount: 100,
        captured_amount_paise: 10000,
        status: 'PAID',
        dispense_status: 'EXPIRED',
        dispense_outcome: 'NOT_DISPENSED',
        failure_stage: 'PRE_DISPENSE',
        failure_reason: 'QUEUED_ORDER_EXPIRED_UNCLAIMED',
        dispensed: false,
        refund_status: 'FAILED',
        total_refunded_amount_paise: 0,
        pending_refund_amount_paise: 0,
        razorpay_order_id: `order_rffail_${i}`,
        razorpay_payment_id: `pay_rffail_${i}`,
        created_at: ts,
        paid_at: ts,
        expires_at: new Date(Date.parse(ts) + 5 * 60_000).toISOString(),
        expired_at: new Date(Date.parse(ts) + 6 * 60_000).toISOString(),
        updated_at: ts
      });
    }

    // 25 newer eligible expired QUEUED orders sitting beyond the 270 blocking docs
    const eligibleExpiredIds: string[] = [];
    for (let i = 0; i < 25; i++) {
      const ts = new Date(baseTimeMs + (400 + i) * 1000).toISOString();
      const id = `CFX-H4-ELIG-${String(i).padStart(3, '0')}`;
      eligibleExpiredIds.push(id);
      blockingOrders.push({
        id,
        machine_id: 'CFX-MC-02',
        product_id: 1,
        product_name: 'Classic Crest',
        coffee: 'Classic Crest',
        amount: 100,
        captured_amount_paise: 10000,
        status: 'PAID',
        dispense_status: 'QUEUED',
        dispensed: false,
        refund_status: 'NONE',
        total_refunded_amount_paise: 0,
        pending_refund_amount_paise: 0,
        razorpay_order_id: `order_elig_${i}`,
        razorpay_payment_id: `pay_elig_${i}`,
        created_at: ts,
        paid_at: ts,
        expires_at: new Date(Date.parse(ts) + 5 * 60_000).toISOString(),
        updated_at: ts
      });
    }

    await seedOrdersBatch(firestore, blockingOrders);

    // Even when caller requests limit=500, /api/cron/auto-refund bounds execution to 20 orders
    const cronRun1 = await httpJson(baseUrl, 'GET', '/cron/auto-refund?limit=500', {
      headers: { Authorization: `Bearer ${TEST_CRON_SECRET}` }
    });
    assert.strictEqual(cronRun1.status, 200);
    assert.strictEqual(cronRun1.body.data.scanned, 20, 'Bounded cron sweep must cap scanned/processed batch to 20');
    assert.strictEqual(cronRun1.body.data.eligible, 20, 'Starvation fix must discover 20 eligible orders past 270 FULL/DISPENSED/FAILED docs');
    assert.strictEqual(cronRun1.body.data.refunded_processed, 20);
    assert.strictEqual(cronRun1.body.data.expired_queued, 20);

    // Second cron run processes the remaining 5 eligible orders
    const cronRun2 = await httpJson(baseUrl, 'GET', '/cron/auto-refund', {
      headers: { Authorization: `Bearer ${TEST_CRON_SECRET}` }
    });
    assert.strictEqual(cronRun2.status, 200);
    assert.strictEqual(cronRun2.body.data.eligible, 5, 'Remaining 5 eligible orders must be processed on next bounded sweep');
    assert.strictEqual(cronRun2.body.data.refunded_processed, 5);
    assert.strictEqual(cronRun2.body.data.expired_queued, 5);

    for (const id of eligibleExpiredIds) {
      const snap = await firestore.collection('orders').doc(id).get();
      assert.strictEqual(snap.data()?.refund_status, 'FULL', `${id} must be FULL refunded`);
      assert.strictEqual(snap.data()?.dispense_status, 'EXPIRED', `${id} must be marked EXPIRED`);
    }
    for (const id of failedRefundIds.slice(0, 5)) {
      const snap = await firestore.collection('orders').doc(id).get();
      assert.strictEqual(snap.data()?.refund_status, 'FAILED', `${id} must remain FAILED without consuming batch slots`);
    }
    console.log('   PASS: 25 eligible orders behind 270 FULL/DISPENSED/FAILED orders refunded across bounded batches of 20.');

    // =========================================================================
    // TEST 2: Pending refund on COMPLETED order reconciled across all statuses
    // =========================================================================
    console.log('2. Testing pending refund reconciliation on COMPLETED order...');
    const completedOrderId = 'CFX-H4-COMP-PEND-01';
    const completedRefundId = 'rfnd_res_h4_comp_01';
    const completedPaymentId = 'pay_h4_comp_01';
    const completedRpRefundId = 'rfnd_gw_h4_comp_01';
    const compCreatedIso = new Date(Date.now() - 30 * 60_000).toISOString();

    await firestore.collection('orders').doc(completedOrderId).set({
      id: completedOrderId,
      machine_id: 'CFX-MC-02',
      product_id: 1,
      product_name: 'Classic Crest',
      coffee: 'Classic Crest',
      amount: 100,
      captured_amount_paise: 10000,
      status: 'COMPLETED',
      dispense_status: 'DISPENSED',
      dispensed: true,
      refund_status: 'PENDING',
      total_refunded_amount_paise: 0,
      pending_refund_amount_paise: 10000,
      razorpay_order_id: 'order_h4_comp_01',
      razorpay_payment_id: completedPaymentId,
      created_at: compCreatedIso,
      paid_at: compCreatedIso,
      updated_at: compCreatedIso
    });
    const pendingRefundDoc = {
      id: completedRefundId,
      order_id: completedOrderId,
      machine_id: 'CFX-MC-02',
      razorpay_payment_id: completedPaymentId,
      razorpay_refund_id: completedRpRefundId,
      amount_paise: 10000,
      currency: 'INR',
      status: 'PENDING',
      reason: 'customer_complaint_partial_pour',
      notes: 'H4 test pending refund on COMPLETED order',
      initiated_by: 'super_admin',
      source: 'SUPER_ADMIN_PORTAL',
      idempotency_key: 'idem_h4_comp_01',
      error_code: null,
      error_description: null,
      created_at: compCreatedIso,
      updated_at: compCreatedIso,
      processed_at: null
    };
    await firestore.collection('refunds').doc(completedRefundId).set(pendingRefundDoc);
    await firestore
      .collection('orders')
      .doc(completedOrderId)
      .collection('refunds')
      .doc(completedRefundId)
      .set(pendingRefundDoc);

    setRazorpayRefundClientForTesting({
      payments: {
        refund: async () => {
          throw new Error('Unexpected new refund initiation during pending reconciliation');
        },
        fetchRefunds: async () => ({ items: [] })
      },
      refunds: {
        fetch: async (rpRefundId: string) => {
          assert.strictEqual(rpRefundId, completedRpRefundId);
          return {
            id: completedRpRefundId,
            payment_id: completedPaymentId,
            amount: 10000,
            currency: 'INR',
            status: 'processed',
            created_at: Math.floor(Date.now() / 1000)
          };
        }
      }
    });

    const compSweep = await runAutoRefundSweep({ machineId: 'CFX-MC-02' });
    assert.strictEqual(compSweep.reconciled_pending_processed, 1, 'COMPLETED order pending refund must reconcile to PROCESSED');
    assert.strictEqual(compSweep.refunded_processed, 1);

    const compOrderAfter = (await firestore.collection('orders').doc(completedOrderId).get()).data();
    const compRefundAfter = (await firestore.collection('refunds').doc(completedRefundId).get()).data();
    const compSubRefundAfter = (
      await firestore.collection('orders').doc(completedOrderId).collection('refunds').doc(completedRefundId).get()
    ).data();
    assert.strictEqual(compOrderAfter?.status, 'COMPLETED');
    assert.strictEqual(compOrderAfter?.refund_status, 'FULL');
    assert.strictEqual(compOrderAfter?.total_refunded_amount_paise, 10000);
    assert.strictEqual(compOrderAfter?.pending_refund_amount_paise, 0);
    assert.strictEqual(compRefundAfter?.status, 'PROCESSED');
    assert.strictEqual(compSubRefundAfter?.status, 'PROCESSED');
    console.log('   PASS: Pending refund on COMPLETED order reconciled across root, subcollection, and parent order.');

    // =========================================================================
    // TEST 3: Slow payment confirmation anchors expiry to paid_at
    // =========================================================================
    console.log('3. Testing slow payment confirmation & paid_at-anchored expiry window...');
    const createSlowRes = await httpJson(baseUrl, 'POST', '/orders/create', {
      token: mc1Jwt,
      body: { product_id: 1, amount: 100, machine_id: 'CFX-MC-01', base: 'water' }
    });
    assert.strictEqual(createSlowRes.status, 201);
    const slowOrderId = createSlowRes.body.data.id;
    assert.strictEqual(createSlowRes.body.data.paid_at, null);
    assert.ok(createSlowRes.body.data.expires_at, 'Pending order must carry provisional expires_at');

    // Simulate customer taking 25 minutes before completing payment
    const staleCreatedIso = new Date(Date.now() - 25 * 60_000).toISOString();
    const staleInitialExpiresIso = new Date(Date.parse(staleCreatedIso) + DEFAULT_AUTO_REFUND_QUEUED_EXPIRY_MINUTES * 60_000).toISOString();
    await firestore.collection('orders').doc(slowOrderId).update({
      created_at: staleCreatedIso,
      expires_at: staleInitialExpiresIso
    });
    await db.run('UPDATE orders SET created_at = ?, expires_at = ? WHERE id = ?', [
      staleCreatedIso,
      staleInitialExpiresIso,
      slowOrderId
    ]);

    // Payment confirms now via signed payment.captured webhook
    const rpOrderId = createSlowRes.body.data.razorpay_order_id;
    const rpPaymentId = 'pay_h4_slow_confirmed_01';
    const webhookPayload = {
      entity: 'event',
      event: 'payment.captured',
      payload: {
        payment: {
          entity: {
            id: rpPaymentId,
            entity: 'payment',
            order_id: rpOrderId,
            amount: 10000,
            currency: 'INR',
            status: 'captured',
            captured: true
          }
        }
      }
    };
    const rawWebhookBody = JSON.stringify(webhookPayload);
    const whSignature = crypto
      .createHmac('sha256', String(process.env.RAZORPAY_WEBHOOK_SECRET))
      .update(rawWebhookBody)
      .digest('hex');

    const whConfirmRes = await fetch(`${baseUrl}/api/payments/webhook`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-razorpay-signature': whSignature,
        'x-razorpay-event-id': 'evt_h4_slow_confirm_01'
      },
      body: rawWebhookBody
    });
    assert.strictEqual(whConfirmRes.status, 200);

    const slowPaidSnap = (await firestore.collection('orders').doc(slowOrderId).get()).data();
    assert.strictEqual(slowPaidSnap?.status, 'PAID');
    assert.ok(slowPaidSnap?.paid_at, 'paid_at must be populated when order transitions to PAID');
    const paidMs = Date.parse(String(slowPaidSnap?.paid_at));
    const anchoredExpiresMs = Date.parse(String(slowPaidSnap?.expires_at));
    assert.ok(
      Math.abs((anchoredExpiresMs - paidMs) - DEFAULT_AUTO_REFUND_QUEUED_EXPIRY_MINUTES * 60_000) < 2000,
      'expires_at must be re-anchored to paid_at + 5 minutes'
    );

    setRazorpayRefundClientForTesting({
      payments: {
        refund: async (paymentId: string, payload: any) => ({
          id: `rfnd_h4_slow_${crypto.randomBytes(4).toString('hex')}`,
          payment_id: paymentId,
          amount: Number(payload.amount),
          currency: 'INR',
          status: 'processed',
          receipt: payload.receipt,
          created_at: Math.floor(Date.now() / 1000)
        }),
        fetchRefunds: async () => ({ items: [] })
      },
      refunds: { fetch: async () => null }
    });

    // Immediate sweep after slow confirmation must NOT expire or refund!
    const sweepRightAfterPay = await runAutoRefundSweep({
      machineId: 'CFX-MC-01',
      nowMs: paidMs + 60_000
    });
    assert.strictEqual(sweepRightAfterPay.skipped_not_expired, 1, 'Slow-confirmed order must NOT expire 1 minute after paid_at');
    assert.strictEqual(sweepRightAfterPay.refunded_processed, 0);

    // Sweep 16 minutes after paid_at MUST expire & auto-refund
    const sweepPastPaidExpiry = await runAutoRefundSweep({
      machineId: 'CFX-MC-01',
      nowMs: paidMs + 16 * 60_000
    });
    assert.strictEqual(sweepPastPaidExpiry.expired_queued, 1);
    assert.strictEqual(sweepPastPaidExpiry.refunded_processed, 1);
    const slowAfterExpiry = (await firestore.collection('orders').doc(slowOrderId).get()).data();
    assert.strictEqual(slowAfterExpiry?.dispense_status, 'EXPIRED');
    assert.strictEqual(slowAfterExpiry?.refund_status, 'FULL');
    console.log('   PASS: Slow payment confirmation anchored expires_at to paid_at and prevented premature expiry.');

    // =========================================================================
    // TEST 4: Offline machine order blocking (503 -> heartbeat -> 201)
    // =========================================================================
    console.log('4. Testing offline machine order blocking & heartbeat recovery...');
    process.env.BLOCK_OFFLINE_MACHINE_ORDERS = 'true';
    const staleLastSeen = new Date(Date.now() - 5 * 60_000).toISOString();
    await firestore.collection('machines').doc('CFX-MC-01').update({
      status: 'offline',
      last_seen: staleLastSeen
    });
    await db.run('UPDATE machines SET status = ?, last_seen = ? WHERE id = ?', [
      'offline',
      staleLastSeen,
      'CFX-MC-01'
    ]);

    const blockedCreate = await httpJson(baseUrl, 'POST', '/orders/create', {
      token: mc1Jwt,
      body: { product_id: 1, amount: 100, machine_id: 'CFX-MC-01', base: 'water' }
    });
    assert.strictEqual(blockedCreate.status, 503, 'Offline machine must block new orders with 503');

    const hbRes = await httpJson(baseUrl, 'POST', '/machines/CFX-MC-01/heartbeat', {
      token: mc1Jwt
    });
    assert.strictEqual(hbRes.status, 200);

    const recoveredCreate = await httpJson(baseUrl, 'POST', '/orders/create', {
      token: mc1Jwt,
      body: { product_id: 1, amount: 100, machine_id: 'CFX-MC-01', base: 'water' }
    });
    assert.strictEqual(recoveredCreate.status, 201, 'Online heartbeat must restore order creation (201)');
    delete process.env.BLOCK_OFFLINE_MACHINE_ORDERS;
    console.log('   PASS: Offline machine blocked (503) and restored after heartbeat (201).');

    // =========================================================================
    // TEST 5: Duplicate cron execution (lease lock) & Razorpay ETIMEDOUT handling
    // =========================================================================
    console.log('5. Testing duplicate cron execution lock & Razorpay ETIMEDOUT reservation...');

    // 5a: Concurrent sweep skips duplicate execution via Firestore lease lock
    const leaseOrderId = 'CFX-H4-LEASE-01';
    const leasePaymentId = 'pay_h4_lease_01';
    const oldPaidIso = new Date(Date.now() - 30 * 60_000).toISOString();
    await firestore.collection('orders').doc(leaseOrderId).set({
      id: leaseOrderId,
      machine_id: 'CFX-MC-02',
      product_id: 1,
      product_name: 'Classic Crest',
      coffee: 'Classic Crest',
      amount: 100,
      captured_amount_paise: 10000,
      status: 'PAID',
      dispense_status: 'QUEUED',
      dispensed: false,
      refund_status: 'NONE',
      total_refunded_amount_paise: 0,
      pending_refund_amount_paise: 0,
      razorpay_order_id: 'order_h4_lease_01',
      razorpay_payment_id: leasePaymentId,
      created_at: oldPaidIso,
      paid_at: oldPaidIso,
      expires_at: new Date(Date.parse(oldPaidIso) + 5 * 60_000).toISOString(),
      updated_at: oldPaidIso
    });

    let gatewayRefundInvokeCount = 0;
    setRazorpayRefundClientForTesting({
      payments: {
        refund: async (paymentId: string, payload: any) => {
          gatewayRefundInvokeCount += 1;
          await new Promise((r) => setTimeout(r, 250));
          return {
            id: `rfnd_h4_lease_${gatewayRefundInvokeCount}`,
            payment_id: paymentId,
            amount: Number(payload.amount),
            currency: 'INR',
            status: 'processed',
            receipt: payload.receipt,
            created_at: Math.floor(Date.now() / 1000)
          };
        },
        fetchRefunds: async () => ({ items: [] })
      },
      refunds: { fetch: async () => null }
    });

    const [sweepA, sweepB] = await Promise.all([
      runAutoRefundSweep({ machineId: 'CFX-MC-02' }),
      runAutoRefundSweep({ machineId: 'CFX-MC-02' })
    ]);
    assert.strictEqual(gatewayRefundInvokeCount, 1, 'Concurrent cron runs must invoke gateway refund strictly once');
    assert.strictEqual(
      Number(Boolean(sweepA.skipped_due_to_active_run)) + Number(Boolean(sweepB.skipped_due_to_active_run)),
      1,
      'Exactly one of two concurrent cron sweeps must be skipped by active lease'
    );

    // 5b: Gateway ETIMEDOUT leaves PENDING reservation intact and never retries automatically
    const timeoutOrderId = 'CFX-H4-TIMEOUT-01';
    const timeoutPaymentId = 'pay_h4_timeout_01';
    await firestore.collection('orders').doc(timeoutOrderId).set({
      id: timeoutOrderId,
      machine_id: 'CFX-MC-02',
      product_id: 1,
      product_name: 'Classic Crest',
      coffee: 'Classic Crest',
      amount: 100,
      captured_amount_paise: 10000,
      status: 'PAID',
      dispense_status: 'QUEUED',
      dispensed: false,
      refund_status: 'NONE',
      total_refunded_amount_paise: 0,
      pending_refund_amount_paise: 0,
      razorpay_order_id: 'order_h4_timeout_01',
      razorpay_payment_id: timeoutPaymentId,
      created_at: oldPaidIso,
      paid_at: oldPaidIso,
      expires_at: new Date(Date.parse(oldPaidIso) + 5 * 60_000).toISOString(),
      updated_at: oldPaidIso
    });

    let timeoutAttemptCount = 0;
    let capturedReceipt: string | null = null;
    setRazorpayRefundClientForTesting({
      payments: {
        refund: async (_paymentId: string, payload: any) => {
          timeoutAttemptCount += 1;
          capturedReceipt = String(payload?.receipt || '');
          const err: any = new Error('connect ETIMEDOUT');
          err.code = 'ETIMEDOUT';
          throw err;
        },
        fetchRefunds: async () => ({ items: [] })
      },
      refunds: { fetch: async () => null }
    });

    const timeoutSweep = await runAutoRefundSweep({ machineId: 'CFX-MC-02' });
    assert.strictEqual(timeoutAttemptCount, 1);
    assert.strictEqual(timeoutSweep.refund_pending, 1, 'ETIMEDOUT must leave refund PENDING safely');
    assert.strictEqual(timeoutSweep.errors, 0);

    const timeoutOrderSnap = (await firestore.collection('orders').doc(timeoutOrderId).get()).data();
    assert.strictEqual(timeoutOrderSnap?.refund_status, 'PENDING');
    assert.strictEqual(timeoutOrderSnap?.pending_refund_amount_paise, 10000);
    assert.strictEqual(timeoutOrderSnap?.dispense_status, 'EXPIRED');

    // Second sweep reconciles via payments.fetchRefunds without issuing another payments.refund
    setRazorpayRefundClientForTesting({
      payments: {
        refund: async () => {
          timeoutAttemptCount += 1;
          throw new Error('Must NOT call payments.refund again while reservation is PENDING');
        },
        fetchRefunds: async (pid: string) => {
          assert.strictEqual(pid, timeoutPaymentId);
          return {
            items: [
              {
                id: 'rfnd_h4_recovered_after_timeout',
                payment_id: timeoutPaymentId,
                amount: 10000,
                currency: 'INR',
                status: 'processed',
                receipt: capturedReceipt,
                created_at: Math.floor(Date.now() / 1000)
              }
            ]
          };
        }
      },
      refunds: { fetch: async () => null }
    });

    const recoverSweep = await runAutoRefundSweep({ machineId: 'CFX-MC-02' });
    assert.strictEqual(timeoutAttemptCount, 1, 'Pending timeout reservation must never initiate a second refund');
    assert.strictEqual(recoverSweep.reconciled_pending_processed, 1);
    const recoveredTimeoutOrder = (await firestore.collection('orders').doc(timeoutOrderId).get()).data();
    assert.strictEqual(recoveredTimeoutOrder?.refund_status, 'FULL');
    assert.strictEqual(recoveredTimeoutOrder?.pending_refund_amount_paise, 0);
    assert.strictEqual(recoveredTimeoutOrder?.total_refunded_amount_paise, 10000);
    console.log('   PASS: Duplicate cron lease lock, ETIMEDOUT PENDING hold, and receipt reconciliation verified.');

    // =========================================================================
    // TEST 6: Fallback FAILED exclusion, Razorpay error metadata, & FAILED wording
    // =========================================================================
    console.log('6. Testing non-Firestore fallback FAILED exclusion, gateway error metadata, & reconciliation wording...');
    await db.run("DELETE FROM orders WHERE id LIKE 'CFX-H4-FB-%'");
    for (let i = 0; i < 25; i++) {
      const ts = new Date(baseTimeMs + i * 1000).toISOString();
      await db.run(
        `INSERT INTO orders (id, product_id, amount, status, dispense_status, refund_status, captured_amount_paise, total_refunded_amount_paise, pending_refund_amount_paise, machine_id, created_at, paid_at, razorpay_order_id, razorpay_payment_id)
         VALUES (?, 1, 1, 'PAID', 'EXPIRED', 'FAILED', 100, 0, 0, 'CFX-MC-01', ?, ?, ?, ?)`,
        [`CFX-H4-FB-FAIL-${String(i).padStart(2, '0')}`, ts, ts, `ord_fb_f_${i}`, `pay_fb_f_${i}`]
      );
    }
    const partialTs = new Date(baseTimeMs + 50 * 1000).toISOString();
    await db.run(
      `INSERT INTO orders (id, product_id, amount, status, dispense_status, refund_status, captured_amount_paise, total_refunded_amount_paise, pending_refund_amount_paise, machine_id, created_at, paid_at, razorpay_order_id, razorpay_payment_id)
       VALUES ('CFX-H4-FB-PARTIAL-PEND', 1, 100, 'PAID', 'FAILED', 'PARTIAL', 10000, 4000, 6000, 'CFX-MC-01', ?, ?, 'ord_fb_part', 'pay_fb_part')`,
      [partialTs, partialTs]
    );
    for (let i = 0; i < 5; i++) {
      const ts = new Date(baseTimeMs + (100 + i) * 1000).toISOString();
      await db.run(
        `INSERT INTO orders (id, product_id, amount, status, dispense_status, refund_status, captured_amount_paise, total_refunded_amount_paise, pending_refund_amount_paise, machine_id, created_at, paid_at, razorpay_order_id, razorpay_payment_id)
         VALUES (?, 1, 1, 'PAID', 'QUEUED', 'NONE', 100, 0, 0, 'CFX-MC-01', ?, ?, ?, ?)`,
        [`CFX-H4-FB-ELIG-${i}`, ts, ts, `ord_fb_e_${i}`, `pay_fb_e_${i}`]
      );
    }

    const savedEmuHost = process.env.FIRESTORE_EMULATOR_HOST;
    const savedProjectId = process.env.FIREBASE_PROJECT_ID;
    delete process.env.FIRESTORE_EMULATOR_HOST;
    delete process.env.FIREBASE_PROJECT_ID;
    setFirestoreForTesting({ firestoreInstance: null, clearStores: true });
    try {
      const fbSelected = await getPaidOrdersForAutoRefundFromFirebase(db, {
        machineId: 'CFX-MC-01',
        limit: 20
      });
      const fbIds = new Set(fbSelected.map((o: any) => o.id));
      for (let i = 0; i < 25; i++) {
        assert.strictEqual(
          fbIds.has(`CFX-H4-FB-FAIL-${String(i).padStart(2, '0')}`),
          false,
          'Non-Firestore fallback must exclude refund_status === FAILED orders'
        );
      }
      assert.strictEqual(
        fbIds.has('CFX-H4-FB-PARTIAL-PEND'),
        true,
        'PARTIAL order with pending_refund_amount_paise > 0 must remain included'
      );
      for (let i = 0; i < 5; i++) {
        assert.strictEqual(fbIds.has(`CFX-H4-FB-ELIG-${i}`), true);
      }
    } finally {
      if (savedEmuHost) process.env.FIRESTORE_EMULATOR_HOST = savedEmuHost;
      if (savedProjectId) process.env.FIREBASE_PROJECT_ID = savedProjectId;
      setFirestoreForTesting({ firestoreInstance: firestore });
      ensureFirebaseReady();
    }

    // 6b: Razorpay error logging retains statusCode, reason, source, step & redacts secrets
    setRazorpayRefundClientForTesting({
      payments: {
        refund: async () => {
          throw {
            statusCode: 403,
            error: {
              code: 'BAD_REQUEST_ERROR',
              description: 'Access is forbidden (Basic dXNlcjpzZWNyZXQ= / rzp_live_SecretKey999)',
              reason: 'access_denied',
              source: 'business',
              step: 'refund_initiation'
            }
          };
        }
      }
    });
    const gwForbidden = await executeGatewayRefund({
      orderId: 'CFX-H4-ERR-META-01',
      paymentId: 'pay_live_err_meta_01',
      amountPaise: 100,
      receipt: 'RFND-H4-META-01'
    });
    assert.strictEqual(gwForbidden.success, false);
    assert.strictEqual(gwForbidden.status, 'FAILED');
    assert.strictEqual(gwForbidden.httpStatusCode, 403);
    assert.strictEqual(gwForbidden.errorCode, 'BAD_REQUEST_ERROR');
    assert.strictEqual(gwForbidden.errorReason, 'access_denied');
    assert.strictEqual(gwForbidden.errorSource, 'business');
    assert.strictEqual(gwForbidden.errorStep, 'refund_initiation');
    assert.ok(gwForbidden.errorDescription?.includes('http=403'));
    assert.ok(gwForbidden.errorDescription?.includes('reason=access_denied'));
    assert.ok(gwForbidden.errorDescription?.includes('source=business'));
    assert.ok(gwForbidden.errorDescription?.includes('step=refund_initiation'));
    assert.ok(!gwForbidden.errorDescription?.includes('dXNlcjpzZWNyZXQ='));
    assert.ok(!gwForbidden.errorDescription?.includes('rzp_live_SecretKey999'));

    // 6c: Reconciliation wording distinguishes FAILED refund attempt from uninitiated refund
    const recFailedAttempt = reconcileOrderRecord(
      {
        id: 'CFX-H4-REC-FAIL',
        machine_id: 'CFX-MC-01',
        amount: 1,
        captured_amount_paise: 100,
        razorpay_payment_id: 'pay_rec_fail',
        status: 'PAID',
        dispense_status: 'EXPIRED',
        refund_status: 'FAILED',
        total_refunded_amount_paise: 0,
        pending_refund_amount_paise: 0,
        created_at: oldPaidIso,
        updated_at: oldPaidIso
      },
      { refunds: [] }
    );
    assert.strictEqual(recFailedAttempt.discrepancy_reason, 'DISPENSE_FAILED_UNREFUNDED');
    assert.ok(
      !recFailedAttempt.details.includes('no refund has been initiated'),
      'FAILED refund must NOT say no refund has been initiated'
    );
    assert.ok(recFailedAttempt.details.includes('a refund was attempted, but the payment gateway rejected the refund'));

    const recUninitiated = reconcileOrderRecord(
      {
        id: 'CFX-H4-REC-NONE',
        machine_id: 'CFX-MC-01',
        amount: 1,
        captured_amount_paise: 100,
        razorpay_payment_id: 'pay_rec_none',
        status: 'PAID',
        dispense_status: 'EXPIRED',
        refund_status: 'NONE',
        total_refunded_amount_paise: 0,
        pending_refund_amount_paise: 0,
        created_at: oldPaidIso,
        updated_at: oldPaidIso
      },
      { refunds: [] }
    );
    assert.ok(recUninitiated.details.includes('no refund has been initiated'));
    console.log('   PASS: Fallback FAILED exclusion, gateway error metadata/redaction, and FAILED wording verified.');

    // =========================================================================
    // TEST 7: Separate cron leases, 90s TTL, diagnostic metadata, post-lease timestamp & fencing
    // =========================================================================
    console.log('7. Testing simultaneous pending-order reconciliation + auto-refund sweep, lease fencing & metadata...');
    await clearEmulatorDatabase();
    resetFirestoreSeedStateForTesting();
    clearSyncedRefundsStore();
    await db.run("DELETE FROM refunds WHERE order_id LIKE 'CFX-P2-%'").catch(() => {});
    await db.run("DELETE FROM orders WHERE id LIKE 'CFX-P2-%'").catch(() => {});

    assert.strictEqual(ORDER_RECONCILIATION_LOCK_DOC_ID, 'order_reconciliation');
    assert.strictEqual(AUTO_REFUND_CRON_LOCK_DOC_ID, 'auto_refund_cron_lease');
    assert.strictEqual(DEFAULT_CRON_LEASE_TTL_MS, 90_000, 'Default cron lease TTL must be 90s');

    const stalePendingCreatedIso = new Date(Date.now() - 15 * 60_000).toISOString();
    const expiredQueuedPaidIso = new Date(Date.now() - 10 * 60_000).toISOString();
    const expiredQueuedExpIso = new Date(Date.parse(expiredQueuedPaidIso) + 5 * 60_000).toISOString();

    await seedOrdersBatch(firestore, [
      {
        id: 'ORD-H4-SIMUL-PEND-01',
        machine_id: 'CFX-MC-01',
        product_id: 1,
        product_name: 'Classic Crest',
        coffee: 'Classic Crest',
        amount: 100,
        status: 'PENDING',
        dispense_status: 'PENDING',
        dispensed: false,
        refund_status: 'NONE',
        total_refunded_amount_paise: 0,
        pending_refund_amount_paise: 0,
        razorpay_order_id: 'order_h4_simul_pend_01',
        created_at: stalePendingCreatedIso,
        updated_at: stalePendingCreatedIso
      },
      {
        id: 'CFX-H4-SIMUL-REFUND-01',
        machine_id: 'CFX-MC-02',
        product_id: 1,
        product_name: 'Classic Crest',
        coffee: 'Classic Crest',
        amount: 100,
        captured_amount_paise: 10000,
        status: 'PAID',
        dispense_status: 'QUEUED',
        dispensed: false,
        refund_status: 'NONE',
        total_refunded_amount_paise: 0,
        pending_refund_amount_paise: 0,
        razorpay_order_id: 'order_h4_simul_ref_01',
        razorpay_payment_id: 'pay_h4_simul_ref_01',
        created_at: expiredQueuedPaidIso,
        paid_at: expiredQueuedPaidIso,
        expires_at: expiredQueuedExpIso,
        updated_at: expiredQueuedPaidIso
      }
    ]);

    let inFlightReconLock: any = null;
    let inFlightRefundLock: any = null;
    let simulRefundCalls = 0;

    let markReconInFlight!: () => void;
    let markRefundInFlight!: () => void;
    const reconInFlightPromise = new Promise<void>((r) => {
      markReconInFlight = r;
    });
    const refundInFlightPromise = new Promise<void>((r) => {
      markRefundInFlight = r;
    });

    setRazorpayClientForTesting({
      orders: {
        fetch: async () => {
          markReconInFlight();
          await refundInFlightPromise;
          inFlightReconLock = (
            await firestore.collection('system_locks').doc(ORDER_RECONCILIATION_LOCK_DOC_ID).get()
          ).data();
          return {
            id: 'order_h4_simul_pend_01',
            status: 'paid',
            currency: 'INR',
            amount: 10000,
            amount_paid: 10000,
            attempts: 1
          };
        },
        fetchPayments: async () => ({
          items: [
            {
              id: 'pay_h4_simul_pend_01',
              order_id: 'order_h4_simul_pend_01',
              status: 'captured',
              currency: 'INR',
              amount: 10000
            }
          ]
        })
      }
    });

    setRazorpayRefundClientForTesting({
      payments: {
        refund: async (paymentId: string, payload: any) => {
          simulRefundCalls += 1;
          markRefundInFlight();
          await reconInFlightPromise;
          inFlightRefundLock = (
            await firestore.collection('system_locks').doc(AUTO_REFUND_CRON_LOCK_DOC_ID).get()
          ).data();
          await new Promise((r) => setTimeout(r, 30));
          return {
            id: `rfnd_h4_simul_${simulRefundCalls}`,
            payment_id: paymentId,
            amount: Number(payload.amount),
            currency: 'INR',
            status: 'processed',
            receipt: payload.receipt,
            created_at: Math.floor(Date.now() / 1000)
          };
        },
        fetchRefunds: async () => ({ items: [] })
      },
      refunds: { fetch: async () => null }
    });

    // 7a: Pending-order reconciliation and auto-refund sweep run simultaneously without blocking each other
    const [simulReconSummary, simulRefundSummary] = await Promise.all([
      runPendingOrderReconciliation(),
      runAutoRefundSweep({ machineId: 'CFX-MC-02' })
    ]);

    assert.strictEqual(simulReconSummary.skipped_due_to_active_run, undefined);
    assert.strictEqual(simulRefundSummary.skipped_due_to_active_run, undefined);
    assert.strictEqual(simulReconSummary.reconciled_paid, 1);
    assert.strictEqual(simulRefundSummary.expired_queued, 1);
    assert.strictEqual(simulRefundSummary.refunded_processed, 1);
    assert.strictEqual(simulRefundCalls, 1);

    // Verify in-flight lock metadata & 90-second default TTL on BOTH separate lock documents
    assert.ok(inFlightReconLock, 'order_reconciliation lock must be active during pending reconciliation');
    assert.strictEqual(inFlightReconLock.active, true);
    assert.strictEqual(inFlightReconLock.owner, 'pending_order_reconciliation');
    assert.ok(inFlightReconLock.lock_id);
    assert.strictEqual(
      inFlightReconLock.locked_until_ms - Date.parse(inFlightReconLock.acquired_at),
      90_000,
      'order_reconciliation lease TTL must default to 90s'
    );
    assert.strictEqual(
      Date.parse(inFlightReconLock.expires_at),
      inFlightReconLock.locked_until_ms
    );

    assert.ok(inFlightRefundLock, 'auto_refund_cron_lease lock must be active during refund sweep');
    assert.strictEqual(inFlightRefundLock.active, true);
    assert.strictEqual(inFlightRefundLock.owner, 'auto_refund_sweep');
    assert.ok(inFlightRefundLock.lock_id);
    assert.notStrictEqual(inFlightRefundLock.lock_id, inFlightReconLock.lock_id);
    assert.strictEqual(
      inFlightRefundLock.locked_until_ms - Date.parse(inFlightRefundLock.acquired_at),
      90_000,
      'auto_refund_cron_lease TTL must default to 90s'
    );
    assert.strictEqual(
      Date.parse(inFlightRefundLock.expires_at),
      inFlightRefundLock.locked_until_ms
    );

    // Verify post-release diagnostic metadata preservation & post-lease sweep timestamp capture
    const releasedReconLock = (
      await firestore.collection('system_locks').doc(ORDER_RECONCILIATION_LOCK_DOC_ID).get()
    ).data();
    const releasedRefundLock = (
      await firestore.collection('system_locks').doc(AUTO_REFUND_CRON_LOCK_DOC_ID).get()
    ).data();

    assert.strictEqual(releasedReconLock?.active, false);
    assert.strictEqual(releasedReconLock?.lock_id, null);
    assert.strictEqual(releasedReconLock?.owner, null);
    assert.strictEqual(releasedReconLock?.expires_at, null);
    assert.strictEqual(releasedReconLock?.locked_until_ms, 0);
    assert.ok(releasedReconLock?.released_at);
    assert.strictEqual(releasedReconLock?.last_owner, 'pending_order_reconciliation');
    assert.strictEqual(releasedReconLock?.last_lock_id, inFlightReconLock.lock_id);
    assert.strictEqual(releasedReconLock?.last_acquired_at, inFlightReconLock.acquired_at);
    assert.strictEqual(releasedReconLock?.last_expires_at, inFlightReconLock.expires_at);

    assert.strictEqual(releasedRefundLock?.active, false);
    assert.strictEqual(releasedRefundLock?.lock_id, null);
    assert.strictEqual(releasedRefundLock?.owner, null);
    assert.strictEqual(releasedRefundLock?.expires_at, null);
    assert.strictEqual(releasedRefundLock?.locked_until_ms, 0);
    assert.ok(releasedRefundLock?.released_at);
    assert.strictEqual(releasedRefundLock?.last_owner, 'auto_refund_sweep');
    assert.strictEqual(releasedRefundLock?.last_lock_id, inFlightRefundLock.lock_id);
    assert.strictEqual(releasedRefundLock?.last_acquired_at, inFlightRefundLock.acquired_at);
    assert.strictEqual(releasedRefundLock?.last_expires_at, inFlightRefundLock.expires_at);

    const simulRefundedOrder = (
      await firestore.collection('orders').doc('CFX-H4-SIMUL-REFUND-01').get()
    ).data();
    assert.strictEqual(simulRefundedOrder?.refund_status, 'FULL');
    assert.strictEqual(simulRefundedOrder?.dispense_status, 'EXPIRED');
    assert.ok(
      Date.parse(simulRefundedOrder?.expired_at) >= Date.parse(inFlightRefundLock.acquired_at),
      'Sweep evaluation timestamp (expired_at) must be captured AFTER acquiring auto_refund_cron_lease'
    );

    // 7b: Two overlapping auto-refund sweeps still block each other on auto_refund_cron_lease
    await firestore.collection('orders').doc('CFX-H4-OVERLAP-02').set({
      id: 'CFX-H4-OVERLAP-02',
      machine_id: 'CFX-MC-02',
      product_id: 1,
      product_name: 'Classic Crest',
      coffee: 'Classic Crest',
      amount: 100,
      captured_amount_paise: 10000,
      status: 'PAID',
      dispense_status: 'QUEUED',
      dispensed: false,
      refund_status: 'NONE',
      total_refunded_amount_paise: 0,
      pending_refund_amount_paise: 0,
      razorpay_order_id: 'order_h4_overlap_02',
      razorpay_payment_id: 'pay_h4_overlap_02',
      created_at: expiredQueuedPaidIso,
      paid_at: expiredQueuedPaidIso,
      expires_at: expiredQueuedExpIso,
      updated_at: expiredQueuedPaidIso
    });

    let overlapCalls = 0;
    setRazorpayRefundClientForTesting({
      payments: {
        refund: async (paymentId: string, payload: any) => {
          overlapCalls += 1;
          await new Promise((r) => setTimeout(r, 200));
          return {
            id: `rfnd_h4_ov_${overlapCalls}`,
            payment_id: paymentId,
            amount: Number(payload.amount),
            currency: 'INR',
            status: 'processed',
            receipt: payload.receipt,
            created_at: Math.floor(Date.now() / 1000)
          };
        },
        fetchRefunds: async () => ({ items: [] })
      },
      refunds: { fetch: async () => null }
    });

    const [ovSweep1, ovSweep2] = await Promise.all([
      runAutoRefundSweep({ machineId: 'CFX-MC-02' }),
      runAutoRefundSweep({ machineId: 'CFX-MC-02' })
    ]);
    assert.strictEqual(overlapCalls, 1, 'Overlapping auto-refund sweeps must invoke Razorpay once');
    const skippedSweep = ovSweep1.skipped_due_to_active_run ? ovSweep1 : ovSweep2;
    const executedSweep = ovSweep1.skipped_due_to_active_run ? ovSweep2 : ovSweep1;
    assert.strictEqual(skippedSweep.skipped_due_to_active_run, true);
    assert.strictEqual(skippedSweep.scanned, 0);
    assert.strictEqual(executedSweep.skipped_due_to_active_run, undefined);
    assert.strictEqual(executedSweep.refunded_processed, 1);

    // 7c: Lease fencing (stale lock_id cannot release fresh lease) & idempotency re-sweep check
    await firestore.collection('system_locks').doc(AUTO_REFUND_CRON_LOCK_DOC_ID).set({
      active: true,
      lock_id: 'stale-expired-worker-lock-id',
      owner: 'auto_refund_sweep',
      acquired_at: new Date(Date.now() - 120_000).toISOString(),
      expires_at: new Date(Date.now() - 30_000).toISOString(),
      locked_until_ms: Date.now() - 30_000
    });

    const freshLease = await acquireAutoRefundLeaseInFirebase();
    assert.strictEqual(freshLease.acquired, true);
    assert.ok(freshLease.lockId && freshLease.lockId !== 'stale-expired-worker-lock-id');

    // Stale worker finishing late attempts to release its old lockId -> must NOT release freshLease
    await releaseAutoRefundLeaseInFirebase('stale-expired-worker-lock-id');
    const afterStaleRelease = (
      await firestore.collection('system_locks').doc(AUTO_REFUND_CRON_LOCK_DOC_ID).get()
    ).data();
    assert.strictEqual(afterStaleRelease?.active, true, 'Stale lock_id must never release fresh lease');
    assert.strictEqual(afterStaleRelease?.lock_id, freshLease.lockId);

    // Fresh worker releases cleanly -> diagnostic metadata preserved, subsequent idempotent sweep is a no-op
    await releaseAutoRefundLeaseInFirebase(freshLease.lockId);
    const afterFreshRelease = (
      await firestore.collection('system_locks').doc(AUTO_REFUND_CRON_LOCK_DOC_ID).get()
    ).data();
    assert.strictEqual(afterFreshRelease?.active, false);
    assert.strictEqual(afterFreshRelease?.last_lock_id, freshLease.lockId);

    const idempotentResweep = await runAutoRefundSweep({ machineId: 'CFX-MC-02' });
    assert.strictEqual(idempotentResweep.refunded_processed, 0);
    assert.strictEqual(overlapCalls, 1, 'Idempotent re-sweep must never issue duplicate gateway calls');
    setRazorpayClientForTesting(null);
    console.log('   PASS: Separate cron leases, 90s TTL, metadata preservation, post-lease timestamp & fencing verified.');

    // =========================================================================
    // TEST 8: Phase II — 5-Minute DISPENSING Timeout, Explicit command_transmitted,
    //         Late DONE Audit Guard, Inspection Refund Gate & Legacy Values
    // =========================================================================
    console.log('8. Testing Phase II 5-minute DISPENSING timeout, inspection refund gate, late DONE & legacy values...');
    await clearEmulatorDatabase();
    resetFirestoreSeedStateForTesting();
    clearSyncedRefundsStore();
    await db.run("DELETE FROM refunds WHERE order_id LIKE 'CFX-P2-%'").catch(() => {});
    await db.run("DELETE FROM orders WHERE id LIKE 'CFX-P2-%'").catch(() => {});

    const adminToken = jwt.sign(
      {
        id: 'usr_super_admin_p2',
        email: 'superadmin@caffix.test',
        role: 'admin',
        name: 'Super Admin',
        portal: 'admin'
      },
      process.env.JWT_SECRET
    );
    await firestore.collection('machines').doc('CFX-MC-01').set({
      id: 'CFX-MC-01',
      machine_name: 'Caffix Demo 1',
      location: 'Lab A',
      desired_mode: 'RUNNING',
      status: 'online',
      kiosk_token: 'tok_mc01_h4',
      last_seen: new Date().toISOString()
    });
    await firestore.collection('machines').doc('CFX-MC-02').set({
      id: 'CFX-MC-02',
      machine_name: 'Caffix Demo 2',
      location: 'Lab B',
      desired_mode: 'RUNNING',
      status: 'online',
      kiosk_token: 'tok_mc02_h4',
      last_seen: new Date().toISOString()
    });
    await firestore.collection('products').doc('1').set({
      id: 1,
      name: 'Classic Crest',
      price: 100,
      available: true
    });
    const mc1JwtRes = await httpJson(baseUrl, 'GET', '/kiosk/verify?kiosk=tok_mc01_h4&machine_id=CFX-MC-01');
    assert.strictEqual(mc1JwtRes.status, 200);
    const mc1KioskJwt = mc1JwtRes.body.token;

    // 8a: createOrder explicitly initializes command_transmitted = false;
    // enrichAuthoritativeOrderRecord preserves missing/null/invalid legacy values without defaulting to false
    const createdInitRes = await httpJson(baseUrl, 'POST', '/orders/create', {
      token: mc1KioskJwt,
      body: { product_id: 1, amount: 100, machine_id: 'CFX-MC-01', base: 'water' }
    });
    assert.strictEqual(createdInitRes.status, 201);
    assert.strictEqual(createdInitRes.body.data.command_transmitted, false);
    const createdInitSnap = (await firestore.collection('orders').doc(createdInitRes.body.data.id).get()).data();
    assert.strictEqual(createdInitSnap?.command_transmitted, false);

    const legacyEnriched = enrichAuthoritativeOrderRecord({
      id: 'CFX-P2-LEG-ENRICH',
      machine_id: 'CFX-MC-01',
      product_id: 1,
      status: 'PAID',
      dispense_status: 'DISPENSING'
    });
    assert.strictEqual(legacyEnriched.command_transmitted, undefined, 'Legacy missing command_transmitted must NOT default to false');

    // 8b: Scenario 1 & 2 — Normal <5m dispense & 4m-QUEUED + 3m-DISPENSING window
    const t0Ms = Date.now() - 6 * 60_000;
    const t0Iso = new Date(t0Ms).toISOString();
    const lateClaimedStartIso = new Date(t0Ms + 4 * 60_000).toISOString(); // 2m ago (<5m dispensing!)
    const lateClaimedDispExpIso = new Date(t0Ms + 9 * 60_000).toISOString();
    await seedOrdersBatch(firestore, [
      {
        id: 'CFX-P2-NORMAL-DONE',
        machine_id: 'CFX-MC-02',
        product_id: 1,
        amount: 100,
        captured_amount_paise: 10000,
        status: 'COMPLETED',
        dispense_status: 'DISPENSED',
        dispensed: true,
        refund_status: 'NONE',
        total_refunded_amount_paise: 0,
        pending_refund_amount_paise: 0,
        razorpay_order_id: 'ord_p2_norm',
        razorpay_payment_id: 'pay_p2_norm',
        created_at: t0Iso,
        paid_at: t0Iso,
        dispense_started_at: t0Iso,
        dispensed_at: new Date(t0Ms + 90_000).toISOString(),
        command_transmitted: true,
        updated_at: t0Iso
      },
      {
        id: 'CFX-P2-LATE-CLAIMED',
        machine_id: 'CFX-MC-02',
        product_id: 1,
        amount: 100,
        captured_amount_paise: 10000,
        status: 'PAID',
        dispense_status: 'DISPENSING',
        dispensed: false,
        refund_status: 'NONE',
        total_refunded_amount_paise: 0,
        pending_refund_amount_paise: 0,
        razorpay_order_id: 'ord_p2_late_claim',
        razorpay_payment_id: 'pay_p2_late_claim',
        created_at: t0Iso,
        paid_at: t0Iso,
        expires_at: new Date(t0Ms + 5 * 60_000).toISOString(),
        dispense_started_at: lateClaimedStartIso,
        dispense_expires_at: lateClaimedDispExpIso,
        command_transmitted: true,
        updated_at: lateClaimedStartIso
      }
    ]);

    let p2AutoRefundCount = 0;
    setRazorpayRefundClientForTesting({
      payments: {
        refund: async (paymentId: string, payload: any) => {
          p2AutoRefundCount += 1;
          return {
            id: `rfnd_p2_${p2AutoRefundCount}_${paymentId}`,
            payment_id: paymentId,
            amount: Number(payload.amount),
            currency: 'INR',
            status: 'processed',
            receipt: payload.receipt,
            created_at: Math.floor(Date.now() / 1000)
          };
        },
        fetchRefunds: async () => ({ items: [] })
      },
      refunds: { fetch: async () => null }
    });

    // Sweep at t0 + 6m: CFX-P2-LATE-CLAIMED was claimed at t0 + 4m so must NOT expire!
    const sweepAt6m = await runAutoRefundSweep({ machineId: 'CFX-MC-02', nowMs: t0Ms + 6 * 60_000 });
    assert.strictEqual(p2AutoRefundCount, 0);
    assert.strictEqual(sweepAt6m.refunded_processed, 0);
    const lateClaimedSnap = (await firestore.collection('orders').doc('CFX-P2-LATE-CLAIMED').get()).data();
    assert.strictEqual(lateClaimedSnap?.dispense_status, 'DISPENSING', 'QUEUED expiry must never expire active DISPENSING order');

    // Scenario 7a: Completion immediately BEFORE 5m dispensing expiry succeeds
    const mc2JwtRes = await httpJson(baseUrl, 'GET', '/kiosk/verify?kiosk=tok_mc02_h4&machine_id=CFX-MC-02');
    assert.strictEqual(mc2JwtRes.status, 200);
    const mc2KioskJwt = mc2JwtRes.body.token;
    const beforeExpiryDone = await httpJson(baseUrl, 'POST', '/orders/CFX-P2-LATE-CLAIMED/dispense-result', {
      token: mc2KioskJwt,
      body: { dispense_status: 'DISPENSED', machine_id: 'CFX-MC-02' }
    });
    assert.strictEqual(beforeExpiryDone.status, 200);
    assert.strictEqual(beforeExpiryDone.body.data.order.dispense_status, 'DISPENSED');

    // 8c: Scenario 3, 4, 11 — DISPENSING 5m timeouts:
    //   - command_transmitted === false -> EXPIRED + NOT_DISPENSED -> auto-refunded
    //   - command_transmitted === true -> EXPIRED + UNCERTAIN -> 0 auto-refund
    //   - command_transmitted === undefined / null / "false" / 0 / {} -> EXPIRED + UNCERTAIN -> 0 auto-refund
    const dispBaseMs = Date.now() - 10 * 60_000;
    const dispStartIso = new Date(dispBaseMs).toISOString();
    const dispExpIso = new Date(dispBaseMs + 5 * 60_000).toISOString();
    const makeDispTimeoutOrder = (id: string, cmdTx: any, extra: Record<string, any> = {}) => ({
      id,
      machine_id: 'CFX-MC-02',
      product_id: 1,
      amount: 100,
      captured_amount_paise: 10000,
      status: 'PAID',
      dispense_status: 'DISPENSING',
      dispensed: false,
      refund_status: 'NONE',
      total_refunded_amount_paise: 0,
      pending_refund_amount_paise: 0,
      razorpay_order_id: `ord_${id}`,
      razorpay_payment_id: `pay_${id}`,
      created_at: dispStartIso,
      paid_at: dispStartIso,
      expires_at: dispExpIso,
      dispense_started_at: dispStartIso,
      dispense_expires_at: dispExpIso,
      ...(cmdTx !== undefined ? { command_transmitted: cmdTx } : {}),
      updated_at: dispStartIso,
      ...extra
    });

    await seedOrdersBatch(firestore, [
      makeDispTimeoutOrder('CFX-P2-TMO-FALSE', false),
      makeDispTimeoutOrder('CFX-P2-TMO-TRUE', true),
      makeDispTimeoutOrder('CFX-P2-TMO-UNDEF', undefined),
      makeDispTimeoutOrder('CFX-P2-TMO-NULL', null),
      makeDispTimeoutOrder('CFX-P2-TMO-STR', 'false'),
      makeDispTimeoutOrder('CFX-P2-TMO-ZERO', 0),
      makeDispTimeoutOrder('CFX-P2-TMO-OBJ', {})
    ]);

    // At 4m59s: none may expire or refund
    const sweep4m59 = await runAutoRefundSweep({
      machineId: 'CFX-MC-02',
      nowMs: dispBaseMs + 5 * 60_000 - 1000
    });
    assert.strictEqual(p2AutoRefundCount, 0);
    assert.strictEqual(sweep4m59.refunded_processed, 0);

    // At 5m01s: ONLY CFX-P2-TMO-FALSE is auto-refunded; ALL others become EXPIRED + UNCERTAIN with 0 auto-refund
    const sweep5m01 = await runAutoRefundSweep({
      machineId: 'CFX-MC-02',
      nowMs: dispBaseMs + 5 * 60_000 + 1000
    });
    assert.strictEqual(p2AutoRefundCount, 1, 'Strictly command_transmitted === false may auto-refund');
    assert.strictEqual(sweep5m01.refunded_processed, 1);

    const tmoFalseAfter = (await firestore.collection('orders').doc('CFX-P2-TMO-FALSE').get()).data();
    assert.strictEqual(tmoFalseAfter?.dispense_status, 'EXPIRED');
    assert.strictEqual(tmoFalseAfter?.dispense_outcome, 'NOT_DISPENSED');
    assert.strictEqual(tmoFalseAfter?.refund_status, 'FULL');

    for (const uncId of [
      'CFX-P2-TMO-TRUE',
      'CFX-P2-TMO-UNDEF',
      'CFX-P2-TMO-NULL',
      'CFX-P2-TMO-STR',
      'CFX-P2-TMO-ZERO',
      'CFX-P2-TMO-OBJ'
    ]) {
      const snap = (await firestore.collection('orders').doc(uncId).get()).data();
      assert.strictEqual(snap?.dispense_status, 'EXPIRED', `${uncId} must expire permanently`);
      assert.strictEqual(snap?.dispense_outcome, 'UNCERTAIN', `${uncId} must be UNCERTAIN`);
      assert.strictEqual(snap?.refund_status, 'NONE', `${uncId} must NEVER auto-refund`);
    }

    // 8d: Scenario 7b — Late DONE immediately AFTER backend 5m expiry is rejected (409) & records audit
    const lateDoneAfterExpiry = await httpJson(baseUrl, 'POST', '/orders/CFX-P2-TMO-TRUE/dispense-result', {
      token: mc2KioskJwt,
      body: { dispense_status: 'DISPENSED', machine_id: 'CFX-MC-02' }
    });
    assert.strictEqual(lateDoneAfterExpiry.status, 409, 'Late DONE after EXPIRED must return 409 Conflict');
    const tmoTrueAfterLateDone = (await firestore.collection('orders').doc('CFX-P2-TMO-TRUE').get()).data();
    assert.strictEqual(tmoTrueAfterLateDone?.dispense_status, 'EXPIRED');
    assert.strictEqual(tmoTrueAfterLateDone?.dispense_outcome, 'UNCERTAIN');
    assert.ok(tmoTrueAfterLateDone?.late_dispense_reported_at);
    assert.strictEqual(tmoTrueAfterLateDone?.late_dispense_signal, 'ARDUINO_DONE_AFTER_EXPIRY');

    // reconciliationService reflects 5m dispensing timeout and UNCERTAIN_DISPENSE_OUTCOME with late DONE note
    const recUncertain = reconcileOrderRecord(tmoTrueAfterLateDone, { refunds: [] });
    assert.strictEqual(recUncertain.discrepancy_reason, 'UNCERTAIN_DISPENSE_OUTCOME');
    assert.strictEqual(recUncertain.recommended_action, 'INVESTIGATE_HARDWARE_DISPENSE');
    assert.ok(recUncertain.details.includes('Late Arduino DONE was reported'));

    const rec5mDispTimeout = reconcileOrderRecord(
      makeDispTimeoutOrder('CFX-P2-REC-5M', true),
      { refunds: [], options: { now: new Date(dispBaseMs + 6 * 60_000) } }
    );
    assert.strictEqual(rec5mDispTimeout.discrepancy_reason, 'DISPENSING_IN_PROGRESS_TIMEOUT');

    // 8e: Scenario 4 — Super Admin manual refund physical inspection gate & PARTIAL_DISPENSE / HARDWARE_FAULT_CONFIRMED guards
    // Missing confirmation -> 400
    const noInspectRes = await httpJson(baseUrl, 'POST', '/orders/CFX-P2-TMO-TRUE/refund', {
      token: adminToken,
      body: { reason: 'manual_check' }
    });
    assert.strictEqual(noInspectRes.status, 400);

    // PARTIAL_DISPENSE without amount or with full amount -> 400
    const partialDefaultRes = await httpJson(baseUrl, 'POST', '/orders/CFX-P2-TMO-TRUE/refund', {
      token: adminToken,
      body: {
        physical_inspection_confirmed: true,
        inspection_result: 'PARTIAL_DISPENSE',
        inspection_notes: 'Cup half filled'
      }
    });
    assert.strictEqual(partialDefaultRes.status, 400);

    const partialFullAmtRes = await httpJson(baseUrl, 'POST', '/orders/CFX-P2-TMO-TRUE/refund', {
      token: adminToken,
      body: {
        amount_paise: 10000,
        physical_inspection_confirmed: true,
        inspection_result: 'PARTIAL_DISPENSE',
        inspection_notes: 'Cup half filled'
      }
    });
    assert.strictEqual(partialFullAmtRes.status, 400);

    // HARDWARE_FAULT_CONFIRMED without dispensed_quantity_confirmed/notes or with FULL -> 400
    const hwNoQtyRes = await httpJson(baseUrl, 'POST', '/orders/CFX-P2-TMO-UNDEF/refund', {
      token: adminToken,
      body: {
        physical_inspection_confirmed: true,
        inspection_result: 'HARDWARE_FAULT_CONFIRMED'
      }
    });
    assert.strictEqual(hwNoQtyRes.status, 400);

    const hwFullQtyRes = await httpJson(baseUrl, 'POST', '/orders/CFX-P2-TMO-UNDEF/refund', {
      token: adminToken,
      body: {
        physical_inspection_confirmed: true,
        inspection_result: 'HARDWARE_FAULT_CONFIRMED',
        dispensed_quantity_confirmed: 'FULL',
        inspection_notes: 'Pump relay stuck but full drink poured'
      }
    });
    assert.strictEqual(hwFullQtyRes.status, 400);

    // Valid PARTIAL_DISPENSE (5000 < 10000) succeeds & derives admin identity from req.user
    const validPartialRes = await httpJson(baseUrl, 'POST', '/orders/CFX-P2-TMO-TRUE/refund', {
      token: adminToken,
      body: {
        amount_paise: 5000,
        physical_inspection_confirmed: true,
        inspection_result: 'PARTIAL_DISPENSE',
        inspection_notes: 'Half cup poured before power cut',
        inspected_by_admin_id: 'spoofed_client_id',
        inspected_by_admin_email: 'spoofed@evil.com'
      }
    });
    assert.strictEqual(validPartialRes.status, 200);
    const partialRefundDoc = validPartialRes.body.data.refund;
    assert.strictEqual(partialRefundDoc.amount_paise, 5000);
    assert.strictEqual(partialRefundDoc.physical_inspection_confirmed, true);
    assert.strictEqual(partialRefundDoc.inspection_result, 'PARTIAL_DISPENSE');
    assert.strictEqual(partialRefundDoc.inspected_by_admin_id, 'usr_super_admin_p2');
    assert.strictEqual(partialRefundDoc.inspected_by_admin_email, 'superadmin@caffix.test');
    assert.ok(partialRefundDoc.inspected_at);

    // Valid HARDWARE_FAULT_CONFIRMED with NONE + inspection_notes succeeds
    const validHwNoneRes = await httpJson(baseUrl, 'POST', '/orders/CFX-P2-TMO-UNDEF/refund', {
      token: adminToken,
      body: {
        physical_inspection_confirmed: true,
        inspection_result: 'HARDWARE_FAULT_CONFIRMED',
        dispensed_quantity_confirmed: 'NONE',
        inspection_notes: 'Verified empty cup & dry nozzle after pump jam'
      }
    });
    assert.strictEqual(validHwNoneRes.status, 200);
    assert.strictEqual(validHwNoneRes.body.data.refund.amount_paise, 10000);
    assert.strictEqual(validHwNoneRes.body.data.refund.dispensed_quantity_confirmed, 'NONE');

    // 8f: Regression tests for Issue 1 (legacy already-DISPENSING missing command_transmitted vs QUEUED->DISPENSING)
    //     and Issue 2 (already DISPENSED idempotency, late failure, & late DONE after refunded/expired)
    const regCreatedIso = new Date(Date.now() - 8 * 60_000).toISOString();
    const regDispStartedIso = new Date(Date.now() - 6 * 60_000).toISOString();
    await seedOrdersBatch(firestore, [
      {
        id: 'CFX-P2-REG-QUEUED',
        machine_id: 'CFX-MC-02',
        product_id: 1,
        amount: 100,
        captured_amount_paise: 10000,
        status: 'PAID',
        dispense_status: 'QUEUED',
        dispensed: false,
        refund_status: 'NONE',
        total_refunded_amount_paise: 0,
        pending_refund_amount_paise: 0,
        razorpay_order_id: 'order_reg_q',
        razorpay_payment_id: 'pay_reg_q',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      },
      {
        id: 'CFX-P2-REG-LEG-DISP',
        machine_id: 'CFX-MC-02',
        product_id: 1,
        amount: 100,
        captured_amount_paise: 10000,
        status: 'PAID',
        dispense_status: 'DISPENSING',
        dispensed: false,
        dispense_started_at: regDispStartedIso,
        refund_status: 'NONE',
        total_refunded_amount_paise: 0,
        pending_refund_amount_paise: 0,
        razorpay_order_id: 'order_reg_ld',
        razorpay_payment_id: 'pay_reg_ld',
        created_at: regCreatedIso,
        updated_at: regDispStartedIso
      },
      {
        id: 'CFX-P2-REG-LEG-NULL',
        machine_id: 'CFX-MC-02',
        product_id: 1,
        amount: 100,
        captured_amount_paise: 10000,
        status: 'PAID',
        dispense_status: 'DISPENSING',
        dispensed: false,
        command_transmitted: null,
        dispense_started_at: regDispStartedIso,
        refund_status: 'NONE',
        total_refunded_amount_paise: 0,
        pending_refund_amount_paise: 0,
        razorpay_order_id: 'order_reg_ln',
        razorpay_payment_id: 'pay_reg_ln',
        created_at: regCreatedIso,
        updated_at: regDispStartedIso
      },
      {
        id: 'CFX-P2-REG-LEG-INVALID',
        machine_id: 'CFX-MC-02',
        product_id: 1,
        amount: 100,
        captured_amount_paise: 10000,
        status: 'PAID',
        dispense_status: 'DISPENSING',
        dispensed: false,
        command_transmitted: 'false',
        dispense_started_at: regDispStartedIso,
        refund_status: 'NONE',
        total_refunded_amount_paise: 0,
        pending_refund_amount_paise: 0,
        razorpay_order_id: 'order_reg_li',
        razorpay_payment_id: 'pay_reg_li',
        created_at: regCreatedIso,
        updated_at: regDispStartedIso
      },
      {
        id: 'CFX-P2-REG-LEG-TRUE',
        machine_id: 'CFX-MC-02',
        product_id: 1,
        amount: 100,
        captured_amount_paise: 10000,
        status: 'PAID',
        dispense_status: 'DISPENSING',
        dispensed: false,
        command_transmitted: true,
        command_transmitted_at: '2026-11-26T10:00:00.000Z',
        dispense_started_at: regDispStartedIso,
        refund_status: 'NONE',
        total_refunded_amount_paise: 0,
        pending_refund_amount_paise: 0,
        razorpay_order_id: 'order_reg_lt',
        razorpay_payment_id: 'pay_reg_lt',
        created_at: regCreatedIso,
        updated_at: regDispStartedIso
      },
      {
        id: 'CFX-P2-REG-DISPENSED',
        machine_id: 'CFX-MC-02',
        product_id: 1,
        amount: 100,
        captured_amount_paise: 10000,
        status: 'PAID',
        dispense_status: 'DISPENSED',
        dispensed: true,
        dispense_outcome: 'DISPENSED',
        dispensed_by: 'CFX-MC-02',
        dispensed_at: '2026-11-26T10:01:00.000Z',
        refund_status: 'NONE',
        total_refunded_amount_paise: 0,
        pending_refund_amount_paise: 0,
        razorpay_order_id: 'order_reg_done',
        razorpay_payment_id: 'pay_reg_done',
        created_at: regCreatedIso,
        updated_at: '2026-11-26T10:01:00.000Z'
      },
      {
        id: 'CFX-P2-REG-REFUNDED',
        machine_id: 'CFX-MC-02',
        product_id: 1,
        amount: 100,
        captured_amount_paise: 10000,
        status: 'PAID',
        dispense_status: 'DISPENSING',
        dispensed: false,
        refund_status: 'PARTIAL',
        total_refunded_amount_paise: 5000,
        pending_refund_amount_paise: 0,
        razorpay_order_id: 'order_reg_rfnd',
        razorpay_payment_id: 'pay_reg_rfnd',
        created_at: regCreatedIso,
        updated_at: regDispStartedIso
      }
    ]);

    // QUEUED -> DISPENSING initializes explicit false + null
    const regClaimQueued = await httpJson(baseUrl, 'POST', '/orders/CFX-P2-REG-QUEUED/dispense-result', {
      token: mc2KioskJwt,
      body: { dispense_status: 'DISPENSING', machine_id: 'CFX-MC-02' }
    });
    assert.strictEqual(regClaimQueued.status, 200);
    assert.strictEqual(regClaimQueued.body.data.order.command_transmitted, false);
    assert.strictEqual(regClaimQueued.body.data.order.command_transmitted_at, null);

    // Repeated DISPENSING on legacy already-DISPENSING order with missing command_transmitted preserves missing (undefined)
    const regRepeatMissing = await httpJson(baseUrl, 'POST', '/orders/CFX-P2-REG-LEG-DISP/dispense-result', {
      token: mc2KioskJwt,
      body: { dispense_status: 'DISPENSING', machine_id: 'CFX-MC-02' }
    });
    assert.strictEqual(regRepeatMissing.status, 200);
    const legMissingSnap = (await firestore.collection('orders').doc('CFX-P2-REG-LEG-DISP').get()).data();
    assert.strictEqual(legMissingSnap?.command_transmitted, undefined, 'Legacy missing command_transmitted must remain undefined on repeated DISPENSING');

    // Repeated DISPENSING preserves null, invalid ("false"), and true
    await httpJson(baseUrl, 'POST', '/orders/CFX-P2-REG-LEG-NULL/dispense-result', {
      token: mc2KioskJwt,
      body: { dispense_status: 'DISPENSING', machine_id: 'CFX-MC-02' }
    });
    assert.strictEqual((await firestore.collection('orders').doc('CFX-P2-REG-LEG-NULL').get()).data()?.command_transmitted, null);

    await httpJson(baseUrl, 'POST', '/orders/CFX-P2-REG-LEG-INVALID/dispense-result', {
      token: mc2KioskJwt,
      body: { dispense_status: 'DISPENSING', machine_id: 'CFX-MC-02' }
    });
    assert.strictEqual((await firestore.collection('orders').doc('CFX-P2-REG-LEG-INVALID').get()).data()?.command_transmitted, 'false');

    await httpJson(baseUrl, 'POST', '/orders/CFX-P2-REG-LEG-TRUE/dispense-result', {
      token: mc2KioskJwt,
      body: { dispense_status: 'DISPENSING', machine_id: 'CFX-MC-02' }
    });
    const legTrueSnap = (await firestore.collection('orders').doc('CFX-P2-REG-LEG-TRUE').get()).data();
    assert.strictEqual(legTrueSnap?.command_transmitted, true);
    assert.strictEqual(legTrueSnap?.command_transmitted_at, '2026-11-26T10:00:00.000Z');

    // Legacy already-DISPENSING missing order expires as EXPIRED + UNCERTAIN with zero auto-refunds
    const regBeforeRefundCount = refundCallReceipts.length;
    const regSweep = await runAutoRefundSweep(db, { nowMs: Date.now() });
    assert.strictEqual(refundCallReceipts.length, regBeforeRefundCount, 'Legacy missing/null/invalid/true DISPENSING orders must trigger zero auto-refunds');
    const regExpiredMissing = (await firestore.collection('orders').doc('CFX-P2-REG-LEG-DISP').get()).data();
    assert.strictEqual(regExpiredMissing?.dispense_status, 'EXPIRED');
    assert.strictEqual(regExpiredMissing?.dispense_outcome, 'UNCERTAIN');
    assert.ok(regSweep);

    // Duplicate DONE on already DISPENSED order is idempotent (preserves dispensed_at without mutating)
    const dupDoneRes = await httpJson(baseUrl, 'POST', '/orders/CFX-P2-REG-DISPENSED/dispense-result', {
      token: mc2KioskJwt,
      body: { dispense_status: 'DISPENSED', machine_id: 'CFX-MC-02' }
    });
    assert.strictEqual(dupDoneRes.status, 200);
    assert.strictEqual(dupDoneRes.body.data.order.dispense_status, 'DISPENSED');
    assert.strictEqual(dupDoneRes.body.data.order.dispensed_at, '2026-11-26T10:01:00.000Z');

    // Late failure after already DISPENSED returns 409 and preserves DISPENSED
    const lateFailOnDispensed = await httpJson(baseUrl, 'POST', '/orders/CFX-P2-REG-DISPENSED/dispense-result', {
      token: mc2KioskJwt,
      body: { dispense_status: 'FAILED', failure_stage: 'DURING_DISPENSE', machine_id: 'CFX-MC-02' }
    });
    assert.strictEqual(lateFailOnDispensed.status, 409);
    const dispensedAfterFail = (await firestore.collection('orders').doc('CFX-P2-REG-DISPENSED').get()).data();
    assert.strictEqual(dispensedAfterFail?.dispense_status, 'DISPENSED');
    assert.strictEqual(dispensedAfterFail?.dispensed, true);

    // Late DONE after refunded state (PARTIAL) returns 409 and records late_dispense audit signal
    const lateDoneOnRefunded = await httpJson(baseUrl, 'POST', '/orders/CFX-P2-REG-REFUNDED/dispense-result', {
      token: mc2KioskJwt,
      body: { dispense_status: 'DISPENSED', machine_id: 'CFX-MC-02' }
    });
    assert.strictEqual(lateDoneOnRefunded.status, 409);
    const refundedAfterLateDone = (await firestore.collection('orders').doc('CFX-P2-REG-REFUNDED').get()).data();
    assert.strictEqual(refundedAfterLateDone?.dispense_status, 'DISPENSING');
    assert.strictEqual(refundedAfterLateDone?.refund_status, 'PARTIAL');
    assert.strictEqual(refundedAfterLateDone?.late_dispense_signal, 'ARDUINO_DONE_AFTER_EXPIRY');
    assert.ok(refundedAfterLateDone?.late_dispense_reported_at);

    console.log('   PASS: Phase II 5-min DISPENSING timeout, strict command_transmitted, late DONE audit, and inspection refund gate verified.');

    console.log('\nALL PHASE H.4 AUTOMATED REFUND PREPARATION TESTS PASSED SUCCESSFULLY!\n');
  } finally {
    setRazorpayClientForTesting(null);
    setRazorpayRefundClientForTesting(null);
    delete process.env.BLOCK_OFFLINE_MACHINE_ORDERS;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

runTests().catch((err) => {
  console.error('\nPHASE H.4 TEST SUITE FAILED:', err);
  process.exit(1);
});
