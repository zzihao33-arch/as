import { randomUUID } from 'node:crypto';
import type { RowDataPacket } from 'mysql2';
import type { Pool, PoolConnection } from 'mysql2/promise';
import type { Redis } from 'ioredis';
import type { AuthenticatedClient } from './auth.js';
import { normalizeAirBillNo } from './airPickupOperations.js';
import { ApiError } from './errors.js';
import { decodeTygLabelBase64, type ValidatedLabelPdf } from './labelPdf.js';
import type { LabelStorage } from './labelStorage.js';
import { hashInboundPayload } from './shipmentIngest.js';

const LOCK_SECONDS = 300;
const AIR_OPERATION = 'tyg.v1_1.air_shipments';
const LABEL_OPERATION = 'tyg.v1_1.label_pushes';

type MessageRow = RowDataPacket & { payload_sha256: string; processing_status: 'PROCESSING' | 'COMPLETED'; response_status: number | null; response_body: string | Record<string, unknown> | null };
type AirRow = RowDataPacket & { id: string; client_id: string | null; customer_profile_id: string | null; order_status: 'RECORDED' | 'RECEIVED' | 'HANDED_OVER' | 'VOIDED'; forecast_cartons: number; forecast_packages: number; forecast_weight: number | string; forecast_weight_unit: 'KG' | 'LB' };
type ShipmentRow = RowDataPacket & { id: string; air_pickup_order_id: string | null; courier_tracking_no: string | null; current_label_asset_id: string | null; status: string };
type AssetRow = RowDataPacket & { id: string; storage_key: string; asset_status: 'STORING' | 'READY' | 'FAILED'; content_sha256: string };

export type TygV11Result = { status: number; body: Record<string, unknown> };

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ApiError(400, 'VALIDATION_ERROR', '请求体必须是对象');
  return value as Record<string, unknown>;
}

function text(value: unknown, field: string, max: number, required = true): string | undefined {
  if (value === undefined || value === null || value === '') {
    if (required) throw new ApiError(400, 'VALIDATION_ERROR', `${field} 为必填项`);
    return undefined;
  }
  if (typeof value !== 'string') throw new ApiError(400, 'VALIDATION_ERROR', `${field} 必须是字符串`);
  const parsed = value.trim();
  if (!parsed || parsed.length > max) throw new ApiError(400, 'VALIDATION_ERROR', `${field} 长度无效`);
  return parsed;
}

function positiveInteger(value: unknown, field: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 999_999) throw new ApiError(400, 'VALIDATION_ERROR', `${field} 必须是正整数`);
  return parsed;
}

function positiveWeight(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 99_999_999_999.999 || Math.round(parsed * 1000) !== parsed * 1000) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'forecastWeight 必须大于 0，且最多三位小数');
  }
  return parsed;
}

export function validateTygIdempotencyKey(value: string | undefined): string {
  const key = value?.trim();
  if (!key || !/^[A-Za-z0-9_-]{8,128}$/.test(key)) throw new ApiError(400, 'IDEMPOTENCY_KEY_REQUIRED', '请求必须包含 8–128 位 Idempotency-Key');
  return key;
}

export function parseTygAirShipment(bodyValue: unknown) {
  const body = object(bodyValue);
  const bill = normalizeAirBillNo(text(body.airWaybillNo, 'airWaybillNo', 32)!);
  const unit = text(body.weightUnit, 'weightUnit', 2)!.toUpperCase();
  if (unit !== 'KG' && unit !== 'LB') throw new ApiError(400, 'VALIDATION_ERROR', 'weightUnit 仅支持 KG 或 LB');
  return { body, bill, forecastCartons: positiveInteger(body.forecastCartons, 'forecastCartons'), forecastPackages: positiveInteger(body.forecastPackages, 'forecastPackages'), forecastWeight: positiveWeight(body.forecastWeight), weightUnit: unit as 'KG' | 'LB' };
}

export function parseTygLabelPush(bodyValue: unknown): { body: Record<string, unknown>; bill: ReturnType<typeof normalizeAirBillNo>; originalTrackingNo: string; transferTrackingNo: string; replacementReason: string; pdf: ValidatedLabelPdf } {
  const body = object(bodyValue);
  return {
    body,
    bill: normalizeAirBillNo(text(body.airWaybillNo, 'airWaybillNo', 32)!),
    originalTrackingNo: text(body.originalTrackingNo, 'originalTrackingNo', 128)!,
    transferTrackingNo: text(body.transferTrackingNo, 'transferTrackingNo', 128)!,
    replacementReason: text(body.replacementReason, 'replacementReason', 200, false) ?? 'TYG v1.1 label push',
    pdf: decodeTygLabelBase64(body.labelBase64),
  };
}

/** Business-rule seam used by the route and focused contract tests. */
export function tygLabelDecision(input: { exists: boolean; sameRelationAndPdf: boolean; relationshipChanged: boolean; transferIsBoundToAnother: boolean; originalIsBoundToAnotherAirShipment: boolean }): 'CREATED' | 'DUPLICATE' | 'PDF_REPLACED' | 'TRACKING_AND_PDF_UPDATED' {
  if (input.transferIsBoundToAnother || input.originalIsBoundToAnotherAirShipment) {
    throw new ApiError(409, 'TRACKING_ALREADY_BOUND', '原单号或转单号已经绑定其他包裹');
  }
  if (!input.exists) return 'CREATED';
  if (input.sameRelationAndPdf) return 'DUPLICATE';
  return input.relationshipChanged ? 'TRACKING_AND_PDF_UPDATED' : 'PDF_REPLACED';
}

function response(value: unknown): Record<string, unknown> | undefined {
  if (!value) return undefined;
  if (typeof value !== 'string') return typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  try { const parsed = JSON.parse(value) as unknown; return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined; } catch { return undefined; }
}

function replay(row: MessageRow | undefined, payloadHash: string): TygV11Result | undefined {
  if (!row) return undefined;
  if (row.payload_sha256 !== payloadHash) throw new ApiError(409, 'IDEMPOTENCY_CONFLICT', '该 Idempotency-Key 已用于不同的请求内容');
  if (row.processing_status !== 'COMPLETED') throw new ApiError(409, 'REQUEST_IN_PROGRESS', '相同请求正在处理中');
  const body = response(row.response_body);
  if (!body || !row.response_status) throw new ApiError(500, 'IDEMPOTENCY_RECORD_INVALID', '历史幂等记录不完整');
  return { status: row.response_status, body: { ...body, idempotentReplay: true } };
}

async function findMessage(mysql: Pool, clientId: string, operation: string, key: string): Promise<MessageRow | undefined> {
  const [rows] = await mysql.execute<MessageRow[]>(`SELECT payload_sha256, processing_status, response_status, response_body FROM inbound_messages WHERE client_id = ? AND operation = ? AND idempotency_key = ? LIMIT 1`, [clientId, operation, key]);
  return rows[0];
}

async function release(redis: Redis, lockKey: string, token: string): Promise<void> {
  await redis.eval(`if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) end return 0`, 1, lockKey, token);
}

async function withIdempotency<T>(dependencies: { mysql: Pool; redis: Redis }, request: { client: AuthenticatedClient; idempotencyKey: string | undefined; body: unknown }, operation: string, action: (key: string, hash: string) => Promise<TygV11Result>): Promise<TygV11Result> {
  const key = validateTygIdempotencyKey(request.idempotencyKey);
  const hash = hashInboundPayload(request.body);
  const existing = replay(await findMessage(dependencies.mysql, request.client.id, operation, key), hash);
  if (existing) return existing;
  const lockKey = `cmhub:tyg-v11:${request.client.id}:${operation}:${key}`;
  const token = randomUUID();
  let locked: string | null;
  try { locked = await dependencies.redis.set(lockKey, token, 'EX', LOCK_SECONDS, 'NX'); }
  catch { throw new ApiError(503, 'IDEMPOTENCY_UNAVAILABLE', '去重服务暂时不可用，请稍后重试'); }
  if (locked !== 'OK') throw new ApiError(409, 'REQUEST_IN_PROGRESS', '相同请求正在处理中');
  try {
    const afterLock = replay(await findMessage(dependencies.mysql, request.client.id, operation, key), hash);
    return afterLock ?? await action(key, hash);
  } finally { await release(dependencies.redis, lockKey, token).catch(() => undefined); }
}

function storageKey(clientId: string, shipmentId: string, sha256: string): string { return `labels/${clientId}/${shipmentId}/${sha256}.pdf`; }

export function createTygV11Integration(dependencies: { mysql: Pool; redis: Redis; storage: LabelStorage }) {
  return {
    async upsertAirShipment(request: { client: AuthenticatedClient; requestId: string; idempotencyKey: string | undefined; body: unknown }): Promise<TygV11Result> {
      const input = parseTygAirShipment(request.body);
      return withIdempotency(dependencies, request, AIR_OPERATION, async (key, hash) => {
        const connection = await dependencies.mysql.getConnection();
        try {
          await connection.beginTransaction();
          const [clients] = await connection.execute<(RowDataPacket & { display_name: string; customer_profile_id: string; customer_name: string; customer_type: 'UPSTREAM' })[]>(`SELECT c.display_name, p.id AS customer_profile_id, p.display_name AS customer_name, p.customer_type
            FROM clients c INNER JOIN customer_profiles p ON p.integration_client_id = c.id
            WHERE c.id = ? AND c.client_status = 'ACTIVE' AND p.customer_status = 'ACTIVE' LIMIT 1 FOR UPDATE`, [request.client.id]);
          if (!clients[0]) throw new ApiError(403, 'CLIENT_DISABLED', '客户未启用或未关联上游客户档案');
          const [orders] = await connection.execute<AirRow[]>('SELECT id, client_id, customer_profile_id, order_status, forecast_cartons, forecast_packages, forecast_weight, forecast_weight_unit FROM air_pickup_orders WHERE bill_no_normalized = ? LIMIT 1 FOR UPDATE', [input.bill.normalized]);
          const current = orders[0];
          if (current?.client_id && current.client_id !== request.client.id) throw new ApiError(409, 'TRACKING_ALREADY_BOUND', '空运提单号已属于其他客户');
          if (current?.customer_profile_id && current.customer_profile_id !== clients[0].customer_profile_id) throw new ApiError(409, 'TRACKING_ALREADY_BOUND', '空运提单号已归属于其他客户档案');
          const unchanged = Boolean(current && current.forecast_cartons === input.forecastCartons && current.forecast_packages === input.forecastPackages && Number(current.forecast_weight) === input.forecastWeight && current.forecast_weight_unit === input.weightUnit);
          if (current && current.order_status !== 'RECORDED' && !unchanged) throw new ApiError(409, 'AIR_SHIPMENT_LOCKED', '仓库已经开始收货，预报不能修改');
          const orderId = current?.id ?? randomUUID();
          if (!current) {
            await connection.execute(`INSERT INTO air_pickup_orders (id, client_id, client_name_snapshot, customer_profile_id, customer_name_snapshot, customer_type_snapshot, source_type, raw_data, bill_no_raw, bill_no_display, bill_no_normalized, bill_no_is_standard, forecast_cartons, forecast_packages, forecast_weight, forecast_weight_unit, created_by_reference, updated_by_reference) VALUES (?, ?, ?, ?, ?, ?, 'UPSTREAM', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [orderId, request.client.id, clients[0].display_name, clients[0].customer_profile_id, clients[0].customer_name, clients[0].customer_type, JSON.stringify(input.body), input.bill.raw, input.bill.display, input.bill.normalized, input.bill.isStandard, input.forecastCartons, input.forecastPackages, input.forecastWeight, input.weightUnit, `client:${request.client.id}`, `client:${request.client.id}`]);
          } else if (!unchanged) {
            await connection.execute(`UPDATE air_pickup_orders SET raw_data = ?, forecast_cartons = ?, forecast_packages = ?, forecast_weight = ?, forecast_weight_unit = ?, updated_by_reference = ?, version = version + 1 WHERE id = ?`, [JSON.stringify(input.body), input.forecastCartons, input.forecastPackages, input.forecastWeight, input.weightUnit, `client:${request.client.id}`, orderId]);
          }
          await connection.execute(`INSERT INTO inbound_messages (id, client_id, api_key_id, request_id, operation, idempotency_key, payload_sha256, raw_data, processing_status, response_status, response_body, completed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'COMPLETED', 200, ?, CURRENT_TIMESTAMP(3))`, [randomUUID(), request.client.id, request.client.apiKeyId, request.requestId, AIR_OPERATION, key, hash, JSON.stringify(input.body), JSON.stringify({ code: 'SUCCESS', message: '空运提单预报保存成功', data: { airWaybillNo: input.bill.display, forecastCartons: input.forecastCartons, forecastPackages: input.forecastPackages, forecastWeight: input.forecastWeight, weightUnit: input.weightUnit, duplicate: unchanged, updated: Boolean(current && !unchanged) }, requestId: request.requestId })]);
          await connection.commit();
          return { status: 200, body: { code: 'SUCCESS', message: '空运提单预报保存成功', data: { airWaybillNo: input.bill.display, forecastCartons: input.forecastCartons, forecastPackages: input.forecastPackages, forecastWeight: input.forecastWeight, weightUnit: input.weightUnit, duplicate: unchanged, updated: Boolean(current && !unchanged) }, requestId: request.requestId } };
        } catch (error) { await connection.rollback().catch(() => undefined); throw error; } finally { connection.release(); }
      });
    },

    async pushLabel(request: { client: AuthenticatedClient; requestId: string; idempotencyKey: string | undefined; body: unknown }): Promise<TygV11Result> {
      const input = parseTygLabelPush(request.body);
      return withIdempotency(dependencies, request, LABEL_OPERATION, async (key, hash) => {
        const connection = await dependencies.mysql.getConnection();
        let shipmentId = ''; let asset!: AssetRow; let needsWrite = false; let createdShipment = false; let resultData!: Record<string, unknown>;
        try {
          await connection.beginTransaction();
          const [profileRows] = await connection.execute<(RowDataPacket & { customer_profile_id: string })[]>(
            'SELECT id AS customer_profile_id FROM customer_profiles WHERE integration_client_id = ? AND customer_status = \'ACTIVE\' LIMIT 1', [request.client.id],
          );
          const [airRows] = await connection.execute<AirRow[]>('SELECT id, client_id, customer_profile_id, order_status, forecast_cartons, forecast_packages, forecast_weight, forecast_weight_unit FROM air_pickup_orders WHERE bill_no_normalized = ? LIMIT 1 FOR UPDATE', [input.bill.normalized]);
          const air = airRows[0];
          if (!air || air.customer_profile_id !== profileRows[0]?.customer_profile_id) throw new ApiError(404, 'AIR_SHIPMENT_NOT_FOUND', '未找到已创建的空运提单预报');
          const [shipmentRows] = await connection.execute<ShipmentRow[]>('SELECT id, air_pickup_order_id, courier_tracking_no, current_label_asset_id, status FROM shipments WHERE client_id = ? AND first_leg_tracking_no = ? LIMIT 1 FOR UPDATE', [request.client.id, input.originalTrackingNo]);
          const shipment = shipmentRows[0];
          const originalIsBoundToAnotherAirShipment = Boolean(shipment?.air_pickup_order_id && shipment.air_pickup_order_id !== air.id);
          const [boundRows] = await connection.execute<ShipmentRow[]>('SELECT id, air_pickup_order_id, courier_tracking_no, current_label_asset_id, status FROM shipments WHERE client_id = ? AND courier_tracking_no = ? AND first_leg_tracking_no <> ? LIMIT 1 FOR UPDATE', [request.client.id, input.transferTrackingNo, input.originalTrackingNo]);
          const transferIsBoundToAnother = Boolean(boundRows[0]);
          shipmentId = shipment?.id ?? randomUUID();
          createdShipment = !shipment;
          let currentHash: string | undefined;
          let currentAssetReady = false;
          if (shipment?.current_label_asset_id) {
            const [currentAssets] = await connection.execute<AssetRow[]>('SELECT id, storage_key, asset_status, content_sha256 FROM label_assets WHERE id = ? LIMIT 1', [shipment.current_label_asset_id]);
            currentHash = currentAssets[0]?.content_sha256;
            currentAssetReady = currentAssets[0]?.asset_status === 'READY';
          }
          const sameRelationAndHash = Boolean(shipment && shipment.courier_tracking_no === input.transferTrackingNo && currentHash === input.pdf.sha256);
          const same = sameRelationAndHash && currentAssetReady;
          const fileRestore = sameRelationAndHash && !currentAssetReady;
          const latePush = air.order_status !== 'RECORDED';
          const relationshipChanged = Boolean(shipment && shipment.courier_tracking_no !== input.transferTrackingNo);
          const decision = tygLabelDecision({ exists: Boolean(shipment), sameRelationAndPdf: same, relationshipChanged, transferIsBoundToAnother, originalIsBoundToAnotherAirShipment });
          if (same) {
            resultData = { airWaybillNo: input.bill.display, originalTrackingNo: input.originalTrackingNo, transferTrackingNo: input.transferTrackingNo, operation: 'DUPLICATE', labelVersion: await nextVersion(connection, shipmentId, false), duplicate: true, latePush, relationshipChanged: false, reprintRequired: false };
            await completeMessage(connection, request, LABEL_OPERATION, key, hash, input.body, shipmentId, { code: 'SUCCESS', message: '接收成功', data: resultData, requestId: request.requestId });
            await connection.commit();
            return { status: 200, body: { code: 'SUCCESS', message: '接收成功', data: resultData, requestId: request.requestId } };
          }
          if (!shipment) await connection.execute(`INSERT INTO shipments (id, client_id, air_pickup_order_id, first_leg_tracking_no, courier_tracking_no, raw_data, status) VALUES (?, ?, ?, ?, ?, ?, 'RECEIVED')`, [shipmentId, request.client.id, air.id, input.originalTrackingNo, input.transferTrackingNo, JSON.stringify({ contract: 'TYG-v1.1' })]);
          const [assets] = await connection.execute<AssetRow[]>('SELECT id, storage_key, asset_status, content_sha256 FROM label_assets WHERE shipment_id = ? AND content_sha256 = ? LIMIT 1 FOR UPDATE', [shipmentId, input.pdf.sha256]);
          asset = assets[0] ?? { id: randomUUID(), storage_key: storageKey(request.client.id, shipmentId, input.pdf.sha256), asset_status: 'STORING', content_sha256: input.pdf.sha256 } as AssetRow;
          if (!assets[0]) await connection.execute(`INSERT INTO label_assets (id, client_id, shipment_id, uploaded_by_api_key_id, source_type, storage_key, content_sha256, content_type, byte_size, asset_status) VALUES (?, ?, ?, ?, 'UPSTREAM_PUSH', ?, ?, 'application/pdf', ?, 'STORING')`, [asset.id, request.client.id, shipmentId, request.client.apiKeyId, asset.storage_key, input.pdf.sha256, input.pdf.byteSize]);
          needsWrite = asset.asset_status !== 'READY';
          const [printed] = shipment?.current_label_asset_id ? await connection.execute<RowDataPacket[]>('SELECT 1 AS printed FROM print_attempts WHERE shipment_id = ? AND label_asset_id = ? AND outcome = \'SUBMITTED\' LIMIT 1', [shipmentId, shipment.current_label_asset_id]) : [[]] as unknown as [RowDataPacket[]];
          resultData = { airWaybillNo: input.bill.display, originalTrackingNo: input.originalTrackingNo, transferTrackingNo: input.transferTrackingNo, operation: fileRestore ? 'FILE_RESTORED' : decision, duplicate: false, latePush, relationshipChanged, reprintRequired: Boolean(printed[0]) };
          await connection.commit();
        } catch (error) { await connection.rollback().catch(() => undefined); throw error; } finally { connection.release(); }

        try { if (needsWrite) await dependencies.storage.put(asset.storage_key, input.pdf.content); }
        catch (error) {
          const cleanup = await dependencies.mysql.getConnection();
          try { await cleanup.beginTransaction(); await cleanup.execute('UPDATE label_assets SET asset_status = \'FAILED\', failure_code = \'STORAGE_WRITE_FAILED\' WHERE id = ?', [asset.id]); if (createdShipment) { await cleanup.execute('DELETE FROM label_assets WHERE id = ?', [asset.id]); await cleanup.execute('DELETE FROM shipments WHERE id = ?', [shipmentId]); } await cleanup.commit(); }
          catch { await cleanup.rollback().catch(() => undefined); } finally { cleanup.release(); }
          throw new ApiError(503, 'LABEL_STORAGE_UNAVAILABLE', '面单存储暂时不可用，请使用原幂等键重试');
        }

        const finalize = await dependencies.mysql.getConnection();
        try {
          await finalize.beginTransaction();
          const [shipmentRows] = await finalize.execute<ShipmentRow[]>('SELECT id, air_pickup_order_id, courier_tracking_no, current_label_asset_id, status FROM shipments WHERE id = ? LIMIT 1 FOR UPDATE', [shipmentId]);
          if (!shipmentRows[0]) throw new ApiError(409, 'LABEL_SUPERSEDED', '面单更新被中断，请使用原幂等键重试');
          await finalize.execute('UPDATE label_assets SET asset_status = \'READY\', failure_code = NULL, ready_at = CURRENT_TIMESTAMP(3), retention_expires_at = DATE_ADD(CURRENT_TIMESTAMP(3), INTERVAL 7 DAY) WHERE id = ?', [asset.id]);
          await finalize.execute(`UPDATE shipments SET courier_tracking_no = ?, current_label_asset_id = ?, label_sha256 = ?, status = CASE WHEN status = 'RECEIVED' THEN 'READY_TO_PRINT' ELSE status END, version = version + 1 WHERE id = ?`, [input.transferTrackingNo, asset.id, input.pdf.sha256, shipmentId]);
          const labelVersion = await nextVersion(finalize, shipmentId, true);
          await finalize.execute('INSERT INTO tyg_label_versions (id, shipment_id, label_asset_id, version_no, original_tracking_no, transfer_tracking_no, replacement_reason) VALUES (?, ?, ?, ?, ?, ?, ?)', [randomUUID(), shipmentId, asset.id, labelVersion, input.originalTrackingNo, input.transferTrackingNo, input.replacementReason]);
          await finalize.execute(`INSERT INTO shipment_events (id, client_id, shipment_id, request_id, event_type, actor_type, actor_id, event_data) VALUES (?, ?, ?, ?, 'TYG_LABEL_PUSHED', 'UPSTREAM_API_KEY', ?, ?)`, [randomUUID(), request.client.id, shipmentId, request.requestId, request.client.apiKeyId, JSON.stringify({ ...resultData, labelVersion, sha256: input.pdf.sha256, byteSize: input.pdf.byteSize })]);
          await finalize.execute(`INSERT INTO shipment_delivery_changes (client_id, shipment_id, change_type) VALUES (?, ?, 'LABEL_READY')`, [request.client.id, shipmentId]);
          resultData.labelVersion = labelVersion;
          const body = { code: 'SUCCESS', message: '接收成功', data: resultData, requestId: request.requestId };
          await completeMessage(finalize, request, LABEL_OPERATION, key, hash, input.body, shipmentId, body);
          await finalize.commit();
          return { status: 200, body };
        } catch (error) { await finalize.rollback().catch(() => undefined); throw error; } finally { finalize.release(); }
      });
    },
  };
}

async function nextVersion(connection: PoolConnection, shipmentId: string, increment: boolean): Promise<number> {
  const [rows] = await connection.execute<(RowDataPacket & { version_no: number | null })[]>('SELECT MAX(version_no) AS version_no FROM tyg_label_versions WHERE shipment_id = ? FOR UPDATE', [shipmentId]);
  const current = Number(rows[0]?.version_no ?? 0);
  return increment ? current + 1 : current || 1;
}

async function completeMessage(connection: PoolConnection, request: { client: AuthenticatedClient; requestId: string }, operation: string, key: string, hash: string, rawData: unknown, shipmentId: string, body: Record<string, unknown>): Promise<void> {
  await connection.execute(`INSERT INTO inbound_messages (id, client_id, api_key_id, shipment_id, request_id, operation, idempotency_key, payload_sha256, raw_data, processing_status, response_status, response_body, completed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'COMPLETED', 200, ?, CURRENT_TIMESTAMP(3))`, [randomUUID(), request.client.id, request.client.apiKeyId, shipmentId, request.requestId, operation, key, hash, JSON.stringify(rawData), JSON.stringify(body)]);
}
