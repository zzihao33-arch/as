import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ApiError } from '../src/errors.js';
import { createTygV11Integration, parseTygAirShipment, parseTygLabelPush, tygLabelDecision, validateTygIdempotencyKey } from '../src/tygV11.js';

const pdf = Buffer.from('%PDF-1.7\n1 0 obj\n<<>>\nendobj\nstartxref\n0\n%%EOF\n', 'ascii').toString('base64');

describe('TYG v1.1 contract', () => {
  it('requires a valid idempotency key', () => {
    assert.throws(() => validateTygIdempotencyKey(undefined), { code: 'IDEMPOTENCY_KEY_REQUIRED' });
    assert.equal(validateTygIdempotencyKey('tyg-label-001'), 'tyg-label-001');
  });

  it('replays a v1.1 response before taking a Redis lock', async () => {
    const body = { airWaybillNo: '180-98109734', forecastCartons: 2, forecastPackages: 4, forecastWeight: 1.25, weightUnit: 'KG' };
    const integration = createTygV11Integration({
      mysql: { execute: async () => [[{ payload_sha256: (await import('../src/shipmentIngest.js')).hashInboundPayload(body), processing_status: 'COMPLETED', response_status: 200, response_body: JSON.stringify({ code: 'SUCCESS', message: 'saved', data: {}, requestId: 'original-id' }) }]] } as never,
      redis: { set: async () => { throw new Error('replay must not lock'); } } as never,
      storage: {} as never,
    });
    const result = await integration.upsertAirShipment({ client: { id: 'client-1', apiKeyId: 'key-1', scopes: ['shipments:write'], rateLimitPerMinute: 60 }, requestId: 'request-1', idempotencyKey: 'tyg-air-001', body });
    assert.equal(result.body.idempotentReplay, true);
    assert.equal(result.body.requestId, 'original-id');
  });

  it('accepts the agreed original/transfer/PDF payload and validates its PDF', () => {
    const input = parseTygLabelPush({ airWaybillNo: '180-98109734', originalTrackingNo: 'ORIGINAL-1', transferTrackingNo: 'TRANSFER-1', labelBase64: pdf });
    assert.equal(input.originalTrackingNo, 'ORIGINAL-1');
    assert.equal(input.transferTrackingNo, 'TRANSFER-1');
    assert.equal(input.pdf.content.toString('ascii', 0, 5), '%PDF-');
  });

  it('rejects data URLs, non-PDFs, and PDFs over 5 MiB', () => {
    const base = { airWaybillNo: '180-98109734', originalTrackingNo: 'ORIGINAL-1', transferTrackingNo: 'TRANSFER-1' };
    assert.throws(() => parseTygLabelPush({ ...base, labelBase64: `data:application/pdf;base64,${pdf}` }), { code: 'INVALID_BASE64' });
    assert.throws(() => parseTygLabelPush({ ...base, labelBase64: Buffer.from('not a pdf').toString('base64') }), { code: 'INVALID_LABEL_PDF' });
    const large = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(5 * 1024 * 1024), Buffer.from('%%EOF')]).toString('base64');
    assert.throws(() => parseTygLabelPush({ ...base, labelBase64: large }), { code: 'PAYLOAD_TOO_LARGE' });
  });

  it('enforces duplicate, replacement, and binding decisions', () => {
    assert.equal(tygLabelDecision({ exists: false, sameRelationAndPdf: false, relationshipChanged: false, transferIsBoundToAnother: false, originalIsBoundToAnotherAirShipment: false }), 'CREATED');
    assert.equal(tygLabelDecision({ exists: true, sameRelationAndPdf: true, relationshipChanged: false, transferIsBoundToAnother: false, originalIsBoundToAnotherAirShipment: false }), 'DUPLICATE');
    assert.equal(tygLabelDecision({ exists: true, sameRelationAndPdf: false, relationshipChanged: false, transferIsBoundToAnother: false, originalIsBoundToAnotherAirShipment: false }), 'PDF_REPLACED');
    assert.equal(tygLabelDecision({ exists: true, sameRelationAndPdf: false, relationshipChanged: true, transferIsBoundToAnother: false, originalIsBoundToAnotherAirShipment: false }), 'TRACKING_AND_PDF_UPDATED');
    assert.throws(() => tygLabelDecision({ exists: true, sameRelationAndPdf: false, relationshipChanged: true, transferIsBoundToAnother: true, originalIsBoundToAnotherAirShipment: false }), (error: unknown) => {
      assert.ok(error instanceof ApiError); assert.equal(error.code, 'TRACKING_ALREADY_BOUND'); return true;
    });
  });

  it('parses the separate v1.1 air-shipment forecast contract', () => {
    const air = parseTygAirShipment({ airWaybillNo: '180-98109734', forecastCartons: 2, forecastPackages: 4, forecastWeight: 1.25, weightUnit: 'kg' });
    assert.equal(air.bill.display, '180-98109734');
    assert.equal(air.weightUnit, 'KG');
  });
});
