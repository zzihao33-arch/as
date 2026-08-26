export interface PayrollIssue {
  message: string;
  severity: 'warning' | 'blocking';
}

export interface PayrollWeekRange {
  week: string;
}

export interface PayrollAttendanceDetail {
  date: string;
  hours: number;
  start: string;
  end: string;
}

export interface PayrollEmployeeBase {
  id: string;
  name: string;
  baseRate: number | null;
  bonus?: number;
  fuelDays?: number;
  regularHours: number;
  overtimeHours: number;
  attendanceDays: number;
  weeklyHours: Array<{ week: string; hours: number }>;
  attendanceDetails?: PayrollAttendanceDetail[];
  issues: PayrollIssue[];
}

export interface PayrollParseResult {
  employees: PayrollEmployeeBase[];
  weeks: PayrollWeekRange[];
  periodLabel: string;
  parsedRows: number;
}

export type PayrollWorkerResponse =
  | { type: 'success'; result: PayrollParseResult }
  | { type: 'error'; message: string };
