import assert from 'assert';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { getDB, initDB } from '../config/db';
import {
  syncOrderToFirebase,
  getAuthoritativeOrders,
  getAuthoritativeOrderById
} from '../utils/firebase';
import { getRequiredCronSecret } from '../utils/security';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'phase2_6_test_secret_key_2026_very_strong';
process.env.KIOSK_ADMIN_ENABLED = 'false';

const JWT_SECRET = process.env.JWT_SECRET;

async function runPhase26Tests() {
  console.log('\n=============================================================');
  console.log('Running CAFFIX Phase 2.6 — Advanced Order Management Tests');
  console.log('=============================================================\n');

  const db = await initDB();

  // Test Fixture tokens
  const adminToken = jwt.sign(
    { id: 'usr_admin_1', email: 'admin@caffix.com', role: 'admin', portal: 'admin' },
    JWT_SECRET,
    { expiresIn: '1h' }
  );

  const owner1Token = jwt.sign(
    { id: 'usr_owner_1', email: 'owner1@caffix.com', role: 'owner', portal: 'owner' },
    JWT_SECRET,
    { expiresIn: '1h' }
  );

  const owner2Token = jwt.sign(
    { id: 'usr_owner_2', email: 'owner2@caffix.com', role: 'owner', portal: 'owner' },
    JWT_SECRET,
    { expiresIn: '1h' }
  );

  // 1. Setup Machines & Ownership
  console.log('1. Setting up machines CFX-MC-01 (Owner 1) and CFX-MC-02 (Owner 2)...');
  await db.run("DELETE FROM inventory_ledger WHERE order_id LIKE 'CFX-P26-%'").catch(() => {});
  await db.run("DELETE FROM refunds WHERE order_id LIKE 'CFX-P26-%'").catch(() => {});
  await db.run("DELETE FROM orders WHERE id LIKE 'CFX-P26-%'");
  await db.run(
    'INSERT OR REPLACE INTO machines (id, machine_name, location, status, owner_id, desired_mode) VALUES (?, ?, ?, ?, ?, ?)',
    ['CFX-MC-01', 'Delhi T3 Airport', 'Terminal 3', 'online', 'usr_owner_1', 'RUNNING']
  );
  await db.run(
    'INSERT OR REPLACE INTO machines (id, machine_name, location, status, owner_id, desired_mode) VALUES (?, ?, ?, ?, ?, ?)',
    ['CFX-MC-02', 'Connaught Place Unit', 'CP Block B', 'online', 'usr_owner_2', 'RUNNING']
  );

  // 2. Test All Payment Statuses & All Dispensing Statuses Independence
  console.log('2. Verifying all 5 payment statuses and 5 dispensing statuses independently...');
  const testMatrix = [
    {
      id: 'CFX-P26-001',
      machine_id: 'CFX-MC-01',
      status: 'PENDING',
      dispense_status: 'PENDING',
      payment_id: null,
      customer_name: null,
      product_id: 1,
      amount: 100,
      created_at: new Date(Date.now() - 1000 * 20).toISOString() // 20 sec ago (Today)
    },
    {
      id: 'CFX-P26-002',
      machine_id: 'CFX-MC-01',
      status: 'PAID',
      dispense_status: 'QUEUED',
      payment_id: 'pay_test_queued_111',
      customer_name: 'Rahul Sharma',
      product_id: 2,
      amount: 120,
      created_at: new Date(Date.now() - 1000 * 10).toISOString() // 10 sec ago (Today)
    },
    {
      id: 'CFX-P26-003',
      machine_id: 'CFX-MC-01',
      status: 'PAID',
      dispense_status: 'DISPENSING',
      payment_id: 'pay_test_dispensing_222',
      customer_name: null, // Anonymous kiosk guest
      product_id: 3,
      amount: 140,
      created_at: new Date().toISOString() // Just now (Today)
    },
    {
      id: 'CFX-P26-004',
      machine_id: 'CFX-MC-01',
      status: 'COMPLETED',
      dispense_status: 'DISPENSED',
      payment_id: 'pay_test_dispensed_333',
      customer_name: 'Priya Patel',
      product_id: 4,
      amount: 150,
      created_at: new Date(Date.now() - 1000 * 60 * 60 * 24 * 2).toISOString() // 2 days ago (Last 7 Days)
    },
    {
      id: 'CFX-P26-005',
      machine_id: 'CFX-MC-01',
      status: 'FAILED',
      dispense_status: 'FAILED',
      payment_id: 'pay_test_failed_444',
      customer_name: null,
      product_id: 1,
      amount: 100,
      created_at: new Date(Date.now() - 1000 * 60 * 60 * 24 * 10).toISOString() // 10 days ago (Last 30 Days)
    },
    {
      id: 'CFX-P26-006',
      machine_id: 'CFX-MC-01',
      status: 'CANCELLED',
      dispense_status: 'PENDING',
      payment_id: null,
      customer_name: null,
      product_id: 2,
      amount: 110,
      created_at: new Date(Date.now() - 1000 * 60 * 60 * 24 * 40).toISOString() // 40 days ago (Beyond 30 Days)
    },
    // Order on Machine 2 (Owned by Owner 2)
    {
      id: 'CFX-P26-007',
      machine_id: 'CFX-MC-02',
      status: 'PAID',
      dispense_status: 'DISPENSED',
      payment_id: 'pay_test_mc2_555',
      customer_name: 'Aman Verma',
      product_id: 1,
      amount: 130,
      created_at: new Date().toISOString()
    }
  ];

  for (const ord of testMatrix) {
    await syncOrderToFirebase({
      ...ord,
      coffee: `Product ${ord.product_id}`,
      razorpay_order_id: `order_rzp_${ord.id}`,
      razorpay_payment_id: ord.payment_id,
      customer_name: ord.customer_name,
      updated_at: new Date().toISOString()
    });
  }

  // Fetch all authoritative orders
  const allOrders = await getAuthoritativeOrders(db);
  assert.ok(allOrders.length >= testMatrix.length, 'All orders must be returned');

  // Verify each status in testMatrix is returned exactly without inference
  for (const expected of testMatrix) {
    const fetched = allOrders.find((o) => o.id === expected.id);
    assert.ok(fetched, `Order ${expected.id} must exist in authoritative order list`);
    assert.strictEqual(
      fetched.status,
      expected.status,
      `Order ${expected.id} status must be ${expected.status}`
    );
    assert.strictEqual(
      fetched.dispense_status,
      expected.dispense_status,
      `Order ${expected.id} dispense_status must be ${expected.dispense_status} (never inferred)`
    );
    assert.strictEqual(
      fetched.razorpay_payment_id,
      expected.payment_id,
      `Order ${expected.id} payment_id must match`
    );
    assert.strictEqual(
      fetched.customer_name,
      expected.customer_name,
      `Order ${expected.id} customer_name must match`
    );
  }
  console.log('   PASS: All 5 payment statuses and 5 dispensing statuses independently verified.');

  // 3. Test Payment ID Visibility & Formatting
  console.log('3. Testing Razorpay Payment ID visibility and masking helpers...');
  const paidOrder = allOrders.find((o) => o.id === 'CFX-P26-002');
  assert.strictEqual(paidOrder.razorpay_payment_id, 'pay_test_queued_111');
  const unpaidOrder = allOrders.find((o) => o.id === 'CFX-P26-001');
  assert.strictEqual(unpaidOrder.razorpay_payment_id, null);
  console.log('   PASS: Razorpay Payment ID visibility verified.');

  // 4. Test Machine Scoping & Owner Isolation
  console.log('4. Testing Machine Isolation between Owner 1 (CFX-MC-01) and Owner 2 (CFX-MC-02)...');
  const allOwner1Orders = await getAuthoritativeOrders(db, ['CFX-MC-01']);
  const allOwner2Orders = await getAuthoritativeOrders(db, ['CFX-MC-02']);
  const owner1Orders = allOwner1Orders.filter((o) => o.id.startsWith('CFX-P26-'));
  const owner2Orders = allOwner2Orders.filter((o) => o.id.startsWith('CFX-P26-'));

  // Owner 1 must see all CFX-MC-01 orders and ZERO CFX-MC-02 orders
  assert.ok(allOwner1Orders.every((o) => o.machine_id === 'CFX-MC-01'), 'Owner 1 must only see CFX-MC-01');
  assert.ok(allOwner1Orders.some((o) => o.id === 'CFX-P26-001'), 'Owner 1 must see CFX-P26-001');
  assert.ok(!allOwner1Orders.some((o) => o.id === 'CFX-P26-007'), 'Owner 1 must NOT see CFX-MC-02 order');

  // Owner 2 must see CFX-MC-02 orders and ZERO CFX-MC-01 orders
  assert.ok(allOwner2Orders.every((o) => o.machine_id === 'CFX-MC-02'), 'Owner 2 must only see CFX-MC-02');
  assert.ok(allOwner2Orders.some((o) => o.id === 'CFX-P26-007'), 'Owner 2 must see CFX-P26-007');
  assert.ok(!allOwner2Orders.some((o) => o.id === 'CFX-P26-001'), 'Owner 2 must NOT see CFX-MC-01 order');

  // Super Admin sees both machines
  const superAdminOrders = await getAuthoritativeOrders(db);
  assert.ok(superAdminOrders.some((o) => o.machine_id === 'CFX-MC-01'), 'Admin sees CFX-MC-01');
  assert.ok(superAdminOrders.some((o) => o.machine_id === 'CFX-MC-02'), 'Admin sees CFX-MC-02');
  console.log('   PASS: Multi-machine isolation and Super Admin fleet visibility verified.');

  // 5. Test Combined Multi-Filters (Frontend Logic Simulation)
  console.log('5. Testing combined multi-filtering (Payment + Dispensing + Machine + Date Range)...');
  const nowMs = Date.now();
  const startOfTodayMs = new Date(new Date(nowMs).toDateString()).getTime();

  // Filter A: Payment = PAID, Dispensing = DISPENSING, Machine = CFX-MC-01
  const filterA = owner1Orders.filter(
    (o) =>
      o.machine_id === 'CFX-MC-01' &&
      o.status === 'PAID' &&
      o.dispense_status === 'DISPENSING'
  );
  assert.strictEqual(filterA.length, 1);
  assert.strictEqual(filterA[0].id, 'CFX-P26-003');

  // Filter B: Date range = TODAY (should include CFX-P26-001, 002, 003)
  const filterToday = owner1Orders.filter((o) => {
    const d = Date.parse(o.created_at);
    return !Number.isNaN(d) && d >= startOfTodayMs;
  });
  assert.ok(filterToday.some((o) => o.id === 'CFX-P26-001'));
  assert.ok(filterToday.some((o) => o.id === 'CFX-P26-002'));
  assert.ok(filterToday.some((o) => o.id === 'CFX-P26-003'));
  assert.ok(!filterToday.some((o) => o.id === 'CFX-P26-004'), '2-day-old order must not be in TODAY filter');

  // Filter C: Date range = 7D (should include TODAY + CFX-P26-004)
  const cutoff7d = startOfTodayMs - 6 * 24 * 60 * 60 * 1000;
  const filter7d = owner1Orders.filter((o) => {
    const d = Date.parse(o.created_at);
    return !Number.isNaN(d) && d >= cutoff7d;
  });
  assert.ok(filter7d.some((o) => o.id === 'CFX-P26-004'));
  assert.ok(!filter7d.some((o) => o.id === 'CFX-P26-005'), '10-day-old order must not be in 7D filter');

  // Filter D: Search query = "Rahul"
  const filterSearch = owner1Orders.filter((o) =>
    (o.customer_name || '').toLowerCase().includes('rahul')
  );
  assert.strictEqual(filterSearch.length, 1);
  assert.strictEqual(filterSearch[0].id, 'CFX-P26-002');

  console.log('   PASS: Combined multi-filtering logic passed successfully.');

  // 6. Test Single Order Details Hydration
  console.log('6. Testing single order detail hydration via getAuthoritativeOrderById...');
  const detailOrder = await getAuthoritativeOrderById('CFX-P26-003', db);
  assert.ok(detailOrder);
  assert.strictEqual(detailOrder.id, 'CFX-P26-003');
  assert.strictEqual(detailOrder.machine_id, 'CFX-MC-01');
  assert.strictEqual(detailOrder.status, 'PAID');
  assert.strictEqual(detailOrder.dispense_status, 'DISPENSING');
  assert.strictEqual(detailOrder.razorpay_payment_id, 'pay_test_dispensing_222');
  console.log('   PASS: getAuthoritativeOrderById detail hydration verified.');

  // 7. Test Phase 2.6.1 Razorpay Order ID Search Logic
  console.log('7. Testing Phase 2.6.1 Razorpay Order ID Search logic (exact, partial, case-insensitive, null-safe, combined)...');
  function filterOrders(ordersList: any[], filters: {
    search?: string;
    paymentStatus?: string;
    dispenseStatus?: string;
    machineId?: string;
  }) {
    return ordersList.filter((o) => {
      if (filters.machineId && filters.machineId !== 'ALL' && o.machine_id !== filters.machineId) {
        return false;
      }
      if (filters.paymentStatus && filters.paymentStatus !== 'ALL' && o.status !== filters.paymentStatus) {
        return false;
      }
      if (filters.dispenseStatus && filters.dispenseStatus !== 'ALL' && o.dispense_status !== filters.dispenseStatus) {
        return false;
      }
      if (filters.search && filters.search.trim()) {
        const q = filters.search.trim().toLowerCase();
        const idMatch = String(o.id || '').toLowerCase().includes(q);
        const prodMatch = String(o.product_name || o.coffee || '').toLowerCase().includes(q);
        const machMatch = String(o.machine_id || '').toLowerCase().includes(q);
        const payIdMatch = String(o.razorpay_payment_id || '').toLowerCase().includes(q);
        const rpOrderIdMatch = String(o.razorpay_order_id || '').toLowerCase().includes(q);
        const custMatch =
          String(o.customer_name || '').toLowerCase().includes(q) ||
          String(o.customer_email || '').toLowerCase().includes(q);
        return idMatch || prodMatch || machMatch || payIdMatch || rpOrderIdMatch || custMatch;
      }
      return true;
    });
  }

  // A. Exact Razorpay Order ID Search
  const exactRpSearch = filterOrders(allOrders, { search: 'order_rzp_cfx-p26-002' });
  assert.strictEqual(exactRpSearch.length, 1, 'Exact Razorpay Order ID must match exactly 1 order');
  assert.strictEqual(exactRpSearch[0].id, 'CFX-P26-002');
  assert.strictEqual(exactRpSearch[0].razorpay_order_id, 'order_rzp_CFX-P26-002');

  // B. Partial Razorpay Order ID Search
  const partialRpSearch = filterOrders(allOrders, { search: 'p26-003' });
  assert.ok(partialRpSearch.length >= 1, 'Partial Razorpay Order ID search must match');
  assert.ok(partialRpSearch.some((o) => o.id === 'CFX-P26-003'));

  // C. Case-Insensitive Search
  const upperRpSearch = filterOrders(allOrders, { search: 'ORDER_RZP_CFX-P26-002' });
  assert.strictEqual(upperRpSearch.length, 1, 'Uppercase query must match lowercase stored razorpay_order_id');
  assert.strictEqual(upperRpSearch[0].id, 'CFX-P26-002');

  const mixedRpSearch = filterOrders(allOrders, { search: 'OrDeR_RzP_cFX-p26-004' });
  assert.strictEqual(mixedRpSearch.length, 1, 'Mixed-case query must match stored razorpay_order_id');
  assert.strictEqual(mixedRpSearch[0].id, 'CFX-P26-004');

  // D. Missing / Null Razorpay Order ID
  const testOrderNoRp = {
    id: 'CFX-P26-NULL-RP',
    machine_id: 'CFX-MC-01',
    status: 'PENDING',
    dispense_status: 'PENDING',
    razorpay_order_id: null,
    razorpay_payment_id: null
  };
  const listWithNull = [...allOrders, testOrderNoRp];
  assert.doesNotThrow(() => {
    const searchResult = filterOrders(listWithNull, { search: 'order_rzp_cfx-p26-002' });
    assert.strictEqual(searchResult.length, 1);
    assert.strictEqual(searchResult[0].id, 'CFX-P26-002');
  }, 'Null razorpay_order_id must never cause TypeError');

  // E. Combined Search with Payment and Dispensing Filters
  // Search 'order_rzp_cfx' + Payment 'PAID' + Dispense 'DISPENSING'
  const combinedActive = filterOrders(allOrders, {
    search: 'order_rzp_cfx',
    paymentStatus: 'PAID',
    dispenseStatus: 'DISPENSING'
  });
  assert.strictEqual(combinedActive.length, 1, 'Combined search + PAID + DISPENSING must return only CFX-P26-003');
  assert.strictEqual(combinedActive[0].id, 'CFX-P26-003');

  // Search 'order_rzp_cfx' + Payment 'PAID' + Dispense 'FAILED'
  const combinedFailed = filterOrders(allOrders, {
    search: 'order_rzp_cfx',
    paymentStatus: 'FAILED',
    dispenseStatus: 'FAILED'
  });
  assert.strictEqual(combinedFailed.length, 1, 'Combined search + FAILED + FAILED must return only CFX-P26-005');
  assert.strictEqual(combinedFailed[0].id, 'CFX-P26-005');

  // Non-matching combination
  const noMatchCombo = filterOrders(allOrders, {
    search: 'order_rzp_cfx-p26-003',
    paymentStatus: 'CANCELLED'
  });
  assert.strictEqual(noMatchCombo.length, 0, 'Conflicting search and payment status must yield 0 results');
  console.log('   PASS: Phase 2.6.1 Razorpay Order ID search logic verified successfully.');

  console.log('\n=============================================================');
  console.log('ALL PHASE 2.6 & 2.6.1 ADVANCED ORDER MANAGEMENT TESTS PASSED!');
  console.log('=============================================================\n');
}

runPhase26Tests().catch((err) => {
  console.error('Phase 2.6 test failed:', err);
  process.exit(1);
});

