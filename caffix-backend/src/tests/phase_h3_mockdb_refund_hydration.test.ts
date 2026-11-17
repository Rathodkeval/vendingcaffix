import assert from 'node:assert/strict';

const ORIGINAL_VERCEL = process.env.VERCEL;
const ORIGINAL_NODE_ENV = process.env.NODE_ENV;
const ORIGINAL_FIREBASE_PROJECT_ID = process.env.FIREBASE_PROJECT_ID;
const ORIGINAL_FIREBASE_CLIENT_EMAIL = process.env.FIREBASE_CLIENT_EMAIL;
const ORIGINAL_FIREBASE_PRIVATE_KEY = process.env.FIREBASE_PRIVATE_KEY;

process.env.VERCEL = '1';
process.env.NODE_ENV = 'test';

import {
  initDB,
  getDB,
  resetMockDatabaseForColdStartSimulation
} from '../config/db';
import {
  getAuthoritativeOrderById,
  getAuthoritativeOrdersPaginated,
  resetFirestoreSeedStateForTesting,
  setFirestoreForTesting
} from '../utils/firebase';
import { clearSyncedRefundsStore } from '../utils/refunds';

class InMemoryFirestore {
  private collections = new Map<string, Map<string, any>>();
  private subcollections = new Map<string, Map<string, any>>();

  private getColMap(name: string): Map<string, any> {
    if (!this.collections.has(name)) {
      this.collections.set(name, new Map());
    }
    return this.collections.get(name)!;
  }

  private getSubColMap(parentDocPath: string, subName: string): Map<string, any> {
    const key = `${parentDocPath}/${subName}`;
    if (!this.subcollections.has(key)) {
      this.subcollections.set(key, new Map());
    }
    return this.subcollections.get(key)!;
  }

  private makeQuery(items: Array<{ id: string; path: string; data: any }>) {
    const filters: Array<(doc: any) => boolean> = [];
    const buildQueryObj = (currentFilters: Array<(doc: any) => boolean>, limitN?: number): any => ({
      where(field: string, op: string, val: any) {
        const nextFilters = [
          ...currentFilters,
          (doc: any) => {
            const actual = doc[field];
            if (op === '==') return actual === val;
            if (op === 'in') return Array.isArray(val) && val.includes(actual);
            if (op === '>=') return String(actual || '') >= String(val);
            if (op === '<=') return String(actual || '') <= String(val);
            if (op === '<') return String(actual || '') < String(val);
            return true;
          }
        ];
        return buildQueryObj(nextFilters, limitN);
      },
      orderBy() {
        return buildQueryObj(currentFilters, limitN);
      },
      limit(n: number) {
        return buildQueryObj(currentFilters, n);
      },
      async get() {
        let matched = items.filter((item) => currentFilters.every((fn) => fn(item.data)));
        if (limitN !== undefined) {
          matched = matched.slice(0, limitN);
        }
        const docs = matched.map((item) => ({
          id: item.id,
          exists: true,
          ref: { path: item.path },
          data: () => ({ ...item.data })
        }));
        return {
          empty: docs.length === 0,
          size: docs.length,
          docs,
          forEach: (cb: (d: any) => void) => docs.forEach(cb)
        };
      }
    });
    return buildQueryObj(filters);
  }

  collection(name: string): any {
    const colMap = this.getColMap(name);
    const items = Array.from(colMap.entries()).map(([id, data]) => ({
      id,
      path: `${name}/${id}`,
      data
    }));

    return {
      ...this.makeQuery(items),
      doc: (docId: string) => {
        const docPath = `${name}/${docId}`;
        return {
          id: docId,
          path: docPath,
          async set(data: any, opts?: { merge?: boolean }) {
            if (opts?.merge && colMap.has(docId)) {
              colMap.set(docId, { ...colMap.get(docId), ...data });
            } else {
              colMap.set(docId, { ...data });
            }
          },
          async get() {
            const existing = colMap.get(docId);
            return {
              id: docId,
              exists: Boolean(existing),
              ref: { path: docPath },
              data: () => (existing ? { ...existing } : undefined)
            };
          },
          collection: (subName: string) => {
            const subMap = this.getSubColMap(docPath, subName);
            const subItems = Array.from(subMap.entries()).map(([id, data]) => ({
              id,
              path: `${docPath}/${subName}/${id}`,
              data
            }));
            return {
              ...this.makeQuery(subItems),
              doc: (subId: string) => ({
                id: subId,
                path: `${docPath}/${subName}/${subId}`,
                async set(data: any, opts?: { merge?: boolean }) {
                  if (opts?.merge && subMap.has(subId)) {
                    subMap.set(subId, { ...subMap.get(subId), ...data });
                  } else {
                    subMap.set(subId, { ...data });
                  }
                },
                async get() {
                  const existing = subMap.get(subId);
                  return {
                    id: subId,
                    exists: Boolean(existing),
                    ref: { path: `${docPath}/${subName}/${subId}` },
                    data: () => (existing ? { ...existing } : undefined)
                  };
                }
              })
            };
          }
        };
      }
    };
  }
}

async function runTests() {
  console.log('\n======================================================================');
  console.log('Running CAFFIX Phase H.3 — MockDatabase (VERCEL=1) Refund Hydration Tests');
  console.log('======================================================================\n');

  try {
    resetMockDatabaseForColdStartSimulation();
    const db = await initDB();
    assert.strictEqual(getDB(), db);
    assert.strictEqual(db.constructor.name, 'MockDatabase', 'Tests must run against MockDatabase under VERCEL=1');

    const mockFs = new InMemoryFirestore();
    setFirestoreForTesting({ firestoreInstance: mockFs, clearStores: true });
    resetFirestoreSeedStateForTesting();
    clearSyncedRefundsStore();

    // Seed machine & orders matching live Firestore states
    await mockFs.collection('machines').doc('CFX-MC-01').set({
      id: 'CFX-MC-01',
      machine_name: 'ONE',
      location: 'BVN',
      desired_mode: 'RUNNING',
      status: 'online'
    });

    // Order 1: FULL refund (mirrors CFX-10192226)
    await mockFs.collection('orders').doc('CFX-10192226').set({
      id: 'CFX-10192226',
      machine_id: 'CFX-MC-01',
      product_id: 3,
      product_name: 'Hazel Gold',
      coffee: 'Hazel Gold',
      amount: 1,
      captured_amount_paise: 100,
      status: 'PAID',
      dispense_status: 'QUEUED',
      refund_status: 'FULL',
      total_refunded_amount_paise: 100,
      pending_refund_amount_paise: 0,
      last_refunded_at: '2026-11-17T04:30:09.000Z',
      refund_version: 2,
      created_at: '2026-11-16T06:01:05.831Z',
      updated_at: '2026-11-17T04:32:10.253Z'
    });
    await mockFs.collection('orders').doc('CFX-10192226').collection('refunds').doc('RFND-CFX-10192226-2426EE').set({
      id: 'RFND-CFX-10192226-2426EE',
      order_id: 'CFX-10192226',
      machine_id: 'CFX-MC-01',
      razorpay_payment_id: 'pay_U0jySrx7HOgK8s',
      razorpay_refund_id: 'rfnd_U16wqsc3oO6Z7n',
      amount_paise: 100,
      currency: 'INR',
      status: 'PROCESSED',
      reason: 'historical_undispensed_order_reconciliation',
      processed_at: '2026-11-17T04:30:09.000Z',
      created_at: '2026-11-17T04:30:07.397Z',
      updated_at: '2026-11-17T04:32:10.253Z'
    });

    // Order 2: PARTIAL refund
    await mockFs.collection('orders').doc('CFX-MOCK-PARTIAL').set({
      id: 'CFX-MOCK-PARTIAL',
      machine_id: 'CFX-MC-01',
      product_id: 1,
      product_name: 'Classic Crest',
      amount: 100,
      captured_amount_paise: 10000,
      status: 'PAID',
      dispense_status: 'QUEUED',
      refund_status: 'PARTIAL',
      total_refunded_amount_paise: 4000,
      pending_refund_amount_paise: 0,
      last_refunded_at: '2026-11-17T05:00:00.000Z',
      created_at: '2026-11-16T07:01:05.831Z',
      updated_at: '2026-11-17T05:00:00.000Z'
    });
    await mockFs.collection('orders').doc('CFX-MOCK-PARTIAL').collection('refunds').doc('RFND-PARTIAL-1').set({
      id: 'RFND-PARTIAL-1',
      order_id: 'CFX-MOCK-PARTIAL',
      machine_id: 'CFX-MC-01',
      razorpay_payment_id: 'pay_partial_1',
      razorpay_refund_id: 'rfnd_partial_1',
      amount_paise: 4000,
      currency: 'INR',
      status: 'PROCESSED',
      processed_at: '2026-11-17T05:00:00.000Z',
      created_at: '2026-11-17T04:59:00.000Z',
      updated_at: '2026-11-17T05:00:00.000Z'
    });

    // Order 3: PENDING refund
    await mockFs.collection('orders').doc('CFX-MOCK-PENDING').set({
      id: 'CFX-MOCK-PENDING',
      machine_id: 'CFX-MC-01',
      product_id: 2,
      product_name: 'Vanilla Velvet',
      amount: 100,
      captured_amount_paise: 10000,
      status: 'PAID',
      dispense_status: 'FAILED',
      refund_status: 'PENDING',
      total_refunded_amount_paise: 0,
      pending_refund_amount_paise: 10000,
      last_refunded_at: null,
      created_at: '2026-11-16T08:01:05.831Z',
      updated_at: '2026-11-17T05:10:00.000Z'
    });
    await mockFs.collection('orders').doc('CFX-MOCK-PENDING').collection('refunds').doc('RFND-PENDING-1').set({
      id: 'RFND-PENDING-1',
      order_id: 'CFX-MOCK-PENDING',
      machine_id: 'CFX-MC-01',
      razorpay_payment_id: 'pay_pending_1',
      razorpay_refund_id: 'rfnd_pending_1',
      amount_paise: 10000,
      currency: 'INR',
      status: 'PENDING',
      created_at: '2026-11-17T05:10:00.000Z',
      updated_at: '2026-11-17T05:10:00.000Z'
    });

    // Order 4: Normal non-refunded completed order
    await mockFs.collection('orders').doc('CFX-MOCK-NORMAL').set({
      id: 'CFX-MOCK-NORMAL',
      machine_id: 'CFX-MC-01',
      product_id: 1,
      product_name: 'Classic Crest',
      amount: 100,
      captured_amount_paise: 10000,
      status: 'COMPLETED',
      dispense_status: 'DISPENSED',
      dispensed: true,
      refund_status: 'NONE',
      total_refunded_amount_paise: 0,
      pending_refund_amount_paise: 0,
      last_refunded_at: null,
      created_at: '2026-11-16T09:01:05.831Z',
      updated_at: '2026-11-16T09:02:00.000Z'
    });

    // 1 & 3. getAuthoritativeOrderById under MockDatabase cold start
    console.log('1. Testing getAuthoritativeOrderById with FULL, PARTIAL, PENDING, and NONE refunds under MockDatabase...');
    const fetchedFull = await getAuthoritativeOrderById('CFX-10192226', db);
    assert.ok(fetchedFull);
    assert.strictEqual(fetchedFull.refund_status, 'FULL');
    assert.strictEqual(fetchedFull.total_refunded_amount_paise, 100);
    assert.strictEqual(fetchedFull.pending_refund_amount_paise, 0);
    assert.strictEqual(fetchedFull.last_refunded_at, '2026-11-17T04:30:09.000Z');

    const fetchedPartial = await getAuthoritativeOrderById('CFX-MOCK-PARTIAL', db);
    assert.ok(fetchedPartial);
    assert.strictEqual(fetchedPartial.refund_status, 'PARTIAL');
    assert.strictEqual(fetchedPartial.total_refunded_amount_paise, 4000);
    assert.strictEqual(fetchedPartial.pending_refund_amount_paise, 0);
    assert.strictEqual(fetchedPartial.last_refunded_at, '2026-11-17T05:00:00.000Z');

    const fetchedPending = await getAuthoritativeOrderById('CFX-MOCK-PENDING', db);
    assert.ok(fetchedPending);
    assert.strictEqual(fetchedPending.refund_status, 'PENDING');
    assert.strictEqual(fetchedPending.total_refunded_amount_paise, 0);
    assert.strictEqual(fetchedPending.pending_refund_amount_paise, 10000);

    const fetchedNormal = await getAuthoritativeOrderById('CFX-MOCK-NORMAL', db);
    assert.ok(fetchedNormal);
    assert.strictEqual(fetchedNormal.refund_status, 'NONE');
    assert.strictEqual(fetchedNormal.total_refunded_amount_paise, 0);
    console.log('   PASS: getAuthoritativeOrderById preserved FULL, PARTIAL, PENDING, and NONE accurately.');

    // 2. Cold-start MockDatabase reset -> getAuthoritativeOrdersPaginated must ALSO preserve FULL/PARTIAL/PENDING/NONE
    console.log('2. Testing getAuthoritativeOrdersPaginated after cold-start reset under MockDatabase...');
    resetMockDatabaseForColdStartSimulation();
    const freshDb = await initDB();
    setFirestoreForTesting({ firestoreInstance: mockFs, clearStores: true });
    clearSyncedRefundsStore();

    const paginated = await getAuthoritativeOrdersPaginated(freshDb, undefined, { limit: 10 });
    const byId = new Map(paginated.orders.map((o: any) => [o.id, o]));
    assert.strictEqual(byId.get('CFX-10192226')?.refund_status, 'FULL');
    assert.strictEqual(byId.get('CFX-10192226')?.total_refunded_amount_paise, 100);
    assert.strictEqual(byId.get('CFX-10192226')?.last_refunded_at, '2026-11-17T04:30:09.000Z');
    assert.strictEqual(byId.get('CFX-MOCK-PARTIAL')?.refund_status, 'PARTIAL');
    assert.strictEqual(byId.get('CFX-MOCK-PARTIAL')?.total_refunded_amount_paise, 4000);
    assert.strictEqual(byId.get('CFX-MOCK-PENDING')?.refund_status, 'PENDING');
    assert.strictEqual(byId.get('CFX-MOCK-PENDING')?.pending_refund_amount_paise, 10000);
    assert.strictEqual(byId.get('CFX-MOCK-NORMAL')?.refund_status, 'NONE');
    assert.strictEqual(byId.get('CFX-MOCK-NORMAL')?.total_refunded_amount_paise, 0);
    console.log('   PASS: getAuthoritativeOrdersPaginated preserved FULL, PARTIAL, PENDING, and NONE.');

    // 4 & 5. Both 5-param UPDATE variants + arbitrary SET column order
    console.log('3. Testing both 5-param UPDATE variants, arbitrary SET order, literal EXPIRED, & unknown ID...');
    await freshDb.run(
      'INSERT OR REPLACE INTO orders (id, product_id, amount, status, machine_id, created_at, dispense_status) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ['CFX-UPD-TEST', 1, 100, 'PAID', 'CFX-MC-01', '2026-11-17T06:00:00.000Z', 'QUEUED']
    );

    // Variant A (reconcileOrderRefundRecords): pending, total, refund_status, last_refunded_at, id
    const varA = await freshDb.run(
      `UPDATE orders
       SET pending_refund_amount_paise = ?,
           total_refunded_amount_paise = ?,
           refund_status = ?,
           last_refunded_at = ?
       WHERE id = ?`,
      [0, 5000, 'PARTIAL', '2026-11-17T06:05:00.000Z', 'CFX-UPD-TEST']
    );
    assert.strictEqual(varA.changes, 1);
    let row = await freshDb.get('SELECT * FROM orders WHERE id = ?', ['CFX-UPD-TEST']);
    assert.strictEqual(row.pending_refund_amount_paise, 0);
    assert.strictEqual(row.total_refunded_amount_paise, 5000);
    assert.strictEqual(row.refund_status, 'PARTIAL');
    assert.strictEqual(row.last_refunded_at, '2026-11-17T06:05:00.000Z');

    // Variant B (hydrateLocalOrderFromAuthoritativeRecord): pending, total, last_refunded_at, refund_status, id
    const varB = await freshDb.run(
      `UPDATE orders
       SET pending_refund_amount_paise = ?,
           total_refunded_amount_paise = ?,
           last_refunded_at = ?,
           refund_status = ?
       WHERE id = ?`,
      [0, 10000, '2026-11-17T06:10:00.000Z', 'FULL', 'CFX-UPD-TEST']
    );
    assert.strictEqual(varB.changes, 1);
    row = await freshDb.get('SELECT * FROM orders WHERE id = ?', ['CFX-UPD-TEST']);
    assert.strictEqual(row.total_refunded_amount_paise, 10000);
    assert.strictEqual(row.refund_status, 'FULL');
    assert.strictEqual(row.last_refunded_at, '2026-11-17T06:10:00.000Z');

    // Arbitrary SET column ordering + updated_at
    const varArb = await freshDb.run(
      `UPDATE orders
       SET updated_at = ?,
           refund_status = ?,
           last_refunded_at = ?,
           total_refunded_amount_paise = ?,
           pending_refund_amount_paise = ?
       WHERE id = ?`,
      ['2026-11-17T06:15:00.000Z', 'PENDING', null, 0, 2500, 'CFX-UPD-TEST']
    );
    assert.strictEqual(varArb.changes, 1);
    row = await freshDb.get('SELECT * FROM orders WHERE id = ?', ['CFX-UPD-TEST']);
    assert.strictEqual(row.updated_at, '2026-11-17T06:15:00.000Z');
    assert.strictEqual(row.refund_status, 'PENDING');
    assert.strictEqual(row.last_refunded_at, null);
    assert.strictEqual(row.total_refunded_amount_paise, 0);
    assert.strictEqual(row.pending_refund_amount_paise, 2500);

    // 6. Literal dispense_status = 'EXPIRED' with WHERE guards
    const expOk = await freshDb.run(
      `UPDATE orders SET dispense_status = 'EXPIRED'
       WHERE id = ? AND status = 'PAID' AND dispense_status = 'QUEUED'
         AND dispense_started_at IS NULL AND dispensed_at IS NULL`,
      ['CFX-UPD-TEST']
    );
    assert.strictEqual(expOk.changes, 1);
    row = await freshDb.get('SELECT * FROM orders WHERE id = ?', ['CFX-UPD-TEST']);
    assert.strictEqual(row.dispense_status, 'EXPIRED');

    // Second attempt when no longer QUEUED must return changes: 0
    const expSecond = await freshDb.run(
      `UPDATE orders SET dispense_status = 'EXPIRED'
       WHERE id = ? AND status = 'PAID' AND dispense_status = 'QUEUED'
         AND dispense_started_at IS NULL AND dispensed_at IS NULL`,
      ['CFX-UPD-TEST']
    );
    assert.strictEqual(expSecond.changes, 0);

    // 7. Unknown order ID must return changes: 0
    const unknownRes = await freshDb.run(
      `UPDATE orders
       SET pending_refund_amount_paise = ?,
           total_refunded_amount_paise = ?,
           refund_status = ?,
           last_refunded_at = ?
       WHERE id = ?`,
      [0, 100, 'FULL', '2026-11-17T04:30:09.000Z', 'CFX-DOES-NOT-EXIST']
    );
    assert.strictEqual(unknownRes.changes, 0);
    console.log('   PASS: All UPDATE variants, literal EXPIRED, and unknown order ID guard verified.');

    console.log('\nALL PHASE H.3 MOCKDATABASE REFUND HYDRATION TESTS PASSED!\n');
  } finally {
    setFirestoreForTesting({ firestoreInstance: null, clearStores: true });
    clearSyncedRefundsStore();
    if (ORIGINAL_VERCEL === undefined) delete process.env.VERCEL;
    else process.env.VERCEL = ORIGINAL_VERCEL;
    if (ORIGINAL_NODE_ENV === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = ORIGINAL_NODE_ENV;
    if (ORIGINAL_FIREBASE_PROJECT_ID === undefined) delete process.env.FIREBASE_PROJECT_ID;
    else process.env.FIREBASE_PROJECT_ID = ORIGINAL_FIREBASE_PROJECT_ID;
    if (ORIGINAL_FIREBASE_CLIENT_EMAIL === undefined) delete process.env.FIREBASE_CLIENT_EMAIL;
    else process.env.FIREBASE_CLIENT_EMAIL = ORIGINAL_FIREBASE_CLIENT_EMAIL;
    if (ORIGINAL_FIREBASE_PRIVATE_KEY === undefined) delete process.env.FIREBASE_PRIVATE_KEY;
    else process.env.FIREBASE_PRIVATE_KEY = ORIGINAL_FIREBASE_PRIVATE_KEY;
  }
}

runTests().catch((err) => {
  console.error('MockDatabase Refund Hydration Test FAILED:', err);
  process.exit(1);
});

