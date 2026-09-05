import { randomUUID } from 'node:crypto';
import type { RowDataPacket } from 'mysql2';
import type { Pool, PoolConnection } from 'mysql2/promise';
import type { Redis } from 'ioredis';
import type { AuthenticatedClient } from './auth.js';
import { ApiError } from './errors.js';
import { normalizeAirBillNo } from './airPickupOperations.js';
import { hashInboundPayload } from './shipmentIngest.js';
import { parseShipmentUpsert, type ShipmentUpsertInput } from './shipmentInput.js';

const OPERATION = 'inbound-batches.upsert';
const MAX_SHIPMENTS = 5_000;
const LOCK_SECONDS = 300;

type WeightUnit = 'KG' | 'LB';
type RequestAudit = { requestId: string; ip: string };

type InboundMessageRow = RowDataPacket & {
  payload_sha256: string;
  processing_status: 'PROCESSING' | 'COMPLETED';
  response_status: number | null;
  response_body: string | Record<string, unknown> | null;
};

type ExistingAirPickupRow = RowDataPacket & {
  id: string;
  client_id: string | null;
  customer_profile_id: string | null;
  source_type: 'MANUAL' | 'UPSTREAM';
  external_batch_id: string | null;
  order_status: 'RECORDED' | 'RECEIVED' | 'HANDED_OVER' | 'VOIDED';
};

type ExistingShipmentRow = RowDataPacket & {
  id: string;
  air_pickup_order_id: string | null;
};

export type InboundBatchRequest = {
  client: AuthenticatedClient;
  requestId: string;
  idempotencyKey: string | undefined;
  ip: string;
  body: unknown;
};

function requiredObject(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ApiError(400, 'VALIDATION_ERROR', `${field} 必须是对象`);
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, field: string, maxLength: number, required = true): string | null {
  if (value === undefined || value === null || value === '') {
    if (required) throw new ApiError(400, 'VALIDATION_ERROR', `${field} 为必填项`);
    return null;
  }
  if (typeof value !== 'string') throw new ApiError(400, 'VALIDATION_ERROR', `${field} 必须是字符串`);
  const result = value.trim();
  if (!result || result.length > maxLength) throw new ApiError(400, 'VALIDATION_ERROR', `${field} 长度无效`);
  return result;
}

function positiveInteger(value: unknown, field: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 999_999) {
    throw new ApiError(400, 'VALIDATION_ERROR', `${field} 必须是 1 到 999999 的整数`);
  }
  return parsed;
}

function positiveWeight(value: unknown, field: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 99_999_999_999.999) {
    throw new ApiError(400, 'VALIDATION_ERROR', `${field} 必须大于 0`);
  }
  return Math.round(parsed * 1000) / 1000;
}

function weightUnit(value: unknown): WeightUnit {
  const parsed = text(value, 'airPickup.forecastWeightUnit', 2)!.toUpperCase();
  if (parsed !== 'KG' && parsed !== 'LB') throw new ApiError(400, 'VALIDATION_ERROR', '重量单位仅支持 KG 或 LB');
  return parsed;
}

function idempotencyKey(value: string | undefined): string {
  const parsed = value?.trim();
  if (!parsed || !/^[a-zA-Z0-9_-]{8,128}$/.test(parsed)) {
    throw new ApiError(400, 'IDEMPOTENCY_KEY_REQUIRED', '请求必须包含 8–128 位 Idempotency-Key');
  }
  return parsed;
}

function parseResponse(value: InboundMessageRow['response_body']): Record<string, unknown> | null {
  if (!value) return null;
  if (typeof value !== 'string') return value;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

export function parseInboundBatchInput(bodyValue: unknown) {
  const body = requiredObject(bodyValue, '请求体');
  const externalBatchId = text(body.batchId, 'batchId', 128)!;
  const air = requiredObject(body.airPickup, 'airPickup');
  const bill = normalizeAirBillNo(air.billNo);
  const shipmentsValue = body.shipments;
  if (!Array.isArray(shipmentsValue) || shipmentsValue.length < 1 || shipmentsValue.length > MAX_SHIPMENTS) {
    throw new ApiError(400, 'VALIDATION_ERROR', `shipments 每批需包含 1 到 ${MAX_SHIPMENTS} 条`);
  }
  const shipments = shipmentsValue.map((value, index) => {
    try { return parseShipmentUpsert(value); }
    catch (error) {
      if (error instanceof ApiError) throw new ApiError(error.status, error.code, `shipments[${index}]：${error.message}`);
      throw error;
    }
  });
  const normalizedFirstLegs = shipments.map(item => item.firstLegTrackingNo.trim().toUpperCase());
  if (new Set(normalizedFirstLegs).size !== normalizedFirstLegs.length) {
    throw new ApiError(400, 'DUPLICATE_SHIPMENT', '同一批次不能包含重复的头程单号');
  }
  return {
    body,
    externalBatchId,
    bill,
    cargoName: text(air.cargoName, 'airPickup.cargoName', 100, false),
    forecastCartons: positiveInteger(air.forecastCartons, 'airPickup.forecastCartons'),
    forecastPackages: positiveInteger(air.forecastPackages, 'airPickup.forecastPackages'),
    forecastWeight: positiveWeight(air.forecastWeight, 'airPickup.forecastWeight'),
    forecastWeightUnit: weightUnit(air.forecastWeightUnit),
    remarks: text(air.remarks, 'airPickup.remarks', 200, false),
    shipments,
  };
}

async function releaseLock(redis: Redis, key: string, token: string): Promise<void> {
  await redis.eval(
    `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) end return 0`,
    1,
    key,
    token,
  );
}

async function findMessage(mysql: Pool, clientId: string, key: string): Promise<InboundMessageRow | undefined> {
  const [rows] = await mysql.execute<InboundMessageRow[]>(
    `SELECT payload_sha256, processing_status, response_status, response_body
     FROM inbound_messages WHERE client_id = ? AND operation = ? AND idempotency_key = ? LIMIT 1`,
    [clientId, OPERATION, key],
  );
  return rows[0];
}

function replay(row: InboundMessageRow | undefined, payloadHash: string) {
  if (!row) return null;
  if (row.payload_sha256 !== payloadHash) throw new ApiError(409, 'IDEMPOTENCY_CONFLICT', '该 Idempotency-Key 已用于不同的请求内容');
  if (row.processing_status !== 'COMPLETED') throw new ApiError(409, 'REQUEST_IN_PROGRESS', '相同请求正在处理中');
  const body = parseResponse(row.response_body);
  if (!row.response_status || !body) throw new ApiError(500, 'IDEMPOTENCY_RECORD_INVALID', '历史幂等记录不完整');
  return { status: row.response_status, body: { ...body, idempotentReplay: true } };
}

async function upsertShipment(connection: PoolConnection, input: {
  client: AuthenticatedClient;
  airPickupOrderId: string;
  shipment: ShipmentUpsertInput;
  requestId: string;
}): Promise<string> {
  const [existingRows] = await connection.execute<ExistingShipmentRow[]>(
    `SELECT id, air_pickup_order_id FROM shipments
     WHERE client_id = ? AND first_leg_tracking_no = ? LIMIT 1 FOR UPDATE`,
    [input.client.id, input.shipment.firstLegTrackingNo],
  );
  const existing = existingRows[0];
  if (existing?.air_pickup_order_id && existing.air_pickup_order_id !== input.airPickupOrderId) {
    throw new ApiError(409, 'SHIPMENT_ALREADY_BOUND', `头程单号 ${input.shipment.firstLegTrackingNo} 已属于其他提货单`);
  }
  const shipmentId = existing?.id ?? randomUUID();
  const order = input.shipment.order;
  await connection.execute(
    `INSERT INTO shipments
      (id, client_id, air_pickup_order_id, order_id, first_leg_tracking_no, courier_tracking_no,
       carrier, label_url, label_sha256, recipient_name, recipient_phone, recipient_address,
       items, raw_data, status, attributes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'RECEIVED', ?)
     ON DUPLICATE KEY UPDATE
       air_pickup_order_id = VALUES(air_pickup_order_id),
       order_id = COALESCE(VALUES(order_id), order_id),
       courier_tracking_no = COALESCE(VALUES(courier_tracking_no), courier_tracking_no),
       carrier = COALESCE(VALUES(carrier), carrier),
       label_url = COALESCE(VALUES(label_url), label_url),
       current_label_asset_id = CASE
         WHEN VALUES(label_sha256) IS NOT NULL AND NOT (VALUES(label_sha256) <=> label_sha256) THEN NULL
         ELSE current_label_asset_id END,
       status = CASE
         WHEN status = 'READY_TO_PRINT' AND VALUES(label_sha256) IS NOT NULL
          AND NOT (VALUES(label_sha256) <=> label_sha256) THEN 'RECEIVED' ELSE status END,
       label_sha256 = COALESCE(VALUES(label_sha256), label_sha256),
       recipient_name = COALESCE(VALUES(recipient_name), recipient_name),
       recipient_phone = COALESCE(VALUES(recipient_phone), recipient_phone),
       recipient_address = COALESCE(VALUES(recipient_address), recipient_address),
       items = COALESCE(VALUES(items), items), raw_data = VALUES(raw_data),
       attributes = COALESCE(VALUES(attributes), attributes), version = version + 1`,
    [
      shipmentId, input.client.id, input.airPickupOrderId, order?.orderId ?? null,
      input.shipment.firstLegTrackingNo, input.shipment.courierTrackingNo ?? null,
      input.shipment.carrier ?? null, input.shipment.labelUrl ?? null, input.shipment.labelSha256 ?? null,
      order?.recipientName ?? null, order?.phone ?? null,
      order?.address !== undefined ? JSON.stringify(order.address) : null,
      order?.items !== undefined ? JSON.stringify(order.items) : null,
      JSON.stringify(input.shipment.rawData),
      input.shipment.attributes ? JSON.stringify(input.shipment.attributes) : null,
    ],
  );
  await connection.execute(
    `INSERT INTO shipment_events
      (id, client_id, shipment_id, request_id, event_type, actor_type, actor_id, event_data)
     VALUES (?, ?, ?, ?, 'SHIPMENT_UPSERTED', 'UPSTREAM_API_KEY', ?, ?)`,
    [randomUUID(), input.client.id, shipmentId, input.requestId, input.client.apiKeyId,
      JSON.stringify({ airPickupOrderId: input.airPickupOrderId, rawDataCaptured: true })],
  );
  await connection.execute(
    `INSERT INTO shipment_delivery_changes (client_id, shipment_id, change_type)
     VALUES (?, ?, 'SHIPMENT_UPSERTED')`,
    [input.client.id, shipmentId],
  );
  return shipmentId;
}

export function createInboundBatchIngestor(dependencies: { mysql: Pool; redis: Redis }) {
  return {
    async ingest(request: InboundBatchRequest) {
      const key = idempotencyKey(request.idempotencyKey);
      const input = parseInboundBatchInput(request.body);
      const payloadHash = hashInboundPayload(input.body);
      const existing = replay(await findMessage(dependencies.mysql, request.client.id, key), payloadHash);
      if (existing) return existing;

      const lockKey = `cmhub:ingest-lock:${request.client.id}:${OPERATION}:${key}`;
      const lockToken = randomUUID();
      let locked: string | null;
      try { locked = await dependencies.redis.set(lockKey, lockToken, 'EX', LOCK_SECONDS, 'NX'); }
      catch { throw new ApiError(503, 'IDEMPOTENCY_UNAVAILABLE', '去重服务暂时不可用，请稍后重试'); }
      if (locked !== 'OK') throw new ApiError(409, 'REQUEST_IN_PROGRESS', '相同请求正在处理中');

      try {
        const replayAfterLock = replay(await findMessage(dependencies.mysql, request.client.id, key), payloadHash);
        if (replayAfterLock) return replayAfterLock;
        const connection = await dependencies.mysql.getConnection();
        const messageId = randomUUID();
        try {
          await connection.beginTransaction();
          const [clients] = await connection.execute<(RowDataPacket & { display_name: string; customer_profile_id: string; customer_name: string; customer_type: 'UPSTREAM' })[]>(
            `SELECT c.display_name, p.id AS customer_profile_id, p.display_name AS customer_name, p.customer_type
             FROM clients c INNER JOIN customer_profiles p ON p.integration_client_id = c.id
             WHERE c.id = ? AND c.client_status = 'ACTIVE' AND p.customer_status = 'ACTIVE'
             LIMIT 1 FOR UPDATE`,
            [request.client.id],
          );
          if (!clients[0]) throw new ApiError(403, 'CLIENT_DISABLED', '客户未启用或未关联上游客户档案');
          await connection.execute(
            `INSERT INTO inbound_messages
              (id, client_id, api_key_id, request_id, operation, idempotency_key, payload_sha256, raw_data)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [messageId, request.client.id, request.client.apiKeyId, request.requestId, OPERATION, key, payloadHash, JSON.stringify(input.body)],
          );

          const [airRows] = await connection.execute<ExistingAirPickupRow[]>(
            `SELECT id, client_id, customer_profile_id, source_type, external_batch_id, order_status FROM air_pickup_orders
             WHERE bill_no_normalized = ? LIMIT 1 FOR UPDATE`,
            [input.bill.normalized],
          );
          let airPickupOrderId = airRows[0]?.id;
          const existingAir = airRows[0];
          if (existingAir?.client_id && existingAir.client_id !== request.client.id) {
            throw new ApiError(409, 'AIR_PICKUP_CLIENT_CONFLICT', '该提货单号已归属于其他客户');
          }
          if (existingAir?.customer_profile_id && existingAir.customer_profile_id !== clients[0].customer_profile_id) {
            throw new ApiError(409, 'AIR_PICKUP_CUSTOMER_CONFLICT', '该提货单号已归属于其他客户档案');
          }
          if (existingAir?.external_batch_id && existingAir.external_batch_id !== input.externalBatchId) {
            throw new ApiError(409, 'AIR_PICKUP_BATCH_CONFLICT', '该提货单号已绑定其他客户批次');
          }
          if (!airPickupOrderId) {
            airPickupOrderId = randomUUID();
            await connection.execute(
              `INSERT INTO air_pickup_orders
                (id, client_id, client_name_snapshot, customer_profile_id, customer_name_snapshot, customer_type_snapshot, source_type, external_batch_id, raw_data,
                 bill_no_raw, bill_no_display, bill_no_normalized, bill_no_is_standard, cargo_name,
                 forecast_cartons, forecast_packages, forecast_weight, forecast_weight_unit, remarks,
                 created_by_user_id, created_by_reference, updated_by_user_id, updated_by_reference)
               VALUES (?, ?, ?, ?, ?, ?, 'UPSTREAM', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, NULL, ?)`,
              [airPickupOrderId, request.client.id, clients[0].display_name, clients[0].customer_profile_id, clients[0].customer_name, clients[0].customer_type, input.externalBatchId,
                JSON.stringify(input.body), input.bill.raw, input.bill.display, input.bill.normalized,
                input.bill.isStandard, input.cargoName, input.forecastCartons, input.forecastPackages,
                input.forecastWeight, input.forecastWeightUnit, input.remarks,
                `client:${request.client.id}`, `client:${request.client.id}`],
            );
          } else {
            await connection.execute(
              `UPDATE air_pickup_orders SET client_id = CASE WHEN source_type = 'MANUAL' THEN client_id ELSE ? END,
                 client_name_snapshot = CASE WHEN source_type = 'MANUAL' THEN client_name_snapshot ELSE ? END,
                 customer_profile_id = ?, customer_name_snapshot = ?, customer_type_snapshot = ?,
                 source_type = CASE WHEN source_type = 'MANUAL' THEN source_type ELSE 'UPSTREAM' END,
                 external_batch_id = COALESCE(external_batch_id, ?), raw_data = ?,
                 cargo_name = CASE WHEN order_status = 'RECORDED' THEN ? ELSE cargo_name END,
                 forecast_cartons = CASE WHEN order_status = 'RECORDED' THEN ? ELSE forecast_cartons END,
                 forecast_packages = CASE WHEN order_status = 'RECORDED' THEN ? ELSE forecast_packages END,
                 forecast_weight = CASE WHEN order_status = 'RECORDED' THEN ? ELSE forecast_weight END,
                 forecast_weight_unit = CASE WHEN order_status = 'RECORDED' THEN ? ELSE forecast_weight_unit END,
                 remarks = CASE WHEN order_status = 'RECORDED' THEN ? ELSE remarks END,
                 updated_by_reference = ?, version = version + 1 WHERE id = ?`,
              [request.client.id, clients[0].display_name, clients[0].customer_profile_id, clients[0].customer_name, clients[0].customer_type, input.externalBatchId, JSON.stringify(input.body),
                input.cargoName, input.forecastCartons, input.forecastPackages, input.forecastWeight,
                input.forecastWeightUnit, input.remarks, `client:${request.client.id}`, airPickupOrderId],
            );
          }
          await connection.execute(
            `INSERT INTO air_pickup_events
              (order_id, event_type, actor_user_id, actor_reference, request_id, ip_address, event_data)
             VALUES (?, ?, NULL, ?, ?, ?, ?)`,
            [airPickupOrderId, existingAir ? 'ORDER_EDITED' : 'ORDER_RECORDED',
              `client:${request.client.id}`, request.requestId, request.ip.slice(0, 64),
              JSON.stringify({ source: 'UPSTREAM', externalBatchId: input.externalBatchId, shipmentCount: input.shipments.length })],
          );

          for (const shipment of input.shipments) {
            await upsertShipment(connection, { client: request.client, airPickupOrderId, shipment, requestId: request.requestId });
          }

          const responseBody = {
            data: {
              batchId: input.externalBatchId,
              airPickupOrderId,
              billNo: input.bill.display,
              clientName: clients[0].display_name,
              shipmentCount: input.shipments.length,
            },
            requestId: request.requestId,
          };
          await connection.execute(
            `UPDATE inbound_messages SET processing_status = 'COMPLETED', response_status = 200,
               response_body = ?, completed_at = CURRENT_TIMESTAMP(3) WHERE id = ?`,
            [JSON.stringify(responseBody), messageId],
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
          console.error('Failed to release inbound-batch ingest lock.', { requestId: request.requestId, error });
        });
      }
    },
  };
}

export const inboundBatchLimits = { maxShipments: MAX_SHIPMENTS } as const;
