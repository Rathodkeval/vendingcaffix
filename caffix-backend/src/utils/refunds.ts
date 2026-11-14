import crypto from 'crypto';
import { BadRequestError, NotFoundError, ConflictError, ServiceUnavailableError } from './errors';
import { isFirestoreActive, getFirestoreInstance, updateSyncedFirebaseOrder, isStrictFirebaseEnvironment } from './firebase';
import logger from './logger';

export type RefundStatus = 'PENDING' | 'PROCESSED' | 'FAILED';
export type OrderRefundStatus = 'NONE' | 'PENDING' | 'PARTIAL' | 'FULL' | 'FAILED';
export type RefundSource = 'SUPER_ADMIN_PORTAL' | 'RAZORPAY_DASHBOARD' | 'RECONCILIATION';

export interface RefundRecord {
  id: string;
  order_id: string;
  machine_id: string;
  razorpay_payment_id: string;
  razorpay_refund_id: string | null;
  amount_paise: number;
  currency: string;
  status: RefundStatus;
  reason: string;
  notes: string | null;
  initiated_by: string;
  source: RefundSource;
  idempotency_key: string;
  error_code: string | null;
  error_description: string | null;
  created_at: string;
  updated_at: string;
  processed_at: string | null;
}

export interface RefundableBalanceSummary {
  orderAmountPaise: number;
  totalRefundedPaise: number;
  pendingRefundPaise: number;
  remainingRefundablePaise: number;
  isFullyRefunded: boolean;
  canAcceptRefund: boolean;
  isLegacyFallback: boolean;
  isExactCaptureKnown: boolean;
}

export interface WebhookFencingParams {
  provider: string;
  eventId: string;
  claimCount: number;
}

export interface CreateRefundReservationParams {
  orderId: string;
  amount_paise: number;
  reason: string;
  notes?: string | null;
  initiated_by: string;
  source?: RefundSource;
  idempotency_key: string;
  customRefundId?: string;
  razorpay_refund_id?: string | null;
}

export interface MarkRefundProcessedParams {
  refundId: string;
  razorpay_refund_id?: string | null;
  processed_at?: string;
  webhookFencing?: WebhookFencingParams | null;
}

export interface MarkRefundFailedParams {
  refundId: string;
  error_code?: string | null;
  error_description?: string | null;
  webhookFencing?: WebhookFencingParams | null;
}

// In-memory mirror for local tests and cold start simulations
const syncedRefundsStore = new Map<string, RefundRecord>();

class AsyncMutex {
  private queue: Promise<void> = Promise.resolve();

  acquire(): Promise<() => void> {
    let release: () => void;
    const p = new Promise<void>((resolve) => {
      release = resolve;
    });
    const wait = this.queue.then(() => release);
    this.queue = this.queue.then(() => p);
    return wait;
  }
}

const refundTransactionMutex = new AsyncMutex();

export function getSyncedRefundsStore(): Map<string, RefundRecord> {
  return syncedRefundsStore;
}

export function clearSyncedRefundsStore(): void {
  syncedRefundsStore.clear();
}

/**
 * Calculates remaining refundable balance and financial capacity for an order.
 * - All internal arithmetic uses integer paise.
 * - PART C: Authoritative source for captured payment amount:
 *   1. Uses order.captured_amount_paise strictly if present and a positive integer.
 *   2. For historical orders without captured_amount_paise:
 *      If order is in a paid state ('PAID', 'PREPARING', 'COMPLETED'), safely falls back to Math.round(order.amount * 100).
 *      If order is unpaid/failed/cancelled, captured amount is strictly 0.
 * - Remaining refundable balance strictly accounts for confirmed refunds AND pending reservations.
 */
export function calculateRemainingRefundableBalance(order: any): RefundableBalanceSummary {
  if (!order) {
    return {
      orderAmountPaise: 0,
      totalRefundedPaise: 0,
      pendingRefundPaise: 0,
      remainingRefundablePaise: 0,
      isFullyRefunded: false,
      canAcceptRefund: false,
      isLegacyFallback: false,
      isExactCaptureKnown: false
    };
  }

  let orderAmountPaise = 0;
  let isLegacyFallback = false;
  let isExactCaptureKnown = false;

  const rawCaptured = order.captured_amount_paise;
  const isValidCaptured =
    rawCaptured !== undefined &&
    rawCaptured !== null &&
    typeof rawCaptured === 'number' &&
    Number.isInteger(rawCaptured) &&
    Number.isSafeInteger(rawCaptured) &&
    rawCaptured > 0;

  if (isValidCaptured) {
    orderAmountPaise = Number(rawCaptured);
    isExactCaptureKnown = true;
    isLegacyFallback = false;
  } else {
    // Exact captured amount is unknown / unverified.
    // Legacy / historical fallback for display and reporting ONLY.
    isLegacyFallback = true;
    isExactCaptureKnown = false;
    const rawStatus = String(order.status || '').toUpperCase();
    const isPaidState = ['PAID', 'PREPARING', 'COMPLETED'].includes(rawStatus);
    if (isPaidState) {
      orderAmountPaise = Math.round(Number(order.amount || 0) * 100);
      logger.warn(
        `Order ${order.id || 'unknown'} has no verified captured_amount_paise; relying on historical fallback (${orderAmountPaise} paise) for display/reporting only`
      );
    } else {
      orderAmountPaise = 0;
    }
  }

  const totalRefundedPaise = Number(order.total_refunded_amount_paise || 0);
  const pendingRefundPaise = Number(order.pending_refund_amount_paise || 0);
  const reservedTotal = totalRefundedPaise + pendingRefundPaise;
  const remainingRefundablePaise = Math.max(0, orderAmountPaise - reservedTotal);
  const isFullyRefunded = totalRefundedPaise >= orderAmountPaise && orderAmountPaise > 0;

  const status = String(order.status || '').toUpperCase();
  const dispenseStatus = String(order.dispense_status || '').toUpperCase();
  const isEligibleFinancialState = ['PAID', 'PREPARING', 'COMPLETED'].includes(status);
  const isHardwareSafe = dispenseStatus !== 'DISPENSING';

  // Authorization for a real refund STRICTLY requires verified captured amount (isExactCaptureKnown === true)
  const canAcceptRefund =
    isEligibleFinancialState &&
    isHardwareSafe &&
    isExactCaptureKnown &&
    remainingRefundablePaise > 0 &&
    Boolean(order.razorpay_payment_id);

  return {
    orderAmountPaise,
    totalRefundedPaise,
    pendingRefundPaise,
    remainingRefundablePaise,
    isFullyRefunded,
    canAcceptRefund,
    isLegacyFallback,
    isExactCaptureKnown
  };
}

/**
 * Maps a strongly-typed RefundRecord into a Firestore document structure.
 */
export function mapRefundRecordToFirestore(refund: RefundRecord): any {
  return {
    id: refund.id,
    order_id: refund.order_id,
    machine_id: refund.machine_id,
    razorpay_payment_id: refund.razorpay_payment_id,
    razorpay_refund_id: refund.razorpay_refund_id || null,
    amount_paise: Number(refund.amount_paise),
    amount_inr: Math.round(Number(refund.amount_paise) / 100),
    currency: refund.currency || 'INR',
    status: refund.status,
    reason: refund.reason,
    notes: refund.notes || null,
    initiated_by: refund.initiated_by,
    source: refund.source,
    idempotency_key: refund.idempotency_key,
    error_code: refund.error_code || null,
    error_description: refund.error_description || null,
    created_at: refund.created_at,
    updated_at: refund.updated_at,
    processed_at: refund.processed_at || null
  };
}

/**
 * Maps a Firestore document data object into a normalized RefundRecord.
 */
export function mapFirestoreRefundToRecord(data: any, fallbackId?: string): RefundRecord {
  const id = String(data?.id || fallbackId || '').trim();
  return {
    id,
    order_id: String(data?.order_id || '').trim(),
    machine_id: String(data?.machine_id || '').trim(),
    razorpay_payment_id: String(data?.razorpay_payment_id || '').trim(),
    razorpay_refund_id: data?.razorpay_refund_id ? String(data.razorpay_refund_id).trim() : null,
    amount_paise: Number(data?.amount_paise || 0),
    currency: String(data?.currency || 'INR').trim(),
    status: (String(data?.status || 'PENDING').toUpperCase() as RefundStatus),
    reason: String(data?.reason || 'unspecified').trim(),
    notes: data?.notes ? String(data.notes).trim() : null,
    initiated_by: String(data?.initiated_by || 'system').trim(),
    source: (String(data?.source || 'SUPER_ADMIN_PORTAL').toUpperCase() as RefundSource),
    idempotency_key: String(data?.idempotency_key || '').trim(),
    error_code: data?.error_code ? String(data.error_code).trim() : null,
    error_description: data?.error_description ? String(data.error_description).trim() : null,
    created_at: String(data?.created_at || new Date().toISOString()),
    updated_at: String(data?.updated_at || new Date().toISOString()),
    processed_at: data?.processed_at ? String(data.processed_at) : null
  };
}

export function getFirestoreRefundDocumentPath(orderId: string, refundId: string): string {
  return `orders/${String(orderId).trim()}/refunds/${String(refundId).trim()}`;
}

export function getFirestoreRefundCollectionPath(orderId: string): string {
  return `orders/${String(orderId).trim()}/refunds`;
}

export interface OrderRefundInvariantCheck {
  valid: boolean;
  diagnosticId?: string;
  error?: string;
  sumPendingPaise: number;
  sumProcessedPaise: number;
  failedCount: number;
  recordsCount: number;
}

// Global safety registry for orders flagged during reconciliation as having integrity violations
const unsafeOrderReconciliationStore = new Map<string, { diagnosticId: string; reason: string }>();

export function markOrderRefundUnsafe(orderId: string, diagnosticId: string, reason: string): void {
  unsafeOrderReconciliationStore.set(orderId, { diagnosticId, reason });
}

export function clearOrderRefundUnsafe(orderId: string): void {
  unsafeOrderReconciliationStore.delete(orderId);
}

export function getOrderRefundUnsafeStatus(orderId: string): { isUnsafe: boolean; diagnosticId?: string; reason?: string } {
  const item = unsafeOrderReconciliationStore.get(orderId);
  return item ? { isUnsafe: true, diagnosticId: item.diagnosticId, reason: item.reason } : { isUnsafe: false };
}

export interface DocumentValidationResult {
  valid: boolean;
  error?: string;
  sanitized?: RefundRecord;
}

export function validateAndSanitizeRemoteRefundDocument(
  doc: any,
  expectedOrderId: string,
  expectedMachineId?: string | null
): DocumentValidationResult {
  if (!doc || typeof doc !== 'object') {
    return { valid: false, error: 'Document payload is null or non-object' };
  }

  const id = String(doc.id || '').trim();
  if (!id) {
    return { valid: false, error: 'Missing or empty refund ID' };
  }

  const orderId = String(doc.order_id || '').trim();
  if (!orderId || orderId !== expectedOrderId) {
    return {
      valid: false,
      error: `Mismatched order_id: expected "${expectedOrderId}", received "${doc.order_id}"`
    };
  }

  const machineId = doc.machine_id ? String(doc.machine_id).trim() : '';
  if (expectedMachineId && machineId && machineId !== expectedMachineId) {
    return {
      valid: false,
      error: `Mismatched machine_id: expected "${expectedMachineId}", received "${doc.machine_id}"`
    };
  }

  const rawAmount = doc.amount_paise;
  if (
    typeof rawAmount !== 'number' ||
    !Number.isInteger(rawAmount) ||
    !Number.isSafeInteger(rawAmount) ||
    rawAmount <= 0
  ) {
    return {
      valid: false,
      error: `Invalid amount_paise: expected safe positive integer, received ${rawAmount}`
    };
  }

  const rawStatus = String(doc.status || '').trim().toUpperCase();
  if (!['PENDING', 'PROCESSED', 'FAILED'].includes(rawStatus)) {
    return {
      valid: false,
      error: `Invalid refund status: expected PENDING|PROCESSED|FAILED, received "${doc.status}"`
    };
  }

  return {
    valid: true,
    sanitized: {
      id,
      order_id: orderId,
      machine_id: machineId || (expectedMachineId || ''),
      razorpay_payment_id: String(doc.razorpay_payment_id || '').trim(),
      razorpay_refund_id: doc.razorpay_refund_id ? String(doc.razorpay_refund_id).trim() : null,
      amount_paise: rawAmount,
      currency: String(doc.currency || 'INR').trim().toUpperCase(),
      status: rawStatus as RefundStatus,
      reason: String(doc.reason || 'unspecified').trim(),
      notes: doc.notes ? String(doc.notes).trim() : null,
      initiated_by: String(doc.initiated_by || 'system').trim(),
      source: (String(doc.source || 'SUPER_ADMIN_PORTAL').toUpperCase() as RefundSource),
      idempotency_key: String(doc.idempotency_key || `idem_${id}`).trim(),
      error_code: doc.error_code ? String(doc.error_code).trim() : null,
      error_description: doc.error_description ? String(doc.error_description).trim() : null,
      created_at: String(doc.created_at || new Date().toISOString()),
      updated_at: String(doc.updated_at || new Date().toISOString()),
      processed_at: doc.processed_at ? String(doc.processed_at) : null
    }
  };
}

/**
 * Enforces financial consistency invariants across order aggregate fields and individual refund records.
 * For each order:
 * - Sum of PENDING refund records must equal pending_refund_amount_paise.
 * - Sum of PROCESSED refund records must equal total_refunded_amount_paise.
 * - FAILED records must contribute zero to both balances.
 * - All amounts must be valid positive safe integer paise.
 * - All refund records must belong to the correct order and machine.
 */
export function validateOrderRefundInvariants(
  order: any,
  records: RefundRecord[]
): OrderRefundInvariantCheck {
  const orderId = String(order?.id || '').trim();
  const orderMachineId = order?.machine_id ? String(order.machine_id).trim() : null;
  const orderPending = Number(order?.pending_refund_amount_paise || 0);
  const orderTotal = Number(order?.total_refunded_amount_paise || 0);

  let sumPendingPaise = 0;
  let sumProcessedPaise = 0;
  let failedCount = 0;

  // Check if order was marked unsafe due to malformed documents or unconfirmed deletions during reconciliation
  const unsafeStatus = getOrderRefundUnsafeStatus(orderId);
  if (unsafeStatus.isUnsafe) {
    const diagId = unsafeStatus.diagnosticId || ('DIAG-' + crypto.randomBytes(4).toString('hex').toUpperCase());
    const err = `[${diagId}] Invariant check failed: Order ${orderId} reconciliation is marked unsafe (${unsafeStatus.reason}). Reservations suspended pending manual reconciliation.`;
    logger.error(err);
    return {
      valid: false,
      diagnosticId: diagId,
      error: err,
      sumPendingPaise,
      sumProcessedPaise,
      failedCount,
      recordsCount: records.length
    };
  }

  for (const r of records) {
    const rfId = String(r.id || '').trim();
    const rfOrderId = String(r.order_id || '').trim();
    const rfMachineId = r.machine_id ? String(r.machine_id).trim() : null;
    const amt = Number(r.amount_paise);
    const status = String(r.status || '').toUpperCase();

    // 1. All refund records must belong to the correct order
    if (rfOrderId !== orderId) {
      const diagId = 'DIAG-' + crypto.randomBytes(4).toString('hex').toUpperCase();
      const err = `[${diagId}] Invariant check failed: Record ${rfId} order_id (${rfOrderId}) does not match order ${orderId}`;
      logger.error(err);
      return { valid: false, diagnosticId: diagId, error: err, sumPendingPaise, sumProcessedPaise, failedCount, recordsCount: records.length };
    }

    // 2. All refund records must belong to the correct machine if machine_id is specified
    if (orderMachineId && rfMachineId && rfMachineId !== orderMachineId) {
      const diagId = 'DIAG-' + crypto.randomBytes(4).toString('hex').toUpperCase();
      const err = `[${diagId}] Invariant check failed: Record ${rfId} machine_id (${rfMachineId}) does not match order machine (${orderMachineId})`;
      logger.error(err);
      return { valid: false, diagnosticId: diagId, error: err, sumPendingPaise, sumProcessedPaise, failedCount, recordsCount: records.length };
    }

    // 3. All amounts must be valid positive safe integer paise
    if (!Number.isInteger(amt) || !Number.isSafeInteger(amt) || amt <= 0) {
      const diagId = 'DIAG-' + crypto.randomBytes(4).toString('hex').toUpperCase();
      const err = `[${diagId}] Invariant check failed: Record ${rfId} has invalid non-positive/unsafe amount_paise (${r.amount_paise})`;
      logger.error(err);
      return { valid: false, diagnosticId: diagId, error: err, sumPendingPaise, sumProcessedPaise, failedCount, recordsCount: records.length };
    }

    // 4. Status accumulation
    if (status === 'PENDING') {
      sumPendingPaise += amt;
    } else if (status === 'PROCESSED') {
      sumProcessedPaise += amt;
    } else if (status === 'FAILED') {
      failedCount++;
      // FAILED records contribute zero to both balances
    } else {
      const diagId = 'DIAG-' + crypto.randomBytes(4).toString('hex').toUpperCase();
      const err = `[${diagId}] Invariant check failed: Record ${rfId} has unrecognized status "${r.status}"`;
      logger.error(err);
      return { valid: false, diagnosticId: diagId, error: err, sumPendingPaise, sumProcessedPaise, failedCount, recordsCount: records.length };
    }
  }

  // 5. Invariant: Sum of PENDING must equal pending_refund_amount_paise
  if (sumPendingPaise !== orderPending) {
    const diagId = 'DIAG-' + crypto.randomBytes(4).toString('hex').toUpperCase();
    const err = `[${diagId}] Invariant check failed on order ${orderId}: order.pending_refund_amount_paise (${orderPending}) does not match sum of PENDING refund records (${sumPendingPaise})`;
    logger.error(err);
    return { valid: false, diagnosticId: diagId, error: err, sumPendingPaise, sumProcessedPaise, failedCount, recordsCount: records.length };
  }

  // 6. Invariant: Sum of PROCESSED must equal total_refunded_amount_paise
  if (sumProcessedPaise !== orderTotal) {
    const diagId = 'DIAG-' + crypto.randomBytes(4).toString('hex').toUpperCase();
    const err = `[${diagId}] Invariant check failed on order ${orderId}: order.total_refunded_amount_paise (${orderTotal}) does not match sum of PROCESSED refund records (${sumProcessedPaise})`;
    logger.error(err);
    return { valid: false, diagnosticId: diagId, error: err, sumPendingPaise, sumProcessedPaise, failedCount, recordsCount: records.length };
  }

  return {
    valid: true,
    sumPendingPaise,
    sumProcessedPaise,
    failedCount,
    recordsCount: records.length
  };
}

/**
 * Reconciles individual refund records during local hydration.
 * Treating Firestore subcollection orders/{orderId}/refunds as authoritative history:
 * 1. Validates and sanitizes each remote refund document against schema and order/machine binding.
 * 2. Synchronizes missing refund records into local SQLite.
 * 3. Strictly protects terminal states (prevents FAILED -> PROCESSED/PENDING and PROCESSED -> FAILED/PENDING).
 * 4. Handles unconfirmed remote deletions safely without erasing local records.
 * 5. Recomputes local order aggregate balances from sanitized records.
 * 6. Detects and logs any aggregate/document mismatch.
 */
export async function reconcileOrderRefundRecords(
  orderId: string,
  remoteOrder: any,
  db: any,
  firestoreInstance?: any
): Promise<{
  resolvedPending: number;
  resolvedTotal: number;
  resolvedRefundStatus: OrderRefundStatus;
  lastRefundedAt: string | null;
}> {
  const normalizedId = String(orderId).trim();
  const expectedMachineId = remoteOrder?.machine_id ? String(remoteOrder.machine_id).trim() : null;
  const fs = firestoreInstance || (isFirestoreActive() ? getFirestoreInstance() : null);

  let querySuccess = false;
  let rawRemoteDocs: any[] = [];

  // 1. Fetch authoritative individual Firestore refund documents
  if (fs) {
    try {
      const snap = await fs.collection('orders').doc(normalizedId).collection('refunds').get();
      querySuccess = true;
      if (!snap.empty) {
        rawRemoteDocs = snap.docs.map((d: any) => ({
          ...d.data(),
          id: d.id,
          _path: d.ref?.path || `orders/${normalizedId}/refunds/${d.id}`
        }));
      }
    } catch (err) {
      querySuccess = false;
      logger.warn(`Failed to fetch subcollection refunds for order ${normalizedId} from Firestore: ${err}`);
    }
  } else {
    // In-memory / test mirror fallback
    querySuccess = true;
    for (const r of syncedRefundsStore.values()) {
      if (r.order_id === normalizedId) {
        rawRemoteDocs.push({ ...r, _path: `orders/${normalizedId}/refunds/${r.id}` });
      }
    }
  }

  // 2. Fetch local SQLite refund records
  let localRefunds: RefundRecord[] = [];
  if (db && db.all) {
    try {
      localRefunds = await db.all('SELECT * FROM refunds WHERE order_id = ?', [normalizedId]);
    } catch (err) {
      // Table might not exist yet if unmigrated
    }
  }
  const localMap = new Map<string, RefundRecord>(localRefunds.map(r => [r.id, { ...r }]));

  // 3. Validate and sanitize each remote document; detect cross-order, cross-machine, or malformed records
  let hasIntegrityViolation = false;
  let integrityDiagnosticId: string | null = null;
  const sanitizedRemoteDocs: RefundRecord[] = [];
  const remoteDocIdSet = new Set<string>();

  for (const rawDoc of rawRemoteDocs) {
    // Check parent path if available
    if (rawDoc._path) {
      const expectedPrefix = `orders/${normalizedId}/refunds/`;
      if (!rawDoc._path.startsWith(expectedPrefix)) {
        hasIntegrityViolation = true;
        integrityDiagnosticId = 'DIAG-' + crypto.randomBytes(4).toString('hex').toUpperCase();
        logger.error(
          `[${integrityDiagnosticId}] Rejected refund document with wrong parent path "${rawDoc._path}" (expected ${expectedPrefix})`
        );
        continue;
      }
    }

    const valResult = validateAndSanitizeRemoteRefundDocument(rawDoc, normalizedId, expectedMachineId);
    if (!valResult.valid || !valResult.sanitized) {
      hasIntegrityViolation = true;
      integrityDiagnosticId = 'DIAG-' + crypto.randomBytes(4).toString('hex').toUpperCase();
      logger.error(
        `[${integrityDiagnosticId}] Rejected malformed/contaminated remote refund document ${rawDoc?.id || 'unknown'} for order ${normalizedId}: ${valResult.error}`
      );
      continue;
    }

    sanitizedRemoteDocs.push(valResult.sanitized);
    remoteDocIdSet.add(valResult.sanitized.id);
  }

  // If malformed or foreign records were encountered, mark the order unsafe
  if (hasIntegrityViolation) {
    markOrderRefundUnsafe(
      normalizedId,
      integrityDiagnosticId || 'DIAG-INTEGRITY',
      'Malformed or cross-order/cross-machine contaminated refund documents detected in remote subcollection'
    );
  }

  // 4. Synchronize sanitized remote records into SQLite with strict terminal-state protections
  if (db && db.run) {
    for (const rf of sanitizedRemoteDocs) {
      if (!localMap.has(rf.id)) {
        // Missing in local SQLite -> Insert
        try {
          await db.run(
            `INSERT INTO refunds (
              id, order_id, machine_id, razorpay_payment_id, razorpay_refund_id,
              amount_paise, currency, status, reason, notes, initiated_by,
              source, idempotency_key, error_code, error_description,
              created_at, updated_at, processed_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              rf.id, rf.order_id, rf.machine_id, rf.razorpay_payment_id,
              rf.razorpay_refund_id || null, rf.amount_paise, rf.currency || 'INR', rf.status,
              rf.reason || 'manual_admin_request', rf.notes || null, rf.initiated_by || 'admin', rf.source || 'SUPER_ADMIN_PORTAL',
              rf.idempotency_key || `idem_${rf.id}`, rf.error_code || null, rf.error_description || null,
              rf.created_at, rf.updated_at, rf.processed_at || null
            ]
          );
          localMap.set(rf.id, rf);
        } catch (err) {
          logger.warn(`Failed to insert missing refund record ${rf.id} in SQLite: ${err}`);
          const existingRow = await db.get('SELECT * FROM refunds WHERE id = ?', [rf.id]).catch(() => null);
          if (existingRow) {
            localMap.set(rf.id, existingRow);
          } else {
            localMap.set(rf.id, rf);
          }
        }
      } else {
        const localRf = localMap.get(rf.id)!;
        const localStatus = String(localRf.status || '').toUpperCase();
        const remoteStatus = String(rf.status || '').toUpperCase();

        // Terminal state guards (Part A: A terminal state can NEVER be downgraded to PENDING or switched to another terminal state)
        if (localStatus === 'PROCESSED') {
          if (remoteStatus !== 'PROCESSED') {
            logger.warn(
              `Hydration rejected invalid transition from local terminal PROCESSED to remote ${remoteStatus} for refund ${rf.id}`
            );
          }
          // Local PROCESSED is immutable
          localMap.set(rf.id, localRf);
          continue;
        }

        if (localStatus === 'FAILED') {
          // Authoritative Gateway Settlement Override (Audit Warning W-2):
          // If remote record has status === 'PROCESSED' and a verified razorpay_refund_id,
          // the payment gateway confirmed real-world settlement (e.g. after a local timeout false-negative).
          const hasVerifiedGatewayProof =
            remoteStatus === 'PROCESSED' &&
            Boolean(rf.razorpay_refund_id) &&
            String(rf.razorpay_refund_id).trim().length > 0;

          if (hasVerifiedGatewayProof) {
            const auditOverrideNote = `[AUTHORITATIVE_GATEWAY_OVERRIDE] Previous status FAILED (code: ${localRf.error_code || 'none'}) superseded by verified gateway refund ${rf.razorpay_refund_id}`;
            const combinedNotes = localRf.notes ? `${localRf.notes} | ${auditOverrideNote}` : auditOverrideNote;
            const processedAt = rf.processed_at || rf.updated_at || new Date().toISOString();
            const nowIso = new Date().toISOString();

            logger.info(
              `Authoritative gateway settlement ${rf.razorpay_refund_id} promoted refund ${rf.id} for order ${normalizedId} from previous FAILED to PROCESSED with audit trail`
            );

            if (db && db.run) {
              try {
                await db.run(
                  `UPDATE refunds
                   SET status = 'PROCESSED',
                       razorpay_refund_id = ?,
                       error_description = ?,
                       notes = ?,
                       processed_at = ?,
                       updated_at = ?
                   WHERE id = ?`,
                  [
                    rf.razorpay_refund_id,
                    auditOverrideNote,
                    combinedNotes,
                    processedAt,
                    nowIso,
                    rf.id
                  ]
                );
              } catch (err) {
                logger.warn(`Failed to update authoritative gateway refund ${rf.id} in SQLite: ${err}`);
              }
            }

            localMap.set(rf.id, {
              ...localRf,
              status: 'PROCESSED',
              razorpay_refund_id: rf.razorpay_refund_id,
              notes: combinedNotes,
              error_description: auditOverrideNote,
              processed_at: processedAt,
              updated_at: nowIso
            });
            continue;
          }

          if (remoteStatus !== 'FAILED') {
            logger.warn(
              `Hydration rejected invalid transition from local terminal FAILED to remote ${remoteStatus} for refund ${rf.id}`
            );
          }
          // Local FAILED is immutable unless verified gateway settlement exists
          localMap.set(rf.id, localRf);
          continue;
        }

        // Here localStatus is 'PENDING':
        // Valid advancement: PENDING -> PROCESSED or PENDING -> FAILED
        if (localStatus !== remoteStatus || rf.updated_at > localRf.updated_at) {
          try {
            await db.run(
              `UPDATE refunds
               SET status = ?,
                   razorpay_refund_id = COALESCE(?, razorpay_refund_id),
                   error_code = ?,
                   error_description = ?,
                   updated_at = ?,
                   processed_at = COALESCE(?, processed_at)
               WHERE id = ?`,
              [
                remoteStatus,
                rf.razorpay_refund_id || null,
                rf.error_code || null,
                rf.error_description || null,
                rf.updated_at || new Date().toISOString(),
                rf.processed_at || null,
                rf.id
              ]
            );
            localMap.set(rf.id, { ...localRf, ...rf, status: remoteStatus as RefundStatus });
          } catch (err) {
            logger.warn(`Failed to update refund record ${rf.id} in SQLite: ${err}`);
          }
        }
      }
    }
  }

  // 5. Handle local records that are missing from remote Firestore (Part D: Deleted document handling)
  let hasUnconfirmedDisappearance = false;
  let disappearanceDiagnosticId: string | null = null;

  if (querySuccess) {
    const remoteTombstones: string[] = Array.isArray(remoteOrder?.tombstones)
      ? remoteOrder.tombstones
      : (Array.isArray(remoteOrder?.deleted_refunds) ? remoteOrder.deleted_refunds : []);

    for (const [localId, localRf] of localMap.entries()) {
      if (!remoteDocIdSet.has(localId)) {
        // This local record is not present in the remote subcollection
        if (remoteTombstones.includes(localId)) {
          // Explicit authoritative tombstone exists
          if (localRf.status === 'PROCESSED') {
            // CRITICAL AUDIT RULE (W-1): A settled PROCESSED refund represents real money disbursed.
            // A tombstone must NEVER transition a PROCESSED record to FAILED!
            // Flag as critical integrity violation and lock order fail-closed.
            hasIntegrityViolation = true;
            integrityDiagnosticId = 'DIAG-' + crypto.randomBytes(4).toString('hex').toUpperCase();
            logger.error(
              `[${integrityDiagnosticId}] Illegal deletion tombstone detected for settled PROCESSED refund record ${localId} on order ${normalizedId}. Preserving PROCESSED audit record and locking order fail-closed.`
            );
            markOrderRefundUnsafe(
              normalizedId,
              integrityDiagnosticId,
              'Illegal tombstone attempted on settled PROCESSED refund record'
            );
            localMap.set(localId, localRf);
          } else if (localRf.status === 'PENDING') {
            // Tombstones are strictly valid for PENDING reservations that were cancelled/deleted
            logger.info(
              `Local pending refund reservation ${localId} for order ${normalizedId} transitioned to FAILED based on authoritative deletion tombstone`
            );
            if (db && db.run) {
              await db.run(
                `UPDATE refunds SET status = 'FAILED', error_code = 'TOMBSTONE', updated_at = ? WHERE id = ?`,
                [new Date().toISOString(), localId]
              ).catch(() => {});
            }
            localMap.set(localId, { ...localRf, status: 'FAILED', error_code: 'TOMBSTONE' });
          } else {
            // Already FAILED -> preserve as FAILED
            localMap.set(localId, localRf);
          }
        } else if (sanitizedRemoteDocs.length > 0 && localRf.status === 'PENDING') {
          // Remote Firestore has established authoritative refund documents for this order,
          // but this local PENDING reservation was superseded or not committed remotely.
          // Transition the local hold to FAILED to eliminate phantom pending balance and preserve audit history.
          logger.info(
            `Local pending reservation ${localId} for order ${normalizedId} superseded by authoritative remote records; transitioned to FAILED`
          );
          if (db && db.run) {
            await db.run(
              `UPDATE refunds SET status = 'FAILED', error_code = 'SUPERSEDED_BY_REMOTE', updated_at = ? WHERE id = ?`,
              [new Date().toISOString(), localId]
            ).catch(() => {});
          }
          localMap.set(localId, { ...localRf, status: 'FAILED' });
        } else if (localRf.status === 'PROCESSED') {
          // Unconfirmed remote disappearance of real settled money: DO NOT delete local record or erase audit history.
          // Preserve local record in localMap so aggregates match SQLite rows, but flag order as unsafe.
          hasUnconfirmedDisappearance = true;
          disappearanceDiagnosticId = 'DIAG-' + crypto.randomBytes(4).toString('hex').toUpperCase();
          logger.error(
            `[${disappearanceDiagnosticId}] Unconfirmed remote disappearance of PROCESSED refund record ${localId} on order ${normalizedId}. Preserving local record and locking order pending reconciliation.`
          );
        } else if (sanitizedRemoteDocs.length === 0 && localRf.status === 'PENDING') {
          // Firestore subcollection has 0 documents (e.g. edge node just made a local pending reservation).
          // Preserve local pending reservation so local workflow can complete.
        }
      }
    }
  }

  if (hasUnconfirmedDisappearance) {
    markOrderRefundUnsafe(
      normalizedId,
      disappearanceDiagnosticId || 'DIAG-DISAPPEAR',
      'Unconfirmed remote disappearance of refund records detected'
    );
  }

  // 6. Calculate authoritative aggregate balances strictly from the sanitized localMap
  let calculatedPendingPaise = 0;
  let calculatedTotalPaise = 0;
  let latestRefundedAt: string | null = remoteOrder?.last_refunded_at || null;

  for (const rf of localMap.values()) {
    const amt = Number(rf.amount_paise);
    const st = String(rf.status || '').toUpperCase();
    if (st === 'PENDING') {
      calculatedPendingPaise += amt;
    } else if (st === 'PROCESSED') {
      calculatedTotalPaise += amt;
      if (rf.processed_at && (!latestRefundedAt || rf.processed_at > latestRefundedAt)) {
        latestRefundedAt = rf.processed_at;
      }
    } else if (st === 'FAILED') {
      // FAILED contributes 0 to both balances
    }
  }

  const remotePending = Number(remoteOrder?.pending_refund_amount_paise || 0);
  const remoteTotal = Number(remoteOrder?.total_refunded_amount_paise || 0);

  // Check aggregate vs document consistency
  if (localMap.size > 0) {
    if (remotePending !== calculatedPendingPaise || remoteTotal !== calculatedTotalPaise) {
      const diagId = 'DIAG-' + crypto.randomBytes(4).toString('hex').toUpperCase();
      logger.error(
        `[${diagId}] Refund aggregate/document mismatch on order ${normalizedId}: remote aggregate (pending=${remotePending}, total=${remoteTotal}) vs document records (pending=${calculatedPendingPaise}, total=${calculatedTotalPaise})`
      );
    }
  }

  const resolvedPending = calculatedPendingPaise;
  const resolvedTotal = calculatedTotalPaise;

  let resolvedRefundStatus: OrderRefundStatus = 'NONE';
  const orderAmt = Number(remoteOrder?.captured_amount_paise || (Number(remoteOrder?.amount || 0) * 100));
  if (resolvedTotal >= orderAmt && orderAmt > 0) {
    resolvedRefundStatus = 'FULL';
  } else if (resolvedTotal > 0) {
    resolvedRefundStatus = 'PARTIAL';
  } else if (resolvedPending > 0) {
    resolvedRefundStatus = 'PENDING';
  } else if (localMap.size > 0 && Array.from(localMap.values()).every(r => String(r.status).toUpperCase() === 'FAILED')) {
    resolvedRefundStatus = 'FAILED';
  } else {
    resolvedRefundStatus = 'NONE';
  }

  // 7. Update local SQLite orders table
  if (db && db.run) {
    await db.run(
      `UPDATE orders
       SET pending_refund_amount_paise = ?,
           total_refunded_amount_paise = ?,
           refund_status = ?,
           last_refunded_at = ?
       WHERE id = ?`,
      [
        resolvedPending,
        resolvedTotal,
        resolvedRefundStatus,
        latestRefundedAt,
        normalizedId
      ]
    ).catch(() => {});
  }

  // 8. If reconciliation was completely clean without violations or unconfirmed disappearances, clear any prior unsafe flag
  if (!hasIntegrityViolation && !hasUnconfirmedDisappearance) {
    clearOrderRefundUnsafe(normalizedId);
  }

  return {
    resolvedPending,
    resolvedTotal,
    resolvedRefundStatus,
    lastRefundedAt: latestRefundedAt
  };
}

// ---------------------------------------------------------------------------
// Synchronize committed refund state to local database cache (non-fatal)
// ---------------------------------------------------------------------------
async function syncRefundToLocalDb(db: any, refund: RefundRecord, order: any): Promise<void> {
  if (!db || !db.run) return;
  try {
    await db.run(
      `INSERT OR REPLACE INTO refunds (
        id, order_id, machine_id, razorpay_payment_id, razorpay_refund_id,
        amount_paise, currency, status, reason, notes, initiated_by,
        source, idempotency_key, error_code, error_description,
        created_at, updated_at, processed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        refund.id, refund.order_id, refund.machine_id, refund.razorpay_payment_id,
        refund.razorpay_refund_id, refund.amount_paise, refund.currency, refund.status,
        refund.reason, refund.notes, refund.initiated_by, refund.source,
        refund.idempotency_key, refund.error_code, refund.error_description,
        refund.created_at, refund.updated_at, refund.processed_at
      ]
    );

    const nowIso = new Date().toISOString();
    await db.run(
      `UPDATE orders
       SET pending_refund_amount_paise = ?,
           total_refunded_amount_paise = ?,
           last_refunded_at = ?,
           refund_status = ?,
           updated_at = ?
       WHERE id = ?`,
      [
        Number(order.pending_refund_amount_paise || 0),
        Number(order.total_refunded_amount_paise || 0),
        order.last_refunded_at || null,
        order.refund_status || 'NONE',
        order.updated_at || nowIso,
        order.id
      ]
    );
  } catch (err) {
    // Non-fatal cache sync failure: Authoritative state is already committed in Firestore
  }
}

// ---------------------------------------------------------------------------
// FIRESTORE ADAPTER IMPLEMENTATION (Production & Staging Multi-Instance)
// ---------------------------------------------------------------------------

async function createFirestoreRefundReservation(
  params: CreateRefundReservationParams,
  db?: any
): Promise<{ refund: RefundRecord; order: any; isReplay: boolean }> {
  const firestore = getFirestoreInstance();
  if (!firestore) {
    throw new Error('Firestore instance not available');
  }

  const normalizedKey = String(params.idempotency_key || '').trim();
  const orderId = String(params.orderId).trim();
  const requestedPaise = Number(params.amount_paise);

  const result = await firestore.runTransaction(async (tx) => {
    const idempotencyRef = firestore.collection('refund_idempotency').doc(normalizedKey);
    const idempotencySnap = await tx.get(idempotencyRef);

    const orderRef = firestore.collection('orders').doc(orderId);
    const orderSnap = await tx.get(orderRef);

    if (idempotencySnap.exists) {
      const idemData = idempotencySnap.data();
      const existingRefundId = idemData?.refund_id;
      const rootRefundRef = firestore.collection('refunds').doc(existingRefundId);
      const existingRefundSnap = await tx.get(rootRefundRef);
      const existingRefund = existingRefundSnap.exists
        ? mapFirestoreRefundToRecord(existingRefundSnap.data(), existingRefundId)
        : (idemData?.refund ? mapFirestoreRefundToRecord(idemData.refund, existingRefundId) : null);

      const orderData = orderSnap.exists ? orderSnap.data() : null;
      if (!existingRefund) {
        throw new Error(`Corrupted idempotency record: refund ${existingRefundId} not found`);
      }
      return { refund: existingRefund, order: orderData, isReplay: true };
    }

    if (!orderSnap.exists) {
      throw new NotFoundError(`Order with ID ${orderId} not found`);
    }

    const orderData = (orderSnap.data() || {}) as any;
    const status = String(orderData?.status || '').toUpperCase();
    if (!['PAID', 'PREPARING', 'COMPLETED'].includes(status)) {
      throw new BadRequestError(`Cannot refund order ${orderId} with non-paid status "${orderData?.status}"`);
    }

    if (String(orderData?.dispense_status || '').toUpperCase() === 'DISPENSING') {
      throw new ConflictError(`Cannot reserve refund for order ${orderId} while beverage is actively dispensing`);
    }

    if (!orderData?.razorpay_payment_id) {
      throw new BadRequestError(`Cannot refund order ${orderId}: missing razorpay_payment_id`);
    }

    // 1. Invariant check on existing refund records for this order inside transaction context
    let subRefundsSnap: any;
    if (typeof (tx as any).get === 'function') {
      try {
        const query = firestore.collection('orders').doc(orderId).collection('refunds');
        subRefundsSnap = await (tx as any).get(query);
      } catch (err) {
        subRefundsSnap = await firestore.collection('orders').doc(orderId).collection('refunds').get();
      }
    } else {
      subRefundsSnap = await firestore.collection('orders').doc(orderId).collection('refunds').get();
    }
    const existingRecords = subRefundsSnap.docs.map((d: any) =>
      mapFirestoreRefundToRecord(d.data(), d.id)
    );
    const invariantCheck = validateOrderRefundInvariants(orderData, existingRecords);
    if (!invariantCheck.valid) {
      throw new ConflictError(
        `Cannot reserve refund: financial consistency check failed for order ${orderId} [${invariantCheck.diagnosticId}]. Reservations suspended pending reconciliation.`
      );
    }

    // 2. Verified captured payment amount validation (Part A fail-closed rule)
    const balance = calculateRemainingRefundableBalance(orderData);
    if (!balance.isExactCaptureKnown || orderData.captured_amount_paise === null || orderData.captured_amount_paise === undefined) {
      throw new ConflictError(
        'Cannot initiate refund: exact captured payment amount is unverified. Payment reconciliation is required.'
      );
    }

    if (requestedPaise > balance.remainingRefundablePaise) {
      throw new BadRequestError(
        `Requested refund of ${requestedPaise} paise exceeds remaining available refundable balance of ${balance.remainingRefundablePaise} paise`
      );
    }

    const nowIso = new Date().toISOString();
    const refundId =
      params.customRefundId ||
      `RFND-${orderId}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;

    const refundRecord: RefundRecord = {
      id: refundId,
      order_id: orderId,
      machine_id: String(orderData.machine_id || ''),
      razorpay_payment_id: String(orderData.razorpay_payment_id),
      razorpay_refund_id: params.razorpay_refund_id || null,
      amount_paise: requestedPaise,
      currency: 'INR',
      status: 'PENDING',
      reason: String(params.reason || 'manual_admin_request').trim(),
      notes: params.notes ? String(params.notes).trim() : null,
      initiated_by: String(params.initiated_by || 'admin').trim(),
      source: params.source || 'SUPER_ADMIN_PORTAL',
      idempotency_key: normalizedKey,
      error_code: null,
      error_description: null,
      created_at: nowIso,
      updated_at: nowIso,
      processed_at: null
    };

    const currentPending = Number(orderData.pending_refund_amount_paise || 0);
    const nextPendingPaise = currentPending + requestedPaise;
    const currentTotalRefunded = Number(orderData.total_refunded_amount_paise || 0);
    const nextRefundStatus: OrderRefundStatus = currentTotalRefunded > 0 ? 'PARTIAL' : 'PENDING';

    const nextRefundVersion = Number(orderData.refund_version || 0) + 1;
    const orderUpdatePayload = {
      pending_refund_amount_paise: nextPendingPaise,
      refund_status: nextRefundStatus,
      refund_version: nextRefundVersion,
      updated_at: nowIso
    };

    const firestoreRefundPayload = mapRefundRecordToFirestore(refundRecord);

    // Atomic document sets inside Firestore transaction
    const rootRefundRef = firestore.collection('refunds').doc(refundId);
    tx.set(rootRefundRef, firestoreRefundPayload);

    const subcollectionRefundRef = firestore.collection('orders').doc(orderId).collection('refunds').doc(refundId);
    tx.set(subcollectionRefundRef, firestoreRefundPayload);

    tx.set(idempotencyRef, {
      refund_id: refundId,
      order_id: orderId,
      idempotency_key: normalizedKey,
      created_at: nowIso,
      refund: firestoreRefundPayload
    });

    tx.set(orderRef, orderUpdatePayload, { merge: true });

    return {
      refund: refundRecord,
      order: { ...orderData, ...orderUpdatePayload, id: orderId },
      isReplay: false
    };
  });

  if (db && result.order) {
    await syncRefundToLocalDb(db, result.refund, result.order);
  }
  if (result.order) {
    updateSyncedFirebaseOrder(result.order.id, result.order);
  }
  syncedRefundsStore.set(result.refund.id, result.refund);

  return result;
}

async function markFirestoreRefundProcessed(
  params: MarkRefundProcessedParams,
  db?: any
): Promise<{ refund: RefundRecord; order: any; isReplay: boolean }> {
  const firestore = getFirestoreInstance();
  if (!firestore) {
    throw new Error('Firestore instance not available');
  }

  const refundId = String(params.refundId).trim();

  const result = await firestore.runTransaction(async (tx) => {
    const rootRefundRef = firestore.collection('refunds').doc(refundId);
    const refundSnap = await tx.get(rootRefundRef);
    if (!refundSnap.exists) {
      throw new NotFoundError(`Refund record with ID ${refundId} not found`);
    }

    const refundData = mapFirestoreRefundToRecord(refundSnap.data(), refundId);
    const orderRef = firestore.collection('orders').doc(refundData.order_id);
    const orderSnap = await tx.get(orderRef);
    if (!orderSnap.exists) {
      throw new NotFoundError(`Order ${refundData.order_id} associated with refund ${refundId} not found`);
    }
    const orderData = (orderSnap.data() || {}) as any;

    // F-1 Fencing Guard: Validate webhook claim generation inside authoritative transaction
    if (params.webhookFencing) {
      const whDocRef = firestore.collection('webhook_events').doc(`${params.webhookFencing.provider}_${params.webhookFencing.eventId}`);
      const whSnap = await tx.get(whDocRef);
      if (whSnap.exists) {
        const whData = whSnap.data() as any;
        if (whData.claim_count !== undefined && whData.claim_count !== params.webhookFencing.claimCount) {
          throw new ConflictError(
            `[STALE_WEBHOOK_WORKER] Webhook claim generation superseded for event ${params.webhookFencing.eventId}: current=${whData.claim_count}, worker=${params.webhookFencing.claimCount}`
          );
        }
        if (whData.status === 'PROCESSED') {
          return { refund: refundData, order: orderData, isReplay: true };
        }
      }
    }

    // 1. Idempotent replay if already PROCESSED
    if (refundData.status === 'PROCESSED') {
      return { refund: refundData, order: orderData, isReplay: true };
    }

    // 2. Terminal state protection: FAILED cannot transition to PROCESSED
    if (refundData.status === 'FAILED') {
      throw new BadRequestError(`Cannot mark refund ${refundId} as PROCESSED because its status is already FAILED`);
    }

    // 3. Only PENDING can transition to PROCESSED
    if (refundData.status !== 'PENDING') {
      throw new BadRequestError(`Invalid refund state transition: cannot transition from ${refundData.status} to PROCESSED`);
    }

    const nowIso = new Date().toISOString();
    const processedAt = params.processed_at || nowIso;
    const rpRefundId = params.razorpay_refund_id || refundData.razorpay_refund_id || null;

    const currentPending = Number(orderData.pending_refund_amount_paise || 0);
    const newPendingPaise = Math.max(0, currentPending - refundData.amount_paise);
    const currentTotal = Number(orderData.total_refunded_amount_paise || 0);
    const newTotalRefundedPaise = currentTotal + refundData.amount_paise;

    const balance = calculateRemainingRefundableBalance(orderData);
    const orderAmountPaise = balance.orderAmountPaise;
    const newRefundStatus: OrderRefundStatus =
      newTotalRefundedPaise >= orderAmountPaise ? 'FULL' : 'PARTIAL';

    const refundUpdates = {
      status: 'PROCESSED' as RefundStatus,
      razorpay_refund_id: rpRefundId,
      processed_at: processedAt,
      updated_at: nowIso
    };

    const nextRefundVersion = Number(orderData.refund_version || 0) + 1;
    const orderUpdates = {
      pending_refund_amount_paise: newPendingPaise,
      total_refunded_amount_paise: newTotalRefundedPaise,
      last_refunded_at: processedAt,
      refund_status: newRefundStatus,
      refund_version: nextRefundVersion,
      updated_at: nowIso
    };

    tx.set(rootRefundRef, refundUpdates, { merge: true });
    const subRefundRef = firestore.collection('orders').doc(refundData.order_id).collection('refunds').doc(refundId);
    tx.set(subRefundRef, refundUpdates, { merge: true });
    tx.set(orderRef, orderUpdates, { merge: true });

    const updatedRefund = { ...refundData, ...refundUpdates };
    const updatedOrder = { ...orderData, ...orderUpdates, id: refundData.order_id };
    return { refund: updatedRefund, order: updatedOrder, isReplay: false };
  });

  if (db && result.order) {
    await syncRefundToLocalDb(db, result.refund, result.order);
  }
  if (result.order) {
    updateSyncedFirebaseOrder(result.order.id, result.order);
  }
  syncedRefundsStore.set(result.refund.id, result.refund);

  return result;
}

async function markFirestoreRefundFailed(
  params: MarkRefundFailedParams,
  db?: any
): Promise<{ refund: RefundRecord; order: any; isReplay: boolean }> {
  const firestore = getFirestoreInstance();
  if (!firestore) {
    throw new Error('Firestore instance not available');
  }

  const refundId = String(params.refundId).trim();

  const result = await firestore.runTransaction(async (tx) => {
    const rootRefundRef = firestore.collection('refunds').doc(refundId);
    const refundSnap = await tx.get(rootRefundRef);
    if (!refundSnap.exists) {
      throw new NotFoundError(`Refund record with ID ${refundId} not found`);
    }

    const refundData = mapFirestoreRefundToRecord(refundSnap.data(), refundId);
    const orderRef = firestore.collection('orders').doc(refundData.order_id);
    const orderSnap = await tx.get(orderRef);
    if (!orderSnap.exists) {
      throw new NotFoundError(`Order ${refundData.order_id} associated with refund ${refundId} not found`);
    }
    const orderData = (orderSnap.data() || {}) as any;

    // F-1 Fencing Guard: Validate webhook claim generation inside authoritative transaction
    if (params.webhookFencing) {
      const whDocRef = firestore.collection('webhook_events').doc(`${params.webhookFencing.provider}_${params.webhookFencing.eventId}`);
      const whSnap = await tx.get(whDocRef);
      if (whSnap.exists) {
        const whData = whSnap.data() as any;
        if (whData.claim_count !== undefined && whData.claim_count !== params.webhookFencing.claimCount) {
          throw new ConflictError(
            `[STALE_WEBHOOK_WORKER] Webhook claim generation superseded for event ${params.webhookFencing.eventId}: current=${whData.claim_count}, worker=${params.webhookFencing.claimCount}`
          );
        }
        if (whData.status === 'PROCESSED') {
          throw new ConflictError(
            `[STALE_WEBHOOK_WORKER] Event ${params.webhookFencing.eventId} was already settled PROCESSED; refusing to fail refund`
          );
        }
      }
    }

    // 1. Idempotent replay if already FAILED
    if (refundData.status === 'FAILED') {
      return { refund: refundData, order: orderData, isReplay: true };
    }

    // 2. Terminal state protection: PROCESSED cannot transition to FAILED
    if (refundData.status === 'PROCESSED') {
      throw new BadRequestError(`Cannot mark refund ${refundId} as FAILED because its status is already PROCESSED`);
    }

    // 3. Only PENDING can transition to FAILED
    if (refundData.status !== 'PENDING') {
      throw new BadRequestError(`Invalid refund state transition: cannot transition from ${refundData.status} to FAILED`);
    }

    const nowIso = new Date().toISOString();
    const currentPending = Number(orderData.pending_refund_amount_paise || 0);
    const newPendingPaise = Math.max(0, currentPending - refundData.amount_paise);
    const totalRefundedPaise = Number(orderData.total_refunded_amount_paise || 0);

    const balance = calculateRemainingRefundableBalance(orderData);
    const orderAmountPaise = balance.orderAmountPaise;

    let newRefundStatus: OrderRefundStatus = 'NONE';
    if (totalRefundedPaise >= orderAmountPaise && orderAmountPaise > 0) {
      newRefundStatus = 'FULL';
    } else if (totalRefundedPaise > 0) {
      newRefundStatus = 'PARTIAL';
    } else if (newPendingPaise > 0) {
      newRefundStatus = 'PENDING';
    } else {
      newRefundStatus = 'FAILED';
    }

    const refundUpdates = {
      status: 'FAILED' as RefundStatus,
      error_code: params.error_code || null,
      error_description: params.error_description || null,
      updated_at: nowIso
    };

    const nextRefundVersion = Number(orderData.refund_version || 0) + 1;
    const orderUpdates = {
      pending_refund_amount_paise: newPendingPaise,
      refund_status: newRefundStatus,
      refund_version: nextRefundVersion,
      updated_at: nowIso
    };

    tx.set(rootRefundRef, refundUpdates, { merge: true });
    const subRefundRef = firestore.collection('orders').doc(refundData.order_id).collection('refunds').doc(refundId);
    tx.set(subRefundRef, refundUpdates, { merge: true });
    tx.set(orderRef, orderUpdates, { merge: true });

    const updatedRefund = { ...refundData, ...refundUpdates };
    const updatedOrder = { ...orderData, ...orderUpdates, id: refundData.order_id };
    return { refund: updatedRefund, order: updatedOrder, isReplay: false };
  });

  if (db && result.order) {
    await syncRefundToLocalDb(db, result.refund, result.order);
  }
  if (result.order) {
    updateSyncedFirebaseOrder(result.order.id, result.order);
  }
  syncedRefundsStore.set(result.refund.id, result.refund);

  return result;
}

// ---------------------------------------------------------------------------
// SQLITE ADAPTER IMPLEMENTATION (Local Development & Offline Tests)
// ---------------------------------------------------------------------------

async function createSqliteRefundReservation(
  db: any,
  params: CreateRefundReservationParams
): Promise<{ refund: RefundRecord; order: any; isReplay: boolean }> {
  // Prohibit offline SQLite refund reservations in Production/Preview
  if (isStrictFirebaseEnvironment() || isVercelRuntime()) {
    throw new ServiceUnavailableError(
      'Offline SQLite refund reservations are prohibited in Production and Preview environments. Failing closed (HTTP 503).'
    );
  }

  const normalizedKey = String(params.idempotency_key || '').trim();
  const requestedPaise = Number(params.amount_paise);

  const release = await refundTransactionMutex.acquire();
  let inTx = false;

  try {
    await db.run('BEGIN IMMEDIATE');
    inTx = true;

    // 1. Idempotency check inside transaction
    const existingRefund = await getSqliteRefundByIdempotencyKey(db, normalizedKey);
    if (existingRefund) {
      await db.run('COMMIT');
      inTx = false;
      const existingOrder = await db.get('SELECT * FROM orders WHERE id = ?', [existingRefund.order_id]);
      return { refund: existingRefund, order: existingOrder, isReplay: true };
    }

    // 2. Freshly read order inside transaction directly from SQLite (ZERO network calls inside write lock)
    const order = await db.get('SELECT * FROM orders WHERE id = ?', [params.orderId]);
    if (!order) {
      throw new NotFoundError(`Order with ID ${params.orderId} not found`);
    }

    if (
      process.env.NODE_ENV !== 'test' &&
      !String(order.razorpay_payment_id || '').startsWith('pay_mock_') &&
      !String(order.razorpay_payment_id || '').startsWith('test_')
    ) {
      throw new ConflictError(
        `Cannot reserve refund for live payment ${order.razorpay_payment_id} via offline SQLite. Shared Firestore persistence is required.`
      );
    }

    const status = String(order.status || '').toUpperCase();
    if (!['PAID', 'PREPARING', 'COMPLETED'].includes(status)) {
      throw new BadRequestError(`Cannot refund order ${order.id} with non-paid status "${order.status}"`);
    }

    if (String(order.dispense_status || '').toUpperCase() === 'DISPENSING') {
      throw new ConflictError(`Cannot reserve refund for order ${order.id} while beverage is actively dispensing`);
    }

    if (!order.razorpay_payment_id) {
      throw new BadRequestError(`Cannot refund order ${order.id}: missing razorpay_payment_id`);
    }

    // 3. Invariant check on existing refund records for this order in SQLite
    const existingRefundRows = await db.all('SELECT * FROM refunds WHERE order_id = ?', [order.id]);
    const existingRecords = existingRefundRows.map((r: any) => ({
      ...r,
      amount_paise: Number(r.amount_paise)
    }));
    const invariantCheck = validateOrderRefundInvariants(order, existingRecords);
    if (!invariantCheck.valid) {
      throw new ConflictError(
        `Cannot reserve refund: financial consistency check failed for order ${order.id} [${invariantCheck.diagnosticId}]. Reservations suspended pending reconciliation.`
      );
    }

    // 4. Recalculate capacity using freshly read order snapshot (Part A fail-closed rule)
    const balance = calculateRemainingRefundableBalance(order);
    if (!balance.isExactCaptureKnown || order.captured_amount_paise === null || order.captured_amount_paise === undefined) {
      throw new ConflictError(
        'Cannot initiate refund: exact captured payment amount is unverified. Payment reconciliation is required.'
      );
    }

    if (requestedPaise > balance.remainingRefundablePaise) {
      throw new BadRequestError(
        `Requested refund of ${requestedPaise} paise exceeds remaining available refundable balance of ${balance.remainingRefundablePaise} paise`
      );
    }

    const nowIso = new Date().toISOString();
    const refundId =
      params.customRefundId ||
      `RFND-${order.id}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;

    const refundRecord: RefundRecord = {
      id: refundId,
      order_id: order.id,
      machine_id: order.machine_id,
      razorpay_payment_id: order.razorpay_payment_id,
      razorpay_refund_id: params.razorpay_refund_id || null,
      amount_paise: requestedPaise,
      currency: 'INR',
      status: 'PENDING',
      reason: String(params.reason || 'manual_admin_request').trim(),
      notes: params.notes ? String(params.notes).trim() : null,
      initiated_by: String(params.initiated_by || 'admin').trim(),
      source: params.source || 'SUPER_ADMIN_PORTAL',
      idempotency_key: normalizedKey,
      error_code: null,
      error_description: null,
      created_at: nowIso,
      updated_at: nowIso,
      processed_at: null
    };

    const nextPendingPaise = Number(order.pending_refund_amount_paise || 0) + requestedPaise;
    const currentTotalRefunded = Number(order.total_refunded_amount_paise || 0);
    const nextRefundStatus: OrderRefundStatus = currentTotalRefunded > 0 ? 'PARTIAL' : 'PENDING';

    await db.run(
      `INSERT INTO refunds (
        id, order_id, machine_id, razorpay_payment_id, razorpay_refund_id,
        amount_paise, currency, status, reason, notes, initiated_by,
        source, idempotency_key, error_code, error_description,
        created_at, updated_at, processed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        refundRecord.id,
        refundRecord.order_id,
        refundRecord.machine_id,
        refundRecord.razorpay_payment_id,
        refundRecord.razorpay_refund_id,
        refundRecord.amount_paise,
        refundRecord.currency,
        refundRecord.status,
        refundRecord.reason,
        refundRecord.notes,
        refundRecord.initiated_by,
        refundRecord.source,
        refundRecord.idempotency_key,
        refundRecord.error_code,
        refundRecord.error_description,
        refundRecord.created_at,
        refundRecord.updated_at,
        refundRecord.processed_at
      ]
    );

    await db.run(
      `UPDATE orders
       SET pending_refund_amount_paise = ?,
           refund_status = ?,
           updated_at = ?
       WHERE id = ?`,
      [nextPendingPaise, nextRefundStatus, nowIso, order.id]
    );

    await db.run('COMMIT');
    inTx = false;

    syncedRefundsStore.set(refundRecord.id, refundRecord);
    updateSyncedFirebaseOrder(order.id, {
      pending_refund_amount_paise: nextPendingPaise,
      refund_status: nextRefundStatus,
      updated_at: nowIso
    });
    const updatedOrder = await db.get('SELECT * FROM orders WHERE id = ?', [order.id]);

    return { refund: refundRecord, order: updatedOrder, isReplay: false };
  } catch (error) {
    if (inTx) {
      await db.run('ROLLBACK').catch(() => { });
    }
    throw error;
  } finally {
    release();
  }
}

async function markSqliteRefundProcessed(
  db: any,
  params: MarkRefundProcessedParams
): Promise<{ refund: RefundRecord; order: any; isReplay: boolean }> {
  const release = await refundTransactionMutex.acquire();
  let inTx = false;

  try {
    await db.run('BEGIN IMMEDIATE');
    inTx = true;

    const refund = await db.get('SELECT * FROM refunds WHERE id = ?', [params.refundId]);
    if (!refund) {
      throw new NotFoundError(`Refund record with ID ${params.refundId} not found`);
    }

    const order = await db.get('SELECT * FROM orders WHERE id = ?', [refund.order_id]);
    if (!order) {
      throw new NotFoundError(`Order ${refund.order_id} associated with refund ${refund.id} not found`);
    }

    // F-1 Fencing Guard: Validate webhook claim generation inside authoritative transaction
    if (params.webhookFencing && db && db.get) {
      const whRow = await db.get(
        'SELECT status, claim_count FROM webhook_events WHERE provider = ? AND event_id = ?',
        [params.webhookFencing.provider, params.webhookFencing.eventId]
      );
      if (whRow) {
        if (whRow.claim_count !== undefined && whRow.claim_count !== params.webhookFencing.claimCount) {
          throw new ConflictError(
            `[STALE_WEBHOOK_WORKER] Webhook claim generation superseded for event ${params.webhookFencing.eventId}: current=${whRow.claim_count}, worker=${params.webhookFencing.claimCount}`
          );
        }
        if (whRow.status === 'PROCESSED') {
          await db.run('COMMIT');
          inTx = false;
          return { refund: mapFirestoreRefundToRecord(refund, refund.id), order, isReplay: true };
        }
      }
    }

    // 1. Idempotent replay if already PROCESSED
    if (refund.status === 'PROCESSED') {
      await db.run('COMMIT');
      inTx = false;
      return { refund: mapFirestoreRefundToRecord(refund, refund.id), order, isReplay: true };
    }

    // 2. Terminal state protection: FAILED cannot transition to PROCESSED
    if (refund.status === 'FAILED') {
      throw new BadRequestError(`Cannot mark refund ${refund.id} as PROCESSED because its status is already FAILED`);
    }

    // 3. Only PENDING can transition to PROCESSED
    if (refund.status !== 'PENDING') {
      throw new BadRequestError(`Invalid refund state transition: cannot transition from ${refund.status} to PROCESSED`);
    }

    const processedAt = params.processed_at || new Date().toISOString();
    const updatedAt = new Date().toISOString();
    const rpRefundId = params.razorpay_refund_id || refund.razorpay_refund_id || null;

    const updateResult = await db.run(
      `UPDATE refunds
       SET status = 'PROCESSED',
           razorpay_refund_id = ?,
           processed_at = ?,
           updated_at = ?
       WHERE id = ? AND status = 'PENDING'`,
      [rpRefundId, processedAt, updatedAt, refund.id]
    );

    if (updateResult && updateResult.changes === 0) {
      const current = await db.get('SELECT * FROM refunds WHERE id = ?', [refund.id]);
      if (current?.status === 'PROCESSED') {
        await db.run('COMMIT');
        inTx = false;
        return { refund: mapFirestoreRefundToRecord(current, current.id), order, isReplay: true };
      }
      throw new BadRequestError(`Concurrent conflict: refund ${refund.id} was already transitioned`);
    }

    const currentPending = Number(order.pending_refund_amount_paise || 0);
    const newPendingPaise = Math.max(0, currentPending - refund.amount_paise);
    const currentTotal = Number(order.total_refunded_amount_paise || 0);
    const newTotalRefundedPaise = currentTotal + refund.amount_paise;

    const balance = calculateRemainingRefundableBalance(order);
    const orderAmountPaise = balance.orderAmountPaise;

    const newRefundStatus: OrderRefundStatus =
      newTotalRefundedPaise >= orderAmountPaise ? 'FULL' : 'PARTIAL';

    await db.run(
      `UPDATE orders
       SET pending_refund_amount_paise = ?,
           total_refunded_amount_paise = ?,
           last_refunded_at = ?,
           refund_status = ?,
           updated_at = ?
       WHERE id = ?`,
      [newPendingPaise, newTotalRefundedPaise, processedAt, newRefundStatus, updatedAt, order.id]
    );

    await db.run('COMMIT');
    inTx = false;

    const processedRefundRecord = {
      ...mapFirestoreRefundToRecord(refund, refund.id),
      status: 'PROCESSED' as RefundStatus,
      razorpay_refund_id: rpRefundId,
      processed_at: processedAt,
      updated_at: updatedAt
    };

    syncedRefundsStore.set(refund.id, processedRefundRecord);
    updateSyncedFirebaseOrder(order.id, {
      pending_refund_amount_paise: newPendingPaise,
      total_refunded_amount_paise: newTotalRefundedPaise,
      last_refunded_at: processedAt,
      refund_status: newRefundStatus,
      updated_at: updatedAt
    });

    const updatedOrder = await db.get('SELECT * FROM orders WHERE id = ?', [order.id]);
    return { refund: processedRefundRecord, order: updatedOrder, isReplay: false };
  } catch (error) {
    if (inTx) {
      await db.run('ROLLBACK').catch(() => { });
    }
    throw error;
  } finally {
    release();
  }
}

async function markSqliteRefundFailed(
  db: any,
  params: MarkRefundFailedParams
): Promise<{ refund: RefundRecord; order: any; isReplay: boolean }> {
  const release = await refundTransactionMutex.acquire();
  let inTx = false;

  try {
    await db.run('BEGIN IMMEDIATE');
    inTx = true;

    const refund = await db.get('SELECT * FROM refunds WHERE id = ?', [params.refundId]);
    if (!refund) {
      throw new NotFoundError(`Refund record with ID ${params.refundId} not found`);
    }

    const order = await db.get('SELECT * FROM orders WHERE id = ?', [refund.order_id]);
    if (!order) {
      throw new NotFoundError(`Order ${refund.order_id} associated with refund ${refund.id} not found`);
    }

    // F-1 Fencing Guard: Validate webhook claim generation inside authoritative transaction
    if (params.webhookFencing && db && db.get) {
      const whRow = await db.get(
        'SELECT status, claim_count FROM webhook_events WHERE provider = ? AND event_id = ?',
        [params.webhookFencing.provider, params.webhookFencing.eventId]
      );
      if (whRow) {
        if (whRow.claim_count !== undefined && whRow.claim_count !== params.webhookFencing.claimCount) {
          throw new ConflictError(
            `[STALE_WEBHOOK_WORKER] Webhook claim generation superseded for event ${params.webhookFencing.eventId}: current=${whRow.claim_count}, worker=${params.webhookFencing.claimCount}`
          );
        }
        if (whRow.status === 'PROCESSED') {
          throw new ConflictError(
            `[STALE_WEBHOOK_WORKER] Event ${params.webhookFencing.eventId} was already settled PROCESSED; refusing to fail refund`
          );
        }
      }
    }

    // 1. Idempotent replay if already FAILED
    if (refund.status === 'FAILED') {
      await db.run('COMMIT');
      inTx = false;
      return { refund: mapFirestoreRefundToRecord(refund, refund.id), order, isReplay: true };
    }

    // 2. Terminal state protection: PROCESSED cannot transition to FAILED
    if (refund.status === 'PROCESSED') {
      throw new BadRequestError(`Cannot mark refund ${refund.id} as FAILED because its status is already PROCESSED`);
    }

    // 3. Only PENDING can transition to FAILED
    if (refund.status !== 'PENDING') {
      throw new BadRequestError(`Invalid refund state transition: cannot transition from ${refund.status} to FAILED`);
    }

    const updatedAt = new Date().toISOString();

    const updateResult = await db.run(
      `UPDATE refunds
       SET status = 'FAILED',
           error_code = ?,
           error_description = ?,
           updated_at = ?
       WHERE id = ? AND status = 'PENDING'`,
      [params.error_code || null, params.error_description || null, updatedAt, refund.id]
    );

    if (updateResult && updateResult.changes === 0) {
      const current = await db.get('SELECT * FROM refunds WHERE id = ?', [refund.id]);
      if (current?.status === 'FAILED') {
        await db.run('COMMIT');
        inTx = false;
        return { refund: mapFirestoreRefundToRecord(current, current.id), order, isReplay: true };
      }
      throw new BadRequestError(`Concurrent conflict: refund ${refund.id} was already transitioned`);
    }

    const currentPending = Number(order.pending_refund_amount_paise || 0);
    const newPendingPaise = Math.max(0, currentPending - refund.amount_paise);
    const totalRefundedPaise = Number(order.total_refunded_amount_paise || 0);

    const balance = calculateRemainingRefundableBalance(order);
    const orderAmountPaise = balance.orderAmountPaise;

    let newRefundStatus: OrderRefundStatus = 'NONE';
    if (totalRefundedPaise >= orderAmountPaise && orderAmountPaise > 0) {
      newRefundStatus = 'FULL';
    } else if (totalRefundedPaise > 0) {
      newRefundStatus = 'PARTIAL';
    } else if (newPendingPaise > 0) {
      newRefundStatus = 'PENDING';
    } else {
      newRefundStatus = 'FAILED';
    }

    await db.run(
      `UPDATE orders
       SET pending_refund_amount_paise = ?,
           refund_status = ?,
           updated_at = ?
       WHERE id = ?`,
      [newPendingPaise, newRefundStatus, updatedAt, order.id]
    );

    await db.run('COMMIT');
    inTx = false;

    const failedRefundRecord = {
      ...mapFirestoreRefundToRecord(refund, refund.id),
      status: 'FAILED' as RefundStatus,
      error_code: params.error_code || null,
      error_description: params.error_description || null,
      updated_at: updatedAt
    };

    syncedRefundsStore.set(refund.id, failedRefundRecord);
    updateSyncedFirebaseOrder(order.id, {
      pending_refund_amount_paise: newPendingPaise,
      refund_status: newRefundStatus,
      updated_at: updatedAt
    });

    const updatedOrder = await db.get('SELECT * FROM orders WHERE id = ?', [order.id]);
    return { refund: failedRefundRecord, order: updatedOrder, isReplay: false };
  } catch (error) {
    if (inTx) {
      await db.run('ROLLBACK').catch(() => { });
    }
    throw error;
  } finally {
    release();
  }
}

async function getSqliteRefundById(db: any, refundId: string): Promise<RefundRecord | null> {
  const normalizedId = String(refundId).trim();
  const row = await db.get('SELECT * FROM refunds WHERE id = ?', [normalizedId]);
  if (row) return mapFirestoreRefundToRecord(row, row.id);

  if (syncedRefundsStore.has(normalizedId)) {
    return syncedRefundsStore.get(normalizedId)!;
  }
  return null;
}

async function getSqliteRefundByIdempotencyKey(db: any, idempotencyKey: string): Promise<RefundRecord | null> {
  const normalizedKey = String(idempotencyKey).trim();
  const row = await db.get('SELECT * FROM refunds WHERE idempotency_key = ?', [normalizedKey]);
  if (row) return mapFirestoreRefundToRecord(row, row.id);

  for (const r of syncedRefundsStore.values()) {
    if (r.idempotency_key === normalizedKey) return r;
  }
  return null;
}

async function getSqliteRefundsByOrderId(db: any, orderId: string): Promise<RefundRecord[]> {
  const normalizedOrderId = String(orderId).trim();
  const rows = await db.all('SELECT * FROM refunds WHERE order_id = ? ORDER BY created_at ASC', [normalizedOrderId]);
  if (rows && rows.length > 0) {
    return rows.map((r: any) => mapFirestoreRefundToRecord(r, r.id));
  }

  const matching: RefundRecord[] = [];
  for (const r of syncedRefundsStore.values()) {
    if (r.order_id === normalizedOrderId) {
      matching.push(r);
    }
  }
  return matching.sort((a, b) => a.created_at.localeCompare(b.created_at));
}

// ---------------------------------------------------------------------------
// PUBLIC ADAPTER API (Routes automatically to Firestore or SQLite adapter)
// ---------------------------------------------------------------------------

/**
 * Resolves the active refund persistence mode.
 * Enforces strict fail-closed policy (HTTP 503) for Production/Preview environments
 * if shared Firestore persistence is not available.
 */
function isVercelRuntime(): boolean {
  return Boolean(process.env.VERCEL && process.env.VERCEL !== 'undefined' && process.env.VERCEL !== 'false');
}

export function getEffectiveRefundPersistenceMode(): 'firestore' | 'sqlite' {
  if (isFirestoreActive()) {
    return 'firestore';
  }

  // Strict Fail-Closed Rule for Production & Preview:
  if (isStrictFirebaseEnvironment() || isVercelRuntime()) {
    throw new ServiceUnavailableError(
      'Refund persistence service unavailable: Shared Firestore persistence is required in Production and Preview environments. Failing closed (HTTP 503).'
    );
  }

  return 'sqlite';
}

export async function createPendingRefundReservation(
  db: any,
  params: CreateRefundReservationParams
): Promise<{ refund: RefundRecord; order: any; isReplay: boolean }> {
  const normalizedKey = String(params.idempotency_key || '').trim();
  if (!normalizedKey) {
    throw new BadRequestError('Missing required idempotency_key for refund reservation');
  }

  const requestedPaise = Number(params.amount_paise);
  if (!Number.isInteger(requestedPaise) || !Number.isSafeInteger(requestedPaise) || requestedPaise <= 0) {
    throw new BadRequestError('Refund amount must be a positive integer in paise');
  }

  const mode = getEffectiveRefundPersistenceMode();
  if (mode === 'firestore') {
    return await createFirestoreRefundReservation(params, db);
  }

  return await createSqliteRefundReservation(db, params);
}

export async function markRefundProcessed(
  db: any,
  params: MarkRefundProcessedParams
): Promise<{ refund: RefundRecord; order: any; isReplay: boolean }> {
  const mode = getEffectiveRefundPersistenceMode();
  if (mode === 'firestore') {
    return await markFirestoreRefundProcessed(params, db);
  }

  return await markSqliteRefundProcessed(db, params);
}

export async function markRefundFailed(
  db: any,
  params: MarkRefundFailedParams
): Promise<{ refund: RefundRecord; order: any; isReplay: boolean }> {
  const mode = getEffectiveRefundPersistenceMode();
  if (mode === 'firestore') {
    return await markFirestoreRefundFailed(params, db);
  }

  return await markSqliteRefundFailed(db, params);
}

export async function getRefundById(db: any, refundId: string): Promise<RefundRecord | null> {
  const normalizedId = String(refundId).trim();
  const mode = getEffectiveRefundPersistenceMode();
  if (mode === 'firestore') {
    const firestore = getFirestoreInstance()!;
    const doc = await firestore.collection('refunds').doc(normalizedId).get();
    if (doc.exists) {
      return mapFirestoreRefundToRecord(doc.data(), doc.id);
    }
    return null;
  }

  return await getSqliteRefundById(db, normalizedId);
}

export async function getRefundByIdempotencyKey(
  db: any,
  idempotencyKey: string
): Promise<RefundRecord | null> {
  const normalizedKey = String(idempotencyKey).trim();
  const mode = getEffectiveRefundPersistenceMode();
  if (mode === 'firestore') {
    const firestore = getFirestoreInstance()!;
    const idemDoc = await firestore.collection('refund_idempotency').doc(normalizedKey).get();
    if (idemDoc.exists) {
      const data = idemDoc.data();
      if (data?.refund) {
        return mapFirestoreRefundToRecord(data.refund, data.refund_id);
      }
      return await getRefundById(db, data?.refund_id);
    }
    return null;
  }

  return await getSqliteRefundByIdempotencyKey(db, normalizedKey);
}

export async function getRefundsByOrderId(db: any, orderId: string): Promise<RefundRecord[]> {
  const normalizedOrderId = String(orderId).trim();
  const mode = getEffectiveRefundPersistenceMode();
  if (mode === 'firestore') {
    const firestore = getFirestoreInstance()!;
    const snap = await firestore.collection('orders').doc(normalizedOrderId).collection('refunds').get();
    if (!snap.empty) {
      const list = snap.docs.map((d: any) => mapFirestoreRefundToRecord(d.data(), d.id));
      return list.sort((a, b) => a.created_at.localeCompare(b.created_at));
    }
    return [];
  }

  return await getSqliteRefundsByOrderId(db, normalizedOrderId);
}

/**
 * Authoritatively reconciles a verified payment gateway refund outcome (Audit Warning W-2).
 * Designed for webhooks (e.g. refund.processed) and manual gateway synchronization.
 * If local record was previously FAILED (e.g. due to client-side network timeout),
 * safely transitions it to PROCESSED while recording the previous failure in an audit trail.
 */
export async function reconcileAuthoritativeGatewayRefundOutcome(
  db: any,
  params: {
    orderId: string;
    razorpayRefundId: string;
    razorpayPaymentId?: string | null;
    amount_paise: number;
    currency?: string | null;
    refundId?: string | null;
    processed_at?: string;
    notes?: string | null;
    machineId?: string | null;
    webhookFencing?: WebhookFencingParams | null;
  }
): Promise<{ refund: RefundRecord; order: any; isReplay: boolean }> {
  const normalizedOrderId = String(params.orderId).trim();
  const rpRefundId = String(params.razorpayRefundId).trim();
  const amountPaise = Number(params.amount_paise);
  const currency = String(params.currency || 'INR').trim().toUpperCase();
  const nowIso = new Date().toISOString();
  const processedAt = params.processed_at || nowIso;

  // Validate currency strictly: must be INR (Finding 1)
  if (currency !== 'INR') {
    throw new BadRequestError(`Authoritative refund currency must be INR (received: ${currency})`);
  }

  // Validate amount: must be positive safe integer in paise (Finding 1)
  if (!Number.isInteger(amountPaise) || !Number.isSafeInteger(amountPaise) || amountPaise <= 0) {
    throw new BadRequestError(`Authoritative refund amount must be a positive safe integer in paise (received: ${params.amount_paise})`);
  }

  // 1. Look for existing refund by razorpay_refund_id, or custom refundId
  let existingRefund: RefundRecord | null = null;
  if (db && db.get) {
    const row = await db.get(
      'SELECT * FROM refunds WHERE razorpay_refund_id = ? OR (id = ? AND order_id = ?)',
      [rpRefundId, params.refundId || '', normalizedOrderId]
    );
    if (row) {
      existingRefund = mapFirestoreRefundToRecord(row, row.id);
    }
  }

  // Check authoritative Firestore if active and not found in SQLite
  if (!existingRefund && isFirestoreActive()) {
    const firestore = getFirestoreInstance()!;
    if (params.refundId) {
      const doc = await firestore.collection('refunds').doc(params.refundId).get();
      if (doc.exists) {
        existingRefund = mapFirestoreRefundToRecord(doc.data(), doc.id);
      }
    }
    if (!existingRefund && rpRefundId) {
      const snap = await firestore
        .collection('refunds')
        .where('razorpay_refund_id', '==', rpRefundId)
        .limit(1)
        .get();
      if (!snap.empty) {
        existingRefund = mapFirestoreRefundToRecord(snap.docs[0].data(), snap.docs[0].id);
      }
    }
  }

  // Check in-memory mirror if not in SQLite
  if (!existingRefund) {
    for (const r of syncedRefundsStore.values()) {
      if (r.razorpay_refund_id === rpRefundId || (params.refundId && r.id === params.refundId)) {
        existingRefund = r;
        break;
      }
    }
  }

  // If already PROCESSED with same razorpay_refund_id, return idempotent replay
  if (existingRefund && existingRefund.status === 'PROCESSED' && existingRefund.razorpay_refund_id === rpRefundId) {
    const existingOrder = db && db.get ? await db.get('SELECT * FROM orders WHERE id = ?', [normalizedOrderId]) : null;
    return { refund: existingRefund, order: existingOrder, isReplay: true };
  }

  // Critical Finding 1: Compare actual gateway amount exactly against reserved refund's amount_paise
  if (existingRefund && existingRefund.amount_paise !== amountPaise) {
    // Retain the financial reservation safely in PENDING (do not release hold, do not settle as PROCESSED)
    const mismatchNote = `[DIAG_GATEWAY_AMOUNT_MISMATCH] Gateway reported ${amountPaise} ${currency} for refund ${rpRefundId}, but reservation expected ${existingRefund.amount_paise} paise. Held in PENDING for manual reconciliation.`;
    const updatedNotes = existingRefund.notes ? `${existingRefund.notes} | ${mismatchNote}` : mismatchNote;

    existingRefund.razorpay_refund_id = rpRefundId;
    existingRefund.error_code = 'GATEWAY_AMOUNT_MISMATCH';
    existingRefund.error_description = `Gateway reported refund amount ${amountPaise} paise does not match reserved amount ${existingRefund.amount_paise} paise`;
    existingRefund.notes = updatedNotes;
    existingRefund.updated_at = nowIso;

    // Persist diagnostic update to Firestore
    if (isFirestoreActive()) {
      const firestore = getFirestoreInstance()!;
      const refundPayload = mapRefundRecordToFirestore(existingRefund);
      await firestore.collection('refunds').doc(existingRefund.id).set(refundPayload, { merge: true });
      await firestore.collection('orders').doc(normalizedOrderId).collection('refunds').doc(existingRefund.id).set(refundPayload, { merge: true });
    }

    // Persist diagnostic update to SQLite
    if (db && db.run) {
      await db.run(
        `UPDATE refunds 
         SET razorpay_refund_id = ?, error_code = ?, error_description = ?, notes = ?, updated_at = ?
         WHERE id = ?`,
        [rpRefundId, existingRefund.error_code, existingRefund.error_description, updatedNotes, nowIso, existingRefund.id]
      );
    }
    syncedRefundsStore.set(existingRefund.id, existingRefund);

    logger.error(
      `[CRITICAL FINANCIAL EXCEPTION] Gateway refund amount mismatch on order ${normalizedOrderId} (refund: ${existingRefund.id}): gateway=${amountPaise} paise, reserved=${existingRefund.amount_paise} paise. Held in PENDING.`
    );

    throw new ConflictError(
      `[GATEWAY_AMOUNT_MISMATCH] Gateway reported refund amount ${amountPaise} paise does not match reserved amount ${existingRefund.amount_paise} paise`
    );
  }

  // If existing record was PENDING and amount matches, promote cleanly via standard settlement
  if (existingRefund && existingRefund.status === 'PENDING') {
    return await markRefundProcessed(db, {
      refundId: existingRefund.id,
      razorpay_refund_id: rpRefundId,
      processed_at: processedAt,
      webhookFencing: params.webhookFencing
    });
  }

  // If existing record was FAILED (or missing), perform authoritative gateway override
  const refundId = existingRefund ? existingRefund.id : (params.refundId || `RFND-${normalizedOrderId}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`);
  const previousStatus = existingRefund ? existingRefund.status : 'UNRECORDED';
  const previousError = existingRefund?.error_code || 'none';
  const auditNote = `[AUTHORITATIVE_GATEWAY_OVERRIDE] Previous status was ${previousStatus} (code: ${previousError}); superseded by verified gateway refund ${rpRefundId}`;
  const combinedNotes = params.notes
    ? `${params.notes} | ${auditNote}`
    : (existingRefund?.notes ? `${existingRefund.notes} | ${auditNote}` : auditNote);

  const resolvedMachineId = existingRefund?.machine_id || params.machineId || '';

  const updatedRecord: RefundRecord = {
    id: refundId,
    order_id: normalizedOrderId,
    machine_id: resolvedMachineId,
    razorpay_payment_id: params.razorpayPaymentId || existingRefund?.razorpay_payment_id || '',
    razorpay_refund_id: rpRefundId,
    amount_paise: amountPaise,
    currency: 'INR',
    status: 'PROCESSED',
    reason: existingRefund?.reason || 'gateway_webhook_settlement',
    notes: combinedNotes,
    initiated_by: existingRefund?.initiated_by || 'system_gateway',
    source: 'RECONCILIATION',
    idempotency_key: existingRefund?.idempotency_key || `idem_gw_${rpRefundId}`,
    error_code: null,
    error_description: auditNote,
    created_at: existingRefund?.created_at || nowIso,
    updated_at: nowIso,
    processed_at: processedAt
  };

  // Update Firestore if active
  if (isFirestoreActive()) {
    const firestore = getFirestoreInstance()!;
    await firestore.runTransaction(async (tx) => {
      // F-1 Fencing Guard: Validate webhook claim generation inside authoritative transaction
      if (params.webhookFencing) {
        const whDocRef = firestore.collection('webhook_events').doc(`${params.webhookFencing.provider}_${params.webhookFencing.eventId}`);
        const whSnap = await tx.get(whDocRef);
        if (whSnap.exists) {
          const whData = whSnap.data() as any;
          if (whData.claim_count !== undefined && whData.claim_count !== params.webhookFencing.claimCount) {
            throw new ConflictError(
              `[STALE_WEBHOOK_WORKER] Webhook claim generation superseded for event ${params.webhookFencing.eventId}: current=${whData.claim_count}, worker=${params.webhookFencing.claimCount}`
            );
          }
          if (whData.status === 'PROCESSED') {
            return;
          }
        }
      }

      const orderRef = firestore.collection('orders').doc(normalizedOrderId);
      const orderSnap = await tx.get(orderRef);
      if (!orderSnap.exists) {
        throw new NotFoundError(`Order ${normalizedOrderId} not found`);
      }
      const orderData = orderSnap.data() as any;

      // F-3: Inherit verified machine ID from authoritative order document if not already set
      if (!updatedRecord.machine_id && orderData.machine_id) {
        updatedRecord.machine_id = orderData.machine_id;
      }

      // Adjust balances
      let currentPending = Number(orderData.pending_refund_amount_paise || 0);
      if (previousStatus === 'PENDING') {
        currentPending = Math.max(0, currentPending - amountPaise);
      }
      const newTotal = Number(orderData.total_refunded_amount_paise || 0) + (previousStatus === 'PROCESSED' ? 0 : amountPaise);
      const balance = calculateRemainingRefundableBalance(orderData);
      const orderAmountPaise = balance.orderAmountPaise;
      const newStatus: OrderRefundStatus = newTotal >= orderAmountPaise ? 'FULL' : 'PARTIAL';
      const nextVersion = Number(orderData.refund_version || 0) + 1;

      const refundPayload = mapRefundRecordToFirestore(updatedRecord);
      tx.set(firestore.collection('refunds').doc(refundId), refundPayload, { merge: true });
      tx.set(firestore.collection('orders').doc(normalizedOrderId).collection('refunds').doc(refundId), refundPayload, { merge: true });
      tx.set(orderRef, {
        pending_refund_amount_paise: currentPending,
        total_refunded_amount_paise: newTotal,
        refund_status: newStatus,
        last_refunded_at: processedAt,
        refund_version: nextVersion,
        updated_at: nowIso
      }, { merge: true });
    });
  }

  // Update SQLite cache
  if (db && db.run) {
    // F-1 Fencing Guard: Validate webhook claim generation in SQLite
    if (params.webhookFencing && db && db.get) {
      const whRow = await db.get(
        'SELECT status, claim_count FROM webhook_events WHERE provider = ? AND event_id = ?',
        [params.webhookFencing.provider, params.webhookFencing.eventId]
      );
      if (whRow) {
        if (whRow.claim_count !== undefined && whRow.claim_count !== params.webhookFencing.claimCount) {
          throw new ConflictError(
            `[STALE_WEBHOOK_WORKER] Webhook claim generation superseded for event ${params.webhookFencing.eventId}: current=${whRow.claim_count}, worker=${params.webhookFencing.claimCount}`
          );
        }
        if (whRow.status === 'PROCESSED') {
          const existingOrder = await db.get('SELECT * FROM orders WHERE id = ?', [normalizedOrderId]);
          return { refund: updatedRecord, order: existingOrder, isReplay: true };
        }
      }
    }

    // Recompute order totals in SQLite
    const order = await db.get('SELECT * FROM orders WHERE id = ?', [normalizedOrderId]);
    if (order) {
      // F-3: Inherit verified machine ID from authoritative order record if not already set
      if (!updatedRecord.machine_id && order.machine_id) {
        updatedRecord.machine_id = order.machine_id;
      }

      let currentPending = Number(order.pending_refund_amount_paise || 0);
      if (previousStatus === 'PENDING') {
        currentPending = Math.max(0, currentPending - amountPaise);
      }
      const newTotal = Number(order.total_refunded_amount_paise || 0) + (previousStatus === 'PROCESSED' ? 0 : amountPaise);
      const balance = calculateRemainingRefundableBalance(order);
      const newStatus: OrderRefundStatus = newTotal >= balance.orderAmountPaise ? 'FULL' : 'PARTIAL';

      await db.run(
        `UPDATE orders
         SET pending_refund_amount_paise = ?,
             total_refunded_amount_paise = ?,
             last_refunded_at = ?,
             refund_status = ?,
             updated_at = ?
         WHERE id = ?`,
        [currentPending, newTotal, processedAt, newStatus, nowIso, normalizedOrderId]
      );
    }

    await db.run(
      `INSERT OR REPLACE INTO refunds (
        id, order_id, machine_id, razorpay_payment_id, razorpay_refund_id,
        amount_paise, currency, status, reason, notes, initiated_by,
        source, idempotency_key, error_code, error_description,
        created_at, updated_at, processed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        updatedRecord.id, updatedRecord.order_id, updatedRecord.machine_id, updatedRecord.razorpay_payment_id,
        updatedRecord.razorpay_refund_id, updatedRecord.amount_paise, updatedRecord.currency, updatedRecord.status,
        updatedRecord.reason, updatedRecord.notes, updatedRecord.initiated_by, updatedRecord.source,
        updatedRecord.idempotency_key, updatedRecord.error_code, updatedRecord.error_description,
        updatedRecord.created_at, updatedRecord.updated_at, updatedRecord.processed_at
      ]
    );
  }

  syncedRefundsStore.set(updatedRecord.id, updatedRecord);
  const updatedOrder = db && db.get ? await db.get('SELECT * FROM orders WHERE id = ?', [normalizedOrderId]) : null;

  logger.info(
    `Authoritative gateway refund reconciliation completed for order ${normalizedOrderId} (refund: ${refundId}, rpRefundId: ${rpRefundId})`
  );

  return { refund: updatedRecord, order: updatedOrder, isReplay: false };
}
