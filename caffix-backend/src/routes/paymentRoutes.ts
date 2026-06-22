import { Router } from 'express';
import { verifyPaymentSignature, handleRazorpayWebhook } from '../controllers/paymentController';
import { authenticateJWT } from '../middleware/auth';

const router = Router();

router.post('/verify', authenticateJWT, verifyPaymentSignature);
router.post('/webhook', handleRazorpayWebhook);

export default router;
