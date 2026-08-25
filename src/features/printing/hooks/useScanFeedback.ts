import { useCallback, useEffect, useRef, useState } from 'react';
import type { ScanFeedbackState } from '../printingTypes';

const FEEDBACK_DURATION_MS: Record<Exclude<ScanFeedbackState, 'idle'>, number> = {
  processing: 4_000,
  success: 1_200,
  error: 1_200
};

export function useScanFeedback() {
  const [scanFeedback, setScanFeedback] = useState<ScanFeedbackState>('idle');
  const timerRef = useRef<number | null>(null);

  const announceScanFeedback = useCallback((state: Exclude<ScanFeedbackState, 'idle'>) => {
    if (timerRef.current) {
      window.clearTimeout(timerRef.current);
    }

    setScanFeedback(state);
    timerRef.current = window.setTimeout(() => {
      setScanFeedback('idle');
      timerRef.current = null;
    }, FEEDBACK_DURATION_MS[state]);
  }, []);

  useEffect(() => () => {
    if (timerRef.current) {
      window.clearTimeout(timerRef.current);
    }
  }, []);

  return { scanFeedback, announceScanFeedback };
}
