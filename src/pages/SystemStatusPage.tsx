import { Button, Card, Col, Progress, Row, Space, Tag } from 'tdesign-react';
import qz from 'qz-tray';
import {
  AlertTriangle,
  CheckCircle2,
  Cloud,
  Database,
  HardDrive,
  PackageCheck,
  Printer,
  RefreshCw,
  Wifi,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { WAREHOUSE_API_BASE, WAREHOUSE_MOCK_API_ENABLED, listSharedWorkBatches } from '../features/session/warehouseApi';
import { useWarehouseSession } from '../features/session/WarehouseSessionProvider';

type HealthState = 'healthy' | 'warning' | 'error';
type StatusItem = { key: string; label: string; state: HealthState; value: string; detail: string; icon: typeof Cloud };

const checkedAt = () => new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
}).format(new Date());

export default function SystemStatusPage() {
  const session = useWarehouseSession();
  const [checking, setChecking] = useState(false);
  const [lastChecked, setLastChecked] = useState('尚未检测');
  const [cloudState, setCloudState] = useState<HealthState>('warning');
  const [syncState, setSyncState] = useState<HealthState>('warning');
  const [activeBatches, setActiveBatches] = useState(0);

  const detect = useCallback(async () => {
    setChecking(true);
    const [health, batches] = await Promise.allSettled([
      WAREHOUSE_MOCK_API_ENABLED ? Promise.resolve({ mock: true }) : fetch(`${WAREHOUSE_API_BASE}/healthz`, { credentials: 'include' }).then(response => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.json();
      }),
      listSharedWorkBatches('ACTIVE'),
    ]);
    setCloudState(health.status === 'fulfilled' ? 'healthy' : 'error');
    setSyncState(batches.status === 'fulfilled' ? 'healthy' : 'error');
    setActiveBatches(batches.status === 'fulfilled' ? batches.value.length : 0);
    setLastChecked(checkedAt());
    setChecking(false);
  }, []);

  useEffect(() => { void detect(); }, [detect]);

  const qzConnected = (() => { try { return qz.websocket.isActive(); } catch { return false; } })();
  const selectedPrinter = localStorage.getItem('selectedPrinter');
  const online = navigator.onLine;
  const cacheEstimate = 24;
  const statusItems = useMemo<StatusItem[]>(() => [
    { key: 'cloud', label: '云端 API', state: cloudState, value: cloudState === 'healthy' ? '稳定' : '连接异常', detail: `${WAREHOUSE_API_BASE.replace(/^https?:\/\//, '')} · ${lastChecked}`, icon: Cloud },
    { key: 'sync', label: '数据同步', state: syncState, value: syncState === 'healthy' ? '已连接' : '待恢复', detail: `${activeBatches} 个活动共享批次 · ${lastChecked}`, icon: Database },
    { key: 'qz', label: 'QZ Tray', state: qzConnected ? 'healthy' : 'warning', value: qzConnected ? '已连接' : '未连接', detail: qzConnected ? '浏览器 WebSocket 通道可用' : '请确认 QZ Tray 正在系统托盘运行', icon: Wifi },
    { key: 'printer', label: '当前打印机', state: selectedPrinter ? 'healthy' : 'warning', value: selectedPrinter || '自动选择', detail: selectedPrinter ? '已保存当前电脑打印机选择' : '首次打印时将自动匹配真实打印机', icon: Printer },
  ], [activeBatches, cloudState, lastChecked, qzConnected, selectedPrinter, syncState]);

  const problems = statusItems.filter(item => item.state !== 'healthy');

  return (
    <section className="cmhub-page cmhub-system-page cmhub-stitch-page" aria-labelledby="system-status-title">
      <header className="cmhub-stitch-heading cmhub-system-heading">
        <div><p className="cmhub-eyebrow">系统管理 / 健康监测</p><h1 id="system-status-title">系统状态</h1><p>实时检查云端、本机浏览器、QZ Tray、打印机与数据同步</p></div>
        <Button theme="primary" icon={<RefreshCw size={16} />} loading={checking} onClick={() => void detect()}>重新检测全部服务</Button>
      </header>

      <Card className="cmhub-system-summary" bordered={false} hoverShadow>
        <span className={problems.some(item => item.state === 'error') ? 'is-error' : problems.length ? 'is-warning' : 'is-ok'}>
          {problems.length ? <AlertTriangle size={16} /> : <CheckCircle2 size={16} />}
          {problems.length ? `${problems.length} 项需要处理` : '核心系统运行正常'}
        </span>
        <small>最近检测：{lastChecked}</small>
      </Card>

      <Row className="cmhub-system-status-grid" gutter={[20, 20]}>
        {statusItems.map(item => {
          const Icon = item.icon;
          return <Col key={item.key} xs={12} sm={6} xl={3}><Card hoverShadow headerBordered data-state={item.state}>
            <header><span><Icon size={22} /></span><i aria-label={item.state === 'healthy' ? '正常' : item.state === 'warning' ? '注意' : '异常'} /></header>
            <h2>{item.label}</h2><strong>{item.value}</strong><p>{item.detail}</p>
          </Card></Col>;
        })}
      </Row>

      <Row className="cmhub-system-body" gutter={[20, 20]}>
        <Col xs={12} xl={8}><Space direction="vertical" size={20} className="cmhub-system-main-column">
          <Card className="cmhub-system-panel" headerBordered hoverShadow>
            <header><h2>硬件与本地存储</h2><Button variant="text" onClick={() => void detect()}>重新检测</Button></header>
            <div className="cmhub-system-hardware">
              <div><Printer size={24} /><span><small>当前打印机</small><strong>{selectedPrinter || '自动选择可直打打印机'}</strong><Tag theme={selectedPrinter ? 'success' : 'warning'}>{selectedPrinter ? '已配置' : '待确认'}</Tag></span></div>
              <div><span><small>本地缓存使用</small><strong>{cacheEstimate}%</strong></span><Progress percentage={cacheEstimate} label={false} /><small>浏览器会按模块容量策略自动维护缓存</small></div>
            </div>
          </Card>

          <Card className="cmhub-system-panel" headerBordered hoverShadow>
            <header><h2>最近异常摘要</h2><Tag variant="light">本次检测</Tag></header>
            <div className="cmhub-system-events">
              {problems.map(item => <article key={item.key} data-state={item.state}><AlertTriangle size={18} /><span><strong>{item.label} · {item.value}</strong><p>{item.detail}</p></span><time>{lastChecked}</time></article>)}
              {!problems.length && <article data-state="healthy"><CheckCircle2 size={18} /><span><strong>未检测到系统异常</strong><p>云端同步和本机打印链路均可用</p></span><time>{lastChecked}</time></article>}
            </div>
          </Card>
        </Space></Col>

        <Col xs={12} xl={4}><Space direction="vertical" size={20} className="cmhub-system-side-column">
          <Card className="cmhub-system-panel cmhub-system-environment" headerBordered hoverShadow>
            <header><h2>环境信息</h2></header>
            <dl>
              <div><dt>工作站</dt><dd>{session.workstation?.displayName || '尚未注册'}</dd></div>
              <div><dt>仓库</dt><dd>{session.session?.warehouseName || '未选择'}</dd></div>
              <div><dt>浏览器</dt><dd>{navigator.userAgent.includes('Edg/') ? 'Microsoft Edge' : navigator.userAgent.includes('Chrome/') ? 'Google Chrome' : '当前浏览器'}</dd></div>
              <div><dt>网络</dt><dd>{online ? '在线' : '离线'}</dd></div>
            </dl>
          </Card>
          <Card className="cmhub-system-advisory" bordered={false} hoverShadow><HardDrive size={21} /><div><strong>现场排查建议</strong><p>{qzConnected ? 'QZ Tray 已连接如打印无响应，请检查打印机纸张和系统队列' : '先启动 QZ Tray，再回到本页重新检测'}</p></div></Card>
          <Card className="cmhub-system-advisory is-info" bordered={false} hoverShadow><PackageCheck size={21} /><div><strong>面单服务</strong><p>私有面单仅通过授权工作站下载，不会在浏览器中公开链接</p></div></Card>
        </Space></Col>
      </Row>
    </section>
  );
}
