import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import {
  Alert,
  Button,
  Card,
  Checkbox,
  Grid,
  Input,
  Modal,
  Space,
  Spin,
  Table,
  Tag,
  Typography,
} from '@arco-design/web-react';
import { CheckCircle2, FileSpreadsheet, Search, Upload, UsersRound } from 'lucide-react';
import type { ColumnProps } from '@arco-design/web-react/es/Table/interface';
import type { PayrollEmployeeBase, PayrollParseResult, PayrollWeekRange, PayrollWorkerResponse } from './payrollTypes';
import { deleteLocalFirstValue, readLocalFirstValue, writeLocalFirstValue } from '../../shared/storage/localFirstDatabase';
import { downloadPayrollTemplateWorkbook } from './payrollTemplateExport';

const { Row, Col } = Grid;
const { Text, Title, Paragraph } = Typography;

interface PayrollEmployee extends PayrollEmployeeBase {
  bonus: number;
  fuelDays: number;
}

interface PayrollRow extends PayrollEmployee {
  regularPay: number | null;
  overtimePay: number | null;
  fuelAllowance: number;
  totalPay: number | null;
  isBlocked: boolean;
}

const FUEL_ALLOWANCE_PER_DAY = 19.5;
const PAYROLL_DRAFT_DATABASE_KEY = 'active';

interface PayrollDraft {
  employees: PayrollEmployee[];
  weeks?: PayrollWeekRange[];
  fileName: string;
  periodLabel: string;
  parsedRows: number;
  updatedAt: number;
}

const asAmount = (value: number) => Math.round(value * 100) / 100;
const formatCurrency = (value: number) => new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
}).format(value);

const normalizeEmployeeName = (name: string) => name.trim().toLocaleLowerCase('zh-CN');
const formatDraftTime = (timestamp: number) => new Intl.DateTimeFormat('zh-CN', {
  hour: '2-digit', minute: '2-digit', hour12: false
}).format(timestamp);

const WEEK_ORDINALS = ['一', '二', '三', '四', '五', '六'];

const parseWeekDate = (week: string) => {
  const [year, month, day] = week.split('-').map(Number);
  if (!year || !month || !day) return null;
  const date = new Date(year, month - 1, day);
  return Number.isNaN(date.getTime()) ? null : date;
};

const formatMonthDay = (date: Date) => `${date.getMonth() + 1}/${date.getDate()}`;

const formatWeekRange = (week: string) => {
  const start = parseWeekDate(week);
  if (!start) return week;
  const end = new Date(start);
  end.setDate(end.getDate() + 6);
  return `${formatMonthDay(start)}–${formatMonthDay(end)}`;
};

const deriveWeekRanges = (employees: PayrollEmployee[]): PayrollWeekRange[] => (
  Array.from(new Set(employees.flatMap((employee) => employee.weeklyHours.map(({ week }) => week))))
    .sort((first, second) => first.localeCompare(second))
    .map((week) => ({ week }))
);

const calculatePayrollRow = (employee: PayrollEmployee): PayrollRow => {
  const fuelAllowance = asAmount(employee.fuelDays * FUEL_ALLOWANCE_PER_DAY);
  if (employee.baseRate === null || employee.baseRate <= 0) {
    return { ...employee, regularPay: null, overtimePay: null, fuelAllowance, totalPay: null, isBlocked: true };
  }

  const regularPay = asAmount(employee.regularHours * employee.baseRate);
  const overtimePay = asAmount(employee.overtimeHours * employee.baseRate * 1.5);
  return {
    ...employee,
    regularPay,
    overtimePay,
    fuelAllowance,
    totalPay: asAmount(regularPay + overtimePay + employee.bonus + fuelAllowance),
    isBlocked: false,
  };
};

interface AmountInputProps {
  value: number | null;
  onChange: (value: string) => void;
  prefix?: string;
  suffix?: string;
  invalid?: boolean;
  ariaLabel: string;
  step?: string;
  className?: string;
  placeholder?: string;
}

function AmountInput({ value, onChange, prefix, suffix, invalid, ariaLabel, step = '0.01', className, placeholder }: AmountInputProps) {
  return (
    <Input
      className={className}
      aria-label={ariaLabel}
      type="number"
      value={value === null ? '' : String(value)}
      placeholder={placeholder}
      onChange={onChange}
      addBefore={prefix}
      addAfter={suffix}
      status={invalid ? 'error' : undefined}
      step={step}
    />
  );
}

function StatCard({ label, value, alert }: { label: string; value: string; alert?: string }) {
  return (
    <Card size="small" className="cmhub-payroll-stat" bordered>
      <Text type="secondary">{label}</Text>
      <Title heading={5}>{value}</Title>
      {alert && <Text type="warning">{alert}</Text>}
    </Card>
  );
}

export default function PayrollManager() {
  const [isOpen, setIsOpen] = useState(false);
  const [isParsing, setIsParsing] = useState(false);
  const [error, setError] = useState('');
  const [fileName, setFileName] = useState('');
  const [periodLabel, setPeriodLabel] = useState('');
  const [parsedRows, setParsedRows] = useState(0);
  const [employees, setEmployees] = useState<PayrollEmployee[]>([]);
  const [weeklyPeriods, setWeeklyPeriods] = useState<PayrollWeekRange[]>([]);
  const [search, setSearch] = useState('');
  const [onlyIssues, setOnlyIssues] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [isPayrollDropActive, setIsPayrollDropActive] = useState(false);
  const [pendingDraft, setPendingDraft] = useState<PayrollDraft | null>(null);
  const [lastDraftSavedAt, setLastDraftSavedAt] = useState<number | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const workerRef = useRef<Worker | null>(null);

  useEffect(() => () => workerRef.current?.terminate(), []);

  useEffect(() => {
    let isCurrent = true;
    void readLocalFirstValue<PayrollDraft>('payrollDrafts', PAYROLL_DRAFT_DATABASE_KEY)
      .then(draft => {
        if (!isCurrent || !draft || !Array.isArray(draft.employees) || draft.employees.length === 0) return;
        setPendingDraft(draft);
      })
      .catch(() => undefined);
    return () => {
      isCurrent = false;
    };
  }, []);

  const rows = useMemo(() => employees.map(calculatePayrollRow), [employees]);
  const previewWeeks = useMemo(
    () => weeklyPeriods.length > 0 ? weeklyPeriods : deriveWeekRanges(employees),
    [employees, weeklyPeriods],
  );
  const deferredSearch = useDeferredValue(search);
  const filteredRows = useMemo(() => {
    const normalizedSearch = deferredSearch.trim().toLowerCase();
    return rows.filter((row) => {
      const hasIssue = row.isBlocked || row.issues.length > 0;
      return (!normalizedSearch || row.name.toLowerCase().includes(normalizedSearch)) && (!onlyIssues || hasIssue);
    });
  }, [deferredSearch, onlyIssues, rows]);
  const summary = useMemo(() => ({
    totalHours: rows.reduce((sum, row) => sum + row.regularHours + row.overtimeHours, 0),
    overtimeHours: rows.reduce((sum, row) => sum + row.overtimeHours, 0),
    totalPay: rows.reduce((sum, row) => sum + (row.totalPay || 0), 0),
    blockedCount: rows.filter((row) => row.isBlocked).length,
  }), [rows]);

  const applyParsedResult = useCallback(async (result: PayrollParseResult) => {
    const parsedEmployees = result.employees.map((employee) => ({ ...employee, bonus: employee.bonus ?? 0, fuelDays: employee.fuelDays ?? 0 }));
    const rememberedRates = await Promise.all(parsedEmployees.map(async employee => {
      if (employee.baseRate !== null && employee.baseRate > 0) return [employee.id, employee.baseRate] as const;
      try {
        const rate = await readLocalFirstValue<number>('employeeRates', normalizeEmployeeName(employee.name));
        return [employee.id, rate && rate > 0 ? rate : null] as const;
      } catch {
        return [employee.id, null] as const;
      }
    }));
    const rateMap = new Map(rememberedRates);

    setEmployees(parsedEmployees.map(employee => ({
      ...employee,
      baseRate: employee.baseRate ?? rateMap.get(employee.id) ?? null
    })));
    setPeriodLabel(result.periodLabel);
    setParsedRows(result.parsedRows);
    setWeeklyPeriods(result.weeks);
    setError('');
  }, []);

  const ensureWorker = () => {
    if (workerRef.current) return workerRef.current;
    const worker = new Worker(new URL('./payrollWorker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (event: MessageEvent<PayrollWorkerResponse>) => {
      setIsParsing(false);
      if (event.data.type === 'error') {
        setError(event.data.message);
        return;
      }

      void applyParsedResult(event.data.result);
    };
    worker.onerror = () => {
      setIsParsing(false);
      setError('考勤解析线程异常，请重新上传文件。');
    };
    workerRef.current = worker;
    return worker;
  };

  const parseAttendanceFile = async (file: File) => {
    setIsOpen(true);
    setFileName(file.name);
    setIsParsing(true);
    setError('');
    try {
      const buffer = await file.arrayBuffer();
      ensureWorker().postMessage({ type: 'parse', buffer }, [buffer]);
    } catch (parseError) {
      setIsParsing(false);
      setError(parseError instanceof Error ? parseError.message : '无法读取考勤文件。');
    }
  };

  const handlePayrollDragEnter = (event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    if (Array.from(event.dataTransfer.types).includes('Files')) setIsPayrollDropActive(true);
  };

  const handlePayrollDragLeave = (event: DragEvent<HTMLElement>) => {
    if (!event.currentTarget.contains(event.relatedTarget as Node)) setIsPayrollDropActive(false);
  };

  const handlePayrollDrop = (event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    setIsPayrollDropActive(false);
    const file = Array.from(event.dataTransfer.files).find(candidate => /\.(xlsx|xls)$/i.test(candidate.name));
    if (!file) {
      setError('请拖入 .xlsx 或 .xls 格式的考勤文件。');
      return;
    }
    void parseAttendanceFile(file);
  };

  const updateEmployee = useCallback((id: string, field: 'baseRate' | 'bonus' | 'fuelDays', value: string) => {
    const numericValue = value === '' ? null : Number(value);
    const employee = employees.find(current => current.id === id);
    const normalizedValue = numericValue !== null && Number.isFinite(numericValue) && numericValue >= 0 ? numericValue : null;
    setEmployees((current) => current.map((employee) => {
      if (employee.id !== id) return employee;
      if (field === 'baseRate') {
        return { ...employee, baseRate: normalizedValue };
      }
      return { ...employee, [field]: normalizedValue ?? 0 };
    }));
    if (field === 'baseRate' && employee && normalizedValue !== null && normalizedValue > 0) {
      void writeLocalFirstValue('employeeRates', normalizeEmployeeName(employee.name), normalizedValue);
    }
  }, [employees]);

  useEffect(() => {
    if (employees.length === 0 || isParsing) return undefined;
    const saveTimer = window.setTimeout(() => {
      const updatedAt = Date.now();
      const draft: PayrollDraft = { employees, weeks: weeklyPeriods, fileName, periodLabel, parsedRows, updatedAt };
      void writeLocalFirstValue('payrollDrafts', PAYROLL_DRAFT_DATABASE_KEY, draft)
        .then(() => setLastDraftSavedAt(updatedAt))
        .catch(() => setError('薪酬草稿无法写入 IndexedDB；请先导出或保留当前页面。'));
    }, 300);
    return () => window.clearTimeout(saveTimer);
  }, [employees, fileName, isParsing, parsedRows, periodLabel, weeklyPeriods]);

  const restorePendingDraft = () => {
    if (!pendingDraft) return;
    setEmployees(pendingDraft.employees);
    setWeeklyPeriods(pendingDraft.weeks ?? deriveWeekRanges(pendingDraft.employees));
    setFileName(pendingDraft.fileName);
    setPeriodLabel(pendingDraft.periodLabel);
    setParsedRows(pendingDraft.parsedRows);
    setLastDraftSavedAt(pendingDraft.updatedAt);
    setPendingDraft(null);
    setError('');
  };

  const discardPendingDraft = () => {
    setPendingDraft(null);
    void deleteLocalFirstValue('payrollDrafts', PAYROLL_DRAFT_DATABASE_KEY);
  };

  const exportPayroll = async () => {
    if (summary.blockedCount > 0) {
      setError(`仍有 ${summary.blockedCount} 位员工缺少基础时薪，补充后才能导出。`);
      return;
    }

    setIsExporting(true);
    try {
      const exportRows = rows.map(row => {
        if (row.baseRate === null || row.regularPay === null || row.overtimePay === null || row.totalPay === null) {
          throw new Error(`${row.name} 的薪酬尚未完成计算。`);
        }
        return {
          ...row,
          baseRate: row.baseRate,
          regularPay: row.regularPay,
          overtimePay: row.overtimePay,
          totalPay: row.totalPay,
        };
      });
      downloadPayrollTemplateWorkbook({ periodLabel, weeks: previewWeeks, rows: exportRows });
      setError('');
    } catch (exportError) {
      setError(exportError instanceof Error ? exportError.message : '薪酬汇总导出失败，请重试。');
    } finally {
      setIsExporting(false);
    }
  };

  const columns = useMemo<ColumnProps<PayrollRow>[]>(() => [
    { title: '姓名', dataIndex: 'name', width: 120, render: (_, row) => <Text bold>{row.name}</Text> },
    {
      title: '基础时薪',
      width: 180,
      render: (_, row) => (
        <div className="cmhub-payroll-rate-editor">
          <AmountInput
            className="cmhub-payroll-rate-input"
            ariaLabel={`${row.name} 的基础时薪`}
            value={row.baseRate}
            onChange={(value) => updateEmployee(row.id, 'baseRate', value)}
            prefix="$"
            suffix="/h"
            invalid={row.isBlocked}
            placeholder="填写时薪"
          />
        </div>
      )
    },
    ...previewWeeks.map((period, index): ColumnProps<PayrollRow> => ({
      title: (
        <span className="cmhub-payroll-week-heading">
          <strong>第{WEEK_ORDINALS[index] ?? index + 1}周</strong>
          <small>{formatWeekRange(period.week)}</small>
        </span>
      ),
      key: `week-${period.week}`,
      width: 136,
      align: 'center',
      render: (_, row) => {
        const hours = row.weeklyHours.find(({ week }) => week === period.week)?.hours ?? 0;
        const regularHours = Math.min(hours, 40);
        const overtimeHours = Math.max(hours - 40, 0);
        return (
          <div className="cmhub-payroll-week-cell">
            <strong>{hours.toFixed(1)} h</strong>
            <span>{overtimeHours > 0
              ? `常规 ${regularHours.toFixed(1)} · OT ${overtimeHours.toFixed(1)}`
              : `常规 ${regularHours.toFixed(1)} h`}</span>
          </div>
        );
      }
    })),
    { title: '常规工时', dataIndex: 'regularHours', width: 100, render: (value) => `${Number(value).toFixed(1)} h` },
    { title: 'OT 工时', dataIndex: 'overtimeHours', width: 100, render: (value) => <Text type="warning">{`${Number(value).toFixed(1)} h`}</Text> },
    { title: '奖金', width: 140, render: (_, row) => <AmountInput ariaLabel={`${row.name} 的奖金`} value={row.bonus} onChange={(value) => updateEmployee(row.id, 'bonus', value)} prefix="$" /> },
    { title: '油补天数', width: 140, render: (_, row) => <AmountInput ariaLabel={`${row.name} 的油补天数`} value={row.fuelDays} onChange={(value) => updateEmployee(row.id, 'fuelDays', value)} suffix="天" step="1" /> },
    { title: '应发总额', width: 140, render: (_, row) => row.totalPay === null ? <Tag color="red">计算阻断</Tag> : <Text bold>{formatCurrency(row.totalPay)}</Text> },
    { title: '核对', width: 220, render: (_, row) => row.issues.length ? <Space direction="vertical" size={2}>{row.issues.map((issue) => <Text key={issue.message} type={issue.severity === 'blocking' ? 'error' : 'warning'}>{issue.message}</Text>)}</Space> : <Tag color="green" icon={<CheckCircle2 size={14} />}>已核对</Tag> },
  ], [previewWeeks, updateEmployee]);

  return (
    <>
      <Button type="text" icon={<UsersRound size={18} />} onClick={() => setIsOpen(true)}>考勤薪酬</Button>

      <Modal
        visible={isOpen && Boolean(pendingDraft)}
        title="恢复未完成的薪酬核算草稿"
        onCancel={() => setIsOpen(false)}
        footer={(
          <Space>
            <Button onClick={discardPendingDraft}>放弃草稿</Button>
            <Button type="primary" onClick={restorePendingDraft}>恢复草稿</Button>
          </Space>
        )}
      >
        <Paragraph>
          检测到未完成的薪酬核算草稿{pendingDraft ? `（上次修改时间：${formatDraftTime(pendingDraft.updatedAt)}）` : ''}。恢复后可继续核对、修改和导出。
        </Paragraph>
      </Modal>

      <Modal
        visible={isOpen && !pendingDraft}
        title={<Space><FileSpreadsheet size={20} /><span>考勤与薪酬计算预览</span></Space>}
        onCancel={() => setIsOpen(false)}
        footer={null}
        style={{ width: 'min(1440px, calc(100vw - 32px))' }}
      >
        <div className="cmhub-payroll-modal">
          <Paragraph type="secondary">按周一至周日计算，超过 40 小时自动按 1.5 倍时薪计入 OT；下方按周展开，便于与员工逐周核对。</Paragraph>

          {!employees.length && !isParsing && (
            <Card
              className="cmhub-payroll-empty"
              bordered
              data-drop-active={isPayrollDropActive}
              onDragEnter={handlePayrollDragEnter}
              onDragOver={(event) => event.preventDefault()}
              onDragLeave={handlePayrollDragLeave}
              onDrop={handlePayrollDrop}
            >
              <div className="cmhub-payroll-upload-state">
                <div className="cmhub-payroll-upload-icon"><FileSpreadsheet size={28} aria-hidden="true" /></div>
                <div className="cmhub-payroll-upload-copy">
                  <Title heading={5}>上传考勤 Excel</Title>
                  <Paragraph>可直接拖入 .xlsx / .xls 文件，或点击按钮选择。模板按每位员工两行排列：第一行为上班时间、姓名和基础时薪；第二行为下班时间。完整打卡将固定扣除 1 小时午休。</Paragraph>
                </div>
                <Button type="primary" icon={<Upload size={16} />} onClick={() => fileInputRef.current?.click()}>选择考勤 Excel</Button>
              </div>
            </Card>
          )}

          {isParsing && <Card className="cmhub-payroll-loading" bordered><Spin size={24} /><Text>正在后台解析 {fileName || '考勤文件'}，请稍候…</Text></Card>}
          {error && <Alert className="cmhub-payroll-alert" type="error" showIcon content={error} />}

          {employees.length > 0 && !isParsing && (
            <Space direction="vertical" size="large" className="cmhub-payroll-content">
              <Row gutter={[12, 12]}>
                <Col xs={24} sm={12} lg={6}><StatCard label="解析员工" value={`${rows.length} 人`} /></Col>
                <Col xs={24} sm={12} lg={6}><StatCard label="出勤总工时" value={`${summary.totalHours.toFixed(1)} h`} /></Col>
                <Col xs={24} sm={12} lg={6}><StatCard label="加班工时" value={`${summary.overtimeHours.toFixed(1)} h`} /></Col>
                <Col xs={24} sm={12} lg={6}><StatCard label="应发总额" value={formatCurrency(summary.totalPay)} alert={summary.blockedCount ? `待补 ${summary.blockedCount} 人时薪` : undefined} /></Col>
              </Row>

              <Row align="center" gutter={[12, 12]}>
                <Col flex="auto"><Input prefix={<Search size={16} />} value={search} onChange={setSearch} placeholder="搜索员工" allowClear /></Col>
                <Col><Checkbox checked={onlyIssues} onChange={setOnlyIssues}>仅看时薪缺失 / 考勤异常</Checkbox></Col>
                <Col><Button type="text" onClick={() => fileInputRef.current?.click()}>重新上传</Button></Col>
              </Row>

              <Text type="secondary">考勤周期：{periodLabel} · 已读取 {parsedRows} 行 · 已按 {previewWeeks.length} 个自然周展开 · 油补按 ${FUEL_ALLOWANCE_PER_DAY.toFixed(2)}/天计算。{lastDraftSavedAt ? ` 草稿已于 ${formatDraftTime(lastDraftSavedAt)} 自动保存。` : ''}</Text>
              <div className={search !== deferredSearch ? 'cmhub-deferred-results' : undefined}>
                <Table<PayrollRow>
                  className="cmhub-payroll-table"
                  rowKey="id"
                  columns={columns}
                  data={filteredRows}
                  border={{ wrapper: true, cell: true }}
                  pagination={{ pageSize: 50, sizeCanChange: true, showTotal: true }}
                  scroll={{ x: Math.max(1180, 1140 + previewWeeks.length * 136), y: 420 }}
                />
              </div>
            </Space>
          )}

          <div className="cmhub-payroll-footer">
            <Button onClick={() => setIsOpen(false)}>取消</Button>
            <Button type="primary" disabled={!employees.length || isParsing} loading={isExporting} icon={<Upload size={16} />} onClick={() => void exportPayroll()}>导出薪酬汇总 Excel</Button>
          </div>
        </div>
      </Modal>

      <input
        ref={fileInputRef}
        type="file"
        accept=".xlsx,.xls"
        hidden
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) void parseAttendanceFile(file);
          event.target.value = '';
        }}
      />
    </>
  );
}
