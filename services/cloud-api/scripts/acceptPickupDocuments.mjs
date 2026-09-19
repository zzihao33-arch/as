import assert from 'node:assert/strict';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

// Test-only HTTP acceptance. Credentials remain in process memory and are never written to the report.
const origin = 'https://test.cmhubtool.com';
const base = 'https://api-test.cmhubtool.com/warehouse/v1';
const orderId = process.env.CMHUB_TEST_ORDER_ID || '4b0389a6-f63b-44d3-a6c1-d68a8cdbd617';
const billNo = process.env.CMHUB_TEST_BILL_NO || 'E2E260919001';
assert.match(orderId, /^[0-9a-f-]{36}$/); assert.match(billNo, /^E2E[A-Z0-9]+$/);
const runId = `pickup-${Date.now()}`;
const report = { runId, startedAt: new Date().toISOString(), orderId, checks: [], assets: [], uploads: [], cleanup: [] };
const output = resolve(process.env.CMHUB_ACCEPT_OUTPUT || 'node_modules/.cache/pickup-http-acceptance.json');
const credentials = { loginName: process.env.CMHUB_TEST_LOGIN, password: process.env.CMHUB_TEST_PASSWORD };
assert.ok(credentials.loginName && credentials.password, 'Provide test credentials through environment variables');
let admin = {}, employee = {}, roleId, accountId;
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
async function call(client, path, { method = 'GET', data, bytes, headers = {} } = {}) {
  const start = performance.now();
  const r = await fetch(base + path, { method, redirect: 'error', signal: AbortSignal.timeout(90000),
    headers: { Origin: origin, ...(client.cookie ? { Cookie: client.cookie } : {}),
      ...(data ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: bytes ?? (data ? JSON.stringify(data) : undefined) });
  const cookie = r.headers.getSetCookie().map(x => x.split(';')[0]).join('; ');
  if (cookie) client.cookie = cookie;
  const content = Buffer.from(await r.arrayBuffer());
  const body = r.headers.get('content-type')?.includes('application/json') && content.length ? JSON.parse(content) : null;
  const result = { status: r.status, data: body?.data, error: body?.error, content, headers: r.headers };
  report.checks.push({ method, path, status: r.status, code: body?.error?.code, requestId: body?.requestId ?? body?.error?.requestId,
    elapsedMs: Math.round(performance.now() - start) });
  console.log(JSON.stringify(report.checks.at(-1)));
  return result;
}
async function ok(client, path, options) {
  const r = await call(client, path, options);
  assert.ok(r.status >= 200 && r.status < 300, `${path}: ${r.status} ${r.error?.code || ''}`);
  return r;
}
function pdf(comment, active = false) {
  const objects = [`<< /Type /Catalog /Pages 2 0 R ${active ? '/OpenAction << /S /JavaScript /JS (app.alert(1)) >>' : ''} >>`,'<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Contents 4 0 R >>','<< /Length 0 >>\nstream\n\nendstream'];
  let text = `%PDF-1.7\n% ${comment}\n`; const offsets = [];
  for (const [i, object] of objects.entries()) { offsets.push(Buffer.byteLength(text)); text += `${i + 1} 0 obj\n${object}\nendobj\n`; }
  const xref = Buffer.byteLength(text);
  return Buffer.from(text + `xref\n0 5\n0000000000 65535 f \n${offsets.map(x => `${String(x).padStart(10,'0')} 00000 n \n`).join('')}trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
}
let policy;
async function upload(client, name, bytes, mime, accepted, preview = true) {
  const uploadId = randomUUID(); report.uploads.push(uploadId);
  const meta = { uploadId, filename: name, byteSize: bytes.length, sha256: digest(bytes), declaredContentType: mime, policyVersion: policy.policyVersion };
  const registered = await call(client, `/air-pickups/${orderId}/document-uploads`, { method: 'POST', data: meta });
  if (registered.status >= 400) { assert.equal(accepted, false); assert.ok([400,415,422].includes(registered.status)); return; }
  const r = await call(client, `/air-pickups/${orderId}/document-uploads/${uploadId}/content`, { method: 'PUT', bytes,
    headers: { 'Content-Type': 'application/octet-stream', 'X-Upload-Attempt': '1' } });
  if (accepted === 'unavailable') {
    assert.equal(r.status,503); assert.equal(r.error?.code,'DOCUMENT_CHECK_UNAVAILABLE');
    const state=await ok(client, `/air-pickups/${orderId}/document-uploads/${uploadId}`);
    assert.equal(state.data.status,'FAILED_NOT_SAVED'); return;
  }
  if (!accepted) {
    assert.ok([400,415,422].includes(r.status), `Expected content rejection, got ${r.status} ${r.error?.code}`);
    const state = await ok(client, `/air-pickups/${orderId}/document-uploads/${uploadId}`);
    assert.equal(state.data.status, 'FAILED_NOT_SAVED'); return;
  }
  assert.equal(r.data?.status, 'COMPLETED', `Upload failed: ${r.status} ${r.error?.code}`);
  const assetId = r.data.recordRef.id; report.assets.push(assetId);
  const replay = await ok(client, `/air-pickups/${orderId}/document-uploads/${uploadId}/content`, { method: 'PUT', bytes,
    headers: { 'Content-Type': 'application/octet-stream', 'X-Upload-Attempt': '1' } });
  assert.equal(replay.data.recordRef.id, assetId);
  for (const [variant, disposition] of (preview ? [['original','attachment'],['preview','inline']] : [['original','attachment']])) {
    const downloaded = await ok(client, `/air-pickups/${orderId}/documents/${assetId}/content?variant=${variant}&disposition=${disposition}`);
    assert.equal(digest(downloaded.content), digest(bytes));
    assert.match(downloaded.headers.get('cache-control'), /private.*no-store/);
    assert.equal(downloaded.headers.get('x-content-type-options'), 'nosniff');
  }
  return assetId;
}
try {
  const session = (await ok(admin, '/sessions', { method: 'POST', data: credentials })).data;
  policy = (await ok(admin, '/air-pickup-document-policy')).data;
  assert.equal(policy.enabled, true);
  const list = await ok(admin, `/air-pickups?search=${encodeURIComponent(billNo)}&page=1&pageSize=20`);
  assert.equal(list.data.length, 1); assert.equal(list.data[0].id, orderId);
  const detail = await ok(admin, `/air-pickups/${orderId}`); assert.equal(detail.data.billNo,billNo);
  const role = (await ok(admin, '/roles', { method:'POST', data:{name:`E2E${Date.now()}`,description:'Disposable pickup document acceptance role'} })).data;
  roleId = role.id;
  const permissions = ['air_pickups.view','air_pickups.documents.view','air_pickups.documents.add','air_pickups.documents.download'];
  await ok(admin, `/roles/${roleId}`, { method:'PATCH', data:{expectedVersion:1,permissions} });
  const account = (await ok(admin, '/accounts', { method:'POST', data:{loginName:runId,displayName:'E2E pickup documents',warehouseId:session.workspaces[0].warehouseId,roleId} })).data;
  accountId = account.id; report.accountId = accountId; report.roleId = roleId;
  await ok(employee, '/sessions', {method:'POST',data:{loginName:runId,password:account.temporaryPassword}});
  const ephemeralPassword = randomBytes(24).toString('base64url');
  await ok(employee, '/session/password', {method:'POST',data:{currentPassword:account.temporaryPassword,newPassword:ephemeralPassword}});
  await ok(employee, '/sessions', {method:'POST',data:{loginName:runId,password:ephemeralPassword}});
  const pdfBytes=pdf(runId);
  await mkdir(resolve(output,'..'), {recursive:true});
  await writeFile(resolve(output,'..','synthetic-pickup.pdf'),pdfBytes);
  const assetId=await upload(employee,'synthetic-pickup.pdf',pdfBytes,'application/pdf',true);
  const fixtures = resolve('node_modules/.cache/pickup-fixtures');
  await upload(employee,'synthetic.png',await readFile(resolve(fixtures,'synthetic.png')),'image/png',true);
  await upload(employee,'synthetic.docx',await readFile(resolve(fixtures,'synthetic.docx')),'application/vnd.openxmlformats-officedocument.wordprocessingml.document',true,false);
  await upload(employee,'synthetic.xlsx',await readFile(resolve(fixtures,'synthetic.xlsx')),'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',true,false);
  await ok(employee, `/air-pickups/${orderId}/documents`);
  await ok(admin, `/roles/${roleId}`, {method:'PATCH',data:{expectedVersion:2,permissions:['air_pickups.view']}});
  for(const path of [`/air-pickups/${orderId}/documents`,`/air-pickups/${orderId}/documents/${assetId}/content?variant=original&disposition=attachment`]) {
    const r=await call(employee,path); assert.equal(r.status,403);
  }
  const denied=await call(employee,`/air-pickups/${orderId}/document-uploads`,{method:'POST',data:{uploadId:randomUUID(),filename:'denied.pdf',byteSize:pdfBytes.length,sha256:digest(pdfBytes),declaredContentType:'application/pdf',policyVersion:policy.policyVersion}});
  assert.equal(denied.status,403);
  await ok(admin, `/roles/${roleId}`, {method:'PATCH',data:{expectedVersion:3,permissions}});
  await ok(employee, `/air-pickups/${orderId}/documents/${assetId}/content?variant=original&disposition=attachment`);
  await upload(employee,'corrupt.pdf',Buffer.from('%PDF-1.7\nbroken\n'),'application/pdf',false);
  await upload(employee,'disguised.pdf',Buffer.from('not a PDF'),'application/pdf',false);
  await upload(employee,'encrypted.pdf',await readFile(resolve(fixtures,'encrypted.pdf')),'application/pdf',false);
  const eicar=Buffer.from('X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*');
  await upload(employee,'eicar.pdf',eicar,'application/pdf',false);
  await upload(employee,'active.pdf',pdf('synthetic active content',true),'application/pdf',false);
  await upload(employee,'legacy.xls',Buffer.from('synthetic legacy Excel test case'),'application/vnd.ms-excel','unavailable');
  await upload(employee,'after-rejection.pdf',pdf('recovery after rejects'),'application/pdf',true);
  const anonymous=await call({},`/air-pickups/${orderId}/documents/${assetId}/content?variant=original&disposition=attachment`);
  assert.equal(anonymous.status,401);
  report.passed=true;
} catch(e) { report.passed=false;report.failure=e.message;console.error(e.message);process.exitCode=1; }
finally {
  // Preserve uploaded files until the browser preview check; remove this run's disposable identity only.
  if(accountId) { try { await ok(admin,`/accounts/${accountId}`,{method:'DELETE'});report.cleanup.push('account deleted'); } catch(e) {report.cleanup.push(`account cleanup failed: ${e.message}`);} }
  if(roleId) { try { await ok(admin,`/roles/${roleId}`,{method:'DELETE'});report.cleanup.push('role deleted'); } catch(e) {report.cleanup.push(`role cleanup failed: ${e.message}`);} }
  if(admin.cookie) { try {await ok(admin,'/session',{method:'DELETE'});} catch {} }
  report.completedAt=new Date().toISOString();await mkdir(resolve(output,'..'),{recursive:true});await writeFile(output,JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify({passed:report.passed,failure:report.failure,output,assets:report.assets,cleanup:report.cleanup}));
}
