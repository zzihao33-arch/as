import assert from 'node:assert/strict';
import test from 'node:test';
import { ApiError } from '../src/errors.js';
import {
  createAirPickupOperations,
  evidenceStatusForCounts,
  normalizeAirBillNo,
  receivingValuesDiffer,
  validateAirEvidenceImage,
} from '../src/airPickupOperations.js';
import type { Pool } from 'mysql2/promise';
import type { LabelStorage } from '../src/labelStorage.js';

test('list query intersects exact client with search and preserves count on an empty page', async () => {
  const queries: { sql: string; values: unknown[] }[] = [];
  const mysql = {
    query: async (sql: string, values: unknown[] = []) => {
      queries.push({ sql, values });
      return [sql.includes('SELECT COUNT(*)') ? [{ total_count: 21 }] : []];
    },
    execute: async () => [[{}]],
  } as unknown as Pool;
  const ops = createAirPickupOperations({ mysql, storage: {} as LabelStorage });
  const clientId = '00000000-0000-4000-8000-000000000001';
  const result = await ops.listOrders({ clientId, search: '180-123', status: 'RECORDED', page: 3, pageSize: 20 });
  assert.equal(result.total, 21);
  for (const query of queries) {
    assert.match(query.sql, /o\.client_id = \?/);
    assert.ok(query.values.includes(clientId));
    assert.ok(query.values.includes('%180123%'));
    assert.ok(query.values.includes('RECORDED'));
  }
  assert.ok(queries.some(query => query.sql.includes('SELECT COUNT(*)')));
});

test('list query rejects malformed client ids before contacting the database', async () => {
  let contacted = false;
  const mysql = { query: async () => { contacted = true; return [[]]; }, execute: async () => [[]] } as unknown as Pool;
  const ops = createAirPickupOperations({ mysql, storage: {} as LabelStorage });
  await assert.rejects(ops.listOrders({ clientId: 'invalid-client' }), ApiError);
  assert.equal(contacted, false);
});

test('normalizes equivalent air bill numbers to one global key', () => {
  const values = ['abc-123', 'ABC-123', 'ABC123', ' abc 123 ', 'ＡBC123'.replace('Ａ', 'A')];
  assert.deepEqual(values.map(value => normalizeAirBillNo(value).normalized), Array(values.length).fill('ABC123'));
});

test('formats a standard eleven digit air waybill', () => {
  assert.deepEqual(normalizeAirBillNo('18098109734'), {
    raw: '18098109734',
    display: '180-98109734',
    normalized: '18098109734',
    isStandard: true,
  });
});

test('accepts an abnormal alphanumeric bill with a warning flag and rejects special characters', () => {
  assert.equal(normalizeAirBillNo('AB-12-Z').isStandard, false);
  assert.throws(() => normalizeAirBillNo('180/98109734'), (error: unknown) => (
    error instanceof ApiError && error.code === 'INVALID_AIR_BILL_NO'
  ));
});

test('requires a difference reason when any actual receiving value differs', () => {
  const unchanged = receivingValuesDiffer({
    forecastCartons: 10, forecastPackages: 20, forecastWeight: 100, forecastWeightUnit: 'KG',
    actualCartons: 10, actualPackages: 20, actualWeight: 100, actualWeightUnit: 'KG',
  });
  const changed = receivingValuesDiffer({
    forecastCartons: 10, forecastPackages: 20, forecastWeight: 100, forecastWeightUnit: 'KG',
    actualCartons: 10, actualPackages: 21, actualWeight: 100, actualWeightUnit: 'KG',
  });
  assert.equal(unchanged, false);
  assert.equal(changed, true);
});

test('evidence completion requires at least one POD and three loading photos', () => {
  assert.equal(evidenceStatusForCounts(0, 0), 'NONE');
  assert.equal(evidenceStatusForCounts(1, 2), 'PARTIAL');
  assert.equal(evidenceStatusForCounts(0, 3), 'PARTIAL');
  assert.equal(evidenceStatusForCounts(1, 3), 'COMPLETE');
});

test('validates image bytes rather than trusting the file extension or header', () => {
  const png = Buffer.alloc(24);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(png);
  png.writeUInt32BE(800, 16);
  png.writeUInt32BE(600, 20);
  const result = validateAirEvidenceImage(png, 'image/png');
  assert.equal(result.width, 800);
  assert.equal(result.height, 600);
  assert.equal(result.contentType, 'image/png');
  assert.throws(() => validateAirEvidenceImage(png, 'image/jpeg'), (error: unknown) => (
    error instanceof ApiError && error.code === 'EVIDENCE_CONTENT_TYPE_MISMATCH'
  ));
});
