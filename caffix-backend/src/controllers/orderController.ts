import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { getDB } from '../config/db';
import { AuthRequest, assertMachineOwnershipOrAdmin } from '../middleware/auth';
import {
  NotFoundError,
  BadRequestError,
  ForbiddenError,
  ConflictError,
  ServiceUnavailableError
} from '../utils/errors';
import {
  isVercelProduction,
  isMockSecretValue,
  assertRazorpayEnvironmentIsolation
} from '../utils/security';
import logger from '../utils/logger';
import {
  syncOrderToFirebase,
  commitOrderTransitionInFirebase,
  checkOrderExistsInFirebase,
  getAuthoritativeMachineState,
  getAuthoritativeMachinesList,
  getAuthoritativeMachineProduct,
  getAuthoritativeOrderById,
  getAuthoritativeOrders,
  updateMachineInventoryInFirebase
} from '../utils/firebase';
import { ensureMachineRegisteredInLocalDB } from './kioskController';
import { assertSufficientInventory } from '../utils/inventory';
const Razorpay = require('razorpay');

let cachedRazorpayClient: any = null;
let cachedRazorpaySignature: string | null = null;
let testRazorpayClientOverride: any = null;

export function setRazorpayClientForTesting(client: any | null): void {
  testRazorpayClientOverride = client;
}

export function resolveRazorpayOrderConfig(): {
  isMockMode: boolean;
  razorpayKeyId: string;
  razorpayClient: any;
} {
  assertRazorpayEnvironmentIsolation();
  const razorpayKeyId = (process.env.RAZORPAY_KEY_ID || '').trim();
  const razorpayKeySecret = (process.env.RAZORPAY_KEY_SECRET || '').trim();
  const production = isVercelProduction();

  const hasValidCredentials =
    Boolean(razorpayKeyId) &&
    Boolean(razorpayKeySecret) &&
    !isMockSecretValue(razorpayKeyId) &&
    !isMockSecretValue(razorpayKeySecret);

  if (production && !hasValidCredentials) {
    throw new ServiceUnavailableError(
      'Payment service unavailable: Razorpay credentials (RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET) are missing or mock in Production'
    );
  }

  if (testRazorpayClientOverride && (!production || hasValidCredentials)) {
    return {
      isMockMode: false,
      razorpayKeyId: razorpayKeyId || 'rzp_test_override',
      razorpayClient: testRazorpayClientOverride
    };
  }

  if (!hasValidCredentials) {
    return { isMockMode: true, razorpayKeyId: '', razorpayClient: null };
  }

  const signature = `${razorpayKeyId}|${razorpayKeySecret}`;
  if (!cachedRazorpayClient || cachedRazorpaySignature !== signature) {
    try {
      cachedRazorpayClient = new Razorpay({
        key_id: razorpayKeyId,
        key_secret: razorpayKeySecret
      });
      cachedRazorpaySignature = signature;
    } catch {
      cachedRazorpayClient = null;
      cachedRazorpaySignature = null;
      if (production) {
        throw new ServiceUnavailableError(
          'Payment service unavailable: failed to initialize Razorpay client in Production'
        );
      }
      logger.warn('Failed to initialize Razorpay client, running in mock mode');
      return { isMockMode: true, razorpayKeyId: '', razorpayClient: null };
    }
  }

  return {
    isMockMode: false,
    razorpayKeyId,
    razorpayClient: cachedRazorpayClient
  };
}

// Per-order mutex to prevent race conditions on concurrent payment verification / webhook callbacks
const orderUpdateLocks = new Map<string, Promise<any>>();

export const MAX_ORDER_ID_ATTEMPTS = 8;

export function generateCandidateOrderId(): string {
  // Preserves 'CFX-' prefix and numeric format while using CSPRNG across a 90M ID space
  return `CFX-${crypto.randomInt(10000000, 100000000)}`;
}

let customOrderIdGenerator: (() => string) | null = null;

export function setOrderIdGeneratorForTesting(generator: (() => string) | null): void {
  customOrderIdGenerator = generator;
}

function isOrderIdCollisionError(error: any): boolean {
  const msg = String(error?.message || error || '');
  return (
    msg.includes('UNIQUE constraint failed') ||
    msg.includes('SQLITE_CONSTRAINT') ||
    msg.includes('ORDER_ID_COLLISION')
  );
}

export const getOrders = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  const db = getDB();
  try {
    const queryMachineId = typeof req.query.machine_id === 'string' ? req.query.machine_id.trim() : '';

    if (req.user?.role === 'owner') {
      if (queryMachineId) {
        const machine = await assertMachineOwnershipOrAdmin(req.user, queryMachineId);
        const orders = await getAuthoritativeOrders(db, [machine.id]);
        res.status(200).json({
          status: 'success',
          data: orders
        });
        return;
      }

      const machines = await getAuthoritativeMachinesList(db);
      const ownedMachineIds = machines
        .filter((m) => m.owner_id && String(m.owner_id).trim() === String(req.user!.id).trim())
        .map((m) => String(m.id));
      const orders = await getAuthoritativeOrders(db, ownedMachineIds);
      res.status(200).json({
        status: 'success',
        data: orders
      });
      return;
    }

    const isKioskScoped =
      req.user?.role === 'kiosk' ||
      (req.user?.role === 'admin' && req.user?.scope === 'kiosk_admin');

    if (isKioskScoped) {
      if (req.user?.machine_id && queryMachineId && queryMachineId !== req.user.machine_id) {
        return next(
          new ForbiddenError(
            `Kiosk session bound to ${req.user.machine_id} cannot query orders for ${queryMachineId}`
          )
        );
      }
      const targetMachineId = queryMachineId || req.user?.machine_id || '';
      const orders = await getAuthoritativeOrders(
        db,
        targetMachineId ? [targetMachineId] : []
      );
      res.status(200).json({
        status: 'success',
        data: orders
      });
      return;
    }

    // Admin role
    const orders = queryMachineId
      ? await getAuthoritativeOrders(db, [queryMachineId])
      : await getAuthoritativeOrders(db);

    res.status(200).json({
      status: 'success',
      data: orders
    });
  } catch (error) {
    next(error);
  }
};

export const getOrderById = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  const id = String(req.params.id);
  const db = getDB();
  try {
    const order = await getAuthoritativeOrderById(id, db);
    
    if (!order) {
      return next(new NotFoundError(`Order with ID ${id} not found`));
    }

    if (req.user?.role === 'owner') {
      await assertMachineOwnershipOrAdmin(req.user, order.machine_id);
    } else if (
      (req.user?.role === 'kiosk' || (req.user?.role === 'admin' && req.user?.scope === 'kiosk_admin')) &&
      req.user.machine_id &&
      req.user.machine_id !== order.machine_id
    ) {
      return next(
        new ForbiddenError(
          `Kiosk ${req.user.machine_id} cannot access order ${id} belonging to machine ${order.machine_id}`
        )
      );
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

    // Enforce machine identity binding if the kiosk or kiosk_admin JWT is scoped to a specific machine
    const isKioskScoped =
      req.user?.role === 'kiosk' ||
      (req.user?.role === 'admin' && req.user?.scope === 'kiosk_admin');
    if (isKioskScoped && req.user?.machine_id && req.user.machine_id !== requestedMachineId) {
      logger.warn(`Blocked order creation with mismatched machine_id: JWT=${req.user.machine_id}, body=${requestedMachineId}`);
      return next(new ForbiddenError(`Authenticated kiosk (${req.user.machine_id}) cannot place orders for machine ${requestedMachineId}`));
    }

    const resolvedMachineId = (isKioskScoped && req.user?.machine_id)
      ? req.user.machine_id
      : requestedMachineId;

    if (req.user?.role === 'owner') {
      await assertMachineOwnershipOrAdmin(req.user, resolvedMachineId);
    }

    // 1. Verify Product exists in global catalog
    const product = await db.get('SELECT * FROM products WHERE id = ?', [product_id]);
    if (!product) {
      return next(new NotFoundError(`Product ID ${product_id} not found`));
    }

    // 2. Verify Machine registration & authoritative desired_mode / status
    const registered = await ensureMachineRegisteredInLocalDB(resolvedMachineId);
    if (!registered) {
      return next(new NotFoundError(`Vending machine ID ${resolvedMachineId} not registered`));
    }
    const machine = (await getAuthoritativeMachineState(resolvedMachineId, db)) || registered;
    if (machine.desired_mode === 'MAINTENANCE' || machine.status === 'maintenance') {
      return next(new BadRequestError('Machine is currently under maintenance mode'));
    }

    // 3. Resolve authoritative machine-specific product pricing and availability
    const machineProduct = await getAuthoritativeMachineProduct(
      resolvedMachineId,
      Number(product_id),
      db
    );
    if (!machineProduct) {
      return next(new NotFoundError(`Product ID ${product_id} not found for machine ${resolvedMachineId}`));
    }

    if (!machineProduct.is_available) {
      return next(
        new BadRequestError(
          `Product "${machineProduct.name}" is currently unavailable on machine ${resolvedMachineId}`
        )
      );
    }

    const authoritativePrice = Number(machineProduct.price);
    if (amount !== undefined && amount !== null && Number(amount) !== authoritativePrice) {
      logger.warn(
        `Rejected manipulated or mismatched frontend order amount on machine ${resolvedMachineId}: product_id=${product_id}, frontend_amount=${amount}, authoritative_price=${authoritativePrice}`
      );
      return next(
        new BadRequestError(
          `Invalid order amount: expected ₹${authoritativePrice} for ${machineProduct.name} on machine ${resolvedMachineId}, received ₹${amount}`
        )
      );
    }

    // 3b. Validate authoritative machine inventory BEFORE creating Razorpay order
    const machineInventory = await db.get('SELECT * FROM inventory WHERE machine_id = ?', [resolvedMachineId]);
    assertSufficientInventory(
      machineInventory,
      machineProduct.name || product.name,
      resolvedMachineId
    );

    const { isMockMode, razorpayKeyId, razorpayClient } = resolveRazorpayOrderConfig();

    // 4. Reserve a collision-free order ID and create order in PENDING status with authoritative per-machine price
    const todayStr = new Date().toISOString();
    const orderAmount = authoritativePrice;
    let allocatedOrderId: string | null = null;
    let rpOrderId = `order_mock_${crypto.randomInt(100000, 1000000)}`;
    let newOrder: any = null;

    for (let attempt = 1; attempt <= MAX_ORDER_ID_ATTEMPTS; attempt++) {
      const candidateId = String(
        (customOrderIdGenerator || generateCandidateOrderId)()
      ).trim();

      if (!candidateId.startsWith('CFX-')) {
        logger.warn(`Invalid generated order ID candidate on attempt ${attempt}/${MAX_ORDER_ID_ATTEMPTS}`);
        continue;
      }

      const existingLocal = await db.get('SELECT id FROM orders WHERE id = ?', [candidateId]);
      if (existingLocal) {
        logger.warn(`Order ID collision avoided in local DB for ${candidateId} (attempt ${attempt}/${MAX_ORDER_ID_ATTEMPTS})`);
        continue;
      }

      const existsRemote = await checkOrderExistsInFirebase(candidateId);
      if (existsRemote) {
        logger.warn(`Order ID collision avoided in Firestore for ${candidateId} (attempt ${attempt}/${MAX_ORDER_ID_ATTEMPTS})`);
        continue;
      }

      const initialRpOrderId = !isMockMode && razorpayClient ? null : rpOrderId;

      try {
        await db.run(
          'INSERT INTO orders (id, product_id, amount, status, machine_id, created_at, razorpay_order_id, extra_sugar, base) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
          [candidateId, product_id, orderAmount, 'PENDING', resolvedMachineId, todayStr, initialRpOrderId, 1, base || 'water']
        );
      } catch (insertError: any) {
        if (isOrderIdCollisionError(insertError)) {
          logger.warn(`Concurrent order ID insert collision on ${candidateId} (attempt ${attempt}/${MAX_ORDER_ID_ATTEMPTS})`);
          continue;
        }
        throw insertError;
      }

      if (!isMockMode && razorpayClient) {
        try {
          const rpOrder = await razorpayClient.orders.create({
            amount: orderAmount * 100, // in paise
            currency: 'INR',
            receipt: candidateId,
            notes: {
              machine_id: resolvedMachineId,
              order_id: candidateId,
              coffee: product.name
            }
          });
          if (!rpOrder || !rpOrder.id) {
            throw new ServiceUnavailableError('Razorpay order creation returned no order ID');
          }
          rpOrderId = rpOrder.id;
          await db.run('UPDATE orders SET razorpay_order_id = ? WHERE id = ?', [rpOrderId, candidateId]);
        } catch (rpError) {
          await db.run('DELETE FROM orders WHERE id = ?', [candidateId]).catch(() => {});
          logger.error('Razorpay order creation failed:', rpError);
          return next(rpError);
        }
      }

      const candidateOrder = {
        id: candidateId,
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

      try {
        // Sync to Firebase with createOnly guard so an existing Firestore order is never overwritten
        await syncOrderToFirebase(candidateOrder, { createOnly: true });
      } catch (firebaseError: any) {
        await db.run('DELETE FROM orders WHERE id = ?', [candidateId]).catch(() => {});
        if (isOrderIdCollisionError(firebaseError)) {
          logger.warn(`Firestore order ID collision for ${candidateId} (attempt ${attempt}/${MAX_ORDER_ID_ATTEMPTS})`);
          continue;
        }
        throw firebaseError;
      }

      allocatedOrderId = candidateId;
      newOrder = candidateOrder;
      break;
    }

    if (!allocatedOrderId || !newOrder) {
      return next(
        new ServiceUnavailableError(
          'Unable to generate a unique order ID after multiple attempts. Please retry.'
        )
      );
    }

    logger.info(`Created PENDING order ${allocatedOrderId} for machine ${resolvedMachineId} (price=₹${orderAmount}) with Razorpay Order ID ${rpOrderId}`);

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

export interface OrderPaymentMetadata {
  razorpayPaymentId?: string | null;
  razorpaySignature?: string | null;
  allowPaidOrderRecovery?: boolean;
  allowPaidOrderNoop?: boolean;
  onTransitionOutcome?: (outcome: { didTransition: boolean; finalStatus: string }) => void;
}

function isOrderPaidOrActive(order: any): boolean {
  const status = String(order?.status || 'PENDING').toUpperCase();
  const dispenseStatus = String(order?.dispense_status || '').toUpperCase();
  return (
    ['PAID', 'PREPARING', 'COMPLETED'].includes(status) ||
    ['QUEUED', 'DISPENSING', 'DISPENSED'].includes(dispenseStatus) ||
    order?.dispensed === true
  );
}

async function assertCanModifyOrder(user: AuthRequest['user'], existing: any): Promise<void> {
  if (
    user?.role === 'kiosk' ||
    (user?.role === 'admin' && user?.scope === 'kiosk_admin')
  ) {
    if (!user.machine_id || user.machine_id !== existing.machine_id) {
      throw new ForbiddenError(
        `Kiosk ${user.machine_id || 'unknown'} cannot modify order ${existing.id} belonging to machine ${existing.machine_id}`
      );
    }
  }

  if (user?.role === 'owner') {
    await assertMachineOwnershipOrAdmin(user, existing.machine_id);
  }
}

async function fetchFormattedOrder(db: any, id: string): Promise<any> {
  const row = await db.get(
    `SELECT o.*, p.name as product_name
     FROM orders o
     JOIN products p ON o.product_id = p.id
     WHERE o.id = ?`,
    [id]
  );
  if (row) {
    row.extra_sugar = 1;
    row.coffee = row.product_name;
  }
  return row;
}

async function syncLocalInventoryFromLevels(db: any, machineId: string, levels: any): Promise<void> {
  if (!levels) return;
  await db.run(
    `UPDATE inventory SET
      milk_level = ?,
      coffee_level = ?,
      vanilla_level = ?,
      hazelnut_level = ?,
      irish_level = ?,
      mocha_level = ?,
      water_level = ?,
      updated_at = ?
     WHERE machine_id = ?`,
    [
      Number(levels.milk_level ?? 100),
      Number(levels.coffee_level ?? 100),
      Number(levels.vanilla_level ?? 100),
      Number(levels.hazelnut_level ?? 100),
      Number(levels.irish_level ?? 100),
      Number(levels.mocha_level ?? 100),
      Number(levels.water_level ?? 100),
      new Date().toISOString(),
      machineId
    ]
  );
}

async function performOrderStatusUpdateInternal(
  id: string,
  status: string,
  paymentMetadata?: OrderPaymentMetadata
): Promise<any> {
  const db = getDB();

  // 1. Retrieve current order state (hydrating from Firestore if needed after a serverless cold start)
  const order = await getAuthoritativeOrderById(id, db);
  if (!order) {
    throw new NotFoundError(`Order with ID ${id} not found`);
  }

  const currentStatus = String(order.status || 'PENDING').toUpperCase();
  const currentDispense = String(order.dispense_status || '').toUpperCase();
  const newStatus = String(status).toUpperCase();
  const alreadyPaidOrActive = isOrderPaidOrActive(order);
  const isNonPaidTarget = ['FAILED', 'CANCELLED', 'PENDING'].includes(newStatus);
  const transitionToActive = ['PAID', 'PREPARING', 'COMPLETED'].includes(newStatus);
  const isClosedUnpaidOrigin = currentStatus === 'FAILED' || currentStatus === 'CANCELLED';

  // Idempotency guard: if already in the requested status, or already PAID/PREPARING/COMPLETED when a late PAID arrives,
  // return current order without re-deducting ingredients or re-triggering Firestore writes
  if (
    currentStatus === newStatus ||
    (currentStatus === 'COMPLETED' && (newStatus === 'PAID' || newStatus === 'PREPARING')) ||
    ((currentStatus === 'PAID' || currentStatus === 'PREPARING') && newStatus === 'PAID')
  ) {
    logger.info(`Idempotent status update ignored for order ${id} (current: ${currentStatus}, requested: ${newStatus})`);
    const existingOrder = await fetchFormattedOrder(db, id);
    paymentMetadata?.onTransitionOutcome?.({
      didTransition: false,
      finalStatus: String(existingOrder?.status || currentStatus).toUpperCase()
    });
    return existingOrder;
  }

  // Never allow paid/completed/dispensing/dispensed orders to be downgraded or overwritten by FAILED/CANCELLED/PENDING,
  // and never mutate an already-COMPLETED or DISPENSED order.
  if (
    (isNonPaidTarget && alreadyPaidOrActive) ||
    currentStatus === 'COMPLETED' ||
    currentDispense === 'DISPENSED' ||
    order.dispensed === true ||
    (isNonPaidTarget && currentStatus !== 'PENDING') ||
    (isClosedUnpaidOrigin && !(paymentMetadata?.allowPaidOrderRecovery && newStatus === 'PAID'))
  ) {
    if (paymentMetadata?.allowPaidOrderNoop) {
      logger.info(`Webhook/idempotent transition ignored for order ${id} (current: ${currentStatus}, requested: ${newStatus})`);
      const existingOrder = await fetchFormattedOrder(db, id);
      paymentMetadata?.onTransitionOutcome?.({
        didTransition: false,
        finalStatus: String(existingOrder?.status || currentStatus).toUpperCase()
      });
      return existingOrder;
    }
    if (isNonPaidTarget && isClosedUnpaidOrigin) {
      logger.info(`Closed unpaid order ${id} kept in ${currentStatus} (requested: ${newStatus})`);
      const existingOrder = await fetchFormattedOrder(db, id);
      paymentMetadata?.onTransitionOutcome?.({
        didTransition: false,
        finalStatus: String(existingOrder?.status || currentStatus).toUpperCase()
      });
      return existingOrder;
    }
    throw new ConflictError(`Cannot transition order ${id} from ${currentStatus} to ${newStatus}`);
  }

  // 2. Prepare inventory deduction context ONLY when transitioning an eligible unpaid order -> active paid status
  let inventory: any = null;
  let product: any = null;
  let requirements: ReturnType<typeof assertSufficientInventory> | null = null;
  const eligibleForInventoryDeduction =
    (currentStatus === 'PENDING' ||
      (Boolean(paymentMetadata?.allowPaidOrderRecovery) && isClosedUnpaidOrigin && newStatus === 'PAID')) &&
    transitionToActive &&
    currentDispense !== 'DISPENSING' &&
    currentDispense !== 'DISPENSED' &&
    order.dispensed !== true;

  if (eligibleForInventoryDeduction) {
    await ensureMachineRegisteredInLocalDB(order.machine_id);
    await getAuthoritativeMachineState(order.machine_id, db);
    inventory = await db.get('SELECT * FROM inventory WHERE machine_id = ?', [order.machine_id]);
    if (!inventory) {
      throw new BadRequestError(`Inventory record not found for machine ${order.machine_id}`);
    }

    product = await db.get('SELECT * FROM products WHERE id = ?', [order.product_id]);
    if (!product) {
      throw new NotFoundError(`Product ID ${order.product_id} not found`);
    }

    requirements = assertSufficientInventory(inventory, product.name, order.machine_id);
  }

  // 3. Execute atomic Firestore transaction first (authoritative cross-instance guard)
  const firebaseTransition = await commitOrderTransitionInFirebase({
    order: {
      ...order,
      product_name: product?.name || order.product_name,
      coffee: product?.name || order.product_name
    },
    targetStatus: newStatus,
    productName: product?.name || order.product_name,
    razorpayPaymentId: paymentMetadata?.razorpayPaymentId,
    razorpaySignature: paymentMetadata?.razorpaySignature,
    requirements,
    fallbackInventory: inventory,
    allowPaidOrderRecovery: paymentMetadata?.allowPaidOrderRecovery
  });

  if (firebaseTransition !== null) {
    if (firebaseTransition.alreadyProcessed) {
      const authOrder = firebaseTransition.authoritativeOrder;
      if (authOrder?.status) {
        await db.run('UPDATE orders SET status = ? WHERE id = ?', [
          String(authOrder.status).toUpperCase(),
          id
        ]);
      }
      if (authOrder?.razorpay_payment_id && !order.razorpay_payment_id) {
        await db.run('UPDATE orders SET razorpay_payment_id = ?, razorpay_signature = ? WHERE id = ?', [
          authOrder.razorpay_payment_id,
          authOrder.razorpay_signature || null,
          id
        ]);
      }
      if (firebaseTransition.updatedEstimatedInventory) {
        await syncLocalInventoryFromLevels(
          db,
          order.machine_id,
          firebaseTransition.updatedEstimatedInventory
        );
      }
      if (firebaseTransition.rejectedByStateGuard && !paymentMetadata?.allowPaidOrderNoop) {
        throw new ConflictError(
          `Cannot transition order ${id} from ${authOrder?.status || currentStatus} to ${newStatus}`
        );
      }
      logger.info(
        `Cross-instance idempotent transition skipped for order ${id} (Firestore status: ${authOrder?.status || currentStatus})`
      );
      const latestOrder = await fetchFormattedOrder(db, id);
      paymentMetadata?.onTransitionOutcome?.({
        didTransition: false,
        finalStatus: String(latestOrder?.status || authOrder?.status || currentStatus).toUpperCase()
      });
      return latestOrder;
    }

    if (firebaseTransition.didDeductInventory && firebaseTransition.updatedEstimatedInventory) {
      await syncLocalInventoryFromLevels(
        db,
        order.machine_id,
        firebaseTransition.updatedEstimatedInventory
      );
      logger.info(
        `Deducted ingredients atomically for order ID ${id} (machine ${order.machine_id}) on transition from ${currentStatus} to ${newStatus}`
      );
    }

    if (
      firebaseTransition.authoritativeOrder?.razorpay_payment_id ||
      firebaseTransition.authoritativeOrder?.razorpay_signature
    ) {
      await db.run('UPDATE orders SET razorpay_payment_id = ?, razorpay_signature = ? WHERE id = ?', [
        firebaseTransition.authoritativeOrder.razorpay_payment_id || null,
        firebaseTransition.authoritativeOrder.razorpay_signature || null,
        id
      ]);
    }
    await db.run('UPDATE orders SET status = ? WHERE id = ?', [newStatus, id]);
    logger.info(`Updated order ${id} status from ${currentStatus} to ${newStatus}`);
    const updatedOrder = await fetchFormattedOrder(db, id);
    paymentMetadata?.onTransitionOutcome?.({
      didTransition: Boolean(firebaseTransition.didTransition),
      finalStatus: String(updatedOrder?.status || newStatus).toUpperCase()
    });
    return updatedOrder;
  }

  // 4. Local SQLite / MockDatabase atomic fallback when Firestore is not configured
  if (eligibleForInventoryDeduction && requirements) {
    const claimSql = paymentMetadata?.allowPaidOrderRecovery
      ? `UPDATE orders SET status = ?, razorpay_payment_id = COALESCE(razorpay_payment_id, ?), razorpay_signature = COALESCE(razorpay_signature, ?) WHERE id = ? AND status IN ('PENDING', 'CANCELLED', 'FAILED')`
      : `UPDATE orders SET status = ?, razorpay_payment_id = COALESCE(razorpay_payment_id, ?), razorpay_signature = COALESCE(razorpay_signature, ?) WHERE id = ? AND status = 'PENDING'`;
    const claimResult = await db.run(claimSql, [
      newStatus,
      paymentMetadata?.razorpayPaymentId || null,
      paymentMetadata?.razorpaySignature || null,
      id
    ]);
    if (!claimResult || Number(claimResult.changes ?? 0) === 0) {
      logger.info(`Concurrent local status claim skipped for order ${id}; order is no longer eligible`);
      const latestOrder = await fetchFormattedOrder(db, id);
      paymentMetadata?.onTransitionOutcome?.({
        didTransition: false,
        finalStatus: String(latestOrder?.status || currentStatus).toUpperCase()
      });
      return latestOrder;
    }

    await db.run(
      `UPDATE inventory SET 
        water_level = water_level - ?,
        coffee_level = coffee_level - ?,
        milk_level = milk_level - ?,
        vanilla_level = vanilla_level - ?,
        hazelnut_level = hazelnut_level - ?,
        irish_level = irish_level - ?,
        mocha_level = mocha_level - ?,
        updated_at = ?
       WHERE machine_id = ?`,
      [
        requirements.water,
        requirements.coffee,
        requirements.milk,
        requirements.vanilla,
        requirements.hazelnut,
        requirements.irish,
        requirements.mocha,
        new Date().toISOString(),
        order.machine_id
      ]
    );

    const updatedInventory = await db.get('SELECT * FROM inventory WHERE machine_id = ?', [order.machine_id]);
    if (updatedInventory) {
      await updateMachineInventoryInFirebase(order.machine_id, updatedInventory);
    }

    logger.info(`Deducted ingredients for order ID ${id} (machine ${order.machine_id}) on transition from ${currentStatus} to ${newStatus}`);
  } else if (isNonPaidTarget && (newStatus === 'FAILED' || newStatus === 'CANCELLED')) {
    const cancelResult = await db.run(
      `UPDATE orders SET status = ? WHERE id = ? AND status = 'PENDING'`,
      [newStatus, id]
    );
    if (!cancelResult || Number(cancelResult.changes ?? 0) === 0) {
      const latest = await fetchFormattedOrder(db, id);
      if (isOrderPaidOrActive(latest)) {
        if (paymentMetadata?.allowPaidOrderNoop) {
          paymentMetadata?.onTransitionOutcome?.({
            didTransition: false,
            finalStatus: String(latest?.status || currentStatus).toUpperCase()
          });
          return latest;
        }
        throw new ConflictError(`Cannot transition order ${id} from ${latest.status} to ${newStatus}`);
      }
      paymentMetadata?.onTransitionOutcome?.({
        didTransition: false,
        finalStatus: String(latest?.status || currentStatus).toUpperCase()
      });
      return latest;
    }
  } else {
    if (paymentMetadata?.razorpayPaymentId || paymentMetadata?.razorpaySignature) {
      await db.run(
        `UPDATE orders SET razorpay_payment_id = ?, razorpay_signature = ? WHERE id = ?`,
        [
          paymentMetadata.razorpayPaymentId || order.razorpay_payment_id || null,
          paymentMetadata.razorpaySignature || order.razorpay_signature || null,
          id
        ]
      );
    }
    await db.run('UPDATE orders SET status = ? WHERE id = ?', [newStatus, id]);
  }

  logger.info(`Updated order ${id} status from ${currentStatus} to ${newStatus}`);

  const updatedOrder = await fetchFormattedOrder(db, id);
  if (updatedOrder) {
    await syncOrderToFirebase(updatedOrder);
  }
  paymentMetadata?.onTransitionOutcome?.({
    didTransition: true,
    finalStatus: String(updatedOrder?.status || newStatus).toUpperCase()
  });

  return updatedOrder;
}

export async function executeOrderStatusUpdate(
  id: string,
  status: string,
  paymentMetadata?: OrderPaymentMetadata
): Promise<any> {
  const prevLock = orderUpdateLocks.get(id) || Promise.resolve();
  const nextPromise = prevLock
    .catch(() => {})
    .then(() => performOrderStatusUpdateInternal(id, status, paymentMetadata));

  orderUpdateLocks.set(id, nextPromise);
  try {
    return await nextPromise;
  } finally {
    if (orderUpdateLocks.get(id) === nextPromise) {
      orderUpdateLocks.delete(id);
    }
  }
}

export const cancelOrder = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  const id = String(req.params.id);
  const { razorpay_order_id: requestedRpOrderId, reason } = req.body || {};
  const db = getDB();

  try {
    const existing = await getAuthoritativeOrderById(id, db);
    if (!existing) {
      return next(new NotFoundError(`Order with ID ${id} not found`));
    }

    await assertCanModifyOrder(req.user, existing);

    if (
      requestedRpOrderId &&
      existing.razorpay_order_id &&
      String(requestedRpOrderId).trim() !== String(existing.razorpay_order_id).trim()
    ) {
      return next(new BadRequestError('Razorpay Order ID does not match the specified order'));
    }

    if (isOrderPaidOrActive(existing)) {
      res.status(409).json({
        status: 'error',
        code: 'ORDER_ALREADY_PAID',
        message: `Cannot cancel order ${id} because payment/dispense is already ${existing.status}`,
        data: existing
      });
      return;
    }

    const currentStatus = String(existing.status || 'PENDING').toUpperCase();
    if (currentStatus === 'CANCELLED' || currentStatus === 'FAILED') {
      const currentOrder = (await fetchFormattedOrder(db, id)) || existing;
      res.status(200).json({
        status: 'success',
        data: currentOrder
      });
      return;
    }

    try {
      const updatedOrder = await executeOrderStatusUpdate(id, 'CANCELLED');
      logger.info(
        `Order ${id} cancelled for machine ${existing.machine_id} (reason: ${reason || 'unspecified'})`
      );
      res.status(200).json({
        status: 'success',
        data: updatedOrder
      });
    } catch (err: any) {
      if (err instanceof ConflictError) {
        const latestOrder = (await getAuthoritativeOrderById(id, db)) || existing;
        res.status(409).json({
          status: 'error',
          code: 'ORDER_ALREADY_PAID',
          message: err.message,
          data: latestOrder
        });
        return;
      }
      throw err;
    }
  } catch (error) {
    next(error);
  }
};

export const updateOrderStatus = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  const id = String(req.params.id);
  const { status } = req.body; // PENDING, PAID, PREPARING, COMPLETED, FAILED, CANCELLED
  const requestedStatus = String(status || '').toUpperCase();
  const db = getDB();

  try {
    const existing = await getAuthoritativeOrderById(id, db);
    if (!existing) {
      return next(new NotFoundError(`Order with ID ${id} not found`));
    }

    await assertCanModifyOrder(req.user, existing);

    const currentStatus = String(existing.status || 'PENDING').toUpperCase();
    const currentDispense = String(existing.dispense_status || '').toUpperCase();
    const alreadyPaidOrActive = isOrderPaidOrActive(existing);

    if (req.user?.role === 'kiosk') {
      // Customers cannot mark unpaid orders as PAID/PREPARING/COMPLETED without payment verification,
      // nor manually force FAILED, nor downgrade/alter PAID/PREPARING/COMPLETED/DISPENSED orders.
      if (['PENDING', 'CANCELLED', 'FAILED'].includes(currentStatus) && requestedStatus !== 'CANCELLED') {
        return next(
          new ForbiddenError(
            `Kiosk session cannot manually change unpaid order ${id} from ${currentStatus} to ${requestedStatus}`
          )
        );
      }

      if (alreadyPaidOrActive) {
        if (currentStatus === 'COMPLETED' || currentDispense === 'DISPENSED' || existing.dispensed === true) {
          return next(
            new ForbiddenError(
              `Customers cannot change completed order ${id} status (${currentStatus} -> ${requestedStatus})`
            )
          );
        }

        if (!['PREPARING', 'COMPLETED'].includes(requestedStatus)) {
          return next(
            new ForbiddenError(
              `Customers cannot change paid order ${id} from ${currentStatus} to ${requestedStatus}`
            )
          );
        }

        if (currentStatus === 'PREPARING' && requestedStatus !== 'COMPLETED') {
          return next(
            new ForbiddenError(
              `Customers cannot change preparing order ${id} to ${requestedStatus}`
            )
          );
        }
      }
    }

    const updatedOrder = await executeOrderStatusUpdate(id, requestedStatus);
    res.status(200).json({
      status: 'success',
      data: updatedOrder
    });
  } catch (error) {
    next(error);
  }
};
