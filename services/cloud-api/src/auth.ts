import { timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import type { RowDataPacket } from 'mysql2';
import { hashApiKey, parseApiKey, parseStoredScopes, type IntegrationScope } from './apiKeys.js';
import { config } from './config.js';
import { mysql, redis } from './db.js';
import { ApiError } from './errors.js';

export type AuthenticatedClient = {
  id: string;
  apiKeyId: string;
  scopes: IntegrationScope[];
  rateLimitPerMinute: number;
};

declare global {
  namespace Express {
    interface Request {
      client?: AuthenticatedClient;
      requestId: string;
    }
  }
}

type ClientRow = RowDataPacket & {
  client_id: string;
  api_key_id: string;
  api_key_hash: Buffer;
  scopes: string | unknown[];
  rate_limit_per_minute: number;
};

async function enforceRateLimit(client: AuthenticatedClient): Promise<void> {
  const minute = Math.floor(Date.now() / 60_000);
  const key = `cmhub:rate:${client.apiKeyId}:${minute}`;
  try {
    const count = await redis.incr(key);
    if (count === 1) await redis.expire(key, 60);
    if (count > client.rateLimitPerMinute) {
      throw new ApiError(429, 'RATE_LIMITED', '请求过于频繁，请稍后重试');
    }
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(503, 'RATE_LIMIT_UNAVAILABLE', '认证服务暂时不可用，请稍后重试');
  }
}

export async function requireApiKey(req: Request, _res: Response, next: NextFunction): Promise<void> {
  try {
    const apiKey = req.header('x-api-key')?.trim();
    const parsed = apiKey ? parseApiKey(apiKey) : undefined;
    if (!apiKey || !parsed) {
      throw new ApiError(401, 'INVALID_API_KEY', '缺少或无效的 X-API-Key');
    }
    if (config.environment === 'production' && parsed.environment !== 'live') {
      throw new ApiError(401, 'INVALID_API_KEY', '测试环境 API Key 不能用于生产服务');
    }

    const [rows] = await mysql.execute<ClientRow[]>(
      `SELECT c.id AS client_id, k.id AS api_key_id, k.api_key_hash, k.scopes, k.rate_limit_per_minute
       FROM integration_api_keys k
       INNER JOIN clients c ON c.id = k.client_id
       WHERE k.key_id = ?
         AND k.key_status = 'ACTIVE'
         AND k.revoked_at IS NULL
         AND (k.expires_at IS NULL OR k.expires_at > CURRENT_TIMESTAMP(3))
         AND c.client_status = 'ACTIVE'
       LIMIT 1`,
      [parsed.keyId],
    );
    const row = rows[0];
    const suppliedHash = hashApiKey(apiKey);
    if (!row || row.api_key_hash.length !== suppliedHash.length || !timingSafeEqual(row.api_key_hash, suppliedHash)) {
      throw new ApiError(401, 'INVALID_API_KEY', 'X-API-Key 无效或已停用');
    }

    const client: AuthenticatedClient = {
      id: row.client_id,
      apiKeyId: row.api_key_id,
      scopes: parseStoredScopes(row.scopes),
      rateLimitPerMinute: row.rate_limit_per_minute,
    };
    await enforceRateLimit(client);
    await mysql.execute(
      `UPDATE integration_api_keys
       SET last_used_at = CURRENT_TIMESTAMP(3)
       WHERE id = ? AND (last_used_at IS NULL OR last_used_at < CURRENT_TIMESTAMP(3) - INTERVAL 5 MINUTE)`,
      [client.apiKeyId],
    );
    req.client = client;
    next();
  } catch (error) {
    next(error);
  }
}

export function requireScope(scope: IntegrationScope) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.client?.scopes.includes(scope)) {
      next(new ApiError(403, 'INSUFFICIENT_SCOPE', `当前 API Key 缺少 ${scope} 权限`));
      return;
    }
    next();
  };
}
