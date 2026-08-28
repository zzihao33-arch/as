import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Redis } from 'ioredis';
import type { Pool } from 'mysql2/promise';
import { ApiError } from '../src/errors.js';
import { createShipmentIngestor, hashInboundPayload } from '../src/shipmentIngest.js';

const request = {
  client: {
    id: 'client-1',
    apiKeyId: 'api-key-1',
    scopes: ['shipments:write'] as const,
    rateLimitPerMinute: 60,
  },
  requestId: 'request-1001',
  idempotencyKey: 'shipment-1001',
  body: { firstLegTrackingNo: 'FL-1001', extra: { lane: 'A' } },
};

function existingPool(payloadSha256: string) {
  return {
    execute: async () => [[{
      payload_sha256: payloadSha256,
      processing_status: 'COMPLETED',
      response_status: 200,
      response_body: JSON.stringify({ data: { id: 'shipment-1' }, requestId: 'request-original' }),
    }]],
  } as unknown as Pool;
}

const unreachableRedis = {
  set: async () => { throw new Error('Redis should not be used for a durable replay.'); },
} as unknown as Redis;

describe('shipment ingestion', () => {
  it('is stable when object property order changes', () => {
    const first = {
      firstLegTrackingNo: 'FL-1001',
      address: { city: 'New York', postalCode: '10001' },
      items: [{ quantity: 2, sku: 'A-1' }],
    };
    const reordered = {
      items: [{ sku: 'A-1', quantity: 2 }],
      address: { postalCode: '10001', city: 'New York' },
      firstLegTrackingNo: 'FL-1001',
    };

    assert.equal(hashInboundPayload(first), hashInboundPayload(reordered));
  });

  it('changes when a business value changes', () => {
    assert.notEqual(
      hashInboundPayload({ firstLegTrackingNo: 'FL-1001', quantity: 1 }),
      hashInboundPayload({ firstLegTrackingNo: 'FL-1001', quantity: 2 }),
    );
  });

  it('replays a durable result without depending on Redis', async () => {
    const ingestor = createShipmentIngestor({
      mysql: existingPool(hashInboundPayload(request.body)),
      redis: unreachableRedis,
    });

    const result = await ingestor.ingest({
      ...request,
      client: { ...request.client, scopes: ['shipments:write'] },
    });

    assert.equal(result.status, 200);
    assert.equal(result.body.idempotentReplay, true);
    assert.deepEqual(result.body.data, { id: 'shipment-1' });
  });

  it('rejects reuse of an idempotency key for a different payload', async () => {
    const ingestor = createShipmentIngestor({
      mysql: existingPool(hashInboundPayload({ firstLegTrackingNo: 'OTHER' })),
      redis: unreachableRedis,
    });

    await assert.rejects(
      ingestor.ingest({ ...request, client: { ...request.client, scopes: ['shipments:write'] } }),
      (error: unknown) => {
        assert.ok(error instanceof ApiError);
        assert.equal(error.status, 409);
        assert.equal(error.code, 'IDEMPOTENCY_CONFLICT');
        return true;
      },
    );
  });

  it('commits the inbound message, shipment, audit, and response as one transaction', async () => {
    const statements: string[] = [];
    let began = false;
    let committed = false;
    let released = false;
    const connection = {
      beginTransaction: async () => { began = true; },
      execute: async (sql: string) => {
        statements.push(sql);
        if (sql.includes('SELECT * FROM shipments')) {
          return [[{
            id: 'shipment-1',
            client_id: 'client-1',
            order_id: null,
            first_leg_tracking_no: 'FL-1001',
            courier_tracking_no: null,
            carrier: null,
            label_url: null,
            label_sha256: null,
            recipient_name: null,
            recipient_phone: null,
            recipient_address: null,
            items: null,
            raw_data: request.body,
            status: 'RECEIVED',
            attributes: null,
            version: 1,
            created_at: new Date('2026-08-28T12:00:00.000Z'),
            updated_at: new Date('2026-08-28T12:00:00.000Z'),
          }]];
        }
        return [{ affectedRows: 1 }];
      },
      commit: async () => { committed = true; },
      rollback: async () => undefined,
      release: () => { released = true; },
    };
    const pool = {
      execute: async () => [[]],
      getConnection: async () => connection,
    } as unknown as Pool;
    const redis = {
      set: async () => 'OK',
      eval: async () => 1,
    } as unknown as Redis;

    const result = await createShipmentIngestor({ mysql: pool, redis }).ingest({
      ...request,
      client: { ...request.client, scopes: ['shipments:write'] },
    });

    assert.equal(began, true);
    assert.equal(committed, true);
    assert.equal(released, true);
    assert.equal(result.status, 200);
    assert.equal(statements.length, 6);
    assert.match(statements[0], /INSERT INTO inbound_messages/);
    assert.match(statements[1], /INSERT INTO shipments/);
    assert.match(statements[2], /SELECT \* FROM shipments/);
    assert.match(statements[3], /INSERT INTO shipment_events/);
    assert.match(statements[4], /INSERT INTO shipment_delivery_changes/);
    assert.match(statements[5], /UPDATE inbound_messages/);
  });
});
