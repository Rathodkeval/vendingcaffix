import { Request, Response, NextFunction } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { getDB } from '../config/db';
import { BadRequestError, UnauthorizedError } from '../utils/errors';
import logger from '../utils/logger';

const JWT_SECRET = process.env.JWT_SECRET || 'caffix_vending_secret_key_2026_xyz';

export const register = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  const { name, email, password, role } = req.body;
  const db = getDB();

  try {
    // Check if user already exists
    const existingUser = await db.get('SELECT id FROM users WHERE email = ?', [email]);
    if (existingUser) {
      return next(new BadRequestError('A user with this email address already exists'));
    }

    const hashedPassword = bcrypt.hashSync(password, 10);
    const result = await db.run(
      'INSERT INTO users (name, email, password, role) VALUES (?, ?, ?, ?)',
      [name, email, hashedPassword, role]
    );

    logger.info(`User registered successfully: ${email} (${role})`);
    
    res.status(201).json({
      status: 'success',
      data: {
        id: result.lastID,
        name,
        email,
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
  const { email, password } = req.body;
  const db = getDB();

  try {
    const user = await db.get('SELECT * FROM users WHERE email = ?', [email]);
    if (!user) {
      return next(new UnauthorizedError('Invalid credentials'));
    }

    const isMatch = bcrypt.compareSync(password, user.password);
    if (!isMatch) {
      return next(new UnauthorizedError('Invalid credentials'));
    }

    // Sign JWT
    const token = jwt.sign(
      { id: user.id, email: user.email, role: user.role, name: user.name },
      JWT_SECRET,
      { expiresIn: '24h' }
    );

    logger.info(`User logged in: ${email}`);

    res.status(200).json({
      status: 'success',
      token,
      data: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role
      }
    });
  } catch (error) {
    next(error);
  }
};
