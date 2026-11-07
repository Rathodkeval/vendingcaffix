import { Router } from 'express';
import {
  register,
  login,
  kioskAdminLogin,
  inviteOwner,
  setupPassword,
  changePassword,
  getMe,
  getOwners
} from '../controllers/authController';
import { authenticateJWT, requireRole } from '../middleware/auth';
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

const inviteOwnerSchema = z.object({
  body: z.object({
    name: z.string().min(2, 'Owner name must be at least 2 characters'),
    email: z.string().email('Invalid email address'),
    machine_ids: z.array(z.string().min(3)).optional(),
    expires_in_ms: z.number().optional()
  })
});

const setupPasswordSchema = z.object({
  body: z.object({
    token: z.string().min(16, 'Valid invitation token is required'),
    password: z.string().min(8, 'Password must be at least 8 characters'),
    email: z.string().email('Invalid email address').optional()
  })
});

const changePasswordSchema = z.object({
  body: z.object({
    current_password: z.string().min(6, 'Current password is required'),
    new_password: z.string().min(8, 'New password must be at least 8 characters')
  })
});

router.post('/register', validateRequest(registerSchema), register);
router.post('/login', validateRequest(loginSchema), login);
router.post('/kiosk-admin', authenticateJWT, validateRequest(kioskAdminSchema), kioskAdminLogin);
router.get('/me', authenticateJWT, requireRole(['admin', 'owner']), getMe);
router.get('/owners', authenticateJWT, requireRole(['admin']), getOwners);
router.post('/owners/invite', authenticateJWT, requireRole(['admin']), validateRequest(inviteOwnerSchema), inviteOwner);
router.post('/setup-password', validateRequest(setupPasswordSchema), setupPassword);
router.post('/change-password', authenticateJWT, requireRole(['admin', 'owner']), validateRequest(changePasswordSchema), changePassword);

export default router;
