export const ATTENDANCE_TIME_ZONE = 'America/New_York';
export const LUNCH_DEDUCTION_MINUTES = 60;
export const WEEKLY_REGULAR_MINUTES = 40 * 60;
export const OVERTIME_MULTIPLIER = 1.5;
export const FUEL_ALLOWANCE_PER_DAY = 19.5;
export const MAX_SHIFT_MINUTES = 18 * 60;

export type AttendanceDailyInput = {
  workDate: string;
  clockInAt: Date | null;
  clockOutAt: Date | null;
  scheduledStartMinutes?: number | null;
  scheduledEndMinutes?: number | null;
  lateGraceMinutes?: number;
  earlyGraceMinutes?: number;
};

export type AttendanceDailyCalculation = {
  status: 'OPEN' | 'COMPLETE' | 'MISSING_IN' | 'MISSING_OUT' | 'NEEDS_REVIEW';
  grossMinutes: number;
  netMinutes: number;
  isLate: boolean;
  isEarlyLeave: boolean;
};

export type PayrollDailyInput = {
  workDate: string;
  grossMinutes: number;
  status: string;
  clockInAt?: string | null;
  clockOutAt?: string | null;
  breakRule?: { id: string | null; startTime: string; endTime: string };
};

export const DEFAULT_BREAK_RULE = { id: null, startTime: '12:00', endTime: '13:00' };

export type PayrollDailyCalculation = PayrollDailyInput & {
  breakRule: typeof DEFAULT_BREAK_RULE | { id: string; startTime: string; endTime: string };
  breakMinutes: number;
  netMinutes: number;
  regularMinutes: number;
  overtimeMinutes: number;
  regularPay: number | null;
  overtimePay: number | null;
};

const breakClock = new Intl.DateTimeFormat('en-GB', {
  timeZone: ATTENDANCE_TIME_ZONE, hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});

// Walk real minute boundaries so partial minutes and DST transitions remain correct.
export function calculateBreakOverlap(clockIn: Date, clockOut: Date, rule: NonNullable<PayrollDailyInput['breakRule']> = DEFAULT_BREAK_RULE): number {
  let overlapMs = 0;
  const start = clockIn.getTime();
  const end = clockOut.getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || Math.round((end - start) / 60_000) > MAX_SHIFT_MINUTES) return 0;
  for (let cursor = start; cursor < end;) {
    const next = Math.min(end, (Math.floor(cursor / 60_000) + 1) * 60_000);
    const time = breakClock.format(new Date(cursor));
    if (time >= rule.startTime && time < rule.endTime) overlapMs += next - cursor;
    cursor = next;
  }
  return Math.round(overlapMs / 60_000);
}

export type PayrollCalculationInput = {
  employeeReference: string;
  employeeName: string;
  employeeNo: string | null;
  hourlyRate: number | null;
  bonus: number;
  fuelDays: number;
  days: PayrollDailyInput[];
};

export type PayrollCalculationRow = Omit<PayrollCalculationInput, 'days'> & {
  days: PayrollDailyCalculation[];
  regularMinutes: number;
  overtimeMinutes: number;
  regularPay: number | null;
  overtimePay: number | null;
  fuelAllowance: number;
  totalPay: number | null;
  issues: string[];
  weeklyMinutes: Array<{ week: string; minutes: number }>;
};

const money = (value: number) => Math.round(value * 100) / 100;

export function haversineDistanceMeters(
  latitudeA: number,
  longitudeA: number,
  latitudeB: number,
  longitudeB: number,
): number {
  const radians = (degrees: number) => degrees * Math.PI / 180;
  const earthRadiusMeters = 6_371_000;
  const latitudeDelta = radians(latitudeB - latitudeA);
  const longitudeDelta = radians(longitudeB - longitudeA);
  const a = Math.sin(latitudeDelta / 2) ** 2
    + Math.cos(radians(latitudeA)) * Math.cos(radians(latitudeB)) * Math.sin(longitudeDelta / 2) ** 2;
  return earthRadiusMeters * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export function dateInTimeZone(value: Date, timeZone = ATTENDANCE_TIME_ZONE): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(value);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find(item => item.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')}`;
}

export function minutesInTimeZone(value: Date, timeZone = ATTENDANCE_TIME_ZONE): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(value);
  const hour = Number(parts.find(item => item.type === 'hour')?.value ?? 0) % 24;
  const minute = Number(parts.find(item => item.type === 'minute')?.value ?? 0);
  return hour * 60 + minute;
}

export function calculateDailyAttendance(input: AttendanceDailyInput): AttendanceDailyCalculation {
  if (!input.clockInAt && !input.clockOutAt) {
    return { status: 'NEEDS_REVIEW', grossMinutes: 0, netMinutes: 0, isLate: false, isEarlyLeave: false };
  }
  if (!input.clockInAt) {
    return { status: 'MISSING_IN', grossMinutes: 0, netMinutes: 0, isLate: false, isEarlyLeave: false };
  }
  const clockInMinutes = minutesInTimeZone(input.clockInAt);
  const isLate = input.scheduledStartMinutes != null
    && clockInMinutes > input.scheduledStartMinutes + (input.lateGraceMinutes ?? 0);
  if (!input.clockOutAt) {
    return { status: 'OPEN', grossMinutes: 0, netMinutes: 0, isLate, isEarlyLeave: false };
  }
  const grossMinutes = Math.max(0, Math.round((input.clockOutAt.getTime() - input.clockInAt.getTime()) / 60_000));
  if (grossMinutes <= 0 || grossMinutes > MAX_SHIFT_MINUTES) {
    return { status: 'NEEDS_REVIEW', grossMinutes, netMinutes: 0, isLate, isEarlyLeave: false };
  }
  const clockOutMinutes = minutesInTimeZone(input.clockOutAt);
  const isEarlyLeave = input.scheduledEndMinutes != null
    && clockOutMinutes < input.scheduledEndMinutes - (input.earlyGraceMinutes ?? 0);
  return {
    status: 'COMPLETE',
    grossMinutes,
    netMinutes: Math.max(0, grossMinutes - calculateBreakOverlap(input.clockInAt, input.clockOutAt)),
    isLate,
    isEarlyLeave,
  };
}

function mondayOf(workDate: string): string {
  const date = new Date(`${workDate}T12:00:00Z`);
  const day = date.getUTCDay();
  const offset = day === 0 ? -6 : 1 - day;
  date.setUTCDate(date.getUTCDate() + offset);
  return date.toISOString().slice(0, 10);
}

export function calculatePayrollRow(input: PayrollCalculationInput): PayrollCalculationRow {
  const weekly = new Map<string, number>();
  const issues: string[] = [];
  const validRate = input.hourlyRate != null && Number.isFinite(input.hourlyRate) && input.hourlyRate > 0;
  let runningRegular = 0;
  let runningOvertime = 0;
  const days: PayrollDailyCalculation[] = [];
  for (const day of [...input.days].sort((a, b) => a.workDate.localeCompare(b.workDate))) {
    const detail: PayrollDailyCalculation = { ...day, breakRule: day.breakRule ?? DEFAULT_BREAK_RULE,
      breakMinutes: 0, netMinutes: 0, regularMinutes: 0, overtimeMinutes: 0,
      regularPay: validRate ? 0 : null, overtimePay: validRate ? 0 : null };
    days.push(detail);
    if (day.status !== 'COMPLETE') {
      issues.push(`${day.workDate} 考勤状态为 ${day.status}`);
      continue;
    }
    const start = new Date(day.clockInAt ?? '');
    const end = new Date(day.clockOutAt ?? '');
    const elapsed = Math.round((end.getTime() - start.getTime()) / 60_000);
    if (!Number.isFinite(elapsed) || elapsed <= 0 || elapsed > MAX_SHIFT_MINUTES) {
      issues.push(`${day.workDate} 上下班时间缺失或无效`);
      continue;
    }
    detail.grossMinutes = elapsed;
    detail.breakMinutes = calculateBreakOverlap(start, end, detail.breakRule);
    detail.netMinutes = Math.max(0, elapsed - detail.breakMinutes);
    const week = mondayOf(day.workDate);
    const previous = weekly.get(week) ?? 0;
    detail.regularMinutes = Math.min(detail.netMinutes, Math.max(0, WEEKLY_REGULAR_MINUTES - previous));
    detail.overtimeMinutes = detail.netMinutes - detail.regularMinutes;
    // Allocate rounding differences cumulatively so daily wages reconcile to the summary.
    if (validRate) {
      detail.regularPay = money(money((runningRegular + detail.regularMinutes) / 60 * input.hourlyRate!) - money(runningRegular / 60 * input.hourlyRate!));
      detail.overtimePay = money(money((runningOvertime + detail.overtimeMinutes) / 60 * input.hourlyRate! * OVERTIME_MULTIPLIER) - money(runningOvertime / 60 * input.hourlyRate! * OVERTIME_MULTIPLIER));
    }
    runningRegular += detail.regularMinutes;
    runningOvertime += detail.overtimeMinutes;
    weekly.set(week, previous + detail.netMinutes);
  }
  let regularMinutes = 0;
  let overtimeMinutes = 0;
  const weeklyMinutes = Array.from(weekly.entries()).sort(([a], [b]) => a.localeCompare(b)).map(([week, minutes]) => {
    regularMinutes += Math.min(minutes, WEEKLY_REGULAR_MINUTES);
    overtimeMinutes += Math.max(0, minutes - WEEKLY_REGULAR_MINUTES);
    return { week, minutes };
  });
  const fuelAllowance = money(Math.max(0, input.fuelDays) * FUEL_ALLOWANCE_PER_DAY);
  if (!validRate) issues.push('缺少有效基础时薪');
  const regularPay = validRate ? money(regularMinutes / 60 * input.hourlyRate!) : null;
  const overtimePay = validRate ? money(overtimeMinutes / 60 * input.hourlyRate! * OVERTIME_MULTIPLIER) : null;
  return {
    ...input,
    days,
    regularMinutes,
    overtimeMinutes,
    regularPay,
    overtimePay,
    fuelAllowance,
    totalPay: regularPay == null || overtimePay == null
      ? null
      : money(regularPay + overtimePay + Math.max(0, input.bonus) + fuelAllowance),
    issues,
    weeklyMinutes,
  };
}
