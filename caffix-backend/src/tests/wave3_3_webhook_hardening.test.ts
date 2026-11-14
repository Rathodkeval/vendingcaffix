import assert from 'assert';
import crypto from 'crypto';
import http from 'http';

process.env.VERCEL = '1';
process.env.VERCEL_ENV = 'production';
process.env.FIREBASE_PROJECT_ID = 'caffix-vending';
process.env.FIREBASE_CLIENT_EMAIL = 'firebase-adminsdk@caffix-vending.iam.gserviceaccount.com';
process.env.FIREBASE_PRIVATE_KEY = '-----BEGIN PRIVATE KEY-----\nWAVE3_3_TEST_KEY\n-----END PRIVATE KEY-----';
process.env.JWT_SECRET = 'caffix-test-wave3-3-jwt-secret-key-2026';
process.env.KIOSK_SECRET = 'Wave33ProdKioskSecret9988';
process.env.KIOSK_ADMIN_ENABLED = 'false';
process.env.RAZORPAY_KEY_ID = 'rzp_live_wave33testkeyid';
process.env.RAZORPAY_KEY_SECRET = 'live_wave33_key_secret_99887766';
process.env.RAZORPAY_WEBHOOK_SECRET = 'live_wave33_webhook_secret_55443322';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const app = require('../index').default;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { initDB, resetMockDatabaseForColdStartSimulation } = require('../config/db');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { setRazorpayClientForTesting } = require('../controllers/orderController');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const {
  setFirestoreForTesting,
  commitOrderTransitionInFirebase
} = require('../utils/firebase');

const PORT = 5093;
const BASE_URL = `http://127.0.0.1:${PORT}/api`;
const WEBHOOK_SECRET = process.env.RAZORPAY_WEBHOOK_SECRET as string;

/**
 * Optimistic-concurrency Firestore mock that tracks document versions and retries
 * transactions on write-after-concurrent-read conflicts (matching Cloud Firestore MVCC).
 */
class OptimisticMockFirestore {
  public collections = new Map<string, Map<string, any>>();
  private versions = new Map<string, number>();
  public transactionRetries = 0;
  public readYieldMs = 0;

  private getCol(name: string): Map<string, any> {
    let col = this.collections.get(name);
    if (!col) {
      col = new Map<string, any>();
      this.collections.set(name, col);
    }
    return col;
  }

  private docPath(colName: string, id: string): string {
    return `${colName}/${id}`;
  }

  private getVersion(path: string): number {
    return this.versions.get(path) || 0;
  }

  private bumpVersion(path: string): void {
    this.versions.set(path, this.getVersion(path) + 1);
  }

  collection(colName: string) {
    const self = this;
    const colMap = this.getCol(colName);
    return {
      doc(docId: string) {
        const id = String(docId);
        const path = self.docPath(colName, id);
        return {
          id,
          _colName: colName,
          _path: path,
          collection(subColName: string) {
            return self.collection(`${colName}/${id}/${subColName}`);
          },
          async get() {
            if (self.readYieldMs > 0) {
              await new Promise((r) => setTimeout(r, self.readYieldMs));
            }
            const has = colMap.has(id);
            const raw = colMap.get(id);
            return {
              id,
              exists: has,
              _version: self.getVersion(path),
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
            self.bumpVersion(path);
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
        const docs: Array<{ id: string; data: () => any }> = [];
        for (const [id, data] of colMap.entries()) {
          docs.push({ id, data: () => JSON.parse(JSON.stringify(data)) });
        }
        return { empty: docs.length === 0, docs, forEach: (cb: any) => docs.forEach(cb) };
      }
    };
  }

  async runTransaction<T>(fn: (tx: any) => Promise<T>): Promise<T> {
    const maxAttempts = 6;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const readSnapshots = new Map<string, number>();
      const staged: Array<{ ref: any; payload: any; opts?: { merge?: boolean } }> = [];
      const tx = {
        get: async (ref: any) => {
          const snap = await ref.get();
          readSnapshots.set(ref._path, snap._version);
          return snap;
        },
        set: (ref: any, payload: any, opts?: { merge?: boolean }) => {
          staged.push({ ref, payload, opts });
        }
      };

      const res = await fn(tx);

      // Check optimistic concurrency for all documents read in this transaction
      let conflicted = false;
      if (staged.length > 0) {
        for (const [path, versionAtRead] of readSnapshots.entries()) {
          if (this.getVersion(path) !== versionAtRead) {
            conflicted = true;
            break;
          }
        }
      }

      if (conflicted) {
        this.transactionRetries++;
        if (attempt === maxAttempts) {
          throw new Error('Firestore transaction aborted due to persistent contention');
        }
        continue;
      }

      for (const write of staged) {
        await write.ref.set(write.payload, write.opts);
      }
      return res;
    }
    throw new Error('Unreachable transaction loop');
  }
}

function signRawBytes(rawBody: string, secret: string = WEBHOOK_SECRET): string {
  return crypto.createHmac('sha256', secret).update(Buffer.from(rawBody, 'utf8')).digest('hex');
}

async function sendRawWebhook(
  rawBody: string,
  headers: Record<string, string> = {}
): Promise<{ status: number; data: any }> {
  const reqHeaders: Record<string, string> = {
    'Content-Type': 'application/json',
    ...headers
  };
  const res = await fetch(`${BASE_URL}/payments/webhook`, {
    method: 'POST',
    headers: reqHeaders,
    body: rawBody
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

async function createPendingOrder(
  firestore: OptimisticMockFirestore,
  kioskToken: string,
  rpOrderId: string
): Promise<{ orderId: string; razorpayOrderId: string; price: number }> {
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
  const res = await fetch(`${BASE_URL}/orders/create`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${kioskToken}`
    },
    body: JSON.stringify({ product_id: 1, amount: 100, machine_id: 'CFX-MC-01' })
  });
  assert.strictEqual(res.status, 201, 'Expected 201 when creating pending order');
  const json: any = await res.json();
  const orderDoc = firestore.collections.get('orders')?.get(json.data.id);
  assert.strictEqual(orderDoc?.status, 'PENDING');
  return { orderId: json.data.id, razorpayOrderId: rpOrderId, price: json.data.amount };
}

async function getKioskJwt(): Promise<string> {
  const res = await fetch(
    `${BASE_URL}/kiosk/verify?kiosk=${encodeURIComponent(process.env.KIOSK_SECRET!)}&machine_id=CFX-MC-01`
  );
  assert.strictEqual(res.status, 200);
  const json: any = await res.json();
  return json.token;
}

async function runTests() {
  const firestore = new OptimisticMockFirestore();
  const nowIso = new Date().toISOString();
  await firestore.collection('machines').doc('CFX-MC-01').set({
    id: 'CFX-MC-01',
    machine_name: 'Production Kiosk CFX-MC-01',
    location: 'Production Terminal',
    desired_mode: 'RUNNING',
    status: 'online',
    last_seen: null,
    owner_id: null,
    kiosk_token: process.env.KIOSK_SECRET,
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
  setFirestoreForTesting({ firestoreInstance: firestore, clearStores: true });
  await initDB();
  resetMockDatabaseForColdStartSimulation();

  const server: http.Server = await new Promise((resolve) => {
    const s = app.listen(PORT, '127.0.0.1', () => resolve(s));
  });

  try {
    console.log('=============================================================');
    console.log('Running Wave 3.3 Razorpay Webhook & Idempotency Tests');
    console.log('=============================================================');

    const kioskToken = await getKioskJwt();
    firestore.collection('machines');
    firestore.collection('orders');
    const machineCol = firestore.collections.get('machines')!;
    const ordersCol = firestore.collections.get('orders')!;

    // Test 1: Missing & invalid signatures
    console.log('1. Testing missing, mock, invalid, and non-JSON rawBody signatures...');
    {
      const body = JSON.stringify({ event: 'payment.captured', payload: {} });
      assert.strictEqual((await sendRawWebhook(body, {})).status, 400);
      assert.strictEqual((await sendRawWebhook(body, { 'x-razorpay-signature': 'mock' })).status, 400);
      assert.strictEqual((await sendRawWebhook(body, { 'x-razorpay-signature': 'deadbeef' })).status, 400);

      // Non-JSON content-type -> express.json does not populate req.rawBody -> fail closed 400
      const nonJsonRes = await sendRawWebhook(body, {
        'Content-Type': 'text/plain',
        'x-razorpay-signature': signRawBytes(body)
      });
      assert.strictEqual(nonJsonRes.status, 400, 'Missing req.rawBody must fail closed');
    }
    console.log('   PASS: Missing/invalid signatures rejected safely.');

    // Test 2: Raw JSON bytes with whitespace differences (pretty-printed multiline JSON)
    console.log('2. Testing exact raw JSON bytes with whitespace differences...');
    {
      const initialWater = machineCol.get('CFX-MC-01').estimated_inventory.water_level;
      const order = await createPendingOrder(firestore, kioskToken, 'order_live_ws_001');
      const prettyPayload =
        '{\n  "event":   "payment.captured",\n  "payload": {\n    "payment": {\n      "entity": {\n        "id": "pay_ws_001",\n        "order_id": "' +
        order.razorpayOrderId +
        '"\n      }\n    }\n  }\n}\n';
      // Ensure JSON.stringify differs from raw wire bytes!
      assert.notStrictEqual(prettyPayload, JSON.stringify(JSON.parse(prettyPayload)));

      const res = await sendRawWebhook(prettyPayload, {
        'x-razorpay-signature': signRawBytes(prettyPayload)
      });
      assert.strictEqual(res.status, 200, 'Pretty-printed raw bytes signature must succeed');
      assert.strictEqual(ordersCol.get(order.orderId).status, 'PAID');
      assert.strictEqual(ordersCol.get(order.orderId).dispense_status, 'QUEUED');
      assert.strictEqual(
        machineCol.get('CFX-MC-01').estimated_inventory.water_level,
        initialWater - 5,
        'Inventory deducted exactly once'
      );
    }
    console.log('   PASS: Exact raw-byte HMAC succeeded despite whitespace formatting.');

    // Test 3: Raw JSON bytes with key ordering differences + valid order.paid
    console.log('3. Testing exact raw JSON bytes with JSON key ordering differences...');
    {
      const initialWater = machineCol.get('CFX-MC-01').estimated_inventory.water_level;
      const order = await createPendingOrder(firestore, kioskToken, 'order_live_keyorder_002');
      // Wire bytes put payload BEFORE event and order_id BEFORE id (differs from canonical key order)
      const canonicalRaw = `{"event":"order.paid","payload":{"payment":{"entity":{"id":"pay_key_002","order_id":"${order.razorpayOrderId}"}},"order":{"entity":{"id":"${order.razorpayOrderId}"}}}}`;
      const reorderedRaw = `{"payload":{"order":{"entity":{"id":"${order.razorpayOrderId}"}},"payment":{"entity":{"order_id":"${order.razorpayOrderId}","id":"pay_key_002"}}},"event":"order.paid"}`;
      assert.notStrictEqual(reorderedRaw, canonicalRaw);
      assert.deepStrictEqual(JSON.parse(reorderedRaw), JSON.parse(canonicalRaw));

      // Sending canonical-order signature with reordered wire bytes must fail (proves raw bytes are verified)
      const mismatchedSigRes = await sendRawWebhook(reorderedRaw, {
        'x-razorpay-signature': signRawBytes(canonicalRaw)
      });
      assert.strictEqual(mismatchedSigRes.status, 400, 'Signature from different key order must fail');
      assert.strictEqual(ordersCol.get(order.orderId).status, 'PENDING');

      // Sending signature computed over exact reordered wire bytes must succeed
      const res = await sendRawWebhook(reorderedRaw, {
        'x-razorpay-signature': signRawBytes(reorderedRaw)
      });
      assert.strictEqual(res.status, 200, 'Reordered JSON keys signed over exact wire bytes must pass');
      assert.strictEqual(ordersCol.get(order.orderId).status, 'PAID');
      assert.strictEqual(ordersCol.get(order.orderId).dispense_status, 'QUEUED');
      assert.strictEqual(
        machineCol.get('CFX-MC-01').estimated_inventory.water_level,
        initialWater - 5
      );
    }
    console.log('   PASS: Reordered JSON keys raw-byte HMAC verified cleanly.');

    // Test 4: Duplicate order.paid, duplicate payment.captured, and both arriving sequentially
    console.log('4. Testing duplicate order.paid, duplicate payment.captured, and both sequential events...');
    {
      const initialWater = machineCol.get('CFX-MC-01').estimated_inventory.water_level;
      const orderA = await createPendingOrder(firestore, kioskToken, 'order_live_dup_a');

      const orderPaidBody = JSON.stringify({
        event: 'order.paid',
        payload: { payment: { entity: { id: 'pay_dup_a1', order_id: orderA.razorpayOrderId } } }
      });
      const capturedBody = JSON.stringify({
        event: 'payment.captured',
        payload: { payment: { entity: { id: 'pay_dup_a1', order_id: orderA.razorpayOrderId } } }
      });

      assert.strictEqual(
        (await sendRawWebhook(orderPaidBody, { 'x-razorpay-signature': signRawBytes(orderPaidBody) })).status,
        200
      );
      // Duplicate order.paid
      assert.strictEqual(
        (await sendRawWebhook(orderPaidBody, { 'x-razorpay-signature': signRawBytes(orderPaidBody) })).status,
        200
      );
      // Followed by payment.captured and another duplicate payment.captured
      assert.strictEqual(
        (await sendRawWebhook(capturedBody, { 'x-razorpay-signature': signRawBytes(capturedBody) })).status,
        200
      );
      assert.strictEqual(
        (await sendRawWebhook(capturedBody, { 'x-razorpay-signature': signRawBytes(capturedBody) })).status,
        200
      );

      assert.strictEqual(
        machineCol.get('CFX-MC-01').estimated_inventory.water_level,
        initialWater - 5,
        'Duplicate + cross-event webhooks must deduct inventory only once'
      );
      assert.strictEqual(ordersCol.get(orderA.orderId).status, 'PAID');
      assert.strictEqual(ordersCol.get(orderA.orderId).dispense_status, 'QUEUED');

      // Reverse order: payment.captured first, then order.paid
      const waterBeforeB = machineCol.get('CFX-MC-01').estimated_inventory.water_level;
      const orderB = await createPendingOrder(firestore, kioskToken, 'order_live_dup_b');
      const capturedB = JSON.stringify({
        event: 'payment.captured',
        payload: { payment: { entity: { id: 'pay_dup_b1', order_id: orderB.razorpayOrderId } } }
      });
      const orderPaidB = JSON.stringify({
        event: 'order.paid',
        payload: { payment: { entity: { id: 'pay_dup_b1', order_id: orderB.razorpayOrderId } } }
      });
      assert.strictEqual(
        (await sendRawWebhook(capturedB, { 'x-razorpay-signature': signRawBytes(capturedB) })).status,
        200
      );
      assert.strictEqual(
        (await sendRawWebhook(orderPaidB, { 'x-razorpay-signature': signRawBytes(orderPaidB) })).status,
        200
      );
      assert.strictEqual(
        machineCol.get('CFX-MC-01').estimated_inventory.water_level,
        waterBeforeB - 5
      );
    }
    console.log('   PASS: Sequential duplicate and cross-event webhooks deduplicated.');

    // Test 5: Concurrent HTTP delivery AND direct cross-instance Firestore MVCC transaction contention
    console.log('5. Testing concurrent delivery & cross-instance Firestore transaction idempotency...');
    {
      const waterBeforeHttpRace = machineCol.get('CFX-MC-01').estimated_inventory.water_level;
      const orderRace = await createPendingOrder(firestore, kioskToken, 'order_live_race_http');
      const rawPaid = JSON.stringify({
        event: 'order.paid',
        payload: { payment: { entity: { id: 'pay_race_1', order_id: orderRace.razorpayOrderId } } }
      });
      const rawCaptured = JSON.stringify({
        event: 'payment.captured',
        payload: { payment: { entity: { id: 'pay_race_1', order_id: orderRace.razorpayOrderId } } }
      });

      const [r1, r2, r3] = await Promise.all([
        sendRawWebhook(rawPaid, { 'x-razorpay-signature': signRawBytes(rawPaid) }),
        sendRawWebhook(rawCaptured, { 'x-razorpay-signature': signRawBytes(rawCaptured) }),
        sendRawWebhook(rawCaptured, { 'x-razorpay-signature': signRawBytes(rawCaptured) })
      ]);
      assert.strictEqual(r1.status, 200);
      assert.strictEqual(r2.status, 200);
      assert.strictEqual(r3.status, 200);
      assert.strictEqual(
        machineCol.get('CFX-MC-01').estimated_inventory.water_level,
        waterBeforeHttpRace - 5,
        'Concurrent HTTP webhooks must only deduct inventory once'
      );

      // Direct cross-instance simulation bypassing in-process mutex (two Vercel instances simultaneously)
      const waterBeforeCrossInstance = machineCol.get('CFX-MC-01').estimated_inventory.water_level;
      const orderCross = await createPendingOrder(firestore, kioskToken, 'order_live_cross_inst');
      const storedOrderCross = ordersCol.get(orderCross.orderId);
      firestore.readYieldMs = 15;
      const retriesBefore = firestore.transactionRetries;
      try {
        const reqs = {
          water: 5,
          coffee: 6,
          milk: 5,
          vanilla: 0,
          hazelnut: 0,
          irish: 0,
          mocha: 0
        };
        const [txA, txB] = await Promise.all([
          commitOrderTransitionInFirebase({
            order: { ...storedOrderCross },
            targetStatus: 'PAID',
            productName: 'Classic Crest',
            razorpayPaymentId: 'pay_cross_1',
            razorpaySignature: 'sig_cross_1',
            requirements: reqs,
            fallbackInventory: machineCol.get('CFX-MC-01').estimated_inventory
          }),
          commitOrderTransitionInFirebase({
            order: { ...storedOrderCross },
            targetStatus: 'PAID',
            productName: 'Classic Crest',
            razorpayPaymentId: 'pay_cross_1',
            razorpaySignature: 'sig_cross_2',
            requirements: reqs,
            fallbackInventory: machineCol.get('CFX-MC-01').estimated_inventory
          })
        ]);
        const winners = [txA, txB].filter((t) => t && t.didTransitionFromPendingToActive && !t.alreadyProcessed);
        const skipped = [txA, txB].filter((t) => t && t.alreadyProcessed);
        assert.strictEqual(winners.length, 1, 'Exactly one serverless instance may win PENDING -> PAID');
        assert.strictEqual(skipped.length, 1, 'Contending instance must retry and see alreadyProcessed=true');
        assert.ok(firestore.transactionRetries > retriesBefore, 'Simulated MVCC contention retry must have occurred');
        assert.strictEqual(
          machineCol.get('CFX-MC-01').estimated_inventory.water_level,
          waterBeforeCrossInstance - 5,
          'Cross-instance race must deduct estimated_inventory only once'
        );
      } finally {
        firestore.readYieldMs = 0;
      }
    }
    console.log('   PASS: Concurrent webhook & cross-instance Firestore contention verified.');

    // Test 6: Preserve DISPENSING & DISPENSED states and prevent duplicate dispense queuing
    console.log('6. Testing DISPENSING & DISPENSED preservation on late webhooks...');
    {
      const waterStart = machineCol.get('CFX-MC-01').estimated_inventory.water_level;

      // Case A: Already PAID + DISPENSING in Firestore
      const dispensingOrder = await createPendingOrder(firestore, kioskToken, 'order_live_dispensing');
      const dBody = JSON.stringify({
        event: 'payment.captured',
        payload: { payment: { entity: { id: 'pay_disp_1', order_id: dispensingOrder.razorpayOrderId } } }
      });
      await sendRawWebhook(dBody, { 'x-razorpay-signature': signRawBytes(dBody) });
      // Simulate Raspberry Pi claiming the order for dispensing
      const dDoc = ordersCol.get(dispensingOrder.orderId);
      await firestore
        .collection('orders')
        .doc(dispensingOrder.orderId)
        .set({ ...dDoc, dispense_status: 'DISPENSING', dispensed: false }, { merge: true });

      const lateOrderPaid = JSON.stringify({
        event: 'order.paid',
        payload: { payment: { entity: { id: 'pay_disp_1', order_id: dispensingOrder.razorpayOrderId } } }
      });
      const resLateDispensing = await sendRawWebhook(lateOrderPaid, {
        'x-razorpay-signature': signRawBytes(lateOrderPaid)
      });
      assert.strictEqual(resLateDispensing.status, 200);
      assert.strictEqual(
        ordersCol.get(dispensingOrder.orderId).dispense_status,
        'DISPENSING',
        'DISPENSING must never be reset back to QUEUED'
      );

      // Case B: Already DISPENSED + COMPLETED in Firestore (or even if status were stale PENDING while dispensed=true)
      const dispensedOrder = await createPendingOrder(firestore, kioskToken, 'order_live_dispensed');
      const existingDispensedDoc = ordersCol.get(dispensedOrder.orderId);
      await firestore
        .collection('orders')
        .doc(dispensedOrder.orderId)
        .set(
          {
            ...existingDispensedDoc,
            status: 'COMPLETED',
            dispense_status: 'DISPENSED',
            dispensed: true
          },
          { merge: true }
        );
      const lateForDispensed = JSON.stringify({
        event: 'order.paid',
        payload: { payment: { entity: { id: 'pay_disp_2', order_id: dispensedOrder.razorpayOrderId } } }
      });
      const resLateDispensed = await sendRawWebhook(lateForDispensed, {
        'x-razorpay-signature': signRawBytes(lateForDispensed)
      });
      assert.strictEqual(resLateDispensed.status, 200);
      assert.strictEqual(ordersCol.get(dispensedOrder.orderId).status, 'COMPLETED');
      assert.strictEqual(ordersCol.get(dispensedOrder.orderId).dispense_status, 'DISPENSED');
      assert.strictEqual(ordersCol.get(dispensedOrder.orderId).dispensed, true);

      // Edge Case C: status still 'PENDING' but Raspberry Pi flags DISPENSING already present -> never reset to QUEUED or deduct again
      const stalePendingDispensing = await createPendingOrder(firestore, kioskToken, 'order_live_stale_disp');
      await firestore
        .collection('orders')
        .doc(stalePendingDispensing.orderId)
        .set(
          {
            ...ordersCol.get(stalePendingDispensing.orderId),
            dispense_status: 'DISPENSING',
            dispensed: true
          },
          { merge: true }
        );
      const staleWebhook = JSON.stringify({
        event: 'payment.captured',
        payload: { payment: { entity: { id: 'pay_stale_1', order_id: stalePendingDispensing.razorpayOrderId } } }
      });
      const resStale = await sendRawWebhook(staleWebhook, {
        'x-razorpay-signature': signRawBytes(staleWebhook)
      });
      assert.strictEqual(resStale.status, 200);
      assert.strictEqual(ordersCol.get(stalePendingDispensing.orderId).dispense_status, 'DISPENSING');
      assert.strictEqual(ordersCol.get(stalePendingDispensing.orderId).dispensed, true);

      // Only dispensingOrder deducted once (-5 water); dispensed & already-dispensing stale orders must NOT deduct again
      assert.strictEqual(
        machineCol.get('CFX-MC-01').estimated_inventory.water_level,
        waterStart - 5,
        'Already DISPENSING/DISPENSED orders must never deduct inventory again'
      );
    }
    console.log('   PASS: DISPENSING & DISPENSED states preserved without duplicate dispensing or deduction.');

    // Test 7: Unknown / unsupported events (e.g. payment.authorized, refund.created) safely ignored
    console.log('7. Testing unsupported events (payment.authorized, refund.created) safely acknowledged...');
    {
      const waterBefore = machineCol.get('CFX-MC-01').estimated_inventory.water_level;
      const pendingOrder = await createPendingOrder(firestore, kioskToken, 'order_live_unsupported_ignored');

      for (const evt of ['payment.authorized', 'refund.created']) {
        const rawEvt = JSON.stringify({
          event: evt,
          payload: { payment: { entity: { id: 'pay_ignored_1', order_id: pendingOrder.razorpayOrderId } } }
        });
        const r = await sendRawWebhook(rawEvt, { 'x-razorpay-signature': signRawBytes(rawEvt) });
        assert.strictEqual(r.status, 200);
        assert.strictEqual(r.data.status, 'ok');
      }

      assert.strictEqual(ordersCol.get(pendingOrder.orderId).status, 'PENDING');
      assert.strictEqual(machineCol.get('CFX-MC-01').estimated_inventory.water_level, waterBefore);
    }
    console.log('   PASS: Unsupported events acknowledged cleanly with zero state mutation.');

    console.log('\nALL WAVE 3.3 RAZORPAY WEBHOOK HARDENING TESTS PASSED!');
  } finally {
    setRazorpayClientForTesting(null);
    setFirestoreForTesting({ firestoreInstance: null, initError: null, clearStores: true });
    if (typeof (server as any).closeAllConnections === 'function') {
      (server as any).closeAllConnections();
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

runTests().catch((err) => {
  console.error('Wave 3.3 test failed:', err);
  process.exitCode = 1;
});
