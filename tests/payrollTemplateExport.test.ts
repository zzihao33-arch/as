import assert from 'node:assert/strict';
import test from 'node:test';
import * as XLSX from 'xlsx';
import { createPayrollTemplateWorkbook } from '../src/features/payroll/payrollTemplateExport.ts';

test('exports daily punches, rest deduction, payable hours and wages with blank non-working dates', () => {
  const bytes = createPayrollTemplateWorkbook({ periodLabel: '2026-09-21 至 2026-09-22', dateFrom: '2026-09-21', dateTo: '2026-09-22',
    weeks: [{ week: '2026-09-21' }], rows: [{ id: 'user:1', name: 'Max', baseRate: 20, bonus: 0, fuelDays: 0,
      attendanceDays: 1, weeklyHours: [{ week: '2026-09-21', hours: 5 }], regularHours: 5, overtimeHours: 0,
      regularPay: 100, overtimePay: 0, fuelAllowance: 0, totalPay: 100, issues: [],
      dailyDetails: [{ workDate: '2026-09-21', clockInAt: '2026-09-21T16:30:00Z', clockOutAt: '2026-09-21T22:00:00Z',
        grossMinutes: 330, breakRule: { id: null, startTime: '12:00', endTime: '13:00' }, breakMinutes: 30,
        netMinutes: 300, regularMinutes: 300, overtimeMinutes: 0, regularPay: 100, overtimePay: 0, status: 'COMPLETE' }],
    }] });
  const workbook = XLSX.read(bytes, { type: 'array' });
  assert.deepEqual(workbook.SheetNames, ['考勤及工时汇总', '每日上班明细']);
  const sheet = workbook.Sheets['每日上班明细'];
  const values = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1 });
  assert.deepEqual(values[3].slice(0, 10), ['Max', 'user:1', '2026-09-21', '周一', '12:30', '18:00', 5.5, '12:00–13:00', 30, 5]);
  assert.equal(values[3][15], 100);
  assert.equal(values[4][2], '2026-09-22');
  assert.equal(values[4][4], '');
  assert.equal(values[4][16], '无记录');
});
