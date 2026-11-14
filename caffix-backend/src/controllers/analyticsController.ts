import { Response, NextFunction } from 'express';
import { getDB } from '../config/db';
import { AuthRequest, assertMachineOwnershipOrAdmin } from '../middleware/auth';
import { ForbiddenError, BadRequestError } from '../utils/errors';
import { getAuthoritativeMachinesList } from '../utils/firebase';
import {
  normalizeTimeframe,
  getAnalyticsOverview,
  getTimeSeriesAnalytics,
  getMachineRevenueAnalytics,
  getProductSalesAnalytics,
  getInventoryAnalytics,
  getRefundsAnalytics,
  AnalyticsScopeOptions,
  TimeSeriesInterval
} from '../services/analyticsService';

/**
 * Resolves the multi-tenant scope options for the current authenticated request.
 * Super Admin:
 * - Can query fleet-wide (if machine_id is omitted) or specific machine (if machine_id is provided).
 *
 * Owner:
 * - Scoped strictly to machines assigned to that owner.
 * - If machine_id is provided, verifies ownership (assertMachineOwnershipOrAdmin throws 403/404 if unauthorized).
 * - If machine_id is omitted, resolves all machines assigned to this owner.
 * - If owner has 0 machines assigned, scopes to machineIds: [] (empty result set, never fleet data).
 *
 * Forbidden:
 * - kiosk, kiosk_admin (handled by middleware and verified here).
 */
export async function resolveAuthorizedScope(
  req: AuthRequest
): Promise<{ db: any; options: AnalyticsScopeOptions }> {
  const db = getDB();
  const user = req.user;

  if (!user) {
    throw new ForbiddenError('Authentication required');
  }

  if (user.role === 'kiosk' || user.scope === 'kiosk_admin') {
    throw new ForbiddenError('Kiosk sessions cannot access business analytics');
  }

  const queryMachineId =
    typeof req.query.machine_id === 'string' && req.query.machine_id.trim()
      ? req.query.machine_id.trim()
      : undefined;

  const startDate =
    typeof req.query.start_date === 'string' && req.query.start_date.trim()
      ? req.query.start_date.trim()
      : undefined;

  const endDate =
    typeof req.query.end_date === 'string' && req.query.end_date.trim()
      ? req.query.end_date.trim()
      : undefined;

  const timeZone =
    typeof req.query.time_zone === 'string' && req.query.time_zone.trim()
      ? req.query.time_zone.trim()
      : 'Asia/Kolkata';

  const timeframe = normalizeTimeframe(startDate, endDate, timeZone);
  const options: AnalyticsScopeOptions = { timeframe };

  if (user.role === 'admin') {
    if (queryMachineId) {
      // Validate that machine exists
      await assertMachineOwnershipOrAdmin(user, queryMachineId);
      options.machineId = queryMachineId;
    }
    // If no machine_id, Super Admin views fleet-wide
    return { db, options };
  }

  if (user.role === 'owner') {
    if (queryMachineId) {
      // Enforce strict ownership: assertMachineOwnershipOrAdmin throws 403 if machine is not owned by this owner
      await assertMachineOwnershipOrAdmin(user, queryMachineId);
      options.machineId = queryMachineId;
      return { db, options };
    }

    // Owner fleet query: query all machines assigned to this owner
    const allMachines = await getAuthoritativeMachinesList(db);
    const ownedMachineIds = allMachines
      .filter((m) => m.owner_id && String(m.owner_id).trim() === String(user.id).trim())
      .map((m) => m.id);

    // If owner has 0 machines assigned, empty array enforces 1=0 / empty results
    options.machineIds = ownedMachineIds;
    return { db, options };
  }

  throw new ForbiddenError('You do not have access permission for business analytics');
}

/**
 * GET /api/analytics/overview
 * Dashboard KPI Summary Cards.
 */
export const getOverview = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const { db, options } = await resolveAuthorizedScope(req);
    const data = await getAnalyticsOverview(db, options);
    res.status(200).json({
      status: 'success',
      data
    });
  } catch (err) {
    next(err);
  }
};

/**
 * GET /api/analytics/time-series
 * Time series bucketing in Asia/Kolkata timezone.
 */
export const getTimeSeries = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const { db, options } = await resolveAuthorizedScope(req);
    const intervalRaw = (req.query.interval || req.query.granularity || 'day') as string;
    const interval = ['hour', 'day', 'week', 'month'].includes(intervalRaw)
      ? (intervalRaw as TimeSeriesInterval)
      : 'day';

    const data = await getTimeSeriesAnalytics(db, {
      ...options,
      interval
    });

    res.status(200).json({
      status: 'success',
      data
    });
  } catch (err) {
    next(err);
  }
};

/**
 * GET /api/analytics/machines
 * Machine-level performance and revenue matrix.
 */
export const getMachines = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const { db, options } = await resolveAuthorizedScope(req);
    const data = await getMachineRevenueAnalytics(db, options);
    res.status(200).json({
      status: 'success',
      data
    });
  } catch (err) {
    next(err);
  }
};

/**
 * GET /api/analytics/products
 * Product mix, volume, and revenue share.
 */
export const getProducts = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const { db, options } = await resolveAuthorizedScope(req);
    const data = await getProductSalesAnalytics(db, options);
    res.status(200).json({
      status: 'success',
      data
    });
  } catch (err) {
    next(err);
  }
};

/**
 * GET /api/analytics/inventory
 * Ingredient consumption, refills, waste, adjustments, and current balance.
 */
export const getInventory = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const { db, options } = await resolveAuthorizedScope(req);
    const data = await getInventoryAnalytics(db, options);
    res.status(200).json({
      status: 'success',
      data
    });
  } catch (err) {
    next(err);
  }
};

/**
 * GET /api/analytics/refunds
 * Authoritative refunds analytics: processed, pending, failed counts and amounts,
 * reasons breakdown, and customer-safe recent records.
 */
export const getRefunds = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const { db, options } = await resolveAuthorizedScope(req);
    const data = await getRefundsAnalytics(db, options);
    res.status(200).json({
      status: 'success',
      data
    });
  } catch (err) {
    next(err);
  }
};

