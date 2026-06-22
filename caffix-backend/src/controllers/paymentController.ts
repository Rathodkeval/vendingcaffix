import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { getDB } from '../config/db';
import { executeOrderStatusUpdate } from './orderController';
import { BadRequestError, NotFoundError } from '../utils/errors';
import logger from '../utils/logger';

const getSecrets = () => ({
  razorpayKeySecret: (process.env.RAZORPAY_KEY_SECRET || 'mockSecret987654321').trim(),
  webhookSecret: (process.env.RAZORPAY_WEBHOOK_SECRET || 'mockWebhookSecret112233').trim()
});

export const verifyPaymentSignature = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  const { order_id, razorpay_payment_id, razorpay_order_id, razorpay_signature } = req.body;
  const db = getDB();
  const { razorpayKeySecret } = getSecrets();

  try {
    // 1. Check if the order exists locally
    const order = await db.get('SELECT * FROM orders WHERE id = ?', [order_id]);
    if (!order) {
      return next(new NotFoundError(`Local order ID ${order_id} not found`));
    }

    // 2. Perform verification
    const isMockOrder = razorpay_order_id.startsWith('order_mock_') || razorpayKeySecret.includes('mock');

    if (isMockOrder) {
      logger.info(`Verifying mock Razorpay signature for order ${order_id}`);
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

    // 3. Update order in SQLite to store Razorpay tokens
    await db.run(
      `UPDATE orders SET 
        razorpay_payment_id = ?, 
        razorpay_signature = ?
       WHERE id = ?`,
      [razorpay_payment_id, razorpay_signature, order_id]
    );

    // 4. Update status to PAID (which triggers db-level ingredient deductions)
    const updatedOrder = await executeOrderStatusUpdate(order_id, 'PAID');
    
    logger.info(`Successfully verified payment for order ${order_id}. Marked as PAID.`);

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
        // Find matching local order by razorpay_order_id
        const order = await db.get('SELECT * FROM orders WHERE razorpay_order_id = ?', [rpOrderId]);
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
