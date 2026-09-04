import { useEffect, useRef } from 'react';
import { Animated, Pressable, View } from 'react-native';
import { Tabs } from 'expo-router';
import { router } from 'expo-router';
import type { BottomTabBarProps } from '@react-navigation/bottom-tabs';
import { Ionicons } from '@expo/vector-icons';
import { useAuthStore } from '@/stores/auth';
import { useChatStore } from '@/stores/chat';
import {
  useTheme, radius, spacing,
  FLOATING_TAB_BAR_HEIGHT, FLOATING_TAB_BAR_GAP,
} from '@/src/theme';
import { trackEvent } from '@/lib/analytics';

// Blur + tint was tried and dropped the same day (see CLAUDE.md's "Floating
// tab bar" section for the full reasoning) — on this app's flat, mostly
// monochrome-gray screens there's nothing behind the bar with enough visual
// variety to blur into, so it never read as real glass, just an ambiguous
// half-opaque wash. A clean opaque fill + a real shadow is the honest
// choice for this app's actual design language, not a lesser fallback.
// 48 — back up from 36 once the underlying architecture (centering, hidden-
// tab handling, spacing) was confirmed correct: "now expand it," a request
// to scale the whole design up now that it's structurally right, not a
// reversal of the earlier "too big" complaints (those were about the *bar*
// growing around a fixed circle, making it bulkier without the circle
// itself growing — see the 60→64→52 bar-height history below). 48 is also,
// not incidentally, Apple's HIG minimum tap-target size.
const TAB_CIRCLE_SIZE = 48;

// Content-hugging, not a screen-relative inset — widening left/right insets
// (two follow-ups) still stretches the bar to fill whatever's left of the
// screen, which is the opposite of "wraps just the icons." Derived from
// real numbers, not picked by eye: N tabs × TAB_CIRCLE_SIZE (36) + (N-1)
// gaps between them (spacing[6], 24) + 2 edges (spacing[4], 16 — this app's
// standard screen-padding value everywhere else). Computed per visible tab
// count, not hardcoded to 4 — investisseur/vendeur see fewer tabs (2/3), and
// the bar should hug however many are actually showing, not assume 4.
function barWidthFor(tabCount: number) {
  return tabCount * TAB_CIRCLE_SIZE + (tabCount - 1) * spacing[6] + 2 * spacing[4];
}

// A fully custom tab bar, not `tabBarStyle`/`tabBarItemStyle`/
// `tabBarBackground` on <Tabs>'s screenOptions — three follow-ups tried
// centering this via those props (a full-width transparent box with
// `justifyContent: 'center'`, un-stretched fixed-width items, a separately
// flex-centered background) and it still rendered flush left, not centered.
// Never fully diagnosed which specific internal behavior caused it — most
// likely react-navigation's actual tab-button row is an inner wrapper that
// `tabBarStyle`'s properties don't reach, meaning `justifyContent` set
// there was silently not applying to the real row at all. Rather than
// guess a fourth variant against an API surface that's now failed three
// times, this renders the whole bar directly: one component, full control,
// no dependency on any undocumented react-navigation-internal layout
// behavior. Hides routes the same way expo-router's own Tabs does, since a
// custom `tabBar` bypasses its built-in hiding mechanism entirely —
// `state.routes` here includes every registered screen regardless of role,
// `caisse` (always hidden) included.
//
// NOT via `options.href` — expo-router's own href-shortcut transform
// (`TabsClient.js`) destructures `href` OUT of the options object it hands
// to react-navigation (`const { href, ...options } = screen.options`), so by
// the time it reaches `descriptors` here, `.href` is always `undefined`
// regardless of what was authored — checking it always evaluated to
// "visible." That transform also sets `tabBarItemStyle: { display: 'none' }`
// on hidden routes, which is NOT stripped — checking *that* instead is what
// actually reads whether expo-router marked this route hidden. Missed this
// asymmetry (what the transform sets vs. what it silently removes) the
// first time and shipped `caisse` as an always-visible 5th tab — it never
// showed an icon (no tabBarIcon set for it), but it still claimed a slot in
// the row, which is exactly what pushed the last real tab out to the far
// right with a gap before it.
function CustomTabBar({ state, descriptors, navigation, insets }: BottomTabBarProps) {
  const { palette } = useTheme();
  const visibleRoutes = state.routes.filter(route => {
    const itemStyle = descriptors[route.key].options.tabBarItemStyle as { display?: string } | undefined;
    return itemStyle?.display !== 'none';
  });
  const barWidth = barWidthFor(visibleRoutes.length);
  const itemWidth = barWidth / visibleRoutes.length;

  return (
    <View
      pointerEvents="box-none"
      style={{ position: 'absolute', left: 0, right: 0, bottom: insets.bottom + FLOATING_TAB_BAR_GAP, alignItems: 'center' }}
    >
      {/* No shadow — reported directly as an unwanted rectangle showing
          behind the pill. The pill is just its own white fill; nothing
          else renders behind it. */}
      <View
        style={{
          flexDirection: 'row',
          width: barWidth,
          height: FLOATING_TAB_BAR_HEIGHT,
          borderRadius: radius.full,
          backgroundColor: palette.surfaceElevated,
        }}
      >
        {visibleRoutes.map(route => {
          const { options } = descriptors[route.key];
          const routeIndex = state.routes.findIndex(r => r.key === route.key);
          const focused = state.index === routeIndex;
          // Neutral dark, not palette.primary — reference apps never color
          // the nav icon itself; the selected circle (TabIconChip, inside
          // each tabBarIcon below) carries "this is active," so the icon
          // only needs to read as "darker = selected, lighter gray = not."
          const color = focused ? palette.textPrimary : palette.tabBarInactive;
          const onPress = () => {
            const event = navigation.emit({ type: 'tabPress', target: route.key, canPreventDefault: true });
            if (!focused && !event.defaultPrevented) {
              navigation.navigate(route.name, route.params as never);
            }
          };
          return (
            <Pressable
              key={route.key}
              onPress={onPress}
              style={{ width: itemWidth, height: FLOATING_TAB_BAR_HEIGHT, alignItems: 'center', justifyContent: 'center' }}
            >
              {options.tabBarIcon?.({ focused, color, size: TAB_ICON_SIZE })}
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

// Reversed the previous follow-up (which removed this background entirely)
// — a clean, unobscured screenshot of Robinhood's search tab settled it: the
// active icon does sit on a small gray rounded-rect background, it's just
// tight around the icon rather than stretched to fill its tab slot's full
// width, which is what made it hard to spot in the earlier, lower-contrast
// screenshots. So the premise wasn't wrong — the shape/proportions were, the
// same class of mistake as the earlier size/color rounds, not a reason to
// remove the element outright. Kept genuinely small (TAB_CIRCLE_SIZE, not
// the tab's full slot width) so it stays a tight chip around the icon.
function TabIconChip({ focused, children }: { focused: boolean; children: React.ReactNode }) {
  const { palette } = useTheme();
  return (
    <View
      style={{
        width: TAB_CIRCLE_SIZE, height: TAB_CIRCLE_SIZE,
        borderRadius: TAB_CIRCLE_SIZE / 2,
        alignItems: 'center', justifyContent: 'center',
        backgroundColor: focused ? palette.border : 'transparent',
      }}
    >
      {children}
    </View>
  );
}

type IoniconName = React.ComponentProps<typeof Ionicons>['name'];

// 24 — scaled up alongside TAB_CIRCLE_SIZE (36→48), keeping the same ~1:2
// glyph-to-circle ratio rather than letting the icon stay small inside a
// now-bigger circle.
const TAB_ICON_SIZE = 24;

// Home only — a small spring "pop" the instant the tab becomes active,
// instead of the flat instant glyph/color swap every other tab still uses.
// Scoped deliberately to this one icon (not a shared helper) so the other
// three tabs are completely untouched by this change.
function HomeTabIcon({ color, focused }: { color: string; focused: boolean }) {
  const scale = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    if (focused) {
      scale.setValue(0.75);
      Animated.spring(scale, { toValue: 1, useNativeDriver: true, bounciness: 14, speed: 16 }).start();
    }
  }, [focused, scale]);

  return (
    <TabIconChip focused={focused}>
      <Animated.View style={{ transform: [{ scale }] }}>
        <Ionicons name={focused ? 'home' : 'home-outline'} size={TAB_ICON_SIZE} color={color} />
      </Animated.View>
    </TabIconChip>
  );
}

function tabIcon(name: IoniconName, activeName: IoniconName) {
  return ({ color, focused }: { color: string; size: number; focused: boolean }) => (
    <TabIconChip focused={focused}>
      <Ionicons name={focused ? activeName : name} size={TAB_ICON_SIZE} color={color} />
    </TabIconChip>
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
      <Tabs.Screen
        name="index"
        options={{
          title: 'Accueil',
          tabBarIcon: ({ color, focused }) => <HomeTabIcon color={color} focused={focused} />,
        }}
      />
      <Tabs.Screen
        name="catalogue"
        options={{
          title: 'Produits',
          href: isInvestisseur || isVendeur ? null : undefined,
          tabBarIcon: tabIcon('grid-outline', 'grid'),
        }}
      />
      <Tabs.Screen
        name="vendre"
        options={{
          title: 'Vendre',
          href: isInvestisseur ? null : undefined,
          tabBarIcon: tabIcon('cart-outline', 'cart'),
        }}
      />
      <Tabs.Screen
        name="caisse"
        options={{ href: null }}
      />
      <Tabs.Screen
        name="plus"
        options={{
          title: 'Moi',
          // A generic person icon, not a per-user colored initial avatar —
          // requested directly, to match Robinhood's profile tab and read as
          // uniform with the other three icon-only tabs regardless of which
          // account is signed in. Tapping still opens the same Plus/profile
          // screen unchanged; only the glyph itself changed.
          tabBarIcon: tabIcon('person-outline', 'person'),
        }}
      />
    </Tabs>
  );
}
