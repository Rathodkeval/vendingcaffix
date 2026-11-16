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

// 3. Availability checks (inventory does not block kiosk orders)
assert.deepEqual(
  getDrinkStockStatus('vanilla', { classic: true, vanilla: false }),
  {
    isAvailable: false,
    isInStock: true,
    canOrder: false,
    disabledReason: 'unavailable',
    statusLabel: 'Currently Unavailable'
  }
);

assert.deepEqual(
  getDrinkStockStatus('vanilla', { classic: true, vanilla: true }),
  {
    isAvailable: true,
    isInStock: true,
    canOrder: true,
    disabledReason: null,
    statusLabel: null
  }
);
assert.equal(getDrinkStockStatus('classic', { classic: true }, { water: 0, coffee: 0, milk: 0 }).canOrder, true);

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
      maintenance: true
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

// 5. mapProductsPayload fallback safety
const defaultMapped = mapProductsPayload([]);
assert.equal(defaultMapped.prices.mocha, 100);
assert.equal(defaultMapped.availability.mocha, true);

// 6. preferCombinedSync uses single /kiosk/sync endpoint when available
const combinedCalls = [];
const combinedSynced = await fetchKioskSyncState({
  fetchImpl: async (url, init) => {
    combinedCalls.push({ url, init });
    return {
      ok: true,
      status: 200,
      json: async () => ({
        status: 'success',
        data: {
          products: mockResponses['https://api.example/api/products?machine_id=CFX-MC-02'].data,
          machine_status: mockResponses['https://api.example/api/machine-status?machine_id=CFX-MC-02'].data
        }
      })
    };
  },
  apiBase: 'https://api.example/api',
  token: 'kiosk-jwt-mc02',
  machineId: 'CFX-MC-02',
  preferCombinedSync: true
});
assert.equal(combinedCalls.length, 1);
assert.equal(combinedCalls[0].url, 'https://api.example/api/kiosk/sync?machine_id=CFX-MC-02');
assert.equal(combinedSynced.prices.classic, 140);
assert.equal(combinedSynced.maintenanceMode, true);

console.log('ALL KIOSK SYNC UNIT TESTS PASSED!');
