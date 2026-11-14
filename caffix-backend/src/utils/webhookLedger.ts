import crypto from 'crypto';
import logger from './logger';
import {
  isFirestoreActive,
  getFirestoreInstance,
  isStrictFirebaseEnvironment
} from './firebase';
import { ServiceUnavailableError } from './errors';

export interface WebhookEventRecord {
  id: string;
  provider: string;
  event_id: string;
  event_type: string;
  order_id: string | null;
  payment_id: string | null;
  refund_id: string | null;
  status: 'RECEIVED' | 'PROCESSING' | 'PROCESSED' | 'IGNORED' | 'FAILED';
  payload: string | null;
  error_message: string | null;
  lease_expires_at: string | null;
  claim_count: number;
  created_at: string;
  updated_at: string;
  processed_at: string | null;
}

export interface ClaimWebhookEventParams {
  provider: string;
  eventId: string;
  eventType: string;
  orderId?: string | null;
  paymentId?: string | null;
  refundId?: string | null;
  payload?: any;
  leaseDurationMs?: number;
}

export interface ClaimWebhookResult {
  shouldProcess: boolean;
  isDuplicate?: boolean;
  isConcurrentInFlight?: boolean;
  isRecovery?: boolean;
  isRetry?: boolean;
  isNew?: boolean;
  status: string;
  claimCount?: number;
  claimToken?: string;
  entry?: any;
}

function isVercelRuntime(): boolean {
  return Boolean(process.env.VERCEL && process.env.VERCEL !== 'undefined' && process.env.VERCEL !== 'false');
}

/**
 * Recursively redacts customer PII and sensitive payment details from webhook payloads
 * before persistence (Finding 5 & Phase 2.7.2.4 F-4).
 * Redacts email, contact/phone, card numbers, VPAs, names, bank accounts, and addresses across nested objects.
 * Preserves event IDs, amounts, currencies, statuses, order/refund IDs, and timestamps.
 */
export function sanitizeWebhookPayload(payload: any): any {
  if (!payload || typeof payload !== 'object') {
    return payload;
  }

  // Deep clone to prevent mutating in-flight express req.body
  const cloned = JSON.parse(JSON.stringify(payload));

  const SENSITIVE_KEYS = new Set([
    'email',
    'contact',
    'phone',
    'card_number',
    'card',
    'vpa',
    'customer_email',
    'customer_contact',
    'customer_phone',
    'cvv',
    'secret',
    'password',
    'token',
    'name',
    'customer_name',
    'account_number',
    'bank_account',
    'address',
    'billing_address',
    'shipping_address',
    'upi_id',
    'upi',
    'pan',
    'pin',
    'cvc'
  ]);

  function redactRecursive(current: any) {
    if (!current || typeof current !== 'object') return;

    if (Array.isArray(current)) {
      current.forEach((item) => redactRecursive(item));
      return;
    }

    for (const key of Object.keys(current)) {
      const lowerKey = key.toLowerCase();
      if (SENSITIVE_KEYS.has(lowerKey)) {
        if (current[key] !== null && current[key] !== undefined) {
          current[key] = '[REDACTED]';
        }
      } else if (typeof current[key] === 'object' && current[key] !== null) {
        redactRecursive(current[key]);
      }
    }
  }

  redactRecursive(cloned);
  return cloned;
}

/**
 * Claims a webhook event atomically with distributed lease and crash recovery (Findings 2 & 4).
 * Enforces shared Firestore persistence in production and preview environments.
 * Uses atomic transactions to prevent concurrent processing by separate serverless containers.
 */
export async function claimWebhookEvent(
  db: any,
  params: ClaimWebhookEventParams
): Promise<ClaimWebhookResult> {
  const provider = String(params.provider || 'razorpay').trim().toLowerCase();
  const eventId = String(params.eventId || '').trim();
  const eventType = String(params.eventType || 'unknown').trim();
  const leaseDurationMs = params.leaseDurationMs || 60000; // 60 seconds bounded lease

  if (!eventId) {
    throw new Error('Event ID is required to claim a webhook event');
  }

  // Strict Fail-Closed Rule for Production & Preview:
  if (isStrictFirebaseEnvironment() || isVercelRuntime()) {
    if (!isFirestoreActive()) {
      throw new ServiceUnavailableError(
        'Webhook ledger unavailable: Shared Firestore persistence is required in Production and Preview environments. Failing closed (HTTP 503).'
      );
    }
  }

  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const leaseExpiresIso = new Date(nowMs + leaseDurationMs).toISOString();
  const sanitizedPayload = params.payload
    ? JSON.stringify(sanitizeWebhookPayload(params.payload)).slice(0, 4000)
    : null;

  // 1. Authoritative Firestore Path (Production, Preview, or when Firestore is Active)
  if (isFirestoreActive()) {
    const firestore = getFirestoreInstance()!;
    const docId = `${provider}_${eventId}`;
    const docRef = firestore.collection('webhook_events').doc(docId);

    const result = await firestore.runTransaction(async (tx) => {
      const snap = await tx.get(docRef);

      if (snap.exists) {
        const data = snap.data() as any;
        const status = String(data.status || '').toUpperCase();

        // Already settled terminal state: idempotent deduplication
        if (status === 'PROCESSED' || status === 'IGNORED') {
          return {
            shouldProcess: false,
            isDuplicate: true,
            status,
            entry: data
          };
        }

        // Active in-flight claim: inspect bounded lease
        if (status === 'PROCESSING') {
          const leaseExpiryMs = data.lease_expires_at
            ? new Date(data.lease_expires_at).getTime()
            : 0;

          if (nowMs < leaseExpiryMs) {
            // Active lease held by another instance
            return {
              shouldProcess: false,
              isConcurrentInFlight: true,
              status: 'PROCESSING',
              entry: data
            };
          }

          // Lease expired: recover processing claim atomically
          const nextClaim = Number(data.claim_count || 1) + 1;
          tx.set(
            docRef,
            {
              status: 'PROCESSING',
              lease_expires_at: leaseExpiresIso,
              claim_count: nextClaim,
              last_recovered_at: nowIso,
              updated_at: nowIso
            },
            { merge: true }
          );

          return {
            shouldProcess: true,
            isRecovery: true,
            status: 'PROCESSING',
            claimCount: nextClaim,
            claimToken: `${provider}_${eventId}_gen_${nextClaim}`,
            entry: data
          };
        }

        // FAILED state: allow recoverable retry
        if (status === 'FAILED') {
          const nextClaim = Number(data.claim_count || 1) + 1;
          tx.set(
            docRef,
            {
              status: 'PROCESSING',
              lease_expires_at: leaseExpiresIso,
              claim_count: nextClaim,
              last_retry_at: nowIso,
              updated_at: nowIso
            },
            { merge: true }
          );

          return {
            shouldProcess: true,
            isRetry: true,
            status: 'PROCESSING',
            claimCount: nextClaim,
            claimToken: `${provider}_${eventId}_gen_${nextClaim}`,
            entry: data
          };
        }
      }

      // Brand new event claim
      const record: WebhookEventRecord = {
        id: docId,
        provider,
        event_id: eventId,
        event_type: eventType,
        order_id: params.orderId || null,
        payment_id: params.paymentId || null,
        refund_id: params.refundId || null,
        status: 'PROCESSING',
        payload: sanitizedPayload,
        error_message: null,
        lease_expires_at: leaseExpiresIso,
        claim_count: 1,
        created_at: nowIso,
        updated_at: nowIso,
        processed_at: null
      };

      tx.set(docRef, record);
      return {
        shouldProcess: true,
        isNew: true,
        status: 'PROCESSING',
        claimCount: 1,
        claimToken: `${provider}_${eventId}_gen_1`,
        entry: record
      };
    });

    // Mirror to SQLite cache if available
    if (db && db.run) {
      try {
        await db.run(
          `INSERT OR REPLACE INTO webhook_events (
            id, provider, event_id, event_type, order_id, payment_id, refund_id,
            status, payload, error_message, lease_expires_at, claim_count, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            docId,
            provider,
            eventId,
            eventType,
            params.orderId || null,
            params.paymentId || null,
            params.refundId || null,
            result.status,
            sanitizedPayload,
            null,
            leaseExpiresIso,
            result.isRecovery || result.isRetry ? 2 : 1,
            nowIso,
            nowIso
          ]
        );
      } catch (cacheErr) {
        logger.warn(`Failed to mirror webhook_events claim to SQLite cache: ${cacheErr}`);
      }
    }

    return result;
  }

  // 2. Local SQLite / MockDatabase Fallback (Local Development & Offline Tests)
  if (!db || !db.get) {
    return { shouldProcess: true, isNew: true, status: 'PROCESSING' };
  }

  const existing = await db.get(
    'SELECT * FROM webhook_events WHERE provider = ? AND event_id = ?',
    [provider, eventId]
  );

  if (existing) {
    const status = String(existing.status || '').toUpperCase();

    if (status === 'PROCESSED' || status === 'IGNORED') {
      return {
        shouldProcess: false,
        isDuplicate: true,
        status,
        entry: existing
      };
    }

    if (status === 'PROCESSING') {
      const leaseExpiryMs = existing.lease_expires_at
        ? new Date(existing.lease_expires_at).getTime()
        : 0;

      if (nowMs < leaseExpiryMs) {
        return {
          shouldProcess: false,
          isConcurrentInFlight: true,
          status: 'PROCESSING',
          entry: existing
        };
      }

      // Expired lease recovery
      const nextClaim = Number(existing.claim_count || 1) + 1;
      await db.run(
        `UPDATE webhook_events 
         SET status = 'PROCESSING', lease_expires_at = ?, claim_count = ?, updated_at = ? 
         WHERE provider = ? AND event_id = ?`,
        [leaseExpiresIso, nextClaim, nowIso, provider, eventId]
      );

      return {
        shouldProcess: true,
        isRecovery: true,
        status: 'PROCESSING',
        claimCount: nextClaim,
        claimToken: `${provider}_${eventId}_gen_${nextClaim}`,
        entry: existing
      };
    }

    if (status === 'FAILED') {
      const nextClaim = Number(existing.claim_count || 1) + 1;
      await db.run(
        `UPDATE webhook_events 
         SET status = 'PROCESSING', lease_expires_at = ?, claim_count = ?, updated_at = ? 
         WHERE provider = ? AND event_id = ?`,
        [leaseExpiresIso, nextClaim, nowIso, provider, eventId]
      );

      return {
        shouldProcess: true,
        isRetry: true,
        status: 'PROCESSING',
        claimCount: nextClaim,
        claimToken: `${provider}_${eventId}_gen_${nextClaim}`,
        entry: existing
      };
    }
  }

  // Brand new SQLite insertion
  const ledgerEntryId = `wh_evt_${crypto.randomBytes(8).toString('hex')}`;
  try {
    await db.run(
      `INSERT INTO webhook_events (
        id, provider, event_id, event_type, order_id, payment_id, refund_id,
        status, payload, error_message, lease_expires_at, claim_count, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'PROCESSING', ?, NULL, ?, 1, ?, ?)`,
      [
        ledgerEntryId,
        provider,
        eventId,
        eventType,
        params.orderId || null,
        params.paymentId || null,
        params.refundId || null,
        sanitizedPayload,
        leaseExpiresIso,
        nowIso,
        nowIso
      ]
    );

    return {
      shouldProcess: true,
      isNew: true,
      status: 'PROCESSING',
      claimCount: 1,
      claimToken: `${provider}_${eventId}_gen_1`
    };
  } catch (err: any) {
    // Concurrent insert race condition in SQLite:
    // Re-check row state rather than swallowing error blindly!
    if (
      String(err?.message || err).includes('UNIQUE') ||
      String(err?.code || '') === 'SQLITE_CONSTRAINT'
    ) {
      const rechecked = await db.get(
        'SELECT * FROM webhook_events WHERE provider = ? AND event_id = ?',
        [provider, eventId]
      );
      if (rechecked) {
        const recheckStatus = String(rechecked.status || '').toUpperCase();
        if (recheckStatus === 'PROCESSED' || recheckStatus === 'IGNORED') {
          return {
            shouldProcess: false,
            isDuplicate: true,
            status: recheckStatus,
            entry: rechecked
          };
        }
        return {
          shouldProcess: false,
          isConcurrentInFlight: true,
          status: 'PROCESSING',
          entry: rechecked
        };
      }
    }
    throw err;
  }
}

/**
 * Marks a claimed webhook event as successfully PROCESSED in authoritative persistence.
 * Enforces claim generation fencing to prevent stale superseded workers from overwriting ledger state.
 */
export async function markWebhookEventProcessed(
  db: any,
  provider: string,
  eventId: string,
  metadata?: {
    orderId?: string | null;
    paymentId?: string | null;
    refundId?: string | null;
    claimCount?: number;
  }
): Promise<void> {
  const nowIso = new Date().toISOString();

  if (isFirestoreActive()) {
    const firestore = getFirestoreInstance()!;
    const docId = `${provider}_${eventId}`;
    const docRef = firestore.collection('webhook_events').doc(docId);

    await firestore.runTransaction(async (tx) => {
      const snap = await tx.get(docRef);
      if (!snap.exists) return;
      const data = snap.data() as any;

      // F-1 Fencing Guard: Stale worker must not overwrite a newer worker's claim
      if (metadata?.claimCount !== undefined && data.claim_count !== undefined) {
        if (data.claim_count !== metadata.claimCount) {
          logger.warn(
            `[Webhook Ledger] Refusing to mark PROCESSED for stale claim generation (current=${data.claim_count}, worker=${metadata.claimCount}) on event ${eventId}`
          );
          return;
        }
      }

      tx.set(
        docRef,
        {
          status: 'PROCESSED',
          processed_at: data.processed_at || nowIso,
          updated_at: nowIso,
          error_message: null,
          ...(metadata?.orderId ? { order_id: metadata.orderId } : {}),
          ...(metadata?.paymentId ? { payment_id: metadata.paymentId } : {}),
          ...(metadata?.refundId ? { refund_id: metadata.refundId } : {})
        },
        { merge: true }
      );
    });
  }

  if (db && db.run) {
    try {
      if (metadata?.claimCount !== undefined) {
        await db.run(
          `UPDATE webhook_events 
           SET status = 'PROCESSED', processed_at = COALESCE(processed_at, ?), updated_at = ?, error_message = NULL
           WHERE provider = ? AND event_id = ? AND claim_count = ?`,
          [nowIso, nowIso, provider, eventId, metadata.claimCount]
        );
      } else {
        await db.run(
          `UPDATE webhook_events 
           SET status = 'PROCESSED', processed_at = COALESCE(processed_at, ?), updated_at = ?, error_message = NULL
           WHERE provider = ? AND event_id = ?`,
          [nowIso, nowIso, provider, eventId]
        );
      }
    } catch (e) {
      logger.warn(`Failed to update SQLite webhook_events to PROCESSED: ${e}`);
    }
  }
}

/**
 * Marks a claimed webhook event as FAILED with diagnostic error message.
 * Enforces terminal state immutability (never downgrades PROCESSED to FAILED)
 * and generation fencing (stale worker cannot overwrite newer claim).
 */
export async function markWebhookEventFailed(
  db: any,
  provider: string,
  eventId: string,
  errorMessage: string,
  claimCount?: number
): Promise<void> {
  const nowIso = new Date().toISOString();
  const safeError = String(errorMessage || 'Unknown error').slice(0, 1000);

  if (isFirestoreActive()) {
    const firestore = getFirestoreInstance()!;
    const docId = `${provider}_${eventId}`;
    const docRef = firestore.collection('webhook_events').doc(docId);

    await firestore.runTransaction(async (tx) => {
      const snap = await tx.get(docRef);
      if (!snap.exists) return;
      const data = snap.data() as any;

      // F-1 Guard 1: A stale worker must never downgrade PROCESSED to FAILED!
      if (data.status === 'PROCESSED') {
        logger.warn(`[Webhook Ledger] Refusing to downgrade already PROCESSED event ${eventId} to FAILED`);
        return;
      }

      // F-1 Guard 2: Stale worker must not overwrite newer worker's ledger state
      if (claimCount !== undefined && data.claim_count !== undefined) {
        if (data.claim_count !== claimCount) {
          logger.warn(
            `[Webhook Ledger] Refusing to mark FAILED for stale claim generation (current=${data.claim_count}, worker=${claimCount}) on event ${eventId}`
          );
          return;
        }
      }

      tx.set(
        docRef,
        {
          status: 'FAILED',
          error_message: safeError,
          updated_at: nowIso
        },
        { merge: true }
      );
    });
  }

  if (db && db.run) {
    try {
      if (claimCount !== undefined) {
        await db.run(
          `UPDATE webhook_events 
           SET status = 'FAILED', error_message = ?, updated_at = ?
           WHERE provider = ? AND event_id = ? AND status != 'PROCESSED' AND claim_count = ?`,
          [safeError, nowIso, provider, eventId, claimCount]
        );
      } else {
        await db.run(
          `UPDATE webhook_events 
           SET status = 'FAILED', error_message = ?, updated_at = ?
           WHERE provider = ? AND event_id = ? AND status != 'PROCESSED'`,
          [safeError, nowIso, provider, eventId]
        );
      }
    } catch (e) {
      logger.warn(`Failed to update SQLite webhook_events to FAILED: ${e}`);
    }
  }
}

/**
 * Marks a claimed webhook event as IGNORED (e.g. unsupported event type).
 */
export async function markWebhookEventIgnored(
  db: any,
  provider: string,
  eventId: string,
  reason?: string
): Promise<void> {
  const nowIso = new Date().toISOString();
  const safeReason = String(reason || 'Ignored unsupported event').slice(0, 1000);

  if (isFirestoreActive()) {
    const firestore = getFirestoreInstance()!;
    const docId = `${provider}_${eventId}`;
    await firestore.collection('webhook_events').doc(docId).set(
      {
        status: 'IGNORED',
        error_message: safeReason,
        updated_at: nowIso
      },
      { merge: true }
    );
  }

  if (db && db.run) {
    try {
      await db.run(
        `UPDATE webhook_events 
         SET status = 'IGNORED', error_message = ?, updated_at = ?
         WHERE provider = ? AND event_id = ?`,
        [safeReason, nowIso, provider, eventId]
      );
    } catch (e) {
      logger.warn(`Failed to update SQLite webhook_events to IGNORED: ${e}`);
    }
  }
}

/**
 * Retrieves a webhook event record from authoritative Firestore or SQLite for verification.
 */
export async function getWebhookEvent(
  db: any,
  provider: string,
  eventId: string
): Promise<WebhookEventRecord | null> {
  if (isFirestoreActive()) {
    const firestore = getFirestoreInstance()!;
    const docId = `${provider}_${eventId}`;
    const snap = await firestore.collection('webhook_events').doc(docId).get();
    if (snap.exists) {
      return snap.data() as WebhookEventRecord;
    }
  }

  if (db && db.get) {
    const row = await db.get(
      'SELECT * FROM webhook_events WHERE provider = ? AND event_id = ?',
      [provider, eventId]
    );
    return row || null;
  }

  return null;
}
