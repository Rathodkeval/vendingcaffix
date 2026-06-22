import { Router } from 'express';
import {
  getMachines,
  registerMachine,
  updateMachineStatus,
  getInventoryByMachine,
  refillMachineInventory
} from '../controllers/machineController';
import { authenticateJWT, requireRole } from '../middleware/auth';
import { validateRequest } from '../middleware/validate';
import { z } from 'zod';

const router = Router();

const registerMachineSchema = z.object({
  body: z.object({
    id: z.string().min(3, 'Machine ID is required (min 3 chars)'),
    machine_name: z.string().min(2, 'Machine name must be at least 2 chars'),
    location: z.string().min(2, 'Location is required')
  })
});

const updateStatusSchema = z.object({
  params: z.object({
    id: z.string()
  }),
  body: z.object({
    status: z.enum(['online', 'offline', 'maintenance'])
  })
});

const refillSchema = z.object({
  params: z.object({
    machine_id: z.string()
  }),
  body: z.object({
    ingredient: z.enum(['milk', 'coffee', 'vanilla', 'hazelnut', 'water', 'ALL'])
  })
});

router.get('/', authenticateJWT, requireRole(['admin']), getMachines);
router.post('/register', authenticateJWT, requireRole(['admin']), validateRequest(registerMachineSchema), registerMachine);
router.patch('/:id/status', authenticateJWT, validateRequest(updateStatusSchema), updateMachineStatus);
router.get('/:machine_id/inventory', authenticateJWT, getInventoryByMachine);
router.post('/:machine_id/refill', authenticateJWT, requireRole(['admin']), validateRequest(refillSchema), refillMachineInventory);

export default router;
