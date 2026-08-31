export type LocalFirstStore = 'intercepts' | 'bolRecords' | 'printLogs' | 'payrollDrafts' | 'employeeRates' | 'cloudShipments' | 'cloudLabels' | 'cloudSync' | 'cloudPrintOutbox' | 'sharedPrintOutbox';

const DATABASE_NAME = 'cmhub-local-first-v1';
const DATABASE_VERSION = 5;

const openDatabase = () => new Promise<IDBDatabase>((resolve, reject) => {
  const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);

  request.onupgradeneeded = () => {
    const database = request.result;
    (['intercepts', 'bolRecords', 'printLogs', 'payrollDrafts', 'employeeRates', 'cloudShipments', 'cloudLabels', 'cloudSync', 'cloudPrintOutbox', 'sharedPrintOutbox'] as const).forEach((storeName) => {
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

export interface LocalFirstEntry<T> {
  key: IDBValidKey;
  value: T;
}

export async function readAllLocalFirstEntries<T>(storeName: LocalFirstStore): Promise<Array<LocalFirstEntry<T>>> {
  const database = await openDatabase();
  const transaction = database.transaction(storeName, 'readonly');
  const completed = transactionAsPromise(transaction);
  const objectStore = transaction.objectStore(storeName);
  const [keys, values] = await Promise.all([
    requestAsPromise(objectStore.getAllKeys()),
    requestAsPromise(objectStore.getAll())
  ]);
  await completed;
  return keys.map((key, index) => ({ key, value: values[index] as T }));
}

export async function writeLocalFirstValue<T>(storeName: LocalFirstStore, key: IDBValidKey, value: T): Promise<void> {
  const database = await openDatabase();
  const transaction = database.transaction(storeName, 'readwrite');
  const completed = transactionAsPromise(transaction);
  transaction.objectStore(storeName).put(value, key);
  await completed;
}

export async function updateLocalFirstEntries<T>(
  storeName: LocalFirstStore,
  entries: ReadonlyArray<LocalFirstEntry<T>>,
  deletedKeys: ReadonlyArray<IDBValidKey> = []
): Promise<void> {
  const database = await openDatabase();
  const transaction = database.transaction(storeName, 'readwrite');
  const completed = transactionAsPromise(transaction);
  const objectStore = transaction.objectStore(storeName);
  deletedKeys.forEach(key => objectStore.delete(key));
  entries.forEach(({ key, value }) => objectStore.put(value, key));
  await completed;
}

export async function deleteLocalFirstValue(storeName: LocalFirstStore, key: IDBValidKey): Promise<void> {
  const database = await openDatabase();
  const transaction = database.transaction(storeName, 'readwrite');
  const completed = transactionAsPromise(transaction);
  transaction.objectStore(storeName).delete(key);
  await completed;
}
