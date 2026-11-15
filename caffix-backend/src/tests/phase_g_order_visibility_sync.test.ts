import assert from 'assert';
import http from 'http';
import jwt from 'jsonwebtoken';
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import { initializeApp, getApps, deleteApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

const EMULATOR_HOST = '127.0.0.1:8088';
const EMULATOR_PROJECT_ID = 'demo-caffix-emulator';

process.env.FIRESTORE_EMULATOR_HOST = EMULATOR_HOST;
process.env.FIREBASE_PROJECT_ID = EMULATOR_PROJECT_ID;
process.env.VERCEL = '1';
delete process.env.VERCEL_ENV;
delete process.env.STRICT_FIREBASE_VALIDATION;
process.env.JWT_SECRET = 'phase-g-order-visibility-sync-test-secret-2026';
process.env.KIOSK_SECRET = 'phase-g-order-visibility-kiosk-secret-2026';
process.env.KIOSK_ADMIN_ENABLED = 'false';

import app from '../index';
import { initDB, getDB, resetMockDatabaseForColdStartSimulation } from '../config/db';
import {
  setFirestoreForTesting,
  resetFirestoreSeedStateForTesting,
  ensureFirestoreSeeded,
  syncOrderToFirebase,
  getAuthoritativeOrderById,
  getAuthoritativeOrderByRazorpayOrderId,
  getAuthoritativeOrders
} from '../utils/firebase';
import { getAnalyticsOverview } from '../services/analyticsService';
import { getJwtSecret } from '../utils/security';

const PORT = 5098;
const BASE_URL = `http://127.0.0.1:${PORT}/api`;

async function clearEmulatorDatabase() {
  const url = `http://${EMULATOR_HOST}/emulator/v1/projects/${EMULATOR_PROJECT_ID}/databases/(default)/documents`;
  const res = await fetch(url, { method: 'DELETE' });
  if (!res.ok) {
    throw new Error(`Failed to clear emulator database: HTTP ${res.status}`);
  }
}

async function api(method: string, path: string, token?: string, body?: unknown) {
  const headers: Record<string, string> = {};
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

async function createSqliteOrdersDb() {
  const sdb = await open({
    filename: ':memory:',
    driver: sqlite3.Database
  });
  await sdb.run('PRAGMA foreign_keys = ON');
  await sdb.exec(`
    CREATE TABLE products (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      price INTEGER NOT NULL,
      description TEXT,
      image TEXT
    );
    CREATE TABLE machines (
      id TEXT PRIMARY KEY,
      machine_name TEXT NOT NULL,
      location TEXT,
      desired_mode TEXT DEFAULT 'RUNNING',
      status TEXT DEFAULT 'online',
      last_seen TEXT,
      kiosk_token TEXT,
      owner_id TEXT,
      updated_at TEXT
    );
    CREATE TABLE orders (
      id TEXT PRIMARY KEY,
      product_id INTEGER NOT NULL,
      amount INTEGER NOT NULL,
      status TEXT NOT NULL,
      machine_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      razorpay_order_id TEXT,
      razorpay_payment_id TEXT,
      razorpay_signature TEXT,
      extra_sugar INTEGER DEFAULT 0,
      base TEXT DEFAULT 'water',
      dispense_status TEXT DEFAULT 'PENDING',
      customer_name TEXT,
      customer_email TEXT,
      updated_at TEXT,
      dispensed_at TEXT,
      dispense_started_at TEXT,
      refund_status TEXT DEFAULT 'NONE',
      total_refunded_amount_paise INTEGER DEFAULT 0,
      pending_refund_amount_paise INTEGER DEFAULT 0,
      last_refunded_at TEXT,
      captured_amount_paise INTEGER DEFAULT NULL,
      FOREIGN KEY (product_id) REFERENCES products(id),
      FOREIGN KEY (machine_id) REFERENCES machines(id)
    );
    CREATE TABLE refunds (
      id TEXT PRIMARY KEY,
      order_id TEXT NOT NULL,
      machine_id TEXT NOT NULL,
      razorpay_payment_id TEXT,
      razorpay_refund_id TEXT,
      amount_paise INTEGER NOT NULL,
      currency TEXT DEFAULT 'INR',
      status TEXT NOT NULL,
      reason TEXT,
      notes TEXT,
      initiated_by TEXT,
      source TEXT,
      idempotency_key TEXT UNIQUE NOT NULL,
      error_code TEXT,
      error_description TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      processed_at TEXT
    );
  `);
  await sdb.run('INSERT INTO products (id, name, price, description) VALUES (?, ?, ?, ?)', [3, 'Hazel Gold', 150, 'Hazelnut']);
  await sdb.run('INSERT INTO products (id, name, price, description) VALUES (?, ?, ?, ?)', [4, 'Irish Emerald', 160, 'Irish']);
  await sdb.run('INSERT INTO machines (id, machine_name, location, owner_id) VALUES (?, ?, ?, ?)', ['CFX-MC-01', 'ONE', 'Loc 1', 'usr_owner_1']);
  await sdb.run('INSERT INTO machines (id, machine_name, location, owner_id) VALUES (?, ?, ?, ?)', ['CFX-MC-02', 'TWO', 'Loc 2', 'usr_owner_2']);
  await sdb.run('INSERT INTO machines (id, machine_name, location, owner_id) VALUES (?, ?, ?, ?)', ['CFX-MC-03', 'THREE', 'Loc 3', null]);
  return sdb;
}

async function runTests() {
  console.log('\n======================================================================');
  console.log('Running CAFFIX Phase G — Order Visibility & Portal Sync Regression Tests');
  console.log('======================================================================\n');

  for (const a of getApps()) await deleteApp(a);
  const fbApp = initializeApp({ projectId: EMULATOR_PROJECT_ID });
  const firestore = getFirestore(fbApp);
  setFirestoreForTesting({ firestoreInstance: firestore, clearStores: true });
  resetFirestoreSeedStateForTesting();
  await clearEmulatorDatabase();

  await initDB();
  const db = getDB();

  const nowIso = new Date().toISOString();
  const earlierIso = new Date(Date.now() - 3600_000).toISOString();

  // Seed machines in Firestore & MockStore
  const machines = [
    { id: 'CFX-MC-01', machine_name: 'ONE', location: 'Loc 1', status: 'online', owner_id: 'usr_owner_1', desired_mode: 'RUNNING', last_seen: nowIso },
    { id: 'CFX-MC-02', machine_name: 'TWO', location: 'Loc 2', status: 'online', owner_id: 'usr_owner_2', desired_mode: 'RUNNING', last_seen: nowIso },
    { id: 'CFX-MC-03', machine_name: 'THREE', location: 'Loc 3', status: 'online', owner_id: null, desired_mode: 'RUNNING', last_seen: null }
  ];
  for (const m of machines) {
    await firestore.collection('machines').doc(m.id).set(m);
    await db.run(
      'INSERT OR REPLACE INTO machines (id, machine_name, location, status, owner_id, desired_mode) VALUES (?, ?, ?, ?, ?, ?)',
      [m.id, m.machine_name, m.location, m.status, m.owner_id, m.desired_mode]
    );
  }

  // Seed authoritative orders including exact Production replicas + malformed orphan doc + missing timestamps/refs
  const seedOrders = [
    {
      id: 'CFX-43016777',
      machine_id: 'CFX-MC-01',
      product_id: 4,
      product_name: 'Irish Emerald',
      coffee: 'Irish Emerald',
      amount: 1,
      captured_amount_paise: 100,
      status: 'PAID',
      dispense_status: 'QUEUED',
      refund_status: 'NONE',
      total_refunded_amount_paise: 0,
      pending_refund_amount_paise: 0,
      razorpay_order_id: 'order_U0SSAOWbJN2HXp',
      razorpay_payment_id: 'pay_U0SSo4M9u5MQjq',
      customer_name: 'Customer One',
      customer_email: 'c1@example.com',
      created_at: earlierIso,
      updated_at: nowIso,
      dispense_started_at: nowIso,
      dispensed_at: null,
      base: 'milk',
      extra_sugar: 1
    },
    {
      id: 'CFX-77486398',
      machine_id: 'CFX-MC-02',
      product_id: 3,
      product_name: 'Hazel Gold',
      coffee: 'Hazel Gold',
      amount: 1,
      captured_amount_paise: 100,
      status: 'PAID',
      dispense_status: 'QUEUED',
      refund_status: 'NONE',
      total_refunded_amount_paise: 0,
      pending_refund_amount_paise: 0,
      razorpay_order_id: 'order_U0SWn94LNw9ubZ',
      razorpay_payment_id: 'pay_U0SWwwfKgwsWhd',
      created_at: earlierIso,
      updated_at: nowIso,
      base: 'milk',
      extra_sugar: 1
    },
    {
      id: 'CFX-G-MC03',
      machine_id: 'CFX-MC-03',
      product_id: 3,
      product_name: 'Hazel Gold',
      coffee: 'Hazel Gold',
      amount: 100,
      captured_amount_paise: 10000,
      status: 'COMPLETED',
      dispense_status: 'DISPENSED',
      dispensed: true,
      refund_status: 'NONE',
      total_refunded_amount_paise: 0,
      pending_refund_amount_paise: 0,
      razorpay_order_id: 'order_g_mc03',
      razorpay_payment_id: 'pay_g_mc03',
      created_at: earlierIso,
      updated_at: nowIso,
      dispensed_at: nowIso
    },
    {
      id: 'CFX-G-REFUNDED',
      machine_id: 'CFX-MC-01',
      product_id: 4,
      product_name: 'Irish Emerald',
      coffee: 'Irish Emerald',
      amount: 50,
      captured_amount_paise: 5000,
      status: 'PAID',
      dispense_status: 'FAILED',
      refund_status: 'FULL',
      total_refunded_amount_paise: 5000,
      pending_refund_amount_paise: 0,
      razorpay_order_id: 'order_g_refunded',
      razorpay_payment_id: 'pay_g_refunded',
      created_at: earlierIso,
      updated_at: nowIso
    },
    {
      id: 'CFX-G-NO-TS',
      machine_id: 'CFX-MC-01',
      product_id: 4,
      product_name: 'Irish Emerald',
      coffee: 'Irish Emerald',
      amount: 25,
      captured_amount_paise: 2500,
      status: 'PAID',
      dispense_status: 'DISPENSED',
      razorpay_order_id: 'order_g_nots',
      razorpay_payment_id: 'pay_g_nots'
    },
    {
      id: 'CFX-G-MISSING-PROD',
      machine_id: 'CFX-MC-01',
      product_id: 999,
      product_name: 'Seasonal Blend',
      coffee: 'Seasonal Blend',
      amount: 75,
      captured_amount_paise: 7500,
      status: 'PAID',
      dispense_status: 'DISPENSED',
      razorpay_order_id: 'order_g_missprod',
      razorpay_payment_id: 'pay_g_missprod',
      created_at: earlierIso,
      updated_at: nowIso
    }
  ];
  for (const o of seedOrders) {
    await firestore.collection('orders').doc(o.id).set(o);
  }
  await firestore.collection('refunds').doc('ref_g_001').set({
    id: 'ref_g_001',
    order_id: 'CFX-G-REFUNDED',
    machine_id: 'CFX-MC-01',
    razorpay_payment_id: 'pay_g_refunded',
    amount_paise: 5000,
    status: 'PROCESSED',
    reason: 'Dispense failed',
    created_at: nowIso,
    updated_at: nowIso,
    processed_at: nowIso
  });
  await firestore
    .collection('orders')
    .doc('CFX-G-REFUNDED')
    .collection('refunds')
    .doc('ref_g_001')
    .set({
      id: 'ref_g_001',
      order_id: 'CFX-G-REFUNDED',
      machine_id: 'CFX-MC-01',
      razorpay_payment_id: 'pay_g_refunded',
      amount_paise: 5000,
      status: 'PROCESSED',
      reason: 'Dispense failed',
      created_at: nowIso,
      updated_at: nowIso,
      processed_at: nowIso
    });

  // Malformed Production orphan doc replica (NpjipaUS7lHc4kObDOCR)
  await firestore.collection('orders').doc('NpjipaUS7lHc4kObDOCR').set({
    orderId: 'TEST001',
    coffee: 'Classic Coffee',
    status: 'PAID'
  });

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(PORT, '127.0.0.1', () => resolve()));

  try {
    const secret = getJwtSecret();
    const adminToken = jwt.sign({ id: 'usr_admin_1', email: 'admin@test.local', role: 'admin', portal: 'admin' }, secret, { expiresIn: '1h' });
    const owner1Token = jwt.sign({ id: 'usr_owner_1', email: 'owner1@test.local', role: 'owner', portal: 'owner' }, secret, { expiresIn: '1h' });
    const owner2Token = jwt.sign({ id: 'usr_owner_2', email: 'owner2@test.local', role: 'owner', portal: 'owner' }, secret, { expiresIn: '1h' });

    // 1. Simulate Vercel cold start (reset MockDatabase + clear in-memory caches + ensureFirestoreSeeded)
    console.log('1. Testing Vercel MockDatabase cold start & Firestore order hydration...');
    resetMockDatabaseForColdStartSimulation();
    resetFirestoreSeedStateForTesting();
    setFirestoreForTesting({ firestoreInstance: firestore, clearStores: true });
    await initDB();
    const mockDb = getDB();
    await ensureFirestoreSeeded(mockDb);

    // Confirm MockStore orders starts empty after cold start DELETE FROM orders
    const emptyBefore = await mockDb.get('SELECT COUNT(*) as count FROM orders');
    assert.strictEqual(emptyBefore.count, 0, 'Cold start mockStore.orders should begin empty');

    const adminListRes = await api('GET', '/orders', adminToken);
    assert.strictEqual(adminListRes.status, 200, 'Admin GET /api/orders must succeed with 200 OK');
    const adminOrders: any[] = adminListRes.body?.data || [];
    assert.ok(adminOrders.some((o) => o.id === 'CFX-43016777'), 'CFX-43016777 must be returned by GET /api/orders');
    assert.ok(adminOrders.some((o) => o.id === 'CFX-77486398'), 'CFX-77486398 must be returned by GET /api/orders');
    assert.ok(adminOrders.some((o) => o.id === 'CFX-G-MC03'), 'CFX-MC-03 order must be returned to Admin');
    assert.ok(adminOrders.some((o) => o.id === 'CFX-G-MISSING-PROD'), 'Order with missing product reference must be preserved');

    // Verify customer_name, customer_email, dispense_started_at, updated_at hydrated cleanly
    const cfx1 = adminOrders.find((o) => o.id === 'CFX-43016777');
    assert.strictEqual(cfx1.customer_name, 'Customer One');
    assert.strictEqual(cfx1.customer_email, 'c1@example.com');
    assert.strictEqual(cfx1.dispense_started_at, nowIso);
    assert.strictEqual(cfx1.updated_at, nowIso);

    // Verify missing created_at was NOT fabricated into Date.now()
    const noTs = adminOrders.find((o) => o.id === 'CFX-G-NO-TS');
    assert.ok(noTs, 'Order without created_at must still be preserved');
    assert.strictEqual(noTs.created_at, null, 'Missing created_at must NOT be fabricated');

    // Verify orphan malformed doc does not crash listing & is safely normalized
    const orphan = adminOrders.find((o) => o.id === 'NpjipaUS7lHc4kObDOCR');
    assert.ok(orphan, 'Orphan doc safely normalized in Admin view without crashing');
    assert.strictEqual(orphan.machine_id, null, 'Orphan machine_id must never become literal "undefined"');
    assert.strictEqual(orphan.is_malformed, true, 'Orphan doc must be marked is_malformed=true');
    assert.strictEqual(orphan.amount, 0);
    console.log('   PASS: Vercel cold start hydration, metadata updates, missing refs/timestamps, and orphan defense verified.');

    // 2. Test INSERT OR IGNORE duplicate idempotency + repeated cold starts + re-sync
    console.log('2. Testing INSERT OR IGNORE duplicate handling, repeated cold starts & re-sync...');
    const dupInsertRes = await mockDb.run(
      'INSERT OR IGNORE INTO orders (id, product_id, amount, status, machine_id, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      ['CFX-43016777', 4, 1, 'PAID', 'CFX-MC-01', earlierIso]
    );
    assert.strictEqual(dupInsertRes.changes, 0, 'Duplicate INSERT OR IGNORE must return changes=0 without throwing');

    await syncOrderToFirebase({ id: 'CFX-43016777', machine_id: 'CFX-MC-01', product_id: 4, amount: 1, status: 'PAID' });
    resetMockDatabaseForColdStartSimulation();
    await initDB();
    const resAfterColdStart2 = await api('GET', '/orders', adminToken);
    assert.strictEqual(resAfterColdStart2.status, 200);
    const matchingCfx1 = (resAfterColdStart2.body?.data || []).filter((o: any) => o.id === 'CFX-43016777');
    assert.strictEqual(matchingCfx1.length, 1, 'Repeated cold starts + re-sync must never create duplicates');
    console.log('   PASS: Duplicate handling & repeated cold-start idempotency verified.');

    // 3. Test getAuthoritativeOrderByRazorpayOrderId after cold start
    console.log('3. Testing getAuthoritativeOrderByRazorpayOrderId after Vercel cold start...');
    resetMockDatabaseForColdStartSimulation();
    await initDB();
    setFirestoreForTesting({ firestoreInstance: firestore, clearStores: true });
    const coldDb = getDB();
    const rzpFound = await getAuthoritativeOrderByRazorpayOrderId('order_U0SSAOWbJN2HXp', coldDb);
    assert.ok(rzpFound, 'getAuthoritativeOrderByRazorpayOrderId must return merged order after cold start');
    assert.strictEqual(rzpFound.id, 'CFX-43016777');
    assert.strictEqual(rzpFound.razorpay_payment_id, 'pay_U0SSo4M9u5MQjq');
    assert.strictEqual(rzpFound.captured_amount_paise, 100);
    console.log('   PASS: Razorpay order lookup after cold start verified.');

    // 4. Test Admin vs Owner machine visibility & cross-owner isolation
    console.log('4. Testing Admin vs Owner visibility and cross-owner isolation...');
    const owner1ListRes = await api('GET', '/orders', owner1Token);
    assert.strictEqual(owner1ListRes.status, 200);
    const owner1Ids = new Set((owner1ListRes.body?.data || []).map((o: any) => o.id));
    assert.ok(owner1Ids.has('CFX-43016777'), 'Owner 1 must see CFX-43016777 on CFX-MC-01');
    assert.ok(!owner1Ids.has('CFX-77486398'), 'Owner 1 must NOT see CFX-MC-02 orders');
    assert.ok(!owner1Ids.has('CFX-G-MC03'), 'Owner 1 must NOT see CFX-MC-03 testing orders');
    assert.ok(!owner1Ids.has('NpjipaUS7lHc4kObDOCR'), 'Owner 1 must NOT see orphan doc');

    const owner2ListRes = await api('GET', '/orders', owner2Token);
    assert.strictEqual(owner2ListRes.status, 200);
    const owner2Orders: any[] = owner2ListRes.body?.data || [];
    assert.strictEqual(owner2Orders.length, 1);
    assert.strictEqual(owner2Orders[0].id, 'CFX-77486398');

    const crossMachineRes = await api('GET', '/orders?machine_id=CFX-MC-02', owner1Token);
    assert.strictEqual(crossMachineRes.status, 403, 'Owner 1 querying CFX-MC-02 must fail with 403');
    const crossOrderRes = await api('GET', '/orders/CFX-77486398', owner1Token);
    assert.strictEqual(crossOrderRes.status, 403, 'Owner 1 reading CFX-MC-02 order must fail with 403');
    console.log('   PASS: Multi-machine visibility and cross-owner 403 isolation verified.');

    // 5. Test SQLite mode with PRAGMA foreign_keys = ON & LEFT JOIN preservation
    console.log('5. Testing SQLite FK defense against malformed orphan & missing product references...');
    const sqliteDb = await createSqliteOrdersDb();
    setFirestoreForTesting({ firestoreInstance: firestore, clearStores: true });
    const sqliteOrders = await getAuthoritativeOrders(sqliteDb);
    assert.ok(sqliteOrders.some((o) => o.id === 'CFX-43016777'), 'SQLite mode must hydrate CFX-43016777');
    assert.ok(sqliteOrders.some((o) => o.id === 'CFX-77486398'), 'SQLite mode must hydrate CFX-77486398');
    assert.ok(sqliteOrders.some((o) => o.id === 'CFX-G-MISSING-PROD'), 'Missing product ref order preserved via authoritative fallback');
    assert.ok(sqliteOrders.some((o) => o.id === 'NpjipaUS7lHc4kObDOCR'), 'Malformed orphan preserved safely without FK crash');

    // Verify LEFT JOIN even if product row is removed AFTER local order insert
    await sqliteDb.run('PRAGMA foreign_keys = OFF');
    await sqliteDb.run('DELETE FROM products WHERE id = 3');
    await sqliteDb.run('PRAGMA foreign_keys = ON');
    const sqliteAfterProdDelete = await getAuthoritativeOrders(sqliteDb);
    assert.ok(sqliteAfterProdDelete.some((o) => o.id === 'CFX-77486398'), 'LEFT JOIN must retain hydrated order even if local product deleted');
    const singleAfterProdDelete = await getAuthoritativeOrderById('CFX-77486398', sqliteDb);
    assert.ok(singleAfterProdDelete, 'getAuthoritativeOrderById LEFT JOIN must retain order');
    console.log('   PASS: SQLite FK protection and LEFT JOIN product preservation verified.');

    // 6. Test Gross, Refund & Net revenue consistency in analyticsService
    console.log('6. Testing Gross, Refund & Net revenue accounting (excluding orphan doc)...');
    const analyticsAdmin = await getAnalyticsOverview(coldDb, { timeframe: {}, forceSource: 'firestore' });
    // Gross: CFX-43016777 (100p) + CFX-77486398 (100p) + MC03 (10000p) + REFUNDED (5000p) + NO_TS (2500p) + MISS_PROD (7500p) = 25200 paise (252 INR)
    // Refunds: ref_g_001 = 5000 paise (50 INR)
    // Net: 20200 paise (202 INR)
    // Malformed NpjipaUS7lHc4kObDOCR: excluded (0 revenue, not counted in paid_orders_count)
    assert.strictEqual(analyticsAdmin.gross_sales_paise, 25200);
    assert.strictEqual(analyticsAdmin.processed_refunds_paise, 5000);
    assert.strictEqual(analyticsAdmin.net_revenue_paise, 20200);
    assert.strictEqual(analyticsAdmin.paid_orders_count, 6);
    console.log('   PASS: Financial totals (Gross=₹252, Refunds=₹50, Net=₹202, PaidCount=6) verified.');

    console.log('\nALL PHASE G ORDER VISIBILITY & PORTAL SYNC REGRESSION TESTS PASSED!\n');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    for (const a of getApps()) await deleteApp(a);
  }
}

runTests().catch((err) => {
  console.error('Phase G order visibility regression tests failed:', err);
  process.exit(1);
});
