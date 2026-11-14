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
  getAuthoritativeOrderById,
  syncOrderToFirebase
} from '../utils/firebase';
import {
  claimWebhookEvent,
  markWebhookEventProcessed,
  markWebhookEventFailed
} from '../utils/webhookLedger';
import {
  createPendingRefundReservation,
  markRefundProcessed,
  markRefundFailed,
  getRefundById,
  getRefundsByOrderId
} from '../utils/refunds';
import {
  recordInventoryMovement,
  recordOrderDeductionsToLedger,
  getInventoryLedgerForMachine,
  getInventoryLedgerForOrder,
  initializeInventoryLedgerSchema
} from '../utils/inventoryLedger';
import {
  reconcileOrderRecord,
  generateReconciliationReport,
  reconcileSingleOrderById
} from '../services/reconciliationService';

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
  setFirestoreForTesting({ clearStores: true });
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

    CREATE TABLE IF NOT EXISTS products (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      price REAL NOT NULL,
      description TEXT,
      image TEXT
    );

    INSERT OR IGNORE INTO products (id, name, price, description) VALUES
      (1, 'Classic Crest', 100, 'Signature espresso with rich crema'),
      (2, 'Vanilla Velvet', 100, 'Silky milk infused with French vanilla'),
      (3, 'Hazel Gold', 100, 'Roasted hazelnut with double espresso'),
      (4, 'Irish Emerald', 100, 'Traditional Irish cream flavoured blend'),
      (5, 'Mocha Bliss', 100, 'Dark cocoa with velvety steamed milk');

    CREATE TABLE IF NOT EXISTS orders (
      id TEXT PRIMARY KEY,
      machine_id TEXT NOT NULL,
      product_id INTEGER DEFAULT 1,
      product_name TEXT,
      amount REAL NOT NULL,
      captured_amount_paise INTEGER,
      status TEXT NOT NULL,
      dispense_status TEXT DEFAULT 'PENDING',
      dispensed BOOLEAN DEFAULT 0,
      extra_sugar INTEGER DEFAULT 1,
      base TEXT DEFAULT 'water',
      customer_name TEXT,
      customer_email TEXT,
      refund_status TEXT DEFAULT 'NONE',
      total_refunded_amount_paise INTEGER DEFAULT 0,
      pending_refund_amount_paise INTEGER DEFAULT 0,
      last_refunded_at TEXT,
      refund_version INTEGER DEFAULT 0,
      razorpay_order_id TEXT,
      razorpay_payment_id TEXT,
      razorpay_signature TEXT,
      dispense_started_at TEXT,
      dispensed_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT
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
      updated_at TEXT,
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
      updated_at TEXT,
      processed_at TEXT,
      UNIQUE(provider, event_id)
    );

    CREATE TABLE IF NOT EXISTS inventory (
      machine_id TEXT PRIMARY KEY,
      coffee_level REAL DEFAULT 100,
      milk_level REAL DEFAULT 100,
      water_level REAL DEFAULT 100,
      vanilla_level REAL DEFAULT 100,
      hazelnut_level REAL DEFAULT 100,
      irish_level REAL DEFAULT 100,
      mocha_level REAL DEFAULT 100,
      updated_at TEXT
    );
  `);

  await initializeInventoryLedgerSchema(db);
  return db;
}

async function runPhase2_8_ReconciliationTests() {
  console.log('========================================================================');
  console.log('Running CAFFIX Phase 2.8 — Payment, Inventory & Refund Reconciliation Tests');
  console.log(`Target Emulator Host: http://${EMULATOR_HOST}`);
  console.log(`Isolated Project ID: ${EMULATOR_PROJECT_ID}`);
  console.log('========================================================================\n');

  // Verify emulator connection
  try {
    const healthRes = await fetch(`http://${EMULATOR_HOST}/`);
    assert.strictEqual(healthRes.status, 200, 'Emulator must respond on port 8088');
    console.log('PASS: Official Google Cloud Firestore Emulator is live and reachable.');
  } catch (err: any) {
    console.error('FAIL: Emulator is not reachable on port 8088:', err.message);
    process.exit(1);
  }

  // Initialize Admin SDK with emulator
  const existingApps = getApps();
  for (const app of existingApps) {
    await deleteApp(app);
  }
  const app = initializeApp({ projectId: EMULATOR_PROJECT_ID });
  const firestore = getFirestore(app);
  setFirestoreForTesting({ firestoreInstance: firestore });

  let passed = 0;
  let total = 0;

  async function test(name: string, fn: () => Promise<void>) {
    total++;
    process.stdout.write(`Scenario ${total}: ${name} ... `);
    try {
      await clearEmulatorDatabase();
      await fn();
      passed++;
      console.log('PASS');
    } catch (err: any) {
      console.log('FAIL');
      console.error(err);
      throw err;
    }
  }

  // SCENARIO 1: Duplicate payment events idempotency and reconciliation
  await test('Duplicate payment events & idempotency protection', async () => {
    const db = await createIsolatedSqliteDb();
    const orderId = 'ord_dup_payment_01';
    const machineId = 'CFX-MC-01';

    await firestore.collection('machines').doc(machineId).set({
      id: machineId,
      estimated_inventory: {
        coffee_level: 100,
        milk_level: 100,
        water_level: 100,
        vanilla_level: 100,
        hazelnut_level: 100,
        irish_level: 100,
        mocha_level: 100
      }
    });

    await firestore.collection('orders').doc(orderId).set({
      id: orderId,
      machine_id: machineId,
      product_id: 1,
      amount: 100,
      status: 'PENDING',
      dispense_status: 'PENDING',
      created_at: new Date().toISOString()
    });

    const reqs = { coffee: 18, milk: 150, water: 50, vanilla: 0, hazelnut: 0, irish: 0, mocha: 0 };

    // First payment arrival
    const res1 = await commitOrderTransitionInFirebase({
      order: { id: orderId, machine_id: machineId, amount: 100 },
      targetStatus: 'PAID',
      razorpayPaymentId: 'pay_first_123',
      capturedAmountPaise: 10000,
      requirements: reqs
    });

    assert.strictEqual(res1?.didTransition, true);
    assert.strictEqual(res1?.didDeductInventory, true);

    // Duplicate payment arrival (same payment ID)
    const res2 = await commitOrderTransitionInFirebase({
      order: { id: orderId, machine_id: machineId, amount: 100 },
      targetStatus: 'PAID',
      razorpayPaymentId: 'pay_first_123',
      capturedAmountPaise: 10000,
      requirements: reqs
    });

    assert.strictEqual(res2?.didTransition, false);
    assert.strictEqual(res2?.alreadyProcessed, true);
    assert.strictEqual(res2?.didDeductInventory, false);

    // Verify machine stock was deducted ONCE (100 - 18 = 82)
    const machineSnap = await firestore.collection('machines').doc(machineId).get();
    const inv = machineSnap.data()?.estimated_inventory;
    assert.strictEqual(inv.coffee_level, 82);

    // Verify ledger has exactly 1 deduction for coffee
    const ledgerSnap = await firestore
      .collection('machines')
      .doc(machineId)
      .collection('inventory_ledger')
      .where('order_id', '==', orderId)
      .where('ingredient', '==', 'coffee')
      .get();
    assert.strictEqual(ledgerSnap.size, 1);

    // Verify reconciliation result is MATCH
    const orderSnap = await firestore.collection('orders').doc(orderId).get();
    const rec = reconcileOrderRecord(orderSnap.data(), {
      refunds: [],
      inventoryMovements: ledgerSnap.docs.map(d => d.data() as any)
    });
    assert.strictEqual(rec.reconciliation_result, 'MATCH');
    assert.strictEqual(rec.discrepancy_reason, 'NONE');
  });

  // SCENARIO 2: Delayed payment events reconciliation
  await test('Delayed payment events identification (UNVERIFIED_GATEWAY_PAYMENT)', async () => {
    const orderId = 'ord_delayed_pay_02';
    const machineId = 'CFX-MC-01';

    const orderData = {
      id: orderId,
      machine_id: machineId,
      amount: 100,
      status: 'PENDING',
      dispense_status: 'PENDING',
      created_at: new Date().toISOString()
    };

    // Reconcile order with gateway evidence showing confirmed payment
    const rec = reconcileOrderRecord(orderData, {
      refunds: [],
      inventoryMovements: [],
      options: {
        gatewayEvidence: {
          order_id: 'order_rp_delayed_1',
          payment_id: 'pay_captured_live_999',
          amount_paise: 10000,
          status: 'captured'
        }
      }
    });

    assert.strictEqual(rec.reconciliation_result, 'DISCREPANCY');
    assert.strictEqual(rec.discrepancy_reason, 'UNVERIFIED_GATEWAY_PAYMENT');
    assert.strictEqual(rec.recommended_action, 'VERIFY_GATEWAY_AND_SYNC_PAID');
  });

  // SCENARIO 3: Payment amount mismatches
  await test('Payment amount mismatches detection (PAYMENT_AMOUNT_MISMATCH)', async () => {
    const orderId = 'ord_mismatch_pay_03';
    const machineId = 'CFX-MC-02';

    // Order created for ₹100 (10000 paise), but gateway captured 5000 paise (₹50)
    const orderData = {
      id: orderId,
      machine_id: machineId,
      amount: 100,
      captured_amount_paise: 5000,
      razorpay_payment_id: 'pay_short_5000',
      status: 'PAID',
      dispense_status: 'QUEUED',
      created_at: new Date().toISOString()
    };

    const rec = reconcileOrderRecord(orderData, {
      refunds: [],
      inventoryMovements: [
        {
          id: 'inv_1',
          machine_id: machineId,
          ingredient: 'coffee',
          quantity: 18,
          movement_type: 'DEDUCTION',
          balance_after: 82,
          created_at: new Date().toISOString()
        }
      ]
    });

    assert.strictEqual(rec.reconciliation_result, 'DISCREPANCY');
    assert.strictEqual(rec.discrepancy_reason, 'PAYMENT_AMOUNT_MISMATCH');
    assert.strictEqual(rec.recommended_action, 'MANUAL_REVIEW_FINANCES');
  });

  // SCENARIO 4: Failed dispensing with captured payment but unrefunded
  await test('Failed dispensing unrefunded detection (DISPENSE_FAILED_UNREFUNDED)', async () => {
    const orderId = 'ord_failed_disp_04';
    const machineId = 'CFX-MC-01';

    const orderData = {
      id: orderId,
      machine_id: machineId,
      amount: 100,
      captured_amount_paise: 10000,
      razorpay_payment_id: 'pay_captured_ok_44',
      status: 'FAILED',
      dispense_status: 'FAILED',
      refund_status: 'NONE',
      total_refunded_amount_paise: 0,
      pending_refund_amount_paise: 0,
      created_at: new Date().toISOString()
    };

    const rec = reconcileOrderRecord(orderData, {
      refunds: [],
      inventoryMovements: []
    });

    assert.strictEqual(rec.reconciliation_result, 'DISCREPANCY');
    assert.strictEqual(rec.discrepancy_reason, 'DISPENSE_FAILED_UNREFUNDED');
    assert.strictEqual(rec.recommended_action, 'INITIATE_REFUND');
  });

  // SCENARIO 5: Uncertain dispensing outcome
  await test('Uncertain dispensing outcome detection (UNCERTAIN_DISPENSE_OUTCOME)', async () => {
    const orderId = 'ord_uncertain_05';
    const machineId = 'CFX-MC-01';

    // Status COMPLETED but dispense_status is PENDING
    const orderData = {
      id: orderId,
      machine_id: machineId,
      amount: 100,
      captured_amount_paise: 10000,
      razorpay_payment_id: 'pay_ok_55',
      status: 'COMPLETED',
      dispense_status: 'PENDING',
      created_at: new Date().toISOString()
    };

    const rec = reconcileOrderRecord(orderData, {
      refunds: [],
      inventoryMovements: [
        {
          id: 'inv_2',
          machine_id: machineId,
          ingredient: 'coffee',
          quantity: 18,
          movement_type: 'DEDUCTION',
          balance_after: 82,
          created_at: new Date().toISOString()
        }
      ]
    });

    assert.strictEqual(rec.reconciliation_result, 'DISCREPANCY');
    assert.strictEqual(rec.discrepancy_reason, 'UNCERTAIN_DISPENSE_OUTCOME');
    assert.strictEqual(rec.recommended_action, 'INVESTIGATE_HARDWARE_DISPENSE');
  });

  // SCENARIO 6: Duplicate inventory deductions prevention & audit
  await test('Duplicate inventory deductions prevention & audit (INVENTORY_DEDUCTION_DUPLICATED)', async () => {
    const db = await createIsolatedSqliteDb();
    const orderId = 'ord_inv_deduct_06';
    const machineId = 'CFX-MC-03';

    // Record deduction
    await recordInventoryMovement(db, {
      machine_id: machineId,
      ingredient: 'coffee',
      quantity: 18,
      movement_type: 'DEDUCTION',
      balance_after: 82,
      order_id: orderId,
      idempotency_key: `order_${orderId}_deduct_coffee`
    });

    // Attempt second deduction with identical idempotency key -> returns existing record without inserting duplicate
    const secondTry = await recordInventoryMovement(db, {
      machine_id: machineId,
      ingredient: 'coffee',
      quantity: 18,
      movement_type: 'DEDUCTION',
      balance_after: 64,
      order_id: orderId,
      idempotency_key: `order_${orderId}_deduct_coffee`
    });

    const entries = await getInventoryLedgerForOrder(db, orderId);
    assert.strictEqual(entries.length, 1, 'Idempotency key must strictly prevent duplicate rows');
    assert.strictEqual(secondTry.balance_after, 82, 'Returns original record balance');

    // If duplicate movement manually exists, reconciliation flags INVENTORY_DEDUCTION_DUPLICATED
    const duplicatedMovements = [
      { id: '1', machine_id: machineId, ingredient: 'coffee', quantity: 18, movement_type: 'DEDUCTION' as const, balance_after: 82, created_at: new Date().toISOString() },
      { id: '2', machine_id: machineId, ingredient: 'coffee', quantity: 18, movement_type: 'DEDUCTION' as const, balance_after: 64, created_at: new Date().toISOString() }
    ];

    const rec = reconcileOrderRecord({
      id: orderId,
      machine_id: machineId,
      status: 'PAID',
      dispense_status: 'QUEUED',
      amount: 100,
      captured_amount_paise: 10000,
      razorpay_payment_id: 'pay_ok_06',
      created_at: new Date().toISOString()
    }, {
      refunds: [],
      inventoryMovements: duplicatedMovements
    });

    assert.strictEqual(rec.reconciliation_result, 'DISCREPANCY');
    assert.strictEqual(rec.discrepancy_reason, 'INVENTORY_DEDUCTION_DUPLICATED');
    assert.strictEqual(rec.recommended_action, 'FLAG_DATA_CORRUPTION');
  });

  // SCENARIO 7: Partial refunds reconciliation
  await test('Partial refunds reconciliation & balance tracking', async () => {
    const db = await createIsolatedSqliteDb();
    const orderId = 'ord_partial_ref_07';
    const machineId = 'CFX-MC-01';

    await firestore.collection('orders').doc(orderId).set({
      id: orderId,
      machine_id: machineId,
      product_id: 1,
      amount: 100,
      captured_amount_paise: 10000,
      razorpay_payment_id: 'pay_part_77',
      status: 'PAID',
      dispense_status: 'QUEUED',
      refund_status: 'PARTIAL',
      total_refunded_amount_paise: 4000,
      pending_refund_amount_paise: 0,
      created_at: new Date().toISOString()
    });

    // Create partial refund record in refunds collection
    const refundDoc = {
      id: 'ref_part_001',
      order_id: orderId,
      machine_id: machineId,
      amount_paise: 4000,
      status: 'PROCESSED',
      razorpay_payment_id: 'pay_part_77',
      idempotency_key: 'idem_part_001',
      created_at: new Date().toISOString()
    };
    await firestore.collection('orders').doc(orderId).collection('refunds').doc('ref_part_001').set(refundDoc);
    await firestore.collection('refunds').doc('ref_part_001').set(refundDoc);

    const rec = reconcileOrderRecord({
      id: orderId,
      machine_id: machineId,
      amount: 100,
      captured_amount_paise: 10000,
      razorpay_payment_id: 'pay_part_77',
      status: 'PAID',
      dispense_status: 'QUEUED',
      refund_status: 'PARTIAL',
      total_refunded_amount_paise: 4000,
      pending_refund_amount_paise: 0,
      created_at: new Date().toISOString()
    }, {
      refunds: [refundDoc],
      inventoryMovements: [
        {
          id: 'inv_7',
          machine_id: machineId,
          ingredient: 'coffee',
          quantity: 18,
          movement_type: 'DEDUCTION',
          balance_after: 82,
          created_at: new Date().toISOString()
        }
      ]
    });

    assert.strictEqual(rec.reconciliation_result, 'MATCH');
    assert.strictEqual(rec.total_refunded_paise, 4000);
    assert.strictEqual(rec.captured_amount_paise, 10000);
  });

  // SCENARIO 8: Full refunds reconciliation and dispensing guard
  await test('Full refunds reconciliation & dispensing safety guard', async () => {
    const orderId = 'ord_full_ref_08';
    const machineId = 'CFX-MC-01';

    await firestore.collection('orders').doc(orderId).set({
      id: orderId,
      machine_id: machineId,
      product_id: 1,
      amount: 100,
      captured_amount_paise: 10000,
      razorpay_payment_id: 'pay_full_88',
      status: 'PAID',
      dispense_status: 'QUEUED',
      refund_status: 'FULL',
      total_refunded_amount_paise: 10000,
      pending_refund_amount_paise: 0,
      created_at: new Date().toISOString()
    });

    // Verify commitOrderTransitionInFirebase strictly rejects transition to PREPARING or DISPENSING
    const attemptDispense = await commitOrderTransitionInFirebase({
      order: { id: orderId, machine_id: machineId, status: 'PAID', refund_status: 'FULL' },
      targetStatus: 'PREPARING'
    });

    assert.strictEqual(attemptDispense?.didTransition, false);
    assert.strictEqual(attemptDispense?.rejectedByStateGuard, true);

    const refundDoc = {
      id: 'ref_full_001',
      order_id: orderId,
      machine_id: machineId,
      amount_paise: 10000,
      status: 'PROCESSED',
      created_at: new Date().toISOString()
    };

    const rec = reconcileOrderRecord({
      id: orderId,
      machine_id: machineId,
      amount: 100,
      captured_amount_paise: 10000,
      razorpay_payment_id: 'pay_full_88',
      status: 'PAID',
      dispense_status: 'QUEUED',
      refund_status: 'FULL',
      total_refunded_amount_paise: 10000,
      pending_refund_amount_paise: 0,
      created_at: new Date().toISOString()
    }, {
      refunds: [refundDoc],
      inventoryMovements: [
        {
          id: 'inv_8',
          machine_id: machineId,
          ingredient: 'coffee',
          quantity: 18,
          movement_type: 'DEDUCTION',
          balance_after: 82,
          created_at: new Date().toISOString()
        }
      ]
    });

    assert.strictEqual(rec.reconciliation_result, 'MATCH');
    assert.strictEqual(rec.total_refunded_paise, 10000);
  });

  // SCENARIO 9: Concurrent reconciliation queries
  await test('Concurrent reconciliation queries with zero race conditions', async () => {
    const db = await createIsolatedSqliteDb();
    const machineId = 'CFX-MC-01';

    // Seed 10 orders in Firestore
    for (let i = 1; i <= 10; i++) {
      const oid = `ord_concurrent_${i}`;
      await firestore.collection('orders').doc(oid).set({
        id: oid,
        machine_id: machineId,
        product_id: 1,
        amount: 100,
        captured_amount_paise: 10000,
        razorpay_payment_id: `pay_c_${i}`,
        status: 'PAID',
        dispense_status: 'DISPENSED',
        refund_status: 'NONE',
        total_refunded_amount_paise: 0,
        pending_refund_amount_paise: 0,
        created_at: new Date().toISOString()
      });
      await recordInventoryMovement(db, {
        machine_id: machineId,
        ingredient: 'coffee',
        quantity: 18,
        movement_type: 'DEDUCTION',
        balance_after: 100 - i * 5,
        order_id: oid,
        idempotency_key: `order_${oid}_deduct_coffee`
      });
    }

    // Run 10 parallel reconciliation report queries
    const promises = Array.from({ length: 10 }).map(() =>
      generateReconciliationReport(db, { machineIds: [machineId] })
    );

    const reports = await Promise.all(promises);
    for (const rep of reports) {
      assert.strictEqual(rep.status, 'success');
      assert.strictEqual(rep.summary.total_orders, 10);
      assert.strictEqual(rep.summary.financial_summary.total_captured_paise, 100000);
    }
  });

  // SCENARIO 10: Machine isolation between owners
  await test('Machine isolation enforcement for Owner reports', async () => {
    const db = await createIsolatedSqliteDb();

    // Machine 1 owned by Owner A
    await firestore.collection('machines').doc('CFX-MC-01').set({
      id: 'CFX-MC-01',
      owner_id: 'usr_owner_a',
      machine_name: 'Machine A'
    });
    // Machine 2 owned by Owner B
    await firestore.collection('machines').doc('CFX-MC-02').set({
      id: 'CFX-MC-02',
      owner_id: 'usr_owner_b',
      machine_name: 'Machine B'
    });

    await firestore.collection('orders').doc('ord_a1').set({
      id: 'ord_a1',
      machine_id: 'CFX-MC-01',
      product_id: 1,
      amount: 100,
      status: 'PAID',
      dispense_status: 'DISPENSED',
      captured_amount_paise: 10000,
      razorpay_payment_id: 'pay_a1',
      created_at: new Date().toISOString()
    });

    await firestore.collection('orders').doc('ord_b1').set({
      id: 'ord_b1',
      machine_id: 'CFX-MC-02',
      product_id: 1,
      amount: 100,
      status: 'PAID',
      dispense_status: 'DISPENSED',
      captured_amount_paise: 10000,
      razorpay_payment_id: 'pay_b1',
      created_at: new Date().toISOString()
    });

    // Owner A generates report scoped to CFX-MC-01
    const reportA = await generateReconciliationReport(db, { machineIds: ['CFX-MC-01'] });
    assert.strictEqual(reportA.summary.total_orders, 1);
    assert.strictEqual(reportA.data[0].machine_id, 'CFX-MC-01');
    assert.strictEqual(reportA.data.some(d => d.machine_id === 'CFX-MC-02'), false);

    // Fleet-wide (Super Admin) report
    const reportAdmin = await generateReconciliationReport(db);
    assert.strictEqual(reportAdmin.summary.total_orders, 2);
  });

  // SCENARIO 11: Firestore transaction conflicts resolution
  await test('Firestore transaction conflicts resolution under concurrent load', async () => {
    const db = await createIsolatedSqliteDb();
    const orderId = 'ord_tx_conflict_11';
    const machineId = 'CFX-MC-01';

    await firestore.collection('machines').doc(machineId).set({
      id: machineId,
      estimated_inventory: {
        coffee_level: 100,
        milk_level: 100,
        water_level: 100,
        vanilla_level: 100,
        hazelnut_level: 100,
        irish_level: 100,
        mocha_level: 100
      }
    });

    await firestore.collection('orders').doc(orderId).set({
      id: orderId,
      machine_id: machineId,
      product_id: 1,
      amount: 100,
      status: 'PENDING',
      dispense_status: 'PENDING',
      created_at: new Date().toISOString()
    });

    const reqs = { coffee: 18, milk: 150, water: 50, vanilla: 0, hazelnut: 0, irish: 0, mocha: 0 };

    // Concurrently trigger transition from 5 parallel promises
    const parallelTransitions = await Promise.all(
      Array.from({ length: 5 }).map((_, i) =>
        commitOrderTransitionInFirebase({
          order: { id: orderId, machine_id: machineId, amount: 100 },
          targetStatus: 'PAID',
          razorpayPaymentId: `pay_tx_${i}`,
          capturedAmountPaise: 10000,
          requirements: reqs
        })
      )
    );

    // Exactly one must have transitioned
    const transitionedCount = parallelTransitions.filter(r => r?.didTransition).length;
    assert.strictEqual(transitionedCount, 1, 'Exactly one transaction must succeed with didTransition=true');

    // Exactly one deduction must have occurred on machine stock
    const machineSnap = await firestore.collection('machines').doc(machineId).get();
    assert.strictEqual(machineSnap.data()?.estimated_inventory.coffee_level, 82);
  });

  // SCENARIO 12: Serverless cold-start recovery
  await test('Serverless cold-start recovery directly from emulator', async () => {
    // Create order and ledger exclusively in Firestore emulator (simulating prior instance write)
    const orderId = 'ord_cold_start_12';
    const machineId = 'CFX-MC-04';

    await firestore.collection('orders').doc(orderId).set({
      id: orderId,
      machine_id: machineId,
      product_id: 1,
      amount: 100,
      captured_amount_paise: 10000,
      razorpay_payment_id: 'pay_cold_12',
      status: 'PAID',
      dispense_status: 'DISPENSED',
      refund_status: 'NONE',
      total_refunded_amount_paise: 0,
      pending_refund_amount_paise: 0,
      created_at: new Date().toISOString()
    });

    await firestore.collection('inventory_ledger').doc(`inv_mov_${orderId}_coffee`).set({
      id: `inv_mov_${orderId}_coffee`,
      machine_id: machineId,
      ingredient: 'coffee',
      quantity: 18,
      movement_type: 'DEDUCTION',
      balance_after: 82,
      order_id: orderId,
      created_at: new Date().toISOString()
    });

    // In a new fresh cold SQLite instance with empty memory
    const coldDb = await createIsolatedSqliteDb();

    // Authoritative lookup fetches directly from Firestore emulator
    const reconciledItem = await reconcileSingleOrderById(coldDb, orderId);
    assert.ok(reconciledItem, 'Reconciled item must not be null');
    assert.strictEqual(reconciledItem?.order_id, orderId);
    assert.strictEqual(reconciledItem?.machine_id, machineId);
    assert.strictEqual(reconciledItem?.reconciliation_result, 'MATCH');
    assert.strictEqual(reconciledItem?.inventory_movement_status, 'RECORDED');
  });

  // SCENARIO 15 (H-1): Empty machineIds scope MUST fail-closed to 'NONE' (never leak fleet)
  await test('H-1 Empty machineIds array scopes reconciliation report to NONE (no fleet leakage)', async () => {
    const db = await createIsolatedSqliteDb();
    const orderId = 'ord_h1_scope_01';

    await db.run(
      `INSERT INTO orders (id, machine_id, product_id, amount, captured_amount_paise, status, dispense_status, refund_status, total_refunded_amount_paise, pending_refund_amount_paise, created_at)
       VALUES (?, 'CFX-MC-02', 1, 120, 12000, 'PAID', 'DISPENSED', 'NONE', 0, 0, ?)`,
      [orderId, new Date().toISOString()]
    );
    await firestore.collection('orders').doc(orderId).set({
      id: orderId,
      machine_id: 'CFX-MC-02',
      amount: 120,
      captured_amount_paise: 12000,
      status: 'PAID',
      dispense_status: 'DISPENSED',
      refund_status: 'NONE',
      total_refunded_amount_paise: 0,
      pending_refund_amount_paise: 0,
      created_at: new Date().toISOString()
    });

    // Owner with 0 assigned machines passes []
    const noneReport = await generateReconciliationReport(db, { machineIds: [] });
    assert.strictEqual(noneReport.machine_scope, 'NONE', 'Empty machineIds must report machine_scope NONE');
    assert.strictEqual(noneReport.summary.total_orders, 0, 'Empty machineIds must return 0 orders');
    assert.strictEqual(noneReport.summary.financial_summary.total_captured_paise, 0, 'Empty machineIds must return 0 paise');
    assert.strictEqual(noneReport.data.length, 0, 'Empty machineIds must return empty data array');

    // Super Admin unrestricted passes undefined
    const fleetReport = await generateReconciliationReport(db, { machineIds: undefined });
    assert.strictEqual(fleetReport.machine_scope, 'FLEET_WIDE', 'Undefined machineIds must report FLEET_WIDE');
    assert.strictEqual(fleetReport.summary.total_orders, 1, 'Super Admin FLEET must see the seeded order');
    assert.strictEqual(fleetReport.data[0].order_id, orderId);
  });

  console.log(`\n========================================================================`);
  console.log(`Phase 2.8 Test Suite Completed: ${passed}/${total} Scenarios Passed (100%)`);
  console.log(`========================================================================\n`);
}

runPhase2_8_ReconciliationTests().catch((err) => {
  console.error('Test Suite Failed:', err);
  process.exit(1);
});
