import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { listGlobalIntercepts, removeGlobalIntercept, upsertGlobalIntercepts } from '../session/warehouseApi';
import { readLocalFirstValue, writeLocalFirstValue } from '../../shared/storage/localFirstDatabase';

export type InterceptRuleSource = 'manual' | 'scan';

export interface InterceptRule {
  id: string;
  waybillNo: string;
  normalizedWaybillNo: string;
  createdAt: number;
  source: InterceptRuleSource;
  reason?: string;
}

export type InterceptStorageStatus = 'loading' | 'ready' | 'corrupted' | 'unavailable';

const LEGACY_INTERCEPT_RULE_STORAGE_KEY = 'cmhub-intercept-rules-v1';
const INTERCEPT_RULES_DATABASE_KEY = 'rules';
const INTERCEPT_CURSOR_DATABASE_KEY = 'cloud-cursor';
const INTERCEPT_SYNCED_AT_DATABASE_KEY = 'cloud-synced-at';
const INTERCEPT_RULES_UPDATED_EVENT = 'cmhub-intercept-rules-updated';
const WAYBILL_PATTERN = /^[a-z0-9._-]{3,128}$/i;

export const sanitizeInterceptWaybill = (value: string) => value.trim().replace(/[\x00-\x1F\x7F-\x9F]/g, '');
export const normalizeInterceptWaybill = (value: string) => sanitizeInterceptWaybill(value).replaceAll(/\s+/g, '').toLowerCase();

export const getInterceptWaybillError = (value: string) => {
  const waybillNo = sanitizeInterceptWaybill(value).replaceAll(/\s+/g, '');
  if (!waybillNo) return '请输入拦截单号';
  if (!WAYBILL_PATTERN.test(waybillNo)) return '单号格式错误：请输入字母、数字、点、下划线或连字符';
  return null;
};

const isStoredRule = (value: unknown): value is InterceptRule => {
  if (!value || typeof value !== 'object') return false;
  const rule = value as Partial<InterceptRule>;
  return typeof rule.id === 'string'
    && typeof rule.waybillNo === 'string'
    && typeof rule.normalizedWaybillNo === 'string'
    && typeof rule.createdAt === 'number'
    && (rule.source === 'manual' || rule.source === 'scan')
    && !getInterceptWaybillError(rule.waybillNo);
};

const normalizeRules = (value: unknown): { rules: InterceptRule[]; isCorrupted: boolean } => {
  if (!Array.isArray(value)) return { rules: [], isCorrupted: value !== null && value !== undefined };
  const ruleIndex = new Set<string>();
  const rules = value
    .filter(isStoredRule)
    .map(rule => ({ ...rule, normalizedWaybillNo: normalizeInterceptWaybill(rule.waybillNo) }))
    .filter(rule => {
      if (ruleIndex.has(rule.normalizedWaybillNo)) return false;
      ruleIndex.add(rule.normalizedWaybillNo);
      return true;
    })
    .sort((left, right) => right.createdAt - left.createdAt);
  return { rules, isCorrupted: rules.length !== value.length };
};

const readLegacyRules = () => {
  try {
    const rawValue = localStorage.getItem(LEGACY_INTERCEPT_RULE_STORAGE_KEY);
    if (!rawValue) return { rules: [], isCorrupted: false };
    return normalizeRules(JSON.parse(rawValue));
  } catch {
    return { rules: [], isCorrupted: true };
  }
};

const loadRules = async () => {
  const storedRules = await readLocalFirstValue<unknown>('intercepts', INTERCEPT_RULES_DATABASE_KEY);
  if (storedRules !== null) return normalizeRules(storedRules);
  const legacy = readLegacyRules();
  if (legacy.rules.length > 0) await writeLocalFirstValue('intercepts', INTERCEPT_RULES_DATABASE_KEY, legacy.rules);
  return legacy;
};

const splitWaybills = (value: string) => value
  .split(/[\s,;，；]+/)
  .map(sanitizeInterceptWaybill)
  .filter(Boolean);

export function useInterceptRules() {
  const [rules, setRules] = useState<InterceptRule[]>([]);
  const [storageStatus, setStorageStatus] = useState<InterceptStorageStatus>('loading');
  const [lastSyncedAt, setLastSyncedAt] = useState<number | null>(null);
  const instanceId = useRef(`intercept-rules-${crypto.randomUUID()}`);
  const rulesRef = useRef<InterceptRule[]>([]);

  useEffect(() => { rulesRef.current = rules; }, [rules]);

  const ruleIndex = useMemo(() => {
    const index = new Map<string, InterceptRule>();
    rules.forEach(rule => index.set(rule.normalizedWaybillNo, rule));
    return index;
  }, [rules]);

  const persistRules = useCallback(async (nextRules: InterceptRule[], cursor?: string) => {
    await writeLocalFirstValue('intercepts', INTERCEPT_RULES_DATABASE_KEY, nextRules);
    if (cursor !== undefined) await writeLocalFirstValue('intercepts', INTERCEPT_CURSOR_DATABASE_KEY, cursor);
    setRules(nextRules);
    rulesRef.current = nextRules;
    window.dispatchEvent(new CustomEvent(INTERCEPT_RULES_UPDATED_EVENT, { detail: instanceId.current }));
  }, []);

  const syncRules = useCallback(async (reset = false) => {
    try {
      const local = await loadRules();
      if (rulesRef.current.length === 0 && local.rules.length > 0) {
        setRules(local.rules);
        rulesRef.current = local.rules;
      }
      const storedCursor = await readLocalFirstValue<string>('intercepts', INTERCEPT_CURSOR_DATABASE_KEY);
      if (storedCursor === null && local.rules.length > 0) {
        for (let start = 0; start < local.rules.length; start += 1_000) {
          await upsertGlobalIntercepts(
            local.rules.slice(start, start + 1_000).map(rule => ({ trackingNo: rule.waybillNo })),
            'BULK_IMPORT',
          );
        }
      }
      let cursor = reset ? '0' : storedCursor ?? '0';
      const index = new Map((reset ? [] : rulesRef.current).map(rule => [rule.normalizedWaybillNo, rule]));
      let hasMore = true;
      while (hasMore) {
        const page = await listGlobalIntercepts(cursor);
        for (const entry of page.data) {
          const normalized = normalizeInterceptWaybill(entry.trackingNo);
          if (entry.status === 'REMOVED') index.delete(normalized);
          else index.set(normalized, {
            id: entry.id,
            waybillNo: entry.trackingNo,
            normalizedWaybillNo: normalized,
            createdAt: new Date(entry.updatedAt).getTime(),
            source: 'manual',
            reason: entry.reason ?? undefined,
          });
        }
        cursor = page.cursor;
        hasMore = page.hasMore;
      }
      const nextRules = [...index.values()].sort((left, right) => right.createdAt - left.createdAt);
      await persistRules(nextRules, cursor);
      const syncedAt = Date.now();
      await writeLocalFirstValue('intercepts', INTERCEPT_SYNCED_AT_DATABASE_KEY, syncedAt);
      setLastSyncedAt(syncedAt);
      setStorageStatus(local.isCorrupted ? 'corrupted' : 'ready');
    } catch {
      const cachedSyncedAt = await readLocalFirstValue<number>('intercepts', INTERCEPT_SYNCED_AT_DATABASE_KEY).catch(() => null);
      setLastSyncedAt(cachedSyncedAt);
      setStorageStatus('unavailable');
    }
  }, [persistRules]);

  useEffect(() => {
    void syncRules(true);
    const interval = window.setInterval(() => void syncRules(), 15_000);
    const online = () => void syncRules();
    window.addEventListener('online', online);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener('online', online);
    };
  }, [syncRules]);

  useEffect(() => {
    const handleRulesUpdated = (event: Event) => {
      if (event instanceof CustomEvent && event.detail === instanceId.current) return;
      void loadRules().then(state => {
        setRules(state.rules);
        rulesRef.current = state.rules;
      });
    };
    window.addEventListener(INTERCEPT_RULES_UPDATED_EVENT, handleRulesUpdated);
    return () => window.removeEventListener(INTERCEPT_RULES_UPDATED_EVENT, handleRulesUpdated);
  }, []);

  const findRule = useCallback((value: string) => ruleIndex.get(normalizeInterceptWaybill(value)) ?? null, [ruleIndex]);

  const addRules = useCallback(async (rawWaybills: string, source: InterceptRuleSource, reason?: string) => {
    const sourceLabel = source === 'scan' ? '扫码' : '手动';
    const values = splitWaybills(rawWaybills);
    if (values.length === 0) return { ok: false as const, added: 0, duplicates: 0, invalid: 0, message: '请输入至少一个拦截单号' };
    const valid: string[] = [];
    const nextIndex = new Set(ruleIndex.keys());
    let duplicates = 0;
    let invalid = 0;
    for (const value of values) {
      if (getInterceptWaybillError(value)) { invalid += 1; continue; }
      const normalized = normalizeInterceptWaybill(value);
      if (nextIndex.has(normalized)) { duplicates += 1; continue; }
      nextIndex.add(normalized);
      valid.push(value);
    }
    if (valid.length === 0) {
      return { ok: false as const, added: 0, duplicates, invalid, message: invalid ? '没有添加成功：请检查单号格式' : '输入的单号已全部存在于拦截名单' };
    }
    try {
      for (let start = 0; start < valid.length; start += 1_000) {
        await upsertGlobalIntercepts(valid.slice(start, start + 1_000).map(trackingNo => ({ trackingNo, reason: reason?.trim() || undefined })), valid.length > 1 ? 'BULK_IMPORT' : 'MANUAL');
      }
      await syncRules();
      const details = [duplicates ? `${duplicates} 个重复` : '', invalid ? `${invalid} 个格式错误` : ''].filter(Boolean).join('，');
      return { ok: true as const, added: valid.length, duplicates, invalid, message: details ? `${sourceLabel}共享 ${valid.length} 个拦截单号；${details}` : `${sourceLabel}共享 ${valid.length} 个拦截单号` };
    } catch (cause) {
      setStorageStatus('unavailable');
      return { ok: false as const, added: 0, duplicates, invalid, message: cause instanceof Error ? cause.message : '云端拦截名单写入失败' };
    }
  }, [ruleIndex, syncRules]);

  const removeRule = useCallback(async (id: string) => {
    const rule = rulesRef.current.find(item => item.id === id);
    if (!rule) return;
    await removeGlobalIntercept(rule.waybillNo);
    await syncRules();
  }, [syncRules]);

  return { rules, storageStatus, lastSyncedAt, sync: syncRules, findRule, addRules, removeRule };
}
