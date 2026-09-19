import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import type { Pool } from 'mysql2/promise';
import type { LabelStorage } from '../src/labelStorage.js';
import { ApiError } from '../src/errors.js';
import {
  evidenceStatusForCounts,
  createAirPickupOperations,
  normalizeAirBillNo,
  receivingValuesDiffer,
  validateAirEvidenceImage,
  validatePickupDocument,
} from '../src/airPickupOperations.js';

test('pickup list executes its paginated query and counts filtered orders before pagination', async () => {
  // Execute the portable SELECT against a real SQL engine so invalid SQL is not hidden by canned rows.
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(`CREATE TABLE air_pickup_orders (
      id TEXT, receipt_batch_id TEXT, handover_batch_id TEXT, bill_no_normalized TEXT,
      cargo_name TEXT, customer_name_snapshot TEXT, client_name_snapshot TEXT, customer_profile_id TEXT,
      order_status TEXT, evidence_status TEXT, created_at TEXT, updated_at TEXT);
      CREATE TABLE air_receipt_batches (id TEXT, batch_no TEXT);
      CREATE TABLE air_handover_batches (id TEXT, batch_no TEXT);
      CREATE TABLE shipments (id TEXT, air_pickup_order_id TEXT);
      CREATE TABLE print_attempts (id TEXT, shipment_id TEXT, outcome TEXT, occurred_at TEXT, created_at TEXT);
      INSERT INTO air_pickup_orders (id,bill_no_normalized,order_status,evidence_status,created_at,updated_at) VALUES
      ('one','E2E001','RECORDED','NONE','2026-09-19','2026-09-19'),
      ('two','E2E002','RECORDED','NONE','2026-09-19','2026-09-18'),
      ('three','OTHER003','VOIDED','NONE','2026-09-19','2026-09-17');`);
    const query = async (sql: string, values: SQLInputValue[] = []) => [db.prepare(sql).all(...values).map(row => ({
      ...row, ...(row.created_at ? { created_at: new Date(String(row.created_at)), updated_at: new Date(String(row.updated_at)) } : {}),
    }))];
    const service = createAirPickupOperations({ mysql: { query, execute: query } as unknown as Pool, storage: {} as LabelStorage });
    const first = await service.listOrders({ search: 'E2E', page: 1, pageSize: 1 });
    assert.deepEqual(first.orders.map(order => order.id), ['one']);
    assert.equal(first.total, 2);
    const second = await service.listOrders({ search: 'E2E', page: 2, pageSize: 1 });
    assert.deepEqual(second.orders.map(order => order.id), ['two']);
    assert.equal(second.total, 2);
    assert.deepEqual(second.summary, { recorded: 2, received: 0, handedOver: 0, voided: 1, evidencePending: 0 });
  } finally { db.close(); }
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

test('validates pickup-document extension, real file signature, and declared digest', () => {
  const pdf = Buffer.from('%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF');
  const result = validatePickupDocument(pdf, 'pickup-order.pdf', 'application/pdf');
  assert.equal(result.contentType, 'application/pdf');
  assert.throws(() => validatePickupDocument(Buffer.from('not a document'), 'pickup-order.pdf'), (error: unknown) => (
    error instanceof ApiError && error.code === 'PICKUP_DOCUMENT_SIGNATURE_INVALID'
  ));
  assert.throws(() => validatePickupDocument(pdf, 'pickup-order.exe'), (error: unknown) => (
    error instanceof ApiError && error.code === 'UNSUPPORTED_PICKUP_DOCUMENT'
  ));
  assert.throws(() => validatePickupDocument(pdf, 'pickup-order.pdf', 'application/pdf', '0'.repeat(64)), (error: unknown) => (
    error instanceof ApiError && error.code === 'PICKUP_DOCUMENT_SHA256_MISMATCH'
  ));
});

test('recognizes the internal Office package path for docx and xlsx pickup documents', () => {
  const docx = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from('word/document.xml')]);
  const xlsx = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from('xl/workbook.xml')]);
  assert.equal(validatePickupDocument(docx, 'pickup.docx').contentType, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  assert.equal(validatePickupDocument(xlsx, 'pickup.xlsx').contentType, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  assert.throws(() => validatePickupDocument(docx, 'pickup.xlsx'), (error: unknown) => (
    error instanceof ApiError && error.code === 'PICKUP_DOCUMENT_SIGNATURE_INVALID'
  ));
});
