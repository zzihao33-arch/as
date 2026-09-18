import assert from 'node:assert/strict';
import test from 'node:test';
import { mergeSelectedRecords, selectExistingRecordsById } from '../src/features/airPickup/receiptSelection.ts';

test('receipt editor ignores orders removed by the active list filter', () => {
  const visibleOrders = [{ id: 'still-visible', billNo: '180-00000001' }];

  assert.deepEqual(
    selectExistingRecordsById(visibleOrders, ['already-received', 'still-visible']),
    [visibleOrders[0]],
  );
});

test('selected records survive paging and update from revisited pages', () => {
  const first = { id: 'page-1', version: 1 };
  const second = { id: 'page-2', version: 1 };
  let saved = mergeSelectedRecords([first], [second], ['page-1', 'page-2']);
  assert.deepEqual(saved, [first, second]);
  saved = mergeSelectedRecords(saved, [{ ...first, version: 2 }], ['page-1', 'page-2']);
  assert.deepEqual(saved, [{ ...first, version: 2 }, second]);
  assert.deepEqual(mergeSelectedRecords(saved, [], ['page-2']), [second]);
});
