export interface NotificationSnapshot { cursor: string; readCursor: string; unreadCount: number }
export interface NotificationState extends NotificationSnapshot { initialized: boolean; lastNotificationAt: number | null }
export function initialNotification(): NotificationState { return { cursor: '0', readCursor: '0', unreadCount: 0, initialized: false, lastNotificationAt: null }; }
export function normalizeCursor(value: string): string {
  if (!/^(0|[1-9]\d{0,19})$/.test(value)) throw new Error('Invalid notification cursor');
  return value;
}
export function advanceNotification(state: NotificationState, snapshot: NotificationSnapshot, now: number): {state: NotificationState; notify: boolean} {
  const cursor = BigInt(normalizeCursor(snapshot.cursor));
  const read = BigInt(normalizeCursor(snapshot.readCursor));
  if (cursor < BigInt(state.cursor) || read < BigInt(state.readCursor)) return { state, notify: false };
  const notify = state.initialized && cursor > BigInt(state.cursor) && snapshot.unreadCount > 0
    && (state.lastNotificationAt === null || now - state.lastNotificationAt >= 15_000);
  return { state: { ...snapshot, initialized: true, lastNotificationAt: notify ? now : state.lastNotificationAt }, notify };
}
