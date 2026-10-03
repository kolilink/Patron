import React from 'react';
import type { ReactNode } from 'react';
import type { ViewStyle } from 'react-native';
import { SafeAreaView, type Edge } from 'react-native-safe-area-context';
import { useTheme } from '@/src/theme';
import { useAuthStore } from '@/stores/auth';
import { useSyncStore } from '@/stores/sync';

interface ScreenProps {
  children: ReactNode;
  /**
   * Tab-bar screen (Accueil/Catalogue/Vendre/Plus) — semantic marker only
   * now, no different bottom padding from a default screen. Content on
   * these screens is meant to extend the full safe-area height and scroll
   * underneath the floating tab bar, the same way Robinhood's does, rather
   * than stopping short at a reserved gap sized for the bar — that reserved
   * gap was tried and explicitly rejected (see the removed
   * FLOATING_TAB_BAR_CLEARANCE usage below, and the "Floating tab bar"
   * section of CLAUDE.md for the full back-and-forth). Genuinely
   * interactive fixed elements that must never render under the bar
   * (vendre.tsx's cart checkout panel, the Catalogue/Vendre FABs) still add
   * FLOATING_TAB_BAR_CLEARANCE to their own bottom offset directly — that
   * constant still exists and is still correct for those, only ordinary
   * scrollable page content stopped reserving it.
   */
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
  const syncLineVisible = useSyncStore(s => s.pendingCount > 0);

  // DemoBanner and SyncStatusLine (both mounted above <Stack/> in
  // (app)/_layout.tsx, outside any Screen) each already consume insets.top for
  // themselves when visible — don't add it again here or every screen
  // underneath gets a double gap between the header and its own content. Only
  // applies to the default edge logic; an explicit `edges` prop always takes
  // full precedence.
  //
  // The sync line is silent when online (returns null — zero height), so the
  // top inset is dropped only while one of those two strips is actually
  // rendering above the Stack (demo banner, or pending sync items). When
  // neither is visible, the screen keeps insets.top so its own first content
  // clears the status bar / Dynamic Island — no dead space, no overlap. `tab`
  // adds no extra bottom padding beyond the real OS safe area (content is
  // meant to sit underneath the floating pill and reveal itself on scroll —
  // see the prop's doc comment); the top inset is now governed solely by
  // header visibility.
  const defaultEdges: Edge[] = ['top', 'bottom'];
  const resolvedEdges: Edge[] = edges ?? (
    (isDemoMode || syncLineVisible) ? defaultEdges.filter((e): e is Edge => e !== 'top') : defaultEdges
  );

  return (
    <SafeAreaView
      style={[
        { flex: 1, backgroundColor: palette.background },
        style,
      ]}
      edges={resolvedEdges}
    >
      {children}
    </SafeAreaView>
  );
}
