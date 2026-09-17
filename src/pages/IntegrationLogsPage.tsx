import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Drawer, Empty, Message, Pagination, Spin } from '@arco-design/web-react';
import { Bell, RefreshCw, Volume2, VolumeX } from 'lucide-react';
import { getPushLog, listPushLogs, operationNames, type LogFilters, type PushLogDetail, type PushLogList } from '../features/integrationLogs/api';
import { useIntegrationLogs } from '../features/integrationLogs/IntegrationLogsProvider';
import { createLogListLoader, createLogReadAcknowledgement } from '../features/integrationLogs/requestLifecycle';

const formatTime = (value: string) => new Date(value).toLocaleString('zh-CN', { timeZone: 'America/New_York', hour12: false });
const number = (value?: number) => value === undefined ? '—' : value.toLocaleString('en-US');
export default function IntegrationLogsPage() {
  const notifications = useIntegrationLogs();
  const [filters, setFilters] = useState<LogFilters>({ page: 1, pageSize: 20 });
  const [search, setSearch] = useState('');
  const [period, setPeriod] = useState('24h');
  const [result, setResult] = useState<PushLogList | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [failedReadCursor, setFailedReadCursor] = useState<string | null>(null);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [detail, setDetail] = useState<PushLogDetail | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [tab, setTab] = useState<'request' | 'response'>('response');
  const listLoader = useRef<ReturnType<typeof createLogListLoader> | null>(null);
  const readAcknowledgement = useRef<ReturnType<typeof createLogReadAcknowledgement> | null>(null);
  const acknowledgeRef = useRef(notifications.acknowledge); acknowledgeRef.current = notifications.acknowledge;
  const lastNotificationCursor = useRef(notifications.state.cursor);

  useEffect(() => {
    const timer = window.setTimeout(() => setFilters(old => (old.search ?? '') === search.trim() ? old : { ...old, search: search.trim(), page: 1 }), 300);
    return () => window.clearTimeout(timer);
  }, [search]);
  useEffect(() => {
    const read = createLogReadAcknowledgement({ save: cursor => acknowledgeRef.current(cursor), onError: setFailedReadCursor });
    readAcknowledgement.current = read;
    return () => { read.dispose(); readAcknowledgement.current = null; };
  }, []);
  useEffect(() => {
    let hasResult = false;
    const loader = createLogListLoader({
      load(signal) {
        const from = period === 'all' ? undefined : new Date(Date.now() - (period === '7d' ? 7 : 1) * 86_400_000).toISOString();
        return listPushLogs({ ...filters, from }, signal);
      },
      onStart() { setLoading(!hasResult); setError(null); },
      onSuccess(data) {
        hasResult = true; setResult(data); setLoading(false);
        readAcknowledgement.current?.entry(data.cursor);
      },
      onError(err) { setError(err instanceof Error ? err.message : '日志加载失败。'); },
      onIdle() { setLoading(false); },
    });
    listLoader.current = loader;
    loader.refresh();
    return () => { loader.dispose(); listLoader.current = null; };
  }, [filters, period]);
  useEffect(() => {
    if (lastNotificationCursor.current === notifications.state.cursor) return;
    lastNotificationCursor.current = notifications.state.cursor;
    listLoader.current?.refresh();
  }, [notifications.state.cursor]);
  useEffect(() => {
    if (!detailId) return;
    const controller = new AbortController(); let active = true;
    setDetail(null); setDetailError(null); setTab('response');
    void getPushLog(detailId, controller.signal).then(data => { if (active) setDetail(data); })
      .catch(err => { if (active && err?.name !== 'AbortError') setDetailError(err instanceof Error ? err.message : '详情加载失败。'); });
    return () => { active = false; controller.abort(); };
  }, [detailId]);
  const filter = (key: 'clientId' | 'operation' | 'status', value: string) => setFilters(old => ({ ...old, [key]: value || undefined, page: 1 }));
  const refresh = useCallback(() => { listLoader.current?.refresh(); void notifications.refresh(); }, [notifications.refresh]);
  const markCurrentRead = () => { if (result) void readAcknowledgement.current?.acknowledge(result.cursor); };
  const copy = async (value: string) => {
    try { await navigator.clipboard.writeText(value); Message.success('已复制'); } catch { Message.error('复制失败，请手动选择文本复制。'); }
  };

  return <section className="push-logs-page" aria-labelledby="push-logs-title">
    <header className="push-logs-header">
      <div><h1 id="push-logs-title">推送日志</h1><p>集中查看所有客户的入站推送、处理结果与失败原因</p></div>
      <div className="push-logs-actions">
        <span className={`push-logs-live ${notifications.error ? 'is-offline' : ''}`}><i />{notifications.error ? '连接异常' : notifications.lastUpdated ? '实时监测中' : '正在连接'}</span>
        <Button onClick={notifications.toggleAudio} icon={notifications.muted ? <VolumeX size={15} /> : <Volume2 size={15} />}>
          {!notifications.audioReady ? '开启提醒音' : notifications.muted ? '音效已关闭' : '音效已开启'}
        </Button>
        <Button onClick={refresh} loading={loading} icon={<RefreshCw size={15} />}>刷新</Button>
      </div>
    </header>
    <div className="push-logs-banner" role="status">
      <Bell size={20} /><div><strong>{notifications.state.unreadCount ? `${number(notifications.state.unreadCount)} 条未读推送` : '正在关注新的客户推送'}</strong>
      <span>{notifications.error ?? '新推送合并提醒；进入页面时已有记录标为已读，后续新增记录继续累计。'}</span></div>
      {notifications.state.unreadCount > 0 && <Button size="small" onClick={() => void markCurrentRead()}>标记当前记录已读</Button>}
    </div>
    {failedReadCursor !== null && <div className="push-logs-error" role="alert">已读状态未能保存。<button onClick={() => void readAcknowledgement.current?.acknowledge(failedReadCursor)}>重试</button></div>}
    <div className="push-logs-metrics">
      <div><span>筛选范围内推送</span><strong>{number(result?.metrics.total)}</strong></div>
      <div className="is-success"><span>成功</span><strong>{number(result?.metrics.success)}</strong></div>
      <div className="is-failure"><span>失败</span><strong>{number(result?.metrics.failure)}</strong></div>
      <div className="is-unread"><span>全部客户未读</span><strong>{number(notifications.state.unreadCount)}</strong></div>
    </div>
    <div className="push-logs-filters">
      <div className="push-logs-panel-title"><strong>筛选条件</strong><button onClick={() => { setFilters({ page: 1, pageSize: 20 }); setSearch(''); setPeriod('24h'); }}>重置</button></div>
      <div className="push-logs-filter-grid">
        <label>客户<select value={filters.clientId ?? ''} onChange={e => filter('clientId', e.target.value)}><option value="">全部客户</option><option value="unknown">未识别客户</option>{result?.clients.map(client => <option key={client.id} value={client.id}>{client.name}</option>)}</select></label>
        <label>接口<select value={filters.operation ?? ''} onChange={e => filter('operation', e.target.value)}><option value="">全部接口</option>{Object.entries(operationNames).map(([key, name]) => <option key={key} value={key}>{name}</option>)}</select></label>
        <label>结果<select value={filters.status ?? ''} onChange={e => filter('status', e.target.value)}><option value="">全部结果</option><option value="success">成功</option><option value="failure">失败</option></select></label>
        <label>单号 / Request ID<input maxLength={128} value={search} placeholder="输入关键词搜索" onChange={e => setSearch(e.target.value)} /></label>
        <label>接收时间<select value={period} onChange={e => { setPeriod(e.target.value); setFilters(old => ({ ...old, page: 1 })); }}><option value="24h">最近 24 小时</option><option value="7d">最近 7 天</option><option value="all">全部时间</option></select></label>
      </div>
    </div>
    <div className="push-logs-table-panel">
      <div className="push-logs-panel-title"><strong>推送记录 · {number(result?.total)} 条</strong><Button size="small" status={filters.status === 'failure' ? 'danger' : undefined} onClick={() => filter('status', filters.status === 'failure' ? '' : 'failure')}>{filters.status === 'failure' ? '显示全部结果' : '只看失败'}</Button></div>
      {error ? <div className="push-logs-error" role="alert">{error}<Button onClick={refresh}>重新加载</Button></div> : <Spin loading={loading} style={{ display: 'block' }}>
        <div className="push-logs-table-scroll"><table className="push-logs-table"><caption className="push-logs-sr-only">客户入站推送记录，时间为纽约时间</caption><thead><tr>
          <th>接收时间 · 纽约</th><th>客户</th><th>接口</th><th>单号</th><th>结果</th><th>状态码</th><th>耗时</th><th>Request ID</th><th>操作</th>
        </tr></thead><tbody>{result?.records.map(row => <tr key={row.id} className={row.outcome === 'failure' ? 'is-failure' : ''}>
          <td className="push-log-mono">{formatTime(row.occurredAt)}</td><td>{row.clientName ?? '未识别客户'}</td><td>{operationNames[row.operation] ?? row.operation}</td>
          <td className="push-log-mono"><span className="push-log-ellipsis" title={row.reference ?? ''}>{row.reference ?? '—'}</span>{row.relatedReference && <span className="push-log-ellipsis push-log-related-reference" title={`转单号：${row.relatedReference}`}>转单：{row.relatedReference}</span>}</td>
          <td><span className={`push-log-result ${row.outcome}`}>{row.outcome === 'success' ? '成功' : '失败'}</span></td>
          <td className="push-log-mono">{row.httpStatus}</td><td className="push-log-mono">{row.durationMs < 1000 ? `${row.durationMs}ms` : `${(row.durationMs / 1000).toFixed(2)}s`}</td>
          <td className="push-log-mono"><span className="push-log-ellipsis" title={row.requestId}>{row.requestId}</span></td><td><button aria-label={`查看 ${row.reference ?? row.requestId} 的推送详情`} onClick={() => setDetailId(row.id)}>查看</button></td>
        </tr>)}</tbody></table></div>
        {!loading && result?.records.length === 0 && <Empty description="当前条件下暂无推送记录" />}
      </Spin>}
      <footer><span>每 5 秒检查新推送{notifications.lastUpdated ? ` · 最近检查 ${new Date(notifications.lastUpdated).toLocaleTimeString('zh-CN', { hour12: false })}` : ''}</span>
        <Pagination current={filters.page} pageSize={filters.pageSize} total={result?.total ?? 0} size="small" simple onChange={page => setFilters(old => ({ ...old, page }))} />
      </footer>
    </div>
    <p className="push-logs-footnote">日志从本功能启用后开始记录。详情仅展示脱敏摘要，不保存密钥、面单文件或完整请求报文。</p>
    <Drawer title="推送详情" visible={!!detailId} width="min(520px, 100vw)" footer={null} onCancel={() => setDetailId(null)} className="push-logs-drawer" unmountOnExit>
      {detailError ? <div role="alert" className="push-logs-error">{detailError}</div> : !detail ? <Spin /> : <div className="push-log-detail">
        <div><strong>{detail.clientName ?? '未识别客户'} · {operationNames[detail.operation] ?? detail.operation}</strong><p className="push-log-mono">{detail.reference ?? '无关联单号'}<br />{formatTime(detail.occurredAt)}（纽约）</p></div>
        <div className={`push-log-callout ${detail.outcome}`}><strong>HTTP {detail.httpStatus} · {detail.outcome === 'success' ? '处理成功' : detail.errorCode ?? '请求失败'}</strong><p>{detail.outcome === 'success' ? '本次接口请求已成功处理。' : '请结合错误码与 Request ID 核对请求及服务日志。'}</p></div>
        <dl><dt>客户</dt><dd>{detail.clientName ?? '未识别客户'}</dd>{detail.relatedReference && <><dt>转单号</dt><dd className="push-log-mono">{detail.relatedReference}</dd></>}<dt>接口</dt><dd className="push-log-mono">{detail.method} {detail.endpoint}</dd><dt>Request ID</dt><dd className="push-log-mono">{detail.requestId}</dd><dt>处理耗时</dt><dd>{detail.durationMs} ms</dd><dt>完成时间</dt><dd>{formatTime(detail.completedAt)}</dd></dl>
        <div className="push-log-tabs" role="tablist" aria-label="脱敏摘要"><button role="tab" aria-selected={tab === 'request'} onClick={() => setTab('request')}>请求摘要</button><button role="tab" aria-selected={tab === 'response'} onClick={() => setTab('response')}>响应摘要</button></div>
        <pre tabIndex={0} aria-label={tab === 'request' ? '请求脱敏摘要' : '响应脱敏摘要'}>{JSON.stringify(tab === 'request' ? detail.requestSummary : detail.responseSummary, null, 2)}</pre>
        {detail.outcome === 'failure' && <div className="push-log-retry"><strong>关于失败重推</strong><p>请客户保留原幂等键和完全相同的请求内容重试；修改转单号或面单时应使用新幂等键。本页面不代客户重放请求。</p></div>}
        <div className="push-logs-actions"><Button onClick={() => void copy(detail.requestId)}>复制 Request ID</Button><Button type="primary" onClick={() => void copy(JSON.stringify({ requestId: detail.requestId, request: detail.requestSummary, response: detail.responseSummary }, null, 2))}>复制脱敏摘要</Button></div>
      </div>}
    </Drawer>
  </section>;
}
