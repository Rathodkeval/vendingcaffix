import { getAuthoritativeOrderById, getAuthoritativeOrders, isFirestoreActive, getFirestoreInstance } from '../utils/firebase';
import { getRefundsByOrderId } from '../utils/refunds';
import { getInventoryLedgerForOrder, InventoryMovementRecord } from '../utils/inventoryLedger';
import logger from '../utils/logger';

export type ReconciliationResult = 'MATCH' | 'DISCREPANCY' | 'PENDING_ACTION';

export type DiscrepancyReason =
  | 'NONE'
  | 'UNVERIFIED_GATEWAY_PAYMENT'
  | 'MISSING_PAYMENT_REFERENCE'
  | 'PAYMENT_AMOUNT_MISMATCH'
  | 'DUPLICATE_PAYMENT_EVENT'
  | 'FAILED_PAYMENT_ACTIVE_STATUS'
  | 'DISPENSING_STUCK_QUEUED'
  | 'DISPENSING_IN_PROGRESS_TIMEOUT'
  | 'DISPENSE_FAILED_UNREFUNDED'
  | 'UNCERTAIN_DISPENSE_OUTCOME'
  | 'INVENTORY_DEDUCTION_MISSING'
  | 'INVENTORY_DEDUCTION_DUPLICATED'
  | 'REFUND_EXCEEDS_CAPTURE'
  | 'REFUND_LEDGER_MISMATCH'
  | 'REFUND_PENDING_STALE'
  | 'MACHINE_ID_MISMATCH';

export type RecommendedAction =
  | 'NO_ACTION'
  | 'VERIFY_GATEWAY_AND_SYNC_PAID'
  | 'RECORD_CAPTURED_AMOUNT'
  | 'MANUAL_REVIEW_FINANCES'
  | 'INITIATE_REFUND'
  | 'CHECK_MACHINE_CONNECTIVITY'
  | 'INVESTIGATE_HARDWARE_DISPENSE'
  | 'RECORD_INVENTORY_LEDGER'
  | 'RELEASE_STALE_PENDING_REFUND'
  | 'FLAG_DATA_CORRUPTION';

export interface GatewayPaymentEvidence {
  order_id?: string;
  payment_id?: string;
  amount_paise?: number;
  currency?: string;
  status: 'captured' | 'failed' | 'cancelled' | 'authorized' | 'created';
}

export interface OrderReconciliationItem {
  order_id: string;
  machine_id: string;
  payment_status: string;
  dispense_status: string;
  order_amount_inr: number;
  captured_amount_paise: number | null;
  total_refunded_paise: number;
  pending_refund_paise: number;
  inventory_movement_status: 'RECORDED' | 'MISSING' | 'DUPLICATED' | 'NOT_APPLICABLE';
  reconciliation_result: ReconciliationResult;
  discrepancy_reason: DiscrepancyReason;
  recommended_action: RecommendedAction;
  details: string;
  created_at: string;
  updated_at?: string;
}

export interface ReconciliationReportSummary {
  total_orders: number;
  matched: number;
  discrepancies: number;
  pending_actions: number;
  discrepancies_by_reason: Record<string, number>;
  financial_summary: {
    total_captured_paise: number;
    total_refunded_paise: number;
    total_pending_refund_paise: number;
  };
}

export interface ReconciliationReport {
  status: 'success';
  generated_at: string;
  machine_scope: string | 'FLEET_WIDE';
  summary: ReconciliationReportSummary;
  data: OrderReconciliationItem[];
}

export interface ReconcileOrderOptions {
  now?: Date;
  queuedTimeoutMs?: number;       // default: 15 minutes (900000 ms)
  dispensingTimeoutMs?: number;   // default: 10 minutes (600000 ms)
  pendingRefundTimeoutMs?: number;// default: 30 minutes (1800000 ms)
  gatewayEvidence?: GatewayPaymentEvidence;
}

/**
 * Reconciles a single order across payment, dispensing, inventory, and refund records.
 */
export function reconcileOrderRecord(
  order: any,
  context: {
    refunds: any[];
    inventoryMovements: InventoryMovementRecord[];
    webhookEvents?: any[];
    options?: ReconcileOrderOptions;
  }
): OrderReconciliationItem {
  const now = context.options?.now || new Date();
  const queuedTimeout = context.options?.queuedTimeoutMs ?? 15 * 60 * 1000;
  const dispensingTimeout = context.options?.dispensingTimeoutMs ?? 10 * 60 * 1000;
  const pendingRefundTimeout = context.options?.pendingRefundTimeoutMs ?? 30 * 60 * 1000;
  const gateway = context.options?.gatewayEvidence;

  const orderId = String(order.id);
  const machineId = String(order.machine_id);
  const orderStatus = String(order.status || 'PENDING').toUpperCase();
  const dispenseStatus = String(order.dispense_status || 'PENDING').toUpperCase();
  const orderAmountInr = Number(order.amount || 0);
  const orderAmountPaise = Math.round(orderAmountInr * 100);
  const capturedPaise = order.captured_amount_paise !== undefined && order.captured_amount_paise !== null
    ? Number(order.captured_amount_paise)
    : null;
  const totalRefundedPaise = Number(order.total_refunded_amount_paise || 0);
  const pendingRefundPaise = Number(order.pending_refund_amount_paise || 0);
  const refunds = context.refunds || [];
  const invMovements = context.inventoryMovements || [];
  const createdAtMs = order.created_at ? new Date(order.created_at).getTime() : now.getTime();
  const updatedAtMs = order.updated_at ? new Date(order.updated_at).getTime() : createdAtMs;
  const dispenseStartedAtMs = order.dispense_started_at ? new Date(order.dispense_started_at).getTime() : updatedAtMs;

  // Inventory movement status determination
  let inventoryStatus: 'RECORDED' | 'MISSING' | 'DUPLICATED' | 'NOT_APPLICABLE' = 'NOT_APPLICABLE';
  if (['PAID', 'PREPARING', 'COMPLETED'].includes(orderStatus)) {
    if (invMovements.length === 0) {
      inventoryStatus = 'MISSING';
    } else {
      // Check for duplicate deductions for the same ingredient
      const seenIngredients = new Set<string>();
      let hasDuplicates = false;
      for (const m of invMovements) {
        if (m.movement_type === 'DEDUCTION') {
          if (seenIngredients.has(m.ingredient)) {
            hasDuplicates = true;
            break;
          }
          seenIngredients.add(m.ingredient);
        }
      }
      inventoryStatus = hasDuplicates ? 'DUPLICATED' : 'RECORDED';
    }
  }

  // 1. Payment Reconciliation
  // A. PENDING order with confirmed successful payment at gateway
  if (orderStatus === 'PENDING' && gateway && gateway.status === 'captured') {
    return {
      order_id: orderId,
      machine_id: machineId,
      payment_status: orderStatus,
      dispense_status: dispenseStatus,
      order_amount_inr: orderAmountInr,
      captured_amount_paise: capturedPaise,
      total_refunded_paise: totalRefundedPaise,
      pending_refund_paise: pendingRefundPaise,
      inventory_movement_status: inventoryStatus,
      reconciliation_result: 'DISCREPANCY',
      discrepancy_reason: 'UNVERIFIED_GATEWAY_PAYMENT',
      recommended_action: 'VERIFY_GATEWAY_AND_SYNC_PAID',
      details: `Gateway confirms captured payment (${gateway.payment_id}) but order remains PENDING in CAFFIX.`,
      created_at: order.created_at,
      updated_at: order.updated_at
    };
  }

  // B. FAILED or CANCELLED at gateway but marked PAID in CAFFIX
  if (['PAID', 'PREPARING', 'COMPLETED'].includes(orderStatus) && gateway && (gateway.status === 'failed' || gateway.status === 'cancelled')) {
    return {
      order_id: orderId,
      machine_id: machineId,
      payment_status: orderStatus,
      dispense_status: dispenseStatus,
      order_amount_inr: orderAmountInr,
      captured_amount_paise: capturedPaise,
      total_refunded_paise: totalRefundedPaise,
      pending_refund_paise: pendingRefundPaise,
      inventory_movement_status: inventoryStatus,
      reconciliation_result: 'DISCREPANCY',
      discrepancy_reason: 'FAILED_PAYMENT_ACTIVE_STATUS',
      recommended_action: 'FLAG_DATA_CORRUPTION',
      details: `Gateway reports payment ${gateway.status} but CAFFIX order is ${orderStatus}.`,
      created_at: order.created_at,
      updated_at: order.updated_at
    };
  }

  // C. PAID order with missing payment reference
  if (['PAID', 'PREPARING', 'COMPLETED'].includes(orderStatus) && !order.razorpay_payment_id) {
    return {
      order_id: orderId,
      machine_id: machineId,
      payment_status: orderStatus,
      dispense_status: dispenseStatus,
      order_amount_inr: orderAmountInr,
      captured_amount_paise: capturedPaise,
      total_refunded_paise: totalRefundedPaise,
      pending_refund_paise: pendingRefundPaise,
      inventory_movement_status: inventoryStatus,
      reconciliation_result: 'DISCREPANCY',
      discrepancy_reason: 'MISSING_PAYMENT_REFERENCE',
      recommended_action: 'RECORD_CAPTURED_AMOUNT',
      details: 'Order marked PAID without authoritative razorpay_payment_id.',
      created_at: order.created_at,
      updated_at: order.updated_at
    };
  }

  // D. Payment amount mismatch (order amount != captured amount)
  if (capturedPaise !== null && orderAmountPaise > 0 && capturedPaise !== orderAmountPaise) {
    return {
      order_id: orderId,
      machine_id: machineId,
      payment_status: orderStatus,
      dispense_status: dispenseStatus,
      order_amount_inr: orderAmountInr,
      captured_amount_paise: capturedPaise,
      total_refunded_paise: totalRefundedPaise,
      pending_refund_paise: pendingRefundPaise,
      inventory_movement_status: inventoryStatus,
      reconciliation_result: 'DISCREPANCY',
      discrepancy_reason: 'PAYMENT_AMOUNT_MISMATCH',
      recommended_action: 'MANUAL_REVIEW_FINANCES',
      details: `Order created for ${orderAmountPaise} paise (₹${orderAmountInr}) but gateway captured ${capturedPaise} paise.`,
      created_at: order.created_at,
      updated_at: order.updated_at
    };
  }

  // 2. Dispensing Reconciliation
  // A. PAID order remaining QUEUED past timeout
  if (['PAID'].includes(orderStatus) && dispenseStatus === 'QUEUED') {
    const ageMs = now.getTime() - createdAtMs;
    if (ageMs > queuedTimeout) {
      return {
        order_id: orderId,
        machine_id: machineId,
        payment_status: orderStatus,
        dispense_status: dispenseStatus,
        order_amount_inr: orderAmountInr,
        captured_amount_paise: capturedPaise,
        total_refunded_paise: totalRefundedPaise,
        pending_refund_paise: pendingRefundPaise,
        inventory_movement_status: inventoryStatus,
        reconciliation_result: 'DISCREPANCY',
        discrepancy_reason: 'DISPENSING_STUCK_QUEUED',
        recommended_action: 'CHECK_MACHINE_CONNECTIVITY',
        details: `Order has been queued for ${Math.round(ageMs / 60000)} minutes without beverage preparation starting.`,
        created_at: order.created_at,
        updated_at: order.updated_at
      };
    }
  }

  // B. Order stuck in DISPENSING past timeout
  if (dispenseStatus === 'DISPENSING') {
    const activeDispenseAge = now.getTime() - dispenseStartedAtMs;
    if (activeDispenseAge > dispensingTimeout) {
      return {
        order_id: orderId,
        machine_id: machineId,
        payment_status: orderStatus,
        dispense_status: dispenseStatus,
        order_amount_inr: orderAmountInr,
        captured_amount_paise: capturedPaise,
        total_refunded_paise: totalRefundedPaise,
        pending_refund_paise: pendingRefundPaise,
        inventory_movement_status: inventoryStatus,
        reconciliation_result: 'DISCREPANCY',
        discrepancy_reason: 'DISPENSING_IN_PROGRESS_TIMEOUT',
        recommended_action: 'INVESTIGATE_HARDWARE_DISPENSE',
        details: `Order has been in DISPENSING status for ${Math.round(activeDispenseAge / 60000)} minutes without completion.`,
        created_at: order.created_at,
        updated_at: order.updated_at
      };
    }
  }

  // C. Dispense FAILED but unrefunded
  const isDispenseFailed = dispenseStatus === 'FAILED' || orderStatus === 'FAILED';
  const hasCapturedPayment = (capturedPaise !== null && capturedPaise > 0) || Boolean(order.razorpay_payment_id);
  if (isDispenseFailed && hasCapturedPayment && totalRefundedPaise === 0 && pendingRefundPaise === 0) {
    return {
      order_id: orderId,
      machine_id: machineId,
      payment_status: orderStatus,
      dispense_status: dispenseStatus,
      order_amount_inr: orderAmountInr,
      captured_amount_paise: capturedPaise,
      total_refunded_paise: totalRefundedPaise,
      pending_refund_paise: pendingRefundPaise,
      inventory_movement_status: inventoryStatus,
      reconciliation_result: 'DISCREPANCY',
      discrepancy_reason: 'DISPENSE_FAILED_UNREFUNDED',
      recommended_action: 'INITIATE_REFUND',
      details: 'Dispense failed or was aborted after payment was captured, but no refund has been initiated.',
      created_at: order.created_at,
      updated_at: order.updated_at
    };
  }

  // D. Inconsistent dispense status (e.g. COMPLETED order with dispense_status PENDING or FAILED)
  if (orderStatus === 'COMPLETED' && (dispenseStatus === 'PENDING' || dispenseStatus === 'FAILED')) {
    return {
      order_id: orderId,
      machine_id: machineId,
      payment_status: orderStatus,
      dispense_status: dispenseStatus,
      order_amount_inr: orderAmountInr,
      captured_amount_paise: capturedPaise,
      total_refunded_paise: totalRefundedPaise,
      pending_refund_paise: pendingRefundPaise,
      inventory_movement_status: inventoryStatus,
      reconciliation_result: 'DISCREPANCY',
      discrepancy_reason: 'UNCERTAIN_DISPENSE_OUTCOME',
      recommended_action: 'INVESTIGATE_HARDWARE_DISPENSE',
      details: `Order status is COMPLETED but dispense_status is "${dispenseStatus}". Physical outcome uncertain.`,
      created_at: order.created_at,
      updated_at: order.updated_at
    };
  }

  // 3. Refund Reconciliation
  // A. Refund amount exceeds captured amount
  if (capturedPaise !== null && totalRefundedPaise > capturedPaise) {
    return {
      order_id: orderId,
      machine_id: machineId,
      payment_status: orderStatus,
      dispense_status: dispenseStatus,
      order_amount_inr: orderAmountInr,
      captured_amount_paise: capturedPaise,
      total_refunded_paise: totalRefundedPaise,
      pending_refund_paise: pendingRefundPaise,
      inventory_movement_status: inventoryStatus,
      reconciliation_result: 'DISCREPANCY',
      discrepancy_reason: 'REFUND_EXCEEDS_CAPTURE',
      recommended_action: 'MANUAL_REVIEW_FINANCES',
      details: `Total refunded amount (${totalRefundedPaise} paise) exceeds captured payment (${capturedPaise} paise).`,
      created_at: order.created_at,
      updated_at: order.updated_at
    };
  }

  // B. Refund sum mismatch
  const processedRefundsSum = refunds
    .filter((r) => String(r.status).toUpperCase() === 'PROCESSED')
    .reduce((sum, r) => sum + Number(r.amount_paise || 0), 0);
  if (processedRefundsSum !== totalRefundedPaise) {
    return {
      order_id: orderId,
      machine_id: machineId,
      payment_status: orderStatus,
      dispense_status: dispenseStatus,
      order_amount_inr: orderAmountInr,
      captured_amount_paise: capturedPaise,
      total_refunded_paise: totalRefundedPaise,
      pending_refund_paise: pendingRefundPaise,
      inventory_movement_status: inventoryStatus,
      reconciliation_result: 'DISCREPANCY',
      discrepancy_reason: 'REFUND_LEDGER_MISMATCH',
      recommended_action: 'MANUAL_REVIEW_FINANCES',
      details: `Sum of PROCESSED refund documents (${processedRefundsSum} paise) does not match order.total_refunded_amount_paise (${totalRefundedPaise} paise).`,
      created_at: order.created_at,
      updated_at: order.updated_at
    };
  }

  // C. Stale pending refund reservation
  if (pendingRefundPaise > 0) {
    const pendingAge = now.getTime() - updatedAtMs;
    if (pendingAge > pendingRefundTimeout) {
      return {
        order_id: orderId,
        machine_id: machineId,
        payment_status: orderStatus,
        dispense_status: dispenseStatus,
        order_amount_inr: orderAmountInr,
        captured_amount_paise: capturedPaise,
        total_refunded_paise: totalRefundedPaise,
        pending_refund_paise: pendingRefundPaise,
        inventory_movement_status: inventoryStatus,
        reconciliation_result: 'DISCREPANCY',
        discrepancy_reason: 'REFUND_PENDING_STALE',
        recommended_action: 'RELEASE_STALE_PENDING_REFUND',
        details: `Pending refund reservation of ${pendingRefundPaise} paise has been unresolved for ${Math.round(pendingAge / 60000)} minutes.`,
        created_at: order.created_at,
        updated_at: order.updated_at
      };
    }
  }

  // 4. Inventory Ledger Reconciliation
  if (inventoryStatus === 'DUPLICATED') {
    return {
      order_id: orderId,
      machine_id: machineId,
      payment_status: orderStatus,
      dispense_status: dispenseStatus,
      order_amount_inr: orderAmountInr,
      captured_amount_paise: capturedPaise,
      total_refunded_paise: totalRefundedPaise,
      pending_refund_paise: pendingRefundPaise,
      inventory_movement_status: inventoryStatus,
      reconciliation_result: 'DISCREPANCY',
      discrepancy_reason: 'INVENTORY_DEDUCTION_DUPLICATED',
      recommended_action: 'FLAG_DATA_CORRUPTION',
      details: 'Multiple inventory deductions found for the same order and ingredient.',
      created_at: order.created_at,
      updated_at: order.updated_at
    };
  }

  if (inventoryStatus === 'MISSING') {
    return {
      order_id: orderId,
      machine_id: machineId,
      payment_status: orderStatus,
      dispense_status: dispenseStatus,
      order_amount_inr: orderAmountInr,
      captured_amount_paise: capturedPaise,
      total_refunded_paise: totalRefundedPaise,
      pending_refund_paise: pendingRefundPaise,
      inventory_movement_status: inventoryStatus,
      reconciliation_result: 'PENDING_ACTION',
      discrepancy_reason: 'INVENTORY_DEDUCTION_MISSING',
      recommended_action: 'RECORD_INVENTORY_LEDGER',
      details: 'Active paid order has no corresponding inventory ledger deduction records.',
      created_at: order.created_at,
      updated_at: order.updated_at
    };
  }

  // 5. Perfect Match
  return {
    order_id: orderId,
    machine_id: machineId,
    payment_status: orderStatus,
    dispense_status: dispenseStatus,
    order_amount_inr: orderAmountInr,
    captured_amount_paise: capturedPaise,
    total_refunded_paise: totalRefundedPaise,
    pending_refund_paise: pendingRefundPaise,
    inventory_movement_status: inventoryStatus,
    reconciliation_result: 'MATCH',
    discrepancy_reason: 'NONE',
    recommended_action: 'NO_ACTION',
    details: 'Order matches all financial, dispensing, inventory and refund invariants.',
    created_at: order.created_at,
    updated_at: order.updated_at
  };
}

/**
 * Generates an end-to-end reconciliation report for a fleet or machine.
 */
export async function generateReconciliationReport(
  db: any,
  options?: {
    machineIds?: string[];
    resultFilter?: ReconciliationResult;
    discrepancyFilter?: DiscrepancyReason;
    options?: ReconcileOrderOptions;
  }
): Promise<ReconciliationReport> {
  const machineIds = options?.machineIds;
  // Distinguish an explicit empty machine list (e.g. Owner with 0 assigned machines)
  // from an unrestricted Admin fleet query (machineIds === undefined).
  if (Array.isArray(machineIds) && machineIds.length === 0) {
    return {
      status: 'success',
      generated_at: new Date().toISOString(),
      machine_scope: 'NONE',
      summary: {
        total_orders: 0,
        matched: 0,
        discrepancies: 0,
        pending_actions: 0,
        discrepancies_by_reason: {},
        financial_summary: {
          total_captured_paise: 0,
          total_refunded_paise: 0,
          total_pending_refund_paise: 0
        }
      },
      data: []
    };
  }

  const orders = await getAuthoritativeOrders(db, machineIds);

  const reportData: OrderReconciliationItem[] = [];
  const discrepanciesByReason: Record<string, number> = {};
  let totalCaptured = 0;
  let totalRefunded = 0;
  let totalPendingRefund = 0;
  let matchedCount = 0;
  let discrepancyCount = 0;
  let pendingActionCount = 0;

  for (const order of orders) {
    const [refunds, inventoryMovements] = await Promise.all([
      getRefundsByOrderId(db, order.id).catch(() => []),
      getInventoryLedgerForOrder(db, order.id).catch(() => [])
    ]);

    const item = reconcileOrderRecord(order, {
      refunds,
      inventoryMovements,
      options: options?.options
    });

    if (item.captured_amount_paise) {
      totalCaptured += item.captured_amount_paise;
    }
    totalRefunded += item.total_refunded_paise;
    totalPendingRefund += item.pending_refund_paise;

    if (item.reconciliation_result === 'MATCH') {
      matchedCount++;
    } else if (item.reconciliation_result === 'DISCREPANCY') {
      discrepancyCount++;
      discrepanciesByReason[item.discrepancy_reason] = (discrepanciesByReason[item.discrepancy_reason] || 0) + 1;
    } else if (item.reconciliation_result === 'PENDING_ACTION') {
      pendingActionCount++;
      discrepanciesByReason[item.discrepancy_reason] = (discrepanciesByReason[item.discrepancy_reason] || 0) + 1;
    }

    if (options?.resultFilter && item.reconciliation_result !== options.resultFilter) {
      continue;
    }
    if (options?.discrepancyFilter && item.discrepancy_reason !== options.discrepancyFilter) {
      continue;
    }

    reportData.push(item);
  }

  const machineScope = machineIds && machineIds.length === 1 ? machineIds[0] : (machineIds && machineIds.length > 1 ? `MULTI_MACHINE (${machineIds.join(',')})` : 'FLEET_WIDE');

  return {
    status: 'success',
    generated_at: new Date().toISOString(),
    machine_scope: machineScope,
    summary: {
      total_orders: orders.length,
      matched: matchedCount,
      discrepancies: discrepancyCount,
      pending_actions: pendingActionCount,
      discrepancies_by_reason: discrepanciesByReason,
      financial_summary: {
        total_captured_paise: totalCaptured,
        total_refunded_paise: totalRefunded,
        total_pending_refund_paise: totalPendingRefund
      }
    },
    data: reportData
  };
}

/**
 * Reconciles a single order by ID with optional live gateway evidence.
 */
export async function reconcileSingleOrderById(
  db: any,
  orderId: string,
  options?: ReconcileOrderOptions
): Promise<OrderReconciliationItem | null> {
  const order = await getAuthoritativeOrderById(orderId, db);
  if (!order) return null;

  const [refunds, inventoryMovements] = await Promise.all([
    getRefundsByOrderId(db, order.id).catch(() => []),
    getInventoryLedgerForOrder(db, order.id).catch(() => [])
  ]);

  return reconcileOrderRecord(order, {
    refunds,
    inventoryMovements,
    options
  });
}
