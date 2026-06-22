import { Request, Response, NextFunction } from 'express';
import { ZodError } from 'zod';
import { BadRequestError } from '../utils/errors';

export const validateRequest = (schema: any) => {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      await schema.parseAsync({
        body: req.body,
        query: req.query,
        params: req.params
      });
      next();
    } catch (error) {
      if (error instanceof ZodError) {
        const errorMessages = error.issues.map(
          (err: any) => `${err.path.join('.')}: ${err.message}`
        ).join('; ');
        next(new BadRequestError(`Validation failed: ${errorMessages}`));
      } else {
        next(error as Error);
      }
    }
  };
};
