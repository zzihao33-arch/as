import { createHash } from 'node:crypto';
import { ApiError } from './errors.js';

export type DocumentCapabilities = { view: boolean; download: boolean; add: boolean; manage: boolean };
export const DOCUMENT_POLICY = { policyVersion: 't4-candidate-1', allowedExtensions: ['.pdf', '.doc', '.docx', '.xls', '.xlsx', '.jpg', '.jpeg', '.png'],
  maxFileBytes: 26214400, maxActiveFiles: 20, maxActiveBytes: 209715200, clientConcurrency: 2, previewTypes: ['application/pdf', 'image/jpeg', 'image/png'] };
export type DocumentPolicy = typeof DOCUMENT_POLICY & { enabled: boolean; capabilities: DocumentCapabilities };
export type DocumentRegistration = { uploadId: string; filename: string; byteSize: number; sha256: string; declaredContentType: string;
  policyVersion: string; supersedesAssetId: string | null; expectedAssetVersion: number | null; reason: string | null };
// An implementation MUST fully parse the container/document and run malware checks in a bounded,
// network-isolated process. A signature detector is not a checker. There is deliberately no permissive default.
export type DocumentChecker = (bytes: Buffer, expectedContentType: string, signal: AbortSignal) => Promise<{ clean: boolean; validated: boolean; contentType: string }>;
export const DOCUMENT_MIMES: Record<string, string> = { pdf: 'application/pdf', doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png' };
export function fitsDocumentQuota(count: number, bytes: number, limit: { count: number; bytes: number }): boolean {
  return Number.isSafeInteger(count) && Number.isSafeInteger(bytes) && count >= 0 && bytes >= 0 && count <= limit.count && bytes <= limit.bytes;
}
export function documentId(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) throw new ApiError(400, 'DOCUMENT_INVALID_REQUEST', '文档标识无效。');
  return value.toLowerCase();
}
export function normalizeDocumentRegistration(input: Record<string, unknown>, enforceCurrentLimit = true): DocumentRegistration {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['uploadId', 'filename', 'byteSize', 'sha256', 'declaredContentType', 'policyVersion', 'supersedesAssetId', 'expectedAssetVersion', 'reason', 'password'].includes(key))) throw new ApiError(400, 'DOCUMENT_INVALID_REQUEST', '文档注册参数无效。');
  const filename = typeof input.filename === 'string' ? input.filename.normalize('NFC').trim() : '';
  if (!filename || filename.length > 240 || /[\x00-\x1f\x7f/\\]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(filename)) throw new ApiError(400, 'DOCUMENT_INVALID_FILENAME', '文件名无效或过长。');
  const ext = filename.split('.').pop()!.toLowerCase();
  if (!DOCUMENT_MIMES[ext]) throw new ApiError(415, 'DOCUMENT_TYPE_UNSUPPORTED', '文件扩展名不受支持。');
  const byteSize = input.byteSize;
  if (!Number.isSafeInteger(byteSize) || Number(byteSize) <= 0) throw new ApiError(400, 'DOCUMENT_INVALID_LENGTH', '文件长度无效。');
  if (enforceCurrentLimit && Number(byteSize) > DOCUMENT_POLICY.maxFileBytes) throw new ApiError(413, 'DOCUMENT_TOO_LARGE', '单文件不能超过 25 MiB。');
  if (typeof input.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(input.sha256)) throw new ApiError(400, 'DOCUMENT_INVALID_HASH', '文件摘要无效。');
  if (input.declaredContentType !== DOCUMENT_MIMES[ext]) throw new ApiError(415, 'DOCUMENT_MIME_MISMATCH', '声明类型与扩展名不一致。');
  if (typeof input.policyVersion !== 'string' || input.policyVersion.length > 64) throw new ApiError(400, 'DOCUMENT_INVALID_POLICY', '策略版本无效。');
  const replacement = input.supersedesAssetId != null;
  const reason = typeof input.reason === 'string' ? input.reason.trim() : null;
  if (replacement && (!Number.isSafeInteger(input.expectedAssetVersion) || Number(input.expectedAssetVersion) < 1 || !reason || reason.length > 1000)) throw new ApiError(400, 'DOCUMENT_REPLACEMENT_INVALID', '替换须提供当前版本和原因。');
  return { uploadId: documentId(input.uploadId), filename, byteSize: Number(byteSize), sha256: input.sha256.toLowerCase(), declaredContentType: String(input.declaredContentType),
    policyVersion: input.policyVersion, supersedesAssetId: replacement ? documentId(input.supersedesAssetId) : null,
    expectedAssetVersion: replacement ? Number(input.expectedAssetVersion) : null, reason: replacement ? reason : null };
}
function invalid(): never { throw new ApiError(422, 'DOCUMENT_CONTENT_INVALID', '文件损坏、加密或真实类型与扩展名不一致。'); }
export async function validateDocumentContent(bytes: Buffer, input: DocumentRegistration, checker?: DocumentChecker, signal = new AbortController().signal): Promise<string> {
  if (bytes.length !== input.byteSize || bytes.length > DOCUMENT_POLICY.maxFileBytes) throw new ApiError(422, 'DOCUMENT_LENGTH_MISMATCH', '接收长度与声明不一致。');
  if (createHash('sha256').update(bytes).digest('hex') !== input.sha256) throw new ApiError(422, 'DOCUMENT_HASH_MISMATCH', '文件摘要校验失败。');
  const ext = input.filename.split('.').pop()!.toLowerCase(), mime = DOCUMENT_MIMES[ext];
  if (!checker) throw new ApiError(503, 'DOCUMENT_CHECK_UNAVAILABLE', '受限文档检查服务尚不可用，原件未保存。');
  let check: Awaited<ReturnType<DocumentChecker>>;
  try { check = await checker(bytes, mime, signal); } catch { throw new ApiError(503, 'DOCUMENT_CHECK_UNAVAILABLE', '文档检查服务不可用。'); }
  if (!check.clean || !check.validated || check.contentType !== mime || input.declaredContentType !== mime) invalid();
  if (createHash('sha256').update(bytes).digest('hex') !== input.sha256) throw new ApiError(422, 'DOCUMENT_HASH_MISMATCH', '检查器改变了原件字节，文件未保存。');
  return mime;
}
