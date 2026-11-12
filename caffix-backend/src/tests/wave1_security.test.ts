import assert from 'assert';
import jwt from 'jsonwebtoken';
import app from '../index';
import { initDB, getDB } from '../config/db';
import { sanitizeUrlForLogging, redactSensitiveText } from '../utils/security';

const INITIAL_JWT_SECRET = process.env.JWT_SECRET;
const INITIAL_ADMIN_PASSCODE = process.env.ADMIN_PASSCODE;
const INITIAL_KIOSK_SECRET = process.env.KIOSK_SECRET;
const INITIAL_VERCEL = process.env.VERCEL;
const INITIAL_VERCEL_ENV = process.env.VERCEL_ENV;
const INITIAL_NODE_ENV = process.env.NODE_ENV;

if (!process.env.JWT_SECRET) {
  process.env.JWT_SECRET = 'wave1_security_test_jwt_secret_2026_strong';
}
if (!process.env.KIOSK_SECRET) {
  process.env.KIOSK_SECRET = 'wave1_security_test_kiosk_secret_2026';
}
const TEST_KIOSK_SECRET = process.env.KIOSK_SECRET;

async function runWave1SecurityTests() {
  await initDB();
  const db = getDB();
  const server = app.listen(0);
  const address = server.address() as { port: number };
  const baseUrl = `http://127.0.0.1:${address.port}/api`;

  async function api(
    method: string,
    path: string,
    body?: any,
    headers: Record<string, string> = {}
  ): Promise<{ status: number; data: any }> {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...headers
      },
      body: body !== undefined ? JSON.stringify(body) : undefined
    });
    const data = await res.json().catch(() => ({}));
    return { status: res.status, data };
  }

  try {
    console.log('--- Wave 1 Security Tests Starting ---');

    // Acquire baseline admin + kiosk tokens with valid JWT_SECRET
    const testSecret = process.env.JWT_SECRET!;
    const adminLogin = await api('POST', '/auth/login', {
      email: 'admin@caffix.com',
      password: 'admin123',
      portal: 'admin'
    });
    assert.strictEqual(adminLogin.status, 200);
    const adminToken = adminLogin.data.token;

    const kioskVerify = await api(
      'GET',
      `/kiosk/verify?kiosk=${encodeURIComponent(TEST_KIOSK_SECRET)}&machine_id=CFX-MC-01`
    );
    assert.strictEqual(kioskVerify.status, 200);
    const kioskToken = kioskVerify.data.token;

    // -------------------------------------------------------------------------
    // 1. Missing JWT_SECRET tests (no hardcoded fallback)
    // -------------------------------------------------------------------------
    delete process.env.JWT_SECRET;

    const loginNoSecret = await api('POST', '/auth/login', {
      email: 'admin@caffix.com',
      password: 'admin123',
      portal: 'admin'
    });
    assert.strictEqual(
      loginNoSecret.status,
      503,
      'POST /api/auth/login must fail safely (503) when JWT_SECRET is missing'
    );

    const protectedNoSecret = await api('GET', '/machines', undefined, {
      Authorization: `Bearer ${adminToken}`
    });
    assert.strictEqual(
      protectedNoSecret.status,
      503,
      'Protected routes must fail safely (503) when JWT_SECRET is missing'
    );

    const kioskVerifyNoSecret = await api(
      'GET',
      `/kiosk/verify?kiosk=${encodeURIComponent(TEST_KIOSK_SECRET)}&machine_id=CFX-MC-01`
    );
    assert.strictEqual(
      kioskVerifyNoSecret.status,
      503,
      'GET /api/kiosk/verify must fail safely (503) when JWT_SECRET is missing'
    );

    // Deployed environment check: VERCEL=1 + NODE_ENV=production without JWT_SECRET fails closed on /api/health too
    process.env.VERCEL = '1';
    process.env.NODE_ENV = 'production';
    const deployedNoSecretHealth = await api('GET', '/health');
    assert.strictEqual(
      deployedNoSecretHealth.status,
      503,
      'Deployed environment must fail closed (503) when JWT_SECRET is missing'
    );

    // Restore runtime env for remaining tests
    process.env.JWT_SECRET = testSecret;
    if (INITIAL_VERCEL === undefined) delete process.env.VERCEL;
    else process.env.VERCEL = INITIAL_VERCEL;
    if (INITIAL_NODE_ENV === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = INITIAL_NODE_ENV;

    // Tokens signed with the legacy removed fallback secret must NEVER be accepted
    const legacyForgedToken = jwt.sign(
      { id: '1', email: 'admin@caffix.com', role: 'admin', name: 'Caffix Manager' },
      'caffix_vending_secret_key_2026_xyz'
    );
    const forgedLegacyRes = await api('GET', '/machines', undefined, {
      Authorization: `Bearer ${legacyForgedToken}`
    });
    assert.strictEqual(
      forgedLegacyRes.status,
      401,
      'Tokens signed with removed legacy fallback JWT secret must be rejected'
    );

    // -------------------------------------------------------------------------
    // 2. Missing and insecure ADMIN_PASSCODE tests (legacy '1234' removed)
    // -------------------------------------------------------------------------
    delete process.env.ADMIN_PASSCODE;
    const missingPinRes = await api(
      'POST',
      '/auth/kiosk-admin',
      { passcode: '1234', machine_id: 'CFX-MC-01' },
      { Authorization: `Bearer ${kioskToken}` }
    );
    assert.strictEqual(
      missingPinRes.status,
      503,
      'POST /api/auth/kiosk-admin must return 503 when ADMIN_PASSCODE is missing'
    );

    process.env.ADMIN_PASSCODE = '1234';
    const defaultPinRejected = await api(
      'POST',
      '/auth/kiosk-admin',
      { passcode: '1234', machine_id: 'CFX-MC-01' },
      { Authorization: `Bearer ${kioskToken}` }
    );
    assert.strictEqual(
      defaultPinRejected.status,
      503,
      'Default passcode 1234 must be rejected even if configured in env'
    );

    process.env.ADMIN_PASSCODE = '12345';
    const shortPinRejected = await api(
      'POST',
      '/auth/kiosk-admin',
      { passcode: '12345', machine_id: 'CFX-MC-01' },
      { Authorization: `Bearer ${kioskToken}` }
    );
    assert.strictEqual(
      shortPinRejected.status,
      503,
      'Short insecure ADMIN_PASSCODE (< 6 chars) must be rejected with 503'
    );

    process.env.ADMIN_PASSCODE = 'SecureKioskPin#98';
    const wrongPinRes = await api(
      'POST',
      '/auth/kiosk-admin',
      { passcode: '1234', machine_id: 'CFX-MC-01' },
      { Authorization: `Bearer ${kioskToken}` }
    );
    assert.strictEqual(wrongPinRes.status, 401, 'Wrong passcode 1234 must return 401');

    const validPinRes = await api(
      'POST',
      '/auth/kiosk-admin',
      { passcode: 'SecureKioskPin#98', machine_id: 'CFX-MC-01' },
      { Authorization: `Bearer ${kioskToken}` }
    );
    assert.strictEqual(validPinRes.status, 200, 'Explicitly configured secure ADMIN_PASSCODE must succeed');
    const kioskAdminToken = validPinRes.data.token;

    // Kiosk admin unlock token must NOT bypass portal isolation or grant Super Admin management access
    const kioskAdminOnMe = await api('GET', '/auth/me?portal=admin', undefined, {
      Authorization: `Bearer ${kioskAdminToken}`
    });
    assert.strictEqual(kioskAdminOnMe.status, 403, 'Kiosk admin unlock token must not access admin portal /me');

    const kioskAdminListOwners = await api('GET', '/auth/owners', undefined, {
      Authorization: `Bearer ${kioskAdminToken}`
    });
    assert.strictEqual(kioskAdminListOwners.status, 403, 'Kiosk admin unlock token must not list owners');

    // -------------------------------------------------------------------------
    // 3. Portal claim & role tamper/bypass tests + cross-owner machine/payment denial
    // -------------------------------------------------------------------------
    const mismatchedClaimToken = jwt.sign(
      { id: '1', email: 'admin@caffix.com', role: 'owner', name: 'Tampered', portal: 'admin' },
      testSecret
    );
    const mismatchedRes = await api('GET', '/machines', undefined, {
      Authorization: `Bearer ${mismatchedClaimToken}`
    });
    assert.strictEqual(mismatchedRes.status, 403, 'Mismatched role/portal JWT claims must be rejected with 403');

    const ownerHeaderWithAdminToken = await api('GET', '/machines', undefined, {
      Authorization: `Bearer ${adminToken}`,
      'X-Portal': 'owner'
    });
    assert.strictEqual(
      ownerHeaderWithAdminToken.status,
      403,
      'Admin token must be rejected when X-Portal: owner header is present'
    );

    // Owner cannot escalate via kiosk-admin PIN unlock or verify payment on unowned machine
    const ownerEmail = `sec_owner_${Date.now()}@caffix.com`;
    const inviteRes = await api(
      'POST',
      '/auth/owners/invite',
      { name: 'Sec Owner', email: ownerEmail, machine_ids: ['CFX-MC-01'] },
      { Authorization: `Bearer ${adminToken}` }
    );
    assert.strictEqual(inviteRes.status, 201);
    const setupRes = await api('POST', '/auth/setup-password', {
      token: inviteRes.data.data.invite_token,
      email: ownerEmail,
      password: 'OwnerSecPassword#2026'
    });
    assert.strictEqual(setupRes.status, 200);
    const ownerToken = setupRes.data.token;

    const ownerKioskAdminAttempt = await api(
      'POST',
      '/auth/kiosk-admin',
      { passcode: 'SecureKioskPin#98', machine_id: 'CFX-MC-01' },
      { Authorization: `Bearer ${ownerToken}` }
    );
    assert.strictEqual(ownerKioskAdminAttempt.status, 403, 'Owner role must be denied POST /auth/kiosk-admin');

    // Create order on CFX-MC-02 (not owned by ownerToken) and verify ownerToken cannot verify its payment
    const kioskVerifyMc02 = await api(
      'GET',
      `/kiosk/verify?kiosk=${encodeURIComponent(TEST_KIOSK_SECRET)}&machine_id=CFX-MC-02`
    );
    assert.strictEqual(kioskVerifyMc02.status, 200);
    const orderMc02 = await api(
      'POST',
      '/orders/create',
      { product_id: 1, machine_id: 'CFX-MC-02' },
      { Authorization: `Bearer ${kioskVerifyMc02.data.token}` }
    );
    assert.strictEqual(orderMc02.status, 201);

    const ownerVerifyOtherOrder = await api(
      'POST',
      '/payments/verify',
      {
        order_id: orderMc02.data.data.id,
        razorpay_order_id: orderMc02.data.data.razorpay_order_id,
        razorpay_payment_id: 'pay_mock_test_1',
        razorpay_signature: 'sig_mock'
      },
      { Authorization: `Bearer ${ownerToken}` }
    );
    assert.strictEqual(
      ownerVerifyOtherOrder.status,
      403,
      'Owner must not be allowed to verify payments for another machine'
    );

    // Clean up test order & machine ownership
    await db.run('DELETE FROM orders WHERE id = ?', [orderMc02.data.data.id]);
    await api('PATCH', '/machines/CFX-MC-01/owner', { owner_id: null }, { Authorization: `Bearer ${adminToken}` });

    // -------------------------------------------------------------------------
    // 4. Sensitive log redaction helpers
    // -------------------------------------------------------------------------
    const redactedUrl = sanitizeUrlForLogging('/api/kiosk/verify?kiosk=SUPER_SECRET_KIOSK_TOKEN&machine_id=CFX-MC-01');
    assert(!redactedUrl.includes('SUPER_SECRET_KIOSK_TOKEN'), 'Kiosk token must be redacted from logged URLs');
    assert(redactedUrl.includes('machine_id=CFX-MC-01'), 'Non-sensitive query parameters must remain');

    const redactedMsg = redactSensitiveText(
      'Auth Bearer aaa.bbb.ccc failed with -----BEGIN PRIVATE KEY-----\nSECRET_KEY_BYTES\n-----END PRIVATE KEY-----'
    );
    assert(!redactedMsg.includes('aaa.bbb.ccc'), 'Bearer JWT must be redacted from logs');
    assert(!redactedMsg.includes('SECRET_KEY_BYTES'), 'Private key must be redacted from logs');

    console.log('ALL WAVE 1 SECURITY TESTS PASSED SUCCESSFULLY!');
  } finally {
    if (INITIAL_JWT_SECRET === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = INITIAL_JWT_SECRET;
    if (INITIAL_ADMIN_PASSCODE === undefined) delete process.env.ADMIN_PASSCODE;
    else process.env.ADMIN_PASSCODE = INITIAL_ADMIN_PASSCODE;
    if (INITIAL_KIOSK_SECRET === undefined) delete process.env.KIOSK_SECRET;
    else process.env.KIOSK_SECRET = INITIAL_KIOSK_SECRET;
    if (INITIAL_VERCEL === undefined) delete process.env.VERCEL;
    else process.env.VERCEL = INITIAL_VERCEL;
    if (INITIAL_VERCEL_ENV === undefined) delete process.env.VERCEL_ENV;
    else process.env.VERCEL_ENV = INITIAL_VERCEL_ENV;
    if (INITIAL_NODE_ENV === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = INITIAL_NODE_ENV;
    server.close();
  }
}

runWave1SecurityTests()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('WAVE 1 SECURITY TEST SUITE FAILED:', err);
    process.exit(1);
  });
