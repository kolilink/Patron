import { useCallback, useEffect, useMemo } from 'react';
import { FlatList, Pressable, StyleSheet, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Screen } from '@/src/components/ui/Screen';
import { router, useFocusEffect } from 'expo-router';
import { Text } from '@/src/components/ui/Text';
import { SkeletonList } from '@/src/components/ui/SkeletonPlaceholder';
import { useTheme, spacing, radius } from '@/src/theme';
import type { Palette } from '@/src/theme';
import { useAuthStore } from '@/stores/auth';
import { useSupportChatStore } from '@/stores/supportChat';
import { isFounderPhone } from '@/src/utils/founder';
import type { SupportConversation } from '@/src/types';

function relativeTime(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const diffM = Math.floor(diffMs / 60_000);
  const diffH = Math.floor(diffMs / 3_600_000);
  const diffD = Math.floor(diffMs / 86_400_000);
  if (diffM < 1) return 'maintenant';
  if (diffM < 60) return `${diffM}min`;
  if (diffH < 24) return `${diffH}h`;
  if (diffD <= 7) return `${diffD}j`;
  return new Date(iso).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' });
}

export default function SupportInboxScreen() {
  const { palette } = useTheme();
  const styles = useMemo(() => makeStyles(palette), [palette]);
  const session = useAuthStore(s => s.session);
  const isFounder = isFounderPhone(session?.user.phone);
  const businessId = session?.activeBusiness?.id ?? '';
  const businessName = session?.activeBusiness?.name ?? '';

  const { founderConversations, founderLoading, loadBusinessConversations } = useSupportChatStore();

  useEffect(() => {
    if (!isFounder) router.back();
  }, [isFounder]);

  useFocusEffect(useCallback(() => {
    if (!isFounder || !businessId) return;
    loadBusinessConversations(businessId);
  }, [isFounder, businessId]));

  if (!isFounder) return null;

  return (
    <Screen>
      <View style={styles.header}>
        <Pressable onPress={() => router.back()}>
          <Text variant="body" color="secondary">‹ Retour</Text>
        </Pressable>
        <View style={{ alignItems: 'center' }}>
          <Text variant="h4">Support</Text>
          <Text variant="caption" color="secondary" numberOfLines={1}>{businessName}</Text>
        </View>
        <View style={{ width: 60 }} />
      </View>

      {founderLoading && founderConversations.length === 0 ? (
        <SkeletonList count={6} />
      ) : founderConversations.length === 0 ? (
        <View style={styles.empty}>
          <Text variant="body" color="secondary">Aucune conversation pour l'instant</Text>
        </View>
      ) : (
        <FlatList<SupportConversation>
          data={founderConversations}
          keyExtractor={c => c.id}
          contentContainerStyle={{ paddingBottom: spacing[10] }}
          renderItem={({ item }) => {
            const unread = !item.founder_last_read_at || new Date(item.last_message_at) > new Date(item.founder_last_read_at);
            // Photo previews are stored as "📷 <caption>" so a plain-text push
            // notification still reads naturally — here, in-app, we swap the
            // emoji for a proper vector icon instead of rendering it as text.
            const rawPreview = item.last_message_preview ?? '—';
            const photoMatch = rawPreview.match(/^📷\s*(.*)$/);
            return (
              <Pressable
                onPress={() => router.push(`/(app)/support-inbox/${item.id}`)}
                style={({ pressed }) => [styles.row, pressed && { opacity: 0.75 }]}
              >
                <View style={{ flex: 1, gap: 2 }}>
                  <View style={styles.nameRow}>
                    <Text variant="label" numberOfLines={1} style={{ flex: 1 }}>
                      {item.merchant_name ?? '—'} · {item.business_name ?? '—'}
                    </Text>
                    {unread && <View style={styles.unreadDot} />}
                  </View>
                  <View style={styles.previewRow}>
                    {photoMatch && (
                      <Ionicons name="image-outline" size={13} color={palette.textSecondary} />
                    )}
                    <Text variant="caption" color="secondary" numberOfLines={1} style={{ flex: 1 }}>
                      {photoMatch ? (photoMatch[1] || 'Photo') : rawPreview}
                    </Text>
                  </View>
                </View>
                <View style={{ alignItems: 'flex-end', gap: spacing[1] }}>
                  <View style={[styles.statusPill, item.status === 'open' ? styles.statusOpen : styles.statusClosed]}>
                    <Text variant="labelSmall" style={{ color: item.status === 'open' ? palette.success : palette.textSecondary }}>
                      {item.status === 'open' ? 'Ouvert' : 'Fermé'}
                    </Text>
                  </View>
                  {item.rating != null && (
                    <View style={styles.ratingRow}>
                      <Ionicons name="star" size={11} color={palette.warning} />
                      <Text variant="caption" color="secondary">{item.rating}/5</Text>
                    </View>
                  )}
                  <Text variant="caption" color="secondary">{relativeTime(item.last_message_at)}</Text>
                </View>
              </Pressable>
            );
          }}
          ItemSeparatorComponent={() => <View style={{ height: 1, backgroundColor: palette.border }} />}
        />
      )}
    </Screen>
  );
}

function makeStyles(p: Palette) {
  return StyleSheet.create({
    header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: spacing[5], borderBottomWidth: 1, borderBottomColor: p.border },
    empty: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing[10] },
    row: { flexDirection: 'row', alignItems: 'center', gap: spacing[3], paddingHorizontal: spacing[5], paddingVertical: spacing[4], backgroundColor: p.surface },
    nameRow: { flexDirection: 'row', alignItems: 'center', gap: spacing[2] },
    previewRow: { flexDirection: 'row', alignItems: 'center', gap: 4 },
    unreadDot: { width: 8, height: 8, borderRadius: radius.full, backgroundColor: p.primary },
    statusPill: { paddingHorizontal: spacing[2], paddingVertical: 2, borderRadius: radius.full },
    statusOpen: { backgroundColor: p.successLight },
    statusClosed: { backgroundColor: p.border },
    ratingRow: { flexDirection: 'row', alignItems: 'center', gap: 3 },
  });
}
