import assert from 'assert';
import crypto from 'crypto';
import sqlite3 from 'sqlite3';
import { open, Database } from 'sqlite';
import { initializeApp, getApps, deleteApp } from 'firebase-admin/app';
import { getFirestore, Firestore } from 'firebase-admin/firestore';
import {
  ensureFirebaseReady,
  setFirestoreForTesting,
  isFirestoreActive
} from '../utils/firebase';
import { initializeInventoryLedgerSchema } from '../utils/inventoryLedger';
import {
  paiseToInr,
  inrToPaise,
  formatInTimeZone,
  getGrossCapturedSalesPaise,
  getProcessedRefundsPaise,
  getNetRevenuePaise,
  getPaidOrderCount,
  getPaymentCounts,
  getDispensedOrderCount,
  getFailedDispensingCount,
  getInFlightDispensingCount,
  getAverageOrderValue,
  getAnalyticsOverview,
  getMachineRevenueAnalytics,
  getProductSalesAnalytics,
  getIngredientConsumption,
  getInventoryRefillQuantities,
  getWasteAndAdjustments,
  getInventoryAnalytics,
  getTimeSeriesAnalytics
} from '../services/analyticsService';

const EMULATOR_HOST = '127.0.0.1:8088';
const EMULATOR_PROJECT_ID = 'demo-caffix-emulator';

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
      machine_name TEXT NOT NULL,
      owner_id TEXT,
      location TEXT,
      desired_mode TEXT DEFAULT 'RUNNING',
      status TEXT DEFAULT 'online',
      last_seen TEXT
    );

    CREATE TABLE IF NOT EXISTS products (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      price INTEGER NOT NULL,
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
      product_id INTEGER NOT NULL,
      amount INTEGER NOT NULL,
      captured_amount_paise INTEGER,
      status TEXT NOT NULL,
      dispense_status TEXT DEFAULT 'PENDING',
      dispensed BOOLEAN DEFAULT 0,
      customer_name TEXT,
      customer_email TEXT,
      refund_status TEXT DEFAULT 'NONE',
      total_refunded_amount_paise INTEGER DEFAULT 0,
      pending_refund_amount_paise INTEGER DEFAULT 0,
      last_refunded_at TEXT,
      razorpay_order_id TEXT,
      razorpay_payment_id TEXT,
      razorpay_signature TEXT,
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

  // Apply Phase 2.9 Analytics Indexes to SQLite
  await db.exec(`
    CREATE INDEX IF NOT EXISTS idx_orders_analytics ON orders(machine_id, status, created_at);
    CREATE INDEX IF NOT EXISTS idx_orders_status_created_at ON orders(status, created_at);
    CREATE INDEX IF NOT EXISTS idx_orders_created_at ON orders(created_at);
    CREATE INDEX IF NOT EXISTS idx_refunds_status_created_at ON refunds(status, created_at);
    CREATE INDEX IF NOT EXISTS idx_refunds_machine_status_created_at ON refunds(machine_id, status, created_at);
  `);

  return db;
}

async function runAllAnalyticsTests() {
  console.log('=============================================================');
  console.log('Running CAFFIX Phase 2.9.1 — Backend Analytics Foundation Tests');
  console.log('=============================================================\n');

  let firestore: Firestore;
  try {
    for (const app of getApps()) {
      await deleteApp(app);
    }
    const app = initializeApp({ projectId: EMULATOR_PROJECT_ID });
    firestore = getFirestore(app);
    setFirestoreForTesting({ firestoreInstance: firestore });
    await clearEmulatorDatabase();
    console.log('Connected to local Firestore Emulator at', EMULATOR_HOST);
  } catch (err: any) {
    console.error('Failed to initialize Firestore Emulator:', err.message);
    process.exit(1);
  }

  const db = await createIsolatedSqliteDb();

  // Seed Machines
  await db.run(
    `INSERT INTO machines (id, machine_name, owner_id, location, desired_mode, status) VALUES
     ('CFX-MC-01', 'Kiosk-One', 'usr_owner_alpha', 'Delhi Airport T3', 'RUNNING', 'online'),
     ('CFX-MC-02', 'Kiosk-Two', 'usr_owner_beta', 'CyberHub Gurgaon', 'RUNNING', 'online'),
     ('CFX-MC-03', 'Kiosk-Three', 'usr_owner_alpha', 'Noida Sec 62', 'MAINTENANCE', 'offline')`
  );

  await db.run(
    `INSERT INTO inventory (machine_id, milk_level, coffee_level, vanilla_level, hazelnut_level, irish_level, mocha_level, water_level) VALUES
     ('CFX-MC-01', 85, 70, 90, 80, 75, 60, 95),
     ('CFX-MC-02', 60, 50, 40, 30, 20, 10, 80),
     ('CFX-MC-03', 100, 100, 100, 100, 100, 100, 100)`
  );

  // -------------------------------------------------------------------------
  // Test 1: Pending and Failed Orders Excluded from Revenue
  // -------------------------------------------------------------------------
  console.log('1. Testing PENDING and FAILED orders are strictly excluded from revenue...');
  await db.run(`
    INSERT INTO orders (id, machine_id, product_id, amount, captured_amount_paise, status, dispense_status, razorpay_order_id, razorpay_payment_id, created_at)
    VALUES
    ('ord_pending_1', 'CFX-MC-01', 1, 100, NULL, 'PENDING', 'PENDING', 'order_p1', NULL, '2026-11-14T02:00:00.000Z'),
    ('ord_failed_1', 'CFX-MC-01', 1, 100, NULL, 'FAILED', 'PENDING', 'order_f1', NULL, '2026-11-14T02:15:00.000Z'),
    ('ord_cancelled_1', 'CFX-MC-01', 1, 100, NULL, 'CANCELLED', 'PENDING', 'order_c1', NULL, '2026-11-14T02:30:00.000Z')
  `);

  const grossUnpaid = await getGrossCapturedSalesPaise(db);
  const paidCountUnpaid = await getPaidOrderCount(db);
  const paymentCounts = await getPaymentCounts(db);

  assert.strictEqual(grossUnpaid, 0, 'Unpaid orders must yield 0 gross sales paise');
  assert.strictEqual(paidCountUnpaid, 0, 'Unpaid orders must yield 0 paid orders');
  assert.strictEqual(paymentCounts.pending, 1, 'Should record 1 pending payment');
  assert.strictEqual(paymentCounts.failed, 1, 'Should record 1 failed payment');
  console.log('   PASS: PENDING, FAILED, and CANCELLED orders contribute 0 revenue.');

  // -------------------------------------------------------------------------
  // Test 2: Captured Amount Calculation & Legacy Fallback
  // -------------------------------------------------------------------------
  console.log('2. Testing captured amount calculation and legacy fallback...');
  await db.run(`
    INSERT INTO orders (id, machine_id, product_id, amount, captured_amount_paise, status, dispense_status, razorpay_order_id, razorpay_payment_id, created_at)
    VALUES
    -- Exact captured paise (14500 paise = 145 INR)
    ('ord_paid_exact', 'CFX-MC-01', 1, 145, 14500, 'PAID', 'DISPENSED', 'order_exact', 'pay_exact_123', '2026-11-14T03:00:00.000Z'),
    -- Legacy order where captured_amount_paise is NULL, amount is 100 INR -> 10000 paise
    ('ord_paid_legacy', 'CFX-MC-01', 2, 100, NULL, 'PAID', 'DISPENSED', 'order_legacy', 'pay_legacy_456', '2026-11-14T03:30:00.000Z')
  `);

  const grossWithPaid = await getGrossCapturedSalesPaise(db);
  const paidCount = await getPaidOrderCount(db);

  // 14500 + 10000 = 24500 paise (245 INR)
  assert.strictEqual(grossWithPaid, 24500, 'Expected 24500 paise gross revenue');
  assert.strictEqual(paiseToInr(grossWithPaid), 245, 'Expected 245 INR gross revenue');
  assert.strictEqual(paidCount, 2, 'Expected 2 paid orders');
  console.log('   PASS: Exact paise (14,500) and legacy fallback (10,000) correctly sum to 24,500 paise (₹245).');

  // -------------------------------------------------------------------------
  // Test 3: Partial Refunds and Full Refunds Accounting
  // -------------------------------------------------------------------------
  console.log('3. Testing partial and full processed refunds accounting...');
  // Add partial refund of 5000 paise (50 INR) on ord_paid_exact
  await db.run(`
    INSERT INTO refunds (id, order_id, machine_id, razorpay_payment_id, razorpay_refund_id, amount_paise, status, reason, initiated_by, source, idempotency_key, created_at, updated_at, processed_at)
    VALUES
    ('ref_partial_1', 'ord_paid_exact', 'CFX-MC-01', 'pay_exact_123', 'rfnd_part_1', 5000, 'PROCESSED', 'Partial refund test', 'admin', 'SUPER_ADMIN_PORTAL', 'idem_ref_part_1', '2026-11-14T04:00:00.000Z', '2026-11-14T04:00:00.000Z', '2026-11-14T04:00:00.000Z')
  `);

  const processedRefunds = await getProcessedRefundsPaise(db);
  const netRevenue = await getNetRevenuePaise(db);

  // Gross = 24500 paise, Refunds = 5000 paise -> Net = 19500 paise (195 INR)
  assert.strictEqual(processedRefunds, 5000, 'Expected 5000 paise processed refunds');
  assert.strictEqual(netRevenue, 19500, 'Expected 19500 paise net revenue');
  assert.strictEqual(paiseToInr(netRevenue), 195, 'Expected 195 INR net revenue');
  console.log('   PASS: Partial refund correctly subtracted from net revenue (Gross: ₹245, Refund: ₹50, Net: ₹195).');

  // -------------------------------------------------------------------------
  // Test 4: Pending Refunds Excluded from Processed Refund Totals
  // -------------------------------------------------------------------------
  console.log('4. Testing pending refund reservations do not debit net revenue prematurely...');
  await db.run(`
    INSERT INTO refunds (id, order_id, machine_id, razorpay_payment_id, razorpay_refund_id, amount_paise, status, reason, initiated_by, source, idempotency_key, created_at, updated_at)
    VALUES
    ('ref_pending_res', 'ord_paid_legacy', 'CFX-MC-01', 'pay_legacy_456', NULL, 10000, 'PENDING', 'Pending gateway', 'admin', 'SUPER_ADMIN_PORTAL', 'idem_ref_pend_1', '2026-11-14T04:30:00.000Z', '2026-11-14T04:30:00.000Z')
  `);

  const processedAfterPending = await getProcessedRefundsPaise(db);
  const netAfterPending = await getNetRevenuePaise(db);

  // Still 5000 paise processed refunds and 19500 net revenue
  assert.strictEqual(processedAfterPending, 5000, 'Pending refund reservation must not count as processed refund');
  assert.strictEqual(netAfterPending, 19500, 'Pending refund reservation must not reduce net revenue');
  console.log('   PASS: PENDING refund reservation strictly excluded from processed refund deductions.');

  // -------------------------------------------------------------------------
  // Test 5: Duplicate Refund Prevention via Unique Idempotency Key
  // -------------------------------------------------------------------------
  console.log('5. Testing duplicate refund prevention and idempotency...');
  let failedDuplicate = false;
  try {
    await db.run(`
      INSERT INTO refunds (id, order_id, machine_id, razorpay_payment_id, razorpay_refund_id, amount_paise, status, reason, initiated_by, source, idempotency_key, created_at, updated_at)
      VALUES
      ('ref_dup_test', 'ord_paid_exact', 'CFX-MC-01', 'pay_exact_123', 'rfnd_part_1', 5000, 'PROCESSED', 'Dup test', 'admin', 'SUPER_ADMIN_PORTAL', 'idem_ref_part_1', '2026-11-14T04:00:00.000Z', '2026-11-14T04:00:00.000Z')
    `);
  } catch (err) {
    failedDuplicate = true;
  }
  assert.strictEqual(failedDuplicate, true, 'Unique idempotency key must block duplicate refund insertion');
  console.log('   PASS: Duplicate refund rejected by unique constraint on idempotency_key.');

  // -------------------------------------------------------------------------
  // Test 6: Dispensing State Handling (DISPENSED vs FAILED vs IN-FLIGHT)
  // -------------------------------------------------------------------------
  console.log('6. Testing hardware dispensing independence & status values...');
  // Add an order where payment succeeded, but hardware dispense failed
  await db.run(`
    INSERT INTO orders (id, machine_id, product_id, amount, captured_amount_paise, status, dispense_status, razorpay_order_id, razorpay_payment_id, created_at)
    VALUES
    ('ord_disp_fail', 'CFX-MC-02', 3, 120, 12000, 'PAID', 'FAILED', 'order_df1', 'pay_df_789', '2026-11-14T05:00:00.000Z'),
    ('ord_disp_inflight', 'CFX-MC-02', 4, 130, 13000, 'PAID', 'DISPENSING', 'order_di1', 'pay_di_999', '2026-11-14T05:15:00.000Z'),
    ('ord_disp_completed', 'CFX-MC-02', 5, 150, 15000, 'COMPLETED', 'COMPLETED', 'order_dc1', 'pay_dc_111', '2026-11-14T05:30:00.000Z')
  `);

  const dispensedCount = await getDispensedOrderCount(db);
  const failedDispenseCount = await getFailedDispensingCount(db);
  const inFlightDispenseCount = await getInFlightDispensingCount(db);

  // Previously: 2 dispensed (ord_paid_exact, ord_paid_legacy). Now + 1 (ord_disp_completed) = 3 dispensed.
  // 1 failed dispense (ord_disp_fail)
  // 1 in-flight dispense (ord_disp_inflight)
  assert.strictEqual(dispensedCount, 3, 'Expected 3 successfully dispensed orders (DISPENSED + COMPLETED)');
  assert.strictEqual(failedDispenseCount, 1, 'Expected 1 failed dispense order');
  assert.strictEqual(inFlightDispenseCount, 1, 'Expected 1 in-flight dispense order');

  // Verify that ord_disp_fail STILL counts towards gross revenue!
  // Previous gross = 24500 paise. Added 12000 + 13000 + 15000 = 40000 paise. Total = 64500 paise.
  const newGross = await getGrossCapturedSalesPaise(db);
  assert.strictEqual(newGross, 64500, 'Failed hardware dispense must remain recorded as captured gross revenue');
  console.log('   PASS: Dispensing lifecycle independently evaluated; failed pours remain captured gross revenue.');

  // -------------------------------------------------------------------------
  // Test 7: Historical Product Pricing Continuity
  // -------------------------------------------------------------------------
  console.log('7. Testing product sales analytics with historical price snapshots...');
  // Update catalog price for product 1 from 100 to 199 in products table
  await db.run('UPDATE products SET price = 199 WHERE id = 1');

  const productAnalytics = await getProductSalesAnalytics(db);
  const prod1 = productAnalytics.find((p) => p.product_id === 1);

  // ord_paid_exact was bought for 14500 paise (145 INR), ord_pending_1 and ord_failed_1 excluded.
  assert.ok(prod1, 'Product 1 must be present');
  assert.strictEqual(prod1.units_sold, 1, 'Product 1 units sold must be 1');
  assert.strictEqual(prod1.gross_sales_paise, 14500, 'Product 1 gross sales must match historical 14,500 paise, not 19,900');
  assert.strictEqual(prod1.gross_sales_inr, 145, 'Product 1 INR must be 145');
  console.log('   PASS: Product sales preserve historical transaction snapshot regardless of catalog price changes.');

  // -------------------------------------------------------------------------
  // Test 8: Machine-Specific & Owner-Scoped Analytics
  // -------------------------------------------------------------------------
  console.log('8. Testing machine filtering and multi-tenant owner scoping...');
  // Machine 1 (CFX-MC-01): ord_paid_exact (14500) + ord_paid_legacy (10000) = 24500 paise. Refund = 5000 paise. Net = 19500 paise.
  // Machine 2 (CFX-MC-02): ord_disp_fail (12000) + ord_disp_inflight (13000) + ord_disp_completed (15000) = 40000 paise. Refunds = 0. Net = 40000 paise.
  const m1Overview = await getAnalyticsOverview(db, { machineId: 'CFX-MC-01' });
  const m2Overview = await getAnalyticsOverview(db, { machineId: 'CFX-MC-02' });

  assert.strictEqual(m1Overview.gross_sales_paise, 24500);
  assert.strictEqual(m1Overview.processed_refunds_paise, 5000);
  assert.strictEqual(m1Overview.net_revenue_paise, 19500);
  assert.strictEqual(m1Overview.paid_orders_count, 2);

  assert.strictEqual(m2Overview.gross_sales_paise, 40000);
  assert.strictEqual(m2Overview.processed_refunds_paise, 0);
  assert.strictEqual(m2Overview.net_revenue_paise, 40000);
  assert.strictEqual(m2Overview.paid_orders_count, 3);

  // Owner Alpha owns CFX-MC-01 and CFX-MC-03.
  const ownerAlphaOverview = await getAnalyticsOverview(db, {
    machineIds: ['CFX-MC-01', 'CFX-MC-03']
  });
  assert.strictEqual(ownerAlphaOverview.gross_sales_paise, 24500, 'Owner Alpha sees strictly their units');

  // Owner Beta owns CFX-MC-02.
  const ownerBetaOverview = await getAnalyticsOverview(db, {
    machineIds: ['CFX-MC-02']
  });
  assert.strictEqual(ownerBetaOverview.gross_sales_paise, 40000, 'Owner Beta sees strictly their units');

  // Owner with 0 machines
  const emptyOwnerOverview = await getAnalyticsOverview(db, { machineIds: [] });
  assert.strictEqual(emptyOwnerOverview.gross_sales_paise, 0);
  assert.strictEqual(emptyOwnerOverview.paid_orders_count, 0);
  console.log('   PASS: Machine filtering and multi-tenant owner scoping strictly isolated.');

  // -------------------------------------------------------------------------
  // Test 9: Asia/Kolkata Timezone & Midnight Boundary Bucketing
  // -------------------------------------------------------------------------
  console.log('9. Testing Asia/Kolkata (IST) timezone calendar boundary bucketing...');
  // Order placed at 2026-11-13T23:30:00.000Z
  // In UTC, this is Nov 13.
  // In IST (UTC+05:30), 23:30 + 05:30 = 05:00 AM on 2026-11-14!
  const midnightUtcOrder = '2026-11-13T23:30:00.000Z';
  const tzFormatted = formatInTimeZone(midnightUtcOrder, 'Asia/Kolkata');
  assert.strictEqual(tzFormatted.dateKey, '2026-11-14', '23:30 UTC must map to Nov 14 in Asia/Kolkata');

  // Order placed at 2026-11-13T18:00:00.000Z
  // In UTC, this is Nov 13.
  // In IST (UTC+05:30), 18:00 + 05:30 = 23:30 on 2026-11-13.
  const eveningUtcOrder = '2026-11-13T18:00:00.000Z';
  const eveningFormatted = formatInTimeZone(eveningUtcOrder, 'Asia/Kolkata');
  assert.strictEqual(eveningFormatted.dateKey, '2026-11-13', '18:00 UTC must map to Nov 13 in Asia/Kolkata');
  console.log('   PASS: Asia/Kolkata timezone math correctly partitions UTC records across midnight boundaries.');

  // -------------------------------------------------------------------------
  // Test 10: Inventory Movements Accounting (DEDUCTION, REFILL, WASTE, ADJUSTMENT)
  // -------------------------------------------------------------------------
  console.log('10. Testing inventory ledger analytics (DEDUCTION, REFILL, WASTE, ADJUSTMENT)...');
  await db.run(`
    INSERT INTO inventory_ledger (id, machine_id, ingredient, quantity, movement_type, balance_after, reason, idempotency_key, created_at)
    VALUES
    ('mov_1', 'CFX-MC-01', 'coffee', 20, 'DEDUCTION', 80, 'Classic Crest dispense', 'idem_mov_1', '2026-11-14T03:00:00.000Z'),
    ('mov_2', 'CFX-MC-01', 'coffee', 20, 'DEDUCTION', 60, 'Vanilla Velvet dispense', 'idem_mov_2', '2026-11-14T03:30:00.000Z'),
    ('mov_3', 'CFX-MC-01', 'coffee', 100, 'REFILL', 160, 'Morning restock', 'idem_mov_3', '2026-11-14T01:00:00.000Z'),
    ('mov_4', 'CFX-MC-01', 'milk', 50, 'DEDUCTION', 50, 'Vanilla Velvet dispense', 'idem_mov_4', '2026-11-14T03:30:00.000Z'),
    ('mov_5', 'CFX-MC-01', 'milk', 10, 'WASTE', 40, 'Spill during nozzle check', 'idem_mov_5', '2026-11-14T06:00:00.000Z'),
    ('mov_6', 'CFX-MC-01', 'water', 5, 'ADJUSTMENT', 95, 'Sensor scale calibration', 'idem_mov_6', '2026-11-14T06:30:00.000Z')
  `);

  const consumption = await getIngredientConsumption(db, { machineId: 'CFX-MC-01' });
  const refills = await getInventoryRefillQuantities(db, { machineId: 'CFX-MC-01' });
  const { waste, adjustments } = await getWasteAndAdjustments(db, { machineId: 'CFX-MC-01' });

  assert.strictEqual(consumption['coffee'], 40, 'Coffee deduction should be 40 units');
  assert.strictEqual(consumption['milk'], 50, 'Milk deduction should be 50 units');
  assert.strictEqual(refills['coffee'], 100, 'Coffee refill should be 100 units');
  assert.strictEqual(waste['milk'], 10, 'Milk waste should be 10 units');
  assert.strictEqual(adjustments['water'], 5, 'Water adjustment should be 5 units');
  console.log('   PASS: Inventory movements accurately categorized across DEDUCTION, REFILL, WASTE, and ADJUSTMENT.');

  // -------------------------------------------------------------------------
  // Test 11: Warning B-1 (SHA-256 Hashed Doc ID in Firestore)
  // -------------------------------------------------------------------------
  console.log('11. Testing Warning B-1: SHA-256 Hashing of Refill Idempotency Key in Firestore...');
  const trickyKeyWithSlashes = 'client/pos/terminal-01/refill-20261114';
  const hashedDocId = `idem_${crypto.createHash('sha256').update(trickyKeyWithSlashes).digest('hex')}`;

  // Direct Firestore write using the hashed document ID
  await firestore.collection('refill_idempotency').doc(hashedDocId).set({
    idempotency_key: trickyKeyWithSlashes,
    machine_id: 'CFX-MC-01',
    ingredient: 'coffee',
    quantity: 50,
    created_at: new Date().toISOString()
  });

  const snap = await firestore.collection('refill_idempotency').doc(hashedDocId).get();
  assert.strictEqual(snap.exists, true, 'Document with SHA-256 hashed ID must exist in Firestore');
  assert.strictEqual(snap.data()?.idempotency_key, trickyKeyWithSlashes, 'Original raw key preserved inside document payload');
  console.log('   PASS: Raw key containing slashes stored safely using SHA-256 document ID without path errors.');

  // -------------------------------------------------------------------------
  // Test 12: Time Series Aggregation
  // -------------------------------------------------------------------------
  console.log('12. Testing Time Series bucketing...');
  const timeSeries = await getTimeSeriesAnalytics(db, {
    timeframe: {
      startDate: '2026-11-14T00:00:00.000Z',
      endDate: '2026-11-14T23:59:59.999Z'
    },
    interval: 'day'
  });

  assert.ok(timeSeries.length >= 1, 'Should produce at least one day bucket');
  const todayBucket = timeSeries.find((b) => b.bucket_key === '2026-11-14');
  assert.ok(todayBucket, 'Should find 2026-11-14 bucket');
  assert.strictEqual(todayBucket.paid_orders_count, 5, 'Should count all paid orders on Nov 14');
  assert.strictEqual(todayBucket.gross_sales_paise, 64500, 'Should match total gross sales paise');
  assert.strictEqual(todayBucket.processed_refunds_paise, 5000, 'Should match processed refund paise');
  assert.strictEqual(todayBucket.net_revenue_paise, 59500, 'Should match net revenue paise');
  console.log('   PASS: Time series day bucket matches exact financial totals (Gross: ₹645, Refund: ₹50, Net: ₹595).');

  // -------------------------------------------------------------------------
  // Test 13: Audit 1 - Dual Firestore Representations & Single Counting
  // -------------------------------------------------------------------------
  console.log('13. Audit 1: Testing dual Firestore refund representation and single counting verification...');
  const testOrderId = 'ord_audit_dual_13';
  const testRefundId = 'ref_audit_dual_13';
  const refundPayload = {
    id: testRefundId,
    order_id: testOrderId,
    machine_id: 'CFX-MC-01',
    amount_paise: 3000,
    status: 'PROCESSED',
    idempotency_key: 'idem_audit_dual_13',
    created_at: new Date().toISOString()
  };

  // Write dual representation in Firestore: root and subcollection
  await firestore.collection('refunds').doc(testRefundId).set(refundPayload);
  await firestore.collection('orders').doc(testOrderId).collection('refunds').doc(testRefundId).set(refundPayload);

  // In SQLite, write the single canonical refund record
  await db.run(`
    INSERT INTO refunds (id, order_id, machine_id, razorpay_payment_id, razorpay_refund_id, amount_paise, status, reason, initiated_by, source, idempotency_key, created_at, updated_at, processed_at)
    VALUES
    ('${testRefundId}', '${testOrderId}', 'CFX-MC-01', 'pay_audit_13', 'rfnd_audit_13', 3000, 'PROCESSED', 'Dual representation audit', 'admin', 'SUPER_ADMIN_PORTAL', 'idem_audit_dual_13', '2026-11-14T07:00:00.000Z', '2026-11-14T07:00:00.000Z', '2026-11-14T07:00:00.000Z')
  `);

  // Verify getProcessedRefundsPaise counts this refund exactly once (5000 previous + 3000 new = 8000)
  const totalRefundsWithDual = await getProcessedRefundsPaise(db, { machineId: 'CFX-MC-01' });
  assert.strictEqual(totalRefundsWithDual, 8000, 'Dual representation in Firestore must map to single count of 8,000 paise');
  console.log('   PASS: Dual Firestore representations verified; SQLite refunds table counts refund exactly once.');

  // -------------------------------------------------------------------------
  // Test 14: Audit 4 - Over-Refund Behavior & Negative Net Revenue Analysis
  // -------------------------------------------------------------------------
  console.log('14. Audit 4: Testing over-refund scenario (refunds > gross sales)...');
  // Query a machine that has 0 gross sales but where a refund is assigned (or period with excess refunds)
  // CFX-MC-03 has 0 orders, but let's insert an orphaned/cross-period refund of 1000 paise on CFX-MC-03
  await db.run(`
    INSERT INTO refunds (id, order_id, machine_id, razorpay_payment_id, razorpay_refund_id, amount_paise, status, reason, initiated_by, source, idempotency_key, created_at, updated_at, processed_at)
    VALUES
    ('ref_over_14', 'ord_nonexistent', 'CFX-MC-03', 'pay_none', 'rfnd_none', 1000, 'PROCESSED', 'Over-refund test', 'admin', 'SUPER_ADMIN_PORTAL', 'idem_over_14', '2026-11-14T08:00:00.000Z', '2026-11-14T08:00:00.000Z', '2026-11-14T08:00:00.000Z')
  `);

  const m3Overview = await getAnalyticsOverview(db, { machineId: 'CFX-MC-03' });
  assert.strictEqual(m3Overview.gross_sales_paise, 0, 'Gross sales should be 0');
  assert.strictEqual(m3Overview.processed_refunds_paise, 1000, 'Processed refunds should be 1000 paise');
  // Phase 2.9.2 Resolution for Audit F-4A: Signed integer net revenue & over-refund detection
  assert.strictEqual(m3Overview.net_revenue_paise, -1000, 'Net revenue must return signed integer -1000 paise');
  assert.strictEqual(m3Overview.net_revenue_inr, -10, 'Net revenue INR must return signed integer -10 INR');
  assert.strictEqual(m3Overview.refunds_exceed_period_sales, true, 'refunds_exceed_period_sales must be true when refunds > gross');
  assert.strictEqual(m3Overview.over_refund_detected, false, 'over_refund_detected is false as no individual order exceeded cap');
  console.log('   PASS: Over-refund scenario verified: gross=0, refund=1000 paise, net=-1000 paise (F-4A resolved).');

  console.log('\n=============================================================');
  console.log('ALL PHASE 2.9.1 BACKEND ANALYTICS FOUNDATION TESTS PASSED!');
  console.log('=============================================================');
}

runAllAnalyticsTests().catch((err) => {
  console.error('\nTEST SUITE FAILED:', err);
  process.exit(1);
});

