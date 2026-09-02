import type { NextFunction, Request, Response } from 'express';
import { ApiError } from './errors.js';
import type { WarehouseIdentity, WarehouseSession } from './warehouseIdentity.js';
import { parseCookie } from './warehouseSecurity.js';

declare global {
  namespace Express {
    interface Request {
      warehouseSession?: WarehouseSession;
    }
  }
}

export function createWarehouseHttpBoundary(input: {
  identity: WarehouseIdentity;
  allowedOrigins: ReadonlySet<string>;
  cookieName: string;
}) {
  const { identity, allowedOrigins, cookieName } = input;
  return {
    origin(req: Request, res: Response, next: NextFunction): void {
      const origin = req.header('origin');
      if (!origin || !allowedOrigins.has(origin)) {
        next(new ApiError(403, 'ORIGIN_NOT_ALLOWED', '请求来源不受信任。'));
        return;
      }
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Request-ID, X-Image-Sha256, X-Label-SHA256');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
      res.setHeader('Vary', 'Origin');
      if (req.method === 'OPTIONS') {
        res.status(204).end();
        return;
      }
      next();
    },

    async session(req: Request, _res: Response, next: NextFunction): Promise<void> {
      try {
        req.warehouseSession = await identity.authenticate(parseCookie(req.header('cookie'), cookieName));
        next();
      } catch (error) {
        next(error);
      }
    },
  };
}
