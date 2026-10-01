import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Default is read-only preflight. --apply is required to change production.
const app = '/www/wwwroot/releases/cloud-api-b1c897a-20260920T170700Z';
const node = '/opt/node22/bin/node';
const pm2 = '/www/server/nodejs/v20.10.0/lib/node_modules/pm2/bin/pm2';
const env = { ...process.env, PM2_HOME: '/root/.pm2', PATH: '/opt/node22/bin:' + process.env.PATH };
const normalize = value => value.replace(/\r\n/g, '\n');
const hash = value => createHash('sha256').update(value).digest('hex');
const bundle = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'attendance-unlimited-patch.json')));
assert.equal(execFileSync('curl', ['--noproxy', '*', '--fail', '--silent', '--max-time', '3', 'http://metadata.tencentyun.com/latest/meta-data/instance-id'], { encoding: 'utf8' }).trim(), 'ins-dmx8z3xt');
const processes = JSON.parse(execFileSync(node, [pm2, 'jlist'], { env, encoding: 'utf8' })).filter(p => p.name === 'cloud-api');
assert.equal(processes.length, 1);
assert.equal(processes[0].pm2_env.pm_cwd, app);
assert.equal(processes[0].pm2_env.status, 'online');
assert.deepEqual(bundle.files.map(entry => entry.file).sort(), ['dist/attendanceOperations.js', 'src/attendanceOperations.ts']);
const entries = bundle.files.map(entry => {
  const target = path.join(app, entry.file);
  const original = fs.readFileSync(target, 'utf8');
  const normalized = normalize(original);
  assert.equal(hash(normalized), entry.before, `Live file changed; stop and rebase: ${entry.file}`);
  assert.equal(normalized.split(entry.oldBlock).length, 2);
  const content = normalized.replace(entry.oldBlock, entry.newBlock);
  assert.equal(hash(content), entry.after);
  assert.ok(!content.includes('APPEAL_WINDOW_EXPIRED'));
  return { ...entry, target, original, content, stat: fs.statSync(target) };
});
async function health() {
  const response = await fetch('http://127.0.0.1:8080/healthz', { signal: AbortSignal.timeout(3000) });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).ok, true);
}
await health();
console.log('ATTENDANCE_UNLIMITED_PREFLIGHT=PASS');
if (!process.argv.includes('--apply')) process.exit(0);
const backup = fs.mkdtempSync('/root/attendance-unlimited-backup-');
fs.chmodSync(backup, 0o700);
fs.writeFileSync(path.join(backup, 'manifest.json'), JSON.stringify(bundle, null, 2), { mode: 0o600 });
for (const entry of entries) fs.writeFileSync(path.join(backup, entry.file.replace('/', '-')), entry.original, { mode: 0o600, flag: 'wx' });
console.log('BACKUP=' + backup);
function atomic(entry, content) {
  const temporary = entry.target + '.attendance-' + process.pid;
  fs.writeFileSync(temporary, content, { flag: 'wx', mode: entry.stat.mode & 0o777 });
  fs.chownSync(temporary, entry.stat.uid, entry.stat.gid);
  fs.renameSync(temporary, entry.target);
}
function reload() { execFileSync(node, [pm2, 'reload', 'cloud-api'], { env, stdio: 'pipe', timeout: 30000 }); }
async function waitHealthy() {
  for (let attempt = 0; attempt < 15; attempt++) {
    try { await health(); return; } catch { await new Promise(resolve => setTimeout(resolve, 1000)); }
  }
  throw new Error('Service health did not recover');
}
try {
  // Recheck immediately before writing, so a concurrent deployment is not overwritten.
  for (const entry of entries) assert.equal(hash(normalize(fs.readFileSync(entry.target, 'utf8'))), entry.before);
} catch (error) {
  console.error('PREFLIGHT_CHANGED: ' + error.message);
  process.exit(1);
}
try {
  for (const entry of entries) atomic(entry, entry.content);
  execFileSync(node, ['--check', path.join(app, 'dist/attendanceOperations.js')]);
  reload();
  await waitHealthy();
  for (const entry of entries) assert.equal(hash(normalize(fs.readFileSync(entry.target, 'utf8'))), entry.after);
  console.log('ATTENDANCE_UNLIMITED_DEPLOY=' + JSON.stringify({ status: 'PASS', backup, health: true }));
} catch (error) {
  for (const entry of entries) atomic(entry, entry.original);
  reload();
  await waitHealthy();
  console.error(JSON.stringify({ status: 'ROLLED_BACK', backup, message: error.message }));
  process.exitCode = 1;
}
