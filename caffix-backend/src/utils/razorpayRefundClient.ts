import crypto from 'crypto';
import logger from './logger';
import { BadRequestError, ServiceUnavailableError } from './errors';
import {
  isMockSecretValue,
  isRefundSubmissionEnabled,
  resolveRefundRelayConfig,
  resolveValidatedRazorpayEnvironment
} from './security';

export interface GatewayRefundRequest {
  orderId: string;
  paymentId: string;
  amountPaise: number;
  receipt?: string;
  idempotencyKey?: string;
  notes?: Record<string, string>;
  speed?: 'normal' | 'optimum';
}

export interface GatewayRefundResponse {
  success: boolean;
  isMock: boolean;
  isTimeout?: boolean;
  isUncertain?: boolean;
  httpStatusCode?: number;
  razorpayRefundId?: string;
  paymentId: string;
  amountPaise: number;
  currency: string;
  status: 'PROCESSED' | 'PENDING' | 'FAILED';
  processedAt?: string;
  errorCode?: string;
  errorDescription?: string;
  errorReason?: string;
  errorSource?: string;
  errorStep?: string;
  amountMismatch?: boolean;
  currencyMismatch?: boolean;
  rawResponse?: any;
}

export type RefundRelayTransport = (
  url: string,
  init: {
    method: 'POST';
    headers: Record<string, string>;
    body: string;
    redirect: 'error';
    signal?: AbortSignal;
  }
) => Promise<{
  status: number;
  text: () => Promise<string>;
}>;

export interface RelayHttpResult {
  httpStatus: number | null;
  rawText: string;
  parsed: any;
  isTimeout: boolean;
  isNetworkError: boolean;
  isInvalidJson: boolean;
  errorCode?: string;
  errorMessage?: string;
}

const DEFAULT_RELAY_TIMEOUT_MS = 20_000;

function redactCredentialsFromErrorText(raw: string): string {
  return raw
    .replace(/\b(Basic|Bearer)\s+[A-Za-z0-9+/=_.-]+/gi, '$1 [REDACTED]')
    .replace(/\brzp_(live|test)_[A-Za-z0-9]+\b/gi, 'rzp_$1_[REDACTED]');
}

let testRazorpayRefundClientOverride: any = null;
let testRefundRelayTransportOverride: RefundRelayTransport | null = null;

/**
 * Injects a test mock client for legacy unit tests.
 * Pass null to reset to standard configuration.
 */
export function setRazorpayRefundClientForTesting(client: any | null): void {
  testRazorpayRefundClientOverride = client;
}

/**
 * Injects a mock HTTP transport for VPS Refund Relay unit tests.
 * Pass null to reset to standard fetch.
 */
export function setRefundRelayTransportForTesting(transport: RefundRelayTransport | null): void {
  testRefundRelayTransportOverride = transport;
}

export function getTestRazorpayRefundClientOverride(): any | null {
  return testRazorpayRefundClientOverride;
}

/**
 * Pre-flight check called BEFORE creating a Firestore PENDING reservation so that
 * disabled refunds (`RAZORPAY_REFUNDS_ENABLED !== 'true'`) or missing relay config
 * fail closed without leaving a dangling PENDING reservation.
 */
export function assertRefundExecutionReady(paymentId: string, amountPaise: number): void {
  const cleanPaymentId = String(paymentId || '').trim();
  const env = resolveValidatedRazorpayEnvironment();
  const envLabel = env.mode === 'production' ? 'Production' : 'Preview';
  const { isMockMode } = resolveRazorpayRefundConfig();
  const isMockOrTestPaymentId =
    cleanPaymentId.startsWith('pay_mock_') || cleanPaymentId.startsWith('test_');

  if (env.strict && isMockOrTestPaymentId) {
    throw new BadRequestError(
      `Mock or test payment IDs (pay_mock_*, test_*) are not allowed for refund execution in ${envLabel}`
    );
  }

  const hasRelayOverrideOrUrl =
    Boolean(testRefundRelayTransportOverride) ||
    Boolean((process.env.REFUND_RELAY_URL || '').trim());

  const hasExplicitRefundGate = process.env.RAZORPAY_REFUNDS_ENABLED !== undefined;

  if (
    !env.strict &&
    !testRazorpayRefundClientOverride &&
    !hasRelayOverrideOrUrl &&
    !hasExplicitRefundGate &&
    isMockOrTestPaymentId
  ) {
    return;
  }

  if (testRazorpayRefundClientOverride && !testRefundRelayTransportOverride) {
    return;
  }

  if (!isRefundSubmissionEnabled()) {
    throw new ServiceUnavailableError(
      'Refund submission is disabled: RAZORPAY_REFUNDS_ENABLED must be strictly "true" (HTTP 503)'
    );
  }
  const relayCfg = resolveRefundRelayConfig();
  if (
    (process.env.NODE_ENV || '').trim().toLowerCase() === 'production' &&
    new URL(relayCfg.relayUrl).protocol !== 'https:'
  ) {
    throw new ServiceUnavailableError(
      'Refund relay unavailable: REFUND_RELAY_URL must use https:// in production (HTTP 503)'
    );
  }
  if (!Number.isInteger(amountPaise) || !Number.isSafeInteger(amountPaise) || amountPaise < 100) {
    throw new BadRequestError('Refund amount must be at least 100 paise for VPS Refund Relay');
  }
}

/**
 * Computes the exact VPS HMAC-SHA256 signature:
 *   message = timestamp.encode("utf-8") + b"." + body
 *   expected = hmac.new(RELAY_SECRET.encode("utf-8"), message, hashlib.sha256).hexdigest()
 */
export function computeRefundRelayHmacSignature(
  relaySecret: string,
  timestampSeconds: string,
  rawBody: string
): string {
  const message = Buffer.concat([
    Buffer.from(timestampSeconds, 'utf8'),
    Buffer.from('.', 'utf8'),
    Buffer.from(rawBody, 'utf8')
  ]);
  return crypto.createHmac('sha256', relaySecret).update(message).digest('hex');
}

/**
 * Sends an authenticated HMAC-SHA256 POST request to the Ubuntu VPS Refund Relay.
 * Serializes JSON exactly once, signs those exact bytes, and enforces a bounded timeout.
 */
export async function invokeRefundRelay(
  endpointPath: '/v1/refunds' | '/v1/refunds/reconcile' | '/v1/refunds/status',
  payload: Record<string, any>,
  options: { timeoutMs?: number; timestampSeconds?: string } = {}
): Promise<RelayHttpResult> {
  const { relayUrl, relaySecret } = resolveRefundRelayConfig();
  if (
    (process.env.NODE_ENV || '').trim().toLowerCase() === 'production' &&
    new URL(relayUrl).protocol !== 'https:'
  ) {
    throw new ServiceUnavailableError(
      'Refund relay unavailable: REFUND_RELAY_URL must use https:// in production (HTTP 503)'
    );
  }
  const rawBody = JSON.stringify(payload);
  const timestamp = options.timestampSeconds ?? String(Math.floor(Date.now() / 1000));
  const signature = computeRefundRelayHmacSignature(relaySecret, timestamp, rawBody);
  const targetUrl = `${relayUrl}${endpointPath}`;
  const timeoutMs =
    options.timeoutMs && Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
      ? options.timeoutMs
      : DEFAULT_RELAY_TIMEOUT_MS;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const transport: RefundRelayTransport =
    testRefundRelayTransportOverride ||
    ((url, init) => fetch(url, init));

  try {
    const response = await transport(targetUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Relay-Timestamp': timestamp,
        'X-Relay-Signature': signature
      },
      body: rawBody,
      redirect: 'error',
      signal: controller.signal
    });

    const rawText = await response.text();
    let parsed: any = null;
    let isInvalidJson = false;
    if (rawText) {
      try {
        parsed = JSON.parse(rawText);
      } catch {
        isInvalidJson = true;
      }
    } else {
      isInvalidJson = true;
    }

    return {
      httpStatus: response.status,
      rawText,
      parsed,
      isTimeout: false,
      isNetworkError: false,
      isInvalidJson
    };
  } catch (error: any) {
    const rawMsg = String(error?.message || error || '');
    const cleanMsg = redactCredentialsFromErrorText(rawMsg).trim();
    const errCode = String(error?.code || error?.cause?.code || error?.name || 'NETWORK_ERROR');
    const isTimeout =
      errCode === 'AbortError' ||
      errCode === 'ETIMEDOUT' ||
      errCode === 'ESOCKETTIMEDOUT' ||
      cleanMsg.toLowerCase().includes('timeout') ||
      cleanMsg.toLowerCase().includes('aborted');

    return {
      httpStatus: null,
      rawText: '',
      parsed: null,
      isTimeout,
      isNetworkError: true,
      isInvalidJson: false,
      errorCode: isTimeout ? 'RELAY_TIMEOUT' : errCode,
      errorMessage: cleanMsg
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Resolves active Razorpay / Refund Relay configuration.
 * Enforces production fail-closed isolation if real credentials are missing or mock.
 */
export function resolveRazorpayRefundConfig(): {
  isMockMode: boolean;
  razorpayKeyId: string;
  razorpayClient: any;
} {
  const env = resolveValidatedRazorpayEnvironment();
  const { strict, mode, keyId: razorpayKeyId, keySecret: razorpayKeySecret } = env;
  const envLabel = mode === 'production' ? 'Production' : 'Preview';

  const hasValidCredentials =
    Boolean(razorpayKeyId) &&
    Boolean(razorpayKeySecret) &&
    !isMockSecretValue(razorpayKeyId) &&
    !isMockSecretValue(razorpayKeySecret);

  if (strict && !hasValidCredentials) {
    throw new ServiceUnavailableError(
      `Refund gateway unavailable: Razorpay credentials (RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET) are missing or mock in ${envLabel}`
    );
  }

  if (testRazorpayRefundClientOverride) {
    return {
      isMockMode: false,
      razorpayKeyId: razorpayKeyId || 'rzp_test_refund_override',
      razorpayClient: testRazorpayRefundClientOverride
    };
  }

  if (!hasValidCredentials) {
    if (strict) {
      throw new ServiceUnavailableError(
        `Refund gateway unavailable: mock refund mode is disabled in ${envLabel}`
      );
    }
    return { isMockMode: true, razorpayKeyId: '', razorpayClient: null };
  }

  return {
    isMockMode: false,
    razorpayKeyId,
    razorpayClient: null
  };
}

/**
 * Executes a refund request against the Razorpay Payments API.
 *
 * CRITICAL ARCHITECTURAL GUARANTEES & LIMITATIONS:
 * 1. Razorpay SDK Idempotency Header Limitation:
 *    The official Razorpay Node SDK (razorpay npm package) passes only `url` and `data` in its HTTP client.
 *    It does NOT support an HTTP `X-Razorpay-Idempotency-Key` or `X-Idempotency-Key` header on `payments.refund`.
 *    Consequently, the Razorpay gateway will NOT deduplicate refund calls if the client calls `refund` multiple times.
 * 2. Mandated Pre-Reservation Lock:
 *    Callers MUST create a persistent pending reservation in SQLite / Firestore BEFORE invoking this function.
 * 3. Unique Receipt Correlation:
 *    The unique reservation ID is passed as `receipt` in the refund payload.
 * 4. Timeout / Network Interruption Policy:
 *    If an HTTP timeout or network error occurs, `isTimeout: true` is returned.
 *    Callers must NEVER automatically retry an uncertain refund request. The reservation must remain PENDING
 *    until resolved by webhook or authoritative reconciliation.
 */
export async function executeGatewayRefund(params: GatewayRefundRequest): Promise<GatewayRefundResponse> {
  const paymentId = String(params.paymentId || '').trim();
  const orderId = String(params.orderId || '').trim();
  const requestedPaise = Number(params.amountPaise);

  // 1. Parameter validation: strictly positive safe integer paise
  if (!Number.isInteger(requestedPaise) || !Number.isSafeInteger(requestedPaise) || requestedPaise <= 0) {
    throw new BadRequestError('Refund amount must be a positive safe integer in paise');
  }

  if (!paymentId) {
    throw new BadRequestError('Missing mandatory Razorpay payment_id for refund');
  }

  const env = resolveValidatedRazorpayEnvironment();
  const strict = env.strict;
  const envLabel = env.mode === 'production' ? 'Production' : 'Preview';
  const { isMockMode, razorpayClient } = resolveRazorpayRefundConfig();

  const isMockOrTestPaymentId =
    paymentId.startsWith('pay_mock_') ||
    paymentId.startsWith('test_');

  if (strict && isMockOrTestPaymentId) {
    throw new BadRequestError(
      `Mock or test payment IDs (pay_mock_*, test_*) are not allowed for refund execution in ${envLabel}`
    );
  }

  const hasRelayOverrideOrUrl =
    Boolean(testRefundRelayTransportOverride) ||
    Boolean((process.env.REFUND_RELAY_URL || '').trim());

  const hasExplicitRefundGate = process.env.RAZORPAY_REFUNDS_ENABLED !== undefined;

  // 2. Simulated / Local Mock Gateway Execution (strictly non-Production, non-Preview, mock payment IDs only)
  if (!strict && !testRazorpayRefundClientOverride && !hasRelayOverrideOrUrl && !hasExplicitRefundGate && isMockOrTestPaymentId) {
    logger.info(
      `[Mock Gateway] Simulating refund for order ${orderId} (payment ${paymentId}, amount: ${requestedPaise} paise)`
    );

    // Simulated rejection trigger
    if (paymentId.includes('fail') || paymentId.includes('reject')) {
      return {
        success: false,
        isMock: true,
        isTimeout: false,
        paymentId,
        amountPaise: requestedPaise,
        currency: 'INR',
        status: 'FAILED',
        errorCode: 'BAD_REQUEST_ERROR',
        errorDescription: 'Simulated gateway rejection: Payment already refunded or card expired'
      };
    }

    // Simulated timeout trigger
    if (paymentId.includes('timeout') || paymentId.includes('hangup')) {
      return {
        success: false,
        isMock: true,
        isTimeout: true,
        paymentId,
        amountPaise: requestedPaise,
        currency: 'INR',
        status: 'PENDING',
        errorCode: 'GATEWAY_TIMEOUT',
        errorDescription: 'Simulated gateway network timeout: Request timed out while awaiting Razorpay response'
      };
    }

    // Simulated amount mismatch trigger (lower or higher amount)
    if (paymentId.includes('mismatch_lower') || paymentId.includes('amount_lower')) {
      const mockRefundId = `rfnd_mock_${crypto.randomBytes(6).toString('hex')}`;
      const lowerPaise = Math.max(100, requestedPaise - 2000);
      return {
        success: false,
        isMock: true,
        razorpayRefundId: mockRefundId,
        paymentId,
        amountPaise: lowerPaise,
        currency: 'INR',
        status: 'PENDING',
        amountMismatch: true,
        errorCode: 'GATEWAY_AMOUNT_MISMATCH',
        errorDescription: `Gateway reported refund amount ${lowerPaise} paise does not match requested ${requestedPaise} paise`,
        rawResponse: { id: mockRefundId, status: 'processed', amount: lowerPaise, currency: 'INR' }
      };
    }

    if (paymentId.includes('mismatch_higher') || paymentId.includes('amount_higher')) {
      const mockRefundId = `rfnd_mock_${crypto.randomBytes(6).toString('hex')}`;
      const higherPaise = requestedPaise + 2000;
      return {
        success: false,
        isMock: true,
        razorpayRefundId: mockRefundId,
        paymentId,
        amountPaise: higherPaise,
        currency: 'INR',
        status: 'PENDING',
        amountMismatch: true,
        errorCode: 'GATEWAY_AMOUNT_MISMATCH',
        errorDescription: `Gateway reported refund amount ${higherPaise} paise does not match requested ${requestedPaise} paise`,
        rawResponse: { id: mockRefundId, status: 'processed', amount: higherPaise, currency: 'INR' }
      };
    }

    // Simulated missing amount trigger
    if (paymentId.includes('missing_amount')) {
      const mockRefundId = `rfnd_mock_${crypto.randomBytes(6).toString('hex')}`;
      return {
        success: false,
        isMock: true,
        razorpayRefundId: mockRefundId,
        paymentId,
        amountPaise: NaN,
        currency: 'INR',
        status: 'PENDING',
        amountMismatch: true,
        errorCode: 'GATEWAY_AMOUNT_MISMATCH',
        errorDescription: 'Gateway response is missing the amount field',
        rawResponse: { id: mockRefundId, status: 'processed', currency: 'INR' }
      };
    }

    // Simulated invalid non-INR currency trigger
    if (paymentId.includes('invalid_currency') || paymentId.includes('currency_usd')) {
      const mockRefundId = `rfnd_mock_${crypto.randomBytes(6).toString('hex')}`;
      return {
        success: false,
        isMock: true,
        razorpayRefundId: mockRefundId,
        paymentId,
        amountPaise: requestedPaise,
        currency: 'USD',
        status: 'PENDING',
        currencyMismatch: true,
        errorCode: 'GATEWAY_CURRENCY_MISMATCH',
        errorDescription: 'Gateway reported non-INR currency "USD"',
        rawResponse: { id: mockRefundId, status: 'processed', amount: requestedPaise, currency: 'USD' }
      };
    }

    // Simulated malformed amount trigger (negative, decimal, zero, or NaN)
    if (paymentId.includes('decimal_amount')) {
      const mockRefundId = `rfnd_mock_${crypto.randomBytes(6).toString('hex')}`;
      return {
        success: false,
        isMock: true,
        razorpayRefundId: mockRefundId,
        paymentId,
        amountPaise: 49.99,
        currency: 'INR',
        status: 'PENDING',
        amountMismatch: true,
        errorCode: 'GATEWAY_AMOUNT_MISMATCH',
        errorDescription: 'Gateway reported non-integer decimal amount 49.99',
        rawResponse: { id: mockRefundId, status: 'processed', amount: 49.99, currency: 'INR' }
      };
    }

    if (paymentId.includes('negative_amount')) {
      const mockRefundId = `rfnd_mock_${crypto.randomBytes(6).toString('hex')}`;
      return {
        success: false,
        isMock: true,
        razorpayRefundId: mockRefundId,
        paymentId,
        amountPaise: -5000,
        currency: 'INR',
        status: 'PENDING',
        amountMismatch: true,
        errorCode: 'GATEWAY_AMOUNT_MISMATCH',
        errorDescription: 'Gateway reported negative refund amount -5000',
        rawResponse: { id: mockRefundId, status: 'processed', amount: -5000, currency: 'INR' }
      };
    }

    if (paymentId.includes('zero_amount')) {
      const mockRefundId = `rfnd_mock_${crypto.randomBytes(6).toString('hex')}`;
      return {
        success: false,
        isMock: true,
        razorpayRefundId: mockRefundId,
        paymentId,
        amountPaise: 0,
        currency: 'INR',
        status: 'PENDING',
        amountMismatch: true,
        errorCode: 'GATEWAY_AMOUNT_MISMATCH',
        errorDescription: 'Gateway reported zero refund amount',
        rawResponse: { id: mockRefundId, status: 'processed', amount: 0, currency: 'INR' }
      };
    }

    // Simulated pending settlement trigger
    if (paymentId.includes('pending')) {
      const mockRefundId = `rfnd_mock_${crypto.randomBytes(6).toString('hex')}`;
      return {
        success: true,
        isMock: true,
        razorpayRefundId: mockRefundId,
        paymentId,
        amountPaise: requestedPaise,
        currency: 'INR',
        status: 'PENDING',
        rawResponse: { id: mockRefundId, status: 'pending', amount: requestedPaise }
      };
    }

    // Default: Instant simulated processed settlement
    const mockRefundId = `rfnd_mock_${crypto.randomBytes(6).toString('hex')}`;
    const nowIso = new Date().toISOString();
    return {
      success: true,
      isMock: true,
      razorpayRefundId: mockRefundId,
      paymentId,
      amountPaise: requestedPaise,
      currency: 'INR',
      status: 'PROCESSED',
      processedAt: nowIso,
      rawResponse: { id: mockRefundId, status: 'processed', amount: requestedPaise, created_at: Math.floor(Date.now() / 1000) }
    };
  }

  // 2b. Legacy unit-test mock client override (never used in real production/relay execution)
  if (testRazorpayRefundClientOverride && !testRefundRelayTransportOverride) {
    try {
      const rpResponse = await razorpayClient.payments.refund(paymentId, {
        amount: requestedPaise,
        ...(params.receipt ? { receipt: params.receipt } : {}),
        ...(params.notes && Object.keys(params.notes).length > 0 ? { notes: params.notes } : {}),
        ...(params.speed ? { speed: params.speed } : {})
      });
      if (!rpResponse || !rpResponse.id) {
        return {
          success: false,
          isMock: false,
          isTimeout: false,
          paymentId,
          amountPaise: requestedPaise,
          currency: 'INR',
          status: 'FAILED',
          errorCode: 'GATEWAY_INVALID_RESPONSE',
          errorDescription: 'Mock refund client returned empty or malformed refund response'
        };
      }
      const rawStatus = String(rpResponse.status || '').toLowerCase();
      let status: 'PROCESSED' | 'PENDING' | 'FAILED' = 'PROCESSED';
      let processedAt: string | undefined;
      if (rawStatus === 'processed') {
        status = 'PROCESSED';
        processedAt = rpResponse.created_at
          ? new Date(Number(rpResponse.created_at) * 1000).toISOString()
          : new Date().toISOString();
      } else if (rawStatus === 'pending' || rawStatus === 'submitted') {
        status = 'PENDING';
      } else if (rawStatus === 'failed') {
        status = 'FAILED';
      }
      const gatewayAmount =
        rpResponse.amount !== undefined && rpResponse.amount !== null ? Number(rpResponse.amount) : NaN;
      const gatewayCurrency = String(rpResponse.currency || '').trim().toUpperCase();
      const isAmountValid =
        Number.isInteger(gatewayAmount) && Number.isSafeInteger(gatewayAmount) && gatewayAmount === requestedPaise;
      const isCurrencyValid = gatewayCurrency === 'INR';
      return {
        success: status !== 'FAILED' && isAmountValid && isCurrencyValid,
        isMock: false,
        razorpayRefundId: String(rpResponse.id),
        paymentId,
        amountPaise: Number.isFinite(gatewayAmount) ? gatewayAmount : requestedPaise,
        currency: gatewayCurrency || 'INR',
        status: !isAmountValid || !isCurrencyValid ? 'PENDING' : status,
        processedAt,
        amountMismatch: !isAmountValid,
        currencyMismatch: isAmountValid && !isCurrencyValid,
        errorCode: !isAmountValid ? 'GATEWAY_AMOUNT_MISMATCH' : !isCurrencyValid ? 'GATEWAY_CURRENCY_MISMATCH' : undefined,
        errorDescription: !isAmountValid
          ? `Gateway reported refund amount ${gatewayAmount} does not match requested safe integer ${requestedPaise} paise`
          : !isCurrencyValid
            ? `Gateway reported non-INR currency "${gatewayCurrency}" (expected INR)`
            : undefined,
        rawResponse: rpResponse
      };
    } catch (error: any) {
      const rawStatus = error?.statusCode ?? error?.response?.status;
      const httpStatusCode =
        typeof rawStatus === 'number' && Number.isInteger(rawStatus) && rawStatus > 0 ? rawStatus : undefined;
      const rpErrObj = error?.error && typeof error.error === 'object' ? error.error : undefined;
      const rawErrorMsg = String(error?.message || rpErrObj?.description || '');
      const errorMsg = redactCredentialsFromErrorText(rawErrorMsg).trim();
      const errorCode = String(error?.code || rpErrObj?.code || 'GATEWAY_ERROR');
      const errorReason = rpErrObj?.reason ? redactCredentialsFromErrorText(String(rpErrObj.reason)).trim() : undefined;
      const errorSource = rpErrObj?.source ? redactCredentialsFromErrorText(String(rpErrObj.source)).trim() : undefined;
      const errorStep = rpErrObj?.step ? redactCredentialsFromErrorText(String(rpErrObj.step)).trim() : undefined;
      const metaParts: string[] = [];
      if (httpStatusCode !== undefined) metaParts.push(`http=${httpStatusCode}`);
      if (errorReason) metaParts.push(`reason=${errorReason}`);
      if (errorSource) metaParts.push(`source=${errorSource}`);
      if (errorStep) metaParts.push(`step=${errorStep}`);
      const metaSuffix = metaParts.length > 0 ? ` (${metaParts.join(', ')})` : '';
      const isTimeout =
        errorCode === 'ETIMEDOUT' ||
        errorCode === 'ESOCKETTIMEDOUT' ||
        errorCode === 'ECONNRESET' ||
        errorCode === 'ECONNABORTED' ||
        errorMsg.toLowerCase().includes('timeout') ||
        errorMsg.toLowerCase().includes('socket hang up');
      if (isTimeout) {
        return {
          success: false,
          isMock: false,
          isTimeout: true,
          httpStatusCode,
          paymentId,
          amountPaise: requestedPaise,
          currency: 'INR',
          status: 'PENDING',
          errorCode: 'GATEWAY_TIMEOUT',
          errorReason,
          errorSource,
          errorStep,
          errorDescription: `Gateway request timed out: ${errorMsg}${metaSuffix}`
        };
      }
      return {
        success: false,
        isMock: false,
        isTimeout: false,
        httpStatusCode,
        paymentId,
        amountPaise: requestedPaise,
        currency: 'INR',
        status: 'FAILED',
        errorCode,
        errorReason,
        errorSource,
        errorStep,
        errorDescription: `${errorMsg || 'Payment gateway rejected refund request'}${metaSuffix}`
      };
    }
  }

  // 3. Ubuntu VPS FastAPI Refund Relay Invocation (NO direct Vercel -> Razorpay refund calls)
  if (!isRefundSubmissionEnabled()) {
    throw new ServiceUnavailableError(
      'Refund submission is disabled: RAZORPAY_REFUNDS_ENABLED must be strictly "true" (HTTP 503)'
    );
  }

  if (requestedPaise < 100) {
    throw new BadRequestError('Refund amount must be at least 100 paise for VPS Refund Relay');
  }

  const idempotencyKey = String(params.idempotencyKey || params.receipt || '').trim();
  if (!idempotencyKey) {
    throw new BadRequestError('Missing mandatory idempotency_key for VPS Refund Relay');
  }

  logger.info(
    `Invoking VPS Refund Relay POST /v1/refunds for order ${orderId} (payment ${paymentId}, amount: ${requestedPaise} paise, idempotency_key: ${idempotencyKey})`
  );

  const relayRes = await invokeRefundRelay('/v1/refunds', {
    payment_id: paymentId,
    amount: requestedPaise,
    idempotency_key: idempotencyKey
  });

  if (relayRes.isTimeout || relayRes.isNetworkError || relayRes.isInvalidJson) {
    logger.warn(
      `VPS Refund Relay ambiguous/network outcome for order ${orderId} (payment ${paymentId}, timeout=${relayRes.isTimeout}, invalidJson=${relayRes.isInvalidJson}): ${relayRes.errorMessage || 'invalid JSON'}`
    );
    return {
      success: false,
      isMock: false,
      isTimeout: true,
      isUncertain: true,
      httpStatusCode: relayRes.httpStatus ?? undefined,
      paymentId,
      amountPaise: requestedPaise,
      currency: 'INR',
      status: 'PENDING',
      errorCode: relayRes.errorCode || (relayRes.isInvalidJson ? 'RELAY_INVALID_JSON' : 'RELAY_TIMEOUT'),
      errorDescription:
        relayRes.errorMessage ||
        'VPS Refund Relay returned network interruption or invalid JSON; preserving PENDING for reconciliation'
    };
  }

  const httpStatus = relayRes.httpStatus ?? 500;
  const body = relayRes.parsed && typeof relayRes.parsed === 'object' ? relayRes.parsed : {};
  const relayState = String(body.status || '').trim().toUpperCase();
  const relayMsg = redactCredentialsFromErrorText(String(body.message || body.detail || '')).trim();

  if (httpStatus === 403) {
    logger.warn(`VPS Refund Relay returned HTTP 403 (refunds disabled) for order ${orderId}`);
    return {
      success: false,
      isMock: false,
      isTimeout: false,
      isUncertain: true,
      httpStatusCode: 403,
      paymentId,
      amountPaise: requestedPaise,
      currency: 'INR',
      status: 'PENDING',
      errorCode: 'RELAY_REFUNDS_DISABLED',
      errorDescription: relayMsg || 'Live refund submission is disabled on VPS Refund Relay (HTTP 403)'
    };
  }

  if (httpStatus === 202 || ['UNCERTAIN', 'SUBMISSION_STARTED', 'RESERVED'].includes(relayState)) {
    return {
      success: false,
      isMock: false,
      isTimeout: false,
      isUncertain: true,
      httpStatusCode: httpStatus,
      paymentId,
      amountPaise: requestedPaise,
      currency: 'INR',
      status: 'PENDING',
      errorCode: `RELAY_${relayState || 'UNCERTAIN'}`,
      errorDescription: relayMsg || 'VPS Refund Relay reported uncertain/in-flight state; do not retry, reconcile later'
    };
  }

  if (httpStatus === 409) {
    if (relayState === 'REJECTED') {
      return {
        success: false,
        isMock: false,
        isTimeout: false,
        httpStatusCode: 409,
        paymentId,
        amountPaise: requestedPaise,
        currency: 'INR',
        status: 'FAILED',
        errorCode: String(body.error_code || 'RELAY_REJECTED'),
        errorDescription: relayMsg || 'VPS Refund Relay reported request was previously rejected'
      };
    }
    return {
      success: false,
      isMock: false,
      isTimeout: false,
      isUncertain: true,
      httpStatusCode: 409,
      paymentId,
      amountPaise: requestedPaise,
      currency: 'INR',
      status: 'PENDING',
      errorCode: `RELAY_CONFLICT_${relayState || 'LOCKED'}`,
      errorDescription: relayMsg || 'VPS Refund Relay returned HTTP 409 conflict/lock; preserving PENDING for reconciliation'
    };
  }

  if (httpStatus === 200 && relayState === 'CONFIRMED' && body.refund && typeof body.refund === 'object') {
    const rpResponse = body.refund;
    if (!rpResponse.id) {
      return {
        success: false,
        isMock: false,
        isTimeout: false,
        isUncertain: true,
        httpStatusCode: 200,
        paymentId,
        amountPaise: requestedPaise,
        currency: 'INR',
        status: 'PENDING',
        errorCode: 'RELAY_MISSING_REFUND_ID',
        errorDescription: 'VPS Refund Relay returned CONFIRMED without refund.id'
      };
    }

    const rawStatus = String(rpResponse.status || '').toLowerCase();
    let status: 'PROCESSED' | 'PENDING' | 'FAILED' = 'PROCESSED';
    let processedAt: string | undefined;

    if (rawStatus === 'processed') {
      status = 'PROCESSED';
      processedAt = rpResponse.created_at
        ? new Date(Number(rpResponse.created_at) * 1000).toISOString()
        : new Date().toISOString();
    } else if (rawStatus === 'pending' || rawStatus === 'submitted') {
      status = 'PENDING';
    } else if (rawStatus === 'failed') {
      status = 'FAILED';
    }

    const gatewayAmount =
      rpResponse.amount !== undefined && rpResponse.amount !== null ? Number(rpResponse.amount) : NaN;
    const gatewayCurrency = String(rpResponse.currency || 'INR').trim().toUpperCase();
    const isAmountValidInteger =
      Number.isInteger(gatewayAmount) && Number.isSafeInteger(gatewayAmount) && gatewayAmount > 0;
    const isAmountExactMatch = isAmountValidInteger && gatewayAmount === requestedPaise;
    const isCurrencyValid = gatewayCurrency === 'INR';

    let amountMismatch = false;
    let currencyMismatch = false;
    let errorCode: string | undefined;
    let errorDescription: string | undefined;

    if (!isAmountValidInteger || !isAmountExactMatch) {
      amountMismatch = true;
      errorCode = 'GATEWAY_AMOUNT_MISMATCH';
      errorDescription = `Relay reported refund amount ${gatewayAmount} does not match requested safe integer ${requestedPaise} paise`;
    } else if (!isCurrencyValid) {
      currencyMismatch = true;
      errorCode = 'GATEWAY_CURRENCY_MISMATCH';
      errorDescription = `Relay reported non-INR currency "${gatewayCurrency}" (expected INR)`;
    }

    return {
      success: status !== 'FAILED' && !amountMismatch && !currencyMismatch,
      isMock: false,
      httpStatusCode: 200,
      razorpayRefundId: String(rpResponse.id),
      paymentId,
      amountPaise: Number.isFinite(gatewayAmount) ? gatewayAmount : requestedPaise,
      currency: gatewayCurrency || 'INR',
      status: amountMismatch || currencyMismatch ? 'PENDING' : status,
      processedAt,
      amountMismatch,
      currencyMismatch,
      errorCode,
      errorDescription,
      rawResponse: body
    };
  }

  if (relayState === 'REJECTED' && httpStatus >= 400 && httpStatus < 500) {
    return {
      success: false,
      isMock: false,
      isTimeout: false,
      httpStatusCode: httpStatus,
      paymentId,
      amountPaise: requestedPaise,
      currency: 'INR',
      status: 'FAILED',
      errorCode: String(body.error_code || 'RELAY_REJECTED'),
      errorDescription: relayMsg || `VPS Refund Relay rejected refund (HTTP ${httpStatus})`
    };
  }

  return {
    success: false,
    isMock: false,
    isTimeout: false,
    isUncertain: true,
    httpStatusCode: httpStatus,
    paymentId,
    amountPaise: requestedPaise,
    currency: 'INR',
    status: 'PENDING',
    errorCode: `RELAY_HTTP_${httpStatus}`,
    errorDescription: relayMsg || `VPS Refund Relay returned ambiguous HTTP ${httpStatus}; preserving PENDING for reconciliation`
  };
}

export interface RelayReconcileResult {
  outcome: 'CONFIRMED' | 'REJECTED' | 'UNCERTAIN';
  httpStatusCode?: number;
  refund?: {
    id: string;
    payment_id: string;
    amount: number;
    currency: string;
    status: string;
    created_at?: number;
  };
  errorCode?: string;
  errorDescription?: string;
}

/**
 * Reconciles an existing refund request via VPS POST /v1/refunds/reconcile.
 * Never submits a new refund.
 */
export async function reconcileRelayRefund(idempotencyKey: string): Promise<RelayReconcileResult> {
  const cleanKey = String(idempotencyKey || '').trim();
  if (!cleanKey) {
    return {
      outcome: 'UNCERTAIN',
      errorCode: 'MISSING_IDEMPOTENCY_KEY',
      errorDescription: 'Missing idempotency_key for VPS reconciliation'
    };
  }

  const relayRes = await invokeRefundRelay('/v1/refunds/reconcile', {
    idempotency_key: cleanKey
  });

  if (relayRes.isTimeout || relayRes.isNetworkError || relayRes.isInvalidJson || !relayRes.parsed) {
    return {
      outcome: 'UNCERTAIN',
      httpStatusCode: relayRes.httpStatus ?? undefined,
      errorCode: relayRes.errorCode || 'RELAY_RECONCILE_UNCERTAIN',
      errorDescription: relayRes.errorMessage || 'VPS reconcile returned network/parse error'
    };
  }

  const body = relayRes.parsed;
  const state = String(body.status || '').trim().toUpperCase();
  const msg = redactCredentialsFromErrorText(String(body.message || body.detail || '')).trim();

  if (relayRes.httpStatus === 200 && state === 'CONFIRMED' && body.refund && typeof body.refund === 'object') {
    return {
      outcome: 'CONFIRMED',
      httpStatusCode: 200,
      refund: {
        id: String(body.refund.id || ''),
        payment_id: String(body.refund.payment_id || ''),
        amount: Number(body.refund.amount),
        currency: String(body.refund.currency || 'INR').trim().toUpperCase(),
        status: String(body.refund.status || '').trim().toLowerCase(),
        created_at: body.refund.created_at !== undefined ? Number(body.refund.created_at) : undefined
      }
    };
  }

  if (state === 'REJECTED') {
    return {
      outcome: 'REJECTED',
      httpStatusCode: relayRes.httpStatus ?? undefined,
      errorCode: String(body.error_code || 'RELAY_REJECTED'),
      errorDescription: msg || 'VPS reconciliation confirmed refund rejection'
    };
  }

  return {
    outcome: 'UNCERTAIN',
    httpStatusCode: relayRes.httpStatus ?? undefined,
    errorCode: `RELAY_${state || 'UNCERTAIN'}`,
    errorDescription: msg || 'VPS reconciliation status remains uncertain'
  };
}

/**
 * Read-only refund status lookup via VPS POST /v1/refunds/status.
 */
export async function fetchRelayRefundStatus(
  refundId: string,
  paymentId: string
): Promise<RelayReconcileResult> {
  const relayRes = await invokeRefundRelay('/v1/refunds/status', {
    refund_id: String(refundId || '').trim(),
    payment_id: String(paymentId || '').trim()
  });

  if (relayRes.isTimeout || relayRes.isNetworkError || relayRes.isInvalidJson || !relayRes.parsed) {
    return {
      outcome: 'UNCERTAIN',
      httpStatusCode: relayRes.httpStatus ?? undefined,
      errorCode: relayRes.errorCode || 'RELAY_STATUS_UNCERTAIN',
      errorDescription: relayRes.errorMessage || 'VPS status lookup failed'
    };
  }

  const body = relayRes.parsed;
  const refundObj = body.refund && typeof body.refund === 'object' ? body.refund : body;
  if (relayRes.httpStatus === 200 && refundObj && (refundObj.refund_id || refundObj.id)) {
    return {
      outcome: 'CONFIRMED',
      httpStatusCode: 200,
      refund: {
        id: String(refundObj.refund_id || refundObj.id),
        payment_id: String(refundObj.payment_id || paymentId),
        amount: Number(refundObj.amount),
        currency: String(refundObj.currency || 'INR').trim().toUpperCase(),
        status: String(refundObj.status || '').trim().toLowerCase(),
        created_at: refundObj.created_at !== undefined ? Number(refundObj.created_at) : undefined
      }
    };
  }

  return {
    outcome: 'UNCERTAIN',
    httpStatusCode: relayRes.httpStatus ?? undefined,
    errorCode: `RELAY_STATUS_HTTP_${relayRes.httpStatus ?? 'ERR'}`,
    errorDescription: redactCredentialsFromErrorText(String(body.message || body.detail || 'Status unavailable'))
  };
}
