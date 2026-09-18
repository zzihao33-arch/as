// Local browser acceptance fixture. Synthetic records only; business writes are refused.
// node tests/fixtures/airPickupContinuityServer.mjs
import http from 'node:http';

const events = [];
const pending = [];
let detailMode = 'ok';
let limit = 50;
const clients = [{ id: 'client-a', code: 'A', name: '合成客户 A' }, { id: 'client-b', code: 'B', name: '合成客户 B' }];
const orders = Array.from({ length: 50 }, (_, i) => ({
  id: `fixture-${i + 1}`, billNo: `FIXTURE-${String(i + 1).padStart(3, '0')}`,
  normalizedBillNo: `FIXTURE-${i + 1}`, billNoIsStandard: false,
  sourceClientId: clients[i % 2].id, sourceClientName: clients[i % 2].name,
  cargoName: null, forecastCartons: i + 1, forecastPackages: 100 + i,
  forecastWeight: 10 + i, forecastWeightUnit: 'KG',
  status: i < 25 ? 'RECORDED' : 'RECEIVED', evidenceStatus: 'NONE', version: 1,
  receiptBatchId: null, handoverBatchId: null,
  exchangeProgress: { total: 100 + i, processed: 0, changed: 0, intercepted: 0, exceptions: 0, pending: 100 + i },
  createdAt: '2026-09-18T12:00:00Z', updatedAt: '2026-09-18T12:00:00Z', evidence: [],
}));
const session = {
  sessionId: 'continuity-fixture', userId: 'continuity-fixture', userName: '跨页合成验收', loginName: 'continuity-fixture',
  platformRole: null, passwordState: 'ACTIVE', warehouseId: null, warehouseName: '隔离验收仓',
  roleName: '验收角色', workspaces: [], permissions: ['air_pickups.view', 'air_pickups.receive', 'air_pickups.handover'],
  expiresAt: new Date(Date.now() + 4 * 3600_000).toISOString(),
  absoluteExpiresAt: new Date(Date.now() + 8 * 3600_000).toISOString(),
};
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
    if (url.searchParams.has('detailMode')) detailMode = url.searchParams.get('detailMode');
    if (url.searchParams.has('limit')) limit = Math.max(0, Math.min(50, Number(url.searchParams.get('limit'))));
    if (url.searchParams.has('release')) pending.splice(0).forEach(resolve => resolve());
    return send({ detailMode, limit });
  }
  if (url.pathname === '/__stats') return send({ detailMode, limit, pending: pending.length, events });
  const event = { method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), requestedAt: new Date().toISOString() };
  events.push(event);
  if (events.length > 500) events.shift();
  if (req.method !== 'GET') return send({ error: { code: 'FIXTURE_READ_ONLY', message: '合成验收拒绝业务写入' } }, 405);
  if (url.pathname === '/warehouse/v1/session') return send({ data: session });
  if (url.pathname === '/warehouse/v1/air-pickup-clients') return send({ data: clients });
  if (url.pathname === '/warehouse/v1/air-pickups') {
    const { search = '', clientId = '', status = '', evidenceStatus = '' } = event.query;
    const filtered = orders.slice(0, limit).filter(o => (!clientId || o.sourceClientId === clientId)
      && (!status || o.status === status) && (!evidenceStatus || o.evidenceStatus === evidenceStatus)
      && (!search || `${o.billNo} ${o.sourceClientName}`.toLowerCase().includes(search.toLowerCase())));
    const page = Math.max(1, Number(event.query.page) || 1);
    const pageSize = 20;
    return send({ data: filtered.slice((page - 1) * pageSize, page * pageSize),
      pagination: { page, pageSize, total: filtered.length },
      summary: { recorded: filtered.filter(o => o.status === 'RECORDED').length,
        received: filtered.filter(o => o.status === 'RECEIVED').length, handedOver: 0, voided: 0, evidencePending: 0 } });
  }
  if (url.pathname.startsWith('/warehouse/v1/air-pickups/')) {
    const order = orders.find(o => o.id === url.pathname.split('/').at(-1));
    const capturedMode = detailMode;
    if (capturedMode === 'hold') await new Promise(resolve => pending.push(resolve));
    event.respondedAt = new Date().toISOString();
    if (capturedMode === 'fail') return send({ error: { code: 'FIXTURE_DETAIL_UNAVAILABLE', message: '合成目标读取失败，整批未提交' } }, 503);
    if (order) return send({ data: { ...order, forecastCartons: order.forecastCartons + 100,
      version: 2, ...(capturedMode === 'stale' ? { status: 'HANDED_OVER', handoverBatchId: 'fixture-existing-batch' } : {}) } });
  }
  return send({ error: { code: 'FIXTURE_ROUTE_NOT_FOUND', message: url.pathname } }, 404);
}).listen(4820, '127.0.0.1', () => console.log('CONTINUITY_FIXTURE_READY http://127.0.0.1:4820'));
