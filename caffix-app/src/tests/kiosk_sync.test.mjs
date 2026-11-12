import assert from 'node:assert/strict';
import {
  resolveEffectiveMachineId,
  mapProductsPayload,
  isMachineInMaintenance,
  getDrinkStockStatus,
  fetchKioskSyncState
} from '../utils/kioskSync.js';

// 1. Machine ID resolution prefers URL query param and falls back to VITE_MACHINE_ID
assert.equal(resolveEffectiveMachineId('CFX-MC-02', 'CFX-MC-01'), 'CFX-MC-02');
assert.equal(resolveEffectiveMachineId('', 'CFX-MC-03'), 'CFX-MC-03');
assert.equal(resolveEffectiveMachineId(null, ''), null);

// 2. Maintenance helper checks all backend fields
assert.equal(isMachineInMaintenance({ status: 'online', desired_mode: 'RUNNING', maintenance: false }), false);
assert.equal(isMachineInMaintenance({ status: 'maintenance', desired_mode: 'RUNNING', maintenance: false }), true);
assert.equal(isMachineInMaintenance({ status: 'online', desired_mode: 'MAINTENANCE', maintenance: false }), true);
assert.equal(isMachineInMaintenance({ status: 'online', desired_mode: 'RUNNING', maintenance: true }), true);

// 3. Availability & exact inventory threshold checks
const fullInv = { water: 100, coffee: 100, milk: 100, vanilla: 100, hazelnut: 100, irish: 100, mocha: 100 };
assert.deepEqual(
  getDrinkStockStatus('vanilla', { classic: true, vanilla: false }, fullInv),
  {
    isAvailable: false,
    isInStock: true,
    canOrder: false,
    disabledReason: 'unavailable',
    statusLabel: 'Currently Unavailable'
  }
);

const lowVanillaInv = { ...fullInv, vanilla: 7 };
assert.equal(getDrinkStockStatus('vanilla', { vanilla: true }, lowVanillaInv).canOrder, false);
assert.equal(getDrinkStockStatus('vanilla', { vanilla: true }, lowVanillaInv).statusLabel, 'Out of Stock');
assert.equal(getDrinkStockStatus('classic', { classic: true }, lowVanillaInv).canOrder, true);

const lowBaseInv = { ...fullInv, coffee: 5 };
assert.equal(getDrinkStockStatus('classic', { classic: true }, lowBaseInv).canOrder, false);
assert.equal(getDrinkStockStatus('classic', { classic: true }, lowBaseInv).statusLabel, 'Out of Stock');

// 4. fetchKioskSyncState passes machine_id, Authorization, cache: 'no-store' and keeps machines isolated
const recordedCalls = [];
const mockResponses = {
  'https://api.example/api/products?machine_id=CFX-MC-02': {
    status: 'success',
    data: [
      { id: 1, price: 140, is_available: false },
      { id: 2, price: 155, is_available: true }
    ]
  },
  'https://api.example/api/machine-status?machine_id=CFX-MC-02': {
    status: 'success',
    data: {
      machine_id: 'CFX-MC-02',
      desired_mode: 'MAINTENANCE',
      status: 'maintenance',
      maintenance: true,
      inventory: { ...fullInv, vanilla: 6 }
    }
  }
};

const fakeFetch = async (url, init) => {
  recordedCalls.push({ url, init });
  const payload = mockResponses[url];
  return {
    ok: Boolean(payload),
    json: async () => payload
  };
};

const synced = await fetchKioskSyncState({
  fetchImpl: fakeFetch,
  apiBase: 'https://api.example/api',
  token: 'kiosk-jwt-mc02',
  machineId: 'CFX-MC-02'
});

assert.equal(recordedCalls.length, 2);
for (const call of recordedCalls) {
  assert.equal(call.init.cache, 'no-store');
  assert.equal(call.init.headers.Authorization, 'Bearer kiosk-jwt-mc02');
}
assert.equal(synced.prices.classic, 140);
assert.equal(synced.prices.vanilla, 155);
assert.equal(synced.availability.classic, false);
assert.equal(synced.availability.vanilla, true);
assert.equal(synced.maintenanceMode, true);
assert.equal(synced.inventory.vanilla, 6);

// 5. mapProductsPayload fallback safety
const defaultMapped = mapProductsPayload([]);
assert.equal(defaultMapped.prices.mocha, 100);
assert.equal(defaultMapped.availability.mocha, true);

console.log('ALL KIOSK SYNC UNIT TESTS PASSED!');
