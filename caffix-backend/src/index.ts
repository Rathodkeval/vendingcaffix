import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'path';
import YAML from 'yamljs';
import swaggerUi from 'swagger-ui-express';

// Load environment variables
dotenv.config();

import { initDB, getDB } from './config/db';
import { ensureFirebaseReady, ensureFirestoreSeeded } from './utils/firebase';
import { ensureSecurityConfigReady, sanitizeUrlForLogging } from './utils/security';
import apiRoutes from './routes';
import { errorHandler } from './middleware/errorHandler';
import logger from './utils/logger';

const app = express();
const PORT = process.env.PORT || 5000;

// Explicit CORS origin allowlist (never unrestricted wildcard '*' for browser origins)
export const DEFAULT_ALLOWED_ORIGINS = [
  'https://caffix-owner.vercel.app',
  'https://caffix-admin.vercel.app',
  'https://vendingcaffix.vercel.app',
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'http://localhost:5174',
  'http://127.0.0.1:5174',
  'http://localhost:5175',
  'http://127.0.0.1:5175',
  'http://localhost:8000',
  'http://127.0.0.1:8000',
  'http://localhost:5000',
  'http://127.0.0.1:5000'
];

export function isAllowedCorsOrigin(origin?: string): boolean {
  // Allow non-browser / server-to-server requests (e.g. Razorpay webhooks, RPi scripts, curl)
  if (!origin) return true;

  const normalized = origin.trim().replace(/\/+$/, '');
  const extraOrigins = (process.env.CORS_ALLOWED_ORIGINS || '')
    .split(',')
    .map((o) => o.trim().replace(/\/+$/, ''))
    .filter(Boolean);

  if (DEFAULT_ALLOWED_ORIGINS.includes(normalized) || extraOrigins.includes(normalized)) {
    return true;
  }

  // Allow localhost / 127.0.0.1 development ports
  if (/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(normalized)) {
    return true;
  }

  return false;
}

app.use(
  cors({
    origin: (origin, callback) => {
      if (isAllowedCorsOrigin(origin)) {
        callback(null, true);
      } else {
        callback(null, false);
      }
    },
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'x-razorpay-signature',
      'x-machine-id',
      'Idempotency-Key',
      'x-portal'
    ],
    credentials: true
  })
);
app.use(
  express.json({
    verify: (req: any, _res, buf) => {
      const requestUrl = String(req.originalUrl || req.url || '');
      if (Buffer.isBuffer(buf) && requestUrl.includes('/payments/webhook')) {
        req.rawBody = Buffer.from(buf);
      }
    }
  })
);

// Custom request logging middleware (redacts sensitive query parameters such as kiosk tokens)
app.use((req, res, next) => {
  logger.info(`${req.method} ${sanitizeUrlForLogging(req.originalUrl)}`);
  next();
});

// Load and mount Swagger documentation
try {
  const swaggerDocument = YAML.load(path.resolve(__dirname, '../swagger.yaml'));
  app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerDocument));
  logger.info('Swagger API docs mounted on /api-docs');
} catch (error) {
  logger.error('Failed to load Swagger YAML definition file:', error);
}

// Lazy Database & Firestore Initialization Middleware (for Serverless / Vercel compatibility)
let dbInitialized = false;
let dbPromise: Promise<any> | null = null;

const ensureDB = async () => {
  // 1. Validate security & Firebase environment credentials first (fail-closed HTTP 503 before touching MockDatabase)
  ensureSecurityConfigReady();
  ensureFirebaseReady();

  // 2. Initialize local SQLite / MockDatabase schema
  if (!dbInitialized) {
    if (!dbPromise) {
      dbPromise = initDB()
        .then(() => {
          dbInitialized = true;
          logger.info('SQLite database schema parsed and seeded successfully');
        })
        .catch((err) => {
          dbPromise = null;
          throw err;
        });
    }
    await dbPromise;
  }

  // 3. Ensure authoritative Firestore records (default admin & machines) are seeded safely without overwriting existing state
  await ensureFirestoreSeeded(getDB());
};

app.use(async (req, res, next) => {
  try {
    await ensureDB();
    next();
  } catch (error) {
    next(error);
  }
});

// Mount REST API routes
app.use('/api', apiRoutes);
app.use('/', apiRoutes);

// Root route
app.get(['/health', '/api/health'], (req, res) => {
  res.status(200).json({
    status: 'success',
    message: 'Welcome to CAFFIX Vending REST API Server',
    docs: '/api-docs',
    env: process.env.NODE_ENV
  });
});

// Central Error Handler (must be registered last)
app.use(errorHandler);

// Bootstrap Server for local environments
if (!process.env.VERCEL) {
  async function startServer() {
    try {
      await ensureDB();
      app.listen(PORT, () => {
        logger.info(`CAFFIX Vending server running on http://localhost:${PORT}`);
        logger.info(`Swagger interactive docs: http://localhost:${PORT}/api-docs`);
      });
    } catch (error) {
      logger.error('Server failed to bootstrap:', error);
      process.exit(1);
    }
  }
  startServer();
}

export default app;
