import { useEffect, useRef, useState } from 'react';
import {
  Alert,
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
import { palette, spacing, radius } from '@/src/theme';
import { useAuthStore } from '@/stores/auth';
import type { Role } from '@/src/types';

const DRAWER_WIDTH = Dimensions.get('window').width * 0.78;

const AVATAR_PALETTE = [
  '#6366F1', '#8B5CF6', '#EC4899', '#F59E0B',
  '#10B981', '#3B82F6', '#EF4444', '#14B8A6',
];

const ROLE_LABEL: Record<Role, string> = {
  administrateur: 'Gérant',
  manager: 'Manager',
  vendeur: 'Vendeur',
  investisseur: 'Investisseur',
};

function avatarColor(id: string) {
  return AVATAR_PALETTE[id.charCodeAt(0) % AVATAR_PALETTE.length];
}

export function BusinessDrawer() {
  const session = useAuthStore(s => s.session);
  const businessDrawerOpen = useAuthStore(s => s.businessDrawerOpen);
  const closeBusinessDrawer = useAuthStore(s => s.closeBusinessDrawer);
  const selectBusiness = useAuthStore(s => s.selectBusiness);
  const insets = useSafeAreaInsets();

  const slideAnim = useRef(new Animated.Value(-DRAWER_WIDTH)).current;
  const [modalVisible, setModalVisible] = useState(false);
  const [search, setSearch] = useState('');

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
      Alert.alert(
        'Bientôt disponible',
        'La gestion de plusieurs commerces arrive prochainement sur Patron. Pour l\'instant, vous pouvez rejoindre un commerce existant avec un code.',
        [{ text: 'OK' }],
      );
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
              placeholder="Rechercher un commerce..."
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
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    backgroundColor: 'rgba(0,0,0,0.45)',
  },
  drawer: {
    position: 'absolute',
    left: 0,
    width: DRAWER_WIDTH,
    backgroundColor: '#fff',
    borderTopRightRadius: 16,
    borderBottomRightRadius: 16,
    overflow: 'hidden',
    shadowColor: '#000',
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
    borderBottomColor: palette.border,
  },
  headerTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: palette.textPrimary,
  },
  searchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[2],
    marginHorizontal: spacing[4],
    marginVertical: spacing[3],
    paddingHorizontal: spacing[3],
    paddingVertical: spacing[2],
    backgroundColor: palette.background,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: palette.border,
  },
  searchInput: {
    flex: 1,
    fontSize: 14,
    color: palette.textPrimary,
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
    backgroundColor: `${palette.primary}12`,
    borderLeftWidth: 3,
    borderLeftColor: palette.primary,
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
    color: '#fff',
  },
  bizName: {
    fontSize: 14,
    fontWeight: '600',
    color: palette.textPrimary,
    marginBottom: 2,
  },
  roleLabel: {
    fontSize: 12,
    color: palette.textSecondary,
  },
  emptySearch: {
    padding: spacing[6],
    alignItems: 'center',
  },
  emptySearchText: {
    fontSize: 13,
    color: palette.textSecondary,
  },
  footer: {
    borderTopWidth: 1,
    borderTopColor: palette.border,
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
    backgroundColor: palette.background,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: palette.border,
  },
  footerLabel: {
    fontSize: 14,
    fontWeight: '500',
    color: palette.primary,
  },
});
