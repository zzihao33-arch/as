import { useState, useEffect, useRef } from 'react';
import * as XLSX from 'xlsx';
import printJS from 'print-js';
import { Upload, FileSpreadsheet, FileText, Scan, Printer, CheckCircle2, AlertCircle, History, X, Settings, RefreshCw, Save } from 'lucide-react';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
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

export default function App() {
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [pdfFiles, setPdfFiles] = useState<Record<string, File>>({});
  const [scanInput, setScanInput] = useState('');
  const [logs, setLogs] = useState<PrintLog[]>([]);
  const [activeTab, setActiveTab] = useState<'import' | 'print' | 'system'>('print');
  const [stats, setStats] = useState({ excelCount: 0, pdfCount: 0, printedCount: 0 });
  const [showSettings, setShowSettings] = useState(false);
  const [printers, setPrinters] = useState<string[]>([]);
  const [selectedPrinter, setSelectedPrinter] = useState<string>(localStorage.getItem('selectedPrinter') || '');
  const [isPrinterLoading, setIsPrinterLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // Load printers
  useEffect(() => {
    if (showSettings) {
      fetchPrinters();
    }
  }, [showSettings]);

  const fetchPrinters = async () => {
    setIsPrinterLoading(true);
    try {
      const res = await fetch('http://localhost:3001/api/printers');
      const data = await res.json();
      if (data.success) {
        setPrinters(data.printers);
      } else {
        addLog('System', '-', `获取打印机列表失败: ${data.message || '未知错误'}`, 'error', 'system');
      }
    } catch (error) {
      addLog('System', '-', '无法连接到打印服务 (http://localhost:3001)', 'error', 'system');
    } finally {
      setIsPrinterLoading(false);
    }
  };

  const savePrinter = () => {
    localStorage.setItem('selectedPrinter', selectedPrinter);
    setShowSettings(false);
    addLog('System', '-', `已绑定打印机: ${selectedPrinter || '系统默认'}`, 'success', 'system');
  };

  // Keep focus on scan input
  useEffect(() => {
    const timer = setInterval(() => {
      // Don't steal focus if settings modal is open or user is typing in another input/select
      if (!showSettings && 
          document.activeElement?.tagName !== 'INPUT' && 
          document.activeElement?.tagName !== 'SELECT' &&
          document.activeElement?.tagName !== 'TEXTAREA') {
        inputRef.current?.focus();
      }
    }, 1000);
    return () => clearInterval(timer);
  }, [showSettings]);

  const handleExcelUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (event) => {
      const data = new Uint8Array(event.target?.result as ArrayBuffer);
      const workbook = XLSX.read(data, { type: 'array' });
      const firstSheetName = workbook.SheetNames[0];
      const worksheet = workbook.Sheets[firstSheetName];
      const jsonData = XLSX.utils.sheet_to_json(worksheet) as any[];

      const newMapping: Record<string, string> = {};
      jsonData.forEach((row) => {
        // Assume column A is '转单号' (First Leg) and B is '内单号' (Exchange) based on user image
        const firstLeg = String(row['转单号'] || Object.values(row)[0] || '').trim();
        const exchange = String(row['内单号'] || Object.values(row)[1] || '').trim();
        if (firstLeg && exchange) {
          newMapping[firstLeg] = exchange;
        }
      });

      setMapping(newMapping);
      setStats(prev => ({ ...prev, excelCount: Object.keys(newMapping).length }));
      addLog('System', '-', 'Excel 导入成功', 'success', 'import');
    };
    reader.readAsArrayBuffer(file);
  };

  const handlePdfUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files) return;

    const newPdfFiles: Record<string, File> = {};
    Array.from(files).forEach(file => {
      // Check for .pdf extension as a fallback to MIME type
      if (file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf')) {
        // Use filename without extension as the key
        const name = file.name.replace(/\.[^/.]+$/, "");
        newPdfFiles[name] = file;
      }
    });

    setPdfFiles(prev => {
      const updated = { ...prev, ...newPdfFiles };
      setStats(s => ({ ...s, pdfCount: Object.keys(updated).length }));
      return updated;
    });
    addLog('System', '-', `导入了 ${Object.keys(newPdfFiles).length} 个 PDF 文件`, 'success', 'import');
  };

  const handleScan = (e: React.FormEvent) => {
    e.preventDefault();
    const scannedValue = scanInput.trim();
    if (!scannedValue) return;

    processScan(scannedValue);
    setScanInput('');
  };

  const processScan = (scannedValue: string) => {
    // 1. Try to find exchange number from mapping (case-insensitive, support fuzzy match if needed, but usually Excel is exact)
    const mappingKey = Object.keys(mapping).find(k => k.toLowerCase() === scannedValue.toLowerCase());
    const exchangeNumber = mappingKey ? mapping[mappingKey] : null;
    
    // According to user: "文件名为头程单号" (Filename is First Leg Number)
    // Support fuzzy match: scannedValue is part of the filename
    // Priority: 1. Exact match 2. Scanned value is start of filename 3. Scanned value is anywhere in filename
    const allPdfKeys = Object.keys(pdfFiles);
    const exactMatch = allPdfKeys.find(k => k.toLowerCase() === scannedValue.toLowerCase());
    const startMatch = allPdfKeys.find(k => k.toLowerCase().startsWith(scannedValue.toLowerCase()));
    const fuzzyMatch = allPdfKeys.find(k => k.toLowerCase().includes(scannedValue.toLowerCase()));

    const pdfKey = exactMatch || startMatch || fuzzyMatch;
    const pdfFile = pdfKey ? pdfFiles[pdfKey] : null;

    if (!pdfFile) {
      addLog(scannedValue, exchangeNumber || '未知', '未找到对应的 PDF 文件', 'error', 'print');
      return;
    }

    // Convert file to Base64 for backend printing
    const reader = new FileReader();
    reader.onload = async () => {
      const base64 = (reader.result as string).split(',')[1];
      
      try {
        const response = await fetch('http://localhost:3001/api/print', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            pdfBase64: base64,
            printerName: selectedPrinter,
            fileName: pdfFile.name
          })
        });

        const result = await response.json();
        if (result.success) {
          addLog(scannedValue, exchangeNumber || '-', '已发送至打印机', 'success', 'print');
          setStats(prev => ({ ...prev, printedCount: prev.printedCount + 1 }));
        } else {
          addLog(scannedValue, exchangeNumber || '-', `打印失败: ${result.message}`, 'error', 'print');
        }
      } catch (error) {
        addLog(scannedValue, exchangeNumber || '-', '打印服务未响应，请检查后端', 'error', 'print');
      }
    };
    reader.readAsDataURL(pdfFile);
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
  };

  return (
    <div className="min-h-screen bg-slate-50 p-4 md:p-8 font-sans text-slate-900">
      <div className="max-w-6xl mx-auto space-y-6">
        {/* Header */}
        <header className="flex items-center justify-between bg-white p-6 rounded-2xl shadow-sm border border-slate-200">
          <div className="flex items-center gap-4">
            <div className="bg-blue-600 p-3 rounded-xl">
              <Printer className="text-white w-8 h-8" />
            </div>
            <div>
              <h1 className="text-2xl font-bold tracking-tight">CM手动换单打印系统</h1>
              <p className="text-slate-500 text-sm">导入数据 {'->'} 扫码 {'->'} 自动匹配并打印</p>
            </div>
          </div>
          
          <div className="flex items-center gap-8">
            <div className="flex gap-6 border-r pr-8 border-slate-100">
              <div className="text-center">
                <div className="text-2xl font-bold text-blue-600">{stats.excelCount}</div>
                <div className="text-xs text-slate-500 uppercase font-semibold">Excel 条目</div>
              </div>
              <div className="text-center border-x px-6 border-slate-100">
                <div className="text-2xl font-bold text-indigo-600">{stats.pdfCount}</div>
                <div className="text-xs text-slate-500 uppercase font-semibold">PDF 文件</div>
              </div>
              <div className="text-center">
                <div className="text-2xl font-bold text-green-600">{stats.printedCount}</div>
                <div className="text-xs text-slate-500 uppercase font-semibold">已打印</div>
              </div>
            </div>
            
            <button 
              onClick={() => setShowSettings(true)}
              className="flex flex-col items-center gap-1 group transition-colors hover:text-blue-600"
            >
              <div className="p-2 bg-slate-50 rounded-lg group-hover:bg-blue-50 transition-colors">
                <Settings className="w-6 h-6 text-slate-500 group-hover:text-blue-600" />
              </div>
              <span className="text-xs font-semibold text-slate-500 group-hover:text-blue-600">打单设置</span>
            </button>
          </div>
        </header>

        {/* Printer Settings Modal */}
        {showSettings && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 backdrop-blur-sm">
            <div className="bg-white w-full max-w-md rounded-2xl shadow-2xl border border-slate-200 overflow-hidden">
              <div className="p-6 border-b border-slate-100 flex items-center justify-between">
                <h2 className="text-xl font-bold flex items-center gap-2">
                  <Settings className="w-5 h-5 text-blue-600" />
                  打单设置
                </h2>
                <button onClick={() => setShowSettings(false)} className="text-slate-400 hover:text-slate-600">
                  <X className="w-6 h-6" />
                </button>
              </div>
              
              <div className="p-8 space-y-6">
                <div className="space-y-3">
                  <label className="text-sm font-semibold text-slate-700 flex items-center justify-between">
                    选择打印机
                    <button 
                      onClick={fetchPrinters} 
                      disabled={isPrinterLoading}
                      className="text-blue-600 hover:text-blue-700 flex items-center gap-1 text-xs"
                    >
                      <RefreshCw className={cn("w-3 h-3", isPrinterLoading && "animate-spin")} />
                      刷新列表
                    </button>
                  </label>
                  <select
                    value={selectedPrinter}
                    onChange={(e) => setSelectedPrinter(e.target.value)}
                    className="w-full p-3 bg-slate-50 border-2 border-slate-100 rounded-xl outline-none focus:border-blue-500 transition-all appearance-none cursor-pointer"
                  >
                    <option value="">系统默认打印机</option>
                    {printers.map(printer => (
                      <option key={printer} value={printer}>{printer}</option>
                    ))}
                  </select>
                  <p className="text-xs text-slate-400">当前绑定：{selectedPrinter || '未选择 (使用默认)'}</p>
                </div>

                <div className="pt-4">
                  <button
                    onClick={savePrinter}
                    className="w-full bg-blue-600 hover:bg-blue-700 text-white font-bold py-4 rounded-xl flex items-center justify-center gap-2 transition-all shadow-lg shadow-blue-200 active:scale-[0.98]"
                  >
                    <Save className="w-5 h-5" />
                    保存打印设置
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}

        <div className="grid md:grid-cols-3 gap-6">
          {/* Left: Controls */}
          <div className="md:col-span-1 space-y-6">
            {/* Excel Import */}
            <div className="bg-white p-6 rounded-2xl shadow-sm border border-slate-200 space-y-4">
              <div className="flex items-center gap-2 font-semibold text-slate-700">
                <FileSpreadsheet className="w-5 h-5 text-green-600" />
                <h2>数据导入 (Excel)</h2>
              </div>
              <label className="flex flex-col items-center justify-center w-full h-32 border-2 border-dashed border-slate-300 rounded-xl cursor-pointer hover:bg-slate-50 transition-colors">
                <div className="flex flex-col items-center justify-center pt-5 pb-6">
                  <Upload className="w-8 h-8 text-slate-400 mb-2" />
                  <p className="text-sm text-slate-500">点击或拖拽上传 Excel</p>
                </div>
                <input type="file" className="hidden" accept=".xlsx, .xls" onChange={handleExcelUpload} />
              </label>
            </div>

            {/* PDF Import */}
            <div className="bg-white p-6 rounded-2xl shadow-sm border border-slate-200 space-y-4">
              <div className="flex items-center gap-2 font-semibold text-slate-700">
                <FileText className="w-5 h-5 text-red-500" />
                <h2>面单库 (PDF 文件夹)</h2>
              </div>
              <label className="flex flex-col items-center justify-center w-full h-32 border-2 border-dashed border-slate-300 rounded-xl cursor-pointer hover:bg-slate-50 transition-colors">
                <div className="flex flex-col items-center justify-center pt-5 pb-6">
                  <Upload className="w-8 h-8 text-slate-400 mb-2" />
                  <p className="text-sm text-slate-500 text-center px-2">选择包含 PDF 的文件夹</p>
                </div>
                {/* @ts-ignore */}
                <input type="file" className="hidden" webkitdirectory="" directory="" multiple onChange={handlePdfUpload} />
              </label>
            </div>

            {/* Status Info */}
            <div className="bg-blue-50 p-6 rounded-2xl border border-blue-100">
              <h3 className="text-blue-800 font-semibold mb-2 flex items-center gap-2">
                <AlertCircle className="w-4 h-4" />
                使用说明
              </h3>
              <ul className="text-sm text-blue-700 space-y-2 list-disc list-inside">
                <li>文件名需包含 Excel 中的<b>转单号</b> (支持模糊匹配)</li>
                <li>外置扫码枪请设置为<b>回车结束</b>模式</li>
                <li>建议使用 Chrome 浏览器以获得最佳打印体验</li>
              </ul>
            </div>
          </div>

          {/* Right: Scanner & Logs */}
          <div className="md:col-span-2 space-y-6">
            {/* Scanner Input */}
            <div className="bg-white p-8 rounded-2xl shadow-sm border-2 border-blue-500 space-y-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2 font-semibold text-slate-700">
                  <Scan className="w-6 h-6 text-blue-600" />
                  <h2 className="text-xl">扫码区域</h2>
                </div>
                <div className="flex items-center gap-2 text-xs font-medium text-blue-600 bg-blue-50 px-3 py-1 rounded-full animate-pulse">
                  <div className="w-2 h-2 bg-blue-600 rounded-full"></div>
                  已连接扫码枪
                </div>
              </div>
              
              <form onSubmit={handleScan}>
                <input
                  ref={inputRef}
                  type="text"
                  value={scanInput}
                  onChange={(e) => setScanInput(e.target.value)}
                  placeholder="等待扫码..."
                  className="w-full text-3xl font-mono text-center py-6 border-2 border-slate-200 rounded-xl focus:border-blue-500 focus:ring-4 focus:ring-blue-100 outline-none transition-all placeholder:text-slate-300"
                  autoFocus
                />
              </form>
            </div>

            {/* Logs */}
            <div className="bg-white rounded-2xl shadow-sm border border-slate-200 overflow-hidden">
              <div className="p-4 border-b border-slate-100 flex items-center justify-between bg-slate-50/50">
                <div className="flex items-center gap-4">
                  <div className="flex items-center gap-2 font-semibold text-slate-700 mr-2">
                    <History className="w-5 h-5 text-slate-500" />
                    <h2>操作日志</h2>
                  </div>
                  <div className="flex bg-slate-200/50 p-1 rounded-lg gap-1">
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
                            ? "bg-white text-blue-600 shadow-sm" 
                            : "text-slate-500 hover:text-slate-700"
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
                  className="text-xs text-slate-400 hover:text-red-500 flex items-center gap-1 transition-colors"
                >
                  <X className="w-3 h-3" /> 清空当前页
                </button>
              </div>
              <div className="max-h-[400px] overflow-y-auto">
                <table className="w-full text-left text-sm">
                  <thead className="sticky top-0 bg-white border-b border-slate-100 text-slate-500 font-medium">
                    <tr>
                      <th className="px-6 py-3">时间</th>
                      <th className="px-6 py-3">相关单号/对象</th>
                      <th className="px-6 py-3">状态/详情</th>
                      <th className="px-6 py-3 text-right">结果</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-50">
                    {logs.filter(l => l.type === activeTab).length === 0 ? (
                      <tr>
                        <td colSpan={4} className="px-6 py-12 text-center text-slate-400 italic">
                          当前分类暂无记录...
                        </td>
                      </tr>
                    ) : (
                      logs.filter(l => l.type === activeTab).map((log, i) => (
                        <tr key={i} className="hover:bg-slate-50 transition-colors">
                          <td className="px-6 py-4 text-slate-500 font-mono whitespace-nowrap">{log.time}</td>
                          <td className="px-6 py-4 font-medium">
                            {log.type === 'print' ? (
                              <div className="flex flex-col">
                                <span className="text-slate-900">{log.firstLeg}</span>
                                <span className="text-xs text-slate-400 font-normal">内单: {log.exchange}</span>
                              </div>
                            ) : log.firstLeg}
                          </td>
                          <td className="px-6 py-4 text-slate-600">
                            {log.message}
                          </td>
                          <td className="px-6 py-4 text-right">
                            <span className={cn(
                              "inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium",
                              log.status === 'success' ? "bg-green-50 text-green-700" : "bg-red-50 text-red-700"
                            )}>
                              {log.status === 'success' ? <CheckCircle2 className="w-3.5 h-3.5" /> : <AlertCircle className="w-3.5 h-3.5" />}
                              {log.status === 'success' ? '成功' : '失败'}
                            </span>
                          </td>
                        </tr>
                      ))
                    )}
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
