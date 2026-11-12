import React, { useState, useMemo } from 'react';
import { BarChart3, IndianRupee, ShoppingBag, TrendingUp, Cpu, Coffee } from 'lucide-react';
import { formatINR, computeSalesAnalytics } from '../utils/formatters';

export default function SalesReportsPage({ orders, machines }) {
  const [period, setPeriod] = useState('daily'); // 'daily' | 'weekly' | 'monthly' | 'all'
  const [machineFilter, setMachineFilter] = useState('ALL');

  const analytics = useMemo(
    () => computeSalesAnalytics(orders, machines, period, machineFilter),
    [orders, machines, period, machineFilter]
  );

  const periodTabs = [
    { id: 'daily', label: 'Daily (Last 7 Days)' },
    { id: 'weekly', label: 'Weekly (Last 4 Weeks)' },
    { id: 'monthly', label: 'Monthly (Last 6 Months)' },
    { id: 'all', label: 'All-Time' }
  ];

  const maxBucketRevenue = useMemo(() => {
    if (!analytics.periodBreakdown.length) return 1;
    return Math.max(...analytics.periodBreakdown.map((b) => b.revenue), 1);
  }, [analytics.periodBreakdown]);

  return (
    <div className="space-y-6">
      {/* Controls Bar */}
      <div className="bg-white rounded-2xl border border-[#EED9C4] p-5 flex flex-col lg:flex-row lg:items-center justify-between gap-4 shadow-xs">
        <div>
          <h2 className="font-display text-xl font-bold text-[#2C1E17]">
            Sales & Revenue Reports
          </h2>
          <p className="text-xs text-slate-500 mt-0.5">
            Calculated from stored historical order amounts at time of sale (unaffected by later price changes).
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          {/* Period Switcher */}
          <div className="inline-flex p-1 rounded-xl bg-[#FAF6F0] border border-[#EED9C4]">
            {periodTabs.map((tab) => (
              <button
                key={tab.id}
                type="button"
                onClick={() => setPeriod(tab.id)}
                className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-all cursor-pointer ${
                  period === tab.id
                    ? 'bg-[#4E3629] text-white shadow-xs'
                    : 'text-[#8C6246] hover:text-[#2C1E17]'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>

          {/* Machine Filter */}
          <select
            value={machineFilter}
            onChange={(e) => setMachineFilter(e.target.value)}
            className="px-3.5 py-2 rounded-xl border border-[#EED9C4] bg-[#FAF6F0] text-xs font-semibold text-[#2C1E17]"
          >
            <option value="ALL">All Assigned Machines</option>
            {machines.map((m) => (
              <option key={m.id} value={m.id}>
                {m.machine_name} ({m.id})
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* Summary KPI Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div className="bg-white rounded-2xl border border-[#EED9C4] p-5 shadow-xs flex items-start justify-between">
          <div>
            <div className="text-xs font-semibold uppercase tracking-wider text-slate-500">
              Period Revenue
            </div>
            <div className="font-display text-3xl font-extrabold text-[#2C1E17] mt-1">
              {formatINR(analytics.totalRevenue)}
            </div>
            <div className="text-xs text-slate-500 mt-1">
              Today: {formatINR(analytics.todayRevenue)} ({analytics.todayOrdersCount} orders)
            </div>
          </div>
          <div className="p-3 rounded-xl bg-[#4E3629] text-white">
            <IndianRupee className="w-5 h-5" />
          </div>
        </div>

        <div className="bg-white rounded-2xl border border-[#EED9C4] p-5 shadow-xs flex items-start justify-between">
          <div>
            <div className="text-xs font-semibold uppercase tracking-wider text-slate-500">
              Paid / Completed Orders
            </div>
            <div className="font-display text-3xl font-extrabold text-[#2C1E17] mt-1">
              {analytics.totalOrders}
            </div>
            <div className="text-xs text-slate-500 mt-1">
              Verified paid orders in selected period
            </div>
          </div>
          <div className="p-3 rounded-xl bg-[#C9A66B] text-[#2C1E17]">
            <ShoppingBag className="w-5 h-5" />
          </div>
        </div>

        <div className="bg-white rounded-2xl border border-[#EED9C4] p-5 shadow-xs flex items-start justify-between">
          <div>
            <div className="text-xs font-semibold uppercase tracking-wider text-slate-500">
              Average Order Value
            </div>
            <div className="font-display text-3xl font-extrabold text-[#2C1E17] mt-1">
              {formatINR(analytics.averageOrderValue)}
            </div>
            <div className="text-xs text-slate-500 mt-1">
              Based on historical transaction amounts
            </div>
          </div>
          <div className="p-3 rounded-xl bg-[#8C6246] text-white">
            <TrendingUp className="w-5 h-5" />
          </div>
        </div>
      </div>

      {/* Visual Revenue Trend Chart */}
      <div className="bg-white rounded-2xl border border-[#EED9C4] p-6 shadow-xs space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="font-display text-base font-bold text-[#2C1E17] flex items-center gap-2">
              <BarChart3 className="w-4 h-4 text-[#4E3629]" />
              {period === 'daily'
                ? 'Daily Revenue Breakdown'
                : period === 'weekly'
                ? 'Weekly Revenue Breakdown'
                : period === 'monthly'
                ? 'Monthly Revenue Breakdown'
                : 'Historical Revenue Breakdown'}
            </h3>
            <p className="text-xs text-slate-500">
              Revenue (INR) and order volume per time bucket
            </p>
          </div>
        </div>

        {analytics.periodBreakdown.length === 0 ? (
          <div className="py-10 text-center text-xs text-slate-500">
            No paid orders recorded in this time window.
          </div>
        ) : (
          <div className="space-y-3 pt-2">
            {analytics.periodBreakdown.map((bucket) => {
              const widthPct = Math.max(
                4,
                Math.round((bucket.revenue / maxBucketRevenue) * 100)
              );
              return (
                <div key={bucket.key} className="space-y-1">
                  <div className="flex items-center justify-between text-xs">
                    <span className="font-semibold text-[#2C1E17]">{bucket.label}</span>
                    <span className="font-bold text-[#4E3629]">
                      {formatINR(bucket.revenue)}{' '}
                      <span className="text-slate-400 font-normal">
                        ({bucket.orders_count} order{bucket.orders_count === 1 ? '' : 's'})
                      </span>
                    </span>
                  </div>
                  <div className="h-3 w-full bg-[#FAF6F0] rounded-full overflow-hidden border border-[#EED9C4]/70">
                    <div
                      className="h-full bg-gradient-to-r from-[#4E3629] to-[#C9A66B] rounded-full transition-all duration-300"
                      style={{ width: `${widthPct}%` }}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Revenue by Machine & Product-Wise Sales Tables */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Revenue by Machine */}
        <div className="bg-white rounded-2xl border border-[#EED9C4] shadow-xs overflow-hidden">
          <div className="px-6 py-4 border-b border-[#EED9C4] flex items-center justify-between">
            <div>
              <h3 className="font-display text-base font-bold text-[#2C1E17] flex items-center gap-2">
                <Cpu className="w-4 h-4 text-[#4E3629]" />
                Revenue by Machine
              </h3>
              <p className="text-xs text-slate-500">
                Machine-level order count and revenue contribution
              </p>
            </div>
          </div>

          {analytics.revenueByMachine.length === 0 ? (
            <div className="p-8 text-center text-xs text-slate-500">
              No machine revenue data available.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="bg-[#FAF6F0] text-[11px] font-semibold uppercase tracking-wider text-[#8C6246] border-b border-[#EED9C4]">
                    <th className="py-3 px-5">Machine</th>
                    <th className="py-3 px-5">Location</th>
                    <th className="py-3 px-5 text-right">Orders</th>
                    <th className="py-3 px-5 text-right">Revenue</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#EED9C4]/60 text-sm">
                  {analytics.revenueByMachine.map((row) => (
                    <tr key={row.machine_id} className="hover:bg-[#FAF6F0]/50">
                      <td className="py-3 px-5">
                        <div className="font-bold text-[#2C1E17]">{row.machine_name}</div>
                        <div className="text-xs font-mono text-[#8C6246]">{row.machine_id}</div>
                      </td>
                      <td className="py-3 px-5 text-xs text-slate-600">{row.location}</td>
                      <td className="py-3 px-5 text-right font-semibold text-[#2C1E17]">
                        {row.orders_count}
                      </td>
                      <td className="py-3 px-5 text-right font-display font-bold text-[#4E3629]">
                        {formatINR(row.revenue)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Product-Wise Sales */}
        <div className="bg-white rounded-2xl border border-[#EED9C4] shadow-xs overflow-hidden">
          <div className="px-6 py-4 border-b border-[#EED9C4] flex items-center justify-between">
            <div>
              <h3 className="font-display text-base font-bold text-[#2C1E17] flex items-center gap-2">
                <Coffee className="w-4 h-4 text-[#4E3629]" />
                Product-Wise Sales
              </h3>
              <p className="text-xs text-slate-500">
                Beverage popularity and actual historical revenue share
              </p>
            </div>
          </div>

          {analytics.productSales.length === 0 ? (
            <div className="p-8 text-center text-xs text-slate-500">
              No product sales recorded in this period.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="bg-[#FAF6F0] text-[11px] font-semibold uppercase tracking-wider text-[#8C6246] border-b border-[#EED9C4]">
                    <th className="py-3 px-5">Beverage</th>
                    <th className="py-3 px-5 text-right">Cups Sold</th>
                    <th className="py-3 px-5 text-right">Share</th>
                    <th className="py-3 px-5 text-right">Revenue</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#EED9C4]/60 text-sm">
                  {analytics.productSales.map((prod) => (
                    <tr key={prod.product_name} className="hover:bg-[#FAF6F0]/50">
                      <td className="py-3 px-5 font-bold text-[#2C1E17]">
                        {prod.product_name}
                      </td>
                      <td className="py-3 px-5 text-right font-semibold text-[#2C1E17]">
                        {prod.orders_count}
                      </td>
                      <td className="py-3 px-5 text-right text-xs font-semibold text-[#8C6246]">
                        {prod.share_percent}%
                      </td>
                      <td className="py-3 px-5 text-right font-display font-bold text-[#4E3629]">
                        {formatINR(prod.revenue)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

