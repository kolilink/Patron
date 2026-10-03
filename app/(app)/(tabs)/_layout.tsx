import { useEffect } from 'react';
import { Tabs } from 'expo-router';
import { router } from 'expo-router';
import type { BottomTabBarProps } from '@react-navigation/bottom-tabs';
import { Ionicons } from '@expo/vector-icons';
import { useAuthStore } from '@/stores/auth';
import { useChatStore } from '@/stores/chat';
import { spacing } from '@/src/theme';
import { FloatingTabBar, type FloatingTabItem } from '@/src/components/ui/FloatingTabBar';
import { trackEvent } from '@/lib/analytics';

// ─────────────────────────────────────────────────────────────────────────────
// Floating tab bar — Material 3 style (see src/components/ui/FloatingTabBar.tsx
// for the bar itself: sliding violet indicator, per-platform glass tiers,
// press micro-interaction, reduce-motion, keyboard-aware). This file is the
// wiring layer only: which routes are visible, what each tab is called, and
// how a tab press maps back onto react-navigation.
//
// History: this layout has gone through many iterations of hand-rolled bar
// geometry (see CLAUDE.md "Floating tab bar" — centering, hidden-tab handling,
// circle sizing). The actual bar chrome now lives in one reusable component so
// those lessons are captured once, not re-derived per edit.
// ─────────────────────────────────────────────────────────────────────────────

type IoniconName = React.ComponentProps<typeof Ionicons>['name'];

// Same 4 tabs, same order, same icons as before — outline inactive → filled
// active (spec §4). Keyed by route name so the visible-set filter below can
// resolve any subset (investisseur sees fewer tabs).
const TAB_DEFS: Record<string, { label: string; outline: IoniconName; filled: IoniconName }> = {
  index: { label: 'Accueil', outline: 'home-outline', filled: 'home' },
  catalogue: { label: 'Produits', outline: 'grid-outline', filled: 'grid' },
  vendre: { label: 'Vendre', outline: 'cart-outline', filled: 'cart' },
  plus: { label: 'Moi', outline: 'person-outline', filled: 'person' },
};

// Content-hugging bar width, computed per visible tab count (not hardcoded to
// 4 — investisseur/vendeur see fewer tabs and the bar hugs whatever shows).
const TAB_CIRCLE_SIZE = 48;
function barWidthFor(tabCount: number) {
  return tabCount * TAB_CIRCLE_SIZE + (tabCount - 1) * spacing[6] + 2 * spacing[4];
}

function CustomTabBar({ state, descriptors, navigation, insets }: BottomTabBarProps) {
  // Hidden-route detection must read `tabBarItemStyle.display` — expo-router's
  // href-shortcut transform strips `href` from what `descriptors` sees, but it
  // sets `tabBarItemStyle: { display: 'none' }` on hidden routes and does NOT
  // strip that (see the fifteenth follow-up in CLAUDE.md).
  const visibleRoutes = state.routes.filter(route => {
    const itemStyle = descriptors[route.key].options.tabBarItemStyle as { display?: string } | undefined;
    return itemStyle?.display !== 'none';
  });

  const items: FloatingTabItem[] = visibleRoutes.map(route => {
    const def = TAB_DEFS[route.name];
    return {
      key: route.key,
      label: def?.label ?? route.name,
      outline: def?.outline ?? 'ellipse-outline',
      filled: def?.filled ?? 'ellipse',
    };
  });

  const activeRouteKey = state.routes[state.index]?.key;
  const activeIndex = Math.max(0, visibleRoutes.findIndex(r => r.key === activeRouteKey));

  const onSelect = (visibleIndex: number) => {
    const route = visibleRoutes[visibleIndex];
    if (!route) return;
    const routeIndex = state.routes.findIndex(r => r.key === route.key);
    const focused = state.index === routeIndex;
    const event = navigation.emit({ type: 'tabPress', target: route.key, canPreventDefault: true });
    if (!focused && !event.defaultPrevented) {
      navigation.navigate(route.name, route.params as never);
    }
  };

  return (
    <FloatingTabBar
      items={items}
      index={activeIndex}
      onSelect={onSelect}
      bottomInset={insets.bottom}
      width={barWidthFor(visibleRoutes.length)}
    />
  );
}

export default function TabsLayout() {
  const session = useAuthStore(s => s.session);
  const loading = useAuthStore(s => s.loading);
  const removedBusinessName = useAuthStore(s => s.removedBusinessName);
  const { boutiqueRoom, load: loadChat } = useChatStore();

  useEffect(() => {
    // If membership was removed, the (app)/_layout.tsx handles the redirect.
    // Don't race it by also redirecting to welcome.
    if (!loading && !session?.activeBusiness && !removedBusinessName) {
      router.replace('/(welcome)/');
    }
  }, [loading, session?.activeBusiness, removedBusinessName]);

  useEffect(() => {
    const bId = session?.activeBusiness?.id;
    const uId = session?.user?.id;
    if (!bId || !uId || boutiqueRoom !== null) return;
    loadChat(bId, uId);
  }, [session?.activeBusiness?.id, session?.user?.id, boutiqueRoom]);

  if (!session?.activeBusiness) return null;

  const role = session.activeMembership?.role;
  const isInvestisseur = role === 'investisseur';
  const isVendeur = role === 'vendeur';

  const bId = session.activeBusiness?.id ?? null;
  const uId = session.user.id;

  return (
    <Tabs
      initialRouteName={isVendeur ? 'vendre' : 'index'}
      screenListeners={{
        focus: (e) => {
          const tab = e.target?.split('-')[0] ?? 'unknown';
          trackEvent('tab_viewed', bId, uId, { tab });
        },
      }}
      tabBar={(props) => <CustomTabBar {...props} />}
      screenOptions={{
        headerShown: false,
      }}
    >
      <Tabs.Screen name="index" options={{ title: 'Accueil' }} />
      <Tabs.Screen
        name="catalogue"
        options={{
          title: 'Produits',
          href: isInvestisseur || isVendeur ? null : undefined,
        }}
      />
      <Tabs.Screen
        name="vendre"
        options={{
          title: 'Vendre',
          href: isInvestisseur ? null : undefined,
        }}
      />
      <Tabs.Screen name="caisse" options={{ href: null }} />
      <Tabs.Screen name="plus" options={{ title: 'Moi' }} />
    </Tabs>
  );
}
