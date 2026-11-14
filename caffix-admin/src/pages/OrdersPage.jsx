import React, { useState, useMemo } from 'react';
import {
  Search,
  Filter,
  Calendar,
  X,
  Copy,
  Check,
  Eye,
  CreditCard,
  Coffee,
  Clock,
  User,
  RotateCcw
} from 'lucide-react';
import {
  PaymentStatusBadge,
  DispenseStatusBadge,
  RefundStatusBadge,
  ReconciliationBadge
} from '../components/StatusBadges';
import {
  formatINR,
  formatPaise,
  formatDateTime,
  getPaymentStatusLabel,
  getDispenseStatusLabel,
  getDiscrepancyReasonLabel,
  getRecommendedActionLabel
} from '../utils/formatters';

function CopyableText({ text, displayText, label = 'Copy', tooltip = '' }) {
  const [copied, setCopied] = useState(false);

  if (!text) {
    return <span className="text-slate-400 font-mono text-xs">—</span>;
  }

  const handleCopy = (e) => {
    e.stopPropagation();
    if (navigator?.clipboard?.writeText) {
      navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }
  };

  return (
    <div className="inline-flex items-center gap-1.5 group/copy">
      <span
        className="font-mono text-xs text-slate-700 font-medium"
        title={tooltip || text}
      >
        {displayText || text}
      </span>
      <button
        type="button"
        onClick={handleCopy}
        className="p-1 rounded-md text-slate-400 hover:text-[#4E3629] hover:bg-[#FAF6F0] transition-colors"
        title={copied ? 'Copied!' : label}
      >
        {copied ? (
          <Check className="w-3.5 h-3.5 text-emerald-600" />
        ) : (
          <Copy className="w-3.5 h-3.5" />
        )}
      </button>
      {copied && (
        <span className="text-[10px] font-semibold text-emerald-600 animate-in fade-in">
          Copied
        </span>
      )}
    </div>
  );
}

function resolveBeverageName(o) {
  if (o.product_name) return o.product_name;
  if (o.coffee) return o.coffee;
  switch (o.product_id) {
    case 1:
      return 'Classic Crest';
    case 2:
      return 'Vanilla Velvet';
    case 3:
      return 'Hazel Gold';
    case 4:
      return 'Irish Emerald';
    case 5:
      return 'Mocha Bliss';
    default:
      return `Product #${o.product_id || 1}`;
  }
}

export function evaluateOrderReconciliation(o) {
  if (!o) return { result: 'MATCH', reason: 'NONE', action: 'NO_ACTION', details: 'No order data' };
  const orderStatus = String(o.status || 'PENDING').toUpperCase();
  const dispenseStatus = String(o.dispense_status || 'PENDING').toUpperCase();
  const capturedPaise = o.captured_amount_paise !== undefined && o.captured_amount_paise !== null ? Number(o.captured_amount_paise) : null;
  const totalRefunded = Number(o.total_refunded_amount_paise || 0);
  const pendingRefund = Number(o.pending_refund_amount_paise || 0);

  if (['PAID', 'PREPARING', 'COMPLETED'].includes(orderStatus) && !o.razorpay_payment_id) {
    return {
      result: 'DISCREPANCY',
      reason: 'MISSING_PAYMENT_REFERENCE',
      action: 'RECORD_CAPTURED_AMOUNT',
      details: 'Order marked PAID without authoritative razorpay_payment_id.'
    };
  }

  const orderAmountPaise = Math.round(Number(o.amount || 0) * 100);
  if (capturedPaise !== null && orderAmountPaise > 0 && capturedPaise !== orderAmountPaise) {
    return {
      result: 'DISCREPANCY',
      reason: 'PAYMENT_AMOUNT_MISMATCH',
      action: 'MANUAL_REVIEW_FINANCES',
      details: `Order created for ${orderAmountPaise} paise but gateway captured ${capturedPaise} paise.`
    };
  }

  const isFailed = dispenseStatus === 'FAILED' || orderStatus === 'FAILED';
  const isPaid = (capturedPaise !== null && capturedPaise > 0) || Boolean(o.razorpay_payment_id);
  if (isFailed && isPaid && totalRefunded === 0 && pendingRefund === 0) {
    return {
      result: 'DISCREPANCY',
      reason: 'DISPENSE_FAILED_UNREFUNDED',
      action: 'INITIATE_REFUND',
      details: 'Dispense failed after payment was captured, but no refund has been initiated.'
    };
  }

  if (orderStatus === 'PAID' && dispenseStatus === 'QUEUED') {
    const ageMs = Date.now() - (o.created_at ? new Date(o.created_at).getTime() : Date.now());
    if (ageMs > 15 * 60 * 1000) {
      return {
        result: 'DISCREPANCY',
        reason: 'DISPENSING_STUCK_QUEUED',
        action: 'CHECK_MACHINE_CONNECTIVITY',
        details: 'Order has been queued for more than 15 minutes.'
      };
    }
  }

  if (capturedPaise !== null && totalRefunded > capturedPaise) {
    return {
      result: 'DISCREPANCY',
      reason: 'REFUND_EXCEEDS_CAPTURE',
      action: 'MANUAL_REVIEW_FINANCES',
      details: 'Total refunded amount exceeds captured payment amount.'
    };
  }

  if (pendingRefund > 0 || String(o.refund_status || '').toUpperCase() === 'PENDING') {
    return {
      result: 'PENDING_ACTION',
      reason: 'REFUND_PENDING',
      action: 'VERIFY_GATEWAY_REFUND',
      details: 'Refund request is pending gateway confirmation.'
    };
  }

  return {
    result: 'MATCH',
    reason: 'NONE',
    action: 'NO_ACTION',
    details: 'Order matches all financial and hardware reconciliation checks.'
  };
}

export default function OrdersPage({ orders = [], machines = [] }) {
  const [searchQuery, setSearchQuery] = useState('');
  const [machineFilter, setMachineFilter] = useState('ALL');
  const [paymentStatusFilter, setPaymentStatusFilter] = useState('ALL');
  const [dispenseStatusFilter, setDispenseStatusFilter] = useState('ALL');
  const [refundStatusFilter, setRefundStatusFilter] = useState('ALL');
  const [reconciliationFilter, setReconciliationFilter] = useState('ALL');
  const [dateRangePreset, setDateRangePreset] = useState('ALL');
  const [customStartDate, setCustomStartDate] = useState('');
  const [customEndDate, setCustomEndDate] = useState('');
  const [selectedOrder, setSelectedOrder] = useState(null);

  const machineMap = useMemo(() => {
    const map = new Map();
    (machines || []).forEach((m) => {
      map.set(m.id, m);
    });
    return map;
  }, [machines]);

  // Date filtering logic
  const filteredOrders = useMemo(() => {
    const now = new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();

    return (orders || []).filter((o) => {
      // 1. Machine filter
      if (machineFilter !== 'ALL' && o.machine_id !== machineFilter) {
        return false;
      }

      // 2. Payment status filter
      const paymentStatus = getPaymentStatusLabel(o);
      if (paymentStatusFilter !== 'ALL' && paymentStatus !== paymentStatusFilter) {
        return false;
      }

      // 3. Dispensing status filter
      const dispenseStatus = getDispenseStatusLabel(o);
      if (dispenseStatusFilter !== 'ALL' && dispenseStatus !== dispenseStatusFilter) {
        return false;
      }

      // 4. Refund status filter
      const refundStatus = String(o.refund_status || 'NONE').toUpperCase();
      if (refundStatusFilter !== 'ALL' && refundStatus !== refundStatusFilter) {
        return false;
      }

      // 4b. Reconciliation filter (Phase 2.8)
      if (reconciliationFilter !== 'ALL') {
        const rec = evaluateOrderReconciliation(o);
        if (rec.result !== reconciliationFilter) {
          return false;
        }
      }

      // 5. Date range filter
      const orderDateMs = Date.parse(o.created_at);
      if (!Number.isNaN(orderDateMs)) {
        if (dateRangePreset === 'TODAY' && orderDateMs < startOfToday) {
          return false;
        }
        if (
          dateRangePreset === '7D' &&
          orderDateMs < startOfToday - 6 * 24 * 60 * 60 * 1000
        ) {
          return false;
        }
        if (
          dateRangePreset === '30D' &&
          orderDateMs < startOfToday - 29 * 24 * 60 * 60 * 1000
        ) {
          return false;
        }
        if (dateRangePreset === 'CUSTOM') {
          if (customStartDate) {
            const startMs = Date.parse(`${customStartDate}T00:00:00`);
            if (!Number.isNaN(startMs) && orderDateMs < startMs) return false;
          }
          if (customEndDate) {
            const endMs = Date.parse(`${customEndDate}T23:59:59`);
            if (!Number.isNaN(endMs) && orderDateMs > endMs) return false;
          }
        }
      }

      // 5. Search query
      if (searchQuery.trim()) {
        const q = searchQuery.trim().toLowerCase();
        const idMatch = String(o.id || '').toLowerCase().includes(q);
        const prodMatch = resolveBeverageName(o).toLowerCase().includes(q);
        const machMatch = String(o.machine_id || '').toLowerCase().includes(q);
        const payIdMatch = String(o.razorpay_payment_id || '').toLowerCase().includes(q);
        const rpOrderIdMatch = String(o.razorpay_order_id || '').toLowerCase().includes(q);
        const custMatch =
          String(o.customer_name || '').toLowerCase().includes(q) ||
          String(o.customer_email || '').toLowerCase().includes(q);
        return idMatch || prodMatch || machMatch || payIdMatch || rpOrderIdMatch || custMatch;
      }

      return true;
    });
  }, [
    orders,
    machineFilter,
    paymentStatusFilter,
    dispenseStatusFilter,
    refundStatusFilter,
    reconciliationFilter,
    dateRangePreset,
    customStartDate,
    customEndDate,
    searchQuery
  ]);

  const hasActiveFilters =
    searchQuery.trim() !== '' ||
    machineFilter !== 'ALL' ||
    paymentStatusFilter !== 'ALL' ||
    dispenseStatusFilter !== 'ALL' ||
    refundStatusFilter !== 'ALL' ||
    reconciliationFilter !== 'ALL' ||
    dateRangePreset !== 'ALL' ||
    customStartDate !== '' ||
    customEndDate !== '';

  const handleResetFilters = () => {
    setSearchQuery('');
    setMachineFilter('ALL');
    setPaymentStatusFilter('ALL');
    setDispenseStatusFilter('ALL');
    setRefundStatusFilter('ALL');
    setReconciliationFilter('ALL');
    setDateRangePreset('ALL');
    setCustomStartDate('');
    setCustomEndDate('');
  };

  return (
    <div className="space-y-6">
      {/* Header & Filter Card */}
      <div className="bg-white rounded-2xl border border-[#EED9C4] p-5 shadow-xs space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
          <div>
            <h2 className="font-display text-xl font-bold text-[#2C1E17]">All Fleet Orders</h2>
            <p className="text-xs text-slate-500">
              Live payment and dispensing monitoring across all registered fleet machines.
            </p>
          </div>
          <div className="flex items-center gap-3">
            <span className="text-xs font-semibold text-[#8C6246]">
              Showing {filteredOrders.length} of {orders.length} order(s)
            </span>
            {hasActiveFilters && (
              <button
                type="button"
                onClick={handleResetFilters}
                className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-semibold text-[#8C6246] hover:text-[#4E3629] bg-[#FAF6F0] hover:bg-[#EED9C4]/50 rounded-lg transition-colors border border-[#EED9C4]"
              >
                <RotateCcw className="w-3 h-3" />
                Reset
              </button>
            )}
          </div>
        </div>

        {/* Filters Grid */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-6 gap-3">
          {/* Search Query */}
          <div className="relative">
            <Search className="w-4 h-4 text-slate-400 absolute left-3.5 top-2.5" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search ID, beverage, pay/order ID..."
              className="w-full pl-9 pr-3 py-2 rounded-xl border border-[#EED9C4] bg-[#FAF6F0]/50 text-xs focus:outline-none focus:border-[#4E3629]"
            />
          </div>

          {/* Machine Filter */}
          <div className="relative flex items-center">
            <select
              value={machineFilter}
              onChange={(e) => setMachineFilter(e.target.value)}
              className="w-full px-3 py-2 rounded-xl border border-[#EED9C4] bg-[#FAF6F0]/50 text-xs font-semibold text-[#2C1E17] focus:outline-none focus:border-[#4E3629]"
            >
              <option value="ALL">All Fleet Machines</option>
              {machines.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.machine_name} ({m.id})
                </option>
              ))}
            </select>
          </div>

          {/* Payment Status Filter */}
          <div>
            <select
              value={paymentStatusFilter}
              onChange={(e) => setPaymentStatusFilter(e.target.value)}
              className="w-full px-3 py-2 rounded-xl border border-[#EED9C4] bg-[#FAF6F0]/50 text-xs font-semibold text-[#2C1E17] focus:outline-none focus:border-[#4E3629]"
            >
              <option value="ALL">All Payment Statuses</option>
              <option value="PENDING">Payment: PENDING</option>
              <option value="PAID">Payment: PAID</option>
              <option value="COMPLETED">Payment: COMPLETED</option>
              <option value="FAILED">Payment: FAILED</option>
              <option value="CANCELLED">Payment: CANCELLED</option>
            </select>
          </div>

          {/* Dispensing Status Filter */}
          <div>
            <select
              value={dispenseStatusFilter}
              onChange={(e) => setDispenseStatusFilter(e.target.value)}
              className="w-full px-3 py-2 rounded-xl border border-[#EED9C4] bg-[#FAF6F0]/50 text-xs font-semibold text-[#2C1E17] focus:outline-none focus:border-[#4E3629]"
            >
              <option value="ALL">All Dispensing Statuses</option>
              <option value="PENDING">Dispense: PENDING</option>
              <option value="QUEUED">Dispense: QUEUED</option>
              <option value="DISPENSING">Dispense: DISPENSING</option>
              <option value="DISPENSED">Dispense: DISPENSED</option>
              <option value="FAILED">Dispense: FAILED</option>
            </select>
          </div>

          {/* Refund Status Filter */}
          <div>
            <select
              value={refundStatusFilter}
              onChange={(e) => setRefundStatusFilter(e.target.value)}
              className="w-full px-3 py-2 rounded-xl border border-[#EED9C4] bg-[#FAF6F0]/50 text-xs font-semibold text-[#2C1E17] focus:outline-none focus:border-[#4E3629]"
            >
              <option value="ALL">All Refund Statuses</option>
              <option value="NONE">Refund: NONE</option>
              <option value="PENDING">Refund: PENDING</option>
              <option value="PARTIAL">Refund: PARTIAL</option>
              <option value="FULL">Refund: FULL</option>
              <option value="FAILED">Refund: FAILED</option>
            </select>
          </div>

          {/* Reconciliation Status Filter (Phase 2.8) */}
          <div>
            <select
              value={reconciliationFilter}
              onChange={(e) => setReconciliationFilter(e.target.value)}
              className="w-full px-3 py-2 rounded-xl border border-[#EED9C4] bg-[#FAF6F0]/50 text-xs font-semibold text-[#2C1E17] focus:outline-none focus:border-[#4E3629]"
            >
              <option value="ALL">All Reconciliation</option>
              <option value="MATCH">Reconciled (Match)</option>
              <option value="DISCREPANCY">Discrepancy Detected</option>
              <option value="PENDING_ACTION">Pending Action</option>
            </select>
          </div>

          {/* Date Range Filter */}
          <div>
            <select
              value={dateRangePreset}
              onChange={(e) => setDateRangePreset(e.target.value)}
              className="w-full px-3 py-2 rounded-xl border border-[#EED9C4] bg-[#FAF6F0]/50 text-xs font-semibold text-[#2C1E17] focus:outline-none focus:border-[#4E3629]"
            >
              <option value="ALL">Date: All Time</option>
              <option value="TODAY">Date: Today</option>
              <option value="7D">Date: Last 7 Days</option>
              <option value="30D">Date: Last 30 Days</option>
              <option value="CUSTOM">Date: Custom Range...</option>
            </select>
          </div>
        </div>

        {/* Custom Date Inputs (when CUSTOM selected) */}
        {dateRangePreset === 'CUSTOM' && (
          <div className="flex flex-wrap items-center gap-3 pt-2 border-t border-[#EED9C4]/60">
            <div className="flex items-center gap-2">
              <span className="text-xs font-semibold text-[#8C6246]">From:</span>
              <input
                type="date"
                value={customStartDate}
                onChange={(e) => setCustomStartDate(e.target.value)}
                className="px-2.5 py-1.5 rounded-lg border border-[#EED9C4] text-xs font-medium text-[#2C1E17] bg-[#FAF6F0]/40"
              />
            </div>
            <div className="flex items-center gap-2">
              <span className="text-xs font-semibold text-[#8C6246]">To:</span>
              <input
                type="date"
                value={customEndDate}
                onChange={(e) => setCustomEndDate(e.target.value)}
                className="px-2.5 py-1.5 rounded-lg border border-[#EED9C4] text-xs font-medium text-[#2C1E17] bg-[#FAF6F0]/40"
              />
            </div>
          </div>
        )}
      </div>

      {/* Orders Table */}
      <div className="bg-white rounded-2xl border border-[#EED9C4] shadow-xs overflow-hidden">
        {filteredOrders.length === 0 ? (
          <div className="p-12 text-center text-sm text-slate-500">
            No orders match the current filters.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="bg-[#FAF6F0] text-[11px] font-semibold uppercase tracking-wider text-[#8C6246] border-b border-[#EED9C4]">
                  <th className="py-3.5 px-4">Order ID</th>
                  <th className="py-3.5 px-4">Date & Time</th>
                  <th className="py-3.5 px-4">Machine ID</th>
                  <th className="py-3.5 px-4">Product</th>
                  <th className="py-3.5 px-4">Amount</th>
                  <th className="py-3.5 px-4">Refund</th>
                  <th className="py-3.5 px-4">Payment</th>
                  <th className="py-3.5 px-4">Dispensing</th>
                  <th className="py-3.5 px-4">Reconciliation</th>
                  <th className="py-3.5 px-4">Payment ID</th>
                  <th className="py-3.5 px-4">Customer</th>
                  <th className="py-3.5 px-4 text-right">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#EED9C4]/60 text-sm">
                {filteredOrders.map((o) => {
                  const paymentLabel = getPaymentStatusLabel(o);
                  const dispenseLabel = getDispenseStatusLabel(o);
                  const beverageName = resolveBeverageName(o);
                  const customerDisplay = o.customer_name || o.customer_email;
                  const payIdShort = o.razorpay_payment_id
                    ? o.razorpay_payment_id.length > 14
                    ? `${o.razorpay_payment_id.slice(0, 8)}...${o.razorpay_payment_id.slice(-4)}`
                    : o.razorpay_payment_id
                    : null;

                  return (
                    <tr
                      key={o.id}
                      onClick={() => setSelectedOrder(o)}
                      className="hover:bg-[#FAF6F0]/60 transition-colors cursor-pointer group"
                    >
                      {/* 1. Order ID */}
                      <td className="py-3.5 px-4 font-mono font-bold text-xs text-[#2C1E17] group-hover:text-[#8C6246] transition-colors">
                        {o.id}
                      </td>

                      {/* 2. Date & Time */}
                      <td className="py-3.5 px-4 text-xs text-slate-600 whitespace-nowrap">
                        {formatDateTime(o.created_at)}
                      </td>

                      {/* 3. Machine ID */}
                      <td className="py-3.5 px-4 font-mono text-xs text-[#8C6246] font-semibold whitespace-nowrap">
                        {o.machine_id}
                      </td>

                      {/* 4. Product */}
                      <td className="py-3.5 px-4 font-semibold text-[#2C1E17]">
                        <div>{beverageName}</div>
                        {(o.base && o.base !== 'water') || o.extra_sugar ? (
                          <div className="text-[10px] text-slate-400 font-normal">
                            {o.base ? `base: ${o.base}` : ''}
                            {o.extra_sugar ? ` • sugar: ${o.extra_sugar}` : ''}
                          </div>
                        ) : null}
                      </td>

                      {/* 5. Amount */}
                      <td className="py-3.5 px-4 font-display font-bold text-[#4E3629] whitespace-nowrap">
                        {formatINR(o.amount)}
                      </td>

                      {/* 6. Refund Status & Amount */}
                      <td className="py-3.5 px-4 whitespace-nowrap">
                        <div className="flex flex-col gap-0.5">
                          <RefundStatusBadge status={o.refund_status || 'NONE'} />
                          {Number(o.total_refunded_amount_paise || 0) > 0 && (
                            <span className="text-[10px] font-bold text-purple-700">
                              -{formatPaise(o.total_refunded_amount_paise)}
                            </span>
                          )}
                        </div>
                      </td>

                      {/* 7. Payment Status */}
                      <td className="py-3.5 px-4 whitespace-nowrap">
                        <PaymentStatusBadge status={paymentLabel} />
                      </td>

                      {/* 8. Dispensing Status */}
                      <td className="py-3.5 px-4 whitespace-nowrap">
                        <DispenseStatusBadge status={dispenseLabel} />
                      </td>

                      {/* 8b. Reconciliation Status (Phase 2.8) */}
                      <td className="py-3.5 px-4 whitespace-nowrap">
                        {(() => {
                          const rec = evaluateOrderReconciliation(o);
                          return <ReconciliationBadge result={rec.result} reason={rec.reason} />;
                        })()}
                      </td>

                      {/* 9. Razorpay Payment ID */}
                      <td className="py-3.5 px-4 whitespace-nowrap">
                        <CopyableText
                          text={o.razorpay_payment_id}
                          displayText={payIdShort}
                          label="Copy Payment ID"
                        />
                      </td>

                      {/* 9. Customer */}
                      <td className="py-3.5 px-4 text-xs">
                        {customerDisplay ? (
                          <span className="font-medium text-[#2C1E17]">{customerDisplay}</span>
                        ) : (
                          <span className="text-slate-400 italic">Kiosk Guest</span>
                        )}
                      </td>

                      {/* 10. Action */}
                      <td className="py-3.5 px-4 text-right">
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            setSelectedOrder(o);
                          }}
                          className="p-1.5 rounded-lg text-slate-400 hover:text-[#4E3629] hover:bg-[#FAF6F0] transition-colors"
                          title="View Order Details"
                        >
                          <Eye className="w-4 h-4" />
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Order Details Modal */}
      {selectedOrder && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-xs p-4"
          onClick={() => setSelectedOrder(null)}
        >
          <div
            className="bg-white rounded-3xl border border-[#EED9C4] shadow-2xl max-w-lg w-full p-6 animate-in fade-in zoom-in-95 duration-150 space-y-5"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Modal Header */}
            <div className="flex items-start justify-between gap-3 border-b border-[#EED9C4]/60 pb-4">
              <div>
                <div className="flex items-center gap-2">
                  <h3 className="font-display text-lg font-bold text-[#2C1E17]">
                    Order Details
                  </h3>
                  <span className="font-mono text-sm font-bold text-[#8C6246] bg-[#FAF6F0] px-2.5 py-0.5 rounded-lg border border-[#EED9C4]">
                    {selectedOrder.id}
                  </span>
                </div>
                <p className="text-xs text-slate-500 mt-1">
                  Machine: {selectedOrder.machine_id}
                  {machineMap.get(selectedOrder.machine_id)?.machine_name
                    ? ` (${machineMap.get(selectedOrder.machine_id).machine_name})`
                    : ''}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setSelectedOrder(null)}
                className="text-slate-400 hover:text-slate-600 p-1.5 rounded-xl hover:bg-slate-100 transition-colors"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Status & Amount Cards */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div className="bg-[#FAF6F0]/60 p-3.5 rounded-2xl border border-[#EED9C4]/70 space-y-1.5">
                <div className="text-[10px] font-semibold uppercase tracking-wider text-[#8C6246]">
                  Payment Status
                </div>
                <div>
                  <PaymentStatusBadge status={getPaymentStatusLabel(selectedOrder)} />
                </div>
                <div className="text-[11px] text-slate-500 font-display font-bold text-[#4E3629] pt-1">
                  Amount: {formatINR(selectedOrder.amount)}
                </div>
              </div>

              <div className="bg-[#FAF6F0]/60 p-3.5 rounded-2xl border border-[#EED9C4]/70 space-y-1.5">
                <div className="text-[10px] font-semibold uppercase tracking-wider text-[#8C6246]">
                  Dispensing Status
                </div>
                <div>
                  <DispenseStatusBadge status={getDispenseStatusLabel(selectedOrder)} />
                </div>
                <div className="text-[11px] text-slate-500 pt-1">
                  {selectedOrder.dispense_status === 'DISPENSED'
                    ? 'Beverage served'
                    : selectedOrder.dispense_status === 'DISPENSING'
                    ? 'Grinding / pouring'
                    : selectedOrder.dispense_status === 'QUEUED'
                    ? 'Queued on hardware'
                    : selectedOrder.dispense_status === 'FAILED'
                    ? 'Hardware error'
                    : 'Awaiting payment'}
                </div>
              </div>

              <div className="bg-[#FAF6F0]/60 p-3.5 rounded-2xl border border-[#EED9C4]/70 space-y-1.5">
                <div className="text-[10px] font-semibold uppercase tracking-wider text-[#8C6246]">
                  Refund Lifecycle
                </div>
                <div>
                  <RefundStatusBadge status={selectedOrder.refund_status || 'NONE'} />
                </div>
                <div className="text-[11px] text-slate-600 font-medium pt-1 space-y-0.5">
                  <div>
                    Refunded:{' '}
                    <span className="font-bold text-[#2C1E17]">
                      {formatPaise(selectedOrder.total_refunded_amount_paise || 0)}
                    </span>
                  </div>
                  {Number(selectedOrder.pending_refund_amount_paise || 0) > 0 && (
                    <div className="text-amber-700">
                      Pending:{' '}
                      <span className="font-bold">
                        {formatPaise(selectedOrder.pending_refund_amount_paise)}
                      </span>
                    </div>
                  )}
                </div>
              </div>
            </div>

            {/* Reconciliation Assessment (Phase 2.8) */}
            {(() => {
              const rec = evaluateOrderReconciliation(selectedOrder);
              const isMatch = rec.result === 'MATCH';
              return (
                <div
                  className={`p-3.5 rounded-2xl border text-xs space-y-1.5 ${
                    isMatch
                      ? 'bg-emerald-50/50 border-emerald-200 text-emerald-900'
                      : rec.result === 'PENDING_ACTION'
                      ? 'bg-amber-50/70 border-amber-300 text-amber-900'
                      : 'bg-rose-50/70 border-rose-300 text-rose-900'
                  }`}
                >
                  <div className="flex items-center justify-between font-bold">
                    <span className="flex items-center gap-1.5">
                      <ReconciliationBadge result={rec.result} reason={rec.reason} />
                      {isMatch ? 'All Invariants Verified' : getDiscrepancyReasonLabel(rec.reason)}
                    </span>
                    {!isMatch && (
                      <span className="text-[10px] uppercase tracking-wider font-semibold px-2 py-0.5 rounded bg-white/70 border border-current">
                        Action Required
                      </span>
                    )}
                  </div>
                  <div className="text-[11px] leading-relaxed opacity-90">{rec.details}</div>
                  {!isMatch && (
                    <div className="pt-1 text-[11px] font-semibold border-t border-current/20">
                      Recommended Action:{' '}
                      <span className="font-bold">{getRecommendedActionLabel(rec.action)}</span>
                    </div>
                  )}
                </div>
              );
            })()}

            {/* Product & Recipe Options */}
            <div className="bg-white p-4 rounded-2xl border border-[#EED9C4]/80 space-y-2">
              <div className="text-xs font-bold text-[#2C1E17] flex items-center gap-1.5">
                <Coffee className="w-4 h-4 text-[#8C6246]" />
                {resolveBeverageName(selectedOrder)}
              </div>
              <div className="grid grid-cols-2 gap-2 text-xs text-slate-600 pt-1">
                <div>
                  <span className="text-slate-400">Base Liquid: </span>
                  <span className="font-semibold capitalize text-[#4E3629]">
                    {selectedOrder.base || 'water'}
                  </span>
                </div>
                <div>
                  <span className="text-slate-400">Extra Sugar: </span>
                  <span className="font-semibold text-[#4E3629]">
                    {selectedOrder.extra_sugar ? `${selectedOrder.extra_sugar} packet(s)` : 'Standard'}
                  </span>
                </div>
              </div>
            </div>

            {/* Razorpay Transaction Details */}
            <div className="bg-[#FAF6F0]/40 p-4 rounded-2xl border border-[#EED9C4]/70 space-y-3">
              <div className="text-xs font-bold text-[#2C1E17] flex items-center gap-1.5">
                <CreditCard className="w-4 h-4 text-[#8C6246]" />
                Payment Gateway Details
              </div>

              <div className="space-y-2 text-xs">
                <div className="flex items-center justify-between">
                  <span className="text-slate-500">Razorpay Order ID:</span>
                  <CopyableText
                    text={selectedOrder.razorpay_order_id}
                    label="Copy Razorpay Order ID"
                  />
                </div>

                <div className="flex items-center justify-between">
                  <span className="text-slate-500">Razorpay Payment ID:</span>
                  <CopyableText
                    text={selectedOrder.razorpay_payment_id}
                    label="Copy Razorpay Payment ID"
                  />
                </div>
              </div>
            </div>

            {/* Refund History & Audit Trail */}
            {selectedOrder.refunds && selectedOrder.refunds.length > 0 && (
              <div className="bg-white p-4 rounded-2xl border border-[#EED9C4]/80 space-y-2">
                <div className="text-xs font-bold text-[#2C1E17] flex items-center justify-between">
                  <span>Refund Records ({selectedOrder.refunds.length})</span>
                  <span className="text-[11px] font-normal text-slate-500">Super Admin Audit History</span>
                </div>
                <div className="divide-y divide-[#EED9C4]/40 text-xs">
                  {selectedOrder.refunds.map((rfnd, rIdx) => (
                    <div key={rfnd.id || rIdx} className="py-2 flex items-center justify-between">
                      <div className="space-y-0.5">
                        <div className="font-mono font-bold text-[11px] text-[#4E3629]">
                          {rfnd.id}
                        </div>
                        <div className="text-[10px] text-slate-500">
                          {formatDateTime(rfnd.created_at)} • {rfnd.reason || 'Admin initiated'}
                          {rfnd.initiated_by ? ` by ${rfnd.initiated_by}` : ''}
                        </div>
                      </div>
                      <div className="text-right space-y-0.5">
                        <div className="font-bold text-[#2C1E17]">
                          {formatPaise(rfnd.amount_paise)}
                        </div>
                        <RefundStatusBadge status={rfnd.status} />
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Timestamps & Dispensing Logs */}
            <div className="space-y-2 pt-1 border-t border-[#EED9C4]/60 text-xs">
              <div className="flex items-center justify-between text-slate-600">
                <span className="flex items-center gap-1 text-slate-400">
                  <Clock className="w-3.5 h-3.5" /> Created:
                </span>
                <span className="font-medium text-[#2C1E17]">
                  {formatDateTime(selectedOrder.created_at)}
                </span>
              </div>

              <div className="flex items-center justify-between text-slate-600">
                <span className="text-slate-400">Updated:</span>
                <span className="font-medium text-[#2C1E17]">
                  {formatDateTime(selectedOrder.updated_at || selectedOrder.created_at)}
                </span>
              </div>

              {selectedOrder.dispense_started_at && (
                <div className="flex items-center justify-between text-slate-600">
                  <span className="text-slate-400">Dispense Started:</span>
                  <span className="font-medium text-[#2C1E17]">
                    {formatDateTime(selectedOrder.dispense_started_at)}
                  </span>
                </div>
              )}

              {selectedOrder.dispensed_at && (
                <div className="flex items-center justify-between text-slate-600">
                  <span className="text-slate-400">Dispensed At:</span>
                  <span className="font-medium text-emerald-700 font-semibold">
                    {formatDateTime(selectedOrder.dispensed_at)}
                  </span>
                </div>
              )}

              <div className="flex items-center justify-between text-slate-600 pt-1">
                <span className="flex items-center gap-1 text-slate-400">
                  <User className="w-3.5 h-3.5" /> Customer:
                </span>
                <span className="font-medium text-[#2C1E17]">
                  {selectedOrder.customer_name || selectedOrder.customer_email || 'Kiosk Guest (Anonymous)'}
                </span>
              </div>
            </div>

            {/* Close Button */}
            <div className="pt-2">
              <button
                type="button"
                onClick={() => setSelectedOrder(null)}
                className="w-full py-2.5 rounded-xl text-xs font-bold text-white bg-[#4E3629] hover:bg-[#2C1E17] transition-colors shadow-xs"
              >
                Close Details
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
