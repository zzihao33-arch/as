import {
  Alert,
  Badge,
  Button,
  Card,
  Checkbox,
  Descriptions,
  Drawer,
  Empty,
  Form,
  Input,
  InputNumber,
  Message,
  Modal,
  Progress,
  Select,
  Space,
  Spin,
  Table,
  Tabs,
  Tag,
  Timeline,
  Tooltip,
} from '@arco-design/web-react';
import {
  Archive,
  Camera,
  Eye,
  ImagePlus,
  PackageCheck,
  Pencil,
  Plane,
  Plus,
  RefreshCw,
  Search,
  ShieldAlert,
  Truck,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  confirmAirHandoverBatch,
  createAirHandoverBatch,
  createAirPickup,
  createAirReceiptBatch,
  downloadAirEvidence,
  getAirHandoverBatch,
  getAirPickup,
  listAirPickups,
  listAirPickupClients,
  removeAirEvidence,
  updateAirPickup,
  updateAirHandoverBatch,
  uploadAirHandoverEvidence,
  uploadAirReceiptEvidence,
  voidAirPickup,
  type AirEvidenceStatus,
  type AirHandoverBatch,
  type AirHandoverEvidence,
  type AirPickupClient,
  type AirPickupOrder,
  type AirPickupSummary,
  type AirPickupStatus,
  type AirWeightUnit,
} from '../features/session/warehouseApi';
import { normalizeEvidenceImage } from '../features/airPickup/evidenceImage';
import { AirPickupModuleHeader } from '../features/airPickup/AirPickupModuleHeader';
import { selectExistingRecordsById } from '../features/airPickup/receiptSelection';
import { useWarehouseSession } from '../features/session/WarehouseSessionProvider';

const DRAFT_KEY = 'cmhub-air-pickup-create-draft-v1';
const DRAFT_TTL = 60 * 60_000;

type ReceiptDraft = {
  actualCartons: number;
  actualPackages: number;
  actualWeight: number;
  actualWeightUnit: AirWeightUnit;
  differenceReason: string;
};

type PendingReceiptEvidence = {
  file: File;
  warnings: string[];
  qualityOverride: boolean;
  previewUrl: string;
};

const emptySummary: AirPickupSummary = { recorded: 0, received: 0, handedOver: 0, voided: 0, evidencePending: 0 };

const statusLabels: Record<AirPickupStatus, string> = {
  RECORDED: '已录入', RECEIVED: '已入库', HANDED_OVER: '已交仓', VOIDED: '已作废',
};

const eventLabels: Record<string, string> = {
  ORDER_RECORDED: '录入提货单', ORDER_EDITED: '编辑预报信息', ORDER_RECEIVED: '确认入库',
  HANDOVER_DRAFT_CREATED: '加入交仓批次', EVIDENCE_ADDED: '补充交仓凭证',
  EVIDENCE_REMOVED: '移除交仓凭证', ORDER_HANDED_OVER: '确认交仓', ORDER_VOIDED: '作废提货单',
  ORDER_CORRECTED: '更正提货单',
  RECEIPT_EVIDENCE_ADDED: '补充入库照片',
};

function statusTag(status: AirPickupStatus) {
  const color = status === 'RECORDED' ? 'arcoblue' : status === 'RECEIVED' ? 'orange' : status === 'HANDED_OVER' ? 'green' : 'gray';
  return <Tag color={color}>{statusLabels[status]}</Tag>;
}

function evidenceTag(order: AirPickupOrder) {
  if (order.evidenceStatus === 'COMPLETE') return <Tag color="green">凭证完整</Tag>;
  if (order.status === 'HANDED_OVER') return <Tag color="orange">凭证待补</Tag>;
  if (order.evidenceStatus === 'PARTIAL') return <Tag color="arcoblue">已有部分凭证</Tag>;
  return <Tag color="gray">暂无凭证</Tag>;
}

function differs(order: AirPickupOrder, draft: ReceiptDraft) {
  return order.forecastCartons !== draft.actualCartons
    || order.forecastPackages !== draft.actualPackages
    || Math.abs(order.forecastWeight - draft.actualWeight) > 0.0001
    || order.forecastWeightUnit !== draft.actualWeightUnit;
}

function formatDate(value: string | null) {
  return value ? new Date(value).toLocaleString() : '—';
}

const warehouseDateTimeFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  year: '2-digit',
  month: 'numeric',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

const warehouseFullDateTimeFormatter = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'America/New_York',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
  timeZoneName: 'short',
});

function formatWarehouseUpdatedAt(value: string) {
  const parts = Object.fromEntries(warehouseDateTimeFormatter
    .formatToParts(new Date(value))
    .map(part => [part.type, part.value]));
  return `${parts.month}.${parts.day}.${parts.year} ${parts.hour}:${parts.minute}:${parts.second}`;
}

function localDateTimeValue(value: string | null = null) {
  const date = value ? new Date(value) : new Date();
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

function ExchangeProgress({ order }: { order: AirPickupOrder }) {
  const progress = order.exchangeProgress;
  if (!progress.total) return <span className="cmhub-air-progress-empty">暂无换单数据</span>;
  const percent = Math.min(100, Math.round((progress.processed / progress.total) * 100));
  return <div className="cmhub-air-progress" aria-label={`换单进度 ${progress.processed} / ${progress.total}，${percent}%`}>
    <div className="cmhub-air-progress-heading"><strong>{progress.processed.toLocaleString()} / {progress.total.toLocaleString()}</strong><span>{percent}%</span></div>
    <Progress percent={percent} showText={false} size="small" status={progress.exceptions ? 'warning' : percent === 100 ? 'success' : 'normal'} />
    <div className="cmhub-air-progress-meta">
      <span>已换单 {progress.changed.toLocaleString()}</span>
      <span>已拦截 {progress.intercepted.toLocaleString()}</span>
      {progress.exceptions > 0 && <span className="is-warning">异常 {progress.exceptions.toLocaleString()}</span>}
    </div>
  </div>;
}

function EvidenceThumbnail({ asset, onPreview }: { asset: AirHandoverEvidence; onPreview: (asset: AirHandoverEvidence) => void }) {
  const containerRef = useRef<HTMLButtonElement>(null);
  const [thumbnailUrl, setThumbnailUrl] = useState('');
  useEffect(() => {
    const node = containerRef.current;
    if (!node) return undefined;
    let disposed = false;
    let objectUrl = '';
    const load = async () => {
      try {
        const blob = await downloadAirEvidence(asset.downloadPath);
        if (disposed) return;
        objectUrl = URL.createObjectURL(blob);
        setThumbnailUrl(objectUrl);
      } catch { /* keep the reserved thumbnail placeholder and allow full preview retry */ }
    };
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) { observer.disconnect(); void load(); }
    }, { rootMargin: '120px' });
    observer.observe(node);
    return () => { disposed = true; observer.disconnect(); if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [asset.downloadPath]);
  return <button ref={containerRef} className="cmhub-air-evidence-thumb" onClick={() => onPreview(asset)} aria-label={`预览 ${asset.filename}`}>
    {thumbnailUrl ? <img src={thumbnailUrl} alt="" loading="lazy" /> : <span className="cmhub-air-evidence-placeholder"><Camera size={20} aria-hidden="true" /></span>}
    <small>{asset.filename}</small>
  </button>;
}

export default function AirPickupPage() {
  const warehouseSession = useWarehouseSession();
  const [orders, setOrders] = useState<AirPickupOrder[]>([]);
  const [summary, setSummary] = useState<AirPickupSummary>(emptySummary);
  const [clients, setClients] = useState<AirPickupClient[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [searchDraft, setSearchDraft] = useState('');
  const [status, setStatus] = useState<AirPickupStatus | ''>('');
  const [evidenceStatus, setEvidenceStatus] = useState<AirEvidenceStatus | ''>('');
  const [clientFilter, setClientFilter] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editingOrder, setEditingOrder] = useState<AirPickupOrder | null>(null);
  const [saving, setSaving] = useState(false);
  const [receiptOpen, setReceiptOpen] = useState(false);
  const [receiptDrafts, setReceiptDrafts] = useState<Record<string, ReceiptDraft>>({});
  const [receiptReceivedAt, setReceiptReceivedAt] = useState(localDateTimeValue());
  const [receiptEvidence, setReceiptEvidence] = useState<PendingReceiptEvidence[]>([]);
  const [handoverOpen, setHandoverOpen] = useState(false);
  const [handoverOrderIds, setHandoverOrderIds] = useState<string[]>([]);
  const [handoverBatch, setHandoverBatch] = useState<AirHandoverBatch | null>(null);
  const [handoverSaving, setHandoverSaving] = useState(false);
  const [batchEditOpen, setBatchEditOpen] = useState(false);
  const [batchCandidates, setBatchCandidates] = useState<AirPickupOrder[]>([]);
  const [detailOrder, setDetailOrder] = useState<AirPickupOrder | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [removeAsset, setRemoveAsset] = useState<AirHandoverEvidence | null>(null);
  const [voidTarget, setVoidTarget] = useState<AirPickupOrder | null>(null);
  const [form] = Form.useForm();
  const [handoverForm] = Form.useForm();
  const [removeForm] = Form.useForm();
  const [voidForm] = Form.useForm();
  const [batchEditForm] = Form.useForm();
  const podInput = useRef<HTMLInputElement>(null);
  const loadingInput = useRef<HTMLInputElement>(null);
  const receiptInput = useRef<HTMLInputElement>(null);

  const canCreate = warehouseSession.hasPermission('air_pickups.create');
  const canEdit = warehouseSession.hasPermission('air_pickups.edit');
  const canReceive = warehouseSession.hasPermission('air_pickups.receive');
  const canHandover = warehouseSession.hasPermission('air_pickups.handover');
  const canAddEvidence = warehouseSession.hasPermission('air_pickups.evidence.add');
  const canManageEvidence = warehouseSession.hasPermission('air_pickups.evidence.manage');
  const canCorrect = warehouseSession.hasPermission('air_pickups.correct');

  const load = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true);
    setError('');
    try {
      const selectedClient = clients.find(client => client.id === clientFilter);
      const result = await listAirPickups({ search: search || selectedClient?.name || '', status, evidenceStatus, page, pageSize: 20 });
      setOrders(result.data);
      setTotal(result.pagination.total);
      setSummary(result.summary);
      setSelectedIds(current => current.filter(id => result.data.some(order => order.id === id)));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '提货单数据加载失败。');
    } finally {
      if (!quiet) setLoading(false);
    }
  }, [clientFilter, clients, evidenceStatus, page, search, status]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (clients.length) return;
    void listAirPickupClients().then(setClients).catch(() => undefined);
  }, [clients.length]);
  useEffect(() => {
    const timer = window.setTimeout(() => { setSearch(searchDraft); setPage(1); }, 300);
    return () => window.clearTimeout(timer);
  }, [searchDraft]);
  useEffect(() => {
    const timer = window.setInterval(() => { if (document.visibilityState === 'visible' && !editorOpen && !receiptOpen && !handoverOpen) void load(true); }, 5_000);
    return () => window.clearInterval(timer);
  }, [editorOpen, handoverOpen, load, receiptOpen]);
  useEffect(() => () => { if (previewUrl) URL.revokeObjectURL(previewUrl); }, [previewUrl]);

  const selectedOrders = useMemo(() => selectedIds.map(id => orders.find(order => order.id === id)).filter(Boolean) as AirPickupOrder[], [orders, selectedIds]);
  const selectedRecorded = selectedOrders.filter(order => order.status === 'RECORDED');
  const selectedReceived = selectedOrders.filter(order => order.status === 'RECEIVED' && !order.handoverBatchId);

  const openCreate = async () => {
    setEditingOrder(null);
    let initial: { clientId?: string; forecastCartons: number; forecastPackages: number; forecastWeightUnit: AirWeightUnit } = {
      forecastCartons: 1, forecastPackages: 1, forecastWeightUnit: 'KG',
    };
    try {
      const draft = JSON.parse(localStorage.getItem(DRAFT_KEY) ?? 'null') as { savedAt: number; values: typeof initial } | null;
      if (draft && Date.now() - draft.savedAt <= DRAFT_TTL) initial = { ...initial, ...draft.values };
    } catch { /* invalid local draft is ignored */ }
    try {
      const availableClients = clients.length ? clients : await listAirPickupClients();
      setClients(availableClients);
      if (availableClients.length === 1) initial = { ...initial, clientId: availableClients[0].id };
    } catch (cause) {
      Message.error(cause instanceof Error ? cause.message : '来源客户加载失败。');
      return;
    }
    form.setFieldsValue(initial);
    setEditorOpen(true);
  };

  const openEdit = (order: AirPickupOrder) => {
    setEditingOrder(order);
    form.setFieldsValue({ cargoName: order.cargoName ?? '', forecastCartons: order.forecastCartons,
      forecastPackages: order.forecastPackages, forecastWeight: order.forecastWeight,
      forecastWeightUnit: order.forecastWeightUnit, remarks: order.remarks ?? '' });
    setEditorOpen(true);
  };

  const openReceipt = (targets: AirPickupOrder[]) => {
    const next = Object.fromEntries(targets.map(order => [order.id, { actualCartons: order.forecastCartons,
      actualPackages: order.forecastPackages, actualWeight: order.forecastWeight,
      actualWeightUnit: order.forecastWeightUnit, differenceReason: '' }]));
    setReceiptDrafts(next);
    setReceiptReceivedAt(localDateTimeValue());
    receiptEvidence.forEach(item => URL.revokeObjectURL(item.previewUrl));
    setReceiptEvidence([]);
    setReceiptOpen(true);
  };

  const clearReceiptEvidence = () => {
    setReceiptEvidence(current => {
      current.forEach(item => URL.revokeObjectURL(item.previewUrl));
      return [];
    });
    if (receiptInput.current) receiptInput.current.value = '';
  };

  const closeReceiptEditor = () => {
    setReceiptOpen(false);
    setReceiptDrafts({});
    clearReceiptEvidence();
  };

  const handleReceiptEvidenceFiles = async (files: FileList | null) => {
    if (!files?.length) return;
    if (receiptEvidence.length + files.length > 9) { Message.error('入库照最多 9 张。'); return; }
    const accepted: PendingReceiptEvidence[] = [];
    try {
      for (const original of Array.from(files)) {
        if (!['image/jpeg', 'image/png'].includes(original.type)) throw new Error(`${original.name} 不是 JPG、JPEG 或 PNG 图片。`);
        const normalized = await normalizeEvidenceImage(original);
        const qualityOverride = normalized.warnings.length
          ? window.confirm(`${original.name}：${normalized.warnings.join('、')}。是否确认仍然上传？`)
          : false;
        if (normalized.warnings.length && !qualityOverride) continue;
        accepted.push({ file: normalized.file, warnings: normalized.warnings, qualityOverride,
          previewUrl: URL.createObjectURL(normalized.file) });
      }
      setReceiptEvidence(current => [...current, ...accepted]);
    } catch (cause) {
      accepted.forEach(item => URL.revokeObjectURL(item.previewUrl));
      Message.error(cause instanceof Error ? cause.message : '入库照读取失败。');
    } finally {
      if (receiptInput.current) receiptInput.current.value = '';
    }
  };

  const openDetail = async (order: AirPickupOrder) => {
    setDetailOrder(order);
    setDetailLoading(true);
    try { setDetailOrder(await getAirPickup(order.id)); }
    catch (cause) { Message.error(cause instanceof Error ? cause.message : '详情加载失败。'); }
    finally { setDetailLoading(false); }
  };

  const openBatch = async (batchId: string) => {
    try { setHandoverBatch(await getAirHandoverBatch(batchId)); setHandoverOpen(true); }
    catch (cause) { Message.error(cause instanceof Error ? cause.message : '交仓批次加载失败。'); }
  };

  const openBatchEditor = async () => {
    if (!handoverBatch) return;
    setHandoverSaving(true);
    try {
      const first = await listAirPickups({ status: 'RECEIVED', page: 1, pageSize: 100 });
      const second = first.pagination.total > 100 ? await listAirPickups({ status: 'RECEIVED', page: 2, pageSize: 100 }) : null;
      const combined = [...handoverBatch.orders, ...first.data, ...(second?.data ?? [])];
      setBatchCandidates([...new Map(combined.map(order => [order.id, order])).values()]);
      batchEditForm.setFieldsValue({ orderIds: handoverBatch.orders.map(order => order.id), vehicleNo: handoverBatch.vehicleNo ?? '',
        driverName: handoverBatch.driverName ?? '', driverPhone: handoverBatch.driverPhone ?? '',
        handedOverAt: localDateTimeValue(handoverBatch.handedOverAt) });
      setBatchEditOpen(true);
    } catch (cause) { Message.error(cause instanceof Error ? cause.message : '可选提货单加载失败。'); }
    finally { setHandoverSaving(false); }
  };

  const handleEvidenceFiles = async (type: 'POD' | 'LOADING', files: FileList | null) => {
    if (!handoverBatch || !files?.length) return;
    const currentCount = handoverBatch.evidence.filter(item => item.type === type).length;
    if (currentCount + files.length > 9) { Message.error(`${type === 'POD' ? 'POD' : '装车照'}最多 9 张。`); return; }
    setHandoverSaving(true);
    try {
      for (const original of Array.from(files)) {
        const normalized = await normalizeEvidenceImage(original);
        const override = normalized.warnings.length
          ? window.confirm(`${original.name}：${normalized.warnings.join('、')}。是否确认仍然上传？`)
          : false;
        if (normalized.warnings.length && !override) continue;
        await uploadAirHandoverEvidence(handoverBatch.id, { type, file: normalized.file, qualityWarnings: normalized.warnings, qualityOverride: override });
      }
      setHandoverBatch(await getAirHandoverBatch(handoverBatch.id));
      await load(true);
      Message.success('凭证已保存并同步');
    } catch (cause) { Message.error(cause instanceof Error ? cause.message : '凭证上传失败。'); }
    finally { setHandoverSaving(false); if (podInput.current) podInput.current.value = ''; if (loadingInput.current) loadingInput.current.value = ''; }
  };

  const previewEvidence = async (asset: AirHandoverEvidence) => {
    try {
      const blob = await downloadAirEvidence(asset.downloadPath);
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      setPreviewUrl(URL.createObjectURL(blob));
    } catch (cause) { Message.error(cause instanceof Error ? cause.message : '凭证预览失败。'); }
  };

  const columns = [
    { title: '提货单号', dataIndex: 'billNo', width: 175, render: (_: unknown, order: AirPickupOrder) => (
      <button className="cmhub-air-link" onClick={() => void openDetail(order)}>{order.billNo}</button>
    ) },
    { title: '来源客户', width: 150, render: (_: unknown, order: AirPickupOrder) => (
      <span className="cmhub-air-source" title={order.sourceClientName}>{order.sourceClientName}</span>
    ) },
    { title: '预报', width: 190, render: (_: unknown, order: AirPickupOrder) => (
      <span>{order.forecastCartons}箱 · {order.forecastPackages}包 · {order.forecastWeight}{order.forecastWeightUnit}</span>
    ) },
    { title: '换单进度', width: 250, render: (_: unknown, order: AirPickupOrder) => <ExchangeProgress order={order} /> },
    { title: '状态', width: 200, render: (_: unknown, order: AirPickupOrder) => <Space>{statusTag(order.status)}{evidenceTag(order)}</Space> },
    { title: '批次', width: 160, render: (_: unknown, order: AirPickupOrder) => order.handoverBatchNo
      ? <button className="cmhub-air-link is-secondary" onClick={() => void openBatch(order.handoverBatchId!)}>{order.handoverBatchNo}</button>
      : order.receiptBatchNo ?? '—' },
    { title: '更新时间', width: 150, render: (_: unknown, order: AirPickupOrder) => (
      <time className="cmhub-air-updated-at" dateTime={order.updatedAt} title={warehouseFullDateTimeFormatter.format(new Date(order.updatedAt))}>
        {formatWarehouseUpdatedAt(order.updatedAt)}
      </time>
    ) },
    { title: '操作', width: 250, fixed: 'right' as const, render: (_: unknown, order: AirPickupOrder) => (
      <Space>
        <Button size="mini" icon={<Eye size={13} />} onClick={() => void openDetail(order)}>详情</Button>
        {canEdit && order.status === 'RECORDED' && <Button size="mini" icon={<Pencil size={13} />} onClick={() => openEdit(order)}>编辑</Button>}
        {canReceive && order.status === 'RECORDED' && <Button size="mini" type="primary" onClick={() => openReceipt([order])}>入库</Button>}
        {canCorrect && order.status === 'RECORDED' && <Button size="mini" status="danger" onClick={() => setVoidTarget(order)}>作废</Button>}
        {canHandover && order.status === 'RECEIVED' && !order.handoverBatchId && <Button size="mini" type="primary" onClick={() => { setHandoverOrderIds([order.id]); handoverForm.setFieldsValue({ handedOverAt: localDateTimeValue() }); setHandoverOpen(true); }}>交仓</Button>}
        {canAddEvidence && order.status === 'HANDED_OVER' && order.evidenceStatus !== 'COMPLETE' && order.handoverBatchId && <Button size="mini" onClick={() => void openBatch(order.handoverBatchId!)}>补凭证</Button>}
      </Space>
    ) },
  ];

  return (
    <section className="cmhub-page cmhub-air-page" aria-labelledby="air-management-title">
      <AirPickupModuleHeader action={canCreate && <Button type="primary" icon={<Plus size={16} />} onClick={() => void openCreate()}>录入提货单</Button>} />

      <div className="cmhub-air-summary" aria-label="状态概览">
        <div><Plane size={18} /><span>当前结果</span><strong>{total}</strong></div>
        <div><PackageCheck size={18} /><span>已选择</span><strong>{selectedIds.length}</strong></div>
        <div><Archive size={18} /><span>待入库</span><strong>{summary.recorded}</strong></div>
        <div><Camera size={18} /><span>凭证待补</span><strong>{summary.evidencePending}</strong></div>
      </div>

      {error && <Alert type="error" content={error} action={<Button size="mini" onClick={() => void load()}>重试</Button>} />}

      <Card className="cmhub-module-frame cmhub-air-list-card" bordered>
        <div className="cmhub-air-filter-row">
          <Tabs activeTab={status || 'ALL'} onChange={key => { setStatus(key === 'ALL' ? '' : key as AirPickupStatus); setPage(1); setSelectedIds([]); }}>
            <Tabs.TabPane key="ALL" title="全部" />
            <Tabs.TabPane key="RECORDED" title={<Badge count={summary.recorded} maxCount={9999} dotStyle={{ background: '#f53f3f' }}><span className="cmhub-air-tab-with-badge">已录入</span></Badge>} />
            <Tabs.TabPane key="RECEIVED" title="已入库" />
            <Tabs.TabPane key="HANDED_OVER" title="已交仓" />
            <Tabs.TabPane key="VOIDED" title="已作废" />
          </Tabs>
          <div className="cmhub-air-filter-controls">
            <Input.Search allowClear value={searchDraft} prefix={<Search size={15} />} placeholder="搜索提货单号或客户"
              onChange={setSearchDraft} onSearch={value => { setSearch(value); setPage(1); }} />
            <Select allowClear showSearch placeholder="来源客户" value={clientFilter || undefined}
              onChange={value => { setClientFilter(value ?? ''); setPage(1); }}
              options={clients.map(client => ({ label: client.name, value: client.id }))} />
            <Select allowClear placeholder="凭证状态" value={evidenceStatus || undefined}
              onChange={value => { setEvidenceStatus((value ?? '') as AirEvidenceStatus | ''); setPage(1); }}
              options={[{ label: '暂无凭证', value: 'NONE' }, { label: '凭证待补', value: 'PARTIAL' }, { label: '凭证完整', value: 'COMPLETE' }]} />
            <Tooltip content="数据每5秒自动同步"><Button icon={<RefreshCw size={15} />} onClick={() => void load()}>刷新</Button></Tooltip>
          </div>
        </div>

        <div className="cmhub-air-batchbar">
          <span>选择同一批货后可批量处理，单批最多 200 单。</span>
          <Space>
            {canReceive && <Button disabled={!selectedRecorded.length || selectedRecorded.length !== selectedOrders.length} icon={<PackageCheck size={15} />} onClick={() => openReceipt(selectedRecorded)}>批量入库 ({selectedRecorded.length})</Button>}
            {canHandover && <Button type="primary" disabled={!selectedReceived.length || selectedReceived.length !== selectedOrders.length} icon={<Truck size={15} />}
              onClick={() => { setHandoverOrderIds(selectedReceived.map(order => order.id)); handoverForm.setFieldsValue({ handedOverAt: localDateTimeValue() }); setHandoverBatch(null); setHandoverOpen(true); }}>批量交仓 ({selectedReceived.length})</Button>}
          </Space>
        </div>

        <div className="cmhub-air-desktop-table">
          <Table rowKey="id" borderCell={false} loading={loading} data={orders} columns={columns}
            scroll={{ x: 1550 }} noDataElement={<Empty description="暂无提货单，点击“录入提货单”开始。" />}
            rowSelection={{ type: 'checkbox', selectedRowKeys: selectedIds, onChange: keys => setSelectedIds(keys.map(String)), checkboxProps: order => ({ disabled: order.status === 'VOIDED' }) }}
            pagination={{ current: page, pageSize: 20, total, showTotal: true, onChange: setPage }} />
        </div>
        <div className="cmhub-air-mobile-list">
          {loading ? <div className="cmhub-module-loading"><Spin />正在同步提货单…</div> : orders.map(order => <article key={order.id}>
            <header><Checkbox checked={selectedIds.includes(order.id)} disabled={order.status === 'VOIDED'} onChange={checked => setSelectedIds(current => checked ? [...current, order.id] : current.filter(id => id !== order.id))} />
              <button className="cmhub-air-link" onClick={() => void openDetail(order)}>{order.billNo}</button>{statusTag(order.status)}</header>
            <dl><div><dt>来源</dt><dd>{order.sourceClientName}</dd></div><div><dt>预报</dt><dd>{order.forecastCartons}箱 · {order.forecastPackages}包 · {order.forecastWeight}{order.forecastWeightUnit}</dd></div><div><dt>换单</dt><dd><ExchangeProgress order={order} /></dd></div><div><dt>凭证</dt><dd>{evidenceTag(order)}</dd></div></dl>
            <footer>
              <Button size="small" onClick={() => void openDetail(order)}>详情</Button>
              {canEdit && order.status === 'RECORDED' && <Button size="small" onClick={() => openEdit(order)}>编辑</Button>}
              {canReceive && order.status === 'RECORDED' && <Button size="small" type="primary" onClick={() => openReceipt([order])}>入库</Button>}
              {canCorrect && order.status === 'RECORDED' && <Button size="small" status="danger" onClick={() => setVoidTarget(order)}>作废</Button>}
              {canHandover && order.status === 'RECEIVED' && !order.handoverBatchId && <Button size="small" type="primary" onClick={() => { setHandoverOrderIds([order.id]); handoverForm.setFieldsValue({ handedOverAt: localDateTimeValue() }); setHandoverOpen(true); }}>交仓</Button>}
              {canAddEvidence && order.status === 'HANDED_OVER' && order.evidenceStatus !== 'COMPLETE' && order.handoverBatchId && <Button size="small" onClick={() => void openBatch(order.handoverBatchId!)}>补凭证</Button>}
            </footer>
          </article>)}
          {!loading && !orders.length && <Empty description="暂无提货单" />}
          {total > 20 && <div className="cmhub-air-mobile-pagination"><Button disabled={page <= 1} onClick={() => setPage(current => current - 1)}>上一页</Button><span>{page} / {Math.ceil(total / 20)}</span><Button disabled={page >= Math.ceil(total / 20)} onClick={() => setPage(current => current + 1)}>下一页</Button></div>}
        </div>
      </Card>

      <Modal title={editingOrder ? `编辑 ${editingOrder.billNo}` : '录入空运提货单'} visible={editorOpen} confirmLoading={saving}
        okText={editingOrder ? '保存修改' : '保存并录入'} onCancel={() => { setEditorOpen(false); form.resetFields(); }} onOk={() => form.submit()} unmountOnExit={false}>
        <Form form={form} layout="vertical" onValuesChange={(_, values) => {
          if (!editingOrder) localStorage.setItem(DRAFT_KEY, JSON.stringify({ savedAt: Date.now(), values }));
        }} onSubmit={async values => {
          setSaving(true);
          try {
            const input = values as { clientId?: string; billNo?: string; cargoName?: string; forecastCartons: number; forecastPackages: number;
              forecastWeight: number; forecastWeightUnit: AirWeightUnit; remarks?: string };
            if (editingOrder) await updateAirPickup(editingOrder.id, { ...input, expectedVersion: editingOrder.version });
            else await createAirPickup(input as Parameters<typeof createAirPickup>[0]);
            localStorage.removeItem(DRAFT_KEY); setEditorOpen(false); setEditingOrder(null); form.resetFields();
            Message.success(editingOrder ? '提货单已更新' : '提货单已录入'); await load();
          } catch (cause) { Message.error(cause instanceof Error ? cause.message : '保存失败。'); }
          finally { setSaving(false); }
        }}>
          {!editingOrder && <Form.Item label="提货单号" field="billNo" rules={[{ required: true, message: '请输入提货单号' }]} extra="大小写、空格和连字符不影响唯一性；标准11位数字会显示为 180-98109734。">
            <Input maxLength={32} placeholder="例如 180-98109734" autoFocus />
          </Form.Item>}
          {!editingOrder && <Form.Item label="来源客户" field="clientId" rules={[{ required: true, message: '请选择来源客户' }]} extra="来源用于关联上游批次；仓库内所有授权账号仍可共同操作。">
            <Select showSearch placeholder="选择客户" options={clients.map(client => ({ label: `${client.name} · ${client.code}`, value: client.id }))} />
          </Form.Item>}
          <Form.Item label="货物名称" field="cargoName"><Input maxLength={100} placeholder="选填" /></Form.Item>
          <div className="cmhub-form-grid cmhub-air-form-grid">
            <Form.Item label="预报箱数" field="forecastCartons" rules={[{ required: true }]}><InputNumber min={1} max={999999} precision={0} /></Form.Item>
            <Form.Item label="预报包裹数" field="forecastPackages" rules={[{ required: true }]}><InputNumber min={1} max={999999} precision={0} /></Form.Item>
            <Form.Item label="预报重量" field="forecastWeight" rules={[{ required: true }]}><InputNumber min={0.001} precision={3} /></Form.Item>
            <Form.Item label="单位" field="forecastWeightUnit" rules={[{ required: true }]}><Select options={[{ label: 'KG', value: 'KG' }, { label: 'LB', value: 'LB' }]} /></Form.Item>
          </div>
          <Form.Item label="备注" field="remarks"><Input.TextArea maxLength={200} showWordLimit autoSize={{ minRows: 3, maxRows: 5 }} /></Form.Item>
        </Form>
      </Modal>

      <Modal className="cmhub-air-receipt-modal" title={`批量入库确认 · ${Object.keys(receiptDrafts).length} 单`} visible={receiptOpen} style={{ width: 1180 }}
        okText="整批确认入库" unmountOnExit onCancel={closeReceiptEditor} onOk={async () => {
          const selected = Object.entries(receiptDrafts);
          const unavailable = selected.find(([id]) => !orders.some(order => order.id === id));
          if (unavailable) { Message.error('提货单列表已刷新，请重新打开入库窗口后再提交。'); return; }
          const missing = selected.find(([id, draft]) => differs(orders.find(order => order.id === id)!, draft) && !draft.differenceReason.trim());
          if (missing) { Message.error(`${orders.find(order => order.id === missing[0])?.billNo} 实际值有差异，请填写差异说明。`); return; }
          setSaving(true);
          try {
            const hadReceiptEvidence = receiptEvidence.length > 0;
            const batch = await createAirReceiptBatch({ receivedAt: new Date(receiptReceivedAt).toISOString(), orders: selected.map(([orderId, draft]) => ({ orderId, ...draft, differenceReason: draft.differenceReason || undefined })) });
            let failedUploads = 0;
            for (const evidence of receiptEvidence) {
              try {
                await uploadAirReceiptEvidence(batch.id, { file: evidence.file, qualityWarnings: evidence.warnings, qualityOverride: evidence.qualityOverride });
              } catch { failedUploads += 1; }
            }
            closeReceiptEditor(); setSelectedIds([]);
            if (failedUploads) Message.warning(`整批入库成功；${failedUploads} 张入库照上传失败，可在详情中查看已保存照片。`);
            else Message.success(hadReceiptEvidence ? '整批入库及入库照已保存' : '整批入库成功');
            await load();
          } catch (cause) { Message.error(cause instanceof Error ? cause.message : '批量入库失败，整批未保存。'); }
          finally { setSaving(false); }
        }} confirmLoading={saving}>
        <Alert type="info" content="实际值默认带入预报值；任一项改变后，该单的差异说明必须填写。提交采用整批事务。" />
        <div className="cmhub-air-receipt-layout">
          <main>
            <label className="cmhub-air-common-time">共同入库时间<Input type="datetime-local" value={receiptReceivedAt} onChange={setReceiptReceivedAt} /></label>
            <div className="cmhub-air-receipt-list">
              {selectExistingRecordsById(orders, Object.keys(receiptDrafts)).map(order => {
                const id = order.id;
                const draft = receiptDrafts[id];
                const changed = differs(order, draft);
                const update = (patch: Partial<ReceiptDraft>) => setReceiptDrafts(current => ({ ...current, [id]: { ...current[id], ...patch } }));
                return <div className="cmhub-air-receipt-row" data-variance={changed || undefined} key={id}>
                  <header><strong>{order.billNo}</strong><Tag color={changed ? 'orange' : 'green'}>{changed ? '检测到差异' : '数据一致'}</Tag></header>
                  <div className="cmhub-air-receipt-forecast"><small>预报</small><span>{order.forecastCartons}箱 · {order.forecastPackages}包 · {order.forecastWeight}{order.forecastWeightUnit}</span></div>
                  <label>实际箱数<InputNumber min={1} max={999999} precision={0} value={draft.actualCartons} onChange={value => update({ actualCartons: Number(value) })} /></label>
                  <label>实际包裹数<InputNumber min={1} max={999999} precision={0} value={draft.actualPackages} onChange={value => update({ actualPackages: Number(value) })} /></label>
                  <label>实际重量<InputNumber min={0.001} precision={3} value={draft.actualWeight} onChange={value => update({ actualWeight: Number(value) })} /></label>
                  <label>单位<Select value={draft.actualWeightUnit} options={[{ label: 'KG', value: 'KG' }, { label: 'LB', value: 'LB' }]} onChange={value => update({ actualWeightUnit: value as AirWeightUnit })} /></label>
                  <label className="cmhub-air-difference">差异说明{changed && <i>*</i>}<Input maxLength={500} value={draft.differenceReason} onChange={value => update({ differenceReason: value })} placeholder={changed ? '请说明实际与预报差异' : '无差异，可不填'} /></label>
                </div>;
              })}
            </div>
          </main>
          <aside>
            <section className="cmhub-air-receipt-evidence-picker">
              <div><strong>本批入库照片</strong><span>选填，0～9张 · JPG/JPEG/PNG · 单张≤10MB</span></div>
              <Button icon={<ImagePlus size={15} />} disabled={receiptEvidence.length >= 9} onClick={() => receiptInput.current?.click()}>添加入库照</Button>
              <input ref={receiptInput} hidden type="file" multiple accept="image/jpeg,image/png,.jpg,.jpeg,.png" onChange={event => void handleReceiptEvidenceFiles(event.target.files)} />
              {receiptEvidence.length > 0 && <div className="cmhub-air-pending-evidence-grid">
                {receiptEvidence.map((item, index) => <article key={`${item.file.name}-${index}`}>
                  <img src={item.previewUrl} alt={`入库照 ${item.file.name}`} />
                  <span title={item.file.name}>{item.file.name}</span>
                  <Button size="mini" status="danger" onClick={() => setReceiptEvidence(current => current.filter((candidate, candidateIndex) => {
                    if (candidateIndex === index) URL.revokeObjectURL(candidate.previewUrl);
                    return candidateIndex !== index;
                  }))}>移除</Button>
                </article>)}
              </div>}
              {!receiptEvidence.length && <button className="cmhub-air-receipt-photo-empty" type="button" onClick={() => receiptInput.current?.click()}><Camera size={28} /><span>拍照或选择图片</span><small>照片由本批提货单共同引用</small></button>}
            </section>
            <section className="cmhub-air-receipt-summary-card">
              <h3>确认摘要</h3>
              <dl><div><dt>提货单</dt><dd>{Object.keys(receiptDrafts).length}</dd></div><div><dt>已填写</dt><dd>{Object.values(receiptDrafts).filter(Boolean).length}</dd></div><div><dt>存在差异</dt><dd>{selectExistingRecordsById(orders, Object.keys(receiptDrafts)).filter(order => differs(order, receiptDrafts[order.id])).length}</dd></div><div><dt>入库照片</dt><dd>{receiptEvidence.length}</dd></div></dl>
            </section>
          </aside>
        </div>
      </Modal>

      <Modal title={handoverBatch ? `${handoverBatch.batchNo} · ${handoverBatch.status === 'DRAFT' ? '交仓草稿' : '已交仓'}` : `新建交仓批次 · ${handoverOrderIds.length} 单`}
        visible={handoverOpen} style={{ width: 960 }} footer={handoverBatch ? (
          <Space>
            <Button onClick={() => setHandoverOpen(false)}>关闭</Button>
            {(handoverBatch.status === 'DRAFT' || canCorrect) && <Button icon={<Pencil size={14} />} loading={handoverSaving} onClick={() => void openBatchEditor()}>{handoverBatch.status === 'DRAFT' ? '编辑批次' : '更正批次'}</Button>}
            {handoverBatch.status === 'DRAFT' && <Button type="primary" loading={handoverSaving} onClick={() => {
              Modal.confirm({ title: '整批确认交仓？', content: `将 ${handoverBatch.orders.length} 张提货单标记为已交仓。凭证不足不会阻塞，但会显示“凭证待补”。`,
                okText: '确认交仓', onOk: async () => { setHandoverSaving(true); try { setHandoverBatch(await confirmAirHandoverBatch(handoverBatch.id)); setSelectedIds([]); await load(); Message.success('整批交仓成功'); } finally { setHandoverSaving(false); } } });
            }}>确认交仓</Button>}
          </Space>
        ) : undefined} onCancel={() => { setHandoverOpen(false); setHandoverBatch(null); }}
        onOk={handoverBatch ? undefined : () => handoverForm.submit()} confirmLoading={handoverSaving} okText="创建交仓草稿" unmountOnExit={false}>
        {!handoverBatch ? <Form form={handoverForm} layout="vertical" onSubmit={async values => {
          setHandoverSaving(true);
          try {
            const batch = await createAirHandoverBatch({ orderIds: handoverOrderIds, ...(values as Record<string, string>) });
            setHandoverBatch(batch); Message.success('交仓草稿已创建，可先上传凭证再确认'); await load(true);
          } catch (cause) { Message.error(cause instanceof Error ? cause.message : '交仓草稿创建失败，整批未保存。'); }
          finally { setHandoverSaving(false); }
        }}>
          <Alert type="info" content="同一台卡车可包含最多200张提货单。草稿全局可见；同一提货单不能加入两个交仓批次。" />
          <div className="cmhub-form-grid">
            <Form.Item label="车牌号" field="vehicleNo"><Input maxLength={64} placeholder="选填" /></Form.Item>
            <Form.Item label="司机姓名" field="driverName"><Input maxLength={100} placeholder="选填" /></Form.Item>
            <Form.Item label="司机电话" field="driverPhone"><Input maxLength={32} placeholder="选填" /></Form.Item>
            <Form.Item label="共同交仓时间" field="handedOverAt" rules={[{ required: true }]}><Input type="datetime-local" /></Form.Item>
          </div>
          <div className="cmhub-air-selected-bills">{handoverOrderIds.map(id => orders.find(order => order.id === id)).filter(Boolean).map(order => <Tag key={order!.id}>{order!.billNo}</Tag>)}</div>
        </Form> : <div className="cmhub-air-handover-workspace">
          <Descriptions column={3} size="small" border data={[
            { label: '提货单', value: `${handoverBatch.orders.length} 单` },
            { label: '车牌', value: handoverBatch.vehicleNo || '未填写' },
            { label: '交仓时间', value: formatDate(handoverBatch.handedOverAt) },
          ]} />
          <Alert type={handoverBatch.evidence.some(item => item.type === 'POD') && handoverBatch.evidence.filter(item => item.type === 'LOADING').length >= 3 ? 'success' : 'warning'}
            content={`完整凭证标准：POD至少1张＋装车照至少3张。当前 POD ${handoverBatch.evidence.filter(item => item.type === 'POD').length} 张，装车照 ${handoverBatch.evidence.filter(item => item.type === 'LOADING').length} 张。`} />
          {(['POD', 'LOADING'] as const).map(type => <section className="cmhub-air-evidence-section" key={type}>
            <div className="cmhub-air-evidence-heading"><div><strong>{type === 'POD' ? 'POD 凭证' : '装车照片'}</strong><span>0～9张 · JPG/PNG · 单张≤10MB · 至少800×600</span></div>
              {canAddEvidence && <Button icon={<ImagePlus size={15} />} loading={handoverSaving} onClick={() => (type === 'POD' ? podInput : loadingInput).current?.click()}>添加图片</Button>}</div>
            <input ref={type === 'POD' ? podInput : loadingInput} hidden type="file" multiple accept="image/jpeg,image/png,.jpg,.jpeg,.png" onChange={event => void handleEvidenceFiles(type, event.target.files)} />
            <div className="cmhub-air-evidence-grid">
              {handoverBatch.evidence.filter(item => item.type === type).map(asset => <article key={asset.id}>
                <EvidenceThumbnail asset={asset} onPreview={previewEvidence} />
                {canManageEvidence && <Button size="mini" status="danger" onClick={() => setRemoveAsset(asset)}>移除</Button>}
              </article>)}
              {!handoverBatch.evidence.some(item => item.type === type) && <Empty description="暂未上传" />}
            </div>
          </section>)}
        </div>}
      </Modal>

      <Modal title={handoverBatch?.status === 'CONFIRMED' ? '更正已确认交仓批次' : '编辑交仓草稿'} visible={batchEditOpen}
        style={{ width: 720 }} okText={handoverBatch?.status === 'CONFIRMED' ? '验证并保存更正' : '保存草稿'} confirmLoading={handoverSaving}
        onCancel={() => { setBatchEditOpen(false); batchEditForm.resetFields(); }} onOk={() => batchEditForm.submit()} unmountOnExit={false}>
        {handoverBatch?.status === 'CONFIRMED' && <Alert type="warning" content="已确认批次的成员、车辆或时间更正需要主管权限、原因和当前账户密码。移出的提货单会恢复为“已入库”。" />}
        <Form form={batchEditForm} layout="vertical" onSubmit={async values => {
          if (!handoverBatch) return;
          const input = values as { orderIds: string[]; vehicleNo?: string; driverName?: string; driverPhone?: string;
            handedOverAt: string; reason?: string; password?: string };
          setHandoverSaving(true);
          try {
            const updated = await updateAirHandoverBatch(handoverBatch.id, { ...input, handedOverAt: new Date(input.handedOverAt).toISOString(), expectedVersion: handoverBatch.version });
            setHandoverBatch(updated); setBatchEditOpen(false); batchEditForm.resetFields(); await load(true);
            Message.success(handoverBatch.status === 'CONFIRMED' ? '批次更正已保存并记录审计' : '交仓草稿已更新');
          } catch (cause) { Message.error(cause instanceof Error ? cause.message : '批次更新失败，整批未保存。'); }
          finally { setHandoverSaving(false); }
        }}>
          <Form.Item label="批次提货单" field="orderIds" rules={[{ required: true, message: '至少保留1张提货单' }]} extra="可选择当前已入库且未加入其他交仓批次的提货单，最多200单。">
            <Select mode="multiple" showSearch maxTagCount={6} options={batchCandidates.map(order => ({ label: order.billNo, value: order.id }))} />
          </Form.Item>
          <div className="cmhub-form-grid">
            <Form.Item label="车牌号" field="vehicleNo"><Input maxLength={64} /></Form.Item>
            <Form.Item label="司机姓名" field="driverName"><Input maxLength={100} /></Form.Item>
            <Form.Item label="司机电话" field="driverPhone"><Input maxLength={32} /></Form.Item>
            <Form.Item label="共同交仓时间" field="handedOverAt" rules={[{ required: true }]}><Input type="datetime-local" /></Form.Item>
          </div>
          {handoverBatch?.status === 'CONFIRMED' && <>
            <Form.Item label="更正原因" field="reason" rules={[{ required: true }]}><Input.TextArea maxLength={500} /></Form.Item>
            <Form.Item label="当前账户密码" field="password" rules={[{ required: true }]}><Input.Password /></Form.Item>
          </>}
        </Form>
      </Modal>

      <Drawer className="cmhub-air-detail-drawer" title={<div className="cmhub-air-detail-title"><strong>{detailOrder?.billNo ?? '提货单详情'}</strong><span>{detailOrder?.sourceClientName ?? '正在加载来源客户'}</span></div>} visible={Boolean(detailOrder)} width={720}
        onCancel={() => setDetailOrder(null)} footer={detailOrder && <Space>
          {canCorrect && detailOrder.status !== 'VOIDED' && !detailOrder.handoverBatchId && <Button status="danger" icon={<ShieldAlert size={14} />} onClick={() => setVoidTarget(detailOrder)}>作废</Button>}
          {detailOrder.handoverBatchId && <Button icon={<Archive size={14} />} onClick={() => void openBatch(detailOrder.handoverBatchId!)}>查看交仓批次</Button>}
        </Space>}>
        {detailLoading ? <div className="cmhub-module-loading"><Spin />正在加载详情…</div> : detailOrder && <div className="cmhub-air-detail">
          <Space>{statusTag(detailOrder.status)}{evidenceTag(detailOrder)}{!detailOrder.billNoIsStandard && <Tag color="orange">非标准单号</Tag>}</Space>
          <Descriptions column={1} border size="small" data={[
            { label: '来源客户', value: detailOrder.sourceClientName },
            { label: '来源方式', value: detailOrder.sourceType === 'UPSTREAM' ? `上游接口${detailOrder.externalBatchId ? ` · ${detailOrder.externalBatchId}` : ''}` : '人工录入' },
            { label: '预报', value: `${detailOrder.forecastCartons}箱 · ${detailOrder.forecastPackages}包 · ${detailOrder.forecastWeight}${detailOrder.forecastWeightUnit}` },
            { label: '换单进度', value: <ExchangeProgress order={detailOrder} /> },
            { label: '实际', value: detailOrder.actualCartons ? `${detailOrder.actualCartons}箱 · ${detailOrder.actualPackages}包 · ${detailOrder.actualWeight}${detailOrder.actualWeightUnit}` : '尚未入库' },
            { label: '差异说明', value: detailOrder.differenceReason || '—' },
            { label: '入库批次', value: detailOrder.receiptBatchNo || '—' },
            { label: '交仓批次', value: detailOrder.handoverBatchNo || '—' },
            { label: '备注', value: detailOrder.remarks || '—' },
          ]} />
          {(detailOrder.receiptEvidence?.length ?? 0) > 0 && <section className="cmhub-air-detail-evidence">
            <h3>入库照片</h3>
            <div className="cmhub-air-detail-evidence-grid">{detailOrder.receiptEvidence!.map(asset => <EvidenceThumbnail key={asset.id} asset={asset} onPreview={previewEvidence} />)}</div>
          </section>}
          {(detailOrder.handoverEvidence?.length ?? 0) > 0 && <section className="cmhub-air-detail-evidence">
            <h3>交仓凭证</h3>
            <div className="cmhub-air-detail-evidence-grid">{detailOrder.handoverEvidence!.map(asset => <EvidenceThumbnail key={asset.id} asset={asset} onPreview={previewEvidence} />)}</div>
          </section>}
          <h3>流转记录</h3>
          <Timeline>{detailOrder.events?.map(event => <Timeline.Item key={event.revision} label={formatDate(event.occurredAt)}>
            <strong>{eventLabels[event.type] ?? event.type}</strong>{event.reason && <p>{event.reason}</p>}
            {(event.evidence?.length ?? 0) > 0 && <div className="cmhub-air-event-evidence">{event.evidence!.map(asset => <EvidenceThumbnail key={asset.id} asset={asset} onPreview={previewEvidence} />)}</div>}
          </Timeline.Item>)}</Timeline>
        </div>}
      </Drawer>

      <Modal title="凭证预览" visible={Boolean(previewUrl)} footer={null} onCancel={() => { if (previewUrl) URL.revokeObjectURL(previewUrl); setPreviewUrl(null); }}>
        {previewUrl && <img className="cmhub-air-preview" src={previewUrl} alt="交仓凭证预览" />}
      </Modal>

      <Modal title="移除凭证" visible={Boolean(removeAsset)} okText="验证并移除" okButtonProps={{ status: 'danger' }} onCancel={() => { setRemoveAsset(null); removeForm.resetFields(); }} onOk={() => removeForm.submit()}>
        <Form form={removeForm} layout="vertical" onSubmit={async values => {
          if (!removeAsset || !handoverBatch) return;
          try { await removeAirEvidence(removeAsset.id, values as { password: string; reason: string }); setRemoveAsset(null); removeForm.resetFields(); setHandoverBatch(await getAirHandoverBatch(handoverBatch.id)); await load(true); Message.success('凭证已从业务视图移除，审计记录已保留'); }
          catch (cause) { Message.error(cause instanceof Error ? cause.message : '凭证移除失败。'); }
        }}>
          <Alert type="warning" content="此操作需要主管/系统管理员权限、当前账户密码和原因。原文件按留存策略保留。" />
          <Form.Item label="操作原因" field="reason" rules={[{ required: true }]}><Input.TextArea maxLength={500} /></Form.Item>
          <Form.Item label="当前账户密码" field="password" rules={[{ required: true }]}><Input.Password /></Form.Item>
        </Form>
      </Modal>

      <Modal title={`作废 ${voidTarget?.billNo ?? ''}`} visible={Boolean(voidTarget)} okText="验证并作废" okButtonProps={{ status: 'danger' }} onCancel={() => { setVoidTarget(null); voidForm.resetFields(); }} onOk={() => voidForm.submit()}>
        <Form form={voidForm} layout="vertical" onSubmit={async values => {
          if (!voidTarget) return;
          try { await voidAirPickup(voidTarget.id, values as { password: string; reason: string }); setVoidTarget(null); setDetailOrder(null); voidForm.resetFields(); await load(); Message.success('提货单已作废'); }
          catch (cause) { Message.error(cause instanceof Error ? cause.message : '作废失败。'); }
        }}>
          <Alert type="warning" content="作废是异常状态，不会删除历史记录。请输入原因并验证当前账户密码。" />
          <Form.Item label="作废原因" field="reason" rules={[{ required: true }]}><Input.TextArea maxLength={500} /></Form.Item>
          <Form.Item label="当前账户密码" field="password" rules={[{ required: true }]}><Input.Password /></Form.Item>
        </Form>
      </Modal>
    </section>
  );
}
