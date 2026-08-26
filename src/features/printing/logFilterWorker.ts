import type { PrintLog, PrintLogTab } from './printingTypes';

interface LogFilterRequest {
  logs: PrintLog[];
  tab: PrintLogTab;
  page: number;
  pageSize: number;
}

interface LogFilterResponse {
  total: number;
  logs: Array<PrintLog & { rowNumber: number }>;
}

self.onmessage = (event: MessageEvent<LogFilterRequest>) => {
  const { logs, tab, page, pageSize } = event.data;
  const filteredLogs = logs.filter(log => log.type === tab);
  const total = filteredLogs.length;
  const safePage = Math.min(Math.max(1, page), Math.max(1, Math.ceil(total / pageSize)));
  const startIndex = (safePage - 1) * pageSize;

  const response: LogFilterResponse = {
    total,
    logs: filteredLogs.slice(startIndex, startIndex + pageSize).map((log, index) => ({
      ...log,
      rowNumber: total - (startIndex + index)
    }))
  };
  self.postMessage(response);
};
