import { Router } from 'express';
import { z } from 'zod';
import { authenticateJWT, requireRole } from '../middleware/auth';
import { validateRequest } from '../middleware/validate';
import {
  getOverview,
  getTimeSeries,
  getMachines,
  getProducts,
  getInventory,
  getRefunds
} from '../controllers/analyticsController';

const router = Router();

// Validate strict calendar dates to prevent month-overflow (e.g., February 31)
function isValidCalendarDate(str: string): boolean {
  const match = str.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return true;
  const y = parseInt(match[1], 10);
  const m = parseInt(match[2], 10);
  const d = parseInt(match[3], 10);
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const dateObj = new Date(Date.UTC(y, m - 1, d));
  return (
    dateObj.getUTCFullYear() === y &&
    dateObj.getUTCMonth() === m - 1 &&
    dateObj.getUTCDate() === d
  );
}

const dateRegex = /^(\d{4}-\d{2}-\d{2})(T\d{2}:\d{2}:\d{2}(\.\d{1,3})?(Z|[+-]\d{2}:?\d{2})?)?$/;

const baseAnalyticsQuery = {
  start_date: z
    .string()
    .trim()
    .regex(dateRegex, 'Invalid start_date format. Must be YYYY-MM-DD or ISO 8601')
    .refine((val) => !isNaN(Date.parse(val)) && isValidCalendarDate(val), 'Invalid start_date timestamp or calendar date')
    .optional(),
  end_date: z
    .string()
    .trim()
    .regex(dateRegex, 'Invalid end_date format. Must be YYYY-MM-DD or ISO 8601')
    .refine((val) => !isNaN(Date.parse(val)) && isValidCalendarDate(val), 'Invalid end_date timestamp or calendar date')
    .optional(),
  machine_id: z
    .string()
    .trim()
    .min(1, 'machine_id cannot be empty')
    .regex(/^[a-zA-Z0-9_-]+$/, 'Invalid machine_id format')
    .optional(),
  time_zone: z
    .string()
    .trim()
    .optional()
};

function refineDateRange(data: { start_date?: string; end_date?: string }, ctx: z.RefinementCtx) {
  if (data.start_date && data.end_date) {
    const start = new Date(data.start_date).getTime();
    const end = new Date(data.end_date).getTime();
    if (start > end) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'start_date cannot be after end_date',
        path: ['start_date']
      });
    }
    const diffDays = (end - start) / (1000 * 60 * 60 * 24);
    if (diffDays > 366) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Reporting period cannot exceed 366 days',
        path: ['end_date']
      });
    }
  }
}

const analyticsQuerySchema = z.object({
  query: z.object(baseAnalyticsQuery).superRefine(refineDateRange)
});

const timeSeriesQuerySchema = z.object({
  query: z
    .object({
      ...baseAnalyticsQuery,
      interval: z.enum(['hour', 'day', 'week', 'month']).optional(),
      granularity: z.enum(['hour', 'day', 'week', 'month']).optional()
    })
    .superRefine(refineDateRange)
});

// Enforce authentication and role access across all analytics endpoints
// Only Super Admin and Machine Owners are permitted; Kiosks and Kiosk-Admins are strictly rejected (HTTP 403)
router.use(authenticateJWT);
router.use(requireRole(['admin', 'owner'], { disallowKioskAdmin: true }));

router.get('/overview', validateRequest(analyticsQuerySchema), getOverview);
router.get('/time-series', validateRequest(timeSeriesQuerySchema), getTimeSeries);
router.get('/machines', validateRequest(analyticsQuerySchema), getMachines);
router.get('/products', validateRequest(analyticsQuerySchema), getProducts);
router.get('/inventory', validateRequest(analyticsQuerySchema), getInventory);
router.get('/refunds', validateRequest(analyticsQuerySchema), getRefunds);

export default router;

