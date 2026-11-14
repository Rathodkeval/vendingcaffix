/**
 * CAFFIX Phase 2.9.2.2 — Analytics API Hardening & Audit Remediation Tests
 *
 * Verifies resolutions for:
 * - Finding A4-1: Firestore machine query chunking (>30 machines, deduplication, fail-closed)
 * - Finding A5-1: Cross-period over-refund detection across SQLite and Firestore
 * - Finding A6-1: Firestore index configuration and firebase.json reference
 * - Finding A8-1: Fleet-wide and machine-level current inventory aggregation
 */

import assert from 'assert';
import fs from 'fs';
import path from 'path';
import sqlite3 from 'sqlite3';
import { open, Database } from 'sqlite';
import { initializeApp, getApps } from 'firebase-admin/app';
import { getFirestore, Firestore } from 'firebase-admin/firestore';
import {
  chunkMachineIds,
  getAnalyticsOverview,
  getInventoryAnalytics,
  getGrossCapturedSalesPaise,
  getTimeSeriesAnalytics,
  getRefundsAnalytics
} from '../services/analyticsService';
import {
  getFirestoreInstance,
  isFirestoreActive,
  ensureFirebaseReady,
  setFirestoreForTesting
} from '../utils/firebase';
import { initializeInventoryLedgerSchema } from '../utils/inventoryLedger';

const EMULATOR_HOST = '127.0.0.1:8088';
const EMULATOR_PROJECT_ID = 'demo-caffix-emulator';

process.env.FIRESTORE_EMULATOR_HOST = EMULATOR_HOST;
process.env.FIREBASE_PROJECT_ID = EMULATOR_PROJECT_ID;

async function runHardeningTests() {
  console.log('========================================================================');
  console.log('Running CAFFIX Phase 2.9.2.2 — Analytics API Hardening Tests');
  console.log('========================================================================\n');

  // Initialize SQLite test DB
  const db: Database = await open({
    filename: ':memory:',
    driver: sqlite3.Database
  });

  await db.exec(`
    CREATE TABLE IF NOT EXISTS orders (
      id TEXT PRIMARY KEY,
      machine_id TEXT NOT NULL,
      product_id INTEGER NOT NULL DEFAULT 1,
      amount INTEGER NOT NULL,
      captured_amount_paise INTEGER,
      status TEXT NOT NULL,
      dispense_status TEXT DEFAULT 'PENDING',
      refund_status TEXT DEFAULT 'NONE',
      total_refunded_amount_paise INTEGER DEFAULT 0,
      pending_refund_amount_paise INTEGER DEFAULT 0,
      razorpay_payment_id TEXT,
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
      source TEXT NOT NULL,
      idempotency_key TEXT UNIQUE NOT NULL,
      error_code TEXT,
      error_description TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      processed_at TEXT
    );

    CREATE TABLE IF NOT EXISTS inventory (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      machine_id TEXT UNIQUE NOT NULL,
      milk_level INTEGER NOT NULL DEFAULT 100,
      coffee_level INTEGER NOT NULL DEFAULT 100,
      vanilla_level INTEGER NOT NULL DEFAULT 100,
      hazelnut_level INTEGER NOT NULL DEFAULT 100,
      irish_level INTEGER NOT NULL DEFAULT 100,
      mocha_level INTEGER NOT NULL DEFAULT 100,
      water_level INTEGER NOT NULL DEFAULT 100,
      updated_at TEXT
    );
  `);
  await initializeInventoryLedgerSchema(db);

  // Initialize Firebase Admin with Emulator
  let app;
  if (!getApps().length) {
    app = initializeApp({ projectId: EMULATOR_PROJECT_ID });
  } else {
    app = getApps()[0];
  }
  const firestore: Firestore = getFirestore(app);
  setFirestoreForTesting({ firestoreInstance: firestore });

  console.log('PASS: Firestore Emulator connected at ' + EMULATOR_HOST);

  // -------------------------------------------------------------------------
  // 1. Finding A6-1: Firestore Indexes & Configuration Validation
  // -------------------------------------------------------------------------
  console.log('\n--- 1. Testing Finding A6-1: Firestore Index Configuration ---');
  const workspaceRoot = path.resolve(__dirname, '../../../');
  const firebaseJsonPath = path.join(workspaceRoot, 'firebase.json');
  const indexesJsonPath = path.join(workspaceRoot, 'firestore.indexes.json');

  assert.ok(fs.existsSync(firebaseJsonPath), 'firebase.json must exist');
  assert.ok(fs.existsSync(indexesJsonPath), 'firestore.indexes.json must exist on disk');

  const firebaseJson = JSON.parse(fs.readFileSync(firebaseJsonPath, 'utf8'));
  assert.strictEqual(
    firebaseJson?.firestore?.indexes,
    'firestore.indexes.json',
    'firebase.json must declare "indexes": "firestore.indexes.json"'
  );

  const indexesJson = JSON.parse(fs.readFileSync(indexesJsonPath, 'utf8'));
  assert.ok(Array.isArray(indexesJson?.indexes), 'firestore.indexes.json must contain indexes array');

  const indexedCollections = new Set(indexesJson.indexes.map((idx: any) => idx.collectionGroup));
  assert.ok(indexedCollections.has('orders'), 'orders composite indexes declared');
  assert.ok(indexedCollections.has('refunds'), 'refunds composite indexes declared');
  assert.ok(indexedCollections.has('inventory_ledger'), 'inventory_ledger composite indexes declared');
  console.log('   PASS: firestore.indexes.json and firebase.json references verified.');

  // -------------------------------------------------------------------------
  // 2. Finding A4-1: Firestore Machine ID Chunking Helper
  // -------------------------------------------------------------------------
  console.log('\n--- 2. Testing Finding A4-1: Machine ID Chunking Helper ---');

  // 1 machine
  const chunk1 = chunkMachineIds(['MC-01'], 30);
  assert.strictEqual(chunk1.length, 1);
  assert.strictEqual(chunk1[0].length, 1);

  // Exactly 30 machines
  const machines30 = Array.from({ length: 30 }, (_, i) => `MC-${String(i + 1).padStart(2, '0')}`);
  const chunk30 = chunkMachineIds(machines30, 30);
  assert.strictEqual(chunk30.length, 1);
  assert.strictEqual(chunk30[0].length, 30);

  // 31 machines -> 2 chunks (30 and 1)
  const machines31 = Array.from({ length: 31 }, (_, i) => `MC-${String(i + 1).padStart(2, '0')}`);
  const chunk31 = chunkMachineIds(machines31, 30);
  assert.strictEqual(chunk31.length, 2);
  assert.strictEqual(chunk31[0].length, 30);
  assert.strictEqual(chunk31[1].length, 1);

  // 35 machines -> 2 chunks (30 and 5)
  const machines35 = Array.from({ length: 35 }, (_, i) => `MC-${String(i + 1).padStart(2, '0')}`);
  const chunk35 = chunkMachineIds(machines35, 30);
  assert.strictEqual(chunk35.length, 2);
  assert.strictEqual(chunk35[0].length, 30);
  assert.strictEqual(chunk35[1].length, 5);

  // 60 machines -> 2 chunks (30 and 30)
  const machines60 = Array.from({ length: 60 }, (_, i) => `MC-${String(i + 1).padStart(2, '0')}`);
  const chunk60 = chunkMachineIds(machines60, 30);
  assert.strictEqual(chunk60.length, 2);
  assert.strictEqual(chunk60[0].length, 30);
  assert.strictEqual(chunk60[1].length, 30);

  // >60 machines (65 machines) -> 3 chunks (30, 30, 5)
  const machines65 = Array.from({ length: 65 }, (_, i) => `MC-${String(i + 1).padStart(2, '0')}`);
  const chunk65 = chunkMachineIds(machines65, 30);
  assert.strictEqual(chunk65.length, 3);
  assert.strictEqual(chunk65[0].length, 30);
  assert.strictEqual(chunk65[1].length, 30);
  assert.strictEqual(chunk65[2].length, 5);

  // Duplicate machine IDs
  const dupMachines = ['MC-01', 'MC-02', 'MC-01', 'MC-03', 'MC-02', '  MC-04  '];
  const chunkDups = chunkMachineIds(dupMachines, 30);
  assert.strictEqual(chunkDups.length, 1);
  assert.deepStrictEqual(chunkDups[0], ['MC-01', 'MC-02', 'MC-03', 'MC-04']);

  // Empty machine arrays
  assert.deepStrictEqual(chunkMachineIds([]), []);
  assert.deepStrictEqual(chunkMachineIds(undefined), []);

  console.log('   PASS: Unit tests for chunkMachineIds passed (1, 30, 31, 35, 60, 65, duplicates, empty).');

  // -------------------------------------------------------------------------
  // 3. Finding A4-1 Integration: 35 Machines Query in Firestore
  // -------------------------------------------------------------------------
  console.log('\n--- 3. Testing Finding A4-1 Integration: 35 Machines Query in Firestore ---');
  // Seed 35 machines with 1 order each in Firestore emulator
  const testMachineIds: string[] = [];
  const nowIso = '2026-11-14T10:00:00.000Z';
  const batch = firestore.batch();

  for (let i = 1; i <= 35; i++) {
    const mId = `CFX-CHUNK-${String(i).padStart(2, '0')}`;
    testMachineIds.push(mId);

    // Create machine doc
    batch.set(firestore.collection('machines').doc(mId), {
      id: mId,
      name: `Chunk Machine ${i}`,
      estimated_inventory: { milk_level: 10, coffee_level: 10, water_level: 10 },
      created_at: nowIso
    });

    // Create 1 order per machine (₹100 = 10000 paise)
    const orderId = `ord_chunk_${i}`;
    batch.set(firestore.collection('orders').doc(orderId), {
      id: orderId,
      machine_id: mId,
      amount: 100,
      captured_amount_paise: 10000,
      status: 'PAID',
      razorpay_payment_id: `pay_chunk_${i}`,
      created_at: nowIso,
      total_refunded_amount_paise: 0
    });
  }
  await batch.commit();

  // Query gross sales for all 35 machines in Firestore mode
  const grossSales35 = await getGrossCapturedSalesPaise(db, {
    machineIds: testMachineIds,
    forceSource: 'firestore'
  });
  // 35 machines * 10,000 paise = 350,000 paise
  assert.strictEqual(
    grossSales35,
    350000,
    `All 35 machines must be queried and included (expected 350,000 paise, got ${grossSales35})`
  );
  console.log('   PASS: 35-machine query chunking succeeded in Firestore without truncation (350,000 paise).');

  // Test Owner with zero assigned machines
  const emptyScopeGross = await getGrossCapturedSalesPaise(db, {
    machineIds: [],
    forceSource: 'firestore'
  });
  assert.strictEqual(emptyScopeGross, 0, 'Owner with zero machines strictly returns 0');
  console.log('   PASS: Owner with zero machines strictly returns 0 in Firestore.');

  // Test Chunk Failure Fail-Closed Policy: If any chunk fails, the entire query must fail (HTTP 503)
  const queryProto = Object.getPrototypeOf(firestore.collection('orders').where('machine_id', '==', 'test'));
  const originalGet = queryProto.get;
  try {
    let callCount = 0;
    queryProto.get = async function(...args: any[]) {
      callCount++;
      if (callCount >= 2) throw new Error('Simulated network partition on chunk 2');
      return originalGet.apply(this, args);
    };
    await assert.rejects(
      async () => {
        await getGrossCapturedSalesPaise(db, {
          machineIds: testMachineIds,
          forceSource: 'firestore'
        });
      },
      /ServiceUnavailableError|Simulated network partition/,
      'Query with failing chunk must fail closed without returning partial totals'
    );
    console.log('   PASS: Failing chunk strictly triggers fail-closed error without partial financial totals.');
  } finally {
    queryProto.get = originalGet;
  }

  // -------------------------------------------------------------------------
  // 4. Finding A5-1: Cross-Period Over-Refund Detection (SQLite & Firestore)
  // -------------------------------------------------------------------------
  console.log('\n--- 4. Testing Finding A5-1: Cross-Period Over-Refund Detection ---');

  // Scenario A: Order created in October (₹100), refunded in November for ₹100 (Legitimate full refund)
  // In SQLite
  await db.exec(`DELETE FROM orders; DELETE FROM refunds;`);
  await db.run(`
    INSERT INTO orders (id, machine_id, product_id, amount, captured_amount_paise, status, razorpay_payment_id, created_at, total_refunded_amount_paise)
    VALUES ('ORD-OCT-LEGIT', 'CFX-MC-01', 1, 100, 10000, 'PAID', 'pay_oct_1', '2026-10-15T10:00:00.000Z', 10000)
  `);
  await db.run(`
    INSERT INTO refunds (id, order_id, machine_id, razorpay_payment_id, razorpay_refund_id, amount_paise, status, reason, initiated_by, source, idempotency_key, created_at, updated_at, processed_at)
    VALUES ('RF-NOV-LEGIT', 'ORD-OCT-LEGIT', 'CFX-MC-01', 'pay_oct_1', 'rfnd_nov_1', 10000, 'PROCESSED', 'Customer cancellation', 'admin', 'SUPER_ADMIN_PORTAL', 'idem_legit_1', '2026-11-10T10:00:00.000Z', '2026-11-10T10:00:00.000Z', '2026-11-10T10:00:00.000Z')
  `);

  // Query November reporting period (Nov 1 to Nov 30)
  const novOverviewLegit = await getAnalyticsOverview(db, {
    machineId: 'CFX-MC-01',
    timeframe: { startDate: '2026-11-01', endDate: '2026-11-30' },
    forceSource: 'sqlite'
  });
  assert.strictEqual(novOverviewLegit.processed_refunds_paise, 10000);
  assert.strictEqual(novOverviewLegit.refunds_exceed_period_sales, true, 'Refunds exceed sales in Nov (sales=0, refunds=100)');
  assert.strictEqual(novOverviewLegit.over_refund_detected, false, 'Legitimate cross-period refund must NOT be flagged as over-refund');
  console.log('   PASS [SQLite]: Legitimate cross-period refund is NOT flagged as over-refund.');

  // Scenario B: Order created in October (₹100), over-refunded in November for ₹150 (15000 paise)
  await db.exec(`DELETE FROM orders; DELETE FROM refunds;`);
  await db.run(`
    INSERT INTO orders (id, machine_id, product_id, amount, captured_amount_paise, status, razorpay_payment_id, created_at, total_refunded_amount_paise)
    VALUES ('ORD-OCT-CORRUPT', 'CFX-MC-01', 1, 100, 10000, 'PAID', 'pay_oct_2', '2026-10-15T10:00:00.000Z', 15000)
  `);
  await db.run(`
    INSERT INTO refunds (id, order_id, machine_id, razorpay_payment_id, razorpay_refund_id, amount_paise, status, reason, initiated_by, source, idempotency_key, created_at, updated_at, processed_at)
    VALUES ('RF-NOV-CORRUPT', 'ORD-OCT-CORRUPT', 'CFX-MC-01', 'pay_oct_2', 'rfnd_nov_2', 15000, 'PROCESSED', 'Erroneous double refund', 'admin', 'SUPER_ADMIN_PORTAL', 'idem_corrupt_2', '2026-11-10T10:00:00.000Z', '2026-11-10T10:00:00.000Z', '2026-11-10T10:00:00.000Z')
  `);

  const novOverviewCorrupt = await getAnalyticsOverview(db, {
    machineId: 'CFX-MC-01',
    timeframe: { startDate: '2026-11-01', endDate: '2026-11-30' },
    forceSource: 'sqlite'
  });
  assert.strictEqual(novOverviewCorrupt.over_refund_detected, true, 'Cross-period over-refund must be detected in November report!');
  console.log('   PASS [SQLite]: Cross-period over-refund correctly flagged in November reporting period.');

  // Scenario C: Partial refund in October (₹50) + Partial refund in November (₹60) = Cumulative ₹110 > ₹100
  await db.exec(`DELETE FROM orders; DELETE FROM refunds;`);
  await db.run(`
    INSERT INTO orders (id, machine_id, product_id, amount, captured_amount_paise, status, razorpay_payment_id, created_at, total_refunded_amount_paise)
    VALUES ('ORD-OCT-MULTI', 'CFX-MC-01', 1, 100, 10000, 'PAID', 'pay_oct_3', '2026-10-15T10:00:00.000Z', 11000)
  `);
  await db.run(`
    INSERT INTO refunds (id, order_id, machine_id, razorpay_payment_id, razorpay_refund_id, amount_paise, status, reason, initiated_by, source, idempotency_key, created_at, updated_at, processed_at)
    VALUES
      ('RF-OCT-P1', 'ORD-OCT-MULTI', 'CFX-MC-01', 'pay_oct_3', 'rfnd_oct_p1', 5000, 'PROCESSED', 'Partial 1', 'admin', 'SUPER_ADMIN_PORTAL', 'idem_multi_p1', '2026-10-20T10:00:00.000Z', '2026-10-20T10:00:00.000Z', '2026-10-20T10:00:00.000Z'),
      ('RF-NOV-P2', 'ORD-OCT-MULTI', 'CFX-MC-01', 'pay_oct_3', 'rfnd_nov_p2', 6000, 'PROCESSED', 'Partial 2', 'admin', 'SUPER_ADMIN_PORTAL', 'idem_multi_p2', '2026-11-05T10:00:00.000Z', '2026-11-05T10:00:00.000Z', '2026-11-05T10:00:00.000Z')
  `);

  const novOverviewMulti = await getAnalyticsOverview(db, {
    machineId: 'CFX-MC-01',
    timeframe: { startDate: '2026-11-01', endDate: '2026-11-30' },
    forceSource: 'sqlite'
  });
  assert.strictEqual(novOverviewMulti.processed_refunds_paise, 6000, 'November report only sums November refunds (6000)');
  assert.strictEqual(novOverviewMulti.over_refund_detected, true, 'Cumulative cross-period over-refund (11,000 > 10,000) detected!');
  console.log('   PASS [SQLite]: Cumulative cross-period partial refunds correctly trigger over_refund_detected.');

  // Scenario D: Failed / Pending refunds in November must NOT trigger over_refund_detected
  await db.exec(`DELETE FROM orders; DELETE FROM refunds;`);
  await db.run(`
    INSERT INTO orders (id, machine_id, product_id, amount, captured_amount_paise, status, razorpay_payment_id, created_at, total_refunded_amount_paise)
    VALUES ('ORD-OCT-FAIL', 'CFX-MC-01', 1, 100, 10000, 'PAID', 'pay_oct_4', '2026-10-15T10:00:00.000Z', 0)
  `);
  await db.run(`
    INSERT INTO refunds (id, order_id, machine_id, razorpay_payment_id, razorpay_refund_id, amount_paise, status, reason, initiated_by, source, idempotency_key, created_at, updated_at)
    VALUES
      ('RF-NOV-FAILED', 'ORD-OCT-FAIL', 'CFX-MC-01', 'pay_oct_4', NULL, 15000, 'FAILED', 'Gateway card failure', 'admin', 'SUPER_ADMIN_PORTAL', 'idem_fail_1', '2026-11-10T10:00:00.000Z', '2026-11-10T10:00:00.000Z'),
      ('RF-NOV-PENDING', 'ORD-OCT-FAIL', 'CFX-MC-01', 'pay_oct_4', NULL, 15000, 'PENDING', 'Pending approval', 'admin', 'SUPER_ADMIN_PORTAL', 'idem_pend_1', '2026-11-11T10:00:00.000Z', '2026-11-11T10:00:00.000Z')
  `);

  const novOverviewFailed = await getAnalyticsOverview(db, {
    machineId: 'CFX-MC-01',
    timeframe: { startDate: '2026-11-01', endDate: '2026-11-30' },
    forceSource: 'sqlite'
  });
  assert.strictEqual(novOverviewFailed.processed_refunds_paise, 0, 'FAILED/PENDING refunds not counted in processed revenue');
  assert.strictEqual(novOverviewFailed.over_refund_detected, false, 'FAILED/PENDING refunds must NOT trigger over_refund_detected');
  console.log('   PASS [SQLite]: FAILED and PENDING cross-period refunds do not trigger over-refund.');

  // Scenario E: Firestore Cross-Period Over-Refund Verification
  const fsBatch = firestore.batch();
  fsBatch.set(firestore.collection('orders').doc('ORD-FS-OCT-CORRUPT'), {
    id: 'ORD-FS-OCT-CORRUPT',
    machine_id: 'CFX-MC-01',
    amount: 100,
    captured_amount_paise: 10000,
    status: 'PAID',
    razorpay_payment_id: 'pay_fs_oct_corrupt',
    created_at: '2026-10-15T10:00:00.000Z',
    total_refunded_amount_paise: 15000
  });
  fsBatch.set(firestore.collection('refunds').doc('RF-FS-NOV-CORRUPT'), {
    id: 'RF-FS-NOV-CORRUPT',
    order_id: 'ORD-FS-OCT-CORRUPT',
    machine_id: 'CFX-MC-01',
    amount_paise: 15000,
    status: 'PROCESSED',
    reason: 'Firestore over-refund test',
    created_at: '2026-11-10T10:00:00.000Z',
    processed_at: '2026-11-10T10:00:00.000Z'
  });
  await fsBatch.commit();

  const fsNovOverview = await getAnalyticsOverview(db, {
    machineId: 'CFX-MC-01',
    timeframe: { startDate: '2026-11-01', endDate: '2026-11-30' },
    forceSource: 'firestore'
  });
  assert.strictEqual(fsNovOverview.over_refund_detected, true, 'Firestore correctly detects cross-period over-refund in November!');
  console.log('   PASS [Firestore]: Cross-period over-refund detected in Firestore emulator.');

  // Scenario F: Unrelated machine over-refund must NOT leak into another machine/owner scope
  await db.exec(`DELETE FROM orders; DELETE FROM refunds;`);
  await db.run(`
    INSERT INTO orders (id, machine_id, product_id, amount, captured_amount_paise, status, razorpay_payment_id, created_at, total_refunded_amount_paise)
    VALUES
      ('ORD-CLEAN-M1', 'CFX-MC-01', 1, 100, 10000, 'PAID', 'pay_clean_1', '2026-11-10T10:00:00.000Z', 0),
      ('ORD-CORRUPT-M2', 'CFX-MC-02', 1, 100, 10000, 'PAID', 'pay_corrupt_2', '2026-11-10T10:00:00.000Z', 15000)
  `);
  await db.run(`
    INSERT INTO refunds (id, order_id, machine_id, razorpay_payment_id, razorpay_refund_id, amount_paise, status, reason, initiated_by, source, idempotency_key, created_at, updated_at, processed_at)
    VALUES
      ('RF-CORRUPT-M2', 'ORD-CORRUPT-M2', 'CFX-MC-02', 'pay_corrupt_2', 'rfnd_corrupt_2', 15000, 'PROCESSED', 'Over refund on M2', 'admin', 'SUPER_ADMIN_PORTAL', 'idem_m2_corrupt', '2026-11-10T10:00:00.000Z', '2026-11-10T10:00:00.000Z', '2026-11-10T10:00:00.000Z')
  `);

  // Querying MC-01 must NOT see MC-02's over-refund
  const m1Overview = await getAnalyticsOverview(db, {
    machineId: 'CFX-MC-01',
    timeframe: { startDate: '2026-11-01', endDate: '2026-11-30' },
    forceSource: 'sqlite'
  });
  assert.strictEqual(m1Overview.over_refund_detected, false, 'MC-01 must NOT be flagged for MC-02 over-refund');

  // Querying MC-02 must see MC-02's over-refund
  const m2Overview = await getAnalyticsOverview(db, {
    machineId: 'CFX-MC-02',
    timeframe: { startDate: '2026-11-01', endDate: '2026-11-30' },
    forceSource: 'sqlite'
  });
  assert.strictEqual(m2Overview.over_refund_detected, true, 'MC-02 must be flagged for its own over-refund');
  console.log('   PASS [SQLite]: Machine scope isolation prevents cross-machine over-refund contamination.');

  // -------------------------------------------------------------------------
  // 5. Finding A8-1: Fleet-Wide & Single-Machine Inventory Balances
  // -------------------------------------------------------------------------
  console.log('\n--- 5. Testing Finding A8-1: Fleet-Wide & Single-Machine Inventory Balances ---');

  // Seed SQLite inventory table
  await db.run(`DELETE FROM inventory;`);
  await db.run(`
    INSERT INTO inventory (machine_id, milk_level, coffee_level, vanilla_level, hazelnut_level, irish_level, mocha_level, water_level)
    VALUES
      ('CFX-MC-01', 85, 75, 95, 90, 80, 65, 100),
      ('CFX-MC-02', 45, 35, 55, 50, 40, 25, 80)
  `);

  // Single Machine Query (CFX-MC-01)
  const singleInv = await getInventoryAnalytics(db, {
    machineId: 'CFX-MC-01',
    forceSource: 'sqlite'
  });
  const milkSingle = singleInv.find((i) => i.ingredient === 'milk');
  const coffeeSingle = singleInv.find((i) => i.ingredient === 'coffee');
  assert.strictEqual(milkSingle?.current_balance, 85, 'Single machine CFX-MC-01 milk balance is 85');
  assert.strictEqual(coffeeSingle?.current_balance, 75, 'Single machine CFX-MC-01 coffee balance is 75');
  assert.strictEqual(milkSingle?.inventory_source, 'software_estimated');
  console.log('   PASS [SQLite]: Single machine inventory returns actual recorded balance (85 milk, 75 coffee).');

  // Fleet-wide Query across CFX-MC-01 and CFX-MC-02 (Super Admin fleet-wide)
  const fleetInv = await getInventoryAnalytics(db, {
    forceSource: 'sqlite'
  });
  const milkFleet = fleetInv.find((i) => i.ingredient === 'milk');
  const coffeeFleet = fleetInv.find((i) => i.ingredient === 'coffee');
  // 85 + 45 = 130 milk
  // 75 + 35 = 110 coffee
  assert.strictEqual(milkFleet?.current_balance, 130, 'Fleet-wide milk balance is 130 (85 + 45), NOT hardcoded 100!');
  assert.strictEqual(coffeeFleet?.current_balance, 110, 'Fleet-wide coffee balance is 110 (75 + 35), NOT hardcoded 100!');
  console.log('   PASS [SQLite]: Fleet-wide inventory sums actual recorded balances (130 milk, 110 coffee).');

  // Owner Scoped Multi-Machine Query (assigned ['CFX-MC-01', 'CFX-MC-02'])
  const ownerMultiInv = await getInventoryAnalytics(db, {
    machineIds: ['CFX-MC-01', 'CFX-MC-02'],
    forceSource: 'sqlite'
  });
  const milkOwner = ownerMultiInv.find((i) => i.ingredient === 'milk');
  assert.strictEqual(milkOwner?.current_balance, 130, 'Owner multi-machine balance correctly sums assigned machines (130)');

  // Owner with ZERO assigned machines
  const emptyOwnerInv = await getInventoryAnalytics(db, {
    machineIds: [],
    forceSource: 'sqlite'
  });
  const milkEmpty = emptyOwnerInv.find((i) => i.ingredient === 'milk');
  assert.strictEqual(milkEmpty?.current_balance, 0, 'Owner with 0 assigned machines has 0 balance, NOT hardcoded 100');
  console.log('   PASS [SQLite]: Owner with 0 assigned machines returns 0 balance.');

  // Unrecorded / Missing machine inventory in SQLite
  const unrecordedInv = await getInventoryAnalytics(db, {
    machineId: 'CFX-MC-UNRECORDED',
    forceSource: 'sqlite'
  });
  const milkUnrecorded = unrecordedInv.find((i) => i.ingredient === 'milk');
  assert.strictEqual(milkUnrecorded?.current_balance, null, 'Unrecorded machine returns null balance instead of invented number');
  console.log('   PASS [SQLite]: Unrecorded machine returns null balance without inventing data.');

  // Firestore Inventory Aggregation Verification
  const fsInvBatch = firestore.batch();
  fsInvBatch.set(firestore.collection('machines').doc('CFX-INV-01'), {
    id: 'CFX-INV-01',
    name: 'Inv Machine 1',
    estimated_inventory: { milk_level: 60, coffee_level: 50 },
    inventory_source: 'software_estimated'
  });
  fsInvBatch.set(firestore.collection('machines').doc('CFX-INV-02'), {
    id: 'CFX-INV-02',
    name: 'Inv Machine 2',
    estimated_inventory: { milk_level: 40, coffee_level: 30 },
    inventory_source: 'software_estimated'
  });
  await fsInvBatch.commit();

  // Firestore Multi-Machine Aggregation
  const fsInvScoped = await getInventoryAnalytics(db, {
    machineIds: ['CFX-INV-01', 'CFX-INV-02'],
    forceSource: 'firestore'
  });
  const fsMilkScoped = fsInvScoped.find((i) => i.ingredient === 'milk');
  const fsCoffeeScoped = fsInvScoped.find((i) => i.ingredient === 'coffee');
  assert.strictEqual(fsMilkScoped?.current_balance, 100, 'Firestore multi-machine milk sums 60 + 40 = 100');
  assert.strictEqual(fsCoffeeScoped?.current_balance, 80, 'Firestore multi-machine coffee sums 50 + 30 = 80');
  const fsVanillaScoped = fsInvScoped.find((i) => i.ingredient === 'vanilla');
  assert.strictEqual(fsVanillaScoped?.current_balance, null, 'Unrecorded ingredient in Firestore returns null, never 100');
  console.log('   PASS [Firestore]: Firestore multi-machine inventory aggregation verified (100 milk, 80 coffee, null unrecorded).');

  // -------------------------------------------------------------------------
  // 5. Phase 2.9.4.1 Analytics Regressions: M-3, L-1 (weekly), L-4 (over-refund)
  // -------------------------------------------------------------------------
  console.log('\n--- 5. Testing M-3, L-1 Weekly Bucketing & L-4 Refunds Over-Refund Parity ---');

  // M-3: Legacy paid order without captured_amount_paise MUST count only when razorpay_payment_id is present
  await db.run(
    `INSERT INTO orders (id, machine_id, amount, captured_amount_paise, status, razorpay_payment_id, created_at)
     VALUES ('ord_m3_cap', 'CFX-MC-M3', 100, 10000, 'PAID', 'pay_m3_cap', '2026-08-02T10:00:00.000Z'),
            ('ord_m3_leg', 'CFX-MC-M3', 150, NULL, 'PAID', 'pay_m3_leg', '2026-08-02T11:00:00.000Z'),
            ('ord_m3_unv', 'CFX-MC-M3', 200, NULL, 'PAID', NULL, '2026-08-02T12:00:00.000Z')`
  );
  await db.run(
    `INSERT INTO refunds (id, order_id, machine_id, razorpay_payment_id, amount_paise, status, reason, initiated_by, source, idempotency_key, created_at, updated_at, processed_at)
     VALUES ('ref_m3_1', 'ord_m3_leg', 'CFX-MC-M3', 'pay_m3_leg', 5000, 'PROCESSED', 'M-3 check', 'admin', 'SUPER_ADMIN_PORTAL', 'idem_m3_1', '2026-08-02T13:00:00.000Z', '2026-08-02T13:00:00.000Z', '2026-08-02T13:00:00.000Z')`
  );

  const m3Batch = firestore.batch();
  m3Batch.set(firestore.collection('orders').doc('ord_m3_cap'), {
    id: 'ord_m3_cap', machine_id: 'CFX-MC-M3', amount: 100, captured_amount_paise: 10000,
    status: 'PAID', razorpay_payment_id: 'pay_m3_cap', created_at: '2026-08-02T10:00:00.000Z'
  });
  m3Batch.set(firestore.collection('orders').doc('ord_m3_leg'), {
    id: 'ord_m3_leg', machine_id: 'CFX-MC-M3', amount: 150, captured_amount_paise: null,
    status: 'PAID', razorpay_payment_id: 'pay_m3_leg', created_at: '2026-08-02T11:00:00.000Z'
  });
  m3Batch.set(firestore.collection('orders').doc('ord_m3_unv'), {
    id: 'ord_m3_unv', machine_id: 'CFX-MC-M3', amount: 200, captured_amount_paise: null,
    status: 'PAID', razorpay_payment_id: null, created_at: '2026-08-02T12:00:00.000Z'
  });
  m3Batch.set(firestore.collection('refunds').doc('ref_m3_1'), {
    id: 'ref_m3_1', order_id: 'ord_m3_leg', machine_id: 'CFX-MC-M3',
    razorpay_payment_id: 'pay_m3_leg', amount_paise: 5000, status: 'PROCESSED',
    reason: 'M-3 check', created_at: '2026-08-02T13:00:00.000Z'
  });
  await m3Batch.commit();

  const m3Tf = { startDate: '2026-08-01T00:00:00+05:30', endDate: '2026-08-05T23:59:59+05:30', timeZone: 'Asia/Kolkata' };
  const m3SqlOverview = await getAnalyticsOverview(db, { machineIds: ['CFX-MC-M3'], timeframe: m3Tf, forceSource: 'sqlite' });
  const m3FsOverview = await getAnalyticsOverview(db, { machineIds: ['CFX-MC-M3'], timeframe: m3Tf, forceSource: 'firestore' });
  assert.strictEqual(m3SqlOverview.gross_sales_paise, 25000, 'SQLite M-3 must sum 10000 + 15000 = 25000 (excluding unverified order)');
  assert.strictEqual(m3FsOverview.gross_sales_paise, 25000, 'Firestore M-3 must match SQLite exactly (25000)');

  // Test getRefundsAnalytics grossPaise boundary via refunds_exceed_period_sales:
  // Confirmed captured+legacy grossPaise = 25000; refund of 18000 is <= 25000 (false), NOT > 10000 (true if legacy skipped!)
  await db.run(
    `INSERT INTO refunds (id, order_id, machine_id, razorpay_payment_id, amount_paise, status, reason, initiated_by, source, idempotency_key, created_at, updated_at, processed_at)
     VALUES ('ref_m3_2', 'ord_m3_leg', 'CFX-MC-M3', 'pay_m3_leg', 13000, 'PROCESSED', 'M-3 boundary check', 'admin', 'SUPER_ADMIN_PORTAL', 'idem_m3_2', '2026-08-02T14:00:00.000Z', '2026-08-02T14:00:00.000Z', '2026-08-02T14:00:00.000Z')`
  );
  await firestore.collection('refunds').doc('ref_m3_2').set({
    id: 'ref_m3_2', order_id: 'ord_m3_leg', machine_id: 'CFX-MC-M3',
    razorpay_payment_id: 'pay_m3_leg', amount_paise: 13000, status: 'PROCESSED',
    reason: 'M-3 boundary check', created_at: '2026-08-02T14:00:00.000Z'
  });
  const m3SqlRefunds = await getRefundsAnalytics(db, { machineIds: ['CFX-MC-M3'], timeframe: m3Tf, forceSource: 'sqlite' });
  const m3FsRefunds = await getRefundsAnalytics(db, { machineIds: ['CFX-MC-M3'], timeframe: m3Tf, forceSource: 'firestore' });
  assert.strictEqual(m3SqlRefunds.processed_refunds_paise, 18000);
  assert.strictEqual(m3FsRefunds.processed_refunds_paise, 18000);
  assert.strictEqual(m3SqlRefunds.refunds_exceed_period_sales, false, 'SQLite M-3 must count legacy order (18000 <= 25000)');
  assert.strictEqual(m3FsRefunds.refunds_exceed_period_sales, false, 'Firestore M-3 must match SQLite (18000 <= 25000)');

  // Now add another refund of 10000 (total 28000 > 25000, still < 45000 if unverified order were wrongly included!)
  await db.run(
    `INSERT INTO refunds (id, order_id, machine_id, razorpay_payment_id, amount_paise, status, reason, initiated_by, source, idempotency_key, created_at, updated_at, processed_at)
     VALUES ('ref_m3_3', 'ord_m3_cap', 'CFX-MC-M3', 'pay_m3_cap', 10000, 'PROCESSED', 'M-3 unverified excl check', 'admin', 'SUPER_ADMIN_PORTAL', 'idem_m3_3', '2026-08-02T15:00:00.000Z', '2026-08-02T15:00:00.000Z', '2026-08-02T15:00:00.000Z')`
  );
  await firestore.collection('refunds').doc('ref_m3_3').set({
    id: 'ref_m3_3', order_id: 'ord_m3_cap', machine_id: 'CFX-MC-M3',
    razorpay_payment_id: 'pay_m3_cap', amount_paise: 10000, status: 'PROCESSED',
    reason: 'M-3 unverified excl check', created_at: '2026-08-02T15:00:00.000Z'
  });
  const m3SqlUnv = await getRefundsAnalytics(db, { machineIds: ['CFX-MC-M3'], timeframe: m3Tf, forceSource: 'sqlite' });
  const m3FsUnv = await getRefundsAnalytics(db, { machineIds: ['CFX-MC-M3'], timeframe: m3Tf, forceSource: 'firestore' });
  assert.strictEqual(m3SqlUnv.refunds_exceed_period_sales, true, 'Unverified order must NOT count as captured revenue (28000 > 25000)');
  assert.strictEqual(m3FsUnv.refunds_exceed_period_sales, true, 'Firestore must also exclude unverified order');

  // L-4 Part A: Cross-period over-refund detection & no nested-subcollection double counting
  await db.run(
    `INSERT INTO orders (id, machine_id, amount, captured_amount_paise, status, razorpay_payment_id, total_refunded_amount_paise, created_at)
     VALUES ('ord_l4_prior', 'CFX-MC-L4', 100, 10000, 'PAID', 'pay_l4_prior', 12000, '2026-06-15T10:00:00.000Z')`
  );
  await db.run(
    `INSERT INTO refunds (id, order_id, machine_id, razorpay_payment_id, amount_paise, status, reason, initiated_by, source, idempotency_key, created_at, updated_at, processed_at)
     VALUES ('ref_l4_1', 'ord_l4_prior', 'CFX-MC-L4', 'pay_l4_prior', 12000, 'PROCESSED', 'Over-refund L4', 'admin', 'SUPER_ADMIN_PORTAL', 'idem_l4_1', '2026-07-05T10:00:00.000Z', '2026-07-05T10:00:00.000Z', '2026-07-05T10:00:00.000Z')`
  );
  await firestore.collection('orders').doc('ord_l4_prior').set({
    id: 'ord_l4_prior', machine_id: 'CFX-MC-L4', amount: 100, captured_amount_paise: 10000,
    status: 'PAID', razorpay_payment_id: 'pay_l4_prior', total_refunded_amount_paise: 12000,
    created_at: '2026-06-15T10:00:00.000Z'
  });
  await firestore.collection('refunds').doc('ref_l4_1').set({
    id: 'ref_l4_1', order_id: 'ord_l4_prior', machine_id: 'CFX-MC-L4',
    razorpay_payment_id: 'pay_l4_prior', amount_paise: 12000, status: 'PROCESSED',
    reason: 'Over-refund L4', created_at: '2026-07-05T10:00:00.000Z'
  });
  await firestore.collection('orders').doc('ord_l4_prior').collection('refunds').doc('ref_l4_1').set({
    id: 'ref_l4_1', order_id: 'ord_l4_prior', machine_id: 'CFX-MC-L4',
    razorpay_payment_id: 'pay_l4_prior', amount_paise: 12000, status: 'PROCESSED',
    reason: 'Over-refund L4', created_at: '2026-07-05T10:00:00.000Z'
  });

  const l4Tf = { startDate: '2026-07-01T00:00:00+05:30', endDate: '2026-07-10T23:59:59+05:30', timeZone: 'Asia/Kolkata' };
  const l4Sql = await getRefundsAnalytics(db, { machineIds: ['CFX-MC-L4'], timeframe: l4Tf, forceSource: 'sqlite' });
  const l4Fs = await getRefundsAnalytics(db, { machineIds: ['CFX-MC-L4'], timeframe: l4Tf, forceSource: 'firestore' });
  assert.strictEqual(l4Sql.over_refund_detected, true, 'L-4 SQLite must detect cross-period over-refund');
  assert.strictEqual(l4Fs.over_refund_detected, true, 'L-4 Firestore must detect cross-period over-refund once (no double count)');
  assert.strictEqual(l4Fs.processed_refunds_paise, 12000, 'L-4 Firestore nested subcollection must not double-count');

  // L-1: Weekly time-series bucketing (Monday-Sunday IST, month wrap, year wrap, empty dataset)
  await db.run(
    `INSERT INTO orders (id, machine_id, amount, captured_amount_paise, status, razorpay_payment_id, created_at)
     VALUES ('ord_wk_sun_oct', 'CFX-MC-L1', 100, 10000, 'PAID', 'pay_wk1', '2026-10-31T19:00:00.000Z'),
            ('ord_wk_mon_nov', 'CFX-MC-L1', 200, 20000, 'PAID', 'pay_wk2', '2026-11-01T19:00:00.000Z'),
            ('ord_wk_mon_same', 'CFX-MC-L1', 50, 5000, 'PAID', 'pay_wk3', '2026-11-08T10:00:00+05:30'),
            ('ord_wk_year_wrap', 'CFX-MC-L1', 300, 30000, 'PAID', 'pay_wk4', '2027-01-02T10:00:00+05:30')`
  );
  const wkBatch = firestore.batch();
  for (const [id, amt, ts] of [
    ['ord_wk_sun_oct', 10000, '2026-10-31T19:00:00.000Z'],
    ['ord_wk_mon_nov', 20000, '2026-11-01T19:00:00.000Z'],
    ['ord_wk_mon_same', 5000, '2026-11-08T10:00:00+05:30'],
    ['ord_wk_year_wrap', 30000, '2027-01-02T10:00:00+05:30']
  ] as const) {
    wkBatch.set(firestore.collection('orders').doc(id), {
      id, machine_id: 'CFX-MC-L1', amount: amt / 100, captured_amount_paise: amt,
      status: 'PAID', razorpay_payment_id: `pay_${id}`, created_at: ts
    });
  }
  await wkBatch.commit();

  const wkTf = { startDate: '2026-10-25T00:00:00+05:30', endDate: '2027-01-05T23:59:59+05:30', timeZone: 'Asia/Kolkata' };
  const wkSql = await getTimeSeriesAnalytics(db, { machineIds: ['CFX-MC-L1'], timeframe: wkTf, interval: 'week', forceSource: 'sqlite' });
  const wkFs = await getTimeSeriesAnalytics(db, { machineIds: ['CFX-MC-L1'], timeframe: wkTf, interval: 'week', forceSource: 'firestore' });
  assert.deepStrictEqual(wkSql.map((b) => b.bucket_key), ['2026-10-26', '2026-11-02', '2026-12-28'], 'Weekly buckets must follow chronological IST Monday boundaries');
  assert.deepStrictEqual(wkFs.map((b) => b.bucket_key), ['2026-10-26', '2026-11-02', '2026-12-28'], 'Firestore weekly buckets must match SQLite');
  assert.strictEqual(wkSql[0].gross_sales_paise, 10000, 'Sunday Nov 1 IST must belong to 2026-10-26 week');
  assert.strictEqual(wkSql[1].gross_sales_paise, 25000, 'Mon Nov 2 IST + Sun Nov 8 IST must sum in 2026-11-02 week');
  assert.strictEqual(wkSql[2].gross_sales_paise, 30000, 'Sat Jan 2 2027 IST must belong to 2026-12-28 week');

  const emptyWk = await getTimeSeriesAnalytics(db, {
    machineIds: ['CFX-MC-L1'],
    timeframe: { startDate: '2025-01-01T00:00:00+05:30', endDate: '2025-01-10T23:59:59+05:30', timeZone: 'Asia/Kolkata' },
    interval: 'week',
    forceSource: 'sqlite'
  });
  assert.strictEqual(emptyWk.length, 0, 'Empty dataset must return empty weekly array');
  console.log('   PASS: M-3 refund rate parity, L-1 weekly IST boundaries, and L-4 cross-period over-refund checks passed.');

  console.log('\n========================================================================');
  console.log('ALL PHASE 2.9.2.2 HARDENING & AUDIT REMEDIATION TESTS PASSED (100%)!');
  console.log('========================================================================\n');
}

runHardeningTests()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Test execution failed:', err);
    process.exit(1);
  });
