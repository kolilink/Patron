import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { useColorScheme } from 'react-native';
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
  const systemScheme = useColorScheme();
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

  return (
    <ThemeContext.Provider value={{ palette, colorScheme, resolvedScheme, setColorScheme }}>
      <StatusBar style={resolvedScheme === 'dark' ? 'light' : 'dark'} />
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme(): ThemeContextValue {
  return useContext(ThemeContext);
}

export type { Palette };
