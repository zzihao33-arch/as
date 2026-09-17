import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  deleteLocalFirstValue,
  readAllLocalFirstEntries,
  readLocalFirstValue,
  updateLocalFirstEntries,
  writeLocalFirstValue,
} from '../../shared/storage/localFirstDatabase';
import { useWarehouseSession } from '../session/WarehouseSessionProvider';
import { downloadWarehouseLabel, listWarehouseShipments, type WarehouseShipment } from '../session/warehouseApi';
import { normalizeBarcode } from './printMatching';

export interface CloudPrintTarget {
  shipmentId: string;
  labelAssetId: string;
  firstLegTrackingNo: string;
  courierTrackingNo: string | null;
  labelSha256: string;
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

async function downloadAndValidateLabel(warehouseId: string, shipment: WarehouseShipment): Promise<void> {
  const asset = shipment.labelAsset;
  if (!asset) return;
  const key = labelKey(warehouseId, asset.id);
  const existing = await readLocalFirstValue<CachedCloudLabel>('cloudLabels', key);
  if (existing?.sha256 === asset.sha256 && existing.blob.size === asset.byteSize) return;
  const blob = await downloadWarehouseLabel(asset.downloadPath);
  if (blob.size !== asset.byteSize || await blob.slice(0, 5).text() !== '%PDF-') {
    throw new Error(`面单 ${shipment.firstLegTrackingNo} 的文件格式或大小校验失败。`);
  }
  const actualHash = await sha256(blob);
  if (actualHash !== asset.sha256.toLowerCase()) {
    throw new Error(`面单 ${shipment.firstLegTrackingNo} 的 SHA-256 校验失败。`);
  }
  await writeLocalFirstValue('cloudLabels', key, {
    warehouseId, assetId: asset.id, sha256: actualHash, blob, cachedAt: Date.now(),
  } satisfies CachedCloudLabel);
}

async function mapWithConcurrency<T>(values: T[], concurrency: number, task: (value: T) => Promise<void>): Promise<void> {
  let index = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (index < values.length) {
      const current = values[index++];
      await task(current);
    }
  }));
}

async function loadTargets(warehouseId: string): Promise<CloudPrintTarget[]> {
  const entries = await readAllLocalFirstEntries<CachedCloudShipment>('cloudShipments');
  return entries
    .map(entry => entry.value)
    .filter(shipment => shipment.warehouseId === warehouseId && shipment.status === 'READY_TO_PRINT' && shipment.labelAsset)
    .map(shipment => ({
      shipmentId: shipment.id,
      labelAssetId: shipment.labelAsset!.id,
      firstLegTrackingNo: shipment.firstLegTrackingNo,
      courierTrackingNo: shipment.courierTrackingNo,
      labelSha256: shipment.labelAsset!.sha256,
      updatedAt: shipment.updatedAt,
    }));
}

async function synchronizeWarehouse(warehouseId: string, onPage: (targets: CloudPrintTarget[]) => void): Promise<number> {
  const syncKey = `warehouse:${warehouseId}`;
  let state = await readLocalFirstValue<SyncState>('cloudSync', syncKey) ?? { cursor: null, syncedAt: 0 };
  let synchronized = 0;
  do {
    const page = await listWarehouseShipments(state.cursor, 200);
    await mapWithConcurrency(
      page.data.filter(shipment => shipment.status === 'READY_TO_PRINT' && shipment.labelAsset),
      4,
      shipment => downloadAndValidateLabel(warehouseId, shipment)
    );
    const staleLabelKeys: string[] = [];
    for (const shipment of page.data) {
      const existing = await readLocalFirstValue<CachedCloudShipment>('cloudShipments', shipmentKey(warehouseId, shipment.id));
      if (existing?.labelAsset?.id && (
        shipment.status !== 'READY_TO_PRINT' || existing.labelAsset.id !== shipment.labelAsset?.id
      )) {
        staleLabelKeys.push(labelKey(warehouseId, existing.labelAsset.id));
      }
    }
    await updateLocalFirstEntries('cloudShipments', page.data.map(shipment => ({
      key: shipmentKey(warehouseId, shipment.id),
      value: { ...shipment, warehouseId } satisfies CachedCloudShipment,
    })));
    await Promise.all(staleLabelKeys.map(key => deleteLocalFirstValue('cloudLabels', key)));
    state = { cursor: page.cursor, syncedAt: Date.now() };
    await writeLocalFirstValue('cloudSync', syncKey, state);
    synchronized += page.data.length;
    onPage(await loadTargets(warehouseId));
    if (!page.hasMore) break;
  } while (true);
  return synchronized;
}

export async function readCloudLabelFile(warehouseId: string, target: CloudPrintTarget): Promise<File> {
  const cached = await readLocalFirstValue<CachedCloudLabel>('cloudLabels', labelKey(warehouseId, target.labelAssetId));
  if (!cached || cached.sha256 !== target.labelSha256) throw new Error('云端面单尚未同步到本机，请等待同步完成后重试。');
  const name = `${target.courierTrackingNo || target.firstLegTrackingNo}.pdf`;
  return new File([cached.blob], name, { type: 'application/pdf', lastModified: cached.cachedAt });
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
      setMessage('正在同步云端单据与面单…');
      try {
        const count = await synchronizeWarehouse(warehouseId, setTargets);
        setTargets(await loadTargets(warehouseId));
        setStatus('ready');
        setMessage(count > 0 ? `云端同步完成，本次处理 ${count} 条更新。` : '云端数据已是最新。');
      } catch (cause) {
        setStatus('error');
        setMessage(cause instanceof Error ? cause.message : '云端面单同步失败。');
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
