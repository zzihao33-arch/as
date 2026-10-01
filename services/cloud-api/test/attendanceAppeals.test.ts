import assert from 'node:assert/strict';
import test from 'node:test';
import type { Pool } from 'mysql2/promise';
import type { LabelStorage } from '../src/labelStorage.js';
import type { WarehouseSession } from '../src/warehouseIdentity.js';
import { createAttendanceOperations } from '../src/attendanceOperations.js';

const session = { warehouseId: 'warehouse-1', userId: 'employee-1' } as WarehouseSession;
const input = {
  workDate: '2026-09-01', type: 'DEVICE_FAILURE', description: '补卡',
  requestedClockInAt: '2026-09-01T09:41:00-04:00',
  requestedClockOutAt: '2026-09-01T19:05:00-04:00',
};

function fixture(dailyUpdatedAt: Date | null, active = true) {
  const writes: unknown[][] = [];
  const execute = async (sql: string, params: unknown[] = []) => {
    if (sql.includes('FROM warehouse_users')) return [active ? [{ display_name: 'Employee', employee_no: '001' }] : []];
    if (sql.includes('FROM attendance_daily_results')) return [dailyUpdatedAt ? [{ updated_at: dailyUpdatedAt }] : []];
    if (sql.includes('INSERT INTO attendance_appeals')) { writes.push(params); return [{ affectedRows: 1 }]; }
    if (sql.includes('FROM attendance_appeals')) {
      const p = writes.at(-1)!;
      return [[{
        id: p[0], warehouse_id: p[1], user_id: p[2], employee_reference: p[3],
        employee_name_snapshot: p[4], employee_no_snapshot: p[5], work_date: p[6], appeal_type: p[7],
        requested_clock_in_at: p[8], requested_clock_out_at: p[9], description: p[10], expires_at: p[11],
        appeal_status: 'PENDING', review_note: null, reviewed_by_reference: null, reviewed_at: null,
        created_at: new Date(), updated_at: new Date(),
      }]];
    }
    throw new Error(`Unexpected SQL: ${sql}`);
  };
  return { writes, operations: createAttendanceOperations({ mysql: { execute } as unknown as Pool, storage: {} as LabelStorage }) };
}

for (const [name, updatedAt] of [
  ['old attendance record', new Date('2026-09-01T23:05:00Z')],
  ['missing historical daily record', null],
  ['recent attendance record', new Date('2026-09-30T23:05:00Z')],
] as const) {
  test(`accepts appeal for ${name} regardless of elapsed time`, async context => {
    context.mock.timers.enable({ apis: ['Date'], now: new Date('2026-10-01T15:00:00Z') });
    const { operations, writes } = fixture(updatedAt);
    const result = await operations.createAppeal(session, input);
    assert.equal(result.status, 'PENDING');
    assert.equal(result.workDate, input.workDate);
    assert.equal(result.requestedClockInAt, '2026-09-01T13:41:00.000Z');
    assert.equal(result.requestedClockOutAt, '2026-09-01T23:05:00.000Z');
    assert.equal(writes.length, 1);
    assert.equal(writes[0][1], session.warehouseId);
    assert.equal(writes[0][3], 'user:employee-1');
  });
}

test('unlimited appeals still require a warehouse, active user and valid correction details', async () => {
  const { operations, writes } = fixture(null);
  await assert.rejects(operations.createAppeal({ ...session, warehouseId: null }, input), /请先选择仓库/);
  await assert.rejects(fixture(null, false).operations.createAppeal(session, input), /当前账号不能提交考勤/);
  await assert.rejects(operations.createAppeal(session, { ...input, type: 'INVALID' }), /申诉类型无效/);
  await assert.rejects(operations.createAppeal(session, { ...input, description: '' }), /description/);
  await assert.rejects(operations.createAppeal(session, { ...input, requestedClockInAt: null, requestedClockOutAt: null }), /至少填写一个/);
  assert.equal(writes.length, 0);
});
