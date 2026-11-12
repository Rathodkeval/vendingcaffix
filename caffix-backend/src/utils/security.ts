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
 * Prevents Vercel Preview deployments from using Production Razorpay Live credentials.
 */
export function assertRazorpayEnvironmentIsolation(): void {
  const keyId = (process.env.RAZORPAY_KEY_ID || '').trim();
  if (isVercelPreview() && isLiveRazorpayKeyId(keyId)) {
    throw new ServiceUnavailableError(
      'Preview environment guard: Production Razorpay Live credentials (rzp_live_*) are not permitted in Vercel Preview (HTTP 503)'
    );
  }
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

