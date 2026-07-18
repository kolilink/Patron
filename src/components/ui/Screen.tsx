import React from 'react';
import type { ReactNode } from 'react';
import type { ViewStyle } from 'react-native';
import { SafeAreaView, type Edge } from 'react-native-safe-area-context';
import { useTheme } from '@/src/theme';
import { useAuthStore } from '@/stores/auth';
import { useSyncStore } from '@/stores/sync';

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
  const hasPendingSync = useSyncStore(s => s.pendingCount > 0);

  // DemoBanner and SyncBanner (both mounted above <Stack/> in (app)/_layout.tsx,
  // outside any Screen) each already consume insets.top for themselves when
  // visible — don't add it again here or every screen underneath gets a
  // double gap between the banner and its own content. Only applies to the
  // default edge logic; an explicit `edges` prop always takes full precedence.
  const defaultEdges: Edge[] = tab ? ['top'] : ['top', 'bottom'];
  const resolvedEdges: Edge[] = edges ?? (
    (isDemoMode || hasPendingSync) ? defaultEdges.filter((e): e is Edge => e !== 'top') : defaultEdges
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
