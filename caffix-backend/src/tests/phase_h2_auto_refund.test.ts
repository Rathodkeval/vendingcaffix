import assert from 'assert';
import crypto from 'crypto';
import http from 'http';
import jwt from 'jsonwebtoken';
import { initializeApp, getApps, deleteApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

const EMULATOR_HOST = '127.0.0.1:8088';
const EMULATOR_PROJECT_ID = 'demo-caffix-emulator';

process.env.FIRESTORE_EMULATOR_HOST = EMULATOR_HOST;
process.env.FIREBASE_PROJECT_ID = EMULATOR_PROJECT_ID;
delete process.env.VERCEL;
delete process.env.VERCEL_ENV;
delete process.env.STRICT_FIREBASE_VALIDATION;
process.env.JWT_SECRET = 'phase-h2-auto-refund-jwt-secret-2026';
process.env.KIOSK_SECRET = 'phase-h2-shared-kiosk-secret-2026';
process.env.CRON_SECRET = 'phase-h2-cron-secret-key-2026-prod-safe';
process.env.ENFORCE_PER_MACHINE_SECRETS = 'true';

// 1. Load db.ts with VERCEL unset so sqlite3 loads natively
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { initDB, getDB } = require('../config/db');
// 2. Temporarily set VERCEL=1 while loading index.ts so it does not auto-listen on port 5000
process.env.VERCEL = '1';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const app = require('../index').default;
delete process.env.VERCEL;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const {
  resetFirestoreSeedStateForTesting,
  setFirestoreForTesting,
  getAuthoritativeOrderById
} = require('../utils/firebase');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const {
  clearSyncedRefundsStore,
  getRefundsByOrderId
} = require('../utils/refunds');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { setRazorpayRefundClientForTesting } = require('../utils/razorpayRefundClient');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const {
  DEFAULT_AUTO_REFUND_QUEUED_EXPIRY_MINUTES,
  buildAutoRefundIdempotencyKey,
  processAutoRefundForOrder,
  resolveAutoRefundQueuedExpiryMs,
  runAutoRefundSweep
} = require('../services/autoRefundService');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { getJwtSecret } = require('../utils/security');

const PORT = 5097;
const BASE_URL = `http://127.0.0.1:${PORT}/api`;

async function clearEmulatorDatabase() {
  const url = `http://${EMULATOR_HOST}/emulator/v1/projects/${EMULATOR_PROJECT_ID}/databases/(default)/documents`;
  const res = await fetch(url, { method: 'DELETE' });
  if (!res.ok) {
    throw new Error(`Failed to clear emulator database: HTTP ${res.status}`);
  }
}

async function api(method: string, path: string, token?: string, body?: unknown, extraHeaders: Record<string, string> = {}) {
  const headers: Record<string, string> = { ...extraHeaders };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined
  });
  const payload = await res.json().catch(() => ({}));
  return { status: res.status, body: payload };
}

async function seedEmulatorMachine(firestore: FirebaseFirestore.Firestore, id: string, opts: {
  name: string;
  ownerId: string | null;
  kioskToken: string;
  lastSeen: string | null;
}) {
  await firestore.collection('machines').doc(id).set({
    id,
    machine_name: opts.name,
    location: 'Test Location',
    desired_mode: 'RUNNING',
    status: 'online',
    last_seen: opts.lastSeen,
    owner_id: opts.ownerId,
    kiosk_token: opts.kioskToken,
    estimated_inventory: {
      water_level: 95,
      coffee_level: 95,
      milk_level: 95,
      vanilla_level: 95,
      hazelnut_level: 95,
      irish_level: 95,
      mocha_level: 95
    },
    products: {
      '1': { price: 100, is_available: true }
    },
    updated_at: new Date().toISOString()
  });
}

async function seedPaidOrder(firestore: FirebaseFirestore.Firestore, order: Record<string, any>) {
  await firestore.collection('orders').doc(order.id).set(order);
}

async function runTests() {
  console.log('\n======================================================================');
  console.log('Running CAFFIX Phase H.2 — Safe Automatic Refund Engine Tests');
  console.log('======================================================================\n');

  for (const a of getApps()) await deleteApp(a);
  const fbApp = initializeApp({ projectId: EMULATOR_PROJECT_ID });
  const firestore = getFirestore(fbApp);
  setFirestoreForTesting({ firestoreInstance: firestore, clearStores: true });
  resetFirestoreSeedStateForTesting();
  clearSyncedRefundsStore();
  await clearEmulatorDatabase();

  await initDB();
  const db = getDB();
  await db.run("DELETE FROM refunds WHERE order_id LIKE 'CFX-H2-%'").catch(() => {});
  await db.run("DELETE FROM orders WHERE id LIKE 'CFX-H2-%'").catch(() => {});

  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const staleCreatedIso = new Date(nowMs - 20 * 60_000).toISOString(); // 20 mins ago (>15m default)
  const freshCreatedIso = new Date(nowMs - 2 * 60_000).toISOString();  // 2 mins ago (<15m default)
  const staleHeartbeatIso = new Date(nowMs - 180_000).toISOString();  // 3 mins ago (OFFLINE)

  await seedEmulatorMachine(firestore, 'CFX-MC-01', {
    name: 'ONE',
    ownerId: 'usr_owner_1',
    kioskToken: 'tok_mc01_h2',
    lastSeen: staleHeartbeatIso
  });
  await db.run('UPDATE machines SET last_seen = ?, desired_mode = ?, status = ? WHERE id = ?', [
    staleHeartbeatIso,
    'RUNNING',
    'online',
    'CFX-MC-01'
  ]);
  await seedEmulatorMachine(firestore, 'CFX-MC-02', {
    name: 'TWO',
    ownerId: 'usr_owner_2',
    kioskToken: 'tok_mc02_h2',
    lastSeen: nowIso
  });
  await db.run('UPDATE machines SET last_seen = ?, desired_mode = ?, status = ? WHERE id = ?', [
    nowIso,
    'RUNNING',
    'online',
    'CFX-MC-02'
  ]);
  await seedEmulatorMachine(firestore, 'CFX-MC-03', {
    name: 'THREE',
    ownerId: null,
    kioskToken: 'tok_mc03_h2',
    lastSeen: null
  });
  await db.run('UPDATE machines SET last_seen = NULL, desired_mode = ?, status = ? WHERE id = ?', [
    'RUNNING',
    'online',
    'CFX-MC-03'
  ]);

  // Seed mock Razorpay refund counter tracker
  let gatewayRefundCalls: Array<{ paymentId: string; payload: any }> = [];
  let gatewayBehavior: 'processed' | 'pending' | 'timeout' | 'reject' = 'processed';

  setRazorpayRefundClientForTesting({
    payments: {
      refund: async (paymentId: string, payload: any) => {
        gatewayRefundCalls.push({ paymentId, payload });
        if (gatewayBehavior === 'timeout') {
          const err: any = new Error('connect ETIMEDOUT razorpay api');
          err.code = 'ETIMEDOUT';
          throw err;
        }
        if (gatewayBehavior === 'reject') {
          const err: any = new Error('The payment has already been fully refunded');
          err.error = { code: 'BAD_REQUEST_ERROR', description: 'Payment already refunded or rejected' };
          throw err;
        }
        return {
          id: `rfnd_h2_${crypto.randomBytes(4).toString('hex')}`,
          payment_id: paymentId,
          amount: payload.amount,
          currency: 'INR',
          status: gatewayBehavior === 'pending' ? 'pending' : 'processed',
          receipt: payload.receipt,
          created_at: Math.floor(Date.now() / 1000)
        };
      }
    }
  });

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(PORT, '127.0.0.1', () => resolve()));

  try {
    const adminToken = jwt.sign(
      { id: 'usr_admin_1', email: 'admin@test.local', role: 'admin', portal: 'admin' },
      getJwtSecret(),
      { expiresIn: '1h' }
    );
    const owner1Token = jwt.sign(
      { id: 'usr_owner_1', email: 'owner1@test.local', role: 'owner', portal: 'owner' },
      getJwtSecret(),
      { expiresIn: '1h' }
    );
    const mc1Verify = await api('GET', '/kiosk/verify?kiosk=tok_mc01_h2&machine_id=CFX-MC-01');
    assert.strictEqual(mc1Verify.status, 200);
    const mc1Jwt = mc1Verify.body.token;
    const mc2Verify = await api('GET', '/kiosk/verify?kiosk=tok_mc02_h2&machine_id=CFX-MC-02');
    assert.strictEqual(mc2Verify.status, 200);
    const mc2Jwt = mc2Verify.body.token;

    // 1. Offline Machine Guard & Configurable Order-Expiry Policy
    console.log('1. Testing offline machine order guard & configurable expiry policy...');
    delete process.env.AUTO_REFUND_QUEUED_EXPIRY_MINUTES;
    assert.strictEqual(resolveAutoRefundQueuedExpiryMs(), DEFAULT_AUTO_REFUND_QUEUED_EXPIRY_MINUTES * 60_000);
    process.env.AUTO_REFUND_QUEUED_EXPIRY_MINUTES = '5';
    assert.strictEqual(resolveAutoRefundQueuedExpiryMs(), 5 * 60_000);
    delete process.env.AUTO_REFUND_QUEUED_EXPIRY_MINUTES;

    process.env.BLOCK_OFFLINE_MACHINE_ORDERS = 'true';
    const offlineCreate = await api(
      'POST',
      '/orders/create',
      mc1Jwt,
      { product_id: 1, amount: 100, machine_id: 'CFX-MC-01', base: 'water' }
    );
    assert.strictEqual(offlineCreate.status, 503, 'Offline machine must reject order creation when guard is enabled');

    const hbRes = await api('POST', '/machines/CFX-MC-01/heartbeat', mc1Jwt);
    assert.strictEqual(hbRes.status, 200);
    const onlineCreate = await api(
      'POST',
      '/orders/create',
      mc1Jwt,
      { product_id: 1, amount: 100, machine_id: 'CFX-MC-01', base: 'water' }
    );
    assert.strictEqual(onlineCreate.status, 201);
    assert.ok(onlineCreate.body.data.expires_at, 'Created order must carry computed expires_at TTL');
    delete process.env.BLOCK_OFFLINE_MACHINE_ORDERS;
    console.log('   PASS: Offline guard (503 -> 201 after heartbeat) & expiry config verified.');

    // 2. Confirmed Pre-Dispense Failure -> Immediate Safe Auto-Refund + Duplicate Protection
    console.log('2. Testing confirmed pre-dispense failure & idempotent auto-refund...');
    await seedPaidOrder(firestore, {
      id: 'CFX-H2-PREFAIL',
      machine_id: 'CFX-MC-01',
      product_id: 1,
      product_name: 'Classic Crest',
      amount: 100,
      captured_amount_paise: 10000,
      status: 'PAID',
      dispense_status: 'QUEUED',
      dispensed: false,
      refund_status: 'NONE',
      total_refunded_amount_paise: 0,
      pending_refund_amount_paise: 0,
      razorpay_order_id: 'order_h2_prefail',
      razorpay_payment_id: 'pay_h2_prefail',
      created_at: freshCreatedIso,
      updated_at: freshCreatedIso
    });

    const preFailRes = await api(
      'POST',
      '/orders/CFX-H2-PREFAIL/dispense-result',
      mc1Jwt,
      { dispense_status: 'FAILED', failure_stage: 'PRE_DISPENSE', failure_reason: 'ARDUINO_NOT_CONNECTED' }
    );
    assert.strictEqual(preFailRes.status, 200);
    assert.strictEqual(preFailRes.body.data.autoRefund?.status, 'refunded');
    assert.strictEqual(preFailRes.body.data.order.dispense_status, 'FAILED');
    assert.strictEqual(preFailRes.body.data.order.dispense_outcome, 'NOT_DISPENSED');
    assert.strictEqual(preFailRes.body.data.order.refund_status, 'FULL');
    assert.strictEqual(preFailRes.body.data.order.total_refunded_amount_paise, 10000);
    assert.strictEqual(gatewayRefundCalls.length, 1);

    // Duplicate retry must replay deterministically without hitting Razorpay again
    const dupPreFail = await processAutoRefundForOrder(db, 'CFX-H2-PREFAIL', { nowMs });
    assert.strictEqual(dupPreFail.status, 'skipped');
    assert.strictEqual(dupPreFail.skipReason, 'ALREADY_REFUNDED_OR_PENDING');
    assert.strictEqual(gatewayRefundCalls.length, 1);

    const preFailRefunds = await getRefundsByOrderId(db, 'CFX-H2-PREFAIL');
    assert.strictEqual(preFailRefunds.length, 1);
    assert.strictEqual(preFailRefunds[0].idempotency_key, buildAutoRefundIdempotencyKey('CFX-H2-PREFAIL'));
    console.log('   PASS: Pre-dispense failure refunded ONCE via deterministic key.');

    // 3. Uncertain Mid-Dispense Failure & Active DISPENSING Must Never Auto-Refund
    console.log('3. Testing DISPENSING & uncertain mid-dispense blocking...');
    await seedPaidOrder(firestore, {
      id: 'CFX-H2-UNCERTAIN',
      machine_id: 'CFX-MC-01',
      product_id: 1,
      amount: 100,
      captured_amount_paise: 10000,
      status: 'PAID',
      dispense_status: 'QUEUED',
      dispensed: false,
      refund_status: 'NONE',
      total_refunded_amount_paise: 0,
      pending_refund_amount_paise: 0,
      razorpay_order_id: 'order_h2_unc',
      razorpay_payment_id: 'pay_h2_unc',
      created_at: staleCreatedIso,
      updated_at: staleCreatedIso
    });
    // Machine claims DISPENSING
    const claimRes = await api(
      'POST',
      '/orders/CFX-H2-UNCERTAIN/dispense-result',
      mc1Jwt,
      { dispense_status: 'DISPENSING' }
    );
    assert.strictEqual(claimRes.status, 200);
    assert.strictEqual(claimRes.body.data.order.dispense_status, 'DISPENSING');

    // Attempt auto-refund while DISPENSING -> MUST SKIP
    const autoWhileDisp = await processAutoRefundForOrder(db, 'CFX-H2-UNCERTAIN', { nowMs });
    assert.strictEqual(autoWhileDisp.status, 'skipped');
    assert.strictEqual(autoWhileDisp.skipReason, 'UNCERTAIN_DISPENSE_IN_PROGRESS');

    // Hardware disconnects during pour -> FAILED (DURING_DISPENSE / UNCERTAIN) -> MUST NOT AUTO-REFUND
    const duringFailRes = await api(
      'POST',
      '/orders/CFX-H2-UNCERTAIN/dispense-result',
      mc1Jwt,
      { dispense_status: 'FAILED', failure_stage: 'DURING_DISPENSE', failure_reason: 'SERIAL_DISCONNECTED_MID_POUR' }
    );
    assert.strictEqual(duringFailRes.status, 200);
    assert.strictEqual(duringFailRes.body.data.order.dispense_outcome, 'UNCERTAIN');
    assert.strictEqual(duringFailRes.body.data.autoRefund, undefined);
    assert.strictEqual(duringFailRes.body.data.order.refund_status, 'NONE');
    assert.strictEqual(gatewayRefundCalls.length, 1);

    // Manual Super Admin refund STILL works after human investigation (partial or full)
    const manualRes = await api(
      'POST',
      '/orders/CFX-H2-UNCERTAIN/refund',
      adminToken,
      { amount_paise: 5000, reason: 'manual_customer_support_partial' }
    );
    assert.strictEqual(manualRes.status, 200);
    assert.strictEqual(manualRes.body.data.order.refund_status, 'PARTIAL');
    assert.strictEqual(manualRes.body.data.order.total_refunded_amount_paise, 5000);
    console.log('   PASS: DISPENSING/uncertain never auto-refunded; manual refund preserved.');

    // 4. Stale QUEUED Expiry, Successful DISPENSED, Unverified Capture & Cron Sweep
    console.log('4. Testing stale QUEUED expiry sweep, DISPENSED exclusion, & unverified capture guard...');
    await seedPaidOrder(firestore, {
      id: 'CFX-H2-STALE',
      machine_id: 'CFX-MC-01',
      product_id: 1,
      amount: 120,
      captured_amount_paise: 12000,
      status: 'PAID',
      dispense_status: 'QUEUED',
      dispensed: false,
      refund_status: 'NONE',
      total_refunded_amount_paise: 0,
      pending_refund_amount_paise: 0,
      razorpay_order_id: 'order_h2_stale',
      razorpay_payment_id: 'pay_h2_stale',
      created_at: staleCreatedIso,
      updated_at: staleCreatedIso
    });
    await seedPaidOrder(firestore, {
      id: 'CFX-H2-FRESH',
      machine_id: 'CFX-MC-01',
      product_id: 1,
      amount: 100,
      captured_amount_paise: 10000,
      status: 'PAID',
      dispense_status: 'QUEUED',
      dispensed: false,
      refund_status: 'NONE',
      total_refunded_amount_paise: 0,
      pending_refund_amount_paise: 0,
      razorpay_order_id: 'order_h2_fresh',
      razorpay_payment_id: 'pay_h2_fresh',
      created_at: freshCreatedIso,
      updated_at: freshCreatedIso
    });
    await seedPaidOrder(firestore, {
      id: 'CFX-H2-DISPENSED',
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
      razorpay_order_id: 'order_h2_disp',
      razorpay_payment_id: 'pay_h2_disp',
      created_at: staleCreatedIso,
      updated_at: staleCreatedIso
    });
    await seedPaidOrder(firestore, {
      id: 'CFX-H2-UNVERIFIED',
      machine_id: 'CFX-MC-01',
      product_id: 1,
      amount: 100,
      captured_amount_paise: null,
      status: 'PAID',
      dispense_status: 'FAILED',
      dispensed: false,
      dispense_outcome: 'NOT_DISPENSED',
      refund_status: 'NONE',
      total_refunded_amount_paise: 0,
      pending_refund_amount_paise: 0,
      razorpay_order_id: 'order_h2_unver',
      razorpay_payment_id: null,
      created_at: staleCreatedIso,
      updated_at: staleCreatedIso
    });
    // Untouched CFX-MC-02 & CFX-MC-03 orders
    await seedPaidOrder(firestore, {
      id: 'CFX-H2-MC02',
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
      razorpay_order_id: 'order_h2_mc02',
      razorpay_payment_id: 'pay_h2_mc02',
      created_at: freshCreatedIso,
      updated_at: freshCreatedIso
    });
    await seedPaidOrder(firestore, {
      id: 'CFX-H2-MC03',
      machine_id: 'CFX-MC-03',
      product_id: 1,
      amount: 100,
      captured_amount_paise: 10000,
      status: 'PAID',
      dispense_status: 'QUEUED',
      dispensed: false,
      refund_status: 'NONE',
      total_refunded_amount_paise: 0,
      pending_refund_amount_paise: 0,
      razorpay_order_id: 'order_h2_mc03',
      razorpay_payment_id: 'pay_h2_mc03',
      created_at: freshCreatedIso,
      updated_at: freshCreatedIso
    });

    const cronSweepRes = await api(
      'POST',
      '/cron/auto-refund?queuedExpiryMinutes=15',
      undefined,
      undefined,
      { Authorization: `Bearer ${process.env.CRON_SECRET}` }
    );
    assert.strictEqual(cronSweepRes.status, 200);
    const sweepData = cronSweepRes.body.data;
    assert.strictEqual(sweepData.expired_queued, 1);
    assert.strictEqual(sweepData.refunded_processed, 1);
    assert.strictEqual(sweepData.skipped_dispensed, 1);
    assert.strictEqual(sweepData.skipped_uncertain, 1);
    assert.strictEqual(sweepData.skipped_unverified, 1);
    assert.strictEqual(sweepData.skipped_not_expired, 3); // CFX-H2-FRESH, MC02, MC03

    // Expired/refunded CFX-H2-STALE cannot be claimed/dispensed afterwards!
    const lateClaim = await api(
      'POST',
      '/orders/CFX-H2-STALE/dispense-result',
      mc1Jwt,
      { dispense_status: 'DISPENSING' }
    );
    assert.strictEqual(lateClaim.status, 409);

    // Repeat cron sweep produces zero additional gateway calls
    const beforeSecondSweepCalls = gatewayRefundCalls.length;
    const secondSweep = await runAutoRefundSweep({ nowMs });
    assert.strictEqual(secondSweep.refunded_processed, 0);
    assert.strictEqual(gatewayRefundCalls.length, beforeSecondSweepCalls);
    console.log('   PASS: Stale QUEUED expiry sweep, exclusions, & anti-redispense lock verified.');

    // 5. Concurrent Dispense Claim vs Auto-Refund Expiry Race (Zero Double Win)
    console.log('5. Testing concurrent dispense claim vs auto-refund expiry race...');
    await seedPaidOrder(firestore, {
      id: 'CFX-H2-RACE',
      machine_id: 'CFX-MC-01',
      product_id: 1,
      amount: 100,
      captured_amount_paise: 10000,
      status: 'PAID',
      dispense_status: 'QUEUED',
      dispensed: false,
      refund_status: 'NONE',
      total_refunded_amount_paise: 0,
      pending_refund_amount_paise: 0,
      razorpay_order_id: 'order_h2_race',
      razorpay_payment_id: 'pay_h2_race',
      created_at: staleCreatedIso,
      updated_at: staleCreatedIso
    });

    const [raceClaim, raceRefund] = await Promise.all([
      api('POST', '/orders/CFX-H2-RACE/dispense-result', mc1Jwt, { dispense_status: 'DISPENSING' }),
      processAutoRefundForOrder(db, 'CFX-H2-RACE', { nowMs })
    ]);
    const finalRaceOrder = await getAuthoritativeOrderById('CFX-H2-RACE', db);
    const claimedWon = raceClaim.status === 200 && finalRaceOrder.dispense_status === 'DISPENSING' && finalRaceOrder.refund_status === 'NONE';
    const refundWon = raceRefund.status === 'refunded' && finalRaceOrder.dispense_status === 'EXPIRED' && finalRaceOrder.refund_status === 'FULL';
    assert.ok(claimedWon || refundWon, 'Exactly one of dispense claim or expiry refund must win atomically');
    assert.ok(!(claimedWon && refundWon), 'Both dispense claim and auto-refund must NEVER succeed simultaneously');
    console.log(`   PASS: Mutual exclusion under concurrency verified (${claimedWon ? 'DISPENSE_WON' : 'REFUND_WON'}).`);

    // 6. Razorpay PENDING / TIMEOUT / FAILED Responses
    console.log('6. Testing Razorpay PENDING, ETIMEDOUT, & REJECTED outcomes...');
    await seedPaidOrder(firestore, {
      id: 'CFX-H2-RP-PEND',
      machine_id: 'CFX-MC-01',
      product_id: 1,
      amount: 100,
      captured_amount_paise: 10000,
      status: 'PAID',
      dispense_status: 'FAILED',
      dispensed: false,
      dispense_outcome: 'NOT_DISPENSED',
      failure_stage: 'PRE_DISPENSE',
      refund_status: 'NONE',
      total_refunded_amount_paise: 0,
      pending_refund_amount_paise: 0,
      razorpay_order_id: 'order_h2_rppend',
      razorpay_payment_id: 'pay_h2_rppend',
      created_at: freshCreatedIso,
      updated_at: freshCreatedIso
    });
    gatewayBehavior = 'pending';
    const pendOutcome = await processAutoRefundForOrder(db, 'CFX-H2-RP-PEND', { nowMs });
    assert.strictEqual(pendOutcome.status, 'pending');
    assert.strictEqual(pendOutcome.refund?.status, 'PENDING');
    assert.strictEqual(pendOutcome.order?.pending_refund_amount_paise, 10000);
    assert.strictEqual(pendOutcome.order?.total_refunded_amount_paise, 0);

    // Timeout case
    await seedPaidOrder(firestore, {
      id: 'CFX-H2-RP-TO',
      machine_id: 'CFX-MC-01',
      product_id: 1,
      amount: 100,
      captured_amount_paise: 10000,
      status: 'PAID',
      dispense_status: 'FAILED',
      dispensed: false,
      dispense_outcome: 'NOT_DISPENSED',
      failure_stage: 'PRE_DISPENSE',
      refund_status: 'NONE',
      total_refunded_amount_paise: 0,
      pending_refund_amount_paise: 0,
      razorpay_order_id: 'order_h2_rpto',
      razorpay_payment_id: 'pay_h2_rpto',
      created_at: freshCreatedIso,
      updated_at: freshCreatedIso
    });
    gatewayBehavior = 'timeout';
    const toOutcome = await processAutoRefundForOrder(db, 'CFX-H2-RP-TO', { nowMs });
    assert.strictEqual(toOutcome.status, 'pending');
    assert.strictEqual(toOutcome.order?.pending_refund_amount_paise, 10000);
    assert.strictEqual(toOutcome.order?.total_refunded_amount_paise, 0);

    // Rejection case releases pending hold safely
    await seedPaidOrder(firestore, {
      id: 'CFX-H2-RP-REJ',
      machine_id: 'CFX-MC-01',
      product_id: 1,
      amount: 100,
      captured_amount_paise: 10000,
      status: 'PAID',
      dispense_status: 'FAILED',
      dispensed: false,
      dispense_outcome: 'NOT_DISPENSED',
      failure_stage: 'PRE_DISPENSE',
      refund_status: 'NONE',
      total_refunded_amount_paise: 0,
      pending_refund_amount_paise: 0,
      razorpay_order_id: 'order_h2_rprej',
      razorpay_payment_id: 'pay_h2_rprej',
      created_at: freshCreatedIso,
      updated_at: freshCreatedIso
    });
    gatewayBehavior = 'reject';
    const rejOutcome = await processAutoRefundForOrder(db, 'CFX-H2-RP-REJ', { nowMs });
    assert.strictEqual(rejOutcome.status, 'failed');
    assert.strictEqual(rejOutcome.refund?.status, 'FAILED');
    assert.strictEqual(rejOutcome.order?.pending_refund_amount_paise, 0);
    assert.strictEqual(rejOutcome.order?.total_refunded_amount_paise, 0);
    gatewayBehavior = 'processed';
    console.log('   PASS: Razorpay pending/timeout holds & rejection hold-release verified.');

    // 7. Cross-Machine Isolation & CFX-MC-03 Preservation
    console.log('7. Testing cross-machine RBAC & CFX-MC-03 preservation...');
    const crossDispense = await api(
      'POST',
      '/orders/CFX-H2-MC02/dispense-result',
      mc1Jwt,
      { dispense_status: 'FAILED', failure_stage: 'PRE_DISPENSE' }
    );
    assert.strictEqual(crossDispense.status, 403, 'CFX-MC-01 must NOT alter CFX-MC-02 orders');

    const ownerRefundAttempt = await api(
      'POST',
      '/orders/CFX-H2-FRESH/refund',
      owner1Token,
      { reason: 'owner_should_be_blocked' }
    );
    assert.strictEqual(ownerRefundAttempt.status, 403, 'Owner must remain forbidden from refund endpoint');

    const mc3Doc = (await firestore.collection('machines').doc('CFX-MC-03').get()).data();
    assert.strictEqual(mc3Doc?.owner_id, null);
    assert.strictEqual(mc3Doc?.last_seen, null);
    const mc3Order = await getAuthoritativeOrderById('CFX-H2-MC03', db);
    assert.strictEqual(mc3Order?.dispense_status, 'QUEUED');
    assert.strictEqual(mc3Order?.refund_status, 'NONE');
    console.log('   PASS: Cross-machine isolation, owner RBAC, and CFX-MC-03 integrity verified.');

    console.log('\nALL PHASE H.2 SAFE AUTOMATIC REFUND TESTS PASSED!\n');
  } finally {
    setRazorpayRefundClientForTesting(null);
    delete process.env.BLOCK_OFFLINE_MACHINE_ORDERS;
    delete process.env.AUTO_REFUND_QUEUED_EXPIRY_MINUTES;
    await db.run("DELETE FROM refunds WHERE order_id LIKE 'CFX-H2-%'").catch(() => {});
    await db.run("DELETE FROM orders WHERE id LIKE 'CFX-H2-%'").catch(() => {});
    if (typeof (server as any).closeAllConnections === 'function') {
      (server as any).closeAllConnections();
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
    for (const a of getApps()) await deleteApp(a);
  }
}

runTests().catch((err) => {
  console.error('Phase H.2 auto-refund tests failed:', err);
  process.exit(1);
});

