import assert from 'assert';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import http from 'http';

process.env.VERCEL = '1';
process.env.JWT_SECRET =
  process.env.JWT_SECRET || 'caffix-test-wave3-1-hardening-secret-2026';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const app = require('../index').default;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { getDB, initDB, resetMockDatabaseForColdStartSimulation } = require('../config/db');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { setRazorpayClientForTesting } = require('../controllers/orderController');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const {
  setFirestoreForTesting,
  syncMachineToFirebase
} = require('../utils/firebase');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { ensureSecurityConfigReady, getRequiredAdminPasscode } = require('../utils/security');

const PORT = 5092;
const BASE_URL = `http://127.0.0.1:${PORT}/api`;

async function api(
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {}
): Promise<{ status: number; data: any }> {
  const reqHeaders: Record<string, string> = { ...headers };
  if (body !== undefined) {
    reqHeaders['Content-Type'] = 'application/json';
  }
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: reqHeaders,
    body: body !== undefined ? JSON.stringify(body) : undefined
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

class MockFirestore {
  public collections = new Map<string, Map<string, any>>();
  public readCount = 0;
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
            self.readCount++;
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
          self.readCount++;
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
                const docs = match().slice(0, max);
                return { empty: docs.length === 0, docs, forEach: (cb: any) => docs.forEach(cb) };
              }
            };
          },
          async get() {
            const docs = match();
            return { empty: docs.length === 0, docs, forEach: (cb: any) => docs.forEach(cb) };
          }
        };
      },
      async get() {
        self.readCount++;
        const docs: Array<{ id: string; data: () => any }> = [];
        for (const [id, data] of colMap.entries()) {
          docs.push({ id, data: () => JSON.parse(JSON.stringify(data)) });
        }
        return { empty: docs.length === 0, docs, forEach: (cb: any) => docs.forEach(cb) };
      }
    };
  }

  async runTransaction<T>(fn: (tx: any) => Promise<T>): Promise<T> {
    const staged: Array<() => Promise<void>> = [];
    const tx = {
      get: async (ref: any) => await ref.get(),
      set: (ref: any, payload: any, opts?: { merge?: boolean }) => {
        staged.push(() => ref.set(payload, opts));
      }
    };
    const res = await fn(tx);
    for (const apply of staged) {
      await apply();
    }
    return res;
  }
}

const ENV_KEYS = [
  'VERCEL',
  'VERCEL_ENV',
  'NODE_ENV',
  'JWT_SECRET',
  'ADMIN_PASSCODE',
  'KIOSK_ADMIN_ENABLED',
  'KIOSK_SECRET',
  'KIOSK_MACHINE_KEYS',
  'KIOSK_SECRET_CFX_MC_01',
  'KIOSK_SECRET_CFX_MC_02',
  'KIOSK_SECRET_CFX_MC_03',
  'KIOSK_SECRET_CFX_MC_04',
  'ENFORCE_PER_MACHINE_SECRETS',
  'FIREBASE_PROJECT_ID',
  'FIREBASE_CLIENT_EMAIL',
  'FIREBASE_PRIVATE_KEY',
  'PRODUCTION_FIREBASE_PROJECT_ID',
  'STAGING_FIREBASE_PROJECT_ID',
  'FORBIDDEN_FIREBASE_PROJECT_ID',
  'RAZORPAY_KEY_ID',
  'RAZORPAY_KEY_SECRET',
  'RAZORPAY_WEBHOOK_SECRET'
];

function snapshotEnv(): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const k of ENV_KEYS) {
    out[k] = process.env[k];
  }
  return out;
}

function restoreEnv(snap: Record<string, string | undefined>): void {
  for (const k of ENV_KEYS) {
    if (snap[k] === undefined) delete process.env[k];
    else process.env[k] = snap[k];
  }
}

function seedProdSuperAdmin(fs: MockFirestore, email: string, password: string): void {
  const users = new Map<string, any>();
  users.set('usr_prod_admin_1', {
    id: 'usr_prod_admin_1',
    name: 'Prod Super Admin',
    email,
    password: bcrypt.hashSync(password, 10),
    role: 'admin',
    setup_token_hash: null,
    setup_token_expires_at: null,
    must_change_password: 0,
    updated_at: new Date().toISOString()
  });
  fs.collections.set('users', users);
}

async function seedProdMachines(fs: MockFirestore, machineTokens: Record<string, string>): Promise<void> {
  const nowIso = new Date().toISOString();
  for (const [id, token] of Object.entries(machineTokens)) {
    await fs.collection('machines').doc(id).set({
      id,
      machine_name: `Production Kiosk ${id}`,
      location: 'Production Terminal',
      desired_mode: 'RUNNING',
      status: 'online',
      last_seen: null,
      owner_id: null,
      kiosk_token: token,
      estimated_inventory: {
        milk_level: 100,
        coffee_level: 100,
        vanilla_level: 100,
        hazelnut_level: 100,
        irish_level: 100,
        mocha_level: 100,
        water_level: 100
      },
      inventory_source: 'software_estimated',
      inventory_updated_at: nowIso,
      products: {},
      updated_at: nowIso
    });
  }
}

async function runWave31Tests() {
  console.log('\n=============================================================');
  console.log('Running Wave 3.1 Production Security & Reliability Tests');
  console.log('=============================================================\n');

  const initialEnv = snapshotEnv();
  await initDB();

  const server: http.Server = await new Promise((resolve) => {
    const s = app.listen(PORT, '127.0.0.1', () => resolve(s));
  });

  try {
    // -------------------------------------------------------------------------
    // 1. Firebase Production & Preview Project-ID Isolation Guards
    // -------------------------------------------------------------------------
    console.log('1. Testing Firebase Production & Preview project-ID isolation...');
    const guardFs = new MockFirestore();
    seedProdSuperAdmin(guardFs, 'superadmin@caffix.com', 'StrongProdPass#2026!');
    setFirestoreForTesting({ firestoreInstance: guardFs, initError: null, clearStores: true });

    process.env.VERCEL = '1';
    process.env.FIREBASE_CLIENT_EMAIL = 'firebase-adminsdk@caffix-vending.iam.gserviceaccount.com';
    process.env.FIREBASE_PRIVATE_KEY = '-----BEGIN PRIVATE KEY-----\nTEST\n-----END PRIVATE KEY-----';
    delete process.env.PRODUCTION_FIREBASE_PROJECT_ID;
    delete process.env.STAGING_FIREBASE_PROJECT_ID;
    delete process.env.FORBIDDEN_FIREBASE_PROJECT_ID;

    // 1A. Production rejects missing, staging, or mismatched project IDs with 503 and 0 reads/writes
    process.env.VERCEL_ENV = 'production';
    for (const badId of ['', 'caffix-staging', 'vendingcaffix-other', 'caffix-prod']) {
      if (badId) process.env.FIREBASE_PROJECT_ID = badId;
      else delete process.env.FIREBASE_PROJECT_ID;
      const beforeReads = guardFs.readCount;
      const beforeWrites = guardFs.writeCount;
      const res = await api('GET', '/products');
      assert.strictEqual(res.status, 503, `VERCEL_ENV=production must reject FIREBASE_PROJECT_ID="${badId}" with 503, got ${res.status}`);
      assert.strictEqual(guardFs.readCount, beforeReads);
      assert.strictEqual(guardFs.writeCount, beforeWrites);
    }

    // Conflicting PRODUCTION_FIREBASE_PROJECT_ID override in Production -> 503
    process.env.FIREBASE_PROJECT_ID = 'caffix-vending';
    process.env.PRODUCTION_FIREBASE_PROJECT_ID = 'wrong-project';
    assert.strictEqual((await api('GET', '/products')).status, 503);
    delete process.env.PRODUCTION_FIREBASE_PROJECT_ID;

    // Production accepts ONLY FIREBASE_PROJECT_ID=caffix-vending
    process.env.FIREBASE_PROJECT_ID = 'caffix-vending';
    assert.strictEqual((await api('GET', '/products')).status, 200);

    // 1B. Preview rejects missing, production, or mismatched project IDs with 503 and 0 reads/writes
    process.env.VERCEL_ENV = 'preview';
    for (const badPreviewId of ['', 'caffix-vending', 'caffix-staging-2', 'dev-project']) {
      if (badPreviewId) process.env.FIREBASE_PROJECT_ID = badPreviewId;
      else delete process.env.FIREBASE_PROJECT_ID;
      const beforeReads = guardFs.readCount;
      const beforeWrites = guardFs.writeCount;
      const res = await api('GET', '/products');
      assert.strictEqual(res.status, 503, `VERCEL_ENV=preview must reject FIREBASE_PROJECT_ID="${badPreviewId}" with 503, got ${res.status}`);
      assert.strictEqual(guardFs.readCount, beforeReads);
      assert.strictEqual(guardFs.writeCount, beforeWrites);
    }

    // Conflicting STAGING_FIREBASE_PROJECT_ID override in Preview -> 503
    process.env.FIREBASE_PROJECT_ID = 'caffix-staging';
    process.env.STAGING_FIREBASE_PROJECT_ID = 'other-staging';
    assert.strictEqual((await api('GET', '/products')).status, 503);
    delete process.env.STAGING_FIREBASE_PROJECT_ID;

    // Preview accepts ONLY FIREBASE_PROJECT_ID=caffix-staging
    process.env.FIREBASE_PROJECT_ID = 'caffix-staging';
    assert.strictEqual((await api('GET', '/products')).status, 200);
    console.log('   PASS: Firebase Production/Preview project isolation verified.');

    // -------------------------------------------------------------------------
    // 2. Kiosk Secret Hardening & Per-Machine Token Isolation
    // -------------------------------------------------------------------------
    console.log('2. Testing Kiosk secret hardening & CFX-MC-01..04 token isolation...');
    process.env.VERCEL_ENV = 'production';
    process.env.FIREBASE_PROJECT_ID = 'caffix-vending';
    resetMockDatabaseForColdStartSimulation();
    setFirestoreForTesting({ firestoreInstance: guardFs, initError: null, clearStores: true });

    // 2A. When NO KIOSK_SECRET and NO per-machine tokens exist in Production -> 503
    delete process.env.KIOSK_SECRET;
    delete process.env.KIOSK_MACHINE_KEYS;
    delete process.env.KIOSK_SECRET_CFX_MC_01;
    delete process.env.KIOSK_SECRET_CFX_MC_02;
    delete process.env.KIOSK_SECRET_CFX_MC_03;
    delete process.env.KIOSK_SECRET_CFX_MC_04;
    const noKioskConfigRes = await api('GET', '/kiosk/verify?kiosk=Kx8P2mL9Qv4Rz7Tn5Yh1&machine_id=CFX-MC-01');
    assert.strictEqual(
      noKioskConfigRes.status,
      503,
      `Expected 503 when no kiosk credentials are configured in Production, got ${noKioskConfigRes.status}`
    );

    // 2B. Configure per-machine tokens for CFX-MC-01..04 (plus a non-mock KIOSK_SECRET)
    const machineTokens: Record<string, string> = {
      'CFX-MC-01': 'tok_mc01_live_9f8e7d6c5b4a',
      'CFX-MC-02': 'tok_mc02_live_1a2b3c4d5e6f',
      'CFX-MC-03': 'tok_mc03_live_7g8h9i0j1k2l',
      'CFX-MC-04': 'tok_mc04_live_3m4n5o6p7q8r'
    };
    process.env.KIOSK_SECRET_CFX_MC_01 = machineTokens['CFX-MC-01'];
    process.env.KIOSK_SECRET_CFX_MC_02 = machineTokens['CFX-MC-02'];
    process.env.KIOSK_SECRET_CFX_MC_03 = machineTokens['CFX-MC-03'];
    process.env.KIOSK_SECRET_CFX_MC_04 = machineTokens['CFX-MC-04'];
    process.env.ENFORCE_PER_MACHINE_SECRETS = 'true';
    await seedProdMachines(guardFs, machineTokens);
    setFirestoreForTesting({ firestoreInstance: guardFs, initError: null, clearStores: true });

    // Removed hardcoded fallback & legacy 'CFX-MC-01' bypass MUST fail with 401
    assert.strictEqual(
      (await api('GET', '/kiosk/verify?kiosk=Kx8P2mL9Qv4Rz7Tn5Yh1&machine_id=CFX-MC-01')).status,
      401,
      'Removed hardcoded KIOSK_SECRET fallback must return 401'
    );
    assert.strictEqual(
      (await api('GET', '/kiosk/verify?kiosk=CFX-MC-01&machine_id=CFX-MC-01')).status,
      401,
      'Legacy CFX-MC-01 literal bypass must return 401'
    );
    assert.strictEqual(
      (await api('GET', '/kiosk/verify?machine_id=CFX-MC-01')).status,
      401,
      'Missing kiosk credential must return 401'
    );

    // Each machine succeeds with its own token, and ALL cross-machine token combinations fail (401)
    const issuedTokens: Record<string, string> = {};
    for (const targetMachine of Object.keys(machineTokens)) {
      const okRes = await api(
        'GET',
        `/kiosk/verify?kiosk=${encodeURIComponent(machineTokens[targetMachine])}&machine_id=${targetMachine}`
      );
      assert.strictEqual(okRes.status, 200, `${targetMachine} should verify with its own token`);
      assert.strictEqual(okRes.data.machine_id, targetMachine);
      assert.ok(okRes.data.token);
      issuedTokens[targetMachine] = okRes.data.token;

      for (const otherMachine of Object.keys(machineTokens)) {
        if (otherMachine === targetMachine) continue;
        const crossRes = await api(
          'GET',
          `/kiosk/verify?kiosk=${encodeURIComponent(machineTokens[otherMachine])}&machine_id=${targetMachine}`
        );
        assert.strictEqual(
          crossRes.status,
          401,
          `${targetMachine} MUST reject ${otherMachine}'s token`
        );
      }
    }

    // Machine JWT remains isolated from technician kiosk-admin and dashboard admin routes
    assert.strictEqual(
      (await api('GET', '/auth/me?portal=admin', undefined, { Authorization: `Bearer ${issuedTokens['CFX-MC-01']}` })).status,
      403
    );
    assert.strictEqual(
      (await api('GET', '/machines', undefined, { Authorization: `Bearer ${issuedTokens['CFX-MC-01']}` })).status,
      403
    );
    console.log('   PASS: Hardcoded fallback & legacy bypass removed; CFX-MC-01..04 tokens isolated.');

    // -------------------------------------------------------------------------
    // 3. Razorpay Production Fail-Closed Protection
    // -------------------------------------------------------------------------
    console.log('3. Testing Razorpay Production fail-closed protection & webhook HMAC...');
    const mc1Token = issuedTokens['CFX-MC-01'];

    // 3A. Missing / mock RAZORPAY_KEY_ID or RAZORPAY_KEY_SECRET in Production -> 503
    delete process.env.RAZORPAY_KEY_ID;
    delete process.env.RAZORPAY_KEY_SECRET;
    delete process.env.RAZORPAY_WEBHOOK_SECRET;
    assert.strictEqual(
      (await api('POST', '/orders/create', { product_id: 1, machine_id: 'CFX-MC-01', amount: 100 }, { Authorization: `Bearer ${mc1Token}` })).status,
      503,
      'Order creation in Production without Razorpay keys must return 503'
    );

    process.env.RAZORPAY_KEY_ID = 'rzp_live_mock_key';
    process.env.RAZORPAY_KEY_SECRET = 'mockSecret987654321';
    assert.strictEqual(
      (await api('POST', '/orders/create', { product_id: 1, machine_id: 'CFX-MC-01', amount: 100 }, { Authorization: `Bearer ${mc1Token}` })).status,
      503,
      'Order creation in Production with mock Razorpay keys must return 503'
    );

    // Missing/mock RAZORPAY_KEY_SECRET on /payments/verify -> 503
    assert.strictEqual(
      (
        await api(
          'POST',
          '/payments/verify',
          {
            order_id: 'CFX-12345678',
            razorpay_order_id: 'order_live_123',
            razorpay_payment_id: 'pay_live_123',
            razorpay_signature: 'deadbeef'
          },
          { Authorization: `Bearer ${mc1Token}` }
        )
      ).status,
      503,
      '/payments/verify in Production with mock RAZORPAY_KEY_SECRET must return 503'
    );

    // Missing/mock RAZORPAY_WEBHOOK_SECRET on /payments/webhook -> 503
    assert.strictEqual(
      (await api('POST', '/payments/webhook', { event: 'order.paid' })).status,
      503,
      '/payments/webhook in Production without RAZORPAY_WEBHOOK_SECRET must return 503'
    );
    process.env.RAZORPAY_WEBHOOK_SECRET = 'mockWebhookSecret112233';
    assert.strictEqual(
      (await api('POST', '/payments/webhook', { event: 'order.paid' })).status,
      503,
      '/payments/webhook in Production with mock secret must return 503'
    );

    // 3B. Valid Production Razorpay config (with local mocked Razorpay SDK client)
    const prodKeyId = 'rzp_live_w31_test_pub';
    const prodKeySecret = 'live_key_sec_9c8b7a6f5e4d3c2b1a';
    const prodWebhookSecret = 'live_wh_sec_1z2y3x4w5v6u7t8s9r';
    process.env.RAZORPAY_KEY_ID = prodKeyId;
    process.env.RAZORPAY_KEY_SECRET = prodKeySecret;
    process.env.RAZORPAY_WEBHOOK_SECRET = prodWebhookSecret;

    setRazorpayClientForTesting({
      orders: {
        create: async (opts: any) => ({
          id: `order_live_${opts.receipt.replace(/[^A-Za-z0-9]/g, '')}`
        })
      }
    });

    const createOrderRes = await api(
      'POST',
      '/orders/create',
      { product_id: 1, machine_id: 'CFX-MC-01', amount: 100 },
      { Authorization: `Bearer ${mc1Token}` }
    );
    assert.strictEqual(createOrderRes.status, 201, `Expected 201 for live-configured order, got ${JSON.stringify(createOrderRes.data)}`);
    const liveOrder = createOrderRes.data.data;
    assert.ok(liveOrder.razorpay_order_id.startsWith('order_live_'));
    assert.strictEqual(liveOrder.razorpay_key, prodKeyId);
    assert.ok(!JSON.stringify(createOrderRes.data).includes(prodKeySecret));
    assert.ok(!JSON.stringify(createOrderRes.data).includes(prodWebhookSecret));

    // Reject order_mock_* in Production payment verification -> 400
    assert.strictEqual(
      (
        await api(
          'POST',
          '/payments/verify',
          {
            order_id: liveOrder.id,
            razorpay_order_id: 'order_mock_forged',
            razorpay_payment_id: 'pay_live_1',
            razorpay_signature: 'mock'
          },
          { Authorization: `Bearer ${mc1Token}` }
        )
      ).status,
      400
    );

    // Reject invalid signature -> 400
    assert.strictEqual(
      (
        await api(
          'POST',
          '/payments/verify',
          {
            order_id: liveOrder.id,
            razorpay_order_id: liveOrder.razorpay_order_id,
            razorpay_payment_id: 'pay_live_1',
            razorpay_signature: 'invalid_sig_hex'
          },
          { Authorization: `Bearer ${mc1Token}` }
        )
      ).status,
      400
    );

    // Valid HMAC signature -> 200 PAID, and idempotent on repeat
    const validPayId = 'pay_live_w31_001';
    const validSig = crypto
      .createHmac('sha256', prodKeySecret)
      .update(`${liveOrder.razorpay_order_id}|${validPayId}`)
      .digest('hex');

    const verifyOkRes = await api(
      'POST',
      '/payments/verify',
      {
        order_id: liveOrder.id,
        razorpay_order_id: liveOrder.razorpay_order_id,
        razorpay_payment_id: validPayId,
        razorpay_signature: validSig
      },
      { Authorization: `Bearer ${mc1Token}` }
    );
    assert.strictEqual(verifyOkRes.status, 200);
    assert.strictEqual(verifyOkRes.data.data.status, 'PAID');

    const verifyIdempotentRes = await api(
      'POST',
      '/payments/verify',
      {
        order_id: liveOrder.id,
        razorpay_order_id: liveOrder.razorpay_order_id,
        razorpay_payment_id: validPayId,
        razorpay_signature: validSig
      },
      { Authorization: `Bearer ${mc1Token}` }
    );
    assert.strictEqual(verifyIdempotentRes.status, 200);
    assert.strictEqual(verifyIdempotentRes.data.data.status, 'PAID');

    // Webhook tests on a second PENDING order
    const createOrder2Res = await api(
      'POST',
      '/orders/create',
      { product_id: 2, machine_id: 'CFX-MC-01', amount: 100 },
      { Authorization: `Bearer ${mc1Token}` }
    );
    assert.strictEqual(createOrder2Res.status, 201);
    const liveOrder2 = createOrder2Res.data.data;
    const webhookBody = {
      event: 'payment.captured',
      payload: {
        payment: {
          entity: {
            id: 'pay_live_wh_002',
            order_id: liveOrder2.razorpay_order_id
          }
        }
      }
    };

    // Missing, 'mock', and wrong webhook signatures -> 400
    assert.strictEqual((await api('POST', '/payments/webhook', webhookBody)).status, 400);
    assert.strictEqual(
      (await api('POST', '/payments/webhook', webhookBody, { 'x-razorpay-signature': 'mock' })).status,
      400
    );
    assert.strictEqual(
      (await api('POST', '/payments/webhook', webhookBody, { 'x-razorpay-signature': 'deadbeef' })).status,
      400
    );

    // Valid webhook HMAC -> 200 & transitions order to PAID
    const validWhSig = crypto
      .createHmac('sha256', prodWebhookSecret)
      .update(JSON.stringify(webhookBody))
      .digest('hex');
    const validWhRes = await api('POST', '/payments/webhook', webhookBody, {
      'x-razorpay-signature': validWhSig
    });
    assert.strictEqual(validWhRes.status, 200);
    const afterWhOrder = await api('GET', `/orders/${liveOrder2.id}`, undefined, {
      Authorization: `Bearer ${mc1Token}`
    });
    assert.strictEqual(afterWhOrder.data.data.status, 'PAID');
    setRazorpayClientForTesting(null);
    console.log('   PASS: Razorpay fail-closed & webhook HMAC protection verified.');

    // -------------------------------------------------------------------------
    // 4. Machine Registration Reliability (Firestore duplicate, conflict 409, concurrency)
    // -------------------------------------------------------------------------
    console.log('4. Testing Machine registration duplicate & concurrency protection...');
    const adminLoginRes = await api('POST', '/auth/login', {
      email: 'superadmin@caffix.com',
      password: 'StrongProdPass#2026!',
      portal: 'admin'
    });
    assert.strictEqual(adminLoginRes.status, 200);
    const adminToken = adminLoginRes.data.token;

    // 4A. Seed a machine directly in Firestore ONLY (simulating remote machine unseen in local DB cache)
    const remoteOnlyId = 'CFX-MC-88';
    await syncMachineToFirebase({
      id: remoteOnlyId,
      machine_name: 'Existing Remote Kiosk',
      location: 'Existing Terminal',
      desired_mode: 'MAINTENANCE',
      owner_id: 'usr_existing_owner',
      kiosk_token: 'existing_remote_token_88'
    });
    // Ensure local DB does NOT have CFX-MC-88 yet
    const db = getDB();
    await db.run('DELETE FROM machines WHERE id = ?', [remoteOnlyId]);

    const dupRemoteRes = await api(
      'POST',
      '/machines/register',
      { id: remoteOnlyId, machine_name: 'Overwrite Attempt', location: 'Fake Loc' },
      { Authorization: `Bearer ${adminToken}` }
    );
    assert.strictEqual(dupRemoteRes.status, 409, `Expected 409 Conflict for remote existing machine, got ${dupRemoteRes.status}`);

    const preservedDoc = guardFs.collections.get('machines')?.get(remoteOnlyId);
    assert.strictEqual(preservedDoc.machine_name, 'Existing Remote Kiosk');
    assert.strictEqual(preservedDoc.owner_id, 'usr_existing_owner');
    assert.strictEqual(preservedDoc.desired_mode, 'MAINTENANCE');

    // 4B. Concurrent registration attempts for same new machine ID -> one 201, one 409
    const concurrentId = 'CFX-MC-89';
    const [r1, r2] = await Promise.all([
      api(
        'POST',
        '/machines/register',
        { id: concurrentId, machine_name: 'Concurrent One', location: 'Loc 1' },
        { Authorization: `Bearer ${adminToken}` }
      ),
      api(
        'POST',
        '/machines/register',
        { id: concurrentId, machine_name: 'Concurrent Two', location: 'Loc 2' },
        { Authorization: `Bearer ${adminToken}` }
      )
    ]);
    const statuses = [r1.status, r2.status].sort();
    assert.deepStrictEqual(statuses, [201, 409], `Expected [201, 409] for concurrent register, got ${JSON.stringify(statuses)}`);

    // Subsequent duplicate attempt also returns 409
    const dupAgainRes = await api(
      'POST',
      '/machines/register',
      { id: concurrentId, machine_name: 'Third Try', location: 'Loc 3' },
      { Authorization: `Bearer ${adminToken}` }
    );
    assert.strictEqual(dupAgainRes.status, 409);
    console.log('   PASS: Duplicate and concurrent machine registration protection verified.');

    // -------------------------------------------------------------------------
    // 5. Security Config Validation (JWT_SECRET + conditional ADMIN_PASSCODE)
    // -------------------------------------------------------------------------
    console.log('5. Testing startup security config validation & optional kiosk-admin...');
    process.env.VERCEL = '1';
    process.env.VERCEL_ENV = 'production';
    process.env.JWT_SECRET = 'valid_prod_jwt_secret_w31_strong';

    const verifyForSecCheck = await api(
      'GET',
      `/kiosk/verify?kiosk=${encodeURIComponent(machineTokens['CFX-MC-01'])}&machine_id=CFX-MC-01`
    );
    assert.strictEqual(verifyForSecCheck.status, 200);
    const mc1Token5 = verifyForSecCheck.data.token;

    // Disabled / unconfigured optional technician unlock does NOT fail startup
    delete process.env.ADMIN_PASSCODE;
    delete process.env.KIOSK_ADMIN_ENABLED;
    ensureSecurityConfigReady(); // must not throw
    assert.strictEqual((await api('GET', '/products')).status, 200);
    // Calling /auth/kiosk-admin when disabled still returns 503
    assert.strictEqual(
      (
        await api(
          'POST',
          '/auth/kiosk-admin',
          { passcode: 'SomePass#2026', machine_id: 'CFX-MC-01' },
          { Authorization: `Bearer ${mc1Token5}` }
        )
      ).status,
      503
    );

    // Enabled technician unlock with missing or weak ADMIN_PASSCODE MUST fail at startup
    process.env.KIOSK_ADMIN_ENABLED = 'true';
    delete process.env.ADMIN_PASSCODE;
    assert.throws(() => ensureSecurityConfigReady(), /ADMIN_PASSCODE/);

    for (const weakPin of ['1234', '0000', '123456', '12345']) {
      process.env.ADMIN_PASSCODE = weakPin;
      assert.throws(() => ensureSecurityConfigReady(), /minimum security requirements/);
      assert.throws(() => getRequiredAdminPasscode(), /minimum security requirements/);
    }

    // Explicitly disabled (KIOSK_ADMIN_ENABLED=false) allows startup even without ADMIN_PASSCODE, while blocking endpoint
    process.env.KIOSK_ADMIN_ENABLED = 'false';
    delete process.env.ADMIN_PASSCODE;
    ensureSecurityConfigReady();
    assert.throws(() => getRequiredAdminPasscode(), /disabled/);

    // Missing JWT_SECRET always fails startup
    const savedJwt = process.env.JWT_SECRET;
    delete process.env.JWT_SECRET;
    assert.throws(() => ensureSecurityConfigReady(), /JWT_SECRET/);
    process.env.JWT_SECRET = savedJwt;

    // Valid ADMIN_PASSCODE with KIOSK_ADMIN_ENABLED=true succeeds at startup & endpoint
    process.env.KIOSK_ADMIN_ENABLED = 'true';
    process.env.ADMIN_PASSCODE = 'StrongTechUnlock#2026';
    ensureSecurityConfigReady();
    const techUnlockRes = await api(
      'POST',
      '/auth/kiosk-admin',
      { passcode: 'StrongTechUnlock#2026', machine_id: 'CFX-MC-01' },
      { Authorization: `Bearer ${mc1Token5}` }
    );
    assert.strictEqual(techUnlockRes.status, 200);
    console.log('   PASS: Startup security configuration validation verified.');

    console.log('\nALL WAVE 3.1 PRODUCTION HARDENING TESTS PASSED SUCCESSFULLY!\n');
  } finally {
    setRazorpayClientForTesting(null);
    setFirestoreForTesting({ firestoreInstance: null, initError: null, clearStores: true });
    restoreEnv(initialEnv);
    resetMockDatabaseForColdStartSimulation();
    server.close();
  }
}

runWave31Tests()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('WAVE 3.1 PRODUCTION HARDENING TESTS FAILED:', err);
    process.exit(1);
  });
