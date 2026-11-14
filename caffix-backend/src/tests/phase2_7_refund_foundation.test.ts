import assert from 'assert';
import crypto from 'crypto';
import { open as sqliteOpen } from 'sqlite';
import sqlite3 from 'sqlite3';
import { initDB, getDB, resetMockDatabaseForColdStartSimulation } from '../config/db';
import {
  calculateRemainingRefundableBalance,
  createPendingRefundReservation,
  markRefundProcessed,
  markRefundFailed,
  getRefundById,
  getRefundByIdempotencyKey,
  getRefundsByOrderId,
  mapRefundRecordToFirestore,
  mapFirestoreRefundToRecord,
  getFirestoreRefundDocumentPath,
  getFirestoreRefundCollectionPath,
  clearSyncedRefundsStore,
  getEffectiveRefundPersistenceMode,
  reconcileOrderRefundRecords,
  validateOrderRefundInvariants,
  validateAndSanitizeRemoteRefundDocument,
  clearOrderRefundUnsafe,
  markOrderRefundUnsafe,
  getOrderRefundUnsafeStatus,
  RefundRecord
} from '../utils/refunds';
import {
  syncOrderToFirebase,
  getAuthoritativeOrderById,
  setFirestoreForTesting
} from '../utils/firebase';
import { BadRequestError, ConflictError, NotFoundError, ServiceUnavailableError } from '../utils/errors';
import { verifyPaymentSignature, handleRazorpayWebhook } from '../controllers/paymentController';
import { updateOrderPaymentCapture } from '../controllers/orderController';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'phase2_7_test_secret_key_2026_very_strong';
process.env.KIOSK_ADMIN_ENABLED = 'false';

// ---------------------------------------------------------------------------
// Isolated In-Memory Native SQLite Test Factory
// ---------------------------------------------------------------------------
async function createIsolatedNativeSqliteDb() {
  const db = await sqliteOpen({
    filename: ':memory:',
    driver: sqlite3.Database
  });
  await db.exec('PRAGMA foreign_keys = ON;');
  await db.exec('PRAGMA busy_timeout = 5000;');

  await db.exec(`
    CREATE TABLE products (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      price INTEGER NOT NULL DEFAULT 100
    );
    INSERT INTO products (id, name, description, price) VALUES (1, 'Espresso', 'Rich espresso', 100);

    CREATE TABLE machines (
      id TEXT PRIMARY KEY,
      machine_name TEXT NOT NULL,
      location TEXT NOT NULL,
      status TEXT DEFAULT 'online',
      desired_mode TEXT DEFAULT 'RUNNING'
    );
    INSERT INTO machines (id, machine_name, location) VALUES ('CFX-MC-01', 'Test Machine 1', 'Test Location');

    CREATE TABLE orders (
      id TEXT PRIMARY KEY,
      product_id INTEGER NOT NULL,
      amount INTEGER NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('PENDING', 'PAID', 'PREPARING', 'COMPLETED', 'FAILED', 'CANCELLED')),
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
      refund_status TEXT DEFAULT 'NONE' CHECK(refund_status IN ('NONE', 'PENDING', 'PARTIAL', 'FULL', 'FAILED')),
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
      razorpay_payment_id TEXT NOT NULL,
      razorpay_refund_id TEXT,
      amount_paise INTEGER NOT NULL,
      currency TEXT DEFAULT 'INR',
      status TEXT NOT NULL CHECK(status IN ('PENDING', 'PROCESSED', 'FAILED')),
      reason TEXT NOT NULL,
      notes TEXT,
      initiated_by TEXT NOT NULL,
      source TEXT NOT NULL CHECK(source IN ('SUPER_ADMIN_PORTAL', 'RAZORPAY_DASHBOARD', 'RECONCILIATION')),
      idempotency_key TEXT UNIQUE NOT NULL,
      error_code TEXT,
      error_description TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      processed_at TEXT,
      FOREIGN KEY (order_id) REFERENCES orders(id),
      FOREIGN KEY (machine_id) REFERENCES machines(id)
    );

    CREATE INDEX idx_refunds_order_id ON refunds(order_id);
    CREATE INDEX idx_refunds_machine_id ON refunds(machine_id);
    CREATE INDEX idx_refunds_razorpay_refund_id ON refunds(razorpay_refund_id);
    CREATE INDEX idx_refunds_status ON refunds(status);
  `);

  return db;
}

// ---------------------------------------------------------------------------
// Realistic Mock Firestore with Multi-Instance Transaction Support
// ---------------------------------------------------------------------------
class MockFirestoreForPhase27 {
  private collections = new Map<string, Map<string, any>>();
  private docVersions = new Map<string, number>();
  private commitMutex = new (class {
    private q: Promise<void> = Promise.resolve();
    acquire(): Promise<() => void> {
      let rel: () => void;
      const p = new Promise<void>((res) => { rel = res; });
      const wait = this.q.then(() => rel);
      this.q = this.q.then(() => p);
      return wait;
    }
  })();
  public transactionCount = 0;

  getCollectionMap(colName: string): Map<string, any> {
    if (!this.collections.has(colName)) {
      this.collections.set(colName, new Map<string, any>());
    }
    return this.collections.get(colName)!;
  }

  collection(colName: string) {
    const self = this;
    return {
      path: colName,
      doc: (docId: string) => {
        const fullPath = `${colName}/${docId}`;
        return {
          id: docId,
          path: fullPath,
          get: async () => {
            const m = self.getCollectionMap(colName);
            const data = m.get(docId);
            return {
              id: docId,
              exists: Boolean(data),
              data: () => (data ? JSON.parse(JSON.stringify(data)) : undefined)
            };
          },
          set: async (payload: any, opts?: { merge?: boolean }) => {
            const m = self.getCollectionMap(colName);
            const existing = m.get(docId) || {};
            const finalData = opts?.merge ? { ...existing, ...payload } : payload;
            m.set(docId, JSON.parse(JSON.stringify(finalData)));
            self.docVersions.set(fullPath, (self.docVersions.get(fullPath) || 0) + 1);
          },
          collection: (subColName: string) => {
            return self.collection(`${colName}/${docId}/${subColName}`);
          }
        };
      },
      get: async () => {
        const m = self.getCollectionMap(colName);
        const docs = Array.from(m.entries()).map(([id, data]) => ({
          id,
          data: () => JSON.parse(JSON.stringify(data))
        }));
        return {
          empty: docs.length === 0,
          docs
        };
      },
      where: (field: string, op: string, val: any) => {
        const queryObj = {
          limit: (n: number) => ({
            get: async () => {
              const res = await queryObj.get();
              return { empty: res.docs.length === 0, docs: res.docs.slice(0, n) };
            }
          }),
          get: async () => {
            const m = self.getCollectionMap(colName);
            const docs: any[] = [];
            for (const [id, data] of m.entries()) {
              if (op === '==' && data && data[field] === val) {
                docs.push({ id, data: () => JSON.parse(JSON.stringify(data)) });
              }
            }
            return { empty: docs.length === 0, docs };
          }
        };
        return queryObj;
      }
    };
  }

  async runTransaction<T>(updateFunction: (tx: any) => Promise<T>): Promise<T> {
    const maxRetries = 10;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      this.transactionCount++;
      const readVersions = new Map<string, number>();
      const stagedWrites: Array<() => Promise<void>> = [];
      const tx = {
        get: async (target: any) => {
          const snap = await target.get();
          if (target.path) {
            readVersions.set(target.path, this.docVersions.get(target.path) || 0);
          }
          return snap;
        },
        set: (docRef: any, payload: any, opts?: { merge?: boolean }) => {
          stagedWrites.push(async () => {
            await docRef.set(payload, opts);
          });
        }
      };

      const result = await updateFunction(tx);

      // Atomic commit: verify optimistic concurrency against modified doc versions
      const releaseCommit = await this.commitMutex.acquire();
      let hasContention = false;
      try {
        for (const [path, readVer] of readVersions.entries()) {
          if ((this.docVersions.get(path) || 0) !== readVer) {
            hasContention = true;
            break;
          }
        }
        if (!hasContention) {
          for (const write of stagedWrites) {
            await write();
          }
        }
      } finally {
        releaseCommit();
      }

      if (hasContention) {
        // Automatic Firestore transaction retry on write collision
        continue;
      }

      return result;
    }
    throw new Error('Firestore transaction failed after maximum contention retries');
  }
}

async function runPhase2714Tests() {
  console.log('\n========================================================================');
  console.log('Running CAFFIX Phase 2.7.1.4 — Shared Persistence & Architecture Tests');
  console.log('========================================================================\n');

  clearSyncedRefundsStore();
  setFirestoreForTesting({ firestoreInstance: null, clearStores: true });

  // -------------------------------------------------------------------------
  // Scenario 1: Two Independent Persistence Clients Concurrently Reserving Against Same Order
  // Tested on both Native SQLite Adapter and Distributed Firestore Adapter
  // -------------------------------------------------------------------------
  console.log('Scenario 1 [Dual Adapter Concurrency]: Two simultaneous ₹60 reservations against ₹100 order...');

  // 1A: Native SQLite adapter
  const memDb1 = await createIsolatedNativeSqliteDb();
  const orderId1 = 'ORD-CONC-01';
  await memDb1.run(
    `INSERT INTO orders (id, product_id, amount, status, machine_id, created_at, razorpay_payment_id, dispense_status, captured_amount_paise)
     VALUES (?, 1, 100, 'COMPLETED', 'CFX-MC-01', datetime('now'), 'pay_conc_1', 'DISPENSED', 10000)`,
    [orderId1]
  );

  const [res1A, res1B] = await Promise.allSettled([
    createPendingRefundReservation(memDb1, { orderId: orderId1, amount_paise: 6000, reason: 'Client A', initiated_by: 'adm1', idempotency_key: 'idem_c1_a' }),
    createPendingRefundReservation(memDb1, { orderId: orderId1, amount_paise: 6000, reason: 'Client B', initiated_by: 'adm2', idempotency_key: 'idem_c1_b' })
  ]);
  const fulfilled1 = [res1A, res1B].filter(r => r.status === 'fulfilled').length;
  const rejected1 = [res1A, res1B].filter(r => r.status === 'rejected').length;
  assert.strictEqual(fulfilled1, 1, 'SQLite: Exactly one simultaneous ₹60 reservation must succeed');
  assert.strictEqual(rejected1, 1, 'SQLite: Competing reservation must be rejected');

  // 1B: Firestore Adapter
  const mockFs1 = new MockFirestoreForPhase27();
  setFirestoreForTesting({ firestoreInstance: mockFs1, clearStores: true });
  await mockFs1.collection('orders').doc('ORD-FS-01').set({
    id: 'ORD-FS-01',
    amount: 100,
    status: 'COMPLETED',
    machine_id: 'CFX-MC-01',
    razorpay_payment_id: 'pay_fs_1',
    dispense_status: 'DISPENSED',
    captured_amount_paise: 10000,
    pending_refund_amount_paise: 0,
    total_refunded_amount_paise: 0,
    refund_status: 'NONE'
  });

  const [resFsA, resFsB] = await Promise.allSettled([
    createPendingRefundReservation(null, { orderId: 'ORD-FS-01', amount_paise: 6000, reason: 'FS Client A', initiated_by: 'adm1', idempotency_key: 'idem_fs_1a' }),
    createPendingRefundReservation(null, { orderId: 'ORD-FS-01', amount_paise: 6000, reason: 'FS Client B', initiated_by: 'adm2', idempotency_key: 'idem_fs_1b' })
  ]);
  const fulfilledFs = [resFsA, resFsB].filter(r => r.status === 'fulfilled').length;
  const rejectedFs = [resFsA, resFsB].filter(r => r.status === 'rejected').length;
  assert.strictEqual(fulfilledFs, 1, 'Firestore: Exactly one simultaneous ₹60 reservation must succeed');
  assert.strictEqual(rejectedFs, 1, 'Firestore: Competing reservation must be rejected');
  console.log('   PASS [Dual Adapter]: Concurrency limit strictly enforced across SQLite and Firestore.');

  // -------------------------------------------------------------------------
  // Scenario 2: Concurrent Requests Using the Same Idempotency Key
  // -------------------------------------------------------------------------
  console.log('Scenario 2 [Idempotency]: Simultaneous requests with the SAME idempotency key...');
  const sameKey = 'idem_identical_key_777';
  const [idemA, idemB] = await Promise.all([
    createPendingRefundReservation(null, { orderId: 'ORD-FS-01', amount_paise: 3000, reason: 'Idem 1', idempotency_key: sameKey, initiated_by: 'adm' }),
    createPendingRefundReservation(null, { orderId: 'ORD-FS-01', amount_paise: 3000, reason: 'Idem 2', idempotency_key: sameKey, initiated_by: 'adm' })
  ]);
  assert.strictEqual(idemA.refund.id, idemB.refund.id, 'Both concurrent requests must return identical refund ID');
  const replayCount = [idemA.isReplay, idemB.isReplay].filter(Boolean).length;
  assert.strictEqual(replayCount, 1, 'Exactly one request must be marked isReplay: true');
  console.log('   PASS [Idempotency]: Concurrent duplicate idempotency key safely handled.');

  // Reset Firestore back to null for offline SQLite tests
  setFirestoreForTesting({ firestoreInstance: null, clearStores: true });

  // -------------------------------------------------------------------------
  // Scenario 3: Firestore Hydration After a Pending Reservation (PART B Protection)
  // Proves that stale Firestore default values CANNOT overwrite newer SQLite refund balances
  // -------------------------------------------------------------------------
  console.log('Scenario 3 [Hydration Guard]: Firestore hydration after a local pending reservation...');
  const memDb3 = await createIsolatedNativeSqliteDb();
  const orderId3 = 'ORD-HYDRATE-03';
  await memDb3.run(
    `INSERT INTO orders (id, product_id, amount, status, machine_id, created_at, razorpay_payment_id, dispense_status, captured_amount_paise, updated_at)
     VALUES (?, 1, 100, 'COMPLETED', 'CFX-MC-01', datetime('now'), 'pay_hyd_3', 'DISPENSED', 10000, '2026-11-13T10:00:00.000Z')`,
    [orderId3]
  );

  // Reserve ₹50 in SQLite
  await createPendingRefundReservation(memDb3, {
    orderId: orderId3,
    amount_paise: 5000,
    reason: 'Local Reservation Before Hydration',
    initiated_by: 'admin',
    idempotency_key: 'idem_hyd_3'
  });

  // Now simulate remote Firestore having an older order document with pending_refund_amount_paise = 0
  const mockFs3 = new MockFirestoreForPhase27();
  await mockFs3.collection('orders').doc(orderId3).set({
    id: orderId3,
    amount: 100,
    status: 'COMPLETED',
    machine_id: 'CFX-MC-01',
    razorpay_payment_id: 'pay_hyd_3',
    dispense_status: 'DISPENSED',
    captured_amount_paise: 10000,
    pending_refund_amount_paise: 0, // Stale default in Firestore
    total_refunded_amount_paise: 0,
    refund_status: 'NONE',
    updated_at: '2026-11-13T09:00:00.000Z' // Older timestamp
  });

  // Activate Firestore and hydrate local order
  setFirestoreForTesting({ firestoreInstance: mockFs3, clearStores: false });
  const hydratedOrder = await getAuthoritativeOrderById(orderId3, memDb3);

  // CRITICAL ASSERTION: Local SQLite reservation must NOT be wiped out!
  assert.strictEqual(
    hydratedOrder.pending_refund_amount_paise,
    5000,
    'Hydration must NEVER overwrite a local active refund reservation with stale zero balance'
  );
  assert.strictEqual(hydratedOrder.refund_status, 'PENDING');
  console.log('   PASS [Hydration Guard]: Reserved refund was safely preserved during Firestore hydration.');

  // -------------------------------------------------------------------------
  // Scenario 4: Firestore Transaction Failure (Atomic Rollback)
  // -------------------------------------------------------------------------
  console.log('Scenario 4 [Firestore Rollback]: Transaction failure rolls back completely without partial state...');
  const failingFs = new MockFirestoreForPhase27();
  await failingFs.collection('orders').doc('ORD-FAIL-TX').set({
    id: 'ORD-FAIL-TX',
    amount: 100,
    status: 'COMPLETED',
    machine_id: 'CFX-MC-01',
    razorpay_payment_id: 'pay_fail_tx',
    captured_amount_paise: 10000,
    pending_refund_amount_paise: 0,
    total_refunded_amount_paise: 0,
    refund_status: 'NONE'
  });
  setFirestoreForTesting({ firestoreInstance: failingFs, clearStores: true });

  // Excessive reservation triggers transaction error
  let txFailedCaught = false;
  try {
    await createPendingRefundReservation(null, {
      orderId: 'ORD-FAIL-TX',
      amount_paise: 999999, // Exceeds balance
      reason: 'Should Fail',
      initiated_by: 'adm',
      idempotency_key: 'idem_fail_tx'
    });
  } catch (err: any) {
    txFailedCaught = true;
    assert.ok(err instanceof BadRequestError);
  }
  assert.strictEqual(txFailedCaught, true);

  const orderAfterFail = (await failingFs.collection('orders').doc('ORD-FAIL-TX').get()).data();
  assert.strictEqual(orderAfterFail.pending_refund_amount_paise, 0);
  assert.strictEqual(orderAfterFail.refund_status, 'NONE');
  console.log('   PASS [Firestore Rollback]: Failed transaction cleanly preserves zero balance changes.');

  // -------------------------------------------------------------------------
  // Scenario 5: Firestore Synchronization / Recovery After Process Failure
  // -------------------------------------------------------------------------
  console.log('Scenario 5 [Recovery]: State recovery from Firestore after cold start...');
  const recoveryFs = new MockFirestoreForPhase27();
  await recoveryFs.collection('orders').doc('ORD-RECOVER-01').set({
    id: 'ORD-RECOVER-01',
    product_id: 1,
    amount: 100,
    status: 'COMPLETED',
    machine_id: 'CFX-MC-01',
    razorpay_payment_id: 'pay_rec_1',
    captured_amount_paise: 10000,
    pending_refund_amount_paise: 0,
    total_refunded_amount_paise: 0,
    refund_status: 'NONE'
  });
  setFirestoreForTesting({ firestoreInstance: recoveryFs, clearStores: true });

  // Reserve and process refund on Instance 1
  const recRes = await createPendingRefundReservation(null, {
    orderId: 'ORD-RECOVER-01',
    amount_paise: 4000,
    reason: 'Recovery Test',
    initiated_by: 'adm1',
    idempotency_key: 'idem_rec_1'
  });
  await markRefundProcessed(null, { refundId: recRes.refund.id, razorpay_refund_id: 'rfnd_rec_1' });

  // Simulate Instance 2 cold start (empty local memory & brand new SQLite database)
  clearSyncedRefundsStore();
  const coldMemDb = await createIsolatedNativeSqliteDb();

  // Read authoritative refund and order on cold instance
  const recoveredRefund = await getRefundById(coldMemDb, recRes.refund.id);
  const recoveredOrder = await getAuthoritativeOrderById('ORD-RECOVER-01', coldMemDb);

  assert.ok(recoveredRefund);
  assert.strictEqual(recoveredRefund?.status, 'PROCESSED');
  assert.strictEqual(recoveredOrder.total_refunded_amount_paise, 4000);
  assert.strictEqual(recoveredOrder.refund_status, 'PARTIAL');
  console.log('   PASS [Recovery]: State safely recovered from authoritative Firestore after process restart.');

  // -------------------------------------------------------------------------
  // Scenario 6: Duplicate Processing Notifications (Idempotent Replay)
  // -------------------------------------------------------------------------
  console.log('Scenario 6 [Duplicate Processing]: Replay returns isReplay: true with 0 balance mutation...');
  const firstProc = await markRefundProcessed(coldMemDb, { refundId: recRes.refund.id, razorpay_refund_id: 'rfnd_rec_1' });
  assert.strictEqual(firstProc.isReplay, true, 'Duplicate processing call must return isReplay: true');
  assert.strictEqual(firstProc.order.total_refunded_amount_paise, 4000, 'Total refunded must not double-increment');
  console.log('   PASS [Duplicate Processing]: Duplicate notification safely replayed.');

  // -------------------------------------------------------------------------
  // Scenario 7: Concurrent Processing & Failure Conflict on Same Refund
  // -------------------------------------------------------------------------
  console.log('Scenario 7 [Terminal State Conflict]: Competing processed and failed transitions for same refund...');
  const conflictRes = await createPendingRefundReservation(coldMemDb, {
    orderId: 'ORD-RECOVER-01',
    amount_paise: 3000,
    reason: 'Conflict Test',
    initiated_by: 'adm',
    idempotency_key: 'idem_conflict_7'
  });

  const [procResult, failResult] = await Promise.allSettled([
    markRefundProcessed(coldMemDb, { refundId: conflictRes.refund.id, razorpay_refund_id: 'rfnd_conf_proc' }),
    markRefundFailed(coldMemDb, { refundId: conflictRes.refund.id, error_code: 'DECLINED', error_description: 'Bank decline' })
  ]);

  const fulfilled7 = [procResult, failResult].filter(r => r.status === 'fulfilled').length;
  const rejected7 = [procResult, failResult].filter(r => r.status === 'rejected').length;
  assert.strictEqual(fulfilled7, 1, 'Exactly one competing terminal transition must succeed');
  assert.strictEqual(rejected7, 1, 'The competing conflicting terminal transition must be rejected');
  console.log('   PASS [Terminal State Conflict]: Competing terminal states safely mutually excluded.');

  // Switch back to offline SQLite for payment amount tests
  setFirestoreForTesting({ firestoreInstance: null, clearStores: true });

  // -------------------------------------------------------------------------
  // Scenario 8: Partial Payment Capture (orders.captured_amount_paise)
  // -------------------------------------------------------------------------
  console.log('Scenario 8 [Partial Capture]: Captured amount is ₹70 on a ₹100 order...');
  const memDb8 = await createIsolatedNativeSqliteDb();
  const orderId8 = 'ORD-PARTIAL-CAP-08';
  await memDb8.run(
    `INSERT INTO orders (id, product_id, amount, status, machine_id, created_at, razorpay_payment_id, dispense_status, captured_amount_paise)
     VALUES (?, 1, 100, 'COMPLETED', 'CFX-MC-01', datetime('now'), 'pay_cap_8', 'DISPENSED', 7000)`,
    [orderId8]
  );
  const order8 = await memDb8.get('SELECT * FROM orders WHERE id = ?', [orderId8]);
  const bal8 = calculateRemainingRefundableBalance(order8);
  assert.strictEqual(bal8.orderAmountPaise, 7000, 'Refundable capacity must be strictly 7000 paise (not 10000)');
  assert.strictEqual(bal8.remainingRefundablePaise, 7000);

  // Attempting ₹80 refund on ₹70 captured order must fail
  let overRefundCaught = false;
  try {
    await createPendingRefundReservation(memDb8, {
      orderId: orderId8,
      amount_paise: 8000,
      reason: 'Over-refund test',
      initiated_by: 'adm',
      idempotency_key: 'idem_cap_8_over'
    });
  } catch (err: any) {
    overRefundCaught = true;
    assert.ok(err instanceof BadRequestError);
    assert.ok(err.message.includes('exceeds remaining available refundable balance of 7000 paise'));
  }
  assert.strictEqual(overRefundCaught, true);

  // Refunding ₹70 must succeed
  const validRes8 = await createPendingRefundReservation(memDb8, {
    orderId: orderId8,
    amount_paise: 7000,
    reason: 'Exact capture refund',
    initiated_by: 'adm',
    idempotency_key: 'idem_cap_8_exact'
  });
  assert.strictEqual(validRes8.refund.amount_paise, 7000);
  console.log('   PASS [Partial Capture]: Refund capacity strictly bounded by captured_amount_paise.');

  // -------------------------------------------------------------------------
  // Scenario 9: Discounted Payment
  // -------------------------------------------------------------------------
  console.log('Scenario 9 [Discounted Payment]: Order ₹100 with ₹20 discount captured at ₹80 (8000 paise)...');
  const memDb9 = await createIsolatedNativeSqliteDb();
  const orderId9 = 'ORD-DISC-09';
  await memDb9.run(
    `INSERT INTO orders (id, product_id, amount, status, machine_id, created_at, razorpay_payment_id, dispense_status, captured_amount_paise)
     VALUES (?, 1, 100, 'COMPLETED', 'CFX-MC-01', datetime('now'), 'pay_disc_9', 'DISPENSED', 8000)`,
    [orderId9]
  );
  const order9 = await memDb9.get('SELECT * FROM orders WHERE id = ?', [orderId9]);
  const bal9 = calculateRemainingRefundableBalance(order9);
  assert.strictEqual(bal9.orderAmountPaise, 8000);
  assert.strictEqual(bal9.remainingRefundablePaise, 8000);
  console.log('   PASS [Discounted Payment]: Discounted captured payment capacity correctly calculated.');

  // -------------------------------------------------------------------------
  // Scenario 10: Captured Amount Differing from Order Amount (Surcharge / Price Delta)
  // -------------------------------------------------------------------------
  console.log('Scenario 10 [Mismatched Amount]: Captured amount 6500 paise vs order amount 100...');
  const memDb10 = await createIsolatedNativeSqliteDb();
  const orderId10 = 'ORD-MISMATCH-10';
  await memDb10.run(
    `INSERT INTO orders (id, product_id, amount, status, machine_id, created_at, razorpay_payment_id, dispense_status, captured_amount_paise)
     VALUES (?, 1, 100, 'COMPLETED', 'CFX-MC-01', datetime('now'), 'pay_mis_10', 'DISPENSED', 6500)`,
    [orderId10]
  );
  const order10 = await memDb10.get('SELECT * FROM orders WHERE id = ?', [orderId10]);
  const bal10 = calculateRemainingRefundableBalance(order10);
  assert.strictEqual(bal10.orderAmountPaise, 6500);
  assert.strictEqual(bal10.remainingRefundablePaise, 6500);
  console.log('   PASS [Mismatched Amount]: Captured amount takes precedence over order.amount.');

  // -------------------------------------------------------------------------
  // Scenario 11: Historical Order Without captured_amount_paise (Part A Fail-Closed)
  // -------------------------------------------------------------------------
  console.log('Scenario 11 [Historical Order]: Pre-Phase 2.7.1.4 order without captured_amount_paise...');
  const memDb11 = await createIsolatedNativeSqliteDb();
  const orderId11A = 'ORD-HIST-PAID';
  const orderId11B = 'ORD-HIST-FAILED';
  await memDb11.run(
    `INSERT INTO orders (id, product_id, amount, status, machine_id, created_at, razorpay_payment_id, dispense_status, captured_amount_paise)
     VALUES (?, 1, 100, 'COMPLETED', 'CFX-MC-01', datetime('now'), 'pay_hist_1', 'DISPENSED', NULL)`,
    [orderId11A]
  );
  await memDb11.run(
    `INSERT INTO orders (id, product_id, amount, status, machine_id, created_at, razorpay_payment_id, dispense_status, captured_amount_paise)
     VALUES (?, 1, 100, 'FAILED', 'CFX-MC-01', datetime('now'), NULL, 'FAILED', NULL)`,
    [orderId11B]
  );

  const order11A = await memDb11.get('SELECT * FROM orders WHERE id = ?', [orderId11A]);
  const order11B = await memDb11.get('SELECT * FROM orders WHERE id = ?', [orderId11B]);

  const bal11A = calculateRemainingRefundableBalance(order11A);
  const bal11B = calculateRemainingRefundableBalance(order11B);

  // Historical COMPLETED order: fallback exists for display and reporting (₹100 = 10000 paise)
  assert.strictEqual(bal11A.orderAmountPaise, 10000, 'Historical COMPLETED order falls back to ₹100 = 10000 paise for display/reporting');
  assert.strictEqual(bal11A.isLegacyFallback, true, 'Must be marked as legacy fallback');
  assert.strictEqual(bal11A.isExactCaptureKnown, false, 'Exact capture must be unknown');
  // CRITICAL FAIL-CLOSED: must NOT authorize real refund!
  assert.strictEqual(bal11A.canAcceptRefund, false, 'Historical order without verified captured amount must NOT authorize refund');

  assert.strictEqual(bal11B.orderAmountPaise, 0, 'Historical FAILED order strictly yields 0 capacity');
  assert.strictEqual(bal11B.canAcceptRefund, false);

  // Attempting SQLite reservation on historical order without captured_amount_paise must throw ConflictError
  let histSqliteBlocked = false;
  try {
    await createPendingRefundReservation(memDb11, {
      orderId: orderId11A,
      amount_paise: 5000,
      reason: 'Historical Test',
      initiated_by: 'admin',
      idempotency_key: 'idem_hist_sqlite'
    });
  } catch (err: any) {
    histSqliteBlocked = true;
    assert.ok(err instanceof ConflictError, 'Must throw ConflictError for unverified capture');
    assert.ok(err.message.includes('exact captured payment amount is unverified'));
  }
  assert.strictEqual(histSqliteBlocked, true, 'SQLite must block refund for order with NULL captured_amount_paise');

  // Attempting Firestore reservation on historical order without captured_amount_paise must also throw ConflictError
  const mockFs11 = new MockFirestoreForPhase27();
  await mockFs11.collection('orders').doc('ORD-HIST-FS').set({
    id: 'ORD-HIST-FS',
    amount: 100,
    status: 'COMPLETED',
    machine_id: 'CFX-MC-01',
    razorpay_payment_id: 'pay_hist_fs',
    captured_amount_paise: null,
    pending_refund_amount_paise: 0,
    total_refunded_amount_paise: 0,
    refund_status: 'NONE'
  });
  setFirestoreForTesting({ firestoreInstance: mockFs11, clearStores: true });

  let histFsBlocked = false;
  try {
    await createPendingRefundReservation(null, {
      orderId: 'ORD-HIST-FS',
      amount_paise: 5000,
      reason: 'Historical FS Test',
      initiated_by: 'admin',
      idempotency_key: 'idem_hist_fs'
    });
  } catch (err: any) {
    histFsBlocked = true;
    assert.ok(err instanceof ConflictError, 'Firestore must throw ConflictError for unverified capture');
    assert.ok(err.message.includes('exact captured payment amount is unverified'));
  }
  assert.strictEqual(histFsBlocked, true, 'Firestore must block refund for order with NULL captured_amount_paise');

  // Fabricated amount_paise on order cannot authorize real refund
  const fabricatedOrder = {
    ...order11A,
    amount_paise: 10000,
    captured_amount_paise: null
  };
  const fabricatedBal = calculateRemainingRefundableBalance(fabricatedOrder);
  assert.strictEqual(fabricatedBal.isExactCaptureKnown, false);
  assert.strictEqual(fabricatedBal.canAcceptRefund, false);

  setFirestoreForTesting({ firestoreInstance: null, clearStores: true });
  console.log('   PASS [Historical Order]: Safe compatibility & fail-closed policy strictly enforced.');

  // -------------------------------------------------------------------------
  // Scenario 12: Full Refund and Multiple Partial Refunds
  // -------------------------------------------------------------------------
  console.log('Scenario 12 [Partial & Full Sequence]: Progression through multiple partial refunds to FULL...');
  const memDb12 = await createIsolatedNativeSqliteDb();
  const orderId12 = 'ORD-SEQ-12';
  await memDb12.run(
    `INSERT INTO orders (id, product_id, amount, status, machine_id, created_at, razorpay_payment_id, dispense_status, captured_amount_paise)
     VALUES (?, 1, 100, 'COMPLETED', 'CFX-MC-01', datetime('now'), 'pay_seq_12', 'DISPENSED', 10000)`,
    [orderId12]
  );

  // Partial 1: ₹30
  const p1 = await createPendingRefundReservation(memDb12, { orderId: orderId12, amount_paise: 3000, reason: 'P1', idempotency_key: 'k12_1', initiated_by: 'adm' });
  const p1Proc = await markRefundProcessed(memDb12, { refundId: p1.refund.id });
  assert.strictEqual(p1Proc.order.total_refunded_amount_paise, 3000);
  assert.strictEqual(p1Proc.order.refund_status, 'PARTIAL');

  // Partial 2: ₹70 (completes order)
  const p2 = await createPendingRefundReservation(memDb12, { orderId: orderId12, amount_paise: 7000, reason: 'P2', idempotency_key: 'k12_2', initiated_by: 'adm' });
  const p2Proc = await markRefundProcessed(memDb12, { refundId: p2.refund.id });
  assert.strictEqual(p2Proc.order.total_refunded_amount_paise, 10000);
  assert.strictEqual(p2Proc.order.refund_status, 'FULL');

  const bal12 = calculateRemainingRefundableBalance(p2Proc.order);
  assert.strictEqual(bal12.isFullyRefunded, true);
  assert.strictEqual(bal12.remainingRefundablePaise, 0);
  console.log('   PASS [Partial & Full Sequence]: Full refund lifecycle verified.');

  // -------------------------------------------------------------------------
  // Scenario 13: Repeated Migrations (Idempotence)
  // -------------------------------------------------------------------------
  console.log('Scenario 13 [Migration Idempotence]: Consecutive dynamic migrations on SQLite...');
  const migDb = await sqliteOpen({ filename: ':memory:', driver: sqlite3.Database });
  await migDb.exec(`
    CREATE TABLE orders (
      id TEXT PRIMARY KEY, product_id INTEGER NOT NULL, amount INTEGER NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('PENDING', 'PAID', 'PREPARING', 'COMPLETED', 'FAILED', 'CANCELLED')),
      machine_id TEXT NOT NULL, created_at TEXT NOT NULL
    );
  `);

  for (let cycle = 1; cycle <= 3; cycle++) {
    const info = await migDb.all('PRAGMA table_info(orders)');
    if (!info.some((col: any) => col.name === 'refund_status')) {
      await migDb.exec("ALTER TABLE orders ADD COLUMN refund_status TEXT DEFAULT 'NONE' CHECK(refund_status IN ('NONE', 'PENDING', 'PARTIAL', 'FULL', 'FAILED'));");
    }
    if (!info.some((col: any) => col.name === 'total_refunded_amount_paise')) {
      await migDb.exec("ALTER TABLE orders ADD COLUMN total_refunded_amount_paise INTEGER DEFAULT 0;");
    }
    if (!info.some((col: any) => col.name === 'pending_refund_amount_paise')) {
      await migDb.exec("ALTER TABLE orders ADD COLUMN pending_refund_amount_paise INTEGER DEFAULT 0;");
    }
    if (!info.some((col: any) => col.name === 'last_refunded_at')) {
      await migDb.exec("ALTER TABLE orders ADD COLUMN last_refunded_at TEXT;");
    }
    if (!info.some((col: any) => col.name === 'captured_amount_paise')) {
      await migDb.exec("ALTER TABLE orders ADD COLUMN captured_amount_paise INTEGER DEFAULT NULL;");
    }
  }

  const finalCols = (await migDb.all('PRAGMA table_info(orders)')).map((c: any) => c.name);
  assert.ok(finalCols.includes('refund_status'));
  assert.ok(finalCols.includes('total_refunded_amount_paise'));
  assert.ok(finalCols.includes('pending_refund_amount_paise'));
  assert.ok(finalCols.includes('last_refunded_at'));
  assert.ok(finalCols.includes('captured_amount_paise'));
  console.log('   PASS [Migration Idempotence]: Dynamic migrations executed 3 times with 100% idempotence.');

  // =========================================================================
  // Scenario 14: Payment Controller -> Webhook Integration (PART A)
  // =========================================================================
  console.log('\nScenario 14 [Controller Integration]: Verify endpoint -> payment.captured webhook -> duplicate...');
  await initDB();
  const db14 = getDB();

  // Create test product and machine in shared DB
  await db14.run("INSERT OR REPLACE INTO machines (id, machine_name, location, status) VALUES ('CFX-MC-01', 'Kiosk-One', 'Test Location', 'online')");
  await db14.run("INSERT OR REPLACE INTO products (id, name, description, price) VALUES (1, 'Classic Espresso', 'Fresh roast', 100)");

  const orderId14 = 'CFX-TEST-ORD-14';
  const rpOrderId14 = 'order_rp_mock_14';
  const rpPayId14 = 'pay_rp_mock_14';

  // Seed order in PENDING status without captured_amount_paise
  await db14.run('DELETE FROM refunds WHERE order_id = ?', [orderId14]);
  await db14.run(
    `INSERT OR REPLACE INTO orders (
      id, product_id, amount, status, machine_id, created_at,
      razorpay_order_id, dispense_status, captured_amount_paise
    ) VALUES (?, 1, 100, 'PENDING', 'CFX-MC-01', datetime('now'), ?, 'PENDING', NULL)`,
    [orderId14, rpOrderId14]
  );

  process.env.RAZORPAY_KEY_SECRET = 'phase2_7_test_key_secret_123';
  process.env.RAZORPAY_WEBHOOK_SECRET = 'phase2_7_test_webhook_secret_key_123';

  const keySecret = process.env.RAZORPAY_KEY_SECRET;
  const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET;
  const validPaymentSig = crypto
    .createHmac('sha256', keySecret)
    .update(`${rpOrderId14}|${rpPayId14}`)
    .digest('hex');

  function createMockReqRes(options: {
    body?: any;
    headers?: Record<string, string>;
    user?: any;
    rawBody?: Buffer;
  }) {
    let statusCode = 200;
    let responseData: any = null;
    const res: any = {
      status: (code: number) => {
        statusCode = code;
        return res;
      },
      json: (data: any) => {
        responseData = data;
        return res;
      }
    };
    const rawBody = options.rawBody || Buffer.from(JSON.stringify(options.body || {}));
    const req: any = {
      body: options.body || {},
      headers: options.headers || {},
      user: options.user || null,
      rawBody
    };
    const next = (err?: any) => {
      if (err) throw err;
    };
    return { req, res, getStatus: () => statusCode, getData: () => responseData, next };
  }

  // 14.1: Normal Kiosk Payment Verification (/api/payments/verify)
  const verifyCall = createMockReqRes({
    body: {
      order_id: orderId14,
      razorpay_order_id: rpOrderId14,
      razorpay_payment_id: rpPayId14,
      razorpay_signature: validPaymentSig
    },
    user: { role: 'kiosk', machine_id: 'CFX-MC-01' }
  });
  await verifyPaymentSignature(verifyCall.req, verifyCall.res, verifyCall.next);

  const verifiedOrder = await db14.get('SELECT * FROM orders WHERE id = ?', [orderId14]);
  assert.strictEqual(verifiedOrder.status, 'PAID', 'Order must transition to PAID on signature verification');
  assert.strictEqual(
    verifiedOrder.captured_amount_paise,
    null,
    'Kiosk verification must NOT depend on client-supplied captured amount'
  );

  // 14.2: Verified payment.captured webhook arrives for the already-PAID order
  const webhookPayload = {
    event: 'payment.captured',
    payload: {
      payment: {
        entity: {
          id: rpPayId14,
          order_id: rpOrderId14,
          amount: 10000,
          currency: 'INR'
        }
      }
    }
  };
  const webhookBytes = Buffer.from(JSON.stringify(webhookPayload));
  const webhookSig = crypto.createHmac('sha256', webhookSecret).update(webhookBytes).digest('hex');

  const webhookCall = createMockReqRes({
    body: webhookPayload,
    headers: { 'x-razorpay-signature': webhookSig },
    rawBody: webhookBytes
  });
  await handleRazorpayWebhook(webhookCall.req, webhookCall.res, webhookCall.next);

  const orderAfterWebhook = await db14.get('SELECT * FROM orders WHERE id = ?', [orderId14]);
  assert.strictEqual(
    orderAfterWebhook.captured_amount_paise,
    10000,
    'Webhook must persist exact captured_amount_paise (10000) even when order was already PAID'
  );

  // 14.3: Duplicate webhook delivery (Idempotence)
  const duplicateWebhookCall = createMockReqRes({
    body: webhookPayload,
    headers: { 'x-razorpay-signature': webhookSig },
    rawBody: webhookBytes
  });
  await handleRazorpayWebhook(duplicateWebhookCall.req, duplicateWebhookCall.res, duplicateWebhookCall.next);
  const orderAfterDuplicate = await db14.get('SELECT * FROM orders WHERE id = ?', [orderId14]);
  assert.strictEqual(orderAfterDuplicate.captured_amount_paise, 10000, 'Duplicate webhook must be idempotent');

  // 14.4: Non-INR currency rejection
  const nonInrPayload = {
    event: 'payment.captured',
    payload: {
      payment: {
        entity: {
          id: 'pay_usd_fake',
          order_id: rpOrderId14,
          amount: 1000,
          currency: 'USD'
        }
      }
    }
  };
  const nonInrBytes = Buffer.from(JSON.stringify(nonInrPayload));
  const nonInrSig = crypto.createHmac('sha256', webhookSecret).update(nonInrBytes).digest('hex');
  const nonInrCall = createMockReqRes({
    body: nonInrPayload,
    headers: { 'x-razorpay-signature': nonInrSig },
    rawBody: nonInrBytes
  });
  await handleRazorpayWebhook(nonInrCall.req, nonInrCall.res, nonInrCall.next);
  const orderAfterNonInr = await db14.get('SELECT * FROM orders WHERE id = ?', [orderId14]);
  assert.strictEqual(orderAfterNonInr.captured_amount_paise, 10000, 'Non-INR webhook must not alter captured amount');

  // 14.5: Conflicting amount rejection
  const conflictPayload = {
    event: 'payment.captured',
    payload: {
      payment: {
        entity: {
          id: rpPayId14,
          order_id: rpOrderId14,
          amount: 8500, // Conflict: 8500 vs existing 10000
          currency: 'INR'
        }
      }
    }
  };
  const conflictBytes = Buffer.from(JSON.stringify(conflictPayload));
  const conflictSig = crypto.createHmac('sha256', webhookSecret).update(conflictBytes).digest('hex');
  const conflictCall = createMockReqRes({
    body: conflictPayload,
    headers: { 'x-razorpay-signature': conflictSig },
    rawBody: conflictBytes
  });
  await handleRazorpayWebhook(conflictCall.req, conflictCall.res, conflictCall.next);
  const orderAfterConflict = await db14.get('SELECT * FROM orders WHERE id = ?', [orderId14]);
  assert.strictEqual(
    orderAfterConflict.captured_amount_paise,
    10000,
    'Conflicting webhook amount must be rejected safely without overwriting stored amount'
  );

  // 14.6: Tampered/invalid webhook signature rejection
  const tamperedSigCall = createMockReqRes({
    body: webhookPayload,
    headers: { 'x-razorpay-signature': '0000000000000000000000000000000000000000000000000000000000000000' },
    rawBody: webhookBytes
  });
  await handleRazorpayWebhook(tamperedSigCall.req, tamperedSigCall.res, tamperedSigCall.next);
  assert.strictEqual(
    tamperedSigCall.getStatus(),
    400,
    'Tampered webhook signature must be rejected with HTTP 400'
  );

  console.log('   PASS [Controller Integration]: Verified payment verify -> webhook capture pipeline.');

  // =========================================================================
  // Scenario 15: Production & Preview Fail-Closed Persistence (PART B)
  // =========================================================================
  console.log('Scenario 15 [Fail-Closed Persistence]: Enforce 503 when Firestore is unavailable in Production/Preview...');
  const initialVercelEnv = process.env.VERCEL_ENV;
  const initialVercel = process.env.VERCEL;

  try {
    // 15.1: Production environment with Firestore unavailable
    process.env.VERCEL_ENV = 'production';
    setFirestoreForTesting({ firestoreInstance: null, clearStores: true });

    let prod503Caught = false;
    try {
      await createPendingRefundReservation(db14, {
        orderId: orderId14,
        amount_paise: 5000,
        reason: 'Prod Fail Closed Test',
        initiated_by: 'admin',
        idempotency_key: 'idem_prod_fail_closed'
      });
    } catch (err: any) {
      prod503Caught = true;
      assert.ok(err instanceof ServiceUnavailableError, 'Must throw ServiceUnavailableError in Production');
      assert.strictEqual(err.statusCode, 503);
    }
    assert.strictEqual(prod503Caught, true, 'Production without Firestore must fail closed with HTTP 503');

    // 15.2: Preview environment with Firestore unavailable
    process.env.VERCEL_ENV = 'preview';
    let preview503Caught = false;
    try {
      await createPendingRefundReservation(db14, {
        orderId: orderId14,
        amount_paise: 5000,
        reason: 'Preview Fail Closed Test',
        initiated_by: 'admin',
        idempotency_key: 'idem_prev_fail_closed'
      });
    } catch (err: any) {
      preview503Caught = true;
      assert.ok(err instanceof ServiceUnavailableError);
      assert.strictEqual(err.statusCode, 503);
    }
    assert.strictEqual(preview503Caught, true, 'Preview without Firestore must fail closed with HTTP 503');

    // 15.3: Production with Firestore active succeeds
    const prodFs = new MockFirestoreForPhase27();
    await prodFs.collection('orders').doc(orderId14).set({
      id: orderId14,
      amount: 100,
      status: 'PAID',
      machine_id: 'CFX-MC-01',
      razorpay_payment_id: rpPayId14,
      captured_amount_paise: 10000,
      pending_refund_amount_paise: 0,
      total_refunded_amount_paise: 0,
      refund_status: 'NONE'
    });
    setFirestoreForTesting({ firestoreInstance: prodFs, clearStores: true });
    process.env.VERCEL_ENV = 'production';

    const prodRefundRes = await createPendingRefundReservation(db14, {
      orderId: orderId14,
      amount_paise: 4000,
      reason: 'Prod Success Test',
      initiated_by: 'admin',
      idempotency_key: 'idem_prod_success'
    });
    assert.strictEqual(prodRefundRes.refund.amount_paise, 4000);
    assert.strictEqual(prodRefundRes.order.pending_refund_amount_paise, 4000);

  } finally {
    if (initialVercelEnv !== undefined) {
      process.env.VERCEL_ENV = initialVercelEnv;
    } else {
      delete process.env.VERCEL_ENV;
    }
    if (initialVercel !== undefined) {
      process.env.VERCEL = initialVercel;
    } else {
      delete process.env.VERCEL;
    }
    setFirestoreForTesting({ firestoreInstance: null, clearStores: true });
  }
  console.log('   PASS [Fail-Closed Persistence]: Production/Preview fails closed with 503 when Firestore is absent.');

  // =========================================================================
  // Scenario 16: Elimination of Offline SQLite Real-Payment Split-Brain (PART C)
  // =========================================================================
  console.log('Scenario 16 [Split-Brain Protection]: Prevent offline SQLite reservations for live payments...');
  const initialNodeEnv = process.env.NODE_ENV;
  const splitMemDb = await createIsolatedNativeSqliteDb();
  const liveOrderOrderId = 'ORD-LIVE-PAY-16';

  await splitMemDb.run(
    `INSERT INTO orders (id, product_id, amount, status, machine_id, created_at, razorpay_payment_id, dispense_status, captured_amount_paise)
     VALUES (?, 1, 100, 'COMPLETED', 'CFX-MC-01', datetime('now'), 'pay_live_real_xyz123', 'DISPENSED', 10000)`,
    [liveOrderOrderId]
  );

  try {
    process.env.NODE_ENV = 'production';
    setFirestoreForTesting({ firestoreInstance: null, clearStores: true });

    let splitBrainCaught = false;
    try {
      await createPendingRefundReservation(splitMemDb, {
        orderId: liveOrderOrderId,
        amount_paise: 6000,
        reason: 'Split Brain Offline Test',
        initiated_by: 'kiosk_offline',
        idempotency_key: 'idem_split_brain_16'
      });
    } catch (err: any) {
      splitBrainCaught = true;
      assert.ok(err instanceof ServiceUnavailableError || err instanceof ConflictError);
    }
    assert.strictEqual(splitBrainCaught, true, 'Offline SQLite refund for live payment must be rejected');
  } finally {
    process.env.NODE_ENV = initialNodeEnv;
  }
  console.log('   PASS [Split-Brain Protection]: Live payments cannot establish offline SQLite reservations.');

  // =========================================================================
  // Scenario 17: Hydration Ownership and Overwrite Isolation (PART D)
  // =========================================================================
  console.log('Scenario 17 [Hydration Ownership]: Ensure unrelated remote updates NEVER reset local pending balance...');
  const memDb17 = await createIsolatedNativeSqliteDb();
  const orderId17 = 'ORD-HYDRATE-OWNERSHIP-17';

  // Seed order in SQLite with active pending reservation of ₹50 (5000 paise) and its refund record
  await memDb17.run(
    `INSERT INTO orders (
      id, product_id, amount, status, machine_id, created_at, razorpay_payment_id,
      dispense_status, captured_amount_paise, pending_refund_amount_paise, total_refunded_amount_paise,
      refund_status, updated_at
    ) VALUES (?, 1, 100, 'COMPLETED', 'CFX-MC-01', datetime('now'), 'pay_hyd_17', 'PENDING', 10000, 5000, 0, 'PENDING', '2026-11-13T10:00:00.000Z')`,
    [orderId17]
  );
  await memDb17.run(
    `INSERT INTO refunds (
      id, order_id, machine_id, razorpay_payment_id, amount_paise, status, reason, initiated_by, source, idempotency_key, created_at, updated_at
    ) VALUES ('RFND-HYD-17-A', ?, 'CFX-MC-01', 'pay_hyd_17', 5000, 'PENDING', 'Initial reservation', 'admin', 'SUPER_ADMIN_PORTAL', 'idem_hyd_17_a', datetime('now'), datetime('now'))`,
    [orderId17]
  );

  // Firestore has remote zero default, BUT an unrelated dispense event bumped remote updated_at
  const mockFs17 = new MockFirestoreForPhase27();
  await mockFs17.collection('orders').doc(orderId17).set({
    id: orderId17,
    amount: 100,
    status: 'COMPLETED',
    machine_id: 'CFX-MC-01',
    razorpay_payment_id: 'pay_hyd_17',
    dispense_status: 'DISPENSED', // Unrelated dispense update!
    dispensed_at: '2026-11-13T10:05:00.000Z',
    captured_amount_paise: 10000,
    pending_refund_amount_paise: 0, // Stale default in Firestore
    total_refunded_amount_paise: 0,
    refund_status: 'NONE',
    updated_at: '2026-11-13T10:05:00.000Z' // Newer remote timestamp!
  });

  setFirestoreForTesting({ firestoreInstance: mockFs17, clearStores: false });
  const hydrated17A = await getAuthoritativeOrderById(orderId17, memDb17);

  // CRITICAL: Local 5000 must NOT be clobbered by remote zero despite newer timestamp
  assert.strictEqual(
    hydrated17A.pending_refund_amount_paise,
    5000,
    'Unrelated remote timestamp update must NEVER overwrite local pending refund with 0'
  );
  assert.strictEqual(hydrated17A.refund_status, 'PENDING');
  assert.strictEqual(
    hydrated17A.dispense_status,
    'DISPENSED',
    'Unrelated dispense_status update must be safely synced'
  );

  // 17.2: Authoritative remote transaction confirms higher pending balance (6000 paise) via refund document
  await mockFs17.collection('orders').doc(orderId17).collection('refunds').doc('RFND-HYD-17-B').set({
    id: 'RFND-HYD-17-B',
    order_id: orderId17,
    machine_id: 'CFX-MC-01',
    razorpay_payment_id: 'pay_hyd_17',
    amount_paise: 6000,
    status: 'PENDING',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  });
  await mockFs17.collection('orders').doc(orderId17).set({
    pending_refund_amount_paise: 6000,
    refund_status: 'PENDING'
  }, { merge: true });

  const hydrated17B = await getAuthoritativeOrderById(orderId17, memDb17);
  assert.strictEqual(
    hydrated17B.pending_refund_amount_paise,
    6000,
    'Authoritative remote distributed transaction balance must be adopted'
  );

  // 17.3: Authoritative remote settles the refund (total=6000, pending=0)
  await mockFs17.collection('orders').doc(orderId17).collection('refunds').doc('RFND-HYD-17-B').set({
    status: 'PROCESSED',
    processed_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  }, { merge: true });
  await mockFs17.collection('orders').doc(orderId17).set({
    pending_refund_amount_paise: 0,
    total_refunded_amount_paise: 6000,
    refund_status: 'PARTIAL'
  }, { merge: true });

  const hydrated17C = await getAuthoritativeOrderById(orderId17, memDb17);
  assert.strictEqual(hydrated17C.pending_refund_amount_paise, 0);
  assert.strictEqual(hydrated17C.total_refunded_amount_paise, 6000);
  assert.strictEqual(hydrated17C.refund_status, 'PARTIAL');
  console.log('   PASS [Hydration Ownership]: Refund balances are strictly isolated from generic order updates.');

  // =========================================================================
  // Scenario 18: Complete End-to-End Financial Flow (PART E)
  // =========================================================================
  console.log('Scenario 18 [End-to-End Financial Flow]: Full order -> verify -> webhook -> concurrent refunds...');
  const e2eFs = new MockFirestoreForPhase27();
  setFirestoreForTesting({ firestoreInstance: e2eFs, clearStores: true });

  const e2eOrderId = 'ORD-E2E-FLOW-18';
  const e2eRpOrderId = 'order_e2e_rp_18';
  const e2eRpPayId = 'pay_e2e_rp_18';

  // 1. Order created in Firestore & SQLite
  await e2eFs.collection('orders').doc(e2eOrderId).set({
    id: e2eOrderId,
    product_id: 1,
    amount: 100,
    status: 'PENDING',
    machine_id: 'CFX-MC-01',
    razorpay_order_id: e2eRpOrderId,
    dispense_status: 'PENDING',
    captured_amount_paise: null,
    pending_refund_amount_paise: 0,
    total_refunded_amount_paise: 0,
    refund_status: 'NONE'
  });
  await db14.run('DELETE FROM refunds WHERE order_id = ?', [e2eOrderId]);
  await db14.run(
    `INSERT OR REPLACE INTO orders (
      id, product_id, amount, status, machine_id, created_at,
      razorpay_order_id, dispense_status, captured_amount_paise
    ) VALUES (?, 1, 100, 'PENDING', 'CFX-MC-01', datetime('now'), ?, 'PENDING', NULL)`,
    [e2eOrderId, e2eRpOrderId]
  );

  // 2. Kiosk verify payment signature
  const e2eSig = crypto.createHmac('sha256', keySecret).update(`${e2eRpOrderId}|${e2eRpPayId}`).digest('hex');
  const e2eVerifyCall = createMockReqRes({
    body: {
      order_id: e2eOrderId,
      razorpay_order_id: e2eRpOrderId,
      razorpay_payment_id: e2eRpPayId,
      razorpay_signature: e2eSig
    },
    user: { role: 'kiosk', machine_id: 'CFX-MC-01' }
  });
  await verifyPaymentSignature(e2eVerifyCall.req, e2eVerifyCall.res, e2eVerifyCall.next);

  // 3. Webhook delivery saves captured_amount_paise = 10000
  const e2eWebhookPayload = {
    event: 'payment.captured',
    payload: {
      payment: {
        entity: {
          id: e2eRpPayId,
          order_id: e2eRpOrderId,
          amount: 10000,
          currency: 'INR'
        }
      }
    }
  };
  const e2eWebhookBytes = Buffer.from(JSON.stringify(e2eWebhookPayload));
  const e2eWebhookSig = crypto.createHmac('sha256', webhookSecret).update(e2eWebhookBytes).digest('hex');
  const e2eWebhookCall = createMockReqRes({
    body: e2eWebhookPayload,
    headers: { 'x-razorpay-signature': e2eWebhookSig },
    rawBody: e2eWebhookBytes
  });
  await handleRazorpayWebhook(e2eWebhookCall.req, e2eWebhookCall.res, e2eWebhookCall.next);

  const e2eDoc = (await e2eFs.collection('orders').doc(e2eOrderId).get()).data();
  assert.strictEqual(e2eDoc.captured_amount_paise, 10000);

  // 4. Capacity check
  const e2eBal = calculateRemainingRefundableBalance(e2eDoc);
  assert.strictEqual(e2eBal.remainingRefundablePaise, 10000);
  assert.strictEqual(e2eBal.isExactCaptureKnown, true);
  assert.strictEqual(e2eBal.isLegacyFallback, false);

  // 5. Two concurrent ₹60 refund reservations: exactly one succeeds, one rejected
  const [e2eResA, e2eResB] = await Promise.allSettled([
    createPendingRefundReservation(db14, {
      orderId: e2eOrderId,
      amount_paise: 6000,
      reason: 'E2E Concurrent A',
      initiated_by: 'adminA',
      idempotency_key: 'idem_e2e_conc_a'
    }),
    createPendingRefundReservation(db14, {
      orderId: e2eOrderId,
      amount_paise: 6000,
      reason: 'E2E Concurrent B',
      initiated_by: 'adminB',
      idempotency_key: 'idem_e2e_conc_b'
    })
  ]);
  const e2eFulfilled = [e2eResA, e2eResB].filter(r => r.status === 'fulfilled').length;
  const e2eRejected = [e2eResA, e2eResB].filter(r => r.status === 'rejected').length;
  assert.strictEqual(e2eFulfilled, 1, 'Exactly one concurrent reservation must succeed');
  assert.strictEqual(e2eRejected, 1, 'Competing reservation must be rejected for exceeding balance');

  console.log('   PASS [End-to-End Financial Flow]: Completed full order -> verify -> webhook -> refund sequence.');

  // =========================================================================
  // Scenario 19: Unknown Captured Amount Blocking (Part A Fail-Closed)
  // =========================================================================
  console.log('\nScenario 19 [Unknown Capture Guard]: Block real refunds when exact captured amount is unknown...');
  setFirestoreForTesting({ firestoreInstance: null, clearStores: true });
  const memDb19 = await createIsolatedNativeSqliteDb();
  const orderId19 = 'ORD-UNKNOWN-CAP-19';

  // Seed order in SQLite with captured_amount_paise = NULL (PAID, but webhook not yet arrived)
  await memDb19.run(
    `INSERT INTO orders (id, product_id, amount, status, machine_id, created_at, razorpay_payment_id, dispense_status, captured_amount_paise)
     VALUES (?, 1, 100, 'PAID', 'CFX-MC-01', datetime('now'), 'pay_mock_19', 'DISPENSED', NULL)`,
    [orderId19]
  );

  let sqliteBlocked19 = false;
  try {
    await createPendingRefundReservation(memDb19, {
      orderId: orderId19,
      amount_paise: 5000,
      reason: 'Unknown capture test',
      initiated_by: 'admin',
      idempotency_key: 'idem_19_sqlite'
    });
  } catch (err: any) {
    sqliteBlocked19 = true;
    assert.ok(err instanceof ConflictError);
    assert.ok(err.message.includes('exact captured payment amount is unverified'));
  }
  assert.strictEqual(sqliteBlocked19, true, 'SQLite must block refund when captured_amount_paise is NULL');

  // Firestore adapter enforcement
  const mockFs19 = new MockFirestoreForPhase27();
  await mockFs19.collection('orders').doc(orderId19).set({
    id: orderId19,
    amount: 100,
    status: 'PAID',
    machine_id: 'CFX-MC-01',
    razorpay_payment_id: 'pay_test_19',
    captured_amount_paise: null,
    pending_refund_amount_paise: 0,
    total_refunded_amount_paise: 0,
    refund_status: 'NONE'
  });
  setFirestoreForTesting({ firestoreInstance: mockFs19, clearStores: true });

  let fsBlocked19 = false;
  try {
    await createPendingRefundReservation(null, {
      orderId: orderId19,
      amount_paise: 5000,
      reason: 'Unknown capture FS test',
      initiated_by: 'admin',
      idempotency_key: 'idem_19_fs'
    });
  } catch (err: any) {
    fsBlocked19 = true;
    assert.ok(err instanceof ConflictError);
    assert.ok(err.message.includes('exact captured payment amount is unverified'));
  }
  assert.strictEqual(fsBlocked19, true, 'Firestore must block refund when captured_amount_paise is NULL');

  // Exact captured amount of 8000 paise permits refunds up to 8000
  await mockFs19.collection('orders').doc('ORD-EXACT-8000').set({
    id: 'ORD-EXACT-8000',
    amount: 100,
    status: 'PAID',
    machine_id: 'CFX-MC-01',
    razorpay_payment_id: 'pay_test_exact',
    captured_amount_paise: 8000,
    pending_refund_amount_paise: 0,
    total_refunded_amount_paise: 0,
    refund_status: 'NONE'
  });
  const okRes19 = await createPendingRefundReservation(null, {
    orderId: 'ORD-EXACT-8000',
    amount_paise: 5000,
    reason: 'Exact capture test',
    initiated_by: 'admin',
    idempotency_key: 'idem_19_exact_ok'
  });
  assert.strictEqual(okRes19.refund.amount_paise, 5000);

  // Attempting to exceed 8000 capacity (5000 + 4000 = 9000 > 8000) is rejected
  let overBlocked19 = false;
  try {
    await createPendingRefundReservation(null, {
      orderId: 'ORD-EXACT-8000',
      amount_paise: 4000,
      reason: 'Exceed exact capacity',
      initiated_by: 'admin',
      idempotency_key: 'idem_19_exact_over'
    });
  } catch (err: any) {
    overBlocked19 = true;
    assert.ok(err instanceof BadRequestError);
  }
  assert.strictEqual(overBlocked19, true, 'Refund exceeding exact captured amount must be rejected');
  console.log('   PASS [Unknown Capture Guard]: Both adapters block unverified captured amounts fail-closed.');

  // =========================================================================
  // Scenario 20: Failed Refund Reconciliation (Scenario B in Parts C & E)
  // =========================================================================
  console.log('\nScenario 20 [Failed Refund Reconciliation]: Remote FAILED refund clears local pending balance...');
  const memDb20 = await createIsolatedNativeSqliteDb();
  const orderId20 = 'ORD-FAILED-RECON-20';
  const refundId20 = 'RFND-FAILED-R1';

  // Local SQLite has order with pending_refund_amount_paise = 5000 and PENDING refund record
  await memDb20.run(
    `INSERT INTO orders (
      id, product_id, amount, status, machine_id, created_at, razorpay_payment_id,
      dispense_status, captured_amount_paise, pending_refund_amount_paise, total_refunded_amount_paise,
      refund_status, updated_at
    ) VALUES (?, 1, 100, 'COMPLETED', 'CFX-MC-01', datetime('now'), 'pay_failed_20', 'DISPENSED', 10000, 5000, 0, 'PENDING', '2026-11-13T10:00:00.000Z')`,
    [orderId20]
  );
  await memDb20.run(
    `INSERT INTO refunds (
      id, order_id, machine_id, razorpay_payment_id, amount_paise, status, reason, initiated_by, source, idempotency_key, created_at, updated_at
    ) VALUES (?, ?, 'CFX-MC-01', 'pay_failed_20', 5000, 'PENDING', 'Initial reservation', 'admin', 'SUPER_ADMIN_PORTAL', 'idem_failed_20', datetime('now'), datetime('now'))`,
    [refundId20, orderId20]
  );

  // Firestore processes refund as FAILED: document becomes FAILED, order pending drops to 0
  const mockFs20 = new MockFirestoreForPhase27();
  await mockFs20.collection('orders').doc(orderId20).set({
    id: orderId20,
    amount: 100,
    status: 'COMPLETED',
    machine_id: 'CFX-MC-01',
    razorpay_payment_id: 'pay_failed_20',
    dispense_status: 'DISPENSED',
    captured_amount_paise: 10000,
    pending_refund_amount_paise: 0,
    total_refunded_amount_paise: 0,
    refund_status: 'FAILED',
    updated_at: '2026-11-13T10:10:00.000Z'
  });
  await mockFs20.collection('orders').doc(orderId20).collection('refunds').doc(refundId20).set({
    id: refundId20,
    order_id: orderId20,
    machine_id: 'CFX-MC-01',
    razorpay_payment_id: 'pay_failed_20',
    amount_paise: 5000,
    status: 'FAILED',
    error_code: 'GATEWAY_ERROR',
    error_description: 'Issuer declined',
    created_at: '2026-11-13T10:00:00.000Z',
    updated_at: '2026-11-13T10:10:00.000Z'
  });

  setFirestoreForTesting({ firestoreInstance: mockFs20, clearStores: false });
  const hydrated20 = await getAuthoritativeOrderById(orderId20, memDb20);

  // CRITICAL: Local pending balance must be CLEARED (0 paise) and local refund record must be FAILED
  assert.strictEqual(hydrated20.pending_refund_amount_paise, 0, 'Local pending balance must be 0 after remote failure');
  assert.strictEqual(hydrated20.total_refunded_amount_paise, 0, 'Total refunded must remain 0');

  const localRefund20 = await memDb20.get('SELECT * FROM refunds WHERE id = ?', [refundId20]);
  assert.strictEqual(localRefund20.status, 'FAILED', 'Local refund record must be updated to FAILED');

  // Repeated hydration must produce zero changes (Idempotence)
  const hydrated20Repeat = await getAuthoritativeOrderById(orderId20, memDb20);
  assert.strictEqual(hydrated20Repeat.pending_refund_amount_paise, 0);
  assert.strictEqual(hydrated20Repeat.total_refunded_amount_paise, 0);
  console.log('   PASS [Failed Refund Reconciliation]: Remote FAILED refund cleanly clears local pending reservation.');

  // =========================================================================
  // Scenario 21: Recovery of Missing Local SQLite Refund Records (Part E Requirement 5)
  // =========================================================================
  console.log('\nScenario 21 [Record Recovery]: Recover missing SQLite refund records from Firestore...');
  const memDb21 = await createIsolatedNativeSqliteDb();
  const orderId21 = 'ORD-RECOVER-21';

  // Seed remote Firestore with 2 refund documents
  const mockFs21 = new MockFirestoreForPhase27();
  await mockFs21.collection('orders').doc(orderId21).set({
    id: orderId21,
    product_id: 1,
    amount: 100,
    status: 'COMPLETED',
    machine_id: 'CFX-MC-01',
    razorpay_payment_id: 'pay_rec_21',
    captured_amount_paise: 10000,
    pending_refund_amount_paise: 3000,
    total_refunded_amount_paise: 4000,
    refund_status: 'PARTIAL'
  });
  await mockFs21.collection('orders').doc(orderId21).collection('refunds').doc('RFND-21-A').set({
    id: 'RFND-21-A',
    order_id: orderId21,
    machine_id: 'CFX-MC-01',
    razorpay_payment_id: 'pay_rec_21',
    amount_paise: 4000,
    status: 'PROCESSED',
    created_at: '2026-11-13T10:00:00.000Z',
    updated_at: '2026-11-13T10:05:00.000Z',
    processed_at: '2026-11-13T10:05:00.000Z'
  });
  await mockFs21.collection('orders').doc(orderId21).collection('refunds').doc('RFND-21-B').set({
    id: 'RFND-21-B',
    order_id: orderId21,
    machine_id: 'CFX-MC-01',
    razorpay_payment_id: 'pay_rec_21',
    amount_paise: 3000,
    status: 'PENDING',
    created_at: '2026-11-13T10:10:00.000Z',
    updated_at: '2026-11-13T10:10:00.000Z'
  });

  // Local SQLite has NO refund records initially
  setFirestoreForTesting({ firestoreInstance: mockFs21, clearStores: false });
  const hydrated21 = await getAuthoritativeOrderById(orderId21, memDb21);

  assert.strictEqual(hydrated21.pending_refund_amount_paise, 3000);
  assert.strictEqual(hydrated21.total_refunded_amount_paise, 4000);

  const localRefunds21 = await memDb21.all('SELECT * FROM refunds WHERE order_id = ? ORDER BY id', [orderId21]);
  assert.strictEqual(localRefunds21.length, 2, 'Missing refund records must be recovered into local SQLite');
  assert.strictEqual(localRefunds21[0].id, 'RFND-21-A');
  assert.strictEqual(localRefunds21[0].status, 'PROCESSED');
  assert.strictEqual(localRefunds21[1].id, 'RFND-21-B');
  assert.strictEqual(localRefunds21[1].status, 'PENDING');
  console.log('   PASS [Record Recovery]: Successfully recovered missing refund documents into SQLite.');

  // =========================================================================
  // Scenario 22: Terminal State Immunity (Requirements 5 & 6)
  // =========================================================================
  console.log('\nScenario 22 [Terminal State Immunity]: Prevent FAILED <-> PROCESSED invalid transitions...');
  const memDb22 = await createIsolatedNativeSqliteDb();
  const orderId22 = 'ORD-TERMINAL-22';

  // Seed local SQLite with R1 PROCESSED and R2 FAILED
  await memDb22.run(
    `INSERT INTO orders (id, product_id, amount, status, machine_id, created_at, razorpay_payment_id, captured_amount_paise, pending_refund_amount_paise, total_refunded_amount_paise, refund_status)
     VALUES (?, 1, 100, 'COMPLETED', 'CFX-MC-01', datetime('now'), 'pay_term_22', 10000, 0, 5000, 'PARTIAL')`,
    [orderId22]
  );
  await memDb22.run(
    `INSERT INTO refunds (id, order_id, machine_id, razorpay_payment_id, amount_paise, status, reason, initiated_by, source, idempotency_key, created_at, updated_at)
     VALUES ('RFND-22-PROCESSED', ?, 'CFX-MC-01', 'pay_term_22', 5000, 'PROCESSED', 'P1', 'admin', 'SUPER_ADMIN_PORTAL', 'idem_term_p', datetime('now'), datetime('now')),
            ('RFND-22-FAILED', ?, 'CFX-MC-01', 'pay_term_22', 2000, 'FAILED', 'F1', 'admin', 'SUPER_ADMIN_PORTAL', 'idem_term_f', datetime('now'), datetime('now'))`,
    [orderId22, orderId22]
  );

  // Remote attempts invalid state transitions: sends PROCESSED as FAILED, and FAILED as PROCESSED
  const mockFs22 = new MockFirestoreForPhase27();
  await mockFs22.collection('orders').doc(orderId22).set({
    id: orderId22,
    amount: 100,
    status: 'COMPLETED',
    machine_id: 'CFX-MC-01',
    razorpay_payment_id: 'pay_term_22',
    captured_amount_paise: 10000,
    pending_refund_amount_paise: 0,
    total_refunded_amount_paise: 5000,
    refund_status: 'PARTIAL'
  });
  await mockFs22.collection('orders').doc(orderId22).collection('refunds').doc('RFND-22-PROCESSED').set({
    id: 'RFND-22-PROCESSED',
    order_id: orderId22,
    machine_id: 'CFX-MC-01',
    razorpay_payment_id: 'pay_term_22',
    amount_paise: 5000,
    status: 'FAILED', // Invalid transition! Must be rejected
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  });
  await mockFs22.collection('orders').doc(orderId22).collection('refunds').doc('RFND-22-FAILED').set({
    id: 'RFND-22-FAILED',
    order_id: orderId22,
    machine_id: 'CFX-MC-01',
    razorpay_payment_id: 'pay_term_22',
    amount_paise: 2000,
    status: 'PROCESSED', // Invalid transition! Must be rejected
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  });

  setFirestoreForTesting({ firestoreInstance: mockFs22, clearStores: false });
  await getAuthoritativeOrderById(orderId22, memDb22);

  const checkR1 = await memDb22.get("SELECT status FROM refunds WHERE id = 'RFND-22-PROCESSED'");
  assert.strictEqual(checkR1.status, 'PROCESSED', 'PROCESSED refund must never transition to FAILED');

  const checkR2 = await memDb22.get("SELECT status FROM refunds WHERE id = 'RFND-22-FAILED'");
  assert.strictEqual(checkR2.status, 'FAILED', 'FAILED refund must never transition to PROCESSED');
  console.log('   PASS [Terminal State Immunity]: Terminal states are strictly protected from invalid transitions.');

  // =========================================================================
  // Scenario 23: Multiple Refund Records Aggregate Integrity (Requirement 8)
  // =========================================================================
  console.log('\nScenario 23 [Multiple Record Aggregates]: Accurate derivation across mixed refund statuses...');
  const memDb23 = await createIsolatedNativeSqliteDb();
  const orderId23 = 'ORD-MULTI-23';

  const mockFs23 = new MockFirestoreForPhase27();
  await mockFs23.collection('orders').doc(orderId23).set({
    id: orderId23,
    product_id: 1,
    amount: 100,
    status: 'COMPLETED',
    machine_id: 'CFX-MC-01',
    razorpay_payment_id: 'pay_multi_23',
    captured_amount_paise: 10000,
    pending_refund_amount_paise: 2500,
    total_refunded_amount_paise: 5000,
    refund_status: 'PARTIAL'
  });
  await mockFs23.collection('orders').doc(orderId23).collection('refunds').doc('R1').set({
    id: 'R1', order_id: orderId23, machine_id: 'CFX-MC-01', razorpay_payment_id: 'pay_multi_23',
    amount_paise: 2000, status: 'PROCESSED', created_at: new Date().toISOString(), updated_at: new Date().toISOString()
  });
  await mockFs23.collection('orders').doc(orderId23).collection('refunds').doc('R2').set({
    id: 'R2', order_id: orderId23, machine_id: 'CFX-MC-01', razorpay_payment_id: 'pay_multi_23',
    amount_paise: 3000, status: 'PROCESSED', created_at: new Date().toISOString(), updated_at: new Date().toISOString()
  });
  await mockFs23.collection('orders').doc(orderId23).collection('refunds').doc('R3').set({
    id: 'R3', order_id: orderId23, machine_id: 'CFX-MC-01', razorpay_payment_id: 'pay_multi_23',
    amount_paise: 2500, status: 'PENDING', created_at: new Date().toISOString(), updated_at: new Date().toISOString()
  });
  await mockFs23.collection('orders').doc(orderId23).collection('refunds').doc('R4').set({
    id: 'R4', order_id: orderId23, machine_id: 'CFX-MC-01', razorpay_payment_id: 'pay_multi_23',
    amount_paise: 1000, status: 'FAILED', created_at: new Date().toISOString(), updated_at: new Date().toISOString()
  });

  setFirestoreForTesting({ firestoreInstance: mockFs23, clearStores: false });
  const hydrated23 = await getAuthoritativeOrderById(orderId23, memDb23);

  // Total refunded = 2000 + 3000 = 5000; Pending = 2500; FAILED contributes 0
  assert.strictEqual(hydrated23.total_refunded_amount_paise, 5000);
  assert.strictEqual(hydrated23.pending_refund_amount_paise, 2500);
  assert.strictEqual(hydrated23.refund_status, 'PARTIAL');
  console.log('   PASS [Multiple Record Aggregates]: Aggregates exactly calculated from individual refund documents.');

  // =========================================================================
  // Scenario 24: Aggregate / Document Invariant Mismatch Blocks New Reservations (Part D)
  // =========================================================================
  console.log('\nScenario 24 [Invariant Check]: Aggregate mismatch blocks new reservations with diagnostic error...');
  const orderId24 = 'ORD-INVARIANT-24';
  const mockFs24 = new MockFirestoreForPhase27();
  // Order doc claims pending = 9000, but only has 1 record of 3000
  await mockFs24.collection('orders').doc(orderId24).set({
    id: orderId24,
    product_id: 1,
    amount: 100,
    status: 'PAID',
    machine_id: 'CFX-MC-01',
    razorpay_payment_id: 'pay_inv_24',
    captured_amount_paise: 10000,
    pending_refund_amount_paise: 9000, // Mismatch: 9000 vs record of 3000
    total_refunded_amount_paise: 0,
    refund_status: 'PENDING'
  });
  await mockFs24.collection('orders').doc(orderId24).collection('refunds').doc('R24').set({
    id: 'R24',
    order_id: orderId24,
    machine_id: 'CFX-MC-01',
    razorpay_payment_id: 'pay_inv_24',
    amount_paise: 3000,
    status: 'PENDING',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  });

  setFirestoreForTesting({ firestoreInstance: mockFs24, clearStores: true });
  let invariantBlocked = false;
  try {
    await createPendingRefundReservation(null, {
      orderId: orderId24,
      amount_paise: 1000,
      reason: 'Invariant test',
      initiated_by: 'admin',
      idempotency_key: 'idem_24_inv'
    });
  } catch (err: any) {
    invariantBlocked = true;
    assert.ok(err instanceof ConflictError);
    assert.ok(err.message.includes('financial consistency check failed'));
  }
  assert.strictEqual(invariantBlocked, true, 'Mismatch between order aggregates and refund records must block new reservations');
  console.log('   PASS [Invariant Check]: Invariant violation safely suspended new refund reservations.');

  // =========================================================================
  // Scenario 25: Local SQLite Sync Failure Recovers on Next Hydration
  // =========================================================================
  console.log('\nScenario 25 [Sync Recovery]: Hydration recovers local state after SQLite write hiccup...');
  const memDb25 = await createIsolatedNativeSqliteDb();
  const orderId25 = 'ORD-RECOVERY-25';

  const mockFs25 = new MockFirestoreForPhase27();
  await mockFs25.collection('orders').doc(orderId25).set({
    id: orderId25,
    product_id: 1,
    amount: 100,
    status: 'COMPLETED',
    machine_id: 'CFX-MC-01',
    razorpay_payment_id: 'pay_sync_25',
    captured_amount_paise: 10000,
    pending_refund_amount_paise: 5000,
    total_refunded_amount_paise: 0,
    refund_status: 'PENDING'
  });
  await mockFs25.collection('orders').doc(orderId25).collection('refunds').doc('RFND-25-A').set({
    id: 'RFND-25-A',
    order_id: orderId25,
    machine_id: 'CFX-MC-01',
    razorpay_payment_id: 'pay_sync_25',
    amount_paise: 5000,
    status: 'PENDING',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  });

  setFirestoreForTesting({ firestoreInstance: mockFs25, clearStores: false });
  // Local SQLite was initially empty
  const hydrated25 = await getAuthoritativeOrderById(orderId25, memDb25);
  assert.strictEqual(hydrated25.pending_refund_amount_paise, 5000);

  const localRow25 = await memDb25.get("SELECT * FROM refunds WHERE id = 'RFND-25-A'");
  assert.ok(localRow25, 'Refund record must be restored to SQLite on hydration');
  assert.strictEqual(localRow25.amount_paise, 5000);
  assert.strictEqual(localRow25.status, 'PENDING');
  console.log('   PASS [Sync Recovery]: Local state fully repaired after missed synchronization.');

  // =========================================================================
  // Scenario 26: Local PROCESSED + Remote PENDING (Part A)
  // =========================================================================
  console.log('\nScenario 26 [Stale Remote PENDING vs Local PROCESSED]: Local terminal state protected...');
  const memDb26 = await createIsolatedNativeSqliteDb();
  const orderId26 = 'ORD-STALE-26';
  await memDb26.run(
    `INSERT INTO orders (id, product_id, amount, status, machine_id, created_at, razorpay_payment_id, captured_amount_paise, total_refunded_amount_paise, pending_refund_amount_paise, refund_status)
     VALUES (?, 1, 100, 'PAID', 'CFX-MC-01', datetime('now'), 'pay_26', 10000, 5000, 0, 'PARTIAL')`,
    [orderId26]
  );
  await memDb26.run(
    `INSERT INTO refunds (id, order_id, machine_id, razorpay_payment_id, amount_paise, status, reason, initiated_by, source, idempotency_key, created_at, updated_at, processed_at)
     VALUES ('RFND-26', ?, 'CFX-MC-01', 'pay_26', 5000, 'PROCESSED', 'test', 'admin', 'SUPER_ADMIN_PORTAL', 'idem-26', datetime('now'), datetime('now'), datetime('now'))`,
    [orderId26]
  );

  const mockFs26 = new MockFirestoreForPhase27();
  await mockFs26.collection('orders').doc(orderId26).set({
    id: orderId26,
    product_id: 1,
    amount: 100,
    status: 'PAID',
    machine_id: 'CFX-MC-01',
    razorpay_payment_id: 'pay_26',
    captured_amount_paise: 10000,
    pending_refund_amount_paise: 5000,
    total_refunded_amount_paise: 0
  });
  await mockFs26.collection('orders').doc(orderId26).collection('refunds').doc('RFND-26').set({
    id: 'RFND-26',
    order_id: orderId26,
    machine_id: 'CFX-MC-01',
    razorpay_payment_id: 'pay_26',
    amount_paise: 5000,
    status: 'PENDING', // Stale remote PENDING!
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  });

  setFirestoreForTesting({ firestoreInstance: mockFs26, clearStores: false });
  const hydrated26 = await getAuthoritativeOrderById(orderId26, memDb26);
  assert.strictEqual(hydrated26.pending_refund_amount_paise, 0, 'Pending balance must remain 0');
  assert.strictEqual(hydrated26.total_refunded_amount_paise, 5000, 'Total refunded must remain 5000');

  const checkR26 = await memDb26.get("SELECT status FROM refunds WHERE id = 'RFND-26'");
  assert.strictEqual(checkR26.status, 'PROCESSED', 'Local PROCESSED must never be downgraded to PENDING');
  console.log('   PASS [Stale Remote PENDING vs Local PROCESSED]: Local PROCESSED preserved and phantom balance prevented.');

  // =========================================================================
  // Scenario 27: Local FAILED + Remote PENDING (Part A)
  // =========================================================================
  console.log('\nScenario 27 [Stale Remote PENDING vs Local FAILED]: Local FAILED terminal state protected...');
  const memDb27 = await createIsolatedNativeSqliteDb();
  const orderId27 = 'ORD-STALE-27';
  await memDb27.run(
    `INSERT INTO orders (id, product_id, amount, status, machine_id, created_at, razorpay_payment_id, captured_amount_paise, total_refunded_amount_paise, pending_refund_amount_paise, refund_status)
     VALUES (?, 1, 100, 'PAID', 'CFX-MC-01', datetime('now'), 'pay_27', 10000, 0, 0, 'FAILED')`,
    [orderId27]
  );
  await memDb27.run(
    `INSERT INTO refunds (id, order_id, machine_id, razorpay_payment_id, amount_paise, status, reason, initiated_by, source, idempotency_key, created_at, updated_at)
     VALUES ('RFND-27', ?, 'CFX-MC-01', 'pay_27', 3000, 'FAILED', 'test', 'admin', 'SUPER_ADMIN_PORTAL', 'idem-27', datetime('now'), datetime('now'))`,
    [orderId27]
  );

  const mockFs27 = new MockFirestoreForPhase27();
  await mockFs27.collection('orders').doc(orderId27).set({
    id: orderId27,
    product_id: 1,
    amount: 100,
    status: 'PAID',
    machine_id: 'CFX-MC-01',
    razorpay_payment_id: 'pay_27',
    captured_amount_paise: 10000,
    pending_refund_amount_paise: 3000,
    total_refunded_amount_paise: 0
  });
  await mockFs27.collection('orders').doc(orderId27).collection('refunds').doc('RFND-27').set({
    id: 'RFND-27',
    order_id: orderId27,
    machine_id: 'CFX-MC-01',
    razorpay_payment_id: 'pay_27',
    amount_paise: 3000,
    status: 'PENDING', // Stale remote PENDING!
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  });

  setFirestoreForTesting({ firestoreInstance: mockFs27, clearStores: false });
  const hydrated27 = await getAuthoritativeOrderById(orderId27, memDb27);
  assert.strictEqual(hydrated27.pending_refund_amount_paise, 0);

  const checkR27 = await memDb27.get("SELECT status FROM refunds WHERE id = 'RFND-27'");
  assert.strictEqual(checkR27.status, 'FAILED', 'Local FAILED must never be downgraded to PENDING');
  console.log('   PASS [Stale Remote PENDING vs Local FAILED]: Local FAILED preserved.');

  // =========================================================================
  // Scenario 28: Malformed String Amount (Part B)
  // =========================================================================
  console.log('\nScenario 28 [Malformed String Amount]: Rejected and order marked unsafe...');
  const memDb28 = await createIsolatedNativeSqliteDb();
  const orderId28 = 'ORD-MALFORMED-STR-28';
  await memDb28.run(
    `INSERT INTO orders (id, product_id, amount, status, machine_id, created_at, razorpay_payment_id, captured_amount_paise)
     VALUES (?, 1, 100, 'PAID', 'CFX-MC-01', datetime('now'), 'pay_28', 10000)`,
    [orderId28]
  );

  const mockFs28 = new MockFirestoreForPhase27();
  await mockFs28.collection('orders').doc(orderId28).set({
    id: orderId28,
    product_id: 1,
    amount: 100,
    status: 'PAID',
    machine_id: 'CFX-MC-01',
    razorpay_payment_id: 'pay_28',
    captured_amount_paise: 10000
  });
  await mockFs28.collection('orders').doc(orderId28).collection('refunds').doc('RFND-28-MAL').set({
    id: 'RFND-28-MAL',
    order_id: orderId28,
    machine_id: 'CFX-MC-01',
    razorpay_payment_id: 'pay_28',
    amount_paise: 'invalid_string_paise',
    status: 'PENDING',
    created_at: new Date().toISOString()
  });

  setFirestoreForTesting({ firestoreInstance: mockFs28, clearStores: false });
  const hydrated28 = await getAuthoritativeOrderById(orderId28, memDb28);
  assert.strictEqual(hydrated28.pending_refund_amount_paise, 0, 'Malformed string amount must not enter aggregates');

  const unsafeStatus28 = getOrderRefundUnsafeStatus(orderId28);
  assert.strictEqual(unsafeStatus28.isUnsafe, true, 'Order with malformed record must be marked unsafe');
  console.log('   PASS [Malformed String Amount]: Malformed string rejected and order flagged unsafe.');

  // =========================================================================
  // Scenario 29: NaN and Infinity (Part B)
  // =========================================================================
  console.log('\nScenario 29 [NaN and Infinity Amounts]: Rejected before aggregate calculation...');
  const valNaN = validateAndSanitizeRemoteRefundDocument({
    id: 'R-NAN',
    order_id: 'ORD-29',
    machine_id: 'MC-1',
    amount_paise: NaN,
    status: 'PENDING'
  }, 'ORD-29', 'MC-1');
  assert.strictEqual(valNaN.valid, false, 'NaN amount must be invalid');

  const valInf = validateAndSanitizeRemoteRefundDocument({
    id: 'R-INF',
    order_id: 'ORD-29',
    machine_id: 'MC-1',
    amount_paise: Infinity,
    status: 'PENDING'
  }, 'ORD-29', 'MC-1');
  assert.strictEqual(valInf.valid, false, 'Infinity amount must be invalid');
  console.log('   PASS [NaN and Infinity Amounts]: Non-finite values safely rejected.');

  // =========================================================================
  // Scenario 30: Negative and Decimal Amounts (Part B)
  // =========================================================================
  console.log('\nScenario 30 [Negative and Decimal Amounts]: Rejected strictly...');
  const valNeg = validateAndSanitizeRemoteRefundDocument({
    id: 'R-NEG',
    order_id: 'ORD-30',
    machine_id: 'MC-1',
    amount_paise: -1000,
    status: 'PENDING'
  }, 'ORD-30', 'MC-1');
  assert.strictEqual(valNeg.valid, false, 'Negative amount must be invalid');

  const valDec = validateAndSanitizeRemoteRefundDocument({
    id: 'R-DEC',
    order_id: 'ORD-30',
    machine_id: 'MC-1',
    amount_paise: 15.5,
    status: 'PENDING'
  }, 'ORD-30', 'MC-1');
  assert.strictEqual(valDec.valid, false, 'Decimal amount must be invalid');
  console.log('   PASS [Negative and Decimal Amounts]: Negative and decimal amounts rejected.');

  // =========================================================================
  // Scenario 31: Invalid Refund Status (Part B)
  // =========================================================================
  console.log('\nScenario 31 [Invalid Refund Status]: Rejects unsupported status values...');
  const valStatus = validateAndSanitizeRemoteRefundDocument({
    id: 'R-STAT',
    order_id: 'ORD-31',
    machine_id: 'MC-1',
    amount_paise: 1000,
    status: 'CANCELLED' // Unsupported status
  }, 'ORD-31', 'MC-1');
  assert.strictEqual(valStatus.valid, false, 'Status CANCELLED must be rejected');
  console.log('   PASS [Invalid Refund Status]: Unsupported status values rejected.');

  // =========================================================================
  // Scenario 32: Wrong Order ID (Part C)
  // =========================================================================
  console.log('\nScenario 32 [Wrong Order ID Contamination]: Prevents cross-order contamination...');
  const memDb32 = await createIsolatedNativeSqliteDb();
  const orderId32 = 'ORD-CORRECT-32';
  await memDb32.run(
    `INSERT INTO orders (id, product_id, amount, status, machine_id, created_at, razorpay_payment_id, captured_amount_paise)
     VALUES (?, 1, 100, 'PAID', 'CFX-MC-01', datetime('now'), 'pay_32', 10000)`,
    [orderId32]
  );

  const mockFs32 = new MockFirestoreForPhase27();
  await mockFs32.collection('orders').doc(orderId32).set({
    id: orderId32,
    product_id: 1,
    amount: 100,
    status: 'PAID',
    machine_id: 'CFX-MC-01',
    razorpay_payment_id: 'pay_32',
    captured_amount_paise: 10000
  });
  await mockFs32.collection('orders').doc(orderId32).collection('refunds').doc('RFND-OTHER-32').set({
    id: 'RFND-OTHER-32',
    order_id: 'ORD-WRONG-OTHER',
    machine_id: 'CFX-MC-01',
    razorpay_payment_id: 'pay_32',
    amount_paise: 5000,
    status: 'PENDING',
    created_at: new Date().toISOString()
  });

  setFirestoreForTesting({ firestoreInstance: mockFs32, clearStores: false });
  const hydrated32 = await getAuthoritativeOrderById(orderId32, memDb32);
  assert.strictEqual(hydrated32.pending_refund_amount_paise, 0, 'Foreign order refund must not enter aggregates');

  const foreignInDb = await memDb32.get("SELECT * FROM refunds WHERE id = 'RFND-OTHER-32'");
  assert.strictEqual(foreignInDb, undefined, 'Foreign order refund must not be inserted into SQLite');
  console.log('   PASS [Wrong Order ID Contamination]: Cross-order contamination prevented.');

  // =========================================================================
  // Scenario 33: Wrong Machine ID (Part C)
  // =========================================================================
  console.log('\nScenario 33 [Wrong Machine ID Contamination]: Prevents cross-machine contamination...');
  const valWrongMc = validateAndSanitizeRemoteRefundDocument({
    id: 'R-MC-33',
    order_id: 'ORD-33',
    machine_id: 'CFX-MC-99',
    amount_paise: 1000,
    status: 'PENDING'
  }, 'ORD-33', 'CFX-MC-01');
  assert.strictEqual(valWrongMc.valid, false, 'Mismatched machine ID must be rejected');
  console.log('   PASS [Wrong Machine ID Contamination]: Cross-machine contamination prevented.');

  // =========================================================================
  // Scenario 34: Wrong Firestore Parent Path (Part C)
  // =========================================================================
  console.log('\nScenario 34 [Wrong Firestore Parent Path]: Verified parent path constraint...');
  const memDb34 = await createIsolatedNativeSqliteDb();
  const orderId34 = 'ORD-PATH-34';
  await memDb34.run(
    `INSERT INTO orders (id, product_id, amount, status, machine_id, created_at, razorpay_payment_id, captured_amount_paise)
     VALUES (?, 1, 100, 'PAID', 'CFX-MC-01', datetime('now'), 'pay_34', 10000)`,
    [orderId34]
  );

  const reconPathRes = await reconcileOrderRefundRecords(orderId34, {
    id: orderId34,
    machine_id: 'CFX-MC-01',
    captured_amount_paise: 10000
  }, memDb34, {
    collection: () => ({
      doc: () => ({
        collection: () => ({
          get: async () => ({
            empty: false,
            docs: [{
              id: 'R-PATH-BAD',
              ref: { path: 'orders/WRONG_ORDER/refunds/R-PATH-BAD' },
              data: () => ({
                id: 'R-PATH-BAD',
                order_id: orderId34,
                machine_id: 'CFX-MC-01',
                amount_paise: 2000,
                status: 'PENDING'
              })
            }]
          })
        })
      })
    })
  });
  assert.strictEqual(reconPathRes.resolvedPending, 0, 'Wrong parent path must be rejected');
  console.log('   PASS [Wrong Firestore Parent Path]: Path violation rejected.');

  // =========================================================================
  // Scenario 35: Deleted Refund Document Handling (Part D)
  // =========================================================================
  console.log('\nScenario 35 [Deleted Refund Document Safety]: Preserves local record without tombstone...');
  const memDb35 = await createIsolatedNativeSqliteDb();
  const orderId35 = 'ORD-DEL-35';
  await memDb35.run(
    `INSERT INTO orders (id, product_id, amount, status, machine_id, created_at, razorpay_payment_id, captured_amount_paise, total_refunded_amount_paise, pending_refund_amount_paise)
     VALUES (?, 1, 100, 'PAID', 'CFX-MC-01', datetime('now'), 'pay_35', 10000, 5000, 0)`,
    [orderId35]
  );
  await memDb35.run(
    `INSERT INTO refunds (id, order_id, machine_id, razorpay_payment_id, amount_paise, status, reason, initiated_by, source, idempotency_key, created_at, updated_at, processed_at)
     VALUES ('R35-A', ?, 'CFX-MC-01', 'pay_35', 3000, 'PROCESSED', 'test', 'admin', 'SUPER_ADMIN_PORTAL', 'idem-35-a', datetime('now'), datetime('now'), datetime('now')),
            ('R35-B', ?, 'CFX-MC-01', 'pay_35', 2000, 'PROCESSED', 'test', 'admin', 'SUPER_ADMIN_PORTAL', 'idem-35-b', datetime('now'), datetime('now'), datetime('now'))`,
    [orderId35, orderId35]
  );

  const mockFs35 = new MockFirestoreForPhase27();
  await mockFs35.collection('orders').doc(orderId35).set({
    id: orderId35,
    product_id: 1,
    amount: 100,
    status: 'PAID',
    machine_id: 'CFX-MC-01',
    razorpay_payment_id: 'pay_35',
    captured_amount_paise: 10000
  });
  // Remote Firestore only has R35-A (R35-B disappeared without tombstone)
  await mockFs35.collection('orders').doc(orderId35).collection('refunds').doc('R35-A').set({
    id: 'R35-A',
    order_id: orderId35,
    machine_id: 'CFX-MC-01',
    razorpay_payment_id: 'pay_35',
    amount_paise: 3000,
    status: 'PROCESSED',
    created_at: new Date().toISOString()
  });

  setFirestoreForTesting({ firestoreInstance: mockFs35, clearStores: false });
  const hydrated35 = await getAuthoritativeOrderById(orderId35, memDb35);

  const checkR35B = await memDb35.get("SELECT * FROM refunds WHERE id = 'R35-B'");
  assert.ok(checkR35B, 'Local PROCESSED record R35-B must not be deleted from SQLite');
  assert.strictEqual(hydrated35.total_refunded_amount_paise, 5000, 'Aggregates must include preserved local PROCESSED record');

  const unsafe35 = getOrderRefundUnsafeStatus(orderId35);
  assert.strictEqual(unsafe35.isUnsafe, true, 'Order with unconfirmed deletion must be locked fail-closed');
  console.log('   PASS [Deleted Refund Document Safety]: Local record preserved and order locked fail-closed.');

  // =========================================================================
  // Scenario 36: Incomplete Firestore Query (Part D)
  // =========================================================================
  console.log('\nScenario 36 [Incomplete Firestore Query]: Preserves state on query failure...');
  const memDb36 = await createIsolatedNativeSqliteDb();
  const orderId36 = 'ORD-INCOMPLETE-36';
  await memDb36.run(
    `INSERT INTO orders (id, product_id, amount, status, machine_id, created_at, razorpay_payment_id, captured_amount_paise, pending_refund_amount_paise)
     VALUES (?, 1, 100, 'PAID', 'CFX-MC-01', datetime('now'), 'pay_36', 10000, 2000)`,
    [orderId36]
  );
  await memDb36.run(
    `INSERT INTO refunds (id, order_id, machine_id, razorpay_payment_id, amount_paise, status, reason, initiated_by, source, idempotency_key, created_at, updated_at)
     VALUES ('R36', ?, 'CFX-MC-01', 'pay_36', 2000, 'PENDING', 'test', 'admin', 'SUPER_ADMIN_PORTAL', 'idem-36', datetime('now'), datetime('now'))`,
    [orderId36]
  );

  const throwingFs = {
    collection: () => ({
      doc: () => ({
        collection: () => ({
          get: async () => {
            throw new Error('Firestore timeout / network interruption');
          }
        })
      })
    })
  };

  const reconFailRes = await reconcileOrderRefundRecords(orderId36, { id: orderId36, captured_amount_paise: 10000 }, memDb36, throwingFs);
  assert.strictEqual(reconFailRes.resolvedPending, 2000, 'Query failure must preserve local SQLite pending balance');
  console.log('   PASS [Incomplete Firestore Query]: Preserved state on network query failure.');

  // =========================================================================
  // Scenario 37: Concurrent Hydration (Part E & F)
  // =========================================================================
  console.log('\nScenario 37 [Concurrent Hydration Concurrency]: Multiple simultaneous hydrations...');
  const memDb37 = await createIsolatedNativeSqliteDb();
  const orderId37 = 'ORD-CONC-HYD-37';
  await memDb37.run(
    `INSERT INTO orders (id, product_id, amount, status, machine_id, created_at, razorpay_payment_id, captured_amount_paise)
     VALUES (?, 1, 100, 'PAID', 'CFX-MC-01', datetime('now'), 'pay_37', 10000)`,
    [orderId37]
  );

  const mockFs37 = new MockFirestoreForPhase27();
  await mockFs37.collection('orders').doc(orderId37).collection('refunds').doc('R37-PAR').set({
    id: 'R37-PAR',
    order_id: orderId37,
    machine_id: 'CFX-MC-01',
    razorpay_payment_id: 'pay_37',
    amount_paise: 4000,
    status: 'PROCESSED',
    created_at: new Date().toISOString()
  });

  await Promise.all([
    reconcileOrderRefundRecords(orderId37, { id: orderId37, captured_amount_paise: 10000 }, memDb37, mockFs37),
    reconcileOrderRefundRecords(orderId37, { id: orderId37, captured_amount_paise: 10000 }, memDb37, mockFs37)
  ]);

  const orderAfterHyd37 = await memDb37.get('SELECT * FROM orders WHERE id = ?', [orderId37]);
  assert.strictEqual(orderAfterHyd37.total_refunded_amount_paise, 4000);
  console.log('   PASS [Concurrent Hydration Concurrency]: Concurrent hydrations resolved accurately.');

  // =========================================================================
  // Scenario 38: Concurrent Firestore Reservation & Refund Status Transition (Part E)
  // =========================================================================
  console.log('\nScenario 38 [Concurrent Firestore Reservation & Status Transition]: Atomic versioned updates...');
  const orderId38 = 'ORD-CONC-TX-38';
  const mockFs38 = new MockFirestoreForPhase27();
  await mockFs38.collection('orders').doc(orderId38).set({
    id: orderId38,
    amount: 100,
    status: 'PAID',
    machine_id: 'CFX-MC-01',
    razorpay_payment_id: 'pay_38',
    captured_amount_paise: 10000,
    pending_refund_amount_paise: 2000,
    total_refunded_amount_paise: 0,
    refund_status: 'PENDING',
    refund_version: 1
  });
  await mockFs38.collection('refunds').doc('R38-EXISTING').set({
    id: 'R38-EXISTING',
    order_id: orderId38,
    machine_id: 'CFX-MC-01',
    razorpay_payment_id: 'pay_38',
    amount_paise: 2000,
    status: 'PENDING',
    created_at: new Date().toISOString()
  });
  await mockFs38.collection('orders').doc(orderId38).collection('refunds').doc('R38-EXISTING').set({
    id: 'R38-EXISTING',
    order_id: orderId38,
    machine_id: 'CFX-MC-01',
    razorpay_payment_id: 'pay_38',
    amount_paise: 2000,
    status: 'PENDING',
    created_at: new Date().toISOString()
  });

  setFirestoreForTesting({ firestoreInstance: mockFs38, clearStores: false });

  // Worker 1 marks R38-EXISTING as PROCESSED, while Worker 2 reserves 3000 paise
  const [t1, t2] = await Promise.all([
    markRefundProcessed(null, { refundId: 'R38-EXISTING' }),
    createPendingRefundReservation(null, {
      orderId: orderId38,
      amount_paise: 3000,
      reason: 'Conc test',
      initiated_by: 'admin',
      idempotency_key: 'idem_38_tx'
    })
  ]);

  const finalOrder38 = (await mockFs38.collection('orders').doc(orderId38).get()).data();
  assert.strictEqual(finalOrder38.total_refunded_amount_paise, 2000, 'Processed refund must be recorded');
  assert.strictEqual(finalOrder38.pending_refund_amount_paise, 3000, 'New pending reservation must be recorded');
  assert.ok(finalOrder38.refund_version >= 2, 'Monotonic refund_version must be incremented');
  console.log('   PASS [Concurrent Firestore Reservation & Status Transition]: Atomically serialized via versioning.');

  // =========================================================================
  // Scenario 39: Existing Terminal-State Idempotency (Part A & F)
  // =========================================================================
  console.log('\nScenario 39 [Terminal-State Idempotency]: Duplicate terminal calls return replay...');
  const memDb39 = await createIsolatedNativeSqliteDb();
  const orderId39 = 'ORD-TERM-IDEM-39';
  await memDb39.run(
    `INSERT INTO orders (id, product_id, amount, status, machine_id, created_at, razorpay_payment_id, captured_amount_paise, total_refunded_amount_paise, pending_refund_amount_paise)
     VALUES (?, 1, 100, 'PAID', 'CFX-MC-01', datetime('now'), 'pay_mock_39', 10000, 5000, 0)`,
    [orderId39]
  );
  await memDb39.run(
    `INSERT INTO refunds (id, order_id, machine_id, razorpay_payment_id, amount_paise, status, reason, initiated_by, source, idempotency_key, created_at, updated_at)
     VALUES ('RFND-39', ?, 'CFX-MC-01', 'pay_mock_39', 5000, 'PROCESSED', 'test', 'admin', 'SUPER_ADMIN_PORTAL', 'idem-39', datetime('now'), datetime('now'))`,
    [orderId39]
  );

  setFirestoreForTesting({ firestoreInstance: null, clearStores: true });
  const replayProc = await markRefundProcessed(memDb39, { refundId: 'RFND-39' });
  assert.strictEqual(replayProc.isReplay, true, 'Repeat markRefundProcessed must return isReplay: true');
  const orderAfter39 = await memDb39.get('SELECT * FROM orders WHERE id = ?', [orderId39]);
  assert.strictEqual(orderAfter39.total_refunded_amount_paise, 5000, 'Balance must not change on duplicate');
  console.log('   PASS [Terminal-State Idempotency]: Duplicate terminal processing idempotent.');

  // =========================================================================
  // Scenario 40: Aggregate Mismatch Blocks New Reservation (Part B & F)
  // =========================================================================
  console.log('\nScenario 40 [Aggregate Mismatch Blocks Reservation]: Fail-closed check...');
  const memDb40 = await createIsolatedNativeSqliteDb();
  const orderId40 = 'ORD-AGG-MISMATCH-40';
  await memDb40.run(
    `INSERT INTO orders (id, product_id, amount, status, machine_id, created_at, razorpay_payment_id, captured_amount_paise, total_refunded_amount_paise, pending_refund_amount_paise)
     VALUES (?, 1, 100, 'PAID', 'CFX-MC-01', datetime('now'), 'pay_mock_40', 10000, 8000, 0)`,
    [orderId40]
  );
  // Zero refund rows in DB, but order claims total = 8000
  let caughtMismatch40 = false;
  try {
    await createPendingRefundReservation(memDb40, {
      orderId: orderId40,
      amount_paise: 1000,
      reason: 'Mismatch test',
      initiated_by: 'admin',
      idempotency_key: 'idem-40'
    });
  } catch (e: any) {
    if (e instanceof ConflictError && e.message.includes('financial consistency check failed')) {
      caughtMismatch40 = true;
    }
  }
  assert.strictEqual(caughtMismatch40, true, 'Aggregate mismatch must throw ConflictError');
  console.log('   PASS [Aggregate Mismatch Blocks Reservation]: Invariant violation blocked.');

  // =========================================================================
  // Scenario 41: Historical Captured Amount Remains Fail-Closed (Part F)
  // =========================================================================
  console.log('\nScenario 41 [Historical Captured Amount Fail-Closed]: Blocks refund when capture unknown...');
  const memDb41 = await createIsolatedNativeSqliteDb();
  const orderId41 = 'ORD-HIST-NULL-41';
  await memDb41.run(
    `INSERT INTO orders (id, product_id, amount, status, machine_id, created_at, razorpay_payment_id, captured_amount_paise)
     VALUES (?, 1, 100, 'PAID', 'CFX-MC-01', datetime('now'), 'pay_mock_41', NULL)`,
    [orderId41]
  );

  let caughtHist41 = false;
  try {
    await createPendingRefundReservation(memDb41, {
      orderId: orderId41,
      amount_paise: 2000,
      reason: 'Hist test',
      initiated_by: 'admin',
      idempotency_key: 'idem-41'
    });
  } catch (e: any) {
    if (e instanceof ConflictError && e.message.includes('exact captured payment amount is unverified')) {
      caughtHist41 = true;
    }
  }
  assert.strictEqual(caughtHist41, true, 'Historical order without capture must throw ConflictError');
  console.log('   PASS [Historical Captured Amount Fail-Closed]: Historical order strictly fails closed.');

  setFirestoreForTesting({ firestoreInstance: null, clearStores: true });

  console.log('\n========================================================================');
  console.log('ALL Phase 2.7.1 Shared Persistence & Financial Invariant Tests PASSED!');
  console.log('========================================================================\n');
}

runPhase2714Tests().catch((err) => {
  console.error('\n Phase 2.7.1 Test FAILED:\n', err);
  process.exit(1);
});
