import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import type http from 'node:http';
import { Firestore } from 'firebase-admin/firestore';

const EMULATOR_HOST = '127.0.0.1:8088';
const EMULATOR_PROJECT_ID = 'demo-caffix-emulator';
const TEST_PORT = 5100;
const TEST_CRON_SECRET = 'phase_h5_dry_run_cron_secret_888';

// Configure isolated Firebase Firestore Emulator environment BEFORE importing backend modules
process.env.FIRESTORE_EMULATOR_HOST = EMULATOR_HOST;
process.env.FIREBASE_PROJECT_ID = EMULATOR_PROJECT_ID;
delete process.env.VERCEL;
delete process.env.VERCEL_ENV;
delete process.env.STRICT_FIREBASE_VALIDATION;
process.env.NODE_ENV = 'test';
process.env.PORT = String(TEST_PORT);
process.env.CRON_SECRET = TEST_CRON_SECRET;
process.env.JWT_SECRET = 'phase_h5_jwt_secret_654321';
process.env.KIOSK_SECRET = 'phase_h5_shared_kiosk_secret';
process.env.ENFORCE_PER_MACHINE_SECRETS = 'true';
delete process.env.RAZORPAY_KEY_ID;
delete process.env.RAZORPAY_KEY_SECRET;
process.env.RAZORPAY_WEBHOOK_SECRET = 'h5_wh_secret_123';
delete process.env.BLOCK_OFFLINE_MACHINE_ORDERS;
delete process.env.AUTO_REFUND_QUEUED_EXPIRY_MINUTES;

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { initDB, getDB } = require('../config/db');
process.env.VERCEL = '1';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const app = require('../index').default;
delete process.env.VERCEL;
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

async function snapshotFirestoreState(firestore: Firestore): Promise<string> {
  const collections = ['orders', 'refunds', 'system_locks'];
  const result: Record<string, Record<string, any>> = {};
  for (const col of collections) {
    const snap = await firestore.collection(col).get();
    const docs: Record<string, any> = {};
    const sortedDocs = [...snap.docs].sort((a, b) => a.id.localeCompare(b.id));
    for (const doc of sortedDocs) {
      docs[doc.id] = doc.data();
      if (col === 'orders') {
        const subSnap = await doc.ref.collection('refunds').get();
        if (!subSnap.empty) {
          docs[doc.id].__sub_refunds = [...subSnap.docs]
            .sort((a, b) => a.id.localeCompare(b.id))
            .map((d) => ({ id: d.id, data: d.data() }));
        }
      }
    }
    result[col] = docs;
  }
  return JSON.stringify(result);
}

async function callCron(
  baseUrl: string,
  method: 'GET' | 'POST',
  query: string,
  authHeader?: string
): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = {};
  if (authHeader !== undefined) {
    headers.Authorization = authHeader;
  }
  const res = await fetch(`${baseUrl}/api/cron/auto-refund${query}`, {
    method,
    headers
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

async function runTests(): Promise<void> {
  console.log('\n==============================================================');
  console.log('CAFFIX Phase H.5 Auto-Refund Cron Dry-Run Mode Emulator Tests');
  console.log('==============================================================\n');

  await clearEmulatorDatabase();
  resetFirestoreSeedStateForTesting();
  clearSyncedRefundsStore();

  await initDB();
  const db = getDB();
  ensureFirebaseReady();
  const firestore = getFirestoreInstance();
  assert.ok(firestore, 'Firestore Emulator instance must be active');

  await firestore.collection('machines').doc('CFX-MC-01').set({
    id: 'CFX-MC-01',
    machine_name: 'Caffix Demo 1',
    desired_mode: 'RUNNING',
    status: 'online',
    kiosk_token: 'tok_mc01_h5',
    last_seen: new Date().toISOString()
  });
  await firestore.collection('machines').doc('CFX-MC-02').set({
    id: 'CFX-MC-02',
    machine_name: 'Caffix Demo 2',
    desired_mode: 'RUNNING',
    status: 'online',
    kiosk_token: 'tok_mc02_h5',
    last_seen: new Date().toISOString()
  });
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
    // =========================================================================
    // TEST 1: Authentication enforcement on dry_run=true
    // =========================================================================
    console.log('1. Testing CRON_SECRET authentication on dry-run endpoint (401 when missing/invalid)...');
    const missingAuth = await callCron(baseUrl, 'GET', '?dry_run=true');
    assert.strictEqual(missingAuth.status, 401, 'Missing Authorization must return 401');

    const invalidAuthGet = await callCron(baseUrl, 'GET', '?dry_run=true', 'Bearer wrong_secret');
    assert.strictEqual(invalidAuthGet.status, 401, 'Invalid secret on GET must return 401');

    const invalidAuthPost = await callCron(baseUrl, 'POST', '?dry_run=true', 'Bearer wrong_secret');
    assert.strictEqual(invalidAuthPost.status, 401, 'Invalid secret on POST must return 401');
    console.log('   PASS: Missing/invalid cron auth returned 401 on GET and POST.');

    // =========================================================================
    // TEST 2: Eligible, Ineligible, Pending Reconciliation & Zero-Mutation Proofs
    // =========================================================================
    console.log('2. Testing eligible, ineligible, pending reconciliation, zero Razorpay calls, & zero Firestore mutations...');
    let razorpayCallsDuringDryRun = 0;
    setRazorpayRefundClientForTesting({
      payments: {
        refund: async () => {
          razorpayCallsDuringDryRun += 1;
          throw new Error('CRITICAL VIOLATION: payments.refund called during dry_run=true');
        },
        fetchRefunds: async () => {
          razorpayCallsDuringDryRun += 1;
          throw new Error('CRITICAL VIOLATION: payments.fetchRefunds called during dry_run=true');
        }
      },
      refunds: {
        fetch: async () => {
          razorpayCallsDuringDryRun += 1;
          throw new Error('CRITICAL VIOLATION: refunds.fetch called during dry_run=true');
        }
      }
    });

    const oldPaidIso = new Date(Date.now() - 30 * 60_000).toISOString();
    const oldExpIso = new Date(Date.now() - 15 * 60_000).toISOString();
    const freshPaidIso = new Date(Date.now() - 2 * 60_000).toISOString();
    const freshExpIso = new Date(Date.now() + 13 * 60_000).toISOString();

    await seedOrdersBatch(firestore, [
      {
        id: 'CFX-DRY-ELIG-QUEUED',
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
        razorpay_order_id: 'order_dry_1',
        razorpay_payment_id: 'pay_dry_1',
        created_at: oldPaidIso,
        paid_at: oldPaidIso,
        expires_at: oldExpIso,
        updated_at: oldPaidIso
      },
      {
        id: 'CFX-DRY-ELIG-PREFAIL',
        machine_id: 'CFX-MC-01',
        product_id: 1,
        product_name: 'Classic Crest',
        coffee: 'Classic Crest',
        amount: 50,
        captured_amount_paise: 5000,
        status: 'PAID',
        dispense_status: 'FAILED',
        dispense_outcome: 'NOT_DISPENSED',
        failure_stage: 'PRE_DISPENSE',
        dispensed: false,
        refund_status: 'NONE',
        total_refunded_amount_paise: 0,
        pending_refund_amount_paise: 0,
        razorpay_order_id: 'order_dry_2',
        razorpay_payment_id: 'pay_dry_2',
        created_at: freshPaidIso,
        paid_at: freshPaidIso,
        expires_at: freshExpIso,
        updated_at: freshPaidIso
      },
      {
        id: 'CFX-DRY-INELIG-FRESH',
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
        razorpay_order_id: 'order_dry_3',
        razorpay_payment_id: 'pay_dry_3',
        created_at: freshPaidIso,
        paid_at: freshPaidIso,
        expires_at: freshExpIso,
        updated_at: freshPaidIso
      },
      {
        id: 'CFX-DRY-INELIG-DISPENSED',
        machine_id: 'CFX-MC-01',
        product_id: 1,
        amount: 100,
        captured_amount_paise: 10000,
        status: 'PAID',
        dispense_status: 'DISPENSED',
        dispensed: true,
        refund_status: 'NONE',
        total_refunded_amount_paise: 0,
        pending_refund_amount_paise: 0,
        razorpay_order_id: 'order_dry_4',
        razorpay_payment_id: 'pay_dry_4',
        created_at: oldPaidIso,
        paid_at: oldPaidIso,
        updated_at: oldPaidIso
      },
      {
        id: 'CFX-DRY-INELIG-UNCERTAIN',
        machine_id: 'CFX-MC-01',
        product_id: 1,
        amount: 100,
        captured_amount_paise: 10000,
        status: 'PAID',
        dispense_status: 'FAILED',
        dispense_outcome: 'UNCERTAIN',
        dispensed: false,
        refund_status: 'NONE',
        total_refunded_amount_paise: 0,
        pending_refund_amount_paise: 0,
        razorpay_order_id: 'order_dry_5',
        razorpay_payment_id: 'pay_dry_5',
        created_at: oldPaidIso,
        paid_at: oldPaidIso,
        updated_at: oldPaidIso
      },
      {
        id: 'CFX-DRY-INELIG-DISPENSING',
        machine_id: 'CFX-MC-01',
        product_id: 1,
        amount: 100,
        captured_amount_paise: 10000,
        status: 'PAID',
        dispense_status: 'DISPENSING',
        dispensed: false,
        refund_status: 'NONE',
        total_refunded_amount_paise: 0,
        pending_refund_amount_paise: 0,
        razorpay_order_id: 'order_dry_6',
        razorpay_payment_id: 'pay_dry_6',
        created_at: oldPaidIso,
        paid_at: oldPaidIso,
        updated_at: oldPaidIso
      },
      {
        id: 'CFX-DRY-EXCL-FULL',
        machine_id: 'CFX-MC-02',
        product_id: 1,
        amount: 100,
        captured_amount_paise: 10000,
        status: 'PAID',
        dispense_status: 'QUEUED',
        refund_status: 'FULL',
        total_refunded_amount_paise: 10000,
        pending_refund_amount_paise: 0,
        razorpay_order_id: 'order_dry_7',
        razorpay_payment_id: 'pay_dry_7',
        created_at: oldPaidIso,
        paid_at: oldPaidIso,
        updated_at: oldPaidIso
      },
      {
        id: 'CFX-DRY-PEND-COMP',
        machine_id: 'CFX-MC-01',
        product_id: 1,
        amount: 100,
        captured_amount_paise: 10000,
        status: 'COMPLETED',
        dispense_status: 'DISPENSED',
        dispensed: true,
        refund_status: 'PENDING',
        total_refunded_amount_paise: 0,
        pending_refund_amount_paise: 10000,
        razorpay_order_id: 'order_dry_8',
        razorpay_payment_id: 'pay_dry_8',
        created_at: oldPaidIso,
        paid_at: oldPaidIso,
        updated_at: oldPaidIso
      },
      {
        id: 'CFX-DRY-PEND-PARTIAL',
        machine_id: 'CFX-MC-02',
        product_id: 1,
        amount: 100,
        captured_amount_paise: 10000,
        status: 'PAID',
        dispense_status: 'FAILED',
        refund_status: 'PARTIAL',
        total_refunded_amount_paise: 4000,
        pending_refund_amount_paise: 6000,
        razorpay_order_id: 'order_dry_9',
        razorpay_payment_id: 'pay_dry_9',
        created_at: oldPaidIso,
        paid_at: oldPaidIso,
        updated_at: oldPaidIso
      }
    ]);

    const pendingRefDoc = {
      id: 'RFND-DRY-PEND-COMP',
      order_id: 'CFX-DRY-PEND-COMP',
      machine_id: 'CFX-MC-01',
      razorpay_payment_id: 'pay_dry_8',
      razorpay_refund_id: 'rfnd_dry_pend_8',
      amount_paise: 10000,
      currency: 'INR',
      status: 'PENDING',
      reason: 'manual_test',
      idempotency_key: 'idem_dry_pend_8',
      created_at: oldPaidIso,
      updated_at: oldPaidIso
    };
    await firestore.collection('refunds').doc(pendingRefDoc.id).set(pendingRefDoc);
    await firestore
      .collection('orders')
      .doc('CFX-DRY-PEND-COMP')
      .collection('refunds')
      .doc(pendingRefDoc.id)
      .set(pendingRefDoc);

    // Pre-existing active cron lease lock must NOT be modified or block dry_run=true
    await firestore.collection('system_locks').doc('reconciliation_cron_lease').set({
      holder: 'other-worker',
      expires_at: new Date(Date.now() + 60_000).toISOString()
    });

    const snapshotBefore = await snapshotFirestoreState(firestore);
    const sqliteRefundCountBefore = (await db.get('SELECT COUNT(*) as cnt FROM refunds')).cnt;

    const dryRunRes = await callCron(
      baseUrl,
      'GET',
      '?dry_run=true',
      `Bearer ${TEST_CRON_SECRET}`
    );
    assert.strictEqual(dryRunRes.status, 200);
    const data = dryRunRes.body.data;

    assert.strictEqual(data.dry_run, true);
    assert.strictEqual(razorpayCallsDuringDryRun, 0, 'Razorpay SDK must NEVER be called during dry-run');
    assert.strictEqual(data.refunded_processed, 0);
    assert.strictEqual(data.refund_pending, 0);
    assert.strictEqual(data.refund_failed, 0);
    assert.strictEqual(data.replayed, 0);
    assert.strictEqual(data.eligible, 2, 'Expected 2 eligible orders (STALE_QUEUED + PRE_DISPENSE)');
    assert.strictEqual(data.expired_queued, 1, 'Expected 1 QUEUED order that would transition to EXPIRED');
    assert.strictEqual(data.pending_reconciliation_count, 2, 'Expected 2 pending reconciliation candidates');
    assert.strictEqual(data.skipped_dispensed, 1);
    assert.strictEqual(data.skipped_uncertain, 1);
    assert.strictEqual(data.skipped_dispensing, 1);
    assert.strictEqual(data.skipped_not_expired, 1);
    assert.strictEqual(data.skipped_already_refunded, 1);

    const byId = new Map<string, any>(data.orders.map((o: any) => [o.order_id, o]));
    assert.strictEqual(byId.has('CFX-DRY-EXCL-FULL'), false, 'FULL-refunded order must be excluded by Firestore query');
    assert.strictEqual(byId.get('CFX-DRY-ELIG-QUEUED')?.eligible, true);
    assert.strictEqual(byId.get('CFX-DRY-ELIG-QUEUED')?.eligibility_reason, 'STALE_QUEUED_EXPIRED');
    assert.strictEqual(byId.get('CFX-DRY-ELIG-QUEUED')?.refund_amount_paise, 10000);
    assert.strictEqual(byId.get('CFX-DRY-ELIG-QUEUED')?.dispense_status, 'QUEUED');
    assert.strictEqual(byId.get('CFX-DRY-ELIG-QUEUED')?.would_expire_to_expired, true);

    assert.strictEqual(byId.get('CFX-DRY-ELIG-PREFAIL')?.eligible, true);
    assert.strictEqual(byId.get('CFX-DRY-ELIG-PREFAIL')?.eligibility_reason, 'CONFIRMED_PRE_DISPENSE_FAILURE');
    assert.strictEqual(byId.get('CFX-DRY-ELIG-PREFAIL')?.refund_amount_paise, 5000);

    assert.strictEqual(byId.get('CFX-DRY-INELIG-FRESH')?.skip_reason, 'NOT_EXPIRED_YET');
    assert.strictEqual(byId.get('CFX-DRY-INELIG-DISPENSED')?.skip_reason, 'ALREADY_DISPENSED');
    assert.strictEqual(byId.get('CFX-DRY-INELIG-UNCERTAIN')?.skip_reason, 'UNCERTAIN_DISPENSE_OUTCOME');
    assert.strictEqual(byId.get('CFX-DRY-INELIG-DISPENSING')?.skip_reason, 'UNCERTAIN_DISPENSE_IN_PROGRESS');

    const pendById = new Map<string, any>(
      data.pending_reconciliation_candidates.map((p: any) => [p.order_id, p])
    );
    assert.strictEqual(pendById.get('CFX-DRY-PEND-COMP')?.pending_refund_amount_paise, 10000);
    assert.strictEqual(pendById.get('CFX-DRY-PEND-COMP')?.status, 'COMPLETED');
    assert.strictEqual(pendById.get('CFX-DRY-PEND-PARTIAL')?.pending_refund_amount_paise, 6000);

    // Proof of ZERO mutations in Firestore and SQLite
    const snapshotAfter = await snapshotFirestoreState(firestore);
    assert.strictEqual(snapshotAfter, snapshotBefore, 'Firestore must be byte-for-byte identical after dry-run');
    const sqliteRefundCountAfter = (await db.get('SELECT COUNT(*) as cnt FROM refunds')).cnt;
    assert.strictEqual(sqliteRefundCountAfter, sqliteRefundCountBefore, 'SQLite refunds table must not change');

    const queuedSnap = (await firestore.collection('orders').doc('CFX-DRY-ELIG-QUEUED').get()).data();
    assert.strictEqual(queuedSnap?.dispense_status, 'QUEUED', 'QUEUED order must NOT become EXPIRED during dry-run');
    assert.strictEqual(queuedSnap?.refund_status, 'NONE');
    console.log('   PASS: Dry-run reported eligible, ineligible & pending candidates with ZERO Firestore/SQLite/Razorpay mutations.');

    // =========================================================================
    // TEST 3: 20-order batch limit enforcement during dry_run=true
    // =========================================================================
    console.log('3. Testing 20-order batch limit during dry_run=true...');
    await clearEmulatorDatabase();
    resetFirestoreSeedStateForTesting();
    clearSyncedRefundsStore();

    const batchOrders: Record<string, any>[] = [];
    const baseMs = Date.now() - 2 * 60 * 60_000;
    for (let i = 0; i < 25; i++) {
      const ts = new Date(baseMs + i * 1000).toISOString();
      batchOrders.push({
        id: `CFX-DRY-LIM-${String(i).padStart(3, '0')}`,
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
        razorpay_order_id: `order_dry_lim_${i}`,
        razorpay_payment_id: `pay_dry_lim_${i}`,
        created_at: ts,
        paid_at: ts,
        expires_at: new Date(Date.parse(ts) + 15 * 60_000).toISOString(),
        updated_at: ts
      });
    }
    await seedOrdersBatch(firestore, batchOrders);

    const limitSnapBefore = await snapshotFirestoreState(firestore);
    const limitDryRes = await callCron(
      baseUrl,
      'POST',
      '?dry_run=true&limit=99',
      `Bearer ${TEST_CRON_SECRET}`
    );
    assert.strictEqual(limitDryRes.status, 200);
    assert.strictEqual(limitDryRes.body.data.dry_run, true);
    assert.strictEqual(limitDryRes.body.data.limit, 20);
    assert.strictEqual(limitDryRes.body.data.orders.length, 20, 'Dry-run must enforce 20-order cap');
    assert.strictEqual(limitDryRes.body.data.eligible, 20);
    assert.strictEqual(razorpayCallsDuringDryRun, 0);
    assert.strictEqual(await snapshotFirestoreState(firestore), limitSnapBefore);
    const lockDoc = await firestore.collection('system_locks').doc('reconciliation_cron_lease').get();
    assert.strictEqual(lockDoc.exists, false, 'Dry-run must never create reconciliation_cron_lease');
    console.log('   PASS: Dry-run enforced 20-order cap and left system_locks untouched.');

    // =========================================================================
    // TEST 4: Non-true dry_run (dry_run=false / omitted) preserves live behavior
    // =========================================================================
    console.log('4. Testing live cron behavior preserved when dry_run is not explicitly true...');
    await clearEmulatorDatabase();
    resetFirestoreSeedStateForTesting();
    clearSyncedRefundsStore();

    await seedOrdersBatch(firestore, [
      {
        id: 'CFX-LIVE-CHECK-01',
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
        razorpay_order_id: 'order_live_chk_01',
        razorpay_payment_id: 'pay_live_chk_01',
        created_at: oldPaidIso,
        paid_at: oldPaidIso,
        expires_at: oldExpIso,
        updated_at: oldPaidIso
      }
    ]);

    let liveRefundCalls = 0;
    setRazorpayRefundClientForTesting({
      payments: {
        refund: async (paymentId: string, payload: any) => {
          liveRefundCalls += 1;
          return {
            id: `rfnd_live_${crypto.randomBytes(4).toString('hex')}`,
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

    const liveRes = await callCron(
      baseUrl,
      'POST',
      '?dry_run=false',
      `Bearer ${TEST_CRON_SECRET}`
    );
    assert.strictEqual(liveRes.status, 200);
    assert.strictEqual(liveRes.body.data.dry_run, undefined);
    assert.strictEqual(liveRes.body.data.refunded_processed, 1);
    assert.strictEqual(liveRes.body.data.expired_queued, 1);
    assert.strictEqual(liveRefundCalls, 1);
    const liveAfter = (await firestore.collection('orders').doc('CFX-LIVE-CHECK-01').get()).data();
    assert.strictEqual(liveAfter?.dispense_status, 'EXPIRED');
    assert.strictEqual(liveAfter?.refund_status, 'FULL');
    console.log('   PASS: dry_run=false preserved live refund execution and state transition.');

    console.log('\nALL PHASE H.5 AUTO-REFUND DRY-RUN EMULATOR TESTS PASSED SUCCESSFULLY!\n');
  } finally {
    setRazorpayRefundClientForTesting(null);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

runTests().catch((err) => {
  console.error('\nPHASE H.5 DRY-RUN TEST SUITE FAILED:', err);
  process.exit(1);
});
