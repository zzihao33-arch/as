import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createHash, webcrypto } from 'node:crypto';
import ts from 'typescript';

// Run the real library with network/IndexedDB boundaries replaced; no React DOM needed.
const source = readFileSync(new URL('../src/features/printing/warehousePrintLibrary.ts', import.meta.url), 'utf8');
const code = ts.transpileModule(source + '\nexport { synchronizeWarehouse, loadTargets };', {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const blob = new Blob(['%PDF-1.4\nlabel\n%%EOF'], { type: 'application/pdf' });
const hash = createHash('sha256').update(Buffer.from(await blob.arrayBuffer())).digest('hex');
const shipment = id => ({ id, firstLegTrackingNo: `ORIGINAL-${id}`, courierTrackingNo: `COURIER-${id}`,
  status: 'READY_TO_PRINT', version: 1, updatedAt: '2026-09-25T00:00:00Z',
  labelAsset: { id: `asset-${id}`, sha256: hash, byteSize: blob.size, downloadPath: `/labels/${id}` } });

function harness({ pages = [], download = async () => blob, lookup = async () => shipment('new'), failRead = false, failLabelWrite = false, fullCache = false } = {}) {
  const stores = new Map();
  const store = name => { if (!stores.has(name)) stores.set(name, new Map()); return stores.get(name); };
  const downloads = [];
  let cacheFull = fullCache;
  const storage = {
    clearWarehouseLabelCache: async warehouseId => {
      for (const [key, value] of store('cloudLabels')) if (value.warehouseId === warehouseId) store('cloudLabels').delete(key);
      cacheFull = false;
    },
    readLocalFirstValue: async (name, key) => { if (failRead) throw new Error('Storage unavailable'); return store(name).get(key) ?? null; },
    readAllLocalFirstEntries: async name => [...store(name)].map(([key, value]) => ({ key, value })),
    writeLocalFirstValue: async (name, key, value) => {
      if (name === 'cloudLabels' && failLabelWrite) throw new DOMException('Full', 'QuotaExceededError');
      store(name).set(key, value);
    },
    updateLocalFirstEntries: async (name, entries) => {
      if (cacheFull) throw new DOMException('Full', 'QuotaExceededError');
      entries.forEach(({ key, value }) => store(name).set(key, value));
    },
    deleteLocalFirstValue: async (name, key) => store(name).delete(key),
  };
  let pageIndex = 0;
  const api = {
    lookupWarehouseShipment: lookup,
    listWarehouseShipments: async () => pages[pageIndex++],
    downloadWarehouseLabel: async path => { downloads.push(path); return download(path); },
  };
  const exports = {};
  vm.runInNewContext(code, { exports, Blob, File, Date, DOMException, crypto: webcrypto, console,
    require: name => name.includes('localFirstDatabase') ? storage : name.includes('warehouseApi') ? api : {},
  });
  return { ...exports, store, downloads };
}

test('indexes later pages even when an earlier PDF cannot be downloaded', async () => {
  const h = harness({ pages: [
    { data: [shipment('old')], cursor: '1', hasMore: true },
    { data: [shipment('new')], cursor: '2', hasMore: false },
  ], download: async () => { throw new Error('Historical PDF unavailable'); } });
  await h.synchronizeWarehouse('warehouse', () => {});
  assert.equal((await h.loadTargets('warehouse')).length, 2);
  assert.equal(h.store('cloudSync').get('warehouse:warehouse').cursor, '2');
  assert.equal(h.downloads.length, 0);
});

test('resolves the current server label on every scan without a local shipment index', async () => {
  let current = 'first';
  const h = harness({ lookup: async () => shipment(current), failRead: true });
  assert.equal((await h.resolveCloudPrintTarget('ORIGINAL')).labelAssetId, 'asset-first');
  current = 'second';
  assert.equal((await h.resolveCloudPrintTarget('ORIGINAL')).labelAssetId, 'asset-second');
  assert.equal(h.store('cloudShipments').size, 0);
});

test('lookup failure never falls back to a cached shipment, and no match stays distinct', async () => {
  const h = harness({ lookup: async () => { throw new Error('Lookup offline'); } });
  await indexedTarget(h);
  await assert.rejects(h.resolveCloudPrintTarget('ORIGINAL'), /Lookup offline/);
  assert.equal(await harness({ lookup: async () => null }).resolveCloudPrintTarget('MISSING'), null);
});

test('unavailable browser storage does not block a validated online PDF', async () => {
  const h = harness({ failRead: true });
  const target = await indexedTarget(h);
  assert.equal(await (await h.readCloudLabelFile('warehouse', target)).text(), await blob.text());
});

async function indexedTarget(h, id = 'new') {
  h.store('cloudShipments').set(`warehouse:${id}`, { ...shipment(id), warehouseId: 'warehouse' });
  return (await h.loadTargets('warehouse'))[0];
}

test('downloads and validates only the scanned label, then reuses its cache', async () => {
  const h = harness();
  const target = await indexedTarget(h);
  const first = await h.readCloudLabelFile('warehouse', target);
  assert.equal(await first.text(), await blob.text());
  assert.equal(first.name, 'COURIER-new.pdf');
  await h.readCloudLabelFile('warehouse', target);
  assert.deepEqual(h.downloads, ['/labels/new']);
});

test('a full PDF cache does not prevent printing a validated online label', async () => {
  const h = harness({ failLabelWrite: true });
  const target = await indexedTarget(h);
  assert.equal(await (await h.readCloudLabelFile('warehouse', target)).text(), await blob.text());
});

test('rejects a wrong PDF hash instead of printing or caching it', async () => {
  const h = harness({ download: async () => new Blob(['%PDF-1.4\nWRONG\n%%EOF']) });
  const target = await indexedTarget(h);
  await assert.rejects(h.readCloudLabelFile('warehouse', target), /SHA-256/);
  assert.equal(h.store('cloudLabels').size, 0);
});

test('a failed scanned download can be retried', async () => {
  let fail = true;
  const h = harness({ download: async () => { if (fail) throw new Error('Network unavailable'); return blob; } });
  const target = await indexedTarget(h);
  await assert.rejects(h.readCloudLabelFile('warehouse', target), /Network unavailable/);
  fail = false;
  assert.equal(await (await h.readCloudLabelFile('warehouse', target)).text(), await blob.text());
});

test('recovers index synchronization when old PDF cache has filled browser storage', async () => {
  const h = harness({ fullCache: true, pages: [{ data: [shipment('new')], cursor: '2', hasMore: false }] });
  h.store('cloudLabels').set('warehouse:old', { warehouseId: 'warehouse', blob });
  h.store('cloudLabels').set('other:old', { warehouseId: 'other', blob });
  h.store('printLogs').set('important', { outcome: 'SUCCESS' });
  await h.synchronizeWarehouse('warehouse', () => {});
  assert.equal((await h.loadTargets('warehouse')).length, 1);
  assert.equal(h.store('cloudLabels').has('warehouse:old'), false);
  assert.equal(h.store('cloudLabels').has('other:old'), true);
  assert.equal(h.store('printLogs').has('important'), true);
});

test('preserves the IndexedDB quota error when a request error precedes transaction abort', async () => {
  const storageSource = readFileSync(new URL('../src/shared/storage/localFirstDatabase.ts', import.meta.url), 'utf8');
  const output = ts.transpileModule(storageSource + '\nexport { transactionAsPromise };', {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports = {};
  vm.runInNewContext(output, { exports });
  const transaction = { error: null };
  const result = exports.transactionAsPromise(transaction);
  transaction.onerror?.({ target: { error: new DOMException('Full', 'QuotaExceededError') } });
  transaction.error = new DOMException('Full', 'QuotaExceededError');
  transaction.onabort();
  await assert.rejects(result, error => error.name === 'QuotaExceededError');
});
