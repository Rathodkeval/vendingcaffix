import { Router } from 'express';
import { getProducts, createProduct, updateProductPrice } from '../controllers/productController';
import { authenticateJWT, requireRole } from '../middleware/auth';
import { validateRequest } from '../middleware/validate';
import { z } from 'zod';

const router = Router();

const createProductSchema = z.object({
  body: z.object({
    name: z.string().min(2, 'Product name must be at least 2 characters'),
    price: z.number().int().positive('Price must be a positive integer'),
    description: z.string().optional(),
    image: z.string().optional()
  })
});

const updatePriceSchema = z.object({
  params: z.object({
    id: z.string()
  }),
  body: z.object({
    price: z.number().int().positive('Price must be a positive integer')
  })
});

router.get('/', getProducts);
router.post('/', authenticateJWT, requireRole(['admin']), validateRequest(createProductSchema), createProduct);
router.put('/:id/price', authenticateJWT, requireRole(['admin']), validateRequest(updatePriceSchema), updateProductPrice);

export default router;
