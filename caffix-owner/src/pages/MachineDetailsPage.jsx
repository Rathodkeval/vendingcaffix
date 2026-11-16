import React, { useState, useEffect } from 'react';
import {
  MapPin,
  Clock,
  Wrench,
  PlayCircle,
  Tag,
  CheckCircle2,
  XCircle
} from 'lucide-react';
import {
  ConnectionBadge,
  ModeBadge,
  ConfirmModal
} from '../components/StatusBadges';
import { formatINR, formatDateTime, formatRelativeHeartbeat } from '../utils/formatters';
import { ownerApi } from '../services/api';

export default function MachineDetailsPage({
  machines,
  selectedMachineId,
  onSelectMachineId,
  onToggleMode,
  onNavigateToPricing
}) {
  const activeMachine =
    machines.find((m) => m.id === selectedMachineId) || machines[0] || null;

  const [machineProducts, setMachineProducts] = useState([]);
  const [loadingProducts, setLoadingProducts] = useState(false);
  const [confirmMode, setConfirmMode] = useState(null);
  const [modeLoading, setModeLoading] = useState(false);

  useEffect(() => {
    if (!activeMachine) {
      setMachineProducts([]);
      return;
    }
    let mounted = true;
    setLoadingProducts(true);
    ownerApi
      .getMachineProducts(activeMachine.id)
      .then((res) => {
        if (mounted) {
          setMachineProducts(res.data || []);
        }
      })
      .catch(() => {
        if (mounted) setMachineProducts([]);
      })
      .finally(() => {
        if (mounted) setLoadingProducts(false);
      });
    return () => {
      mounted = false;
    };
  }, [activeMachine?.id]);

  if (!activeMachine) {
    return (
      <div className="bg-white rounded-2xl border border-[#EED9C4] p-12 text-center">
        <div className="text-base font-bold text-[#2C1E17]">No Machine Selected</div>
        <p className="text-xs text-slate-500 mt-1">
          No assigned machines are available to inspect.
        </p>
      </div>
    );
  }

  const isMaintenance =
    String(activeMachine.desired_mode || '').toUpperCase() === 'MAINTENANCE';

  const handleConfirmModeToggle = async () => {
    if (!confirmMode) return;
    setModeLoading(true);
    try {
      await onToggleMode(activeMachine.id, confirmMode);
      setConfirmMode(null);
    } finally {
      setModeLoading(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Top Machine Selector Bar */}
      <div className="bg-white rounded-2xl border border-[#EED9C4] p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-4 shadow-xs">
        <div>
          <div className="text-xs font-semibold uppercase tracking-wider text-[#8C6246]">
            Machine Inspector & Telemetry
          </div>
          <h2 className="font-display text-2xl font-bold text-[#2C1E17] mt-0.5">
            {activeMachine.machine_name}{' '}
            <span className="text-sm font-mono text-[#8C6246]">({activeMachine.id})</span>
          </h2>
          <div className="flex items-center gap-1.5 text-xs text-slate-500 mt-1">
            <MapPin className="w-3.5 h-3.5 text-[#C9A66B]" />
            {activeMachine.location}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <label className="text-xs font-semibold text-slate-600">Select Machine:</label>
          <select
            value={activeMachine.id}
            onChange={(e) => onSelectMachineId(e.target.value)}
            className="px-3.5 py-2 rounded-xl border border-[#EED9C4] bg-[#FAF6F0] text-sm font-semibold text-[#2C1E17] focus:outline-none focus:border-[#4E3629]"
          >
            {machines.map((m) => (
              <option key={m.id} value={m.id}>
                {m.machine_name} ({m.id}) — {m.location}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* Connectivity & Mode Cards */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        {/* Connectivity Card */}
        <div className="bg-white rounded-2xl border border-[#EED9C4] p-6 shadow-xs space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="font-display text-base font-bold text-[#2C1E17]">
                Raspberry Pi 4 Connectivity
              </h3>
              <p className="text-xs text-slate-500">
                30-second heartbeat to Firestore (90-second offline timeout)
              </p>
            </div>
            <ConnectionBadge status={activeMachine.connection_status} />
          </div>

          <div className="p-4 rounded-xl bg-[#FAF6F0]/70 border border-[#EED9C4] space-y-2 text-xs">
            <div className="flex items-center justify-between">
              <span className="text-slate-500 flex items-center gap-1.5">
                <Clock className="w-3.5 h-3.5 text-[#8C6246]" />
                Last Seen (Relative):
              </span>
              <span className="font-bold text-[#2C1E17]">
                {formatRelativeHeartbeat(activeMachine.last_seen)}
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-slate-500">Last Heartbeat Timestamp:</span>
              <span className="font-mono text-slate-700">
                {formatDateTime(activeMachine.last_seen)}
              </span>
            </div>
          </div>
        </div>

        {/* Operational Mode Card */}
        <div className="bg-white rounded-2xl border border-[#EED9C4] p-6 shadow-xs flex flex-col justify-between space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="font-display text-base font-bold text-[#2C1E17]">
                Operational Mode (`desired_mode`)
              </h3>
              <p className="text-xs text-slate-500">
                Independent of RPi heartbeat; never overwritten by telemetry
              </p>
            </div>
            <ModeBadge mode={activeMachine.desired_mode} />
          </div>

          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pt-2">
            <p className="text-xs text-slate-600">
              {isMaintenance
                ? 'Machine is in Maintenance Mode. New orders are blocked while any paid/dispensing orders finish.'
                : 'Machine is in Running Mode and actively accepting customer orders.'}
            </p>
            <button
              type="button"
              onClick={() => setConfirmMode(isMaintenance ? 'RUNNING' : 'MAINTENANCE')}
              className={`shrink-0 inline-flex items-center gap-1.5 px-4 py-2.5 rounded-xl text-xs font-semibold transition-colors cursor-pointer ${
                isMaintenance
                  ? 'bg-emerald-600 hover:bg-emerald-700 text-white'
                  : 'bg-amber-600 hover:bg-amber-700 text-white'
              }`}
            >
              {isMaintenance ? (
                <>
                  <PlayCircle className="w-4 h-4" />
                  Switch to RUNNING
                </>
              ) : (
                <>
                  <Wrench className="w-4 h-4" />
                  Switch to MAINTENANCE
                </>
              )}
            </button>
          </div>
        </div>
      </div>

      {/* Machine-Specific Products & Pricing Summary */}
      <div className="bg-white rounded-2xl border border-[#EED9C4] p-6 shadow-xs space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-3 border-b border-[#EED9C4]">
          <div>
            <h3 className="font-display text-lg font-bold text-[#2C1E17]">
              Configured Beverage Prices & Availability ({activeMachine.id})
            </h3>
            <p className="text-xs text-slate-500">
              Prices and availability shown here apply exclusively to {activeMachine.machine_name}.
            </p>
          </div>
          <button
            type="button"
            onClick={() => onNavigateToPricing(activeMachine.id)}
            className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl text-xs font-semibold bg-[#C9A66B] hover:bg-[#B08E55] text-[#2C1E17] transition-colors cursor-pointer"
          >
            <Tag className="w-3.5 h-3.5" />
            Edit Prices & Availability
          </button>
        </div>

        {loadingProducts ? (
          <div className="py-8 text-center text-xs text-slate-500">
            Loading machine product configuration...
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3.5">
            {machineProducts.map((prod) => (
              <div
                key={prod.id}
                className={`rounded-xl border p-3.5 flex flex-col justify-between ${
                  prod.is_available
                    ? 'border-[#EED9C4] bg-[#FAF6F0]/30'
                    : 'border-slate-200 bg-slate-50 opacity-75'
                }`}
              >
                <div>
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-bold text-sm text-[#2C1E17]">{prod.name}</span>
                    {prod.is_available ? (
                      <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />
                    ) : (
                      <XCircle className="w-4 h-4 text-rose-500 shrink-0" />
                    )}
                  </div>
                  <div className="mt-2 font-display text-xl font-extrabold text-[#4E3629]">
                    {formatINR(prod.price)}
                  </div>
                </div>
                <div className="mt-2 text-[11px] font-semibold">
                  {prod.is_available ? (
                    <span className="text-emerald-700">Available on Kiosk</span>
                  ) : (
                    <span className="text-rose-600">Disabled on Kiosk</span>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <ConfirmModal
        open={Boolean(confirmMode)}
        title={
          confirmMode === 'MAINTENANCE'
            ? `Switch ${activeMachine.machine_name} (${activeMachine.id}) to Maintenance Mode?`
            : `Switch ${activeMachine.machine_name} (${activeMachine.id}) to Running Mode?`
        }
        description={
          confirmMode === 'MAINTENANCE'
            ? 'New customer orders on this kiosk will be blocked immediately. Any order that was already paid or is currently dispensing will still finish safely.'
            : 'This kiosk will immediately resume accepting customer orders.'
        }
        confirmLabel={confirmMode === 'MAINTENANCE' ? 'Enable Maintenance' : 'Resume Running'}
        variant={confirmMode === 'MAINTENANCE' ? 'warning' : 'primary'}
        loading={modeLoading}
        onCancel={() => setConfirmMode(null)}
        onConfirm={handleConfirmModeToggle}
      />
    </div>
  );
}

