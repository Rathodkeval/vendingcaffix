import assert from 'assert';
import bcrypt from 'bcryptjs';
import http from 'http';

process.env.VERCEL = '1';
process.env.VERCEL_ENV = 'production';
process.env.FIREBASE_PROJECT_ID = 'caffix-vending';
process.env.FIREBASE_CLIENT_EMAIL = 'firebase-adminsdk@caffix-vending.iam.gserviceaccount.com';
process.env.FIREBASE_PRIVATE_KEY = '-----BEGIN PRIVATE KEY-----\nWAVE3_7_TEST_KEY\n-----END PRIVATE KEY-----';
process.env.JWT_SECRET = 'caffix-test-wave3-7-jwt-secret-key-2026';
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

const PORT = 5094;
const BASE_URL = `http://127.0.0.1:${PORT}/api`;

class TrackingMockFirestore {
  public collections = new Map<string, Map<string, any>>();
  public writeCount = 0;
  public machineWriteCount = 0;

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
            if (colName === 'machines') {
              self.machineWriteCount++;
            }
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
    const stagedWrites: Array<{ ref: any; payload: any; opts?: { merge?: boolean } }> = [];
    const tx = {
      get: async (ref: any) => ref.get(),
      set: (ref: any, payload: any, opts?: { merge?: boolean }) => {
        stagedWrites.push({ ref, payload, opts });
      }
    };
    const res = await fn(tx);
    for (const w of stagedWrites) {
      await w.ref.set(w.payload, w.opts);
    }
    return res;
  }
}

async function api(
  method: string,
  path: string,
  body?: any,
  headers: Record<string, string> = {}
): Promise<{ status: number; data: any }> {
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...headers
    },
    body: body !== undefined ? JSON.stringify(body) : undefined
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

function seedProdAdmin(fs: TrackingMockFirestore, email: string, password: string): void {
  fs.collections.set(
    'users',
    new Map<string, any>([
      [
        'usr_prod_admin',
        {
          id: 'usr_prod_admin',
          name: 'Prod Super Admin',
          email,
          password: bcrypt.hashSync(password, 10),
          role: 'admin',
          must_change_password: 0,
          updated_at: new Date().toISOString()
        }
      ]
    ])
  );
}

async function runWave37Tests() {
  console.log('\n=============================================================');
  console.log('Running Wave 3.7 Production No-Auto-Machine-Seeding Tests');
  console.log('=============================================================\n');

  await initDB();
  const server: http.Server = await new Promise((resolve) => {
    const s = app.listen(PORT, '127.0.0.1', () => resolve(s));
  });

  const savedEnv = {
    VERCEL: process.env.VERCEL,
    VERCEL_ENV: process.env.VERCEL_ENV,
    FIREBASE_PROJECT_ID: process.env.FIREBASE_PROJECT_ID,
    KIOSK_SECRET: process.env.KIOSK_SECRET,
    KIOSK_SECRET_CFX_MC_01: process.env.KIOSK_SECRET_CFX_MC_01,
    KIOSK_SECRET_CFX_MC_02: process.env.KIOSK_SECRET_CFX_MC_02,
    KIOSK_SECRET_CFX_MC_03: process.env.KIOSK_SECRET_CFX_MC_03,
    KIOSK_SECRET_CFX_MC_04: process.env.KIOSK_SECRET_CFX_MC_04,
    STAGING_FIREBASE_PROJECT_ID: process.env.STAGING_FIREBASE_PROJECT_ID,
    PRODUCTION_FIREBASE_PROJECT_ID: process.env.PRODUCTION_FIREBASE_PROJECT_ID
  };

  try {
    // -------------------------------------------------------------------------
    // 1. Production seeding on empty Firestore creates 0 machines
    // -------------------------------------------------------------------------
    console.log('1. Testing Production startup/API requests on empty Firestore create 0 machines...');
    process.env.VERCEL = '1';
    process.env.VERCEL_ENV = 'production';
    process.env.FIREBASE_PROJECT_ID = 'caffix-vending';
    process.env.KIOSK_SECRET = 'Wave37ProdKioskSecret_01';
    process.env.KIOSK_SECRET_CFX_MC_01 = 'Wave37ProdMc01Secret_Alpha';
    process.env.KIOSK_SECRET_CFX_MC_02 = 'Wave37ProdMc02Secret_Beta';
    process.env.KIOSK_SECRET_CFX_MC_03 = 'Wave37ProdMc03Secret_Gamma';
    process.env.KIOSK_SECRET_CFX_MC_04 = 'Wave37ProdMc04Secret_Delta';
    delete process.env.PRODUCTION_FIREBASE_PROJECT_ID;
    delete process.env.STAGING_FIREBASE_PROJECT_ID;

    const emptyProdFs = new TrackingMockFirestore();
    seedProdAdmin(emptyProdFs, 'prodadmin@caffix.com', 'StrongProdPass#37!');
    setFirestoreForTesting({ firestoreInstance: emptyProdFs, initError: null, clearStores: true });
    resetMockDatabaseForColdStartSimulation();

    await ensureFirestoreSeeded(getDB());
    assert.strictEqual(emptyProdFs.writeCount, 0, 'Production seeding must perform 0 Firestore writes on empty machines');
    assert.strictEqual(emptyProdFs.machineWriteCount, 0, 'Production seeding must perform 0 machine writes');
    assert.strictEqual(
      emptyProdFs.collections.get('machines')?.size ?? 0,
      0,
      'Production Firestore machines collection must remain empty (CFX-MC-01..04 must NOT be created)'
    );

    const prodLoginRes = await api('POST', '/auth/login', {
      email: 'prodadmin@caffix.com',
      password: 'StrongProdPass#37!',
      portal: 'admin'
    });
    assert.strictEqual(prodLoginRes.status, 200);
    const prodAdminToken = prodLoginRes.data.token;

    const listMachinesEmpty = await api('GET', '/machines', undefined, {
      Authorization: `Bearer ${prodAdminToken}`
    });
    assert.strictEqual(listMachinesEmpty.status, 200);
    assert.deepStrictEqual(listMachinesEmpty.data.data, [], 'Production /api/machines must not synthesize default machines');

    const statusMissingMachine = await api('GET', '/machine-status?machine_id=CFX-MC-01', undefined, {
      Authorization: `Bearer ${prodAdminToken}`
    });
    assert.strictEqual(statusMissingMachine.status, 404, 'Missing CFX-MC-01 in Production must return 404');
    const getMissingMachine = await api('GET', '/machines/CFX-MC-01', undefined, {
      Authorization: `Bearer ${prodAdminToken}`
    });
    assert.strictEqual(getMissingMachine.status, 404, 'GET /machines/CFX-MC-01 for missing Production machine must return 404');
    assert.strictEqual(
      emptyProdFs.collections.get('machines')?.size ?? 0,
      0,
      'API requests must not auto-create CFX-MC-01..04 in Production Firestore'
    );
    assert.strictEqual(emptyProdFs.machineWriteCount, 0);
    console.log('   PASS: Empty Production Firestore stayed at 0 machines and 0 writes.');

    // -------------------------------------------------------------------------
    // 2. Repeated Production cold-start / API requests do not trigger creation
    // -------------------------------------------------------------------------
    console.log('2. Testing repeated Production requests & cold-start simulations never seed machines...');
    for (let i = 0; i < 3; i++) {
      resetMockDatabaseForColdStartSimulation();
      resetFirestoreSeedStateForTesting();
      await ensureFirestoreSeeded(getDB());
      const globalProdsRes = await api('GET', '/products');
      assert.strictEqual(globalProdsRes.status, 200);
      const missingMachineProdsRes = await api('GET', '/products?machine_id=CFX-MC-01');
      assert.strictEqual(missingMachineProdsRes.status, 404);
      const listRes = await api('GET', '/machines', undefined, {
        Authorization: `Bearer ${prodAdminToken}`
      });
      assert.strictEqual(listRes.status, 200);
      assert.deepStrictEqual(listRes.data.data, []);
    }
    assert.strictEqual(emptyProdFs.machineWriteCount, 0, 'Repeated Production requests must never write machine docs');
    assert.strictEqual(emptyProdFs.collections.get('machines')?.size ?? 0, 0);
    console.log('   PASS: Repeated Production requests triggered 0 machine creations.');

    // -------------------------------------------------------------------------
    // 3. Existing Production machine docs remain completely untouched (including missing kiosk_token)
    // -------------------------------------------------------------------------
    console.log('3. Testing existing Production machine document remains completely untouched & accessible...');
    const partialProdFs = new TrackingMockFirestore();
    seedProdAdmin(partialProdFs, 'prodadmin@caffix.com', 'StrongProdPass#37!');

    const originalInventory = {
      milk_level: 41,
      coffee_level: 33,
      vanilla_level: 19,
      hazelnut_level: 77,
      irish_level: 88,
      mocha_level: 12,
      water_level: 64
    };
    const originalProducts = {
      '1': { price: 199, is_available: false }
    };
    const originalMc01: Record<string, any> = {
      id: 'CFX-MC-01',
      machine_name: 'Real Live Airport Machine',
      location: 'Mumbai Terminal 2 Gate 44',
      desired_mode: 'MAINTENANCE',
      status: 'maintenance',
      last_seen: '2026-10-01T10:20:30.000Z',
      owner_id: 'usr_real_owner_99',
      estimated_inventory: originalInventory,
      inventory_source: 'software_estimated',
      inventory_updated_at: '2026-10-01T10:00:00.000Z',
      products: originalProducts,
      updated_at: '2026-10-01T10:20:30.000Z'
      // Deliberately omit kiosk_token even though KIOSK_SECRET_CFX_MC_01 is set in env
    };
    await partialProdFs.collection('machines').doc('CFX-MC-01').set(originalMc01);
    partialProdFs.writeCount = 0;
    partialProdFs.machineWriteCount = 0;

    setFirestoreForTesting({ firestoreInstance: partialProdFs, initError: null, clearStores: true });
    resetMockDatabaseForColdStartSimulation();
    resetFirestoreSeedStateForTesting();

    await ensureFirestoreSeeded(getDB());
    // Repeat again after clearing seed memoization
    resetMockDatabaseForColdStartSimulation();
    resetFirestoreSeedStateForTesting();
    await ensureFirestoreSeeded(getDB());

    assert.strictEqual(partialProdFs.writeCount, 0, 'Production must not modify existing machine docs (not even kiosk_token merge)');
    assert.strictEqual(partialProdFs.machineWriteCount, 0);
    const partialMachinesMap = partialProdFs.collections.get('machines')!;
    assert.strictEqual(partialMachinesMap.size, 1, 'Only pre-existing CFX-MC-01 may exist; CFX-MC-02..04 must NOT be created');
    assert.strictEqual(partialMachinesMap.has('CFX-MC-02'), false);
    assert.strictEqual(partialMachinesMap.has('CFX-MC-03'), false);
    assert.strictEqual(partialMachinesMap.has('CFX-MC-04'), false);

    const preservedMc01 = partialMachinesMap.get('CFX-MC-01');
    assert.deepStrictEqual(preservedMc01, originalMc01, 'Existing CFX-MC-01 document must be byte-for-byte unchanged');
    assert.strictEqual(preservedMc01.kiosk_token, undefined, 'Missing kiosk_token must NOT be auto-written in Production');

    // Normal read access to existing Production machine works properly
    const existingListRes = await api('GET', '/machines', undefined, {
      Authorization: `Bearer ${prodAdminToken}`
    });
    assert.strictEqual(existingListRes.status, 200);
    assert.strictEqual(existingListRes.data.data.length, 1);
    assert.strictEqual(existingListRes.data.data[0].id, 'CFX-MC-01');
    assert.strictEqual(existingListRes.data.data[0].location, 'Mumbai Terminal 2 Gate 44');
    assert.strictEqual(existingListRes.data.data[0].owner_id, 'usr_real_owner_99');
    assert.strictEqual(existingListRes.data.data[0].desired_mode, 'MAINTENANCE');
    assert.deepStrictEqual(existingListRes.data.data[0].estimated_inventory, originalInventory);

    const existingProductsRes = await api('GET', '/products?machine_id=CFX-MC-01');
    assert.strictEqual(existingProductsRes.status, 200);
    const p1 = existingProductsRes.data.data.find((p: any) => p.id === 1);
    assert.strictEqual(p1.price, 199);
    assert.strictEqual(p1.is_available, false);

    // Kiosk verification against existing Production machine with per-machine env secret still works
    const verifyRes = await api(
      'GET',
      `/kiosk/verify?kiosk=${encodeURIComponent(process.env.KIOSK_SECRET_CFX_MC_01!)}&machine_id=CFX-MC-01`
    );
    assert.strictEqual(verifyRes.status, 200);
    assert.strictEqual(verifyRes.data.machine_id, 'CFX-MC-01');
    assert.ok(verifyRes.data.token);
    console.log('   PASS: Existing Production machine preserved untouched and normal access works.');

    // -------------------------------------------------------------------------
    // 4. Preview/Staging seeding still creates missing machines as expected
    // -------------------------------------------------------------------------
    console.log('4. Testing Preview/Staging seeding still creates missing machines...');
    process.env.VERCEL = '1';
    process.env.VERCEL_ENV = 'preview';
    process.env.FIREBASE_PROJECT_ID = 'caffix-staging';

    const previewFs = new TrackingMockFirestore();
    setFirestoreForTesting({ firestoreInstance: previewFs, initError: null, clearStores: true });
    resetMockDatabaseForColdStartSimulation();
    resetFirestoreSeedStateForTesting();

    await ensureFirestoreSeeded(getDB());
    const previewMachines = previewFs.collections.get('machines');
    assert.ok(previewMachines && previewMachines.size >= 4, 'Preview must still seed configured default machines');
    assert.strictEqual(previewMachines.get('CFX-MC-01')?.location, 'Delhi Airport T3');
    assert.strictEqual(previewMachines.get('CFX-MC-01')?.estimated_inventory?.milk_level, 92);
    assert.ok(previewMachines.has('CFX-MC-02'));
    assert.ok(previewMachines.has('CFX-MC-03'));
    assert.ok(previewMachines.has('CFX-MC-04'));
    assert.ok(previewFs.machineWriteCount >= 4);
    console.log('   PASS: Preview/Staging automatic machine seeding preserved.');

    console.log('\nALL WAVE 3.7 PRODUCTION NO-AUTO-MACHINE-SEEDING TESTS PASSED!\n');
  } finally {
    setFirestoreForTesting({ firestoreInstance: null, initError: null, clearStores: true });
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    resetMockDatabaseForColdStartSimulation();
    server.close();
  }
}

runWave37Tests()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('WAVE 3.7 TESTS FAILED:', err);
    process.exit(1);
  });
