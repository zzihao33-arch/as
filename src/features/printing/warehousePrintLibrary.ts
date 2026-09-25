import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  clearWarehouseLabelCache,
  deleteLocalFirstValue,
  readAllLocalFirstEntries,
  readLocalFirstValue,
  updateLocalFirstEntries,
  writeLocalFirstValue,
} from '../../shared/storage/localFirstDatabase';
import { useWarehouseSession } from '../session/WarehouseSessionProvider';
import { downloadWarehouseLabel, listWarehouseShipments, lookupWarehouseShipment, type WarehouseShipment } from '../session/warehouseApi';
import { normalizeBarcode } from './printMatching';

export interface CloudPrintTarget {
  version: number;
  shipmentId: string;
  labelAssetId: string;
  firstLegTrackingNo: string;
  courierTrackingNo: string | null;
  labelSha256: string;
  labelByteSize: number;
  labelDownloadPath: string;
  updatedAt: string;
}

type CachedCloudShipment = WarehouseShipment & { warehouseId: string };
type CachedCloudLabel = { warehouseId: string; assetId: string; sha256: string; blob: Blob; cachedAt: number };
type SyncState = { cursor: string | null; syncedAt: number };
type LibraryStatus = 'loading' | 'syncing' | 'ready' | 'error';

function shipmentKey(warehouseId: string, shipmentId: string) { return `${warehouseId}:${shipmentId}`; }
function labelKey(warehouseId: string, assetId: string) { return `${warehouseId}:${assetId}`; }

async function sha256(blob: Blob): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
  return Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, '0')).join('');
}

async function downloadAndValidateLabel(warehouseId: string, target: CloudPrintTarget): Promise<CachedCloudLabel> {
  const key = labelKey(warehouseId, target.labelAssetId);
  const existing = await readLocalFirstValue<CachedCloudLabel>('cloudLabels', key).catch(() => null);
  if (existing?.sha256 === target.labelSha256.toLowerCase() && existing.blob.size === target.labelByteSize) return existing;
  const blob = await downloadWarehouseLabel(target.labelDownloadPath);
  if (blob.size !== target.labelByteSize || await blob.slice(0, 5).text() !== '%PDF-') {
    throw new Error(`面单 ${target.firstLegTrackingNo} 的文件格式或大小校验失败。`);
  }
  const actualHash = await sha256(blob);
  if (actualHash !== target.labelSha256.toLowerCase()) {
    throw new Error(`面单 ${target.firstLegTrackingNo} 的 SHA-256 校验失败。`);
  }
  const label = { warehouseId, assetId: target.labelAssetId, sha256: actualHash, blob, cachedAt: Date.now() };
  try {
    await writeLocalFirstValue('cloudLabels', key, label);
  } catch {
    // Cache persistence is optional; the downloaded file has already been verified.
  }
  return label;
}

async function loadTargets(warehouseId: string): Promise<CloudPrintTarget[]> {
  const entries = await readAllLocalFirstEntries<CachedCloudShipment>('cloudShipments');
  return entries
    .map(entry => entry.value)
    .filter(shipment => shipment.warehouseId === warehouseId && shipment.status === 'READY_TO_PRINT' && shipment.labelAsset)
    .map(shipment => ({
      version: shipment.version,
      shipmentId: shipment.id,
      labelAssetId: shipment.labelAsset!.id,
      firstLegTrackingNo: shipment.firstLegTrackingNo,
      courierTrackingNo: shipment.courierTrackingNo,
      labelSha256: shipment.labelAsset!.sha256,
      labelByteSize: shipment.labelAsset!.byteSize,
      labelDownloadPath: shipment.labelAsset!.downloadPath,
      updatedAt: shipment.updatedAt,
    }));
}

async function synchronizeWarehouse(warehouseId: string, onPage: (targets: CloudPrintTarget[]) => void): Promise<number> {
  let stage = 'read-cursor';
  try {
  const syncKey = `warehouse:${warehouseId}`;
  let state = await readLocalFirstValue<SyncState>('cloudSync', syncKey) ?? { cursor: null, syncedAt: 0 };
  let synchronized = 0;
  do {
    stage = 'fetch-page';
    const page = await listWarehouseShipments(state.cursor, 200);
    // Index metadata independently of PDF downloads. A historical asset must not
    // block every later shipment; PDFs are fetched and validated when scanned.
    const staleLabelKeys: string[] = [];
    stage = 'read-existing-index';
    for (const shipment of page.data) {
      const existing = await readLocalFirstValue<CachedCloudShipment>('cloudShipments', shipmentKey(warehouseId, shipment.id));
      if (existing?.labelAsset?.id && (
        shipment.status !== 'READY_TO_PRINT' || existing.labelAsset.id !== shipment.labelAsset?.id
      )) {
        staleLabelKeys.push(labelKey(warehouseId, existing.labelAsset.id));
      }
    }
    const entries = page.data.map(shipment => ({
      key: shipmentKey(warehouseId, shipment.id),
      value: { ...shipment, warehouseId } satisfies CachedCloudShipment,
    }));
    try {
      stage = 'write-index';
      await updateLocalFirstEntries('cloudShipments', entries);
    } catch (cause) {
      if (!(cause instanceof DOMException && cause.name === 'QuotaExceededError')) throw cause;
      stage = 'evict-pdf-cache';
      await clearWarehouseLabelCache(warehouseId);
      stage = 'retry-write-index';
      await updateLocalFirstEntries('cloudShipments', entries);
    }
    stage = 'delete-stale-pdf';
    await Promise.all(staleLabelKeys.map(key => deleteLocalFirstValue('cloudLabels', key)));
    state = { cursor: page.cursor, syncedAt: Date.now() };
    stage = 'write-cursor';
    await writeLocalFirstValue('cloudSync', syncKey, state);
    synchronized += page.data.length;
    stage = 'read-index';
    onPage(await loadTargets(warehouseId));
    if (!page.hasMore) break;
  } while (true);
  return synchronized;
  } catch (cause) {
    console.error('Cloud shipment sync failed', JSON.stringify({
      stage,
      name: cause instanceof Error ? cause.name : 'UnknownError',
      message: cause instanceof Error ? cause.message : '',
    }));
    throw cause;
  }
}

export async function readCloudLabelFile(warehouseId: string, target: CloudPrintTarget): Promise<File> {
  const cached = await downloadAndValidateLabel(warehouseId, target);
  const name = `${target.courierTrackingNo || target.firstLegTrackingNo}.pdf`;
  return new File([cached.blob], name, { type: 'application/pdf', lastModified: cached.cachedAt });
}

export async function resolveCloudPrintTarget(trackingNo: string): Promise<CloudPrintTarget | null> {
  const shipment = await lookupWarehouseShipment(trackingNo);
  if (!shipment) return null;
  if (shipment.status !== 'READY_TO_PRINT' || !shipment.labelAsset) throw new Error('当前运单或面单不可打印，请核对客户推送状态。');
  return {
    version: shipment.version,
    shipmentId: shipment.id, labelAssetId: shipment.labelAsset.id,
    firstLegTrackingNo: shipment.firstLegTrackingNo, courierTrackingNo: shipment.courierTrackingNo,
    labelSha256: shipment.labelAsset.sha256, labelByteSize: shipment.labelAsset.byteSize,
    labelDownloadPath: shipment.labelAsset.downloadPath, updatedAt: shipment.updatedAt,
  };
}

export function useWarehousePrintLibrary() {
  const { session } = useWarehouseSession();
  const [targets, setTargets] = useState<CloudPrintTarget[]>([]);
  const [status, setStatus] = useState<LibraryStatus>('loading');
  const [message, setMessage] = useState('正在读取云端面单缓存…');
  const runningRef = useRef<Promise<void> | null>(null);

  const sync = useCallback(() => {
    const warehouseId = session?.warehouseId;
    if (!warehouseId || runningRef.current) return runningRef.current ?? Promise.resolve();
    const run = (async () => {
      setStatus('syncing');
      setMessage('正在同步云端单号，PDF 将在扫描时按需下载…');
      try {
        const count = await synchronizeWarehouse(warehouseId, pageTargets => {
          setTargets(pageTargets);
          setMessage(`正在同步云端单号，已有 ${pageTargets.length.toLocaleString()} 票可匹配…`);
        });
        setTargets(await loadTargets(warehouseId));
        setStatus('ready');
        setMessage(count > 0 ? `云端同步完成，本次处理 ${count} 条更新。` : '云端数据已是最新。');
      } catch (cause) {
        setStatus('error');
        setMessage(cause instanceof Error && cause.message ? cause.message : '云端单号同步失败，请检查网络与浏览器存储空间后重试。');
      } finally {
        runningRef.current = null;
      }
    })();
    runningRef.current = run;
    return run;
  }, [session]);

  useEffect(() => {
    const warehouseId = session?.warehouseId;
    if (!warehouseId) return;
    let current = true;
    void loadTargets(warehouseId).then(cached => {
      if (!current) return;
      setTargets(cached);
      void sync();
    });
    const interval = window.setInterval(() => void sync(), 60_000);
    const online = () => void sync();
    window.addEventListener('online', online);
    return () => {
      current = false;
      window.clearInterval(interval);
      window.removeEventListener('online', online);
    };
  }, [session, sync]);

  const byBarcode = useMemo(() => {
    const result = new Map<string, CloudPrintTarget>();
    for (const target of targets) {
      result.set(normalizeBarcode(target.firstLegTrackingNo), target);
      if (target.courierTrackingNo) result.set(normalizeBarcode(target.courierTrackingNo), target);
    }
    return result;
  }, [targets]);

  return { byBarcode, count: targets.length, status, message, sync };
}
