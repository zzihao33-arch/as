export const ATTENDANCE_TIME_ZONE = 'America/New_York';

const workDateFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: ATTENDANCE_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

export function attendanceWorkDate(value: string | number | Date = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const parts = Object.fromEntries(
    workDateFormatter.formatToParts(date).map(part => [part.type, part.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export function attendanceElapsedMinutes(clockInAt: string | null, clockOutAt: string | null, now: Date = new Date()) {
  if (!clockInAt) return 0;
  const start = new Date(clockInAt).getTime();
  const end = clockOutAt ? new Date(clockOutAt).getTime() : now.getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return 0;
  return Math.max(1, Math.round((end - start) / 60_000));
}

export function formatAttendanceDecimalHours(minutes: number) {
  const wholeMinutes = Number.isFinite(minutes) ? Math.max(0, Math.round(minutes)) : 0;
  return `${(wholeMinutes / 60).toFixed(2)} h`;
}

export function isOpenAttendanceWithin(clockInAt: string | null, now: Date = new Date(), maximumHours = 18) {
  if (!clockInAt) return false;
  const elapsed = now.getTime() - new Date(clockInAt).getTime();
  return Number.isFinite(elapsed) && elapsed >= 0 && elapsed <= maximumHours * 60 * 60_000;
}
