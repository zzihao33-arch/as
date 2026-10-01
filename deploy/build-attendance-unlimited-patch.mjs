import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const normalize = value => value.replace(/\r\n/g, '\n');
const hash = value => createHash('sha256').update(value).digest('hex');
const released = JSON.parse(fs.readFileSync(path.join(root, 'deploy/payroll-rest-patch.json')));
const files = ['src/attendanceOperations.ts', 'dist/attendanceOperations.js'].map(file => {
  const baseline = released.files.find(entry => entry.file === file);
  assert.ok(baseline, `Missing released baseline: ${file}`);
  const before = normalize(baseline.content);
  const after = normalize(fs.readFileSync(path.join(root, 'services/cloud-api', file), 'utf8'));
  assert.equal(hash(before), baseline.after);
  const oldBlock = before.match(/^ +if \(expiresAt\.getTime\(\) < Date\.now\(\)\)(?:\n +| )throw new ApiError\(409, 'APPEAL_WINDOW_EXPIRED', '[^']+'\);\n/m)?.[0];
  const newBlock = after.match(/^ +\/\/ Keep the legacy expires_at[^\n]+\n +\/\/ Appeals have no submission deadline[^\n]+\n/m)?.[0];
  assert.ok(oldBlock && newBlock, `Expected exact deadline change: ${file}`);
  assert.equal(before.replace(oldBlock, newBlock), after, `Unrelated release change: ${file}`);
  return { file, before: hash(before), after: hash(after), oldBlock, newBlock };
});
const bundle = { base: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), files };
fs.writeFileSync(path.join(root, 'deploy/attendance-unlimited-patch.json'), JSON.stringify(bundle, null, 2) + '\n');
console.log('ATTENDANCE_PATCH_BUILD=PASS (exactly two files; only deadline rejection removed)');
