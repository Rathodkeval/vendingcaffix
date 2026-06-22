import { Router } from 'express';
import { getOrders, getOrderById, createOrder, updateOrderStatus } from '../controllers/orderController';
import { authenticateJWT, requireRole } from '../middleware/auth';
import { validateRequest } from '../middleware/validate';
import { z } from 'zod';

const router = Router();

const createOrderSchema = z.object({
  body: z.object({
    product_id: z.number().int().positive('Product ID must be a positive integer'),
    amount: z.number().int().positive('Amount must be a positive integer').optional(),
    machine_id: z.string().min(3, 'Machine ID is required')
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

router.post('/create', authenticateJWT, validateRequest(createOrderSchema), createOrder);
router.get('/', authenticateJWT, requireRole(['admin']), getOrders);
router.get('/:id', authenticateJWT, getOrderById);
router.put('/:id/status', authenticateJWT, validateRequest(updateStatusSchema), updateOrderStatus);

export default router;
