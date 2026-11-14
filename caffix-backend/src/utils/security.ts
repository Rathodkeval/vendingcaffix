import crypto from 'crypto';
import { ServiceUnavailableError } from './errors';

const FORBIDDEN_DEFAULT_PASSCODES = new Set(['1234', '0000', '000000', '123456', '1111', '9999']);
const SENSITIVE_QUERY_KEYS = new Set([
  'kiosk',
  'token',
  'invite_token',
  'setup_token',
  'passcode',
  'password',
  'secret',
  'jwt_secret',
  'private_key',
  'key',
  'razorpay_signature'
]);

export type RazorpayRuntimeMode = 'production' | 'preview' | 'local';

export interface ValidatedRazorpayEnvironment {
  mode: RazorpayRuntimeMode;
  strict: boolean;
  keyId: string;
  keySecret: string;
  webhookSecret: string;
}

/**
 * Returns true when running explicitly in Vercel Production (`VERCEL_ENV=production`).
 */
export function isVercelProduction(): boolean {
  return (process.env.VERCEL_ENV || '').trim().toLowerCase() === 'production';
}

/**
 * Returns true when running explicitly in Vercel Preview (`VERCEL_ENV=preview`).
 */
export function isVercelPreview(): boolean {
  return (process.env.VERCEL_ENV || '').trim().toLowerCase() === 'preview';
}

/**
 * Returns true when a Razorpay Key ID uses Production Live mode (`rzp_live_*`).
 */
export function isLiveRazorpayKeyId(keyId?: string | null): boolean {
  return (keyId || '').trim().toLowerCase().startsWith('rzp_live_');
}

/**
 * Returns true when a Razorpay Key ID uses Sandbox Test mode (`rzp_test_*`).
 */
export function isTestRazorpayKeyId(keyId?: string | null): boolean {
  return (keyId || '').trim().toLowerCase().startsWith('rzp_test_');
}

/**
 * Classifies the active Razorpay runtime mode and fails closed on ambiguous deployed environments.
 */
export function classifyRazorpayRuntimeMode(): RazorpayRuntimeMode {
  const vercelEnv = (process.env.VERCEL_ENV || '').trim().toLowerCase();
  const vercelFlag = (process.env.VERCEL || '').trim().toLowerCase();
  const nodeEnv = (process.env.NODE_ENV || '').trim().toLowerCase();
  const hasVercelRuntime =
    Boolean(vercelFlag) && vercelFlag !== '0' && vercelFlag !== 'false' && vercelFlag !== 'undefined';

  if (vercelEnv && !['production', 'preview', 'development', 'test'].includes(vercelEnv)) {
    throw new ServiceUnavailableError(
      'Payment/refund gateway unavailable: unrecognized VERCEL_ENV classification (HTTP 503)'
    );
  }

  if (vercelEnv === 'production') {
    return 'production';
  }

  if (vercelEnv === 'preview') {
    return 'preview';
  }

  if (hasVercelRuntime || nodeEnv === 'production') {
    throw new ServiceUnavailableError(
      'Payment/refund gateway unavailable: ambiguous runtime environment identification (set VERCEL_ENV explicitly)'
    );
  }

  return 'local';
}

/**
 * Resolves and validates Razorpay credentials according to runtime environment boundaries.
 * - Preview (`VERCEL_ENV=preview`): fail-closed HTTP 503 unless Test Mode `rzp_test_*`, Key Secret,
 *   and Webhook Secret are all present and non-mock; `rzp_live_*` is blocked.
 * - Production (`VERCEL_ENV=production`): fail-closed HTTP 503 unless Live Mode `rzp_live_*`
 *   and non-mock secrets are configured; `rzp_test_*` and mocks are blocked.
 * - Ambiguous deployed/production flags: fail-closed HTTP 503.
 * - Local dev/test only: allows mock fallback when not running in Preview/Production/ambiguous env.
 */
export function resolveValidatedRazorpayEnvironment(
  options: { requireWebhookSecret?: boolean } = {}
): ValidatedRazorpayEnvironment {
  const mode = classifyRazorpayRuntimeMode();
  const keyId = (process.env.RAZORPAY_KEY_ID || '').trim();
  const keySecret = (process.env.RAZORPAY_KEY_SECRET || '').trim();
  const webhookSecret = (process.env.RAZORPAY_WEBHOOK_SECRET || '').trim();

  if (mode === 'preview') {
    if (isLiveRazorpayKeyId(keyId)) {
      throw new ServiceUnavailableError(
        'Preview environment guard: Production Razorpay Live credentials (rzp_live_*) are not permitted in Vercel Preview (HTTP 503)'
      );
    }
    if (!keyId || isMockSecretValue(keyId) || !isTestRazorpayKeyId(keyId)) {
      throw new ServiceUnavailableError(
        'Preview payment service unavailable: valid Razorpay Test Key ID (rzp_test_*) is required in Vercel Preview (HTTP 503)'
      );
    }
    if (!keySecret || isMockSecretValue(keySecret)) {
      throw new ServiceUnavailableError(
        'Preview payment service unavailable: RAZORPAY_KEY_SECRET is missing or mock in Vercel Preview (HTTP 503)'
      );
    }
    if (!webhookSecret || isMockSecretValue(webhookSecret)) {
      throw new ServiceUnavailableError(
        'Preview webhook service unavailable: RAZORPAY_WEBHOOK_SECRET is missing or mock in Vercel Preview (HTTP 503)'
      );
    }
    return { mode: 'preview', strict: true, keyId, keySecret, webhookSecret };
  }

  if (mode === 'production') {
    if (!keyId || isMockSecretValue(keyId) || !isLiveRazorpayKeyId(keyId)) {
      throw new ServiceUnavailableError(
        'Payment service unavailable: valid Razorpay Live Key ID (rzp_live_*) is required in Production (HTTP 503)'
      );
    }
    if (!keySecret || isMockSecretValue(keySecret)) {
      throw new ServiceUnavailableError(
        'Payment service unavailable: RAZORPAY_KEY_SECRET is missing or mock in Production (HTTP 503)'
      );
    }
    if (options.requireWebhookSecret && (!webhookSecret || isMockSecretValue(webhookSecret))) {
      throw new ServiceUnavailableError(
        'Webhook service unavailable: RAZORPAY_WEBHOOK_SECRET is missing or mock in Production (HTTP 503)'
      );
    }
    return { mode: 'production', strict: true, keyId, keySecret, webhookSecret };
  }

  return { mode: 'local', strict: false, keyId, keySecret, webhookSecret };
}

/**
 * Enforces Razorpay environment boundaries for the current runtime mode.
 */
export function assertRazorpayEnvironmentIsolation(): void {
  resolveValidatedRazorpayEnvironment();
}

/**
 * Returns the configured Vercel Cron bearer secret (`CRON_SECRET`), failing closed with HTTP 503
 * if unset, weak (< 16 characters), or a mock/placeholder value.
 */
export function getRequiredCronSecret(): string {
  const secret = (process.env.CRON_SECRET || '').trim();
  if (!secret || isMockSecretValue(secret) || secret.length < 16) {
    throw new ServiceUnavailableError(
      'Scheduled reconciliation unavailable: CRON_SECRET is missing, mock, or shorter than 16 characters'
    );
  }
  return secret;
}

/**
 * Returns true when running in a deployed environment (Vercel Preview/Production or NODE_ENV=production).
 */
export function isDeployedEnvironment(): boolean {
  const vercelEnv = (process.env.VERCEL_ENV || '').trim().toLowerCase();
  const nodeEnv = (process.env.NODE_ENV || '').trim().toLowerCase();
  return (
    vercelEnv === 'production' ||
    vercelEnv === 'preview' ||
    process.env.VERCEL === '1' ||
    nodeEnv === 'production'
  );
}

/**
 * Returns true if a secret/key value is empty or looks like a mock/placeholder credential.
 */
export function isMockSecretValue(value?: string | null): boolean {
  const normalized = (value || '').trim().toLowerCase();
  return (
    !normalized ||
    normalized === 'mock' ||
    normalized === 'null' ||
    normalized === 'undefined' ||
    normalized.includes('mock') ||
    normalized.includes('placeholder') ||
    normalized.includes('changeme')
  );
}

/**
 * Determines whether the optional technician kiosk-admin unlock feature is enabled.
 * - Explicitly disabled when `KIOSK_ADMIN_ENABLED` is `false` / `0` / `off` / `disabled`.
 * - Enabled when `KIOSK_ADMIN_ENABLED` is `true` / `1` / `on` / `enabled`, or when `ADMIN_PASSCODE` is set.
 * - When neither is configured, the optional technician feature is treated as disabled so machines can operate normally.
 */
export function isKioskAdminEnabled(): boolean {
  const flag = (process.env.KIOSK_ADMIN_ENABLED ?? '').trim().toLowerCase();
  if (flag === 'false' || flag === '0' || flag === 'disabled' || flag === 'off') {
    return false;
  }
  if (flag === 'true' || flag === '1' || flag === 'enabled' || flag === 'on') {
    return true;
  }
  return process.env.ADMIN_PASSCODE !== undefined;
}

/**
 * Returns the configured JWT signing secret.
 * Never falls back to a hardcoded secret; fails closed with HTTP 503 if unset.
 */
export function getJwtSecret(): string {
  const secret = (process.env.JWT_SECRET || '').trim();
  if (!secret) {
    throw new ServiceUnavailableError(
      'Authentication service unavailable: JWT_SECRET environment variable is not configured'
    );
  }
  return secret;
}

/**
 * Returns the configured kiosk admin unlock passcode.
 * Removes the legacy '1234' default and enforces an explicitly configured, non-trivial passcode.
 */
export function getRequiredAdminPasscode(): string {
  const flag = (process.env.KIOSK_ADMIN_ENABLED ?? '').trim().toLowerCase();
  if (flag === 'false' || flag === '0' || flag === 'disabled' || flag === 'off') {
    throw new ServiceUnavailableError(
      'Kiosk admin unlock is disabled: KIOSK_ADMIN_ENABLED is set to false'
    );
  }

  const passcode = (process.env.ADMIN_PASSCODE || '').trim();
  if (!passcode) {
    throw new ServiceUnavailableError(
      'Kiosk admin unlock unavailable: ADMIN_PASSCODE environment variable is not configured'
    );
  }
  if (FORBIDDEN_DEFAULT_PASSCODES.has(passcode) || passcode.length < 6) {
    throw new ServiceUnavailableError(
      'Kiosk admin unlock unavailable: configured ADMIN_PASSCODE does not meet minimum security requirements'
    );
  }
  return passcode;
}

/**
 * Validates security environment readiness at startup / cold start in deployed environments.
 * Always requires JWT_SECRET; validates ADMIN_PASSCODE at startup only when kiosk technician unlock is enabled.
 */
export function ensureSecurityConfigReady(): void {
  if (isDeployedEnvironment()) {
    getJwtSecret();
    if (isKioskAdminEnabled()) {
      getRequiredAdminPasscode();
    }
  }
}

/**
 * Constant-time string comparison using fixed-length SHA-256 digests.
 */
export function constantTimeEqual(a: string, b: string): boolean {
  const hashA = crypto.createHash('sha256').update(String(a)).digest();
  const hashB = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(hashA, hashB);
}

/**
 * Enforces strict portal-to-role binding:
 * - 'admin' portal requires 'admin' role
 * - 'owner' portal requires 'owner' role
 * - 'kiosk' role must never carry a dashboard portal claim
 */
export function isValidRoleForPortal(role: string | undefined, portal?: string | null): boolean {
  if (!portal) {
    return role === 'admin' || role === 'owner' || role === 'kiosk';
  }
  const normalizedPortal = String(portal).trim().toLowerCase();
  if (normalizedPortal === 'admin') {
    return role === 'admin';
  }
  if (normalizedPortal === 'owner') {
    return role === 'owner';
  }
  return false;
}

/**
 * Redacts sensitive query parameter values (kiosk tokens, setup tokens, passcodes, secrets)
 * before URLs are written to application or error logs.
 */
export function sanitizeUrlForLogging(rawUrl: string): string {
  if (!rawUrl || typeof rawUrl !== 'string') {
    return String(rawUrl || '');
  }
  const qIdx = rawUrl.indexOf('?');
  if (qIdx === -1) {
    return rawUrl;
  }

  const basePath = rawUrl.slice(0, qIdx);
  const queryPart = rawUrl.slice(qIdx + 1);
  try {
    const params = new URLSearchParams(queryPart);
    let mutated = false;
    for (const key of Array.from(params.keys())) {
      if (SENSITIVE_QUERY_KEYS.has(key.toLowerCase())) {
        params.set(key, '[REDACTED]');
        mutated = true;
      }
    }
    if (!mutated) {
      return rawUrl;
    }
    const serialized = params.toString();
    return serialized ? `${basePath}?${serialized}` : basePath;
  } catch {
    return `${basePath}?[REDACTED]`;
  }
}

/**
 * Scrubs accidental Bearer tokens, PEM private keys, and sensitive query parameters from log strings.
 */
export function redactSensitiveText(input: string): string {
  if (!input || typeof input !== 'string') {
    return String(input || '');
  }
  return input
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[REDACTED_PRIVATE_KEY]')
    .replace(/Bearer\s+[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+/gi, 'Bearer [REDACTED_JWT]')
    .replace(
      /([?&](?:kiosk|token|invite_token|setup_token|passcode|password|secret|private_key)=)[^&\s]+/gi,
      '$1[REDACTED]'
    );
}

