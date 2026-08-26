import { useCallback, useRef, useState } from 'react';

export interface UploadFileSummary {
  name: string;
  count: number;
  sourceCount?: number;
}

export interface RestoredUploadSession {
  mapping: Record<string, string>;
  excel: UploadFileSummary | null;
  pdfFolder: UploadFileSummary | null;
  pdfFiles: Record<string, File>;
  restoredPdfFileCount: number;
  message?: string;
}

type CacheStatus = 'idle' | 'restoring' | 'ready' | 'unavailable';

interface StoredUploadSession {
  id: string;
  updatedAt: number;
  mapping: Record<string, string>;
  excel: UploadFileSummary | null;
  pdfFolder: UploadFileSummary | null;
  directoryHandle?: FileSystemDirectoryHandle;
}

interface StoredPdfFile {
  id: string;
  sessionId: string;
  key: string;
  name: string;
  lastModified: number;
  blob: Blob;
}

interface DirectoryPickerWindow extends Window {
  showDirectoryPicker?: (options?: { mode?: 'read' | 'readwrite' }) => Promise<FileSystemDirectoryHandle>;
}

const DATABASE_NAME = 'cmhub-upload-session-cache-v1';
const DATABASE_VERSION = 1;
const SESSION_STORE = 'sessions';
const PDF_STORE = 'pdf-files';
const PDF_SESSION_INDEX = 'sessionId';
const SESSION_ID_KEY = 'cmhub-upload-session-id-v1';
const STALE_SESSION_MS = 24 * 60 * 60 * 1000;

let databasePromise: Promise<IDBDatabase> | null = null;

const requestAsPromise = <T>(request: IDBRequest<T>) => new Promise<T>((resolve, reject) => {
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error ?? new Error('浏览器本地缓存操作失败。'));
});

const transactionAsPromise = (transaction: IDBTransaction) => new Promise<void>((resolve, reject) => {
  transaction.oncomplete = () => resolve();
  transaction.onabort = () => reject(transaction.error ?? new Error('浏览器本地缓存写入失败。'));
  transaction.onerror = () => reject(transaction.error ?? new Error('浏览器本地缓存写入失败。'));
});

const openDatabase = () => {
  if (databasePromise) return databasePromise;

  databasePromise = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(SESSION_STORE)) {
        database.createObjectStore(SESSION_STORE, { keyPath: 'id' });
      }
      if (!database.objectStoreNames.contains(PDF_STORE)) {
        const pdfStore = database.createObjectStore(PDF_STORE, { keyPath: 'id' });
        pdfStore.createIndex(PDF_SESSION_INDEX, 'sessionId', { unique: false });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('浏览器不支持本地文件会话缓存。'));
  });

  return databasePromise;
};

const createSessionId = () => `upload-session-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

const getCurrentSessionId = () => {
  try {
    const currentId = sessionStorage.getItem(SESSION_ID_KEY);
    if (currentId) return currentId;

    const newId = createSessionId();
    sessionStorage.setItem(SESSION_ID_KEY, newId);
    return newId;
  } catch {
    return null;
  }
};

const getSession = async (sessionId: string) => {
  const database = await openDatabase();
  const transaction = database.transaction(SESSION_STORE, 'readonly');
  const session = await requestAsPromise(transaction.objectStore(SESSION_STORE).get(sessionId));
  await transactionAsPromise(transaction);
  return (session as StoredUploadSession | undefined) ?? null;
};

const getPdfFiles = async (sessionId: string) => {
  const database = await openDatabase();
  const transaction = database.transaction(PDF_STORE, 'readonly');
  const store = transaction.objectStore(PDF_STORE);
  const files = await requestAsPromise(store.index(PDF_SESSION_INDEX).getAll(sessionId));
  await transactionAsPromise(transaction);
  return files as StoredPdfFile[];
};

const deletePdfFilesForSession = async (sessionId: string) => {
  const records = await getPdfFiles(sessionId);
  if (records.length === 0) return;

  const database = await openDatabase();
  const transaction = database.transaction(PDF_STORE, 'readwrite');
  const store = transaction.objectStore(PDF_STORE);
  records.forEach(record => store.delete(record.id));
  await transactionAsPromise(transaction);
};

const pruneExpiredSessions = async (currentSessionId: string) => {
  const database = await openDatabase();
  const transaction = database.transaction(SESSION_STORE, 'readonly');
  const sessions = await requestAsPromise(transaction.objectStore(SESSION_STORE).getAll());
  await transactionAsPromise(transaction);

  const expiredSessionIds = (sessions as StoredUploadSession[])
    .filter(session => session.id !== currentSessionId && Date.now() - session.updatedAt > STALE_SESSION_MS)
    .map(session => session.id);

  if (expiredSessionIds.length === 0) return;
  const allPdfRecords = await getAllPdfFiles(database);
  const cleanupTransaction = database.transaction([SESSION_STORE, PDF_STORE], 'readwrite');
  const sessionStore = cleanupTransaction.objectStore(SESSION_STORE);
  const pdfStore = cleanupTransaction.objectStore(PDF_STORE);
  expiredSessionIds.forEach(sessionId => sessionStore.delete(sessionId));
  allPdfRecords
    .filter(file => expiredSessionIds.includes(file.sessionId))
    .forEach(file => pdfStore.delete(file.id));
  await transactionAsPromise(cleanupTransaction);
};

const getAllPdfFiles = async (database: IDBDatabase) => {
  const transaction = database.transaction(PDF_STORE, 'readonly');
  const records = await requestAsPromise(transaction.objectStore(PDF_STORE).getAll());
  await transactionAsPromise(transaction);
  return records as StoredPdfFile[];
};

export const collectPdfFilesFromDirectory = async (directory: FileSystemDirectoryHandle) => {
  const files: Record<string, File> = {};
  const entries = directory as unknown as { values: () => AsyncIterable<FileSystemHandle> };

  for await (const entry of entries.values()) {
    if (entry.kind === 'directory') {
      Object.assign(files, await collectPdfFilesFromDirectory(entry as FileSystemDirectoryHandle));
      continue;
    }

    const file = await (entry as FileSystemFileHandle).getFile();
    if (file.type !== 'application/pdf' && !file.name.toLowerCase().endsWith('.pdf')) continue;
    const key = file.name.replace(/\.[^/.]+$/, '');
    files[key] = file;
  }

  return files;
};

const hasDirectoryPicker = () => typeof window !== 'undefined' && typeof (window as DirectoryPickerWindow).showDirectoryPicker === 'function';

export function useSessionUploadCache() {
  const sessionIdRef = useRef<string | null>(getCurrentSessionId());
  const pdfSaveQueueRef = useRef<Promise<void>>(Promise.resolve());
  const [status, setStatus] = useState<CacheStatus>('idle');
  const [message, setMessage] = useState('');

  const updateSession = useCallback(async (patch: Partial<Omit<StoredUploadSession, 'id' | 'updatedAt'>>) => {
    const sessionId = sessionIdRef.current;
    if (!sessionId) throw new Error('当前浏览器不允许会话缓存。');

    const currentSession = await getSession(sessionId);
    const nextSession: StoredUploadSession = {
      id: sessionId,
      updatedAt: Date.now(),
      mapping: currentSession?.mapping ?? {},
      excel: currentSession?.excel ?? null,
      pdfFolder: currentSession?.pdfFolder ?? null,
      ...(currentSession?.directoryHandle ? { directoryHandle: currentSession.directoryHandle } : {}),
      ...patch
    };

    const database = await openDatabase();
    const transaction = database.transaction(SESSION_STORE, 'readwrite');
    transaction.objectStore(SESSION_STORE).put(nextSession);
    await transactionAsPromise(transaction);
  }, []);

  const restore = useCallback(async (): Promise<RestoredUploadSession | null> => {
    const sessionId = sessionIdRef.current;
    if (!sessionId) {
      setStatus('unavailable');
      setMessage('当前浏览器阻止了会话缓存；刷新后需要重新上传。');
      return null;
    }

    setStatus('restoring');
    try {
      await pruneExpiredSessions(sessionId);
      const session = await getSession(sessionId);
      if (!session) {
        setStatus('ready');
        return null;
      }

      let restoredPdfFiles: Record<string, File> = {};
      let restoreMessage = '';
      if (session.directoryHandle) {
        const readableDirectory = session.directoryHandle as FileSystemDirectoryHandle & {
          queryPermission?: (descriptor: { mode: 'read' | 'readwrite' }) => Promise<PermissionState>;
        };
        const permission = readableDirectory.queryPermission
          ? await readableDirectory.queryPermission({ mode: 'read' })
          : 'granted';
        if (permission === 'granted') {
          restoredPdfFiles = await collectPdfFilesFromDirectory(session.directoryHandle);
        } else {
          restoreMessage = '为保护本机文件访问权限，请重新选择 PDF 文件夹。';
        }
      } else {
        const storedFiles = await getPdfFiles(sessionId);
        restoredPdfFiles = Object.fromEntries(storedFiles.map(file => [
          file.key,
          new File([file.blob], file.name, { type: file.blob.type || 'application/pdf', lastModified: file.lastModified })
        ]));
      }

      setStatus('ready');
      setMessage(restoreMessage);
      return {
        mapping: session.mapping,
        excel: session.excel,
        pdfFolder: session.pdfFolder,
        pdfFiles: restoredPdfFiles,
        restoredPdfFileCount: Object.keys(restoredPdfFiles).length,
        message: restoreMessage || undefined
      };
    } catch (error) {
      const nextMessage = error instanceof Error ? error.message : '会话文件恢复失败，请重新上传。';
      setStatus('unavailable');
      setMessage(nextMessage);
      return null;
    }
  }, []);

  const saveExcelMapping = useCallback(async (mapping: Record<string, string>, excel: UploadFileSummary) => {
    try {
      await updateSession({ mapping, excel });
      setStatus('ready');
      setMessage('');
    } catch (error) {
      setStatus('unavailable');
      setMessage(error instanceof Error ? error.message : 'Excel 会话缓存失败。');
    }
  }, [updateSession]);

  const savePdfDirectory = useCallback(async (directoryHandle: FileSystemDirectoryHandle, pdfFolder: UploadFileSummary) => {
    try {
      const sessionId = sessionIdRef.current;
      if (!sessionId) throw new Error('当前浏览器不允许会话缓存。');
      await deletePdfFilesForSession(sessionId);
      await updateSession({ directoryHandle, pdfFolder });
      setStatus('ready');
      setMessage('');
    } catch (error) {
      setStatus('unavailable');
      setMessage(error instanceof Error ? error.message : 'PDF 文件夹会话缓存失败。');
    }
  }, [updateSession]);

  const savePdfFiles = useCallback((pdfFiles: Record<string, File>, pdfFolder: UploadFileSummary) => {
    const persistPdfFiles = async () => {
      const sessionId = sessionIdRef.current;
      if (!sessionId) {
        setStatus('unavailable');
        setMessage('当前浏览器不允许会话缓存；刷新后需要重新选择 PDF 文件夹。');
        return;
      }

      try {
        const database = await openDatabase();
        const existingFiles = await getPdfFiles(sessionId);
        const currentSession = await getSession(sessionId);
        const transaction = database.transaction([SESSION_STORE, PDF_STORE], 'readwrite');
        const sessionStore = transaction.objectStore(SESSION_STORE);
        const pdfStore = transaction.objectStore(PDF_STORE);
        existingFiles.forEach(file => pdfStore.delete(file.id));
        Object.entries(pdfFiles).forEach(([key, file]) => {
          pdfStore.put({
            id: `${sessionId}:${key}`,
            sessionId,
            key,
            name: file.name,
            lastModified: file.lastModified,
            blob: file
          } satisfies StoredPdfFile);
        });

        sessionStore.put({
          id: sessionId,
          updatedAt: Date.now(),
          mapping: currentSession?.mapping ?? {},
          excel: currentSession?.excel ?? null,
          pdfFolder
        } satisfies StoredUploadSession);
        await transactionAsPromise(transaction);
        setStatus('ready');
        setMessage('');
      } catch (error) {
        setStatus('unavailable');
        setMessage(error instanceof Error ? error.message : 'PDF 会话缓存空间不足，请重新上传。');
      }
    };

    const queuedWrite = pdfSaveQueueRef.current.then(persistPdfFiles, persistPdfFiles);
    pdfSaveQueueRef.current = queuedWrite.catch(() => undefined);
    return queuedWrite;
  }, []);

  return {
    hasDirectoryPicker,
    status,
    message,
    restore,
    collectPdfFilesFromDirectory,
    saveExcelMapping,
    savePdfDirectory,
    savePdfFiles
  };
}
