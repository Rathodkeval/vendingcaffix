import { Request, Response, NextFunction } from 'express';
import { getDB } from '../config/db';
import {
  executeOrderStatusUpdate,
  resolveRazorpayOrderConfig
} from './orderController';
import { UnauthorizedError } from '../utils/errors';
import {
  acquireReconciliationLeaseInFirebase,
  ensureFirebaseReady,
  getPendingOrdersFromFirebase,
  releaseReconciliationLeaseInFirebase
} from '../utils/firebase';
import {
  assertRazorpayEnvironmentIsolation,
  constantTimeEqual,
  getRequiredCronSecret,
  isVercelProduction
} from '../utils/security';
import logger from '../utils/logger';

export interface ReconciliationSummary {
  scanned: number;
  eligible: number;
  reconciled_paid: number;
  marked_failed: number;
  marked_cancelled: number;
  kept_pending: number;
  skipped: number;
  too_recent: number;
  errors: number;
  skipped_due_to_active_run?: boolean;
  cutoff_iso: string;
}

export interface ReconciliationOptions {
  maxAgeMinutes?: number;
  limit?: number;
  nowMs?: number;
}

type RazorpayOutcome =
  | { outcome: 'captured'; razorpayPaymentId: string | null }
  | { outcome: 'pending_or_authorized' }
  | { outcome: 'failed' }
  | { outcome: 'abandoned' }
  | { outcome: 'uncertain' };

type OrderReconcileAction =
  | 'paid'
  | 'failed'
  | 'cancelled'
  | 'kept_pending'
  | 'skipped'
  | 'error';

const DEFAULT_MAX_AGE_MINUTES = 10;
const MIN_MAX_AGE_MINUTES = 1;
const MAX_MAX_AGE_MINUTES = 10080; // 7 days
const DEFAULT_BATCH_LIMIT = 50;
const MIN_BATCH_LIMIT = 1;
const MAX_BATCH_LIMIT = 200;

let reconciliationQueue: Promise<any> = Promise.resolve();

function parsePositiveInt(
  rawValue: unknown,
  fallback: number,
  min: number,
  max: number
): number {
  const parsed = Number(rawValue);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.floor(parsed)));
}

function isOrderAlreadyActiveOrDispensed(order: any): boolean {
  const status = String(order?.status || 'PENDING').toUpperCase();
  const dispenseStatus = String(order?.dispense_status || '').toUpperCase();
  return (
    status !== 'PENDING' ||
    ['QUEUED', 'DISPENSING', 'DISPENSED'].includes(dispenseStatus) ||
    order?.dispensed === true
  );
}

/**
 * Classifies a Razorpay order + its fetched payments into a safe state transition decision.
 * Never cancels/fails an order while any payment is captured, authorized, or still created/pending.
 */
export function classifyRazorpayOrderOutcome(rpOrder: any, rpPayments: any): RazorpayOutcome {
  const payments: any[] = Array.isArray(rpPayments)
    ? rpPayments
    : Array.isArray(rpPayments?.items)
      ? rpPayments.items
      : [];

  const capturedPayment = payments.find(
    (p) => String(p?.status || '').toLowerCase() === 'captured' || p?.captured === true
  );
  const rpOrderStatus = String(rpOrder?.status || '').toLowerCase();
  const orderAmount = Number(rpOrder?.amount || 0);
  const orderAmountPaid = Number(rpOrder?.amount_paid || 0);
  const orderMarkedPaid =
    rpOrderStatus === 'paid' && orderAmount > 0 && orderAmountPaid >= orderAmount;

  if (capturedPayment || orderMarkedPaid) {
    return {
      outcome: 'captured',
      razorpayPaymentId: capturedPayment?.id ? String(capturedPayment.id) : null
    };
  }

  const hasActiveOrAuthorizedPayment = payments.some((p) =>
    ['authorized', 'created'].includes(String(p?.status || '').toLowerCase())
  );
  if (hasActiveOrAuthorizedPayment) {
    return { outcome: 'pending_or_authorized' };
  }

  const hasFailedPayment = payments.some(
    (p) => String(p?.status || '').toLowerCase() === 'failed'
  );
  const allPaymentsFailed =
    hasFailedPayment &&
    payments.every((p) => String(p?.status || '').toLowerCase() === 'failed');
  if (allPaymentsFailed) {
    return { outcome: 'failed' };
  }

  const attempts = Number(rpOrder?.attempts ?? 0);
  if (
    payments.length === 0 &&
    rpOrderStatus === 'created' &&
    orderAmountPaid === 0 &&
    attempts === 0
  ) {
    return { outcome: 'abandoned' };
  }

  return { outcome: 'uncertain' };
}

/**
 * Authenticates Vercel Cron and authorized operators using constant-time CRON_SECRET verification.
 * Fails closed with HTTP 503 if CRON_SECRET is missing, weak, or mock.
 */
export const authenticateCronSecret = (
  req: Request,
  _res: Response,
  next: NextFunction
): void => {
  try {
    const expectedSecret = getRequiredCronSecret();
    const authHeader = typeof req.headers.authorization === 'string'
      ? req.headers.authorization.trim()
      : '';

    if (!authHeader || !authHeader.toLowerCase().startsWith('bearer ')) {
      return next(new UnauthorizedError('Unauthorized: Missing cron bearer authorization header'));
    }

    const token = authHeader.slice(7).trim();
    if (!token || !constantTimeEqual(token, expectedSecret)) {
      return next(new UnauthorizedError('Unauthorized: Invalid cron bearer secret'));
    }

    next();
  } catch (error) {
    next(error);
  }
};

async function applyOrderReconciliationTransition(
  orderId: string,
  targetStatus: 'PAID' | 'FAILED' | 'CANCELLED',
  razorpayPaymentId?: string | null
): Promise<boolean> {
  let didTransition = false;
  await executeOrderStatusUpdate(orderId, targetStatus, {
    razorpayPaymentId: razorpayPaymentId || null,
    allowPaidOrderRecovery: targetStatus === 'PAID',
    allowPaidOrderNoop: true,
    onTransitionOutcome: (outcome) => {
      didTransition = outcome.didTransition;
    }
  });
  return didTransition;
}

async function reconcileSinglePendingOrder(
  order: any,
  razorpayConfig: { isMockMode: boolean; razorpayClient: any },
  production: boolean
): Promise<OrderReconcileAction> {
  const orderId = String(order?.id || '');
  if (!orderId || isOrderAlreadyActiveOrDispensed(order)) {
    return 'skipped';
  }

  const rpOrderId = String(order.razorpay_order_id || '').trim();
  if (!rpOrderId || rpOrderId.startsWith('order_mock_')) {
    // Mock/unlinked stale PENDING orders can only be safely cancelled; never promoted to PAID
    const didCancel = await applyOrderReconciliationTransition(orderId, 'CANCELLED');
    return didCancel ? 'cancelled' : 'skipped';
  }

  if (razorpayConfig.isMockMode || !razorpayConfig.razorpayClient) {
    return 'kept_pending';
  }

  try {
    const [rpOrder, rpPayments] = await Promise.all([
      razorpayConfig.razorpayClient.orders.fetch(rpOrderId),
      razorpayConfig.razorpayClient.orders.fetchPayments(rpOrderId)
    ]);

    const decision = classifyRazorpayOrderOutcome(rpOrder, rpPayments);
    if (decision.outcome === 'captured') {
      const didPay = await applyOrderReconciliationTransition(
        orderId,
        'PAID',
        decision.razorpayPaymentId || order.razorpay_payment_id || null
      );
      if (didPay) {
        logger.info(`Reconciled captured payment for stale PENDING order ${orderId} -> PAID`);
        return 'paid';
      }
      return 'skipped';
    }

    if (decision.outcome === 'failed') {
      const didFail = await applyOrderReconciliationTransition(orderId, 'FAILED');
      if (didFail) {
        logger.info(`Reconciled definitively failed payment for stale PENDING order ${orderId} -> FAILED`);
        return 'failed';
      }
      return 'skipped';
    }

    if (decision.outcome === 'abandoned') {
      const didCancel = await applyOrderReconciliationTransition(orderId, 'CANCELLED');
      if (didCancel) {
        logger.info(`Expired abandoned checkout with no payment attempt for PENDING order ${orderId} -> CANCELLED`);
        return 'cancelled';
      }
      return 'skipped';
    }

    // Authorized, in-progress ('created'), or uncertain state: preserve PENDING for later retry
    return 'kept_pending';
  } catch (err: any) {
    logger.warn(
      `Reconciliation lookup error for order ${orderId} (${production ? 'prod' : 'non-prod'}): ${err?.message || 'Unknown error'}`
    );
    return 'error';
  }
}

async function runPendingOrderReconciliationInternal(
  options: ReconciliationOptions = {}
): Promise<ReconciliationSummary> {
  assertRazorpayEnvironmentIsolation();
  ensureFirebaseReady();
  const razorpayConfig = resolveRazorpayOrderConfig();
  const production = isVercelProduction();

  const defaultAge = parsePositiveInt(
    process.env.ORDER_RECONCILIATION_MAX_AGE_MINUTES,
    DEFAULT_MAX_AGE_MINUTES,
    MIN_MAX_AGE_MINUTES,
    MAX_MAX_AGE_MINUTES
  );
  const maxAgeMinutes = parsePositiveInt(
    options.maxAgeMinutes,
    defaultAge,
    MIN_MAX_AGE_MINUTES,
    MAX_MAX_AGE_MINUTES
  );
  const defaultLimit = parsePositiveInt(
    process.env.ORDER_RECONCILIATION_BATCH_LIMIT,
    DEFAULT_BATCH_LIMIT,
    MIN_BATCH_LIMIT,
    MAX_BATCH_LIMIT
  );
  const limit = parsePositiveInt(
    options.limit,
    defaultLimit,
    MIN_BATCH_LIMIT,
    MAX_BATCH_LIMIT
  );

  const nowMs = Number.isFinite(options.nowMs) ? Number(options.nowMs) : Date.now();
  const cutoffMs = nowMs - maxAgeMinutes * 60_000;
  const cutoffIso = new Date(cutoffMs).toISOString();

  const lease = await acquireReconciliationLeaseInFirebase();
  if (!lease.acquired) {
    logger.info('Order reconciliation skipped because another serverless instance holds an active lease');
    return {
      scanned: 0,
      eligible: 0,
      reconciled_paid: 0,
      marked_failed: 0,
      marked_cancelled: 0,
      kept_pending: 0,
      skipped: 0,
      too_recent: 0,
      errors: 0,
      skipped_due_to_active_run: true,
      cutoff_iso: cutoffIso
    };
  }

  try {
    const db = getDB();
    const pendingOrders = await getPendingOrdersFromFirebase(db);

    const summary: ReconciliationSummary = {
      scanned: pendingOrders.length,
      eligible: 0,
      reconciled_paid: 0,
      marked_failed: 0,
      marked_cancelled: 0,
      kept_pending: 0,
      skipped: 0,
      too_recent: 0,
      errors: 0,
      cutoff_iso: cutoffIso
    };

    const eligibleOrders: any[] = [];
    for (const order of pendingOrders) {
      if (isOrderAlreadyActiveOrDispensed(order)) {
        summary.skipped += 1;
        continue;
      }
      const createdAtMs = Date.parse(String(order?.created_at || ''));
      if (!Number.isFinite(createdAtMs) || createdAtMs > cutoffMs) {
        summary.too_recent += 1;
        continue;
      }
      eligibleOrders.push(order);
    }

    eligibleOrders.sort((a, b) =>
      String(a.created_at || '').localeCompare(String(b.created_at || ''))
    );
    const batch = eligibleOrders.slice(0, limit);
    summary.eligible = batch.length;

    for (const order of batch) {
      const action = await reconcileSinglePendingOrder(order, razorpayConfig, production);
      if (action === 'paid') summary.reconciled_paid += 1;
      else if (action === 'failed') summary.marked_failed += 1;
      else if (action === 'cancelled') summary.marked_cancelled += 1;
      else if (action === 'kept_pending') summary.kept_pending += 1;
      else if (action === 'skipped') summary.skipped += 1;
      else if (action === 'error') summary.errors += 1;
    }

    return summary;
  } finally {
    await releaseReconciliationLeaseInFirebase(lease.lockId);
  }
}

/**
 * Serializes reconciliation runs within the Node/Vercel instance to prevent overlapping cron overlap,
 * while Firestore transactions protect across independent serverless instances and webhooks.
 */
export function runPendingOrderReconciliation(
  options: ReconciliationOptions = {}
): Promise<ReconciliationSummary> {
  const nextRun = reconciliationQueue.then(() =>
    runPendingOrderReconciliationInternal(options)
  );
  reconciliationQueue = nextRun.catch(() => undefined);
  return nextRun;
}

export const reconcilePendingOrders = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const summary = await runPendingOrderReconciliation({
      maxAgeMinutes: req.query?.maxAgeMinutes ? Number(req.query.maxAgeMinutes) : undefined,
      limit: req.query?.limit ? Number(req.query.limit) : undefined
    });

    res.status(200).json({
      status: 'success',
      data: summary
    });
  } catch (error) {
    next(error);
  }
};

