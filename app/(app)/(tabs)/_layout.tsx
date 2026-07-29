import { useEffect, useRef } from 'react';
import { Animated, View } from 'react-native';
import { Tabs } from 'expo-router';
import { router } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useAuthStore } from '@/stores/auth';
import { useChatStore } from '@/stores/chat';
import { useTheme, ROLE_COLORS as ROLE_COLORS_LIGHT, ROLE_COLORS_DARK } from '@/src/theme';
import { Text } from '@/src/components/ui/Text';
import { generateFallbackName } from '@/lib/id';
import { trackEvent } from '@/lib/analytics';

type IoniconName = React.ComponentProps<typeof Ionicons>['name'];

const TAB_ICON_SIZE = 26;

function ProfileTabIcon({ focused }: { focused: boolean }) {
  const session = useAuthStore(s => s.session);
  const { palette, resolvedScheme } = useTheme();
  const role = session?.activeMembership?.role ?? '';
  const name = session?.user?.name || generateFallbackName(session?.user?.id ?? '');
  const initial = name[0]?.toUpperCase() ?? '?';
  const roleColor = (resolvedScheme === 'dark' ? ROLE_COLORS_DARK : ROLE_COLORS_LIGHT)[role] ?? palette.primary;

  const circleSize = TAB_ICON_SIZE + 6;
  return (
    // Outer anchor locked to the same bounding box as Ionicons so flex row treats all tabs equally
    <View style={{ width: TAB_ICON_SIZE, height: TAB_ICON_SIZE, alignItems: 'center', justifyContent: 'center' }}>
      <View style={{
        width: circleSize, height: circleSize, borderRadius: circleSize / 2,
        backgroundColor: roleColor + '25',
        alignItems: 'center', justifyContent: 'center',
        opacity: focused ? 1 : 0.55,
      }}>
        <Text style={{
          fontSize: circleSize * 0.46,
          fontWeight: '700',
          color: roleColor,
          includeFontPadding: false,
          textAlignVertical: 'center',
        }}>
          {initial}
        </Text>
      </View>
    </View>
  );
}

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
    <Animated.View style={{ transform: [{ scale }] }}>
      <Ionicons name={focused ? 'home' : 'home-outline'} size={TAB_ICON_SIZE} color={color} />
    </Animated.View>
  );
}

function tabIcon(name: IoniconName, activeName: IoniconName) {
  return ({ color, focused }: { color: string; size: number; focused: boolean }) => (
    <Ionicons name={focused ? activeName : name} size={TAB_ICON_SIZE} color={color} />
  );
}

export default function TabsLayout() {
  const { palette } = useTheme();
  const insets = useSafeAreaInsets();
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
      screenOptions={{
        headerShown: false,
        tabBarShowLabel: false,
        tabBarActiveTintColor: palette.primary,
        tabBarInactiveTintColor: palette.tabBarInactive,
        tabBarStyle: {
          backgroundColor: palette.surface,
          borderTopColor: palette.border,
          borderTopWidth: 1,
          height: 44 + insets.bottom,
          paddingBottom: insets.bottom || 8,
        },
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
          tabBarIcon: ({ focused }) => <ProfileTabIcon focused={focused} />,
        }}
      />
    </Tabs>
  );
}
