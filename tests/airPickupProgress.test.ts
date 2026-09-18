import assert from 'node:assert/strict';
import test from 'node:test';
import * as selection from '../src/features/airPickup/receiptSelection.ts';

test('incomplete exchange progress never rounds up to complete', () => {
  assert.equal(typeof selection.exchangeProgressPercent, 'function');
  assert.equal(selection.exchangeProgressPercent(49900, 50000), 99.8);
  assert.equal(selection.exchangeProgressPercent(49999, 50000), 99.9);
  assert.equal(selection.exchangeProgressPercent(50000, 50000), 100);
  assert.equal(selection.exchangeProgressPercent(7, 10), 70);
  assert.equal(selection.exchangeProgressPercent(0, 0), 0);
});
