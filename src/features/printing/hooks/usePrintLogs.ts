import { useCallback, useEffect, useRef, useState } from 'react';
import type { PrintLog, PrintLogInput, PrintLogType } from '../printingTypes';

// V2.4.1 keeps the client-side log queue intentionally lightweight. The
// latest entry is always inserted at index 0 and the 101st entry removes the
// oldest one, preventing LocalStorage pressure during long warehouse shifts.
export const MAX_PRINT_LOG_ENTRIES = 100;
const PRINT_LOG_STORAGE_KEY = 'cmhub-print-logs-v1';
const PERSIST_DELAY_MS = 300;

const createLogId = () => `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

const loadStoredLogs = (): PrintLog[] => {
  try {
    const storedLogs = localStorage.getItem(PRINT_LOG_STORAGE_KEY);
    if (!storedLogs) return [];

    const parsedLogs: unknown = JSON.parse(storedLogs);
    if (!Array.isArray(parsedLogs)) return [];

    return parsedLogs
      .filter((log): log is Omit<PrintLog, 'id' | 'createdAt'> & Partial<Pick<PrintLog, 'id' | 'createdAt'>> => (
        log !== null &&
        typeof log === 'object' &&
        typeof log.time === 'string' &&
        typeof log.firstLeg === 'string' &&
        typeof log.exchange === 'string' &&
        typeof log.message === 'string' &&
        (log.status === 'success' || log.status === 'error') &&
        (log.type === 'import' || log.type === 'print' || log.type === 'system')
      ))
      .slice(0, MAX_PRINT_LOG_ENTRIES)
      .map(log => ({
        ...log,
        id: typeof log.id === 'string' ? log.id : createLogId(),
        createdAt: typeof log.createdAt === 'number' ? log.createdAt : 0
      }));
  } catch {
    return [];
  }
};

const persistLogs = (logs: PrintLog[]) => {
  try {
    localStorage.setItem(PRINT_LOG_STORAGE_KEY, JSON.stringify(logs));
  } catch {
    // 本地存储不可用时不影响扫码和打印主流程。
  }
};

export function usePrintLogs() {
  const [logs, setLogs] = useState<PrintLog[]>(loadStoredLogs);
  const [lastLogId, setLastLogId] = useState<string | null>(null);
  const logsRef = useRef(logs);

  const addLog = useCallback((input: PrintLogInput) => {
    const newLog: PrintLog = {
      id: createLogId(),
      createdAt: Date.now(),
      time: new Date().toLocaleTimeString(),
      ...input
    };

    setLogs(previousLogs => [newLog, ...previousLogs].slice(0, MAX_PRINT_LOG_ENTRIES));
    setLastLogId(newLog.id);
  }, []);

  const clearLogsByType = useCallback((type: PrintLogType) => {
    setLogs(previousLogs => previousLogs.filter(log => log.type !== type));
  }, []);

  useEffect(() => {
    logsRef.current = logs;
    const saveTimer = window.setTimeout(() => persistLogs(logs), PERSIST_DELAY_MS);
    return () => window.clearTimeout(saveTimer);
  }, [logs]);

  useEffect(() => {
    const saveLogsBeforeExit = () => persistLogs(logsRef.current);
    window.addEventListener('pagehide', saveLogsBeforeExit);
    return () => window.removeEventListener('pagehide', saveLogsBeforeExit);
  }, []);

  useEffect(() => {
    if (!lastLogId) return;

    const timer = window.setTimeout(() => setLastLogId(null), 3_000);
    return () => window.clearTimeout(timer);
  }, [lastLogId]);

  return {
    logs,
    lastLogId,
    addLog,
    clearLogsByType
  };
}
