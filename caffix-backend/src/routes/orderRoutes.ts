import { Router } from 'express';
import { getOrders, getOrderById, createOrder, updateOrderStatus, cancelOrder, refundOrder, reportOrderDispenseOutcome } from '../controllers/orderController';
import { authenticateJWT, requireRole } from '../middleware/auth';
import { validateRequest } from '../middleware/validate';
import { z } from 'zod';

const router = Router();

const createOrderSchema = z.object({
  body: z.object({
    product_id: z.number().int().positive('Product ID must be a positive integer'),
    amount: z.number().optional(),
    machine_id: z.string().min(3, 'Machine ID is required'),
    extra_sugar: z.union([z.boolean(), z.number()]).optional(),
    base: z.string().optional()
  })
});

const updateStatusSchema = z.object({
  params: z.object({
    id: z.string()
  }),
  body: z.object({
    status: z.enum(['PENDING', 'PAID', 'PREPARING', 'COMPLETED', 'FAILED', 'CANCELLED'])
  })
});

const cancelOrderSchema = z.object({
  params: z.object({
    id: z.string().min(1)
  }),
  body: z
    .object({
      razorpay_order_id: z.string().optional(),
      reason: z
        .enum(['checkout_dismissed', 'customer_cancelled', 'timeout', 'payment_failed'])
        .optional()
    })
    .optional()
});

const refundOrderSchema = z.object({
  params: z.object({
    id: z.string().min(1, 'Order ID is required')
  }),
  body: z
    .object({
      amount_paise: z.number().int().positive('amount_paise must be a positive integer').optional(),
      amount_inr: z.number().positive('amount_inr must be positive').optional(),
      reason: z.string().min(3, 'Reason must be at least 3 characters').optional(),
      notes: z.string().optional().nullable(),
      idempotency_key: z.string().optional()
    })
    .optional()
    .default({})
});

const dispenseResultSchema = z.object({
  params: z.object({
    id: z.string().min(1, 'Order ID is required')
  }),
  body: z.object({
    dispense_status: z.enum(['DISPENSING', 'DISPENSED', 'FAILED', 'EXPIRED']),
    failure_stage: z.enum(['PRE_DISPENSE', 'DURING_DISPENSE']).optional(),
    failure_reason: z.string().trim().max(500).optional().nullable(),
    machine_id: z.string().optional()
  })
});

router.post('/create', authenticateJWT, validateRequest(createOrderSchema), createOrder);
router.get('/', authenticateJWT, requireRole(['admin', 'owner', 'kiosk']), getOrders);
router.get('/:id', authenticateJWT, getOrderById);
router.post('/:id/cancel', authenticateJWT, validateRequest(cancelOrderSchema), cancelOrder);
router.post('/:id/refund', authenticateJWT, requireRole(['admin']), validateRequest(refundOrderSchema), refundOrder);
router.post('/:id/dispense-result', authenticateJWT, requireRole(['admin', 'kiosk']), validateRequest(dispenseResultSchema), reportOrderDispenseOutcome);
router.put('/:id/status', authenticateJWT, validateRequest(updateStatusSchema), updateOrderStatus);

export default router;
