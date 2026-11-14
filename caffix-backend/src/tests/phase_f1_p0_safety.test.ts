import assert from 'assert';
import crypto from 'crypto';
import http from 'http';

process.env.VERCEL = '1';
process.env.VERCEL_ENV = 'production';
process.env.FIREBASE_PROJECT_ID = 'caffix-vending';
process.env.FIREBASE_CLIENT_EMAIL = 'firebase-adminsdk@caffix-vending.iam.gserviceaccount.com';
process.env.FIREBASE_PRIVATE_KEY = '-----BEGIN PRIVATE KEY-----\nPHASE_F1_TEST_KEY\n-----END PRIVATE KEY-----';
process.env.JWT_SECRET = 'caffix-test-phase-f1-jwt-secret-key-2026';
process.env.KIOSK_SECRET_CFX_MC_01 = 'PhaseF1ProdMc01Secret_9988';
process.env.KIOSK_ADMIN_ENABLED = 'false';
process.env.RAZORPAY_KEY_ID = 'rzp_live_phasef1testkeyid';
process.env.RAZORPAY_KEY_SECRET = 'live_phasef1_key_secret_99887766';
process.env.RAZORPAY_WEBHOOK_SECRET = 'live_phasef1_webhook_secret_55443322';
process.env.CRON_SECRET = 'phasef1_production_cron_secret_token_2026';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const app = require('../index').default;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { initDB, resetMockDatabaseForColdStartSimulation } = require('../config/db');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { setRazorpayClientForTesting } = require('../controllers/orderController');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { setFirestoreForTesting } = require('../utils/firebase');

const PORT = 5097;
const BASE_URL = `http://127.0.0.1:${PORT}/api`;
const KEY_SECRET = process.env.RAZORPAY_KEY_SECRET as string;
const CRON_SECRET = process.env.CRON_SECRET as string;

class MockFirestore {
  public collections = new Map<string, Map<string, any>>();

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
          collection(subColName: string) {
            return self.collection(`${colName}/${id}/${subColName}`);
          },
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
    const staged: Array<{ ref: any; payload: any; opts?: { merge?: boolean } }> = [];
    const tx = {
      get: async (ref: any) => ref.get(),
      set: (ref: any, payload: any, opts?: { merge?: boolean }) => {
        staged.push({ ref, payload, opts });
      }
    };
    const res = await fn(tx);
    for (const w of staged) {
      await w.ref.set(w.payload, w.opts);
    }
    return res;
  }

  batch() {
    const ops: Array<() => Promise<void>> = [];
    return {
      set(ref: any, payload: any, opts?: { merge?: boolean }) {
        ops.push(() => ref.set(payload, opts));
      },
      async commit() {
        for (const op of ops) {
          await op();
        }
      }
    };
  }
}

function signCheckoutPayment(rpOrderId: string, rpPaymentId: string): string {
  return crypto.createHmac('sha256', KEY_SECRET).update(`${rpOrderId}|${rpPaymentId}`).digest('hex');
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

async function seedMachine(fs: MockFirestore) {
  const nowIso = new Date().toISOString();
  await fs.collection('machines').doc('CFX-MC-01').set({
    id: 'CFX-MC-01',
    machine_name: 'Production Kiosk CFX-MC-01',
    location: 'Terminal 1',
    desired_mode: 'RUNNING',
    status: 'online',
    last_seen: nowIso,
    owner_id: 'owner_mc1',
    kiosk_token: process.env.KIOSK_SECRET_CFX_MC_01,
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

async function createPendingOrder(
  kioskToken: string,
  rpOrderId: string,
  amount = 100
): Promise<string> {
  setRazorpayClientForTesting({
    orders: {
      create: async (opts: any) => ({
        id: rpOrderId,
        amount: opts.amount,
        currency: opts.currency,
        receipt: opts.receipt
      })
    },
    payments: {
      fetch: async () => {
        throw new Error('payments.fetch mock must be configured per test');
      }
    }
  });

  const res = await api(
    'POST',
    '/orders/create',
    { product_id: 1, machine_id: 'CFX-MC-01', amount },
    { Authorization: `Bearer ${kioskToken}` }
  );
  assert.strictEqual(res.status, 201, `Create order failed: ${JSON.stringify(res.data)}`);
  return res.data.data.id;
}

async function runPhaseF1SafetyTests() {
  console.log('\n=============================================================');
  console.log('Running Phase F.1 P0 Safety Regression Tests (S-2 & S-3)');
  console.log('=============================================================\n');

  const fs = new MockFirestore();
  await seedMachine(fs);
  setFirestoreForTesting({ firestoreInstance: fs, clearStores: true });
  await initDB();
  resetMockDatabaseForColdStartSimulation();

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(PORT, '127.0.0.1', resolve));

  try {
    const tokenRes = await api(
      'GET',
      `/kiosk/verify?kiosk=${encodeURIComponent(process.env.KIOSK_SECRET_CFX_MC_01!)}&machine_id=CFX-MC-01`
    );
    assert.strictEqual(tokenRes.status, 200);
    const kioskToken = tokenRes.data.token as string;
    const ordersCol = fs.collection('orders');
    const ordersMap = fs.collections.get('orders')!;

    // 1. S-2: Non-captured ('authorized') payment must return 503 and stay PENDING
    {
      const rpOrderId = 'order_f1_auth';
      const rpPayId = 'pay_f1_auth';
      const orderId = await createPendingOrder(kioskToken, rpOrderId, 100);

      setRazorpayClientForTesting({
        payments: {
          fetch: async () => ({
            id: rpPayId,
            order_id: rpOrderId,
            status: 'authorized',
            currency: 'INR',
            amount: 10000
          })
        }
      });

      const res = await api(
        'POST',
        '/payments/verify',
        {
          order_id: orderId,
          razorpay_order_id: rpOrderId,
          razorpay_payment_id: rpPayId,
          razorpay_signature: signCheckoutPayment(rpOrderId, rpPayId)
        },
        { Authorization: `Bearer ${kioskToken}` }
      );

      assert.strictEqual(res.status, 503, `Expected 503 for authorized-only payment, got ${res.status}`);
      assert.strictEqual(ordersMap.get(orderId).status, 'PENDING');
      console.log('✓ 1. S-2 rejects uncaptured "authorized" payment with 503 and keeps order PENDING');
    }

    // 2. S-2: Failed payment status returned from Razorpay must fail verification (400) and keep PENDING
    {
      const rpOrderId = 'order_f1_failed_pay';
      const rpPayId = 'pay_f1_failed_pay';
      const orderId = await createPendingOrder(kioskToken, rpOrderId, 100);

      setRazorpayClientForTesting({
        payments: {
          fetch: async () => ({
            id: rpPayId,
            order_id: rpOrderId,
            status: 'failed',
            currency: 'INR',
            amount: 10000
          })
        }
      });

      const res = await api(
        'POST',
        '/payments/verify',
        {
          order_id: orderId,
          razorpay_order_id: rpOrderId,
          razorpay_payment_id: rpPayId,
          razorpay_signature: signCheckoutPayment(rpOrderId, rpPayId)
        },
        { Authorization: `Bearer ${kioskToken}` }
      );

      assert.strictEqual(res.status, 400);
      assert.strictEqual(ordersMap.get(orderId).status, 'PENDING');
      console.log('✓ 2. S-2 rejects status="failed" payment (400) and never promotes order to PAID');
    }

    // 3. S-2: Non-INR currency, amount mismatch, and razorpay order_id mismatch are rejected (400)
    {
      const scenarios = [
        { name: 'non-INR currency', payment: { status: 'captured', currency: 'USD', amount: 10000 } },
        { name: 'underpaid amount', payment: { status: 'captured', currency: 'INR', amount: 5000 } },
        { name: 'mismatched rp order_id', payment: { order_id: 'order_wrong', status: 'captured', currency: 'INR', amount: 10000 } }
      ];

      for (let i = 0; i < scenarios.length; i++) {
        const s = scenarios[i];
        const rpOrderId = `order_f1_mismatch_${i}`;
        const rpPayId = `pay_f1_mismatch_${i}`;
        const orderId = await createPendingOrder(kioskToken, rpOrderId, 100);

        setRazorpayClientForTesting({
          payments: {
            fetch: async () => ({
              id: rpPayId,
              order_id: rpOrderId,
              ...s.payment
            })
          }
        });

        const res = await api(
          'POST',
          '/payments/verify',
          {
            order_id: orderId,
            razorpay_order_id: rpOrderId,
            razorpay_payment_id: rpPayId,
            razorpay_signature: signCheckoutPayment(rpOrderId, rpPayId)
          },
          { Authorization: `Bearer ${kioskToken}` }
        );

        assert.strictEqual(res.status, 400, `Scenario "${s.name}" expected 400, got ${res.status}`);
        assert.strictEqual(ordersMap.get(orderId).status, 'PENDING');
      }
      console.log('✓ 3. S-2 rejects non-INR currency, paise mismatch, and order_id mismatch (400)');
    }

    // 4. S-2: Transient gateway error during payments.fetch returns 503 and preserves PENDING
    {
      const rpOrderId = 'order_f1_neterr';
      const rpPayId = 'pay_f1_neterr';
      const orderId = await createPendingOrder(kioskToken, rpOrderId, 100);

      setRazorpayClientForTesting({
        payments: {
          fetch: async () => {
            throw new Error('ETIMEDOUT calling Razorpay payments API');
          }
        }
      });

      const res = await api(
        'POST',
        '/payments/verify',
        {
          order_id: orderId,
          razorpay_order_id: rpOrderId,
          razorpay_payment_id: rpPayId,
          razorpay_signature: signCheckoutPayment(rpOrderId, rpPayId)
        },
        { Authorization: `Bearer ${kioskToken}` }
      );

      assert.strictEqual(res.status, 503);
      assert.strictEqual(ordersMap.get(orderId).status, 'PENDING');
      console.log('✓ 4. S-2 returns retryable 503 when payments.fetch throws transient error');
    }

    // 5. S-2 & S-3: Valid captured INR verify -> PAID (QUEUED) + atomic captured_amount_paise;
    //    duplicate verify idempotency; kiosk cannot bypass dispensing to COMPLETED;
    //    kiosk CAN finalize COMPLETED once RPi marks dispense_status=DISPENSED & dispensed=true
    {
      const rpOrderId = 'order_f1_happy';
      const rpPayId = 'pay_f1_happy';
      const orderId = await createPendingOrder(kioskToken, rpOrderId, 100);

      let fetchCalls = 0;
      setRazorpayClientForTesting({
        payments: {
          fetch: async () => {
            fetchCalls += 1;
            return {
              id: rpPayId,
              order_id: rpOrderId,
              status: 'captured',
              currency: 'INR',
              amount: 10000
            };
          }
        }
      });

      const verifyRes1 = await api(
        'POST',
        '/payments/verify',
        {
          order_id: orderId,
          razorpay_order_id: rpOrderId,
          razorpay_payment_id: rpPayId,
          razorpay_signature: signCheckoutPayment(rpOrderId, rpPayId)
        },
        { Authorization: `Bearer ${kioskToken}` }
      );
      assert.strictEqual(verifyRes1.status, 200);
      assert.strictEqual(verifyRes1.data.data.status, 'PAID');
      assert.strictEqual(verifyRes1.data.data.dispense_status, 'QUEUED');
      assert.strictEqual(ordersMap.get(orderId).captured_amount_paise, 10000);

      // Duplicate /verify retry is idempotent and does not break already-PAID order
      const verifyRes2 = await api(
        'POST',
        '/payments/verify',
        {
          order_id: orderId,
          razorpay_order_id: rpOrderId,
          razorpay_payment_id: rpPayId,
          razorpay_signature: signCheckoutPayment(rpOrderId, rpPayId)
        },
        { Authorization: `Bearer ${kioskToken}` }
      );
      assert.strictEqual(verifyRes2.status, 200);
      assert.strictEqual(ordersMap.get(orderId).captured_amount_paise, 10000);
      assert.strictEqual(fetchCalls >= 1, true);

      // S-3: Unpaid PENDING order cannot be marked COMPLETED by kiosk (403)
      const unpaidOrderId = await createPendingOrder(kioskToken, 'order_f1_unpaid_complete', 100);
      const unpaidComplete = await api(
        'PUT',
        `/orders/${unpaidOrderId}/status`,
        { status: 'COMPLETED' },
        { Authorization: `Bearer ${kioskToken}` }
      );
      assert.strictEqual(unpaidComplete.status, 403, `Expected 403 for unpaid COMPLETED, got ${unpaidComplete.status}`);
      assert.strictEqual(ordersMap.get(unpaidOrderId).status, 'PENDING');

      // Simulate Raspberry Pi completing physical dispense in Firestore
      await ordersCol.doc(orderId).set(
        {
          status: 'PREPARING',
          dispense_status: 'DISPENSED',
          dispensed: true,
          dispensed_at: new Date().toISOString()
        },
        { merge: true }
      );

      // S-3: Kiosk cannot downgrade an already-DISPENSED order to CANCELLED/FAILED (403)
      const downgradeDispensed = await api(
        'PUT',
        `/orders/${orderId}/status`,
        { status: 'CANCELLED' },
        { Authorization: `Bearer ${kioskToken}` }
      );
      assert.strictEqual(downgradeDispensed.status, 403, `Expected 403 downgrading dispensed order, got ${downgradeDispensed.status}`);

      // S-3: Kiosk CAN finalize already-DISPENSED order from PREPARING -> COMPLETED (200)
      const finalized = await api(
        'PUT',
        `/orders/${orderId}/status`,
        { status: 'COMPLETED' },
        { Authorization: `Bearer ${kioskToken}` }
      );
      assert.strictEqual(finalized.status, 200, `Finalization failed: ${JSON.stringify(finalized.data)}`);
      assert.strictEqual(finalized.data.data.status, 'COMPLETED');
      assert.strictEqual(ordersMap.get(orderId).status, 'COMPLETED');

      // COMPLETED remains immutable against subsequent kiosk status changes (403)
      const tamperCompleted = await api(
        'PUT',
        `/orders/${orderId}/status`,
        { status: 'FAILED' },
        { Authorization: `Bearer ${kioskToken}` }
      );
      assert.strictEqual([403, 409].includes(tamperCompleted.status), true);
      console.log('✓ 5. S-2 captured INR verify, idempotent retry, & S-3 hardware-gated COMPLETED finalization verified');
    }

    // 6. S-2 Cron reconciliation: rejects non-INR / underpaid captured payment, accepts valid INR capture + sets captured_amount_paise
    {
      const staleIso = new Date(Date.now() - 20 * 60_000).toISOString();
      const badOrderId = 'ORD-F1-CRON-BAD';
      const goodOrderId = 'ORD-F1-CRON-OK';

      // Clear earlier orders from Map so cron summary counts only these two deterministic records
      ordersMap.clear();

      await ordersCol.doc(badOrderId).set({
        id: badOrderId,
        machine_id: 'CFX-MC-01',
        product_id: 1,
        product_name: 'Espresso',
        amount: 100,
        status: 'PENDING',
        dispense_status: 'PENDING',
        dispensed: false,
        razorpay_order_id: 'order_cron_bad',
        razorpay_payment_id: null,
        inventory_deducted: false,
        created_at: staleIso,
        updated_at: staleIso,
        sugar_level: 1,
        extra_sugar: 0,
        base: 'water'
      });

      await ordersCol.doc(goodOrderId).set({
        id: goodOrderId,
        machine_id: 'CFX-MC-01',
        product_id: 1,
        product_name: 'Espresso',
        amount: 100,
        status: 'PENDING',
        dispense_status: 'PENDING',
        dispensed: false,
        razorpay_order_id: 'order_cron_ok',
        razorpay_payment_id: null,
        inventory_deducted: false,
        created_at: staleIso,
        updated_at: staleIso,
        sugar_level: 1,
        extra_sugar: 0,
        base: 'water'
      });

      setRazorpayClientForTesting({
        orders: {
          fetch: async (rpId: string) => ({
            id: rpId,
            status: 'paid',
            amount: 10000,
            amount_paid: 10000,
            attempts: 1
          }),
          fetchPayments: async (rpId: string) => {
            if (rpId === 'order_cron_bad') {
              return {
                items: [
                  { id: 'pay_cron_bad', order_id: rpId, status: 'captured', currency: 'USD', amount: 10000 }
                ]
              };
            }
            return {
              items: [
                { id: 'pay_cron_ok', order_id: rpId, status: 'captured', currency: 'INR', amount: 10000 }
              ]
            };
          }
        }
      });

      const cronRes = await api('GET', '/cron/reconcile-orders', undefined, {
        Authorization: `Bearer ${CRON_SECRET}`
      });
      assert.strictEqual(cronRes.status, 200, `Cron failed: ${JSON.stringify(cronRes.data)}`);
      assert.strictEqual(cronRes.data.data.reconciled_paid, 1);
      assert.strictEqual(cronRes.data.data.kept_pending, 1);
      assert.strictEqual(ordersMap.get(badOrderId).status, 'PENDING');
      assert.strictEqual(ordersMap.get(goodOrderId).status, 'PAID');
      assert.strictEqual(ordersMap.get(goodOrderId).captured_amount_paise, 10000);
      console.log('✓ 6. S-2 cron reconciliation rejects USD captured payment and sets captured_amount_paise on valid INR match');
    }

    console.log('\nALL PHASE F.1 P0 SAFETY REGRESSION TESTS PASSED!');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

runPhaseF1SafetyTests().catch((err) => {
  console.error('❌ Phase F.1 P0 Safety test failed:', err);
  process.exit(1);
});
