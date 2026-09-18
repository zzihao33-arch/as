// Loopback-only synthetic acceptance API. No real credentials or writes.
// node tests/fixtures/airPickupListServer.mjs
import http from 'node:http';

let mode = 'ok';
let delay = 0;
const events = [];
const pending = [];
const session = {
  sessionId: 'list-fixture', userId: 'list-fixture', userName: '列表合成验收', loginName: 'list-fixture',
  platformRole: null, passwordState: 'ACTIVE', warehouseId: null, warehouseName: '隔离验收仓',
  roleName: '验收角色', workspaces: [], permissions: ['air_pickups.view'],
  expiresAt: new Date(Date.now() + 4 * 3600_000).toISOString(),
  absoluteExpiresAt: new Date(Date.now() + 8 * 3600_000).toISOString(),
};
const order = (id, processed) => ({
  id, billNo: id, normalizedBillNo: id, billNoIsStandard: false, sourceClientName: '合成客户',
  sourceClientId: 'fixture-client', cargoName: null, forecastCartons: 1, forecastPackages: 50000,
  forecastWeight: 80, forecastWeightUnit: 'KG', status: 'RECORDED', evidenceStatus: 'NONE',
  version: 1, handoverBatchId: null, receiptBatchId: null,
  exchangeProgress: { total: 50000, processed, changed: processed, intercepted: 0, exceptions: 0, pending: 50000 - processed },
  createdAt: '2026-09-18T12:00:00Z', updatedAt: '2026-09-18T12:00:00Z',
});
http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1:4820');
  res.setHeader('Access-Control-Allow-Origin', 'http://127.0.0.1:4819');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Content-Type', 'application/json');
  const send = (value, status = 200) => { res.writeHead(status); res.end(JSON.stringify(value)); };
  if (req.method === 'OPTIONS') return send(null, 204);
  if (url.pathname === '/__control' && req.method === 'POST') {
    if (url.searchParams.has('mode')) mode = url.searchParams.get('mode');
    if (url.searchParams.has('delay')) delay = Number(url.searchParams.get('delay'));
    if (url.searchParams.has('release')) pending.splice(0).forEach(resolve => resolve());
    return send({ mode, delay });
  }
  if (url.pathname === '/__stats') return send({ mode, events, pending: pending.length });
  if (req.method !== 'GET') return send({ error: { code: 'FIXTURE_READ_ONLY', message: '只读合成验收' } }, 405);
  if (url.pathname === '/warehouse/v1/session') return send({ data: session });
  if (url.pathname === '/warehouse/v1/air-pickup-clients') return send({ data: [] });
  if (url.pathname === '/warehouse/v1/air-pickups') {
    const search = url.searchParams.get('search') || '';
    const capturedMode = mode;
    const event = { search, mode: capturedMode, requestedAt: new Date().toISOString() };
    events.push(event);
    if (events.length > 100) events.shift();
    if (search === 'slow') await new Promise(resolve => pending.push(resolve));
    if (delay) await new Promise(resolve => setTimeout(resolve, delay));
    event.respondedAt = new Date().toISOString();
    if (capturedMode === 'fail') return send({ error: { code: 'FIXTURE_LIST_UNAVAILABLE', message: '合成列表暂不可用' } }, 503);
    const data = capturedMode === 'empty' ? [] : search ? [order(`FIXTURE-${search}`, 49999)]
      : [order('FIXTURE-99.8', 49900), order('FIXTURE-99.9', 49999), order('FIXTURE-100', 50000)];
    return send({ data, pagination: { page: 1, pageSize: 20, total: data.length },
      summary: { recorded: data.length, received: 0, handedOver: 0, voided: 0, evidencePending: 0 } });
  }
  return send({ error: { code: 'FIXTURE_ROUTE_NOT_FOUND', message: url.pathname } }, 404);
}).listen(4820, '127.0.0.1', () => console.log('LIST_FIXTURE_READY http://127.0.0.1:4820'));
