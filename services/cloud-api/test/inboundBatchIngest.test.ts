import assert from 'node:assert/strict';
import test from 'node:test';
import { ApiError } from '../src/errors.js';
import { inboundBatchLimits, parseInboundBatchInput } from '../src/inboundBatchIngest.js';

function baseRequest(shipmentCount = 2) {
  return {
    batchId: 'CLIENT-BATCH-20260829-001',
    airPickup: {
      billNo: '18098109734',
      forecastCartons: 100,
      forecastPackages: shipmentCount,
      forecastWeight: 2560,
      forecastWeightUnit: 'KG',
    },
    shipments: Array.from({ length: shipmentCount }, (_, index) => ({
      firstLegTrackingNo: `FL-${String(index + 1).padStart(5, '0')}`,
      courierTrackingNo: `CO-${String(index + 1).padStart(5, '0')}`,
      customerExtension: { lane: 'JFK-A' },
    })),
  };
}

test('parses one upstream batch as one air pickup with many shipment mappings', () => {
  const raw = baseRequest(2);
  const parsed = parseInboundBatchInput(raw);
  assert.equal(parsed.bill.display, '180-98109734');
  assert.equal(parsed.shipments.length, 2);
  assert.strictEqual(parsed.body, raw);
  assert.deepEqual(parsed.shipments[0].rawData.customerExtension, { lane: 'JFK-A' });
});

test('supports the reviewed 2000-shipment customer batch size', () => {
  const parsed = parseInboundBatchInput(baseRequest(2_000));
  assert.equal(parsed.shipments.length, 2_000);
  assert.equal(inboundBatchLimits.maxShipments, 5_000);
});

test('rejects duplicate first-leg numbers inside one atomic batch', () => {
  const raw = baseRequest(2);
  raw.shipments[1].firstLegTrackingNo = raw.shipments[0].firstLegTrackingNo.toLowerCase();
  assert.throws(() => parseInboundBatchInput(raw), (error: unknown) => (
    error instanceof ApiError && error.code === 'DUPLICATE_SHIPMENT'
  ));
});

test('accepts a forecast before any shipments arrive', () => {
  const raw = baseRequest(1);
  raw.shipments = [];
  assert.equal(parseInboundBatchInput(raw).shipments.length, 0);
});

test('requires a valid air-pickup forecast even without shipments', () => {
  const raw = baseRequest(1);
  raw.shipments = [];
  raw.airPickup.forecastWeight = 0;
  assert.throws(() => parseInboundBatchInput(raw), (error: unknown) => (
    error instanceof ApiError && error.code === 'VALIDATION_ERROR'
  ));
});

test('does not persist embedded label bytes in the batch raw payload', () => {
  const raw = baseRequest(1);
  const encoded = Buffer.from('%PDF-1.7\n%%EOF\n').toString('base64');
  Object.assign(raw.shipments[0], { labelPdfBase64: encoded });
  const parsed = parseInboundBatchInput(raw);
  assert.equal(JSON.stringify(parsed.body).includes(encoded), false);
  assert.equal(JSON.stringify(parsed.shipments[0].rawData).includes(encoded), false);
});
