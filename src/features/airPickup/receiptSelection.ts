export function selectExistingRecordsById<T extends { id: string }>(records: T[], ids: string[]): T[] {
  return ids
    .map(id => records.find(record => record.id === id))
    .filter((record): record is T => Boolean(record));
}

export function exchangeProgressPercent(processed: number, total: number): number {
  if (total <= 0 || processed <= 0) return 0;
  if (processed >= total) return 100;
  return Math.min(99.9, Math.floor(processed * 1000 / total) / 10);
}
