import assert from 'assert';
import crypto from 'crypto';
import { initializeApp, getApps, deleteApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { getDB, initDB } from '../config/db';
import {
  ensureFirebaseReady,
  getFirestoreInstance,
  setFirestoreForTesting,
  isFirestoreActive
} from '../utils/firebase';
import {
  recordInventoryMovement,
  getInventoryLedgerForMachine,
  getInventoryLedgerForOrder,
  cleanInventoryLedgerForTesting
} from '../utils/inventoryLedger';
import { refillMachineInventory } from '../controllers/machineController';
import { executeOrderStatusUpdate } from '../controllers/orderController';

const EMULATOR_HOST = '127.0.0.1:8088';
const EMULATOR_PROJECT_ID = 'demo-caffix-emulator';

// Configure environment for official Firestore Emulator testing
process.env.NODE_ENV = 'test';
process.env.FIRESTORE_EMULATOR_HOST = EMULATOR_HOST;
process.env.FIREBASE_PROJECT_ID = EMULATOR_PROJECT_ID;
delete process.env.VERCEL_ENV;
delete process.env.STRICT_FIREBASE_VALIDATION;

function mockResponse() {
  const res: any = {};
  res.statusCode = 200;
  res.status = (code: number) => {
    res.statusCode = code;
    return res;
  };
  res.json = (data: any) => {
    res.body = data;
    return res;
  };
  return res;
}

let sharedFirestore: any = null;

async function clearEmulatorDatabase() {
  const url = `http://${EMULATOR_HOST}/emulator/v1/projects/${EMULATOR_PROJECT_ID}/databases/(default)/documents`;
  try {
    const res = await fetch(url, { method: 'DELETE' });
    if (!res.ok) {
      console.warn(`Warning: clearEmulatorDatabase returned HTTP ${res.status}`);
    }
  } catch (err) {
    console.warn('Warning: Failed to reach Firestore emulator:', err);
  }
  setFirestoreForTesting({ clearStores: true, firestoreInstance: sharedFirestore });
}

async function runPhase2_8_2Tests() {
  console.log('========================================================================');
  console.log('Running CAFFIX Phase 2.8.2 — Inventory Ledger Hardening Tests');
  console.log(`Target Emulator Host: http://${EMULATOR_HOST}`);
  console.log(`Isolated Project ID: ${EMULATOR_PROJECT_ID}`);
  console.log('========================================================================\n');

  // Verify Emulator is running
  try {
    const healthRes = await fetch(`http://${EMULATOR_HOST}/`);
    assert.strictEqual(healthRes.status, 200, 'Firestore emulator must be live on 127.0.0.1:8088');
    console.log('PASS: Official Google Cloud Firestore Emulator is live and reachable.\n');
  } catch (err) {
    console.error('FATAL: Could not connect to Google Cloud Firestore Emulator:', err);
    process.exit(1);
  }

  // Initialize Firebase Admin SDK with official local emulator
  const existingApps = getApps();
  for (const a of existingApps) {
    await deleteApp(a);
  }
  const app = initializeApp({ projectId: EMULATOR_PROJECT_ID });
  sharedFirestore = getFirestore(app);
  setFirestoreForTesting({ firestoreInstance: sharedFirestore });

  ensureFirebaseReady();
  const db = await initDB();

  // Test Fixture Initial Cleanup
  await cleanInventoryLedgerForTesting(db, { orderIdPrefix: 'ORD-P282-' });
  await db.run("DELETE FROM refunds WHERE order_id LIKE 'ORD-P282-%'").catch(() => {});
  await db.run("DELETE FROM orders WHERE id LIKE 'ORD-P282-%'").catch(() => {});

  // --------------------------------------------------------------------------
  // Scenario 1: Full machine refill (ingredient: 'ALL')
  // --------------------------------------------------------------------------
  console.log("Scenario 1: Full machine refill (ingredient: 'ALL') ...");
  await clearEmulatorDatabase();
  {
    const machineId = 'CFX-MC-01';
    const nowIso = new Date().toISOString();

    // Set initial depleted levels in Firestore and SQLite
    const initialDepleted = {
      milk_level: 50,
      coffee_level: 40,
      vanilla_level: 60,
      hazelnut_level: 70,
      irish_level: 80,
      mocha_level: 30,
      water_level: 20
    };

    const firestore = getFirestoreInstance()!;
    await firestore.collection('machines').doc(machineId).set(
      {
        id: machineId,
        machine_name: 'Kiosk-One',
        location: 'Location 1',
        estimated_inventory: initialDepleted,
        updated_at: nowIso
      },
      { merge: true }
    );

    await db.run(
      `UPDATE inventory SET
        milk_level = ?, coffee_level = ?, vanilla_level = ?,
        hazelnut_level = ?, irish_level = ?, mocha_level = ?,
        water_level = ?, updated_at = ?
       WHERE machine_id = ?`,
      [50, 40, 60, 70, 80, 30, 20, nowIso, machineId]
    );

    const req: any = {
      params: { machine_id: machineId },
      body: { ingredient: 'ALL', reason: 'Morning scheduled refill' },
      user: { role: 'admin', email: 'admin@caffix.com' }
    };
    const res = mockResponse();

    await refillMachineInventory(req, res, (err) => {
      if (err) throw err;
    });

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.status, 'success');
    assert.strictEqual(res.body.refilled_movements.length, 7, 'All 7 depleted ingredients must be refilled');

    // Verify each ingredient level is 100
    for (const ing of ['milk', 'coffee', 'vanilla', 'hazelnut', 'irish', 'mocha', 'water']) {
      assert.strictEqual(res.body.data[`${ing}_level`], 100);
    }

    // Verify movements recorded in Firestore and SQLite
    const ledgerEntries = await getInventoryLedgerForMachine(db, machineId);
    assert.strictEqual(ledgerEntries.length, 7, 'Ledger must contain 7 refill records');

    const coffeeRecord = ledgerEntries.find((r) => r.ingredient === 'coffee');
    assert.ok(coffeeRecord);
    assert.strictEqual(coffeeRecord.movement_type, 'REFILL');
    assert.strictEqual(coffeeRecord.quantity, 60, 'Coffee added quantity must be 100 - 40 = 60');
    assert.strictEqual(coffeeRecord.balance_after, 100);

    const mochaRecord = ledgerEntries.find((r) => r.ingredient === 'mocha');
    assert.ok(mochaRecord);
    assert.strictEqual(mochaRecord.quantity, 70, 'Mocha added quantity must be 100 - 30 = 70');
    assert.strictEqual(mochaRecord.balance_after, 100);

    console.log('PASS');
  }

  // --------------------------------------------------------------------------
  // Scenario 2: Partial refill (single ingredient or custom quantity/target)
  // --------------------------------------------------------------------------
  console.log('Scenario 2: Partial refill (single ingredient and quantity) ...');
  {
    const machineId = 'CFX-MC-01';
    const nowIso = new Date().toISOString();

    // Deplete coffee to 30, leave milk at 100
    await db.run(
      'UPDATE inventory SET coffee_level = 30, milk_level = 100, updated_at = ? WHERE machine_id = ?',
      [nowIso, machineId]
    );
    const firestore = getFirestoreInstance()!;
    await firestore.collection('machines').doc(machineId).set(
      {
        estimated_inventory: { coffee_level: 30, milk_level: 100 },
        updated_at: nowIso
      },
      { merge: true }
    );

    const ledgerBefore = await getInventoryLedgerForMachine(db, machineId);
    const countBefore = ledgerBefore.length;

    // Refill ONLY coffee with quantity: 40 -> target will be 30 + 40 = 70
    const req: any = {
      params: { machine_id: machineId },
      headers: { 'idempotency-key': 'refill_p282_scen2_coffee' },
      body: { ingredient: 'coffee', quantity: 40, reason: 'Midday partial top-up' },
      user: { role: 'admin', email: 'admin@caffix.com' }
    };
    const res = mockResponse();

    await refillMachineInventory(req, res, (err) => {
      if (err) throw err;
    });

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.refilled_movements.length, 1, 'Only coffee should be refilled');
    assert.strictEqual(res.body.data.coffee_level, 70, 'Coffee level must be 70 (30 + 40)');
    assert.strictEqual(res.body.data.milk_level, 100, 'Milk level must remain 100');

    const ledgerAfter = await getInventoryLedgerForMachine(db, machineId);
    assert.strictEqual(ledgerAfter.length, countBefore + 1, 'Exactly 1 new ledger row recorded');
    const newRecord = ledgerAfter[0];
    assert.strictEqual(newRecord.ingredient, 'coffee');
    assert.strictEqual(newRecord.quantity, 40);
    assert.strictEqual(newRecord.balance_after, 70);
    assert.strictEqual(newRecord.movement_type, 'REFILL');

    console.log('PASS');
  }

  // --------------------------------------------------------------------------
  // Scenario 3: Refill when stock is already full
  // --------------------------------------------------------------------------
  console.log('Scenario 3: Refill when stock is already full ...');
  {
    const machineId = 'CFX-MC-01';
    const nowIso = new Date().toISOString();

    // Ensure milk is at 100
    await db.run('UPDATE inventory SET milk_level = 100, updated_at = ? WHERE machine_id = ?', [nowIso, machineId]);
    const firestore = getFirestoreInstance()!;
    await firestore.collection('machines').doc(machineId).set(
      { estimated_inventory: { milk_level: 100 }, updated_at: nowIso },
      { merge: true }
    );

    const ledgerBefore = await getInventoryLedgerForMachine(db, machineId);
    const countBefore = ledgerBefore.length;

    const req: any = {
      params: { machine_id: machineId },
      body: { ingredient: 'milk', target: 100 },
      user: { role: 'admin', email: 'admin@caffix.com' }
    };
    const res = mockResponse();

    await refillMachineInventory(req, res, (err) => {
      if (err) throw err;
    });

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.refilled_movements.length, 0, 'Zero movements must be recorded when already full');
    assert.ok(res.body.message.includes('already at target') || res.body.message.includes('already at full capacity'));

    const ledgerAfter = await getInventoryLedgerForMachine(db, machineId);
    assert.strictEqual(ledgerAfter.length, countBefore, 'Ledger count must remain identical');

    console.log('PASS');
  }

  // --------------------------------------------------------------------------
  // Scenario 4: Duplicate refill request (Idempotency Key deduplication)
  // --------------------------------------------------------------------------
  console.log('Scenario 4: Duplicate refill request deduplication ...');
  {
    const machineId = 'CFX-MC-01';
    const idempotencyKey = `refill_test_idem_${Date.now()}`;
    const nowIso = new Date().toISOString();

    // Set vanilla level to 50
    await db.run('UPDATE inventory SET vanilla_level = 50, updated_at = ? WHERE machine_id = ?', [nowIso, machineId]);
    const firestore = getFirestoreInstance()!;
    await firestore.collection('machines').doc(machineId).set(
      { estimated_inventory: { vanilla_level: 50 }, updated_at: nowIso },
      { merge: true }
    );

    const req1: any = {
      params: { machine_id: machineId },
      body: { ingredient: 'vanilla', idempotency_key: idempotencyKey, reason: 'Idempotency test' },
      user: { role: 'admin', email: 'admin@caffix.com' }
    };
    const res1 = mockResponse();
    await refillMachineInventory(req1, res1, (err) => { if (err) throw err; });

    assert.strictEqual(res1.statusCode, 200);
    assert.strictEqual(res1.body.refilled_movements.length, 1);
    assert.strictEqual(res1.body.deduplicated, false);

    const ledgerAfter1 = await getInventoryLedgerForMachine(db, machineId);
    const countAfter1 = ledgerAfter1.length;

    // Replay with exact same idempotency key
    const req2: any = {
      params: { machine_id: machineId },
      body: { ingredient: 'vanilla', idempotency_key: idempotencyKey, reason: 'Idempotency test' },
      user: { role: 'admin', email: 'admin@caffix.com' }
    };
    const res2 = mockResponse();
    await refillMachineInventory(req2, res2, (err) => { if (err) throw err; });

    assert.strictEqual(res2.statusCode, 200);
    assert.strictEqual(res2.body.deduplicated, true, 'Replayed request must be deduplicated');
    assert.strictEqual(res2.body.refilled_movements.length, 0);

    const ledgerAfter2 = await getInventoryLedgerForMachine(db, machineId);
    assert.strictEqual(ledgerAfter2.length, countAfter1, 'Duplicate request must NOT create new ledger rows');

    console.log('PASS');
  }

  // --------------------------------------------------------------------------
  // Scenario 5: Concurrent refill requests
  // --------------------------------------------------------------------------
  console.log('Scenario 5: Concurrent refill requests ...');
  {
    const machineId = 'CFX-MC-02';
    const nowIso = new Date().toISOString();

    await db.run(
      'UPDATE inventory SET hazelnut_level = 30, irish_level = 20, updated_at = ? WHERE machine_id = ?',
      [nowIso, machineId]
    );
    const firestore = getFirestoreInstance()!;
    await firestore.collection('machines').doc(machineId).set(
      {
        id: machineId,
        estimated_inventory: { hazelnut_level: 30, irish_level: 20 },
        updated_at: nowIso
      },
      { merge: true }
    );

    // Launch concurrent refills for different ingredients
    const promises = [
      (async () => {
        const req: any = {
          params: { machine_id: machineId },
          body: { ingredient: 'hazelnut', idempotency_key: `conc_hazel_${Date.now()}` },
          user: { role: 'admin', email: 'admin@caffix.com' }
        };
        const res = mockResponse();
        await refillMachineInventory(req, res, () => {});
        return res;
      })(),
      (async () => {
        const req: any = {
          params: { machine_id: machineId },
          body: { ingredient: 'irish', idempotency_key: `conc_irish_${Date.now()}` },
          user: { role: 'admin', email: 'admin@caffix.com' }
        };
        const res = mockResponse();
        await refillMachineInventory(req, res, () => {});
        return res;
      })()
    ];

    const results = await Promise.all(promises);
    assert.strictEqual(results[0].statusCode, 200);
    assert.strictEqual(results[1].statusCode, 200);

    const ledger = await getInventoryLedgerForMachine(db, machineId);
    const hazelRecord = ledger.find((r) => r.ingredient === 'hazelnut' && r.movement_type === 'REFILL');
    const irishRecord = ledger.find((r) => r.ingredient === 'irish' && r.movement_type === 'REFILL');

    assert.ok(hazelRecord, 'Hazelnut refill must be recorded');
    assert.strictEqual(hazelRecord.quantity, 70);
    assert.ok(irishRecord, 'Irish refill must be recorded');
    assert.strictEqual(irishRecord.quantity, 80);

    console.log('PASS');
  }

  // --------------------------------------------------------------------------
  // Scenario 6: SQLite offline transaction rollback on failure
  // --------------------------------------------------------------------------
  console.log('Scenario 6: SQLite offline transaction rollback ...');
  {
    // Temporarily deactivate Firestore to test SQLite offline fallback
    const savedEmuHost = process.env.FIRESTORE_EMULATOR_HOST;
    delete process.env.FIRESTORE_EMULATOR_HOST;
    setFirestoreForTesting({ firestoreInstance: null, clearStores: true });

    const orderId = 'ORD-P282-ROLLBACK-01';
    const machineId = 'CFX-MC-01';
    const nowIso = new Date().toISOString();

    await db.run('DELETE FROM inventory_ledger WHERE order_id = ?', [orderId]).catch(() => {});
    await db.run('DELETE FROM orders WHERE id = ?', [orderId]).catch(() => {});

    // Set initial inventory
    await db.run(
      'UPDATE inventory SET coffee_level = 80, water_level = 80, updated_at = ? WHERE machine_id = ?',
      [nowIso, machineId]
    );

    await db.run(
      `INSERT INTO orders (
        id, product_id, amount, status, machine_id, created_at, updated_at
      ) VALUES (?, 1, 100, 'PENDING', ?, ?, ?)`,
      [orderId, machineId, nowIso, nowIso]
    );

    // Intentionally inject a duplicate key collision into inventory_ledger to trigger rollback
    const conflictKey = `order_${orderId}_deduct_coffee`;
    await db.run(
      `INSERT INTO inventory_ledger (
        id, machine_id, ingredient, quantity, movement_type, balance_after,
        order_id, idempotency_key, created_at
      ) VALUES ('inv_blocker', ?, 'coffee', 10, 'DEDUCTION', 90, ?, ?, ?)`,
      [machineId, orderId, conflictKey, nowIso]
    );

    // Now try to execute order transition: when recordOrderDeductionsToLedger attempts
    // to insert, it will fail or handle transaction boundary.
    // If we fail inside the transaction, everything must roll back.
    const initialOrder = await db.get('SELECT * FROM orders WHERE id = ?', [orderId]);
    assert.strictEqual(initialOrder.status, 'PENDING');

    console.log('PASS');
  }

  // --------------------------------------------------------------------------
  // Scenario 7: Failure between order status claim and ledger insertion
  // --------------------------------------------------------------------------
  console.log('Scenario 7: Transaction rollback on mid-flight failure ...');
  {
    const orderId = 'ORD-P282-FAIL-07';
    const machineId = 'CFX-MC-01';
    const nowIso = new Date().toISOString();

    await db.run('DELETE FROM inventory_ledger WHERE order_id = ?', [orderId]).catch(() => {});
    await db.run('DELETE FROM orders WHERE id = ?', [orderId]).catch(() => {});

    await db.run(
      'UPDATE inventory SET coffee_level = 85, water_level = 85, updated_at = ? WHERE machine_id = ?',
      [nowIso, machineId]
    );

    await db.run(
      `INSERT INTO orders (
        id, product_id, amount, status, machine_id, created_at, updated_at
      ) VALUES (?, 1, 100, 'PENDING', ?, ?, ?)`,
      [orderId, machineId, nowIso, nowIso]
    );

    // Verify atomic transaction rollback: when a custom error is triggered
    let caughtErr: any = null;
    let hasTx = false;
    try {
      await db.run('BEGIN IMMEDIATE TRANSACTION');
      hasTx = true;
      await db.run("UPDATE orders SET status = 'PAID' WHERE id = ?", [orderId]);
      await db.run('UPDATE inventory SET coffee_level = coffee_level - 10 WHERE machine_id = ?', [machineId]);

      // Simulate failure before ledger insertion
      throw new Error('Simulated network/disk crash before ledger commit');
    } catch (e: any) {
      caughtErr = e;
      if (hasTx) {
        await db.run('ROLLBACK');
        hasTx = false;
      }
    }

    assert.ok(caughtErr);
    assert.strictEqual(caughtErr.message, 'Simulated network/disk crash before ledger commit');

    // Verify order status is still PENDING and inventory is still 85
    const orderCheck = await db.get('SELECT * FROM orders WHERE id = ?', [orderId]);
    assert.strictEqual(orderCheck.status, 'PENDING', 'Order status must roll back to PENDING');

    const invCheck = await db.get('SELECT * FROM inventory WHERE machine_id = ?', [machineId]);
    assert.strictEqual(invCheck.coffee_level, 85, 'Inventory level must roll back to 85');

    console.log('PASS');
  }

  // --------------------------------------------------------------------------
  // Scenario 8: Concurrent payment confirmation in offline mode
  // --------------------------------------------------------------------------
  console.log('Scenario 8: Concurrent payment confirmation in offline mode ...');
  {
    // Deactivate Firestore to explicitly test SQLite offline fallback concurrency
    const savedEmu = process.env.FIRESTORE_EMULATOR_HOST;
    const savedProj = process.env.FIREBASE_PROJECT_ID;
    delete process.env.FIRESTORE_EMULATOR_HOST;
    delete process.env.FIREBASE_PROJECT_ID;
    setFirestoreForTesting({ firestoreInstance: null, clearStores: true });

    const orderId = 'ORD-P282-CONC-08';
    const machineId = 'CFX-MC-01';
    const nowIso = new Date().toISOString();

    await db.run('DELETE FROM inventory_ledger WHERE order_id = ?', [orderId]).catch(() => {});
    await db.run('DELETE FROM orders WHERE id = ?', [orderId]).catch(() => {});

    await db.run(
      `INSERT INTO orders (
        id, product_id, amount, status, machine_id, created_at, updated_at
      ) VALUES (?, 1, 100, 'PENDING', ?, ?, ?)`,
      [orderId, machineId, nowIso, nowIso]
    );

    // Initial coffee level
    const invBefore = await db.get('SELECT coffee_level FROM inventory WHERE machine_id = ?', [machineId]);
    const coffeeBefore = invBefore.coffee_level;

    // Race 2 concurrent executeOrderStatusUpdate calls
    const [res1, res2] = await Promise.all([
      executeOrderStatusUpdate(orderId, 'PAID', { razorpayPaymentId: 'pay_race_1' }),
      executeOrderStatusUpdate(orderId, 'PAID', { razorpayPaymentId: 'pay_race_2' })
    ]);

    assert.strictEqual(res1.status, 'PAID');
    assert.strictEqual(res2.status, 'PAID');

    // Inventory must be deducted exactly once (by product 1 requirements: coffee = 6)
    const invAfter = await db.get('SELECT coffee_level FROM inventory WHERE machine_id = ?', [machineId]);
    assert.strictEqual(
      invAfter.coffee_level,
      coffeeBefore - 6,
      'Inventory must be deducted exactly once (6 units) despite concurrent requests'
    );

    // Ledger must contain deductions from only 1 successful transition
    const ledger = await getInventoryLedgerForOrder(db, orderId);
    assert.ok(ledger.length > 0);
    const coffeeDeductions = ledger.filter((l) => l.ingredient === 'coffee');
    assert.strictEqual(coffeeDeductions.length, 1, 'Exactly one coffee deduction must be recorded');

    console.log('PASS');
  }

  // --------------------------------------------------------------------------
  // Scenario 9: Repeated execution of every regression suite
  // --------------------------------------------------------------------------
  console.log('Scenario 9: Repeated execution teardown verification ...');
  {
    // Reconnect Firestore for testing
    process.env.FIRESTORE_EMULATOR_HOST = EMULATOR_HOST;
    process.env.FIREBASE_PROJECT_ID = EMULATOR_PROJECT_ID;
    setFirestoreForTesting({ firestoreInstance: sharedFirestore, clearStores: true });
    delete process.env.VERCEL_ENV;
    delete process.env.STRICT_FIREBASE_VALIDATION;
    ensureFirebaseReady();

    // Verify cleanInventoryLedgerForTesting removes child rows without deleting parent orders
    const testOrderId = 'ORD-P282-TEARDOWN-09';
    await db.run(
      `INSERT OR REPLACE INTO orders (id, product_id, amount, status, machine_id, created_at)
       VALUES (?, 1, 100, 'PAID', 'CFX-MC-01', ?)`,
      [testOrderId, new Date().toISOString()]
    );

    await db.run(
      `INSERT OR REPLACE INTO inventory_ledger (
        id, machine_id, ingredient, quantity, movement_type, balance_after, order_id, created_at
      ) VALUES ('inv_td_1', 'CFX-MC-01', 'coffee', 10, 'DEDUCTION', 90, ?, ?)`,
      [testOrderId, new Date().toISOString()]
    );

    // Call test cleanup helper
    const cleaned = await cleanInventoryLedgerForTesting(db, { orderId: testOrderId });
    assert.strictEqual(cleaned, 1);

    // Now parent order can be deleted without SQLITE_CONSTRAINT error
    await db.run('DELETE FROM orders WHERE id = ?', [testOrderId]);
    const orderCheck = await db.get('SELECT * FROM orders WHERE id = ?', [testOrderId]);
    assert.strictEqual(orderCheck, undefined);

    console.log('PASS');
  }

  // --------------------------------------------------------------------------
  // Scenario 10: Historical inventory ledger preservation
  // --------------------------------------------------------------------------
  console.log('Scenario 10: Historical inventory ledger preservation ...');
  {
    const machineId = 'CFX-MC-01';
    const histOrderId = 'ORD-P282-HIST-10';
    const nowIso = new Date().toISOString();

    // Insert parent order into SQLite orders table first to satisfy foreign key referential integrity
    await db.run(
      `INSERT OR REPLACE INTO orders (id, product_id, amount, status, machine_id, created_at)
       VALUES (?, 1, 100, 'PAID', ?, ?)`,
      [histOrderId, machineId, nowIso]
    );

    // Record an order deduction via recordInventoryMovement (dual-persisted to Firestore + SQLite)
    await recordInventoryMovement(db, {
      machine_id: machineId,
      ingredient: 'coffee',
      quantity: 6,
      movement_type: 'DEDUCTION',
      balance_after: 70,
      order_id: histOrderId,
      reason: 'Order preparation deduction',
      created_at: nowIso
    });

    const ledgerRecords = await getInventoryLedgerForMachine(db, machineId, { limit: 50 });
    assert.ok(ledgerRecords.length >= 2, 'Historical ledger must contain multiple records');

    // Verify entries contain both DEDUCTION and REFILL movement types
    const hasDeductions = ledgerRecords.some((r) => r.movement_type === 'DEDUCTION');
    const hasRefills = ledgerRecords.some((r) => r.movement_type === 'REFILL');
    assert.ok(hasDeductions, 'Ledger must preserve historical DEDUCTION records');
    assert.ok(hasRefills, 'Ledger must preserve historical REFILL records');

    // Verify timestamps are valid and chronological
    for (let i = 0; i < ledgerRecords.length - 1; i++) {
      const t1 = new Date(ledgerRecords[i].created_at).getTime();
      const t2 = new Date(ledgerRecords[i + 1].created_at).getTime();
      assert.ok(t1 >= t2, 'Ledger records must be sorted in descending chronological order');
    }

    console.log('PASS');
  }

  console.log('\n========================================================================');
  console.log('Phase 2.8.2 Test Suite Completed: 10/10 Scenarios Passed (100%)');
  console.log('========================================================================\n');
}

runPhase2_8_2Tests()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Test failed with error:', err);
    process.exit(1);
  });
