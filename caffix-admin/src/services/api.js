/**
 * CAFFIX Super Admin Dashboard API Service
 * ----------------------------------------
 * Uses `VITE_API_BASE_URL` in production (`https://vendingcaffix.vercel.app/api`)
 * and defaults to `http://localhost:5000/api` in local development.
 * Uses `VITE_OWNER_PORTAL_URL` to construct `#setup_token=...` onboarding links for owners.
 * Never exposes Firebase Admin credentials or secret keys in the frontend.
 */

const TOKEN_STORAGE_KEY = 'caffix_admin_jwt';

export function resolveApiBaseUrl(envOverride) {
  const configured =
    envOverride !== undefined
      ? envOverride
      : typeof import.meta !== 'undefined' && import.meta.env && import.meta.env.VITE_API_BASE_URL
      ? import.meta.env.VITE_API_BASE_URL
      : '';

  if (configured && String(configured).trim() !== '') {
    return String(configured).trim().replace(/\/+$/, '');
  }

  if (typeof window !== 'undefined') {
    const host = window.location.hostname;
    if (host === 'localhost' || host === '127.0.0.1') {
      return 'http://localhost:5000/api';
    }
  }

  return 'https://vendingcaffix.vercel.app/api';
}

export function resolveOwnerPortalUrl(envOverride) {
  const configured =
    envOverride !== undefined
      ? envOverride
      : typeof import.meta !== 'undefined' && import.meta.env && import.meta.env.VITE_OWNER_PORTAL_URL
      ? import.meta.env.VITE_OWNER_PORTAL_URL
      : '';

  if (configured && String(configured).trim() !== '') {
    return String(configured).trim().replace(/\/+$/, '');
  }

  if (typeof window !== 'undefined') {
    const host = window.location.hostname;
    if (host === 'localhost' || host === '127.0.0.1') {
      return 'http://localhost:5174';
    }
  }

  return 'https://caffix-owner.vercel.app';
}

export const API_BASE_URL = resolveApiBaseUrl();

let sessionExpiredHandler = null;

export function setOnSessionExpired(callback) {
  sessionExpiredHandler = callback;
}

export function getStoredToken() {
  if (typeof window === 'undefined') return null;
  try {
    return window.sessionStorage.getItem(TOKEN_STORAGE_KEY) || window.localStorage.getItem(TOKEN_STORAGE_KEY);
  } catch {
    return null;
  }
}

export function setStoredToken(token, remember = true) {
  if (typeof window === 'undefined') return;
  try {
    if (!token) {
      window.sessionStorage.removeItem(TOKEN_STORAGE_KEY);
      window.localStorage.removeItem(TOKEN_STORAGE_KEY);
      return;
    }
    window.sessionStorage.setItem(TOKEN_STORAGE_KEY, token);
    if (remember) {
      window.localStorage.setItem(TOKEN_STORAGE_KEY, token);
    } else {
      window.localStorage.removeItem(TOKEN_STORAGE_KEY);
    }
  } catch {
    // Ignore storage quota errors
  }
}

export function clearStoredToken() {
  setStoredToken(null);
}

/**
 * Builds an owner invitation setup URL pointing to the separate Owner Portal
 * using a URL fragment (`#setup_token=...&email=...`) so raw tokens never hit HTTP query strings.
 */
export function buildInviteSetupUrl(ownerPortalOrigin, inviteToken, email = '') {
  const base = String(ownerPortalOrigin || resolveOwnerPortalUrl()).replace(/\/+$/, '');
  const fragmentParams = new URLSearchParams();
  fragmentParams.set('setup_token', String(inviteToken || '').trim());
  if (email && String(email).trim()) {
    fragmentParams.set('email', String(email).trim());
  }
  return `${base}/#${fragmentParams.toString()}`;
}

export class ApiError extends Error {
  constructor(message, status, data = null) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.data = data;
  }
}

export async function apiFetch(path, options = {}) {
  const baseUrl = options.baseUrl || API_BASE_URL;
  const token = options.token !== undefined ? options.token : getStoredToken();
  const headers = {
    'Content-Type': 'application/json',
    ...(options.headers || {})
  };

  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  const response = await fetch(`${baseUrl}${path}`, {
    method: options.method || 'GET',
    headers,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    signal: options.signal
  });

  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    const message = payload?.message || `Request failed with HTTP ${response.status}`;
    if (response.status === 401 && !options.skipAuthExpirationHandler) {
      clearStoredToken();
      if (typeof sessionExpiredHandler === 'function') {
        sessionExpiredHandler(message);
      }
    }
    throw new ApiError(message, response.status, payload);
  }

  return payload;
}

function buildAnalyticsQueryString(params = {}) {
  const qs = new URLSearchParams();
  if (params?.start_date) qs.append('start_date', params.start_date);
  if (params?.end_date) qs.append('end_date', params.end_date);
  if (params?.machine_id) qs.append('machine_id', params.machine_id);
  if (params?.time_zone) qs.append('time_zone', params.time_zone);
  if (params?.interval) qs.append('interval', params.interval);
  if (params?.granularity) qs.append('granularity', params.granularity);
  const str = qs.toString();
  return str ? `?${str}` : '';
}

function resolveRequestOptions(tokenOrOptions, baseUrl, signal) {
  if (tokenOrOptions && typeof tokenOrOptions === 'object' && !Array.isArray(tokenOrOptions)) {
    return {
      token: tokenOrOptions.token,
      bUrl: tokenOrOptions.baseUrl || baseUrl,
      sig: tokenOrOptions.signal || signal
    };
  }
  return {
    token: tokenOrOptions,
    bUrl: baseUrl,
    sig: signal
  };
}

export const adminApi = {
  // Admin Authentication & Account Password Management
  login: (email, password, baseUrl) =>
    apiFetch('/auth/login', {
      method: 'POST',
      body: { email, password, portal: 'admin' },
      skipAuthExpirationHandler: true,
      baseUrl
    }),

  changePassword: ({ currentPassword, newPassword, current_password, new_password }, token, baseUrl) =>
    apiFetch('/auth/change-password', {
      method: 'POST',
      body: {
        current_password: current_password ?? currentPassword,
        new_password: new_password ?? newPassword
      },
      token,
      baseUrl
    }),

  getMe: (token, baseUrl) =>
    apiFetch('/auth/me?portal=admin', {
      method: 'GET',
      token,
      baseUrl
    }),

  // Fleet Machines & Connectivity
  getMachines: (token, baseUrl) =>
    apiFetch('/machines', {
      method: 'GET',
      token,
      baseUrl
    }),

  getMachineById: (machineId, token, baseUrl) =>
    apiFetch(`/machines/${encodeURIComponent(machineId)}`, {
      method: 'GET',
      token,
      baseUrl
    }),

  updateMachineMode: (machineId, desiredMode, token, baseUrl) =>
    apiFetch(`/machines/${encodeURIComponent(machineId)}/status`, {
      method: 'PATCH',
      body: { desired_mode: desiredMode },
      token,
      baseUrl
    }),

  refillMachineInventory: (machineId, ingredient, token, baseUrl) =>
    apiFetch(`/machines/${encodeURIComponent(machineId)}/refill`, {
      method: 'POST',
      body: { ingredient },
      token,
      baseUrl
    }),

  // Products & Per-Machine Pricing
  getMachineProducts: (machineId, token, baseUrl) =>
    apiFetch(`/machines/${encodeURIComponent(machineId)}/products`, {
      method: 'GET',
      token,
      baseUrl
    }),

  updateMachineProduct: (machineId, productId, { price, is_available }, token, baseUrl) =>
    apiFetch(`/machines/${encodeURIComponent(machineId)}/products/${encodeURIComponent(productId)}`, {
      method: 'PUT',
      body: {
        ...(price !== undefined ? { price: Number(price) } : {}),
        ...(is_available !== undefined ? { is_available: Boolean(is_available) } : {})
      },
      token,
      baseUrl
    }),

  // Global Orders & Historical Sales
  getOrders: (machineId, token, baseUrl) => {
    const query = machineId ? `?machine_id=${encodeURIComponent(machineId)}` : '';
    return apiFetch(`/orders${query}`, {
      method: 'GET',
      token,
      baseUrl
    });
  },

  // Reconciliation API (Phase 2.8)
  getReconciliationReport: (params, token, baseUrl) => {
    const qs = new URLSearchParams();
    if (params?.machine_id) qs.append('machine_id', params.machine_id);
    if (params?.result) qs.append('result', params.result);
    if (params?.discrepancy) qs.append('discrepancy', params.discrepancy);
    const queryString = qs.toString() ? `?${qs.toString()}` : '';
    return apiFetch(`/reconciliation/report${queryString}`, {
      method: 'GET',
      token,
      baseUrl
    });
  },

  getOrderReconciliation: (orderId, token, baseUrl) =>
    apiFetch(`/reconciliation/orders/${encodeURIComponent(orderId)}`, {
      method: 'GET',
      token,
      baseUrl
    }),

  getMachineInventoryLedger: (machineId, params, token, baseUrl) => {
    const qs = new URLSearchParams();
    if (params?.limit) qs.append('limit', params.limit);
    if (params?.offset) qs.append('offset', params.offset);
    const queryString = qs.toString() ? `?${qs.toString()}` : '';
    return apiFetch(`/reconciliation/inventory/${encodeURIComponent(machineId)}${queryString}`, {
      method: 'GET',
      token,
      baseUrl
    });
  },

  // Super Admin Fleet & Owner Management
  getOwners: (token, baseUrl) =>
    apiFetch('/auth/owners', {
      method: 'GET',
      token,
      baseUrl
    }),

  inviteOwner: ({ name, email, machine_ids }, token, baseUrl) =>
    apiFetch('/auth/owners/invite', {
      method: 'POST',
      body: { name, email, machine_ids },
      token,
      baseUrl
    }),

  assignMachineOwner: (machineId, ownerId, token, baseUrl) =>
    apiFetch(`/machines/${encodeURIComponent(machineId)}/owner`, {
      method: 'PATCH',
      body: { owner_id: ownerId || null },
      token,
      baseUrl
    }),

  registerMachine: ({ id, machine_name, location, kiosk_token }, token, baseUrl) =>
    apiFetch('/machines/register', {
      method: 'POST',
      body: {
        id,
        machine_name,
        location,
        ...(kiosk_token ? { kiosk_token } : {})
      },
      token,
      baseUrl
    }),

  // Business Analytics API (Phase 2.9)
  getAnalyticsOverview: (params, tokenOrOptions, baseUrl, signal) => {
    const { token, bUrl, sig } = resolveRequestOptions(tokenOrOptions, baseUrl, signal);
    return apiFetch(`/analytics/overview${buildAnalyticsQueryString(params)}`, {
      method: 'GET',
      token,
      baseUrl: bUrl,
      signal: sig
    });
  },

  getAnalyticsTimeSeries: (params, tokenOrOptions, baseUrl, signal) => {
    const { token, bUrl, sig } = resolveRequestOptions(tokenOrOptions, baseUrl, signal);
    return apiFetch(`/analytics/time-series${buildAnalyticsQueryString(params)}`, {
      method: 'GET',
      token,
      baseUrl: bUrl,
      signal: sig
    });
  },

  getAnalyticsMachines: (params, tokenOrOptions, baseUrl, signal) => {
    const { token, bUrl, sig } = resolveRequestOptions(tokenOrOptions, baseUrl, signal);
    return apiFetch(`/analytics/machines${buildAnalyticsQueryString(params)}`, {
      method: 'GET',
      token,
      baseUrl: bUrl,
      signal: sig
    });
  },

  getAnalyticsProducts: (params, tokenOrOptions, baseUrl, signal) => {
    const { token, bUrl, sig } = resolveRequestOptions(tokenOrOptions, baseUrl, signal);
    return apiFetch(`/analytics/products${buildAnalyticsQueryString(params)}`, {
      method: 'GET',
      token,
      baseUrl: bUrl,
      signal: sig
    });
  },

  getAnalyticsInventory: (params, tokenOrOptions, baseUrl, signal) => {
    const { token, bUrl, sig } = resolveRequestOptions(tokenOrOptions, baseUrl, signal);
    return apiFetch(`/analytics/inventory${buildAnalyticsQueryString(params)}`, {
      method: 'GET',
      token,
      baseUrl: bUrl,
      signal: sig
    });
  },

  getAnalyticsRefunds: (params, tokenOrOptions, baseUrl, signal) => {
    const { token, bUrl, sig } = resolveRequestOptions(tokenOrOptions, baseUrl, signal);
    return apiFetch(`/analytics/refunds${buildAnalyticsQueryString(params)}`, {
      method: 'GET',
      token,
      baseUrl: bUrl,
      signal: sig
    });
  }
};

