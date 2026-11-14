import { Router } from 'express';
import {
  getReconciliationReport,
  getSingleOrderReconciliation,
  getMachineInventoryLedger
} from '../controllers/reconciliationController';
import { authenticateJWT, requireRole } from '../middleware/auth';

const router = Router();

router.get('/report', authenticateJWT, requireRole(['admin', 'owner'], { disallowKioskAdmin: true }), getReconciliationReport);
router.get('/orders/:id', authenticateJWT, requireRole(['admin', 'owner'], { disallowKioskAdmin: true }), getSingleOrderReconciliation);
router.get('/inventory/:machine_id', authenticateJWT, requireRole(['admin', 'owner'], { disallowKioskAdmin: true }), getMachineInventoryLedger);

export default router;

