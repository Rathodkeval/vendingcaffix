import { Request, Response, NextFunction } from 'express';
import { getDB } from '../config/db';
import { NotFoundError, BadRequestError } from '../utils/errors';
import logger from '../utils/logger';
import { syncOrderToFirebase } from '../utils/firebase';
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

export const getOrders = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  const db = getDB();
  try {
    const orders = await db.all(`
      SELECT o.*, p.name as product_name 
      FROM orders o
      JOIN products p ON o.product_id = p.id
      ORDER BY o.created_at DESC
    `);
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
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  const { product_id, amount, machine_id } = req.body;
  const db = getDB();

  try {
    // 1. Verify Product
    const product = await db.get('SELECT * FROM products WHERE id = ?', [product_id]);
    if (!product) {
      return next(new NotFoundError(`Product ID ${product_id} not found`));
    }

    // 2. Verify Machine
    const machine = await db.get('SELECT * FROM machines WHERE id = ?', [machine_id]);
    if (!machine) {
      return next(new NotFoundError(`Vending machine ID ${machine_id} not registered`));
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
          receipt: orderId
        });
        rpOrderId = rpOrder.id;
      } catch (error) {
        logger.error('Razorpay order creation failed:', error);
        return next(error);
      }
    }
    
    await db.run(
      'INSERT INTO orders (id, product_id, amount, status, machine_id, created_at, razorpay_order_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [orderId, product_id, orderAmount, 'PENDING', machine_id, todayStr, rpOrderId]
    );

    logger.info(`Created PENDING order ${orderId} with Razorpay Order ID ${rpOrderId}`);

    const newOrder = {
      id: orderId,
      product_id,
      product_name: product.name,
      amount: orderAmount,
      status: 'PENDING',
      machine_id,
      created_at: todayStr,
      razorpay_order_id: rpOrderId
    };

    // Sync to Firebase asynchronously
    syncOrderToFirebase(newOrder);

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

export async function executeOrderStatusUpdate(id: string, status: string): Promise<any> {
  const db = getDB();
  
  // 1. Retrieve current order state
  const order = await db.get('SELECT * FROM orders WHERE id = ?', [id]);
  if (!order) {
    throw new NotFoundError(`Order with ID ${id} not found`);
  }

  const currentStatus = order.status;
  const newStatus = status.toUpperCase();

  // 2. Perform ingredient deduction on transition to PAID or PREPARING (if current state is PENDING)
  const transitionToActive = ['PAID', 'PREPARING', 'COMPLETED'].includes(newStatus);
  
  if (currentStatus === 'PENDING' && transitionToActive) {
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

    if (lowerName.includes('vanilla')) {
      vanillaNeeded = 8;
    } else if (lowerName.includes('hazelnut')) {
      hazelnutNeeded = 8;
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

    // Deduct inventory levels
    await db.run(
      `UPDATE inventory SET 
        water_level = water_level - ?,
        coffee_level = coffee_level - ?,
        milk_level = milk_level - ?,
        vanilla_level = vanilla_level - ?,
        hazelnut_level = hazelnut_level - ?
       WHERE machine_id = ?`,
      [waterNeeded, coffeeNeeded, milkNeeded, vanillaNeeded, hazelnutNeeded, order.machine_id]
    );
    
    logger.info(`Deducted ingredients for order ID ${id} on transition from ${currentStatus} to ${newStatus}`);
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

  // If payment is completed and machine_status is not set,
  // mark it as PENDING for the vending machine.
  if (
    updatedOrder.status === "COMPLETED" &&
    !updatedOrder.machine_status
  ) {
    updatedOrder.machine_status = "PENDING";
  }

  // Sync status updates to Firebase
  syncOrderToFirebase(updatedOrder);
}

  return updatedOrder;
}

export const updateOrderStatus = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  const { id } = req.params;
  const { status } = req.body; // PENDING, PAID, PREPARING, COMPLETED, FAILED, CANCELLED

  try {
    const updatedOrder = await executeOrderStatusUpdate(id as string, status as string);
    res.status(200).json({
      status: 'success',
      data: updatedOrder
    });
  } catch (error) {
    next(error);
  }
};
