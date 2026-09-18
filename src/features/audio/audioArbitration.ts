export type AudioPurpose = 'notification' | 'scan' | 'intercept';

const priority: Record<AudioPurpose, number> = {
  notification: 1,
  scan: 2,
  intercept: 3,
};

export function createAudioArbitrator() {
  let active: { purpose: AudioPurpose; until: number } | null = null;
  return {
    reserve(purpose: AudioPurpose, now: number, durationMs: number) {
      if (active && active.until > now && priority[active.purpose] > priority[purpose]) return false;
      active = { purpose, until: now + durationMs };
      return true;
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
