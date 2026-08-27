import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import * as XLSX from 'xlsx';
import type { PayrollEmployeeBase, PayrollWeekRange } from './payrollTypes';

const WEEK_COLUMN_KEYS = ['E', 'F', 'G', 'H', 'I', 'J'] as const;
const CURRENCY_COLUMN_KEYS = new Set(['C', 'M', 'N', 'O', 'Q', 'R']);

export interface PayrollTemplateExportRow extends PayrollEmployeeBase {
  bonus: number;
  fuelDays: number;
  regularPay: number;
  overtimePay: number;
  fuelAllowance: number;
  totalPay: number;
}

export interface PayrollTemplateExportOptions {
  periodLabel: string;
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
  archive[sheetPath] = strToU8(sheet.replace(/<c r="([A-Z]+)(\d+)"/g, (match, column: string, rawRow: string) => {
    const rowNumber = Number(rawRow);
    return `<c r="${column}${rawRow}" s="${getCellStyle(column, rowNumber, totalRowNumber, issueRows)}"`;
  }));
  return zipSync(archive, { level: 6 });
};

export function createPayrollTemplateWorkbook(options: PayrollTemplateExportOptions) {
  const weeks = options.weeks.slice(0, WEEK_COLUMN_KEYS.length);
  const headers = [
    '序号', '姓名', '基础时薪', '出勤日期与班次明细 (已扣午休)',
    ...WEEK_COLUMN_KEYS.map((_, index) => formatWeekHeader(weeks[index], index)),
    '常规工时 (小时)', 'OT工时 (>40h/周)', '常规工资', '加班工资', '奖金', '油补 (天)', '油补金额', '应发金额', '核对',
  ];
  const firstDataRow = 4;
  const totalRowNumber = firstDataRow + options.rows.length;
  const issueRows = new Set<number>();
  const values = [
    [formatExportTitle(options.periodLabel), ...Array(18).fill('')],
    ['计算规则：1. 每日扣除 1 小时午休 (12:30-13:30) | 2. 单周(周一至周日)工作超过 40 小时部分按 1.5 倍计算加班费', ...Array(18).fill('')],
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
