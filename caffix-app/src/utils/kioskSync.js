export const PRODUCT_KEY_BY_ID = {
  1: 'classic',
  2: 'vanilla',
  3: 'hazelnut',
  4: 'irish',
  5: 'mocha'
};

export const DEFAULT_PRICES = {
  classic: 100,
  vanilla: 100,
  hazelnut: 100,
  irish: 100,
  mocha: 100
};

export const DEFAULT_AVAILABILITY = {
  classic: true,
  vanilla: true,
  hazelnut: true,
  irish: true,
  mocha: true
};

/**
 * Resolves the active machine ID from URL query parameter or build-time env fallback.
 */
export function resolveEffectiveMachineId(urlMachineId, envMachineId = '') {
  const fromUrl = typeof urlMachineId === 'string' ? urlMachineId.trim() : '';
  if (fromUrl) return fromUrl;
  const fromEnv = typeof envMachineId === 'string' ? envMachineId.trim() : '';
  return fromEnv || null;
}

/**
 * Normalizes the /api/products payload into keyed price and availability maps.
 */
export function mapProductsPayload(prodList = []) {
  const prices = { ...DEFAULT_PRICES };
  const availability = { ...DEFAULT_AVAILABILITY };

  if (!Array.isArray(prodList)) {
    return { prices, availability };
  }

  for (const product of prodList) {
    const pid = Number(product?.product_id ?? product?.id);
    const key = PRODUCT_KEY_BY_ID[pid];
    if (!key) continue;

    if (product?.price !== undefined && product?.price !== null && Number.isFinite(Number(product.price))) {
      prices[key] = Number(product.price);
    }
    availability[key] = !(product?.is_available === false || product?.is_available === 0);
  }

  return { prices, availability };
}

/**
 * Determines whether a machine status payload represents active maintenance mode.
 */
export function isMachineInMaintenance(machineData) {
  if (!machineData || typeof machineData !== 'object') return false;
  return Boolean(
    machineData.maintenance ||
    machineData.desired_mode === 'MAINTENANCE' ||
    machineData.status === 'maintenance'
  );
}

/**
 * Evaluates owner product availability for a drink (orders depend only on product is_available).
 */
export function getDrinkStockStatus(drinkId, availability = DEFAULT_AVAILABILITY) {
  const isAvailable = availability?.[drinkId] !== false;
  return {
    isAvailable,
    isInStock: true,
    canOrder: isAvailable,
    disabledReason: isAvailable ? null : 'unavailable',
    statusLabel: isAvailable ? null : 'Currently Unavailable'
  };
}

/**
 * Builds the cache-busted machine-scoped products URL.
 */
export function buildKioskProductsUrl(apiBase, machineId) {
  if (machineId) {
    return `${apiBase}/products?machine_id=${encodeURIComponent(machineId)}`;
  }
  return `${apiBase}/products`;
}

/**
 * Fetches fresh products, pricing, availability, and maintenance state
 * for the specified machine with strict no-store caching and machine_id scoping.
 */
export async function fetchKioskSyncState({
  fetchImpl = fetch,
  apiBase,
  token,
  machineId,
  preferCombinedSync = false
}) {
  const authHeaders = token ? { Authorization: `Bearer ${token}` } : {};
  const result = {
    prices: null,
    availability: null,
    maintenanceMode: null
  };

  const applyMachineStatus = (m) => {
    if (!m || typeof m !== 'object') return;
    result.maintenanceMode = isMachineInMaintenance(m);
  };

  if (preferCombinedSync && machineId && token) {
    try {
      const syncRes = await fetchImpl(
        `${apiBase}/kiosk/sync?machine_id=${encodeURIComponent(machineId)}`,
        {
          headers: authHeaders,
          cache: 'no-store'
        }
      );
      if (syncRes.ok) {
        const syncData = await syncRes.json();
        if (syncData?.status === 'success' && syncData?.data) {
          const mapped = mapProductsPayload(syncData.data.products);
          result.prices = mapped.prices;
          result.availability = mapped.availability;
          applyMachineStatus(syncData.data.machine_status);
          return result;
        }
      }
      if (syncRes.status !== 404) {
        return result;
      }
    } catch {
      // Fall back to separate endpoints if combined sync is unavailable
    }
  }

  const prodRes = await fetchImpl(buildKioskProductsUrl(apiBase, machineId), {
    headers: authHeaders,
    cache: 'no-store'
  });
  const prodData = await prodRes.json();
  if (prodRes.ok && prodData?.status === 'success') {
    const mapped = mapProductsPayload(prodData.data);
    result.prices = mapped.prices;
    result.availability = mapped.availability;
  }

  if (machineId) {
    const machineRes = await fetchImpl(
      `${apiBase}/machine-status?machine_id=${encodeURIComponent(machineId)}`,
      {
        headers: authHeaders,
        cache: 'no-store'
      }
    );
    const machineData = await machineRes.json();
    if (machineRes.ok && machineData?.status === 'success' && machineData?.data) {
      applyMachineStatus(machineData.data);
    }
  }

  return result;
}
