import { Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { UnauthorizedError, ForbiddenError } from '../utils/errors';
import { Request } from 'express';

export interface AuthRequest extends Request {
  user?: {
    id: number;
    email: string;
    role: 'admin' | 'kiosk';
    name: string;
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

export const requireRole = (roles: Array<'admin' | 'kiosk'>) => {
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
