import * as XLSX from 'xlsx';

type MappingRow = Record<string, unknown>;

interface MappingColumnPair {
  firstLegHeader: string;
  exchangeHeader: string;
}

const MAPPING_COLUMN_PAIRS: MappingColumnPair[] = [
  { firstLegHeader: '头程单号', exchangeHeader: '快递单号' },
  { firstLegHeader: '运单号', exchangeHeader: '参考单号' }
];

const normalizeHeader = (value: string) => value
  .replace(/^\uFEFF/, '')
  .replace(/[\s\u3000]/g, '')
  .trim()
  .toLocaleLowerCase();

const findHeader = (headers: string[], expectedHeader: string) => {
  const normalizedExpected = normalizeHeader(expectedHeader);
  return headers.find(header => normalizeHeader(header) === normalizedExpected);
};

const findMappingColumns = (rows: MappingRow[]) => {
  const headers = [...new Set(rows.flatMap(row => Object.keys(row)))];

  for (const pair of MAPPING_COLUMN_PAIRS) {
    const firstLegColumn = findHeader(headers, pair.firstLegHeader);
    const exchangeColumn = findHeader(headers, pair.exchangeHeader);
    if (firstLegColumn && exchangeColumn) return { firstLegColumn, exchangeColumn };
  }

  return null;
};

const asTrackingNumber = (value: unknown) => String(value ?? '').trim();

/**
 * Both supported spreadsheet templates resolve to the same internal mapping:
 * first-leg waybill -> final-mile courier waybill.
 */
export function parseMappingWorkbook(buffer: ArrayBuffer) {
  const workbook = XLSX.read(new Uint8Array(buffer), { type: 'array' });
  const mapping: Record<string, string> = {};

  for (const sheetName of workbook.SheetNames) {
    const worksheet = workbook.Sheets[sheetName];
    if (!worksheet) continue;

    const rows = XLSX.utils.sheet_to_json<MappingRow>(worksheet, { defval: '' });
    const columns = findMappingColumns(rows);
    if (!columns) continue;

    for (const row of rows) {
      const firstLeg = asTrackingNumber(row[columns.firstLegColumn]);
      const exchange = asTrackingNumber(row[columns.exchangeColumn]);
      if (firstLeg && exchange) mapping[firstLeg] = exchange;
    }
  }

  return mapping;
}
