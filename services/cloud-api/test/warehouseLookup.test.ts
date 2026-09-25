import assert from 'node:assert/strict';
import { it } from 'node:test';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import type { Pool } from 'mysql2/promise';
import { createWarehouseOperations } from '../src/warehouseOperations.js';
import type { LabelStorage } from '../src/labelStorage.js';
import type { WarehouseSession } from '../src/warehouseIdentity.js';

function fixture() {
  const db = new DatabaseSync(':memory:');
  db.function('utc_now', () => '2026-09-25 12:00:00');
  db.exec(`CREATE TABLE shipments (id TEXT PRIMARY KEY, first_leg_tracking_no TEXT COLLATE NOCASE,
    courier_tracking_no TEXT COLLATE NOCASE, carrier TEXT, status TEXT, version INTEGER,
    updated_at TEXT, current_label_asset_id TEXT);
    CREATE TABLE label_assets (id TEXT PRIMARY KEY, asset_status TEXT, content_sha256 TEXT,
    byte_size INTEGER, expires_at TEXT, bytes_deleted_at TEXT);
    INSERT INTO shipments VALUES ('one', 'ORIGINAL', 'TRANSFER', 'UPS', 'READY_TO_PRINT', 1, '2026-09-25', 'pdf');
    INSERT INTO label_assets VALUES ('pdf', 'READY', '${'a'.repeat(64)}', 42, '2026-09-26', NULL);`);
  const mysql = { execute: async (sql: string, params: unknown[]) => [db.prepare(sql.replaceAll('UTC_TIMESTAMP(3)', 'utc_now()'))
    .all(...params as SQLInputValue[]).map(row => ({ ...row, updated_at: new Date(String(row.updated_at)) }))] } as unknown as Pool;
  const operations = createWarehouseOperations({ mysql, storage: {} as LabelStorage, outboundWebhooks: { enqueuePrintAttempt: async () => '' } });
  // Dynamic access lets the first run fail on the missing behavior, before implementation.
  const lookup = (trackingNo: unknown) => (operations as unknown as { lookupShipment(s: WarehouseSession, n: unknown): Promise<any> })
    .lookupShipment({ warehouseId: 'warehouse' } as WarehouseSession, trackingNo);
  return { db, lookup };
}

it('looks up either tracking number without a delivery feed or browser index', async () => {
  const { db, lookup } = fixture();
  try {
    for (const code of ['ORIGINAL', 'transfer', '  ORIGINAL\r\n']) {
      const found = await lookup(code);
      assert.equal(found.id, 'one');
      assert.equal(found.labelAsset.id, 'pdf');
      assert.equal(found.labelAsset.byteSize, 42);
    }
    assert.equal(await lookup('MISSING'), null);
    db.exec("UPDATE shipments SET courier_tracking_no = 'ORIGINAL'");
    assert.equal((await lookup('ORIGINAL')).id, 'one');
  } finally { db.close(); }
});

it('rejects ambiguous shipments instead of picking a customer or ignoring blocked matches', async () => {
  const { db, lookup } = fixture();
  try {
    db.exec("INSERT INTO shipments VALUES ('two', 'OTHER', 'ORIGINAL', 'UPS', 'BLOCKED', 1, '2026-09-25', NULL)");
    await assert.rejects(lookup('ORIGINAL'), { code: 'TRACKING_AMBIGUOUS' });
  } finally { db.close(); }
});

it('reads the current label version and rejects expired, deleted, or unavailable PDFs', async () => {
  const { db, lookup } = fixture();
  try {
    db.exec("INSERT INTO label_assets SELECT 'new-pdf', asset_status, content_sha256, byte_size, expires_at, bytes_deleted_at FROM label_assets; UPDATE shipments SET current_label_asset_id = 'new-pdf', version = 2");
    assert.equal((await lookup('ORIGINAL')).labelAsset.id, 'new-pdf');
    for (const change of ["expires_at = '2026-09-25 12:00:00'", "bytes_deleted_at = '2026-09-25'", "asset_status = 'PENDING'"]) {
      db.exec("UPDATE label_assets SET expires_at = '2026-09-26', bytes_deleted_at = NULL, asset_status = 'READY'");
      db.exec(`UPDATE label_assets SET ${change}`);
      await assert.rejects(lookup('ORIGINAL'), { code: 'LABEL_UNAVAILABLE' });
    }
  } finally { db.close(); }
});

it('rejects non-printable statuses and invalid tracking inputs', async () => {
  const { db, lookup } = fixture();
  try {
    for (const state of ['BLOCKED', 'CANCELLED', 'RECEIVED']) {
      db.exec(`UPDATE shipments SET status = '${state}'`);
      await assert.rejects(lookup('ORIGINAL'), { code: 'SHIPMENT_NOT_PRINTABLE' });
    }
    for (const value of ['', [], null, 'a'.repeat(129)]) await assert.rejects(lookup(value), { code: 'VALIDATION_ERROR' });
  } finally { db.close(); }
});
