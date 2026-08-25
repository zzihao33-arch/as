import * as XLSX from 'xlsx';
import type { PayrollEmployeeBase, PayrollIssue, PayrollParseResult, PayrollWorkerResponse } from './payrollTypes';

type SheetRow = unknown[];

interface MonthlyTimeSheetTemplate {
  dayHeaderRowIndex: number;
  year: number;
  month: number;
  columns: Array<{ columnIndex: number; day: number; date: Date }>;
}

const RATE_PATTERN = /\$?\s*(\d+(?:\.\d+)?)\s*(?:\/\s*h(?:our)?|per\s*hour|时薪)/i;
const TIME_PATTERN = /(?:^|\s)(\d{1,2})(?::(\d{2}))?\s*(AM|PM)?(?:\s|$)/i;

function cellText(value: unknown) {
  return String(value ?? '').trim();
}

function toDate(value: unknown): Date | null {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return new Date(value.getFullYear(), value.getMonth(), value.getDate());
  }

  if (typeof value === 'number' && value > 1) {
    const dateCode = XLSX.SSF.parse_date_code(value);
    if (dateCode?.y && dateCode.m && dateCode.d) {
      return new Date(dateCode.y, dateCode.m - 1, dateCode.d);
    }
  }

  const text = cellText(value);
  if (!text || /^\d{1,2}:\d{2}/.test(text)) return null;
  const numericDate = text.match(/^(\d{4})[\-/](\d{1,2})[\-/](\d{1,2})$/);
  if (numericDate) {
    return new Date(Number(numericDate[1]), Number(numericDate[2]) - 1, Number(numericDate[3]));
  }
  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) return null;
  return new Date(parsed.getFullYear(), parsed.getMonth(), parsed.getDate());
}

function toTimeMinutes(value: unknown): number | null {
  if (typeof value === 'number') {
    const dayFraction = value % 1;
    if (dayFraction >= 0 && dayFraction < 1) return Math.round(dayFraction * 24 * 60);
  }

  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.getHours() * 60 + value.getMinutes();
  }

  const match = cellText(value).match(TIME_PATTERN);
  if (!match) return null;

  let hours = Number(match[1]);
  const minutes = Number(match[2] || 0);
  const meridiem = match[3]?.toUpperCase();
  if (minutes > 59 || hours > 23) return null;
  if (meridiem === 'PM' && hours < 12) hours += 12;
  if (meridiem === 'AM' && hours === 12) hours = 0;
  return hours * 60 + minutes;
}

function formatDate(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function toNonNegativeNumber(value: unknown) {
  const parsed = typeof value === 'number' ? value : Number(cellText(value));
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function mondayOf(date: Date) {
  const copy = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const day = copy.getDay() || 7;
  copy.setDate(copy.getDate() - day + 1);
  return copy;
}

function findDateColumns(rows: SheetRow[]) {
  for (let rowIndex = 0; rowIndex < Math.min(rows.length, 16); rowIndex += 1) {
    const columns = rows[rowIndex]
      .map((cell, columnIndex) => ({ columnIndex, date: toDate(cell) }))
      .filter((entry): entry is { columnIndex: number; date: Date } => entry.date !== null);
    if (columns.length >= 2) return { rowIndex, columns };
  }
  return null;
}

function extractRate(...rows: SheetRow[]) {
  for (const row of rows) {
    for (const cell of row) {
      const match = cellText(cell).match(RATE_PATTERN);
      if (match) return Number(match[1]);
    }
  }
  return null;
}

function cleanName(value: string) {
  return value
    .replace(RATE_PATTERN, '')
    .replace(/(?:基础时薪|时薪|工资|rate)\s*[:：]?/gi, '')
    .replace(/\s*[（(]\s*离职\s*[)）]\s*$/i, '')
    .replace(/[|｜]+/g, ' ')
    .trim();
}

function extractName(rows: SheetRow[], dateColumnStart: number, fallbackIndex: number) {
  const candidateCells = rows.flatMap(row => row.slice(0, Math.max(dateColumnStart, 1)));
  for (const cell of candidateCells) {
    const raw = cellText(cell);
    if (!raw || RATE_PATTERN.test(raw) && cleanName(raw).length === 0) continue;
    if (toTimeMinutes(raw) !== null || toDate(raw) !== null) continue;
    const name = cleanName(raw);
    if (name && !/^(姓名|name|上班|下班|in|out)$/i.test(name)) return name;
  }
  return `员工 ${fallbackIndex}`;
}

function findYearMonth(sheetName: string, rows: SheetRow[]) {
  const candidates = [sheetName, ...rows.slice(0, 12).flatMap(row => row.map(cellText))];
  for (const candidate of candidates) {
    const match = candidate.match(/((?:19|20)\d{2})\s*[年.\-/]\s*(1[0-2]|0?[1-9])(?:\s*月)?/);
    if (match) return { year: Number(match[1]), month: Number(match[2]) };
  }
  return null;
}

function findMonthlyTimeSheetTemplate(sheetName: string, rows: SheetRow[]): MonthlyTimeSheetTemplate | null {
  const yearMonth = findYearMonth(sheetName, rows);
  if (!yearMonth) return null;

  for (let rowIndex = 0; rowIndex < Math.min(rows.length, 16); rowIndex += 1) {
    const dayColumns = rows[rowIndex]
      .map((cell, columnIndex) => ({ columnIndex, day: typeof cell === 'number' && Number.isInteger(cell) ? cell : Number.NaN }))
      .filter((entry) => entry.day >= 1 && entry.day <= 31);

    if (dayColumns.length < 7) continue;

    const columns = dayColumns
      .filter(({ day }) => day <= new Date(yearMonth.year, yearMonth.month, 0).getDate())
      .map(({ columnIndex, day }) => ({ columnIndex, day, date: new Date(yearMonth.year, yearMonth.month - 1, day) }));

    if (columns.length >= 7) return { dayHeaderRowIndex: rowIndex, ...yearMonth, columns };
  }

  return null;
}

function findSummaryColumn(row: SheetRow, matcher: RegExp) {
  const columnIndex = row.findIndex(cell => matcher.test(cellText(cell)));
  return columnIndex >= 0 ? columnIndex : null;
}

function isOilAllowanceCell(sheet: XLSX.WorkSheet, rowIndex: number, columnIndex: number) {
  const cellAddress = XLSX.utils.encode_cell({ r: rowIndex, c: columnIndex });
  const cell = sheet[cellAddress] as { s?: { fgColor?: { rgb?: string }; bgColor?: { rgb?: string } } } | undefined;
  const rawColor = cell?.s?.fgColor?.rgb || cell?.s?.bgColor?.rgb || '';
  const color = rawColor.replace(/^#/, '').slice(-6);
  if (!/^[0-9A-Fa-f]{6}$/.test(color)) return false;

  const red = Number.parseInt(color.slice(0, 2), 16);
  const green = Number.parseInt(color.slice(2, 4), 16);
  const blue = Number.parseInt(color.slice(4, 6), 16);
  // CM's current oil allowance spray colour is the highlighted yellow used in
  // orange/yellow range so the workflow survives small template colour edits.
  return red >= 210 && green >= 130 && blue <= 110 && red >= green;
}

function parseMonthlyTimeSheet(rows: SheetRow[], template: MonthlyTimeSheetTemplate, sheet: XLSX.WorkSheet): PayrollParseResult {
  const employees: PayrollEmployeeBase[] = [];
  const dateColumnStart = Math.min(...template.columns.map(entry => entry.columnIndex));
  const firstEmployeeRowIndex = template.dayHeaderRowIndex + 2;
  const summaryHeader = rows[template.dayHeaderRowIndex + 1] || [];
  const bonusColumnIndex = findSummaryColumn(summaryHeader, /奖金/);
  const fuelDaysColumnIndex = findSummaryColumn(summaryHeader, /油补/);

  for (let rowIndex = firstEmployeeRowIndex, employeeIndex = 1; rowIndex < rows.length; rowIndex += 2, employeeIndex += 1) {
    const clockInRow = rows[rowIndex] || [];
    const clockOutRow = rows[rowIndex + 1] || [];
    const name = extractName([clockInRow], dateColumnStart, employeeIndex);
    const rate = extractRate(clockInRow, clockOutRow);
    const hasPunch = template.columns.some(({ columnIndex }) => (
      toTimeMinutes(clockInRow[columnIndex]) !== null || toTimeMinutes(clockOutRow[columnIndex]) !== null
    ));

    // The CM template uses the first columns for sequence number, nickname, real name and wage.
    // A row without a nickname is an unused template line, not an employee record.
    if (!cellText(clockInRow[1]) && !cellText(clockInRow[2])) continue;
    if (!hasPunch && rate === null) continue;

    const issues: PayrollIssue[] = [];
    const weeklyHourMap = new Map<string, number>();
    const highlightedOilDays = new Set<number>();
    let attendanceDays = 0;

    for (const { columnIndex, date } of template.columns) {
      const start = toTimeMinutes(clockInRow[columnIndex]);
      const end = toTimeMinutes(clockOutRow[columnIndex]);
      if (start === null && end === null) continue;

      if (
        isOilAllowanceCell(sheet, rowIndex, columnIndex)
        || isOilAllowanceCell(sheet, rowIndex + 1, columnIndex)
      ) {
        highlightedOilDays.add(date.getDate());
      }

      if (start === null || end === null) {
        issues.push({ message: `${formatDate(date)} 缺少${start === null ? '上班' : '下班'}打卡`, severity: 'warning' });
        continue;
      }

      let workedMinutes = end - start;
      if (workedMinutes <= 0) workedMinutes += 24 * 60;
      const netHours = Math.max(0, workedMinutes / 60 - 1);
      if (netHours === 0) {
        issues.push({ message: `${formatDate(date)} 打卡时长不足以扣除 1 小时午休`, severity: 'warning' });
      }

      attendanceDays += 1;
      const week = formatDate(mondayOf(date));
      weeklyHourMap.set(week, (weeklyHourMap.get(week) || 0) + netHours);
    }

    if (rate === null || rate <= 0) {
      issues.push({ message: '缺少基础时薪，需补充后才能导出薪酬', severity: 'blocking' });
    }

    const weeklyHours = Array.from(weeklyHourMap.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([week, hours]) => ({ week, hours: Math.round(hours * 100) / 100 }));
    const regularHours = weeklyHours.reduce((total, week) => total + Math.min(week.hours, 40), 0);
    const overtimeHours = weeklyHours.reduce((total, week) => total + Math.max(week.hours - 40, 0), 0);
    const bonus = bonusColumnIndex === null ? 0 : (toNonNegativeNumber(clockInRow[bonusColumnIndex]) ?? 0);
    const reportedFuelDays = fuelDaysColumnIndex === null ? null : toNonNegativeNumber(clockInRow[fuelDaysColumnIndex]);

    employees.push({
      id: `employee-${rowIndex}-${name}`,
      name,
      baseRate: rate,
      bonus,
      fuelDays: reportedFuelDays ?? highlightedOilDays.size,
      regularHours: Math.round(regularHours * 100) / 100,
      overtimeHours: Math.round(overtimeHours * 100) / 100,
      attendanceDays,
      weeklyHours,
      issues
    });
  }

  if (employees.length === 0) {
    throw new Error('未解析到 CM 考勤模板中的员工打卡记录。');
  }

  return {
    employees,
    periodLabel: `${formatDate(new Date(template.year, template.month - 1, 1))} 至 ${formatDate(new Date(template.year, template.month, 0))}`,
    parsedRows: rows.length
  };
}

export function parseWorkbook(buffer: ArrayBuffer): PayrollParseResult {
  const workbook = XLSX.read(buffer, { type: 'array', cellDates: true, cellStyles: true });
  const monthlySheet = workbook.SheetNames
    .map(sheetName => ({
      sheetName,
      sheet: workbook.Sheets[sheetName],
      rows: XLSX.utils.sheet_to_json<SheetRow>(workbook.Sheets[sheetName], { header: 1, defval: '', raw: true })
    }))
    .map(entry => ({ ...entry, template: findMonthlyTimeSheetTemplate(entry.sheetName, entry.rows) }))
    .find((entry): entry is { sheetName: string; sheet: XLSX.WorkSheet; rows: SheetRow[]; template: MonthlyTimeSheetTemplate } => entry.template !== null);

  if (monthlySheet) return parseMonthlyTimeSheet(monthlySheet.rows, monthlySheet.template, monthlySheet.sheet);

  const sheetName = workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];
  if (!sheet) throw new Error('未找到考勤工作表。');

  const rows = XLSX.utils.sheet_to_json<SheetRow>(sheet, { header: 1, defval: '', raw: true });
  const dateHeader = findDateColumns(rows);
  if (!dateHeader) {
    throw new Error('无法识别考勤日期表头。请确保模板中包含至少两列日期。');
  }

  const dateColumnStart = Math.min(...dateHeader.columns.map(entry => entry.columnIndex));
  const employees: PayrollEmployeeBase[] = [];

  for (let rowIndex = dateHeader.rowIndex + 1, employeeIndex = 1; rowIndex < rows.length; rowIndex += 2, employeeIndex += 1) {
    const clockInRow = rows[rowIndex] || [];
    const clockOutRow = rows[rowIndex + 1] || [];
    const hasPunch = dateHeader.columns.some(({ columnIndex }) => (
      toTimeMinutes(clockInRow[columnIndex]) !== null || toTimeMinutes(clockOutRow[columnIndex]) !== null
    ));
    const rate = extractRate(clockInRow, clockOutRow);
    const name = extractName([clockInRow, clockOutRow], dateColumnStart, employeeIndex);

    if (!hasPunch && rate === null && name.startsWith('员工 ')) continue;

    const issues: PayrollIssue[] = [];
    const weeklyHourMap = new Map<string, number>();
    let attendanceDays = 0;

    for (const { columnIndex, date } of dateHeader.columns) {
      const start = toTimeMinutes(clockInRow[columnIndex]);
      const end = toTimeMinutes(clockOutRow[columnIndex]);
      if (start === null && end === null) continue;

      if (start === null || end === null) {
        issues.push({ message: `${formatDate(date)} 缺少${start === null ? '上班' : '下班'}打卡`, severity: 'warning' });
        continue;
      }

      let workedMinutes = end - start;
      if (workedMinutes <= 0) workedMinutes += 24 * 60;
      const netHours = Math.max(0, workedMinutes / 60 - 1);
      if (netHours === 0) {
        issues.push({ message: `${formatDate(date)} 打卡时长不足以扣除 1 小时午休`, severity: 'warning' });
      }

      attendanceDays += 1;
      const week = formatDate(mondayOf(date));
      weeklyHourMap.set(week, (weeklyHourMap.get(week) || 0) + netHours);
    }

    if (rate === null || rate <= 0) {
      issues.push({ message: '缺少基础时薪，需补充后才能导出薪酬', severity: 'blocking' });
    }

    const weeklyHours = Array.from(weeklyHourMap.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([week, hours]) => ({ week, hours: Math.round(hours * 100) / 100 }));
    const regularHours = weeklyHours.reduce((total, week) => total + Math.min(week.hours, 40), 0);
    const overtimeHours = weeklyHours.reduce((total, week) => total + Math.max(week.hours - 40, 0), 0);

    employees.push({
      id: `employee-${rowIndex}-${name}`,
      name,
      baseRate: rate,
      regularHours: Math.round(regularHours * 100) / 100,
      overtimeHours: Math.round(overtimeHours * 100) / 100,
      attendanceDays,
      weeklyHours,
      issues
    });
  }

  if (employees.length === 0) {
    throw new Error('未解析到员工考勤。请确认每位员工由连续两行上班/下班记录组成。');
  }

  const sortedDates = dateHeader.columns.map(entry => entry.date).sort((a, b) => a.getTime() - b.getTime());
  return {
    employees,
    periodLabel: `${formatDate(sortedDates[0])} 至 ${formatDate(sortedDates[sortedDates.length - 1])}`,
    parsedRows: rows.length
  };
}

if (typeof self !== 'undefined') {
  self.onmessage = (event: MessageEvent<{ type: 'parse'; buffer: ArrayBuffer }>) => {
    try {
      if (event.data.type !== 'parse') return;
      const result = parseWorkbook(event.data.buffer);
      const response: PayrollWorkerResponse = { type: 'success', result };
      self.postMessage(response);
    } catch (error) {
      const response: PayrollWorkerResponse = {
        type: 'error',
        message: error instanceof Error ? error.message : '考勤文件解析失败。'
      };
      self.postMessage(response);
    }
  };
}
