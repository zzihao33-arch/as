const configuredApiBase = import.meta.env.VITE_CMHUB_API_BASE_URL?.trim();
export const WAREHOUSE_API_BASE = (configuredApiBase || (import.meta.env.DEV ? 'http://127.0.0.1:8080' : 'https://api.cmhubtool.com')).replace(/\/$/, '');

export type WarehouseRole = 'OPERATOR' | 'SUPERVISOR' | 'ADMIN';
export interface WarehouseSessionView {
  sessionId: string;
  userId: string;
  userName: string;
  email: string;
  warehouseId: string;
  warehouseCode: string;
  warehouseName: string;
  membershipId: string;
  role: WarehouseRole;
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
  const response = await fetch(`${WAREHOUSE_API_BASE}${path}`, {
    ...init,
    credentials: 'include',
    headers: { ...(init.body ? { 'Content-Type': 'application/json' } : {}), ...init.headers },
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => null) as { error?: { code?: string; message?: string } } | null;
    throw new WarehouseApiError(response.status, payload?.error?.code ?? 'REQUEST_FAILED', payload?.error?.message ?? '云端请求失败。');
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

export async function createWarehouseSession(input: { email: string; password: string; warehouseCode: string }) {
  const result = await request<{ data: WarehouseSessionView }>('/warehouse/v1/sessions', {
    method: 'POST', body: JSON.stringify(input),
  });
  return result.data;
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
  const response = await fetch(`${WAREHOUSE_API_BASE}${downloadPath}`, { credentials: 'include' });
  if (!response.ok) {
    const payload = await response.json().catch(() => null) as { error?: { code?: string; message?: string } } | null;
    throw new WarehouseApiError(response.status, payload?.error?.code ?? 'LABEL_DOWNLOAD_FAILED', payload?.error?.message ?? '面单下载失败。');
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
