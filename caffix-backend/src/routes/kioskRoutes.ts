import { Router } from 'express';
import { verifyKiosk } from '../controllers/kioskController';

const router = Router();

router.get('/verify', verifyKiosk);

export default router;
