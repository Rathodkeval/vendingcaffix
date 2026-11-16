import { Router } from 'express';
import { verifyKiosk, getKioskSync } from '../controllers/kioskController';
import { authenticateJWT } from '../middleware/auth';

const router = Router();

router.get('/verify', verifyKiosk);
router.get('/sync', authenticateJWT, getKioskSync);

export default router;
