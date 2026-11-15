/**
 * Currency, Date/Time, Heartbeat, and Historical Sales Analytics Utilities
 * ------------------------------------------------------------------------
 * All revenue and sales report calculations strictly use the stored historical
 * `order.amount` recorded at purchase time, never recalculating from current product prices.
 */

const inrFormatter = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  maximumFractionDigits: 0
});

export function formatINR(amount) {
  const num = Number(amount);
  if (Number.isNaN(num)) return '₹0';
  return inrFormatter.format(num);
}

export function formatSignedINR(amount) {
  const num = Number(amount);
  if (Number.isNaN(num) || num === 0) return '₹0';
  if (num < 0) {
    return `-${inrFormatter.format(Math.abs(num))}`;
  }
  return inrFormatter.format(num);
}

export function formatPaise(paise) {
  const num = Number(paise);
  if (Number.isNaN(num) || num <= 0) return '₹0';
  return formatINR(Math.round(num / 100));
}

export function formatSignedPaise(paise) {
  const num = Number(paise);
  if (Number.isNaN(num) || num === 0) return '₹0';
  return formatSignedINR(Math.round(num / 100));
}

export function getKolkataDateString(d = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(d);
  const year = parts.find((p) => p.type === 'year')?.value;
  const month = parts.find((p) => p.type === 'month')?.value;
  const day = parts.find((p) => p.type === 'day')?.value;
  return `${year}-${month}-${day}`;
}

export function getKolkataDaysAgo(daysAgo) {
  const now = new Date();
  const d = new Date(now.getTime() - daysAgo * 24 * 60 * 60 * 1000);
  return getKolkataDateString(d);
}

export function getKolkataMonthStart() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit'
  }).formatToParts(new Date());
  const year = parts.find((p) => p.type === 'year')?.value;
  const month = parts.find((p) => p.type === 'month')?.value;
  return `${year}-${month}-01`;
}

export function validateDateRange(startDate, endDate) {
  if (!startDate && !endDate) return { valid: true };
  if (startDate && !/^\d{4}-\d{2}-\d{2}$/.test(startDate)) {
    return { valid: false, error: 'Start date must be in YYYY-MM-DD format' };
  }
  if (endDate && !/^\d{4}-\d{2}-\d{2}$/.test(endDate)) {
    return { valid: false, error: 'End date must be in YYYY-MM-DD format' };
  }
  if (startDate && endDate) {
    const s = new Date(`${startDate}T00:00:00+05:30`).getTime();
    const e = new Date(`${endDate}T23:59:59+05:30`).getTime();
    if (s > e) {
      return { valid: false, error: 'Start date cannot be after end date' };
    }
    const diffDays = (e - s) / (1000 * 60 * 60 * 24);
    if (diffDays > 366) {
      return { valid: false, error: 'Reporting period cannot exceed 366 days' };
    }
  }
  return { valid: true };
}

export function formatDateTime(isoString) {
  if (!isoString) return '—';
  const parsed = new Date(isoString);
  if (Number.isNaN(parsed.getTime())) return '—';
  return parsed.toLocaleString('en-IN', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true
  });
}

export function formatShortDate(isoString) {
  if (!isoString) return '—';
  const parsed = new Date(isoString);
  if (Number.isNaN(parsed.getTime())) return '—';
  return parsed.toLocaleDateString('en-IN', {
    day: '2-digit',
    month: 'short'
  });
}

export function formatRelativeHeartbeat(lastSeenIso, nowMs = Date.now()) {
  if (!lastSeenIso || typeof lastSeenIso !== 'string' || !lastSeenIso.trim()) {
    return 'No heartbeat recorded yet';
  }
  const parsedMs = Date.parse(lastSeenIso);
  if (Number.isNaN(parsedMs)) {
    return 'No heartbeat recorded yet';
  }
  const diffSec = Math.max(0, Math.floor((nowMs - parsedMs) / 1000));
  if (diffSec < 5) return 'Just now';
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ${diffSec % 60}s ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ${diffMin % 60}m ago`;
  const diffDays = Math.floor(diffHr / 24);
  return `${diffDays}d ago`;
}

export const REVENUE_ELIGIBLE_STATUSES = new Set(['PAID', 'PREPARING', 'COMPLETED']);

export function hasValidOrderMachine(order) {
  if (!order || order.is_malformed) return false;
  const rawMachineId = order.machine_id !== undefined && order.machine_id !== null
    ? String(order.machine_id).trim()
    : '';
  if (!rawMachineId) return false;
  const lower = rawMachineId.toLowerCase();
  return lower !== 'undefined' && lower !== 'null';
}

export function hasVerifiedGatewayPayment(order) {
  if (!order) return false;
  if (order.razorpay_payment_id) return true;
  return (
    order.captured_amount_paise !== undefined &&
    order.captured_amount_paise !== null &&
    Number(order.captured_amount_paise) > 0
  );
}

export function isRevenueOrder(order) {
  if (!order) return false;
  if (!hasValidOrderMachine(order)) return false;
  if (!REVENUE_ELIGIBLE_STATUSES.has(String(order.status || '').toUpperCase())) {
    return false;
  }
  return hasVerifiedGatewayPayment(order);
}

export function getOrderGrossPaise(order) {
  if (!order) return 0;
  if (order.captured_amount_paise !== undefined && order.captured_amount_paise !== null) {
    const cap = Number(order.captured_amount_paise);
    return Number.isFinite(cap) ? cap : 0;
  }
  const amount = Number(order.amount || 0);
  return Number.isFinite(amount) ? Math.round(amount * 100) : 0;
}

export function getOrderRefundedPaise(order) {
  if (!order) return 0;
  const refunded = Number(order.total_refunded_amount_paise || 0);
  return Number.isFinite(refunded) && refunded > 0 ? refunded : 0;
}

export function getPaymentStatusLabel(order) {
  if (order?.payment_status) return String(order.payment_status).toUpperCase();
  const status = String(order?.status || '').toUpperCase();
  if (status === 'COMPLETED') return 'COMPLETED';
  if (['PAID', 'PREPARING'].includes(status)) {
    return 'PAID';
  }
  if (status === 'FAILED') return 'FAILED';
  if (status === 'CANCELLED') return 'CANCELLED';
  return 'PENDING';
}

export function getDispenseStatusLabel(order) {
  if (order?.dispense_status) return String(order.dispense_status).toUpperCase();
  return 'PENDING';
}

function getStartOfDayMs(dateObj) {
  const d = new Date(dateObj);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function getIsoWeekLabel(dateObj) {
  const d = new Date(dateObj);
  d.setHours(0, 0, 0, 0);
  const day = d.getDay();
  const diffToMonday = day === 0 ? -6 : 1 - day;
  const monday = new Date(d);
  monday.setDate(d.getDate() + diffToMonday);
  return `Week of ${monday.toLocaleDateString('en-IN', { day: '2-digit', month: 'short' })}`;
}

function getMonthLabel(dateObj) {
  return dateObj.toLocaleDateString('en-IN', { month: 'short', year: 'numeric' });
}

/**
 * Computes comprehensive sales analytics using stored `order.amount` values.
 * @param {Array} orders - Orders returned from `/api/orders`
 * @param {Array} machines - Visible machines returned from `/api/machines`
 * @param {'daily' | 'weekly' | 'monthly' | 'all'} period - Selected aggregation timeframe
 * @param {string} machineFilter - `'ALL'` or specific `machine_id`
 * @param {number} nowMs - Reference timestamp
 */
export function computeSalesAnalytics(
  orders = [],
  machines = [],
  period = 'daily',
  machineFilter = 'ALL',
  nowMs = Date.now()
) {
  const nowDate = new Date(nowMs);
  const todayStartMs = getStartOfDayMs(nowDate);

  // Cutoff by period
  let cutoffMs = 0;
  if (period === 'daily') {
    // Last 7 days daily view
    cutoffMs = todayStartMs - 6 * 24 * 60 * 60 * 1000;
  } else if (period === 'weekly') {
    // Last 28 days (4 weeks)
    cutoffMs = todayStartMs - 27 * 24 * 60 * 60 * 1000;
  } else if (period === 'monthly') {
    // Last 180 days (~6 months)
    cutoffMs = todayStartMs - 180 * 24 * 60 * 60 * 1000;
  }

  const scopedOrders = (orders || []).filter((o) => {
    if (machineFilter && machineFilter !== 'ALL' && o.machine_id !== machineFilter) {
      return false;
    }
    return true;
  });

  const revenueOrdersAllTime = scopedOrders.filter(isRevenueOrder);

  // Today's sales & count in Asia/Kolkata calendar day (always computed for Overview & summary cards)
  const todayKolkataDate = getKolkataDateString(nowDate);
  let todayGrossPaise = 0;
  let todayRefundedPaise = 0;
  let todayOrdersCount = 0;
  for (const o of revenueOrdersAllTime) {
    const createdMs = Date.parse(o.created_at);
    if (!Number.isNaN(createdMs) && getKolkataDateString(new Date(createdMs)) === todayKolkataDate) {
      todayGrossPaise += getOrderGrossPaise(o);
      todayRefundedPaise += getOrderRefundedPaise(o);
      todayOrdersCount += 1;
    }
  }
  const todayGrossRevenue = Math.round(todayGrossPaise / 100);
  const todayRefunds = Math.round(todayRefundedPaise / 100);
  const todayNetRevenue = Math.round((todayGrossPaise - todayRefundedPaise) / 100);
  const todayRevenue = todayNetRevenue;

  // Filtered by selected time window (`period`)
  const periodRevenueOrders = revenueOrdersAllTime.filter((o) => {
    if (period === 'all') return true;
    const createdMs = Date.parse(o.created_at);
    if (Number.isNaN(createdMs)) return false;
    return createdMs >= cutoffMs;
  });

  const grossPaise = periodRevenueOrders.reduce((sum, o) => sum + getOrderGrossPaise(o), 0);
  const refundsPaise = periodRevenueOrders.reduce((sum, o) => sum + getOrderRefundedPaise(o), 0);
  const netPaise = grossPaise - refundsPaise;
  const grossRevenue = Math.round(grossPaise / 100);
  const refunds = Math.round(refundsPaise / 100);
  const netRevenue = Math.round(netPaise / 100);
  const totalRevenue = netRevenue;
  const totalOrders = periodRevenueOrders.length;
  const averageOrderValue = totalOrders > 0 ? Math.round(grossRevenue / totalOrders) : 0;

  // Revenue by Machine
  const machineMap = new Map();
  for (const m of machines || []) {
    if (machineFilter !== 'ALL' && m.id !== machineFilter) continue;
    machineMap.set(m.id, {
      machine_id: m.id,
      machine_name: m.machine_name || m.id,
      location: m.location || '—',
      orders_count: 0,
      revenue: 0
    });
  }

  for (const o of periodRevenueOrders) {
    const mId = o.machine_id || 'Unknown';
    if (!machineMap.has(mId)) {
      machineMap.set(mId, {
        machine_id: mId,
        machine_name: mId,
        location: '—',
        orders_count: 0,
        revenue: 0
      });
    }
    const entry = machineMap.get(mId);
    entry.orders_count += 1;
    entry.revenue += Number(o.amount) || 0;
  }

  const revenueByMachine = Array.from(machineMap.values()).sort((a, b) => b.revenue - a.revenue);

  // Product-wise sales
  const productMap = new Map();
  for (const o of periodRevenueOrders) {
    const productName =
      o.product_name ||
      o.coffee ||
      (o.product_id === 1
        ? 'Classic Crest'
        : o.product_id === 2
        ? 'Vanilla Velvet'
        : o.product_id === 3
        ? 'Hazel Gold'
        : o.product_id === 4
        ? 'Irish Emerald'
        : 'Mocha Bliss');
    const key = `${o.product_id || 0}:${productName}`;
    if (!productMap.has(key)) {
      productMap.set(key, {
        product_id: o.product_id || 0,
        product_name: productName,
        orders_count: 0,
        revenue: 0
      });
    }
    const prodEntry = productMap.get(key);
    prodEntry.orders_count += 1;
    prodEntry.revenue += Number(o.amount) || 0;
  }

  const productSales = Array.from(productMap.values())
    .map((p) => ({
      ...p,
      share_percent: totalRevenue > 0 ? Math.round((p.revenue / totalRevenue) * 100) : 0
    }))
    .sort((a, b) => b.revenue - a.revenue);

  // Time-bucket breakdown (Daily, Weekly, or Monthly)
  const bucketMap = new Map();
  for (const o of periodRevenueOrders) {
    const createdDate = new Date(o.created_at || nowMs);
    const validDate = Number.isNaN(createdDate.getTime()) ? nowDate : createdDate;
    let bucketKey;
    let bucketLabel;
    let sortKey;

    if (period === 'weekly') {
      const d = new Date(validDate);
      d.setHours(0, 0, 0, 0);
      const day = d.getDay();
      const diffToMonday = day === 0 ? -6 : 1 - day;
      d.setDate(d.getDate() + diffToMonday);
      sortKey = d.getTime();
      bucketKey = String(sortKey);
      bucketLabel = getIsoWeekLabel(validDate);
    } else if (period === 'monthly') {
      sortKey = new Date(validDate.getFullYear(), validDate.getMonth(), 1).getTime();
      bucketKey = `${validDate.getFullYear()}-${String(validDate.getMonth() + 1).padStart(2, '0')}`;
      bucketLabel = getMonthLabel(validDate);
    } else {
      sortKey = getStartOfDayMs(validDate);
      bucketKey = new Date(sortKey).toISOString().slice(0, 10);
      bucketLabel = formatShortDate(validDate.toISOString());
    }

    if (!bucketMap.has(bucketKey)) {
      bucketMap.set(bucketKey, {
        key: bucketKey,
        label: bucketLabel,
        sortKey,
        orders_count: 0,
        revenue: 0
      });
    }
    const b = bucketMap.get(bucketKey);
    b.orders_count += 1;
    b.revenue += Number(o.amount) || 0;
  }

  const periodBreakdown = Array.from(bucketMap.values()).sort((a, b) => a.sortKey - b.sortKey);

  return {
    todayRevenue,
    todayGrossRevenue,
    todayRefunds,
    todayNetRevenue,
    todayOrdersCount,
    totalRevenue,
    grossRevenue,
    refunds,
    netRevenue,
    totalOrders,
    averageOrderValue,
    revenueByMachine,
    productSales,
    periodBreakdown
  };
}

export function getDiscrepancyReasonLabel(reason) {
  switch (reason) {
    case 'UNVERIFIED_GATEWAY_PAYMENT':
      return 'Unverified Gateway Payment';
    case 'MISSING_PAYMENT_REFERENCE':
      return 'Missing Payment ID';
    case 'PAYMENT_AMOUNT_MISMATCH':
      return 'Payment Amount Mismatch';
    case 'DUPLICATE_PAYMENT_EVENT':
      return 'Duplicate Payment Events';
    case 'FAILED_PAYMENT_ACTIVE_STATUS':
      return 'Failed Gateway Payment';
    case 'DISPENSING_STUCK_QUEUED':
      return 'Dispensing Stuck in Queue';
    case 'DISPENSING_IN_PROGRESS_TIMEOUT':
      return 'Dispensing Timed Out';
    case 'DISPENSE_FAILED_UNREFUNDED':
      return 'Dispense Failed (Unrefunded)';
    case 'UNCERTAIN_DISPENSE_OUTCOME':
      return 'Uncertain Physical Outcome';
    case 'INVENTORY_DEDUCTION_MISSING':
      return 'Missing Inventory Deduction';
    case 'INVENTORY_DEDUCTION_DUPLICATED':
      return 'Duplicate Inventory Deduction';
    case 'REFUND_EXCEEDS_CAPTURE':
      return 'Refund Exceeds Captured Amount';
    case 'REFUND_LEDGER_MISMATCH':
      return 'Refund Sum Mismatch';
    case 'REFUND_PENDING_STALE':
      return 'Stale Pending Refund';
    case 'MACHINE_ID_MISMATCH':
      return 'Cross-Machine Conflict';
    default:
      return reason || 'Reconciled';
  }
}

export function getRecommendedActionLabel(action) {
  switch (action) {
    case 'VERIFY_GATEWAY_AND_SYNC_PAID':
      return 'Verify Gateway & Sync to Paid';
    case 'RECORD_CAPTURED_AMOUNT':
      return 'Record Authoritative Payment ID';
    case 'MANUAL_REVIEW_FINANCES':
      return 'Manual Financial Audit Required';
    case 'INITIATE_REFUND':
      return 'Issue Customer Refund';
    case 'CHECK_MACHINE_CONNECTIVITY':
      return 'Check Machine Hardware / Internet';
    case 'INVESTIGATE_HARDWARE_DISPENSE':
      return 'Physically Verify Pour (Do Not Resend)';
    case 'RECORD_INVENTORY_LEDGER':
      return 'Audit / Backfill Inventory Ledger';
    case 'RELEASE_STALE_PENDING_REFUND':
      return 'Release Expired Pending Reservation';
    case 'FLAG_DATA_CORRUPTION':
      return 'Flag Record for Engineering Review';
    default:
      return action || 'None';
  }
}


