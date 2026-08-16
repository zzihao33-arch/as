import { useState, useEffect, useRef } from 'react';
import * as XLSX from 'xlsx';
import printJS from 'print-js';
import { Upload, FileSpreadsheet, FileText, Scan, Printer, CheckCircle2, AlertCircle, History, X, Settings, RefreshCw, Save, ChevronDown, Check, Volume2, VolumeX, PlayCircle } from 'lucide-react';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

const AUDIO_SETTINGS_VERSION = 'audio-feedback-v2';
const LOCAL_PRINT_SERVER_ENDPOINTS = ['http://127.0.0.1:3001', 'http://localhost:3001'];

type LocalPrintServerStatus = 'unknown' | 'connected' | 'offline';

// Debounce hook
function useDebounce<T>(value: T, delay: number): T {
  const [debouncedValue, setDebouncedValue] = useState<T>(value);
  useEffect(() => {
    const handler = setTimeout(() => {
      setDebouncedValue(value);
    }, delay);
    return () => {
      clearTimeout(handler);
    };
  }, [value, delay]);
  return debouncedValue;
}

interface MappingData {
  firstLeg: string;
  exchange: string;
}

interface PrintLog {
  time: string;
  firstLeg: string;
  exchange: string;
  status: 'success' | 'error';
  message: string;
  type: 'import' | 'print' | 'system';
}

interface RecentlyPrinted {
  code: string;
  timestamp: number;
}

interface FileInfo {
  name: string;
  status: 'success' | 'error';
  message?: string;
}

type SettingsPanel = 'printer' | 'audio';
type ScanResult = 'success' | 'failure';
type AudioFocusState = 'idle' | 'playing' | 'failed';

interface ActiveAudio {
  stop: () => void;
  startedAt: number;
  timerId: number;
}

export default function App() {
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [pdfFiles, setPdfFiles] = useState<Record<string, File>>({});
  const [scanInput, setScanInput] = useState('');
  const [logs, setLogs] = useState<PrintLog[]>([]);
  const [activeTab, setActiveTab] = useState<'import' | 'print' | 'system'>('print');
  const [stats, setStats] = useState({ excelCount: 0, pdfCount: 0, printedCount: 0 });
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
  const [printServerBaseUrl, setPrintServerBaseUrl] = useState(localStorage.getItem('localPrintServerBaseUrl') || '');
  const [printServerMessage, setPrintServerMessage] = useState('');
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
  const [lastPrintedCode, setLastPrintedCode] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const logContainerRef = useRef<HTMLDivElement>(null);
  const printerDropdownRef = useRef<HTMLDivElement>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const activeAudioRef = useRef<ActiveAudio | null>(null);
  const audioFailureLoggedRef = useRef(false);
  const recentAudioRequestsRef = useRef<number[]>([]);
  const previewLongPressTimerRef = useRef<number | null>(null);
  const previewLongPressPlayedRef = useRef(false);
  const debouncedScanInput = useDebounce(scanInput, 50);
  const printerOptions = [
    { value: '', label: '自动选择可直打打印机', hint: '自动跳过 PDF24 等虚拟设备' },
    ...printers.map(printer => ({ value: printer, label: printer, hint: '本机已检测到的打印设备' }))
  ];
  const selectedPrinterLabel = printerOptions.find(option => option.value === selectedPrinter)?.label || selectedPrinter || '自动选择可直打打印机';

  // Process scan after debounce
  useEffect(() => {
    if (debouncedScanInput) {
      processScan(debouncedScanInput, false);
      setScanInput('');
    }
  }, [debouncedScanInput]);

  // Load printers
  useEffect(() => {
    if (showSettings && settingsPanel === 'printer') {
      fetchPrinters();
    } else {
      setIsPrinterDropdownOpen(false);
    }
  }, [showSettings, settingsPanel]);

  useEffect(() => {
    localStorage.setItem('audioFeedbackEnabled', String(audioEnabled));
  }, [audioEnabled]);

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
      const { response: res, endpoint } = await requestLocalPrintServer('/api/printers');
      const data = await res.json();
      if (data.success) {
        const directPrinters = Array.isArray(data.printers) ? data.printers : [];
        const preferredPrinter = typeof data.defaultPrinter === 'string' ? data.defaultPrinter : '';
        setPrintServerStatus('connected');
        setPrintServerBaseUrl(endpoint);
        setPrintServerMessage(`已连接本机打印服务：${endpoint}`);
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
      const message = error instanceof Error ? error.message : '无法连接到本机打印服务';
      setPrintServerStatus('offline');
      setPrintServerBaseUrl('');
      setPrintServerMessage(message);
      addLog('System', '-', message, 'error', 'system');
    } finally {
      setIsPrinterLoading(false);
    }
  };

  const requestLocalPrintServer = async (path: string, init?: RequestInit) => {
    const savedEndpoint = localStorage.getItem('localPrintServerBaseUrl');
    const endpoints = savedEndpoint && LOCAL_PRINT_SERVER_ENDPOINTS.includes(savedEndpoint)
      ? [savedEndpoint, ...LOCAL_PRINT_SERVER_ENDPOINTS.filter(endpoint => endpoint !== savedEndpoint)]
      : LOCAL_PRINT_SERVER_ENDPOINTS;
    const errors: string[] = [];

    for (const endpoint of endpoints) {
      const controller = new AbortController();
      const timeoutId = window.setTimeout(() => controller.abort(), 2500);

      try {
        const response = await fetch(`${endpoint}${path}`, {
          ...init,
          signal: controller.signal
        });

        localStorage.setItem('localPrintServerBaseUrl', endpoint);
        return { response, endpoint };
      } catch (error) {
        errors.push(`${endpoint}: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        window.clearTimeout(timeoutId);
      }
    }

    throw new Error(`无法连接本机打印服务。请先在当前电脑启动本地打印服务，再刷新列表。已尝试：${endpoints.join('、')}`);
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
      const duration = scanResult === 'success' ? 0.18 : 0.68;
      const volume = Math.max(0, Math.min(1, audioVolume / 100));
      const masterGain = context.createGain();
      const primaryOscillator = context.createOscillator();
      const secondaryOscillator = scanResult === 'failure' ? context.createOscillator() : null;

      masterGain.connect(context.destination);
      masterGain.gain.setValueAtTime(0.0001, startTime);
      masterGain.gain.linearRampToValueAtTime((scanResult === 'success' ? 0.22 : 0.18) * volume, startTime + 0.015);
      masterGain.gain.exponentialRampToValueAtTime(0.0001, startTime + duration);

      primaryOscillator.connect(masterGain);
      primaryOscillator.type = scanResult === 'success' ? 'triangle' : 'sawtooth';

      if (scanResult === 'success') {
        primaryOscillator.frequency.setValueAtTime(1120, startTime);
        primaryOscillator.frequency.exponentialRampToValueAtTime(1560, startTime + 0.08);
        primaryOscillator.frequency.setValueAtTime(1320, startTime + 0.12);
      } else {
        primaryOscillator.frequency.setValueAtTime(210, startTime);
        primaryOscillator.frequency.linearRampToValueAtTime(150, startTime + duration);

        if (secondaryOscillator) {
          secondaryOscillator.connect(masterGain);
          secondaryOscillator.type = 'sine';
          secondaryOscillator.frequency.setValueAtTime(105, startTime);
          secondaryOscillator.frequency.linearRampToValueAtTime(95, startTime + duration);
        }
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
    if (previewLongPressTimerRef.current) {
      window.clearTimeout(previewLongPressTimerRef.current);
    }

    previewLongPressTimerRef.current = window.setTimeout(() => {
      previewLongPressPlayedRef.current = true;
      void playScanFeedback('failure', { force: true });
    }, 450);
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

  const handleContainerClick = (e: React.MouseEvent<HTMLDivElement>) => {
    // If the click is on a non-interactive element, focus the scan input
    const target = e.target as HTMLElement;
    if (['DIV', 'HEADER', 'H1', 'P', 'UL', 'LI'].includes(target.tagName)) {
      inputRef.current?.focus();
    }
  };



  const handleExcelUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setExcelFile({ name: file.name, status: 'success' }); // Optimistically set

    const reader = new FileReader();
    reader.onload = (event) => {
      try {
        const data = new Uint8Array(event.target?.result as ArrayBuffer);
        const workbook = XLSX.read(data, { type: 'array' });
        const firstSheetName = workbook.SheetNames[0];
        const worksheet = workbook.Sheets[firstSheetName];
        if (!worksheet) throw new Error('文件中没有找到工作表。');

        const jsonData = XLSX.utils.sheet_to_json(worksheet) as any[];
        console.log('Raw data from Excel:', jsonData);

        const newMapping: Record<string, string> = {};
        let count = 0;
        jsonData.forEach((row, index) => {
          // Final robust implementation: Only rely on column names, ignore column order.
          const firstLeg = String(row['头程单号'] || '').trim();
          const exchange = String(row['快递单号'] || '').trim();
          console.log(`Row ${index + 1}: firstLeg='${firstLeg}', exchange='${exchange}'`);
          if (firstLeg && exchange) {
            newMapping[firstLeg] = exchange;
            count++;
          }
        });

        console.log('Constructed mapping:', newMapping);

        if (count === 0) {
          throw new Error('无法从文件中解析出有效的单号映射关系。');
        }

        setMapping(newMapping);
        setStats(prev => ({ ...prev, excelCount: Object.keys(newMapping).length }));
        addLog('System', file.name, `Excel 导入成功，共 ${count} 条记录`, 'success', 'import');
        setExcelFile({ name: file.name, status: 'success', message: `成功导入 ${count} 条` });
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : '未知错误';
        addLog('System', file.name, `Excel 导入失败: ${errorMessage}`, 'error', 'import');
        setExcelFile({ name: file.name, status: 'error', message: errorMessage });
        setMapping({});
        setStats(prev => ({ ...prev, excelCount: 0 }));
      }
    };
    reader.onerror = () => {
      addLog('System', file.name, '读取文件失败', 'error', 'import');
      setExcelFile({ name: file.name, status: 'error', message: '读取文件失败' });
    };
    reader.readAsArrayBuffer(file);
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


  const processScan = (scannedValue: string, bypassDuplicateCheck = false) => {
    // 0. Check for duplicates
    if (!bypassDuplicateCheck) {
      const now = Date.now();
      const fiveMinutesAgo = now - 5 * 60 * 1000;
      const isDuplicate = recentlyPrinted.some(p => p.code === scannedValue && p.timestamp > fiveMinutesAgo);

      if (isDuplicate) {
        setDuplicateInfo({ code: scannedValue, show: true });
        void playScanFeedback('failure');
        addLog(scannedValue, '-', '检测到重复扫描，已拦截', 'error', 'system');
        return;
      }
    }
    // 1. Try to find exchange number from mapping
    const cleanedScannedValue = scannedValue.trim().toLowerCase();
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
      void playScanFeedback('failure');
      addLog(scannedValue, finalExchangeNumber ?? '-', '未找到对应的 PDF 文件', 'error', 'print');
      return;
    }

    // At this point, if we still don't have it, set to '-'
    finalExchangeNumber = finalExchangeNumber || '-';
    void playScanFeedback('success');

    // Convert file to Base64 for backend printing
    const reader = new FileReader();
    reader.onload = async () => {
      const base64 = (reader.result as string).split(',')[1];
      
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
        setPrintServerBaseUrl(endpoint);
        setPrintServerMessage(`已连接本机打印服务：${endpoint}`);

        const result = await response.json();
        if (result.success) {
          addLog(scannedValue, finalExchangeNumber, result.message || '打印任务已提交到打印机', 'success', 'print');
          setStats(prev => ({ ...prev, printedCount: prev.printedCount + 1 }));
          // Add to recently printed for deduplication
          const newTimestamp = Date.now();
          setRecentlyPrinted(prev => 
            [...prev, { code: scannedValue, timestamp: newTimestamp }].filter(p => p.timestamp > newTimestamp - 5 * 60 * 1000)
          );
        } else {
          void playScanFeedback('failure');
          addLog(scannedValue, finalExchangeNumber, `打印失败: ${result.message}`, 'error', 'print');
        }
      } catch (error) {
        void playScanFeedback('failure');
        const message = error instanceof Error ? error.message : '打印服务未响应，请检查后端';
        setPrintServerStatus('offline');
        setPrintServerBaseUrl('');
        setPrintServerMessage(message);
        addLog(scannedValue, finalExchangeNumber, message, 'error', 'print');
      }
    };
    reader.onerror = () => {
      void playScanFeedback('failure');
      addLog(scannedValue, finalExchangeNumber, '读取 PDF 文件失败', 'error', 'print');
    };
    reader.readAsDataURL(pdfFile);
  };

  const forcePrint = (codeToPrint: string) => {
    // Bypasses the duplicate check
    setDuplicateInfo(null);
    processScan(codeToPrint, true);
  };

  const addLog = (firstLeg: string, exchange: string, message: string, status: 'success' | 'error', type: 'import' | 'print' | 'system') => {
    const newLog: PrintLog = {
      time: new Date().toLocaleTimeString(),
      firstLeg,
      exchange,
      status,
      message,
      type
    };
    setLogs(prev => [newLog, ...prev].slice(0, 200));
    if (type === 'print' && status === 'success') {
      setLastPrintedCode(firstLeg);
    }
  };

  useEffect(() => {
    // Scroll to top of logs when a new log is added
    if (logContainerRef.current) {
      logContainerRef.current.scrollTop = 0;
    }
  }, [logs]);

  useEffect(() => {
    if (lastPrintedCode) {
      const timer = setTimeout(() => {
        setLastPrintedCode(null);
      }, 3000); // Highlight for 3 seconds
      return () => clearTimeout(timer);
    }
  }, [lastPrintedCode]);

  return (
    <div onClick={handleContainerClick} className="min-h-screen bg-dark-bg p-4 md:p-8 font-sans text-text-primary">
      <div className="max-w-6xl mx-auto space-y-6">
        {/* Duplicate Scan Modal */}
        {duplicateInfo?.show && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-dark-bg/50 backdrop-blur-sm">
            <div className="bg-dark-bg/80 backdrop-blur-xl w-full max-w-md rounded-4xl shadow-2xl border border-white/10 overflow-hidden">
              <div className="p-6 border-b border-white/10">
                <h2 className="text-xl font-bold flex items-center gap-2 text-text-primary">
                  <AlertCircle className="w-6 h-6 text-amber-500" />
                  重复扫描警告
                </h2>
              </div>
              <div className="p-8 space-y-6">
                <p className="text-text-secondary">
                  单号 <span className="font-bold text-text-primary">{duplicateInfo.code}</span> 在最近5分钟内已被打印。
                  <br />
                  您确定要强制重复打印吗？
                </p>
                <div className="grid grid-cols-2 gap-4 pt-4">
                  <button
                    onClick={() => setDuplicateInfo(null)}
                    className="w-full bg-white/10 hover:bg-white/20 text-text-primary font-bold py-3 rounded-xl transition-all active:scale-[0.98]"
                  >
                    取消
                  </button>
                  <button
                    onClick={() => forcePrint(duplicateInfo.code)}
                    className="w-full bg-amber-500 hover:bg-amber-600 text-white font-bold py-3 rounded-xl transition-all shadow-lg shadow-amber-500/20 active:scale-[0.98]"
                  >
                    强制打印
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Header */}
        {/* Header */}
        <header className="flex items-center justify-between bg-white/5 backdrop-blur-xl p-6 rounded-4xl border border-white/10">
          <div className="flex items-center gap-4">
            <h1 className="text-3xl font-bold tracking-tight text-brand-green">CM-HUB</h1>
          </div>
          
          <div className="flex items-center gap-8">
            <div className="flex gap-6 border-r pr-8 border-white/10">
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
            
            <button 
              onClick={() => openSettings('printer')}
              className="flex flex-col items-center gap-1 group transition-colors hover:text-brand-green"
            >
              <div className="p-2 bg-white/5 rounded-lg group-hover:bg-white/10 transition-colors">
                <Settings className="w-6 h-6 text-text-secondary group-hover:text-brand-green" />
              </div>
              <span className="text-xs font-semibold text-text-secondary group-hover:text-brand-green">系统设置</span>
            </button>
          </div>
        </header>

        {/* System Settings Modal */}
        {showSettings && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-dark-bg/50 backdrop-blur-sm">
            <div className="bg-dark-bg/80 backdrop-blur-xl w-full max-w-lg rounded-4xl shadow-2xl border border-white/10 overflow-hidden">
              <div className="p-6 border-b border-white/10 flex items-center justify-between">
                <h2 className="text-xl font-bold flex items-center gap-2 text-text-primary">
                  <Settings className="w-5 h-5 text-brand-green" />
                  系统设置
                </h2>
                <button onClick={() => setShowSettings(false)} className="text-text-secondary hover:text-white">
                  <X className="w-6 h-6" />
                </button>
              </div>
              
              <div className="p-8 space-y-6">
                <div className="flex bg-white/5 p-1 rounded-xl gap-1">
                  {[
                    { id: 'printer', label: '打印机', icon: Printer },
                    { id: 'audio', label: '音效', icon: Volume2 }
                  ].map((tab) => (
                    <button
                      key={tab.id}
                      onClick={() => setSettingsPanel(tab.id as SettingsPanel)}
                      className={cn(
                        "flex-1 flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg text-sm font-semibold transition-all",
                        settingsPanel === tab.id
                          ? "bg-brand-green/20 text-brand-green shadow-sm"
                          : "text-text-secondary hover:text-text-primary hover:bg-white/5"
                      )}
                    >
                      <tab.icon className="w-4 h-4" />
                      {tab.label}
                    </button>
                  ))}
                </div>

                {settingsPanel === 'printer' ? (
                  <>
                    <div className="space-y-3">
                  <label className="text-sm font-semibold text-text-primary flex items-center justify-between">
                    选择打印机
                    <button 
                      onClick={fetchPrinters} 
                      disabled={isPrinterLoading}
                      className="text-brand-green hover:text-brand-green/80 flex items-center gap-1 text-xs"
                    >
                      <RefreshCw className={cn("w-3 h-3", isPrinterLoading && "animate-spin")} />
                      刷新列表
                    </button>
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
                      <div className="absolute z-50 mt-2 w-full overflow-hidden rounded-xl border border-brand-green/60 bg-[#111713]/95 shadow-2xl shadow-black/50 backdrop-blur-xl ring-1 ring-white/10">
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
                  </p>
                </div>

                <div className="pt-4">
                  <button
                    onClick={savePrinter}
                    className="w-full bg-brand-green hover:bg-brand-green/80 text-dark-bg font-bold py-4 rounded-xl flex items-center justify-center gap-2 transition-all shadow-lg shadow-brand-green/20 active:scale-[0.98]"
                  >
                    <Save className="w-5 h-5" />
                    保存打印机设置
                  </button>
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
                        <button
                          type="button"
                          role="switch"
                          aria-checked={audioEnabled}
                          onClick={toggleAudioEnabled}
                          className={cn(
                            "relative h-8 w-14 rounded-full transition-colors",
                            audioEnabled ? "bg-brand-green" : "bg-white/15"
                          )}
                        >
                          <span className={cn(
                            "absolute top-1 h-6 w-6 rounded-full bg-dark-bg shadow-lg transition-transform",
                            audioEnabled ? "translate-x-7" : "translate-x-1"
                          )} />
                        </button>
                      </div>

                      <div className="space-y-3">
                        <div className="flex items-center justify-between">
                          <label htmlFor="audio-volume" className="text-sm font-semibold text-text-primary">
                            音量调节
                          </label>
                          <span className="text-xs font-semibold text-brand-green">
                            {audioVolume === 100 ? '跟随系统媒体音量' : `${audioVolume}%`}
                          </span>
                        </div>
                        <input
                          id="audio-volume"
                          type="range"
                          min="0"
                          max="100"
                          value={audioVolume}
                          onChange={(event) => changeAudioVolume(Number(event.target.value))}
                          className="w-full accent-brand-green cursor-pointer"
                        />
                        <div className="flex justify-between text-[11px] text-text-secondary/50">
                          <span>静音</span>
                          <span>独立调节</span>
                          <span>系统上限</span>
                        </div>
                      </div>

                      <button
                        type="button"
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
                        className="w-full bg-white/5 hover:bg-white/10 border border-white/10 hover:border-brand-green/50 text-text-primary font-bold py-4 rounded-xl flex items-center justify-center gap-2 transition-all active:scale-[0.98]"
                      >
                        <PlayCircle className="w-5 h-5 text-brand-green" />
                        试听音效
                        <span className="text-xs font-medium text-text-secondary/60">点击成功 / 长按失败</span>
                      </button>
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
            </div>
          </div>
        )}

        <div className="grid md:grid-cols-3 gap-6">
          {/* Left: Controls */}
          <div className="md:col-span-1 space-y-6">
            {/* Excel Import */}
            <div className="bg-white/5 backdrop-blur-xl p-6 rounded-4xl border border-white/10 space-y-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2 font-semibold text-text-primary">
                  <FileSpreadsheet className="w-5 h-5 text-brand-green" />
                  <h2>数据导入 (Excel)</h2>
                </div>
                {excelFile && (
                  <button 
                    onClick={() => document.getElementById('excel-input')?.click()}
                    className="text-xs font-semibold text-brand-green hover:underline"
                  >重新上传</button>
                )}
              </div>
              <label className="flex flex-col items-center justify-center w-full h-32 border-2 border-dashed border-white/20 rounded-xl cursor-pointer hover:bg-white/5 transition-colors">
                {!excelFile ? (
                  <div className="flex flex-col items-center justify-center pt-5 pb-6">
                    <Upload className="w-8 h-8 text-text-secondary mb-2" />
                    <p className="text-sm text-text-secondary">点击或拖拽上传 Excel</p>
                  </div>
                ) : (
                  <div className="flex flex-col items-center justify-center text-center p-2">
                    {excelFile.status === 'success' ? 
                      <CheckCircle2 className="w-8 h-8 text-green-500 mb-2" /> : 
                      <AlertCircle className="w-8 h-8 text-red-500 mb-2" />
                    }
                    <p className="text-sm font-semibold text-text-primary break-all">{excelFile.name}</p>
                    <p className={cn(
                      "text-xs mt-1",
                      excelFile.status === 'success' ? 'text-text-secondary' : 'text-red-500'
                    )}>{excelFile.message}</p>
                  </div>
                )}
                <input id="excel-input" type="file" className="hidden" accept=".xlsx, .xls" onChange={handleExcelUpload} />
              </label>
            </div>

            {/* PDF Import */}
            <div className="bg-white/5 backdrop-blur-xl p-6 rounded-4xl border border-white/10 space-y-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2 font-semibold text-text-primary">
                  <FileText className="w-5 h-5 text-brand-green" />
                  <h2>面单库 (PDF 文件夹)</h2>
                </div>
                {pdfFolder && (
                   <button 
                    onClick={() => document.getElementById('pdf-input')?.click()}
                    className="text-xs font-semibold text-brand-green hover:underline"
                  >重新选择</button>
                )}
              </div>
              <label className="flex flex-col items-center justify-center w-full h-32 border-2 border-dashed border-white/20 rounded-xl cursor-pointer hover:bg-white/5 transition-colors">
                {!pdfFolder ? (
                  <div className="flex flex-col items-center justify-center pt-5 pb-6">
                    <Upload className="w-8 h-8 text-text-secondary mb-2" />
                    <p className="text-sm text-text-secondary text-center px-2">选择包含 PDF 的文件夹</p>
                  </div>
                ) : (
                  <div className="flex flex-col items-center justify-center text-center p-2">
                    {pdfFolder.status === 'success' ? 
                      <CheckCircle2 className="w-8 h-8 text-green-500 mb-2" /> : 
                      <AlertCircle className="w-8 h-8 text-red-500 mb-2" />
                    }
                    <p className="text-sm font-semibold text-text-primary break-all">{pdfFolder.name}</p>
                    <p className={cn(
                      "text-xs mt-1",
                      pdfFolder.status === 'success' ? 'text-text-secondary' : 'text-red-500'
                    )}>{pdfFolder.message}</p>
                  </div>
                )}
                {/* @ts-ignore */}
                <input id="pdf-input" type="file" className="hidden" webkitdirectory="" directory="" multiple onChange={handlePdfUpload} />
              </label>
            </div>

            {/* Status Info */}
            <div className="bg-white/5 backdrop-blur-xl p-6 rounded-4xl border border-white/10">
              <h3 className="text-text-primary font-semibold mb-2 flex items-center gap-2">
                <AlertCircle className="w-4 h-4 text-brand-green" />
                使用说明
              </h3>
              <ul className="text-sm text-text-secondary space-y-2 list-disc list-inside">
                <li>文件名需包含 Excel 中的<b className="text-text-primary">转单号</b> (支持模糊匹配)</li>
                <li>外置扫码枪请设置为<b className="text-text-primary">回车结束</b>模式</li>
                <li>建议使用 Chrome 浏览器以获得最佳打印体验</li>
              </ul>
            </div>
          </div>

          {/* Right: Scanner & Logs */}
          <div className="md:col-span-2 space-y-6">
            {/* Scanner Input */}
            <div className="bg-white/5 backdrop-blur-xl p-8 rounded-4xl border-2 border-brand-green/50 space-y-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2 font-semibold text-text-primary">
                  <Scan className="w-6 h-6 text-brand-green" />
                  <h2 className="text-xl">扫码区域</h2>
                </div>
                <div className="flex items-center gap-2 text-xs font-medium text-brand-green bg-brand-green/10 px-3 py-1 rounded-full animate-pulse">
                  <div className="w-2 h-2 bg-brand-green rounded-full"></div>
                  已连接扫码枪
                </div>
              </div>
              
                <input
                  ref={inputRef}
                  type="text"
                  value={scanInput}
                  onChange={(e) => setScanInput(e.target.value)}
                  placeholder="等待扫码..."
                  className="w-full text-3xl font-mono text-center py-6 bg-transparent border-2 border-white/20 rounded-xl focus:border-brand-green focus:ring-4 focus:ring-brand-green/20 outline-none transition-all placeholder:text-text-secondary/50"
                  autoFocus
                />
            </div>

            {/* Logs */}
            <div className="bg-white/5 backdrop-blur-xl rounded-4xl border border-white/10 overflow-hidden">
              <div className="p-4 border-b border-white/10 flex items-center justify-between">
                <div className="flex items-center gap-4">
                  <div className="flex items-center gap-2 font-semibold text-text-primary mr-2">
                    <History className="w-5 h-5 text-text-secondary" />
                    <h2>操作日志</h2>
                  </div>
                  <div className="flex bg-white/5 p-1 rounded-lg gap-1">
                    {[
                      { id: 'print', label: '打印记录', icon: Printer },
                      { id: 'import', label: '导入记录', icon: FileSpreadsheet },
                      { id: 'system', label: '系统状态', icon: Settings },
                    ].map((tab) => (
                      <button
                        key={tab.id}
                        onClick={() => setActiveTab(tab.id as any)}
                        className={cn(
                          "flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-semibold transition-all",
                          activeTab === tab.id 
                            ? "bg-brand-green/20 text-brand-green shadow-sm" 
                            : "text-text-secondary hover:text-text-primary"
                        )}
                      >
                        <tab.icon className="w-3.5 h-3.5" />
                        {tab.label}
                      </button>
                    ))}
                  </div>
                </div>
                <button 
                  onClick={() => setLogs(logs.filter(l => l.type !== activeTab))}
                  className="text-xs text-text-secondary hover:text-red-500 flex items-center gap-1 transition-colors"
                >
                  <X className="w-3 h-3" /> 清空当前页
                </button>
              </div>
              <div ref={logContainerRef} className="max-h-[400px] overflow-y-auto">
                <table className="w-full text-left text-sm">
                  <thead className="sticky top-0 bg-dark-bg/80 backdrop-blur-xl border-b border-white/10 text-text-secondary font-medium">
                    <tr>
                      <th className="px-4 py-3 w-12">序号</th>
                      <th className="px-6 py-3">时间</th>
                      <th className="px-6 py-3">相关单号/对象</th>
                      <th className="px-6 py-3">状态/详情</th>
                      <th className="px-6 py-3 text-right">结果</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-white/5">
                    {(() => {
                      const filteredLogs = logs.filter(l => l.type === activeTab);
                      if (filteredLogs.length === 0) {
                        return (
                          <tr>
                            <td colSpan={5} className="px-6 py-12 text-center text-text-secondary/50 italic">
                              当前分类暂无记录...
                            </td>
                          </tr>
                        );
                      }
                      return filteredLogs.map((log, i) => {
                        const isLastPrinted = i === 0 && log.type === 'print' && log.firstLeg === lastPrintedCode;
                        return (
                          <tr key={i} className={cn(
                            "hover:bg-white/5 transition-colors duration-300",
                            isLastPrinted && "bg-white/[0.075] shadow-[inset_3px_0_0_rgba(128,255,0,0.28)]"
                          )}>
                            <td className="px-4 py-4 text-center text-text-secondary font-medium">{filteredLogs.length - i}</td>
                            <td className="px-6 py-4 text-text-secondary font-mono whitespace-nowrap">{log.time}</td>
                            <td className="px-6 py-4 font-medium">
                              {log.type === 'print' ? (
                                <div className="flex flex-col">
                                  <span className="text-text-primary">{log.firstLeg}</span>
                                  <span className="text-xs text-text-secondary/80 font-normal">快递单号: {log.exchange}</span>
                                </div>
                              ) : log.firstLeg}
                            </td>
                            <td className="px-6 py-4 text-text-secondary">
                              {log.message}
                            </td>
                            <td className="px-6 py-4 text-right">
                              <span className={cn(
                                "inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium",
                                log.status === 'success' ? "bg-green-500/10 text-green-400" : "bg-red-500/10 text-red-400"
                              )}>
                                {log.status === 'success' ? <CheckCircle2 className="w-3.5 h-3.5" /> : <AlertCircle className="w-3.5 h-3.5" />}
                                {log.status === 'success' ? '成功' : '失败'}
                              </span>
                            </td>
                          </tr>
                        );
                      });
                    })()}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
