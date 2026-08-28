export const sanitizeBarcode = (value: string) => value.trim().replace(/[\x00-\x1F\x7F-\x9F]/g, '');

export const normalizeBarcode = (value: string) => sanitizeBarcode(value).toLowerCase();

export interface PdfSearchIndex {
  exactKeys: Map<string, string>;
  ambiguousExactKeys: Set<string>;
  entries: Array<{ key: string; normalizedKey: string }>;
}

export interface PdfMatchResult {
  key?: string;
  ambiguous: boolean;
}

export const createPdfSearchIndex = (files: Readonly<Record<string, unknown>>): PdfSearchIndex => {
  const entries = Object.keys(files).map(key => ({ key, normalizedKey: normalizeBarcode(key) }));
  const exactKeys = new Map<string, string>();
  const ambiguousExactKeys = new Set<string>();

  for (const entry of entries) {
    if (exactKeys.has(entry.normalizedKey)) {
      exactKeys.delete(entry.normalizedKey);
      ambiguousExactKeys.add(entry.normalizedKey);
    } else if (!ambiguousExactKeys.has(entry.normalizedKey)) {
      exactKeys.set(entry.normalizedKey, entry.key);
    }
  }

  return {
    entries,
    exactKeys,
    ambiguousExactKeys
  };
};

export const findPdfMatch = (
  index: PdfSearchIndex,
  values: ReadonlyArray<string | null | undefined>
): PdfMatchResult => {
  const candidates = Array.from(new Set(values.map(value => normalizeBarcode(value ?? '')).filter(Boolean)));
  if (candidates.length === 0) return { ambiguous: false };
  if (candidates.some(candidate => index.ambiguousExactKeys.has(candidate))) return { ambiguous: true };

  const exactMatches = new Set(candidates.map(candidate => index.exactKeys.get(candidate)).filter((key): key is string => Boolean(key)));
  if (exactMatches.size === 1) return { key: exactMatches.values().next().value, ambiguous: false };
  if (exactMatches.size > 1) return { ambiguous: true };

  for (const predicate of [
    (normalizedKey: string, candidate: string) => normalizedKey.startsWith(candidate),
    (normalizedKey: string, candidate: string) => normalizedKey.includes(candidate)
  ]) {
    const matches = index.entries.filter(({ normalizedKey }) => candidates.some(candidate => predicate(normalizedKey, candidate)));
    if (matches.length === 1) return { key: matches[0].key, ambiguous: false };
    if (matches.length > 1) return { ambiguous: true };
  }

  return { ambiguous: false };
};

export const createMappingIndex = (mapping: Readonly<Record<string, string>>) => new Map(
  Object.entries(mapping).map(([firstLeg, exchange]) => [normalizeBarcode(firstLeg), exchange])
);
