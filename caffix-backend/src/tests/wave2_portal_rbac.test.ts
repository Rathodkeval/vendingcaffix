import assert from 'assert';
import http from 'http';

process.env.JWT_SECRET =
  process.env.JWT_SECRET || 'caffix-test-wave2-portal-rbac-secret-2026-explicit';

import app from '../index';
import { initDB, getDB } from '../config/db';

const PORT = 5094;
const BASE_URL = `http://127.0.0.1:${PORT}/api`;

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

async function runWave2PortalRbacTests() {
  console.log('\n=============================================================');
  console.log('Running Wave 2 Portal Separation, Machine RBAC & Pricing Tests');
  console.log('=============================================================\n');

  await initDB();
  const db = getDB();
  await db.run('DELETE FROM machine_products');
  await db.run('DELETE FROM machines WHERE id = ?', ['CFX-MC-95']);

  const server: http.Server = await new Promise((resolve) => {
    const s = app.listen(PORT, '127.0.0.1', () => resolve(s));
  });

  try {
    const ts = Date.now();
    const ownerAEmail = `w2_ownera_${ts}@caffix.com`;
    const ownerBEmail = `w2_ownerb_${ts}@caffix.com`;

    // 1. Admin login with portal='admin' & Admin can manage ANY registered machine
    const adminLogin = await api('POST', '/auth/login', {
      email: 'admin@caffix.com',
      password: 'admin123',
      portal: 'admin'
    });
    assert.strictEqual(adminLogin.status, 200, 'Admin login with portal=admin must succeed');
    const adminToken = adminLogin.data.token;
    assert.strictEqual(adminLogin.data.data.portal, 'admin');

    // Register a new machine and confirm admin can operate on both seeded & newly registered machines
    const regNewMachine = await api(
      'POST',
      '/machines/register',
      {
        id: 'CFX-MC-95',
        machine_name: 'Wave 2 Registered Lab Unit',
        location: 'Testing Floor'
      },
      { Authorization: `Bearer ${adminToken}` }
    );
    assert.strictEqual(regNewMachine.status, 201, 'Admin must register new machine CFX-MC-95');

    for (const machineId of ['CFX-MC-01', 'CFX-MC-02', 'CFX-MC-04', 'CFX-MC-95']) {
      const modeRes = await api(
        'PATCH',
        `/machines/${machineId}/status`,
        { desired_mode: 'MAINTENANCE' },
        { Authorization: `Bearer ${adminToken}` }
      );
      assert.strictEqual(modeRes.status, 200, `Admin must toggle mode on ${machineId}`);

      const runRes = await api(
        'PATCH',
        `/machines/${machineId}/status`,
        { desired_mode: 'RUNNING' },
        { Authorization: `Bearer ${adminToken}` }
      );
      assert.strictEqual(runRes.status, 200, `Admin must restore RUNNING mode on ${machineId}`);

      const refillRes = await api(
        'POST',
        `/machines/${machineId}/refill`,
        { ingredient: 'ALL' },
        { Authorization: `Bearer ${adminToken}` }
      );
      assert.strictEqual(refillRes.status, 200, `Admin must refill ${machineId}`);
    }

    // 2. Invite & activate Owner A (CFX-MC-01, CFX-MC-02) and Owner B (CFX-MC-03), leaving CFX-MC-04 & CFX-MC-95 unassigned
    await api('PATCH', '/machines/CFX-MC-04/owner', { owner_id: null }, { Authorization: `Bearer ${adminToken}` });
    await api('PATCH', '/machines/CFX-MC-95/owner', { owner_id: null }, { Authorization: `Bearer ${adminToken}` });

    const inviteA = await api(
      'POST',
      '/auth/owners/invite',
      {
        name: 'Wave2 Owner A',
        email: ownerAEmail,
        machine_ids: ['CFX-MC-01', 'CFX-MC-02']
      },
      { Authorization: `Bearer ${adminToken}` }
    );
    assert.strictEqual(inviteA.status, 201);
    const setupA = await api('POST', '/auth/setup-password', {
      token: inviteA.data.data.invite_token,
      email: ownerAEmail,
      password: 'Wave2OwnerAPass#2026'
    });
    assert.strictEqual(setupA.status, 200);
    const ownerAToken = setupA.data.token;

    const inviteB = await api(
      'POST',
      '/auth/owners/invite',
      {
        name: 'Wave2 Owner B',
        email: ownerBEmail,
        machine_ids: ['CFX-MC-03']
      },
      { Authorization: `Bearer ${adminToken}` }
    );
    assert.strictEqual(inviteB.status, 201);
    const setupB = await api('POST', '/auth/setup-password', {
      token: inviteB.data.data.invite_token,
      email: ownerBEmail,
      password: 'Wave2OwnerBPass#2026'
    });
    assert.strictEqual(setupB.status, 200);
    const ownerBToken = setupB.data.token;

    // 3. Portal-Token Exchange Rejection (Admin <-> Owner)
    const adminLoginOwnerPortal = await api('POST', '/auth/login', {
      email: 'admin@caffix.com',
      password: 'admin123',
      portal: 'owner'
    });
    assert.strictEqual(adminLoginOwnerPortal.status, 403, 'Admin cannot login to Owner portal');

    const ownerLoginAdminPortal = await api('POST', '/auth/login', {
      email: ownerAEmail,
      password: 'Wave2OwnerAPass#2026',
      portal: 'admin'
    });
    assert.strictEqual(ownerLoginAdminPortal.status, 403, 'Owner cannot login to Admin portal');

    const adminTokenOnOwnerMe = await api('GET', '/auth/me?portal=owner', undefined, {
      Authorization: `Bearer ${adminToken}`
    });
    assert.strictEqual(adminTokenOnOwnerMe.status, 403, 'Admin token must fail on /auth/me?portal=owner');

    const adminTokenWithOwnerHeader = await api('GET', '/machines', undefined, {
      Authorization: `Bearer ${adminToken}`,
      'X-Portal': 'owner'
    });
    assert.strictEqual(adminTokenWithOwnerHeader.status, 403, 'Admin token must fail when X-Portal=owner');

    const ownerTokenOnAdminMe = await api('GET', '/auth/me?portal=admin', undefined, {
      Authorization: `Bearer ${ownerAToken}`
    });
    assert.strictEqual(ownerTokenOnAdminMe.status, 403, 'Owner token must fail on /auth/me?portal=admin');

    const ownerTokenWithAdminHeader = await api('GET', '/machines', undefined, {
      Authorization: `Bearer ${ownerAToken}`,
      'X-Portal': 'admin'
    });
    assert.strictEqual(ownerTokenWithAdminHeader.status, 403, 'Owner token must fail when X-Portal=admin');

    // 4. Owner cannot invite owners or perform any admin-only action
    const ownerInviteAttempt = await api(
      'POST',
      '/auth/owners/invite',
      {
        name: 'Unauthorized Invite',
        email: `unauth_invite_${ts}@caffix.com`,
        machine_ids: []
      },
      { Authorization: `Bearer ${ownerAToken}` }
    );
    assert.strictEqual(ownerInviteAttempt.status, 403, 'Owner must never be able to invite other owners');

    const ownerListOwnersAttempt = await api('GET', '/auth/owners', undefined, {
      Authorization: `Bearer ${ownerAToken}`
    });
    assert.strictEqual(ownerListOwnersAttempt.status, 403, 'Owner must receive 403 on GET /auth/owners');

    const ownerRegMachineAttempt = await api(
      'POST',
      '/machines/register',
      { id: 'CFX-MC-94', machine_name: 'Blocked', location: 'Nope' },
      { Authorization: `Bearer ${ownerAToken}` }
    );
    assert.strictEqual(ownerRegMachineAttempt.status, 403, 'Owner cannot register machines');

    const ownerCreateProductAttempt = await api(
      'POST',
      '/products',
      { name: 'Unauthorized Drink', price: 200 },
      { Authorization: `Bearer ${ownerAToken}` }
    );
    assert.strictEqual(ownerCreateProductAttempt.status, 403, 'Owner cannot create global products');

    // 5. Owner can manage assigned machines AND is rejected (403) on BOTH unassigned and another owner's machines
    const ownerAMachines = await api('GET', '/machines', undefined, {
      Authorization: `Bearer ${ownerAToken}`
    });
    assert.strictEqual(ownerAMachines.status, 200);
    assert.deepStrictEqual(
      ownerAMachines.data.data.map((m: any) => m.id).sort(),
      ['CFX-MC-01', 'CFX-MC-02']
    );

    const ownerAAssignedMode = await api(
      'PATCH',
      '/machines/CFX-MC-01/status',
      { desired_mode: 'MAINTENANCE' },
      { Authorization: `Bearer ${ownerAToken}` }
    );
    assert.strictEqual(ownerAAssignedMode.status, 200);
    await api(
      'PATCH',
      '/machines/CFX-MC-01/status',
      { desired_mode: 'RUNNING' },
      { Authorization: `Bearer ${ownerAToken}` }
    );

    // Owner A blocked on unassigned machine CFX-MC-04 AND cross-owner machine CFX-MC-03
    for (const forbiddenMachine of ['CFX-MC-04', 'CFX-MC-03', 'CFX-MC-95']) {
      const checks = await Promise.all([
        api('GET', `/machines/${forbiddenMachine}`, undefined, { Authorization: `Bearer ${ownerAToken}` }),
        api('PATCH', `/machines/${forbiddenMachine}/status`, { desired_mode: 'MAINTENANCE' }, { Authorization: `Bearer ${ownerAToken}` }),
        api('POST', `/machines/${forbiddenMachine}/refill`, { ingredient: 'water' }, { Authorization: `Bearer ${ownerAToken}` }),
        api('GET', `/machines/${forbiddenMachine}/products`, undefined, { Authorization: `Bearer ${ownerAToken}` }),
        api('PUT', `/machines/${forbiddenMachine}/products/1`, { price: 175, is_available: false }, { Authorization: `Bearer ${ownerAToken}` }),
        api('PATCH', `/machines/${forbiddenMachine}/products/1`, { price: 175 }, { Authorization: `Bearer ${ownerAToken}` }),
        api('PUT', '/products/1/price', { price: 175, machine_id: forbiddenMachine }, { Authorization: `Bearer ${ownerAToken}` }),
        api('GET', `/orders?machine_id=${forbiddenMachine}`, undefined, { Authorization: `Bearer ${ownerAToken}` })
      ]);

      for (const res of checks) {
        assert.strictEqual(
          res.status,
          403,
          `Owner A must receive 403 Forbidden for unauthorized access to ${forbiddenMachine} (got ${res.status})`
        );
      }
    }

    // 6. Per-Machine Pricing Independence across machines (CFX-MC-01 vs CFX-MC-02 vs CFX-MC-04)
    const setMc1 = await api(
      'PUT',
      '/machines/CFX-MC-01/products/1',
      { price: 118, is_available: true },
      { Authorization: `Bearer ${ownerAToken}` }
    );
    assert.strictEqual(setMc1.status, 200);

    const setMc2 = await api(
      'PUT',
      '/machines/CFX-MC-02/products/1',
      { price: 162, is_available: true },
      { Authorization: `Bearer ${ownerAToken}` }
    );
    assert.strictEqual(setMc2.status, 200);

    // Update CFX-MC-01 price & availability again and prove CFX-MC-02 & CFX-MC-04 remain untouched
    const updateMc1Again = await api(
      'PUT',
      '/machines/CFX-MC-01/products/1',
      { price: 129, is_available: false },
      { Authorization: `Bearer ${ownerAToken}` }
    );
    assert.strictEqual(updateMc1Again.status, 200);

    const [prodMc1, prodMc2, prodMc4] = await Promise.all([
      api('GET', '/products?machine_id=CFX-MC-01'),
      api('GET', '/products?machine_id=CFX-MC-02'),
      api('GET', '/products?machine_id=CFX-MC-04')
    ]);
    assert.strictEqual(prodMc1.status, 200);
    assert.strictEqual(prodMc2.status, 200);
    assert.strictEqual(prodMc4.status, 200);

    const p1Mc1 = prodMc1.data.data.find((p: any) => Number(p.id) === 1);
    const p1Mc2 = prodMc2.data.data.find((p: any) => Number(p.id) === 1);
    const p1Mc4 = prodMc4.data.data.find((p: any) => Number(p.id) === 1);

    assert.strictEqual(p1Mc1.price, 129);
    assert.strictEqual(p1Mc1.is_available, false);
    assert.strictEqual(p1Mc2.price, 162, 'Updating CFX-MC-01 must NOT change CFX-MC-02 price');
    assert.strictEqual(p1Mc2.is_available, true, 'Updating CFX-MC-01 availability must NOT change CFX-MC-02');
    assert.strictEqual(p1Mc4.price, 100, 'Unmodified CFX-MC-04 must stay at catalog default ₹100');

    // Keep ownerBToken verified as isolated
    const ownerBMachines = await api('GET', '/machines', undefined, { Authorization: `Bearer ${ownerBToken}` });
    assert.deepStrictEqual(ownerBMachines.data.data.map((m: any) => m.id), ['CFX-MC-03']);

    // Cleanup test fixtures
    for (const machineId of ['CFX-MC-01', 'CFX-MC-02', 'CFX-MC-03', 'CFX-MC-04']) {
      await api('PATCH', `/machines/${machineId}/owner`, { owner_id: null }, { Authorization: `Bearer ${adminToken}` });
    }
    await db.run('DELETE FROM machine_products');
    await db.run('DELETE FROM machines WHERE id = ?', ['CFX-MC-95']);

    console.log('\nALL WAVE 2 PORTAL & MACHINE RBAC TESTS PASSED SUCCESSFULLY!\n');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  process.exit(0);
}

runWave2PortalRbacTests().catch((err) => {
  console.error('Wave 2 portal & machine RBAC test suite failed:', err);
  process.exit(1);
});
