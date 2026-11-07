import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { getDB } from '../config/db';
import { AuthRequest, assertMachineOwnershipOrAdmin } from '../middleware/auth';
import { NotFoundError, BadRequestError, ForbiddenError } from '../utils/errors';
import {
  syncMachineToFirebase,
  updateMachineDesiredModeInFirebase,
  updateMachineHeartbeatInFirebase,
  updateMachineInventoryInFirebase,
  updateMachineOwnerInFirebase,
  updateMachineProductInFirebase,
  getAuthoritativeMachinesList,
  getAuthoritativeMachineProducts,
  getAuthoritativeMachineProduct,
  getAuthoritativeUserById,
  normalizeDesiredMode,
  desiredModeToLegacyStatus,
  computeConnectionStatus
} from '../utils/firebase';
import { ensureMachineRegisteredInLocalDB } from './kioskController';
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

export const registerMachine = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  const { id, machine_name, location, kiosk_token } = req.body;
  const db = getDB();
  try {
    const existing = await db.get('SELECT id FROM machines WHERE id = ?', [id]);
    if (existing) {
      return next(new BadRequestError(`Machine with ID ${id} already registered`));
    }

    const now = new Date().toISOString();
    const generatedToken = kiosk_token
      ? String(kiosk_token).trim()
      : crypto.randomBytes(15).toString('base64url');

    await db.run(
      'INSERT INTO machines (id, machine_name, location, status, last_seen, kiosk_token, desired_mode, owner_id, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [id, machine_name, location, 'online', '', generatedToken, 'RUNNING', null, now]
    );

    // Create default software-estimated full inventory for this machine
    await db.run(
      'INSERT INTO inventory (machine_id, milk_level, coffee_level, vanilla_level, hazelnut_level, irish_level, mocha_level, water_level, updated_at) VALUES (?, 100, 100, 100, 100, 100, 100, 100, ?)',
      [id, now]
    );

    await syncMachineToFirebase({
      id,
      machine_name,
      location,
      desired_mode: 'RUNNING',
      status: 'online',
      last_seen: null,
      kiosk_token: generatedToken,
      updated_at: now
    });

    await updateMachineInventoryInFirebase(id, {
      milk_level: 100,
      coffee_level: 100,
      vanilla_level: 100,
      hazelnut_level: 100,
      irish_level: 100,
      mocha_level: 100,
      water_level: 100
    });

    logger.info(`New machine registered: ${machine_name} (${id})`);

    res.status(201).json({
      status: 'success',
      message: 'Machine and default estimated inventory registered successfully',
      data: {
        id,
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

    const inv = await db.get('SELECT id FROM inventory WHERE machine_id = ?', [machine_id]);
    if (!inv) {
      return next(new NotFoundError(`Inventory for machine ID ${machine_id} not found`));
    }

    const nowIso = new Date().toISOString();

    if (ingredient === 'ALL') {
      await db.run(
        'UPDATE inventory SET milk_level = 100, coffee_level = 100, vanilla_level = 100, hazelnut_level = 100, irish_level = 100, mocha_level = 100, water_level = 100, updated_at = ? WHERE machine_id = ?',
        [nowIso, machine_id]
      );
    } else {
      const field = `${ingredient}_level`;
      // Protect against SQL injection by verifying column whitelist
      const validIngredients = ['milk', 'coffee', 'vanilla', 'hazelnut', 'irish', 'mocha', 'water'];
      if (!validIngredients.includes(ingredient)) {
        return next(new BadRequestError(`Invalid ingredient name: ${ingredient}`));
      }

      await db.run(`UPDATE inventory SET ${field} = 100 WHERE machine_id = ?`, [machine_id]);
    }

    logger.info(`Refilled ${ingredient} for machine ID ${machine_id}`);

    const updatedInv = await db.get('SELECT * FROM inventory WHERE machine_id = ?', [machine_id]);
    if (updatedInv) {
      await updateMachineInventoryInFirebase(machine_id, updatedInv);
    }

    res.status(200).json({
      status: 'success',
      message: `Successfully refilled ${ingredient}`,
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


