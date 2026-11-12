import { Response, NextFunction, Request } from 'express';
import jwt from 'jsonwebtoken';
import {
  UnauthorizedError,
  ForbiddenError,
  NotFoundError,
  ServiceUnavailableError
} from '../utils/errors';
import { getDB } from '../config/db';
import { getAuthoritativeMachineState } from '../utils/firebase';
import { getJwtSecret, isValidRoleForPortal } from '../utils/security';

export type UserRole = 'admin' | 'kiosk' | 'owner';
export type PortalType = 'admin' | 'owner';
export type TokenScope = 'kiosk_admin';

export interface AuthRequest extends Request {
  user?: {
    id: number | string;
    email: string;
    role: UserRole;
    name: string;
    machine_id?: string;
    portal?: PortalType;
    scope?: TokenScope;
  };
}

export const authenticateJWT = (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): void => {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return next(new UnauthorizedError('Missing or invalid Authorization header'));
  }

  const token = authHeader.split(' ')[1];

  try {
    const jwtSecret = getJwtSecret();
    const decoded = jwt.verify(token, jwtSecret) as AuthRequest['user'];
    if (!decoded || !['admin', 'kiosk', 'owner'].includes(decoded.role)) {
      return next(new UnauthorizedError('Authentication token contains invalid role claims'));
    }
    if (!isValidRoleForPortal(decoded.role, decoded.portal)) {
      return next(new ForbiddenError('Portal claim does not match authenticated role'));
    }
    req.user = decoded;
    next();
  } catch (error) {
    if (error instanceof ServiceUnavailableError) {
      return next(error);
    }
    next(new UnauthorizedError('Authentication token is invalid or expired'));
  }
};

export const requireRole = (
  roles: Array<UserRole>,
  options: { disallowKioskAdmin?: boolean } = {}
) => {
  return (req: AuthRequest, res: Response, next: NextFunction): void => {
    if (!req.user) {
      return next(new UnauthorizedError('User authentication details not found'));
    }

    if (!roles.includes(req.user.role)) {
      return next(new ForbiddenError('You do not have access permission for this resource'));
    }

    if (!isValidRoleForPortal(req.user.role, req.user.portal)) {
      return next(new ForbiddenError('Portal claim does not match required role'));
    }

    if (options.disallowKioskAdmin && req.user.scope === 'kiosk_admin') {
      return next(
        new ForbiddenError('Kiosk admin unlock tokens cannot access Super Admin management endpoints')
      );
    }

    const headerPortal =
      typeof req.headers['x-portal'] === 'string' ? req.headers['x-portal'].trim().toLowerCase() : '';
    if (headerPortal) {
      if (!isValidRoleForPortal(req.user.role, headerPortal)) {
        return next(new ForbiddenError(`Access denied: role "${req.user.role}" cannot access ${headerPortal} portal`));
      }
      if (req.user.portal && req.user.portal !== headerPortal) {
        return next(new ForbiddenError(`Access denied: token scoped to ${req.user.portal} portal cannot access ${headerPortal} portal`));
      }
    }

    next();
  };
};

/**
 * Live database/Firestore machine ownership enforcement.
 * Never trusts machine assignments embedded in JWTs; always checks current authoritative `owner_id`.
 * - Admin: can access all machines.
 * - Owner: can ONLY access machines where live `machine.owner_id === String(user.id)`.
 * - Kiosk (when allowed on a route): can ONLY access its own bound `user.machine_id`.
 */
export async function assertMachineOwnershipOrAdmin(
  user: AuthRequest['user'],
  machineId: string
): Promise<any> {
  if (!user) {
    throw new UnauthorizedError('Authentication required');
  }

  const db = getDB();
  const machine = await getAuthoritativeMachineState(machineId, db);
  if (!machine) {
    throw new NotFoundError(`Machine with ID ${machineId} not found`);
  }

  if (user.role === 'admin') {
    if (user.scope === 'kiosk_admin') {
      if (!user.machine_id || user.machine_id !== machineId) {
        throw new ForbiddenError(
          `Kiosk admin session bound to ${user.machine_id || 'unknown'} cannot access machine ${machineId}`
        );
      }
    }
    return machine;
  }

  if (user.role === 'owner') {
    const currentOwnerId = machine.owner_id ? String(machine.owner_id).trim() : null;
    const requestingUserId = String(user.id).trim();
    if (!currentOwnerId || currentOwnerId !== requestingUserId) {
      throw new ForbiddenError(
        `Access denied: machine ${machineId} is not assigned to your owner account`
      );
    }
    return machine;
  }

  if (user.role === 'kiosk') {
    if (!user.machine_id || user.machine_id !== machineId) {
      throw new ForbiddenError(
        `Kiosk session bound to ${user.machine_id || 'unknown'} cannot access machine ${machineId}`
      );
    }
    return machine;
  }

  throw new ForbiddenError('You do not have access permission for this machine');
}
