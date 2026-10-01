import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const app = '/www/wwwroot/releases/cloud-api-b1c897a-20260920T170700Z';
const node = '/opt/node22/bin/node';
const pm2 = '/www/server/nodejs/v20.10.0/lib/node_modules/pm2/bin/pm2';
const env = { ...process.env, PM2_HOME: '/root/.pm2', PATH: '/opt/node22/bin:' + process.env.PATH };
delete env.DBA_PASSWORD;
const normalize = value => value.replace(/\r\n/g, '\n');
const hash = value => createHash('sha256').update(value).digest('hex');
const bundle = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'payroll-rest-patch.json')));
assert.equal(execFileSync('curl', ['--noproxy', '*', '--fail', '--silent', '--max-time', '3', 'http://metadata.tencentyun.com/latest/meta-data/instance-id'], { encoding: 'utf8' }).trim(), 'ins-dmx8z3xt');
const processes = JSON.parse(execFileSync(node, [pm2, 'jlist'], { env, encoding: 'utf8' })).filter(p => p.name === 'cloud-api');
assert.equal(processes.length, 1);
assert.equal(processes[0].pm2_env.pm_cwd, app);
assert.equal(processes[0].pm2_env.status, 'online');
process.chdir(app);
const entries = bundle.files.map(entry => {
  assert.match(entry.file, /^(src\/(attendanceCalculations|attendanceOperations|index|payrollBreakRules)\.ts|dist\/(attendanceCalculations|attendanceOperations|index|payrollBreakRules)\.js)$/);
  const target = path.join(app, entry.file);
  const original = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : null;
  assert.equal(original === null ? null : hash(normalize(original)), entry.before, `Live file changed: ${entry.file}`);
  assert.equal(hash(entry.content), entry.after);
  return { ...entry, target, original, stat: fs.statSync(original === null ? path.join(app, entry.file.startsWith('src/') ? 'src/index.ts' : 'dist/index.js') : target) };
});
const health = async () => {
  const response = await fetch('http://127.0.0.1:8080/healthz', { signal: AbortSignal.timeout(3000) });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).ok, true);
};
await health();
console.log('PAYROLL_PATCH_PREFLIGHT=PASS');
if (!process.argv.includes('--apply')) process.exit(0);
assert.ok(process.env.DBA_PASSWORD, 'DBA_PASSWORD must be supplied locally; it is never printed');
const require = createRequire(path.join(app, 'package.json'));
const mysql = require('mysql2/promise');
const { config } = await import(pathToFileURL(path.join(app, 'dist/config.js')));
const db = await mysql.createConnection({ ...config.mysql, user: 'root', password: process.env.DBA_PASSWORD, timezone: 'Z' });
delete process.env.DBA_PASSWORD;
const backup = fs.mkdtempSync('/root/payroll-rest-backup-');
fs.chmodSync(backup, 0o700);
fs.writeFileSync(path.join(backup, 'manifest.json'), JSON.stringify(entries.map(({ file, before, after }) => ({ file, before, after }))), { mode: 0o600 });
for (const entry of entries) if (entry.original !== null) fs.writeFileSync(path.join(backup, entry.file.replace('/', '-')), entry.original, { mode: 0o600, flag: 'wx' });
try {
  await db.query('SET SESSION lock_wait_timeout=5');
  const migration = bundle.migration;
  assert.equal(hash(migration.sql), migration.sha256);
  const [ledgerTables] = await db.query("SHOW TABLES LIKE 'schema_migrations'");
  assert.equal(ledgerTables.length, 1, 'Migration ledger must exist');
  const [recorded] = await db.execute('SELECT sha256 FROM schema_migrations WHERE filename=?', [migration.filename]);
  if (recorded.length) assert.equal(recorded[0].sha256, migration.sha256);
  else {
    const [tables] = await db.query("SHOW TABLES LIKE 'attendance_payroll_break_rules'");
    const [columns] = await db.query("SHOW COLUMNS FROM attendance_payroll_run_rows LIKE 'daily_details_snapshot'");
    assert.equal(tables.length, 0, 'Unrecorded break table exists; inspect before retrying');
    assert.equal(columns.length, 0, 'Unrecorded snapshot column exists; inspect before retrying');
    const statements = migration.sql.replace(/^--[^\n]*\n/, '').split(';').map(s => s.trim()).filter(s => s && !/^USE\s/i.test(s));
    assert.equal(statements.length, 2);
    for (const statement of statements) await db.query(statement);
    await db.execute('INSERT INTO schema_migrations (filename,sha256) VALUES (?,?)', [migration.filename, migration.sha256]);
  }
  // Database-scoped grants already cover the new table. Table-scoped accounts
  // must receive the same SELECT/INSERT/UPDATE privileges before this check.
  const runtime = await mysql.createConnection({ ...config.mysql, timezone: 'Z' });
  try {
    await runtime.query('SELECT id FROM attendance_payroll_break_rules LIMIT 0');
    await runtime.query('SELECT daily_details_snapshot FROM attendance_payroll_run_rows LIMIT 0');
    await runtime.query('START TRANSACTION');
    await runtime.query('UPDATE attendance_payroll_break_rules SET start_time=start_time WHERE 1=0');
    await runtime.query('INSERT INTO attendance_payroll_break_rules SELECT * FROM attendance_payroll_break_rules WHERE 1=0');
    await runtime.query('ROLLBACK');
  } finally { await runtime.end(); }
  console.log('PAYROLL_SCHEMA_AND_RUNTIME_ACCESS=PASS');
} finally { await db.end(); }

const atomic = (entry, content) => {
  const temporary = entry.target + '.payroll-' + process.pid;
  fs.writeFileSync(temporary, content, { flag: 'wx', mode: entry.stat.mode & 0o777 });
  fs.chownSync(temporary, entry.stat.uid, entry.stat.gid);
  fs.renameSync(temporary, entry.target);
};
try {
  for (const entry of entries) atomic(entry, entry.content);
  for (const entry of entries.filter(e => e.file.startsWith('dist/'))) execFileSync(node, ['--check', entry.target]);
  const { calculateBreakOverlap } = await import(pathToFileURL(path.join(app, 'dist/attendanceCalculations.js')));
  assert.equal(calculateBreakOverlap(new Date('2026-09-30T16:30:00Z'), new Date('2026-09-30T22:00:00Z')), 30);
  assert.equal(calculateBreakOverlap(new Date('2026-09-30T17:01:00Z'), new Date('2026-09-30T22:00:00Z')), 0);
  execFileSync(node, [pm2, 'reload', 'cloud-api'], { env, stdio: 'pipe', timeout: 30000 });
  let healthy = false;
  for (let attempt = 0; attempt < 15; attempt++) {
    try { await health(); healthy = true; break; } catch { await new Promise(resolve => setTimeout(resolve, 1000)); }
  }
  assert.ok(healthy);
  const response = await fetch('http://127.0.0.1:8080/warehouse/v1/attendance/payroll-break-rules', { headers: { Origin: 'https://cmhubtool.com' } });
  assert.equal(response.status, 401, 'New route must require authentication');
  for (const entry of entries) assert.equal(hash(normalize(fs.readFileSync(entry.target, 'utf8'))), entry.after);
  console.log('PAYROLL_DEPLOY=' + JSON.stringify({ status: 'PASS', backup, health: true, unauthenticatedStatus: response.status }));
} catch (error) {
  for (const entry of entries) {
    if (entry.original === null) { if (fs.existsSync(entry.target)) fs.unlinkSync(entry.target); }
    else atomic(entry, entry.original);
  }
  execFileSync(node, [pm2, 'reload', 'cloud-api'], { env, stdio: 'pipe', timeout: 30000 });
  console.error(JSON.stringify({ status: 'ROLLED_BACK', backup, message: error.message, additiveSchemaRetained: true }));
  process.exitCode = 1;
}
