import assert from 'node:assert/strict';
import test from 'node:test';
import {
  calculateDailyAttendance,
  calculatePayrollRow,
  haversineDistanceMeters,
} from '../src/attendanceCalculations.js';

test('calculates warehouse geofence distance in meters', () => {
  assert.equal(haversineDistanceMeters(40.6413, -73.7781, 40.6413, -73.7781), 0);
  const distance = haversineDistanceMeters(40.6413, -73.7781, 40.6422, -73.7781);
  assert.ok(distance > 90 && distance < 110);
});

test('deducts one lunch hour and identifies late arrival', () => {
  const result = calculateDailyAttendance({
    workDate: '2026-08-30',
    clockInAt: new Date('2026-08-30T13:15:00Z'),
    clockOutAt: new Date('2026-08-30T22:00:00Z'),
    scheduledStartMinutes: 9 * 60,
    scheduledEndMinutes: 18 * 60,
    lateGraceMinutes: 5,
    earlyGraceMinutes: 5,
  });
  assert.equal(result.grossMinutes, 525);
  assert.equal(result.netMinutes, 465);
  assert.equal(result.isLate, true);
  assert.equal(result.isEarlyLeave, false);
});

test('flags shifts longer than eighteen hours for review', () => {
  const result = calculateDailyAttendance({
    workDate: '2026-08-30',
    clockInAt: new Date('2026-08-30T10:00:00Z'),
    clockOutAt: new Date('2026-08-31T05:01:00Z'),
  });
  assert.equal(result.status, 'NEEDS_REVIEW');
  assert.equal(result.netMinutes, 0);
});

test('calculates weekly overtime, fuel allowance, and total pay with existing rules', () => {
  const row = calculatePayrollRow({
    employeeReference: 'user:1',
    employeeName: 'Max',
    employeeNo: '001',
    hourlyRate: 20,
    bonus: 50,
    fuelDays: 2,
    days: [
      { workDate: '2026-08-24', netMinutes: 2_400, status: 'COMPLETE' },
      { workDate: '2026-08-25', netMinutes: 600, status: 'COMPLETE' },
    ],
  });
  assert.equal(row.regularMinutes, 2_400);
  assert.equal(row.overtimeMinutes, 600);
  assert.equal(row.regularPay, 800);
  assert.equal(row.overtimePay, 300);
  assert.equal(row.fuelAllowance, 39);
  assert.equal(row.totalPay, 1_189);
});
