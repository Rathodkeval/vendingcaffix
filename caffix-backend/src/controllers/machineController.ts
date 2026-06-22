import { Request, Response, NextFunction } from 'express';
import { getDB } from '../config/db';
import { NotFoundError, BadRequestError } from '../utils/errors';
import logger from '../utils/logger';

export const getMachines = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  const db = getDB();
  try {
    const machines = await db.all('SELECT * FROM machines');
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
  const { id, machine_name, location } = req.body;
  const db = getDB();
  try {
    const existing = await db.get('SELECT id FROM machines WHERE id = ?', [id]);
    if (existing) {
      return next(new BadRequestError(`Machine with ID ${id} already registered`));
    }

    const now = new Date().toISOString();
    await db.run(
      'INSERT INTO machines (id, machine_name, location, status, last_seen) VALUES (?, ?, ?, ?, ?)',
      [id, machine_name, location, 'online', now]
    );

    // Create default full inventory for this machine
    await db.run(
      'INSERT INTO inventory (machine_id, milk_level, coffee_level, vanilla_level, hazelnut_level, water_level) VALUES (?, 100, 100, 100, 100, 100)',
      [id]
    );

    logger.info(`New machine registered: ${machine_name} (${id})`);

    res.status(201).json({
      status: 'success',
      message: 'Machine and default inventory registered successfully',
      data: { id, machine_name, location, status: 'online', last_seen: now }
    });
  } catch (error) {
    next(error);
  }
};

export const updateMachineStatus = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  const { id } = req.params;
  const { status } = req.body;
  const db = getDB();
  try {
    const machine = await db.get('SELECT id FROM machines WHERE id = ?', [id]);
    if (!machine) {
      return next(new NotFoundError(`Machine with ID ${id} not found`));
    }

    const now = new Date().toISOString();
    await db.run(
      'UPDATE machines SET status = ?, last_seen = ? WHERE id = ?',
      [status, now, id]
    );

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
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  const { machine_id } = req.params;
  const db = getDB();
  try {
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
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  const { machine_id } = req.params;
  const { ingredient } = req.body; // e.g. "milk", "coffee", "water", "vanilla", "hazelnut", "ALL"
  const db = getDB();
  try {
    const inv = await db.get('SELECT id FROM inventory WHERE machine_id = ?', [machine_id]);
    if (!inv) {
      return next(new NotFoundError(`Inventory for machine ID ${machine_id} not found`));
    }

    if (ingredient === 'ALL') {
      await db.run(
        'UPDATE inventory SET milk_level = 100, coffee_level = 100, vanilla_level = 100, hazelnut_level = 100, water_level = 100 WHERE machine_id = ?',
        [machine_id]
      );
    } else {
      const field = `${ingredient}_level`;
      // Protect against SQL injection by verifying column whitelist
      const validIngredients = ['milk', 'coffee', 'vanilla', 'hazelnut', 'water'];
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
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  const db = getDB();
  try {
    const machineId = 'CFX-MC-01';
    const machine = await db.get('SELECT * FROM machines WHERE id = ?', [machineId]);
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
          water: inventory.water_level
        }
      }
    });
  } catch (error) {
    next(error);
  }
};

