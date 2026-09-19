import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Readable } from 'node:stream';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { receiveDocumentBytes, createDocumentReceiveSlots, createPickupDocuments, type DocumentLease } from '../src/pickupDocuments.js';
import { DOCUMENT_POLICY } from '../src/pickupDocumentPolicy.js';
import { documentPdf } from './documentFixtures.js';
import type { Pool } from 'mysql2/promise';
import type { LabelStorage } from '../src/labelStorage.js';
import type { WarehouseSession } from '../src/warehouseIdentity.js';

for (const [offsetHours, remainingSeconds, shouldCheck] of [[8, 120, true], [-8, -120, false]] as const) {
  test(`UTC document lease remains valid/expired with database zone ${offsetHours} hours`, async () => {
    const db = new DatabaseSync(':memory:');
    const now = Date.now();
    const sqlTime = (value: number) => new Date(value).toISOString().replace('T', ' ').replace('Z', '');
    db.function('NOW', (_precision: unknown) => sqlTime(now + offsetHours * 3600000));
    db.function('UTC_TIMESTAMP', (_precision: unknown) => sqlTime(now));
    db.exec(`CREATE TABLE warehouse_ui_operations (operation_id TEXT, status TEXT, attempt_no INTEGER,
      document_lease_token TEXT, document_lease_expires_at TEXT, retryable INTEGER, error_code TEXT,
      document_phase TEXT, completed_at TEXT);`);
    const uploadId = randomUUID(), token = randomUUID(), userId = randomUUID();
    db.prepare('INSERT INTO warehouse_ui_operations (operation_id,status,attempt_no,document_lease_token,document_lease_expires_at) VALUES (?,?,?,?,?)')
      .run(uploadId, 'PROCESSING', 1, token, sqlTime(now + remainingSeconds * 1000));
    const mysql = { execute: async (sql: string, values: unknown[]) => {
      const result = db.prepare(sql).run(...values.map(value => value instanceof Date ? sqlTime(value.getTime()) : typeof value === 'boolean' ? Number(value) : value) as SQLInputValue[]);
      return [{ affectedRows: Number(result.changes) }];
    } } as unknown as Pool;
    let checked = false;
    const service = createPickupDocuments({ mysql, storage: {} as LabelStorage, enabled: true,
      checker: async (_bytes, contentType) => { checked = true; return { clean: false, validated: false, contentType }; } });
    const bytes = documentPdf('UTC lease regression');
    const lease: DocumentLease = { orderId: randomUUID(), actor: `user:${userId}`, attempt: 1, token,
      upload: { uploadId, filename: 'lease.pdf', byteSize: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'),
        declaredContentType: 'application/pdf', policyVersion: DOCUMENT_POLICY.policyVersion,
        supersedesAssetId: null, expectedAssetVersion: null, reason: null } };
    try {
      await assert.rejects(service.save({ userId } as WarehouseSession, lease, bytes, { requestId: randomUUID(), ip: '127.0.0.1' }),
        { code: shouldCheck ? 'DOCUMENT_CONTENT_INVALID' : 'DOCUMENT_ATTEMPT_STALE' });
      assert.equal(checked, shouldCheck);
    } finally { db.close(); }
  });
}

test('disabled originals refuse reads and writes before touching unmigrated storage', async () => {
  const unavailable = new Proxy({}, { get() { throw new Error('disabled feature touched storage'); } });
  const service = createPickupDocuments({ mysql: unavailable as Pool, storage: unavailable as LabelStorage });
  const session = { passwordState: 'ACTIVE', permissions: ['air_pickups.view', 'air_pickups.documents.view', 'air_pickups.documents.add', 'air_pickups.documents.manage'] } as WarehouseSession;
  assert.equal(service.policy(session).enabled, false);
  await assert.rejects(service.register(session, 'order', {}), { code: 'DOCUMENTS_UNAVAILABLE' });
  await assert.rejects(service.list(session, 'order', {}), { code: 'DOCUMENTS_UNAVAILABLE' });
  await assert.rejects(service.open(session, 'order', 'asset', 'original', 'attachment'), { code: 'DOCUMENTS_UNAVAILABLE' });
  assert.deepEqual(await service.reconcileExpired(), { inspected: 0, recovered: 0 });
});
test('bounded receiver enforces actual and declared length without Content-Length', async () => {
  assert.equal((await receiveDocumentBytes(Readable.from([Buffer.alloc(25), Buffer.alloc(25)]), 50, 50)).length, 50);
  await assert.rejects(receiveDocumentBytes(Readable.from([Buffer.alloc(51)]), 50, 50), { code: 'DOCUMENT_TOO_LARGE' });
  await assert.rejects(receiveDocumentBytes(Readable.from([Buffer.alloc(49)]), 50, 50), { code: 'DOCUMENT_LENGTH_MISMATCH' });
});
test('four slots are bounded and released once', () => {
  const slots = createDocumentReceiveSlots(4);
  const releases = Array.from({ length: 4 }, () => slots.acquire());
  assert.throws(() => slots.acquire(), { code: 'DOCUMENT_RECEIVE_BUSY' });
  releases[0](); releases[0]();
  slots.acquire();
  assert.throws(() => slots.acquire(), { code: 'DOCUMENT_RECEIVE_BUSY' });
  releases.slice(1).forEach(release => release());
});
