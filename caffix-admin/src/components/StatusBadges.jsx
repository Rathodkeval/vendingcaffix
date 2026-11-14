import React from 'react';
import { Wifi, WifiOff, Wrench, PlayCircle, Info, AlertTriangle, X } from 'lucide-react';

export function ConnectionBadge({ status, size = 'md' }) {
  const isOnline = String(status || '').toUpperCase() === 'ONLINE';
  const padding = size === 'sm' ? 'px-2 py-0.5 text-xs' : 'px-2.5 py-1 text-xs';

  return (
    <span
      className={`inline-flex items-center gap-1.5 font-semibold rounded-full border ${padding} ${
        isOnline
          ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
          : 'bg-slate-100 text-slate-600 border-slate-300'
      }`}
      title={
        isOnline
          ? 'Raspberry Pi 4 heartbeat received within the last 90 seconds'
          : 'No Raspberry Pi 4 heartbeat received within the last 90 seconds'
      }
    >
      <span
        className={`h-2 w-2 rounded-full ${
          isOnline ? 'bg-emerald-500 animate-pulse' : 'bg-slate-400'
        }`}
      />
      {isOnline ? (
        <>
          <Wifi className="w-3.5 h-3.5" />
          ONLINE
        </>
      ) : (
        <>
          <WifiOff className="w-3.5 h-3.5" />
          OFFLINE
        </>
      )}
    </span>
  );
}

export function ModeBadge({ mode, size = 'md' }) {
  const isMaintenance = String(mode || '').toUpperCase() === 'MAINTENANCE';
  const padding = size === 'sm' ? 'px-2 py-0.5 text-xs' : 'px-2.5 py-1 text-xs';

  return (
    <span
      className={`inline-flex items-center gap-1.5 font-semibold rounded-full border ${padding} ${
        isMaintenance
          ? 'bg-amber-50 text-amber-800 border-amber-300'
          : 'bg-[#FAF6F0] text-[#4E3629] border-[#C9A66B]/50'
      }`}
    >
      {isMaintenance ? (
        <>
          <Wrench className="w-3.5 h-3.5 text-amber-700" />
          MAINTENANCE
        </>
      ) : (
        <>
          <PlayCircle className="w-3.5 h-3.5 text-emerald-700" />
          RUNNING
        </>
      )}
    </span>
  );
}

export function OrderStatusBadge({ status }) {
  const s = String(status || 'PENDING').toUpperCase();
  const styles = {
    COMPLETED: 'bg-emerald-50 text-emerald-800 border-emerald-200',
    PAID: 'bg-blue-50 text-blue-800 border-blue-200',
    PREPARING: 'bg-amber-50 text-amber-800 border-amber-200',
    PENDING: 'bg-slate-100 text-slate-700 border-slate-200',
    FAILED: 'bg-red-50 text-red-700 border-red-200',
    CANCELLED: 'bg-rose-50 text-rose-700 border-rose-200'
  };

  return (
    <span
      className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold border ${
        styles[s] || styles.PENDING
      }`}
    >
      {s}
    </span>
  );
}

export function PaymentStatusBadge({ status }) {
  const s = String(status || 'PENDING').toUpperCase();
  const styles = {
    PAID: 'bg-emerald-50 text-emerald-700 border-emerald-200',
    COMPLETED: 'bg-emerald-100 text-emerald-800 border-emerald-300',
    PENDING: 'bg-amber-50 text-amber-800 border-amber-200',
    FAILED: 'bg-rose-50 text-rose-700 border-rose-200',
    CANCELLED: 'bg-slate-100 text-slate-600 border-slate-200'
  };

  return (
    <span
      className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold border ${
        styles[s] || 'bg-slate-100 text-slate-600 border-slate-200'
      }`}
    >
      {s}
    </span>
  );
}

export function DispenseStatusBadge({ status }) {
  const s = String(status || 'PENDING').toUpperCase();
  const styles = {
    QUEUED: 'bg-sky-50 text-sky-800 border-sky-200',
    DISPENSING: 'bg-amber-50 text-amber-800 border-amber-300',
    DISPENSED: 'bg-teal-50 text-teal-800 border-teal-200',
    PENDING: 'bg-slate-100 text-slate-600 border-slate-200',
    FAILED: 'bg-rose-50 text-rose-700 border-rose-200'
  };

  return (
    <span
      className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-semibold border ${
        styles[s] || 'bg-slate-100 text-slate-600 border-slate-200'
      }`}
    >
      {s === 'DISPENSING' && (
        <span className="h-1.5 w-1.5 rounded-full bg-amber-500 animate-ping" />
      )}
      {s}
    </span>
  );
}

export function RefundStatusBadge({ status }) {
  const s = String(status || 'NONE').toUpperCase();
  const styles = {
    NONE: 'bg-slate-100 text-slate-600 border-slate-200',
    PENDING: 'bg-amber-50 text-amber-800 border-amber-200',
    PARTIAL: 'bg-indigo-50 text-indigo-800 border-indigo-200',
    FULL: 'bg-purple-50 text-purple-800 border-purple-200',
    FAILED: 'bg-rose-50 text-rose-700 border-rose-200'
  };

  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-semibold border ${
        styles[s] || styles.NONE
      }`}
    >
      {s === 'NONE' ? 'NO REFUND' : `REFUND: ${s}`}
    </span>
  );
}

export function SoftwareEstimatedBadge() {
  return (
    <span
      className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-medium bg-amber-50/90 text-[#8C6246] border border-[#C9A66B]/50"
      title="Calculated by deducting standard recipe quantities per paid order. Not from physical tank sensors."
    >
      <Info className="w-3.5 h-3.5 text-[#C9A66B]" />
      Software-Estimated (Per-Order Deduction)
    </span>
  );
}

export function UntrackedBadge() {
  return (
    <span
      className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-semibold bg-slate-100 text-slate-500 border border-slate-200"
      title="No inventory levels have been initialized or recorded for this machine."
    >
      Untracked
    </span>
  );
}

export function ReconciliationBadge({ result, reason }) {
  const r = String(result || 'MATCH').toUpperCase();
  if (r === 'MATCH') {
    return (
      <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-emerald-50 text-emerald-700 border border-emerald-200">
        <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
        RECONCILED
      </span>
    );
  }
  if (r === 'PENDING_ACTION') {
    return (
      <span
        className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-amber-50 text-amber-800 border border-amber-200"
        title={reason}
      >
        <span className="w-1.5 h-1.5 rounded-full bg-amber-500 animate-pulse" />
        PENDING ACTION
      </span>
    );
  }
  return (
    <span
      className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-rose-50 text-rose-700 border border-rose-200"
      title={reason}
    >
      <span className="w-1.5 h-1.5 rounded-full bg-rose-500" />
      DISCREPANCY
    </span>
  );
}

export function ConfirmModal({
  open,
  title,
  description,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  variant = 'primary',
  loading = false,
  onConfirm,
  onCancel
}) {
  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-xs p-4">
      <div className="bg-white rounded-2xl border border-[#EED9C4] shadow-xl max-w-md w-full p-6 animate-in fade-in zoom-in-95 duration-150">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-3">
            <div
              className={`p-2.5 rounded-xl ${
                variant === 'warning'
                  ? 'bg-amber-100 text-amber-800'
                  : 'bg-[#FAF6F0] text-[#4E3629]'
              }`}
            >
              <AlertTriangle className="w-5 h-5" />
            </div>
            <h3 className="text-lg font-bold text-[#2C1E17]">{title}</h3>
          </div>
          <button
            type="button"
            onClick={onCancel}
            disabled={loading}
            className="text-slate-400 hover:text-slate-600 p-1 rounded-lg"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <p className="mt-3 text-sm text-slate-600 leading-relaxed">{description}</p>

        <div className="mt-6 flex items-center justify-end gap-3">
          <button
            type="button"
            onClick={onCancel}
            disabled={loading}
            className="px-4 py-2 rounded-xl text-sm font-semibold text-slate-700 bg-slate-100 hover:bg-slate-200 transition-colors"
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={loading}
            className={`px-4 py-2 rounded-xl text-sm font-semibold text-white transition-colors ${
              variant === 'warning'
                ? 'bg-amber-600 hover:bg-amber-700'
                : 'bg-[#4E3629] hover:bg-[#2C1E17]'
            } disabled:opacity-60`}
          >
            {loading ? 'Processing...' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

