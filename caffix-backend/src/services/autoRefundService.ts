import crypto from 'crypto';
import {
  getDB
} from '../config/db';
import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ServiceUnavailableError
} from '../utils/errors';
import {
  acquireAutoRefundLeaseInFirebase,
  computeConnectionStatus,
  ensureFirebaseReady,
  getAuthoritativeMachineState,
  getAuthoritativeOrderById,
  getAuthoritativeOrders,
  getPaidOrdersForAutoRefundFromFirebase,
  getPendingRefundOrdersFromFirebase,
  getFirestoreInstance,
  isFirestoreActive,
  releaseAutoRefundLeaseInFirebase,
  updateSyncedFirebaseOrder
} from '../utils/firebase';
import {
  executeGatewayRefund,
  GatewayRefundResponse,
  resolveRazorpayRefundConfig
} from '../utils/razorpayRefundClient';
import {
  DispensedQuantityConfirmed,
  InspectionResult,
  RefundRecord,
  RefundSource,
  calculateRemainingRefundableBalance,
  createPendingRefundReservation,
  getRefundsByOrderId,
  markRefundFailed,
  markRefundProcessed,
  recordPendingRefundGatewayId
} from '../utils/refunds';
import logger from '../utils/logger';

export const DEFAULT_AUTO_REFUND_QUEUED_EXPIRY_MINUTES = 5;
export const DEFAULT_AUTO_REFUND_DISPENSING_TIMEOUT_MINUTES = 5;
export const MIN_AUTO_REFUND_QUEUED_EXPIRY_MINUTES = 1;
export const MAX_AUTO_REFUND_QUEUED_EXPIRY_MINUTES = 1440; // 24 hours

export type AutoRefundTriggerReason =
  | 'CONFIRMED_PRE_DISPENSE_FAILURE'
  | 'STALE_QUEUED_EXPIRED';

export type AutoRefundSkipReason =
  | 'NOT_PAID'
  | 'MISSING_MACHINE_ID'
  | 'UNVERIFIED_PAYMENT'
  | 'ALREADY_DISPENSED'
  | 'UNCERTAIN_DISPENSE_IN_PROGRESS'
  | 'UNCERTAIN_DISPENSE_OUTCOME'
  | 'ALREADY_REFUNDED_OR_PENDING'
  | 'NOT_EXPIRED_YET'
  | 'INVALID_TIMESTAMP'
  | 'NO_REFUNDABLE_BALANCE';

export interface AutoRefundEligibilityResult {
  eligible: boolean;
  triggerReason?: AutoRefundTriggerReason;
  skipReason?: AutoRefundSkipReason;
  needsExpiryTransition?: boolean;
  needsUncertainExpiryTransition?: boolean;
  isDispensingTimeout?: boolean;
  details: string;
}

export interface RefundTransactionExecutionParams {
  order: any;
  requestedPaise: number;
  reason: string;
  notes?: string | null;
  initiatedBy: string;
  source: RefundSource;
  idempotencyKey: string;
  physical_inspection_confirmed?: boolean | null;
  inspection_result?: InspectionResult | null;
  dispensed_quantity_confirmed?: DispensedQuantityConfirmed | null;
  inspected_by_admin_id?: string | null;
  inspected_by_admin_email?: string | null;
  inspected_at?: string | null;
  inspection_notes?: string | null;
}

export type RefundTransactionOutcome =
  | { outcome: 'replay'; refund: RefundRecord; order: any }
  | { outcome: 'processed'; refund: RefundRecord; order: any; gateway: GatewayRefundResponse }
  | { outcome: 'pending'; refund: RefundRecord; order: any; gateway: GatewayRefundResponse }
  | { outcome: 'timeout'; refund: RefundRecord; order: any; gateway: GatewayRefundResponse }
  | { outcome: 'mismatch'; refund: RefundRecord; order: any; gateway: GatewayRefundResponse }
  | { outcome: 'failed'; refund: RefundRecord; order: any; gateway: GatewayRefundResponse };

export interface AutoRefundSweepOptions {
  queuedExpiryMs?: number;
  dispensingTimeoutMs?: number;
  nowMs?: number;
  machineId?: string;
  limit?: number;
  dryRun?: boolean;
}

export interface AutoRefundDryRunOrderReport {
  order_id: string;
  machine_id: string | null;
  status: string;
  dispense_status: string;
  refund_status: string;
  eligible: boolean;
  eligibility_reason: AutoRefundTriggerReason | null;
  skip_reason: AutoRefundSkipReason | null;
  refund_amount_paise: number;
  captured_amount_paise: number | null;
  total_refunded_amount_paise: number;
  pending_refund_amount_paise: number;
  paid_at: string | null;
  expires_at: string | null;
  would_expire_to_expired: boolean;
  details: string;
}

export interface AutoRefundDryRunPendingCandidateReport {
  order_id: string;
  machine_id: string | null;
  status: string;
  dispense_status: string;
  refund_status: string;
  pending_refund_amount_paise: number;
  total_refunded_amount_paise: number;
  captured_amount_paise: number | null;
  razorpay_payment_id: string | null;
  reason: 'PENDING_REFUND_RECONCILIATION';
}

export interface AutoRefundSweepSummary {
  dry_run?: boolean;
  limit?: number;
  scanned: number;
  eligible: number;
  skipped?: number;
  expired_queued: number;
  refunded_processed: number;
  refund_pending: number;
  refund_failed: number;
  replayed: number;
  reconciled_pending_processed?: number;
  reconciled_pending_failed?: number;
  pending_reconciliation_count?: number;
  skipped_dispensing: number;
  skipped_uncertain: number;
  skipped_dispensed: number;
  skipped_unverified: number;
  skipped_already_refunded: number;
  skipped_not_expired: number;
  skipped_other: number;
  errors: number;
  skipped_due_to_active_run?: boolean;
  expiry_ms: number;
  cutoff_iso: string;
  orders?: AutoRefundDryRunOrderReport[];
  pending_reconciliation_candidates?: AutoRefundDryRunPendingCandidateReport[];
}

function recordAutoRefundSkipReason(
  summary: AutoRefundSweepSummary,
  skipReason?: AutoRefundSkipReason
): void {
  if (skipReason === 'UNCERTAIN_DISPENSE_IN_PROGRESS') summary.skipped_dispensing += 1;
  else if (skipReason === 'UNCERTAIN_DISPENSE_OUTCOME') summary.skipped_uncertain += 1;
  else if (skipReason === 'ALREADY_DISPENSED') summary.skipped_dispensed += 1;
  else if (skipReason === 'UNVERIFIED_PAYMENT') summary.skipped_unverified += 1;
  else if (skipReason === 'ALREADY_REFUNDED_OR_PENDING') summary.skipped_already_refunded += 1;
  else if (skipReason === 'NOT_EXPIRED_YET') summary.skipped_not_expired += 1;
  else summary.skipped_other += 1;
}

export function buildAutoRefundIdempotencyKey(orderId: string): string {
  return `auto_refund_${String(orderId).trim()}`;
}

export function resolveAutoRefundQueuedExpiryMs(overrideMs?: number): number {
  if (overrideMs !== undefined && Number.isFinite(overrideMs) && overrideMs >= 1000) {
    return Math.floor(overrideMs);
  }
  const rawMinutes = Number(process.env.AUTO_REFUND_QUEUED_EXPIRY_MINUTES);
  const minutes =
    Number.isFinite(rawMinutes) && rawMinutes > 0
      ? Math.min(
          MAX_AUTO_REFUND_QUEUED_EXPIRY_MINUTES,
          Math.max(MIN_AUTO_REFUND_QUEUED_EXPIRY_MINUTES, Math.floor(rawMinutes))
        )
      : DEFAULT_AUTO_REFUND_QUEUED_EXPIRY_MINUTES;
  return minutes * 60_000;
}

export function resolveAutoRefundDispensingTimeoutMs(overrideMs?: number): number {
  if (overrideMs !== undefined && Number.isFinite(overrideMs) && overrideMs >= 1000) {
    return Math.floor(overrideMs);
  }
  const rawMinutes = Number(process.env.AUTO_REFUND_DISPENSING_TIMEOUT_MINUTES);
  const minutes =
    Number.isFinite(rawMinutes) && rawMinutes > 0
      ? Math.min(
          MAX_AUTO_REFUND_QUEUED_EXPIRY_MINUTES,
          Math.max(MIN_AUTO_REFUND_QUEUED_EXPIRY_MINUTES, Math.floor(rawMinutes))
        )
      : DEFAULT_AUTO_REFUND_DISPENSING_TIMEOUT_MINUTES;
  return minutes * 60_000;
}

export function computeOrderExpiresAtIso(
  createdAtIso: string,
  expiryMs: number = resolveAutoRefundQueuedExpiryMs()
): string {
  const baseMs = Date.parse(createdAtIso);
  const resolvedBase = Number.isNaN(baseMs) ? Date.now() : baseMs;
  return new Date(resolvedBase + expiryMs).toISOString();
}

export function isOfflineMachineOrderBlockingEnabled(): boolean {
  return String(process.env.BLOCK_OFFLINE_MACHINE_ORDERS || '').trim().toLowerCase() === 'true';
}

/**
 * Core 4-step transactional refund runner shared by both manual Admin refunds
 * (`POST /api/orders/:id/refund`) and safe automated dispense-failure refunds.
 */
export async function executeOrderRefundTransaction(
  db: any,
  params: RefundTransactionExecutionParams
): Promise<RefundTransactionOutcome> {
  const {
    order,
    requestedPaise,
    reason,
    notes,
    initiatedBy,
    source,
    idempotencyKey,
    physical_inspection_confirmed,
    inspection_result,
    dispensed_quantity_confirmed,
    inspected_by_admin_id,
    inspected_by_admin_email,
    inspected_at,
    inspection_notes
  } = params;

  // Step 1: Reserve balance atomically BEFORE contacting Razorpay
  const reservation = await createPendingRefundReservation(db, {
    orderId: order.id,
    amount_paise: requestedPaise,
    reason,
    notes: notes ?? null,
    initiated_by: initiatedBy,
    source,
    idempotency_key: idempotencyKey,
    physical_inspection_confirmed,
    inspection_result,
    dispensed_quantity_confirmed,
    inspected_by_admin_id,
    inspected_by_admin_email,
    inspected_at,
    inspection_notes
  });

  if (reservation.isReplay) {
    const latestOrder = (await getAuthoritativeOrderById(order.id, db)) || reservation.order;
    return {
      outcome: 'replay',
      refund: reservation.refund,
      order: latestOrder
    };
  }

  // Step 2: Invoke Razorpay Refunds API
  const gatewayResult = await executeGatewayRefund({
    orderId: order.id,
    paymentId: String(order.razorpay_payment_id),
    amountPaise: requestedPaise,
    receipt: reservation.refund.id,
    notes: {
      order_id: order.id,
      refund_id: reservation.refund.id,
      initiated_by: initiatedBy,
      source
    }
  });

  // Step 3: Validate exact INR amount & currency consistency
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
      `[CRITICAL FINANCIAL EXCEPTION] Gateway refund discrepancy for order ${order.id} (refund: ${reservation.refund.id}): requested=${requestedPaise} INR, reportedAmount=${gatewayResult.amountPaise}, reportedCurrency=${gatewayResult.currency}, rpRefundId=${gatewayResult.razorpayRefundId || 'none'}`
    );
    const updatedMismatchRefund = gatewayResult.razorpayRefundId
      ? (await recordPendingRefundGatewayId(db, {
          refundId: reservation.refund.id,
          razorpay_refund_id: gatewayResult.razorpayRefundId
        })) || reservation.refund
      : reservation.refund;
    return {
      outcome: 'mismatch',
      refund: updatedMismatchRefund,
      order: reservation.order,
      gateway: gatewayResult
    };
  }

  // Step 4: Settle reservation based on verified gateway response
  if (gatewayResult.success && gatewayResult.status === 'PROCESSED') {
    const settlement = await markRefundProcessed(db, {
      refundId: reservation.refund.id,
      razorpay_refund_id: gatewayResult.razorpayRefundId,
      processed_at: gatewayResult.processedAt
    });
    return {
      outcome: 'processed',
      refund: settlement.refund,
      order: settlement.order,
      gateway: gatewayResult
    };
  }

  if (gatewayResult.success && gatewayResult.status === 'PENDING') {
    const pendingRefundRecord = gatewayResult.razorpayRefundId
      ? (await recordPendingRefundGatewayId(db, {
          refundId: reservation.refund.id,
          razorpay_refund_id: gatewayResult.razorpayRefundId
        })) || {
          ...reservation.refund,
          razorpay_refund_id: gatewayResult.razorpayRefundId
        }
      : reservation.refund;

    return {
      outcome: 'pending',
      refund: pendingRefundRecord,
      order: reservation.order,
      gateway: gatewayResult
    };
  }

  if (gatewayResult.isTimeout) {
    return {
      outcome: 'timeout',
      refund: reservation.refund,
      order: reservation.order,
      gateway: gatewayResult
    };
  }

  const failedSettlement = await markRefundFailed(db, {
    refundId: reservation.refund.id,
    error_code: gatewayResult.errorCode || 'GATEWAY_REJECTED',
    error_description: gatewayResult.errorDescription || 'Gateway rejected refund'
  });

  return {
    outcome: 'failed',
    refund: failedSettlement.refund,
    order: failedSettlement.order,
    gateway: gatewayResult
  };
}

/**
 * Evaluates whether an order qualifies for an automatic refund under strict Phase H.2 rules:
 * - Never refunds uncaptured/unverified payments
 * - Never refunds orders in DISPENSING/CLAIMING or with uncertain dispense outcomes
 * - Never refunds already DISPENSED/COMPLETED orders
 * - Refunds ONLY confirmed pre-dispense failures or stale unclaimed QUEUED orders past expiry
 */
export function evaluateAutoRefundEligibility(
  order: any,
  nowMs: number = Date.now(),
  queuedExpiryMs: number = resolveAutoRefundQueuedExpiryMs(),
  dispensingTimeoutMs: number = resolveAutoRefundDispensingTimeoutMs()
): AutoRefundEligibilityResult {
  if (!order || order.is_malformed) {
    return {
      eligible: false,
      skipReason: 'MISSING_MACHINE_ID',
      details: 'Order is missing or malformed.'
    };
  }

  const machineId = order.machine_id ? String(order.machine_id).trim() : '';
  if (!machineId || machineId.toLowerCase() === 'undefined' || machineId.toLowerCase() === 'null') {
    return {
      eligible: false,
      skipReason: 'MISSING_MACHINE_ID',
      details: 'Order has no valid machine_id.'
    };
  }

  const status = String(order.status || '').toUpperCase();
  if (status !== 'PAID') {
    if (status === 'COMPLETED') {
      return {
        eligible: false,
        skipReason: 'ALREADY_DISPENSED',
        details: 'Completed orders are never auto-refunded.'
      };
    }
    return {
      eligible: false,
      skipReason: 'NOT_PAID',
      details: `Order status "${status}" is not eligible for auto-refund.`
    };
  }

  const dispenseStatus = String(order.dispense_status || 'PENDING').toUpperCase();
  const dispenseOutcome = String(order.dispense_outcome || '').toUpperCase();
  const failureStage = String(order.failure_stage || '').toUpperCase();

  // Strictly block already-dispensed orders
  if (order.dispensed === true || dispenseStatus === 'DISPENSED' || dispenseOutcome === 'DISPENSED') {
    return {
      eligible: false,
      skipReason: 'ALREADY_DISPENSED',
      details: 'Order was already dispensed; auto-refund forbidden.'
    };
  }

  // Strictly block active CLAIMING states; evaluate DISPENSING against its 5-minute dispense_started_at window
  if (dispenseStatus === 'CLAIMING') {
    return {
      eligible: false,
      skipReason: 'UNCERTAIN_DISPENSE_IN_PROGRESS',
      details: `Order dispense_status is "${dispenseStatus}"; physical outcome uncertain.`
    };
  }

  if (dispenseStatus === 'DISPENSING') {
    const startedMs = order.dispense_started_at ? Date.parse(String(order.dispense_started_at)) : NaN;
    const explicitDispenseExpiresMs = order.dispense_expires_at
      ? Date.parse(String(order.dispense_expires_at))
      : NaN;
    const alignedDispenseExpires =
      !Number.isNaN(explicitDispenseExpiresMs) &&
      (Number.isNaN(startedMs) || explicitDispenseExpiresMs >= startedMs);

    let isDispenseTimedOut = false;
    if (
      alignedDispenseExpires &&
      dispensingTimeoutMs === resolveAutoRefundDispensingTimeoutMs()
    ) {
      isDispenseTimedOut = nowMs >= explicitDispenseExpiresMs;
    } else if (!Number.isNaN(startedMs)) {
      isDispenseTimedOut = nowMs - startedMs >= dispensingTimeoutMs;
    } else {
      return {
        eligible: false,
        skipReason: 'UNCERTAIN_DISPENSE_IN_PROGRESS',
        details: 'Order dispense_status is "DISPENSING" without a valid dispense_started_at timestamp.'
      };
    }

    if (!isDispenseTimedOut) {
      return {
        eligible: false,
        skipReason: 'UNCERTAIN_DISPENSE_IN_PROGRESS',
        details: 'DISPENSING order has not yet reached its 5-minute dispensing timeout.'
      };
    }

    // Strict financial & capture verification before deciding expiry/refund outcome
    const totalRefunded = Number(order.total_refunded_amount_paise || 0);
    const pendingRefund = Number(order.pending_refund_amount_paise || 0);
    const refundStatus = String(order.refund_status || 'NONE').toUpperCase();
    if (
      totalRefunded > 0 ||
      pendingRefund > 0 ||
      refundStatus === 'FULL' ||
      refundStatus === 'PENDING' ||
      refundStatus === 'PARTIAL' ||
      refundStatus === 'FAILED'
    ) {
      return {
        eligible: false,
        skipReason: 'ALREADY_REFUNDED_OR_PENDING',
        details: `Order already has refund activity (status=${refundStatus}, refunded=${totalRefunded}, pending=${pendingRefund}).`
      };
    }

    // Strict explicit boolean false check: missing, null, true, or invalid values stay UNCERTAIN
    if (order.command_transmitted === false) {
      const balance = calculateRemainingRefundableBalance(order);
      if (
        !balance.isExactCaptureKnown ||
        order.captured_amount_paise === null ||
        order.captured_amount_paise === undefined ||
        !order.razorpay_payment_id
      ) {
        return {
          eligible: false,
          skipReason: 'UNVERIFIED_PAYMENT',
          details: 'Exact captured payment amount or razorpay_payment_id is missing.'
        };
      }
      if (balance.remainingRefundablePaise <= 0) {
        return {
          eligible: false,
          skipReason: 'NO_REFUNDABLE_BALANCE',
          details: 'Order has no remaining refundable balance.'
        };
      }
      return {
        eligible: true,
        triggerReason: 'CONFIRMED_PRE_DISPENSE_FAILURE',
        needsExpiryTransition: true,
        isDispensingTimeout: true,
        details: `DISPENSING order ${order.id} exceeded 5-minute timeout with command_transmitted=false.`
      };
    }

    return {
      eligible: false,
      skipReason: 'UNCERTAIN_DISPENSE_OUTCOME',
      needsUncertainExpiryTransition: true,
      isDispensingTimeout: true,
      details: `DISPENSING order ${order.id} exceeded 5-minute timeout with transmitted or unverified command; permanently expiring as UNCERTAIN without auto-refund.`
    };
  }

  if (dispenseOutcome === 'UNCERTAIN' || failureStage === 'DURING_DISPENSE') {
    return {
      eligible: false,
      skipReason: 'UNCERTAIN_DISPENSE_OUTCOME',
      details: 'Dispense failed after pour/dispensing started; requires manual investigation before refund.'
    };
  }

  // Financial verification (captured payment + no existing refund or pending/failed hold)
  const totalRefunded = Number(order.total_refunded_amount_paise || 0);
  const pendingRefund = Number(order.pending_refund_amount_paise || 0);
  const refundStatus = String(order.refund_status || 'NONE').toUpperCase();
  if (
    totalRefunded > 0 ||
    pendingRefund > 0 ||
    refundStatus === 'FULL' ||
    refundStatus === 'PENDING' ||
    refundStatus === 'PARTIAL' ||
    refundStatus === 'FAILED'
  ) {
    return {
      eligible: false,
      skipReason: 'ALREADY_REFUNDED_OR_PENDING',
      details: `Order already has refund activity (status=${refundStatus}, refunded=${totalRefunded}, pending=${pendingRefund}).`
    };
  }

  const balance = calculateRemainingRefundableBalance(order);
  if (
    !balance.isExactCaptureKnown ||
    order.captured_amount_paise === null ||
    order.captured_amount_paise === undefined ||
    !order.razorpay_payment_id
  ) {
    return {
      eligible: false,
      skipReason: 'UNVERIFIED_PAYMENT',
      details: 'Exact captured payment amount or razorpay_payment_id is missing.'
    };
  }

  if (balance.remainingRefundablePaise <= 0) {
    return {
      eligible: false,
      skipReason: 'NO_REFUNDABLE_BALANCE',
      details: 'Order has no remaining refundable balance.'
    };
  }

  // Path A: Explicitly confirmed pre-dispense failure or already atomically expired
  if (dispenseStatus === 'FAILED' || dispenseStatus === 'EXPIRED') {
    const hasStartedMarkers = Boolean(order.dispense_started_at || order.claimed_at);
    const hasExplicitPreDispenseProof =
      dispenseOutcome === 'NOT_DISPENSED' ||
      failureStage === 'PRE_DISPENSE' ||
      dispenseStatus === 'EXPIRED';

    if (hasStartedMarkers && !hasExplicitPreDispenseProof) {
      return {
        eligible: false,
        skipReason: 'UNCERTAIN_DISPENSE_OUTCOME',
        details: 'Order failed after hardware claim without conclusive pre-dispense confirmation.'
      };
    }

    return {
      eligible: true,
      triggerReason: dispenseStatus === 'EXPIRED' ? 'STALE_QUEUED_EXPIRED' : 'CONFIRMED_PRE_DISPENSE_FAILURE',
      needsExpiryTransition: false,
      details: `Order ${order.id} confirmed non-dispensed (${dispenseStatus}).`
    };
  }

  // Path B: Unclaimed QUEUED order past expiry TTL
  if (dispenseStatus === 'QUEUED') {
    if (order.claimed_at || order.dispense_started_at) {
      return {
        eligible: false,
        skipReason: 'UNCERTAIN_DISPENSE_OUTCOME',
        details: 'QUEUED order has claim/start timestamp and cannot be auto-expired safely.'
      };
    }

    const explicitExpiresMs = order.expires_at ? Date.parse(String(order.expires_at)) : NaN;
    const paidMs = order.paid_at ? Date.parse(String(order.paid_at)) : NaN;
    const createdMs = order.created_at ? Date.parse(String(order.created_at)) : NaN;
    const anchorMs = !Number.isNaN(paidMs) ? paidMs : createdMs;
    const expiresAlignedWithPaidAt =
      !Number.isNaN(explicitExpiresMs) && (Number.isNaN(paidMs) || explicitExpiresMs >= paidMs);

    let isExpired = false;
    if (expiresAlignedWithPaidAt && queuedExpiryMs === resolveAutoRefundQueuedExpiryMs()) {
      isExpired = nowMs >= explicitExpiresMs;
    } else if (!Number.isNaN(anchorMs)) {
      isExpired = nowMs - anchorMs >= queuedExpiryMs;
    } else {
      return {
        eligible: false,
        skipReason: 'INVALID_TIMESTAMP',
        details: 'Order lacks a valid paid_at or created_at timestamp for safe expiry evaluation.'
      };
    }

    if (!isExpired) {
      return {
        eligible: false,
        skipReason: 'NOT_EXPIRED_YET',
        details: 'QUEUED order has not yet reached expiry threshold.'
      };
    }

    return {
      eligible: true,
      triggerReason: 'STALE_QUEUED_EXPIRED',
      needsExpiryTransition: true,
      details: `Unclaimed QUEUED order ${order.id} exceeded expiry threshold.`
    };
  }

  return {
    eligible: false,
    skipReason: 'UNCERTAIN_DISPENSE_OUTCOME',
    details: `Dispense state "${dispenseStatus}" is not eligible for auto-refund.`
  };
}

/**
 * Atomically transitions an eligible unclaimed stale QUEUED order -> EXPIRED inside Firestore
 * (or local DB fallback) BEFORE refund reservation, ensuring RPi claim transactions and
 * auto-refund expiry cannot race on the same order.
 */
async function lockAndVerifyOrderForAutoRefund(
  db: any,
  orderId: string,
  nowMs: number,
  queuedExpiryMs: number,
  dispensingTimeoutMs: number
): Promise<{
  proceed: boolean;
  order?: any;
  eligibility?: AutoRefundEligibilityResult;
  didExpireQueued?: boolean;
  didExpireDispensingUncertain?: boolean;
}> {
  const nowIso = new Date(nowMs).toISOString();

  if (isFirestoreActive()) {
    const firestore = getFirestoreInstance()!;
    const txRes = await firestore.runTransaction(async (tx) => {
      const orderRef = firestore.collection('orders').doc(orderId);
      const snap = await tx.get(orderRef);
      if (!snap.exists) {
        return {
          proceed: false,
          eligibility: {
            eligible: false,
            skipReason: 'NOT_PAID' as AutoRefundSkipReason,
            details: `Order ${orderId} not found in Firestore.`
          },
          didExpireQueued: false,
          didExpireDispensingUncertain: false
        };
      }

      const liveOrder = { ...(snap.data() || {}), id: orderId };
      const check = evaluateAutoRefundEligibility(liveOrder, nowMs, queuedExpiryMs, dispensingTimeoutMs);
      if (check.needsUncertainExpiryTransition) {
        const updates = {
          dispense_status: 'EXPIRED',
          dispensed: false,
          dispense_outcome: 'UNCERTAIN',
          failure_stage: 'DURING_DISPENSE',
          failure_reason: 'DISPENSING_TIMEOUT_UNCERTAIN_5M',
          expired_at: nowIso,
          updated_at: nowIso
        };
        tx.set(orderRef, updates, { merge: true });
        return {
          proceed: false,
          order: { ...liveOrder, ...updates },
          eligibility: check,
          didExpireQueued: false,
          didExpireDispensingUncertain: true
        };
      }

      if (!check.eligible) {
        return {
          proceed: false,
          order: liveOrder,
          eligibility: check,
          didExpireQueued: false,
          didExpireDispensingUncertain: false
        };
      }

      if (check.needsExpiryTransition) {
        const updates = {
          dispense_status: 'EXPIRED',
          dispensed: false,
          dispense_outcome: 'NOT_DISPENSED',
          failure_stage: 'PRE_DISPENSE',
          failure_reason: check.isDispensingTimeout
            ? 'DISPENSING_TIMEOUT_PRE_COMMAND_5M'
            : 'QUEUED_ORDER_EXPIRED_UNCLAIMED',
          expired_at: nowIso,
          updated_at: nowIso
        };
        tx.set(orderRef, updates, { merge: true });
        return {
          proceed: true,
          order: { ...liveOrder, ...updates },
          eligibility: check,
          didExpireQueued: true,
          didExpireDispensingUncertain: false
        };
      }

      return {
        proceed: true,
        order: liveOrder,
        eligibility: check,
        didExpireQueued: false,
        didExpireDispensingUncertain: false
      };
    });

    if (txRes.order) {
      updateSyncedFirebaseOrder(orderId, txRes.order);
      if ((txRes.didExpireQueued || txRes.didExpireDispensingUncertain) && db?.run) {
        await db.run('UPDATE orders SET dispense_status = ? WHERE id = ?', ['EXPIRED', orderId]).catch(() => {});
      }
    }
    return txRes;
  }

  // Local DB / MockDatabase fallback
  const localOrder = await getAuthoritativeOrderById(orderId, db);
  if (!localOrder) {
    return {
      proceed: false,
      eligibility: {
        eligible: false,
        skipReason: 'NOT_PAID',
        details: `Order ${orderId} not found.`
      }
    };
  }

  const check = evaluateAutoRefundEligibility(localOrder, nowMs, queuedExpiryMs, dispensingTimeoutMs);
  if (check.needsUncertainExpiryTransition) {
    if (db?.run) {
      const upd = await db.run(
        `UPDATE orders SET dispense_status = 'EXPIRED'
         WHERE id = ? AND status = 'PAID' AND dispense_status = 'DISPENSING' AND dispensed_at IS NULL`,
        [orderId]
      );
      if (!upd || Number(upd.changes ?? 0) === 0) {
        const latest = await getAuthoritativeOrderById(orderId, db);
        const recheck = evaluateAutoRefundEligibility(latest, nowMs, queuedExpiryMs, dispensingTimeoutMs);
        return { proceed: false, order: latest, eligibility: recheck, didExpireQueued: false };
      }
    }
    const merged = {
      ...localOrder,
      dispense_status: 'EXPIRED',
      dispensed: false,
      dispense_outcome: 'UNCERTAIN',
      failure_stage: 'DURING_DISPENSE',
      failure_reason: 'DISPENSING_TIMEOUT_UNCERTAIN_5M',
      expired_at: nowIso,
      updated_at: nowIso
    };
    updateSyncedFirebaseOrder(orderId, merged);
    return {
      proceed: false,
      order: merged,
      eligibility: check,
      didExpireQueued: false,
      didExpireDispensingUncertain: true
    };
  }

  if (!check.eligible) {
    return { proceed: false, order: localOrder, eligibility: check, didExpireQueued: false };
  }

  if (check.needsExpiryTransition && db?.run) {
    const upd = check.isDispensingTimeout
      ? await db.run(
          `UPDATE orders SET dispense_status = 'EXPIRED'
           WHERE id = ? AND status = 'PAID' AND dispense_status = 'DISPENSING' AND dispensed_at IS NULL`,
          [orderId]
        )
      : await db.run(
          `UPDATE orders SET dispense_status = 'EXPIRED'
           WHERE id = ? AND status = 'PAID' AND dispense_status = 'QUEUED'
             AND dispense_started_at IS NULL AND dispensed_at IS NULL`,
          [orderId]
        );
    if (!upd || Number(upd.changes ?? 0) === 0) {
      const latest = await getAuthoritativeOrderById(orderId, db);
      const recheck = evaluateAutoRefundEligibility(latest, nowMs, queuedExpiryMs, dispensingTimeoutMs);
      return { proceed: false, order: latest, eligibility: recheck, didExpireQueued: false };
    }
    const merged = {
      ...localOrder,
      dispense_status: 'EXPIRED',
      dispensed: false,
      dispense_outcome: 'NOT_DISPENSED',
      failure_stage: 'PRE_DISPENSE',
      failure_reason: check.isDispensingTimeout
        ? 'DISPENSING_TIMEOUT_PRE_COMMAND_5M'
        : 'QUEUED_ORDER_EXPIRED_UNCLAIMED',
      expired_at: nowIso,
      updated_at: nowIso
    };
    updateSyncedFirebaseOrder(orderId, merged);
    return { proceed: true, order: merged, eligibility: check, didExpireQueued: true };
  }

  return { proceed: true, order: localOrder, eligibility: check, didExpireQueued: false };
}

/**
 * Safely processes an automatic full refund for a single order if and only if
 * it satisfies all Phase H.2 eligibility invariants inside an atomic transaction.
 */
export async function processAutoRefundForOrder(
  db: any,
  orderId: string,
  options: { nowMs?: number; queuedExpiryMs?: number; dispensingTimeoutMs?: number } = {}
): Promise<{
  status: 'refunded' | 'pending' | 'failed' | 'replayed' | 'skipped' | 'mismatch';
  didExpireQueued: boolean;
  skipReason?: AutoRefundSkipReason;
  details: string;
  refund?: RefundRecord;
  order?: any;
}> {
  const nowMs = Number.isFinite(options.nowMs) ? Number(options.nowMs) : Date.now();
  const queuedExpiryMs = resolveAutoRefundQueuedExpiryMs(options.queuedExpiryMs);
  const dispensingTimeoutMs = resolveAutoRefundDispensingTimeoutMs(options.dispensingTimeoutMs);

  const locked = await lockAndVerifyOrderForAutoRefund(
    db,
    orderId,
    nowMs,
    queuedExpiryMs,
    dispensingTimeoutMs
  );
  if (!locked.proceed || !locked.order || !locked.eligibility) {
    return {
      status: 'skipped',
      didExpireQueued: false,
      skipReason: locked.eligibility?.skipReason,
      details: locked.eligibility?.details || 'Order not eligible for auto-refund.',
      order: locked.order
    };
  }

  const order = locked.order;
  const triggerReason = locked.eligibility.triggerReason!;
  const balance = calculateRemainingRefundableBalance(order);
  const amountPaise = balance.remainingRefundablePaise;
  const idempotencyKey = buildAutoRefundIdempotencyKey(order.id);
  const reason =
    triggerReason === 'STALE_QUEUED_EXPIRED'
      ? 'auto_refund_queued_order_expired'
      : 'auto_refund_dispense_failed_pre_dispense';

  const execRes = await executeOrderRefundTransaction(db, {
    order,
    requestedPaise: amountPaise,
    reason,
    notes: order.failure_reason ? `Failure reason: ${order.failure_reason}` : locked.eligibility.details,
    initiatedBy: 'system_auto_refund',
    source: 'RECONCILIATION',
    idempotencyKey
  });

  if (execRes.outcome === 'replay') {
    return {
      status: 'replayed',
      didExpireQueued: Boolean(locked.didExpireQueued),
      details: `Auto-refund idempotency replay for ${order.id} (status=${execRes.refund.status}).`,
      refund: execRes.refund,
      order: execRes.order
    };
  }
  if (execRes.outcome === 'processed') {
    logger.info(
      `[Auto-Refund] Settled PROCESSED refund ${execRes.refund.id} (${amountPaise} paise) for order ${order.id} (machine ${order.machine_id}, reason=${triggerReason})`
    );
    return {
      status: 'refunded',
      didExpireQueued: Boolean(locked.didExpireQueued),
      details: locked.eligibility.details,
      refund: execRes.refund,
      order: execRes.order
    };
  }
  if (execRes.outcome === 'pending' || execRes.outcome === 'timeout') {
    logger.warn(
      `[Auto-Refund] Refund ${execRes.refund.id} held in PENDING (${execRes.outcome}) for order ${order.id} (machine ${order.machine_id})`
    );
    return {
      status: 'pending',
      didExpireQueued: Boolean(locked.didExpireQueued),
      details: `Gateway refund ${execRes.outcome}; reservation held in PENDING.`,
      refund: execRes.refund,
      order: execRes.order
    };
  }
  if (execRes.outcome === 'mismatch') {
    return {
      status: 'mismatch',
      didExpireQueued: Boolean(locked.didExpireQueued),
      details: 'Gateway refund amount/currency mismatch; reservation held in PENDING.',
      refund: execRes.refund,
      order: execRes.order
    };
  }

  logger.warn(
    `[Auto-Refund] Gateway rejected refund ${execRes.refund.id} for order ${order.id}: [${execRes.gateway.errorCode}] ${execRes.gateway.errorDescription}`
  );
  return {
    status: 'failed',
    didExpireQueued: Boolean(locked.didExpireQueued),
    details: execRes.gateway.errorDescription || 'Gateway rejected refund request.',
    refund: execRes.refund,
    order: execRes.order
  };
}

/**
 * Records a machine-reported dispense outcome (`DISPENSING`, `DISPENSED`, `FAILED`, `EXPIRED`)
 * inside an atomic transaction enforcing machine binding and refund-first exclusion, then invokes
 * `processAutoRefundForOrder` ONLY when dispensing is conclusively confirmed not to have occurred.
 */
export async function reportMachineDispenseOutcome(
  db: any,
  params: {
    orderId: string;
    machineId: string;
    dispenseStatus: 'DISPENSING' | 'DISPENSED' | 'FAILED' | 'EXPIRED';
    failureStage?: 'PRE_DISPENSE' | 'DURING_DISPENSE';
    failureReason?: string | null;
    nowMs?: number;
  }
): Promise<{
  order: any;
  autoRefund?: Awaited<ReturnType<typeof processAutoRefundForOrder>>;
}> {
  const orderId = String(params.orderId || '').trim();
  const machineId = String(params.machineId || '').trim();
  const targetDispenseStatus = String(params.dispenseStatus || '').toUpperCase() as
    | 'DISPENSING'
    | 'DISPENSED'
    | 'FAILED'
    | 'EXPIRED';
  const nowIso = new Date(params.nowMs ?? Date.now()).toISOString();

  let committedOrder: any = null;

  if (isFirestoreActive()) {
    const firestore = getFirestoreInstance()!;
    committedOrder = await firestore.runTransaction(async (tx) => {
      const orderRef = firestore.collection('orders').doc(orderId);
      const snap = await tx.get(orderRef);
      if (!snap.exists) {
        throw new NotFoundError(`Order with ID ${orderId} not found`);
      }

      const existing = { ...(snap.data() || {}), id: orderId } as any;
      if (String(existing.machine_id || '').trim() !== machineId) {
        throw new ForbiddenError(
          `Machine ${machineId} cannot update dispense result for order ${orderId} belonging to ${existing.machine_id}`
        );
      }

      const currentStatus = String(existing.status || 'PENDING').toUpperCase();
      if (!['PAID', 'PREPARING', 'COMPLETED'].includes(currentStatus)) {
        throw new ConflictError(`Cannot update dispense outcome for unpaid order ${orderId} (${currentStatus})`);
      }

      const currentDispense = String(existing.dispense_status || 'QUEUED').toUpperCase();
      const refundStatus = String(existing.refund_status || 'NONE').toUpperCase();
      const pendingRefund = Number(existing.pending_refund_amount_paise || 0);

      if (targetDispenseStatus === 'DISPENSING') {
        if (refundStatus === 'FULL' || pendingRefund > 0) {
          throw new ConflictError(`Cannot claim order ${orderId}: refund already pending or completed`);
        }
        if (['DISPENSED', 'FAILED', 'EXPIRED', 'CANCELLED'].includes(currentDispense) || existing.dispensed === true) {
          throw new ConflictError(`Cannot transition terminal order ${orderId} (${currentDispense}) to DISPENSING`);
        }
        const startedIso = existing.dispense_started_at || nowIso;
        const startedMs = Date.parse(startedIso);
        const dispenseExpiresIso =
          existing.dispense_expires_at ||
          new Date(
            (Number.isNaN(startedMs) ? (params.nowMs ?? Date.now()) : startedMs) +
              resolveAutoRefundDispensingTimeoutMs()
          ).toISOString();
        const isQueuedToDispensing = currentDispense === 'QUEUED';
        const updates: Record<string, any> = {
          dispense_status: 'DISPENSING',
          claimed_by: machineId,
          claimed_at: existing.claimed_at || nowIso,
          dispense_started_at: startedIso,
          dispense_expires_at: dispenseExpiresIso,
          updated_at: nowIso
        };
        if (existing.command_transmitted !== undefined) {
          updates.command_transmitted = existing.command_transmitted;
          if (existing.command_transmitted_at !== undefined) {
            updates.command_transmitted_at = existing.command_transmitted_at;
          }
        } else if (isQueuedToDispensing) {
          updates.command_transmitted = false;
          updates.command_transmitted_at = existing.command_transmitted_at ?? null;
        }
        tx.set(orderRef, updates, { merge: true });
        return { ...existing, ...updates };
      }

      if (targetDispenseStatus === 'DISPENSED') {
        if (currentDispense === 'DISPENSED' || existing.dispensed === true) {
          return { ...existing };
        }
        if (
          ['FAILED', 'EXPIRED', 'CANCELLED'].includes(currentDispense) ||
          refundStatus === 'FULL' ||
          refundStatus === 'PENDING' ||
          refundStatus === 'PARTIAL' ||
          pendingRefund > 0 ||
          String(existing.dispense_outcome || '').toUpperCase() === 'UNCERTAIN'
        ) {
          const auditUpdates = {
            late_dispense_reported_at: existing.late_dispense_reported_at || nowIso,
            late_dispense_signal: existing.late_dispense_signal || 'ARDUINO_DONE_AFTER_EXPIRY',
            updated_at: nowIso
          };
          tx.set(orderRef, auditUpdates, { merge: true });
          const conflictMessage =
            refundStatus === 'FULL' || refundStatus === 'PENDING' || refundStatus === 'PARTIAL' || pendingRefund > 0
              ? `Cannot mark refunded/pending-refund order ${orderId} as DISPENSED`
              : `Cannot mark terminal failed/expired/uncertain order ${orderId} (${currentDispense}) as DISPENSED`;
          return {
            __conflictMessage: conflictMessage,
            ...existing,
            ...auditUpdates
          };
        }
        const updates = {
          dispense_status: 'DISPENSED',
          dispensed: true,
          dispense_outcome: 'DISPENSED',
          dispensed_by: machineId,
          dispensed_at: existing.dispensed_at || nowIso,
          updated_at: nowIso
        };
        tx.set(orderRef, updates, { merge: true });
        return { ...existing, ...updates };
      }

      // FAILED or EXPIRED
      if (existing.dispensed === true || currentDispense === 'DISPENSED') {
        throw new ConflictError(`Cannot mark already DISPENSED order ${orderId} as ${targetDispenseStatus}`);
      }

      const resolvedStage =
        params.failureStage ||
        (currentDispense === 'DISPENSING' || Boolean(existing.dispense_started_at)
          ? 'DURING_DISPENSE'
          : 'PRE_DISPENSE');

      const resolvedOutcome =
        resolvedStage === 'PRE_DISPENSE' ? 'NOT_DISPENSED' : 'UNCERTAIN';

      const updates: any = {
        dispense_status: targetDispenseStatus,
        dispensed: false,
        dispense_outcome: resolvedOutcome,
        failure_stage: resolvedStage,
        failure_reason: params.failureReason ? String(params.failureReason).trim() : null,
        updated_at: nowIso
      };
      if (targetDispenseStatus === 'EXPIRED') {
        updates.expired_at = existing.expired_at || nowIso;
      }
      tx.set(orderRef, updates, { merge: true });
      return { ...existing, ...updates };
    });

    if (committedOrder?.__conflictMessage) {
      const { __conflictMessage, ...cleanAuditOrder } = committedOrder;
      updateSyncedFirebaseOrder(orderId, cleanAuditOrder);
      throw new ConflictError(__conflictMessage);
    }

    updateSyncedFirebaseOrder(orderId, committedOrder);
    if (db?.run) {
      await db.run('UPDATE orders SET dispense_status = ? WHERE id = ?', [committedOrder.dispense_status, orderId]).catch(() => {});
    }
  } else {
    const existing = await getAuthoritativeOrderById(orderId, db);
    if (!existing) {
      throw new NotFoundError(`Order with ID ${orderId} not found`);
    }
    if (String(existing.machine_id || '').trim() !== machineId) {
      throw new ForbiddenError(
        `Machine ${machineId} cannot update dispense result for order ${orderId} belonging to ${existing.machine_id}`
      );
    }
    const currentDispense = String(existing.dispense_status || 'QUEUED').toUpperCase();
    const resolvedStage =
      params.failureStage ||
      (currentDispense === 'DISPENSING' || Boolean(existing.dispense_started_at)
        ? 'DURING_DISPENSE'
        : 'PRE_DISPENSE');
    committedOrder = {
      ...existing,
      dispense_status: targetDispenseStatus,
      dispensed: targetDispenseStatus === 'DISPENSED',
      dispense_outcome:
        targetDispenseStatus === 'DISPENSED'
          ? 'DISPENSED'
          : resolvedStage === 'PRE_DISPENSE'
            ? 'NOT_DISPENSED'
            : 'UNCERTAIN',
      failure_stage: targetDispenseStatus === 'DISPENSED' ? undefined : resolvedStage,
      failure_reason: params.failureReason ? String(params.failureReason).trim() : null,
      updated_at: nowIso
    };
    await db.run('UPDATE orders SET dispense_status = ? WHERE id = ?', [targetDispenseStatus, orderId]).catch(() => {});
    updateSyncedFirebaseOrder(orderId, committedOrder);
  }

  let autoRefund: Awaited<ReturnType<typeof processAutoRefundForOrder>> | undefined;
  if (
    (targetDispenseStatus === 'FAILED' || targetDispenseStatus === 'EXPIRED') &&
    committedOrder.dispense_outcome === 'NOT_DISPENSED'
  ) {
    autoRefund = await processAutoRefundForOrder(db, orderId, { nowMs: params.nowMs });
  }

  const latestOrder = (await getAuthoritativeOrderById(orderId, db)) || committedOrder;
  return { order: latestOrder, autoRefund };
}

/**
 * Safely reconciles any `PENDING` refund reservations on an order against Razorpay's
 * authoritative refund status (`refunds.fetch` or `payments.fetchRefunds`).
 * Never initiates a new refund — only settles existing `PENDING` reservations once
 * Razorpay reports a terminal `processed` or `failed` outcome.
 */
export async function reconcilePendingRefundsForOrder(
  db: any,
  order: any
): Promise<{
  settledProcessed: number;
  settledFailed: number;
  stillPending: number;
}> {
  const result = { settledProcessed: 0, settledFailed: 0, stillPending: 0 };
  if (!order || !order.id || !order.razorpay_payment_id) {
    return result;
  }

  const refundStatus = String(order.refund_status || '').toUpperCase();
  const pendingPaise = Number(order.pending_refund_amount_paise || 0);
  if (refundStatus !== 'PENDING' && pendingPaise <= 0) {
    return result;
  }

  let razorpayClient: any = null;
  try {
    const cfg = resolveRazorpayRefundConfig();
    razorpayClient = cfg.razorpayClient;
  } catch {
    return result;
  }

  if (!razorpayClient) {
    return result;
  }

  const refunds = await getRefundsByOrderId(db, String(order.id));
  const pendingRefunds = refunds.filter((r) => String(r.status || '').toUpperCase() === 'PENDING');
  if (pendingRefunds.length === 0) {
    return result;
  }

  for (const pendingRefund of pendingRefunds) {
    try {
      let gwRefund: any = null;

      if (
        pendingRefund.razorpay_refund_id &&
        typeof razorpayClient.refunds?.fetch === 'function'
      ) {
        gwRefund = await razorpayClient.refunds.fetch(String(pendingRefund.razorpay_refund_id));
      } else if (typeof razorpayClient.payments?.fetchRefunds === 'function') {
        const listResp = await razorpayClient.payments.fetchRefunds(
          String(order.razorpay_payment_id)
        );
        const items: any[] = Array.isArray(listResp)
          ? listResp
          : Array.isArray(listResp?.items)
            ? listResp.items
            : [];
        gwRefund =
          items.find(
            (item) =>
              String(item?.receipt || '').trim() === pendingRefund.id ||
              String(item?.notes?.refund_id || '').trim() === pendingRefund.id
          ) || null;
      }

      if (!gwRefund || typeof gwRefund !== 'object') {
        result.stillPending += 1;
        continue;
      }

      const gwPaymentId = String(gwRefund.payment_id || order.razorpay_payment_id).trim();
      const gwAmount = Number(gwRefund.amount);
      const gwCurrency = String(gwRefund.currency || 'INR').trim().toUpperCase();
      if (
        gwPaymentId !== String(order.razorpay_payment_id).trim() ||
        gwAmount !== Number(pendingRefund.amount_paise) ||
        gwCurrency !== 'INR'
      ) {
        logger.error(
          `[Pending Refund Reconciliation] Gateway refund mismatch for ${pendingRefund.id} on order ${order.id}: expected=${pendingRefund.amount_paise} INR (${order.razorpay_payment_id}), got=${gwAmount} ${gwCurrency} (${gwPaymentId})`
        );
        result.stillPending += 1;
        continue;
      }

      const gwStatus = String(gwRefund.status || '').trim().toLowerCase();
      const gwRefundId = gwRefund.id ? String(gwRefund.id).trim() : null;

      if (gwStatus === 'processed') {
        const processedAtIso = gwRefund.created_at
          ? new Date(Number(gwRefund.created_at) * 1000).toISOString()
          : new Date().toISOString();
        await markRefundProcessed(db, {
          refundId: pendingRefund.id,
          razorpay_refund_id: gwRefundId || pendingRefund.razorpay_refund_id,
          processed_at: processedAtIso
        });
        result.settledProcessed += 1;
      } else if (gwStatus === 'failed') {
        await markRefundFailed(db, {
          refundId: pendingRefund.id,
          error_code: gwRefund.error_code ? String(gwRefund.error_code) : 'GATEWAY_REFUND_FAILED',
          error_description: gwRefund.error_description
            ? String(gwRefund.error_description)
            : 'Pending refund failed at Razorpay gateway'
        });
        result.settledFailed += 1;
      } else {
        if (!pendingRefund.razorpay_refund_id && gwRefundId) {
          await recordPendingRefundGatewayId(db, {
            refundId: pendingRefund.id,
            razorpay_refund_id: gwRefundId
          });
        }
        result.stillPending += 1;
      }
    } catch (err: any) {
      logger.warn(
        `[Pending Refund Reconciliation] Lookup failed for pending refund ${pendingRefund.id} on order ${order.id}: ${err?.message || 'Unknown error'}`
      );
      result.stillPending += 1;
    }
  }

  return result;
}

/**
 * Sweeps paid orders in Firestore / local mirror under a distributed lease, safely expiring
 * unclaimed stale QUEUED orders, reconciling pending gateway refunds, and initiating idempotent
 * Razorpay refunds ONLY for confirmed non-dispensed orders. Failures are isolated per order so
 * one machine never blocks another.
 */
export async function runAutoRefundSweep(
  options: AutoRefundSweepOptions = {}
): Promise<AutoRefundSweepSummary> {
  ensureFirebaseReady();
  const db = getDB();
  const resolveSweepNowMs = (): number =>
    Number.isFinite(options.nowMs) ? Number(options.nowMs) : Date.now();
  const initialNowMs = resolveSweepNowMs();
  const expiryMs = resolveAutoRefundQueuedExpiryMs(options.queuedExpiryMs);
  const dispensingTimeoutMs = resolveAutoRefundDispensingTimeoutMs(options.dispensingTimeoutMs);
  const initialCutoffIso = new Date(initialNowMs - expiryMs).toISOString();
  const limit =
    options.limit !== undefined && Number.isFinite(Number(options.limit)) && Number(options.limit) > 0
      ? Math.min(200, Math.max(1, Math.floor(Number(options.limit))))
      : 20;

  const summary: AutoRefundSweepSummary = {
    scanned: 0,
    eligible: 0,
    expired_queued: 0,
    refunded_processed: 0,
    refund_pending: 0,
    refund_failed: 0,
    replayed: 0,
    reconciled_pending_processed: 0,
    reconciled_pending_failed: 0,
    skipped_dispensing: 0,
    skipped_uncertain: 0,
    skipped_dispensed: 0,
    skipped_unverified: 0,
    skipped_already_refunded: 0,
    skipped_not_expired: 0,
    skipped_other: 0,
    errors: 0,
    expiry_ms: expiryMs,
    cutoff_iso: initialCutoffIso
  };

  const dryRun = options.dryRun === true;
  const machineIdFilter = options.machineId ? String(options.machineId).trim() : undefined;

  if (dryRun) {
    const nowMs = initialNowMs;
    // Strictly read-only dry-run: zero lease locks, zero Firestore writes, zero Razorpay calls
    const pendingOrders = await getPendingRefundOrdersFromFirebase(db, {
      machineId: machineIdFilter,
      limit,
      hydrateLocal: false
    });
    const paidOrders = await getPaidOrdersForAutoRefundFromFirebase(db, {
      machineId: machineIdFilter,
      limit,
      hydrateLocal: false
    });

    const scannedIds = new Set<string>();
    const pendingByOrderId = new Map<string, AutoRefundDryRunPendingCandidateReport>();

    const toPendingCandidateReport = (order: any): AutoRefundDryRunPendingCandidateReport => ({
      order_id: String(order.id),
      machine_id: order.machine_id ? String(order.machine_id) : null,
      status: String(order.status || 'UNKNOWN').toUpperCase(),
      dispense_status: String(order.dispense_status || 'PENDING').toUpperCase(),
      refund_status: String(order.refund_status || 'NONE').toUpperCase(),
      pending_refund_amount_paise: Number(order.pending_refund_amount_paise || 0),
      total_refunded_amount_paise: Number(order.total_refunded_amount_paise || 0),
      captured_amount_paise:
        order.captured_amount_paise !== undefined && order.captured_amount_paise !== null
          ? Number(order.captured_amount_paise)
          : null,
      razorpay_payment_id: order.razorpay_payment_id ? String(order.razorpay_payment_id) : null,
      reason: 'PENDING_REFUND_RECONCILIATION'
    });

    for (const order of pendingOrders) {
      if (!order?.id) continue;
      const orderId = String(order.id);
      scannedIds.add(orderId);
      if (!pendingByOrderId.has(orderId)) {
        pendingByOrderId.set(orderId, toPendingCandidateReport(order));
      }
    }

    const dryRunOrders: AutoRefundDryRunOrderReport[] = [];
    for (const order of paidOrders) {
      if (!order?.id) continue;
      const orderId = String(order.id);
      scannedIds.add(orderId);

      const isPendingOrder =
        String(order?.refund_status || '').toUpperCase() === 'PENDING' ||
        Number(order?.pending_refund_amount_paise || 0) > 0;
      if (isPendingOrder && !pendingByOrderId.has(orderId) && pendingByOrderId.size < limit) {
        pendingByOrderId.set(orderId, toPendingCandidateReport(order));
      }

      const evaluation = evaluateAutoRefundEligibility(order, nowMs, expiryMs, dispensingTimeoutMs);
      const balance = calculateRemainingRefundableBalance(order);
      const willRefundPaise =
        evaluation.eligible && balance.isExactCaptureKnown ? balance.remainingRefundablePaise : 0;
      const wouldExpire = Boolean(evaluation.eligible && evaluation.needsExpiryTransition);

      if (evaluation.eligible) {
        summary.eligible += 1;
        if (wouldExpire) {
          summary.expired_queued += 1;
        }
      } else {
        recordAutoRefundSkipReason(summary, evaluation.skipReason);
      }

      dryRunOrders.push({
        order_id: orderId,
        machine_id: order.machine_id ? String(order.machine_id) : null,
        status: String(order.status || 'UNKNOWN').toUpperCase(),
        dispense_status: String(order.dispense_status || 'PENDING').toUpperCase(),
        refund_status: String(order.refund_status || 'NONE').toUpperCase(),
        eligible: evaluation.eligible,
        eligibility_reason: evaluation.eligible ? (evaluation.triggerReason || null) : null,
        skip_reason: evaluation.eligible ? null : (evaluation.skipReason || null),
        refund_amount_paise: willRefundPaise,
        captured_amount_paise:
          order.captured_amount_paise !== undefined && order.captured_amount_paise !== null
            ? Number(order.captured_amount_paise)
            : null,
        total_refunded_amount_paise: Number(order.total_refunded_amount_paise || 0),
        pending_refund_amount_paise: Number(order.pending_refund_amount_paise || 0),
        paid_at: order.paid_at ? String(order.paid_at) : null,
        expires_at: order.expires_at ? String(order.expires_at) : null,
        would_expire_to_expired: wouldExpire,
        details: evaluation.details
      });
    }

    const pendingCandidates = Array.from(pendingByOrderId.values());
    summary.dry_run = true;
    summary.limit = limit;
    summary.scanned = scannedIds.size;
    summary.skipped = dryRunOrders.filter((entry) => !entry.eligible).length;
    summary.pending_reconciliation_count = pendingCandidates.length;
    summary.orders = dryRunOrders;
    summary.pending_reconciliation_candidates = pendingCandidates;
    return summary;
  }

  const lease = await acquireAutoRefundLeaseInFirebase();
  if (!lease.acquired) {
    summary.skipped_due_to_active_run = true;
    return summary;
  }

  // Capture authoritative sweep timestamp AFTER acquiring the dedicated auto-refund lease
  const nowMs = resolveSweepNowMs();
  summary.cutoff_iso = new Date(nowMs - expiryMs).toISOString();

  try {
    const pendingOrders = await getPendingRefundOrdersFromFirebase(db, {
      machineId: machineIdFilter,
      limit
    });
    const paidOrders = await getPaidOrdersForAutoRefundFromFirebase(db, {
      machineId: machineIdFilter,
      limit
    });

    const scannedIds = new Set<string>();
    const handledOrderIds = new Set<string>();

    for (const order of pendingOrders) {
      if (order?.id) scannedIds.add(String(order.id));
      try {
        const pendingRecon = await reconcilePendingRefundsForOrder(db, order);
        summary.reconciled_pending_processed =
          (summary.reconciled_pending_processed || 0) + pendingRecon.settledProcessed;
        summary.reconciled_pending_failed =
          (summary.reconciled_pending_failed || 0) + pendingRecon.settledFailed;
        if (pendingRecon.settledProcessed > 0) {
          summary.refunded_processed += pendingRecon.settledProcessed;
          if (order?.id) handledOrderIds.add(String(order.id));
        } else if (pendingRecon.settledFailed > 0) {
          summary.refund_failed += pendingRecon.settledFailed;
          if (order?.id) handledOrderIds.add(String(order.id));
        } else if (pendingRecon.stillPending > 0) {
          summary.skipped_already_refunded += 1;
          if (order?.id) handledOrderIds.add(String(order.id));
        }
      } catch (err) {
        summary.errors += 1;
        if (order?.id) handledOrderIds.add(String(order.id));
        logger.error(`[Auto-Refund Sweep] Error reconciling pending refund for order ${order?.id}:`, err);
      }
    }

    for (const order of paidOrders) {
      if (order?.id) scannedIds.add(String(order.id));
      if (order?.id && handledOrderIds.has(String(order.id))) {
        continue;
      }
      try {
        if (
          String(order?.refund_status || '').toUpperCase() === 'PENDING' ||
          Number(order?.pending_refund_amount_paise || 0) > 0
        ) {
          const pendingRecon = await reconcilePendingRefundsForOrder(db, order);
          summary.reconciled_pending_processed =
            (summary.reconciled_pending_processed || 0) + pendingRecon.settledProcessed;
          summary.reconciled_pending_failed =
            (summary.reconciled_pending_failed || 0) + pendingRecon.settledFailed;
          if (pendingRecon.settledProcessed > 0) {
            summary.refunded_processed += pendingRecon.settledProcessed;
            continue;
          }
          if (pendingRecon.settledFailed > 0) {
            summary.refund_failed += pendingRecon.settledFailed;
            continue;
          }
          if (pendingRecon.stillPending > 0) {
            summary.skipped_already_refunded += 1;
            continue;
          }
        }

        const res = await processAutoRefundForOrder(db, order.id, {
          nowMs,
          queuedExpiryMs: expiryMs,
          dispensingTimeoutMs
        });

        if (res.didExpireQueued) {
          summary.expired_queued += 1;
        }

        if (res.status === 'skipped') {
          recordAutoRefundSkipReason(summary, res.skipReason);
          continue;
        }

        summary.eligible += 1;
        if (res.status === 'refunded') summary.refunded_processed += 1;
        else if (res.status === 'pending' || res.status === 'mismatch') summary.refund_pending += 1;
        else if (res.status === 'failed') summary.refund_failed += 1;
        else if (res.status === 'replayed') summary.replayed += 1;
      } catch (err) {
        summary.errors += 1;
        logger.error(`[Auto-Refund Sweep] Error processing order ${order?.id}:`, err);
      }
    }

    summary.scanned = scannedIds.size;
    return summary;
  } finally {
    await releaseAutoRefundLeaseInFirebase(lease.lockId);
  }
}

export async function assertMachineOnlineIfGuardEnabled(
  machineId: string,
  db: any,
  preloadedMachine?: any
): Promise<void> {
  if (!isOfflineMachineOrderBlockingEnabled()) {
    return;
  }
  const machine = preloadedMachine || (await getAuthoritativeMachineState(machineId, db));
  const connStatus = machine?.connection_status || computeConnectionStatus(machine?.last_seen);
  if (connStatus === 'OFFLINE') {
    throw new ServiceUnavailableError(
      `Machine ${machineId} is currently offline (no recent Raspberry Pi heartbeat)`
    );
  }
}
