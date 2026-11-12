import assert from 'assert';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

import {
  adminApi,
  resolveApiBaseUrl,
  resolveOwnerPortalUrl,
  buildInviteSetupUrl,
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

const PORT = 5096;
const TEST_BASE_URL = `http://127.0.0.1:${PORT}/api`;

function computeRazorpaySignature(razorpayOrderId, razorpayPaymentId) {
  const secret = (process.env.RAZORPAY_KEY_SECRET || 'mockSecret987654321').trim();
  return crypto
    .createHmac('sha256', secret)
    .update(`${razorpayOrderId}|${razorpayPaymentId}`)
    .digest('hex');
}

async function rawBackendRequest(endpoint, { method = 'GET', body, token } = {}) {
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

async function runAdminDashboardTests() {
  console.log('\n=============================================================');
  console.log('Running CAFFIX Super Admin Dashboard Integration Tests');
  console.log('=============================================================\n');

  // 1. Verify API Base URL, Owner Portal URL & #setup_token URL construction
  console.log('1. Verifying VITE_API_BASE_URL, VITE_OWNER_PORTAL_URL, and #setup_token links...');
  assert.strictEqual(
    resolveApiBaseUrl('https://vendingcaffix.vercel.app/api/'),
    'https://vendingcaffix.vercel.app/api'
  );
  assert.strictEqual(resolveApiBaseUrl(''), 'https://vendingcaffix.vercel.app/api');
  assert.strictEqual(
    resolveOwnerPortalUrl('https://caffix-owner.vercel.app/'),
    'https://caffix-owner.vercel.app'
  );
  assert.strictEqual(resolveOwnerPortalUrl(''), 'https://caffix-owner.vercel.app');

  const sampleSetupUrl = buildInviteSetupUrl(
    'https://caffix-owner.vercel.app',
    'tok_sample_123',
    'owner@caffix.com'
  );
  assert.ok(
    sampleSetupUrl.startsWith('https://caffix-owner.vercel.app/#setup_token=tok_sample_123'),
    `Expected #setup_token fragment URL, got ${sampleSetupUrl}`
  );
  const parsedSampleUrl = new URL(sampleSetupUrl);
  assert.strictEqual(parsedSampleUrl.search, '', 'Invite URL must never put tokens in query strings');

  assert.ok(formatINR(1250).includes('1,250'), 'formatINR must format Indian Rupees');
  assert.strictEqual(
    formatRelativeHeartbeat(new Date(Date.now() - 15000).toISOString()),
    '15s ago'
  );
  console.log('   PASS: URL helpers, fragment invite builder, and formatters verified.');

  // 2. Boot backend server from compiled caffix-backend/dist
  process.env.JWT_SECRET =
    process.env.JWT_SECRET || 'caffix-test-admin-portal-secret-2026-explicit';
  process.env.KIOSK_SECRET =
    process.env.KIOSK_SECRET || 'caffix-test-admin-kiosk-secret-2026';
  const backendDistIndex = path.resolve(__dirname, '../../../caffix-backend/dist/index.js');
  const backendDistDb = path.resolve(__dirname, '../../../caffix-backend/dist/config/db.js');
  const appModule = require(backendDistIndex);
  const dbModule = require(backendDistDb);
  const app = appModule.default || appModule;

  await dbModule.initDB();
  const db = dbModule.getDB();
  await db.run('DELETE FROM machine_products');
  await db.run('DELETE FROM machines WHERE id = ?', ['CFX-MC-99']);

  const server = await new Promise((resolve) => {
    const s = app.listen(PORT, '127.0.0.1', () => resolve(s));
  });

  try {
    // 3. CORS Origin Enforcement for caffix-admin & Admin Login
    console.log('2. Testing CORS allowlist for caffix-admin and Super Admin login...');
    const corsAdminProdRes = await fetch(`${TEST_BASE_URL}/health`, {
      method: 'GET',
      headers: { Origin: 'https://caffix-admin.vercel.app' }
    });
    assert.strictEqual(
      corsAdminProdRes.headers.get('access-control-allow-origin'),
      'https://caffix-admin.vercel.app',
      'CORS must explicitly allow https://caffix-admin.vercel.app (never *)'
    );

    const corsAdminDevRes = await fetch(`${TEST_BASE_URL}/health`, {
      method: 'GET',
      headers: { Origin: 'http://localhost:5175' }
    });
    assert.strictEqual(
      corsAdminDevRes.headers.get('access-control-allow-origin'),
      'http://localhost:5175',
      'CORS must explicitly allow http://localhost:5175 (never *)'
    );

    const corsUntrustedRes = await fetch(`${TEST_BASE_URL}/health`, {
      method: 'GET',
      headers: { Origin: 'https://evil-attacker.example.com' }
    });
    assert.strictEqual(
      corsUntrustedRes.headers.get('access-control-allow-origin'),
      null,
      'CORS must block untrusted third-party origins and never return *'
    );

    const adminLogin = await adminApi.login('admin@caffix.com', 'admin123', TEST_BASE_URL);
    const adminToken = adminLogin.token;
    assert.strictEqual(adminLogin.data.role, 'admin');

    const adminMe = await adminApi.getMe(adminToken, TEST_BASE_URL);
    assert.strictEqual(adminMe.data.role, 'admin');
    assert.ok(adminMe.data.assigned_machines.length >= 4, 'Admin must see all 4 seeded machines');

    const allMachines = await adminApi.getMachines(adminToken, TEST_BASE_URL);
    const allIds = allMachines.data.map((m) => m.id);
    for (const id of ['CFX-MC-01', 'CFX-MC-02', 'CFX-MC-03', 'CFX-MC-04']) {
      assert.ok(allIds.includes(id), `Admin must see seeded machine ${id}`);
    }
    console.log('   PASS: CORS allowlist, Super Admin login, and full fleet visibility verified.');

    // 4. Invite Owner, Activate Account, and Enforce Strict Portal-Role Isolation
    console.log('3. Testing owner invitation, activation, and rejecting owner access in Admin Dashboard...');
    const ts = Date.now();
    const ownerEmail = `owner.admin.test.${ts}@caffix.com`;

    const inviteRes = await adminApi.inviteOwner(
      {
        name: 'Admin Test Owner',
        email: ownerEmail,
        machine_ids: ['CFX-MC-01']
      },
      adminToken,
      TEST_BASE_URL
    );
    assert.ok(inviteRes.data.setup_url.startsWith('/#setup_token='));

    const ownersList = await adminApi.getOwners(adminToken, TEST_BASE_URL);
    const invitedRecord = ownersList.data.find((o) => o.email === ownerEmail);
    assert.ok(invitedRecord, 'Invited owner must appear in GET /api/auth/owners');
    assert.strictEqual(invitedRecord.must_change_password, true);

    const setupRes = await rawBackendRequest('/auth/setup-password', {
      method: 'POST',
      body: {
        token: inviteRes.data.invite_token,
        email: ownerEmail,
        password: 'OwnerPortalOnlyPass123!'
      }
    });
    assert.strictEqual(setupRes.status, 200);
    const ownerToken = setupRes.payload.token;
    assert.strictEqual(setupRes.payload.data.role, 'owner');

    // Reject owner on Admin Dashboard login (portal: 'admin')
    let ownerRejectedFromAdminLogin = false;
    try {
      await adminApi.login(ownerEmail, 'OwnerPortalOnlyPass123!', TEST_BASE_URL);
    } catch (err) {
      ownerRejectedFromAdminLogin = err instanceof ApiError && err.status === 403;
    }
    assert.ok(ownerRejectedFromAdminLogin, 'Admin portal login must reject owner account with 403 Forbidden');

    // Reject owner token on GET /auth/me?portal=admin and admin fleet endpoints
    const ownerMeAdmin = await rawBackendRequest('/auth/me?portal=admin', { token: ownerToken });
    assert.strictEqual(ownerMeAdmin.status, 403, 'GET /api/auth/me?portal=admin must reject owner with 403');

    const ownerAdminChecks = [
      await rawBackendRequest('/auth/owners', { token: ownerToken }),
      await rawBackendRequest('/auth/owners/invite', {
        method: 'POST',
        body: { name: 'X', email: `x.${ts}@caffix.com`, machine_ids: [] },
        token: ownerToken
      }),
      await rawBackendRequest('/machines/register', {
        method: 'POST',
        body: { id: 'CFX-MC-98', machine_name: 'Blocked', location: 'None' },
        token: ownerToken
      }),
      await rawBackendRequest('/machines/CFX-MC-01/owner', {
        method: 'PATCH',
        body: { owner_id: invitedRecord.id },
        token: ownerToken
      })
    ];
    for (const check of ownerAdminChecks) {
      assert.strictEqual(check.status, 403, 'Owner token must receive 403 on all admin routes');
    }

    // Verify POST /api/auth/register requires authenticated admin (401 unauth, 403 owner)
    const unauthRegister = await rawBackendRequest('/auth/register', {
      method: 'POST',
      body: { name: 'Unauth', email: `unauth.${ts}@caffix.com`, password: 'Password123!' }
    });
    assert.strictEqual(unauthRegister.status, 401);

    const ownerRegister = await rawBackendRequest('/auth/register', {
      method: 'POST',
      body: { name: 'OwnerReg', email: `ownerreg.${ts}@caffix.com`, password: 'Password123!' },
      token: ownerToken
    });
    assert.strictEqual(ownerRegister.status, 403);
    console.log('   PASS: Owner blocked from Admin Dashboard login, session verification, and all admin APIs.');

    // 5. Machine Registration & Owner Assignment/Unassignment
    console.log('4. Testing new machine registration and owner assignment/unassignment...');
    const regRes = await adminApi.registerMachine(
      {
        id: 'CFX-MC-99',
        machine_name: 'Stage Admin Verification Unit',
        location: 'HQ Test Lab'
      },
      adminToken,
      TEST_BASE_URL
    );
    assert.strictEqual(regRes.data.id, 'CFX-MC-99');

    const afterRegMachines = await adminApi.getMachines(adminToken, TEST_BASE_URL);
    assert.ok(afterRegMachines.data.some((m) => m.id === 'CFX-MC-99'));

    const assignRes = await adminApi.assignMachineOwner(
      'CFX-MC-99',
      invitedRecord.id,
      adminToken,
      TEST_BASE_URL
    );
    assert.strictEqual(assignRes.data.owner_id, invitedRecord.id);

    const unassignRes = await adminApi.assignMachineOwner('CFX-MC-99', null, adminToken, TEST_BASE_URL);
    assert.strictEqual(unassignRes.data.owner_id, null);
    console.log('   PASS: Machine registration and owner assignment/unassignment verified.');

    // 6. Per-Machine Pricing, Mode Control & Historical Order Preservation
    console.log('5. Testing per-machine pricing, refill/mode control & order amount immutability...');
    await adminApi.updateMachineMode('CFX-MC-02', 'RUNNING', adminToken, TEST_BASE_URL);
    await adminApi.refillMachineInventory('CFX-MC-02', 'ALL', adminToken, TEST_BASE_URL);
    await adminApi.updateMachineProduct(
      'CFX-MC-02',
      1,
      { price: 145, is_available: true },
      adminToken,
      TEST_BASE_URL
    );

    const mc2Row = await db.get('SELECT kiosk_token FROM machines WHERE id = ?', ['CFX-MC-02']);
    const kiosk2Secret = mc2Row?.kiosk_token || process.env.KIOSK_SECRET;
    const verifyKiosk2 = await rawBackendRequest(
      `/kiosk/verify?kiosk=${encodeURIComponent(kiosk2Secret)}&machine_id=CFX-MC-02`
    );
    assert.strictEqual(verifyKiosk2.status, 200);
    const kiosk2Token = verifyKiosk2.payload.token;

    const createOrderRes = await rawBackendRequest('/orders/create', {
      method: 'POST',
      token: kiosk2Token,
      body: {
        product_id: 1,
        amount: 145,
        machine_id: 'CFX-MC-02',
        base: 'milk'
      }
    });
    assert.strictEqual(createOrderRes.status, 201);
    const { id: orderId, razorpay_order_id: rzpOrderId } = createOrderRes.payload.data;
    const rzpPaymentId = `pay_admin_test_${ts}`;
    const rzpSig = computeRazorpaySignature(rzpOrderId, rzpPaymentId);

    const verifyPayRes = await rawBackendRequest('/payments/verify', {
      method: 'POST',
      token: kiosk2Token,
      body: {
        order_id: orderId,
        razorpay_order_id: rzpOrderId,
        razorpay_payment_id: rzpPaymentId,
        razorpay_signature: rzpSig
      }
    });
    assert.strictEqual(verifyPayRes.status, 200);

    // Update price afterwards and confirm historical order keeps ₹145
    await adminApi.updateMachineProduct(
      'CFX-MC-02',
      1,
      { price: 190, is_available: true },
      adminToken,
      TEST_BASE_URL
    );

    const adminOrders = await adminApi.getOrders('CFX-MC-02', adminToken, TEST_BASE_URL);
    const matchingOrder = adminOrders.data.find((o) => o.id === orderId);
    assert.ok(matchingOrder, 'Admin must see historical order on CFX-MC-02');
    assert.strictEqual(matchingOrder.amount, 145);
    assert.strictEqual(getPaymentStatusLabel(matchingOrder), 'PAID');

    const analytics = computeSalesAnalytics([matchingOrder], allMachines.data, 'daily', 'CFX-MC-02');
    assert.strictEqual(analytics.totalRevenue, 145);
    assert.strictEqual(analytics.totalOrders, 1);
    console.log('   PASS: Per-machine pricing and ₹145 historical order immutability verified.');

    // 7. Verify Admin UI Source Checks & Production Build Bundle
    console.log('6. Verifying Admin UI security checks and production build artifacts...');
    const adminFleetSource = fs.readFileSync(
      path.resolve(__dirname, '../pages/AdminFleetPage.jsx'),
      'utf-8'
    );
    assert.ok(
      adminFleetSource.includes('buildInviteSetupUrl'),
      'AdminFleetPage must use buildInviteSetupUrl (#setup_token fragment)'
    );
    assert.ok(
      !adminFleetSource.includes('?setup_token='),
      'AdminFleetPage must never construct ?setup_token= query string links'
    );

    const sidebarSource = fs.readFileSync(
      path.resolve(__dirname, '../components/Sidebar.jsx'),
      'utf-8'
    );
    assert.ok(sidebarSource.includes('lg:hidden'), 'Mobile top header must use lg:hidden');
    assert.ok(sidebarSource.includes('lg:translate-x-0'), 'Desktop sidebar must use lg:translate-x-0');

    const distIndexHtml = path.resolve(__dirname, '../../dist/index.html');
    assert.ok(fs.existsSync(distIndexHtml), 'Production build caffix-admin/dist/index.html must exist');
    console.log('   PASS: Admin UI security and production build bundle verified.');

    // Cleanup test state
    for (const machineId of ['CFX-MC-01', 'CFX-MC-02', 'CFX-MC-03', 'CFX-MC-04']) {
      await adminApi.assignMachineOwner(machineId, null, adminToken, TEST_BASE_URL);
    }
    await db.run('DELETE FROM machine_products');
    await db.run('DELETE FROM machines WHERE id = ?', ['CFX-MC-99']);

    console.log('\nALL CAFFIX SUPER ADMIN DASHBOARD TESTS PASSED SUCCESSFULLY!\n');
  } finally {
    await new Promise((resolve) => server.close(() => resolve()));
  }
  process.exit(0);
}

runAdminDashboardTests().catch((err) => {
  console.error('Admin dashboard test suite failed:', err);
  process.exit(1);
});

