import { randomUUID } from 'node:crypto';
import type { RowDataPacket } from 'mysql2';
import type { Pool, PoolConnection } from 'mysql2/promise';
import type { AuthenticatedClient } from './auth.js';
import { ApiError } from './errors.js';
import type { ValidatedLabelPdf } from './labelPdf.js';
import type { LabelStorage } from './labelStorage.js';
import type { ShipmentStatus } from './shipmentInput.js';

const staleUploadMilliseconds = 5 * 60_000;

type ShipmentAssetRow = RowDataPacket & {
  id: string;
  label_sha256: string | null;
  current_label_asset_id: string | null;
  status: ShipmentStatus;
};

type LabelAssetRow = RowDataPacket & {
  id: string;
  storage_key: string;
  asset_status: 'STORING' | 'READY' | 'FAILED';
  updated_at: Date;
};

export type StoredLabelAsset = {
  id: string;
  shipmentId: string;
  sha256: string;
  byteSize: number;
  contentType: 'application/pdf';
  shipmentStatus: ShipmentStatus;
  reused: boolean;
};

export type StoreLabelRequest = {
  client: AuthenticatedClient;
  requestId: string;
  firstLegTrackingNo: string;
  pdf: ValidatedLabelPdf;
};

function storageKeyFor(clientId: string, shipmentId: string, sha256: string): string {
  return `labels/${clientId}/${shipmentId}/${sha256}.pdf`;
}

function readyStatus(status: ShipmentStatus): ShipmentStatus {
  return status === 'RECEIVED' ? 'READY_TO_PRINT' : status;
}

async function writeLabelStoredEvent(connection: PoolConnection, input: {
  clientId: string;
  apiKeyId: string;
  shipmentId: string;
  requestId: string;
  assetId: string;
  sha256: string;
  byteSize: number;
}): Promise<void> {
  await connection.execute(
    `INSERT INTO shipment_events
     (id, client_id, shipment_id, request_id, event_type, actor_type, actor_id, event_data)
     VALUES (?, ?, ?, ?, 'LABEL_STORED', 'UPSTREAM_API_KEY', ?, ?)`,
    [
      randomUUID(), input.clientId, input.shipmentId, input.requestId, input.apiKeyId,
      JSON.stringify({ assetId: input.assetId, sha256: input.sha256, byteSize: input.byteSize }),
    ],
  );
}

export function createLabelAssetModule(dependencies: { mysql: Pool; storage: LabelStorage }) {
  return {
    async storePushedPdf(request: StoreLabelRequest): Promise<StoredLabelAsset> {
      const connection = await dependencies.mysql.getConnection();
      let shipment!: ShipmentAssetRow;
      let assetId!: string;
      let storageKey!: string;
      let reused = false;
      try {
        await connection.beginTransaction();
        const [shipmentRows] = await connection.execute<ShipmentAssetRow[]>(
          `SELECT id, label_sha256, current_label_asset_id, status
           FROM shipments
           WHERE client_id = ? AND first_leg_tracking_no = ?
           LIMIT 1 FOR UPDATE`,
          [request.client.id, request.firstLegTrackingNo],
        );
        shipment = shipmentRows[0];
        if (!shipment) throw new ApiError(404, 'SHIPMENT_NOT_FOUND', '未找到对应物流单据');
        if (shipment.label_sha256 && shipment.label_sha256 !== request.pdf.sha256) {
          throw new ApiError(422, 'LABEL_HASH_MISMATCH', 'PDF 内容与物流单据声明的 labelSha256 不一致');
        }

        const [assetRows] = await connection.execute<LabelAssetRow[]>(
          `SELECT id, storage_key, asset_status, updated_at
           FROM label_assets
           WHERE shipment_id = ? AND content_sha256 = ?
           LIMIT 1 FOR UPDATE`,
          [shipment.id, request.pdf.sha256],
        );
        const existing = assetRows[0];
        if (existing?.asset_status === 'READY') {
          assetId = existing.id;
          storageKey = existing.storage_key;
          reused = true;
          const nextStatus = readyStatus(shipment.status);
          if (shipment.current_label_asset_id !== existing.id || nextStatus !== shipment.status) {
            await connection.execute(
              `UPDATE shipments
               SET current_label_asset_id = ?, label_sha256 = ?, status = ?, version = version + 1
               WHERE id = ?`,
              [existing.id, request.pdf.sha256, nextStatus, shipment.id],
            );
            await connection.execute(
              `INSERT INTO shipment_delivery_changes (client_id, shipment_id, change_type)
               VALUES (?, ?, 'LABEL_READY')`,
              [request.client.id, shipment.id],
            );
          }
          await connection.commit();
        } else {
          if (
            existing?.asset_status === 'STORING'
            && Date.now() - existing.updated_at.getTime() < staleUploadMilliseconds
          ) {
            throw new ApiError(409, 'LABEL_UPLOAD_IN_PROGRESS', '相同 PDF 面单正在保存，请稍后重试');
          }

          assetId = existing?.id ?? randomUUID();
          storageKey = existing?.storage_key ?? storageKeyFor(request.client.id, shipment.id, request.pdf.sha256);
          if (existing) {
            await connection.execute(
              `UPDATE label_assets
               SET uploaded_by_api_key_id = ?, asset_status = 'STORING', failure_code = NULL
               WHERE id = ?`,
              [request.client.apiKeyId, assetId],
            );
          } else {
            await connection.execute(
              `INSERT INTO label_assets
               (id, client_id, shipment_id, uploaded_by_api_key_id, source_type, storage_key,
                content_sha256, content_type, byte_size, asset_status)
               VALUES (?, ?, ?, ?, 'UPSTREAM_PUSH', ?, ?, 'application/pdf', ?, 'STORING')`,
              [
                assetId, request.client.id, shipment.id, request.client.apiKeyId,
                storageKey, request.pdf.sha256, request.pdf.byteSize,
              ],
            );
          }
          await connection.commit();
        }
      } catch (error) {
        await connection.rollback().catch(() => undefined);
        throw error;
      } finally {
        connection.release();
      }

      try {
        await dependencies.storage.put(storageKey, request.pdf.content);
      } catch (error) {
        const failed = await dependencies.mysql.getConnection().catch(() => undefined);
        if (failed) {
          try {
            await failed.beginTransaction();
            await failed.execute(
              `UPDATE label_assets SET asset_status = 'FAILED', failure_code = 'STORAGE_WRITE_FAILED' WHERE id = ?`,
              [assetId],
            );
            await failed.execute(
              `UPDATE shipments
               SET current_label_asset_id = NULL,
                   status = CASE WHEN status = 'READY_TO_PRINT' THEN 'RECEIVED' ELSE status END,
                   version = version + 1
               WHERE id = ? AND current_label_asset_id = ?`,
              [shipment.id, assetId],
            );
            await failed.execute(
              `INSERT INTO shipment_delivery_changes (client_id, shipment_id, change_type)
               VALUES (?, ?, 'LABEL_UNAVAILABLE')`,
              [request.client.id, shipment.id],
            );
            await failed.commit();
          } catch {
            await failed.rollback().catch(() => undefined);
          } finally {
            failed.release();
          }
        }
        console.error('Failed to write private label asset.', { requestId: request.requestId, assetId, error });
        throw new ApiError(503, 'LABEL_STORAGE_UNAVAILABLE', '面单存储暂时不可用，请稍后重试');
      }

      if (reused) {
        return {
          id: assetId,
          shipmentId: shipment.id,
          sha256: request.pdf.sha256,
          byteSize: request.pdf.byteSize,
          contentType: 'application/pdf',
          shipmentStatus: readyStatus(shipment.status),
          reused: true,
        };
      }

      const finalize = await dependencies.mysql.getConnection();
      try {
        await finalize.beginTransaction();
        const [currentRows] = await finalize.execute<ShipmentAssetRow[]>(
          `SELECT id, label_sha256, current_label_asset_id, status
           FROM shipments WHERE id = ? LIMIT 1 FOR UPDATE`,
          [shipment.id],
        );
        const currentShipment = currentRows[0];
        if (!currentShipment) throw new Error('Shipment disappeared while storing its label asset.');
        if (currentShipment.label_sha256 && currentShipment.label_sha256 !== request.pdf.sha256) {
          await finalize.execute(
            `UPDATE label_assets
             SET asset_status = 'FAILED', failure_code = 'LABEL_SUPERSEDED'
             WHERE id = ?`,
            [assetId],
          );
          await finalize.commit();
          throw new ApiError(409, 'LABEL_SUPERSEDED', '物流单据已声明更新的面单，请上传最新文件');
        }
        const nextStatus = readyStatus(currentShipment.status);
        await finalize.execute(
          `UPDATE label_assets
           SET asset_status = 'READY', failure_code = NULL, ready_at = CURRENT_TIMESTAMP(3)
           WHERE id = ?`,
          [assetId],
        );
        await finalize.execute(
          `UPDATE shipments
           SET current_label_asset_id = ?, label_sha256 = ?, status = ?, version = version + 1
           WHERE id = ?`,
          [assetId, request.pdf.sha256, nextStatus, shipment.id],
        );
        await finalize.execute(
          `INSERT INTO shipment_delivery_changes (client_id, shipment_id, change_type)
           VALUES (?, ?, 'LABEL_READY')`,
          [request.client.id, shipment.id],
        );
        await writeLabelStoredEvent(finalize, {
          clientId: request.client.id,
          apiKeyId: request.client.apiKeyId,
          shipmentId: shipment.id,
          requestId: request.requestId,
          assetId,
          sha256: request.pdf.sha256,
          byteSize: request.pdf.byteSize,
        });
        await finalize.commit();
        return {
          id: assetId,
          shipmentId: shipment.id,
          sha256: request.pdf.sha256,
          byteSize: request.pdf.byteSize,
          contentType: 'application/pdf',
          shipmentStatus: nextStatus,
          reused: false,
        };
      } catch (error) {
        await finalize.rollback().catch(() => undefined);
        throw error;
      } finally {
        finalize.release();
      }
    },
  };
}
