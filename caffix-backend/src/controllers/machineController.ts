import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { getDB } from '../config/db';
import { AuthRequest, assertMachineOwnershipOrAdmin } from '../middleware/auth';
import { NotFoundError, BadRequestError, ForbiddenError, ConflictError } from '../utils/errors';
import {
  syncMachineToFirebase,
  updateMachineDesiredModeInFirebase,
  updateMachineHeartbeatInFirebase,
  updateMachineInventoryInFirebase,
  updateMachineOwnerInFirebase,
  updateMachineProductInFirebase,
  getAuthoritativeMachineState,
  getAuthoritativeMachinesList,
  getAuthoritativeMachineProducts,
  getAuthoritativeMachineProduct,
  getAuthoritativeUserById,
  normalizeDesiredMode,
  desiredModeToLegacyStatus,
  computeConnectionStatus,
  isFirestoreActive,
  getFirestoreInstance
} from '../utils/firebase';
import { ensureMachineRegisteredInLocalDB } from './kioskController';
import { setNoStoreHeaders } from '../utils/cache';
import logger from '../utils/logger';

export const getMachines = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  const db = getDB();
  try {
    const machines = await getAuthoritativeMachinesList(db);

    const visibleMachines =
      req.user?.role === 'admin'
        ? machines
        : req.user?.role === 'owner'
        ? machines.filter(
            (m) => m.owner_id && String(m.owner_id).trim() === String(req.user!.id).trim()
          )
        : [];

    const formatted = visibleMachines.map((m) => ({
      id: m.id,
      machine_name: m.machine_name,
      location: m.location,
      desired_mode: m.desired_mode,
      connection_status: m.connection_status,
      status: m.status,
      last_seen: m.last_seen,
      owner_id: m.owner_id ?? null,
      inventory_source: 'software_estimated',
      estimated_inventory: m.inventory
    }));
    res.status(200).json({
      status: 'success',
      data: formatted
    });
  } catch (error) {
    next(error);
  }
};

export const getMachineById = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  const id = String(req.params.id);
  try {
    const machine = await assertMachineOwnershipOrAdmin(req.user, id);
    res.status(200).json({
      status: 'success',
      data: {
        id: machine.id,
        machine_name: machine.machine_name,
        location: machine.location,
        desired_mode: machine.desired_mode,
        connection_status: machine.connection_status,
        status: machine.status,
        maintenance: machine.desired_mode === 'MAINTENANCE',
        last_seen: machine.last_seen,
        owner_id: machine.owner_id ?? null,
        inventory_source: 'software_estimated',
        estimated_inventory: machine.inventory
      }
    });
  } catch (error) {
    next(error);
  }
};

export const assignMachineOwner = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  const id = String(req.params.id);
  const { owner_id } = req.body;
  const db = getDB();
  try {
    const machine = await ensureMachineRegisteredInLocalDB(id);
    if (!machine) {
      return next(new NotFoundError(`Machine with ID ${id} not found`));
    }

    let resolvedOwnerId: string | null = null;
    if (owner_id !== null && owner_id !== undefined && String(owner_id).trim() !== '') {
      const targetUserId = String(owner_id).trim();
      const targetUser = await getAuthoritativeUserById(targetUserId, db);
      if (!targetUser || targetUser.role !== 'owner') {
        return next(new BadRequestError(`Owner account with ID ${targetUserId} not found`));
      }
      resolvedOwnerId = String(targetUser.id);
    }

    const nowIso = new Date().toISOString();
    await db.run('UPDATE machines SET owner_id = ?, updated_at = ? WHERE id = ?', [
      resolvedOwnerId,
      nowIso,
      id
    ]);

    await updateMachineOwnerInFirebase(id, resolvedOwnerId);

    logger.info(`Admin assigned machine ${id} to owner_id=${resolvedOwnerId ?? 'null'}`);

    res.status(200).json({
      status: 'success',
      message: resolvedOwnerId
        ? `Machine ${id} assigned to owner ${resolvedOwnerId}`
        : `Machine ${id} unassigned from owner`,
      data: {
        id,
        owner_id: resolvedOwnerId,
        updated_at: nowIso
      }
    });
  } catch (error) {
    next(error);
  }
};

const activeMachineRegistrations = new Set<string>();

export const registerMachine = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  const { id, machine_name, location, kiosk_token } = req.body;
  const machineId = String(id || '').trim().toUpperCase();
  const db = getDB();

  if (activeMachineRegistrations.has(machineId)) {
    return next(new ConflictError(`Registration for machine ID ${machineId} is already in progress`));
  }

  activeMachineRegistrations.add(machineId);
  try {
    // 1. Check authoritative Firestore/DB state before inserting locally
    const authoritativeExisting = await getAuthoritativeMachineState(machineId, db);
    if (authoritativeExisting) {
      return next(new ConflictError(`Machine with ID ${machineId} already registered`));
    }

    // When Firestore is not active (pure local offline mode without Firebase), check local DB
    if (!isFirestoreActive()) {
      const existing = await db.get('SELECT id FROM machines WHERE id = ?', [machineId]);
      if (existing) {
        return next(new ConflictError(`Machine with ID ${machineId} already registered`));
      }
    }

    const now = new Date().toISOString();
    const generatedToken = kiosk_token
      ? String(kiosk_token).trim()
      : crypto.randomBytes(15).toString('base64url');
    const defaultInventory = {
      milk_level: 100,
      coffee_level: 100,
      vanilla_level: 100,
      hazelnut_level: 100,
      irish_level: 100,
      mocha_level: 100,
      water_level: 100
    };

    // Clean up any stale un-synced local seed row so cold-start seeds never block authoritative registration
    await db.run('DELETE FROM inventory WHERE machine_id = ?', [machineId]).catch(() => {});
    await db.run('DELETE FROM machines WHERE id = ?', [machineId]).catch(() => {});

    try {
      await db.run(
        'INSERT INTO machines (id, machine_name, location, status, last_seen, kiosk_token, desired_mode, owner_id, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [machineId, machine_name, location, 'online', '', generatedToken, 'RUNNING', null, now]
      );
      await db.run(
        'INSERT INTO inventory (machine_id, milk_level, coffee_level, vanilla_level, hazelnut_level, irish_level, mocha_level, water_level, updated_at) VALUES (?, 100, 100, 100, 100, 100, 100, 100, ?)',
        [machineId, now]
      );
    } catch (insertErr: any) {
      const msg = String(insertErr?.message || insertErr || '');
      if (msg.includes('UNIQUE constraint failed') || msg.includes('SQLITE_CONSTRAINT')) {
        return next(new ConflictError(`Machine with ID ${machineId} already registered`));
      }
      throw insertErr;
    }

    try {
      await syncMachineToFirebase(
        {
          id: machineId,
          machine_name,
          location,
          desired_mode: 'RUNNING',
          status: 'online',
          last_seen: null,
          kiosk_token: generatedToken,
          estimated_inventory: defaultInventory,
          inventory_source: 'software_estimated',
          inventory_updated_at: now,
          products: {},
          updated_at: now
        },
        { createOnly: true }
      );
    } catch (firebaseErr: any) {
      // Roll back local DB rows so failed or conflicting registration never leaves partial state
      await db.run('DELETE FROM inventory WHERE machine_id = ?', [machineId]).catch(() => {});
      await db.run('DELETE FROM machines WHERE id = ?', [machineId]).catch(() => {});
      const msg = String(firebaseErr?.message || firebaseErr || '');
      if (msg.includes('MACHINE_ID_CONFLICT')) {
        return next(new ConflictError(`Machine with ID ${machineId} already registered`));
      }
      throw firebaseErr;
    }

    logger.info(`New machine registered: ${machine_name} (${machineId})`);

    res.status(201).json({
      status: 'success',
      message: 'Machine and default estimated inventory registered successfully',
      data: {
        id: machineId,
        machine_name,
        location,
        desired_mode: 'RUNNING',
        connection_status: 'OFFLINE',
        status: 'online',
        last_seen: null,
        kiosk_token: generatedToken,
        inventory_source: 'software_estimated'
      }
    });
  } catch (error) {
    next(error);
  } finally {
    activeMachineRegistrations.delete(machineId);
  }
};

export const updateMachineStatus = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  const id = String(req.params.id);
  const { desired_mode, status } = req.body;
  const db = getDB();
  try {
    const machine = await assertMachineOwnershipOrAdmin(req.user, id);

    const resolvedDesiredMode = normalizeDesiredMode(desired_mode || status);
    const resolvedLegacyStatus = desiredModeToLegacyStatus(resolvedDesiredMode);
    const now = new Date().toISOString();

    // Update ONLY desired_mode and legacy status in local DB; NEVER overwrite last_seen
    await db.run(
      'UPDATE machines SET desired_mode = ?, status = ?, updated_at = ? WHERE id = ?',
      [resolvedDesiredMode, resolvedLegacyStatus, now, id]
    );

    // Targeted partial write to Firestore: updates desired_mode & status ONLY, preserving last_seen
    await updateMachineDesiredModeInFirebase(id, resolvedDesiredMode);

    const connectionStatus = computeConnectionStatus(machine.last_seen);

    logger.info(
      `Machine ${id} desired_mode updated to ${resolvedDesiredMode} (connection_status=${connectionStatus}, last_seen=${machine.last_seen})`
    );

    res.status(200).json({
      status: 'success',
      data: {
        id,
        desired_mode: resolvedDesiredMode,
        connection_status: connectionStatus,
        status: resolvedLegacyStatus,
        last_seen: machine.last_seen || null
      }
    });
  } catch (error) {
    next(error);
  }
};

export const recordMachineHeartbeat = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  const id = String(req.params.id);
  const db = getDB();
  try {
    const machine = await assertMachineOwnershipOrAdmin(req.user, id);

    const nowIso = new Date().toISOString();

    // Update ONLY last_seen in local DB; NEVER overwrite desired_mode or status
    await db.run('UPDATE machines SET last_seen = ? WHERE id = ?', [nowIso, id]);

    // Targeted partial write to Firestore: updates last_seen ONLY, preserving desired_mode
    await updateMachineHeartbeatInFirebase(id, nowIso);

    res.status(200).json({
      status: 'success',
      data: {
        id,
        desired_mode: machine.desired_mode,
        connection_status: 'ONLINE',
        status: machine.status,
        last_seen: nowIso
      }
    });
  } catch (error) {
    next(error);
  }
};

export const getInventoryByMachine = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  const machine_id = String(req.params.machine_id);
  const db = getDB();
  try {
    await assertMachineOwnershipOrAdmin(req.user, machine_id);

    const inv = await db.get('SELECT * FROM inventory WHERE machine_id = ?', [machine_id]);
    if (!inv) {
      return next(new NotFoundError(`Inventory for machine ID ${machine_id} not found`));
    }
    setNoStoreHeaders(res);
    res.status(200).json({
      status: 'success',
      data: {
        ...inv,
        inventory_source: 'software_estimated'
      }
    });
  } catch (error) {
    next(error);
  }
};

const VALID_INGREDIENTS = ['milk', 'coffee', 'vanilla', 'hazelnut', 'irish', 'mocha', 'water'] as const;

export const refillMachineInventory = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  const machine_id = String(req.params.machine_id);
  const { ingredient } = req.body; // e.g. "milk", "coffee", "water", "vanilla", "hazelnut", "ALL"
  const db = getDB();
  try {
    await assertMachineOwnershipOrAdmin(req.user, machine_id);

    // Validate ingredient parameter
    if (!ingredient || (ingredient !== 'ALL' && !VALID_INGREDIENTS.includes(ingredient))) {
      return next(new BadRequestError(`Invalid ingredient name: ${ingredient}`));
    }

    const target =
      typeof req.body.target === 'number' && Number.isFinite(req.body.target)
        ? Math.max(0, Math.min(100, Math.round(req.body.target)))
        : 100;

    const quantitySpecified =
      typeof req.body.quantity === 'number' && Number.isFinite(req.body.quantity) && req.body.quantity > 0
        ? Math.round(req.body.quantity)
        : undefined;

    if (req.body.quantity !== undefined && (typeof req.body.quantity !== 'number' || !Number.isFinite(req.body.quantity) || req.body.quantity <= 0)) {
      return next(new BadRequestError('Invalid refill quantity: expected a positive finite number'));
    }

    const rawIdempotencyHeader =
      req.headers?.['idempotency-key'] ||
      req.headers?.['Idempotency-Key'] ||
      req.headers?.['IDEMPOTENCY-KEY'] ||
      req.headers?.['x-idempotency-key'] ||
      req.headers?.['X-Idempotency-Key'] ||
      (typeof req.header === 'function' ? req.header('idempotency-key') || req.header('x-idempotency-key') : undefined);

    const idempotencyHeader = typeof rawIdempotencyHeader === 'string' ? rawIdempotencyHeader.trim() : '';

    // Requirement 2: For requests that explicitly specify an incremental refill quantity:
    // Require an Idempotency-Key HTTP header. If missing or empty, return HTTP 400.
    if (quantitySpecified !== undefined && !idempotencyHeader) {
      return next(new BadRequestError('Incremental refill requires a non-empty Idempotency-Key header'));
    }

    const baseIdempotencyKey = String(idempotencyHeader || req.body?.idempotency_key || '').trim();

    const reason =
      typeof req.body.reason === 'string' && req.body.reason.trim()
        ? req.body.reason.trim()
        : ingredient === 'ALL'
        ? `Full machine refill for machine ${machine_id}`
        : `Refilled ${ingredient} for machine ${machine_id}`;

    const nowIso = new Date().toISOString();
    const ingredientsToRefill: string[] = ingredient === 'ALL' ? [...VALID_INGREDIENTS] : [ingredient];

    let recordedMovements: any[] = [];
    let updatedInv: any = null;
    let isDeduplicated = false;

    if (isFirestoreActive()) {
      const firestore = getFirestoreInstance()!;
      const machineRef = firestore.collection('machines').doc(machine_id);

      const txResult = await firestore.runTransaction(async (tx) => {
        const snap = await tx.get(machineRef);
        if (!snap.exists) {
          throw new NotFoundError(`Machine ID ${machine_id} not found in Firestore`);
        }
        const machineData = snap.data() || {};
        const currentEstimated = machineData.estimated_inventory || {};

        // Validate idempotency key reuse if key is provided (Finding B-1: hashed doc ID with legacy fallback)
        if (baseIdempotencyKey) {
          const hashedDocId = `idem_${crypto.createHash('sha256').update(baseIdempotencyKey).digest('hex')}`;
          let idemRef = firestore.collection('refill_idempotency').doc(hashedDocId);
          let idemSnap = await tx.get(idemRef);

          // Backward compatibility fallback for legacy unhashed doc IDs
          if (!idemSnap.exists && !baseIdempotencyKey.includes('/')) {
            try {
              const legacyRef = firestore.collection('refill_idempotency').doc(baseIdempotencyKey);
              const legacySnap = await tx.get(legacyRef);
              if (legacySnap.exists) {
                idemSnap = legacySnap;
                idemRef = legacyRef;
              }
            } catch {
              // Ignore invalid path syntax on legacy doc check
            }
          }

          if (idemSnap.exists) {
            const existing = idemSnap.data() as any;
            if (existing.machine_id && existing.machine_id !== machine_id) {
              throw new ConflictError(
                `Idempotency key '${baseIdempotencyKey}' was already used for machine '${existing.machine_id}' (cannot reuse for machine '${machine_id}')`
              );
            }
            if (existing.ingredient && existing.ingredient !== ingredient) {
              throw new ConflictError(
                `Idempotency key '${baseIdempotencyKey}' was already used for ingredient '${existing.ingredient}' (cannot reuse for ingredient '${ingredient}')`
              );
            }
            const storedQty = existing.quantity !== null && existing.quantity !== undefined ? Number(existing.quantity) : undefined;
            if (quantitySpecified !== undefined && storedQty !== quantitySpecified) {
              throw new ConflictError(
                `Idempotency key '${baseIdempotencyKey}' was already used with quantity ${storedQty} (cannot reuse with quantity ${quantitySpecified})`
              );
            }
            if (quantitySpecified === undefined && storedQty !== undefined) {
              throw new ConflictError(
                `Idempotency key '${baseIdempotencyKey}' was already used for an incremental refill with quantity ${storedQty}`
              );
            }
            if (quantitySpecified === undefined && existing.target !== undefined && existing.target !== target) {
              throw new ConflictError(
                `Idempotency key '${baseIdempotencyKey}' was already used with target ${existing.target} (cannot reuse with target ${target})`
              );
            }

            // Valid replay: return existing state without duplicate movements
            return {
              movements: [],
              estimatedInventory: currentEstimated,
              deduplicated: true
            };
          }
        }

        const txMovements: any[] = [];
        const newEstimated: Record<string, number> = {
          milk_level: Number(currentEstimated.milk_level ?? 100),
          coffee_level: Number(currentEstimated.coffee_level ?? 100),
          vanilla_level: Number(currentEstimated.vanilla_level ?? 100),
          hazelnut_level: Number(currentEstimated.hazelnut_level ?? 100),
          irish_level: Number(currentEstimated.irish_level ?? 100),
          mocha_level: Number(currentEstimated.mocha_level ?? 100),
          water_level: Number(currentEstimated.water_level ?? 100)
        };

        let hasNewMovement = false;

        for (const ing of ingredientsToRefill) {
          const currentLevel = Math.max(0, Math.min(100, Number(newEstimated[`${ing}_level`] ?? 100)));
          const targetLevel = quantitySpecified !== undefined ? Math.min(100, currentLevel + quantitySpecified) : target;
          const addedQty = Math.max(0, targetLevel - currentLevel);

          if (addedQty > 0) {
            const itemKey = baseIdempotencyKey
              ? `refill_${machine_id}_${ing}_${baseIdempotencyKey}`
              : `refill_${machine_id}_${ing}_${Date.now()}_${crypto.randomUUID().slice(-8)}`;
            const movementId = `inv_mov_${itemKey.replace(/[^a-zA-Z0-9_-]/g, '_')}`;

            const movementDoc = {
              id: movementId,
              machine_id,
              ingredient: ing,
              quantity: addedQty,
              movement_type: 'REFILL',
              balance_after: targetLevel,
              order_id: null,
              refund_id: null,
              reason,
              idempotency_key: itemKey,
              created_at: nowIso
            };

            const rootLedgerRef = firestore.collection('inventory_ledger').doc(movementId);
            const subLedgerRef = firestore
              .collection('machines')
              .doc(machine_id)
              .collection('inventory_ledger')
              .doc(movementId);

            tx.set(rootLedgerRef, movementDoc, { merge: true });
            tx.set(subLedgerRef, movementDoc, { merge: true });

            newEstimated[`${ing}_level`] = targetLevel;
            txMovements.push(movementDoc);
            hasNewMovement = true;
          }
        }

        if (baseIdempotencyKey) {
          const hashedDocId = `idem_${crypto.createHash('sha256').update(baseIdempotencyKey).digest('hex')}`;
          const idemPayload = {
            idempotency_key: baseIdempotencyKey,
            machine_id,
            ingredient,
            quantity: quantitySpecified ?? null,
            target,
            created_at: nowIso
          };
          tx.set(firestore.collection('refill_idempotency').doc(hashedDocId), idemPayload);
          if (!baseIdempotencyKey.includes('/')) {
            tx.set(firestore.collection('refill_idempotency').doc(baseIdempotencyKey), idemPayload);
          }
        }

        if (hasNewMovement) {
          tx.set(
            machineRef,
            {
              id: machine_id,
              estimated_inventory: newEstimated,
              inventory_source: 'software_estimated',
              inventory_updated_at: nowIso,
              updated_at: nowIso
            },
            { merge: true }
          );
        }

        return {
          movements: txMovements,
          estimatedInventory: newEstimated,
          deduplicated: false
        };
      });

      recordedMovements = txResult.movements;
      isDeduplicated = txResult.deduplicated;

      // Sync updated inventory to local SQLite database mirror
      if (db && db.run) {
        let hasLocalTx = false;
        try {
          await db.run('BEGIN IMMEDIATE TRANSACTION');
          hasLocalTx = true;

          await db.run(`
            CREATE TABLE IF NOT EXISTS refill_idempotency (
              idempotency_key TEXT PRIMARY KEY,
              machine_id TEXT NOT NULL,
              ingredient TEXT NOT NULL,
              quantity INTEGER,
              target INTEGER,
              created_at TEXT NOT NULL
            )
          `);

          if (baseIdempotencyKey) {
            await db.run(
              `INSERT OR IGNORE INTO refill_idempotency (
                idempotency_key, machine_id, ingredient, quantity, target, created_at
              ) VALUES (?, ?, ?, ?, ?, ?)`,
              [
                baseIdempotencyKey,
                machine_id,
                ingredient,
                quantitySpecified ?? null,
                target,
                nowIso
              ]
            ).catch(() => {});
          }

          await db.run(
            `UPDATE inventory SET
              milk_level = ?, coffee_level = ?, vanilla_level = ?,
              hazelnut_level = ?, irish_level = ?, mocha_level = ?,
              water_level = ?, updated_at = ?
             WHERE machine_id = ?`,
            [
              txResult.estimatedInventory.milk_level,
              txResult.estimatedInventory.coffee_level,
              txResult.estimatedInventory.vanilla_level,
              txResult.estimatedInventory.hazelnut_level,
              txResult.estimatedInventory.irish_level,
              txResult.estimatedInventory.mocha_level,
              txResult.estimatedInventory.water_level,
              nowIso,
              machine_id
            ]
          );

          for (const m of recordedMovements) {
            await db.run(
              `INSERT OR IGNORE INTO inventory_ledger (
                id, machine_id, ingredient, quantity, movement_type,
                balance_after, order_id, refund_id, reason, idempotency_key, created_at
              ) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?)`,
              [
                m.id,
                m.machine_id,
                m.ingredient,
                m.quantity,
                m.movement_type,
                m.balance_after,
                m.reason,
                m.idempotency_key,
                m.created_at
              ]
            );
          }

          await db.run('COMMIT');
          hasLocalTx = false;
        } catch (localErr) {
          if (hasLocalTx) {
            try { await db.run('ROLLBACK'); } catch {}
          }
          logger.warn(`Failed to mirror Firestore refill to local SQLite for machine ${machine_id}:`, localErr);
        }
      }

      updatedInv = {
        machine_id,
        ...txResult.estimatedInventory,
        updated_at: nowIso
      };
    } else {
      // Local SQLite / MockDatabase atomic fallback
      let hasLocalTx = false;
      try {
        if (db && db.run) {
          await db.run('BEGIN IMMEDIATE TRANSACTION');
          hasLocalTx = true;

          await db.run(`
            CREATE TABLE IF NOT EXISTS refill_idempotency (
              idempotency_key TEXT PRIMARY KEY,
              machine_id TEXT NOT NULL,
              ingredient TEXT NOT NULL,
              quantity INTEGER,
              target INTEGER,
              created_at TEXT NOT NULL
            )
          `);
        }

        const inv = await db.get('SELECT * FROM inventory WHERE machine_id = ?', [machine_id]);
        if (!inv) {
          throw new NotFoundError(`Inventory for machine ID ${machine_id} not found`);
        }

        if (baseIdempotencyKey) {
          const existingIdem = await db.get(
            'SELECT * FROM refill_idempotency WHERE idempotency_key = ?',
            [baseIdempotencyKey]
          );

          if (existingIdem) {
            if (existingIdem.machine_id && existingIdem.machine_id !== machine_id) {
              throw new ConflictError(
                `Idempotency key '${baseIdempotencyKey}' was already used for machine '${existingIdem.machine_id}' (cannot reuse for machine '${machine_id}')`
              );
            }
            if (existingIdem.ingredient && existingIdem.ingredient !== ingredient) {
              throw new ConflictError(
                `Idempotency key '${baseIdempotencyKey}' was already used for ingredient '${existingIdem.ingredient}' (cannot reuse for ingredient '${ingredient}')`
              );
            }
            const storedQty = existingIdem.quantity !== null && existingIdem.quantity !== undefined ? Number(existingIdem.quantity) : undefined;
            if (quantitySpecified !== undefined && storedQty !== quantitySpecified) {
              throw new ConflictError(
                `Idempotency key '${baseIdempotencyKey}' was already used with quantity ${storedQty} (cannot reuse with quantity ${quantitySpecified})`
              );
            }
            if (quantitySpecified === undefined && storedQty !== undefined) {
              throw new ConflictError(
                `Idempotency key '${baseIdempotencyKey}' was already used for an incremental refill with quantity ${storedQty}`
              );
            }
            if (quantitySpecified === undefined && existingIdem.target !== null && Number(existingIdem.target) !== target) {
              throw new ConflictError(
                `Idempotency key '${baseIdempotencyKey}' was already used with target ${existingIdem.target} (cannot reuse with target ${target})`
              );
            }

            // Valid replay: return existing state without duplicate movements
            if (hasLocalTx) {
              await db.run('COMMIT');
              hasLocalTx = false;
            }
            isDeduplicated = true;
            updatedInv = inv;
          }
        }

        if (!isDeduplicated) {
          const newLevels: Record<string, number> = {
            milk_level: Number(inv.milk_level ?? 100),
            coffee_level: Number(inv.coffee_level ?? 100),
            vanilla_level: Number(inv.vanilla_level ?? 100),
            hazelnut_level: Number(inv.hazelnut_level ?? 100),
            irish_level: Number(inv.irish_level ?? 100),
            mocha_level: Number(inv.mocha_level ?? 100),
            water_level: Number(inv.water_level ?? 100)
          };

          let hasNewMovement = false;

          for (const ing of ingredientsToRefill) {
            const currentLevel = Math.max(0, Math.min(100, Number(newLevels[`${ing}_level`] ?? 100)));
            const targetLevel = quantitySpecified !== undefined ? Math.min(100, currentLevel + quantitySpecified) : target;
            const addedQty = Math.max(0, targetLevel - currentLevel);

            if (addedQty > 0) {
              const itemKey = baseIdempotencyKey
                ? `refill_${machine_id}_${ing}_${baseIdempotencyKey}`
                : `refill_${machine_id}_${ing}_${Date.now()}_${crypto.randomUUID().slice(-8)}`;
              const movementId = `inv_mov_${itemKey.replace(/[^a-zA-Z0-9_-]/g, '_')}`;

              await db.run(
                `INSERT INTO inventory_ledger (
                  id, machine_id, ingredient, quantity, movement_type,
                  balance_after, order_id, refund_id, reason, idempotency_key, created_at
                ) VALUES (?, ?, ?, ?, 'REFILL', ?, NULL, NULL, ?, ?, ?)`,
                [
                  movementId,
                  machine_id,
                  ing,
                  addedQty,
                  targetLevel,
                  reason,
                  itemKey,
                  nowIso
                ]
              );

              newLevels[`${ing}_level`] = targetLevel;
              recordedMovements.push({
                id: movementId,
                machine_id,
                ingredient: ing,
                quantity: addedQty,
                movement_type: 'REFILL',
                balance_after: targetLevel,
                reason,
                idempotency_key: itemKey,
                created_at: nowIso
              });
              hasNewMovement = true;
            }
          }

          if (baseIdempotencyKey) {
            await db.run(
              `INSERT INTO refill_idempotency (
                idempotency_key, machine_id, ingredient, quantity, target, created_at
              ) VALUES (?, ?, ?, ?, ?, ?)`,
              [
                baseIdempotencyKey,
                machine_id,
                ingredient,
                quantitySpecified ?? null,
                target,
                nowIso
              ]
            );
          }

          if (hasNewMovement) {
            await db.run(
              `UPDATE inventory SET
                milk_level = ?, coffee_level = ?, vanilla_level = ?,
                hazelnut_level = ?, irish_level = ?, mocha_level = ?,
                water_level = ?, updated_at = ?
               WHERE machine_id = ?`,
              [
                newLevels.milk_level,
                newLevels.coffee_level,
                newLevels.vanilla_level,
                newLevels.hazelnut_level,
                newLevels.irish_level,
                newLevels.mocha_level,
                newLevels.water_level,
                nowIso,
                machine_id
              ]
            );
          }

          if (hasLocalTx) {
            await db.run('COMMIT');
            hasLocalTx = false;
          }

          updatedInv = await db.get('SELECT * FROM inventory WHERE machine_id = ?', [machine_id]);
        }
      } catch (sqliteErr) {
        if (hasLocalTx) {
          try { await db.run('ROLLBACK'); } catch {}
        }
        throw sqliteErr;
      }
    }

    logger.info(
      `Refilled ${ingredient} for machine ID ${machine_id}: ${recordedMovements.length} movements recorded (deduplicated=${isDeduplicated})`
    );

    let message = `Successfully refilled ${ingredient}`;
    if (isDeduplicated) {
      message = `Refill request already processed with idempotency key ${baseIdempotencyKey}`;
    } else if (recordedMovements.length === 0) {
      message = `Inventory stock is already at target level; no refill movement recorded`;
    }

    res.status(200).json({
      status: 'success',
      message,
      deduplicated: isDeduplicated,
      refilled_movements: recordedMovements,
      data: {
        ...updatedInv,
        inventory_source: 'software_estimated'
      }
    });
  } catch (error) {
    next(error);
  }
};

export const getMachineStatus = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const queryMachineId = typeof req.query.machine_id === 'string' ? req.query.machine_id.trim() : '';
    const tokenMachineId = req.user?.machine_id || '';

    if (req.user?.role === 'kiosk' && tokenMachineId && queryMachineId && queryMachineId !== tokenMachineId) {
      return next(new ForbiddenError(`Kiosk session bound to ${tokenMachineId} cannot query status for ${queryMachineId}`));
    }

    const machineId = queryMachineId || tokenMachineId || 'CFX-MC-01';
    const machine = await assertMachineOwnershipOrAdmin(req.user, machineId);

    setNoStoreHeaders(res);
    res.status(200).json({
      status: 'success',
      data: {
        machine_id: machine.id,
        name: machine.machine_name,
        location: machine.location,
        desired_mode: machine.desired_mode,
        connection_status: machine.connection_status,
        status: machine.status,
        maintenance: machine.desired_mode === 'MAINTENANCE',
        last_seen: machine.last_seen,
        inventory_source: 'software_estimated',
        inventory: {
          milk: machine.inventory.milk_level,
          coffee: machine.inventory.coffee_level,
          vanilla: machine.inventory.vanilla_level,
          hazelnut: machine.inventory.hazelnut_level,
          irish: machine.inventory.irish_level,
          mocha: machine.inventory.mocha_level,
          water: machine.inventory.water_level
        }
      }
    });
  } catch (error) {
    next(error);
  }
};

export const getMachineProducts = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  const id = String(req.params.id).trim();
  const db = getDB();
  try {
    const machine = await assertMachineOwnershipOrAdmin(req.user, id);
    const products = await getAuthoritativeMachineProducts(machine.id, db);
    setNoStoreHeaders(res);
    res.status(200).json({
      status: 'success',
      data: products
    });
  } catch (error) {
    next(error);
  }
};

export const updateMachineProduct = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  const id = String(req.params.id).trim();
  const productIdNum = Number(req.params.productId);
  const { price, is_available } = req.body;
  const db = getDB();

  try {
    const machine = await assertMachineOwnershipOrAdmin(req.user, id);

    if (!Number.isInteger(productIdNum) || productIdNum <= 0) {
      return next(new BadRequestError(`Invalid product ID: ${req.params.productId}`));
    }

    const baseProduct = await db.get('SELECT * FROM products WHERE id = ?', [productIdNum]);
    if (!baseProduct) {
      return next(new NotFoundError(`Product with ID ${productIdNum} not found`));
    }

    const currentMachineProduct = await getAuthoritativeMachineProduct(
      machine.id,
      productIdNum,
      db
    );

    const nextPrice =
      price !== undefined
        ? Number(price)
        : Number(currentMachineProduct?.price ?? baseProduct.price);
    const nextAvailable =
      is_available !== undefined
        ? Boolean(is_available)
        : Boolean(currentMachineProduct?.is_available ?? true);

    if (!Number.isInteger(nextPrice) || nextPrice <= 0) {
      return next(new BadRequestError('Price must be a positive integer'));
    }

    const nowIso = new Date().toISOString();

    await db.run(
      'INSERT OR REPLACE INTO machine_products (machine_id, product_id, price, is_available, updated_at) VALUES (?, ?, ?, ?, ?)',
      [machine.id, productIdNum, nextPrice, nextAvailable ? 1 : 0, nowIso]
    );

    await updateMachineProductInFirebase(machine.id, productIdNum, {
      price: nextPrice,
      is_available: nextAvailable,
      updated_at: nowIso
    });

    logger.info(
      `Machine ${machine.id} product ${productIdNum} (${baseProduct.name}) updated: price=₹${nextPrice}, is_available=${nextAvailable}`
    );

    res.status(200).json({
      status: 'success',
      message: 'Machine product updated successfully',
      data: {
        id: productIdNum,
        product_id: productIdNum,
        machine_id: machine.id,
        name: baseProduct.name,
        default_price: Number(baseProduct.price),
        price: nextPrice,
        is_available: nextAvailable,
        description: baseProduct.description,
        image: baseProduct.image,
        updated_at: nowIso
      }
    });
  } catch (error) {
    next(error);
  }
};

