import { Response, NextFunction, Request } from 'express';
import jwt from 'jsonwebtoken';
import { UnauthorizedError, ForbiddenError, NotFoundError } from '../utils/errors';
import { getDB } from '../config/db';
import { getAuthoritativeMachineState } from '../utils/firebase';

export type UserRole = 'admin' | 'kiosk' | 'owner';

export interface AuthRequest extends Request {
  user?: {
    id: number | string;
    email: string;
    role: UserRole;
    name: string;
    machine_id?: string;
  };
}

const JWT_SECRET = process.env.JWT_SECRET || 'caffix_vending_secret_key_2026_xyz';

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
    const decoded = jwt.verify(token, JWT_SECRET) as AuthRequest['user'];
    req.user = decoded;
    next();
  } catch (error) {
    next(new UnauthorizedError('Authentication token is invalid or expired'));
  }
};

export const requireRole = (roles: Array<UserRole>) => {
  return (req: AuthRequest, res: Response, next: NextFunction): void => {
    if (!req.user) {
      return next(new UnauthorizedError('User authentication details not found'));
    }

    if (!roles.includes(req.user.role)) {
      return next(new ForbiddenError('You do not have access permission for this resource'));
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
