export interface PayrollIssue {
  message: string;
  severity: 'warning' | 'blocking';
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
  issues: PayrollIssue[];
}

export interface PayrollParseResult {
  employees: PayrollEmployeeBase[];
  periodLabel: string;
  parsedRows: number;
}

export type PayrollWorkerResponse =
  | { type: 'success'; result: PayrollParseResult }
  | { type: 'error'; message: string };
