import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import type { Pool } from 'mysql2/promise';
import type { Redis } from 'ioredis';
import type { LabelStorage } from '../src/labelStorage.js';
import { createShipmentIngestor, hashInboundPayload } from '../src/shipmentIngest.js';
import { createInboundBatchIngestor } from '../src/inboundBatchIngest.js';
import { ApiError } from '../src/errors.js';

const pdf = Buffer.from('%PDF-1.7\nnew label\n%%EOF\n');
const hash = createHash('sha256').update(pdf).digest('hex');
const shipment = { firstLegTrackingNo: 'ORIGINAL-A', courierTrackingNo: 'COURIER-C', labelPdfBase64: pdf.toString('base64') };
const client = { id: 'client-1', apiKeyId: 'key-1', scopes: ['shipments:write', 'labels:write'] as ('shipments:write' | 'labels:write')[], rateLimitPerMinute: 600 };
const request = { client, requestId: 'request-inline', idempotencyKey: 'inline-push-1', body: shipment };

// The external database boundary is a small transaction fixture. It records
// publication order and SQL parameters; production parsers/ingestors run intact.
function fixture(options: { storageFailure?: boolean; commitFailure?: boolean; orderStatus?: string; clientConflict?: boolean; existingAssetId?: string } = {}) {
  const events: string[] = [];
  const writes: { sql: string; values: unknown[] }[] = [];
  const storedKeys: string[] = [];
  const row = {
    id: 'shipment-1', client_id: client.id, air_pickup_order_id: 'air-1',
    first_leg_tracking_no: 'ORIGINAL-A', courier_tracking_no: 'COURIER-C',
    label_sha256: hash, current_label_asset_id: null as string | null,
    label_expires_at: new Date('2100-01-01'), label_asset_status: 'READY', label_bytes_deleted_at: null,
    status: 'RECEIVED', raw_data: {}, version: 2,
    created_at: new Date('2026-09-01'), updated_at: new Date('2026-09-09'),
  };
  const connection = {
    beginTransaction: async () => { events.push('begin'); },
    execute: async (sql: string, values: unknown[] = []) => {
      if (sql.includes('FROM clients')) return [[{ display_name: 'TYG' }]];
      if (sql.includes('FROM air_pickup_orders')) return [[{ id: 'air-1', client_id: options.clientConflict ? 'another-client' : client.id, external_batch_id: 'batch-1', order_status: options.orderStatus ?? 'HANDED_OVER' }]];
      if (sql.includes('FROM label_assets') && !sql.includes('FROM shipments')) return [options.existingAssetId ? [{ id: options.existingAssetId }] : []];
      if (sql.includes('FROM shipments')) return [[row]];
      writes.push({ sql, values });
      if (sql.includes('UPDATE shipments') && sql.includes('current_label_asset_id = ?')) {
        row.current_label_asset_id = String(values[0]);
        row.status = 'READY_TO_PRINT';
        events.push('publish');
      }
      return [{ affectedRows: 1 }];
    },
    commit: async () => { if (options.commitFailure) throw new Error('commit failed'); events.push('commit'); },
    rollback: async () => { events.push('rollback'); },
    release: () => undefined,
  };
  const mysql = { execute: async () => [[]], getConnection: async () => connection } as unknown as Pool;
  const redis = { set: async () => 'OK', eval: async () => 1 } as unknown as Redis;
  const storage = {
    put: async (key: string, content: Buffer) => {
      assert.deepEqual(content, pdf);
      if (options.storageFailure) throw new Error('COS unavailable');
      events.push('stored');
      storedKeys.push(key);
    },
  } as LabelStorage;
  return { mysql, redis, storage, events, writes, row, storedKeys };
}

test('single push stores the PDF before atomically publishing its mapping and success', async () => {
  const f = fixture();
  const result = await createShipmentIngestor(f).ingest(request);
  assert.equal(result.status, 200);
  assert.equal((result.body.data as { labelAssetReady: boolean }).labelAssetReady, true);
  assert.equal(f.events[0], 'stored');
  assert.ok(f.events.indexOf('publish') > f.events.indexOf('begin'));
  assert.equal(f.events.at(-1), 'commit');
  assert.ok(f.writes.some(write => write.sql.includes('INSERT INTO label_assets')));
  assert.equal(JSON.stringify(f.writes).includes(shipment.labelPdfBase64), false);
});

test('failed PDF persistence cannot open a write transaction or return success', async () => {
  const f = fixture({ storageFailure: true });
  await assert.rejects(createShipmentIngestor(f).ingest(request),
    (error: unknown) => error instanceof ApiError && error.code === 'LABEL_STORAGE_UNAVAILABLE');
  assert.deepEqual(f.events, []);
  assert.deepEqual(f.writes, []);
});

test('inline PDF requires labels:write even on the shipments endpoint', async () => {
  const f = fixture();
  await assert.rejects(createShipmentIngestor(f).ingest({ ...request, client: { ...client, scopes: ['shipments:write'] } }),
    (error: unknown) => error instanceof ApiError && error.status === 403);
  assert.deepEqual(f.events, []);
});

function batchBody() {
  return { batchId: 'batch-1', airPickup: { billNo: '18098109734', forecastCartons: 10, forecastPackages: 100, forecastWeight: 20, forecastWeightUnit: 'KG' }, shipments: [shipment] };
}

for (const orderStatus of ['RECORDED', 'RECEIVED', 'HANDED_OVER', 'VOIDED']) {
  test(`batch accepts supplementary PDF while the air-pickup state is ${orderStatus}`, async () => {
    const f = fixture({ orderStatus });
    const result = await createInboundBatchIngestor(f).ingest({ ...request, ip: '127.0.0.1', body: batchBody() });
    assert.equal(result.status, 200);
    assert.equal(f.events[0], 'stored');
    assert.ok(f.events.includes('publish'));
    assert.equal(f.events.at(-1), 'commit');
    assert.equal(JSON.stringify(f.writes).includes(shipment.labelPdfBase64), false);
  });
}

test('batch storage failure never commits the forecast or mapping', async () => {
  const f = fixture({ storageFailure: true });
  await assert.rejects(createInboundBatchIngestor(f).ingest({ ...request, ip: '127.0.0.1', body: batchBody() }),
    (error: unknown) => error instanceof ApiError && error.code === 'LABEL_STORAGE_UNAVAILABLE');
  assert.deepEqual(f.writes, []);
});

test('a stored PDF is not reported as accepted when the database commit fails', async () => {
  const f = fixture({ commitFailure: true });
  await assert.rejects(createShipmentIngestor(f).ingest(request), /commit failed/);
  assert.equal(f.events.at(-1), 'rollback');
});

test('batch continues to enforce tenant ownership before publishing a new label', async () => {
  const f = fixture({ clientConflict: true });
  await assert.rejects(createInboundBatchIngestor(f).ingest({ ...request, ip: '127.0.0.1', body: batchBody() }),
    (error: unknown) => error instanceof ApiError && error.code === 'AIR_PICKUP_CLIENT_CONFLICT');
  assert.equal(f.events.includes('publish'), false);
  assert.equal(f.events.at(-1), 'rollback');
});

test('an inline push cannot replay a previous metadata-only acceptance', async () => {
  const f = fixture();
  f.mysql = { execute: async () => [[{
    payload_sha256: hashInboundPayload({ firstLegTrackingNo: shipment.firstLegTrackingNo, courierTrackingNo: shipment.courierTrackingNo, labelSha256: hash }),
    processing_status: 'COMPLETED', response_status: 200, response_body: { data: { labelAssetReady: false } },
  }]] } as unknown as Pool;
  await assert.rejects(createShipmentIngestor(f).ingest(request),
    (error: unknown) => error instanceof ApiError && error.code === 'IDEMPOTENCY_CONFLICT');
  assert.equal(f.events.length, 0);
});

test('identical PDF renewal reuses metadata but rotates storage generation and renews expiry', async () => {
  const f = fixture({ existingAssetId: 'existing-asset' });
  const before = Date.now();
  await createShipmentIngestor(f).ingest(request);
  await createShipmentIngestor(f).ingest({ ...request, idempotencyKey: 'real-business-update-2' });
  assert.equal(f.row.current_label_asset_id, 'existing-asset');
  assert.notEqual(f.storedKeys[0], f.storedKeys[1]);
  const renewal = f.writes.find(write => write.sql.includes('UPDATE label_assets'))!;
  assert.ok(renewal.sql.includes('bytes_deleted_at = NULL'));
  const expiry = renewal.values.find(value => value instanceof Date) as Date;
  assert.ok(expiry.getTime() >= before + 7 * 24 * 60 * 60 * 1000);
  const mappingWrite = f.writes.find(write => write.sql.includes('INSERT INTO shipments'))!;
  assert.ok(mappingWrite.values.includes('COURIER-C'));
  assert.ok(mappingWrite.sql.includes('courier_tracking_no = COALESCE(VALUES(courier_tracking_no), courier_tracking_no)'));
});

test('an inline batch cannot reuse metadata-only success for the same fingerprint', async () => {
  const f = fixture();
  const metadata = { ...batchBody(), shipments: [{ firstLegTrackingNo: shipment.firstLegTrackingNo, courierTrackingNo: shipment.courierTrackingNo, labelSha256: hash }] };
  f.mysql = { execute: async () => [[{
    payload_sha256: hashInboundPayload(metadata), processing_status: 'COMPLETED',
    response_status: 200, response_body: { data: { shipmentCount: 1 } },
  }]] } as unknown as Pool;
  await assert.rejects(createInboundBatchIngestor(f).ingest({ ...request, ip: '127.0.0.1', body: batchBody() }),
    (error: unknown) => error instanceof ApiError && error.code === 'IDEMPOTENCY_CONFLICT');
});

test('durable inline replay returns the accepted result without storing another generation', async () => {
  const f = fixture();
  const payload = { firstLegTrackingNo: shipment.firstLegTrackingNo, courierTrackingNo: shipment.courierTrackingNo, labelSha256: hash };
  f.mysql = { execute: async () => [[{
    payload_sha256: hashInboundPayload({ kind: 'inline-label', payload }), processing_status: 'COMPLETED',
    response_status: 200, response_body: { data: { id: 'shipment-1', labelAssetReady: true }, requestId: 'original-request' },
  }]] } as unknown as Pool;
  const result = await createShipmentIngestor(f).ingest(request);
  assert.equal(result.body.idempotentReplay, true);
  assert.equal(result.body.requestId, 'original-request');
  assert.equal(f.events.length, 0);
});
