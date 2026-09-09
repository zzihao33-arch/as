import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createHash } from 'node:crypto';
import { ApiError } from '../src/errors.js';
import { parseShipmentUpsert } from '../src/shipmentInput.js';

function assertValidationError(parse: () => unknown): void {
  assert.throws(parse, (error: unknown) => {
    assert.ok(error instanceof ApiError);
    assert.equal(error.status, 400);
    assert.equal(error.code, 'VALIDATION_ERROR');
    return true;
  });
}

describe('parseShipmentUpsert', () => {
  it('keeps unknown upstream fields in rawData', () => {
    const body = {
      firstLegTrackingNo: ' FL-1001 ',
      warehouseRouting: { lane: 'A-4' },
      customerExtension: true,
    };

    const input = parseShipmentUpsert(body);

    assert.equal(input.firstLegTrackingNo, 'FL-1001');
    assert.strictEqual(input.rawData, body);
    assert.deepEqual(input.rawData.warehouseRouting, { lane: 'A-4' });
    assert.equal(input.rawData.customerExtension, true);
  });

  it('accepts a shipment when upstream order fields are omitted or only partially supplied', () => {
    const minimal = parseShipmentUpsert({ firstLegTrackingNo: 'FL-1002' });
    assert.equal(minimal.order, undefined);

    const partial = parseShipmentUpsert({
      firstLegTrackingNo: 'FL-1003',
      recipient_name: ' Jane Doe ',
      items: [],
    });
    assert.deepEqual(partial.order, {
      orderId: undefined,
      recipientName: 'Jane Doe',
      phone: undefined,
      address: undefined,
      items: [],
    });
  });

  it('does not treat an upstream status as authoritative shipment state', () => {
    const input = parseShipmentUpsert({
      firstLegTrackingNo: 'FL-1004',
      status: 'PRINTED',
    });

    assert.equal(Object.hasOwn(input, 'status'), false);
    assert.equal(input.rawData.status, 'PRINTED');
  });

  it('accepts HTTPS label URLs', () => {
    const input = parseShipmentUpsert({
      firstLegTrackingNo: 'FL-1005',
      labelUrl: 'https://labels.example.com/FL-1005.pdf',
    });

    assert.equal(input.labelUrl, 'https://labels.example.com/FL-1005.pdf');
  });

  it('rejects non-HTTPS and malformed label URLs', () => {
    for (const labelUrl of ['http://labels.example.com/FL-1006.pdf', '/labels/FL-1006.pdf', 'not a URL']) {
      assertValidationError(() => parseShipmentUpsert({ firstLegTrackingNo: 'FL-1006', labelUrl }));
    }
  });
});

describe('inline PDF shipment input', () => {
  const pdf = Buffer.from('%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF\n');
  const base = { firstLegTrackingNo: 'A', courierTrackingNo: 'B', labelPdfBase64: pdf.toString('base64') };

  it('decodes the three-field push and retains only the PDF fingerprint in raw data', () => {
    const parsed = parseShipmentUpsert(base);
    assert.deepEqual(parsed.labelPdf?.content, pdf);
    assert.equal(parsed.labelSha256, createHash('sha256').update(pdf).digest('hex'));
    assert.equal(Object.hasOwn(parsed.rawData, 'labelPdfBase64'), false);
    assert.equal(JSON.stringify(parsed.rawData).includes(base.labelPdfBase64), false);
    assert.equal(base.labelPdfBase64, pdf.toString('base64'));
  });

  it('requires a courier number when sending an inline label', () => {
    assertValidationError(() => parseShipmentUpsert({ ...base, courierTrackingNo: undefined }));
  });

  it('rejects malformed Base64, empty and non-PDF content', () => {
    for (const labelPdfBase64 of ['', '%%%!!!', 'data:application/pdf;base64,' + base.labelPdfBase64, 'bm90IHBkZg==', base.labelPdfBase64 + '!']) {
      assert.throws(() => parseShipmentUpsert({ ...base, labelPdfBase64 }), ApiError);
    }
  });

  it('rejects a decoded PDF over 20 MiB and a contradictory declared hash', () => {
    assert.throws(() => parseShipmentUpsert({ ...base, labelPdfBase64: Buffer.alloc(20 * 1024 * 1024 + 1).toString('base64') }),
      (error: unknown) => error instanceof ApiError && error.status === 413);
    assert.throws(() => parseShipmentUpsert({ ...base, labelSha256: '0'.repeat(64) }),
      (error: unknown) => error instanceof ApiError && error.code === 'LABEL_HASH_MISMATCH');
  });
});
