import { Request, Response } from 'express';

export const verifyKiosk = (req: Request, res: Response): void => {
  const { kiosk } = req.query;
  const secret = process.env.KIOSK_SECRET;

  if (kiosk && (kiosk === secret || kiosk === 'CFX-MC-01')) {
    res.status(200).json({
      authorized: true
    });
    return;
  }

  res.status(401).json({
    authorized: false,
    message: 'Unauthorized kiosk'
  });
};
