import type { RowDataPacket } from 'mysql2';
import type { Pool, PoolConnection } from 'mysql2/promise';
import type { LabelStorage } from './labelStorage.js';

type Asset = RowDataPacket & {
  id: string;
  shipment_id: string;
  client_id: string;
  storage_key: string;
};

export type LabelRetentionResult = {
  locked: boolean;
  scanned: number;
  expired: number;
  deleted: number;
  deleteFailures: number;
  skipped: number;
};

// Always lock shipment before asset, exactly as publication/renewal writers do.
async function lockExpiredAsset(connection: PoolConnection, candidate: Asset) {
  const [shipments] = await connection.execute<(RowDataPacket & { current_label_asset_id: string | null })[]>(
    'SELECT id, current_label_asset_id FROM shipments WHERE id = ? FOR UPDATE', [candidate.shipment_id],
  );
  const [assets] = await connection.execute<Asset[]>(
    `SELECT id, client_id, shipment_id, storage_key FROM label_assets
     WHERE id = ? AND storage_key = ? AND expires_at <= UTC_TIMESTAMP(3)
       AND bytes_deleted_at IS NULL AND asset_status <> 'STORING' FOR UPDATE`,
    [candidate.id, candidate.storage_key],
  );
  return shipments[0] && assets[0] ? { shipment: shipments[0], asset: assets[0] } : undefined;
}

export function createLabelRetentionWorker(dependencies: {
  mysql: Pool;
  storage: LabelStorage;
  batchSize?: number;
  deleteAttempts?: number;
}) {
  const batchSize = dependencies.batchSize ?? 100;
  const deleteAttempts = dependencies.deleteAttempts ?? 3;
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 1000) throw new Error('Invalid retention batchSize.');
  if (!Number.isInteger(deleteAttempts) || deleteAttempts < 1 || deleteAttempts > 5) throw new Error('Invalid retention deleteAttempts.');
  const remove = dependencies.storage.remove?.bind(dependencies.storage);
  if (!remove) throw new Error('LABEL_RETENTION_REMOVE_UNAVAILABLE');
  // Move past persistent storage failures so they cannot starve later rows.
  // This cursor resets at the end of a sweep and after process restart.
  let afterId = '';

  return {
    async runOnce(): Promise<LabelRetentionResult> {
      const result: LabelRetentionResult = { locked: false, scanned: 0, expired: 0, deleted: 0, deleteFailures: 0, skipped: 0 };
      const connection = await dependencies.mysql.getConnection();
      let reusable = true;
      try {
        const [locks] = await connection.execute<(RowDataPacket & { acquired: number | null })[]>(
          "SELECT GET_LOCK('cmhub.label-retention', 0) AS acquired",
        );
        if (locks[0]?.acquired !== 1) return result;
        result.locked = true;
        const [candidates] = await connection.execute<Asset[]>(
          `SELECT id, client_id, shipment_id, storage_key FROM label_assets
           WHERE expires_at <= UTC_TIMESTAMP(3) AND bytes_deleted_at IS NULL
             AND asset_status <> 'STORING' AND id > ? ORDER BY id LIMIT ${batchSize}`,
          [afterId],
        );
        result.scanned = candidates.length;
        for (const candidate of candidates) {
          await connection.beginTransaction();
          const current = await lockExpiredAsset(connection, candidate);
          if (!current) {
            await connection.commit();
            result.skipped++;
            continue;
          }
          await connection.execute(
            "UPDATE label_assets SET asset_status = 'FAILED', failure_code = 'LABEL_EXPIRED' WHERE id = ?",
            [candidate.id],
          );
          if (current.shipment.current_label_asset_id === candidate.id) {
            await connection.execute(
              `UPDATE shipments SET current_label_asset_id = NULL,
               status = CASE WHEN status = 'READY_TO_PRINT' THEN 'RECEIVED' ELSE status END,
               version = version + 1 WHERE id = ? AND current_label_asset_id = ?`,
              [candidate.shipment_id, candidate.id],
            );
            await connection.execute(
              `INSERT INTO shipment_delivery_changes (client_id, shipment_id, change_type)
               VALUES (?, ?, 'LABEL_UNAVAILABLE')`,
              [candidate.client_id, candidate.shipment_id],
            );
          }
          await connection.commit();
          result.expired++;

          await connection.beginTransaction();
          // A renewal between transactions changes its key or expiration. Never
          // remove that version. Hold the locks during removal and its DB marker.
          if (!await lockExpiredAsset(connection, candidate)) {
            await connection.commit();
            result.skipped++;
            continue;
          }
          let removed = false;
          for (let attempt = 0; attempt < deleteAttempts; attempt++) {
            try {
              await remove(candidate.storage_key);
              removed = true;
              break;
            } catch {
              // No provider error or storage key is logged; next sweep retries.
            }
          }
          if (!removed) {
            await connection.rollback();
            result.deleteFailures++;
            continue;
          }
          await connection.execute(
            'UPDATE label_assets SET bytes_deleted_at = CURRENT_TIMESTAMP(3) WHERE id = ? AND storage_key = ?',
            [candidate.id, candidate.storage_key],
          );
          await connection.commit();
          result.deleted++;
        }
        afterId = candidates.length === batchSize ? candidates[candidates.length - 1].id : '';
        return result;
      } catch (error) {
        await connection.rollback().catch(() => undefined);
        throw error;
      } finally {
        if (result.locked) {
          try {
            await connection.execute("SELECT RELEASE_LOCK('cmhub.label-retention') AS released");
          } catch {
            // Never return a pooled session that may still own the advisory lock.
            reusable = false;
            connection.destroy();
          }
        }
        if (reusable) connection.release();
      }
    },
  };
}
