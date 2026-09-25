import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const source = readFileSync(new URL('../src/features/session/warehouseApi.ts', import.meta.url), 'utf8').replaceAll('import.meta.env', 'TEST_ENV');
const code = ts.transpileModule(source, {compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
test('PDF download bypasses HTTP cache and preserves authenticated access', async () => {
  const exports = {};
  const requests = [];
  vm.runInNewContext(code, {exports, TEST_ENV:{DEV:false}, fetch: async (url, options) => {
    requests.push({url,options});
    return new Response('%PDF-fresh');
  }});
  assert.equal(await (await exports.downloadWarehouseLabel('/warehouse/v1/label-assets/test/content')).text(), '%PDF-fresh');
  assert.equal(requests[0].options.cache, 'no-store');
  assert.equal(requests[0].options.credentials, 'include');
});
