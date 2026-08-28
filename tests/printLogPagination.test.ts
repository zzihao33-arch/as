import assert from 'node:assert/strict';
import test from 'node:test';
import { paginatePrintLogs } from '../src/features/printing/printLogPagination.ts';
import type { PrintLog, PrintLogType } from '../src/features/printing/printingTypes.ts';

const createLog = (id: string, type: PrintLogType): PrintLog => ({
  id,
  createdAt: Number(id),
  time: `time-${id}`,
  firstLeg: `first-${id}`,
  exchange: `exchange-${id}`,
  status: 'success',
  message: `message-${id}`,
  type
});

test('filters and paginates print logs without changing their order', () => {
  const logs = [
    createLog('5', 'print'),
    createLog('4', 'system'),
    createLog('3', 'print'),
    createLog('2', 'print'),
    createLog('1', 'import')
  ];

  const result = paginatePrintLogs(logs, 'print', 1, 2);

  assert.equal(result.total, 3);
  assert.deepEqual(result.logs.map(log => [log.id, log.rowNumber]), [['5', 3], ['3', 2]]);
  assert.deepEqual(logs.map(log => log.id), ['5', '4', '3', '2', '1']);
});

test('clamps an out-of-range page and keeps row numbers stable', () => {
  const logs = [createLog('3', 'print'), createLog('2', 'print'), createLog('1', 'print')];

  const result = paginatePrintLogs(logs, 'print', 99, 2);

  assert.equal(result.total, 3);
  assert.deepEqual(result.logs.map(log => [log.id, log.rowNumber]), [['1', 1]]);
});
