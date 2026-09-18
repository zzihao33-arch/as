import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { useWarehouseSession } from '../session/WarehouseSessionProvider';
import { WarehouseApiError } from '../session/warehouseApi';
import { getLogNotifications, markLogsRead } from './api';
import { advanceNotification, initialNotification, type NotificationState } from './notificationState';
import { appAudioArbitrator } from '../audio/audioArbitration';
import './integration-logs.css';

interface LogNotifications {
  state: NotificationState; error: string | null; lastUpdated: number | null;
  audioReady: boolean; muted: boolean; toggleAudio: () => void;
  refresh: () => Promise<void>; acknowledge: (cursor: string) => Promise<void>;
}
const Context = createContext<LogNotifications | null>(null);
export function useIntegrationLogs() {
  const value = useContext(Context);
  if (!value) throw new Error('Integration logs provider missing');
  return value;
}
export function IntegrationLogsProvider({ children }: { children: ReactNode }) {
  const session = useWarehouseSession();
  const userId = session.session?.userId ?? '';
  const allowed = !!userId && session.hasPermission('integration_logs.view');
  return <NotificationScope key={`${userId}:${allowed}`} userId={userId} allowed={allowed}>{children}</NotificationScope>;
}
function NotificationScope({ userId, allowed, children }: { userId: string; allowed: boolean; children: ReactNode }) {
  const [state, setState] = useState(initialNotification);
  const stateRef = useRef(state);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<number | null>(null);
  const [audioReady, setAudioReady] = useState(false);
  const [muted, setMuted] = useState(false);
  const audio = useRef<AudioContext | null>(null);
  const alive = useRef(true);
  const blocked = useRef(false);
  const serial = useRef(0);
  const controllers = useRef(new Set<AbortController>());

  const unlockAudio = useCallback(async () => {
    if (!allowed || !alive.current) return;
    try {
      audio.current ??= new AudioContext();
      await audio.current.resume();
      if (alive.current) setAudioReady(audio.current.state === 'running');
    } catch { if (alive.current) setAudioReady(false); }
  }, [allowed]);

  const play = useCallback(() => {
    const ctx = audio.current;
    if (muted || ctx?.state !== 'running') return;
    // Coalesce across tabs of this account as well as within each poll loop.
    const now = Date.now();
    if (!appAudioArbitrator.reserve('notification', now, 350)) return;
    try {
      const key = `cmhub:push-log-sound:${userId}`;
      const last = Number(localStorage.getItem(key) ?? '0');
      if (now - last < 15_000) return;
      localStorage.setItem(key, String(now));
    } catch { /* Sound also has an in-memory merge window. */ }
    try {
      const gain = ctx.createGain(); const tone = ctx.createOscillator();
      gain.gain.setValueAtTime(0.0001, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.10, ctx.currentTime + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.28);
      tone.frequency.setValueAtTime(784, ctx.currentTime);
      tone.frequency.setValueAtTime(1046, ctx.currentTime + 0.12);
      tone.connect(gain); gain.connect(ctx.destination); tone.start(); tone.stop(ctx.currentTime + 0.30);
      tone.onended = () => { tone.disconnect(); gain.disconnect(); };
    } catch { setAudioReady(false); }
  }, [muted, userId]);

  const refresh = useCallback(async () => {
    if (!allowed || !alive.current || blocked.current) return;
    const sequence = ++serial.current;
    const controller = new AbortController(); controllers.current.add(controller);
    const timeout = window.setTimeout(() => controller.abort(), 10_000);
    try {
      const snapshot = await getLogNotifications(controller.signal);
      if (!alive.current || sequence !== serial.current) return;
      const result = advanceNotification(stateRef.current, snapshot, Date.now());
      stateRef.current = result.state; setState(result.state); setError(null); setLastUpdated(Date.now());
      if (result.notify) play();
    } catch (err) {
      if (!alive.current || sequence !== serial.current) return;
      if (err instanceof WarehouseApiError && [401, 403].includes(err.status)) blocked.current = true;
      setError(err instanceof Error && err.name !== 'AbortError' ? err.message : '日志连接超时，正在重试。');
    } finally { window.clearTimeout(timeout); controllers.current.delete(controller); }
  }, [allowed, play]);

  const acknowledge = useCallback(async (cursor: string) => {
    if (!allowed || !alive.current) return;
    const controller = new AbortController(); controllers.current.add(controller);
    try {
      await markLogsRead(cursor, controller.signal);
      if (alive.current) await refresh();
    } finally { controllers.current.delete(controller); }
  }, [allowed, refresh]);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false; serial.current += 1;
      controllers.current.forEach(c => c.abort()); controllers.current.clear();
      void audio.current?.close(); audio.current = null;
    };
  }, []);
  useEffect(() => {
    if (!allowed) return;
    let stopped = false; let timer: number;
    const poll = async () => { await refresh(); if (!stopped) timer = window.setTimeout(() => void poll(), 5000); };
    void poll();
    return () => { stopped = true; window.clearTimeout(timer); };
  }, [allowed, refresh]);
  useEffect(() => {
    if (!allowed) return;
    const unlock = () => { void unlockAudio(); };
    window.addEventListener('pointerdown', unlock, { once: true });
    window.addEventListener('keydown', unlock, { once: true });
    return () => { window.removeEventListener('pointerdown', unlock); window.removeEventListener('keydown', unlock); };
  }, [allowed, unlockAudio]);
  const toggleAudio = () => { if (!audioReady) { setMuted(false); void unlockAudio(); } else setMuted(value => !value); };
  return <Context.Provider value={{ state, error, lastUpdated, audioReady, muted, toggleAudio, refresh, acknowledge }}>{children}</Context.Provider>;
}

export function PushLogUnreadBadge() {
  const { state } = useIntegrationLogs();
  return state.unreadCount > 0 ? <span className="push-log-nav-badge" aria-label={`${state.unreadCount} 条未读推送`}>{state.unreadCount > 99 ? '99+' : state.unreadCount}</span> : null;
}
