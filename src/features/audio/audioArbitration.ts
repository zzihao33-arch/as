export type AudioPurpose = 'notification' | 'scan' | 'intercept';
export type AudioLease = {
  purpose: AudioPurpose;
  isCurrent: () => boolean;
  release: () => void;
};

const priority: Record<AudioPurpose, number> = {
  notification: 1,
  scan: 2,
  intercept: 3,
};

export function createAudioArbitrator() {
  let active: { purpose: AudioPurpose; until: number; token: symbol; onPreempt?: () => void } | null = null;
  return {
    claim(purpose: AudioPurpose, now: number, durationMs: number, onPreempt?: () => void): AudioLease | null {
      if (active && active.until > now && priority[active.purpose] > priority[purpose]) return null;
      active?.onPreempt?.();
      const token = Symbol(purpose);
      active = { purpose, until: now + durationMs, token, onPreempt };
      return {
        purpose,
        isCurrent: () => active?.token === token,
        release: () => { if (active?.token === token) active = null; },
      };
    },
    reserve(purpose: AudioPurpose, now: number, durationMs: number) {
      return this.claim(purpose, now, durationMs) !== null;
    },
    current(now: number): AudioPurpose | null {
      if (!active || active.until <= now) {
        active = null;
        return null;
      }
      return active.purpose;
    },
  };
}

export const appAudioArbitrator = createAudioArbitrator();
