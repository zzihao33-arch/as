import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { webcrypto } from 'node:crypto';

// Exercise the production scan controller without mounting the unrelated import UI.
const source = readFileSync(new URL('../src/features/printing/PrintWorkspace.tsx', import.meta.url), 'utf8');
const controller = source.slice(source.indexOf('  const processScan ='), source.indexOf('  const forcePrint ='));
const code = ts.transpileModule(controller + '\nexports.scan = processScan;', { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const target = { shipmentId: 'one', labelAssetId: 'asset', firstLegTrackingNo: 'ORIGINAL', courierTrackingNo: 'TRANSFER' };
class ApiError extends Error { constructor(code) { super(code); this.code = code; this.status = 404; } }
function harness(lookup = async () => target) {
  const printed = [], messages = [], lookups = [], checked = [];
  const ref = current => ({ current });
  const context = { exports: {}, crypto: webcrypto, Date, Error, console,
    sanitizeBarcode: value => value.trim(), normalizeBarcode: value => value.trim().toLowerCase(),
    cloudLibrary: { byBarcode: new Map(), status: 'ready' }, workstation: { id: 'station' },
    activeWarehouse: { warehouseId: 'warehouse' }, uploadSessionReadyRef: ref(true), interceptStorageStatus: 'ready',
    emergencyOfflineEnabled: false, interceptScanLockRef: ref(null), inFlightScansRef: ref(new Set()),
    inFlightCloudShipmentsRef: ref(new Set()), recentCloudShipmentsRef: ref(new Map()),
    recentlyPrinted: [], logs: [], mappingIndexRef: ref(new Map()), pdfSearchIndexRef: ref({}), mappingRef: ref({}), pdfFilesRef: ref({}),
    findInterceptRule: () => null, findPdfMatch: () => ({ ambiguous: false }),
    announceScanFeedback() {}, playScanFeedback: async () => {}, setDuplicateInfo() {}, setInterceptedScan() {},
    playInterceptAlert: async () => {}, addLog: (...args) => messages.push(args), appendLog() {},
    setStats() {}, setRecentlyPrinted() {}, setQzConnectionHealth() {},
    claimSharedWorkBatchItem: async () => { throw new ApiError('BATCH_ITEM_NOT_FOUND'); }, WarehouseApiError: ApiError,
    resolveCloudPrintTarget: async code => { lookups.push(code); return lookup(code); },
    checkGlobalIntercepts: async numbers => { checked.push(numbers); return { blocked: false }; },
    readCloudLabelFile: async () => new Blob(['PDF']), readPdfAsBase64: async () => 'encoded',
    printPdfWithQz: async data => { printed.push(data); return {}; }, cloudAudit: { record: async () => {} },
    formatQzError: error => error.message,
  };
  vm.runInNewContext(code, context);
  const settle = () => new Promise(resolve => setTimeout(resolve, 30));
  return { scan: context.exports.scan, printed, messages, lookups, checked, context, settle };
}
test('a new server shipment prints without a browser mapping and checks both aliases', async () => {
  const h = harness(); h.scan('TRANSFER'); await h.settle();
  assert.equal(h.printed.length, 1);
  assert.ok(h.checked[0].includes('ORIGINAL'));
  assert.ok(h.checked[0].includes('TRANSFER'));
});
test('overlapping original and transfer scans submit only one print', async () => {
  const h = harness(); h.scan('ORIGINAL'); h.scan('TRANSFER'); await h.settle();
  assert.equal(h.printed.length, 1);
});
test('lookup and live-intercept failures stop printing even in emergency mode', async () => {
  const h = harness(async () => { throw new Error('Lookup unavailable'); });
  h.scan('ORIGINAL'); await h.settle(); assert.equal(h.printed.length, 0);
  assert.ok(h.messages.some(args => String(args[2]).includes('Lookup unavailable')));
  const blocked = harness(); blocked.context.emergencyOfflineEnabled = true;
  blocked.context.checkGlobalIntercepts = async () => { throw new Error('Intercept unavailable'); };
  blocked.scan('ORIGINAL'); await blocked.settle(); assert.equal(blocked.printed.length, 0);
});

test('a label replaced during download is never submitted to the printer', async () => {
  let calls = 0;
  const h = harness(async () => ++calls === 1 ? target : { ...target, labelAssetId: 'replacement' });
  h.scan('ORIGINAL'); await h.settle();
  assert.equal(h.printed.length, 0);
});

test('a transfer number changed with the same PDF cannot bypass interception', async () => {
  let calls = 0;
  const h = harness(async () => ++calls === 1 ? { ...target, version: 1 } : { ...target, version: 2, courierTrackingNo: 'NEW-BLOCKED' });
  h.scan('ORIGINAL'); await h.settle(); assert.equal(h.printed.length, 0);
});

test('a later scan of the other alias requires explicit duplicate override', async () => {
  const h = harness(); h.scan('ORIGINAL'); await h.settle(); h.scan('TRANSFER'); await h.settle();
  assert.equal(h.printed.length, 1);
  h.scan('TRANSFER', true, true); await h.settle(); assert.equal(h.printed.length, 2);
});
