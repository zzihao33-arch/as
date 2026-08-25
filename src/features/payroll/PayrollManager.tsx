import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
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
import type { PayrollEmployeeBase, PayrollParseResult, PayrollWorkerResponse } from './payrollTypes';

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

const asAmount = (value: number) => Math.round(value * 100) / 100;
const formatCurrency = (value: number) => new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
}).format(value);

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
}

function AmountInput({ value, onChange, prefix, suffix, invalid, ariaLabel, step = '0.01' }: AmountInputProps) {
  return (
    <Input
      aria-label={ariaLabel}
      type="number"
      value={value === null ? '' : String(value)}
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
  const [search, setSearch] = useState('');
  const [onlyIssues, setOnlyIssues] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const workerRef = useRef<Worker | null>(null);

  useEffect(() => () => workerRef.current?.terminate(), []);

  const rows = useMemo(() => employees.map(calculatePayrollRow), [employees]);
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

  const ensureWorker = () => {
    if (workerRef.current) return workerRef.current;
    const worker = new Worker(new URL('./payrollWorker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (event: MessageEvent<PayrollWorkerResponse>) => {
      setIsParsing(false);
      if (event.data.type === 'error') {
        setError(event.data.message);
        return;
      }

      const result: PayrollParseResult = event.data.result;
      setEmployees(result.employees.map((employee) => ({ ...employee, bonus: employee.bonus ?? 0, fuelDays: employee.fuelDays ?? 0 })));
      setPeriodLabel(result.periodLabel);
      setParsedRows(result.parsedRows);
      setError('');
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

  const updateEmployee = useCallback((id: string, field: 'baseRate' | 'bonus' | 'fuelDays', value: string) => {
    const numericValue = value === '' ? null : Number(value);
    setEmployees((current) => current.map((employee) => {
      if (employee.id !== id) return employee;
      if (field === 'baseRate') {
        return { ...employee, baseRate: numericValue !== null && Number.isFinite(numericValue) && numericValue >= 0 ? numericValue : null };
      }
      return { ...employee, [field]: numericValue !== null && Number.isFinite(numericValue) && numericValue >= 0 ? numericValue : 0 };
    }));
  }, []);

  const exportPayroll = async () => {
    if (summary.blockedCount > 0) {
      setError(`仍有 ${summary.blockedCount} 位员工缺少基础时薪，补充后才能导出。`);
      return;
    }

    setIsExporting(true);
    try {
      const XLSX = await import('xlsx');
      const summaryRows = rows.map((row) => ({
      姓名: row.name,
      基础时薪: row.baseRate,
      常规工时: row.regularHours,
      加班工时: row.overtimeHours,
      常规工资: row.regularPay,
      加班工资: row.overtimePay,
      奖金: row.bonus,
      油补天数: row.fuelDays,
      油补金额: row.fuelAllowance,
      应发总额: row.totalPay,
      考勤异常: row.issues.map((issue) => issue.message).join('；') || '无',
    }));
      const weeklyRows = rows.flatMap((row) => row.weeklyHours.map((week) => ({
      姓名: row.name,
      周起始日: week.week,
      周工时: week.hours,
      常规工时: Math.min(week.hours, 40),
      加班工时: Math.max(week.hours - 40, 0),
    })));
      const workbook = XLSX.utils.book_new();
      const summarySheet = XLSX.utils.json_to_sheet(summaryRows);
      const weeklySheet = XLSX.utils.json_to_sheet(weeklyRows);
      summarySheet['!cols'] = [{ wch: 16 }, { wch: 12 }, { wch: 12 }, { wch: 12 }, { wch: 12 }, { wch: 12 }, { wch: 10 }, { wch: 12 }, { wch: 12 }, { wch: 14 }, { wch: 34 }];
      weeklySheet['!cols'] = [{ wch: 16 }, { wch: 14 }, { wch: 12 }, { wch: 12 }, { wch: 12 }];
      XLSX.utils.book_append_sheet(workbook, summarySheet, '薪酬汇总');
      XLSX.utils.book_append_sheet(workbook, weeklySheet, '周工时明细');
      XLSX.writeFile(workbook, `CM-HUB_薪酬汇总_${periodLabel.replaceAll(' ', '') || '导出'}.xlsx`);
      setError('');
    } catch (exportError) {
      setError(exportError instanceof Error ? exportError.message : '薪酬汇总导出失败，请重试。');
    } finally {
      setIsExporting(false);
    }
  };

  const columns = useMemo<ColumnProps<PayrollRow>[]>(() => [
    { title: '姓名', dataIndex: 'name', width: 120, render: (_, row) => <Text bold>{row.name}</Text> },
    { title: '基础时薪', width: 150, render: (_, row) => <AmountInput ariaLabel={`${row.name} 的基础时薪`} value={row.baseRate} onChange={(value) => updateEmployee(row.id, 'baseRate', value)} prefix="$" suffix="/h" invalid={row.isBlocked} /> },
    { title: '常规工时', dataIndex: 'regularHours', width: 100, render: (value) => `${Number(value).toFixed(1)} h` },
    { title: 'OT 工时', dataIndex: 'overtimeHours', width: 100, render: (value) => <Text type="warning">{`${Number(value).toFixed(1)} h`}</Text> },
    { title: '奖金', width: 140, render: (_, row) => <AmountInput ariaLabel={`${row.name} 的奖金`} value={row.bonus} onChange={(value) => updateEmployee(row.id, 'bonus', value)} prefix="$" /> },
    { title: '油补天数', width: 140, render: (_, row) => <AmountInput ariaLabel={`${row.name} 的油补天数`} value={row.fuelDays} onChange={(value) => updateEmployee(row.id, 'fuelDays', value)} suffix="天" step="1" /> },
    { title: '应发总额', width: 140, render: (_, row) => row.totalPay === null ? <Tag color="red">计算阻断</Tag> : <Text bold>{formatCurrency(row.totalPay)}</Text> },
    { title: '核对', width: 220, render: (_, row) => row.issues.length ? <Space direction="vertical" size={2}>{row.issues.map((issue) => <Text key={issue.message} type={issue.severity === 'blocking' ? 'error' : 'warning'}>{issue.message}</Text>)}</Space> : <Tag color="green" icon={<CheckCircle2 size={14} />}>已核对</Tag> },
  ], [updateEmployee]);

  return (
    <>
      <Button type="text" icon={<UsersRound size={18} />} onClick={() => setIsOpen(true)}>考勤薪酬</Button>

      <Modal
        visible={isOpen}
        title={<Space><FileSpreadsheet size={20} /><span>考勤与薪酬计算预览</span></Space>}
        onCancel={() => setIsOpen(false)}
        footer={null}
        style={{ width: 'min(1180px, calc(100vw - 32px))' }}
      >
        <div className="cmhub-payroll-modal">
          <Paragraph type="secondary">按周一至周日计算，超过 40 小时自动按 1.5 倍时薪计入 OT。</Paragraph>

          {!employees.length && !isParsing && (
            <Card className="cmhub-payroll-empty" bordered>
              <div className="cmhub-payroll-upload-state">
                <div className="cmhub-payroll-upload-icon"><FileSpreadsheet size={28} aria-hidden="true" /></div>
                <div className="cmhub-payroll-upload-copy">
                  <Title heading={5}>上传考勤 Excel</Title>
                  <Paragraph>模板按每位员工两行排列：第一行为上班时间、姓名和基础时薪；第二行为下班时间。完整打卡将固定扣除 1 小时午休。</Paragraph>
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

              <Text type="secondary">考勤周期：{periodLabel} · 已读取 {parsedRows} 行 · 油补按 ${FUEL_ALLOWANCE_PER_DAY.toFixed(2)}/天计算。</Text>
              <div className={search !== deferredSearch ? 'cmhub-deferred-results' : undefined}>
                <Table<PayrollRow>
                  rowKey="id"
                  columns={columns}
                  data={filteredRows}
                  border={{ wrapper: true, cell: true }}
                  pagination={{ pageSize: 50, sizeCanChange: true, showTotal: true }}
                  scroll={{ x: 1080, y: 420 }}
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
