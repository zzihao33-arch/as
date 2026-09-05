import {
  Alert,
  Button,
  Card,
  Checkbox,
  DatePicker,
  Empty,
  Form,
  Input,
  InputNumber,
  Select,
  Space,
  Table,
  Tabs,
  Tag,
  Textarea,
  TimePicker,
  Loading as Spin,
  Dialog as Modal,
  MessagePlugin as Message,
  Col,
  Row,
} from 'tdesign-react';
import {
  CalendarClock,
  Check,
  Clock3,
  Download,
  FileWarning,
  MapPinned,
  Plus,
  RefreshCw,
  Save,
  Settings2,
  WalletCards,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { downloadPayrollTemplateWorkbook, type PayrollTemplateExportRow } from '../payroll/payrollTemplateExport';
import type { PayrollWeekRange } from '../payroll/payrollTypes';
import { useWarehouseSession } from '../session/WarehouseSessionProvider';
import {
  createAttendanceAppeal,
  createAttendancePayrollRun,
  getAttendancePayrollPreview,
  listAttendanceAppeals,
  listAttendanceDailyResults,
  listAttendanceLocations,
  listAttendanceShiftRules,
  openAttendancePunchPhoto,
  reviewAttendanceAppeal,
  saveAttendanceLocation,
  saveAttendancePayrollAdjustment,
  saveAttendancePayProfile,
  saveAttendanceShiftRule,
  type AttendanceAppeal,
  type AttendanceDailyResult,
  type AttendanceLocation,
  type AttendancePayrollResult,
  type AttendancePayrollRow,
  type AttendanceShiftRule,
} from '../session/warehouseApi';
import { AttendanceCapturePanel } from './AttendanceCapturePanel';
import { formatAttendanceDecimalHours } from './attendanceTime';

const ATTENDANCE_TIME_ZONE = 'America/New_York';

const localDate = (date: Date) => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

const monthRange = () => {
  const now = new Date();
  return { from: localDate(new Date(now.getFullYear(), now.getMonth(), 1)), to: localDate(now) };
};

const formatTime = (value: string | null) => value
  ? new Date(value).toLocaleTimeString('zh-CN', { timeZone: ATTENDANCE_TIME_ZONE, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })
  : '—';

const formatDateTime = (value: string) => new Date(value).toLocaleString('zh-CN', {
  timeZone: ATTENDANCE_TIME_ZONE, hour12: false,
});

function warehouseLocalToIso(value: string) {
  const guess = new Date(`${value}:00Z`);
  const timeZoneName = new Intl.DateTimeFormat('en-US', {
    timeZone: ATTENDANCE_TIME_ZONE,
    timeZoneName: 'longOffset',
  }).formatToParts(guess).find(part => part.type === 'timeZoneName')?.value ?? 'GMT-05:00';
  const match = timeZoneName.match(/GMT([+-])(\d{2}):(\d{2})/);
  const offset = match ? (match[1] === '+' ? 1 : -1) * (Number(match[2]) * 60 + Number(match[3])) : -300;
  return new Date(guess.getTime() - offset * 60_000).toISOString();
}

const attendanceStatus = (status: AttendanceDailyResult['status']) => ({
  OPEN: ['进行中', 'arcoblue'],
  COMPLETE: ['完整', 'green'],
  MISSING_IN: ['缺上班卡', 'red'],
  MISSING_OUT: ['缺下班卡', 'orange'],
  ABSENT: ['缺勤', 'red'],
  NEEDS_REVIEW: ['待复核', 'orange'],
}[status] ?? [status, 'gray']) as [string, string];

const appealStatus = (status: AttendanceAppeal['status']) => ({
  PENDING: ['待审批', 'orange'],
  APPROVED: ['已通过', 'green'],
  REJECTED: ['已驳回', 'red'],
}[status]) as [string, string];

const appealType = (type: AttendanceAppeal['type']) => ({
  DEVICE_FAILURE: '设备故障',
  TEMPORARY_LEAVE: '临时外出',
  OTHER: '其他',
}[type]);

function AttendancePhotoThumb({ attemptId, label }: { attemptId?: string | null; label: string }) {
  const targetRef = useRef<HTMLButtonElement>(null);
  const [url, setUrl] = useState('');
  const [preview, setPreview] = useState(false);
  useEffect(() => {
    if (!attemptId || !targetRef.current) return undefined;
    let active = true;
    let objectUrl = '';
    const target = targetRef.current;
    const loadPhoto = () => {
      void openAttendancePunchPhoto(attemptId).then(blob => {
        if (!active || !blob) return;
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
      }).catch(() => undefined);
    };

    if (typeof IntersectionObserver === 'undefined') {
      loadPhoto();
      return () => {
        active = false;
        if (objectUrl) URL.revokeObjectURL(objectUrl);
      };
    }

    const observer = new IntersectionObserver(entries => {
      if (!entries.some(entry => entry.isIntersecting)) return;
      observer.disconnect();
      loadPhoto();
    }, { rootMargin: '120px' });
    observer.observe(target);
    return () => {
      active = false;
      observer.disconnect();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [attemptId]);
  if (!attemptId) return <span>—</span>;
  return (
    <>
      <button ref={targetRef} type="button" className="cmhub-attendance-photo-thumb" onClick={() => url && setPreview(true)} aria-label={`预览${label}`}>
        {url ? <img src={url} alt={label} /> : <span>加载中</span>}
      </button>
      <Modal className="cmhub-attendance-modal cmhub-attendance-photo-modal" header={label} visible={preview} width={800} footer={null} onClose={() => setPreview(false)}>
        {url && <img className="cmhub-attendance-photo-preview" src={url} alt={label} />}
      </Modal>
    </>
  );
}

const emptyLocationDraft = () => ({
  id: '', name: '', address: '', latitude: '', longitude: '', radiusMeters: '200', status: 'ACTIVE' as 'ACTIVE' | 'DISABLED',
});

const emptyRuleDraft = () => ({
  id: '', name: '仓库日班', weekdays: [1, 2, 3, 4, 5], startTime: '09:00', endTime: '18:00',
  lateGraceMinutes: '0', earlyGraceMinutes: '0', effectiveFrom: localDate(new Date()), effectiveTo: '', status: 'ACTIVE' as 'ACTIVE' | 'DISABLED',
});

function RecordsPanel({ refreshKey }: { refreshKey: number }) {
  const session = useWarehouseSession();
  const initial = useMemo(monthRange, []);
  const [from, setFrom] = useState(initial.from);
  const [to, setTo] = useState(initial.to);
  const [rows, setRows] = useState<AttendanceDailyResult[]>([]);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setRows((await listAttendanceDailyResults({ dateFrom: from, dateTo: to })).rows);
    } catch (cause) {
      Message.error(cause instanceof Error ? cause.message : '考勤记录加载失败');
    } finally {
      setLoading(false);
    }
  }, [from, to]);

  useEffect(() => { void load(); }, [load, refreshKey]);

  return (
    <Card className="cmhub-attendance-panel-card" header="考勤记录" headerBordered hoverShadow>
      <div className="cmhub-attendance-toolbar">
        <div className="cmhub-attendance-range">
          <label>开始日期<DatePicker value={from} valueType="YYYY-MM-DD" onChange={(value) => setFrom(typeof value === 'string' ? value : '')} /></label>
          <label>结束日期<DatePicker value={to} valueType="YYYY-MM-DD" onChange={(value) => setTo(typeof value === 'string' ? value : '')} /></label>
          <Button icon={<RefreshCw size={15} />} onClick={() => void load()}>查询</Button>
        </div>
        <span>{session.hasPermission('attendance.team_view') ? '当前显示本仓库团队记录' : '当前仅显示我的记录'}</span>
      </div>
      <Table<AttendanceDailyResult>
        rowKey="id"
        hover
        loading={loading}
        data={rows}
        pagination={{ pageSize: 50, showPageSize: true, total: rows.length }}
        tableContentWidth="980px"
        columns={[
          { title: '日期', colKey: 'workDate', width: 120 },
          { title: '员工', colKey: 'employee', width: 150, cell: ({ row }) => <div className="cmhub-attendance-employee"><strong>{row.employeeName}</strong><small>{row.employeeNo || row.employeeReference}</small></div> },
          { title: '上班', colKey: 'clockInAt', width: 120, cell: ({ row }) => formatTime(row.clockInAt) },
          { title: '下班', colKey: 'clockOutAt', width: 120, cell: ({ row }) => formatTime(row.clockOutAt) },
          {
            title: '工作时长',
            colKey: 'grossMinutes',
            width: 110,
            cell: ({ row }) => <span className="cmhub-attendance-hours" title={`${Math.max(0, Math.round(Number(row.grossMinutes) || 0))} 分钟`}>{formatAttendanceDecimalHours(Number(row.grossMinutes))}</span>,
          },
          { title: '状态', colKey: 'status', width: 110, cell: ({ row }) => { const [label, theme] = attendanceStatus(row.status); return <Tag theme={theme === 'red' ? 'danger' : theme === 'orange' ? 'warning' : theme === 'green' ? 'success' : 'primary'}>{label}</Tag>; } },
          { title: '异常', colKey: 'exceptions', width: 160, cell: ({ row }) => <Space size="small">{row.isLate && <Tag theme="warning">迟到</Tag>}{row.isEarlyLeave && <Tag theme="warning">早退</Tag>}{!row.isLate && !row.isEarlyLeave && '—'}</Space> },
          { title: '现场抓拍', colKey: 'photos', width: 130, cell: ({ row }) => <Space size="small"><AttendancePhotoThumb attemptId={row.clockInAttemptId} label={`${row.employeeName} 上班抓拍`} /><AttendancePhotoThumb attemptId={row.clockOutAttemptId} label={`${row.employeeName} 下班抓拍`} /></Space> },
          { title: '更新时间', colKey: 'updatedAt', width: 180, cell: ({ row }) => formatDateTime(row.updatedAt) },
        ]}
        empty={<Empty description="所选日期内暂无考勤记录" />}
      />
    </Card>
  );
}

function AppealsPanel({ refreshKey, onChanged }: { refreshKey: number; onChanged(): void }) {
  const session = useWarehouseSession();
  const [rows, setRows] = useState<AttendanceAppeal[]>([]);
  const [loading, setLoading] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [reviewTarget, setReviewTarget] = useState<AttendanceAppeal | null>(null);
  const [reviewDecision, setReviewDecision] = useState<'APPROVED' | 'REJECTED'>('APPROVED');
  const [reviewNote, setReviewNote] = useState('');
  const [draft, setDraft] = useState({
    workDate: localDate(new Date()), type: 'DEVICE_FAILURE' as AttendanceAppeal['type'],
    requestedClockInAt: '', requestedClockOutAt: '', description: '',
  });

  const load = useCallback(async () => {
    setLoading(true);
    try { setRows(await listAttendanceAppeals()); }
    catch (cause) { Message.error(cause instanceof Error ? cause.message : '申诉记录加载失败'); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(); }, [load, refreshKey]);

  const create = async () => {
    if (!draft.description.trim()) {
      Message.warning('请填写申诉说明');
      return;
    }
    try {
      await createAttendanceAppeal({
        ...draft,
        requestedClockInAt: draft.requestedClockInAt ? warehouseLocalToIso(draft.requestedClockInAt) : undefined,
        requestedClockOutAt: draft.requestedClockOutAt ? warehouseLocalToIso(draft.requestedClockOutAt) : undefined,
      });
      Message.success('申诉已提交，等待仓库主管处理');
      setCreateOpen(false);
      setDraft({ workDate: localDate(new Date()), type: 'DEVICE_FAILURE', requestedClockInAt: '', requestedClockOutAt: '', description: '' });
      await load();
      onChanged();
    } catch (cause) { Message.error(cause instanceof Error ? cause.message : '申诉提交失败'); }
  };

  const review = async () => {
    if (!reviewTarget) return;
    try {
      await reviewAttendanceAppeal(reviewTarget.id, { decision: reviewDecision, reviewNote });
      Message.success(reviewDecision === 'APPROVED' ? '申诉已通过并重新计算考勤' : '申诉已驳回');
      setReviewTarget(null);
      setReviewNote('');
      await load();
      onChanged();
    } catch (cause) { Message.error(cause instanceof Error ? cause.message : '申诉审批失败'); }
  };

  return (
    <Card className="cmhub-attendance-panel-card" header="异常申诉" headerBordered hoverShadow actions={session.hasPermission('attendance.appeal') && <Button theme="primary" icon={<Plus size={15} />} onClick={() => setCreateOpen(true)}>发起申诉</Button>}>
      <Table<AttendanceAppeal>
        rowKey="id" hover loading={loading} data={rows} pagination={{ pageSize: 20, total: rows.length }} tableContentWidth="1080px"
        columns={[
          { title: '日期', colKey: 'workDate', width: 110 },
          { title: '员工', colKey: 'employee', width: 150, cell: ({ row }) => <div className="cmhub-attendance-employee"><strong>{row.employeeName}</strong><small>{row.employeeNo || row.employeeReference}</small></div> },
          { title: '类型', colKey: 'type', width: 110, cell: ({ row }) => appealType(row.type) },
          { title: '申请修正', colKey: 'requested', width: 220, cell: ({ row }) => `${row.requestedClockInAt ? formatTime(row.requestedClockInAt) : '—'} → ${row.requestedClockOutAt ? formatTime(row.requestedClockOutAt) : '—'}` },
          { title: '说明', colKey: 'description', width: 250 },
          { title: '状态', colKey: 'status', width: 100, cell: ({ row }) => { const [label, color] = appealStatus(row.status); return <Tag theme={color === 'red' ? 'danger' : color === 'orange' ? 'warning' : 'success'}>{label}</Tag>; } },
          { title: '审批意见', colKey: 'reviewNote', width: 180, cell: ({ row }) => row.reviewNote || '—' },
          { title: '操作', colKey: 'actions', fixed: 'right', width: 120, cell: ({ row }) => row.status === 'PENDING' && session.hasPermission('attendance.review')
            ? <Button size="small" disabled={row.userId === session.session?.userId} onClick={() => setReviewTarget(row)}>审批</Button>
            : '—' },
        ]}
        empty={<Empty description="暂无申诉记录" />}
      />

      <Modal className="cmhub-attendance-modal" header="发起考勤申诉" visible={createOpen} width={600} onClose={() => setCreateOpen(false)} onConfirm={() => void create()} confirmBtn="提交申诉" destroyOnClose>
        <Form layout="vertical" className="cmhub-attendance-form-grid">
          <Form.FormItem label="考勤日期"><DatePicker value={draft.workDate} valueType="YYYY-MM-DD" onChange={value => setDraft(current => ({ ...current, workDate: typeof value === 'string' ? value : '' }))} /></Form.FormItem>
          <Form.FormItem label="异常类型"><Select value={draft.type} onChange={value => setDraft(current => ({ ...current, type: String(value) as typeof current.type }))} options={[
            { label: '设备故障', value: 'DEVICE_FAILURE' }, { label: '临时外出', value: 'TEMPORARY_LEAVE' }, { label: '其他', value: 'OTHER' },
          ]} /></Form.FormItem>
          <Form.FormItem label="修正上班时间（选填）"><DatePicker value={draft.requestedClockInAt || undefined} valueType="YYYY-MM-DD HH:mm" enableTimePicker onChange={value => setDraft(current => ({ ...current, requestedClockInAt: typeof value === 'string' ? value : '' }))} /></Form.FormItem>
          <Form.FormItem label="修正下班时间（选填）"><DatePicker value={draft.requestedClockOutAt || undefined} valueType="YYYY-MM-DD HH:mm" enableTimePicker onChange={value => setDraft(current => ({ ...current, requestedClockOutAt: typeof value === 'string' ? value : '' }))} /></Form.FormItem>
          <Form.FormItem className="cmhub-attendance-form-full" label="申诉说明"><Textarea maxlength={200} value={draft.description} onChange={value => setDraft(current => ({ ...current, description: value }))} /></Form.FormItem>
        </Form>
      </Modal>

      <Modal className="cmhub-attendance-modal" header={`审批申诉 · ${reviewTarget?.employeeName ?? ''}`} visible={Boolean(reviewTarget)} width={600} onClose={() => setReviewTarget(null)} onConfirm={() => void review()} confirmBtn="确认处理" destroyOnClose>
        <Alert theme="warning" message="审批通过后会保留修正前后快照并重新计算该日考勤；审批人不可审批自己的申诉" />
        <Form layout="vertical" className="cmhub-attendance-form-stack">
          <Form.FormItem label="审批结果"><Select value={reviewDecision} onChange={value => setReviewDecision(String(value) as typeof reviewDecision)} options={[{ label: '通过', value: 'APPROVED' }, { label: '驳回', value: 'REJECTED' }]} /></Form.FormItem>
          <Form.FormItem label="审批意见"><Textarea maxlength={200} value={reviewNote} onChange={setReviewNote} /></Form.FormItem>
        </Form>
      </Modal>
    </Card>
  );
}

function ConfigurationPanel() {
  const session = useWarehouseSession();
  const [locations, setLocations] = useState<AttendanceLocation[]>([]);
  const [rules, setRules] = useState<AttendanceShiftRule[]>([]);
  const [loading, setLoading] = useState(true);
  const [locationOpen, setLocationOpen] = useState(false);
  const [ruleOpen, setRuleOpen] = useState(false);
  const [locationDraft, setLocationDraft] = useState(emptyLocationDraft);
  const [ruleDraft, setRuleDraft] = useState(emptyRuleDraft);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [nextLocations, nextRules] = await Promise.all([
        session.hasPermission('attendance.locations.manage') ? listAttendanceLocations() : Promise.resolve([]),
        session.hasPermission('attendance.rules.manage') ? listAttendanceShiftRules() : Promise.resolve([]),
      ]);
      setLocations(nextLocations);
      setRules(nextRules);
    } catch (cause) { Message.error(cause instanceof Error ? cause.message : '考勤配置加载失败'); }
    finally { setLoading(false); }
  }, [session]);
  useEffect(() => { void load(); }, [load]);

  const editLocation = (location?: AttendanceLocation) => {
    setLocationDraft(location ? {
      id: location.id, name: location.name, address: location.address ?? '', latitude: String(location.latitude),
      longitude: String(location.longitude), radiusMeters: String(location.radiusMeters), status: location.status,
    } : emptyLocationDraft());
    setLocationOpen(true);
  };

  const editRule = (rule?: AttendanceShiftRule) => {
    setRuleDraft(rule ? {
      id: rule.id, name: rule.name, weekdays: rule.weekdays, startTime: rule.startTime.slice(0, 5), endTime: rule.endTime.slice(0, 5),
      lateGraceMinutes: String(rule.lateGraceMinutes), earlyGraceMinutes: String(rule.earlyGraceMinutes),
      effectiveFrom: rule.effectiveFrom, effectiveTo: rule.effectiveTo ?? '', status: rule.status,
    } : emptyRuleDraft());
    setRuleOpen(true);
  };

  const captureLocation = () => navigator.geolocation?.getCurrentPosition(position => {
    setLocationDraft(current => ({ ...current, latitude: String(position.coords.latitude), longitude: String(position.coords.longitude) }));
  }, () => Message.error('无法读取当前位置，请手动输入经纬度'), { enableHighAccuracy: true, timeout: 5_000 });

  const persistLocation = async () => {
    if (!locationDraft.name.trim() || !locationDraft.latitude || !locationDraft.longitude) {
      Message.warning('请填写地点名称和经纬度');
      return;
    }
    try {
      await saveAttendanceLocation({
        id: locationDraft.id || undefined, name: locationDraft.name, address: locationDraft.address || null,
        latitude: Number(locationDraft.latitude), longitude: Number(locationDraft.longitude),
        radiusMeters: Number(locationDraft.radiusMeters), status: locationDraft.status,
      });
      Message.success('打卡地已保存');
      setLocationOpen(false);
      await load();
    } catch (cause) { Message.error(cause instanceof Error ? cause.message : '打卡地保存失败'); }
  };

  const persistRule = async () => {
    if (!ruleDraft.name.trim() || ruleDraft.weekdays.length === 0) {
      Message.warning('请填写规则名称并至少选择一个工作日');
      return;
    }
    try {
      await saveAttendanceShiftRule({
        id: ruleDraft.id || undefined, name: ruleDraft.name, weekdays: ruleDraft.weekdays,
        startTime: ruleDraft.startTime, endTime: ruleDraft.endTime,
        lateGraceMinutes: Number(ruleDraft.lateGraceMinutes), earlyGraceMinutes: Number(ruleDraft.earlyGraceMinutes),
        effectiveFrom: ruleDraft.effectiveFrom, effectiveTo: ruleDraft.effectiveTo || null, status: ruleDraft.status,
      });
      Message.success('班次规则已保存并按生效日期执行');
      setRuleOpen(false);
      await load();
    } catch (cause) { Message.error(cause instanceof Error ? cause.message : '班次规则保存失败'); }
  };

  if (loading) return <div className="cmhub-attendance-loading"><Spin /><span>正在加载考勤配置…</span></div>;
  return (
    <Row className="cmhub-attendance-config-grid" gutter={[20, 20]}>
      {session.hasPermission('attendance.locations.manage') && (
        <Col xs={12} lg={6}><Card header="打卡地" headerBordered hoverShadow actions={<Button theme="primary" size="small" icon={<Plus size={14} />} onClick={() => editLocation()}>新增地点</Button>}>
          <div className="cmhub-attendance-config-list">
            {locations.map(location => (
              <button type="button" key={location.id} onClick={() => editLocation(location)}>
                <MapPinned size={18} /><span><strong>{location.name}</strong><small>{location.address || `${location.latitude}, ${location.longitude}`} · {location.radiusMeters} 米</small></span>
                <Tag theme={location.status === 'ACTIVE' ? 'success' : 'default'}>{location.status === 'ACTIVE' ? '启用' : '停用'}</Tag>
              </button>
            ))}
            {!locations.length && <Empty description="尚未配置打卡地" />}
          </div>
        </Card></Col>
      )}
      {session.hasPermission('attendance.rules.manage') && (
        <Col xs={12} lg={6}><Card header="班次规则" headerBordered hoverShadow actions={<Button theme="primary" size="small" icon={<Plus size={14} />} onClick={() => editRule()}>新增规则</Button>}>
          <div className="cmhub-attendance-config-list">
            {rules.map(rule => (
              <button type="button" key={rule.id} onClick={() => editRule(rule)}>
                <Clock3 size={18} /><span><strong>{rule.name}</strong><small>{rule.startTime.slice(0, 5)}–{rule.endTime.slice(0, 5)} · 周{rule.weekdays.join('、')}</small></span>
                <Tag theme={rule.status === 'ACTIVE' ? 'success' : 'default'}>{rule.status === 'ACTIVE' ? '生效' : '停用'}</Tag>
              </button>
            ))}
            {!rules.length && <Empty description="尚未配置班次规则" />}
          </div>
        </Card></Col>
      )}

      <Modal className="cmhub-attendance-modal" header="打卡地配置" visible={locationOpen} width={600} onClose={() => setLocationOpen(false)} onConfirm={() => void persistLocation()} confirmBtn="保存" destroyOnClose>
        <Form layout="vertical" className="cmhub-attendance-form-grid">
          <Form.FormItem label="地点名称"><Input value={locationDraft.name} onChange={value => setLocationDraft(current => ({ ...current, name: value }))} /></Form.FormItem>
          <Form.FormItem label="状态"><Select value={locationDraft.status} onChange={value => setLocationDraft(current => ({ ...current, status: value === 'ACTIVE' ? 'ACTIVE' : 'DISABLED' }))} options={[{ label: '启用', value: 'ACTIVE' }, { label: '停用', value: 'DISABLED' }]} /></Form.FormItem>
          <Form.FormItem className="cmhub-attendance-form-full" label="地址（用于展示）"><Input value={locationDraft.address} onChange={value => setLocationDraft(current => ({ ...current, address: value }))} /></Form.FormItem>
          <Form.FormItem label="纬度"><Input value={locationDraft.latitude} onChange={value => setLocationDraft(current => ({ ...current, latitude: value }))} /></Form.FormItem>
          <Form.FormItem label="经度"><Input value={locationDraft.longitude} onChange={value => setLocationDraft(current => ({ ...current, longitude: value }))} /></Form.FormItem>
          <Form.FormItem label="围栏半径（50–1000 米）"><InputNumber min={50} max={1000} value={Number(locationDraft.radiusMeters)} onChange={value => setLocationDraft(current => ({ ...current, radiusMeters: value === undefined || value === null ? '' : String(value) }))} /></Form.FormItem>
          <div className="cmhub-attendance-form-action"><Button icon={<MapPinned size={15} />} onClick={captureLocation}>使用浏览器当前位置</Button></div>
        </Form>
      </Modal>

      <Modal className="cmhub-attendance-modal" header="班次规则" visible={ruleOpen} width={600} onClose={() => setRuleOpen(false)} onConfirm={() => void persistRule()} confirmBtn="保存" destroyOnClose>
        <Form layout="vertical" className="cmhub-attendance-form-grid">
          <Form.FormItem label="规则名称"><Input value={ruleDraft.name} onChange={value => setRuleDraft(current => ({ ...current, name: value }))} /></Form.FormItem>
          <Form.FormItem label="状态"><Select value={ruleDraft.status} onChange={value => setRuleDraft(current => ({ ...current, status: value === 'ACTIVE' ? 'ACTIVE' : 'DISABLED' }))} options={[{ label: '启用', value: 'ACTIVE' }, { label: '停用', value: 'DISABLED' }]} /></Form.FormItem>
          <Form.FormItem label="上班时间"><TimePicker value={ruleDraft.startTime} format="HH:mm" onChange={value => setRuleDraft(current => ({ ...current, startTime: value ?? current.startTime }))} /></Form.FormItem>
          <Form.FormItem label="下班时间"><TimePicker value={ruleDraft.endTime} format="HH:mm" onChange={value => setRuleDraft(current => ({ ...current, endTime: value ?? current.endTime }))} /></Form.FormItem>
          <Form.FormItem label="迟到宽限（分钟）"><InputNumber min={0} value={Number(ruleDraft.lateGraceMinutes)} onChange={value => setRuleDraft(current => ({ ...current, lateGraceMinutes: value === undefined || value === null ? '' : String(value) }))} /></Form.FormItem>
          <Form.FormItem label="早退宽限（分钟）"><InputNumber min={0} value={Number(ruleDraft.earlyGraceMinutes)} onChange={value => setRuleDraft(current => ({ ...current, earlyGraceMinutes: value === undefined || value === null ? '' : String(value) }))} /></Form.FormItem>
          <Form.FormItem label="生效日期"><DatePicker value={ruleDraft.effectiveFrom} valueType="YYYY-MM-DD" clearable={false} onChange={value => setRuleDraft(current => ({ ...current, effectiveFrom: typeof value === 'string' ? value : current.effectiveFrom }))} /></Form.FormItem>
          <Form.FormItem label="失效日期（选填）"><DatePicker value={ruleDraft.effectiveTo || undefined} valueType="YYYY-MM-DD" onChange={value => setRuleDraft(current => ({ ...current, effectiveTo: typeof value === 'string' ? value : '' }))} /></Form.FormItem>
          <fieldset className="cmhub-attendance-weekdays"><legend>工作日</legend>{[
            { label: '一', day: 1 }, { label: '二', day: 2 }, { label: '三', day: 3 }, { label: '四', day: 4 },
            { label: '五', day: 5 }, { label: '六', day: 6 }, { label: '日', day: 7 },
          ].map(({ label, day }) => (
            <Checkbox key={day} checked={ruleDraft.weekdays.includes(day)} onChange={checked => setRuleDraft(current => ({
              ...current, weekdays: checked ? [...current.weekdays, day].sort((a, b) => a - b) : current.weekdays.filter(value => value !== day),
            }))}>周{label}</Checkbox>
          ))}</fieldset>
        </Form>
      </Modal>
    </Row>
  );
}

function PayrollPanel() {
  const session = useWarehouseSession();
  const initial = useMemo(monthRange, []);
  const [from, setFrom] = useState(initial.from);
  const [to, setTo] = useState(initial.to);
  const [result, setResult] = useState<AttendancePayrollResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [rateTarget, setRateTarget] = useState<AttendancePayrollRow | null>(null);
  const [rate, setRate] = useState('');
  const [rateEffectiveFrom, setRateEffectiveFrom] = useState(initial.from);
  const [adjustTarget, setAdjustTarget] = useState<AttendancePayrollRow | null>(null);
  const [bonus, setBonus] = useState('0');
  const [fuelDays, setFuelDays] = useState('0');
  const [adjustNote, setAdjustNote] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try { setResult(await getAttendancePayrollPreview(from, to)); }
    catch (cause) {
      setResult(null);
      Message.error(cause instanceof Error ? cause.message : '薪酬预览加载失败');
    }
    finally { setLoading(false); }
  }, [from, to]);
  useEffect(() => { void load(); }, [load]);

  const exportPayroll = async () => {
    setLoading(true);
    try {
      const run = await createAttendancePayrollRun(from, to);
      const weeks: PayrollWeekRange[] = [...new Set(run.rows.flatMap(row => row.weeklyMinutes.map(item => item.week)))].sort().map(week => ({ week }));
      const rows: PayrollTemplateExportRow[] = run.rows.map(row => ({
        id: row.employeeReference,
        name: row.employeeName,
        baseRate: row.hourlyRate,
        bonus: row.bonus,
        fuelDays: row.fuelDays,
        regularHours: row.regularMinutes / 60,
        overtimeHours: row.overtimeMinutes / 60,
        attendanceDays: row.days.filter(day => day.grossMinutes > 0).length,
        weeklyHours: row.weeklyMinutes.map(item => ({ week: item.week, hours: item.minutes / 60 })),
        issues: row.issues.map(message => ({ message, severity: 'blocking' as const })),
        regularPay: row.regularPay ?? 0,
        overtimePay: row.overtimePay ?? 0,
        fuelAllowance: row.fuelAllowance,
        totalPay: row.totalPay ?? 0,
      }));
      downloadPayrollTemplateWorkbook({ periodLabel: `${from} 至 ${to}`, weeks, rows });
      Message.success(`薪酬快照已固化并导出${run.runId ? `（${run.runId.slice(0, 8)}）` : ''}`);
      setResult(run);
    } catch (cause) { Message.error(cause instanceof Error ? cause.message : '薪酬导出失败'); }
    finally { setLoading(false); }
  };

  const persistRate = async () => {
    if (!rateTarget?.userId || Number(rate) <= 0) return;
    try {
      await saveAttendancePayProfile({ userId: rateTarget.userId, hourlyRate: Number(rate), effectiveFrom: rateEffectiveFrom });
      Message.success('时薪已保存');
      setRateTarget(null);
      await load();
    } catch (cause) { Message.error(cause instanceof Error ? cause.message : '时薪保存失败'); }
  };

  const persistAdjustment = async () => {
    if (!adjustTarget) return;
    try {
      await saveAttendancePayrollAdjustment({
        employeeReference: adjustTarget.employeeReference, periodStart: from, periodEnd: to,
        bonus: Number(bonus), fuelDays: Number(fuelDays), note: adjustNote,
      });
      Message.success('奖金与油补调整已保存');
      setAdjustTarget(null);
      await load();
    } catch (cause) { Message.error(cause instanceof Error ? cause.message : '薪酬调整保存失败'); }
  };

  return (
    <Card className="cmhub-attendance-panel-card" header="薪酬核算" headerBordered hoverShadow actions={session.hasPermission('payroll.export') ? <Button theme="primary" icon={<Download size={15} />} loading={loading} disabled={!result?.rows.length || result.rows.some(row => row.issues.length > 0)} onClick={() => void exportPayroll()}>固化并导出 Excel</Button> : undefined}>
      <Alert theme="info" message="考勤记录是唯一工时来源完整上下班卡按实际分钟累计，不扣除固定午休；每周超过 40 小时按 1.5 倍计算，加油补贴按 $19.50/天缺少时薪或考勤异常时禁止导出" />
      <div className="cmhub-attendance-toolbar">
        <div className="cmhub-attendance-range">
          <label>开始日期<DatePicker value={from} valueType="YYYY-MM-DD" clearable={false} onChange={(value) => setFrom(value as string)} /></label>
          <label>结束日期<DatePicker value={to} valueType="YYYY-MM-DD" clearable={false} onChange={(value) => setTo(value as string)} /></label>
          <Button icon={<RefreshCw size={15} />} onClick={() => void load()}>重新计算</Button>
        </div>
        {result && <span>共 {result.rows.length} 人 · 规则版本已由服务端统一计算</span>}
      </div>
      <Table<AttendancePayrollRow>
        rowKey="employeeReference" loading={loading} data={result?.rows ?? []} tableContentWidth="1260px"
        hover
        columns={[
          { title: '员工', colKey: 'employeeName', fixed: 'left', width: 160, cell: ({ row }) => <div className="cmhub-attendance-employee"><strong>{row.employeeName}</strong><small>{row.employeeNo || row.employeeReference}</small></div> },
          { title: '时薪', colKey: 'hourlyRate', width: 100, cell: ({ row }) => row.hourlyRate === null ? <Tag theme="danger">未设置</Tag> : `$${Number(row.hourlyRate).toFixed(2)}` },
          { title: '正常工时', colKey: 'regularMinutes', width: 110, cell: ({ row }) => formatAttendanceDecimalHours(Number(row.regularMinutes)) },
          { title: 'OT 工时', colKey: 'overtimeMinutes', width: 100, cell: ({ row }) => formatAttendanceDecimalHours(Number(row.overtimeMinutes)) },
          { title: '正常工资', colKey: 'regularPay', width: 110, cell: ({ row }) => row.regularPay === null ? '—' : `$${Number(row.regularPay).toFixed(2)}` },
          { title: '加班工资', colKey: 'overtimePay', width: 110, cell: ({ row }) => row.overtimePay === null ? '—' : `$${Number(row.overtimePay).toFixed(2)}` },
          { title: '奖金', colKey: 'bonus', width: 90, cell: ({ row }) => `$${Number(row.bonus).toFixed(2)}` },
          { title: '油补', colKey: 'fuelAllowance', width: 130, cell: ({ row }) => `${Number(row.fuelDays).toLocaleString('zh-CN')} 天 · $${Number(row.fuelAllowance).toFixed(2)}` },
          { title: '应发金额', colKey: 'totalPay', width: 120, cell: ({ row }) => row.totalPay === null ? <Tag theme="danger">待核对</Tag> : <strong>${Number(row.totalPay).toFixed(2)}</strong> },
          { title: '核对', colKey: 'issues', width: 220, cell: ({ row }) => row.issues.length ? <Tag theme="danger">{row.issues.join('；')}</Tag> : <Tag theme="success">已核对</Tag> },
          { title: '操作', colKey: 'actions', fixed: 'right', width: 170, cell: ({ row }) => session.hasPermission('payroll.manage')
            ? <Space size="mini"><Button size="small" disabled={!row.userId} onClick={() => { setRateTarget(row); setRate(String(row.hourlyRate ?? '')); setRateEffectiveFrom(from); }}>时薪</Button><Button size="small" onClick={() => { setAdjustTarget(row); setBonus(String(row.bonus)); setFuelDays(String(row.fuelDays)); setAdjustNote(''); }}>奖金/油补</Button></Space>
            : '—' },
        ]}
        empty={<Empty description="当前周期暂无可核算考勤" />}
      />

      <Modal className="cmhub-attendance-modal" header={`设置时薪 · ${rateTarget?.employeeName ?? ''}`} visible={Boolean(rateTarget)} width={600} onClose={() => setRateTarget(null)} onConfirm={() => void persistRate()} confirmBtn="保存" destroyOnClose>
        <Form layout="vertical" className="cmhub-attendance-form-stack">
          <Form.FormItem label="时薪（美元）"><InputNumber min={0.01} value={rate ? Number(rate) : undefined} onChange={(value) => setRate(value === undefined || value === null ? '' : String(value))} /></Form.FormItem>
          <Form.FormItem label="生效日期"><DatePicker value={rateEffectiveFrom} valueType="YYYY-MM-DD" clearable={false} onChange={(value) => setRateEffectiveFrom(value as string)} /></Form.FormItem>
        </Form>
      </Modal>
      <Modal className="cmhub-attendance-modal" header={`薪酬调整 · ${adjustTarget?.employeeName ?? ''}`} visible={Boolean(adjustTarget)} width={600} onClose={() => setAdjustTarget(null)} onConfirm={() => void persistAdjustment()} confirmBtn="保存" destroyOnClose>
        <Form layout="vertical" className="cmhub-attendance-form-stack">
          <Form.FormItem label="奖金（美元）"><InputNumber min={0} value={bonus ? Number(bonus) : 0} onChange={(value) => setBonus(value === undefined || value === null ? '' : String(value))} /></Form.FormItem>
          <Form.FormItem label="油补天数"><InputNumber min={0} value={fuelDays ? Number(fuelDays) : 0} onChange={(value) => setFuelDays(value === undefined || value === null ? '' : String(value))} /></Form.FormItem>
          <Form.FormItem label="备注"><Textarea maxlength={200} value={adjustNote} onChange={setAdjustNote} /></Form.FormItem>
        </Form>
      </Modal>
    </Card>
  );
}

type AttendanceTabKey = 'punch' | 'records' | 'appeals' | 'configuration' | 'payroll';

export default function AttendancePayrollWorkspace() {
  const session = useWarehouseSession();
  const canPunch = session.hasPermission('attendance.punch');
  const canViewRecords = session.hasPermission('attendance.self_view') || session.hasPermission('attendance.team_view');
  const canUseAppeals = session.hasPermission('attendance.appeal') || session.hasPermission('attendance.review');
  const configurationAllowed = session.hasPermission('attendance.locations.manage') || session.hasPermission('attendance.rules.manage');
  const canViewPayroll = session.hasPermission('payroll.view');
  const availableTabs = useMemo<AttendanceTabKey[]>(() => [
    ...(canPunch ? ['punch' as const] : []),
    ...(canViewRecords ? ['records' as const] : []),
    ...(canUseAppeals ? ['appeals' as const] : []),
    ...(configurationAllowed ? ['configuration' as const] : []),
    ...(canViewPayroll ? ['payroll' as const] : []),
  ], [canPunch, canUseAppeals, canViewPayroll, canViewRecords, configurationAllowed]);
  const [activeTab, setActiveTab] = useState<AttendanceTabKey>(() => availableTabs[0] ?? 'payroll');
  const [refreshKey, setRefreshKey] = useState(0);
  const resolvedActiveTab = availableTabs.includes(activeTab) ? activeTab : availableTabs[0];
  const changed = () => setRefreshKey(value => value + 1);
  const heading = ({ punch: '我的打卡', records: '考勤记录', appeals: '异常申诉', configuration: '考勤配置', payroll: '考勤薪酬' } as Record<AttendanceTabKey, string>)[resolvedActiveTab ?? 'payroll'];

  useEffect(() => {
    if (resolvedActiveTab && resolvedActiveTab !== activeTab) setActiveTab(resolvedActiveTab);
  }, [activeTab, resolvedActiveTab]);

  if (!resolvedActiveTab) {
    return (
      <section className="cmhub-page cmhub-attendance-page" aria-labelledby="attendance-page-title">
        <div className="cmhub-page-heading">
          <div>
            <h1 id="attendance-page-title">考勤与薪酬</h1>
            <p>当前账号尚未获得此工作区的可用权限</p>
          </div>
        </div>
        <Alert theme="warning" message="请联系系统管理员分配考勤或薪酬权限后重试" />
      </section>
    );
  }

  return (
    <section className="cmhub-page cmhub-attendance-page" aria-labelledby="attendance-page-title">
      <h1 id="attendance-page-title" className="cmhub-visually-hidden">{heading}</h1>
      <Card className="cmhub-attendance-workspace" bordered={false} hoverShadow>
        <div className="cmhub-attendance-tabs">
          <Tabs
          value={resolvedActiveTab}
          onChange={key => setActiveTab(key as AttendanceTabKey)}
          action={<span className="cmhub-attendance-server-time-note" aria-label="以服务器时间为准">以服务器时间为准</span>}
        >
          {canPunch && <Tabs.TabPanel value="punch" destroyOnHide label={<Space size="mini"><CalendarClock size={16} />我的打卡</Space>}><AttendanceCapturePanel onChanged={changed} /></Tabs.TabPanel>}
          {canViewRecords && <Tabs.TabPanel value="records" destroyOnHide label={<Space size="mini"><Clock3 size={16} />考勤记录</Space>}><RecordsPanel refreshKey={refreshKey} /></Tabs.TabPanel>}
          {canUseAppeals && <Tabs.TabPanel value="appeals" destroyOnHide label={<Space size="mini"><FileWarning size={16} />异常申诉</Space>}><AppealsPanel refreshKey={refreshKey} onChanged={changed} /></Tabs.TabPanel>}
          {configurationAllowed && <Tabs.TabPanel value="configuration" destroyOnHide label={<Space size="mini"><Settings2 size={16} />管理配置</Space>}><ConfigurationPanel /></Tabs.TabPanel>}
          {canViewPayroll && <Tabs.TabPanel value="payroll" destroyOnHide label={<Space size="mini"><WalletCards size={16} />薪酬核算</Space>}><PayrollPanel /></Tabs.TabPanel>}
          </Tabs>
        </div>
      </Card>

      <div className="cmhub-attendance-privacy-note">
        <Check size={15} /><span>已接受的打卡、被拒绝的尝试与审批修正均记录审计轨迹</span>
        <X size={15} /><span>不做人脸身份识别，不保存人脸模板；位置与照片不会用于考勤以外用途</span>
        <Save size={15} /><span>照片与定位证据保留 6 个月，薪酬最小身份与计算快照保留 6 年</span>
      </div>
    </section>
  );
}
