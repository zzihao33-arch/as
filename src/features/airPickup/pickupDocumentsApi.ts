import { warehouseRequest, warehouseFetch, WAREHOUSE_API_BASE, WarehouseApiError } from '../session/warehouseApi';
import { guardSessionRequest, assertCurrentSession, warehouseSessionFence } from '../session/sessionRecovery';
import type { UploadResult } from './pickupDocumentRecovery';

export type DocumentCapabilities = { view: boolean; download: boolean; add: boolean; manage: boolean };
export type DocumentPolicy = { enabled: boolean; policyVersion: string; allowedExtensions: string[]; maxFileBytes: number;
  maxActiveFiles: number; maxActiveBytes: number; clientConcurrency: number; previewTypes: string[]; capabilities: DocumentCapabilities };
export type DocumentAsset = { assetId: string; orderId: string; filename: string; contentType: string; byteSize: number;
  assetStatus: 'READY' | 'REMOVED' | 'SUPERSEDED'; assetVersion: number; uploadedBy: string; uploadedAt: string;
  preview: { status: string; generation: number; pageCount: number | null; errorCode: string | null };
  capabilities: DocumentCapabilities };
export type DocumentList = { items: DocumentAsset[]; savedCount: number; activeBytes: number; documentsRevision: number;
  capabilities: DocumentCapabilities; nextCursor: string | null };
export type Replacement = { supersedesAssetId: string; expectedAssetVersion: number; reason: string; password: string };
const base = (orderId: string) => `/warehouse/v1/air-pickups/${encodeURIComponent(orderId)}`;
async function json<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await warehouseRequest<{ data: T }>(path, { ...init, signal: AbortSignal.timeout(25_000) });
  return response.data;
}
export const getDocumentPolicy = () => json<DocumentPolicy>('/warehouse/v1/air-pickup-document-policy');
export function listPickupDocuments(orderId: string, includeHistory: boolean, cursor?: string) {
  const query = new URLSearchParams({ includeHistory: String(includeHistory), limit: '50' });
  if (cursor) query.set('cursor', cursor);
  return json<DocumentList>(`${base(orderId)}/documents?${query}`);
}
const mimeTypes: Record<string, string> = { pdf: 'application/pdf', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
  doc: 'application/msword', xls: 'application/vnd.ms-excel',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' };
export async function registerPickupDocument(orderId: string, uploadId: string, file: File, policyVersion: string, replacement?: Replacement,
  prepared?: (metadata: Record<string, unknown>) => void) {
  const epoch = warehouseSessionFence.current();
  const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
  assertCurrentSession(epoch);
  const sha256 = Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
  const metadata = {
    uploadId, filename: file.name, byteSize: file.size, sha256, policyVersion,
    declaredContentType: file.type || mimeTypes[file.name.split('.').pop()!.toLowerCase()] || 'application/octet-stream', ...replacement,
  };
  prepared?.(metadata);
  return json<UploadResult>(`${base(orderId)}/document-uploads`, { method: 'POST', body: JSON.stringify(metadata) });
}
export async function reregisterPickupDocument(orderId: string, uploadId: string, file: File, original?: Record<string, unknown>, password?: string) {
  let metadata: Record<string, unknown> | undefined;
  try { metadata = (await queryPickupDocument(orderId, uploadId) as UploadResult & { registration?: Record<string, unknown> }).registration; }
  catch (error) { if (!(error instanceof WarehouseApiError && error.status === 404 && original)) throw error; metadata = original; }
  if (!metadata) throw new Error('暂时无法取得原文件信息，请继续核对。');
  const epoch = warehouseSessionFence.current();
  const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
  assertCurrentSession(epoch);
  const sha256 = Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
  if (sha256 !== metadata.sha256 || file.size !== metadata.byteSize) throw Object.assign(new Error('请选择与原上传内容完全相同的文件。'), { code: 'LOCAL_DOCUMENT_MISMATCH' });
  // Repeat only the server's original metadata; replacements keep their original version chain.
  return json<UploadResult>(`${base(orderId)}/document-uploads`, { method: 'POST', body: JSON.stringify({ ...metadata, uploadId, ...(password ? { password } : {}) }) });
}
export function putPickupDocument(orderId: string, uploadId: string, file: Blob, attempt: number, retryOfAttempt?: number) {
  return json<UploadResult>(`${base(orderId)}/document-uploads/${encodeURIComponent(uploadId)}/content`, {
    method: 'PUT', headers: { 'Content-Type': 'application/octet-stream', 'X-Upload-Attempt': String(attempt),
      ...(retryOfAttempt === undefined ? {} : { 'X-Retry-Of-Attempt': String(retryOfAttempt) }) }, body: file,
  });
}
export const queryPickupDocument = (orderId: string, uploadId: string) =>
  json<UploadResult>(`${base(orderId)}/document-uploads/${encodeURIComponent(uploadId)}`);
export function removePickupDocument(orderId: string, assetId: string, input: {
  operationId: string; expectedAssetVersion: number; reason: string; password: string;
}) {
  return json<{ documentsRevision: number }>(`${base(orderId)}/documents/${encodeURIComponent(assetId)}/removals`, {
    method: 'POST', body: JSON.stringify(input),
  });
}
export async function readPickupDocument(asset: DocumentAsset, download: boolean): Promise<Blob> {
  const path = `${base(asset.orderId)}/documents/${encodeURIComponent(asset.assetId)}/content?variant=${download ? 'original' : 'preview'}&disposition=${download ? 'attachment' : 'inline'}`;
  return guardSessionRequest(path, async () => {
    const response = await warehouseFetch(`${WAREHOUSE_API_BASE}${path}`, { credentials: 'include', signal: AbortSignal.timeout(30_000) });
    if (!response.ok) {
      const payload = await response.json().catch(() => null);
      throw new WarehouseApiError(response.status, payload?.error?.code ?? 'DOCUMENT_READ_FAILED', payload?.error?.message ?? '文件暂时无法读取');
    }
    return response.blob();
  });
}
