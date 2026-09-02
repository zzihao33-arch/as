import { createHash, randomUUID } from 'node:crypto';
import type { Pool, PoolConnection } from 'mysql2/promise';
import type { RowDataPacket } from 'mysql2';
import { ApiError } from './errors.js';
import type { LabelStorage, LabelStorageObject } from './labelStorage.js';
import type { WarehouseSession } from './warehouseIdentity.js';
import { validateAirEvidenceImage } from './airPickupOperations.js';
import {
  ATTENDANCE_TIME_ZONE,
  FUEL_ALLOWANCE_PER_DAY,
  OVERTIME_MULTIPLIER,
  WEEKLY_REGULAR_MINUTES,
  calculateDailyAttendance,
  calculatePayrollRow,
  dateInTimeZone,
  haversineDistanceMeters,
} from './attendanceCalculations.js';

type RequestAudit = { requestId: string; ip: string; userAgent?: string };
type PunchType = 'IN' | 'OUT';
type AttendanceChannel = 'MOBILE' | 'WORKSTATION';
type GestureType = 'BLINK' | 'MOUTH_OPEN';

type EmployeeSnapshotRow = RowDataPacket & {
  user_id: string;
  display_name: string;
  employee_no: string | null;
};
type LocationRow = RowDataPacket & {
  id: string; warehouse_id: string; location_name: string; address_text: string | null;
  latitude: number | string; longitude: number | string; radius_meters: number;
  location_status: 'ACTIVE' | 'DISABLED'; created_at: Date; updated_at: Date;
};
type ShiftRuleRow = RowDataPacket & {
  id: string; warehouse_id: string; rule_name: string; time_zone: string; weekdays: string | number[];
  start_time: string; end_time: string; late_grace_minutes: number; early_grace_minutes: number;
  effective_from: Date | string; effective_to: Date | string | null; rule_status: 'ACTIVE' | 'DISABLED'; rule_version: number;
};
type DailyRow = RowDataPacket & {
  id: string; warehouse_id: string; user_id: string | null; employee_reference: string;
  employee_name_snapshot: string; employee_no_snapshot: string | null; work_date: Date | string;
  clock_in_punch_id: string | null; clock_out_punch_id: string | null;
  clock_in_attempt_id?: string | null; clock_out_attempt_id?: string | null;
  clock_in_at: Date | null; clock_out_at: Date | null; gross_minutes: number; net_minutes: number;
  result_status: string; is_late: number | boolean; is_early_leave: number | boolean;
  shift_rule_id: string | null; scheduled_start_snapshot: string | null; scheduled_end_snapshot: string | null;
  late_grace_minutes_snapshot: number; early_grace_minutes_snapshot: number;
  result_version: number; calculated_at: Date; updated_at: Date;
};
type AppealRow = RowDataPacket & {
  id: string; warehouse_id: string; user_id: string | null; employee_reference: string;
  employee_name_snapshot: string; employee_no_snapshot: string | null; work_date: Date | string;
  appeal_type: 'DEVICE_FAILURE' | 'TEMPORARY_LEAVE' | 'OTHER';
  requested_clock_in_at: Date | null; requested_clock_out_at: Date | null; description: string;
  appeal_status: 'PENDING' | 'APPROVED' | 'REJECTED'; review_note: string | null;
  reviewed_by_reference: string | null; reviewed_at: Date | null; expires_at: Date; created_at: Date; updated_at: Date;
};
type PunchPhotoRow = RowDataPacket & {
  id: string; user_id: string | null; employee_reference: string; photo_storage_key: string | null;
  photo_content_type: 'image/jpeg' | 'image/png' | null; photo_byte_size: number | null;
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MAX_PHOTO_BYTES = 1024 * 1024;
const MAX_RANGE_DAYS = 90;

function actor(session: WarehouseSession): string { return `user:${session.userId}`; }
function uuid(value: unknown, field: string): string {
  const result = String(value ?? '').trim();
  if (!UUID_PATTERN.test(result)) throw new ApiError(400, 'VALIDATION_ERROR', `${field} 必须是 UUID。`);
  return result;
}
function text(value: unknown, field: string, maxLength: number, required = true): string | null {
  if (value === undefined || value === null || value === '') {
    if (required) throw new ApiError(400, 'VALIDATION_ERROR', `${field} 为必填项。`);
    return null;
  }
  if (typeof value !== 'string') throw new ApiError(400, 'VALIDATION_ERROR', `${field} 必须是字符串。`);
  const result = value.trim();
  if (!result || result.length > maxLength) throw new ApiError(400, 'VALIDATION_ERROR', `${field} 长度无效。`);
  return result;
}
function finiteNumber(value: unknown, field: string, minimum: number, maximum: number, required = true): number | null {
  if ((value === undefined || value === null || value === '') && !required) return null;
  const result = Number(value);
  if (!Number.isFinite(result) || result < minimum || result > maximum) {
    throw new ApiError(400, 'VALIDATION_ERROR', `${field} 数值无效。`);
  }
  return result;
}
function booleanValue(value: unknown): boolean { return value === true || value === 'true' || value === '1' || value === 1; }
function dateString(value: unknown, field: string): string {
  const result = text(value, field, 10)!;
  if (!DATE_PATTERN.test(result) || Number.isNaN(new Date(`${result}T12:00:00Z`).getTime())) {
    throw new ApiError(400, 'VALIDATION_ERROR', `${field} 必须是 YYYY-MM-DD。`);
  }
  return result;
}
function dateTime(value: unknown, field: string, required = true): Date | null {
  if ((value === undefined || value === null || value === '') && !required) return null;
  const result = new Date(String(value));
  if (Number.isNaN(result.getTime())) throw new ApiError(400, 'VALIDATION_ERROR', `${field} 必须是有效时间。`);
  return result;
}
function sqlDate(value: Date | string): string {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}
function timeMinutes(value: string | null): number | null {
  if (!value) return null;
  const [hour, minute] = value.split(':').map(Number);
  return Number.isFinite(hour) && Number.isFinite(minute) ? hour * 60 + minute : null;
}
function toLocation(row: LocationRow) {
  return {
    id: row.id, name: row.location_name, address: row.address_text,
    latitude: Number(row.latitude), longitude: Number(row.longitude), radiusMeters: row.radius_meters,
    status: row.location_status, createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString(),
  };
}
function toShiftRule(row: ShiftRuleRow) {
  const weekdays = typeof row.weekdays === 'string' ? JSON.parse(row.weekdays) as number[] : row.weekdays;
  return {
    id: row.id, name: row.rule_name, timeZone: row.time_zone, weekdays,
    startTime: row.start_time.slice(0, 5), endTime: row.end_time.slice(0, 5),
    lateGraceMinutes: row.late_grace_minutes, earlyGraceMinutes: row.early_grace_minutes,
    effectiveFrom: sqlDate(row.effective_from), effectiveTo: row.effective_to ? sqlDate(row.effective_to) : null,
    status: row.rule_status, version: row.rule_version,
  };
}
function toDaily(row: DailyRow) {
  return {
    id: row.id, userId: row.user_id, employeeReference: row.employee_reference,
    employeeName: row.employee_name_snapshot, employeeNo: row.employee_no_snapshot,
    workDate: sqlDate(row.work_date), clockInAt: row.clock_in_at?.toISOString() ?? null,
    clockOutAt: row.clock_out_at?.toISOString() ?? null, grossMinutes: row.gross_minutes,
    clockInAttemptId: row.clock_in_attempt_id ?? null, clockOutAttemptId: row.clock_out_attempt_id ?? null,
    netMinutes: row.net_minutes, status: row.result_status, isLate: Boolean(row.is_late),
    isEarlyLeave: Boolean(row.is_early_leave), version: row.result_version,
    updatedAt: row.updated_at.toISOString(),
  };
}
function toAppeal(row: AppealRow) {
  return {
    id: row.id, userId: row.user_id, employeeReference: row.employee_reference,
    employeeName: row.employee_name_snapshot, employeeNo: row.employee_no_snapshot,
    workDate: sqlDate(row.work_date), type: row.appeal_type,
    requestedClockInAt: row.requested_clock_in_at?.toISOString() ?? null,
    requestedClockOutAt: row.requested_clock_out_at?.toISOString() ?? null,
    description: row.description, status: row.appeal_status, reviewNote: row.review_note,
    reviewedByReference: row.reviewed_by_reference, reviewedAt: row.reviewed_at?.toISOString() ?? null,
    expiresAt: row.expires_at.toISOString(), createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString(),
  };
}
function range(inputFrom: unknown, inputTo: unknown): { from: string; to: string } {
  const now = new Date();
  const defaultTo = dateInTimeZone(now);
  const defaultFromDate = new Date(`${defaultTo}T12:00:00Z`);
  defaultFromDate.setUTCDate(1);
  const from = inputFrom ? dateString(inputFrom, 'dateFrom') : defaultFromDate.toISOString().slice(0, 10);
  const to = inputTo ? dateString(inputTo, 'dateTo') : defaultTo;
  const days = Math.round((new Date(`${to}T12:00:00Z`).getTime() - new Date(`${from}T12:00:00Z`).getTime()) / 86_400_000) + 1;
  if (days < 1 || days > MAX_RANGE_DAYS) throw new ApiError(400, 'INVALID_ATTENDANCE_RANGE', '查询区间必须为 1 到 90 天。');
  return { from, to };
}

async function snapshot(mysql: Pool, session: WarehouseSession): Promise<EmployeeSnapshotRow> {
  const [rows] = await mysql.execute<EmployeeSnapshotRow[]>(
    `SELECT u.id AS user_id, u.display_name, m.employee_no
     FROM warehouse_users u
     LEFT JOIN warehouse_memberships m ON m.user_id = u.id AND m.warehouse_id = ? AND m.membership_status = 'ACTIVE'
     WHERE u.id = ? AND u.user_status = 'ACTIVE' LIMIT 1`,
    [session.warehouseId, session.userId],
  );
  if (!rows[0]) throw new ApiError(403, 'ATTENDANCE_USER_UNAVAILABLE', '当前账号不能提交考勤。');
  return rows[0];
}

async function activeShiftRule(connection: Pool | PoolConnection, warehouseId: string, workDate: string): Promise<ShiftRuleRow | null> {
  const [rows] = await connection.execute<ShiftRuleRow[]>(
    `SELECT * FROM attendance_shift_rules
     WHERE warehouse_id = ? AND rule_status = 'ACTIVE' AND effective_from <= ?
       AND (effective_to IS NULL OR effective_to >= ?)
     ORDER BY effective_from DESC, created_at DESC`,
    [warehouseId, workDate, workDate],
  );
  const day = new Date(`${workDate}T12:00:00Z`).getUTCDay() || 7;
  return rows.find(row => {
    const weekdays = typeof row.weekdays === 'string' ? JSON.parse(row.weekdays) as number[] : row.weekdays;
    return weekdays.includes(day);
  }) ?? null;
}

async function activeLocations(connection: Pool | PoolConnection, warehouseId: string): Promise<LocationRow[]> {
  const [rows] = await connection.execute<LocationRow[]>(
    `SELECT * FROM attendance_locations WHERE warehouse_id = ? AND location_status = 'ACTIVE' ORDER BY created_at`,
    [warehouseId],
  );
  return rows;
}

function closestLocation(rows: LocationRow[], latitude: number, longitude: number) {
  let closest: { row: LocationRow; distance: number } | null = null;
  for (const row of rows) {
    const distance = haversineDistanceMeters(latitude, longitude, Number(row.latitude), Number(row.longitude));
    if (!closest || distance < closest.distance) closest = { row, distance };
  }
  return closest;
}

async function insertAttempt(connection: PoolConnection, input: {
  id: string; session: WarehouseSession; employee: EmployeeSnapshotRow; audit: RequestAudit;
  workstationId: string | null; punchType: PunchType; channel: AttendanceChannel;
  result: 'ACCEPTED' | 'REJECTED' | 'EXCEPTION_REQUIRED'; reasonCode: string | null; reasonText: string | null;
  now: Date; clientCapturedAt: Date | null; latitude: number | null; longitude: number | null; accuracy: number | null;
  matchedLocationId: string | null; distance: number | null; gestureType: GestureType; gesturePassed: boolean;
  gestureScore: number | null; photo: ReturnType<typeof validateAirEvidenceImage>; storageKey: string;
}) {
  await connection.execute(
    `INSERT INTO attendance_punch_attempts
       (id, warehouse_id, user_id, employee_reference, employee_name_snapshot, employee_no_snapshot,
        workstation_id, punch_type, channel, attempt_result, reason_code, reason_text,
        server_received_at, client_captured_at, location_latitude, location_longitude,
        location_accuracy_meters, matched_location_id, distance_meters,
        gesture_type, gesture_passed, gesture_score, photo_storage_key, photo_sha256,
        photo_content_type, photo_byte_size, photo_width, photo_height,
        evidence_delete_after, request_id, ip_address, user_agent)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, DATE_ADD(?, INTERVAL 6 MONTH), ?, ?, ?)`,
    [
      input.id, input.session.warehouseId, input.session.userId, actor(input.session), input.employee.display_name, input.employee.employee_no,
      input.workstationId, input.punchType, input.channel, input.result, input.reasonCode, input.reasonText,
      input.now, input.clientCapturedAt, input.latitude, input.longitude, input.accuracy, input.matchedLocationId,
      input.distance === null ? null : Math.round(input.distance * 100) / 100,
      input.gestureType, input.gesturePassed, input.gestureScore, input.storageKey, input.photo.sha256,
      input.photo.contentType, input.photo.content.length, input.photo.width, input.photo.height,
      input.now, input.audit.requestId, input.audit.ip, input.audit.userAgent ?? null,
    ],
  );
}

export function createAttendanceOperations(dependencies: { mysql: Pool; storage: LabelStorage }) {
  const { mysql, storage } = dependencies;
  const materializeDailyResults = async (warehouseId: string, dates: { from: string; to: string }) => {
    await mysql.execute(
      `UPDATE attendance_daily_results
       SET result_status = 'MISSING_OUT', result_version = result_version + 1, calculated_at = CURRENT_TIMESTAMP(3)
       WHERE warehouse_id = ? AND result_status = 'OPEN'
         AND clock_in_at < DATE_SUB(CURRENT_TIMESTAMP(3), INTERVAL 18 HOUR)`,
      [warehouseId],
    );
    const [rules] = await mysql.execute<ShiftRuleRow[]>(
      `SELECT * FROM attendance_shift_rules
       WHERE warehouse_id = ? AND rule_status = 'ACTIVE' AND effective_from <= ?
         AND (effective_to IS NULL OR effective_to >= ?)
       ORDER BY effective_from DESC, created_at DESC`,
      [warehouseId, dates.to, dates.from],
    );
    if (rules.length === 0) return;
    const [employees] = await mysql.execute<(EmployeeSnapshotRow & { membership_created_at: Date })[]>(
      `SELECT DISTINCT u.id AS user_id, u.display_name, m.employee_no, m.created_at AS membership_created_at
       FROM warehouse_users u
       INNER JOIN warehouse_memberships m ON m.user_id = u.id AND m.warehouse_id = ? AND m.membership_status = 'ACTIVE'
       INNER JOIN warehouse_role_permissions rp ON rp.role_id = m.role_id AND rp.permission_code = 'attendance.punch'
       WHERE u.user_status = 'ACTIVE'`,
      [warehouseId],
    );
    if (employees.length === 0) return;
    const today = dateInTimeZone(new Date());
    const cursor = new Date(`${dates.from}T12:00:00Z`);
    const end = new Date(`${dates.to}T12:00:00Z`);
    const rows: Array<Array<string | number | boolean | null>> = [];
    while (cursor <= end) {
      const workDate = cursor.toISOString().slice(0, 10);
      if (workDate < today) {
        const day = cursor.getUTCDay() || 7;
        const rule = rules.find(candidate => {
          const effectiveFrom = sqlDate(candidate.effective_from);
          const effectiveTo = candidate.effective_to ? sqlDate(candidate.effective_to) : null;
          const weekdays = typeof candidate.weekdays === 'string' ? JSON.parse(candidate.weekdays) as number[] : candidate.weekdays;
          return effectiveFrom <= workDate && (!effectiveTo || effectiveTo >= workDate) && weekdays.includes(day);
        });
        if (rule) {
          for (const employee of employees) {
            if (dateInTimeZone(employee.membership_created_at) > workDate) continue;
            rows.push([
              randomUUID(), warehouseId, employee.user_id, `user:${employee.user_id}`,
              employee.display_name, employee.employee_no, workDate, 0, 0, 'ABSENT', false, false,
              rule.id, rule.start_time, rule.end_time, rule.late_grace_minutes, rule.early_grace_minutes,
            ]);
          }
        }
      }
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }
    for (let start = 0; start < rows.length; start += 500) {
      const chunk = rows.slice(start, start + 500);
      const placeholders = chunk.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').join(',');
      await mysql.execute(
        `INSERT IGNORE INTO attendance_daily_results
           (id, warehouse_id, user_id, employee_reference, employee_name_snapshot, employee_no_snapshot,
            work_date, gross_minutes, net_minutes, result_status, is_late, is_early_leave,
            shift_rule_id, scheduled_start_snapshot, scheduled_end_snapshot,
            late_grace_minutes_snapshot, early_grace_minutes_snapshot)
         VALUES ${placeholders}`,
        chunk.flat(),
      );
    }
  };
  return {
    async listLocations(session: WarehouseSession) {
      if (!session.warehouseId) throw new ApiError(409, 'WAREHOUSE_SELECTION_REQUIRED', '请先选择仓库。');
      const [rows] = await mysql.execute<LocationRow[]>(
        `SELECT * FROM attendance_locations WHERE warehouse_id = ? ORDER BY location_status, created_at`, [session.warehouseId],
      );
      return rows.map(toLocation);
    },

    async saveLocation(session: WarehouseSession, input: Record<string, unknown>) {
      if (!session.warehouseId) throw new ApiError(409, 'WAREHOUSE_SELECTION_REQUIRED', '请先选择仓库。');
      const id = input.id ? uuid(input.id, 'id') : randomUUID();
      const name = text(input.name, 'name', 128)!;
      const address = text(input.address, 'address', 255, false);
      const latitude = finiteNumber(input.latitude, 'latitude', -90, 90)!;
      const longitude = finiteNumber(input.longitude, 'longitude', -180, 180)!;
      const radius = finiteNumber(input.radiusMeters, 'radiusMeters', 50, 1000)!;
      const status = input.status === 'DISABLED' ? 'DISABLED' : 'ACTIVE';
      await mysql.execute(
        `INSERT INTO attendance_locations
           (id, warehouse_id, location_name, address_text, latitude, longitude, radius_meters,
            location_status, created_by_user_id, created_by_reference)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE location_name = VALUES(location_name), address_text = VALUES(address_text),
           latitude = VALUES(latitude), longitude = VALUES(longitude), radius_meters = VALUES(radius_meters),
           location_status = VALUES(location_status)`,
        [id, session.warehouseId, name, address, latitude, longitude, radius, status, session.userId, actor(session)],
      );
      const [rows] = await mysql.execute<LocationRow[]>(`SELECT * FROM attendance_locations WHERE id = ? AND warehouse_id = ? LIMIT 1`, [id, session.warehouseId]);
      return toLocation(rows[0]);
    },

    async listShiftRules(session: WarehouseSession) {
      if (!session.warehouseId) throw new ApiError(409, 'WAREHOUSE_SELECTION_REQUIRED', '请先选择仓库。');
      const [rows] = await mysql.execute<ShiftRuleRow[]>(
        `SELECT * FROM attendance_shift_rules WHERE warehouse_id = ? ORDER BY effective_from DESC, created_at DESC`, [session.warehouseId],
      );
      return rows.map(toShiftRule);
    },

    async saveShiftRule(session: WarehouseSession, input: Record<string, unknown>) {
      if (!session.warehouseId) throw new ApiError(409, 'WAREHOUSE_SELECTION_REQUIRED', '请先选择仓库。');
      const id = input.id ? uuid(input.id, 'id') : randomUUID();
      const name = text(input.name, 'name', 128)!;
      const weekdays = Array.isArray(input.weekdays) ? input.weekdays.map(Number) : [];
      if (weekdays.length === 0 || weekdays.some(day => !Number.isInteger(day) || day < 1 || day > 7)) {
        throw new ApiError(400, 'VALIDATION_ERROR', 'weekdays 必须包含 1 到 7 的星期值。');
      }
      const startTime = text(input.startTime, 'startTime', 5)!;
      const endTime = text(input.endTime, 'endTime', 5)!;
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(startTime) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(endTime)) {
        throw new ApiError(400, 'VALIDATION_ERROR', '班次时间必须为 HH:mm。');
      }
      const lateGrace = finiteNumber(input.lateGraceMinutes ?? 0, 'lateGraceMinutes', 0, 240)!;
      const earlyGrace = finiteNumber(input.earlyGraceMinutes ?? 0, 'earlyGraceMinutes', 0, 240)!;
      const effectiveFrom = dateString(input.effectiveFrom, 'effectiveFrom');
      const effectiveTo = input.effectiveTo ? dateString(input.effectiveTo, 'effectiveTo') : null;
      if (effectiveTo && effectiveTo < effectiveFrom) throw new ApiError(400, 'VALIDATION_ERROR', '结束日期不能早于开始日期。');
      const status = input.status === 'DISABLED' ? 'DISABLED' : 'ACTIVE';
      await mysql.execute(
        `INSERT INTO attendance_shift_rules
           (id, warehouse_id, rule_name, time_zone, weekdays, start_time, end_time,
            late_grace_minutes, early_grace_minutes, effective_from, effective_to,
            rule_status, created_by_user_id, created_by_reference)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE rule_name = VALUES(rule_name), weekdays = VALUES(weekdays),
           start_time = VALUES(start_time), end_time = VALUES(end_time), late_grace_minutes = VALUES(late_grace_minutes),
           early_grace_minutes = VALUES(early_grace_minutes), effective_from = VALUES(effective_from),
           effective_to = VALUES(effective_to), rule_status = VALUES(rule_status), rule_version = rule_version + 1`,
        [id, session.warehouseId, name, ATTENDANCE_TIME_ZONE, JSON.stringify([...new Set(weekdays)].sort()),
          `${startTime}:00`, `${endTime}:00`, lateGrace, earlyGrace, effectiveFrom, effectiveTo, status, session.userId, actor(session)],
      );
      const [rows] = await mysql.execute<ShiftRuleRow[]>(`SELECT * FROM attendance_shift_rules WHERE id = ? AND warehouse_id = ? LIMIT 1`, [id, session.warehouseId]);
      return toShiftRule(rows[0]);
    },

    async getPunchContext(session: WarehouseSession) {
      if (!session.warehouseId) throw new ApiError(409, 'WAREHOUSE_SELECTION_REQUIRED', '请先选择仓库。');
      const employee = await snapshot(mysql, session);
      const today = dateInTimeZone(new Date());
      const [locations, shift, dailyRows] = await Promise.all([
        activeLocations(mysql, session.warehouseId),
        activeShiftRule(mysql, session.warehouseId, today),
        mysql.execute<DailyRow[]>(
          `SELECT * FROM attendance_daily_results
           WHERE warehouse_id = ? AND employee_reference = ?
             AND (work_date = ? OR (result_status = 'OPEN' AND clock_in_at >= DATE_SUB(CURRENT_TIMESTAMP(3), INTERVAL 18 HOUR)))
           ORDER BY (result_status = 'OPEN') DESC, clock_in_at DESC LIMIT 1`,
          [session.warehouseId, actor(session), today],
        ).then(([rows]) => rows),
      ]);
      return { employeeName: employee.display_name, employeeNo: employee.employee_no, today,
        locations: locations.map(toLocation), shiftRule: shift ? toShiftRule(shift) : null,
        todayResult: dailyRows[0] ? toDaily(dailyRows[0]) : null, serverTime: new Date().toISOString() };
    },

    async submitPunch(session: WarehouseSession, audit: RequestAudit, input: Record<string, unknown> & { content?: unknown; contentType?: unknown }) {
      if (!session.warehouseId) throw new ApiError(409, 'WAREHOUSE_SELECTION_REQUIRED', '请先选择仓库。');
      const employee = await snapshot(mysql, session);
      const punchType = text(input.punchType, 'punchType', 3)! as PunchType;
      if (punchType !== 'IN' && punchType !== 'OUT') throw new ApiError(400, 'VALIDATION_ERROR', 'punchType 仅支持 IN 或 OUT。');
      const channel = text(input.channel, 'channel', 11)! as AttendanceChannel;
      if (channel !== 'MOBILE' && channel !== 'WORKSTATION') throw new ApiError(400, 'VALIDATION_ERROR', 'channel 无效。');
      const gestureType = text(input.gestureType, 'gestureType', 10)! as GestureType;
      if (gestureType !== 'BLINK' && gestureType !== 'MOUTH_OPEN') throw new ApiError(400, 'VALIDATION_ERROR', 'gestureType 无效。');
      const gesturePassed = booleanValue(input.gesturePassed);
      const gestureScore = finiteNumber(input.gestureScore, 'gestureScore', 0, 100, false);
      const clientCapturedAt = dateTime(input.clientCapturedAt, 'clientCapturedAt', false);
      const latitude = finiteNumber(input.latitude, 'latitude', -90, 90, false);
      const longitude = finiteNumber(input.longitude, 'longitude', -180, 180, false);
      const accuracy = finiteNumber(input.accuracy, 'accuracy', 0, 10_000, false);
      const workstationId = input.workstationId ? uuid(input.workstationId, 'workstationId') : null;
      const photo = validateAirEvidenceImage(
        input.content,
        String(input.contentType ?? ''),
        String(input.sha256 ?? '') || undefined,
        { width: 640, height: 480 },
      );
      if (photo.content.length > MAX_PHOTO_BYTES) throw new ApiError(413, 'ATTENDANCE_PHOTO_TOO_LARGE', '打卡照片不能超过 1MB。');

      const now = new Date();
      const attemptId = randomUUID();
      const storageKey = `attendance/${photo.sha256.slice(0, 2)}/${photo.sha256}.${photo.contentType === 'image/png' ? 'png' : 'jpg'}`;
      await storage.put(storageKey, photo.content);
      const connection = await mysql.getConnection();
      try {
        await connection.beginTransaction();
        let result: 'ACCEPTED' | 'REJECTED' | 'EXCEPTION_REQUIRED' = 'ACCEPTED';
        let reasonCode: string | null = null;
        let reasonText: string | null = null;
        let matchedLocationId: string | null = null;
        let distance: number | null = null;

        if (!gesturePassed || gestureScore === null || gestureScore < 0.005) {
          result = 'EXCEPTION_REQUIRED'; reasonCode = 'GESTURE_NOT_VERIFIED'; reasonText = '动作验证未通过，请重试或提交例外申请。';
        }
        if (channel === 'WORKSTATION') {
          if (!workstationId) {
            result = 'REJECTED'; reasonCode = 'WORKSTATION_REQUIRED'; reasonText = '固定电脑打卡必须登记当前工作站。';
          } else {
            const [workstations] = await connection.execute<RowDataPacket[]>(
              `SELECT id FROM workstations WHERE id = ? AND warehouse_id = ? AND workstation_status = 'ACTIVE' LIMIT 1`,
              [workstationId, session.warehouseId],
            );
            if (!workstations[0]) {
              result = 'REJECTED'; reasonCode = 'WORKSTATION_DISABLED'; reasonText = '当前工作站未登记或已停用。';
            }
          }
        }
        const locations = await activeLocations(connection, session.warehouseId);
        if (latitude !== null && longitude !== null) {
          const closest = closestLocation(locations, latitude, longitude);
          matchedLocationId = closest?.row.id ?? null;
          distance = closest?.distance ?? null;
        }
        if (channel === 'MOBILE') {
          if (latitude === null || longitude === null || accuracy === null) {
            result = 'EXCEPTION_REQUIRED'; reasonCode = 'LOCATION_REQUIRED'; reasonText = '手机打卡必须获取浏览器位置。';
          } else if (accuracy > 50) {
            result = 'EXCEPTION_REQUIRED'; reasonCode = 'LOCATION_LOW_ACCURACY'; reasonText = '定位精度超过50米，请靠近窗口后重试。';
          } else if (!matchedLocationId || distance === null || !locations.some(location => location.id === matchedLocationId && distance! <= location.radius_meters)) {
            result = 'EXCEPTION_REQUIRED'; reasonCode = 'OUTSIDE_GEOFENCE'; reasonText = '当前位置不在已启用的仓库打卡范围内。';
          }
        }

        let daily: DailyRow | null = null;
        let workDate = dateInTimeZone(now);
        if (result === 'ACCEPTED') {
          if (punchType === 'IN') {
            const [openShifts] = await connection.execute<DailyRow[]>(
              `SELECT * FROM attendance_daily_results
               WHERE warehouse_id = ? AND employee_reference = ? AND result_status = 'OPEN'
               ORDER BY clock_in_at DESC LIMIT 1 FOR UPDATE`,
              [session.warehouseId, actor(session)],
            );
            const openShift = openShifts[0];
            if (openShift?.clock_in_at && openShift.clock_in_at.getTime() >= now.getTime() - 18 * 60 * 60_000) {
              result = 'REJECTED'; reasonCode = 'OPEN_SHIFT_EXISTS'; reasonText = '已有未结束班次，请先完成下班打卡。';
            } else if (openShift) {
              await connection.execute(
                `UPDATE attendance_daily_results
                 SET result_status = 'NEEDS_REVIEW', result_version = result_version + 1, calculated_at = CURRENT_TIMESTAMP(3)
                 WHERE id = ?`, [openShift.id],
              );
            }
            const [existing] = await connection.execute<DailyRow[]>(
              `SELECT * FROM attendance_daily_results WHERE warehouse_id = ? AND employee_reference = ? AND work_date = ? LIMIT 1 FOR UPDATE`,
              [session.warehouseId, actor(session), workDate],
            );
            if (result === 'ACCEPTED' && existing[0]) {
              result = 'REJECTED'; reasonCode = 'CLOCK_IN_ALREADY_EXISTS'; reasonText = '今天已经存在上班打卡。';
            }
          } else {
            const [open] = await connection.execute<DailyRow[]>(
              `SELECT * FROM attendance_daily_results
               WHERE warehouse_id = ? AND employee_reference = ? AND result_status = 'OPEN'
                 AND clock_in_at >= DATE_SUB(?, INTERVAL 18 HOUR)
               ORDER BY clock_in_at DESC LIMIT 1 FOR UPDATE`,
              [session.warehouseId, actor(session), now],
            );
            daily = open[0] ?? null;
            if (!daily) {
              result = 'EXCEPTION_REQUIRED'; reasonCode = 'OPEN_SHIFT_NOT_FOUND'; reasonText = '未找到18小时内的上班打卡，请提交例外申请。';
            } else {
              workDate = sqlDate(daily.work_date);
            }
          }
        }

        await insertAttempt(connection, { id: attemptId, session, employee, audit, workstationId, punchType, channel,
          result, reasonCode, reasonText, now, clientCapturedAt, latitude, longitude, accuracy, matchedLocationId,
          distance, gestureType, gesturePassed, gestureScore, photo, storageKey });

        if (result !== 'ACCEPTED') {
          await connection.commit();
          return { attemptId, accepted: false, result, reasonCode, message: reasonText, serverTime: now.toISOString() };
        }

        const punchId = randomUUID();
        if (punchType === 'IN') {
          const shift = await activeShiftRule(connection, session.warehouseId, workDate);
          const calculation = calculateDailyAttendance({
            workDate, clockInAt: now, clockOutAt: null,
            scheduledStartMinutes: timeMinutes(shift?.start_time ?? null), scheduledEndMinutes: timeMinutes(shift?.end_time ?? null),
            lateGraceMinutes: shift?.late_grace_minutes, earlyGraceMinutes: shift?.early_grace_minutes,
          });
          await connection.execute(
            `INSERT INTO attendance_punches
               (id, attempt_id, warehouse_id, user_id, employee_reference, employee_name_snapshot,
                employee_no_snapshot, punch_type, occurred_at, work_date, punch_source,
                created_by_user_id, created_by_reference)
             VALUES (?, ?, ?, ?, ?, ?, ?, 'IN', ?, ?, 'NORMAL', ?, ?)`,
            [punchId, attemptId, session.warehouseId, session.userId, actor(session), employee.display_name,
              employee.employee_no, now, workDate, session.userId, actor(session)],
          );
          const dailyId = randomUUID();
          await connection.execute(
            `INSERT INTO attendance_daily_results
               (id, warehouse_id, user_id, employee_reference, employee_name_snapshot, employee_no_snapshot,
                work_date, clock_in_punch_id, clock_in_at, gross_minutes, net_minutes, result_status,
                is_late, is_early_leave, shift_rule_id, scheduled_start_snapshot, scheduled_end_snapshot,
                late_grace_minutes_snapshot, early_grace_minutes_snapshot)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [dailyId, session.warehouseId, session.userId, actor(session), employee.display_name, employee.employee_no,
              workDate, punchId, now, calculation.grossMinutes, calculation.netMinutes, calculation.status,
              calculation.isLate, calculation.isEarlyLeave, shift?.id ?? null, shift?.start_time ?? null, shift?.end_time ?? null,
              shift?.late_grace_minutes ?? 0, shift?.early_grace_minutes ?? 0],
          );
          const [rows] = await connection.execute<DailyRow[]>(`SELECT * FROM attendance_daily_results WHERE id = ? LIMIT 1`, [dailyId]);
          daily = rows[0];
        } else {
          const shift = daily!.shift_rule_id ? await activeShiftRule(connection, session.warehouseId, workDate) : null;
          const calculation = calculateDailyAttendance({
            workDate, clockInAt: daily!.clock_in_at, clockOutAt: now,
            scheduledStartMinutes: timeMinutes(daily!.scheduled_start_snapshot), scheduledEndMinutes: timeMinutes(daily!.scheduled_end_snapshot),
            lateGraceMinutes: daily!.late_grace_minutes_snapshot ?? shift?.late_grace_minutes,
            earlyGraceMinutes: daily!.early_grace_minutes_snapshot ?? shift?.early_grace_minutes,
          });
          await connection.execute(
            `INSERT INTO attendance_punches
               (id, attempt_id, warehouse_id, user_id, employee_reference, employee_name_snapshot,
                employee_no_snapshot, punch_type, occurred_at, work_date, punch_source,
                created_by_user_id, created_by_reference)
             VALUES (?, ?, ?, ?, ?, ?, ?, 'OUT', ?, ?, 'NORMAL', ?, ?)`,
            [punchId, attemptId, session.warehouseId, session.userId, actor(session), employee.display_name,
              employee.employee_no, now, workDate, session.userId, actor(session)],
          );
          await connection.execute(
            `UPDATE attendance_daily_results
             SET clock_out_punch_id = ?, clock_out_at = ?, gross_minutes = ?, net_minutes = ?, result_status = ?,
                 is_late = ?, is_early_leave = ?, result_version = result_version + 1, calculated_at = CURRENT_TIMESTAMP(3)
             WHERE id = ?`,
            [punchId, now, calculation.grossMinutes, calculation.netMinutes, calculation.status,
              calculation.isLate, calculation.isEarlyLeave, daily!.id],
          );
          const [rows] = await connection.execute<DailyRow[]>(`SELECT * FROM attendance_daily_results WHERE id = ? LIMIT 1`, [daily!.id]);
          daily = rows[0];
        }
        await connection.commit();
        return { attemptId, accepted: true, result: 'ACCEPTED' as const, dailyResult: toDaily(daily!), serverTime: now.toISOString() };
      } catch (error) {
        await connection.rollback().catch(() => undefined);
        throw error;
      } finally {
        connection.release();
      }
    },

    async listDailyResults(session: WarehouseSession, filters: { dateFrom?: unknown; dateTo?: unknown; userId?: unknown }) {
      if (!session.warehouseId) throw new ApiError(409, 'WAREHOUSE_SELECTION_REQUIRED', '请先选择仓库。');
      const dates = range(filters.dateFrom, filters.dateTo);
      await materializeDailyResults(session.warehouseId, dates);
      const canViewTeam = session.platformRole === 'SYSTEM_ADMIN' || session.permissions.includes('attendance.team_view');
      const requestedUserId = filters.userId ? uuid(filters.userId, 'userId') : null;
      const targetUserId = canViewTeam ? requestedUserId : session.userId;
      const [rows] = await mysql.execute<DailyRow[]>(
        `SELECT d.*, pin.attempt_id AS clock_in_attempt_id, pout.attempt_id AS clock_out_attempt_id
         FROM attendance_daily_results d
         LEFT JOIN attendance_punches pin ON pin.id = d.clock_in_punch_id
         LEFT JOIN attendance_punches pout ON pout.id = d.clock_out_punch_id
         WHERE d.warehouse_id = ? AND d.work_date BETWEEN ? AND ? ${targetUserId ? 'AND d.user_id = ?' : ''}
         ORDER BY d.work_date DESC, d.employee_name_snapshot`,
        targetUserId ? [session.warehouseId, dates.from, dates.to, targetUserId] : [session.warehouseId, dates.from, dates.to],
      );
      return { ...dates, rows: rows.map(toDaily) };
    },

    async listAppeals(session: WarehouseSession, status?: unknown) {
      if (!session.warehouseId) throw new ApiError(409, 'WAREHOUSE_SELECTION_REQUIRED', '请先选择仓库。');
      const canReview = session.platformRole === 'SYSTEM_ADMIN' || session.permissions.includes('attendance.review');
      const normalizedStatus = status ? text(status, 'status', 16)! : null;
      const params: Array<string | number | null> = [session.warehouseId];
      let where = 'warehouse_id = ?';
      if (!canReview) { where += ' AND user_id = ?'; params.push(session.userId); }
      if (normalizedStatus) { where += ' AND appeal_status = ?'; params.push(normalizedStatus); }
      const [rows] = await mysql.execute<AppealRow[]>(
        `SELECT * FROM attendance_appeals WHERE ${where} ORDER BY created_at DESC LIMIT 500`, params,
      );
      return rows.map(toAppeal);
    },

    async createAppeal(session: WarehouseSession, input: Record<string, unknown>) {
      if (!session.warehouseId) throw new ApiError(409, 'WAREHOUSE_SELECTION_REQUIRED', '请先选择仓库。');
      const employee = await snapshot(mysql, session);
      const workDate = dateString(input.workDate, 'workDate');
      const type = text(input.type, 'type', 32)!;
      if (!['DEVICE_FAILURE', 'TEMPORARY_LEAVE', 'OTHER'].includes(type)) throw new ApiError(400, 'VALIDATION_ERROR', '申诉类型无效。');
      const description = text(input.description, 'description', 200)!;
      const requestedIn = dateTime(input.requestedClockInAt, 'requestedClockInAt', false);
      const requestedOut = dateTime(input.requestedClockOutAt, 'requestedClockOutAt', false);
      if (!requestedIn && !requestedOut) throw new ApiError(400, 'VALIDATION_ERROR', '至少填写一个需要修正的准确时间。');
      const [dailyRows] = await mysql.execute<DailyRow[]>(
        `SELECT * FROM attendance_daily_results WHERE warehouse_id = ? AND employee_reference = ? AND work_date = ? LIMIT 1`,
        [session.warehouseId, actor(session), workDate],
      );
      const referenceTime = dailyRows[0]?.updated_at ?? new Date(`${workDate}T23:59:59-04:00`);
      const expiresAt = new Date(referenceTime.getTime() + 72 * 60 * 60_000);
      if (expiresAt.getTime() < Date.now()) throw new ApiError(409, 'APPEAL_WINDOW_EXPIRED', '该考勤记录已超过72小时申诉期限。');
      const id = randomUUID();
      await mysql.execute(
        `INSERT INTO attendance_appeals
           (id, warehouse_id, user_id, employee_reference, employee_name_snapshot, employee_no_snapshot,
            work_date, appeal_type, requested_clock_in_at, requested_clock_out_at, description, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, session.warehouseId, session.userId, actor(session), employee.display_name, employee.employee_no,
          workDate, type, requestedIn, requestedOut, description, expiresAt],
      );
      const [rows] = await mysql.execute<AppealRow[]>(`SELECT * FROM attendance_appeals WHERE id = ? LIMIT 1`, [id]);
      return toAppeal(rows[0]);
    },

    async reviewAppeal(session: WarehouseSession, appealIdValue: unknown, input: Record<string, unknown>) {
      if (!session.warehouseId) throw new ApiError(409, 'WAREHOUSE_SELECTION_REQUIRED', '请先选择仓库。');
      const appealId = uuid(appealIdValue, 'appealId');
      const decision = text(input.decision, 'decision', 16)!;
      if (decision !== 'APPROVED' && decision !== 'REJECTED') throw new ApiError(400, 'VALIDATION_ERROR', 'decision 无效。');
      const reviewNote = text(input.reviewNote, 'reviewNote', 500, decision === 'REJECTED');
      const connection = await mysql.getConnection();
      try {
        await connection.beginTransaction();
        const [appeals] = await connection.execute<AppealRow[]>(
          `SELECT * FROM attendance_appeals WHERE id = ? AND warehouse_id = ? LIMIT 1 FOR UPDATE`, [appealId, session.warehouseId],
        );
        const appeal = appeals[0];
        if (!appeal) throw new ApiError(404, 'APPEAL_NOT_FOUND', '未找到申诉。');
        if (appeal.appeal_status !== 'PENDING') throw new ApiError(409, 'APPEAL_ALREADY_REVIEWED', '该申诉已经处理。');
        if (appeal.user_id === session.userId) throw new ApiError(409, 'SELF_REVIEW_NOT_ALLOWED', '主管不能审批自己的申诉。');
        if (decision === 'APPROVED') {
          const [dailyRows] = await connection.execute<DailyRow[]>(
            `SELECT * FROM attendance_daily_results WHERE warehouse_id = ? AND employee_reference = ? AND work_date = ? LIMIT 1 FOR UPDATE`,
            [session.warehouseId, appeal.employee_reference, sqlDate(appeal.work_date)],
          );
          const daily = dailyRows[0] ?? null;
          const clockIn = appeal.requested_clock_in_at ?? daily?.clock_in_at ?? null;
          const clockOut = appeal.requested_clock_out_at ?? daily?.clock_out_at ?? null;
          if (!clockIn || !clockOut) throw new ApiError(400, 'CORRECTION_TIMES_REQUIRED', '批准申诉必须提供完整的上班和下班时间。');
          const calculation = calculateDailyAttendance({
            workDate: sqlDate(appeal.work_date), clockInAt: clockIn, clockOutAt: clockOut,
            scheduledStartMinutes: timeMinutes(daily?.scheduled_start_snapshot ?? null),
            scheduledEndMinutes: timeMinutes(daily?.scheduled_end_snapshot ?? null),
            lateGraceMinutes: daily?.late_grace_minutes_snapshot ?? 0,
            earlyGraceMinutes: daily?.early_grace_minutes_snapshot ?? 0,
          });
          if (calculation.status !== 'COMPLETE') throw new ApiError(400, 'INVALID_CORRECTION_SHIFT', '修正后的班次必须大于0且不超过18小时。');
          await connection.execute(
            `UPDATE attendance_punches SET punch_status = 'SUPERSEDED'
             WHERE warehouse_id = ? AND employee_reference = ? AND work_date = ? AND punch_status = 'ACTIVE'`,
            [session.warehouseId, appeal.employee_reference, sqlDate(appeal.work_date)],
          );
          const inId = randomUUID(); const outId = randomUUID();
          const punchRows = [
            [inId, 'IN', clockIn], [outId, 'OUT', clockOut],
          ];
          for (const [id, type, occurredAt] of punchRows) {
            await connection.execute(
              `INSERT INTO attendance_punches
                 (id, attempt_id, warehouse_id, user_id, employee_reference, employee_name_snapshot,
                  employee_no_snapshot, punch_type, occurred_at, work_date, punch_source,
                  created_by_user_id, created_by_reference)
               VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, 'APPEAL_CORRECTION', ?, ?)`,
              [id, session.warehouseId, appeal.user_id, appeal.employee_reference, appeal.employee_name_snapshot,
                appeal.employee_no_snapshot, type, occurredAt, sqlDate(appeal.work_date), session.userId, actor(session)],
            );
          }
          if (daily) {
            await connection.execute(
              `UPDATE attendance_daily_results
               SET clock_in_punch_id = ?, clock_out_punch_id = ?, clock_in_at = ?, clock_out_at = ?,
                   gross_minutes = ?, net_minutes = ?, result_status = 'COMPLETE', is_late = ?,
                   is_early_leave = ?, result_version = result_version + 1, calculated_at = CURRENT_TIMESTAMP(3)
               WHERE id = ?`,
              [inId, outId, clockIn, clockOut, calculation.grossMinutes, calculation.netMinutes,
                calculation.isLate, calculation.isEarlyLeave, daily.id],
            );
          } else {
            await connection.execute(
              `INSERT INTO attendance_daily_results
                 (id, warehouse_id, user_id, employee_reference, employee_name_snapshot, employee_no_snapshot,
                  work_date, clock_in_punch_id, clock_out_punch_id, clock_in_at, clock_out_at,
                  gross_minutes, net_minutes, result_status)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'COMPLETE')`,
              [randomUUID(), session.warehouseId, appeal.user_id, appeal.employee_reference, appeal.employee_name_snapshot,
                appeal.employee_no_snapshot, sqlDate(appeal.work_date), inId, outId, clockIn, clockOut,
                calculation.grossMinutes, calculation.netMinutes],
            );
          }
        }
        await connection.execute(
          `UPDATE attendance_appeals SET appeal_status = ?, review_note = ?, reviewed_by_user_id = ?,
             reviewed_by_reference = ?, reviewed_at = CURRENT_TIMESTAMP(3) WHERE id = ?`,
          [decision, reviewNote, session.userId, actor(session), appealId],
        );
        await connection.commit();
        const [rows] = await mysql.execute<AppealRow[]>(`SELECT * FROM attendance_appeals WHERE id = ? LIMIT 1`, [appealId]);
        return toAppeal(rows[0]);
      } catch (error) {
        await connection.rollback().catch(() => undefined);
        throw error;
      } finally { connection.release(); }
    },

    async savePayProfile(session: WarehouseSession, input: Record<string, unknown>) {
      if (!session.warehouseId) throw new ApiError(409, 'WAREHOUSE_SELECTION_REQUIRED', '请先选择仓库。');
      const userId = uuid(input.userId, 'userId');
      const hourlyRate = finiteNumber(input.hourlyRate, 'hourlyRate', 0.01, 100_000)!;
      const effectiveFrom = dateString(input.effectiveFrom, 'effectiveFrom');
      const [employees] = await mysql.execute<EmployeeSnapshotRow[]>(
        `SELECT u.id AS user_id, u.display_name, m.employee_no FROM warehouse_users u
         INNER JOIN warehouse_memberships m ON m.user_id = u.id AND m.warehouse_id = ?
         WHERE u.id = ? LIMIT 1`, [session.warehouseId, userId],
      );
      const employee = employees[0];
      if (!employee) throw new ApiError(404, 'EMPLOYEE_NOT_FOUND', '未找到仓库员工。');
      const reference = `user:${userId}`;
      await mysql.execute(
        `INSERT INTO attendance_pay_profiles
           (id, warehouse_id, user_id, employee_reference, employee_name_snapshot, employee_no_snapshot,
            hourly_rate, effective_from, created_by_user_id, created_by_reference)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE hourly_rate = VALUES(hourly_rate), employee_name_snapshot = VALUES(employee_name_snapshot),
           employee_no_snapshot = VALUES(employee_no_snapshot)`,
        [randomUUID(), session.warehouseId, userId, reference, employee.display_name, employee.employee_no,
          hourlyRate, effectiveFrom, session.userId, actor(session)],
      );
      return { userId, hourlyRate, effectiveFrom };
    },

    async savePayrollAdjustment(session: WarehouseSession, input: Record<string, unknown>) {
      if (!session.warehouseId) throw new ApiError(409, 'WAREHOUSE_SELECTION_REQUIRED', '请先选择仓库。');
      const employeeReference = text(input.employeeReference, 'employeeReference', 64)!;
      const period = range(input.periodStart, input.periodEnd);
      const bonus = finiteNumber(input.bonus ?? 0, 'bonus', 0, 10_000_000)!;
      const fuelDays = finiteNumber(input.fuelDays ?? 0, 'fuelDays', 0, 366)!;
      const note = text(input.note, 'note', 500, false);
      await mysql.execute(
        `INSERT INTO attendance_payroll_adjustments
           (id, warehouse_id, employee_reference, period_start, period_end, bonus, fuel_days, note,
            updated_by_user_id, updated_by_reference)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE bonus = VALUES(bonus), fuel_days = VALUES(fuel_days), note = VALUES(note),
           updated_by_user_id = VALUES(updated_by_user_id), updated_by_reference = VALUES(updated_by_reference)`,
        [randomUUID(), session.warehouseId, employeeReference, period.from, period.to, bonus, Math.round(fuelDays),
          note, session.userId, actor(session)],
      );
      return { employeeReference, periodStart: period.from, periodEnd: period.to, bonus, fuelDays: Math.round(fuelDays), note };
    },

    async calculatePayroll(session: WarehouseSession, filters: { dateFrom?: unknown; dateTo?: unknown }, persist = false) {
      if (!session.warehouseId) throw new ApiError(409, 'WAREHOUSE_SELECTION_REQUIRED', '请先选择仓库。');
      const dates = range(filters.dateFrom, filters.dateTo);
      await materializeDailyResults(session.warehouseId, dates);
      const [dailyRows] = await mysql.execute<DailyRow[]>(
        `SELECT * FROM attendance_daily_results WHERE warehouse_id = ? AND work_date BETWEEN ? AND ?
         ORDER BY employee_reference, work_date`, [session.warehouseId, dates.from, dates.to],
      );
      const references = [...new Set(dailyRows.map(row => row.employee_reference))];
      if (references.length === 0) return { ...dates, rows: [], runId: null,
        rule: { lunchDeductionMinutes: 0, weeklyRegularMinutes: WEEKLY_REGULAR_MINUTES,
          overtimeMultiplier: OVERTIME_MULTIPLIER, fuelAllowancePerDay: FUEL_ALLOWANCE_PER_DAY } };
      const placeholders = references.map(() => '?').join(',');
      const [profiles] = await mysql.execute<(RowDataPacket & { employee_reference: string; user_id: string | null; hourly_rate: number | string })[]>(
        `SELECT p.employee_reference, p.user_id, p.hourly_rate FROM attendance_pay_profiles p
         INNER JOIN (SELECT employee_reference, MAX(effective_from) AS effective_from FROM attendance_pay_profiles
           WHERE warehouse_id = ? AND effective_from <= ? AND employee_reference IN (${placeholders}) GROUP BY employee_reference) latest
           ON latest.employee_reference = p.employee_reference AND latest.effective_from = p.effective_from
         WHERE p.warehouse_id = ?`, [session.warehouseId, dates.to, ...references, session.warehouseId],
      );
      const [adjustments] = await mysql.execute<(RowDataPacket & { employee_reference: string; bonus: number | string; fuel_days: number; note: string | null })[]>(
        `SELECT employee_reference, bonus, fuel_days, note FROM attendance_payroll_adjustments
         WHERE warehouse_id = ? AND period_start = ? AND period_end = ?`, [session.warehouseId, dates.from, dates.to],
      );
      const profileMap = new Map(profiles.map(row => [row.employee_reference, row]));
      const adjustmentMap = new Map(adjustments.map(row => [row.employee_reference, row]));
      const grouped = new Map<string, DailyRow[]>();
      for (const row of dailyRows) (grouped.get(row.employee_reference) ?? grouped.set(row.employee_reference, []).get(row.employee_reference)!).push(row);
      const rows = Array.from(grouped.entries()).map(([reference, days]) => {
        const adjustment = adjustmentMap.get(reference);
        const profile = profileMap.get(reference);
        return { userId: profile?.user_id ?? days[0].user_id, ...calculatePayrollRow({
          employeeReference: reference, employeeName: days[0].employee_name_snapshot,
          employeeNo: days[0].employee_no_snapshot, hourlyRate: profile ? Number(profile.hourly_rate) : null,
          bonus: adjustment ? Number(adjustment.bonus) : 0, fuelDays: adjustment?.fuel_days ?? 0,
          days: days.map(day => ({ workDate: sqlDate(day.work_date), grossMinutes: day.gross_minutes, status: day.result_status })),
        }) };
      });
      let runId: string | null = null;
      const rule = { lunchDeductionMinutes: 0, weeklyRegularMinutes: WEEKLY_REGULAR_MINUTES,
        overtimeMultiplier: OVERTIME_MULTIPLIER, fuelAllowancePerDay: FUEL_ALLOWANCE_PER_DAY };
      if (persist) {
        const blocked = rows.find(row => row.totalPay === null);
        if (blocked) throw new ApiError(409, 'PAYROLL_CALCULATION_BLOCKED', `${blocked.employeeName} 缺少有效基础时薪。`);
        runId = randomUUID();
        const connection = await mysql.getConnection();
        try {
          await connection.beginTransaction();
          await connection.execute(
            `INSERT INTO attendance_payroll_runs
               (id, warehouse_id, period_start, period_end, rule_snapshot, employee_count,
                total_regular_minutes, total_overtime_minutes, total_pay, created_by_user_id, created_by_reference)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [runId, session.warehouseId, dates.from, dates.to, JSON.stringify(rule), rows.length,
              rows.reduce((sum, row) => sum + row.regularMinutes, 0), rows.reduce((sum, row) => sum + row.overtimeMinutes, 0),
              rows.reduce((sum, row) => sum + (row.totalPay ?? 0), 0), session.userId, actor(session)],
          );
          for (const row of rows) {
            await connection.execute(
              `INSERT INTO attendance_payroll_run_rows
                 (id, payroll_run_id, employee_reference, employee_name_snapshot, employee_no_snapshot,
                  hourly_rate, regular_minutes, overtime_minutes, regular_pay, overtime_pay, bonus,
                  fuel_days, fuel_allowance, total_pay, calculation_issues)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              [randomUUID(), runId, row.employeeReference, row.employeeName, row.employeeNo, row.hourlyRate,
                row.regularMinutes, row.overtimeMinutes, row.regularPay, row.overtimePay, row.bonus,
                row.fuelDays, row.fuelAllowance, row.totalPay, JSON.stringify(row.issues)],
            );
          }
          await connection.commit();
        } catch (error) { await connection.rollback().catch(() => undefined); throw error; }
        finally { connection.release(); }
      }
      return { ...dates, rows, runId, rule };
    },

    async purgeExpiredEvidence(limit = 500) {
      const [rows] = await mysql.execute<(RowDataPacket & { photo_storage_key: string })[]>(
        `SELECT DISTINCT photo_storage_key FROM attendance_punch_attempts
         WHERE evidence_delete_after <= CURRENT_TIMESTAMP(3) AND photo_storage_key IS NOT NULL
         ORDER BY photo_storage_key LIMIT ?`, [Math.max(1, Math.min(5000, Math.round(limit)))],
      );
      let purged = 0;
      for (const row of rows) {
        const [active] = await mysql.execute<(RowDataPacket & { count: number })[]>(
          `SELECT COUNT(*) AS count FROM attendance_punch_attempts
           WHERE photo_storage_key = ? AND evidence_delete_after > CURRENT_TIMESTAMP(3)`, [row.photo_storage_key],
        );
        if (Number(active[0]?.count ?? 0) === 0) await storage.remove?.(row.photo_storage_key);
        const [result] = await mysql.execute(
          `UPDATE attendance_punch_attempts
           SET photo_storage_key = NULL, photo_sha256 = NULL, photo_content_type = NULL,
               photo_byte_size = NULL, photo_width = NULL, photo_height = NULL,
               location_latitude = NULL, location_longitude = NULL, location_accuracy_meters = NULL,
               matched_location_id = NULL, distance_meters = NULL,
               gesture_type = NULL, gesture_passed = NULL, gesture_score = NULL,
               client_captured_at = NULL
           WHERE photo_storage_key = ? AND evidence_delete_after <= CURRENT_TIMESTAMP(3)`, [row.photo_storage_key],
        );
        purged += 'affectedRows' in result ? Number(result.affectedRows) : 0;
      }
      return purged;
    },

    async openPunchPhoto(session: WarehouseSession, attemptIdValue: unknown): Promise<{ metadata: PunchPhotoRow; object: LabelStorageObject }> {
      const attemptId = uuid(attemptIdValue, 'attemptId');
      const [rows] = await mysql.execute<PunchPhotoRow[]>(
        `SELECT id, user_id, employee_reference, photo_storage_key, photo_content_type, photo_byte_size
         FROM attendance_punch_attempts WHERE id = ? AND warehouse_id = ? LIMIT 1`, [attemptId, session.warehouseId],
      );
      const metadata = rows[0];
      if (!metadata || !metadata.photo_storage_key || !metadata.photo_content_type) throw new ApiError(404, 'ATTENDANCE_PHOTO_NOT_FOUND', '打卡照片不存在或已到期删除。');
      const canViewTeam = session.platformRole === 'SYSTEM_ADMIN' || session.permissions.includes('attendance.team_view');
      if (!canViewTeam && metadata.user_id !== session.userId) throw new ApiError(403, 'PERMISSION_DENIED', '无权查看该打卡照片。');
      return { metadata, object: await storage.open(metadata.photo_storage_key) };
    },
  };
}

export type AttendanceOperations = ReturnType<typeof createAttendanceOperations>;
