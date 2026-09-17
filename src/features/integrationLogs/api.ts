import { WAREHOUSE_API_BASE, WarehouseApiError } from '../session/warehouseApi';
import type { NotificationSnapshot } from './notificationState';

export interface PushLog {
  id: string; occurredAt: string; completedAt: string; requestId: string;
  clientId: string | null; clientName: string | null; operation: string; method: string;
  endpoint: string; reference: string | null; httpStatus: number;
  outcome: 'success' | 'failure'; durationMs: number; errorCode: string | null;
}
export interface PushLogDetail extends PushLog { requestSummary: object; responseSummary: object }
export interface PushLogList {
  records: PushLog[]; total: number; page: number; pageSize: number; cursor: string;
  metrics: { total: number; success: number; failure: number };
  clients: { id: string; name: string; code: string }[];
}
export interface LogFilters { page: number; pageSize: number; clientId?: string; operation?: string; status?: string; search?: string; from?: string; to?: string }
async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${WAREHOUSE_API_BASE}/warehouse/v1/integration-logs${path}`, {
    ...init, credentials: 'include', headers: { ...(init.body ? { 'Content-Type': 'application/json' } : {}), ...init.headers },
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) throw new WarehouseApiError(response.status, payload?.error?.code ?? 'REQUEST_FAILED', payload?.error?.message ?? '推送日志暂时不可用，请稍后重试。');
  return payload.data as T;
}
export function listPushLogs(filters: LogFilters, signal?: AbortSignal) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) if (value !== '' && value !== undefined) params.set(key, String(value));
  return request<PushLogList>(`?${params}`, { signal });
}
export const getPushLog = (id: string, signal?: AbortSignal) => request<PushLogDetail>(`/${encodeURIComponent(id)}`, { signal });
export const getLogNotifications = (signal?: AbortSignal) => request<NotificationSnapshot>('/notifications', { signal });
export const markLogsRead = (cursor: string, signal?: AbortSignal) => request<{ readCursor: string }>('/read', { method: 'POST', body: JSON.stringify({ cursor }), signal });
export const operationNames: Record<string, string> = { shipment: '运单推送', inbound_batch: '批量预报', air_shipment: '提单信息', label_push: '面单 / 转单号', label_pdf: 'PDF 面单' };
