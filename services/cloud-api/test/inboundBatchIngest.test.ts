import assert from 'node:assert/strict';
import test from 'node:test';
import type { Redis } from 'ioredis';
import type { Pool } from 'mysql2/promise';
import { ApiError } from '../src/errors.js';
import { createInboundBatchIngestor, inboundBatchLimits, parseInboundBatchInput } from '../src/inboundBatchIngest.js';

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

function splitSqlList(value: string): string[] {
  const entries: string[] = [];
  let start = 0;
  let depth = 0;
  let quoted = false;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character === "'" && value[index - 1] !== '\\') quoted = !quoted;
    if (quoted) continue;
    if (character === '(') depth += 1;
    if (character === ')') depth -= 1;
    if (character === ',' && depth === 0) {
      entries.push(value.slice(start, index).trim());
      start = index + 1;
    }
  }
  entries.push(value.slice(start).trim());
  return entries;
}

function countSqlPlaceholders(sql: string): number {
  let count = 0;
  let quoted = false;
  for (let index = 0; index < sql.length; index += 1) {
    const character = sql[index];
    if (character === "'" && sql[index - 1] !== '\\') quoted = !quoted;
    else if (character === '?' && !quoted) count += 1;
  }
  return count;
}

function validateExecutedSqlArity(sql: string, params: unknown[]): void {
  const insert = /^\s*INSERT\s+INTO\s+\w+\s*\(([\s\S]*?)\)\s*VALUES\s*\(([\s\S]*?)\)\s*$/i.exec(sql);
  const placeholderCount = countSqlPlaceholders(sql);
  const bindingMismatch = placeholderCount !== params.length;
  if (!insert) {
    if (bindingMismatch) throw new Error(`SQL arity mismatch: ${placeholderCount} placeholders, ${params.length} parameters`);
    return;
  }
  const columnCount = splitSqlList(insert[1]).length;
  const valueCount = splitSqlList(insert[2]).length;
  if (columnCount !== valueCount || bindingMismatch) {
    throw new Error(
      `SQL arity mismatch: ${columnCount} columns, ${valueCount} values; ${placeholderCount} placeholders, ${params.length} parameters`,
    );
  }
}

function batchIngestFixture(failOnEvent = false) {
  const transaction: string[] = [];
  let lockReleased = false;
  const connection = {
    beginTransaction: async () => { transaction.push('begin'); },
    execute: async (sql: string, params: unknown[] = []) => {
      validateExecutedSqlArity(sql, params);
      if (sql.includes('FROM clients c INNER JOIN customer_profiles')) {
        return [[{
          display_name: 'Test Client',
          customer_profile_id: 'profile-1',
          customer_name: 'Test Customer',
          customer_type: 'UPSTREAM',
        }]];
      }
      if (sql.includes('FROM air_pickup_orders')) return [[]];
      if (failOnEvent && sql.includes('INSERT INTO air_pickup_events')) throw new Error('event write failed');
      return [{ affectedRows: 1 }];
    },
    commit: async () => { transaction.push('commit'); },
    rollback: async () => { transaction.push('rollback'); },
    release: () => { transaction.push('release'); },
  };
  const mysql = {
    execute: async () => [[]],
    getConnection: async () => connection,
  } as unknown as Pool;
  const redis = {
    set: async () => 'OK',
    eval: async () => { lockReleased = true; return 1; },
  } as unknown as Redis;
  const body = baseRequest(1);
  body.shipments = [];
  const ingest = () => createInboundBatchIngestor({ mysql, redis }).ingest({
    client: {
      id: 'client-1',
      apiKeyId: 'api-key-1',
      scopes: ['shipments:write'],
      rateLimitPerMinute: 60,
    },
    requestId: 'request-1',
    idempotencyKey: 'batch-test-0001',
    ip: '127.0.0.1',
    body,
  });
  return { ingest, transaction, lockReleased: () => lockReleased };
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

test('ingests a minimal forecast-only batch with valid SQL arity', async () => {
  const fixture = batchIngestFixture();

  const result = await fixture.ingest();

  assert.equal(result.status, 200);
  assert.ok('data' in result.body);
  assert.equal(result.body.data.shipmentCount, 0);
  assert.deepEqual(fixture.transaction, ['begin', 'commit', 'release']);
  assert.equal(fixture.lockReleased(), true);
});

test('rolls back a forecast-only batch when an event write fails', async () => {
  const fixture = batchIngestFixture(true);

  await assert.rejects(fixture.ingest(), /event write failed/);

  assert.deepEqual(fixture.transaction, ['begin', 'rollback', 'release']);
  assert.equal(fixture.lockReleased(), true);
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
