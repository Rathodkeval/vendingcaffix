import { Request, Response, NextFunction } from 'express';
import { getDB } from '../config/db';
import { NotFoundError } from '../utils/errors';
import logger from '../utils/logger';

export const getProducts = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  const db = getDB();
  try {
    const products = await db.all('SELECT * FROM products');
    res.status(200).json({
      status: 'success',
      data: products
    });
  } catch (error) {
    next(error);
  }
};

export const createProduct = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  const { name, price, description, image } = req.body;
  const db = getDB();
  try {
    const result = await db.run(
      'INSERT INTO products (name, price, description, image) VALUES (?, ?, ?, ?)',
      [name, price, description, image || '/assets/classic_coffee.png']
    );
    
    logger.info(`New product created: ${name} (₹${price})`);
    
    res.status(201).json({
      status: 'success',
      data: {
        id: result.lastID,
        name,
        price,
        description,
        image
      }
    });
  } catch (error) {
    next(error);
  }
};

export const updateProductPrice = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  const idStr = String(req.params.id);
  const { price } = req.body;
  const db = getDB();
  try {
    const product = await db.get('SELECT id FROM products WHERE id = ?', [idStr]);
    if (!product) {
      return next(new NotFoundError(`Product with ID ${idStr} not found`));
    }

    await db.run('UPDATE products SET price = ? WHERE id = ?', [price, idStr]);
    logger.info(`Product ID ${idStr} price updated to ₹${price}`);

    res.status(200).json({
      status: 'success',
      message: 'Product price updated successfully',
      data: { id: parseInt(idStr, 10), price }
    });
  } catch (error) {
    next(error);
  }
};
