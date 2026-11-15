import assert from 'assert';
import http from 'http';
import jwt from 'jsonwebtoken';

process.env.VERCEL = '1';
process.env.VERCEL_ENV = 'production';
process.env.FIREBASE_PROJECT_ID = 'caffix-vending';
process.env.FIREBASE_CLIENT_EMAIL = 'firebase-adminsdk@caffix-vending.iam.gserviceaccount.com';
process.env.FIREBASE_PRIVATE_KEY = '-----BEGIN PRIVATE KEY-----\nPHASE_G1_1_TEST_KEY\n-----END PRIVATE KEY-----';
process.env.JWT_SECRET = 'caffix-test-phase-g1-1-jwt-secret-key-2026';
process.env.KIOSK_SECRET = 'kiosk_prod_secret_live_phase_g1_1';
process.env.KIOSK_ADMIN_ENABLED = 'false';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const app = require('../index').default;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { initDB, getDB, resetMockDatabaseForColdStartSimulation } = require('../config/db');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const {
  setFirestoreForTesting,
  resetFirestoreSeedStateForTesting,
  ensureFirestoreSeeded,
  syncMachineToFirebase,
  updateMachineDesiredModeInFirebase,
  getMachineFromFirebase,
  getAllMachinesFromFirebase,
  getAuthoritativeMachineState,
  getSyncedFirebaseMachine,
  checkOrderExistsInFirebase,
  syncOrderToFirebase,
  getAuthoritativeOrderById,
  getAuthoritativeOrders,
  getSyncedFirebaseOrder,
  getAllSyncedFirebaseOrders
} = require('../utils/firebase');

const PORT = 5097;
const BASE_URL = `http://127.0.0.1:${PORT}/api`;

type GetHook = ((colName: string) => Promise<void>) | null;

class ConcurrencyMockFirestore {
  public collections = new Map<string, Map<string, any>>();
  public writeCount = 0;
  public onCollectionGet: GetHook = null;
  private txChain: Promise<any> = Promise.resolve();

  private getCol(name: string): Map<string, any> {
    let col = this.collections.get(name);
    if (!col) {
      col = new Map<string, any>();
      this.collections.set(name, col);
    }
    return col;
  }

  public rawDelete(colName: string, docId: string): boolean {
    return this.getCol(colName).delete(String(docId));
  }

  public rawGet(colName: string, docId: string): any | undefined {
    const val = this.getCol(colName).get(String(docId));
    return val ? JSON.parse(JSON.stringify(val)) : undefined;
  }

  collection(colName: string) {
    const self = this;
    const colMap = this.getCol(colName);

    const buildQuery = (filters: Array<{ field: string; op: string; value: any }>, maxLimit?: number) => {
      const execute = () => {
        let list: Array<{ id: string; data: () => any }> = [];
        for (const [id, data] of colMap.entries()) {
          const matches = filters.every((f) => {
            if (!data) return false;
            if (f.op === '==') return data[f.field] === f.value;
            return true;
          });
          if (matches) {
            list.push({ id, data: () => JSON.parse(JSON.stringify(data)) });
          }
        }
        if (typeof maxLimit === 'number') {
          list = list.slice(0, maxLimit);
        }
        return {
          empty: list.length === 0,
          docs: list,
          forEach: (cb: (d: any) => void) => list.forEach(cb)
        };
      };

      const queryObj: any = {
        where(field: string, op: string, value: any) {
          return buildQuery([...filters, { field, op, value }], maxLimit);
        },
        orderBy() {
          return queryObj;
        },
        limit(max: number) {
          return buildQuery(filters, max);
        },
        async get() {
          const snapshot = execute();
          if (self.onCollectionGet) {
            await self.onCollectionGet(colName);
          }
          return snapshot;
        }
      };
      return queryObj;
    };

    return {
      doc(docId: string) {
        const id = String(docId);
        return {
          id,
          async get() {
            const has = colMap.has(id);
            const raw = colMap.get(id);
            return {
              id,
              exists: has,
              data: () => (raw ? JSON.parse(JSON.stringify(raw)) : undefined)
            };
          },
          async set(payload: any, opts?: { merge?: boolean }) {
            self.writeCount++;
            const existing = colMap.get(id);
            if (opts?.merge && existing && typeof existing === 'object') {
              colMap.set(id, {
                ...JSON.parse(JSON.stringify(existing)),
                ...JSON.parse(JSON.stringify(payload))
              });
            } else {
              colMap.set(id, JSON.parse(JSON.stringify(payload)));
            }
          },
          async delete() {
            colMap.delete(id);
          }
        };
      },
      where(field: string, op: string, value: any) {
        return buildQuery([{ field, op, value }]);
      },
      orderBy() {
        return buildQuery([]);
      },
      limit(max: number) {
        return buildQuery([], max);
      },
      async get() {
        return buildQuery([]).get();
      }
    };
  }

  // Serialize transactions to mirror real Firestore optimistic/pessimistic isolation
  runTransaction<T>(fn: (tx: any) => Promise<T>): Promise<T> {
    const run = async (): Promise<T> => {
      const tx = {
        get: async (refOrQuery: any) => await refOrQuery.get(),
        set: async (ref: any, payload: any, opts?: { merge?: boolean }) => {
          await ref.set(payload, opts);
        },
        delete: async (ref: any) => {
          await ref.delete();
        }
      };
      return await fn(tx);
    };

    const next = this.txChain.then(run, run);
    this.txChain = next.catch(() => undefined);
    return next;
  }
}

function api(
  method: string,
  path: string,
  body?: any,
  token?: string
): Promise<{ status: number; data: any; headers: any }> {
  return new Promise((resolve, reject) => {
    const url = new URL(`${BASE_URL}${path}`);
    const payload = body ? JSON.stringify(body) : undefined;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json'
    };
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }
    if (payload) {
      headers['Content-Length'] = Buffer.byteLength(payload).toString();
    }
    const req = http.request(url, { method, headers }, (res) => {
      let raw = '';
      res.on('data', (chunk) => {
        raw += chunk;
      });
      res.on('end', () => {
        let parsed: any = null;
        try {
          parsed = JSON.parse(raw);
        } catch {
          parsed = raw;
        }
        resolve({ status: res.statusCode || 0, data: parsed, headers: res.headers });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function generateAdminToken(): string {
  return jwt.sign(
    {
      id: 'prod_admin_1',
      email: 'admin@caffix.com',
      role: 'admin',
      name: 'Production Super Admin'
    },
    process.env.JWT_SECRET as string,
    { expiresIn: '2h' }
  );
}

async function runTests() {
  console.log('================================================================');
  console.log('Running Phase G.1.1 — Stale Firebase In-Memory Cache Tests');
  console.log('================================================================');

  const savedEnv = {
    VERCEL: process.env.VERCEL,
    VERCEL_ENV: process.env.VERCEL_ENV,
    FIREBASE_PROJECT_ID: process.env.FIREBASE_PROJECT_ID,
    FIREBASE_CLIENT_EMAIL: process.env.FIREBASE_CLIENT_EMAIL,
    FIREBASE_PRIVATE_KEY: process.env.FIREBASE_PRIVATE_KEY
  };

  const mockFs = new ConcurrencyMockFirestore();
  setFirestoreForTesting({ firestoreInstance: mockFs, initError: null, clearStores: true });
  resetFirestoreSeedStateForTesting();
  resetMockDatabaseForColdStartSimulation();

  await initDB();
  const db = getDB();
  await ensureFirestoreSeeded(db);

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(PORT, () => resolve()));

  const adminToken = generateAdminToken();

  try {
    // -------------------------------------------------------------------------
    // SCENARIO A: Deleted machine can be re-registered on a warm container
    // -------------------------------------------------------------------------
    console.log('\n--- Scenario A: Deleted machine re-registration after warm cache ---');
    const regA1 = await api(
      'POST',
      '/machines/register',
      { id: 'CFX-MC-01', machine_name: 'Lobby Kiosk 1', location: 'Lobby' },
      adminToken
    );
    assert.strictEqual(regA1.status, 201, `Expected 201 creating CFX-MC-01, got ${regA1.status}: ${JSON.stringify(regA1.data)}`);
    assert.ok(getSyncedFirebaseMachine('CFX-MC-01'), 'CFX-MC-01 should be in syncedMachinesStore after registration');
    assert.ok(mockFs.rawGet('machines', 'CFX-MC-01'), 'CFX-MC-01 should exist in Firestore');

    // Warm the read cache on the same serverless instance
    const cachedHit = await getMachineFromFirebase('CFX-MC-01');
    assert.ok(cachedHit && cachedHit.id === 'CFX-MC-01', 'Warm read should return CFX-MC-01');

    // Delete directly from Firestore (simulating manual deletion in Firebase Console)
    assert.strictEqual(mockFs.rawDelete('machines', 'CFX-MC-01'), true, 'Delete CFX-MC-01 from Firestore');
    assert.ok(getSyncedFirebaseMachine('CFX-MC-01'), 'Simulate stale warm container still holding cached entry before next call');

    // Re-register CFX-MC-01 on the warm container -> MUST succeed (201)
    const regA2 = await api(
      'POST',
      '/machines/register',
      { id: 'CFX-MC-01', machine_name: 'Lobby Kiosk 1 Reborn', location: 'Terminal 1' },
      adminToken
    );
    assert.strictEqual(regA2.status, 201, `Re-registration after deletion must succeed with 201, got ${regA2.status}: ${JSON.stringify(regA2.data)}`);
    assert.strictEqual(mockFs.rawGet('machines', 'CFX-MC-01')?.machine_name, 'Lobby Kiosk 1 Reborn');
    console.log('   PASS: Scenario A succeeded.');

    // -------------------------------------------------------------------------
    // SCENARIO B: Existing machine duplicate registration returns 409 Conflict
    // -------------------------------------------------------------------------
    console.log('\n--- Scenario B: Existing machine duplicate registration returns 409 ---');
    const dupRes = await api(
      'POST',
      '/machines/register',
      { id: 'CFX-MC-01', machine_name: 'Duplicate Attempt', location: 'Nowhere' },
      adminToken
    );
    assert.strictEqual(dupRes.status, 409, `Duplicate registration must return 409, got ${dupRes.status}`);
    assert.ok(
      String(dupRes.data?.message || '').includes('Machine with ID CFX-MC-01 already registered'),
      `Expected duplicate conflict message, got ${JSON.stringify(dupRes.data)}`
    );
    console.log('   PASS: Scenario B succeeded.');

    // -------------------------------------------------------------------------
    // SCENARIO C: getMachineFromFirebase & direct createOnly stale-cache eviction
    // -------------------------------------------------------------------------
    console.log('\n--- Scenario C: getMachineFromFirebase stale cache eviction & direct createOnly ---');
    assert.strictEqual(mockFs.rawDelete('machines', 'CFX-MC-01'), true);
    assert.ok(getSyncedFirebaseMachine('CFX-MC-01'), 'Cache still holds stale CFX-MC-01 immediately after out-of-band Firestore delete');

    // Without calling getMachineFromFirebase first, direct createOnly must still succeed via Firestore tx!
    await syncMachineToFirebase(
      { id: 'CFX-MC-01', machine_name: 'Direct Recreated', location: 'Gate B' },
      { createOnly: true }
    );
    assert.strictEqual(mockFs.rawGet('machines', 'CFX-MC-01')?.machine_name, 'Direct Recreated');

    // Now delete again and verify getMachineFromFirebase + getAuthoritativeMachineState evict stale cache
    assert.strictEqual(mockFs.rawDelete('machines', 'CFX-MC-01'), true);
    const fetchedMissing = await getMachineFromFirebase('CFX-MC-01');
    assert.strictEqual(fetchedMissing, null, 'getMachineFromFirebase must return null when doc deleted');
    assert.strictEqual(
      getSyncedFirebaseMachine('CFX-MC-01'),
      undefined,
      'getMachineFromFirebase must remove stale cache entry when doc does not exist'
    );

    // Re-seed cache via non-createOnly sync? Put entry in cache cleanly by recreating + deleting, then verify getAuthoritativeMachineState also evicts
    await syncMachineToFirebase({ id: 'CFX-MC-01', machine_name: 'Temp Machine', location: 'Temp' }, { createOnly: true });
    assert.strictEqual(mockFs.rawDelete('machines', 'CFX-MC-01'), true);
    const authMissing = await getAuthoritativeMachineState('CFX-MC-01', db);
    assert.strictEqual(authMissing, null, 'getAuthoritativeMachineState must return null when deleted in Firestore');
    assert.strictEqual(getSyncedFirebaseMachine('CFX-MC-01'), undefined, 'getAuthoritativeMachineState must evict stale cache');
    console.log('   PASS: Scenario C succeeded.');

    // -------------------------------------------------------------------------
    // SCENARIO D: getAllMachinesFromFirebase evicts deleted entries without losing concurrent updates
    // -------------------------------------------------------------------------
    console.log('\n--- Scenario D: getAllMachinesFromFirebase reconciliation & concurrency safety ---');
    await syncMachineToFirebase({ id: 'CFX-MC-KEEP', machine_name: 'Keep V1', location: 'Bay 1' }, { createOnly: true });
    await syncMachineToFirebase({ id: 'CFX-MC-GONE', machine_name: 'Will Be Deleted', location: 'Bay 2' }, { createOnly: true });
    assert.ok(getSyncedFirebaseMachine('CFX-MC-KEEP'));
    assert.ok(getSyncedFirebaseMachine('CFX-MC-GONE'));

    // Delete CFX-MC-GONE out-of-band before snapshot runs, AND during .get() perform concurrent update + addition!
    assert.strictEqual(mockFs.rawDelete('machines', 'CFX-MC-GONE'), true);

    let hookRan = false;
    mockFs.onCollectionGet = async (colName: string) => {
      if (colName !== 'machines' || hookRan) return;
      hookRan = true;
      // Clear hook before recursive calls inside syncMachineToFirebase (not needed since tx uses doc.get, but safe)
      mockFs.onCollectionGet = null;
      // Concurrent addition while getAllMachinesFromFirebase is awaiting snapshot
      await syncMachineToFirebase(
        { id: 'CFX-MC-CONC-NEW', machine_name: 'Concurrent New', location: 'Bay 3' },
        { createOnly: true }
      );
      // Concurrent update of existing machine while getAllMachinesFromFirebase snapshot response is in flight
      await updateMachineDesiredModeInFirebase('CFX-MC-KEEP', 'MAINTENANCE');
    };

    const allMachinesMap = await getAllMachinesFromFirebase();
    assert.strictEqual(allMachinesMap.has('CFX-MC-GONE'), false, 'Deleted machine must not be returned');
    assert.strictEqual(
      getSyncedFirebaseMachine('CFX-MC-GONE'),
      undefined,
      'getAllMachinesFromFirebase must evict deleted CFX-MC-GONE from cache'
    );
    assert.strictEqual(
      getSyncedFirebaseMachine('CFX-MC-CONC-NEW')?.machine_name,
      'Concurrent New',
      'Concurrently created machine must NOT be deleted by snapshot reconciliation'
    );
    assert.strictEqual(
      getSyncedFirebaseMachine('CFX-MC-KEEP')?.desired_mode,
      'MAINTENANCE',
      'Concurrent update to existing machine must NOT be overwritten by older snapshot'
    );
    console.log('   PASS: Scenario D succeeded.');

    // -------------------------------------------------------------------------
    // SCENARIO E: Order cache check, collision, and snapshot reconciliation
    // -------------------------------------------------------------------------
    console.log('\n--- Scenario E: Order stale cache eviction & reconciliation ---');
    const order1 = {
      id: 'ord_g1_1_one',
      machine_id: 'CFX-MC-KEEP',
      amount_paise: 15000,
      status: 'PENDING',
      created_at: new Date().toISOString()
    };
    const order2 = {
      id: 'ord_g1_1_gone',
      machine_id: 'CFX-MC-KEEP',
      amount_paise: 20000,
      status: 'PENDING',
      created_at: new Date().toISOString()
    };
    await syncOrderToFirebase(order1, { createOnly: true });
    await syncOrderToFirebase(order2, { createOnly: true });
    assert.strictEqual(await checkOrderExistsInFirebase('ord_g1_1_one'), true);

    // Duplicate createOnly while order exists in Firestore MUST throw ORDER_ID_COLLISION
    await assert.rejects(
      () => syncOrderToFirebase(order1, { createOnly: true }),
      (err: any) => String(err?.message || '').includes('ORDER_ID_COLLISION'),
      'createOnly syncOrderToFirebase must reject existing Firestore order with ORDER_ID_COLLISION'
    );

    // Delete order2 from Firestore -> checkOrderExistsInFirebase must return false & evict cache
    assert.strictEqual(mockFs.rawDelete('orders', 'ord_g1_1_gone'), true);
    assert.ok(getSyncedFirebaseOrder('ord_g1_1_gone'), 'Stale order2 should still be cached until checked');
    assert.strictEqual(await checkOrderExistsInFirebase('ord_g1_1_gone'), false, 'checkOrderExistsInFirebase must return false after delete');
    assert.strictEqual(getSyncedFirebaseOrder('ord_g1_1_gone'), undefined, 'checkOrderExistsInFirebase must evict stale order cache');

    // Stale order1 in cache + deleted in Firestore -> createOnly syncOrderToFirebase must succeed
    assert.strictEqual(mockFs.rawDelete('orders', 'ord_g1_1_one'), true);
    assert.ok(getSyncedFirebaseOrder('ord_g1_1_one'), 'Simulate stale order1 in cache before createOnly');
    await syncOrderToFirebase({ ...order1, amount_paise: 17500 }, { createOnly: true });
    assert.strictEqual(mockFs.rawGet('orders', 'ord_g1_1_one')?.amount_paise, 17500);

    // Test getAuthoritativeOrderById eviction
    assert.strictEqual(mockFs.rawDelete('orders', 'ord_g1_1_one'), true);
    const missingOrder = await getAuthoritativeOrderById('ord_g1_1_one', db);
    assert.strictEqual(missingOrder, null);
    assert.strictEqual(getSyncedFirebaseOrder('ord_g1_1_one'), undefined, 'getAuthoritativeOrderById must evict deleted order');

    // Test getAuthoritativeOrders reconciliation + concurrent update preservation
    await syncOrderToFirebase(order1, { createOnly: true });
    await syncOrderToFirebase(order2, { createOnly: true });
    assert.strictEqual(mockFs.rawDelete('orders', 'ord_g1_1_gone'), true);

    let orderHookRan = false;
    mockFs.onCollectionGet = async (colName: string) => {
      if (colName !== 'orders' || orderHookRan) return;
      orderHookRan = true;
      mockFs.onCollectionGet = null;
      await syncOrderToFirebase({
        id: 'ord_g1_1_conc',
        machine_id: 'CFX-MC-KEEP',
        amount_paise: 25000,
        status: 'PENDING',
        created_at: new Date().toISOString()
      }, { createOnly: true });
      await syncOrderToFirebase({
        ...order1,
        status: 'PAID'
      });
    };

    const ordersList = await getAuthoritativeOrders(db);
    assert.strictEqual(
      ordersList.some((o: any) => o.id === 'ord_g1_1_gone'),
      false,
      'Deleted order must not appear in getAuthoritativeOrders'
    );
    assert.strictEqual(getSyncedFirebaseOrder('ord_g1_1_gone'), undefined, 'Deleted order must be evicted from syncedOrdersStore');
    assert.strictEqual(
      getSyncedFirebaseOrder('ord_g1_1_conc')?.id,
      'ord_g1_1_conc',
      'Concurrently created order must remain in syncedOrdersStore'
    );
    assert.strictEqual(
      getSyncedFirebaseOrder('ord_g1_1_one')?.status,
      'PAID',
      'Concurrent order update must not be clobbered by older snapshot'
    );
    assert.ok(getAllSyncedFirebaseOrders().length >= 2);
    console.log('   PASS: Scenario E succeeded.');

    // -------------------------------------------------------------------------
    // SCENARIO F: Concurrent duplicate createOnly registrations create only 1 doc
    // -------------------------------------------------------------------------
    console.log('\n--- Scenario F: Concurrent duplicate createOnly registration protection ---');
    const raceDirect = await Promise.allSettled([
      syncMachineToFirebase({ id: 'CFX-MC-RACE-1', machine_name: 'Race A', location: 'L1' }, { createOnly: true }),
      syncMachineToFirebase({ id: 'CFX-MC-RACE-1', machine_name: 'Race B', location: 'L2' }, { createOnly: true })
    ]);
    const directFulfilled = raceDirect.filter((r) => r.status === 'fulfilled');
    const directRejected = raceDirect.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
    assert.strictEqual(directFulfilled.length, 1, 'Exactly 1 concurrent syncMachineToFirebase must succeed');
    assert.strictEqual(directRejected.length, 1, 'Exactly 1 concurrent syncMachineToFirebase must fail');
    assert.ok(String(directRejected[0].reason?.message || '').includes('MACHINE_ID_CONFLICT'));

    const [httpRace1, httpRace2] = await Promise.all([
      api('POST', '/machines/register', { id: 'CFX-MC-RACE-HTTP', machine_name: 'HTTP Race 1', location: 'H1' }, adminToken),
      api('POST', '/machines/register', { id: 'CFX-MC-RACE-HTTP', machine_name: 'HTTP Race 2', location: 'H2' }, adminToken)
    ]);
    const statuses = [httpRace1.status, httpRace2.status].sort((a, b) => a - b);
    assert.deepStrictEqual(statuses, [201, 409], `Concurrent HTTP registrations must yield [201, 409], got ${JSON.stringify(statuses)}`);
    assert.ok(mockFs.rawGet('machines', 'CFX-MC-RACE-HTTP'), 'CFX-MC-RACE-HTTP must exist once in Firestore');
    console.log('   PASS: Scenario F succeeded.');

    // -------------------------------------------------------------------------
    // SCENARIO G: No-Firestore fallback mode preserves mirror-store uniqueness
    // -------------------------------------------------------------------------
    console.log('\n--- Scenario G: No-Firestore fallback mode uniqueness checks ---');
    delete process.env.VERCEL;
    delete process.env.VERCEL_ENV;
    delete process.env.FIREBASE_PROJECT_ID;
    delete process.env.FIREBASE_CLIENT_EMAIL;
    delete process.env.FIREBASE_PRIVATE_KEY;

    setFirestoreForTesting({ firestoreInstance: null, initError: null, clearStores: true });

    await syncMachineToFirebase(
      { id: 'CFX-MC-FALLBACK', machine_name: 'Local Fallback Machine', location: 'Lab' },
      { createOnly: true }
    );
    assert.ok(getSyncedFirebaseMachine('CFX-MC-FALLBACK'));
    await assert.rejects(
      () =>
        syncMachineToFirebase(
          { id: 'CFX-MC-FALLBACK', machine_name: 'Dup Fallback Machine', location: 'Lab' },
          { createOnly: true }
        ),
      (err: any) => String(err?.message || '').includes('MACHINE_ID_CONFLICT'),
      'Fallback mode createOnly machine must still reject duplicate via syncedMachinesStore'
    );

    const fallbackHttpDup = await api(
      'POST',
      '/machines/register',
      { id: 'CFX-MC-FALLBACK', machine_name: 'Dup HTTP Fallback', location: 'Lab' },
      adminToken
    );
    assert.strictEqual(fallbackHttpDup.status, 409, `Fallback HTTP duplicate must return 409, got ${fallbackHttpDup.status}`);

    const fallbackOrder = {
      id: 'ord_fallback_1',
      machine_id: 'CFX-MC-FALLBACK',
      amount_paise: 10000,
      status: 'PENDING',
      created_at: new Date().toISOString()
    };
    await syncOrderToFirebase(fallbackOrder, { createOnly: true });
    assert.strictEqual(await checkOrderExistsInFirebase('ord_fallback_1'), true);
    await assert.rejects(
      () => syncOrderToFirebase(fallbackOrder, { createOnly: true }),
      (err: any) => String(err?.message || '').includes('ORDER_ID_COLLISION'),
      'Fallback mode createOnly order must still reject duplicate via syncedOrdersStore'
    );
    console.log('   PASS: Scenario G succeeded.');

    console.log('\nALL PHASE G.1.1 REGRESSION TESTS PASSED!');
  } finally {
    process.env.VERCEL = savedEnv.VERCEL;
    process.env.VERCEL_ENV = savedEnv.VERCEL_ENV;
    process.env.FIREBASE_PROJECT_ID = savedEnv.FIREBASE_PROJECT_ID;
    process.env.FIREBASE_CLIENT_EMAIL = savedEnv.FIREBASE_CLIENT_EMAIL;
    process.env.FIREBASE_PRIVATE_KEY = savedEnv.FIREBASE_PRIVATE_KEY;
    setFirestoreForTesting({ firestoreInstance: null, initError: null, clearStores: true });
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

runTests().catch((err) => {
  console.error('TEST FAILED:', err);
  process.exit(1);
});
