import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Animated,
  Dimensions,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { Text } from '@/src/components/ui/Text';
import { colors, useTheme, spacing, radius, BUSINESS_AVATAR_PALETTE } from '@/src/theme';
import type { Palette } from '@/src/theme';
import { useAuthStore } from '@/stores/auth';
import type { Role } from '@/src/types';

const DRAWER_WIDTH = Dimensions.get('window').width * 0.78;

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

  const slideAnim = useRef(new Animated.Value(-DRAWER_WIDTH)).current;
  const sheetAnim = useRef(new Animated.Value(300)).current;
  const [modalVisible, setModalVisible] = useState(false);
  const [search, setSearch] = useState('');
  const [showComingSoon, setShowComingSoon] = useState(false);

  const openSheet = () => {
    setShowComingSoon(true);
    Animated.spring(sheetAnim, { toValue: 0, useNativeDriver: true, tension: 65, friction: 11 }).start();
  };
  const closeSheet = () => {
    Animated.timing(sheetAnim, { toValue: 300, duration: 220, useNativeDriver: true })
      .start(() => setShowComingSoon(false));
  };

  useEffect(() => {
    if (businessDrawerOpen) {
      setSearch('');
      setModalVisible(true);
      Animated.spring(slideAnim, {
        toValue: 0,
        useNativeDriver: true,
        tension: 65,
        friction: 11,
      }).start();
    } else {
      Animated.timing(slideAnim, {
        toValue: -DRAWER_WIDTH,
        duration: 220,
        useNativeDriver: true,
      }).start(() => setModalVisible(false));
    }
  }, [businessDrawerOpen]);

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

  const handleCreate = () => {
    if (isAlreadyAdmin) {
      openSheet();
    } else {
      closeBusinessDrawer();
      router.push('/(app)/onboarding/creer');
    }
  };

  return (
    <Modal
      visible={modalVisible}
      transparent
      animationType="none"
      onRequestClose={closeBusinessDrawer}
    >
      {/* Backdrop */}
      <Pressable
        style={[StyleSheet.absoluteFillObject, styles.backdrop]}
        onPress={closeBusinessDrawer}
      />

      {/* Drawer panel */}
      <Animated.View style={[
        styles.drawer,
        {
          top: insets.top + 10,
          bottom: 10,
          transform: [{ translateX: slideAnim }],
        },
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
            <Ionicons name="search-outline" size={15} color={palette.textSecondary} />
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
            <Pressable onPress={handleJoin} style={({ pressed }) => [styles.footerRow, pressed && { opacity: 0.6 }]}>
              <View style={styles.footerIcon}>
                <Ionicons name="key-outline" size={18} color={palette.primary} />
              </View>
              <Text style={styles.footerLabel}>Rejoindre un commerce</Text>
            </Pressable>
            <Pressable onPress={handleCreate} style={({ pressed }) => [styles.footerRow, pressed && { opacity: 0.6 }]}>
              <View style={styles.footerIcon}>
                <Ionicons name="add-circle-outline" size={18} color={palette.textSecondary} />
              </View>
              <Text style={[styles.footerLabel, { color: palette.textSecondary }]}>Créer un commerce</Text>
            </Pressable>
          </View>

      </Animated.View>

      {/* Inline "Bientôt disponible" sheet — avoids nested Modal on Android */}
      {showComingSoon && (
        <>
          <Pressable style={styles.sheetBackdrop} onPress={closeSheet} />
          <Animated.View style={[styles.sheet, { transform: [{ translateY: sheetAnim }] }]}>
            <View style={styles.sheetHandle} />
            <View style={styles.sheetIcon}>
              <Ionicons name="rocket-outline" size={28} color={palette.primary} />
            </View>
            <Text style={styles.sheetTitle}>Bientôt disponible</Text>
            <Text style={styles.sheetBody}>
              La gestion de plusieurs commerces arrive prochainement sur Patron. Pour l'instant, vous pouvez rejoindre un commerce existant avec un code.
            </Text>
            <Pressable onPress={closeSheet} style={styles.sheetClose}>
              <Text style={styles.sheetCloseLabel}>OK, compris</Text>
            </Pressable>
          </Animated.View>
        </>
      )}
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
      gap: spacing[2],
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
    sheetBackdrop: {
      ...StyleSheet.absoluteFillObject,
      backgroundColor: 'rgba(0,0,0,0.25)',
    },
    sheet: {
      position: 'absolute',
      left: 0,
      right: 0,
      bottom: 0,
      backgroundColor: p.surface,
      borderTopLeftRadius: 24,
      borderTopRightRadius: 24,
      paddingHorizontal: spacing[6],
      paddingTop: spacing[3],
      paddingBottom: spacing[10],
      alignItems: 'center',
      gap: spacing[3],
    },
    sheetHandle: {
      width: 40,
      height: 4,
      borderRadius: 2,
      backgroundColor: p.border,
      marginBottom: spacing[2],
    },
    sheetIcon: {
      width: 64,
      height: 64,
      borderRadius: 20,
      backgroundColor: p.primaryLight,
      alignItems: 'center',
      justifyContent: 'center',
    },
    sheetTitle: {
      fontSize: 18,
      fontWeight: '700',
      color: p.textPrimary,
      textAlign: 'center',
    },
    sheetBody: {
      fontSize: 14,
      color: p.textSecondary,
      textAlign: 'center',
      lineHeight: 22,
    },
    sheetClose: {
      marginTop: spacing[2],
      backgroundColor: p.primary,
      borderRadius: radius.lg,
      paddingHorizontal: spacing[8],
      paddingVertical: spacing[4],
      width: '100%',
      alignItems: 'center',
    },
    sheetCloseLabel: {
      fontSize: 16,
      fontWeight: '700',
      color: colors.neutral[0],
    },
  });
}
