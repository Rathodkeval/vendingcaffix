import React, { useState, useMemo } from 'react';
import { Search, Filter } from 'lucide-react';
import { OrderStatusBadge } from '../components/StatusBadges';
import { formatINR, formatDateTime, getPaymentStatusLabel } from '../utils/formatters';

export default function OrdersPage({ orders, machines }) {
  const [machineFilter, setMachineFilter] = useState('ALL');
  const [statusFilter, setStatusFilter] = useState('ALL');
  const [searchQuery, setSearchQuery] = useState('');

  const filteredOrders = useMemo(() => {
    return (orders || []).filter((o) => {
      if (machineFilter !== 'ALL' && o.machine_id !== machineFilter) {
        return false;
      }
      if (
        statusFilter !== 'ALL' &&
        String(o.status || '').toUpperCase() !== statusFilter
      ) {
        return false;
      }
      if (searchQuery.trim()) {
        const q = searchQuery.trim().toLowerCase();
        const idMatch = String(o.id || '').toLowerCase().includes(q);
        const prodMatch = String(o.product_name || o.coffee || '')
          .toLowerCase()
          .includes(q);
        const machMatch = String(o.machine_id || '').toLowerCase().includes(q);
        return idMatch || prodMatch || machMatch;
      }
      return true;
    });
  }, [orders, machineFilter, statusFilter, searchQuery]);

  return (
    <div className="space-y-6">
      {/* Header & Filters */}
      <div className="bg-white rounded-2xl border border-[#EED9C4] p-5 shadow-xs space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
          <div>
            <h2 className="font-display text-xl font-bold text-[#2C1E17]">Order History</h2>
            <p className="text-xs text-slate-500">
              Showing actual historical amounts charged at purchase time across your assigned machines.
            </p>
          </div>
          <div className="text-xs font-semibold text-[#8C6246]">
            Showing {filteredOrders.length} of {orders.length} order(s)
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          {/* Search */}
          <div className="relative">
            <Search className="w-4 h-4 text-slate-400 absolute left-3.5 top-2.5" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search Order ID, Beverage, or Machine..."
              className="w-full pl-9 pr-4 py-2 rounded-xl border border-[#EED9C4] bg-[#FAF6F0]/50 text-xs focus:outline-none focus:border-[#4E3629]"
            />
          </div>

          {/* Machine Filter */}
          <div className="flex items-center gap-2">
            <Filter className="w-4 h-4 text-[#8C6246] shrink-0" />
            <select
              value={machineFilter}
              onChange={(e) => setMachineFilter(e.target.value)}
              className="w-full px-3 py-2 rounded-xl border border-[#EED9C4] bg-[#FAF6F0]/50 text-xs font-semibold text-[#2C1E17]"
            >
              <option value="ALL">All Assigned Machines</option>
              {machines.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.machine_name} ({m.id})
                </option>
              ))}
            </select>
          </div>

          {/* Status Filter */}
          <div>
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
              className="w-full px-3 py-2 rounded-xl border border-[#EED9C4] bg-[#FAF6F0]/50 text-xs font-semibold text-[#2C1E17]"
            >
              <option value="ALL">All Order Statuses</option>
              <option value="COMPLETED">COMPLETED</option>
              <option value="PAID">PAID</option>
              <option value="PREPARING">PREPARING</option>
              <option value="PENDING">PENDING</option>
              <option value="FAILED">FAILED</option>
              <option value="CANCELLED">CANCELLED</option>
            </select>
          </div>
        </div>
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
                  <th className="py-3.5 px-5">Order ID</th>
                  <th className="py-3.5 px-5">Machine ID</th>
                  <th className="py-3.5 px-5">Beverage</th>
                  <th className="py-3.5 px-5">Amount Charged</th>
                  <th className="py-3.5 px-5">Payment Status</th>
                  <th className="py-3.5 px-5">Order Status</th>
                  <th className="py-3.5 px-5">Date & Time</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#EED9C4]/60 text-sm">
                {filteredOrders.map((o) => {
                  const paymentLabel = getPaymentStatusLabel(o);
                  const beverageName =
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

                  return (
                    <tr key={o.id} className="hover:bg-[#FAF6F0]/60 transition-colors">
                      <td className="py-3.5 px-5 font-mono font-bold text-xs text-[#2C1E17]">
                        {o.id}
                      </td>
                      <td className="py-3.5 px-5 font-mono text-xs text-[#8C6246] font-semibold">
                        {o.machine_id}
                      </td>
                      <td className="py-3.5 px-5 font-semibold text-[#2C1E17]">
                        {beverageName}
                      </td>
                      <td className="py-3.5 px-5 font-display font-bold text-[#4E3629]">
                        {formatINR(o.amount)}
                      </td>
                      <td className="py-3.5 px-5">
                        <span
                          className={`inline-flex px-2.5 py-0.5 rounded-full text-xs font-semibold ${
                            paymentLabel === 'PAID'
                              ? 'bg-emerald-50 text-emerald-700 border border-emerald-200'
                              : paymentLabel === 'PENDING'
                              ? 'bg-amber-50 text-amber-800 border border-amber-200'
                              : 'bg-rose-50 text-rose-700 border border-rose-200'
                          }`}
                        >
                          {paymentLabel}
                        </span>
                      </td>
                      <td className="py-3.5 px-5">
                        <OrderStatusBadge status={o.status} />
                      </td>
                      <td className="py-3.5 px-5 text-xs text-slate-600">
                        {formatDateTime(o.created_at)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

