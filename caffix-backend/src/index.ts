import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'path';
import YAML from 'yamljs';
import swaggerUi from 'swagger-ui-express';

// Load environment variables
dotenv.config();

import { initDB } from './config/db';
import apiRoutes from './routes';
import { errorHandler } from './middleware/errorHandler';
import logger from './utils/logger';

const app = express();
const PORT = process.env.PORT || 5000;

// Enable CORS and JSON parsing
app.use(cors());
app.use(express.json());

// Custom request logging middleware
app.use((req, res, next) => {
  logger.info(`${req.method} ${req.originalUrl}`);
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

// Mount REST API routes
app.use('/api', apiRoutes);
app.use('/', apiRoutes);

// Root route
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'success',
    message: 'Welcome to CAFFIX Vending REST API Server',
    docs: '/api-docs',
    env: process.env.NODE_ENV
  });
});

// Central Error Handler (must be registered last)
app.use(errorHandler);

// Bootstrap Server
async function startServer() {
  try {
    await initDB();
    logger.info('SQLite database schema parsed and seeded successfully');

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
