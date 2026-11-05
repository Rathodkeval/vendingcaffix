import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { getDB } from '../config/db';
import { AuthRequest } from '../middleware/auth';
import { NotFoundError, BadRequestError, ForbiddenError } from '../utils/errors';
import { syncMachineToFirebase } from '../utils/firebase';
import { ensureMachineRegisteredInLocalDB } from './kioskController';
import logger from '../utils/logger';

export const getMachines = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  const db = getDB();
  try {
    const machines = await db.all('SELECT id, machine_name, location, status, last_seen FROM machines');
    res.status(200).json({
      status: 'success',
      data: machines
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
      'INSERT INTO machines (id, machine_name, location, status, last_seen, kiosk_token) VALUES (?, ?, ?, ?, ?, ?)',
      [id, machine_name, location, 'online', now, generatedToken]
    );

    // Create default full inventory for this machine
    await db.run(
      'INSERT INTO inventory (machine_id, milk_level, coffee_level, vanilla_level, hazelnut_level, irish_level, mocha_level, water_level) VALUES (?, 100, 100, 100, 100, 100, 100, 100)',
      [id]
    );

    await syncMachineToFirebase({
      id,
      machine_name,
      location,
      status: 'online',
      last_seen: now,
      kiosk_token: generatedToken
    });

    logger.info(`New machine registered: ${machine_name} (${id})`);

    res.status(201).json({
      status: 'success',
      message: 'Machine and default inventory registered successfully',
      data: {
        id,
        machine_name,
        location,
        status: 'online',
        last_seen: now,
        kiosk_token: generatedToken
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
  const { status } = req.body;
  const db = getDB();
  try {
    if (req.user?.role === 'kiosk' && req.user.machine_id && req.user.machine_id !== id) {
      return next(new ForbiddenError(`Kiosk ${req.user.machine_id} cannot modify status of machine ${id}`));
    }

    const machine = await ensureMachineRegisteredInLocalDB(id);
    if (!machine) {
      return next(new NotFoundError(`Machine with ID ${id} not found`));
    }

    const now = new Date().toISOString();
    await db.run(
      'UPDATE machines SET status = ?, last_seen = ? WHERE id = ?',
      [status, now, id]
    );

    await syncMachineToFirebase({
      ...machine,
      status,
      last_seen: now
    });

    logger.info(`Machine ${id} status updated to ${status}`);

    res.status(200).json({
      status: 'success',
      data: { id, status, last_seen: now }
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
    if (req.user?.role === 'kiosk' && req.user.machine_id && req.user.machine_id !== machine_id) {
      return next(new ForbiddenError(`Kiosk ${req.user.machine_id} cannot access inventory of machine ${machine_id}`));
    }

    await ensureMachineRegisteredInLocalDB(machine_id);
    const inv = await db.get('SELECT * FROM inventory WHERE machine_id = ?', [machine_id]);
    if (!inv) {
      return next(new NotFoundError(`Inventory for machine ID ${machine_id} not found`));
    }
    res.status(200).json({
      status: 'success',
      data: inv
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
    await ensureMachineRegisteredInLocalDB(machine_id);
    const inv = await db.get('SELECT id FROM inventory WHERE machine_id = ?', [machine_id]);
    if (!inv) {
      return next(new NotFoundError(`Inventory for machine ID ${machine_id} not found`));
    }

    if (ingredient === 'ALL') {
      await db.run(
        'UPDATE inventory SET milk_level = 100, coffee_level = 100, vanilla_level = 100, hazelnut_level = 100, irish_level = 100, mocha_level = 100, water_level = 100 WHERE machine_id = ?',
        [machine_id]
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
    res.status(200).json({
      status: 'success',
      message: `Successfully refilled ${ingredient}`,
      data: updatedInv
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
  const db = getDB();
  try {
    const queryMachineId = typeof req.query.machine_id === 'string' ? req.query.machine_id.trim() : '';
    const tokenMachineId = req.user?.machine_id || '';

    if (req.user?.role === 'kiosk' && tokenMachineId && queryMachineId && queryMachineId !== tokenMachineId) {
      return next(new ForbiddenError(`Kiosk session bound to ${tokenMachineId} cannot query status for ${queryMachineId}`));
    }

    const machineId = queryMachineId || tokenMachineId || 'CFX-MC-01';
    const machine = await ensureMachineRegisteredInLocalDB(machineId);
    if (!machine) {
      return next(new NotFoundError(`Machine with ID ${machineId} not found`));
    }

    const inventory = await db.get('SELECT * FROM inventory WHERE machine_id = ?', [machineId]);
    if (!inventory) {
      return next(new NotFoundError(`Inventory for machine ID ${machineId} not found`));
    }

    res.status(200).json({
      status: 'success',
      data: {
        machine_id: machine.id,
        name: machine.machine_name,
        location: machine.location,
        status: machine.status,
        last_seen: machine.last_seen,
        inventory: {
          milk: inventory.milk_level,
          coffee: inventory.coffee_level,
          vanilla: inventory.vanilla_level,
          hazelnut: inventory.hazelnut_level,
          irish: inventory.irish_level,
          mocha: inventory.mocha_level,
          water: inventory.water_level
        }
      }
    });
  } catch (error) {
    next(error);
  }
};

