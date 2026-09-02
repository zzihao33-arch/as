import { randomUUID } from 'node:crypto';
import express, { type NextFunction, type Request, type Response } from 'express';
import { config } from './config.js';
import { requireApiKey, requireScope } from './auth.js';
import { closeConnections, mysql, redis } from './db.js';
import { ApiError, normalizeApiError } from './errors.js';
import { createLabelAssetModule } from './labelAssets.js';
import { validateLabelPdf } from './labelPdf.js';
import { createCosLabelStorage, createFilesystemLabelStorage } from './labelStorage.js';
import { createShipmentIngestor } from './shipmentIngest.js';
import { createInboundBatchIngestor } from './inboundBatchIngest.js';
import { createSharedWarehouseWork } from './sharedWarehouseWork.js';
import { createAirPickupOperations } from './airPickupOperations.js';
import { createAttendanceOperations } from './attendanceOperations.js';
import { createOutboundWebhooks } from './outboundWebhooks.js';
import { toShipment, type ShipmentRow } from './shipmentRecord.js';
import { createWarehouseAdministration } from './warehouseAdministration.js';
import { requireWarehouseAnyPermission, requireWarehousePermission, requireWarehouseWorkspace } from './warehouseAccess.js';
import { createWarehouseIdentity } from './warehouseIdentity.js';
import { createWarehouseHttpBoundary } from './warehouseHttp.js';
import { createWarehouseOperations } from './warehouseOperations.js';

const app = express();

app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use((req, res, next) => {
  const requestedId = req.header('x-request-id')?.trim();
  req.requestId = requestedId && /^[a-zA-Z0-9_-]{8,64}$/.test(requestedId) ? requestedId : randomUUID();
  res.setHeader('X-Request-ID', req.requestId);
  next();
});

const jsonBodyParser = express.json({ limit: config.jsonLimit });
const inboundBatchBodyParser = express.json({ limit: config.inboundBatchJsonLimit });
app.use((req, res, next) => {
  if (req.method === 'POST' && req.path === '/api/v1/inbound-batches') return next();
  return jsonBodyParser(req, res, next);
});

function text(value: unknown, field: string, maxLength = 128, required = false): string | undefined {
  if (value === undefined || value === null || value === '') {
    if (required) throw new ApiError(400, 'VALIDATION_ERROR', `${field} 为必填项。`);
    return undefined;
  }
  if (typeof value !== 'string') throw new ApiError(400, 'VALIDATION_ERROR', `${field} 必须是字符串。`);
  const result = value.trim();
  if (!result || result.length > maxLength) {
    throw new ApiError(400, 'VALIDATION_ERROR', `${field} 长度无效。`);
  }
  return result;
}

const shipmentIngestor = createShipmentIngestor({ mysql, redis });
const inboundBatchIngestor = createInboundBatchIngestor({ mysql, redis });
const labelStorage = config.labelStorage.backend === 'cos'
  ? createCosLabelStorage(config.labelStorage)
  : createFilesystemLabelStorage(config.labelStorage.root);
const labelAssets = createLabelAssetModule({
  mysql,
  storage: labelStorage,
});
const warehouseIdentity = createWarehouseIdentity({
  mysql,
  redis,
  sessionLifetimeHours: config.warehouse.sessionLifetimeHours,
});
const warehouseAdministration = createWarehouseAdministration({ mysql });
const outboundWebhooks = createOutboundWebhooks({
  mysql,
  options: {
    ...config.outboundWebhooks,
    environment: config.environment,
  },
});
const warehouseOperations = createWarehouseOperations({ mysql, storage: labelStorage, outboundWebhooks });
const sharedWarehouseWork = createSharedWarehouseWork({ mysql, storage: labelStorage });
const airPickupOperations = createAirPickupOperations({ mysql, storage: labelStorage });
const attendanceOperations = createAttendanceOperations({ mysql, storage: labelStorage });
const warehouseBoundary = createWarehouseHttpBoundary({
  identity: warehouseIdentity,
  allowedOrigins: new Set(config.warehouse.allowedOrigins),
  cookieName: config.warehouse.cookieName,
});
const pdfBodyParser = express.raw({ type: 'application/pdf', limit: config.labelPdfLimit });
const evidenceBodyParser = express.raw({ type: ['image/jpeg', 'image/png'], limit: '10mb' });
const attendancePhotoBodyParser = express.raw({ type: ['image/jpeg', 'image/png'], limit: '1mb' });

app.get('/healthz', async (_req, res, next) => {
  try {
    await mysql.query('SELECT 1');
    await redis.ping();
    await labelStorage.healthCheck();
    res.json({ ok: true, outboundWebhooks: { enabled: config.outboundWebhooks.enabled } });
  } catch (error) {
    next(new ApiError(503, 'DEPENDENCY_UNAVAILABLE', '数据库或缓存暂时不可用。'));
  }
});

const upstreamRouter = express.Router();

upstreamRouter.post('/shipments', requireScope('shipments:write'), async (req, res, next) => {
  try {
    const result = await shipmentIngestor.ingest({
      client: req.client!,
      requestId: req.requestId,
      idempotencyKey: req.header('idempotency-key'),
      body: req.body,
    });
    res.status(result.status).json(result.body);
  } catch (error) {
    next(error);
  }
});

upstreamRouter.post('/inbound-batches', requireScope('shipments:write'), inboundBatchBodyParser, async (req, res, next) => {
  try {
    const result = await inboundBatchIngestor.ingest({
      client: req.client!,
      requestId: req.requestId,
      idempotencyKey: req.header('idempotency-key'),
      ip: req.ip || req.socket.remoteAddress || 'unknown',
      body: req.body,
    });
    res.status(result.status).json(result.body);
  } catch (error) {
    next(error);
  }
});

upstreamRouter.put(
  '/shipments/by-first-leg/:firstLegTrackingNo/label',
  requireScope('labels:write'),
  pdfBodyParser,
  async (req, res, next) => {
    try {
      if (!req.is('application/pdf')) {
        throw new ApiError(415, 'UNSUPPORTED_MEDIA_TYPE', '面单上传必须使用 Content-Type: application/pdf。');
      }
      const firstLegTrackingNo = text(req.params.firstLegTrackingNo, 'firstLegTrackingNo', 128, true)!;
      const pdf = validateLabelPdf(req.body, req.header('x-label-sha256'));
      const asset = await labelAssets.storePushedPdf({
        client: req.client!,
        requestId: req.requestId,
        firstLegTrackingNo,
        pdf,
      });
      res.status(200).json({ data: asset, requestId: req.requestId });
    } catch (error) {
      next(error);
    }
  },
);

upstreamRouter.get('/shipments/by-first-leg/:firstLegTrackingNo', requireScope('shipments:read'), async (req, res, next) => {
  try {
    const firstLegTrackingNo = text(req.params.firstLegTrackingNo, 'firstLegTrackingNo', 128, true)!;
    const [rows] = await mysql.execute<ShipmentRow[]>(
      `SELECT * FROM shipments WHERE client_id = ? AND first_leg_tracking_no = ? LIMIT 1`,
      [req.client!.id, firstLegTrackingNo],
    );
    if (!rows[0]) throw new ApiError(404, 'SHIPMENT_NOT_FOUND', '未找到对应物流单据。');
    res.json({ data: toShipment(rows[0]), requestId: req.requestId });
  } catch (error) {
    next(error);
  }
});

// The entire public upstream namespace is API-key protected, including unknown
// future paths. Warehouse browser routes use their separate secure session.
app.use('/api', requireApiKey);
app.use('/api/v1', upstreamRouter);

const warehouseRouter = express.Router();
warehouseRouter.use(warehouseBoundary.origin);

function warehouseAudit(req: Request) {
  return {
    requestId: req.requestId,
    ip: req.ip || req.socket.remoteAddress || 'unknown',
    userAgent: req.header('user-agent'),
  };
}

function setWarehouseSessionCookie(res: Response, token: string): void {
  res.cookie(config.warehouse.cookieName, token, {
    httpOnly: true,
    secure: config.environment === 'production',
    sameSite: 'strict',
    path: '/warehouse/v1',
    maxAge: config.warehouse.sessionLifetimeHours * 60 * 60 * 1000,
  });
}

warehouseRouter.post('/sessions', async (req, res, next) => {
  try {
    const result = await warehouseIdentity.login({
      loginName: req.body?.loginName,
      password: req.body?.password,
      requestId: req.requestId,
      ip: req.ip || req.socket.remoteAddress || 'unknown',
      userAgent: req.header('user-agent'),
    });
    setWarehouseSessionCookie(res, result.token);
    res.status(201).json({ data: result.session, requestId: req.requestId });
  } catch (error) {
    next(error);
  }
});

warehouseRouter.get('/session', warehouseBoundary.session, (req, res) => {
  res.json({ data: req.warehouseSession, requestId: req.requestId });
});

warehouseRouter.post('/session/renew', warehouseBoundary.session, async (req, res, next) => {
  try {
    const result = await warehouseIdentity.renew(req.warehouseSession!, warehouseAudit(req));
    setWarehouseSessionCookie(res, result.token);
    res.json({ data: result.session, requestId: req.requestId });
  } catch (error) {
    next(error);
  }
});

warehouseRouter.patch('/session/workspace', warehouseBoundary.session, async (req, res, next) => {
  try {
    const session = await warehouseIdentity.selectWorkspace(
      req.warehouseSession!, req.body?.warehouseId, warehouseAudit(req),
    );
    res.json({ data: session, requestId: req.requestId });
  } catch (error) {
    next(error);
  }
});

warehouseRouter.post('/session/password', warehouseBoundary.session, async (req, res, next) => {
  try {
    await warehouseIdentity.changePassword(req.warehouseSession!, {
      currentPassword: req.body?.currentPassword,
      newPassword: req.body?.newPassword,
    }, warehouseAudit(req));
    res.status(204).end();
  } catch (error) {
    next(error);
  }
});

warehouseRouter.delete('/session', warehouseBoundary.session, async (req, res, next) => {
  try {
    await warehouseIdentity.logout(req.warehouseSession!, warehouseAudit(req));
    res.clearCookie(config.warehouse.cookieName, {
      httpOnly: true,
      secure: config.environment === 'production',
      sameSite: 'strict',
      path: '/warehouse/v1',
    });
    res.status(204).end();
  } catch (error) {
    next(error);
  }
});

warehouseRouter.post('/workstations', warehouseBoundary.session, requireWarehouseAnyPermission(['scan.use', 'attendance.punch']), requireWarehouseWorkspace, async (req, res, next) => {
  try {
    const workstation = await warehouseIdentity.registerWorkstation(req.warehouseSession!, {
      installationId: req.body?.installationId,
      displayName: req.body?.displayName,
    });
    res.status(200).json({ data: workstation, requestId: req.requestId });
  } catch (error) {
    next(error);
  }
});

warehouseRouter.get('/accounts', warehouseBoundary.session, requireWarehousePermission('accounts.view'), async (req, res, next) => {
  try {
    const result = await warehouseAdministration.listAccounts({
      search: req.query.search,
      status: req.query.status,
      roleId: req.query.roleId,
      page: req.query.page,
      pageSize: req.query.pageSize,
    });
    res.json({ data: result.accounts, pagination: { total: result.total, page: result.page, pageSize: result.pageSize }, requestId: req.requestId });
  } catch (error) {
    next(error);
  }
});

warehouseRouter.post('/accounts', warehouseBoundary.session, requireWarehousePermission('accounts.manage'), async (req, res, next) => {
  try {
    const account = await warehouseAdministration.createAccount(req.warehouseSession!, warehouseAudit(req), req.body ?? {});
    res.status(201).json({ data: account, requestId: req.requestId });
  } catch (error) {
    next(error);
  }
});

warehouseRouter.patch('/accounts/:accountId', warehouseBoundary.session, requireWarehousePermission('accounts.manage'), async (req, res, next) => {
  try {
    const account = await warehouseAdministration.updateAccount(
      req.warehouseSession!, warehouseAudit(req), req.params.accountId, req.body ?? {},
    );
    res.json({ data: account, requestId: req.requestId });
  } catch (error) {
    next(error);
  }
});

warehouseRouter.put('/accounts/:accountId/role', warehouseBoundary.session, requireWarehousePermission('accounts.manage'), async (req, res, next) => {
  try {
    const account = await warehouseAdministration.assignRole(
      req.warehouseSession!, warehouseAudit(req), req.params.accountId, req.body ?? {},
    );
    res.json({ data: account, requestId: req.requestId });
  } catch (error) {
    next(error);
  }
});

warehouseRouter.post('/accounts/:accountId/reset-password', warehouseBoundary.session, requireWarehousePermission('accounts.reset_password'), async (req, res, next) => {
  try {
    const account = await warehouseAdministration.resetPassword(
      req.warehouseSession!, warehouseAudit(req), req.params.accountId,
    );
    res.json({ data: account, requestId: req.requestId });
  } catch (error) {
    next(error);
  }
});

warehouseRouter.delete('/accounts/:accountId', warehouseBoundary.session, requireWarehousePermission('accounts.manage'), async (req, res, next) => {
  try {
    await warehouseAdministration.deleteAccount(req.warehouseSession!, warehouseAudit(req), req.params.accountId);
    res.status(204).end();
  } catch (error) {
    next(error);
  }
});

warehouseRouter.post('/login-locks/:loginName/unlock', warehouseBoundary.session, requireWarehousePermission('accounts.manage'), async (req, res, next) => {
  try {
    await warehouseIdentity.unlockLogin(
      req.params.loginName, req.warehouseSession!, warehouseAudit(req),
    );
    res.status(204).end();
  } catch (error) {
    next(error);
  }
});

warehouseRouter.get('/permissions', warehouseBoundary.session, requireWarehousePermission('roles.view'), async (req, res, next) => {
  try {
    res.json({ data: await warehouseAdministration.listPermissions(), requestId: req.requestId });
  } catch (error) {
    next(error);
  }
});

warehouseRouter.get('/roles', warehouseBoundary.session, requireWarehousePermission('roles.view'), async (req, res, next) => {
  try {
    res.json({ data: await warehouseAdministration.listRoles(), requestId: req.requestId });
  } catch (error) {
    next(error);
  }
});

warehouseRouter.post('/roles', warehouseBoundary.session, requireWarehousePermission('roles.manage'), async (req, res, next) => {
  try {
    const role = await warehouseAdministration.createRole(req.warehouseSession!, warehouseAudit(req), req.body ?? {});
    res.status(201).json({ data: role, requestId: req.requestId });
  } catch (error) {
    next(error);
  }
});

warehouseRouter.patch('/roles/:roleId', warehouseBoundary.session, requireWarehousePermission('roles.manage'), async (req, res, next) => {
  try {
    const role = await warehouseAdministration.updateRole(
      req.warehouseSession!, warehouseAudit(req), req.params.roleId, req.body ?? {},
    );
    res.json({ data: role, requestId: req.requestId });
  } catch (error) {
    next(error);
  }
});

warehouseRouter.delete('/roles/:roleId', warehouseBoundary.session, requireWarehousePermission('roles.manage'), async (req, res, next) => {
  try {
    await warehouseAdministration.deleteRole(req.warehouseSession!, warehouseAudit(req), req.params.roleId);
    res.status(204).end();
  } catch (error) {
    next(error);
  }
});

warehouseRouter.get('/security-audit', warehouseBoundary.session, requireWarehousePermission('security_audit.view'), async (req, res, next) => {
  try {
    res.json({ data: await warehouseAdministration.listSecurityAudit({ limit: req.query.limit }), requestId: req.requestId });
  } catch (error) {
    next(error);
  }
});

warehouseRouter.get('/work-batches', warehouseBoundary.session, requireWarehousePermission('batches.view'), async (req, res, next) => {
  try {
    res.json({ data: await sharedWarehouseWork.listBatches({ status: req.query.status, limit: req.query.limit }), requestId: req.requestId });
  } catch (error) {
    next(error);
  }
});

warehouseRouter.post('/work-batches', warehouseBoundary.session, requireWarehousePermission('batches.create'), async (req, res, next) => {
  try {
    const batch = await sharedWarehouseWork.createBatch(req.warehouseSession!, { name: req.body?.name });
    res.status(201).json({ data: batch, requestId: req.requestId });
  } catch (error) {
    next(error);
  }
});

warehouseRouter.get('/work-batches/:batchId/items', warehouseBoundary.session, requireWarehousePermission('batches.view'), async (req, res, next) => {
  try {
    const items = await sharedWarehouseWork.listItems(req.params.batchId, { offset: req.query.offset, limit: req.query.limit });
    res.json({ data: items, requestId: req.requestId });
  } catch (error) {
    next(error);
  }
});

warehouseRouter.post('/work-batches/:batchId/items', warehouseBoundary.session, requireWarehousePermission('batches.create'), async (req, res, next) => {
  try {
    const result = await sharedWarehouseWork.upsertItems(req.warehouseSession!, req.params.batchId, { items: req.body?.items });
    res.json({ data: result, requestId: req.requestId });
  } catch (error) {
    next(error);
  }
});

warehouseRouter.put(
  '/work-batches/:batchId/items/by-first-leg/:firstLegTrackingNo/label',
  warehouseBoundary.session,
  requireWarehousePermission('batches.create'),
  pdfBodyParser,
  async (req, res, next) => {
    try {
      if (!req.is('application/pdf')) throw new ApiError(415, 'UNSUPPORTED_MEDIA_TYPE', '面单上传必须使用 Content-Type: application/pdf。');
      const pdf = validateLabelPdf(req.body, req.header('x-label-sha256'));
      const asset = await sharedWarehouseWork.storeItemLabel(
        req.warehouseSession!, req.params.batchId, req.params.firstLegTrackingNo, req.query.filename, pdf,
      );
      res.json({ data: asset, requestId: req.requestId });
    } catch (error) {
      next(error);
    }
  },
);

warehouseRouter.post('/work-batches/:batchId/publish', warehouseBoundary.session, requireWarehousePermission('batches.publish'), async (req, res, next) => {
  try {
    const batch = await sharedWarehouseWork.publishBatch(req.warehouseSession!, req.params.batchId);
    res.json({ data: batch, requestId: req.requestId });
  } catch (error) {
    next(error);
  }
});

warehouseRouter.post('/work-batches/:batchId/close', warehouseBoundary.session, requireWarehousePermission('batches.close'), async (req, res, next) => {
  try {
    const batch = await sharedWarehouseWork.closeBatch(req.warehouseSession!, req.params.batchId);
    res.json({ data: batch, requestId: req.requestId });
  } catch (error) {
    next(error);
  }
});

warehouseRouter.delete('/work-batches/:batchId', warehouseBoundary.session, requireWarehousePermission('batches.delete'), async (req, res, next) => {
  try {
    const result = await sharedWarehouseWork.deleteBatch(req.warehouseSession!, req.params.batchId);
    res.json({ data: result, requestId: req.requestId });
  } catch (error) {
    next(error);
  }
});

warehouseRouter.post('/work-batch-claims', warehouseBoundary.session, requireWarehousePermission('scan.use'), requireWarehouseWorkspace, async (req, res, next) => {
  try {
    const claim = await sharedWarehouseWork.claimItem(req.warehouseSession!, {
      trackingNo: req.body?.trackingNo,
      workstationId: req.body?.workstationId,
    });
    res.json({ data: claim, requestId: req.requestId });
  } catch (error) {
    next(error);
  }
});

warehouseRouter.post('/work-batch-items/:itemId/complete', warehouseBoundary.session, requireWarehousePermission('print.submit'), requireWarehouseWorkspace, async (req, res, next) => {
  try {
    const attempt = await sharedWarehouseWork.completeItem(req.warehouseSession!, req.params.itemId, req.body ?? {});
    res.status(attempt.replayed ? 200 : 201).json({ data: attempt, requestId: req.requestId });
  } catch (error) {
    next(error);
  }
});

warehouseRouter.get('/shared-label-assets/:assetId/content', warehouseBoundary.session, requireWarehousePermission('scan.use'), requireWarehouseWorkspace, async (req, res, next) => {
  try {
    const result = await sharedWarehouseWork.openAsset(req.params.assetId);
    res.setHeader('Content-Type', result.metadata.content_type);
    res.setHeader('Content-Length', String(result.object.byteSize));
    res.setHeader('Content-Disposition', `attachment; filename="${result.metadata.id}.pdf"`);
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('ETag', `"sha256-${result.metadata.content_sha256}"`);
    result.object.stream.on('error', next).pipe(res);
  } catch (error) {
    next(error);
  }
});

warehouseRouter.get('/intercepts', warehouseBoundary.session, requireWarehousePermission('intercepts.view'), async (req, res, next) => {
  try {
    const result = await sharedWarehouseWork.listIntercepts({ cursor: req.query.cursor, limit: req.query.limit });
    res.json({ data: result.entries, cursor: result.cursor, hasMore: result.hasMore, requestId: req.requestId });
  } catch (error) {
    next(error);
  }
});

warehouseRouter.post('/intercepts/check', warehouseBoundary.session, requireWarehousePermission('intercepts.view'), async (req, res, next) => {
  try {
    const result = await sharedWarehouseWork.checkIntercepts({ trackingNumbers: req.body?.trackingNumbers });
    res.json({ data: result, requestId: req.requestId });
  } catch (error) {
    next(error);
  }
});

warehouseRouter.post('/intercepts', warehouseBoundary.session, requireWarehousePermission('intercepts.manage'), async (req, res, next) => {
  try {
    const result = await sharedWarehouseWork.upsertIntercepts(req.warehouseSession!, {
      entries: req.body?.entries,
      source: req.body?.source,
    });
    res.status(201).json({ data: result, requestId: req.requestId });
  } catch (error) {
    next(error);
  }
});

warehouseRouter.delete('/intercepts/:trackingNo', warehouseBoundary.session, requireWarehousePermission('intercepts.manage'), async (req, res, next) => {
  try {
    await sharedWarehouseWork.removeIntercept(req.warehouseSession!, req.params.trackingNo);
    res.status(204).end();
  } catch (error) {
    next(error);
  }
});

warehouseRouter.get('/air-pickups', warehouseBoundary.session, requireWarehousePermission('air_pickups.view'), async (req, res, next) => {
  try {
    const result = await airPickupOperations.listOrders({
      search: req.query.search,
      status: req.query.status,
      evidenceStatus: req.query.evidenceStatus,
      page: req.query.page,
      pageSize: req.query.pageSize,
    });
    res.json({ data: result.orders, pagination: { total: result.total, page: result.page, pageSize: result.pageSize },
      summary: result.summary, requestId: req.requestId });
  } catch (error) { next(error); }
});

warehouseRouter.get('/air-pickup-clients', warehouseBoundary.session, requireWarehousePermission('air_pickups.create'), async (req, res, next) => {
  try {
    res.json({ data: await airPickupOperations.listClients(), requestId: req.requestId });
  } catch (error) { next(error); }
});

warehouseRouter.post('/air-pickups', warehouseBoundary.session, requireWarehousePermission('air_pickups.create'), async (req, res, next) => {
  try {
    const order = await airPickupOperations.createOrder(req.warehouseSession!, warehouseAudit(req), req.body ?? {});
    res.status(201).json({ data: order, requestId: req.requestId });
  } catch (error) { next(error); }
});

warehouseRouter.get('/air-pickups/:orderId', warehouseBoundary.session, requireWarehousePermission('air_pickups.view'), async (req, res, next) => {
  try {
    res.json({ data: await airPickupOperations.getOrder(req.params.orderId), requestId: req.requestId });
  } catch (error) { next(error); }
});

warehouseRouter.patch('/air-pickups/:orderId', warehouseBoundary.session, requireWarehousePermission('air_pickups.edit'), async (req, res, next) => {
  try {
    const order = await airPickupOperations.updateRecordedOrder(req.warehouseSession!, warehouseAudit(req), req.params.orderId, req.body ?? {});
    res.json({ data: order, requestId: req.requestId });
  } catch (error) { next(error); }
});

warehouseRouter.post('/air-pickup-receipt-batches', warehouseBoundary.session, requireWarehousePermission('air_pickups.receive'), async (req, res, next) => {
  try {
    const batch = await airPickupOperations.createReceiptBatch(req.warehouseSession!, warehouseAudit(req), req.body ?? {});
    res.status(201).json({ data: batch, requestId: req.requestId });
  } catch (error) { next(error); }
});

warehouseRouter.put(
  '/air-pickup-receipt-batches/:batchId/evidence',
  warehouseBoundary.session,
  requireWarehousePermission('air_pickups.receive'),
  evidenceBodyParser,
  async (req, res, next) => {
    try {
      if (!req.is('image/jpeg') && !req.is('image/png')) throw new ApiError(415, 'UNSUPPORTED_EVIDENCE_IMAGE', '仅支持 JPG、JPEG 或 PNG 图片。');
      const warningsHeader = req.header('x-image-quality-warnings');
      const asset = await airPickupOperations.storeReceiptEvidence(req.warehouseSession!, warehouseAudit(req), req.params.batchId, {
        filename: req.query.filename,
        qualityWarnings: warningsHeader ? warningsHeader.split(',').map(item => item.trim()).filter(Boolean) : [],
        qualityOverride: req.header('x-image-quality-override') === 'true',
        contentType: req.header('content-type'),
        sha256: req.header('x-image-sha256'),
        content: req.body,
      });
      res.status(201).json({ data: asset, requestId: req.requestId });
    } catch (error) { next(error); }
  },
);

warehouseRouter.get('/air-receipt-evidence-assets/:assetId/content', warehouseBoundary.session, requireWarehousePermission('air_pickups.view'), async (req, res, next) => {
  try {
    const result = await airPickupOperations.openReceiptEvidence(req.params.assetId);
    res.setHeader('Content-Type', result.metadata.content_type);
    res.setHeader('Content-Length', String(result.object.byteSize));
    res.setHeader('Content-Disposition', `inline; filename="${result.metadata.id}.${result.metadata.content_type === 'image/png' ? 'png' : 'jpg'}"`);
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    result.object.stream.on('error', next).pipe(res);
  } catch (error) { next(error); }
});

warehouseRouter.post('/air-handover-batches', warehouseBoundary.session, requireWarehousePermission('air_pickups.handover'), async (req, res, next) => {
  try {
    const batch = await airPickupOperations.createHandoverDraft(req.warehouseSession!, warehouseAudit(req), req.body ?? {});
    res.status(201).json({ data: batch, requestId: req.requestId });
  } catch (error) { next(error); }
});

warehouseRouter.get('/air-handover-batches/:batchId', warehouseBoundary.session, requireWarehousePermission('air_pickups.view'), async (req, res, next) => {
  try {
    res.json({ data: await airPickupOperations.getHandoverBatch(req.params.batchId), requestId: req.requestId });
  } catch (error) { next(error); }
});

warehouseRouter.patch('/air-handover-batches/:batchId', warehouseBoundary.session, requireWarehousePermission('air_pickups.handover'), async (req, res, next) => {
  try {
    const batch = await airPickupOperations.updateHandoverBatch(req.warehouseSession!, warehouseAudit(req), req.params.batchId, req.body ?? {});
    res.json({ data: batch, requestId: req.requestId });
  } catch (error) { next(error); }
});

warehouseRouter.post('/air-handover-batches/:batchId/confirm', warehouseBoundary.session, requireWarehousePermission('air_pickups.handover'), async (req, res, next) => {
  try {
    const batch = await airPickupOperations.confirmHandoverBatch(req.warehouseSession!, warehouseAudit(req), req.params.batchId);
    res.json({ data: batch, requestId: req.requestId });
  } catch (error) { next(error); }
});

warehouseRouter.put(
  '/air-handover-batches/:batchId/evidence',
  warehouseBoundary.session,
  requireWarehousePermission('air_pickups.evidence.add'),
  evidenceBodyParser,
  async (req, res, next) => {
    try {
      if (!req.is('image/jpeg') && !req.is('image/png')) throw new ApiError(415, 'UNSUPPORTED_EVIDENCE_IMAGE', '仅支持 JPG、JPEG 或 PNG 图片。');
      const warningsHeader = req.header('x-image-quality-warnings');
      const asset = await airPickupOperations.storeEvidence(req.warehouseSession!, warehouseAudit(req), req.params.batchId, {
        type: req.query.type,
        filename: req.query.filename,
        qualityWarnings: warningsHeader ? warningsHeader.split(',').map(item => item.trim()).filter(Boolean) : [],
        qualityOverride: req.header('x-image-quality-override') === 'true',
        contentType: req.header('content-type'),
        sha256: req.header('x-image-sha256'),
        content: req.body,
      });
      res.status(201).json({ data: asset, requestId: req.requestId });
    } catch (error) { next(error); }
  },
);

warehouseRouter.get('/air-evidence-assets/:assetId/content', warehouseBoundary.session, requireWarehousePermission('air_pickups.view'), async (req, res, next) => {
  try {
    const result = await airPickupOperations.openEvidence(req.params.assetId);
    res.setHeader('Content-Type', result.metadata.content_type);
    res.setHeader('Content-Length', String(result.object.byteSize));
    res.setHeader('Content-Disposition', `inline; filename="${result.metadata.id}.${result.metadata.content_type === 'image/png' ? 'png' : 'jpg'}"`);
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    result.object.stream.on('error', next).pipe(res);
  } catch (error) { next(error); }
});

warehouseRouter.delete('/air-evidence-assets/:assetId', warehouseBoundary.session, requireWarehousePermission('air_pickups.evidence.manage'), async (req, res, next) => {
  try {
    res.json({ data: await airPickupOperations.removeEvidence(req.warehouseSession!, warehouseAudit(req), req.params.assetId, req.body ?? {}), requestId: req.requestId });
  } catch (error) { next(error); }
});

warehouseRouter.post('/air-pickups/:orderId/void', warehouseBoundary.session, requireWarehousePermission('air_pickups.correct'), async (req, res, next) => {
  try {
    await airPickupOperations.voidOrder(req.warehouseSession!, warehouseAudit(req), req.params.orderId, req.body ?? {});
    res.status(204).end();
  } catch (error) { next(error); }
});

warehouseRouter.get('/attendance/context', warehouseBoundary.session, requireWarehousePermission('attendance.punch'), requireWarehouseWorkspace, async (req, res, next) => {
  try {
    res.json({ data: await attendanceOperations.getPunchContext(req.warehouseSession!), requestId: req.requestId });
  } catch (error) { next(error); }
});

warehouseRouter.put(
  '/attendance/punches',
  warehouseBoundary.session,
  requireWarehousePermission('attendance.punch'),
  requireWarehouseWorkspace,
  attendancePhotoBodyParser,
  async (req, res, next) => {
    try {
      if (!req.is('image/jpeg') && !req.is('image/png')) {
        throw new ApiError(415, 'UNSUPPORTED_ATTENDANCE_PHOTO', '打卡照片仅支持 JPG、JPEG 或 PNG。');
      }
      const result = await attendanceOperations.submitPunch(req.warehouseSession!, warehouseAudit(req), {
        ...req.query,
        content: req.body,
        contentType: req.header('content-type'),
        sha256: req.header('x-image-sha256'),
      });
      res.status(result.accepted ? 201 : 200).json({ data: result, requestId: req.requestId });
    } catch (error) { next(error); }
  },
);

warehouseRouter.get('/attendance/daily-results', warehouseBoundary.session, requireWarehouseAnyPermission(['attendance.self_view', 'attendance.team_view']), requireWarehouseWorkspace, async (req, res, next) => {
  try {
    res.json({ data: await attendanceOperations.listDailyResults(req.warehouseSession!, {
      dateFrom: req.query.dateFrom, dateTo: req.query.dateTo, userId: req.query.userId,
    }), requestId: req.requestId });
  } catch (error) { next(error); }
});

warehouseRouter.get('/attendance/appeals', warehouseBoundary.session, requireWarehouseAnyPermission(['attendance.self_view', 'attendance.review']), requireWarehouseWorkspace, async (req, res, next) => {
  try { res.json({ data: await attendanceOperations.listAppeals(req.warehouseSession!, req.query.status), requestId: req.requestId }); }
  catch (error) { next(error); }
});

warehouseRouter.post('/attendance/appeals', warehouseBoundary.session, requireWarehousePermission('attendance.appeal'), requireWarehouseWorkspace, async (req, res, next) => {
  try {
    res.status(201).json({ data: await attendanceOperations.createAppeal(req.warehouseSession!, req.body ?? {}), requestId: req.requestId });
  } catch (error) { next(error); }
});

warehouseRouter.patch('/attendance/appeals/:appealId/review', warehouseBoundary.session, requireWarehousePermission('attendance.review'), requireWarehouseWorkspace, async (req, res, next) => {
  try {
    res.json({ data: await attendanceOperations.reviewAppeal(req.warehouseSession!, req.params.appealId, req.body ?? {}), requestId: req.requestId });
  } catch (error) { next(error); }
});

warehouseRouter.get('/attendance/locations', warehouseBoundary.session, requireWarehouseAnyPermission(['attendance.punch', 'attendance.locations.manage']), requireWarehouseWorkspace, async (req, res, next) => {
  try { res.json({ data: await attendanceOperations.listLocations(req.warehouseSession!), requestId: req.requestId }); }
  catch (error) { next(error); }
});

warehouseRouter.put('/attendance/locations', warehouseBoundary.session, requireWarehousePermission('attendance.locations.manage'), requireWarehouseWorkspace, async (req, res, next) => {
  try { res.json({ data: await attendanceOperations.saveLocation(req.warehouseSession!, req.body ?? {}), requestId: req.requestId }); }
  catch (error) { next(error); }
});

warehouseRouter.get('/attendance/shift-rules', warehouseBoundary.session, requireWarehouseAnyPermission(['attendance.punch', 'attendance.rules.manage']), requireWarehouseWorkspace, async (req, res, next) => {
  try { res.json({ data: await attendanceOperations.listShiftRules(req.warehouseSession!), requestId: req.requestId }); }
  catch (error) { next(error); }
});

warehouseRouter.put('/attendance/shift-rules', warehouseBoundary.session, requireWarehousePermission('attendance.rules.manage'), requireWarehouseWorkspace, async (req, res, next) => {
  try { res.json({ data: await attendanceOperations.saveShiftRule(req.warehouseSession!, req.body ?? {}), requestId: req.requestId }); }
  catch (error) { next(error); }
});

warehouseRouter.get('/attendance/payroll-preview', warehouseBoundary.session, requireWarehousePermission('payroll.view'), requireWarehouseWorkspace, async (req, res, next) => {
  try {
    res.json({ data: await attendanceOperations.calculatePayroll(req.warehouseSession!, {
      dateFrom: req.query.dateFrom, dateTo: req.query.dateTo,
    }), requestId: req.requestId });
  } catch (error) { next(error); }
});

warehouseRouter.post('/attendance/payroll-runs', warehouseBoundary.session, requireWarehousePermission('payroll.export'), requireWarehouseWorkspace, async (req, res, next) => {
  try {
    res.status(201).json({ data: await attendanceOperations.calculatePayroll(req.warehouseSession!, {
      dateFrom: req.body?.dateFrom, dateTo: req.body?.dateTo,
    }, true), requestId: req.requestId });
  } catch (error) { next(error); }
});

warehouseRouter.put('/attendance/pay-profiles', warehouseBoundary.session, requireWarehousePermission('payroll.manage'), requireWarehouseWorkspace, async (req, res, next) => {
  try { res.json({ data: await attendanceOperations.savePayProfile(req.warehouseSession!, req.body ?? {}), requestId: req.requestId }); }
  catch (error) { next(error); }
});

warehouseRouter.put('/attendance/payroll-adjustments', warehouseBoundary.session, requireWarehousePermission('payroll.manage'), requireWarehouseWorkspace, async (req, res, next) => {
  try { res.json({ data: await attendanceOperations.savePayrollAdjustment(req.warehouseSession!, req.body ?? {}), requestId: req.requestId }); }
  catch (error) { next(error); }
});

warehouseRouter.get('/attendance/punch-attempts/:attemptId/photo', warehouseBoundary.session, requireWarehouseAnyPermission(['attendance.self_view', 'attendance.team_view']), requireWarehouseWorkspace, async (req, res, next) => {
  try {
    const result = await attendanceOperations.openPunchPhoto(req.warehouseSession!, req.params.attemptId);
    res.setHeader('Content-Type', result.metadata.photo_content_type!);
    res.setHeader('Content-Length', String(result.object.byteSize));
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    result.object.stream.on('error', next).pipe(res);
  } catch (error) { next(error); }
});

warehouseRouter.get('/shipments', warehouseBoundary.session, requireWarehousePermission('shipments.view'), requireWarehouseWorkspace, async (req, res, next) => {
  try {
    const result = await warehouseOperations.listShipments(req.warehouseSession!, {
      cursor: req.query.cursor,
      limit: req.query.limit,
    });
    res.json({ data: result.shipments, cursor: result.cursor, hasMore: result.hasMore, requestId: req.requestId });
  } catch (error) {
    next(error);
  }
});

warehouseRouter.get('/label-assets/:assetId/content', warehouseBoundary.session, requireWarehousePermission('scan.use'), requireWarehouseWorkspace, async (req, res, next) => {
  try {
    const result = await warehouseOperations.openLabel(req.warehouseSession!, req.params.assetId);
    res.setHeader('Content-Type', result.metadata.content_type);
    res.setHeader('Content-Length', String(result.object.byteSize));
    res.setHeader('Content-Disposition', `attachment; filename="${result.metadata.id}.pdf"`);
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('ETag', `"sha256-${result.metadata.content_sha256}"`);
    result.object.stream.on('error', next).pipe(res);
  } catch (error) {
    next(error);
  }
});

warehouseRouter.post('/print-attempts', warehouseBoundary.session, requireWarehousePermission('print.submit'), requireWarehouseWorkspace, async (req, res, next) => {
  try {
    const attempt = await warehouseOperations.recordPrintAttempt(req.warehouseSession!, req.body ?? {});
    res.status(attempt.replayed ? 200 : 201).json({ data: attempt, requestId: req.requestId });
  } catch (error) {
    next(error);
  }
});

warehouseRouter.get('/outbound-events', warehouseBoundary.session, requireWarehousePermission('callbacks.view'), async (req, res, next) => {
  try {
    const events = await outboundWebhooks.listForWarehouse(req.warehouseSession!, {
      status: req.query.status,
      limit: req.query.limit,
    });
    res.json({ data: events, requestId: req.requestId });
  } catch (error) {
    next(error);
  }
});

warehouseRouter.get('/outbound-events/:eventId/attempts', warehouseBoundary.session, requireWarehousePermission('callbacks.view'), async (req, res, next) => {
  try {
    const attempts = await outboundWebhooks.listAttemptsForWarehouse(req.warehouseSession!, req.params.eventId);
    res.json({ data: attempts, requestId: req.requestId });
  } catch (error) {
    next(error);
  }
});

warehouseRouter.post('/outbound-events/:eventId/retry', warehouseBoundary.session, requireWarehousePermission('callbacks.retry'), async (req, res, next) => {
  try {
    const event = await outboundWebhooks.retryForWarehouse(req.warehouseSession!, req.params.eventId);
    res.json({ data: event, requestId: req.requestId });
  } catch (error) {
    next(error);
  }
});

app.use('/warehouse/v1', warehouseRouter);

app.use((_req, _res, next) => {
  next(new ApiError(404, 'ROUTE_NOT_FOUND', '接口不存在。'));
});

app.use((error: unknown, req: Request, res: Response, _next: NextFunction) => {
  const apiError = normalizeApiError(error);
  if (!(error instanceof ApiError) && apiError.status >= 500) console.error(error);
  res.status(apiError.status).json({
    error: { code: apiError.code, message: apiError.message, requestId: req.requestId },
  });
});

let server: ReturnType<typeof app.listen> | null = null;
let attendanceRetentionTimer: ReturnType<typeof setInterval> | null = null;

async function runAttendanceRetention(): Promise<void> {
  try {
    const purged = await attendanceOperations.purgeExpiredEvidence();
    if (purged > 0) console.log(`Purged ${purged} expired attendance evidence record(s).`);
  } catch (error) {
    console.error('Attendance evidence retention failed:', error instanceof Error ? error.message : error);
  }
}

async function start(): Promise<void> {
  await outboundWebhooks.start();
  await runAttendanceRetention();
  attendanceRetentionTimer = setInterval(() => void runAttendanceRetention(), 60 * 60_000);
  attendanceRetentionTimer.unref();
  server = app.listen(config.port, config.host, () => {
    console.log(`CM-HUB cloud API listening on ${config.host}:${config.port} (${config.environment})`);
  });
}

async function shutdown(signal: string): Promise<void> {
  console.log(`Received ${signal}; shutting down.`);
  outboundWebhooks.stop();
  if (attendanceRetentionTimer) clearInterval(attendanceRetentionTimer);
  if (!server) {
    await closeConnections();
    process.exit(0);
    return;
  }
  server.close(async () => {
    await closeConnections();
    process.exit(0);
  });
}

process.once('SIGTERM', () => void shutdown('SIGTERM'));
process.once('SIGINT', () => void shutdown('SIGINT'));

void start().catch(async error => {
  outboundWebhooks.stop();
  console.error('CM-HUB cloud API failed to start:', error instanceof Error ? error.message : error);
  await closeConnections();
  process.exitCode = 1;
});
