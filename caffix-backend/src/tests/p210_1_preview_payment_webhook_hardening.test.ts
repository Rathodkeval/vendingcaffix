import assert from 'assert';
import crypto from 'crypto';
import http from 'http';
import { AddressInfo } from 'net';

// Keep non-Firebase local initialization before importing modules, then restore carefully per test case
const INITIAL_ENV: Record<string, string | undefined> = { ...process.env };
process.env.JWT_SECRET =
  process.env.JWT_SECRET || 'caffix-p210-1-hardening-test-jwt-secret-2026';
delete process.env.FIRESTORE_EMULATOR_HOST;

// eslint-disable-next-line @typescript-eslint/no-var-requires
const app = require('../index').default;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { initDB, getDB, resetMockDatabaseForColdStartSimulation } = require('../config/db');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { setFirestoreForTesting } = require('../utils/firebase');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { setRazorpayClientForTesting, resolveRazorpayOrderConfig } = require('../controllers/orderController');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { setRazorpayRefundClientForTesting, executeGatewayRefund, resolveRazorpayRefundConfig } = require('../utils/razorpayRefundClient');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { resolveValidatedRazorpayEnvironment } = require('../utils/security');

class FakeFirestore {
  public collections = new Map<string, Map<string, any>>();

  private getCol(name: string): Map<string, any> {
    let col = this.collections.get(name);
    if (!col) {
      col = new Map<string, any>();
      this.collections.set(name, col);
    }
    return col;
  }

  private clone<T>(val: T): T {
    return val === undefined ? val : JSON.parse(JSON.stringify(val));
  }

  private applyPatch(existing: Record<string, any> | undefined, payload: Record<string, any>) {
    const base: Record<string, any> = existing ? { ...this.clone(existing) } : {};
    for (const [key, val] of Object.entries(payload)) {
      if (key.includes('.')) {
        const parts = key.split('.');
        let cursor: Record<string, any> = base;
        for (let i = 0; i < parts.length - 1; i++) {
          if (!cursor[parts[i]] || typeof cursor[parts[i]] !== 'object') {
            cursor[parts[i]] = {};
          }
          cursor = cursor[parts[i]];
        }
        cursor[parts[parts.length - 1]] = this.clone(val);
      } else {
        base[key] = this.clone(val);
      }
    }
    return base;
  }

  collection(colName: string) {
    const self = this;
    const colMap = this.getCol(colName);

    const makeDocRef = (docId: string) => {
      const normalizedId = String(docId);
      return {
        id: normalizedId,
        _colName: colName,
        collection(subColName: string) {
          return self.collection(`${colName}/${normalizedId}/${subColName}`);
        },
        async get() {
          const hasDoc = colMap.has(normalizedId);
          const dataVal = hasDoc ? self.clone(colMap.get(normalizedId)) : undefined;
          return {
            id: normalizedId,
            exists: hasDoc,
            data: () => self.clone(dataVal)
          };
        },
        async set(payload: any, opts?: { merge?: boolean }) {
          if (opts?.merge) {
            colMap.set(normalizedId, self.applyPatch(colMap.get(normalizedId), payload));
          } else {
            colMap.set(normalizedId, self.clone(payload));
          }
        },
        async create(payload: any) {
          if (colMap.has(normalizedId)) {
            const err: any = new Error(`Document ${colName}/${normalizedId} already exists`);
            err.code = 6;
            throw err;
          }
          colMap.set(normalizedId, self.clone(payload));
        },
        async update(payload: any) {
          if (!colMap.has(normalizedId)) {
            const err: any = new Error(`Document ${colName}/${normalizedId} not found`);
            err.code = 5;
            throw err;
          }
          colMap.set(normalizedId, self.applyPatch(colMap.get(normalizedId), payload));
        },
        async delete() {
          colMap.delete(normalizedId);
        }
      };
    };

    const makeQuery = (filters: Array<{ field: string; op: string; value: any }>, maxLimit?: number) => ({
      where(field: string, op: string, value: any) {
        return makeQuery([...filters, { field, op, value }], maxLimit);
      },
      limit(n: number) {
        return makeQuery(filters, n);
      },
      async get() {
        let docs: Array<{ id: string; ref: any; data: () => any }> = [];
        for (const [id, raw] of colMap.entries()) {
          const matches = filters.every(({ field, op, value }) => {
            const actual = raw?.[field];
            if (op === '==') return actual === value;
            if (op === 'in' && Array.isArray(value)) return value.includes(actual);
            return false;
          });
          if (matches) {
            const snapshotData = self.clone(raw);
            docs.push({
              id,
              ref: makeDocRef(id),
              data: () => self.clone(snapshotData)
            });
          }
        }
        if (typeof maxLimit === 'number') {
          docs = docs.slice(0, maxLimit);
        }
        return {
          empty: docs.length === 0,
          size: docs.length,
          docs,
          forEach: (cb: (d: { id: string; ref: any; data: () => any }) => void) => docs.forEach(cb)
        };
      }
    });

    return {
      doc: makeDocRef,
      where(field: string, op: string, value: any) {
        return makeQuery([{ field, op, value }]);
      },
      async get() {
        return makeQuery([]).get();
      }
    };
  }

  batch() {
    const ops: Array<() => Promise<void>> = [];
    return {
      set(docRef: any, payload: any, opts?: { merge?: boolean }) {
        ops.push(() => docRef.set(payload, opts));
      },
      update(docRef: any, payload: any) {
        ops.push(() => docRef.update(payload));
      },
      delete(docRef: any) {
        ops.push(() => docRef.delete());
      },
      async commit() {
        for (const op of ops) {
          await op();
        }
      }
    };
  }

  async runTransaction<T>(fn: (tx: any) => Promise<T>): Promise<T> {
    const staged: Array<() => Promise<void>> = [];
    const tx = {
      get: async (refOrQuery: any) => refOrQuery.get(),
      set: (docRef: any, payload: any, opts?: { merge?: boolean }) => {
        staged.push(() => docRef.set(payload, opts));
      },
      create: (docRef: any, payload: any) => {
        staged.push(() => docRef.create(payload));
      },
      update: (docRef: any, payload: any) => {
        staged.push(() => docRef.update(payload));
      },
      delete: (docRef: any) => {
        staged.push(() => docRef.delete());
      }
    };
    const result = await fn(tx);
    for (const op of staged) {
      await op();
    }
    return result;
  }
}

function restoreEnv(snapshot: Record<string, string | undefined>) {
  for (const key of Object.keys(process.env)) {
    if (!(key in snapshot)) {
      delete process.env[key];
    }
  }
  for (const [key, val] of Object.entries(snapshot)) {
    if (val === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = val;
    }
  }
}

async function withEnv(
  overrides: Record<string, string | undefined>,
  fn: () => Promise<void>
): Promise<void> {
  const before: Record<string, string | undefined> = { ...process.env };
  try {
    for (const [k, v] of Object.entries(overrides)) {
      if (v === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = v;
      }
    }
    await fn();
  } finally {
    restoreEnv(before);
  }
}

async function runP2101Tests() {
  await initDB();
  const fs = new FakeFirestore();
  setFirestoreForTesting({ firestoreInstance: fs, initError: null, clearStores: true });

  // Seed admin user, machine, product, and machine product override cleanly in both SQLite & FakeFirestore
  const db = await getDB();
  await fs.collection('products').doc('1').set({
    id: 1,
    name: 'Classic Espresso',
    category: 'Coffee',
    price: 100,
    is_available: true
  });
  await fs.collection('machines').doc('CFX-MC-01').set({
    id: 'CFX-MC-01',
    machine_id: 'CFX-MC-01',
    name: 'Test Machine',
    location: 'Lab',
    kiosk_token: 'kiosk-secret-p210-1',
    desired_mode: 'RUNNING',
    stock: {
      coffee_beans_g: 5000,
      milk_ml: 5000,
      sugar_g: 5000,
      cups_count: 200
    },
    products: {
      '1': { price: 100, is_available: true }
    }
  });
  await db.run(
    `UPDATE machines SET kiosk_token = 'kiosk-secret-p210-1' WHERE id = 'CFX-MC-01'`
  );

  // Start ephemeral HTTP server on port 0
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as AddressInfo).port;
  const baseUrl = `http://127.0.0.1:${port}`;

  async function api(
    method: string,
    path: string,
    body?: any,
    headers: Record<string, string> = {}
  ): Promise<{ status: number; data: any }> {
    const reqHeaders: Record<string, string> = { ...headers };
    let payload: string | undefined;
    if (body !== undefined) {
      if (typeof body === 'string') {
        payload = body;
      } else {
        reqHeaders['Content-Type'] = 'application/json';
        payload = JSON.stringify(body);
      }
    }
    const res = await fetch(`${baseUrl}${path}`, { method, headers: reqHeaders, body: payload });
    const text = await res.text();
    let parsed: any = text;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = text;
    }
    return { status: res.status, data: parsed };
  }

  // Acquire tokens in local setup
  const kioskRes = await api(
    'GET',
    '/api/kiosk/verify?machine_id=CFX-MC-01&kiosk=kiosk-secret-p210-1'
  );
  assert.strictEqual(kioskRes.status, 200, `Kiosk auth setup failed: ${JSON.stringify(kioskRes.data)}`);
  const kioskToken: string = kioskRes.data.token;

  const loginRes = await api('POST', '/api/auth/login', {
    email: 'admin@caffix.com',
    password: process.env.DEFAULT_ADMIN_PASSWORD || 'admin123'
  });
  assert.strictEqual(loginRes.status, 200, `Admin auth setup failed: ${JSON.stringify(loginRes.data)}`);
  const adminToken: string = loginRes.data.token;

  // Seed a paid real-format order + pending real-format order for negative verification & refund tests
  const pendingOrderId = 'CFX-P210-PENDING-1';
  const pendingRpOrderId = 'order_test_pending_p210_1';
  await fs.collection('orders').doc(pendingOrderId).set({
    id: pendingOrderId,
    product_id: 1,
    product_name: 'Classic Espresso',
    machine_id: 'CFX-MC-01',
    amount: 100,
    status: 'PENDING',
    dispense_status: 'PENDING',
    dispensed: false,
    razorpay_order_id: pendingRpOrderId,
    razorpay_payment_id: null,
    created_at: new Date().toISOString()
  });

  const paidOrderForRefundId = 'CFX-P210-PAID-REAL-1';
  await fs.collection('orders').doc(paidOrderForRefundId).set({
    id: paidOrderForRefundId,
    product_id: 1,
    product_name: 'Classic Espresso',
    machine_id: 'CFX-MC-01',
    amount: 100,
    captured_amount_paise: 10000,
    status: 'COMPLETED',
    dispense_status: 'FAILED',
    dispensed: false,
    razorpay_order_id: 'order_test_paid_p210_1',
    razorpay_payment_id: 'pay_test_real_refund_eligible_1',
    created_at: new Date().toISOString()
  });

  const paidMockOrderForRefundId = 'CFX-P210-PAID-MOCK-1';
  await fs.collection('orders').doc(paidMockOrderForRefundId).set({
    id: paidMockOrderForRefundId,
    product_id: 1,
    product_name: 'Classic Espresso',
    machine_id: 'CFX-MC-01',
    amount: 100,
    captured_amount_paise: 10000,
    status: 'COMPLETED',
    dispense_status: 'FAILED',
    dispensed: false,
    razorpay_order_id: 'order_mock_paid_p210_2',
    razorpay_payment_id: 'pay_mock_forbidden_999',
    created_at: new Date().toISOString()
  });

  const basePreviewFirebase = {
    VERCEL: '1',
    VERCEL_ENV: 'preview',
    NODE_ENV: 'production',
    FIREBASE_PROJECT_ID: 'caffix-staging',
    FIREBASE_CLIENT_EMAIL: 'firebase-adminsdk@caffix-staging.iam.gserviceaccount.com',
    FIREBASE_PRIVATE_KEY: 'staging-synthetic-nonmock-key-value'
  };

  try {
    console.log('\n=== CAFFIX Phase 2.10.1 Preview Payment & Webhook Hardening Tests ===');

    // -------------------------------------------------------------------------
    // 1–5. Preview fail-closed on missing / partial / mock / placeholder secrets
    // -------------------------------------------------------------------------
    const invalidPreviewConfigs: Array<{ label: string; env: Record<string, string | undefined> }> = [
      {
        label: 'All Razorpay secrets missing in Preview',
        env: {
          ...basePreviewFirebase,
          RAZORPAY_KEY_ID: undefined,
          RAZORPAY_KEY_SECRET: undefined,
          RAZORPAY_WEBHOOK_SECRET: undefined
        }
      },
      {
        label: 'Missing RAZORPAY_KEY_ID in Preview',
        env: {
          ...basePreviewFirebase,
          RAZORPAY_KEY_ID: undefined,
          RAZORPAY_KEY_SECRET: 'preview_secret_alpha_9988',
          RAZORPAY_WEBHOOK_SECRET: 'preview_whsec_alpha_9988'
        }
      },
      {
        label: 'Missing RAZORPAY_KEY_SECRET in Preview',
        env: {
          ...basePreviewFirebase,
          RAZORPAY_KEY_ID: 'rzp_test_preview12345',
          RAZORPAY_KEY_SECRET: undefined,
          RAZORPAY_WEBHOOK_SECRET: 'preview_whsec_alpha_9988'
        }
      },
      {
        label: 'Missing RAZORPAY_WEBHOOK_SECRET in Preview',
        env: {
          ...basePreviewFirebase,
          RAZORPAY_KEY_ID: 'rzp_test_preview12345',
          RAZORPAY_KEY_SECRET: 'preview_secret_alpha_9988',
          RAZORPAY_WEBHOOK_SECRET: undefined
        }
      },
      {
        label: 'Mock KEY_SECRET in Preview',
        env: {
          ...basePreviewFirebase,
          RAZORPAY_KEY_ID: 'rzp_test_preview12345',
          RAZORPAY_KEY_SECRET: 'mockSecret987654321',
          RAZORPAY_WEBHOOK_SECRET: 'preview_whsec_alpha_9988'
        }
      },
      {
        label: 'Placeholder WEBHOOK_SECRET in Preview',
        env: {
          ...basePreviewFirebase,
          RAZORPAY_KEY_ID: 'rzp_test_preview12345',
          RAZORPAY_KEY_SECRET: 'preview_secret_alpha_9988',
          RAZORPAY_WEBHOOK_SECRET: 'placeholder_webhook_secret'
        }
      },
      {
        label: 'Changeme KEY_ID / string null secret in Preview',
        env: {
          ...basePreviewFirebase,
          RAZORPAY_KEY_ID: 'rzp_test_mock_12345',
          RAZORPAY_KEY_SECRET: 'null',
          RAZORPAY_WEBHOOK_SECRET: 'preview_whsec_alpha_9988'
        }
      },
      {
        label: 'Live Razorpay KEY_ID (rzp_live_*) forbidden in Preview',
        env: {
          ...basePreviewFirebase,
          RAZORPAY_KEY_ID: 'rzp_live_forbidden_in_preview',
          RAZORPAY_KEY_SECRET: 'preview_secret_alpha_9988',
          RAZORPAY_WEBHOOK_SECRET: 'preview_whsec_alpha_9988'
        }
      }
    ];

    for (let idx = 0; idx < invalidPreviewConfigs.length; idx++) {
      const tc = invalidPreviewConfigs[idx];
      const loopOrderId = `CFX-P210-PAID-REAL-${idx + 1}`;
      await fs.collection('orders').doc(loopOrderId).set({
        id: loopOrderId,
        product_id: 1,
        product_name: 'Classic Espresso',
        machine_id: 'CFX-MC-01',
        amount: 100,
        captured_amount_paise: 10000,
        status: 'COMPLETED',
        dispense_status: 'FAILED',
        dispensed: false,
        razorpay_order_id: `order_test_paid_p210_${idx + 1}`,
        razorpay_payment_id: `pay_test_real_refund_eligible_${idx + 1}`,
        created_at: new Date().toISOString()
      });

      await withEnv(tc.env, async () => {
        const orderRes = await api(
          'POST',
          '/api/orders/create',
          { product_id: 1, machine_id: 'CFX-MC-01' },
          { Authorization: `Bearer ${kioskToken}` }
        );
        assert.strictEqual(orderRes.status, 503, `[${tc.label}] /orders/create expected 503, got ${orderRes.status}`);

        const verifyRes = await api(
          'POST',
          '/api/payments/verify',
          {
            order_id: pendingOrderId,
            razorpay_payment_id: 'pay_test_1234',
            razorpay_order_id: pendingRpOrderId,
            razorpay_signature: 'invalid_sig'
          },
          { Authorization: `Bearer ${kioskToken}` }
        );
        assert.strictEqual(verifyRes.status, 503, `[${tc.label}] /payments/verify expected 503, got ${verifyRes.status}`);

        const whRes = await api(
          'POST',
          '/api/payments/webhook',
          { event: 'payment.captured', payload: {} },
          { 'Content-Type': 'application/json' }
        );
        assert.strictEqual(whRes.status, 503, `[${tc.label}] /payments/webhook expected 503, got ${whRes.status}`);

        const refundEndpointRes = await api(
          'POST',
          `/api/orders/${loopOrderId}/refund`,
          { reason: 'P210-1 config test' },
          { Authorization: `Bearer ${adminToken}` }
        );
        assert.strictEqual(
          refundEndpointRes.status,
          503,
          `[${tc.label}] /orders/:id/refund expected 503, got ${refundEndpointRes.status}`
        );

        assert.throws(
          () => resolveRazorpayRefundConfig(),
          (err: any) => err?.statusCode === 503,
          `[${tc.label}] resolveRazorpayRefundConfig expected 503`
        );
      });
    }
    console.log('  [PASS] 1. Preview fails closed with HTTP 503 for all missing/partial/mock/placeholder/rzp_live_* configurations.');

    // -------------------------------------------------------------------------
    // 6. Preview with valid Test Mode credentials accepts Test Mode & enforces real crypto
    // -------------------------------------------------------------------------
    const validPreviewCreds = {
      ...basePreviewFirebase,
      RAZORPAY_KEY_ID: 'rzp_test_preview_valid_01',
      RAZORPAY_KEY_SECRET: 'preview_real_test_key_secret_987654',
      RAZORPAY_WEBHOOK_SECRET: 'preview_real_test_wh_secret_987654'
    };

    await withEnv(validPreviewCreds, async () => {
      // Stub Razorpay client so zero network calls occur while proving real Test Mode code path executes
      let createdOrderCount = 0;
      setRazorpayClientForTesting({
        orders: {
          create: async () => {
            createdOrderCount += 1;
            return { id: `order_rp_preview_real_${createdOrderCount}`, amount: 10000, currency: 'INR' };
          }
        }
      });

      const orderRes = await api(
        'POST',
        '/api/orders/create',
        { product_id: 1, machine_id: 'CFX-MC-01' },
        { Authorization: `Bearer ${kioskToken}` }
      );
      assert.strictEqual(orderRes.status, 201, `Valid Preview order create failed: ${JSON.stringify(orderRes.data)}`);
      assert.strictEqual(createdOrderCount, 1, 'Expected real Razorpay client path in Preview (not mock)');
      assert.strictEqual(orderRes.data.data.razorpay_key, 'rzp_test_preview_valid_01');
      assert.ok(String(orderRes.data.data.razorpay_order_id).startsWith('order_rp_preview_real_'));

      // Mock verify attempts MUST fail with HTTP 400 and leave order untouched
      const createdId = orderRes.data.data.id || orderRes.data.data.order_id;
      assert.ok(createdId, `Expected order id in response: ${JSON.stringify(orderRes.data)}`);
      const realRpOrderId = orderRes.data.data.razorpay_order_id;

      for (const badVerify of [
        {
          label: 'order_mock_* rejected in Preview',
          expectedMsg: 'Mock payment orders',
          body: {
            order_id: createdId,
            razorpay_payment_id: 'pay_test_1',
            razorpay_order_id: 'order_mock_12345',
            razorpay_signature: 'mock'
          }
        },
        {
          label: 'pay_mock_* rejected in Preview',
          expectedMsg: 'Mock payment orders',
          body: {
            order_id: createdId,
            razorpay_payment_id: 'pay_mock_12345',
            razorpay_order_id: realRpOrderId,
            razorpay_signature: 'abc123'
          }
        },
        {
          label: 'signature mock rejected in Preview',
          expectedMsg: 'Mock payment orders',
          body: {
            order_id: createdId,
            razorpay_payment_id: 'pay_test_real_9',
            razorpay_order_id: realRpOrderId,
            razorpay_signature: 'mock'
          }
        },
        {
          label: 'invalid HMAC signature rejected in Preview',
          expectedMsg: 'signature mismatch',
          body: {
            order_id: createdId,
            razorpay_payment_id: 'pay_test_real_9',
            razorpay_order_id: realRpOrderId,
            razorpay_signature: 'deadbeef0000'
          }
        }
      ]) {
        const res = await api('POST', '/api/payments/verify', badVerify.body, {
          Authorization: `Bearer ${kioskToken}`
        });
        assert.strictEqual(res.status, 400, `${badVerify.label}: expected 400, got ${res.status}`);
        assert.ok(
          String(res.data?.message || '').toLowerCase().includes(badVerify.expectedMsg.toLowerCase()),
          `${badVerify.label}: unexpected message ${JSON.stringify(res.data)}`
        );
      }

      // Check order & stock unchanged after failed verifications
      const untouchedSnap = await fs.collection('orders').doc(createdId).get();
      assert.strictEqual(untouchedSnap.data().status, 'PENDING');
      assert.strictEqual(untouchedSnap.data().razorpay_payment_id || null, null);
      const machineAfterBadVerify = await fs.collection('machines').doc('CFX-MC-01').get();
      assert.strictEqual(machineAfterBadVerify.data().stock.cups_count, 200);

      const machineSnapshotBefore = JSON.stringify((await fs.collection('machines').doc('CFX-MC-01').get()).data());
      const ledgerSizeBefore = (await fs.collection('inventory_ledger').get()).size;

      // Missing / mock / tampered webhook signatures MUST fail with HTTP 400 with ZERO ledger or order mutations
      const whPayload = JSON.stringify({
        event: 'payment.captured',
        payload: {
          payment: {
            entity: {
              id: 'pay_test_preview_captured_1',
              order_id: realRpOrderId,
              amount: 10000,
              status: 'captured'
            }
          }
        }
      });

      const whMissingSig = await api('POST', '/api/payments/webhook', whPayload, {
        'Content-Type': 'application/json',
        'X-Razorpay-Event-Id': 'evt_p210_missing_sig'
      });
      assert.strictEqual(whMissingSig.status, 400);

      const whMockSig = await api('POST', '/api/payments/webhook', whPayload, {
        'Content-Type': 'application/json',
        'X-Razorpay-Signature': 'mock',
        'X-Razorpay-Event-Id': 'evt_p210_mock_sig'
      });
      assert.strictEqual(whMockSig.status, 400);

      const whInvalidHmac = await api('POST', '/api/payments/webhook', whPayload, {
        'Content-Type': 'application/json',
        'X-Razorpay-Signature': 'tampered_hmac_signature_value',
        'X-Razorpay-Event-Id': 'evt_p210_bad_hmac'
      });
      assert.strictEqual(whInvalidHmac.status, 400);

      // Confirm zero webhook ledger docs, zero inventory ledger writes & zero order mutations occurred
      for (const badEvtId of ['evt_p210_missing_sig', 'evt_p210_mock_sig', 'evt_p210_bad_hmac']) {
        const ledgerSnap = await fs.collection('razorpay_webhook_events').doc(badEvtId).get();
        assert.strictEqual(ledgerSnap.exists, false, `Expected no ledger entry for rejected event ${badEvtId}`);
      }
      assert.strictEqual((await fs.collection('orders').doc(createdId).get()).data().status, 'PENDING');
      assert.strictEqual(
        JSON.stringify((await fs.collection('machines').doc('CFX-MC-01').get()).data()),
        machineSnapshotBefore
      );
      assert.strictEqual((await fs.collection('inventory_ledger').get()).size, ledgerSizeBefore);

      // Valid HMAC-SHA256 Test Mode webhook succeeds (HTTP 200) and transitions PENDING -> PAID
      const validWhSig = crypto
        .createHmac('sha256', validPreviewCreds.RAZORPAY_WEBHOOK_SECRET)
        .update(Buffer.from(whPayload, 'utf8'))
        .digest('hex');

      const whValidRes = await api('POST', '/api/payments/webhook', whPayload, {
        'Content-Type': 'application/json',
        'X-Razorpay-Signature': validWhSig,
        'X-Razorpay-Event-Id': 'evt_p210_valid_preview'
      });
      assert.strictEqual(whValidRes.status, 200, `Valid Preview webhook failed: ${JSON.stringify(whValidRes.data)}`);
      assert.strictEqual((await fs.collection('orders').doc(createdId).get()).data().status, 'PAID');
      assert.ok(
        (await fs.collection('inventory_ledger').get()).size > ledgerSizeBefore,
        'Expected inventory ledger movements to be recorded after valid webhook payment'
      );

      // Valid HMAC-SHA256 Test Mode client payment verification (/api/payments/verify) succeeds (HTTP 200)
      const orderResForVerify = await api(
        'POST',
        '/api/orders/create',
        { product_id: 1, machine_id: 'CFX-MC-01' },
        { Authorization: `Bearer ${kioskToken}` }
      );
      assert.strictEqual(orderResForVerify.status, 201);
      const secondOrderId = orderResForVerify.data.data.id || orderResForVerify.data.data.order_id;
      assert.ok(secondOrderId);
      const secondRpOrderId = orderResForVerify.data.data.razorpay_order_id;
      const secondRpPayId = 'pay_test_preview_verify_hmac_2';
      const validClientSig = crypto
        .createHmac('sha256', validPreviewCreds.RAZORPAY_KEY_SECRET)
        .update(`${secondRpOrderId}|${secondRpPayId}`)
        .digest('hex');

      const verifyValidRes = await api(
        'POST',
        '/api/payments/verify',
        {
          order_id: secondOrderId,
          razorpay_payment_id: secondRpPayId,
          razorpay_order_id: secondRpOrderId,
          razorpay_signature: validClientSig
        },
        { Authorization: `Bearer ${kioskToken}` }
      );
      assert.strictEqual(verifyValidRes.status, 200, `Valid Preview verify failed: ${JSON.stringify(verifyValidRes.data)}`);
      assert.strictEqual((await fs.collection('orders').doc(secondOrderId).get()).data().status, 'PAID');

      // Preview refund execution blocks pay_mock_* and test_* with 400 BadRequestError (HTTP & gateway level)
      const mockRefundEndpointRes = await api(
        'POST',
        `/api/orders/${paidMockOrderForRefundId}/refund`,
        { reason: 'Attempt mock refund in Preview' },
        { Authorization: `Bearer ${adminToken}` }
      );
      assert.strictEqual(mockRefundEndpointRes.status, 400);

      await assert.rejects(
        () => executeGatewayRefund({ paymentId: 'pay_mock_preview_reject', amountPaise: 10000 }),
        (err: any) => err?.statusCode === 400
      );
      await assert.rejects(
        () => executeGatewayRefund({ paymentId: 'test_payment_preview_reject', amountPaise: 10000 }),
        (err: any) => err?.statusCode === 400
      );

      setRazorpayClientForTesting(null);
    });
    console.log('  [PASS] 2. Preview with Test Mode credentials enforces real HMAC-SHA256 verification and blocks all mock shortcuts.');

    // -------------------------------------------------------------------------
    // 7. Ambiguous environment markers fail closed with HTTP 503
    // -------------------------------------------------------------------------
    const ambiguousEnvs: Array<{ label: string; env: Record<string, string | undefined> }> = [
      {
        label: 'VERCEL=1 with unset VERCEL_ENV',
        env: {
          VERCEL: '1',
          VERCEL_ENV: undefined,
          NODE_ENV: 'test',
          FIREBASE_PROJECT_ID: undefined,
          RAZORPAY_KEY_ID: undefined,
          RAZORPAY_KEY_SECRET: undefined,
          RAZORPAY_WEBHOOK_SECRET: undefined
        }
      },
      {
        label: 'NODE_ENV=production with unset VERCEL_ENV',
        env: {
          VERCEL: undefined,
          VERCEL_ENV: undefined,
          NODE_ENV: 'production',
          FIREBASE_PROJECT_ID: undefined,
          RAZORPAY_KEY_ID: undefined,
          RAZORPAY_KEY_SECRET: undefined,
          RAZORPAY_WEBHOOK_SECRET: undefined
        }
      },
      {
        label: 'VERCEL=1 with VERCEL_ENV=development',
        env: {
          VERCEL: '1',
          VERCEL_ENV: 'development',
          NODE_ENV: 'development',
          FIREBASE_PROJECT_ID: undefined,
          RAZORPAY_KEY_ID: undefined,
          RAZORPAY_KEY_SECRET: undefined,
          RAZORPAY_WEBHOOK_SECRET: undefined
        }
      },
      {
        label: 'Unrecognized VERCEL_ENV=staging',
        env: {
          VERCEL: '1',
          VERCEL_ENV: 'staging',
          NODE_ENV: 'production',
          FIREBASE_PROJECT_ID: undefined,
          RAZORPAY_KEY_ID: undefined,
          RAZORPAY_KEY_SECRET: undefined,
          RAZORPAY_WEBHOOK_SECRET: undefined
        }
      }
    ];

    for (const tc of ambiguousEnvs) {
      await withEnv(tc.env, async () => {
        assert.throws(
          () => resolveValidatedRazorpayEnvironment(),
          (err: any) => err?.statusCode === 503,
          `[${tc.label}] expected 503`
        );
        assert.throws(
          () => resolveRazorpayOrderConfig(),
          (err: any) => err?.statusCode === 503,
          `[${tc.label}] resolveRazorpayOrderConfig expected 503`
        );
        assert.throws(
          () => resolveRazorpayRefundConfig(),
          (err: any) => err?.statusCode === 503,
          `[${tc.label}] resolveRazorpayRefundConfig expected 503`
        );
      });
    }
    console.log('  [PASS] 3. Ambiguous VERCEL / VERCEL_ENV / NODE_ENV classifications fail closed with HTTP 503.');

    // -------------------------------------------------------------------------
    // 8. Production strictly rejects Test Mode (rzp_test_*) and missing secrets
    // -------------------------------------------------------------------------
    const prodFirebaseEnv = {
      VERCEL: '1',
      VERCEL_ENV: 'production',
      NODE_ENV: 'production',
      FIREBASE_PROJECT_ID: 'caffix-vending',
      FIREBASE_CLIENT_EMAIL: 'firebase-adminsdk@caffix-vending.iam.gserviceaccount.com',
      FIREBASE_PRIVATE_KEY: 'prod-synthetic-nonmock-key-value'
    };

    await withEnv(
      {
        ...prodFirebaseEnv,
        RAZORPAY_KEY_ID: 'rzp_test_must_not_run_in_prod',
        RAZORPAY_KEY_SECRET: 'prod_secret_valid_9988',
        RAZORPAY_WEBHOOK_SECRET: 'prod_wh_secret_valid_9988'
      },
      async () => {
        assert.strictEqual(
          (
            await api(
              'POST',
              '/api/orders/create',
              { product_id: 1, machine_id: 'CFX-MC-01' },
              { Authorization: `Bearer ${kioskToken}` }
            )
          ).status,
          503,
          'Production must reject rzp_test_* on /orders/create'
        );
        assert.strictEqual(
          (
            await api(
              'POST',
              '/api/payments/verify',
              {
                order_id: pendingOrderId,
                razorpay_payment_id: 'pay_real_1',
                razorpay_order_id: pendingRpOrderId,
                razorpay_signature: 'sig'
              },
              { Authorization: `Bearer ${kioskToken}` }
            )
          ).status,
          503,
          'Production must reject rzp_test_* on /payments/verify'
        );
        assert.strictEqual(
          (
            await api(
              'POST',
              '/api/payments/webhook',
              { event: 'payment.captured', payload: {} },
              { 'Content-Type': 'application/json' }
            )
          ).status,
          503,
          'Production must reject rzp_test_* on /payments/webhook'
        );
        await assert.rejects(
          () => executeGatewayRefund({ paymentId: 'pay_real_1', amountPaise: 10000 }),
          (err: any) => err?.statusCode === 503
        );
      }
    );

    await withEnv(
      {
        ...prodFirebaseEnv,
        RAZORPAY_KEY_ID: 'rzp_live_valid_prod_key_1',
        RAZORPAY_KEY_SECRET: 'prod_secret_valid_9988',
        RAZORPAY_WEBHOOK_SECRET: undefined
      },
      async () => {
        const prodMissingWh = await api(
          'POST',
          '/api/payments/webhook',
          { event: 'payment.captured', payload: {} },
          { 'Content-Type': 'application/json' }
        );
        assert.strictEqual(prodMissingWh.status, 503, 'Production webhook without RAZORPAY_WEBHOOK_SECRET must return 503');
      }
    );
    console.log('  [PASS] 4. Production strictly rejects rzp_test_* keys and missing webhook secrets with HTTP 503.');

    // -------------------------------------------------------------------------
    // 9. Local development/test mode intentionally preserves mock flow
    // -------------------------------------------------------------------------
    await withEnv(
      {
        VERCEL: undefined,
        VERCEL_ENV: undefined,
        NODE_ENV: 'test',
        RAZORPAY_KEY_ID: undefined,
        RAZORPAY_KEY_SECRET: undefined,
        RAZORPAY_WEBHOOK_SECRET: undefined
      },
      async () => {
        setRazorpayClientForTesting(null);
        setRazorpayRefundClientForTesting(null);

        const localOrder = await api(
          'POST',
          '/api/orders/create',
          { product_id: 1, machine_id: 'CFX-MC-01' },
          { Authorization: `Bearer ${kioskToken}` }
        );
        assert.strictEqual(localOrder.status, 201, `Local mock order failed: ${JSON.stringify(localOrder.data)}`);
        assert.strictEqual(localOrder.data.data.razorpay_key, 'mock');
        assert.ok(String(localOrder.data.data.razorpay_order_id).startsWith('order_mock_'));

        const localVerify = await api(
          'POST',
          '/api/payments/verify',
          {
            order_id: localOrder.data.data.id || localOrder.data.data.order_id,
            razorpay_payment_id: 'pay_mock_local_verify_1',
            razorpay_order_id: localOrder.data.data.razorpay_order_id,
            razorpay_signature: 'mock'
          },
          { Authorization: `Bearer ${kioskToken}` }
        );
        assert.strictEqual(localVerify.status, 200, `Local mock verify failed: ${JSON.stringify(localVerify.data)}`);

        const localOrder2 = await api(
          'POST',
          '/api/orders/create',
          { product_id: 1, machine_id: 'CFX-MC-01' },
          { Authorization: `Bearer ${kioskToken}` }
        );
        assert.strictEqual(localOrder2.status, 201);
        const localOrder2Id = localOrder2.data.data.id || localOrder2.data.data.order_id;
        assert.ok(localOrder2Id);
        const localWh = await api(
          'POST',
          '/api/payments/webhook',
          JSON.stringify({
            event: 'payment.captured',
            payload: {
              payment: {
                entity: {
                  id: 'pay_mock_local_wh_2',
                  order_id: localOrder2.data.data.razorpay_order_id,
                  amount: 10000,
                  status: 'captured'
                }
              }
            }
          }),
          {
            'Content-Type': 'application/json',
            'X-Razorpay-Signature': 'mock',
            'X-Razorpay-Event-Id': 'evt_p210_local_mock_wh'
          }
        );
        assert.strictEqual(localWh.status, 200, `Local mock webhook failed: ${JSON.stringify(localWh.data)}`);
        assert.strictEqual(
          (await fs.collection('orders').doc(localOrder2Id).get()).data().status,
          'PAID'
        );

        const localRefund = await executeGatewayRefund({
          paymentId: 'pay_mock_local_refund_1',
          amountPaise: 10000
        });
        assert.strictEqual(localRefund.isMock, true);
        assert.ok(String(localRefund.razorpayRefundId).startsWith('rfnd_mock_'));
      }
    );
    console.log('  [PASS] 5. Local dev/test mode intentionally preserves mock order, verify, webhook, and refund paths.');
    console.log('\nALL PHASE 2.10.1 PREVIEW PAYMENT & WEBHOOK HARDENING TESTS PASSED!\n');
  } finally {
    setRazorpayClientForTesting(null);
    setRazorpayRefundClientForTesting(null);
    setFirestoreForTesting({ firestoreInstance: null, initError: null, clearStores: true });
    resetMockDatabaseForColdStartSimulation();
    restoreEnv(INITIAL_ENV);
    server.close();
  }
}

runP2101Tests()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('PHASE 2.10.1 TESTS FAILED:', err);
    process.exit(1);
  });
