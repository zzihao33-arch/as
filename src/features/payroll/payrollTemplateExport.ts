import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import * as XLSX from 'xlsx';
import type { PayrollEmployeeBase, PayrollWeekRange } from './payrollTypes';
import type { AttendancePayrollDay } from '../session/warehouseApi';

const WEEK_COLUMN_KEYS = ['E', 'F', 'G', 'H', 'I', 'J'] as const;
const CURRENCY_COLUMN_KEYS = new Set(['C', 'M', 'N', 'O', 'Q', 'R']);

export interface PayrollTemplateExportRow extends PayrollEmployeeBase {
  dailyDetails?: AttendancePayrollDay[];
  bonus: number;
  fuelDays: number;
  regularPay: number;
  overtimePay: number;
  fuelAllowance: number;
  totalPay: number;
}

export interface PayrollTemplateExportOptions {
  periodLabel: string;
  dateFrom?: string;
  dateTo?: string;
  weeks: PayrollWeekRange[];
  rows: PayrollTemplateExportRow[];
}

const PAYROLL_TEMPLATE_STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <numFmts count="2"><numFmt numFmtId="164" formatCode="&quot;$&quot;#,##0.00"/><numFmt numFmtId="165" formatCode="0.00"/></numFmts>
  <fonts count="6">
    <font><sz val="10"/><color rgb="FF1F2937"/><name val="Microsoft YaHei"/><family val="2"/></font>
    <font><b/><sz val="16"/><color rgb="FF2C3E50"/><name val="Microsoft YaHei"/><family val="2"/></font>
    <font><i/><sz val="9"/><color rgb="FF555555"/><name val="Microsoft YaHei"/><family val="2"/></font>
    <font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Microsoft YaHei"/><family val="2"/></font>
    <font><b/><sz val="10"/><color rgb="FF1F2937"/><name val="Microsoft YaHei"/><family val="2"/></font>
    <font><b/><sz val="10"/><color rgb="FFB36B00"/><name val="Microsoft YaHei"/><family val="2"/></font>
  </fonts>
  <fills count="5">
    <fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FFFFFFFF"/><bgColor indexed="64"/></patternFill></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FF1F4E78"/><bgColor indexed="64"/></patternFill></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FFF9FAFB"/><bgColor indexed="64"/></patternFill></fill>
  </fills>
  <borders count="3">
    <border><left/><right/><top/><bottom/><diagonal/></border>
    <border><left style="thin"><color rgb="FFD9D9D9"/></left><right style="thin"><color rgb="FFD9D9D9"/></right><top style="thin"><color rgb="FFD9D9D9"/></top><bottom style="thin"><color rgb="FFD9D9D9"/></bottom><diagonal/></border>
    <border><left style="thin"><color rgb="FF1F4E78"/></left><right style="thin"><color rgb="FF1F4E78"/></right><top style="medium"><color rgb="FF1F4E78"/></top><bottom style="double"><color rgb="FF1F4E78"/></bottom><diagonal/></border>
  </borders>
  <cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
  <cellXfs count="18">
    <xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
    <xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
    <xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
    <xf numFmtId="0" fontId="3" fillId="3" borderId="1" xfId="0" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>
    <xf numFmtId="0" fontId="0" fillId="2" borderId="1" xfId="0" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
    <xf numFmtId="0" fontId="4" fillId="2" borderId="1" xfId="0" applyAlignment="1"><alignment horizontal="left" vertical="center"/></xf>
    <xf numFmtId="0" fontId="0" fillId="2" borderId="1" xfId="0" applyAlignment="1"><alignment horizontal="left" vertical="center" wrapText="1"/></xf>
    <xf numFmtId="164" fontId="0" fillId="2" borderId="1" xfId="0" applyAlignment="1" applyNumberFormat="1"><alignment horizontal="center" vertical="center"/></xf>
    <xf numFmtId="0" fontId="0" fillId="4" borderId="1" xfId="0" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
    <xf numFmtId="0" fontId="4" fillId="4" borderId="1" xfId="0" applyAlignment="1"><alignment horizontal="left" vertical="center"/></xf>
    <xf numFmtId="0" fontId="0" fillId="4" borderId="1" xfId="0" applyAlignment="1"><alignment horizontal="left" vertical="center" wrapText="1"/></xf>
    <xf numFmtId="164" fontId="0" fillId="4" borderId="1" xfId="0" applyAlignment="1" applyNumberFormat="1"><alignment horizontal="center" vertical="center"/></xf>
    <xf numFmtId="165" fontId="4" fillId="2" borderId="2" xfId="0" applyAlignment="1" applyNumberFormat="1"><alignment horizontal="center" vertical="center"/></xf>
    <xf numFmtId="164" fontId="4" fillId="2" borderId="2" xfId="0" applyAlignment="1" applyNumberFormat="1"><alignment horizontal="center" vertical="center"/></xf>
    <xf numFmtId="0" fontId="5" fillId="2" borderId="1" xfId="0" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>
    <xf numFmtId="0" fontId="4" fillId="2" borderId="1" xfId="0" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>
    <xf numFmtId="165" fontId="0" fillId="2" borderId="1" xfId="0" applyAlignment="1" applyNumberFormat="1"><alignment horizontal="center" vertical="center"/></xf>
    <xf numFmtId="165" fontId="0" fillId="4" borderId="1" xfId="0" applyAlignment="1" applyNumberFormat="1"><alignment horizontal="center" vertical="center"/></xf>
  </cellXfs>
  <cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
  <dxfs count="0"/><tableStyles count="0" defaultTableStyle="TableStyleMedium9" defaultPivotStyle="PivotStyleMedium4"/>
</styleSheet>`;

const asAmount = (value: number) => Math.round(value * 100) / 100;

const formatHours = (value: number) => asAmount(value).toFixed(2).replace(/\.00$/, '').replace(/(\.\d)0$/, '$1');

const parseIsoDate = (value: string) => {
  const [year, month, day] = value.split('-').map(Number);
  return year && month && day ? new Date(year, month - 1, day) : null;
};

const formatMonthDay = (value: string) => {
  const date = parseIsoDate(value);
  return date ? `${date.getMonth() + 1}/${date.getDate()}` : value;
};

const formatExportTitle = (periodLabel: string) => {
  const match = periodLabel.match(/(\d{4})-(\d{2})/);
  return match ? `${match[1]}年${Number(match[2])}月 员工考勤及工时统计表` : '员工考勤及工时统计表';
};

const formatWeekHeader = (week: PayrollWeekRange | undefined, index: number) => {
  if (!week) return `第${index + 1}周\n—`;
  const start = parseIsoDate(week.week);
  if (!start) return `第${index + 1}周\n${week.week}`;
  const end = new Date(start);
  end.setDate(end.getDate() + 6);
  return `第${index + 1}周\n${formatMonthDay(week.week)}~${end.getMonth() + 1}/${end.getDate()}`;
};

const formatAttendanceDetails = (row: PayrollTemplateExportRow, weeks: PayrollWeekRange[]) => {
  if (row.attendanceDetails?.length) {
    return row.attendanceDetails
      .map(detail => `${formatMonthDay(detail.date).replace(/^\d+\//, '')}日: ${formatHours(detail.hours)}h (${detail.start}-${detail.end})`)
      .join('\n');
  }

  return weeks
    .map((week, index) => {
      const hours = row.weeklyHours.find(item => item.week === week.week)?.hours ?? 0;
      return hours > 0 ? `第${index + 1}周 ${formatMonthDay(week.week)}: ${formatHours(hours)}h` : '';
    })
    .filter(Boolean)
    .join('\n');
};

const getCellStyle = (column: string, rowNumber: number, totalRowNumber: number, issueRows: Set<number>) => {
  if (rowNumber === 1) return 1;
  if (rowNumber === 2) return 2;
  if (rowNumber === 3) return 3;
  if (rowNumber === totalRowNumber) return CURRENCY_COLUMN_KEYS.has(column) ? 13 : 12;

  const alternate = (rowNumber - 4) % 2 === 1;
  if (column === 'B') return alternate ? 9 : 5;
  if (column === 'D') return alternate ? 10 : 6;
  if (column === 'S') return issueRows.has(rowNumber) ? 14 : 15;
  if (CURRENCY_COLUMN_KEYS.has(column)) return alternate ? 11 : 7;
  if (['E', 'F', 'G', 'H', 'I', 'J', 'K', 'L'].includes(column)) return alternate ? 17 : 16;
  return alternate ? 8 : 4;
};

const applyTemplateStyles = (workbookBytes: ArrayBuffer, totalRowNumber: number, issueRows: Set<number>) => {
  const archive = unzipSync(new Uint8Array(workbookBytes));
  const sheetPath = 'xl/worksheets/sheet1.xml';
  const sheet = strFromU8(archive[sheetPath]);
  archive['xl/styles.xml'] = strToU8(PAYROLL_TEMPLATE_STYLES);
  archive[sheetPath] = strToU8(sheet.replace(/<c r="([A-Z]+)(\d+)"/g, (_match, column: string, rawRow: string) => {
    const rowNumber = Number(rawRow);
    return `<c r="${column}${rawRow}" s="${getCellStyle(column, rowNumber, totalRowNumber, issueRows)}"`;
  }));
  const dailyPath = 'xl/worksheets/sheet2.xml';
  if (archive[dailyPath]) {
    archive[dailyPath] = strToU8(strFromU8(archive[dailyPath]).replace(/<c r="([A-Z]+)(\d+)"(?: s="\d+")?/g, (_match, column: string, rawRow: string) => {
      const row = Number(rawRow);
      const style = row === 1 ? 1 : row === 2 ? 2 : row === 3 ? 3
        : ['M', 'N', 'O', 'P'].includes(column) ? 7 : ['G', 'J', 'K', 'L'].includes(column) ? 16 : 4;
      return `<c r="${column}${rawRow}" s="${style}"`;
    }));
  }
  return zipSync(archive, { level: 6 });
};

function createDailySheet(options: PayrollTemplateExportOptions) {
  const clock = new Intl.DateTimeFormat('en-GB', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const formatPunch = (value: string | null | undefined, workDate: string) => {
    if (!value) return '';
    const instant = new Date(value);
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(instant);
    const part = (type: string) => parts.find(item => item.type === type)?.value;
    const date = `${part('year')}-${part('month')}-${part('day')}`;
    return `${date === workDate ? '' : `${date} `}${clock.format(instant)}`;
  };
  const dates: string[] = [];
  if (options.dateFrom && options.dateTo) {
    for (const date = new Date(`${options.dateFrom}T12:00:00Z`); date.toISOString().slice(0, 10) <= options.dateTo; date.setUTCDate(date.getUTCDate() + 1)) {
      dates.push(date.toISOString().slice(0, 10));
      if (dates.length > 90) throw new Error('每日明细导出最多支持 90 天。');
    }
  }
  const values: Array<Array<string | number>> = [
    [`每日上班明细 · ${options.periodLabel}`],
    ['America/New_York · 只扣出勤与休息时段重叠的分钟；工资按未舍入工时计算，每日工资尾差按累计金额分配。奖金和油补见汇总。'],
    ['姓名', '员工标识', '日期', '星期', '上班时间', '下班时间', '出勤小时', '休息时段', '扣除分钟', '计薪小时', '正常小时', 'OT小时', '时薪', '正常工资', '加班工资', '当日工资', '考勤状态'],
  ];
  for (const row of options.rows) {
    if (!row.dailyDetails?.length) throw new Error(`${row.name} 缺少每日明细，请更新服务端并重新计算。`);
    const byDate = new Map(row.dailyDetails.map(day => [day.workDate, day]));
    for (const date of dates.length ? dates : [...byDate.keys()].sort()) {
      const day = byDate.get(date);
      const weekday = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][new Date(`${date}T12:00:00Z`).getUTCDay()];
      if (!day) { values.push([row.name, row.id, date, weekday, '', '', '', '', '', '', '', '', '', '', '', '', '无记录']); continue; }
      if (!day.breakRule || [day.netMinutes, day.breakMinutes, day.regularMinutes, day.overtimeMinutes, day.regularPay, day.overtimePay].some(value => value == null || !Number.isFinite(value))) {
        throw new Error(`${row.name} ${date} 计薪明细不完整，请重新计算。`);
      }
      values.push([row.name, row.id, date, weekday, formatPunch(day.clockInAt, date), formatPunch(day.clockOutAt, date),
        day.grossMinutes / 60, `${day.breakRule.startTime}–${day.breakRule.endTime}`, day.breakMinutes!, day.netMinutes! / 60,
        day.regularMinutes! / 60, day.overtimeMinutes! / 60, row.baseRate ?? '', day.regularPay!, day.overtimePay!,
        asAmount(day.regularPay! + day.overtimePay!), day.status === 'COMPLETE' ? '完整' : day.status]);
    }
  }
  const sheet = XLSX.utils.aoa_to_sheet(values);
  sheet['!cols'] = [18, 42, 14, 9, 22, 22, 13, 18, 13, 13, 13, 13, 12, 14, 14, 14, 16].map(wch => ({ wch }));
  sheet['!merges'] = [0, 1].map(r => ({ s: { r, c: 0 }, e: { r, c: 16 } }));
  sheet['!rows'] = values.map((_, i) => ({ hpt: i === 0 ? 32 : i === 2 ? 30 : 24 }));
  sheet['!autofilter'] = { ref: `A3:Q${values.length}` };
  return sheet;
}

export function createPayrollTemplateWorkbook(options: PayrollTemplateExportOptions) {
  const weeks = options.weeks.slice(0, WEEK_COLUMN_KEYS.length);
  const headers = [
    '序号', '姓名', '基础时薪', '出勤日期与班次明细 (按实际分钟)',
    ...WEEK_COLUMN_KEYS.map((_, index) => formatWeekHeader(weeks[index], index)),
    '常规工时 (小时)', 'OT工时 (>40h/周)', '常规工资', '加班工资', '奖金', '油补 (天)', '油补金额', '应发金额', '核对',
  ];
  const firstDataRow = 4;
  const totalRowNumber = firstDataRow + options.rows.length;
  const issueRows = new Set<number>();
  const values = [
    [formatExportTitle(options.periodLabel), ...Array(18).fill('')],
    ['计算规则：实际分钟扣除与休息时段重叠的时间，员工个人规则优先；扣除后每周(周一至周日)超过40小时按1.5倍计算。逐日打卡与工资见「每日上班明细」。', ...Array(18).fill('')],
    headers,
    ...options.rows.map((row, index) => {
      const rowNumber = firstDataRow + index;
      const hasIssue = row.issues.length > 0;
      if (hasIssue) issueRows.add(rowNumber);
      const weekCells = weeks.map(week => {
        const hours = row.weeklyHours.find(item => item.week === week.week)?.hours ?? 0;
        return hours > 0 ? asAmount(hours) : '';
      });
      return [
        index + 1,
        row.name,
        row.baseRate,
        formatAttendanceDetails(row, weeks),
        ...weekCells,
        ...Array(WEEK_COLUMN_KEYS.length - weekCells.length).fill(''),
        row.regularHours,
        row.overtimeHours,
        row.regularPay,
        row.overtimePay,
        row.bonus,
        row.fuelDays,
        row.fuelAllowance,
        row.totalPay,
        hasIssue ? row.issues.map(issue => issue.message).join('；') : '已核对',
      ];
    }),
    [
      '合计', ...Array(9).fill(''),
      { f: `SUM(K${firstDataRow}:K${totalRowNumber - 1})` },
      { f: `SUM(L${firstDataRow}:L${totalRowNumber - 1})` },
      { f: `SUM(M${firstDataRow}:M${totalRowNumber - 1})` },
      { f: `SUM(N${firstDataRow}:N${totalRowNumber - 1})` },
      { f: `SUM(O${firstDataRow}:O${totalRowNumber - 1})` },
      { f: `SUM(P${firstDataRow}:P${totalRowNumber - 1})` },
      { f: `SUM(Q${firstDataRow}:Q${totalRowNumber - 1})` },
      { f: `SUM(R${firstDataRow}:R${totalRowNumber - 1})` },
      `${options.rows.length} 人`,
    ],
  ];

  const sheet = XLSX.utils.aoa_to_sheet(values);
  sheet['!merges'] = [
    { s: { r: 0, c: 0 }, e: { r: 0, c: 18 } },
    { s: { r: 1, c: 0 }, e: { r: 1, c: 18 } },
  ];
  sheet['!cols'] = [
    { wch: 8 }, { wch: 18 }, { wch: 14 }, { wch: 44 },
    ...Array.from({ length: 6 }, () => ({ wch: 15 })),
    { wch: 14 }, { wch: 18 }, { wch: 14 }, { wch: 14 }, { wch: 12 }, { wch: 12 }, { wch: 14 }, { wch: 14 }, { wch: 24 },
  ];
  sheet['!rows'] = [
    { hpt: 34 },
    { hpt: 24 },
    { hpt: 54 },
    ...options.rows.map(row => ({ hpt: Math.max(30, Math.min(110, 16 + formatAttendanceDetails(row, weeks).split('\n').length * 18)) })),
    { hpt: 26 },
  ];
  sheet['!autofilter'] = { ref: `A3:S${totalRowNumber - 1}` };

  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, '考勤及工时汇总');
  XLSX.utils.book_append_sheet(workbook, createDailySheet(options), '每日上班明细');
  const rawWorkbook = XLSX.write(workbook, { type: 'array', bookType: 'xlsx', compression: true }) as ArrayBuffer;
  return applyTemplateStyles(rawWorkbook, totalRowNumber, issueRows);
}

export function downloadPayrollTemplateWorkbook(options: PayrollTemplateExportOptions) {
  const bytes = createPayrollTemplateWorkbook(options);
  const title = formatExportTitle(options.periodLabel).replace(/\s+/g, '_');
  const blob = new Blob([bytes.buffer as ArrayBuffer], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `${title}.xlsx`;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}
