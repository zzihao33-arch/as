import { randomUUID } from 'node:crypto';
import type { RowDataPacket } from 'mysql2';
import type { PoolConnection } from 'mysql2/promise';
import type { AuthenticatedClient } from './auth.js';
import { ApiError } from './errors.js';
import type { ValidatedLabelPdf } from './labelPdf.js';
import type { LabelStorage } from './labelStorage.js';

export type StagedLabel = {
  storageKey: string;
  sha256: string;
  byteSize: number;
  expiresAt: Date;
};

export function requireInlineLabelScope(client: AuthenticatedClient, inputs: { labelPdf?: ValidatedLabelPdf }[]): void {
  if (inputs.some(input => input.labelPdf) && !client.scopes.includes('labels:write')) {
    throw new ApiError(403, 'INSUFFICIENT_SCOPE', '当前 API Key 缺少 labels:write 权限。');
  }
}

// Upload outside the DB transaction. Each acceptance uses new immutable keys:
// renewing identical bytes cannot race deletion of a previously expired object.
export async function stageInlineLabels(
  clientId: string,
  inputs: { labelPdf?: ValidatedLabelPdf }[],
  storage?: LabelStorage,
): Promise<(StagedLabel | undefined)[]> {
  const staged: (StagedLabel | undefined)[] = new Array(inputs.length);
  if (!inputs.some(input => input.labelPdf)) return staged;
  if (!storage) throw new ApiError(503, 'LABEL_STORAGE_UNAVAILABLE', '面单存储尚未配置。');
  let next = 0;
  let failed = false;
  async function worker() {
    while (!failed && next < inputs.length) {
      const index = next++;
      const pdf = inputs[index].labelPdf;
      if (!pdf) continue;
      const storageKey = `labels/${clientId}/uploads/${randomUUID()}/${pdf.sha256}.pdf`;
      const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
      try {
        await storage!.put(storageKey, pdf.content);
        staged[index] = { storageKey, sha256: pdf.sha256, byteSize: pdf.byteSize, expiresAt };
      } catch {
        failed = true;
      }
    }
  }
  // Wait for every started upload before reporting failure. Successful orphan
  // objects are private and expire through the COS labels/ lifecycle rule.
  await Promise.all(Array.from({ length: Math.min(4, inputs.length) }, worker));
  if (failed) throw new ApiError(503, 'LABEL_STORAGE_UNAVAILABLE', '面单存储暂时不可用，请使用相同幂等键重试。');
  return staged;
}

// Caller owns an open transaction and the shipment row lock. This never commits.
export async function publishInlineLabel(connection: PoolConnection, input: {
  client: AuthenticatedClient;
  shipmentId: string;
  requestId: string;
  label: StagedLabel;
}): Promise<{ assetId: string; reused: boolean }> {
  const { client, shipmentId, requestId, label } = input;
  if (label.expiresAt.getTime() <= Date.now()) {
    throw new ApiError(503, 'LABEL_UPLOAD_EXPIRED', '面单暂存已过期，请重试。');
  }
  const [rows] = await connection.execute<(RowDataPacket & { id: string })[]>(
    `SELECT id FROM label_assets WHERE shipment_id = ? AND content_sha256 = ? LIMIT 1 FOR UPDATE`,
    [shipmentId, label.sha256],
  );
  const assetId = rows[0]?.id ?? randomUUID();
  if (rows[0]) {
    await connection.execute(
      `UPDATE label_assets SET storage_key = ?, byte_size = ?, uploaded_by_api_key_id = ?,
         asset_status = 'READY', failure_code = NULL, ready_at = CURRENT_TIMESTAMP(3),
         expires_at = ?, bytes_deleted_at = NULL WHERE id = ?`,
      [label.storageKey, label.byteSize, client.apiKeyId, label.expiresAt, assetId],
    );
  } else {
    await connection.execute(
      `INSERT INTO label_assets
        (id, client_id, shipment_id, uploaded_by_api_key_id, source_type, storage_key,
         content_sha256, content_type, byte_size, asset_status, ready_at, expires_at)
       VALUES (?, ?, ?, ?, 'UPSTREAM_PUSH', ?, ?, 'application/pdf', ?, 'READY', CURRENT_TIMESTAMP(3), ?)`,
      [assetId, client.id, shipmentId, client.apiKeyId, label.storageKey, label.sha256, label.byteSize, label.expiresAt],
    );
  }
  await connection.execute(
    `UPDATE shipments SET current_label_asset_id = ?, label_sha256 = ?,
       status = CASE WHEN status = 'RECEIVED' THEN 'READY_TO_PRINT' ELSE status END,
       version = version + 1 WHERE id = ? AND client_id = ?`,
    [assetId, label.sha256, shipmentId, client.id],
  );
  await connection.execute(
    `INSERT INTO shipment_events
      (id, client_id, shipment_id, request_id, event_type, actor_type, actor_id, event_data)
     VALUES (?, ?, ?, ?, 'LABEL_STORED', 'UPSTREAM_API_KEY', ?, ?)`,
    [randomUUID(), client.id, shipmentId, requestId, client.apiKeyId,
      JSON.stringify({ assetId, sha256: label.sha256, byteSize: label.byteSize, expiresAt: label.expiresAt.toISOString() })],
  );
  await connection.execute(
    `INSERT INTO shipment_delivery_changes (client_id, shipment_id, change_type) VALUES (?, ?, 'LABEL_READY')`,
    [client.id, shipmentId],
  );
  return { assetId, reused: Boolean(rows[0]) };
}
