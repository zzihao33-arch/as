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

const labelBody = { airWaybillNo: '180-98109734', originalTrackingNo: 'ORIGINAL-1', transferTrackingNo: 'TRANSFER-1', labelBase64: pdf };
function atomicFixture(existing = false, expired = false, failure = '') {
  const calls: { sql: string; params: unknown[] }[] = [], steps: string[] = [], keys: string[] = [];
  const client = { id: 'client', apiKeyId: 'key', scopes: ['labels:write' as const], rateLimitPerMinute: 60 };
  const connection = {
    beginTransaction: async () => { steps.push('begin'); }, commit: async () => { steps.push('commit'); }, rollback: async () => { steps.push('rollback'); }, release: () => {},
    execute: async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      if (sql.includes('FROM customer_profiles')) return [[{ customer_profile_id: 'profile' }]];
      if (sql.includes('FROM air_pickup_orders')) return [[{ id: 'air', client_id: 'client', customer_profile_id: 'profile', order_status: 'HANDED_OVER' }]];
      if (sql.includes('FROM shipments') && sql.includes('first_leg_tracking_no =')) return [existing ? [{ id: 'shipment', air_pickup_order_id: 'air', courier_tracking_no: 'TRANSFER-1', current_label_asset_id: 'asset', status: 'PRINTED' }] : []];
      if (sql.includes('FROM shipments')) return [[]];
      if (sql.includes('FROM label_assets') && sql.includes('WHERE id =')) return [[{ id: 'asset', content_sha256: parseTygLabelPush(labelBody).pdf.sha256, asset_status: 'READY', expires_at: new Date(Date.now() + (expired ? -1000 : 86400000)), bytes_deleted_at: null }]];
      if (sql.includes('FROM label_assets')) return [existing ? [{ id: 'asset' }] : []];
      if (sql.includes('FROM print_attempts')) return [[{ printed: 1 }]];
      if (sql.includes('MAX(version_no)')) return [[{ version_no: existing ? 3 : null }]];
      if (sql.startsWith('INSERT INTO inbound_messages') && failure === 'message') throw new Error('message failed');
      return [{ affectedRows: 1 }];
    },
  };
  const api = createTygV11Integration({ mysql: { execute: async () => [[]], getConnection: async () => { steps.push('connection'); return connection; } } as never, redis: { set: async () => 'OK', eval: async () => 1 } as never, storage: { put: async (key: string) => { steps.push('storage'); keys.push(key); if (failure === 'storage') throw new Error('storage failed'); } } as never });
  return { calls, steps, keys, push: () => api.pushLabel({ client, requestId: 'request', idempotencyKey: 'tyg-label-test', body: labelBody }) };
}
describe('TYG v1.1 atomic publication', () => {
  it('stages before the only transaction, retaining hashes without Base64', async () => {
    const parsed = parseTygLabelPush(labelBody);
    assert.equal(parsed.body.labelBase64, undefined);
    assert.equal(parsed.body.labelSha256, parsed.pdf.sha256);
    assert.equal(labelBody.labelBase64, pdf);
    const f = atomicFixture(); const result = await f.push();
    assert.deepEqual(f.steps, ['storage', 'connection', 'begin', 'commit']);
    assert.equal((result.body.data as Record<string, unknown>).operation, 'CREATED');
    assert.equal((result.body.data as Record<string, unknown>).latePush, true);
    assert.ok(!JSON.stringify(f.calls).includes(pdf));
    assert.ok(f.calls.some(c => c.sql.includes('retention_expires_at = expires_at')));
  });
  it('staging failure never opens a database transaction', async () => {
    const f = atomicFixture(false, false, 'storage');
    await assert.rejects(f.push(), { code: 'LABEL_STORAGE_UNAVAILABLE' });
    assert.deepEqual(f.steps, ['storage']); assert.equal(f.calls.length, 0);
  });
  it('same-content new requests renew immutable storage without incrementing duplicate versions', async () => {
    const f = atomicFixture(true); const result = await f.push(); await f.push();
    assert.notEqual(f.keys[0], f.keys[1]);
    assert.equal((result.body.data as Record<string, unknown>).operation, 'DUPLICATE');
    assert.equal((result.body.data as Record<string, unknown>).labelVersion, 3);
    assert.ok(!f.calls.some(c => c.sql.includes('INSERT INTO tyg_label_versions')));
    assert.ok(f.calls.some(c => c.sql.includes('UPDATE label_assets SET storage_key')));
  });
  it('expired content restores with a new version', async () => {
    const f = atomicFixture(true, true); const result = await f.push();
    assert.equal((result.body.data as Record<string, unknown>).operation, 'FILE_RESTORED');
    assert.equal((result.body.data as Record<string, unknown>).labelVersion, 4);
    assert.equal((result.body.data as Record<string, unknown>).reprintRequired, true);
  });
  it('response persistence failure rolls back publication and version together', async () => {
    const f = atomicFixture(false, false, 'message'); await assert.rejects(f.push(), /message failed/);
    assert.deepEqual(f.steps, ['storage', 'connection', 'begin', 'rollback']);
  });
});
