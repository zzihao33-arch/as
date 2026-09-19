import { createHash, randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';
import type { Pool, PoolConnection } from 'mysql2/promise';
import type { RowDataPacket } from 'mysql2';
import { ApiError } from './errors.js';
import type { WarehouseSession } from './warehouseIdentity.js';
import type { LabelStorage } from './labelStorage.js';
import { verifyWarehousePassword } from './warehouseSecurity.js';
import { DOCUMENT_POLICY, documentId, normalizeDocumentRegistration, fitsDocumentQuota, validateDocumentContent,
  type DocumentCapabilities, type DocumentChecker, type DocumentRegistration } from './pickupDocumentPolicy.js';

export type DocumentAsset = { assetId: string; orderId: string; filename: string; contentType: string; byteSize: number;
  assetStatus: 'READY' | 'REMOVED' | 'SUPERSEDED'; assetVersion: number; uploadedBy: string; uploadedAt: string;
  preview: { status: 'QUEUED' | 'RUNNING' | 'READY' | 'FAILED' | 'UNSUPPORTED'; generation: number; pageCount: number | null; errorCode: string | null };
  capabilities: DocumentCapabilities };
export type DocumentUploadView = { uploadId: string; operationId: string; orderId: string;
  status: 'WAITING_BYTES' | 'PROCESSING' | 'COMPLETED' | 'FAILED_NOT_SAVED'; phase: string;
  attempt: number; retryable: boolean; replayed: boolean; recordRef: { type: 'PICKUP_DOCUMENT_ASSET'; id: string; no: null } | null;
  errorCode: string | null; registration: DocumentRegistration; assetStatus?: DocumentAsset['assetStatus']; documentsRevision?: number; deduplicated?: boolean };
type UploadRow = RowDataPacket & { upload_id: string; order_id: string; actor_reference: string; registration_sha256: string; metadata: DocumentRegistration | string; reauthenticated_at: Date | null };
type AssetRow = RowDataPacket & { id: string; order_id: string; original_filename: string; detected_content_type: string; byte_size: number;
  content_sha256: string; storage_key: string; asset_status: DocumentAsset['assetStatus']; asset_version: number; created_by_reference: string; created_at: Date;
  preview_generation: number; preview_status: DocumentAsset['preview']['status']; page_count: number | null; error_code: string | null };
type OperationRow = RowDataPacket & { operation_id: string; actor_reference: string; operation_type: string; request_sha256: string; status: Exclude<DocumentUploadView['status'], 'WAITING_BYTES'>;
  scope_key: string; contract_version: number; canonicalization_version: number; record_type: string | null;
  attempt_no: number; retryable: boolean; record_id: string | null; error_code: string | null; document_phase: string;
  document_lease_token: string | null; document_lease_expires_at: Date | null; result_summary: string | { deduplicated?: boolean } | null };
export type DocumentLease = { upload: DocumentRegistration; orderId: string; actor: string; attempt: number; token: string };
type Audit = { requestId: string; ip: string };
type Executor = Pool | PoolConnection;
const LEASE_MS = 120000;
const actor = (session: WarehouseSession) => `user:${session.userId}`;
const parse = <T>(value: T | string): T => typeof value === 'string' ? JSON.parse(value) as T : value;
const error = (status: number, code: string, message: string) => new ApiError(status, code, message);
const unknown = () => error(503, 'OPERATION_RESULT_UNKNOWN', '结果待核对，请保留原上传标识继续查询。');

export function createDocumentReceiveSlots(maximum = 4) {
  let active = 0;
  return { acquire() { if (active >= maximum) throw error(429, 'DOCUMENT_RECEIVE_BUSY', '文档接收繁忙，请稍后重试。');
    active++; let released = false; return () => { if (!released) { released = true; active--; } }; } };
}
export async function receiveDocumentBytes(stream: Readable, declared: number, maximum = DOCUMENT_POLICY.maxFileBytes, timeoutMs = 60000): Promise<Buffer> {
  if (declared > maximum || declared <= 0) throw error(413, 'DOCUMENT_TOO_LARGE', '文件超过接收上限。');
  // One bounded allocation; do not retain an unbounded list of transport chunks or concatenate copies.
  const buffer = Buffer.allocUnsafe(declared); let received = 0;
  const timer = setTimeout(() => stream.destroy(error(408, 'DOCUMENT_RECEIVE_TIMEOUT', '接收超时，请查询原上传结果。')), timeoutMs);
  timer.unref();
  try {
    for await (const chunk of stream) {
      const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (received + part.length > declared || received + part.length > maximum) throw error(413, 'DOCUMENT_TOO_LARGE', '实收文件超过声明长度或上限。');
      part.copy(buffer, received); received += part.length;
    }
    if (received !== declared) throw error(422, 'DOCUMENT_LENGTH_MISMATCH', '实收文件长度与声明不一致。');
    return buffer;
  } finally { clearTimeout(timer); }
}

export function createPickupDocuments(dependencies: { mysql: Pool; storage: LabelStorage; enabled?: boolean; checker?: DocumentChecker; externalTimeoutMs?: number }) {
  const { mysql, storage, checker } = dependencies;
  let externalUnavailable = false;
  async function bounded<T>(work: (signal: AbortSignal) => Promise<T>, code: string): Promise<T> {
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([work(controller.signal), new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => { externalUnavailable = true; controller.abort(); reject(error(503, code, '文档检查或存储超时，上传暂时停用，请核对原结果。')); }, dependencies.externalTimeoutMs ?? 30000);
        timer.unref();
      })]);
    } finally { if (timer) clearTimeout(timer); }
  }
  function capabilities(session: WarehouseSession, status?: string): DocumentCapabilities {
    const has = (name: string) => session.permissions.some(permission => permission === name);
    const view = session.passwordState === 'ACTIVE' && has('air_pickups.view') && has('air_pickups.documents.view');
    return { view, download: view && has('air_pickups.documents.download'), add: view && status !== 'VOIDED' && has('air_pickups.documents.add'), manage: view && has('air_pickups.documents.manage') };
  }
  function enabled() { if (!dependencies.enabled) throw error(503, 'DOCUMENTS_UNAVAILABLE', '原件功能尚未启用。'); }
  async function authorize(db: Executor, session: WarehouseSession, action: keyof DocumentCapabilities, lock = false) {
    enabled();
    if (!session || !capabilities(session)[action]) throw error(403, 'PERMISSION_DENIED', '当前账号无权执行此文档操作。');
    const suffix = lock ? ' FOR SHARE' : '';
    const [users] = await db.execute<RowDataPacket[]>(`SELECT user_status,password_state,platform_role FROM warehouse_users WHERE id=?${suffix}`, [session.userId]);
    const [sessions] = await db.execute<RowDataPacket[]>(`SELECT id FROM warehouse_sessions WHERE id=? AND user_id=? AND revoked_at IS NULL AND expires_at>NOW(3) AND absolute_expires_at>NOW(3)${suffix}`, [session.sessionId, session.userId]);
    if (!users[0] || !sessions[0] || users[0].user_status !== 'ACTIVE' || users[0].password_state !== 'ACTIVE') throw error(401, 'SESSION_INVALID', '当前会话已失效。');
    if (users[0].platform_role === 'SYSTEM_ADMIN') return session;
    const [members] = await db.execute<RowDataPacket[]>(`SELECT m.role_id FROM warehouse_memberships m JOIN warehouses w ON w.id=m.warehouse_id WHERE m.id=? AND m.user_id=? AND m.role_id=? AND m.warehouse_id=? AND m.membership_status='ACTIVE' AND w.warehouse_status='ACTIVE'${suffix}`, [session.membershipId, session.userId, session.roleId, session.warehouseId]);
    if (!members[0]) throw error(403, 'PERMISSION_DENIED', '工作空间权限已变化。');
    const [rows] = await db.execute<RowDataPacket[]>(`SELECT permission_code FROM warehouse_role_permissions WHERE role_id=?${suffix}`, [session.roleId]);
    const required = new Set(['air_pickups.view', 'air_pickups.documents.view', `air_pickups.documents.${action}`]);
    if (![...required].every(code => rows.some(row => row.permission_code === code))) throw error(403, 'PERMISSION_DENIED', '文档权限已撤销。');
    return { ...session, permissions: session.permissions.filter(permission => rows.some(row => row.permission_code === permission)) };
  }
  async function order(db: Executor, orderId: string, lock = false, add = false) {
    const [rows] = await db.execute<RowDataPacket[]>(`SELECT id,order_status,documents_revision FROM air_pickup_orders WHERE id=?${lock ? ' FOR UPDATE' : ''}`, [documentId(orderId)]);
    if (!rows[0]) throw error(404, 'DOCUMENT_ORDER_NOT_FOUND', '当前范围内未找到提单。');
    if (add && rows[0].order_status === 'VOIDED') throw error(409, 'DOCUMENT_ORDER_VOIDED', '已作废提单不允许新增或替换原件。');
    return rows[0];
  }
  async function reauthenticate(db: Executor, session: WarehouseSession, password: unknown) {
    if (typeof password !== 'string' || !password || password.length > 1024) throw error(400, 'REAUTHENTICATION_REQUIRED', '请验证当前账户密码。');
    const [rows] = await db.execute<RowDataPacket[]>('SELECT password_hash FROM warehouse_users WHERE id=?', [session.userId]);
    if (!rows[0] || !await verifyWarehousePassword(password, rows[0].password_hash)) throw error(401, 'REAUTHENTICATION_FAILED', '操作密码错误。');
  }
  async function uploadRow(db: Executor, session: WarehouseSession, orderId: string, uploadId: string, lock = false) {
    const [rows] = await db.execute<UploadRow[]>(`SELECT * FROM air_pickup_document_uploads WHERE upload_id=? AND order_id=? AND actor_reference=? AND scope_key='GLOBAL'${lock ? ' FOR SHARE' : ''}`, [documentId(uploadId), documentId(orderId), actor(session)]);
    if (!rows[0]) throw error(404, 'DOCUMENT_UPLOAD_NOT_FOUND', '当前授权范围内未找到上传。');
    return rows[0];
  }
  async function operation(db: Executor, id: string, lock = false, nowait = false) {
    const [rows] = await db.execute<OperationRow[]>(`SELECT * FROM warehouse_ui_operations WHERE operation_id=?${lock ? ` FOR UPDATE${nowait ? ' NOWAIT' : ''}` : ''}`, [id]);
    return rows[0];
  }
  function assertUploadOperation(upload: Pick<UploadRow, 'actor_reference' | 'registration_sha256'>, op: OperationRow | undefined) {
    if (!op) return;
    if (op.actor_reference !== upload.actor_reference || op.scope_key !== 'GLOBAL') throw error(404, 'DOCUMENT_UPLOAD_NOT_FOUND', '当前授权范围内未找到上传。');
    if (op.operation_type !== 'PICKUP_DOCUMENT_UPLOAD' || op.request_sha256 !== upload.registration_sha256 || op.contract_version !== 2 || op.canonicalization_version !== 1
      || op.status === 'COMPLETED' && op.record_type !== 'PICKUP_DOCUMENT_ASSET') throw error(409, 'DOCUMENT_UPLOAD_ID_CONFLICT', '此上传标识已绑定其他操作。');
  }
  async function asset(db: Executor, orderId: string, id: string, lock = false) {
    const [rows] = await db.execute<AssetRow[]>(`SELECT a.*,p.preview_status,p.page_count,p.error_code FROM air_pickup_document_assets_v2 a LEFT JOIN air_pickup_document_previews p ON p.asset_id=a.id AND p.generation=a.preview_generation WHERE a.id=? AND a.order_id=?${lock ? ' FOR UPDATE' : ''}`, [documentId(id), orderId]);
    if (!rows[0]) throw error(404, 'DOCUMENT_NOT_FOUND', '当前范围内未找到原件。');
    return rows[0];
  }
  function assetView(row: AssetRow, caps: DocumentCapabilities): DocumentAsset {
    return { assetId: row.id, orderId: row.order_id, filename: row.original_filename, contentType: row.detected_content_type, byteSize: Number(row.byte_size),
      assetStatus: row.asset_status, assetVersion: row.asset_version, uploadedBy: row.created_by_reference, uploadedAt: row.created_at.toISOString(),
      preview: { status: row.preview_status ?? 'UNSUPPORTED', generation: row.preview_generation, pageCount: row.page_count ?? null, errorCode: row.error_code ?? null },
      capabilities: { ...caps, add: caps.add && row.asset_status === 'READY', manage: caps.manage, download: caps.download && (row.asset_status === 'READY' || caps.manage) } };
  }
  async function view(db: Executor, upload: UploadRow, op: OperationRow | undefined, replayed = true): Promise<DocumentUploadView> {
    assertUploadOperation(upload, op);
    const result: DocumentUploadView = { uploadId: upload.upload_id, operationId: upload.upload_id, orderId: upload.order_id,
      status: op?.status ?? 'WAITING_BYTES', phase: op?.document_phase ?? 'WAITING_BYTES', attempt: op?.attempt_no ?? 0,
      retryable: op?.status === 'FAILED_NOT_SAVED' && Boolean(op.retryable), replayed, recordRef: null, errorCode: op?.error_code ?? null, registration: parse<DocumentRegistration>(upload.metadata) };
    if (op?.status === 'COMPLETED') {
      if (!op.record_id) throw unknown();
      const row = await asset(db, upload.order_id, op.record_id);
      result.recordRef = { type: 'PICKUP_DOCUMENT_ASSET', id: row.id, no: null }; result.assetStatus = row.asset_status;
      result.documentsRevision = Number((await order(db, upload.order_id)).documents_revision);
      result.deduplicated = op.result_summary ? Boolean(parse<{ deduplicated?: boolean }>(op.result_summary).deduplicated) : false;
    }
    return result;
  }
  async function verifiedObject(key: string, expectedSize: number, hash: string) {
    try {
      await bounded(async signal => {
      const object = await storage.open(key);
      if (signal.aborted) { object.stream.destroy(); throw new Error('read expired'); }
      const abort = () => object.stream.destroy(); signal.addEventListener('abort', abort, { once: true });
      try {
      if (object.byteSize !== expectedSize) { object.stream.destroy(); throw new Error('size mismatch'); }
      let length = 0; const digest = createHash('sha256');
      for await (const chunk of object.stream) { length += chunk.length; if (length > expectedSize) { object.stream.destroy(); throw new Error('size mismatch'); } digest.update(chunk); }
      if (length !== expectedSize || digest.digest('hex') !== hash) throw new Error('content mismatch');
      } finally { signal.removeEventListener('abort', abort); object.stream.destroy(); }
      }, 'DOCUMENT_STORAGE_UNAVAILABLE');
    } catch { throw error(503, 'DOCUMENT_STORAGE_UNAVAILABLE', '已关联原件暂时不可读取，请稍后重试。'); }
  }
  async function get(session: WarehouseSession, orderId: string, uploadId: string) {
    await authorize(mysql, session, 'add'); await order(mysql, orderId);
    const row = await uploadRow(mysql, session, orderId, uploadId);
    return view(mysql, row, await operation(mysql, row.upload_id));
  }
  async function register(session: WarehouseSession, orderId: string, raw: Record<string, unknown>): Promise<DocumentUploadView> {
    await authorize(mysql, session, 'add');
    const metadata = normalizeDocumentRegistration(raw, false), id = documentId(orderId);
    const fingerprint = createHash('sha256').update(JSON.stringify({ orderId: id, actor: actor(session), ...metadata })).digest('hex');
    assertUploadOperation({ actor_reference: actor(session), registration_sha256: fingerprint }, await operation(mysql, metadata.uploadId));
    const existing = await mysql.execute<UploadRow[]>('SELECT * FROM air_pickup_document_uploads WHERE upload_id=?', [metadata.uploadId]);
    if (existing[0][0]) {
      const previous = await uploadRow(mysql, session, id, metadata.uploadId);
      if (previous.registration_sha256 !== fingerprint) throw error(409, 'DOCUMENT_UPLOAD_ID_CONFLICT', '此上传标识已绑定其他内容。');
      return get(session, id, metadata.uploadId);
    }
    normalizeDocumentRegistration(raw);
    await order(mysql, id, false, true);
    if (metadata.supersedesAssetId) { await authorize(mysql, session, 'manage'); await reauthenticate(mysql, session, raw.password);
      const old = await asset(mysql, id, metadata.supersedesAssetId);
      if (old.asset_status !== 'READY' || old.asset_version !== metadata.expectedAssetVersion) throw error(409, 'DOCUMENT_ASSET_VERSION_CONFLICT', '原件版本已变化。'); }
    try {
      await mysql.execute(`INSERT INTO air_pickup_document_uploads (upload_id,order_id,actor_reference,registration_sha256,metadata,reauthenticated_at) VALUES (?,?,?,?,?,?)`,
        [metadata.uploadId, id, actor(session), fingerprint, JSON.stringify(metadata), metadata.supersedesAssetId ? new Date() : null]);
    } catch (caught) {
      if (caught && typeof caught === 'object' && 'code' in caught && caught.code === 'ER_DUP_ENTRY') return register(session, id, raw);
      throw unknown();
    }
    return { ...await get(session, id, metadata.uploadId), replayed: false };
  }
  async function acquire(session: WarehouseSession, orderId: string, uploadId: string, attempt: number, retryOfAttempt?: number): Promise<{ view: DocumentUploadView; lease: DocumentLease | null }> {
    orderId = documentId(orderId); uploadId = documentId(uploadId);
    await authorize(mysql, session, 'add');
    const upload = await uploadRow(mysql, session, orderId, uploadId), metadata = parse<DocumentRegistration>(upload.metadata);
    const current = await operation(mysql, uploadId);
    assertUploadOperation(upload, current);
    async function checkedReplay(op: OperationRow): Promise<{ view: DocumentUploadView; lease: null }> {
      const replay = await view(mysql, upload, op);
      if (replay.assetStatus !== 'READY') throw new ApiError(409, 'DOCUMENT_UPLOAD_ASSET_INACTIVE', '原上传已成功，但原件已移除或替代。', { operationId: uploadId, attempt: replay.attempt, retryable: false });
      const original = await asset(mysql, orderId, op.record_id!);
      await verifiedObject(original.storage_key, Number(original.byte_size), original.content_sha256);
      return { view: replay, lease: null };
    }
    if (current?.status === 'COMPLETED') return checkedReplay(current);
    if (metadata.supersedesAssetId) await authorize(mysql, session, 'manage');
    if (externalUnavailable) throw error(503, 'DOCUMENT_DEPENDENCY_UNAVAILABLE', '文档依赖已超时，新上传暂时停用。');
    if (!Number.isSafeInteger(attempt) || attempt < 1 || attempt > 2147483647 || (retryOfAttempt !== undefined && (!Number.isSafeInteger(retryOfAttempt) || retryOfAttempt < 1))) throw error(400, 'DOCUMENT_ATTEMPT_INVALID', '上传执行次数无效。');
    await order(mysql, orderId, false, true);
    const connection = await mysql.getConnection(); let committing = false, released = false;
    try {
      await connection.beginTransaction();
      // INSERT creates/locks only the operation. No order lock spans reception/storage.
      await connection.execute(`INSERT IGNORE INTO warehouse_ui_operations (operation_id,actor_reference,actor_user_id,actor_context,scope_key,operation_type,contract_version,canonicalization_version,request_sha256,status,attempt_no,document_phase)
        VALUES (?,?,?,?,'GLOBAL','PICKUP_DOCUMENT_UPLOAD',2,1,?,'PROCESSING',1,'WAITING_EXECUTOR')`, [uploadId, actor(session), session.userId, JSON.stringify({ warehouseId: session.warehouseId }), upload.registration_sha256]);
      const op = (await operation(connection, uploadId, true))!;
      assertUploadOperation(upload, op);
      if (op.status === 'PROCESSING' && (attempt !== op.attempt_no || (retryOfAttempt !== undefined && retryOfAttempt !== op.attempt_no - 1))) throw error(409, 'DOCUMENT_ATTEMPT_INVALID', '当前上传执行次数不一致。');
      if (op.status === 'COMPLETED') {
        await connection.rollback(); connection.release(); released = true;
        return await checkedReplay(op);
      }
      if (op.status === 'PROCESSING' && op.document_lease_token) {
        await connection.rollback(); return { view: await view(mysql, upload, op), lease: null };
      }
      if (op.status === 'FAILED_NOT_SAVED') {
        if (!op.retryable || retryOfAttempt !== op.attempt_no || attempt !== op.attempt_no + 1) throw error(409, 'DOCUMENT_ATTEMPT_INVALID', '请按已确认失败的执行次数重试。');
      } else if (attempt !== 1 || retryOfAttempt !== undefined) throw error(409, 'DOCUMENT_ATTEMPT_INVALID', '首次上传执行次数必须为1。');
      const token = randomUUID();
      await connection.execute(`UPDATE warehouse_ui_operations SET status='PROCESSING',attempt_no=?,retryable=FALSE,error_code=NULL,completed_at=NULL,document_phase='RECEIVING',document_lease_token=?,document_lease_expires_at=? WHERE operation_id=?`, [attempt, token, new Date(Date.now() + LEASE_MS), uploadId]);
      const opView = await view(connection, upload, (await operation(connection, uploadId))!, false);
      committing = true; await connection.commit();
      return { view: opView, lease: { upload: metadata, orderId, actor: actor(session), attempt, token } };
    } catch (caught) {
      if (released) throw caught;
      if (committing) { connection.destroy(); released = true; throw unknown(); }
      await connection.rollback().catch(() => undefined); throw caught;
    } finally { if (!released) connection.release(); }
  }
  async function renew(lease: DocumentLease) {
    const [result] = await mysql.execute<import('mysql2').ResultSetHeader>(`UPDATE warehouse_ui_operations SET document_lease_expires_at=? WHERE operation_id=? AND status='PROCESSING' AND attempt_no=? AND document_lease_token=? AND document_lease_expires_at>UTC_TIMESTAMP(3)`, [new Date(Date.now() + LEASE_MS), lease.upload.uploadId, lease.attempt, lease.token]);
    if (result.affectedRows !== 1) throw error(409, 'DOCUMENT_ATTEMPT_STALE', '此上传执行已失效，请查询原上传。');
  }
  async function fail(lease: DocumentLease, caught: unknown) {
    const code = caught instanceof ApiError ? caught.code : 'DOCUMENT_RECEIVE_INTERRUPTED';
    const retryable = !(caught instanceof ApiError) || caught.status >= 500 || ['DOCUMENT_RECEIVE_TIMEOUT', 'DOCUMENT_RECEIVE_INTERRUPTED'].includes(code);
    await mysql.execute(`UPDATE warehouse_ui_operations SET status='FAILED_NOT_SAVED',retryable=?,error_code=?,document_phase='FAILED_NOT_SAVED',document_lease_token=NULL,document_lease_expires_at=NULL,completed_at=NOW(3)
      WHERE operation_id=? AND status='PROCESSING' AND attempt_no=? AND document_lease_token=?`, [retryable, code, lease.upload.uploadId, lease.attempt, lease.token]).catch(() => undefined);
  }
  async function orphan(lease: DocumentLease, key: string, reason: string) {
    await mysql.execute('INSERT INTO air_pickup_document_orphan_candidates (upload_id,attempt_no,storage_key,reason) VALUES (?,?,?,?)', [lease.upload.uploadId, lease.attempt, key, reason]).catch(() => undefined);
  }
  async function event(db: PoolConnection, session: WarehouseSession, audit: Audit, orderId: string, type: string, reason: string | null, data: unknown) {
    await db.execute('INSERT INTO air_pickup_events (order_id,event_type,actor_user_id,actor_reference,request_id,ip_address,reason,event_data) VALUES (?,?,?,?,?,?,?,?)', [orderId, type, session.userId, actor(session), audit.requestId, audit.ip.slice(0, 64), reason, JSON.stringify(data)]);
  }
  async function save(session: WarehouseSession, lease: DocumentLease, bytes: Buffer, audit: Audit): Promise<DocumentUploadView> {
    const metadata = lease.upload, key = `pickup-documents/${lease.orderId}/${metadata.sha256}`;
    let connection: PoolConnection | undefined, committing = false, published = false, storageAttempted = false, rolledBack = false;
    let renewing = false;
    const heartbeat = setInterval(() => { if (!renewing) { renewing = true; void renew(lease).catch(() => undefined).finally(() => { renewing = false; }); } }, 30000);
    heartbeat.unref();
    try {
      if (lease.actor !== actor(session)) throw error(403, 'PERMISSION_DENIED', '此上传不属于当前账户。');
      await renew(lease);
      const contentType = await bounded(signal => validateDocumentContent(bytes, metadata, checker, signal), 'DOCUMENT_CHECK_UNAVAILABLE');
      await renew(lease);
      // A provider may throw after publication; probe immutable object before deciding.
      storageAttempted = true;
      try { await bounded(() => storage.put(key, bytes), 'DOCUMENT_STORAGE_UNAVAILABLE'); published = true; }
      catch { if (externalUnavailable) throw error(503, 'DOCUMENT_STORAGE_UNAVAILABLE', '存储发布结果待核对。'); await verifiedObject(key, bytes.length, metadata.sha256); published = true; }
      await verifiedObject(key, bytes.length, metadata.sha256);
      connection = await mysql.getConnection(); await connection.beginTransaction();
      const op = await operation(connection, metadata.uploadId, true);
      // Locking read: a consistent read here would pin an old REPEATABLE READ snapshot before
      // waiting for the order lock, causing later aggregate quotas to miss the preceding writer.
      assertUploadOperation(await uploadRow(connection, session, lease.orderId, metadata.uploadId, true), op);
      if (!op || op.status !== 'PROCESSING' || op.attempt_no !== lease.attempt || op.document_lease_token !== lease.token || !op.document_lease_expires_at || op.document_lease_expires_at.getTime() <= Date.now()) throw error(409, 'DOCUMENT_ATTEMPT_STALE', '此上传执行已失效。');
      const currentOrder = await order(connection, lease.orderId, true, true);
      await authorize(connection, session, 'add', true);
      let old: AssetRow | undefined;
      if (metadata.supersedesAssetId) {
        await authorize(connection, session, 'manage', true);
        const registered = await uploadRow(connection, session, lease.orderId, metadata.uploadId);
        if (!registered.reauthenticated_at) throw error(401, 'REAUTHENTICATION_REQUIRED', '替换尚未完成二次验证。');
        old = await asset(connection, lease.orderId, metadata.supersedesAssetId, true);
        if (old.asset_status !== 'READY' || old.asset_version !== metadata.expectedAssetVersion) throw error(409, 'DOCUMENT_ASSET_VERSION_CONFLICT', '被替换原件版本已变化。');
      }
      const [same] = await connection.execute<AssetRow[]>("SELECT * FROM air_pickup_document_assets_v2 WHERE order_id=? AND active_sha256=? FOR UPDATE", [lease.orderId, metadata.sha256]);
      if (old && same[0]) throw error(409, 'DOCUMENT_REPLACEMENT_DUPLICATE', '替换内容与有效原件重复，请保留明确版本关系。');
      let assetId = same[0]?.id;
      if (!assetId) {
        const [totals] = await connection.execute<RowDataPacket[]>("SELECT COUNT(*) AS n,COALESCE(SUM(byte_size),0) AS bytes FROM air_pickup_document_assets_v2 WHERE order_id=? AND asset_status='READY'", [lease.orderId]);
        if (!fitsDocumentQuota(Number(totals[0].n) + (old ? 0 : 1), Number(totals[0].bytes) - Number(old?.byte_size ?? 0) + bytes.length,
          { count: DOCUMENT_POLICY.maxActiveFiles, bytes: DOCUMENT_POLICY.maxActiveBytes })) throw error(409, 'DOCUMENT_QUOTA_EXCEEDED', '有效原件数量或总容量超过当前策略。');
        if (old) await connection.execute("UPDATE air_pickup_document_assets_v2 SET asset_status='SUPERSEDED',asset_version=asset_version+1,removed_by_reference=?,removed_reason=?,removed_at=NOW(3) WHERE id=?", [actor(session), metadata.reason, old.id]);
        assetId = randomUUID();
        await connection.execute(`INSERT INTO air_pickup_document_assets_v2 (id,order_id,original_filename,detected_content_type,byte_size,content_sha256,storage_key,created_by_reference,supersedes_asset_id,creation_upload_id) VALUES (?,?,?,?,?,?,?,?,?,?)`, [assetId, lease.orderId, metadata.filename, contentType, bytes.length, metadata.sha256, key, actor(session), old?.id ?? null, metadata.uploadId]);
        const direct = ['application/pdf', 'image/png', 'image/jpeg'].includes(contentType);
        await connection.execute(`INSERT INTO air_pickup_document_previews (asset_id,generation,source_sha256,converter_version,preview_status,error_code) VALUES (?,1,?,?,?,NULL)`, [assetId, metadata.sha256, direct ? 'original-v1' : 'original-download-v1', direct ? 'READY' : 'UNSUPPORTED']);
        await connection.execute('UPDATE air_pickup_orders SET documents_revision=documents_revision+1 WHERE id=?', [lease.orderId]);
        await event(connection, session, audit, lease.orderId, old ? 'DOCUMENT_REPLACED' : 'DOCUMENT_ADDED', metadata.reason, { assetId, uploadId: metadata.uploadId, supersedesAssetId: old?.id ?? null });
      }
      await connection.execute(`UPDATE warehouse_ui_operations SET status='COMPLETED',record_type='PICKUP_DOCUMENT_ASSET',record_id=?,result_summary=?,completed_at=NOW(3),document_phase='COMPLETED',document_lease_token=NULL,document_lease_expires_at=NULL WHERE operation_id=?`, [assetId, JSON.stringify({ deduplicated: Boolean(same[0]), documentsRevision: Number(currentOrder.documents_revision) + (same[0] ? 0 : 1) }), metadata.uploadId]);
      committing = true; await connection.commit(); connection.release(); connection = undefined;
      return { ...await get(session, lease.orderId, metadata.uploadId), replayed: false };
    } catch (caught) {
      if (connection) {
        if (committing) connection.destroy();
        else { try { await connection.rollback(); rolledBack = true; connection.release(); } catch { connection.destroy(); } }
        connection = undefined;
      } else if (!committing) rolledBack = true;
      if (published || storageAttempted) await orphan(lease, key, committing ? 'COMMIT_RESULT_UNKNOWN' : 'CANDIDATE_NOT_ASSOCIATED');
      if (committing || !rolledBack) {
        try { return await get(session, lease.orderId, metadata.uploadId); } catch { throw unknown(); }
      }
      await fail(lease, caught); throw caught;
    } finally { clearInterval(heartbeat); }
  }
  async function reconcile(uploadId: string, attempt: number): Promise<'BUSY' | 'UNCHANGED' | 'FAILED_NOT_SAVED' | 'RECONCILIATION_REQUIRED'> {
    const connection = await mysql.getConnection();
    try {
      await connection.beginTransaction(); const op = await operation(connection, documentId(uploadId), true, true);
      if (!op || op.operation_type !== 'PICKUP_DOCUMENT_UPLOAD' || op.status !== 'PROCESSING' || op.attempt_no !== attempt) { await connection.rollback(); return 'UNCHANGED'; }
      if (op.document_lease_expires_at && op.document_lease_expires_at.getTime() > Date.now()) { await connection.rollback(); return 'BUSY'; }
      const [assets] = await connection.execute<RowDataPacket[]>('SELECT id FROM air_pickup_document_assets_v2 WHERE creation_upload_id=? FOR UPDATE', [uploadId]);
      if (assets[0]) { await connection.rollback(); return 'RECONCILIATION_REQUIRED'; }
      await connection.execute("UPDATE warehouse_ui_operations SET status='FAILED_NOT_SAVED',retryable=TRUE,error_code='DOCUMENT_RECEIVE_INTERRUPTED',completed_at=NOW(3),document_phase='FAILED_NOT_SAVED',document_lease_token=NULL,document_lease_expires_at=NULL WHERE operation_id=?", [uploadId]);
      await connection.commit(); return 'FAILED_NOT_SAVED';
    } catch (caught) { await connection.rollback().catch(() => undefined); if (caught && typeof caught === 'object' && 'code' in caught && caught.code === 'ER_LOCK_NOWAIT') return 'BUSY'; connection.destroy(); throw unknown(); } finally { connection.release(); }
  }
  let sweeping = false;
  async function reconcileExpired(limit = 25) {
    if (!dependencies.enabled || sweeping) return { inspected: 0, recovered: 0 };
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 25) throw error(400, 'DOCUMENT_INVALID_REQUEST', '恢复批量上限无效。');
    sweeping = true;
    try {
      const [rows] = await mysql.query<RowDataPacket[]>(`SELECT operation_id,attempt_no FROM warehouse_ui_operations WHERE operation_type='PICKUP_DOCUMENT_UPLOAD' AND status='PROCESSING' AND scope_key='GLOBAL' AND contract_version=2 AND canonicalization_version=1 AND (document_lease_expires_at<UTC_TIMESTAMP(3) OR document_lease_expires_at IS NULL AND updated_at<DATE_SUB(NOW(3),INTERVAL 2 MINUTE)) ORDER BY updated_at LIMIT ?`, [limit]);
      let recovered = 0;
      for (const row of rows) if (await reconcile(row.operation_id, Number(row.attempt_no)) === 'FAILED_NOT_SAVED') recovered++;
      return { inspected: rows.length, recovered };
    } finally { sweeping = false; }
  }
  async function list(session: WarehouseSession, orderId: string, input: { includeHistory?: boolean; cursor?: string; limit?: number }) {
    const authorizedSession = await authorize(mysql, session, input.includeHistory ? 'manage' : 'view');
    const limit = input.limit ?? 50;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw error(400, 'DOCUMENT_INVALID_REQUEST', '分页上限无效。');
    const cursor = input.cursor ? documentId(input.cursor) : null;
    const connection = await mysql.getConnection();
    try {
      await connection.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ'); await connection.beginTransaction();
      const row = await order(connection, orderId), caps = capabilities(authorizedSession, row.order_status);
      const [totals] = await connection.execute<RowDataPacket[]>("SELECT COUNT(*) AS n,COALESCE(SUM(byte_size),0) AS bytes FROM air_pickup_document_assets_v2 WHERE order_id=? AND asset_status='READY'", [orderId]);
      const [assets] = await connection.query<AssetRow[]>(`SELECT a.*,p.preview_status,p.page_count,p.error_code FROM air_pickup_document_assets_v2 a LEFT JOIN air_pickup_document_previews p ON p.asset_id=a.id AND p.generation=a.preview_generation WHERE a.order_id=? ${input.includeHistory ? '' : "AND a.asset_status='READY'"} ${cursor ? 'AND a.id>?' : ''} ORDER BY a.id LIMIT ?`, cursor ? [orderId, cursor, limit + 1] : [orderId, limit + 1]);
      await connection.commit();
      return { items: assets.slice(0, limit).map(item => assetView(item, caps)), savedCount: Number(totals[0].n), activeBytes: Number(totals[0].bytes), documentsRevision: Number(row.documents_revision), capabilities: caps,
        nextCursor: assets.length > limit ? assets[limit - 1].id : null };
    } catch (caught) { await connection.rollback(); throw caught; } finally { connection.release(); }
  }
  async function open(session: WarehouseSession, orderId: string, assetId: string, variant: string, disposition: string) {
    await authorize(mysql, session, 'view'); await order(mysql, orderId);
    if (!['original', 'preview'].includes(variant) || !['attachment', 'inline'].includes(disposition)) throw error(400, 'DOCUMENT_INVALID_REQUEST', '内容读取参数无效。');
    const row = await asset(mysql, orderId, assetId);
    if (row.asset_status !== 'READY') await authorize(mysql, session, 'manage');
    if (variant === 'original' || disposition === 'attachment') await authorize(mysql, session, 'download');
    const direct = ['application/pdf', 'image/png', 'image/jpeg'].includes(row.detected_content_type);
    if (variant === 'original' && !direct && disposition !== 'attachment') throw error(409, 'DOCUMENT_OFFICE_ATTACHMENT_ONLY', 'Office原件仅支持下载。');
    if (variant === 'preview' && !direct) throw error(409, `DOCUMENT_PREVIEW_${row.preview_status === 'FAILED' ? 'FAILED' : row.preview_status === 'UNSUPPORTED' ? 'UNSUPPORTED' : 'NOT_READY'}`, 'Office预览尚不可用，原件仍可下载。');
    await verifiedObject(row.storage_key, Number(row.byte_size), row.content_sha256);
    try {
      const object = await bounded(async signal => { const opened = await storage.open(row.storage_key); if (signal.aborted) { opened.stream.destroy(); throw new Error('read expired'); } return opened; }, 'DOCUMENT_STORAGE_UNAVAILABLE');
      if (object.byteSize !== Number(row.byte_size)) { object.stream.destroy(); throw new Error('size mismatch'); }
      return { metadata: assetView(row, capabilities(session)), object };
    } catch { throw error(503, 'DOCUMENT_STORAGE_UNAVAILABLE', '原件暂时不可读取。'); }
  }
  async function remove(session: WarehouseSession, orderId: string, assetId: string, raw: Record<string, unknown>, audit: Audit) {
    await authorize(mysql, session, 'manage');
    const operationId = documentId(raw.operationId), reason = typeof raw.reason === 'string' ? raw.reason.trim() : '';
    if (!reason || reason.length > 1000 || !Number.isSafeInteger(raw.expectedAssetVersion) || Number(raw.expectedAssetVersion) < 1) throw error(400, 'DOCUMENT_INVALID_REQUEST', '请提供移除原因和原件版本。');
    const fingerprint = createHash('sha256').update(JSON.stringify({ orderId: documentId(orderId), assetId: documentId(assetId), version: raw.expectedAssetVersion, reason })).digest('hex');
    const existing = await operation(mysql, operationId);
    if (existing) {
      if (existing.actor_reference !== actor(session)) throw error(404, 'DOCUMENT_OPERATION_NOT_FOUND', '当前范围内未找到操作。');
      if (existing.operation_type !== 'PICKUP_DOCUMENT_REMOVE' || existing.request_sha256 !== fingerprint) throw error(409, 'DOCUMENT_OPERATION_ID_CONFLICT', '操作标识内容不一致。');
      if (existing.status === 'COMPLETED') return { operationId, attempt: 1, replayed: true, recordRef: { type: 'PICKUP_DOCUMENT_ASSET', id: assetId }, documentsRevision: Number((await order(mysql, orderId)).documents_revision) };
      throw unknown();
    }
    await reauthenticate(mysql, session, raw.password);
    const connection = await mysql.getConnection(); let committing = false;
    try {
      await connection.beginTransaction();
      await connection.execute(`INSERT INTO warehouse_ui_operations (operation_id,actor_reference,actor_user_id,actor_context,scope_key,operation_type,contract_version,canonicalization_version,request_sha256,status) VALUES (?,?,?,?,'GLOBAL','PICKUP_DOCUMENT_REMOVE',2,1,?,'PROCESSING')`, [operationId, actor(session), session.userId, '{}', fingerprint]);
      await operation(connection, operationId, true); const currentOrder = await order(connection, orderId, true);
      await authorize(connection, session, 'manage', true);
      const row = await asset(connection, orderId, assetId, true);
      if (row.asset_version !== raw.expectedAssetVersion || row.asset_status !== 'READY') throw error(409, 'DOCUMENT_ASSET_VERSION_CONFLICT', '原件版本已变化。');
      await connection.execute("UPDATE air_pickup_document_assets_v2 SET asset_status='REMOVED',asset_version=asset_version+1,removed_by_reference=?,removed_reason=?,removed_at=NOW(3) WHERE id=?", [actor(session), reason, assetId]);
      await connection.execute('UPDATE air_pickup_orders SET documents_revision=documents_revision+1 WHERE id=?', [orderId]);
      await event(connection, session, audit, orderId, 'DOCUMENT_REMOVED', reason, { assetId, operationId });
      await connection.execute("UPDATE warehouse_ui_operations SET status='COMPLETED',record_type='PICKUP_DOCUMENT_ASSET',record_id=?,completed_at=NOW(3) WHERE operation_id=?", [assetId, operationId]);
      committing = true; await connection.commit();
      return { operationId, attempt: 1, replayed: false, recordRef: { type: 'PICKUP_DOCUMENT_ASSET', id: assetId }, documentsRevision: Number(currentOrder.documents_revision) + 1 };
    } catch (caught) {
      if (committing) { connection.destroy(); throw unknown(); }
      await connection.rollback();
      if (caught && typeof caught === 'object' && 'code' in caught && caught.code === 'ER_DUP_ENTRY') return remove(session, orderId, assetId, raw, audit);
      throw caught;
    } finally { connection.release(); }
  }
  return { policy: (session: WarehouseSession) => ({ ...DOCUMENT_POLICY, enabled: Boolean(dependencies.enabled), capabilities: capabilities(session) }),
    register, get, acquire, renew, fail, save, reconcile, reconcileExpired, list, open, remove };
}
