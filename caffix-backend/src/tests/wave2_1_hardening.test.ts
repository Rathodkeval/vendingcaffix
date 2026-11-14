import assert from 'assert';
import crypto from 'crypto';
import http from 'http';

process.env.JWT_SECRET =
  process.env.JWT_SECRET || 'caffix-test-wave2-1-hardening-secret-2026-explicit';
process.env.KIOSK_SECRET =
  process.env.KIOSK_SECRET || 'w21_test_kiosk_secret_2026';
const TEST_ADMIN_PIN = 'CaffixHardeningPin#2026';

import app from '../index';
import { initDB, getDB } from '../config/db';
import {
  generateCandidateOrderId,
  setOrderIdGeneratorForTesting,
  setRazorpayClientForTesting
} from '../controllers/orderController';
import { syncOrderToFirebase } from '../utils/firebase';

const PORT = 5093;
const BASE_URL = `http://127.0.0.1:${PORT}/api`;

function computeRazorpaySignature(razorpayOrderId: string, razorpayPaymentId: string): string {
  const secret = (process.env.RAZORPAY_KEY_SECRET || 'mockSecret987654321').trim();
  return crypto
    .createHmac('sha256', secret)
    .update(`${razorpayOrderId}|${razorpayPaymentId}`)
    .digest('hex');
}

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

async function runWave21HardeningTests() {
  console.log('\n=============================================================');
  console.log('Running Wave 2.1 Security & Order ID Collision Hardening Tests');
  console.log('=============================================================\n');

  const INITIAL_PIN = process.env.ADMIN_PASSCODE;
  process.env.ADMIN_PASSCODE = TEST_ADMIN_PIN;

  await initDB();
  const db = getDB();

  const w21Orders: Array<{ id: string; amount: number; currency: string; receipt: string }> = [];
  let w21Seq = 0;
  setRazorpayClientForTesting({
    orders: {
      create: async (opts: any) => {
        w21Seq += 1;
        const created = {
          id: `order_w21_${w21Seq}`,
          amount: Number(opts.amount),
          currency: opts.currency || 'INR',
          receipt: String(opts.receipt || '')
        };
        w21Orders.push(created);
        return created;
      }
    },
    payments: {
      fetch: async (paymentId: string) => {
        const match =
          w21Orders.find((o) => o.receipt === 'CFX-90000001') ||
          w21Orders[w21Orders.length - 1];
        return {
          id: paymentId,
          order_id: match?.id || 'order_w21_unknown',
          status: 'captured',
          currency: 'INR',
          amount: match?.amount ?? 10000
        };
      }
    }
  });
  await db.run('DELETE FROM machine_products');
  await db.run("DELETE FROM products WHERE name LIKE 'Wave21 Admin Espresso%'");
  await db.run('DELETE FROM inventory_ledger WHERE order_id IN (?, ?)', ['CFX-90000001', 'CFX-90000002']).catch(() => {});
  await db.run('DELETE FROM refunds WHERE order_id IN (?, ?)', ['CFX-90000001', 'CFX-90000002']).catch(() => {});
  await db.run('DELETE FROM orders WHERE id IN (?, ?)', ['CFX-90000001', 'CFX-90000002']);

  const server: http.Server = await new Promise<http.Server>((resolve) => {
    const s = app.listen(PORT, '127.0.0.1', () => resolve(s));
  });

  try {
    // Verify generated candidate ID format preserves CFX- prefix + 8 digits
    for (let i = 0; i < 10; i++) {
      const candidate = generateCandidateOrderId();
      assert.match(candidate, /^CFX-\d{8}$/, `Expected CFX-<8 digits>, got ${candidate}`);
    }

    // Login as Super Admin & verify kiosk tokens for CFX-MC-01 and CFX-MC-02
    const adminLogin = await api('POST', '/auth/login', {
      email: 'admin@caffix.com',
      password: 'admin123',
      portal: 'admin'
    });
    assert.strictEqual(adminLogin.status, 200);
    const adminToken = adminLogin.data.token;

    // Ensure CFX-MC-01 and CFX-MC-02 are RUNNING and refilled
    for (const mId of ['CFX-MC-01', 'CFX-MC-02']) {
      await api('PATCH', `/machines/${mId}/status`, { desired_mode: 'RUNNING' }, { Authorization: `Bearer ${adminToken}` });
      await api('POST', `/machines/${mId}/refill`, { ingredient: 'ALL' }, { Authorization: `Bearer ${adminToken}` });
    }

    const mc1Row = await db.get('SELECT kiosk_token FROM machines WHERE id = ?', ['CFX-MC-01']);
    const mc2Row = await db.get('SELECT kiosk_token FROM machines WHERE id = ?', ['CFX-MC-02']);
    const k1Secret = mc1Row?.kiosk_token || process.env.KIOSK_SECRET!;
    const k2Secret = mc2Row?.kiosk_token || process.env.KIOSK_SECRET!;

    const verifyK1 = await api('GET', `/kiosk/verify?kiosk=${encodeURIComponent(k1Secret)}&machine_id=CFX-MC-01`);
    const verifyK2 = await api('GET', `/kiosk/verify?kiosk=${encodeURIComponent(k2Secret)}&machine_id=CFX-MC-02`);
    assert.strictEqual(verifyK1.status, 200);
    assert.strictEqual(verifyK2.status, 200);
    const kiosk1Token = verifyK1.data.token;
    const kiosk2Token = verifyK2.data.token;

    // -------------------------------------------------------------------------
    // 1. Order ID Collision Simulation & Non-Overwrite Verification
    // -------------------------------------------------------------------------
    const seqInitial = ['CFX-90000001'];
    let idxInitial = 0;
    setOrderIdGeneratorForTesting(() => seqInitial[idxInitial++] || generateCandidateOrderId());

    const firstOrderRes = await api(
      'POST',
      '/orders/create',
      { product_id: 1, amount: 100, machine_id: 'CFX-MC-01', base: 'water' },
      { Authorization: `Bearer ${kiosk1Token}` }
    );
    assert.strictEqual(firstOrderRes.status, 201);
    assert.strictEqual(firstOrderRes.data.data.id, 'CFX-90000001');

    // Pay first order so its status/payment record is completely distinct
    const firstPaySig = computeRazorpaySignature(firstOrderRes.data.data.razorpay_order_id, 'pay_w21_first');
    const payFirst = await api(
      'POST',
      '/payments/verify',
      {
        order_id: 'CFX-90000001',
        razorpay_order_id: firstOrderRes.data.data.razorpay_order_id,
        razorpay_payment_id: 'pay_w21_first',
        razorpay_signature: firstPaySig
      },
      { Authorization: `Bearer ${kiosk1Token}` }
    );
    assert.strictEqual(payFirst.status, 200);
    assert.strictEqual(payFirst.data.data.status, 'PAID');

    // Duplicate payment verify must remain idempotent and return 200 without overwriting/failing
    const dupPay = await api(
      'POST',
      '/payments/verify',
      {
        order_id: 'CFX-90000001',
        razorpay_order_id: firstOrderRes.data.data.razorpay_order_id,
        razorpay_payment_id: 'pay_w21_first',
        razorpay_signature: firstPaySig
      },
      { Authorization: `Bearer ${kiosk1Token}` }
    );
    assert.strictEqual(dupPay.status, 200);

    // Simulate two collisions returning CFX-90000001 before succeeding with CFX-90000002
    const seqCollisionRetry = ['CFX-90000001', 'CFX-90000001', 'CFX-90000002'];
    let idxCollisionRetry = 0;
    setOrderIdGeneratorForTesting(
      () => seqCollisionRetry[idxCollisionRetryRetryIndex()] || generateCandidateOrderId()
    );
    function idxCollisionRetryRetryIndex() {
      return idxCollisionRetry++;
    }

    const secondOrderRes = await api(
      'POST',
      '/orders/create',
      { product_id: 2, amount: 100, machine_id: 'CFX-MC-02', base: 'milk' },
      { Authorization: `Bearer ${kiosk2Token}` }
    );
    assert.strictEqual(secondOrderRes.status, 201, 'Retry after order ID collision must succeed');
    assert.strictEqual(secondOrderRes.data.data.id, 'CFX-90000002');
    assert.strictEqual(secondOrderRes.data.data.machine_id, 'CFX-MC-02');

    // Confirm CFX-90000001 was NEVER overwritten or modified
    const checkFirst = await api('GET', '/orders/CFX-90000001', undefined, {
      Authorization: `Bearer ${kiosk1Token}`
    });
    assert.strictEqual(checkFirst.status, 200);
    assert.strictEqual(checkFirst.data.data.machine_id, 'CFX-MC-01');
    assert.strictEqual(checkFirst.data.data.product_id, 1);
    assert.strictEqual(checkFirst.data.data.status, 'PAID');

    // Simulate createOnly collision in syncOrderToFirebase
    await assert.rejects(
      () =>
        syncOrderToFirebase(
          {
            id: 'CFX-90000001',
            product_id: 2,
            amount: 999,
            status: 'PENDING',
            machine_id: 'CFX-MC-02',
            created_at: new Date().toISOString()
          },
          { createOnly: true }
        ),
      /ORDER_ID_COLLISION/,
      'syncOrderToFirebase(createOnly=true) must never overwrite an existing order'
    );

    // Simulate bounded retry exhaustion -> controlled HTTP 503 error
    setOrderIdGeneratorForTesting(() => 'CFX-90000001');
    const exhaustedRes = await api(
      'POST',
      '/orders/create',
      { product_id: 1, amount: 100, machine_id: 'CFX-MC-01', base: 'water' },
      { Authorization: `Bearer ${kiosk1Token}` }
    );
    assert.strictEqual(
      exhaustedRes.status,
      503,
      'Exhausted order ID collision retries must return controlled HTTP 503'
    );
    assert.ok(
      String(exhaustedRes.data.message || '').toLowerCase().includes('unique order id'),
      'Exhausted collision error must report a controlled message'
    );

    setOrderIdGeneratorForTesting(null);
    console.log('   PASS: Order ID collision retry, Firebase createOnly guard, and bounded failure verified.');

    // -------------------------------------------------------------------------
    // 2. Kiosk-Admin Authorization Hardening (POST /api/products & Machine Scope)
    // -------------------------------------------------------------------------
    const unlockRes = await api(
      'POST',
      '/auth/kiosk-admin',
      { passcode: TEST_ADMIN_PIN, machine_id: 'CFX-MC-01' },
      { Authorization: `Bearer ${kiosk1Token}` }
    );
    assert.strictEqual(unlockRes.status, 200);
    const kioskAdminToken = unlockRes.data.token;

    // kiosk_admin MUST be rejected with 403 on POST /api/products
    const kioskCreateGlobalProd = await api(
      'POST',
      '/products',
      { name: 'Unauthorized Kiosk Product', price: 250, description: 'Blocked' },
      { Authorization: `Bearer ${kioskAdminToken}` }
    );
    assert.strictEqual(
      kioskCreateGlobalProd.status,
      403,
      'kiosk_admin token must NEVER create global products via POST /api/products'
    );

    // Real Super Admin token MUST continue to create global products (201)
    const testProductName = `Wave21 Admin Espresso ${Date.now()}`;
    const adminCreateGlobalProd = await api(
      'POST',
      '/products',
      { name: testProductName, price: 140, description: 'Admin created coffee' },
      { Authorization: `Bearer ${adminToken}` }
    );
    assert.strictEqual(
      adminCreateGlobalProd.status,
      201,
      'Super Admin must still be able to create global products via POST /api/products'
    );
    const createdProductId = adminCreateGlobalProd.data.data.id;

    // kiosk_admin updating price via PUT /products/1/price MUST scope ONLY to bound CFX-MC-01, never global catalog
    const kioskUpdateOwnPrice = await api(
      'PUT',
      '/products/1/price',
      { price: 133 },
      { Authorization: `Bearer ${kioskAdminToken}` }
    );
    assert.strictEqual(kioskUpdateOwnPrice.status, 200);
    assert.strictEqual(kioskUpdateOwnPrice.data.data.machine_id, 'CFX-MC-01');

    // Check CFX-MC-02 and global product catalog remained at ₹100
    const mc2ProductsAfter = await api('GET', '/products?machine_id=CFX-MC-02');
    assert.strictEqual(
      mc2ProductsAfter.data.data.find((p: any) => Number(p.id) === 1).price,
      100,
      'kiosk_admin price update on CFX-MC-01 must NOT change CFX-MC-02 or global catalog price'
    );

    // kiosk_admin bound to CFX-MC-01 must be rejected (403) across ALL cross-machine & fleet endpoints
    const kioskAdminForbidden = await Promise.all([
      api('GET', '/machines', undefined, { Authorization: `Bearer ${kioskAdminToken}` }),
      api('PUT', '/products/1/price', { price: 199, machine_id: 'CFX-MC-02' }, { Authorization: `Bearer ${kioskAdminToken}` }),
      api('PATCH', '/machines/CFX-MC-02/status', { desired_mode: 'MAINTENANCE' }, { Authorization: `Bearer ${kioskAdminToken}` }),
      api('POST', '/machines/CFX-MC-02/refill', { ingredient: 'ALL' }, { Authorization: `Bearer ${kioskAdminToken}` }),
      api('GET', '/orders?machine_id=CFX-MC-02', undefined, { Authorization: `Bearer ${kioskAdminToken}` }),
      api('GET', '/orders/CFX-90000002', undefined, { Authorization: `Bearer ${kioskAdminToken}` }),
      api('PUT', '/orders/CFX-90000002/status', { status: 'COMPLETED' }, { Authorization: `Bearer ${kioskAdminToken}` }),
      api(
        'POST',
        '/payments/verify',
        {
          order_id: 'CFX-90000002',
          razorpay_order_id: secondOrderRes.data.data.razorpay_order_id,
          razorpay_payment_id: 'pay_cross',
          razorpay_signature: 'sig'
        },
        { Authorization: `Bearer ${kioskAdminToken}` }
      )
    ]);

    for (const check of kioskAdminForbidden) {
      assert.strictEqual(
        check.status,
        403,
        `kiosk_admin token bound to CFX-MC-01 must receive 403 on cross-machine/fleet action (got ${check.status})`
      );
    }

    // kiosk_admin CAN still inspect & manage its own machine (CFX-MC-01)
    const ownStatusToggle = await api(
      'PATCH',
      '/machines/CFX-MC-01/status',
      { desired_mode: 'RUNNING' },
      { Authorization: `Bearer ${kioskAdminToken}` }
    );
    assert.strictEqual(ownStatusToggle.status, 200);

    const ownOrders = await api('GET', '/orders?machine_id=CFX-MC-01', undefined, {
      Authorization: `Bearer ${kioskAdminToken}`
    });
    assert.strictEqual(ownOrders.status, 200);
    assert.ok(ownOrders.data.data.every((o: any) => o.machine_id === 'CFX-MC-01'));
    console.log('   PASS: kiosk_admin blocked on POST /api/products & cross-machine actions; Super Admin allowed.');

    // Cleanup test fixtures
    await db.run('DELETE FROM machine_products');
    await db.run('DELETE FROM inventory_ledger WHERE order_id IN (?, ?)', ['CFX-90000001', 'CFX-90000002']).catch(() => {});
    await db.run('DELETE FROM refunds WHERE order_id IN (?, ?)', ['CFX-90000001', 'CFX-90000002']).catch(() => {});
    await db.run('DELETE FROM orders WHERE id IN (?, ?)', ['CFX-90000001', 'CFX-90000002']);
    if (createdProductId) {
      await db.run('DELETE FROM products WHERE id = ?', [createdProductId]);
    }

    console.log('\nALL WAVE 2.1 HARDENING TESTS PASSED SUCCESSFULLY!\n');
  } finally {
    setOrderIdGeneratorForTesting(null);
    if (INITIAL_PIN === undefined) delete process.env.ADMIN_PASSCODE;
    else process.env.ADMIN_PASSCODE = INITIAL_PIN;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  process.exit(0);
}

runWave21HardeningTests().catch((err) => {
  console.error('Wave 2.1 hardening test suite failed:', err);
  process.exit(1);
});

