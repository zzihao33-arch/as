import { ApiError } from './errors.js';

export type ShipmentStatus = 'RECEIVED' | 'READY_TO_PRINT' | 'PRINTED' | 'BLOCKED' | 'PRINT_FAILED' | 'CANCELLED';

export type UpstreamOrderDetails = {
  orderId?: string;
  recipientName?: string;
  phone?: string;
  address?: string | Record<string, unknown>;
  items?: unknown[];
};

export type ShipmentUpsertInput = {
  firstLegTrackingNo: string;
  courierTrackingNo?: string;
  carrier?: string;
  labelUrl?: string;
  labelSha256?: string;
  attributes?: Record<string, unknown>;
  order?: UpstreamOrderDetails;
  rawData: Record<string, unknown>;
};

const upstreamOrderFields = ['order_id', 'recipient_name', 'phone', 'address', 'items'] as const;

function text(value: unknown, field: string, maxLength = 128, required = false): string | undefined {
  if (value === undefined || value === null || value === '') {
    if (required) throw new ApiError(400, 'VALIDATION_ERROR', `${field} 为必填项。`);
    return undefined;
  }
  if (typeof value !== 'string') throw new ApiError(400, 'VALIDATION_ERROR', `${field} 必须是字符串。`);
  const result = value.trim();
  if (!result || result.length > maxLength) {
    throw new ApiError(400, 'VALIDATION_ERROR', `${field} 长度无效。`);
  }
  return result;
}

function object(value: unknown, field: string, required = false): Record<string, unknown> | undefined {
  if (value === undefined || value === null) {
    if (required) throw new ApiError(400, 'VALIDATION_ERROR', `${field} 为必填项。`);
    return undefined;
  }
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new ApiError(400, 'VALIDATION_ERROR', `${field} 必须是对象。`);
  }
  return value as Record<string, unknown>;
}

function address(value: unknown): string | Record<string, unknown> | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value === 'string') {
    const result = value.trim();
    if (result) return result;
  }
  if (value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length > 0) {
    return value as Record<string, unknown>;
  }
  throw new ApiError(400, 'VALIDATION_ERROR', 'address 必须是非空字符串或非空对象。');
}

function items(value: unknown): unknown[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) throw new ApiError(400, 'VALIDATION_ERROR', 'items 必须是数组。');
  return value;
}

function verifyHttpsUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:') throw new Error('not https');
    return url.toString();
  } catch {
    throw new ApiError(400, 'VALIDATION_ERROR', 'labelUrl 必须为 HTTPS URL。');
  }
}

function readUpstreamOrderDetails(body: Record<string, unknown>): UpstreamOrderDetails | undefined {
  const hasAnyCoreField = upstreamOrderFields.some((field) => Object.hasOwn(body, field));
  if (!hasAnyCoreField) return undefined;

  return {
    orderId: text(body.order_id, 'order_id', 128),
    recipientName: text(body.recipient_name, 'recipient_name', 128),
    phone: text(body.phone, 'phone', 64),
    address: address(body.address),
    items: items(body.items),
  };
}

export function parseShipmentUpsert(body: unknown): ShipmentUpsertInput {
  const rawData = object(body, '请求体', true)!;
  const labelSha256 = text(rawData.labelSha256, 'labelSha256', 64);
  if (labelSha256 && !/^[a-fA-F0-9]{64}$/.test(labelSha256)) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'labelSha256 必须是 64 位十六进制 SHA-256。');
  }

  return {
    firstLegTrackingNo: text(rawData.firstLegTrackingNo, 'firstLegTrackingNo', 128, true)!,
    courierTrackingNo: text(rawData.courierTrackingNo, 'courierTrackingNo'),
    carrier: text(rawData.carrier, 'carrier', 64),
    labelUrl: verifyHttpsUrl(text(rawData.labelUrl, 'labelUrl', 2048)),
    labelSha256: labelSha256?.toLowerCase(),
    attributes: object(rawData.attributes, 'attributes'),
    order: readUpstreamOrderDetails(rawData),
    rawData,
  };
}
