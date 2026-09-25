import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createHash, webcrypto } from 'node:crypto';
import ts from 'typescript';

// Run the real library with network/IndexedDB boundaries replaced; no React DOM needed.
const source = readFileSync(new URL('../src/features/printing/warehousePrintLibrary.ts', import.meta.url), 'utf8');
const code = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const blob = new Blob(['%PDF-1.4\nlabel\n%%EOF'], { type: 'application/pdf' });
const hash = createHash('sha256').update(Buffer.from(await blob.arrayBuffer())).digest('hex');
const shipment = id => ({ id, firstLegTrackingNo: `ORIGINAL-${id}`, courierTrackingNo: `COURIER-${id}`,
  status: 'READY_TO_PRINT', version: 1, updatedAt: '2026-09-25T00:00:00Z',
  labelAsset: { id: `asset-${id}`, sha256: hash, byteSize: blob.size, downloadPath: `/labels/${id}` } });

function harness({ download = async () => blob, lookup = async () => shipment('new'), failRead = false, failLabelWrite = false } = {}) {
  const stores = new Map();
  const store = name => { if (!stores.has(name)) stores.set(name, new Map()); return stores.get(name); };
  const downloads = [];
  const storage = {
    readLocalFirstValue: async (name, key) => { if (failRead) throw new Error('Storage unavailable'); return store(name).get(key) ?? null; },
    readAllLocalFirstEntries: async name => [...store(name)].map(([key, value]) => ({ key, value })),
    writeLocalFirstValue: async (name, key, value) => {
      if (name === 'cloudLabels' && failLabelWrite) throw new DOMException('Full', 'QuotaExceededError');
      store(name).set(key, value);
    },
  };
  const api = {
    lookupWarehouseShipment: lookup,
    downloadWarehouseLabel: async path => { downloads.push(path); return download(path); },
  };
  const exports = {};
  vm.runInNewContext(code, { exports, Blob, File, Date, DOMException, crypto: webcrypto, console,
    require: name => name.includes('localFirstDatabase') ? storage : name.includes('warehouseApi') ? api : {},
  });
  return { ...exports, store, downloads };
}


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
  assert.equal(await (await h.readCloudLabelFile(target)).text(), await blob.text());
});

async function indexedTarget(h, id = 'new') {
  h.store('cloudShipments').set(`warehouse:${id}`, { ...shipment(id), warehouseId: 'warehouse' });
  const record = shipment(id);
  return { version: record.version, shipmentId: id, labelAssetId: record.labelAsset.id,
    firstLegTrackingNo: record.firstLegTrackingNo, courierTrackingNo: record.courierTrackingNo,
    labelSha256: hash, labelByteSize: blob.size, labelDownloadPath: record.labelAsset.downloadPath,
    updatedAt: record.updatedAt };
}

test('downloads and validates the scanned label again on every print without persisting it', async () => {
  const h = harness();
  const target = await indexedTarget(h);
  const first = await h.readCloudLabelFile(target);
  assert.equal(await first.text(), await blob.text());
  assert.equal(first.name, 'COURIER-new.pdf');
  await h.readCloudLabelFile(target);
  assert.deepEqual(h.downloads, ['/labels/new', '/labels/new']);
  assert.equal(h.store('cloudLabels').size, 0);
});

test('ignores an old PDF cache even when its metadata matches the server', async () => {
  const h = harness();
  const target = await indexedTarget(h);
  h.store('cloudLabels').set('warehouse:asset-new', { warehouseId: 'warehouse', sha256: hash, blob });
  assert.equal(await (await h.readCloudLabelFile(target)).text(), await blob.text());
  assert.deepEqual(h.downloads, ['/labels/new']);
});

test('download failure cannot print an old cached PDF', async () => {
  const h = harness({ download: async () => { throw new Error('Network unavailable'); } });
  const target = await indexedTarget(h);
  h.store('cloudLabels').set('warehouse:asset-new', { warehouseId: 'warehouse', sha256: hash, blob });
  await assert.rejects(h.readCloudLabelFile(target), /Network unavailable/);
});

test('a full PDF cache does not prevent printing a validated online label', async () => {
  const h = harness({ failLabelWrite: true });
  const target = await indexedTarget(h);
  assert.equal(await (await h.readCloudLabelFile(target)).text(), await blob.text());
});

test('rejects a wrong PDF hash instead of printing or caching it', async () => {
  const h = harness({ download: async () => new Blob(['%PDF-1.4\nWRONG\n%%EOF']) });
  const target = await indexedTarget(h);
  await assert.rejects(h.readCloudLabelFile(target), /SHA-256/);
  assert.equal(h.store('cloudLabels').size, 0);
});

test('a failed scanned download can be retried', async () => {
  let fail = true;
  const h = harness({ download: async () => { if (fail) throw new Error('Network unavailable'); return blob; } });
  const target = await indexedTarget(h);
  await assert.rejects(h.readCloudLabelFile(target), /Network unavailable/);
  fail = false;
  assert.equal(await (await h.readCloudLabelFile(target)).text(), await blob.text());
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

test('rejects a wrong file size or a non-PDF response before printing', async () => {
  for (const invalid of [new Blob(['short']), new Blob(['!PDF-1.4\nlabel\n%%EOF'])]) {
    const h = harness({ download: async () => invalid });
    const target = await indexedTarget(h);
    await assert.rejects(h.readCloudLabelFile(target), /文件格式或大小校验失败/);
    assert.equal(h.store('cloudLabels').size, 0);
  }
});

test('entering the scan page starts cleanup without waiting and tolerates storage failure', async () => {
  const ui = readFileSync(new URL('../src/features/printing/PrintWorkspace.tsx', import.meta.url), 'utf8');
  const start = ui.indexOf('  useEffect(() => {', ui.indexOf('const { session: activeWarehouse, workstation }'));
  const end = ui.indexOf('  const cloudAudit', start);
  const code = ts.transpileModule(ui.slice(start, end), {compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
  const cleanups = [];
  let effect;
  vm.runInNewContext(code, {
    activeWarehouse: {warehouseId:'warehouse'},
    useEffect: callback => { effect = callback; },
    clearWarehouseLabelCache: warehouseId => { cleanups.push(warehouseId); return Promise.reject(new Error('Storage unavailable')); },
  });
  assert.equal(effect(), undefined);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(cleanups, ['warehouse']);
});
