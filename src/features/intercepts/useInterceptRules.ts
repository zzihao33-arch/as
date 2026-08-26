import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { readLocalFirstValue, writeLocalFirstValue } from '../../shared/storage/localFirstDatabase';

export type InterceptRuleSource = 'manual' | 'scan';

export interface InterceptRule {
  id: string;
  waybillNo: string;
  normalizedWaybillNo: string;
  createdAt: number;
  source: InterceptRuleSource;
}

export type InterceptStorageStatus = 'loading' | 'ready' | 'corrupted' | 'unavailable';

const LEGACY_INTERCEPT_RULE_STORAGE_KEY = 'cmhub-intercept-rules-v1';
const INTERCEPT_RULES_DATABASE_KEY = 'rules';
const INTERCEPT_RULES_UPDATED_EVENT = 'cmhub-intercept-rules-updated';
const WAYBILL_PATTERN = /^[a-z0-9-]{8,25}$/i;

const createRuleId = () => `intercept-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

export const sanitizeInterceptWaybill = (value: string) => value.trim().replace(/[\x00-\x1F\x7F-\x9F]/g, '');
export const normalizeInterceptWaybill = (value: string) => sanitizeInterceptWaybill(value).toLowerCase();

export const getInterceptWaybillError = (value: string) => {
  const waybillNo = sanitizeInterceptWaybill(value);
  if (!waybillNo) return '请输入拦截单号。';
  if (!WAYBILL_PATTERN.test(waybillNo)) return '单号格式错误：请输入 8–25 位字母、数字或连字符。';
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
  if (legacy.rules.length > 0) {
    await writeLocalFirstValue('intercepts', INTERCEPT_RULES_DATABASE_KEY, legacy.rules);
  }
  return legacy;
};

const splitWaybills = (value: string) => value
  .split(/[\s,;，；]+/)
  .map(sanitizeInterceptWaybill)
  .filter(Boolean);

export function useInterceptRules() {
  const [rules, setRules] = useState<InterceptRule[]>([]);
  const [storageStatus, setStorageStatus] = useState<InterceptStorageStatus>('loading');
  const instanceId = useRef(`intercept-rules-${Math.random().toString(36).slice(2)}`);

  const ruleIndex = useMemo(() => {
    const index = new Map<string, InterceptRule>();
    rules.forEach(rule => index.set(rule.normalizedWaybillNo, rule));
    return index;
  }, [rules]);

  const syncRulesFromStorage = useCallback(async () => {
    setStorageStatus('loading');
    try {
      const nextState = await loadRules();
      setRules(nextState.rules);
      setStorageStatus(nextState.isCorrupted ? 'corrupted' : 'ready');
    } catch {
      setStorageStatus('unavailable');
    }
  }, []);

  useEffect(() => {
    void syncRulesFromStorage();
  }, [syncRulesFromStorage]);

  useEffect(() => {
    const handleRulesUpdated = (event: Event) => {
      if (event instanceof CustomEvent && event.detail === instanceId.current) return;
      void syncRulesFromStorage();
    };
    window.addEventListener(INTERCEPT_RULES_UPDATED_EVENT, handleRulesUpdated);
    return () => window.removeEventListener(INTERCEPT_RULES_UPDATED_EVENT, handleRulesUpdated);
  }, [syncRulesFromStorage]);

  const persistRules = useCallback(async (nextRules: InterceptRule[]) => {
    try {
      await writeLocalFirstValue('intercepts', INTERCEPT_RULES_DATABASE_KEY, nextRules);
      setStorageStatus('ready');
      window.dispatchEvent(new CustomEvent(INTERCEPT_RULES_UPDATED_EVENT, { detail: instanceId.current }));
      return true;
    } catch {
      setStorageStatus('unavailable');
      return false;
    }
  }, []);

  const findRule = useCallback((value: string) => ruleIndex.get(normalizeInterceptWaybill(value)) ?? null, [ruleIndex]);

  const addRules = useCallback(async (rawWaybills: string, source: InterceptRuleSource) => {
    const values = splitWaybills(rawWaybills);
    if (values.length === 0) {
      return { ok: false as const, added: 0, duplicates: 0, invalid: 0, message: '请输入至少一个拦截单号。' };
    }

    const nextRules = [...rules];
    const nextIndex = new Set(ruleIndex.keys());
    let duplicates = 0;
    let invalid = 0;

    values.forEach(value => {
      if (getInterceptWaybillError(value)) {
        invalid += 1;
        return;
      }

      const normalizedWaybillNo = normalizeInterceptWaybill(value);
      if (nextIndex.has(normalizedWaybillNo)) {
        duplicates += 1;
        return;
      }

      nextIndex.add(normalizedWaybillNo);
      nextRules.unshift({
        id: createRuleId(),
        waybillNo: value,
        normalizedWaybillNo,
        createdAt: Date.now(),
        source
      });
    });

    const added = nextRules.length - rules.length;
    if (added === 0) {
      const message = invalid > 0
        ? '没有添加成功：请检查单号格式。'
        : '输入的单号已全部存在于拦截名单。';
      return { ok: false as const, added, duplicates, invalid, message };
    }

    setRules(nextRules);
    const persisted = await persistRules(nextRules);
    if (!persisted) {
      return { ok: false as const, added, duplicates, invalid, message: '名单已暂存，但无法写入本机数据仓库。' };
    }

    const details = [duplicates ? `${duplicates} 个重复` : '', invalid ? `${invalid} 个格式错误` : ''].filter(Boolean).join('，');
    return {
      ok: true as const,
      added,
      duplicates,
      invalid,
      message: details ? `已加入 ${added} 个拦截单号；${details}。` : `已加入 ${added} 个拦截单号。`
    };
  }, [persistRules, ruleIndex, rules]);

  const removeRule = useCallback(async (id: string) => {
    const nextRules = rules.filter(rule => rule.id !== id);
    setRules(nextRules);
    await persistRules(nextRules);
  }, [persistRules, rules]);

  return {
    rules,
    storageStatus,
    findRule,
    addRules,
    removeRule
  };
}
