import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

export type InterceptRuleSource = 'manual' | 'scan';

export interface InterceptRule {
  id: string;
  waybillNo: string;
  normalizedWaybillNo: string;
  createdAt: number;
  source: InterceptRuleSource;
}

type InterceptStorageStatus = 'ready' | 'corrupted' | 'unavailable';

const INTERCEPT_RULE_STORAGE_KEY = 'cmhub-intercept-rules-v1';
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

const loadRules = (): { rules: InterceptRule[]; status: InterceptStorageStatus } => {
  try {
    const rawValue = localStorage.getItem(INTERCEPT_RULE_STORAGE_KEY);
    if (!rawValue) return { rules: [], status: 'ready' };

    const parsedValue: unknown = JSON.parse(rawValue);
    if (!Array.isArray(parsedValue)) return { rules: [], status: 'corrupted' };

    const ruleIndex = new Set<string>();
    const rules = parsedValue
      .filter(isStoredRule)
      .map(rule => ({ ...rule, normalizedWaybillNo: normalizeInterceptWaybill(rule.waybillNo) }))
      .filter(rule => {
        if (ruleIndex.has(rule.normalizedWaybillNo)) return false;
        ruleIndex.add(rule.normalizedWaybillNo);
        return true;
      })
      .sort((left, right) => right.createdAt - left.createdAt);

    return { rules, status: rules.length === parsedValue.length ? 'ready' : 'corrupted' };
  } catch {
    return { rules: [], status: 'corrupted' };
  }
};

/**
 * The scan workspace may stay mounted while an operator manages the intercept
 * list in another view. Read the persisted list as the final source of truth
 * before a scan continues to matching or printing.
 */
export const findStoredInterceptRule = (value: string) => {
  const { rules } = loadRules();
  const normalizedWaybillNo = normalizeInterceptWaybill(value);
  return rules.find(rule => rule.normalizedWaybillNo === normalizedWaybillNo) ?? null;
};

export function useInterceptRules() {
  const [initialState] = useState(loadRules);
  const [rules, setRules] = useState<InterceptRule[]>(initialState.rules);
  const [storageStatus, setStorageStatus] = useState<InterceptStorageStatus>(initialState.status);
  const instanceId = useRef(`intercept-rules-${Math.random().toString(36).slice(2)}`);

  const ruleIndex = useMemo(() => {
    const index = new Map<string, InterceptRule>();
    rules.forEach(rule => index.set(rule.normalizedWaybillNo, rule));
    return index;
  }, [rules]);

  const syncRulesFromStorage = useCallback(() => {
    const nextState = loadRules();
    setRules(nextState.rules);
    setStorageStatus(nextState.status);
  }, []);

  useEffect(() => {
    const handleStorage = (event: StorageEvent) => {
      if (event.key === INTERCEPT_RULE_STORAGE_KEY) syncRulesFromStorage();
    };
    const handleRulesUpdated = (event: Event) => {
      if (event instanceof CustomEvent && event.detail === instanceId.current) return;
      syncRulesFromStorage();
    };

    window.addEventListener('storage', handleStorage);
    window.addEventListener(INTERCEPT_RULES_UPDATED_EVENT, handleRulesUpdated);
    return () => {
      window.removeEventListener('storage', handleStorage);
      window.removeEventListener(INTERCEPT_RULES_UPDATED_EVENT, handleRulesUpdated);
    };
  }, [syncRulesFromStorage]);

  const persistRules = useCallback((nextRules: InterceptRule[]) => {
    try {
      localStorage.setItem(INTERCEPT_RULE_STORAGE_KEY, JSON.stringify(nextRules));
      setStorageStatus('ready');
      window.dispatchEvent(new CustomEvent(INTERCEPT_RULES_UPDATED_EVENT, { detail: instanceId.current }));
    } catch {
      setStorageStatus('unavailable');
    }
  }, []);

  const findRule = useCallback((value: string) => ruleIndex.get(normalizeInterceptWaybill(value)) ?? null, [ruleIndex]);

  const addRule = useCallback((rawWaybillNo: string, source: InterceptRuleSource) => {
    const waybillNo = sanitizeInterceptWaybill(rawWaybillNo);
    const validationError = getInterceptWaybillError(waybillNo);
    if (validationError) return { ok: false as const, reason: 'invalid' as const, message: validationError };

    const normalizedWaybillNo = normalizeInterceptWaybill(waybillNo);
    if (ruleIndex.has(normalizedWaybillNo)) {
      return { ok: false as const, reason: 'duplicate' as const, message: '该单号已在拦截名单中。' };
    }

    const rule: InterceptRule = {
      id: createRuleId(),
      waybillNo,
      normalizedWaybillNo,
      createdAt: Date.now(),
      source
    };
    const nextRules = [rule, ...rules];
    setRules(nextRules);
    persistRules(nextRules);
    return { ok: true as const, rule };
  }, [persistRules, ruleIndex, rules]);

  const removeRule = useCallback((id: string) => {
    const nextRules = rules.filter(rule => rule.id !== id);
    setRules(nextRules);
    persistRules(nextRules);
  }, [persistRules, rules]);

  return {
    rules,
    storageStatus,
    findRule,
    addRule,
    removeRule
  };
}
