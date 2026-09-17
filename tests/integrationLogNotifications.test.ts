import assert from 'node:assert/strict';
import { test } from 'node:test';
import { advanceNotification, initialNotification, normalizeCursor } from '../src/features/integrationLogs/notificationState.ts';

test('first snapshot establishes baseline silently even with historical unread rows', () => {
  const next = advanceNotification(initialNotification(), { cursor: '22', readCursor: '2', unreadCount: 20 }, 1000);
  assert.equal(next.notify, false);
  assert.equal(next.state.unreadCount, 20);
});
test('only a newer cursor notifies and bursts coalesce for fifteen seconds', () => {
  const baseline = advanceNotification(initialNotification(), { cursor: '20', readCursor: '20', unreadCount: 0 }, 1000).state;
  const first = advanceNotification(baseline, { cursor: '21', readCursor: '20', unreadCount: 1 }, 2000);
  assert.equal(first.notify, true);
  const burst = advanceNotification(first.state, { cursor: '32', readCursor: '20', unreadCount: 12 }, 4000);
  assert.equal(burst.notify, false);
  assert.equal(burst.state.unreadCount, 12);
  const later = advanceNotification(burst.state, { cursor: '33', readCursor: '20', unreadCount: 13 }, 18000);
  assert.equal(later.notify, true);
});
test('out of order snapshot cannot restore old unread after another device acknowledges', () => {
  let state = advanceNotification(initialNotification(), { cursor: '20', readCursor: '0', unreadCount: 20 }, 1).state;
  state = advanceNotification(state, { cursor: '20', readCursor: '20', unreadCount: 0 }, 2).state;
  assert.deepEqual(advanceNotification(state, { cursor: '19', readCursor: '0', unreadCount: 19 }, 3).state, state);
  assert.deepEqual(advanceNotification(state, { cursor: '20', readCursor: '0', unreadCount: 20 }, 4).state, state);
});
test('new account uses fresh baseline and decimal cursors retain integer precision', () => {
  const s = advanceNotification(initialNotification(), { cursor: '9007199254740995', readCursor: '9007199254740994', unreadCount: 1 }, 1);
  assert.equal(s.notify, false);
  assert.equal(advanceNotification(s.state, { cursor: '9007199254740996', readCursor: '9007199254740994', unreadCount: 2 }, 2).notify, true);
  assert.equal(normalizeCursor('9007199254740996'), '9007199254740996');
  assert.throws(() => normalizeCursor('-1'));
  assert.throws(() => normalizeCursor('1e3'));
});
