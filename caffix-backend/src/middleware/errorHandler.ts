import { Request, Response, NextFunction } from 'express';
import { AppError } from '../utils/errors';
import logger from '../utils/logger';

export const errorHandler = (
  err: Error,
  req: Request,
  res: Response,
  next: NextFunction
): void => {
  let statusCode = 500;
  let message = 'Internal Server Error';
  let isOperational = false;

  if (err instanceof AppError) {
    statusCode = err.statusCode;
    message = err.message;
    isOperational = err.isOperational;
  }

  // Log error using Winston
  if (statusCode === 500) {
    logger.error(`${req.method} ${req.originalUrl} - ${err.message}`, {
      stack: err.stack,
      url: req.originalUrl,
      method: req.method
    });
  } else {
    logger.warn(`${req.method} ${req.originalUrl} - ${statusCode} - ${err.message}`);
  }

  // Send JSON response
  res.status(statusCode).json({
    status: 'error',
    message: message,
    ...(process.env.NODE_ENV === 'development' && !isOperational ? { stack: err.stack } : {})
  });
};
