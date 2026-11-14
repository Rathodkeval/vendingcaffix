import crypto from 'crypto';
import { getFirestoreInstance, isFirestoreActive } from './firebase';
import logger from './logger';
import { IngredientRequirements } from './inventory';

export type InventoryMovementType = 'DEDUCTION' | 'REFILL' | 'ADJUSTMENT' | 'WASTE';

export interface InventoryMovementRecord {
  id: string;
  machine_id: string;
  ingredient: string;
  quantity: number;
  movement_type: InventoryMovementType;
  balance_after: number;
  order_id?: string | null;
  refund_id?: string | null;
  reason?: string | null;
  idempotency_key?: string | null;
  created_at: string;
}

export interface RecordMovementInput {
  machine_id: string;
  ingredient: string;
  quantity: number;
  movement_type: InventoryMovementType;
  balance_after: number;
  order_id?: string | null;
  refund_id?: string | null;
  reason?: string | null;
  idempotency_key?: string | null;
  created_at?: string;
}

/**
 * Creates the SQLite schema for the auditable inventory ledger.
 */
export async function initializeInventoryLedgerSchema(db: any): Promise<void> {
  if (!db || !db.exec) return;

  await db.exec(`
    CREATE TABLE IF NOT EXISTS inventory_ledger (
      id TEXT PRIMARY KEY,
      machine_id TEXT NOT NULL,
      ingredient TEXT NOT NULL,
      quantity INTEGER NOT NULL,
      movement_type TEXT NOT NULL CHECK(movement_type IN ('DEDUCTION', 'REFILL', 'ADJUSTMENT', 'WASTE')),
      balance_after INTEGER NOT NULL,
      order_id TEXT,
      refund_id TEXT,
      reason TEXT,
      idempotency_key TEXT UNIQUE,
      created_at TEXT NOT NULL,
      FOREIGN KEY (machine_id) REFERENCES machines(id),
      FOREIGN KEY (order_id) REFERENCES orders(id)
    )
  `);

  await db.exec(`
    CREATE INDEX IF NOT EXISTS idx_inventory_ledger_machine_id ON inventory_ledger(machine_id);
    CREATE INDEX IF NOT EXISTS idx_inventory_ledger_order_id ON inventory_ledger(order_id);
    CREATE INDEX IF NOT EXISTS idx_inventory_ledger_idempotency_key ON inventory_ledger(idempotency_key);
    CREATE INDEX IF NOT EXISTS idx_inventory_ledger_created_at ON inventory_ledger(created_at);
    CREATE INDEX IF NOT EXISTS idx_inventory_ledger_analytics ON inventory_ledger(machine_id, movement_type, created_at);
  `);

  await db.exec(`
    CREATE TABLE IF NOT EXISTS refill_idempotency (
      idempotency_key TEXT PRIMARY KEY,
      machine_id TEXT NOT NULL,
      ingredient TEXT NOT NULL,
      quantity INTEGER,
      target INTEGER,
      created_at TEXT NOT NULL
    )
  `);

  await db.exec(`
    CREATE INDEX IF NOT EXISTS idx_refill_idempotency_machine_id ON refill_idempotency(machine_id);
  `);
}

/**
 * Records an inventory movement into SQLite and (optionally) Firestore.
 * Guaranteed idempotent if idempotency_key is provided.
 */
export async function recordInventoryMovement(
  db: any,
  input: RecordMovementInput
): Promise<InventoryMovementRecord> {
  const nowIso = input.created_at || new Date().toISOString();
  const movementId = `inv_mov_${crypto.randomUUID()}`;
  const movement: InventoryMovementRecord = {
    id: movementId,
    machine_id: input.machine_id,
    ingredient: input.ingredient,
    quantity: Math.max(0, Math.round(input.quantity)),
    movement_type: input.movement_type,
    balance_after: Math.max(0, Math.round(input.balance_after)),
    order_id: input.order_id || null,
    refund_id: input.refund_id || null,
    reason: input.reason || null,
    idempotency_key: input.idempotency_key || null,
    created_at: nowIso
  };

  if (db && db.run) {
    try {
      if (movement.idempotency_key) {
        const existing = await db.get(
          'SELECT * FROM inventory_ledger WHERE idempotency_key = ?',
          [movement.idempotency_key]
        );
        if (existing) {
          return existing;
        }
      }

      await db.run(
        `INSERT INTO inventory_ledger (
          id, machine_id, ingredient, quantity, movement_type,
          balance_after, order_id, refund_id, reason, idempotency_key, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          movement.id,
          movement.machine_id,
          movement.ingredient,
          movement.quantity,
          movement.movement_type,
          movement.balance_after,
          movement.order_id,
          movement.refund_id,
          movement.reason,
          movement.idempotency_key,
          movement.created_at
        ]
      );
    } catch (err: any) {
      // If unique constraint violated on idempotency_key, fetch and return existing
      if (err.message && err.message.includes('UNIQUE constraint failed') && movement.idempotency_key) {
        const existing = await db.get(
          'SELECT * FROM inventory_ledger WHERE idempotency_key = ?',
          [movement.idempotency_key]
        );
        if (existing) return existing;
      }
      logger.error('Failed to insert inventory movement into SQLite:', err);
      throw err;
    }
  }

  // Dual sync to Firestore if active and not already in a transaction
  if (isFirestoreActive()) {
    try {
      const firestore = getFirestoreInstance()!;
      const rootDocRef = firestore.collection('inventory_ledger').doc(movement.id);
      const subDocRef = firestore
        .collection('machines')
        .doc(movement.machine_id)
        .collection('inventory_ledger')
        .doc(movement.id);

      const batch = firestore.batch();
      batch.set(rootDocRef, movement, { merge: true });
      batch.set(subDocRef, movement, { merge: true });
      await batch.commit();
    } catch (fsErr) {
      logger.warn(`Failed to mirror inventory ledger ${movement.id} to Firestore:`, fsErr);
    }
  }

  return movement;
}

/**
 * Transaction-safe writer for Firestore transactions.
 * Called inside commitOrderTransitionInFirebase to guarantee atomicity.
 */
export function recordInventoryMovementInFirestoreTx(
  tx: FirebaseFirestore.Transaction,
  firestore: FirebaseFirestore.Firestore,
  input: RecordMovementInput
): InventoryMovementRecord {
  const nowIso = input.created_at || new Date().toISOString();
  const movementId = input.idempotency_key
    ? `inv_mov_${input.idempotency_key.replace(/[^a-zA-Z0-9_-]/g, '_')}`
    : `inv_mov_${crypto.randomUUID()}`;

  const movement: InventoryMovementRecord = {
    id: movementId,
    machine_id: input.machine_id,
    ingredient: input.ingredient,
    quantity: Math.max(0, Math.round(input.quantity)),
    movement_type: input.movement_type,
    balance_after: Math.max(0, Math.round(input.balance_after)),
    order_id: input.order_id || null,
    refund_id: input.refund_id || null,
    reason: input.reason || null,
    idempotency_key: input.idempotency_key || null,
    created_at: nowIso
  };

  const rootDocRef = firestore.collection('inventory_ledger').doc(movement.id);
  const subDocRef = firestore
    .collection('machines')
    .doc(movement.machine_id)
    .collection('inventory_ledger')
    .doc(movement.id);

  tx.set(rootDocRef, movement, { merge: true });
  tx.set(subDocRef, movement, { merge: true });

  return movement;
}

/**
 * Records all ingredient deductions for an order atomically into the ledger.
 * Uses idempotency keys formatted as `order_${orderId}_deduct_${ingredient}`.
 */
export async function recordOrderDeductionsToLedger(
  db: any,
  params: {
    orderId: string;
    machineId: string;
    requirements: IngredientRequirements;
    remainingLevels: Record<string, number>;
    createdAt?: string;
  }
): Promise<InventoryMovementRecord[]> {
  const { orderId, machineId, requirements, remainingLevels, createdAt } = params;
  const nowIso = createdAt || new Date().toISOString();
  const records: InventoryMovementRecord[] = [];

  const ingredientMap: Array<{ name: keyof IngredientRequirements; key: string }> = [
    { name: 'coffee', key: 'coffee_level' },
    { name: 'milk', key: 'milk_level' },
    { name: 'water', key: 'water_level' },
    { name: 'vanilla', key: 'vanilla_level' },
    { name: 'hazelnut', key: 'hazelnut_level' },
    { name: 'irish', key: 'irish_level' },
    { name: 'mocha', key: 'mocha_level' }
  ];

  for (const item of ingredientMap) {
    const qty = requirements[item.name];
    if (typeof qty === 'number' && qty > 0) {
      const balanceAfter = remainingLevels[item.key] ?? 0;
      const idempotencyKey = `order_${orderId}_deduct_${String(item.name)}`;

      const record = await recordInventoryMovement(db, {
        machine_id: machineId,
        ingredient: String(item.name),
        quantity: qty,
        movement_type: 'DEDUCTION',
        balance_after: balanceAfter,
        order_id: orderId,
        reason: `Order ${orderId} preparation deduction`,
        idempotency_key: idempotencyKey,
        created_at: nowIso
      });
      records.push(record);
    }
  }

  return records;
}

/**
 * Fetches the inventory ledger for a specific machine.
 */
export async function getInventoryLedgerForMachine(
  db: any,
  machineId: string,
  options?: { limit?: number; offset?: number }
): Promise<InventoryMovementRecord[]> {
  const limit = options?.limit || 100;
  const offset = options?.offset || 0;

  if (isFirestoreActive()) {
    const firestore = getFirestoreInstance()!;
    const snap = await firestore
      .collection('machines')
      .doc(machineId)
      .collection('inventory_ledger')
      .orderBy('created_at', 'desc')
      .limit(limit)
      .get();

    if (!snap.empty) {
      const records = snap.docs.map((d) => d.data() as InventoryMovementRecord);
      if (db && db.run) {
        for (const r of records) {
          await db.run(
            `INSERT OR IGNORE INTO inventory_ledger (
              id, machine_id, ingredient, quantity, movement_type,
              balance_after, order_id, refund_id, reason, idempotency_key, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              r.id,
              r.machine_id,
              r.ingredient,
              r.quantity,
              r.movement_type,
              r.balance_after,
              r.order_id || null,
              r.refund_id || null,
              r.reason || null,
              r.idempotency_key || null,
              r.created_at
            ]
          ).catch(() => {});
        }
      }
      return records;
    }
  }

  if (db && db.all) {
    return await db.all(
      `SELECT * FROM inventory_ledger 
       WHERE machine_id = ? 
       ORDER BY created_at DESC 
       LIMIT ? OFFSET ?`,
      [machineId, limit, offset]
    );
  }

  return [];
}

/**
 * Fetches all inventory ledger entries associated with a specific order.
 */
export async function getInventoryLedgerForOrder(
  db: any,
  orderId: string
): Promise<InventoryMovementRecord[]> {
  if (isFirestoreActive()) {
    const firestore = getFirestoreInstance()!;
    const snap = await firestore
      .collection('inventory_ledger')
      .where('order_id', '==', orderId)
      .get();

    if (!snap.empty) {
      const records = snap.docs.map((d) => d.data() as InventoryMovementRecord);
      if (db && db.run) {
        for (const r of records) {
          await db.run(
            `INSERT OR IGNORE INTO inventory_ledger (
              id, machine_id, ingredient, quantity, movement_type,
              balance_after, order_id, refund_id, reason, idempotency_key, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              r.id,
              r.machine_id,
              r.ingredient,
              r.quantity,
              r.movement_type,
              r.balance_after,
              r.order_id || null,
              r.refund_id || null,
              r.reason || null,
              r.idempotency_key || null,
              r.created_at
            ]
          ).catch(() => {});
        }
      }
      return records;
    }
  }

  if (db && db.all) {
    return await db.all(
      `SELECT * FROM inventory_ledger WHERE order_id = ? ORDER BY created_at ASC`,
      [orderId]
    );
  }

  return [];
}

/**
 * Test fixture cleanup helper.
 * Removes inventory_ledger child rows for specific test orders or test machines before teardown.
 * Strictly restricted to test environments.
 */
export async function cleanInventoryLedgerForTesting(
  db: any,
  options: { orderId?: string; orderIdPrefix?: string; machineId?: string; idempotencyKey?: string; idempotencyKeyPrefix?: string }
): Promise<number> {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('cleanInventoryLedgerForTesting is restricted to test environments');
  }
  if (!db || !db.run) return 0;
  let totalCleaned = 0;
  if (options.orderId) {
    const res = await db.run('DELETE FROM inventory_ledger WHERE order_id = ?', [options.orderId]);
    totalCleaned += res?.changes ?? 0;
  }
  if (options.orderIdPrefix) {
    const res = await db.run('DELETE FROM inventory_ledger WHERE order_id LIKE ?', [`${options.orderIdPrefix}%`]);
    totalCleaned += res?.changes ?? 0;
  }
  if (options.machineId) {
    const res = await db.run('DELETE FROM inventory_ledger WHERE machine_id = ?', [options.machineId]);
    totalCleaned += res?.changes ?? 0;
    await db.run('DELETE FROM refill_idempotency WHERE machine_id = ?', [options.machineId]).catch(() => {});
  }
  if (options.idempotencyKey) {
    await db.run('DELETE FROM refill_idempotency WHERE idempotency_key = ?', [options.idempotencyKey]).catch(() => {});
  }
  if (options.idempotencyKeyPrefix) {
    await db.run('DELETE FROM refill_idempotency WHERE idempotency_key LIKE ?', [`${options.idempotencyKeyPrefix}%`]).catch(() => {});
  }
  return totalCleaned;
}

