import test from 'node:test';
import assert from 'node:assert/strict';
import { createDocumentUpload, readDocumentJournal, writeDocumentJournal } from '../src/features/airPickup/pickupDocumentRecovery.ts';

const id = '11111111-1111-4111-8111-111111111111';
const ready = { uploadId: id, orderId: 'order-1', status: 'COMPLETED', attempt: 1, retryable: false, recordRef: { id: 'asset-1' }, assetStatus: 'READY' };
function setup() {
  let current = true; let writes = 0; let registrations = 0; let result: any = ready;
  let fail = false;
  const controller = createDocumentUpload({ uploadId: id, orderId: 'order-1', filename: 'a.pdf' }, {
    current: () => current, changed: () => {},
    register: async () => { registrations++; return { ...ready, status: 'WAITING_BYTES', attempt: 0, recordRef: null }; },
    put: async (_file, attempt, retry) => { writes++; if (fail) throw new Error('socket lost'); assert.equal(attempt, retry ? retry + 1 : 1); return result; },
    query: async () => result,
  });
  return { controller, writes: () => writes, registrations: () => registrations,
    result: (next: any) => { result = next; }, fail: () => { fail = true; }, stale: () => { current = false; } };
}
test('lost upload response queries the original upload and never sends bytes twice', async () => {
  const h = setup(); h.fail(); await h.controller.start(new Blob(['pdf']));
  assert.equal(h.controller.state().phase, 'unknown');
  await h.controller.retry(); assert.equal(h.writes(), 1);
  await h.controller.check(); assert.equal(h.controller.state().phase, 'saved'); assert.equal(h.writes(), 1);
});
test('concurrent start clicks cannot register or upload a second time', async () => {
  const h = setup(); await Promise.all([h.controller.start(new Blob(['pdf'])), h.controller.start(new Blob(['pdf']))]);
  assert.equal(h.registrations(), 1); assert.equal(h.writes(), 1);
});
test('only explicit retryable not-saved result enables the next attempt', async () => {
  const h = setup(); h.result({ ...ready, status: 'FAILED_NOT_SAVED', retryable: true, recordRef: null });
  await h.controller.start(new Blob(['pdf'])); h.result({ ...ready, attempt: 2 });
  await h.controller.retry(); assert.equal(h.writes(), 2); assert.equal(h.controller.state().phase, 'saved');
});
test('malformed or foreign result never establishes saved or authorizes retry', async () => {
  const h = setup(); h.result({ ...ready, orderId: 'other-order' });
  await h.controller.start(new Blob(['pdf'])); await h.controller.retry();
  assert.equal(h.controller.state().phase, 'unknown'); assert.equal(h.writes(), 1);
});
test('completed inactive asset is historical success and cannot be resurrected', async () => {
  const h = setup(); h.result({ ...ready, assetStatus: 'REMOVED' });
  await h.controller.start(new Blob(['pdf'])); await h.controller.retry();
  assert.equal(h.controller.state().phase, 'inactive'); assert.equal(h.writes(), 1);
});
test('identity change before registration returns prevents file transmission', async () => {
  const h = setup(); const promise = h.controller.start(new Blob(['pdf'])); h.stale(); await promise;
  assert.equal(h.writes(), 0);
});
test('journal contains query handles only and rejects a different owner', () => {
  const h = setup(); const raw = writeDocumentJournal([{ ...h.controller.state(), phase: 'unknown' }], 'owner-1');
  assert.deepEqual(Object.keys(JSON.parse(raw).items[0]).sort(), ['orderId', 'uploadId']);
  assert.equal(readDocumentJournal(raw, 'owner-2').length, 0);
  assert.deepEqual(readDocumentJournal(raw, 'owner-1'), [{ uploadId: id, orderId: 'order-1', filename: '待核对文件', phase: 'unknown' }]);
});
test('completed history never crowds unresolved uploads out of the journal', () => {
  const h = setup(); const completed = Array.from({ length: 120 }, () => ({ ...h.controller.state(), phase: 'saved' as const }));
  const raw = writeDocumentJournal([...completed, { ...h.controller.state(), phase: 'unknown' }], 'owner-1');
  assert.equal(JSON.parse(raw).items.length, 1); assert.equal(readDocumentJournal(raw, 'owner-1').length, 1);
});
test('confirmed registration validation rejection explains correction without claiming unknown write', async () => {
  const controller = createDocumentUpload({ uploadId: id, orderId: 'order-1', filename: 'bad.pdf' }, {
    current: () => true, changed: () => {},
    register: async () => { throw Object.assign(new Error('文件名无效'), { status: 400, code: 'DOCUMENT_INVALID_FILENAME' }); },
    put: async () => { throw new Error('must not send'); }, query: async () => { throw new Error('must not query'); },
  });
  await controller.start(new Blob(['pdf']));
  assert.equal(controller.state().phase, 'not_saved'); assert.match(controller.state().message, /文件名无效/);
});
test('reselected bytes must register against the old id before retrying and unknown results block reselection', async () => {
  const h = setup(); h.fail(); await h.controller.start(new Blob(['pdf']));
  await h.controller.reselect(new Blob(['other'])); assert.equal(h.registrations(), 1);
  h.result({ ...ready, status: 'WAITING_BYTES', attempt: 0, recordRef: null }); await h.controller.check();
  await h.controller.reselect(new Blob(['pdf'])); assert.equal(h.registrations(), 2); assert.equal(h.writes(), 2);
});
test('lost registration can replay the same metadata and same id without allocating a new upload', async () => {
  let registered = 0; let puts = 0;
  const controller = createDocumentUpload({ uploadId: id, orderId: 'order-1', filename: 'a.pdf' }, {
    current: () => true, changed: () => {}, register: async () => { registered++; if (registered === 1) throw new Error('network before registration'); return { ...ready, status: 'WAITING_BYTES', attempt: 0, recordRef: null }; },
    put: async () => { puts++; return ready; }, query: async () => { throw Object.assign(new Error('not found'), { status: 404 }); },
  });
  await controller.start(new Blob(['pdf'])); await controller.check(); await controller.replayRegistration();
  assert.equal(registered, 2); assert.equal(puts, 1); assert.equal(controller.state().phase, 'saved'); assert.equal(controller.state().uploadId, id);
});
test('wrong reselected file leaves confirmed waiting state and shows the mismatch', async () => {
  const controller = createDocumentUpload({ uploadId: id, orderId: 'order-1', filename: 'a.pdf', phase: 'unknown' }, {
    current: () => true, changed: () => {}, register: async () => ready,
    reregister: async () => { throw Object.assign(new Error('请选择原文件'), { code: 'LOCAL_DOCUMENT_MISMATCH' }); },
    put: async () => ready, query: async () => ({ ...ready, status: 'WAITING_BYTES', attempt: 0, recordRef: null }),
  });
  await controller.check(); await controller.reselect(new Blob(['wrong']));
  assert.equal(controller.state().phase, 'waiting'); assert.match(controller.state().message, /请选择原文件/);
});
test('restored registration keeps immutable metadata but cannot persist credentials or bytes', () => {
  const h = setup(); h.controller.prepared({ uploadId: id, filename: 'a.pdf', sha256: 'a'.repeat(64), byteSize: 3,
    password: 'secret', token: 'secret', file: new Blob(['pdf']), reason: 'correction', supersedesAssetId: 'old-asset' });
  const raw = writeDocumentJournal([{ ...h.controller.state(), phase: 'unknown' }], 'owner-1');
  assert.equal(raw.includes('secret'), false); assert.equal(raw.includes('"file"'), false);
  const restored = readDocumentJournal(raw, 'owner-1')[0];
  assert.equal(restored.registration?.supersedesAssetId, 'old-asset'); assert.equal(restored.registration?.filename, 'a.pdf');
});
