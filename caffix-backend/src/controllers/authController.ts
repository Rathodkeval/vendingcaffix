import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { getDB } from '../config/db';
import { AuthRequest } from '../middleware/auth';
import { BadRequestError, UnauthorizedError, NotFoundError } from '../utils/errors';
import {
  syncUserToFirebase,
  getAuthoritativeUserByEmail,
  getAuthoritativeUserById,
  getAuthoritativeOwnersList,
  getAuthoritativeMachinesList,
  updateMachineOwnerInFirebase,
  consumeSetupTokenAtomically
} from '../utils/firebase';
import { ensureMachineRegisteredInLocalDB } from './kioskController';
import logger from '../utils/logger';

const JWT_SECRET = process.env.JWT_SECRET || 'caffix_vending_secret_key_2026_xyz';
export const INVITE_TOKEN_EXPIRY_MS = 24 * 60 * 60 * 1000; // 24 hours

export function hashInvitationToken(rawToken: string): string {
  return crypto.createHash('sha256').update(String(rawToken).trim()).digest('hex');
}

async function getLiveAssignedMachineIds(userId: string, role: string, db: any): Promise<string[]> {
  const machines = await getAuthoritativeMachinesList(db);
  if (role === 'admin') {
    return machines.map((m) => m.id);
  }
  if (role === 'owner') {
    return machines
      .filter((m) => m.owner_id && String(m.owner_id).trim() === String(userId).trim())
      .map((m) => m.id);
  }
  return [];
}

export const register = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  const { name, email, password, role } = req.body;
  const db = getDB();

  try {
    const normalizedEmail = String(email).trim().toLowerCase();
    const existingUser = await getAuthoritativeUserByEmail(normalizedEmail, db);
    if (existingUser) {
      return next(new BadRequestError('A user with this email address already exists'));
    }

    const userId = `usr_${crypto.randomUUID()}`;
    const hashedPassword = bcrypt.hashSync(password, 10);
    const nowIso = new Date().toISOString();

    await db.run(
      'INSERT INTO users (id, name, email, password, role, setup_token_hash, setup_token_expires_at, must_change_password, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [userId, name, normalizedEmail, hashedPassword, role, null, null, 0, nowIso]
    );

    await syncUserToFirebase({
      id: userId,
      name,
      email: normalizedEmail,
      password: hashedPassword,
      role,
      setup_token_hash: null,
      setup_token_expires_at: null,
      must_change_password: 0,
      updated_at: nowIso
    });

    logger.info(`User registered successfully: ${normalizedEmail} (${role}, id=${userId})`);
    
    res.status(201).json({
      status: 'success',
      data: {
        id: userId,
        name,
        email: normalizedEmail,
        role
      }
    });
  } catch (error) {
    next(error);
  }
};

export const login = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  const { email, password, machine_id } = req.body;
  const db = getDB();

  try {
    const normalizedEmail = String(email).trim().toLowerCase();
    const user = await getAuthoritativeUserByEmail(normalizedEmail, db);
    if (!user) {
      return next(new UnauthorizedError('Invalid credentials'));
    }

    if (user.must_change_password === 1 || user.setup_token_hash) {
      return next(
        new UnauthorizedError(
          'Account setup is not complete. Please use your one-time invitation token to set your password.'
        )
      );
    }

    const isMatch = bcrypt.compareSync(password, user.password);
    if (!isMatch) {
      return next(new UnauthorizedError('Invalid credentials'));
    }

    let resolvedMachineId: string | undefined = undefined;
    if (user.role === 'kiosk' && machine_id) {
      const machine = await ensureMachineRegisteredInLocalDB(machine_id);
      if (!machine) {
        return next(new UnauthorizedError(`Unregistered machine ID: ${machine_id}`));
      }
      resolvedMachineId = machine.id;
    }

    const userId = String(user.id);

    // Sign JWT (note: owner machine assignments are NOT trusted from JWT; they are checked live on every request)
    const token = jwt.sign(
      {
        id: userId,
        email: user.email,
        role: user.role,
        name: user.name,
        ...(resolvedMachineId ? { machine_id: resolvedMachineId } : {})
      },
      JWT_SECRET,
      { expiresIn: '24h' }
    );

    const assignedMachines =
      user.role === 'owner' || user.role === 'admin'
        ? await getLiveAssignedMachineIds(userId, user.role, db)
        : undefined;

    logger.info(`User logged in: ${normalizedEmail} (role: ${user.role})${resolvedMachineId ? ` (machine: ${resolvedMachineId})` : ''}`);

    res.status(200).json({
      status: 'success',
      token,
      data: {
        id: userId,
        name: user.name,
        email: user.email,
        role: user.role,
        ...(resolvedMachineId ? { machine_id: resolvedMachineId } : {}),
        ...(assignedMachines !== undefined ? { assigned_machines: assignedMachines } : {})
      }
    });
  } catch (error) {
    next(error);
  }
};

export const kioskAdminLogin = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  const { passcode, machine_id } = req.body;
  const expectedPin = (process.env.ADMIN_PASSCODE || '1234').trim();

  try {
    if (!passcode || String(passcode).trim() !== expectedPin) {
      return next(new UnauthorizedError('Invalid admin passcode'));
    }

    const token = jwt.sign(
      {
        id: '1',
        email: 'admin@caffix.com',
        role: 'admin',
        name: 'Caffix Manager',
        ...(machine_id ? { machine_id } : {})
      },
      JWT_SECRET,
      { expiresIn: '12h' }
    );

    logger.info(`Kiosk admin unlocked${machine_id ? ` on machine ${machine_id}` : ''}`);

    res.status(200).json({
      status: 'success',
      token,
      data: {
        id: '1',
        name: 'Caffix Manager',
        email: 'admin@caffix.com',
        role: 'admin',
        ...(machine_id ? { machine_id } : {})
      }
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Admin-only endpoint: Invite a new customer Owner account and optionally assign machines.
 * Generates a cryptographically random 256-bit single-use token, stores ONLY its SHA-256 hash
 * with a 24-hour expiration in Firestore + SQLite/MockDatabase, and assigns specified machines.
 */
export const inviteOwner = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  const { name, email, machine_ids, expires_in_ms } = req.body;
  const db = getDB();

  try {
    const normalizedEmail = String(email).trim().toLowerCase();
    const existingUser = await getAuthoritativeUserByEmail(normalizedEmail, db);
    if (existingUser) {
      return next(new BadRequestError('A user with this email address already exists'));
    }

    const requestedMachines: string[] = Array.isArray(machine_ids)
      ? Array.from(new Set(machine_ids.map((m: string) => String(m).trim()).filter(Boolean)))
      : [];

    // Verify all requested machines exist before creating user
    for (const mId of requestedMachines) {
      const machine = await ensureMachineRegisteredInLocalDB(mId);
      if (!machine) {
        return next(new NotFoundError(`Machine with ID ${mId} not found`));
      }
    }

    // Generate stable UUID-based user ID
    const userId = `usr_${crypto.randomUUID()}`;

    // Generate cryptographically random single-use invitation token (64 hex chars / 256 bits)
    const rawInviteToken = crypto.randomBytes(32).toString('hex');
    const setupTokenHash = hashInvitationToken(rawInviteToken);

    const ttlMs =
      typeof expires_in_ms === 'number' && !Number.isNaN(expires_in_ms)
        ? expires_in_ms
        : INVITE_TOKEN_EXPIRY_MS;
    const nowIso = new Date().toISOString();
    const expiresAtIso = new Date(Date.now() + ttlMs).toISOString();

    // Unusable placeholder hash until owner completes setupPassword
    const lockedPlaceholderHash = bcrypt.hashSync(crypto.randomBytes(32).toString('hex'), 10);

    await db.run(
      'INSERT INTO users (id, name, email, password, role, setup_token_hash, setup_token_expires_at, must_change_password, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [
        userId,
        name.trim(),
        normalizedEmail,
        lockedPlaceholderHash,
        'owner',
        setupTokenHash,
        expiresAtIso,
        1,
        nowIso
      ]
    );

    await syncUserToFirebase({
      id: userId,
      name: name.trim(),
      email: normalizedEmail,
      password: lockedPlaceholderHash,
      role: 'owner',
      setup_token_hash: setupTokenHash,
      setup_token_expires_at: expiresAtIso,
      must_change_password: 1,
      updated_at: nowIso
    });

    // Assign requested machines to this owner in local DB and Firestore
    for (const mId of requestedMachines) {
      await db.run('UPDATE machines SET owner_id = ?, updated_at = ? WHERE id = ?', [
        userId,
        nowIso,
        mId
      ]);
      await updateMachineOwnerInFirebase(mId, userId);
    }

    logger.info(
      `Admin invited owner ${normalizedEmail} (id=${userId}) with machines: [${requestedMachines.join(', ')}]`
    );

    res.status(201).json({
      status: 'success',
      message: 'Owner invitation created. Share the single-use invitation token with the customer.',
      data: {
        user: {
          id: userId,
          name: name.trim(),
          email: normalizedEmail,
          role: 'owner',
          must_change_password: true,
          setup_token_expires_at: expiresAtIso
        },
        assigned_machines: requestedMachines,
        invite_token: rawInviteToken,
        setup_url: `/setup-password?token=${rawInviteToken}&email=${encodeURIComponent(normalizedEmail)}`
      }
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Public single-use token endpoint: Complete owner password setup.
 * Atomically verifies and consumes the SHA-256 token hash via Firestore transaction + mutex + conditional SQL,
 * enforces 24-hour expiry, hashes password with bcrypt, and returns a signed JWT.
 */
export const setupPassword = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  const { token, password, email } = req.body;
  const db = getDB();

  try {
    const tokenHash = hashInvitationToken(token);
    const hashedPassword = bcrypt.hashSync(password, 10);

    const outcome = await consumeSetupTokenAtomically(tokenHash, hashedPassword, email, db);

    if (!outcome.success || !outcome.user) {
      if (outcome.reason === 'EMAIL_MISMATCH') {
        return next(new BadRequestError('Invitation token does not match the provided email address'));
      }
      if (outcome.reason === 'EXPIRED') {
        return next(new BadRequestError('Invitation token has expired'));
      }
      return next(new BadRequestError('Invalid or already-used invitation token'));
    }

    const user = outcome.user;
    const userId = String(user.id);
    const assignedMachines = await getLiveAssignedMachineIds(userId, user.role, db);

    const jwtToken = jwt.sign(
      {
        id: userId,
        email: user.email,
        role: user.role,
        name: user.name
      },
      JWT_SECRET,
      { expiresIn: '24h' }
    );

    logger.info(`Owner ${user.email} (id=${userId}) completed password setup`);

    res.status(200).json({
      status: 'success',
      message: 'Password configured successfully',
      token: jwtToken,
      data: {
        id: userId,
        name: user.name,
        email: user.email,
        role: user.role,
        assigned_machines: assignedMachines
      }
    });
  } catch (error) {
    next(error);
  }
};

export const changePassword = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  const { current_password, new_password } = req.body;
  const db = getDB();

  try {
    if (!req.user) {
      return next(new UnauthorizedError('Authentication required'));
    }

    const user = await getAuthoritativeUserById(req.user.id, db);
    if (!user) {
      return next(new NotFoundError('User account not found'));
    }

    const isMatch = bcrypt.compareSync(current_password, user.password);
    if (!isMatch) {
      return next(new UnauthorizedError('Current password is incorrect'));
    }

    const hashedPassword = bcrypt.hashSync(new_password, 10);
    const nowIso = new Date().toISOString();
    const userId = String(user.id);

    await db.run('UPDATE users SET password = ?, updated_at = ? WHERE id = ?', [
      hashedPassword,
      nowIso,
      userId
    ]);

    await syncUserToFirebase({
      id: userId,
      name: user.name,
      email: user.email,
      password: hashedPassword,
      role: user.role,
      setup_token_hash: null,
      setup_token_expires_at: null,
      must_change_password: 0,
      updated_at: nowIso
    });

    res.status(200).json({
      status: 'success',
      message: 'Password updated successfully'
    });
  } catch (error) {
    next(error);
  }
};

export const getMe = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  const db = getDB();
  try {
    if (!req.user) {
      return next(new UnauthorizedError('Authentication required'));
    }

    const user = await getAuthoritativeUserById(req.user.id, db);
    const userId = user ? String(user.id) : String(req.user.id);
    const role = user ? user.role : req.user.role;
    const assignedMachines = await getLiveAssignedMachineIds(userId, role, db);

    res.status(200).json({
      status: 'success',
      data: {
        id: userId,
        name: user ? user.name : req.user.name,
        email: user ? user.email : req.user.email,
        role,
        assigned_machines: assignedMachines
      }
    });
  } catch (error) {
    next(error);
  }
};

export const getOwners = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  const db = getDB();
  try {
    const owners = await getAuthoritativeOwnersList(db);
    const machines = await getAuthoritativeMachinesList(db);

    const formatted = owners.map((o) => {
      const ownerId = String(o.id);
      const assigned = machines
        .filter((m) => m.owner_id && String(m.owner_id).trim() === ownerId)
        .map((m) => m.id);
      return {
        id: ownerId,
        name: o.name,
        email: o.email,
        role: o.role,
        must_change_password: Boolean(o.must_change_password),
        updated_at: o.updated_at || null,
        assigned_machines: assigned
      };
    });

    res.status(200).json({
      status: 'success',
      data: formatted
    });
  } catch (error) {
    next(error);
  }
};
