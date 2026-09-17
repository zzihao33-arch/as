import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';
import express, { type ErrorRequestHandler } from 'express';
import type { Pool } from 'mysql2/promise';
import { createIntegrationLogs, createIntegrationAudit, createIntegrationLogsRouter, safeSummary } from '../src/integrationLogs.js';
import { ApiError, normalizeApiError } from '../src/errors.js';
import type { WarehouseSession } from '../src/warehouseIdentity.js';

test('summaries omit secrets and binary payloads, including nested and oversized data', () => {
  const summary = safeSummary({ apiKey: 'SECRET', token: 'SECRET', labelPdfBase64: 'SECRET'.repeat(100000), items: [{ password: 'SECRET' }], recipient: { address: 'PRIVATE' } });
  assert.ok(!JSON.stringify(summary).includes('SECRET'));
  assert.ok(!JSON.stringify(summary).includes('PRIVATE'));
  assert.ok(JSON.stringify(summary).length < 1024);
  assert.deepEqual(summary, { format: 'json', itemCount: 1, pdfOmitted: true });
  assert.deepEqual(safeSummary(Buffer.from('PRIVATE PDF')), { format: 'binary', bytes: 11, pdfOmitted: true });
});

test('HTTP audit captures supported attempts before parsers/auth, safely and independently', async () => {
  const attempts: any[] = [];
  const audit = createIntegrationAudit({ append: async (attempt: any) => { attempts.push(attempt); } });
  const app = express();
  app.use((req, _res, next) => { req.requestId = 'same-request-id'; next(); });
  app.use(audit.middleware);
  app.use(express.json({ limit: '1kb' }));
  app.use((req, _res, next) => {
    if (req.header('x-test-status')) return next(new ApiError(Number(req.header('x-test-status')), 'TEST_FAILURE', 'SECRET ERROR'));
    req.client = { id: 'client-1', apiKeyId: 'SECRET', scopes: [], rateLimitPerMinute: 1 }; next();
  });
  app.post(['/api/v1/shipments', '/api/v1/inbound-batches', '/api/v1/air-shipments', '/api/v1/label-pushes'], (_req, res) => res.status(201).json({ data: { token: 'SECRET' } }));
  app.put('/api/v1/shipments/by-first-leg/:tracking/label', express.raw({ type: 'application/pdf' }), (_req, res) => res.json({ data: {} }));
  app.use(((err, _req, res, _next) => { const error = normalizeApiError(err); res.status(error.status).json({ error: { code: error.code, message: error.message } }); }) as ErrorRequestHandler);
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address() as { port: number }; const base = `http://127.0.0.1:${address.port}`;
  try {
    for (const path of ['shipments', 'inbound-batches', 'air-shipments', 'label-pushes', 'shipments']) {
      assert.equal((await fetch(`${base}/api/v1/${path}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': 'SECRET' }, body: JSON.stringify({ firstLegTrackingNo: 'TRACK-1', password: 'SECRET' }) })).status, 201);
    }
    for (const status of [401, 403, 429, 500]) assert.equal((await fetch(`${base}/api/v1/shipments`, { method: 'POST', headers: { 'x-test-status': String(status) } })).status, status);
    assert.equal((await fetch(`${base}/api/v1/air-shipments`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{bad' })).status, 400);
    assert.equal((await fetch(`${base}/api/v1/shipments`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ huge: 'x'.repeat(2000) }) })).status, 413);
    assert.equal((await fetch(`${base}/api/v1/shipments/by-first-leg/TRACK-2/label?token=SECRET`, { method: 'PUT', headers: { 'content-type': 'application/pdf' }, body: 'SECRET PDF' })).status, 200);
    await fetch(`${base}/api/v1/shipments`);
    await audit.drain();
    assert.equal(attempts.length, 12);
    assert.deepEqual(attempts.map(row => row.httpStatus), [201, 201, 201, 201, 201, 401, 403, 429, 500, 400, 413, 200]);
    assert.equal(attempts[9].errorCode, 'INVALID_JSON');
    assert.equal(attempts[0].reference, 'TRACK-1');
    assert.equal(attempts[11].reference, 'TRACK-2');
    assert.equal(attempts[11].requestSummary.pdfOmitted, true);
    assert.ok(!JSON.stringify(attempts).includes('SECRET'));
    assert.equal(attempts[0].requestId, attempts[4].requestId);
  } finally { server.close(); await once(server, 'close'); }
});

test('audit rejection never changes the response and diagnostic is bounded', async () => {
  const diagnostics: unknown[] = [];
  const audit = createIntegrationAudit({ append: async () => { throw new Error('SECRET database error'); }, onFailure: value => diagnostics.push(value) });
  const app = express(); app.use(audit.middleware); app.post('/api/v1/shipments', (_req, res) => res.status(201).json({ data: 'accepted' }));
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    const response = await fetch(`http://127.0.0.1:${(server.address() as { port: number }).port}/api/v1/shipments`, { method: 'POST' });
    assert.equal(response.status, 201); assert.deepEqual(await response.json(), { data: 'accepted' });
    await audit.drain(); assert.equal(diagnostics.length, 1); assert.ok(!JSON.stringify(diagnostics).includes('SECRET'));
  } finally { server.close(); await once(server, 'close'); }
});

function recordingPool(responses: unknown[][]) {
  const calls: { sql: string; values: any[] }[] = [];
  const execute = async (sql: string, values: any[] = []) => { calls.push({ sql, values }); return [responses.shift() ?? [], []]; };
  return { calls, pool: { execute } as unknown as Pool };
}

test('list validates and binds filters, computes full filtered metrics and keeps big IDs as strings', async () => {
  const { calls, pool } = recordingPool([
    [{ cursor: '9007199254740993', readCursor: '0', unreadCount: 8 }], [],
    [{ total: 12, success: 9, failure: 3 }],
    [{ id: '9007199254740993', occurred_at: new Date('2026-09-17T00:00:00Z'), completed_at: new Date('2026-09-17T00:00:01Z'), request_id: 'req', client_id: null, client_name: null, operation: 'shipment', method: 'POST', endpoint: '/api/v1/shipments', reference: 'ABC', http_status: 201, duration_ms: 1000, error_code: null }],
    [{ id: 'client', name: 'Client', code: 'C' }],
  ]);
  const logs = createIntegrationLogs({ mysql: pool });
  const result = await logs.list('user1', { search: "x%' OR 1=1 --", page: '2', pageSize: '5', status: 'success', operation: 'shipment' });
  assert.equal(result.total, 12); assert.deepEqual(result.metrics, { total: 12, success: 9, failure: 3 });
  assert.equal(result.records[0].id, '9007199254740993'); assert.equal(result.records[0].occurredAt, '2026-09-17T00:00:00.000Z');
  const query = calls.find(call => call.sql.includes('ORDER BY l.id DESC'))!;
  assert.ok(query.sql.includes('l.id <= ?')); assert.ok(!query.sql.includes("OR 1=1"));
  assert.ok(query.values.includes("%x!%' OR 1=1 --%")); assert.ok(query.values.includes('9007199254740993'));
  for (const filters of [{ page: '0' }, { pageSize: '101' }, { status: 'bad' }, { operation: 'bad' }, { clientId: 'bad' }, { from: 'yesterday' }, { from: '2026-02-30T00:00:00Z' }, { from: '0000-01-01T00:00:00Z' }, { search: 'a'.repeat(129) }]) {
    await assert.rejects(logs.list('user1', filters), (err: any) => err.status === 400);
  }
});

test('read acknowledgements are clamped to observed cursor and monotonic in SQL, never JS numbers', async () => {
  const { calls, pool } = recordingPool([[], [{ readCursor: '9007199254740993' }]]);
  const logs = createIntegrationLogs({ mysql: pool });
  assert.deepEqual(await logs.markRead('user1', '9007199254740994'), { readCursor: '9007199254740993' });
  assert.match(calls[0].sql, /GREATEST\(read_cursor, LEAST\(CAST\(\? AS UNSIGNED\), observed_cursor\)\)/);
  assert.deepEqual(calls[0].values, ['9007199254740994', 'user1']);
  for (const value of [1, '-1', '01', '18446744073709551616', {}, null]) await assert.rejects(logs.markRead('user1', value), (err: any) => err.status === 400);
});

test('warehouse log routes reject missing session/permission before accessing storage', async () => {
  let accesses = 0;
  const logs = { list: async () => { accesses++; return { records: [] }; }, detail: async () => { accesses++; return {}; }, notifications: async () => { accesses++; return {}; }, markRead: async () => { accesses++; return {}; } };
  const app = express(); app.use(express.json());
  app.use((req, _res, next) => { if (req.header('x-user')) req.warehouseSession = { userId: 'user1', passwordState: 'ACTIVE', permissions: req.header('x-allow') ? ['integration_logs.view'] : [] } as unknown as WarehouseSession; next(); });
  app.use('/warehouse/v1/integration-logs', createIntegrationLogsRouter(logs as any));
  app.use(((err, _req, res, _next) => res.status(err.status ?? 500).json({ error: err.code })) as ErrorRequestHandler);
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening'); const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/warehouse/v1/integration-logs`;
  try {
    for (const path of ['', '/notifications', '/1', '/read']) {
      const method = path === '/read' ? 'POST' : 'GET';
      assert.equal((await fetch(base + path, { method })).status, 401);
      assert.equal((await fetch(base + path, { method, headers: { 'x-user': '1' } })).status, 403);
    }
    assert.equal(accesses, 0);
    assert.equal((await fetch(base + '/notifications', { headers: { 'x-user': '1', 'x-allow': '1' } })).status, 200);
    assert.equal(accesses, 1);
  } finally { server.close(); await once(server, 'close'); }
});

test('captures batch reference and count while suppressing obvious credentials placed in identifier fields', async () => {
  const attempts: any[] = [];
  const audit = createIntegrationAudit({ append: async row => { attempts.push(row); } });
  const app = express(); app.use(audit.middleware); app.use(express.json());
  app.post('/api/v1/inbound-batches', (_req, res) => res.status(400).json({ code: 'VALIDATION_ERROR', message: 'PRIVATE' }));
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    const send = (body: object) => fetch(`http://127.0.0.1:${(server.address() as { port: number }).port}/api/v1/inbound-batches`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    await send({ batchId: 'BATCH-1', shipments: [{ firstLegTrackingNo: 'A' }, { firstLegTrackingNo: 'B' }] });
    await send({ firstLegTrackingNo: 'cmh_live_123456789012_' + 'S'.repeat(43) });
    await audit.drain();
    assert.equal(attempts[0].reference, 'BATCH-1'); assert.equal(attempts[0].requestSummary.itemCount, 2);
    assert.equal(attempts[0].errorCode, 'VALIDATION_ERROR'); assert.equal(attempts[1].reference, null);
    assert.ok(!JSON.stringify(attempts).includes('cmh_live_'));
  } finally { server.close(); await once(server, 'close'); }
});

test('append rejects a missing allocator row rather than silently losing attempts', async () => {
  let destroyed = false; let committed = false;
  const connection = { beginTransaction: async () => {}, execute: async () => [{ affectedRows: 0 }, []], commit: async () => { committed = true; }, destroy: () => { destroyed = true; }, release: () => {} };
  const logs = createIntegrationLogs({ mysql: { getConnection: async () => connection } as unknown as Pool });
  await assert.rejects(logs.append({ occurredAt: new Date(), completedAt: new Date(), requestId: 'request', clientId: null, operation: 'shipment', method: 'POST', endpoint: '/api/v1/shipments', reference: null, httpStatus: 201, durationMs: 0, errorCode: null, requestSummary: {}, responseSummary: {} }));
  assert.equal(committed, false); assert.equal(destroyed, true);
});

test('bounded pending audit writes drop excess attempts without delaying business responses', async () => {
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  const events: unknown[] = []; let writes = 0;
  const audit = createIntegrationAudit({ maxPending: 1, append: async () => { writes++; await gate; }, onFailure: event => events.push(event) });
  const app = express(); app.use(audit.middleware); app.post('/api/v1/shipments', (_req, res) => res.status(201).end());
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    for (let i = 0; i < 3; i++) assert.equal((await fetch(`http://127.0.0.1:${(server.address() as { port: number }).port}/api/v1/shipments`, { method: 'POST' })).status, 201);
    assert.equal(writes, 1); assert.deepEqual(events, [{ event: 'integration_audit_queue_full' }, { event: 'integration_audit_queue_full' }]);
  } finally { release(); await audit.drain(); server.close(); await once(server, 'close'); }
});
