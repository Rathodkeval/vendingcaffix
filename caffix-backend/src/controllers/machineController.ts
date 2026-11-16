import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { getDB } from '../config/db';
import { AuthRequest, assertMachineOwnershipOrAdmin } from '../middleware/auth';
import { NotFoundError, BadRequestError, ForbiddenError, ConflictError } from '../utils/errors';
import {
  syncMachineToFirebase,
  updateMachineDesiredModeInFirebase,
  updateMachineHeartbeatInFirebase,
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
      owner_id: m.owner_id ?? null
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
        owner_id: machine.owner_id ?? null
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

    // Clean up any stale un-synced local seed row so cold-start seeds never block authoritative registration
    await db.run('DELETE FROM machines WHERE id = ?', [machineId]).catch(() => {});

    try {
      await db.run(
        'INSERT INTO machines (id, machine_name, location, status, last_seen, kiosk_token, desired_mode, owner_id, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [machineId, machine_name, location, 'online', '', generatedToken, 'RUNNING', null, now]
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
          products: {},
          updated_at: now
        },
        { createOnly: true }
      );
    } catch (firebaseErr: any) {
      // Roll back local DB row so failed or conflicting registration never leaves partial state
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
      message: 'Machine registered successfully',
      data: {
        id: machineId,
        machine_name,
        location,
        desired_mode: 'RUNNING',
        connection_status: 'OFFLINE',
        status: 'online',
        last_seen: null,
        kiosk_token: generatedToken
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
        last_seen: machine.last_seen
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

