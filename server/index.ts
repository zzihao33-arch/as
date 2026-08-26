import express from 'express';
import cors from 'cors';
import bodyParser from 'body-parser';
import ptp from 'pdf-to-printer';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { exec } from 'child_process';
import { promisify } from 'util';

type PrinterRecord = {
  name: string;
  isDefault: boolean;
  isVirtual: boolean;
};

const execAsync = promisify(exec);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const { print, getPrinters, getDefaultPrinter } = ptp as any;

const app = express();
const port = 3001;

const isAllowedOrigin = (origin: string) => (
  /^https?:\/\/(localhost|127\.0\.0\.1)(?::\d+)?$/i.test(origin)
  || origin.endsWith('.vercel.app')
  || origin === 'https://cmhubtool.com'
  || origin === 'https://www.cmhubtool.com'
);

const virtualPrinterKeywords = [
  'pdf24',
  'microsoft print to pdf',
  'onenote',
  'fax',
  'xps',
  'wps pdf',
  'adobe pdf'
];

const normalizePrinterName = (name: unknown) => String(name || '').trim();

const isVirtualPrinterName = (name: string) => {
  const normalizedName = name.toLowerCase();
  return virtualPrinterKeywords.some(keyword => normalizedName.includes(keyword));
};

const dedupePrinters = (printers: PrinterRecord[]) => {
  const seen = new Set<string>();
  return printers.filter(printer => {
    const key = printer.name.toLowerCase();
    if (!printer.name || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

const readPrintersWithPowerShell = async (): Promise<PrinterRecord[]> => {
  const { stdout } = await execAsync(
    'powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-Printer | Select-Object -Property Name,IsDefault | ConvertTo-Json -Compress"'
  );
  const raw = stdout.trim();
  if (!raw) return [];

  const parsed = JSON.parse(raw);
  const rows = Array.isArray(parsed) ? parsed : [parsed];

  return dedupePrinters(rows.map(row => {
    const name = normalizePrinterName(row.Name);
    return {
      name,
      isDefault: Boolean(row.IsDefault),
      isVirtual: isVirtualPrinterName(name)
    };
  }));
};

const readPrintersWithPackage = async (): Promise<PrinterRecord[]> => {
  const [printers, defaultPrinter] = await Promise.all([
    getPrinters(),
    getDefaultPrinter().catch(() => null)
  ]);
  const defaultPrinterName = normalizePrinterName(defaultPrinter?.name);

  return dedupePrinters(printers.map((printer: any) => {
    const name = normalizePrinterName(printer.name);
    return {
      name,
      isDefault: name.toLowerCase() === defaultPrinterName.toLowerCase(),
      isVirtual: isVirtualPrinterName(name)
    };
  }));
};

const readDefaultPrinterFromUserRegistry = async () => {
  try {
    const { stdout } = await execAsync(
      'reg query "HKCU\\Software\\Microsoft\\Windows NT\\CurrentVersion\\Windows" /v Device'
    );
    const deviceLine = stdout
      .split(/\r?\n/)
      .find(line => /\sDevice\s+REG_\w+\s+/i.test(line));

    if (!deviceLine) return '';

    const [, deviceValue = ''] = deviceLine.split(/\sREG_\w+\s+/i);
    return normalizePrinterName(deviceValue.split(',')[0]);
  } catch (error) {
    return '';
  }
};

const readPrintersFromUserRegistry = async (): Promise<PrinterRecord[]> => {
  const { stdout } = await execAsync(
    'reg query "HKCU\\Software\\Microsoft\\Windows NT\\CurrentVersion\\Devices"'
  );
  const defaultPrinterName = await readDefaultPrinterFromUserRegistry();
  const printers = stdout
    .split(/\r?\n/)
    .map(line => {
      const match = line.match(/^\s+(.+?)\s+REG_\w+\s+/i);
      const name = normalizePrinterName(match?.[1]);

      if (!name) return null;

      return {
        name,
        isDefault: Boolean(defaultPrinterName && name.toLowerCase() === defaultPrinterName.toLowerCase()),
        isVirtual: isVirtualPrinterName(name)
      };
    })
    .filter((printer): printer is PrinterRecord => Boolean(printer));

  return dedupePrinters(printers);
};

const getPrinterInventory = async () => {
  let allPrinters: PrinterRecord[] = [];
  const discoveryErrors: string[] = [];

  if (process.platform === 'win32') {
    try {
      allPrinters = await readPrintersFromUserRegistry();
    } catch (registryError) {
      discoveryErrors.push(`Registry: ${registryError instanceof Error ? registryError.message : String(registryError)}`);
      console.error('Registry printer inventory failed:', registryError);
    }
  }

  if (process.platform === 'win32' && allPrinters.length === 0) {
    try {
      allPrinters = await readPrintersWithPowerShell();
    } catch (psError) {
      discoveryErrors.push(`PowerShell: ${psError instanceof Error ? psError.message : String(psError)}`);
      console.error('PowerShell printer inventory failed:', psError);
    }
  }

  if (allPrinters.length === 0) {
    try {
      allPrinters = await readPrintersWithPackage();
    } catch (packageError) {
      discoveryErrors.push(`pdf-to-printer: ${packageError instanceof Error ? packageError.message : String(packageError)}`);
      console.error('pdf-to-printer inventory failed:', packageError);
    }
  }

  if (allPrinters.length === 0 && discoveryErrors.length > 0) {
    throw new Error(discoveryErrors.join(' | '));
  }

  const directPrinters = allPrinters.filter(printer => !printer.isVirtual);
  const excludedPrinters = allPrinters.filter(printer => printer.isVirtual).map(printer => printer.name);
  const defaultDirectPrinter = directPrinters.find(printer => printer.isDefault)?.name || '';
  const preferredPrinter = defaultDirectPrinter || (directPrinters.length === 1 ? directPrinters[0].name : '');

  return {
    allPrinters,
    directPrinters,
    excludedPrinters,
    preferredPrinter
  };
};

const resolveTargetPrinter = (requestedPrinter: unknown, inventory: Awaited<ReturnType<typeof getPrinterInventory>>) => {
  const requestedName = normalizePrinterName(requestedPrinter);

  if (requestedName) {
    const matchingPrinter = inventory.allPrinters.find(
      printer => printer.name.toLowerCase() === requestedName.toLowerCase()
    );

    if (!matchingPrinter) {
      throw new Error(`未找到打印机「${requestedName}」，请刷新打印机列表后重新选择。`);
    }

    if (matchingPrinter.isVirtual) {
      throw new Error(`「${matchingPrinter.name}」是虚拟打印机，不能用于面单直打。请改选真实打印机。`);
    }

    return matchingPrinter.name;
  }

  if (inventory.preferredPrinter) {
    return inventory.preferredPrinter;
  }

  if (inventory.directPrinters.length === 0) {
    throw new Error('未检测到可直接打印的真实打印机，请先安装或连接标签打印机。');
  }

  throw new Error('检测到多台真实打印机，请先在打印机设置中选择一台。');
};

const corsOptions: cors.CorsOptions = {
  origin: (origin, callback) => {
    // Allow requests with no origin (like mobile apps or curl requests)
    if (!origin) return callback(null, true);

    if (isAllowedOrigin(origin)) {
      return callback(null, true);
    } else {
      return callback(new Error('Not allowed by CORS'));
    }
  }
};

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Private-Network', 'true');
  next();
});
app.use(cors(corsOptions));
app.use(bodyParser.json({ limit: '50mb' }));

// 1. 获取系统打印机列表
app.get('/api/printers', async (req, res) => {
  try {
    console.log('Fetching printers...');
    const inventory = await getPrinterInventory();
    const printerNames = inventory.directPrinters.map(printer => printer.name);

    console.log('Direct printers:', printerNames);
    if (inventory.excludedPrinters.length > 0) {
      console.log('Hidden virtual printers:', inventory.excludedPrinters);
    }

    res.json({
      success: true,
      printers: printerNames,
      defaultPrinter: inventory.preferredPrinter,
      excludedPrinters: inventory.excludedPrinters
    });
  } catch (error) {
    console.error('Final printer fetch error:', error);
    res.status(500).json({ 
      success: false, 
      message: `无法获取系统打印机列表: ${error instanceof Error ? error.message : String(error)}` 
    });
  }
});

// 2. 接收请求并调用打印功能
app.post('/api/print', async (req, res) => {
  const { pdfBase64, printerName, fileName } = req.body;

  if (!pdfBase64) {
    return res.status(400).json({ success: false, message: '缺少 PDF 数据' });
  }

  const tempDir = path.join(__dirname, 'temp');
  if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir);
  }

  const tempFilePath = path.join(tempDir, `${Date.now()}_${fileName || 'print.pdf'}`);
  
  try {
    const buffer = Buffer.from(pdfBase64, 'base64');
    fs.writeFileSync(tempFilePath, buffer);

    const inventory = await getPrinterInventory();
    const targetPrinter = resolveTargetPrinter(printerName, inventory);

    await print(tempFilePath, {
      printer: targetPrinter,
      silent: true,
      scale: 'noscale'
    });

    res.json({
      success: true,
      message: `打印任务已提交到 ${targetPrinter}`,
      printerName: targetPrinter
    });
  } catch (error) {
    console.error('Print error:', error);
    res.status(500).json({ success: false, message: `打印失败: ${error instanceof Error ? error.message : String(error)}` });
  } finally {
    if (fs.existsSync(tempFilePath)) {
      setTimeout(() => {
        try { fs.unlinkSync(tempFilePath); } catch (e) {}
      }, 10000); 
    }
  }
});

app.listen(port, '127.0.0.1', () => {
  console.log(`Print server running at http://localhost:${port}`);
});

// Keep the process alive indefinitely, more robust than stdin.resume()
new Promise(() => {});
