export function selectExistingRecordsById<T extends { id: string }>(records: T[], ids: string[]): T[] {
  return ids
    .map(id => records.find(record => record.id === id))
    .filter((record): record is T => Boolean(record));
}
