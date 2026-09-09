import assert from 'node:assert/strict';
import { test } from 'node:test';
import { toShipment, type ShipmentRow } from '../src/shipmentRecord.js';

test('upstream query does not advertise an expired or deleted PDF as ready', () => {
  const row = {
    id: 'shipment', current_label_asset_id: 'asset', label_asset_status: 'READY', label_bytes_deleted_at: null,
    label_expires_at: new Date('2020-01-01'), created_at: new Date(), updated_at: new Date(),
  } as unknown as ShipmentRow;
  assert.equal(toShipment(row).labelAssetReady, false);
  row.label_expires_at = new Date('2100-01-01');
  assert.equal(toShipment(row).labelAssetReady, true);
  row.label_bytes_deleted_at = new Date();
  assert.equal(toShipment(row).labelAssetReady, false);
});
