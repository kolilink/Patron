import { useEffect } from 'react';
import { Alert, AppState, Pressable, StyleSheet, View } from 'react-native';
import { Redirect, Stack, router } from 'expo-router';
import { AppLockOverlay } from '@/src/components/AppLockOverlay';
import { Text } from '@/src/components/ui/Text';
import { palette, spacing } from '@/src/theme';
import { useAuthStore } from '@/stores/auth';
import { useProductStore } from '@/stores/products';
import { useSyncStore } from '@/stores/sync';
import { drainQueue } from '@/lib/sync';
import { supabase } from '@/lib/supabase';
import type { Role } from '@/src/types';

function SyncBanner() {
  const pendingCount = useSyncStore(s => s.pendingCount);
  const syncing = useSyncStore(s => s.syncing);
  const sync = useSyncStore(s => s.sync);

  if (pendingCount === 0) return null;

  const handleSync = async () => {
    const result = await sync();
    if (result.synced > 0) {
      const s = useAuthStore.getState().session;
      if (s?.activeBusiness?.id) {
        useProductStore.getState().fetchProducts(s.activeBusiness.id, s.user.id);
      }
    }
  };

  return (
    <Pressable style={styles.syncBanner} onPress={syncing ? undefined : handleSync}>
      <Text variant="caption" style={styles.syncText}>
        {pendingCount} opération{pendingCount > 1 ? 's' : ''} en attente
      </Text>
      <Text variant="caption" style={[styles.syncAction, syncing && { opacity: 0.5 }]}>
        {syncing ? 'Synchro…' : '↑ Sync'}
      </Text>
    </Pressable>
  );
}

export default function AppLayout() {
  const session = useAuthStore(s => s.session);
  const loading = useAuthStore(s => s.loading);
  const removedBusinessName = useAuthStore(s => s.removedBusinessName);
  const dismissedFromBusiness = useAuthStore(s => s.dismissedFromBusiness);
  const handleMembershipRemoved = useAuthStore(s => s.handleMembershipRemoved);
  const handleMembershipRemovedWithFallback = useAuthStore(s => s.handleMembershipRemovedWithFallback);
  const handleRoleChanged = useAuthStore(s => s.handleRoleChanged);
  const clearDismissedFromBusiness = useAuthStore(s => s.clearDismissedFromBusiness);

  useEffect(() => {
    if (removedBusinessName) {
      router.replace('/(app)/acces-supprime');
    }
  }, [removedBusinessName]);

  useEffect(() => {
    if (!dismissedFromBusiness) return;
    Alert.alert(
      'Commerce retiré',
      `Vous n'êtes plus membre de « ${dismissedFromBusiness.name} ».`,
      [{ text: 'OK', onPress: clearDismissedFromBusiness }],
    );
  }, [dismissedFromBusiness]);

  useEffect(() => {
    const userId = session?.user.id;
    const businessId = session?.activeBusiness?.id;
    const businessName = session?.activeBusiness?.name ?? '';
    const currentRole = session?.activeMembership?.role;

    if (!userId || !businessId) return;

    const channel = supabase
      .channel(`membership:${userId}:${businessId}`)
      .on(
        'postgres_changes',
        { event: 'DELETE', schema: 'public', table: 'memberships', filter: `user_id=eq.${userId}` },
        (payload) => {
          const removedId = (payload.old as { business_id?: string }).business_id;
          if (removedId !== businessId) return;
          const remaining = (session?.memberships ?? []).filter(m => m.business_id !== removedId);
          if (remaining.length > 0) {
            handleMembershipRemovedWithFallback(removedId, businessName, remaining);
          } else {
            handleMembershipRemoved(businessName);
          }
        },
      )
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'memberships', filter: `user_id=eq.${userId}` },
        (payload) => {
          const updated = payload.new as { business_id: string; role: Role };
          if (updated.business_id === businessId && updated.role !== currentRole) {
            handleRoleChanged(updated.role);
            Alert.alert(
              'Rôle modifié',
              'Votre rôle a été modifié par le gérant. Vos accès ont été mis à jour.',
              [{ text: 'OK' }],
            );
          }
        },
      )
      .subscribe();

    return () => { supabase.removeChannel(channel); };
  }, [session?.user.id, session?.activeBusiness?.id]);

  // Auto-sync: drain queue on login and every time app comes to foreground
  useEffect(() => {
    if (!session?.user.id) return;

    const trySync = async () => {
      const result = await drainQueue();
      useSyncStore.getState().refreshCount();
      if (result.synced > 0) {
        const s = useAuthStore.getState().session;
        if (s?.activeBusiness?.id) {
          useProductStore.getState().fetchProducts(s.activeBusiness.id, s.user.id);
        }
      }
    };

    // Run immediately on mount (catches anything queued while app was closed/offline)
    trySync();

    const sub = AppState.addEventListener('change', (nextState) => {
      if (nextState === 'active') trySync();
    });

    return () => sub.remove();
  }, [session?.user.id]);

  if (loading) return null;
  if (!session) return <Redirect href="/(welcome)/" />;

  return (
    <AppLockOverlay>
      <SyncBanner />
      <Stack screenOptions={{ headerShown: false, animation: 'slide_from_right' }} />
    </AppLockOverlay>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  syncBanner: {
    backgroundColor: '#D97706',
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing[5],
    paddingVertical: spacing[2],
    gap: spacing[3],
  },
  syncText: { color: '#fff', flex: 1 },
  syncAction: { color: '#fff', fontWeight: '700' },
});
