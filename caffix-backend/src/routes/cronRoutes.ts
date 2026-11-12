import { Router } from 'express';
import {
  authenticateCronSecret,
  reconcilePendingOrders
} from '../controllers/cronController';

const router = Router();

// Vercel Cron invokes GET with `Authorization: Bearer <CRON_SECRET>`.
// POST is also allowed with the same CRON_SECRET bearer header for manual operator runs.
router.get('/reconcile-orders', authenticateCronSecret, reconcilePendingOrders);
router.post('/reconcile-orders', authenticateCronSecret, reconcilePendingOrders);

export default router;

