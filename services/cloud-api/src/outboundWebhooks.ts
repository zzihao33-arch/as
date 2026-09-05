import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import { lookup } from 'node:dns/promises';
import { request as requestHttp } from 'node:http';
import { request as requestHttps } from 'node:https';
import type { Pool, PoolConnection } from 'mysql2/promise';
import type { RowDataPacket } from 'mysql2';
import { ApiError } from './errors.js';
import type { WarehousePrintOutcome } from './warehouseOperations.js';
import type { WarehouseSession } from './warehouseIdentity.js';

export type WebhookDeliveryStatus =
  | 'WAITING_CONFIGURATION' | 'PENDING' | 'DELIVERING' | 'RETRY_SCHEDULED' | 'DELIVERED' | 'DEAD_LETTER';
export type WebhookAttemptOutcome = 'IN_PROGRESS' | 'DELIVERED' | 'RETRY' | 'DEAD_LETTER';

export type EncryptedSecret = { ciphertext: Buffer; iv: Buffer; authTag: Buffer };
export type WebhookTransportResponse = { status: number; retryAfter: string | null; body: string };
export type WebhookTransport = {
  send(input: { url: string; headers: Record<string, string>; body: string; timeoutMs: number }): Promise<WebhookTransportResponse>;
};

export type OutboundWebhookOptions = {
  enabled: boolean;
  masterKeys: ReadonlyMap<string, Buffer>;
  encryptionKeyVersion: string;
  environment: string;
  pollIntervalMs: number;
  batchSize: number;
  leaseSeconds: number;
  timeoutMs: number;
  maxAttempts: number;
};

type EndpointRow = RowDataPacket & {
  id: string;
  client_id: string;
  callback_url: string;
  secret_ciphertext: Buffer;
  secret_iv: Buffer;
  secret_auth_tag: Buffer;
  encryption_key_version: string;
};
type DueEventRow = RowDataPacket & EndpointRow & {
  event_id: string;
  payload_body: string;
  payload_sha256: string;
  replay_count: number;
  attempt_count: number;
};
type ClaimedDelivery = DueEventRow & {
  attemptId: string;
  leaseToken: string;
  requestTimestamp: number;
  attemptNumber: number;
};
type EventAccessRow = RowDataPacket & { id: string; client_id: string; delivery_status: WebhookDeliveryStatus };
type ActiveEndpointRow = RowDataPacket & { id: string };
type ListedEventRow = RowDataPacket & {
  id: string;
  client_code: string;
  shipment_id: string;
  source_print_attempt_id: string;
  event_type: string;
  delivery_status: WebhookDeliveryStatus;
  replay_count: number;
  attempt_count: number;
  last_attempt_at: Date | null;
  last_http_status: number | null;
  last_error_code: string | null;
  last_error_message: string | null;
  delivered_at: Date | null;
  created_at: Date;
};
type ListedAttemptRow = RowDataPacket & {
  id: string;
  replay_number: number;
  attempt_number: number;
  request_timestamp: string | number;
  http_status: number | null;
  outcome: WebhookAttemptOutcome;
  error_code: string | null;
  response_excerpt: string | null;
  started_at: Date;
  completed_at: Date | null;
};
type EncryptionCheckRow = RowDataPacket & {
  id: string;
  client_id: string;
  secret_ciphertext: Buffer;
  secret_iv: Buffer;
  secret_auth_tag: Buffer;
  encryption_key_version: string;
};

const DELIVERY_STATUSES = new Set<WebhookDeliveryStatus>([
  'WAITING_CONFIGURATION', 'PENDING', 'DELIVERING', 'RETRY_SCHEDULED', 'DELIVERED', 'DEAD_LETTER',
]);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

class WebhookDeliveryError extends Error {
  constructor(readonly code: string, readonly retryable: boolean, message: string) {
    super(message);
  }
}

function secretAad(clientId: string, keyVersion: string): Buffer {
  return Buffer.from(`cmhub-callback-secret\0${clientId}\0${keyVersion}\0HMAC_SHA256_V1`, 'utf8');
}

export function encryptWebhookSecret(secret: string, masterKey: Buffer, clientId: string, keyVersion: string): EncryptedSecret {
  if (masterKey.length !== 32) throw new Error('Webhook master key must contain exactly 32 bytes.');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', masterKey, iv);
  cipher.setAAD(secretAad(clientId, keyVersion));
  const ciphertext = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
  return { ciphertext, iv, authTag: cipher.getAuthTag() };
}

export function decryptWebhookSecret(encrypted: EncryptedSecret, masterKey: Buffer, clientId: string, keyVersion: string): string {
  if (masterKey.length !== 32) throw new Error('Webhook master key must contain exactly 32 bytes.');
  const decipher = createDecipheriv('aes-256-gcm', masterKey, encrypted.iv);
  decipher.setAAD(secretAad(clientId, keyVersion));
  decipher.setAuthTag(encrypted.authTag);
  return Buffer.concat([decipher.update(encrypted.ciphertext), decipher.final()]).toString('utf8');
}

export function signWebhookPayload(secret: string, timestamp: number, body: string): string {
  return `v1=${createHmac('sha256', secret).update(`${timestamp}.${body}`, 'utf8').digest('hex')}`;
}

function isPrivateIpv4(value: string): boolean {
  const parts = value.split('.').map(Number);
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  return parts[0] === 10 || parts[0] === 127 || parts[0] === 0 ||
    (parts[0] === 169 && parts[1] === 254) || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
    (parts[0] === 192 && parts[1] === 168) || parts[0] >= 224;
}

function isPrivateAddress(value: string): boolean {
  const address = unbracketHostname(value);
  const version = isIP(address);
  if (version === 4) return isPrivateIpv4(address);
  if (version === 6) {
    const normalized = address.toLowerCase();
    const mappedIpv4 = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1];
    if (mappedIpv4) return isPrivateIpv4(mappedIpv4);
    const mappedHex = normalized.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (mappedHex) {
      const high = Number.parseInt(mappedHex[1], 16);
      const low = Number.parseInt(mappedHex[2], 16);
      return isPrivateIpv4(`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`);
    }
    return normalized === '::' || normalized === '::1' || normalized.startsWith('fc') || normalized.startsWith('fd') ||
      normalized.startsWith('fe8') || normalized.startsWith('fe9') || normalized.startsWith('fea') || normalized.startsWith('feb');
  }
  return false;
}

function unbracketHostname(value: string): string {
  return value.startsWith('[') && value.endsWith(']') ? value.slice(1, -1) : value;
}

export function validateCallbackUrl(value: string, environment: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ApiError(400, 'INVALID_CALLBACK_URL', '回调地址必须是有效 URL');
  }
  if (url.username || url.password || url.hash || !url.hostname ||
      (environment === 'production' ? url.protocol !== 'https:' : !['http:', 'https:'].includes(url.protocol))) {
    throw new ApiError(400, 'INVALID_CALLBACK_URL', '生产回调必须使用无用户信息和片段的 HTTPS URL');
  }
  if (url.hostname === 'localhost' || isPrivateAddress(url.hostname)) {
    throw new ApiError(400, 'INVALID_CALLBACK_URL', '回调地址不能指向本机或私有网络');
  }
  return url;
}

async function resolvePublicDestination(url: URL, timeoutMs: number): Promise<{ address: string; family: 4 | 6 }> {
  let timer: NodeJS.Timeout | undefined;
  const addresses = await Promise.race([
    lookup(unbracketHostname(url.hostname), { all: true, verbatim: true }),
    new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('CALLBACK_DNS_TIMEOUT')), timeoutMs);
    }),
  ]).finally(() => { if (timer) clearTimeout(timer); });
  if (addresses.length === 0 || addresses.some(address => isPrivateAddress(address.address))) {
    throw new Error('CALLBACK_DESTINATION_NOT_PUBLIC');
  }
  return { address: addresses[0].address, family: addresses[0].family === 6 ? 6 : 4 };
}

export function createFetchWebhookTransport(): WebhookTransport {
  return {
    async send(input) {
      const startedAt = Date.now();
      const url = new URL(input.url);
      const destination = await resolvePublicDestination(url, input.timeoutMs);
      const tlsHostname = unbracketHostname(url.hostname);
      const remainingMs = input.timeoutMs - (Date.now() - startedAt);
      if (remainingMs <= 0) throw new Error('CALLBACK_TIMEOUT');
      return new Promise<WebhookTransportResponse>((resolve, reject) => {
        let completed = false;
        let deadline: NodeJS.Timeout;
        const succeed = (value: WebhookTransportResponse) => {
          if (completed) return;
          completed = true;
          clearTimeout(deadline);
          resolve(value);
        };
        const fail = (error: Error) => {
          if (completed) return;
          completed = true;
          clearTimeout(deadline);
          reject(error);
        };
        const request = (url.protocol === 'https:' ? requestHttps : requestHttp)(url, {
          method: 'POST',
          headers: { ...input.headers, 'Content-Length': String(Buffer.byteLength(input.body, 'utf8')) },
          lookup: (_hostname, _options, callback) => callback(null, destination.address, destination.family),
          servername: url.protocol === 'https:' && isIP(tlsHostname) === 0 ? tlsHostname : undefined,
        }, response => {
          const chunks: Buffer[] = [];
          let bytes = 0;
          let settled = false;
          const finishResponse = () => {
            if (settled) return;
            settled = true;
            const retryAfter = response.headers['retry-after'];
            succeed({
              status: response.statusCode ?? 0,
              retryAfter: Array.isArray(retryAfter) ? retryAfter[0] ?? null : retryAfter ?? null,
              body: Buffer.concat(chunks).toString('utf8'),
            });
          };
          response.on('data', (chunk: Buffer) => {
            if (bytes >= 1024) return;
            const remaining = 1024 - bytes;
            chunks.push(chunk.subarray(0, remaining));
            bytes += Math.min(chunk.length, remaining);
            if (bytes >= 1024) {
              finishResponse();
              response.destroy();
            }
          });
          response.once('end', finishResponse);
          response.once('error', error => { if (!settled) fail(error); });
          response.resume();
        });
        deadline = setTimeout(() => request.destroy(new Error('CALLBACK_TIMEOUT')), remainingMs);
        request.once('error', fail);
        request.end(input.body, 'utf8');
      });
    },
  };
}

export function classifyWebhookResponse(status: number): 'DELIVERED' | 'RETRY' | 'DEAD_LETTER' {
  if (status >= 200 && status < 300) return 'DELIVERED';
  if ([408, 425, 429].includes(status) || status >= 500) return 'RETRY';
  return 'DEAD_LETTER';
}

export function retryDelayMs(attemptNumber: number, retryAfter: string | null, random = Math.random): number {
  const exponential = Math.min(3_600_000, 30_000 * 2 ** Math.max(0, attemptNumber - 1));
  let requested = 0;
  if (retryAfter) {
    const seconds = Number(retryAfter);
    const date = Date.parse(retryAfter);
    requested = Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : Number.isNaN(date) ? 0 : Math.max(0, date - Date.now());
  }
  const jittered = Math.round(exponential * (0.8 + random() * 0.4));
  return Math.min(3_600_000, Math.max(1_000, requested, jittered));
}

function eventType(outcome: WarehousePrintOutcome): string {
  return `SHIPMENT_PRINT_${outcome}`;
}

function publicEventType(outcome: WarehousePrintOutcome): string {
  return `shipment.print.${outcome.toLowerCase()}`;
}

function excerpt(value: string): string | null {
  const clean = value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  return clean ? clean.slice(0, 1024) : null;
}

function responseAudit(value: string): string | null {
  if (!value) return null;
  return `sha256=${createHash('sha256').update(value, 'utf8').digest('hex')};capturedBytes=${Buffer.byteLength(value, 'utf8')}`;
}

function listLimit(value: unknown): number {
  if (value === undefined) return 100;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 200) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'limit 必须是 1 到 200 的整数');
  }
  return parsed;
}

export function createOutboundWebhooks(dependencies: {
  mysql: Pool;
  options: OutboundWebhookOptions;
  transport?: WebhookTransport;
}) {
  const { mysql, options } = dependencies;
  const transport = dependencies.transport ?? createFetchWebhookTransport();
  let timer: NodeJS.Timeout | null = null;
  let delivering = false;

  async function enqueuePrintAttempt(connection: PoolConnection, input: {
    clientId: string;
    shipmentId: string;
    printAttemptId: string;
    outcome: WarehousePrintOutcome;
    occurredAt: string;
    firstLegTrackingNo: string;
    courierTrackingNo: string | null;
    carrier: string | null;
    shipmentStatus: string;
    shipmentVersion: number;
    printerName: string | null;
    message: string | null;
    warehouseCode: string;
  }): Promise<string> {
    const id = randomUUID();
    const body = JSON.stringify({
      specVersion: '1.0',
      eventId: id,
      eventType: publicEventType(input.outcome),
      occurredAt: input.occurredAt,
      data: {
        shipment: {
          id: input.shipmentId,
          firstLegTrackingNo: input.firstLegTrackingNo,
          courierTrackingNo: input.courierTrackingNo,
          carrier: input.carrier,
          status: input.shipmentStatus,
          version: input.shipmentVersion,
        },
        printAttempt: {
          id: input.printAttemptId,
          outcome: input.outcome,
          printerName: input.printerName,
          message: input.message,
        },
        warehouse: { code: input.warehouseCode },
      },
    });
    await connection.execute(`SELECT id FROM clients WHERE id = ? LIMIT 1 FOR UPDATE`, [input.clientId]);
    const [endpoints] = await connection.execute<ActiveEndpointRow[]>(
      `SELECT id FROM client_callback_endpoints WHERE client_id = ? AND endpoint_status = 'ACTIVE' LIMIT 1 FOR UPDATE`,
      [input.clientId],
    );
    const endpointId = endpoints[0]?.id ?? null;
    await connection.execute(
      `INSERT INTO outbound_webhook_events
         (id, client_id, shipment_id, source_print_attempt_id, endpoint_id, event_type,
          payload_body, payload_sha256, delivery_status, next_attempt_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, input.clientId, input.shipmentId, input.printAttemptId, endpointId, eventType(input.outcome), body,
        createHash('sha256').update(body, 'utf8').digest('hex'), endpointId ? 'PENDING' : 'WAITING_CONFIGURATION',
        endpointId ? new Date() : null],
    );
    return id;
  }

  async function claimBatch(): Promise<ClaimedDelivery[]> {
    if (!options.enabled) return [];
    const connection = await mysql.getConnection();
    try {
      await connection.beginTransaction();
      const [rows] = await connection.query<DueEventRow[]>(
        `SELECT e.id AS event_id, e.payload_body, e.payload_sha256, e.replay_count, e.attempt_count,
                ep.id, ep.client_id, ep.callback_url, ep.secret_ciphertext, ep.secret_iv,
                ep.secret_auth_tag, ep.encryption_key_version
         FROM outbound_webhook_events e
         INNER JOIN client_callback_endpoints ep ON ep.id = e.endpoint_id AND ep.endpoint_status = 'ACTIVE'
         WHERE ((e.delivery_status IN ('PENDING', 'RETRY_SCHEDULED') AND e.next_attempt_at <= NOW(3))
             OR (e.delivery_status = 'DELIVERING' AND e.lease_expires_at <= NOW(3)))
         ORDER BY COALESCE(e.next_attempt_at, e.created_at), e.created_at
         LIMIT ${options.batchSize}
         FOR UPDATE SKIP LOCKED`,
      );
      const claims: ClaimedDelivery[] = [];
      for (const row of rows) {
        const leaseToken = randomUUID();
        const attemptId = randomUUID();
        const attemptNumber = Number(row.attempt_count) + 1;
        const requestTimestamp = Math.floor(Date.now() / 1000);
        await connection.execute(
          `UPDATE outbound_webhook_attempts
           SET outcome = 'RETRY', error_code = 'LEASE_EXPIRED', completed_at = NOW(3)
           WHERE event_id = ? AND outcome = 'IN_PROGRESS'`,
          [row.event_id],
        );
        await connection.execute(
          `UPDATE outbound_webhook_events
           SET delivery_status = 'DELIVERING', attempt_count = ?, lease_token = ?,
               lease_expires_at = DATE_ADD(NOW(3), INTERVAL ? SECOND), last_attempt_at = NOW(3)
           WHERE id = ?`,
          [attemptNumber, leaseToken, options.leaseSeconds, row.event_id],
        );
        await connection.execute(
          `INSERT INTO outbound_webhook_attempts
             (id, event_id, replay_number, attempt_number, lease_token, request_timestamp, request_sha256, outcome)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'IN_PROGRESS')`,
          [attemptId, row.event_id, row.replay_count, attemptNumber, leaseToken, requestTimestamp, row.payload_sha256],
        );
        claims.push({ ...row, attemptId, leaseToken, requestTimestamp, attemptNumber });
      }
      await connection.commit();
      return claims;
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  async function finish(claim: ClaimedDelivery, result: {
    classification: 'DELIVERED' | 'RETRY' | 'DEAD_LETTER';
    httpStatus: number | null;
    errorCode: string | null;
    responseAudit: string | null;
    errorMessage: string | null;
    retryAfter: string | null;
  }): Promise<void> {
    const exhausted = result.classification === 'RETRY' && claim.attemptNumber >= options.maxAttempts;
    const classification = exhausted ? 'DEAD_LETTER' : result.classification;
    const nextAttempt = classification === 'RETRY'
      ? new Date(Date.now() + retryDelayMs(claim.attemptNumber, result.retryAfter))
      : null;
    const connection = await mysql.getConnection();
    try {
      await connection.beginTransaction();
      await connection.execute(
        `UPDATE outbound_webhook_attempts
         SET http_status = ?, outcome = ?, error_code = ?, response_excerpt = ?, completed_at = NOW(3)
         WHERE id = ? AND lease_token = ? AND outcome = 'IN_PROGRESS'`,
        [result.httpStatus, classification, exhausted ? 'MAX_ATTEMPTS_EXHAUSTED' : result.errorCode,
          excerpt(result.responseAudit ?? ''), claim.attemptId, claim.leaseToken],
      );
      await connection.execute(
        `UPDATE outbound_webhook_events
         SET delivery_status = ?, next_attempt_at = ?, lease_token = NULL, lease_expires_at = NULL,
             last_http_status = ?, last_error_code = ?, last_error_message = ?,
             delivered_at = CASE WHEN ? = 'DELIVERED' THEN NOW(3) ELSE delivered_at END
         WHERE id = ? AND lease_token = ? AND delivery_status = 'DELIVERING'`,
        [classification === 'RETRY' ? 'RETRY_SCHEDULED' : classification, nextAttempt, result.httpStatus,
          exhausted ? 'MAX_ATTEMPTS_EXHAUSTED' : result.errorCode,
          exhausted ? 'Maximum delivery attempts exhausted.' : excerpt(result.errorMessage ?? ''),
          classification, claim.event_id, claim.leaseToken],
      );
      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  async function deliver(claim: ClaimedDelivery): Promise<void> {
    try {
      const url = validateCallbackUrl(claim.callback_url, options.environment);
      let secret: string;
      try {
        const masterKey = options.masterKeys.get(claim.encryption_key_version);
        if (!masterKey) {
          throw new WebhookDeliveryError('WEBHOOK_MASTER_KEY_VERSION_MISSING', false, 'Required callback master key version is not configured.');
        }
        secret = decryptWebhookSecret({
          ciphertext: claim.secret_ciphertext,
          iv: claim.secret_iv,
          authTag: claim.secret_auth_tag,
        }, masterKey, claim.client_id, claim.encryption_key_version);
      } catch (error) {
        if (error instanceof WebhookDeliveryError) throw error;
        throw new WebhookDeliveryError('WEBHOOK_SECRET_UNREADABLE', false, 'Callback signing secret cannot be decrypted.');
      }
      const response = await transport.send({
        url: url.toString(),
        timeoutMs: options.timeoutMs,
        body: claim.payload_body,
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'CM-HUB-Webhooks/1.0',
          'X-CMHUB-Event-ID': claim.event_id,
          'X-CMHUB-Timestamp': String(claim.requestTimestamp),
          'X-CMHUB-Signature': signWebhookPayload(secret, claim.requestTimestamp, claim.payload_body),
        },
      });
      const classification = classifyWebhookResponse(response.status);
      await finish(claim, {
        classification,
        httpStatus: response.status,
        errorCode: classification === 'DELIVERED' ? null : `HTTP_${response.status}`,
        responseAudit: responseAudit(response.body),
        errorMessage: classification === 'DELIVERED' ? null : `Upstream returned HTTP ${response.status}.`,
        retryAfter: response.retryAfter,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Webhook delivery failed.';
      const deliveryError = error instanceof WebhookDeliveryError ? error : null;
      const nonRetryable = deliveryError ? !deliveryError.retryable : error instanceof ApiError || message === 'CALLBACK_DESTINATION_NOT_PUBLIC';
      const errorCode = deliveryError?.code ?? (error instanceof ApiError
        ? error.code
        : message === 'CALLBACK_DESTINATION_NOT_PUBLIC' ? 'UNSAFE_CALLBACK_DESTINATION' : 'NETWORK_ERROR');
      await finish(claim, {
        classification: nonRetryable ? 'DEAD_LETTER' : 'RETRY',
        httpStatus: null,
        errorCode,
        responseAudit: null,
        errorMessage: deliveryError?.message ?? (nonRetryable ? 'Callback destination is not allowed.' : 'Callback transport failed.'),
        retryAfter: null,
      });
    }
  }

  async function deliverBatch(): Promise<number> {
    if (delivering) return 0;
    delivering = true;
    try {
      const claims = await claimBatch();
      await Promise.allSettled(claims.map(deliver));
      return claims.length;
    } finally {
      delivering = false;
    }
  }

  async function verifyConfiguration(): Promise<void> {
    if (!options.enabled) return;
    const [endpoints] = await mysql.query<EncryptionCheckRow[]>(
      `SELECT id, client_id, secret_ciphertext, secret_iv, secret_auth_tag, encryption_key_version
       FROM client_callback_endpoints WHERE endpoint_status = 'ACTIVE'`,
    );
    const missing = [...new Set(endpoints.map(row => row.encryption_key_version)
      .filter(version => !options.masterKeys.has(version)))];
    if (missing.length > 0) {
      throw new Error(`Missing outbound webhook master-key versions: ${missing.join(', ')}`);
    }
    let unreadable = 0;
    for (const endpoint of endpoints) {
      try {
        decryptWebhookSecret({
          ciphertext: endpoint.secret_ciphertext,
          iv: endpoint.secret_iv,
          authTag: endpoint.secret_auth_tag,
        }, options.masterKeys.get(endpoint.encryption_key_version)!, endpoint.client_id, endpoint.encryption_key_version);
      } catch {
        unreadable += 1;
      }
    }
    if (unreadable > 0) {
      throw new Error(`Unable to decrypt ${unreadable} active outbound webhook endpoint secret(s).`);
    }
  }

  async function start(): Promise<void> {
    if (!options.enabled || timer) return;
    await verifyConfiguration();
    const tick = () => void deliverBatch().catch(error => console.error('Outbound webhook delivery failed:', error));
    tick();
    timer = setInterval(tick, options.pollIntervalMs);
    timer.unref();
  }

  function stop(): void {
    if (timer) clearInterval(timer);
    timer = null;
  }

  async function listForWarehouse(_session: WarehouseSession, input: { status?: unknown; limit?: unknown }) {
    const status = input.status === undefined || input.status === '' ? null : String(input.status);
    if (status && !DELIVERY_STATUSES.has(status as WebhookDeliveryStatus)) {
      throw new ApiError(400, 'VALIDATION_ERROR', 'status 不受支持');
    }
    const limit = listLimit(input.limit);
    const [rows] = await mysql.query<ListedEventRow[]>(
      `SELECT e.id, c.client_code, e.shipment_id, e.source_print_attempt_id, e.event_type,
              e.delivery_status, e.replay_count, e.attempt_count, e.last_attempt_at,
              e.last_http_status, e.last_error_code, e.last_error_message, e.delivered_at, e.created_at
       FROM outbound_webhook_events e
       INNER JOIN clients c ON c.id = e.client_id
       WHERE (? IS NULL OR e.delivery_status = ?)
       ORDER BY e.created_at DESC
       LIMIT ${limit}`,
      [status, status],
    );
    return rows.map(row => ({
      id: row.id,
      clientCode: row.client_code,
      shipmentId: row.shipment_id,
      printAttemptId: row.source_print_attempt_id,
      eventType: row.event_type,
      status: row.delivery_status,
      replayCount: Number(row.replay_count),
      attemptCount: Number(row.attempt_count),
      lastAttemptAt: row.last_attempt_at?.toISOString() ?? null,
      lastHttpStatus: row.last_http_status,
      lastErrorCode: row.last_error_code,
      lastErrorMessage: row.last_error_message,
      deliveredAt: row.delivered_at?.toISOString() ?? null,
      createdAt: row.created_at.toISOString(),
    }));
  }

  async function listAttemptsForWarehouse(_session: WarehouseSession, eventIdValue: unknown) {
    const eventId = typeof eventIdValue === 'string' ? eventIdValue.trim() : '';
    if (!UUID_PATTERN.test(eventId)) throw new ApiError(400, 'VALIDATION_ERROR', 'eventId 必须是 UUID');
    const [access] = await mysql.execute<EventAccessRow[]>(
      `SELECT e.id, e.client_id, e.delivery_status
       FROM outbound_webhook_events e
       WHERE e.id = ? LIMIT 1`,
      [eventId],
    );
    if (!access[0]) throw new ApiError(404, 'WEBHOOK_EVENT_NOT_FOUND', '未找到可访问的回调事件');
    const [rows] = await mysql.execute<ListedAttemptRow[]>(
      `SELECT id, replay_number, attempt_number, request_timestamp, http_status, outcome,
              error_code, response_excerpt, started_at, completed_at
       FROM outbound_webhook_attempts WHERE event_id = ?
       ORDER BY replay_number DESC, attempt_number DESC`,
      [eventId],
    );
    return rows.map(row => ({
      id: row.id,
      replayNumber: Number(row.replay_number),
      attemptNumber: Number(row.attempt_number),
      requestTimestamp: String(row.request_timestamp),
      httpStatus: row.http_status,
      outcome: row.outcome,
      errorCode: row.error_code,
      responseExcerpt: row.response_excerpt,
      startedAt: row.started_at.toISOString(),
      completedAt: row.completed_at?.toISOString() ?? null,
    }));
  }

  async function retryForWarehouse(session: WarehouseSession, eventIdValue: unknown) {
    const eventId = typeof eventIdValue === 'string' ? eventIdValue.trim() : '';
    if (!UUID_PATTERN.test(eventId)) throw new ApiError(400, 'VALIDATION_ERROR', 'eventId 必须是 UUID');
    const connection = await mysql.getConnection();
    try {
      await connection.beginTransaction();
      const [events] = await connection.execute<EventAccessRow[]>(
        `SELECT e.id, e.client_id, e.delivery_status
         FROM outbound_webhook_events e
         WHERE e.id = ? FOR UPDATE`,
        [eventId],
      );
      const event = events[0];
      if (!event) throw new ApiError(404, 'WEBHOOK_EVENT_NOT_FOUND', '未找到可访问的回调事件');
      if (event.delivery_status !== 'DEAD_LETTER') {
        throw new ApiError(409, 'WEBHOOK_NOT_DEAD_LETTER', '只有死信事件可以人工重放');
      }
      const [endpoints] = await connection.execute<ActiveEndpointRow[]>(
        `SELECT id FROM client_callback_endpoints WHERE client_id = ? AND endpoint_status = 'ACTIVE' LIMIT 1`,
        [event.client_id],
      );
      const endpointId = endpoints[0]?.id ?? null;
      const nextStatus = endpointId ? 'PENDING' : 'WAITING_CONFIGURATION';
      await connection.execute(
        `UPDATE outbound_webhook_events
         SET endpoint_id = ?, delivery_status = ?, replay_count = replay_count + 1, attempt_count = 0,
             next_attempt_at = ?, lease_token = NULL, lease_expires_at = NULL,
             last_http_status = NULL, last_error_code = NULL, last_error_message = NULL
         WHERE id = ?`,
        [endpointId, nextStatus, endpointId ? new Date() : null, eventId],
      );
      await connection.execute(
        `INSERT INTO shipment_events
           (id, client_id, shipment_id, request_id, event_type, actor_type, actor_id, event_data)
         SELECT ?, client_id, shipment_id, ?, 'WEBHOOK_REQUEUED', 'WAREHOUSE_USER', ?, ?
         FROM outbound_webhook_events WHERE id = ?`,
        [randomUUID(), eventId, session.userId, JSON.stringify({ warehouseId: session.warehouseId }), eventId],
      );
      await connection.commit();
      return { id: eventId, status: nextStatus };
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  return { enqueuePrintAttempt, deliverBatch, listForWarehouse, listAttemptsForWarehouse, retryForWarehouse, verifyConfiguration, start, stop };
}

export type OutboundWebhooks = ReturnType<typeof createOutboundWebhooks>;
