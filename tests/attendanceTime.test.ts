import assert from 'node:assert/strict';
import test from 'node:test';
import {
  attendanceElapsedMinutes,
  attendanceWorkDate,
  formatAttendanceDecimalHours,
  isOpenAttendanceWithin,
} from '../src/features/attendance/attendanceTime.ts';

test('uses the New York business date instead of the UTC calendar date', () => {
  assert.equal(attendanceWorkDate('2026-09-02T00:04:28.000Z'), '2026-09-01');
  assert.equal(attendanceWorkDate('2026-09-02T14:00:00.000Z'), '2026-09-02');
});

test('counts an overnight shift continuously across midnight', () => {
  assert.equal(
    attendanceElapsedMinutes('2026-09-03T03:30:00.000Z', '2026-09-03T05:00:00.000Z'),
    90,
  );
});

test('shows a positive minute for a short completed shift', () => {
  assert.equal(
    attendanceElapsedMinutes('2026-09-02T00:04:28.000Z', '2026-09-02T00:04:37.000Z'),
    1,
  );
});

test('formats elapsed work time from whole minutes as decimal hours', () => {
  assert.equal(formatAttendanceDecimalHours(45), '0.75 h');
  assert.equal(formatAttendanceDecimalHours(1), '0.02 h');
  assert.equal(formatAttendanceDecimalHours(480), '8.00 h');
});

test('accepts only open shifts inside the eighteen-hour window', () => {
  const now = new Date('2026-09-03T18:00:00.000Z');
  assert.equal(isOpenAttendanceWithin('2026-09-03T01:00:00.000Z', now), true);
  assert.equal(isOpenAttendanceWithin('2026-09-02T23:59:59.000Z', now), false);
});
