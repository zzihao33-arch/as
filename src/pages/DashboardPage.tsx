import { Alert, Button, Skeleton, Tag } from '@arco-design/web-react';
import qz from 'qz-tray';
import {
  ArrowRight,
  BadgeCheck,
  Camera,
  ChevronDown,
  Cloud,
  FileInput,
  Fingerprint,
  History,
  PackageCheck,
  PackageSearch,
  Plane,
  Printer,
  RefreshCw,
} from 'lucide-react';
import { type UIEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useWorkbenchMotion } from '../features/motion/useWorkbenchMotion';
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
  const motionScopeRef = useRef<HTMLElement>(null);
  const session = useWarehouseSession();
  const { logs, refresh: refreshPrintLogs } = usePrintLogs();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [isActivityRefreshing, setIsActivityRefreshing] = useState(false);
  const [lastActivitySyncedAt, setLastActivitySyncedAt] = useState<number | null>(null);
  const [visibleActivityCount, setVisibleActivityCount] = useState(5);
  const [snapshot, setSnapshot] = useState<DashboardSnapshot>({
    batches: [], airOrders: [], airSummary: emptySummary, interceptCount: 0, attendanceExceptionCount: 0, cloudOnline: false,
  });

  const load = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true);
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
    if (successful > 0) setLastActivitySyncedAt(Date.now());
    if (!quiet) setLoading(false);
  }, []);

  useEffect(() => { void load(); }, [load]);

  const printLogs = useMemo(() => logs.filter(log => log.type === 'print'), [logs]);
  const visiblePrintLogs = printLogs.slice(0, visibleActivityCount);
  const hasMorePrintLogs = visibleActivityCount < printLogs.length;
  const loadMorePrintLogs = useCallback(() => {
    setVisibleActivityCount(current => Math.min(current + 5, printLogs.length));
  }, [printLogs.length]);
  const refreshActivity = useCallback(async () => {
    if (isActivityRefreshing) return;
    const feedbackStartedAt = performance.now();
    setIsActivityRefreshing(true);
    try {
      await Promise.all([load(true), refreshPrintLogs()]);
      setVisibleActivityCount(5);
    } finally {
      const feedbackRemaining = Math.max(0, 360 - (performance.now() - feedbackStartedAt));
      if (feedbackRemaining) {
        await new Promise(resolve => window.setTimeout(resolve, feedbackRemaining));
      }
      setIsActivityRefreshing(false);
    }
  }, [isActivityRefreshing, load, refreshPrintLogs]);
  const handleActivityScroll = useCallback((event: UIEvent<HTMLOListElement>) => {
    const list = event.currentTarget;
    if (hasMorePrintLogs && list.scrollHeight - list.scrollTop - list.clientHeight < 28) {
      loadMorePrintLogs();
    }
  }, [hasMorePrintLogs, loadMorePrintLogs]);
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
    { label: '进入扫码打单', description: '匹配面单并直达本机打印机', icon: PackageSearch, path: '/operations/scan-print', primary: true },
    { label: '录入提货单', description: '开始一张新的空运提货单', icon: FileInput, path: '/air-pickups' },
    { label: '批量入库', description: '处理当前待入库队列', icon: PackageCheck, path: '/air-pickups' },
    { label: '我的打卡', description: '记录或查看当日考勤', icon: Fingerprint, path: '/payroll' },
  ];
  const primaryAction = quickActions.find(action => action.primary)!;
  const secondaryActions = quickActions.filter(action => !action.primary);
  const PrimaryActionIcon = primaryAction.icon;

  useWorkbenchMotion(motionScopeRef);

  return (
    <section ref={motionScopeRef} className="cmhub-page cmhub-dashboard-page cmhub-stitch-page" aria-labelledby="dashboard-title">
      <header className="cmhub-stitch-heading" data-motion-enter>
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
          <button key={metric.label} type="button" data-motion-enter data-motion-hover data-tone={metric.tone} onClick={() => void navigate(metric.path)} aria-label={`查看${metric.label}：${metric.value.toLocaleString()}`}>
            <span className="cmhub-dashboard-metric-label">{metric.label}</span>
            {loading ? <Skeleton text={{ rows: 1, width: '42%' }} animation /> : <strong>{metric.value.toLocaleString()}</strong>}
            <small>查看队列 <ArrowRight size={13} aria-hidden="true" /></small>
          </button>
        ))}
      </div>

      <div className="cmhub-dashboard-body">
        <div className="cmhub-dashboard-primary-column">
          <section className="cmhub-dashboard-action-board" data-motion-enter aria-labelledby="quick-actions-title">
            <header>
              <div>
                <span className="cmhub-eyebrow">优先操作</span>
                <h2 id="quick-actions-title">从当前最重要的工作开始</h2>
              </div>
              <small>高频工作入口</small>
            </header>
            <div className="cmhub-dashboard-action-grid">
              <button type="button" className="cmhub-dashboard-primary-action" data-motion-hover onClick={() => void navigate(primaryAction.path)}>
                <span className="cmhub-dashboard-action-icon"><PrimaryActionIcon size={22} aria-hidden="true" /></span>
                <span><strong>{primaryAction.label}</strong><small>{primaryAction.description}</small></span>
                <ArrowRight size={19} aria-hidden="true" />
              </button>
              <div className="cmhub-dashboard-secondary-actions">
                {secondaryActions.map(action => {
                  const Icon = action.icon;
                  return <button key={action.label} type="button" data-motion-hover onClick={() => void navigate(action.path)}>
                    <Icon size={18} aria-hidden="true" /><span><strong>{action.label}</strong><small>{action.description}</small></span><ArrowRight size={15} aria-hidden="true" />
                  </button>;
                })}
              </div>
            </div>
          </section>

          <section className="cmhub-dashboard-panel" data-motion-enter aria-labelledby="pending-title">
            <header><h2 id="pending-title">近期待办任务</h2><Button type="text" onClick={() => void navigate('/air-pickups')}>查看全部</Button></header>
            {loading ? <div className="cmhub-dashboard-skeleton"><Skeleton text={{ rows: 4 }} animation /></div> : snapshot.airOrders.length ? (
              <div className="cmhub-dashboard-task-table" role="table">
                <div role="row"><span role="columnheader">提货单号</span><span role="columnheader">更新时间</span><span role="columnheader">业务类型</span><span role="columnheader">状态</span><span role="columnheader">操作</span></div>
                {snapshot.airOrders.slice(0, 4).map(order => {
                  const actionLabel = order.status === 'RECORDED' ? '去入库' : order.status === 'RECEIVED' ? '去交仓' : '查看';
                  return <div role="row" key={order.id}>
                    <strong role="cell">{order.billNo}</strong><time role="cell">{shortTime(order.updatedAt)}</time><span role="cell">空提流转</span>
                    <span role="cell"><Tag color={order.status === 'RECORDED' ? 'arcoblue' : order.status === 'RECEIVED' ? 'orange' : order.status === 'HANDED_OVER' ? 'green' : 'gray'}>
                      {{ RECORDED: '待入库', RECEIVED: '待交仓', HANDED_OVER: '已交仓', VOIDED: '已作废' }[order.status]}
                    </Tag></span>
                    <span role="cell">
                      <Button
                        className="cmhub-dashboard-task-action"
                        type="secondary"
                        size="small"
                        aria-label={`${actionLabel} ${order.billNo}`}
                        data-motion-hover
                        onClick={() => void navigate('/air-pickups')}
                      >
                        {actionLabel}<ArrowRight size={14} aria-hidden="true" />
                      </Button>
                    </span>
                  </div>;
                })}
              </div>
            ) : <div className="cmhub-dashboard-empty-state"><Plane size={24} /><span>当前没有待处理任务</span></div>}
          </section>
        </div>

        <aside
          className="cmhub-dashboard-panel cmhub-dashboard-activity"
          data-motion-enter
          data-refreshing={isActivityRefreshing || undefined}
          aria-labelledby="activity-title"
          aria-busy={isActivityRefreshing}
        >
          <header>
            <div className="cmhub-dashboard-activity-heading">
              <span className="cmhub-dashboard-activity-icon"><History size={17} aria-hidden="true" /></span>
              <h2 id="activity-title">最近操作动态</h2>
              <span
                className="cmhub-dashboard-activity-refresh-state"
                data-state={isActivityRefreshing ? 'loading' : snapshot.cloudOnline ? 'ready' : 'error'}
                role="status"
                aria-live="polite"
                aria-atomic="true"
              >
                <span>{isActivityRefreshing ? '正在同步' : snapshot.cloudOnline ? '最后同步' : '同步异常'}</span>
                <time>{lastActivitySyncedAt ? shortTime(lastActivitySyncedAt) : '等待首次同步'}</time>
              </span>
            </div>
            <div className="cmhub-dashboard-activity-header-actions">
              <Button
                className="cmhub-dashboard-activity-refresh"
                type="secondary"
                size="small"
                icon={<RefreshCw size={16} aria-hidden="true" />}
                disabled={isActivityRefreshing}
                onClick={() => void refreshActivity()}
                aria-label={isActivityRefreshing ? '正在刷新最近操作动态' : '刷新最近操作动态'}
                title="刷新最近操作动态"
              >
                {isActivityRefreshing ? '刷新中' : '刷新'}
              </Button>
            </div>
          </header>
          <ol onScroll={handleActivityScroll} aria-label="最近操作动态记录" aria-busy={isActivityRefreshing}>
            {visiblePrintLogs.map((log, index) => {
              const reference = `${log.firstLeg}${log.exchange && log.exchange !== '-' ? ` → ${log.exchange}` : ''}`;
              return <li key={log.id} className={log.status === 'error' ? 'is-error' : index === 0 ? 'is-active' : ''}>
                <i aria-hidden="true" />
                <div className="cmhub-dashboard-activity-copy">
                  <div className="cmhub-dashboard-activity-mainline">
                    <strong>{log.status === 'success' ? '打印任务已提交' : '打印任务异常'}</strong>
                    <time dateTime={log.createdAt ? new Date(log.createdAt).toISOString() : undefined} title={log.time}>
                      {log.createdAt ? shortTime(log.createdAt) : log.time}
                    </time>
                  </div>
                  <Button
                    className="cmhub-dashboard-activity-reference"
                    type="text"
                    size="mini"
                    title={reference}
                    aria-label={`查看打印记录 ${reference}`}
                    onClick={() => void navigate('/operations/scan-print#operation-log')}
                  >
                    {reference}
                  </Button>
                </div>
              </li>;
            })}
            {hasMorePrintLogs && (
              <li className="cmhub-dashboard-activity-load-more">
                <Button type="text" size="small" icon={<ChevronDown size={15} aria-hidden="true" />} onClick={loadMorePrintLogs}>下拉加载更多动态</Button>
              </li>
            )}
            {!printLogs.length && <li className="is-empty"><Camera size={21} /><span>扫码处理后将在这里显示最近动态</span></li>}
          </ol>
        </aside>
      </div>
    </section>
  );
}
