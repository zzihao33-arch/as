// Run only against a disposable schema. Requires built ../dist/integrationLogs.js.
// Connection: INTEGRATION_TEST_MYSQL_HOST/PORT/USER/PASSWORD. A schema named
// integration_logs_test_<random> is created and dropped; business schemas untouched.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import mysql from 'mysql2/promise';
import { executableStatements } from './applyMigrations.mjs';
import { createIntegrationLogs } from '../dist/integrationLogs.js';

const host = process.env.INTEGRATION_TEST_MYSQL_HOST;
const user = process.env.INTEGRATION_TEST_MYSQL_USER;
if (!host || !user || process.env.INTEGRATION_TEST_ALLOW_DISPOSABLE_SCHEMA !== 'yes') {
  throw new Error('Set INTEGRATION_TEST_MYSQL_HOST/USER/PASSWORD and INTEGRATION_TEST_ALLOW_DISPOSABLE_SCHEMA=yes');
}
const database = `integration_logs_test_${randomBytes(8).toString('hex')}`;
assert.match(database, /^integration_logs_test_[a-f0-9]{16}$/);
const config = { host, user, port: Number(process.env.INTEGRATION_TEST_MYSQL_PORT ?? 3306), password: process.env.INTEGRATION_TEST_MYSQL_PASSWORD, timezone: 'Z' };
const admin = await mysql.createConnection(config);
let pool;
try {
  const [[version]] = await admin.query('SELECT VERSION() AS version');
  console.log('Database version:', version.version);
  await admin.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`);
  pool = mysql.createPool({ ...config, database, connectionLimit: 8 });
  await pool.query(`CREATE TABLE clients (id CHAR(36) PRIMARY KEY, display_name VARCHAR(128), client_code VARCHAR(64)) ENGINE=InnoDB`);
  await pool.query(`CREATE TABLE warehouse_permissions (permission_code VARCHAR(96) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY, module_code VARCHAR(64), display_name VARCHAR(128), risk_level ENUM('LOW','MEDIUM','HIGH')) ENGINE=InnoDB`);
  await pool.query(`CREATE TABLE warehouse_role_permissions (role_id CHAR(36), permission_code VARCHAR(96) CHARACTER SET ascii COLLATE ascii_bin, PRIMARY KEY(role_id,permission_code), FOREIGN KEY(permission_code) REFERENCES warehouse_permissions(permission_code)) ENGINE=InnoDB`);
  await pool.query(`INSERT INTO warehouse_permissions VALUES ('accounts.manage','accounts','Accounts','HIGH'), ('roles.manage','roles','Roles','HIGH')`);
  await pool.query(`INSERT INTO warehouse_role_permissions VALUES ('manager-custom','accounts.manage'),('manager-custom','roles.manage'),('ordinary','accounts.manage')`);
  const sql = await readFile(new URL('../../../database/018_add_integration_push_logs.sql', import.meta.url), 'utf8');
  for (const statement of executableStatements(sql)) await pool.query(statement);
  const [roles] = await pool.query(`SELECT role_id FROM warehouse_role_permissions WHERE permission_code = 'integration_logs.view'`);
  assert.deepEqual(roles.map(row => row.role_id), ['manager-custom']);
  console.log('PASS migration with inherited 0900 collation and capability-based permission seed');

  let allowFirstCommit, firstInserted;
  const gate = new Promise(resolve => { allowFirstCommit = resolve; });
  const inserted = new Promise(resolve => { firstInserted = resolve; });
  let first = true;
  const delayedPool = {
    execute: pool.execute.bind(pool),
    getConnection: async () => {
      const connection = await pool.getConnection();
      if (!first) return connection;
      first = false;
      return {
        beginTransaction: () => connection.beginTransaction(),
        execute: connection.execute.bind(connection),
        commit: async () => { firstInserted(); await gate; return connection.commit(); },
        destroy: () => connection.destroy(), release: () => connection.release(),
      };
    },
  };
  const logs = createIntegrationLogs({ mysql: delayedPool });
  const attempt = requestId => ({ occurredAt: new Date('2026-09-17T01:00:00Z'), completedAt: new Date('2026-09-17T01:00:01Z'), requestId,
    clientId: null, operation: 'shipment', method: 'POST', endpoint: '/api/v1/shipments', reference: 'TRACK_1', httpStatus: 201, durationMs: 1000, errorCode: null,
    requestSummary: { format: 'json', pdfOmitted: true }, responseSummary: { httpStatus: 201 } });
  const firstWrite = logs.append(attempt('first'));
  await inserted;
  let secondFinished = false;
  const secondWrite = logs.append(attempt('second')).then(() => { secondFinished = true; });
  try {
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(secondFinished, false, 'second allocation cannot pass the first uncommitted row');
    assert.deepEqual(await logs.notifications('account-a'), { cursor: '0', readCursor: '0', unreadCount: 0 });
  } finally { allowFirstCommit(); await Promise.all([firstWrite, secondWrite]); }
  const [ordered] = await pool.query(`SELECT CAST(id AS CHAR) AS id, request_id FROM integration_push_logs ORDER BY id`);
  assert.deepEqual(ordered, [{ id: '1', request_id: 'first' }, { id: '2', request_id: 'second' }]);
  assert.deepEqual(await logs.notifications('account-a'), { cursor: '2', readCursor: '0', unreadCount: 2 });
  console.log('PASS delayed lower commit blocks higher ID; notifications never skip unfinished rows');

  await assert.rejects(logs.append({ ...attempt('rollback'), httpStatus: 999 }));
  await assert.rejects(logs.append({ ...attempt('oversized'), requestSummary: { unsafe: 'x'.repeat(3000) } }));
  await logs.append(attempt('third'));
  assert.equal((await logs.detail('3')).requestId, 'third');
  assert.deepEqual(await logs.markRead('account-a', '999'), { readCursor: '2' });
  assert.deepEqual(await logs.notifications('account-a'), { cursor: '3', readCursor: '2', unreadCount: 1 });
  await Promise.all([logs.markRead('account-a', '1'), logs.markRead('account-a', '3'), logs.markRead('account-a', '0')]);
  assert.deepEqual(await logs.notifications('account-a'), { cursor: '3', readCursor: '3', unreadCount: 0 });
  assert.deepEqual(await logs.markRead('never-observed', '999'), { readCursor: '0' });
  assert.deepEqual(await logs.notifications('account-b'), { cursor: '3', readCursor: '0', unreadCount: 3 });
  console.log('PASS failed audit rollback, bounded observed acknowledgement, concurrent monotonic reads, account isolation');

  await logs.append({ ...attempt('failed'), httpStatus: 400, errorCode: 'VALIDATION_ERROR', responseSummary: { httpStatus: 400, errorCode: 'VALIDATION_ERROR' } });
  const listed = await logs.list('account-a', { pageSize: '1', status: 'success', search: 'TRACK_1', from: '2026-09-17T00:00:00.000Z', to: '2026-09-17T02:00:00.000Z' });
  assert.deepEqual(listed.metrics, { total: 3, success: 3, failure: 0 });
  assert.equal(listed.records.length, 1); assert.equal(listed.records[0].id, '3');
  assert.equal(listed.records[0].occurredAt, '2026-09-17T01:00:00.000Z');
  assert.equal((await logs.list('account-a', { search: "%' OR 1=1 --" })).total, 0);
  assert.equal((await logs.list('account-a', { status: 'failure', clientId: 'unknown' })).total, 1);
  assert.deepEqual((await logs.detail('4')).responseSummary, { httpStatus: 400, errorCode: 'VALIDATION_ERROR' });
  await assert.rejects(logs.detail('999'), error => error.status === 404);
  console.log('PASS real prepared list/detail filters, metrics, timestamps, LIKE escaping and absent detail');

  // Exercise restricted application grants, using a temporary account limited to
  // this temporary schema. Disabled by default when CREATE USER is unavailable.
  if (process.env.INTEGRATION_TEST_VERIFY_GRANTS === 'yes') {
    const account = `iltest_${randomBytes(6).toString('hex')}`;
    const password = randomBytes(24).toString('hex');
    try {
      await admin.query(`CREATE USER '${account}'@'127.0.0.1' IDENTIFIED BY ?`, [password]);
      for (const [table, privileges] of [['clients','SELECT'], ['integration_push_logs','SELECT, INSERT'], ['integration_push_log_sequence','SELECT, UPDATE'], ['integration_push_log_reads','SELECT, INSERT, UPDATE']]) {
        await admin.query(`GRANT ${privileges} ON \`${database}\`.${table} TO '${account}'@'127.0.0.1'`);
      }
      const restricted = mysql.createPool({ ...config, host: '127.0.0.1', database, user: account, password, connectionLimit: 2 });
      try {
        const limitedLogs = createIntegrationLogs({ mysql: restricted });
        await limitedLogs.append(attempt('restricted'));
        assert.equal((await limitedLogs.list('restricted-user', {})).total, 5);
        assert.equal((await limitedLogs.markRead('restricted-user', '5')).readCursor, '5');
        assert.equal((await limitedLogs.detail('5')).requestId, 'restricted');
      } finally { await restricted.end(); }
      console.log('PASS exact table-scoped application grants');
    } finally { await admin.query(`DROP USER IF EXISTS '${account}'@'127.0.0.1'`); }
  }
} finally {
  if (pool) await pool.end();
  await admin.query(`DROP DATABASE IF EXISTS \`${database}\``);
  await admin.end();
}
console.log('PASS disposable schema removed; verification complete');
