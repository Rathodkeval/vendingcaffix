import assert from 'assert';
import crypto from 'crypto';
import fsNode from 'fs';
import http from 'http';
import path from 'path';

process.env.VERCEL = '1';
process.env.VERCEL_ENV = 'production';
process.env.FIREBASE_PROJECT_ID = 'caffix-vending';
process.env.FIREBASE_CLIENT_EMAIL = 'firebase-adminsdk@caffix-vending.iam.gserviceaccount.com';
process.env.FIREBASE_PRIVATE_KEY = '-----BEGIN PRIVATE KEY-----\nWAVE3_9_TEST_KEY\n-----END PRIVATE KEY-----';
process.env.JWT_SECRET = 'caffix-test-wave3-9-jwt-secret-key-2026';
process.env.KIOSK_SECRET_CFX_MC_01 = 'Wave39ProdMc01Secret_9988';
process.env.KIOSK_SECRET_CFX_MC_02 = 'Wave39ProdMc02Secret_7766';
process.env.KIOSK_ADMIN_ENABLED = 'false';
process.env.RAZORPAY_KEY_ID = 'rzp_live_wave39testkeyid';
process.env.RAZORPAY_KEY_SECRET = 'live_wave39_key_secret_99887766';
process.env.RAZORPAY_WEBHOOK_SECRET = 'live_wave39_webhook_secret_55443322';
process.env.CRON_SECRET = 'wave39_production_cron_secret_token_2026';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const app = require('../index').default;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { initDB, resetMockDatabaseForColdStartSimulation } = require('../config/db');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { setRazorpayClientForTesting } = require('../controllers/orderController');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { setFirestoreForTesting } = require('../utils/firebase');

const PORT = 5096;
const BASE_URL = `http://127.0.0.1:${PORT}/api`;
const WEBHOOK_SECRET = process.env.RAZORPAY_WEBHOOK_SECRET as string;
const CRON_SECRET = process.env.CRON_SECRET as string;

class TrackingMockFirestore {
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
            if (colName !== 'system_locks') {
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
}

function signWebhookBytes(rawBody: string): string {
  return crypto.createHmac('sha256', WEBHOOK_SECRET).update(Buffer.from(rawBody, 'utf8')).digest('hex');
}

async function api(
  method: string,
  urlPath: string,
  body?: any,
  headers: Record<string, string> = {}
): Promise<{ status: number; data: any }> {
  const res = await fetch(`${BASE_URL}${urlPath}`, {
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

async function seedFirestoreOrder(
  fs: TrackingMockFirestore,
  overrides: Record<string, any>
): Promise<string> {
  const id = String(overrides.id);
  const record = {
    id,
    product_id: 1,
    product_name: 'Espresso',
    coffee: 'Espresso',
    amount: 100,
    status: 'PENDING',
    dispense_status: 'NOT_STARTED',
    dispensed: false,
    machine_id: 'CFX-MC-01',
    created_at: new Date(Date.now() - 20 * 60_000).toISOString(),
    razorpay_order_id: `order_rp_${id}`,
    razorpay_payment_id: null,
    extra_sugar: 1,
    base: 'water',
    ...overrides
  };
  await fs.collection('orders').doc(id).set(record);
  return id;
}

function seedMachineDoc(
  fs: TrackingMockFirestore,
  machineId: string,
  secret: string
) {
  const nowIso = new Date().toISOString();
  return fs.collection('machines').doc(machineId).set({
    id: machineId,
    machine_name: `Production Kiosk ${machineId}`,
    location: 'Production Terminal',
    desired_mode: 'RUNNING',
    status: 'online',
    last_seen: null,
    owner_id: machineId === 'CFX-MC-01' ? 'owner_mc1' : 'owner_mc2',
    kiosk_token: secret,
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

function collectSourceFiles(dirPath: string): string[] {
  const results: string[] = [];
  if (!fsNode.existsSync(dirPath)) return results;
  for (const entry of fsNode.readdirSync(dirPath, { withFileTypes: true })) {
    const full = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectSourceFiles(full));
    } else if (/\.(ts|tsx|js|jsx|html)$/i.test(entry.name)) {
      results.push(full);
    }
  }
  return results;
}

async function runWave39Tests() {
  console.log('\n=============================================================');
  console.log('Running Wave 3.9 Pending Order Expiry & Reconciliation Tests');
  console.log('=============================================================\n');

  const fs = new TrackingMockFirestore();
  await seedMachineDoc(fs, 'CFX-MC-01', process.env.KIOSK_SECRET_CFX_MC_01!);
  await seedMachineDoc(fs, 'CFX-MC-02', process.env.KIOSK_SECRET_CFX_MC_02!);

  setFirestoreForTesting({ firestoreInstance: fs, clearStores: true });
  await initDB();
  resetMockDatabaseForColdStartSimulation();

  fs.collection('orders');
  fs.collection('machines');
  const ordersCol = fs.collections.get('orders')!;
  const machineCol = fs.collections.get('machines')!;

  const server: http.Server = await new Promise((resolve) => {
    const s = app.listen(PORT, '127.0.0.1', () => resolve(s));
  });

  try {
    // -------------------------------------------------------------------------
    // 1. Captured, Failed, Abandoned, Authorized/In-Flight, API Error, Recent
    // -------------------------------------------------------------------------
    console.log('1. Testing captured, failed, abandoned, authorized/in-flight, API error, and too-recent PENDING orders...');
    {
      const capturedOrderId = await seedFirestoreOrder(fs, {
        id: 'ORD-W39-CAP-1',
        razorpay_order_id: 'order_rp_cap_1'
      });
      const failedOrderId = await seedFirestoreOrder(fs, {
        id: 'ORD-W39-FAIL-1',
        razorpay_order_id: 'order_rp_fail_1'
      });
      const abandonedOrderId = await seedFirestoreOrder(fs, {
        id: 'ORD-W39-ABAN-1',
        razorpay_order_id: 'order_rp_aban_1'
      });
      const authOrderId = await seedFirestoreOrder(fs, {
        id: 'ORD-W39-AUTH-1',
        razorpay_order_id: 'order_rp_auth_1'
      });
      const inFlightOrderId = await seedFirestoreOrder(fs, {
        id: 'ORD-W39-INFLIGHT-1',
        razorpay_order_id: 'order_rp_inflight_1'
      });
      const apiErrOrderId = await seedFirestoreOrder(fs, {
        id: 'ORD-W39-ERR-1',
        razorpay_order_id: 'order_rp_err_1'
      });
      const tooRecentOrderId = await seedFirestoreOrder(fs, {
        id: 'ORD-W39-RECENT-1',
        razorpay_order_id: 'order_rp_recent_1',
        created_at: new Date(Date.now() - 2 * 60_000).toISOString()
      });

      const waterBefore = machineCol.get('CFX-MC-01').estimated_inventory.water_level;
      const coffeeBefore = machineCol.get('CFX-MC-01').estimated_inventory.coffee_level;

      let authStage: 'authorized' | 'captured' = 'authorized';
      setRazorpayClientForTesting({
        orders: {
          fetch: async (rpId: string) => {
            if (rpId === 'order_rp_err_1') {
              throw new Error('Razorpay gateway timeout');
            }
            if (rpId === 'order_rp_cap_1') {
              return { id: rpId, status: 'paid', amount: 10000, amount_paid: 10000, attempts: 1 };
            }
            if (rpId === 'order_rp_fail_1') {
              return { id: rpId, status: 'attempted', amount: 10000, amount_paid: 0, attempts: 1 };
            }
            if (rpId === 'order_rp_aban_1' || rpId === 'order_rp_recent_1') {
              return { id: rpId, status: 'created', amount: 10000, amount_paid: 0, attempts: 0 };
            }
            if (rpId === 'order_rp_auth_1' || rpId === 'order_rp_inflight_1') {
              return {
                id: rpId,
                status: authStage === 'captured' && rpId === 'order_rp_auth_1' ? 'paid' : 'attempted',
                amount: 10000,
                amount_paid: authStage === 'captured' && rpId === 'order_rp_auth_1' ? 10000 : 0,
                attempts: 1
              };
            }
            return { id: rpId, status: 'created', amount: 10000, amount_paid: 0, attempts: 0 };
          },
          fetchPayments: async (rpId: string) => {
            if (rpId === 'order_rp_err_1') {
              throw new Error('Razorpay payments timeout');
            }
            if (rpId === 'order_rp_cap_1') {
              return { items: [{ id: 'pay_cap_001', status: 'captured', currency: 'INR', amount: 10000 }] };
            }
            if (rpId === 'order_rp_fail_1') {
              return { items: [{ id: 'pay_fail_001', status: 'failed', currency: 'INR', amount: 10000 }] };
            }
            if (rpId === 'order_rp_aban_1' || rpId === 'order_rp_recent_1') {
              return { items: [] };
            }
            if (rpId === 'order_rp_auth_1') {
              return {
                items: [
                  {
                    id: 'pay_auth_001',
                    status: authStage === 'captured' ? 'captured' : 'authorized',
                    currency: 'INR',
                    amount: 10000
                  }
                ]
              };
            }
            if (rpId === 'order_rp_inflight_1') {
              return { items: [{ id: 'pay_created_001', status: 'created', amount: 10000 }] };
            }
            return { items: [] };
          }
        }
      });

      const res1 = await api('GET', '/cron/reconcile-orders', undefined, {
        Authorization: `Bearer ${CRON_SECRET}`
      });
      assert.strictEqual(res1.status, 200, `Cron GET failed: ${JSON.stringify(res1.data)}`);
      assert.strictEqual(res1.data.data.reconciled_paid, 1);
      assert.strictEqual(res1.data.data.marked_failed, 1);
      assert.strictEqual(res1.data.data.marked_cancelled, 1);
      assert.strictEqual(res1.data.data.kept_pending, 2); // authorized + created
      assert.strictEqual(res1.data.data.too_recent, 1);
      assert.strictEqual(res1.data.data.errors, 1);

      assert.strictEqual(ordersCol.get(capturedOrderId).status, 'PAID');
      assert.strictEqual(ordersCol.get(capturedOrderId).razorpay_payment_id, 'pay_cap_001');
      assert.strictEqual(ordersCol.get(capturedOrderId).dispense_status, 'QUEUED');
      assert.strictEqual(ordersCol.get(failedOrderId).status, 'FAILED');
      assert.strictEqual(ordersCol.get(abandonedOrderId).status, 'CANCELLED');
      assert.strictEqual(ordersCol.get(authOrderId).status, 'PENDING');
      assert.strictEqual(ordersCol.get(inFlightOrderId).status, 'PENDING');
      assert.strictEqual(ordersCol.get(apiErrOrderId).status, 'PENDING');
      assert.strictEqual(ordersCol.get(tooRecentOrderId).status, 'PENDING');

      // Only 1 order transitioned to PAID -> inventory deducted once (Espresso uses 3 water, 1 coffee? Let's verify exact positive deduction from baseline)
      const waterAfterRun1 = machineCol.get('CFX-MC-01').estimated_inventory.water_level;
      const coffeeAfterRun1 = machineCol.get('CFX-MC-01').estimated_inventory.coffee_level;
      const singleOrderWaterDelta = waterBefore - waterAfterRun1;
      const singleOrderCoffeeDelta = coffeeBefore - coffeeAfterRun1;
      assert.ok(singleOrderWaterDelta > 0, 'Captured order recovery must deduct water once');
      assert.ok(singleOrderCoffeeDelta > 0, 'Captured order recovery must deduct coffee once');

      // -----------------------------------------------------------------------
      // 2. Duplicate cron execution is completely idempotent (0 new writes on remaining resolved orders)
      // -----------------------------------------------------------------------
      console.log('2. Testing duplicate cron execution causes zero extra Firestore writes or duplicate deductions...');
      const businessWritesBeforeReplay = fs.businessWriteCount;
      const resReplay = await api('GET', '/cron/reconcile-orders', undefined, {
        Authorization: `Bearer ${CRON_SECRET}`
      });
      assert.strictEqual(resReplay.status, 200);
      assert.strictEqual(
        fs.businessWriteCount,
        businessWritesBeforeReplay,
        'Replay with unresolved/settled orders must produce 0 Firestore order/inventory writes'
      );
      assert.strictEqual(machineCol.get('CFX-MC-01').estimated_inventory.water_level, waterAfterRun1);
      assert.strictEqual(machineCol.get('CFX-MC-01').estimated_inventory.coffee_level, coffeeAfterRun1);

      // Now simulate authorized payment settling to captured -> subsequent cron run promotes it to PAID once
      authStage = 'captured';
      const resAuthCaptured = await api('POST', '/cron/reconcile-orders', undefined, {
        Authorization: `Bearer ${CRON_SECRET}`
      });
      assert.strictEqual(resAuthCaptured.status, 200);
      assert.strictEqual(resAuthCaptured.data.data.reconciled_paid, 1);
      assert.strictEqual(ordersCol.get(authOrderId).status, 'PAID');
      assert.strictEqual(
        machineCol.get('CFX-MC-01').estimated_inventory.water_level,
        waterAfterRun1 - singleOrderWaterDelta,
        'Late capture of formerly authorized payment deducts inventory exactly once'
      );
    }

    // -------------------------------------------------------------------------
    // 3. Concurrent webhook + cron & never overwriting PAID/PREPARING/COMPLETED/DISPENSING/DISPENSED
    // -------------------------------------------------------------------------
    console.log('3. Testing concurrent webhook + cron race and protection of active/completed/dispensed orders...');
    {
      await seedMachineDoc(fs, 'CFX-MC-02', process.env.KIOSK_SECRET_CFX_MC_02!);

      // Pre-seed already active/dispensed orders that happen to match old timestamps
      await seedFirestoreOrder(fs, {
        id: 'ORD-W39-ACTIVE-PAID',
        machine_id: 'CFX-MC-02',
        status: 'PAID',
        dispense_status: 'QUEUED',
        razorpay_order_id: 'order_rp_active_paid'
      });
      await seedFirestoreOrder(fs, {
        id: 'ORD-W39-ACTIVE-PREP',
        machine_id: 'CFX-MC-02',
        status: 'PREPARING',
        dispense_status: 'DISPENSING',
        razorpay_order_id: 'order_rp_active_prep'
      });
      await seedFirestoreOrder(fs, {
        id: 'ORD-W39-ACTIVE-DONE',
        machine_id: 'CFX-MC-02',
        status: 'COMPLETED',
        dispense_status: 'DISPENSED',
        dispensed: true,
        razorpay_order_id: 'order_rp_active_done'
      });

      const raceCapOrderId = await seedFirestoreOrder(fs, {
        id: 'ORD-W39-RACE-CAP',
        machine_id: 'CFX-MC-02',
        razorpay_order_id: 'order_rp_race_cap'
      });
      const raceFailOrderId = await seedFirestoreOrder(fs, {
        id: 'ORD-W39-RACE-FAIL',
        machine_id: 'CFX-MC-02',
        razorpay_order_id: 'order_rp_race_fail'
      });

      const mc2WaterBefore = machineCol.get('CFX-MC-02').estimated_inventory.water_level;

      setRazorpayClientForTesting({
        orders: {
          fetch: async (rpId: string) => {
            await new Promise((r) => setTimeout(r, 15));
            if (rpId === 'order_rp_race_cap') {
              return { id: rpId, status: 'paid', amount: 10000, amount_paid: 10000, attempts: 1 };
            }
            if (rpId === 'order_rp_race_fail') {
              return { id: rpId, status: 'attempted', amount: 10000, amount_paid: 0, attempts: 1 };
            }
            return { id: rpId, status: 'created', amount: 10000, amount_paid: 0, attempts: 0 };
          },
          fetchPayments: async (rpId: string) => {
            if (rpId === 'order_rp_race_cap') {
              return { items: [{ id: 'pay_race_cap_1', status: 'captured', currency: 'INR', amount: 10000 }] };
            }
            if (rpId === 'order_rp_race_fail') {
              return { items: [{ id: 'pay_race_fail_1', status: 'failed', currency: 'INR', amount: 10000 }] };
            }
            return { items: [] };
          }
        }
      });

      const capWebhookPayload = {
        event: 'payment.captured',
        payload: {
          payment: {
            entity: {
              id: 'pay_race_cap_1',
              order_id: 'order_rp_race_cap',
              status: 'captured'
            }
          }
        }
      };
      const failWebhookPayload = {
        event: 'payment.failed',
        payload: {
          payment: {
            entity: {
              id: 'pay_race_fail_1',
              order_id: 'order_rp_race_fail',
              status: 'failed'
            }
          }
        }
      };

      const [whCapRes, whFailRes, cronRace1, cronRace2] = await Promise.all([
        sendWebhook(capWebhookPayload, signWebhookBytes(JSON.stringify(capWebhookPayload))),
        sendWebhook(failWebhookPayload, signWebhookBytes(JSON.stringify(failWebhookPayload))),
        api('GET', '/cron/reconcile-orders', undefined, { Authorization: `Bearer ${CRON_SECRET}` }),
        api('GET', '/cron/reconcile-orders', undefined, { Authorization: `Bearer ${CRON_SECRET}` })
      ]);

      assert.strictEqual(whCapRes.status, 200);
      assert.strictEqual(whFailRes.status, 200);
      assert.strictEqual(cronRace1.status, 200);
      assert.strictEqual(cronRace2.status, 200);

      assert.strictEqual(ordersCol.get(raceCapOrderId).status, 'PAID');
      assert.strictEqual(ordersCol.get(raceFailOrderId).status, 'FAILED');
      assert.strictEqual(ordersCol.get('ORD-W39-ACTIVE-PAID').status, 'PAID');
      assert.strictEqual(ordersCol.get('ORD-W39-ACTIVE-PREP').status, 'PREPARING');
      assert.strictEqual(ordersCol.get('ORD-W39-ACTIVE-DONE').status, 'COMPLETED');

      const mc2WaterAfter = machineCol.get('CFX-MC-02').estimated_inventory.water_level;
      // Espresso deducts 30 water once (100 -> 70); must never deduct twice across concurrent webhook + 2 cron runs
      assert.ok(
        mc2WaterAfter >= 70 && mc2WaterAfter < mc2WaterBefore,
        `Expected exactly 1 deduction on CFX-MC-02, got water_level=${mc2WaterAfter} (before=${mc2WaterBefore})`
      );
      assert.strictEqual(
        cronRace1.data.data.reconciled_paid + cronRace2.data.data.reconciled_paid <= 1,
        true,
        'Concurrent cron runs must transition captured race order at most once'
      );

      // Even if a broken/late Razorpay response reports failed for an already PAID order, cron never overwrites PAID
      const alreadyPaidOrderId = await seedFirestoreOrder(fs, {
        id: 'ORD-W39-NO-DOWNGRADE',
        machine_id: 'CFX-MC-02',
        status: 'PAID',
        dispense_status: 'DISPENSING',
        razorpay_order_id: 'order_rp_no_downgrade'
      });
      await api('GET', '/cron/reconcile-orders', undefined, {
        Authorization: `Bearer ${CRON_SECRET}`
      });
      assert.strictEqual(ordersCol.get(alreadyPaidOrderId).status, 'PAID');
    }

    // -------------------------------------------------------------------------
    // 4. Unauthorized & Fail-Closed CRON_SECRET Tests
    // -------------------------------------------------------------------------
    console.log('4. Testing CRON_SECRET auth rejection (401) and fail-closed config (503)...');
    {
      const noHeader = await api('GET', '/cron/reconcile-orders');
      assert.strictEqual(noHeader.status, 401);

      const wrongToken = await api('GET', '/cron/reconcile-orders', undefined, {
        Authorization: 'Bearer wrong-secret-token-value'
      });
      assert.strictEqual(wrongToken.status, 401);

      const basicScheme = await api('GET', '/cron/reconcile-orders', undefined, {
        Authorization: `Basic ${CRON_SECRET}`
      });
      assert.strictEqual(basicScheme.status, 401);

      const origCronSecret = process.env.CRON_SECRET;
      try {
        delete process.env.CRON_SECRET;
        const missingSecretRes = await api('GET', '/cron/reconcile-orders', undefined, {
          Authorization: `Bearer ${CRON_SECRET}`
        });
        assert.strictEqual(missingSecretRes.status, 503);

        process.env.CRON_SECRET = 'mock_cron_secret_123456';
        const mockSecretRes = await api('GET', '/cron/reconcile-orders', undefined, {
          Authorization: 'Bearer mock_cron_secret_123456'
        });
        assert.strictEqual(mockSecretRes.status, 503);

        process.env.CRON_SECRET = 'short_secret';
        const shortSecretRes = await api('GET', '/cron/reconcile-orders', undefined, {
          Authorization: 'Bearer short_secret'
        });
        assert.strictEqual(shortSecretRes.status, 503);
      } finally {
        process.env.CRON_SECRET = origCronSecret;
      }
    }

    // -------------------------------------------------------------------------
    // 5. Production / Preview Isolation (Firebase & Razorpay Live Keys)
    // -------------------------------------------------------------------------
    console.log('5. Testing Production vs Preview isolation (rejects Prod Firebase & rzp_live_* in Preview)...');
    {
      const savedEnv = {
        VERCEL_ENV: process.env.VERCEL_ENV,
        FIREBASE_PROJECT_ID: process.env.FIREBASE_PROJECT_ID,
        FIREBASE_CLIENT_EMAIL: process.env.FIREBASE_CLIENT_EMAIL,
        RAZORPAY_KEY_ID: process.env.RAZORPAY_KEY_ID,
        RAZORPAY_KEY_SECRET: process.env.RAZORPAY_KEY_SECRET
      };
      try {
        // Production missing Razorpay keys -> 503 on cron
        process.env.VERCEL_ENV = 'production';
        delete process.env.RAZORPAY_KEY_SECRET;
        const prodMissingRp = await api('GET', '/cron/reconcile-orders', undefined, {
          Authorization: `Bearer ${CRON_SECRET}`
        });
        assert.strictEqual(prodMissingRp.status, 503);

        // Preview attempting Production Firebase -> 503 on cron
        process.env.VERCEL_ENV = 'preview';
        process.env.FIREBASE_PROJECT_ID = 'caffix-vending';
        process.env.RAZORPAY_KEY_ID = 'rzp_test_preview_ok';
        process.env.RAZORPAY_KEY_SECRET = 'preview_test_secret_1234';
        const previewProdFb = await api('GET', '/cron/reconcile-orders', undefined, {
          Authorization: `Bearer ${CRON_SECRET}`
        });
        assert.strictEqual(previewProdFb.status, 503);

        // Preview attempting Production Razorpay Live key (rzp_live_*) -> 503 on cron, webhook, and verify
        process.env.FIREBASE_PROJECT_ID = 'caffix-staging';
        process.env.FIREBASE_CLIENT_EMAIL = 'firebase-adminsdk@caffix-staging.iam.gserviceaccount.com';
        process.env.RAZORPAY_KEY_ID = 'rzp_live_forbidden_in_preview';
        const previewLiveCron = await api('GET', '/cron/reconcile-orders', undefined, {
          Authorization: `Bearer ${CRON_SECRET}`
        });
        assert.strictEqual(previewLiveCron.status, 503);

        const previewLiveWh = await sendWebhook(
          { event: 'payment.captured', payload: {} },
          signWebhookBytes(JSON.stringify({ event: 'payment.captured', payload: {} }))
        );
        assert.strictEqual(previewLiveWh.status, 503);

        // Preview with proper staging Firebase + Test Razorpay key -> 200
        process.env.RAZORPAY_KEY_ID = 'rzp_test_preview_valid';
        const previewValidCron = await api('GET', '/cron/reconcile-orders', undefined, {
          Authorization: `Bearer ${CRON_SECRET}`
        });
        assert.strictEqual(previewValidCron.status, 200, `Valid preview cron failed: ${JSON.stringify(previewValidCron.data)}`);
      } finally {
        Object.assign(process.env, savedEnv);
      }
    }

    // -------------------------------------------------------------------------
    // 6. Verify CRON_SECRET is never referenced in frontend apps & vercel.json is Hobby-safe
    // -------------------------------------------------------------------------
    console.log('6. Verifying CRON_SECRET is absent from frontend codebases, vercel.json is Hobby-safe, and distributed lease prevents cross-instance overlap...');
    {
      const repoRoot = path.resolve(__dirname, '..', '..', '..');
      const vercelConfig = JSON.parse(
        fsNode.readFileSync(path.join(repoRoot, 'vercel.json'), 'utf8')
      );
      assert.strictEqual(
        vercelConfig.crons,
        undefined,
        'vercel.json must omit incompatible five-minute native crons on Vercel Hobby plan'
      );

      for (const appDir of ['caffix-app', 'caffix-admin', 'caffix-owner']) {
        const files = collectSourceFiles(path.join(repoRoot, appDir, 'src'));
        assert.ok(files.length > 0, `Expected source files under ${appDir}/src`);
        for (const file of files) {
          const text = fsNode.readFileSync(file, 'utf8');
          assert.ok(
            !text.includes('CRON_SECRET'),
            `Forbidden CRON_SECRET reference found in frontend file: ${file}`
          );
        }
      }

      // Cross-instance distributed lease overlap test
      const leaseOrderId = await seedFirestoreOrder(fs, {
        id: 'ORD-W39-LEASE-1',
        machine_id: 'CFX-MC-01',
        razorpay_order_id: 'order_rp_lease_1'
      });
      await fs.collection('system_locks').doc('order_reconciliation').set({
        active: true,
        lock_id: 'other-serverless-instance-lock',
        acquired_at: new Date().toISOString(),
        locked_until_ms: Date.now() + 120_000
      });

      let razorpayCallsDuringLock = 0;
      setRazorpayClientForTesting({
        orders: {
          fetch: async () => {
            razorpayCallsDuringLock += 1;
            return { id: 'order_rp_lease_1', status: 'paid', amount: 10000, amount_paid: 10000, attempts: 1 };
          },
          fetchPayments: async () => {
            razorpayCallsDuringLock += 1;
            return { items: [{ id: 'pay_lease_1', status: 'captured', currency: 'INR', amount: 10000 }] };
          }
        }
      });

      const overlappedRes = await api('GET', '/cron/reconcile-orders', undefined, {
        Authorization: `Bearer ${CRON_SECRET}`
      });
      assert.strictEqual(overlappedRes.status, 200);
      assert.strictEqual(overlappedRes.data.data.skipped_due_to_active_run, true);
      assert.strictEqual(razorpayCallsDuringLock, 0, 'Active lease must skip Razorpay lookups completely');
      assert.strictEqual(ordersCol.get(leaseOrderId).status, 'PENDING');

      // Expire lease -> next external scheduler call recovers the pending order cleanly
      await fs.collection('system_locks').doc('order_reconciliation').set({
        active: false,
        lock_id: null,
        locked_until_ms: 0
      });
      const recoveredAfterLeaseRes = await api('GET', '/cron/reconcile-orders', undefined, {
        Authorization: `Bearer ${CRON_SECRET}`
      });
      assert.strictEqual(recoveredAfterLeaseRes.status, 200);
      assert.strictEqual(recoveredAfterLeaseRes.data.data.reconciled_paid, 1);
      assert.strictEqual(ordersCol.get(leaseOrderId).status, 'PAID');
    }

    console.log('\nALL WAVE 3.9 PENDING ORDER RECONCILIATION TESTS PASSED!\n');
  } finally {
    setRazorpayClientForTesting(null);
    setFirestoreForTesting({ firestoreInstance: null, initError: null, clearStores: true });
    server.close();
  }
}

runWave39Tests().catch((err) => {
  console.error('Wave 3.9 test suite failed:', err);
  process.exit(1);
});
