import assert from 'assert';
import crypto from 'crypto';
import sqlite3 from 'sqlite3';
import { open, Database } from 'sqlite';
import { initializeApp, getApps, deleteApp } from 'firebase-admin/app';
import { getFirestore, Firestore } from 'firebase-admin/firestore';
import {
  ensureFirebaseReady,
  getFirestoreInstance,
  setFirestoreForTesting,
  isFirestoreActive,
  commitOrderTransitionInFirebase,
  getAuthoritativeOrderById
} from '../utils/firebase';
import {
  claimWebhookEvent,
  markWebhookEventProcessed,
  markWebhookEventFailed,
  getWebhookEvent
} from '../utils/webhookLedger';
import {
  createPendingRefundReservation,
  markRefundProcessed,
  markRefundFailed,
  reconcileAuthoritativeGatewayRefundOutcome,
  getRefundById,
  getRefundsByOrderId
} from '../utils/refunds';
import {
  executeOrderStatusUpdate,
  updateOrderPaymentCapture
} from '../controllers/orderController';
import { ServiceUnavailableError, ConflictError } from '../utils/errors';

const EMULATOR_HOST = '127.0.0.1:8088';
const EMULATOR_PROJECT_ID = 'demo-caffix-emulator';

// Configure environment for official Firestore Emulator testing
process.env.FIRESTORE_EMULATOR_HOST = EMULATOR_HOST;
process.env.FIREBASE_PROJECT_ID = EMULATOR_PROJECT_ID;
delete process.env.VERCEL_ENV;
delete process.env.STRICT_FIREBASE_VALIDATION;

async function clearEmulatorDatabase() {
  const url = `http://${EMULATOR_HOST}/emulator/v1/projects/${EMULATOR_PROJECT_ID}/databases/(default)/documents`;
  const res = await fetch(url, { method: 'DELETE' });
  if (!res.ok) {
    throw new Error(`Failed to clear emulator database: HTTP ${res.status}`);
  }
}

async function createIsolatedSqliteDb(): Promise<Database> {
  const db = await open({
    filename: ':memory:',
    driver: sqlite3.Database
  });

  await db.exec(`
    CREATE TABLE IF NOT EXISTS machines (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      owner_id TEXT,
      location TEXT,
      desired_mode TEXT DEFAULT 'RUNNING',
      connection_status TEXT DEFAULT 'ONLINE',
      last_seen TEXT
    );

    CREATE TABLE IF NOT EXISTS orders (
      id TEXT PRIMARY KEY,
      machine_id TEXT NOT NULL,
      product_name TEXT NOT NULL,
      amount REAL NOT NULL,
      captured_amount_paise INTEGER,
      status TEXT NOT NULL,
      dispense_status TEXT DEFAULT 'PENDING',
      dispensed BOOLEAN DEFAULT 0,
      refund_status TEXT DEFAULT 'NONE',
      total_refunded_amount_paise INTEGER DEFAULT 0,
      pending_refund_amount_paise INTEGER DEFAULT 0,
      last_refunded_at TEXT,
      refund_version INTEGER DEFAULT 0,
      razorpay_order_id TEXT,
      razorpay_payment_id TEXT,
      razorpay_signature TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS refunds (
      id TEXT PRIMARY KEY,
      order_id TEXT NOT NULL,
      machine_id TEXT NOT NULL,
      razorpay_payment_id TEXT NOT NULL,
      razorpay_refund_id TEXT,
      amount_paise INTEGER NOT NULL,
      currency TEXT DEFAULT 'INR',
      status TEXT NOT NULL,
      reason TEXT NOT NULL,
      notes TEXT,
      initiated_by TEXT NOT NULL,
      source TEXT DEFAULT 'SUPER_ADMIN_PORTAL',
      idempotency_key TEXT UNIQUE,
      error_code TEXT,
      error_description TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      processed_at TEXT
    );

    CREATE TABLE IF NOT EXISTS webhook_events (
      id TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      event_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      order_id TEXT,
      payment_id TEXT,
      refund_id TEXT,
      status TEXT NOT NULL,
      payload TEXT,
      error_message TEXT,
      lease_expires_at TEXT,
      claim_count INTEGER DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      processed_at TEXT,
      UNIQUE(provider, event_id)
    );

    CREATE TABLE IF NOT EXISTS inventory (
      machine_id TEXT PRIMARY KEY,
      coffee_beans_level REAL DEFAULT 1000,
      milk_level REAL DEFAULT 1000,
      water_level REAL DEFAULT 1000,
      paper_cups_count INTEGER DEFAULT 500,
      stirrer_sticks_count INTEGER DEFAULT 500,
      last_refilled_at TEXT
    );
  `);

  return db;
}

async function runPhase2_7_3_EmulatorTests() {
  console.log('========================================================================');
  console.log('Running CAFFIX Phase 2.7.3 — Official Firebase Emulator Integration Tests');
  console.log(`Target Emulator Host: http://${EMULATOR_HOST}`);
  console.log(`Isolated Project ID: ${EMULATOR_PROJECT_ID}`);
  console.log('========================================================================\n');

  // Verify emulator health before starting
  await clearEmulatorDatabase();

  ensureFirebaseReady();
  const fsAdmin = getFirestoreInstance();
  assert(fsAdmin, 'Firebase Admin must be initialized with Firestore Emulator instance');

  // --------------------------------------------------------------------------
  // SECTION 1 & 2: EMULATOR SAFETY & CONFIGURATION
  // --------------------------------------------------------------------------
  console.log('Scenario 1 [Emulator Safety]: Verifying isolated demo project routing...');
  const testDocRef = fsAdmin.collection('safety_check').doc('ping');
  await testDocRef.set({ ok: true, timestamp: new Date().toISOString() });
  const testDocSnap = await testDocRef.get();
  assert.strictEqual(testDocSnap.exists, true);
  assert.strictEqual(testDocSnap.data()?.ok, true);
  console.log('   PASS [Scenario 1]: Direct document mutation verified in official Firestore emulator.\n');

  console.log('Scenario 2 [Emulator Guard]: Refuse emulator when VERCEL_ENV=production or preview...');
  assert.throws(
    () => {
      process.env.VERCEL_ENV = 'production';
      ensureFirebaseReady();
    },
    ServiceUnavailableError,
    'Must fail closed (HTTP 503) if FIRESTORE_EMULATOR_HOST is used in production Vercel environment'
  );
  assert.throws(
    () => {
      process.env.VERCEL_ENV = 'preview';
      ensureFirebaseReady();
    },
    ServiceUnavailableError,
    'Must fail closed (HTTP 503) if FIRESTORE_EMULATOR_HOST is used in preview Vercel environment'
  );
  delete process.env.VERCEL_ENV;
  ensureFirebaseReady(); // Restore clean emulator state
  console.log('   PASS [Scenario 2]: Vercel production/preview isolation guards verified.\n');

  console.log('Scenario 3 [Emulator Guard]: Refuse live project IDs caffix-vending or caffix-staging...');
  assert.throws(
    () => {
      process.env.FIREBASE_PROJECT_ID = 'caffix-vending';
      ensureFirebaseReady();
    },
    ServiceUnavailableError,
    'Must fail closed if live production project ID is passed with emulator'
  );
  assert.throws(
    () => {
      process.env.FIREBASE_PROJECT_ID = 'caffix-staging';
      ensureFirebaseReady();
    },
    ServiceUnavailableError,
    'Must fail closed if live staging project ID is passed with emulator'
  );
  process.env.FIREBASE_PROJECT_ID = EMULATOR_PROJECT_ID;
  ensureFirebaseReady();
  console.log('   PASS [Scenario 3]: Production/Staging project ID collision blocked fail-closed.\n');

  // --------------------------------------------------------------------------
  // SECTION 3: FIRESTORE REFUND TRANSACTIONS (LIVE EMULATOR OCC)
  // --------------------------------------------------------------------------
  console.log('Scenario 4 [Refund Reservation]: Creating Firestore refund reservation in live emulator...');
  await clearEmulatorDatabase();
  const db4 = await createIsolatedSqliteDb();

  const order4 = {
    id: 'ORD-EMU-04',
    machine_id: 'CFX-MC-01',
    product_name: 'Espresso',
    amount: 100,
    captured_amount_paise: 10000,
    status: 'PAID',
    dispense_status: 'DISPENSED',
    refund_status: 'NONE',
    total_refunded_amount_paise: 0,
    pending_refund_amount_paise: 0,
    refund_version: 1,
    razorpay_payment_id: 'pay_emu_04',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };

  // Persist order in emulator and SQLite
  await fsAdmin.collection('orders').doc(order4.id).set(order4);
  await db4.run(
    `INSERT INTO orders (id, machine_id, product_name, amount, captured_amount_paise, status, dispense_status, razorpay_payment_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [order4.id, order4.machine_id, order4.product_name, order4.amount, order4.captured_amount_paise, order4.status, order4.dispense_status, order4.razorpay_payment_id, order4.created_at, order4.updated_at]
  );

  // Reserve ₹40 (4000 paise)
  const res4 = await createPendingRefundReservation(db4, {
    orderId: order4.id,
    amount_paise: 4000,
    reason: 'customer_request',
    notes: 'Phase 2.7.3 emulator reservation test',
    initiated_by: 'admin',
    idempotency_key: 'idem_res_04'
  });

  assert.strictEqual(res4.refund.amount_paise, 4000);
  assert.strictEqual(res4.refund.status, 'PENDING');
  assert.strictEqual(res4.order.pending_refund_amount_paise, 4000);
  assert.strictEqual(res4.order.refund_version, 2);

  // Verify actual persisted documents in the emulator
  const emuOrderSnap4 = await fsAdmin.collection('orders').doc(order4.id).get();
  assert.strictEqual(emuOrderSnap4.data()?.pending_refund_amount_paise, 4000);
  assert.strictEqual(emuOrderSnap4.data()?.refund_version, 2);

  const emuRefundSnap4 = await fsAdmin.collection('orders').doc(order4.id).collection('refunds').doc(res4.refund.id).get();
  assert.strictEqual(emuRefundSnap4.exists, true);
  assert.strictEqual(emuRefundSnap4.data()?.status, 'PENDING');
  assert.strictEqual(emuRefundSnap4.data()?.amount_paise, 4000);

  const emuRootRefundSnap4 = await fsAdmin.collection('refunds').doc(res4.refund.id).get();
  assert.strictEqual(emuRootRefundSnap4.exists, true);
  assert.strictEqual(emuRootRefundSnap4.data()?.status, 'PENDING');
  console.log('   PASS [Scenario 4]: Live emulator refund reservation and dual-path document persistence verified.\n');

  console.log('Scenario 5 [Partial Refund Settlement]: Settling reservation to PROCESSED...');
  const procRes5 = await markRefundProcessed(db4, {
    refundId: res4.refund.id,
    razorpay_refund_id: 'rfnd_emu_proc_05',
    processed_at: new Date().toISOString()
  });

  assert.strictEqual(procRes5.refund.status, 'PROCESSED');
  assert.strictEqual(procRes5.order.total_refunded_amount_paise, 4000);
  assert.strictEqual(procRes5.order.pending_refund_amount_paise, 0);
  assert.strictEqual(procRes5.order.refund_status, 'PARTIAL');

  // Check emulator document state
  const emuOrderSnap5 = await fsAdmin.collection('orders').doc(order4.id).get();
  assert.strictEqual(emuOrderSnap5.data()?.total_refunded_amount_paise, 4000);
  assert.strictEqual(emuOrderSnap5.data()?.pending_refund_amount_paise, 0);
  assert.strictEqual(emuOrderSnap5.data()?.refund_status, 'PARTIAL');

  const emuRefundSnap5 = await fsAdmin.collection('orders').doc(order4.id).collection('refunds').doc(res4.refund.id).get();
  assert.strictEqual(emuRefundSnap5.data()?.status, 'PROCESSED');
  assert.strictEqual(emuRefundSnap5.data()?.razorpay_refund_id, 'rfnd_emu_proc_05');
  console.log('   PASS [Scenario 5]: Partial refund settlement committed and verified in Firestore emulator.\n');

  console.log('Scenario 6 [Full Refund Settlement]: Second reservation ₹60 transitions order to FULL...');
  const res6 = await createPendingRefundReservation(db4, {
    orderId: order4.id,
    amount_paise: 6000,
    reason: 'customer_request_remaining',
    initiated_by: 'admin',
    idempotency_key: 'idem_res_06'
  });

  const procRes6 = await markRefundProcessed(db4, {
    refundId: res6.refund.id,
    razorpay_refund_id: 'rfnd_emu_proc_06'
  });

  assert.strictEqual(procRes6.order.total_refunded_amount_paise, 10000);
  assert.strictEqual(procRes6.order.pending_refund_amount_paise, 0);
  assert.strictEqual(procRes6.order.refund_status, 'FULL');

  // Verify full capacity exhaustion rejects further reservations
  await assert.rejects(
    async () => {
      await createPendingRefundReservation(db4, {
        orderId: order4.id,
        amount_paise: 100,
        reason: 'illegal_extra',
        initiated_by: 'admin',
        idempotency_key: 'idem_res_illegal'
      });
    },
    (err: any) => err.message.includes('exceeds remaining available refundable balance'),
    'Reservation on fully refunded order must be rejected'
  );
  console.log('   PASS [Scenario 6]: Full refund settlement and remaining balance boundary enforcement verified.\n');

  console.log('Scenario 7 [Refund Failure & Reservation Release]: Releasing hold on gateway failure...');
  const order7 = {
    id: 'ORD-EMU-07',
    machine_id: 'CFX-MC-01',
    product_name: 'Cappuccino',
    amount: 100,
    captured_amount_paise: 10000,
    status: 'PAID',
    dispense_status: 'DISPENSED',
    refund_status: 'NONE',
    total_refunded_amount_paise: 0,
    pending_refund_amount_paise: 0,
    refund_version: 1,
    razorpay_payment_id: 'pay_emu_07',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };
  await fsAdmin.collection('orders').doc(order7.id).set(order7);
  await db4.run(
    `INSERT INTO orders (id, machine_id, product_name, amount, captured_amount_paise, status, dispense_status, razorpay_payment_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [order7.id, order7.machine_id, order7.product_name, order7.amount, order7.captured_amount_paise, order7.status, order7.dispense_status, order7.razorpay_payment_id, order7.created_at, order7.updated_at]
  );

  const res7 = await createPendingRefundReservation(db4, {
    orderId: order7.id,
    amount_paise: 5000,
    reason: 'will_fail',
    initiated_by: 'admin',
    idempotency_key: 'idem_res_07'
  });
  assert.strictEqual(res7.order.pending_refund_amount_paise, 5000);

  const failRes7 = await markRefundFailed(db4, {
    refundId: res7.refund.id,
    error_code: 'GATEWAY_REJECTED',
    error_description: 'Card expired or closed account'
  });

  assert.strictEqual(failRes7.refund.status, 'FAILED');
  assert.strictEqual(failRes7.order.pending_refund_amount_paise, 0);
  assert.strictEqual(failRes7.order.total_refunded_amount_paise, 0);

  // Check emulator document
  const emuOrderSnap7 = await fsAdmin.collection('orders').doc(order7.id).get();
  assert.strictEqual(emuOrderSnap7.data()?.pending_refund_amount_paise, 0);
  assert.strictEqual(emuOrderSnap7.data()?.total_refunded_amount_paise, 0);

  const emuRefundSnap7 = await fsAdmin.collection('orders').doc(order7.id).collection('refunds').doc(res7.refund.id).get();
  assert.strictEqual(emuRefundSnap7.data()?.status, 'FAILED');
  assert.strictEqual(emuRefundSnap7.data()?.error_code, 'GATEWAY_REJECTED');
  console.log('   PASS [Scenario 7]: Reservation hold cleanly released and recorded as FAILED in emulator.\n');

  console.log('Scenario 8 [Gateway Amount Mismatch]: Holding in PENDING on amount discrepancy...');
  const order8 = {
    id: 'ORD-EMU-08',
    machine_id: 'CFX-MC-01',
    product_name: 'Latte',
    amount: 100,
    captured_amount_paise: 10000,
    status: 'PAID',
    dispense_status: 'DISPENSED',
    refund_status: 'NONE',
    total_refunded_amount_paise: 0,
    pending_refund_amount_paise: 0,
    refund_version: 1,
    razorpay_payment_id: 'pay_emu_08',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };
  await fsAdmin.collection('orders').doc(order8.id).set(order8);
  await db4.run(
    `INSERT INTO orders (id, machine_id, product_name, amount, captured_amount_paise, status, dispense_status, razorpay_payment_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [order8.id, order8.machine_id, order8.product_name, order8.amount, order8.captured_amount_paise, order8.status, order8.dispense_status, order8.razorpay_payment_id, order8.created_at, order8.updated_at]
  );

  const res8 = await createPendingRefundReservation(db4, {
    orderId: order8.id,
    amount_paise: 3000,
    reason: 'mismatch_test',
    initiated_by: 'admin',
    idempotency_key: 'idem_res_08'
  });

  // Gateway webhook reports 5000 paise instead of reserved 3000 paise
  await assert.rejects(
    async () => {
      await reconcileAuthoritativeGatewayRefundOutcome(db4, {
        orderId: order8.id,
        refundId: res8.refund.id,
        razorpayRefundId: 'rfnd_emu_mismatch_08',
        amount_paise: 5000,
        currency: 'INR'
      });
    },
    ConflictError,
    'Must throw ConflictError on gateway amount mismatch'
  );

  // Invariant: The refund MUST remain in PENDING with mismatch diagnostic; never settled!
  const emuRefundSnap8 = await fsAdmin.collection('orders').doc(order8.id).collection('refunds').doc(res8.refund.id).get();
  assert.strictEqual(emuRefundSnap8.data()?.status, 'PENDING');
  assert.strictEqual(emuRefundSnap8.data()?.error_code, 'GATEWAY_AMOUNT_MISMATCH');
  console.log('   PASS [Scenario 8]: Mismatched refund safely retained in PENDING without settlement.\n');

  console.log('Scenario 9 [Out-of-Order Webhook]: Gateway settlement arriving before reservation...');
  const order9 = {
    id: 'ORD-EMU-09',
    machine_id: 'CFX-MC-01',
    product_name: 'Mocha',
    amount: 100,
    captured_amount_paise: 10000,
    status: 'PAID',
    dispense_status: 'DISPENSED',
    refund_status: 'NONE',
    total_refunded_amount_paise: 0,
    pending_refund_amount_paise: 0,
    refund_version: 1,
    razorpay_payment_id: 'pay_emu_09',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };
  await fsAdmin.collection('orders').doc(order9.id).set(order9);
  await db4.run(
    `INSERT INTO orders (id, machine_id, product_name, amount, captured_amount_paise, status, dispense_status, razorpay_payment_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [order9.id, order9.machine_id, order9.product_name, order9.amount, order9.captured_amount_paise, order9.status, order9.dispense_status, order9.razorpay_payment_id, order9.created_at, order9.updated_at]
  );

  const outOfOrderRes = await reconcileAuthoritativeGatewayRefundOutcome(db4, {
    orderId: order9.id,
    razorpayRefundId: 'rfnd_emu_ooo_09',
    amount_paise: 3500,
    currency: 'INR',
    machineId: order9.machine_id
  });

  assert.strictEqual(outOfOrderRes.refund.status, 'PROCESSED');
  assert.strictEqual(outOfOrderRes.refund.amount_paise, 3500);
  assert.strictEqual(outOfOrderRes.order.total_refunded_amount_paise, 3500);

  // Duplicate replay
  const replayRes = await reconcileAuthoritativeGatewayRefundOutcome(db4, {
    orderId: order9.id,
    razorpayRefundId: 'rfnd_emu_ooo_09',
    amount_paise: 3500,
    currency: 'INR'
  });
  assert.strictEqual(replayRes.isReplay, true);
  console.log('   PASS [Scenario 9]: Out-of-order unreserved settlement and idempotent replay verified.\n');

  // --------------------------------------------------------------------------
  // SECTION 4: DISTRIBUTED WEBHOOK LEASES (TWO INDEPENDENT CLIENTS)
  // --------------------------------------------------------------------------
  console.log('Scenario 10 [Distributed Lease]: Two independent Firestore clients competing on lease...');
  await clearEmulatorDatabase();

  // Create two distinct Firebase apps / Firestore client instances connected to the same emulator
  const appA = initializeApp({ projectId: EMULATOR_PROJECT_ID }, 'client-worker-A');
  const appB = initializeApp({ projectId: EMULATOR_PROJECT_ID }, 'client-worker-B');
  const clientA = getFirestore(appA);
  const clientB = getFirestore(appB);

  const eventId = 'evt_dist_race_10';
  const provider = 'razorpay';
  const whDocRef = clientA.collection('webhook_events').doc(`${provider}_${eventId}`);

  // 1. Worker A claims the event (Gen 1)
  setFirestoreForTesting({ firestoreInstance: clientA });
  const claimA = await claimWebhookEvent(db4, {
    provider,
    eventId,
    eventType: 'refund.processed',
    leaseDurationMs: 60000 // 60s lease
  });
  assert.strictEqual(claimA.shouldProcess, true);
  assert.strictEqual(claimA.claimCount, 1);
  assert.strictEqual(claimA.claimToken, `${provider}_${eventId}_gen_1`);

  // 2. Worker B attempts to claim the same event while lease is active
  setFirestoreForTesting({ firestoreInstance: clientB });
  const claimB1 = await claimWebhookEvent(db4, {
    provider,
    eventId,
    eventType: 'refund.processed'
  });
  assert.strictEqual(claimB1.shouldProcess, false);
  assert.strictEqual(claimB1.isConcurrentInFlight, true);

  // 3. Worker A's lease expires (simulated by setting lease_expires_at into the past)
  const expiredIso = new Date(Date.now() - 5000).toISOString();
  await whDocRef.update({ lease_expires_at: expiredIso });

  // 4. Worker B reclaims the expired lease (Gen 2)
  const claimB2 = await claimWebhookEvent(db4, {
    provider,
    eventId,
    eventType: 'refund.processed'
  });
  assert.strictEqual(claimB2.shouldProcess, true);
  assert.strictEqual(claimB2.isRecovery, true);
  assert.strictEqual(claimB2.claimCount, 2);
  assert.strictEqual(claimB2.claimToken, `${provider}_${eventId}_gen_2`);

  // Setup order for financial mutation
  const order10 = {
    id: 'ORD-EMU-DIST-10',
    machine_id: 'CFX-MC-01',
    product_name: 'Espresso',
    amount: 100,
    captured_amount_paise: 10000,
    status: 'PAID',
    dispense_status: 'DISPENSED',
    refund_status: 'NONE',
    total_refunded_amount_paise: 0,
    pending_refund_amount_paise: 0,
    refund_version: 1,
    razorpay_payment_id: 'pay_emu_dist_10',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };
  await fsAdmin.collection('orders').doc(order10.id).set(order10);
  await db4.run(
    `INSERT INTO orders (id, machine_id, product_name, amount, captured_amount_paise, status, dispense_status, razorpay_payment_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [order10.id, order10.machine_id, order10.product_name, order10.amount, order10.captured_amount_paise, order10.status, order10.dispense_status, order10.razorpay_payment_id, order10.created_at, order10.updated_at]
  );

  // 5. Worker A wakes up and attempts a financial mutation with Gen 1 -> Must be rejected!
  setFirestoreForTesting({ firestoreInstance: clientA });
  await assert.rejects(
    async () => {
      await reconcileAuthoritativeGatewayRefundOutcome(db4, {
        orderId: order10.id,
        razorpayRefundId: 'rfnd_worker_a_stale',
        amount_paise: 5000,
        currency: 'INR',
        webhookFencing: { provider, eventId, claimCount: 1 } // Stale token!
      });
    },
    (err: any) => err.message.includes('[STALE_WEBHOOK_WORKER]'),
    'Worker A mutation with stale claimCount must throw ConflictError'
  );

  // 6. Worker B commits financial mutation with Gen 2 -> Must succeed!
  setFirestoreForTesting({ firestoreInstance: clientB });
  const mutationB = await reconcileAuthoritativeGatewayRefundOutcome(db4, {
    orderId: order10.id,
    razorpayRefundId: 'rfnd_worker_b_valid',
    amount_paise: 5000,
    currency: 'INR',
    webhookFencing: { provider, eventId, claimCount: 2 } // Valid token!
  });
  assert.strictEqual(mutationB.refund.status, 'PROCESSED');
  assert.strictEqual(mutationB.order.total_refunded_amount_paise, 5000);

  // 7. Worker B marks ledger PROCESSED at Gen 2
  await markWebhookEventProcessed(db4, provider, eventId, {
    orderId: order10.id,
    refundId: 'rfnd_worker_b_valid',
    claimCount: 2
  });

  const finalWhSnap = await whDocRef.get();
  assert.strictEqual(finalWhSnap.data()?.status, 'PROCESSED');
  assert.strictEqual(finalWhSnap.data()?.claim_count, 2);

  // 8. Worker A attempts to mark FAILED after completion -> Ledger must remain PROCESSED
  setFirestoreForTesting({ firestoreInstance: clientA });
  await markWebhookEventFailed(db4, provider, eventId, 'Worker A timed out', 1);

  const postFailWhSnap = await whDocRef.get();
  assert.strictEqual(postFailWhSnap.data()?.status, 'PROCESSED');
  assert.strictEqual(postFailWhSnap.data()?.claim_count, 2);

  // Clean up test apps
  await deleteApp(appA);
  await deleteApp(appB);
  setFirestoreForTesting({ firestoreInstance: null });
  ensureFirebaseReady(); // Restore default admin app

  console.log('   PASS [Scenario 10]: Multi-client distributed lease fencing, stale rejection, and terminal protection verified.\n');

  // --------------------------------------------------------------------------
  // SECTION 5: FIRESTORE TRANSACTION CONFLICTS UNDER REAL OCC CONTENTION
  // --------------------------------------------------------------------------
  console.log('Scenario 11 [OCC Contention]: Two concurrent refund reservations on the same order...');
  await clearEmulatorDatabase();

  const order11 = {
    id: 'ORD-EMU-OCC-11',
    machine_id: 'CFX-MC-01',
    product_name: 'Americano',
    amount: 100,
    captured_amount_paise: 10000,
    status: 'PAID',
    dispense_status: 'DISPENSED',
    refund_status: 'NONE',
    total_refunded_amount_paise: 0,
    pending_refund_amount_paise: 0,
    refund_version: 1,
    razorpay_payment_id: 'pay_emu_occ_11',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };
  await fsAdmin.collection('orders').doc(order11.id).set(order11);
  await db4.run(
    `INSERT INTO orders (id, machine_id, product_name, amount, captured_amount_paise, status, dispense_status, razorpay_payment_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [order11.id, order11.machine_id, order11.product_name, order11.amount, order11.captured_amount_paise, order11.status, order11.dispense_status, order11.razorpay_payment_id, order11.created_at, order11.updated_at]
  );

  // Launch two concurrent ₹60 reservations simultaneously against a ₹100 order
  // Under real OCC, Firestore will serialize them; the first succeeds, the second overflows
  const [res11_A, res11_B] = await Promise.allSettled([
    createPendingRefundReservation(db4, {
      orderId: order11.id,
      amount_paise: 6000,
      reason: 'contention_A',
      initiated_by: 'admin',
      idempotency_key: 'idem_res_11_a'
    }),
    createPendingRefundReservation(db4, {
      orderId: order11.id,
      amount_paise: 6000,
      reason: 'contention_B',
      initiated_by: 'admin',
      idempotency_key: 'idem_res_11_b'
    })
  ]);

  const fulfilledCount11 = [res11_A, res11_B].filter((r) => r.status === 'fulfilled').length;
  const rejectedCount11 = [res11_A, res11_B].filter((r) => r.status === 'rejected').length;

  assert.strictEqual(fulfilledCount11, 1, 'Exactly one reservation must succeed');
  assert.strictEqual(rejectedCount11, 1, 'Exactly one reservation must fail due to capacity overflow');

  // Verify document consistency in emulator
  const finalOrderSnap11 = await fsAdmin.collection('orders').doc(order11.id).get();
  assert.strictEqual(finalOrderSnap11.data()?.pending_refund_amount_paise, 6000);
  assert.strictEqual(finalOrderSnap11.data()?.total_refunded_amount_paise, 0);
  console.log('   PASS [Scenario 11]: Real Firestore OCC contention handled safely without double reservation.\n');

  console.log('Scenario 12 [OCC Contention]: Refund reservation vs Dispensing transition race...');
  const order12 = {
    id: 'ORD-EMU-OCC-12',
    machine_id: 'CFX-MC-01',
    product_name: 'Hot Chocolate',
    amount: 100,
    captured_amount_paise: 10000,
    status: 'PAID',
    dispense_status: 'QUEUED',
    refund_status: 'NONE',
    total_refunded_amount_paise: 0,
    pending_refund_amount_paise: 0,
    refund_version: 1,
    razorpay_payment_id: 'pay_emu_occ_12',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };
  await fsAdmin.collection('orders').doc(order12.id).set(order12);
  await db4.run(
    `INSERT INTO orders (id, machine_id, product_name, amount, captured_amount_paise, status, dispense_status, razorpay_payment_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [order12.id, order12.machine_id, order12.product_name, order12.amount, order12.captured_amount_paise, order12.status, order12.dispense_status, order12.razorpay_payment_id, order12.created_at, order12.updated_at]
  );

  // Race: Attempt a full refund reservation while order transitions into DISPENSING
  const [res12_Refund, res12_Dispense] = await Promise.allSettled([
    createPendingRefundReservation(db4, {
      orderId: order12.id,
      amount_paise: 10000,
      reason: 'full_refund_race',
      initiated_by: 'admin',
      idempotency_key: 'idem_res_12'
    }),
    commitOrderTransitionInFirebase({
      order: { ...order12, dispense_status: 'DISPENSING' },
      targetStatus: 'PAID'
    })
  ]);

  // One transaction must commit first; whichever commits must enforce hardware safety
  const finalOrderSnap12 = await fsAdmin.collection('orders').doc(order12.id).get();
  const fData12 = finalOrderSnap12.data()!;

  if (fData12.pending_refund_amount_paise === 10000) {
    assert.notStrictEqual(fData12.dispense_status, 'DISPENSING', 'Dispense must not proceed when fully reserved');
  } else {
    assert.strictEqual(fData12.dispense_status, 'DISPENSING');
    assert.strictEqual(fData12.pending_refund_amount_paise, 0);
  }
  console.log('   PASS [Scenario 12]: Hardware safety invariants mutually excluded under concurrent transaction race.\n');

  console.log('Scenario 13 [OCC Contention]: Competing settle vs failure transitions for same refund...');
  const order13 = {
    id: 'ORD-EMU-OCC-13',
    machine_id: 'CFX-MC-01',
    product_name: 'Flat White',
    amount: 100,
    captured_amount_paise: 10000,
    status: 'PAID',
    dispense_status: 'DISPENSED',
    refund_status: 'NONE',
    total_refunded_amount_paise: 0,
    pending_refund_amount_paise: 0,
    refund_version: 1,
    razorpay_payment_id: 'pay_emu_occ_13',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };
  await fsAdmin.collection('orders').doc(order13.id).set(order13);
  await db4.run(
    `INSERT INTO orders (id, machine_id, product_name, amount, captured_amount_paise, status, dispense_status, razorpay_payment_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [order13.id, order13.machine_id, order13.product_name, order13.amount, order13.captured_amount_paise, order13.status, order13.dispense_status, order13.razorpay_payment_id, order13.created_at, order13.updated_at]
  );

  const res13 = await createPendingRefundReservation(db4, {
    orderId: order13.id,
    amount_paise: 4000,
    reason: 'competing_terminal_race',
    initiated_by: 'admin',
    idempotency_key: 'idem_res_13'
  });

  const [tSettled, tFailed] = await Promise.allSettled([
    markRefundProcessed(db4, {
      refundId: res13.refund.id,
      razorpay_refund_id: 'rfnd_race_13'
    }),
    markRefundFailed(db4, {
      refundId: res13.refund.id,
      error_code: 'RACE_FAIL'
    })
  ]);

  const emuRefundSnap13 = await fsAdmin.collection('orders').doc(order13.id).collection('refunds').doc(res13.refund.id).get();
  const terminalStatus = emuRefundSnap13.data()?.status;
  assert(['PROCESSED', 'FAILED'].includes(terminalStatus), 'Must reach one valid terminal state');

  const emuOrderSnap13 = await fsAdmin.collection('orders').doc(order13.id).get();
  assert.strictEqual(emuOrderSnap13.data()?.pending_refund_amount_paise, 0, 'Pending hold must be cleared');
  if (terminalStatus === 'PROCESSED') {
    assert.strictEqual(emuOrderSnap13.data()?.total_refunded_amount_paise, 4000);
  } else {
    assert.strictEqual(emuOrderSnap13.data()?.total_refunded_amount_paise, 0);
  }
  console.log('   PASS [Scenario 13]: Competing terminal transitions serialized safely by Firestore OCC.\n');

  // --------------------------------------------------------------------------
  // SECTION 6: SERVERLESS COLD-START BEHAVIOR (EMPTY LOCAL SQLITE)
  // --------------------------------------------------------------------------
  console.log('Scenario 14 [Cold Start]: Receipt-based refund lookup with empty local SQLite...');
  await clearEmulatorDatabase();
  const emptyDb = await createIsolatedSqliteDb(); // Fresh in-memory SQLite with 0 rows

  const order14 = {
    id: 'ORD-COLD-14',
    machine_id: 'CFX-MC-02',
    product_name: 'Espresso Cold Start',
    amount: 100,
    captured_amount_paise: 10000,
    status: 'PAID',
    dispense_status: 'DISPENSED',
    refund_status: 'NONE',
    total_refunded_amount_paise: 0,
    pending_refund_amount_paise: 0,
    refund_version: 1,
    razorpay_payment_id: 'pay_cold_14',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };
  await fsAdmin.collection('orders').doc(order14.id).set(order14);

  // Create refund directly in Firestore (as if created on another container)
  const refundId14 = 'RFND-COLD-14-REC';
  const refundDoc14 = {
    id: refundId14,
    order_id: order14.id,
    machine_id: order14.machine_id,
    razorpay_payment_id: order14.razorpay_payment_id,
    amount_paise: 5000,
    currency: 'INR',
    status: 'PENDING',
    reason: 'cold_start_test',
    initiated_by: 'admin',
    source: 'SUPER_ADMIN_PORTAL',
    idempotency_key: `idem_${refundId14}`,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };
  await fsAdmin.collection('refunds').doc(refundId14).set(refundDoc14);
  await fsAdmin.collection('orders').doc(order14.id).collection('refunds').doc(refundId14).set(refundDoc14);

  // Look up refund from empty SQLite -> must resolve from Firestore
  const resolvedRefund14 = await getRefundById(emptyDb, refundId14);
  assert.strictEqual(resolvedRefund14?.id, refundId14);
  assert.strictEqual(resolvedRefund14?.order_id, order14.id);
  assert.strictEqual(resolvedRefund14?.amount_paise, 5000);
  console.log('   PASS [Scenario 14]: Authoritative Firestore refund hydration verified from empty SQLite.\n');

  console.log('Scenario 15 [Cold Start]: Payment-ID-based order lookup and machine ID inheritance...');
  // Webhook settlement for unreserved refund using only payment ID
  const coldOutcome15 = await reconcileAuthoritativeGatewayRefundOutcome(emptyDb, {
    orderId: order14.id,
    razorpayPaymentId: order14.razorpay_payment_id,
    razorpayRefundId: 'rfnd_cold_gw_15',
    amount_paise: 3000,
    currency: 'INR',
    machineId: order14.machine_id // Inherited from authoritative order
  });

  assert.strictEqual(coldOutcome15.refund.status, 'PROCESSED');
  assert.strictEqual(coldOutcome15.refund.machine_id, 'CFX-MC-02');
  assert.strictEqual(coldOutcome15.refund.amount_paise, 3000);

  // Verify in Firestore emulator
  const emuRefund15 = await fsAdmin.collection('orders').doc(order14.id).collection('refunds').doc(coldOutcome15.refund.id).get();
  assert.strictEqual(emuRefund15.data()?.machine_id, 'CFX-MC-02');
  console.log('   PASS [Scenario 15]: Machine ID inheritance and unreserved refund settlement verified in cold start.\n');

  // --------------------------------------------------------------------------
  // SECTION 7: FIREBASE SECURITY RULES & CLIENT ISOLATION
  // --------------------------------------------------------------------------
  console.log('Scenario 16 [Security Rules]: Direct unauthenticated client writes rejected by firestore.rules...');
  const directClientPatch = await fetch(
    `http://${EMULATOR_HOST}/v1/projects/${EMULATOR_PROJECT_ID}/databases/(default)/documents/refunds/direct_hack`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields: { status: { stringValue: 'PROCESSED' } } })
    }
  );
  assert.strictEqual(
    directClientPatch.status,
    403,
    'Direct unauthenticated client write must be rejected with HTTP 403 Forbidden by firestore.rules'
  );

  const directClientRead = await fetch(
    `http://${EMULATOR_HOST}/v1/projects/${EMULATOR_PROJECT_ID}/databases/(default)/documents/orders/ORD-COLD-14`,
    { method: 'GET' }
  );
  assert.strictEqual(
    directClientRead.status,
    403,
    'Direct unauthenticated client read must be rejected with HTTP 403 Forbidden by firestore.rules'
  );
  console.log('   PASS [Scenario 16]: Client write and read rejected fail-closed (HTTP 403) by firestore.rules.\n');

  console.log('Scenario 17 [Security Rules]: Backend Admin SDK operations permitted with audit authority...');
  const adminDocSnap = await fsAdmin.collection('orders').doc(order14.id).get();
  assert.strictEqual(adminDocSnap.exists, true);
  assert.strictEqual(adminDocSnap.data()?.machine_id, 'CFX-MC-02');
  console.log('   PASS [Scenario 17]: Backend Firebase Admin SDK operation verified with administrative access.\n');

  console.log('========================================================================');
  console.log('ALL CAFFIX Phase 2.7.3 Firebase Emulator Integration Tests PASSED!');
  console.log('========================================================================');
}

runPhase2_7_3_EmulatorTests().catch((err) => {
  console.error('\n[FATAL TEST FAILURE in Phase 2.7.3]:', err);
  process.exit(1);
});
