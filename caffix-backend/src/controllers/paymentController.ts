import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { getDB } from '../config/db';
import { AuthRequest } from '../middleware/auth';
import { executeOrderStatusUpdate } from './orderController';
import { BadRequestError, ForbiddenError, NotFoundError } from '../utils/errors';
import {
  getAuthoritativeOrderById,
  getAuthoritativeOrderByRazorpayOrderId
} from '../utils/firebase';
import logger from '../utils/logger';

const getSecrets = () => ({
  razorpayKeySecret: (process.env.RAZORPAY_KEY_SECRET || 'mockSecret987654321').trim(),
  webhookSecret: (process.env.RAZORPAY_WEBHOOK_SECRET || 'mockWebhookSecret112233').trim()
});

export const verifyPaymentSignature = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  const { order_id, razorpay_payment_id, razorpay_order_id, razorpay_signature } = req.body;
  const db = getDB();
  const { razorpayKeySecret } = getSecrets();

  try {
    if (!order_id || !razorpay_payment_id || !razorpay_order_id || !razorpay_signature) {
      return next(new BadRequestError('Missing required payment verification parameters'));
    }

    // 1. Check if the order exists (hydrating from Firestore if needed after a serverless cold start)
    const order = await getAuthoritativeOrderById(String(order_id), db);
    if (!order) {
      return next(new NotFoundError(`Local order ID ${order_id} not found`));
    }

    // 2. Verify machine identity binding for kiosk sessions
    if (req.user?.role === 'kiosk' && req.user.machine_id && req.user.machine_id !== order.machine_id) {
      return next(new ForbiddenError(`Kiosk ${req.user.machine_id} cannot verify payment for order on machine ${order.machine_id}`));
    }

    // 3. Verify Razorpay order ID matches the order record
    if (order.razorpay_order_id && order.razorpay_order_id !== razorpay_order_id) {
      return next(new BadRequestError('Razorpay Order ID does not match the local order'));
    }

    // 4. Perform cryptographic signature verification
    const isMockOrder = String(razorpay_order_id).startsWith('order_mock_') || razorpayKeySecret.includes('mock');

    if (isMockOrder) {
      logger.info(`Verifying mock Razorpay signature for order ${order_id} (machine: ${order.machine_id})`);
    } else {
      // Cryptographic signature check for production
      const text = razorpay_order_id + '|' + razorpay_payment_id;
      const generated_signature = crypto
        .createHmac('sha256', razorpayKeySecret)
        .update(text)
        .digest('hex');

      if (generated_signature !== razorpay_signature) {
        logger.warn(`Signature verification failed for order ${order_id}`);
        return next(new BadRequestError('Cryptographic payment signature mismatch'));
      }
    }

    // 5. Idempotency check: if already PAID, PREPARING, or COMPLETED, return current order without re-processing
    if (['PAID', 'PREPARING', 'COMPLETED'].includes(order.status)) {
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

    // 6. Update order in SQLite to store Razorpay tokens
    await db.run(
      `UPDATE orders SET 
        razorpay_payment_id = ?, 
        razorpay_signature = ?
       WHERE id = ?`,
      [razorpay_payment_id, razorpay_signature, order_id]
    );

    // 7. Update status to PAID (which triggers db-level ingredient deductions once)
    const updatedOrder = await executeOrderStatusUpdate(order_id, 'PAID');
    
    logger.info(`Successfully verified payment for order ${order_id} (machine: ${order.machine_id}). Marked as PAID.`);

    res.status(200).json({
      status: 'success',
      data: updatedOrder
    });
  } catch (error) {
    next(error);
  }
};

export const handleRazorpayWebhook = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  const signature = req.headers['x-razorpay-signature'] as string;
  const rawBody = JSON.stringify(req.body);
  const db = getDB();
  const { webhookSecret } = getSecrets();

  try {
    const isMockWebhook = !signature || signature === 'mock' || webhookSecret.includes('mock');

    if (!isMockWebhook) {
      // Validate webhook authenticity
      const expectedSignature = crypto
        .createHmac('sha256', webhookSecret)
        .update(rawBody)
        .digest('hex');

      if (expectedSignature !== signature) {
        logger.warn('Razorpay webhook signature verification failed');
        res.status(400).json({ status: 'error', message: 'Webhook signature verification failed' });
        return;
      }
    }

    // Process event
    const event = req.body.event;
    logger.info(`Processing Razorpay webhook event: ${event}`);

    if (event === 'order.paid' || event === 'payment.captured') {
      const payload = req.body.payload;
      const paymentEntity = payload.payment ? payload.payment.entity : null;
      
      const rpOrderId = paymentEntity ? paymentEntity.order_id : null;
      const rpPaymentId = paymentEntity ? paymentEntity.id : null;
      const rpSignature = signature || 'webhook_signature';

      if (rpOrderId) {
        // Find matching order by razorpay_order_id (hydrating from Firestore if needed after a serverless cold start)
        const order = await getAuthoritativeOrderByRazorpayOrderId(String(rpOrderId), db);
        if (order) {
          if (order.status === 'PENDING') {
            await db.run(
              `UPDATE orders SET 
                razorpay_payment_id = ?, 
                razorpay_signature = ?
               WHERE id = ?`,
              [rpPaymentId, rpSignature, order.id]
            );
            await executeOrderStatusUpdate(order.id, 'PAID');
            logger.info(`Webhook updated order ${order.id} status to PAID`);
          } else {
            logger.info(`Order ${order.id} status is already ${order.status}. Webhook bypass.`);
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
