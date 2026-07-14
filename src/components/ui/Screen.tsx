import React from 'react';
import type { ReactNode } from 'react';
import type { ViewStyle } from 'react-native';
import { SafeAreaView, type Edge } from 'react-native-safe-area-context';
import { useTheme } from '@/src/theme';
import { useAuthStore } from '@/stores/auth';

interface ScreenProps {
  children: ReactNode;
  /** Tab-bar screen — protects top edge only (bottom handled by the tab bar). */
  tab?: boolean;
  /** Extra styles merged on top of the defaults (flex:1, backgroundColor). */
  style?: ViewStyle;
  /** Escape hatch — overrides the tab/default edge logic entirely. */
  edges?: Edge[];
}

/**
 * Drop-in replacement for SafeAreaView as a screen root.
 * Default: edges=['top','bottom']. Pass `tab` for screens inside the tab bar.
 */
export function Screen({ children, tab = false, style, edges }: ScreenProps) {
  const { palette } = useTheme();
  const isDemoMode = useAuthStore(s => s.session?.isDemoMode ?? false);

  // DemoBanner already consumes insets.top — don't add it again here or you
  // get a double-gap (black bar). Only applies to the default edge logic;
  // an explicit `edges` prop always takes full precedence.
  const defaultEdges: Edge[] = tab ? ['top'] : ['top', 'bottom'];
  const resolvedEdges: Edge[] = edges ?? (
    isDemoMode ? defaultEdges.filter((e): e is Edge => e !== 'top') : defaultEdges
  );

  return (
    <SafeAreaView
      style={[{ flex: 1, backgroundColor: palette.background }, style]}
      edges={resolvedEdges}
    >
      {children}
    </SafeAreaView>
  );
}
