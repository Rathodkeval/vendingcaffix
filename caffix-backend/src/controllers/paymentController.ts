import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { getDB } from '../config/db';
import { AuthRequest, assertMachineOwnershipOrAdmin } from '../middleware/auth';
import { executeOrderStatusUpdate } from './orderController';
import { BadRequestError, ForbiddenError, NotFoundError, ServiceUnavailableError } from '../utils/errors';
import {
  getAuthoritativeOrderById,
  getAuthoritativeOrderByRazorpayOrderId
} from '../utils/firebase';
import {
  isVercelProduction,
  isMockSecretValue,
  constantTimeEqual,
  assertRazorpayEnvironmentIsolation
} from '../utils/security';
import logger from '../utils/logger';

function resolvePaymentSecrets() {
  assertRazorpayEnvironmentIsolation();
  const production = isVercelProduction();
  const rawKeySecret = (process.env.RAZORPAY_KEY_SECRET || '').trim();
  const rawWebhookSecret = (process.env.RAZORPAY_WEBHOOK_SECRET || '').trim();

  return {
    production,
    razorpayKeySecret: production ? rawKeySecret : rawKeySecret || 'mockSecret987654321',
    webhookSecret: production ? rawWebhookSecret : rawWebhookSecret || 'mockWebhookSecret112233'
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
    const { production, razorpayKeySecret } = resolvePaymentSecrets();
    if (production && (!razorpayKeySecret || isMockSecretValue(razorpayKeySecret))) {
      return next(
        new ServiceUnavailableError(
          'Payment verification unavailable: RAZORPAY_KEY_SECRET is missing or mock in Production'
        )
      );
    }

    if (!order_id || !razorpay_payment_id || !razorpay_order_id || !razorpay_signature) {
      return next(new BadRequestError('Missing required payment verification parameters'));
    }

    if (production && String(razorpay_order_id).trim().startsWith('order_mock_')) {
      return next(new BadRequestError('Mock payment orders are not permitted in Production'));
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

    // 4. Perform cryptographic signature verification (never bypassed in Production)
    const isMockOrder =
      !production &&
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

    // 6. Atomically store Razorpay tokens and transition unpaid -> PAID (triggers single ingredient deduction & Firestore transaction)
    const updatedOrder = await executeOrderStatusUpdate(String(order_id), 'PAID', {
      razorpayPaymentId: String(razorpay_payment_id),
      razorpaySignature: String(razorpay_signature),
      allowPaidOrderRecovery: true
    });
    
    logger.info(`Successfully verified payment for order ${order_id} (machine: ${order.machine_id}). Marked as PAID.`);

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
const SUPPORTED_RAZORPAY_WEBHOOK_EVENTS = new Set(['order.paid', 'payment.captured', 'payment.failed']);

export const handleRazorpayWebhook = async (
  req: WebhookRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  const signature = typeof req.headers['x-razorpay-signature'] === 'string' ? req.headers['x-razorpay-signature'].trim() : '';
  const rawBody = req.rawBody;
  const db = getDB();

  try {
    const { production, webhookSecret } = resolvePaymentSecrets();
    if (production && (!webhookSecret || isMockSecretValue(webhookSecret))) {
      return next(
        new ServiceUnavailableError(
          'Webhook service unavailable: RAZORPAY_WEBHOOK_SECRET is missing or mock in Production'
        )
      );
    }

    const allowLocalMockWebhook =
      !production && isMockSecretValue(webhookSecret) && (!signature || signature.toLowerCase() === 'mock');

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

    if (SUPPORTED_RAZORPAY_WEBHOOK_EVENTS.has(event)) {
      const payload = req.body?.payload && typeof req.body.payload === 'object' ? req.body.payload : null;
      const paymentEntity = payload?.payment?.entity && typeof payload.payment.entity === 'object'
        ? payload.payment.entity
        : null;
      const orderEntity = payload?.order?.entity && typeof payload.order.entity === 'object'
        ? payload.order.entity
        : null;

      const rpOrderId = paymentEntity?.order_id || orderEntity?.id || null;
      const rpPaymentId = paymentEntity?.id || null;
      const rpSignature = signature || 'webhook_signature';

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
                allowPaidOrderRecovery: true,
                allowPaidOrderNoop: true
              });
              logger.info(`Webhook processed order ${order.id} (status: ${updatedOrder?.status || 'PAID'})`);
            } else {
              logger.info(`Order ${order.id} status is already ${order.status}. Webhook bypass.`);
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
    }

    res.status(200).json({ status: 'ok' });
  } catch (error) {
    next(error);
  }
};
