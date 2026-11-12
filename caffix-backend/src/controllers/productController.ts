import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { getDB } from '../config/db';
import { AuthRequest, assertMachineOwnershipOrAdmin } from '../middleware/auth';
import { NotFoundError, BadRequestError, ForbiddenError } from '../utils/errors';
import {
  getAuthoritativeMachineProducts,
  getAuthoritativeMachineProduct,
  updateMachineProductInFirebase
} from '../utils/firebase';
import { ensureMachineRegisteredInLocalDB } from './kioskController';
import { setNoStoreHeaders } from '../utils/cache';
import logger from '../utils/logger';

const JWT_SECRET = process.env.JWT_SECRET || 'caffix_vending_secret_key_2026_xyz';

function resolveOptionalMachineIdFromRequest(req: Request): {
  machineId: string | null;
  explicitlyProvided: boolean;
  tokenMachineId: string | null;
  tokenRole: string | null;
} {
  let tokenMachineId: string | null = null;
  let tokenRole: string | null = null;

  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.split(' ')[1];
    try {
      const decoded = jwt.verify(token, JWT_SECRET) as any;
      if (typeof decoded?.role === 'string') {
        tokenRole = decoded.role;
      }
      if (decoded?.machine_id && typeof decoded.machine_id === 'string') {
        tokenMachineId = decoded.machine_id.trim();
      }
    } catch {
      // Ignore invalid optional token on public product listing
    }
  }

  if (typeof req.query.machine_id === 'string' && req.query.machine_id.trim() !== '') {
    return {
      machineId: req.query.machine_id.trim(),
      explicitlyProvided: true,
      tokenMachineId,
      tokenRole
    };
  }

  const headerMachineId = req.headers['x-machine-id'];
  if (typeof headerMachineId === 'string' && headerMachineId.trim() !== '') {
    return {
      machineId: headerMachineId.trim(),
      explicitlyProvided: true,
      tokenMachineId,
      tokenRole
    };
  }

  if (tokenMachineId) {
    return {
      machineId: tokenMachineId,
      explicitlyProvided: false,
      tokenMachineId,
      tokenRole
    };
  }

  const referer = req.headers.referer;
  if (typeof referer === 'string' && referer.includes('machine_id=')) {
    try {
      const url = new URL(referer);
      const refMachineId = url.searchParams.get('machine_id');
      if (refMachineId && /^CFX-MC-\d{2,4}$/.test(refMachineId.trim())) {
        return {
          machineId: refMachineId.trim(),
          explicitlyProvided: false,
          tokenMachineId,
          tokenRole
        };
      }
    } catch {
      // Ignore malformed referer
    }
  }

  return { machineId: null, explicitlyProvided: false, tokenMachineId, tokenRole };
}

export const getProducts = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  const db = getDB();
  try {
    setNoStoreHeaders(res);
    const { machineId, explicitlyProvided, tokenMachineId, tokenRole } =
      resolveOptionalMachineIdFromRequest(req);

    if (
      tokenRole === 'kiosk' &&
      tokenMachineId &&
      explicitlyProvided &&
      machineId &&
      machineId !== tokenMachineId
    ) {
      return next(
        new ForbiddenError(
          `Kiosk session bound to ${tokenMachineId} cannot query products for ${machineId}`
        )
      );
    }

    if (machineId) {
      if (!/^CFX-MC-\d{2,4}$/.test(machineId)) {
        if (explicitlyProvided) {
          return next(new BadRequestError(`Invalid machine_id format: "${machineId}"`));
        }
      } else {
        const machine = await ensureMachineRegisteredInLocalDB(machineId);
        if (!machine) {
          return next(new NotFoundError(`Machine with ID ${machineId} not found`));
        }
        const machineProducts = await getAuthoritativeMachineProducts(machineId, db);
        res.status(200).json({
          status: 'success',
          machine_id: machineId,
          data: machineProducts
        });
        return;
      }
    }

    const products = await db.all('SELECT * FROM products');
    const formatted = products.map((p: any) => ({
      ...p,
      default_price: Number(p.price),
      is_available: true
    }));

    res.status(200).json({
      status: 'success',
      data: formatted
    });
  } catch (error) {
    next(error);
  }
};

export const createProduct = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  const { name, price, description, image } = req.body;
  const db = getDB();
  try {
    const result = await db.run(
      'INSERT INTO products (name, price, description, image) VALUES (?, ?, ?, ?)',
      [name, price, description, image || '/assets/classic_coffee.png']
    );
    
    logger.info(`New product created: ${name} (₹${price})`);
    
    res.status(201).json({
      status: 'success',
      data: {
        id: result.lastID,
        name,
        price,
        description,
        image
      }
    });
  } catch (error) {
    next(error);
  }
};

export const updateProductPrice = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  const idStr = String(req.params.id);
  const productIdNum = parseInt(idStr, 10);
  const { price, machine_id, is_available } = req.body;
  const queryMachineId = typeof req.query.machine_id === 'string' ? req.query.machine_id.trim() : '';
  const targetMachineId = (machine_id ? String(machine_id).trim() : '') || queryMachineId;
  const db = getDB();

  try {
    const product = await db.get('SELECT * FROM products WHERE id = ?', [productIdNum]);
    if (!product) {
      return next(new NotFoundError(`Product with ID ${idStr} not found`));
    }

    // If a machine_id is provided (or if caller is an owner), update per-machine product override
    if (targetMachineId || req.user?.role === 'owner') {
      if (!targetMachineId) {
        return next(
          new BadRequestError('machine_id is required when updating machine-specific product pricing')
        );
      }

      const machine = await assertMachineOwnershipOrAdmin(req.user, targetMachineId);
      const currentMachineProduct = await getAuthoritativeMachineProduct(
        machine.id,
        productIdNum,
        db
      );
      const nextAvailable =
        is_available !== undefined
          ? Boolean(is_available)
          : Boolean(currentMachineProduct?.is_available ?? true);
      const nowIso = new Date().toISOString();

      await db.run(
        'INSERT OR REPLACE INTO machine_products (machine_id, product_id, price, is_available, updated_at) VALUES (?, ?, ?, ?, ?)',
        [machine.id, productIdNum, Number(price), nextAvailable ? 1 : 0, nowIso]
      );

      await updateMachineProductInFirebase(machine.id, productIdNum, {
        price: Number(price),
        is_available: nextAvailable,
        updated_at: nowIso
      });

      logger.info(
        `Machine ${machine.id} product ID ${productIdNum} price updated to ₹${price} (is_available=${nextAvailable})`
      );

      res.status(200).json({
        status: 'success',
        message: `Product price updated for machine ${machine.id}`,
        data: {
          id: productIdNum,
          product_id: productIdNum,
          machine_id: machine.id,
          price: Number(price),
          is_available: nextAvailable
        }
      });
      return;
    }

    if (req.user?.role !== 'admin') {
      return next(new ForbiddenError('Only admin can update global catalog product prices'));
    }

    await db.run('UPDATE products SET price = ? WHERE id = ?', [price, idStr]);
    logger.info(`Global catalog product ID ${idStr} default price updated to ₹${price}`);

    res.status(200).json({
      status: 'success',
      message: 'Product price updated successfully',
      data: { id: productIdNum, price: Number(price) }
    });
  } catch (error) {
    next(error);
  }
};
