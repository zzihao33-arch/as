export type LocalFirstStore = 'intercepts' | 'bolRecords' | 'printLogs' | 'payrollDrafts' | 'employeeRates';

const DATABASE_NAME = 'cmhub-local-first-v1';
const DATABASE_VERSION = 2;

const openDatabase = () => new Promise<IDBDatabase>((resolve, reject) => {
  const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);

  request.onupgradeneeded = () => {
    const database = request.result;
    (['intercepts', 'bolRecords', 'printLogs', 'payrollDrafts', 'employeeRates'] as const).forEach((storeName) => {
      if (!database.objectStoreNames.contains(storeName)) {
        database.createObjectStore(storeName);
      }
    });
  };
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error ?? new Error('本机数据仓库无法打开。'));
});

const transactionAsPromise = (transaction: IDBTransaction) => new Promise<void>((resolve, reject) => {
  transaction.oncomplete = () => resolve();
  transaction.onabort = () => reject(transaction.error ?? new Error('本机数据保存失败。'));
  transaction.onerror = () => reject(transaction.error ?? new Error('本机数据保存失败。'));
});

const requestAsPromise = <T>(request: IDBRequest<T>) => new Promise<T>((resolve, reject) => {
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error ?? new Error('本机数据读取失败。'));
});

export async function readLocalFirstValue<T>(storeName: LocalFirstStore, key: IDBValidKey): Promise<T | null> {
  const database = await openDatabase();
  const transaction = database.transaction(storeName, 'readonly');
  const completed = transactionAsPromise(transaction);
  const value = await requestAsPromise(transaction.objectStore(storeName).get(key));
  await completed;
  return (value as T | undefined) ?? null;
}

export async function writeLocalFirstValue<T>(storeName: LocalFirstStore, key: IDBValidKey, value: T): Promise<void> {
  const database = await openDatabase();
  const transaction = database.transaction(storeName, 'readwrite');
  const completed = transactionAsPromise(transaction);
  transaction.objectStore(storeName).put(value, key);
  await completed;
}

export async function deleteLocalFirstValue(storeName: LocalFirstStore, key: IDBValidKey): Promise<void> {
  const database = await openDatabase();
  const transaction = database.transaction(storeName, 'readwrite');
  const completed = transactionAsPromise(transaction);
  transaction.objectStore(storeName).delete(key);
  await completed;
}
