import { Response, NextFunction } from 'express';
import { getDB } from '../config/db';
import { AuthRequest, assertMachineOwnershipOrAdmin } from '../middleware/auth';
import { NotFoundError, BadRequestError, ForbiddenError } from '../utils/errors';
import { getAuthoritativeMachinesList, getAuthoritativeOrderById } from '../utils/firebase';
import {
  generateReconciliationReport,
  reconcileSingleOrderById,
  ReconciliationResult,
  DiscrepancyReason
} from '../services/reconciliationService';
import { getInventoryLedgerForMachine } from '../utils/inventoryLedger';

export const getReconciliationReport = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  const db = getDB();
  try {
    if (req.user?.scope === 'kiosk_admin') {
      return next(new ForbiddenError('Kiosk admin unlock tokens cannot access reconciliation endpoints'));
    }

    const queryMachineId = typeof req.query.machine_id === 'string' ? req.query.machine_id.trim() : '';
    const resultFilter = req.query.result as ReconciliationResult | undefined;
    const discrepancyFilter = req.query.discrepancy as DiscrepancyReason | undefined;

    let targetMachineIds: string[] | undefined = undefined;

    if (req.user?.role === 'owner') {
      if (queryMachineId) {
        await assertMachineOwnershipOrAdmin(req.user, queryMachineId);
        targetMachineIds = [queryMachineId];
      } else {
        const machines = await getAuthoritativeMachinesList(db);
        const ownedMachineIds = machines
          .filter((m) => m.owner_id && String(m.owner_id).trim() === String(req.user!.id).trim())
          .map((m) => String(m.id));
        targetMachineIds = ownedMachineIds;
      }
    } else if (req.user?.role === 'admin') {
      if (queryMachineId) {
        targetMachineIds = [queryMachineId];
      }
    } else {
      return next(new ForbiddenError('Reconciliation reports require admin or owner permissions'));
    }

    const report = await generateReconciliationReport(db, {
      machineIds: targetMachineIds,
      resultFilter,
      discrepancyFilter
    });

    res.status(200).json(report);
  } catch (error) {
    next(error);
  }
};

export const getSingleOrderReconciliation = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  const orderId = String(req.params.id);
  const db = getDB();

  try {
    if (req.user?.scope === 'kiosk_admin') {
      return next(new ForbiddenError('Kiosk admin unlock tokens cannot access reconciliation endpoints'));
    }

    const order = await getAuthoritativeOrderById(orderId, db);
    if (!order) {
      return next(new NotFoundError(`Order ${orderId} not found`));
    }

    if (req.user?.role === 'owner') {
      if (!order.machine_id) {
        return next(new ForbiddenError('Access denied: order is not associated with an assigned machine'));
      }
      await assertMachineOwnershipOrAdmin(req.user, String(order.machine_id));
    } else if (req.user?.role !== 'admin') {
      return next(new ForbiddenError('Reconciliation access denied'));
    }

    const item = await reconcileSingleOrderById(db, orderId);
    if (!item) {
      return next(new NotFoundError(`Could not reconcile order ${orderId}`));
    }

    res.status(200).json({
      status: 'success',
      data: item
    });
  } catch (error) {
    next(error);
  }
};

export const getMachineInventoryLedger = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  const machineId = String(req.params.machine_id);
  const db = getDB();

  try {
    if (req.user?.scope === 'kiosk_admin') {
      return next(new ForbiddenError('Kiosk admin unlock tokens cannot access reconciliation endpoints'));
    }

    await assertMachineOwnershipOrAdmin(req.user, machineId);

    const limit = typeof req.query.limit === 'string' ? parseInt(req.query.limit, 10) : 100;
    const offset = typeof req.query.offset === 'string' ? parseInt(req.query.offset, 10) : 0;

    const entries = await getInventoryLedgerForMachine(db, machineId, { limit, offset });

    res.status(200).json({
      status: 'success',
      machine_id: machineId,
      count: entries.length,
      data: entries
    });
  } catch (error) {
    next(error);
  }
};

