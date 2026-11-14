import { getFirestoreInstance, isFirestoreActive, isStrictFirebaseEnvironment } from '../utils/firebase';
import { ServiceUnavailableError } from '../utils/errors';
import logger from '../utils/logger';

export type TimeSeriesInterval = 'hour' | 'day' | 'week' | 'month';

export interface AnalyticsTimeframe {
  startDate?: string;
  endDate?: string;
  timeZone?: string;
}

export interface AnalyticsScopeOptions {
  machineId?: string;
  machineIds?: string[];
  timeframe?: AnalyticsTimeframe;
  forceSource?: 'firestore' | 'sqlite';
}

export interface FinancialKPISummary {
  gross_sales_paise: number;
  gross_sales_inr: number;
  processed_refunds_paise: number;
  processed_refunds_inr: number;
  net_revenue_paise: number;
  net_revenue_inr: number;
  refunds_exceed_period_sales: boolean;
  over_refund_detected: boolean;
  paid_orders_count: number;
  pending_orders_count: number;
  failed_orders_count: number;
  dispensed_count: number;
  dispense_failed_count: number;
  dispense_in_flight_count: number;
  average_order_value_inr: number;
  dispense_fulfillment_rate: number;
}

export interface TimeSeriesBucket {
  bucket_key: string;
  label: string;
  gross_sales_paise: number;
  gross_sales_inr: number;
  processed_refunds_paise: number;
  processed_refunds_inr: number;
  net_revenue_paise: number;
  net_revenue_inr: number;
  paid_orders_count: number;
  dispensed_orders_count: number;
  failed_dispenses_count: number;
}

export interface MachineAnalyticsItem {
  machine_id: string;
  machine_name: string;
  location: string;
  owner_id: string | null;
  gross_sales_paise: number;
  gross_sales_inr: number;
  processed_refunds_paise: number;
  processed_refunds_inr: number;
  net_revenue_paise: number;
  net_revenue_inr: number;
  paid_orders_count: number;
  dispensed_count: number;
  dispense_failed_count: number;
  dispense_fulfillment_rate: number;
}

export interface ProductAnalyticsItem {
  product_id: number;
  product_name: string;
  units_sold: number;
  gross_sales_paise: number;
  gross_sales_inr: number;
  revenue_share_percent: number;
  refunded_units: number;
  refunded_amount_paise: number;
  refunded_amount_inr: number;
}

export interface InventoryMovementAnalytics {
  ingredient: string;
  total_consumed: number;
  total_refilled: number;
  total_waste: number;
  total_adjustments: number;
  current_balance: number | null;
  inventory_source?: string | null;
}

export interface RefundItemSummary {
  id: string;
  order_id: string;
  machine_id: string;
  amount_paise: number;
  amount_inr: number;
  status: string;
  reason: string;
  source: string;
  created_at: string;
  updated_at?: string;
}

export interface RefundsAnalyticsResult {
  total_refunds_count: number;
  processed_refunds_count: number;
  processed_refunds_paise: number;
  processed_refunds_inr: number;
  pending_refunds_count: number;
  pending_refunds_paise: number;
  pending_refunds_inr: number;
  failed_refunds_count: number;
  failed_refunds_paise: number;
  failed_refunds_inr: number;
  refunds_exceed_period_sales: boolean;
  over_refund_detected: boolean;
  refund_reasons: Record<string, number>;
  recent_refunds: RefundItemSummary[];
}

/**
 * Standard monetary conversions between integer paise and INR.
 * Supports signed integers for negative net revenue.
 */
export function paiseToInr(paise: number): number {
  if (!Number.isFinite(paise)) return 0;
  return Math.round(paise / 100);
}

export function inrToPaise(inr: number): number {
  if (!Number.isFinite(inr)) return 0;
  return Math.round(inr * 100);
}

/**
 * Converts input date strings (calendar dates or full ISO strings) into UTC ISO strings
 * respecting Asia/Kolkata (+05:30) calendar day boundaries.
 */
export function normalizeTimeframe(
  startDate?: string,
  endDate?: string,
  timeZone: string = 'Asia/Kolkata'
): AnalyticsTimeframe {
  let startUtc: string | undefined;
  let endUtc: string | undefined;

  if (startDate) {
    const trimmed = startDate.trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
      startUtc = new Date(`${trimmed}T00:00:00+05:30`).toISOString();
    } else {
      startUtc = new Date(trimmed).toISOString();
    }
  }

  if (endDate) {
    const trimmed = endDate.trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
      endUtc = new Date(`${trimmed}T23:59:59.999+05:30`).toISOString();
    } else {
      endUtc = new Date(trimmed).toISOString();
    }
  }

  return {
    startDate: startUtc,
    endDate: endUtc,
    timeZone
  };
}

/**
 * Formats a UTC ISO date string into specific time-zone calendar buckets using native Intl.DateTimeFormat.
 * Default time zone: 'Asia/Kolkata' (IST, UTC+05:30).
 */
export function formatInTimeZone(
  dateInput: string | Date | number,
  timeZone: string = 'Asia/Kolkata'
): {
  dateKey: string;      // YYYY-MM-DD
  hourKey: string;      // YYYY-MM-DD HH:00
  monthKey: string;     // YYYY-MM
  yearKey: string;      // YYYY
  displayLabel: string; // e.g. "14 Nov 2026"
  hourLabel: string;    // e.g. "14 Nov, 02:00 PM"
} {
  const d = new Date(dateInput);
  if (Number.isNaN(d.getTime())) {
    return {
      dateKey: '1970-01-01',
      hourKey: '1970-01-01 00:00',
      monthKey: '1970-01',
      yearKey: '1970',
      displayLabel: '—',
      hourLabel: '—'
    };
  }

  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hourCycle: 'h23'
  });

  const parts = formatter.formatToParts(d);
  let year = '1970';
  let month = '01';
  let day = '01';
  let hour = '00';

  for (const part of parts) {
    if (part.type === 'year') year = part.value;
    if (part.type === 'month') month = part.value;
    if (part.type === 'day') day = part.value;
    if (part.type === 'hour') hour = part.value;
  }

  const dateKey = `${year}-${month}-${day}`;
  const hourKey = `${dateKey} ${hour}:00`;
  const monthKey = `${year}-${month}`;
  const yearKey = year;

  const displayFormatter = new Intl.DateTimeFormat('en-IN', {
    timeZone,
    day: '2-digit',
    month: 'short',
    year: 'numeric'
  });

  const hourDisplayFormatter = new Intl.DateTimeFormat('en-IN', {
    timeZone,
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true
  });

  return {
    dateKey,
    hourKey,
    monthKey,
    yearKey,
    displayLabel: displayFormatter.format(d),
    hourLabel: hourDisplayFormatter.format(d)
  };
}

/**
 * Computes Monday–Sunday reporting week bucket in target timezone from YYYY-MM-DD dateKey.
 * Preserves chronological sorting across month and year boundaries.
 */
function getWeekBucketForDateKey(dateKey: string): { key: string; label: string } {
  const parts = dateKey.split('-').map(Number);
  if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n))) {
    return { key: dateKey, label: dateKey };
  }
  const [y, m, d] = parts;
  const utcDate = new Date(Date.UTC(y, m - 1, d));
  const dow = utcDate.getUTCDay(); // 0=Sun, 1=Mon, ..., 6=Sat
  const diffToMonday = dow === 0 ? -6 : 1 - dow;
  const monday = new Date(utcDate.getTime() + diffToMonday * 86400000);
  const sunday = new Date(monday.getTime() + 6 * 86400000);

  const key = monday.toISOString().slice(0, 10);
  const labelFormatter = new Intl.DateTimeFormat('en-IN', {
    timeZone: 'UTC',
    day: '2-digit',
    month: 'short',
    year: 'numeric'
  });

  return {
    key,
    label: `${labelFormatter.format(monday)} - ${labelFormatter.format(sunday)}`
  };
}

function resolveTimeSeriesBucket(
  dateInput: string | Date | number,
  interval: TimeSeriesInterval,
  timeZone: string
): { key: string; label: string } {
  const formatted = formatInTimeZone(dateInput, timeZone);
  if (interval === 'hour') {
    return { key: formatted.hourKey, label: formatted.hourLabel };
  }
  if (interval === 'week') {
    return getWeekBucketForDateKey(formatted.dateKey);
  }
  if (interval === 'month') {
    return { key: formatted.monthKey, label: formatted.monthKey };
  }
  return { key: formatted.dateKey, label: formatted.displayLabel };
}

/**
 * Determines whether queries should be routed to authoritative Firestore.
 * Strict fail-closed rules apply:
 * - Production/Preview strictly requires Firestore. Falling back to SQLite in strict mode throws ServiceUnavailableError (HTTP 503).
 */
export function shouldRunFirestore(options?: AnalyticsScopeOptions): boolean {
  if (options?.forceSource === 'sqlite') {
    if (isStrictFirebaseEnvironment()) {
      throw new ServiceUnavailableError(
        'SQLite analytics source is forbidden in strict Firebase environment. Failing closed (HTTP 503).'
      );
    }
    return false;
  }
  if (options?.forceSource === 'firestore') {
    if (!isFirestoreActive()) {
      throw new ServiceUnavailableError(
        'Authoritative Firestore is not active. Failing closed (HTTP 503).'
      );
    }
    return true;
  }
  if (isStrictFirebaseEnvironment()) {
    if (!isFirestoreActive()) {
      throw new ServiceUnavailableError(
        'Shared Firestore persistence is required in Production and Preview environments. Failing closed (HTTP 503).'
      );
    }
    return true;
  }
  return false;
}

/**
 * Normalizes options into SQL parameter clauses and values for SQLite queries.
 */
function buildSqlFilter(
  prefix: string,
  options?: AnalyticsScopeOptions
): { whereSql: string; params: any[] } {
  const clauses: string[] = [];
  const params: any[] = [];
  const colPrefix = prefix ? `${prefix}.` : '';

  if (options?.machineId) {
    clauses.push(`${colPrefix}machine_id = ?`);
    params.push(options.machineId);
  } else if (options?.machineIds !== undefined) {
    if (options.machineIds.length === 0) {
      clauses.push('1 = 0'); // Empty owner scope
    } else if (options.machineIds.length === 1) {
      clauses.push(`${colPrefix}machine_id = ?`);
      params.push(options.machineIds[0]);
    } else {
      const placeholders = options.machineIds.map(() => '?').join(', ');
      clauses.push(`${colPrefix}machine_id IN (${placeholders})`);
      params.push(...options.machineIds);
    }
  }

  if (options?.timeframe?.startDate) {
    const d = new Date(options.timeframe.startDate);
    const startIso = !isNaN(d.getTime()) ? d.toISOString() : options.timeframe.startDate;
    clauses.push(`${colPrefix}created_at >= ?`);
    params.push(startIso);
  }
  if (options?.timeframe?.endDate) {
    const d = new Date(options.timeframe.endDate);
    const endIso = !isNaN(d.getTime()) ? d.toISOString() : options.timeframe.endDate;
    clauses.push(`${colPrefix}created_at <= ?`);
    params.push(endIso);
  }

  const whereSql = clauses.length > 0 ? ` AND ${clauses.join(' AND ')}` : '';
  return { whereSql, params };
}

// ---------------------------------------------------------------------------
// Firestore Data Loaders (Authoritative Online Source)
// ---------------------------------------------------------------------------

/**
 * Chunks an array of machine IDs into partitions of at most maxChunkSize (default: 30 for Firestore 'in' limit).
 * Deduplicates machine IDs and trims whitespace.
 * Returns an array of string arrays. If input is empty, returns [].
 */
export function chunkMachineIds(machineIds?: string[], maxChunkSize: number = 30): string[][] {
  if (!machineIds || machineIds.length === 0) return [];
  const unique = Array.from(
    new Set(
      machineIds
        .map((m) => String(m || '').trim())
        .filter((m) => m.length > 0)
    )
  );
  if (unique.length === 0) return [];
  const chunks: string[][] = [];
  for (let i = 0; i < unique.length; i += maxChunkSize) {
    chunks.push(unique.slice(i, i + maxChunkSize));
  }
  return chunks;
}

async function queryFirestoreOrders(options?: AnalyticsScopeOptions): Promise<any[]> {
  const firestore = getFirestoreInstance();
  if (!firestore) {
    throw new ServiceUnavailableError('Firestore instance not available');
  }
  try {
    const startIso = options?.timeframe?.startDate
      ? (!isNaN(new Date(options.timeframe.startDate).getTime())
          ? new Date(options.timeframe.startDate).toISOString()
          : options.timeframe.startDate)
      : null;
    const endIso = options?.timeframe?.endDate
      ? (!isNaN(new Date(options.timeframe.endDate).getTime())
          ? new Date(options.timeframe.endDate).toISOString()
          : options.timeframe.endDate)
      : null;

    // 1. Explicit single machine query
    if (options?.machineId) {
      let q: FirebaseFirestore.Query = firestore.collection('orders').where('machine_id', '==', options.machineId);
      if (startIso) q = q.where('created_at', '>=', startIso);
      if (endIso) q = q.where('created_at', '<=', endIso);
      const snap = await q.get();
      return snap.docs.map((d) => ({ ...d.data(), id: d.id }));
    }

    // 2. Machine IDs scope specified (e.g. Owner assigned machines)
    if (options?.machineIds !== undefined) {
      if (options.machineIds.length === 0) return [];

      const chunks = chunkMachineIds(options.machineIds, 30);
      if (chunks.length === 0) return [];

      const chunkPromises = chunks.map(async (chunk) => {
        let q: FirebaseFirestore.Query = firestore.collection('orders');
        if (chunk.length === 1) {
          q = q.where('machine_id', '==', chunk[0]);
        } else {
          q = q.where('machine_id', 'in', chunk);
        }
        if (startIso) q = q.where('created_at', '>=', startIso);
        if (endIso) q = q.where('created_at', '<=', endIso);
        return q.get();
      });

      const snapshots = await Promise.all(chunkPromises);
      const docMap = new Map<string, any>();
      for (const snap of snapshots) {
        for (const d of snap.docs) {
          if (!docMap.has(d.id)) {
            docMap.set(d.id, { ...d.data(), id: d.id });
          }
        }
      }
      return Array.from(docMap.values());
    }

    // 3. Fleet-wide query (Super Admin without machine filters)
    let q: FirebaseFirestore.Query = firestore.collection('orders');
    if (startIso) q = q.where('created_at', '>=', startIso);
    if (endIso) q = q.where('created_at', '<=', endIso);
    const snap = await q.get();
    return snap.docs.map((d) => ({ ...d.data(), id: d.id }));
  } catch (err: any) {
    throw new ServiceUnavailableError(`Firestore orders query failed: ${err?.message || err}`);
  }
}

/**
 * Authoritatively queries the root /refunds collection in Firestore.
 * Rules:
 * - Only reads root /refunds/{refundId}.
 * - Strictly ignores nested /orders/{orderId}/refunds subcollections to prevent double-counting.
 * - Never includes order aggregate fields in document sums.
 * - Chunks machine queries into groups of at most 30 to respect Firestore 'in' limits.
 */
async function queryFirestoreRefunds(options?: AnalyticsScopeOptions): Promise<any[]> {
  const firestore = getFirestoreInstance();
  if (!firestore) {
    throw new ServiceUnavailableError('Firestore instance not available');
  }
  try {
    const startIso = options?.timeframe?.startDate
      ? (!isNaN(new Date(options.timeframe.startDate).getTime())
          ? new Date(options.timeframe.startDate).toISOString()
          : options.timeframe.startDate)
      : null;
    const endIso = options?.timeframe?.endDate
      ? (!isNaN(new Date(options.timeframe.endDate).getTime())
          ? new Date(options.timeframe.endDate).toISOString()
          : options.timeframe.endDate)
      : null;

    if (options?.machineId) {
      let q: FirebaseFirestore.Query = firestore.collection('refunds').where('machine_id', '==', options.machineId);
      if (startIso) q = q.where('created_at', '>=', startIso);
      if (endIso) q = q.where('created_at', '<=', endIso);
      const snap = await q.get();
      return snap.docs.map((d) => ({ ...d.data(), id: d.id }));
    }

    if (options?.machineIds !== undefined) {
      if (options.machineIds.length === 0) return [];

      const chunks = chunkMachineIds(options.machineIds, 30);
      if (chunks.length === 0) return [];

      const chunkPromises = chunks.map(async (chunk) => {
        let q: FirebaseFirestore.Query = firestore.collection('refunds');
        if (chunk.length === 1) {
          q = q.where('machine_id', '==', chunk[0]);
        } else {
          q = q.where('machine_id', 'in', chunk);
        }
        if (startIso) q = q.where('created_at', '>=', startIso);
        if (endIso) q = q.where('created_at', '<=', endIso);
        return q.get();
      });

      const snapshots = await Promise.all(chunkPromises);
      const docMap = new Map<string, any>();
      for (const snap of snapshots) {
        for (const d of snap.docs) {
          if (!docMap.has(d.id)) {
            docMap.set(d.id, { ...d.data(), id: d.id });
          }
        }
      }
      return Array.from(docMap.values());
    }

    let q: FirebaseFirestore.Query = firestore.collection('refunds');
    if (startIso) q = q.where('created_at', '>=', startIso);
    if (endIso) q = q.where('created_at', '<=', endIso);
    const snap = await q.get();
    return snap.docs.map((d) => ({ ...d.data(), id: d.id }));
  } catch (err: any) {
    throw new ServiceUnavailableError(`Firestore refunds query failed: ${err?.message || err}`);
  }
}

async function queryFirestoreMachines(options?: AnalyticsScopeOptions): Promise<any[]> {
  const firestore = getFirestoreInstance();
  if (!firestore) {
    throw new ServiceUnavailableError('Firestore instance not available');
  }
  try {
    if (options?.machineId) {
      const doc = await firestore.collection('machines').doc(options.machineId).get();
      if (!doc.exists) return [];
      return [{ ...doc.data(), id: doc.id }];
    }
    if (options?.machineIds !== undefined && options.machineIds.length === 0) {
      return [];
    }
    const snap = await firestore.collection('machines').get();
    let list = snap.docs.map((d) => ({ ...d.data(), id: d.id }));
    if (options?.machineIds !== undefined) {
      const allowed = new Set(options.machineIds);
      list = list.filter((m) => allowed.has(m.id));
    }
    return list;
  } catch (err: any) {
    throw new ServiceUnavailableError(`Firestore machines query failed: ${err?.message || err}`);
  }
}

async function queryFirestoreInventoryLedger(options?: AnalyticsScopeOptions): Promise<any[]> {
  const firestore = getFirestoreInstance();
  if (!firestore) {
    throw new ServiceUnavailableError('Firestore instance not available');
  }
  try {
    const startIso = options?.timeframe?.startDate
      ? (!isNaN(new Date(options.timeframe.startDate).getTime())
          ? new Date(options.timeframe.startDate).toISOString()
          : options.timeframe.startDate)
      : null;
    const endIso = options?.timeframe?.endDate
      ? (!isNaN(new Date(options.timeframe.endDate).getTime())
          ? new Date(options.timeframe.endDate).toISOString()
          : options.timeframe.endDate)
      : null;

    if (options?.machineId) {
      let q: FirebaseFirestore.Query = firestore.collection('inventory_ledger').where('machine_id', '==', options.machineId);
      if (startIso) q = q.where('created_at', '>=', startIso);
      if (endIso) q = q.where('created_at', '<=', endIso);
      const snap = await q.get();
      return snap.docs.map((d) => ({ ...d.data(), id: d.id }));
    }

    if (options?.machineIds !== undefined) {
      if (options.machineIds.length === 0) return [];

      const chunks = chunkMachineIds(options.machineIds, 30);
      if (chunks.length === 0) return [];

      const chunkPromises = chunks.map(async (chunk) => {
        let q: FirebaseFirestore.Query = firestore.collection('inventory_ledger');
        if (chunk.length === 1) {
          q = q.where('machine_id', '==', chunk[0]);
        } else {
          q = q.where('machine_id', 'in', chunk);
        }
        if (startIso) q = q.where('created_at', '>=', startIso);
        if (endIso) q = q.where('created_at', '<=', endIso);
        return q.get();
      });

      const snapshots = await Promise.all(chunkPromises);
      const docMap = new Map<string, any>();
      for (const snap of snapshots) {
        for (const d of snap.docs) {
          if (!docMap.has(d.id)) {
            docMap.set(d.id, { ...d.data(), id: d.id });
          }
        }
      }
      return Array.from(docMap.values());
    }

    let q: FirebaseFirestore.Query = firestore.collection('inventory_ledger');
    if (startIso) q = q.where('created_at', '>=', startIso);
    if (endIso) q = q.where('created_at', '<=', endIso);
    const snap = await q.get();
    return snap.docs.map((d) => ({ ...d.data(), id: d.id }));
  } catch (err: any) {
    throw new ServiceUnavailableError(`Firestore inventory_ledger query failed: ${err?.message || err}`);
  }
}

// ---------------------------------------------------------------------------
// Core Calculation Functions
// ---------------------------------------------------------------------------

/**
 * 1. Gross captured sales in integer paise.
 * Rules:
 * - Only orders with status IN ('PAID', 'PREPARING', 'COMPLETED')
 * - AND (razorpay_payment_id IS NOT NULL OR captured_amount_paise IS NOT NULL)
 * - Uses exact captured_amount_paise if available, falling back to amount * 100 paise.
 */
export async function getGrossCapturedSalesPaise(
  db: any,
  options?: AnalyticsScopeOptions
): Promise<number> {
  if (shouldRunFirestore(options)) {
    const orders = await queryFirestoreOrders(options);
    let gross = 0;
    for (const o of orders) {
      const isPaid =
        ['PAID', 'PREPARING', 'COMPLETED'].includes(String(o.status || '').toUpperCase()) &&
        (o.razorpay_payment_id || o.captured_amount_paise !== undefined && o.captured_amount_paise !== null);
      if (isPaid) {
        const orderPaise =
          o.captured_amount_paise !== null && o.captured_amount_paise !== undefined
            ? Number(o.captured_amount_paise)
            : Math.round(Number(o.amount || 0) * 100);
        gross += orderPaise;
      }
    }
    return gross;
  }

  const { whereSql, params } = buildSqlFilter('o', options);
  const row = await db.get(
    `SELECT COALESCE(SUM(
       CASE
         WHEN o.status IN ('PAID', 'PREPARING', 'COMPLETED')
              AND (o.razorpay_payment_id IS NOT NULL OR o.captured_amount_paise IS NOT NULL)
         THEN COALESCE(o.captured_amount_paise, o.amount * 100)
         ELSE 0
       END
     ), 0) as gross_paise
     FROM orders o
     WHERE 1=1 ${whereSql}`,
    params
  );
  return Number(row?.gross_paise || 0);
}

/**
 * 2. Processed refunds in integer paise.
 * Rules:
 * - Only refunds with status = 'PROCESSED'
 * - Pending reservations are strictly excluded.
 * - Single-counted from authoritative root refunds records.
 */
export async function getProcessedRefundsPaise(
  db: any,
  options?: AnalyticsScopeOptions
): Promise<number> {
  if (shouldRunFirestore(options)) {
    const refunds = await queryFirestoreRefunds(options);
    let total = 0;
    for (const r of refunds) {
      if (String(r.status || '').toUpperCase() === 'PROCESSED') {
        total += Number(r.amount_paise || 0);
      }
    }
    return total;
  }

  const { whereSql, params } = buildSqlFilter('r', options);
  const row = await db.get(
    `SELECT COALESCE(SUM(r.amount_paise), 0) as refunded_paise
     FROM refunds r
     WHERE r.status = 'PROCESSED' ${whereSql}`,
    params
  );
  return Number(row?.refunded_paise || 0);
}

/**
 * 3. Net revenue in integer paise (Gross Captured Sales - Processed Refunds).
 * Financial Correctness (Audit F-4A):
 * - Returns signed integer paise without clamping to zero.
 * - Can be negative when cross-period refunds exceed period sales.
 */
export async function getNetRevenuePaise(
  db: any,
  options?: AnalyticsScopeOptions
): Promise<number> {
  const gross = await getGrossCapturedSalesPaise(db, options);
  const refunds = await getProcessedRefundsPaise(db, options);
  return gross - refunds;
}

/**
 * 4. Paid order count.
 * Verified payment transactions.
 */
export async function getPaidOrderCount(
  db: any,
  options?: AnalyticsScopeOptions
): Promise<number> {
  if (shouldRunFirestore(options)) {
    const orders = await queryFirestoreOrders(options);
    return orders.filter(
      (o) =>
        ['PAID', 'PREPARING', 'COMPLETED'].includes(String(o.status || '').toUpperCase()) &&
        (o.razorpay_payment_id || o.captured_amount_paise !== undefined && o.captured_amount_paise !== null)
    ).length;
  }

  const { whereSql, params } = buildSqlFilter('o', options);
  const row = await db.get(
    `SELECT COUNT(*) as count
     FROM orders o
     WHERE o.status IN ('PAID', 'PREPARING', 'COMPLETED')
       AND (o.razorpay_payment_id IS NOT NULL OR o.captured_amount_paise IS NOT NULL)
       ${whereSql}`,
    params
  );
  return Number(row?.count || 0);
}

/**
 * 5. Pending and failed payment counts.
 */
export async function getPaymentCounts(
  db: any,
  options?: AnalyticsScopeOptions
): Promise<{ pending: number; failed: number }> {
  if (shouldRunFirestore(options)) {
    const orders = await queryFirestoreOrders(options);
    let pending = 0;
    let failed = 0;
    for (const o of orders) {
      const status = String(o.status || '').toUpperCase();
      if (status === 'PENDING') pending++;
      else if (status === 'FAILED') failed++;
    }
    return { pending, failed };
  }

  const { whereSql, params } = buildSqlFilter('o', options);
  const row = await db.get(
    `SELECT
       COUNT(CASE WHEN o.status = 'PENDING' THEN 1 END) as pending_count,
       COUNT(CASE WHEN o.status = 'FAILED' THEN 1 END) as failed_count
     FROM orders o
     WHERE 1=1 ${whereSql}`,
    params
  );
  return {
    pending: Number(row?.pending_count || 0),
    failed: Number(row?.failed_count || 0)
  };
}

/**
 * 6. Dispensed orders count (Successful beverage pours).
 * Checks dispense_status IN ('DISPENSED', 'COMPLETED') or order.dispensed = 1 on paid orders.
 */
export async function getDispensedOrderCount(
  db: any,
  options?: AnalyticsScopeOptions
): Promise<number> {
  if (shouldRunFirestore(options)) {
    const orders = await queryFirestoreOrders(options);
    return orders.filter((o) => {
      const isPaid =
        ['PAID', 'PREPARING', 'COMPLETED'].includes(String(o.status || '').toUpperCase()) &&
        (o.razorpay_payment_id || o.captured_amount_paise !== undefined && o.captured_amount_paise !== null);
      const isDispensed =
        ['DISPENSED', 'COMPLETED'].includes(String(o.dispense_status || '').toUpperCase()) ||
        o.dispensed === 1 ||
        o.dispensed === true;
      return isPaid && isDispensed;
    }).length;
  }

  const { whereSql, params } = buildSqlFilter('o', options);
  const row = await db.get(
    `SELECT COUNT(*) as count
     FROM orders o
     WHERE o.status IN ('PAID', 'PREPARING', 'COMPLETED')
       AND (o.razorpay_payment_id IS NOT NULL OR o.captured_amount_paise IS NOT NULL)
       AND o.dispense_status IN ('DISPENSED', 'COMPLETED')
       ${whereSql}`,
    params
  );
  return Number(row?.count || 0);
}

/**
 * 7. Failed dispensing count on paid orders.
 */
export async function getFailedDispensingCount(
  db: any,
  options?: AnalyticsScopeOptions
): Promise<number> {
  if (shouldRunFirestore(options)) {
    const orders = await queryFirestoreOrders(options);
    return orders.filter((o) => {
      const isPaid =
        ['PAID', 'PREPARING', 'COMPLETED'].includes(String(o.status || '').toUpperCase()) &&
        (o.razorpay_payment_id || o.captured_amount_paise !== undefined && o.captured_amount_paise !== null);
      return isPaid && String(o.dispense_status || '').toUpperCase() === 'FAILED';
    }).length;
  }

  const { whereSql, params } = buildSqlFilter('o', options);
  const row = await db.get(
    `SELECT COUNT(*) as count
     FROM orders o
     WHERE o.status IN ('PAID', 'PREPARING', 'COMPLETED')
       AND o.dispense_status = 'FAILED'
       ${whereSql}`,
    params
  );
  return Number(row?.count || 0);
}

/**
 * 8. In-flight dispensing count on paid orders.
 */
export async function getInFlightDispensingCount(
  db: any,
  options?: AnalyticsScopeOptions
): Promise<number> {
  if (shouldRunFirestore(options)) {
    const orders = await queryFirestoreOrders(options);
    return orders.filter((o) => {
      const isPaid =
        ['PAID', 'PREPARING', 'COMPLETED'].includes(String(o.status || '').toUpperCase()) &&
        (o.razorpay_payment_id || o.captured_amount_paise !== undefined && o.captured_amount_paise !== null);
      return (
        isPaid &&
        ['QUEUED', 'DISPENSING', 'PREPARING'].includes(String(o.dispense_status || '').toUpperCase())
      );
    }).length;
  }

  const { whereSql, params } = buildSqlFilter('o', options);
  const row = await db.get(
    `SELECT COUNT(*) as count
     FROM orders o
     WHERE o.status IN ('PAID', 'PREPARING', 'COMPLETED')
       AND o.dispense_status IN ('QUEUED', 'DISPENSING', 'PREPARING')
       ${whereSql}`,
    params
  );
  return Number(row?.count || 0);
}

/**
 * 9. Average order value in INR.
 */
export async function getAverageOrderValue(
  db: any,
  options?: AnalyticsScopeOptions
): Promise<number> {
  const grossPaise = await getGrossCapturedSalesPaise(db, options);
  const count = await getPaidOrderCount(db, options);
  if (count <= 0) return 0;
  return Math.round(paiseToInr(grossPaise) / count);
}

/**
 * Comprehensive KPI Overview for Dashboard Summary Cards.
 * Financial Correctness:
 * - Net revenue is signed integer paise (Audit F-4A).
 * - refunds_exceed_period_sales signals period-level negative net revenue.
 * - over_refund_detected checks order-level integrity.
 */
export async function getAnalyticsOverview(
  db: any,
  options?: AnalyticsScopeOptions
): Promise<FinancialKPISummary> {
  if (shouldRunFirestore(options)) {
    const firestore = getFirestoreInstance()!;
    const orders = await queryFirestoreOrders(options);
    const refunds = await queryFirestoreRefunds(options);

    let grossPaise = 0;
    let paidCount = 0;
    let pendingCount = 0;
    let failedCount = 0;
    let dispensedCount = 0;
    let dispenseFailedCount = 0;
    let inFlightCount = 0;

    const ordersMap = new Map<string, any>();
    for (const o of orders) {
      if (o.id) ordersMap.set(o.id, o);
      const status = String(o.status || '').toUpperCase();
      const isPaid =
        ['PAID', 'PREPARING', 'COMPLETED'].includes(status) &&
        (o.razorpay_payment_id || (o.captured_amount_paise !== undefined && o.captured_amount_paise !== null));

      if (status === 'PENDING') pendingCount++;
      else if (status === 'FAILED') failedCount++;

      if (isPaid) {
        paidCount++;
        const captured =
          o.captured_amount_paise !== null && o.captured_amount_paise !== undefined
            ? Number(o.captured_amount_paise)
            : Math.round(Number(o.amount || 0) * 100);
        grossPaise += captured;

        const isDispensed =
          ['DISPENSED', 'COMPLETED'].includes(String(o.dispense_status || '').toUpperCase()) ||
          o.dispensed === 1 ||
          o.dispensed === true;
        if (isDispensed) dispensedCount++;
        else if (String(o.dispense_status || '').toUpperCase() === 'FAILED') dispenseFailedCount++;
        else if (['QUEUED', 'DISPENSING', 'PREPARING'].includes(String(o.dispense_status || '').toUpperCase())) {
          inFlightCount++;
        }
      }
    }

    let refundPaise = 0;
    for (const r of refunds) {
      if (String(r.status || '').toUpperCase() === 'PROCESSED') {
        refundPaise += Number(r.amount_paise || 0);
      }
    }

    // Cross-Period Over-Refund Detection (Finding A5-1)
    const overRefundDetected = await detectOverRefundInFirestore(
      firestore,
      orders,
      ordersMap,
      refunds,
      options
    );

    const netPaise = grossPaise - refundPaise;
    const aovInr = paidCount > 0 ? Math.round(paiseToInr(grossPaise) / paidCount) : 0;
    const fulfillmentRate = paidCount > 0 ? Number((dispensedCount / paidCount).toFixed(4)) : 1.0;

    return {
      gross_sales_paise: grossPaise,
      gross_sales_inr: paiseToInr(grossPaise),
      processed_refunds_paise: refundPaise,
      processed_refunds_inr: paiseToInr(refundPaise),
      net_revenue_paise: netPaise,
      net_revenue_inr: paiseToInr(netPaise),
      refunds_exceed_period_sales: refundPaise > grossPaise,
      over_refund_detected: overRefundDetected,
      paid_orders_count: paidCount,
      pending_orders_count: pendingCount,
      failed_orders_count: failedCount,
      dispensed_count: dispensedCount,
      dispense_failed_count: dispenseFailedCount,
      dispense_in_flight_count: inFlightCount,
      average_order_value_inr: aovInr,
      dispense_fulfillment_rate: fulfillmentRate
    };
  }

  const { whereSql: orderWhere, params: orderParams } = buildSqlFilter('o', options);
  const { whereSql: refundWhere, params: refundParams } = buildSqlFilter('r', options);

  // 1. Aggregations on orders table
  const orderRow = await db.get(
    `SELECT
       COUNT(CASE
         WHEN o.status IN ('PAID', 'PREPARING', 'COMPLETED')
              AND (o.razorpay_payment_id IS NOT NULL OR o.captured_amount_paise IS NOT NULL)
         THEN 1
       END) as paid_count,
       COALESCE(SUM(
         CASE
           WHEN o.status IN ('PAID', 'PREPARING', 'COMPLETED')
                AND (o.razorpay_payment_id IS NOT NULL OR o.captured_amount_paise IS NOT NULL)
           THEN COALESCE(o.captured_amount_paise, o.amount * 100)
           ELSE 0
         END
       ), 0) as gross_paise,
       COUNT(CASE WHEN o.status = 'PENDING' THEN 1 END) as pending_count,
       COUNT(CASE WHEN o.status = 'FAILED' THEN 1 END) as failed_count,
       COUNT(CASE
         WHEN o.status IN ('PAID', 'PREPARING', 'COMPLETED')
              AND o.dispense_status IN ('DISPENSED', 'COMPLETED')
         THEN 1
       END) as dispensed_count,
       COUNT(CASE
         WHEN o.status IN ('PAID', 'PREPARING', 'COMPLETED')
              AND o.dispense_status = 'FAILED'
         THEN 1
       END) as dispense_failed_count,
       COUNT(CASE
         WHEN o.status IN ('PAID', 'PREPARING', 'COMPLETED')
              AND o.dispense_status IN ('QUEUED', 'DISPENSING', 'PREPARING')
         THEN 1
       END) as in_flight_count
     FROM orders o
     WHERE 1=1 ${orderWhere}`,
    orderParams
  );

  // 2. Processed refunds from refunds table
  const refundRow = await db.get(
    `SELECT COALESCE(SUM(r.amount_paise), 0) as refund_paise
     FROM refunds r
     WHERE r.status = 'PROCESSED' ${refundWhere}`,
    refundParams
  );

  // 3. Cross-Period Over-Refund Corruption Check (Finding A5-1)
  const overRefundDetected = await detectOverRefundInSqlite(
    db,
    orderWhere,
    orderParams,
    refundWhere,
    refundParams,
    options
  );

  const grossPaise = Number(orderRow?.gross_paise || 0);
  const refundPaise = Number(refundRow?.refund_paise || 0);
  const netPaise = grossPaise - refundPaise; // Signed integer paise
  const paidCount = Number(orderRow?.paid_count || 0);
  const dispensedCount = Number(orderRow?.dispensed_count || 0);

  const aovInr = paidCount > 0 ? Math.round(paiseToInr(grossPaise) / paidCount) : 0;
  const fulfillmentRate = paidCount > 0 ? Number((dispensedCount / paidCount).toFixed(4)) : 1.0;

  return {
    gross_sales_paise: grossPaise,
    gross_sales_inr: paiseToInr(grossPaise),
    processed_refunds_paise: refundPaise,
    processed_refunds_inr: paiseToInr(refundPaise),
    net_revenue_paise: netPaise,
    net_revenue_inr: paiseToInr(netPaise),
    refunds_exceed_period_sales: refundPaise > grossPaise,
    over_refund_detected: overRefundDetected,
    paid_orders_count: paidCount,
    pending_orders_count: Number(orderRow?.pending_count || 0),
    failed_orders_count: Number(orderRow?.failed_count || 0),
    dispensed_count: dispensedCount,
    dispense_failed_count: Number(orderRow?.dispense_failed_count || 0),
    dispense_in_flight_count: Number(orderRow?.in_flight_count || 0),
    average_order_value_inr: aovInr,
    dispense_fulfillment_rate: fulfillmentRate
  };
}

/**
 * 10. Machine-wise revenue and performance breakdown.
 */
export async function getMachineRevenueAnalytics(
  db: any,
  options?: AnalyticsScopeOptions
): Promise<MachineAnalyticsItem[]> {
  if (shouldRunFirestore(options)) {
    const machines = await queryFirestoreMachines(options);
    const orders = await queryFirestoreOrders(options);
    const refunds = await queryFirestoreRefunds(options);

    const orderMap = new Map<string, any>();
    for (const o of orders) {
      const mId = o.machine_id;
      if (!orderMap.has(mId)) {
        orderMap.set(mId, { paid_count: 0, gross_paise: 0, dispensed_count: 0, dispense_failed_count: 0 });
      }
      const entry = orderMap.get(mId)!;
      const isPaid =
        ['PAID', 'PREPARING', 'COMPLETED'].includes(String(o.status || '').toUpperCase()) &&
        (o.razorpay_payment_id || o.captured_amount_paise !== undefined && o.captured_amount_paise !== null);

      if (isPaid) {
        entry.paid_count++;
        entry.gross_paise +=
          o.captured_amount_paise !== null && o.captured_amount_paise !== undefined
            ? Number(o.captured_amount_paise)
            : Math.round(Number(o.amount || 0) * 100);
        const isDispensed =
          ['DISPENSED', 'COMPLETED'].includes(String(o.dispense_status || '').toUpperCase()) ||
          o.dispensed === 1 ||
          o.dispensed === true;
        if (isDispensed) entry.dispensed_count++;
        else if (String(o.dispense_status || '').toUpperCase() === 'FAILED') entry.dispense_failed_count++;
      }
    }

    const refundMap = new Map<string, number>();
    for (const r of refunds) {
      if (String(r.status || '').toUpperCase() === 'PROCESSED') {
        const mId = r.machine_id;
        refundMap.set(mId, (refundMap.get(mId) || 0) + Number(r.amount_paise || 0));
      }
    }

    const results: MachineAnalyticsItem[] = [];
    for (const m of machines) {
      const o = orderMap.get(m.id);
      const grossPaise = Number(o?.gross_paise || 0);
      const refundPaise = Number(refundMap.get(m.id) || 0);
      const netPaise = grossPaise - refundPaise;
      const paidCount = Number(o?.paid_count || 0);
      const dispensedCount = Number(o?.dispensed_count || 0);
      const dispenseFailedCount = Number(o?.dispense_failed_count || 0);
      const fulfillmentRate = paidCount > 0 ? Number((dispensedCount / paidCount).toFixed(4)) : 1.0;

      results.push({
        machine_id: m.id,
        machine_name: m.machine_name || m.id,
        location: m.location || '—',
        owner_id: m.owner_id || null,
        gross_sales_paise: grossPaise,
        gross_sales_inr: paiseToInr(grossPaise),
        processed_refunds_paise: refundPaise,
        processed_refunds_inr: paiseToInr(refundPaise),
        net_revenue_paise: netPaise,
        net_revenue_inr: paiseToInr(netPaise),
        paid_orders_count: paidCount,
        dispensed_count: dispensedCount,
        dispense_failed_count: dispenseFailedCount,
        dispense_fulfillment_rate: fulfillmentRate
      });
    }

    return results.sort((a, b) => b.gross_sales_paise - a.gross_sales_paise);
  }

  const { whereSql: orderWhere, params: orderParams } = buildSqlFilter('o', options);
  const { whereSql: refundWhere, params: refundParams } = buildSqlFilter('r', options);

  let machineListSql = 'SELECT id, machine_name, location, owner_id FROM machines';
  const machineListParams: any[] = [];
  if (options?.machineId) {
    machineListSql += ' WHERE id = ?';
    machineListParams.push(options.machineId);
  } else if (options?.machineIds !== undefined) {
    if (options.machineIds.length === 0) {
      return [];
    }
    machineListSql += ` WHERE id IN (${options.machineIds.map(() => '?').join(', ')})`;
    machineListParams.push(...options.machineIds);
  }
  const machines = await db.all(machineListSql, machineListParams);

  const orderRows = await db.all(
    `SELECT
       o.machine_id,
       COUNT(CASE
         WHEN o.status IN ('PAID', 'PREPARING', 'COMPLETED')
              AND (o.razorpay_payment_id IS NOT NULL OR o.captured_amount_paise IS NOT NULL)
         THEN 1
       END) as paid_count,
       COALESCE(SUM(
         CASE
           WHEN o.status IN ('PAID', 'PREPARING', 'COMPLETED')
                AND (o.razorpay_payment_id IS NOT NULL OR o.captured_amount_paise IS NOT NULL)
           THEN COALESCE(o.captured_amount_paise, o.amount * 100)
           ELSE 0
         END
       ), 0) as gross_paise,
       COUNT(CASE
         WHEN o.status IN ('PAID', 'PREPARING', 'COMPLETED')
              AND o.dispense_status IN ('DISPENSED', 'COMPLETED')
         THEN 1
       END) as dispensed_count,
       COUNT(CASE
         WHEN o.status IN ('PAID', 'PREPARING', 'COMPLETED')
              AND o.dispense_status = 'FAILED'
         THEN 1
       END) as dispense_failed_count
     FROM orders o
     WHERE 1=1 ${orderWhere}
     GROUP BY o.machine_id`,
    orderParams
  );
  const orderMap = new Map<string, any>(orderRows.map((r: any) => [r.machine_id, r]));

  const refundRows = await db.all(
    `SELECT
       r.machine_id,
       COALESCE(SUM(r.amount_paise), 0) as refund_paise
     FROM refunds r
     WHERE r.status = 'PROCESSED' ${refundWhere}
     GROUP BY r.machine_id`,
    refundParams
  );
  const refundMap = new Map<string, any>(refundRows.map((r: any) => [r.machine_id, r]));

  const results: MachineAnalyticsItem[] = [];
  for (const m of machines) {
    const o = orderMap.get(m.id);
    const r = refundMap.get(m.id);

    const grossPaise = Number(o?.gross_paise || 0);
    const refundPaise = Number(r?.refund_paise || 0);
    const netPaise = grossPaise - refundPaise;
    const paidCount = Number(o?.paid_count || 0);
    const dispensedCount = Number(o?.dispensed_count || 0);
    const dispenseFailedCount = Number(o?.dispense_failed_count || 0);
    const fulfillmentRate = paidCount > 0 ? Number((dispensedCount / paidCount).toFixed(4)) : 1.0;

    results.push({
      machine_id: m.id,
      machine_name: m.machine_name || m.id,
      location: m.location || '—',
      owner_id: m.owner_id || null,
      gross_sales_paise: grossPaise,
      gross_sales_inr: paiseToInr(grossPaise),
      processed_refunds_paise: refundPaise,
      processed_refunds_inr: paiseToInr(refundPaise),
      net_revenue_paise: netPaise,
      net_revenue_inr: paiseToInr(netPaise),
      paid_orders_count: paidCount,
      dispensed_count: dispensedCount,
      dispense_failed_count: dispenseFailedCount,
      dispense_fulfillment_rate: fulfillmentRate
    });
  }

  return results.sort((a, b) => b.gross_sales_paise - a.gross_sales_paise);
}

/**
 * 11. Product-wise sales based on historical snapshots.
 */
export async function getProductSalesAnalytics(
  db: any,
  options?: AnalyticsScopeOptions
): Promise<ProductAnalyticsItem[]> {
  // Load products list from DB if available, else static catalog fallback
  let products: any[] = [];
  try {
    if (db && db.all) {
      products = await db.all('SELECT id, name, price FROM products ORDER BY id ASC');
    }
  } catch (err) {
    logger.warn('Failed to query products from DB:', err);
  }

  if (!products || products.length === 0) {
    products = [
      { id: 1, name: 'Classic Crest', price: 100 },
      { id: 2, name: 'Vanilla Velvet', price: 100 },
      { id: 3, name: 'Hazel Gold', price: 100 },
      { id: 4, name: 'Irish Emerald', price: 100 },
      { id: 5, name: 'Mocha Bliss', price: 100 }
    ];
  }
  const productMetaMap = new Map<number, any>(products.map((p: any) => [Number(p.id), p]));

  if (shouldRunFirestore(options)) {
    const orders = await queryFirestoreOrders(options);
    const refunds = await queryFirestoreRefunds(options);

    const orderById = new Map<string, any>(orders.map((o) => [o.id, o]));
    const salesMap = new Map<number, { units_sold: number; gross_paise: number }>();
    let totalGrossPaise = 0;

    for (const o of orders) {
      const isPaid =
        ['PAID', 'PREPARING', 'COMPLETED'].includes(String(o.status || '').toUpperCase()) &&
        (o.razorpay_payment_id || o.captured_amount_paise !== undefined && o.captured_amount_paise !== null);
      if (isPaid) {
        const pId = Number(o.product_id);
        if (!salesMap.has(pId)) salesMap.set(pId, { units_sold: 0, gross_paise: 0 });
        const entry = salesMap.get(pId)!;
        entry.units_sold++;
        const paise =
          o.captured_amount_paise !== null && o.captured_amount_paise !== undefined
            ? Number(o.captured_amount_paise)
            : Math.round(Number(o.amount || 0) * 100);
        entry.gross_paise += paise;
        totalGrossPaise += paise;
      }
    }

    const refundMap = new Map<number, { refunded_units: number; refunded_paise: number }>();
    for (const r of refunds) {
      if (String(r.status || '').toUpperCase() === 'PROCESSED') {
        const parentOrder = orderById.get(r.order_id);
        const pId = parentOrder ? Number(parentOrder.product_id) : 1;
        if (!refundMap.has(pId)) refundMap.set(pId, { refunded_units: 0, refunded_paise: 0 });
        const entry = refundMap.get(pId)!;
        entry.refunded_units++;
        entry.refunded_paise += Number(r.amount_paise || 0);
      }
    }

    const results: ProductAnalyticsItem[] = [];
    for (const [pId, pMeta] of productMetaMap.entries()) {
      const sale = salesMap.get(pId);
      const refund = refundMap.get(pId);
      const grossPaise = Number(sale?.gross_paise || 0);
      const unitsSold = Number(sale?.units_sold || 0);
      const refundedUnits = Number(refund?.refunded_units || 0);
      const refundedPaise = Number(refund?.refunded_paise || 0);
      const sharePercent =
        totalGrossPaise > 0 ? Number(((grossPaise / totalGrossPaise) * 100).toFixed(1)) : 0;

      results.push({
        product_id: pId,
        product_name: pMeta.name,
        units_sold: unitsSold,
        gross_sales_paise: grossPaise,
        gross_sales_inr: paiseToInr(grossPaise),
        revenue_share_percent: sharePercent,
        refunded_units: refundedUnits,
        refunded_amount_paise: refundedPaise,
        refunded_amount_inr: paiseToInr(refundedPaise)
      });
    }

    return results.sort((a, b) => b.gross_sales_paise - a.gross_sales_paise);
  }

  const { whereSql: orderWhere, params: orderParams } = buildSqlFilter('o', options);
  const { whereSql: refundWhere, params: refundParams } = buildSqlFilter('r', options);

  const salesRows = await db.all(
    `SELECT
       o.product_id,
       COUNT(*) as units_sold,
       COALESCE(SUM(COALESCE(o.captured_amount_paise, o.amount * 100)), 0) as gross_paise
     FROM orders o
     WHERE o.status IN ('PAID', 'PREPARING', 'COMPLETED')
       AND (o.razorpay_payment_id IS NOT NULL OR o.captured_amount_paise IS NOT NULL)
       ${orderWhere}
     GROUP BY o.product_id`,
    orderParams
  );

  const totalGrossPaise = salesRows.reduce(
    (sum: number, r: any) => sum + Number(r.gross_paise || 0),
    0
  );

  const refundRows = await db.all(
    `SELECT
       o.product_id,
       COUNT(r.id) as refunded_units,
       COALESCE(SUM(r.amount_paise), 0) as refunded_paise
     FROM refunds r
     JOIN orders o ON r.order_id = o.id
     WHERE r.status = 'PROCESSED' ${refundWhere}
     GROUP BY o.product_id`,
    refundParams
  );
  const refundMap = new Map<number, any>(
    refundRows.map((r: any) => [Number(r.product_id), r])
  );
  const salesMap = new Map<number, any>(
    salesRows.map((r: any) => [Number(r.product_id), r])
  );

  const results: ProductAnalyticsItem[] = [];
  for (const [pId, pMeta] of productMetaMap.entries()) {
    const sale = salesMap.get(pId);
    const refund = refundMap.get(pId);

    const grossPaise = Number(sale?.gross_paise || 0);
    const unitsSold = Number(sale?.units_sold || 0);
    const refundedUnits = Number(refund?.refunded_units || 0);
    const refundedPaise = Number(refund?.refunded_paise || 0);
    const sharePercent =
      totalGrossPaise > 0 ? Number(((grossPaise / totalGrossPaise) * 100).toFixed(1)) : 0;

    results.push({
      product_id: pId,
      product_name: pMeta.name,
      units_sold: unitsSold,
      gross_sales_paise: grossPaise,
      gross_sales_inr: paiseToInr(grossPaise),
      revenue_share_percent: sharePercent,
      refunded_units: refundedUnits,
      refunded_amount_paise: refundedPaise,
      refunded_amount_inr: paiseToInr(refundedPaise)
    });
  }

  return results.sort((a, b) => b.gross_sales_paise - a.gross_sales_paise);
}

/**
 * 12. Ingredient consumption (movement_type = 'DEDUCTION') from inventory_ledger.
 */
export async function getIngredientConsumption(
  db: any,
  options?: AnalyticsScopeOptions
): Promise<Record<string, number>> {
  if (shouldRunFirestore(options)) {
    const ledger = await queryFirestoreInventoryLedger(options);
    const result: Record<string, number> = {};
    for (const l of ledger) {
      if (l.movement_type === 'DEDUCTION') {
        result[l.ingredient] = (result[l.ingredient] || 0) + Number(l.quantity || 0);
      }
    }
    return result;
  }

  const { whereSql, params } = buildSqlFilter('l', options);
  const rows = await db.all(
    `SELECT l.ingredient, COALESCE(SUM(l.quantity), 0) as total_qty
     FROM inventory_ledger l
     WHERE l.movement_type = 'DEDUCTION' ${whereSql}
     GROUP BY l.ingredient`,
    params
  );

  const result: Record<string, number> = {};
  for (const r of rows) {
    result[r.ingredient] = Number(r.total_qty || 0);
  }
  return result;
}

/**
 * 13. Inventory refill quantities (movement_type = 'REFILL') from inventory_ledger.
 */
export async function getInventoryRefillQuantities(
  db: any,
  options?: AnalyticsScopeOptions
): Promise<Record<string, number>> {
  if (shouldRunFirestore(options)) {
    const ledger = await queryFirestoreInventoryLedger(options);
    const result: Record<string, number> = {};
    for (const l of ledger) {
      if (l.movement_type === 'REFILL') {
        result[l.ingredient] = (result[l.ingredient] || 0) + Number(l.quantity || 0);
      }
    }
    return result;
  }

  const { whereSql, params } = buildSqlFilter('l', options);
  const rows = await db.all(
    `SELECT l.ingredient, COALESCE(SUM(l.quantity), 0) as total_qty
     FROM inventory_ledger l
     WHERE l.movement_type = 'REFILL' ${whereSql}
     GROUP BY l.ingredient`,
    params
  );

  const result: Record<string, number> = {};
  for (const r of rows) {
    result[r.ingredient] = Number(r.total_qty || 0);
  }
  return result;
}

/**
 * 14. Waste and adjustments from inventory_ledger.
 */
export async function getWasteAndAdjustments(
  db: any,
  options?: AnalyticsScopeOptions
): Promise<{ waste: Record<string, number>; adjustments: Record<string, number> }> {
  if (shouldRunFirestore(options)) {
    const ledger = await queryFirestoreInventoryLedger(options);
    const waste: Record<string, number> = {};
    const adjustments: Record<string, number> = {};
    for (const l of ledger) {
      if (l.movement_type === 'WASTE') {
        waste[l.ingredient] = (waste[l.ingredient] || 0) + Number(l.quantity || 0);
      } else if (l.movement_type === 'ADJUSTMENT') {
        adjustments[l.ingredient] = (adjustments[l.ingredient] || 0) + Number(l.quantity || 0);
      }
    }
    return { waste, adjustments };
  }

  const { whereSql, params } = buildSqlFilter('l', options);
  const rows = await db.all(
    `SELECT l.ingredient, l.movement_type, COALESCE(SUM(l.quantity), 0) as total_qty
     FROM inventory_ledger l
     WHERE l.movement_type IN ('WASTE', 'ADJUSTMENT') ${whereSql}
     GROUP BY l.ingredient, l.movement_type`,
    params
  );

  const waste: Record<string, number> = {};
  const adjustments: Record<string, number> = {};

  for (const r of rows) {
    if (r.movement_type === 'WASTE') {
      waste[r.ingredient] = Number(r.total_qty || 0);
    } else if (r.movement_type === 'ADJUSTMENT') {
      adjustments[r.ingredient] = Number(r.total_qty || 0);
    }
  }

  return { waste, adjustments };
}

/**
 * Comprehensive inventory movement analytics per ingredient.
 * Calculates recorded software balance across authorized machine(s) without hardcoded values (Finding A8-1).
 */
export async function getInventoryAnalytics(
  db: any,
  options?: AnalyticsScopeOptions
): Promise<InventoryMovementAnalytics[]> {
  const validIngredients = ['milk', 'coffee', 'vanilla', 'hazelnut', 'irish', 'mocha', 'water'];
  const consumption = await getIngredientConsumption(db, options);
  const refills = await getInventoryRefillQuantities(db, options);
  const { waste, adjustments } = await getWasteAndAdjustments(db, options);

  const balances: Record<string, number | null> = {};
  for (const ing of validIngredients) {
    balances[ing] = null;
  }
  let inventorySource: string = 'software_estimated';

  if (shouldRunFirestore(options)) {
    const firestore = getFirestoreInstance();
    if (firestore) {
      if (options?.machineId) {
        // Single machine query
        const mDoc = await firestore.collection('machines').doc(options.machineId).get();
        if (mDoc.exists) {
          const data = mDoc.data() || {};
          const inv = data.estimated_inventory || data.inventory || {};
          inventorySource = data.inventory_source || 'software_estimated';
          for (const ing of validIngredients) {
            const level = inv[`${ing}_level`] ?? inv[ing];
            if (level !== undefined && level !== null && !isNaN(Number(level))) {
              balances[ing] = Math.max(0, Number(level));
            }
          }
        }
      } else if (options?.machineIds !== undefined) {
        // Owner scoped machines
        if (options.machineIds.length === 0) {
          for (const ing of validIngredients) {
            balances[ing] = 0;
          }
        } else {
          const machines = await queryFirestoreMachines(options);
          const hasRecord: Record<string, boolean> = {};
          for (const m of machines) {
            const inv = m.estimated_inventory || m.inventory || {};
            for (const ing of validIngredients) {
              const level = inv[`${ing}_level`] ?? inv[ing];
              if (level !== undefined && level !== null && !isNaN(Number(level))) {
                balances[ing] = (balances[ing] ?? 0) + Math.max(0, Number(level));
                hasRecord[ing] = true;
              }
            }
          }
          for (const ing of validIngredients) {
            if (!hasRecord[ing]) balances[ing] = null;
          }
        }
      } else {
        // Super Admin fleet-wide query
        const machines = await queryFirestoreMachines();
        const hasRecord: Record<string, boolean> = {};
        for (const m of machines) {
          const inv = m.estimated_inventory || m.inventory || {};
          for (const ing of validIngredients) {
            const level = inv[`${ing}_level`] ?? inv[ing];
            if (level !== undefined && level !== null && !isNaN(Number(level))) {
              balances[ing] = (balances[ing] ?? 0) + Math.max(0, Number(level));
              hasRecord[ing] = true;
            }
          }
        }
        for (const ing of validIngredients) {
          if (!hasRecord[ing]) balances[ing] = null;
        }
      }
    }
  } else if (db && db.get) {
    if (options?.machineId) {
      // Single machine query
      const inv = await db.get('SELECT * FROM inventory WHERE machine_id = ?', [options.machineId]);
      if (inv) {
        for (const ing of validIngredients) {
          const level = inv[`${ing}_level`];
          if (level !== undefined && level !== null && !isNaN(Number(level))) {
            balances[ing] = Math.max(0, Number(level));
          }
        }
      }
    } else if (options?.machineIds !== undefined) {
      // Owner scoped machines
      if (options.machineIds.length === 0) {
        for (const ing of validIngredients) {
          balances[ing] = 0;
        }
      } else {
        const placeholders = options.machineIds.map(() => '?').join(', ');
        const rows = await db.all(
          `SELECT * FROM inventory WHERE machine_id IN (${placeholders})`,
          options.machineIds
        );
        const hasRecord: Record<string, boolean> = {};
        for (const r of rows) {
          for (const ing of validIngredients) {
            const level = r[`${ing}_level`];
            if (level !== undefined && level !== null && !isNaN(Number(level))) {
              balances[ing] = (balances[ing] ?? 0) + Math.max(0, Number(level));
              hasRecord[ing] = true;
            }
          }
        }
        for (const ing of validIngredients) {
          if (!hasRecord[ing]) balances[ing] = null;
        }
      }
    } else {
      // Super Admin fleet-wide query
      const rows = await db.all('SELECT * FROM inventory');
      const hasRecord: Record<string, boolean> = {};
      for (const r of rows) {
        for (const ing of validIngredients) {
          const level = r[`${ing}_level`];
          if (level !== undefined && level !== null && !isNaN(Number(level))) {
            balances[ing] = (balances[ing] ?? 0) + Math.max(0, Number(level));
            hasRecord[ing] = true;
          }
        }
      }
      for (const ing of validIngredients) {
        if (!hasRecord[ing]) balances[ing] = null;
      }
    }
  }

  return validIngredients.map((ing) => ({
    ingredient: ing,
    total_consumed: consumption[ing] || 0,
    total_refilled: refills[ing] || 0,
    total_waste: waste[ing] || 0,
    total_adjustments: adjustments[ing] || 0,
    current_balance: balances[ing],
    inventory_source: balances[ing] !== null ? inventorySource : null
  }));
}

/**
 * Time-series analytics with timezone bucketing in Asia/Kolkata.
 * Net revenue is signed integer paise without clamping.
 */
export async function getTimeSeriesAnalytics(
  db: any,
  options?: AnalyticsScopeOptions & { interval?: TimeSeriesInterval }
): Promise<TimeSeriesBucket[]> {
  const timeZone = options?.timeframe?.timeZone || 'Asia/Kolkata';
  const interval = options?.interval || 'day';

  let orders: any[] = [];
  let refunds: any[] = [];

  if (shouldRunFirestore(options)) {
    orders = await queryFirestoreOrders(options);
    refunds = await queryFirestoreRefunds(options);
  } else {
    const { whereSql: orderWhere, params: orderParams } = buildSqlFilter('o', options);
    const { whereSql: refundWhere, params: refundParams } = buildSqlFilter('r', options);

    orders = await db.all(
      `SELECT
         o.id,
         o.status,
         o.dispense_status,
         o.captured_amount_paise,
         o.amount,
         o.razorpay_payment_id,
         o.created_at
       FROM orders o
       WHERE 1=1 ${orderWhere}
       ORDER BY o.created_at ASC`,
      orderParams
    );

    refunds = await db.all(
      `SELECT
         r.id,
         r.amount_paise,
         r.status,
         r.created_at
       FROM refunds r
       WHERE r.status = 'PROCESSED' ${refundWhere}
       ORDER BY r.created_at ASC`,
      refundParams
    );
  }

  const bucketMap = new Map<
    string,
    {
      key: string;
      label: string;
      gross_paise: number;
      refund_paise: number;
      paid_count: number;
      dispensed_count: number;
      failed_dispenses: number;
    }
  >();

  for (const o of orders) {
    const isPaid =
      ['PAID', 'PREPARING', 'COMPLETED'].includes(String(o.status || '').toUpperCase()) &&
      (o.razorpay_payment_id || o.captured_amount_paise !== undefined && o.captured_amount_paise !== null);

    if (!isPaid) continue;

    const { key, label } = resolveTimeSeriesBucket(o.created_at, interval, timeZone);

    if (!bucketMap.has(key)) {
      bucketMap.set(key, {
        key,
        label,
        gross_paise: 0,
        refund_paise: 0,
        paid_count: 0,
        dispensed_count: 0,
        failed_dispenses: 0
      });
    }

    const b = bucketMap.get(key)!;
    b.paid_count += 1;
    const grossOrderPaise =
      o.captured_amount_paise !== null && o.captured_amount_paise !== undefined
        ? Number(o.captured_amount_paise)
        : Math.round(Number(o.amount || 0) * 100);
    b.gross_paise += grossOrderPaise;

    const isDispensed =
      ['DISPENSED', 'COMPLETED'].includes(String(o.dispense_status || '').toUpperCase()) ||
      o.dispensed === 1 ||
      o.dispensed === true;
    if (isDispensed) {
      b.dispensed_count += 1;
    } else if (String(o.dispense_status || '').toUpperCase() === 'FAILED') {
      b.failed_dispenses += 1;
    }
  }

  for (const r of refunds) {
    if (String(r.status || '').toUpperCase() !== 'PROCESSED') continue;

    const { key, label } = resolveTimeSeriesBucket(r.created_at, interval, timeZone);

    if (!bucketMap.has(key)) {
      bucketMap.set(key, {
        key,
        label,
        gross_paise: 0,
        refund_paise: 0,
        paid_count: 0,
        dispensed_count: 0,
        failed_dispenses: 0
      });
    }

    const b = bucketMap.get(key)!;
    b.refund_paise += Number(r.amount_paise || 0);
  }

  const sortedBuckets = Array.from(bucketMap.values()).sort((a, b) =>
    a.key.localeCompare(b.key)
  );

  return sortedBuckets.map((b) => {
    const netPaise = b.gross_paise - b.refund_paise; // Signed integer paise
    return {
      bucket_key: b.key,
      label: b.label,
      gross_sales_paise: b.gross_paise,
      gross_sales_inr: paiseToInr(b.gross_paise),
      processed_refunds_paise: b.refund_paise,
      processed_refunds_inr: paiseToInr(b.refund_paise),
      net_revenue_paise: netPaise,
      net_revenue_inr: paiseToInr(netPaise),
      paid_orders_count: b.paid_count,
      dispensed_orders_count: b.dispensed_count,
      failed_dispenses_count: b.failed_dispenses
    };
  });
}

/**
 * Detects cross-period over-refunds in Firestore across root /refunds collection
 * without double-counting nested machine/order refund subcollections.
 */
async function detectOverRefundInFirestore(
  firestore: FirebaseFirestore.Firestore,
  orders: any[],
  ordersMap: Map<string, any>,
  refunds: any[],
  options?: AnalyticsScopeOptions
): Promise<boolean> {
  if (options?.machineIds !== undefined && options.machineIds.length === 0) {
    return false;
  }

  const candidateOrderIds = new Set<string>();
  for (const o of orders) {
    if (o.id) candidateOrderIds.add(o.id);
  }
  for (const r of refunds) {
    if (r.order_id) candidateOrderIds.add(r.order_id);
  }

  for (const orderId of candidateOrderIds) {
    let orderDoc = ordersMap.get(orderId);
    if (!orderDoc) {
      const oSnap = await firestore.collection('orders').doc(orderId).get();
      if (!oSnap.exists) continue;
      orderDoc = { ...oSnap.data(), id: oSnap.id };
    }

    if (options?.machineId && orderDoc.machine_id !== options.machineId) {
      continue;
    }
    if (options?.machineIds !== undefined && !options.machineIds.includes(orderDoc.machine_id)) {
      continue;
    }

    const captured =
      orderDoc.captured_amount_paise !== null && orderDoc.captured_amount_paise !== undefined
        ? Number(orderDoc.captured_amount_paise)
        : Math.round(Number(orderDoc.amount || 0) * 100);

    const allRefundsSnap = await firestore
      .collection('refunds')
      .where('order_id', '==', orderId)
      .where('status', '==', 'PROCESSED')
      .get();

    const cumulativeProcessedRefunds = allRefundsSnap.docs.reduce(
      (sum, d) => sum + Number(d.data().amount_paise || 0),
      0
    );

    const maxRefunded = Math.max(
      cumulativeProcessedRefunds,
      Number(orderDoc.total_refunded_amount_paise || 0)
    );

    if (maxRefunded > captured) {
      return true;
    }
  }

  return false;
}

/**
 * Detects cross-period over-refunds in SQLite including orders created prior to the reporting window.
 */
async function detectOverRefundInSqlite(
  db: any,
  orderWhere: string,
  orderParams: any[],
  refundWhere: string,
  refundParams: any[],
  options?: AnalyticsScopeOptions
): Promise<boolean> {
  if (options?.machineIds !== undefined && options.machineIds.length === 0) {
    return false;
  }

  const periodRefundOrders = await db.all(
    `SELECT DISTINCT r.order_id
     FROM refunds r
     WHERE 1=1 ${refundWhere}`,
    refundParams
  );

  const candidateOrderIds = new Set<string>();
  for (const r of periodRefundOrders) {
    if (r.order_id) candidateOrderIds.add(r.order_id);
  }

  let machineScopeSql = '';
  const machineScopeParams: any[] = [];
  if (options?.machineId) {
    machineScopeSql = ' AND o.machine_id = ?';
    machineScopeParams.push(options.machineId);
  } else if (options?.machineIds !== undefined) {
    if (options.machineIds.length === 1) {
      machineScopeSql = ' AND o.machine_id = ?';
      machineScopeParams.push(options.machineIds[0]);
    } else {
      const placeholders = options.machineIds.map(() => '?').join(', ');
      machineScopeSql = ` AND o.machine_id IN (${placeholders})`;
      machineScopeParams.push(...options.machineIds);
    }
  }

  const candidateArray = Array.from(candidateOrderIds);
  const candidatePlaceholders = candidateArray.map(() => '?').join(', ');

  const candidateQuery = `
    SELECT o.id,
           COALESCE(o.captured_amount_paise, o.amount * 100) as captured_paise,
           COALESCE(o.total_refunded_amount_paise, 0) as order_total_refunded_paise,
           (
             SELECT COALESCE(SUM(r_all.amount_paise), 0)
             FROM refunds r_all
             WHERE r_all.order_id = o.id AND r_all.status = 'PROCESSED'
           ) as cumulative_processed_refunds
    FROM orders o
    WHERE (
      (1=1 ${orderWhere})
      ${candidateArray.length > 0 ? `OR o.id IN (${candidatePlaceholders})` : ''}
    )
    ${machineScopeSql}
  `;

  const candidateParams = [
    ...orderParams,
    ...(candidateArray.length > 0 ? candidateArray : []),
    ...machineScopeParams
  ];

  const candidates = await db.all(candidateQuery, candidateParams);
  for (const c of candidates) {
    const maxRefunded = Math.max(
      Number(c.order_total_refunded_paise || 0),
      Number(c.cumulative_processed_refunds || 0)
    );
    if (maxRefunded > Number(c.captured_paise || 0)) {
      return true;
    }
  }

  return false;
}

/**
 * 15. Refunds Analytics for GET /api/analytics/refunds.
 * Provides refund aggregates, reasons breakdown, and customer-safe recent records.
 */
export async function getRefundsAnalytics(
  db: any,
  options?: AnalyticsScopeOptions
): Promise<RefundsAnalyticsResult> {
  let refunds: any[] = [];
  let orders: any[] = [];
  let overRefundDetected = false;

  if (shouldRunFirestore(options)) {
    const firestore = getFirestoreInstance()!;
    refunds = await queryFirestoreRefunds(options);
    orders = await queryFirestoreOrders(options);
    const ordersMap = new Map<string, any>();
    for (const o of orders) {
      if (o.id) ordersMap.set(o.id, o);
    }
    overRefundDetected = await detectOverRefundInFirestore(
      firestore,
      orders,
      ordersMap,
      refunds,
      options
    );
  } else {
    const { whereSql: refundWhere, params: refundParams } = buildSqlFilter('r', options);
    const { whereSql: orderWhere, params: orderParams } = buildSqlFilter('o', options);

    refunds = await db.all(
      `SELECT r.id, r.order_id, r.machine_id, r.amount_paise, r.status, r.reason, r.source, r.created_at, r.updated_at
       FROM refunds r
       WHERE 1=1 ${refundWhere}
       ORDER BY r.created_at DESC`,
      refundParams
    );

    orders = await db.all(
      `SELECT o.id, o.machine_id, o.amount, o.captured_amount_paise, o.total_refunded_amount_paise, o.status, o.razorpay_payment_id
       FROM orders o
       WHERE 1=1 ${orderWhere}`,
      orderParams
    );

    overRefundDetected = await detectOverRefundInSqlite(
      db,
      orderWhere,
      orderParams,
      refundWhere,
      refundParams,
      options
    );
  }

  let processedCount = 0;
  let processedPaise = 0;
  let pendingCount = 0;
  let pendingPaise = 0;
  let failedCount = 0;
  let failedPaise = 0;
  const reasonMap: Record<string, number> = {};

  for (const r of refunds) {
    const status = String(r.status || '').toUpperCase();
    const amount = Number(r.amount_paise || 0);
    const reason = String(r.reason || 'UNSPECIFIED');

    reasonMap[reason] = (reasonMap[reason] || 0) + 1;

    if (status === 'PROCESSED') {
      processedCount++;
      processedPaise += amount;
    } else if (status === 'PENDING') {
      pendingCount++;
      pendingPaise += amount;
    } else if (status === 'FAILED') {
      failedCount++;
      failedPaise += amount;
    }
  }

  let grossPaise = 0;

  for (const o of orders) {
    const status = String(o.status || '').toUpperCase();
    const hasCapturedAmount =
      o.captured_amount_paise !== undefined && o.captured_amount_paise !== null;
    const isPaid =
      ['PAID', 'PREPARING', 'COMPLETED'].includes(status) &&
      (Boolean(o.razorpay_payment_id) || hasCapturedAmount);
    if (isPaid) {
      const cap = hasCapturedAmount
        ? Number(o.captured_amount_paise)
        : Math.round(Number(o.amount || 0) * 100);
      grossPaise += cap;
    }
  }

  const safeRecentRefunds: RefundItemSummary[] = refunds.slice(0, 50).map((r) => ({
    id: String(r.id),
    order_id: String(r.order_id),
    machine_id: String(r.machine_id),
    amount_paise: Number(r.amount_paise || 0),
    amount_inr: paiseToInr(Number(r.amount_paise || 0)),
    status: String(r.status),
    reason: String(r.reason || 'UNSPECIFIED'),
    source: String(r.source || 'SUPER_ADMIN_PORTAL'),
    created_at: String(r.created_at),
    updated_at: r.updated_at ? String(r.updated_at) : undefined
  }));

  return {
    total_refunds_count: refunds.length,
    processed_refunds_count: processedCount,
    processed_refunds_paise: processedPaise,
    processed_refunds_inr: paiseToInr(processedPaise),
    pending_refunds_count: pendingCount,
    pending_refunds_paise: pendingPaise,
    pending_refunds_inr: paiseToInr(pendingPaise),
    failed_refunds_count: failedCount,
    failed_refunds_paise: failedPaise,
    failed_refunds_inr: paiseToInr(failedPaise),
    refunds_exceed_period_sales: processedPaise > grossPaise,
    over_refund_detected: overRefundDetected,
    refund_reasons: reasonMap,
    recent_refunds: safeRecentRefunds
  };
}
