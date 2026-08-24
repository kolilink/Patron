import { useEffect, useRef, useState } from 'react';
import { Alert, AppState, Pressable, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Redirect, Stack, router } from 'expo-router';
import { BusinessDrawer } from '@/src/components/BusinessDrawer';
import { TrialWelcomeOverlay } from '@/src/components/TrialWelcomeOverlay';
import { ActivationForkOverlay } from '@/src/components/ActivationForkOverlay';
import { AppToastContainer } from '@/src/components/ui/AppToast';
import { DemoBanner } from '@/src/components/ui/DemoBanner';
import { NotificationSetup } from '@/src/components/NotificationSetup';
import { Text } from '@/src/components/ui/Text';
import { useTheme, spacing } from '@/src/theme';
import { useAuthStore } from '@/stores/auth';
import { useChatStore } from '@/stores/chat';
import { useProductStore } from '@/stores/products';
import { useVentesStore } from '@/stores/ventes';
import { useExpensesStore } from '@/stores/expenses';
import { useSyncStore } from '@/stores/sync';
import { toast } from '@/stores/toast';
import { drainQueue, debounceAppStateHandler } from '@/lib/sync';
import { getDeadOps, archiveDeadOps } from '@/lib/db';
import { supabase } from '@/lib/supabase';
import { PAYWALL_ENABLED } from '@/lib/purchases';
import type { Role } from '@/src/types';

// Re-lock (biometric or full OTP re-login, see verrouille.tsx) after the app
// has been backgrounded this long. Was previously a separate AppLockOverlay
// component with its own AppState listener; folded into the existing
// foreground-sync listener below so backgrounding doesn't also trigger a
// pointless realtime reconnect + drainQueue() right before the redirect.
const BACKGROUND_MS = 3 * 60_000;

// debounceAppStateHandler() (guards against Android's rapid AppState
// flapping — see its own doc comment in lib/sync.ts) now lives there
// instead of here, so it's importable in isolation for unit tests.

function SyncBanner() {
  const { palette } = useTheme();
  const insets = useSafeAreaInsets();
  const pendingCount = useSyncStore(s => s.pendingCount);
  const syncing = useSyncStore(s => s.syncing);
  const sync = useSyncStore(s => s.sync);
  // Mounted as a sibling of <Stack/> at the root layout, not inside a
  // <Screen>/SafeAreaView — so unlike every real screen, it has no built-in
  // top-inset awareness and was rendering flush against the physical top
  // edge, bleeding behind the status bar/notch on every device. DemoBanner
  // (mounted right above this one) already consumes insets.top when demo
  // mode is on, so skip it here too or the two banners get a double gap —
  // same rule Screen.tsx already follows for the same reason.
  const isDemoMode = useAuthStore(s => s.session?.isDemoMode ?? false);

  if (pendingCount === 0) return null;

  const handleSync = async () => {
    const result = await sync();
    if (result.synced > 0) {
      const s = useAuthStore.getState().session;
      if (s?.activeBusiness?.id) {
        const isVendeur = s.activeMembership?.role === 'vendeur';
        useProductStore.getState().fetchProducts(s.activeBusiness.id, s.user.id, s.activeMembership?.id, s.activeMembership?.role);
        useVentesStore.getState().fetchSales(s.activeBusiness.id, isVendeur ? s.user.id : undefined);
      }
    }
  };

  return (
    <Pressable
      style={{
        backgroundColor: palette.warningLight,
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: spacing[5],
        paddingTop: (isDemoMode ? 0 : insets.top) + spacing[2],
        paddingBottom: spacing[2],
        gap: spacing[3],
      }}
      onPress={syncing ? undefined : handleSync}
    >
      <Text variant="caption" style={{ color: palette.warning, flex: 1 }}>
        {pendingCount} opération{pendingCount > 1 ? 's' : ''} à synchroniser
      </Text>
      <Text variant="caption" style={{ color: palette.warning, fontWeight: '700', opacity: syncing ? 0.5 : 1 }}>
        {syncing ? 'Synchro…' : '↑ Sync'}
      </Text>
    </Pressable>
  );
}

export default function AppLayout() {
  const session = useAuthStore(s => s.session);
  const loading = useAuthStore(s => s.loading);
  const locked = useAuthStore(s => s.locked);
  const showTrialWelcome = useAuthStore(s => s.showTrialWelcome);
  const clearTrialWelcome = useAuthStore(s => s.clearTrialWelcome);
  const removedBusinessName = useAuthStore(s => s.removedBusinessName);
  const dismissedFromBusiness = useAuthStore(s => s.dismissedFromBusiness);
  const handleMembershipRemoved = useAuthStore(s => s.handleMembershipRemoved);
  const handleMembershipRemovedWithFallback = useAuthStore(s => s.handleMembershipRemovedWithFallback);
  const handleRoleChanged = useAuthStore(s => s.handleRoleChanged);
  const clearDismissedFromBusiness = useAuthStore(s => s.clearDismissedFromBusiness);

  // Activation fork ("On enregistre quoi aujourd'hui ?") — evaluated here,
  // not on Accueil, specifically so it can show on top of ANY screen, not
  // just Home. It used to live entirely inside (tabs)/index.tsx; the gap
  // that exposed was that backing out of a sub-flow onto Catalogue's or
  // Vendre's own screen (without navigating back to Home) left nothing
  // enforcing anything until the user specifically returned there. Derived
  // fresh every render from live product/sale counts + business age, same
  // as before — no persisted flag, nothing that can go stale.
  const suppressActivationFork = useAuthStore(s => s.suppressActivationFork);
  const forkProducts = useProductStore(s => s.products);
  const forkSales = useVentesStore(s => s.sales);
  const forkRole = session?.activeMembership?.role;
  const forkIsOwner = forkRole !== 'investisseur' && forkRole !== 'vendeur';
  const forkBusinessId = session?.activeBusiness?.id ?? '';
  const forkStep2Done = forkProducts.length > 0;
  const forkStep3Done = forkSales.some(s => s.business_id === forkBusinessId && s.status !== 'annule');
  const forkAgeMs = session?.activeBusiness?.created_at
    ? Date.now() - new Date(session.activeBusiness.created_at).getTime()
    : Infinity;
  const showFork = forkIsOwner && !forkStep2Done && !forkStep3Done && forkAgeMs < 24 * 60 * 60 * 1000;

  // forkAgeMs is a snapshot taken at render time, not a live clock — if
  // nothing else re-renders this component, it never re-evaluates on its
  // own. In practice something almost always does (foreground returns
  // already trigger refreshActiveBusiness() below, which changes session
  // and re-renders this), so this is a backstop, not the primary
  // mechanism: while the fork is actually showing, force a re-render once a
  // minute so age crossing 24h is caught even in the pathological case of
  // the app sitting open, foregrounded, untouched, for a full day straight.
  // Self-limiting — stops scheduling itself the moment showFork goes false,
  // whether that's from crossing 24h or from the business no longer being
  // empty.
  const [, forkAgeTick] = useState(0);
  useEffect(() => {
    if (!showFork) return;
    const interval = setInterval(() => forkAgeTick(t => t + 1), 60_000);
    return () => clearInterval(interval);
  }, [showFork]);

  // Hides the fork for a short window right after tapping one of its three
  // buttons — otherwise it keeps floating on top of wherever that button
  // just navigated to, since showFork itself only changes once the
  // underlying data does. Resets on a timeout (there's no single "focus"
  // event to hook at this global a level) and also immediately on business
  // switch. catalogue.tsx's add-product form additionally suppresses via
  // suppressActivationFork for as long as it's genuinely open, since that
  // form is its own real Modal and a fixed timeout can't safely predict how
  // long someone takes to fill it in.
  const [forkNavigating, setForkNavigating] = useState(false);
  const forkNavTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => { setForkNavigating(false); }, [forkBusinessId]);
  useEffect(() => () => { if (forkNavTimerRef.current) clearTimeout(forkNavTimerRef.current); }, []);
  const beginForkNavigation = () => {
    setForkNavigating(true);
    if (forkNavTimerRef.current) clearTimeout(forkNavTimerRef.current);
    forkNavTimerRef.current = setTimeout(() => setForkNavigating(false), 1200);
  };

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
        .channel(`membership:${userId}:${businessId}:${Date.now()}`)
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

    const debounced = debounceAppStateHandler((nextState) => {
      if (nextState === 'background') close();
      else if (nextState === 'active') open();
    });
    const appStateSub = AppState.addEventListener('change', debounced.onChange);

    return () => { close(); appStateSub.remove(); debounced.cancel(); };
  }, [session?.user.id, session?.activeBusiness?.id]);

  // Real-time scope subscription for vendeurs — re-fetch their product list
  // whenever admin modifies membership_product_scope for their membership.
  useEffect(() => {
    const membershipId = session?.activeMembership?.id;
    const role = session?.activeMembership?.role;
    if (role !== 'vendeur' || !membershipId) return;

    const ch = supabase
      .channel(`scope:${membershipId}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'membership_product_scope', filter: `membership_id=eq.${membershipId}` },
        () => {
          const s = useAuthStore.getState().session;
          if (s?.activeBusiness?.id) {
            useProductStore.getState().fetchProducts(
              s.activeBusiness.id,
              s.user.id,
              s.activeMembership?.id,
              s.activeMembership?.role,
            );
          }
        },
      )
      .subscribe();

    return () => { supabase.removeChannel(ch); };
  }, [session?.activeMembership?.id, session?.activeMembership?.role]);

  // Load chat rooms + unread counts whenever the active business changes
  useEffect(() => {
    const businessId = session?.activeBusiness?.id;
    const userId = session?.user.id;
    if (!businessId || !userId) return;
    useChatStore.getState().load(businessId, userId);
  }, [session?.activeBusiness?.id, session?.user.id]);

  // Auto-sync: drain queue on login and every time app comes to foreground
  const backgroundAt = useRef<number | null>(null);
  useEffect(() => {
    if (!session?.user.id) return;

    const trySync = async () => {
      try {
        const result = await drainQueue();
        useSyncStore.getState().refreshCount();

        // A queued payment can be correctly rejected (the debt it was paying
        // off was already settled by another payment before this one synced) —
        // surface that instead of letting it disappear into the retry queue.
        if (result.rejectedPayments.length > 0) {
          toast.warning(
            result.rejectedPayments.length === 1
              ? 'Un paiement enregistré hors ligne n\'a pas pu être appliqué : la dette était déjà soldée.'
              : `${result.rejectedPayments.length} paiements enregistrés hors ligne n'ont pas pu être appliqués : les dettes étaient déjà soldées.`,
          );
        }

        const s = useAuthStore.getState().session;
        if (s?.activeBusiness?.id) {
          const isVendeur = s.activeMembership?.role === 'vendeur';

          // Always refresh expenses on every foreground so the cache stays warm
          // even if the user never visits the dépenses screen.
          useExpensesStore.getState().fetchExpenses(s.activeBusiness.id);
          // Refresh chat unread counts so the badge stays current without a persistent subscription.
          void useChatStore.getState().load(s.activeBusiness.id, s.user.id);

          if (result.synced > 0) {
            useProductStore.getState().fetchProducts(s.activeBusiness.id, s.user.id, s.activeMembership?.id, s.activeMembership?.role);
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
      } catch (err) {
        console.warn('[sync] trySync error:', err);
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
    void trySync();

    // Poll chat unread count every 30 seconds while app is open.
    const chatInterval = setInterval(refreshChat, 30_000);

    const debounced = debounceAppStateHandler((nextState) => {
      if (nextState === 'background' || nextState === 'inactive') {
        backgroundAt.current = Date.now();
        return;
      }
      if (nextState === 'active') {
        const bgStart = backgroundAt.current;
        backgroundAt.current = null;

        if (bgStart !== null && Date.now() - bgStart >= BACKGROUND_MS) {
          void useAuthStore.getState().lock();
          return; // about to redirect to /(auth)/verrouille — skip the sync below
        }

        void useAuthStore.getState().refreshActiveBusiness();
        trySync();
      }
    });
    const sub = AppState.addEventListener('change', debounced.onChange);

    return () => { clearInterval(chatInterval); sub.remove(); debounced.cancel(); };
  }, [session?.user.id]);

  if (loading) return null;
  if (locked) return <Redirect href="/(auth)/verrouille" />;
  if (!session) return <Redirect href="/(welcome)/" />;

  const activeBusiness = session.activeBusiness;
  const isDemoMode = session.isDemoMode ?? false;
  // No paywall gating anywhere in the app anymore — the core app is free
  // forever, and only Alpha (has_ai_access(), db/migration_v133.sql) checks
  // subscription state, entirely within app/(app)/alpha/index.tsx itself.

  return (
    <>
      <NotificationSetup />
      <DemoBanner />
      <SyncBanner />
      <Stack screenOptions={{ headerShown: false, animation: 'slide_from_right' }}>
        {/* Only reachable from ActivationForkOverlay's "Une vente" button —
            unlike catalogue/vendre (tab routes, switched in place with no
            stack transition), this is a genuine stack push, so the default
            slide-in was visibly two stages: old screen slides away, new one
            slides in, only then its content is settled. animation: 'none'
            here removes that — the fork's own Modal already provides the
            "you made a choice" motion, this arrival doesn't need a second one. */}
        <Stack.Screen name="onboarding/vente-rapide" options={{ animation: 'none' }} />
      </Stack>

      <BusinessDrawer />
      {PAYWALL_ENABLED && showTrialWelcome && activeBusiness && (
        <TrialWelcomeOverlay
          businessName={activeBusiness.name}
          trialEndsAt={activeBusiness.trial_ends_at}
          onStart={clearTrialWelcome}
        />
      )}
      {/* !(PAYWALL_ENABLED && showTrialWelcome) — dead weight today since
          PAYWALL_ENABLED is false (TrialWelcomeOverlay never renders), but
          both overlays go true at the same instant right after business
          creation, and letting two Modals race for the screen is the exact
          bug already fixed twice elsewhere this session. Cheap insurance
          against re-enabling the paywall silently reintroducing it. */}
      {showFork && !forkNavigating && !suppressActivationFork && !(PAYWALL_ENABLED && showTrialWelcome) && activeBusiness && (
        <ActivationForkOverlay
          userName={session.user.name}
          onSelectProduct={() => {
            beginForkNavigation();
            router.push({ pathname: '/(app)/(tabs)/catalogue', params: { openForm: '1' } });
          }}
          onSelectSale={() => {
            beginForkNavigation();
            router.push('/(app)/onboarding/vente-rapide');
          }}
          onSelectDebt={() => {
            beginForkNavigation();
            router.push({ pathname: '/(app)/(tabs)/vendre', params: { mode: 'credit' } });
          }}
        />
      )}
      <AppToastContainer />
    </>
  );
}

