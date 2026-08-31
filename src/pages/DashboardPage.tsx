import { Alert, Button, Skeleton, Tag } from '@arco-design/web-react';
import qz from 'qz-tray';
import {
  ArrowRight,
  BadgeCheck,
  Camera,
  Cloud,
  FileInput,
  Fingerprint,
  History,
  PackageCheck,
  PackageSearch,
  Plane,
  Printer,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { usePrintLogs } from '../features/printing/hooks/usePrintLogs';
import {
  getAttendancePunchContext,
  listAirPickups,
  listGlobalIntercepts,
  listSharedWorkBatches,
  type AirPickupOrder,
  type AirPickupSummary,
  type SharedWorkBatch,
} from '../features/session/warehouseApi';
import { useWarehouseSession } from '../features/session/WarehouseSessionProvider';

type DashboardSnapshot = {
  batches: SharedWorkBatch[];
  airOrders: AirPickupOrder[];
  airSummary: AirPickupSummary;
  interceptCount: number;
  attendanceExceptionCount: number;
  cloudOnline: boolean;
};

const emptySummary: AirPickupSummary = { recorded: 0, received: 0, handedOver: 0, voided: 0, evidencePending: 0 };

const shortTime = (value: string | number) => new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
}).format(new Date(value));

export default function DashboardPage() {
  const navigate = useNavigate();
  const session = useWarehouseSession();
  const { logs } = usePrintLogs();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [snapshot, setSnapshot] = useState<DashboardSnapshot>({
    batches: [], airOrders: [], airSummary: emptySummary, interceptCount: 0, attendanceExceptionCount: 0, cloudOnline: false,
  });

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    const [batchesResult, interceptResult, airResult, attendanceResult] = await Promise.allSettled([
      listSharedWorkBatches('ACTIVE'),
      listGlobalIntercepts('0', 2_000),
      listAirPickups({ page: 1, pageSize: 6 }),
      getAttendancePunchContext(),
    ]);
    const successful = [batchesResult, interceptResult, airResult, attendanceResult].filter(result => result.status === 'fulfilled').length;
    if (!successful) setError('工作概览暂时无法读取云端数据，请检查网络或稍后重试。');
    setSnapshot({
      batches: batchesResult.status === 'fulfilled' ? batchesResult.value : [],
      interceptCount: interceptResult.status === 'fulfilled' ? interceptResult.value.data.length : 0,
      airOrders: airResult.status === 'fulfilled' ? airResult.value.data : [],
      airSummary: airResult.status === 'fulfilled' ? airResult.value.summary : emptySummary,
      attendanceExceptionCount: attendanceResult.status === 'fulfilled'
        && attendanceResult.value.todayResult
        && !['OPEN', 'COMPLETE'].includes(attendanceResult.value.todayResult.status) ? 1 : 0,
      cloudOnline: successful > 0,
    });
    setLoading(false);
  }, []);

  useEffect(() => { void load(); }, [load]);

  const printLogs = useMemo(() => logs.filter(log => log.type === 'print'), [logs]);
  const submittedCount = printLogs.filter(log => log.status === 'success').length;
  const availableMappings = snapshot.batches.reduce((sum, batch) => sum + batch.mappingCount, 0);
  const pendingCount = Math.max(0, availableMappings - submittedCount);
  const qzConnected = (() => { try { return qz.websocket.isActive(); } catch { return false; } })();
  const selectedPrinter = localStorage.getItem('selectedPrinter') || '自动选择打印机';

  const metrics = [
    { label: '待换单包裹', value: pendingCount, tone: 'blue', path: '/operations/scan-print' },
    { label: '已提交打印', value: submittedCount, tone: 'blue', path: '/operations/scan-print#operation-log' },
    { label: '拦截数量', value: snapshot.interceptCount, tone: 'danger', path: '/operations/scan-print#intercepts' },
    { label: '待入库提货单', value: snapshot.airSummary.recorded, tone: 'warning', path: '/air-pickups' },
    { label: '凭证待补', value: snapshot.airSummary.evidencePending, tone: 'warning', path: '/air-pickups' },
    { label: '考勤异常', value: snapshot.attendanceExceptionCount, tone: 'warning', path: '/payroll' },
  ];

  const quickActions = [
    { label: '进入扫码打单', icon: PackageSearch, path: '/operations/scan-print', primary: true },
    { label: '录入提货单', icon: FileInput, path: '/air-pickups' },
    { label: '批量入库', icon: PackageCheck, path: '/air-pickups' },
    { label: '我的打卡', icon: Fingerprint, path: '/payroll' },
  ];

  return (
    <section className="cmhub-page cmhub-dashboard-page cmhub-stitch-page" aria-labelledby="dashboard-title">
      <header className="cmhub-stitch-heading">
        <div>
          <h1 id="dashboard-title">工作概览 · {session.session?.warehouseName ?? '当前仓库'}</h1>
          <p>实时同步仓库作业动态 · 数据更新于 {shortTime(Date.now())}</p>
        </div>
        <div className="cmhub-dashboard-connectivity" aria-label="连接状态">
          <span className={snapshot.cloudOnline ? 'is-ok' : 'is-error'}><Cloud size={14} />云端同步 {snapshot.cloudOnline ? '在线' : '异常'}</span>
          <span className={qzConnected ? 'is-ok' : 'is-muted'}><BadgeCheck size={14} />QZ Tray {qzConnected ? '已连接' : '待连接'}</span>
          <span className="is-muted"><Printer size={14} />{selectedPrinter}</span>
          <span className="is-muted"><History size={14} />本地缓存可用</span>
        </div>
      </header>

      {error && <Alert type="warning" content={error} action={<Button size="small" onClick={() => void load()}>重试</Button>} />}

      <div className="cmhub-dashboard-metrics" aria-label="今日业务摘要">
        {metrics.map(metric => (
          <button key={metric.label} type="button" data-tone={metric.tone} onClick={() => void navigate(metric.path)}>
            <span>{metric.label}</span>
            {loading ? <Skeleton text={{ rows: 1, width: '42%' }} animation /> : <strong>{metric.value.toLocaleString()}</strong>}
            <i aria-hidden="true"><b style={{ width: `${Math.min(100, Math.max(8, metric.value ? 58 : 8))}%` }} /></i>
          </button>
        ))}
      </div>

      <div className="cmhub-dashboard-body">
        <main>
          <h2>快捷操作</h2>
          <div className="cmhub-dashboard-actions">
            {quickActions.map(action => {
              const Icon = action.icon;
              return <button key={action.label} type="button" className={action.primary ? 'is-primary' : ''} onClick={() => void navigate(action.path)}>
                <Icon size={28} aria-hidden="true" /><span>{action.label}</span>
              </button>;
            })}
          </div>

          <section className="cmhub-dashboard-panel" aria-labelledby="pending-title">
            <header><h2 id="pending-title">近期待办任务</h2><Button type="text" onClick={() => void navigate('/air-pickups')}>查看全部</Button></header>
            {loading ? <div className="cmhub-dashboard-skeleton"><Skeleton text={{ rows: 4 }} animation /></div> : snapshot.airOrders.length ? (
              <div className="cmhub-dashboard-task-table" role="table">
                <div role="row"><span>提货单号</span><span>更新时间</span><span>业务类型</span><span>状态</span><span>操作</span></div>
                {snapshot.airOrders.slice(0, 4).map(order => <div role="row" key={order.id}>
                  <strong>{order.billNo}</strong><time>{shortTime(order.updatedAt)}</time><span>空提流转</span>
                  <Tag color={order.status === 'RECORDED' ? 'arcoblue' : order.status === 'RECEIVED' ? 'orange' : order.status === 'HANDED_OVER' ? 'green' : 'gray'}>
                    {{ RECORDED: '待入库', RECEIVED: '待交仓', HANDED_OVER: '已交仓', VOIDED: '已作废' }[order.status]}
                  </Tag>
                  <Button type="text" aria-label={`查看 ${order.billNo}`} icon={<ArrowRight size={16} />} onClick={() => void navigate('/air-pickups')} />
                </div>)}
              </div>
            ) : <div className="cmhub-dashboard-empty-state"><Plane size={24} /><span>当前没有待处理任务</span></div>}
          </section>
        </main>

        <aside className="cmhub-dashboard-panel cmhub-dashboard-activity" aria-labelledby="activity-title">
          <header><h2 id="activity-title">最近操作动态</h2><History size={18} /></header>
          <ol>
            {printLogs.slice(0, 5).map((log, index) => <li key={log.id} className={log.status === 'error' ? 'is-error' : index === 0 ? 'is-active' : ''}>
              <i aria-hidden="true" />
              <small>{log.time}</small>
              <strong>{log.status === 'success' ? '打印任务已提交' : '打印任务异常'}</strong>
              <span>{log.firstLeg}{log.exchange && log.exchange !== '-' ? ` → ${log.exchange}` : ''}</span>
            </li>)}
            {!printLogs.length && <li className="is-empty"><Camera size={21} /><span>扫码处理后将在这里显示最近动态</span></li>}
          </ol>
        </aside>
      </div>
    </section>
  );
}
