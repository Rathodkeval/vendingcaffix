import assert from 'assert';
import http from 'http';

// Ensure Vercel serverless simulation mode is active before loading app/db modules
process.env.VERCEL = '1';
process.env.JWT_SECRET =
  process.env.JWT_SECRET || 'caffix-test-staging-safety-secret-2026-explicit';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const app = require('../index').default;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { getDB, initDB, resetMockDatabaseForColdStartSimulation } = require('../config/db');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const {
  setFirestoreForTesting,
  resetFirestoreSeedStateForTesting,
  ensureFirestoreSeeded
} = require('../utils/firebase');

const PORT = 5097;
const BASE_URL = `http://127.0.0.1:${PORT}`;

async function request(
  method: string,
  path: string,
  options: {
    headers?: Record<string, string>;
    body?: any;
  } = {}
): Promise<{ status: number; data: any }> {
  const headers: Record<string, string> = {
    ...(options.headers || {})
  };
  let bodyStr: string | undefined;
  if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    bodyStr = JSON.stringify(options.body);
  }

  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers,
    body: bodyStr
  });

  let data: any = null;
  const text = await res.text();
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  return { status: res.status, data };
}

/**
 * In-memory transactional FakeFirestore that emulates `collection(name).doc(id)`,
 * `.where(field, '==', val)`, and atomic `runTransaction(tx => ...)` with contention tracking.
 */
class FakeFirestore {
  public collections = new Map<string, Map<string, any>>();
  public readCount = 0;
  public writeCount = 0;
  public transactionCount = 0;
  public simulatedError: Error | null = null;

  private getColMap(name: string): Map<string, any> {
    let col = this.collections.get(name);
    if (!col) {
      col = new Map<string, any>();
      this.collections.set(name, col);
    }
    return col;
  }

  private checkError() {
    if (this.simulatedError) {
      throw this.simulatedError;
    }
  }

  collection(colName: string) {
    const self = this;
    const colMap = this.getColMap(colName);

    return {
      doc(docId: string) {
        const normalizedId = String(docId);
        return {
          id: normalizedId,
          _colName: colName,
          async get() {
            self.checkError();
            self.readCount++;
            const hasDoc = colMap.has(normalizedId);
            const raw = colMap.get(normalizedId);
            const cloned = raw ? JSON.parse(JSON.stringify(raw)) : undefined;
            return {
              id: normalizedId,
              exists: hasDoc,
              data: () => (cloned ? JSON.parse(JSON.stringify(cloned)) : undefined)
            };
          },
          async set(payload: any, opts?: { merge?: boolean }) {
            self.checkError();
            self.writeCount++;
            const existing = colMap.get(normalizedId);
            if (opts?.merge && existing && typeof existing === 'object') {
              const merged = { ...JSON.parse(JSON.stringify(existing)) };
              for (const [k, v] of Object.entries(payload)) {
                if (
                  k === 'products' &&
                  v &&
                  typeof v === 'object' &&
                  merged.products &&
                  typeof merged.products === 'object'
                ) {
                  merged.products = {
                    ...merged.products,
                    ...JSON.parse(JSON.stringify(v))
                  };
                } else {
                  merged[k] = v !== undefined ? JSON.parse(JSON.stringify(v)) : v;
                }
              }
              colMap.set(normalizedId, merged);
            } else {
              colMap.set(normalizedId, JSON.parse(JSON.stringify(payload)));
            }
          }
        };
      },
      where(field: string, op: string, value: any) {
        const filterDocs = () => {
          self.checkError();
          self.readCount++;
          const matches: Array<{ id: string; data: () => any }> = [];
          for (const [id, docData] of colMap.entries()) {
            if (op === '==' && docData && docData[field] === value) {
              const cloned = JSON.parse(JSON.stringify(docData));
              matches.push({
                id,
                data: () => JSON.parse(JSON.stringify(cloned))
              });
            }
          }
          return matches;
        };

        return {
          limit(max: number) {
            return {
              async get() {
                const docs = filterDocs().slice(0, max);
                return {
                  empty: docs.length === 0,
                  docs,
                  forEach: (cb: (d: { id: string; data: () => any }) => void) => docs.forEach(cb)
                };
              }
            };
          },
          async get() {
            const docs = filterDocs();
            return {
              empty: docs.length === 0,
              docs,
              forEach: (cb: (d: { id: string; data: () => any }) => void) => docs.forEach(cb)
            };
          }
        };
      },
      async get() {
        self.checkError();
        self.readCount++;
        const docs: Array<{ id: string; data: () => any }> = [];
        for (const [id, docData] of colMap.entries()) {
          const cloned = JSON.parse(JSON.stringify(docData));
          docs.push({
            id,
            data: () => JSON.parse(JSON.stringify(cloned))
          });
        }
        return {
          empty: docs.length === 0,
          docs,
          forEach: (cb: (d: { id: string; data: () => any }) => void) => docs.forEach(cb)
        };
      }
    };
  }

  async runTransaction<T>(updateFunction: (tx: any) => Promise<T>): Promise<T> {
    this.checkError();
    this.transactionCount++;
    const stagedWrites: Array<() => Promise<void>> = [];
    const tx = {
      get: async (docRef: any) => {
        return await docRef.get();
      },
      set: (docRef: any, payload: any, opts?: { merge?: boolean }) => {
        stagedWrites.push(() => docRef.set(payload, opts));
      }
    };
    const result = await updateFunction(tx);
    for (const applyWrite of stagedWrites) {
      await applyWrite();
    }
    return result;
  }
}

function saveFirebaseEnv() {
  return {
    VERCEL: process.env.VERCEL,
    VERCEL_ENV: process.env.VERCEL_ENV,
    STRICT_FIREBASE_VALIDATION: process.env.STRICT_FIREBASE_VALIDATION,
    FIREBASE_PROJECT_ID: process.env.FIREBASE_PROJECT_ID,
    FIREBASE_CLIENT_EMAIL: process.env.FIREBASE_CLIENT_EMAIL,
    FIREBASE_PRIVATE_KEY: process.env.FIREBASE_PRIVATE_KEY,
    PRODUCTION_FIREBASE_PROJECT_ID: process.env.PRODUCTION_FIREBASE_PROJECT_ID,
    FORBIDDEN_FIREBASE_PROJECT_ID: process.env.FORBIDDEN_FIREBASE_PROJECT_ID,
    STAGING_FIREBASE_PROJECT_ID: process.env.STAGING_FIREBASE_PROJECT_ID
  };
}

function restoreFirebaseEnv(snapshot: Record<string, string | undefined>) {
  for (const [k, v] of Object.entries(snapshot)) {
    if (v === undefined) {
      delete process.env[k];
    } else {
      process.env[k] = v;
    }
  }
}

async function runTests() {
  const originalEnv = saveFirebaseEnv();
  process.env.VERCEL = '1';
  await initDB();
  resetMockDatabaseForColdStartSimulation();
  const server: http.Server = await new Promise((resolve) => {
    const s = app.listen(PORT, '127.0.0.1', () => resolve(s));
  });

  let passed = 0;
  const step = async (name: string, fn: () => Promise<void>) => {
    try {
      await fn();
      passed++;
      console.log(`  [PASS] ${name}`);
    } catch (err) {
      console.error(`  [FAIL] ${name}:`, err);
      throw err;
    }
  };

  console.log('\n=== CAFFIX Staging Firebase Safety & Non-Destructive Seeding Tests ===');

  try {
    // -------------------------------------------------------------------------
    // TEST 1: Missing Firebase credentials in Preview & Production -> HTTP 503
    // -------------------------------------------------------------------------
    await step(
      '1. Missing Firebase credentials in Vercel Preview/Production fail closed with HTTP 503 and prevent MockDatabase fallback',
      async () => {
        setFirestoreForTesting({ firestoreInstance: null, initError: null, clearStores: true });
        process.env.VERCEL = '1';
        process.env.VERCEL_ENV = 'preview';
        delete process.env.FIREBASE_PROJECT_ID;
        delete process.env.FIREBASE_CLIENT_EMAIL;
        delete process.env.FIREBASE_PRIVATE_KEY;

        const loginRes = await request('POST', '/api/auth/login', {
          body: { email: 'admin@caffix.com', password: 'admin123' }
        });
        assert.strictEqual(loginRes.status, 503, `Expected 503 on login without Firebase creds, got ${loginRes.status}`);
        assert.ok(!loginRes.data?.token, 'Must not issue JWT from MockDatabase when Firebase creds are missing');

        const prodRes = await request('GET', '/api/products');
        assert.strictEqual(prodRes.status, 503, `Expected 503 on GET /api/products without Firebase creds, got ${prodRes.status}`);

        // Also verify partial credentials in Production fail closed with 503
        process.env.VERCEL_ENV = 'production';
        process.env.FIREBASE_PROJECT_ID = 'caffix-staging';
        process.env.FIREBASE_CLIENT_EMAIL = 'firebase-adminsdk@caffix-staging.iam.gserviceaccount.com';
        delete process.env.FIREBASE_PRIVATE_KEY;

        const partialRes = await request('POST', '/api/auth/login', {
          body: { email: 'admin@caffix.com', password: 'admin123' }
        });
        assert.strictEqual(partialRes.status, 503, `Expected 503 on partial Firebase creds in production, got ${partialRes.status}`);
      }
    );

    // -------------------------------------------------------------------------
    // TEST 2: Invalid Firebase credentials / initialization failure -> HTTP 503
    // -------------------------------------------------------------------------
    await step(
      '2. Invalid Firebase credentials / certificate initialization failure produces HTTP 503',
      async () => {
        setFirestoreForTesting({ firestoreInstance: null, initError: null, clearStores: true });
        process.env.VERCEL = '1';
        process.env.VERCEL_ENV = 'preview';
        process.env.FIREBASE_PROJECT_ID = 'caffix-staging';
        process.env.FIREBASE_CLIENT_EMAIL = 'firebase-adminsdk@caffix-staging.iam.gserviceaccount.com';
        process.env.FIREBASE_PRIVATE_KEY = 'INVALID_MALFORMED_PRIVATE_KEY_NOT_PEM';

        const invalidCertRes = await request('POST', '/api/auth/login', {
          body: { email: 'admin@caffix.com', password: 'admin123' }
        });
        assert.strictEqual(
          invalidCertRes.status,
          503,
          `Expected 503 when FIREBASE_PRIVATE_KEY is malformed, got ${invalidCertRes.status}`
        );
        assert.ok(
          String(invalidCertRes.data?.message || '').includes('Firebase Admin initialization failed'),
          `Expected initialization failure message, got: ${JSON.stringify(invalidCertRes.data)}`
        );
      }
    );

    // -------------------------------------------------------------------------
    // TEST 3: Preview Environment Guard rejects Production Firebase Project ID -> HTTP 503
    // -------------------------------------------------------------------------
    await step(
      '3. Preview environment guard rejects production Firebase project ID with HTTP 503 before any Firestore writes',
      async () => {
        const spyFirestore = new FakeFirestore();
        setFirestoreForTesting({
          firestoreInstance: spyFirestore,
          initError: null,
          clearStores: true
        });
        process.env.VERCEL = '1';
        process.env.VERCEL_ENV = 'preview';
        process.env.FIREBASE_CLIENT_EMAIL = 'firebase-adminsdk@caffix.iam.gserviceaccount.com';
        process.env.FIREBASE_PRIVATE_KEY = '-----BEGIN PRIVATE KEY-----\nTEST\n-----END PRIVATE KEY-----';

        // Case 3A: Matches explicit PRODUCTION_FIREBASE_PROJECT_ID
        process.env.PRODUCTION_FIREBASE_PROJECT_ID = 'vendingcaffix-live';
        process.env.FIREBASE_PROJECT_ID = 'vendingcaffix-live';
        const resA = await request('GET', '/api/products');
        assert.strictEqual(resA.status, 503, `Expected 503 for PRODUCTION_FIREBASE_PROJECT_ID, got ${resA.status}`);
        assert.strictEqual(spyFirestore.writeCount, 0, 'Must perform zero Firestore writes when Preview guard triggers');
        assert.strictEqual(spyFirestore.readCount, 0, 'Must perform zero Firestore reads when Preview guard triggers');

        // Case 3B: Project ID contains 'prod' / 'production'
        delete process.env.PRODUCTION_FIREBASE_PROJECT_ID;
        process.env.FIREBASE_PROJECT_ID = 'caffix-prod';
        const resB = await request('POST', '/api/auth/login', {
          body: { email: 'admin@caffix.com', password: 'admin123' }
        });
        assert.strictEqual(resB.status, 503, `Expected 503 for caffix-prod in Preview, got ${resB.status}`);
        assert.strictEqual(spyFirestore.writeCount, 0);

        // Case 3C: Mismatches configured STAGING_FIREBASE_PROJECT_ID
        process.env.STAGING_FIREBASE_PROJECT_ID = 'caffix-staging';
        process.env.FIREBASE_PROJECT_ID = 'vendingcaffix-main';
        const resC = await request('GET', '/api/products');
        assert.strictEqual(resC.status, 503, `Expected 503 when FIREBASE_PROJECT_ID != STAGING_FIREBASE_PROJECT_ID, got ${resC.status}`);
        assert.strictEqual(spyFirestore.writeCount, 0);

        // Case 3D: Unmarked non-staging project ID when STAGING_FIREBASE_PROJECT_ID is unset
        delete process.env.STAGING_FIREBASE_PROJECT_ID;
        process.env.FIREBASE_PROJECT_ID = 'vendingcaffix';
        const resD = await request('GET', '/api/products');
        assert.strictEqual(resD.status, 503, `Expected 503 for unmarked project ID 'vendingcaffix' in Preview, got ${resD.status}`);
        assert.strictEqual(spyFirestore.writeCount, 0);
      }
    );

    // -------------------------------------------------------------------------
    // TEST 4: Firestore runtime auth / permission failures fail closed -> HTTP 503
    // -------------------------------------------------------------------------
    await step(
      '4. Firestore authentication and permission errors fail closed with HTTP 503 (never fall back to MockDatabase)',
      async () => {
        const fakeFirestore = new FakeFirestore();
        fakeFirestore.simulatedError = new Error('16 UNAUTHENTICATED: Request had invalid authentication credentials.');
        setFirestoreForTesting({
          firestoreInstance: fakeFirestore,
          initError: null,
          clearStores: true
        });
        process.env.VERCEL = '1';
        process.env.VERCEL_ENV = 'preview';
        process.env.STAGING_FIREBASE_PROJECT_ID = 'caffix-staging';
        process.env.FIREBASE_PROJECT_ID = 'caffix-staging';
        process.env.FIREBASE_CLIENT_EMAIL = 'firebase-adminsdk@caffix-staging.iam.gserviceaccount.com';
        process.env.FIREBASE_PRIVATE_KEY = '-----BEGIN PRIVATE KEY-----\nTEST\n-----END PRIVATE KEY-----';

        const loginRes = await request('POST', '/api/auth/login', {
          body: { email: 'admin@caffix.com', password: 'admin123' }
        });
        assert.strictEqual(loginRes.status, 503, `Expected 503 on Firestore UNAUTHENTICATED error, got ${loginRes.status}`);
        assert.ok(!loginRes.data?.token, 'Must not fall back to MockDatabase admin user when Firestore throws UNAUTHENTICATED');
      }
    );

    // -------------------------------------------------------------------------
    // TEST 5: Fresh Staging Firestore Connection & Initial Seeding
    // -------------------------------------------------------------------------
    const stagingFirestore = new FakeFirestore();
    await step(
      '5. Fresh staging Firestore seeds default admin and machines atomically while preserving global products & per-machine override architecture',
      async () => {
        process.env.VERCEL = '1';
        process.env.VERCEL_ENV = 'preview';
        process.env.PRODUCTION_FIREBASE_PROJECT_ID = 'vendingcaffix';
        process.env.STAGING_FIREBASE_PROJECT_ID = 'caffix-staging';
        process.env.FIREBASE_PROJECT_ID = 'caffix-staging';
        process.env.FIREBASE_CLIENT_EMAIL = 'firebase-adminsdk@caffix-staging.iam.gserviceaccount.com';
        process.env.FIREBASE_PRIVATE_KEY = '-----BEGIN PRIVATE KEY-----\nTEST\n-----END PRIVATE KEY-----';

        resetMockDatabaseForColdStartSimulation();
        setFirestoreForTesting({
          firestoreInstance: stagingFirestore,
          initError: null,
          clearStores: true
        });

        // Trigger initial request against fresh staging Firestore
        const loginRes = await request('POST', '/api/auth/login', {
          body: { email: 'admin@caffix.com', password: 'admin123' }
        });
        assert.strictEqual(loginRes.status, 200, `Expected 200 on Admin login with fresh staging Firestore, got ${loginRes.status}`);
        assert.ok(loginRes.data?.token, 'Expected valid Admin JWT');

        // Verify Firestore collections created: ONLY 'users' and 'machines' (NO duplicate top-level 'products' collection)
        assert.strictEqual(
          stagingFirestore.collections.has('products'),
          false,
          'Must NOT create a duplicate top-level products collection in Firestore'
        );

        const usersCol = stagingFirestore.collections.get('users');
        assert.ok(usersCol, 'Expected users collection in staging Firestore');
        assert.ok(usersCol.has('1'), 'Expected default Admin (users/1) in staging Firestore');
        assert.strictEqual(usersCol.get('1').email, 'admin@caffix.com');
        assert.strictEqual(usersCol.get('1').role, 'admin');

        const machinesCol = stagingFirestore.collections.get('machines');
        assert.ok(machinesCol, 'Expected machines collection in staging Firestore');
        for (const mId of ['CFX-MC-01', 'CFX-MC-02', 'CFX-MC-03']) {
          assert.ok(machinesCol.has(mId), `Expected ${mId} seeded in staging Firestore`);
          const mDoc = machinesCol.get(mId);
          assert.strictEqual(mDoc.desired_mode, 'RUNNING');
          assert.strictEqual(mDoc.last_seen, null);
          assert.strictEqual(mDoc.owner_id, null);
          assert.ok(mDoc.estimated_inventory, `Expected estimated_inventory on ${mId}`);
        }

        // Verify global catalog products & per-machine products work via getAuthoritativeMachineProducts
        const machineProdsRes = await request('GET', '/api/machines/CFX-MC-01/products', {
          headers: { Authorization: `Bearer ${loginRes.data.token}` }
        });
        assert.strictEqual(machineProdsRes.status, 200);
        assert.strictEqual(machineProdsRes.data.data.length, 5);
        assert.strictEqual(machineProdsRes.data.data[0].name, 'Classic Crest');
        assert.strictEqual(machineProdsRes.data.data[0].price, 100);
        assert.strictEqual(machineProdsRes.data.data[0].is_available, true);

        // Verify MockDatabase demo orders were cleared and do not pollute staging
        const ordersRes = await request('GET', '/api/orders', {
          headers: { Authorization: `Bearer ${loginRes.data.token}` }
        });
        assert.strictEqual(ordersRes.status, 200);
        assert.strictEqual(
          ordersRes.data.data.length,
          0,
          'Fresh staging Firestore must return 0 orders (not MockDatabase hardcoded demo orders)'
        );
      }
    );

    // -------------------------------------------------------------------------
    // TEST 6: Repeated & Concurrent Cold Starts NEVER Overwrite Existing Data
    // -------------------------------------------------------------------------
    await step(
      '6. Repeated and concurrent cold-start initializations never overwrite modified admin password, owner_id, desired_mode, last_seen, estimated_inventory, or per-machine product overrides',
      async () => {
        // 1. Log in as Admin and modify state across users and machines
        const initialLogin = await request('POST', '/api/auth/login', {
          body: { email: 'admin@caffix.com', password: 'admin123' }
        });
        assert.strictEqual(initialLogin.status, 200);
        const adminToken = initialLogin.data.token;

        // Change Admin password from 'admin123' to 'StagingAdmin#2026'
        const pwChangeRes = await request('POST', '/api/auth/change-password', {
          headers: { Authorization: `Bearer ${adminToken}` },
          body: {
            current_password: 'admin123',
            new_password: 'StagingAdmin#2026'
          }
        });
        assert.strictEqual(pwChangeRes.status, 200);

        // Invite an Owner and assign CFX-MC-01
        const inviteRes = await request('POST', '/api/auth/owners/invite', {
          headers: { Authorization: `Bearer ${adminToken}` },
          body: {
            name: 'Staging Owner',
            email: 'owner.staging@caffix.com',
            machine_ids: ['CFX-MC-01']
          }
        });
        assert.strictEqual(inviteRes.status, 201);
        const ownerId = inviteRes.data.data.user.id;
        const rawInviteToken = inviteRes.data.data.invite_token;

        // Complete Owner password setup
        const setupRes = await request('POST', '/api/auth/setup-password', {
          body: {
            token: rawInviteToken,
            email: 'owner.staging@caffix.com',
            password: 'OwnerPass#2026'
          }
        });
        assert.strictEqual(setupRes.status, 200);
        const ownerToken = setupRes.data.token;

        // Owner sets CFX-MC-01 to MAINTENANCE mode
        const modeRes = await request('PATCH', '/api/machines/CFX-MC-01/status', {
          headers: { Authorization: `Bearer ${ownerToken}` },
          body: { desired_mode: 'MAINTENANCE' }
        });
        assert.strictEqual(modeRes.status, 200);

        // Record RPi heartbeat on CFX-MC-01
        const hbRes = await request('POST', '/api/machines/CFX-MC-01/heartbeat', {
          headers: { Authorization: `Bearer ${adminToken}` }
        });
        assert.strictEqual(hbRes.status, 200);
        const recordedLastSeen = hbRes.data.data.last_seen;
        assert.ok(recordedLastSeen, 'Expected last_seen timestamp');

        // Refill CFX-MC-01 milk to 100 (modifying estimated_inventory from initial 92 -> 100)
        const refillRes = await request('POST', '/api/machines/CFX-MC-01/refill', {
          headers: { Authorization: `Bearer ${ownerToken}` },
          body: { ingredient: 'milk' }
        });
        assert.strictEqual(refillRes.status, 200);

        // Owner customizes CFX-MC-01 product 1 (Classic Crest -> ₹145) and product 2 (Vanilla Velvet -> unavailable)
        const p1Res = await request('PATCH', '/api/machines/CFX-MC-01/products/1', {
          headers: { Authorization: `Bearer ${ownerToken}` },
          body: { price: 145, is_available: true }
        });
        assert.strictEqual(p1Res.status, 200);

        const p2Res = await request('PATCH', '/api/machines/CFX-MC-01/products/2', {
          headers: { Authorization: `Bearer ${ownerToken}` },
          body: { price: 115, is_available: false }
        });
        assert.strictEqual(p2Res.status, 200);

        // 2. Simulate a Vercel Serverless Cold Start + 5 concurrent cold-start initialization calls
        resetMockDatabaseForColdStartSimulation();
        resetFirestoreSeedStateForTesting();

        await Promise.all([
          ensureFirestoreSeeded(getDB()),
          ensureFirestoreSeeded(getDB()),
          ensureFirestoreSeeded(getDB()),
          ensureFirestoreSeeded(getDB()),
          ensureFirestoreSeeded(getDB())
        ]);

        // Simulate a second sequential cold start as well
        resetMockDatabaseForColdStartSimulation();
        resetFirestoreSeedStateForTesting();
        await ensureFirestoreSeeded(getDB());

        // 3. Verify Admin password was NOT reset to 'admin123'
        const oldPassLogin = await request('POST', '/api/auth/login', {
          body: { email: 'admin@caffix.com', password: 'admin123' }
        });
        assert.strictEqual(
          oldPassLogin.status,
          401,
          'Old default admin password (admin123) must be rejected after cold-start re-initialization'
        );

        const newPassLogin = await request('POST', '/api/auth/login', {
          body: { email: 'admin@caffix.com', password: 'StagingAdmin#2026' }
        });
        assert.strictEqual(
          newPassLogin.status,
          200,
          'Updated Admin password must be preserved across cold-start re-initialization'
        );

        // 4. Verify Owner account and password remain intact
        const ownerLoginAfterColdStart = await request('POST', '/api/auth/login', {
          body: { email: 'owner.staging@caffix.com', password: 'OwnerPass#2026' }
        });
        assert.strictEqual(ownerLoginAfterColdStart.status, 200);
        assert.deepStrictEqual(ownerLoginAfterColdStart.data.data.assigned_machines, ['CFX-MC-01']);

        // 5. Verify CFX-MC-01 preserved owner_id, desired_mode, status, last_seen, and estimated_inventory
        const machRes = await request('GET', '/api/machines/CFX-MC-01', {
          headers: { Authorization: `Bearer ${ownerToken}` }
        });
        assert.strictEqual(machRes.status, 200);
        const mData = machRes.data.data;
        assert.strictEqual(mData.owner_id, ownerId, 'owner_id must not be overwritten');
        assert.strictEqual(mData.desired_mode, 'MAINTENANCE', 'desired_mode must not be overwritten');
        assert.strictEqual(mData.status, 'maintenance', 'status must not be overwritten');
        assert.strictEqual(mData.last_seen, recordedLastSeen, 'last_seen must not be overwritten');
        assert.strictEqual(
          mData.estimated_inventory.milk_level,
          100,
          'estimated_inventory.milk_level (100) must not be overwritten by initial seed (92)'
        );
        assert.strictEqual(
          mData.estimated_inventory.coffee_level,
          78,
          'estimated_inventory.coffee_level (78) must be preserved'
        );

        // 6. Verify CFX-MC-01 per-machine product prices and availability were NOT overwritten
        const prodsAfterRes = await request('GET', '/api/machines/CFX-MC-01/products', {
          headers: { Authorization: `Bearer ${ownerToken}` }
        });
        assert.strictEqual(prodsAfterRes.status, 200);
        const pList = prodsAfterRes.data.data;
        const p1 = pList.find((p: any) => p.id === 1);
        const p2 = pList.find((p: any) => p.id === 2);
        const p3 = pList.find((p: any) => p.id === 3);
        assert.strictEqual(p1.price, 145, 'Product 1 custom price ₹145 must be preserved');
        assert.strictEqual(p1.is_available, true);
        assert.strictEqual(p2.price, 115, 'Product 2 custom price ₹115 must be preserved');
        assert.strictEqual(p2.is_available, false, 'Product 2 unavailable flag must be preserved');
        assert.strictEqual(p3.price, 100, 'Product 3 default price ₹100 must remain intact');
      }
    );

    // -------------------------------------------------------------------------
    // TEST 7: Security Audit — Bcrypt Hashing, Secret Redaction & Production Default Credential Rejection
    // -------------------------------------------------------------------------
    await step(
      '7. Seeded staging passwords use bcrypt, secrets are never returned, and default staging credentials cannot access Production',
      async () => {
        // 1. Inspect seeded user records in stagingFirestore from Test 5/6
        const usersCol = stagingFirestore.collections.get('users')!;
        const adminDoc = usersCol.get('1');
        const kioskDoc = usersCol.get('2');
        assert.ok(
          typeof adminDoc.password === 'string' && adminDoc.password.startsWith('$2'),
          'Admin password in Firestore must be a bcrypt hash'
        );
        assert.ok(
          typeof kioskDoc.password === 'string' && kioskDoc.password.startsWith('$2'),
          'Kiosk password in Firestore must be a bcrypt hash'
        );
        assert.notStrictEqual(adminDoc.password, 'admin123');
        assert.notStrictEqual(kioskDoc.password, 'kiosk123');

        // 2. Verify Production (VERCEL_ENV=production) never seeds or accepts default staging credentials ('admin123' / 'kiosk123')
        const prodFirestore = new FakeFirestore();
        delete process.env.PRODUCTION_FIREBASE_PROJECT_ID;
        delete process.env.STAGING_FIREBASE_PROJECT_ID;
        delete process.env.FORBIDDEN_FIREBASE_PROJECT_ID;
        process.env.VERCEL = '1';
        process.env.VERCEL_ENV = 'production';
        process.env.FIREBASE_PROJECT_ID = 'caffix-vending';
        process.env.FIREBASE_CLIENT_EMAIL = 'firebase-adminsdk@caffix-vending.iam.gserviceaccount.com';
        process.env.FIREBASE_PRIVATE_KEY = '-----BEGIN PRIVATE KEY-----\nPROD_KEY\n-----END PRIVATE KEY-----';

        resetMockDatabaseForColdStartSimulation();
        setFirestoreForTesting({
          firestoreInstance: prodFirestore,
          initError: null,
          clearStores: true
        });

        // Attempt to log in with default 'admin123' on a fresh Production Firestore -> must fail (401) and NOT seed users/1 with admin123
        const prodDefaultLogin = await request('POST', '/api/auth/login', {
          body: { email: 'admin@caffix.com', password: 'admin123' }
        });
        assert.strictEqual(
          prodDefaultLogin.status,
          401,
          'Default staging admin123 password must not authenticate in VERCEL_ENV=production'
        );
        assert.strictEqual(
          prodFirestore.collections.get('users')?.has('1') ?? false,
          false,
          'ensureFirestoreSeeded must not seed default admin123 account into Production Firestore'
        );

        // Even if a document with default 'admin123' hash were manually placed in Production Firestore, login must be rejected
        await prodFirestore.collection('users').doc('1').set({
          id: '1',
          name: 'Caffix Manager',
          email: 'admin@caffix.com',
          password: kioskDoc.password, // default hash ('kiosk123')
          role: 'admin',
          must_change_password: 0
        });
        const prodDefaultHashLogin = await request('POST', '/api/auth/login', {
          body: { email: 'admin@caffix.com', password: 'kiosk123' }
        });
        assert.strictEqual(
          prodDefaultHashLogin.status,
          401,
          'Default staging/dev password hash must be rejected in VERCEL_ENV=production'
        );
      }
    );

    // -------------------------------------------------------------------------
    // TEST 10: Firestore authoritative hydration without updated_at & override pruning
    // -------------------------------------------------------------------------
    await step(
      '10. Firestore overrides and estimated_inventory hydrate cold/warm MockDatabase even when timestamps are omitted or overrides are removed',
      async () => {
        const syncFirestore = new FakeFirestore();
        process.env.VERCEL = '1';
        process.env.VERCEL_ENV = 'preview';
        process.env.PRODUCTION_FIREBASE_PROJECT_ID = 'vendingcaffix';
        process.env.STAGING_FIREBASE_PROJECT_ID = 'caffix-staging';
        process.env.FIREBASE_PROJECT_ID = 'caffix-staging';
        process.env.FIREBASE_CLIENT_EMAIL = 'firebase-adminsdk@caffix-staging.iam.gserviceaccount.com';
        process.env.FIREBASE_PRIVATE_KEY = '-----BEGIN PRIVATE KEY-----\nTEST\n-----END PRIVATE KEY-----';

        resetMockDatabaseForColdStartSimulation();
        setFirestoreForTesting({
          firestoreInstance: syncFirestore,
          initError: null,
          clearStores: true
        });

        const loginRes = await request('POST', '/api/auth/login', {
          body: { email: 'admin@caffix.com', password: 'admin123' }
        });
        assert.strictEqual(loginRes.status, 200);
        const adminTok = loginRes.data.token;

        // Warm the MockDatabase cache with CFX-MC-01 product 2 override = 125
        const putProd = await request('PUT', '/api/machines/CFX-MC-01/products/2', {
          headers: { Authorization: `Bearer ${adminTok}` },
          body: { price: 125, is_available: false }
        });
        assert.strictEqual(putProd.status, 200);

        // Simulate out-of-band Firestore edit (missing inventory_updated_at & older/missing product updated_at)
        const mc01Doc = syncFirestore.collections.get('machines')?.get('CFX-MC-01');
        assert.ok(mc01Doc, 'CFX-MC-01 must exist in FakeFirestore');
        await syncFirestore.collection('machines').doc('CFX-MC-01').set({
          ...mc01Doc,
          updated_at: '2026-01-01T00:00:00.000Z',
          inventory_updated_at: '',
          estimated_inventory: {
            milk_level: 3,
            coffee_level: 88,
            vanilla_level: 4,
            hazelnut_level: 90,
            irish_level: 90,
            mocha_level: 90,
            water_level: 85
          },
          products: {
            '1': { product_id: 1, price: 165, is_available: true, updated_at: '2026-01-01T00:00:00.000Z' }
            // Notice product '2' override was removed from Firestore!
          }
        });

        // Verify warm MockDatabase sees Firestore's product 1 = 165 and product 2 reverted to default 100 / available=true
        const kioskRes = await request('GET', '/api/products?machine_id=CFX-MC-01');
        assert.strictEqual(kioskRes.status, 200);
        const classic = kioskRes.data.data.find((p: any) => Number(p.id) === 1);
        const vanilla = kioskRes.data.data.find((p: any) => Number(p.id) === 2);
        assert.strictEqual(classic.price, 165);
        assert.strictEqual(vanilla.price, 100);
        assert.strictEqual(vanilla.is_available, true);

        // Verify cold start against same Firestore picks up depleted milk_level=3 despite missing inventory_updated_at
        resetMockDatabaseForColdStartSimulation();
        const statusRes = await request('GET', '/api/machine-status?machine_id=CFX-MC-01', {
          headers: { Authorization: `Bearer ${adminTok}` }
        });
        assert.strictEqual(statusRes.status, 200);
        assert.strictEqual(statusRes.data.data.inventory.milk, 3);
        assert.strictEqual(statusRes.data.data.inventory.vanilla, 4);
      }
    );

    console.log(`\nALL ${passed} STAGING FIREBASE SAFETY & SEEDING TESTS PASSED!\n`);
  } finally {
    setFirestoreForTesting({ firestoreInstance: null, initError: null, clearStores: true });
    restoreFirebaseEnv(originalEnv);
    resetMockDatabaseForColdStartSimulation();
    server.close();
  }
}

runTests().catch((err) => {
  console.error('Staging Firebase safety test suite failed:', err);
  process.exit(1);
});
