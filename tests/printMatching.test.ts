import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createMappingIndex,
  createPdfSearchIndex,
  findPdfMatch,
  normalizeBarcode
} from '../src/features/printing/printMatching.ts';

const pdfFiles = (...keys: string[]) => Object.fromEntries(keys.map(key => [key, null]));

test('matches a PDF key exactly after barcode normalization', () => {
  const index = createPdfSearchIndex(pdfFiles('ABC-123'));

  assert.deepEqual(findPdfMatch(index, [' \u0000aBc-123\r\n']), {
    key: 'ABC-123',
    ambiguous: false
  });
});

test('matches the mapped exchange number when the scanned first-leg number has no PDF', () => {
  const mappingIndex = createMappingIndex({ 'FIRST-001': 'EXCHANGE-900' });
  const scannedValue = ' first-001 ';
  const exchangeNumber = mappingIndex.get(normalizeBarcode(scannedValue));
  const index = createPdfSearchIndex(pdfFiles('EXCHANGE-900'));

  assert.deepEqual(findPdfMatch(index, [scannedValue, exchangeNumber]), {
    key: 'EXCHANGE-900',
    ambiguous: false
  });
});

test('blocks ambiguous prefix and contains matches', () => {
  const cases = [
    createPdfSearchIndex(pdfFiles('ABC-001-label', 'ABC-001-copy')),
    createPdfSearchIndex(pdfFiles('label-ABC-001', 'copy-ABC-001'))
  ];

  for (const index of cases) {
    assert.deepEqual(findPdfMatch(index, ['ABC-001']), { ambiguous: true });
  }
});

test('blocks different filenames that normalize to the same exact barcode', () => {
  const index = createPdfSearchIndex(pdfFiles('ABC-001', 'abc-001'));

  assert.deepEqual(findPdfMatch(index, ['ABC-001']), { ambiguous: true });
});

test('returns no match when no PDF key contains a candidate', () => {
  const index = createPdfSearchIndex(pdfFiles('EXCHANGE-900'));

  assert.deepEqual(findPdfMatch(index, ['FIRST-404', null]), { ambiguous: false });
});
