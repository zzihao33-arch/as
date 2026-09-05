import {
  Alert,
  Button,
  Card,
  Checkbox,
  DatePicker,
  Descriptions,
  Drawer,
  Empty,
  Form,
  Input,
  InputNumber,
  Pagination,
  Progress,
  Select,
  Space,
  Loading as Spin,
  Tabs,
  Tag,
  Table,
  Timeline,
  Dialog as Modal,
  DialogPlugin,
  MessagePlugin as Message,
  Textarea,
} from 'tdesign-react';
import {
  Archive,
  Camera,
  ChevronRight,
  CheckCircle2,
  CircleAlert,
  Download,
  Eye,
  FileCheck2,
  FileText,
  FileUp,
  ImagePlus,
  ImageOff,
  PackageCheck,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  ShieldAlert,
  Truck,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useWorkbenchMotion } from '../features/motion/useWorkbenchMotion';
import {
  confirmAirHandoverBatch,
  createAirHandoverBatch,
  createAirPickup,
  createCustomerProfile,
  createAirReceiptBatch,
  downloadAirEvidence,
  downloadAirPickupDocument,
  deleteCustomerProfile,
  getAirHandoverBatch,
  getAirPickup,
  listAirPickups,
  listCustomerProfiles,
  removeAirEvidence,
  removeAirPickupDocument,
  updateAirPickup,
  updateAirHandoverBatch,
  uploadAirHandoverEvidence,
  uploadAirPickupDocument,
  uploadAirReceiptEvidence,
  voidAirPickup,
  type AirEvidenceStatus,
  type AirHandoverBatch,
  type AirHandoverEvidence,
  type AirPickupOrder,
  type AirPickupDocument,
  type AirPickupSummary,
  type AirPickupStatus,
  type AirWeightUnit,
  type CustomerProfile,
} from '../features/session/warehouseApi';
import { normalizeEvidenceImage } from '../features/airPickup/evidenceImage';
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
  ORDER_RECORDED: '录入提单', ORDER_EDITED: '编辑预报信息', ORDER_RECEIVED: '确认入库',
  HANDOVER_DRAFT_CREATED: '加入交仓批次', EVIDENCE_ADDED: '补充交仓凭证',
  EVIDENCE_REMOVED: '移除交仓凭证', ORDER_HANDED_OVER: '确认交仓', ORDER_VOIDED: '作废提货单',
  ORDER_CORRECTED: '更正提货单',
  RECEIPT_EVIDENCE_ADDED: '补充入库照片',
  PICKUP_DOCUMENT_ADDED: '上传提货文件', PICKUP_DOCUMENT_REMOVED: '移除提货文件',
};

function statusTag(status: AirPickupStatus) {
  const theme = status === 'RECORDED' ? 'primary' : status === 'RECEIVED' ? 'warning' : status === 'HANDED_OVER' ? 'success' : 'default';
  return <Tag theme={theme}>{statusLabels[status]}</Tag>;
}

function evidenceTag(order: AirPickupOrder) {
  if (order.evidenceStatus === 'COMPLETE') return <Tag theme="success">凭证完整</Tag>;
  if (order.status === 'HANDED_OVER') return <Tag theme="warning">凭证待补</Tag>;
  if (order.evidenceStatus === 'PARTIAL') return <Tag theme="primary">已有部分凭证</Tag>;
  return <Tag className="cmhub-air-tag-neutral">凭证未生成</Tag>;
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

function formatWarehouseSyncTime(value: string) {
  const parts = Object.fromEntries(warehouseFullDateTimeFormatter
    .formatToParts(new Date(value))
    .map(part => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
}

function localDateTimeValue(value: string | null = null) {
  const date = value ? new Date(value) : new Date();
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

function ExchangeProgress({ order }: { order: AirPickupOrder }) {
  const progress = order.exchangeProgress;
  if (!progress.total) return <span className="cmhub-air-progress-empty">换单数据待录入</span>;
  const percent = Math.min(100, Math.round((progress.processed / progress.total) * 100));
  return <div className="cmhub-air-progress" aria-label={`换单进度 ${progress.processed} / ${progress.total}，${percent}%`}>
    <div className="cmhub-air-progress-heading"><strong>{progress.processed.toLocaleString()} / {progress.total.toLocaleString()}</strong><span>{percent}%</span></div>
    <Progress percentage={percent} label={<span />} size="small" status={progress.exceptions ? 'warning' : percent === 100 ? 'success' : 'active'} />
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
  const [thumbnailStatus, setThumbnailStatus] = useState<'loading' | 'ready' | 'unavailable'>('loading');
  useEffect(() => {
    const node = containerRef.current;
    if (!node) return undefined;
    let disposed = false;
    let objectUrl = '';
    const load = async () => {
      try {
        setThumbnailStatus('loading');
        const blob = await downloadAirEvidence(asset.downloadPath);
        if (disposed) return;
        objectUrl = URL.createObjectURL(blob);
        setThumbnailUrl(objectUrl);
        setThumbnailStatus('ready');
      } catch {
        if (!disposed) setThumbnailStatus('unavailable');
      }
    };
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) { observer.disconnect(); void load(); }
    }, { rootMargin: '120px' });
    observer.observe(node);
    return () => { disposed = true; observer.disconnect(); if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [asset.downloadPath]);
  return <button ref={containerRef} className="cmhub-air-evidence-thumb" onClick={() => onPreview(asset)} aria-label={thumbnailStatus === 'unavailable' ? `${asset.filename} 预览文件不可用` : `预览 ${asset.filename}`}>
    {thumbnailUrl && thumbnailStatus === 'ready'
      ? <img src={thumbnailUrl} alt="" loading="lazy" onError={() => setThumbnailStatus('unavailable')} />
      : <span className="cmhub-air-evidence-placeholder">
        {thumbnailStatus === 'unavailable' ? <ImageOff size={20} aria-hidden="true" /> : <Camera size={20} aria-hidden="true" />}
        <small>{thumbnailStatus === 'unavailable' ? '文件不可用' : '正在加载'}</small>
      </span>}
    <small>{asset.filename}</small>
  </button>;
}

function HandoverConfirmationPanel({ batch }: { batch: AirHandoverBatch }) {
  const podCount = batch.evidence.filter(item => item.type === 'POD').length;
  const loadingCount = batch.evidence.filter(item => item.type === 'LOADING').length;
  const evidenceComplete = podCount >= 1 && loadingCount >= 3;

  return <div className="cmhub-air-handover-confirm-content">
    <div className="cmhub-air-handover-confirm-hero">
      <span aria-hidden="true"><Truck size={22} /></span>
      <div>
        <h3>确认 {batch.orders.length} 张提货单已完成交仓</h3>
        <p>提交后，批次和所含提货单将统一更新为“已交仓”</p>
      </div>
    </div>
    <dl className="cmhub-air-handover-confirm-summary">
      <div><dt>交仓批次</dt><dd>{batch.batchNo}</dd></div>
      <div><dt>提货单</dt><dd>{batch.orders.length} 单</dd></div>
      <div><dt>交仓时间</dt><dd>{formatDate(batch.handedOverAt)}</dd></div>
      <div><dt>凭证状态</dt><dd>{evidenceComplete ? '已完整' : '待补充'}</dd></div>
    </dl>
    <div className="cmhub-air-handover-confirm-note" data-state={evidenceComplete ? 'complete' : 'pending'}>
      <CircleAlert size={18} aria-hidden="true" />
      <span>{evidenceComplete
        ? `当前已上传 POD ${podCount} 张、装车照 ${loadingCount} 张，满足完整凭证标准`
        : `当前 POD ${podCount} 张、装车照 ${loadingCount} 张凭证不足不会阻塞交仓，系统将标记为“凭证待补”`}</span>
    </div>
  </div>;
}

export default function AirPickupPage() {
  const warehouseSession = useWarehouseSession();
  const navigate = useNavigate();
  const motionScopeRef = useRef<HTMLElement>(null);
  const [orders, setOrders] = useState<AirPickupOrder[]>([]);
  const [summary, setSummary] = useState<AirPickupSummary>(emptySummary);
  const [customers, setCustomers] = useState<CustomerProfile[]>([]);
  const [customersLoaded, setCustomersLoaded] = useState(false);
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
  const [customerCreateOpen, setCustomerCreateOpen] = useState(false);
  const [customerManagerOpen, setCustomerManagerOpen] = useState(false);
  const [customerSaving, setCustomerSaving] = useState(false);
  const [customerActionBusy, setCustomerActionBusy] = useState('');
  const [receiptOpen, setReceiptOpen] = useState(false);
  const [receiptDrafts, setReceiptDrafts] = useState<Record<string, ReceiptDraft>>({});
  const [receiptReceivedAt, setReceiptReceivedAt] = useState(localDateTimeValue());
  const [receiptEvidence, setReceiptEvidence] = useState<PendingReceiptEvidence[]>([]);
  const [pickupDocuments, setPickupDocuments] = useState<File[]>([]);
  const [handoverOpen, setHandoverOpen] = useState(false);
  const [handoverOrderIds, setHandoverOrderIds] = useState<string[]>([]);
  const [handoverBatch, setHandoverBatch] = useState<AirHandoverBatch | null>(null);
  const [handoverSaving, setHandoverSaving] = useState(false);
  const [handoverConfirmOpen, setHandoverConfirmOpen] = useState(false);
  const [batchEditOpen, setBatchEditOpen] = useState(false);
  const [batchCandidates, setBatchCandidates] = useState<AirPickupOrder[]>([]);
  const [detailOrder, setDetailOrder] = useState<AirPickupOrder | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailDocumentSaving, setDetailDocumentSaving] = useState(false);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [removeAsset, setRemoveAsset] = useState<AirHandoverEvidence | null>(null);
  const [removeDocument, setRemoveDocument] = useState<AirPickupDocument | null>(null);
  const [voidTarget, setVoidTarget] = useState<AirPickupOrder | null>(null);
  const [form] = Form.useForm();
  const [customerForm] = Form.useForm();
  const [handoverForm] = Form.useForm();
  const [removeForm] = Form.useForm();
  const [removeDocumentForm] = Form.useForm();
  const [voidForm] = Form.useForm();
  const [batchEditForm] = Form.useForm();
  const podInput = useRef<HTMLInputElement>(null);
  const loadingInput = useRef<HTMLInputElement>(null);
  const receiptInput = useRef<HTMLInputElement>(null);
  const pickupDocumentInput = useRef<HTMLInputElement>(null);
  const detailPickupDocumentInput = useRef<HTMLInputElement>(null);

  const canCreate = warehouseSession.hasPermission('air_pickups.create');
  const canEdit = warehouseSession.hasPermission('air_pickups.edit');
  const canReceive = warehouseSession.hasPermission('air_pickups.receive');
  const canHandover = warehouseSession.hasPermission('air_pickups.handover');
  const canAddEvidence = warehouseSession.hasPermission('air_pickups.evidence.add');
  const canManageEvidence = warehouseSession.hasPermission('air_pickups.evidence.manage');
  const canCorrect = warehouseSession.hasPermission('air_pickups.correct');
  const canManageCustomers = warehouseSession.hasPermission('customers.manage');
  const canViewDocuments = warehouseSession.hasPermission('bol.view');
  const motionTabKey = `records:${status}:${evidenceStatus}`;

  useWorkbenchMotion(motionScopeRef, { tabKey: motionTabKey });

  const load = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true);
    setError('');
    try {
      const result = await listAirPickups({ search, customerId: clientFilter || undefined, status, evidenceStatus, page, pageSize: 20 });
      setOrders(result.data);
      setTotal(result.pagination.total);
      setSummary(result.summary);
      setSelectedIds(current => current.filter(id => result.data.some(order => order.id === id)));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '提货单数据加载失败');
    } finally {
      if (!quiet) setLoading(false);
    }
  }, [clientFilter, evidenceStatus, page, search, status]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (customersLoaded) return;
    void listCustomerProfiles().then(data => { setCustomers(data); setCustomersLoaded(true); }).catch(() => undefined);
  }, [customersLoaded]);
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
  const applyListFilter = (nextStatus: AirPickupStatus | '', nextEvidenceStatus: AirEvidenceStatus | '' = '') => {
    setStatus(nextStatus);
    setEvidenceStatus(nextEvidenceStatus);
    setPage(1);
    setSelectedIds([]);
  };

  const openCreate = async () => {
    setEditingOrder(null);
    setPickupDocuments([]);
    let initial: { customerId?: string; forecastCartons: number; forecastPackages: number; forecastWeightUnit: AirWeightUnit } = {
      forecastCartons: 1, forecastPackages: 1, forecastWeightUnit: 'KG',
    };
    try {
      const draft = JSON.parse(localStorage.getItem(DRAFT_KEY) ?? 'null') as { savedAt: number; values: typeof initial } | null;
      if (draft && Date.now() - draft.savedAt <= DRAFT_TTL) initial = { ...initial, ...draft.values };
    } catch { /* invalid local draft is ignored */ }
    try {
      const availableCustomers = customersLoaded ? customers : await listCustomerProfiles();
      setCustomers(availableCustomers);
      setCustomersLoaded(true);
      if (availableCustomers.length === 1) initial = { ...initial, customerId: availableCustomers[0].id };
    } catch (cause) {
      Message.error(cause instanceof Error ? cause.message : '客户档案加载失败');
      return;
    }
    form.setFieldsValue(initial);
    setEditorOpen(true);
  };

  const openEdit = (order: AirPickupOrder) => {
    setEditingOrder(order);
    setPickupDocuments([]);
    form.setFieldsValue({ cargoName: order.cargoName ?? '', forecastCartons: order.forecastCartons,
      forecastPackages: order.forecastPackages, forecastWeight: order.forecastWeight,
      forecastWeightUnit: order.forecastWeightUnit, remarks: order.remarks ?? '' });
    setEditorOpen(true);
  };

  const confirmDeleteCustomer = (customer: CustomerProfile) => {
    DialogPlugin.confirm({
      header: `删除 ${customer.name}？`,
      body: '仅未绑定系统对接且没有提货单记录的客户可以删除删除后，该客户将不再出现在归属客户列表中',
      confirmBtn: { content: '确认删除', theme: 'danger' },
      onConfirm: async () => {
        setCustomerActionBusy(customer.id);
        try {
          await deleteCustomerProfile(customer.id);
          setCustomers(current => current.filter(item => item.id !== customer.id));
          if (clientFilter === customer.id) setClientFilter('');
          form.setFieldsValue({ customerId: undefined });
          Message.success(`${customer.name} 已删除`);
        } catch (cause) {
          Message.error(cause instanceof Error ? cause.message : '客户删除失败');
          throw cause;
        } finally { setCustomerActionBusy(''); }
      },
    });
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
    if (receiptEvidence.length + files.length > 9) { Message.error('入库照最多 9 张'); return; }
    const accepted: PendingReceiptEvidence[] = [];
    try {
      for (const original of Array.from(files)) {
        if (!['image/jpeg', 'image/png'].includes(original.type)) throw new Error(`${original.name} 不是 JPG、JPEG 或 PNG 图片`);
        const normalized = await normalizeEvidenceImage(original);
        const qualityOverride = normalized.warnings.length
          ? window.confirm(`${original.name}：${normalized.warnings.join('、')}是否确认仍然上传？`)
          : false;
        if (normalized.warnings.length && !qualityOverride) continue;
        accepted.push({ file: normalized.file, warnings: normalized.warnings, qualityOverride,
          previewUrl: URL.createObjectURL(normalized.file) });
      }
      setReceiptEvidence(current => [...current, ...accepted]);
    } catch (cause) {
      accepted.forEach(item => URL.revokeObjectURL(item.previewUrl));
      Message.error(cause instanceof Error ? cause.message : '入库照读取失败');
    } finally {
      if (receiptInput.current) receiptInput.current.value = '';
    }
  };

  const handlePickupDocumentFiles = (files: FileList | null) => {
    if (!files?.length) return;
    const supported = new Set(['pdf', 'doc', 'docx', 'xls', 'xlsx', 'csv']);
    const accepted = Array.from(files).filter(file => {
      const extension = file.name.split('.').pop()?.toLowerCase();
      if (!extension || !supported.has(extension)) { Message.error(`${file.name} 不是支持的提货文件`); return false; }
      if (file.size > 20 * 1024 * 1024) { Message.error(`${file.name} 超过 20MB 限制`); return false; }
      return true;
    });
    setPickupDocuments(current => {
      const next = [...current];
      for (const file of accepted) {
        if (next.length >= 10) { Message.error('每张提货单最多上传 10 个提货文件'); break; }
        if (!next.some(item => item.name === file.name && item.size === file.size && item.lastModified === file.lastModified)) next.push(file);
      }
      return next;
    });
    if (pickupDocumentInput.current) pickupDocumentInput.current.value = '';
  };

  const downloadPickupDocument = async (document: AirPickupDocument) => {
    try {
      const blob = await downloadAirPickupDocument(document.downloadPath);
      const url = URL.createObjectURL(blob);
      const anchor = window.document.createElement('a');
      anchor.href = url; anchor.download = document.filename; anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 0);
    } catch (cause) { Message.error(cause instanceof Error ? cause.message : '提货文件下载失败'); }
  };

  const handleDetailPickupDocumentFiles = async (files: FileList | null) => {
    if (!detailOrder || !files?.length) return;
    const supported = new Set(['pdf', 'doc', 'docx', 'xls', 'xlsx', 'csv']);
    const candidates = Array.from(files).filter(file => {
      const extension = file.name.split('.').pop()?.toLowerCase();
      return extension && supported.has(extension) && file.size <= 20 * 1024 * 1024;
    });
    if (candidates.length !== files.length) { Message.error('仅可上传 PDF、Word、Excel、CSV，且单个文件不超过 20MB'); }
    if (!candidates.length) return;
    if ((detailOrder.pickupDocuments?.length ?? 0) + candidates.length > 10) { Message.error('每张提货单最多上传 10 个提货文件'); return; }
    setDetailDocumentSaving(true);
    try {
      for (const file of candidates) await uploadAirPickupDocument(detailOrder.id, file);
      setDetailOrder(await getAirPickup(detailOrder.id));
      await load(true);
      Message.success('提货文件已上传');
    } catch (cause) { Message.error(cause instanceof Error ? cause.message : '提货文件上传失败'); }
    finally { setDetailDocumentSaving(false); if (detailPickupDocumentInput.current) detailPickupDocumentInput.current.value = ''; }
  };

  const openDetail = async (order: AirPickupOrder) => {
    setDetailOrder(order);
    setDetailLoading(true);
    try { setDetailOrder(await getAirPickup(order.id)); }
    catch (cause) { Message.error(cause instanceof Error ? cause.message : '详情加载失败'); }
    finally { setDetailLoading(false); }
  };

  const openBatch = async (batchId: string) => {
    try { setHandoverBatch(await getAirHandoverBatch(batchId)); setHandoverOpen(true); }
    catch (cause) { Message.error(cause instanceof Error ? cause.message : '交仓批次加载失败'); }
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
    } catch (cause) { Message.error(cause instanceof Error ? cause.message : '可选提货单加载失败'); }
    finally { setHandoverSaving(false); }
  };

  const confirmCurrentHandover = async () => {
    if (!handoverBatch) return;
    setHandoverSaving(true);
    try {
      setHandoverBatch(await confirmAirHandoverBatch(handoverBatch.id));
      setHandoverConfirmOpen(false);
      setSelectedIds([]);
      await load();
      Message.success('整批交仓成功');
    } catch (cause) {
      Message.error(cause instanceof Error ? cause.message : '整批交仓失败，请稍后重试');
    } finally {
      setHandoverSaving(false);
    }
  };

  const handleEvidenceFiles = async (type: 'POD' | 'LOADING', files: FileList | null) => {
    if (!handoverBatch || !files?.length) return;
    const currentCount = handoverBatch.evidence.filter(item => item.type === type).length;
    if (currentCount + files.length > 9) { Message.error(`${type === 'POD' ? 'POD' : '装车照'}最多 9 张`); return; }
    setHandoverSaving(true);
    try {
      for (const original of Array.from(files)) {
        const normalized = await normalizeEvidenceImage(original);
        const override = normalized.warnings.length
          ? window.confirm(`${original.name}：${normalized.warnings.join('、')}是否确认仍然上传？`)
          : false;
        if (normalized.warnings.length && !override) continue;
        await uploadAirHandoverEvidence(handoverBatch.id, { type, file: normalized.file, qualityWarnings: normalized.warnings, qualityOverride: override });
      }
      setHandoverBatch(await getAirHandoverBatch(handoverBatch.id));
      await load(true);
      Message.success('凭证已保存并同步');
    } catch (cause) { Message.error(cause instanceof Error ? cause.message : '凭证上传失败'); }
    finally { setHandoverSaving(false); if (podInput.current) podInput.current.value = ''; if (loadingInput.current) loadingInput.current.value = ''; }
  };

  const previewEvidence = async (asset: AirHandoverEvidence) => {
    try {
      const blob = await downloadAirEvidence(asset.downloadPath);
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      setPreviewUrl(URL.createObjectURL(blob));
    } catch (cause) { Message.error(cause instanceof Error ? cause.message : '凭证预览失败'); }
  };

  const toggleSelected = (order: AirPickupOrder, checked: boolean) => {
    setSelectedIds(current => checked
      ? current.includes(order.id) ? current : [...current, order.id]
      : current.filter(id => id !== order.id));
  };

  const renderNextAction = (order: AirPickupOrder) => {
    if (canReceive && order.status === 'RECORDED') {
      return <Button className="cmhub-air-row-action" size="small" theme="primary" icon={<PackageCheck size={14} aria-hidden="true" />} onClick={() => openReceipt([order])}>确认入库</Button>;
    }
    if (canHandover && order.status === 'RECEIVED' && !order.handoverBatchId) {
      return <Button className="cmhub-air-row-action" size="small" theme="primary" icon={<Truck size={14} aria-hidden="true" />} onClick={() => { setHandoverOrderIds([order.id]); handoverForm.setFieldsValue({ handedOverAt: localDateTimeValue() }); setHandoverOpen(true); }}>确认交仓</Button>;
    }
    if (canAddEvidence && order.status === 'HANDED_OVER' && order.evidenceStatus !== 'COMPLETE' && order.handoverBatchId) {
      return <Button className="cmhub-air-row-action" size="small" theme="primary" icon={<Camera size={14} aria-hidden="true" />} onClick={() => void openBatch(order.handoverBatchId!)}>补齐凭证</Button>;
    }
    return <Button className="cmhub-air-row-action" size="small" variant="text" icon={<Eye size={14} aria-hidden="true" />} onClick={() => void openDetail(order)}>查看详情</Button>;
  };

  const syncedAt = new Date().toISOString();

  return (
    <section ref={motionScopeRef} className="cmhub-page cmhub-air-page" aria-labelledby="air-management-title">
      {error && <Alert theme="error" message={error} operation={<Button size="small" onClick={() => void load()}>重试</Button>} />}

      <div data-motion-enter>
        <header className="cmhub-page-heading cmhub-air-page-heading">
          <div>
            <h1 id="air-management-title">提单管理</h1>
            <p>处理提货单、入库流转与交仓凭证，所有待办均可从此处继续。</p>
          </div>
          <div className="cmhub-air-header-actions" aria-label="提货单操作">
            {canViewDocuments && <Button variant="outline" icon={<FileCheck2 size={16} aria-hidden="true" />} onClick={() => void navigate('/air-pickups/handover-documents')}>交仓凭证</Button>}
            {canCreate && <Button theme="primary" icon={<Plus size={16} aria-hidden="true" />} onClick={() => void openCreate()}>录入提单</Button>}
          </div>
        </header>

        <div className="cmhub-air-summary-grid" aria-label="提货单待办概览">
          <Card className="cmhub-air-summary-card" data-tone="primary" bordered>
            <button type="button" onClick={() => applyListFilter('RECORDED')} aria-pressed={status === 'RECORDED' && !evidenceStatus}>
              <span className="cmhub-air-summary-icon"><PackageCheck size={30} aria-hidden="true" /></span>
              <span className="cmhub-air-summary-copy"><span>待入库</span><strong>{summary.recorded.toLocaleString()}</strong></span>
              <ChevronRight className="cmhub-air-summary-action" size={18} aria-hidden="true" />
            </button>
          </Card>
          <Card className="cmhub-air-summary-card" data-tone="warning" bordered>
            <button type="button" onClick={() => applyListFilter('RECEIVED')} aria-pressed={status === 'RECEIVED' && !evidenceStatus}>
              <span className="cmhub-air-summary-icon is-warning"><Truck size={30} aria-hidden="true" /></span>
              <span className="cmhub-air-summary-copy"><span>待交仓</span><strong>{summary.received.toLocaleString()}</strong></span>
              <ChevronRight className="cmhub-air-summary-action" size={18} aria-hidden="true" />
            </button>
          </Card>
          <Card className="cmhub-air-summary-card" data-tone="success" bordered>
            <button type="button" onClick={() => applyListFilter('HANDED_OVER', 'PARTIAL')} aria-pressed={status === 'HANDED_OVER' && evidenceStatus === 'PARTIAL'}>
              <span className="cmhub-air-summary-icon is-success"><FileCheck2 size={30} aria-hidden="true" /></span>
              <span className="cmhub-air-summary-copy"><span>凭证待补</span><strong>{summary.evidencePending.toLocaleString()}</strong></span>
              <ChevronRight className="cmhub-air-summary-action" size={18} aria-hidden="true" />
            </button>
          </Card>
        </div>

        <Card className="cmhub-module-frame cmhub-air-list-card" bordered>
          <header className="cmhub-air-list-intro">
            <div>
              <h2>提货列表</h2>
            </div>
            <div className="cmhub-air-sync-state" role="status" aria-live="polite">
              <time dateTime={syncedAt}>数据时间：{formatWarehouseSyncTime(syncedAt)}</time>
              <span className="cmhub-air-sync-divider" aria-hidden="true" />
              <span className="cmhub-air-sync-result"><CheckCircle2 size={18} aria-hidden="true" />{loading ? '正在同步' : '已自动同步'}</span>
              <button className="cmhub-air-sync-refresh" type="button" aria-label="立即同步提货单" disabled={loading} onClick={() => void load()}><RefreshCw size={17} aria-hidden="true" /></button>
            </div>
          </header>
          <div className="cmhub-air-filter-row">
            <Tabs value={status || 'ALL'} onChange={key => applyListFilter(key === 'ALL' ? '' : key as AirPickupStatus)}>
              <Tabs.TabPanel value="ALL" label="全部" />
              <Tabs.TabPanel value="RECORDED" label="待入库" />
              <Tabs.TabPanel value="RECEIVED" label="待交仓" />
              <Tabs.TabPanel value="HANDED_OVER" label="已交仓" />
              <Tabs.TabPanel value="VOIDED" label="已作废" />
            </Tabs>
            <div className="cmhub-air-filter-controls">
              <Input aria-label="搜索提货单号或客户" clearable value={searchDraft} prefixIcon={<Search size={15} />} placeholder="搜索提货单号或客户"
                onChange={setSearchDraft} onEnter={value => { setSearch(value); setPage(1); }} />
              <Select className="cmhub-air-customer-filter" aria-label="按客户筛选" clearable filterable placeholder="全部客户" value={clientFilter || undefined}
                onChange={value => { setClientFilter(typeof value === 'string' ? value : ''); setPage(1); }}
                options={customers.map(customer => ({ label: `${customer.type === 'BUSINESS' ? '业务' : '上游'} · ${customer.name}`, value: customer.id }))} />
            </div>
          </div>

          {selectedIds.length > 0 && <div className="cmhub-air-batchbar" role="status">
            <span className="cmhub-air-batchbar-message">已选择 {selectedIds.length} 单，仅相同流转状态的提单可批量处理</span>
            <div className="cmhub-air-batchbar-actions">
              <Button className="cmhub-air-batch-clear" variant="text" size="small" onClick={() => setSelectedIds([])}>清除选择</Button>
              {canReceive && <Button className="cmhub-air-batch-action" theme="default" variant="outline" size="small" disabled={!selectedRecorded.length || selectedRecorded.length !== selectedOrders.length} icon={<PackageCheck size={15} aria-hidden="true" />} onClick={() => openReceipt(selectedRecorded)}>批量入库 <span className="cmhub-air-action-count">{selectedRecorded.length}</span></Button>}
              {canHandover && <Button className="cmhub-air-batch-action" theme="primary" size="small" disabled={!selectedReceived.length || selectedReceived.length !== selectedOrders.length} icon={<Truck size={15} aria-hidden="true" />}
                onClick={() => { setHandoverOrderIds(selectedReceived.map(order => order.id)); handoverForm.setFieldsValue({ handedOverAt: localDateTimeValue() }); setHandoverBatch(null); setHandoverOpen(true); }}>批量交仓 <span className="cmhub-air-action-count">{selectedReceived.length}</span></Button>}
            </div>
          </div>}

          <Table<AirPickupOrder>
            className="cmhub-air-order-table"
            rowKey="id"
            hover
            loading={loading}
            data={orders}
            tableLayout="auto"
            columns={[
              { title: '选择', colKey: 'selection', width: 72, cell: ({ row }) => <Checkbox aria-label={`选择 ${row.billNo}`} checked={selectedIds.includes(row.id)} disabled={row.status === 'VOIDED'} onChange={checked => toggleSelected(row, checked)} /> },
              { title: '提货单与客户', colKey: 'identity', minWidth: 180, cell: ({ row }) => <div className="cmhub-air-order-identity"><button className="cmhub-air-link" onClick={() => void openDetail(row)}>{row.billNo}</button><span title={row.customerName}>{row.customerName}</span></div> },
              { title: '预报与换单', colKey: 'forecast', minWidth: 200, cell: ({ row }) => <div className="cmhub-air-order-progress"><strong>{row.forecastCartons}箱 · {row.forecastPackages}包 · {row.forecastWeight}{row.forecastWeightUnit}</strong><ExchangeProgress order={row} /></div> },
              { title: '状态与凭证', colKey: 'status', minWidth: 148, cell: ({ row }) => <Space size="small">{statusTag(row.status)}{evidenceTag(row)}</Space> },
              { title: '更新时间', colKey: 'updatedAt', minWidth: 148, cell: ({ row }) => <time className="cmhub-air-updated-at" dateTime={row.updatedAt} title={warehouseFullDateTimeFormatter.format(new Date(row.updatedAt))}>{formatWarehouseUpdatedAt(row.updatedAt)}</time> },
              { title: '下一步', colKey: 'actions', width: 128, cell: ({ row }) => <div className="cmhub-air-order-action">{renderNextAction(row)}</div> },
            ]}
            empty={<Empty
              title="暂无提货单"
              description={search || clientFilter || status || evidenceStatus ? '没有符合当前筛选条件的提货记录' : '录入提单后，可在此跟进入库与交仓状态'}
              action={canCreate ? <Button theme="primary" size="small" icon={<Plus size={14} aria-hidden="true" />} onClick={() => void openCreate()}>录入提单</Button> : undefined}
            />}
          />
          {total > 20 && <footer className="cmhub-air-queue-pagination"><Pagination current={page} pageSize={20} total={total} showJumper onChange={({ current }) => setPage(current)} /></footer>}
        </Card>
      </div>

      <Modal className="cmhub-air-modal cmhub-air-editor-modal" header={editingOrder ? `编辑 ${editingOrder.billNo}` : '录入空运提货单'} visible={editorOpen} width={600} confirmLoading={saving}
        confirmBtn={editingOrder ? '保存修改' : '保存并录入'} onClose={() => { setEditorOpen(false); setPickupDocuments([]); form.reset(); }} onConfirm={() => form.submit()} destroyOnClose={false}>
        <Form form={form} layout="vertical" onValuesChange={(_, values) => {
          if (!editingOrder) localStorage.setItem(DRAFT_KEY, JSON.stringify({ savedAt: Date.now(), values }));
        }} onSubmit={async ({ fields }) => {
          setSaving(true);
          try {
            const input = fields as { customerId?: string; billNo?: string; cargoName?: string; forecastCartons: number; forecastPackages: number;
              forecastWeight: number; forecastWeightUnit: AirWeightUnit; remarks?: string };
            let failedDocumentCount = 0;
            if (editingOrder) await updateAirPickup(editingOrder.id, { ...input, expectedVersion: editingOrder.version });
            else {
              const created = await createAirPickup(input as Parameters<typeof createAirPickup>[0]);
              const failures: string[] = [];
              for (const file of pickupDocuments) {
                try { await uploadAirPickupDocument(created.id, file); }
                catch { failures.push(file.name); }
              }
              failedDocumentCount = failures.length;
              if (failures.length) {
                try { setDetailOrder(await getAirPickup(created.id)); } catch { /* the order itself is safely persisted */ }
                Message.warning(`提货单已录入；${failures.length} 个提货文件未上传，可在详情中重新选择后补传`);
              }
            }
            localStorage.removeItem(DRAFT_KEY); setEditorOpen(false); setEditingOrder(null); form.reset();
            setPickupDocuments([]);
            if (editingOrder) Message.success('提货单已更新');
            else if (!failedDocumentCount) Message.success('提货单及提货文件已录入');
            await load();
          } catch (cause) { Message.error(cause instanceof Error ? cause.message : '保存失败'); }
          finally { setSaving(false); }
        }}>
          {!editingOrder && <Form.FormItem label="提货单号" name="billNo" rules={[{ required: true, message: '请输入提货单号' }]} tips="大小写、空格和连字符不影响唯一性；标准11位数字会显示为 180-98109734">
            <Input maxlength={32} placeholder="例如 180-98109734" autofocus />
          </Form.FormItem>}
          {!editingOrder && <Form.FormItem label="归属客户" requiredMark tips="一期一张提货单只归属一个客户：业务客户或上游客户二选一">
            <div className="cmhub-air-customer-picker">
              <Form.FormItem name="customerId" showErrorMessage rules={[{ required: true, message: '请选择业务客户或上游客户' }]}>
                <Select filterable placeholder="选择业务客户或上游客户" options={customers.map(customer => ({ label: `${customer.type === 'BUSINESS' ? '业务' : `上游·${customer.integrationStatus === 'PENDING' ? '待对接' : customer.integrationStatus === 'INTEGRATING' ? '对接中' : '已对接'}`} · ${customer.name} · ${customer.code}`, value: customer.id }))} />
              </Form.FormItem>
              {canManageCustomers && <div className="cmhub-air-customer-actions">
                <Button className="cmhub-air-customer-action" variant="outline" icon={<Plus size={15} />} onClick={() => { customerForm.reset(); customerForm.setFieldsValue({ type: 'BUSINESS' }); setCustomerCreateOpen(true); }}>新增客户</Button>
                <Button className="cmhub-air-customer-action" variant="outline" icon={<Pencil size={15} />} onClick={() => setCustomerManagerOpen(true)}>管理</Button>
              </div>}
            </div>
          </Form.FormItem>}
          <Form.FormItem label="货物名称" name="cargoName"><Input maxlength={100} placeholder="选填" /></Form.FormItem>
          <section className="cmhub-air-measure-section" aria-label="预报信息">
          <div className="cmhub-form-grid cmhub-air-measure-grid">
            <Form.FormItem label="预报箱数" name="forecastCartons" rules={[{ required: true, message: '请输入预报箱数' }]}>
              <InputNumber min={1} max={999999} />
            </Form.FormItem>
            <Form.FormItem label="预报包裹数" name="forecastPackages" rules={[{ required: true, message: '请输入预报包裹数' }]}>
              <InputNumber min={1} max={999999} />
            </Form.FormItem>
            <Form.FormItem className="cmhub-air-weight-form-item" label="预报重量" requiredMark>
              <Input.Group className="cmhub-air-weight-group">
                <Form.FormItem name="forecastWeight" showErrorMessage rules={[{ required: true, message: '请输入预报重量' }]}>
                  <InputNumber className="cmhub-air-weight-value" min={0.001} />
                </Form.FormItem>
                <Form.FormItem name="forecastWeightUnit" showErrorMessage rules={[{ required: true, message: '请选择重量单位' }]}>
                  <Select className="cmhub-air-weight-unit" options={[{ label: 'KG', value: 'KG' }, { label: 'LB', value: 'LB' }]} />
                </Form.FormItem>
              </Input.Group>
            </Form.FormItem>
          </div>
          </section>
          {!editingOrder && <Form.FormItem label="提货文件（选填）" tips="支持 PDF、Word、Excel、CSV；最多 10 个文件，单个不超过 20MB保存后仅已登录运营人员可在详情下载">
            <div className="cmhub-air-pickup-document-picker">
              <input ref={pickupDocumentInput} hidden type="file" multiple accept=".pdf,.doc,.docx,.xls,.xlsx,.csv,application/pdf,application/msword,application/vnd.ms-excel,text/csv" onChange={event => handlePickupDocumentFiles(event.target.files)} />
              <Button icon={<FileUp size={15} />} onClick={() => pickupDocumentInput.current?.click()}>选择提货文件</Button>
              {pickupDocuments.length > 0 && <div className="cmhub-air-pickup-document-list">
                {pickupDocuments.map((file, index) => <div key={`${file.name}-${file.lastModified}-${index}`}>
                  <FileText size={15} /><span title={file.name}>{file.name}</span><small>{(file.size / 1024 / 1024).toFixed(1)} MB</small>
                  <button type="button" aria-label={`移除 ${file.name}`} onClick={() => setPickupDocuments(current => current.filter((_, itemIndex) => itemIndex !== index))}><X size={14} /></button>
                </div>)}
              </div>}
            </div>
          </Form.FormItem>}
          <Form.FormItem label="备注" name="remarks"><Textarea maxlength={200} autosize={{ minRows: 3, maxRows: 5 }} /></Form.FormItem>
        </Form>
      </Modal>

      <Modal className="cmhub-air-modal" header="新增客户档案" visible={customerCreateOpen} width={600} confirmLoading={customerSaving}
        confirmBtn="创建客户" onClose={() => { setCustomerCreateOpen(false); customerForm.reset(); }} onConfirm={() => customerForm.submit()}>
        <Form form={customerForm} layout="vertical" onSubmit={async ({ fields }) => {
          setCustomerSaving(true);
          try {
            const created = await createCustomerProfile(fields as Parameters<typeof createCustomerProfile>[0]);
            setCustomers(current => [...current, created].sort((a, b) => a.name.localeCompare(b.name, 'zh-CN')));
            form.setFieldsValue({ customerId: created.id });
            setCustomerCreateOpen(false);
            customerForm.reset();
            Message.success(`${created.name} 已创建`);
          } catch (cause) { Message.error(cause instanceof Error ? cause.message : '客户创建失败'); }
          finally { setCustomerSaving(false); }
        }}>
          <Form.FormItem label="客户类型" name="type" rules={[{ required: true, message: '请选择客户类型' }]} tips="业务客户不对接系统；上游客户可先建档，后续完成系统对接">
            <Select options={[{ label: '业务客户', value: 'BUSINESS' }, { label: '上游客户', value: 'UPSTREAM' }]} />
          </Form.FormItem>
          <Form.FormItem label="客户名称" name="name" rules={[{ required: true, message: '请输入客户名称' }]} tips="建议填写日常使用的中文名称，例如“厘米海外仓”"><Input maxlength={128} /></Form.FormItem>
          <Form.FormItem label="客户编码" name="customerCode" rules={[{ required: true, message: '请输入客户编码' }]} tips="后续上游系统对接时，应使用同一编码自动连接客户档案"><Input maxlength={64} placeholder="例如 TYG" /></Form.FormItem>
          <Form.FormItem label="联系人" name="contactName"><Input maxlength={100} /></Form.FormItem>
          <Form.FormItem label="联系电话" name="contactPhone"><Input maxlength={32} /></Form.FormItem>
          <Form.FormItem label="联系邮箱" name="contactEmail"><Input maxlength={254} /></Form.FormItem>
        </Form>
      </Modal>

      <Modal className="cmhub-air-modal" header="管理客户档案" visible={customerManagerOpen} width={600} footer={null}
        onClose={() => setCustomerManagerOpen(false)}>
        <p className="cmhub-customer-manager-note">只有未绑定系统对接且没有提货单记录的客户可删除</p>
        <div className="cmhub-customer-manager-list">
          {customers.map(customer => <article key={customer.id} className="cmhub-customer-manager-item">
            <div>
              <strong>{customer.name}</strong>
              <span>{customer.type === 'BUSINESS' ? '业务客户' : `上游客户 · ${customer.integrationStatus === 'PENDING' ? '待对接' : customer.integrationStatus === 'INTEGRATING' ? '对接中' : '已对接'}`} · {customer.code}</span>
            </div>
            <Button variant="text" theme="danger" size="small" loading={customerActionBusy === customer.id}
              onClick={() => confirmDeleteCustomer(customer)}>删除</Button>
          </article>)}
          {!customers.length && <Empty description="暂无客户档案" />}
        </div>
      </Modal>

      <Modal className="cmhub-air-modal cmhub-air-receipt-modal" header={`批量入库确认 · ${Object.keys(receiptDrafts).length} 单`} visible={receiptOpen} width={800}
        confirmBtn="整批确认入库" destroyOnClose onClose={closeReceiptEditor} onConfirm={async () => {
          if (!receiptReceivedAt) { Message.error('请选择共同入库时间'); return; }
          const selected = Object.entries(receiptDrafts);
          const unavailable = selected.find(([id]) => !orders.some(order => order.id === id));
          if (unavailable) { Message.error('提货单列表已刷新，请重新打开入库窗口后再提交'); return; }
          const missing = selected.find(([id, draft]) => differs(orders.find(order => order.id === id)!, draft) && !draft.differenceReason.trim());
          if (missing) { Message.error(`${orders.find(order => order.id === missing[0])?.billNo} 实际值有差异，请填写差异说明`); return; }
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
            if (failedUploads) Message.warning(`整批入库成功；${failedUploads} 张入库照上传失败，可在详情中查看已保存照片`);
            else Message.success(hadReceiptEvidence ? '整批入库及入库照已保存' : '整批入库成功');
            await load();
          } catch (cause) { Message.error(cause instanceof Error ? cause.message : '批量入库失败，整批未保存'); }
          finally { setSaving(false); }
        }} confirmLoading={saving}>
        <Alert theme="info" message="先核对预报信息，再填写实际入库值任一实际值发生变化时，必须填写差异说明；整批提交将一次完成" />
        <div className="cmhub-air-receipt-layout">
          <main>
            <label className="cmhub-air-common-time">
              <span>共同入库时间<small>仓库本地时间</small></span>
              <DatePicker
                value={receiptReceivedAt || undefined}
                valueType="YYYY-MM-DD HH:mm"
                format="YYYY/MM/DD HH:mm"
                enableTimePicker
                clearable
                onChange={value => setReceiptReceivedAt(typeof value === 'string' ? value : '')}
              />
            </label>
            <div className="cmhub-air-receipt-list">
              {selectExistingRecordsById(orders, Object.keys(receiptDrafts)).map(order => {
                const id = order.id;
                const draft = receiptDrafts[id];
                const changed = differs(order, draft);
                const update = (patch: Partial<ReceiptDraft>) => setReceiptDrafts(current => ({ ...current, [id]: { ...current[id], ...patch } }));
                return <div className="cmhub-air-receipt-row" data-variance={changed || undefined} key={id}>
                  <header><div><strong>{order.billNo}</strong><small>核对该提货单的预报值与本次实收值</small></div><Tag theme={changed ? 'warning' : 'success'}>{changed ? '检测到差异' : '数据一致'}</Tag></header>
                  <div className="cmhub-air-receipt-forecast" aria-label={`${order.billNo} 预报信息`}>
                    <span><small>预报箱数</small><strong>{order.forecastCartons} 箱</strong></span>
                    <span><small>预报包裹数</small><strong>{order.forecastPackages} 包</strong></span>
                    <span><small>预报重量</small><strong>{order.forecastWeight} {order.forecastWeightUnit}</strong></span>
                  </div>
                  <div className="cmhub-air-receipt-actual-heading"><strong>实际入库值</strong><small>默认沿用预报值，可按现场结果修改</small></div>
                  <label>实际箱数<InputNumber min={1} max={999999} value={draft.actualCartons} onChange={value => update({ actualCartons: Number(value) })} /></label>
                  <label>实际包裹数<InputNumber min={1} max={999999} value={draft.actualPackages} onChange={value => update({ actualPackages: Number(value) })} /></label>
                  <label className="cmhub-air-receipt-weight-field">
                    <span>实际重量</span>
                    <Input.Group className="cmhub-air-weight-group cmhub-air-receipt-weight-group">
                      <InputNumber className="cmhub-air-weight-value" min={0.1} step={0.1} value={draft.actualWeight} onChange={value => update({ actualWeight: Number(value) })} />
                      <Select className="cmhub-air-weight-unit" value={draft.actualWeightUnit} options={[{ label: 'KG', value: 'KG' }, { label: 'LB', value: 'LB' }]} onChange={value => update({ actualWeightUnit: value === 'LB' ? 'LB' : 'KG' })} />
                    </Input.Group>
                  </label>
                  <label className="cmhub-air-difference">差异说明{changed && <i>*</i>}<Input maxlength={500} value={draft.differenceReason} onChange={value => update({ differenceReason: value })} placeholder={changed ? '请说明实际与预报差异' : '无差异，可不填'} /></label>
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
                  <Button size="small" theme="danger" onClick={() => setReceiptEvidence(current => current.filter((candidate, candidateIndex) => {
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

      <Modal className="cmhub-air-modal cmhub-air-handover-modal" header={handoverBatch ? `${handoverBatch.batchNo} · ${handoverBatch.status === 'DRAFT' ? '交仓草稿' : '已交仓'}` : `新建交仓批次 · ${handoverOrderIds.length} 单`}
        visible={handoverOpen} width={800} footer={handoverBatch ? (
          <Space>
            <Button onClick={() => setHandoverOpen(false)}>关闭</Button>
            {(handoverBatch.status === 'DRAFT' || canCorrect) && <Button icon={<Pencil size={14} />} loading={handoverSaving} onClick={() => void openBatchEditor()}>{handoverBatch.status === 'DRAFT' ? '编辑批次' : '更正批次'}</Button>}
            {handoverBatch.status === 'DRAFT' && <Button theme="primary" loading={handoverSaving} onClick={() => setHandoverConfirmOpen(true)}>确认交仓</Button>}
          </Space>
        ) : undefined} onClose={() => { setHandoverConfirmOpen(false); setHandoverOpen(false); setHandoverBatch(null); }}
        onConfirm={handoverBatch ? undefined : () => handoverForm.submit()} confirmLoading={handoverSaving} confirmBtn="创建交仓草稿" destroyOnClose={false}>
        {!handoverBatch ? <Form form={handoverForm} layout="vertical" onSubmit={async ({ fields }) => {
          setHandoverSaving(true);
          try {
            const batch = await createAirHandoverBatch({ orderIds: handoverOrderIds, ...(fields as Record<string, string>) });
            setHandoverBatch(batch); Message.success('交仓草稿已创建，可先上传凭证再确认'); await load(true);
          } catch (cause) { Message.error(cause instanceof Error ? cause.message : '交仓草稿创建失败，整批未保存'); }
          finally { setHandoverSaving(false); }
        }}>
          <Alert theme="info" message="同一台卡车可包含最多200张提货单草稿全局可见；同一提货单不能加入两个交仓批次" />
          <div className="cmhub-form-grid">
            <Form.FormItem label="车牌号" name="vehicleNo"><Input maxlength={64} placeholder="选填" /></Form.FormItem>
            <Form.FormItem label="司机姓名" name="driverName"><Input maxlength={100} placeholder="选填" /></Form.FormItem>
            <Form.FormItem label="司机电话" name="driverPhone"><Input maxlength={32} placeholder="选填" /></Form.FormItem>
            <Form.FormItem label="共同交仓时间" name="handedOverAt" rules={[{ required: true }]}><DatePicker valueType="YYYY-MM-DD HH:mm" enableTimePicker /></Form.FormItem>
          </div>
          <div className="cmhub-air-selected-bills">{handoverOrderIds.map(id => orders.find(order => order.id === id)).filter(Boolean).map(order => <Tag key={order!.id}>{order!.billNo}</Tag>)}</div>
        </Form> : <div className="cmhub-air-handover-workspace">
          <Descriptions column={3} size="small" bordered items={[
            { label: '提货单', content: `${handoverBatch.orders.length} 单` },
            { label: '车牌', content: handoverBatch.vehicleNo || '未填写' },
            { label: '交仓时间', content: formatDate(handoverBatch.handedOverAt) },
          ]} />
          <Alert theme={handoverBatch.evidence.some(item => item.type === 'POD') && handoverBatch.evidence.filter(item => item.type === 'LOADING').length >= 3 ? 'success' : 'warning'}
            message={`完整凭证标准：POD至少1张＋装车照至少3张当前 POD ${handoverBatch.evidence.filter(item => item.type === 'POD').length} 张，装车照 ${handoverBatch.evidence.filter(item => item.type === 'LOADING').length} 张`} />
          {(['POD', 'LOADING'] as const).map(type => <section className="cmhub-air-evidence-section" key={type}>
            <div className="cmhub-air-evidence-heading"><div><strong>{type === 'POD' ? 'POD 凭证' : '装车照片'}</strong><span>0～9张 · JPG/PNG · 单张≤10MB · 至少800×600</span></div>
              {canAddEvidence && <Button icon={<ImagePlus size={15} />} loading={handoverSaving} onClick={() => (type === 'POD' ? podInput : loadingInput).current?.click()}>添加图片</Button>}</div>
            <input ref={type === 'POD' ? podInput : loadingInput} hidden type="file" multiple accept="image/jpeg,image/png,.jpg,.jpeg,.png" onChange={event => void handleEvidenceFiles(type, event.target.files)} />
            <div className="cmhub-air-evidence-grid">
              {handoverBatch.evidence.filter(item => item.type === type).map(asset => <article key={asset.id}>
                <EvidenceThumbnail asset={asset} onPreview={previewEvidence} />
                {canManageEvidence && <Button size="small" theme="danger" onClick={() => setRemoveAsset(asset)}>移除</Button>}
              </article>)}
              {!handoverBatch.evidence.some(item => item.type === type) && <Empty description="暂未上传" />}
            </div>
          </section>)}
        </div>}
      </Modal>

      <Modal
        className="cmhub-air-modal cmhub-air-handover-confirm-modal"
        header="确认整批交仓"
        visible={handoverConfirmOpen && Boolean(handoverBatch)}
        width={600}
        confirmBtn="确认交仓"
        cancelBtn="返回检查"
        confirmLoading={handoverSaving}
        onClose={() => setHandoverConfirmOpen(false)}
        onConfirm={() => void confirmCurrentHandover()}
        destroyOnClose
      >
        {handoverBatch && <HandoverConfirmationPanel batch={handoverBatch} />}
      </Modal>

      <Modal className="cmhub-air-modal cmhub-air-handover-edit-modal" header={handoverBatch?.status === 'CONFIRMED' ? '更正已确认交仓批次' : '编辑交仓草稿'} visible={batchEditOpen}
        width={800} confirmBtn={handoverBatch?.status === 'CONFIRMED' ? '验证并保存更正' : '保存草稿'} confirmLoading={handoverSaving}
        onClose={() => { setBatchEditOpen(false); batchEditForm.reset(); }} onConfirm={() => batchEditForm.submit()} destroyOnClose={false}>
        {handoverBatch?.status === 'CONFIRMED' && <Alert theme="warning" message="已确认批次的成员、车辆或时间更正需要主管权限、原因和当前账户密码移出的提货单会恢复为“已入库”" />}
        <Form form={batchEditForm} layout="vertical" onSubmit={async ({ fields }) => {
          if (!handoverBatch) return;
          const input = fields as { orderIds: string[]; vehicleNo?: string; driverName?: string; driverPhone?: string;
            handedOverAt: string; reason?: string; password?: string };
          setHandoverSaving(true);
          try {
            const updated = await updateAirHandoverBatch(handoverBatch.id, { ...input, handedOverAt: new Date(input.handedOverAt).toISOString(), expectedVersion: handoverBatch.version });
            setHandoverBatch(updated); setBatchEditOpen(false); batchEditForm.reset(); await load(true);
            Message.success(handoverBatch.status === 'CONFIRMED' ? '批次更正已保存并记录审计' : '交仓草稿已更新');
          } catch (cause) { Message.error(cause instanceof Error ? cause.message : '批次更新失败，整批未保存'); }
          finally { setHandoverSaving(false); }
        }}>
          <Form.FormItem label="批次提货单" name="orderIds" rules={[{ required: true, message: '至少保留1张提货单' }]} tips="可选择当前已入库且未加入其他交仓批次的提货单，最多200单">
            <Select multiple filterable options={batchCandidates.map(order => ({ label: order.billNo, value: order.id }))} />
          </Form.FormItem>
          <div className="cmhub-form-grid">
            <Form.FormItem label="车牌号" name="vehicleNo"><Input maxlength={64} /></Form.FormItem>
            <Form.FormItem label="司机姓名" name="driverName"><Input maxlength={100} /></Form.FormItem>
            <Form.FormItem label="司机电话" name="driverPhone"><Input maxlength={32} /></Form.FormItem>
            <Form.FormItem label="共同交仓时间" name="handedOverAt" rules={[{ required: true }]}><DatePicker valueType="YYYY-MM-DD HH:mm" enableTimePicker /></Form.FormItem>
          </div>
          {handoverBatch?.status === 'CONFIRMED' && <>
            <Form.FormItem label="更正原因" name="reason" rules={[{ required: true }]}><Textarea maxlength={500} /></Form.FormItem>
            <Form.FormItem label="当前账户密码" name="password" rules={[{ required: true }]}><Input type="password" /></Form.FormItem>
          </>}
        </Form>
      </Modal>

      <Drawer className="cmhub-air-detail-drawer" header={<div className="cmhub-air-detail-title"><strong>{detailOrder?.billNo ?? '提货单详情'}</strong><span>{detailOrder?.customerName ?? '正在加载归属客户'}</span></div>} visible={Boolean(detailOrder)} size="720px"
        onClose={() => setDetailOrder(null)} footer={detailOrder && <Space>
          {canEdit && detailOrder.status === 'RECORDED' && <Button icon={<Pencil size={14} />} onClick={() => openEdit(detailOrder)}>编辑提货单</Button>}
          {canCorrect && detailOrder.status !== 'VOIDED' && !detailOrder.handoverBatchId && <Button theme="danger" icon={<ShieldAlert size={14} />} onClick={() => setVoidTarget(detailOrder)}>作废</Button>}
          {detailOrder.handoverBatchId && <Button icon={<Archive size={14} />} onClick={() => void openBatch(detailOrder.handoverBatchId!)}>查看交仓批次</Button>}
        </Space>}>
        {detailLoading ? <div className="cmhub-module-loading"><Spin />正在加载详情…</div> : detailOrder && <div className="cmhub-air-detail">
          <Space>{statusTag(detailOrder.status)}{evidenceTag(detailOrder)}{!detailOrder.billNoIsStandard && <Tag theme="warning">非标准单号</Tag>}</Space>
          <dl className="cmhub-air-detail-facts">
            {[
              { label: '归属客户', value: `${detailOrder.customerType === 'BUSINESS' ? '业务客户' : detailOrder.customerType === 'UPSTREAM' ? '上游客户' : '未分类'} · ${detailOrder.customerName}` },
              { label: '来源方式', value: detailOrder.sourceType === 'UPSTREAM' ? `上游接口${detailOrder.externalBatchId ? ` · ${detailOrder.externalBatchId}` : ''}` : '人工录入' },
              { label: '预报数据', value: `${detailOrder.forecastCartons} 箱 · ${detailOrder.forecastPackages} 包 · ${detailOrder.forecastWeight} ${detailOrder.forecastWeightUnit}` },
              { label: '换单进度', value: <ExchangeProgress order={detailOrder} /> },
              { label: '实际入库', value: detailOrder.actualCartons ? `${detailOrder.actualCartons} 箱 · ${detailOrder.actualPackages} 包 · ${detailOrder.actualWeight} ${detailOrder.actualWeightUnit}` : '尚未入库' },
              { label: '差异说明', value: detailOrder.differenceReason || '无' },
              { label: '入库批次', value: detailOrder.receiptBatchNo || '—' },
              { label: '交仓批次', value: detailOrder.handoverBatchNo || '—' },
              { label: '备注', value: detailOrder.remarks || '无' },
            ].map(item => <div key={item.label}><dt>{item.label}</dt><dd>{item.value}</dd></div>)}
          </dl>
          <section className="cmhub-air-pickup-document-section">
            <header><div><h3>提货文件</h3><p>运营下载后可交给司机提货；文件仅向登录后的授权人员开放</p></div>
              {canCreate && detailOrder.status !== 'VOIDED' && <Button size="small" loading={detailDocumentSaving} icon={<FileUp size={14} />} onClick={() => detailPickupDocumentInput.current?.click()}>补传文件</Button>}
            </header>
            <input ref={detailPickupDocumentInput} hidden type="file" multiple accept=".pdf,.doc,.docx,.xls,.xlsx,.csv,application/pdf,application/msword,application/vnd.ms-excel,text/csv" onChange={event => void handleDetailPickupDocumentFiles(event.target.files)} />
            {(detailOrder.pickupDocuments?.length ?? 0) > 0
              ? <div className="cmhub-air-pickup-document-list">{detailOrder.pickupDocuments!.map(document => <div key={document.id}>
                <FileText size={16} /><span title={document.filename}>{document.filename}</span><small>{(document.byteSize / 1024 / 1024).toFixed(1)} MB · {formatDate(document.createdAt)}</small>
                <Space size={2}><Button size="small" variant="text" icon={<Download size={14} />} onClick={() => void downloadPickupDocument(document)}>下载</Button>
                  {canCorrect && <Button size="small" variant="text" theme="danger" icon={<X size={14} />} onClick={() => setRemoveDocument(document)}>移除</Button>}
                </Space>
              </div>)}</div>
              : <p className="cmhub-air-pickup-document-empty">暂无提货文件</p>}
          </section>
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

      <Modal className="cmhub-air-modal cmhub-air-preview-modal" header="凭证预览" visible={Boolean(previewUrl)} width={800} footer={null} onClose={() => { if (previewUrl) URL.revokeObjectURL(previewUrl); setPreviewUrl(null); }}>
        {previewUrl && <img className="cmhub-air-preview" src={previewUrl} alt="交仓凭证预览" />}
      </Modal>

      <Modal className="cmhub-air-modal" header="移除凭证" visible={Boolean(removeAsset)} width={600} confirmBtn={{ content: '验证并移除', theme: 'danger' }} onClose={() => { setRemoveAsset(null); removeForm.reset(); }} onConfirm={() => removeForm.submit()}>
        <Form form={removeForm} layout="vertical" onSubmit={async ({ fields }) => {
          if (!removeAsset || !handoverBatch) return;
          try { await removeAirEvidence(removeAsset.id, fields as { password: string; reason: string }); setRemoveAsset(null); removeForm.reset(); setHandoverBatch(await getAirHandoverBatch(handoverBatch.id)); await load(true); Message.success('凭证已从业务视图移除，审计记录已保留'); }
          catch (cause) { Message.error(cause instanceof Error ? cause.message : '凭证移除失败'); }
        }}>
          <Alert theme="warning" message="此操作需要主管/系统管理员权限、当前账户密码和原因原文件按留存策略保留" />
          <Form.FormItem label="操作原因" name="reason" rules={[{ required: true }]}><Textarea maxlength={500} /></Form.FormItem>
          <Form.FormItem label="当前账户密码" name="password" rules={[{ required: true }]}><Input type="password" /></Form.FormItem>
        </Form>
      </Modal>

      <Modal className="cmhub-air-modal" header="移除提货文件" visible={Boolean(removeDocument)} width={600} confirmBtn={{ content: '验证并移除', theme: 'danger' }} onClose={() => { setRemoveDocument(null); removeDocumentForm.reset(); }} onConfirm={() => removeDocumentForm.submit()}>
        <Form form={removeDocumentForm} layout="vertical" onSubmit={async ({ fields }) => {
          if (!removeDocument || !detailOrder) return;
          try {
            await removeAirPickupDocument(removeDocument.id, fields as { password: string; reason: string });
            setDetailOrder(await getAirPickup(detailOrder.id));
            setRemoveDocument(null); removeDocumentForm.reset(); await load(true);
            Message.success('提货文件已从业务视图移除，审计记录已保留');
          } catch (cause) { Message.error(cause instanceof Error ? cause.message : '提货文件移除失败'); }
        }}>
          <Alert theme="warning" message="此操作需要主管/系统管理员权限、当前账户密码和原因原文件按留存策略保留" />
          <Form.FormItem label="操作原因" name="reason" rules={[{ required: true }]}><Textarea maxlength={500} /></Form.FormItem>
          <Form.FormItem label="当前账户密码" name="password" rules={[{ required: true }]}><Input type="password" /></Form.FormItem>
        </Form>
      </Modal>

      <Modal className="cmhub-air-modal" header={`作废 ${voidTarget?.billNo ?? ''}`} visible={Boolean(voidTarget)} width={600} confirmBtn={{ content: '验证并作废', theme: 'danger' }} onClose={() => { setVoidTarget(null); voidForm.reset(); }} onConfirm={() => voidForm.submit()}>
        <Form form={voidForm} layout="vertical" onSubmit={async ({ fields }) => {
          if (!voidTarget) return;
          try { await voidAirPickup(voidTarget.id, fields as { password: string; reason: string }); setVoidTarget(null); setDetailOrder(null); voidForm.reset(); await load(); Message.success('提货单已作废'); }
          catch (cause) { Message.error(cause instanceof Error ? cause.message : '作废失败'); }
        }}>
          <Alert theme="warning" message="作废是异常状态，不会删除历史记录请输入原因并验证当前账户密码" />
          <Form.FormItem label="作废原因" name="reason" rules={[{ required: true }]}><Textarea maxlength={500} /></Form.FormItem>
          <Form.FormItem label="当前账户密码" name="password" rules={[{ required: true }]}><Input type="password" /></Form.FormItem>
        </Form>
      </Modal>
    </section>
  );
}
