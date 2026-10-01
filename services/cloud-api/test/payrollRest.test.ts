import assert from 'node:assert/strict';
import test from 'node:test';
import { calculatePayrollRow } from '../src/attendanceCalculations.js';
import { resolvePayrollBreakRule } from '../src/payrollBreakRules.js';
import { createAttendanceOperations } from '../src/attendanceOperations.js';
import type { Pool } from 'mysql2/promise';
import type { LabelStorage } from '../src/labelStorage.js';
import type { WarehouseSession } from '../src/warehouseIdentity.js';

function operationsFixture(status = 'COMPLETE') {
  const writes: Array<{ sql: string; params: unknown[] }> = [];
  let committed = false;
  const execute = async (sql: string, params: unknown[] = []) => {
    if (sql.includes('INSERT')) { writes.push({ sql, params }); return [{ affectedRows: 1 }]; }
    if (sql.includes('attendance_payroll_break_rules')) return [[{ id: 'personal', employee_reference: 'user:1', start_time: '12:30:00', end_time: '13:00:00', effective_from: '2026-09-01' }]];
    if (sql.includes('SELECT * FROM attendance_daily_results')) return [[{ user_id: '1', employee_reference: 'user:1', employee_name_snapshot: 'Max', employee_no_snapshot: '001', work_date: '2026-09-21', clock_in_at: new Date('2026-09-21T13:00:00Z'), clock_out_at: new Date('2026-09-21T22:00:00Z'), gross_minutes: 540, result_status: status }]];
    if (sql.includes('SELECT p.employee_reference')) return [[{ employee_reference: 'user:1', user_id: '1', hourly_rate: '20' }]];
    return [[]];
  };
  const mysql = { execute, getConnection: async () => ({ execute, beginTransaction: async () => {}, commit: async () => { committed = true; }, rollback: async () => {}, release: () => {} }) } as unknown as Pool;
  return { operations: createAttendanceOperations({ mysql, storage: {} as LabelStorage }), writes, committed: () => committed };
}
const session = { warehouseId: 'warehouse-1', userId: 'admin' } as WarehouseSession;

test('payroll service persists the resolved rest rule and daily punches in its immutable snapshot', async () => {
  const fixture = operationsFixture();
  const result = await fixture.operations.calculatePayroll(session, { dateFrom: '2026-09-21', dateTo: '2026-09-21' }, true);
  assert.equal(result.rows[0].regularMinutes, 510);
  assert.equal(result.rows[0].totalPay, 170);
  assert.equal(fixture.committed(), true);
  const insert = fixture.writes.find(write => write.sql.includes('attendance_payroll_run_rows'))!;
  const saved = JSON.parse(String(insert.params[15]));
  assert.equal(saved[0].breakRule.id, 'personal');
  assert.equal(saved[0].clockInAt, '2026-09-21T13:00:00.000Z');
  assert.equal(saved[0].breakMinutes, 30);
});

test('payroll service refuses to persist abnormal attendance even when called directly', async () => {
  const fixture = operationsFixture('OPEN');
  await assert.rejects(fixture.operations.calculatePayroll(session, { dateFrom: '2026-09-21', dateTo: '2026-09-21' }, true), /考勤状态为 OPEN/);
  assert.equal(fixture.writes.length, 0);
});

test('rest rule writes reject invalid times, impossible dates and employees outside the warehouse', async () => {
  const fixture = operationsFixture();
  const input = { employeeReference: null, startTime: '12:00', endTime: '13:00', effectiveFrom: '2026-09-21' };
  await assert.rejects(fixture.operations.savePayrollBreakRule(session, { ...input, endTime: '11:00' }), /结束时间/);
  await assert.rejects(fixture.operations.savePayrollBreakRule(session, { ...input, effectiveFrom: '2026-02-30' }), /生效日期无效/);
  await assert.rejects(fixture.operations.savePayrollBreakRule(session, { ...input, employeeReference: 'foreign' }), /当前仓库/);
  assert.equal(fixture.writes.length, 0);
});

test('selects rules by employee priority and effective date without affecting earlier days', () => {
  const rules = [
    { id: 'default', employeeReference: null, startTime: '12:00', endTime: '13:00', effectiveFrom: '2026-09-01' },
    { id: 'personal', employeeReference: 'user:1', startTime: '12:30', endTime: '13:00', effectiveFrom: '2026-09-15' },
    { id: 'new-default', employeeReference: null, startTime: '11:30', endTime: '12:30', effectiveFrom: '2026-09-20' },
  ];
  assert.equal(resolvePayrollBreakRule(rules, 'user:1', '2026-09-14').id, 'default');
  assert.equal(resolvePayrollBreakRule(rules, 'user:1', '2026-09-21').id, 'personal');
  assert.equal(resolvePayrollBreakRule(rules, 'user:2', '2026-09-21').id, 'new-default');
  assert.equal(resolvePayrollBreakRule(rules, 'user:1', '2026-08-30').id, null);
});

test('uses New York clock time in winter, summer, and across midnight', () => {
  const winter = calculatePayrollRow({ ...base, days: [{ workDate: '2026-01-05', grossMinutes: 330, status: 'COMPLETE',
    clockInAt: '2026-01-05T17:30:00Z', clockOutAt: '2026-01-05T23:00:00Z' }] });
  assert.equal(winter.days[0].breakMinutes, 30);
  const overnight = calculatePayrollRow({ ...base, days: [{ workDate: '2026-09-21', grossMinutes: 480, status: 'COMPLETE',
    clockInAt: '2026-09-21T22:00:00-04:00', clockOutAt: '2026-09-22T06:00:00-04:00',
    breakRule: { id: 'night', startTime: '00:00', endTime: '00:30' } }] });
  assert.equal(overnight.days[0].breakMinutes, 30);
  assert.equal(overnight.regularMinutes, 450);
});

const base = { employeeReference: 'user:1', employeeName: 'Max', employeeNo: '001', hourlyRate: 20, bonus: 0, fuelDays: 0 };
const day = (start: string, end: string, workDate = '2026-09-21') => ({
  workDate, clockInAt: `${workDate}T${start}:00-04:00`, clockOutAt: `${workDate}T${end}:00-04:00`,
  grossMinutes: (Number(end.slice(0, 2)) - Number(start.slice(0, 2))) * 60 + Number(end.slice(3)) - Number(start.slice(3)),
  status: 'COMPLETE',
});

test('deducts only the overlap with the default noon break', () => {
  for (const [start, end, rest, net] of [['09:00', '18:00', 60, 480], ['12:30', '18:00', 30, 300], ['13:00', '18:00', 0, 300], ['09:00', '12:15', 15, 180], ['12:10', '12:40', 30, 0]] as const) {
    const row = calculatePayrollRow({ ...base, days: [day(start, end)] });
    assert.equal(row.regularMinutes, net);
    assert.equal(row.days[0].breakMinutes, rest);
    assert.equal(row.days[0].netMinutes, net);
  }
});

test('personal break replaces the default instead of adding a second deduction', () => {
  const row = calculatePayrollRow({ ...base, days: [{ ...day('09:00', '18:00'), breakRule: { id: 'personal', startTime: '12:30', endTime: '13:00' } }] });
  assert.equal(row.regularMinutes, 510);
  assert.equal(row.days[0].breakMinutes, 30);
});

test('allocates weekly overtime after breaks and daily money reconciles to totals', () => {
  const days = Array.from({ length: 6 }, (_, i) => day('09:05', '18:30', `2026-09-${21 + i}`)).reverse();
  const row = calculatePayrollRow({ ...base, hourlyRate: 17, bonus: 50, fuelDays: 2, days });
  assert.equal(row.regularMinutes, 2400);
  assert.equal(row.overtimeMinutes, 630);
  assert.equal(row.days[0].workDate, '2026-09-21');
  assert.equal(row.days.reduce((sum, d) => sum + d.regularMinutes, 0), row.regularMinutes);
  assert.equal(row.days.reduce((sum, d) => sum + d.overtimeMinutes, 0), row.overtimeMinutes);
  assert.equal(Math.round(row.days.reduce((sum, d) => sum + (d.regularPay ?? 0) + (d.overtimePay ?? 0), 0) * 100), Math.round(((row.regularPay ?? 0) + (row.overtimePay ?? 0)) * 100));
});

test('missing or invalid punches block payroll instead of silently skipping rest', () => {
  const row = calculatePayrollRow({ ...base, days: [{ workDate: '2026-09-21', grossMinutes: 540, status: 'COMPLETE' }] });
  assert.ok(row.issues.length > 0);
  assert.equal(row.regularMinutes, 0);
});

test('the rounded eighteen-hour shift boundary still deducts rest', () => {
  const row = calculatePayrollRow({ ...base, days: [{ ...day('00:00', '18:00'), clockOutAt: '2026-09-21T18:00:20-04:00' }] });
  assert.equal(row.days[0].breakMinutes, 60);
  assert.equal(row.days[0].netMinutes, 1020);
});
