import assert from 'assert';
import bcrypt from 'bcryptjs';
import http from 'http';
import jwt from 'jsonwebtoken';

process.env.VERCEL = '1';
process.env.VERCEL_ENV = 'production';
process.env.FIREBASE_PROJECT_ID = 'caffix-vending';
process.env.FIREBASE_CLIENT_EMAIL = 'firebase-adminsdk@caffix-vending.iam.gserviceaccount.com';
process.env.FIREBASE_PRIVATE_KEY = '-----BEGIN PRIVATE KEY-----\nWAVE3_14_TEST_KEY\n-----END PRIVATE KEY-----';
process.env.JWT_SECRET = 'caffix-test-wave3-14-jwt-secret-key-2026';
process.env.KIOSK_SECRET = 'kiosk_prod_secret_live_987654321';
process.env.KIOSK_ADMIN_ENABLED = 'false';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const app = require('../index').default;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { initDB, getDB, resetMockDatabaseForColdStartSimulation } = require('../config/db');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const {
  setFirestoreForTesting,
  resetFirestoreSeedStateForTesting,
  ensureFirestoreSeeded
} = require('../utils/firebase');

const PORT = 5096;
const BASE_URL = `http://127.0.0.1:${PORT}/api`;

class TrackingMockFirestore {
  public collections = new Map<string, Map<string, any>>();
  public writeCount = 0;

  private getCol(name: string): Map<string, any> {
    let col = this.collections.get(name);
    if (!col) {
      col = new Map<string, any>();
      this.collections.set(name, col);
    }
    return col;
  }

  collection(colName: string) {
    const self = this;
    const colMap = this.getCol(colName);
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
          }
        };
      },
      where(field: string, op: string, value: any) {
        const match = () => {
          const list: Array<{ id: string; data: () => any }> = [];
          for (const [id, data] of colMap.entries()) {
            if (op === '==' && data && data[field] === value) {
              list.push({ id, data: () => JSON.parse(JSON.stringify(data)) });
            }
          }
          return list;
        };
        return {
          limit(max: number) {
            return {
              async get() {
                const sliced = match().slice(0, max);
                return { empty: sliced.length === 0, docs: sliced, forEach: (cb: (d: any) => void) => sliced.forEach(cb) };
              }
            };
          },
          async get() {
            const docs = match();
            return { empty: docs.length === 0, docs, forEach: (cb: (d: any) => void) => docs.forEach(cb) };
          }
        };
      },
      async get() {
        const docs: Array<{ id: string; data: () => any }> = [];
        for (const [id, data] of colMap.entries()) {
          docs.push({ id, data: () => JSON.parse(JSON.stringify(data)) });
        }
        return { empty: docs.length === 0, docs, forEach: (cb: (d: any) => void) => docs.forEach(cb) };
      }
    };
  }

  async runTransaction<T>(fn: (tx: any) => Promise<T>): Promise<T> {
    const self = this;
    const tx = {
      get: async (ref: any) => await ref.get(),
      set: async (ref: any, payload: any, opts?: { merge?: boolean }) => {
        await ref.set(payload, opts);
      }
    };
    return await fn(tx);
  }
}

function api(method: string, path: string, body?: any, token?: string): Promise<{ status: number; data: any; headers: any }> {
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
    const req = http.request(
      url,
      {
        method,
        headers
      },
      (res) => {
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
      }
    );
    req.on('error', reject);
    if (payload) {
      req.write(payload);
    }
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
  console.log('Running Wave 3.14 — Machine Registration & Kiosk Authorization Tests');
  console.log('================================================================');

  const mockFs = new TrackingMockFirestore();
  setFirestoreForTesting({ firestoreInstance: mockFs, initError: null, clearStores: true });
  resetFirestoreSeedStateForTesting();
  resetMockDatabaseForColdStartSimulation();

  await initDB();
  const db = getDB();

  // Run ensureFirestoreSeeded in simulated Production
  await ensureFirestoreSeeded(db);

  const server = http.createServer(app);
  await new Promise<void>((resolve) => {
    server.listen(PORT, () => resolve());
  });

  const adminToken = generateAdminToken();

  try {
    // -------------------------------------------------------------------------
    // ISSUE 1: Machine Registration duplicate check & authoritative fleet list
    // -------------------------------------------------------------------------
    console.log('\n--- 1. Testing Issue 1: Machine Registration & 0-Fleet-Machine Bug ---');

    // 1A. Dashboard queries fleet machines on clean Production start -> MUST be 0
    const listRes1 = await api('GET', '/machines', undefined, adminToken);
    assert.strictEqual(listRes1.status, 200, 'GET /machines should return 200');
    assert.strictEqual(listRes1.data.status, 'success');
    assert.strictEqual(listRes1.data.data.length, 0, 'Dashboard must see 0 fleet machines on fresh Production');
    console.log('   PASS: Fresh Production dashboard reports 0 fleet machines.');

    // 1B. Registering CFX-MC-01 must SUCCEED (201 Created) and NOT report false duplicate!
    const regRes1 = await api(
      'POST',
      '/machines/register',
      {
        id: 'CFX-MC-01',
        machine_name: 'Delhi Airport Terminal 3',
        location: 'Delhi Airport T3 Departure Gate 4'
      },
      adminToken
    );
    assert.strictEqual(regRes1.status, 201, `Expected 201 Created for CFX-MC-01, got ${regRes1.status}: ${JSON.stringify(regRes1.data)}`);
    assert.strictEqual(regRes1.data.status, 'success');
    assert.strictEqual(regRes1.data.data.id, 'CFX-MC-01');
    assert.ok(regRes1.data.data.kiosk_token, 'Machine registration must generate dedicated kiosk_token');
    const mc01Token = regRes1.data.data.kiosk_token;
    console.log('   PASS: Super Admin registered CFX-MC-01 without duplicate conflict.');

    // 1C. Verify CFX-MC-01 was created in authoritative Firestore
    const fsDoc1 = await mockFs.collection('machines').doc('CFX-MC-01').get();
    assert.strictEqual(fsDoc1.exists, true, 'CFX-MC-01 document must exist in Firestore');
    assert.strictEqual(fsDoc1.data().machine_name, 'Delhi Airport Terminal 3');
    assert.strictEqual(fsDoc1.data().kiosk_token, mc01Token);
    console.log('   PASS: CFX-MC-01 document persisted to Firestore.');

    // 1D. Duplicate registration of CFX-MC-01 (including lower-case cfx-mc-01) must return 409 Conflict
    const dupRes = await api(
      'POST',
      '/machines/register',
      {
        id: 'cfx-mc-01',
        machine_name: 'Another Delhi Machine',
        location: 'Delhi'
      },
      adminToken
    );
    assert.strictEqual(dupRes.status, 409, `Duplicate registration must return 409, got ${dupRes.status}`);
    assert.ok(dupRes.data.message.includes('already registered'), 'Duplicate message must indicate machine is registered');
    console.log('   PASS: Duplicate machine registration accurately blocked with 409 Conflict.');

    // 1E. Calling GET /machines now shows 1 machine
    const listRes2 = await api('GET', '/machines', undefined, adminToken);
    assert.strictEqual(listRes2.status, 200);
    assert.strictEqual(listRes2.data.data.length, 1);
    assert.strictEqual(listRes2.data.data[0].id, 'CFX-MC-01');
    console.log('   PASS: Dashboard fleet count reflects registered machine (count = 1).');

    // -------------------------------------------------------------------------
    // ISSUE 2: Kiosk Authorization & Unauthorized Device
    // -------------------------------------------------------------------------
    console.log('\n--- 2. Testing Issue 2: Kiosk Authorization & Device Verification ---');

    // 2A. Opening kiosk for unregistered machine (CFX-MC-02) -> MUST return 401 Unauthorized
    const unregRes = await api(
      'GET',
      `/kiosk/verify?kiosk=${encodeURIComponent(process.env.KIOSK_SECRET as string)}&machine_id=CFX-MC-02`
    );
    assert.strictEqual(unregRes.status, 401, 'Unregistered machine CFX-MC-02 must be rejected with 401');
    assert.strictEqual(unregRes.data.authorized, false);
    assert.ok(unregRes.data.message.includes('not registered'), 'Message must indicate machine is not registered');
    console.log('   PASS: Unregistered machine CFX-MC-02 rejected with 401 (not registered).');

    // 2B. Missing kiosk parameter -> MUST return 401
    const noKioskParamRes = await api('GET', '/kiosk/verify?machine_id=CFX-MC-01');
    assert.strictEqual(noKioskParamRes.status, 401, 'Missing kiosk parameter must return 401');
    console.log('   PASS: Missing kiosk credential parameter rejected with 401.');

    // 2C. Register machine CFX-MC-02 in the fleet
    const regRes2 = await api(
      'POST',
      '/machines/register',
      {
        id: 'CFX-MC-02',
        machine_name: 'Connaught Place Central',
        location: 'Inner Circle Block B'
      },
      adminToken
    );
    assert.strictEqual(regRes2.status, 201, 'CFX-MC-02 registration must succeed');
    const mc02Token = regRes2.data.data.kiosk_token;
    assert.ok(mc02Token, 'CFX-MC-02 dedicated token must be generated');
    console.log('   PASS: Registered CFX-MC-02.');

    // 2D. Kiosk verify CFX-MC-02 with valid shared Production KIOSK_SECRET -> MUST return 200 OK!
    const sharedAuthRes = await api(
      'GET',
      `/kiosk/verify?kiosk=${encodeURIComponent(process.env.KIOSK_SECRET as string)}&machine_id=CFX-MC-02`
    );
    assert.strictEqual(
      sharedAuthRes.status,
      200,
      `Expected 200 OK for CFX-MC-02 with shared KIOSK_SECRET, got ${sharedAuthRes.status}: ${JSON.stringify(sharedAuthRes.data)}`
    );
    assert.strictEqual(sharedAuthRes.data.authorized, true);
    assert.strictEqual(sharedAuthRes.data.machine_id, 'CFX-MC-02');
    assert.ok(sharedAuthRes.data.token, 'Must return signed kiosk JWT token');

    // Verify the returned JWT is bound to CFX-MC-02
    const decoded: any = jwt.verify(sharedAuthRes.data.token, process.env.JWT_SECRET as string);
    assert.strictEqual(decoded.role, 'kiosk');
    assert.strictEqual(decoded.machine_id, 'CFX-MC-02');
    console.log('   PASS: Kiosk CFX-MC-02 verified successfully with Production KIOSK_SECRET.');

    // 2E. Kiosk verify CFX-MC-02 with dedicated per-machine token -> MUST return 200 OK!
    const dedicatedAuthRes = await api(
      'GET',
      `/kiosk/verify?kiosk=${encodeURIComponent(mc02Token)}&machine_id=CFX-MC-02`
    );
    assert.strictEqual(dedicatedAuthRes.status, 200, 'Dedicated token must authenticate CFX-MC-02 with 200 OK');
    assert.strictEqual(dedicatedAuthRes.data.authorized, true);
    assert.strictEqual(dedicatedAuthRes.data.machine_id, 'CFX-MC-02');
    console.log('   PASS: Kiosk CFX-MC-02 verified successfully with dedicated per-machine token.');

    // 2F. Cross-machine token: using CFX-MC-01 token for CFX-MC-02 -> MUST return 401
    const crossRes = await api(
      'GET',
      `/kiosk/verify?kiosk=${encodeURIComponent(mc01Token)}&machine_id=CFX-MC-02`
    );
    assert.strictEqual(crossRes.status, 401, 'Cross-machine token usage must return 401');
    assert.strictEqual(crossRes.data.authorized, false);
    console.log('   PASS: Cross-machine token correctly rejected with 401.');

    // 2G. When ENFORCE_PER_MACHINE_SECRETS is enabled, shared secret is locked out and ONLY dedicated token works
    process.env.ENFORCE_PER_MACHINE_SECRETS = 'true';
    const strictSharedRes = await api(
      'GET',
      `/kiosk/verify?kiosk=${encodeURIComponent(process.env.KIOSK_SECRET as string)}&machine_id=CFX-MC-02`
    );
    assert.strictEqual(strictSharedRes.status, 401, 'Shared secret must be rejected when ENFORCE_PER_MACHINE_SECRETS=true');
    assert.ok(strictSharedRes.data.message.includes('requires its dedicated credential'));

    const strictDedicatedRes = await api(
      'GET',
      `/kiosk/verify?kiosk=${encodeURIComponent(mc02Token)}&machine_id=CFX-MC-02`
    );
    assert.strictEqual(strictDedicatedRes.status, 200, 'Dedicated token must continue working under strict enforcement');
    delete process.env.ENFORCE_PER_MACHINE_SECRETS;
    console.log('   PASS: ENFORCE_PER_MACHINE_SECRETS correctly isolates dedicated credentials.');

    console.log('\n================================================================');
    console.log('ALL WAVE 3.14 REGRESSION TESTS PASSED SUCCESSFULLY!');
    console.log('================================================================\n');
  } finally {
    server.close();
  }
}

runTests().catch((err) => {
  console.error('Test run failed:', err);
  process.exit(1);
});

