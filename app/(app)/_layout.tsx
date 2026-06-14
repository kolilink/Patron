import { useEffect } from 'react';
import { Alert, AppState, Pressable, View } from 'react-native';
import { Redirect, Stack, router } from 'expo-router';
import { AppLockOverlay } from '@/src/components/AppLockOverlay';
import { BusinessDrawer } from '@/src/components/BusinessDrawer';
import { PaywallScreen } from '@/src/components/PaywallScreen';
import { TrialWelcomeOverlay } from '@/src/components/TrialWelcomeOverlay';
import { AppToastContainer } from '@/src/components/ui/AppToast';
import { Text } from '@/src/components/ui/Text';
import { useTheme, spacing } from '@/src/theme';
import { useAuthStore } from '@/stores/auth';
import { useChatStore } from '@/stores/chat';
import { useProductStore } from '@/stores/products';
import { useVentesStore } from '@/stores/ventes';
import { useExpensesStore } from '@/stores/expenses';
import { useSyncStore } from '@/stores/sync';
import { drainQueue } from '@/lib/sync';
import { getDeadOps, archiveDeadOps } from '@/lib/db';
import { supabase } from '@/lib/supabase';
import type { Business, Role } from '@/src/types';

// Paywall disabled — app is free during early access
function isSubscriptionExpired(_business: Business): boolean {
  return false;
}

// Trial banner paused — app is free during early access
function TrialBanner({ business: _business }: { business: Business }) {
  return null;
}

function SyncBanner() {
  const { palette } = useTheme();
  const pendingCount = useSyncStore(s => s.pendingCount);
  const syncing = useSyncStore(s => s.syncing);
  const sync = useSyncStore(s => s.sync);

  if (pendingCount === 0) return null;

  const handleSync = async () => {
    const result = await sync();
    if (result.synced > 0) {
      const s = useAuthStore.getState().session;
      if (s?.activeBusiness?.id) {
        const isVendeur = s.activeMembership?.role === 'vendeur';
        useProductStore.getState().fetchProducts(s.activeBusiness.id, s.user.id);
        useVentesStore.getState().fetchSales(s.activeBusiness.id, isVendeur ? s.user.id : undefined);
      }
    }
  };

  return (
    <Pressable
      style={{ backgroundColor: palette.warning, flexDirection: 'row', alignItems: 'center', paddingHorizontal: spacing[5], paddingVertical: spacing[2], gap: spacing[3] }}
      onPress={syncing ? undefined : handleSync}
    >
      <Text variant="caption" style={{ color: '#1C1917', flex: 1 }}>
        {pendingCount} opération{pendingCount > 1 ? 's' : ''} à synchroniser
      </Text>
      <Text variant="caption" style={{ color: '#1C1917', fontWeight: '700', opacity: syncing ? 0.5 : 1 }}>
        {syncing ? 'Synchro…' : '↑ Sync'}
      </Text>
    </Pressable>
  );
}

export default function AppLayout() {
  const session = useAuthStore(s => s.session);
  const loading = useAuthStore(s => s.loading);
  const showTrialWelcome = useAuthStore(s => s.showTrialWelcome);
  const clearTrialWelcome = useAuthStore(s => s.clearTrialWelcome);
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

    if (!userId || !businessId) return;

    let ch: ReturnType<typeof supabase.channel> | null = null;

    const open = () => {
      if (ch) return;
      const currentRole = useAuthStore.getState().session?.activeMembership?.role;
      ch = supabase
        .channel(`membership:${userId}:${businessId}`)
        .on(
          'postgres_changes',
          { event: 'DELETE', schema: 'public', table: 'memberships', filter: `user_id=eq.${userId}` },
          (payload) => {
            const removedId = (payload.old as { business_id?: string }).business_id;
            if (removedId !== businessId) return;
            const remaining = (useAuthStore.getState().session?.memberships ?? []).filter(m => m.business_id !== removedId);
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
    };

    const close = () => {
      if (ch) { supabase.removeChannel(ch); ch = null; }
    };

    open();

    const appStateSub = AppState.addEventListener('change', (nextState) => {
      if (nextState === 'background') close();
      else if (nextState === 'active') open();
    });

    return () => { close(); appStateSub.remove(); };
  }, [session?.user.id, session?.activeBusiness?.id]);

  // Load chat rooms + unread counts whenever the active business changes
  useEffect(() => {
    const businessId = session?.activeBusiness?.id;
    const userId = session?.user.id;
    if (!businessId || !userId) return;
    useChatStore.getState().load(businessId, userId);
  }, [session?.activeBusiness?.id, session?.user.id]);

  // Auto-sync: drain queue on login and every time app comes to foreground
  useEffect(() => {
    if (!session?.user.id) return;

    const trySync = async () => {
      const result = await drainQueue();
      useSyncStore.getState().refreshCount();

      const s = useAuthStore.getState().session;
      if (s?.activeBusiness?.id) {
        const isVendeur = s.activeMembership?.role === 'vendeur';

        // Always refresh expenses on every foreground so the cache stays warm
        // even if the user never visits the dépenses screen.
        useExpensesStore.getState().fetchExpenses(s.activeBusiness.id);
        // Refresh chat unread counts so the badge stays current without a persistent subscription.
        void useChatStore.getState().load(s.activeBusiness.id, s.user.id);

        if (result.synced > 0) {
          useProductStore.getState().fetchProducts(s.activeBusiness.id, s.user.id);
          useVentesStore.getState().fetchSales(s.activeBusiness.id, isVendeur ? s.user.id : undefined);
        }
      }

      // Alert the merchant if any ops permanently failed (hit MAX_SYNC_ATTEMPTS).
      // Archive them to dead_ops before purging from the queue.
      const deadOps = await getDeadOps();
      if (deadOps.length > 0) {
        await archiveDeadOps();
        useSyncStore.getState().refreshCount();

        const salesCount = deadOps.filter(o => o.operation === 'submit_sale').length;
        const expCount   = deadOps.filter(o => o.operation === 'create_expense').length;
        const otherCount = deadOps.length - salesCount - expCount;

        const parts: string[] = [];
        if (salesCount > 0) parts.push(`${salesCount} vente${salesCount > 1 ? 's' : ''}`);
        if (expCount > 0)   parts.push(`${expCount} dépense${expCount > 1 ? 's' : ''}`);
        if (otherCount > 0) parts.push(`${otherCount} opération${otherCount > 1 ? 's' : ''}`);
        const summary = parts.join(', ');

        Alert.alert(
          'Données non synchronisées',
          `${summary} n'ont pas pu être envoyées après plusieurs tentatives et ont été archivées. Vérifiez votre connexion. Si le problème persiste, contactez le support.`,
          [{ text: 'Compris' }],
        );
      }
    };

    const refreshChat = () => {
      const s = useAuthStore.getState().session;
      if (s?.activeBusiness?.id && s?.user.id) {
        void useChatStore.getState().load(s.activeBusiness.id, s.user.id);
      }
    };

    // Run immediately on mount (catches anything queued while app was closed/offline)
    // Also refresh subscription status so the paywall unlocks immediately after payment.
    void useAuthStore.getState().refreshActiveBusiness();
    trySync();

    // Poll chat unread count every 30 seconds while app is open.
    const chatInterval = setInterval(refreshChat, 30_000);

    const sub = AppState.addEventListener('change', (nextState) => {
      if (nextState === 'active') {
        void useAuthStore.getState().refreshActiveBusiness();
        trySync();
      }
    });

    return () => { clearInterval(chatInterval); sub.remove(); };
  }, [session?.user.id]);

  if (loading) return null;
  if (!session) return <Redirect href="/(welcome)/" />;

  const activeBusiness = session.activeBusiness;
  const isOwner = session.activeMembership?.role === 'administrateur';
  if (activeBusiness && isOwner && isSubscriptionExpired(activeBusiness)) {
    return <PaywallScreen business={activeBusiness} />;
  }

  return (
    <AppLockOverlay>
      {activeBusiness && <TrialBanner business={activeBusiness} />}
      <SyncBanner />
      <Stack screenOptions={{ headerShown: false, animation: 'slide_from_right' }} />
      <BusinessDrawer />
      {/* TrialWelcomeOverlay paused — app is free during early access */}
      <AppToastContainer />
    </AppLockOverlay>
  );
}

