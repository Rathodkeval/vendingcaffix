import { Router } from 'express';
import authRoutes from './authRoutes';
import productRoutes from './productRoutes';
import machineRoutes from './machineRoutes';
import orderRoutes from './orderRoutes';
import paymentRoutes from './paymentRoutes';
import kioskRoutes from './kioskRoutes';
import { getMachineStatus } from '../controllers/machineController';
import { authenticateJWT } from '../middleware/auth';

const router = Router();

router.use('/auth', authRoutes);
router.use('/products', productRoutes);
router.use('/machines', machineRoutes);
router.use('/orders', orderRoutes);
router.use('/payments', paymentRoutes);
router.use('/kiosk', kioskRoutes);
router.get('/machine-status', authenticateJWT, getMachineStatus);

export default router;
