export interface VerifiedCapturedPayment {
  paymentId: string;
  orderId: string | null;
  amountPaise: number;
  currency: 'INR';
  status: 'captured';
}

export type GatewayPaymentValidationCode =
  | 'PENDING_CAPTURE'
  | 'INVALID_STATUS'
  | 'INVALID_CURRENCY'
  | 'AMOUNT_MISMATCH'
  | 'ORDER_MISMATCH'
  | 'INVALID_PAYMENT';

export type GatewayPaymentValidationResult =
  | { valid: true; data: VerifiedCapturedPayment }
  | { valid: false; code: GatewayPaymentValidationCode; reason: string };

/**
 * Validates an authoritative Razorpay payment entity returned by the gateway SDK
 * before an order can be promoted to PAID:
 * - payment status must be 'captured' (never 'authorized', 'created', or 'failed')
 * - currency must be 'INR'
 * - amount must be a positive safe integer in paise matching expected order amount
 * - optional razorpay_order_id must match payment.order_id when present
 */
export function validateCapturedRazorpayPayment(params: {
  payment: any;
  expectedAmountInr: number;
  expectedRazorpayOrderId?: string | null;
}): GatewayPaymentValidationResult {
  const { payment, expectedAmountInr, expectedRazorpayOrderId } = params;

  if (!payment || typeof payment !== 'object') {
    return {
      valid: false,
      code: 'INVALID_PAYMENT',
      reason: 'Razorpay payment lookup returned an empty or invalid payment payload'
    };
  }

  const rpPaymentId = String(payment.id || '').trim();
  const rpOrderId = payment.order_id ? String(payment.order_id).trim() : null;
  const expectedRpOrderId = expectedRazorpayOrderId ? String(expectedRazorpayOrderId).trim() : null;

  if (expectedRpOrderId && rpOrderId && rpOrderId !== expectedRpOrderId) {
    return {
      valid: false,
      code: 'ORDER_MISMATCH',
      reason: `Razorpay payment ${rpPaymentId || 'unknown'} belongs to order ${rpOrderId}, not ${expectedRpOrderId}`
    };
  }

  const normalizedStatus = String(payment.status || '').trim().toLowerCase();
  if (normalizedStatus === 'authorized' || normalizedStatus === 'created') {
    return {
      valid: false,
      code: 'PENDING_CAPTURE',
      reason: `Payment is currently ${normalizedStatus} at Razorpay and awaiting capture confirmation`
    };
  }

  if (normalizedStatus !== 'captured') {
    return {
      valid: false,
      code: 'INVALID_STATUS',
      reason: `Razorpay payment status must be 'captured', received '${normalizedStatus || 'unknown'}'`
    };
  }

  const normalizedCurrency = String(payment.currency || '').trim().toUpperCase();
  if (normalizedCurrency !== 'INR') {
    return {
      valid: false,
      code: 'INVALID_CURRENCY',
      reason: `Razorpay payment currency must be INR, received '${normalizedCurrency || 'missing'}'`
    };
  }

  const rawAmount = payment.amount;
  if (
    typeof rawAmount !== 'number' ||
    !Number.isInteger(rawAmount) ||
    !Number.isSafeInteger(rawAmount) ||
    rawAmount <= 0
  ) {
    return {
      valid: false,
      code: 'INVALID_PAYMENT',
      reason: `Razorpay payment amount must be a positive safe integer in paise, received '${rawAmount}'`
    };
  }

  const expectedAmountPaise = Math.round(Number(expectedAmountInr) * 100);
  if (!Number.isFinite(expectedAmountPaise) || expectedAmountPaise <= 0 || rawAmount !== expectedAmountPaise) {
    return {
      valid: false,
      code: 'AMOUNT_MISMATCH',
      reason: `Captured amount mismatch: expected ${expectedAmountPaise} paise, gateway returned ${rawAmount} paise`
    };
  }

  return {
    valid: true,
    data: {
      paymentId: rpPaymentId,
      orderId: rpOrderId,
      amountPaise: rawAmount,
      currency: 'INR',
      status: 'captured'
    }
  };
}

