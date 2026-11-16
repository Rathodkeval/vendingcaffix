import React from 'react';
import {
  Cpu,
  Wifi,
  WifiOff,
  Wrench,
  IndianRupee,
  ShoppingBag,
  ArrowUpRight,
  MapPin,
  Clock
} from 'lucide-react';
import { ConnectionBadge, ModeBadge } from '../components/StatusBadges';
import {
  formatINR,
  formatSignedINR,
  formatDateTime,
  formatRelativeHeartbeat,
  computeSalesAnalytics
} from '../utils/formatters';

export default function OverviewPage({
  machines,
  orders,
  owners = [],
  analyticsOverview = null,
  onSelectMachineForDetails,
  onSelectMachineForPricing,
  onNavigateTab
}) {
  const totalMachines = machines.length;
  const onlineMachines = machines.filter(
    (m) => String(m.connection_status || '').toUpperCase() === 'ONLINE'
  ).length;
  const offlineMachines = totalMachines - onlineMachines;
  const maintenanceMachines = machines.filter(
    (m) => String(m.desired_mode || '').toUpperCase() === 'MAINTENANCE'
  ).length;

  const ownerMap = new Map(owners.map((o) => [String(o.id), o]));
  const computed = computeSalesAnalytics(orders, machines, 'all', 'ALL');

  const todaySummary = analyticsOverview?.today || null;
  const allSummary = analyticsOverview?.all || null;

  const todayGrossRevenue = todaySummary
    ? (todaySummary.gross_sales_inr ?? Math.round(Number(todaySummary.gross_sales_paise || 0) / 100))
    : computed.todayGrossRevenue;
  const todayRefunds = todaySummary
    ? (todaySummary.processed_refunds_inr ?? Math.round(Number(todaySummary.processed_refunds_paise || 0) / 100))
    : computed.todayRefunds;
  const todayNetRevenue = todaySummary
    ? (todaySummary.net_revenue_inr ?? Math.round(Number(todaySummary.net_revenue_paise || 0) / 100))
    : computed.todayNetRevenue;
  const todayOrdersCount = todaySummary ? Number(todaySummary.paid_orders_count || 0) : computed.todayOrdersCount;

  const allGrossRevenue = allSummary
    ? (allSummary.gross_sales_inr ?? Math.round(Number(allSummary.gross_sales_paise || 0) / 100))
    : computed.grossRevenue;
  const allRefunds = allSummary
    ? (allSummary.processed_refunds_inr ?? Math.round(Number(allSummary.processed_refunds_paise || 0) / 100))
    : computed.refunds;
  const allNetRevenue = allSummary
    ? (allSummary.net_revenue_inr ?? Math.round(Number(allSummary.net_revenue_paise || 0) / 100))
    : computed.netRevenue;
  const allOrdersCount = allSummary ? Number(allSummary.paid_orders_count || 0) : computed.totalOrders;

  const kpis = [
    {
      label: 'Total Fleet Machines',
      value: totalMachines,
      sub: `${owners.length} registered owner account(s)`,
      icon: Cpu,
      accent: 'bg-[#4E3629] text-white'
    },
    {
      label: 'Online Machines',
      value: onlineMachines,
      sub: 'RPi heartbeat within last 90s',
      icon: Wifi,
      accent: 'bg-emerald-600 text-white'
    },
    {
      label: 'Offline Machines',
      value: offlineMachines,
      sub: 'No heartbeat in >90s',
      icon: WifiOff,
      accent: 'bg-slate-600 text-white'
    },
    {
      label: 'In Maintenance Mode',
      value: maintenanceMachines,
      sub: 'New orders paused safely',
      icon: Wrench,
      accent: 'bg-amber-600 text-white'
    },
    {
      label: "Today's Fleet Net Revenue",
      value: formatSignedINR(todayNetRevenue),
      sub: `${todayOrdersCount} paid order(s) today • Gross ${formatINR(todayGrossRevenue)} − Refunds ${formatINR(todayRefunds)}`,
      icon: IndianRupee,
      accent: 'bg-[#C9A66B] text-[#2C1E17]'
    },
    {
      label: 'All-Time Net Revenue',
      value: formatSignedINR(allNetRevenue),
      sub: `${allOrdersCount} paid order(s) • Gross ${formatINR(allGrossRevenue)} − Refunds ${formatINR(allRefunds)}`,
      icon: ShoppingBag,
      accent: 'bg-[#8C6246] text-white'
    }
  ];

  return (
    <div className="space-y-8">
      {/* KPI Grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4">
        {kpis.map((kpi) => {
          const Icon = kpi.icon;
          return (
            <div
              key={kpi.label}
              className="bg-white rounded-2xl border border-[#EED9C4] p-5 shadow-xs flex items-start justify-between"
            >
              <div>
                <div className="text-xs font-semibold uppercase tracking-wider text-slate-500">
                  {kpi.label}
                </div>
                <div className="font-display text-2xl sm:text-3xl font-extrabold text-[#2C1E17] mt-1.5">
                  {kpi.value}
                </div>
                <div className="text-xs text-slate-500 mt-1">{kpi.sub}</div>
              </div>
              <div className={`p-3 rounded-xl ${kpi.accent}`}>
                <Icon className="w-5 h-5" />
              </div>
            </div>
          );
        })}
      </div>

      {/* Authoritative Revenue Breakdown (Gross, Refunds, Net) */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="bg-white rounded-2xl border border-[#EED9C4] p-4 shadow-xs">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">
            Gross Revenue (All-Time)
          </div>
          <div className="font-display text-xl font-extrabold text-[#2C1E17] mt-1">
            {formatINR(allGrossRevenue)}
          </div>
          <div className="text-xs text-slate-500 mt-0.5">
            Today: {formatINR(todayGrossRevenue)} • {allOrdersCount} verified paid order(s)
          </div>
        </div>
        <div className="bg-white rounded-2xl border border-[#EED9C4] p-4 shadow-xs">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-rose-700">
            Processed Refunds (All-Time)
          </div>
          <div className="font-display text-xl font-extrabold text-rose-700 mt-1">
            {formatINR(allRefunds)}
          </div>
          <div className="text-xs text-slate-500 mt-0.5">
            Today: {formatINR(todayRefunds)} • Deducted from net revenue
          </div>
        </div>
        <div className="bg-white rounded-2xl border border-[#EED9C4] p-4 shadow-xs">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-emerald-700">
            Net Revenue (All-Time)
          </div>
          <div className="font-display text-xl font-extrabold text-emerald-700 mt-1">
            {formatSignedINR(allNetRevenue)}
          </div>
          <div className="text-xs text-slate-500 mt-0.5">
            Today: {formatSignedINR(todayNetRevenue)} • Gross minus processed refunds
          </div>
        </div>
      </div>

      {/* Global Fleet Status Overview */}
      <div className="bg-white rounded-2xl border border-[#EED9C4] shadow-xs overflow-hidden">
        <div className="px-6 py-4 border-b border-[#EED9C4] flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
          <div>
            <h2 className="font-display text-lg font-bold text-[#2C1E17]">
              All Registered Vending Machines
            </h2>
            <p className="text-xs text-slate-500">
              Live Raspberry Pi 4 connectivity status, operational mode, and current owner across all units
            </p>
          </div>
          <div className="flex items-center gap-4">
            <button
              type="button"
              onClick={() => onNavigateTab('admin')}
              className="inline-flex items-center gap-1.5 text-xs font-semibold text-[#8C6246] hover:text-[#2C1E17]"
            >
              Manage Fleet & Owners
              <ArrowUpRight className="w-4 h-4" />
            </button>
            <button
              type="button"
              onClick={() => onNavigateTab('machines')}
              className="inline-flex items-center gap-1.5 text-xs font-semibold text-[#4E3629] hover:text-[#2C1E17]"
            >
              View All Machines
              <ArrowUpRight className="w-4 h-4" />
            </button>
          </div>
        </div>

        {machines.length === 0 ? (
          <div className="p-10 text-center text-sm text-slate-500">
            No vending machines registered yet. Open Fleet & Owners to register a kiosk.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="bg-[#FAF6F0] text-[11px] font-semibold uppercase tracking-wider text-[#8C6246] border-b border-[#EED9C4]">
                  <th className="py-3.5 px-5">Machine</th>
                  <th className="py-3.5 px-5">Location</th>
                  <th className="py-3.5 px-5">Assigned Owner</th>
                  <th className="py-3.5 px-5">RPi Connectivity</th>
                  <th className="py-3.5 px-5">Operational Mode</th>
                  <th className="py-3.5 px-5">Last Heartbeat</th>
                  <th className="py-3.5 px-5 text-right">Quick Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#EED9C4]/60 text-sm">
                {machines.map((m) => {
                  const assignedOwner = m.owner_id ? ownerMap.get(String(m.owner_id)) : null;
                  return (
                    <tr key={m.id} className="hover:bg-[#FAF6F0]/60 transition-colors">
                      <td className="py-3.5 px-5">
                        <div className="font-bold text-[#2C1E17]">{m.machine_name}</div>
                        <div className="text-xs font-mono text-[#8C6246]">{m.id}</div>
                      </td>
                      <td className="py-3.5 px-5 text-slate-600">
                        <span className="inline-flex items-center gap-1.5">
                          <MapPin className="w-3.5 h-3.5 text-[#C9A66B]" />
                          {m.location}
                        </span>
                      </td>
                      <td className="py-3.5 px-5 text-xs">
                        {m.owner_id ? (
                          <div>
                            <div className="font-semibold text-[#2C1E17]">
                              {assignedOwner ? assignedOwner.name : 'Assigned'}
                            </div>
                            <div className="font-mono text-[11px] text-slate-400">
                              {assignedOwner ? assignedOwner.email : m.owner_id}
                            </div>
                          </div>
                        ) : (
                          <span className="text-slate-400 italic">Unassigned</span>
                        )}
                      </td>
                      <td className="py-3.5 px-5">
                        <ConnectionBadge status={m.connection_status} />
                      </td>
                      <td className="py-3.5 px-5">
                        <ModeBadge mode={m.desired_mode} />
                      </td>
                      <td className="py-3.5 px-5 text-xs text-slate-600">
                        <div className="flex items-center gap-1 font-medium text-[#2C1E17]">
                          <Clock className="w-3.5 h-3.5 text-slate-400" />
                          {formatRelativeHeartbeat(m.last_seen)}
                        </div>
                        <div className="text-[11px] text-slate-400">
                          {formatDateTime(m.last_seen)}
                        </div>
                      </td>
                      <td className="py-3.5 px-5 text-right space-x-2">
                        <button
                          type="button"
                          onClick={() => onSelectMachineForDetails(m.id)}
                          className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-[#FAF6F0] hover:bg-[#EED9C4] text-[#4E3629] transition-colors"
                        >
                          Details
                        </button>
                        <button
                          type="button"
                          onClick={() => onSelectMachineForPricing(m.id)}
                          className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-[#4E3629] hover:bg-[#2C1E17] text-white transition-colors"
                        >
                          Pricing
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
    </div>
  );
}

