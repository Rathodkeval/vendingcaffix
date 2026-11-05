import { Request, Response, NextFunction } from 'express';
import { getDB } from '../config/db';
import { AuthRequest } from '../middleware/auth';
import { NotFoundError, BadRequestError, ForbiddenError } from '../utils/errors';
import logger from '../utils/logger';
import { syncOrderToFirebase } from '../utils/firebase';
import { ensureMachineRegisteredInLocalDB } from './kioskController';
const Razorpay = require('razorpay');

const razorpayKeyId = (process.env.RAZORPAY_KEY_ID || '').trim();
const razorpayKeySecret = (process.env.RAZORPAY_KEY_SECRET || '').trim();

const isMockMode = !razorpayKeyId || razorpayKeyId.includes('mock') || !razorpayKeySecret || razorpayKeySecret.includes('mock');

let razorpayClient: any = null;
if (!isMockMode) {
  try {
    razorpayClient = new Razorpay({
      key_id: razorpayKeyId,
      key_secret: razorpayKeySecret
    });
  } catch (error) {
    logger.warn('Failed to initialize Razorpay client, running in mock mode', error);
  }
}

// Per-order mutex to prevent race conditions on concurrent payment verification / webhook callbacks
const orderUpdateLocks = new Map<string, Promise<any>>();

export const getOrders = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  const db = getDB();
  try {
    const queryMachineId = typeof req.query.machine_id === 'string' ? req.query.machine_id.trim() : '';
    const filterMachineId = queryMachineId || req.user?.machine_id || '';

    let orders: any[];
    if (filterMachineId) {
      orders = await db.all(`
        SELECT o.*, p.name as product_name 
        FROM orders o
        JOIN products p ON o.product_id = p.id
        WHERE o.machine_id = ?
        ORDER BY o.created_at DESC
      `, [filterMachineId]);
    } else {
      orders = await db.all(`
        SELECT o.*, p.name as product_name 
        FROM orders o
        JOIN products p ON o.product_id = p.id
        ORDER BY o.created_at DESC
      `);
    }

    res.status(200).json({
      status: 'success',
      data: orders
    });
  } catch (error) {
    next(error);
  }
};

export const getOrderById = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  const { id } = req.params;
  const db = getDB();
  try {
    const order = await db.get(`
      SELECT o.*, p.name as product_name, p.description as product_desc
      FROM orders o
      JOIN products p ON o.product_id = p.id
      WHERE o.id = ?
    `, [id]);
    
    if (!order) {
      return next(new NotFoundError(`Order with ID ${id} not found`));
    }

    res.status(200).json({
      status: 'success',
      data: order
    });
  } catch (error) {
    next(error);
  }
};

export const createOrder = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  const { product_id, amount, machine_id, extra_sugar, base } = req.body;
  const db = getDB();

  try {
    const requestedMachineId = typeof machine_id === 'string' ? machine_id.trim() : '';
    if (!requestedMachineId || !/^CFX-MC-\d{2,4}$/.test(requestedMachineId)) {
      return next(new BadRequestError(`Invalid or missing machine_id: "${requestedMachineId}"`));
    }

    // Enforce machine identity binding if the kiosk JWT is scoped to a specific machine
    if (req.user?.role === 'kiosk' && req.user.machine_id && req.user.machine_id !== requestedMachineId) {
      logger.warn(`Blocked order creation with mismatched machine_id: JWT=${req.user.machine_id}, body=${requestedMachineId}`);
      return next(new ForbiddenError(`Authenticated kiosk (${req.user.machine_id}) cannot place orders for machine ${requestedMachineId}`));
    }

    const resolvedMachineId = (req.user?.role === 'kiosk' && req.user.machine_id)
      ? req.user.machine_id
      : requestedMachineId;

    // 1. Verify Product
    const product = await db.get('SELECT * FROM products WHERE id = ?', [product_id]);
    if (!product) {
      return next(new NotFoundError(`Product ID ${product_id} not found`));
    }

    // 2. Verify Machine registration & status
    const machine = await ensureMachineRegisteredInLocalDB(resolvedMachineId);
    if (!machine) {
      return next(new NotFoundError(`Vending machine ID ${resolvedMachineId} not registered`));
    }
    if (machine.status === 'maintenance') {
      return next(new BadRequestError('Machine is currently under maintenance mode'));
    }

    // 3. Create order in PENDING status
    const orderId = 'CFX-' + Math.floor(10000 + Math.random() * 90000);
    const todayStr = new Date().toISOString();
    const orderAmount = amount || product.price;

    let rpOrderId = `order_mock_${Math.floor(100000 + Math.random() * 900000)}`;

    if (!isMockMode && razorpayClient) {
      try {
        const rpOrder = await razorpayClient.orders.create({
          amount: orderAmount * 100, // in paise
          currency: 'INR',
          receipt: orderId,
          notes: {
            machine_id: resolvedMachineId,
            order_id: orderId,
            coffee: product.name
          }
        });
        rpOrderId = rpOrder.id;
      } catch (error) {
        logger.error('Razorpay order creation failed:', error);
        return next(error);
      }
    }
    
    await db.run(
      'INSERT INTO orders (id, product_id, amount, status, machine_id, created_at, razorpay_order_id, extra_sugar, base) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [orderId, product_id, orderAmount, 'PENDING', resolvedMachineId, todayStr, rpOrderId, 1, base || 'water']
    );

    logger.info(`Created PENDING order ${orderId} for machine ${resolvedMachineId} with Razorpay Order ID ${rpOrderId}`);

    const newOrder = {
      id: orderId,
      product_id,
      product_name: product.name,
      coffee: product.name,
      amount: orderAmount,
      status: 'PENDING',
      machine_id: resolvedMachineId,
      created_at: todayStr,
      razorpay_order_id: rpOrderId,
      extra_sugar: 1,
      base: base || 'water'
    };

    // Sync to Firebase before responding so Serverless environments complete the write
    await syncOrderToFirebase(newOrder);

    res.status(201).json({
      status: 'success',
      data: {
        ...newOrder,
        razorpay_key: isMockMode ? 'mock' : razorpayKeyId
      }
    });
  } catch (error) {
    next(error);
  }
};

async function performOrderStatusUpdateInternal(id: string, status: string): Promise<any> {
  const db = getDB();
  
  // 1. Retrieve current order state
  const order = await db.get('SELECT * FROM orders WHERE id = ?', [id]);
  if (!order) {
    throw new NotFoundError(`Order with ID ${id} not found`);
  }

  const currentStatus = order.status;
  const newStatus = status.toUpperCase();

  // Idempotency guard: if already in the requested status, or already COMPLETED when a late PAID webhook arrives,
  // return current order without re-deducting ingredients or re-triggering Firestore writes
  if (
    currentStatus === newStatus ||
    (currentStatus === 'COMPLETED' && (newStatus === 'PAID' || newStatus === 'PREPARING')) ||
    (currentStatus === 'PAID' && newStatus === 'PAID')
  ) {
    logger.info(`Idempotent status update ignored for order ${id} (current: ${currentStatus}, requested: ${newStatus})`);
    const existingOrder = await db.get(`
      SELECT o.*, p.name as product_name 
      FROM orders o
      JOIN products p ON o.product_id = p.id
      WHERE o.id = ?
    `, [id]);
    if (existingOrder) {
      existingOrder.extra_sugar = 1;
      existingOrder.coffee = existingOrder.product_name;
    }
    return existingOrder;
  }

  // 2. Perform ingredient deduction on transition to PAID, PREPARING, or COMPLETED (ONLY if current state is PENDING)
  const transitionToActive = ['PAID', 'PREPARING', 'COMPLETED'].includes(newStatus);
  
  if (currentStatus === 'PENDING' && transitionToActive) {
    await ensureMachineRegisteredInLocalDB(order.machine_id);
    // Fetch machine inventory
    const inventory = await db.get('SELECT * FROM inventory WHERE machine_id = ?', [order.machine_id]);
    if (!inventory) {
      throw new BadRequestError(`Inventory record not found for machine ${order.machine_id}`);
    }

    // Fetch product to see requirements
    const product = await db.get('SELECT * FROM products WHERE id = ?', [order.product_id]);
    if (!product) {
      throw new NotFoundError(`Product ID ${order.product_id} not found`);
    }

    const lowerName = product.name.toLowerCase();
    const waterNeeded = 5;
    const coffeeNeeded = 6;
    const milkNeeded = 5;
    let vanillaNeeded = 0;
    let hazelnutNeeded = 0;
    let irishNeeded = 0;
    let mochaNeeded = 0;

    if (lowerName.includes('vanilla')) {
      vanillaNeeded = 8;
    } else if (lowerName.includes('hazel')) {
      hazelnutNeeded = 8;
    } else if (lowerName.includes('irish')) {
      irishNeeded = 8;
    } else if (lowerName.includes('mocha')) {
      mochaNeeded = 8;
    }

    // Verify availability
    if (inventory.water_level < waterNeeded) {
      throw new BadRequestError('Ingredients depleted: Water refill required');
    }
    if (inventory.coffee_level < coffeeNeeded) {
      throw new BadRequestError('Ingredients depleted: Coffee beans refill required');
    }
    if (inventory.milk_level < milkNeeded) {
      throw new BadRequestError('Ingredients depleted: Milk refill required');
    }
    if (vanillaNeeded > 0 && inventory.vanilla_level < vanillaNeeded) {
      throw new BadRequestError('Ingredients depleted: Vanilla syrup refill required');
    }
    if (hazelnutNeeded > 0 && inventory.hazelnut_level < hazelnutNeeded) {
      throw new BadRequestError('Ingredients depleted: Hazelnut syrup refill required');
    }
    if (irishNeeded > 0 && inventory.irish_level < irishNeeded) {
      throw new BadRequestError('Ingredients depleted: Irish syrup refill required');
    }
    if (mochaNeeded > 0 && inventory.mocha_level < mochaNeeded) {
      throw new BadRequestError('Ingredients depleted: Mocha syrup refill required');
    }

    // Deduct inventory levels
    await db.run(
      `UPDATE inventory SET 
        water_level = water_level - ?,
        coffee_level = coffee_level - ?,
        milk_level = milk_level - ?,
        vanilla_level = vanilla_level - ?,
        hazelnut_level = hazelnut_level - ?,
        irish_level = irish_level - ?,
        mocha_level = mocha_level - ?
       WHERE machine_id = ?`,
      [waterNeeded, coffeeNeeded, milkNeeded, vanillaNeeded, hazelnutNeeded, irishNeeded, mochaNeeded, order.machine_id]
    );
    
    logger.info(`Deducted ingredients for order ID ${id} (machine ${order.machine_id}) on transition from ${currentStatus} to ${newStatus}`);
  }

  // 3. Update order status
  await db.run('UPDATE orders SET status = ? WHERE id = ?', [newStatus, id]);
  logger.info(`Updated order ${id} status from ${currentStatus} to ${newStatus}`);

  const updatedOrder = await db.get(`
    SELECT o.*, p.name as product_name 
    FROM orders o
    JOIN products p ON o.product_id = p.id
    WHERE o.id = ?
  `, [id]);

  if (updatedOrder) {
    updatedOrder.extra_sugar = 1;
    updatedOrder.coffee = updatedOrder.product_name;
    await syncOrderToFirebase(updatedOrder);
  }

  return updatedOrder;
}

export async function executeOrderStatusUpdate(id: string, status: string): Promise<any> {
  const prevLock = orderUpdateLocks.get(id) || Promise.resolve();
  const nextPromise = prevLock
    .catch(() => {})
    .then(() => performOrderStatusUpdateInternal(id, status));

  orderUpdateLocks.set(id, nextPromise);
  try {
    return await nextPromise;
  } finally {
    if (orderUpdateLocks.get(id) === nextPromise) {
      orderUpdateLocks.delete(id);
    }
  }
}

export const updateOrderStatus = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  const id = String(req.params.id);
  const { status } = req.body; // PENDING, PAID, PREPARING, COMPLETED, FAILED, CANCELLED
  const db = getDB();

  try {
    const existing = await db.get('SELECT id, machine_id FROM orders WHERE id = ?', [id]);
    if (!existing) {
      return next(new NotFoundError(`Order with ID ${id} not found`));
    }

    if (req.user?.role === 'kiosk' && req.user.machine_id && req.user.machine_id !== existing.machine_id) {
      return next(new ForbiddenError(`Kiosk ${req.user.machine_id} cannot modify order ${id} belonging to machine ${existing.machine_id}`));
    }

    const updatedOrder = await executeOrderStatusUpdate(id, status as string);
    res.status(200).json({
      status: 'success',
      data: updatedOrder
    });
  } catch (error) {
    next(error);
  }
};
