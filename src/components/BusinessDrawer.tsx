import { useEffect, useMemo, useState } from 'react';
import {
  Dimensions,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
} from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withTiming,
  runOnJS,
  interpolate,
  Extrapolation,
  Easing,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { Text } from '@/src/components/ui/Text';
import { colors, useTheme, spacing, radius, BUSINESS_AVATAR_PALETTE } from '@/src/theme';
import type { Palette } from '@/src/theme';
import { useAuthStore } from '@/stores/auth';
import { useSupportChatStore } from '@/stores/supportChat';
import { isFounderPhone } from '@/src/utils/founder';
import type { Role } from '@/src/types';

const DRAWER_WIDTH = Dimensions.get('window').width * 0.78;

// Plain eased timing, not a physics spring — a spring has velocity/mass and
// can overshoot the target and settle back (the back-and-forth wobble the
// user kept seeing even with overshootClamping). A timing curve has no
// velocity to overshoot with: it interpolates monotonically to the target
// every time. Shared by open, cancel-drag spring-back, and drag-confirmed close.
const DRAWER_EASE = Easing.out(Easing.cubic);
const DRAWER_OPEN_DURATION = 260;
const DRAWER_CLOSE_DURATION = 300;

const DRAWER_AVATAR_PALETTE = BUSINESS_AVATAR_PALETTE;

const ROLE_LABEL: Record<Role, string> = {
  administrateur: 'Gérant',
  manager: 'Manager',
  vendeur: 'Vendeur',
  investisseur: 'Investisseur',
};

function avatarColor(id: string) {
  return DRAWER_AVATAR_PALETTE[id.charCodeAt(0) % DRAWER_AVATAR_PALETTE.length];
}

export function BusinessDrawer() {
  const { palette } = useTheme();
  const styles = useMemo(() => makeStyles(palette), [palette]);

  const session = useAuthStore(s => s.session);
  const businessDrawerOpen = useAuthStore(s => s.businessDrawerOpen);
  const closeBusinessDrawer = useAuthStore(s => s.closeBusinessDrawer);
  const selectBusiness = useAuthStore(s => s.selectBusiness);
  const insets = useSafeAreaInsets();
  const isFounder = isFounderPhone(session?.user.phone);
  const founderUnreadTotal = useSupportChatStore(s => s.founderUnreadTotal);

  const translateX = useSharedValue(-DRAWER_WIDTH);
  const dragStartX = useSharedValue(-DRAWER_WIDTH);
  const [modalVisible, setModalVisible] = useState(false);
  const [search, setSearch] = useState('');

  useEffect(() => {
    if (businessDrawerOpen) {
      setSearch('');
      setModalVisible(true);
      translateX.value = withTiming(0, { duration: DRAWER_OPEN_DURATION, easing: DRAWER_EASE });
    } else {
      translateX.value = withTiming(-DRAWER_WIDTH, { duration: DRAWER_CLOSE_DURATION, easing: DRAWER_EASE }, (finished) => {
        if (finished) runOnJS(setModalVisible)(false);
      });
    }
  }, [businessDrawerOpen]);

  // Swipe-to-close: drag the open panel left. A quick flick (velocity) or a
  // drag past ~35% of the drawer width closes it; otherwise it springs back
  // open. Small activeOffsetX/failOffsetY thresholds mirror the swipe-to-reply
  // gesture in discussions.tsx so a simple tap or vertical scroll inside the
  // list isn't mistaken for a close-drag.
  const closeDragGesture = Gesture.Pan()
    .activeOffsetX([-10, 10])
    .failOffsetY([-15, 15])
    .onStart(() => {
      dragStartX.value = translateX.value;
    })
    .onUpdate((e) => {
      if (e.translationX < 0) {
        translateX.value = Math.max(-DRAWER_WIDTH, dragStartX.value + e.translationX);
      }
    })
    .onEnd((e) => {
      const shouldClose = translateX.value < -DRAWER_WIDTH * 0.35 || e.velocityX < -600;
      if (shouldClose) {
        runOnJS(closeBusinessDrawer)();
      } else {
        translateX.value = withTiming(0, { duration: 200, easing: DRAWER_EASE });
      }
    });

  const drawerAnimStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: translateX.value }],
  }));

  const backdropAnimStyle = useAnimatedStyle(() => ({
    opacity: interpolate(translateX.value, [-DRAWER_WIDTH, 0], [0, 1], Extrapolation.CLAMP),
  }));

  const memberships = session?.memberships ?? [];
  const activeBusiness = session?.activeBusiness;

  const filtered = memberships.filter(m =>
    (m.business as { name?: string })?.name?.toLowerCase().includes(search.toLowerCase())
  );

  const isAlreadyAdmin = memberships.some(m => m.role === 'administrateur');

  const handleSwitch = (businessId: string) => {
    if (businessId === activeBusiness?.id) {
      closeBusinessDrawer();
      return;
    }
    selectBusiness(businessId);
    closeBusinessDrawer();
    router.replace('/(app)/(tabs)/');
  };

  const handleJoin = () => {
    closeBusinessDrawer();
    router.push('/(app)/onboarding/rejoindre');
  };

  const handleSupportInbox = () => {
    closeBusinessDrawer();
    router.push('/(app)/support-inbox');
  };

  const handleSupport = () => {
    closeBusinessDrawer();
    router.push('/(app)/support');
  };

  const handleCreate = () => {
    closeBusinessDrawer();
    router.push('/(app)/onboarding/creer');
  };

  return (
    <Modal
      visible={modalVisible}
      transparent
      animationType="none"
      onRequestClose={closeBusinessDrawer}
    >
      {/* Backdrop */}
      <Animated.View style={[StyleSheet.absoluteFillObject, styles.backdrop, backdropAnimStyle]}>
        <Pressable style={StyleSheet.absoluteFillObject} onPress={closeBusinessDrawer} />
      </Animated.View>

      {/* Drawer panel */}
      <GestureDetector gesture={closeDragGesture}>
        <Animated.View style={[
          styles.drawer,
          {
            top: insets.top + 10,
            bottom: 10,
          },
          drawerAnimStyle,
        ]}>

          {/* Header */}
          <View style={styles.header}>
            <Text style={styles.headerTitle}>Mes commerces</Text>
            <Pressable onPress={closeBusinessDrawer} hitSlop={12}>
              <Ionicons name="close-outline" size={22} color={palette.textSecondary} />
            </Pressable>
          </View>

          {/* Search bar */}
          <View style={styles.searchRow}>
            <TextInput
              value={search}
              onChangeText={setSearch}
              placeholder="Rechercher…"
              placeholderTextColor={palette.textDisabled}
              style={styles.searchInput}
              returnKeyType="search"
              clearButtonMode="while-editing"
            />
          </View>

          {/* Business list */}
          <ScrollView
            style={{ flex: 1 }}
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}
          >
            {filtered.map(m => {
              const biz = m.business as { name?: string; id?: string } | undefined;
              const name = biz?.name ?? m.business_id;
              const initial = name.charAt(0).toUpperCase();
              const isActive = m.business_id === activeBusiness?.id;
              const color = avatarColor(m.business_id);

              return (
                <Pressable
                  key={m.id}
                  onPress={() => handleSwitch(m.business_id)}
                  style={({ pressed }) => [
                    styles.row,
                    isActive && styles.rowActive,
                    pressed && { opacity: 0.7 },
                  ]}
                >
                  <View style={[styles.avatar, { backgroundColor: color }]}>
                    <Text style={styles.avatarText}>{initial}</Text>
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.bizName} numberOfLines={1}>{name}</Text>
                    <Text style={styles.roleLabel}>{ROLE_LABEL[m.role]}</Text>
                  </View>
                  {isActive && (
                    <Ionicons name="checkmark" size={18} color={palette.primary} />
                  )}
                </Pressable>
              );
            })}

            {filtered.length === 0 && search.length > 0 && (
              <View style={styles.emptySearch}>
                <Text style={styles.emptySearchText}>Aucun résultat pour « {search} »</Text>
              </View>
            )}
          </ScrollView>

          {/* Footer */}
          <View style={styles.footer}>
            {isFounder ? (
              <Pressable onPress={handleSupportInbox} style={({ pressed }) => [styles.footerRow, pressed && { opacity: 0.6 }]}>
                <View style={styles.footerIcon}>
                  <Ionicons name="headset-outline" size={18} color={palette.primary} />
                </View>
                <Text style={[styles.footerLabel, { flex: 1 }]}>Service client</Text>
                {founderUnreadTotal > 0 && <View style={styles.footerUnreadDot} />}
              </Pressable>
            ) : (
              // Relocated from the Accueil header's headphone icon — same
              // destination (the member's one ongoing thread with the
              // founder), just moved into this lateral drawer.
              <Pressable onPress={handleSupport} style={({ pressed }) => [styles.footerRow, pressed && { opacity: 0.6 }]}>
                <View style={styles.footerIcon}>
                  <Ionicons name="headset-outline" size={18} color={palette.primary} />
                </View>
                <Text style={[styles.footerLabel, { flex: 1 }]}>Support</Text>
              </Pressable>
            )}
            <Pressable onPress={handleJoin} style={({ pressed }) => [styles.footerRow, pressed && { opacity: 0.6 }]}>
              <View style={styles.footerIcon}>
                <Ionicons name="key-outline" size={18} color={palette.primary} />
              </View>
              <Text style={styles.footerLabel}>Rejoindre un commerce</Text>
            </Pressable>
            {!isAlreadyAdmin && (
              <Pressable onPress={handleCreate} style={({ pressed }) => [styles.footerRow, pressed && { opacity: 0.6 }]}>
                <View style={styles.footerIcon}>
                  <Ionicons name="add-circle-outline" size={18} color={palette.textSecondary} />
                </View>
                <Text style={[styles.footerLabel, { color: palette.textSecondary }]}>Créer un commerce</Text>
              </Pressable>
            )}
          </View>

        </Animated.View>
      </GestureDetector>
    </Modal>
  );
}

function makeStyles(p: Palette) {
  return StyleSheet.create({
    backdrop: {
      backgroundColor: 'rgba(0,0,0,0.45)',
    },
    drawer: {
      position: 'absolute',
      left: 0,
      width: DRAWER_WIDTH,
      backgroundColor: p.surface,
      borderTopRightRadius: 16,
      borderBottomRightRadius: 16,
      overflow: 'hidden',
      shadowColor: p.shadow,
      shadowOffset: { width: 4, height: 0 },
      shadowOpacity: 0.18,
      shadowRadius: 16,
      elevation: 12,
    },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: spacing[5],
      paddingTop: spacing[4],
      paddingBottom: spacing[3],
      borderBottomWidth: 1,
      borderBottomColor: p.border,
    },
    headerTitle: {
      fontSize: 16,
      fontWeight: '700',
      color: p.textPrimary,
    },
    searchRow: {
      flexDirection: 'row',
      alignItems: 'center',
      marginHorizontal: spacing[4],
      marginVertical: spacing[3],
      paddingHorizontal: spacing[3],
      paddingVertical: spacing[2],
      backgroundColor: p.background,
      borderRadius: radius.md,
      borderWidth: 1,
      borderColor: p.border,
    },
    searchInput: {
      flex: 1,
      fontSize: 14,
      color: p.textPrimary,
      paddingVertical: 0,
    },
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing[3],
      paddingHorizontal: spacing[4],
      paddingVertical: spacing[3],
    },
    rowActive: {
      backgroundColor: p.primaryLight,
      borderLeftWidth: 3,
      borderLeftColor: p.primary,
      paddingLeft: spacing[4] - 3,
    },
    avatar: {
      width: 40,
      height: 40,
      borderRadius: 10,
      alignItems: 'center',
      justifyContent: 'center',
    },
    avatarText: {
      fontSize: 16,
      fontWeight: '700',
      color: colors.neutral[0],
    },
    bizName: {
      fontSize: 14,
      fontWeight: '600',
      color: p.textPrimary,
      marginBottom: 2,
    },
    roleLabel: {
      fontSize: 12,
      color: p.textSecondary,
    },
    emptySearch: {
      padding: spacing[6],
      alignItems: 'center',
    },
    emptySearchText: {
      fontSize: 13,
      color: p.textSecondary,
    },
    footer: {
      borderTopWidth: 1,
      borderTopColor: p.border,
      paddingVertical: spacing[2],
    },
    footerRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing[3],
      paddingHorizontal: spacing[4],
      paddingVertical: spacing[3],
    },
    footerIcon: {
      width: 32,
      height: 32,
      borderRadius: 8,
      backgroundColor: p.background,
      alignItems: 'center',
      justifyContent: 'center',
      borderWidth: 1,
      borderColor: p.border,
    },
    footerLabel: {
      fontSize: 14,
      fontWeight: '500',
      color: p.primary,
    },
    footerUnreadDot: {
      width: 8,
      height: 8,
      borderRadius: radius.full,
      backgroundColor: p.primary,
    },
  });
}
