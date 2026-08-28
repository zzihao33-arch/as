import { createHash } from 'node:crypto';
import { ApiError } from './errors.js';

const pdfHeader = Buffer.from('%PDF-', 'ascii');
const pdfEof = Buffer.from('%%EOF', 'ascii');

export type ValidatedLabelPdf = {
  content: Buffer;
  sha256: string;
  byteSize: number;
};

export function validateLabelPdf(content: unknown, declaredSha256: string | undefined): ValidatedLabelPdf {
  if (!Buffer.isBuffer(content) || content.length === 0) {
    throw new ApiError(400, 'LABEL_PDF_REQUIRED', '请求体必须包含 PDF 文件内容。');
  }
  const declared = declaredSha256?.trim().toLowerCase();
  if (!declared || !/^[0-9a-f]{64}$/.test(declared)) {
    throw new ApiError(400, 'LABEL_SHA256_REQUIRED', 'X-Label-SHA256 必须是 64 位十六进制 SHA-256。');
  }

  const headerWindow = content.subarray(0, Math.min(content.length, 1024));
  const eofWindow = content.subarray(Math.max(0, content.length - 2048));
  if (headerWindow.indexOf(pdfHeader) === -1 || eofWindow.lastIndexOf(pdfEof) === -1) {
    throw new ApiError(422, 'INVALID_LABEL_PDF', '上传内容不是结构完整的 PDF 面单。');
  }

  const sha256 = createHash('sha256').update(content).digest('hex');
  if (sha256 !== declared) {
    throw new ApiError(422, 'LABEL_HASH_MISMATCH', 'PDF 内容与 X-Label-SHA256 不一致。');
  }
  return { content, sha256, byteSize: content.length };
}
