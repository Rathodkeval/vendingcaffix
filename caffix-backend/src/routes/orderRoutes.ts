import { Router } from 'express';
import { getOrders, getOrderById, createOrder, updateOrderStatus, cancelOrder } from '../controllers/orderController';
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

router.post('/create', authenticateJWT, validateRequest(createOrderSchema), createOrder);
router.get('/', authenticateJWT, requireRole(['admin', 'owner', 'kiosk']), getOrders);
router.get('/:id', authenticateJWT, getOrderById);
router.post('/:id/cancel', authenticateJWT, validateRequest(cancelOrderSchema), cancelOrder);
router.put('/:id/status', authenticateJWT, validateRequest(updateStatusSchema), updateOrderStatus);

export default router;
