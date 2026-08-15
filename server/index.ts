import express from 'express';
import cors from 'cors';
import bodyParser from 'body-parser';
import ptp from 'pdf-to-printer';
const { print, getPrinters } = ptp as any;
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const port = 3001;

const allowedOrigins = ['http://localhost:5173', 'http://localhost:5174'];

const corsOptions: cors.CorsOptions = {
  origin: (origin, callback) => {
    // Allow requests with no origin (like mobile apps or curl requests)
    if (!origin) return callback(null, true);

    if (allowedOrigins.indexOf(origin) !== -1 || origin.endsWith('.vercel.app')) {
      return callback(null, true);
    } else {
      return callback(new Error('Not allowed by CORS'));
    }
  }
};

app.use(cors(corsOptions));
app.use(bodyParser.json({ limit: '50mb' }));

// 1. 获取系统打印机列表
app.get('/api/printers', async (req, res) => {
  try {
    console.log('Fetching printers...');
    let printerNames: string[] = [];
    
    if (process.platform === 'win32') {
      try {
        console.log('Trying PowerShell fallback first for Windows...');
        const { stdout } = await execAsync('powershell "Get-Printer | Select-Object -ExpandProperty Name"');
        printerNames = stdout.split(/\r?\n/).map(name => name.trim()).filter(name => name !== '');
        console.log('PowerShell found:', printerNames);
      } catch (psError) {
        console.error('PowerShell failed:', psError);
      }
    }

    // 如果 PowerShell 没拿到，或者不是 Windows，尝试 pdf-to-printer
    if (printerNames.length === 0) {
      try {
        const printers = await getPrinters();
        printerNames = printers.map((p: any) => p.name);
      } catch (ptpError) {
        console.error('pdf-to-printer failed:', ptpError);
        // 如果都失败了且是 Windows，确保返回一个错误，但如果是内部匹配错误，我们已经有尝试了
        if (printerNames.length === 0) throw ptpError;
      }
    }
    
    res.json({ success: true, printers: printerNames });
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

    // 尝试打印
    try {
      await print(tempFilePath, { printer: printerName });
    } catch (e) {
      console.warn('pdf-to-printer print failed, trying PowerShell fallback...', e);
      if (process.platform === 'win32') {
        // 使用 PowerShell 强制打印
        const printerArg = printerName ? `"${printerName}"` : '(Get-Printer | Where-Object {$_.IsDefault} | Select-Object -ExpandProperty Name)';
        await execAsync(`powershell "Start-Process -FilePath '${tempFilePath}' -Verb PrintTo -ArgumentList ${printerArg} -WindowStyle Hidden"`);
      } else {
        throw e;
      }
    }

    res.json({ success: true, message: '已发送至打印机' });
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

app.listen(port, '0.0.0.0', () => {
  console.log(`Print server running at http://localhost:${port}`);
});

// Keep process alive
process.stdin.resume();
