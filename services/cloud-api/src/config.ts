import 'dotenv/config';
import { resolve } from 'node:path';

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function asPort(name: string, fallback: number): number {
  const value = process.env[name];
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw new Error(`${name} must be a valid TCP port`);
  }
  return parsed;
}

function asPositiveInteger(name: string, fallback: number): number {
  const value = process.env[name];
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function asIntegerRange(name: string, fallback: number, minimum: number, maximum: number): number {
  const parsed = asPositiveInteger(name, fallback);
  if (parsed < minimum || parsed > maximum) throw new Error(`${name} must be between ${minimum} and ${maximum}`);
  return parsed;
}

function asBoolean(name: string, fallback: boolean): boolean {
  const value = process.env[name]?.trim().toLowerCase();
  if (!value) return fallback;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error(`${name} must be true or false`);
}

function asChoice<const T extends string>(name: string, choices: readonly T[], fallback: T): T {
  const value = process.env[name]?.trim().toLowerCase() || fallback;
  if (!choices.includes(value as T)) {
    throw new Error(`${name} must be one of: ${choices.join(', ')}`);
  }
  return value as T;
}

function decodeMasterKey(name: string, value: string | undefined): Buffer | null {
  value = value?.trim();
  if (!value) return null;
  const decoded = Buffer.from(value, 'base64');
  if (decoded.length !== 32 || decoded.toString('base64') !== value) {
    throw new Error(`${name} must be a canonical base64-encoded 32-byte key`);
  }
  return decoded;
}

function asOptionalMasterKey(name: string): Buffer | null {
  return decodeMasterKey(name, process.env[name]);
}

function asMasterKeyring(activeVersion: string): ReadonlyMap<string, Buffer> {
  if (!/^[a-zA-Z0-9_-]{1,32}$/.test(activeVersion)) {
    throw new Error('OUTBOUND_WEBHOOK_KEY_VERSION must contain 1 to 32 ASCII letters, digits, underscores, or hyphens');
  }
  const keys = new Map<string, Buffer>();
  const encodedKeyring = process.env.OUTBOUND_WEBHOOK_MASTER_KEYS?.trim();
  for (const entry of encodedKeyring ? encodedKeyring.split(',') : []) {
    const separator = entry.indexOf('=');
    const version = entry.slice(0, separator).trim();
    const encoded = entry.slice(separator + 1).trim();
    if (separator < 1 || !/^[a-zA-Z0-9_-]{1,32}$/.test(version) || keys.has(version)) {
      throw new Error('OUTBOUND_WEBHOOK_MASTER_KEYS must contain unique version=base64 entries');
    }
    const key = decodeMasterKey(`OUTBOUND_WEBHOOK_MASTER_KEYS (${version})`, encoded);
    if (!key) throw new Error(`OUTBOUND_WEBHOOK_MASTER_KEYS is missing a key for ${version}`);
    keys.set(version, key);
  }
  const legacy = asOptionalMasterKey('OUTBOUND_WEBHOOK_MASTER_KEY');
  if (legacy) {
    const existing = keys.get(activeVersion);
    if (existing && !existing.equals(legacy)) {
      throw new Error(`OUTBOUND_WEBHOOK_MASTER_KEY conflicts with ${activeVersion} in OUTBOUND_WEBHOOK_MASTER_KEYS`);
    }
    keys.set(activeVersion, legacy);
  }
  return keys;
}

function asOriginList(name: string, fallback: string[]): string[] {
  const values = (process.env[name]?.split(',') ?? fallback).map(value => value.trim()).filter(Boolean);
  if (values.length === 0 || values.some(value => {
    try {
      const url = new URL(value);
      return url.origin !== value || !['http:', 'https:'].includes(url.protocol);
    } catch {
      return true;
    }
  })) {
    throw new Error(`${name} must be a comma-separated list of exact HTTP(S) origins`);
  }
  return [...new Set(values)];
}

const environment = process.env.NODE_ENV ?? 'development';
const labelStorageBackend = asChoice('LABEL_STORAGE_BACKEND', ['filesystem', 'cos'] as const, 'filesystem');
const configuredLabelStorageRoot = process.env.LABEL_STORAGE_ROOT?.trim();
if (environment === 'production' && labelStorageBackend === 'filesystem' && !configuredLabelStorageRoot) {
  throw new Error('Missing required environment variable: LABEL_STORAGE_ROOT');
}
const cosBucket = process.env.COS_BUCKET?.trim();
const cosRegion = process.env.COS_REGION?.trim();
const cosSecretId = process.env.COS_SECRET_ID?.trim();
const cosSecretKey = process.env.COS_SECRET_KEY?.trim();
if (labelStorageBackend === 'cos' && (!cosBucket || !cosRegion || !cosSecretId || !cosSecretKey)) {
  throw new Error('COS storage requires COS_BUCKET, COS_REGION, COS_SECRET_ID, and COS_SECRET_KEY');
}
const outboundWebhookEnabled = asBoolean('OUTBOUND_WEBHOOK_ENABLED', false);
const outboundWebhookKeyVersion = process.env.OUTBOUND_WEBHOOK_KEY_VERSION?.trim() || 'v1';
const outboundWebhookMasterKeys = asMasterKeyring(outboundWebhookKeyVersion);
if (outboundWebhookEnabled && !outboundWebhookMasterKeys.has(outboundWebhookKeyVersion)) {
  throw new Error(`Missing master key for active outbound webhook key version: ${outboundWebhookKeyVersion}`);
}
const outboundWebhookLeaseSeconds = asIntegerRange('OUTBOUND_WEBHOOK_LEASE_SECONDS', 60, 15, 600);
const outboundWebhookTimeoutMs = asIntegerRange('OUTBOUND_WEBHOOK_TIMEOUT_MS', 10000, 1000, 60000);
if (outboundWebhookLeaseSeconds * 1000 < outboundWebhookTimeoutMs + 10_000) {
  throw new Error('OUTBOUND_WEBHOOK_LEASE_SECONDS must exceed OUTBOUND_WEBHOOK_TIMEOUT_MS by at least 10 seconds');
}

export const config = {
  environment,
  host: process.env.HOST?.trim() || '127.0.0.1',
  port: asPort('PORT', 8080),
  jsonLimit: process.env.JSON_BODY_LIMIT ?? '256kb',
  inboundBatchJsonLimit: process.env.INBOUND_BATCH_JSON_LIMIT ?? '10mb',
  // TYG v1.1 embeds a maximum 5 MiB PDF as Base64. Keep its larger parser
  // scoped to that route; legacy JSON requests retain the 256 KiB default.
  tygLabelPushJsonLimit: process.env.TYG_LABEL_PUSH_JSON_LIMIT ?? '7mb',
  labelPdfLimit: process.env.LABEL_PDF_LIMIT ?? '20mb',
  labelStorage: labelStorageBackend === 'cos' ? {
    backend: 'cos' as const,
    bucket: cosBucket!,
    region: cosRegion!,
    secretId: cosSecretId!,
    secretKey: cosSecretKey!,
    securityToken: process.env.COS_SECURITY_TOKEN?.trim() || undefined,
    prefix: process.env.COS_PREFIX?.trim() || '',
  } : {
    backend: 'filesystem' as const,
    root: configuredLabelStorageRoot || resolve(process.cwd(), 'data', 'labels'),
  },
  mysql: {
    host: required('MYSQL_HOST'),
    port: asPort('MYSQL_PORT', 3306),
    database: required('MYSQL_DATABASE'),
    user: required('MYSQL_USER'),
    password: required('MYSQL_PASSWORD'),
    connectionLimit: asPositiveInteger('MYSQL_CONNECTION_LIMIT', 10),
  },
  redisUrl: required('REDIS_URL'),
  warehouse: {
    allowedOrigins: asOriginList('WAREHOUSE_ALLOWED_ORIGINS', environment === 'production'
      ? ['https://cmhubtool.com']
      : ['http://127.0.0.1:5173', 'http://localhost:5173']),
    cookieName: 'cmhub_warehouse_session',
    sessionLifetimeHours: asIntegerRange('WAREHOUSE_SESSION_HOURS', 8, 1, 8),
  },
  outboundWebhooks: {
    enabled: outboundWebhookEnabled,
    masterKeys: outboundWebhookMasterKeys,
    encryptionKeyVersion: outboundWebhookKeyVersion,
    pollIntervalMs: asIntegerRange('OUTBOUND_WEBHOOK_POLL_INTERVAL_MS', 5000, 1000, 60000),
    batchSize: asIntegerRange('OUTBOUND_WEBHOOK_BATCH_SIZE', 20, 1, 100),
    leaseSeconds: outboundWebhookLeaseSeconds,
    timeoutMs: outboundWebhookTimeoutMs,
    maxAttempts: asIntegerRange('OUTBOUND_WEBHOOK_MAX_ATTEMPTS', 12, 1, 100),
  },
};
