import assert from 'assert';
import http from 'http';

process.env.JWT_SECRET =
  process.env.JWT_SECRET || 'caffix-test-jwt-secret-analytics-2026-explicit';

import jwt from 'jsonwebtoken';
import { initializeApp, getApps, deleteApp } from 'firebase-admin/app';
import { getFirestore, Firestore } from 'firebase-admin/firestore';
import app from '../index';
import { initDB, getDB } from '../config/db';
import { getJwtSecret } from '../utils/security';
import {
  ensureFirebaseReady,
  setFirestoreForTesting,
  isFirestoreActive
} from '../utils/firebase';
import {
  getAnalyticsOverview,
  getTimeSeriesAnalytics,
  getRefundsAnalytics
} from '../services/analyticsService';

const PORT = 5096;
const BASE_URL = `http://127.0.0.1:${PORT}/api`;
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

async function api(
  method: string,
  path: string,
  body?: unknown,
  token?: string
): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = {};
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined
  });
  const resBody = await res.json().catch(() => ({}));
  return { status: res.status, body: resBody };
}

async function runPhase292ApiTests() {
  console.log('\n=============================================================');
  console.log('Running CAFFIX Phase 2.9.2 — Analytics REST APIs & RBAC Tests');
  console.log('=============================================================\n');

  // 1. Initialize Firestore Emulator and SQLite DB
  for (const existingApp of getApps()) {
    await deleteApp(existingApp);
  }
  const fbApp = initializeApp({ projectId: EMULATOR_PROJECT_ID });
  const firestore = getFirestore(fbApp);
  setFirestoreForTesting({ firestoreInstance: firestore, clearStores: true });
  await clearEmulatorDatabase();

  await initDB();
  const db = getDB();

  // Clean tables safely
  await db.run('PRAGMA foreign_keys = OFF');
  await db.run('DELETE FROM refunds');
  await db.run('DELETE FROM orders');
  await db.run('DELETE FROM inventory_ledger');
  await db.run('DELETE FROM inventory');
  await db.run('DELETE FROM machine_products');
  await db.run('DELETE FROM machines');
  await db.run('PRAGMA foreign_keys = ON');

  // Insert test machines
  await db.run(
    `INSERT INTO machines (id, machine_name, location, status, owner_id, desired_mode) VALUES
     ('CFX-MC-01', 'Kiosk Alpha', 'Main Lobby', 'online', 'usr_owner_1', 'RUNNING'),
     ('CFX-MC-02', 'Kiosk Beta', 'North Wing', 'online', 'usr_owner_2', 'RUNNING'),
     ('CFX-MC-03', 'Kiosk Gamma', 'Food Court', 'online', null, 'RUNNING')`
  );

  // Sync machines to Firestore emulator
  await firestore.collection('machines').doc('CFX-MC-01').set({
    id: 'CFX-MC-01',
    machine_name: 'Kiosk Alpha',
    location: 'Main Lobby',
    owner_id: 'usr_owner_1',
    status: 'online',
    desired_mode: 'RUNNING',
    inventory: { milk_level: 80, coffee_level: 90 }
  });
  await firestore.collection('machines').doc('CFX-MC-02').set({
    id: 'CFX-MC-02',
    machine_name: 'Kiosk Beta',
    location: 'North Wing',
    owner_id: 'usr_owner_2',
    status: 'online',
    desired_mode: 'RUNNING',
    inventory: { milk_level: 70, coffee_level: 85 }
  });

  // Start HTTP test server
  const server: http.Server = await new Promise((resolve) => {
    const s = app.listen(PORT, '127.0.0.1', () => resolve(s));
  });

  const secret = getJwtSecret();

  // Mint JWT tokens for testing
  const adminToken = jwt.sign(
    { id: 'usr_admin', email: 'admin@caffix.com', role: 'admin', portal: 'admin' },
    secret,
    { expiresIn: '1h' }
  );
  const kioskAdminToken = jwt.sign(
    { id: 'usr_kiosk_admin', email: 'ka@caffix.com', role: 'admin', portal: 'admin', scope: 'kiosk_admin', machine_id: 'CFX-MC-01' },
    secret,
    { expiresIn: '1h' }
  );
  const owner1Token = jwt.sign(
    { id: 'usr_owner_1', email: 'owner1@caffix.com', role: 'owner', portal: 'owner' },
    secret,
    { expiresIn: '1h' }
  );
  const owner2Token = jwt.sign(
    { id: 'usr_owner_2', email: 'owner2@caffix.com', role: 'owner', portal: 'owner' },
    secret,
    { expiresIn: '1h' }
  );
  const emptyOwnerToken = jwt.sign(
    { id: 'usr_owner_empty', email: 'empty@caffix.com', role: 'owner', portal: 'owner' },
    secret,
    { expiresIn: '1h' }
  );
  const kioskToken = jwt.sign(
    { id: 'kiosk_token_1', role: 'kiosk', machine_id: 'CFX-MC-01' },
    secret,
    { expiresIn: '1h' }
  );

  try {
    // Seed orders and refunds
    // Order 1 on MC-01 (Paid & Dispensed, 100 INR)
    await db.run(`
      INSERT INTO orders (id, machine_id, product_id, amount, captured_amount_paise, status, dispense_status, razorpay_payment_id, created_at, total_refunded_amount_paise)
      VALUES ('ord_101', 'CFX-MC-01', 1, 100, 10000, 'PAID', 'DISPENSED', 'pay_101', '2026-11-14T05:00:00.000Z', 0)
    `);
    // Order 2 on MC-01 (Paid, 120 INR, Partial refund 40 INR)
    await db.run(`
      INSERT INTO orders (id, machine_id, product_id, amount, captured_amount_paise, status, dispense_status, razorpay_payment_id, created_at, total_refunded_amount_paise)
      VALUES ('ord_102', 'CFX-MC-01', 2, 120, 12000, 'PAID', 'DISPENSED', 'pay_102', '2026-11-14T06:00:00.000Z', 4000)
    `);
    // Order 3 on MC-02 (Paid, 150 INR)
    await db.run(`
      INSERT INTO orders (id, machine_id, product_id, amount, captured_amount_paise, status, dispense_status, razorpay_payment_id, created_at, total_refunded_amount_paise)
      VALUES ('ord_201', 'CFX-MC-02', 3, 150, 15000, 'COMPLETED', 'COMPLETED', 'pay_201', '2026-11-14T07:00:00.000Z', 0)
    `);
    // Refund on Order 2 (4000 paise)
    await db.run(`
      INSERT INTO refunds (id, order_id, machine_id, razorpay_payment_id, razorpay_refund_id, amount_paise, status, reason, initiated_by, source, idempotency_key, created_at, updated_at)
      VALUES ('ref_102', 'ord_102', 'CFX-MC-01', 'pay_102', 'rfnd_102', 4000, 'PROCESSED', 'CUSTOMER_REQUEST', 'admin', 'SUPER_ADMIN_PORTAL', 'idem_ref_102', '2026-11-14T08:00:00.000Z', '2026-11-14T08:00:00.000Z')
    `);
    // Inventory movements
    await db.run(`
      INSERT INTO inventory_ledger (id, machine_id, ingredient, movement_type, quantity, balance_after, reason, idempotency_key, created_at)
      VALUES
      ('inv_1', 'CFX-MC-01', 'milk', 'DEDUCTION', 20, 80, 'Order ord_101', 'idem_inv_1', '2026-11-14T05:00:00.000Z'),
      ('inv_2', 'CFX-MC-01', 'milk', 'REFILL', 100, 180, 'Morning refill', 'idem_inv_2', '2026-11-14T04:00:00.000Z')
    `);

    // -------------------------------------------------------------------------
    // 1. RBAC & Authentication Rejection Tests
    // -------------------------------------------------------------------------
    console.log('1. Testing RBAC & Authentication Rejections...');
    
    // 1.1 Missing token -> 401
    const resNoToken = await api('GET', '/analytics/overview');
    assert.strictEqual(resNoToken.status, 401, 'Unauthenticated request must return 401');
    console.log('   PASS: Unauthenticated request rejected with HTTP 401.');

    // 1.2 Kiosk token -> 403
    const resKiosk = await api('GET', '/analytics/overview', undefined, kioskToken);
    assert.strictEqual(resKiosk.status, 403, 'Kiosk token must return 403');
    console.log('   PASS: Kiosk role rejected with HTTP 403.');

    // 1.3 Kiosk-Admin token -> 403
    const resKioskAdmin = await api('GET', '/analytics/overview', undefined, kioskAdminToken);
    assert.strictEqual(resKioskAdmin.status, 403, 'Kiosk admin token must return 403');
    console.log('   PASS: Kiosk admin session rejected with HTTP 403.');

    // 1.4 Owner 2 accessing Owner 1's machine -> 403
    const resOwnerCross = await api('GET', '/analytics/overview?machine_id=CFX-MC-01', undefined, owner2Token);
    assert.strictEqual(resOwnerCross.status, 403, 'Owner accessing another owner machine must return 403');
    console.log('   PASS: Cross-owner machine access rejected with HTTP 403.');

    // 1.5 Non-existent machine -> 404
    const resNotFound = await api('GET', '/analytics/overview?machine_id=CFX-MC-NONEXISTENT', undefined, adminToken);
    assert.strictEqual(resNotFound.status, 404, 'Non-existent machine must return 404');
    console.log('   PASS: Non-existent machine query rejected with HTTP 404.');

    // -------------------------------------------------------------------------
    // 2. Super Admin Fleet vs Filtered Access
    // -------------------------------------------------------------------------
    console.log('2. Testing Super Admin Fleet vs Single-Machine Access...');
    // Fleet overview (both MC-01 and MC-02)
    const adminFleet = await api('GET', '/analytics/overview', undefined, adminToken);
    assert.strictEqual(adminFleet.status, 200);
    // MC-01 (10000 + 12000) + MC-02 (15000) = 37,000 paise gross
    assert.strictEqual(adminFleet.body.data.gross_sales_paise, 37000);
    assert.strictEqual(adminFleet.body.data.processed_refunds_paise, 4000);
    assert.strictEqual(adminFleet.body.data.net_revenue_paise, 33000);
    assert.strictEqual(adminFleet.body.data.paid_orders_count, 3);
    console.log('   PASS: Super Admin fleet overview aggregates all machines accurately.');

    // Filtered to MC-01
    const adminMC01 = await api('GET', '/analytics/overview?machine_id=CFX-MC-01', undefined, adminToken);
    assert.strictEqual(adminMC01.status, 200);
    assert.strictEqual(adminMC01.body.data.gross_sales_paise, 22000);
    assert.strictEqual(adminMC01.body.data.processed_refunds_paise, 4000);
    assert.strictEqual(adminMC01.body.data.net_revenue_paise, 18000);
    assert.strictEqual(adminMC01.body.data.paid_orders_count, 2);
    console.log('   PASS: Super Admin machine-filtered query isolated to specified machine.');

    // -------------------------------------------------------------------------
    // 3. Owner Scoped Access & Empty Machine Assignments
    // -------------------------------------------------------------------------
    console.log('3. Testing Owner Scoped Access & Empty Assignments...');
    // Owner 1 queries without machine_id -> auto-scoped to CFX-MC-01
    const owner1Overview = await api('GET', '/analytics/overview', undefined, owner1Token);
    assert.strictEqual(owner1Overview.status, 200);
    assert.strictEqual(owner1Overview.body.data.gross_sales_paise, 22000);
    assert.strictEqual(owner1Overview.body.data.net_revenue_paise, 18000);
    console.log('   PASS: Owner 1 auto-scoped to assigned machine CFX-MC-01.');

    // Owner with 0 machines assigned -> returns empty metrics, never fleet
    const emptyOverview = await api('GET', '/analytics/overview', undefined, emptyOwnerToken);
    assert.strictEqual(emptyOverview.status, 200);
    assert.strictEqual(emptyOverview.body.data.gross_sales_paise, 0);
    assert.strictEqual(emptyOverview.body.data.processed_refunds_paise, 0);
    assert.strictEqual(emptyOverview.body.data.net_revenue_paise, 0);
    assert.strictEqual(emptyOverview.body.data.paid_orders_count, 0);

    const emptyMachines = await api('GET', '/analytics/machines', undefined, emptyOwnerToken);
    assert.strictEqual(emptyMachines.status, 200);
    assert.strictEqual(emptyMachines.body.data.length, 0);
    console.log('   PASS: Owner with 0 assigned machines strictly returns empty metrics.');

    // -------------------------------------------------------------------------
    // 4. Testing All 6 Analytics Endpoints
    // -------------------------------------------------------------------------
    console.log('4. Testing All 6 Analytics Endpoints...');
    // 4.1 Overview
    const epOverview = await api('GET', '/analytics/overview', undefined, adminToken);
    assert.strictEqual(epOverview.status, 200);
    assert.ok(epOverview.body.data.gross_sales_paise !== undefined);

    // 4.2 Time Series
    const epTimeSeries = await api('GET', '/analytics/time-series?interval=day', undefined, adminToken);
    assert.strictEqual(epTimeSeries.status, 200);
    assert.ok(Array.isArray(epTimeSeries.body.data));
    assert.ok(epTimeSeries.body.data.length >= 1);

    // 4.3 Machines
    const epMachines = await api('GET', '/analytics/machines', undefined, adminToken);
    assert.strictEqual(epMachines.status, 200);
    assert.ok(Array.isArray(epMachines.body.data));
    assert.ok(epMachines.body.data.some((m: any) => m.machine_id === 'CFX-MC-01'));

    // 4.4 Products
    const epProducts = await api('GET', '/analytics/products', undefined, adminToken);
    assert.strictEqual(epProducts.status, 200);
    assert.ok(Array.isArray(epProducts.body.data));

    // 4.5 Inventory
    const epInventory = await api('GET', '/analytics/inventory?machine_id=CFX-MC-01', undefined, adminToken);
    assert.strictEqual(epInventory.status, 200);
    assert.ok(Array.isArray(epInventory.body.data));
    const milkItem = epInventory.body.data.find((i: any) => i.ingredient === 'milk');
    assert.ok(milkItem);
    assert.strictEqual(milkItem.total_consumed, 20);
    assert.strictEqual(milkItem.total_refilled, 100);

    // 4.6 Refunds
    const epRefunds = await api('GET', '/analytics/refunds', undefined, adminToken);
    assert.strictEqual(epRefunds.status, 200);
    assert.strictEqual(epRefunds.body.data.total_refunds_count, 1);
    assert.strictEqual(epRefunds.body.data.processed_refunds_paise, 4000);
    assert.strictEqual(epRefunds.body.data.recent_refunds.length, 1);
    assert.strictEqual(epRefunds.body.data.recent_refunds[0].id, 'ref_102');
    console.log('   PASS: All 6 analytics endpoints successfully respond with valid structures.');

    // -------------------------------------------------------------------------
    // 5. Zod Query Validation
    // -------------------------------------------------------------------------
    console.log('5. Testing Zod Query Validation...');
    // Invalid calendar date
    const resFeb31 = await api('GET', '/analytics/overview?start_date=2026-02-31', undefined, adminToken);
    assert.strictEqual(resFeb31.status, 400, 'Feb 31 must be rejected');

    // Invalid non-date string
    const resGarbageDate = await api('GET', '/analytics/overview?start_date=invalid-string', undefined, adminToken);
    assert.strictEqual(resGarbageDate.status, 400);

    // start_date after end_date
    const resInverted = await api('GET', '/analytics/overview?start_date=2026-11-15&end_date=2026-11-10', undefined, adminToken);
    assert.strictEqual(resInverted.status, 400);

    // Range > 366 days
    const resExcessiveRange = await api('GET', '/analytics/overview?start_date=2025-01-01&end_date=2026-03-01', undefined, adminToken);
    assert.strictEqual(resExcessiveRange.status, 400);

    // Invalid machine_id format
    const resInvalidMid = await api('GET', '/analytics/overview?machine_id=CFX%24%21%23', undefined, adminToken);
    assert.strictEqual(resInvalidMid.status, 400);
    console.log('   PASS: Zod validation correctly rejects invalid dates, inverted ranges, >366 day windows, and bad IDs.');

    // -------------------------------------------------------------------------
    // 6. Financial Correctness: Signed Net Revenue & Over-Refund (F-4A)
    // -------------------------------------------------------------------------
    console.log('6. Testing Signed Net Revenue & Over-Refund Detection (F-4A)...');
    // Scenario 6.1: Cross-period refund exceeding period sales
    // Machine CFX-MC-03 has 0 sales in this window, but add a 5000 paise refund
    await db.run(`
      INSERT INTO refunds (id, order_id, machine_id, razorpay_payment_id, razorpay_refund_id, amount_paise, status, reason, initiated_by, source, idempotency_key, created_at, updated_at)
      VALUES ('ref_f4a_cross', 'ord_101', 'CFX-MC-03', 'pay_101', 'rfnd_f4a', 5000, 'PROCESSED', 'CROSS_PERIOD', 'admin', 'SUPER_ADMIN_PORTAL', 'idem_f4a_1', '2026-11-14T09:00:00.000Z', '2026-11-14T09:00:00.000Z')
    `);
    const resF4a = await api('GET', '/analytics/overview?machine_id=CFX-MC-03', undefined, adminToken);
    assert.strictEqual(resF4a.status, 200);
    assert.strictEqual(resF4a.body.data.gross_sales_paise, 0);
    assert.strictEqual(resF4a.body.data.processed_refunds_paise, 5000);
    assert.strictEqual(resF4a.body.data.net_revenue_paise, -5000, 'Net revenue must be signed -5000 paise');
    assert.strictEqual(resF4a.body.data.net_revenue_inr, -50, 'Net revenue INR must be signed -50 INR');
    assert.strictEqual(resF4a.body.data.refunds_exceed_period_sales, true, 'refunds_exceed_period_sales must be true');
    assert.strictEqual(resF4a.body.data.over_refund_detected, false, 'over_refund_detected must be false for normal cross-period refund');

    // Scenario 6.2: True order-level corruption
    await db.run(`
      INSERT INTO orders (id, machine_id, product_id, amount, captured_amount_paise, status, razorpay_payment_id, created_at, total_refunded_amount_paise)
      VALUES ('ord_corrupt', 'CFX-MC-03', 1, 100, 10000, 'PAID', 'pay_corrupt', '2026-11-14T10:00:00.000Z', 15000)
    `);
    const resCorrupt = await api('GET', '/analytics/overview?machine_id=CFX-MC-03', undefined, adminToken);
    assert.strictEqual(resCorrupt.body.data.over_refund_detected, true, 'over_refund_detected must trigger on order corruption');
    console.log('   PASS: Signed negative net revenue and order-level over-refund detection verified.');

    // -------------------------------------------------------------------------
    // 7. Data Privacy: No Sensitive Information Leakage
    // -------------------------------------------------------------------------
    console.log('7. Testing Data Privacy & Sensitive Info Masking...');
    const refundDataStr = JSON.stringify(epRefunds.body.data);
    assert.ok(!refundDataStr.includes('pay_102'), 'Must not leak razorpay_payment_id in analytics API');
    assert.ok(!refundDataStr.includes('rfnd_102'), 'Must not leak razorpay_refund_id in analytics API');
    console.log('   PASS: Payment IDs and gateway secrets are strictly excluded from response payloads.');

    // -------------------------------------------------------------------------
    // 8. Firestore and SQLite Result Equivalence
    // -------------------------------------------------------------------------
    console.log('8. Testing Firestore and SQLite Result Equivalence...');
    // Seed Firestore emulator with identical records for CFX-MC-01
    await firestore.collection('orders').doc('ord_101').set({
      id: 'ord_101',
      machine_id: 'CFX-MC-01',
      product_id: 1,
      amount: 100,
      captured_amount_paise: 10000,
      status: 'PAID',
      dispense_status: 'DISPENSED',
      dispensed: 1,
      razorpay_payment_id: 'pay_101',
      created_at: '2026-11-14T05:00:00.000Z',
      total_refunded_amount_paise: 0
    });
    await firestore.collection('orders').doc('ord_102').set({
      id: 'ord_102',
      machine_id: 'CFX-MC-01',
      product_id: 2,
      amount: 120,
      captured_amount_paise: 12000,
      status: 'PAID',
      dispense_status: 'DISPENSED',
      dispensed: 1,
      razorpay_payment_id: 'pay_102',
      created_at: '2026-11-14T06:00:00.000Z',
      total_refunded_amount_paise: 4000
    });
    // Canonical root refunds collection in Firestore
    await firestore.collection('refunds').doc('ref_102').set({
      id: 'ref_102',
      order_id: 'ord_102',
      machine_id: 'CFX-MC-01',
      amount_paise: 4000,
      status: 'PROCESSED',
      reason: 'CUSTOMER_REQUEST',
      source: 'SUPER_ADMIN_PORTAL',
      created_at: '2026-11-14T08:00:00.000Z'
    });
    // Also write nested subcollection mirror to verify it does NOT cause double-counting
    await firestore.collection('orders').doc('ord_102').collection('refunds').doc('ref_102').set({
      id: 'ref_102',
      order_id: 'ord_102',
      amount_paise: 4000,
      status: 'PROCESSED'
    });

    const firestoreOverview = await getAnalyticsOverview(db, {
      machineId: 'CFX-MC-01',
      forceSource: 'firestore'
    });
    const sqliteOverview = await getAnalyticsOverview(db, {
      machineId: 'CFX-MC-01',
      forceSource: 'sqlite'
    });

    assert.strictEqual(firestoreOverview.gross_sales_paise, sqliteOverview.gross_sales_paise);
    assert.strictEqual(firestoreOverview.processed_refunds_paise, sqliteOverview.processed_refunds_paise);
    assert.strictEqual(firestoreOverview.net_revenue_paise, sqliteOverview.net_revenue_paise);
    assert.strictEqual(firestoreOverview.paid_orders_count, sqliteOverview.paid_orders_count);
    assert.strictEqual(firestoreOverview.dispensed_count, sqliteOverview.dispensed_count);
    assert.strictEqual(firestoreOverview.processed_refunds_paise, 4000, 'Dual Firestore representation must count refund exactly once');
    console.log('   PASS: Firestore and SQLite produce mathematically equivalent analytics results.');

    // -------------------------------------------------------------------------
    // 9. Firestore Fail-Closed in Strict Mode
    // -------------------------------------------------------------------------
    console.log('9. Testing Strict Mode Fail-Closed Behavior...');
    process.env.STRICT_FIREBASE_VALIDATION = 'true';
    setFirestoreForTesting({ firestoreInstance: null }); // Simulate Firestore unavailable

    try {
      await getAnalyticsOverview(db, { machineId: 'CFX-MC-01' });
      assert.fail('Should have failed closed with ServiceUnavailableError');
    } catch (err: any) {
      assert.strictEqual(err.statusCode || err.status, 503, 'Must throw HTTP 503 when Firestore is required but unavailable');
      console.log('   PASS: Analytics fails closed (HTTP 503) without silent SQLite fallback in strict mode.');
    } finally {
      delete process.env.STRICT_FIREBASE_VALIDATION;
      setFirestoreForTesting({ firestoreInstance: firestore });
    }

    // -------------------------------------------------------------------------
    // 10. Asia/Kolkata Calendar Boundaries
    // -------------------------------------------------------------------------
    console.log('10. Testing Asia/Kolkata Calendar Boundaries...');
    // Order placed on Nov 13 at 20:00 UTC = Nov 14 at 01:30 AM IST (+05:30)
    await db.run(`
      INSERT INTO orders (id, machine_id, product_id, amount, captured_amount_paise, status, dispense_status, razorpay_payment_id, created_at, total_refunded_amount_paise)
      VALUES ('ord_ist_boundary', 'CFX-MC-01', 1, 100, 10000, 'PAID', 'DISPENSED', 'pay_ist', '2026-11-13T20:00:00.000Z', 0)
    `);
    const istTimeSeries = await getTimeSeriesAnalytics(db, {
      machineId: 'CFX-MC-01',
      timeframe: {
        startDate: '2026-11-14T00:00:00+05:30',
        endDate: '2026-11-14T23:59:59+05:30',
        timeZone: 'Asia/Kolkata'
      },
      interval: 'day'
    });
    const nov14Bucket = istTimeSeries.find((b) => b.bucket_key === '2026-11-14');
    assert.ok(nov14Bucket, 'Nov 14 IST bucket must exist');
    // ord_ist_boundary should be grouped into Nov 14 in Asia/Kolkata!
    assert.ok(nov14Bucket.gross_sales_paise >= 32000, 'Order created at 20:00 UTC Nov 13 must fall into Nov 14 IST bucket');
    console.log('   PASS: Asia/Kolkata calendar day boundaries accurately bucket late-evening UTC records.');

    // -------------------------------------------------------------------------
    // 11. Phase 2.9.4.1 Security, RBAC, CORS & Route Validation Regressions
    // -------------------------------------------------------------------------
    console.log('11. Testing Phase 2.9.4.1 Reconciliation RBAC/Scope, CORS Preflight & Refill Validation...');

    // Ensure ord_101, ord_102, ord_201 exist in Firestore Emulator as well for reconciliation lookups
    await firestore.collection('orders').doc('ord_101').set({
      id: 'ord_101', machine_id: 'CFX-MC-01', product_id: 1, amount: 100,
      captured_amount_paise: 10000, status: 'PAID', dispense_status: 'DISPENSED',
      razorpay_payment_id: 'pay_101', refund_status: 'NONE',
      total_refunded_amount_paise: 0, pending_refund_amount_paise: 0,
      created_at: '2026-11-14T05:00:00.000Z'
    });
    await firestore.collection('orders').doc('ord_201').set({
      id: 'ord_201', machine_id: 'CFX-MC-02', product_id: 3, amount: 150,
      captured_amount_paise: 15000, status: 'COMPLETED', dispense_status: 'COMPLETED',
      razorpay_payment_id: 'pay_201', refund_status: 'NONE',
      total_refunded_amount_paise: 0, pending_refund_amount_paise: 0,
      created_at: '2026-11-14T07:00:00.000Z'
    });

    // H-1: Owner with 0 machines MUST receive 0 reconciliation orders/totals
    const zeroOwnerRec = await api('GET', '/reconciliation/report', undefined, emptyOwnerToken);
    assert.strictEqual(zeroOwnerRec.status, 200);
    assert.strictEqual(zeroOwnerRec.body.machine_scope, 'NONE');
    assert.strictEqual(zeroOwnerRec.body.summary.total_orders, 0);
    assert.strictEqual(zeroOwnerRec.body.data.length, 0);

    // H-1: Zero-machine owner denied single-order and inventory ledger endpoints
    assert.strictEqual((await api('GET', '/reconciliation/orders/ord_101', undefined, emptyOwnerToken)).status, 403);
    assert.strictEqual((await api('GET', '/reconciliation/inventory/CFX-MC-01', undefined, emptyOwnerToken)).status, 403);

    // H-1: Owner 1 (CFX-MC-01) scoped strictly to CFX-MC-01, blocked on CFX-MC-02
    const owner1Rec = await api('GET', '/reconciliation/report', undefined, owner1Token);
    assert.strictEqual(owner1Rec.status, 200);
    assert.ok(owner1Rec.body.data.every((r: any) => r.machine_id === 'CFX-MC-01'), 'Owner 1 must only receive CFX-MC-01 orders');
    assert.strictEqual((await api('GET', '/reconciliation/report?machine_id=CFX-MC-02', undefined, owner1Token)).status, 403);
    assert.strictEqual((await api('GET', '/reconciliation/orders/ord_201', undefined, owner1Token)).status, 403);
    assert.strictEqual((await api('GET', '/reconciliation/inventory/CFX-MC-02', undefined, owner1Token)).status, 403);
    assert.strictEqual((await api('GET', '/reconciliation/orders/ord_101', undefined, owner1Token)).status, 200);

    // H-2: kiosk_admin, kiosk, and unauthenticated tokens MUST be blocked from all reconciliation routes
    for (const ep of ['/reconciliation/report', '/reconciliation/orders/ord_101', '/reconciliation/inventory/CFX-MC-01']) {
      assert.strictEqual((await api('GET', ep, undefined, undefined)).status, 401, `Unauthenticated ${ep} -> 401`);
      assert.strictEqual((await api('GET', ep, undefined, kioskToken)).status, 403, `Kiosk token ${ep} -> 403`);
      assert.strictEqual((await api('GET', ep, undefined, kioskAdminToken)).status, 403, `kiosk_admin token ${ep} -> 403`);
      assert.strictEqual((await api('GET', ep, undefined, adminToken)).status, 200, `Full Super Admin ${ep} -> 200`);
    }

    // M-2: CORS Preflight OPTIONS accepts Idempotency-Key & x-portal for allowed origin, rejects unknown origin
    const preflightAllowed = await fetch(`${BASE_URL}/machines/CFX-MC-01/refill`, {
      method: 'OPTIONS',
      headers: {
        Origin: 'http://localhost:5173',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'Content-Type, Authorization, Idempotency-Key, x-portal, x-razorpay-signature, x-machine-id'
      }
    });
    assert.ok(preflightAllowed.status === 204 || preflightAllowed.status === 200, `CORS preflight returned ${preflightAllowed.status}`);
    assert.strictEqual(preflightAllowed.headers.get('access-control-allow-origin'), 'http://localhost:5173');
    const allowedHeadersLower = (preflightAllowed.headers.get('access-control-allow-headers') || '').toLowerCase();
    for (const h of ['idempotency-key', 'x-portal', 'x-razorpay-signature', 'x-machine-id']) {
      assert.ok(allowedHeadersLower.includes(h), `CORS Access-Control-Allow-Headers missing '${h}': ${allowedHeadersLower}`);
    }

    const preflightDenied = await fetch(`${BASE_URL}/machines/CFX-MC-01/refill`, {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://untrusted.example.com',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'Authorization, Idempotency-Key'
      }
    });
    assert.strictEqual(preflightDenied.headers.get('access-control-allow-origin'), null, 'Disallowed origin must not receive Access-Control-Allow-Origin');

    // L-4 Part B: HTTP Zod validation on POST /api/machines/:machine_id/refill + idempotency preserved
    const badTargetRes = await api('POST', '/machines/CFX-MC-01/refill', { ingredient: 'coffee', target: 150 }, adminToken);
    assert.strictEqual(badTargetRes.status, 400, 'Out-of-range refill target >100 must fail Zod validation with 400');

    const badQtyRes = await fetch(`${BASE_URL}/machines/CFX-MC-01/refill`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json', 'Idempotency-Key': `k-bad-${Date.now()}` },
      body: JSON.stringify({ ingredient: 'coffee', quantity: -5 })
    });
    assert.strictEqual(badQtyRes.status, 400, 'Negative refill quantity must fail Zod validation with 400');

    const badIngRes = await api('POST', '/machines/CFX-MC-01/refill', { ingredient: 'matcha', target: 80 }, adminToken);
    assert.strictEqual(badIngRes.status, 400, 'Invalid ingredient must fail Zod validation with 400');

    const longReasonRes = await api('POST', '/machines/CFX-MC-01/refill', { ingredient: 'coffee', target: 80, reason: 'x'.repeat(501) }, adminToken);
    assert.strictEqual(longReasonRes.status, 400, 'Reason >500 chars must fail Zod validation with 400');

    const validKey = `k-route-refill-${Date.now()}`;
    const validRefill1 = await fetch(`${BASE_URL}/machines/CFX-MC-01/refill`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json', 'Idempotency-Key': validKey },
      body: JSON.stringify({ ingredient: 'coffee', quantity: 5, reason: 'Route Zod + Idempotency test' })
    });
    assert.strictEqual(validRefill1.status, 200);
    const body1 = await validRefill1.json();
    assert.strictEqual(body1.deduplicated, false);

    const replayRefill = await fetch(`${BASE_URL}/machines/CFX-MC-01/refill`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json', 'Idempotency-Key': validKey },
      body: JSON.stringify({ ingredient: 'coffee', quantity: 5, reason: 'Route Zod + Idempotency test' })
    });
    assert.strictEqual(replayRefill.status, 200);
    assert.strictEqual((await replayRefill.json()).deduplicated, true);

    const conflictRefill = await fetch(`${BASE_URL}/machines/CFX-MC-01/refill`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json', 'Idempotency-Key': validKey },
      body: JSON.stringify({ ingredient: 'coffee', quantity: 10 })
    });
    assert.strictEqual(conflictRefill.status, 409);

    console.log('   PASS: H-1, H-2, M-2, and L-4 Part B HTTP integration regressions verified.');

    console.log('\n=============================================================');
    console.log('ALL PHASE 2.9.2 ANALYTICS REST API & RBAC TESTS PASSED!');
    console.log('=============================================================\n');
  } finally {
    server.close();
    process.exit(0);
  }
}

runPhase292ApiTests().catch((err) => {
  console.error('\nTEST SUITE FAILED:', err.stack || err);
  process.exit(1);
});
