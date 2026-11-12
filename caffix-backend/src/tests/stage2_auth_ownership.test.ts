import assert from 'assert';
import app from '../index';
import { initDB, getDB, resetMockDatabaseForColdStartSimulation } from '../config/db';
import { hashInvitationToken } from '../controllers/authController';

async function runStage2Tests() {
  await initDB();
  const db = getDB();

  const server = app.listen(0);
  const address = server.address() as { port: number };
  const baseUrl = `http://127.0.0.1:${address.port}/api`;

  async function api(
    method: string,
    path: string,
    body?: any,
    token?: string
  ): Promise<{ status: number; data: any }> {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {})
      },
      body: body !== undefined ? JSON.stringify(body) : undefined
    });
    const data = await res.json();
    return { status: res.status, data };
  }

  try {
    console.log('--- Stage 2 Test Suite Starting ---');

    // 1. Existing Admin & Kiosk Login Compatibility
    const adminLogin = await api('POST', '/auth/login', {
      email: 'admin@caffix.com',
      password: 'admin123'
    });
    assert.strictEqual(adminLogin.status, 200, 'Admin login must succeed');
    assert.strictEqual(adminLogin.data.data.role, 'admin');
    const adminToken = adminLogin.data.token;

    const kioskVerify = await api(
      'GET',
      '/kiosk/verify?kiosk=Kx8P2mL9Qv4Rz7Tn5Yh1&machine_id=CFX-MC-01'
    );
    assert.strictEqual(kioskVerify.status, 200, 'Kiosk verify must succeed');
    const kioskToken = kioskVerify.data.token;

    // Kiosk PIN Admin unlock must still work for local kiosk maintenance/refill
    const kioskPinAdmin = await api(
      'POST',
      '/auth/kiosk-admin',
      { passcode: '1234', machine_id: 'CFX-MC-01' },
      kioskToken
    );
    assert.strictEqual(kioskPinAdmin.status, 200, 'Kiosk PIN admin unlock must succeed');

    // 2. Kiosk Account Denied Owner Dashboard Access
    const kioskMe = await api('GET', '/auth/me', undefined, kioskToken);
    assert.strictEqual(kioskMe.status, 403, 'Kiosk must be denied GET /auth/me');

    const kioskMachines = await api('GET', '/machines', undefined, kioskToken);
    assert.strictEqual(kioskMachines.status, 403, 'Kiosk must be denied GET /machines');

    const kioskMachineDetail = await api('GET', '/machines/CFX-MC-01', undefined, kioskToken);
    assert.strictEqual(kioskMachineDetail.status, 403, 'Kiosk must be denied GET /machines/:id');

    const kioskInviteAttempt = await api(
      'POST',
      '/auth/owners/invite',
      { name: 'Hacker', email: 'hacker@example.com' },
      kioskToken
    );
    assert.strictEqual(kioskInviteAttempt.status, 403, 'Kiosk must be denied POST /auth/owners/invite');

    // 3. Admin Invites Customer A (assigned multiple machines: CFX-MC-01 & CFX-MC-02) and Customer B (CFX-MC-03)
    const uniqueSuffix = Date.now();
    const emailA = `customera_${uniqueSuffix}@caffix.com`;
    const emailB = `customerb_${uniqueSuffix}@caffix.com`;

    const inviteA = await api(
      'POST',
      '/auth/owners/invite',
      {
        name: 'Customer A Beverages',
        email: emailA,
        machine_ids: ['CFX-MC-01', 'CFX-MC-02']
      },
      adminToken
    );
    assert.strictEqual(inviteA.status, 201, 'Admin invite Customer A must return 201');
    const userAId = inviteA.data.data.user.id;
    const rawTokenA = inviteA.data.data.invite_token;
    assert(String(userAId).startsWith('usr_'), 'Owner ID must use stable usr_<uuid> format');
    assert.strictEqual(rawTokenA.length, 64, 'Invite token must be 64 hex chars (256-bit)');
    assert.deepStrictEqual(inviteA.data.data.assigned_machines, ['CFX-MC-01', 'CFX-MC-02']);

    // Verify only SHA-256 hash is stored in DB (never raw token)
    const dbUserA = await db.get('SELECT * FROM users WHERE id = ?', [userAId]);
    assert.strictEqual(dbUserA.setup_token_hash, hashInvitationToken(rawTokenA));
    assert.notStrictEqual(dbUserA.setup_token_hash, rawTokenA);

    // Attempt login BEFORE password setup must fail with 401
    const prematureLoginA = await api('POST', '/auth/login', {
      email: emailA,
      password: 'Password123!'
    });
    assert.strictEqual(prematureLoginA.status, 401, 'Login before password setup must fail');

    // Invite Customer B with CFX-MC-03
    const inviteB = await api(
      'POST',
      '/auth/owners/invite',
      {
        name: 'Customer B Hospitality',
        email: emailB,
        machine_ids: ['CFX-MC-03']
      },
      adminToken
    );
    assert.strictEqual(inviteB.status, 201, 'Admin invite Customer B must return 201');
    const userBId = inviteB.data.data.user.id;
    const rawTokenB = inviteB.data.data.invite_token;

    // 4. Customer A & Customer B Complete Password Setup
    const setupA = await api('POST', '/auth/setup-password', {
      token: rawTokenA,
      email: emailA,
      password: 'OwnerAPassword123!'
    });
    assert.strictEqual(setupA.status, 200, 'Customer A password setup must succeed');
    assert.strictEqual(setupA.data.data.id, userAId);
    assert.deepStrictEqual(
      setupA.data.data.assigned_machines.sort(),
      ['CFX-MC-01', 'CFX-MC-02'].sort()
    );

    const setupB = await api('POST', '/auth/setup-password', {
      token: rawTokenB,
      email: emailB,
      password: 'OwnerBPassword123!'
    });
    assert.strictEqual(setupB.status, 200, 'Customer B password setup must succeed');
    const tokenB = setupB.data.token;

    // 5. Invalid, Reused & Expired Invitation Tokens + Concurrent Token-Reuse Atomicity Test
    const invalidTokenAttempt = await api('POST', '/auth/setup-password', {
      token: '0'.repeat(64),
      password: 'InvalidPassword123!'
    });
    assert.strictEqual(invalidTokenAttempt.status, 400, 'Invalid random token must be rejected with 400');

    const reuseTokenA = await api('POST', '/auth/setup-password', {
      token: rawTokenA,
      email: emailA,
      password: 'AnotherPassword123!'
    });
    assert.strictEqual(reuseTokenA.status, 400, 'Reused invitation token must be rejected with 400');

    const expiredEmail = `expired_${uniqueSuffix}@caffix.com`;
    const inviteExpired = await api(
      'POST',
      '/auth/owners/invite',
      {
        name: 'Expired Owner',
        email: expiredEmail,
        machine_ids: [],
        expires_in_ms: -5000 // Already expired 5 seconds ago
      },
      adminToken
    );
    assert.strictEqual(inviteExpired.status, 201);
    const expiredAttempt = await api('POST', '/auth/setup-password', {
      token: inviteExpired.data.data.invite_token,
      email: expiredEmail,
      password: 'ExpiredPassword123!'
    });
    assert.strictEqual(expiredAttempt.status, 400, 'Expired invitation token must be rejected with 400');
    assert(
      String(expiredAttempt.data.message).toLowerCase().includes('expired'),
      'Error message must indicate token expired'
    );

    // Concurrent Token-Reuse Race Test: fire 2 simultaneous setup-password requests with the same token
    const concurrentEmail = `concurrent_${uniqueSuffix}@caffix.com`;
    const inviteConcurrent = await api(
      'POST',
      '/auth/owners/invite',
      {
        name: 'Concurrent Test Owner',
        email: concurrentEmail,
        machine_ids: []
      },
      adminToken
    );
    assert.strictEqual(inviteConcurrent.status, 201);
    const concurrentRawToken = inviteConcurrent.data.data.invite_token;

    const [raceRes1, raceRes2] = await Promise.all([
      api('POST', '/auth/setup-password', {
        token: concurrentRawToken,
        email: concurrentEmail,
        password: 'ConcurrentPassOne123!'
      }),
      api('POST', '/auth/setup-password', {
        token: concurrentRawToken,
        email: concurrentEmail,
        password: 'ConcurrentPassTwo123!'
      })
    ]);

    const statuses = [raceRes1.status, raceRes2.status].sort();
    assert.deepStrictEqual(
      statuses,
      [200, 400],
      `Concurrent setup-password with same token must have exactly one 200 and one 400 (got ${statuses})`
    );

    // Verify no user-facing API ever exposes password hash or setup_token_hash
    const ownersListRes = await api('GET', '/auth/owners', undefined, adminToken);
    assert.strictEqual(ownersListRes.status, 200);
    for (const ownerObj of ownersListRes.data.data) {
      assert.strictEqual(ownerObj.password, undefined, 'GET /auth/owners must never return password hash');
      assert.strictEqual(ownerObj.setup_token_hash, undefined, 'GET /auth/owners must never return setup_token_hash');
    }
    assert.strictEqual(inviteA.data.data.user.password, undefined, 'Invite response must never return password hash');
    assert.strictEqual(inviteA.data.data.user.setup_token_hash, undefined, 'Invite response must never return setup_token_hash');
    assert.strictEqual(setupA.data.data.password, undefined, 'Setup response must never return password hash');
    assert.strictEqual(setupA.data.data.setup_token_hash, undefined, 'Setup response must never return setup_token_hash');

    // 6. Customer A Logs In With New Password
    const loginA = await api('POST', '/auth/login', {
      email: emailA,
      password: 'OwnerAPassword123!'
    });
    assert.strictEqual(loginA.status, 200, 'Customer A login must succeed');
    const tokenA = loginA.data.token;
    assert.strictEqual(loginA.data.data.id, userAId);
    assert.strictEqual(loginA.data.data.role, 'owner');
    assert.deepStrictEqual(
      loginA.data.data.assigned_machines.sort(),
      ['CFX-MC-01', 'CFX-MC-02'].sort()
    );

    // 7. Customer A Accesses Assigned Machines (CFX-MC-01, CFX-MC-02)
    const listA = await api('GET', '/machines', undefined, tokenA);
    assert.strictEqual(listA.status, 200);
    assert.deepStrictEqual(
      listA.data.data.map((m: any) => m.id).sort(),
      ['CFX-MC-01', 'CFX-MC-02'].sort(),
      'Customer A GET /machines must only return CFX-MC-01 and CFX-MC-02'
    );

    const detailA1 = await api('GET', '/machines/CFX-MC-01', undefined, tokenA);
    assert.strictEqual(detailA1.status, 200);
    assert.strictEqual(detailA1.data.data.id, 'CFX-MC-01');

    const detailA2 = await api('GET', '/machines/CFX-MC-02', undefined, tokenA);
    assert.strictEqual(detailA2.status, 200);
    assert.strictEqual(detailA2.data.data.id, 'CFX-MC-02');

    const modeUpdateA1 = await api(
      'PATCH',
      '/machines/CFX-MC-01/status',
      { desired_mode: 'MAINTENANCE' },
      tokenA
    );
    assert.strictEqual(modeUpdateA1.status, 200, 'Customer A can toggle mode on CFX-MC-01');
    assert.strictEqual(modeUpdateA1.data.data.desired_mode, 'MAINTENANCE');

    // Restore CFX-MC-01 to RUNNING
    await api('PATCH', '/machines/CFX-MC-01/status', { desired_mode: 'RUNNING' }, tokenA);

    // 8. Customer A Receives HTTP 403 When Accessing Customer B's Machine (CFX-MC-03)
    const forbiddenDetail = await api('GET', '/machines/CFX-MC-03', undefined, tokenA);
    assert.strictEqual(forbiddenDetail.status, 403, 'Customer A GET /machines/CFX-MC-03 must return 403');

    const forbiddenMode = await api(
      'PATCH',
      '/machines/CFX-MC-03/status',
      { desired_mode: 'MAINTENANCE' },
      tokenA
    );
    assert.strictEqual(forbiddenMode.status, 403, 'Customer A PATCH /machines/CFX-MC-03/status must return 403');

    const forbiddenInv = await api('GET', '/machines/CFX-MC-03/inventory', undefined, tokenA);
    assert.strictEqual(forbiddenInv.status, 403, 'Customer A GET /machines/CFX-MC-03/inventory must return 403');

    const forbiddenRefill = await api(
      'POST',
      '/machines/CFX-MC-03/refill',
      { ingredient: 'ALL' },
      tokenA
    );
    assert.strictEqual(forbiddenRefill.status, 403, 'Customer A POST /machines/CFX-MC-03/refill must return 403');

    const forbiddenStatus = await api(
      'GET',
      '/machine-status?machine_id=CFX-MC-03',
      undefined,
      tokenA
    );
    assert.strictEqual(forbiddenStatus.status, 403, 'Customer A GET /machine-status?machine_id=CFX-MC-03 must return 403');

    // 9. Live Ownership Reassignment Takes Effect Immediately Without Re-Issuing JWTs
    const reassignM2 = await api(
      'PATCH',
      '/machines/CFX-MC-02/owner',
      { owner_id: userBId },
      adminToken
    );
    assert.strictEqual(reassignM2.status, 200, 'Admin reassign CFX-MC-02 to Customer B must succeed');

    // Customer A's existing tokenA must IMMEDIATELY lose access to CFX-MC-02
    const afterReassignA2 = await api('GET', '/machines/CFX-MC-02', undefined, tokenA);
    assert.strictEqual(
      afterReassignA2.status,
      403,
      'Customer A must immediately get 403 on CFX-MC-02 after reassignment without JWT refresh'
    );

    // Customer B's existing tokenB must IMMEDIATELY gain access to CFX-MC-02
    const afterReassignB2 = await api('GET', '/machines/CFX-MC-02', undefined, tokenB);
    assert.strictEqual(
      afterReassignB2.status,
      200,
      'Customer B must immediately get 200 on CFX-MC-02 after reassignment without JWT refresh'
    );

    // 10. Persistence Across Simulated Vercel Serverless Cold Starts
    resetMockDatabaseForColdStartSimulation();

    // Verify Customer A can still log in and access CFX-MC-01 after MockDatabase reset
    const coldStartLoginA = await api('POST', '/auth/login', {
      email: emailA,
      password: 'OwnerAPassword123!'
    });
    assert.strictEqual(coldStartLoginA.status, 200, 'Customer A login must survive cold start via Firestore hydration');
    assert.strictEqual(coldStartLoginA.data.data.id, userAId, 'User ID must remain identical after cold start');
    assert.deepStrictEqual(coldStartLoginA.data.data.assigned_machines, ['CFX-MC-01']);

    const coldStartListB = await api('GET', '/machines', undefined, tokenB);
    assert.strictEqual(coldStartListB.status, 200);
    assert.deepStrictEqual(
      coldStartListB.data.data.map((m: any) => m.id).sort(),
      ['CFX-MC-02', 'CFX-MC-03'].sort(),
      'Customer B machine assignments must survive cold start via Firestore hydration'
    );

    // 11. Portal-Role Isolation Enforcement (Admin Portal vs Owner Portal)
    const adminOnAdminPortal = await api('POST', '/auth/login', {
      email: 'admin@caffix.com',
      password: 'admin123',
      portal: 'admin'
    });
    assert.strictEqual(adminOnAdminPortal.status, 200, 'Admin login to admin portal must succeed');

    const adminOnOwnerPortal = await api('POST', '/auth/login', {
      email: 'admin@caffix.com',
      password: 'admin123',
      portal: 'owner'
    });
    assert.strictEqual(adminOnOwnerPortal.status, 403, 'Admin login to owner portal must return 403');
    assert(!adminOnOwnerPortal.data.token, 'Rejected admin login on owner portal must not issue token');

    const ownerOnOwnerPortal = await api('POST', '/auth/login', {
      email: emailA,
      password: 'OwnerAPassword123!',
      portal: 'owner'
    });
    assert.strictEqual(ownerOnOwnerPortal.status, 200, 'Owner login to owner portal must succeed');

    const ownerOnAdminPortal = await api('POST', '/auth/login', {
      email: emailA,
      password: 'OwnerAPassword123!',
      portal: 'admin'
    });
    assert.strictEqual(ownerOnAdminPortal.status, 403, 'Owner login to admin portal must return 403');
    assert(!ownerOnAdminPortal.data.token, 'Rejected owner login on admin portal must not issue token');

    const adminMeOnOwnerPortal = await api('GET', '/auth/me?portal=owner', undefined, adminToken);
    assert.strictEqual(adminMeOnOwnerPortal.status, 403, 'Admin token must fail GET /auth/me?portal=owner');

    const ownerMeOnAdminPortal = await api('GET', '/auth/me?portal=admin', undefined, tokenA);
    assert.strictEqual(ownerMeOnAdminPortal.status, 403, 'Owner token must fail GET /auth/me?portal=admin');

    const unauthRegister = await api('POST', '/auth/register', {
      name: 'Rogue Admin',
      email: 'rogue@caffix.com',
      password: 'password123',
      role: 'admin'
    });
    assert.strictEqual(unauthRegister.status, 401, 'Unauthenticated POST /auth/register must return 401');

    const ownerRegister = await api(
      'POST',
      '/auth/register',
      {
        name: 'Rogue Admin 2',
        email: 'rogue2@caffix.com',
        password: 'password123',
        role: 'admin'
      },
      tokenA
    );
    assert.strictEqual(ownerRegister.status, 403, 'Owner POST /auth/register must return 403');

    // Clean up test machine assignments
    for (const mId of ['CFX-MC-01', 'CFX-MC-02', 'CFX-MC-03']) {
      await api('PATCH', `/machines/${mId}/owner`, { owner_id: null }, adminToken);
    }

    console.log('ALL STAGE 2 TESTS PASSED SUCCESSFULLY!');
  } finally {
    server.close();
  }
}

runStage2Tests()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('STAGE 2 TEST SUITE FAILED:', err);
    process.exit(1);
  });
