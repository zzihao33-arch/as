import { DEFAULT_BREAK_RULE } from './attendanceCalculations.js';

export type PayrollBreakRule = {
  id: string; employeeReference: string | null; startTime: string; endTime: string; effectiveFrom: string;
};

export function resolvePayrollBreakRule(rules: PayrollBreakRule[], employeeReference: string, date: string) {
  const candidates = rules.filter(rule => rule.effectiveFrom <= date
    && (rule.employeeReference === null || rule.employeeReference === employeeReference));
  candidates.sort((a, b) => Number(b.employeeReference !== null) - Number(a.employeeReference !== null)
    || b.effectiveFrom.localeCompare(a.effectiveFrom) || b.id.localeCompare(a.id));
  const rule = candidates[0];
  return rule ? { id: rule.id, startTime: rule.startTime, endTime: rule.endTime } : DEFAULT_BREAK_RULE;
}
