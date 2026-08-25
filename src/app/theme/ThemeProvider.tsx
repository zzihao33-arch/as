import { createContext, useCallback, useContext, useEffect, useMemo, useState, type PropsWithChildren } from 'react';

export type ThemeMode = 'auto' | 'light' | 'dark';
export type ResolvedTheme = Exclude<ThemeMode, 'auto'>;

interface ThemeContextValue {
  mode: ThemeMode;
  resolvedTheme: ResolvedTheme;
  setMode: (mode: ThemeMode) => void;
}

const THEME_STORAGE_KEY = 'cmhub-theme-mode';
const SYSTEM_THEME_QUERY = '(prefers-color-scheme: dark)';

const ThemeContext = createContext<ThemeContextValue | null>(null);

function readStoredMode(): ThemeMode {
  if (typeof window === 'undefined') return 'auto';

  const value = window.localStorage.getItem(THEME_STORAGE_KEY);
  return value === 'light' || value === 'dark' || value === 'auto' ? value : 'auto';
}

function readSystemDarkMode() {
  return typeof window !== 'undefined' && window.matchMedia(SYSTEM_THEME_QUERY).matches;
}

function resolveTheme(mode: ThemeMode, systemIsDark: boolean): ResolvedTheme {
  return mode === 'auto' ? (systemIsDark ? 'dark' : 'light') : mode;
}

export function ThemeProvider({ children }: PropsWithChildren) {
  const [mode, setModeState] = useState<ThemeMode>(readStoredMode);
  const [systemIsDark, setSystemIsDark] = useState(readSystemDarkMode);
  const resolvedTheme = resolveTheme(mode, systemIsDark);

  useEffect(() => {
    const mediaQuery = window.matchMedia(SYSTEM_THEME_QUERY);
    const updateSystemTheme = (event: MediaQueryListEvent) => setSystemIsDark(event.matches);

    setSystemIsDark(mediaQuery.matches);
    mediaQuery.addEventListener('change', updateSystemTheme);
    return () => mediaQuery.removeEventListener('change', updateSystemTheme);
  }, []);

  useEffect(() => {
    window.localStorage.setItem(THEME_STORAGE_KEY, mode);
  }, [mode]);

  useEffect(() => {
    const root = document.documentElement;
    root.dataset.theme = resolvedTheme;
    root.dataset.themeMode = mode;

    if (resolvedTheme === 'dark') {
      document.body.setAttribute('arco-theme', 'dark');
    } else {
      document.body.removeAttribute('arco-theme');
    }
  }, [mode, resolvedTheme]);

  const setMode = useCallback((nextMode: ThemeMode) => setModeState(nextMode), []);
  const value = useMemo(() => ({ mode, resolvedTheme, setMode }), [mode, resolvedTheme, setMode]);

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  const context = useContext(ThemeContext);
  if (!context) throw new Error('useTheme must be used inside ThemeProvider');
  return context;
}
