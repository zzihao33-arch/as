import { useCallback, useEffect, useRef } from 'react';
import {
  deleteLocalFirstValue,
  readAllLocalFirstEntries,
  writeLocalFirstValue,
} from '../../shared/storage/localFirstDatabase';
import { submitWarehousePrintAttempt } from '../session/warehouseApi';

export type WarehousePrintAttemptInput = {
  workstationId: string;
  shipmentId: string;
  labelAssetId: string;
  clientAttemptId: string;
  outcome: 'SUBMITTED' | 'FAILED' | 'RESULT_UNKNOWN' | 'BLOCKED';
  printerName?: string;
  message?: string;
  occurredAt: string;
};

type QueuedAttempt = WarehousePrintAttemptInput & { queuedAt: number };

async function deliver(attempt: QueuedAttempt): Promise<void> {
  await submitWarehousePrintAttempt(attempt);
  await deleteLocalFirstValue('cloudPrintOutbox', attempt.clientAttemptId);
}
async function flush(workstationId: string): Promise<void> {
  const pending = await readAllLocalFirstEntries<QueuedAttempt>('cloudPrintOutbox');
  for (const entry of pending) {
    if (entry.value.workstationId !== workstationId) continue;
    try {
      await deliver(entry.value);
    } catch {
      // Preserve order and stop on the first unavailable response. The next online
      // event/interval retries the same idempotent clientAttemptId.
      break;
    }
  }
}

export function useWarehousePrintAudit(workstationId: string | undefined) {
  const flushingRef = useRef<Promise<void> | null>(null);
  const flushPending = useCallback(() => {
    if (!workstationId || flushingRef.current) return flushingRef.current ?? Promise.resolve();
    const running = flush(workstationId).finally(() => { flushingRef.current = null; });
    flushingRef.current = running;
    return running;
  }, [workstationId]);

  useEffect(() => {
    if (!workstationId) return;
    void flushPending();
    const interval = window.setInterval(() => void flushPending(), 30_000);
    const online = () => void flushPending();
    window.addEventListener('online', online);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener('online', online);
    };
  }, [flushPending, workstationId]);

  const record = useCallback(async (input: WarehousePrintAttemptInput): Promise<'delivered' | 'queued'> => {
    const queued = { ...input, queuedAt: Date.now() } satisfies QueuedAttempt;
    await writeLocalFirstValue('cloudPrintOutbox', input.clientAttemptId, queued);
    try {
      await deliver(queued);
      return 'delivered';
    } catch {
      return 'queued';
    }
  }, []);

  return { record, flushPending };
}
