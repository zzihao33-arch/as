import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Pool, PoolConnection } from 'mysql2/promise';
import type { RowDataPacket } from 'mysql2';
import { ApiError } from './errors.js';
import type { LabelStorage, LabelStorageObject } from './labelStorage.js';
import type { WarehouseSession } from './warehouseIdentity.js';
import { verifyWarehousePassword } from './warehouseSecurity.js';

type RequestAudit = { requestId: string; ip: string; userAgent?: string };
type AirPickupStatus = 'RECORDED' | 'RECEIVED' | 'HANDED_OVER' | 'VOIDED';
type EvidenceStatus = 'NONE' | 'PARTIAL' | 'COMPLETE';
type WeightUnit = 'KG' | 'LB';

type OrderRow = RowDataPacket & {
  id: string;
  client_id: string | null;
  client_name_snapshot: string;
  customer_profile_id: string | null;
  customer_name_snapshot: string | null;
  customer_type_snapshot: 'BUSINESS' | 'UPSTREAM' | null;
  source_type: 'MANUAL' | 'UPSTREAM';
  external_batch_id: string | null;
  bill_no_raw: string;
  bill_no_display: string;
  bill_no_normalized: string;
  bill_no_is_standard: number | boolean;
  cargo_name: string | null;
  forecast_cartons: number;
  forecast_packages: number;
  forecast_weight: number | string;
  forecast_weight_unit: WeightUnit;
  remarks: string | null;
  order_status: AirPickupStatus;
  evidence_status: EvidenceStatus;
  actual_cartons: number | null;
  actual_packages: number | null;
  actual_weight: number | string | null;
  actual_weight_unit: WeightUnit | null;
  difference_reason: string | null;
  receipt_batch_id: string | null;
  receipt_batch_no: string | null;
  handover_batch_id: string | null;
  handover_batch_no: string | null;
  received_at: Date | null;
  handed_over_at: Date | null;
  created_by_reference: string;
  updated_by_reference: string;
  version: number;
  void_reason: string | null;
  created_at: Date;
  updated_at: Date;
  total_count?: number | string;
  total_shipment_count?: number | string | null;
  changed_shipment_count?: number | string | null;
  intercepted_shipment_count?: number | string | null;
  exception_shipment_count?: number | string | null;
};

type EvidenceRow = RowDataPacket & {
  id: string;
  handover_batch_id: string;
  evidence_type: 'POD' | 'LOADING';
  original_filename: string;
  storage_key: string;
  content_sha256: string;
  content_type: 'image/jpeg' | 'image/png';
  byte_size: number | string;
  pixel_width: number;
  pixel_height: number;
  quality_warnings: string | null;
  quality_override: number | boolean;
  asset_status: 'READY' | 'REMOVED';
  uploaded_by_reference: string;
  created_at: Date;
};

type ReceiptEvidenceRow = RowDataPacket & {
  id: string;
  receipt_batch_id: string;
  original_filename: string;
  storage_key: string;
  content_sha256: string;
  content_type: 'image/jpeg' | 'image/png';
  byte_size: number | string;
  pixel_width: number;
  pixel_height: number;
  quality_warnings: string | null;
  quality_override: number | boolean;
  asset_status: 'READY' | 'REMOVED';
  uploaded_by_reference: string;
  created_at: Date;
};

type PickupDocumentRow = RowDataPacket & {
  id: string;
  order_id: string;
  original_filename: string;
  storage_key: string;
  content_sha256: string;
  content_type: PickupDocumentContentType;
  byte_size: number | string;
  asset_status: 'READY' | 'REMOVED';
  uploaded_by_reference: string;
  created_at: Date;
};

type HandoverBatchRow = RowDataPacket & {
  id: string;
  batch_no: string;
  batch_status: 'DRAFT' | 'CONFIRMED';
  vehicle_no: string | null;
  driver_name: string | null;
  driver_phone: string | null;
  handed_over_at: Date | null;
  created_by_user_id: string | null;
  created_by_reference: string;
  confirmed_by_reference: string | null;
  version: number;
  confirmed_at: Date | null;
  created_at: Date;
  updated_at: Date;
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const BILL_ALLOWED = /^[A-Z0-9-]+$/;
const MAX_BATCH_SIZE = 200;
const MAX_EVIDENCE_BYTES = 10 * 1024 * 1024;
const MAX_PICKUP_DOCUMENT_BYTES = 20 * 1024 * 1024;
const MAX_PICKUP_DOCUMENTS = 10;
const PICKUP_DOCUMENT_TYPES = {
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  csv: 'text/csv',
} as const;
type PickupDocumentExtension = keyof typeof PICKUP_DOCUMENT_TYPES;
type PickupDocumentContentType = typeof PICKUP_DOCUMENT_TYPES[PickupDocumentExtension];

function text(value: unknown, field: string, maxLength: number, required = true): string | null {
  if (value === undefined || value === null || value === '') {
    if (required) throw new ApiError(400, 'VALIDATION_ERROR', `${field} 为必填项`);
    return null;
  }
  if (typeof value !== 'string') throw new ApiError(400, 'VALIDATION_ERROR', `${field} 必须是字符串`);
  const result = value.trim();
  if (!result || result.length > maxLength) throw new ApiError(400, 'VALIDATION_ERROR', `${field} 长度无效`);
  return result;
}

function uuid(value: unknown, field: string): string {
  const result = text(value, field, 36)!;
  if (!UUID_PATTERN.test(result)) throw new ApiError(400, 'VALIDATION_ERROR', `${field} 必须是 UUID`);
  return result;
}

function positiveInteger(value: unknown, field: string): number {
  const result = Number(value);
  if (!Number.isInteger(result) || result < 1 || result > 999_999) {
    throw new ApiError(400, 'VALIDATION_ERROR', `${field} 必须是 1 到 999999 的整数`);
  }
  return result;
}

function positiveWeight(value: unknown, field: string): number {
  const result = Number(value);
  if (!Number.isFinite(result) || result <= 0 || result > 99_999_999_999.999) {
    throw new ApiError(400, 'VALIDATION_ERROR', `${field} 必须大于 0`);
  }
  return Math.round(result * 1000) / 1000;
}

function weightUnit(value: unknown, field: string): WeightUnit {
  const result = text(value, field, 2)!.toUpperCase();
  if (result !== 'KG' && result !== 'LB') throw new ApiError(400, 'VALIDATION_ERROR', `${field} 仅支持 KG 或 LB`);
  return result;
}

function dateValue(value: unknown, field: string): Date {
  if (value === undefined || value === null || value === '') return new Date();
  const result = new Date(String(value));
  if (Number.isNaN(result.getTime())) throw new ApiError(400, 'VALIDATION_ERROR', `${field} 必须是有效时间`);
  return result;
}

function pageValue(value: unknown, fallback: number, maximum: number): number {
  if (value === undefined || value === null || value === '') return fallback;
  const result = Number(value);
  if (!Number.isInteger(result) || result < 1 || result > maximum) throw new ApiError(400, 'VALIDATION_ERROR', '分页参数无效');
  return result;
}

export function normalizeAirBillNo(value: unknown): {
  raw: string;
  display: string;
  normalized: string;
  isStandard: boolean;
} {
  const raw = text(value, 'billNo', 32)!;
  const displayCandidate = raw.replace(/[\s\u3000]+/g, '').replace(/[－—–]/g, '-').toUpperCase();
  if (!BILL_ALLOWED.test(displayCandidate)) {
    throw new ApiError(400, 'INVALID_AIR_BILL_NO', '提货单号仅允许字母、数字和连字符');
  }
  const normalized = displayCandidate.replace(/-/g, '');
  if (!normalized || normalized.length > 32) throw new ApiError(400, 'INVALID_AIR_BILL_NO', '提货单号长度无效');
  const isStandard = /^\d{11}$/.test(normalized);
  const display = isStandard ? `${normalized.slice(0, 3)}-${normalized.slice(3)}` : displayCandidate;
  return { raw, display, normalized, isStandard };
}

export function receivingValuesDiffer(input: {
  forecastCartons: number; forecastPackages: number; forecastWeight: number; forecastWeightUnit: WeightUnit;
  actualCartons: number; actualPackages: number; actualWeight: number; actualWeightUnit: WeightUnit;
}): boolean {
  return input.forecastCartons !== input.actualCartons
    || input.forecastPackages !== input.actualPackages
    || Math.abs(input.forecastWeight - input.actualWeight) > 0.000_1
    || input.forecastWeightUnit !== input.actualWeightUnit;
}

export function evidenceStatusForCounts(podCount: number, loadingCount: number): EvidenceStatus {
  if (podCount >= 1 && loadingCount >= 3) return 'COMPLETE';
  if (podCount > 0 || loadingCount > 0) return 'PARTIAL';
  return 'NONE';
}

function pngDimensions(buffer: Buffer): { width: number; height: number } | null {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (buffer.length < 24 || !buffer.subarray(0, 8).equals(signature)) return null;
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

function jpegDimensions(buffer: Buffer): { width: number; height: number } | null {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 9 < buffer.length) {
    if (buffer[offset] !== 0xff) { offset += 1; continue; }
    const marker = buffer[offset + 1];
    if (marker === 0xd9 || marker === 0xda) break;
    const length = buffer.readUInt16BE(offset + 2);
    if (length < 2 || offset + length + 2 > buffer.length) break;
    if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
      return { height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) };
    }
    offset += length + 2;
  }
  return null;
}

export function validateAirEvidenceImage(
  buffer: unknown,
  declaredContentType?: string,
  declaredSha256?: string,
  minimumDimensions: { width: number; height: number } = { width: 800, height: 600 },
): {
  content: Buffer; contentType: 'image/jpeg' | 'image/png'; sha256: string; width: number; height: number;
} {
  if (!Buffer.isBuffer(buffer) || buffer.length < 1) throw new ApiError(400, 'EMPTY_EVIDENCE_IMAGE', '凭证图片不能为空');
  if (buffer.length > MAX_EVIDENCE_BYTES) throw new ApiError(413, 'EVIDENCE_IMAGE_TOO_LARGE', '单张凭证图片不能超过 10MB');
  const png = pngDimensions(buffer);
  const jpeg = png ? null : jpegDimensions(buffer);
  const contentType = png ? 'image/png' : jpeg ? 'image/jpeg' : null;
  if (!contentType) throw new ApiError(415, 'UNSUPPORTED_EVIDENCE_IMAGE', '仅支持真实的 JPG、JPEG 或 PNG 图片');
  if (declaredContentType && !['image/jpeg', 'image/png'].includes(declaredContentType.toLowerCase())) {
    throw new ApiError(415, 'UNSUPPORTED_EVIDENCE_IMAGE', '图片 Content-Type 无效');
  }
  if (declaredContentType && declaredContentType.toLowerCase() !== contentType) {
    throw new ApiError(415, 'EVIDENCE_CONTENT_TYPE_MISMATCH', '图片真实类型与 Content-Type 不一致');
  }
  const dimensions = png ?? jpeg!;
  if (dimensions.width < minimumDimensions.width || dimensions.height < minimumDimensions.height) {
    throw new ApiError(400, 'EVIDENCE_RESOLUTION_TOO_LOW', `凭证图片分辨率至少为 ${minimumDimensions.width}×${minimumDimensions.height}`);
  }
  const sha256 = createHash('sha256').update(buffer).digest('hex');
  if (declaredSha256 && !/^[0-9a-f]{64}$/i.test(declaredSha256)) throw new ApiError(400, 'INVALID_EVIDENCE_SHA256', '图片摘要格式无效');
  if (declaredSha256 && declaredSha256.toLowerCase() !== sha256) throw new ApiError(400, 'EVIDENCE_SHA256_MISMATCH', '图片摘要校验失败');
  return { content: buffer, contentType, sha256, width: dimensions.width, height: dimensions.height };
}

function pickupDocumentFilename(value: unknown): { filename: string; extension: PickupDocumentExtension } {
  const filename = text(value, 'filename', 255)!;
  if (/[\\/\0]/.test(filename)) throw new ApiError(400, 'INVALID_DOCUMENT_FILENAME', '文件名不能包含路径');
  const extension = filename.split('.').pop()?.toLowerCase() as PickupDocumentExtension | undefined;
  if (!extension || !(extension in PICKUP_DOCUMENT_TYPES)) {
    throw new ApiError(415, 'UNSUPPORTED_PICKUP_DOCUMENT', '仅支持 PDF、Word、Excel 或 CSV 提货文件');
  }
  return { filename, extension };
}

export function validatePickupDocument(buffer: unknown, filenameValue: unknown, declaredContentType?: string, declaredSha256?: string): {
  content: Buffer; filename: string; extension: PickupDocumentExtension; contentType: PickupDocumentContentType; sha256: string;
} {
  if (!Buffer.isBuffer(buffer) || buffer.length < 1) throw new ApiError(400, 'EMPTY_PICKUP_DOCUMENT', '提货文件不能为空');
  if (buffer.length > MAX_PICKUP_DOCUMENT_BYTES) throw new ApiError(413, 'PICKUP_DOCUMENT_TOO_LARGE', '单个提货文件不能超过 20MB');
  const { filename, extension } = pickupDocumentFilename(filenameValue);
  const isPdf = buffer.subarray(0, 5).equals(Buffer.from('%PDF-'));
  const isOfficeBinary = buffer.subarray(0, 8).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]));
  const isZip = buffer.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
  const contains = (value: string) => buffer.includes(Buffer.from(value));
  const valid = extension === 'pdf' ? isPdf
    : extension === 'doc' || extension === 'xls' ? isOfficeBinary
      : extension === 'docx' ? isZip && contains('word/')
        : extension === 'xlsx' ? isZip && contains('xl/')
          : !buffer.includes(0);
  if (!valid) throw new ApiError(415, 'PICKUP_DOCUMENT_SIGNATURE_INVALID', '文件内容与所选的提货文件格式不一致');
  const contentType = PICKUP_DOCUMENT_TYPES[extension];
  const normalizedType = declaredContentType?.split(';')[0].trim().toLowerCase();
  if (normalizedType && normalizedType !== 'application/octet-stream' && normalizedType !== contentType
    && !(extension === 'csv' && normalizedType === 'application/vnd.ms-excel')) {
    throw new ApiError(415, 'PICKUP_DOCUMENT_CONTENT_TYPE_MISMATCH', '文件 Content-Type 与文件类型不一致');
  }
  const sha256 = createHash('sha256').update(buffer).digest('hex');
  if (declaredSha256 && !/^[0-9a-f]{64}$/i.test(declaredSha256)) throw new ApiError(400, 'INVALID_PICKUP_DOCUMENT_SHA256', '文件摘要格式无效');
  if (declaredSha256 && declaredSha256.toLowerCase() !== sha256) throw new ApiError(400, 'PICKUP_DOCUMENT_SHA256_MISMATCH', '文件摘要校验失败');
  return { content: buffer, filename, extension, contentType, sha256 };
}

function batchNo(prefix: 'IN' | 'HO'): string {
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  return `${prefix}-${date}-${randomBytes(4).toString('hex').toUpperCase()}`;
}

function actor(session: WarehouseSession): string {
  return `user:${session.userId}`;
}

function canCorrect(session: WarehouseSession): boolean {
  return session.platformRole === 'SYSTEM_ADMIN' || session.permissions.includes('air_pickups.correct');
}

function toOrder(row: OrderRow) {
  const total = Number(row.total_shipment_count ?? 0);
  const changed = Number(row.changed_shipment_count ?? 0);
  const intercepted = Number(row.intercepted_shipment_count ?? 0);
  const exceptions = Number(row.exception_shipment_count ?? 0);
  return {
    id: row.id, sourceClientId: row.client_id, sourceClientName: row.client_name_snapshot,
    customerId: row.customer_profile_id, customerName: row.customer_name_snapshot ?? row.client_name_snapshot,
    customerType: row.customer_type_snapshot,
    sourceType: row.source_type, externalBatchId: row.external_batch_id,
    billNoRaw: row.bill_no_raw, billNo: row.bill_no_display,
    billNoNormalized: row.bill_no_normalized, billNoIsStandard: Boolean(row.bill_no_is_standard),
    cargoName: row.cargo_name, forecastCartons: row.forecast_cartons,
    forecastPackages: row.forecast_packages, forecastWeight: Number(row.forecast_weight),
    forecastWeightUnit: row.forecast_weight_unit, remarks: row.remarks,
    status: row.order_status, evidenceStatus: row.evidence_status,
    actualCartons: row.actual_cartons, actualPackages: row.actual_packages,
    actualWeight: row.actual_weight === null ? null : Number(row.actual_weight),
    actualWeightUnit: row.actual_weight_unit, differenceReason: row.difference_reason,
    receiptBatchId: row.receipt_batch_id, receiptBatchNo: row.receipt_batch_no,
    handoverBatchId: row.handover_batch_id, handoverBatchNo: row.handover_batch_no,
    receivedAt: row.received_at?.toISOString() ?? null, handedOverAt: row.handed_over_at?.toISOString() ?? null,
    version: row.version, voidReason: row.void_reason,
    exchangeProgress: {
      total, changed, intercepted, exceptions,
      processed: changed + intercepted,
      pending: Math.max(0, total - changed - intercepted),
    },
    createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString(),
  };
}

const ORDER_SELECT = `SELECT o.*, rb.batch_no AS receipt_batch_no, hb.batch_no AS handover_batch_no,
    COALESCE(progress.total_count, 0) AS total_shipment_count,
    COALESCE(progress.changed_count, 0) AS changed_shipment_count,
    COALESCE(progress.intercepted_count, 0) AS intercepted_shipment_count,
    COALESCE(progress.exception_count, 0) AS exception_shipment_count
  FROM air_pickup_orders o
  LEFT JOIN air_receipt_batches rb ON rb.id = o.receipt_batch_id
  LEFT JOIN air_handover_batches hb ON hb.id = o.handover_batch_id
  LEFT JOIN (
    SELECT s.air_pickup_order_id, COUNT(*) AS total_count,
      SUM(CASE WHEN latest.outcome = 'SUBMITTED' THEN 1 ELSE 0 END) AS changed_count,
      SUM(CASE WHEN latest.outcome = 'BLOCKED' THEN 1 ELSE 0 END) AS intercepted_count,
      SUM(CASE WHEN latest.outcome IN ('FAILED', 'RESULT_UNKNOWN') THEN 1 ELSE 0 END) AS exception_count
    FROM shipments s
    LEFT JOIN (
      SELECT shipment_id, outcome FROM (
        SELECT shipment_id, outcome,
          ROW_NUMBER() OVER (PARTITION BY shipment_id ORDER BY occurred_at DESC, created_at DESC, id DESC) AS row_number
        FROM print_attempts
      ) ranked_attempts WHERE row_number = 1
    ) latest ON latest.shipment_id = s.id
    WHERE s.air_pickup_order_id IS NOT NULL
    GROUP BY s.air_pickup_order_id
  ) progress ON progress.air_pickup_order_id = o.id`;

function parseJson(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return null; }
}

function handoverEvidenceView(asset: EvidenceRow) {
  return { id: asset.id, type: asset.evidence_type, filename: asset.original_filename,
    contentType: asset.content_type, byteSize: Number(asset.byte_size), width: asset.pixel_width, height: asset.pixel_height,
    qualityWarnings: asset.quality_warnings ? parseJson(asset.quality_warnings) : [], qualityOverride: Boolean(asset.quality_override),
    downloadPath: `/warehouse/v1/air-evidence-assets/${asset.id}/content`, createdAt: asset.created_at.toISOString() };
}

function receiptEvidenceView(asset: ReceiptEvidenceRow) {
  return { id: asset.id, type: 'RECEIPT' as const, filename: asset.original_filename,
    contentType: asset.content_type, byteSize: Number(asset.byte_size), width: asset.pixel_width, height: asset.pixel_height,
    qualityWarnings: asset.quality_warnings ? parseJson(asset.quality_warnings) : [], qualityOverride: Boolean(asset.quality_override),
    downloadPath: `/warehouse/v1/air-receipt-evidence-assets/${asset.id}/content`, createdAt: asset.created_at.toISOString() };
}

function pickupDocumentView(asset: PickupDocumentRow) {
  return { id: asset.id, filename: asset.original_filename, contentType: asset.content_type,
    byteSize: Number(asset.byte_size), downloadPath: `/warehouse/v1/air-pickup-documents/${asset.id}/content`,
    createdAt: asset.created_at.toISOString() };
}

async function addEvent(connection: PoolConnection, session: WarehouseSession, audit: RequestAudit, input: {
  orderId?: string | null; receiptBatchId?: string | null; handoverBatchId?: string | null;
  eventType: string; reason?: string | null; data?: unknown;
}): Promise<void> {
  await connection.execute(
    `INSERT INTO air_pickup_events
      (order_id, receipt_batch_id, handover_batch_id, event_type, actor_user_id, actor_reference,
       request_id, ip_address, reason, event_data)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [input.orderId ?? null, input.receiptBatchId ?? null, input.handoverBatchId ?? null,
      input.eventType, session.userId, actor(session), audit.requestId, audit.ip.slice(0, 64),
      input.reason ?? null, input.data === undefined ? null : JSON.stringify(input.data)],
  );
}

async function recalculateEvidence(connection: PoolConnection, handoverBatchId: string): Promise<EvidenceStatus> {
  const [rows] = await connection.execute<(RowDataPacket & { evidence_type: 'POD' | 'LOADING'; count: number | string })[]>(
    `SELECT evidence_type, COUNT(*) AS count FROM air_handover_evidence_assets
     WHERE handover_batch_id = ? AND asset_status = 'READY' GROUP BY evidence_type`, [handoverBatchId],
  );
  const pod = Number(rows.find(row => row.evidence_type === 'POD')?.count ?? 0);
  const loading = Number(rows.find(row => row.evidence_type === 'LOADING')?.count ?? 0);
  const status = evidenceStatusForCounts(pod, loading);
  await connection.execute('UPDATE air_pickup_orders SET evidence_status = ?, version = version + 1 WHERE handover_batch_id = ?', [status, handoverBatchId]);
  return status;
}

export function createAirPickupOperations(dependencies: { mysql: Pool; storage: LabelStorage }) {
  const { mysql, storage } = dependencies;
  return {
    async listClients() {
      const [rows] = await mysql.execute<(RowDataPacket & { id: string; client_code: string; display_name: string })[]>(
        `SELECT id, client_code, display_name FROM clients
         WHERE client_status = 'ACTIVE' ORDER BY display_name, client_code`,
      );
      return rows.map(row => ({ id: row.id, code: row.client_code, name: row.display_name }));
    },

    async listOrders(input: { search?: unknown; customerId?: unknown; status?: unknown; evidenceStatus?: unknown; page?: unknown; pageSize?: unknown }) {
      const search = input.search === undefined || input.search === '' ? null : text(input.search, 'search', 100);
      const customerId = input.customerId === undefined || input.customerId === '' ? null : uuid(input.customerId, 'customerId');
      const status = input.status === undefined || input.status === '' ? null : text(input.status, 'status', 32) as AirPickupStatus | null;
      const evidence = input.evidenceStatus === undefined || input.evidenceStatus === '' ? null : text(input.evidenceStatus, 'evidenceStatus', 32) as EvidenceStatus | null;
      if (status && !['RECORDED', 'RECEIVED', 'HANDED_OVER', 'VOIDED'].includes(status)) throw new ApiError(400, 'VALIDATION_ERROR', 'status 不受支持');
      if (evidence && !['NONE', 'PARTIAL', 'COMPLETE'].includes(evidence)) throw new ApiError(400, 'VALIDATION_ERROR', 'evidenceStatus 不受支持');
      const page = pageValue(input.page, 1, 100_000);
      const pageSize = pageValue(input.pageSize, 20, 100);
      const offset = (page - 1) * pageSize;
      const normalizedSearch = search ? `%${search.replace(/[\s\u3000\-－—–]+/g, '').toUpperCase()}%` : null;
      const [rows] = await mysql.query<OrderRow[]>(
        `${ORDER_SELECT}, COUNT(*) OVER () AS total_count
         WHERE (? IS NULL OR o.bill_no_normalized LIKE ? OR o.cargo_name LIKE ? OR COALESCE(o.customer_name_snapshot, o.client_name_snapshot) LIKE ?)
           AND (? IS NULL OR o.customer_profile_id = ?)
           AND (? IS NULL OR o.order_status = ?)
           AND (? IS NULL OR o.evidence_status = ?)
         ORDER BY o.updated_at DESC, o.id LIMIT ${pageSize} OFFSET ${offset}`,
        [normalizedSearch, normalizedSearch, search ? `%${search}%` : null, search ? `%${search}%` : null,
          customerId, customerId, status, status, evidence, evidence],
      );
      const [summaryRows] = await mysql.execute<(RowDataPacket & {
        recorded_count: number | string; received_count: number | string;
        handed_over_count: number | string; voided_count: number | string; evidence_pending_count: number | string;
      })[]>(
        `SELECT
           SUM(order_status = 'RECORDED') AS recorded_count,
           SUM(order_status = 'RECEIVED') AS received_count,
           SUM(order_status = 'HANDED_OVER') AS handed_over_count,
           SUM(order_status = 'VOIDED') AS voided_count,
           SUM(order_status = 'HANDED_OVER' AND evidence_status <> 'COMPLETE') AS evidence_pending_count
         FROM air_pickup_orders`,
      );
      const summary = summaryRows[0];
      return { orders: rows.map(toOrder), total: Number(rows[0]?.total_count ?? 0), page, pageSize,
        summary: {
          recorded: Number(summary?.recorded_count ?? 0), received: Number(summary?.received_count ?? 0),
          handedOver: Number(summary?.handed_over_count ?? 0), voided: Number(summary?.voided_count ?? 0),
          evidencePending: Number(summary?.evidence_pending_count ?? 0),
        } };
    },

    async getOrder(orderIdValue: unknown) {
      const orderId = uuid(orderIdValue, 'orderId');
      const [rows] = await mysql.execute<OrderRow[]>(`${ORDER_SELECT} WHERE o.id = ? LIMIT 1`, [orderId]);
      if (!rows[0]) throw new ApiError(404, 'AIR_PICKUP_NOT_FOUND', '未找到空运提货单');
      const [events] = await mysql.execute<(RowDataPacket & { revision: number; event_type: string; actor_reference: string; reason: string | null; event_data: unknown; occurred_at: Date })[]>(
        `SELECT revision, event_type, actor_reference, reason, event_data, occurred_at
         FROM air_pickup_events WHERE order_id = ? ORDER BY revision DESC LIMIT 100`, [orderId],
      );
      const [receiptAssets] = rows[0].receipt_batch_id
        ? await mysql.execute<ReceiptEvidenceRow[]>(
          `SELECT * FROM air_receipt_evidence_assets WHERE receipt_batch_id = ? AND asset_status = 'READY' ORDER BY created_at`,
          [rows[0].receipt_batch_id],
        ) : [[] as ReceiptEvidenceRow[], []];
      const [handoverAssets] = rows[0].handover_batch_id
        ? await mysql.execute<EvidenceRow[]>(
          `SELECT * FROM air_handover_evidence_assets WHERE handover_batch_id = ? AND asset_status = 'READY' ORDER BY evidence_type, created_at`,
          [rows[0].handover_batch_id],
        ) : [[] as EvidenceRow[], []];
      const [pickupDocuments] = await mysql.execute<PickupDocumentRow[]>(
        `SELECT * FROM air_pickup_document_assets WHERE order_id = ? AND asset_status = 'READY' ORDER BY created_at`,
        [orderId],
      );
      const receiptEvidence = receiptAssets.map(receiptEvidenceView);
      const handoverEvidence = handoverAssets.map(handoverEvidenceView);
      return { ...toOrder(rows[0]), receiptEvidence, handoverEvidence, pickupDocuments: pickupDocuments.map(pickupDocumentView), events: events.map(event => {
        const data = parseJson(event.event_data);
        const eventEvidence = event.event_type === 'ORDER_RECEIVED'
          ? receiptEvidence
          : event.event_type === 'ORDER_HANDED_OVER'
            ? handoverEvidence
            : event.event_type === 'RECEIPT_EVIDENCE_ADDED'
              ? receiptEvidence.filter(asset => asset.id === (data as { assetId?: string } | null)?.assetId)
              : event.event_type === 'EVIDENCE_ADDED'
                ? handoverEvidence.filter(asset => asset.id === (data as { assetId?: string } | null)?.assetId)
                : [];
        return {
        revision: Number(event.revision), type: event.event_type, actorReference: event.actor_reference,
        reason: event.reason, data, evidence: eventEvidence, occurredAt: event.occurred_at.toISOString(),
      }; }) };
    },

    async createOrder(session: WarehouseSession, audit: RequestAudit, input: Record<string, unknown>) {
      const customerId = uuid(input.customerId, 'customerId');
      const bill = normalizeAirBillNo(input.billNo);
      const cargoName = text(input.cargoName, 'cargoName', 100, false);
      const forecastCartons = positiveInteger(input.forecastCartons, 'forecastCartons');
      const forecastPackages = positiveInteger(input.forecastPackages, 'forecastPackages');
      const forecastWeight = positiveWeight(input.forecastWeight, 'forecastWeight');
      const forecastWeightUnit = weightUnit(input.forecastWeightUnit, 'forecastWeightUnit');
      const remarks = text(input.remarks, 'remarks', 200, false);
      const id = randomUUID();
      const connection = await mysql.getConnection();
      try {
        await connection.beginTransaction();
        const [customers] = await connection.execute<(RowDataPacket & { display_name: string; customer_type: 'BUSINESS' | 'UPSTREAM' })[]>(
          `SELECT display_name, customer_type FROM customer_profiles
           WHERE id = ? AND customer_status = 'ACTIVE' LIMIT 1`, [customerId],
        );
        if (!customers[0]) throw new ApiError(400, 'INVALID_CUSTOMER', '请选择有效的归属客户');
        await connection.execute(
          `INSERT INTO air_pickup_orders
            (id, client_id, client_name_snapshot, customer_profile_id, customer_name_snapshot, customer_type_snapshot, source_type,
             bill_no_raw, bill_no_display, bill_no_normalized, bill_no_is_standard, cargo_name,
             forecast_cartons, forecast_packages, forecast_weight, forecast_weight_unit, remarks,
             created_by_user_id, created_by_reference, updated_by_user_id, updated_by_reference)
           VALUES (?, NULL, ?, ?, ?, ?, 'MANUAL', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [id, customers[0].display_name, customerId, customers[0].display_name, customers[0].customer_type,
            bill.raw, bill.display, bill.normalized, bill.isStandard, cargoName, forecastCartons,
            forecastPackages, forecastWeight, forecastWeightUnit, remarks, session.userId, actor(session), session.userId, actor(session)],
        );
        await addEvent(connection, session, audit, { orderId: id, eventType: 'ORDER_RECORDED',
          data: { billNo: bill.display, billNoIsStandard: bill.isStandard, customerId, customerName: customers[0].display_name,
            customerType: customers[0].customer_type, source: 'MANUAL' } });
        await connection.commit();
        return await this.getOrder(id);
      } catch (error) {
        await connection.rollback().catch(() => undefined);
        if (error instanceof Error && 'code' in error && error.code === 'ER_DUP_ENTRY') {
          throw new ApiError(409, 'AIR_BILL_ALREADY_EXISTS', '该提货单号已存在；空格、大小写和连字符不影响唯一性');
        }
        throw error;
      } finally { connection.release(); }
    },

    async updateRecordedOrder(session: WarehouseSession, audit: RequestAudit, orderIdValue: unknown, input: Record<string, unknown>) {
      const orderId = uuid(orderIdValue, 'orderId');
      const expectedVersion = positiveInteger(input.expectedVersion, 'expectedVersion');
      const cargoName = text(input.cargoName, 'cargoName', 100, false);
      const forecastCartons = positiveInteger(input.forecastCartons, 'forecastCartons');
      const forecastPackages = positiveInteger(input.forecastPackages, 'forecastPackages');
      const forecastWeight = positiveWeight(input.forecastWeight, 'forecastWeight');
      const forecastWeightUnit = weightUnit(input.forecastWeightUnit, 'forecastWeightUnit');
      const remarks = text(input.remarks, 'remarks', 200, false);
      const connection = await mysql.getConnection();
      try {
        await connection.beginTransaction();
        const [result] = await connection.execute(
          `UPDATE air_pickup_orders SET cargo_name = ?, forecast_cartons = ?, forecast_packages = ?,
             forecast_weight = ?, forecast_weight_unit = ?, remarks = ?, updated_by_user_id = ?,
             updated_by_reference = ?, version = version + 1
           WHERE id = ? AND order_status = 'RECORDED' AND version = ?`,
          [cargoName, forecastCartons, forecastPackages, forecastWeight, forecastWeightUnit, remarks,
            session.userId, actor(session), orderId, expectedVersion],
        );
        if (!('affectedRows' in result) || result.affectedRows !== 1) throw new ApiError(409, 'AIR_PICKUP_VERSION_CONFLICT', '提货单已被其他人修改或不再允许编辑，请刷新');
        await addEvent(connection, session, audit, { orderId, eventType: 'ORDER_EDITED' });
        await connection.commit();
        return await this.getOrder(orderId);
      } catch (error) { await connection.rollback().catch(() => undefined); throw error; }
      finally { connection.release(); }
    },

    async createReceiptBatch(session: WarehouseSession, audit: RequestAudit, input: Record<string, unknown>) {
      if (!Array.isArray(input.orders) || input.orders.length < 1 || input.orders.length > MAX_BATCH_SIZE) {
        throw new ApiError(400, 'VALIDATION_ERROR', `orders 每批需包含 1 到 ${MAX_BATCH_SIZE} 条`);
      }
      const receivedAt = dateValue(input.receivedAt, 'receivedAt');
      const entries = input.orders.map((value, index) => {
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ApiError(400, 'VALIDATION_ERROR', `orders[${index}] 必须是对象`);
        const row = value as Record<string, unknown>;
        return { orderId: uuid(row.orderId, `orders[${index}].orderId`), actualCartons: positiveInteger(row.actualCartons, 'actualCartons'),
          actualPackages: positiveInteger(row.actualPackages, 'actualPackages'), actualWeight: positiveWeight(row.actualWeight, 'actualWeight'),
          actualWeightUnit: weightUnit(row.actualWeightUnit, 'actualWeightUnit'), differenceReason: text(row.differenceReason, 'differenceReason', 500, false) };
      });
      if (new Set(entries.map(entry => entry.orderId)).size !== entries.length) throw new ApiError(400, 'DUPLICATE_BATCH_ORDER', '同一提货单不能在批次中重复');
      const id = randomUUID();
      const nextBatchNo = batchNo('IN');
      const connection = await mysql.getConnection();
      try {
        await connection.beginTransaction();
        await connection.execute(
          `INSERT INTO air_receipt_batches (id, batch_no, received_at, created_by_user_id, created_by_reference)
           VALUES (?, ?, ?, ?, ?)`, [id, nextBatchNo, receivedAt, session.userId, actor(session)],
        );
        for (const entry of entries) {
          const [orders] = await connection.execute<OrderRow[]>('SELECT * FROM air_pickup_orders WHERE id = ? LIMIT 1 FOR UPDATE', [entry.orderId]);
          const order = orders[0];
          if (!order || order.order_status !== 'RECORDED') throw new ApiError(409, 'AIR_PICKUP_NOT_RECEIVABLE', '批次包含不存在或已处理的提货单，整批未保存');
          const differs = receivingValuesDiffer({ forecastCartons: order.forecast_cartons, forecastPackages: order.forecast_packages,
            forecastWeight: Number(order.forecast_weight), forecastWeightUnit: order.forecast_weight_unit,
            actualCartons: entry.actualCartons, actualPackages: entry.actualPackages, actualWeight: entry.actualWeight,
            actualWeightUnit: entry.actualWeightUnit });
          if (differs && !entry.differenceReason) throw new ApiError(400, 'DIFFERENCE_REASON_REQUIRED', `${order.bill_no_display} 的实际值有差异，必须填写差异说明`);
          await connection.execute(
            `UPDATE air_pickup_orders SET order_status = 'RECEIVED', actual_cartons = ?, actual_packages = ?,
               actual_weight = ?, actual_weight_unit = ?, difference_reason = ?, receipt_batch_id = ?, received_at = ?,
               updated_by_user_id = ?, updated_by_reference = ?, version = version + 1 WHERE id = ?`,
            [entry.actualCartons, entry.actualPackages, entry.actualWeight, entry.actualWeightUnit,
              entry.differenceReason, id, receivedAt, session.userId, actor(session), entry.orderId],
          );
          await addEvent(connection, session, audit, { orderId: entry.orderId, receiptBatchId: id, eventType: 'ORDER_RECEIVED', reason: entry.differenceReason });
        }
        await connection.commit();
        return { id, batchNo: nextBatchNo, receivedAt: receivedAt.toISOString(), orderCount: entries.length };
      } catch (error) { await connection.rollback().catch(() => undefined); throw error; }
      finally { connection.release(); }
    },

    async storeReceiptEvidence(session: WarehouseSession, audit: RequestAudit, batchIdValue: unknown, input: {
      filename: unknown; qualityWarnings: unknown; qualityOverride: unknown; contentType?: string;
      sha256?: string; content: unknown;
    }) {
      const batchId = uuid(batchIdValue, 'batchId');
      const filename = text(input.filename, 'filename', 255)!;
      const warnings = Array.isArray(input.qualityWarnings) ? input.qualityWarnings.map(String).slice(0, 8) : [];
      const qualityOverride = input.qualityOverride === true || input.qualityOverride === 'true';
      if (warnings.length && !qualityOverride) throw new ApiError(400, 'QUALITY_OVERRIDE_REQUIRED', '图片存在清晰度警告，请确认后再上传');
      const image = validateAirEvidenceImage(input.content, input.contentType, input.sha256);
      const assetId = randomUUID();
      const extension = image.contentType === 'image/png' ? 'png' : 'jpg';
      const storageKey = `air-pickups/receipts/${batchId}/${image.sha256}.${extension}`;
      const connection = await mysql.getConnection();
      try {
        await connection.beginTransaction();
        const [batches] = await connection.execute<(RowDataPacket & { id: string })[]>(
          `SELECT id FROM air_receipt_batches WHERE id = ? LIMIT 1 FOR UPDATE`, [batchId],
        );
        if (!batches[0]) throw new ApiError(404, 'RECEIPT_BATCH_NOT_FOUND', '未找到入库批次');
        const [counts] = await connection.execute<(RowDataPacket & { count: number | string })[]>(
          `SELECT COUNT(*) AS count FROM air_receipt_evidence_assets
           WHERE receipt_batch_id = ? AND asset_status = 'READY' FOR UPDATE`, [batchId],
        );
        if (Number(counts[0]?.count ?? 0) >= 9) throw new ApiError(409, 'RECEIPT_EVIDENCE_LIMIT_REACHED', '入库照最多上传 9 张');
        await storage.put(storageKey, image.content);
        await connection.execute(
          `INSERT INTO air_receipt_evidence_assets
            (id, receipt_batch_id, original_filename, storage_key, content_sha256, content_type,
             byte_size, pixel_width, pixel_height, quality_warnings, quality_override,
             uploaded_by_user_id, uploaded_by_reference)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [assetId, batchId, filename, storageKey, image.sha256, image.contentType, image.content.length,
            image.width, image.height, warnings.length ? JSON.stringify(warnings) : null, qualityOverride,
            session.userId, actor(session)],
        );
        const [orders] = await connection.execute<(RowDataPacket & { id: string })[]>(
          `SELECT id FROM air_pickup_orders WHERE receipt_batch_id = ?`, [batchId],
        );
        for (const order of orders) await addEvent(connection, session, audit, {
          orderId: order.id, receiptBatchId: batchId, eventType: 'RECEIPT_EVIDENCE_ADDED', data: { assetId },
        });
        await connection.commit();
        return { id: assetId, type: 'RECEIPT' as const, filename, contentType: image.contentType,
          byteSize: image.content.length, width: image.width, height: image.height,
          qualityWarnings: warnings, qualityOverride,
          downloadPath: `/warehouse/v1/air-receipt-evidence-assets/${assetId}/content`, createdAt: new Date().toISOString() };
      } catch (error) { await connection.rollback().catch(() => undefined); throw error; }
      finally { connection.release(); }
    },

    async openReceiptEvidence(assetIdValue: unknown): Promise<{ metadata: ReceiptEvidenceRow; object: LabelStorageObject }> {
      const assetId = uuid(assetIdValue, 'assetId');
      const [rows] = await mysql.execute<ReceiptEvidenceRow[]>(
        `SELECT * FROM air_receipt_evidence_assets WHERE id = ? AND asset_status = 'READY' LIMIT 1`, [assetId],
      );
      if (!rows[0]) throw new ApiError(404, 'EVIDENCE_NOT_FOUND', '入库照不存在或已移除');
      const object = await storage.open(rows[0].storage_key).catch(() => {
        throw new ApiError(503, 'EVIDENCE_STORAGE_UNAVAILABLE', '入库照暂时不可用');
      });
      return { metadata: rows[0], object };
    },

    async storePickupDocument(session: WarehouseSession, audit: RequestAudit, orderIdValue: unknown, input: {
      filename: unknown; contentType?: string; sha256?: string; content: unknown;
    }) {
      const orderId = uuid(orderIdValue, 'orderId');
      const document = validatePickupDocument(input.content, input.filename, input.contentType, input.sha256);
      const assetId = randomUUID();
      const storageKey = `air-pickups/documents/${orderId}/${document.sha256}.${document.extension}`;
      const connection = await mysql.getConnection();
      try {
        await connection.beginTransaction();
        const [orders] = await connection.execute<OrderRow[]>('SELECT * FROM air_pickup_orders WHERE id = ? LIMIT 1 FOR UPDATE', [orderId]);
        if (!orders[0]) throw new ApiError(404, 'AIR_PICKUP_NOT_FOUND', '未找到空运提货单');
        if (orders[0].order_status === 'VOIDED') throw new ApiError(409, 'AIR_PICKUP_VOIDED', '已作废的提货单不能新增提货文件');
        const [counts] = await connection.execute<(RowDataPacket & { count: number | string })[]>(
          `SELECT COUNT(*) AS count FROM air_pickup_document_assets WHERE order_id = ? AND asset_status = 'READY' FOR UPDATE`, [orderId],
        );
        if (Number(counts[0]?.count ?? 0) >= MAX_PICKUP_DOCUMENTS) {
          throw new ApiError(409, 'PICKUP_DOCUMENT_LIMIT_REACHED', `每张提货单最多上传 ${MAX_PICKUP_DOCUMENTS} 个提货文件`);
        }
        const [duplicates] = await connection.execute<(RowDataPacket & { id: string })[]>(
          'SELECT id FROM air_pickup_document_assets WHERE order_id = ? AND content_sha256 = ? LIMIT 1 FOR UPDATE', [orderId, document.sha256],
        );
        if (duplicates[0]) throw new ApiError(409, 'DUPLICATE_PICKUP_DOCUMENT', '相同内容的提货文件已经上传');
        await storage.put(storageKey, document.content);
        await connection.execute(
          `INSERT INTO air_pickup_document_assets
            (id, order_id, original_filename, storage_key, content_sha256, content_type, byte_size, uploaded_by_user_id, uploaded_by_reference)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [assetId, orderId, document.filename, storageKey, document.sha256, document.contentType, document.content.length,
            session.userId, actor(session)],
        );
        await connection.execute(
          `UPDATE air_pickup_orders SET updated_by_user_id = ?, updated_by_reference = ?, version = version + 1 WHERE id = ?`,
          [session.userId, actor(session), orderId],
        );
        await addEvent(connection, session, audit, { orderId, eventType: 'PICKUP_DOCUMENT_ADDED', data: { assetId, filename: document.filename } });
        await connection.commit();
        return { id: assetId, filename: document.filename, contentType: document.contentType, byteSize: document.content.length,
          downloadPath: `/warehouse/v1/air-pickup-documents/${assetId}/content`, createdAt: new Date().toISOString() };
      } catch (error) { await connection.rollback().catch(() => undefined); throw error; }
      finally { connection.release(); }
    },

    async openPickupDocument(assetIdValue: unknown): Promise<{ metadata: PickupDocumentRow; object: LabelStorageObject }> {
      const assetId = uuid(assetIdValue, 'assetId');
      const [rows] = await mysql.execute<PickupDocumentRow[]>(
        `SELECT * FROM air_pickup_document_assets WHERE id = ? AND asset_status = 'READY' LIMIT 1`, [assetId],
      );
      if (!rows[0]) throw new ApiError(404, 'PICKUP_DOCUMENT_NOT_FOUND', '提货文件不存在或已移除');
      const object = await storage.open(rows[0].storage_key).catch(() => {
        throw new ApiError(503, 'PICKUP_DOCUMENT_STORAGE_UNAVAILABLE', '提货文件暂时不可用');
      });
      return { metadata: rows[0], object };
    },

    async removePickupDocument(session: WarehouseSession, audit: RequestAudit, assetIdValue: unknown, input: Record<string, unknown>) {
      const assetId = uuid(assetIdValue, 'assetId');
      const password = text(input.password, 'password', 1024)!;
      const reason = text(input.reason, 'reason', 500)!;
      if (!canCorrect(session)) throw new ApiError(403, 'PERMISSION_DENIED', '仅主管或系统管理员可移除提货文件');
      const connection = await mysql.getConnection();
      try {
        await connection.beginTransaction();
        const [users] = await connection.execute<(RowDataPacket & { password_hash: string })[]>('SELECT password_hash FROM warehouse_users WHERE id = ? LIMIT 1', [session.userId]);
        if (!users[0] || !(await verifyWarehousePassword(password, users[0].password_hash))) throw new ApiError(401, 'REAUTHENTICATION_FAILED', '操作密码错误');
        const [assets] = await connection.execute<PickupDocumentRow[]>(
          `SELECT * FROM air_pickup_document_assets WHERE id = ? AND asset_status = 'READY' LIMIT 1 FOR UPDATE`, [assetId],
        );
        const asset = assets[0];
        if (!asset) throw new ApiError(404, 'PICKUP_DOCUMENT_NOT_FOUND', '提货文件不存在或已移除');
        await connection.execute(
          `UPDATE air_pickup_document_assets SET asset_status = 'REMOVED', removed_by_user_id = ?,
             removed_by_reference = ?, removed_reason = ?, removed_at = CURRENT_TIMESTAMP(3) WHERE id = ?`,
          [session.userId, actor(session), reason, assetId],
        );
        await connection.execute(
          `UPDATE air_pickup_orders SET updated_by_user_id = ?, updated_by_reference = ?, version = version + 1 WHERE id = ?`,
          [session.userId, actor(session), asset.order_id],
        );
        await addEvent(connection, session, audit, { orderId: asset.order_id, eventType: 'PICKUP_DOCUMENT_REMOVED', reason, data: { assetId } });
        await connection.commit();
      } catch (error) { await connection.rollback().catch(() => undefined); throw error; }
      finally { connection.release(); }
    },

    async createHandoverDraft(session: WarehouseSession, audit: RequestAudit, input: Record<string, unknown>) {
      if (!Array.isArray(input.orderIds) || input.orderIds.length < 1 || input.orderIds.length > MAX_BATCH_SIZE) {
        throw new ApiError(400, 'VALIDATION_ERROR', `orderIds 每批需包含 1 到 ${MAX_BATCH_SIZE} 条`);
      }
      const orderIds = input.orderIds.map((value, index) => uuid(value, `orderIds[${index}]`));
      if (new Set(orderIds).size !== orderIds.length) throw new ApiError(400, 'DUPLICATE_BATCH_ORDER', '同一提货单不能在批次中重复');
      const vehicleNo = text(input.vehicleNo, 'vehicleNo', 64, false);
      const driverName = text(input.driverName, 'driverName', 100, false);
      const driverPhone = text(input.driverPhone, 'driverPhone', 32, false);
      const handedOverAt = dateValue(input.handedOverAt, 'handedOverAt');
      const id = randomUUID();
      const nextBatchNo = batchNo('HO');
      const connection = await mysql.getConnection();
      try {
        await connection.beginTransaction();
        await connection.execute(
          `INSERT INTO air_handover_batches
            (id, batch_no, vehicle_no, driver_name, driver_phone, handed_over_at, created_by_user_id, created_by_reference)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [id, nextBatchNo, vehicleNo, driverName, driverPhone, handedOverAt, session.userId, actor(session)],
        );
        for (const orderId of orderIds) {
          const [result] = await connection.execute(
            `UPDATE air_pickup_orders SET handover_batch_id = ?, updated_by_user_id = ?, updated_by_reference = ?, version = version + 1
             WHERE id = ? AND order_status = 'RECEIVED' AND handover_batch_id IS NULL`,
            [id, session.userId, actor(session), orderId],
          );
          if (!('affectedRows' in result) || result.affectedRows !== 1) {
            throw new ApiError(409, 'AIR_PICKUP_NOT_HANDOVER_READY', '批次包含未入库或已加入其他交仓批次的提货单，整批未保存');
          }
          await addEvent(connection, session, audit, { orderId, handoverBatchId: id, eventType: 'HANDOVER_DRAFT_CREATED' });
        }
        await connection.commit();
        return await this.getHandoverBatch(id);
      } catch (error) { await connection.rollback().catch(() => undefined); throw error; }
      finally { connection.release(); }
    },

    async getHandoverBatch(batchIdValue: unknown) {
      const batchId = uuid(batchIdValue, 'batchId');
      const [batches] = await mysql.execute<HandoverBatchRow[]>('SELECT * FROM air_handover_batches WHERE id = ? LIMIT 1', [batchId]);
      if (!batches[0]) throw new ApiError(404, 'HANDOVER_BATCH_NOT_FOUND', '未找到交仓批次');
      const [orders] = await mysql.execute<OrderRow[]>(`${ORDER_SELECT} WHERE o.handover_batch_id = ? ORDER BY o.bill_no_display`, [batchId]);
      const [assets] = await mysql.execute<EvidenceRow[]>(
        `SELECT * FROM air_handover_evidence_assets WHERE handover_batch_id = ? AND asset_status = 'READY'
         ORDER BY evidence_type, created_at`, [batchId],
      );
      const row = batches[0];
      return { id: row.id, batchNo: row.batch_no, status: row.batch_status, vehicleNo: row.vehicle_no,
        driverName: row.driver_name, driverPhone: row.driver_phone, handedOverAt: row.handed_over_at?.toISOString() ?? null,
        createdByUserId: row.created_by_user_id, version: row.version, confirmedAt: row.confirmed_at?.toISOString() ?? null,
        createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString(), orders: orders.map(toOrder),
        evidence: assets.map(handoverEvidenceView) };
    },

    async updateHandoverBatch(session: WarehouseSession, audit: RequestAudit, batchIdValue: unknown, input: Record<string, unknown>) {
      const batchId = uuid(batchIdValue, 'batchId');
      const expectedVersion = positiveInteger(input.expectedVersion, 'expectedVersion');
      if (!Array.isArray(input.orderIds) || input.orderIds.length < 1 || input.orderIds.length > MAX_BATCH_SIZE) {
        throw new ApiError(400, 'VALIDATION_ERROR', `orderIds 每批需包含 1 到 ${MAX_BATCH_SIZE} 条`);
      }
      const orderIds = input.orderIds.map((value, index) => uuid(value, `orderIds[${index}]`));
      if (new Set(orderIds).size !== orderIds.length) throw new ApiError(400, 'DUPLICATE_BATCH_ORDER', '同一提货单不能在批次中重复');
      const vehicleNo = text(input.vehicleNo, 'vehicleNo', 64, false);
      const driverName = text(input.driverName, 'driverName', 100, false);
      const driverPhone = text(input.driverPhone, 'driverPhone', 32, false);
      const handedOverAt = dateValue(input.handedOverAt, 'handedOverAt');
      const reason = input.reason === undefined ? null : text(input.reason, 'reason', 500, false);
      const password = input.password === undefined ? null : text(input.password, 'password', 1024, false);
      const connection = await mysql.getConnection();
      try {
        await connection.beginTransaction();
        const [batches] = await connection.execute<HandoverBatchRow[]>('SELECT * FROM air_handover_batches WHERE id = ? LIMIT 1 FOR UPDATE', [batchId]);
        const batch = batches[0];
        if (!batch) throw new ApiError(404, 'HANDOVER_BATCH_NOT_FOUND', '未找到交仓批次');
        if (batch.version !== expectedVersion) throw new ApiError(409, 'HANDOVER_VERSION_CONFLICT', '交仓批次已被其他人修改，请刷新');
        const confirmed = batch.batch_status === 'CONFIRMED';
        if (!confirmed && batch.created_by_user_id !== session.userId && !canCorrect(session)) {
          throw new ApiError(403, 'HANDOVER_DRAFT_OWNER_REQUIRED', '仅草稿创建人或主管可编辑该批次');
        }
        if (confirmed) {
          if (!canCorrect(session)) throw new ApiError(403, 'PERMISSION_DENIED', '已确认批次仅允许主管或系统管理员更正');
          if (!reason || !password) throw new ApiError(400, 'REAUTHENTICATION_REQUIRED', '更正已确认批次必须填写原因并验证当前账户密码');
          const [users] = await connection.execute<(RowDataPacket & { password_hash: string })[]>('SELECT password_hash FROM warehouse_users WHERE id = ? LIMIT 1', [session.userId]);
          if (!users[0] || !(await verifyWarehousePassword(password, users[0].password_hash))) throw new ApiError(401, 'REAUTHENTICATION_FAILED', '操作密码错误');
        }
        const [existing] = await connection.execute<OrderRow[]>('SELECT * FROM air_pickup_orders WHERE handover_batch_id = ? FOR UPDATE', [batchId]);
        const existingIds = new Set(existing.map(order => order.id));
        const targetIds = new Set(orderIds);
        const evidenceStatus = await recalculateEvidence(connection, batchId);
        for (const orderId of orderIds) {
          const [rows] = await connection.execute<OrderRow[]>('SELECT * FROM air_pickup_orders WHERE id = ? LIMIT 1 FOR UPDATE', [orderId]);
          const order = rows[0];
          const alreadyMember = existingIds.has(orderId);
          if (!order || (!alreadyMember && (order.order_status !== 'RECEIVED' || order.handover_batch_id !== null))) {
            throw new ApiError(409, 'AIR_PICKUP_NOT_HANDOVER_READY', '成员变更包含未入库或已加入其他交仓批次的提货单，整批未保存');
          }
          if (!alreadyMember) {
            await connection.execute(
              `UPDATE air_pickup_orders SET handover_batch_id = ?,
                 order_status = ?, handed_over_at = ?, evidence_status = ?, updated_by_user_id = ?,
                 updated_by_reference = ?, version = version + 1 WHERE id = ?`,
              [batchId, confirmed ? 'HANDED_OVER' : 'RECEIVED', confirmed ? handedOverAt : null,
                confirmed ? evidenceStatus : 'NONE', session.userId, actor(session), orderId],
            );
          }
          await addEvent(connection, session, audit, { orderId, handoverBatchId: batchId,
            eventType: confirmed ? 'ORDER_CORRECTED' : 'HANDOVER_DRAFT_CREATED', reason,
            data: { action: alreadyMember ? 'BATCH_DETAILS_UPDATED' : 'ADDED_TO_BATCH' } });
        }
        for (const order of existing) {
          if (targetIds.has(order.id)) continue;
          await connection.execute(
            `UPDATE air_pickup_orders SET handover_batch_id = NULL, order_status = 'RECEIVED', handed_over_at = NULL,
               evidence_status = 'NONE', updated_by_user_id = ?, updated_by_reference = ?, version = version + 1 WHERE id = ?`,
            [session.userId, actor(session), order.id],
          );
          await addEvent(connection, session, audit, { orderId: order.id, handoverBatchId: batchId,
            eventType: 'ORDER_CORRECTED', reason, data: { action: 'REMOVED_FROM_BATCH' } });
        }
        await connection.execute(
          `UPDATE air_handover_batches SET vehicle_no = ?, driver_name = ?, driver_phone = ?, handed_over_at = ?,
             version = version + 1 WHERE id = ? AND version = ?`,
          [vehicleNo, driverName, driverPhone, handedOverAt, batchId, expectedVersion],
        );
        if (confirmed) {
          await connection.execute(
            `UPDATE air_pickup_orders SET handed_over_at = ?, evidence_status = ?, updated_by_user_id = ?,
               updated_by_reference = ?, version = version + 1 WHERE handover_batch_id = ?`,
            [handedOverAt, evidenceStatus, session.userId, actor(session), batchId],
          );
        }
        await connection.commit();
        return await this.getHandoverBatch(batchId);
      } catch (error) { await connection.rollback().catch(() => undefined); throw error; }
      finally { connection.release(); }
    },

    async confirmHandoverBatch(session: WarehouseSession, audit: RequestAudit, batchIdValue: unknown) {
      const batchId = uuid(batchIdValue, 'batchId');
      const connection = await mysql.getConnection();
      try {
        await connection.beginTransaction();
        const [batches] = await connection.execute<HandoverBatchRow[]>('SELECT * FROM air_handover_batches WHERE id = ? LIMIT 1 FOR UPDATE', [batchId]);
        const batch = batches[0];
        if (!batch) throw new ApiError(404, 'HANDOVER_BATCH_NOT_FOUND', '未找到交仓批次');
        if (batch.batch_status !== 'DRAFT') throw new ApiError(409, 'HANDOVER_ALREADY_CONFIRMED', '该交仓批次已经确认');
        if (batch.created_by_user_id !== session.userId && !canCorrect(session)) throw new ApiError(403, 'HANDOVER_DRAFT_OWNER_REQUIRED', '仅草稿创建人或主管可确认该批次');
        const [orders] = await connection.execute<OrderRow[]>('SELECT * FROM air_pickup_orders WHERE handover_batch_id = ? FOR UPDATE', [batchId]);
        if (!orders.length || orders.some(order => order.order_status !== 'RECEIVED')) throw new ApiError(409, 'HANDOVER_BATCH_INVALID', '交仓批次中的提货单状态已变化，整批未确认');
        const status = await recalculateEvidence(connection, batchId);
        const confirmedAt = batch.handed_over_at ?? new Date();
        await connection.execute(
          `UPDATE air_handover_batches SET batch_status = 'CONFIRMED', confirmed_by_user_id = ?,
             confirmed_by_reference = ?, confirmed_at = CURRENT_TIMESTAMP(3), version = version + 1 WHERE id = ?`,
          [session.userId, actor(session), batchId],
        );
        await connection.execute(
          `UPDATE air_pickup_orders SET order_status = 'HANDED_OVER', handed_over_at = ?, evidence_status = ?,
             updated_by_user_id = ?, updated_by_reference = ?, version = version + 1 WHERE handover_batch_id = ?`,
          [confirmedAt, status, session.userId, actor(session), batchId],
        );
        for (const order of orders) await addEvent(connection, session, audit, { orderId: order.id, handoverBatchId: batchId, eventType: 'ORDER_HANDED_OVER', data: { evidenceStatus: status } });
        await connection.commit();
        return await this.getHandoverBatch(batchId);
      } catch (error) { await connection.rollback().catch(() => undefined); throw error; }
      finally { connection.release(); }
    },

    async storeEvidence(session: WarehouseSession, audit: RequestAudit, batchIdValue: unknown, input: {
      type: unknown; filename: unknown; qualityWarnings: unknown; qualityOverride: unknown; contentType?: string;
      sha256?: string; content: unknown;
    }) {
      const batchId = uuid(batchIdValue, 'batchId');
      const type = text(input.type, 'type', 16)! as 'POD' | 'LOADING';
      if (type !== 'POD' && type !== 'LOADING') throw new ApiError(400, 'VALIDATION_ERROR', 'type 仅支持 POD 或 LOADING');
      const filename = text(input.filename, 'filename', 255)!;
      const warnings = Array.isArray(input.qualityWarnings) ? input.qualityWarnings.map(String).slice(0, 8) : [];
      const qualityOverride = input.qualityOverride === true || input.qualityOverride === 'true';
      if (warnings.length && !qualityOverride) throw new ApiError(400, 'QUALITY_OVERRIDE_REQUIRED', '图片存在清晰度警告，请确认后再上传');
      const image = validateAirEvidenceImage(input.content, input.contentType, input.sha256);
      const assetId = randomUUID();
      const extension = image.contentType === 'image/png' ? 'png' : 'jpg';
      const storageKey = `air-pickups/${batchId}/${image.sha256}.${extension}`;
      const connection = await mysql.getConnection();
      try {
        await connection.beginTransaction();
        const [batches] = await connection.execute<HandoverBatchRow[]>('SELECT * FROM air_handover_batches WHERE id = ? LIMIT 1 FOR UPDATE', [batchId]);
        if (!batches[0]) throw new ApiError(404, 'HANDOVER_BATCH_NOT_FOUND', '未找到交仓批次');
        const [counts] = await connection.execute<(RowDataPacket & { count: number | string })[]>(
          `SELECT COUNT(*) AS count FROM air_handover_evidence_assets
           WHERE handover_batch_id = ? AND evidence_type = ? AND asset_status = 'READY' FOR UPDATE`, [batchId, type],
        );
        if (Number(counts[0]?.count ?? 0) >= 9) throw new ApiError(409, 'EVIDENCE_LIMIT_REACHED', `${type === 'POD' ? 'POD' : '装车照'}最多上传 9 张`);
        await storage.put(storageKey, image.content);
        await connection.execute(
          `INSERT INTO air_handover_evidence_assets
            (id, handover_batch_id, evidence_type, original_filename, storage_key, content_sha256,
             content_type, byte_size, pixel_width, pixel_height, quality_warnings, quality_override,
             uploaded_by_user_id, uploaded_by_reference)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [assetId, batchId, type, filename, storageKey, image.sha256, image.contentType, image.content.length,
            image.width, image.height, warnings.length ? JSON.stringify(warnings) : null, qualityOverride,
            session.userId, actor(session)],
        );
        const status = await recalculateEvidence(connection, batchId);
        const [orders] = await connection.execute<(RowDataPacket & { id: string })[]>('SELECT id FROM air_pickup_orders WHERE handover_batch_id = ?', [batchId]);
        for (const order of orders) await addEvent(connection, session, audit, { orderId: order.id, handoverBatchId: batchId, eventType: 'EVIDENCE_ADDED', data: { assetId, type, evidenceStatus: status } });
        await connection.commit();
        return { id: assetId, type, evidenceStatus: status, contentType: image.contentType, byteSize: image.content.length,
          width: image.width, height: image.height, downloadPath: `/warehouse/v1/air-evidence-assets/${assetId}/content` };
      } catch (error) { await connection.rollback().catch(() => undefined); throw error; }
      finally { connection.release(); }
    },

    async openEvidence(assetIdValue: unknown): Promise<{ metadata: EvidenceRow; object: LabelStorageObject }> {
      const assetId = uuid(assetIdValue, 'assetId');
      const [rows] = await mysql.execute<EvidenceRow[]>(
        `SELECT * FROM air_handover_evidence_assets WHERE id = ? AND asset_status = 'READY' LIMIT 1`, [assetId],
      );
      if (!rows[0]) throw new ApiError(404, 'EVIDENCE_NOT_FOUND', '凭证不存在或已移除');
      const object = await storage.open(rows[0].storage_key).catch(() => { throw new ApiError(503, 'EVIDENCE_STORAGE_UNAVAILABLE', '凭证文件暂时不可用'); });
      return { metadata: rows[0], object };
    },

    async removeEvidence(session: WarehouseSession, audit: RequestAudit, assetIdValue: unknown, input: Record<string, unknown>) {
      const assetId = uuid(assetIdValue, 'assetId');
      const password = text(input.password, 'password', 1024)!;
      const reason = text(input.reason, 'reason', 500)!;
      if (!canCorrect(session)) throw new ApiError(403, 'PERMISSION_DENIED', '仅主管或系统管理员可移除凭证');
      const connection = await mysql.getConnection();
      try {
        await connection.beginTransaction();
        const [users] = await connection.execute<(RowDataPacket & { password_hash: string })[]>('SELECT password_hash FROM warehouse_users WHERE id = ? LIMIT 1', [session.userId]);
        if (!users[0] || !(await verifyWarehousePassword(password, users[0].password_hash))) throw new ApiError(401, 'REAUTHENTICATION_FAILED', '操作密码错误');
        const [assets] = await connection.execute<EvidenceRow[]>('SELECT * FROM air_handover_evidence_assets WHERE id = ? AND asset_status = \'READY\' LIMIT 1 FOR UPDATE', [assetId]);
        if (!assets[0]) throw new ApiError(404, 'EVIDENCE_NOT_FOUND', '凭证不存在或已移除');
        await connection.execute(
          `UPDATE air_handover_evidence_assets SET asset_status = 'REMOVED', removed_by_user_id = ?,
             removed_by_reference = ?, removal_reason = ?, removed_at = CURRENT_TIMESTAMP(3) WHERE id = ?`,
          [session.userId, actor(session), reason, assetId],
        );
        const status = await recalculateEvidence(connection, assets[0].handover_batch_id);
        const [orders] = await connection.execute<(RowDataPacket & { id: string })[]>('SELECT id FROM air_pickup_orders WHERE handover_batch_id = ?', [assets[0].handover_batch_id]);
        for (const order of orders) await addEvent(connection, session, audit, { orderId: order.id, handoverBatchId: assets[0].handover_batch_id,
          eventType: 'EVIDENCE_REMOVED', reason, data: { assetId, evidenceStatus: status } });
        await connection.commit();
        return { evidenceStatus: status };
      } catch (error) { await connection.rollback().catch(() => undefined); throw error; }
      finally { connection.release(); }
    },

    async voidOrder(session: WarehouseSession, audit: RequestAudit, orderIdValue: unknown, input: Record<string, unknown>) {
      const orderId = uuid(orderIdValue, 'orderId');
      const password = text(input.password, 'password', 1024)!;
      const reason = text(input.reason, 'reason', 500)!;
      if (!canCorrect(session)) throw new ApiError(403, 'PERMISSION_DENIED', '仅主管或系统管理员可作废提货单');
      const connection = await mysql.getConnection();
      try {
        await connection.beginTransaction();
        const [users] = await connection.execute<(RowDataPacket & { password_hash: string })[]>('SELECT password_hash FROM warehouse_users WHERE id = ? LIMIT 1', [session.userId]);
        if (!users[0] || !(await verifyWarehousePassword(password, users[0].password_hash))) throw new ApiError(401, 'REAUTHENTICATION_FAILED', '操作密码错误');
        const [result] = await connection.execute(
          `UPDATE air_pickup_orders SET order_status = 'VOIDED', void_reason = ?, voided_at = CURRENT_TIMESTAMP(3),
             updated_by_user_id = ?, updated_by_reference = ?, version = version + 1
           WHERE id = ? AND order_status <> 'VOIDED' AND handover_batch_id IS NULL`,
          [reason, session.userId, actor(session), orderId],
        );
        if (!('affectedRows' in result) || result.affectedRows !== 1) throw new ApiError(409, 'AIR_PICKUP_NOT_VOIDABLE', '提货单已作废或已加入交仓批次，不能直接作废');
        await addEvent(connection, session, audit, { orderId, eventType: 'ORDER_VOIDED', reason });
        await connection.commit();
      } catch (error) { await connection.rollback().catch(() => undefined); throw error; }
      finally { connection.release(); }
    },
  };
}

export type AirPickupOperations = ReturnType<typeof createAirPickupOperations>;
