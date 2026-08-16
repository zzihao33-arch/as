const getPemFromEnv = (plainName: string, base64Name: string) => {
  const base64Value = process.env[base64Name]?.trim();
  if (base64Value) {
    return Buffer.from(base64Value, 'base64').toString('utf8').trim();
  }

  return (process.env[plainName] || '').replace(/\\n/g, '\n').trim();
};

const sendText = (res: any, statusCode: number, body: string) => {
  res.status(statusCode);
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.send(body);
};

export default function handler(req: any, res: any) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    sendText(res, 405, 'Method Not Allowed');
    return;
  }

  const certificate = getPemFromEnv('QZ_CERTIFICATE', 'QZ_CERTIFICATE_BASE64');

  if (!certificate) {
    sendText(res, 503, 'QZ_CERTIFICATE 未配置：系统会继续使用未签名模式，QZ 仍可能每次打印弹窗。');
    return;
  }

  if (!certificate.includes('BEGIN CERTIFICATE')) {
    sendText(res, 500, 'QZ_CERTIFICATE 格式异常：请粘贴 QZ 官方 digital-certificate.txt 的完整 PEM 内容。');
    return;
  }

  sendText(res, 200, `${certificate}\n`);
}
