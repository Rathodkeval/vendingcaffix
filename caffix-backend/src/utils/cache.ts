import { Response } from 'express';

/**
 * Sets strict no-store cache control and Vary headers on dynamic kiosk and
 * machine endpoints so CDN/browser caches never serve stale prices, stock,
 * availability, or maintenance status across machines.
 */
export function setNoStoreHeaders(res: Response): void {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.vary('Authorization');
  res.vary('X-Machine-Id');
}
