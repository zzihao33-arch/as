export type UploadResult = {
  uploadId: string; orderId: string; status: 'WAITING_BYTES' | 'PROCESSING' | 'COMPLETED' | 'FAILED_NOT_SAVED';
  attempt: number; retryable: boolean; recordRef: { id: string } | null;
  assetStatus?: 'READY' | 'REMOVED' | 'SUPERSEDED'; errorCode?: string | null;
  documentsRevision?: number; deduplicated?: boolean;
};
export type UploadPhase = 'selected' | 'uploading' | 'waiting' | 'unknown' | 'restricted' | 'saved' | 'inactive' | 'not_saved';
export type UploadState = { uploadId: string; orderId: string; filename: string; phase: UploadPhase;
  busy: boolean; result: UploadResult | null; message: string; hasFile: boolean; registration?: Record<string, unknown> };
type InitialUpload = Pick<UploadState, 'uploadId' | 'orderId' | 'filename'> & { phase?: UploadPhase; registration?: Record<string, unknown> };
type Dependencies = { current(): boolean; changed(state: UploadState): void;
  register(file: Blob): Promise<UploadResult>; put(file: Blob, attempt: number, retryOfAttempt?: number): Promise<UploadResult>;
  reregister?(file: Blob): Promise<UploadResult>;
  replay?(file: Blob, registration: Record<string, unknown> | undefined, password?: string): Promise<UploadResult>;
  query(): Promise<UploadResult> };

export function createDocumentUpload(initial: InitialUpload, dependencies: Dependencies) {
  let file: Blob | null = null;
  let state: UploadState = { ...initial, phase: initial.phase ?? 'selected', busy: false, result: null, message: '', hasFile: false };
  const publish = (patch: Partial<UploadState>) => {
    if (!dependencies.current()) return;
    state = { ...state, ...patch }; dependencies.changed(state);
  };
  function accept(result: UploadResult) {
    if (!result || result.uploadId !== state.uploadId || result.orderId !== state.orderId
      || !Number.isSafeInteger(result.attempt) || result.attempt < 0 || typeof result.retryable !== 'boolean'
      || !['WAITING_BYTES', 'PROCESSING', 'COMPLETED', 'FAILED_NOT_SAVED'].includes(result.status)
      || (result.status !== 'WAITING_BYTES' && result.attempt < 1)
      || (result.status === 'COMPLETED' && !result.recordRef?.id)) throw new Error('上传结果格式无效');
    const phase: UploadPhase = result.status === 'COMPLETED' ? result.assetStatus && result.assetStatus !== 'READY' ? 'inactive' : 'saved'
      : result.status === 'FAILED_NOT_SAVED' ? 'not_saved' : result.status === 'WAITING_BYTES' ? 'waiting' : 'unknown';
    publish({ result, phase, busy: false, message: phase === 'saved' ? '原件已保存'
      : phase === 'inactive' ? '原件曾保存，现已移除或被替换'
        : phase === 'not_saved' ? `服务器已确认本次未保存。${uploadErrorMessage(result.errorCode)}`
          : phase === 'waiting' ? '尚未传送文件内容' : '正在核对上传结果' });
  }
  function fail(error: unknown) {
    const candidate = error as { status?: number; code?: string; details?: { upload?: UploadResult } };
    if (candidate?.code === 'DOCUMENT_UPLOAD_ASSET_INACTIVE' && candidate.details?.upload) {
      try { accept(candidate.details.upload); return; } catch { /* Preserve unknown if malformed. */ }
    }
    publish({ busy: false, phase: candidate?.status === 401 || candidate?.status === 403 ? 'restricted' : 'unknown',
      message: candidate?.status === 401 || candidate?.status === 403 ? '访问受限，恢复权限后继续核对原文件'
        : '上传结果暂未确认，请核对原文件，勿重复新增' });
  }
  async function send(retryOfAttempt?: number) {
    if (!file || !dependencies.current()) return;
    publish({ busy: true, phase: 'uploading', message: '正在上传原件' });
    try { const result = await dependencies.put(file, retryOfAttempt === undefined ? 1 : retryOfAttempt + 1, retryOfAttempt);
      if (dependencies.current()) accept(result); } catch (error) { fail(error); }
  }
  return {
    state: () => state,
    prepared(registration: Record<string, unknown>) { publish({ registration: safeRegistration(registration) }); },
    async replayRegistration(selected?: Blob, password?: string) {
      if (state.busy || !dependencies.current() || state.phase !== 'unknown' || state.result) return;
      const bytes = selected ?? file; if (!bytes) return;
      publish({ busy: true, message: '正在使用原编号核对并注册' });
      try {
        const result = await (dependencies.replay ? dependencies.replay(bytes, state.registration, password) : dependencies.register(bytes));
        if (!dependencies.current()) return;
        file = bytes; accept(result); publish({ hasFile: true });
        if (result.status === 'WAITING_BYTES') await send();
      } catch (error) {
        if ((error as { code?: string })?.code === 'LOCAL_DOCUMENT_MISMATCH') publish({ busy: false, message: (error as Error).message });
        else fail(error);
      }
    },
    async start(selected: Blob) {
      if (state.busy || state.phase !== 'selected' || !dependencies.current()) return;
      file = selected; publish({ busy: true, phase: 'uploading', hasFile: true, message: '正在注册文件' });
      try {
        const result = await dependencies.register(selected);
        if (!dependencies.current()) return;
        // Do not open a gap for a concurrent click between registration and PUT.
        accept(result);
        if (result.status === 'WAITING_BYTES') await send();
      } catch (error) {
        const rejected = error as { status?: number; code?: string; message?: string };
        if ([400, 413, 415].includes(rejected?.status ?? 0) && /^(DOCUMENT_(INVALID_|TOO_LARGE|TYPE_UNSUPPORTED|MIME_MISMATCH|REPLACEMENT_INVALID))/.test(rejected?.code ?? '')) {
          publish({ busy: false, phase: 'not_saved', message: `${rejected.message || '文件信息无效'}，请修正后重新选择文件。` });
        } else fail(error);
      }
    },
    async retry() {
      if (state.busy || !file || !dependencies.current()) return;
      if (state.phase === 'not_saved' && state.result?.retryable) await send(state.result.attempt);
      else if (state.phase === 'waiting') await send();
    },
    async reselect(selected: Blob) {
      if (state.busy || !dependencies.current() || !(state.phase === 'waiting' || (state.phase === 'not_saved' && state.result?.retryable))) return;
      publish({ busy: true });
      try {
        const result = await (dependencies.reregister ?? dependencies.register)(selected);
        if (!dependencies.current()) return;
        accept(result); file = selected; publish({ hasFile: true });
        if (state.phase === 'waiting') await send();
        else if (state.phase === 'not_saved' && state.result?.retryable) await send(state.result.attempt);
      } catch (error) {
        if ((error as { code?: string })?.code === 'LOCAL_DOCUMENT_MISMATCH') publish({ busy: false, message: (error as Error).message });
        else fail(error);
      }
    },
    async check() {
      if (state.busy || !dependencies.current()) return;
      publish({ busy: true, message: '正在核对原上传' });
      try { const result = await dependencies.query(); if (dependencies.current()) accept(result); }
      catch (error) { fail(error); }
    },
    releaseFile() { file = null; publish({ hasFile: false }); },
  };
}

export const DOCUMENT_JOURNAL_KEY = 'cmhub-pickup-document-uploads-v1';
export function writeDocumentJournal(items: UploadState[], owner: string): string {
  return JSON.stringify({ version: 1, owner, items: items.filter(item => !['saved', 'inactive', 'selected'].includes(item.phase)
    && !(item.phase === 'not_saved' && !item.result?.retryable)).map(({ uploadId, orderId, registration }) => ({ uploadId, orderId,
      ...(registration ? { registration: safeRegistration(registration) } : {}) })) });
}
export function readDocumentJournal(raw: string | null, owner: string): InitialUpload[] {
  try {
    const data = JSON.parse(raw ?? 'null');
    if (!data || data.version !== 1 || data.owner !== owner || !Array.isArray(data.items)) return [];
    return data.items.filter((item: { uploadId?: string; orderId?: string }) => typeof item.uploadId === 'string'
      && /^[0-9a-f-]{36}$/i.test(item.uploadId) && typeof item.orderId === 'string' && item.orderId.length > 0 && item.orderId.length <= 64)
      .map(({ uploadId, orderId, registration }: { uploadId: string; orderId: string; registration?: Record<string, unknown> }) => ({ uploadId, orderId,
        filename: typeof registration?.filename === 'string' ? registration.filename.slice(0, 240) : '待核对文件', phase: 'unknown',
        ...(registration && typeof registration === 'object' ? { registration: safeRegistration(registration) } : {}) }));
  } catch { return []; }
}
function safeRegistration(value: Record<string, unknown>): Record<string, unknown> {
  const fields = new Set(['uploadId','filename','byteSize','sha256','declaredContentType','policyVersion','supersedesAssetId','expectedAssetVersion','reason']);
  return Object.fromEntries(Object.entries(value).filter(([key, entry]) => fields.has(key)
    && (entry === null || typeof entry === 'number' && Number.isFinite(entry) || typeof entry === 'string' && entry.length <= 1000)));
}
function uploadErrorMessage(code?: string | null): string {
  const messages: Record<string, string> = {
    DOCUMENT_CHECK_UNAVAILABLE: '文件检查服务暂时不可用，请稍后重试。', DOCUMENT_CONTENT_INVALID: '文件损坏、加密或真实格式不符，请重新选择。',
    DOCUMENT_QUOTA_EXCEEDED: '有效文件数量或总容量已达上限。', DOCUMENT_REPLACEMENT_DUPLICATE: '更正版与另一份有效文件重复。',
    DOCUMENT_ASSET_VERSION_CONFLICT: '旧版已变化，请刷新列表后重新检查。', DOCUMENT_STORAGE_UNAVAILABLE: '存储暂不可用，请稍后重试。',
    DOCUMENT_HASH_MISMATCH: '传输摘要不一致，请重新选择原文件。', DOCUMENT_LENGTH_MISMATCH: '接收长度不一致，请重新选择原文件。',
  };
  return messages[code ?? ''] ?? '请核对文件及当前权限。';
}
