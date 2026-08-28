import type { RowDataPacket } from 'mysql2';
import type { ShipmentStatus } from './shipmentInput.js';

export type ShipmentRow = RowDataPacket & {
  id: string;
  client_id: string;
  order_id: string | null;
  first_leg_tracking_no: string;
  courier_tracking_no: string | null;
  carrier: string | null;
  label_url: string | null;
  label_sha256: string | null;
  current_label_asset_id: string | null;
  recipient_name: string | null;
  recipient_phone: string | null;
  recipient_address: string | Record<string, unknown> | null;
  items: string | unknown[] | null;
  raw_data: string | Record<string, unknown> | null;
  status: ShipmentStatus;
  attributes: string | Record<string, unknown> | null;
  version: number;
  created_at: Date;
  updated_at: Date;
};

function parseJson(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

export function toShipment(row: ShipmentRow) {
  return {
    id: row.id,
    orderId: row.order_id,
    firstLegTrackingNo: row.first_leg_tracking_no,
    courierTrackingNo: row.courier_tracking_no,
    carrier: row.carrier,
    labelUrl: row.label_url,
    labelSha256: row.label_sha256,
    labelAssetReady: Boolean(row.current_label_asset_id),
    recipientName: row.recipient_name,
    phone: row.recipient_phone,
    address: parseJson(row.recipient_address),
    items: parseJson(row.items),
    status: row.status,
    attributes: parseJson(row.attributes),
    rawDataCaptured: row.raw_data !== null,
    version: row.version,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

export type ShipmentView = ReturnType<typeof toShipment>;
