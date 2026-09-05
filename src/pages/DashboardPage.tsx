import { Alert, Button, Skeleton } from 'tdesign-react';
import qz from 'qz-tray';
import { AlertTriangle, ArrowRight, BadgeCheck, Camera, Cloud, FileInput, Fingerprint, History, PackageCheck, PackageSearch, Plane, Printer, RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useWorkbenchMotion } from '../features/motion/useWorkbenchMotion';
import { usePrintLogs } from '../features/printing/hooks/usePrintLogs';
import { getAttendancePunchContext, listAirPickups, listGlobalIntercepts, listSharedWorkBatches, type AirPickupOrder, type AirPickupStatus, type AirPickupSummary, type SharedWorkBatch } from '../features/session/warehouseApi';
import { useWarehouseSession } from '../features/session/WarehouseSessionProvider';

type DashboardSnapshot = { batches: SharedWorkBatch[]; airOrders: AirPickupOrder[]; airSummary: AirPickupSummary; interceptCount: number; attendanceExceptionCount: number; cloudOnline: boolean };
type WorkQueueItem = { label: string; description: string; value: number; tone: 'primary' | 'warning' | 'danger'; path: string; action: string };

const emptySummary: AirPickupSummary = { recorded: 0, received: 0, handedOver: 0, voided: 0, evidencePending: 0 };
const shortTime = (value: string | number) => new Intl.DateTimeFormat('zh-CN', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(new Date(value));
const pickupStatusDetails: Record<AirPickupStatus, { label: string; action: string; tone: string }> = {
  RECORDED: { label: '待入库', action: '去入库', tone: 'recorded' },
  RECEIVED: { label: '待交仓', action: '去交仓', tone: 'received' },
  HANDED_OVER: { label: '已交仓', action: '查看', tone: 'handed-over' },
  VOIDED: { label: '已作废', action: '查看', tone: 'voided' },
};

export default function DashboardPage() {
  const navigate = useNavigate();
  const motionScopeRef = useRef<HTMLElement>(null);
  const session = useWarehouseSession();
  const { logs, refresh: refreshPrintLogs } = usePrintLogs();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [lastSyncedAt, setLastSyncedAt] = useState<number | null>(null);
  const [snapshot, setSnapshot] = useState<DashboardSnapshot>({ batches: [], airOrders: [], airSummary: emptySummary, interceptCount: 0, attendanceExceptionCount: 0, cloudOnline: false });

  const load = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true);
    setError('');
    const [batchesResult, interceptResult, airResult, attendanceResult] = await Promise.allSettled([
      listSharedWorkBatches('ACTIVE'), listGlobalIntercepts('0', 2_000), listAirPickups({ page: 1, pageSize: 6 }), getAttendancePunchContext(),
    ]);
    const successful = [batchesResult, interceptResult, airResult, attendanceResult].filter(result => result.status === 'fulfilled').length;
    if (!successful) setError('工作概览暂时无法读取云端数据，请检查网络后重试');
    setSnapshot({
      batches: batchesResult.status === 'fulfilled' ? batchesResult.value : [],
      interceptCount: interceptResult.status === 'fulfilled' ? interceptResult.value.data.length : 0,
      airOrders: airResult.status === 'fulfilled' ? airResult.value.data : [],
      airSummary: airResult.status === 'fulfilled' ? airResult.value.summary : emptySummary,
      attendanceExceptionCount: attendanceResult.status === 'fulfilled' && attendanceResult.value.todayResult && !['OPEN', 'COMPLETE'].includes(attendanceResult.value.todayResult.status) ? 1 : 0,
      cloudOnline: successful > 0,
    });
    if (successful > 0) setLastSyncedAt(Date.now());
    if (!quiet) setLoading(false);
  }, []);

  useEffect(() => { void load(); }, [load]);

  const refreshDashboard = useCallback(async () => {
    if (isRefreshing) return;
    setIsRefreshing(true);
    try { await Promise.all([load(true), refreshPrintLogs()]); } finally { setIsRefreshing(false); }
  }, [isRefreshing, load, refreshPrintLogs]);

  const printLogs = useMemo(() => logs.filter(log => log.type === 'print').slice(0, 6), [logs]);
  const submittedCount = useMemo(() => logs.filter(log => log.type === 'print' && log.status === 'success').length, [logs]);
  const availableMappings = useMemo(() => snapshot.batches.reduce((sum, batch) => sum + batch.mappingCount, 0), [snapshot.batches]);
  const pendingCount = Math.max(0, availableMappings - submittedCount);
  const qzConnected = (() => { try { return qz.websocket.isActive(); } catch { return false; } })();
  const selectedPrinter = localStorage.getItem('selectedPrinter') || '自动选择打印机';
  const syncDescription = lastSyncedAt ? `上次同步 ${shortTime(lastSyncedAt)}` : '正在建立首次同步';

  const queueItems = useMemo<WorkQueueItem[]>(() => [
    { label: '待换单包裹', description: '面单匹配完成后可直接打印', value: pendingCount, tone: 'primary', path: '/operations/scan-print', action: '处理包裹' },
    { label: '待入库提货单', description: '空提单已录入，等待入库确认', value: snapshot.airSummary.recorded, tone: 'warning', path: '/air-pickups', action: '进入空提' },
    { label: '凭证待补', description: '补齐交接凭证后才可完成流转', value: snapshot.airSummary.evidencePending, tone: 'warning', path: '/air-pickups', action: '补充凭证' },
    { label: '拦截事项', description: '存在异常包裹，需要确认处理方案', value: snapshot.interceptCount, tone: 'danger', path: '/operations/scan-print#intercepts', action: '查看拦截' },
    { label: '考勤异常', description: '今日打卡记录需要核对', value: snapshot.attendanceExceptionCount, tone: 'warning', path: '/payroll', action: '查看考勤' },
  ], [pendingCount, snapshot.airSummary.evidencePending, snapshot.airSummary.recorded, snapshot.attendanceExceptionCount, snapshot.interceptCount]);
  const activeQueue = queueItems.filter(item => item.value > 0);
  const priorityItem = activeQueue[0] ?? queueItems[0];
  const overviewNumbers = [
    { label: '已提交打印', value: submittedCount, path: '/operations/scan-print#operation-log' },
    { label: '当前映射面单', value: availableMappings, path: '/operations/scan-print' },
    { label: '今日空提单', value: snapshot.airSummary.recorded + snapshot.airSummary.received + snapshot.airSummary.handedOver, path: '/air-pickups' },
  ];

  useWorkbenchMotion(motionScopeRef);

  return (
    <section ref={motionScopeRef} className="cmhub-page cmhub-overview" aria-labelledby="dashboard-title">
      <h1 id="dashboard-title" className="cmhub-visually-hidden">{session.session?.warehouseName ?? '当前仓库'}</h1>
      <header className="cmhub-overview-header" data-motion-enter>
        <div className="cmhub-overview-context" aria-label="工作台连接状态">
          <dl>
            <div><dd className={snapshot.cloudOnline ? 'is-online' : 'is-offline'}><Cloud size={15} aria-hidden="true" />{snapshot.cloudOnline ? '已同步' : '未连接'}</dd></div>
            <div><dd className={qzConnected ? 'is-online' : ''}><Printer size={15} aria-hidden="true" />{qzConnected ? 'QZ 已连接' : '等待 QZ'}</dd></div>
            <div><dd title={selectedPrinter}><BadgeCheck size={15} aria-hidden="true" />{selectedPrinter}</dd></div>
          </dl>
          <div className="cmhub-overview-refresh-row"><span aria-live="polite">{syncDescription}</span><Button className="cmhub-overview-refresh" variant="text" shape="square" size="small" aria-label="刷新工作区" loading={isRefreshing} icon={<RefreshCw size={14} aria-hidden="true" />} onClick={() => void refreshDashboard()} /></div>
        </div>
      </header>

      {error && <Alert theme="warning" message={error} operation={<Button size="small" onClick={() => void load()}>重新加载</Button>} />}

      <main className="cmhub-overview-layout">
          <article className={`cmhub-overview-launcher is-${priorityItem.tone}`} data-motion-enter>
            <div className="cmhub-overview-launcher-icon"><PackageSearch size={24} aria-hidden="true" /></div>
            <div className="cmhub-overview-launcher-copy"><h2>{loading ? '正在汇总今日工作' : priorityItem.value > 0 ? priorityItem.label : '开始扫码打单'}</h2><p>{loading ? '正在读取仓库队列和本机打印记录' : priorityItem.value > 0 ? `${priorityItem.value.toLocaleString()} 项需要处理${priorityItem.description}` : '当前没有阻塞事项，可直接进入扫码打单'}</p></div>
            <Button theme="primary" size="large" onClick={() => void navigate(priorityItem.path)} suffix={<ArrowRight size={17} aria-hidden="true" />}>{priorityItem.value > 0 ? priorityItem.action : '开始打单'}</Button>
          </article>

          <section className="cmhub-overview-section cmhub-overview-queue" data-motion-enter aria-labelledby="queue-title">
            <header><div><h2 id="queue-title">优先队列</h2><p>按当前阻塞程度安排处理顺序</p></div><span className={activeQueue.length ? 'is-active' : 'is-clear'}>{activeQueue.length ? `${activeQueue.length} 类待处理` : '队列正常'}</span></header>
            {loading ? <div className="cmhub-overview-queue-skeleton"><Skeleton rowCol={[1, 1, 1]} animation="gradient" /></div> : activeQueue.length ? <div className="cmhub-overview-queue-list">{activeQueue.map((item) => <button key={item.label} type="button" className={`is-${item.tone}`} onClick={() => void navigate(item.path)}><span className="cmhub-overview-queue-count">{item.value.toLocaleString()}</span><span className="cmhub-overview-queue-copy"><strong>{item.label}</strong><small>{item.description}</small></span><span className="cmhub-overview-queue-action">{item.action}<ArrowRight size={15} aria-hidden="true" /></span></button>)}</div> : <div className="cmhub-overview-clear-state"><PackageCheck size={23} aria-hidden="true" /><div><strong>没有需要立即处理的事项</strong><span>可以继续扫码打单，或查看今日流转记录</span></div></div>}
          </section>

          <section className="cmhub-overview-section cmhub-overview-numbers" data-motion-enter aria-labelledby="numbers-title"><header><div><h2 id="numbers-title">今日概况</h2><p>用于核对处理节奏，不代替完整流水</p></div></header><div>{overviewNumbers.map(item => <button key={item.label} type="button" onClick={() => void navigate(item.path)}><span>{item.label}</span><strong>{loading ? <Skeleton rowCol={[{ width: '42px' }]} animation="gradient" /> : item.value.toLocaleString()}</strong><ArrowRight size={15} aria-hidden="true" /></button>)}</div></section>

          <section className="cmhub-overview-section cmhub-overview-pickups" data-motion-enter aria-labelledby="pickup-title">
            <header><div><h2 id="pickup-title">空提流转</h2><p>最近更新的提货单，优先呈现可继续处理的记录</p></div><Button variant="text" onClick={() => void navigate('/air-pickups')}>查看全部<ArrowRight size={15} aria-hidden="true" /></Button></header>
            {loading ? <div className="cmhub-overview-table-skeleton"><Skeleton rowCol={[1, 1, 1, 1]} animation="gradient" /></div> : snapshot.airOrders.length ? <div className="cmhub-overview-pickup-list" role="list" aria-label="最近更新的空提流转记录">{snapshot.airOrders.slice(0, 4).map(order => {
              const status = pickupStatusDetails[order.status];
              return <article key={order.id} className="cmhub-overview-pickup-row" role="listitem">
                <div className="cmhub-overview-pickup-identity"><span>提货单号</span><strong>{order.billNo}</strong></div>
                <div className="cmhub-overview-pickup-time"><span>更新时间</span><time dateTime={new Date(order.updatedAt).toISOString()}>{shortTime(order.updatedAt)}</time></div>
                <div className="cmhub-overview-pickup-state"><span>状态</span><b className={`is-${status.tone}`}>{status.label}</b></div>
                <button type="button" className="cmhub-overview-pickup-action" aria-label={`${status.action} ${order.billNo}`} onClick={() => void navigate('/air-pickups')}>{status.action}<ArrowRight size={14} aria-hidden="true" /></button>
              </article>;
            })}</div> : <div className="cmhub-overview-empty-table"><Plane size={23} aria-hidden="true" /><span>暂无空提流转记录</span><Button variant="text" onClick={() => void navigate('/air-pickups')}>录入提单</Button></div>}
          </section>

          <section className="cmhub-overview-section cmhub-overview-shortcuts" data-motion-enter aria-labelledby="shortcuts-title"><header><div><h2 id="shortcuts-title">常用入口</h2><p>高频操作保持在一处，减少页面来回切换</p></div></header><div>{[
            { label: '录入提单', icon: FileInput, path: '/air-pickups' }, { label: '批量入库', icon: PackageCheck, path: '/air-pickups' }, { label: '我的打卡', icon: Fingerprint, path: '/payroll' },
          ].map(item => { const Icon = item.icon; return <button key={item.label} type="button" onClick={() => void navigate(item.path)}><Icon size={18} aria-hidden="true" /><span>{item.label}</span><ArrowRight size={15} aria-hidden="true" /></button>; })}</div></section>

          <section className="cmhub-overview-section cmhub-overview-activity" data-motion-enter aria-labelledby="activity-title" aria-busy={isRefreshing}><header><div><h2 id="activity-title">最近动态</h2><p>本机打印记录会在提交后显示</p></div><History size={18} aria-hidden="true" /></header>{printLogs.length ? <ol aria-label="最近打印操作">{printLogs.map((log, index) => { const reference = `${log.firstLeg}${log.exchange && log.exchange !== '-' ? ` → ${log.exchange}` : ''}`; return <li key={log.id} className={log.status === 'error' ? 'is-error' : index === 0 ? 'is-latest' : ''}><i aria-hidden="true" /><div><strong>{log.status === 'success' ? '打印任务已提交' : '打印任务异常'}</strong><time dateTime={log.createdAt ? new Date(log.createdAt).toISOString() : undefined}>{log.createdAt ? shortTime(log.createdAt) : log.time}</time><button type="button" onClick={() => void navigate('/operations/scan-print#operation-log')}>{reference}</button></div></li>; })}</ol> : <div className="cmhub-overview-activity-empty"><Camera size={22} aria-hidden="true" /><span>提交打印任务后，这里会保留最近动态</span></div>}</section>
          {!loading && !snapshot.cloudOnline && <div className="cmhub-overview-offline-note" role="status"><AlertTriangle size={17} aria-hidden="true" />当前使用本地缓存，恢复连接后请刷新工作区</div>}
      </main>
    </section>
  );
}
