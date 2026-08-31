import { useCallback, useEffect, useRef, useState } from 'react';
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
  const ordered = pending
    .map(entry => entry.value)
    .filter(attempt => attempt.workstationId === workstationId)
    .sort((left, right) => left.queuedAt - right.queuedAt);
  for (const attempt of ordered) {
    try {
      await deliver(attempt);
    } catch {
      // Preserve order and stop on the first unavailable response. The next online
      // event/interval retries the same idempotent clientAttemptId.
      break;
    }
  }
}

export function useWarehousePrintAudit(workstationId: string | undefined) {
  const flushingRef = useRef<Promise<void> | null>(null);
  const [pendingCount, setPendingCount] = useState(0);
  const refreshPendingCount = useCallback(async () => {
    const pending = await readAllLocalFirstEntries<QueuedAttempt>('cloudPrintOutbox');
    setPendingCount(pending.filter(entry => !workstationId || entry.value.workstationId === workstationId).length);
  }, [workstationId]);
  const flushPending = useCallback(() => {
    if (!workstationId || flushingRef.current) return flushingRef.current ?? Promise.resolve();
    const running = flush(workstationId).finally(() => {
      flushingRef.current = null;
      void refreshPendingCount();
    });
    flushingRef.current = running;
    return running;
  }, [refreshPendingCount, workstationId]);

  useEffect(() => {
    if (!workstationId) return;
    void refreshPendingCount();
    void flushPending();
    const interval = window.setInterval(() => void flushPending(), 30_000);
    const online = () => void flushPending();
    window.addEventListener('online', online);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener('online', online);
    };
  }, [flushPending, refreshPendingCount, workstationId]);

  const record = useCallback(async (input: WarehousePrintAttemptInput): Promise<void> => {
    const queued = { ...input, queuedAt: Date.now() } satisfies QueuedAttempt;
    await writeLocalFirstValue('cloudPrintOutbox', input.clientAttemptId, queued);
    setPendingCount(count => count + 1);
    void flushPending();
  }, [flushPending]);

  return { record, flushPending, pendingCount };
}
