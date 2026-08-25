import { useState, useEffect, useMemo, useRef } from 'react';
import printJS from 'print-js';
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
import { Upload, FileSpreadsheet, FileText, Scan, Printer, CheckCircle2, AlertCircle, AlertTriangle, History, X, Settings, RefreshCw, Save, ChevronDown, Check, Volume2, VolumeX, PlayCircle, PlugZap, ShieldAlert } from 'lucide-react';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
import { useLocation, useNavigate } from 'react-router-dom';
import QzSetupGuide from '../settings/QzSetupGuide';
import InterceptAlertOverlay from '../intercepts/InterceptAlertOverlay';
import { findStoredInterceptRule, type InterceptRule, useInterceptRules } from '../intercepts/useInterceptRules';
import PrintLogTable from './PrintLogTable';
import { usePrintLogs, MAX_PRINT_LOG_ENTRIES } from './hooks/usePrintLogs';
import { useScanFeedback } from './hooks/useScanFeedback';
import { PRINT_LOG_TABS, SCAN_FEEDBACK_COPY, type PrintLogTab, type PrintLogType, type PrintOutcome } from './printingTypes';

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

const AUDIO_SETTINGS_VERSION = 'audio-feedback-v2';
const LOGS_PER_PAGE = 20;
const QZ_PRINT_TIMEOUT_MS = 3_000;
const AUDIO_PREVIEW_LONG_PRESS_MS = 450;
const LOCAL_PRINT_SERVER_ENDPOINTS = ['http://127.0.0.1:3001', 'http://localhost:3001'];
const LOCAL_WEB_HOSTS = ['127.0.0.1', 'localhost', '::1'];
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

type LocalPrintServerStatus = 'unknown' | 'connected' | 'offline';
type PrinterBridge = 'none' | 'qz' | 'local';
type QzSecurityState = 'unknown' | 'signed' | 'unsigned' | 'error';
type QzConnectionHealth = 'idle' | 'healthy' | 'offline';

interface QzSecurityStatus {
  state: QzSecurityState;
  message: string;
}

interface MappingData {
  firstLeg: string;
  exchange: string;
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

const sanitizeBarcode = (value: string) => value.trim().replace(/[\x00-\x1F\x7F-\x9F]/g, '');
const normalizeBarcode = (value: string) => sanitizeBarcode(value).toLowerCase();

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
  const navigate = useNavigate();
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [pdfFiles, setPdfFiles] = useState<Record<string, File>>({});
  const [scanInput, setScanInput] = useState('');
  const { logs, lastLogId, addLog: appendLog, clearLogsByType } = usePrintLogs();
  const { scanFeedback, announceScanFeedback } = useScanFeedback();
  const { findRule: findInterceptRule, storageStatus: interceptStorageStatus } = useInterceptRules();
  const [activeTab, setActiveTab] = useState<PrintLogTab>('print');
  const [logPage, setLogPage] = useState(1);
  const [stats, setStats] = useState({ excelCount: 0, pdfCount: 0, printedCount: 0 });
  const [isDataImportOpen, setIsDataImportOpen] = useState(false);
  const [isQzGuideOpen, setIsQzGuideOpen] = useState(false);
  const [excelFile, setExcelFile] = useState<FileInfo | null>(null);
  const [pdfFolder, setPdfFolder] = useState<FileInfo | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [settingsPanel, setSettingsPanel] = useState<SettingsPanel>('printer');
  const [printers, setPrinters] = useState<string[]>([]);
  const [selectedPrinter, setSelectedPrinter] = useState<string>(localStorage.getItem('selectedPrinter') || '');
  const [isPrinterDropdownOpen, setIsPrinterDropdownOpen] = useState(false);
  const [isPrinterLoading, setIsPrinterLoading] = useState(false);
  const [excludedPrinterCount, setExcludedPrinterCount] = useState(0);
  const [printServerStatus, setPrintServerStatus] = useState<LocalPrintServerStatus>('unknown');
  const [printerBridge, setPrinterBridge] = useState<PrinterBridge>('none');
  const [printServerBaseUrl, setPrintServerBaseUrl] = useState(localStorage.getItem('localPrintServerBaseUrl') || '');
  const [printServerMessage, setPrintServerMessage] = useState('');
  const [qzSecurityStatus, setQzSecurityStatus] = useState<QzSecurityStatus>({
    state: 'unknown',
    message: '尚未检测 QZ 官方证书签名'
  });
  const [qzConnectionHealth, setQzConnectionHealth] = useState<QzConnectionHealth>('idle');
  const [audioEnabled, setAudioEnabled] = useState(() => localStorage.getItem('audioFeedbackEnabled') !== 'false');
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
  const interceptScanLockRef = useRef<string | null>(null);
  const printerDropdownRef = useRef<HTMLDivElement>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const activeAudioRef = useRef<ActiveAudio | null>(null);
  const qzConnectPromiseRef = useRef<Promise<void> | null>(null);
  const qzSecurityPromiseRef = useRef<Promise<QzSecurityStatus> | null>(null);
  const audioFailureLoggedRef = useRef(false);
  const recentAudioRequestsRef = useRef<number[]>([]);
  const previewLongPressTimerRef = useRef<number | null>(null);
  const previewLongPressPlayedRef = useRef(false);
  const mappingWorkerRef = useRef<Worker | null>(null);
  const pendingExcelFileNameRef = useRef('');
  const logTabListRef = useRef<HTMLDivElement>(null);
  const logTabPillRef = useRef<HTMLSpanElement>(null);
  const logSectionRef = useRef<HTMLElement>(null);
  const logTabMotionInitializedRef = useRef(false);
  const interceptStorageNoticeLoggedRef = useRef(false);
  const printerOptions = [
    { value: '', label: '自动选择可直打打印机', hint: printerBridge === 'qz' ? '自动通过 QZ Tray 匹配真实打印机' : '自动跳过 PDF24 等虚拟设备' },
    ...printers.map(printer => ({ value: printer, label: printer, hint: printerBridge === 'qz' ? 'QZ Tray 已检测到的本机设备' : '本机已检测到的打印设备' }))
  ];
  const selectedPrinterLabel = printerOptions.find(option => option.value === selectedPrinter)?.label || selectedPrinter || '自动选择可直打打印机';
  const filteredLogs = useMemo(
    () => logs.filter(log => log.type === activeTab),
    [logs, activeTab]
  );
  const totalLogPages = Math.max(1, Math.ceil(filteredLogs.length / LOGS_PER_PAGE));
  const currentLogPage = Math.min(logPage, totalLogPages);
  const visibleLogs = useMemo(() => {
    const startIndex = (currentLogPage - 1) * LOGS_PER_PAGE;
    return filteredLogs
      .slice(startIndex, startIndex + LOGS_PER_PAGE)
      .map((log, index) => ({
        ...log,
        rowNumber: filteredLogs.length - (startIndex + index)
      }));
  }, [currentLogPage, filteredLogs]);
  const paginationItems = useMemo(
    () => createPaginationItems(currentLogPage, totalLogPages),
    [currentLogPage, totalLogPages]
  );

  const ensureMappingWorker = () => {
    if (mappingWorkerRef.current) return mappingWorkerRef.current;

    const worker = new Worker(new URL('./mappingWorker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (event: MessageEvent<{
      type: 'success' | 'error';
      mapping?: Record<string, string>;
      count?: number;
      message?: string;
    }>) => {
      const fileName = pendingExcelFileNameRef.current || 'Excel 文件';
      if (event.data.type === 'success' && event.data.mapping && event.data.count) {
        setMapping(event.data.mapping);
        setStats(prev => ({ ...prev, excelCount: event.data.count ?? 0 }));
        addLog('System', fileName, `Excel 导入成功，共 ${event.data.count} 条记录`, 'success', 'import');
        setExcelFile({ name: fileName, status: 'success', message: `成功导入 ${event.data.count} 条` });
        return;
      }

      const message = event.data.message || 'Excel 解析失败。';
      setMapping({});
      setStats(prev => ({ ...prev, excelCount: 0 }));
      addLog('System', fileName, `Excel 导入失败: ${message}`, 'error', 'import');
      setExcelFile({ name: fileName, status: 'error', message });
    };
    worker.onerror = () => {
      const fileName = pendingExcelFileNameRef.current || 'Excel 文件';
      const message = 'Excel 解析线程异常，请重新上传。';
      setMapping({});
      setStats(prev => ({ ...prev, excelCount: 0 }));
      addLog('System', fileName, message, 'error', 'import');
      setExcelFile({ name: fileName, status: 'error', message });
    };
    mappingWorkerRef.current = worker;
    return worker;
  };

  const parseExcelOnMainThread = async (file: File) => {
    try {
      const [XLSX, buffer] = await Promise.all([import('xlsx'), file.arrayBuffer()]);
      const workbook = XLSX.read(new Uint8Array(buffer), { type: 'array' });
      const firstSheetName = workbook.SheetNames[0];
      const worksheet = workbook.Sheets[firstSheetName];
      if (!worksheet) throw new Error('文件中没有找到工作表。');

      const mapping: Record<string, string> = {};
      let count = 0;
      for (const row of XLSX.utils.sheet_to_json(worksheet) as Record<string, unknown>[]) {
        const firstLeg = String(row['头程单号'] || '').trim();
        const exchange = String(row['快递单号'] || '').trim();
        if (!firstLeg || !exchange) continue;
        mapping[firstLeg] = exchange;
        count += 1;
      }
      if (count === 0) throw new Error('无法从文件中解析出有效的单号映射关系。');

      setMapping(mapping);
      setStats(prev => ({ ...prev, excelCount: count }));
      addLog('System', file.name, `Excel 导入成功，共 ${count} 条记录`, 'success', 'import');
      setExcelFile({ name: file.name, status: 'success', message: `成功导入 ${count} 条` });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Excel 解析失败。';
      setMapping({});
      setStats(prev => ({ ...prev, excelCount: 0 }));
      addLog('System', file.name, `Excel 导入失败: ${message}`, 'error', 'import');
      setExcelFile({ name: file.name, status: 'error', message });
    }
  };

  const canUseSameOriginPrintProxy = () => (
    import.meta.env.DEV &&
    LOCAL_WEB_HOSTS.includes(window.location.hostname) &&
    ['5173', '5174', '5175'].includes(window.location.port)
  );

  const formatPrintServerEndpoint = (endpoint: string) => (
    endpoint || '本地开发代理 /api → 127.0.0.1:3001'
  );

  const formatQzError = (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
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

  const getLocalPrintServerEndpoints = () => {
    const savedEndpoint = localStorage.getItem('localPrintServerBaseUrl');
    const baseEndpoints = canUseSameOriginPrintProxy()
      ? ['', ...LOCAL_PRINT_SERVER_ENDPOINTS]
      : LOCAL_PRINT_SERVER_ENDPOINTS;
    const endpoints = savedEndpoint && baseEndpoints.includes(savedEndpoint) && savedEndpoint !== ''
      ? ['', savedEndpoint, ...baseEndpoints.filter(endpoint => endpoint !== '' && endpoint !== savedEndpoint)]
      : baseEndpoints;

    return Array.from(new Set(endpoints));
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
        void qz.websocket.disconnect().catch(() => undefined);
        setQzConnectionHealth('offline');
        reject(new Error('QZ Tray 响应超时（超过 3 秒），已中断本次打印。'));
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
    const connectionErrors: string[] = [];
    try {
      const qzInventory = await getQzPrinterInventory();
      if (qzInventory.directPrinters.length > 0) {
        setPrintServerStatus('connected');
        setPrinterBridge('qz');
        setPrintServerBaseUrl('QZ Tray 本机连接');
        setPrintServerMessage(qzInventory.securityStatus.state === 'signed'
          ? 'QZ Tray 已连接，官方证书签名已启用'
          : 'QZ Tray 已连接，但官方证书签名未完成，打印时可能弹出授权确认'
        );
        setPrinters(qzInventory.directPrinters);
        setExcludedPrinterCount(qzInventory.excludedPrinters.length);
        setSelectedPrinter(currentPrinter => {
          if (currentPrinter && qzInventory.directPrinters.includes(currentPrinter)) {
            return currentPrinter;
          }
          return qzInventory.preferredPrinter || '';
        });
        return;
      }

      connectionErrors.push('QZ Tray 已连接，但未检测到可直打的真实打印机。');
    } catch (qzError) {
      connectionErrors.push(formatQzError(qzError));
    }

    try {
      const { response: res, endpoint } = await requestLocalPrintServer('/api/printers');
      const data = await res.json();
      if (data.success) {
        const directPrinters = Array.isArray(data.printers) ? data.printers : [];
        const preferredPrinter = typeof data.defaultPrinter === 'string' ? data.defaultPrinter : '';
        setPrintServerStatus('connected');
        setPrinterBridge('local');
        setPrintServerBaseUrl(formatPrintServerEndpoint(endpoint));
        setPrintServerMessage(`已连接本机打印服务：${formatPrintServerEndpoint(endpoint)}`);
        setPrinters(directPrinters);
        setExcludedPrinterCount(Array.isArray(data.excludedPrinters) ? data.excludedPrinters.length : 0);
        setSelectedPrinter(currentPrinter => {
          if (currentPrinter && directPrinters.includes(currentPrinter)) {
            return currentPrinter;
          }
          return preferredPrinter || '';
        });
      } else {
        addLog('System', '-', `获取打印机列表失败: ${data.message || '未知错误'}`, 'error', 'system');
      }
    } catch (error) {
      const localMessage = error instanceof Error ? error.message : '无法连接到本机打印服务';
      const message = [
        ...connectionErrors,
        localMessage
      ].filter(Boolean).join('；');
      setPrintServerStatus('offline');
      setPrinterBridge('none');
      setPrintServerBaseUrl('');
      setPrintServerMessage(message);
      addLog('System', '-', message, 'error', 'system');
    } finally {
      setIsPrinterLoading(false);
    }
  };

  const requestLocalPrintServer = async (path: string, init?: RequestInit) => {
    const endpoints = getLocalPrintServerEndpoints();
    const errors: string[] = [];

    for (const endpoint of endpoints) {
      const controller = new AbortController();
      const timeoutMs = path === '/api/printers' ? 10000 : 60000;
      const timeoutId = window.setTimeout(() => controller.abort(), timeoutMs);

      try {
        const response = await fetch(`${endpoint}${path}`, {
          ...init,
          signal: controller.signal
        });

        if (!response.ok) {
          const contentType = response.headers.get('content-type') || '';
          if (!contentType.includes('application/json')) {
            const responseText = await response.clone().text().catch(() => '');
            errors.push(`${formatPrintServerEndpoint(endpoint)}: HTTP ${response.status}${responseText ? ` ${responseText.slice(0, 120)}` : ''}`);
            continue;
          }
        }

        if (endpoint) {
          localStorage.setItem('localPrintServerBaseUrl', endpoint);
        } else {
          localStorage.removeItem('localPrintServerBaseUrl');
        }
        return { response, endpoint };
      } catch (error) {
        errors.push(`${formatPrintServerEndpoint(endpoint)}: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        window.clearTimeout(timeoutId);
      }
    }

    throw new Error(`无法连接本机打印服务。请先在当前电脑启动本地打印服务，再刷新列表。已尝试：${endpoints.map(formatPrintServerEndpoint).join('、')}。详情：${errors.join('；')}`);
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

  const getAudioContext = async () => {
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
  };

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
    recentAudioRequestsRef.current = [...recentAudioRequestsRef.current, requestTime].filter(time => requestTime - time <= 1000);

    if (!options.force && scanResult === 'success' && recentAudioRequestsRef.current.length > 10) {
      return;
    }

    try {
      const didInterrupt = stopActiveAudio();
      if (didInterrupt) {
        setAudioInterruptCount(count => count + 1);
      }

      const context = await getAudioContext();
      const startTime = context.currentTime;
      const duration = scanResult === 'success' ? 0.15 : 0.75;
      const volume = Math.max(0, Math.min(1, audioVolume / 100));
      const masterGain = context.createGain();
      const primaryOscillator = context.createOscillator();

      masterGain.connect(context.destination);
      masterGain.gain.setValueAtTime(0.0001, startTime);
      masterGain.gain.linearRampToValueAtTime((scanResult === 'success' ? 0.22 : 0.28) * volume, startTime + 0.015);
      masterGain.gain.exponentialRampToValueAtTime(0.0001, startTime + duration);

      primaryOscillator.connect(masterGain);
      primaryOscillator.type = scanResult === 'success' ? 'triangle' : 'sine';

      if (scanResult === 'success') {
        primaryOscillator.frequency.setValueAtTime(1000, startTime);
        primaryOscillator.frequency.setValueAtTime(1200, startTime + 0.075);
      } else {
        primaryOscillator.frequency.setValueAtTime(200, startTime);
      }

      primaryOscillator.start(startTime);
      primaryOscillator.stop(startTime + duration + 0.02);

      const cleanup = () => {
        try {
          primaryOscillator.disconnect();
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
    if (interceptStorageStatus === 'ready' || interceptStorageNoticeLoggedRef.current) return;
    interceptStorageNoticeLoggedRef.current = true;
    appendLog({
      firstLeg: 'System',
      exchange: '拦截名单',
      message: interceptStorageStatus === 'corrupted'
        ? '拦截库读取异常，当前扫码将跳过拦截判断。'
        : '拦截库无法写入本机缓存，当前名单在关闭页面后将失效。',
      status: 'error',
      type: 'system'
    });
  }, [appendLog, interceptStorageStatus]);

  const handleExcelUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setExcelFile({ name: file.name, status: 'loading', message: '正在读取并解析 Excel…' });
    pendingExcelFileNameRef.current = file.name;

    if (typeof Worker === 'undefined') {
      await parseExcelOnMainThread(file);
      return;
    }

    try {
      const buffer = await file.arrayBuffer();
      ensureMappingWorker().postMessage({ type: 'parse', buffer }, [buffer]);
    } catch (error) {
      const message = error instanceof Error ? error.message : '读取文件失败';
      addLog('System', file.name, `Excel 导入失败: ${message}`, 'error', 'import');
      setExcelFile({ name: file.name, status: 'error', message });
    }
  };

  const handlePdfUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    const newPdfFiles: Record<string, File> = {};
    let pdfCount = 0;
    Array.from(files).forEach(file => {
      if (file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf')) {
        const name = file.name.replace(/\.[^/.]+$/, "");
        newPdfFiles[name] = file;
        pdfCount++;
      }
    });

    if (pdfCount === 0) {
      const message = '选择的文件夹中未找到有效的 PDF 文件。';
      addLog('System', '-', message, 'error', 'import');
      setPdfFolder({ name: `共 ${files.length} 个文件`, status: 'error', message });
      return;
    }

    setPdfFiles(prev => {
      const updated = { ...prev, ...newPdfFiles };
      setStats(s => ({ ...s, pdfCount: Object.keys(updated).length }));
      return updated;
    });
    const message = `成功导入 ${pdfCount} 个 PDF 文件`;
    addLog('System', 'PDF 文件夹', message, 'success', 'import');
    setPdfFolder({ name: `已选择 ${pdfCount} 个 PDF`, status: 'success', message });
  };

  const processScan = (rawScannedValue: string, bypassDuplicateCheck = false, isDuplicateOverride = false) => {
    const scannedValue = sanitizeBarcode(rawScannedValue);
    if (!scannedValue) return;

    // Always check persisted rules as well as the in-memory index. This prevents
    // a scan from slipping through if the list was just changed in another view.
    const interceptedRule = findInterceptRule(scannedValue) ?? findStoredInterceptRule(scannedValue);
    if (interceptedRule) {
      const normalizedInterceptedValue = normalizeBarcode(scannedValue);
      if (interceptScanLockRef.current === normalizedInterceptedValue) return;
      interceptScanLockRef.current = normalizedInterceptedValue;
      setInterceptedScan({ code: scannedValue, rule: interceptedRule });
      announceScanFeedback('error');
      void playInterceptAlert();
      addLog(scannedValue, '-', '命中拦截名单，已阻断当前扫描与打印任务。', 'error', 'system');
      return;
    }

    // 0. Check for duplicates
    if (!bypassDuplicateCheck) {
      const now = Date.now();
      const fiveMinutesAgo = now - 5 * 60 * 1000;
      const normalizedScannedValue = normalizeBarcode(scannedValue);
      const isDuplicate = recentlyPrinted.some(p => normalizeBarcode(p.code) === normalizedScannedValue && p.timestamp > fiveMinutesAgo)
        || logs.some(log => (
          log.type === 'print'
          && normalizeBarcode(log.firstLeg) === normalizedScannedValue
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
    // 1. Try to find exchange number from mapping
    const cleanedScannedValue = normalizeBarcode(scannedValue);
    const mappingKey = Object.keys(mapping).find(k => k.trim().toLowerCase() === cleanedScannedValue);
    let finalExchangeNumber = mappingKey ? mapping[mappingKey] : null;

    // According to user: "文件名为头程单号" (Filename is First Leg Number)
    // Priority: 1. Scanned value is start of filename (prefix match) 2. Scanned value is anywhere in filename (fuzzy match)
    const allPdfKeys = Object.keys(pdfFiles);
    const prefixMatch = allPdfKeys.find(k => k.toLowerCase().startsWith(cleanedScannedValue));
    const fuzzyMatch = allPdfKeys.find(k => k.toLowerCase().includes(cleanedScannedValue));

    const pdfKey = prefixMatch || fuzzyMatch; // Prioritize prefix match
    
    // 2. If we found a PDF but still don't have an exchange number, try to find it via the PDF key
    if (pdfKey && !finalExchangeNumber) {
        // This is a fallback: maybe the PDF is named with the exchange number?
        const found = Object.entries(mapping).find(([_, exchangeVal]) => pdfKey.includes(exchangeVal));
        if (found) {
            finalExchangeNumber = found[1]; // The exchange number
        }
    }

    const pdfFile = pdfKey ? pdfFiles[pdfKey] : null;

    if (!pdfFile) {
      announceScanFeedback('error');
      void playScanFeedback('failure');
      addLog(scannedValue, finalExchangeNumber ?? '-', '未找到对应的 PDF 文件', 'error', 'print');
      return;
    }

    // At this point, if we still don't have it, set to '-'
    finalExchangeNumber = finalExchangeNumber || '-';
    announceScanFeedback('processing');
    void playScanFeedback('success');

    // Convert file to Base64 for backend printing
    const reader = new FileReader();
    reader.onload = async () => {
      const base64 = (reader.result as string).split(',')[1];
      
      try {
        if (printerBridge === 'qz') {
          const result = await printPdfWithQz(base64);
          setPrintServerStatus('connected');
          setPrinterBridge('qz');
          setPrintServerBaseUrl('QZ Tray 本机连接');
          setPrintServerMessage(`QZ Tray 已连接：${result.printerName}`);
          announceScanFeedback('success');
          addLog(scannedValue, finalExchangeNumber, result.message, 'success', 'print', isDuplicateOverride ? 'DUPLICATE_OVERRIDE' : 'SUCCESS');
          setStats(prev => ({ ...prev, printedCount: prev.printedCount + 1 }));
          const newTimestamp = Date.now();
          setRecentlyPrinted(prev => 
            [...prev, { code: scannedValue, timestamp: newTimestamp }].filter(p => p.timestamp > newTimestamp - 5 * 60 * 1000)
          );
        } else {
          try {
            const { response, endpoint } = await requestLocalPrintServer('/api/print', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                pdfBase64: base64,
                printerName: selectedPrinter,
                fileName: pdfFile.name
              })
            });
            setPrintServerStatus('connected');
            setPrinterBridge('local');
            setPrintServerBaseUrl(formatPrintServerEndpoint(endpoint));
            setPrintServerMessage(`已连接本机打印服务：${formatPrintServerEndpoint(endpoint)}`);

            const result = await response.json();
            if (result.success) {
              announceScanFeedback('success');
              addLog(scannedValue, finalExchangeNumber, result.message || '打印任务已提交到打印机', 'success', 'print', isDuplicateOverride ? 'DUPLICATE_OVERRIDE' : 'SUCCESS');
              setStats(prev => ({ ...prev, printedCount: prev.printedCount + 1 }));
              const newTimestamp = Date.now();
              setRecentlyPrinted(prev => 
                [...prev, { code: scannedValue, timestamp: newTimestamp }].filter(p => p.timestamp > newTimestamp - 5 * 60 * 1000)
              );
            } else {
              announceScanFeedback('error');
              void playScanFeedback('failure');
              addLog(scannedValue, finalExchangeNumber, `打印失败: ${result.message}`, 'error', 'print');
            }
          } catch (localPrintError) {
            const result = await printPdfWithQz(base64).catch(qzPrintError => {
              const localMessage = localPrintError instanceof Error ? localPrintError.message : String(localPrintError);
              throw new Error(`本地打印服务失败：${localMessage}；${formatQzError(qzPrintError)}`);
            });
            setPrintServerStatus('connected');
            setPrinterBridge('qz');
            setPrintServerBaseUrl('QZ Tray 本机连接');
            setPrintServerMessage(`QZ Tray 已连接：${result.printerName}`);
            announceScanFeedback('success');
            addLog(scannedValue, finalExchangeNumber, result.message, 'success', 'print', isDuplicateOverride ? 'DUPLICATE_OVERRIDE' : 'SUCCESS');
            setStats(prev => ({ ...prev, printedCount: prev.printedCount + 1 }));
            const newTimestamp = Date.now();
            setRecentlyPrinted(prev => 
              [...prev, { code: scannedValue, timestamp: newTimestamp }].filter(p => p.timestamp > newTimestamp - 5 * 60 * 1000)
            );
          }
        }
      } catch (error) {
        announceScanFeedback('error');
        void playScanFeedback('failure');
        const message = printerBridge === 'qz'
          ? formatQzError(error)
          : (error instanceof Error ? error.message : '打印服务未响应，请检查后端');
        setPrintServerStatus('offline');
        setPrintServerBaseUrl('');
        setPrintServerMessage(message);
        addLog(scannedValue, finalExchangeNumber, message, 'error', 'print', message.includes('超时') ? 'TIMEOUT' : 'FAILED');
      }
    };
    reader.onerror = () => {
      announceScanFeedback('error');
      void playScanFeedback('failure');
      addLog(scannedValue, finalExchangeNumber, '读取 PDF 文件失败', 'error', 'print');
    };
    reader.readAsDataURL(pdfFile);
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
    const interceptedRule = findInterceptRule(nextValue) ?? findStoredInterceptRule(nextValue);
    if (!interceptedRule) return;

    setScanInput('');
    processScan(nextValue, false);
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

  return (
    <div className="cmhub-operating-workspace min-h-full p-4 md:p-6 xl:p-8">
      <div className="w-full space-y-5">
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
        <ArcoCard className="cmhub-operating-card" bordered>
        <header className="cmhub-operating-header">
          <div className="cmhub-operating-title">
            <Typography.Title heading={3} className="!mb-0">扫码与本机打印工作台</Typography.Title>
          </div>
          
          <div className="cmhub-operating-header-actions">
            <div className="cmhub-header-metrics">
              <div className="text-center">
                <div className="text-2xl font-bold text-text-primary">{stats.excelCount}</div>
                <div className="text-xs text-text-secondary uppercase font-semibold">Excel 条目</div>
              </div>
              <div className="text-center border-x px-6 border-white/10">
                <div className="text-2xl font-bold text-text-primary">{stats.pdfCount}</div>
                <div className="text-xs text-text-secondary uppercase font-semibold">PDF 文件</div>
              </div>
              <div className="text-center">
                <div className="text-2xl font-bold text-text-primary">{stats.printedCount}</div>
                <div className="text-xs text-text-secondary uppercase font-semibold">已打印</div>
              </div>
            </div>
            
            <div className="cmhub-header-utilities" role="toolbar" aria-label="扫码打单快捷操作">
              <Tooltip content="QZ Tray 教程与新电脑配置">
                <ArcoButton
                  type="text"
                  shape="circle"
                  size="large"
                  aria-label="打开 QZ Tray 教程与新电脑配置"
                  icon={<PlugZap size={20} />}
                  onClick={() => setIsQzGuideOpen(true)}
                />
              </Tooltip>
              <Tooltip content="拦截名单管理">
                <ArcoButton
                  type="text"
                  shape="circle"
                  size="large"
                  aria-label="打开拦截名单管理"
                  icon={<ShieldAlert size={20} />}
                  onClick={() => navigate('/operations/intercepts')}
                />
              </Tooltip>
              <Tooltip content="导入 Excel 映射与 PDF 面单">
                <ArcoButton
                  type="text"
                  shape="circle"
                  size="large"
                  aria-label="打开数据导入"
                  icon={<FileSpreadsheet size={20} />}
                  onClick={openDataImport}
                />
              </Tooltip>
              <Tooltip content="系统设置">
                <ArcoButton
                  type="text"
                  shape="circle"
                  size="large"
                  aria-label="打开系统设置"
                  icon={<Settings size={20} />}
                  onClick={() => openSettings('printer')}
                />
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

        {interceptStorageStatus !== 'ready' && (
          <ArcoAlert
            type="warning"
            showIcon
            content={interceptStorageStatus === 'corrupted'
              ? '拦截名单读取异常，当前扫码将跳过拦截判断；请在“拦截名单”中重新添加单号。'
              : '拦截名单无法保存到本机缓存，本次会话关闭后将失效。'}
          />
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
                      printServerStatus === 'connected' ? "text-brand-green" : printServerStatus === 'offline' ? "text-red-400" : "text-text-secondary/50"
                    )}>
                      {printServerStatus === 'connected'
                        ? `本地打印服务已连接：${printServerBaseUrl}`
                        : printServerStatus === 'offline'
                          ? printServerMessage
                          : '部署页面需要当前电脑同时运行本地打印服务'}
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
                        <Typography.Text type="secondary">点击成功 / 长按失败</Typography.Text>
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
          visible={isDataImportOpen}
          className="cmhub-utility-drawer"
          width={680}
          title={<ArcoSpace><FileSpreadsheet size={20} /><span>数据导入与面单库</span></ArcoSpace>}
          footer={null}
          onCancel={() => setIsDataImportOpen(false)}
        >
          <section id="data-import" className="cmhub-data-import-drawer" aria-label="数据导入与面单库">
            <div className="cmhub-data-import-summary cmhub-data-import-drawer-summary" aria-live="polite">
              <span>{excelFile ? `${stats.excelCount.toLocaleString()} 条 Excel 映射` : '未导入 Excel'}</span>
              <span>{pdfFolder ? `${stats.pdfCount.toLocaleString()} 个 PDF` : '未选择 PDF 文件夹'}</span>
            </div>
            <div className="cmhub-data-import-body">
                <div className="cmhub-data-import-grid">
                <div className="cmhub-import-source">
                  <div className="cmhub-import-source-heading">
                    <span><FileSpreadsheet size={18} aria-hidden="true" /> Excel 映射</span>
                    {excelFile && (
                      <ArcoButton type="text" size="mini" onClick={() => document.getElementById('excel-input')?.click()}>
                        重新上传
                      </ArcoButton>
                    )}
                  </div>
                  <label className="cmhub-import-drop-target">
                    {!excelFile ? (
                      <>
                        <Upload size={24} aria-hidden="true" />
                        <span>点击或拖拽上传 Excel</span>
                      </>
                    ) : (
                      <>
                        {excelFile.status === 'loading' ? <RefreshCw size={24} className="animate-spin" aria-hidden="true" /> : excelFile.status === 'success' ? <CheckCircle2 size={24} aria-hidden="true" /> : <AlertCircle size={24} aria-hidden="true" />}
                        <strong>{excelFile.name}</strong>
                        <small>{excelFile.message}</small>
                      </>
                    )}
                    <input id="excel-input" type="file" className="hidden" accept=".xlsx, .xls" onChange={(event) => void handleExcelUpload(event)} />
                  </label>
                </div>

                <div className="cmhub-import-source">
                  <div className="cmhub-import-source-heading">
                    <span><FileText size={18} aria-hidden="true" /> 面单库（PDF 文件夹）</span>
                    {pdfFolder && (
                      <ArcoButton type="text" size="mini" onClick={() => document.getElementById('pdf-input')?.click()}>
                        重新选择
                      </ArcoButton>
                    )}
                  </div>
                  <label className="cmhub-import-drop-target">
                    {!pdfFolder ? (
                      <>
                        <Upload size={24} aria-hidden="true" />
                        <span>选择包含 PDF 的文件夹</span>
                      </>
                    ) : (
                      <>
                        {pdfFolder.status === 'success' ? <CheckCircle2 size={24} aria-hidden="true" /> : <AlertCircle size={24} aria-hidden="true" />}
                        <strong>{pdfFolder.name}</strong>
                        <small>{pdfFolder.message}</small>
                      </>
                    )}
                    {/* @ts-ignore */}
                    <input id="pdf-input" type="file" className="hidden" webkitdirectory="" directory="" multiple onChange={handlePdfUpload} />
                  </label>
                </div>
                </div>
                <p className="cmhub-data-import-note">
                  <AlertCircle size={15} aria-hidden="true" /> 文件名需包含 Excel 中的转单号；扫码枪请设置为回车结束模式。
                </p>
            </div>
          </section>
        </Drawer>

        <div className="space-y-5">
            {/* Scanner Input */}
            <ArcoCard className="cmhub-operating-card cmhub-scanner-card" data-state={scanFeedback} bordered>
              <div className="space-y-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2 font-semibold text-text-primary">
                  <Scan className="w-6 h-6 text-brand-green" />
                  <h2 className="text-xl">扫码区域</h2>
                </div>
                <div className="cmhub-scan-status" role="status" aria-live="polite">
                  <span className="cmhub-scan-status-dot" aria-hidden="true" />
                  {scanFeedbackCopy}
                </div>
              </div>
              
                <ArcoInput
                  value={scanInput}
                  onChange={handleScanInputChange}
                  onPressEnter={() => {
                    const scannedValue = scanInput;
                    setScanInput('');
                    processScan(scannedValue, false);
                  }}
                  placeholder="等待扫码..."
                  size="large"
                  className="cmhub-scan-input"
                  aria-label="扫码输入框，输入完成后按回车开始处理"
                />
              </div>
            </ArcoCard>

            {/* Logs */}
            <section id="operation-log" ref={logSectionRef} tabIndex={-1} aria-label="操作日志">
              <ArcoCard className="cmhub-operating-card cmhub-log-card" bordered bodyStyle={{ padding: 0 }}>
              <div className="p-4 border-b border-white/10 flex items-center justify-between">
                <div className="flex items-center gap-4">
                  <div className="flex items-center gap-2 font-semibold text-text-primary mr-2">
                    <History className="w-5 h-5 text-text-secondary" />
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
              <div className="px-4 py-2.5 border-b border-white/5 flex items-center justify-between gap-3 text-xs text-text-secondary">
                <span>当前分类已保存 <b className="text-text-primary">{filteredLogs.length.toLocaleString()}</b> / {MAX_PRINT_LOG_ENTRIES.toLocaleString()} 条</span>
                <span className="whitespace-nowrap">每页 {LOGS_PER_PAGE} 条 · 最新优先</span>
              </div>
              <div id="cmhub-log-table" key={activeTab} className="cmhub-log-content" role="tabpanel">
                <PrintLogTable logs={visibleLogs} latestLogId={lastLogId} />
              </div>
              {filteredLogs.length > 0 && (
                <div className="px-4 py-3 border-t border-white/10 flex items-center justify-between gap-3 text-xs text-text-secondary">
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
