import assert from 'node:assert/strict';
import http from 'node:http';
import jwt from 'jsonwebtoken';
import { initializeApp, getApps, deleteApp } from 'firebase-admin/app';
import {
  getFirestore,
  DocumentReference,
  Query
} from 'firebase-admin/firestore';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'phase-h3-quota-opt-test-secret-2026';
process.env.KIOSK_SECRET = process.env.KIOSK_SECRET || 'caffix-h3-kiosk-secret-2026';
process.env.FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8088';

import app from '../index';
import { initDB, getDB } from '../config/db';
import { getJwtSecret } from '../utils/security';
import {
  ensureFirestoreSeeded,
  resetFirestoreSeedStateForTesting,
  setFirestoreForTesting,
  getAuthoritativeMachinesList,
  getAuthoritativeMachineProducts,
  notifyAnalyticsMutation
} from '../utils/firebase';
import { clearSyncedRefundsStore } from '../utils/refunds';
import {
  getAnalyticsOverview,
  clearAnalyticsCache
} from '../services/analyticsService';

const EMULATOR_PROJECT_ID = 'demo-caffix-emulator';
const TEST_PORT = 5074;

async function clearEmulatorDatabase(): Promise<void> {
  const host = process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8088';
  const res = await fetch(
    `http://${host}/emulator/v1/projects/${EMULATOR_PROJECT_ID}/databases/(default)/documents`,
    { method: 'DELETE' }
  );
  if (!res.ok) {
    throw new Error(`Failed to clear Firestore emulator: ${res.status}`);
  }
}

async function api(method: string, path: string, token?: string, body?: any) {
  const res = await fetch(`http://127.0.0.1:${TEST_PORT}/api${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {})
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, body: json };
}

interface ReadTrace {
  queryPaths: string[];
  docPaths: string[];
  queryCount: number;
  docGetCount: number;
  docsReturned: number;
}

async function measureFirestoreReads<T>(fn: () => Promise<T>): Promise<{ result: T; trace: ReadTrace }> {
  const origQueryGet = Query.prototype.get;
  const origDocGet = DocumentReference.prototype.get;
  const trace: ReadTrace = {
    queryPaths: [],
    docPaths: [],
    queryCount: 0,
    docGetCount: 0,
    docsReturned: 0
  };

  Query.prototype.get = async function (...args: any[]) {
    trace.queryCount += 1;
    const snap = await origQueryGet.apply(this, args as any);
    const firstPath = snap?.docs?.[0]?.ref?.path || (this as any)?._queryOptions?.parentPath?.relativeName || 'query';
    trace.queryPaths.push(String(firstPath));
    trace.docsReturned += snap?.size ?? snap?.docs?.length ?? 0;
    return snap;
  };

  DocumentReference.prototype.get = async function (...args: any[]) {
    trace.docGetCount += 1;
    trace.docPaths.push(this.path);
    const snap = await origDocGet.apply(this, args as any);
    trace.docsReturned += snap?.exists ? 1 : 0;
    return snap;
  };

  try {
    const result = await fn();
    return { result, trace };
  } finally {
    Query.prototype.get = origQueryGet;
    DocumentReference.prototype.get = origDocGet;
  }
}

async function runTests() {
  console.log('\n======================================================================');
  console.log('Running CAFFIX Phase H.3 — Firestore Read-Quota Optimization Tests');
  console.log('======================================================================\n');

  for (const a of getApps()) await deleteApp(a);
  const fbApp = initializeApp({ projectId: EMULATOR_PROJECT_ID });
  const firestore = getFirestore(fbApp);
  setFirestoreForTesting({ firestoreInstance: firestore, clearStores: true });
  resetFirestoreSeedStateForTesting();
  clearSyncedRefundsStore();
  clearAnalyticsCache();
  await clearEmulatorDatabase();

  await initDB();
  const db = getDB();
  await db.run("DELETE FROM refunds WHERE order_id LIKE 'CFX-H3-%'").catch(() => {});
  await db.run("DELETE FROM orders WHERE id LIKE 'CFX-H3-%'").catch(() => {});

  const nowMs = Date.now();
  await firestore.collection('machines').doc('CFX-MC-01').set({
    id: 'CFX-MC-01',
    machine_name: 'ONE',
    location: 'Loc 1',
    desired_mode: 'RUNNING',
    status: 'online',
    last_seen: new Date(nowMs).toISOString(),
    owner_id: 'usr_owner_1',
    kiosk_token: 'tok_h3_mc01',
    estimated_inventory: { milk_level: 90, coffee_level: 90, vanilla_level: 90, hazelnut_level: 90, irish_level: 90, mocha_level: 90, water_level: 90 },
    products: {
      '1': { product_id: 1, price: 115, is_available: true, updated_at: new Date(nowMs).toISOString() }
    }
  });
  await firestore.collection('machines').doc('CFX-MC-02').set({
    id: 'CFX-MC-02',
    machine_name: 'TWO',
    location: 'Loc 2',
    desired_mode: 'RUNNING',
    status: 'online',
    last_seen: new Date(nowMs).toISOString(),
    owner_id: 'usr_owner_2',
    kiosk_token: 'tok_h3_mc02',
    estimated_inventory: { milk_level: 80, coffee_level: 80, vanilla_level: 80, hazelnut_level: 80, irish_level: 80, mocha_level: 80, water_level: 80 }
  });
  await firestore.collection('machines').doc('CFX-MC-03').set({
    id: 'CFX-MC-03',
    machine_name: 'THREE',
    location: 'Loc 3',
    desired_mode: 'RUNNING',
    status: 'online',
    last_seen: null,
    owner_id: null
  });

  // Seed 10 orders across 3 machines (5 on CFX-MC-01, 3 on CFX-MC-02, 2 on CFX-MC-03)
  for (let i = 1; i <= 5; i++) {
    const id = `CFX-H3-MC01-0${i}`;
    const createdAt = new Date(nowMs - (10 - i) * 60_000).toISOString();
    await firestore.collection('orders').doc(id).set({
      id,
      machine_id: 'CFX-MC-01',
      product_id: 1,
      product_name: 'Classic Crest',
      amount: 100,
      captured_amount_paise: 10000,
      status: 'PAID',
      dispense_status: 'DISPENSED',
      dispensed: true,
      razorpay_payment_id: `pay_h3_mc01_${i}`,
      refund_status: 'NONE',
      total_refunded_amount_paise: 0,
      pending_refund_amount_paise: 0,
      created_at: createdAt,
      updated_at: createdAt
    });
    await firestore.collection('inventory_ledger').doc(`mov_h3_${i}`).set({
      id: `mov_h3_${i}`,
      machine_id: 'CFX-MC-01',
      ingredient: 'coffee',
      quantity: 6,
      movement_type: 'DEDUCTION',
      order_id: id,
      created_at: createdAt
    });
  }
  for (let i = 1; i <= 3; i++) {
    const id = `CFX-H3-MC02-0${i}`;
    const createdAt = new Date(nowMs - (5 - i) * 60_000).toISOString();
    await firestore.collection('orders').doc(id).set({
      id,
      machine_id: 'CFX-MC-02',
      product_id: 2,
      product_name: 'Vanilla Velvet',
      amount: 120,
      captured_amount_paise: 12000,
      status: 'PAID',
      dispense_status: 'DISPENSED',
      dispensed: true,
      razorpay_payment_id: `pay_h3_mc02_${i}`,
      refund_status: 'NONE',
      total_refunded_amount_paise: 0,
      pending_refund_amount_paise: 0,
      created_at: createdAt,
      updated_at: createdAt
    });
  }
  for (let i = 1; i <= 2; i++) {
    const id = `CFX-H3-MC03-0${i}`;
    const createdAt = new Date(nowMs - (2 - i) * 60_000).toISOString();
    await firestore.collection('orders').doc(id).set({
      id,
      machine_id: 'CFX-MC-03',
      product_id: 1,
      amount: 100,
      status: 'PENDING',
      dispense_status: 'PENDING',
      created_at: createdAt,
      updated_at: createdAt
    });
  }

  const secret = getJwtSecret();
  const adminToken = jwt.sign({ id: 'usr_admin_h3', email: 'admin@caffix.com', role: 'admin', portal: 'admin' }, secret, { expiresIn: '1h' });
  const owner1Token = jwt.sign({ id: 'usr_owner_1', email: 'owner1@caffix.com', role: 'owner', portal: 'owner' }, secret, { expiresIn: '1h' });
  const mc1KioskToken = jwt.sign({ id: 'kiosk_CFX-MC-01', email: 'cfx-mc-01@caffix.com', role: 'kiosk', machine_id: 'CFX-MC-01' }, secret, { expiresIn: '1h' });

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(TEST_PORT, '127.0.0.1', () => resolve()));

  try {
    // 1. Machine list & Kiosk sync single-read efficiency
    console.log('1. Testing duplicate machine read elimination & combined /api/kiosk/sync...');
    const mListRun = await measureFirestoreReads(() => getAuthoritativeMachinesList(db));
    assert.ok(mListRun.result.length >= 3, 'Expected seeded fleet machines');
    assert.strictEqual(mListRun.trace.queryCount, 1, 'getAuthoritativeMachinesList must run 1 collection query');
    assert.strictEqual(mListRun.trace.docGetCount, 0, 'getAuthoritativeMachinesList must perform 0 redundant per-machine doc reads');

    const prodRun = await measureFirestoreReads(() => api('GET', '/products?machine_id=CFX-MC-01', mc1KioskToken));
    assert.strictEqual(prodRun.result.status, 200);
    assert.strictEqual(prodRun.trace.docGetCount, 1, 'GET /api/products?machine_id= must read machine doc only once');
    assert.strictEqual(prodRun.result.body.data.find((p: any) => p.product_id === 1)?.price, 115);

    const syncRun = await measureFirestoreReads(() => api('GET', '/kiosk/sync?machine_id=CFX-MC-01', mc1KioskToken));
    assert.strictEqual(syncRun.result.status, 200);
    assert.strictEqual(syncRun.trace.docGetCount, 1, 'GET /api/kiosk/sync must read machine doc only once for products+status');
    assert.strictEqual(syncRun.trace.queryCount, 0);
    assert.strictEqual(syncRun.result.body.data.machine_status.machine_id, 'CFX-MC-01');
    assert.strictEqual(syncRun.result.body.data.products.find((p: any) => p.product_id === 1)?.price, 115);

    const crossSync = await api('GET', '/kiosk/sync?machine_id=CFX-MC-02', mc1KioskToken);
    assert.strictEqual(crossSync.status, 403, 'Kiosk CFX-MC-01 must remain forbidden from CFX-MC-02 sync');
    console.log('   PASS: Machine list, /products, and /kiosk/sync perform minimal single-read queries with isolation preserved.');

    // 2. Zero N+1 refund queries & machine pushdown & cursor pagination on GET /api/orders
    console.log('2. Testing zero N+1 refund subcollection queries, machine filtering, & cursor pagination...');
    const ownerOrdersRun = await measureFirestoreReads(() => api('GET', '/orders', owner1Token));
    assert.strictEqual(ownerOrdersRun.result.status, 200);
    assert.strictEqual(ownerOrdersRun.result.body.data.length, 5, 'Owner 1 must receive only 5 CFX-MC-01 orders');
    // 1 query for machines (for owner assignment resolution) + 1 query for orders (CFX-MC-01 only) = 2 queries total, 0 subcollection reads!
    assert.strictEqual(ownerOrdersRun.trace.queryCount, 2, 'Owner GET /api/orders must run 1 machines query + 1 filtered orders query');
    assert.strictEqual(ownerOrdersRun.trace.docGetCount, 0, 'Owner GET /api/orders must not trigger N+1 doc/subcollection reads');
    assert.ok(ownerOrdersRun.trace.docsReturned <= mListRun.result.length + 5, `Expected <= ${mListRun.result.length + 5} docs returned (machines + 5 MC-01 orders), got ${ownerOrdersRun.trace.docsReturned}`);

    // Bounded pagination across fleet (Admin)
    const page1Run = await measureFirestoreReads(() => api('GET', '/orders?limit=2', adminToken));
    assert.strictEqual(page1Run.result.status, 200);
    assert.strictEqual(page1Run.result.body.data.length, 2);
    assert.strictEqual(page1Run.result.body.pagination.has_more, true);
    assert.ok(page1Run.result.body.pagination.next_cursor);
    assert.strictEqual(page1Run.trace.queryCount, 1);
    assert.strictEqual(page1Run.trace.docsReturned, 3, 'limit=2 fetches limit+1 (3) docs to detect has_more without extra count query');

    const page2Run = await measureFirestoreReads(() =>
      api('GET', `/orders?limit=2&cursor=${encodeURIComponent(page1Run.result.body.pagination.next_cursor)}`, adminToken)
    );
    assert.strictEqual(page2Run.result.status, 200);
    assert.strictEqual(page2Run.result.body.data.length, 2);
    const p1Ids = new Set(page1Run.result.body.data.map((o: any) => o.id));
    for (const o of page2Run.result.body.data) {
      assert.ok(!p1Ids.has(o.id), 'Page 2 must not overlap with Page 1');
    }

    // Single-order GET /api/orders/:id STILL runs full refund reconciliation when needed
    const detailRun = await measureFirestoreReads(() => api('GET', '/orders/CFX-H3-MC01-01', adminToken));
    assert.strictEqual(detailRun.result.status, 200);
    assert.ok(detailRun.trace.queryCount >= 1, 'Single-order GET keeps refund subcollection reconciliation active');
    console.log('   PASS: Server-side machine pushdown, cursor pagination, and zero N+1 order list reads verified.');

    // 3. Analytics zero N+1 over-refund scan, query coalescing, & TTL cache + invalidation
    console.log('3. Testing analytics N+1 elimination, coalescing, & short TTL caching...');
    clearAnalyticsCache();
    const prevTtl = process.env.ANALYTICS_CACHE_TTL_MS;
    const prevStrictFb = process.env.STRICT_FIREBASE_VALIDATION;
    process.env.ANALYTICS_CACHE_TTL_MS = '15000';
    process.env.STRICT_FIREBASE_VALIDATION = 'true';
    try {
      const ovRun = await measureFirestoreReads(() =>
        getAnalyticsOverview(db, { forceSource: 'firestore' })
      );
      assert.strictEqual(ovRun.result.paid_orders_count, 8);
      assert.strictEqual(ovRun.result.over_refund_detected, false);
      assert.strictEqual(ovRun.trace.queryCount, 2, 'Unrefunded overview must only run orders + refunds queries (0 N+1 over-refund queries)');

      // Concurrent 5-endpoint fan-out with warm TTL cache -> coalesced into <= 3 Firestore queries (orders, refunds, machines)
      clearAnalyticsCache();
      const fanOutRun = await measureFirestoreReads(() =>
        Promise.all([
          api('GET', '/analytics/overview', adminToken),
          api('GET', '/analytics/time-series?interval=day', adminToken),
          api('GET', '/analytics/machines', adminToken),
          api('GET', '/analytics/products', adminToken),
          api('GET', '/analytics/refunds', adminToken)
        ])
      );
      for (const r of fanOutRun.result) {
        assert.strictEqual(r.status, 200);
      }
      assert.ok(
        fanOutRun.trace.queryCount <= 3,
        `5 simultaneous analytics endpoints must coalesce into <= 3 Firestore collection queries, ran ${fanOutRun.trace.queryCount}`
      );

      // Immediate second overview call uses TTL cache (0 Firestore queries)
      const cachedOvRun = await measureFirestoreReads(() => api('GET', '/analytics/overview', adminToken));
      assert.strictEqual(cachedOvRun.result.status, 200);
      assert.strictEqual(cachedOvRun.trace.queryCount, 0, 'Cached overview within 15s TTL must consume 0 Firestore reads');

      // Mutation invalidates cache immediately
      notifyAnalyticsMutation();
      const postMutRun = await measureFirestoreReads(() => api('GET', '/analytics/overview', adminToken));
      assert.strictEqual(postMutRun.trace.queryCount, 2, 'Cache invalidation must re-query authoritative Firestore immediately');
    } finally {
      if (prevTtl === undefined) delete process.env.ANALYTICS_CACHE_TTL_MS;
      else process.env.ANALYTICS_CACHE_TTL_MS = prevTtl;
      if (prevStrictFb === undefined) delete process.env.STRICT_FIREBASE_VALIDATION;
      else process.env.STRICT_FIREBASE_VALIDATION = prevStrictFb;
      clearAnalyticsCache();
    }
    console.log('   PASS: Analytics query coalescing, 0 N+1 refund scans, & TTL invalidation verified.');

    // 4. Production cold-start ensureFirestoreSeeded performs 0 user tx reads
    console.log('4. Testing Production cold-start ensureFirestoreSeeded performs 0 reads & 0 writes...');
    let seedReads = 0;
    let seedWrites = 0;
    const mockProdFs = {
      collection: () => ({
        doc: () => ({
          get: async () => {
            seedReads += 1;
            return { exists: false };
          }
        })
      }),
      runTransaction: async (fn: any) =>
        fn({
          get: async () => {
            seedReads += 1;
            return { exists: false };
          },
          set: () => {
            seedWrites += 1;
          }
        })
    };
    const prevVercelEnv = process.env.VERCEL_ENV;
    const prevFbProj = process.env.FIREBASE_PROJECT_ID;
    const prevFbEmail = process.env.FIREBASE_CLIENT_EMAIL;
    const prevFbKey = process.env.FIREBASE_PRIVATE_KEY;
    const prevEmuHost = process.env.FIRESTORE_EMULATOR_HOST;
    try {
      delete process.env.FIRESTORE_EMULATOR_HOST;
      process.env.VERCEL_ENV = 'production';
      process.env.FIREBASE_PROJECT_ID = 'caffix-vending';
      process.env.FIREBASE_CLIENT_EMAIL = 'test@caffix-vending.iam.gserviceaccount.com';
      process.env.FIREBASE_PRIVATE_KEY = '-----BEGIN PRIVATE KEY-----\\nFAKE\\n-----END PRIVATE KEY-----\\n';
      setFirestoreForTesting({ firestoreInstance: mockProdFs, clearStores: false });
      await ensureFirestoreSeeded(db);
      assert.strictEqual(seedReads, 0, 'Production ensureFirestoreSeeded must execute 0 Firestore reads');
      assert.strictEqual(seedWrites, 0, 'Production ensureFirestoreSeeded must execute 0 Firestore writes');
    } finally {
      if (prevEmuHost === undefined) delete process.env.FIRESTORE_EMULATOR_HOST;
      else process.env.FIRESTORE_EMULATOR_HOST = prevEmuHost;
      if (prevVercelEnv === undefined) delete process.env.VERCEL_ENV;
      else process.env.VERCEL_ENV = prevVercelEnv;
      if (prevFbProj === undefined) delete process.env.FIREBASE_PROJECT_ID;
      else process.env.FIREBASE_PROJECT_ID = prevFbProj;
      if (prevFbEmail === undefined) delete process.env.FIREBASE_CLIENT_EMAIL;
      else process.env.FIREBASE_CLIENT_EMAIL = prevFbEmail;
      if (prevFbKey === undefined) delete process.env.FIREBASE_PRIVATE_KEY;
      else process.env.FIREBASE_PRIVATE_KEY = prevFbKey;
      setFirestoreForTesting({ firestoreInstance: firestore, clearStores: false });
    }
    console.log('   PASS: Production cold-start initialization confirmed at 0 reads and 0 writes.');

    console.log('\nALL PHASE H.3 FIRESTORE QUOTA OPTIMIZATION TESTS PASSED!\n');
  } finally {
    await db.run("DELETE FROM refunds WHERE order_id LIKE 'CFX-H3-%'").catch(() => {});
    await db.run("DELETE FROM orders WHERE id LIKE 'CFX-H3-%'").catch(() => {});
    if (typeof (server as any).closeAllConnections === 'function') {
      (server as any).closeAllConnections();
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
    for (const a of getApps()) await deleteApp(a);
  }
}

runTests()
  .then(() => {
    process.exit(0);
  })
  .catch((err) => {
    console.error('Phase H.3 quota optimization tests failed:', err);
    process.exit(1);
  });
