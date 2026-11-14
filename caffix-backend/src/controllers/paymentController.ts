import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { getDB } from '../config/db';
import { AuthRequest, assertMachineOwnershipOrAdmin } from '../middleware/auth';
import { executeOrderStatusUpdate, resolveRazorpayOrderConfig, updateOrderPaymentCapture } from './orderController';
import { validateCapturedRazorpayPayment } from '../utils/razorpayPaymentValidation';
import { BadRequestError, ConflictError, ForbiddenError, NotFoundError, ServiceUnavailableError } from '../utils/errors';
import {
  reconcileAuthoritativeGatewayRefundOutcome,
  markRefundFailed,
  getRefundById,
  mapFirestoreRefundToRecord
} from '../utils/refunds';
import {
  getAuthoritativeOrderById,
  getAuthoritativeOrderByRazorpayOrderId,
  isFirestoreActive,
  getFirestoreInstance,
  isStrictFirebaseEnvironment
} from '../utils/firebase';
import {
  claimWebhookEvent,
  markWebhookEventProcessed,
  markWebhookEventFailed,
  markWebhookEventIgnored
} from '../utils/webhookLedger';
import {
  isMockSecretValue,
  constantTimeEqual,
  resolveValidatedRazorpayEnvironment
} from '../utils/security';
import logger from '../utils/logger';

function resolvePaymentSecrets(options: { requireWebhookSecret?: boolean } = {}) {
  const env = resolveValidatedRazorpayEnvironment(options);
  return {
    mode: env.mode,
    strict: env.strict,
    razorpayKeySecret: env.strict ? env.keySecret : env.keySecret || 'mockSecret987654321',
    webhookSecret: env.strict ? env.webhookSecret : env.webhookSecret || 'mockWebhookSecret112233'
  };
}

export const verifyPaymentSignature = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  const { order_id, razorpay_payment_id, razorpay_order_id, razorpay_signature } = req.body;
  const db = getDB();

  try {
    const { mode, strict, razorpayKeySecret } = resolvePaymentSecrets({ requireWebhookSecret: false });
    if (strict && (!razorpayKeySecret || isMockSecretValue(razorpayKeySecret))) {
      return next(
        new ServiceUnavailableError(
          `Payment verification unavailable: RAZORPAY_KEY_SECRET is missing or mock in ${mode === 'production' ? 'Production' : 'Preview'}`
        )
      );
    }

    if (!order_id || !razorpay_payment_id || !razorpay_order_id || !razorpay_signature) {
      return next(new BadRequestError('Missing required payment verification parameters'));
    }

    if (
      strict &&
      (String(razorpay_order_id).trim().startsWith('order_mock_') ||
        String(razorpay_payment_id).trim().startsWith('pay_mock_') ||
        String(razorpay_signature).trim().toLowerCase() === 'mock')
    ) {
      return next(
        new BadRequestError(
          `Mock payment orders are not permitted in ${mode === 'production' ? 'Production' : 'Preview'}`
        )
      );
    }

    // 1. Check if the order exists (hydrating from Firestore if needed after a serverless cold start)
    const order = await getAuthoritativeOrderById(String(order_id), db);
    if (!order) {
      return next(new NotFoundError(`Local order ID ${order_id} not found`));
    }

    // 2. Verify machine identity / ownership binding for kiosk, kiosk_admin, and owner sessions
    if (req.user?.role === 'kiosk') {
      if (!req.user.machine_id || req.user.machine_id !== order.machine_id) {
        return next(new ForbiddenError(`Kiosk ${req.user.machine_id || 'unknown'} cannot verify payment for order on machine ${order.machine_id}`));
      }
    }
    if (req.user?.role === 'owner' || (req.user?.role === 'admin' && req.user?.scope === 'kiosk_admin')) {
      await assertMachineOwnershipOrAdmin(req.user, order.machine_id);
    }

    // 3. Verify Razorpay order ID matches the order record
    if (order.razorpay_order_id && order.razorpay_order_id !== razorpay_order_id) {
      return next(new BadRequestError('Razorpay Order ID does not match the local order'));
    }

    // 4. Perform cryptographic signature verification (never bypassed in Production or Preview)
    const isMockOrder =
      !strict &&
      mode === 'local' &&
      (String(razorpay_order_id).startsWith('order_mock_') || isMockSecretValue(razorpayKeySecret));

    if (isMockOrder) {
      logger.info(`Verifying mock Razorpay signature for order ${order_id} (machine: ${order.machine_id})`);
    } else {
      const text = `${razorpay_order_id}|${razorpay_payment_id}`;
      const generated_signature = crypto
        .createHmac('sha256', razorpayKeySecret)
        .update(text)
        .digest('hex');

      if (!constantTimeEqual(generated_signature, String(razorpay_signature).trim())) {
        logger.warn(`Signature verification failed for order ${order_id}`);
        return next(new BadRequestError('Cryptographic payment signature mismatch'));
      }
    }

    // 5. Idempotency check: if already PAID, PREPARING, COMPLETED, or claimed/dispensed, return current order without re-processing
    const upperOrderStatus = String(order.status || '').toUpperCase();
    const upperDispenseStatus = String(order.dispense_status || '').toUpperCase();
    if (
      ['PAID', 'PREPARING', 'COMPLETED'].includes(upperOrderStatus) ||
      ['DISPENSING', 'DISPENSED'].includes(upperDispenseStatus) ||
      order.dispensed === true
    ) {
      logger.info(`Duplicate payment verification ignored for already-${order.status} order ${order_id}`);
      const existingOrder = await db.get(`
        SELECT o.*, p.name as product_name 
        FROM orders o
        JOIN products p ON o.product_id = p.id
        WHERE o.id = ?
      `, [order_id]);
      res.status(200).json({
        status: 'success',
        data: existingOrder || order
      });
      return;
    }

    // 5b. Gateway capture verification via Razorpay server SDK:
    // Never mark an order PAID based only on checkout HMAC when a real/configured Razorpay client is required.
    let verifiedCapturedAmountPaise: number | null = null;
    if (!isMockOrder) {
      const { isMockMode, razorpayClient } = resolveRazorpayOrderConfig();
      if (strict || !isMockMode) {
        if (!razorpayClient || !razorpayClient.payments || typeof razorpayClient.payments.fetch !== 'function') {
          return next(
            new ServiceUnavailableError(
              'Payment verification unavailable: Razorpay gateway client cannot fetch payment status'
            )
          );
        }

        let rpPayment: any;
        try {
          rpPayment = await razorpayClient.payments.fetch(String(razorpay_payment_id).trim());
        } catch (gwErr: any) {
          const gwStatusCode = Number(gwErr?.statusCode || gwErr?.error?.statusCode || 0);
          logger.warn(
            `Gateway payment fetch failed for order ${order_id} (payment ${razorpay_payment_id}, status=${gwStatusCode || 'network'}): ${gwErr?.message || gwErr?.error?.description || 'Unknown gateway error'}`
          );
          if (gwStatusCode === 400 || gwStatusCode === 404) {
            return next(new BadRequestError('Razorpay payment ID could not be found or verified'));
          }
          return next(
            new ServiceUnavailableError(
              'Unable to confirm captured payment status with Razorpay right now. Order remains pending for safe verification or reconciliation.'
            )
          );
        }

        const captureCheck = validateCapturedRazorpayPayment({
          payment: rpPayment,
          expectedAmountInr: Number(order.amount),
          expectedRazorpayOrderId: String(razorpay_order_id)
        });

        if (!captureCheck.valid) {
          logger.warn(
            `Rejected payment verification for order ${order_id} (payment ${razorpay_payment_id}): ${captureCheck.reason}`
          );
          if (captureCheck.code === 'PENDING_CAPTURE') {
            return next(new ServiceUnavailableError(captureCheck.reason));
          }
          return next(new BadRequestError(captureCheck.reason));
        }

        verifiedCapturedAmountPaise = captureCheck.data.amountPaise;
      }
    }

    // 6. Atomically store Razorpay tokens, captured_amount_paise, and transition unpaid -> PAID
    // (triggers single ingredient deduction & Firestore transaction)
    let updatedOrder = await executeOrderStatusUpdate(String(order_id), 'PAID', {
      razorpayPaymentId: String(razorpay_payment_id),
      razorpaySignature: String(razorpay_signature),
      capturedAmountPaise: verifiedCapturedAmountPaise,
      allowPaidOrderRecovery: true
    });

    if (
      verifiedCapturedAmountPaise !== null &&
      (updatedOrder?.captured_amount_paise === null || updatedOrder?.captured_amount_paise === undefined)
    ) {
      updatedOrder =
        (await updateOrderPaymentCapture(String(order_id), {
          capturedAmountPaise: verifiedCapturedAmountPaise,
          razorpayPaymentId: String(razorpay_payment_id),
          razorpaySignature: String(razorpay_signature)
        })) || updatedOrder;
    }
    
    logger.info(
      `Successfully verified payment for order ${order_id} (machine: ${order.machine_id}, captured: ${verifiedCapturedAmountPaise ?? 'mock'} paise). Marked as PAID.`
    );

    res.status(200).json({
      status: 'success',
      data: updatedOrder
    });
  } catch (error) {
    next(error);
  }
};

export interface WebhookRequest extends Request {
  rawBody?: Buffer;
}

const SUPPORTED_RAZORPAY_PAYMENT_SUCCESS_EVENTS = new Set(['order.paid', 'payment.captured']);
const SUPPORTED_RAZORPAY_REFUND_EVENTS = new Set(['refund.processed', 'refund.failed', 'refund.created']);
const SUPPORTED_RAZORPAY_WEBHOOK_EVENTS = new Set([
  'order.paid',
  'payment.captured',
  'payment.failed',
  'refund.processed',
  'refund.failed',
  'refund.created'
]);

export const handleRazorpayWebhook = async (
  req: WebhookRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  const signature = typeof req.headers['x-razorpay-signature'] === 'string' ? req.headers['x-razorpay-signature'].trim() : '';
  const rawBody = req.rawBody;
  const db = getDB();
  let claimResult: any = null;

  try {
    const { mode, strict, webhookSecret } = resolvePaymentSecrets({ requireWebhookSecret: true });
    if (strict && (!webhookSecret || isMockSecretValue(webhookSecret))) {
      return next(
        new ServiceUnavailableError(
          `Webhook service unavailable: RAZORPAY_WEBHOOK_SECRET is missing or mock in ${mode === 'production' ? 'Production' : 'Preview'}`
        )
      );
    }

    const allowLocalMockWebhook =
      mode === 'local' &&
      !strict &&
      isMockSecretValue(webhookSecret) &&
      (!signature || signature.toLowerCase() === 'mock');

    if (!allowLocalMockWebhook) {
      if (!signature || signature.toLowerCase() === 'mock') {
        logger.warn('Rejected Razorpay webhook with missing or mock signature');
        res.status(400).json({ status: 'error', message: 'Missing or invalid webhook signature' });
        return;
      }

      if (!Buffer.isBuffer(rawBody) || rawBody.length === 0) {
        logger.warn('Rejected Razorpay webhook without raw request bytes for signature verification');
        res.status(400).json({ status: 'error', message: 'Missing raw webhook body for signature verification' });
        return;
      }

      const expectedSignature = crypto
        .createHmac('sha256', webhookSecret)
        .update(rawBody)
        .digest('hex');

      if (!constantTimeEqual(expectedSignature, signature)) {
        logger.warn('Razorpay webhook signature verification failed');
        res.status(400).json({ status: 'error', message: 'Webhook signature verification failed' });
        return;
      }
    }

    // Process supported events only ('order.paid', 'payment.captured', 'payment.failed')
    const event = typeof req.body?.event === 'string' ? req.body.event.trim() : '';
    logger.info(`Processing Razorpay webhook event: ${event || 'unknown'}`);

    // D-1 / Findings 2, 4, 5: Distributed Atomically Claimed Webhook Ledger
    const rawEventId =
      (typeof req.body?.id === 'string' && req.body.id.trim()) ||
      (typeof req.headers['x-razorpay-event-id'] === 'string' && req.headers['x-razorpay-event-id'].trim()) ||
      '';
    const payload = req.body?.payload && typeof req.body.payload === 'object' ? req.body.payload : null;
    const paymentEntity = payload?.payment?.entity && typeof payload.payment.entity === 'object'
      ? payload.payment.entity
      : null;
    const orderEntity = payload?.order?.entity && typeof payload.order.entity === 'object'
      ? payload.order.entity
      : null;
    const refundEntity = payload?.refund?.entity && typeof payload.refund.entity === 'object'
      ? payload.refund.entity
      : null;

    const rpPaymentId = paymentEntity?.id || refundEntity?.payment_id || null;
    const rpRefundId = refundEntity?.id || null;
    const rpOrderId = paymentEntity?.order_id || orderEntity?.id || null;

    // Build unique event identifier
    const eventId = rawEventId || (rpPaymentId && event ? `${event}_${rpPaymentId}_${req.body?.created_at || Date.now()}` : '');

    if (eventId) {
      claimResult = await claimWebhookEvent(db, {
        provider: 'razorpay',
        eventId,
        eventType: event || 'unknown',
        orderId: rpOrderId ? String(rpOrderId) : null,
        paymentId: rpPaymentId ? String(rpPaymentId) : null,
        refundId: rpRefundId ? String(rpRefundId) : null,
        payload: req.body
      });

      if (!claimResult.shouldProcess) {
        if (claimResult.isDuplicate) {
          logger.info(`[Webhook Ledger] Deduplicated duplicate webhook event: ${eventId} (${claimResult.status})`);
          res.status(200).json({ status: 'ok', deduplicated: true, event_id: eventId });
          return;
        }

        if (claimResult.isConcurrentInFlight) {
          logger.warn(`[Webhook Ledger] Concurrent webhook execution rejected for in-flight event: ${eventId}`);
          res.status(409).json({
            status: 'conflict',
            message: 'Webhook event is currently being processed by another instance',
            event_id: eventId
          });
          return;
        }
      }
    }

    if (SUPPORTED_RAZORPAY_WEBHOOK_EVENTS.has(event)) {
      const rpSignature = signature || 'webhook_signature';

      // Validate currency and amount: strictly INR and positive safe integer
      const rawCurrency = String(paymentEntity?.currency || orderEntity?.currency || '').trim().toUpperCase();
      const rawAmount = paymentEntity?.amount ?? orderEntity?.amount;
      const isINR = rawCurrency === 'INR';
      const isValidPaise =
        typeof rawAmount === 'number' &&
        Number.isInteger(rawAmount) &&
        Number.isSafeInteger(rawAmount) &&
        rawAmount > 0;

      let rpCapturedAmountPaise: number | null = null;
      if (paymentEntity || orderEntity) {
        if (!isINR && rawCurrency) {
          logger.warn(
            `Rejected webhook payment amount with non-INR currency "${rawCurrency}" for Razorpay order ID ${rpOrderId}`
          );
        } else if (isValidPaise && isINR) {
          rpCapturedAmountPaise = rawAmount;
        } else if (rawAmount !== undefined && rawAmount !== null) {
          logger.warn(
            `Rejected webhook payment amount with invalid non-positive/unsafe integer "${rawAmount}" for Razorpay order ID ${rpOrderId}`
          );
        }
      }

      if (rpOrderId) {
        // Find matching order by razorpay_order_id (hydrating from Firestore if needed after a serverless cold start)
        const order = await getAuthoritativeOrderByRazorpayOrderId(String(rpOrderId), db);
        if (order && String(order.razorpay_order_id || '').trim() === String(rpOrderId).trim()) {
          const currentStatus = String(order.status || '').toUpperCase();
          const currentDispense = String(order.dispense_status || '').toUpperCase();
          const isPaidOrDispensed =
            ['PAID', 'PREPARING', 'COMPLETED'].includes(currentStatus) ||
            ['QUEUED', 'DISPENSING', 'DISPENSED'].includes(currentDispense) ||
            order.dispensed === true;

          if (SUPPORTED_RAZORPAY_PAYMENT_SUCCESS_EVENTS.has(event)) {
            if (!isPaidOrDispensed) {
              const updatedOrder = await executeOrderStatusUpdate(order.id, 'PAID', {
                razorpayPaymentId: rpPaymentId ? String(rpPaymentId) : null,
                razorpaySignature: rpSignature,
                capturedAmountPaise: rpCapturedAmountPaise,
                allowPaidOrderRecovery: true,
                allowPaidOrderNoop: true,
                webhookFencing: eventId && claimResult?.claimCount ? { provider: 'razorpay', eventId, claimCount: claimResult.claimCount } : null
              });
              logger.info(`Webhook processed order ${order.id} (status: ${updatedOrder?.status || 'PAID'}, captured: ${rpCapturedAmountPaise || 'unrecorded'} paise)`);
            } else {
              // The order is already in a successful state (e.g. marked PAID by /api/payments/verify).
              // Persist the exact captured payment amount without modifying dispense status or state machine!
              if (rpCapturedAmountPaise !== null) {
                const capRes = await updateOrderPaymentCapture(order.id, {
                  capturedAmountPaise: rpCapturedAmountPaise,
                  razorpayPaymentId: rpPaymentId ? String(rpPaymentId) : null,
                  razorpaySignature: rpSignature
                });
                if (capRes?.captured_amount_paise === rpCapturedAmountPaise) {
                  logger.info(
                    `Webhook recorded exact captured payment amount for already-${order.status} order ${order.id}: ${rpCapturedAmountPaise} paise`
                  );
                }
              } else {
                logger.info(`Order ${order.id} status is already ${order.status}. Webhook bypass without valid INR captured amount.`);
              }
            }
          } else if (event === 'payment.failed') {
            if (currentStatus === 'PENDING' && !isPaidOrDispensed) {
              const updatedOrder = await executeOrderStatusUpdate(order.id, 'FAILED', {
                allowPaidOrderNoop: true
              });
              logger.info(`Webhook marked failed order ${order.id} (status: ${updatedOrder?.status || 'FAILED'})`);
            } else {
              logger.info(
                `Payment failed webhook ignored for non-eligible order ${order.id} (status: ${order.status}, dispense_status: ${order.dispense_status || 'none'})`
              );
            }
          }
        } else {
          logger.warn(`No local order found for Razorpay order ID ${rpOrderId}`);
        }
      }

      // Handle refund webhook events ('refund.processed', 'refund.failed', 'refund.created')
      if (SUPPORTED_RAZORPAY_REFUND_EVENTS.has(event)) {
        const refundEntity = payload?.refund?.entity && typeof payload.refund.entity === 'object'
          ? payload.refund.entity
          : null;

        if (refundEntity) {
          const rpRefundId = String(refundEntity.id || '').trim();
          const rpPaymentId = String(refundEntity.payment_id || '').trim();
          const receiptRefundId = refundEntity.receipt ? String(refundEntity.receipt).trim() : null;
          const rawRefundAmount = refundEntity.amount;
          const refundAmountPaise = Number(rawRefundAmount);
          const refundCurrency = String(refundEntity.currency || '').trim().toUpperCase();

          if (event === 'refund.processed') {
            // Strictly validate currency as INR (Finding 1)
            if (refundCurrency !== 'INR') {
              throw new BadRequestError(
                `Rejected webhook refund with non-INR currency "${refundCurrency}" (expected INR)`
              );
            }

            // Strictly validate amount as positive safe integer in paise (Finding 1)
            if (
              typeof rawRefundAmount !== 'number' ||
              !Number.isInteger(refundAmountPaise) ||
              !Number.isSafeInteger(refundAmountPaise) ||
              refundAmountPaise <= 0
            ) {
              throw new BadRequestError(
                `Rejected webhook refund with invalid amount: expected positive safe integer in paise, received ${rawRefundAmount}`
              );
            }

            let targetOrder = null;
            let targetRefund: any = null;

            // F-2: Resolve refund using Firestore-aware getRefundById path
            if (receiptRefundId) {
              targetRefund = await getRefundById(db, receiptRefundId);
              if (targetRefund?.order_id) {
                targetOrder = await getAuthoritativeOrderById(targetRefund.order_id, db);
              }
            }

            // F-2: Fall back to payment ID if order not resolved by receipt
            if (!targetOrder && rpPaymentId) {
              if (db && db.get) {
                const orderRow = await db.get('SELECT id FROM orders WHERE razorpay_payment_id = ?', [rpPaymentId]);
                if (orderRow?.id) {
                  targetOrder = await getAuthoritativeOrderById(orderRow.id, db);
                }
              }

              // Authoritative Firestore lookup when local lookup misses (e.g. serverless cold start)
              if (!targetOrder && isFirestoreActive()) {
                const firestore = getFirestoreInstance()!;
                const snap = await firestore
                  .collection('orders')
                  .where('razorpay_payment_id', '==', rpPaymentId)
                  .limit(1)
                  .get();
                if (!snap.empty) {
                  targetOrder = await getAuthoritativeOrderById(snap.docs[0].id, db);
                }
              }
            }

            // F-2: Strict fail-closed rule in Production / Preview if Firestore is required
            const isVercel = Boolean(process.env.VERCEL && process.env.VERCEL !== 'undefined' && process.env.VERCEL !== 'false');
            if (!targetOrder && (isStrictFirebaseEnvironment() || isVercel)) {
              if (!isFirestoreActive()) {
                throw new ServiceUnavailableError(
                  'Authoritative order lookup unavailable: Shared Firestore persistence required in Production/Preview. Failing closed (HTTP 503).'
                );
              }
            }

            if (!targetOrder) {
              throw new NotFoundError(
                `No matching order found for refund webhook ${rpRefundId} (payment: ${rpPaymentId}, receipt: ${receiptRefundId})`
              );
            }

            // Relationship integrity validation
            if (targetRefund && targetRefund.order_id !== targetOrder.id) {
              throw new ConflictError(
                `Mismatched refund-to-order relationship: refund ${targetRefund.id} belongs to order ${targetRefund.order_id}, not ${targetOrder.id}`
              );
            }
            if (rpPaymentId && targetOrder.razorpay_payment_id) {
              if (String(targetOrder.razorpay_payment_id).trim() !== String(rpPaymentId).trim()) {
                throw new ConflictError(
                  `Mismatched payment relationship: order ${targetOrder.id} has payment ${targetOrder.razorpay_payment_id}, received webhook payment ${rpPaymentId}`
                );
              }
            }

            const processedAt = refundEntity.created_at
              ? new Date(Number(refundEntity.created_at) * 1000).toISOString()
              : new Date().toISOString();

            // F-1 & F-3: Pass targetOrder.machine_id and webhookFencing to authoritative reconciliation
            await reconcileAuthoritativeGatewayRefundOutcome(db, {
              orderId: targetOrder.id,
              razorpayRefundId: rpRefundId,
              razorpayPaymentId: rpPaymentId,
              amount_paise: refundAmountPaise,
              currency: refundCurrency,
              refundId: receiptRefundId,
              processed_at: processedAt,
              notes: 'Settled via verified Razorpay refund.processed webhook',
              machineId: targetOrder.machine_id || null,
              webhookFencing: eventId && claimResult?.claimCount ? { provider: 'razorpay', eventId, claimCount: claimResult.claimCount } : null
            });
            logger.info(`Webhook authoritatively settled refund ${rpRefundId} for order ${targetOrder.id}`);
          } else if (event === 'refund.failed') {
            // Robust Handling of refund.failed (Finding 3)
            const gatewayErrorCode = String(refundEntity.error_code || 'GATEWAY_REFUND_FAILED').trim();
            const gatewayErrorDesc = String(
              refundEntity.error_description || refundEntity.error_reason || 'Razorpay refund.failed event received'
            ).trim();

            let targetRefund: any = null;
            if (receiptRefundId) {
              targetRefund = await getRefundById(db, receiptRefundId);
            }
            if (!targetRefund && rpRefundId) {
              if (db && db.get) {
                const row = await db.get('SELECT * FROM refunds WHERE razorpay_refund_id = ?', [rpRefundId]);
                if (row) {
                  targetRefund = mapFirestoreRefundToRecord(row, row.id);
                }
              }
              if (!targetRefund && isFirestoreActive()) {
                const firestore = getFirestoreInstance()!;
                const snap = await firestore
                  .collection('refunds')
                  .where('razorpay_refund_id', '==', rpRefundId)
                  .limit(1)
                  .get();
                if (!snap.empty) {
                  targetRefund = mapFirestoreRefundToRecord(snap.docs[0].data(), snap.docs[0].id);
                }
              }
            }
            if (!targetRefund && rpPaymentId) {
              if (db && db.all) {
                const rows = await db.all(
                  'SELECT * FROM refunds WHERE razorpay_payment_id = ? AND status = ?',
                  [rpPaymentId, 'PENDING']
                );
                if (rows.length === 1) {
                  targetRefund = mapFirestoreRefundToRecord(rows[0], rows[0].id);
                }
              }
            }

            if (!targetRefund) {
              logger.warn(
                `Cannot match refund.failed event (rpRefundId: ${rpRefundId}, payment: ${rpPaymentId}, receipt: ${receiptRefundId}) to any existing refund record. No reservation released.`
              );
            } else {
              // Terminal state check: PROCESSED cannot be downgraded to FAILED
              if (targetRefund.status === 'PROCESSED') {
                logger.warn(
                  `Received refund.failed for already PROCESSED refund ${targetRefund.id} on order ${targetRefund.order_id}. Preserving settled state.`
                );
              } else if (targetRefund.status === 'FAILED') {
                logger.info(`Idempotent replay: refund ${targetRefund.id} is already in FAILED state.`);
              } else if (targetRefund.status === 'PENDING') {
                // Safely release pending reservation hold with F-1 fencing protection
                await markRefundFailed(db, {
                  refundId: targetRefund.id,
                  error_code: gatewayErrorCode,
                  error_description: `[WEBHOOK_GATEWAY_FAILURE] ${gatewayErrorDesc}`,
                  webhookFencing: eventId && claimResult?.claimCount ? { provider: 'razorpay', eventId, claimCount: claimResult.claimCount } : null
                });
                logger.info(
                  `Webhook successfully released pending reservation hold for failed refund ${targetRefund.id} on order ${targetRefund.order_id}`
                );
              }
            }
          }
        }
      }
    } else if (eventId) {
      await markWebhookEventIgnored(db, 'razorpay', eventId, `Unsupported event: ${event}`);
    }

    if (eventId) {
      await markWebhookEventProcessed(db, 'razorpay', eventId, {
        orderId: rpOrderId ? String(rpOrderId) : null,
        paymentId: rpPaymentId ? String(rpPaymentId) : null,
        refundId: rpRefundId ? String(rpRefundId) : null,
        claimCount: claimResult?.claimCount
      });
    }

    res.status(200).json({ status: 'ok', event_id: eventId });
  } catch (error) {
    const rawEventId =
      (typeof req.body?.id === 'string' && req.body.id.trim()) ||
      (typeof req.headers['x-razorpay-event-id'] === 'string' && req.headers['x-razorpay-event-id'].trim()) ||
      '';
    const errEventId = rawEventId || (req.body?.payload?.payment?.entity?.id && req.body?.event ? `${req.body.event}_${req.body.payload.payment.entity.id}` : '');
    if (errEventId) {
      await markWebhookEventFailed(
        db,
        'razorpay',
        errEventId,
        String((error as any)?.message || error),
        claimResult?.claimCount
      );
    }
    next(error);
  }
};
