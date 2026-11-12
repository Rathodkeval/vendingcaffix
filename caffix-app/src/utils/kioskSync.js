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

export const BASE_INGREDIENT_REQUIREMENTS = {
  water: 5,
  coffee: 6,
  milk: 5
};

export const SYRUP_KEY_BY_DRINK = {
  vanilla: 'vanilla',
  hazelnut: 'hazelnut',
  irish: 'irish',
  mocha: 'mocha'
};

export const SYRUP_REQUIREMENT = 8;

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
 * Evaluates both owner product availability and ingredient stock thresholds for a drink.
 */
export function getDrinkStockStatus(drinkId, availability = DEFAULT_AVAILABILITY, inventory = null) {
  const isAvailable = availability?.[drinkId] !== false;

  if (!inventory || typeof inventory !== 'object') {
    return {
      isAvailable,
      isInStock: true,
      canOrder: isAvailable,
      disabledReason: isAvailable ? null : 'unavailable',
      statusLabel: isAvailable ? null : 'Currently Unavailable'
    };
  }

  const hasBaseIngredients =
    Number(inventory.water ?? 100) >= BASE_INGREDIENT_REQUIREMENTS.water &&
    Number(inventory.coffee ?? 100) >= BASE_INGREDIENT_REQUIREMENTS.coffee &&
    Number(inventory.milk ?? 100) >= BASE_INGREDIENT_REQUIREMENTS.milk;

  const syrupKey = SYRUP_KEY_BY_DRINK[drinkId];
  const hasSyrup = syrupKey ? Number(inventory[syrupKey] ?? 100) >= SYRUP_REQUIREMENT : true;
  const isInStock = hasBaseIngredients && hasSyrup;

  if (!isAvailable) {
    return {
      isAvailable: false,
      isInStock,
      canOrder: false,
      disabledReason: 'unavailable',
      statusLabel: 'Currently Unavailable'
    };
  }

  if (!isInStock) {
    return {
      isAvailable: true,
      isInStock: false,
      canOrder: false,
      disabledReason: 'out_of_stock',
      statusLabel: 'Out of Stock'
    };
  }

  return {
    isAvailable: true,
    isInStock: true,
    canOrder: true,
    disabledReason: null,
    statusLabel: null
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
 * Fetches fresh products, pricing, availability, inventory, and maintenance state
 * for the specified machine with strict no-store caching and machine_id scoping.
 */
export async function fetchKioskSyncState({ fetchImpl = fetch, apiBase, token, machineId }) {
  const authHeaders = token ? { Authorization: `Bearer ${token}` } : {};
  const result = {
    prices: null,
    availability: null,
    maintenanceMode: null,
    inventory: null
  };

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
      const m = machineData.data;
      result.maintenanceMode = isMachineInMaintenance(m);
      if (m.inventory) {
        result.inventory = {
          water: m.inventory.water,
          coffee: m.inventory.coffee,
          milk: m.inventory.milk,
          vanilla: m.inventory.vanilla,
          hazelnut: m.inventory.hazelnut,
          irish: m.inventory.irish,
          mocha: m.inventory.mocha
        };
      }
    }
  }

  return result;
}
