import assert from 'assert';
import crypto from 'crypto';
import http from 'http';

process.env.JWT_SECRET =
  process.env.JWT_SECRET || 'caffix-test-stage3-secret-key-2026-explicit-only';
process.env.KIOSK_SECRET =
  process.env.KIOSK_SECRET || 'stage3_test_kiosk_secret_2026';

import app from '../index';
import { initDB, getDB, resetMockDatabaseForColdStartSimulation } from '../config/db';
import { getSyncedFirebaseMachine, getSyncedFirebaseOrder } from '../utils/firebase';

const PORT = 5098;
const BASE_URL = `http://127.0.0.1:${PORT}/api`;

function computeRazorpaySignature(razorpayOrderId: string, razorpayPaymentId: string): string {
  const secret = (process.env.RAZORPAY_KEY_SECRET || 'mockSecret987654321').trim();
  return crypto
    .createHmac('sha256', secret)
    .update(`${razorpayOrderId}|${razorpayPaymentId}`)
    .digest('hex');
}

async function apiRequest(
  method: string,
  path: string,
  body?: any,
  token?: string
): Promise<{ status: number; data: any }> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json'
  };
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined
  });

  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

async function runTests() {
  const modeLabel = process.env.VERCEL ? 'Vercel Serverless (MockDatabase)' : 'Local SQLite';
  console.log(`\n=============================================================`);
  console.log(`Running Stage 3 Pricing, Availability & Maintenance Tests [${modeLabel}]`);
  console.log(`=============================================================\n`);

  await initDB();
  await getDB().run('DELETE FROM machine_products');

  const server: http.Server = await new Promise((resolve) => {
    const s = app.listen(PORT, '127.0.0.1', () => resolve(s));
  });

  try {
    // -------------------------------------------------------------------------
    // Setup: Admin login + invite & activate Owner A (CFX-MC-01) and Owner B (CFX-MC-02)
    // plus verify Kiosk tokens for CFX-MC-01 and CFX-MC-02
    // -------------------------------------------------------------------------
    const adminLogin = await apiRequest('POST', '/auth/login', {
      email: 'admin@caffix.com',
      password: 'admin123'
    });
    assert.strictEqual(adminLogin.status, 200, 'Admin login must succeed');
    const adminToken = adminLogin.data.token;

    // Ensure both machines are in RUNNING mode and have full inventory
    await apiRequest('PATCH', '/machines/CFX-MC-01/status', { desired_mode: 'RUNNING' }, adminToken);
    await apiRequest('PATCH', '/machines/CFX-MC-02/status', { desired_mode: 'RUNNING' }, adminToken);
    await apiRequest('POST', '/machines/CFX-MC-01/refill', { ingredient: 'ALL' }, adminToken);
    await apiRequest('POST', '/machines/CFX-MC-02/refill', { ingredient: 'ALL' }, adminToken);

    // Record heartbeat on CFX-MC-01 to verify product updates do not overwrite last_seen
    const hbRes = await apiRequest('POST', '/machines/CFX-MC-01/heartbeat', {}, adminToken);
    assert.strictEqual(hbRes.status, 200);
    const preservedLastSeen = hbRes.data.data.last_seen;

    // Create Owner A (assigned CFX-MC-01) and Owner B (assigned CFX-MC-02)
    const ownerAEmail = `owner.stage3.a.${Date.now()}@caffix.com`;
    const ownerBEmail = `owner.stage3.b.${Date.now()}@caffix.com`;

    const inviteA = await apiRequest(
      'POST',
      '/auth/owners/invite',
      { name: 'Stage3 Owner A', email: ownerAEmail, machine_ids: ['CFX-MC-01'] },
      adminToken
    );
    assert.strictEqual(inviteA.status, 201);
    const setupA = await apiRequest('POST', '/auth/setup-password', {
      token: inviteA.data.data.invite_token,
      email: ownerAEmail,
      password: 'OwnerAPassword123!'
    });
    assert.strictEqual(setupA.status, 200);
    const ownerAToken = setupA.data.token;
    const ownerAId = setupA.data.data.id;

    const inviteB = await apiRequest(
      'POST',
      '/auth/owners/invite',
      { name: 'Stage3 Owner B', email: ownerBEmail, machine_ids: ['CFX-MC-02'] },
      adminToken
    );
    assert.strictEqual(inviteB.status, 201);
    const setupB = await apiRequest('POST', '/auth/setup-password', {
      token: inviteB.data.data.invite_token,
      email: ownerBEmail,
      password: 'OwnerBPassword123!'
    });
    assert.strictEqual(setupB.status, 200);
    const ownerBToken = setupB.data.token;

    // Obtain Kiosk JWTs for CFX-MC-01 and CFX-MC-02
    const db = getDB();
    const mc1Row = await db.get('SELECT kiosk_token FROM machines WHERE id = ?', ['CFX-MC-01']);
    const mc2Row = await db.get('SELECT kiosk_token FROM machines WHERE id = ?', ['CFX-MC-02']);
    const kiosk1Secret = mc1Row?.kiosk_token || process.env.KIOSK_SECRET!;
    const kiosk2Secret = mc2Row?.kiosk_token || process.env.KIOSK_SECRET!;

    const kiosk1Verify = await apiRequest(
      'GET',
      `/kiosk/verify?kiosk=${encodeURIComponent(kiosk1Secret)}&machine_id=CFX-MC-01`
    );
    assert.strictEqual(kiosk1Verify.status, 200);
    const kiosk1Token = kiosk1Verify.data.token;

    const kiosk2Verify = await apiRequest(
      'GET',
      `/kiosk/verify?kiosk=${encodeURIComponent(kiosk2Secret)}&machine_id=CFX-MC-02`
    );
    assert.strictEqual(kiosk2Verify.status, 200);
    const kiosk2Token = kiosk2Verify.data.token;

    // -------------------------------------------------------------------------
    // Test 1: Default catalog prices returned when no machine override exists
    // -------------------------------------------------------------------------
    console.log('Test 1: Default catalog prices returned when no machine override exists...');
    const globalProds = await apiRequest('GET', '/products');
    assert.strictEqual(globalProds.status, 200);
    assert.strictEqual(globalProds.data.data.length, 5);
    for (const p of globalProds.data.data) {
      assert.strictEqual(p.price, 100, `Default price for product ${p.id} should be 100`);
      assert.strictEqual(p.is_available, true, `Default availability for product ${p.id} should be true`);
    }

    const mc1DefaultProds = await apiRequest('GET', '/products?machine_id=CFX-MC-01');
    assert.strictEqual(mc1DefaultProds.status, 200);
    assert.strictEqual(mc1DefaultProds.data.data.length, 5);
    assert.strictEqual(mc1DefaultProds.data.data[0].price, 100);
    assert.strictEqual(mc1DefaultProds.data.data[0].is_available, true);
    console.log('  PASS: Default catalog prices (₹100, available=true) returned when no overrides exist.');

    // -------------------------------------------------------------------------
    // Test 2 & 3: Owner updates price for assigned machine; CFX-MC-01 and CFX-MC-02 have independent prices
    // -------------------------------------------------------------------------
    console.log('Test 2 & 3: Owner updating price for assigned machine & independent per-machine pricing...');
    // Owner B sets CFX-MC-02 Product 1 (Classic Crest) to ₹120
    const updateMc2Prod1 = await apiRequest(
      'PUT',
      '/machines/CFX-MC-02/products/1',
      { price: 120 },
      ownerBToken
    );
    assert.strictEqual(updateMc2Prod1.status, 200, 'Owner B must be able to update price on CFX-MC-02');
    assert.strictEqual(updateMc2Prod1.data.data.price, 120);
    assert.strictEqual(updateMc2Prod1.data.data.is_available, true);

    // Owner A sets CFX-MC-01 Product 3 (Hazel Gold) to ₹115 while leaving Product 1 at ₹100
    const updateMc1Prod3 = await apiRequest(
      'PUT',
      '/machines/CFX-MC-01/products/3',
      { price: 115 },
      ownerAToken
    );
    assert.strictEqual(updateMc1Prod3.status, 200, 'Owner A must be able to update price on CFX-MC-01');
    assert.strictEqual(updateMc1Prod3.data.data.price, 115);

    // Verify CFX-MC-01 has Product 1 = ₹100, Product 3 = ₹115
    const mc1ProdsAfter = await apiRequest('GET', '/products?machine_id=CFX-MC-01');
    assert.strictEqual(mc1ProdsAfter.status, 200);
    const mc1P1 = mc1ProdsAfter.data.data.find((p: any) => p.id === 1);
    const mc1P3 = mc1ProdsAfter.data.data.find((p: any) => p.id === 3);
    assert.strictEqual(mc1P1.price, 100, 'CFX-MC-01 Product 1 must remain ₹100');
    assert.strictEqual(mc1P3.price, 115, 'CFX-MC-01 Product 3 must be ₹115');

    // Verify CFX-MC-02 has Product 1 = ₹120, Product 3 = ₹100
    const mc2ProdsAfter = await apiRequest('GET', '/products?machine_id=CFX-MC-02');
    assert.strictEqual(mc2ProdsAfter.status, 200);
    const mc2P1 = mc2ProdsAfter.data.data.find((p: any) => p.id === 1);
    const mc2P3 = mc2ProdsAfter.data.data.find((p: any) => p.id === 3);
    assert.strictEqual(mc2P1.price, 120, 'CFX-MC-02 Product 1 must be ₹120');
    assert.strictEqual(mc2P3.price, 100, 'CFX-MC-02 Product 3 must remain ₹100');

    // Verify Firestore partial update on CFX-MC-01 preserved owner_id, desired_mode, and last_seen
    const syncedMc1 = getSyncedFirebaseMachine('CFX-MC-01');
    assert.strictEqual(syncedMc1.owner_id, ownerAId, 'Product update must not overwrite owner_id in Firestore');
    assert.strictEqual(syncedMc1.desired_mode, 'RUNNING', 'Product update must not overwrite desired_mode in Firestore');
    assert.strictEqual(syncedMc1.last_seen, preservedLastSeen, 'Product update must not overwrite last_seen in Firestore');
    console.log('  PASS: CFX-MC-01 (₹100) and CFX-MC-02 (₹120) have independent prices and Firestore fields are preserved.');

    // -------------------------------------------------------------------------
    // Test 4: Owner blocked (403) when attempting to view or update price for another owner's machine
    // -------------------------------------------------------------------------
    console.log('Test 4: Owner blocked (403) when attempting to update price for another owner\'s machine...');
    const crossOwnerGetProds = await apiRequest('GET', '/machines/CFX-MC-02/products', undefined, ownerAToken);
    assert.strictEqual(crossOwnerGetProds.status, 403, 'Owner A must be blocked (403) from viewing CFX-MC-02 products');

    const crossOwnerUpdatePrice = await apiRequest(
      'PUT',
      '/machines/CFX-MC-02/products/1',
      { price: 200 },
      ownerAToken
    );
    assert.strictEqual(crossOwnerUpdatePrice.status, 403, 'Owner A must be blocked (403) from updating CFX-MC-02 price');

    const unassignedUpdatePrice = await apiRequest(
      'PUT',
      '/machines/CFX-MC-03/products/1',
      { price: 200 },
      ownerAToken
    );
    assert.strictEqual(unassignedUpdatePrice.status, 403, 'Owner A must be blocked (403) from updating unassigned CFX-MC-03 price');
    console.log('  PASS: Cross-owner and unassigned machine price updates rejected with 403 Forbidden.');

    // -------------------------------------------------------------------------
    // Test 5 & 6: Owner updating availability for assigned machine & blocked (403) on another owner's machine
    // -------------------------------------------------------------------------
    console.log('Test 5 & 6: Owner updating availability for assigned machine & blocked (403) for another owner\'s machine...');
    // Owner A disables Product 2 (Vanilla Velvet) on CFX-MC-01
    const disableMc1Prod2 = await apiRequest(
      'PUT',
      '/machines/CFX-MC-01/products/2',
      { is_available: false },
      ownerAToken
    );
    assert.strictEqual(disableMc1Prod2.status, 200);
    assert.strictEqual(disableMc1Prod2.data.data.is_available, false);
    assert.strictEqual(disableMc1Prod2.data.data.price, 100, 'Disabling product without price param must preserve its price');

    // Verify Product 3 on CFX-MC-01 still has price ₹115 and is_available=true
    const ownerAMc1Prods = await apiRequest('GET', '/machines/CFX-MC-01/products', undefined, ownerAToken);
    assert.strictEqual(ownerAMc1Prods.status, 200);
    const checkP2 = ownerAMc1Prods.data.data.find((p: any) => p.id === 2);
    const checkP3 = ownerAMc1Prods.data.data.find((p: any) => p.id === 3);
    assert.strictEqual(checkP2.is_available, false);
    assert.strictEqual(checkP3.price, 115);
    assert.strictEqual(checkP3.is_available, true);

    // Owner A tries to disable Product 2 on Owner B's machine CFX-MC-02 -> 403
    const crossOwnerDisable = await apiRequest(
      'PUT',
      '/machines/CFX-MC-02/products/2',
      { is_available: false },
      ownerAToken
    );
    assert.strictEqual(crossOwnerDisable.status, 403, 'Owner A must be blocked (403) from updating availability on CFX-MC-02');
    console.log('  PASS: Owner availability update works on assigned machine and returns 403 on other machines.');

    // -------------------------------------------------------------------------
    // Test 7: Order rejection when product is unavailable on that machine
    // -------------------------------------------------------------------------
    console.log('Test 7: Order rejection when product is unavailable on that machine...');
    const unavailableOrderRes = await apiRequest(
      'POST',
      '/orders/create',
      {
        product_id: 2,
        machine_id: 'CFX-MC-01',
        base: 'milk'
      },
      kiosk1Token
    );
    assert.strictEqual(unavailableOrderRes.status, 400, 'Order for unavailable product on CFX-MC-01 must be rejected with 400');

    // Meanwhile, Product 2 IS available on CFX-MC-02, so ordering Product 2 on CFX-MC-02 must succeed
    const availableOnMc2Res = await apiRequest(
      'POST',
      '/orders/create',
      {
        product_id: 2,
        machine_id: 'CFX-MC-02',
        base: 'milk'
      },
      kiosk2Token
    );
    assert.strictEqual(availableOnMc2Res.status, 201, 'Order for Product 2 on CFX-MC-02 (where it is available) must succeed');
    console.log('  PASS: Unavailable product rejected on CFX-MC-01 (400) while remaining orderable on CFX-MC-02 (201).');

    // -------------------------------------------------------------------------
    // Test 8: Backend calculation of authoritative price during order creation
    // (including across simulated Vercel cold start)
    // -------------------------------------------------------------------------
    console.log('Test 8: Backend calculation of authoritative price during order creation...');
    if (process.env.VERCEL) {
      resetMockDatabaseForColdStartSimulation();
    }

    // Create order on CFX-MC-02 for Product 1 without sending amount -> must use ₹120
    const orderMc2NoAmount = await apiRequest(
      'POST',
      '/orders/create',
      {
        product_id: 1,
        machine_id: 'CFX-MC-02',
        base: 'water'
      },
      kiosk2Token
    );
    assert.strictEqual(orderMc2NoAmount.status, 201);
    assert.strictEqual(orderMc2NoAmount.data.data.amount, 120, 'Backend must calculate authoritative ₹120 for CFX-MC-02 Product 1');

    // Create order on CFX-MC-01 for Product 1 with matching amount 100 -> must use ₹100
    const orderMc1Matching = await apiRequest(
      'POST',
      '/orders/create',
      {
        product_id: 1,
        amount: 100,
        machine_id: 'CFX-MC-01',
        base: 'water'
      },
      kiosk1Token
    );
    assert.strictEqual(orderMc1Matching.status, 201);
    assert.strictEqual(orderMc1Matching.data.data.amount, 100, 'Backend must use authoritative ₹100 for CFX-MC-01 Product 1');
    console.log('  PASS: Backend calculates authoritative per-machine price (₹120 on CFX-MC-02, ₹100 on CFX-MC-01).');

    // -------------------------------------------------------------------------
    // Test 9: Backend rejection of manipulated frontend prices
    // -------------------------------------------------------------------------
    console.log('Test 9: Backend rejection of manipulated frontend prices...');
    // Manipulated low price (₹50 instead of ₹120 on CFX-MC-02)
    const manipulatedLow = await apiRequest(
      'POST',
      '/orders/create',
      {
        product_id: 1,
        amount: 50,
        machine_id: 'CFX-MC-02',
        base: 'water'
      },
      kiosk2Token
    );
    assert.strictEqual(manipulatedLow.status, 400, 'Manipulated frontend price (₹50 vs ₹120) must be rejected with 400');

    // Stale/wrong machine price (₹100 sent for CFX-MC-02 where Product 1 is ₹120)
    const manipulatedStale = await apiRequest(
      'POST',
      '/orders/create',
      {
        product_id: 1,
        amount: 100,
        machine_id: 'CFX-MC-02',
        base: 'water'
      },
      kiosk2Token
    );
    assert.strictEqual(manipulatedStale.status, 400, 'Mismatched frontend price (₹100 vs ₹120) must be rejected with 400');
    console.log('  PASS: Manipulated or mismatched frontend prices are rejected with 400 Bad Request.');

    // -------------------------------------------------------------------------
    // Test 10: Historical order amount remains unchanged after future product price changes
    // -------------------------------------------------------------------------
    console.log('Test 10: Historical order amount remaining unchanged after product price changes...');
    const historicalOrderId = orderMc2NoAmount.data.data.id;
    const historicalRpOrderId = orderMc2NoAmount.data.data.razorpay_order_id;

    // Verify payment & complete the ₹120 order on CFX-MC-02
    const histPaymentId = 'pay_test_hist_120';
    const histSignature = computeRazorpaySignature(historicalRpOrderId, histPaymentId);
    const verifyHistPayment = await apiRequest(
      'POST',
      '/payments/verify',
      {
        order_id: historicalOrderId,
        razorpay_order_id: historicalRpOrderId,
        razorpay_payment_id: histPaymentId,
        razorpay_signature: histSignature
      },
      kiosk2Token
    );
    assert.strictEqual(verifyHistPayment.status, 200);
    assert.strictEqual(verifyHistPayment.data.data.status, 'PAID');
    assert.strictEqual(verifyHistPayment.data.data.amount, 120);

    const completeHistOrder = await apiRequest(
      'PUT',
      `/orders/${historicalOrderId}/status`,
      { status: 'COMPLETED' },
      kiosk2Token
    );
    assert.strictEqual(completeHistOrder.status, 200);
    assert.strictEqual(completeHistOrder.data.data.amount, 120);

    // Now Owner B changes CFX-MC-02 Product 1 price from ₹120 to ₹160
    const changePriceTo160 = await apiRequest(
      'PUT',
      '/machines/CFX-MC-02/products/1',
      { price: 160 },
      ownerBToken
    );
    assert.strictEqual(changePriceTo160.status, 200);
    assert.strictEqual(changePriceTo160.data.data.price, 160);

    // Simulate cold start in Vercel mode to verify Firestore order hydration preserves historical amount
    if (process.env.VERCEL) {
      resetMockDatabaseForColdStartSimulation();
    }

    // Fetch historical order by ID and via Owner B's orders list
    const fetchedById = await apiRequest('GET', `/orders/${historicalOrderId}`, undefined, ownerBToken);
    assert.strictEqual(fetchedById.status, 200);
    assert.strictEqual(
      fetchedById.data.data.amount,
      120,
      'Historical order amount by ID must remain ₹120 after price increase to ₹160'
    );

    const ownerBOrders = await apiRequest('GET', '/orders', undefined, ownerBToken);
    assert.strictEqual(ownerBOrders.status, 200);
    const foundInList = ownerBOrders.data.data.find((o: any) => o.id === historicalOrderId);
    assert.ok(foundInList, 'Historical order must be returned in Owner B orders list');
    assert.strictEqual(
      foundInList.amount,
      120,
      'Historical order amount in sales/orders list must remain ₹120 after price increase to ₹160'
    );
    const firestoreOrder = getSyncedFirebaseOrder(historicalOrderId);
    assert.strictEqual(firestoreOrder?.amount, 120, 'Firestore order record must retain amount=120');
    console.log('  PASS: Historical order amount remains ₹120 after product price is changed to ₹160.');

    // -------------------------------------------------------------------------
    // Test 11 & 12: Safe Maintenance Transition
    // - In-progress order created BEFORE maintenance mode is allowed to complete payment & dispensing
    // - New order creation AFTER maintenance mode is enabled is rejected (400)
    // -------------------------------------------------------------------------
    console.log('Test 11 & 12: Safe Maintenance Transition (reject new orders, allow in-progress orders to complete)...');
    // Step A: Create an order on CFX-MC-01 while CFX-MC-01 is still RUNNING
    const inFlightOrderRes = await apiRequest(
      'POST',
      '/orders/create',
      {
        product_id: 3, // ₹115 on CFX-MC-01
        amount: 115,
        machine_id: 'CFX-MC-01',
        base: 'milk'
      },
      kiosk1Token
    );
    assert.strictEqual(inFlightOrderRes.status, 201, 'Order creation while RUNNING must succeed');
    const inFlightOrderId = inFlightOrderRes.data.data.id;
    const inFlightRpOrderId = inFlightOrderRes.data.data.razorpay_order_id;
    assert.strictEqual(inFlightOrderRes.data.data.amount, 115);

    // Step B: Owner A activates MAINTENANCE mode on CFX-MC-01 while inFlightOrder is still PENDING payment
    const enableMaintRes = await apiRequest(
      'PATCH',
      '/machines/CFX-MC-01/status',
      { desired_mode: 'MAINTENANCE' },
      ownerAToken
    );
    assert.strictEqual(enableMaintRes.status, 200);
    assert.strictEqual(enableMaintRes.data.data.desired_mode, 'MAINTENANCE');

    if (process.env.VERCEL) {
      resetMockDatabaseForColdStartSimulation();
    }

    // Step C (Test 11): Attempt to create a NEW order on CFX-MC-01 while desired_mode === 'MAINTENANCE' -> must be rejected (400)
    const newOrderDuringMaint = await apiRequest(
      'POST',
      '/orders/create',
      {
        product_id: 1,
        amount: 100,
        machine_id: 'CFX-MC-01',
        base: 'water'
      },
      kiosk1Token
    );
    assert.strictEqual(
      newOrderDuringMaint.status,
      400,
      'New order creation must be rejected (400) when machine desired_mode is MAINTENANCE'
    );

    // Step D (Test 12): Complete Razorpay payment verification and status transitions (PAID -> PREPARING -> COMPLETED)
    // for the in-flight order that was created before MAINTENANCE mode was enabled
    const inFlightPaymentId = 'pay_test_inflight_115';
    const inFlightSignature = computeRazorpaySignature(inFlightRpOrderId, inFlightPaymentId);
    const verifyInFlight = await apiRequest(
      'POST',
      '/payments/verify',
      {
        order_id: inFlightOrderId,
        razorpay_order_id: inFlightRpOrderId,
        razorpay_payment_id: inFlightPaymentId,
        razorpay_signature: inFlightSignature
      },
      kiosk1Token
    );
    assert.strictEqual(
      verifyInFlight.status,
      200,
      'In-flight order created before MAINTENANCE must be allowed to verify payment'
    );
    assert.strictEqual(verifyInFlight.data.data.status, 'PAID');

    const preparingInFlight = await apiRequest(
      'PUT',
      `/orders/${inFlightOrderId}/status`,
      { status: 'PREPARING' },
      kiosk1Token
    );
    assert.strictEqual(
      preparingInFlight.status,
      200,
      'Paid order must be allowed to transition to PREPARING during MAINTENANCE mode'
    );
    assert.strictEqual(preparingInFlight.data.data.status, 'PREPARING');

    const completedInFlight = await apiRequest(
      'PUT',
      `/orders/${inFlightOrderId}/status`,
      { status: 'COMPLETED' },
      kiosk1Token
    );
    assert.strictEqual(
      completedInFlight.status,
      200,
      'Dispensing order must be allowed to transition to COMPLETED during MAINTENANCE mode'
    );
    assert.strictEqual(completedInFlight.data.data.status, 'COMPLETED');
    assert.strictEqual(completedInFlight.data.data.amount, 115);

    const syncedInFlight = getSyncedFirebaseOrder(inFlightOrderId);
    assert.strictEqual(syncedInFlight?.status, 'COMPLETED');
    assert.strictEqual(syncedInFlight?.amount, 115);
    console.log('  PASS: New orders rejected during MAINTENANCE while already-initiated/paid orders complete safely.');

    // Restore CFX-MC-01 to RUNNING mode before running live kiosk synchronization & inventory validation checks
    await apiRequest('PATCH', '/machines/CFX-MC-01/status', { desired_mode: 'RUNNING' }, ownerAToken);

    // -------------------------------------------------------------------------
    // Test 13: Cache-Control no-store headers + Kiosk machine_id isolation on /products
    // -------------------------------------------------------------------------
    console.log('Test 13: Dynamic endpoints emit no-store cache headers & enforce kiosk machine isolation...');
    const headerEndpoints = [
      { path: '/products?machine_id=CFX-MC-01', token: kiosk1Token },
      { path: '/machine-status?machine_id=CFX-MC-01', token: kiosk1Token },
      { path: '/machines/CFX-MC-01/products', token: ownerAToken },
      { path: '/machines/CFX-MC-01/inventory', token: ownerAToken }
    ];
    for (const endpoint of headerEndpoints) {
      const rawRes = await fetch(`${BASE_URL}${endpoint.path}`, {
        headers: { Authorization: `Bearer ${endpoint.token}` }
      });
      assert.strictEqual(rawRes.status, 200, `Expected 200 for ${endpoint.path}`);
      const cacheControl = (rawRes.headers.get('cache-control') || '').toLowerCase();
      assert(cacheControl.includes('no-store'), `${endpoint.path} must return Cache-Control: no-store`);
      assert.strictEqual((rawRes.headers.get('pragma') || '').toLowerCase(), 'no-cache');
      const varyHeader = (rawRes.headers.get('vary') || '').toLowerCase();
      assert(varyHeader.includes('authorization') && varyHeader.includes('x-machine-id'));
    }

    const crossMachineProdRes = await apiRequest(
      'GET',
      '/products?machine_id=CFX-MC-02',
      undefined,
      kiosk1Token
    );
    assert.strictEqual(
      crossMachineProdRes.status,
      403,
      'Kiosk bound to CFX-MC-01 must receive 403 when querying /products for CFX-MC-02'
    );
    console.log('  PASS: no-store cache headers present on all dynamic endpoints and cross-machine kiosk /products blocked.');

    // -------------------------------------------------------------------------
    // Test 14: Pre-payment inventory validation in POST /api/orders/create
    // -------------------------------------------------------------------------
    console.log('Test 14: POST /api/orders/create rejects depleted ingredients BEFORE Razorpay order creation...');
    await apiRequest(
      'PUT',
      '/machines/CFX-MC-01/products/2',
      { price: 115, is_available: true },
      ownerAToken
    );
    await getDB().run(
      'UPDATE inventory SET milk_level = ?, coffee_level = ?, vanilla_level = ?, hazelnut_level = ?, irish_level = ?, mocha_level = ?, water_level = ?, updated_at = ? WHERE machine_id = ?',
      [2, 100, 100, 100, 100, 100, 100, new Date().toISOString(), 'CFX-MC-01']
    );
    const lowMilkOrder = await apiRequest(
      'POST',
      '/orders/create',
      { product_id: 2, amount: 115, machine_id: 'CFX-MC-01', extra_sugar: true, base: 'milk' },
      kiosk1Token
    );
    assert.strictEqual(lowMilkOrder.status, 400);
    assert.strictEqual(lowMilkOrder.data.message, 'Ingredients depleted: Milk refill required');

    // Verify Vanilla syrup threshold (< 8) blocks Vanilla Velvet even when base ingredients are full
    await getDB().run(
      'UPDATE inventory SET milk_level = ?, coffee_level = ?, vanilla_level = ?, hazelnut_level = ?, irish_level = ?, mocha_level = ?, water_level = ?, updated_at = ? WHERE machine_id = ?',
      [100, 100, 7, 100, 100, 100, 100, new Date().toISOString(), 'CFX-MC-01']
    );
    const lowVanillaOrder = await apiRequest(
      'POST',
      '/orders/create',
      { product_id: 2, amount: 115, machine_id: 'CFX-MC-01', extra_sugar: true, base: 'water' },
      kiosk1Token
    );
    assert.strictEqual(lowVanillaOrder.status, 400);
    assert.strictEqual(lowVanillaOrder.data.message, 'Ingredients depleted: Vanilla syrup refill required');

    // Classic Crest (product_id 1) does not use vanilla syrup and must still be allowed when only vanilla is low
    const classicWhileVanillaLow = await apiRequest(
      'POST',
      '/orders/create',
      { product_id: 1, amount: 100, machine_id: 'CFX-MC-01', extra_sugar: true, base: 'water' },
      kiosk1Token
    );
    assert.strictEqual(classicWhileVanillaLow.status, 201);

    // Refill Vanilla via owner endpoint and verify Vanilla Velvet order creation succeeds again
    const refillVanilla = await apiRequest(
      'POST',
      '/machines/CFX-MC-01/refill',
      { ingredient: 'vanilla' },
      ownerAToken
    );
    assert.strictEqual(refillVanilla.status, 200);
    const vanillaAfterRefill = await apiRequest(
      'POST',
      '/orders/create',
      { product_id: 2, amount: 115, machine_id: 'CFX-MC-01', extra_sugar: true, base: 'water' },
      kiosk1Token
    );
    assert.strictEqual(vanillaAfterRefill.status, 201);
    console.log('  PASS: Depleted ingredients block checkout pre-payment and recover immediately on refill.');

    // Clean up test overrides/assignments after test completion
    await apiRequest('PATCH', '/machines/CFX-MC-01/owner', { owner_id: null }, adminToken);
    await apiRequest('PATCH', '/machines/CFX-MC-02/owner', { owner_id: null }, adminToken);
    await getDB().run('DELETE FROM machine_products');

    console.log(`\nALL STAGE 3 TESTS PASSED SUCCESSFULLY [${modeLabel}]!\n`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  process.exit(0);
}

runTests().catch((err) => {
  console.error('Stage 3 test suite failed:', err);
  process.exit(1);
});
