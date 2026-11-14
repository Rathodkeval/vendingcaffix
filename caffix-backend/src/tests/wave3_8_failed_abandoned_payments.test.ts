import assert from 'assert';
import crypto from 'crypto';
import http from 'http';
import jwt from 'jsonwebtoken';

process.env.VERCEL = '1';
process.env.VERCEL_ENV = 'production';
process.env.FIREBASE_PROJECT_ID = 'caffix-vending';
process.env.FIREBASE_CLIENT_EMAIL = 'firebase-adminsdk@caffix-vending.iam.gserviceaccount.com';
process.env.FIREBASE_PRIVATE_KEY = '-----BEGIN PRIVATE KEY-----\nWAVE3_8_TEST_KEY\n-----END PRIVATE KEY-----';
process.env.JWT_SECRET = 'caffix-test-wave3-8-jwt-secret-key-2026';
process.env.KIOSK_SECRET_CFX_MC_01 = 'Wave38ProdMc01Secret_9988';
process.env.KIOSK_SECRET_CFX_MC_02 = 'Wave38ProdMc02Secret_7766';
process.env.KIOSK_ADMIN_ENABLED = 'false';
process.env.RAZORPAY_KEY_ID = 'rzp_live_wave38testkeyid';
process.env.RAZORPAY_KEY_SECRET = 'live_wave38_key_secret_99887766';
process.env.RAZORPAY_WEBHOOK_SECRET = 'live_wave38_webhook_secret_55443322';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const app = require('../index').default;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { initDB, resetMockDatabaseForColdStartSimulation } = require('../config/db');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { setRazorpayClientForTesting } = require('../controllers/orderController');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { setFirestoreForTesting } = require('../utils/firebase');

const PORT = 5095;
const BASE_URL = `http://127.0.0.1:${PORT}/api`;
const KEY_SECRET = process.env.RAZORPAY_KEY_SECRET as string;
const WEBHOOK_SECRET = process.env.RAZORPAY_WEBHOOK_SECRET as string;

class CountingMockFirestore {
  public collections = new Map<string, Map<string, any>>();
  public writeCount = 0;
  public businessWriteCount = 0;

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
            self.writeCount++;
            if (colName !== 'webhook_events' && colName !== 'system_locks') {
              self.businessWriteCount++;
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

function signWebhookBytes(rawBody: string): string {
  return crypto.createHmac('sha256', WEBHOOK_SECRET).update(Buffer.from(rawBody, 'utf8')).digest('hex');
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

async function sendWebhook(
  payloadObj: any,
  signature?: string
): Promise<{ status: number; data: any }> {
  const rawBody = JSON.stringify(payloadObj);
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (signature !== undefined) {
    headers['x-razorpay-signature'] = signature;
  }
  const res = await fetch(`${BASE_URL}/payments/webhook`, {
    method: 'POST',
    headers,
    body: rawBody
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

async function createPendingOrder(
  kioskToken: string,
  machineId: string,
  rpOrderId: string
): Promise<{ orderId: string; razorpayOrderId: string }> {
  setRazorpayClientForTesting({
    orders: {
      create: async (opts: any) => ({
        id: rpOrderId,
        amount: opts.amount,
        currency: opts.currency,
        receipt: opts.receipt
      })
    }
  });
  const res = await api(
    'POST',
    '/orders/create',
    { product_id: 1, machine_id: machineId, amount: 100 },
    { Authorization: `Bearer ${kioskToken}` }
  );
  assert.strictEqual(res.status, 201, `Order create failed: ${JSON.stringify(res.data)}`);
  return { orderId: res.data.data.id, razorpayOrderId: rpOrderId };
}

async function getKioskJwt(machineId: string, secret: string): Promise<string> {
  const res = await api(
    'GET',
    `/kiosk/verify?kiosk=${encodeURIComponent(secret)}&machine_id=${machineId}`
  );
  assert.strictEqual(res.status, 200);
  return res.data.token;
}

async function runWave38Tests() {
  console.log('\n=============================================================');
  console.log('Running Wave 3.8 Failed & Abandoned Payment Handling Tests');
  console.log('=============================================================\n');

  const fs = new CountingMockFirestore();
  const nowIso = new Date().toISOString();
  const machineSecrets: Record<string, string> = {
    'CFX-MC-01': process.env.KIOSK_SECRET_CFX_MC_01!,
    'CFX-MC-02': process.env.KIOSK_SECRET_CFX_MC_02!
  };
  for (const mId of ['CFX-MC-01', 'CFX-MC-02']) {
    await fs.collection('machines').doc(mId).set({
      id: mId,
      machine_name: `Production Kiosk ${mId}`,
      location: 'Production Terminal',
      desired_mode: 'RUNNING',
      status: 'online',
      last_seen: null,
      owner_id: mId === 'CFX-MC-01' ? 'owner_mc1' : 'owner_mc2',
      kiosk_token: machineSecrets[mId],
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

  setFirestoreForTesting({ firestoreInstance: fs, clearStores: true });
  await initDB();
  resetMockDatabaseForColdStartSimulation();

  const server: http.Server = await new Promise((resolve) => {
    const s = app.listen(PORT, '127.0.0.1', () => resolve(s));
  });

  try {
    const kiosk1Token = await getKioskJwt('CFX-MC-01', machineSecrets['CFX-MC-01']);
    const kiosk2Token = await getKioskJwt('CFX-MC-02', machineSecrets['CFX-MC-02']);
    fs.collection('machines');
    fs.collection('orders');
    const machineCol = fs.collections.get('machines')!;
    const ordersCol = fs.collections.get('orders')!;

    // -------------------------------------------------------------------------
    // 1. payment.failed webhook + raw-body HMAC + single target + 0 inventory deduction
    // -------------------------------------------------------------------------
    console.log('1. Testing payment.failed webhook marks only matching eligible order FAILED with 0 inventory deduction...');
    {
      const waterBefore = machineCol.get('CFX-MC-01').estimated_inventory.water_level;
      const targetOrder = await createPendingOrder(kiosk1Token, 'CFX-MC-01', 'order_live_fail_01');
      const siblingPending = await createPendingOrder(kiosk1Token, 'CFX-MC-01', 'order_live_pending_02');

      const failedPayload = {
        event: 'payment.failed',
        created_at: 1700000100,
        payload: {
          payment: {
            entity: {
              id: 'pay_failed_01',
              order_id: targetOrder.razorpayOrderId,
              status: 'failed',
              error_code: 'BAD_REQUEST_ERROR'
            }
          }
        }
      };

      // Invalid/missing/mock signature must be rejected (400) before touching order
      assert.strictEqual((await sendWebhook(failedPayload)).status, 400);
      assert.strictEqual((await sendWebhook(failedPayload, 'mock')).status, 400);
      assert.strictEqual((await sendWebhook(failedPayload, 'bad_sig')).status, 400);
      assert.strictEqual(ordersCol.get(targetOrder.orderId).status, 'PENDING');

      // Valid signed payment.failed
      const rawFailed = JSON.stringify(failedPayload);
      const okRes = await sendWebhook(failedPayload, signWebhookBytes(rawFailed));
      assert.strictEqual(okRes.status, 200);

      const updatedTarget = ordersCol.get(targetOrder.orderId);
      assert.strictEqual(updatedTarget.status, 'FAILED');
      assert.strictEqual(updatedTarget.dispense_status, 'FAILED');
      assert.ok(!updatedTarget.razorpay_payment_id, 'Failed payment ID must not be stored as captured payment');

      // Sibling PENDING order must remain untouched
      assert.strictEqual(ordersCol.get(siblingPending.orderId).status, 'PENDING');
      assert.strictEqual(ordersCol.get(siblingPending.orderId).dispense_status, 'PENDING');

      // Zero inventory deduction
      assert.strictEqual(
        machineCol.get('CFX-MC-01').estimated_inventory.water_level,
        waterBefore,
        'payment.failed must NEVER deduct inventory'
      );

      // -----------------------------------------------------------------------
      // 2. Duplicate payment.failed deliveries are idempotent (0 writes, 0 deduction)
      // -----------------------------------------------------------------------
      console.log('2. Testing duplicate & concurrent payment.failed webhook deliveries are idempotent...');
      const writesBefore = fs.writeCount;
      const [dup1, dup2, dup3] = await Promise.all([
        sendWebhook(failedPayload, signWebhookBytes(rawFailed)),
        sendWebhook(failedPayload, signWebhookBytes(rawFailed)),
        sendWebhook(failedPayload, signWebhookBytes(rawFailed))
      ]);
      assert.strictEqual(dup1.status, 200);
      assert.strictEqual(dup2.status, 200);
      assert.strictEqual(dup3.status, 200);
      assert.strictEqual(fs.writeCount, writesBefore, 'Duplicate payment.failed deliveries must execute 0 Firestore writes');
      assert.strictEqual(ordersCol.get(targetOrder.orderId).status, 'FAILED');
      assert.strictEqual(machineCol.get('CFX-MC-01').estimated_inventory.water_level, waterBefore);
    }
    console.log('   PASS: payment.failed webhook + duplicates idempotent + 0 inventory deduction.');

    // -------------------------------------------------------------------------
    // 3. Late payment.failed arriving after PAID, PREPARING, COMPLETED, DISPENSING, DISPENSED
    // -------------------------------------------------------------------------
    console.log('3. Testing late payment.failed never overwrites PAID, PREPARING, COMPLETED, DISPENSING, or DISPENSED...');
    {
      const scenarios: Array<{ label: string; setup: (orderId: string, rpOrderId: string) => Promise<void>; expectedStatus: string; expectedDispense: string }> = [
        {
          label: 'PAID',
          expectedStatus: 'PAID',
          expectedDispense: 'QUEUED',
          setup: async () => {}
        },
        {
          label: 'PREPARING',
          expectedStatus: 'PREPARING',
          expectedDispense: 'QUEUED',
          setup: async (orderId) => {
            const r = await api('PUT', `/orders/${orderId}/status`, { status: 'PREPARING' }, { Authorization: `Bearer ${kiosk1Token}` });
            assert.strictEqual(r.status, 200);
          }
        },
        {
          label: 'COMPLETED',
          expectedStatus: 'COMPLETED',
          expectedDispense: 'QUEUED',
          setup: async (orderId) => {
            const r = await api('PUT', `/orders/${orderId}/status`, { status: 'COMPLETED' }, { Authorization: `Bearer ${kiosk1Token}` });
            assert.strictEqual(r.status, 200);
          }
        },
        {
          label: 'DISPENSING',
          expectedStatus: 'PAID',
          expectedDispense: 'DISPENSING',
          setup: async (orderId) => {
            const doc = ordersCol.get(orderId);
            doc.dispense_status = 'DISPENSING';
            ordersCol.set(orderId, doc);
          }
        },
        {
          label: 'DISPENSED',
          expectedStatus: 'COMPLETED',
          expectedDispense: 'DISPENSED',
          setup: async (orderId) => {
            const doc = ordersCol.get(orderId);
            doc.status = 'COMPLETED';
            doc.dispense_status = 'DISPENSED';
            doc.dispensed = true;
            ordersCol.set(orderId, doc);
          }
        }
      ];

      for (let i = 0; i < scenarios.length; i++) {
        const sc = scenarios[i];
        const ord = await createPendingOrder(kiosk1Token, 'CFX-MC-01', `order_live_paid_guard_${i}`);
        const payId = `pay_guard_${i}`;
        const vRes = await api(
          'POST',
          '/payments/verify',
          {
            order_id: ord.orderId,
            razorpay_order_id: ord.razorpayOrderId,
            razorpay_payment_id: payId,
            razorpay_signature: signCheckoutPayment(ord.razorpayOrderId, payId)
          },
          { Authorization: `Bearer ${kiosk1Token}` }
        );
        assert.strictEqual(vRes.status, 200);
        await sc.setup(ord.orderId, ord.razorpayOrderId);

        const waterBefore = machineCol.get('CFX-MC-01').estimated_inventory.water_level;
        const bizWritesBefore = fs.businessWriteCount;
        const failPayload = {
          event: 'payment.failed',
          payload: {
            payment: {
              entity: {
                id: `pay_late_fail_${i}`,
                order_id: ord.razorpayOrderId,
                status: 'failed'
              }
            }
          }
        };
        const whRes = await sendWebhook(failPayload, signWebhookBytes(JSON.stringify(failPayload)));
        assert.strictEqual(whRes.status, 200);
        assert.strictEqual(
          fs.businessWriteCount,
          bizWritesBefore,
          `Late payment.failed on ${sc.label} must perform 0 order/machine Firestore writes`
        );

        const afterDoc = ordersCol.get(ord.orderId);
        assert.strictEqual(afterDoc.status, sc.expectedStatus, `Late payment.failed must not overwrite ${sc.label}`);
        assert.strictEqual(afterDoc.dispense_status, sc.expectedDispense, `Late payment.failed must preserve dispense_status on ${sc.label}`);
        assert.strictEqual(afterDoc.razorpay_payment_id, payId, `razorpay_payment_id must stay intact on ${sc.label}`);
        assert.strictEqual(machineCol.get('CFX-MC-01').estimated_inventory.water_level, waterBefore);
      }
    }
    console.log('   PASS: Late payment.failed cannot overwrite any PAID/PREPARING/COMPLETED/DISPENSING/DISPENSED order.');

    // -------------------------------------------------------------------------
    // 4. Checkout dismissal (CANCELLED) + idempotency + 0 inventory deduction + unauthorized cancel checks
    // -------------------------------------------------------------------------
    console.log('4. Testing checkout dismissal & unauthorized cancellation protection...');
    {
      const waterBefore = machineCol.get('CFX-MC-01').estimated_inventory.water_level;
      const cancelOrd = await createPendingOrder(kiosk1Token, 'CFX-MC-01', 'order_live_cancel_01');

      // Unauthenticated -> 401
      assert.strictEqual((await api('POST', `/orders/${cancelOrd.orderId}/cancel`, {})).status, 401);

      // Cross-kiosk (CFX-MC-02 cancelling CFX-MC-01 order) -> 403
      const crossKioskCancel = await api(
        'POST',
        `/orders/${cancelOrd.orderId}/cancel`,
        { razorpay_order_id: cancelOrd.razorpayOrderId, reason: 'checkout_dismissed' },
        { Authorization: `Bearer ${kiosk2Token}` }
      );
      assert.strictEqual(crossKioskCancel.status, 403);
      assert.strictEqual(ordersCol.get(cancelOrd.orderId).status, 'PENDING');

      // Kiosk token missing machine_id -> 403
      const malformedKioskJwt = jwt.sign(
        { id: '2', role: 'kiosk', portal: 'kiosk' },
        process.env.JWT_SECRET!
      );
      assert.strictEqual(
        (
          await api(
            'POST',
            `/orders/${cancelOrd.orderId}/cancel`,
            { reason: 'checkout_dismissed' },
            { Authorization: `Bearer ${malformedKioskJwt}` }
          )
        ).status,
        403
      );

      // Unassigned owner cancelling CFX-MC-01 order -> 403
      const otherOwnerJwt = jwt.sign(
        { id: 'owner_mc2', role: 'owner', email: 'owner2@caffix.com', portal: 'owner' },
        process.env.JWT_SECRET!
      );
      assert.strictEqual(
        (
          await api(
            'POST',
            `/orders/${cancelOrd.orderId}/cancel`,
            { reason: 'checkout_dismissed' },
            { Authorization: `Bearer ${otherOwnerJwt}` }
          )
        ).status,
        403
      );

      // Mismatched razorpay_order_id -> 400
      assert.strictEqual(
        (
          await api(
            'POST',
            `/orders/${cancelOrd.orderId}/cancel`,
            { razorpay_order_id: 'order_wrong_id_999', reason: 'checkout_dismissed' },
            { Authorization: `Bearer ${kiosk1Token}` }
          )
        ).status,
        400
      );
      assert.strictEqual(ordersCol.get(cancelOrd.orderId).status, 'PENDING');

      // Authorized dismissal on CFX-MC-01 -> 200 CANCELLED, 0 deduction
      const okCancel = await api(
        'POST',
        `/orders/${cancelOrd.orderId}/cancel`,
        { razorpay_order_id: cancelOrd.razorpayOrderId, reason: 'checkout_dismissed' },
        { Authorization: `Bearer ${kiosk1Token}` }
      );
      assert.strictEqual(okCancel.status, 200);
      assert.strictEqual(okCancel.data.data.status, 'CANCELLED');
      assert.strictEqual(ordersCol.get(cancelOrd.orderId).status, 'CANCELLED');
      assert.strictEqual(ordersCol.get(cancelOrd.orderId).dispense_status, 'CANCELLED');
      assert.strictEqual(machineCol.get('CFX-MC-01').estimated_inventory.water_level, waterBefore);

      // Duplicate dismissal call is idempotent -> 200, 0 writes
      const writesBefore = fs.writeCount;
      const dupCancel = await api(
        'POST',
        `/orders/${cancelOrd.orderId}/cancel`,
        { razorpay_order_id: cancelOrd.razorpayOrderId, reason: 'timeout' },
        { Authorization: `Bearer ${kiosk1Token}` }
      );
      assert.strictEqual(dupCancel.status, 200);
      assert.strictEqual(dupCancel.data.data.status, 'CANCELLED');
      assert.strictEqual(fs.writeCount, writesBefore);
      assert.strictEqual(machineCol.get('CFX-MC-01').estimated_inventory.water_level, waterBefore);
    }
    console.log('   PASS: Authorized checkout dismissal marks CANCELLED with 0 deduction; unauthorized attempts blocked.');

    // -------------------------------------------------------------------------
    // 5. Dismissal racing with successful payment + cancel-after-pay rejection (409)
    // -------------------------------------------------------------------------
    console.log('5. Testing checkout dismissal racing with successful payment confirmation...');
    {
      // 5A. Payment verified BEFORE dismissal arrives -> 409 ORDER_ALREADY_PAID, status stays PAID, 1 deduction
      const waterStart = machineCol.get('CFX-MC-01').estimated_inventory.water_level;
      const raceOrdA = await createPendingOrder(kiosk1Token, 'CFX-MC-01', 'order_live_race_seq');
      const payResA = await api(
        'POST',
        '/payments/verify',
        {
          order_id: raceOrdA.orderId,
          razorpay_order_id: raceOrdA.razorpayOrderId,
          razorpay_payment_id: 'pay_race_seq_1',
          razorpay_signature: signCheckoutPayment(raceOrdA.razorpayOrderId, 'pay_race_seq_1')
        },
        { Authorization: `Bearer ${kiosk1Token}` }
      );
      assert.strictEqual(payResA.status, 200);
      assert.strictEqual(payResA.data.data.status, 'PAID');

      const cancelAfterPay = await api(
        'POST',
        `/orders/${raceOrdA.orderId}/cancel`,
        { razorpay_order_id: raceOrdA.razorpayOrderId, reason: 'checkout_dismissed' },
        { Authorization: `Bearer ${kiosk1Token}` }
      );
      assert.strictEqual(cancelAfterPay.status, 409);
      assert.strictEqual(cancelAfterPay.data.code, 'ORDER_ALREADY_PAID');
      assert.strictEqual(cancelAfterPay.data.data.status, 'PAID');
      assert.strictEqual(ordersCol.get(raceOrdA.orderId).status, 'PAID');
      assert.strictEqual(ordersCol.get(raceOrdA.orderId).dispense_status, 'QUEUED');
      assert.strictEqual(machineCol.get('CFX-MC-01').estimated_inventory.water_level, waterStart - 5);

      // 5B. Concurrent race: Promise.all([POST /cancel, webhook payment.captured]) & Promise.all([POST /cancel, POST /payments/verify])
      const raceOrdB = await createPendingOrder(kiosk1Token, 'CFX-MC-01', 'order_live_race_conc1');
      const capPayload = {
        event: 'payment.captured',
        payload: {
          payment: {
            entity: {
              id: 'pay_race_conc_wh',
              order_id: raceOrdB.razorpayOrderId
            }
          }
        }
      };
      const [cancelConcB, webhookConcB] = await Promise.all([
        api(
          'POST',
          `/orders/${raceOrdB.orderId}/cancel`,
          { razorpay_order_id: raceOrdB.razorpayOrderId, reason: 'checkout_dismissed' },
          { Authorization: `Bearer ${kiosk1Token}` }
        ),
        sendWebhook(capPayload, signWebhookBytes(JSON.stringify(capPayload)))
      ]);
      assert.strictEqual(webhookConcB.status, 200);
      assert.ok([200, 409].includes(cancelConcB.status));
      assert.strictEqual(ordersCol.get(raceOrdB.orderId).status, 'PAID', 'Captured payment must settle PAID');
      assert.strictEqual(ordersCol.get(raceOrdB.orderId).dispense_status, 'QUEUED');
      assert.strictEqual(
        machineCol.get('CFX-MC-01').estimated_inventory.water_level,
        waterStart - 10,
        'Concurrent cancel + webhook capture must deduct inventory exactly ONCE'
      );

      // 5C. Concurrent race: Promise.all([POST /cancel, POST /payments/verify])
      const raceOrdC = await createPendingOrder(kiosk1Token, 'CFX-MC-01', 'order_live_race_conc2');
      const [cancelConcC, verifyConcC] = await Promise.all([
        api(
          'POST',
          `/orders/${raceOrdC.orderId}/cancel`,
          { razorpay_order_id: raceOrdC.razorpayOrderId, reason: 'checkout_dismissed' },
          { Authorization: `Bearer ${kiosk1Token}` }
        ),
        api(
          'POST',
          '/payments/verify',
          {
            order_id: raceOrdC.orderId,
            razorpay_order_id: raceOrdC.razorpayOrderId,
            razorpay_payment_id: 'pay_race_conc_verify',
            razorpay_signature: signCheckoutPayment(raceOrdC.razorpayOrderId, 'pay_race_conc_verify')
          },
          { Authorization: `Bearer ${kiosk1Token}` }
        )
      ]);
      assert.strictEqual(verifyConcC.status, 200);
      assert.ok([200, 409].includes(cancelConcC.status));
      assert.strictEqual(ordersCol.get(raceOrdC.orderId).status, 'PAID');
      assert.strictEqual(ordersCol.get(raceOrdC.orderId).dispense_status, 'QUEUED');
      assert.strictEqual(
        machineCol.get('CFX-MC-01').estimated_inventory.water_level,
        waterStart - 15,
        'Concurrent cancel + verify must deduct inventory exactly ONCE'
      );
    }
    console.log('   PASS: Dismissal & payment confirmation races preserve PAID status & single inventory deduction.');

    // -------------------------------------------------------------------------
    // 6. Prevent customers from changing paid/completed order status OR bypassing payment
    // -------------------------------------------------------------------------
    console.log('6. Testing customer status tampering restrictions & existing payment success flow...');
    {
      const waterStart = machineCol.get('CFX-MC-02').estimated_inventory.water_level;
      const unpaidOrd = await createPendingOrder(kiosk2Token, 'CFX-MC-02', 'order_live_cust_guard');

      // Customer CANNOT bypass payment via PUT /orders/:id/status { status: 'PAID' | 'PREPARING' | 'COMPLETED' | 'FAILED' }
      for (const forbiddenTarget of ['PAID', 'PREPARING', 'COMPLETED', 'FAILED']) {
        const res = await api(
          'PUT',
          `/orders/${unpaidOrd.orderId}/status`,
          { status: forbiddenTarget },
          { Authorization: `Bearer ${kiosk2Token}` }
        );
        assert.strictEqual(res.status, 403, `Kiosk must get 403 when setting unpaid order to ${forbiddenTarget}`);
      }
      assert.strictEqual(ordersCol.get(unpaidOrd.orderId).status, 'PENDING');
      assert.strictEqual(machineCol.get('CFX-MC-02').estimated_inventory.water_level, waterStart);

      // Existing successful payment flow: /payments/verify -> PAID -> PREPARING -> COMPLETED
      const payId = 'pay_legit_flow_1';
      const verifyOk = await api(
        'POST',
        '/payments/verify',
        {
          order_id: unpaidOrd.orderId,
          razorpay_order_id: unpaidOrd.razorpayOrderId,
          razorpay_payment_id: payId,
          razorpay_signature: signCheckoutPayment(unpaidOrd.razorpayOrderId, payId)
        },
        { Authorization: `Bearer ${kiosk2Token}` }
      );
      assert.strictEqual(verifyOk.status, 200);
      assert.strictEqual(verifyOk.data.data.status, 'PAID');
      assert.strictEqual(machineCol.get('CFX-MC-02').estimated_inventory.water_level, waterStart - 5);

      // Customer CANNOT downgrade PAID -> CANCELLED / FAILED / PENDING
      for (const badStatus of ['CANCELLED', 'FAILED', 'PENDING']) {
        const res = await api(
          'PUT',
          `/orders/${unpaidOrd.orderId}/status`,
          { status: badStatus },
          { Authorization: `Bearer ${kiosk2Token}` }
        );
        assert.strictEqual(res.status, 403, `Kiosk must get 403 trying to set PAID order to ${badStatus}`);
      }
      assert.strictEqual(ordersCol.get(unpaidOrd.orderId).status, 'PAID');

      // Preserved dispense progression PAID -> PREPARING -> COMPLETED
      assert.strictEqual(
        (await api('PUT', `/orders/${unpaidOrd.orderId}/status`, { status: 'PREPARING' }, { Authorization: `Bearer ${kiosk2Token}` })).status,
        200
      );
      assert.strictEqual(
        (await api('PUT', `/orders/${unpaidOrd.orderId}/status`, { status: 'COMPLETED' }, { Authorization: `Bearer ${kiosk2Token}` })).status,
        200
      );
      assert.strictEqual(ordersCol.get(unpaidOrd.orderId).status, 'COMPLETED');
      assert.strictEqual(machineCol.get('CFX-MC-02').estimated_inventory.water_level, waterStart - 5);

      // Customer CANNOT change COMPLETED order status to ANYTHING
      for (const tampered of ['PENDING', 'PAID', 'PREPARING', 'FAILED', 'CANCELLED']) {
        const res = await api(
          'PUT',
          `/orders/${unpaidOrd.orderId}/status`,
          { status: tampered },
          { Authorization: `Bearer ${kiosk2Token}` }
        );
        assert.strictEqual(res.status, 403, `Kiosk must get 403 trying to alter COMPLETED order to ${tampered}`);
      }
      assert.strictEqual(
        (await api('POST', `/orders/${unpaidOrd.orderId}/cancel`, {}, { Authorization: `Bearer ${kiosk2Token}` })).status,
        409
      );
      assert.strictEqual(ordersCol.get(unpaidOrd.orderId).status, 'COMPLETED');
      assert.strictEqual(machineCol.get('CFX-MC-02').estimated_inventory.water_level, waterStart - 5);
    }
    console.log('   PASS: Customer status tampering blocked; existing payment & dispense flow preserved.');

    console.log('\nALL WAVE 3.8 FAILED & ABANDONED PAYMENT HANDLING TESTS PASSED!\n');
  } finally {
    setRazorpayClientForTesting(null);
    setFirestoreForTesting({ firestoreInstance: null, initError: null, clearStores: true });
    resetMockDatabaseForColdStartSimulation();
    if (typeof (server as any).closeAllConnections === 'function') {
      (server as any).closeAllConnections();
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

runWave38Tests().catch((err) => {
  console.error('WAVE 3.8 TESTS FAILED:', err);
  process.exitCode = 1;
});

