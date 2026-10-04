import { useEffect, useRef, useState } from 'react';
import { Alert, AppState, Pressable, View } from 'react-native';
import NetInfo from '@react-native-community/netinfo';
import { shouldKickOnConnectivityChange } from '@/lib/netInfoKick';
import { trackEvent } from '@/lib/analytics';
import { flushFunnelOutbox } from '@/lib/funnel';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Redirect, Stack, router } from 'expo-router';
import { BusinessDrawer } from '@/src/components/BusinessDrawer';
import { FirstRunHeroOverlay } from '@/src/components/FirstRunHeroOverlay';
import { TrialWelcomeOverlay } from '@/src/components/TrialWelcomeOverlay';
import { ActivationForkOverlay } from '@/src/components/ActivationForkOverlay';
import { NotificationPrimer } from '@/src/components/NotificationPrimer';
import { AppToastContainer } from '@/src/components/ui/AppToast';
import { SaveConfirmation } from '@/src/components/ui/SaveConfirmation';
import { NotificationSetup } from '@/src/components/NotificationSetup';
import { ActivationPrimingSheet } from '@/src/components/ActivationPrimingSheet';
import { Text } from '@/src/components/ui/Text';
import { useTheme, spacing } from '@/src/theme';
import { useAuthStore } from '@/stores/auth';
import { useInviterStore } from '@/stores/inviter';
import { getPendingInviteToken, clearPendingInviteToken } from '@/lib/inviteLink';
import { useChatStore } from '@/stores/chat';
import { useProductStore } from '@/stores/products';
import { useVentesStore } from '@/stores/ventes';
import { useExpensesStore } from '@/stores/expenses';
import { useSyncStore } from '@/stores/sync';
import { useSupportChatStore } from '@/stores/supportChat';
import { toast } from '@/stores/toast';
import { debounceAppStateHandler } from '@/lib/sync';
import { SyncStatusLine } from '@/src/components/ui/SyncStatusLine';
import { supabase } from '@/lib/supabase';
import { PAYWALL_ENABLED } from '@/lib/purchases';
import type { Role } from '@/src/types';

// Re-lock (biometric or WhatsApp OTP re-login, see verrouille.tsx) after the
// app has been backgrounded this long. Was previously a separate
// AppLockOverlay component with its own AppState listener; folded into the
// existing foreground-sync listener below so backgrounding doesn't also
// trigger a pointless realtime reconnect + drainQueue() right before the
// redirect. Single tunable constant, per the lock-screen redesign brief.
const BACKGROUND_MS = 2 * 60_000;

// PaymentReminderAsker's "fresh session" trigger — a return from background
// this long counts as a new session moment, same as a real cold start.
// Deliberately its own constant, not derived from BACKGROUND_MS: the lock
// threshold and this one answer different questions (is the session secure
// vs. is this a good moment to ask something) and have no reason to move
// together just because they're both measured off the same backgroundAt ref.
const FRESH_SESSION_BACKGROUND_MS = 10 * 60_000;

// debounceAppStateHandler() (guards against Android's rapid AppState
// flapping — see its own doc comment in lib/sync.ts) now lives there
// instead of here, so it's importable in isolation for unit tests.

// §8: SyncBanner (amber "N opérations à synchroniser" + a tappable manual
// "↑ Sync" action) is deleted, not just restyled — replaced by
// SyncStatusLine (src/components/ui/SyncStatusLine.tsx), the single quiet
// sync surface the approved spec calls for. No manual sync button: there is
// nothing for the merchant to do here that kick() (every write) and the
// foreground AppState listener below don't already do on their own.

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

  // Starts true (pessimistic) so ActivationForkOverlay can't flash in during
  // the brief async window before NotificationPrimer has determined whether
  // it needs to show itself — see NotificationPrimer's own doc comment for
  // why these two must never be visible at the same time.
  const [notifPrimerBlocking, setNotifPrimerBlocking] = useState(true);

  // Which business (if any) should currently show FirstRunHeroOverlay —
  // deliberately a LATCHED local id, not a live re-derivation of
  // activeBusiness.first_run_hero_completed_at. First attempt at this got
  // it wrong: adding a separate "dismissed" boolean alongside a condition
  // that *also* still checked the live DB flag meant either one flipping
  // could still close the overlay — and the flag flips the instant the
  // FIRST save succeeds (it has to, for the payoff screen to be reachable
  // at all), so the Modal was unmounting itself before "Noté ✓" was ever
  // visible. Found on-device 2026-09-27. Fix: decide eligibility exactly
  // once per business, latch it into local state, and only ever clear it
  // on an explicit exit (Passer, or "Voir mon commerce"). The persisted
  // flag still does its real job — preventing the gate from being eligible
  // again on a future launch/business-switch — it just no longer has any
  // power to close an already-open instance.
  const [heroBusinessId, setHeroBusinessId] = useState<string | null>(null);
  // The business id this latch has actually evaluated eligibility for —
  // NOT the same thing as heroBusinessId itself (that one is null both
  // "not yet checked" and "checked, not eligible"). See the render-time
  // block below for why this exists.
  const [heroCheckedBusinessId, setHeroCheckedBusinessId] = useState<string | null>(null);
  const activeBusinessId = session?.activeBusiness?.id ?? null;
  const activeBusinessForHero = session?.activeBusiness;
  // Adjusting state during render — deliberately not a useEffect. An effect
  // only runs *after* a frame has already committed, so switching to a
  // brand-new business (freshly created, or just switched to) always
  // painted one real, visible frame with heroBusinessId still holding
  // whatever it was for the *previous* business, before the effect
  // corrected it a moment later — "something flashes before the hero gate
  // for a few ms," reported live 2026-09-28, right after creating a
  // business. Computing eligibility directly in the render body instead —
  // guarded by comparing against the last business id actually processed,
  // so it only runs once per business change and can't loop — updates
  // state synchronously before React paints anything, so the very first
  // rendered frame for a new business already has the right value. Still
  // deliberately keyed on the business id alone, exactly as before:
  // re-running this because first_run_hero_completed_at itself changed
  // (which happens mid-flow, from inside the overlay this gates) is
  // exactly the bug the latch design above exists to avoid.
  if (activeBusinessId !== heroCheckedBusinessId) {
    setHeroCheckedBusinessId(activeBusinessId);
    const eligible = !!activeBusinessId && !!activeBusinessForHero
      && !activeBusinessForHero.first_run_hero_completed_at
      && session?.activeMembership?.role === 'administrateur';
    setHeroBusinessId(eligible ? activeBusinessId : null);
  }

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
  // `products.length === 0` / `sales`-has-no-match can't tell "confirmed
  // empty" apart from "haven't loaded yet for this business" — on a cold
  // start (or right after switching business), both stores start out empty
  // in memory until their fetch resolves, so a business that already has a
  // product and a sale would still briefly read as "neither done," flashing
  // the fork before the real data arrived and corrected it. Fail closed
  // (don't show) until both stores confirm they've actually fetched *this*
  // business's data — same defensive shape as notifPrimerBlocking below.
  const productsFetchedFor = useProductStore(s => s.productsFetchedFor);
  const salesFetchedFor = useVentesStore(s => s.salesFetchedFor);
  const forkDataReady = productsFetchedFor === forkBusinessId && salesFetchedFor === forkBusinessId;
  // Superseded by FirstRunHeroOverlay for any business that's already been
  // through it, skip or save alike — found live 2026-09-27: skipping the
  // (soft, real-exit) hero gate on an empty business left forkAgeMs < 24h
  // and neither step done, so this hard, non-dismissible 3-button wall fired
  // immediately behind it. That's a strictly worse experience than before
  // the hero gate existed, and directly contradicts its whole "Passer is a
  // real exit" design. A completed hero save already suppresses this
  // naturally (forkStep3Done becomes true, since a debt is a credit sale) —
  // this condition is what covers the skip path, where neither is true yet.
  const showFork = forkIsOwner && forkDataReady && !forkStep2Done && !forkStep3Done
    && forkAgeMs < 24 * 60 * 60 * 1000
    && !session?.activeBusiness?.first_run_hero_completed_at;

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

  // B3 — cold-start race: a pending invite token (captured on this device
  // before/while the session was being restored) must be redeemed as soon as
  // the restored session has an active business, instead of being orphaned
  // while the app silently lands on Home. Runs once per restored business id;
  // redemption is idempotent server-side so a re-fire clears the token
  // without double-pushing.
  const coldStartInviteHandledFor = useRef<string | null>(null);
  useEffect(() => {
    const businessId = session?.activeBusiness?.id;
    if (!businessId || !session) return;
    if (coldStartInviteHandledFor.current === businessId) return;
    coldStartInviteHandledFor.current = businessId;
    (async () => {
      const token = await getPendingInviteToken();
      if (!token) return;
      const resolved = await useInviterStore.getState().resolveInvite(token, '');
      if (resolved) {
        await clearPendingInviteToken();
        router.replace('/(app)/discussions?tab=amis');
      }
    })();
  }, [session?.activeBusiness?.id]);

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
        // §8: routed through useSyncStore.sync() rather than calling
        // drainQueue() directly — this is what fires the PostHog
        // sync-health events (§3/§4's SyncHealthEvent wiring, done in
        // stores/sync.ts specifically because lib/sync.ts itself can't
        // safely import analytics) and updates lastSyncedAt (kept for
        // observability now — the sync line is silent when online, §8).
        // Calling drainQueue() directly here — the pre-existing shape —
        // meant every drain triggered by this foreground listener silently
        // skipped both; only a kick()-triggered drain (from a write) ever
        // went through the wrapper. sync() calls getQueueCount() itself,
        // so the separate refreshCount() call this used to need is gone.
        const result = await useSyncStore.getState().sync();

        // A queued payment can be correctly rejected (the debt it was paying
        // off was already settled by another payment before this one synced) —
        // surface that instead of letting it disappear into the retry queue.
        if (result.rejectedPayments.length > 0) {
          // Distinct copy for the two real rejection causes (P0-1): the
          // targeted sale no longer exists, vs the debt was already settled
          // by another payment before this queued one synced. The raw
          // rejection message (extracted from the RPC's P0001 RAISE) is what
          // distinguishes them — "Vente introuvable" vs "Le montant dépasse
          // le solde restant dû".
          const notFound = result.rejectedPayments.filter((m) => m.includes('Vente introuvable')).length;
          const alreadySettled = result.rejectedPayments.length - notFound;

          if (notFound > 0) {
            toast.warning(
              notFound === 1
                ? 'Un paiement enregistré hors ligne n\'a pas pu être appliqué : la vente correspondante est introuvable.'
                : `${notFound} paiements enregistrés hors ligne n'ont pas pu être appliqués : les ventes correspondantes sont introuvables.`,
            );
          }
          if (alreadySettled > 0) {
            toast.warning(
              alreadySettled === 1
                ? 'Un paiement enregistré hors ligne n\'a pas pu être appliqué : la dette était déjà soldée.'
                : `${alreadySettled} paiements enregistrés hors ligne n'ont pas pu être appliqués : les dettes étaient déjà soldées.`,
            );
          }
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

        // §8: the old "Données non synchronisées" Alert.alert (fired once an
        // item hit MAX_SYNC_ATTEMPTS and was archived to dead_ops) is
        // deleted, not just quieted — it was the exact "looks lost" failure
        // the approved spec forbids, and under §3's new classification
        // there's no attempts-cap event to alert on in the first place: a
        // failed_permanent item is classified immediately (not after N
        // retries) and stays fully visible in her own data (never archived
        // away) — the quiet sync line (SyncStatusLine, §8) is the only
        // sync-related UI now. A founder-facing surface for
        // failed_permanent/failed_corrupt items is §9's job (the staleness
        // proxy + a Paramètres line), not a merchant-facing alert.
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

        // Bumped before the lock check below, deliberately — a background
        // stretch long enough to qualify here is also long enough to lock,
        // and the asker should still get credit for "fresh session" once the
        // user unlocks and actually reaches Accueil, not lose the signal
        // just because this same tick also redirects to verrouille first.
        if (bgStart !== null && Date.now() - bgStart >= FRESH_SESSION_BACKGROUND_MS) {
          useAuthStore.setState(s => ({ freshSessionToken: s.freshSessionToken + 1 }));
          // Same 10-minute bar as "fresh session": a real return to the app,
          // not a quick switch to WhatsApp and back. Cold starts fire from
          // app/_layout.tsx.
          trackEvent('app_opened', null, null, { source: 'foreground' });
        }
        void flushFunnelOutbox();

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

  // Kick the drainer the instant real connectivity returns, instead of
  // waiting on the exponential backoff cadence (up to 30min once it's
  // settled, per lib/sync.ts's rescheduleOp) or the next foreground/write
  // event. NetInfo's isConnected can flap/false-positive on some Android
  // devices (a captive portal reads as "connected" at the OS level), so
  // this is a fast-path nudge on top of the existing retry loop, not a
  // replacement for it — kick() is safe to call redundantly either way.
  useEffect(() => {
    if (!session?.user.id) return;
    let wasConnected: boolean | null = null;
    const sub = NetInfo.addEventListener(state => {
      const isConnected = state.isConnected === true;
      if (shouldKickOnConnectivityChange(wasConnected, isConnected)) {
        useSyncStore.getState().kick();
        // A reconnect is also the moment to flush any support messages the
        // merchant wrote while offline — drainSupportQueue otherwise only
        // runs from load() on screen focus, so a queued message would sit
        // undelivered until the next refocus.
        void useSupportChatStore.getState().drainSupportQueue();
      }
      wasConnected = isConnected;
    });
    return () => sub();
  }, [session?.user.id]);

  if (loading) return null;
  if (locked) return <Redirect href="/(auth)/verrouille" />;
  if (!session) return <Redirect href="/(welcome)/" />;

  const activeBusiness = session.activeBusiness;
  // First-run hero action ("Qui vous doit de l'argent ?") — the very first
  // thing a brand-new business should see, ahead of even NotificationPrimer.
  // Eligibility (business flag unset, administrateur) was
  // already decided once, above, into heroBusinessId the moment this
  // business became active — this line only checks whether THIS render's
  // active business is the one currently latched open, never re-derives
  // eligibility from the live DB flag (see heroBusinessId's own comment for
  // why that distinction is load-bearing).
  const showFirstRunHero = !!activeBusiness && heroBusinessId === activeBusiness.id;
  // No paywall gating anywhere in the app anymore — the core app is free
  // forever, and only Alpha (has_ai_access(), db/migration_v133.sql) checks
  // subscription state, entirely within app/(app)/alpha/index.tsx itself.

  return (
    <>
      <NotificationSetup />
      <SyncStatusLine />
      <Stack screenOptions={{ headerShown: false, animation: 'slide_from_right' }} />

      <BusinessDrawer />
      {showFirstRunHero && activeBusiness ? (
        // Blocks NotificationPrimer/TrialWelcome/ActivationFork entirely
        // while showing — same "two Modals racing" hazard as the
        // notifPrimerBlocking guards just below, and this one has to win
        // priority since it's the very first thing a new business sees.
        <FirstRunHeroOverlay
          businessId={activeBusiness.id}
          userId={session.user.id}
          currency={activeBusiness.currency}
          onDone={() => {
            setHeroBusinessId(null);
            useAuthStore.setState(s => ({ homeRefreshToken: s.homeRefreshToken + 1 }));
          }}
        />
      ) : (
        <>
          <NotificationPrimer
            userId={session.user.id}
            active={!!activeBusiness}
            onBlockingChange={setNotifPrimerBlocking}
          />
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
              against re-enabling the paywall silently reintroducing it.
              !notifPrimerBlocking — same reasoning, for NotificationPrimer:
              it's the first thing a brand-new business should see, and letting
              the fork show underneath/alongside it is the same race. */}
          {showFork && !forkNavigating && !suppressActivationFork && !notifPrimerBlocking && !(PAYWALL_ENABLED && showTrialWelcome) && activeBusiness && (
            <ActivationForkOverlay
              userName={session.user.name}
              onSelectProduct={() => {
                beginForkNavigation();
                router.push({ pathname: '/(app)/(tabs)/catalogue', params: { openForm: '1' } });
              }}
              onSelectSale={() => {
                // No longer a dedicated screen (onboarding/vente-rapide.tsx,
                // deleted) — the amount-only quick sale now lives as
                // QuickCaptureSheet's own "Vente" mode, owned by Accueil's
                // local state. Navigate there first (same reasoning as
                // onSelectProduct/onSelectDebt below: land on the screen
                // that will actually act on this before asking it to),
                // then request the sheet open in Vente mode via the
                // cross-cutting requestQuickCapture signal.
                beginForkNavigation();
                useAuthStore.setState({ requestQuickCapture: 'vente' });
                router.push('/(app)/(tabs)/');
              }}
              onSelectDebt={() => {
                beginForkNavigation();
                router.push({ pathname: '/(app)/(tabs)/vendre', params: { mode: 'credit' } });
              }}
            />
          )}
        </>
      )}
      <AppToastContainer />
      <SaveConfirmation />
      <ActivationPrimingSheet />
    </>
  );
}

