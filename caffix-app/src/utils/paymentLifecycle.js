/**
 * Kiosk payment verification retry, safe pre-cancel verification, and
 * real-time dispensing progress helpers (CAFFIX Phase F.1: S-3 & S-4).
 */

export const PAID_OR_ACTIVE_ORDER_STATUSES = ['PAID', 'PREPARING', 'COMPLETED'];
export const ACTIVE_DISPENSE_STATES = ['QUEUED', 'DISPENSING', 'DISPENSED'];

export function isOrderPaidOrActive(order) {
  if (!order || typeof order !== 'object') return false;
  const status = String(order.status || '').toUpperCase();
  const dispenseStatus = String(order.dispense_status || '').toUpperCase();
  return (
    PAID_OR_ACTIVE_ORDER_STATUSES.includes(status) ||
    ACTIVE_DISPENSE_STATES.includes(dispenseStatus) ||
    order.dispensed === true
  );
}

export function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithTimeout(fetchImpl, url, options = {}, timeoutMs = 10000) {
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  let timeoutId = null;
  if (controller && timeoutMs > 0) {
    timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  }
  try {
    return await fetchImpl(url, {
      ...options,
      ...(controller ? { signal: controller.signal } : {})
    });
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

export async function fetchAuthoritativeOrderStatus({
  apiBase,
  token,
  orderId,
  fetchImpl = fetch,
  timeoutMs = 10000
}) {
  if (!orderId) {
    return { ok: false, statusCode: 0, order: null, message: 'Missing order ID' };
  }
  try {
    const res = await fetchWithTimeout(
      fetchImpl,
      `${apiBase}/orders/${encodeURIComponent(orderId)}`,
      {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        cache: 'no-store'
      },
      timeoutMs
    );
    const data = await res.json().catch(() => ({}));
    if (res.ok && data?.data) {
      return { ok: true, statusCode: res.status, order: data.data };
    }
    return {
      ok: false,
      statusCode: res.status,
      order: data?.data || null,
      message: data?.message || `HTTP ${res.status}`
    };
  } catch (err) {
    return {
      ok: false,
      statusCode: 0,
      order: null,
      isNetworkOrTimeout: true,
      message: err?.name === 'AbortError' ? 'Status check timed out' : (err?.message || 'Network error')
    };
  }
}

/**
 * Bounded exponential-backoff retry wrapper around POST /api/payments/verify.
 * - Retries ONLY transient network/timeout errors, HTTP 429, and HTTP 5xx (including 503 pending capture).
 * - Never retries indefinitely.
 * - Re-checks GET /api/orders/:id before concluding failure/uncertainty so a captured payment
 *   settled concurrently by webhook or an earlier attempt is never lost.
 */
export async function verifyPaymentWithRetry({
  apiBase,
  token,
  payload,
  fetchImpl = fetch,
  sleepImpl = defaultSleep,
  maxAttempts = 4,
  initialDelayMs = 800,
  backoffFactor = 2,
  timeoutMs = 12000,
  onAttempt = null
}) {
  const safeMaxAttempts = Math.max(1, Math.min(6, Number(maxAttempts) || 4));
  let lastStatus = 0;
  let lastMessage = '';
  let sawTransientFailure = false;

  for (let attempt = 1; attempt <= safeMaxAttempts; attempt++) {
    if (typeof onAttempt === 'function') {
      onAttempt({ attempt, maxAttempts: safeMaxAttempts });
    }

    let retryable;
    try {
      const res = await fetchWithTimeout(
        fetchImpl,
        `${apiBase}/payments/verify`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(token ? { Authorization: `Bearer ${token}` } : {})
          },
          body: JSON.stringify(payload)
        },
        timeoutMs
      );

      const data = await res.json().catch(() => ({}));
      if (res.ok && data?.status === 'success') {
        return {
          outcome: 'VERIFIED',
          order: data.data || null,
          attempts: attempt
        };
      }

      lastStatus = res.status;
      lastMessage = data?.message || `Payment verification returned HTTP ${res.status}`;

      if (res.status === 429 || (res.status >= 500 && res.status < 600)) {
        retryable = true;
        sawTransientFailure = true;
      } else {
        // Definitive 4xx (e.g., 400 signature mismatch or amount mismatch): stop retrying
        break;
      }
    } catch (err) {
      sawTransientFailure = true;
      lastStatus = 0;
      lastMessage =
        err?.name === 'AbortError'
          ? 'Payment confirmation request timed out'
          : (err?.message || 'Network error while verifying payment');
      retryable = true;
    }

    if (retryable && attempt < safeMaxAttempts) {
      const delayMs = Math.round(initialDelayMs * Math.pow(backoffFactor, attempt - 1));
      await sleepImpl(delayMs);
    }
  }

  // Always check authoritative backend status before concluding failed or uncertain
  const statusCheck = await fetchAuthoritativeOrderStatus({
    apiBase,
    token,
    orderId: payload?.order_id,
    fetchImpl,
    timeoutMs: Math.min(timeoutMs, 10000)
  });

  if (statusCheck.ok && isOrderPaidOrActive(statusCheck.order)) {
    return {
      outcome: 'VERIFIED',
      order: statusCheck.order,
      attempts: safeMaxAttempts,
      recoveredViaStatusCheck: true
    };
  }

  if (sawTransientFailure || !statusCheck.ok) {
    return {
      outcome: 'UNCERTAIN',
      attempts: safeMaxAttempts,
      statusCode: lastStatus,
      message:
        lastMessage ||
        'Unable to confirm payment status due to a temporary network or gateway delay.'
    };
  }

  return {
    outcome: 'FAILED',
    attempts: safeMaxAttempts,
    statusCode: lastStatus,
    message: lastMessage || 'Payment verification failed.'
  };
}

/**
 * Checks authoritative payment status BEFORE sending POST /api/orders/:id/cancel.
 * Guarantees that a paid, pending-verification, or uncertain order is never cancelled prematurely.
 */
export async function safeCheckAndCancelOrder({
  apiBase,
  token,
  orderId,
  razorpayOrderId,
  reason = 'customer_cancelled',
  hasPendingVerification = false,
  fetchImpl = fetch,
  timeoutMs = 10000
}) {
  if (!orderId) {
    return { action: 'CANCELLED', order: null, alreadyClosed: true };
  }

  const statusCheck = await fetchAuthoritativeOrderStatus({
    apiBase,
    token,
    orderId,
    fetchImpl,
    timeoutMs
  });

  if (statusCheck.ok && isOrderPaidOrActive(statusCheck.order)) {
    return { action: 'ALREADY_PAID', order: statusCheck.order };
  }

  // If gateway response was already received or status could not be checked, never blindly cancel
  if (hasPendingVerification) {
    return {
      action: 'UNCERTAIN',
      order: statusCheck.order || null,
      message:
        'Payment response was received from gateway and cannot be cancelled safely while confirmation is pending.'
    };
  }

  if (!statusCheck.ok) {
    return {
      action: 'UNCERTAIN',
      order: null,
      statusCode: statusCheck.statusCode,
      message:
        statusCheck.message ||
        'Could not verify current order payment status with backend before cancellation.'
    };
  }

  const currentStatus = String(statusCheck.order?.status || 'PENDING').toUpperCase();
  if (currentStatus === 'CANCELLED' || currentStatus === 'FAILED') {
    return { action: 'CANCELLED', order: statusCheck.order, alreadyClosed: true };
  }

  try {
    const cancelRes = await fetchWithTimeout(
      fetchImpl,
      `${apiBase}/orders/${encodeURIComponent(orderId)}/cancel`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {})
        },
        body: JSON.stringify({
          razorpay_order_id: razorpayOrderId,
          reason
        })
      },
      timeoutMs
    );

    const cancelData = await cancelRes.json().catch(() => ({}));
    if (cancelRes.status === 409 || isOrderPaidOrActive(cancelData?.data)) {
      return { action: 'ALREADY_PAID', order: cancelData?.data || null };
    }

    if (cancelRes.ok && cancelData?.status === 'success') {
      return { action: 'CANCELLED', order: cancelData.data || null };
    }

    return {
      action: 'ERROR',
      statusCode: cancelRes.status,
      order: cancelData?.data || null,
      message: cancelData?.message || `Cancel failed with HTTP ${cancelRes.status}`
    };
  } catch (err) {
    return {
      action: 'ERROR',
      statusCode: 0,
      order: null,
      message: err?.message || 'Network error while cancelling order'
    };
  }
}

/**
 * Interprets the authoritative backend order snapshot for PreparingScreen progress.
 */
export function classifyDispenseProgress(order) {
  if (!order || typeof order !== 'object') {
    return 'QUEUED';
  }
  const dispenseStatus = String(order.dispense_status || '').toUpperCase();
  const refundStatus = String(order.refund_status || '').toUpperCase();
  const orderStatus = String(order.status || '').toUpperCase();

  if (dispenseStatus === 'FAILED' || dispenseStatus === 'CANCELLED' || refundStatus === 'FULL') {
    return 'DISPENSE_FAILED';
  }

  if (dispenseStatus === 'DISPENSED' || order.dispensed === true) {
    return 'DISPENSED';
  }

  if (
    dispenseStatus === 'DISPENSING' ||
    dispenseStatus === 'CLAIMING' ||
    orderStatus === 'PREPARING'
  ) {
    return 'DISPENSING';
  }

  return 'QUEUED';
}

export async function pollOrderDispenseProgress({
  apiBase,
  token,
  orderId,
  fetchImpl = fetch,
  timeoutMs = 8000
}) {
  const statusCheck = await fetchAuthoritativeOrderStatus({
    apiBase,
    token,
    orderId,
    fetchImpl,
    timeoutMs
  });

  if (!statusCheck.ok || !statusCheck.order) {
    return {
      ok: false,
      state: null,
      order: null,
      message: statusCheck.message || 'Unable to fetch dispense status'
    };
  }

  return {
    ok: true,
    state: classifyDispenseProgress(statusCheck.order),
    order: statusCheck.order
  };
}

export async function finalizeDispensedOrder({
  apiBase,
  token,
  orderId,
  fetchImpl = fetch,
  timeoutMs = 8000
}) {
  if (!orderId) return { ok: false };
  try {
    const res = await fetchWithTimeout(
      fetchImpl,
      `${apiBase}/orders/${encodeURIComponent(orderId)}/status`,
      {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {})
        },
        body: JSON.stringify({ status: 'COMPLETED' })
      },
      timeoutMs
    );
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok, statusCode: res.status, order: data?.data || null };
  } catch (err) {
    return { ok: false, statusCode: 0, message: err?.message || 'Finalize order failed' };
  }
}

