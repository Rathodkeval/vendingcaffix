import { Router } from 'express';
import { register, login, kioskAdminLogin } from '../controllers/authController';
import { authenticateJWT } from '../middleware/auth';
import { validateRequest } from '../middleware/validate';
import { z } from 'zod';

const router = Router();

const registerSchema = z.object({
  body: z.object({
    name: z.string().min(2, 'Name must be at least 2 characters'),
    email: z.string().email('Invalid email address'),
    password: z.string().min(6, 'Password must be at least 6 characters'),
    role: z.enum(['admin', 'kiosk'])
  })
});

const loginSchema = z.object({
  body: z.object({
    email: z.string().email('Invalid email address'),
    password: z.string().min(6, 'Password must be at least 6 characters'),
    machine_id: z.string().min(3).optional()
  })
});

const kioskAdminSchema = z.object({
  body: z.object({
    passcode: z.string().min(4, 'Passcode is required'),
    machine_id: z.string().min(3).optional()
  })
});

router.post('/register', validateRequest(registerSchema), register);
router.post('/login', validateRequest(loginSchema), login);
router.post('/kiosk-admin', authenticateJWT, validateRequest(kioskAdminSchema), kioskAdminLogin);

export default router;
