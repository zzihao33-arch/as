const configuredApiBase = import.meta.env.VITE_CMHUB_API_BASE_URL?.trim();
export const WAREHOUSE_API_BASE = (configuredApiBase || (import.meta.env.DEV ? 'http://127.0.0.1:8080' : 'https://api.cmhubtool.com')).replace(/\/$/, '');
export const WAREHOUSE_MOCK_API_ENABLED = import.meta.env.DEV && import.meta.env.VITE_CMHUB_MOCK_API === 'true';

export interface WarehouseWorkspace {
  warehouseId: string;
  warehouseCode: string;
  warehouseName: string;
  membershipId: string | null;
  roleId: string | null;
  roleName: string | null;
}
export interface WarehouseSessionView {
  sessionId: string;
  userId: string;
  userName: string;
  loginName: string;
  email: string | null;
  phone: string | null;
  platformRole: 'SYSTEM_ADMIN' | null;
  passwordState: 'ACTIVE' | 'CHANGE_REQUIRED';
  warehouseId: string | null;
  warehouseCode: string | null;
  warehouseName: string | null;
  membershipId: string | null;
  roleId: string | null;
  roleName: string | null;
  permissions: string[];
  workspaces: WarehouseWorkspace[];
  expiresAt: string;
  absoluteExpiresAt: string;
}
export interface WarehouseWorkstation {
  id: string;
  installationId: string;
  displayName: string;
}
export interface WarehouseShipment {
  id: string;
  firstLegTrackingNo: string;
  courierTrackingNo: string | null;
  carrier: string | null;
  status: string;
  version: number;
  updatedAt: string;
  labelAsset: null | { id: string; sha256: string; byteSize: number; downloadPath: string };
}
export class WarehouseApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  if (WAREHOUSE_MOCK_API_ENABLED) {
    const { mockWarehouseRequest } = await import('./warehouseMockApi');
    return mockWarehouseRequest<T>(path, init);
  }
  const response = await fetch(`${WAREHOUSE_API_BASE}${path}`, {
    ...init,
    credentials: 'include',
    headers: { ...(init.body ? { 'Content-Type': 'application/json' } : {}), ...init.headers },
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => null) as { error?: { code?: string; message?: string } } | null;
    throw new WarehouseApiError(response.status, payload?.error?.code ?? 'REQUEST_FAILED', payload?.error?.message ?? '云端请求失败');
  }
  return response.status === 204 ? undefined as T : response.json() as Promise<T>;
}

export async function getWarehouseSession(): Promise<WarehouseSessionView | null> {
  try {
    const result = await request<{ data: WarehouseSessionView }>('/warehouse/v1/session');
    return result.data;
  } catch (error) {
    if (error instanceof WarehouseApiError && error.status === 401) return null;
    throw error;
  }
}

export async function createWarehouseSession(input: { loginName: string; password: string }) {
  const result = await request<{ data: WarehouseSessionView }>('/warehouse/v1/sessions', {
    method: 'POST', body: JSON.stringify(input),
  });
  return result.data;
}

export async function renewWarehouseSession() {
  const result = await request<{ data: WarehouseSessionView }>('/warehouse/v1/session/renew', { method: 'POST' });
  return result.data;
}

export async function selectWarehouseWorkspace(warehouseId: string) {
  const result = await request<{ data: WarehouseSessionView }>('/warehouse/v1/session/workspace', {
    method: 'PATCH', body: JSON.stringify({ warehouseId }),
  });
  return result.data;
}

export function changeWarehousePassword(input: { currentPassword: string; newPassword: string }): Promise<void> {
  return request('/warehouse/v1/session/password', { method: 'POST', body: JSON.stringify(input) });
}

export function deleteWarehouseSession(): Promise<void> {
  return request('/warehouse/v1/session', { method: 'DELETE' });
}

export async function registerWarehouseWorkstation(input: { installationId: string; displayName: string }) {
  const result = await request<{ data: WarehouseWorkstation }>('/warehouse/v1/workstations', {
    method: 'POST', body: JSON.stringify(input),
  });
  return result.data;
}

export async function listWarehouseShipments(cursor: string | null, limit = 200) {
  const query = new URLSearchParams({ limit: String(limit) });
  if (cursor) query.set('cursor', cursor);
  return request<{ data: WarehouseShipment[]; cursor: string | null; hasMore: boolean }>(`/warehouse/v1/shipments?${query}`);
}

export async function downloadWarehouseLabel(downloadPath: string): Promise<Blob> {
  if (WAREHOUSE_MOCK_API_ENABLED) {
    const { mockDownloadWarehouseLabel } = await import('./warehouseMockApi');
    return mockDownloadWarehouseLabel(downloadPath);
  }
  const response = await fetch(`${WAREHOUSE_API_BASE}${downloadPath}`, { credentials: 'include' });
  if (!response.ok) {
    const payload = await response.json().catch(() => null) as { error?: { code?: string; message?: string } } | null;
    throw new WarehouseApiError(response.status, payload?.error?.code ?? 'LABEL_DOWNLOAD_FAILED', payload?.error?.message ?? '面单下载失败');
  }
  return response.blob();
}

export function submitWarehousePrintAttempt(input: {
  workstationId: string;
  shipmentId: string;
  labelAssetId: string;
  clientAttemptId: string;
  outcome: 'SUBMITTED' | 'FAILED' | 'RESULT_UNKNOWN' | 'BLOCKED';
  printerName?: string;
  message?: string;
  occurredAt: string;
}): Promise<unknown> {
  return request('/warehouse/v1/print-attempts', { method: 'POST', body: JSON.stringify(input) });
}

export interface WarehouseAccount {
  id: string;
  loginName: string;
  displayName: string;
  email: string | null;
  phone: string | null;
  status: 'ACTIVE' | 'DISABLED';
  platformRole: 'SYSTEM_ADMIN' | null;
  passwordState: 'ACTIVE' | 'CHANGE_REQUIRED';
  lastLoginAt: string | null;
  createdAt: string;
  memberships: Array<{
    id: string;
    warehouseId: string;
    warehouseCode: string;
    warehouseName: string;
    employeeNo: string | null;
    status: 'ACTIVE' | 'DISABLED';
    roleId: string | null;
    roleName: string | null;
  }>;
}

export interface WarehouseRoleView {
  id: string;
  code: string;
  name: string;
  description: string | null;
  kind: 'DEFAULT' | 'CUSTOM';
  version: number;
  employeeCount: number;
  permissions: string[];
  createdAt: string;
  updatedAt: string;
}

export interface WarehousePermissionView {
  code: string;
  module: string;
  name: string;
  riskLevel: 'LOW' | 'MEDIUM' | 'HIGH';
}

export async function listWarehouseAccounts(filters: { search?: string; status?: string; roleId?: string; page?: number; pageSize?: number } = {}) {
  const query = new URLSearchParams();
  Object.entries(filters).forEach(([key, value]) => { if (value !== undefined && value !== '') query.set(key, String(value)); });
  return request<{ data: WarehouseAccount[]; pagination: { total: number; page: number; pageSize: number } }>(`/warehouse/v1/accounts?${query}`);
}

export async function createWarehouseAccount(input: {
  loginName: string; displayName: string; phone?: string; email?: string;
  employeeNo?: string; warehouseId: string; roleId: string;
}) {
  const result = await request<{ data: { id: string; loginName: string; displayName: string; temporaryPassword: string } }>('/warehouse/v1/accounts', {
    method: 'POST', body: JSON.stringify(input),
  });
  return result.data;
}

export function updateWarehouseAccount(accountId: string, input: Partial<{
  loginName: string; displayName: string; phone: string | null; email: string | null; status: 'ACTIVE' | 'DISABLED';
}>): Promise<unknown> {
  return request(`/warehouse/v1/accounts/${accountId}`, { method: 'PATCH', body: JSON.stringify(input) });
}

export function assignWarehouseAccountRole(accountId: string, input: {
  warehouseId: string; roleId: string; employeeNo?: string | null;
}): Promise<unknown> {
  return request(`/warehouse/v1/accounts/${accountId}/role`, { method: 'PUT', body: JSON.stringify(input) });
}

export function unlockWarehouseAccount(loginName: string): Promise<void> {
  return request(`/warehouse/v1/login-locks/${encodeURIComponent(loginName)}/unlock`, { method: 'POST' });
}

export async function resetWarehouseAccountPassword(accountId: string) {
  const result = await request<{ data: { id: string; temporaryPassword: string } }>(`/warehouse/v1/accounts/${accountId}/reset-password`, { method: 'POST' });
  return result.data;
}

export function deleteWarehouseAccount(accountId: string): Promise<void> {
  return request(`/warehouse/v1/accounts/${accountId}`, { method: 'DELETE' });
}

export async function listWarehouseRoles() {
  const result = await request<{ data: WarehouseRoleView[] }>('/warehouse/v1/roles');
  return result.data;
}

export async function listWarehousePermissions() {
  const result = await request<{ data: WarehousePermissionView[] }>('/warehouse/v1/permissions');
  return result.data;
}

export async function createWarehouseRole(input: { name: string; description?: string }) {
  const result = await request<{ data: WarehouseRoleView }>('/warehouse/v1/roles', { method: 'POST', body: JSON.stringify(input) });
  return result.data;
}

export function updateWarehouseRole(roleId: string, input: Partial<{ name: string; description: string | null; permissions: string[] }> & { expectedVersion: number }): Promise<unknown> {
  return request(`/warehouse/v1/roles/${roleId}`, { method: 'PATCH', body: JSON.stringify(input) });
}

export function deleteWarehouseRole(roleId: string): Promise<void> {
  return request(`/warehouse/v1/roles/${roleId}`, { method: 'DELETE' });
}

export interface SharedWorkBatch {
  id: string;
  name: string;
  status: 'DRAFT' | 'ACTIVE' | 'CLOSED';
  mappingCount: number;
  pdfCount: number;
  version: number;
  publishedAt: string | null;
  closedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SharedWorkBatchMissingItem {
  firstLegTrackingNo: string;
  courierTrackingNo: string | null;
  reason: string;
  updatedAt: string;
}

export async function listSharedWorkBatches(status?: SharedWorkBatch['status']) {
  const query = status ? `?status=${status}` : '';
  const result = await request<{ data: SharedWorkBatch[] }>(`/warehouse/v1/work-batches${query}`);
  return result.data;
}

export async function createSharedWorkBatch(name: string) {
  const result = await request<{ data: SharedWorkBatch }>('/warehouse/v1/work-batches', { method: 'POST', body: JSON.stringify({ name }) });
  return result.data;
}

export function upsertSharedWorkBatchItems(batchId: string, items: Array<{ firstLegTrackingNo: string; courierTrackingNo: string | null; rawData?: unknown }>): Promise<unknown> {
  return request(`/warehouse/v1/work-batches/${batchId}/items`, { method: 'POST', body: JSON.stringify({ items }) });
}

export async function listMissingSharedWorkBatchItems(batchId: string, offset = 0, limit = 500) {
  const query = new URLSearchParams({ offset: String(offset), limit: String(limit) });
  const result = await request<{ data: { total: number; items: SharedWorkBatchMissingItem[] } }>(`/warehouse/v1/work-batches/${batchId}/missing-items?${query}`);
  return result.data;
}

export async function uploadSharedWorkBatchLabel(batchId: string, firstLegTrackingNo: string, file: File) {
  if (WAREHOUSE_MOCK_API_ENABLED) {
    const { mockUploadSharedWorkBatchLabel } = await import('./warehouseMockApi');
    return mockUploadSharedWorkBatchLabel(batchId, firstLegTrackingNo, file);
  }
  const query = new URLSearchParams({ filename: file.name });
  const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
  const sha256 = Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, '0')).join('');
  const response = await fetch(`${WAREHOUSE_API_BASE}/warehouse/v1/work-batches/${batchId}/items/by-first-leg/${encodeURIComponent(firstLegTrackingNo)}/label?${query}`, {
    method: 'PUT',
    credentials: 'include',
    headers: { 'Content-Type': 'application/pdf', 'X-Label-SHA256': sha256 },
    body: file,
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => null) as { error?: { code?: string; message?: string } } | null;
    throw new WarehouseApiError(response.status, payload?.error?.code ?? 'LABEL_UPLOAD_FAILED', payload?.error?.message ?? '共享面单上传失败');
  }
  return response.json();
}

export function publishSharedWorkBatch(batchId: string): Promise<unknown> {
  return request(`/warehouse/v1/work-batches/${batchId}/publish`, { method: 'POST' });
}

export function closeSharedWorkBatch(batchId: string): Promise<unknown> {
  return request(`/warehouse/v1/work-batches/${batchId}/close`, { method: 'POST' });
}

export async function deleteSharedWorkBatch(batchId: string) {
  const result = await request<{ data: { id: string; mappingCount: number; pdfCount: number; deletedStorageBytes: number } }>(
    `/warehouse/v1/work-batches/${batchId}`,
    { method: 'DELETE' },
  );
  return result.data;
}

export async function claimSharedWorkBatchItem(input: { trackingNo: string; workstationId: string }) {
  const result = await request<{ data: { blocked: true; trackingNo: string; reason: string | null } | {
    blocked: false; claimToken: string; item: {
      id: string; batchId: string; batchName: string; firstLegTrackingNo: string;
      courierTrackingNo: string | null; labelAssetId: string; labelDownloadPath: string;
      labelSha256: string; labelByteSize: number;
    };
  } }>('/warehouse/v1/work-batch-claims', { method: 'POST', body: JSON.stringify(input) });
  return result.data;
}

export function completeSharedWorkBatchItem(itemId: string, input: {
  workstationId: string; clientAttemptId: string; claimToken: string;
  outcome: 'SUBMITTED' | 'FAILED' | 'RESULT_UNKNOWN' | 'BLOCKED';
  printerName?: string; message?: string; occurredAt: string;
}): Promise<unknown> {
  return request(`/warehouse/v1/work-batch-items/${itemId}/complete`, { method: 'POST', body: JSON.stringify(input) });
}

export interface GlobalInterceptView {
  id: string;
  trackingNo: string;
  reason: string | null;
  source: 'MANUAL' | 'BULK_IMPORT' | 'UPSTREAM';
  status: 'ACTIVE' | 'REMOVED';
  updatedAt: string;
}

export function listGlobalIntercepts(cursor = '0', limit = 2000) {
  return request<{ data: GlobalInterceptView[]; cursor: string; hasMore: boolean }>(`/warehouse/v1/intercepts?cursor=${encodeURIComponent(cursor)}&limit=${limit}`);
}

export async function checkGlobalIntercepts(trackingNumbers: string[]) {
  const result = await request<{ data: { blocked: false } | { blocked: true; trackingNo: string; reason: string | null } }>('/warehouse/v1/intercepts/check', {
    method: 'POST', body: JSON.stringify({ trackingNumbers }),
  });
  return result.data;
}

export function upsertGlobalIntercepts(entries: Array<{ trackingNo: string; reason?: string }>, source: 'MANUAL' | 'BULK_IMPORT' = 'MANUAL'): Promise<unknown> {
  return request('/warehouse/v1/intercepts', { method: 'POST', body: JSON.stringify({ entries, source }) });
}

export function removeGlobalIntercept(trackingNo: string): Promise<void> {
  return request(`/warehouse/v1/intercepts/${encodeURIComponent(trackingNo)}`, { method: 'DELETE' });
}

export type AirPickupStatus = 'RECORDED' | 'RECEIVED' | 'HANDED_OVER' | 'VOIDED';
export type AirEvidenceStatus = 'NONE' | 'PARTIAL' | 'COMPLETE';
export type AirWeightUnit = 'KG' | 'LB';

export interface AirPickupOrder {
  id: string;
  sourceClientId: string | null;
  sourceClientName: string;
  customerId: string | null;
  customerName: string;
  customerType: 'BUSINESS' | 'UPSTREAM' | null;
  sourceType: 'MANUAL' | 'UPSTREAM';
  externalBatchId: string | null;
  billNoRaw: string;
  billNo: string;
  billNoNormalized: string;
  billNoIsStandard: boolean;
  cargoName: string | null;
  forecastCartons: number;
  forecastPackages: number;
  forecastWeight: number;
  forecastWeightUnit: AirWeightUnit;
  remarks: string | null;
  status: AirPickupStatus;
  evidenceStatus: AirEvidenceStatus;
  actualCartons: number | null;
  actualPackages: number | null;
  actualWeight: number | null;
  actualWeightUnit: AirWeightUnit | null;
  differenceReason: string | null;
  receiptBatchId: string | null;
  receiptBatchNo: string | null;
  handoverBatchId: string | null;
  handoverBatchNo: string | null;
  receivedAt: string | null;
  handedOverAt: string | null;
  version: number;
  voidReason: string | null;
  exchangeProgress: {
    total: number;
    changed: number;
    intercepted: number;
    exceptions: number;
    processed: number;
    pending: number;
  };
  createdAt: string;
  updatedAt: string;
  receiptEvidence?: AirHandoverEvidence[];
  handoverEvidence?: AirHandoverEvidence[];
  pickupDocuments?: AirPickupDocument[];
  events?: AirPickupEvent[];
}

export interface AirPickupDocument {
  id: string;
  filename: string;
  contentType: 'application/pdf' | 'application/msword' | 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' | 'application/vnd.ms-excel' | 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' | 'text/csv';
  byteSize: number;
  downloadPath: string;
  createdAt: string;
}

export interface AirPickupEvent {
  revision: number;
  type: string;
  actorReference: string;
  reason: string | null;
  data: unknown;
  evidence?: AirHandoverEvidence[];
  occurredAt: string;
}

export interface AirHandoverEvidence {
  id: string;
  type: 'RECEIPT' | 'POD' | 'LOADING';
  filename: string;
  contentType: 'image/jpeg' | 'image/png';
  byteSize: number;
  width: number;
  height: number;
  qualityWarnings: string[];
  qualityOverride: boolean;
  downloadPath: string;
  createdAt: string;
}

export interface AirPickupClient {
  id: string;
  code: string;
  name: string;
}

export interface CustomerProfile {
  id: string;
  code: string;
  name: string;
  type: 'BUSINESS' | 'UPSTREAM';
  status: 'ACTIVE' | 'DISABLED';
  integrationStatus: 'NOT_APPLICABLE' | 'PENDING' | 'INTEGRATING' | 'INTEGRATED' | 'SUSPENDED';
  integrationClientId: string | null;
  contactName: string | null;
  contactPhone: string | null;
  contactEmail: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AirPickupSummary {
  recorded: number;
  received: number;
  handedOver: number;
  voided: number;
  evidencePending: number;
}

export interface AirHandoverBatch {
  id: string;
  batchNo: string;
  status: 'DRAFT' | 'CONFIRMED';
  vehicleNo: string | null;
  driverName: string | null;
  driverPhone: string | null;
  handedOverAt: string | null;
  createdByUserId: string | null;
  version: number;
  confirmedAt: string | null;
  createdAt: string;
  updatedAt: string;
  orders: AirPickupOrder[];
  evidence: AirHandoverEvidence[];
}

export async function listAirPickups(filters: {
  search?: string; customerId?: string; status?: AirPickupStatus | ''; evidenceStatus?: AirEvidenceStatus | ''; page?: number; pageSize?: number;
} = {}) {
  const query = new URLSearchParams();
  Object.entries(filters).forEach(([key, value]) => { if (value !== undefined && value !== '') query.set(key, String(value)); });
  return request<{ data: AirPickupOrder[]; pagination: { total: number; page: number; pageSize: number }; summary: AirPickupSummary }>(`/warehouse/v1/air-pickups?${query}`);
}

export async function listAirPickupClients() {
  const result = await request<{ data: AirPickupClient[] }>('/warehouse/v1/air-pickup-clients');
  return result.data;
}

export async function listCustomerProfiles(filters: { type?: CustomerProfile['type']; includeDisabled?: boolean } = {}) {
  const query = new URLSearchParams();
  if (filters.type) query.set('type', filters.type);
  if (filters.includeDisabled) query.set('includeDisabled', 'true');
  const suffix = query.size ? `?${query}` : '';
  const result = await request<{ data: CustomerProfile[] }>(`/warehouse/v1/customers${suffix}`);
  return result.data;
}

export async function createCustomerProfile(input: {
  customerCode: string; name: string; type: CustomerProfile['type']; integrationStatus?: 'PENDING' | 'INTEGRATING';
  contactName?: string; contactPhone?: string; contactEmail?: string;
}) {
  const result = await request<{ data: CustomerProfile }>('/warehouse/v1/customers', { method: 'POST', body: JSON.stringify(input) });
  return result.data;
}

export function deleteCustomerProfile(customerId: string): Promise<void> {
  return request(`/warehouse/v1/customers/${customerId}`, { method: 'DELETE' });
}

export async function getAirPickup(orderId: string) {
  const result = await request<{ data: AirPickupOrder }>(`/warehouse/v1/air-pickups/${orderId}`);
  return result.data;
}

export async function createAirPickup(input: {
  customerId: string; billNo: string; cargoName?: string; forecastCartons: number; forecastPackages: number;
  forecastWeight: number; forecastWeightUnit: AirWeightUnit; remarks?: string;
}) {
  const result = await request<{ data: AirPickupOrder }>('/warehouse/v1/air-pickups', { method: 'POST', body: JSON.stringify(input) });
  return result.data;
}

export async function uploadAirReceiptEvidence(batchId: string, input: {
  file: File; qualityWarnings?: string[]; qualityOverride?: boolean;
}) {
  if (WAREHOUSE_MOCK_API_ENABLED) {
    const { mockUploadAirReceiptEvidence } = await import('./warehouseMockApi');
    return mockUploadAirReceiptEvidence(batchId, input);
  }
  const query = new URLSearchParams({ filename: input.file.name });
  const digest = await crypto.subtle.digest('SHA-256', await input.file.arrayBuffer());
  const sha256 = Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, '0')).join('');
  const response = await fetch(`${WAREHOUSE_API_BASE}/warehouse/v1/air-pickup-receipt-batches/${batchId}/evidence?${query}`, {
    method: 'PUT', credentials: 'include',
    headers: {
      'Content-Type': input.file.type,
      'X-Image-SHA256': sha256,
      'X-Image-Quality-Warnings': (input.qualityWarnings ?? []).join(','),
      'X-Image-Quality-Override': input.qualityOverride ? 'true' : 'false',
    },
    body: input.file,
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => null) as { error?: { code?: string; message?: string } } | null;
    throw new WarehouseApiError(response.status, payload?.error?.code ?? 'RECEIPT_EVIDENCE_UPLOAD_FAILED', payload?.error?.message ?? '入库照上传失败');
  }
  return response.json() as Promise<{ data: AirHandoverEvidence }>;
}

export async function uploadAirPickupDocument(orderId: string, file: File) {
  if (WAREHOUSE_MOCK_API_ENABLED) {
    const { mockUploadAirPickupDocument } = await import('./warehouseMockApi');
    return mockUploadAirPickupDocument(orderId, file);
  }
  const query = new URLSearchParams({ filename: file.name });
  const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
  const sha256 = Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, '0')).join('');
  const response = await fetch(`${WAREHOUSE_API_BASE}/warehouse/v1/air-pickups/${orderId}/documents?${query}`, {
    method: 'PUT', credentials: 'include',
    headers: { 'Content-Type': file.type || 'application/octet-stream', 'X-Document-SHA256': sha256 },
    body: file,
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => null) as { error?: { code?: string; message?: string } } | null;
    throw new WarehouseApiError(response.status, payload?.error?.code ?? 'PICKUP_DOCUMENT_UPLOAD_FAILED', payload?.error?.message ?? '提货文件上传失败');
  }
  return response.json() as Promise<{ data: AirPickupDocument }>;
}

export async function updateAirPickup(orderId: string, input: {
  expectedVersion: number; cargoName?: string; forecastCartons: number; forecastPackages: number;
  forecastWeight: number; forecastWeightUnit: AirWeightUnit; remarks?: string;
}) {
  const result = await request<{ data: AirPickupOrder }>(`/warehouse/v1/air-pickups/${orderId}`, { method: 'PATCH', body: JSON.stringify(input) });
  return result.data;
}

export async function createAirReceiptBatch(input: {
  receivedAt?: string;
  orders: Array<{ orderId: string; actualCartons: number; actualPackages: number; actualWeight: number;
    actualWeightUnit: AirWeightUnit; differenceReason?: string }>;
}) {
  const result = await request<{ data: { id: string; batchNo: string; receivedAt: string; orderCount: number } }>('/warehouse/v1/air-pickup-receipt-batches', { method: 'POST', body: JSON.stringify(input) });
  return result.data;
}

export async function createAirHandoverBatch(input: {
  orderIds: string[]; handedOverAt?: string; vehicleNo?: string; driverName?: string; driverPhone?: string;
}) {
  const result = await request<{ data: AirHandoverBatch }>('/warehouse/v1/air-handover-batches', { method: 'POST', body: JSON.stringify(input) });
  return result.data;
}

export async function getAirHandoverBatch(batchId: string) {
  const result = await request<{ data: AirHandoverBatch }>(`/warehouse/v1/air-handover-batches/${batchId}`);
  return result.data;
}

export async function updateAirHandoverBatch(batchId: string, input: {
  expectedVersion: number; orderIds: string[]; handedOverAt: string;
  vehicleNo?: string; driverName?: string; driverPhone?: string; reason?: string; password?: string;
}) {
  const result = await request<{ data: AirHandoverBatch }>(`/warehouse/v1/air-handover-batches/${batchId}`, {
    method: 'PATCH', body: JSON.stringify(input),
  });
  return result.data;
}

export async function confirmAirHandoverBatch(batchId: string) {
  const result = await request<{ data: AirHandoverBatch }>(`/warehouse/v1/air-handover-batches/${batchId}/confirm`, { method: 'POST' });
  return result.data;
}

export async function uploadAirHandoverEvidence(batchId: string, input: {
  type: 'POD' | 'LOADING'; file: File; qualityWarnings?: string[]; qualityOverride?: boolean;
}) {
  if (WAREHOUSE_MOCK_API_ENABLED) {
    const { mockUploadAirHandoverEvidence } = await import('./warehouseMockApi');
    return mockUploadAirHandoverEvidence(batchId, input);
  }
  const query = new URLSearchParams({ type: input.type, filename: input.file.name });
  const digest = await crypto.subtle.digest('SHA-256', await input.file.arrayBuffer());
  const sha256 = Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, '0')).join('');
  const response = await fetch(`${WAREHOUSE_API_BASE}/warehouse/v1/air-handover-batches/${batchId}/evidence?${query}`, {
    method: 'PUT', credentials: 'include',
    headers: {
      'Content-Type': input.file.type,
      'X-Image-SHA256': sha256,
      'X-Image-Quality-Warnings': (input.qualityWarnings ?? []).join(','),
      'X-Image-Quality-Override': input.qualityOverride ? 'true' : 'false',
    },
    body: input.file,
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => null) as { error?: { code?: string; message?: string } } | null;
    throw new WarehouseApiError(response.status, payload?.error?.code ?? 'EVIDENCE_UPLOAD_FAILED', payload?.error?.message ?? '凭证上传失败');
  }
  return response.json() as Promise<{ data: AirHandoverEvidence & { evidenceStatus: AirEvidenceStatus } }>;
}

export async function downloadAirEvidence(downloadPath: string): Promise<Blob> {
  if (WAREHOUSE_MOCK_API_ENABLED) {
    const { mockDownloadAirEvidence } = await import('./warehouseMockApi');
    return mockDownloadAirEvidence(downloadPath);
  }
  const response = await fetch(`${WAREHOUSE_API_BASE}${downloadPath}`, { credentials: 'include' });
  if (!response.ok) throw new WarehouseApiError(response.status, 'EVIDENCE_DOWNLOAD_FAILED', '凭证读取失败');
  return response.blob();
}

export async function downloadAirPickupDocument(downloadPath: string): Promise<Blob> {
  if (WAREHOUSE_MOCK_API_ENABLED) {
    const { mockDownloadAirPickupDocument } = await import('./warehouseMockApi');
    return mockDownloadAirPickupDocument(downloadPath);
  }
  const response = await fetch(`${WAREHOUSE_API_BASE}${downloadPath}`, { credentials: 'include' });
  if (!response.ok) throw new WarehouseApiError(response.status, 'PICKUP_DOCUMENT_DOWNLOAD_FAILED', '提货文件读取失败');
  return response.blob();
}

export function removeAirPickupDocument(assetId: string, input: { password: string; reason: string }): Promise<void> {
  return request(`/warehouse/v1/air-pickup-documents/${assetId}`, { method: 'DELETE', body: JSON.stringify(input) });
}

export function removeAirEvidence(assetId: string, input: { password: string; reason: string }): Promise<{ data: { evidenceStatus: AirEvidenceStatus } }> {
  return request(`/warehouse/v1/air-evidence-assets/${assetId}`, { method: 'DELETE', body: JSON.stringify(input) });
}

export function voidAirPickup(orderId: string, input: { password: string; reason: string }): Promise<void> {
  return request(`/warehouse/v1/air-pickups/${orderId}/void`, { method: 'POST', body: JSON.stringify(input) });
}

export interface AttendanceLocation {
  id: string;
  name: string;
  address: string | null;
  latitude: number;
  longitude: number;
  radiusMeters: number;
  status: 'ACTIVE' | 'DISABLED';
  createdAt: string;
  updatedAt: string;
}

export interface AttendanceShiftRule {
  id: string;
  name: string;
  timeZone: string;
  weekdays: number[];
  startTime: string;
  endTime: string;
  lateGraceMinutes: number;
  earlyGraceMinutes: number;
  effectiveFrom: string;
  effectiveTo: string | null;
  status: 'ACTIVE' | 'DISABLED';
  version: number;
}

export interface AttendanceDailyResult {
  id: string;
  userId: string | null;
  employeeReference: string;
  employeeName: string;
  employeeNo: string | null;
  workDate: string;
  clockInAt: string | null;
  clockOutAt: string | null;
  clockInAttemptId?: string | null;
  clockOutAttemptId?: string | null;
  grossMinutes: number;
  netMinutes: number;
  status: 'OPEN' | 'COMPLETE' | 'MISSING_IN' | 'MISSING_OUT' | 'ABSENT' | 'NEEDS_REVIEW';
  isLate: boolean;
  isEarlyLeave: boolean;
  version: number;
  updatedAt: string;
}

export interface AttendanceAppeal {
  id: string;
  userId: string | null;
  employeeReference: string;
  employeeName: string;
  employeeNo: string | null;
  workDate: string;
  type: 'DEVICE_FAILURE' | 'TEMPORARY_LEAVE' | 'OTHER';
  requestedClockInAt: string | null;
  requestedClockOutAt: string | null;
  description: string;
  status: 'PENDING' | 'APPROVED' | 'REJECTED';
  reviewNote: string | null;
  reviewedByReference: string | null;
  reviewedAt: string | null;
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface AttendancePunchContext {
  employeeName: string;
  employeeNo: string | null;
  today: string;
  locations: AttendanceLocation[];
  shiftRule: AttendanceShiftRule | null;
  todayResult: AttendanceDailyResult | null;
  serverTime: string;
}

export interface AttendancePayrollRow {
  userId: string | null;
  employeeReference: string;
  employeeName: string;
  employeeNo: string | null;
  hourlyRate: number | null;
  bonus: number;
  fuelDays: number;
  regularMinutes: number;
  overtimeMinutes: number;
  regularPay: number | null;
  overtimePay: number | null;
  fuelAllowance: number;
  totalPay: number | null;
  issues: string[];
  weeklyMinutes: Array<{ week: string; minutes: number }>;
  days: Array<{ workDate: string; grossMinutes: number; status: string }>;
}

export interface AttendancePayrollResult {
  from: string;
  to: string;
  rows: AttendancePayrollRow[];
  runId: string | null;
  rule: {
    lunchDeductionMinutes: number;
    weeklyRegularMinutes: number;
    overtimeMultiplier: number;
    fuelAllowancePerDay: number;
  };
}

export async function getAttendancePunchContext() {
  const result = await request<{ data: AttendancePunchContext }>('/warehouse/v1/attendance/context');
  return result.data;
}

export async function submitAttendancePunch(input: {
  photo: Blob;
  punchType: 'IN' | 'OUT';
  channel: 'MOBILE' | 'WORKSTATION';
  workstationId?: string;
  gestureType: 'BLINK' | 'MOUTH_OPEN';
  gesturePassed: boolean;
  gestureScore: number;
  clientCapturedAt: string;
  latitude?: number;
  longitude?: number;
  accuracy?: number;
}) {
  if (WAREHOUSE_MOCK_API_ENABLED) {
    const { mockSubmitAttendancePunch } = await import('./warehouseMockApi');
    return mockSubmitAttendancePunch(input);
  }
  const query = new URLSearchParams({
    punchType: input.punchType,
    channel: input.channel,
    gestureType: input.gestureType,
    gesturePassed: String(input.gesturePassed),
    gestureScore: String(input.gestureScore),
    clientCapturedAt: input.clientCapturedAt,
  });
  if (input.workstationId) query.set('workstationId', input.workstationId);
  if (input.latitude !== undefined) query.set('latitude', String(input.latitude));
  if (input.longitude !== undefined) query.set('longitude', String(input.longitude));
  if (input.accuracy !== undefined) query.set('accuracy', String(input.accuracy));
  const digest = await crypto.subtle.digest('SHA-256', await input.photo.arrayBuffer());
  const sha256 = Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, '0')).join('');
  const response = await fetch(`${WAREHOUSE_API_BASE}/warehouse/v1/attendance/punches?${query}`, {
    method: 'PUT', credentials: 'include',
    headers: { 'Content-Type': input.photo.type || 'image/jpeg', 'X-Image-SHA256': sha256 },
    body: input.photo,
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => null) as { error?: { code?: string; message?: string } } | null;
    throw new WarehouseApiError(response.status, payload?.error?.code ?? 'ATTENDANCE_PUNCH_FAILED', payload?.error?.message ?? '打卡提交失败');
  }
  return response.json() as Promise<{ data: {
    attemptId: string; accepted: boolean; result: string; reasonCode?: string; message?: string;
    dailyResult?: AttendanceDailyResult; serverTime: string;
  } }>;
}

export async function listAttendanceDailyResults(filters: { dateFrom?: string; dateTo?: string; userId?: string } = {}) {
  const query = new URLSearchParams();
  Object.entries(filters).forEach(([key, value]) => { if (value) query.set(key, value); });
  const result = await request<{ data: { from: string; to: string; rows: AttendanceDailyResult[] } }>(`/warehouse/v1/attendance/daily-results?${query}`);
  return result.data;
}

export async function openAttendancePunchPhoto(attemptId: string) {
  if (WAREHOUSE_MOCK_API_ENABLED) return null;
  const response = await fetch(`${WAREHOUSE_API_BASE}/warehouse/v1/attendance/punch-attempts/${encodeURIComponent(attemptId)}/photo`, {
    credentials: 'include',
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => null) as { error?: { code?: string; message?: string } } | null;
    throw new WarehouseApiError(response.status, payload?.error?.code ?? 'ATTENDANCE_PHOTO_FAILED', payload?.error?.message ?? '打卡照片读取失败');
  }
  return response.blob();
}

export async function listAttendanceAppeals(status?: AttendanceAppeal['status']) {
  const query = status ? `?status=${status}` : '';
  const result = await request<{ data: AttendanceAppeal[] }>(`/warehouse/v1/attendance/appeals${query}`);
  return result.data;
}

export async function createAttendanceAppeal(input: {
  workDate: string;
  type: AttendanceAppeal['type'];
  requestedClockInAt?: string;
  requestedClockOutAt?: string;
  description: string;
}) {
  const result = await request<{ data: AttendanceAppeal }>('/warehouse/v1/attendance/appeals', {
    method: 'POST', body: JSON.stringify(input),
  });
  return result.data;
}

export async function reviewAttendanceAppeal(appealId: string, input: { decision: 'APPROVED' | 'REJECTED'; reviewNote?: string }) {
  const result = await request<{ data: AttendanceAppeal }>(`/warehouse/v1/attendance/appeals/${appealId}/review`, {
    method: 'PATCH', body: JSON.stringify(input),
  });
  return result.data;
}

export async function listAttendanceLocations() {
  const result = await request<{ data: AttendanceLocation[] }>('/warehouse/v1/attendance/locations');
  return result.data;
}

export async function saveAttendanceLocation(input: Partial<AttendanceLocation> & {
  name: string; latitude: number; longitude: number; radiusMeters: number;
}) {
  const result = await request<{ data: AttendanceLocation }>('/warehouse/v1/attendance/locations', {
    method: 'PUT', body: JSON.stringify(input),
  });
  return result.data;
}

export async function listAttendanceShiftRules() {
  const result = await request<{ data: AttendanceShiftRule[] }>('/warehouse/v1/attendance/shift-rules');
  return result.data;
}

export async function saveAttendanceShiftRule(input: Partial<AttendanceShiftRule> & {
  name: string; weekdays: number[]; startTime: string; endTime: string;
  lateGraceMinutes: number; earlyGraceMinutes: number; effectiveFrom: string;
}) {
  const result = await request<{ data: AttendanceShiftRule }>('/warehouse/v1/attendance/shift-rules', {
    method: 'PUT', body: JSON.stringify(input),
  });
  return result.data;
}

const payrollNumber = (value: unknown) => {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : null;
};

function normalizeAttendancePayrollResult(value: unknown): AttendancePayrollResult {
  if (!value || typeof value !== 'object') {
    throw new WarehouseApiError(502, 'PAYROLL_RESPONSE_INVALID', '薪酬数据格式不完整，请刷新后重试');
  }

  const source = value as Partial<AttendancePayrollResult>;
  if (!Array.isArray(source.rows)) {
    throw new WarehouseApiError(502, 'PAYROLL_RESPONSE_INVALID', '薪酬明细缺失，请刷新后重试');
  }

  const rows = source.rows.map(rawRow => {
    const row = rawRow && typeof rawRow === 'object'
      ? rawRow as Partial<AttendancePayrollRow>
      : {} as Partial<AttendancePayrollRow>;
    const weeklyMinutes = Array.isArray(row.weeklyMinutes)
      ? row.weeklyMinutes.map(item => ({ week: String(item?.week ?? ''), minutes: payrollNumber(item?.minutes) ?? 0 }))
      : [];
    const rawDays = Array.isArray(row.days) ? row.days : [];
    const days = rawDays.length
      ? rawDays.map(day => ({
        workDate: String(day?.workDate ?? ''),
        grossMinutes: payrollNumber(day?.grossMinutes) ?? 0,
        status: String(day?.status ?? ''),
      }))
      : [];
    const requiredNumbers = [row.bonus, row.fuelDays, row.regularMinutes, row.overtimeMinutes, row.fuelAllowance];
    const nullableNumbers = [row.hourlyRate, row.regularPay, row.overtimePay, row.totalPay];
    const malformed = !row.employeeReference
      || !row.employeeName
      || requiredNumbers.some(item => payrollNumber(item) === null)
      || nullableNumbers.some(item => item != null && payrollNumber(item) === null)
      || !Array.isArray(row.issues)
      || !Array.isArray(row.weeklyMinutes)
      || !Array.isArray(row.days)
      || rawDays.some(day => payrollNumber(day?.grossMinutes) === null);
    const issues = Array.isArray(row.issues) ? row.issues.map(String).filter(Boolean) : [];
    if (malformed) issues.push('薪酬数据格式异常，请联系管理员重新计算');

    return {
      userId: typeof row.userId === 'string' ? row.userId : null,
      employeeReference: String(row.employeeReference ?? 'unknown'),
      employeeName: String(row.employeeName ?? '未知员工'),
      employeeNo: typeof row.employeeNo === 'string' ? row.employeeNo : null,
      hourlyRate: payrollNumber(row.hourlyRate),
      bonus: payrollNumber(row.bonus) ?? 0,
      fuelDays: payrollNumber(row.fuelDays) ?? 0,
      regularMinutes: payrollNumber(row.regularMinutes) ?? 0,
      overtimeMinutes: payrollNumber(row.overtimeMinutes) ?? 0,
      regularPay: payrollNumber(row.regularPay),
      overtimePay: payrollNumber(row.overtimePay),
      fuelAllowance: payrollNumber(row.fuelAllowance) ?? 0,
      totalPay: malformed ? null : payrollNumber(row.totalPay),
      issues: [...new Set(issues)],
      weeklyMinutes,
      days,
    } satisfies AttendancePayrollRow;
  });

  if (!source.rule || typeof source.rule !== 'object') {
    throw new WarehouseApiError(502, 'PAYROLL_RESPONSE_INVALID', '薪酬计算规则缺失，请刷新后重试');
  }
  const rule = source.rule;
  const ruleNumbers = [rule.lunchDeductionMinutes, rule.weeklyRegularMinutes, rule.overtimeMultiplier, rule.fuelAllowancePerDay];
  if (ruleNumbers.some(item => payrollNumber(item) === null)) {
    throw new WarehouseApiError(502, 'PAYROLL_RESPONSE_INVALID', '薪酬计算规则格式异常，请刷新后重试');
  }
  return {
    from: String(source.from ?? ''),
    to: String(source.to ?? ''),
    runId: typeof source.runId === 'string' ? source.runId : null,
    rows,
    rule: {
      lunchDeductionMinutes: payrollNumber(rule.lunchDeductionMinutes) ?? 0,
      weeklyRegularMinutes: payrollNumber(rule.weeklyRegularMinutes) ?? 0,
      overtimeMultiplier: payrollNumber(rule.overtimeMultiplier) ?? 0,
      fuelAllowancePerDay: payrollNumber(rule.fuelAllowancePerDay) ?? 0,
    },
  };
}

export async function getAttendancePayrollPreview(dateFrom: string, dateTo: string) {
  const result = await request<{ data: AttendancePayrollResult }>(`/warehouse/v1/attendance/payroll-preview?${new URLSearchParams({ dateFrom, dateTo })}`);
  return normalizeAttendancePayrollResult(result.data);
}

export async function createAttendancePayrollRun(dateFrom: string, dateTo: string) {
  const result = await request<{ data: AttendancePayrollResult }>('/warehouse/v1/attendance/payroll-runs', {
    method: 'POST', body: JSON.stringify({ dateFrom, dateTo }),
  });
  return normalizeAttendancePayrollResult(result.data);
}

export function saveAttendancePayProfile(input: { userId: string; hourlyRate: number; effectiveFrom: string }): Promise<unknown> {
  return request('/warehouse/v1/attendance/pay-profiles', { method: 'PUT', body: JSON.stringify(input) });
}

export function saveAttendancePayrollAdjustment(input: {
  employeeReference: string; periodStart: string; periodEnd: string; bonus: number; fuelDays: number; note?: string;
}): Promise<unknown> {
  return request('/warehouse/v1/attendance/payroll-adjustments', { method: 'PUT', body: JSON.stringify(input) });
}
