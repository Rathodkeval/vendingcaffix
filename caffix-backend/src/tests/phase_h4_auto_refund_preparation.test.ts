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
delete process.env.RAZORPAY_KEY_ID;
delete process.env.RAZORPAY_KEY_SECRET;
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
// eslint-disable-next-line @typescript-eslint/no-var-requires
const {
  DEFAULT_AUTO_REFUND_QUEUED_EXPIRY_MINUTES,
  runAutoRefundSweep
} = require('../services/autoRefundService');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const {
  ensureFirebaseReady,
  getFirestoreInstance,
  resetFirestoreSeedStateForTesting
} = require('../utils/firebase');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { setRazorpayRefundClientForTesting } = require('../utils/razorpayRefundClient');
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
        expires_at: new Date(Date.parse(ts) + 15 * 60_000).toISOString(),
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
        expires_at: new Date(Date.parse(ts) + 15 * 60_000).toISOString(),
        updated_at: ts
      });
    }

    // 25 newer eligible expired QUEUED orders sitting beyond the 220 blocking docs
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
        expires_at: new Date(Date.parse(ts) + 15 * 60_000).toISOString(),
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
    assert.strictEqual(cronRun1.body.data.eligible, 20, 'Starvation fix must discover 20 eligible orders past 220 blocking docs');
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
    console.log('   PASS: 25 eligible orders behind 220 FULL/DISPENSED orders refunded across bounded batches of 20.');

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
      'expires_at must be re-anchored to paid_at + 15 minutes'
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
      expires_at: new Date(Date.parse(oldPaidIso) + 15 * 60_000).toISOString(),
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
      expires_at: new Date(Date.parse(oldPaidIso) + 15 * 60_000).toISOString(),
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

    console.log('\nALL PHASE H.4 AUTOMATED REFUND PREPARATION TESTS PASSED SUCCESSFULLY!\n');
  } finally {
    setRazorpayRefundClientForTesting(null);
    delete process.env.BLOCK_OFFLINE_MACHINE_ORDERS;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

runTests().catch((err) => {
  console.error('\nPHASE H.4 TEST SUITE FAILED:', err);
  process.exit(1);
});
