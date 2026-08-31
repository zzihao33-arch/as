import assert from 'node:assert/strict';
import test from 'node:test';
import { selectExistingRecordsById } from '../src/features/airPickup/receiptSelection.ts';

test('receipt editor ignores orders removed by the active list filter', () => {
  const visibleOrders = [{ id: 'still-visible', billNo: '180-00000001' }];

  assert.deepEqual(
    selectExistingRecordsById(visibleOrders, ['already-received', 'still-visible']),
    [visibleOrders[0]],
  );
});
