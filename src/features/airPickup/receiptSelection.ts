export function selectExistingRecordsById<T extends { id: string }>(records: T[], ids: string[]): T[] {
  return ids
    .map(id => records.find(record => record.id === id))
    .filter((record): record is T => Boolean(record));
}

/** Retain selected records across pages and refresh records when a page is revisited. */
export function mergeSelectedRecords<T extends { id: string }>(previous: T[], incoming: T[], selectedIds: string[]): T[] {
  const records = new Map([...previous, ...incoming].map(record => [record.id, record]));
  return [...new Set(selectedIds)].flatMap(id => records.has(id) ? [records.get(id)!] : []);
}

export function exchangeProgressPercent(processed: number, total: number): number {
  if (total <= 0 || processed <= 0) return 0;
  if (processed >= total) return 100;
  return Math.min(99.9, Math.floor(processed * 1000 / total) / 10);
}
