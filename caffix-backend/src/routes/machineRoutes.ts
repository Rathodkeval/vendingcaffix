import { Router } from 'express';
import {
  getMachines,
  getMachineById,
  assignMachineOwner,
  registerMachine,
  updateMachineStatus,
  recordMachineHeartbeat,
  getInventoryByMachine,
  refillMachineInventory,
  getMachineProducts,
  updateMachineProduct
} from '../controllers/machineController';
import { authenticateJWT, requireRole } from '../middleware/auth';
import { validateRequest } from '../middleware/validate';
import { z } from 'zod';

const router = Router();

const registerMachineSchema = z.object({
  body: z.object({
    id: z.string().min(3, 'Machine ID is required (min 3 chars)'),
    machine_name: z.string().min(2, 'Machine name must be at least 2 chars'),
    location: z.string().min(2, 'Location is required'),
    kiosk_token: z.string().min(8, 'Kiosk token must be at least 8 chars').optional()
  })
});

const assignOwnerSchema = z.object({
  params: z.object({
    id: z.string().min(3)
  }),
  body: z.object({
    owner_id: z.union([z.string().min(1), z.null()])
  })
});

const updateStatusSchema = z.object({
  params: z.object({
    id: z.string()
  }),
  body: z
    .object({
      desired_mode: z.enum(['RUNNING', 'MAINTENANCE']).optional(),
      status: z.enum(['online', 'maintenance', 'RUNNING', 'MAINTENANCE']).optional()
    })
    .refine((data) => Boolean(data.desired_mode || data.status), {
      message: "Either 'desired_mode' ('RUNNING' | 'MAINTENANCE') or 'status' ('online' | 'maintenance') is required"
    })
});

const heartbeatSchema = z.object({
  params: z.object({
    id: z.string()
  })
});

const refillSchema = z.object({
  params: z.object({
    machine_id: z.string()
  }),
  body: z.object({
    ingredient: z.enum(['milk', 'coffee', 'vanilla', 'hazelnut', 'irish', 'mocha', 'water', 'ALL'])
  })
});

const getMachineProductsSchema = z.object({
  params: z.object({
    id: z.string().min(3)
  })
});

const updateMachineProductSchema = z.object({
  params: z.object({
    id: z.string().min(3),
    productId: z.string().min(1)
  }),
  body: z
    .object({
      price: z.number().int().positive('Price must be a positive integer').optional(),
      is_available: z.boolean().optional()
    })
    .refine((data) => data.price !== undefined || data.is_available !== undefined, {
      message: "At least one of 'price' or 'is_available' must be provided"
    })
});

router.get('/', authenticateJWT, requireRole(['admin', 'owner']), getMachines);
router.post('/register', authenticateJWT, requireRole(['admin']), validateRequest(registerMachineSchema), registerMachine);
router.get('/:id', authenticateJWT, requireRole(['admin', 'owner']), getMachineById);
router.get('/:id/products', authenticateJWT, requireRole(['admin', 'owner']), validateRequest(getMachineProductsSchema), getMachineProducts);
router.put('/:id/products/:productId', authenticateJWT, requireRole(['admin', 'owner']), validateRequest(updateMachineProductSchema), updateMachineProduct);
router.patch('/:id/products/:productId', authenticateJWT, requireRole(['admin', 'owner']), validateRequest(updateMachineProductSchema), updateMachineProduct);
router.patch('/:id/owner', authenticateJWT, requireRole(['admin']), validateRequest(assignOwnerSchema), assignMachineOwner);
router.patch('/:id/status', authenticateJWT, requireRole(['admin', 'owner']), validateRequest(updateStatusSchema), updateMachineStatus);
router.post('/:id/heartbeat', authenticateJWT, requireRole(['admin', 'owner', 'kiosk']), validateRequest(heartbeatSchema), recordMachineHeartbeat);
router.get('/:machine_id/inventory', authenticateJWT, requireRole(['admin', 'owner', 'kiosk']), getInventoryByMachine);
router.post('/:machine_id/refill', authenticateJWT, requireRole(['admin', 'owner']), validateRequest(refillSchema), refillMachineInventory);

export default router;
