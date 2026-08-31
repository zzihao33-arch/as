import { useCallback, useState, useEffect, useMemo, useRef, type DragEvent } from 'react';
import qz from 'qz-tray';
import {
  Alert as ArcoAlert,
  Button as ArcoButton,
  Card as ArcoCard,
  Drawer,
  Input as ArcoInput,
  Modal as ArcoModal,
  Slider,
  Space as ArcoSpace,
  Switch,
  Tabs,
  Tooltip,
  Typography
} from '@arco-design/web-react';
import { Upload, FileSpreadsheet, FileText, Scan, Printer, CheckCircle2, AlertCircle, AlertTriangle, ArrowRight, History, X, Settings, RefreshCw, Save, ChevronDown, Check, Volume2, VolumeX, PlayCircle, PlugZap, ShieldAlert } from 'lucide-react';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
import { useLocation } from 'react-router-dom';
import { unzip } from 'fflate';
import QzSetupGuide from '../settings/QzSetupGuide';
import InterceptAlertOverlay from '../intercepts/InterceptAlertOverlay';
import InterceptListPage from '../intercepts/InterceptListPage';
import { normalizeInterceptWaybill, type InterceptRule, useInterceptRules } from '../intercepts/useInterceptRules';
import PrintLogTable from './PrintLogTable';
import { usePrintLogs, MAX_PRINT_LOG_ENTRIES } from './hooks/usePrintLogs';
import { useScanFeedback } from './hooks/useScanFeedback';
import { useSessionUploadCache, type RestoredUploadSession } from './hooks/useSessionUploadCache';
import {
  createMappingIndex,
  createPdfSearchIndex,
  findPdfMatch,
  normalizeBarcode,
  sanitizeBarcode,
  type PdfSearchIndex
} from './printMatching';
import { paginatePrintLogs } from './printLogPagination';
import { PRINT_LOG_TABS, SCAN_FEEDBACK_COPY, type PrintLogTab, type PrintLogType, type PrintOutcome } from './printingTypes';
import { readCloudLabelFile, useWarehousePrintLibrary, type CloudPrintTarget } from './warehousePrintLibrary';
import { useWarehouseSession } from '../session/WarehouseSessionProvider';
import { useWarehousePrintAudit } from './warehousePrintAudit';
import { useSharedWorkPrintAudit } from './sharedWorkPrintAudit';
import {
  claimSharedWorkBatchItem,
  checkGlobalIntercepts,
  closeSharedWorkBatch,
  createSharedWorkBatch,
  downloadWarehouseLabel,
  listSharedWorkBatches,
  publishSharedWorkBatch,
  uploadSharedWorkBatchLabel,
  upsertSharedWorkBatchItems,
  type SharedWorkBatch,
  WAREHOUSE_MOCK_API_ENABLED,
  WarehouseApiError
} from '../session/warehouseApi';

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

const AUDIO_SETTINGS_VERSION = 'audio-feedback-v3';
const LOGS_PER_PAGE = 20;
const QZ_PRINT_TIMEOUT_MS = 30_000;
const AUDIO_PREVIEW_LONG_PRESS_MS = 450;
const MAX_PDF_FILES = 20_000;
const IMPORT_PRECHECK_MAX_COMPARISONS = 1_000_000;
const VIRTUAL_PRINTER_KEYWORDS = [
  'pdf24',
  'microsoft print to pdf',
  'onenote',
  'fax',
  'xps',
  'wps pdf',
  'adobe pdf',
  '导出为wps pdf'
];

type QzSecurityState = 'unknown' | 'signed' | 'unsigned' | 'error';
type QzConnectionHealth = 'idle' | 'healthy' | 'offline';

interface QzSecurityStatus {
  state: QzSecurityState;
  message: string;
}

interface RecentlyPrinted {
  code: string;
  timestamp: number;
}

interface FileInfo {
  name: string;
  status: 'loading' | 'success' | 'error';
  message?: string;
}

type ImportDropTarget = 'excel' | 'pdf';

interface DroppedFileSystemEntry {
  isFile: boolean;
  isDirectory: boolean;
  file?: (resolve: (file: File) => void, reject?: (error: DOMException) => void) => void;
  createReader?: () => DroppedDirectoryReader;
}

interface DroppedDirectoryReader {
  readEntries: (resolve: (entries: DroppedFileSystemEntry[]) => void, reject?: (error: DOMException) => void) => void;
}

type DroppedDataTransferItem = DataTransferItem & {
  webkitGetAsEntry?: () => DroppedFileSystemEntry | null;
};

interface ImportPrecheck {
  matchedCount: number;
  missingWaybills: string[];
  isDeferred?: boolean;
}

const isPdfFile = (file: File) => file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf');
const isZipFile = (file: File) => file.type === 'application/zip' || /\.(zip)$/i.test(file.name);
const getFileKey = (file: File) => file.name.replace(/\.[^/.]+$/, '');

const getBlobBackedPdfFiles = (files: Record<string, File>, directoryPdfKeys: ReadonlySet<string>) => Object.fromEntries(
  Object.entries(files).filter(([key]) => !directoryPdfKeys.has(key))
);

const readPdfAsBase64 = (file: File) => new Promise<string>((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
  reader.onerror = () => reject(reader.error ?? new Error('读取 PDF 文件失败'));
  reader.readAsDataURL(file);
});

const extractPdfFilesFromArchive = async (archive: File) => {
  const archiveBytes = new Uint8Array(await archive.arrayBuffer());
  const entries = await new Promise<Record<string, Uint8Array>>((resolve, reject) => {
    unzip(archiveBytes, (error, data) => {
      if (error) reject(error);
      else resolve(data);
    });
  });

  return Object.entries(entries)
    .filter(([path]) => /\.pdf$/i.test(path))
    .map(([path, content]) => {
      const fileBytes = new Uint8Array(content.byteLength);
      fileBytes.set(content);
      return new File(
        [fileBytes.buffer],
        path.split('/').filter(Boolean).pop() || '面单.pdf',
        { type: 'application/pdf' }
      );
    });
};

const readDirectoryEntries = async (reader: DroppedDirectoryReader) => {
  const entries: DroppedFileSystemEntry[] = [];
  while (true) {
    const batch = await new Promise<DroppedFileSystemEntry[]>((resolve, reject) => reader.readEntries(resolve, reject));
    if (batch.length === 0) return entries;
    entries.push(...batch);
  }
};

const collectDroppedFiles = async (entry: DroppedFileSystemEntry): Promise<File[]> => {
  if (entry.isFile && entry.file) {
    return new Promise<File[]>((resolve, reject) => entry.file?.(file => resolve([file]), reject));
  }
  if (!entry.isDirectory || !entry.createReader) return [];
  const entries = await readDirectoryEntries(entry.createReader());
  return (await Promise.all(entries.map(collectDroppedFiles))).flat();
};

const getDroppedFiles = async (dataTransfer: DataTransfer) => {
  const entries = Array.from(dataTransfer.items).reduce<DroppedFileSystemEntry[]>((collected, item) => {
    const entry = (item as DroppedDataTransferItem).webkitGetAsEntry?.() as DroppedFileSystemEntry | null | undefined;
    if (entry) collected.push(entry);
    return collected;
  }, []);
  if (entries.length === 0) return Array.from(dataTransfer.files);
  const entryFiles = (await Promise.all(entries.map(collectDroppedFiles))).flat();
  return entryFiles.length > 0 ? entryFiles : Array.from(dataTransfer.files);
};

type PaginationItem = number | 'ellipsis-left' | 'ellipsis-right';

const createPaginationItems = (currentPage: number, totalPages: number): PaginationItem[] => {
  if (totalPages <= 7) {
    return Array.from({ length: totalPages }, (_, index) => index + 1);
  }

  const pages: PaginationItem[] = [1];
  const windowStart = Math.max(2, currentPage - 2);
  const windowEnd = Math.min(totalPages - 1, currentPage + 2);

  if (windowStart > 2) pages.push('ellipsis-left');
  for (let page = windowStart; page <= windowEnd; page += 1) pages.push(page);
  if (windowEnd < totalPages - 1) pages.push('ellipsis-right');
  pages.push(totalPages);

  return pages;
};

const normalizePrinterName = (name: unknown) => String(name || '').trim();

const isVirtualPrinterName = (name: string) => {
  const normalizedName = name.toLowerCase();
  return VIRTUAL_PRINTER_KEYWORDS.some(keyword => normalizedName.includes(keyword));
};

const dedupePrinterNames = (printerNames: string[]) => {
  const seen = new Set<string>();
  return printerNames.filter(printerName => {
    const normalizedName = normalizePrinterName(printerName);
    const key = normalizedName.toLowerCase();
    if (!normalizedName || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

type SettingsPanel = 'printer' | 'audio';
type ScanResult = 'success' | 'failure';
type AudioFocusState = 'idle' | 'playing' | 'failed';

interface ActiveAudio {
  stop: () => void;
  startedAt: number;
  timerId: number;
}

export default function App() {
  const location = useLocation();
  const warehouseSession = useWarehouseSession();
  const { session: activeWarehouse, workstation } = warehouseSession;
  const cloudLibrary = useWarehousePrintLibrary();
  const cloudAudit = useWarehousePrintAudit(workstation?.id);
  const sharedAudit = useSharedWorkPrintAudit(workstation?.id);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [pdfFiles, setPdfFiles] = useState<Record<string, File>>({});
  const [scanInput, setScanInput] = useState('');
  const { logs, lastLogId, addLog: appendLog, clearLogsByType } = usePrintLogs();
  const { scanFeedback, announceScanFeedback } = useScanFeedback();
  const {
    hasDirectoryPicker,
    status: uploadCacheStatus,
    message: uploadCacheMessage,
    restore: restoreUploadSession,
    collectPdfFilesFromDirectory,
    saveExcelMapping,
    savePdfFiles
  } = useSessionUploadCache();
  const {
    findRule: findInterceptRule,
    storageStatus: interceptStorageStatus,
    lastSyncedAt: interceptLastSyncedAt,
    sync: syncInterceptRules,
  } = useInterceptRules();
  const [activeTab, setActiveTab] = useState<PrintLogTab>('print');
  const [logPage, setLogPage] = useState(1);
  const logQuery = useMemo(
    () => paginatePrintLogs(logs, activeTab, logPage, LOGS_PER_PAGE),
    [activeTab, logPage, logs]
  );
  const latestPrintLog = useMemo(() => logs.find(log => log.type === 'print') ?? null, [logs]);
  const [stats, setStats] = useState({ excelCount: 0, pdfCount: 0, printedCount: 0 });
  const [isDataImportOpen, setIsDataImportOpen] = useState(false);
  const [isQzGuideOpen, setIsQzGuideOpen] = useState(false);
  const [isInterceptManagerOpen, setIsInterceptManagerOpen] = useState(() => location.hash === '#intercepts');
  const [excelFile, setExcelFile] = useState<FileInfo | null>(null);
  const [pdfFolder, setPdfFolder] = useState<FileInfo | null>(null);
  const [excelSourceCount, setExcelSourceCount] = useState(0);
  const [pdfSourceCount, setPdfSourceCount] = useState(0);
  const [sharedBatchId, setSharedBatchId] = useState('');
  const [sharedBatchStatus, setSharedBatchStatus] = useState<'idle' | 'syncing' | 'draft' | 'active' | 'error'>('idle');
  const [sharedBatchMessage, setSharedBatchMessage] = useState('');
  const [activeSharedBatches, setActiveSharedBatches] = useState<SharedWorkBatch[]>([]);
  const [closingSharedBatchId, setClosingSharedBatchId] = useState('');
  const [emergencyOfflineEnabled, setEmergencyOfflineEnabled] = useState(false);
  const sharedBatchIdRef = useRef('');
  const sharedBatchPromiseRef = useRef<Promise<string> | null>(null);
  const sharedUploadedItemsRef = useRef(new Set<string>());
  const sharedUploadedLabelsRef = useRef(new Set<string>());
  const [activeImportDropTarget, setActiveImportDropTarget] = useState<ImportDropTarget | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [settingsPanel, setSettingsPanel] = useState<SettingsPanel>('printer');
  const [printers, setPrinters] = useState<string[]>([]);
  const [selectedPrinter, setSelectedPrinter] = useState<string>(localStorage.getItem('selectedPrinter') || '');
  const [isPrinterDropdownOpen, setIsPrinterDropdownOpen] = useState(false);
  const [isPrinterLoading, setIsPrinterLoading] = useState(false);
  const [excludedPrinterCount, setExcludedPrinterCount] = useState(0);
  const [qzSecurityStatus, setQzSecurityStatus] = useState<QzSecurityStatus>({
    state: 'unknown',
    message: '尚未检测 QZ 官方证书签名'
  });
  const [qzConnectionHealth, setQzConnectionHealth] = useState<QzConnectionHealth>('idle');
  const [audioEnabled, setAudioEnabled] = useState(() => localStorage.getItem('audioFeedbackEnabled') !== 'false');
  const [audioBoostEnabled, setAudioBoostEnabled] = useState(() => localStorage.getItem('audioFeedbackBoostEnabled') === 'true');
  const [audioVolume, setAudioVolume] = useState(() => {
    if (localStorage.getItem('audioFeedbackSettingsVersion') !== AUDIO_SETTINGS_VERSION) {
      return 100;
    }
    const savedVolumeValue = localStorage.getItem('audioFeedbackVolume');
    if (savedVolumeValue === null) return 100;
    const savedVolume = Number(savedVolumeValue);
    return Number.isFinite(savedVolume) ? Math.min(100, Math.max(0, savedVolume)) : 100;
  });
  const [audioFocusState, setAudioFocusState] = useState<AudioFocusState>('idle');
  const [audioInterruptCount, setAudioInterruptCount] = useState(0);
  const [lastAudioDuration, setLastAudioDuration] = useState(0);
  const [lastAudioResult, setLastAudioResult] = useState<ScanResult | null>(null);
  const [recentlyPrinted, setRecentlyPrinted] = useState<RecentlyPrinted[]>([]);
  const [duplicateInfo, setDuplicateInfo] = useState<{ code: string; show: boolean } | null>(null);
  const [interceptedScan, setInterceptedScan] = useState<{ code: string; rule: InterceptRule } | null>(null);
  const [isPrecheckListOpen, setIsPrecheckListOpen] = useState(false);
  const interceptScanLockRef = useRef<string | null>(null);
  const inFlightScansRef = useRef<Set<string>>(new Set());
  const printerDropdownRef = useRef<HTMLDivElement>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const activeAudioRef = useRef<ActiveAudio | null>(null);
  const qzConnectPromiseRef = useRef<Promise<void> | null>(null);
  const qzSecurityPromiseRef = useRef<Promise<QzSecurityStatus> | null>(null);
  const audioFailureLoggedRef = useRef(false);
  const previewLongPressTimerRef = useRef<number | null>(null);
  const previewLongPressPlayedRef = useRef(false);
  const mappingWorkerRef = useRef<Worker | null>(null);
  const pendingExcelFileNameRef = useRef('');
  const pendingExcelSourceCountRef = useRef(0);
  const mappingRef = useRef<Record<string, string>>({});
  const mappingIndexRef = useRef<Map<string, string>>(new Map());
  const pdfFilesRef = useRef<Record<string, File>>({});
  const pdfSearchIndexRef = useRef<PdfSearchIndex>({ exactKeys: new Map(), ambiguousExactKeys: new Set(), entries: [] });
  const directoryHandlesRef = useRef<FileSystemDirectoryHandle[]>([]);
  const directoryPdfKeysRef = useRef<Set<string>>(new Set());
  const excelSourceCountRef = useRef(0);
  const pdfSourceCountRef = useRef(0);
  const uploadSessionRestorePromiseRef = useRef<Promise<RestoredUploadSession | null> | null>(null);
  const uploadSessionReadyRef = useRef(false);
  const logTabListRef = useRef<HTMLDivElement>(null);
  const logTabPillRef = useRef<HTMLSpanElement>(null);
  const logSectionRef = useRef<HTMLElement>(null);
  const logTabMotionInitializedRef = useRef(false);
  const interceptStorageNoticeLoggedRef = useRef(false);
  const printerOptions = [
    { value: '', label: '自动选择可直打打印机', hint: '自动通过 QZ Tray 匹配真实打印机' },
    ...printers.map(printer => ({ value: printer, label: printer, hint: 'QZ Tray 已检测到的本机设备' }))
  ];
  const selectedPrinterLabel = printerOptions.find(option => option.value === selectedPrinter)?.label || selectedPrinter || '自动选择可直打打印机';
  const totalLogPages = Math.max(1, Math.ceil(logQuery.total / LOGS_PER_PAGE));
  const currentLogPage = Math.min(logPage, totalLogPages);
  const paginationItems = useMemo(
    () => createPaginationItems(currentLogPage, totalLogPages),
    [currentLogPage, totalLogPages]
  );
  const importPrecheck = useMemo<ImportPrecheck | null>(() => {
    const mappingEntries = Object.entries(mapping);
    const pdfSearchIndex = createPdfSearchIndex(pdfFiles);
    if (mappingEntries.length === 0 || pdfSearchIndex.entries.length === 0) return null;

    if (mappingEntries.length * pdfSearchIndex.entries.length > IMPORT_PRECHECK_MAX_COMPARISONS) {
      return { matchedCount: 0, missingWaybills: [], isDeferred: true };
    }

    const missingWaybills = mappingEntries
      .filter(([firstLeg, exchange]) => !findPdfMatch(pdfSearchIndex, [firstLeg, exchange]).key)
      .map(([firstLeg]) => firstLeg);

    return {
      matchedCount: mappingEntries.length - missingWaybills.length,
      missingWaybills
    };
  }, [mapping, pdfFiles]);

  const canCreateSharedBatch = warehouseSession.hasPermission('batches.create');
  const canPublishSharedBatch = warehouseSession.hasPermission('batches.publish');
  const canCloseSharedBatch = warehouseSession.hasPermission('batches.close');
  const canEnableEmergencyOffline = warehouseSession.hasPermission('offline_mode.enable');
  const canViewIntercepts = warehouseSession.hasPermission('intercepts.view');

  useEffect(() => {
    if (canViewIntercepts && location.hash === '#intercepts') setIsInterceptManagerOpen(true);
  }, [canViewIntercepts, location.hash]);
  const sharedDraftStorageKey = activeWarehouse?.userId && activeWarehouse.warehouseId
    ? `cmhub-shared-draft-v1:${activeWarehouse.userId}:${activeWarehouse.warehouseId}`
    : '';

  const refreshActiveSharedBatches = useCallback(async () => {
    if (!canCloseSharedBatch) return;
    try {
      setActiveSharedBatches(await listSharedWorkBatches('ACTIVE'));
    } catch (cause) {
      setSharedBatchStatus('error');
      setSharedBatchMessage(cause instanceof Error ? cause.message : '读取活动共享批次失败。');
    }
  }, [canCloseSharedBatch]);

  useEffect(() => {
    if (isDataImportOpen && canCloseSharedBatch) void refreshActiveSharedBatches();
  }, [canCloseSharedBatch, isDataImportOpen, refreshActiveSharedBatches]);

  const ensureSharedDraft = async () => {
    if (!canCreateSharedBatch) throw new Error('当前角色没有创建共享批次的权限。');
    if (sharedBatchIdRef.current) return sharedBatchIdRef.current;
    if (sharedBatchPromiseRef.current) return sharedBatchPromiseRef.current;
    const pending = (async () => {
      const storedBatchId = sharedDraftStorageKey ? sessionStorage.getItem(sharedDraftStorageKey) : null;
      const drafts = storedBatchId ? await listSharedWorkBatches('DRAFT') : [];
      const batch = drafts.find(candidate => candidate.id === storedBatchId)
        ?? await createSharedWorkBatch(`扫码批次 ${new Date().toLocaleString('zh-CN', { hour12: false })}`);
      sharedBatchIdRef.current = batch.id;
      if (sharedDraftStorageKey) sessionStorage.setItem(sharedDraftStorageKey, batch.id);
      setSharedBatchId(batch.id);
      setSharedBatchStatus('draft');
      return batch.id;
    })();
    sharedBatchPromiseRef.current = pending;
    try {
      return await pending;
    } finally {
      sharedBatchPromiseRef.current = null;
    }
  };

  const syncSharedMappings = async (nextMapping: Record<string, string>) => {
    if (!canCreateSharedBatch || Object.keys(nextMapping).length === 0) return true;
    setSharedBatchStatus('syncing');
    setSharedBatchMessage('正在同步 Excel 映射到共享批次…');
    try {
      const batchId = await ensureSharedDraft();
      const entries = Object.entries(nextMapping).filter(([firstLeg]) => !sharedUploadedItemsRef.current.has(normalizeBarcode(firstLeg)));
      for (let start = 0; start < entries.length; start += 1_000) {
        const chunk = entries.slice(start, start + 1_000);
        await upsertSharedWorkBatchItems(batchId, chunk.map(([firstLegTrackingNo, courierTrackingNo]) => ({
          firstLegTrackingNo,
          courierTrackingNo,
        })));
        chunk.forEach(([firstLeg]) => sharedUploadedItemsRef.current.add(normalizeBarcode(firstLeg)));
        setSharedBatchMessage(`共享映射已同步 ${Math.min(start + chunk.length, entries.length).toLocaleString()} / ${entries.length.toLocaleString()} 条`);
      }
      setSharedBatchStatus('draft');
      setSharedBatchMessage(`共享批次草稿已保存 ${Object.keys(nextMapping).length.toLocaleString()} 条映射`);
      return true;
    } catch (cause) {
      setSharedBatchStatus('error');
      setSharedBatchMessage(cause instanceof Error ? cause.message : '共享映射同步失败。');
      return false;
    }
  };

  const syncSharedLabels = async (nextMapping: Record<string, string>, nextPdfFiles: Record<string, File>) => {
    if (!canCreateSharedBatch || Object.keys(nextMapping).length === 0 || Object.keys(nextPdfFiles).length === 0) return true;
    setSharedBatchStatus('syncing');
    setSharedBatchMessage('正在上传共享 PDF 面单…');
    try {
      const batchId = await ensureSharedDraft();
      if (!await syncSharedMappings(nextMapping)) return false;
      const searchIndex = createPdfSearchIndex(nextPdfFiles);
      const matches = Object.entries(nextMapping).flatMap(([firstLeg, exchange]) => {
        const normalized = normalizeBarcode(firstLeg);
        if (sharedUploadedLabelsRef.current.has(normalized)) return [];
        const match = findPdfMatch(searchIndex, [firstLeg, exchange]);
        const file = match.key ? nextPdfFiles[match.key] : null;
        return file && !match.ambiguous ? [{ firstLeg, normalized, file }] : [];
      });
      let nextIndex = 0;
      let completed = 0;
      const worker = async () => {
        while (nextIndex < matches.length) {
          const match = matches[nextIndex++];
          await uploadSharedWorkBatchLabel(batchId, match.firstLeg, match.file);
          sharedUploadedLabelsRef.current.add(match.normalized);
          completed += 1;
          if (completed % 25 === 0 || completed === matches.length) {
            setSharedBatchMessage(`共享面单已上传 ${completed.toLocaleString()} / ${matches.length.toLocaleString()} 个`);
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(4, matches.length) }, () => worker()));
      setSharedBatchStatus('draft');
      setSharedBatchMessage(`共享批次草稿已就绪：${sharedUploadedLabelsRef.current.size.toLocaleString()} 个 PDF`);
      return true;
    } catch (cause) {
      setSharedBatchStatus('error');
      setSharedBatchMessage(cause instanceof Error ? cause.message : '共享面单上传失败。');
      return false;
    }
  };

  const publishCurrentSharedBatch = async () => {
    if (!canPublishSharedBatch) return;
    setSharedBatchStatus('syncing');
    setSharedBatchMessage('正在完成共享数据同步…');
    try {
      if (!await syncSharedMappings(mappingRef.current) || !await syncSharedLabels(mappingRef.current, pdfFilesRef.current)) {
        throw new Error('共享数据尚未完整同步，已取消发布。');
      }
      const batchId = sharedBatchIdRef.current || await ensureSharedDraft();
      await publishSharedWorkBatch(batchId);
      setSharedBatchStatus('active');
      setSharedBatchMessage('共享批次已发布；其他工作站现在无需重复导入即可扫码。');
      sharedBatchIdRef.current = '';
      if (sharedDraftStorageKey) sessionStorage.removeItem(sharedDraftStorageKey);
      sharedUploadedItemsRef.current = new Set();
      sharedUploadedLabelsRef.current = new Set();
      await refreshActiveSharedBatches();
    } catch (cause) {
      setSharedBatchStatus('error');
      setSharedBatchMessage(cause instanceof Error ? cause.message : '共享批次发布失败。');
    }
  };

  const closeCurrentSharedBatch = async () => {
    if (!canCloseSharedBatch || !sharedBatchId || sharedBatchStatus !== 'active') return;
    setSharedBatchStatus('syncing');
    setSharedBatchMessage('正在关闭共享批次…');
    try {
      await closeSharedWorkBatch(sharedBatchId);
      setSharedBatchId('');
      setSharedBatchStatus('idle');
      setSharedBatchMessage('共享批次已关闭，该批次不再参与新的扫码匹配。');
      await refreshActiveSharedBatches();
    } catch (cause) {
      setSharedBatchStatus('error');
      setSharedBatchMessage(cause instanceof Error ? cause.message : '共享批次关闭失败。');
    }
  };

  const closeListedSharedBatch = async (batch: SharedWorkBatch) => {
    if (!canCloseSharedBatch || closingSharedBatchId) return;
    setClosingSharedBatchId(batch.id);
    try {
      await closeSharedWorkBatch(batch.id);
      if (batch.id === sharedBatchId) {
        setSharedBatchId('');
        setSharedBatchStatus('idle');
      }
      setSharedBatchMessage(`共享批次“${batch.name}”已关闭。`);
      await refreshActiveSharedBatches();
    } catch (cause) {
      setSharedBatchStatus('error');
      setSharedBatchMessage(cause instanceof Error ? cause.message : '关闭共享批次失败。');
    } finally {
      setClosingSharedBatchId('');
    }
  };

  const commitExcelImport = (
    importedMapping: Record<string, string>,
    importedSourceCount: number,
    skippedFileNames: string[] = []
  ) => {
    const nextMapping = { ...mappingRef.current, ...importedMapping };
    const nextSourceCount = excelSourceCountRef.current + importedSourceCount;
    const fileName = `已累计 ${nextSourceCount} 个 Excel`;
    const skippedMessage = skippedFileNames.length ? `；已跳过 ${skippedFileNames.length} 个无法解析的文件` : '';

    mappingRef.current = nextMapping;
    mappingIndexRef.current = createMappingIndex(nextMapping);
    excelSourceCountRef.current = nextSourceCount;
    setMapping(nextMapping);
    setExcelSourceCount(nextSourceCount);
    setStats(prev => ({ ...prev, excelCount: Object.keys(nextMapping).length }));
    addLog('System', pendingExcelFileNameRef.current || fileName, `Excel 导入成功，当前共 ${Object.keys(nextMapping).length} 条映射${skippedMessage}`, 'success', 'import');
    setExcelFile({ name: fileName, status: 'success', message: `${Object.keys(nextMapping).length} 条映射${skippedMessage}` });
    void saveExcelMapping(nextMapping, {
      name: fileName,
      count: Object.keys(nextMapping).length,
      sourceCount: nextSourceCount
    });
    void syncSharedMappings(nextMapping).then(ok => ok && syncSharedLabels(nextMapping, pdfFilesRef.current));
  };

  const ensureMappingWorker = () => {
    if (mappingWorkerRef.current) return mappingWorkerRef.current;

    const worker = new Worker(new URL('./mappingWorker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (event: MessageEvent<{
      type: 'success' | 'error';
      mapping?: Record<string, string>;
      count?: number;
      sourceCount?: number;
      skippedFileNames?: string[];
      message?: string;
    }>) => {
      const fileName = pendingExcelFileNameRef.current || 'Excel 文件';
      if (event.data.type === 'success' && event.data.mapping && event.data.count) {
        commitExcelImport(
          event.data.mapping,
          event.data.sourceCount ?? pendingExcelSourceCountRef.current,
          event.data.skippedFileNames
        );
        return;
      }

      const message = event.data.message || 'Excel 解析失败。';
      addLog('System', fileName, `Excel 导入失败: ${message}`, 'error', 'import');
      setExcelFile({ name: fileName, status: 'error', message: `${message}；当前已导入的数据保持不变。` });
    };
    worker.onerror = () => {
      const fileName = pendingExcelFileNameRef.current || 'Excel 文件';
      const message = 'Excel 解析线程异常，请重新上传。';
      addLog('System', fileName, message, 'error', 'import');
      setExcelFile({ name: fileName, status: 'error', message: `${message}；当前已导入的数据保持不变。` });
    };
    mappingWorkerRef.current = worker;
    return worker;
  };

  const parseExcelOnMainThread = async (files: File[]) => {
    try {
      const { parseMappingWorkbook } = await import('./mappingParser');
      const importedMapping: Record<string, string> = {};
      const skippedFileNames: string[] = [];
      let sourceCount = 0;

      for (const file of files) {
        try {
          const fileMapping = parseMappingWorkbook(await file.arrayBuffer());

          if (Object.keys(fileMapping).length === 0) throw new Error('未找到有效的单号映射关系。支持“头程单号→快递单号”或“运单号→参考单号”。');
          Object.assign(importedMapping, fileMapping);
          sourceCount += 1;
        } catch {
          skippedFileNames.push(file.name);
        }
      }

      if (Object.keys(importedMapping).length === 0) throw new Error('无法从文件中解析出有效的单号映射关系。');
      commitExcelImport(importedMapping, sourceCount, skippedFileNames);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Excel 解析失败。';
      const fileName = pendingExcelFileNameRef.current || 'Excel 文件';
      addLog('System', fileName, `Excel 导入失败: ${message}`, 'error', 'import');
      setExcelFile({ name: fileName, status: 'error', message: `${message}；当前已导入的数据保持不变。` });
    }
  };

  const formatQzError = (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    if (/超过 30 秒|结果可能已进入打印队列/.test(message)) {
      return message;
    }
    if (/connection|connect|websocket|socket|refused|timed out|closed/i.test(message)) {
      return 'QZ Tray 未连接。请确认 QZ Tray 已安装并在右下角托盘保持运行，然后刷新列表。';
    }
    if (/certificate|signature|security|denied|reject|permission|unauthorized/i.test(message)) {
      return 'QZ Tray 授权或官方证书签名未完成。请确认 Vercel 已配置 QZ_CERTIFICATE 与 QZ_PRIVATE_KEY，并重新部署。';
    }
    return `QZ Tray 连接失败：${message}`;
  };

  const configureQzSecurity = async (): Promise<QzSecurityStatus> => {
    if (qzSecurityPromiseRef.current) {
      return qzSecurityPromiseRef.current;
    }

    qzSecurityPromiseRef.current = (async () => {
      try {
        const certificateResponse = await fetch('/api/qz-certificate', {
          cache: 'no-store',
          headers: {
            Accept: 'text/plain'
          }
        });

        if (!certificateResponse.ok) {
          const detail = await certificateResponse.text().catch(() => '');
          const status: QzSecurityStatus = {
            state: 'unsigned',
            message: detail || '未配置 QZ 官方证书，打印时 QZ 仍可能弹出授权确认'
          };
          setQzSecurityStatus(status);
          return status;
        }

        const certificate = (await certificateResponse.text()).trim();
        if (!certificate.includes('BEGIN CERTIFICATE')) {
          throw new Error('QZ_CERTIFICATE 内容不是有效的 PEM 证书');
        }

        qz.security.setCertificatePromise((resolve: (certificate: string) => void) => {
          resolve(certificate);
        }, { rejectOnFailure: true });

        qz.security.setSignatureAlgorithm('SHA512');
        qz.security.setSignaturePromise((toSign: string) => {
          return async (
            resolve: (signature: string) => void,
            reject: (reason?: unknown) => void
          ) => {
            try {
              const signatureResponse = await fetch('/api/qz-sign', {
                method: 'POST',
                cache: 'no-store',
                headers: {
                  'Content-Type': 'application/json',
                  Accept: 'text/plain'
                },
                body: JSON.stringify({ request: toSign })
              });
              const signature = (await signatureResponse.text()).trim();

              if (!signatureResponse.ok) {
                throw new Error(signature || `签名接口返回 HTTP ${signatureResponse.status}`);
              }
              if (!signature) {
                throw new Error('签名接口返回为空');
              }

              resolve(signature);
            } catch (error) {
              reject(error);
            }
          };
        });

        const status: QzSecurityStatus = {
          state: 'signed',
          message: 'QZ 官方证书签名已启用，可减少/消除每次打印授权弹窗'
        };
        setQzSecurityStatus(status);
        return status;
      } catch (error) {
        const status: QzSecurityStatus = {
          state: 'error',
          message: `QZ 官方证书签名配置异常：${error instanceof Error ? error.message : String(error)}`
        };
        setQzSecurityStatus(status);
        return status;
      }
    })();

    return qzSecurityPromiseRef.current;
  };

  const ensureQzConnected = async () => {
    try {
      const securityStatus = await configureQzSecurity();
      if (!qz.websocket.isActive()) {
        if (!qzConnectPromiseRef.current) {
          qzConnectPromiseRef.current = qz.websocket
            .connect({ retries: 2, delay: 1 })
            .finally(() => {
              qzConnectPromiseRef.current = null;
            });
        }

        await qzConnectPromiseRef.current;
      }
      setQzConnectionHealth('healthy');
      return securityStatus;
    } catch (error) {
      setQzConnectionHealth('offline');
      throw error;
    }
  };

  const getQzPrinterInventory = async () => {
    const securityStatus = await ensureQzConnected();
    const [qzPrinters, qzDefaultPrinter] = await Promise.all([
      qz.printers.find(),
      qz.printers.getDefault().catch(() => '')
    ]);
    const allPrinterNames = dedupePrinterNames(Array.isArray(qzPrinters) ? qzPrinters.map(normalizePrinterName) : [normalizePrinterName(qzPrinters)]);
    const directPrinters = allPrinterNames.filter(printer => !isVirtualPrinterName(printer));
    const excludedPrinters = allPrinterNames.filter(isVirtualPrinterName);
    const defaultPrinter = normalizePrinterName(qzDefaultPrinter);
    const preferredPrinter = directPrinters.includes(defaultPrinter)
      ? defaultPrinter
      : (directPrinters.length === 1 ? directPrinters[0] : '');

    return {
      allPrinterNames,
      directPrinters,
      excludedPrinters,
      preferredPrinter,
      securityStatus
    };
  };

  const getSelectedQzPrinterName = async () => {
    if (selectedPrinter) return selectedPrinter;

    if (printers.length === 1) {
      return printers[0];
    }

    const inventory = await getQzPrinterInventory();
    if (inventory.preferredPrinter) return inventory.preferredPrinter;
    if (inventory.directPrinters.length === 1) return inventory.directPrinters[0];

    throw new Error('检测到多台真实打印机，请先在系统设置中选择一台。');
  };

  const printPdfWithQz = async (pdfBase64: string) => {
    if (WAREHOUSE_MOCK_API_ENABLED) {
      await new Promise(resolve => window.setTimeout(resolve, 180));
      return { message: '本地 Mock：已模拟提交打印任务', printerName: 'CM-HUB Mock Printer' };
    }
    const securityStatus = await ensureQzConnected();
    const printerName = await getSelectedQzPrinterName();
    const config = qz.configs.create(printerName, {
      scaleContent: false,
      colorType: 'grayscale'
    });
    const data = [{
      type: 'pixel',
      format: 'pdf',
      flavor: 'base64',
      data: pdfBase64,
      options: {
        ignoreTransparency: true
      }
    }];

    await new Promise<void>((resolve, reject) => {
      const timeoutId = window.setTimeout(() => {
        reject(new Error('QZ Tray 超过 30 秒未返回结果；任务可能已进入打印队列，请先检查打印机后再决定是否重打。'));
      }, QZ_PRINT_TIMEOUT_MS);

      qz.print(config, data).then(
        () => {
          window.clearTimeout(timeoutId);
          resolve();
        },
        (error: unknown) => {
          window.clearTimeout(timeoutId);
          reject(error);
        }
      );
    });

    return {
      printerName,
      message: securityStatus.state === 'signed'
        ? `打印任务已通过 QZ Tray 官方证书签名提交到 ${printerName}`
        : `打印任务已通过 QZ Tray 提交到 ${printerName}（官方签名未完成，QZ 可能弹授权确认）`
    };
  };

  // Load printers
  useEffect(() => {
    if (showSettings && settingsPanel === 'printer') {
      fetchPrinters();
    } else {
      setIsPrinterDropdownOpen(false);
    }
  }, [showSettings, settingsPanel]);

  useEffect(() => {
    if (qzConnectionHealth === 'idle') return;

    const heartbeat = async () => {
      try {
        if (!qz.websocket.isActive()) {
          await ensureQzConnected();
          return;
        }
        await qz.printers.getDefault();
        setQzConnectionHealth('healthy');
      } catch {
        setQzConnectionHealth('offline');
      }
    };

    const intervalId = window.setInterval(() => {
      void heartbeat();
    }, 5_000);

    return () => window.clearInterval(intervalId);
  }, [qzConnectionHealth]);

  useEffect(() => {
    localStorage.setItem('audioFeedbackEnabled', String(audioEnabled));
  }, [audioEnabled]);

  useEffect(() => () => mappingWorkerRef.current?.terminate(), []);

  useEffect(() => {
    let isCurrent = true;
    const restorePromise = uploadSessionRestorePromiseRef.current ?? restoreUploadSession();
    uploadSessionRestorePromiseRef.current = restorePromise;

    void restorePromise.then(restoredSession => {
      if (!isCurrent) return;

      if (restoredSession) {
        const excelCount = restoredSession.excel?.count ?? Object.keys(restoredSession.mapping).length;
        const pdfCount = restoredSession.restoredPdfFileCount;
        const restoredExcelSourceCount = restoredSession.excel?.sourceCount ?? (restoredSession.excel ? 1 : 0);
        const restoredPdfSourceCount = restoredSession.pdfFolder?.sourceCount ?? (restoredSession.pdfFolder ? 1 : 0);
        mappingRef.current = restoredSession.mapping;
        mappingIndexRef.current = createMappingIndex(restoredSession.mapping);
        pdfFilesRef.current = restoredSession.pdfFiles;
        pdfSearchIndexRef.current = createPdfSearchIndex(restoredSession.pdfFiles);
        directoryHandlesRef.current = restoredSession.directoryHandles;
        directoryPdfKeysRef.current = new Set(restoredSession.directoryPdfKeys);
        excelSourceCountRef.current = restoredExcelSourceCount;
        pdfSourceCountRef.current = restoredPdfSourceCount;
        setMapping(restoredSession.mapping);
        setPdfFiles(restoredSession.pdfFiles);
        setExcelSourceCount(restoredExcelSourceCount);
        setPdfSourceCount(restoredPdfSourceCount);
        setStats(previous => ({ ...previous, excelCount, pdfCount }));

        if (restoredSession.excel) {
          setExcelFile({
            name: restoredSession.excel.name,
            status: 'success',
            message: `本次会话已恢复 ${excelCount} 条映射`
          });
        }

        if (restoredSession.pdfFolder) {
          setPdfFolder({
            name: restoredSession.pdfFolder.name,
            status: restoredSession.message ? 'error' : 'success',
            message: restoredSession.message || `本次会话已恢复 ${pdfCount} 个 PDF 文件`
          });
        }
      }

      uploadSessionReadyRef.current = true;
    }).catch(() => {
      uploadSessionReadyRef.current = true;
    });

    return () => {
      isCurrent = false;
    };
  }, [restoreUploadSession]);

  useEffect(() => {
    setLogPage(currentPage => Math.min(currentPage, totalLogPages));
  }, [totalLogPages]);

  useEffect(() => {
    const unlockAudio = () => {
      if (!audioEnabled) return;
      void getAudioContext().then(context => {
        if (context.state === 'suspended') {
          return context.resume();
        }
      }).catch(() => undefined);
    };

    window.addEventListener('pointerdown', unlockAudio, { once: true });
    window.addEventListener('keydown', unlockAudio, { once: true });

    return () => {
      window.removeEventListener('pointerdown', unlockAudio);
      window.removeEventListener('keydown', unlockAudio);
    };
  }, [audioEnabled]);

  useEffect(() => {
    if (!isPrinterDropdownOpen) return;

    const handlePointerDown = (event: MouseEvent) => {
      if (!printerDropdownRef.current?.contains(event.target as Node)) {
        setIsPrinterDropdownOpen(false);
      }
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setIsPrinterDropdownOpen(false);
      }
    };

    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);

    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [isPrinterDropdownOpen]);

  const fetchPrinters = async () => {
    setIsPrinterLoading(true);
    try {
      const qzInventory = await getQzPrinterInventory();
      if (qzInventory.directPrinters.length === 0) {
        throw new Error('QZ Tray 已连接，但未检测到可直打的真实打印机。');
      }

      setQzConnectionHealth('healthy');
      setPrinters(qzInventory.directPrinters);
      setExcludedPrinterCount(qzInventory.excludedPrinters.length);
      setSelectedPrinter(currentPrinter => {
        if (currentPrinter && qzInventory.directPrinters.includes(currentPrinter)) {
          return currentPrinter;
        }
        return qzInventory.preferredPrinter || '';
      });
      addLog('System', '-', qzInventory.securityStatus.state === 'signed'
        ? 'QZ Tray 已连接，官方证书签名已启用'
        : 'QZ Tray 已连接，但官方证书签名未完成，打印时可能弹出授权确认', 'success', 'system');
    } catch (error) {
      const message = formatQzError(error);
      setQzConnectionHealth('offline');
      setPrinters([]);
      setExcludedPrinterCount(0);
      addLog('System', '-', message, 'error', 'system');
    } finally {
      setIsPrinterLoading(false);
    }
  };

  const savePrinter = () => {
    localStorage.setItem('selectedPrinter', selectedPrinter);
    setShowSettings(false);
    addLog('System', '-', `已绑定打印机: ${selectedPrinter || '自动选择可直打打印机'}`, 'success', 'system');
  };

  const openSettings = (panel: SettingsPanel = 'printer') => {
    setSettingsPanel(panel);
    setShowSettings(true);
  };

  const openDataImport = () => {
    if (!canCreateSharedBatch) return;
    setIsDataImportOpen(true);
  };

  useEffect(() => {
    const panel = new URLSearchParams(location.search).get('settings');
    if (panel === 'printer' || panel === 'audio') {
      openSettings(panel);
    }
  }, [location.search]);

  useEffect(() => {
    if (location.hash === '#data-import') {
      openDataImport();
    }
  }, [location.hash]);

  useEffect(() => {
    if (location.hash !== '#operation-log') return;

    const frameId = window.requestAnimationFrame(() => {
      logSectionRef.current?.scrollIntoView({ block: 'start', behavior: 'auto' });
    });

    return () => window.cancelAnimationFrame(frameId);
  }, [location.hash]);

  const getAudioContext = useCallback(async () => {
    const AudioContextClass = window.AudioContext || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextClass) {
      throw new Error('当前浏览器不支持音效播放');
    }

    if (!audioContextRef.current || audioContextRef.current.state === 'closed') {
      audioContextRef.current = new AudioContextClass();
    }

    if (audioContextRef.current.state === 'suspended') {
      await audioContextRef.current.resume();
    }

    return audioContextRef.current;
  }, []);

  useEffect(() => {
    const unlockAudio = () => {
      void getAudioContext().catch(() => undefined);
    };

    // Create the lightweight Web Audio graph early, then resume it on the
    // first deliberate gesture so Chrome does not lose the first scan tone.
    void getAudioContext().catch(() => undefined);
    window.addEventListener('pointerdown', unlockAudio, { once: true, passive: true });
    return () => window.removeEventListener('pointerdown', unlockAudio);
  }, [getAudioContext]);

  const stopActiveAudio = () => {
    if (!activeAudioRef.current) return false;

    const activeAudio = activeAudioRef.current;
    window.clearTimeout(activeAudio.timerId);
    activeAudio.stop();
    setLastAudioDuration(Math.round(performance.now() - activeAudio.startedAt));
    activeAudioRef.current = null;
    return true;
  };

  const recordAudioPlaybackFailure = (message: string) => {
    setAudioFocusState('failed');
    if (audioFailureLoggedRef.current) return;
    audioFailureLoggedRef.current = true;
    addLog('System', '音效', `音效播放失败，已静默处理: ${message}`, 'error', 'system');
  };

  const playScanFeedback = async (scanResult: ScanResult, options: { force?: boolean } = {}) => {
    if (!audioEnabled && !options.force) return;

    const requestTime = performance.now();

    try {
      const didInterrupt = stopActiveAudio();
      if (didInterrupt) {
        setAudioInterruptCount(count => count + 1);
      }

      const context = await getAudioContext();
      const startTime = context.currentTime;
      const duration = scanResult === 'success' ? 0.38 : 0.76;
      const volume = Math.max(0, Math.min(1, audioVolume / 100));
      const boost = audioBoostEnabled ? Math.pow(10, 3 / 20) : 1;
      const masterGain = context.createGain();
      const primaryOscillator = context.createOscillator();
      const secondaryOscillator = scanResult === 'success' ? context.createOscillator() : null;

      masterGain.connect(context.destination);
      masterGain.gain.setValueAtTime(0.0001, startTime);
      masterGain.gain.linearRampToValueAtTime(Math.min(0.95, (scanResult === 'success' ? 0.25 : 0.32) * volume * boost), startTime + 0.015);
      if (scanResult === 'failure') {
        masterGain.gain.setValueAtTime(0.0001, startTime + 0.24);
        masterGain.gain.linearRampToValueAtTime(Math.min(0.95, 0.32 * volume * boost), startTime + 0.34);
      }
      masterGain.gain.exponentialRampToValueAtTime(0.0001, startTime + duration);

      primaryOscillator.connect(masterGain);
      primaryOscillator.type = scanResult === 'success' ? 'triangle' : 'square';

      if (scanResult === 'success') {
        primaryOscillator.frequency.setValueAtTime(1_050, startTime);
        primaryOscillator.frequency.exponentialRampToValueAtTime(1_420, startTime + 0.17);
        primaryOscillator.frequency.exponentialRampToValueAtTime(1_780, startTime + 0.34);
        secondaryOscillator?.connect(masterGain);
        if (secondaryOscillator) {
          secondaryOscillator.type = 'sine';
          secondaryOscillator.frequency.setValueAtTime(1_570, startTime + 0.07);
          secondaryOscillator.frequency.exponentialRampToValueAtTime(2_100, startTime + 0.34);
        }
      } else {
        primaryOscillator.frequency.setValueAtTime(320, startTime);
        primaryOscillator.frequency.setValueAtTime(260, startTime + 0.38);
      }

      primaryOscillator.start(startTime);
      primaryOscillator.stop(startTime + duration + 0.02);
      secondaryOscillator?.start(startTime);
      secondaryOscillator?.stop(startTime + duration + 0.02);

      const cleanup = () => {
        try {
          primaryOscillator.disconnect();
          secondaryOscillator?.disconnect();
          masterGain.disconnect();
        } catch (error) {
          // Audio nodes may already be disconnected after rapid interruption.
        }
      };

      const stop = () => {
        const stopTime = context.currentTime;
        try {
          masterGain.gain.cancelScheduledValues(stopTime);
          masterGain.gain.setTargetAtTime(0.0001, stopTime, 0.006);
          primaryOscillator.stop(stopTime + 0.02);
          secondaryOscillator?.stop(stopTime + 0.02);
        } catch (error) {
          // Oscillators can only be stopped once; rapid scans intentionally race here.
        }
        window.setTimeout(cleanup, 80);
      };

      const timerId = window.setTimeout(() => {
        if (activeAudioRef.current?.stop === stop) {
          activeAudioRef.current = null;
          setAudioFocusState('idle');
          setLastAudioDuration(Math.round(duration * 1000));
        }
        cleanup();
      }, duration * 1000 + 90);

      activeAudioRef.current = {
        stop,
        startedAt: requestTime,
        timerId
      };

      setAudioFocusState('playing');
      setLastAudioResult(scanResult);
    } catch (error) {
      recordAudioPlaybackFailure(error instanceof Error ? error.message : String(error));
    }
  };

  const playInterceptAlert = async () => {
    try {
      const didInterrupt = stopActiveAudio();
      if (didInterrupt) setAudioInterruptCount(count => count + 1);

      const context = await getAudioContext();
      const startTime = context.currentTime;
      const startedAt = performance.now();
      const masterGain = context.createGain();
      const oscillators: OscillatorNode[] = [];

      masterGain.connect(context.destination);
      // Browsers cannot override the computer's system mute state. This is the
      // maximum safe gain available through the browser media channel.
      masterGain.gain.setValueAtTime(0.0001, startTime);
      masterGain.gain.linearRampToValueAtTime(0.9, startTime + 0.01);
      masterGain.gain.setValueAtTime(0.9, startTime + 5.8);
      masterGain.gain.exponentialRampToValueAtTime(0.0001, startTime + 6);

      for (let cycle = 0; cycle < 3; cycle += 1) {
        const cycleStart = startTime + cycle * 2;
        const oscillator = context.createOscillator();
        const toneGain = context.createGain();
        oscillator.type = 'square';
        oscillator.frequency.setValueAtTime(2_240, cycleStart);
        oscillator.frequency.setValueAtTime(2_760, cycleStart + 0.24);
        oscillator.frequency.setValueAtTime(2_240, cycleStart + 0.48);
        oscillator.frequency.setValueAtTime(2_760, cycleStart + 0.72);
        oscillator.frequency.setValueAtTime(2_240, cycleStart + 0.96);
        toneGain.gain.setValueAtTime(0.34, cycleStart);
        toneGain.gain.exponentialRampToValueAtTime(0.0001, cycleStart + 1.55);
        oscillator.connect(toneGain);
        toneGain.connect(masterGain);
        oscillator.start(cycleStart);
        oscillator.stop(cycleStart + 1.6);
        oscillators.push(oscillator);
      }

      const cleanup = () => {
        oscillators.forEach(oscillator => {
          try { oscillator.disconnect(); } catch { /* already released */ }
        });
        try { masterGain.disconnect(); } catch { /* already released */ }
      };
      const stop = () => {
        const stopTime = context.currentTime;
        try {
          masterGain.gain.cancelScheduledValues(stopTime);
          masterGain.gain.setTargetAtTime(0.0001, stopTime, 0.006);
          oscillators.forEach(oscillator => oscillator.stop(stopTime + 0.03));
        } catch {
          // Alert tone may already have completed when the operator confirms it.
        }
        window.setTimeout(cleanup, 90);
      };
      const timerId = window.setTimeout(() => {
        if (activeAudioRef.current?.stop === stop) {
          activeAudioRef.current = null;
          setAudioFocusState('idle');
          setLastAudioDuration(6_000);
        }
        cleanup();
      }, 6_090);

      activeAudioRef.current = { stop, startedAt, timerId };
      setAudioFocusState('playing');
      setLastAudioResult('failure');
    } catch (error) {
      recordAudioPlaybackFailure(error instanceof Error ? error.message : String(error));
    }
  };

  const toggleAudioEnabled = () => {
    const nextEnabled = !audioEnabled;
    if (!nextEnabled) {
      stopActiveAudio();
    }
    setAudioEnabled(nextEnabled);
    addLog('System', '音效设置', nextEnabled ? '音效反馈已开启' : '音效反馈已关闭', 'success', 'system');
  };

  const toggleAudioBoost = () => {
    const nextEnabled = !audioBoostEnabled;
    setAudioBoostEnabled(nextEnabled);
    localStorage.setItem('audioFeedbackBoostEnabled', String(nextEnabled));
    addLog('System', '音效设置', nextEnabled ? '现场强力模式已开启（+3dB）' : '现场强力模式已关闭', 'success', 'system');
  };

  const changeAudioVolume = (nextVolume: number) => {
    const normalizedVolume = Math.min(100, Math.max(0, nextVolume));
    setAudioVolume(normalizedVolume);
    localStorage.setItem('audioFeedbackVolume', String(normalizedVolume));
    localStorage.setItem('audioFeedbackSettingsVersion', AUDIO_SETTINGS_VERSION);
  };

  const startAudioPreviewPress = () => {
    previewLongPressPlayedRef.current = false;
    // This call happens within the direct pointer gesture. It unlocks the
    // browser audio context before the long-press timer fires.
    void getAudioContext().catch(() => undefined);
    if (previewLongPressTimerRef.current) {
      window.clearTimeout(previewLongPressTimerRef.current);
    }

    previewLongPressTimerRef.current = window.setTimeout(() => {
      previewLongPressTimerRef.current = null;
      previewLongPressPlayedRef.current = true;
      void playScanFeedback('failure', { force: true });
    }, AUDIO_PREVIEW_LONG_PRESS_MS);
  };

  const finishAudioPreviewPress = () => {
    if (previewLongPressTimerRef.current) {
      window.clearTimeout(previewLongPressTimerRef.current);
      previewLongPressTimerRef.current = null;
    }

    if (!previewLongPressPlayedRef.current) {
      void playScanFeedback('success', { force: true });
    }
  };

  const cancelAudioPreviewPress = () => {
    if (previewLongPressTimerRef.current) {
      window.clearTimeout(previewLongPressTimerRef.current);
      previewLongPressTimerRef.current = null;
    }
  };

  useEffect(() => () => {
    if (previewLongPressTimerRef.current) {
      window.clearTimeout(previewLongPressTimerRef.current);
    }
  }, []);

  useEffect(() => {
    if (interceptStorageStatus === 'ready' || interceptStorageStatus === 'loading' || interceptStorageNoticeLoggedRef.current) return;
    interceptStorageNoticeLoggedRef.current = true;
    appendLog({
      firstLeg: 'System',
      exchange: '拦截名单',
      message: interceptStorageStatus === 'corrupted'
        ? '拦截库读取异常，当前扫码已改为阻断打印。'
        : '拦截库无法写入本机缓存，当前扫码已改为阻断打印。',
      status: 'error',
      type: 'system'
    });
  }, [appendLog, interceptStorageStatus]);

  const importExcelFiles = async (files: File[]) => {
    const excelFiles = files.filter(file => /\.(xlsx|xls)$/i.test(file.name));
    if (excelFiles.length === 0) {
      setExcelFile({ name: '选择的文件', status: 'error', message: '请导入一个或多个 .xlsx / .xls 格式的 Excel 文件。' });
      return;
    }

    const fileName = excelFiles.length === 1 ? excelFiles[0].name : `${excelFiles.length} 个 Excel 文件`;
    pendingExcelFileNameRef.current = fileName;
    pendingExcelSourceCountRef.current = excelFiles.length;
    setExcelFile({ name: fileName, status: 'loading', message: `正在读取并合并 ${excelFiles.length} 个 Excel…` });

    if (typeof Worker === 'undefined') {
      await parseExcelOnMainThread(excelFiles);
      return;
    }

    try {
      const parsedFiles = await Promise.all(excelFiles.map(async file => ({ name: file.name, buffer: await file.arrayBuffer() })));
      ensureMappingWorker().postMessage({ type: 'parse', files: parsedFiles }, parsedFiles.map(file => file.buffer));
    } catch (error) {
      const message = error instanceof Error ? error.message : '读取文件失败。';
      addLog('System', fileName, `Excel 导入失败: ${message}`, 'error', 'import');
      setExcelFile({ name: fileName, status: 'error', message: `${message}；当前已导入的数据保持不变。` });
    }
  };

  const handleExcelUpload = (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = event.target.files;
    if (files?.length) void importExcelFiles(Array.from(files));
    event.target.value = '';
  };

  const applyPdfUpload = async (
    files: Iterable<File>,
    options: { sourceLabel: string; sourceCount: number; warningMessage?: string; directoryHandle?: FileSystemDirectoryHandle }
  ) => {
    const importedPdfFiles: Record<string, File> = {};
    const duplicateKeys = new Set<string>();
    Array.from(files).filter(isPdfFile).forEach(file => {
      const key = getFileKey(file);
      if (Object.hasOwn(importedPdfFiles, key)) duplicateKeys.add(key);
      else importedPdfFiles[key] = file;
    });

    if (Object.keys(importedPdfFiles).length === 0) {
      const message = '未找到有效的 PDF 文件。';
      addLog('System', options.sourceLabel, message, 'error', 'import');
      setPdfFolder({ name: options.sourceLabel, status: 'error', message });
      return;
    }

    const normalizedImportKeys = new Map<string, string>();
    const normalizedConflicts = new Set<string>();
    for (const key of Object.keys(importedPdfFiles)) {
      const normalizedKey = normalizeBarcode(key);
      if (normalizedImportKeys.has(normalizedKey)) {
        normalizedConflicts.add(key);
        normalizedConflicts.add(normalizedImportKeys.get(normalizedKey)!);
      } else {
        normalizedImportKeys.set(normalizedKey, key);
      }
    }

    const currentPdfFiles = pdfFilesRef.current;
    const currentNormalizedKeys = new Set(Object.keys(currentPdfFiles).map(normalizeBarcode));
    const existingConflicts = Object.keys(importedPdfFiles).filter(key => (
      Object.hasOwn(currentPdfFiles, key) || currentNormalizedKeys.has(normalizeBarcode(key))
    ));
    if (duplicateKeys.size > 0 || normalizedConflicts.size > 0 || existingConflicts.length > 0) {
      const allConflicts = new Set([...duplicateKeys, ...normalizedConflicts, ...existingConflicts]);
      const conflictCount = allConflicts.size;
      const examples = Array.from(allConflicts).slice(0, 3).join('、');
      const message = `发现 ${conflictCount} 个重复或规范化后同名的 PDF（如 ${examples}），为防止面单被静默覆盖，本次导入已取消。请先处理重名文件。`;
      addLog('System', options.sourceLabel, message, 'error', 'import');
      setPdfFolder({ name: options.sourceLabel, status: 'error', message });
      return;
    }
    const addedFileCount = Object.keys(importedPdfFiles)
      .filter(key => !Object.hasOwn(currentPdfFiles, key))
      .length;
    const nextPdfFileCount = Object.keys(currentPdfFiles).length + addedFileCount;
    if (nextPdfFileCount > MAX_PDF_FILES) {
      const message = `面单库最多可保留 ${MAX_PDF_FILES.toLocaleString()} 个 PDF；当前已有 ${Object.keys(currentPdfFiles).length.toLocaleString()} 个，请减少本次导入数量。`;
      addLog('System', options.sourceLabel, message, 'error', 'import');
      setPdfFolder({ name: options.sourceLabel, status: 'error', message });
      return;
    }

    const nextPdfFiles = { ...currentPdfFiles, ...importedPdfFiles };
    const nextSourceCount = pdfSourceCountRef.current + options.sourceCount;
    const sourceName = `已累计 ${nextSourceCount} 个来源`;
    const warningMessage = options.warningMessage ? `；${options.warningMessage}` : '';
    const message = `当前共 ${Object.keys(nextPdfFiles).length.toLocaleString()} / ${MAX_PDF_FILES.toLocaleString()} 个 PDF 文件${warningMessage}`;
    const nextDirectoryPdfKeys = new Set(directoryPdfKeysRef.current);
    const importedPdfKeys = Object.keys(importedPdfFiles);

    if (options.directoryHandle) {
      importedPdfKeys.forEach(key => nextDirectoryPdfKeys.add(key));
    } else {
      // A later file / ZIP import with the same name must take precedence over the
      // earlier folder source after a refresh, so keep that file as a Blob cache.
      importedPdfKeys.forEach(key => nextDirectoryPdfKeys.delete(key));
    }

    const nextDirectoryHandles = options.directoryHandle
      ? (directoryHandlesRef.current.includes(options.directoryHandle)
        ? directoryHandlesRef.current
        : [...directoryHandlesRef.current, options.directoryHandle])
      : directoryHandlesRef.current;
    const blobBackedPdfFiles = getBlobBackedPdfFiles(nextPdfFiles, nextDirectoryPdfKeys);

    pdfFilesRef.current = nextPdfFiles;
    pdfSearchIndexRef.current = createPdfSearchIndex(nextPdfFiles);
    pdfSourceCountRef.current = nextSourceCount;
    setPdfFiles(nextPdfFiles);
    setPdfSourceCount(nextSourceCount);
    setStats(s => ({ ...s, pdfCount: Object.keys(nextPdfFiles).length }));
    void syncSharedLabels(mappingRef.current, nextPdfFiles);
    setPdfFolder({
      name: sourceName,
      status: 'loading',
      message: options.directoryHandle
        ? `${message}；正在保存文件夹授权以便刷新后恢复…`
        : `${message}；正在分批保存本机缓存…`
    });

    const persisted = await savePdfFiles(blobBackedPdfFiles, {
      name: sourceName,
      count: Object.keys(nextPdfFiles).length,
      sourceCount: nextSourceCount
    }, nextDirectoryHandles);

    if (persisted) {
      directoryHandlesRef.current = nextDirectoryHandles;
      directoryPdfKeysRef.current = nextDirectoryPdfKeys;
      addLog('System', options.sourceLabel, `PDF 导入成功，${message}`, 'success', 'import');
      setPdfFolder({ name: sourceName, status: 'success', message });
      return;
    }

    const cacheMessage = 'PDF 已载入当前页面，但本机缓存未完整保存；请勿刷新，并重新选择文件夹或释放浏览器存储空间后再试。';
    addLog('System', options.sourceLabel, cacheMessage, 'error', 'import');
    setPdfFolder({ name: sourceName, status: 'error', message: cacheMessage });
  };

  const importPdfSources = async (
    files: File[],
    sourceLabel: string,
    options: { directoryHandle?: FileSystemDirectoryHandle } = {}
  ) => {
    setPdfFolder({
      name: sourceLabel,
      status: 'loading',
      message: files.length >= 1_000 ? `正在读取 ${files.length.toLocaleString()} 个候选文件，请稍候…` : '正在读取 PDF 文件…'
    });
    await new Promise<void>(resolve => window.requestAnimationFrame(() => resolve()));
    const directPdfFiles = files.filter(isPdfFile);
    const archives = files.filter(isZipFile);
    const extractedPdfFiles: File[] = [];
    const skippedArchiveNames: string[] = [];

    for (const archive of archives) {
      try {
        const archivePdfFiles = await extractPdfFilesFromArchive(archive);
        if (archivePdfFiles.length === 0) throw new Error('压缩包中未找到 PDF 文件。');
        extractedPdfFiles.push(...archivePdfFiles);
      } catch {
        skippedArchiveNames.push(archive.name);
      }
    }

    const sourceCount = (directPdfFiles.length > 0 ? 1 : 0) + (archives.length - skippedArchiveNames.length);
    await applyPdfUpload([...directPdfFiles, ...extractedPdfFiles], {
      sourceLabel,
      sourceCount: Math.max(1, sourceCount),
      warningMessage: skippedArchiveNames.length ? `已跳过 ${skippedArchiveNames.length} 个无效 ZIP 压缩包` : undefined,
      directoryHandle: options.directoryHandle
    });
  };

  const handlePdfUpload = (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = event.target.files;
    if (files?.length) void importPdfSources(Array.from(files), 'PDF 文件夹');
    event.target.value = '';
  };

  const handlePdfArchiveUpload = (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = event.target.files;
    if (files?.length) void importPdfSources(Array.from(files), 'ZIP 压缩包');
    event.target.value = '';
  };

  const handleImportDragEnter = (target: ImportDropTarget, event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    if (Array.from(event.dataTransfer.types).includes('Files')) setActiveImportDropTarget(target);
  };

  const handleImportDragLeave = (target: ImportDropTarget, event: DragEvent<HTMLElement>) => {
    if (!event.currentTarget.contains(event.relatedTarget as Node) && activeImportDropTarget === target) {
      setActiveImportDropTarget(null);
    }
  };

  const handleExcelDrop = (event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    setActiveImportDropTarget(null);
    const files = Array.from(event.dataTransfer.files).filter(candidate => /\.(xlsx|xls)$/i.test(candidate.name));
    if (files.length === 0) {
      setExcelFile({ name: '拖入的文件', status: 'error', message: '请拖入一个或多个 .xlsx / .xls 格式的 Excel 文件。' });
      return;
    }
    void importExcelFiles(files);
  };

  const handlePdfDrop = (event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    setActiveImportDropTarget(null);
    setPdfFolder({ name: '拖入的文件', status: 'loading', message: '正在读取拖入的文件夹与压缩包…' });
    const dataTransfer = event.dataTransfer;
    void getDroppedFiles(dataTransfer)
      .then(files => {
        if (files.length === 0) {
          setPdfFolder({ name: '拖入的文件夹', status: 'error', message: '未识别到 PDF 或 ZIP 文件，请拖入包含 PDF 的文件夹、多个 PDF 或 ZIP 压缩包。' });
          return;
        }
        void importPdfSources(files, '拖入的文件');
      })
      .catch(error => {
        const message = error instanceof Error ? error.message : '读取拖入的 PDF 文件失败。';
        setPdfFolder({ name: '拖入的文件夹', status: 'error', message });
      });
  };

  const handlePdfFolderSelection = async () => {
    const directoryPicker = hasDirectoryPicker()
      ? (window as Window & { showDirectoryPicker?: (options?: { mode?: 'read' | 'readwrite' }) => Promise<FileSystemDirectoryHandle> }).showDirectoryPicker
      : undefined;

    if (!directoryPicker) {
      document.getElementById('pdf-input')?.click();
      return;
    }

    try {
      const directoryHandle = await directoryPicker({ mode: 'read' });
      setPdfFolder({ name: directoryHandle.name || 'PDF 文件夹', status: 'loading', message: '正在读取文件夹中的 PDF 文件…' });
      await new Promise<void>(resolve => window.requestAnimationFrame(() => resolve()));
      const fileMap = await collectPdfFilesFromDirectory(directoryHandle);
      await importPdfSources(Object.values(fileMap), directoryHandle.name || 'PDF 文件夹', { directoryHandle });
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return;
      const message = error instanceof Error ? error.message : '读取 PDF 文件夹失败，请重新选择。';
      addLog('System', 'PDF 文件夹', message, 'error', 'import');
      setPdfFolder({ name: 'PDF 文件夹', status: 'error', message });
    }
  };

  const processScan = (rawScannedValue: string, bypassDuplicateCheck = false, isDuplicateOverride = false) => {
    const scannedValue = sanitizeBarcode(rawScannedValue);
    if (!scannedValue) return;
    const cleanedScannedValue = normalizeBarcode(scannedValue);
    const cloudTarget = cloudLibrary.byBarcode.get(cleanedScannedValue) ?? null;

    const reportCloudAttempt = async (
      target: CloudPrintTarget,
      clientAttemptId: string,
      outcome: 'SUBMITTED' | 'FAILED' | 'RESULT_UNKNOWN' | 'BLOCKED',
      details: { printerName?: string; message?: string } = {}
    ) => {
      if (!workstation) return;
      try {
        await cloudAudit.record({
          workstationId: workstation.id,
          shipmentId: target.shipmentId,
          labelAssetId: target.labelAssetId,
          clientAttemptId,
          outcome,
          printerName: details.printerName,
          message: details.message,
          occurredAt: new Date().toISOString()
        });
      } catch (error) {
        appendLog({
          firstLeg: target.firstLegTrackingNo,
          exchange: target.courierTrackingNo ?? '-',
          status: 'error',
          message: `本机审计队列写入失败：${error instanceof Error ? error.message : '未知错误'}`,
          type: 'system',
          outcome: 'FAILED'
        });
      }
    };

    if (!uploadSessionReadyRef.current) {
      announceScanFeedback('processing');
      addLog(scannedValue, '-', '本次会话文件正在恢复，请在状态恢复完成后重试扫码。', 'error', 'system');
      return;
    }

    if (interceptStorageStatus === 'loading') {
      announceScanFeedback('processing');
      addLog(scannedValue, '-', '拦截名单正在恢复，请稍候重试扫码。', 'error', 'system');
      return;
    }

    if (interceptStorageStatus !== 'ready' && !emergencyOfflineEnabled) {
      announceScanFeedback('error');
      void playScanFeedback('failure');
      addLog(scannedValue, '-', '全局拦截名单不可用，为避免漏拦截已阻断打印。主管可在现场确认后启用单机应急模式。', 'error', 'system');
      return;
    }

    const interceptedRule = findInterceptRule(scannedValue);
    if (interceptedRule) {
      if (interceptScanLockRef.current === cleanedScannedValue) return;
      interceptScanLockRef.current = cleanedScannedValue;
      setInterceptedScan({ code: scannedValue, rule: interceptedRule });
      announceScanFeedback('error');
      void playInterceptAlert();
      addLog(scannedValue, '-', '命中拦截名单，已阻断当前扫描与打印任务。', 'error', 'system');
      if (cloudTarget) void reportCloudAttempt(cloudTarget, crypto.randomUUID(), 'BLOCKED', { message: '命中本机拦截名单。' });
      return;
    }

    if (inFlightScansRef.current.has(cleanedScannedValue)) {
      announceScanFeedback('error');
      void playScanFeedback('failure');
      addLog(scannedValue, '-', '同一单号已有打印任务正在提交，请等待当前任务返回后再操作。', 'error', 'system');
      return;
    }

    // 0. Check for duplicates
    if (!bypassDuplicateCheck) {
      const now = Date.now();
      const fiveMinutesAgo = now - 5 * 60 * 1000;
      const isDuplicate = recentlyPrinted.some(p => normalizeBarcode(p.code) === cleanedScannedValue && p.timestamp > fiveMinutesAgo)
        || logs.some(log => (
          log.type === 'print'
          && normalizeBarcode(log.firstLeg) === cleanedScannedValue
          && log.createdAt > fiveMinutesAgo
          && (log.outcome === 'SUCCESS' || log.outcome === 'DUPLICATE_OVERRIDE')
        ));

      if (isDuplicate) {
        setDuplicateInfo({ code: scannedValue, show: true });
        announceScanFeedback('error');
        void playScanFeedback('failure');
        addLog(scannedValue, '-', '检测到重复扫描，已拦截', 'error', 'system');
        return;
      }
    }
    const processLegacyScan = () => {
    // The lookup indexes are updated on import/restore. Exact matches no longer
    // scan thousands of mappings and file names on every scanner input.
    let finalExchangeNumber = cloudTarget?.courierTrackingNo ?? mappingIndexRef.current.get(cleanedScannedValue) ?? null;
    const pdfSearchIndex = pdfSearchIndexRef.current;
    const pdfMatch = cloudTarget ? { key: undefined, ambiguous: false } : findPdfMatch(pdfSearchIndex, [scannedValue, finalExchangeNumber]);
    const pdfKey = pdfMatch.key;

    if (pdfMatch.ambiguous) {
      announceScanFeedback('error');
      void playScanFeedback('failure');
      addLog(scannedValue, finalExchangeNumber ?? '-', '匹配到多个相似 PDF，为避免错打已阻断。请使用唯一文件名或清理面单库。', 'error', 'print');
      return;
    }

    // Keep the filename-as-reference-number fallback for legacy libraries.
    if (pdfKey && !finalExchangeNumber) {
      const found = Object.entries(mappingRef.current).find(([_, exchangeValue]) => pdfKey.includes(exchangeValue));
      if (found) finalExchangeNumber = found[1];
    }

    const localPdfFile = pdfKey ? pdfFilesRef.current[pdfKey] : null;

    if (!cloudTarget && !localPdfFile) {
      announceScanFeedback('error');
      void playScanFeedback('failure');
      addLog(scannedValue, finalExchangeNumber ?? '-', '未找到对应的 PDF 文件', 'error', 'print');
      return;
    }

    // At this point, if we still don't have it, set to '-'
    finalExchangeNumber = finalExchangeNumber || '-';
    announceScanFeedback('processing');
    inFlightScansRef.current.add(cleanedScannedValue);
    const clientAttemptId = crypto.randomUUID();

    const recordPrintSubmission = (result: { message?: string; printerName?: string }) => {
      announceScanFeedback('success');
      void playScanFeedback('success');
      addLog(
        scannedValue,
        finalExchangeNumber,
        result.message || '打印任务已提交到打印机',
        'success',
        'print',
        isDuplicateOverride ? 'DUPLICATE_OVERRIDE' : 'SUCCESS'
      );
      setStats(prev => ({ ...prev, printedCount: prev.printedCount + 1 }));
      const newTimestamp = Date.now();
      setRecentlyPrinted(prev => [
        ...prev,
        { code: scannedValue, timestamp: newTimestamp }
      ].filter(item => item.timestamp > newTimestamp - 5 * 60 * 1000));
    };

    void (async () => {
      try {
        try {
          const trackingNumbers = [scannedValue, finalExchangeNumber]
            .filter((value): value is string => Boolean(value && value !== '-'));
          const liveIntercept = await checkGlobalIntercepts(trackingNumbers);
          if (liveIntercept.blocked) {
            const rule: InterceptRule = {
              id: `cloud-${normalizeBarcode(liveIntercept.trackingNo)}`,
              waybillNo: liveIntercept.trackingNo,
              normalizedWaybillNo: normalizeInterceptWaybill(liveIntercept.trackingNo),
              createdAt: Date.now(),
              source: 'manual',
              reason: liveIntercept.reason ?? undefined,
            };
            interceptScanLockRef.current = cleanedScannedValue;
            setInterceptedScan({ code: scannedValue, rule });
            announceScanFeedback('error');
            void playInterceptAlert();
            addLog(scannedValue, finalExchangeNumber, `命中实时全局拦截${liveIntercept.reason ? `：${liveIntercept.reason}` : ''}`, 'error', 'system');
            if (cloudTarget) await reportCloudAttempt(cloudTarget, clientAttemptId, 'BLOCKED', { message: '命中实时全局拦截名单。' });
            return;
          }
        } catch (interceptError) {
          if (!emergencyOfflineEnabled) {
            announceScanFeedback('error');
            void playScanFeedback('failure');
            addLog(scannedValue, finalExchangeNumber, `实时拦截校验失败，已阻断打印：${interceptError instanceof Error ? interceptError.message : '云端不可用'}`, 'error', 'system');
            if (cloudTarget) await reportCloudAttempt(cloudTarget, clientAttemptId, 'BLOCKED', { message: '实时全局拦截校验不可用，按安全策略阻断。' });
            return;
          }
          addLog(scannedValue, finalExchangeNumber, '实时拦截校验不可用，已按主管启用的单机应急模式继续使用最后同步缓存。', 'error', 'system');
        }
        const pdfFile = cloudTarget && activeWarehouse?.warehouseId
          ? await readCloudLabelFile(activeWarehouse.warehouseId, cloudTarget)
          : localPdfFile!;
        const result = await printPdfWithQz(await readPdfAsBase64(pdfFile));
        setQzConnectionHealth('healthy');
        recordPrintSubmission(result);
        if (cloudTarget) void reportCloudAttempt(cloudTarget, clientAttemptId, 'SUBMITTED', result);
      } catch (error) {
        announceScanFeedback('error');
        void playScanFeedback('failure');
        const message = formatQzError(error);
        const isUnknownOutcome = message.includes('超过 30 秒');
        if (!isUnknownOutcome) setQzConnectionHealth('offline');
        addLog(scannedValue, finalExchangeNumber, message, 'error', 'print', isUnknownOutcome ? 'TIMEOUT' : 'FAILED');
        if (cloudTarget) {
          void reportCloudAttempt(cloudTarget, clientAttemptId, isUnknownOutcome ? 'RESULT_UNKNOWN' : 'FAILED', { message });
        }
        if (isUnknownOutcome) {
          const timestamp = Date.now();
          setRecentlyPrinted(previous => [
            ...previous,
            { code: scannedValue, timestamp }
          ].filter(item => item.timestamp > timestamp - 5 * 60 * 1000));
        }
      } finally {
        inFlightScansRef.current.delete(cleanedScannedValue);
      }
    })();
    };

    if (!workstation) {
      processLegacyScan();
      return;
    }

    announceScanFeedback('processing');
    inFlightScansRef.current.add(cleanedScannedValue);
    void (async () => {
      try {
        let claim;
        try {
          claim = await claimSharedWorkBatchItem({ trackingNo: scannedValue, workstationId: workstation.id });
        } catch (cause) {
          if (cause instanceof WarehouseApiError && cause.code === 'BATCH_ITEM_NOT_FOUND') {
            inFlightScansRef.current.delete(cleanedScannedValue);
            processLegacyScan();
            return;
          }
          const cloudUnavailable = cause instanceof WarehouseApiError
            ? cause.status >= 500
            : cause instanceof TypeError;
          if (emergencyOfflineEnabled && cloudUnavailable) {
            inFlightScansRef.current.delete(cleanedScannedValue);
            addLog(scannedValue, '-', '云端共享服务不可用，已按主管启用的单机应急模式使用本机已验证数据。', 'error', 'system');
            processLegacyScan();
            return;
          }
          throw cause;
        }

        if (claim.blocked) {
          const rule: InterceptRule = {
            id: `cloud-${cleanedScannedValue}`,
            waybillNo: claim.trackingNo,
            normalizedWaybillNo: normalizeInterceptWaybill(claim.trackingNo),
            createdAt: Date.now(),
            source: 'manual',
            reason: claim.reason ?? undefined,
          };
          interceptScanLockRef.current = cleanedScannedValue;
          setInterceptedScan({ code: scannedValue, rule });
          announceScanFeedback('error');
          void playInterceptAlert();
          addLog(scannedValue, '-', `命中全局拦截名单${claim.reason ? `：${claim.reason}` : ''}`, 'error', 'system');
          return;
        }

        const clientAttemptId = crypto.randomUUID();
        const exchange = claim.item.courierTrackingNo ?? '-';
        try {
          const blob = await downloadWarehouseLabel(claim.item.labelDownloadPath);
          const file = new File([blob], `${claim.item.courierTrackingNo || claim.item.firstLegTrackingNo}.pdf`, { type: 'application/pdf' });
          const result = await printPdfWithQz(await readPdfAsBase64(file));
          setQzConnectionHealth('healthy');
          try {
            await sharedAudit.record({
              itemId: claim.item.id,
              workstationId: workstation.id,
              clientAttemptId,
              claimToken: claim.claimToken,
              outcome: 'SUBMITTED',
              printerName: result.printerName,
              message: result.message,
              occurredAt: new Date().toISOString(),
            });
          } catch (auditError) {
            appendLog({
              firstLeg: scannedValue,
              exchange,
              status: 'error',
              message: `打印已提交，但本机审计队列写入失败：${auditError instanceof Error ? auditError.message : '未知错误'}`,
              type: 'system',
              outcome: 'FAILED',
            });
          }
          announceScanFeedback('success');
          void playScanFeedback('success');
          addLog(scannedValue, exchange, result.message || `共享批次 ${claim.item.batchName} 已提交打印`, 'success', 'print', isDuplicateOverride ? 'DUPLICATE_OVERRIDE' : 'SUCCESS');
          setStats(previous => ({ ...previous, printedCount: previous.printedCount + 1 }));
          const timestamp = Date.now();
          setRecentlyPrinted(previous => [...previous, { code: scannedValue, timestamp }]
            .filter(item => item.timestamp > timestamp - 5 * 60 * 1000));
        } catch (cause) {
          const message = formatQzError(cause);
          const isUnknownOutcome = message.includes('超过 30 秒');
          try {
            await sharedAudit.record({
              itemId: claim.item.id,
              workstationId: workstation.id,
              clientAttemptId,
              claimToken: claim.claimToken,
              outcome: isUnknownOutcome ? 'RESULT_UNKNOWN' : 'FAILED',
              message,
              occurredAt: new Date().toISOString(),
            });
          } catch (auditError) {
            appendLog({
              firstLeg: scannedValue,
              exchange,
              status: 'error',
              message: `打印结果本机队列写入失败：${auditError instanceof Error ? auditError.message : '未知错误'}`,
              type: 'system',
              outcome: 'FAILED',
            });
          }
          announceScanFeedback('error');
          void playScanFeedback('failure');
          if (!isUnknownOutcome) setQzConnectionHealth('offline');
          addLog(scannedValue, exchange, message, 'error', 'print', isUnknownOutcome ? 'TIMEOUT' : 'FAILED');
        }
      } catch (cause) {
        announceScanFeedback('error');
        void playScanFeedback('failure');
        const message = cause instanceof Error ? cause.message : '共享批次处理失败。';
        addLog(scannedValue, '-', message, 'error', 'system');
      } finally {
        inFlightScansRef.current.delete(cleanedScannedValue);
      }
    })();
  };

  const forcePrint = (codeToPrint: string) => {
    // Bypasses the duplicate check
    setDuplicateInfo(null);
    processScan(codeToPrint, true, true);
  };

  const closeInterceptAlert = () => {
    stopActiveAudio();
    interceptScanLockRef.current = null;
    setInterceptedScan(null);
    setScanInput('');
  };

  const handleScanInputChange = (nextValue: string) => {
    setScanInput(nextValue);

    // Barcode scanners normally submit Enter. For manual typing or scanners
    // without a suffix key, an exact intercept hit must still halt immediately.
    const interceptedRule = findInterceptRule(nextValue);
    if (!interceptedRule) return;

    setScanInput('');
    processScan(nextValue, false);
  };

  const submitScanInput = () => {
    const scannedValue = scanInput;
    if (!scannedValue.trim()) return;

    setScanInput('');
    processScan(scannedValue, false);
  };

  const addLog = (
    firstLeg: string,
    exchange: string,
    message: string,
    status: 'success' | 'error',
    type: PrintLogType,
    outcome?: PrintOutcome
  ) => {
    appendLog({
      firstLeg,
      exchange,
      status,
      message,
      type,
      outcome
    });
  };

  useEffect(() => {
    if (!duplicateInfo?.show) return;

    const confirmDuplicatePrint = (event: KeyboardEvent) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        forcePrint(duplicateInfo.code);
      }
      if (event.key === 'Escape') {
        setDuplicateInfo(null);
      }
    };

    document.addEventListener('keydown', confirmDuplicatePrint);
    return () => document.removeEventListener('keydown', confirmDuplicatePrint);
  }, [duplicateInfo]);

  useEffect(() => {
    const tabList = logTabListRef.current;
    const pill = logTabPillRef.current;
    const activeTabButton = tabList?.querySelector<HTMLButtonElement>(`[data-log-tab="${activeTab}"]`);
    if (!tabList || !pill || !activeTabButton) return;

    const movePill = (shouldAnimate: boolean) => {
      const originalTransition = pill.style.transition;
      if (!shouldAnimate) pill.style.transition = 'none';
      pill.style.transform = `translateX(${activeTabButton.offsetLeft}px)`;
      pill.style.width = `${activeTabButton.offsetWidth}px`;

      if (!shouldAnimate) {
        void pill.offsetWidth;
        pill.style.transition = originalTransition;
      }
    };

    const frameId = window.requestAnimationFrame(() => {
      movePill(logTabMotionInitializedRef.current);
      logTabMotionInitializedRef.current = true;
    });
    const handleResize = () => movePill(false);
    window.addEventListener('resize', handleResize);

    return () => {
      window.cancelAnimationFrame(frameId);
      window.removeEventListener('resize', handleResize);
    };
  }, [activeTab]);

  const scanFeedbackCopy = SCAN_FEEDBACK_COPY[scanFeedback];
  const isWorkspacePreparing = uploadCacheStatus === 'restoring' || interceptStorageStatus === 'loading';
  const scanStatusCopy = isWorkspacePreparing ? '正在准备本机数据' : scanFeedbackCopy;

  return (
    <div className="cmhub-operating-workspace">
      <div className="cmhub-operating-stack">
        {interceptedScan && (
          <InterceptAlertOverlay
            rule={interceptedScan.rule}
            scannedValue={interceptedScan.code}
            onConfirm={closeInterceptAlert}
          />
        )}

        {/* Duplicate Scan Modal */}
        {duplicateInfo?.show && (
          <ArcoModal
            visible
            className="cmhub-confirm-modal"
            title={<ArcoSpace><AlertTriangle size={20} /><span>重复扫描警告</span></ArcoSpace>}
            onCancel={() => setDuplicateInfo(null)}
            footer={
              <ArcoSpace>
                <ArcoButton onClick={() => setDuplicateInfo(null)}>取消</ArcoButton>
                <ArcoButton status="danger" type="primary" autoFocus onClick={() => forcePrint(duplicateInfo.code)}>
                  确认强制打印（Enter）
                </ArcoButton>
              </ArcoSpace>
            }
          >
            <Typography.Paragraph>
              单号 <Typography.Text bold>{duplicateInfo.code}</Typography.Text> 在最近 5 分钟内已被打印。您确定要强制重复打印吗？
            </Typography.Paragraph>
          </ArcoModal>
        )}

        {/* Header */}
        <ArcoCard className="cmhub-operating-card cmhub-operating-overview" bordered>
        <header className="cmhub-operating-header">
          <div className="cmhub-operating-title">
            <div>
              <Typography.Title heading={3}>扫码打单工作台</Typography.Title>
              <p>连续扫描后自动匹配面单，并发送至当前电脑的打印机。</p>
            </div>
          </div>

          <div className="cmhub-operating-header-actions">
            <div className="cmhub-header-metrics">
              <div className="text-center">
                <div className="text-2xl font-bold text-text-primary">{stats.excelCount}</div>
                <div className="text-xs text-text-secondary uppercase font-semibold">Excel 条目</div>
              </div>
              <div className="text-center border-x px-6 border-white/10">
                <div className="text-2xl font-bold text-text-primary">{(stats.pdfCount + cloudLibrary.count).toLocaleString()}</div>
                <div className="text-xs text-text-secondary uppercase font-semibold">可打印面单</div>
              </div>
              <div className="text-center">
                <div className="text-2xl font-bold text-text-primary">{stats.printedCount}</div>
                <div className="text-xs text-text-secondary uppercase font-semibold">已提交打印</div>
              </div>
            </div>

            <div className="cmhub-header-utilities" role="toolbar" aria-label="扫码打单快捷操作">
              <span className="cmhub-header-utilities-label">快捷操作</span>
              <Tooltip content="QZ Tray 教程与新电脑配置">
                <ArcoButton
                  type="text"
                  size="large"
                  aria-label="打开 QZ Tray 教程与新电脑配置"
                  icon={<PlugZap size={20} />}
                  onClick={() => setIsQzGuideOpen(true)}
                ><span>QZ 配置</span></ArcoButton>
              </Tooltip>
              {canViewIntercepts && <Tooltip content="拦截名单管理">
                <ArcoButton
                  type="text"
                  size="large"
                  aria-label="打开拦截名单管理"
                  icon={<ShieldAlert size={20} />}
                  onClick={() => setIsInterceptManagerOpen(true)}
                ><span>拦截名单</span></ArcoButton>
              </Tooltip>}
              {canCreateSharedBatch && <Tooltip content="导入 Excel 映射与 PDF 面单">
                <ArcoButton
                  type="text"
                  size="large"
                  aria-label="打开数据导入"
                  icon={<FileSpreadsheet size={20} />}
                  onClick={openDataImport}
                ><span>数据导入</span></ArcoButton>
              </Tooltip>}
              <Tooltip content="系统设置">
                <ArcoButton
                  type="text"
                  size="large"
                  aria-label="打开系统设置"
                  icon={<Settings size={20} />}
                  onClick={() => openSettings('printer')}
                ><span>打印与音效</span></ArcoButton>
              </Tooltip>
            </div>
          </div>
        </header>
        </ArcoCard>

        {qzConnectionHealth === 'offline' && (
          <ArcoAlert
            type="warning"
            showIcon
            content="QZ Tray 连接已中断，系统正在每 5 秒自动尝试重连；请确认 QZ Tray 正在当前电脑运行。"
          />
        )}

        {cloudLibrary.status === 'error' && (
          <ArcoAlert
            type="warning"
            showIcon
            content={`云端同步未完成：${cloudLibrary.message}`}
            action={<ArcoButton size="small" onClick={() => void cloudLibrary.sync()}>重新同步</ArcoButton>}
          />
        )}

        {interceptStorageStatus === 'corrupted' && (
          <ArcoAlert
            type="warning"
            showIcon
            content="拦截名单读取异常，当前扫码将跳过拦截判断；请在“拦截名单”中重新添加单号。"
          />
        )}

        {interceptStorageStatus === 'unavailable' && (
          <ArcoAlert
            type="warning"
            showIcon
            content="拦截名单无法保存到本机缓存，本次会话关闭后将失效。"
          />
        )}

        {uploadCacheStatus === 'unavailable' && uploadCacheMessage && (
          <ArcoAlert type="warning" showIcon content={`会话文件缓存不可用：${uploadCacheMessage}`} />
        )}

        <Drawer
          visible={isQzGuideOpen}
          className="cmhub-utility-drawer"
          width={680}
          title={<ArcoSpace><PlugZap size={20} /><span>QZ Tray 教程与新电脑配置</span></ArcoSpace>}
          footer={null}
          onCancel={() => setIsQzGuideOpen(false)}
        >
          <QzSetupGuide />
        </Drawer>

        {canViewIntercepts && <Drawer
          visible={isInterceptManagerOpen}
          className="cmhub-utility-drawer cmhub-intercept-drawer"
          width={760}
          title={<div className="cmhub-intercept-drawer-title"><span><ShieldAlert size={20} />拦截名单</span><small>维护后对所有授权仓库工作站实时生效。</small></div>}
          footer={null}
          onCancel={() => setIsInterceptManagerOpen(false)}
        >
          <InterceptListPage embedded />
        </Drawer>}

        {/* System Settings Modal */}
        {showSettings && (
          <ArcoModal
            visible
            className="cmhub-settings-modal"
            title={<ArcoSpace><Settings size={20} /><span>系统设置</span></ArcoSpace>}
            onCancel={() => setShowSettings(false)}
            footer={null}
            style={{ width: 620 }}
          >
              <div className="space-y-6">
                <Tabs
                  activeTab={settingsPanel}
                  onChange={(key) => setSettingsPanel(key as SettingsPanel)}
                  type="rounded"
                >
                  <Tabs.TabPane key="printer" title={<ArcoSpace size="mini"><Printer size={16} />打印机</ArcoSpace>} />
                  <Tabs.TabPane key="audio" title={<ArcoSpace size="mini"><Volume2 size={16} />音效</ArcoSpace>} />
                </Tabs>

                {settingsPanel === 'printer' ? (
                  <>
                    <div className="space-y-3">
                  <label className="text-sm font-semibold text-text-primary flex items-center justify-between">
                    选择打印机
                    <ArcoButton
                      type="text"
                      size="mini"
                      onClick={fetchPrinters}
                      loading={isPrinterLoading}
                      icon={<RefreshCw className="w-3 h-3" />}
                    >
                      刷新列表
                    </ArcoButton>
                  </label>
                  <div className="relative" ref={printerDropdownRef}>
                    <button
                      type="button"
                      aria-haspopup="listbox"
                      aria-expanded={isPrinterDropdownOpen}
                      onClick={() => setIsPrinterDropdownOpen(open => !open)}
                      className={cn(
                        "w-full min-h-[58px] px-4 py-3 rounded-xl border-2 text-left outline-none transition-all flex items-center justify-between gap-3",
                        isPrinterDropdownOpen
                          ? "bg-dark-bg/95 border-brand-green shadow-lg shadow-brand-green/20"
                          : "bg-white/5 border-white/10 hover:bg-white/10 hover:border-white/20"
                      )}
                    >
                      <span className="min-w-0">
                        <span className="block truncate text-base font-semibold text-text-primary">{selectedPrinterLabel}</span>
                        <span className="block truncate text-xs text-text-secondary/60">
                          {selectedPrinter ? '已选择的打印设备' : '自动匹配真实打印机'}
                        </span>
                      </span>
                      <ChevronDown className={cn("w-5 h-5 flex-shrink-0 text-brand-green transition-transform", isPrinterDropdownOpen && "rotate-180")} />
                    </button>

                    {isPrinterDropdownOpen && (
                      <div className="absolute z-50 mt-2 w-full overflow-hidden rounded-xl border border-brand-green/60 bg-dark-bg/95 shadow-2xl shadow-black/50 backdrop-blur-xl ring-1 ring-white/10">
                        <div role="listbox" className="max-h-64 overflow-y-auto p-1">
                          {printerOptions.map(option => {
                            const isSelected = option.value === selectedPrinter;

                            return (
                              <button
                                key={option.value || 'system-default-printer'}
                                type="button"
                                role="option"
                                aria-selected={isSelected}
                                onClick={() => {
                                  setSelectedPrinter(option.value);
                                  setIsPrinterDropdownOpen(false);
                                }}
                                className={cn(
                                  "w-full rounded-lg px-3 py-3 text-left transition-all flex items-center gap-3",
                                  isSelected
                                    ? "bg-brand-green text-dark-bg"
                                    : "text-text-primary hover:bg-brand-green/15 hover:text-brand-green"
                                )}
                              >
                                <span className={cn(
                                  "flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full border",
                                  isSelected ? "border-dark-bg/40 bg-dark-bg/10" : "border-white/20"
                                )}>
                                  {isSelected && <Check className="w-3.5 h-3.5" />}
                                </span>
                                <span className="min-w-0 flex-1">
                                  <span className="block truncate font-semibold">{option.label}</span>
                                  <span className={cn("block truncate text-xs", isSelected ? "text-dark-bg/70" : "text-text-secondary/55")}>
                                    {option.hint}
                                  </span>
                                </span>
                              </button>
                            );
                          })}

                          {isPrinterLoading && (
                            <div className="px-3 py-3 text-sm text-text-secondary flex items-center gap-2">
                              <RefreshCw className="w-4 h-4 animate-spin text-brand-green" />
                              正在刷新打印机列表...
                            </div>
                          )}

                          {!isPrinterLoading && printers.length === 0 && (
                            <div className="px-3 pb-3 pt-2 text-xs text-text-secondary/70">
                              暂未检测到可直打打印机，请先连接或安装标签打印机。
                            </div>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                  <p className="text-xs text-text-secondary/70">
                    当前绑定：{selectedPrinter || '自动选择可直打打印机'}
                    <span className={cn(
                      "block mt-1",
                      qzConnectionHealth === 'healthy' ? "text-brand-green" : qzConnectionHealth === 'offline' ? "text-red-400" : "text-text-secondary/50"
                    )}>
                      {qzConnectionHealth === 'healthy'
                        ? 'QZ Tray 已连接，可直接调用本机打印机'
                        : qzConnectionHealth === 'offline'
                          ? 'QZ Tray 未连接。请确认已安装并在系统托盘中运行后刷新。'
                          : '请通过 QZ Tray 刷新并选择本机打印机'}
                    </span>
                    {excludedPrinterCount > 0 && (
                      <span className="block mt-1 text-text-secondary/50">
                        已隐藏 {excludedPrinterCount} 个 PDF/Fax/OneNote 虚拟打印设备
                      </span>
                    )}
                    <span className={cn(
                      "block mt-1",
                      qzSecurityStatus.state === 'signed'
                        ? "text-brand-green"
                        : qzSecurityStatus.state === 'unknown'
                          ? "text-text-secondary/50"
                          : "text-amber-300"
                    )}>
                      QZ 官方签名：{qzSecurityStatus.message}
                    </span>
                    {qzSecurityStatus.state !== 'signed' && qzSecurityStatus.state !== 'unknown' && (
                      <span className="block mt-1 text-text-secondary/50">
                        管理员需在 Vercel 配置 QZ 官方 certificate/private key 后重新部署，才能消除每次打印授权弹窗。
                      </span>
                    )}
                  </p>
                </div>

                <div className="pt-4">
                  <ArcoButton
                    type="primary"
                    long
                    onClick={savePrinter}
                    icon={<Save className="w-5 h-5" />}
                  >
                    保存打印机设置
                  </ArcoButton>
                </div>
                  </>
                ) : (
                  <>
                    <div className="rounded-2xl border border-white/10 bg-white/[0.04] p-5 space-y-5">
                      <div className="flex items-center justify-between gap-4">
                        <div className="flex items-center gap-3">
                          <div className="h-10 w-10 rounded-xl bg-brand-green/10 flex items-center justify-center">
                            {audioEnabled ? (
                              <Volume2 className="w-5 h-5 text-brand-green" />
                            ) : (
                              <VolumeX className="w-5 h-5 text-text-secondary" />
                            )}
                          </div>
                          <div>
                            <div className="font-semibold text-text-primary">音效总开关</div>
                            <div className="text-xs text-text-secondary/60">
                              {audioEnabled ? '扫描反馈已开启' : '扫描反馈已关闭'}
                            </div>
                          </div>
                        </div>
                        <Switch checked={audioEnabled} onChange={toggleAudioEnabled} />
                      </div>

                      <div className="space-y-3">
                        <div className="flex items-center justify-between">
                          <span className="text-sm font-semibold text-text-primary">
                            音量调节
                          </span>
                          <span className="text-xs font-semibold text-brand-green">
                            {audioVolume === 100 ? '跟随系统媒体音量' : `${audioVolume}%`}
                          </span>
                        </div>
                        <Slider
                          min={0}
                          max={100}
                          value={audioVolume}
                          onChange={(value) => changeAudioVolume(Array.isArray(value) ? value[0] : value)}
                        />
                        <div className="flex justify-between text-[11px] text-text-secondary/50">
                          <span>静音</span>
                          <span>独立调节</span>
                          <span>系统上限</span>
                        </div>
                      </div>

                      <div className="flex items-center justify-between gap-4 rounded-xl border border-white/10 bg-white/[0.03] px-4 py-3">
                        <div>
                          <div className="font-semibold text-text-primary">现场强力模式</div>
                          <div className="mt-1 text-xs text-text-secondary/60">将浏览器输出增益提高约 +3dB，适用于嘈杂作业区。</div>
                        </div>
                        <Switch checked={audioBoostEnabled} onChange={toggleAudioBoost} aria-label="现场强力模式" />
                      </div>

                      <ArcoButton
                        long
                        icon={<PlayCircle className="w-5 h-5" />}
                        onPointerDown={startAudioPreviewPress}
                        onPointerUp={finishAudioPreviewPress}
                        onPointerLeave={cancelAudioPreviewPress}
                        onPointerCancel={cancelAudioPreviewPress}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter' || event.key === ' ') {
                            event.preventDefault();
                            void playScanFeedback('success', { force: true });
                          }
                        }}
                      >
                        试听音效
                        <Typography.Text type="secondary">点击成功（约 380ms）/ 长按失败（约 760ms）</Typography.Text>
                      </ArcoButton>
                    </div>

                    <div className="grid grid-cols-3 gap-3 text-xs">
                      <div className="rounded-xl bg-white/[0.04] border border-white/10 px-3 py-3">
                        <div className="text-text-secondary/60">音频状态</div>
                        <div className="mt-1 font-semibold text-text-primary">
                          {audioFocusState === 'playing' ? '播放中' : audioFocusState === 'failed' ? '异常' : '就绪'}
                        </div>
                      </div>
                      <div className="rounded-xl bg-white/[0.04] border border-white/10 px-3 py-3">
                        <div className="text-text-secondary/60">截断次数</div>
                        <div className="mt-1 font-semibold text-text-primary">{audioInterruptCount}</div>
                      </div>
                      <div className="rounded-xl bg-white/[0.04] border border-white/10 px-3 py-3">
                        <div className="text-text-secondary/60">最近音效</div>
                        <div className="mt-1 font-semibold text-text-primary">
                          {lastAudioResult ? `${lastAudioResult === 'success' ? '成功' : '失败'} · ${lastAudioDuration}ms` : '暂无'}
                        </div>
                      </div>
                    </div>
                  </>
                )}
              </div>
          </ArcoModal>
        )}

        <Drawer
          visible={isDataImportOpen && canCreateSharedBatch}
          className="cmhub-utility-drawer"
          width={680}
          title={<ArcoSpace><FileSpreadsheet size={20} /><span>数据导入与面单库</span></ArcoSpace>}
          footer={null}
          onCancel={() => setIsDataImportOpen(false)}
        >
          <section id="data-import" className="cmhub-data-import-drawer" aria-label="数据导入与面单库">
            <div className="cmhub-data-import-summary cmhub-data-import-drawer-summary" aria-live="polite">
              <span>{excelFile ? `${excelSourceCount} 个 Excel · ${stats.excelCount.toLocaleString()} 条映射` : '未导入 Excel'}</span>
              <span>{pdfFolder ? `${pdfSourceCount} 个来源 · ${stats.pdfCount.toLocaleString()} 个 PDF` : '未选择 PDF 文件夹或 ZIP'}</span>
            </div>
            {canCreateSharedBatch && (
              <div className="cmhub-shared-batch-status">
                <ArcoAlert
                  type={sharedBatchStatus === 'error' ? 'error' : sharedBatchStatus === 'active' ? 'success' : 'info'}
                  showIcon
                  content={sharedBatchMessage || '导入的数据会先保存为共享草稿；确认 Excel 与 PDF 后发布，其他工作站即可直接扫码。'}
                />
                {canPublishSharedBatch && (
                  <ArcoSpace>
                    <ArcoButton
                      type="primary"
                      loading={sharedBatchStatus === 'syncing'}
                      disabled={!sharedBatchId || stats.excelCount === 0 || stats.pdfCount === 0 || sharedBatchStatus === 'active'}
                      onClick={() => void publishCurrentSharedBatch()}
                    >
                      {sharedBatchStatus === 'active' ? '共享批次已发布' : '发布共享批次'}
                    </ArcoButton>
                    {canCloseSharedBatch && sharedBatchStatus === 'active' && (
                      <ArcoButton status="warning" onClick={() => void closeCurrentSharedBatch()}>关闭当前批次</ArcoButton>
                    )}
                  </ArcoSpace>
                )}
                {canCloseSharedBatch && activeSharedBatches.length > 0 && (
                  <div className="cmhub-active-shared-batches" aria-label="活动共享批次">
                    <div className="cmhub-active-shared-batches-title">当前活动批次</div>
                    {activeSharedBatches.map(batch => (
                      <div className="cmhub-active-shared-batch" key={batch.id}>
                        <div>
                          <strong>{batch.name}</strong>
                          <span>{batch.mappingCount.toLocaleString()} 条映射 · {batch.pdfCount.toLocaleString()} 个 PDF</span>
                        </div>
                        <ArcoButton
                          size="mini"
                          status="warning"
                          loading={closingSharedBatchId === batch.id}
                          disabled={Boolean(closingSharedBatchId)}
                          onClick={() => void closeListedSharedBatch(batch)}
                        >关闭</ArcoButton>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
            {importPrecheck && (
              <div className="cmhub-import-precheck" aria-live="polite">
                <ArcoAlert
                  type={importPrecheck.isDeferred ? 'info' : importPrecheck.missingWaybills.length === 0 ? 'success' : 'warning'}
                  showIcon
                  content={importPrecheck.isDeferred
                    ? `已导入 ${stats.pdfCount.toLocaleString()} 个 PDF。为保证高容量面单库导入流畅，已跳过全量预检；扫码仍会按文件名匹配规则处理。`
                    : `导入匹配预检：已导入 ${stats.excelCount.toLocaleString()} 条 Excel 映射，匹配成功 ${importPrecheck.matchedCount.toLocaleString()} 个 PDF 面单${importPrecheck.missingWaybills.length ? `，${importPrecheck.missingWaybills.length.toLocaleString()} 个面单缺失。` : '。'}`}
                />
                {importPrecheck.missingWaybills.length > 0 && (
                  <>
                    <ArcoButton type="text" size="mini" onClick={() => setIsPrecheckListOpen(current => !current)}>
                      {isPrecheckListOpen ? '收起缺失单号' : '查看缺失单号'}
                    </ArcoButton>
                    {isPrecheckListOpen && (
                      <ul className="cmhub-import-precheck-list" aria-label="未匹配 PDF 的头程单号">
                        {importPrecheck.missingWaybills.map(waybill => <li key={waybill}>{waybill}</li>)}
                      </ul>
                    )}
                  </>
                )}
              </div>
            )}
            <div className="cmhub-data-import-body">
                <div className="cmhub-data-import-grid">
                <div className="cmhub-import-source">
                  <div className="cmhub-import-source-heading">
                    <span><FileSpreadsheet size={18} aria-hidden="true" /> Excel 映射</span>
                    {excelFile && (
                      <ArcoButton type="text" size="mini" onClick={() => document.getElementById('excel-input')?.click()}>
                        继续添加
                      </ArcoButton>
                    )}
                  </div>
                  <label
                    className="cmhub-import-drop-target"
                    data-drop-active={activeImportDropTarget === 'excel'}
                    onDragEnter={(event) => handleImportDragEnter('excel', event)}
                    onDragOver={(event) => event.preventDefault()}
                    onDragLeave={(event) => handleImportDragLeave('excel', event)}
                    onDrop={handleExcelDrop}
                  >
                    {!excelFile ? (
                      <>
                        <Upload size={24} aria-hidden="true" />
                        <span>点击或拖拽上传多个 Excel</span>
                      </>
                    ) : (
                      <>
                        {excelFile.status === 'loading' ? <RefreshCw size={24} className="animate-spin" aria-hidden="true" /> : excelFile.status === 'success' ? <CheckCircle2 size={24} aria-hidden="true" /> : <AlertCircle size={24} aria-hidden="true" />}
                        <strong>{excelFile.name}</strong>
                        <small>{excelFile.message}</small>
                      </>
                    )}
                    <input id="excel-input" type="file" className="hidden" accept=".xlsx, .xls" multiple onChange={handleExcelUpload} />
                  </label>
                </div>

                <div className="cmhub-import-source">
                  <div className="cmhub-import-source-heading">
                    <span><FileText size={18} aria-hidden="true" /> 面单库</span>
                    <span className="cmhub-import-capacity">最多 {MAX_PDF_FILES.toLocaleString()} 个</span>
                  </div>
                  <div className="cmhub-import-pdf-workspace">
                    <button
                      type="button"
                      className="cmhub-import-drop-target cmhub-import-pdf-drop-target"
                      data-drop-active={activeImportDropTarget === 'pdf'}
                      onClick={() => void handlePdfFolderSelection()}
                      onDragEnter={(event) => handleImportDragEnter('pdf', event)}
                      onDragOver={(event) => event.preventDefault()}
                      onDragLeave={(event) => handleImportDragLeave('pdf', event)}
                      onDrop={handlePdfDrop}
                      disabled={pdfFolder?.status === 'loading'}
                      aria-label="选择或拖入 PDF 文件夹"
                    >
                      {!pdfFolder ? (
                        <>
                          <Upload size={24} aria-hidden="true" />
                          <span>点击或拖入 PDF 文件夹</span>
                        </>
                      ) : (
                        <>
                          {pdfFolder.status === 'loading' ? <RefreshCw size={24} className="animate-spin" aria-hidden="true" /> : pdfFolder.status === 'success' ? <CheckCircle2 size={24} aria-hidden="true" /> : <AlertCircle size={24} aria-hidden="true" />}
                          <strong>{pdfFolder.name}</strong>
                          <small>{pdfFolder.message}</small>
                          {pdfFolder.status === 'error' && <em>请在右侧操作区重新选择。</em>}
                        </>
                      )}
                    </button>
                    <div className="cmhub-import-pdf-actions" aria-label="面单库导入操作">
                      <span>继续添加</span>
                      <ArcoButton type="secondary" size="small" disabled={pdfFolder?.status === 'loading'} onClick={() => void handlePdfFolderSelection()}>
                        文件夹
                      </ArcoButton>
                      <ArcoButton type="outline" size="small" disabled={pdfFolder?.status === 'loading'} onClick={() => document.getElementById('pdf-archive-input')?.click()}>
                        ZIP 包
                      </ArcoButton>
                    </div>
                  </div>
                  {/* @ts-ignore Chromium directory picker fallback */}
                  <input id="pdf-input" type="file" className="hidden" webkitdirectory="" directory="" multiple onChange={handlePdfUpload} />
                  <input id="pdf-archive-input" type="file" className="hidden" accept=".zip,application/zip,application/x-zip-compressed" multiple onChange={handlePdfArchiveUpload} />
                </div>
                </div>
                <p className="cmhub-data-import-note">
                  <AlertCircle size={15} aria-hidden="true" /> Excel 支持“头程单号→快递单号”及“运单号→参考单号”；单次/累计最多 {MAX_PDF_FILES.toLocaleString()} 个 PDF。使用“文件夹”导入会保存本机访问授权，刷新后可恢复大批量面单；也可连续添加多个文件夹或 ZIP，同名单以后导入为准。
                </p>
            </div>
          </section>
        </Drawer>

        {canEnableEmergencyOffline && (
          <ArcoAlert
            className="cmhub-emergency-mode-alert"
            type={emergencyOfflineEnabled ? 'warning' : 'info'}
            showIcon
            content={emergencyOfflineEnabled
              ? `单机应急模式已开启：仅使用本机已验证面单与最后同步的拦截名单（${interceptLastSyncedAt ? new Date(interceptLastSyncedAt).toLocaleString() : '尚无同步记录'}）。本机面单缓存：${uploadCacheMessage}。待回传 ${cloudAudit.pendingCount + sharedAudit.pendingCount} 条。`
              : '共享模式断网时默认停止打印。现场主管可临时启用单机应急模式。'}
            action={(
              <ArcoSpace>
                {emergencyOfflineEnabled && (
                  <ArcoButton onClick={() => {
                    void Promise.all([
                      syncInterceptRules(),
                      cloudLibrary.sync(),
                      cloudAudit.flushPending(),
                      sharedAudit.flushPending(),
                    ]);
                  }}>恢复连接</ArcoButton>
                )}
                <ArcoButton
                  status={emergencyOfflineEnabled ? 'danger' : undefined}
                  onClick={() => setEmergencyOfflineEnabled(enabled => !enabled)}
                >{emergencyOfflineEnabled ? '关闭应急模式' : '启用单机应急'}</ArcoButton>
              </ArcoSpace>
            )}
          />
        )}

        <div className="cmhub-operating-stack">
            {/* Scanner Input */}
            <ArcoCard
              className="cmhub-operating-card cmhub-scanner-card"
              data-state={scanFeedback}
              aria-busy={isWorkspacePreparing}
              bordered
            >
              <div className="cmhub-scan-entry-summary">
                <div className="cmhub-scan-entry-icon"><Printer size={22} aria-hidden="true" /></div>
                <div className="cmhub-scan-entry-copy">
                  <h2>扫码并打印</h2>
                  <p>扫描或输入单号后，系统会匹配面单并发送至已选打印机。</p>
                </div>
              </div>
              <div className="cmhub-scan-stage">
                <div className="cmhub-scan-entry-controls">
                  <div className="cmhub-scan-field">
                    <div className="cmhub-scan-field-label">
                      <label id="cmhub-scan-input-label" htmlFor="cmhub-scan-input">扫描单号</label>
                      <div className="cmhub-scan-status" role="status" aria-live="polite">
                        <span className="cmhub-scan-status-dot" aria-hidden="true" />
                        {scanStatusCopy}
                      </div>
                    </div>
                    <ArcoInput
                      value={scanInput}
                      onChange={handleScanInputChange}
                      onFocus={() => { void getAudioContext().catch(() => undefined); }}
                      onPressEnter={submitScanInput}
                      id="cmhub-scan-input"
                      placeholder={isWorkspacePreparing ? '正在准备本机数据…' : '等待扫码或输入单号…'}
                      size="large"
                      disabled={isWorkspacePreparing}
                      className={cn('cmhub-scan-input', scanFeedback === 'error' && 'is-error')}
                      aria-labelledby="cmhub-scan-input-label"
                      prefix={<Scan size={20} aria-hidden="true" />}
                      suffix={<kbd className="cmhub-scan-enter-key">Enter</kbd>}
                    />
                  </div>
                  <div className="cmhub-scan-entry-actions" role="group" aria-label="扫码打印操作">
                    <ArcoButton type="primary" disabled={isWorkspacePreparing || !scanInput.trim()} onClick={submitScanInput}>
                      <Printer size={16} aria-hidden="true" />
                      <span>打印</span>
                    </ArcoButton>
                  </div>
                </div>
                <div className="cmhub-scan-field-meta">
                  <span>扫码枪将自动提交；手动输入后按 Enter</span>
                  <span>面单自动匹配</span>
                  <span>本机打印机直打</span>
                  <span>拦截名单即时校验</span>
                </div>
              </div>
            </ArcoCard>

            <ArcoCard className="cmhub-operating-card cmhub-scan-result-card" bordered>
              <div className="cmhub-scan-result-heading">
                <span>本次处理结果</span>
                <small>{latestPrintLog ? latestPrintLog.time : '等待首次扫描'}</small>
              </div>
              {latestPrintLog ? (
                <div className="cmhub-scan-result-content" data-status={latestPrintLog.status}>
                  <div><small>扫描单号</small><strong>{latestPrintLog.firstLeg}</strong></div>
                  <ArrowRight size={20} aria-hidden="true" />
                  <div><small>匹配末端单号</small><strong>{latestPrintLog.exchange || '—'}</strong></div>
                  <span>{latestPrintLog.status === 'success' ? <CheckCircle2 size={18} /> : <AlertCircle size={18} />}{latestPrintLog.status === 'success' ? '已提交到打印机' : latestPrintLog.message}</span>
                </div>
              ) : (
                <div className="cmhub-scan-result-empty"><Scan size={20} /><span>扫描完成后将在这里显示本次匹配与提交结果</span></div>
              )}
            </ArcoCard>

            {/* Logs */}
            <section id="operation-log" ref={logSectionRef} tabIndex={-1} aria-label="操作日志">
              <ArcoCard className="cmhub-operating-card cmhub-log-card" bordered bodyStyle={{ padding: 0 }}>
              <div className="cmhub-log-card-header">
                <div className="cmhub-log-card-heading">
                  <div className="cmhub-log-title">
                    <span className="cmhub-log-title-icon" aria-hidden="true"><History size={19} /></span>
                    <h2>操作日志</h2>
                  </div>
                  <div ref={logTabListRef} className="t-tabs cmhub-log-tabs" role="tablist" aria-label="操作日志分类">
                    <span ref={logTabPillRef} className="t-tabs-pill" aria-hidden="true" />
                    {PRINT_LOG_TABS.map(tab => (
                      <button
                        key={tab.key}
                        type="button"
                        className="t-tab"
                        data-log-tab={tab.key}
                        role="tab"
                        aria-selected={activeTab === tab.key}
                        aria-controls="cmhub-log-table"
                        tabIndex={activeTab === tab.key ? 0 : -1}
                        onClick={() => {
                          setActiveTab(tab.key);
                          setLogPage(1);
                        }}
                        onKeyDown={(event) => {
                          if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;

                          event.preventDefault();
                          const currentIndex = PRINT_LOG_TABS.findIndex(item => item.key === activeTab);
                          const nextIndex = event.key === 'ArrowRight'
                            ? (currentIndex + 1) % PRINT_LOG_TABS.length
                            : (currentIndex - 1 + PRINT_LOG_TABS.length) % PRINT_LOG_TABS.length;
                          const nextTab = PRINT_LOG_TABS[nextIndex];
                          setActiveTab(nextTab.key);
                          setLogPage(1);
                          window.requestAnimationFrame(() => {
                            logTabListRef.current
                              ?.querySelector<HTMLButtonElement>(`[data-log-tab="${nextTab.key}"]`)
                              ?.focus();
                          });
                        }}
                      >
                        {tab.title}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="cmhub-log-card-actions">
                  <ArcoButton
                    type="text"
                    size="mini"
                    status="danger"
                    className="cmhub-log-clear-button"
                    onClick={() => {
                      clearLogsByType(activeTab);
                      setLogPage(1);
                    }}
                  >
                    <X className="w-3 h-3" /> 清空当前记录
                  </ArcoButton>
                </div>
              </div>
              <div className="cmhub-log-card-meta">
                <span>当前分类已保存 <b className="text-text-primary">{logQuery.total.toLocaleString()}</b> / {MAX_PRINT_LOG_ENTRIES.toLocaleString()} 条</span>
                <span className="whitespace-nowrap">每页 {LOGS_PER_PAGE} 条 · 最新优先</span>
              </div>
              <div id="cmhub-log-table" key={activeTab} className="cmhub-log-content" role="tabpanel">
                <PrintLogTable logs={logQuery.logs} latestLogId={lastLogId} />
              </div>
              {logQuery.total > 0 && (
                <div className="cmhub-log-card-footer">
                  <span>第 {currentLogPage.toLocaleString()} / {totalLogPages.toLocaleString()} 页</span>
                  <div className="flex items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() => setLogPage(page => Math.max(1, page - 1))}
                      disabled={currentLogPage === 1}
                      aria-label="上一页"
                      className="rounded-md border border-white/10 px-2.5 py-1.5 text-text-primary transition-colors hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      &lt;
                    </button>
                    {paginationItems.map(page => {
                      if (typeof page !== 'number') {
                        return <span key={page} className="px-1 text-text-secondary/70" aria-hidden="true">…</span>;
                      }

                      return (
                        <button
                          key={page}
                          type="button"
                          onClick={() => setLogPage(page)}
                          aria-label={`第 ${page} 页`}
                          aria-current={currentLogPage === page ? 'page' : undefined}
                          className={cn(
                            "min-w-8 rounded-md border px-2 py-1.5 transition-colors",
                            currentLogPage === page
                              ? "border-brand-green/60 bg-brand-green/15 text-brand-green"
                              : "border-white/10 text-text-primary hover:bg-white/10"
                          )}
                        >
                          {page}
                        </button>
                      );
                    })}
                    <button
                      type="button"
                      onClick={() => setLogPage(page => Math.min(totalLogPages, page + 1))}
                      disabled={currentLogPage === totalLogPages}
                      aria-label="下一页"
                      className="rounded-md border border-white/10 px-2.5 py-1.5 text-text-primary transition-colors hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      &gt;
                    </button>
                  </div>
                </div>
              )}
              </ArcoCard>
            </section>
        </div>
      </div>
    </div>
  );
}
