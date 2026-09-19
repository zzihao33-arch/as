import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { readFile, readdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { before, after, describe, test } from 'node:test';
import { createPool, type Pool, type PoolConnection } from 'mysql2/promise';
import type { RowDataPacket } from 'mysql2';
import { createPickupDocuments, createDocumentReceiveSlots, receiveDocumentBytes } from '../src/pickupDocuments.js';
import { Readable } from 'node:stream';
import { setImmediate as nextTurn } from 'node:timers/promises';
import express from 'express';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { createPickupDocumentsRouter } from '../src/pickupDocumentsHttp.js';
import { createWarehouseHttpBoundary } from '../src/warehouseHttp.js';
import type { WarehouseIdentity } from '../src/warehouseIdentity.js';
import { createFilesystemLabelStorage } from '../src/labelStorage.js';
import { createAirPickupOperations } from '../src/airPickupOperations.js';
import { hashWarehousePassword } from '../src/warehouseSecurity.js';
import type { WarehouseSession } from '../src/warehouseIdentity.js';
import { DOCUMENT_POLICY } from '../src/pickupDocumentPolicy.js';
import { documentPdf } from './documentFixtures.js';
const port = process.env.CMHUB_T2_MYSQL_PORT;
describe('T4 isolated real MySQL + filesystem original document lifecycle', { skip: !port }, () => {
  const database = `cmhub_t4_test_${randomUUID().replaceAll('-', '')}`;
  let mysql: Pool, admin: Pool, directory: string;
  const userId = randomUUID(), clientId = randomUUID(), sessionId = randomUUID();
  const session = { userId, sessionId, passwordState: 'ACTIVE', warehouseId: null, membershipId: null, roleId: null,
    permissions: ['air_pickups.view', 'air_pickups.documents.view', 'air_pickups.documents.add', 'air_pickups.documents.download', 'air_pickups.documents.manage'] } as WarehouseSession;
  const audit = { requestId: randomUUID(), ip: '127.0.0.1' };
  const storage = () => createFilesystemLabelStorage(directory);
  const service = () => createPickupDocuments({ mysql, storage: storage(), enabled: true, checker: async (_bytes, contentType) => ({ clean: true, validated: true, contentType }) });
  before(async () => {
    admin = createPool({ host: '127.0.0.1', port: Number(port), user: 'root', password: '' });
    await admin.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    mysql = createPool({ host: '127.0.0.1', port: Number(port), user: 'root', password: '', database, connectionLimit: 24, timezone: 'Z' });
    const { executableStatements } = await import(pathToFileURL(resolve('scripts/applyMigrations.mjs')).href);
    for (const name of (await readdir(resolve('../../database'))).filter(name => /^\d{3}_.*\.sql$/.test(name)).sort()) {
      for (const sql of executableStatements(await readFile(resolve('../../database', name), 'utf8'))) await mysql.query(sql);
    }
    await mysql.execute(`INSERT INTO warehouse_users (id,email,display_name,password_hash,login_name,platform_role) VALUES (?, 't4@example.invalid','T4',?,'t4','SYSTEM_ADMIN')`, [userId, await hashWarehousePassword('test-password-123')]);
    await mysql.execute(`INSERT INTO warehouse_sessions (id,session_key_id,token_hash,user_id,warehouse_id,membership_id,expires_at,absolute_expires_at) VALUES (?, 't4sessionkey', ?, ?, NULL,NULL,DATE_ADD(NOW(), INTERVAL 1 HOUR),DATE_ADD(NOW(), INTERVAL 1 HOUR))`, [sessionId, Buffer.alloc(32), userId]);
    await mysql.execute(`INSERT INTO clients (id,client_code,display_name,key_id,api_key_prefix,api_key_hash) VALUES (?, 'T4','T4','t4-key','t4',?)`, [clientId, Buffer.alloc(32)]);
    directory = await mkdtemp(join(tmpdir(), 'cmhub-t4-'));
  });
  after(async () => {
    await mysql?.end();
    if (admin) { assert.match(database, /^cmhub_t4_test_[a-f0-9]{32}$/); await admin.query(`DROP DATABASE IF EXISTS \`${database}\``); await admin.end(); }
    if (directory) await rm(directory, { recursive: true, force: true });
  });
  const pdf = documentPdf;
  const metadata = (bytes: Buffer, extra = {}) => ({ uploadId: randomUUID(), filename: '原件.pdf', byteSize: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'), declaredContentType: 'application/pdf', policyVersion: DOCUMENT_POLICY.policyVersion, ...extra });
  async function order() {
    return (await createAirPickupOperations({ mysql, storage: storage() }).createOrder(session, audit,
      { clientId, billNo: `T4${randomUUID().slice(0, 8)}`, forecastCartons: 1, forecastPackages: 1, forecastWeight: 1, forecastWeightUnit: 'KG' })).id;
  }
  async function upload(orderId: string, bytes: Buffer, extra = {}) {
    const svc = service(), input = metadata(bytes, extra);
    await svc.register(session, orderId, input);
    const claimed = await svc.acquire(session, orderId, input.uploadId, 1);
    assert.ok(claimed.lease);
    return { view: await svc.save(session, claimed.lease, bytes, audit), input };
  }
  test('v1 Office originals download unchanged without creating conversion work', async () => {
    // Synthetic checker verdict isolates persistence and authorization; not Office parsing evidence.
    const orderId = await order(), bytes = Buffer.from('synthetic-office-original');
    const saved = await upload(orderId, bytes, { filename: 'original.docx', declaredContentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
    const svc = service();
    const list = await svc.list(session, orderId, {});
    assert.equal(list.items[0].preview.status, 'UNSUPPORTED');
    const [jobs] = await mysql.query<RowDataPacket[]>("SELECT asset_id FROM air_pickup_document_previews WHERE asset_id=? AND preview_status IN ('QUEUED','RUNNING')", [saved.view.recordRef!.id]);
    assert.equal(jobs.length, 0);
    await assert.rejects(svc.open(session, orderId, saved.view.recordRef!.id, 'preview', 'inline'), { code: 'DOCUMENT_PREVIEW_UNSUPPORTED' });
    await assert.rejects(svc.open(session, orderId, saved.view.recordRef!.id, 'original', 'inline'), { code: 'DOCUMENT_OFFICE_ATTACHMENT_ONLY' });
    const opened = await svc.open(session, orderId, saved.view.recordRef!.id, 'original', 'attachment');
    const chunks: Buffer[] = []; for await (const chunk of opened.object.stream) chunks.push(Buffer.from(chunk));
    assert.deepEqual(Buffer.concat(chunks), bytes);
    await assert.rejects(svc.open({ ...session, permissions: ['air_pickups.view', 'air_pickups.documents.view'] }, orderId, saved.view.recordRef!.id, 'original', 'attachment'), { code: 'PERMISSION_DENIED' });
  });
  test('registration waits for bytes; one same-attempt owner; immutable bytes and same-hash dedup', async () => {
    const orderId = await order(), svc = service(), bytes = pdf();
    const input = metadata(bytes);
    assert.equal((await svc.register(session, orderId, input)).status, 'WAITING_BYTES');
    const owners = await Promise.all([svc.acquire(session, orderId, input.uploadId, 1), svc.acquire(session, orderId, input.uploadId, 1)]);
    assert.equal(owners.filter(result => result.lease).length, 1);
    const saved = await svc.save(session, owners.find(result => result.lease)!.lease!, bytes, audit);
    assert.equal(saved.status, 'COMPLETED');
    const duplicate = await upload(orderId, bytes);
    assert.equal(duplicate.view.recordRef?.id, saved.recordRef?.id);
    assert.equal(duplicate.view.deduplicated, true);
    const list = await svc.list(session, orderId, {});
    assert.equal(list.savedCount, 1); assert.equal(list.activeBytes, bytes.length);
    const opened = await svc.open(session, orderId, saved.recordRef!.id, 'original', 'attachment');
    const chunks: Buffer[] = []; for await (const chunk of opened.object.stream) chunks.push(Buffer.from(chunk));
    assert.deepEqual(Buffer.concat(chunks), bytes);
    assert.equal(JSON.stringify(list).includes('storage_key'), false);
    await assert.rejects(svc.register(session, orderId, { ...input, filename: 'other.pdf' }), { code: 'DOCUMENT_UPLOAD_ID_CONFLICT' });
    await assert.rejects(svc.get({ ...session, userId: randomUUID() }, orderId, input.uploadId));
  });
  test('remove retains history; old completed upload cannot revive; replacement is atomic', async () => {
    const orderId = await order(), svc = service();
    const first = await upload(orderId, pdf('old'));
    await assert.rejects(upload(orderId, pdf('bad'), { supersedesAssetId: first.view.recordRef!.id, expectedAssetVersion: 2, reason: '更正', password: 'test-password-123' }), { code: 'DOCUMENT_ASSET_VERSION_CONFLICT' });
    const second = await upload(orderId, pdf('new'), { supersedesAssetId: first.view.recordRef!.id, expectedAssetVersion: 1, reason: '更正', password: 'test-password-123' });
    assert.equal((await svc.list(session, orderId, {})).savedCount, 1);
    assert.equal((await svc.list(session, orderId, { includeHistory: true })).items.length, 2);
    await assert.rejects(svc.acquire(session, orderId, first.input.uploadId, 1), { code: 'DOCUMENT_UPLOAD_ASSET_INACTIVE' });
    await svc.remove(session, orderId, second.view.recordRef!.id, { operationId: randomUUID(), expectedAssetVersion: 1, reason: '作废原件', password: 'test-password-123' }, audit);
    assert.equal((await svc.list(session, orderId, {})).savedCount, 0);
    const [rows] = await mysql.execute<RowDataPacket[]>('SELECT order_status,version FROM air_pickup_orders WHERE id=?', [orderId]);
    assert.equal(rows[0].order_status, 'RECORDED'); assert.equal(rows[0].version, 1);
  });
  test('lease recovery fences a late writer and revoked session cannot finalize', async () => {
    const orderId = await order(), svc = service(), bytes = pdf('late'), input = metadata(bytes);
    await svc.register(session, orderId, input);
    const first = await svc.acquire(session, orderId, input.uploadId, 1);
    assert.equal(await svc.reconcile(input.uploadId, 1), 'BUSY');
    await mysql.execute('UPDATE warehouse_ui_operations SET document_lease_expires_at=DATE_SUB(UTC_TIMESTAMP(),INTERVAL 1 MINUTE) WHERE operation_id=?', [input.uploadId]);
    assert.equal(await svc.reconcile(input.uploadId, 1), 'FAILED_NOT_SAVED');
    const retry = await svc.acquire(session, orderId, input.uploadId, 2, 1);
    await assert.rejects(svc.save(session, first.lease!, bytes, audit), { code: 'DOCUMENT_ATTEMPT_STALE' });
    await svc.save(session, retry.lease!, bytes, audit);
    assert.equal((await svc.list(session, orderId, {})).savedCount, 1);
  });
  test('20-file last-slot contention, dedup at full quota, equal replacement and duplicate replacement', async () => {
    const orderId = await order(), svc = service();
    const originals = [];
    for (let i = 0; i < 19; i++) originals.push(await upload(orderId, pdf(`count-${i}`)));
    const last = await Promise.allSettled([upload(orderId, pdf('last-a')), upload(orderId, pdf('last-b'))]);
    assert.equal(last.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal((await svc.list(session, orderId, {})).savedCount, 20);
    const dup = await upload(orderId, pdf('count-0'));
    assert.equal(dup.view.deduplicated, true);
    await assert.rejects(upload(orderId, pdf('21st')), { code: 'DOCUMENT_QUOTA_EXCEEDED' });
    await assert.rejects(upload(orderId, pdf('count-1'), { supersedesAssetId: originals[0].view.recordRef!.id, expectedAssetVersion: 1, reason: '更正', password: 'test-password-123' }), { code: 'DOCUMENT_REPLACEMENT_DUPLICATE' });
    await upload(orderId, pdf('changed'), { supersedesAssetId: originals[0].view.recordRef!.id, expectedAssetVersion: 1, reason: '更正', password: 'test-password-123' });
    assert.equal((await svc.list(session, orderId, {})).savedCount, 20);
    const [indexes] = await mysql.query<RowDataPacket[]>('SHOW INDEX FROM air_pickup_document_assets_v2');
    assert.ok(indexes.some(row => row.Key_name === 'uq_document_active_hash' && Number(row.Non_unique) === 0));
    assert.ok(indexes.some(row => row.Key_name === 'uq_document_creation_upload' && Number(row.Non_unique) === 0));
    const [grants] = await mysql.query<RowDataPacket[]>("SELECT * FROM warehouse_role_permissions WHERE permission_code LIKE 'air_pickups.documents.%'");
    assert.equal(grants.length, 0, 'migration defines permissions without granting existing roles');
  });
  test('actual 25MiB originals fill exact200MiB; equal-size replacement succeeds; plus one total byte fails', async () => {
    const orderId = await order(), svc = service();
    let first: Awaited<ReturnType<typeof upload>> | undefined;
    for (let i = 0; i < 8; i++) { const saved = await upload(orderId, pdf(`large-${i}`, DOCUMENT_POLICY.maxFileBytes)); if (i === 0) first = saved; }
    assert.equal((await svc.list(session, orderId, {})).activeBytes, 209715200);
    await upload(orderId, pdf('large-replacement', DOCUMENT_POLICY.maxFileBytes), { supersedesAssetId: first!.view.recordRef!.id, expectedAssetVersion: 1, reason: '等额替换', password: 'test-password-123' });
    assert.equal((await svc.list(session, orderId, {})).activeBytes, 209715200);
    const dedup = await upload(orderId, pdf('large-1', DOCUMENT_POLICY.maxFileBytes)); assert.equal(dedup.view.deduplicated, true);
    const newest = (await svc.list(session, orderId, {})).items.find(item => item.assetId !== dedup.view.recordRef!.id)!;
    const reduced = await upload(orderId, pdf('reduce', DOCUMENT_POLICY.maxFileBytes - 600), { supersedesAssetId: newest.assetId, expectedAssetVersion: 1, reason: '缩小', password: 'test-password-123' });
    assert.equal(reduced.view.status, 'COMPLETED');
    await assert.rejects(upload(orderId, pdf('one-byte-over', 601)), { code: 'DOCUMENT_QUOTA_EXCEEDED' });
    await upload(orderId, pdf('exact-byte-limit', 600));
    assert.equal((await svc.list(session, orderId, {})).activeBytes, 209715200);
  });
  test('commit acknowledgement lost after DB commit resolves one original and never removes its object', async () => {
    const orderId = await order(), svc = service(), bytes = pdf('commit-loss'), input = metadata(bytes);
    await svc.register(session, orderId, input); const claim = await svc.acquire(session, orderId, input.uploadId, 1);
    const transport = Object.create(mysql) as Pool;
    transport.getConnection = async () => { const real = await mysql.getConnection(); const wrapped = Object.create(real) as PoolConnection;
      wrapped.commit = async () => { await real.commit(); throw new Error('lost commit acknowledgement'); };
      wrapped.release = () => real.release(); wrapped.destroy = () => real.destroy(); return wrapped; };
    const fault = createPickupDocuments({ mysql: transport, storage: storage(), enabled: true, checker: async (_b, contentType) => ({ clean: true, validated: true, contentType }) });
    const result = await fault.save(session, claim.lease!, bytes, audit);
    assert.equal(result.status, 'COMPLETED');
    assert.equal((await svc.list(session, orderId, {})).savedCount, 1);
    const [orphans] = await mysql.execute<RowDataPacket[]>('SELECT * FROM air_pickup_document_orphan_candidates WHERE upload_id=?', [input.uploadId]);
    assert.equal(orphans.length, 1);
    const original = await svc.open(session, orderId, result.recordRef!.id, 'original', 'attachment'); original.object.stream.destroy();
  });
  test('write publishes then provider throws; independent object verification salvages original', async () => {
    const orderId = await order(), svc = service(), bytes = pdf('provider-loss'), input = metadata(bytes), real = storage();
    await svc.register(session, orderId, input); const claim = await svc.acquire(session, orderId, input.uploadId, 1);
    const fault = createPickupDocuments({ mysql, enabled: true, checker: async (_b, contentType) => ({ clean: true, validated: true, contentType }),
      storage: { ...real, put: async (key, content) => { await real.put(key, content); throw new Error('published but response lost'); } } });
    assert.equal((await fault.save(session, claim.lease!, bytes, audit)).status, 'COMPLETED');
    const [rows] = await mysql.execute<RowDataPacket[]>('SELECT storage_key FROM air_pickup_document_assets_v2 WHERE creation_upload_id=?', [input.uploadId]);
    await real.remove!(rows[0].storage_key);
    await assert.rejects(svc.open(session, orderId, (await svc.get(session, orderId, input.uploadId)).recordRef!.id, 'original', 'attachment'), { code: 'DOCUMENT_STORAGE_UNAVAILABLE' });
    await assert.rejects(svc.acquire(session, orderId, input.uploadId, 1), { code: 'DOCUMENT_STORAGE_UNAVAILABLE' });
    assert.equal((await svc.list(session, orderId, {})).savedCount, 1, 'storage loss does not erase READY database fact');
  });
  test('revoke after byte validation prevents final publication; voided rejects adding; failures preserve order', async () => {
    const orderId = await order(), svc = service(), bytes = pdf('revoke'), input = metadata(bytes);
    await svc.register(session, orderId, input); const claim = await svc.acquire(session, orderId, input.uploadId, 1);
    const fault = createPickupDocuments({ mysql, storage: storage(), enabled: true, checker: async (_bytes, contentType) => {
      await mysql.execute('UPDATE warehouse_sessions SET revoked_at=NOW(3) WHERE id=?', [sessionId]); return { clean: true, validated: true, contentType }; } });
    try { await assert.rejects(fault.save(session, claim.lease!, bytes, audit), { code: 'SESSION_INVALID' }); }
    finally { await mysql.execute('UPDATE warehouse_sessions SET revoked_at=NULL WHERE id=?', [sessionId]); }
    assert.equal((await svc.list(session, orderId, {})).savedCount, 0);
    assert.equal((await svc.get(session, orderId, input.uploadId)).status, 'FAILED_NOT_SAVED');
    await mysql.execute("UPDATE air_pickup_orders SET order_status='VOIDED' WHERE id=?", [orderId]);
    await assert.rejects(svc.register(session, orderId, metadata(pdf('void'))), { code: 'DOCUMENT_ORDER_VOIDED' });
  });
  test('four concurrent25MiB receivers retain hard slot bound and MySQL stays responsive', async t => {
    const baseline = process.memoryUsage().rss; let peak = baseline, reads = 0, maxReadMs = 0;
    const slots = createDocumentReceiveSlots(4), chunk = Buffer.alloc(65536, 32);
    const releases = Array.from({ length: 4 }, () => slots.acquire());
    assert.throws(() => slots.acquire(), { code: 'DOCUMENT_RECEIVE_BUSY' });
    let done = false;
    const probe = (async () => { while (!done) { const start = performance.now(); await mysql.query('SELECT 1'); reads++; maxReadMs = Math.max(maxReadMs, performance.now() - start); peak = Math.max(peak, process.memoryUsage().rss); await nextTurn(); } })();
    const results = await Promise.all(releases.map(async (release, index) => {
      try { const buffer = await receiveDocumentBytes(Readable.from((async function* () { for (let i = 0; i < 400; i++) { yield chunk; await nextTurn(); } })()), 26214400);
        const key = `capacity/${randomUUID()}/${index}`; await storage().put(key, buffer); await storage().put(key, buffer); return buffer; }
      finally { release(); }
    }));
    peak = Math.max(peak, process.memoryUsage().rss); done = true; await probe;
    assert.ok(results.every(buffer => buffer.length === 26214400)); assert.ok(reads > 0);
    await assert.rejects(receiveDocumentBytes(Readable.from([Buffer.alloc(26214401)]), 26214400), { code: 'DOCUMENT_TOO_LARGE' });
    t.diagnostic(JSON.stringify({ adapter: 'filesystem: first publication then existing-content verification (readFile copies)', concurrentReceivers: 4, bytesEach: 26214400, baselineRssBytes: baseline, peakRssBytes: peak, deltaRssBytes: peak - baseline, mysqlReads: reads, maxMysqlReadMs: Math.round(maxReadMs), productionCapacityValidated: false }));
  });
  test('HTTP raw upload preserves bytes, no-store/nosniff, range full200, origin and permission checks', async () => {
    const orderId = await order(), svc = service(), bytes = pdf('http'); let currentSession = session;
    const boundary = createWarehouseHttpBoundary({ identity: { authenticate: async () => currentSession } as unknown as WarehouseIdentity, cookieName: 'session', allowedOrigins: new Set(['https://workspace.example']) });
    const app = express();
    app.use((req, _res, next) => { req.requestId = 't4-http'; next(); });
    app.use((req, res, next) => req.method === 'PUT' ? next() : express.json()(req, res, next));
    app.use('/warehouse/v1', boundary.origin, createPickupDocumentsRouter({ documents: svc, authenticate: boundary.session }));
    const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/warehouse/v1`, headers = { origin: 'https://workspace.example', 'content-type': 'application/json' };
    try {
      const input = metadata(bytes), path = `${base}/air-pickups/${orderId}/document-uploads`;
      const registration = await fetch(path, { method: 'POST', headers, body: JSON.stringify(input) }); assert.equal(registration.status, 201);
      assert.equal((await registration.json()).data.status, 'WAITING_BYTES');
      const put = await fetch(`${path}/${input.uploadId}/content`, { method: 'PUT', headers: { ...headers, 'content-type': 'application/octet-stream', 'x-upload-attempt': '1' }, body: Uint8Array.from(bytes) });
      assert.equal(put.status, 201); const saved = (await put.json()).data;
      const contentPath = `${base}/air-pickups/${orderId}/documents/${saved.recordRef.id}/content`;
      const content = await fetch(`${contentPath}?variant=original&disposition=attachment`, { headers: { ...headers, Range: 'bytes=0-9' } });
      assert.equal(content.status, 200); assert.equal(content.headers.get('accept-ranges'), null);
      assert.equal(content.headers.get('cache-control'), 'private, no-store'); assert.equal(content.headers.get('x-content-type-options'), 'nosniff');
      assert.ok(content.headers.get('content-disposition')?.includes("filename*=UTF-8''")); assert.deepEqual(Buffer.from(await content.arrayBuffer()), bytes);
      currentSession = { ...session, permissions: ['air_pickups.view', 'air_pickups.documents.view'] };
      assert.equal((await fetch(`${contentPath}?variant=preview&disposition=inline`, { headers })).status, 200);
      assert.equal((await fetch(`${contentPath}?variant=original&disposition=attachment`, { headers })).status, 403);
      assert.equal((await fetch(`${base}/air-pickups/${orderId}/documents?includeHistory=true`, { headers })).status, 403);
      assert.equal((await fetch(`${path}/${input.uploadId}/content`, { method: 'PUT', headers: { ...headers, 'content-type': 'application/octet-stream', 'x-upload-attempt': '1' }, body: Uint8Array.from(bytes) })).status, 403);
      assert.equal((await fetch(contentPath, { headers: { origin: 'https://untrusted.example' } })).status, 403);
    } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  });
  test('hung checker/storage calls time out, release caller and stop new allocations until process recovery', async () => {
    for (const dependency of ['checker', 'storage'] as const) {
      const orderId = await order(), svc = service(), bytes = pdf(`hang-${dependency}`), input = metadata(bytes);
      await svc.register(session, orderId, input); const claim = await svc.acquire(session, orderId, input.uploadId, 1);
      const fault = createPickupDocuments({ mysql, storage: dependency === 'storage' ? { ...storage(), put: async () => new Promise<void>(() => {}) } : storage(), enabled: true, externalTimeoutMs: 20,
        checker: dependency === 'checker' ? async () => new Promise(() => {}) : async (_bytes, contentType) => ({ clean: true, validated: true, contentType }) });
      await assert.rejects(fault.save(session, claim.lease!, bytes, audit), { code: dependency === 'checker' ? 'DOCUMENT_CHECK_UNAVAILABLE' : 'DOCUMENT_STORAGE_UNAVAILABLE' });
      const result = await svc.get(session, orderId, input.uploadId); assert.equal(result.status, 'FAILED_NOT_SAVED');
      assert.equal((await svc.list(session, orderId, {})).savedCount, 0);
      const another = metadata(pdf('later')); await svc.register(session, orderId, another);
      await assert.rejects(fault.acquire(session, orderId, another.uploadId, 1), { code: 'DOCUMENT_DEPENDENCY_UNAVAILABLE' });
    }
  });
  test('non-admin role revocation is checked at final transaction and reflected in list capabilities', async () => {
    const staffId = randomUUID(), staffSessionId = randomUUID(), warehouseId = randomUUID(), membershipId = randomUUID(), roleId = randomUUID(), orderId = await order();
    await mysql.execute("INSERT INTO warehouse_users (id,email,display_name,password_hash,login_name) VALUES (?,'t4staff@example.invalid','T4 staff','fixture','t4-staff')", [staffId]);
    await mysql.execute("INSERT INTO warehouses (id,warehouse_code,display_name) VALUES (?,'T4','T4')", [warehouseId]);
    await mysql.execute("INSERT INTO warehouse_roles (id,role_code,role_name,role_kind) VALUES (?,'T4','T4','CUSTOM')", [roleId]);
    await mysql.execute('INSERT INTO warehouse_memberships (id,warehouse_id,user_id,role_id) VALUES (?,?,?,?)', [membershipId, warehouseId, staffId, roleId]);
    for (const permission of session.permissions) await mysql.execute('INSERT INTO warehouse_role_permissions (role_id,permission_code) VALUES (?,?)', [roleId, permission]);
    await mysql.execute(`INSERT INTO warehouse_sessions (id,session_key_id,token_hash,user_id,warehouse_id,membership_id,expires_at,absolute_expires_at) VALUES (?,'t4staffkey',?,?,?,?,DATE_ADD(NOW(),INTERVAL 1 HOUR),DATE_ADD(NOW(),INTERVAL 1 HOUR))`, [staffSessionId, Buffer.alloc(32), staffId, warehouseId, membershipId]);
    const staff = { ...session, userId: staffId, sessionId: staffSessionId, warehouseId, membershipId, roleId }, svc = service(), bytes = pdf('staff'), input = metadata(bytes);
    await svc.register(staff, orderId, input); const claim = await svc.acquire(staff, orderId, input.uploadId, 1);
    await mysql.execute("DELETE FROM warehouse_role_permissions WHERE role_id=? AND permission_code IN ('air_pickups.documents.add','air_pickups.documents.manage')", [roleId]);
    await assert.rejects(svc.save(staff, claim.lease!, bytes, audit), { code: 'PERMISSION_DENIED' });
    const list = await svc.list(staff, orderId, {}); assert.equal(list.savedCount, 0); assert.equal(list.capabilities.add, false); assert.equal(list.capabilities.manage, false);
  });
  test('upload IDs cannot alias own or foreign completed remove/create operations', async () => {
    const orderId = await order(), svc = service(), saved = await upload(orderId, pdf('collision-source'));
    const removeId = randomUUID();
    await svc.remove(session, orderId, saved.view.recordRef!.id, { operationId: removeId, expectedAssetVersion: 1, reason: 'collision-test', password: 'test-password-123' }, audit);
    await assert.rejects(svc.register(session, orderId, metadata(pdf('collision'), { uploadId: removeId })), { code: 'DOCUMENT_UPLOAD_ID_CONFLICT' });
    await mysql.execute('UPDATE warehouse_ui_operations SET actor_reference=? WHERE operation_id=?', ['user:other-account', removeId]);
    await assert.rejects(svc.register(session, orderId, metadata(pdf('foreign-remove'), { uploadId: removeId })), { code: 'DOCUMENT_UPLOAD_NOT_FOUND' });
    const createId = randomUUID();
    await mysql.execute(`INSERT INTO warehouse_ui_operations (operation_id,actor_reference,actor_context,scope_key,operation_type,contract_version,canonicalization_version,request_sha256,status,record_type,record_id,completed_at) VALUES (?,?,'{}','GLOBAL','AIR_PICKUP_CREATE',2,1,?,'COMPLETED','AIR_PICKUP_ORDER',?,NOW(3))`, [createId, 'user:other-account', 'a'.repeat(64), orderId]);
    await assert.rejects(svc.register(session, orderId, metadata(pdf('foreign'), { uploadId: createId })), { code: 'DOCUMENT_UPLOAD_NOT_FOUND' });
    await mysql.execute('UPDATE warehouse_ui_operations SET actor_reference=? WHERE operation_id=?', [`user:${session.userId}`, createId]);
    await assert.rejects(svc.register(session, orderId, metadata(pdf('own-create'), { uploadId: createId })), { code: 'DOCUMENT_UPLOAD_ID_CONFLICT' });
    const late = metadata(pdf('late-collision')); await svc.register(session, orderId, late);
    await mysql.execute(`INSERT INTO warehouse_ui_operations (operation_id,actor_reference,actor_context,scope_key,operation_type,contract_version,canonicalization_version,request_sha256,status,record_type,record_id,completed_at) VALUES (?,?,'{}','GLOBAL','PICKUP_DOCUMENT_REMOVE',2,1,?,'COMPLETED','PICKUP_DOCUMENT_ASSET',?,NOW(3))`, [late.uploadId, 'user:other-account', 'b'.repeat(64), saved.view.recordRef!.id]);
    await assert.rejects(svc.get(session, orderId, late.uploadId), { code: 'DOCUMENT_UPLOAD_NOT_FOUND' });
    await assert.rejects(svc.acquire(session, orderId, late.uploadId, 1), { code: 'DOCUMENT_UPLOAD_NOT_FOUND' });
  });
  test('bounded sweep recovers expired byte owners without GET side effects and fences old writer', async () => {
    const orderId = await order(), svc = service(), bytes = pdf('sweep'), input = metadata(bytes);
    await svc.register(session, orderId, input); const claim = await svc.acquire(session, orderId, input.uploadId, 1);
    await mysql.execute('UPDATE warehouse_ui_operations SET document_lease_expires_at=DATE_SUB(UTC_TIMESTAMP(),INTERVAL 1 MINUTE) WHERE operation_id=?', [input.uploadId]);
    assert.equal((await svc.get(session, orderId, input.uploadId)).status, 'PROCESSING');
    await svc.reconcileExpired(25);
    assert.equal((await svc.get(session, orderId, input.uploadId)).status, 'FAILED_NOT_SAVED');
    await assert.rejects(svc.save(session, claim.lease!, bytes, audit), { code: 'DOCUMENT_ATTEMPT_STALE' });
  });
  test('unknown commit plus unavailable primary reads never becomes a false retryable failure', async () => {
    const orderId = await order(), svc = service(), bytes = pdf('unavailable-after-commit'), input = metadata(bytes);
    await svc.register(session, orderId, input); const claim = await svc.acquire(session, orderId, input.uploadId, 1);
    let unavailable = false; const transport = Object.create(mysql) as Pool;
    transport.getConnection = async () => { const real = await mysql.getConnection(), wrapper = Object.create(real) as PoolConnection;
      wrapper.commit = async () => { await real.commit(); unavailable = true; throw new Error('commit response lost'); };
      wrapper.release = () => real.release(); wrapper.destroy = () => real.destroy(); return wrapper; };
    transport.execute = ((...args: Parameters<Pool['execute']>) => unavailable ? Promise.reject(new Error('primary unavailable')) : mysql.execute(...args)) as Pool['execute'];
    const fault = createPickupDocuments({ mysql: transport, storage: storage(), enabled: true, checker: async (_bytes, contentType) => ({ clean: true, validated: true, contentType }) });
    await assert.rejects(fault.save(session, claim.lease!, bytes, audit), { code: 'OPERATION_RESULT_UNKNOWN' });
    assert.equal((await svc.get(session, orderId, input.uploadId)).status, 'COMPLETED');
    assert.equal((await svc.list(session, orderId, {})).savedCount, 1);
  });
  test('replacement cannot obtain a receiving lease after manage permission is removed', async () => {
    const orderId = await order(), svc = service(), original = await upload(orderId, pdf('before-replacement'));
    const input = metadata(pdf('replacement'), { supersedesAssetId: original.view.recordRef!.id, expectedAssetVersion: 1, reason: '更正', password: 'test-password-123' });
    await svc.register(session, orderId, input);
    await assert.rejects(svc.acquire({ ...session, permissions: session.permissions.filter(permission => permission !== 'air_pickups.documents.manage') }, orderId, input.uploadId, 1), { code: 'PERMISSION_DENIED' });
    assert.equal((await svc.get(session, orderId, input.uploadId)).status, 'WAITING_BYTES');
  });
  test('completion raced between initial read and lease transaction uses checked lifecycle/storage replay', async () => {
    for (const mode of ['inactive', 'missing'] as const) {
      const orderId = await order(), svc = service(), bytes = pdf(`raced-${mode}`), input = metadata(bytes);
      await svc.register(session, orderId, input); const claim = await svc.acquire(session, orderId, input.uploadId, 1);
      const transport = Object.create(mysql) as Pool; let first = true;
      transport.getConnection = async () => {
        if (first) {
          first = false; const completed = await svc.save(session, claim.lease!, bytes, audit);
          if (mode === 'inactive') await svc.remove(session, orderId, completed.recordRef!.id, { operationId: randomUUID(), expectedAssetVersion: 1, reason: 'removed during race', password: 'test-password-123' }, audit);
          else { const [rows] = await mysql.execute<RowDataPacket[]>('SELECT storage_key FROM air_pickup_document_assets_v2 WHERE id=?', [completed.recordRef!.id]); await storage().remove!(rows[0].storage_key); }
        }
        return mysql.getConnection();
      };
      const racing = createPickupDocuments({ mysql: transport, storage: storage(), enabled: true, checker: async (_bytes, contentType) => ({ clean: true, validated: true, contentType }) });
      await assert.rejects(racing.acquire(session, orderId, input.uploadId, 1), { code: mode === 'inactive' ? 'DOCUMENT_UPLOAD_ASSET_INACTIVE' : 'DOCUMENT_STORAGE_UNAVAILABLE' });
    }
  });
});
