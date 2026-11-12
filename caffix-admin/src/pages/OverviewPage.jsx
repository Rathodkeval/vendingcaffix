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
import { ConnectionBadge, ModeBadge, SoftwareEstimatedBadge } from '../components/StatusBadges';
import {
  formatINR,
  formatDateTime,
  formatRelativeHeartbeat,
  computeSalesAnalytics
} from '../utils/formatters';

export default function OverviewPage({
  machines,
  orders,
  owners = [],
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
  const analytics = computeSalesAnalytics(orders, machines, 'all', 'ALL');

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
      label: "Today's Fleet Sales",
      value: formatINR(analytics.todayRevenue),
      sub: `${analytics.todayOrdersCount} paid order(s) today`,
      icon: IndianRupee,
      accent: 'bg-[#C9A66B] text-[#2C1E17]'
    },
    {
      label: 'Total Fleet Orders',
      value: analytics.totalOrders,
      sub: `All-time revenue: ${formatINR(analytics.totalRevenue)}`,
      icon: ShoppingBag,
      accent: 'bg-[#8C6246] text-white'
    }
  ];

  const ingredientKeys = [
    { key: 'water_level', label: 'Water' },
    { key: 'coffee_level', label: 'Coffee Beans' },
    { key: 'milk_level', label: 'Milk' },
    { key: 'vanilla_level', label: 'Vanilla Syrup' },
    { key: 'hazelnut_level', label: 'Hazelnut Syrup' },
    { key: 'irish_level', label: 'Irish Cream' },
    { key: 'mocha_level', label: 'Mocha Syrup' }
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

      {/* Software-Estimated Stock Summary */}
      <div className="bg-white rounded-2xl border border-[#EED9C4] p-6 shadow-xs">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-4 border-b border-[#EED9C4]">
          <div>
            <h2 className="font-display text-lg font-bold text-[#2C1E17]">
              Fleet Estimated Ingredient Stock Summary
            </h2>
            <p className="text-xs text-slate-500 mt-0.5">
              Calculated automatically from order deductions since last refill reset.
            </p>
          </div>
          <SoftwareEstimatedBadge />
        </div>

        {machines.length === 0 ? (
          <div className="py-8 text-center text-sm text-slate-500">
            No machine stock records to display.
          </div>
        ) : (
          <div className="mt-5 grid grid-cols-1 lg:grid-cols-2 gap-5">
            {machines.map((m) => {
              const inv = m.estimated_inventory || {};
              return (
                <div
                  key={m.id}
                  className="rounded-xl border border-[#EED9C4] bg-[#FAF6F0]/40 p-4 space-y-3"
                >
                  <div className="flex items-center justify-between">
                    <div>
                      <span className="font-bold text-sm text-[#2C1E17]">{m.machine_name}</span>
                      <span className="ml-2 text-xs font-mono text-[#8C6246]">({m.id})</span>
                    </div>
                    <button
                      type="button"
                      onClick={() => onSelectMachineForDetails(m.id)}
                      className="text-xs font-semibold text-[#4E3629] hover:underline"
                    >
                      Manage Refills →
                    </button>
                  </div>

                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
                    {ingredientKeys.map((ing) => {
                      const val = Number(inv[ing.key] ?? 100);
                      const isLow = val <= 25;
                      return (
                        <div
                          key={ing.key}
                          className="bg-white rounded-lg p-2.5 border border-[#EED9C4]/80"
                        >
                          <div className="flex items-center justify-between text-[11px] font-medium text-slate-600">
                            <span className="truncate">{ing.label}</span>
                            <span
                              className={`font-bold ${
                                isLow ? 'text-red-600' : 'text-[#4E3629]'
                              }`}
                            >
                              {val}%
                            </span>
                          </div>
                          <div className="mt-1.5 h-1.5 w-full bg-slate-100 rounded-full overflow-hidden">
                            <div
                              className={`h-full rounded-full ${
                                isLow ? 'bg-red-500' : 'bg-[#4E3629]'
                              }`}
                              style={{ width: `${Math.max(0, Math.min(100, val))}%` }}
                            />
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

