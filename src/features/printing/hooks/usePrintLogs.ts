import { useCallback, useEffect, useRef, useState } from 'react';
import {
  readAllLocalFirstEntries,
  updateLocalFirstEntries,
  type LocalFirstEntry
} from '../../../shared/storage/localFirstDatabase';
import type { PrintLog, PrintLogInput, PrintLogType } from '../printingTypes';

// IndexedDB keeps long warehouse shifts out of the 5 MB localStorage quota.
// The UI is paginated, so five thousand entries stay responsive on-site.
export const MAX_PRINT_LOG_ENTRIES = 5_000;
const LEGACY_PRINT_LOG_STORAGE_KEY = 'cmhub-print-logs-v1';
const PRINT_LOGS_DATABASE_KEY = 'entries';
const PRINT_LOG_RECORD_PREFIX = 'log:';

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

const getPrintLogRecordKey = (id: string) => `${PRINT_LOG_RECORD_PREFIX}${id}`;

const isPrintLogRecordKey = (key: IDBValidKey): key is string => (
  typeof key === 'string' && key.startsWith(PRINT_LOG_RECORD_PREFIX)
);

const printLogsAreEqual = (left: unknown, right: PrintLog) => {
  if (left === null || typeof left !== 'object') return false;
  const candidate = left as Partial<PrintLog>;
  return candidate.id === right.id
    && candidate.createdAt === right.createdAt
    && candidate.time === right.time
    && candidate.firstLeg === right.firstLeg
    && candidate.exchange === right.exchange
    && candidate.status === right.status
    && candidate.message === right.message
    && candidate.type === right.type
    && candidate.outcome === right.outcome;
};

interface PendingLogChanges {
  entries: PrintLog[];
  deletedIds: string[];
}

export function usePrintLogs() {
  const [logs, setLogs] = useState<PrintLog[]>([]);
  const [lastLogId, setLastLogId] = useState<string | null>(null);
  const logsRef = useRef(logs);
  const isHydratedRef = useRef(false);
  const clearedTypesBeforeHydrationRef = useRef<Set<PrintLogType>>(new Set());
  const pendingChangesRef = useRef<PendingLogChanges[]>([]);
  const pendingChangesRevisionRef = useRef(0);
  const isFlushingRef = useRef(false);

  const flushPendingChanges = useCallback(() => {
    if (!isHydratedRef.current || isFlushingRef.current || pendingChangesRef.current.length === 0) return;

    const revisionAtStart = pendingChangesRevisionRef.current;
    isFlushingRef.current = true;
    void (async () => {
      let failed = false;
      while (pendingChangesRef.current.length > 0) {
        const { entries, deletedIds } = pendingChangesRef.current[0];
        try {
          await updateLocalFirstEntries(
            'printLogs',
            entries.map(log => ({ key: getPrintLogRecordKey(log.id), value: log })),
            deletedIds.map(getPrintLogRecordKey)
          );
          pendingChangesRef.current.shift();
        } catch {
          failed = true;
          break;
        }
      }
      isFlushingRef.current = false;

      // A change queued while a failed transaction was in flight deserves one
      // fresh attempt. Otherwise retain the ordered queue for the next event.
      if (failed && pendingChangesRevisionRef.current !== revisionAtStart) {
        window.setTimeout(flushPendingChanges, 0);
      }
    })();
  }, []);

  const queueLogChanges = useCallback(({ entries, deletedIds }: PendingLogChanges) => {
    if (entries.length === 0 && deletedIds.length === 0) return;
    pendingChangesRef.current.push({ entries: [...entries], deletedIds: [...deletedIds] });
    pendingChangesRevisionRef.current += 1;
    flushPendingChanges();
  }, [flushPendingChanges]);

  useEffect(() => {
    let isCurrent = true;
    void (async () => {
      let recoveredLogs: PrintLog[] = [];
      try {
        const storedEntries = await readAllLocalFirstEntries<unknown>('printLogs');
        const legacyDatabaseEntry = storedEntries.find(({ key }) => key === PRINT_LOGS_DATABASE_KEY);
        const recordEntries = storedEntries.filter(
          (entry): entry is LocalFirstEntry<unknown> & { key: string } => isPrintLogRecordKey(entry.key)
        );
        const recordLogs = normalizeLogs(recordEntries.map(({ value }) => value));
        const legacyLogs = legacyDatabaseEntry
          ? normalizeLogs(legacyDatabaseEntry.value)
          : recordEntries.length === 0
            ? readLegacyLogs()
            : [];
        recoveredLogs = mergeLogs(legacyLogs, recordLogs);

        const desiredRecordKeys = new Set(recoveredLogs.map(log => getPrintLogRecordKey(log.id)));
        const existingRecords = new Map(recordEntries.map(entry => [entry.key, entry.value]));
        const entriesToWrite: Array<LocalFirstEntry<PrintLog>> = recoveredLogs
          .filter(log => !printLogsAreEqual(existingRecords.get(getPrintLogRecordKey(log.id)), log))
          .map(log => ({ key: getPrintLogRecordKey(log.id), value: log }));
        const keysToDelete = recordEntries
          .map(({ key }) => key)
          .filter(key => !desiredRecordKeys.has(key));
        if (legacyDatabaseEntry) keysToDelete.push(PRINT_LOGS_DATABASE_KEY);

        try {
          if (entriesToWrite.length > 0 || keysToDelete.length > 0) {
            await updateLocalFirstEntries('printLogs', entriesToWrite, keysToDelete);
          }
          localStorage.removeItem(LEGACY_PRINT_LOG_STORAGE_KEY);
        } catch {
          // Keep the recovered records available in memory when IndexedDB is
          // temporarily unavailable. A later session can retry the migration.
        }
      } catch {
        recoveredLogs = readLegacyLogs();
      }

      const clearedTypes = clearedTypesBeforeHydrationRef.current;
      const recoverableLogs = recoveredLogs.filter(log => !clearedTypes.has(log.type));
      const nextLogs = mergeLogs(logsRef.current, recoverableLogs);
      const retainedIds = new Set(nextLogs.map(log => log.id));
      const deletedRecoveredIds = recoveredLogs.filter(log => !retainedIds.has(log.id)).map(log => log.id);
      logsRef.current = nextLogs;
      if (isCurrent) setLogs(nextLogs);
      queueLogChanges({ entries: [], deletedIds: deletedRecoveredIds });
      clearedTypesBeforeHydrationRef.current.clear();
      isHydratedRef.current = true;
      flushPendingChanges();
    })();
    return () => {
      isCurrent = false;
      flushPendingChanges();
    };
  }, [flushPendingChanges, queueLogChanges]);

  const addLog = useCallback((input: PrintLogInput) => {
    const newLog: PrintLog = {
      id: createLogId(),
      createdAt: Date.now(),
      time: new Date().toLocaleTimeString(),
      ...input
    };
    const previousLogs = logsRef.current;
    const nextLogs = [newLog, ...previousLogs].slice(0, MAX_PRINT_LOG_ENTRIES);
    const retainedIds = new Set(nextLogs.map(log => log.id));
    const evictedIds = previousLogs.filter(log => !retainedIds.has(log.id)).map(log => log.id);

    logsRef.current = nextLogs;
    setLogs(nextLogs);
    queueLogChanges({ entries: [newLog], deletedIds: evictedIds });
    setLastLogId(newLog.id);
  }, [queueLogChanges]);

  const clearLogsByType = useCallback((type: PrintLogType) => {
    if (!isHydratedRef.current) clearedTypesBeforeHydrationRef.current.add(type);
    const previousLogs = logsRef.current;
    const deletedIds = previousLogs.filter(log => log.type === type).map(log => log.id);
    const nextLogs = previousLogs.filter(log => log.type !== type);

    logsRef.current = nextLogs;
    setLogs(nextLogs);
    queueLogChanges({ entries: [], deletedIds });
  }, [queueLogChanges]);

  useEffect(() => {
    const saveLogsBeforeExit = () => flushPendingChanges();
    window.addEventListener('pagehide', saveLogsBeforeExit);
    return () => {
      window.removeEventListener('pagehide', saveLogsBeforeExit);
      flushPendingChanges();
    };
  }, [flushPendingChanges]);

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
