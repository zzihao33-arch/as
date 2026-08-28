import type { PrintLog, PrintLogTab } from './printingTypes';

export interface PrintLogPage {
  total: number;
  logs: Array<PrintLog & { rowNumber: number }>;
}

export const paginatePrintLogs = (
  logs: readonly PrintLog[],
  tab: PrintLogTab,
  requestedPage: number,
  pageSize: number
): PrintLogPage => {
  const filteredLogs = logs.filter(log => log.type === tab);
  const total = filteredLogs.length;
  const safePageSize = Number.isFinite(pageSize) ? Math.max(1, Math.floor(pageSize)) : 1;
  const totalPages = Math.max(1, Math.ceil(total / safePageSize));
  const normalizedPage = Number.isFinite(requestedPage) ? Math.floor(requestedPage) : 1;
  const safePage = Math.min(Math.max(1, normalizedPage), totalPages);
  const startIndex = (safePage - 1) * safePageSize;

  return {
    total,
    logs: filteredLogs.slice(startIndex, startIndex + safePageSize).map((log, index) => ({
      ...log,
      rowNumber: total - (startIndex + index)
    }))
  };
};
