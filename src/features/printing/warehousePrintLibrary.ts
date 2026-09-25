import { downloadWarehouseLabel, lookupWarehouseShipment } from '../session/warehouseApi';

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

async function sha256(blob: Blob): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
  return Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, '0')).join('');
}

export async function readCloudLabelFile(target: CloudPrintTarget): Promise<File> {
  // Cloud PDFs live only for this print attempt; never consult or persist IndexedDB.
  const blob = await downloadWarehouseLabel(target.labelDownloadPath);
  if (blob.size !== target.labelByteSize || await blob.slice(0, 5).text() !== '%PDF-') {
    throw new Error(`面单 ${target.firstLegTrackingNo} 的文件格式或大小校验失败。`);
  }
  if (await sha256(blob) !== target.labelSha256.toLowerCase()) {
    throw new Error(`面单 ${target.firstLegTrackingNo} 的 SHA-256 校验失败。`);
  }
  const name = `${target.courierTrackingNo || target.firstLegTrackingNo}.pdf`;
  return new File([blob], name, { type: 'application/pdf', lastModified: Date.now() });
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
