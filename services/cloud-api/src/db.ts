import { createPool } from 'mysql2/promise';
import { Redis } from 'ioredis';
import { config } from './config.js';

export const mysql = createPool({
  host: config.mysql.host,
  port: config.mysql.port,
  database: config.mysql.database,
  user: config.mysql.user,
  password: config.mysql.password,
  connectionLimit: config.mysql.connectionLimit,
  waitForConnections: true,
  charset: 'utf8mb4',
  timezone: 'Z',
  enableKeepAlive: true,
});

export const redis = new Redis(config.redisUrl, {
  enableOfflineQueue: false,
  maxRetriesPerRequest: 1,
  lazyConnect: true,
});

export async function closeConnections(): Promise<void> {
  await Promise.allSettled([mysql.end(), redis.quit()]);
}
