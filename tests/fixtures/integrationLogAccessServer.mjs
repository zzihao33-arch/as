// Synthetic, loopback-only browser regression fixture. Never uses real credentials.
// Run with: node tests/fixtures/integrationLogAccessServer.mjs
import http from 'node:http';

let mode = 'allowed';
let user = 'fixture-a';
let sessionDelayMs = 0;
let cursor = 3;
const reads = new Map();
const counts = {};
let requestSequence = 0;
const events = [];
const records = Array.from({ length: 3 }, (_, index) => ({
  id: String(3 - index), occurredAt: new Date().toISOString(), completedAt: new Date().toISOString(),
  requestId: `fixture-request-${3 - index}`, clientId: 'fixture-client', clientName: '合成验收客户',
  operation: 'label_push', method: 'POST', endpoint: '/api/v1/label-pushes', reference: `FIXTURE-${3 - index}`,
  httpStatus: 200, outcome: 'success', durationMs: 2, errorCode: null,
}));
const view = () => ({
  sessionId: `session-${user}`, userId: user, userName: user, loginName: user,
  email: null, phone: null, platformRole: null, passwordState: 'ACTIVE',
  warehouseId: null, warehouseCode: null, warehouseName: '隔离验收仓', membershipId: null,
  roleId: 'fixture-role', roleName: '验收角色', workspaces: [],
  permissions: mode === 'denied' ? ['roles.view'] : ['roles.view', 'integration_logs.view'],
  expiresAt: new Date(Date.now() + 4 * 3600_000).toISOString(),
  absoluteExpiresAt: new Date(Date.now() + 8 * 3600_000).toISOString(),
});

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1:4818');
  res.setHeader('Access-Control-Allow-Origin', 'http://127.0.0.1:4817');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
  res.setHeader('Content-Type', 'application/json');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
  const send = (data, status = 200) => { res.writeHead(status); res.end(JSON.stringify({ data })); };
  const fail = (status, code) => { res.writeHead(status); res.end(JSON.stringify({ error: { code, message: code } })); };
  if (url.pathname === '/__control' && req.method === 'POST') {
    if (url.searchParams.has('mode')) mode = url.searchParams.get('mode');
    if (url.searchParams.has('user')) user = url.searchParams.get('user');
    if (url.searchParams.has('delay')) sessionDelayMs = Number(url.searchParams.get('delay'));
    if (url.searchParams.has('advance')) cursor += Number(url.searchParams.get('advance'));
    return send({ mode, user, sessionDelayMs, cursor });
  }
  if (url.pathname === '/__stats') return send({ mode, user, cursor, reads: Object.fromEntries(reads), counts, events });
  const requestId = ++requestSequence;
  const requestUser = user;
  const recordEvent = (phase, status) => {
    events.push({ requestId, phase, method: req.method, path: url.pathname, user: requestUser, status, at: new Date().toISOString() });
    if (events.length > 100) events.shift();
  };
  recordEvent('request');
  res.once('finish', () => recordEvent('response', res.statusCode));
  counts[`${req.method} ${url.pathname}`] = (counts[`${req.method} ${url.pathname}`] || 0) + 1;
  if (url.pathname === '/warehouse/v1/session') {
    if (req.method === 'DELETE') { mode = 'expired'; return send(null); }
    const snapshot = view();
    const capturedMode = mode;
    await new Promise(resolve => setTimeout(resolve, sessionDelayMs));
    if (capturedMode === 'expired') return fail(401, 'SESSION_REQUIRED');
    if (capturedMode === 'session-failure') return fail(503, 'FIXTURE_SESSION_UNAVAILABLE');
    return send(snapshot);
  }
  if (url.pathname === '/warehouse/v1/sessions' && req.method === 'POST') {
    let body = '';
    for await (const part of req) body += part;
    const input = JSON.parse(body);
    if (!['fixture-a', 'fixture-b'].includes(input.loginName) || input.password !== 'fixture-password') return fail(401, 'FIXTURE_LOGIN_REQUIRED');
    user = input.loginName;
    mode = 'allowed';
    return send(view());
  }
  if (['/warehouse/v1/roles', '/warehouse/v1/permissions'].includes(url.pathname)) return send([]);
  if (url.pathname.startsWith('/warehouse/v1/integration-logs')) {
    if (mode === 'expired') return fail(401, 'SESSION_REQUIRED');
    if (mode !== 'allowed') return fail(403, 'PERMISSION_DENIED');
    if (url.pathname.endsWith('/notifications')) return send({ cursor: String(cursor), readCursor: String(reads.get(user) || 0), unreadCount: cursor - (reads.get(user) || 0) });
    if (url.pathname.endsWith('/read')) {
      let body = '';
      for await (const part of req) body += part;
      reads.set(user, Math.max(reads.get(user) || 0, Math.min(cursor, Number(JSON.parse(body).cursor))));
      return send({ readCursor: String(reads.get(user)) });
    }
    const id = url.pathname.match(/integration-logs\/(\d+)$/)?.[1];
    if (id) return send({ ...records.find(row => row.id === id), requestSummary: {}, responseSummary: { httpStatus: 200 } });
    return send({ records, total: records.length, page: 1, pageSize: 20, cursor: String(cursor),
      metrics: { total: records.length, success: records.length, failure: 0 }, clients: [] });
  }
  return fail(404, 'FIXTURE_ROUTE_NOT_FOUND');
}).listen(4818, '127.0.0.1', () => console.log('ACCESS_FIXTURE_READY http://127.0.0.1:4818'));
