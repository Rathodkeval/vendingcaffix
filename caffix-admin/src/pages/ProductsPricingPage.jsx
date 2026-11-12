import React, { useState, useEffect } from 'react';
import { Save, CheckCircle2, AlertCircle, RefreshCw } from 'lucide-react';
import { adminApi } from '../services/api';
import { formatINR } from '../utils/formatters';

export default function ProductsPricingPage({
  machines,
  selectedMachineId,
  onSelectMachineId
}) {
  const activeMachine =
    machines.find((m) => m.id === selectedMachineId) || machines[0] || null;

  const [products, setProducts] = useState([]);
  const [drafts, setDrafts] = useState({});
  const [loading, setLoading] = useState(false);
  const [savingId, setSavingId] = useState(null);
  const [savingAll, setSavingAll] = useState(false);
  const [error, setError] = useState('');
  const [successMsg, setSuccessMsg] = useState('');

  const loadMachineProducts = async (machineId) => {
    if (!machineId) return;
    setLoading(true);
    setError('');
    try {
      const res = await adminApi.getMachineProducts(machineId);
      const list = res.data || [];
      setProducts(list);
      const initialDrafts = {};
      for (const p of list) {
        initialDrafts[p.id] = {
          price: Number(p.price),
          is_available: Boolean(p.is_available)
        };
      }
      setDrafts(initialDrafts);
    } catch (err) {
      setError(err.message || 'Failed to load products for this machine.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (activeMachine?.id) {
      setSuccessMsg('');
      loadMachineProducts(activeMachine.id);
    }
  }, [activeMachine?.id]);

  if (!activeMachine) {
    return (
      <div className="bg-white rounded-2xl border border-[#EED9C4] p-12 text-center">
        <div className="text-base font-bold text-[#2C1E17]">No Machine Available</div>
        <p className="text-xs text-slate-500 mt-1">
          Register a vending machine in Fleet & Owners to configure per-machine pricing.
        </p>
      </div>
    );
  }

  const handleDraftChange = (productId, field, value) => {
    setSuccessMsg('');
    setError('');
    setDrafts((prev) => ({
      ...prev,
      [productId]: {
        ...prev[productId],
        [field]: value
      }
    }));
  };

  const handleSaveSingle = async (product) => {
    const draft = drafts[product.id];
    if (!draft) return;
    const parsedPrice = Number(draft.price);
    if (!Number.isInteger(parsedPrice) || parsedPrice <= 0) {
      setError(`Price for ${product.name} must be a positive whole number in INR.`);
      return;
    }

    setSavingId(product.id);
    setError('');
    setSuccessMsg('');
    try {
      await adminApi.updateMachineProduct(activeMachine.id, product.id, {
        price: parsedPrice,
        is_available: Boolean(draft.is_available)
      });
      await loadMachineProducts(activeMachine.id);
      setSuccessMsg(
        `Saved ${product.name} on ${activeMachine.machine_name} (${activeMachine.id}): ${formatINR(
          parsedPrice
        )} (${draft.is_available ? 'Available' : 'Unavailable'}).`
      );
    } catch (err) {
      setError(err.message || `Failed to update ${product.name}.`);
    } finally {
      setSavingId(null);
    }
  };

  const handleSaveAll = async () => {
    setSavingAll(true);
    setError('');
    setSuccessMsg('');
    try {
      for (const p of products) {
        const draft = drafts[p.id];
        if (!draft) continue;
        const parsedPrice = Number(draft.price);
        if (!Number.isInteger(parsedPrice) || parsedPrice <= 0) {
          throw new Error(`Price for ${p.name} must be a positive whole number.`);
        }
        const changed =
          parsedPrice !== Number(p.price) ||
          Boolean(draft.is_available) !== Boolean(p.is_available);
        if (changed) {
          await adminApi.updateMachineProduct(activeMachine.id, p.id, {
            price: parsedPrice,
            is_available: Boolean(draft.is_available)
          });
        }
      }
      await loadMachineProducts(activeMachine.id);
      setSuccessMsg(
        `All product prices and availability settings saved for ${activeMachine.machine_name} (${activeMachine.id}).`
      );
    } catch (err) {
      setError(err.message || 'Failed to save product updates.');
    } finally {
      setSavingAll(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Header & Machine Selector */}
      <div className="bg-white rounded-2xl border border-[#EED9C4] p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-4 shadow-xs">
        <div>
          <h2 className="font-display text-xl font-bold text-[#2C1E17]">
            Fleet Products & Per-Machine Pricing
          </h2>
          <p className="text-xs text-slate-500 mt-0.5">
            Each vending machine maintains independent prices and availability. Changes on{' '}
            <span className="font-semibold text-[#4E3629]">{activeMachine.id}</span> never affect
            other machines.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <select
            value={activeMachine.id}
            onChange={(e) => onSelectMachineId(e.target.value)}
            className="px-3.5 py-2 rounded-xl border border-[#EED9C4] bg-[#FAF6F0] text-sm font-semibold text-[#2C1E17] focus:outline-none focus:border-[#4E3629]"
          >
            {machines.map((m) => (
              <option key={m.id} value={m.id}>
                {m.machine_name} ({m.id})
              </option>
            ))}
          </select>

          <button
            type="button"
            disabled={savingAll || loading}
            onClick={handleSaveAll}
            className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl text-xs font-semibold bg-[#4E3629] hover:bg-[#2C1E17] text-white transition-colors disabled:opacity-60 cursor-pointer"
          >
            <Save className="w-3.5 h-3.5" />
            {savingAll ? 'Saving All...' : 'Save All Changes'}
          </button>
        </div>
      </div>

      {error && (
        <div className="p-4 rounded-xl bg-red-50 border border-red-200 text-red-700 text-xs font-semibold flex items-center gap-2">
          <AlertCircle className="w-4 h-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {successMsg && (
        <div className="p-4 rounded-xl bg-emerald-50 border border-emerald-200 text-emerald-800 text-xs font-semibold flex items-center gap-2">
          <CheckCircle2 className="w-4 h-4 shrink-0" />
          <span>{successMsg}</span>
        </div>
      )}

      {loading ? (
        <div className="bg-white rounded-2xl border border-[#EED9C4] p-12 text-center text-sm text-slate-500 flex items-center justify-center gap-2">
          <RefreshCw className="w-4 h-4 animate-spin text-[#4E3629]" />
          Loading beverage catalog for {activeMachine.id}...
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-5">
          {products.map((product) => {
            const draft = drafts[product.id] || {
              price: product.price,
              is_available: product.is_available
            };
            const hasUnsavedChanges =
              Number(draft.price) !== Number(product.price) ||
              Boolean(draft.is_available) !== Boolean(product.is_available);

            return (
              <div
                key={product.id}
                className={`bg-white rounded-2xl border p-5 shadow-xs flex flex-col justify-between space-y-4 transition-all ${
                  draft.is_available ? 'border-[#EED9C4]' : 'border-slate-300 bg-slate-50/70'
                }`}
              >
                <div className="flex items-start gap-4">
                  <img
                    src={product.image || '/assets/classic_crest.png'}
                    alt={product.name}
                    className="w-16 h-16 rounded-2xl object-cover bg-[#FAF6F0] border border-[#EED9C4] shrink-0"
                  />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-[11px] font-mono font-semibold text-[#8C6246]">
                        Product #{product.id}
                      </span>
                      <span className="text-[11px] text-slate-400">
                        Catalog default: {formatINR(product.default_price || 100)}
                      </span>
                    </div>
                    <h3 className="font-display text-lg font-bold text-[#2C1E17] truncate">
                      {product.name}
                    </h3>
                    <p className="text-xs text-slate-500 line-clamp-2 mt-0.5">
                      {product.description}
                    </p>
                  </div>
                </div>

                {/* Price & Availability Controls */}
                <div className="pt-3 border-t border-[#EED9C4]/80 space-y-3">
                  <div>
                    <label className="block text-xs font-semibold text-[#4E3629] mb-1">
                      Machine Price on {activeMachine.id} (INR ₹)
                    </label>
                    <div className="relative">
                      <span className="absolute left-3.5 top-2.5 text-sm font-bold text-[#8C6246]">
                        ₹
                      </span>
                      <input
                        type="number"
                        min={1}
                        step={1}
                        value={draft.price}
                        onChange={(e) =>
                          handleDraftChange(product.id, 'price', e.target.value)
                        }
                        className="w-full pl-8 pr-4 py-2 rounded-xl border border-[#EED9C4] bg-[#FAF6F0]/60 text-sm font-bold text-[#2C1E17] focus:outline-none focus:border-[#4E3629] focus:bg-white"
                      />
                    </div>
                  </div>

                  <div className="flex items-center justify-between p-3 rounded-xl bg-[#FAF6F0]/60 border border-[#EED9C4]">
                    <div>
                      <div className="text-xs font-semibold text-[#2C1E17]">
                        Kiosk Availability
                      </div>
                      <div className="text-[11px] text-slate-500">
                        {draft.is_available
                          ? 'Customers can order this drink'
                          : 'Blocked from new kiosk orders'}
                      </div>
                    </div>

                    <button
                      type="button"
                      onClick={() =>
                        handleDraftChange(product.id, 'is_available', !draft.is_available)
                      }
                      className={`px-3 py-1.5 rounded-full text-xs font-bold transition-colors cursor-pointer ${
                        draft.is_available
                          ? 'bg-emerald-600 text-white'
                          : 'bg-rose-100 text-rose-700 border border-rose-200'
                      }`}
                    >
                      {draft.is_available ? 'Available' : 'Unavailable'}
                    </button>
                  </div>
                </div>

                {/* Save Button */}
                <button
                  type="button"
                  disabled={savingId === product.id}
                  onClick={() => handleSaveSingle(product)}
                  className={`w-full py-2.5 px-4 rounded-xl text-xs font-semibold flex items-center justify-center gap-1.5 transition-colors cursor-pointer ${
                    hasUnsavedChanges
                      ? 'bg-[#C9A66B] hover:bg-[#B08E55] text-[#2C1E17]'
                      : 'bg-[#FAF6F0] hover:bg-[#EED9C4] text-[#4E3629]'
                  }`}
                >
                  <Save className="w-3.5 h-3.5" />
                  {savingId === product.id
                    ? 'Saving...'
                    : hasUnsavedChanges
                    ? `Save Changes (${formatINR(draft.price)})`
                    : 'Saved'}
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

