import { createHash, randomUUID } from 'node:crypto';
import type { ResultSetHeader, RowDataPacket } from 'mysql2';
import type { Pool } from 'mysql2/promise';
import { ApiError } from './errors.js';
import type { LabelStorage, LabelStorageObject } from './labelStorage.js';
import type { OutboundWebhooks } from './outboundWebhooks.js';
import type { WarehouseSession } from './warehouseIdentity.js';

export type WarehousePrintOutcome = 'SUBMITTED' | 'FAILED' | 'RESULT_UNKNOWN' | 'BLOCKED';
type ShipmentDeliveryRow = RowDataPacket & {
  revision: string | number;
  id: string;
  first_leg_tracking_no: string;
  courier_tracking_no: string | null;
  carrier: string | null;
  status: string;
  version: number;
  updated_at: Date;
  label_asset_id: string | null;
  content_sha256: string | null;
  byte_size: number | null;
};
type LabelDownloadRow = RowDataPacket & {
  id: string;
  content_sha256: string;
  content_type: string;
  byte_size: number;
  storage_key: string;
};
type WorkstationAccessRow = RowDataPacket & { id: string };
type PrintTargetRow = RowDataPacket & {
  client_id: string;
  shipment_id: string;
  label_asset_id: string;
  first_leg_tracking_no: string;
  courier_tracking_no: string | null;
  carrier: string | null;
  status: string;
  version: number;
};
type ExistingAttemptRow = RowDataPacket & {
  id: string;
  shipment_id: string;
  label_asset_id: string;
  outcome: WarehousePrintOutcome;
  payload_sha256: string;
  created_at: Date;
};

type DeliveryCursor = { revision: string };
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function text(value: unknown, field: string, maxLength: number, required = true): string | null {
  if (value === undefined || value === null || value === '') {
    if (required) throw new ApiError(400, 'VALIDATION_ERROR', `${field} 为必填项。`);
    return null;
  }
  if (typeof value !== 'string') throw new ApiError(400, 'VALIDATION_ERROR', `${field} 必须是字符串。`);
  const result = value.trim();
  if (!result || result.length > maxLength) throw new ApiError(400, 'VALIDATION_ERROR', `${field} 长度无效。`);
  return result;
}

export function encodeDeliveryCursor(cursor: DeliveryCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

export function decodeDeliveryCursor(value: unknown): DeliveryCursor | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || value.length > 512) throw new ApiError(400, 'INVALID_CURSOR', '同步游标无效。');
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Partial<DeliveryCursor>;
    if (typeof parsed.revision !== 'string' || !/^[0-9]+$/.test(parsed.revision)) {
      throw new Error('invalid');
    }
    return { revision: parsed.revision };
  } catch {
    throw new ApiError(400, 'INVALID_CURSOR', '同步游标无效。');
  }
}

function limitValue(value: unknown): number {
  if (value === undefined) return 200;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 500) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'limit 必须是 1 到 500 的整数。');
  }
  return parsed;
}

export function createWarehouseOperations(dependencies: {
  mysql: Pool;
  storage: LabelStorage;
  outboundWebhooks: Pick<OutboundWebhooks, 'enqueuePrintAttempt'>;
}) {
  const { mysql, storage, outboundWebhooks } = dependencies;

  return {
    async listShipments(_session: WarehouseSession, input: { cursor?: unknown; limit?: unknown }) {
      const cursor = decodeDeliveryCursor(input.cursor);
      const limit = limitValue(input.limit);
      const cursorClause = cursor ? `AND d.revision > ?` : '';
      const parameters = cursor ? [cursor.revision, limit + 1] : [limit + 1];
      const [rows] = await mysql.execute<ShipmentDeliveryRow[]>(
        `SELECT d.revision, s.id, s.first_leg_tracking_no, s.courier_tracking_no, s.carrier, s.status, s.version, s.updated_at,
                CASE WHEN la.asset_status = 'READY' THEN la.id ELSE NULL END AS label_asset_id,
                CASE WHEN la.asset_status = 'READY' THEN la.content_sha256 ELSE NULL END AS content_sha256,
                CASE WHEN la.asset_status = 'READY' THEN la.byte_size ELSE NULL END AS byte_size
         FROM shipment_delivery_changes d
         INNER JOIN shipments s ON s.id = d.shipment_id
         LEFT JOIN label_assets la ON la.id = s.current_label_asset_id
         WHERE 1 = 1 ${cursorClause}
         ORDER BY d.revision ASC
         LIMIT ?`,
        parameters,
      );
      const hasMore = rows.length > limit;
      const rawPage = rows.slice(0, limit);
      const page = [...new Map(rawPage.map(row => [row.id, row])).values()];
      const last = rawPage.at(-1);
      return {
        shipments: page.map(row => ({
          id: row.id,
          firstLegTrackingNo: row.first_leg_tracking_no,
          courierTrackingNo: row.courier_tracking_no,
          carrier: row.carrier,
          status: row.status,
          version: row.version,
          updatedAt: row.updated_at.toISOString(),
          labelAsset: row.label_asset_id ? {
            id: row.label_asset_id,
            sha256: row.content_sha256,
            byteSize: Number(row.byte_size),
            downloadPath: `/warehouse/v1/label-assets/${row.label_asset_id}/content`,
          } : null,
        })),
        cursor: last ? encodeDeliveryCursor({ revision: String(last.revision) }) : (typeof input.cursor === 'string' ? input.cursor : null),
        hasMore,
      };
    },

    async openLabel(_session: WarehouseSession, assetIdValue: unknown): Promise<{ metadata: LabelDownloadRow; object: LabelStorageObject }> {
      const assetId = text(assetIdValue, 'assetId', 36)!;
      const [rows] = await mysql.execute<LabelDownloadRow[]>(
        `SELECT la.id, la.content_sha256, la.content_type, la.byte_size, la.storage_key
         FROM label_assets la
         INNER JOIN shipments s ON s.id = la.shipment_id AND s.current_label_asset_id = la.id
         WHERE la.id = ? AND la.asset_status = 'READY'
         LIMIT 1`,
        [assetId],
      );
      if (!rows[0]) throw new ApiError(404, 'LABEL_NOT_FOUND', '面单不存在、尚未就绪或已失效。');
      const object = await storage.open(rows[0].storage_key).catch(() => {
        throw new ApiError(503, 'LABEL_STORAGE_UNAVAILABLE', '面单文件暂时不可用。');
      });
      if (object.byteSize !== Number(rows[0].byte_size)) {
        object.stream.destroy();
        throw new ApiError(503, 'LABEL_STORAGE_MISMATCH', '面单文件校验失败。');
      }
      return { metadata: rows[0], object };
    },

    async recordPrintAttempt(session: WarehouseSession, input: Record<string, unknown>) {
      const warehouseId = session.warehouseId;
      const warehouseCode = session.warehouseCode;
      if (!warehouseId || !warehouseCode) {
        throw new ApiError(409, 'WAREHOUSE_SELECTION_REQUIRED', '请先选择要进入的仓库。');
      }
      const workstationId = text(input.workstationId, 'workstationId', 36)!;
      const shipmentId = text(input.shipmentId, 'shipmentId', 36)!;
      const labelAssetId = text(input.labelAssetId, 'labelAssetId', 36)!;
      const clientAttemptId = text(input.clientAttemptId, 'clientAttemptId', 36)!;
      if (![workstationId, shipmentId, labelAssetId, clientAttemptId].every(value => UUID_PATTERN.test(value))) {
        throw new ApiError(400, 'VALIDATION_ERROR', '提交标识必须是 UUID。');
      }
      const outcome = text(input.outcome, 'outcome', 32) as WarehousePrintOutcome;
      if (!['SUBMITTED', 'FAILED', 'RESULT_UNKNOWN', 'BLOCKED'].includes(outcome)) {
        throw new ApiError(400, 'VALIDATION_ERROR', 'outcome 不受支持。');
      }
      const printerName = text(input.printerName, 'printerName', 255, false);
      const message = text(input.message, 'message', 1024, false);
      const occurredAtText = text(input.occurredAt, 'occurredAt', 64)!;
      const occurredAt = new Date(occurredAtText);
      if (Number.isNaN(occurredAt.getTime()) || Math.abs(Date.now() - occurredAt.getTime()) > 7 * 24 * 60 * 60 * 1000) {
        throw new ApiError(400, 'VALIDATION_ERROR', 'occurredAt 必须是七天内的有效时间。');
      }
      const normalizedOccurredAt = occurredAt.toISOString();
      const payloadHash = createHash('sha256').update(JSON.stringify({
        workstationId, shipmentId, labelAssetId, clientAttemptId, outcome,
        printerName, message, occurredAt: normalizedOccurredAt,
      })).digest('hex');

      const connection = await mysql.getConnection();
      try {
        await connection.beginTransaction();
        const [workstations] = await connection.execute<WorkstationAccessRow[]>(
          `SELECT id FROM workstations WHERE id = ? AND warehouse_id = ? AND workstation_status = 'ACTIVE' LIMIT 1`,
          [workstationId, warehouseId],
        );
        if (!workstations[0]) throw new ApiError(403, 'WORKSTATION_NOT_ALLOWED', '工作站不存在、已停用或不属于当前仓库。');
        const [targets] = await connection.execute<PrintTargetRow[]>(
          `SELECT s.client_id, s.id AS shipment_id, la.id AS label_asset_id,
                  s.first_leg_tracking_no, s.courier_tracking_no, s.carrier, s.status, s.version
           FROM shipments s
           INNER JOIN label_assets la ON la.id = s.current_label_asset_id AND la.asset_status = 'READY'
           WHERE s.id = ? AND la.id = ? LIMIT 1`,
          [shipmentId, labelAssetId],
        );
        if (!targets[0]) throw new ApiError(409, 'PRINT_TARGET_STALE', '当前面单已失效，请先重新同步。');

        const attemptId = randomUUID();
        const [insert] = await connection.execute<ResultSetHeader>(
          `INSERT IGNORE INTO print_attempts
             (id, client_id, shipment_id, label_asset_id, warehouse_id, user_id, workstation_id,
              client_attempt_id, payload_sha256, outcome, printer_name, message, occurred_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [attemptId, targets[0].client_id, shipmentId, labelAssetId, warehouseId, session.userId,
            workstationId, clientAttemptId, payloadHash, outcome, printerName, message, occurredAt],
        );
        if (insert.affectedRows === 0) {
          const [existing] = await connection.execute<ExistingAttemptRow[]>(
            `SELECT id, shipment_id, label_asset_id, outcome, payload_sha256, created_at
             FROM print_attempts WHERE workstation_id = ? AND client_attempt_id = ? LIMIT 1`,
            [workstationId, clientAttemptId],
          );
          if (!existing[0] || existing[0].payload_sha256 !== payloadHash) {
            throw new ApiError(409, 'IDEMPOTENCY_CONFLICT', 'clientAttemptId 已被用于不同的打印尝试。');
          }
          await connection.commit();
          return { id: existing[0].id, outcome: existing[0].outcome, recordedAt: existing[0].created_at.toISOString(), replayed: true };
        }
        const eventType = outcome === 'SUBMITTED' ? 'PRINT_SUBMITTED' : outcome === 'BLOCKED' ? 'PRINT_BLOCKED' : outcome === 'RESULT_UNKNOWN' ? 'PRINT_RESULT_UNKNOWN' : 'PRINT_FAILED';
        await connection.execute(
          `INSERT INTO shipment_events
             (id, client_id, shipment_id, request_id, event_type, actor_type, actor_id, event_data, occurred_at)
           VALUES (?, ?, ?, ?, ?, 'WORKSTATION', ?, ?, ?)`,
          [randomUUID(), targets[0].client_id, shipmentId, clientAttemptId, eventType, workstationId,
            JSON.stringify({ attemptId, outcome, printerName, message, userId: session.userId, warehouseId }), occurredAt],
        );
        await outboundWebhooks.enqueuePrintAttempt(connection, {
          clientId: targets[0].client_id,
          shipmentId,
          printAttemptId: attemptId,
          outcome,
          occurredAt: normalizedOccurredAt,
          firstLegTrackingNo: targets[0].first_leg_tracking_no,
          courierTrackingNo: targets[0].courier_tracking_no,
          carrier: targets[0].carrier,
          shipmentStatus: targets[0].status,
          shipmentVersion: Number(targets[0].version),
          printerName,
          message,
          warehouseCode,
        });
        await connection.commit();
        return { id: attemptId, outcome, recordedAt: new Date().toISOString(), replayed: false };
      } catch (error) {
        await connection.rollback();
        throw error;
      } finally {
        connection.release();
      }
    },
  };
}

export type WarehouseOperations = ReturnType<typeof createWarehouseOperations>;
