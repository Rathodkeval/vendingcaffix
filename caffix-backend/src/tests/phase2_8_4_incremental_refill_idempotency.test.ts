/**
 * CAFFIX Phase 2.8.4 — Incremental Refill Idempotency Hardening Test Suite
 *
 * Validates Phase 2.8.3 audit finding W-1:
 * 1. Incremental refill without Idempotency-Key returns HTTP 400.
 * 2. Incremental refill with a valid key succeeds.
 * 3. Replaying the same request with the same key does not add stock twice.
 * 4. Concurrent duplicate requests with the same key create only one movement.
 * 5. Reusing a key with a different quantity is rejected.
 * 6. Reusing a key with a different ingredient or machine is rejected.
 * 7. Target-level refill without a key continues to work.
 * 8. SQLite rollback remains correct.
 * 9. Firestore Emulator atomicity and deduplication remain correct.
 */

process.env.NODE_ENV = 'test';
process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8088';
process.env.FIREBASE_PROJECT_ID = 'demo-caffix-emulator';

import assert from 'assert';
import http from 'http';
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
  cleanInventoryLedgerForTesting,
  getInventoryLedgerForMachine,
  initializeInventoryLedgerSchema
} from '../utils/inventoryLedger';
import { refillMachineInventory } from '../controllers/machineController';
import { BadRequestError, ConflictError } from '../utils/errors';

let sharedFirestore: any = null;

function checkEmulatorReachable(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get(`http://${host}:${port}`, (res) => {
      resolve(res.statusCode === 200 || res.statusCode === 404);
    });
    req.on('error', () => resolve(false));
    req.setTimeout(1500, () => {
      req.destroy();
      resolve(false);
    });
  });
}

function mockResponse() {
  const res: any = {
    statusCode: 200,
    headers: {} as Record<string, string>,
    body: null as any
  };
  res.status = function (code: number) {
    res.statusCode = code;
    return res;
  };
  res.json = function (payload: any) {
    res.body = payload;
    return res;
  };
  res.setHeader = function (name: string, val: string) {
    res.headers[name] = val;
    return res;
  };
  return res;
}

async function runPhase284Tests() {
  console.log('========================================================================');
  console.log('Running CAFFIX Phase 2.8.4 — Incremental Refill Idempotency Tests');
  console.log(`Target Emulator Host: http://${process.env.FIRESTORE_EMULATOR_HOST}`);
  console.log(`Isolated Project ID: ${process.env.FIREBASE_PROJECT_ID}`);
  console.log('========================================================================\n');

  const emulatorLive = await checkEmulatorReachable('127.0.0.1', 8088);
  if (!emulatorLive) {
    console.error('FATAL: Official Google Cloud Firestore Emulator is not reachable at 127.0.0.1:8088');
    process.exit(1);
  }
  console.log('PASS: Official Google Cloud Firestore Emulator is live and reachable.\n');

  const existingApps = getApps();
  for (const a of existingApps) {
    await deleteApp(a);
  }
  const app = initializeApp({ projectId: process.env.FIREBASE_PROJECT_ID });
  sharedFirestore = getFirestore(app);
  setFirestoreForTesting({ firestoreInstance: sharedFirestore });
  ensureFirebaseReady();

  const db = await initDB();
  await initializeInventoryLedgerSchema(db);

  await db.run("DELETE FROM inventory_ledger WHERE id = 'colliding_id'").catch(() => {});
  await cleanInventoryLedgerForTesting(db, { machineId: 'CFX-MC-01' });
  await cleanInventoryLedgerForTesting(db, { machineId: 'CFX-MC-02' });

  // Ensure machines are set to RUNNING and online
  await db.run(
    `UPDATE machines SET desired_mode = 'RUNNING', status = 'online' WHERE id IN ('CFX-MC-01', 'CFX-MC-02')`
  );

  await db.run(
    `UPDATE inventory SET milk_level = 50, coffee_level = 40, vanilla_level = 60, hazelnut_level = 70, irish_level = 80, mocha_level = 90, water_level = 85, updated_at = datetime('now') WHERE machine_id IN ('CFX-MC-01', 'CFX-MC-02')`
  );

  const firestore = getFirestoreInstance()!;
  await firestore.collection('machines').doc('CFX-MC-01').set({
    id: 'CFX-MC-01',
    name: 'Flagship Alpha',
    location: 'HQ Lobby',
    desired_mode: 'RUNNING',
    estimated_inventory: {
      milk_level: 50,
      coffee_level: 40,
      vanilla_level: 60,
      hazelnut_level: 70,
      irish_level: 80,
      mocha_level: 90,
      water_level: 85
    },
    inventory_source: 'software_estimated',
    updated_at: new Date().toISOString()
  }, { merge: true });

  await firestore.collection('machines').doc('CFX-MC-02').set({
    id: 'CFX-MC-02',
    name: 'Express Beta',
    location: 'Airport T3',
    desired_mode: 'RUNNING',
    estimated_inventory: {
      milk_level: 50,
      coffee_level: 40,
      vanilla_level: 60,
      hazelnut_level: 70,
      irish_level: 80,
      mocha_level: 90,
      water_level: 85
    },
    inventory_source: 'software_estimated',
    updated_at: new Date().toISOString()
  }, { merge: true });

  // --------------------------------------------------------------------------
  // Scenario 1: Incremental refill without Idempotency-Key returns HTTP 400
  // --------------------------------------------------------------------------
  console.log('Scenario 1: Incremental refill without Idempotency-Key returns HTTP 400 ...');
  {
    const req: any = {
      params: { machine_id: 'CFX-MC-01' },
      headers: {}, // Omitted Idempotency-Key header
      body: { ingredient: 'coffee', quantity: 20 },
      user: { role: 'admin', email: 'admin@caffix.com' }
    };
    const res = mockResponse();
    let capturedError: any = null;

    await refillMachineInventory(req, res, (err) => {
      capturedError = err;
    });

    assert.ok(capturedError, 'Expected BadRequestError when Idempotency-Key is missing');
    assert.strictEqual(capturedError.statusCode, 400);
    assert.ok(
      capturedError.message.includes('Idempotency-Key'),
      `Error message must mention Idempotency-Key: ${capturedError.message}`
    );
    console.log('PASS');
  }

  // --------------------------------------------------------------------------
  // Scenario 2: Incremental refill with a valid key succeeds
  // --------------------------------------------------------------------------
  console.log('Scenario 2: Incremental refill with a valid key succeeds ...');
  {
    const idemKey = `idem_valid_${Date.now()}`;
    const req: any = {
      params: { machine_id: 'CFX-MC-01' },
      headers: { 'idempotency-key': idemKey },
      body: { ingredient: 'coffee', quantity: 25, reason: 'Test incremental top-up' },
      user: { role: 'admin', email: 'admin@caffix.com' }
    };
    const res = mockResponse();
    let capturedError: any = null;

    await refillMachineInventory(req, res, (err) => {
      capturedError = err;
    });

    assert.ifError(capturedError);
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.deduplicated, false);
    assert.strictEqual(res.body.refilled_movements.length, 1);
    assert.strictEqual(res.body.refilled_movements[0].ingredient, 'coffee');
    assert.strictEqual(res.body.refilled_movements[0].quantity, 25);
    assert.strictEqual(res.body.refilled_movements[0].balance_after, 65); // 40 + 25 = 65
    assert.strictEqual(res.body.data.coffee_level, 65);

    // Verify written to refill_idempotency
    const snap = await firestore.collection('refill_idempotency').doc(idemKey).get();
    assert.ok(snap.exists, 'refill_idempotency record must be stored in Firestore');
    const data = snap.data()!;
    assert.strictEqual(data.idempotency_key, idemKey);
    assert.strictEqual(data.machine_id, 'CFX-MC-01');
    assert.strictEqual(data.ingredient, 'coffee');
    assert.strictEqual(data.quantity, 25);
    console.log('PASS');
  }

  // --------------------------------------------------------------------------
  // Scenario 3: Replaying the same request with the same key does not add stock twice
  // --------------------------------------------------------------------------
  console.log('Scenario 3: Replaying the same request with the same key does not add stock twice ...');
  {
    const idemKey = `idem_replay_${Date.now()}`;
    const req1: any = {
      params: { machine_id: 'CFX-MC-01' },
      headers: { 'idempotency-key': idemKey },
      body: { ingredient: 'milk', quantity: 20 },
      user: { role: 'admin', email: 'admin@caffix.com' }
    };
    const res1 = mockResponse();
    await refillMachineInventory(req1, res1, (err) => { if (err) throw err; });
    assert.strictEqual(res1.statusCode, 200);
    assert.strictEqual(res1.body.deduplicated, false);
    assert.strictEqual(res1.body.data.milk_level, 70); // 50 + 20 = 70

    // Duplicate replay with identical key and parameters
    const req2: any = {
      params: { machine_id: 'CFX-MC-01' },
      headers: { 'idempotency-key': idemKey },
      body: { ingredient: 'milk', quantity: 20 },
      user: { role: 'admin', email: 'admin@caffix.com' }
    };
    const res2 = mockResponse();
    await refillMachineInventory(req2, res2, (err) => { if (err) throw err; });
    assert.strictEqual(res2.statusCode, 200);
    assert.strictEqual(res2.body.deduplicated, true);
    assert.strictEqual(res2.body.refilled_movements.length, 0, 'Replay must not record movements');
    assert.strictEqual(res2.body.data.milk_level, 70, 'Milk level must remain 70 and not increase to 90');
    console.log('PASS');
  }

  // --------------------------------------------------------------------------
  // Scenario 4: Concurrent duplicate requests with the same key create only one movement
  // --------------------------------------------------------------------------
  console.log('Scenario 4: Concurrent duplicate requests with the same key create only one movement ...');
  {
    const idemKey = `idem_conc_${Date.now()}`;
    const makeReq = (): any => ({
      params: { machine_id: 'CFX-MC-01' },
      headers: { 'idempotency-key': idemKey },
      body: { ingredient: 'vanilla', quantity: 15 },
      user: { role: 'admin', email: 'admin@caffix.com' }
    });

    const resA = mockResponse();
    const resB = mockResponse();

    await Promise.all([
      refillMachineInventory(makeReq(), resA, () => {}),
      refillMachineInventory(makeReq(), resB, () => {})
    ]);

    const deduplicatedResults = [resA.body?.deduplicated, resB.body?.deduplicated];
    assert.ok(
      deduplicatedResults.includes(true),
      'At least one of the concurrent requests must be deduplicated'
    );

    // Stock should be 60 + 15 = 75, NOT 60 + 15 + 15 = 90
    const inv = await db.get('SELECT vanilla_level FROM inventory WHERE machine_id = ?', ['CFX-MC-01']);
    assert.strictEqual(Number(inv.vanilla_level), 75, 'Vanilla stock must increase by exactly 15');

    // Query ledger
    const ledger = await getInventoryLedgerForMachine(db, 'CFX-MC-01');
    const vanillaMoves = ledger.filter(
      (m) => m.ingredient === 'vanilla' && m.idempotency_key?.includes(idemKey)
    );
    assert.strictEqual(vanillaMoves.length, 1, 'Exactly one ledger movement must be recorded');
    console.log('PASS');
  }

  // --------------------------------------------------------------------------
  // Scenario 5: Reusing a key with a different quantity is rejected
  // --------------------------------------------------------------------------
  console.log('Scenario 5: Reusing a key with a different quantity is rejected ...');
  {
    const idemKey = `idem_diff_qty_${Date.now()}`;
    const req1: any = {
      params: { machine_id: 'CFX-MC-01' },
      headers: { 'idempotency-key': idemKey },
      body: { ingredient: 'hazelnut', quantity: 10 },
      user: { role: 'admin', email: 'admin@caffix.com' }
    };
    const res1 = mockResponse();
    await refillMachineInventory(req1, res1, (err) => { if (err) throw err; });
    assert.strictEqual(res1.statusCode, 200);

    // Attempt reuse with quantity: 20
    const req2: any = {
      params: { machine_id: 'CFX-MC-01' },
      headers: { 'idempotency-key': idemKey },
      body: { ingredient: 'hazelnut', quantity: 20 },
      user: { role: 'admin', email: 'admin@caffix.com' }
    };
    const res2 = mockResponse();
    let capturedErr: any = null;
    await refillMachineInventory(req2, res2, (err) => {
      capturedErr = err;
    });

    assert.ok(capturedErr, 'Expected rejection when key is reused with different quantity');
    assert.strictEqual(capturedErr.statusCode, 409);
    assert.ok(
      capturedErr.message.includes('quantity'),
      `Error must describe quantity mismatch: ${capturedErr.message}`
    );
    console.log('PASS');
  }

  // --------------------------------------------------------------------------
  // Scenario 6: Reusing a key with a different ingredient or machine is rejected
  // --------------------------------------------------------------------------
  console.log('Scenario 6: Reusing a key with a different ingredient or machine is rejected ...');
  {
    // Part A: Different ingredient
    const idemKeyA = `idem_diff_ing_${Date.now()}`;
    const req1: any = {
      params: { machine_id: 'CFX-MC-01' },
      headers: { 'idempotency-key': idemKeyA },
      body: { ingredient: 'irish', quantity: 5 },
      user: { role: 'admin', email: 'admin@caffix.com' }
    };
    const res1 = mockResponse();
    await refillMachineInventory(req1, res1, (err) => { if (err) throw err; });
    assert.strictEqual(res1.statusCode, 200);

    const req2: any = {
      params: { machine_id: 'CFX-MC-01' },
      headers: { 'idempotency-key': idemKeyA },
      body: { ingredient: 'mocha', quantity: 5 },
      user: { role: 'admin', email: 'admin@caffix.com' }
    };
    const res2 = mockResponse();
    let errA: any = null;
    await refillMachineInventory(req2, res2, (err) => { errA = err; });
    assert.ok(errA, 'Expected error on ingredient mismatch');
    assert.strictEqual(errA.statusCode, 409);
    assert.ok(errA.message.includes('ingredient'));

    // Part B: Different machine
    const idemKeyB = `idem_diff_mc_${Date.now()}`;
    const req3: any = {
      params: { machine_id: 'CFX-MC-01' },
      headers: { 'idempotency-key': idemKeyB },
      body: { ingredient: 'mocha', quantity: 5 },
      user: { role: 'admin', email: 'admin@caffix.com' }
    };
    const res3 = mockResponse();
    await refillMachineInventory(req3, res3, (err) => { if (err) throw err; });
    assert.strictEqual(res3.statusCode, 200);

    const req4: any = {
      params: { machine_id: 'CFX-MC-02' },
      headers: { 'idempotency-key': idemKeyB },
      body: { ingredient: 'mocha', quantity: 5 },
      user: { role: 'admin', email: 'admin@caffix.com' }
    };
    const res4 = mockResponse();
    let errB: any = null;
    await refillMachineInventory(req4, res4, (err) => { errB = err; });
    assert.ok(errB, 'Expected error on machine mismatch');
    assert.strictEqual(errB.statusCode, 409);
    assert.ok(errB.message.includes('machine'));
    console.log('PASS');
  }

  // --------------------------------------------------------------------------
  // Scenario 7: Target-level refill without a key continues to work
  // --------------------------------------------------------------------------
  console.log('Scenario 7: Target-level refill without a key continues to work ...');
  {
    // Deplete water to 50
    await db.run('UPDATE inventory SET water_level = 50 WHERE machine_id = ?', ['CFX-MC-01']);
    await firestore.collection('machines').doc('CFX-MC-01').set(
      { estimated_inventory: { water_level: 50 } },
      { merge: true }
    );

    const req: any = {
      params: { machine_id: 'CFX-MC-01' },
      headers: {}, // No key
      body: { ingredient: 'water', target: 95 },
      user: { role: 'admin', email: 'admin@caffix.com' }
    };
    const res = mockResponse();
    await refillMachineInventory(req, res, (err) => { if (err) throw err; });

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.deduplicated, false);
    assert.strictEqual(res.body.refilled_movements.length, 1);
    assert.strictEqual(res.body.refilled_movements[0].quantity, 45); // 95 - 50 = 45
    assert.strictEqual(res.body.refilled_movements[0].balance_after, 95);
    console.log('PASS');
  }

  // --------------------------------------------------------------------------
  // Scenario 8: SQLite rollback remains correct
  // --------------------------------------------------------------------------
  console.log('Scenario 8: SQLite rollback remains correct ...');
  {
    // Temporarily deactivate Firestore to test offline SQLite path
    const savedHost = process.env.FIRESTORE_EMULATOR_HOST;
    const savedProj = process.env.FIREBASE_PROJECT_ID;
    delete process.env.FIRESTORE_EMULATOR_HOST;
    delete process.env.FIREBASE_PROJECT_ID;
    setFirestoreForTesting({ firestoreInstance: null, clearStores: true });

    const rollbackKey = `idem_sqlite_rollback_${Date.now()}`;
    await db.run('UPDATE inventory SET coffee_level = 50 WHERE machine_id = ?', ['CFX-MC-02']);

    // Clean up any previous test artifacts
    await db.run("DELETE FROM inventory_ledger WHERE id = 'colliding_id'").catch(() => {});

    // Pre-insert a duplicate collision in inventory_ledger with the exact item key to force SQLITE_CONSTRAINT
    const targetItemKey = `refill_CFX-MC-02_coffee_${rollbackKey}`;
    await db.run(
      `INSERT INTO inventory_ledger (
        id, machine_id, ingredient, quantity, movement_type, balance_after, idempotency_key, created_at
      ) VALUES ('colliding_id', 'CFX-MC-02', 'coffee', 10, 'REFILL', 60, ?, datetime('now'))`,
      [targetItemKey]
    );

    const req: any = {
      params: { machine_id: 'CFX-MC-02' },
      headers: { 'idempotency-key': rollbackKey },
      body: { ingredient: 'coffee', quantity: 20 },
      user: { role: 'admin', email: 'admin@caffix.com' }
    };
    const res = mockResponse();
    let errorCaught: any = null;

    await refillMachineInventory(req, res, (err) => {
      errorCaught = err;
    });

    assert.ok(errorCaught, 'Expected transaction error on unique constraint collision');
    // Verify inventory level was rolled back and remains 50
    const inv = await db.get('SELECT coffee_level FROM inventory WHERE machine_id = ?', ['CFX-MC-02']);
    assert.strictEqual(Number(inv.coffee_level), 50, 'Coffee level must be 50 after rollback');

    // Clean up injected collision
    await db.run('DELETE FROM inventory_ledger WHERE id = ?', ['colliding_id']);

    // Restore Firestore environment
    process.env.FIRESTORE_EMULATOR_HOST = savedHost;
    process.env.FIREBASE_PROJECT_ID = savedProj;
    setFirestoreForTesting({ firestoreInstance: sharedFirestore });
    console.log('PASS');
  }

  // --------------------------------------------------------------------------
  // Scenario 9: Firestore Emulator atomicity and deduplication remain correct
  // --------------------------------------------------------------------------
  console.log('Scenario 9: Firestore Emulator atomicity and deduplication remain correct ...');
  {
    const fsKey = `idem_fs_atomic_${Date.now()}`;
    const req: any = {
      params: { machine_id: 'CFX-MC-01' },
      headers: { 'idempotency-key': fsKey },
      body: { ingredient: 'ALL', target: 100 },
      user: { role: 'admin', email: 'admin@caffix.com' }
    };
    const res = mockResponse();
    await refillMachineInventory(req, res, (err) => { if (err) throw err; });
    assert.strictEqual(res.statusCode, 200);

    // Verify written to Firestore collections
    const idemSnap = await firestore.collection('refill_idempotency').doc(fsKey).get();
    assert.ok(idemSnap.exists, 'refill_idempotency doc must exist in Firestore');
    assert.strictEqual(idemSnap.data()?.ingredient, 'ALL');

    // Replay with exact same key
    const replayRes = mockResponse();
    await refillMachineInventory(req, replayRes, (err) => { if (err) throw err; });
    assert.strictEqual(replayRes.statusCode, 200);
    assert.strictEqual(replayRes.body.deduplicated, true);
    assert.strictEqual(replayRes.body.refilled_movements.length, 0);
    console.log('PASS');
  }

  console.log('\n========================================================================');
  console.log('Phase 2.8.4 Test Suite Completed: 9/9 Scenarios Passed (100%)');
  console.log('========================================================================\n');
}

runPhase284Tests().catch((err) => {
  console.error('Test Suite Failed:', err);
  process.exit(1);
});
