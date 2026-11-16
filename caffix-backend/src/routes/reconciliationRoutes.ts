import { Router } from 'express';
import {
  getReconciliationReport,
  getSingleOrderReconciliation
} from '../controllers/reconciliationController';
import { authenticateJWT, requireRole } from '../middleware/auth';

const router = Router();

router.get('/report', authenticateJWT, requireRole(['admin', 'owner'], { disallowKioskAdmin: true }), getReconciliationReport);
router.get('/orders/:id', authenticateJWT, requireRole(['admin', 'owner'], { disallowKioskAdmin: true }), getSingleOrderReconciliation);

export default router;

