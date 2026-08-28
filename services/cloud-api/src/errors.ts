export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function isBodyParserError(error: unknown, type: string, status: number): boolean {
  if (!(error instanceof Error)) return false;
  const candidate = error as Error & { status?: unknown; type?: unknown };
  return candidate.status === status && candidate.type === type;
}

export function normalizeApiError(error: unknown): ApiError {
  if (error instanceof ApiError) return error;
  if (isBodyParserError(error, 'entity.parse.failed', 400)) {
    return new ApiError(400, 'INVALID_JSON', '请求体必须是有效的 JSON。');
  }
  if (isBodyParserError(error, 'entity.too.large', 413)) {
    return new ApiError(413, 'PAYLOAD_TOO_LARGE', '请求体超过允许的大小。');
  }
  return new ApiError(500, 'INTERNAL_ERROR', '服务暂时不可用，请稍后重试。');
}
