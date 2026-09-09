import type { RowDataPacket } from 'mysql2';
import type { Pool } from 'mysql2/promise';
import type { AuthenticatedClient } from './auth.js';
import { ApiError } from './errors.js';
import { publishInlineLabel, stageInlineLabels } from './inlineLabels.js';
import type { ValidatedLabelPdf } from './labelPdf.js';
import type { LabelStorage } from './labelStorage.js';
import type { ShipmentStatus } from './shipmentInput.js';

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

export function createLabelAssetModule(dependencies: { mysql: Pool; storage: LabelStorage }) {
  return {
    async storePushedPdf(request: StoreLabelRequest): Promise<StoredLabelAsset> {
      // Use the same immutable staging/publication path as the unified push.
      // The HTTP layer already validates the uploaded bytes and declared hash.
      const [label] = await stageInlineLabels(request.client.id, [{ labelPdf: request.pdf }], dependencies.storage);
      const connection = await dependencies.mysql.getConnection();
      try {
        await connection.beginTransaction();
        const [rows] = await connection.execute<(RowDataPacket & { id: string; status: ShipmentStatus })[]>(
          `SELECT id, status FROM shipments WHERE client_id = ? AND first_leg_tracking_no = ? LIMIT 1 FOR UPDATE`,
          [request.client.id, request.firstLegTrackingNo],
        );
        const shipment = rows[0];
        if (!shipment) throw new ApiError(404, 'SHIPMENT_NOT_FOUND', '未找到对应物流单据。');
        const result = await publishInlineLabel(connection, {
          client: request.client, shipmentId: shipment.id, requestId: request.requestId, label: label!,
        });
        await connection.commit();
        return {
          id: result.assetId, shipmentId: shipment.id, sha256: request.pdf.sha256,
          byteSize: request.pdf.byteSize, contentType: 'application/pdf',
          shipmentStatus: shipment.status === 'RECEIVED' ? 'READY_TO_PRINT' : shipment.status,
          reused: result.reused,
        };
      } catch (error) {
        await connection.rollback().catch(() => undefined);
        throw error;
      } finally {
        connection.release();
      }
    },
  };
}
