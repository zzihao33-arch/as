import { useCallback, useEffect, useRef, useState } from 'react';
import {
  deleteLocalFirstValue,
  readAllLocalFirstEntries,
  writeLocalFirstValue,
} from '../../shared/storage/localFirstDatabase';
import { completeSharedWorkBatchItem } from '../session/warehouseApi';

export type SharedWorkPrintAttemptInput = {
  itemId: string;
  workstationId: string;
  clientAttemptId: string;
  claimToken: string;
  outcome: 'SUBMITTED' | 'FAILED' | 'RESULT_UNKNOWN' | 'BLOCKED';
  printerName?: string;
  message?: string;
  occurredAt: string;
};

type QueuedSharedAttempt = SharedWorkPrintAttemptInput & { queuedAt: number };

async function deliver(attempt: QueuedSharedAttempt): Promise<void> {
  await completeSharedWorkBatchItem(attempt.itemId, {
    workstationId: attempt.workstationId,
    clientAttemptId: attempt.clientAttemptId,
    claimToken: attempt.claimToken,
    outcome: attempt.outcome,
    printerName: attempt.printerName,
    message: attempt.message,
    occurredAt: attempt.occurredAt,
  });
  await deleteLocalFirstValue('sharedPrintOutbox', attempt.clientAttemptId);
}

async function flush(workstationId: string): Promise<void> {
  const pending = await readAllLocalFirstEntries<QueuedSharedAttempt>('sharedPrintOutbox');
  const ordered = pending
    .map(entry => entry.value)
    .filter(attempt => attempt.workstationId === workstationId)
    .sort((left, right) => left.queuedAt - right.queuedAt);
  for (const attempt of ordered) {
    try {
      await deliver(attempt);
    } catch {
      // Preserve submission order. The same clientAttemptId and claim token are
      // safe to replay once connectivity returns.
      break;
    }
  }
}

export function useSharedWorkPrintAudit(workstationId: string | undefined) {
  const flushingRef = useRef<Promise<void> | null>(null);
  const [pendingCount, setPendingCount] = useState(0);
  const refreshPendingCount = useCallback(async () => {
    const pending = await readAllLocalFirstEntries<QueuedSharedAttempt>('sharedPrintOutbox');
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
    const interval = window.setInterval(() => void flushPending(), 5_000);
    const online = () => void flushPending();
    window.addEventListener('online', online);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener('online', online);
    };
  }, [flushPending, refreshPendingCount, workstationId]);

  const record = useCallback(async (input: SharedWorkPrintAttemptInput): Promise<void> => {
    const queued = { ...input, queuedAt: Date.now() } satisfies QueuedSharedAttempt;
    await writeLocalFirstValue('sharedPrintOutbox', input.clientAttemptId, queued);
    setPendingCount(count => count + 1);
    void flushPending();
  }, [flushPending]);

  return { record, flushPending, pendingCount };
}
