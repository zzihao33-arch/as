import { createHash, randomUUID } from 'node:crypto';
import type { ResultSetHeader, RowDataPacket } from 'mysql2';
import type { Pool } from 'mysql2/promise';
import { ApiError } from './errors.js';
import type { ValidatedLabelPdf } from './labelPdf.js';
import type { LabelStorage, LabelStorageObject } from './labelStorage.js';
import type { WarehouseSession } from './warehouseIdentity.js';

type BatchRow = RowDataPacket & {
  id: string;
  batch_name: string;
  batch_status: 'DRAFT' | 'ACTIVE' | 'CLOSED';
  mapping_count: number;
  pdf_count: number;
  version: number;
  published_at: Date | null;
  closed_at: Date | null;
  created_at: Date;
  updated_at: Date;
};
type ItemRow = RowDataPacket & {
  id: string;
  batch_id: string;
  batch_name: string;
  first_leg_tracking_no: string;
  courier_tracking_no: string | null;
  label_asset_id: string | null;
  item_status: 'PENDING' | 'CLAIMED' | 'SUBMITTED' | 'FAILED' | 'RESULT_UNKNOWN' | 'BLOCKED';
  item_version: number;
  claim_token: string | null;
  claim_expires_at: Date | null;
  claimed_by_workstation_id: string | null;
  asset_status: 'STORING' | 'READY' | 'FAILED' | null;
  content_sha256: string | null;
  byte_size: number | null;
  storage_key: string | null;
  updated_at: Date;
};
type AssetRow = RowDataPacket & {
  id: string;
  storage_key: string;
  content_sha256: string;
  content_type: string;
  byte_size: number;
  asset_status: 'STORING' | 'READY' | 'FAILED';
};
type BatchAssetDeletionRow = RowDataPacket & {
  storage_key: string;
  byte_size: number;
};
type AttemptRow = RowDataPacket & { id: string; payload_sha256: string; outcome: string; created_at: Date };
type InterceptRow = RowDataPacket & {
  id: string;
  tracking_no: string;
  intercept_reason: string | null;
  source_type: string;
  intercept_status: 'ACTIVE' | 'REMOVED';
  updated_at: Date;
  revision: string | number;
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type SharedPrintOutcome = 'SUBMITTED' | 'FAILED' | 'RESULT_UNKNOWN' | 'BLOCKED';
export type SharedItemStatus = 'PENDING' | 'CLAIMED' | 'SUBMITTED' | 'FAILED' | 'RESULT_UNKNOWN' | 'BLOCKED';

export function mappedTrackingNumbers(firstLeg: string, courier: string | null): string[] {
  return courier ? [firstLeg, courier] : [firstLeg];
}

export function canCompleteClaim(
  claim: { claimToken: string | null; workstationId: string | null },
  claimToken: string,
  workstationId: string,
): boolean {
  return claim.claimToken === claimToken && claim.workstationId === workstationId;
}

export function completionStatus(outcome: SharedPrintOutcome): SharedItemStatus {
  if (outcome === 'SUBMITTED' || outcome === 'RESULT_UNKNOWN' || outcome === 'BLOCKED') return outcome;
  return 'FAILED';
}

function text(value: unknown, field: string, maxLength: number, required = true): string | null {
  if (value === undefined || value === null || value === '') {
    if (required) throw new ApiError(400, 'VALIDATION_ERROR', `${field} 为必填项`);
    return null;
  }
  if (typeof value !== 'string') throw new ApiError(400, 'VALIDATION_ERROR', `${field} 必须是字符串`);
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength) throw new ApiError(400, 'VALIDATION_ERROR', `${field} 长度无效`);
  return normalized;
}

function uuid(value: unknown, field: string): string {
  const result = text(value, field, 36)!;
  if (!UUID_PATTERN.test(result)) throw new ApiError(400, 'VALIDATION_ERROR', `${field} 必须是 UUID`);
  return result;
}

function tracking(value: unknown, field = 'trackingNo'): string {
  const result = text(value, field, 128)!.replaceAll(/\s+/g, '').toUpperCase();
  if (!/^[A-Z0-9._-]{3,128}$/.test(result)) throw new ApiError(400, 'VALIDATION_ERROR', `${field} 格式无效`);
  return result;
}

function batchView(row: BatchRow) {
  return {
    id: row.id,
    name: row.batch_name,
    status: row.batch_status,
    mappingCount: Number(row.mapping_count),
    pdfCount: Number(row.pdf_count),
    version: Number(row.version),
    publishedAt: row.published_at?.toISOString() ?? null,
    closedAt: row.closed_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function storageKey(batchId: string, sha256: string): string {
  return `shared-batches/${batchId}/${sha256}.pdf`;
}

function requireWorkspace(session: WarehouseSession): string {
  if (!session.warehouseId) throw new ApiError(409, 'WAREHOUSE_SELECTION_REQUIRED', '请先选择要进入的仓库');
  return session.warehouseId;
}

export function createSharedWarehouseWork(dependencies: { mysql: Pool; storage: LabelStorage }) {
  const { mysql, storage } = dependencies;

  return {
    async listBatches(input: { status?: unknown; limit?: unknown }) {
      const status = input.status === undefined || input.status === '' ? null : text(input.status, 'status', 16);
      if (status && !['DRAFT', 'ACTIVE', 'CLOSED'].includes(status)) throw new ApiError(400, 'VALIDATION_ERROR', 'status 不受支持');
      const limit = input.limit === undefined ? 50 : Number(input.limit);
      if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new ApiError(400, 'VALIDATION_ERROR', 'limit 必须为 1 到 200');
      const [rows] = await mysql.query<BatchRow[]>(
        `SELECT id, batch_name, batch_status, mapping_count, pdf_count, version,
                published_at, closed_at, created_at, updated_at
         FROM warehouse_work_batches
         WHERE (? IS NULL OR batch_status = ?)
         ORDER BY updated_at DESC LIMIT ${limit}`,
        [status, status],
      );
      return rows.map(batchView);
    },

    async createBatch(session: WarehouseSession, input: { name: unknown }) {
      const name = text(input.name, 'name', 128)!;
      const id = randomUUID();
      await mysql.execute(
        `INSERT INTO warehouse_work_batches
           (id, batch_name, created_by_user_id, created_by_reference)
         VALUES (?, ?, ?, ?)`,
        [id, name, session.userId, `user:${session.userId}`],
      );
      await mysql.execute(
        `INSERT INTO warehouse_work_batch_changes (batch_id, change_type) VALUES (?, 'BATCH_CREATED')`,
        [id],
      );
      return { id, name, status: 'DRAFT' as const, mappingCount: 0, pdfCount: 0 };
    },

    async upsertItems(session: WarehouseSession, batchIdValue: unknown, input: { items: unknown }) {
      const batchId = uuid(batchIdValue, 'batchId');
      if (!Array.isArray(input.items) || input.items.length < 1 || input.items.length > 1_000) {
        throw new ApiError(400, 'VALIDATION_ERROR', 'items 每批需包含 1 到 1,000 条映射');
      }
      const items = input.items.map((value, index) => {
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
          throw new ApiError(400, 'VALIDATION_ERROR', `items[${index}] 必须是对象`);
        }
        const row = value as Record<string, unknown>;
        return {
          firstLegTrackingNo: tracking(row.firstLegTrackingNo, `items[${index}].firstLegTrackingNo`),
          courierTrackingNo: row.courierTrackingNo === undefined || row.courierTrackingNo === null || row.courierTrackingNo === ''
            ? null : tracking(row.courierTrackingNo, `items[${index}].courierTrackingNo`),
          rawData: row.rawData === undefined ? null : row.rawData,
        };
      });
      const connection = await mysql.getConnection();
      try {
        await connection.beginTransaction();
        const [batches] = await connection.execute<(RowDataPacket & { batch_status: string })[]>(
          `SELECT batch_status FROM warehouse_work_batches WHERE id = ? LIMIT 1 FOR UPDATE`, [batchId],
        );
        if (!batches[0]) throw new ApiError(404, 'BATCH_NOT_FOUND', '未找到共享批次');
        if (batches[0].batch_status !== 'DRAFT') throw new ApiError(409, 'BATCH_NOT_EDITABLE', '只有草稿批次可以继续导入');
        for (const item of items) {
          await connection.execute(
            `INSERT INTO warehouse_work_batch_items
               (id, batch_id, first_leg_tracking_no, courier_tracking_no, raw_data)
             VALUES (?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE courier_tracking_no = VALUES(courier_tracking_no),
               raw_data = VALUES(raw_data), item_version = item_version + 1`,
            [randomUUID(), batchId, item.firstLegTrackingNo, item.courierTrackingNo,
              item.rawData === null ? null : JSON.stringify(item.rawData)],
          );
        }
        await connection.execute(
          `UPDATE warehouse_work_batches b
           SET mapping_count = (SELECT COUNT(*) FROM warehouse_work_batch_items i WHERE i.batch_id = b.id),
               version = version + 1
           WHERE b.id = ?`,
          [batchId],
        );
        await connection.execute(
          `INSERT INTO warehouse_work_batch_changes (batch_id, change_type) VALUES (?, 'ITEMS_UPSERTED')`,
          [batchId],
        );
        await connection.commit();
        return { batchId, importedCount: items.length };
      } catch (error) {
        await connection.rollback().catch(() => undefined);
        throw error;
      } finally {
        connection.release();
      }
    },

    async storeItemLabel(session: WarehouseSession, batchIdValue: unknown, firstLegValue: unknown, originalFilenameValue: unknown, pdf: ValidatedLabelPdf) {
      const batchId = uuid(batchIdValue, 'batchId');
      const firstLegTrackingNo = tracking(firstLegValue, 'firstLegTrackingNo');
      const originalFilename = text(originalFilenameValue, 'originalFilename', 255, false) ?? `${firstLegTrackingNo}.pdf`;
      const connection = await mysql.getConnection();
      let itemId = '';
      let assetId = '';
      const key = storageKey(batchId, pdf.sha256);
      try {
        await connection.beginTransaction();
        const [items] = await connection.execute<(RowDataPacket & {
          id: string;
          batch_status: string;
          label_asset_id: string | null;
          asset_status: AssetRow['asset_status'] | null;
        })[]>(
          `SELECT i.id, b.batch_status, i.label_asset_id, a.asset_status
            FROM warehouse_work_batch_items i
            INNER JOIN warehouse_work_batches b ON b.id = i.batch_id
            LEFT JOIN warehouse_work_batch_assets a ON a.id = i.label_asset_id
            WHERE i.batch_id = ? AND i.first_leg_tracking_no = ? LIMIT 1 FOR UPDATE`,
           [batchId, firstLegTrackingNo],
         );
        if (!items[0]) throw new ApiError(404, 'BATCH_ITEM_NOT_FOUND', '未找到对应的批次映射');
        if (items[0].batch_status !== 'DRAFT' && items[0].batch_status !== 'ACTIVE') {
          throw new ApiError(409, 'BATCH_NOT_EDITABLE', '只有草稿或生效中的批次可以上传面单');
        }
        if (items[0].batch_status === 'ACTIVE' && items[0].asset_status === 'READY') {
          throw new ApiError(409, 'LABEL_ALREADY_READY', '生效批次只允许补传缺失面单，不能替换已有可用面单');
        }
        itemId = items[0].id;
        const [assets] = await connection.execute<AssetRow[]>(
          `SELECT id, storage_key, content_sha256, content_type, byte_size, asset_status
           FROM warehouse_work_batch_assets WHERE batch_id = ? AND lookup_key = ? LIMIT 1 FOR UPDATE`,
          [batchId, firstLegTrackingNo],
        );
        assetId = assets[0]?.id ?? randomUUID();
        if (assets[0]?.asset_status === 'READY' && assets[0].content_sha256 === pdf.sha256) {
          await connection.execute(
            `UPDATE warehouse_work_batch_items SET label_asset_id = ? WHERE id = ?`,
            [assetId, itemId],
          );
          await connection.commit();
          return { id: assetId, itemId, sha256: pdf.sha256, byteSize: pdf.byteSize, reused: true };
        }
        await connection.execute(
          `INSERT INTO warehouse_work_batch_assets
             (id, batch_id, lookup_key, original_filename, storage_key, content_sha256,
              byte_size, asset_status, uploaded_by_user_id, uploaded_by_reference)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'STORING', ?, ?)
           ON DUPLICATE KEY UPDATE original_filename = VALUES(original_filename), storage_key = VALUES(storage_key),
             content_sha256 = VALUES(content_sha256), byte_size = VALUES(byte_size), asset_status = 'STORING',
             failure_code = NULL, uploaded_by_user_id = VALUES(uploaded_by_user_id),
             uploaded_by_reference = VALUES(uploaded_by_reference)`,
          [assetId, batchId, firstLegTrackingNo, originalFilename, key, pdf.sha256, pdf.byteSize,
            session.userId, `user:${session.userId}`],
        );
        await connection.commit();
      } catch (error) {
        await connection.rollback().catch(() => undefined);
        throw error;
      } finally {
        connection.release();
      }

      try {
        await storage.put(key, pdf.content);
      } catch {
        await mysql.execute(
          `UPDATE warehouse_work_batch_assets SET asset_status = 'FAILED', failure_code = 'STORAGE_WRITE_FAILED' WHERE id = ?`,
          [assetId],
        );
        throw new ApiError(503, 'LABEL_STORAGE_UNAVAILABLE', '面单存储暂时不可用');
      }
      const finalize = await mysql.getConnection();
      try {
        await finalize.beginTransaction();
        await finalize.execute(
          `UPDATE warehouse_work_batch_assets SET asset_status = 'READY', ready_at = CURRENT_TIMESTAMP(3) WHERE id = ?`,
          [assetId],
        );
        await finalize.execute(
          `UPDATE warehouse_work_batch_items SET label_asset_id = ?, item_version = item_version + 1 WHERE id = ?`,
          [assetId, itemId],
        );
        await finalize.execute(
          `UPDATE warehouse_work_batches b
           SET pdf_count = (SELECT COUNT(*) FROM warehouse_work_batch_assets a WHERE a.batch_id = b.id AND a.asset_status = 'READY'),
               version = version + 1
           WHERE id = ?`,
          [batchId],
        );
        await finalize.execute(
          `INSERT INTO warehouse_work_batch_changes (batch_id, item_id, change_type) VALUES (?, ?, 'ASSET_READY')`,
          [batchId, itemId],
        );
        await finalize.commit();
        return { id: assetId, itemId, sha256: pdf.sha256, byteSize: pdf.byteSize, reused: false };
      } catch (error) {
        await finalize.rollback().catch(() => undefined);
        throw error;
      } finally {
        finalize.release();
      }
    },

    async publishBatch(_session: WarehouseSession, batchIdValue: unknown) {
      const batchId = uuid(batchIdValue, 'batchId');
      const [result] = await mysql.execute<ResultSetHeader>(
        `UPDATE warehouse_work_batches
         SET batch_status = 'ACTIVE', published_at = COALESCE(published_at, CURRENT_TIMESTAMP(3)),
             closed_at = NULL, version = version + 1
         WHERE id = ? AND batch_status = 'DRAFT' AND mapping_count > 0`,
        [batchId],
      );
      if (result.affectedRows !== 1) {
        throw new ApiError(409, 'BATCH_NOT_PUBLISHABLE', '只有至少包含一条 Excel 映射的草稿批次才能发布');
      }
      await mysql.execute(
        `INSERT INTO warehouse_work_batch_changes (batch_id, change_type) VALUES (?, 'BATCH_PUBLISHED')`, [batchId],
      );
      return { id: batchId, status: 'ACTIVE' as const };
    },

    async closeBatch(_session: WarehouseSession, batchIdValue: unknown) {
      const batchId = uuid(batchIdValue, 'batchId');
      const [result] = await mysql.execute<ResultSetHeader>(
        `UPDATE warehouse_work_batches
         SET batch_status = 'CLOSED', closed_at = CURRENT_TIMESTAMP(3), version = version + 1
         WHERE id = ? AND batch_status = 'ACTIVE'`,
        [batchId],
      );
      if (result.affectedRows !== 1) throw new ApiError(409, 'BATCH_NOT_CLOSABLE', '只有生效中的批次可以关闭');
      await mysql.execute(
        `INSERT INTO warehouse_work_batch_changes (batch_id, change_type) VALUES (?, 'BATCH_CLOSED')`, [batchId],
      );
      return { id: batchId, status: 'CLOSED' as const };
    },

    async deleteBatch(_session: WarehouseSession, batchIdValue: unknown) {
      const batchId = uuid(batchIdValue, 'batchId');
      if (!storage.remove) throw new ApiError(501, 'LABEL_STORAGE_DELETE_UNSUPPORTED', '当前面单存储不支持安全删除');
      const connection = await mysql.getConnection();
      try {
        await connection.beginTransaction();
        const [batches] = await connection.execute<(RowDataPacket & {
          mapping_count: number; pdf_count: number;
        })[]>(
          `SELECT mapping_count, pdf_count FROM warehouse_work_batches WHERE id = ? LIMIT 1 FOR UPDATE`, [batchId],
        );
        if (!batches[0]) throw new ApiError(404, 'BATCH_NOT_FOUND', '未找到共享批次');
        const [assets] = await connection.execute<BatchAssetDeletionRow[]>(
          `SELECT storage_key, byte_size FROM warehouse_work_batch_assets WHERE batch_id = ? FOR UPDATE`, [batchId],
        );

        // Each shared-batch asset has a batch-scoped storage key. Remove bytes before
        // metadata so a failed object-store operation leaves the batch retryable.
        for (const key of new Set(assets.map(asset => asset.storage_key))) await storage.remove(key);

        await connection.execute(`DELETE FROM warehouse_work_batch_print_attempts WHERE batch_id = ?`, [batchId]);
        await connection.execute(`DELETE FROM warehouse_work_batch_changes WHERE batch_id = ?`, [batchId]);
        await connection.execute(`DELETE FROM warehouse_work_batch_items WHERE batch_id = ?`, [batchId]);
        await connection.execute(`DELETE FROM warehouse_work_batch_assets WHERE batch_id = ?`, [batchId]);
        const [result] = await connection.execute<ResultSetHeader>(
          `DELETE FROM warehouse_work_batches WHERE id = ?`, [batchId],
        );
        if (result.affectedRows !== 1) throw new ApiError(409, 'BATCH_DELETE_CONFLICT', '共享批次删除状态发生变化，请刷新后重试');
        await connection.commit();
        return {
          id: batchId,
          mappingCount: Number(batches[0].mapping_count),
          pdfCount: Number(batches[0].pdf_count),
          deletedStorageBytes: assets.reduce((sum, asset) => sum + Number(asset.byte_size), 0),
        };
      } catch (error) {
        await connection.rollback().catch(() => undefined);
        throw error;
      } finally {
        connection.release();
      }
    },

    async listItems(batchIdValue: unknown, input: { offset?: unknown; limit?: unknown }) {
      const batchId = uuid(batchIdValue, 'batchId');
      const offset = input.offset === undefined ? 0 : Number(input.offset);
      const limit = input.limit === undefined ? 200 : Number(input.limit);
      if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 500) {
        throw new ApiError(400, 'VALIDATION_ERROR', '分页参数无效');
      }
      const [rows] = await mysql.query<ItemRow[]>(
        `SELECT i.id, i.batch_id, b.batch_name, i.first_leg_tracking_no, i.courier_tracking_no,
                i.label_asset_id, i.item_status, i.item_version, i.claim_token, i.claim_expires_at,
                i.claimed_by_workstation_id, a.asset_status, a.content_sha256, a.byte_size, a.storage_key, i.updated_at
         FROM warehouse_work_batch_items i
         INNER JOIN warehouse_work_batches b ON b.id = i.batch_id
         LEFT JOIN warehouse_work_batch_assets a ON a.id = i.label_asset_id
         WHERE i.batch_id = ? ORDER BY i.created_at, i.id LIMIT ${limit} OFFSET ${offset}`,
        [batchId],
      );
      return rows.map(row => ({
        id: row.id,
        firstLegTrackingNo: row.first_leg_tracking_no,
        courierTrackingNo: row.courier_tracking_no,
        status: row.item_status,
        version: Number(row.item_version),
        labelReady: row.asset_status === 'READY',
        updatedAt: row.updated_at.toISOString(),
      }));
    },

    async listMissingItems(batchIdValue: unknown, input: { offset?: unknown; limit?: unknown }) {
      const batchId = uuid(batchIdValue, 'batchId');
      const offset = input.offset === undefined ? 0 : Number(input.offset);
      const limit = input.limit === undefined ? 500 : Number(input.limit);
      if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 500) {
        throw new ApiError(400, 'VALIDATION_ERROR', '分页参数无效');
      }
      const missingClause = `(i.label_asset_id IS NULL OR a.asset_status <> 'READY' OR a.id IS NULL)`;
      const [countRows] = await mysql.execute<(RowDataPacket & { total: number })[]>(
        `SELECT COUNT(*) AS total
         FROM warehouse_work_batch_items i
         LEFT JOIN warehouse_work_batch_assets a ON a.id = i.label_asset_id
         WHERE i.batch_id = ? AND ${missingClause}`,
        [batchId],
      );
      const [rows] = await mysql.query<(RowDataPacket & {
        first_leg_tracking_no: string;
        courier_tracking_no: string | null;
        asset_status: AssetRow['asset_status'] | null;
        updated_at: Date;
      })[]>(
        `SELECT i.first_leg_tracking_no, i.courier_tracking_no, a.asset_status, i.updated_at
         FROM warehouse_work_batch_items i
         LEFT JOIN warehouse_work_batch_assets a ON a.id = i.label_asset_id
         WHERE i.batch_id = ? AND ${missingClause}
         ORDER BY i.created_at, i.id LIMIT ${limit} OFFSET ${offset}`,
        [batchId],
      );
      return {
        total: Number(countRows[0]?.total ?? 0),
        items: rows.map(row => ({
          firstLegTrackingNo: row.first_leg_tracking_no,
          courierTrackingNo: row.courier_tracking_no,
          reason: row.asset_status === 'FAILED' ? '面单上传失败' : '未匹配面单',
          updatedAt: row.updated_at.toISOString(),
        })),
      };
    },

    async claimItem(session: WarehouseSession, input: { trackingNo: unknown; workstationId: unknown }) {
      const warehouseId = requireWorkspace(session);
      const trackingNo = tracking(input.trackingNo);
      const workstationId = uuid(input.workstationId, 'workstationId');
      const connection = await mysql.getConnection();
      try {
        await connection.beginTransaction();
        const [workstations] = await connection.execute<(RowDataPacket & { id: string })[]>(
          `SELECT id FROM workstations WHERE id = ? AND warehouse_id = ? AND workstation_status = 'ACTIVE' LIMIT 1`,
          [workstationId, warehouseId],
        );
        if (!workstations[0]) throw new ApiError(403, 'WORKSTATION_NOT_ALLOWED', '工作站不可用');
        const [intercepts] = await connection.execute<(RowDataPacket & { tracking_no: string; intercept_reason: string | null })[]>(
          `SELECT tracking_no, intercept_reason FROM global_intercepts
           WHERE tracking_no = ? AND intercept_status = 'ACTIVE' LIMIT 1 FOR UPDATE`,
          [trackingNo],
        );
        if (intercepts[0]) {
          await connection.commit();
          return { blocked: true as const, trackingNo, reason: intercepts[0].intercept_reason };
        }
        const [items] = await connection.execute<ItemRow[]>(
          `SELECT i.id, i.batch_id, b.batch_name, i.first_leg_tracking_no, i.courier_tracking_no,
                  i.label_asset_id, i.item_status, i.item_version, i.claim_token, i.claim_expires_at,
                  i.claimed_by_workstation_id, a.asset_status, a.content_sha256, a.byte_size, a.storage_key, i.updated_at
           FROM warehouse_work_batch_items i
           INNER JOIN warehouse_work_batches b ON b.id = i.batch_id AND b.batch_status = 'ACTIVE'
           LEFT JOIN warehouse_work_batch_assets a ON a.id = i.label_asset_id
           WHERE i.first_leg_tracking_no = ? OR i.courier_tracking_no = ?
           ORDER BY b.published_at DESC LIMIT 2 FOR UPDATE`,
          [trackingNo, trackingNo],
        );
        if (items.length === 0) throw new ApiError(404, 'BATCH_ITEM_NOT_FOUND', '当前生效批次中未找到该单号');
        if (items.length > 1) throw new ApiError(409, 'AMBIGUOUS_BATCH_ITEM', '该单号同时存在于多个生效批次，请先关闭旧批次');
        const item = items[0];
        const itemTrackingNumbers = mappedTrackingNumbers(item.first_leg_tracking_no, item.courier_tracking_no);
        const [mappedIntercepts] = await connection.query<(RowDataPacket & { tracking_no: string; intercept_reason: string | null })[]>(
          `SELECT tracking_no, intercept_reason FROM global_intercepts
           WHERE intercept_status = 'ACTIVE' AND tracking_no IN (${itemTrackingNumbers.map(() => '?').join(', ')})
           LIMIT 1 FOR UPDATE`,
          itemTrackingNumbers,
        );
        if (mappedIntercepts[0]) {
          await connection.commit();
          return {
            blocked: true as const,
            trackingNo: mappedIntercepts[0].tracking_no,
            reason: mappedIntercepts[0].intercept_reason,
          };
        }
        if (item.item_status === 'SUBMITTED') throw new ApiError(409, 'ITEM_ALREADY_SUBMITTED', '该单号已完成打印');
        if (item.item_status === 'RESULT_UNKNOWN') {
          throw new ApiError(409, 'ITEM_RESULT_UNKNOWN', '上次打印结果未知，为避免重复打印已阻断，请由主管复核');
        }
        if (!item.label_asset_id || item.asset_status !== 'READY') throw new ApiError(409, 'LABEL_NOT_READY', '该单号尚无可用面单');
        if (item.item_status === 'CLAIMED' && item.claim_expires_at && item.claim_expires_at.getTime() > Date.now()
            && item.claimed_by_workstation_id !== workstationId) {
          throw new ApiError(409, 'ITEM_CLAIMED', '该单号正在由另一台工作站处理');
        }
        const claimToken = randomUUID();
        await connection.execute(
          `UPDATE warehouse_work_batch_items
           SET item_status = 'CLAIMED', claimed_by_user_id = ?, claimed_by_workstation_id = ?,
               claim_token = ?, claim_expires_at = DATE_ADD(CURRENT_TIMESTAMP(3), INTERVAL 2 MINUTE),
               item_version = item_version + 1
           WHERE id = ?`,
          [session.userId, workstationId, claimToken, item.id],
        );
        await connection.execute(
          `INSERT INTO warehouse_work_batch_changes (batch_id, item_id, change_type) VALUES (?, ?, 'ITEM_CLAIMED')`,
          [item.batch_id, item.id],
        );
        await connection.commit();
        return {
          blocked: false as const,
          claimToken,
          item: {
            id: item.id,
            batchId: item.batch_id,
            batchName: item.batch_name,
            firstLegTrackingNo: item.first_leg_tracking_no,
            courierTrackingNo: item.courier_tracking_no,
            labelAssetId: item.label_asset_id,
            labelDownloadPath: `/warehouse/v1/shared-label-assets/${item.label_asset_id}/content`,
            labelSha256: item.content_sha256,
            labelByteSize: Number(item.byte_size),
          },
        };
      } catch (error) {
        await connection.rollback().catch(() => undefined);
        throw error;
      } finally {
        connection.release();
      }
    },

    async completeItem(session: WarehouseSession, itemIdValue: unknown, input: Record<string, unknown>) {
      const itemId = uuid(itemIdValue, 'itemId');
      const workstationId = uuid(input.workstationId, 'workstationId');
      const clientAttemptId = uuid(input.clientAttemptId, 'clientAttemptId');
      const claimToken = uuid(input.claimToken, 'claimToken');
      const outcome = text(input.outcome, 'outcome', 32)!;
      if (!['SUBMITTED', 'FAILED', 'RESULT_UNKNOWN', 'BLOCKED'].includes(outcome)) throw new ApiError(400, 'VALIDATION_ERROR', 'outcome 不受支持');
      const printerName = text(input.printerName, 'printerName', 255, false);
      const message = text(input.message, 'message', 1024, false);
      const occurredAtValue = text(input.occurredAt, 'occurredAt', 64)!;
      const occurredAt = new Date(occurredAtValue);
      if (Number.isNaN(occurredAt.getTime()) || Math.abs(Date.now() - occurredAt.getTime()) > 7 * 86_400_000) {
        throw new ApiError(400, 'VALIDATION_ERROR', 'occurredAt 必须是七天内的有效时间');
      }
      const payloadHash = createHash('sha256').update(JSON.stringify({
        itemId, workstationId, clientAttemptId, claimToken, outcome, printerName, message,
        occurredAt: occurredAt.toISOString(),
      })).digest('hex');
      const connection = await mysql.getConnection();
      try {
        await connection.beginTransaction();
        const [items] = await connection.execute<ItemRow[]>(
          `SELECT i.id, i.batch_id, b.batch_name, i.first_leg_tracking_no, i.courier_tracking_no,
                  i.label_asset_id, i.item_status, i.item_version, i.claim_token, i.claim_expires_at,
                  i.claimed_by_workstation_id, a.asset_status, a.content_sha256, a.byte_size, a.storage_key, i.updated_at
           FROM warehouse_work_batch_items i
           INNER JOIN warehouse_work_batches b ON b.id = i.batch_id
           LEFT JOIN warehouse_work_batch_assets a ON a.id = i.label_asset_id
           WHERE i.id = ? LIMIT 1 FOR UPDATE`,
          [itemId],
        );
        const item = items[0];
        if (!item) throw new ApiError(404, 'BATCH_ITEM_NOT_FOUND', '未找到批次单号');
        const [existing] = await connection.execute<AttemptRow[]>(
          `SELECT id, payload_sha256, outcome, created_at FROM warehouse_work_batch_print_attempts
           WHERE workstation_id = ? AND client_attempt_id = ? LIMIT 1`,
          [workstationId, clientAttemptId],
        );
        if (existing[0]) {
          if (existing[0].payload_sha256 !== payloadHash) throw new ApiError(409, 'IDEMPOTENCY_CONFLICT', 'clientAttemptId 已用于不同请求');
          await connection.commit();
          return { id: existing[0].id, outcome: existing[0].outcome, replayed: true };
        }
        // A workstation persists QZ outcomes locally before sending them. Accept
        // a late result for the same claim token as long as no other workstation
        // has reclaimed the item in the meantime.
        if (!canCompleteClaim(
          { claimToken: item.claim_token, workstationId: item.claimed_by_workstation_id },
          claimToken,
          workstationId,
        )) {
          throw new ApiError(409, 'CLAIM_REPLACED', '处理权已被其他工作站接管，当前结果不能覆盖新状态');
        }
        if (!item.label_asset_id) throw new ApiError(409, 'LABEL_NOT_READY', '面单不可用');
        const attemptId = randomUUID();
        await connection.execute(
          `INSERT INTO warehouse_work_batch_print_attempts
             (id, batch_id, item_id, label_asset_id, user_id, actor_reference, workstation_id,
              client_attempt_id, claim_token, payload_sha256, outcome, printer_name, message, occurred_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [attemptId, item.batch_id, item.id, item.label_asset_id, session.userId, `user:${session.userId}`,
            workstationId, clientAttemptId, claimToken, payloadHash, outcome, printerName, message, occurredAt],
        );
        const nextStatus = completionStatus(outcome as SharedPrintOutcome);
        await connection.execute(
          `UPDATE warehouse_work_batch_items
           SET item_status = ?, item_version = item_version + 1, claim_token = NULL, claim_expires_at = NULL,
               claimed_by_user_id = NULL, claimed_by_workstation_id = NULL,
               last_outcome_message = ?, completed_at = CASE WHEN ? = 'SUBMITTED' THEN ? ELSE completed_at END
           WHERE id = ?`,
          [nextStatus, message, nextStatus, occurredAt, item.id],
        );
        await connection.execute(
          `INSERT INTO warehouse_work_batch_changes (batch_id, item_id, change_type) VALUES (?, ?, 'ITEM_COMPLETED')`,
          [item.batch_id, item.id],
        );
        await connection.commit();
        return { id: attemptId, outcome, replayed: false };
      } catch (error) {
        await connection.rollback().catch(() => undefined);
        throw error;
      } finally {
        connection.release();
      }
    },

    async openAsset(assetIdValue: unknown): Promise<{ metadata: AssetRow; object: LabelStorageObject }> {
      const assetId = uuid(assetIdValue, 'assetId');
      const [rows] = await mysql.execute<AssetRow[]>(
        `SELECT id, storage_key, content_sha256, content_type, byte_size, asset_status
         FROM warehouse_work_batch_assets WHERE id = ? AND asset_status = 'READY' LIMIT 1`,
        [assetId],
      );
      if (!rows[0]) throw new ApiError(404, 'LABEL_NOT_FOUND', '面单不存在或尚未就绪');
      const object = await storage.open(rows[0].storage_key).catch(() => {
        throw new ApiError(503, 'LABEL_STORAGE_UNAVAILABLE', '面单文件暂时不可用');
      });
      if (object.byteSize !== Number(rows[0].byte_size)) {
        object.stream.destroy();
        throw new ApiError(503, 'LABEL_STORAGE_MISMATCH', '面单文件校验失败');
      }
      return { metadata: rows[0], object };
    },

    async listIntercepts(input: { cursor?: unknown; limit?: unknown }) {
      const cursor = input.cursor === undefined || input.cursor === '' ? '0' : String(input.cursor);
      if (!/^[0-9]+$/.test(cursor)) throw new ApiError(400, 'VALIDATION_ERROR', 'cursor 无效');
      const limit = input.limit === undefined ? 500 : Number(input.limit);
      if (!Number.isInteger(limit) || limit < 1 || limit > 2_000) throw new ApiError(400, 'VALIDATION_ERROR', 'limit 必须为 1 到 2,000');
      const [rows] = await mysql.query<InterceptRow[]>(
        `SELECT gi.id, gi.tracking_no, gi.intercept_reason, gi.source_type, gi.intercept_status,
                gi.updated_at, changes.revision
         FROM global_intercept_changes changes
         INNER JOIN global_intercepts gi ON gi.id = changes.intercept_id
         WHERE changes.revision > ? ORDER BY changes.revision ASC LIMIT ${limit}`,
        [cursor],
      );
      const unique = [...new Map(rows.map(row => [row.id, row])).values()];
      return {
        entries: unique.map(row => ({
          id: row.id,
          trackingNo: row.tracking_no,
          reason: row.intercept_reason,
          source: row.source_type,
          status: row.intercept_status,
          updatedAt: row.updated_at.toISOString(),
        })),
        cursor: rows.length ? String(rows.at(-1)!.revision) : cursor,
        hasMore: rows.length === limit,
      };
    },

    async checkIntercepts(input: { trackingNumbers: unknown }) {
      if (!Array.isArray(input.trackingNumbers) || input.trackingNumbers.length < 1 || input.trackingNumbers.length > 10) {
        throw new ApiError(400, 'VALIDATION_ERROR', 'trackingNumbers 必须包含 1 到 10 个单号');
      }
      const trackingNumbers = [...new Set(input.trackingNumbers.map((value, index) => tracking(value, `trackingNumbers[${index}]`)))];
      const [rows] = await mysql.query<(RowDataPacket & { tracking_no: string; intercept_reason: string | null })[]>(
        `SELECT tracking_no, intercept_reason FROM global_intercepts
         WHERE intercept_status = 'ACTIVE' AND tracking_no IN (${trackingNumbers.map(() => '?').join(', ')})
         ORDER BY updated_at DESC LIMIT 1`,
        trackingNumbers,
      );
      return rows[0]
        ? { blocked: true as const, trackingNo: rows[0].tracking_no, reason: rows[0].intercept_reason }
        : { blocked: false as const };
    },

    async upsertIntercepts(session: WarehouseSession, input: { entries: unknown; source?: unknown }) {
      if (!Array.isArray(input.entries) || input.entries.length < 1 || input.entries.length > 1_000) {
        throw new ApiError(400, 'VALIDATION_ERROR', 'entries 每批需包含 1 到 1,000 条拦截记录');
      }
      const source = input.source === undefined ? 'MANUAL' : text(input.source, 'source', 32)!;
      if (!['MANUAL', 'BULK_IMPORT', 'UPSTREAM'].includes(source)) throw new ApiError(400, 'VALIDATION_ERROR', 'source 不受支持');
      const entries = input.entries.map((value, index) => {
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ApiError(400, 'VALIDATION_ERROR', `entries[${index}] 必须是对象`);
        const row = value as Record<string, unknown>;
        return { trackingNo: tracking(row.trackingNo, `entries[${index}].trackingNo`), reason: text(row.reason, 'reason', 512, false) };
      });
      const connection = await mysql.getConnection();
      try {
        await connection.beginTransaction();
        for (const entry of entries) {
          const [existing] = await connection.execute<(RowDataPacket & { id: string })[]>(
            `SELECT id FROM global_intercepts WHERE tracking_no = ? LIMIT 1 FOR UPDATE`, [entry.trackingNo],
          );
          const id = existing[0]?.id ?? randomUUID();
          await connection.execute(
            `INSERT INTO global_intercepts
               (id, tracking_no, intercept_reason, source_type, created_by_user_id, created_by_reference,
                updated_by_user_id, updated_by_reference)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE intercept_reason = VALUES(intercept_reason), source_type = VALUES(source_type),
               intercept_status = 'ACTIVE', updated_by_user_id = VALUES(updated_by_user_id),
               updated_by_reference = VALUES(updated_by_reference)`,
            [id, entry.trackingNo, entry.reason, source, session.userId, `user:${session.userId}`,
              session.userId, `user:${session.userId}`],
          );
          await connection.execute(
            `INSERT INTO global_intercept_changes (intercept_id, change_type) VALUES (?, 'UPSERTED')`, [id],
          );
        }
        await connection.commit();
        return { importedCount: entries.length };
      } catch (error) {
        await connection.rollback().catch(() => undefined);
        throw error;
      } finally {
        connection.release();
      }
    },

    async removeIntercept(session: WarehouseSession, trackingNoValue: unknown) {
      const trackingNo = tracking(trackingNoValue);
      const connection = await mysql.getConnection();
      try {
        await connection.beginTransaction();
        const [rows] = await connection.execute<(RowDataPacket & { id: string })[]>(
          `SELECT id FROM global_intercepts WHERE tracking_no = ? LIMIT 1 FOR UPDATE`, [trackingNo],
        );
        if (!rows[0]) throw new ApiError(404, 'INTERCEPT_NOT_FOUND', '未找到拦截单号');
        await connection.execute(
          `UPDATE global_intercepts SET intercept_status = 'REMOVED', updated_by_user_id = ?, updated_by_reference = ? WHERE id = ?`,
          [session.userId, `user:${session.userId}`, rows[0].id],
        );
        await connection.execute(
          `INSERT INTO global_intercept_changes (intercept_id, change_type) VALUES (?, 'REMOVED')`, [rows[0].id],
        );
        await connection.commit();
      } catch (error) {
        await connection.rollback().catch(() => undefined);
        throw error;
      } finally {
        connection.release();
      }
    },
  };
}

export type SharedWarehouseWork = ReturnType<typeof createSharedWarehouseWork>;
