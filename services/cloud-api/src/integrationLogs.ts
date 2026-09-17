import { randomUUID } from 'node:crypto';
import { Router, type RequestHandler } from 'express';
import type { Pool, PoolConnection } from 'mysql2/promise';
import type { RowDataPacket, ResultSetHeader } from 'mysql2';
import { ApiError } from './errors.js';
import { requireWarehousePermission } from './warehouseAccess.js';

type Summary = Record<string, string | number | boolean>;
export type IntegrationAttempt = {
  occurredAt: Date; completedAt: Date; requestId: string; clientId: string | null;
  operation: string; method: string; endpoint: string; reference: string | null; relatedReference?: string | null;
  httpStatus: number; durationMs: number; errorCode: string | null;
  requestSummary: Summary; responseSummary: Summary;
};
const operations = ['shipment', 'inbound_batch', 'air_shipment', 'label_push', 'label_pdf'];
export function safeSummary(body: unknown): Summary {
  if (Buffer.isBuffer(body)) return { format: 'binary', bytes: body.length, pdfOmitted: true };
  if (!body || typeof body !== 'object') return { format: 'unavailable' };
  const value = body as Record<string, unknown>;
  const airWaybillNo = identifier(value.airWaybillNo);
  return { format: 'json', itemCount: Array.isArray(value.shipments) ? value.shipments.length : Array.isArray(value.items) ? value.items.length : 0, pdfOmitted: true,
    ...(airWaybillNo ? { airWaybillNo } : {}) };
}
function identifier(value: unknown, max = 128): string | null {
  return typeof value === 'string' && value.length <= max && /^[\p{L}\p{N}_.:/ -]+$/u.test(value)
    && !/(?:cmh_(?:live|test)_|Bearer\s|eyJ[A-Za-z0-9_-]*\.)/i.test(value) ? value : null;
}
// Register before parsers/auth. Pending writes hold only small allowlisted records.
export function createIntegrationAudit(options: {
  append: (attempt: IntegrationAttempt, deadlineMs?: number) => Promise<void>;
  onFailure?: (value: { event: string }) => void;
  maxPending?: number;
  maxLatencyMs?: number;
}) {
  const pending = new Set<Promise<void>>();
  let tail = Promise.resolve();
  const report = (event: string) => {
    try { (options.onFailure ?? (value => console.error(value)))({ event }); } catch { /* telemetry also fails open */ }
  };
  const middleware: RequestHandler = (req, res, next) => {
    const post = req.method === 'POST' && /^\/api\/v1\/(shipments|inbound-batches|air-shipments|label-pushes)\/?$/i.exec(req.path);
    const pdf = req.method === 'PUT' && /^\/api\/v1\/shipments\/by-first-leg\/([^/]+)\/label\/?$/i.exec(req.path);
    if (!post && !pdf) return next();
    const name = post ? post[1].toLowerCase() : '';
    const operation = pdf ? 'label_pdf' : ({ shipments: 'shipment', 'inbound-batches': 'inbound_batch', 'air-shipments': 'air_shipment', 'label-pushes': 'label_push' } as Record<string, string>)[name];
    const endpoint = pdf ? '/api/v1/shipments/by-first-leg/:firstLegTrackingNo/label' : `/api/v1/${name}`;
    const occurredAt = new Date(); const started = performance.now();
    let errorCode: string | null = null;
    const originalJson = res.json;
    res.json = function(body: unknown) {
      if (body && typeof body === 'object') {
        const envelope = body as { error?: { code?: unknown }; code?: unknown };
        const code = envelope.error?.code ?? envelope.code;
        if (typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(code)) errorCode = code;
      }
      return originalJson.call(this, body);
    };
    let recorded = false;
    const finish = () => {
      if (recorded) return;
      recorded = true;
      if (pending.size >= (options.maxPending ?? 256)) { report('integration_audit_queue_full'); return; }
      try {
        let pdfReference: string | null = null;
        if (pdf) { try { pdfReference = identifier(decodeURIComponent(pdf[1])); } catch { /* malformed URI */ } }
        const requestSummary = safeSummary(req.body);
        const length = req.header('content-length');
        if (length && /^\d{1,10}$/.test(length)) requestSummary.contentLength = Number(length);
        const httpStatus = res.writableFinished ? res.statusCode : 499;
        const attempt: IntegrationAttempt = {
          occurredAt, completedAt: new Date(), requestId: identifier(req.requestId, 64) ?? randomUUID(),
          clientId: req.client?.id ?? null, operation, method: req.method, endpoint,
          reference: pdfReference ?? identifier(req.body?.originalTrackingNo ?? req.body?.firstLegTrackingNo ?? req.body?.batchId ?? req.body?.airWaybillNo),
          relatedReference: identifier(req.body?.transferTrackingNo),
          httpStatus, durationMs: Math.min(2147483647, Math.round(performance.now() - started)),
          errorCode: httpStatus >= 400 ? (errorCode ?? (httpStatus === 499 ? 'CLIENT_DISCONNECTED' : 'HTTP_ERROR')) : null,
          requestSummary, responseSummary: { httpStatus, ...(httpStatus >= 400 && errorCode ? { errorCode } : {}) },
        };
        const deadline = performance.now() + (options.maxLatencyMs ?? 5000);
        // Exactly one active writer. Queued entries expire instead of building
        // an unbounded shutdown delay during a database outage.
        const task = tail.then(async () => {
          const remaining = deadline - performance.now();
          if (remaining <= 0) { report('integration_audit_queue_expired'); return; }
          await options.append(attempt, remaining);
        }).catch(() => report('integration_audit_write_failed'));
        tail = task;
        pending.add(task); void task.finally(() => pending.delete(task));
      } catch { report('integration_audit_capture_failed'); }
    };
    res.once('finish', finish); res.once('close', finish); next();
  };
  return { middleware, drain: async () => { await Promise.all([...pending]); } };
}
function cursor(value: unknown): string {
  if (typeof value !== 'string' || !/^(0|[1-9]\d{0,19})$/.test(value) || BigInt(value) > 18446744073709551615n) throw new ApiError(400, 'VALIDATION_ERROR', 'cursor/id 必须是无符号十进制字符串');
  return value;
}
function integer(value: unknown, fallback: number, max: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value) || Number(value) > max) throw new ApiError(400, 'VALIDATION_ERROR', '分页参数无效');
  return Number(value);
}
function dateFilter(value: unknown): Date | null {
  if (value === undefined) return null;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/.test(value) || !Number.isFinite(Date.parse(value))) throw new ApiError(400, 'VALIDATION_ERROR', '时间必须是 UTC ISO 格式');
  const parsed = new Date(value);
  const canonical = value.includes('.') ? value : value.replace('Z', '.000Z');
  if (parsed.getUTCFullYear() < 1000 || parsed.toISOString() !== canonical) throw new ApiError(400, 'VALIDATION_ERROR', '时间日期无效');
  return parsed;
}
type LogRow = RowDataPacket & {
  id: string; occurred_at: Date; completed_at: Date; request_id: string; client_id: string | null; client_name: string | null;
  operation: string; method: string; endpoint: string; reference: string | null; related_reference?: string | null; http_status: number; duration_ms: number; error_code: string | null;
  request_summary?: Summary | string; response_summary?: Summary | string;
};
function record(row: LogRow) {
  return { id: row.id, occurredAt: row.occurred_at.toISOString(), completedAt: row.completed_at.toISOString(), requestId: row.request_id,
    clientId: row.client_id, clientName: row.client_name, operation: row.operation, method: row.method, endpoint: row.endpoint,
    reference: row.reference, relatedReference: row.related_reference ?? null, httpStatus: row.http_status, outcome: row.http_status < 400 ? 'success' as const : 'failure' as const,
    durationMs: row.duration_ms, errorCode: row.error_code };
}
const columns = `CAST(l.id AS CHAR) AS id, l.occurred_at, l.completed_at, l.request_id, l.client_id,
  c.display_name AS client_name, l.operation, l.method, l.endpoint, l.reference, l.related_reference, l.http_status, l.duration_ms, l.error_code`;
export function createIntegrationLogs({ mysql, auditMysql = mysql, auditDeadlineMs = 5000 }: { mysql: Pool; auditMysql?: Pool; auditDeadlineMs?: number }) {
  async function notifications(userId: string) {
    // Single statement snapshot: MAX cannot overtake a lower uncommitted ID.
    const [rows] = await mysql.execute<(RowDataPacket & { cursor: string; readCursor: string; unreadCount: number })[]>(
      `SELECT CAST(COALESCE(MAX(l.id), 0) AS CHAR) AS \`cursor\`,
         CAST(COALESCE((SELECT read_cursor FROM integration_push_log_reads WHERE user_id = ?), 0) AS CHAR) AS readCursor,
         COALESCE(SUM(l.id > COALESCE((SELECT read_cursor FROM integration_push_log_reads WHERE user_id = ?), 0)), 0) AS unreadCount
       FROM integration_push_logs l`, [userId, userId]);
    const result = { cursor: rows[0].cursor, readCursor: rows[0].readCursor, unreadCount: Number(rows[0].unreadCount) };
    await mysql.execute(`INSERT INTO integration_push_log_reads (user_id, observed_cursor, read_cursor) VALUES (?, ?, 0)
      ON DUPLICATE KEY UPDATE observed_cursor = GREATEST(observed_cursor, VALUES(observed_cursor))`, [userId, result.cursor]);
    return result;
  }
  return {
    async append(attempt: IntegrationAttempt, remainingMs = auditDeadlineMs): Promise<void> {
      // Fresh connection after business response. The allocator lock stays held
      // through commit, including the INSERT; rollback cannot publish a gap.
      let connection: PoolConnection | undefined;
      let expired = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const deadlineError = new Error('Integration audit deadline exceeded');
      const checkDeadline = () => { if (expired) throw deadlineError; };
      const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => { expired = true; connection?.destroy(); reject(deadlineError); }, Math.max(1, Math.min(auditDeadlineMs, remainingMs)));
      });
      const write = (async () => {
        const acquired = await auditMysql.getConnection();
        // A timed-out acquisition can arrive after Promise.race has returned.
        // Destroy it immediately: it must not start a late transaction.
        if (expired) { acquired.destroy(); throw deadlineError; }
        connection = acquired;
        try {
          await connection.beginTransaction();
          checkDeadline();
          const [allocation] = await connection.execute<ResultSetHeader>({ sql: `UPDATE integration_push_log_sequence SET last_id = last_id + 1 WHERE singleton = 1`, timeout: 5000 });
          if (allocation.affectedRows !== 1) throw new Error('Integration audit allocator unavailable');
          checkDeadline();
          const [insertion] = await connection.execute<ResultSetHeader>({ sql: `INSERT INTO integration_push_logs
            (id, occurred_at, completed_at, request_id, client_id, operation, method, endpoint, reference, related_reference, http_status, duration_ms, error_code, request_summary, response_summary)
            SELECT last_id, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? FROM integration_push_log_sequence WHERE singleton = 1`, timeout: 5000 },
            [attempt.occurredAt, attempt.completedAt, attempt.requestId, attempt.clientId, attempt.operation, attempt.method, attempt.endpoint,
              attempt.reference, attempt.relatedReference ?? null, attempt.httpStatus, attempt.durationMs, attempt.errorCode, JSON.stringify(attempt.requestSummary), JSON.stringify(attempt.responseSummary)]);
          if (insertion.affectedRows !== 1) throw new Error('Integration audit insert unavailable');
          checkDeadline();
          await connection.commit();
          checkDeadline();
        } catch (error) {
          // Never return an uncertain transaction to the pool. A COMMIT timeout
          // may have committed on the server, so do not automatically retry.
          connection.destroy(); throw error;
        } finally { connection.release(); }
      })();
      try { await Promise.race([write, timeout]); }
      finally { if (timer) clearTimeout(timer); }
    },
    notifications,
    async markRead(userId: string, input: unknown) {
      const requested = cursor(input);
      await mysql.execute(`UPDATE integration_push_log_reads
        SET read_cursor = GREATEST(read_cursor, LEAST(CAST(? AS UNSIGNED), observed_cursor)) WHERE user_id = ?`, [requested, userId]);
      const [rows] = await mysql.execute<(RowDataPacket & { readCursor: string })[]>(`SELECT CAST(read_cursor AS CHAR) AS readCursor FROM integration_push_log_reads WHERE user_id = ?`, [userId]);
      return { readCursor: rows[0]?.readCursor ?? '0' };
    },
    async list(userId: string, query: Record<string, unknown>) {
      const page = integer(query.page, 1, 10000); const pageSize = integer(query.pageSize, 20, 100);
      const where = ['l.id <= ?']; const values: (string | Date)[] = [];
      if (query.clientId !== undefined) {
        if (query.clientId === 'unknown') where.push('l.client_id IS NULL');
        else if (typeof query.clientId === 'string' && /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(query.clientId)) { where.push('l.client_id = ?'); values.push(query.clientId); }
        else throw new ApiError(400, 'VALIDATION_ERROR', 'clientId 无效');
      }
      if (query.operation !== undefined) {
        if (typeof query.operation !== 'string' || !operations.includes(query.operation)) throw new ApiError(400, 'VALIDATION_ERROR', 'operation 无效');
        where.push('l.operation = ?'); values.push(query.operation);
      }
      if (query.status !== undefined) {
        if (typeof query.status !== 'string' || !['success', 'failure'].includes(query.status)) throw new ApiError(400, 'VALIDATION_ERROR', 'status 无效');
        where.push(query.status === 'success' ? 'l.http_status < 400' : 'l.http_status >= 400');
      }
      const from = dateFilter(query.from); const to = dateFilter(query.to);
      if (from && to && from > to) throw new ApiError(400, 'VALIDATION_ERROR', '时间范围无效');
      if (from) { where.push('l.occurred_at >= ?'); values.push(from); }
      if (to) { where.push('l.occurred_at <= ?'); values.push(to); }
      if (query.search !== undefined) {
        if (typeof query.search !== 'string' || query.search.length > 128) throw new ApiError(400, 'VALIDATION_ERROR', 'search 过长');
        where.push("(l.request_id LIKE ? ESCAPE '!' OR l.reference LIKE ? ESCAPE '!' OR l.related_reference LIKE ? ESCAPE '!' OR JSON_UNQUOTE(JSON_EXTRACT(l.request_summary, '$.airWaybillNo')) LIKE ? ESCAPE '!')");
        const search = `%${query.search.replace(/[!%_]/g, '!$&')}%`; values.push(search, search, search, search);
      }
      const snapshot = await notifications(userId); values.unshift(snapshot.cursor);
      const clause = where.join(' AND ');
      const [counts] = await mysql.execute<(RowDataPacket & { total: number; success: number; failure: number })[]>(
        `SELECT COUNT(*) AS total, COALESCE(SUM(l.http_status < 400), 0) AS success, COALESCE(SUM(l.http_status >= 400), 0) AS failure
         FROM integration_push_logs l WHERE ${clause}`, values);
      const [rows] = await mysql.execute<LogRow[]>(`SELECT ${columns} FROM integration_push_logs l LEFT JOIN clients c ON c.id = l.client_id
        WHERE ${clause} ORDER BY l.id DESC LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`, values);
      const [clients] = await mysql.execute<(RowDataPacket & { id: string; name: string; code: string })[]>(`SELECT id, display_name AS name, client_code AS code FROM clients ORDER BY display_name, id LIMIT 1000`);
      const metrics = { total: Number(counts[0].total), success: Number(counts[0].success), failure: Number(counts[0].failure) };
      return { records: rows.map(record), total: metrics.total, page, pageSize, cursor: snapshot.cursor, metrics, clients };
    },
    async detail(input: unknown) {
      const id = cursor(input);
      const [rows] = await mysql.execute<LogRow[]>(`SELECT ${columns}, l.request_summary, l.response_summary
        FROM integration_push_logs l LEFT JOIN clients c ON c.id = l.client_id WHERE l.id = ? LIMIT 1`, [id]);
      if (!rows[0]) throw new ApiError(404, 'INTEGRATION_LOG_NOT_FOUND', '推送记录不存在');
      const row = rows[0];
      return { ...record(row), requestSummary: typeof row.request_summary === 'string' ? JSON.parse(row.request_summary) : row.request_summary,
        responseSummary: typeof row.response_summary === 'string' ? JSON.parse(row.response_summary) : row.response_summary };
    },
  };
}
export function createIntegrationLogsRouter(logs: ReturnType<typeof createIntegrationLogs>): Router {
  const router = Router(); router.use(requireWarehousePermission('integration_logs.view'));
  router.get('/', async (req, res) => { res.json({ data: await logs.list(req.warehouseSession!.userId, req.query), requestId: req.requestId }); });
  router.get('/notifications', async (req, res) => { res.json({ data: await logs.notifications(req.warehouseSession!.userId), requestId: req.requestId }); });
  router.post('/read', async (req, res) => { res.json({ data: await logs.markRead(req.warehouseSession!.userId, req.body?.cursor), requestId: req.requestId }); });
  router.get('/:id', async (req, res) => { res.json({ data: await logs.detail(req.params.id), requestId: req.requestId }); });
  return router;
}
