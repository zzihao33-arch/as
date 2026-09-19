// Local synthetic UI contract checks. All API requests are intercepted; external traffic is blocked.
const { chromium } = require(process.env.CMHUB_PLAYWRIGHT_MODULE || 'C:/Users/ZIHAO ZHANG/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

(async () => {
  const { preview } = await import('vite');
  const server = await preview({ preview: { host: '127.0.0.1', port: 4831, strictPort: true } });
  const browser = await chromium.launch({ executablePath: process.env.CMHUB_BROWSER_PATH || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true });
  const output = path.resolve('.cache/pickup-v1'); fs.mkdirSync(output, { recursive: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    await page.addInitScript(() => {
      const original = window.setTimeout.bind(window);
      window.setTimeout = (callback, delay, ...args) => {
        if (delay > 50000 && delay < 65000) {
          window.fireRenewalReminder = () => callback(...args);
          return original(() => {}, 2147483647);
        }
        return original(callback, delay, ...args);
      };
    });
    const errors = [], requests = [], uploads = new Map();
    page.on('pageerror', e => errors.push(e.message));
    const caps = { view: true, download: true, add: true, manage: true };
    let enabled = true, loseUploadResponse = true, denyNextList = false, changeScopeOnRenewal = false;
    const session = { sessionId: 'v1-ui', userId: 'v1-user', userName: '本地验收', loginName: 'v1-user', platformRole: null, passwordState: 'ACTIVE', warehouseId: null,
      warehouseName: '隔离验收', roleName: '验收', workspaces: [], permissions: ['air_pickups.view','air_pickups.receive','air_pickups.documents.view','air_pickups.documents.download','air_pickups.documents.add','air_pickups.documents.manage'],
      expiresAt: new Date(Date.now() + 31 * 60000).toISOString(), absoluteExpiresAt: '2099-01-01T00:00:00Z' };
    const order = { id: 'v1-order', billNo: 'V1-LOCAL-001', billNoIsStandard: false, sourceClientId: 'v1-client', sourceClientName: '本地合成客户', status: 'RECORDED', evidenceStatus: 'NONE', version: 1,
      forecastCartons: 1, forecastPackages: 1, forecastWeight: 1, forecastWeightUnit: 'KG', exchangeProgress: { total: 0, processed: 0, changed: 0, intercepted: 0, exceptions: 0, pending: 0 },
      createdAt: '2026-09-19T12:00:00Z', updatedAt: '2026-09-19T12:00:00Z', evidence: [], events: [], receiptBatchId: null, handoverBatchId: null };
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
    const assets = [
      { assetId: 'office', filename: 'download-only.docx', contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', preview: { status: 'UNSUPPORTED' } },
      { assetId: 'image', filename: 'receipt.png', contentType: 'image/png', preview: { status: 'READY' } },
    ].map(x => ({ ...x, orderId: order.id, byteSize: png.length, assetStatus: 'READY', assetVersion: 1, uploadedBy: 'test', uploadedAt: order.updatedAt, capabilities: caps }));
    await page.route('**/*', async route => {
      const req = route.request(), url = new URL(req.url());
      if (!url.pathname.startsWith('/warehouse/v1/')) {
        if (url.origin === 'http://127.0.0.1:4831' || url.protocol === 'blob:') return route.continue();
        return route.abort();
      }
      requests.push({ path: url.pathname, method: req.method() });
      const headers = { 'Access-Control-Allow-Origin': 'http://127.0.0.1:4831', 'Access-Control-Allow-Credentials': 'true', 'Cache-Control': 'no-store' };
      const send = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body), headers });
      const data = value => send({ data: value });
      if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { ...headers, 'Access-Control-Allow-Headers': 'Content-Type,X-Upload-Attempt,X-Retry-Of-Attempt', 'Access-Control-Allow-Methods': 'GET,POST,PUT,OPTIONS' } });
      if (url.pathname === '/warehouse/v1/session') return data(session);
      if (url.pathname === '/warehouse/v1/session/renew') {
        session.expiresAt = '2099-01-01T00:00:00Z';
        return data(changeScopeOnRenewal ? { ...session, warehouseId: 'new-workspace', permissions: [...session.permissions, 'scan.use'] } : session);
      }
      if (url.pathname === '/warehouse/v1/workstations') return send({ error: { code: 'WORKSTATION_UNAVAILABLE', message: '合成工作站注册失败' } }, 503);
      if (url.pathname === '/warehouse/v1/air-pickup-clients') return data([{ id: 'v1-client', name: '本地合成客户' }]);
      if (url.pathname === '/warehouse/v1/air-pickup-document-policy') return data({ enabled, policyVersion: 't4-candidate-1', allowedExtensions: ['.pdf','.png','.jpg','.docx','.xlsx'], maxFileBytes: 26214400, maxActiveFiles: 20, maxActiveBytes: 209715200, clientConcurrency: 2, previewTypes: ['application/pdf','image/png','image/jpeg'], capabilities: caps });
      if (url.pathname === '/warehouse/v1/air-pickups') return send({ data: [order], pagination: { total: 1, page: 1, pageSize: 20 }, summary: { recorded: 1, received: 0, handedOver: 0, voided: 0, evidencePending: 0 } });
      if (url.pathname === '/warehouse/v1/air-pickups/v1-order') return data(order);
      if (url.pathname.endsWith('/documents')) {
        if (denyNextList) { denyNextList = false; return send({ error: { code: 'PERMISSION_DENIED', message: '权限已变化' } }, 403); }
        return data({ items: assets, savedCount: assets.length, activeBytes: assets.length * png.length, documentsRevision: assets.length, capabilities: caps, nextCursor: null });
      }
      if (url.pathname.endsWith('/document-uploads') && req.method() === 'POST') {
        const registration = req.postDataJSON();
        uploads.set(registration.uploadId, { ...registration, registration, orderId: order.id, status: 'WAITING_BYTES', attempt: 0, retryable: false, recordRef: null });
        return data(uploads.get(registration.uploadId));
      }
      const uploadId = url.pathname.match(/document-uploads\/([^/]+)/)?.[1];
      if (uploadId) {
        const upload = uploads.get(uploadId); assert.ok(upload);
        if (req.method() === 'PUT') {
          upload.status = 'COMPLETED'; upload.attempt = 1; upload.assetStatus = 'READY'; upload.recordRef = { id: uploadId };
          assets.push({ ...assets[1], assetId: uploadId, filename: upload.filename });
          if (loseUploadResponse) { loseUploadResponse = false; return route.abort('connectionfailed'); }
        }
        return data(upload);
      }
      if (url.pathname.endsWith('/content')) return route.fulfill({ status: 200, contentType: url.pathname.includes('/image/') ? 'image/png' : 'application/octet-stream', body: png, headers });
      return send({ error: { code: 'FIXTURE_ROUTE_NOT_FOUND', message: url.pathname } }, 404);
    });
    await page.goto('http://127.0.0.1:4831/air-pickups');
    await page.getByRole('button', { name: '确认入库', exact: true }).first().click();
    const cartons = page.getByRole('spinbutton', { name: `${order.billNo} 实际箱数`, exact: true });
    await cartons.fill('17');
    await page.evaluate(() => window.fireRenewalReminder());
    await page.getByRole('button', { name: '继续使用', exact: true }).click();
    await page.getByText('登录即将过期', { exact: true }).waitFor({ state: 'hidden' });
    assert.equal(await cartons.count(), 1, 'successful same-account renewal must retain the open receipt form');
    assert.equal(await cartons.inputValue(), '17');
    await page.locator('.cmhub-air-receipt-modal .arco-modal-close-icon').click();
    await page.getByRole('button', { name: order.billNo, exact: true }).click();
    await page.getByRole('button', { name: '提货凭证', exact: true }).click();
    const officeRow = page.locator('li').filter({ hasText: 'download-only.docx' });
    await officeRow.waitFor();
    assert.equal(await officeRow.getByRole('button', { name: '查看', exact: true }).count(), 0, 'Office must not offer a preview action');
    assert.match(await officeRow.innerText(), /下载原件/);
    assert.doesNotMatch(await officeRow.innerText(), /生成中/);
    const imageRow = page.locator('li').filter({ hasText: 'receipt.png' });
    await imageRow.getByRole('button', { name: '查看', exact: true }).click();
    await page.locator('.cmhub-document-preview-modal img').waitFor();
    await page.locator('.cmhub-document-preview-modal .arco-modal-close-icon').click();
    await page.locator('.cmhub-pickup-file-selection input[type=file]').setInputFiles({ name: 'new.png', mimeType: 'image/png', buffer: png });
    await page.getByRole('button', { name: '上传 1 份文件', exact: true }).click();
    await page.getByText('上传结果暂未确认，请核对原文件，勿重复新增', { exact: true }).waitFor();
    await page.getByRole('button', { name: '核对原文件', exact: true }).click();
    await page.getByText('原件已保存', { exact: true }).last().waitFor();
    assert.equal(requests.filter(r => r.method === 'PUT').length, 1, 'result lookup must not re-upload');
    await page.screenshot({ path: path.join(output, 'documents-desktop.png'), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: path.join(output, 'documents-mobile.png'), fullPage: true });
    await page.setViewportSize({ width: 1440, height: 1000 });
    caps.add = false; caps.manage = false;
    session.permissions = session.permissions.filter(p => !p.endsWith('.add') && !p.endsWith('.manage'));
    const sessionsBefore = requests.filter(r => r.path === '/warehouse/v1/session').length;
    denyNextList = true;
    await page.locator('.cmhub-pickup-documents header').getByRole('button', { name: '刷新', exact: true }).click();
    await page.getByRole('button', { name: order.billNo, exact: true }).click();
    await page.getByRole('button', { name: '提货凭证', exact: true }).click();
    await page.locator('li').filter({ hasText: 'download-only.docx' }).waitFor();
    assert.equal(await page.getByRole('button', { name: '选择提货凭证', exact: true }).count(), 0, 'permission recovery must remove upload controls');
    assert.equal(await page.getByRole('button', { name: '替换', exact: true }).count(), 0);
    assert.equal(requests.filter(r => r.path === '/warehouse/v1/session').length, sessionsBefore + 1, 'single recovery for permission failure');
    enabled = false;
    await page.reload();
    await page.getByRole('button', { name: order.billNo, exact: true }).click();
    assert.equal(await page.getByRole('button', { name: '提货凭证', exact: true }).count(), 0);
    changeScopeOnRenewal = true; session.expiresAt = new Date(Date.now() + 31 * 60000).toISOString();
    await page.reload();
    await page.getByRole('button', { name: order.billNo, exact: true }).waitFor();
    await page.evaluate(() => window.fireRenewalReminder());
    await page.getByRole('button', { name: '继续使用', exact: true }).click();
    await page.getByRole('button', { name: '重新连接', exact: true }).waitFor({ timeout: 5000 });
    assert.deepEqual(errors, []);
    fs.writeFileSync(path.join(output, 'browser-result.json'), JSON.stringify({ passed: true, errors, requests }, null, 2));
    console.log('PASS: Office download-only, image preview, lost upload response lookup, permission recovery, feature disabled, desktop/mobile');
  } finally { await browser.close(); await new Promise(resolve => server.httpServer.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
