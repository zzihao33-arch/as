export type IdentityScope = { userId: string; warehouseId: string | null; epoch: number };
export type AccessFailure = 'session' | 'reauthentication' | 'permission' | 'other';

export function sameIdentityScope(a: IdentityScope, b: IdentityScope): boolean {
  return a.userId === b.userId && a.warehouseId === b.warehouseId && a.epoch === b.epoch;
}

export function classifyAccess(status: number, code: string): AccessFailure {
  if (status === 401 && code === 'REAUTHENTICATION_FAILED') return 'reauthentication';
  if (status === 401 && ['SESSION_REQUIRED', 'SESSION_INVALID'].includes(code)) return 'session';
  return status === 403 ? 'permission' : 'other';
}

export function createSessionFence() {
  let epoch = 0;
  let reported = -1;
  const blockedRequests = new Set<string>();
  const listeners = new Set<(failure: 'session' | 'permission') => void>();
  return {
    current: () => epoch,
    isCurrent: (candidate: number) => candidate === epoch,
    advance: (resetRecovery = true) => { if (resetRecovery) blockedRequests.clear(); return ++epoch; },
    succeeded(candidate: number, request = '*') {
      if (candidate !== epoch) return;
      blockedRequests.delete('session:' + recoveryRequestKey(request));
      blockedRequests.delete('permission:' + recoveryRequestKey(request));
    },
    subscribe(listener: (failure: 'session' | 'permission') => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    report(status: number, code: string, candidate: number, request = '*') {
      const failure = classifyAccess(status, code);
      const key = failure + ':' + recoveryRequestKey(request);
      if (blockedRequests.has(key) || candidate !== epoch || reported === epoch || (failure !== 'session' && failure !== 'permission')) return;
      reported = epoch;
      blockedRequests.add(key);
      for (const listener of listeners) listener(failure);
    },
  };
}

export const warehouseSessionFence = createSessionFence();

export class StaleSessionResponse extends Error {
  constructor() { super('身份或页面已变化，已忽略旧请求结果。'); }
}

function recoveryRequestKey(path: string) { return new URL(path, 'http://local').pathname; }

export function assertCurrentSession(epoch: number) {
  if (!warehouseSessionFence.isCurrent(epoch)) throw new StaleSessionResponse();
}

export function sessionInputOwner(session: { userId: string; warehouseId: string | null; permissions: string[]; passwordState: string }) {
  return JSON.stringify([session.userId, session.warehouseId, [...session.permissions].sort().join(','), session.passwordState]);
}

// Query handles survive permission changes but never cross accounts or workspaces.
export function operationJournalOwner(session: { userId: string; warehouseId: string | null }): string {
  return JSON.stringify([session.userId, session.warehouseId]);
}

export async function guardSessionRequest<T>(path: string, send: () => Promise<T>): Promise<T> {
  const epoch = warehouseSessionFence.current();
  const managed = /\/warehouse\/v1\/sessions?(?:[/?]|$)/.test(path);
  try {
    const result = await send();
    if (!managed && !warehouseSessionFence.isCurrent(epoch)) throw new StaleSessionResponse();
    if (!managed && !path.includes('/warehouse/v1/workstations')) warehouseSessionFence.succeeded(epoch, path);
    return result;
  } catch (error) {
    if (!managed) {
      if (!warehouseSessionFence.isCurrent(epoch)) throw new StaleSessionResponse();
      if (!path.includes('/warehouse/v1/workstations') && error && typeof error === 'object' && 'status' in error && 'code' in error) {
        warehouseSessionFence.report(Number(error.status), String(error.code), epoch, path);
      }
    }
    throw error;
  }
}

export function createProtectedDraftStore() {
  let owner = '';
  const values = new Map<string, unknown>();
  const clear = () => {
    // Only receipt file previews own object URLs in this store.
    const files = values.get('air.receiptEvidence');
    if (Array.isArray(files)) for (const file of files) {
      if (typeof file?.previewUrl === 'string') URL.revokeObjectURL(file.previewUrl);
    }
    values.clear();
  };
  return {
    activate(nextOwner: string) { if (owner !== nextOwner) clear(); owner = nextOwner; },
    clear,
    get: (key: string) => values.get(key),
    set: (key: string, value: unknown) => { values.set(key, value); },
    has: (key: string) => values.has(key),
  };
}

const draftFields = new Set(['clientId', 'billNo', 'cargoName', 'forecastCartons', 'forecastPackages', 'forecastWeight', 'forecastWeightUnit', 'remarks']);
export function safeCreateDraft(values: Record<string, unknown>): Record<string, string | number> {
  return Object.fromEntries(Object.entries(values).filter(([key, value]) =>
    draftFields.has(key) && (typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value))),
  )) as Record<string, string | number>;
}

export function readOwnedDraft(raw: string | null, owner: string, now = Date.now()): Record<string, string | number> | null {
  try {
    const draft = JSON.parse(raw ?? 'null');
    if (!draft || draft.owner !== owner || !Number.isFinite(draft.savedAt)
      || now < draft.savedAt || now - draft.savedAt > 3_600_000
      || !draft.values || typeof draft.values !== 'object' || Array.isArray(draft.values)) return null;
    return safeCreateDraft(draft.values);
  } catch { return null; }
}
