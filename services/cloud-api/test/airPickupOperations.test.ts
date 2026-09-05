import assert from 'node:assert/strict';
import test from 'node:test';
import { ApiError } from '../src/errors.js';
import {
  evidenceStatusForCounts,
  normalizeAirBillNo,
  receivingValuesDiffer,
  validateAirEvidenceImage,
  validatePickupDocument,
} from '../src/airPickupOperations.js';

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
