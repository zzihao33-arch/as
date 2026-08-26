import { useCallback, useEffect, useRef, useState } from 'react';
import { readLocalFirstValue, writeLocalFirstValue } from '../../../shared/storage/localFirstDatabase';
import type { PrintLog, PrintLogInput, PrintLogType } from '../printingTypes';

// IndexedDB keeps long warehouse shifts out of the 5 MB localStorage quota.
// The UI is paginated, so five thousand entries stay responsive on-site.
export const MAX_PRINT_LOG_ENTRIES = 5_000;
const LEGACY_PRINT_LOG_STORAGE_KEY = 'cmhub-print-logs-v1';
const PRINT_LOGS_DATABASE_KEY = 'entries';
const PERSIST_DELAY_MS = 300;

const createLogId = () => `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

const normalizeLogs = (value: unknown): PrintLog[] => {
  if (!Array.isArray(value)) return [];

  return value
    .filter((log): log is Omit<PrintLog, 'id' | 'createdAt'> & Partial<Pick<PrintLog, 'id' | 'createdAt'>> => (
      log !== null
      && typeof log === 'object'
      && typeof log.time === 'string'
      && typeof log.firstLeg === 'string'
      && typeof log.exchange === 'string'
      && typeof log.message === 'string'
      && (log.status === 'success' || log.status === 'error')
      && (log.type === 'import' || log.type === 'print' || log.type === 'system')
    ))
    .map(log => ({
      ...log,
      id: typeof log.id === 'string' ? log.id : createLogId(),
      createdAt: typeof log.createdAt === 'number' ? log.createdAt : 0
    }))
    .sort((left, right) => right.createdAt - left.createdAt)
    .slice(0, MAX_PRINT_LOG_ENTRIES);
};

const readLegacyLogs = () => {
  try {
    const storedLogs = localStorage.getItem(LEGACY_PRINT_LOG_STORAGE_KEY);
    return storedLogs ? normalizeLogs(JSON.parse(storedLogs)) : [];
  } catch {
    return [];
  }
};

const mergeLogs = (primary: PrintLog[], secondary: PrintLog[]) => {
  const merged = new Map<string, PrintLog>();
  [...primary, ...secondary].forEach(log => merged.set(log.id, log));
  return [...merged.values()]
    .sort((left, right) => right.createdAt - left.createdAt)
    .slice(0, MAX_PRINT_LOG_ENTRIES);
};

export function usePrintLogs() {
  const [logs, setLogs] = useState<PrintLog[]>([]);
  const [lastLogId, setLastLogId] = useState<string | null>(null);
  const [isHydrated, setIsHydrated] = useState(false);
  const logsRef = useRef(logs);

  useEffect(() => {
    let isCurrent = true;
    void (async () => {
      try {
        const storedLogs = await readLocalFirstValue<unknown>('printLogs', PRINT_LOGS_DATABASE_KEY);
        const recoveredLogs = storedLogs === null ? readLegacyLogs() : normalizeLogs(storedLogs);
        if (storedLogs === null && recoveredLogs.length > 0) {
          await writeLocalFirstValue('printLogs', PRINT_LOGS_DATABASE_KEY, recoveredLogs);
        }
        if (isCurrent) {
          setLogs(previous => mergeLogs(previous, recoveredLogs));
        }
      } finally {
        if (isCurrent) setIsHydrated(true);
      }
    })();
    return () => {
      isCurrent = false;
    };
  }, []);

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
    if (!isHydrated) return undefined;
    const saveTimer = window.setTimeout(() => {
      void writeLocalFirstValue('printLogs', PRINT_LOGS_DATABASE_KEY, logs);
    }, PERSIST_DELAY_MS);
    return () => window.clearTimeout(saveTimer);
  }, [isHydrated, logs]);

  useEffect(() => {
    const saveLogsBeforeExit = () => {
      if (isHydrated) void writeLocalFirstValue('printLogs', PRINT_LOGS_DATABASE_KEY, logsRef.current);
    };
    window.addEventListener('pagehide', saveLogsBeforeExit);
    return () => window.removeEventListener('pagehide', saveLogsBeforeExit);
  }, [isHydrated]);

  useEffect(() => {
    if (!lastLogId) return undefined;
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
