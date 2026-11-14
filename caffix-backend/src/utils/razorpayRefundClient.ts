import crypto from 'crypto';
import logger from './logger';
import { BadRequestError, ServiceUnavailableError } from './errors';
import {
  isMockSecretValue,
  resolveValidatedRazorpayEnvironment
} from './security';

const Razorpay = require('razorpay');

export interface GatewayRefundRequest {
  orderId: string;
  paymentId: string;
  amountPaise: number;
  receipt?: string;
  notes?: Record<string, string>;
  speed?: 'normal' | 'optimum';
}

export interface GatewayRefundResponse {
  success: boolean;
  isMock: boolean;
  isTimeout?: boolean;
  razorpayRefundId?: string;
  paymentId: string;
  amountPaise: number;
  currency: string;
  status: 'PROCESSED' | 'PENDING' | 'FAILED';
  processedAt?: string;
  errorCode?: string;
  errorDescription?: string;
  amountMismatch?: boolean;
  currencyMismatch?: boolean;
  rawResponse?: any;
}

let cachedRazorpayClient: any = null;
let cachedRazorpaySignature: string | null = null;
let testRazorpayRefundClientOverride: any = null;

/**
 * Injects a test mock client for the refund wrapper.
 * Pass null to reset to standard configuration.
 */
export function setRazorpayRefundClientForTesting(client: any | null): void {
  testRazorpayRefundClientOverride = client;
}

/**
 * Resolves active Razorpay refund client configuration.
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

  const signature = `${razorpayKeyId}|${razorpayKeySecret}`;
  if (!cachedRazorpayClient || cachedRazorpaySignature !== signature) {
    try {
      cachedRazorpayClient = new Razorpay({
        key_id: razorpayKeyId,
        key_secret: razorpayKeySecret
      });
      cachedRazorpaySignature = signature;
    } catch (error) {
      cachedRazorpayClient = null;
      cachedRazorpaySignature = null;
      if (strict) {
        throw new ServiceUnavailableError(
          `Refund gateway unavailable: failed to initialize Razorpay client in ${envLabel}`
        );
      }
      logger.warn('Failed to initialize Razorpay refund client, running in mock mode');
      return { isMockMode: true, razorpayKeyId: '', razorpayClient: null };
    }
  }

  return {
    isMockMode: false,
    razorpayKeyId,
    razorpayClient: cachedRazorpayClient
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

  if (strict && (isMockMode || !razorpayClient)) {
    throw new ServiceUnavailableError(
      `Refund gateway unavailable: mock refund execution is disabled in ${envLabel}`
    );
  }

  const isMockPayment =
    !strict && (isMockOrTestPaymentId || isMockMode);

  // 2. Simulated / Local Mock Gateway Execution (strictly non-Production, non-Preview only)
  if (!strict && (isMockPayment || !razorpayClient)) {
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

  // 3. Live Razorpay Gateway Invocation via Official SDK
  try {
    const refundPayload: any = {
      amount: requestedPaise
    };
    if (params.receipt) {
      refundPayload.receipt = params.receipt;
    }
    if (params.notes && Object.keys(params.notes).length > 0) {
      refundPayload.notes = params.notes;
    }
    if (params.speed) {
      refundPayload.speed = params.speed;
    }

    logger.info(
      `Invoking Razorpay payments.refund for payment ${paymentId} (amount: ${requestedPaise} paise, receipt: ${params.receipt || 'none'})`
    );

    const rpResponse = await razorpayClient.payments.refund(paymentId, refundPayload);

    if (!rpResponse || !rpResponse.id) {
      logger.error(`Razorpay payments.refund returned invalid response: ${JSON.stringify(rpResponse)}`);
      return {
        success: false,
        isMock: false,
        isTimeout: false,
        paymentId,
        amountPaise: requestedPaise,
        currency: 'INR',
        status: 'FAILED',
        errorCode: 'GATEWAY_INVALID_RESPONSE',
        errorDescription: 'Razorpay returned empty or malformed refund response'
      };
    }

    const rawStatus = String(rpResponse.status || '').toLowerCase();
    let status: 'PROCESSED' | 'PENDING' | 'FAILED' = 'PROCESSED';
    let processedAt: string | undefined = undefined;

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
      rpResponse.amount !== undefined && rpResponse.amount !== null
        ? Number(rpResponse.amount)
        : NaN;
    const gatewayCurrency = String(rpResponse.currency || '').trim().toUpperCase();

    const isAmountValidInteger =
      Number.isInteger(gatewayAmount) &&
      Number.isSafeInteger(gatewayAmount) &&
      gatewayAmount > 0;
    const isAmountExactMatch = isAmountValidInteger && gatewayAmount === requestedPaise;
    const isCurrencyValid = gatewayCurrency === 'INR';

    let amountMismatch = false;
    let currencyMismatch = false;
    let errorCode: string | undefined = undefined;
    let errorDescription: string | undefined = undefined;

    if (!isAmountValidInteger || !isAmountExactMatch) {
      amountMismatch = true;
      errorCode = 'GATEWAY_AMOUNT_MISMATCH';
      errorDescription = `Gateway reported refund amount ${gatewayAmount} does not match requested safe integer ${requestedPaise} paise`;
    } else if (!isCurrencyValid) {
      currencyMismatch = true;
      errorCode = 'GATEWAY_CURRENCY_MISMATCH';
      errorDescription = `Gateway reported non-INR currency "${gatewayCurrency}" (expected INR)`;
    }

    return {
      success: status !== 'FAILED' && !amountMismatch && !currencyMismatch,
      isMock: false,
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
      rawResponse: rpResponse
    };
  } catch (error: any) {
    const errorMsg = String(error?.message || error?.error?.description || error || '');
    const errorCode = String(error?.code || error?.error?.code || 'GATEWAY_ERROR');

    // Detect network timeouts / interruption
    const isTimeout =
      errorCode === 'ETIMEDOUT' ||
      errorCode === 'ESOCKETTIMEDOUT' ||
      errorCode === 'ECONNRESET' ||
      errorCode === 'ECONNABORTED' ||
      errorMsg.toLowerCase().includes('timeout') ||
      errorMsg.toLowerCase().includes('socket hang up');

    if (isTimeout) {
      logger.warn(
        `Razorpay refund API call timed out for payment ${paymentId} on order ${orderId}: ${errorMsg}`
      );
      return {
        success: false,
        isMock: false,
        isTimeout: true,
        paymentId,
        amountPaise: requestedPaise,
        currency: 'INR',
        status: 'PENDING',
        errorCode: 'GATEWAY_TIMEOUT',
        errorDescription: `Gateway request timed out: ${errorMsg}`
      };
    }

    logger.error(
      `Razorpay refund API rejected request for payment ${paymentId} on order ${orderId} [${errorCode}]: ${errorMsg}`
    );

    return {
      success: false,
      isMock: false,
      isTimeout: false,
      paymentId,
      amountPaise: requestedPaise,
      currency: 'INR',
      status: 'FAILED',
      errorCode,
      errorDescription: errorMsg || 'Payment gateway rejected refund request'
    };
  }
}

