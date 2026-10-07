import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { AppState, Appearance, useColorScheme } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { getKV, setKV } from '@/lib/db';
import { paletteLight, paletteDark } from './colors';
import type { Palette } from './colors';

export type ColorScheme = 'light' | 'dark' | 'system';

interface ThemeContextValue {
  palette: Palette;
  colorScheme: ColorScheme;
  resolvedScheme: 'light' | 'dark';
  setColorScheme: (scheme: ColorScheme) => void;
}

const ThemeContext = createContext<ThemeContextValue>({
  palette: paletteLight,
  colorScheme: 'system',
  resolvedScheme: 'light',
  setColorScheme: () => {},
});

const THEME_KEY = 'app_theme_preference';

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const liveSystemScheme = useColorScheme();
  // iOS flips the app's appearance light↔dark while the app is going to the
  // background (it snapshots the app-switcher card in BOTH modes). Following
  // those flips re-themed the whole tree twice per background/foreground —
  // wrong-theme frames, doubled blur/tab-bar renders, and a bad frame baked
  // into the switcher snapshot. So the system scheme is only accepted while
  // the app is 'active', and re-synced once on return.
  const [systemScheme, setSystemScheme] = useState(liveSystemScheme);
  useEffect(() => {
    if (AppState.currentState === 'active') setSystemScheme(liveSystemScheme);
  }, [liveSystemScheme]);
  useEffect(() => {
    const sub = AppState.addEventListener('change', next => {
      if (next === 'active') setSystemScheme(Appearance.getColorScheme());
    });
    return () => sub.remove();
  }, []);
  const [colorScheme, setColorSchemeState] = useState<ColorScheme>('system');

  useEffect(() => {
    getKV(THEME_KEY).then(saved => {
      if (saved === 'light' || saved === 'dark' || saved === 'system') {
        setColorSchemeState(saved);
      }
    });
  }, []);

  const resolvedScheme: 'light' | 'dark' = colorScheme === 'system'
    ? (systemScheme === 'dark' ? 'dark' : 'light')
    : colorScheme;

  const palette = resolvedScheme === 'dark' ? paletteDark : paletteLight;

  const setColorScheme = useCallback((scheme: ColorScheme) => {
    setColorSchemeState(scheme);
    void setKV(THEME_KEY, scheme);
  }, []);

  const value = useMemo(
    () => ({ palette, colorScheme, resolvedScheme, setColorScheme }),
    [palette, colorScheme, resolvedScheme, setColorScheme],
  );

  return (
    <ThemeContext.Provider value={value}>
      <StatusBar style={resolvedScheme === 'dark' ? 'light' : 'dark'} />
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme(): ThemeContextValue {
  return useContext(ThemeContext);
}

export type { Palette };
