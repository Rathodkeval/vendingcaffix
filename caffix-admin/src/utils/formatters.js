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

export function isRevenueOrder(order) {
  if (!order) return false;
  return REVENUE_ELIGIBLE_STATUSES.has(String(order.status || '').toUpperCase());
}

export function getPaymentStatusLabel(order) {
  const status = String(order?.status || '').toUpperCase();
  if (['PAID', 'PREPARING', 'COMPLETED'].includes(status)) {
    return 'PAID';
  }
  if (status === 'FAILED') return 'FAILED';
  if (status === 'CANCELLED') return 'CANCELLED';
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

  // Today's sales & count (always computed for Overview & summary cards)
  let todayRevenue = 0;
  let todayOrdersCount = 0;
  for (const o of revenueOrdersAllTime) {
    const createdMs = Date.parse(o.created_at);
    if (!Number.isNaN(createdMs) && createdMs >= todayStartMs) {
      todayRevenue += Number(o.amount) || 0;
      todayOrdersCount += 1;
    }
  }

  // Filtered by selected time window (`period`)
  const periodRevenueOrders = revenueOrdersAllTime.filter((o) => {
    if (period === 'all') return true;
    const createdMs = Date.parse(o.created_at);
    if (Number.isNaN(createdMs)) return true;
    return createdMs >= cutoffMs;
  });

  const totalRevenue = periodRevenueOrders.reduce((sum, o) => sum + (Number(o.amount) || 0), 0);
  const totalOrders = periodRevenueOrders.length;
  const averageOrderValue = totalOrders > 0 ? Math.round(totalRevenue / totalOrders) : 0;

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
    todayOrdersCount,
    totalRevenue,
    totalOrders,
    averageOrderValue,
    revenueByMachine,
    productSales,
    periodBreakdown
  };
}

