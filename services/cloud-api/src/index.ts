import { randomUUID } from 'node:crypto';
import express, { type NextFunction, type Request, type Response } from 'express';
import { config } from './config.js';
import { requireApiKey, requireScope } from './auth.js';
import { closeConnections, mysql, redis } from './db.js';
import { ApiError, normalizeApiError } from './errors.js';
import { createLabelAssetModule } from './labelAssets.js';
import { validateLabelPdf } from './labelPdf.js';
import { createFilesystemLabelStorage } from './labelStorage.js';
import { createShipmentIngestor } from './shipmentIngest.js';
import { createOutboundWebhooks } from './outboundWebhooks.js';
import { toShipment, type ShipmentRow } from './shipmentRecord.js';
import { createWarehouseIdentity } from './warehouseIdentity.js';
import { createWarehouseHttpBoundary, requireWarehouseRole } from './warehouseHttp.js';
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

app.use(express.json({ limit: config.jsonLimit }));

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
const labelStorage = createFilesystemLabelStorage(config.labelStorageRoot);
const labelAssets = createLabelAssetModule({
  mysql,
  storage: labelStorage,
});
const warehouseIdentity = createWarehouseIdentity({
  mysql,
  redis,
  sessionLifetimeHours: config.warehouse.sessionLifetimeHours,
});
const outboundWebhooks = createOutboundWebhooks({
  mysql,
  options: {
    ...config.outboundWebhooks,
    environment: config.environment,
  },
});
const warehouseOperations = createWarehouseOperations({ mysql, storage: labelStorage, outboundWebhooks });
const warehouseBoundary = createWarehouseHttpBoundary({
  identity: warehouseIdentity,
  allowedOrigins: new Set(config.warehouse.allowedOrigins),
  cookieName: config.warehouse.cookieName,
});
const pdfBodyParser = express.raw({ type: 'application/pdf', limit: config.labelPdfLimit });

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

app.use('/api/v1', requireApiKey, upstreamRouter);

const warehouseRouter = express.Router();
warehouseRouter.use(warehouseBoundary.origin);

warehouseRouter.post('/sessions', async (req, res, next) => {
  try {
    const result = await warehouseIdentity.login({
      email: req.body?.email,
      password: req.body?.password,
      warehouseCode: req.body?.warehouseCode,
      ip: req.ip || req.socket.remoteAddress || 'unknown',
      userAgent: req.header('user-agent'),
    });
    res.cookie(config.warehouse.cookieName, result.token, {
      httpOnly: true,
      secure: config.environment === 'production',
      sameSite: 'strict',
      path: '/warehouse/v1',
      maxAge: config.warehouse.sessionLifetimeHours * 60 * 60 * 1000,
    });
    res.status(201).json({ data: result.session, requestId: req.requestId });
  } catch (error) {
    next(error);
  }
});

warehouseRouter.get('/session', warehouseBoundary.session, (req, res) => {
  res.json({ data: req.warehouseSession, requestId: req.requestId });
});

warehouseRouter.delete('/session', warehouseBoundary.session, async (req, res, next) => {
  try {
    await warehouseIdentity.logout(req.warehouseSession!.sessionId);
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

warehouseRouter.post('/workstations', warehouseBoundary.session, requireWarehouseRole('OPERATOR'), async (req, res, next) => {
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

warehouseRouter.get('/members', warehouseBoundary.session, requireWarehouseRole('ADMIN'), async (req, res, next) => {
  try {
    res.json({ data: await warehouseIdentity.listMembers(req.warehouseSession!), requestId: req.requestId });
  } catch (error) {
    next(error);
  }
});

warehouseRouter.post('/members', warehouseBoundary.session, requireWarehouseRole('ADMIN'), async (req, res, next) => {
  try {
    const member = await warehouseIdentity.createMember(req.warehouseSession!, {
      email: req.body?.email,
      displayName: req.body?.displayName,
      password: req.body?.password,
      role: req.body?.role,
    });
    res.status(201).json({ data: member, requestId: req.requestId });
  } catch (error) {
    next(error);
  }
});

warehouseRouter.patch('/members/:userId', warehouseBoundary.session, requireWarehouseRole('ADMIN'), async (req, res, next) => {
  try {
    const member = await warehouseIdentity.updateMember(req.warehouseSession!, req.params.userId, {
      role: req.body?.role,
      status: req.body?.status,
    });
    res.json({ data: member, requestId: req.requestId });
  } catch (error) {
    next(error);
  }
});

warehouseRouter.get('/shipments', warehouseBoundary.session, requireWarehouseRole('OPERATOR'), async (req, res, next) => {
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

warehouseRouter.get('/label-assets/:assetId/content', warehouseBoundary.session, requireWarehouseRole('OPERATOR'), async (req, res, next) => {
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

warehouseRouter.post('/print-attempts', warehouseBoundary.session, requireWarehouseRole('OPERATOR'), async (req, res, next) => {
  try {
    const attempt = await warehouseOperations.recordPrintAttempt(req.warehouseSession!, req.body ?? {});
    res.status(attempt.replayed ? 200 : 201).json({ data: attempt, requestId: req.requestId });
  } catch (error) {
    next(error);
  }
});

warehouseRouter.get('/outbound-events', warehouseBoundary.session, requireWarehouseRole('ADMIN'), async (req, res, next) => {
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

warehouseRouter.get('/outbound-events/:eventId/attempts', warehouseBoundary.session, requireWarehouseRole('ADMIN'), async (req, res, next) => {
  try {
    const attempts = await outboundWebhooks.listAttemptsForWarehouse(req.warehouseSession!, req.params.eventId);
    res.json({ data: attempts, requestId: req.requestId });
  } catch (error) {
    next(error);
  }
});

warehouseRouter.post('/outbound-events/:eventId/retry', warehouseBoundary.session, requireWarehouseRole('ADMIN'), async (req, res, next) => {
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

async function start(): Promise<void> {
  await outboundWebhooks.start();
  server = app.listen(config.port, config.host, () => {
    console.log(`CM-HUB cloud API listening on ${config.host}:${config.port} (${config.environment})`);
  });
}

async function shutdown(signal: string): Promise<void> {
  console.log(`Received ${signal}; shutting down.`);
  outboundWebhooks.stop();
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
