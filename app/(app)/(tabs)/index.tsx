import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useReduceMotion } from '@/src/hooks/useReduceMotion';
import { InputAccessoryView, KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, Share, StyleSheet, TextInput, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { runOnJS } from 'react-native-reanimated';
import { Screen } from '@/src/components/ui/Screen';
import { OfflineNotice } from '@/src/components/ui/OfflineNotice';
import { QuickCaptureSheet } from '@/src/components/QuickCaptureSheet';
import { FirstRunHeroOverlay } from '@/src/components/FirstRunHeroOverlay';
import { PaymentReminderAsker } from '@/src/components/PaymentReminderAsker';
import { DebtReminderDeniedCard } from '@/src/components/DebtReminderDeniedCard';
import { router, useFocusEffect } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { Button } from '@/src/components/ui/Button';
import { Card } from '@/src/components/ui/Card';
import { Pill } from '@/src/components/ui/Pill';
import { Text } from '@/src/components/ui/Text';
import { useTheme, radius, spacing, floatingTabBarClearance } from '@/src/theme';
import type { Palette } from '@/src/theme';
import { trackEvent } from '@/lib/analytics';
import { useAuthStore } from '@/stores/auth';
import { useProductStore } from '@/stores/products';
import { useVentesStore } from '@/stores/ventes';
import { useChatStore } from '@/stores/chat';
import { useSupportChatStore } from '@/stores/supportChat';
import { isFounderPhone } from '@/src/utils/founder';
import { useRapportsStore, fetchPaired } from '@/stores/rapports';
import { useSyncStore } from '@/stores/sync';
import { useEquipeStore } from '@/stores/equipe';
import { useInvestorStore } from '@/stores/investor';
import type { MemberProductStake } from '@/src/types';
import { formatAmount, formatAmountInput, parseAmountInput, formatAmountValue } from '@/src/utils/format';
import { debtAgeTier } from '@/src/utils/clientReminder';
import { supabase } from '@/lib/supabase';
import { isNetworkError, withTimeout } from '@/lib/sync';
import { saveDashboardKpiCache, getDashboardKpiCache, saveBestSellersCache, getBestSellersCache, getKV, setKV } from '@/lib/db';
import { computeLocalKpis as kpisFromLocalState, applyKpiOverlay } from '@/src/utils/salesTotals';
import { buildReportDelta, applyTopSellers, type OverlaySale } from '@/lib/pendingOverlay';
import { SkeletonKpiGrid } from '@/src/components/ui/SkeletonPlaceholder';
import { haptics } from '@/lib/haptics';
import { toast } from '@/stores/toast';
import { buildInviteLink, buildInviteMessage } from '@/stores/inviter';
import { FAILURE_COPY } from '@/src/utils/failureCopy';
import { todayIso } from '@/src/utils/dates';
import { homeComparison } from '@/src/utils/dashboardNarrative';
import { getKpiSnapshot, setKpiSnapshot } from '@/src/utils/kpiSnapshot';


interface KPIs {
  revenue_today: number;
  revenue_yesterday: number;
  revenue_month: number;
  // Last calendar month's paid revenue (get_dashboard_kpis, migration_v240).
  // Optional: an older cache, or a server that hasn't got v240 yet, simply
  // omits it — read as 0 (then "Ce mois" shows whenever there is revenue).
  revenue_last_month?: number;
  sales_today: number;
  credit_total: number;
  credit_count: number;
  low_stock: number;
  // Lifetime — the business's very first real (status='paye') sale ever,
  // null if none yet. Drives the one-time "Première vente notée ✓"
  // acknowledgment; never scoped to today/this month like the rest of KPIs.
  first_sale_at: string | null;
}

interface BestSeller {
  product_id: string;
  product_name: string;
  total_qty: number;
  total_revenue: number;
}

function fmt(n: number, cur: string) {
  return formatAmount(n, cur);
}

// Same clamped-to-zero "days ago" logic as clients/index.tsx's getDaysAgo —
// duplicated rather than shared, matching that file's own precedent (its
// sibling clients/[name].tsx also computes this locally rather than
// exporting a shared helper with no theme/store context of its own).
function getDaysAgo(dateStr: string): number {
  const d = dateStr.includes('T') ? new Date(dateStr) : new Date(dateStr + 'T00:00:00');
  return Math.max(0, Math.floor((Date.now() - d.getTime()) / (1000 * 60 * 60 * 24)));
}

// Maps the shared age tier to this screen's palette tokens — age escalates
// the color, never the amount itself (see clients/index.tsx's own
// debtAgeColor for the same reasoning).
function debtAgeColor(days: number, palette: Palette): string {
  const tier = debtAgeTier(days);
  if (tier === 'urgent') return palette.recouvrementOwed;
  if (tier === 'attention') return palette.recouvrementPending;
  return palette.textSecondary;
}

// Invisible strip along the left edge that catches the swipe-to-open-drawer
// gesture — matches the touch-target width iOS itself uses for its own
// edge-swipe-back gesture. activeOffsetX(15)/failOffsetY(20) mirror the
// swipe-to-reply gesture in discussions.tsx: a small horizontal threshold
// before claiming the gesture, generous vertical tolerance so it doesn't
// fight the KPI ScrollView underneath.
const EDGE_SWIPE_WIDTH = 24;
// Approximate height of the header row (menu icon + business name) below
// the safe area — the catcher starts after insets.top + this, not a flat
// guess, so it can't creep into the header's own tap targets on devices
// with a taller inset.
const HEADER_ROW_HEIGHT = 56;
const EDGE_SWIPE_OPEN_DISTANCE = 40;
const EDGE_SWIPE_OPEN_VELOCITY = 600;

// iOS-only: suppresses the OS's auto-injected floating "Done" pill above
// the numeric keyboard — the withdraw sheet's "Envoyer la demande" button
// sits immediately below the field, always visible with no scrolling.
const WITHDRAW_SHEET_SILENT_ACCESSORY_ID = 'dashboard-withdraw-sheet-silent-accessory';

type DayPart = 'morning' | 'active' | 'evening' | 'night';

function getDayPart(): DayPart {
  const h = new Date().getHours();
  if (h >= 5 && h < 12) return 'morning';
  if (h >= 12 && h < 17) return 'active';
  if (h >= 17 && h < 21) return 'evening';
  return 'night';
}

function KpiCard({ label, value, sub, onPress, tone, icon }: {
  label: string; value: string; sub?: string; onPress?: () => void;
  tone?: 'success' | 'warning'; icon?: React.ComponentProps<typeof Ionicons>['name'];
}) {
  const { palette } = useTheme();
  return (
    <Card onPress={onPress} elevated={!!tone} style={{ gap: spacing[1] }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing[2] }}>
        {tone && icon ? (
          <View style={{ width: 26, height: 26, borderRadius: 13, backgroundColor: palette[tone], alignItems: 'center', justifyContent: 'center' }}>
            <Ionicons name={icon} size={14} color={palette.textInverse} />
          </View>
        ) : null}
        <Text variant="caption" color="secondary" style={{ flex: 1 }}>{label}</Text>
      </View>
      <Text variant="amountLarge" style={tone ? { color: palette[tone] } : undefined}>{value}</Text>
      {sub ? <Text variant="caption" color="secondary">{sub}</Text> : null}
    </Card>
  );
}

export default function AccueilScreen() {
  const reduceMotion = useReduceMotion();
  const { palette } = useTheme();
  const insets = useSafeAreaInsets();
  const styles = useMemo(() => makeStyles(palette, insets.bottom), [palette, insets.bottom]);
  const session = useAuthStore(s => s.session);
  const openBusinessPicker = useAuthStore(s => s.openBusinessDrawer);
  const business = session?.activeBusiness;
  const role = session?.activeMembership?.role;
  const isInvestisseur = role === 'investisseur';
  const isVendeur = role === 'vendeur';
  const businessId = business?.id ?? '';
  const userId = session?.user.id ?? '';
  const membershipId = session?.activeMembership?.id ?? '';
  const currency = business?.currency ?? 'GNF';
  const memberships = session?.memberships ?? [];
  const totalUnread = useChatStore(s => s.boutiqueUnread + s.marcheUnread);
  const isFounder = isFounderPhone(session?.user.phone);
  // Prefetches founder conversations (across every business — see
  // loadFounderConversations) purely so the lateral drawer's "Service
  // client" unread dot (BusinessDrawer, driven by founderUnreadTotal) is
  // fresh as soon as the founder opens Accueil, not only after they've
  // visited the inbox once this session.
  const loadFounderConversations = useSupportChatStore(s => s.loadFounderConversations);

  const edgeSwipeOpenDrawer = Gesture.Pan()
    .activeOffsetX([15, 999])
    .failOffsetY([-20, 20])
    .onEnd((e) => {
      if (e.translationX > EDGE_SWIPE_OPEN_DISTANCE || e.velocityX > EDGE_SWIPE_OPEN_VELOCITY) {
        runOnJS(openBusinessPicker)();
        runOnJS(haptics.tap)();
      }
    });

  useEffect(() => {
    if (isFounder) void loadFounderConversations();
  }, [isFounder]);

  // ─── Inviter — word-of-mouth share ───────────────────────────────────────
  // Native share sheet with the link patron.kolilink.com/invite/?i=<my-id>
  // (the ?i= form is a 200 page, so WhatsApp can build a preview card).
  // No code, no expiry, no server round trip — works offline up to the share.
  const [inviting, setInviting] = useState(false);
  const handleInvite = useCallback(async () => {
    if (inviting || !userId) return;
    setInviting(true);
    haptics.tap();
    try {
      const message = buildInviteMessage(buildInviteLink(userId));
      trackEvent('invite_sent', businessId, userId, { source: 'accueil_header' });
      await Share.share({ message });
    } catch {
      // failure: speaks — share sheet failed to open: shareNotOpened toast
      toast.warning(FAILURE_COPY.shareNotOpened.what);
    } finally {
      setInviting(false);
    }
  }, [inviting, businessId, userId]);

  const { products, fetchProducts } = useProductStore();
  const ventesSales = useVentesStore(s => s.sales);
  const { snapshot: rapportsSnapshot, fetchReportsSnapshot } = useRapportsStore();
  const { fetchMemberScope } = useEquipeStore();
  const { balance, payouts, saving: investorSaving, fetchBalance, fetchPayouts, requestPayout } = useInvestorStore();
  // `kpisBase` = the last server read (or its cache), never touched by the
  // outbox; `kpis` = what is shown = base + what the outbox still holds. See
  // src/utils/salesTotals.ts (applyKpiOverlay) for why the two never diverge
  // from the lists.
  const [kpisBase, setKpisBase] = useState<KPIs | null>(null);
  // Seeded from the module-scope snapshot when this is the SAME business (a
  // remount after the lock screen): the numbers are on screen from the very
  // first paint. A different business, or no snapshot yet, starts empty.
  const [kpis, setKpis] = useState<KPIs | null>(() => getKpiSnapshot<KPIs>(businessId));
  // Raw server (or cached) month ranking, before pending-sale deltas and the
  // >= 2 filter — `bestSellers` below is derived from this + the overlay.
  const [bestSellersBase, setBestSellersBase] = useState<BestSeller[]>([]);
  // No skeleton when the first paint already has this business's numbers.
  const [loading, setLoading] = useState(() => getKpiSnapshot<KPIs>(businessId) === null);
  const [isOffline, setIsOffline] = useState(false);
  const [investorScope, setInvestorScope] = useState<MemberProductStake[]>([]);

  // Withdrawal sheet
  const [showWithdrawSheet, setShowWithdrawSheet] = useState(false);
  const [withdrawAmountStr, setWithdrawAmountStr] = useState('');

  // Alpha's dashboard entry point is the plain "A" header icon only (see
  // header below) — the floating glow-ring pill that used to sit docked to
  // the bottom of this screen was removed 2026-09-02: it read as too loud/
  // attention-grabbing for the home screen and ate real vertical space above
  // the tab bar, out of step with this app's restrained-color redesign.
  // Real product tradeoff, taken deliberately: the header icon is a quieter
  // "jump back into the conversation" affordance, not an inviting "ask
  // something new" prompt the way the pill was — revisit if Alpha engagement
  // from Accueil drops noticeably.

  const loadedForRef = useRef<string | null>(null);

  const isOwner = !isInvestisseur && !isVendeur;

  // null = not yet checked, true = dismissed, false = active
  const [onboardingDismissed, setOnboardingDismissed] = useState<boolean | null>(null);
  const [showCarnetSheet, setShowCarnetSheet] = useState(false);
  const [showQuickCapture, setShowQuickCapture] = useState(false);
  const [quickCaptureClientName, setQuickCaptureClientName] = useState<string | undefined>(undefined);
  const [quickCaptureMode, setQuickCaptureMode] = useState<'credit' | 'vente'>('credit');
  const [isPrivate, setIsPrivate] = useState(false);
  // Debt card's zero-debts CTA opens the exact same single-purpose form the
  // first-run gate uses — "the deferred hero action," not a separate flow.
  // Independent of _layout.tsx's heroBusinessId latch (that one only governs
  // the once-per-business gate's own eligibility); this is a plain,
  // repeatable manual trigger, safe to open any time credit_count reads 0.
  const [showDebtCapture, setShowDebtCapture] = useState(false);
  // Bumped by PaymentReminderAsker's onDenied — see DebtReminderDeniedCard's
  // own comment for why this signal has to exist at all.
  const [debtDeniedRefresh, setDebtDeniedRefresh] = useState(0);

  // Helpers: when privacy mode is on, replace money amounts with bullets
  const amtOrMask = (n: number) => isPrivate ? `••••• ${currency}` : fmt(n, currency);
  const rawOrMask = (n: number) => isPrivate ? '•••••' : formatAmountValue(n, currency);

  useEffect(() => {
    if (!userId || !businessId || !isOwner) { setOnboardingDismissed(true); return; }
    // Reset to "unknown" the instant businessId changes, before the async
    // KV read below resolves. Switching business in-session (as opposed to
    // a cold start) doesn't remount this screen, so without this line
    // onboardingDismissed keeps holding whatever it last resolved to for
    // the PREVIOUS business until the new lookup finishes — showOnboarding
    // (and the mark-done/carnet-sheet effects that key off it) would
    // briefly judge the newly-active business using a different business's
    // state otherwise.
    setOnboardingDismissed(null);
    const key = `onboarding_done_${userId}_${businessId}`;
    getKV(key).then(val => {
      if (val !== null) { setOnboardingDismissed(true); return; }
      // Auto-dismiss for businesses older than 7 days — they predate this onboarding flow
      const ageMs = business?.created_at ? Date.now() - new Date(business.created_at).getTime() : Infinity;
      if (ageMs > 7 * 24 * 60 * 60 * 1000) {
        setKV(key, '1').catch(() => { });
        setOnboardingDismissed(true);
      } else {
        setOnboardingDismissed(false);
      }
    }).catch(() => setOnboardingDismissed(true));
  }, [userId, businessId, isOwner, business?.created_at]);

  // Show carnet import sheet once — but only once onboarding is genuinely
  // dismissed (both steps done, or the 7-day grandfather). Showing this
  // alongside the activation fork would be exactly the double-nudge
  // confusion both were designed to avoid; in practice the two never
  // overlap by construction — the fork requires the business to still be
  // empty, this requires it not to be.
  useEffect(() => {
    if (!userId || !businessId || !isOwner) return;
    if (onboardingDismissed !== true) return; // wait until fully dismissed
    const ageMs = business?.created_at ? Date.now() - new Date(business.created_at).getTime() : Infinity;
    if (ageMs > 7 * 24 * 60 * 60 * 1000) return;
    const key = `carnet_prompt_seen_${userId}_${businessId}`;
    getKV(key).then(val => {
      if (val !== null) return;
      void setKV(key, '1');
      setShowCarnetSheet(true);
    }).catch(() => { });
  }, [userId, businessId, isOwner, business?.created_at, onboardingDismissed]);

  const step2Done = products.length > 0;
  // Any real sale ever (paye OR credit) counts as "done" — using kpis.revenue_month here
  // used to miss credit sales entirely (that RPC only sums status='paye') and reset every
  // calendar month, so a merchant whose first sale was on credit, or made near month-end,
  // kept seeing "Faire une vente" as an unfinished step despite already having made one.
  const step3Done = ventesSales.some(s => s.business_id === businessId && s.status !== 'annule');
  const showOnboarding = isOwner && onboardingDismissed === false;

  // The activation fork itself ("On enregistre quoi aujourd'hui ?") now
  // lives in app/(app)/_layout.tsx, not here — it needs to show on top of
  // ANY screen (Catalogue, Vendre, ...) while a business is still empty and
  // under 24h old, not just Accueil, so it's evaluated at the root layout
  // that wraps every screen instead of one tab. step2Done/step3Done stay
  // here only because the mark-done effect below (a different, narrower
  // concern — the 7-day grandfather + carnet-sheet gating) still needs them.

  // Permanently write flag once all steps complete. This write is
  // effectively irreversible (no in-app way to clear it) — so it re-verifies
  // against LIVE store state right before writing, not the step2Done/
  // step3Done captured by this render. Effects always run a tick or more
  // after the render that scheduled them; if a business switch happened in
  // that gap, the closed-over values here could still belong to whichever
  // business was active when this render happened, not the one actually
  // named in the businessId captured alongside them. Re-reading
  // .getState() fresh, for the same businessId this effect is about to
  // write against, is the only way to be sure the two actually match.
  useEffect(() => {
    if (!showOnboarding || loading || !step2Done || !step3Done) return;
    const liveProducts = useProductStore.getState().products;
    const liveSales = useVentesStore.getState().sales;
    const liveStep2 = liveProducts.length > 0;
    const liveStep3 = liveSales.some(s => s.business_id === businessId && s.status !== 'annule');
    if (!liveStep2 || !liveStep3) return;
    setKV(`onboarding_done_${userId}_${businessId}`, '1').catch(() => { });
    setOnboardingDismissed(true);
  }, [showOnboarding, loading, step2Done, step3Done, userId, businessId]);

  const loadAll = useCallback(async () => {
    if (!businessId) return;
    setIsOffline(false);
    if (loadedForRef.current !== businessId) {
      // A same-business remount (after the lock screen) already has its numbers
      // on screen from the snapshot: skip the blanking entirely and refresh in
      // the background. Only a REAL business change blanks and shows the
      // skeleton — stale data from the previous business must never sit next to
      // new-business content.
      const haveSnapshot = getKpiSnapshot<KPIs>(businessId) !== null;
      if (!haveSnapshot) {
        setLoading(true);
        setBestSellersBase([]);
        setKpis(null);
        setKpisBase(null);
      }
      const cachedKpis = await getDashboardKpiCache(businessId) as KPIs | null;
      if (cachedKpis) {
        setKpisBase(cachedKpis);
        if (!haveSnapshot) {
          const shown = await withOutbox(cachedKpis);
          setKpis(shown);
          setKpiSnapshot(businessId, shown);
          setLoading(false);
        }
      }
    }
    const today = new Date();
    const monthStart = new Date(today.getFullYear(), today.getMonth(), 1);
    const daysThisMonth = Math.max(1, Math.floor((today.getTime() - monthStart.getTime()) / 86_400_000));
    void fetchReportsSnapshot(businessId, daysThisMonth, role ?? 'administrateur', userId);
    // loadKpis()'s offline fallback reads useVentesStore.getState().sales directly
    // (to reflect today's sales even mid-outage) — but the dashboard never otherwise
    // touches that store, only the Ventes history screen does. Without seeding it
    // here first, a user who opens straight to Accueil and never visits Ventes this
    // session sees revenue_today/credit_total silently reset to 0 the moment they
    // go offline, even though a valid cached total exists. Gate loadKpis() behind
    // this fetch (not just parallel) so the fallback never runs against an empty array.
    const ventesReady = useVentesStore.getState().fetchSales(businessId, isVendeur ? userId : undefined);
    try {
      await Promise.all([
        fetchProducts(businessId, userId, membershipId, role),
        ventesReady.then(() => loadKpis()),
        // Best sellers no longer render on Accueil; only an investisseur's own
        // stake figures ("Vos produits") still read them.
        isInvestisseur ? loadBestSellers() : Promise.resolve(),
      ]);
      if (isInvestisseur && membershipId) {
        fetchMemberScope(membershipId).then(rows => setInvestorScope(rows)).catch(() => { });
        fetchBalance(businessId, userId);
        fetchPayouts(businessId, userId);
      }
    } catch (err) {
      // failure: control-flow — network error flips the offline banner, which speaks
      if (isNetworkError(err)) setIsOffline(true);
    } finally {
      setLoading(false);
      loadedForRef.current = businessId;
    }
  }, [businessId, userId, isInvestisseur, isVendeur, membershipId, role]);

  // Any change to the sales the lists read (a local write, a refetch) re-derives
  // the dashboard from the same server base — no remount, no refocus. Held while
  // a drain is running: ops leave the outbox before the next server read lands,
  // and recomputing in that gap would drop them from the total.
  const syncing = useSyncStore(s => s.syncing);
  useEffect(() => {
    if (!kpisBase || syncing) return;
    let alive = true;
    void withOutbox(kpisBase).then(k => { if (alive) setKpis(k); }).catch(() => { /* keep what is shown */ });
    return () => { alive = false; };
  }, [ventesSales, kpisBase, syncing]);

  // A sync pass that sent something: re-read the server base now, so the numbers
  // settle on the server's truth without waiting for a refocus.
  const syncedCount = useSyncStore(s => s.lastResult?.synced ?? 0);
  const lastResult = useSyncStore(s => s.lastResult);
  const seenResult = useRef<unknown>(useSyncStore.getState().lastResult);
  useEffect(() => {
    if (!lastResult || seenResult.current === lastResult) return;
    seenResult.current = lastResult;
    if (syncedCount > 0) loadAll();
  }, [lastResult, syncedCount, loadAll]);

  // Reload every time this tab gains focus (catches sales made in caisse)
  useFocusEffect(
    useCallback(() => {
      loadAll();
    }, [loadAll]),
  );

  // FirstRunHeroOverlay (app/(app)/_layout.tsx) bumps this the moment it
  // closes. It's a plain RN Modal outside the tab navigator, so closing it
  // never actually unfocuses/refocuses Accueil — useFocusEffect above never
  // fires for it, which is why a debt saved there used to only ever show up
  // after a real business switch. Skips the very first render (ref, not
  // state) so this doesn't fire a redundant second loadAll() alongside the
  // one useFocusEffect already runs on initial mount.
  const homeRefreshToken = useAuthStore(s => s.homeRefreshToken);
  const homeRefreshMounted = useRef(false);
  useEffect(() => {
    if (!homeRefreshMounted.current) { homeRefreshMounted.current = true; return; }
    loadAll();
  }, [homeRefreshToken, loadAll]);

  // Screens outside the tab navigator (Clients, ...) set this cross-cutting
  // signal and navigate here, since they have no direct reference to this
  // screen's own showQuickCapture state. Open the sheet in that mode, then clear the
  // signal so it doesn't re-fire on some unrelated future re-render.
  const requestQuickCapture = useAuthStore(s => s.requestQuickCapture);
  useEffect(() => {
    if (!requestQuickCapture) return;
    setQuickCaptureMode(requestQuickCapture);
    setQuickCaptureClientName(useAuthStore.getState().requestQuickCaptureClientName ?? undefined);
    setShowQuickCapture(true);
    useAuthStore.setState({ requestQuickCapture: null, requestQuickCaptureClientName: null });
  }, [requestQuickCapture]);

  // Local-first (§6 of the offline-first rewrite): computes KPIs purely
  // from local state (the last-cached snapshot + useVentesStore.sales,
  // which now always reflects the current pending-overlay merge — see
  // stores/ventes.ts's refreshPendingOverlay). This used to be the
  // offline FALLBACK, only ever reached after a live RPC call had already
  // lost its race against withTimeout's 12s. It's now the PRIMARY path,
  // shown immediately, every time, before any network call is even
  // attempted — the network is strictly a background refresh from here on.
  const computeLocalKpis = async (): Promise<KPIs> => {
    const cached = await getDashboardKpiCache(businessId) as KPIs | null;
    const { products: pOffline, variantsByProduct: vOffline } = useProductStore.getState();
    return kpisFromLocalState({
      cached,
      sales: useVentesStore.getState().sales,
      products: pOffline,
      variantsByProduct: vOffline,
    });
  };

  // Server base + whatever the outbox still holds (never a server number shown
  // as current while ops are pending).
  const withOutbox = async (base: KPIs): Promise<KPIs> => {
    const { baseline, overlay } = await useVentesStore.getState().readOverlayPair();
    return applyKpiOverlay(base, overlay, baseline);
  };

  const loadKpis = async () => {
    // Local-first: render immediately from the last server base + the outbox,
    // before touching the network. With no base at all (first ever open,
    // nothing cached) the list-derived estimate stands in.
    const cachedBase = await getDashboardKpiCache(businessId) as KPIs | null;
    if (cachedBase) {
      setKpisBase(cachedBase);
      const shown = await withOutbox(cachedBase);
      setKpis(shown);
      setKpiSnapshot(businessId, shown);
    } else {
      const local = await computeLocalKpis();
      setKpis(local);
      setKpiSnapshot(businessId, local);
    }

    // Background refresh. The read is paired with the outbox (fetchPaired:
    // waits out a running drain and retries when the queue moved during the
    // call), so the base never already contains an op the overlay will add
    // again. A network failure is a no-op — what is on screen is already
    // base + outbox.
    try {
      const localDate = todayIso(); // YYYY-MM-DD device local date
      const { result: { data, error } } = await fetchPaired(
        () => withTimeout(
          supabase.rpc('get_dashboard_kpis', {
            p_business_id: businessId,
            p_today: localDate,
          }),
        ),
        r => !!r.error,
      );
      if (error) {
        if (isNetworkError(error)) return;
        throw error;
      }
      const d = data as Record<string, number | string | null>;
      const freshKpis: KPIs = {
        revenue_today: Number(d.revenue_today) / 100,
        revenue_yesterday: Number(d.revenue_yesterday) / 100,
        revenue_month: Number(d.revenue_month) / 100,
        revenue_last_month: Number(d.revenue_last_month ?? 0) / 100,
        sales_today: Number(d.sales_today),
        credit_total: Number(d.credit_total) / 100,
        credit_count: Number(d.credit_count),
        low_stock: Number(d.low_stock),
        first_sale_at: (d.first_sale_at as string | null) ?? null,
      };
      setKpisBase(freshKpis);
      void saveDashboardKpiCache(businessId, freshKpis);   // server truth only — never the overlaid figures
      const shownFresh = await withOutbox(freshKpis);
      setKpis(shownFresh);
      setKpiSnapshot(businessId, shownFresh);   // the DISPLAYED (post-overlay) numbers
    } catch (err) {
      // failure: control-flow — network error: base + outbox already on screen; anything else rethrows
      if (!isNetworkError(err)) throw err;
    }
  };

  const loadBestSellers = async () => {
    const now = new Date();
    const monthStart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;

    // Local-first, same as loadKpis: show the last cached base immediately.
    // A failed/offline refresh below must leave it on screen — it used to
    // simply throw, and the section vanished whenever the network did.
    const cachedBase = await getBestSellersCache(businessId) as BestSeller[] | null;
    if (cachedBase) setBestSellersBase(cachedBase);

    try {
      const { data, error: bsErr } = await withTimeout(
        supabase.rpc('get_best_sellers', {
          p_business_id: businessId,
          p_month_start: monthStart,
          p_limit: 5,
        }),
      );
      if (bsErr) {
        if (isNetworkError(bsErr)) return;
        throw bsErr;
      }
      const base: BestSeller[] = (data ?? []).map((r: BestSeller) => ({
        product_id: r.product_id,
        product_name: r.product_name,
        total_qty: Number(r.total_qty),
        total_revenue: Number(r.total_revenue) / 100,
      }));
      setBestSellersBase(base);
      void saveBestSellersCache(businessId, base);
    } catch (err) {
      // failure: control-flow — network error: the cached ranking stays; anything else rethrows
      if (!isNetworkError(err)) throw err;
    }
  };

  // displayed = base + delta from still-pending sales (useVentesStore.sales
  // already carries the outbox overlay), so an offline sale shows up too.
  const bestSellers = useMemo<BestSeller[]>(() => {
    const now = new Date();
    const monthStart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
    const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    // The shared report-delta builder (lib/pendingOverlay.ts) — the same one
    // Rapports uses — so the two screens cannot drift on what a pending sale adds.
    const { topSellers } = buildReportDelta(
      { sales: ventesSales as unknown as OverlaySale[] },
      { start: monthStart, end: today, currentUserId: null, knownProductIds: new Set(products.map(p => p.id)) },
    );
    return applyTopSellers(bestSellersBase, topSellers);
  }, [bestSellersBase, ventesSales, products]);

  const lowStock = kpis?.low_stock ?? 0;

  // Oldest-debt aging for the "clients qui doivent" card — computed
  // client-side from the already-fetched sales list (same per-client
  // grouping clients/index.tsx uses) rather than adding a new RPC field,
  // since this is purely a "is anything genuinely old" signal, not a new
  // source of truth for the total owed (kpis.credit_total already covers that).
  const creditAging = useMemo(() => {
    const oldestByClient = new Map<string, string>();
    for (const s of ventesSales) {
      if (s.status !== 'credit') continue;
      const remaining = s.total_amount - (s.discount_amount ?? 0) - (s.amount_paid ?? 0);
      if (remaining <= 0.01) continue;
      const name = s.customer_name?.trim();
      const key = s.client_id ?? name;
      if (!key) continue;
      const saleDate = s.sale_date ?? s.created_at.split('T')[0];
      const existing = oldestByClient.get(key);
      if (!existing || saleDate < existing) oldestByClient.set(key, saleDate);
    }
    let agingCount = 0;
    let oldestDays = 0;
    for (const dateStr of oldestByClient.values()) {
      const days = getDaysAgo(dateStr);
      if (days >= 7) agingCount++;
      if (days > oldestDays) oldestDays = days;
    }
    return { agingCount, oldestDays };
  }, [ventesSales]);

  // Investor gain: sum profit_share% of each assigned product's gross margin this month.
  // Gross margin per product = revenue - (qty sold × cost_price). Expenses are business-level
  // overhead and are not deducted here since the stake is in individual product margins.
  const investorGain = useMemo(() => {
    if (!investorScope.length) return 0;
    return investorScope.reduce((total, stake) => {
      if (stake.profit_share <= 0) return total;
      const bs = bestSellers.find(b => b.product_id === stake.product_id);
      if (!bs) return total;
      const product = products.find(p => p.id === stake.product_id);
      const costPrice = product?.cost_price ?? 0;
      const productProfit = bs.total_revenue - bs.total_qty * costPrice;
      return total + (stake.profit_share / 100) * productProfit;
    }, 0);
  }, [investorScope, bestSellers, products]);

  const pendingPayout = payouts.find(p => p.status === 'en_attente');

  const monthOrderCount = rapportsSnapshot?.period_order_count ?? 0;

  const salesCount = kpis?.sales_today ?? 0;
  const hasSoldToday = salesCount > 0;
  const delta = (kpis?.revenue_today ?? 0) - (kpis?.revenue_yesterday ?? 0);

  const dayPart = getDayPart();
  const dayGreeting = dayPart === 'evening' ? 'Voici votre journée'
      : null;
  // Never prints "0 ventes" — a zero-sales day drops the count entirely
  // rather than stating it, same reasoning as the debt card's zero-state
  // below: a quiet fact stated as a number reads as a verdict, a CTA reads
  // as an invitation.
  const heroCaption = dayPart === 'morning'
    ? (hasSoldToday ? `Bonjour · ${salesCount} vente${salesCount !== 1 ? 's' : ''}` : 'Bonjour')
    : dayPart === 'evening'
      ? (hasSoldToday ? `Ce soir · ${salesCount} vente${salesCount !== 1 ? 's' : ''}` : 'Ce soir')
      : (hasSoldToday ? `${salesCount} vente${salesCount !== 1 ? 's' : ''} aujourd'hui` : "Aujourd'hui");

  const isEvening = dayPart === 'evening' || dayPart === 'night';
  // "Bienvenue" used to be keyed on the business's creation date — wrong,
  // since a business created today but already mid-testing (or genuinely
  // busy from hour one) would show "Bienvenue" right alongside real sales
  // already on the board. The real signal is whether she has ever recorded
  // a real (status='paye') sale at all — get_dashboard_kpis' first_sale_at
  // is business-wide and RLS-bypassing (SECURITY DEFINER), so a vendeur
  // sees the business's true first sale, not just their own. A credit debt
  // deliberately does NOT count — submit_carnet_debt writes status='credit',
  // which the RPC's MIN(paid_at) WHERE status='paye' never touches, so a
  // business whose only activity so far is a debt still reads "Bienvenue."
  const firstSaleAt = kpis?.first_sale_at ? new Date(kpis.first_sale_at) : null;
  const hasEverSold = firstSaleAt !== null;
  // "Local midnight" per the spec — toDateString() compares in device local
  // time, same technique the old isBusinessCreatedToday check already used.
  const isFirstSaleToday = hasEverSold && firstSaleAt.toDateString() === new Date().toDateString();
  const deltaAmt = isPrivate ? `••••• ${currency}` : fmt(Math.abs(delta), currency);
  // The ONLY conditional line here, deliberately — no time-of-day greeting
  // variants, no tips, no streaks. Once the first-sale day has passed, this
  // never says "Première vente" again for this business (falls through to
  // the ordinary comparison instead — see below) — a
  // one-time acknowledgment, not a recurring one.
  const monthRevenue = kpis?.revenue_month ?? 0;
  const lastMonthRevenue = kpis?.revenue_last_month ?? 0;
  // The home speaks ONLY on genuine gains. "Même niveau qu'hier" is gone (flat
  // day → nothing), a down day shows nothing, and "Ce mois : X" appears only
  // when this month is strictly ahead of last month (never zero, never lower
  // or equal). "Bienvenue" / "Première vente enregistrée ✓" are one-time
  // acknowledgments, untouched. See src/utils/dashboardNarrative.ts.
  const showMonthLine = monthRevenue > lastMonthRevenue;
  const comparison = homeComparison({ hasEverSold, isFirstSaleToday, isEvening, delta, monthRevenue, lastMonthRevenue });
  const showDeltaPill = comparison.kind === 'pill';
  const comparisonText =
    comparison.kind === 'welcome' ? 'Bienvenue sur Patron'
    : comparison.kind === 'first_sale' ? 'Première vente enregistrée ✓'
    : comparison.kind === 'month' ? `Ce mois : ${amtOrMask(monthRevenue)}`
    : '';

  return (
    <KeyboardAvoidingView style={{ flex: 1, backgroundColor: palette.background }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <Screen tab>
        {/* Swipe right from the left edge to open the business drawer —
          complements the header menu icon's tap-to-open. */}
        <GestureDetector gesture={edgeSwipeOpenDrawer}>
          {/* top was a flat 64 — didn't account for the device's real safe-area
            inset, so on a phone with a taller inset (Dynamic Island models
            especially) this could still reach up into the header row and
            steal the hamburger icon's taps before the underlying Pressable
            ever saw them — reported as the icon having zero press feedback,
            not just "opens nothing", which pointed at a touch being
            intercepted rather than a broken onPress. insets.top is measured
            fresh per device now, not guessed. */}
          <View style={[styles.edgeSwipeCatcher, { top: insets.top + HEADER_ROW_HEIGHT }]} pointerEvents="box-only" />
        </GestureDetector>

        {/* One-time carnet import sheet shown after business creation */}
        <Modal
          visible={showCarnetSheet}
          transparent
          animationType={reduceMotion ? 'none' : 'slide'}
          onRequestClose={() => setShowCarnetSheet(false)}
          statusBarTranslucent
          navigationBarTranslucent
        >
          <View style={styles.sheetBackdrop}>
            <Pressable style={StyleSheet.absoluteFill} onPress={() => setShowCarnetSheet(false)} />
            <View style={[styles.sheetPanel, { backgroundColor: palette.surface }]}>
              <View style={[styles.sheetHandle, { backgroundColor: palette.border }]} />
              <Text variant="h3" style={styles.sheetTitle}>Votre commerce est prêt !</Text>
              <Text variant="body" color="secondary" style={styles.sheetBody}>
                Des gens vous doivent de l'argent ?
              </Text>
              <Button
                label="Oui, les noter →"
                size="lg"
                fullWidth
                onPress={() => {
                  setShowCarnetSheet(false);
                  router.push('/(app)/onboarding/carnet');
                }}
                style={{ marginTop: spacing[2] }}
              />
              <Button
                label="Pas maintenant"
                variant="ghost"
                fullWidth
                onPress={() => setShowCarnetSheet(false)}
              />
            </View>
          </View>
        </Modal>

        {isOffline && <OfflineNotice offlineSince={null} onRetry={() => loadAll()} />}

        <ScrollView style={{ flex: 1 }} contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>

          {/* Header */}
          <View style={styles.header}>
            <View style={{ flexDirection: 'row', alignItems: 'center' }}>
              <Pressable
                onPress={openBusinessPicker}
                hitSlop={10}
                style={({ pressed }) => [{ opacity: pressed ? 0.5 : 1 }]}
                accessibilityLabel="Changer de commerce"
                accessibilityRole="button"
              >
                <Ionicons name="menu" size={24} color={palette.textPrimary} />
              </Pressable>
              <Text variant="h4" style={{ marginLeft: 12 }} numberOfLines={1}>
                {business?.name}
              </Text>
            </View>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing[2] }}>
              {/* Inviter pill — the single invite-a-friend entry point. Replaces
                  the former "A" header shortcut (Alpha) here; Alpha now lives
                  in the lateral drawer as "Assistant IA" (BusinessDrawer footer),
                  same destination, no stranded function. The discussions icon
                  to the right stays put. */}
              <Pressable
                onPress={handleInvite}
                disabled={inviting}
                style={({ pressed }) => [styles.invitePill, (pressed || inviting) && { opacity: 0.7 }]}
                accessibilityLabel="Inviter un ami sur Patron"
                accessibilityRole="button"
              >
                <Ionicons name="person-add-outline" size={14} color={palette.textInverse} />
                <Text style={styles.invitePillText}>Inviter</Text>
              </Pressable>
              <Pressable
                onPress={() => router.push('/(app)/discussions')}
                style={({ pressed }) => [styles.chatBtn, { opacity: pressed ? 0.7 : 1 }]}
                accessibilityLabel="Discussions"
                accessibilityRole="button"
              >
                <View style={styles.chatIconBox}>
                  <Ionicons name="chatbubbles-outline" size={24} color={palette.textSecondary} />
                </View>
                {totalUnread > 0 && (
                  <View style={styles.chatBadge}>
                    <Text style={styles.chatBadgeText}>{totalUnread > 99 ? '99+' : String(totalUnread)}</Text>
                  </View>
                )}
              </Pressable>
            </View>
          </View>

          {loading ? (
            <SkeletonKpiGrid />
          ) : isVendeur && products.length === 0 ? (
            /* ── Empty state for vendeur: no products configured yet ── */
            <Card style={styles.welcome}>
              <Text variant="h4" style={{ textAlign: 'center' }}>Aucun produit</Text>
              <Text variant="body" color="secondary" style={{ textAlign: 'center' }}>
                Votre commerce n'a pas encore de produits.{'\n'}
                Contactez votre gérant pour commencer à vendre.
              </Text>
            </Card>

          ) : isInvestisseur ? (
            /* ── INVESTOR HOME ─────────────────────────────────────────────────── */
            <View style={{ gap: spacing[4] }}>

              {/* ── 1. Gains hero ── */}
              {pendingPayout ? (
                <Card elevated style={[styles.heroCard, { backgroundColor: palette.warningLight }]}>
                  <Text variant="caption" style={{ color: palette.warning }}>Demande en cours</Text>
                  <Text variant="amountLarge" style={{ color: palette.textPrimary, fontSize: 44, lineHeight: 56 }}>
                    {formatAmount(pendingPayout.requested_amount, currency)}
                  </Text>
                </Card>
              ) : (
                <Card elevated style={styles.heroCard}>
                  <View style={styles.investorHeroRow}>
                    <View style={{ flex: 1, gap: spacing[1] }}>
                      <Text variant="caption" color="secondary">Vos gains</Text>
                      <Text
                        variant="amountLarge"
                        style={{ color: palette.textPrimary, fontSize: 44, lineHeight: 56 }}
                      >
                        {formatAmount(balance ?? 0, currency)}
                      </Text>
                    </View>
                    {(balance ?? 0) > 0 && (
                      <Pressable
                        onPress={() => {
                          setWithdrawAmountStr(formatAmountInput(String(Math.round(balance ?? 0)), currency));
                          setShowWithdrawSheet(true);
                        }}
                        style={[styles.withdrawBtn, { borderColor: palette.primary }]}
                      >
                        <Text variant="label" style={{ color: palette.primary }}>Retirer</Text>
                      </Pressable>
                    )}
                  </View>
                  <View style={[styles.heroComparison, { marginTop: spacing[3] }]}>
                    <Text variant="caption" color="secondary">
                      {monthOrderCount > 0
                        ? `Ce mois · ${monthOrderCount} vente${monthOrderCount !== 1 ? 's' : ''}`
                        : 'Aucune vente ce mois'}
                    </Text>
                  </View>
                </Card>
              )}

              {/* ── 2. Leurs produits ── */}
              {investorScope.length > 0 && (
                <View style={styles.section}>
                  <Text variant="label" color="secondary" style={styles.sectionTitle}>
                    Vos produits
                  </Text>
                  {investorScope.map(stake => {
                    const bs = bestSellers.find(b => b.product_id === stake.product_id);
                    const product = products.find(p => p.id === stake.product_id);
                    const cost = product?.cost_price ?? 0;
                    const profit = bs ? bs.total_revenue - bs.total_qty * cost : 0;
                    const gain = (stake.profit_share / 100) * profit;
                    return (
                      <View key={stake.product_id} style={styles.bsRow}>
                        <Text variant="body" style={{ flex: 1 }} numberOfLines={1}>{stake.product_name}</Text>
                        <View style={{ alignItems: 'flex-end' }}>
                          {bs && bs.total_revenue > 0 ? (
                            <>
                              <Text variant="label" style={{ color: palette.textPrimary }}>
                                {formatAmount(gain, currency)}
                              </Text>
                              <Text variant="caption" color="secondary">
                                {stake.profit_share}% · {formatAmount(bs.total_revenue, currency)}
                              </Text>
                            </>
                          ) : (
                            <Text variant="caption" color="secondary">{stake.profit_share}% des bénéfices</Text>
                          )}
                        </View>
                      </View>
                    );
                  })}
                  {investorGain > 0 && (
                    <View style={[styles.bsRow, { borderBottomWidth: 0 }]}>
                      <Text variant="body" color="secondary" style={{ flex: 1 }}>Gain estimé ce mois</Text>
                      <Text variant="label" style={{ color: palette.textPrimary }}>
                        {formatAmount(investorGain, currency)}
                      </Text>
                    </View>
                  )}
                </View>
              )}

            </View>

          ) : (
            <>
              {/* ── Zone 1: Hero — Today ── */}
              {dayGreeting ? (
                <Text variant="caption" color="secondary">{dayGreeting}</Text>
              ) : null}
              <Card onPress={() => router.push('/ventes')} elevated style={styles.heroCard}>
                <Pressable
                  onPress={() => setIsPrivate(p => !p)}
                  style={styles.heroEye}
                  hitSlop={12}
                  accessibilityLabel={isPrivate ? 'Afficher le montant' : 'Masquer le montant'}
                  accessibilityRole="button"
                >
                  <Ionicons
                    name={isPrivate ? 'eye-off-outline' : 'eye-outline'}
                    size={18}
                    color={isPrivate ? palette.primary : palette.textSecondary}
                  />
                </Pressable>
                <View style={styles.heroTop}>
                  <Text variant="caption" color="secondary">
                    {heroCaption}
                  </Text>
                  {hasSoldToday ? (
                    <View style={styles.heroAmountRow}>
                      <Text variant="amountLarge" color="success" style={styles.heroAmount}>
                        {rawOrMask(kpis?.revenue_today ?? 0)}
                      </Text>
                      <Text variant="amountLarge" color="success" style={styles.heroCurrency}>
                        {currency}
                      </Text>
                    </View>
                  ) : (
                    // Never a giant "0" — a quiet fact plus an invitation to act
                    // on it, instead of a number that reads as a verdict. Kept
                    // deliberately compact (title + button, no subtitle) — this
                    // sits inside the hero card, not a full-screen empty state.
                    // A real button, not a text link — this is the single most
                    // likely next action on the screen a busy shop owner opens most.
                    <View style={styles.heroEmptyState}>
                      <Text variant="body" color="secondary">Aucune vente aujourd'hui.</Text>
                      <Button
                        label="Enregistrer une vente"
                        onPress={() => { setQuickCaptureMode('vente'); setShowQuickCapture(true); }}
                        size="sm"
                        style={styles.heroEmptyAction}
                      />
                    </View>
                  )}
                </View>
                {showDeltaPill ? (
                  <View style={styles.heroComparison}>
                    <Pill variant="solid" tone="success" icon="arrow-up">
                      {`${deltaAmt} de plus qu'hier`}
                    </Pill>
                  </View>
                ) : comparisonText ? (
                  <View style={styles.heroComparison}>
                    <Text variant="caption" color="secondary">{comparisonText}</Text>
                  </View>
                ) : null}
              </Card>

              {/* ── Zone 2: Attention. The debt card always renders — data
                variant when someone owes money, or the zero-debts CTA (the
                deferred hero action) when nobody currently does — so this
                zone is never entirely empty for the default role branch. The
                low-stock card stays purely conditional: it's a genuine "is
                anything wrong" signal with no equivalent always-useful
                zero-state. The two resolve independently of each other. ── */}
              <View style={styles.attentionZone}>
                {isOwner && <DebtReminderDeniedCard userId={userId} refreshSignal={debtDeniedRefresh} />}
                {(kpis?.credit_count ?? 0) > 0 ? (
                  // Bespoke, not <KpiCard> — this is about PEOPLE who owe
                  // her, not a warning/cash state, so it deliberately skips
                  // KpiCard's colored icon-circle + tone-tinted amount
                  // treatment (still used, unchanged, by "À racheter" below).
                  // The amount is plain foreground; color appears only on
                  // the aging line, and only when a debt is genuinely old.
                  <Card
                    onPress={() => router.push({ pathname: '/(app)/clients', params: { filter: 'doivent' } })}
                    style={{ gap: spacing[1] }}
                  >
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing[2] }}>
                      <Text variant="caption" color="secondary" style={{ flex: 1 }}>
                        {kpis?.credit_count} client{(kpis?.credit_count ?? 0) > 1 ? 's' : ''} vous {(kpis?.credit_count ?? 0) > 1 ? 'doivent' : 'doit'}
                      </Text>
                      <Ionicons name="chevron-forward" size={16} color={palette.textSecondary} />
                    </View>
                    <Text variant="amountLarge">{amtOrMask(kpis?.credit_total ?? 0)}</Text>
                    {creditAging.agingCount > 0 && (
                      <Text variant="caption" style={{ color: debtAgeColor(creditAging.oldestDays, palette) }}>
                        dont {creditAging.agingCount} depuis {creditAging.oldestDays} jour{creditAging.oldestDays > 1 ? 's' : ''}
                      </Text>
                    )}
                  </Card>
                ) : (
                  // The deferred hero action — same single-purpose form the
                  // first-run gate itself uses (see FirstRunHeroOverlay,
                  // opened below via showDebtCapture), reachable again any
                  // time there are currently zero outstanding debts, not just
                  // once at first run.
                  <Card style={{ gap: spacing[2] }}>
                    <Text variant="h4">Qui vous doit de l&apos;argent ?</Text>
                    <Text variant="body" color="secondary">Écrivez son nom et le montant.</Text>
                    <Button
                      label="Enregistrer une dette"
                      onPress={() => setShowDebtCapture(true)}
                      fullWidth
                      size="md"
                      style={{ marginTop: spacing[1] }}
                    />
                  </Card>
                )}
                {lowStock > 0 && (
                  <KpiCard
                    label="À racheter"
                    value={String(lowStock)}
                    sub="Stock bas"
                    onPress={isVendeur ? undefined : () => router.push('/(app)/(tabs)/catalogue')}
                    tone="warning"
                    icon="leaf-outline"
                  />
                )}
              </View>

              {showDebtCapture && (
                <FirstRunHeroOverlay
                  businessId={businessId}
                  userId={userId}
                  currency={currency}
                  onDone={() => { setShowDebtCapture(false); loadAll(); }}
                />
              )}

              {/* ── Zone 3: Month context — hidden in evening/night (already in comparison) ── */}
              {dayPart !== 'evening' && dayPart !== 'night' && showMonthLine ? (
                <Text variant="caption" color="secondary" style={styles.monthLine}>
                  Ce mois : {amtOrMask(monthRevenue)}
                </Text>
              ) : null}
            </>
          )}
        </ScrollView>

        {/* ── Withdrawal sheet ── */}
        <Modal
          visible={showWithdrawSheet}
          transparent
          animationType={reduceMotion ? 'none' : 'slide'}
          onRequestClose={() => setShowWithdrawSheet(false)}
          statusBarTranslucent
          navigationBarTranslucent
        >
          <Pressable style={styles.sheetBackdrop} onPress={() => setShowWithdrawSheet(false)}>
            <Pressable style={[styles.sheetPanel, { backgroundColor: palette.surface }]} onPress={() => { }}>
              <View style={[styles.sheetHandle, { backgroundColor: palette.border }]} />
              <Text variant="h4" style={styles.sheetTitle}>Retirer mes gains</Text>
              <Text variant="caption" color="secondary" style={styles.sheetBody}>
                Disponible : {formatAmount(balance ?? 0, currency)}
              </Text>

              {/* Amount input */}
              <View style={{ width: '100%', gap: spacing[2] }}>
                <Text variant="label">Montant à retirer</Text>
                <View style={[styles.withdrawInput, { borderColor: palette.border, backgroundColor: palette.background }]}>
                  <TextInput
                    style={{ flex: 1, fontSize: 28, fontWeight: '700', color: palette.textPrimary }}
                    value={withdrawAmountStr}
                    onChangeText={v => setWithdrawAmountStr(formatAmountInput(v, currency))}
                    keyboardType="numeric"
                    placeholder="0"
                    placeholderTextColor={palette.textDisabled}
                    selectTextOnFocus
                    inputAccessoryViewID={Platform.OS === 'ios' ? WITHDRAW_SHEET_SILENT_ACCESSORY_ID : undefined}
                  />
                  <Text variant="label" color="secondary">{currency}</Text>
                </View>
              </View>

              <Button
                label="Envoyer la demande" loadingLabel="Envoi"
                fullWidth
                size="lg"
                loading={investorSaving}
                onPress={async () => {
                  const amt = parseAmountInput(withdrawAmountStr, currency);
                  if (!amt || amt <= 0) { toast.warning('Entrez un montant valide'); return; }
                  const balanceVal = balance ?? 0;
                  if (amt > balanceVal) { toast.warning('Montant supérieur à votre solde'); return; }
                  const amtCents = BigInt(Math.round(amt * 100));
                  const ok = await requestPayout(businessId, amtCents);
                  if (ok) {
                    haptics.success();
                    toast.success('Demande envoyée');
                    setShowWithdrawSheet(false);
                    setWithdrawAmountStr('');
                  }
                }}
              />
              <Pressable onPress={() => setShowWithdrawSheet(false)}>
                <Text variant="label" color="secondary">Annuler</Text>
              </Pressable>
            </Pressable>
          </Pressable>
          {Platform.OS === 'ios' && (
            <InputAccessoryView nativeID={WITHDRAW_SHEET_SILENT_ACCESSORY_ID}>
              <View style={{ height: 0 }} />
            </InputAccessoryView>
          )}
        </Modal>

        {/* One-tap capture — the "radical simplicity" entry point. Investisseur
          is read-only (no write access to sale_orders/clients), so it's the
          one role that never sees this. Positioned above the floating tab
          bar the same way catalogue.tsx's/vendre.tsx's own FABs are, plus a
          small extra `spacing[4]` lift on top of `FLOATING_TAB_BAR_CLEARANCE`
          — the bare clearance value read as sitting too close to the bar on
          a real device. A pure shortcut alongside Vendre — nothing about
          the underlying credit/sale flow changes, only how fast it's
          reached from the screen the app actually opens to. */}
        {!isInvestisseur && (
          <Pressable
            onPress={() => {
              trackEvent('quick_capture_opened', businessId, userId, { source: 'accueil_fab' });
              setShowQuickCapture(true);
            }}
            style={({ pressed }) => [styles.quickCaptureFab, pressed && { opacity: 0.82 }]}
            accessibilityLabel="Ajouter une vente ou une dette"
            accessibilityRole="button"
          >
            <Ionicons name="add" size={20} color={palette.textInverse} />
            <Text style={styles.quickCaptureFabLabel}>Ajouter</Text>
          </Pressable>
        )}

        <QuickCaptureSheet
          visible={showQuickCapture}
          onClose={() => {
            // This sheet is a plain RN Modal rendered by Accueil itself — but
            // per FirstRunHeroOverlay's own fix above, a native Modal opening/
            // closing never triggers a real react-navigation focus transition
            // regardless of where in the tree it's mounted, so useFocusEffect
            // alone would leave the day-card/debt-card stale after a credit
            // debt or quick sale recorded here, exactly like that bug. loadAll
            // is cheap and idempotent — a no-op close (nothing was ever
            // recorded this session) just refetches the same numbers.
            setShowQuickCapture(false);
            setQuickCaptureClientName(undefined);
            loadAll();
          }}
          businessId={businessId}
          userId={userId}
          currency={currency}
          initialMode={quickCaptureMode}
          initialClientName={quickCaptureClientName}
        />

        {businessId && userId && (
          <PaymentReminderAsker
            businessId={businessId}
            userId={userId}
            active={isOwner}
            blocked={showQuickCapture || showDebtCapture}
            onDenied={() => setDebtDeniedRefresh(n => n + 1)}
          />
        )}

      </Screen>
    </KeyboardAvoidingView>
  );
}

function makeStyles(p: Palette, bottomInset: number) {
  return StyleSheet.create({
    safe: { flex: 1, backgroundColor: p.background },
    edgeSwipeCatcher: {
      // top is set inline (insets.top + HEADER_ROW_HEIGHT) at the call site
      // — device-aware, not a flat guess. See the comment there.
      position: 'absolute',
      left: 0,
      bottom: 0,
      width: EDGE_SWIPE_WIDTH,
      zIndex: 20,
    },
    content: { padding: spacing[5], gap: spacing[4], paddingBottom: spacing[10] },
    quickCaptureFab: {
      position: 'absolute', bottom: floatingTabBarClearance(bottomInset) + spacing[4], right: spacing[4], zIndex: 10,
      flexDirection: 'row', alignItems: 'center', gap: spacing[2],
      height: 56, paddingHorizontal: spacing[5], borderRadius: radius.full,
      backgroundColor: p.primary,
      shadowColor: p.shadow, shadowOffset: { width: 0, height: 4 },
      shadowOpacity: 0.18, shadowRadius: 8, elevation: 8,
    },
    quickCaptureFabLabel: { fontSize: 15, fontWeight: '600' as const, color: p.textInverse },
    header: { paddingBottom: spacing[2], flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
    invitePill: {
      flexDirection: 'row', alignItems: 'center', gap: spacing[1],
      backgroundColor: p.primary,
      paddingHorizontal: spacing[3], paddingVertical: spacing[1],
      borderRadius: radius.full,
    },
    invitePillText: { fontSize: 13, fontWeight: '600' as const, color: p.textInverse },
    chatBtn: { padding: spacing[1] },
    chatIconBox: { width: 24, height: 24, alignItems: 'center', justifyContent: 'center' },
    chatBadge: {
      position: 'absolute', top: -2, right: -2,
      minWidth: 16, height: 16, borderRadius: radius.full,
      backgroundColor: p.primary,
      alignItems: 'center', justifyContent: 'center',
      paddingHorizontal: 3,
    },
    chatBadgeText: { fontSize: 9, fontWeight: '700' as const, color: p.textInverse, lineHeight: 12 },

    heroCard: {},
    investorHeroRow: { flexDirection: 'row' as const, alignItems: 'center' as const, gap: spacing[4] },
    heroEye: {
      position: 'absolute' as const,
      top: spacing[3],
      right: spacing[3],
      padding: spacing[1],
      zIndex: 1,
    },
    heroTop: { gap: spacing[1] },
    heroAmountRow: { position: 'relative' },
    heroAmount: { fontSize: 52, lineHeight: 64 },
    heroCurrency: { fontSize: 18, lineHeight: 24, position: 'absolute', top: 4, right: 0 },
    heroEmptyState: { gap: spacing[1], paddingVertical: spacing[2] },
    heroEmptyAction: { alignSelf: 'flex-start', marginTop: spacing[2] },
    heroComparison: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingTop: spacing[3],
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: p.border,
    },

    attentionZone: { gap: spacing[3] },
    monthLine: { textAlign: 'center', paddingVertical: spacing[2] },

    sheetBackdrop: {
      flex: 1, justifyContent: 'flex-end',
      backgroundColor: 'rgba(0,0,0,0.5)',
    },
    sheetPanel: {
      borderTopLeftRadius: 24, borderTopRightRadius: 24,
      paddingHorizontal: spacing[6],
      paddingTop: spacing[3],
      paddingBottom: spacing[10],
      alignItems: 'center',
      gap: spacing[3],
    },
    sheetHandle: {
      width: 40, height: 4, borderRadius: 2,
      marginBottom: spacing[2],
    },
    sheetTitle: { textAlign: 'center' },
    sheetBody: { textAlign: 'center', lineHeight: 24 },

    welcome: { alignItems: 'center', gap: spacing[4], paddingVertical: spacing[8], paddingHorizontal: spacing[6] },
    welcomeEmoji: { fontSize: 52, lineHeight: 72 },

    section: {
      backgroundColor: p.surface,
      borderRadius: radius.card,
      borderWidth: 1,
      borderColor: p.border,
      overflow: 'hidden',
    },
    sectionTitle: {
      paddingHorizontal: spacing[4],
      paddingVertical: spacing[3],
      borderBottomWidth: 1,
      borderBottomColor: p.border,
    },
    bsRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing[3],
      paddingHorizontal: spacing[4],
      paddingVertical: spacing[3],
      borderBottomWidth: 1,
      borderBottomColor: p.border,
    },
    withdrawBtn: {
      borderWidth: 1.5, borderRadius: radius.full,
      paddingHorizontal: spacing[4], paddingVertical: spacing[2],
    },
    withdrawInput: {
      flexDirection: 'row', alignItems: 'center', gap: spacing[3],
      borderWidth: 1, borderRadius: radius.md,
      paddingHorizontal: spacing[4], paddingVertical: spacing[3],
    },
  });
}
