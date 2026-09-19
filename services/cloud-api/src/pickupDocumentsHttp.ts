import { Router, type RequestHandler, type Request, type Response, type NextFunction } from 'express';
import { ApiError, normalizeApiError } from './errors.js';
import { createDocumentReceiveSlots, receiveDocumentBytes, type createPickupDocuments, type DocumentLease, type DocumentUploadView } from './pickupDocuments.js';

export function documentContentDisposition(filename: string, disposition: 'inline' | 'attachment') {
  const fallback = filename.replace(/[^\x20-\x7e]|["\\;\r\n]/g, '_').slice(0, 180) || 'document';
  const encoded = encodeURIComponent(filename).replace(/['()*]/g, character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${disposition}; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}
export function createPickupDocumentsRouter(input: { documents: ReturnType<typeof createPickupDocuments>; authenticate: RequestHandler; receiveSlots?: number }) {
  const router = Router(), service = input.documents, slots = createDocumentReceiveSlots(input.receiveSlots ?? 4);
  const wrapper = (handler: (req: Request, res: Response) => Promise<void>): RequestHandler => async (req, res, next) => {
    res.setHeader('Cache-Control', 'private, no-store'); res.setHeader('X-Content-Type-Options', 'nosniff');
    try { await handler(req, res); } catch (error) { next(error); }
  };
  const reply = (req: Request, res: Response, data: unknown, status = 200) => { res.status(status).json({ data, requestId: req.requestId }); };
  const param = (req: Request, name: string) => String(req.params[name]);
  const status = (view: DocumentUploadView) => view.status === 'PROCESSING' ? 202 : view.status === 'COMPLETED' && !view.replayed && !view.deduplicated ? 201 : 200;
  router.get('/air-pickup-document-policy', input.authenticate, wrapper(async (req, res) => { reply(req, res, service.policy(req.warehouseSession!)); }));
  router.get('/air-pickups/:orderId/documents', input.authenticate, wrapper(async (req, res) => {
    if (req.query.includeHistory !== undefined && !['true', 'false'].includes(String(req.query.includeHistory))) throw new ApiError(400, 'DOCUMENT_INVALID_REQUEST', '历史参数无效。');
    reply(req, res, await service.list(req.warehouseSession!, param(req, 'orderId'), { includeHistory: req.query.includeHistory === 'true',
      cursor: req.query.cursor === undefined ? undefined : String(req.query.cursor), limit: req.query.limit === undefined ? undefined : Number(req.query.limit) }));
  }));
  router.post('/air-pickups/:orderId/document-uploads', input.authenticate, wrapper(async (req, res) => {
    const result = await service.register(req.warehouseSession!, param(req, 'orderId'), req.body ?? {});
    reply(req, res, result, result.replayed ? 200 : 201);
  }));
  router.get('/air-pickups/:orderId/document-uploads/:uploadId', input.authenticate, wrapper(async (req, res) => {
    reply(req, res, await service.get(req.warehouseSession!, param(req, 'orderId'), param(req, 'uploadId')));
  }));
  router.put('/air-pickups/:orderId/document-uploads/:uploadId/content', input.authenticate, wrapper(async (req, res) => {
    const session = req.warehouseSession!, orderId = param(req, 'orderId'), uploadId = param(req, 'uploadId');
    // Ownership, current access and replay before accepting the raw request stream or taking a slot.
    const previous = await service.get(session, orderId, uploadId);
    const attempt = Number(req.header('x-upload-attempt'));
    const retry = req.header('x-retry-of-attempt') === undefined ? undefined : Number(req.header('x-retry-of-attempt'));
    if (previous.status === 'COMPLETED') { const result = await service.acquire(session, orderId, uploadId, attempt, retry); reply(req, res, result.view, status(result.view)); return; }
    if (req.header('content-type')?.split(';')[0].trim() !== 'application/octet-stream' || (req.header('content-encoding') && req.header('content-encoding') !== 'identity')) throw new ApiError(415, 'DOCUMENT_CONTENT_TYPE_REQUIRED', '请发送未压缩的application/octet-stream原件。');
    const release = slots.acquire(); let lease: DocumentLease | null = null, receiving = false;
    try {
      const claim = await service.acquire(session, orderId, uploadId, attempt, retry); lease = claim.lease;
      if (!lease) { reply(req, res, claim.view, status(claim.view)); return; }
      const length = req.header('content-length');
      if (length !== undefined && (!/^\d+$/.test(length) || Number(length) !== lease.upload.byteSize)) throw new ApiError(422, 'DOCUMENT_LENGTH_MISMATCH', 'Content-Length与声明不一致。');
      receiving = true;
      const bytes = await receiveDocumentBytes(req, lease.upload.byteSize);
      receiving = false;
      const result = await service.save(session, lease, bytes, { requestId: req.requestId, ip: req.ip ?? '' });
      reply(req, res, result, status(result));
    } catch (error) {
      // save owns commit uncertainty; only a pre-save failure can be marked definitely not saved here.
      if (lease && (receiving || error instanceof ApiError && error.code === 'DOCUMENT_LENGTH_MISMATCH')) await service.fail(lease, error);
      throw error;
    } finally { release(); }
  }));
  router.get('/air-pickups/:orderId/documents/:assetId/content', input.authenticate, wrapper(async (req, res) => {
    if (Object.keys(req.query).some(key => !['variant', 'disposition'].includes(key))) throw new ApiError(400, 'DOCUMENT_INVALID_REQUEST', '内容入口只接受原件标识和预览参数。');
    const variant = String(req.query.variant ?? 'preview'), disposition = String(req.query.disposition ?? 'inline');
    const result = await service.open(req.warehouseSession!, param(req, 'orderId'), param(req, 'assetId'), variant, disposition);
    res.setHeader('Content-Type', result.metadata.contentType);
    res.setHeader('Content-Length', result.object.byteSize);
    res.setHeader('Content-Disposition', documentContentDisposition(result.metadata.filename, disposition as 'inline' | 'attachment'));
    // Full 200, deliberately no Accept-Ranges or partial-content claim.
    res.status(200);
    result.object.stream.once('error', () => { if (!res.headersSent) { res.removeHeader('Content-Length'); res.status(503).json({ error: { code: 'DOCUMENT_STORAGE_UNAVAILABLE', message: '原件暂时不可读取。', requestId: req.requestId } }); } else res.destroy(); });
    res.once('close', () => result.object.stream.destroy());
    result.object.stream.pipe(res);
  }));
  router.post('/air-pickups/:orderId/documents/:assetId/removals', input.authenticate, wrapper(async (req, res) => {
    reply(req, res, await service.remove(req.warehouseSession!, param(req, 'orderId'), param(req, 'assetId'), req.body ?? {}, { requestId: req.requestId, ip: req.ip ?? '' }));
  }));
  router.use((caught: unknown, req: Request, res: Response, _next: NextFunction) => {
    const error = normalizeApiError(caught);
    res.setHeader('Cache-Control', 'private, no-store'); res.setHeader('X-Content-Type-Options', 'nosniff');
    if (error.status === 429) res.setHeader('Retry-After', '2');
    res.status(error.status).json({ error: { code: error.code, message: error.message, requestId: req.requestId, ...error.operation } });
  });
  return router;
}
