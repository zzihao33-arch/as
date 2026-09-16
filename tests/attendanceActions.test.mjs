import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

// Render the real panels and TDesign Card. Only the login context is a fixture;
// server rendering never runs effects or sends attendance requests.
await mkdir('.cache', { recursive: true });
const temp = await mkdtemp(path.resolve('.cache/attendance-actions-'));
const output = path.join(temp, 'panels.cjs');
await build({
  entryPoints: ['src/features/attendance/AttendancePayrollWorkspace.tsx'],
  outfile: output, bundle: true, platform: 'node', format: 'cjs', packages: 'external',
  define: { 'import.meta.env': '{}' },
  plugins: [{ name: 'attendance-session-fixture', setup(builder) {
    builder.onResolve({ filter: /WarehouseSessionProvider$/ }, () => ({ path: 'session', namespace: 'fixture' }));
    builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: `
      export const permissions = new Set();
      export function useWarehouseSession() { return { hasPermission: p => permissions.has(p) }; }
    ` }));
    builder.onLoad({ filter: /AttendancePayrollWorkspace\.tsx$/ }, async args => ({
      contents: await readFile(args.path, 'utf8') + '\nexport { AppealsPanel, ConfigurationPanel, PayrollPanel };\nexport { permissions } from "../session/WarehouseSessionProvider";',
      loader: 'tsx', resolveDir: path.dirname(args.path),
    }));
  } }],
});
const panels = createRequire(import.meta.url)(output);
const render = (name, permissions) => {
  panels.permissions.clear();
  permissions.forEach(p => panels.permissions.add(p));
  return renderToStaticMarkup(React.createElement(panels[name], { refreshKey: 0, onChanged() {} }));
};

test('authorized employee can see the appeal action', () => {
  assert.match(render('AppealsPanel', ['attendance.appeal']), /<button\b[^>]*>[\s\S]*?发起申诉[\s\S]*?<\/button>/);
});
test('employee without appeal permission cannot see the action', () => {
  assert.doesNotMatch(render('AppealsPanel', ['attendance.self_view']), /发起申诉/);
});
test('payroll exporter can see the export action', () => {
  assert.match(render('PayrollPanel', ['payroll.export']), /固化并导出 Excel/);
});
test('non-exporter cannot see the payroll export action', () => {
  assert.doesNotMatch(render('PayrollPanel', []), /固化并导出 Excel/);
});
test.after(async () => {
  assert.ok(path.resolve(temp).startsWith(path.resolve('.cache') + path.sep + 'attendance-actions-'));
  await rm(temp, { recursive: true });
});
