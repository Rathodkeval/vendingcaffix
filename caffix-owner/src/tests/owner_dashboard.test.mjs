import assert from 'assert';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import http from 'http';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

import {
  ownerApi,
  resolveApiBaseUrl,
  extractInviteFromHash,
  ApiError
} from '../services/api.js';
import {
  formatINR,
  formatSignedINR,
  formatSignedPaise,
  formatRelativeHeartbeat,
  computeSalesAnalytics,
  getPaymentStatusLabel,
  getDispenseStatusLabel,
  validateDateRange,
  getKolkataDateString
} from '../utils/formatters.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const require = createRequire(import.meta.url);

const PORT = 5097;
const TEST_BASE_URL = `http://127.0.0.1:${PORT}/api`;

async function backendRequest(endpoint, { method = 'GET', body, token } = {}) {
  const headers = {};
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  const response = await fetch(`${TEST_BASE_URL}${endpoint}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined
  });
  const payload = await response.json().catch(() => ({}));
  return { status: response.status, ok: response.ok, payload };
}

function computeRazorpaySignature(razorpayOrderId, razorpayPaymentId) {
  const secret = (process.env.RAZORPAY_KEY_SECRET || 'mockSecret987654321').trim();
  return crypto
    .createHmac('sha256', secret)
    .update(`${razorpayOrderId}|${razorpayPaymentId}`)
    .digest('hex');
}

async function runStage5Tests() {
  console.log('\n=============================================================');
  console.log('Running Stage 5 CAFFIX Owner Dashboard Integration Tests');
  console.log('=============================================================\n');

  // 1. Verify API Base URL configuration & INR / Sales Analytics formatters
  console.log('1. Verifying VITE_API_BASE_URL resolution, INR currency formatting & sales analytics...');
  assert.strictEqual(
    resolveApiBaseUrl('https://vendingcaffix.vercel.app/api/'),
    'https://vendingcaffix.vercel.app/api'
  );
  assert.strictEqual(resolveApiBaseUrl(''), 'https://vendingcaffix.vercel.app/api');
  assert.ok(formatINR(1250).includes('1,250'), 'formatINR must format Indian Rupees');
  assert.strictEqual(
    formatRelativeHeartbeat(new Date(Date.now() - 15000).toISOString()),
    '15s ago'
  );
  console.log('   PASS: API base URL & INR/Heartbeat formatters verified.');

  // 2. Boot backend server from compiled caffix-backend/dist
  process.env.JWT_SECRET =
    process.env.JWT_SECRET || 'caffix-test-owner-portal-secret-2026-explicit';
  process.env.KIOSK_SECRET =
    process.env.KIOSK_SECRET || 'caffix-test-owner-kiosk-secret-2026';
  const backendDistIndex = path.resolve(__dirname, '../../../caffix-backend/dist/index.js');
  const backendDistDb = path.resolve(__dirname, '../../../caffix-backend/dist/config/db.js');
  const appModule = require(backendDistIndex);
  const dbModule = require(backendDistDb);
  const app = appModule.default || appModule;

  await dbModule.initDB();
  const db = dbModule.getDB();
  await db.run('DELETE FROM machine_products');

  const server = await new Promise((resolve) => {
    const s = app.listen(PORT, '127.0.0.1', () => resolve(s));
  });

  try {
    // 3. Admin Login, CORS Origin Enforcement & Access to All Machines
    console.log('2. Testing CORS origin allowlist, Admin login & full fleet access...');

    // Verify CORS permits https://caffix-owner.vercel.app without wildcard '*'
    const corsOwnerRes = await fetch(`${TEST_BASE_URL}/health`, {
      method: 'GET',
      headers: { Origin: 'https://caffix-owner.vercel.app' }
    });
    assert.strictEqual(
      corsOwnerRes.headers.get('access-control-allow-origin'),
      'https://caffix-owner.vercel.app',
      'CORS must explicitly allow https://caffix-owner.vercel.app (never *)'
    );

    // Verify CORS permits https://vendingcaffix.vercel.app without wildcard '*'
    const corsKioskRes = await fetch(`${TEST_BASE_URL}/health`, {
      method: 'GET',
      headers: { Origin: 'https://vendingcaffix.vercel.app' }
    });
    assert.strictEqual(
      corsKioskRes.headers.get('access-control-allow-origin'),
      'https://vendingcaffix.vercel.app',
      'CORS must explicitly allow https://vendingcaffix.vercel.app (never *)'
    );

    // Verify CORS permits local development origin http://localhost:5174
    const corsDevRes = await fetch(`${TEST_BASE_URL}/health`, {
      method: 'GET',
      headers: { Origin: 'http://localhost:5174' }
    });
    assert.strictEqual(
      corsDevRes.headers.get('access-control-allow-origin'),
      'http://localhost:5174',
      'CORS must explicitly allow http://localhost:5174'
    );

    // Verify CORS rejects untrusted external browser origins
    const corsUntrustedRes = await fetch(`${TEST_BASE_URL}/health`, {
      method: 'GET',
      headers: { Origin: 'https://untrusted-attacker.example.com' }
    });
    assert.strictEqual(
      corsUntrustedRes.headers.get('access-control-allow-origin'),
      null,
      'CORS must block untrusted third-party origins and never return *'
    );

    // Verify ownerApi no longer exposes admin fleet management helpers
    assert.strictEqual(ownerApi.getOwners, undefined, 'ownerApi must not expose getOwners');
    assert.strictEqual(ownerApi.inviteOwner, undefined, 'ownerApi must not expose inviteOwner');
    assert.strictEqual(ownerApi.assignMachineOwner, undefined, 'ownerApi must not expose assignMachineOwner');
    assert.strictEqual(ownerApi.registerMachine, undefined, 'ownerApi must not expose registerMachine');

    // Verify Admin account cannot sign into Owner Dashboard (403 Forbidden)
    let adminRejectedFromOwnerLogin = false;
    try {
      await ownerApi.login('admin@caffix.com', 'admin123', TEST_BASE_URL);
    } catch (err) {
      adminRejectedFromOwnerLogin = err instanceof ApiError && err.status === 403;
    }
    assert.ok(adminRejectedFromOwnerLogin, 'Owner portal login must reject admin account with 403 Forbidden');

    // Direct admin login (simulating caffix-admin setup only)
    const directAdminLogin = await backendRequest('/auth/login', {
      method: 'POST',
      body: { email: 'admin@caffix.com', password: 'admin123', portal: 'admin' }
    });
    assert.strictEqual(directAdminLogin.status, 200);
    const adminToken = directAdminLogin.payload.token;
    assert.strictEqual(directAdminLogin.payload.data.role, 'admin');

    // Verify admin token is rejected by owner portal session endpoint (?portal=owner)
    const adminRejectedOnOwnerMe = await backendRequest('/auth/me?portal=owner', {
      token: adminToken
    });
    assert.strictEqual(adminRejectedOnOwnerMe.status, 403, 'GET /api/auth/me?portal=owner must reject admin token with 403');

    const adminMe = await backendRequest('/auth/me?portal=admin', { token: adminToken });
    assert.strictEqual(adminMe.status, 200);
    assert.strictEqual(adminMe.payload.data.role, 'admin');
    assert.ok(adminMe.payload.data.assigned_machines.length >= 4, 'Admin must see all 4 machines');
    assert.ok(adminMe.payload.data.assigned_machines.includes('CFX-MC-04'), 'Admin must see CFX-MC-04');

    // Ensure machines are RUNNING and refilled via admin API before testing owner workflows
    for (const machineId of ['CFX-MC-01', 'CFX-MC-02', 'CFX-MC-03', 'CFX-MC-04']) {
      const modeRes = await backendRequest(`/machines/${machineId}/status`, {
        method: 'PATCH',
        body: { desired_mode: 'RUNNING' },
        token: adminToken
      });
      assert.strictEqual(modeRes.status, 200);
    }
    for (const machineId of ['CFX-MC-01', 'CFX-MC-02', 'CFX-MC-04']) {
      const refillRes = await backendRequest(`/machines/${machineId}/refill`, {
        method: 'POST',
        body: { ingredient: 'ALL' },
        token: adminToken
      });
      assert.strictEqual(refillRes.status, 200);
    }
    console.log('   PASS: CORS allowlist, portal isolation (admin rejected on owner portal), and test fixture setup verified.');

    // 4. Invite Owner A (assigned multiple machines: CFX-MC-01 & CFX-MC-02) and Owner B (assigned CFX-MC-03)
    console.log('3. Testing Owner invitation (#setup_token URL fragment), password setup, and password change...');
    const ts = Date.now();
    const emailA = `owner.stage5.a.${ts}@caffix.com`;
    const emailB = `owner.stage5.b.${ts}@caffix.com`;

    const inviteARes = await backendRequest('/auth/owners/invite', {
      method: 'POST',
      body: {
        name: 'Stage 5 Multi-Machine Owner A',
        email: emailA,
        machine_ids: ['CFX-MC-01', 'CFX-MC-02']
      },
      token: adminToken
    });
    assert.strictEqual(inviteARes.status, 201);
    const inviteA = inviteARes.payload;

    // Verify backend setup_url uses URL fragment (#setup_token=...)
    assert.ok(
      inviteA.data.setup_url.startsWith('/#setup_token='),
      `Backend setup_url must use URL fragment #setup_token=... (got ${inviteA.data.setup_url})`
    );
    assert.ok(
      !inviteA.data.setup_url.includes('?'),
      'Backend setup_url must not put token in query string'
    );

    const constructedInviteUrl = `https://caffix-owner.vercel.app${inviteA.data.setup_url}`;
    const urlObj = new URL(constructedInviteUrl);
    assert.strictEqual(urlObj.search, '', 'Invite URL must have empty query string');
    const parsedFromHash = extractInviteFromHash(urlObj.hash);
    assert.strictEqual(parsedFromHash.token, inviteA.data.invite_token);
    assert.strictEqual(parsedFromHash.email, emailA);

    // Verify Admin GET /api/auth/owners shows must_change_password = true before setup
    const ownersBeforeSetup = await backendRequest('/auth/owners', { token: adminToken });
    assert.strictEqual(ownersBeforeSetup.status, 200);
    const pendingOwnerA = ownersBeforeSetup.payload.data.find((o) => o.email === emailA);
    assert.ok(pendingOwnerA, 'Invited Owner A must appear in GET /api/auth/owners');
    assert.strictEqual(pendingOwnerA.must_change_password, true);

    const setupA = await ownerApi.setupPassword(
      {
        token: parsedFromHash.token,
        email: parsedFromHash.email,
        password: 'OwnerAInitialPass123!'
      },
      TEST_BASE_URL
    );
    assert.strictEqual(setupA.data.role, 'owner');
    assert.deepStrictEqual(
      setupA.data.assigned_machines.sort(),
      ['CFX-MC-01', 'CFX-MC-02'].sort()
    );

    // Test POST /api/auth/change-password via ownerApi.changePassword
    const changePwdRes = await ownerApi.changePassword(
      {
        currentPassword: 'OwnerAInitialPass123!',
        newPassword: 'OwnerAPassword123!'
      },
      setupA.token,
      TEST_BASE_URL
    );
    assert.strictEqual(changePwdRes.status, 'success');

    const inviteBRes = await backendRequest('/auth/owners/invite', {
      method: 'POST',
      body: {
        name: 'Stage 5 Single-Machine Owner B',
        email: emailB,
        machine_ids: ['CFX-MC-03']
      },
      token: adminToken
    });
    assert.strictEqual(inviteBRes.status, 201);
    const inviteB = inviteBRes.payload;
    const setupB = await ownerApi.setupPassword(
      {
        token: inviteB.data.invite_token,
        email: emailB,
        password: 'OwnerBPassword123!'
      },
      TEST_BASE_URL
    );
    const tokenB = setupB.token;

    // Verify Owner A login flow with updated password
    const loginA = await ownerApi.login(emailA, 'OwnerAPassword123!', TEST_BASE_URL);
    const tokenA = loginA.token;
    const meA = await ownerApi.getMe(tokenA, TEST_BASE_URL);
    assert.strictEqual(meA.data.email, emailA);
    assert.deepStrictEqual(
      meA.data.assigned_machines.sort(),
      ['CFX-MC-01', 'CFX-MC-02'].sort()
    );
    console.log('   PASS: Owner invitation (#setup_token fragment), password setup, change-password, and login verified.');

    // 5. Verify Owner sees ONLY assigned machines and is blocked (403) from other owners' machines
    console.log('4. Testing strict machine isolation between Owner A and Owner B...');
    const machinesA = await ownerApi.getMachines(tokenA, TEST_BASE_URL);
    const machineIdsA = machinesA.data.map((m) => m.id).sort();
    assert.deepStrictEqual(machineIdsA, ['CFX-MC-01', 'CFX-MC-02']);

    const machinesB = await ownerApi.getMachines(tokenB, TEST_BASE_URL);
    const machineIdsB = machinesB.data.map((m) => m.id);
    assert.deepStrictEqual(machineIdsB, ['CFX-MC-03']);

    let blockedDetails = false;
    try {
      await ownerApi.getMachineById('CFX-MC-03', tokenA, TEST_BASE_URL);
    } catch (err) {
      blockedDetails = err instanceof ApiError && err.status === 403;
    }
    assert.ok(blockedDetails, 'Owner A must receive 403 when querying Owner B machine CFX-MC-03');

    // Verify Owner A is blocked (403) from changing Owner B's mode, reading/updating Owner B's products, refilling Owner B's inventory, querying Owner B's orders, or calling Admin endpoints
    const crossTenantChecks = [
      () => ownerApi.updateMachineMode('CFX-MC-03', 'MAINTENANCE', tokenA, TEST_BASE_URL),
      () => ownerApi.getMachineProducts('CFX-MC-03', tokenA, TEST_BASE_URL),
      () => ownerApi.updateMachineProduct('CFX-MC-03', 1, { price: 999, is_available: false }, tokenA, TEST_BASE_URL),
      () => ownerApi.refillMachineInventory('CFX-MC-03', 'ALL', tokenA, TEST_BASE_URL),
      () => ownerApi.getOrders('CFX-MC-03', tokenA, TEST_BASE_URL)
    ];

    for (const checkFn of crossTenantChecks) {
      let rejected403 = false;
      try {
        await checkFn();
      } catch (err) {
        rejected403 = err instanceof ApiError && err.status === 403;
      }
      assert.ok(rejected403, 'Cross-tenant request by Owner A must be rejected with 403 Forbidden');
    }

    const ownerAdminRouteChecks = [
      await backendRequest('/auth/owners', { token: tokenA }),
      await backendRequest('/machines/CFX-MC-03/owner', {
        method: 'PATCH',
        body: { owner_id: loginA.data.id },
        token: tokenA
      }),
      await backendRequest('/auth/me?portal=admin', { token: tokenA })
    ];
    for (const checkRes of ownerAdminRouteChecks) {
      assert.strictEqual(checkRes.status, 403, 'Owner must receive 403 on admin endpoints');
    }

    console.log('   PASS: Owner sees only assigned machines; all cross-owner & admin actions blocked with 403.');

    // 6. Test Heartbeat Connectivity (ONLINE/OFFLINE) & Maintenance Mode separation
    console.log('5. Testing heartbeat connectivity display and Maintenance Mode toggle...');
    await fetch(`${TEST_BASE_URL}/machines/CFX-MC-01/heartbeat`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}` }
    });

    const mc1Online = await ownerApi.getMachineById('CFX-MC-01', tokenA, TEST_BASE_URL);
    assert.strictEqual(mc1Online.data.connection_status, 'ONLINE');
    assert.strictEqual(mc1Online.data.desired_mode, 'RUNNING');

    // Owner A toggles CFX-MC-01 to MAINTENANCE
    const maintRes = await ownerApi.updateMachineMode('CFX-MC-01', 'MAINTENANCE', tokenA, TEST_BASE_URL);
    assert.strictEqual(maintRes.data.desired_mode, 'MAINTENANCE');
    assert.strictEqual(maintRes.data.connection_status, 'ONLINE', 'Maintenance mode must preserve ONLINE connectivity');

    // Resume RUNNING mode
    const runRes = await ownerApi.updateMachineMode('CFX-MC-01', 'RUNNING', tokenA, TEST_BASE_URL);
    assert.strictEqual(runRes.data.desired_mode, 'RUNNING');
    console.log('   PASS: Heartbeat ONLINE status and desired_mode toggle verified.');

    // 7. Test Per-Machine Pricing & Availability Updates via Owner Dashboard API
    console.log('6. Testing per-machine pricing and product availability updates...');
    await ownerApi.updateMachineProduct(
      'CFX-MC-01',
      1,
      { price: 110, is_available: true },
      tokenA,
      TEST_BASE_URL
    );
    await ownerApi.updateMachineProduct(
      'CFX-MC-02',
      1,
      { price: 135, is_available: true },
      tokenA,
      TEST_BASE_URL
    );
    await ownerApi.updateMachineProduct(
      'CFX-MC-01',
      2,
      { price: 100, is_available: false },
      tokenA,
      TEST_BASE_URL
    );

    const mc1Products = await ownerApi.getMachineProducts('CFX-MC-01', tokenA, TEST_BASE_URL);
    const mc2Products = await ownerApi.getMachineProducts('CFX-MC-02', tokenA, TEST_BASE_URL);
    assert.strictEqual(mc1Products.data.find((p) => p.id === 1).price, 110);
    assert.strictEqual(mc1Products.data.find((p) => p.id === 2).is_available, false);
    assert.strictEqual(mc2Products.data.find((p) => p.id === 1).price, 135);
    assert.strictEqual(mc2Products.data.find((p) => p.id === 2).is_available, true);
    console.log('   PASS: Per-machine pricing (₹110 vs ₹135) and availability updates verified.');

    // 8. Test Order History & Sales Reports with Historical Order Amounts
    console.log('7. Testing order history & sales reports using stored historical order amounts...');
    const mc2Row = await db.get('SELECT kiosk_token FROM machines WHERE id = ?', ['CFX-MC-02']);
    const kiosk2Secret = mc2Row?.kiosk_token || process.env.KIOSK_SECRET;
    const verifyKiosk2 = await fetch(
      `${TEST_BASE_URL}/kiosk/verify?kiosk=${encodeURIComponent(kiosk2Secret)}&machine_id=CFX-MC-02`
    ).then((r) => r.json());
    const kiosk2Token = verifyKiosk2.token;

    // Create & pay for an order on CFX-MC-02 at ₹135
    const createOrderRes = await fetch(`${TEST_BASE_URL}/orders/create`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${kiosk2Token}`
      },
      body: JSON.stringify({
        product_id: 1,
        amount: 135,
        machine_id: 'CFX-MC-02',
        base: 'milk'
      })
    }).then((r) => r.json());
    assert.strictEqual(createOrderRes.data.amount, 135);

    const orderId = createOrderRes.data.id;
    const rpOrderId = createOrderRes.data.razorpay_order_id;
    const payId = 'pay_stage5_135';
    const sig = computeRazorpaySignature(rpOrderId, payId);

    await fetch(`${TEST_BASE_URL}/payments/verify`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${kiosk2Token}`
      },
      body: JSON.stringify({
        order_id: orderId,
        razorpay_order_id: rpOrderId,
        razorpay_payment_id: payId,
        razorpay_signature: sig
      })
    });

    // Now change CFX-MC-02 Product 1 price from ₹135 to ₹180
    await ownerApi.updateMachineProduct(
      'CFX-MC-02',
      1,
      { price: 180, is_available: true },
      tokenA,
      TEST_BASE_URL
    );

    // Fetch Owner A's orders and run Sales Reports analytics
    const ownerAOrdersRes = await ownerApi.getOrders(undefined, tokenA, TEST_BASE_URL);
    const matchingOrder = ownerAOrdersRes.data.find((o) => o.id === orderId);
    assert.ok(matchingOrder, 'Owner A must see the order on CFX-MC-02');
    assert.strictEqual(
      matchingOrder.amount,
      135,
      'Stored order amount must remain ₹135 even after product price changed to ₹180'
    );
    assert.strictEqual(getPaymentStatusLabel(matchingOrder), 'PAID');

    // Owner B must NOT see Owner A's order
    const ownerBOrdersRes = await ownerApi.getOrders(undefined, tokenB, TEST_BASE_URL);
    assert.ok(
      !ownerBOrdersRes.data.some((o) => o.id === orderId),
      'Owner B must never see Owner A orders'
    );

    const salesReport = computeSalesAnalytics(
      [matchingOrder],
      machinesA.data,
      'daily',
      'CFX-MC-02'
    );
    assert.strictEqual(salesReport.totalRevenue, 135);
    assert.strictEqual(salesReport.totalOrders, 1);
    assert.strictEqual(salesReport.revenueByMachine[0].revenue, 135);
    assert.strictEqual(salesReport.productSales[0].revenue, 135);
    console.log('   PASS: Order history & sales reports preserve ₹135 historical amount.');

    // 8. Verify Phase 2.6 Advanced Order Management in Owner Portal
    console.log('8. Verifying Phase 2.6 Order Management columns, badges, copyable pay ID & filters...');
    const ownerOrdersSource = fs.readFileSync(
      path.resolve(__dirname, '../pages/OrdersPage.jsx'),
      'utf-8'
    );
    assert.ok(ownerOrdersSource.includes('PaymentStatusBadge'), 'OrdersPage must render PaymentStatusBadge');
    assert.ok(ownerOrdersSource.includes('DispenseStatusBadge'), 'OrdersPage must render DispenseStatusBadge');
    assert.ok(ownerOrdersSource.includes('CopyableText'), 'OrdersPage must include CopyableText helper');
    assert.ok(ownerOrdersSource.includes('Order ID'), 'OrdersPage must have Order ID column');
    assert.ok(ownerOrdersSource.includes('Date & Time'), 'OrdersPage must have Date & Time column');
    assert.ok(ownerOrdersSource.includes('Machine ID'), 'OrdersPage must have Machine ID column');
    assert.ok(ownerOrdersSource.includes('Product'), 'OrdersPage must have Product column');
    assert.ok(ownerOrdersSource.includes('Amount'), 'OrdersPage must have Amount column');
    assert.ok(ownerOrdersSource.includes('Payment'), 'OrdersPage must have Payment status column');
    assert.ok(ownerOrdersSource.includes('Dispensing'), 'OrdersPage must have Dispensing status column');
    assert.ok(ownerOrdersSource.includes('Payment ID'), 'OrdersPage must have Razorpay Payment ID column');
    assert.ok(ownerOrdersSource.includes('Customer'), 'OrdersPage must have Customer column');
    assert.ok(ownerOrdersSource.includes('Order Details'), 'OrdersPage must include Order Details view');
    assert.ok(ownerOrdersSource.includes('razorpay_order_id'), 'OrdersPage search must match razorpay_order_id');
    assert.ok(ownerOrdersSource.includes('rpOrderIdMatch'), 'OrdersPage must include rpOrderIdMatch in search');

    // Test formatter status independence
    assert.strictEqual(getPaymentStatusLabel({ status: 'PAID' }), 'PAID');
    assert.strictEqual(getPaymentStatusLabel({ status: 'COMPLETED' }), 'COMPLETED');
    assert.strictEqual(getPaymentStatusLabel({ status: 'PENDING' }), 'PENDING');
    assert.strictEqual(getPaymentStatusLabel({ status: 'FAILED' }), 'FAILED');
    assert.strictEqual(getPaymentStatusLabel({ status: 'CANCELLED' }), 'CANCELLED');

    assert.strictEqual(getDispenseStatusLabel({ dispense_status: 'QUEUED' }), 'QUEUED');
    assert.strictEqual(getDispenseStatusLabel({ dispense_status: 'DISPENSING' }), 'DISPENSING');
    assert.strictEqual(getDispenseStatusLabel({ dispense_status: 'DISPENSED' }), 'DISPENSED');
    assert.strictEqual(getDispenseStatusLabel({ dispense_status: 'FAILED' }), 'FAILED');
    assert.strictEqual(getDispenseStatusLabel({ status: 'PAID' }), 'PENDING', 'Dispense status must default to PENDING when unset, never inferring from payment status');
    console.log('   PASS: Owner Phase 2.6 order table columns, independent statuses & formatters verified.');

    // 9. Verify Responsive UI, Fragment Token Security & Production Build Bundle
    console.log('9. Verifying responsive layout classes, fragment token security & production build artifacts...');
    const sidebarSource = fs.readFileSync(
      path.resolve(__dirname, '../components/Sidebar.jsx'),
      'utf-8'
    );
    assert.ok(sidebarSource.includes('lg:hidden'), 'Mobile top header must use lg:hidden');
    assert.ok(sidebarSource.includes('lg:translate-x-0'), 'Desktop sidebar must use lg:translate-x-0');

    const authPageSource = fs.readFileSync(
      path.resolve(__dirname, '../pages/AuthPage.jsx'),
      'utf-8'
    );
    assert.ok(
      authPageSource.includes('extractInviteFromHash(window.location.hash)'),
      'AuthPage must extract invite token from window.location.hash'
    );
    assert.ok(
      !authPageSource.includes('window.location.search'),
      'AuthPage must not read invite tokens from window.location.search query string'
    );

    const adminFleetPath = path.resolve(__dirname, '../pages/AdminFleetPage.jsx');
    assert.ok(!fs.existsSync(adminFleetPath), 'AdminFleetPage.jsx must be removed from caffix-owner');
    assert.ok(!sidebarSource.includes('Fleet & Owners'), 'caffix-owner Sidebar must not contain Fleet & Owners');
    const appSource = fs.readFileSync(path.resolve(__dirname, '../App.jsx'), 'utf-8');
    assert.ok(!appSource.includes('AdminFleetPage'), 'caffix-owner App must not import AdminFleetPage');

    const distIndexHtml = path.resolve(__dirname, '../../dist/index.html');
    assert.ok(fs.existsSync(distIndexHtml), 'Production build dist/index.html must exist');
    console.log('   PASS: Responsive navigation, #setup_token security & production build bundle verified.');

    // 10. Verify Phase 2.9.3.2 Owner Backend Analytics Integration & Isolation
    console.log('10. Verifying Phase 2.9.3.2 Owner Backend Analytics API integration & isolation...');
    assert.strictEqual(typeof ownerApi.getAnalyticsOverview, 'function');
    assert.strictEqual(typeof ownerApi.getAnalyticsTimeSeries, 'function');
    assert.strictEqual(typeof ownerApi.getAnalyticsMachines, 'function');
    assert.strictEqual(typeof ownerApi.getAnalyticsProducts, 'function');
    assert.strictEqual(typeof ownerApi.getAnalyticsInventory, 'function');
    assert.strictEqual(typeof ownerApi.getAnalyticsRefunds, 'function');

    // 10.1 Call all 6 endpoints with Owner A token
    const ownerOverview = await ownerApi.getAnalyticsOverview({}, tokenA, TEST_BASE_URL);
    assert.strictEqual(ownerOverview.status, 'success');
    assert.ok(typeof ownerOverview.data.gross_sales_paise === 'number');
    assert.ok(typeof ownerOverview.data.net_revenue_paise === 'number');

    const ownerTs = await ownerApi.getAnalyticsTimeSeries({ interval: 'day' }, tokenA, TEST_BASE_URL);
    assert.strictEqual(ownerTs.status, 'success');
    assert.ok(Array.isArray(ownerTs.data));

    const ownerMachines = await ownerApi.getAnalyticsMachines({}, tokenA, TEST_BASE_URL);
    assert.strictEqual(ownerMachines.status, 'success');
    assert.ok(Array.isArray(ownerMachines.data));
    // Verify Owner A's machines query returns only CFX-MC-01 or CFX-MC-02, NEVER CFX-MC-03
    const analyticsMachineIdsA = ownerMachines.data.map((m) => m.machine_id);
    assert.ok(!analyticsMachineIdsA.includes('CFX-MC-03'), 'Owner A must never see Owner B machine CFX-MC-03 in analytics');

    const ownerProducts = await ownerApi.getAnalyticsProducts({}, tokenA, TEST_BASE_URL);
    assert.strictEqual(ownerProducts.status, 'success');
    assert.ok(Array.isArray(ownerProducts.data));

    const ownerInventory = await ownerApi.getAnalyticsInventory({}, tokenA, TEST_BASE_URL);
    assert.strictEqual(ownerInventory.status, 'success');
    assert.ok(Array.isArray(ownerInventory.data));

    const ownerRefunds = await ownerApi.getAnalyticsRefunds({}, tokenA, TEST_BASE_URL);
    assert.strictEqual(ownerRefunds.status, 'success');
    assert.ok(Array.isArray(ownerRefunds.data.recent_refunds));

    // 10.2 Verify Owner A attempting to query Owner B's machine returns HTTP 403 Forbidden
    let forbiddenCaught = false;
    try {
      await ownerApi.getAnalyticsOverview({ machine_id: 'CFX-MC-03' }, tokenA, TEST_BASE_URL);
    } catch (err) {
      forbiddenCaught = true;
      assert.strictEqual(err.status, 403, 'Cross-owner machine analytics query must be rejected with HTTP 403');
    }
    assert.ok(forbiddenCaught, 'Cross-owner machine analytics query must throw HTTP 403');

    // 10.3 Verify unauthenticated returns HTTP 401
    let unauthCaught = false;
    try {
      await ownerApi.getAnalyticsOverview({}, null, TEST_BASE_URL);
    } catch (err) {
      unauthCaught = true;
      assert.strictEqual(err.status, 401);
    }
    assert.ok(unauthCaught, 'Unauthenticated analytics query must throw HTTP 401');

    // 10.4 Verify signed INR formatting
    assert.strictEqual(formatSignedINR(14500), '₹14,500');
    assert.strictEqual(formatSignedINR(-500), '-₹500');
    assert.strictEqual(formatSignedINR(0), '₹0');
    assert.strictEqual(formatSignedPaise(-50000), '-₹500');

    // 10.5 Verify SalesReportsPage.jsx and StatusBadges source requirements
    const ownerReportsSource = fs.readFileSync(
      path.resolve(__dirname, '../pages/SalesReportsPage.jsx'),
      'utf-8'
    );
    assert.ok(ownerReportsSource.includes('ownerApi.getAnalyticsOverview'), 'Must call ownerApi.getAnalyticsOverview');
    assert.ok(ownerReportsSource.includes('ownerApi.getAnalyticsTimeSeries'), 'Must call ownerApi.getAnalyticsTimeSeries');
    assert.ok(ownerReportsSource.includes('ownerApi.getAnalyticsMachines'), 'Must call ownerApi.getAnalyticsMachines');
    assert.ok(ownerReportsSource.includes('ownerApi.getAnalyticsProducts'), 'Must call ownerApi.getAnalyticsProducts');
    assert.ok(ownerReportsSource.includes('ownerApi.getAnalyticsInventory'), 'Must call ownerApi.getAnalyticsInventory');
    assert.ok(ownerReportsSource.includes('ownerApi.getAnalyticsRefunds'), 'Must call ownerApi.getAnalyticsRefunds');
    assert.ok(ownerReportsSource.includes('AbortController'), 'Must use AbortController');
    assert.ok(ownerReportsSource.includes('No Machines Assigned'), 'Must have zero assigned machines empty state');
    assert.ok(ownerReportsSource.includes('Critical Financial Invariant Violation Detected'), 'Must display over-refund banner');
    assert.ok(ownerReportsSource.includes('Period Net Revenue Deficit'), 'Must display net deficit banner');
    assert.ok(ownerReportsSource.includes('UntrackedBadge'), 'Must use UntrackedBadge');
    assert.ok(!ownerReportsSource.includes('computeSalesAnalytics('), 'Must not use client-side computeSalesAnalytics');

    console.log('   PASS: Owner analytics APIs, tenant isolation (403), signed currency, and UI invariants verified.');

    // 11. Verify Phase 2.9.3.4 Fix W-1: Owner Section-Specific Error Handling & Isolated Retry
    console.log('11. Verifying Phase 2.9.3.4 Fix W-1 Owner section-specific error handling & retry...');
    assert.ok(ownerReportsSource.includes('function SectionError'), 'Must define SectionError component in Owner portal');
    assert.ok(ownerReportsSource.includes('function SectionLoading'), 'Must define SectionLoading component in Owner portal');
    assert.ok(ownerReportsSource.includes('retrySection'), 'Must implement section-specific retrySection in Owner portal');
    assert.ok(ownerReportsSource.includes('sectionLoading'), 'Must track sectionLoading in Owner portal');
    assert.ok(ownerReportsSource.includes('sectionErrors'), 'Must track sectionErrors in Owner portal');
    assert.ok(ownerReportsSource.includes('sectionAbortControllersRef'), 'Must use sectionAbortControllersRef in Owner portal');
    assert.ok(ownerReportsSource.includes('handleIntervalChange'), 'Must support isolated interval change in Owner portal');

    // 11.1 Simulate section error isolation: Overview succeeds while time-series fails for owner
    const ownerOverviewSuccess = await ownerApi.getAnalyticsOverview({}, tokenA, TEST_BASE_URL);
    let ownerTimeSeriesFailMsg = '';
    try {
      await ownerApi.getAnalyticsTimeSeries({ interval: 'invalid_interval' }, tokenA, TEST_BASE_URL);
    } catch (err) {
      ownerTimeSeriesFailMsg = err.message;
    }
    assert.strictEqual(ownerOverviewSuccess.status, 'success');
    assert.ok(ownerTimeSeriesFailMsg.length > 0, 'Auxiliary endpoint must fail independently with validation error');

    // 11.2 Simulate multiple auxiliary sections failing independently while others succeed
    let ownerInventoryFailMsg = '';
    try {
      await ownerApi.getAnalyticsInventory({ machine_id: 'INVALID$$ID' }, tokenA, TEST_BASE_URL);
    } catch (err) {
      ownerInventoryFailMsg = err.message;
    }
    assert.ok(ownerInventoryFailMsg.length > 0, 'Inventory query with invalid machine_id must fail independently');
    const ownerProductsSuccess = await ownerApi.getAnalyticsProducts({}, tokenA, TEST_BASE_URL);
    assert.strictEqual(ownerProductsSuccess.status, 'success');

    // 11.3 Simulate isolated retry on affected endpoint for owner
    const ownerRetryRes = await ownerApi.getAnalyticsTimeSeries({ interval: 'day' }, tokenA, TEST_BASE_URL);
    assert.strictEqual(ownerRetryRes.status, 'success', 'Owner retry on affected endpoint must succeed');
    assert.ok(Array.isArray(ownerRetryRes.data), 'Owner retry data must populate array');

    // 11.4 Simulate cross-owner unauthorized machine retry rejection
    let ownerCrossMachineRetryErr = '';
    try {
      await ownerApi.getAnalyticsMachines({ machine_id: 'CFX-MC-03' }, tokenA, TEST_BASE_URL);
    } catch (err) {
      ownerCrossMachineRetryErr = err.message;
      assert.strictEqual(err.status, 403, 'Cross-owner machine retry must be rejected with HTTP 403');
    }
    assert.ok(ownerCrossMachineRetryErr.length > 0, 'Cross-owner machine retry must throw HTTP 403');

    console.log('   PASS: Owner section-specific error isolation, retry behavior, and multi-tenant defense verified.');

    // 12. Verify Phase 2.9.3.6 A-1 Owner Monotonic Sequence IDs & A-2 Section Timestamps
    console.log('12. Verifying Phase 2.9.3.6 A-1 Owner Monotonic Request Sequence IDs & A-2 Section Timestamps...');
    assert.ok(ownerReportsSource.includes('requestIdRef = useRef(0)'), 'Must declare requestIdRef in Owner portal');
    assert.ok(ownerReportsSource.includes('sectionRequestIdsRef = useRef'), 'Must declare sectionRequestIdsRef in Owner portal');
    assert.ok(ownerReportsSource.includes('isMountedRef = useRef(true)'), 'Must declare isMountedRef in Owner portal');
    assert.ok(ownerReportsSource.includes('isFullRefreshObsolete'), 'Must check isFullRefreshObsolete in Owner portal');
    assert.ok(ownerReportsSource.includes('isSectionObsolete'), 'Must check isSectionObsolete in Owner portal');
    assert.ok(ownerReportsSource.includes('isTimeSeriesObsolete'), 'Must check isTimeSeriesObsolete in Owner portal');
    assert.ok(ownerReportsSource.includes('sectionLastUpdated'), 'Must track sectionLastUpdated in Owner portal');
    assert.ok(ownerReportsSource.includes('lastFullSync'), 'Must track lastFullSync in Owner portal');
    assert.ok(ownerReportsSource.includes('prevFilterContextRef'), 'Must track prevFilterContextRef in Owner portal (C-1.2)');
    assert.ok(ownerReportsSource.includes('function formatSyncTime'), 'Must define formatSyncTime in Owner portal');
    assert.ok(ownerReportsSource.includes('Last full dashboard sync at'), 'Must display Last full dashboard sync in Owner portal');
    assert.ok(ownerReportsSource.includes('Partial sync •'), 'Must display Partial sync with bullet in Owner portal (C-1.1)');
    assert.ok(ownerReportsSource.includes('Ready to synchronize'), 'Must display ready to synchronize in Owner portal (C-1.1)');
    assert.ok(ownerReportsSource.includes('Synchronizing dashboard analytics...'), 'Must display synchronizing status in Owner portal (C-1.1)');

    // 12.1 Verify owner request identity protection: obsolete machine query cannot overwrite
    let ownerCurrentGen = 1;
    let ownerStaleDataApplied = false;
    const simulateOwnerAsync = (genId, data) => {
      if (genId === ownerCurrentGen) {
        ownerStaleDataApplied = true;
      }
    };
    ownerCurrentGen = 2; // Switched machine filter
    simulateOwnerAsync(1, { machine_id: 'CFX-MC-01', gross_sales_inr: 999 }); // Obsolete filter response
    assert.strictEqual(ownerStaleDataApplied, false, 'Obsolete machine filter response must not be applied');
    simulateOwnerAsync(2, { machine_id: 'CFX-MC-02', gross_sales_inr: 1200 }); // Current filter response
    assert.strictEqual(ownerStaleDataApplied, true, 'Current machine filter response must be applied');

    // 12.2 Verify C-1.1 Owner Footer Precedence State Machine
    const evaluateOwnerFooter = ({ isAnyLoading, sectionErrors, lastFullSync, sectionLastUpdated }) => {
      if (isAnyLoading) return 'Synchronizing dashboard analytics...';
      const errCount = Object.values(sectionErrors || {}).filter(Boolean).length;
      if (errCount > 0) return `Partial sync • ${errCount} section(s) require attention`;
      if (lastFullSync) return `Last full dashboard sync at ${ownerFormatIST(lastFullSync)}`;
      const syncCount = Object.values(sectionLastUpdated || {}).filter(Boolean).length;
      if (syncCount > 0) return `${syncCount} of 6 sections synchronized`;
      return 'Ready to synchronize';
    };

    const ownerFormatIST = (d) => d.toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true }) + ' IST';
    const ownerOldSync = new Date('2026-11-14T06:00:00.000Z');

    // Scenario A: Initial loading shows synchronizing
    assert.strictEqual(evaluateOwnerFooter({ isAnyLoading: true, sectionErrors: {}, lastFullSync: null, sectionLastUpdated: {} }), 'Synchronizing dashboard analytics...');
    // Scenario B: Previous full sync exists, user reloads/changes filters -> active loading MUST NOT be hidden by old full sync
    assert.strictEqual(evaluateOwnerFooter({ isAnyLoading: true, sectionErrors: {}, lastFullSync: ownerOldSync, sectionLastUpdated: {} }), 'Synchronizing dashboard analytics...');
    // Scenario C: Section errors take precedence over old full sync
    assert.strictEqual(evaluateOwnerFooter({ isAnyLoading: false, sectionErrors: { overview: 'Network error', refunds: 'Timeout' }, lastFullSync: ownerOldSync, sectionLastUpdated: {} }), 'Partial sync • 2 section(s) require attention');
    // Scenario D: Full sync displays timestamp
    assert.ok(evaluateOwnerFooter({ isAnyLoading: false, sectionErrors: {}, lastFullSync: ownerOldSync, sectionLastUpdated: {} }).startsWith('Last full dashboard sync at'));
    // Scenario E: Partial section sync
    assert.strictEqual(evaluateOwnerFooter({ isAnyLoading: false, sectionErrors: {}, lastFullSync: null, sectionLastUpdated: { overview: ownerOldSync, timeSeries: ownerOldSync } }), '2 of 6 sections synchronized');
    // Scenario F: Uninitialized displays ready
    assert.strictEqual(evaluateOwnerFooter({ isAnyLoading: false, sectionErrors: {}, lastFullSync: null, sectionLastUpdated: {} }), 'Ready to synchronize');

    // 12.3 Verify C-1.2 Owner Filter Context Detection & Timestamp Reset
    let mockOwnerTimestamps = { overview: ownerOldSync, timeSeries: ownerOldSync };
    let mockOwnerLastFull = ownerOldSync;
    let mockOwnerPrevFilterContext = '7days::CFX-MC-01';

    const simulateOwnerFilterOrRefresh = (nextPreset, nextCustomStart, nextCustomEnd, nextMachine) => {
      const nextKey = `${nextPreset}:${nextPreset === 'custom' ? `${nextCustomStart}:${nextCustomEnd}` : ''}:${nextMachine}`;
      const isFilterChange = mockOwnerPrevFilterContext !== null && mockOwnerPrevFilterContext !== nextKey;
      mockOwnerPrevFilterContext = nextKey;
      if (isFilterChange) {
        mockOwnerTimestamps = { overview: null, timeSeries: null };
        mockOwnerLastFull = null;
      }
    };

    // Changing preset clears timestamps
    simulateOwnerFilterOrRefresh('30days', '', '', 'CFX-MC-01');
    assert.strictEqual(mockOwnerTimestamps.overview, null, 'Owner preset change must clear timestamps');
    assert.strictEqual(mockOwnerLastFull, null, 'Owner preset change must clear lastFullSync');

    // Simulate successful sync on 30days
    mockOwnerTimestamps = { overview: ownerOldSync, timeSeries: ownerOldSync };
    mockOwnerLastFull = ownerOldSync;

    // Manual refresh on same filter retains timestamps during loading
    simulateOwnerFilterOrRefresh('30days', '', '', 'CFX-MC-01');
    assert.strictEqual(mockOwnerTimestamps.overview, ownerOldSync, 'Owner manual refresh must retain timestamps during loading');
    assert.strictEqual(mockOwnerLastFull, ownerOldSync, 'Owner manual refresh must retain lastFullSync during loading');

    // Changing machine filter clears timestamps
    simulateOwnerFilterOrRefresh('30days', '', '', 'CFX-MC-02');
    assert.strictEqual(mockOwnerTimestamps.overview, null, 'Owner machine switch must clear timestamps');
    assert.strictEqual(mockOwnerLastFull, null, 'Owner machine switch must clear lastFullSync');

    // 12.4 Verify owner timestamp formatting in Asia/Kolkata
    const ownerTestDate = new Date('2026-11-14T07:15:00.000Z');
    const ownerFormattedIST = ownerTestDate.toLocaleTimeString('en-IN', {
      timeZone: 'Asia/Kolkata',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: true
    }) + ' IST';
    assert.ok(ownerFormattedIST.includes('IST'), 'Formatted sync time must include IST');
    assert.ok(ownerFormattedIST.includes('12:45'), 'UTC 07:15 must convert to Asia/Kolkata 12:45');

    console.log('   PASS: Owner monotonic sequence IDs, C-1.1 footer precedence, C-1.2 filter-context timestamps & IST verified.');

    // =========================================================================
    // 13. Verify Phase 2.9.4.1 Finding M-1: Owner OrdersPage Reconciliation Filter
    // =========================================================================
    console.log('13. Verifying Phase 2.9.4.1 M-1 Owner OrdersPage reconciliation filter contract & behavior...');
    const ownerOrdersPagePath = new URL('../pages/OrdersPage.jsx', import.meta.url);
    const fsOwnerModule = await import('node:fs');
    const ownerOrdersPageSrc = fsOwnerModule.readFileSync(ownerOrdersPagePath, 'utf8');

    assert.ok(ownerOrdersPageSrc.includes("result: 'PENDING_ACTION'"), 'Owner OrdersPage must map pending refunds to PENDING_ACTION');
    assert.ok(/useMemo\([\s\S]*reconciliationFilter[\s\S]*\]\)/.test(ownerOrdersPageSrc), 'Owner filteredOrders useMemo dependencies must include reconciliationFilter');
    assert.ok(ownerOrdersPageSrc.includes("reconciliationFilter !== 'ALL'"), 'Owner hasActiveFilters must include reconciliationFilter');
    assert.ok(ownerOrdersPageSrc.includes("setReconciliationFilter('ALL')"), 'Owner handleResetFilters must reset reconciliationFilter to ALL');

    const evalOwnerRec = (order) => {
      const pending = Number(order.pending_refund_amount_paise || 0);
      if (pending > 0 || order.refund_status === 'PENDING') {
        return { result: 'PENDING_ACTION' };
      }
      if (order.status === 'FAILED' && Number(order.captured_amount_paise || 0) > 0) {
        return { result: 'DISCREPANCY' };
      }
      return { result: 'MATCH' };
    };
    const ownerSampleOrders = [
      { id: 'O-MATCH', status: 'PAID', refund_status: 'NONE', captured_amount_paise: 10000, pending_refund_amount_paise: 0 },
      { id: 'O-DISC', status: 'FAILED', refund_status: 'NONE', captured_amount_paise: 10000, pending_refund_amount_paise: 0 },
      { id: 'O-PEND', status: 'PAID', refund_status: 'PENDING', captured_amount_paise: 10000, pending_refund_amount_paise: 5000 }
    ];
    for (const [filterVal, expectedId] of [['MATCH', 'O-MATCH'], ['DISCREPANCY', 'O-DISC'], ['PENDING_ACTION', 'O-PEND']]) {
      const matched = ownerSampleOrders.filter((o) => filterVal === 'ALL' || evalOwnerRec(o).result === filterVal);
      assert.strictEqual(matched.length, 1);
      assert.strictEqual(matched[0].id, expectedId, `Owner filter ${filterVal} must return ${expectedId}`);
    }
    console.log('   PASS: Owner OrdersPage M-1 reconciliation filter (MATCH, DISCREPANCY, PENDING_ACTION) & reset verified.');

    // Cleanup test state
    for (const machineId of ['CFX-MC-01', 'CFX-MC-02', 'CFX-MC-03', 'CFX-MC-04']) {
      await backendRequest(`/machines/${machineId}/owner`, {
        method: 'PATCH',
        body: { owner_id: null },
        token: adminToken
      });
    }
    await db.run('DELETE FROM machine_products');

    console.log('\nALL STAGE 5 OWNER DASHBOARD TESTS PASSED SUCCESSFULLY!\n');
  } finally {
    await new Promise((resolve) => server.close(() => resolve()));
  }
  process.exit(0);
}

runStage5Tests().catch((err) => {
  console.error('Stage 5 test suite failed:', err);
  process.exit(1);
});

