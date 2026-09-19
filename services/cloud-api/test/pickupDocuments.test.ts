import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Readable } from 'node:stream';
import { receiveDocumentBytes, createDocumentReceiveSlots, createPickupDocuments } from '../src/pickupDocuments.js';
import type { Pool } from 'mysql2/promise';
import type { LabelStorage } from '../src/labelStorage.js';
import type { WarehouseSession } from '../src/warehouseIdentity.js';

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
