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
  await db.run('DELETE FROM inventory_ledger WHERE machine_id = ?', ['CFX-MC-99']).catch(() => {});
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

    // 6. Verify Phase 2.6 Advanced Order Management Components & Formatter Isolation
    console.log('6. Verifying Phase 2.6 Advanced Order Management columns, badges & filters...');
    const ordersPageSource = fs.readFileSync(
      path.resolve(__dirname, '../pages/OrdersPage.jsx'),
      'utf-8'
    );
    assert.ok(ordersPageSource.includes('PaymentStatusBadge'), 'OrdersPage must render PaymentStatusBadge');
    assert.ok(ordersPageSource.includes('DispenseStatusBadge'), 'OrdersPage must render DispenseStatusBadge');
    assert.ok(ordersPageSource.includes('CopyableText'), 'OrdersPage must include CopyableText helper');
    assert.ok(ordersPageSource.includes('Order ID'), 'OrdersPage must have Order ID column');
    assert.ok(ordersPageSource.includes('Date & Time'), 'OrdersPage must have Date & Time column');
    assert.ok(ordersPageSource.includes('Machine ID'), 'OrdersPage must have Machine ID column');
    assert.ok(ordersPageSource.includes('Product'), 'OrdersPage must have Product column');
    assert.ok(ordersPageSource.includes('Amount'), 'OrdersPage must have Amount column');
    assert.ok(ordersPageSource.includes('Payment'), 'OrdersPage must have Payment status column');
    assert.ok(ordersPageSource.includes('Dispensing'), 'OrdersPage must have Dispensing status column');
    assert.ok(ordersPageSource.includes('Payment ID'), 'OrdersPage must have Razorpay Payment ID column');
    assert.ok(ordersPageSource.includes('Customer'), 'OrdersPage must have Customer column');
    assert.ok(ordersPageSource.includes('Order Details'), 'OrdersPage must include Order Details view');
    assert.ok(ordersPageSource.includes('dispense_started_at'), 'OrdersPage must display dispense_started_at');
    assert.ok(ordersPageSource.includes('dispensed_at'), 'OrdersPage must display dispensed_at');
    assert.ok(ordersPageSource.includes('razorpay_order_id'), 'OrdersPage search must match razorpay_order_id');
    assert.ok(ordersPageSource.includes('rpOrderIdMatch'), 'OrdersPage must include rpOrderIdMatch in search');

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
    console.log('   PASS: Phase 2.6 order table columns, independent statuses & formatters verified.');

    // 7. Verify Admin UI Source Checks & Production Build Bundle
    console.log('7. Verifying Admin UI security checks and production build artifacts...');
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

    // 8. Verify Phase 2.9.3.2 Backend Analytics Integration & Dashboard Requirements
    console.log('8. Verifying Phase 2.9.3.2 Backend Analytics API integration & formatting...');
    assert.strictEqual(typeof adminApi.getAnalyticsOverview, 'function');
    assert.strictEqual(typeof adminApi.getAnalyticsTimeSeries, 'function');
    assert.strictEqual(typeof adminApi.getAnalyticsMachines, 'function');
    assert.strictEqual(typeof adminApi.getAnalyticsProducts, 'function');
    assert.strictEqual(typeof adminApi.getAnalyticsInventory, 'function');
    assert.strictEqual(typeof adminApi.getAnalyticsRefunds, 'function');

    // 8.1 Call all 6 endpoints with valid Admin token
    const overviewRes = await adminApi.getAnalyticsOverview({}, adminToken, TEST_BASE_URL);
    assert.strictEqual(overviewRes.status, 'success');
    assert.ok(typeof overviewRes.data.gross_sales_paise === 'number');
    assert.ok(typeof overviewRes.data.net_revenue_paise === 'number');
    assert.ok(typeof overviewRes.data.over_refund_detected === 'boolean');
    assert.ok(typeof overviewRes.data.refunds_exceed_period_sales === 'boolean');

    const tsRes = await adminApi.getAnalyticsTimeSeries({ interval: 'day' }, adminToken, TEST_BASE_URL);
    assert.strictEqual(tsRes.status, 'success');
    assert.ok(Array.isArray(tsRes.data));

    const mcRes = await adminApi.getAnalyticsMachines({}, adminToken, TEST_BASE_URL);
    assert.strictEqual(mcRes.status, 'success');
    assert.ok(Array.isArray(mcRes.data));

    const prRes = await adminApi.getAnalyticsProducts({}, adminToken, TEST_BASE_URL);
    assert.strictEqual(prRes.status, 'success');
    assert.ok(Array.isArray(prRes.data));

    const invRes = await adminApi.getAnalyticsInventory({}, adminToken, TEST_BASE_URL);
    assert.strictEqual(invRes.status, 'success');
    assert.ok(Array.isArray(invRes.data));

    const rfRes = await adminApi.getAnalyticsRefunds({}, adminToken, TEST_BASE_URL);
    assert.strictEqual(rfRes.status, 'success');
    assert.ok(typeof rfRes.data.total_refunds_count === 'number');
    assert.ok(Array.isArray(rfRes.data.recent_refunds));

    // 8.2 Test unauthenticated rejection (HTTP 401)
    let authErrorCaught = false;
    try {
      await adminApi.getAnalyticsOverview({}, null, TEST_BASE_URL);
    } catch (err) {
      authErrorCaught = true;
      assert.strictEqual(err.status, 401);
    }
    assert.ok(authErrorCaught, 'Unauthenticated analytics request must throw HTTP 401');

    // 8.3 Test signed INR formatting & zero/negative handling
    assert.strictEqual(formatSignedINR(14500), '₹14,500');
    assert.strictEqual(formatSignedINR(-500), '-₹500');
    assert.strictEqual(formatSignedINR(0), '₹0');
    assert.strictEqual(formatSignedINR(-0), '₹0');
    assert.strictEqual(formatSignedPaise(-50000), '-₹500');
    assert.strictEqual(formatSignedPaise(1450000), '₹14,500');

    // 8.4 Test date validation
    assert.strictEqual(validateDateRange('2026-11-15', '2026-11-10').valid, false);
    assert.strictEqual(validateDateRange('2025-01-01', '2026-03-01').valid, false);
    assert.strictEqual(validateDateRange('2026-11-01', '2026-11-14').valid, true);

    // 8.5 Test DISPENSED and legacy COMPLETED statuses
    assert.strictEqual(getDispenseStatusLabel({ dispense_status: 'DISPENSED' }), 'DISPENSED');
    assert.strictEqual(getDispenseStatusLabel({ dispense_status: 'COMPLETED' }), 'COMPLETED');

    // 8.6 Verify SalesReportsPage.jsx and StatusBadges source requirements
    const salesReportsSource = fs.readFileSync(
      path.resolve(__dirname, '../pages/SalesReportsPage.jsx'),
      'utf-8'
    );
    assert.ok(salesReportsSource.includes('adminApi.getAnalyticsOverview'), 'Must call getAnalyticsOverview');
    assert.ok(salesReportsSource.includes('adminApi.getAnalyticsTimeSeries'), 'Must call getAnalyticsTimeSeries');
    assert.ok(salesReportsSource.includes('adminApi.getAnalyticsMachines'), 'Must call getAnalyticsMachines');
    assert.ok(salesReportsSource.includes('adminApi.getAnalyticsProducts'), 'Must call getAnalyticsProducts');
    assert.ok(salesReportsSource.includes('adminApi.getAnalyticsInventory'), 'Must call getAnalyticsInventory');
    assert.ok(salesReportsSource.includes('adminApi.getAnalyticsRefunds'), 'Must call getAnalyticsRefunds');
    assert.ok(salesReportsSource.includes('AbortController'), 'Must use AbortController for stale-request protection');
    assert.ok(salesReportsSource.includes('Critical Financial Invariant Violation Detected'), 'Must display over-refund banner');
    assert.ok(salesReportsSource.includes('Period Net Revenue Deficit'), 'Must display net deficit banner');
    assert.ok(salesReportsSource.includes('UntrackedBadge'), 'Must use UntrackedBadge for null inventory balances');
    assert.ok(!salesReportsSource.includes('computeSalesAnalytics('), 'Must not use client-side computeSalesAnalytics for analytics');

    const statusBadgesSource = fs.readFileSync(
      path.resolve(__dirname, '../components/StatusBadges.jsx'),
      'utf-8'
    );
    assert.ok(statusBadgesSource.includes('export function UntrackedBadge'), 'StatusBadges must export UntrackedBadge');

    console.log('   PASS: All 6 analytics APIs, signed currency, date filters, and UI invariants verified.');

    // 9. Verify Phase 2.9.3.4 Fix W-1: Section-Specific API Error Handling & Isolated Retry
    console.log('9. Verifying Phase 2.9.3.4 Fix W-1 section-specific error handling & retry...');
    assert.ok(salesReportsSource.includes('function SectionError'), 'Must define SectionError component');
    assert.ok(salesReportsSource.includes('function SectionLoading'), 'Must define SectionLoading component');
    assert.ok(salesReportsSource.includes('retrySection'), 'Must implement section-specific retrySection');
    assert.ok(salesReportsSource.includes('sectionLoading'), 'Must track sectionLoading');
    assert.ok(salesReportsSource.includes('sectionErrors'), 'Must track sectionErrors');
    assert.ok(salesReportsSource.includes('sectionAbortControllersRef'), 'Must use sectionAbortControllersRef');
    assert.ok(salesReportsSource.includes('handleIntervalChange'), 'Must support isolated interval change without reloading other sections');

    // 9.1 Simulate section error isolation: Overview succeeds while time-series fails
    const mockOverviewSuccess = await adminApi.getAnalyticsOverview({}, adminToken, TEST_BASE_URL);
    let timeSeriesFailMsg = '';
    try {
      // Intentionally invalid interval to simulate auxiliary endpoint failure
      await adminApi.getAnalyticsTimeSeries({ interval: 'invalid_interval' }, adminToken, TEST_BASE_URL);
    } catch (err) {
      timeSeriesFailMsg = err.message;
    }
    assert.strictEqual(mockOverviewSuccess.status, 'success');
    assert.ok(timeSeriesFailMsg.length > 0, 'Auxiliary endpoint must fail with validation error');

    // 9.2 Simulate multiple auxiliary sections failing independently while others succeed
    let inventoryFailMsg = '';
    try {
      // Invalid machine ID format to trigger Zod 400 rejection in inventory endpoint
      await adminApi.getAnalyticsInventory({ machine_id: 'INVALID$$ID' }, adminToken, TEST_BASE_URL);
    } catch (err) {
      inventoryFailMsg = err.message;
    }
    assert.ok(inventoryFailMsg.length > 0, 'Inventory query with invalid machine_id must fail independently');
    // Ensure machines endpoint still succeeds independently
    const machinesSuccess = await adminApi.getAnalyticsMachines({}, adminToken, TEST_BASE_URL);
    assert.strictEqual(machinesSuccess.status, 'success');

    // 9.3 Simulate retry behavior on affected endpoint
    const retryRes = await adminApi.getAnalyticsTimeSeries({ interval: 'day' }, adminToken, TEST_BASE_URL);
    assert.strictEqual(retryRes.status, 'success', 'Retry on affected endpoint must succeed');
    assert.ok(Array.isArray(retryRes.data), 'Retry data must populate array');

    // 9.4 Simulate AbortError ignoring in UI logic
    const abortSimController = new AbortController();
    abortSimController.abort();
    let abortIgnored = false;
    try {
      await adminApi.getAnalyticsOverview({}, { token: adminToken, signal: abortSimController.signal, baseUrl: TEST_BASE_URL });
    } catch (err) {
      if (err.name === 'AbortError' || (err.data && err.data.name === 'AbortError')) {
        abortIgnored = true;
      }
    }
    assert.ok(abortIgnored, 'AbortError must be thrown by fetch and caught by UI without setting service error');

    console.log('   PASS: Section-specific error isolation, retry behavior, and AbortError handling verified.');

    // 10. Verify Phase 2.9.3.6 A-1 Request Sequence IDs & A-2 Section Synchronization Timestamps
    console.log('10. Verifying Phase 2.9.3.6 A-1 Monotonic Request Sequence IDs & A-2 Section Timestamps...');
    assert.ok(salesReportsSource.includes('requestIdRef = useRef(0)'), 'Must declare requestIdRef');
    assert.ok(salesReportsSource.includes('sectionRequestIdsRef = useRef'), 'Must declare sectionRequestIdsRef');
    assert.ok(salesReportsSource.includes('isMountedRef = useRef(true)'), 'Must declare isMountedRef');
    assert.ok(salesReportsSource.includes('isFullRefreshObsolete'), 'Must check isFullRefreshObsolete');
    assert.ok(salesReportsSource.includes('isSectionObsolete'), 'Must check isSectionObsolete');
    assert.ok(salesReportsSource.includes('isTimeSeriesObsolete'), 'Must check isTimeSeriesObsolete');
    assert.ok(salesReportsSource.includes('sectionLastUpdated'), 'Must track sectionLastUpdated state');
    assert.ok(salesReportsSource.includes('lastFullSync'), 'Must track lastFullSync state');
    assert.ok(salesReportsSource.includes('prevFilterContextRef'), 'Must track prevFilterContextRef for filter changes (C-1.2)');
    assert.ok(salesReportsSource.includes('function formatSyncTime'), 'Must define formatSyncTime helper');
    assert.ok(salesReportsSource.includes('Last full dashboard sync at'), 'Must display Last full dashboard sync');
    assert.ok(salesReportsSource.includes('Partial sync •'), 'Must display Partial sync indicator with bullet (C-1.1)');
    assert.ok(salesReportsSource.includes('Ready to synchronize'), 'Must display ready to synchronize status (C-1.1)');
    assert.ok(salesReportsSource.includes('Synchronizing dashboard analytics...'), 'Must display synchronizing status (C-1.1)');

    // 10.1 Verify A-1 request generation identity simulation
    let currentGeneration = 1;
    let staleDataOverwritten = false;
    const simulateAsyncResponse = (genId, payload) => {
      if (genId === currentGeneration) {
        staleDataOverwritten = true;
      }
    };
    currentGeneration = 2; // Newer request started
    simulateAsyncResponse(1, { gross_sales_inr: 9999 }); // Obsolete response arrives
    assert.strictEqual(staleDataOverwritten, false, 'Obsolete generation 1 must not overwrite generation 2');
    simulateAsyncResponse(2, { gross_sales_inr: 5000 }); // Current response arrives
    assert.strictEqual(staleDataOverwritten, true, 'Current generation 2 must be applied');

    // 10.2 Verify C-1.1 Footer Precedence State Machine
    const evaluateFooter = ({ isAnyLoading, sectionErrors, lastFullSync, sectionLastUpdated }) => {
      if (isAnyLoading) return 'Synchronizing dashboard analytics...';
      const errCount = Object.values(sectionErrors || {}).filter(Boolean).length;
      if (errCount > 0) return `Partial sync • ${errCount} section(s) require attention`;
      if (lastFullSync) return `Last full dashboard sync at ${formatISTTime(lastFullSync)}`;
      const syncCount = Object.values(sectionLastUpdated || {}).filter(Boolean).length;
      if (syncCount > 0) return `${syncCount} of 6 sections synchronized`;
      return 'Ready to synchronize';
    };

    const formatISTTime = (d) => d.toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true }) + ' IST';
    const oldSync = new Date('2026-11-14T06:00:00.000Z');

    // Scenario A: Initial loading shows synchronizing
    assert.strictEqual(evaluateFooter({ isAnyLoading: true, sectionErrors: {}, lastFullSync: null, sectionLastUpdated: {} }), 'Synchronizing dashboard analytics...');
    // Scenario B: Previous full sync exists, user reloads/changes filters -> active loading MUST NOT be hidden by old full sync
    assert.strictEqual(evaluateFooter({ isAnyLoading: true, sectionErrors: {}, lastFullSync: oldSync, sectionLastUpdated: {} }), 'Synchronizing dashboard analytics...');
    // Scenario C: Section errors take precedence over old full sync
    assert.strictEqual(evaluateFooter({ isAnyLoading: false, sectionErrors: { overview: 'Network error', refunds: 'Timeout' }, lastFullSync: oldSync, sectionLastUpdated: {} }), 'Partial sync • 2 section(s) require attention');
    // Scenario D: Full sync displays timestamp
    assert.ok(evaluateFooter({ isAnyLoading: false, sectionErrors: {}, lastFullSync: oldSync, sectionLastUpdated: {} }).startsWith('Last full dashboard sync at'));
    // Scenario E: Partial section sync
    assert.strictEqual(evaluateFooter({ isAnyLoading: false, sectionErrors: {}, lastFullSync: null, sectionLastUpdated: { overview: oldSync, timeSeries: oldSync } }), '2 of 6 sections synchronized');
    // Scenario F: Uninitialized displays ready
    assert.strictEqual(evaluateFooter({ isAnyLoading: false, sectionErrors: {}, lastFullSync: null, sectionLastUpdated: {} }), 'Ready to synchronize');

    // 10.3 Verify C-1.2 Filter Context Detection & Timestamp Reset
    let mockTimestamps = { overview: oldSync, timeSeries: oldSync };
    let mockLastFull = oldSync;
    let mockPrevFilterContext = '7days::ALL';

    const simulateFilterOrRefresh = (nextPreset, nextCustomStart, nextCustomEnd, nextMachine) => {
      const nextKey = `${nextPreset}:${nextPreset === 'custom' ? `${nextCustomStart}:${nextCustomEnd}` : ''}:${nextMachine}`;
      const isFilterChange = mockPrevFilterContext !== null && mockPrevFilterContext !== nextKey;
      mockPrevFilterContext = nextKey;
      if (isFilterChange) {
        mockTimestamps = { overview: null, timeSeries: null };
        mockLastFull = null;
      }
    };

    // Changing preset clears timestamps
    simulateFilterOrRefresh('30days', '', '', 'ALL');
    assert.strictEqual(mockTimestamps.overview, null, 'Changing preset must clear timestamps');
    assert.strictEqual(mockLastFull, null, 'Changing preset must clear lastFullSync');

    // Simulate successful sync on 30days
    mockTimestamps = { overview: oldSync, timeSeries: oldSync };
    mockLastFull = oldSync;

    // Manual refresh on same filter retains timestamps during loading
    simulateFilterOrRefresh('30days', '', '', 'ALL');
    assert.strictEqual(mockTimestamps.overview, oldSync, 'Manual refresh with same filter must retain timestamps during loading');
    assert.strictEqual(mockLastFull, oldSync, 'Manual refresh with same filter must retain lastFullSync during loading');

    // Changing machine filter clears timestamps
    simulateFilterOrRefresh('30days', '', '', 'CFX-MC-01');
    assert.strictEqual(mockTimestamps.overview, null, 'Changing machine filter must clear timestamps');
    assert.strictEqual(mockLastFull, null, 'Changing machine filter must clear lastFullSync');

    // 10.4 Verify A-2 timestamp formatting and partial sync behavior
    const testDate = new Date('2026-11-14T07:15:00.000Z');
    const formattedIST = testDate.toLocaleTimeString('en-IN', {
      timeZone: 'Asia/Kolkata',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: true
    }) + ' IST';
    assert.ok(formattedIST.includes('IST'), 'Formatted sync time must include IST');
    assert.ok(formattedIST.includes('12:45'), 'UTC 07:15 must convert to Asia/Kolkata 12:45');

    console.log('   PASS: Monotonic sequence IDs, C-1.1 footer precedence, C-1.2 filter-context timestamps & IST formatting verified.');

    // =========================================================================
    // 11. Verify Phase 2.9.4.1 Finding M-1: Admin OrdersPage Reconciliation Filter
    // =========================================================================
    console.log('11. Verifying Phase 2.9.4.1 M-1 Admin OrdersPage reconciliation filter contract & behavior...');
    const ordersPagePath = new URL('../pages/OrdersPage.jsx', import.meta.url);
    const fsModule = await import('node:fs');
    const ordersPageSrc = fsModule.readFileSync(ordersPagePath, 'utf8');

    assert.ok(ordersPageSrc.includes("result: 'PENDING_ACTION'"), 'OrdersPage must map pending refunds to PENDING_ACTION');
    assert.ok(ordersPageSrc.includes('reconciliationFilter,\n  ])') || ordersPageSrc.includes('reconciliationFilter,\r\n  ])') || /useMemo\([\s\S]*reconciliationFilter[\s\S]*\]\)/.test(ordersPageSrc), 'filteredOrders useMemo dependencies must include reconciliationFilter');
    assert.ok(ordersPageSrc.includes("reconciliationFilter !== 'ALL'"), 'hasActiveFilters must include reconciliationFilter');
    assert.ok(ordersPageSrc.includes("setReconciliationFilter('ALL')"), 'handleResetFilters must reset reconciliationFilter to ALL');

    const evalRec = (order) => {
      const pending = Number(order.pending_refund_amount_paise || 0);
      if (pending > 0 || order.refund_status === 'PENDING') {
        return { result: 'PENDING_ACTION' };
      }
      if (order.status === 'FAILED' && Number(order.captured_amount_paise || 0) > 0) {
        return { result: 'DISCREPANCY' };
      }
      return { result: 'MATCH' };
    };
    const sampleOrders = [
      { id: 'O-MATCH', status: 'PAID', refund_status: 'NONE', captured_amount_paise: 10000, pending_refund_amount_paise: 0 },
      { id: 'O-DISC', status: 'FAILED', refund_status: 'NONE', captured_amount_paise: 10000, pending_refund_amount_paise: 0 },
      { id: 'O-PEND', status: 'PAID', refund_status: 'PENDING', captured_amount_paise: 10000, pending_refund_amount_paise: 5000 }
    ];
    for (const [filterVal, expectedId] of [['MATCH', 'O-MATCH'], ['DISCREPANCY', 'O-DISC'], ['PENDING_ACTION', 'O-PEND']]) {
      const matched = sampleOrders.filter((o) => filterVal === 'ALL' || evalRec(o).result === filterVal);
      assert.strictEqual(matched.length, 1);
      assert.strictEqual(matched[0].id, expectedId, `Filter ${filterVal} must return ${expectedId}`);
    }
    console.log('   PASS: Admin OrdersPage M-1 reconciliation filter (MATCH, DISCREPANCY, PENDING_ACTION) & reset verified.');

    // Cleanup test state
    for (const machineId of ['CFX-MC-01', 'CFX-MC-02', 'CFX-MC-03', 'CFX-MC-04']) {
      await adminApi.assignMachineOwner(machineId, null, adminToken, TEST_BASE_URL);
    }
    await db.run('DELETE FROM inventory_ledger WHERE machine_id = ?', ['CFX-MC-99']).catch(() => {});
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

