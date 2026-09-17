export function createLogListLoader<T>(callbacks: {
  load: (signal: AbortSignal) => Promise<T>;
  onStart: () => void;
  onSuccess: (result: T) => void;
  onError: (error: unknown) => void;
  onIdle: () => void;
}) {
  let disposed = false;
  let running = false;
  let queued = false;
  let controller: AbortController | null = null;
  const run = async () => {
    running = true;
    controller = new AbortController();
    callbacks.onStart();
    try {
      const result = await callbacks.load(controller.signal);
      if (!disposed) callbacks.onSuccess(result);
    } catch (error) {
      if (!disposed) callbacks.onError(error);
    } finally {
      running = false;
      if (!disposed) {
        if (queued) { queued = false; void run(); }
        else callbacks.onIdle();
      }
    }
  };
  return {
    refresh() {
      if (disposed) return;
      if (running) queued = true;
      else void run();
    },
    dispose() { disposed = true; queued = false; controller?.abort(); },
  };
}

// This lifetime belongs to the page, independently of filter/list requests.
export function createLogReadAcknowledgement(callbacks: {
  save: (cursor: string) => Promise<void>;
  onError: (failedCursor: string | null) => void;
}) {
  let disposed = false;
  let entryCursor: string | null = null;
  let serial = 0;
  const acknowledge = async (cursor: string) => {
    if (disposed) return;
    const sequence = ++serial;
    try {
      await callbacks.save(cursor);
      if (!disposed && sequence === serial) callbacks.onError(null);
    } catch {
      if (!disposed && sequence === serial) callbacks.onError(cursor);
    }
  };
  return {
    entry(cursor: string) {
      if (entryCursor !== null || disposed) return;
      entryCursor = cursor;
      void acknowledge(cursor);
    },
    acknowledge,
    dispose() { disposed = true; },
  };
}

// Cover the entire request, including JSON body consumption, not only headers.
export async function withLogRequestTimeout<T>(operation: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal | null): Promise<T> {
  if (signal?.aborted) throw new DOMException('Request cancelled', 'AbortError');
  const controller = new AbortController();
  let rejectDeadline!: (reason: unknown) => void;
  const deadline = new Promise<never>((_, reject) => { rejectDeadline = reject; });
  const cancel = () => {
    const error = new DOMException('Request cancelled', 'AbortError');
    rejectDeadline(error);
    controller.abort(error);
  };
  const timer = setTimeout(() => {
    const error = new DOMException('推送日志请求超时，请重试。', 'TimeoutError');
    rejectDeadline(error);
    controller.abort(error);
  }, 10_000);
  signal?.addEventListener('abort', cancel, { once: true });
  try {
    return await Promise.race([operation(controller.signal), deadline]);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', cancel);
  }
}
