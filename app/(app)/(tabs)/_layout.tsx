import { useEffect } from 'react';
import { View } from 'react-native';
import { Tabs } from 'expo-router';
import { router } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useAuthStore } from '@/stores/auth';
import { useChatStore } from '@/stores/chat';
import { colors, useTheme } from '@/src/theme';
import { Text } from '@/src/components/ui/Text';
import { generateFallbackName } from '@/lib/id';

type IoniconName = React.ComponentProps<typeof Ionicons>['name'];

const ROLE_COLORS_LIGHT: Record<string, string> = {
  administrateur: colors.role.administrateur,
  manager:        colors.role.manager,
  vendeur:        colors.role.vendeur,
  investisseur:   colors.role.investisseur,
};

const ROLE_COLORS_DARK: Record<string, string> = {
  administrateur: '#818CF8',
  manager:        '#38BDF8',
  vendeur:        '#4ADE80',
  investisseur:   '#FCD34D',
};

function ProfileTabIcon({ focused, size }: { focused: boolean; size: number }) {
  const session = useAuthStore(s => s.session);
  const { palette, resolvedScheme } = useTheme();
  const role = session?.activeMembership?.role ?? '';
  const name = session?.user?.name || generateFallbackName(session?.user?.id ?? '');
  const initial = name[0]?.toUpperCase() ?? '?';
  const roleColor = (resolvedScheme === 'dark' ? ROLE_COLORS_DARK : ROLE_COLORS_LIGHT)[role] ?? palette.primary;

  const sz = size + 16;
  return (
    <View style={{
      width: sz, height: sz, borderRadius: sz / 2,
      backgroundColor: roleColor + '25',
      alignItems: 'center', justifyContent: 'center',
      opacity: focused ? 1 : 0.55,
    }}>
      <Text style={{ fontSize: sz * 0.46, fontWeight: '700', color: roleColor, lineHeight: sz * 0.55 }}>
        {initial}
      </Text>
    </View>
  );
}

function tabIcon(name: IoniconName, activeName: IoniconName) {
  return ({ color, size, focused }: { color: string; size: number; focused: boolean }) => (
    <Ionicons name={focused ? activeName : name} size={size} color={color} />
  );
}

export default function TabsLayout() {
  const { palette } = useTheme();
  const insets = useSafeAreaInsets();
  const session = useAuthStore(s => s.session);
  const loading = useAuthStore(s => s.loading);
  const removedBusinessName = useAuthStore(s => s.removedBusinessName);

  useEffect(() => {
    // If membership was removed, the (app)/_layout.tsx handles the redirect.
    // Don't race it by also redirecting to welcome.
    if (!loading && !session?.activeBusiness && !removedBusinessName) {
      router.replace('/(welcome)/');
    }
  }, [loading, session?.activeBusiness, removedBusinessName]);

  if (!session?.activeBusiness) return null;

  const role = session.activeMembership?.role;
  const isInvestisseur = role === 'investisseur';
  const isVendeur = role === 'vendeur';

  const { boutiqueRoom, load: loadChat } = useChatStore();

  useEffect(() => {
    const bId = session.activeBusiness?.id;
    const uId = session.user.id;
    if (!bId || !uId || boutiqueRoom !== null) return;
    loadChat(bId, uId);
  }, [session.activeBusiness?.id, session.user.id]);

  return (
    <Tabs
      initialRouteName={isVendeur ? 'vendre' : 'index'}
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: palette.primary,
        tabBarInactiveTintColor: '#8E8E93',
        tabBarLabelStyle: {
          fontSize: 11,
          fontWeight: '500',
          marginTop: 4,
        },
        tabBarStyle: {
          backgroundColor: palette.surface,
          borderTopColor: palette.border,
          borderTopWidth: 1,
          height: 66 + insets.bottom,
          paddingBottom: insets.bottom || 8,
        },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: 'Accueil',
          tabBarIcon: tabIcon('home-outline', 'home'),
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
          title: 'Plus',
          tabBarIcon: ({ focused, size }) => <ProfileTabIcon focused={focused} size={size} />,
          tabBarLabel: () => <View style={{ height: 13, marginTop: 4 }} />,
        }}
      />
    </Tabs>
  );
}
