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
  isMockSecretValue,
  resolveValidatedRazorpayEnvironment
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
  updateMachineInventoryInFirebase,
  isFirestoreActive,
  getFirestoreInstance,
  updateSyncedFirebaseOrder
} from '../utils/firebase';
import { ensureMachineRegisteredInLocalDB } from './kioskController';
import { assertSufficientInventory } from '../utils/inventory';
import { recordOrderDeductionsToLedger } from '../utils/inventoryLedger';
import {
  calculateRemainingRefundableBalance,
  createPendingRefundReservation,
  markRefundProcessed,
  markRefundFailed
} from '../utils/refunds';
import { executeGatewayRefund } from '../utils/razorpayRefundClient';
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
  const env = resolveValidatedRazorpayEnvironment();
  const { strict, mode, keyId: razorpayKeyId, keySecret: razorpayKeySecret } = env;
  const envLabel = mode === 'production' ? 'Production' : 'Preview';

  const hasValidCredentials =
    Boolean(razorpayKeyId) &&
    Boolean(razorpayKeySecret) &&
    !isMockSecretValue(razorpayKeyId) &&
    !isMockSecretValue(razorpayKeySecret);

  if (strict && !hasValidCredentials) {
    throw new ServiceUnavailableError(
      `Payment service unavailable: Razorpay credentials (RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET) are missing or mock in ${envLabel}`
    );
  }

  if (testRazorpayClientOverride && (!strict || hasValidCredentials)) {
    return {
      isMockMode: false,
      razorpayKeyId: razorpayKeyId || 'rzp_test_override',
      razorpayClient: testRazorpayClientOverride
    };
  }

  if (!hasValidCredentials) {
    if (strict) {
      throw new ServiceUnavailableError(
        `Payment service unavailable: mock Razorpay mode is disabled in ${envLabel}`
      );
    }
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
      if (strict) {
        throw new ServiceUnavailableError(
          `Payment service unavailable: failed to initialize Razorpay client in ${envLabel}`
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
          await db.run('DELETE FROM orders WHERE id = ?', [candidateId]).catch(() => { });
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
        await db.run('DELETE FROM orders WHERE id = ?', [candidateId]).catch(() => { });
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
  capturedAmountPaise?: number | null;
  allowPaidOrderRecovery?: boolean;
  allowPaidOrderNoop?: boolean;
  onTransitionOutcome?: (outcome: { didTransition: boolean; finalStatus: string }) => void;
  webhookFencing?: { provider: string; eventId: string; claimCount: number } | null;
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

  // F-1 Fencing Guard: Validate webhook claim generation in SQLite before executing mutation
  if (paymentMetadata?.webhookFencing && db && db.get) {
    const whRow = await db.get(
      'SELECT status, claim_count FROM webhook_events WHERE provider = ? AND event_id = ?',
      [paymentMetadata.webhookFencing.provider, paymentMetadata.webhookFencing.eventId]
    );
    if (whRow) {
      if (whRow.claim_count !== undefined && whRow.claim_count !== paymentMetadata.webhookFencing.claimCount) {
        throw new ConflictError(
          `[STALE_WEBHOOK_WORKER] Webhook claim generation superseded for event ${paymentMetadata.webhookFencing.eventId}: current=${whRow.claim_count}, worker=${paymentMetadata.webhookFencing.claimCount}`
        );
      }
    }
  }

  const currentStatus = String(order.status || 'PENDING').toUpperCase();
  const currentDispense = String(order.dispense_status || '').toUpperCase();
  const newStatus = String(status).toUpperCase();
  const alreadyPaidOrActive = isOrderPaidOrActive(order);
  const isNonPaidTarget = ['FAILED', 'CANCELLED', 'PENDING'].includes(newStatus);
  const transitionToActive = ['PAID', 'PREPARING', 'COMPLETED'].includes(newStatus);
  const isClosedUnpaidOrigin = currentStatus === 'FAILED' || currentStatus === 'CANCELLED';

  // E-1 Dispensing Safety Guard (Authoritative In-Flight / Terminal Refund Check):
  // Strictly reject dispensing transitions (PREPARING, DISPENSING, COMPLETED)
  // if order is fully refunded or has an active in-flight pending refund reservation.
  // Business Rule: Partial refunds with 0 pending reservations (refund_status === 'PARTIAL')
  // permit dispensing of remaining items.
  const isDispensingTarget = ['PREPARING', 'DISPENSING', 'COMPLETED'].includes(newStatus);
  if (isDispensingTarget) {
    const currentRefundStatus = String(order.refund_status || '').toUpperCase();
    const currentPendingPaise = Number(order.pending_refund_amount_paise || 0);

    if (currentRefundStatus === 'FULL') {
      throw new ConflictError(
        `Cannot dispense order ${id}: order is fully refunded (refund_status=FULL)`
      );
    }

    if (currentPendingPaise > 0) {
      throw new ConflictError(
        `Cannot dispense order ${id}: order has pending refund reservation (${currentPendingPaise} paise)`
      );
    }
  }

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

  const isFinalizingDispensedOrder =
    (currentStatus === 'PAID' || currentStatus === 'PREPARING') &&
    newStatus === 'COMPLETED' &&
    (currentDispense === 'DISPENSED' || order.dispensed === true);

  // Never allow paid/completed/dispensing/dispensed orders to be downgraded or overwritten by FAILED/CANCELLED/PENDING,
  // and never mutate an already-COMPLETED or DISPENSED order (except finalizing PAID/PREPARING -> COMPLETED once DISPENSED).
  if (
    (isNonPaidTarget && alreadyPaidOrActive) ||
    currentStatus === 'COMPLETED' ||
    (!isFinalizingDispensedOrder && (currentDispense === 'DISPENSED' || order.dispensed === true)) ||
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
    capturedAmountPaise: paymentMetadata?.capturedAmountPaise,
    requirements,
    fallbackInventory: inventory,
    allowPaidOrderRecovery: paymentMetadata?.allowPaidOrderRecovery,
    webhookFencing: paymentMetadata?.webhookFencing
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
      if (authOrder?.captured_amount_paise !== undefined && authOrder?.captured_amount_paise !== null) {
        await db.run('UPDATE orders SET captured_amount_paise = COALESCE(captured_amount_paise, ?) WHERE id = ?', [
          Number(authOrder.captured_amount_paise),
          id
        ]);
      } else if (paymentMetadata?.capturedAmountPaise !== undefined && paymentMetadata?.capturedAmountPaise !== null) {
        await db.run('UPDATE orders SET captured_amount_paise = COALESCE(captured_amount_paise, ?) WHERE id = ?', [
          Number(paymentMetadata.capturedAmountPaise),
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
          (firebaseTransition as any).conflictReason ||
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
      if (requirements) {
        await recordOrderDeductionsToLedger(db, {
          orderId: id,
          machineId: order.machine_id,
          requirements,
          remainingLevels: firebaseTransition.updatedEstimatedInventory as any
        }).catch((err) => logger.warn(`Failed to record local inventory ledger for order ${id}:`, err));
      }
      logger.info(
        `Deducted ingredients atomically for order ID ${id} (machine ${order.machine_id}) on transition from ${currentStatus} to ${newStatus}`
      );
    }

    if (
      firebaseTransition.authoritativeOrder?.razorpay_payment_id ||
      firebaseTransition.authoritativeOrder?.razorpay_signature ||
      paymentMetadata?.capturedAmountPaise !== undefined
    ) {
      const capPaise = paymentMetadata?.capturedAmountPaise !== undefined && paymentMetadata?.capturedAmountPaise !== null
        ? Number(paymentMetadata.capturedAmountPaise)
        : (firebaseTransition.authoritativeOrder?.captured_amount_paise !== undefined && firebaseTransition.authoritativeOrder?.captured_amount_paise !== null
          ? Number(firebaseTransition.authoritativeOrder.captured_amount_paise)
          : null);
      await db.run('UPDATE orders SET razorpay_payment_id = ?, razorpay_signature = ?, captured_amount_paise = COALESCE(?, captured_amount_paise) WHERE id = ?', [
        firebaseTransition.authoritativeOrder.razorpay_payment_id || null,
        firebaseTransition.authoritativeOrder.razorpay_signature || null,
        capPaise,
        id
      ]);
    }
    await db.run('UPDATE orders SET status = ? WHERE id = ?', [newStatus, id]);
    const syncedDispenseStatus = firebaseTransition.authoritativeOrder?.dispense_status
      ? String(firebaseTransition.authoritativeOrder.dispense_status).toUpperCase()
      : null;
    if (syncedDispenseStatus) {
      await db.run('UPDATE orders SET dispense_status = ? WHERE id = ?', [syncedDispenseStatus, id]);
    }
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
    const claimCapPaise = paymentMetadata?.capturedAmountPaise !== undefined && paymentMetadata?.capturedAmountPaise !== null
      ? Number(paymentMetadata.capturedAmountPaise)
      : null;
    const claimSql = paymentMetadata?.allowPaidOrderRecovery
      ? `UPDATE orders SET status = ?, razorpay_payment_id = COALESCE(razorpay_payment_id, ?), razorpay_signature = COALESCE(razorpay_signature, ?), captured_amount_paise = COALESCE(?, captured_amount_paise) WHERE id = ? AND status IN ('PENDING', 'CANCELLED', 'FAILED')`
      : `UPDATE orders SET status = ?, razorpay_payment_id = COALESCE(razorpay_payment_id, ?), razorpay_signature = COALESCE(razorpay_signature, ?), captured_amount_paise = COALESCE(?, captured_amount_paise) WHERE id = ? AND status = 'PENDING'`;

    let hasLocalTx = false;
    let updatedInventory: any = null;

    try {
      if (db && db.run) {
        await db.run('BEGIN IMMEDIATE TRANSACTION');
        hasLocalTx = true;
      }

      const claimResult = await db.run(claimSql, [
        newStatus,
        paymentMetadata?.razorpayPaymentId || null,
        paymentMetadata?.razorpaySignature || null,
        claimCapPaise,
        id
      ]);

      if (!claimResult || Number(claimResult.changes ?? 0) === 0) {
        if (claimCapPaise !== null) {
          await db.run(
            'UPDATE orders SET captured_amount_paise = COALESCE(captured_amount_paise, ?), razorpay_payment_id = COALESCE(razorpay_payment_id, ?), razorpay_signature = COALESCE(razorpay_signature, ?) WHERE id = ?',
            [claimCapPaise, paymentMetadata?.razorpayPaymentId || null, paymentMetadata?.razorpaySignature || null, id]
          );
        }
        if (hasLocalTx) {
          await db.run('COMMIT');
          hasLocalTx = false;
        }
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

      updatedInventory = await db.get('SELECT * FROM inventory WHERE machine_id = ?', [order.machine_id]);

      // Record inventory deductions to ledger INSIDE the atomic transaction.
      // If ledger insertion fails, it throws and rolls back the status claim and inventory deduction.
      await recordOrderDeductionsToLedger(db, {
        orderId: id,
        machineId: order.machine_id,
        requirements,
        remainingLevels: updatedInventory || {}
      });

      // Commit only after every operation succeeds
      if (hasLocalTx) {
        await db.run('COMMIT');
        hasLocalTx = false;
      }
    } catch (txErr) {
      if (hasLocalTx) {
        try {
          await db.run('ROLLBACK');
        } catch (rbErr) {
          logger.warn('Failed to rollback SQLite offline transaction:', rbErr);
        }
      }
      logger.error(`Offline SQLite transaction failed for order ${id}:`, txErr);
      throw txErr;
    }

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
    if (isDispensingTarget) {
      const updateResult = await db.run(
        `UPDATE orders SET status = ? 
         WHERE id = ? 
           AND (refund_status IS NULL OR refund_status != 'FULL')
           AND (pending_refund_amount_paise IS NULL OR pending_refund_amount_paise = 0)`,
        [newStatus, id]
      );
      if (!updateResult || Number(updateResult.changes ?? 0) === 0) {
        const latest = await fetchFormattedOrder(db, id);
        if (String(latest?.refund_status || '').toUpperCase() === 'FULL') {
          throw new ConflictError(
            `Cannot dispense order ${id}: order is fully refunded (refund_status=FULL)`
          );
        }
        if (Number(latest?.pending_refund_amount_paise || 0) > 0) {
          throw new ConflictError(
            `Cannot dispense order ${id}: order has pending refund reservation (${latest.pending_refund_amount_paise} paise)`
          );
        }
        throw new ConflictError(`Cannot transition order ${id} from ${currentStatus} to ${newStatus}`);
      }
    } else {
      await db.run('UPDATE orders SET status = ? WHERE id = ?', [newStatus, id]);
      const localDispenseStatus =
        newStatus === 'PAID'
          ? 'QUEUED'
          : (newStatus === 'FAILED' || newStatus === 'CANCELLED')
            ? newStatus
            : null;
      if (localDispenseStatus) {
        await db.run('UPDATE orders SET dispense_status = ? WHERE id = ?', [localDispenseStatus, id]);
      }
    }
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
    .catch(() => { })
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

    if (['PREPARING', 'DISPENSING', 'COMPLETED'].includes(requestedStatus)) {
      const currentRefundStatus = String(existing.refund_status || '').toUpperCase();
      const currentPendingRefund = Number(existing.pending_refund_amount_paise || 0);

      if (currentRefundStatus === 'FULL') {
        return next(
          new ConflictError(
            `Cannot transition order ${id} to ${requestedStatus}: order is fully refunded (refund_status=FULL)`
          )
        );
      }

      if (currentPendingRefund > 0) {
        return next(
          new ConflictError(
            `Cannot transition order ${id} to ${requestedStatus}: order has pending refund reservation (${currentPendingRefund} paise)`
          )
        );
      }
    }

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
        const isFinalizingDispensedOrder =
          (currentStatus === 'PAID' || currentStatus === 'PREPARING') &&
          requestedStatus === 'COMPLETED' &&
          (currentDispense === 'DISPENSED' || existing.dispensed === true);

        if (
          currentStatus === 'COMPLETED' ||
          (!isFinalizingDispensedOrder && (currentDispense === 'DISPENSED' || existing.dispensed === true))
        ) {
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

/**
 * Authoritatively persists the exact captured payment amount (in integer paise)
 * for an order, regardless of whether the order was already transitioned to PAID.
 * Idempotent for matching values; logs and rejects conflicting amounts safely.
 */
export async function updateOrderPaymentCapture(
  orderId: string,
  params: {
    capturedAmountPaise: number;
    razorpayPaymentId?: string | null;
    razorpaySignature?: string | null;
  }
): Promise<any> {
  const db = getDB();
  const id = String(orderId).trim();
  const capturedPaise = Number(params.capturedAmountPaise);

  if (!Number.isInteger(capturedPaise) || !Number.isSafeInteger(capturedPaise) || capturedPaise <= 0) {
    throw new BadRequestError('capturedAmountPaise must be a positive safe integer in paise');
  }

  // 1. Authoritative Firestore update if Firestore is active
  if (isFirestoreActive()) {
    const firestore = getFirestoreInstance()!;
    await firestore.runTransaction(async (tx) => {
      const orderRef = firestore.collection('orders').doc(id);
      const snap = await tx.get(orderRef);
      if (!snap.exists) {
        throw new NotFoundError(`Order ${id} not found in Firestore`);
      }
      const data = snap.data() || {};
      const existingCap = data.captured_amount_paise;
      if (existingCap !== undefined && existingCap !== null) {
        if (Number(existingCap) !== capturedPaise) {
          logger.warn(
            `Conflicting captured_amount_paise for order ${id}: existing=${existingCap}, incoming=${capturedPaise}. Rejecting overwrite.`
          );
          return;
        }
        // Matching duplicate: idempotent
        return;
      }

      const updates: any = {
        captured_amount_paise: capturedPaise,
        updated_at: new Date().toISOString()
      };
      if (params.razorpayPaymentId && !data.razorpay_payment_id) {
        updates.razorpay_payment_id = String(params.razorpayPaymentId);
      }
      if (params.razorpaySignature && !data.razorpay_signature) {
        updates.razorpay_signature = String(params.razorpaySignature);
      }
      tx.set(orderRef, updates, { merge: true });
    });
  }

  // 2. Local SQLite / MockDatabase update
  const localOrder = await db.get('SELECT * FROM orders WHERE id = ?', [id]);
  if (localOrder) {
    if (localOrder.captured_amount_paise !== null && localOrder.captured_amount_paise !== undefined) {
      if (Number(localOrder.captured_amount_paise) !== capturedPaise) {
        logger.warn(
          `Conflicting local captured_amount_paise for order ${id}: existing=${localOrder.captured_amount_paise}, incoming=${capturedPaise}. Rejecting overwrite.`
        );
        return await fetchFormattedOrder(db, id);
      }
    } else {
      await db.run(
        `UPDATE orders
         SET captured_amount_paise = ?,
             razorpay_payment_id = COALESCE(razorpay_payment_id, ?),
             razorpay_signature = COALESCE(razorpay_signature, ?)
         WHERE id = ?`,
        [capturedPaise, params.razorpayPaymentId || null, params.razorpaySignature || null, id]
      );
    }
  }

  // 3. Update in-memory mirror store if present
  updateSyncedFirebaseOrder(id, {
    captured_amount_paise: capturedPaise,
    ...(params.razorpayPaymentId ? { razorpay_payment_id: params.razorpayPaymentId } : {})
  });

  return await fetchFormattedOrder(db, id);
}

/**
 * Processes an administrative refund for an order via the Razorpay refund API.
 * Endpoint: POST /api/orders/:id/refund
 *
 * AUTHORIZATION:
 * - Restricted strictly to Super Admin accounts (role === 'admin', scope !== 'kiosk_admin').
 * - Machine Owners and Kiosks are forbidden (HTTP 403).
 *
 * SAFETY INVARIANTS:
 * - Requires exact, verified captured_amount_paise (fail-closed if unknown / NULL).
 * - Checks hardware safety (dispense_status !== 'DISPENSING').
 * - Validates integer paise amount and ensures requested amount <= remaining refundable balance.
 * - Creates atomic pending reservation BEFORE calling the Razorpay gateway.
 * - Handles gateway outcomes: PROCESSED (200), PENDING (202 Accepted), TIMEOUT (504, reservation held), REJECTED (422, reservation failed).
 */
export const refundOrder = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  const orderId = String(req.params.id || '').trim();
  const db = getDB();

  try {
    // 1. Role-based access control: Super Admin ONLY
    if (!req.user || req.user.role !== 'admin' || req.user.scope === 'kiosk_admin') {
      return next(new ForbiddenError('Only Super Admin accounts can initiate refunds'));
    }

    // 2. Fetch authoritative order
    const order = await getAuthoritativeOrderById(orderId, db);
    if (!order) {
      return next(new NotFoundError(`Order with ID ${orderId} not found`));
    }

    // 3. Financial and hardware status guards
    const orderStatus = String(order.status || '').toUpperCase();
    if (!['PAID', 'PREPARING', 'COMPLETED'].includes(orderStatus)) {
      return next(new BadRequestError(`Cannot refund order ${orderId} with non-paid status "${order.status}"`));
    }

    const dispenseStatus = String(order.dispense_status || '').toUpperCase();
    if (dispenseStatus === 'DISPENSING') {
      return next(new ConflictError(`Cannot refund order ${orderId} while beverage is actively dispensing`));
    }

    if (!order.razorpay_payment_id) {
      return next(new BadRequestError(`Cannot refund order ${orderId}: missing razorpay_payment_id`));
    }

    // 4. Exact captured payment amount validation
    const balance = calculateRemainingRefundableBalance(order);
    if (!balance.isExactCaptureKnown || order.captured_amount_paise === null || order.captured_amount_paise === undefined) {
      return next(
        new ConflictError('Cannot initiate refund: exact captured payment amount is unverified. Payment reconciliation is required.')
      );
    }

    if (balance.remainingRefundablePaise <= 0) {
      return next(new BadRequestError(`Order ${orderId} has no remaining refundable balance`));
    }

    // 5. Amount resolution (support paise or INR)
    let requestedPaise: number;
    if (req.body?.amount_paise !== undefined && req.body?.amount_paise !== null) {
      requestedPaise = Number(req.body.amount_paise);
    } else if (req.body?.amount_inr !== undefined && req.body?.amount_inr !== null) {
      requestedPaise = Math.round(Number(req.body.amount_inr) * 100);
    } else {
      // Default to full remaining refundable balance
      requestedPaise = balance.remainingRefundablePaise;
    }

    if (!Number.isInteger(requestedPaise) || !Number.isSafeInteger(requestedPaise) || requestedPaise <= 0) {
      return next(new BadRequestError('Refund amount must be a positive safe integer in paise'));
    }

    if (requestedPaise > balance.remainingRefundablePaise) {
      return next(
        new BadRequestError(
          `Requested refund of ${requestedPaise} paise exceeds remaining available refundable balance of ${balance.remainingRefundablePaise} paise`
        )
      );
    }

    // 6. Idempotency key
    const rawIdempotencyKey = req.body?.idempotency_key || req.headers['idempotency-key'];
    const idempotencyKey = rawIdempotencyKey
      ? String(rawIdempotencyKey).trim()
      : `idem_rfnd_${orderId}_${crypto.randomBytes(6).toString('hex')}`;

    const reason = String(req.body?.reason || 'admin_manual_refund').trim();
    const notes = req.body?.notes ? String(req.body.notes).trim() : null;

    // 7. STEP 1: Reserve balance BEFORE contacting Razorpay
    const reservation = await createPendingRefundReservation(db, {
      orderId: order.id,
      amount_paise: requestedPaise,
      reason,
      notes,
      initiated_by: String(req.user.email || 'admin').trim(),
      source: 'SUPER_ADMIN_PORTAL',
      idempotency_key: idempotencyKey
    });

    // Handle duplicate idempotent replay
    if (reservation.isReplay) {
      logger.info(
        `Duplicate refund request replayed for order ${orderId} (refund: ${reservation.refund.id}, status: ${reservation.refund.status})`
      );
      const latestOrder = (await getAuthoritativeOrderById(orderId, db)) || reservation.order;
      res.status(200).json({
        status: 'success',
        message: 'Duplicate refund request replayed from existing idempotency record',
        data: {
          refund: reservation.refund,
          order: latestOrder,
          is_replay: true
        }
      });
      return;
    }

    // 8. STEP 2: Call Razorpay API via Refund Client Wrapper
    const gatewayResult = await executeGatewayRefund({
      orderId: order.id,
      paymentId: String(order.razorpay_payment_id),
      amountPaise: requestedPaise,
      receipt: reservation.refund.id,
      notes: {
        order_id: order.id,
        refund_id: reservation.refund.id,
        initiated_by: String(req.user.email || 'admin')
      }
    });

    // 9. STEP 3: Validate Gateway Amount & Currency Consistency
    const isGatewayAmountValid =
      Number.isInteger(gatewayResult.amountPaise) &&
      Number.isSafeInteger(gatewayResult.amountPaise) &&
      gatewayResult.amountPaise > 0 &&
      gatewayResult.amountPaise === requestedPaise;
    const isGatewayCurrencyValid = String(gatewayResult.currency || '').toUpperCase() === 'INR';

    if (
      gatewayResult.amountMismatch ||
      gatewayResult.currencyMismatch ||
      !isGatewayAmountValid ||
      !isGatewayCurrencyValid
    ) {
      logger.error(
        `[CRITICAL FINANCIAL EXCEPTION] Gateway refund discrepancy for order ${orderId} (refund: ${reservation.refund.id}): requested=${requestedPaise} INR, reportedAmount=${gatewayResult.amountPaise}, reportedCurrency=${gatewayResult.currency}, rpRefundId=${gatewayResult.razorpayRefundId || 'none'}`
      );

      // CRITICAL SAFETY POLICY (A-1 Audit Fix):
      // Retain reservation in safe PENDING state.
      // NEVER mark PROCESSED with requested amount if gateway reported different amount!
      // NEVER mark FAILED (which would release reservation hold if gateway actually debited funds)!
      res.status(502).json({
        status: 'error',
        code: gatewayResult.errorCode || 'GATEWAY_AMOUNT_MISMATCH',
        message:
          gatewayResult.errorDescription ||
          'Gateway reported inconsistent refund amount or currency. Reservation held pending reconciliation.',
        data: {
          refund: reservation.refund,
          order: reservation.order,
          discrepancy: {
            requested_paise: requestedPaise,
            reported_paise: gatewayResult.amountPaise,
            reported_currency: gatewayResult.currency,
            razorpay_refund_id: gatewayResult.razorpayRefundId || null
          }
        }
      });
      return;
    }

    // 10. STEP 4: Settle the pending reservation based on Gateway Outcome
    if (gatewayResult.success && gatewayResult.status === 'PROCESSED') {
      const settlement = await markRefundProcessed(db, {
        refundId: reservation.refund.id,
        razorpay_refund_id: gatewayResult.razorpayRefundId,
        processed_at: gatewayResult.processedAt
      });

      logger.info(
        `Refund ${reservation.refund.id} successfully processed for order ${orderId} (rp_refund_id: ${gatewayResult.razorpayRefundId}, amount: ${requestedPaise} paise)`
      );

      res.status(200).json({
        status: 'success',
        message: 'Refund successfully processed',
        data: {
          refund: settlement.refund,
          order: settlement.order,
          gateway: {
            id: gatewayResult.razorpayRefundId,
            status: 'processed',
            is_mock: gatewayResult.isMock
          }
        }
      });
      return;
    }

    if (gatewayResult.success && gatewayResult.status === 'PENDING') {
      logger.info(
        `Refund ${reservation.refund.id} submitted to Razorpay and is pending settlement for order ${orderId} (rp_refund_id: ${gatewayResult.razorpayRefundId})`
      );

      res.status(202).json({
        status: 'accepted',
        message: 'Refund request submitted to payment gateway and is currently pending settlement',
        data: {
          refund: reservation.refund,
          order: reservation.order,
          gateway: {
            id: gatewayResult.razorpayRefundId,
            status: 'pending',
            is_mock: gatewayResult.isMock
          }
        }
      });
      return;
    }

    if (gatewayResult.isTimeout) {
      // Gateway timed out: Keep reservation in PENDING so balance remains locked against over-refund!
      logger.warn(
        `Gateway timed out for refund ${reservation.refund.id} on order ${orderId}. Reservation held in PENDING status pending webhook/reconciliation.`
      );

      res.status(504).json({
        status: 'timeout',
        message: 'Payment gateway request timed out. Refund reservation held in PENDING status pending reconciliation.',
        data: {
          refund: reservation.refund,
          order: reservation.order,
          error: {
            code: gatewayResult.errorCode,
            description: gatewayResult.errorDescription
          }
        }
      });
      return;
    }

    // Definite gateway rejection: Settle reservation to FAILED to release pending hold safely
    const failedSettlement = await markRefundFailed(db, {
      refundId: reservation.refund.id,
      error_code: gatewayResult.errorCode || 'GATEWAY_REJECTED',
      error_description: gatewayResult.errorDescription || 'Gateway rejected refund'
    });

    logger.warn(
      `Gateway rejected refund ${reservation.refund.id} for order ${orderId}: [${gatewayResult.errorCode}] ${gatewayResult.errorDescription}`
    );

    res.status(422).json({
      status: 'error',
      message: `Payment gateway rejected refund: ${gatewayResult.errorDescription || 'Unknown error'}`,
      data: {
        refund: failedSettlement.refund,
        order: failedSettlement.order,
        error: {
          code: gatewayResult.errorCode,
          description: gatewayResult.errorDescription
        }
      }
    });
  } catch (error) {
    next(error);
  }
};
