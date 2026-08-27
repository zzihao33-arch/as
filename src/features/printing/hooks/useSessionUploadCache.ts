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
  directoryHandles: FileSystemDirectoryHandle[];
  directoryPdfKeys: string[];
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
  /** @deprecated Kept only so sessions created before v1.2 can still be restored. */
  directoryHandle?: FileSystemDirectoryHandle;
  directoryHandles?: FileSystemDirectoryHandle[];
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
const PDF_WRITE_BATCH_SIZE = 100;

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

const getDirectoryHandles = (session: StoredUploadSession | null) => {
  if (!session) return [];
  const handles = session.directoryHandles?.filter(Boolean) ?? [];
  if (session.directoryHandle && !handles.includes(session.directoryHandle)) {
    handles.push(session.directoryHandle);
  }
  return handles;
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
    const directoryHandles = getDirectoryHandles(currentSession);
    const nextSession: StoredUploadSession = {
      id: sessionId,
      updatedAt: Date.now(),
      mapping: currentSession?.mapping ?? {},
      excel: currentSession?.excel ?? null,
      pdfFolder: currentSession?.pdfFolder ?? null,
      ...(directoryHandles.length > 0 ? { directoryHandles } : {}),
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
      const directoryHandles = getDirectoryHandles(session);
      const directoryPdfKeys: string[] = [];

      for (const directoryHandle of directoryHandles) {
        const readableDirectory = directoryHandle as FileSystemDirectoryHandle & {
          queryPermission?: (descriptor: { mode: 'read' | 'readwrite' }) => Promise<PermissionState>;
        };
        const permission = readableDirectory.queryPermission
          ? await readableDirectory.queryPermission({ mode: 'read' })
          : 'granted';
        if (permission === 'granted') {
          const directoryFiles = await collectPdfFilesFromDirectory(directoryHandle);
          Object.assign(restoredPdfFiles, directoryFiles);
          directoryPdfKeys.push(...Object.keys(directoryFiles));
        } else {
          restoreMessage = '为保护本机文件访问权限，请重新选择 PDF 文件夹。';
        }
      }

      // Directory-backed PDFs are restored from their source folders. Files imported
      // directly or from ZIP packages remain in IndexedDB and intentionally override
      // same-named files from folders, matching the latest-import-wins behaviour.
      const storedFiles = await getPdfFiles(sessionId);
      const storedFileKeys = new Set(storedFiles.map(file => file.key));
      Object.assign(restoredPdfFiles, Object.fromEntries(storedFiles.map(file => [
        file.key,
        new File([file.blob], file.name, { type: file.blob.type || 'application/pdf', lastModified: file.lastModified })
      ])));

      setStatus('ready');
      const restoredPdfFileCount = Object.keys(restoredPdfFiles).length;
      if (session.pdfFolder && restoredPdfFileCount < session.pdfFolder.count) {
        const incompleteMessage = `本次会话仅恢复 ${restoredPdfFileCount.toLocaleString()} / ${session.pdfFolder.count.toLocaleString()} 个 PDF；请重新选择缺失的文件夹或重新导入。`;
        restoreMessage = [restoreMessage, incompleteMessage].filter(Boolean).join(' ');
      }
      setMessage(restoreMessage);
      return {
        mapping: session.mapping,
        excel: session.excel,
        pdfFolder: session.pdfFolder,
        pdfFiles: restoredPdfFiles,
        directoryHandles,
        directoryPdfKeys: directoryPdfKeys.filter(key => !storedFileKeys.has(key)),
        restoredPdfFileCount,
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

  const savePdfFiles = useCallback((
    pdfFiles: Record<string, File>,
    pdfFolder: UploadFileSummary,
    directoryHandles: FileSystemDirectoryHandle[] = []
  ) => {
    const persistPdfFiles = async (): Promise<boolean> => {
      const sessionId = sessionIdRef.current;
      if (!sessionId) {
        setStatus('unavailable');
        setMessage('当前浏览器不允许会话缓存；刷新后需要重新选择 PDF 文件夹。');
        return false;
      }

      try {
        const database = await openDatabase();
        // Record the expected total before writing Blobs. If the browser is closed
        // or quota is exhausted mid-write, the next restore reports an incomplete
        // cache instead of pretending that an older 1,000-file snapshot is current.
        await updateSession({ pdfFolder, directoryHandles });
        const existingFiles = await getPdfFiles(sessionId);
        const entries = Object.entries(pdfFiles);
        const retainedKeys = new Set(entries.map(([key]) => key));
        const staleFiles = existingFiles.filter(file => !retainedKeys.has(file.key));

        // IndexedDB will frequently abort a huge atomic transaction when several
        // thousand PDF Blobs are written at once. Commit small batches so a 3,600+
        // file import is durable rather than silently falling back to an older cache.
        for (let start = 0; start < staleFiles.length; start += PDF_WRITE_BATCH_SIZE) {
          const transaction = database.transaction(PDF_STORE, 'readwrite');
          const pdfStore = transaction.objectStore(PDF_STORE);
          staleFiles.slice(start, start + PDF_WRITE_BATCH_SIZE).forEach(file => pdfStore.delete(file.id));
          await transactionAsPromise(transaction);
        }

        for (let start = 0; start < entries.length; start += PDF_WRITE_BATCH_SIZE) {
          const transaction = database.transaction(PDF_STORE, 'readwrite');
          const pdfStore = transaction.objectStore(PDF_STORE);
          entries.slice(start, start + PDF_WRITE_BATCH_SIZE).forEach(([key, file]) => {
            pdfStore.put({
              id: `${sessionId}:${key}`,
              sessionId,
              key,
              name: file.name,
              lastModified: file.lastModified,
              blob: file
            } satisfies StoredPdfFile);
          });
          await transactionAsPromise(transaction);
          // Yield between batches so the import does not monopolise the UI thread.
          await new Promise<void>(resolve => window.setTimeout(resolve, 0));
        }

        await updateSession({ pdfFolder, directoryHandles });
        setStatus('ready');
        setMessage('');
        return true;
      } catch (error) {
        setStatus('unavailable');
        setMessage(error instanceof Error ? error.message : 'PDF 会话缓存空间不足，请重新上传。');
        return false;
      }
    };

    const queuedWrite = pdfSaveQueueRef.current.then(persistPdfFiles, persistPdfFiles);
    pdfSaveQueueRef.current = queuedWrite.then(() => undefined, () => undefined);
    return queuedWrite;
  }, []);

  return {
    hasDirectoryPicker,
    status,
    message,
    restore,
    collectPdfFilesFromDirectory,
    saveExcelMapping,
    savePdfFiles
  };
}
