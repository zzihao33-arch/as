import { createSign } from 'node:crypto';

const getHeader = (value: string | string[] | undefined) => (
  Array.isArray(value) ? value[0] : value
);

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

const isAllowedSameOriginRequest = (req: any) => {
  const origin = getHeader(req.headers.origin);
  if (!origin) return true;

  const requestHost = getHeader(req.headers['x-forwarded-host']) || getHeader(req.headers.host);
  const configuredOrigins = (process.env.QZ_ALLOWED_ORIGINS || '')
    .split(',')
    .map(originValue => originValue.trim())
    .filter(Boolean);

  try {
    const originUrl = new URL(origin);
    if (requestHost && originUrl.host === requestHost) {
      return true;
    }
  } catch {
    return false;
  }

  return configuredOrigins.includes(origin);
};

const getRequestToSign = (req: any) => {
  if (typeof req.body === 'string') {
    try {
      const parsed = JSON.parse(req.body);
      return typeof parsed.request === 'string' ? parsed.request : '';
    } catch {
      return req.body;
    }
  }

  if (req.body && typeof req.body.request === 'string') {
    return req.body.request;
  }

  if (typeof req.query?.request === 'string') {
    return req.query.request;
  }

  return '';
};

export default function handler(req: any, res: any) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    sendText(res, 405, 'Method Not Allowed');
    return;
  }

  if (!isAllowedSameOriginRequest(req)) {
    sendText(res, 403, 'QZ 签名请求来源不在允许范围内。');
    return;
  }

  const requestToSign = getRequestToSign(req);
  if (!requestToSign) {
    sendText(res, 400, '缺少需要签名的 QZ request。');
    return;
  }

  const privateKey = getPemFromEnv('QZ_PRIVATE_KEY', 'QZ_PRIVATE_KEY_BASE64');
  if (!privateKey) {
    sendText(res, 503, 'QZ_PRIVATE_KEY 未配置：无法为 QZ 打印请求签名。');
    return;
  }

  try {
    const signer = createSign('RSA-SHA512');
    signer.update(requestToSign, 'utf8');
    signer.end();
    const signature = signer.sign(privateKey, 'base64');
    sendText(res, 200, `${signature}\n`);
  } catch (error) {
    sendText(
      res,
      500,
      `QZ_PRIVATE_KEY 签名失败：${error instanceof Error ? error.message : String(error)}`
    );
  }
}
