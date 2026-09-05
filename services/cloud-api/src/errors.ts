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
    return new ApiError(400, 'INVALID_JSON', '请求体必须是有效的 JSON');
  }
  if (isBodyParserError(error, 'entity.too.large', 413)) {
    return new ApiError(413, 'PAYLOAD_TOO_LARGE', '请求体超过允许的大小');
  }
  if (error instanceof Error && 'code' in error) {
    const code = String((error as Error & { code?: unknown }).code ?? '');
    if (code === 'ER_DUP_ENTRY') return new ApiError(409, 'RESOURCE_CONFLICT', '账号、手机号、邮箱或名称已被使用');
    if (code === 'ER_NO_REFERENCED_ROW_2' || code === 'ER_ROW_IS_REFERENCED_2') {
      return new ApiError(409, 'RESOURCE_IN_USE', '关联数据不存在或仍在使用中');
    }
  }
  return new ApiError(500, 'INTERNAL_ERROR', '服务暂时不可用，请稍后重试');
}
