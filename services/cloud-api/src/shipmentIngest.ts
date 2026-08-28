import { createHash, randomUUID } from 'node:crypto';
import type { RowDataPacket } from 'mysql2';
import type { Pool, PoolConnection } from 'mysql2/promise';
import type { Redis } from 'ioredis';
import type { AuthenticatedClient } from './auth.js';
import { ApiError } from './errors.js';
import { parseShipmentUpsert } from './shipmentInput.js';
import { toShipment, type ShipmentRow } from './shipmentRecord.js';

const operation = 'shipments.upsert';
const lockSeconds = 120;

type InboundMessageRow = RowDataPacket & {
  payload_sha256: string;
  processing_status: 'PROCESSING' | 'COMPLETED';
  response_status: number | null;
  response_body: string | Record<string, unknown> | null;
};

export type ShipmentIngestRequest = {
  client: AuthenticatedClient;
  requestId: string;
  idempotencyKey: string | undefined;
  body: unknown;
};

export type ShipmentIngestResult = {
  status: number;
  body: Record<string, unknown>;
};

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(',')}}`;
}

export function hashInboundPayload(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}

function validateIdempotencyKey(value: string | undefined): string {
  const key = value?.trim();
  if (!key || !/^[a-zA-Z0-9_-]{8,128}$/.test(key)) {
    throw new ApiError(400, 'IDEMPOTENCY_KEY_REQUIRED', '请求必须包含 8–128 位 Idempotency-Key。');
  }
  return key;
}

function parseResponseBody(value: InboundMessageRow['response_body']): Record<string, unknown> | undefined {
  if (value === null) return undefined;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value) as unknown;
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : undefined;
    } catch {
      return undefined;
    }
  }
  return value;
}

function replayFrom(row: InboundMessageRow | undefined, payloadHash: string): ShipmentIngestResult | undefined {
  if (!row) return undefined;
  if (row.payload_sha256 !== payloadHash) {
    throw new ApiError(409, 'IDEMPOTENCY_CONFLICT', '该 Idempotency-Key 已用于不同的请求内容。');
  }
  if (row.processing_status !== 'COMPLETED') {
    throw new ApiError(409, 'REQUEST_IN_PROGRESS', '相同请求正在处理中。');
  }
  const responseBody = parseResponseBody(row.response_body);
  if (!row.response_status || !responseBody) {
    throw new ApiError(500, 'IDEMPOTENCY_RECORD_INVALID', '历史幂等记录不完整，请联系 CM-HUB。');
  }
  return {
    status: row.response_status,
    body: { ...responseBody, idempotentReplay: true },
  };
}

async function findInboundMessage(pool: Pool, clientId: string, key: string): Promise<InboundMessageRow | undefined> {
  const [rows] = await pool.execute<InboundMessageRow[]>(
    `SELECT payload_sha256, processing_status, response_status, response_body
     FROM inbound_messages
     WHERE client_id = ? AND operation = ? AND idempotency_key = ?
     LIMIT 1`,
    [clientId, operation, key],
  );
  return rows[0];
}

async function writeShipmentEvent(connection: PoolConnection, input: {
  clientId: string;
  apiKeyId: string;
  shipmentId: string;
  requestId: string;
  eventData: Record<string, unknown>;
}): Promise<void> {
  await connection.execute(
    `INSERT INTO shipment_events
     (id, client_id, shipment_id, request_id, event_type, actor_type, actor_id, event_data)
     VALUES (?, ?, ?, ?, 'SHIPMENT_UPSERTED', 'UPSTREAM_API_KEY', ?, ?)`,
    [
      randomUUID(), input.clientId, input.shipmentId, input.requestId,
      input.apiKeyId, JSON.stringify(input.eventData),
    ],
  );
}

async function releaseLock(redis: Redis, key: string, token: string): Promise<void> {
  await redis.eval(
    `if redis.call('get', KEYS[1]) == ARGV[1] then
       return redis.call('del', KEYS[1])
     end
     return 0`,
    1,
    key,
    token,
  );
}

export function createShipmentIngestor(dependencies: { mysql: Pool; redis: Redis }) {
  return {
    async ingest(request: ShipmentIngestRequest): Promise<ShipmentIngestResult> {
      const idempotencyKey = validateIdempotencyKey(request.idempotencyKey);
      const input = parseShipmentUpsert(request.body);
      const payloadHash = hashInboundPayload(input.rawData);

      const existing = replayFrom(
        await findInboundMessage(dependencies.mysql, request.client.id, idempotencyKey),
        payloadHash,
      );
      if (existing) return existing;

      const lockKey = `cmhub:ingest-lock:${request.client.id}:${operation}:${idempotencyKey}`;
      const lockToken = randomUUID();
      let locked: string | null;
      try {
        locked = await dependencies.redis.set(lockKey, lockToken, 'EX', lockSeconds, 'NX');
      } catch {
        throw new ApiError(503, 'IDEMPOTENCY_UNAVAILABLE', '去重服务暂时不可用，请稍后重试。');
      }
      if (locked !== 'OK') throw new ApiError(409, 'REQUEST_IN_PROGRESS', '相同请求正在处理中。');

      try {
        const replayAfterLock = replayFrom(
          await findInboundMessage(dependencies.mysql, request.client.id, idempotencyKey),
          payloadHash,
        );
        if (replayAfterLock) return replayAfterLock;

        const inboundMessageId = randomUUID();
        const proposedShipmentId = randomUUID();
        const connection = await dependencies.mysql.getConnection();
        try {
          await connection.beginTransaction();
          await connection.execute(
            `INSERT INTO inbound_messages
             (id, client_id, api_key_id, request_id, operation, idempotency_key, payload_sha256, raw_data)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              inboundMessageId,
              request.client.id,
              request.client.apiKeyId,
              request.requestId,
              operation,
              idempotencyKey,
              payloadHash,
              JSON.stringify(input.rawData),
            ],
          );
          await connection.execute(
            `INSERT INTO shipments
             (id, client_id, order_id, first_leg_tracking_no, courier_tracking_no, carrier, label_url, label_sha256,
              recipient_name, recipient_phone, recipient_address, items, raw_data, status, attributes)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'RECEIVED', ?)
             ON DUPLICATE KEY UPDATE
               order_id = COALESCE(VALUES(order_id), order_id),
               courier_tracking_no = COALESCE(VALUES(courier_tracking_no), courier_tracking_no),
               carrier = COALESCE(VALUES(carrier), carrier),
               label_url = COALESCE(VALUES(label_url), label_url),
               current_label_asset_id = CASE
                 WHEN VALUES(label_sha256) IS NOT NULL AND NOT (VALUES(label_sha256) <=> label_sha256) THEN NULL
                 ELSE current_label_asset_id
               END,
               status = CASE
                 WHEN status = 'READY_TO_PRINT'
                   AND VALUES(label_sha256) IS NOT NULL
                   AND NOT (VALUES(label_sha256) <=> label_sha256)
                 THEN 'RECEIVED'
                 ELSE status
               END,
               label_sha256 = COALESCE(VALUES(label_sha256), label_sha256),
               recipient_name = COALESCE(VALUES(recipient_name), recipient_name),
               recipient_phone = COALESCE(VALUES(recipient_phone), recipient_phone),
               recipient_address = COALESCE(VALUES(recipient_address), recipient_address),
               items = COALESCE(VALUES(items), items),
               raw_data = VALUES(raw_data),
               attributes = COALESCE(VALUES(attributes), attributes),
               version = version + 1`,
            [
              proposedShipmentId,
              request.client.id,
              input.order?.orderId ?? null,
              input.firstLegTrackingNo,
              input.courierTrackingNo ?? null,
              input.carrier ?? null,
              input.labelUrl ?? null,
              input.labelSha256 ?? null,
              input.order?.recipientName ?? null,
              input.order?.phone ?? null,
              input.order?.address !== undefined ? JSON.stringify(input.order.address) : null,
              input.order?.items !== undefined ? JSON.stringify(input.order.items) : null,
              JSON.stringify(input.rawData),
              input.attributes ? JSON.stringify(input.attributes) : null,
            ],
          );

          const [rows] = await connection.execute<ShipmentRow[]>(
            `SELECT * FROM shipments WHERE client_id = ? AND first_leg_tracking_no = ? LIMIT 1`,
            [request.client.id, input.firstLegTrackingNo],
          );
          if (!rows[0]) throw new Error('Shipment was not found after upsert.');
          const shipment = toShipment(rows[0]);
          const responseBody = { data: shipment, requestId: request.requestId };

          await writeShipmentEvent(connection, {
            clientId: request.client.id,
            apiKeyId: request.client.apiKeyId,
            shipmentId: shipment.id,
            requestId: request.requestId,
            eventData: {
              idempotencyKey,
              version: shipment.version,
              rawDataCaptured: true,
              orderId: input.order?.orderId,
            },
          });
          await connection.execute(
            `INSERT INTO shipment_delivery_changes (client_id, shipment_id, change_type)
             VALUES (?, ?, 'SHIPMENT_UPSERTED')`,
            [request.client.id, shipment.id],
          );
          await connection.execute(
            `UPDATE inbound_messages
             SET shipment_id = ?, processing_status = 'COMPLETED', response_status = 200,
                 response_body = ?, completed_at = CURRENT_TIMESTAMP(3)
             WHERE id = ?`,
            [shipment.id, JSON.stringify(responseBody), inboundMessageId],
          );
          await connection.commit();
          return { status: 200, body: responseBody };
        } catch (error) {
          await connection.rollback().catch(() => undefined);
          throw error;
        } finally {
          connection.release();
        }
      } finally {
        await releaseLock(dependencies.redis, lockKey, lockToken).catch((error) => {
          console.error('Failed to release shipment ingest lock.', { requestId: request.requestId, error });
        });
      }
    },
  };
}
