import React, { useState } from 'react';
import { MapPin, Clock, Wrench, PlayCircle, Sliders, Tag, Users } from 'lucide-react';
import {
  ConnectionBadge,
  ModeBadge,
  SoftwareEstimatedBadge,
  ConfirmModal
} from '../components/StatusBadges';
import { formatDateTime, formatRelativeHeartbeat } from '../utils/formatters';

export default function MachinesPage({
  machines,
  owners = [],
  onToggleMode,
  onSelectMachineForDetails,
  onSelectMachineForPricing
}) {
  const [confirmState, setConfirmState] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  const ownerMap = new Map(owners.map((o) => [String(o.id), o]));

  const handleConfirmToggle = async () => {
    if (!confirmState) return;
    setSubmitting(true);
    try {
      await onToggleMode(confirmState.machine.id, confirmState.nextMode);
      setConfirmState(null);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h2 className="font-display text-xl font-bold text-[#2C1E17]">
            All Registered Vending Machines
          </h2>
          <p className="text-xs text-slate-500 mt-0.5">
            Connectivity is determined by the 30-second Raspberry Pi 4 heartbeat (90s offline timeout).
            Super Admins can inspect telemetry and toggle operational modes across the entire fleet.
          </p>
        </div>
        <SoftwareEstimatedBadge />
      </div>

      {machines.length === 0 ? (
        <div className="bg-white rounded-2xl border border-[#EED9C4] p-12 text-center">
          <div className="text-base font-bold text-[#2C1E17]">No Vending Machines Registered</div>
          <p className="text-xs text-slate-500 mt-1">
            Use Fleet & Owners to register a new vending machine unit.
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
          {machines.map((m) => {
            const isMaintenance = String(m.desired_mode || '').toUpperCase() === 'MAINTENANCE';
            const nextMode = isMaintenance ? 'RUNNING' : 'MAINTENANCE';
            const matchedOwner = m.owner_id ? ownerMap.get(String(m.owner_id)) : null;

            return (
              <div
                key={m.id}
                className="bg-white rounded-2xl border border-[#EED9C4] shadow-xs p-6 flex flex-col justify-between space-y-5"
              >
                <div>
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <span className="inline-block text-xs font-mono font-bold px-2.5 py-0.5 rounded-md bg-[#FAF6F0] text-[#8C6246] border border-[#EED9C4]">
                        {m.id}
                      </span>
                      <h3 className="font-display text-xl font-bold text-[#2C1E17] mt-1.5">
                        {m.machine_name}
                      </h3>
                      <div className="flex items-center gap-1.5 text-xs text-slate-500 mt-1">
                        <MapPin className="w-3.5 h-3.5 text-[#C9A66B]" />
                        {m.location}
                      </div>
                      <div className="flex items-center gap-1.5 text-xs text-slate-500 mt-1">
                        <Users className="w-3.5 h-3.5 text-[#8C6246]" />
                        <span>
                          Owner:{' '}
                          {m.owner_id ? (
                            <span className="font-semibold text-[#2C1E17]">
                              {matchedOwner ? `${matchedOwner.name} (${matchedOwner.email})` : m.owner_id}
                            </span>
                          ) : (
                            <span className="italic text-slate-400">Unassigned</span>
                          )}
                        </span>
                      </div>
                    </div>

                    <div className="flex flex-col items-end gap-2">
                      <ConnectionBadge status={m.connection_status} />
                      <ModeBadge mode={m.desired_mode} />
                    </div>
                  </div>

                  {/* Heartbeat Box */}
                  <div className="mt-4 p-3.5 rounded-xl bg-[#FAF6F0]/70 border border-[#EED9C4] flex items-center justify-between text-xs">
                    <span className="text-slate-600 flex items-center gap-1.5 font-medium">
                      <Clock className="w-4 h-4 text-[#8C6246]" />
                      Last RPi Heartbeat:
                    </span>
                    <div className="text-right">
                      <span className="font-bold text-[#2C1E17]">
                        {formatRelativeHeartbeat(m.last_seen)}
                      </span>
                      <span className="block text-[11px] text-slate-400">
                        {formatDateTime(m.last_seen)}
                      </span>
                    </div>
                  </div>
                </div>

                {/* Actions Footer */}
                <div className="pt-3 border-t border-[#EED9C4] flex flex-wrap items-center justify-between gap-2">
                  <button
                    type="button"
                    onClick={() =>
                      setConfirmState({
                        machine: m,
                        nextMode
                      })
                    }
                    className={`inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-xs font-semibold border transition-colors cursor-pointer ${
                      isMaintenance
                        ? 'bg-emerald-50 text-emerald-800 border-emerald-200 hover:bg-emerald-100'
                        : 'bg-amber-50 text-amber-800 border-amber-200 hover:bg-amber-100'
                    }`}
                  >
                    {isMaintenance ? (
                      <>
                        <PlayCircle className="w-4 h-4" />
                        Resume Running Mode
                      </>
                    ) : (
                      <>
                        <Wrench className="w-4 h-4" />
                        Enter Maintenance Mode
                      </>
                    )}
                  </button>

                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => onSelectMachineForPricing(m.id)}
                      className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-xs font-semibold bg-[#FAF6F0] hover:bg-[#EED9C4] text-[#4E3629] transition-colors cursor-pointer"
                    >
                      <Tag className="w-3.5 h-3.5" />
                      Pricing
                    </button>
                    <button
                      type="button"
                      onClick={() => onSelectMachineForDetails(m.id)}
                      className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-xs font-semibold bg-[#4E3629] hover:bg-[#2C1E17] text-white transition-colors cursor-pointer"
                    >
                      <Sliders className="w-3.5 h-3.5" />
                      Machine Details
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <ConfirmModal
        open={Boolean(confirmState)}
        title={
          confirmState?.nextMode === 'MAINTENANCE'
            ? `Put ${confirmState?.machine?.machine_name} (${confirmState?.machine?.id}) in Maintenance Mode?`
            : `Resume Running Mode on ${confirmState?.machine?.machine_name} (${confirmState?.machine?.id})?`
        }
        description={
          confirmState?.nextMode === 'MAINTENANCE'
            ? 'Safe Maintenance Transition: New kiosk orders will be blocked immediately, while any already-paid or actively dispensing orders will be allowed to complete normally.'
            : 'The kiosk will immediately resume accepting new customer orders at its configured per-machine prices.'
        }
        confirmLabel={
          confirmState?.nextMode === 'MAINTENANCE'
            ? 'Enable Maintenance Mode'
            : 'Resume Running Mode'
        }
        variant={confirmState?.nextMode === 'MAINTENANCE' ? 'warning' : 'primary'}
        loading={submitting}
        onCancel={() => setConfirmState(null)}
        onConfirm={handleConfirmToggle}
      />
    </div>
  );
}

