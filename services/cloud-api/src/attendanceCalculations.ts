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
  netMinutes: number;
  status: string;
};

export type PayrollCalculationInput = {
  employeeReference: string;
  employeeName: string;
  employeeNo: string | null;
  hourlyRate: number | null;
  bonus: number;
  fuelDays: number;
  days: PayrollDailyInput[];
};

export type PayrollCalculationRow = PayrollCalculationInput & {
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
    netMinutes: Math.max(0, grossMinutes - LUNCH_DEDUCTION_MINUTES),
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
  for (const day of input.days) {
    if (day.status !== 'COMPLETE') {
      issues.push(`${day.workDate} 考勤状态为 ${day.status}`);
      continue;
    }
    const week = mondayOf(day.workDate);
    weekly.set(week, (weekly.get(week) ?? 0) + Math.max(0, Math.round(day.netMinutes)));
  }
  let regularMinutes = 0;
  let overtimeMinutes = 0;
  const weeklyMinutes = Array.from(weekly.entries()).sort(([a], [b]) => a.localeCompare(b)).map(([week, minutes]) => {
    regularMinutes += Math.min(minutes, WEEKLY_REGULAR_MINUTES);
    overtimeMinutes += Math.max(0, minutes - WEEKLY_REGULAR_MINUTES);
    return { week, minutes };
  });
  const fuelAllowance = money(Math.max(0, input.fuelDays) * FUEL_ALLOWANCE_PER_DAY);
  const validRate = input.hourlyRate != null && Number.isFinite(input.hourlyRate) && input.hourlyRate > 0;
  if (!validRate) issues.push('缺少有效基础时薪');
  const regularPay = validRate ? money(regularMinutes / 60 * input.hourlyRate!) : null;
  const overtimePay = validRate ? money(overtimeMinutes / 60 * input.hourlyRate! * OVERTIME_MULTIPLIER) : null;
  return {
    ...input,
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
