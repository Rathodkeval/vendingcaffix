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
  formatRelativeHeartbeat,
  computeSalesAnalytics,
  getPaymentStatusLabel
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

    // 9. Verify Responsive UI, Fragment Token Security & Production Build Bundle
    console.log('8. Verifying responsive layout classes, fragment token security & production build artifacts...');
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

