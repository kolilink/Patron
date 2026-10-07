import { create } from 'zustand';
import * as Sentry from '@sentry/react-native';
import * as SecureStore from 'expo-secure-store';
import { isAuthRetryableFetchError } from '@supabase/supabase-js';
import { supabase, clearSupabaseLocalSession, revokeAccessToken } from '@/lib/supabase';
import { translateError } from '@/lib/errors';
import { generateId } from '@/lib/id';
import { syncKnownBusinesses } from '@/lib/knownBusinesses';
import { clearKpiSnapshot } from '@/src/utils/kpiSnapshot';
import { ACCOUNT_DELETION_CANCELLED_TOAST } from '@/src/utils/succession';
import { getKV, setKV } from '@/lib/db';
import { toast } from './toast';
import { isLocked, setLocked } from '@/lib/lock';
import { withTimeout, withNetworkRetry, reportOfflineFallback } from '@/lib/sync';
import { isFounderPhone } from '@/src/utils/founder';
import type { AppSession, Business, Membership, Role, User } from '@/src/types';
import { useProductStore } from './products';
import { useVentesStore } from './ventes';
import { useExpensesStore } from './expenses';
import { useEquipeStore } from './equipe';
import { useFournisseursStore } from './fournisseurs';
import { useSalesStore } from './sales';
import { useSyncStore } from './sync';
import { useChatStore } from './chat';
import { useMarketStore } from './market';
import { useRapportsStore } from './rapports';
import { useAportsStore } from './apports';
import { useInvestorStore } from './investor';
import { usePartnershipsStore } from './partnerships';
import { useSupportChatStore } from './supportChat';
import { trackEvent, identifyUser, resetAnalytics } from '@/lib/analytics';
import { loginPurchases } from '@/lib/purchases';
import { notifyEvent } from '@/src/utils/notifications';
import { clearPendingInviterId } from '@/lib/inviteLink';

// ─── Last phone + biometric refresh token (quick-login) ──────────────────────

const LAST_PHONE_KEY = 'patron_last_phone';
const BIO_REFRESH_KEY = 'patron_bio_refresh_token';
const LAST_BUSINESS_NAME_KEY = 'patron_last_business_name';

async function saveLastPhone(phone: string): Promise<void> {
  try { await SecureStore.setItemAsync(LAST_PHONE_KEY, phone); } catch { }
}

export async function getLastPhone(): Promise<string | null> {
  try { return await SecureStore.getItemAsync(LAST_PHONE_KEY); } catch { return null; }
}

// The lock screen (app/(auth)/verrouille.tsx) has no live session to read
// activeBusiness from — lock() clears it. Cached here on every session
// establishment (loadSession() below is the one choke point that already
// covers cold start, login, and biometric restore) the same way
// getLastPhone already solves the identical "screen has no session yet"
// problem for the WhatsApp re-login fallback.
async function saveLastBusinessName(name: string): Promise<void> {
  try { await SecureStore.setItemAsync(LAST_BUSINESS_NAME_KEY, name); } catch { }
}

export async function getLastBusinessName(): Promise<string | null> {
  try { return await SecureStore.getItemAsync(LAST_BUSINESS_NAME_KEY); } catch { return null; }
}

async function saveBioRefreshToken(token: string): Promise<void> {
  try { await SecureStore.setItemAsync(BIO_REFRESH_KEY, token); } catch { }
}

async function clearBioRefreshToken(): Promise<void> {
  try { await SecureStore.deleteItemAsync(BIO_REFRESH_KEY); } catch { }
}

// ─── Session cache (offline restart resilience) ───────────────────────────────

const SESSION_CACHE_KEY = 'patron_session_cache_v1';
const CHUNK_SIZE = 1800;

async function persistSessionCache(session: AppSession): Promise<void> {
  try {
    const json = JSON.stringify(session);
    const chunks = Math.ceil(json.length / CHUNK_SIZE);
    await SecureStore.setItemAsync(`${SESSION_CACHE_KEY}_count`, String(chunks));
    for (let i = 0; i < chunks; i++) {
      await SecureStore.setItemAsync(`${SESSION_CACHE_KEY}_${i}`, json.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE));
    }
  } catch { }
}

async function restoreSessionCache(): Promise<AppSession | null> {
  try {
    const countStr = await SecureStore.getItemAsync(`${SESSION_CACHE_KEY}_count`);
    if (!countStr) return null;
    const count = parseInt(countStr, 10);
    // One IPC wave over every chunk instead of N sequential native round trips
    // (this sits on the critical path of every unlock). Same semantics: any
    // missing chunk means no usable cache.
    const chunks = await Promise.all(
      Array.from({ length: count }, (_, i) => SecureStore.getItemAsync(`${SESSION_CACHE_KEY}_${i}`)),
    );
    if (chunks.some(c => !c)) return null;
    const json = chunks.join('');
    const parsed = JSON.parse(json) as AppSession & { isDemoMode?: boolean };
    // Legacy: a session cached by the removed demo mode — never restore it.
    if (parsed.isDemoMode) {
      await clearSessionCache();
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

async function clearSessionCache(): Promise<void> {
  try {
    const countStr = await SecureStore.getItemAsync(`${SESSION_CACHE_KEY}_count`);
    if (!countStr) return;
    const count = parseInt(countStr, 10);
    for (let i = 0; i < count; i++) {
      await SecureStore.deleteItemAsync(`${SESSION_CACHE_KEY}_${i}`);
    }
    await SecureStore.deleteItemAsync(`${SESSION_CACHE_KEY}_count`);
  } catch { }
}

// If logout() couldn't reach the server to revoke the session (offline, or
// killed before the background attempt finished), the access token it was
// trying to revoke is stashed here so the next launch can retry — otherwise
// that refresh token would stay valid on Supabase's side indefinitely.
async function retryPendingSignOut(): Promise<void> {
  const pending = await getKV(PENDING_SIGNOUT_TOKEN_KEY).catch(() => null);
  if (!pending) return;
  const ok = await revokeAccessToken(pending);
  if (ok) await setKV(PENDING_SIGNOUT_TOKEN_KEY, '').catch(() => { });
}

// ─────────────────────────────────────────────────────────────────────────────

// Set to true only during an explicit logout() call so the onAuthStateChange
// handler can distinguish a deliberate sign-out from a failed JWT refresh
// triggered while the device is offline.
let _explicitLogout = false;

// Mirrors the current access token so logout() can revoke it synchronously,
// without an extra getSession() round trip on the must-be-instant logout path.
let _currentAccessToken: string | null = null;
const PENDING_SIGNOUT_TOKEN_KEY = 'pending_signout_token';

// A second authenticateAsync() call fired while one is still pending (e.g. the
// screen's own mount-time auto-attempt racing a manual "Réessayer" tap) makes
// iOS/Android silently reject the newer call with no native UI shown at all —
// LocalAuthentication only supports one in-flight prompt per app. Guards
// unlockWithBiometric() below so a stacked call is dropped instead of
// swallowed as a mysterious no-op.
let _biometricPromptInFlight = false;

function resetAllStores() {
  useProductStore.getState().reset();
  useVentesStore.getState().reset();
  useExpensesStore.getState().reset();
  useEquipeStore.getState().reset();
  useFournisseursStore.getState().reset();
  useSalesStore.getState().reset();
  useSyncStore.getState().reset();
  useChatStore.getState().reset();
  useMarketStore.getState().reset();
  useRapportsStore.getState().reset();
  useAportsStore.getState().reset();
  useInvestorStore.getState().reset();
  usePartnershipsStore.getState().reset();
  useSupportChatStore.getState().reset();
}

interface PendingPhoneVerification {
  verificationId: string;
  phone: string;
}

interface AuthStore {
  session: AppSession | null;
  loading: boolean;
  locked: boolean;
  // True only right after a genuine fresh authentication (real login, brand
  // new registration, email recovery) — never set by initialize()'s silent
  // session restore on cold start.
  justAuthenticated: boolean;
  emailOtpLoading: boolean;
  error: string | null;
  pendingPhoneVerification: PendingPhoneVerification | null;
  removedBusinessName: string | null;
  removedBusinessesOnLogin: Array<{ id: string; name: string }> | null;
  dismissedFromBusiness: { name: string } | null;
  showTrialWelcome: boolean;

  initialize: () => Promise<void>;
  signInAnonymously: () => Promise<void>;
  login: (email: string, password: string) => Promise<void>;
  register: (name: string, email: string, password: string) => Promise<void>;
  // Phase 5 — stable visible identity. Chooses/confirms the member's familiar
  // pseudo at arrival. Returns the confirmed pseudo. The server (confirm_pseudo
  // in migration_v207) enforces 2-30 chars and case-insensitive uniqueness, and
  // every post resolves to this pseudo — never the legal name, never 'Anonyme'.
  confirmPseudo: (pseudo: string) => Promise<string>;
  logout: () => Promise<void>;
  revokeOtherSessions: () => Promise<boolean>;
  selectBusiness: (businessId: string) => void;
  /** Best-effort refresh of the active business's teams_enabled flag (v227). Fail-open: never throws, never clears an existing value on error. */
  refreshTeamsFlag: () => Promise<void>;
  createBusiness: (data: { name: string; type?: string; currency: string; referralCode?: string }) => Promise<void>;
  markFirstRunHeroCompleted: (businessId: string) => Promise<void>;
  joinBusiness: (code: string) => Promise<void>;
  // Founder-only testing tool — see delete_business(), db/migration_v165.sql.
  deleteBusiness: (businessId: string) => Promise<boolean>;
  lock: () => Promise<void>;
  // OS-native unlock only. 'retryable' covers cancels/interruptions — the OS
  // sheet owns the retry/fallback UI, so the app shows no error copy. There is
  // no 'unavailable' branch anymore: a device with no biometric AND no device
  // credential enrolled (isEnrolledAsync() false) skips the lock entirely and
  // restores the local session cache, so a dead lock screen is never shown.
  unlockWithBiometric: () => Promise<'unlocked' | 'retryable'>;
  clearJustAuthenticated: () => void;
  createPhoneVerification: (phone: string) => Promise<{ verificationId: string } | null>;
  loginWithPhone: (phone: string) => Promise<{ verificationId: string } | null>;
  verifyPhoneCode: (phone: string, code: string, verificationId: string) => Promise<boolean>;
  upgradePhone: (phone: string) => Promise<void>;
  restorePhoneSession: (phone: string, verificationId: string) => Promise<void>;
  businessDrawerOpen: boolean;
  openBusinessDrawer: () => void;
  closeBusinessDrawer: () => void;
  // Bumped by app/(app)/_layout.tsx when FirstRunHeroOverlay closes, so
  // Accueil's own local KPI state (credit_count/credit_total, driving the
  // "N clients vous doivent" card) refreshes immediately. useFocusEffect
  // alone doesn't catch this: the overlay is a plain <Modal> rendered
  // outside the tab navigator, so react-navigation never actually
  // unfocuses/refocuses Accueil while it's open — a real business switch
  // "fixed" the staleness only because that's a much bigger state change,
  // not because focus itself changed. Plain field set via .setState(), not a dedicated action.
  homeRefreshToken: number;

  // In-progress FirstRunHeroOverlay state (which phase, the typed name/
  // amount, the running total, the last saved entry), mirrored here so it
  // survives a lock/unlock cycle. The app-lock re-entry path is a real
  // navigation (app/(app)/_layout.tsx returns <Redirect href="/(auth)/
  // verrouille" />), not an overlay on top of the current screen — so
  // FirstRunHeroOverlay's own local component state would otherwise be
  // destroyed the moment someone locks mid-form and rebuilt from scratch on
  // unlock, silently dropping whatever they'd typed. Keyed on businessId so
  // a stale draft from a different (or since-completed) business is never
  // mistakenly rehydrated; cleared on exit (Passer / "Voir mon commerce").
  // Same setState-directly pattern as the two fields above — the component
  // owns reading/writing this, no dedicated action.
  heroDraft: {
    businessId: string;
    phase: 'ask' | 'payoff';
    name: string;
    amount: string;
    totalCents: number;
    lastEntry: { name: string; amountCents: number } | null;
  } | null;

  // Cross-component open request for Accueil's QuickCaptureSheet — set by the
  // Clients screens (and anything else outside the tab navigator) that want a
  // credit/sale capture, then they navigate to Accueil. Plain field set via
  // .setState(), not a dedicated action.
  // Accueil watches it, opens the sheet in that mode, then clears it back
  // to null.
  requestQuickCapture: 'credit' | 'vente' | null;
  /** Optional prefilled client for a 'credit' request (Clients' "+ Nouveau client « x »"). */
  requestQuickCaptureClientName: string | null;

  // Bumped exactly twice: once on a real cold start (app/_layout.tsx, right
  // after initialize() resolves) and once when the app returns to the
  // foreground after being backgrounded 10+ minutes (app/(app)/_layout.tsx's
  // existing AppState handler). PaymentReminderAsker (mounted in Accueil)
  // watches this — it's the "fresh session" half of that sheet's trigger
  // conditions, same setState-directly/no-dedicated-action pattern as
  // homeRefreshToken above. A plain foreground return under 10 minutes
  // (switching tabs in the OS app switcher, a quick glance at another app)
  // deliberately does NOT bump this — the asker must never interrupt
  // someone who was just actively using the app a moment ago.
  freshSessionToken: number;

  sendEmailOtp: (email: string) => Promise<{ verificationId: string } | null>;
  recoverByEmail: (email: string, code: string, verificationId: string) => Promise<void>;
  linkRecoveryEmail: (email: string, code: string, verificationId: string) => Promise<boolean>;


  clearTrialWelcome: () => void;
  refreshActiveBusiness: () => Promise<void>;
  clearError: () => void;
  handleMembershipRemoved: (businessName: string) => void;
  handleMembershipRemovedWithFallback: (
    removedBusinessId: string,
    removedBusinessName: string,
    remainingMemberships: Membership[]
  ) => void;
  handleRoleChanged: (newRole: import('@/src/types').Role) => void;
  clearRemovedBusiness: () => void;
  clearRemovedBusinessesOnLogin: () => void;
  clearDismissedFromBusiness: () => void;
}

async function loadSession(userId: string, authPhone?: string | null, skipCache = false): Promise<AppSession> {
  const [profileRes, membershipsRes] = await withTimeout(Promise.all([
    supabase.from('profiles').select('*').eq('id', userId).single(),
    supabase
      .from('memberships')
      .select('*, business:businesses(*)')
      .eq('user_id', userId),
  ]));

  if (profileRes.error) throw profileRes.error;
  if (membershipsRes.error) throw membershipsRes.error;

  const p = profileRes.data;
  const memberships = membershipsRes.data as Membership[];

  // A pending account-deletion request (delete_my_account — migration_v178)
  // is cancelled the instant its owner establishes a real session again —
  // this is that single choke point, run by every session-establishing path
  // (cold start, phone OTP login, biometric restore, email recovery). Best-
  // effort: a failure here must never block loading the session itself.
  if (p.pending_deletion_at) {
    (async () => {
      const { error } = await supabase.from('profiles').update({ pending_deletion_at: null }).eq('id', userId);
      if (!error) toast.success(ACCOUNT_DELETION_CANCELLED_TOAST);
    })().catch(() => { });
  }

  const user: User = {
    id: userId,
    name: p.name ?? '',
    // Phase 5 — stable visible identity. NULL until confirmed at arrival.
    pseudo: p.pseudo ?? null,
    pseudo_confirmed_at: p.pseudo_confirmed_at ?? null,
    email: p.email ?? '',
    phone: p.phone ?? authPhone ?? null,
    avatar_url: p.avatar_url ?? null,
    language: p.language ?? 'fr',
    recovery_email: p.recovery_email ?? null,
    notify_on_every_sale: p.notify_on_every_sale ?? true,
    debt_reminders_enabled: p.debt_reminders_enabled ?? true,
    is_test: p.is_test ?? false,
    created_at: p.created_at,
    updated_at: p.updated_at,
  };

  const lastBusinessId = await getKV(`last_business_${userId}`).catch(() => null);
  const preferred = lastBusinessId ? memberships.find(m => m.business_id === lastBusinessId) : null;
  const activeMembership = preferred ?? (memberships.length >= 1 ? memberships[0] : null);
  const activeBusiness = (activeMembership?.business as Business) ?? null;
  if (activeBusiness?.name) void saveLastBusinessName(activeBusiness.name);

  const session: AppSession = { user, memberships, activeBusiness, activeMembership };
  if (!skipCache) void persistSessionCache(session);
  return session;
}

export const useAuthStore = create<AuthStore>((set, get) => ({
  session: null,
  loading: true,
  locked: false,
  justAuthenticated: false,
  emailOtpLoading: false,
  error: null,
  pendingPhoneVerification: null,
  removedBusinessName: null,
  removedBusinessesOnLogin: null,
  dismissedFromBusiness: null,
  showTrialWelcome: false,
  businessDrawerOpen: false,
  homeRefreshToken: 0,
  heroDraft: null,
  requestQuickCapture: null,
  requestQuickCaptureClientName: null,
  freshSessionToken: 0,

  initialize: async () => {
    // Register BEFORE getSession() so we never miss a TOKEN_REFRESHED event.
    // getSession() auto-refreshes expired access tokens; if the listener is
    // registered after, the rotation happens silently and our stored token
    // goes stale on the very first open after login.
    supabase.auth.onAuthStateChange(async (event, session) => {
      try {
        _currentAccessToken = session?.access_token ?? _currentAccessToken;
        if (event === 'TOKEN_REFRESHED' && session) {
          void saveBioRefreshToken(session.refresh_token);
        }
        if (event === 'SIGNED_OUT' || !session) {
          if (_explicitLogout) {
            // Deliberate logout — clear everything.
            set({ session: null });
            resetAllStores();
          }
          // If not explicit: token refresh failed (device is offline). Keep the
          // current session so the user can still access cached data.
        }
      } catch (e) {
        // Supabase awaits and rethrows errors from this async callback, which
        // propagates them into signOut(). Our logout() try/catch handles that.
        // The try/catch here is a belt-and-suspenders in case future code paths
        // call _notifyAllSubscribers without awaiting the result.
        console.warn('[auth] onAuthStateChange error:', e);
      }
    });

    // A soft lock (see lock()) deliberately leaves the underlying Supabase
    // session/refresh token untouched — only a local flag says "don't show it
    // yet, ask for biometric auth first." Honor that before hydrating
    // anything, so a killed-and-relaunched app lands on the lock screen
    // instead of silently back inside.
    if (await isLocked()) {
      set({ session: null, locked: true, loading: false });
      return;
    }

    // Render instantly from the local session cache (SecureStore, no
    // network) so the app never sits on a blank screen waiting for a
    // connection. The live check below then runs as a background upgrade —
    // it only overwrites this if it actually succeeds.
    const cachedSession = await restoreSessionCache();
    if (cachedSession) {
      set({ session: cachedSession, loading: false });
    }

    try {
      // withTimeout here matters most for a device with no cachedSession
      // above (fresh install, or cache cleared) — that's the one path where
      // `loading` is still `true` at this point, so a hang below would blank
      // the entire app forever ((app)/_layout.tsx renders null while
      // loading, see CLAUDE.md's "Critical: auth store loading flag").
      const { data: { session }, error: sessionError } = await withNetworkRetry(() => supabase.auth.getSession());
      _currentAccessToken = session?.access_token ?? _currentAccessToken;

      // Retry any server-side sign-out that couldn't reach the network last
      // time (see logout()) — best-effort, never blocks startup.
      void retryPendingSignOut();

      if (!session) {
        // A retryable fetch error means we simply couldn't reach the server
        // (no connectivity) — the account's real validity is unknown, so keep
        // showing the cached session for offline use. Any other outcome (no
        // error at all, or a non-retryable auth error such as an invalid or
        // revoked refresh token) means the account is genuinely no longer
        // valid server-side — a stale cached session must not keep being
        // trusted indefinitely just because it happens to exist locally.
        if (sessionError && isAuthRetryableFetchError(sessionError)) {
          // Offline — cached session (if any) already rendered above. Still
          // must clear `loading` even when there's NO cache to fall back to
          // (fresh install, or a cleared cache) — otherwise this branch
          // returns having never set loading:false, and (app)/_layout.tsx
          // renders null forever, since nothing else in this function will
          // ever touch `loading` again for this call. See CLAUDE.md's
          // "Critical: auth store loading flag."
          reportOfflineFallback('auth.initialize', sessionError);
          set({ loading: false });
        } else {
          set({ session: null, loading: false });
        }
      } else {
        // Belt-and-suspenders: save the token we got from getSession() directly,
        // in case the TOKEN_REFRESHED event fired before the listener was ready.
        void saveBioRefreshToken(session.refresh_token);

        // Cache is written explicitly below, once we know whether this is a
        // genuine login — not unconditionally inside loadSession() — so an
        // abandoned anonymous/phone-verification session never gets persisted
        // and later restored offline as if it were a real logged-in user.
        const appSession = await loadSession(session.user.id, session.user.phone, true);
        // Anonymous user with no phone = a verification flow still in
        // progress (or abandoned mid-flow) — not a real login. Do not cache
        // it: nothing is persisted, so an offline cold start later won't
        // resurrect this half-finished login.
        if (session.user.is_anonymous && !appSession.user.phone) {
          // Legacy: the removed "Essayer Patron" demo mode left an anonymous
          // user (with a seeded demo business) on devices that used it. Drop
          // that identity so a later signup can't adopt the demo business
          // through the "reuse the existing anonymous session" path.
          const legacyDemoFlag = await getKV(`demo_mode_${session.user.id}`).catch(() => null);
          if (legacyDemoFlag === 'true') {
            await clearSupabaseLocalSession();
            await clearSessionCache();
            setKV(`demo_mode_${session.user.id}`, 'false').catch(() => { });
          }
          set({ session: null, loading: false });
        } else {
          // User is anonymous but has already verified their phone (joined before
          // upgradePhone gained the RPC call, or session restored from storage).
          // Lift the anonymous flag now so RLS lets them see their teammates.
          if (session.user.is_anonymous && appSession.user.phone) {
            await supabase.rpc('upgrade_anonymous_user');
            await supabase.auth.refreshSession();
          }
          const removed = await syncKnownBusinesses(session.user.id, appSession.memberships);
          void persistSessionCache(appSession);
          if (appSession.activeBusiness) void loginPurchases(appSession.activeBusiness.id);
          if (removed.length > 0 && appSession.memberships.length === 0) {
            set({ session: appSession, removedBusinessesOnLogin: removed, loading: false });
          } else if (removed.length > 0 && appSession.memberships.length > 0) {
            set({ session: appSession, dismissedFromBusiness: { name: removed[0].name }, loading: false });
          } else {
            set({ session: appSession, loading: false });
          }
        }
      }
    } catch {
      const cached = await restoreSessionCache();
      set({ session: cached, loading: false });
    }
  },

  signInAnonymously: async () => {
    set({ loading: true, error: null });
    try {
      const { data, error } = await supabase.auth.signInAnonymously();
      if (error) throw error;
      if (!data.user) throw new Error('Connexion anonyme échouée');

      await supabase.from('profiles').upsert(
        { id: data.user.id, name: '', email: '', language: 'fr' },
        { onConflict: 'id', ignoreDuplicates: true },
      );

      const appSession = await loadSession(data.user.id);
      set({ session: appSession, loading: false });
    } catch (err) {
      set({ error: translateError(err, 'Erreur de connexion anonyme'), loading: false });
    }
  },

  login: async (email, password) => {
    set({ loading: true, error: null });
    try {
      const { data, error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) throw error;

      const appSession = await loadSession(data.user.id);
      const removed = await syncKnownBusinesses(data.user.id, appSession.memberships);
      if (removed.length > 0 && appSession.memberships.length === 0) {
        set({ session: appSession, removedBusinessesOnLogin: removed, loading: false });
      } else if (removed.length > 0 && appSession.memberships.length > 0) {
        set({ session: appSession, dismissedFromBusiness: { name: removed[0].name }, loading: false });
      } else {
        set({ session: appSession, loading: false });
      }
    } catch (err) {
      set({ error: translateError(err, 'Erreur de connexion'), loading: false });
    }
  },

  register: async (name, email, password) => {
    set({ loading: true, error: null });
    try {
      const { data, error } = await supabase.auth.signUp({
        email,
        password,
        options: { data: { name } },
      });
      if (error) throw error;
      if (!data.user) throw new Error('Inscription échouée');

      if (!data.session) {
        set({
          loading: false,
          error: 'Un email de confirmation a été envoyé. Vérifiez votre boîte mail puis connectez-vous.',
        });
        return;
      }

      await supabase.from('profiles').upsert({ id: data.user.id, name, email, language: 'fr' });

      const user: User = {
        id: data.user.id,
        name,
        email,
        phone: null,
        avatar_url: null,
        language: 'fr',
        recovery_email: null,
        notify_on_every_sale: true,
        debt_reminders_enabled: true,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };

      set({
        session: { user, memberships: [], activeBusiness: null, activeMembership: null },
        loading: false,
      });
    } catch (err) {
      set({ error: translateError(err, "Erreur d'inscription"), loading: false });
    }
  },

  // Phase 5 — choose/confirm the familiar pseudo at arrival. The server RPC
  // confirm_pseudo validates length and uniqueness; on success we update the
  // in-memory session so the whole app reflects the stable identity without a
  // full reload.
  confirmPseudo: async (pseudo) => {
    const trimmed = pseudo.trim();
    const { data, error } = await supabase.rpc('confirm_pseudo', { p_pseudo: trimmed });
    if (error) throw error;
    if (data !== true) throw new Error('Impossible de confirmer ce pseudo');

    set(state => {
      if (!state.session) return {};
      return {
        session: {
          ...state.session,
          user: {
            ...state.session.user,
            pseudo: trimmed,
            pseudo_confirmed_at: new Date().toISOString(),
          },
        },
      };
    });
    return trimmed;
  },

  logout: async () => {
    const { session } = get();
    const userId = session?.user.id;
    const accessTokenToRevoke = _currentAccessToken;
    trackEvent('user_logged_out', session?.activeBusiness?.id ?? null, userId ?? null);
    resetAnalytics();
    // Deliberately NOT calling RevenueCat's logOut()/isAnonymous() here — both
    // are native calls that can throw an uncaught NSException on the
    // com.meta.react.turbomodulemanager.queue, which surfaces as a native
    // SIGABRT (not a catchable JS promise rejection) and aborts the whole
    // app. A prior fix tried guarding logOut() with an isAnonymous() check
    // first, but isAnonymous() goes through the exact same crash-prone
    // native bridge path, so it just moved the crash one call earlier
    // instead of preventing it (confirmed via a real TestFlight .ips crash
    // log still showing this exact signature after that fix shipped).
    // loginPurchases(businessId) already runs unconditionally on every
    // subsequent login/session-restore and RevenueCat's logIn() safely
    // switches identity on its own — no explicit logOut() is needed first.

    // Logging out is a local, instant action — it must never wait on the
    // network. supabase.auth.signOut() calls the server *before* it clears
    // the local session, so on a slow or dead connection (the norm this app
    // is built for) it can hang for the full 15s fetch timeout, or fail
    // outright and never clear anything. Wipe every local trace ourselves,
    // synchronously and unconditionally, then tell the server in the
    // background as a courtesy — its outcome no longer matters to the user.
    _explicitLogout = true;
    await clearSupabaseLocalSession();
    await clearSessionCache();
    void clearBioRefreshToken();
    await setLocked(false);
    // B5 — a pending inviter id (captured on this device before/while the
    // previous account was signed in) must not leak into the next account on
    // a shared device.
    void clearPendingInviterId();
    resetAllStores();
    // A vendeur's role-scoped Accueil numbers must never reach the next user on this device.
    clearKpiSnapshot();
    set({ session: null, locked: false, justAuthenticated: false, error: null, pendingPhoneVerification: null });

    void (async () => {
      // Unsubscribe Realtime channels before signOut() disconnects the
      // WebSocket — otherwise channel error callbacks can fire after the
      // socket closes and become unhandled rejections that crash Hermes.
      try { await supabase.removeAllChannels(); } catch { }
      let signOutOk = true;
      try { await supabase.auth.signOut(); } catch { signOutOk = false; }
      // signOut() throwing means we can't be sure the server ever heard about
      // this — revoke directly with the token captured before the local wipe.
      // If that also fails (offline), stash it so the next launch retries;
      // otherwise this refresh token would stay valid on Supabase's side.
      if (!signOutOk && accessTokenToRevoke) {
        const ok = await revokeAccessToken(accessTokenToRevoke);
        if (!ok) await setKV(PENDING_SIGNOUT_TOKEN_KEY, accessTokenToRevoke).catch(() => { });
      }
      _explicitLogout = false;
    })();

    // Deliberately NOT calling getExpoPushTokenAsync()/deleteDeviceToken() here
    // anymore — same class of risk as the RevenueCat calls removed above:
    // getExpoPushTokenAsync() is a native module call that can throw an
    // uncaught native exception un-catchable by JS try/catch, and it wasn't
    // load-bearing (worst case without it: a logged-out device keeps its old
    // push token registered server-side until the next login re-registers a
    // fresh one, or it naturally goes stale — not a crash-worthy tradeoff).
  },

  // Lost/stolen-phone flow (security audit 2026-09-27, 1.15) — a real,
  // server-side revocation via GoTrue's own `others` scope: kills every
  // *other* refresh token for this user immediately, no new table, no
  // in-app cooperation required from the other device. Deliberately not
  // "global" — the device tapping this button must stay logged in (that's
  // the whole point: fix the problem from the phone you're holding without
  // also locking yourself out). GoTrue fires no SIGNED_OUT event for this
  // scope, so the current session's own auth-state listener is untouched.
  // A currently-open session on another device keeps its already-issued
  // access token valid until it naturally expires (up to 1h, per this
  // project's confirmed JWT lifetime) — revoking the refresh token stops it
  // from ever getting a new one, it doesn't retroactively kill the current
  // one, since that's not something JWTs support.
  revokeOtherSessions: async () => {
    try {
      const { error } = await supabase.auth.signOut({ scope: 'others' });
      return !error;
    } catch {
      return false;
    }
  },

  selectBusiness: (businessId) => {
    const { session } = get();
    if (!session) return;

    const membership = session.memberships.find(m => m.business_id === businessId);
    if (!membership) return;

    setKV(`last_business_${session.user.id}`, businessId).catch(() => { });
    // B5 — switching account/business on a shared device must not carry the
    // previous account's pending invite token into the next one.
    void clearPendingInviterId();
    resetAllStores();

    const nextSession: AppSession = {
      ...session,
      activeBusiness: (membership.business as Business) ?? null,
      activeMembership: membership,
    };
    // Keep the offline session cache in sync with the switch — otherwise a
    // cold start that happens to land offline right after this would restore
    // the OLD business instead of the one just selected.
    void persistSessionCache(nextSession);
    set({ session: nextSession });
    // The flag rides along with the business record already loaded in
    // memberships, but that copy can be stale — refresh it for the business
    // just switched to (best-effort, fail-open).
    void get().refreshTeamsFlag();
  },

  createBusiness: async ({ name, type, currency, referralCode }) => {
    const { session } = get();
    if (!session) return;

    // The founder is exempt from the 1-business-per-admin limit — he needs
    // to create and delete many throwaway test businesses while iterating
    // on onboarding. Mirrors the server-side bypass in
    // create_business_with_membership (db/migration_v165.sql); this
    // client-side check is defense-in-depth only, same posture as every
    // other isFounderPhone gate in the app.
    const alreadyOwns = !isFounderPhone(session.user.phone) && session.memberships.some(m => m.role === 'administrateur');
    if (alreadyOwns) {
      set({ error: 'Vous avez déjà un commerce actif. Bientôt, vous pourrez en gérer plusieurs.', loading: false });
      return;
    }

    set({ loading: true, error: null });
    trackEvent('business_create_started', null, session.user.id);

    const businessId = generateId();

    // Wrapped in try/catch (unlike an earlier version of this function) —
    // the bare RPC call below has no offline queue or retry of its own, so
    // a network failure has to surface as a translated error and reset
    // `loading`, not disappear. lib/supabase.ts's global fetchWithTimeout
    // aborts any hung request after 15s, but an abort is a THROWN rejection,
    // not a returned `{data,error}` pair — with no catch here, that
    // rejection had nowhere to go: `loading` stayed true forever and the
    // "Créer mon commerce" button was left permanently spinning with no
    // error shown, on literally the last step of onboarding. Same bug class
    // already found and fixed in stores/investor.ts and stores/sales.ts's
    // submitCarnetDebt — see "Offline queue" in CLAUDE.md.
    try {
      // create_business_with_membership: SECURITY DEFINER RPC — inserts the
      // business, lets the on_business_created trigger create the admin
      // membership in the same transaction, then returns both atomically.
      // Replaces a separate insert + up-to-5x poll loop (previously up to ~3s
      // on a slow connection) with a single round trip.
      const { data: membership, error: rpcErr } = await supabase.rpc('create_business_with_membership', {
        p_id: businessId,
        p_name: name,
        p_type: type ?? null,
        p_currency: currency,
        p_phone: session.user.phone ?? null,
      });
      if (rpcErr || !membership) {
        set({ error: translateError(rpcErr, 'Impossible de créer le commerce'), loading: false });
        return;
      }

      const m = membership as Membership;

      // Referral code ("Inviter un ami" in Paramètres) is optional and
      // best-effort — a bad/expired code should never block business
      // creation. resolve_referral_code is SECURITY DEFINER because this
      // brand-new user isn't a member of the referrer's business yet, so the
      // normal is_member(id) SELECT policy on businesses would otherwise
      // block the lookup. The actual write below is a plain client update,
      // allowed by the "Administrateurs: modifier leur commerce" policy
      // since this user is now that business's own admin.
      if (referralCode?.trim()) {
        try {
          const { data: referrerId } = await supabase.rpc('resolve_referral_code', { p_code: referralCode.trim() });
          if (referrerId && referrerId !== businessId) {
            await supabase.from('businesses').update({ referred_by_business_id: referrerId }).eq('id', businessId);
            if (m.business) (m.business as Business).referred_by_business_id = referrerId as string;
          }
        } catch (err) {
          console.warn('[createBusiness] referral code lookup failed:', err);
        }
      }

      const newMemberships = [...session.memberships, m];
      // Persist so next cold start lands on the newly created business
      setKV(`last_business_${session.user.id}`, businessId).catch(() => { });
      void loginPurchases(businessId);
      // Seed the cache so first-reload removal detection works immediately
      syncKnownBusinesses(session.user.id, newMemberships).catch(() => { });
      resetAllStores();
      const nextSession: AppSession = {
        ...session,
        memberships: newMemberships,
        activeBusiness: m.business as Business,
        activeMembership: m,
      };
      // Keep the offline session cache in sync — otherwise a cold start that
      // lands offline right after creating a business would restore a session
      // that predates it (missing membership, wrong/no active business).
      void persistSessionCache(nextSession);
      set({
        session: nextSession,
        showTrialWelcome: true,
        loading: false,
      });
      trackEvent('commerce_created', businessId, session.user.id, { currency, business_type: type ?? null });
    } catch (err) {
      set({ error: translateError(err, 'Impossible de créer le commerce'), loading: false });
    }
  },

  // Marks the first-run hero gate ("Qui vous doit de l'argent ?") done for
  // this business — via Passer, or the first successful save. Same plain
  // client-update pattern createBusiness already uses for
  // referred_by_business_id above: allowed by the existing "Administrateurs:
  // modifier leur commerce" RLS policy, no RPC needed. A joined (non-owner)
  // member never reaches this at all — join_business() (migration_v197.sql)
  // stamps the business the instant anyone joins it, before a manager or
  // vendeur's own session could ever render this gate. Best-effort: a
  // failed write here just means the gate might show once more on a later
  // launch, never a blocking error worth surfacing to the merchant.
  markFirstRunHeroCompleted: async (businessId) => {
    const { session } = get();
    if (!session) return;
    const stampedAt = new Date().toISOString();
    if (session.activeBusiness?.id === businessId) {
      set({
        session: {
          ...session,
          activeBusiness: { ...session.activeBusiness, first_run_hero_completed_at: stampedAt },
        },
      });
    }
    try {
      await supabase.from('businesses').update({ first_run_hero_completed_at: stampedAt }).eq('id', businessId);
    } catch (err) {
      console.warn('[markFirstRunHeroCompleted]', err);
    }
  },

  deleteBusiness: async (businessId) => {
    const { session } = get();
    if (!session) return false;

    const { error } = await supabase.rpc('delete_business', { p_business_id: businessId });
    if (error) {
      set({ error: translateError(error, 'Impossible de supprimer ce commerce') });
      return false;
    }

    const remaining = session.memberships.filter(m => m.business_id !== businessId);
    const wasActive = session.activeBusiness?.id === businessId;
    const fallback = wasActive ? remaining[0] : undefined;

    if (wasActive) resetAllStores();
    setKV(`last_business_${session.user.id}`, fallback?.business_id ?? '').catch(() => { });

    const nextSession: AppSession = {
      ...session,
      memberships: remaining,
      activeBusiness: wasActive ? ((fallback?.business as Business) ?? null) : session.activeBusiness,
      activeMembership: wasActive ? (fallback ?? null) : session.activeMembership,
    };
    void persistSessionCache(nextSession);
    set({ session: nextSession, error: null });
    trackEvent('business_deleted', businessId, session.user.id, {});
    return true;
  },

  joinBusiness: async (code) => {
    const { session } = get();
    if (!session) return;

    set({ loading: true, error: null });
    trackEvent('business_join_started', null, session.user.id);
    try {
      const joinedCount = session.memberships.filter(m => m.role !== 'administrateur').length;
      if (joinedCount >= 3) throw new Error('Vous avez atteint la limite de 3 commerces rejoints. Bientôt, vous pourrez en rejoindre davantage.');

      // record_invite_attempt: logs this attempt for the 5/10min rate limit
      // as its own top-level call, so it commits regardless of whether
      // join_business() below succeeds or raises. A Postgres function can
      // never make one of its own writes survive an exception it raises
      // later in the same call — join_business() used to log the attempt
      // internally, right before its validation checks, but any of those
      // checks raising rolled the log write back along with everything
      // else, so the rate limit never actually tripped against wrong/
      // expired/already-claimed code guesses (fixed in migration_v124).
      // Best-effort: a hiccup here shouldn't block the join attempt itself.
      try {
        await supabase.rpc('record_invite_attempt');
      } catch {
        // ignore — see comment above
      }

      // join_business: SECURITY DEFINER — validates invite code, enforces rate
      // limiting (5/10 min), expiry, max_uses, and inserts membership atomically.
      // Direct memberships INSERT is no longer allowed (policy dropped in v43).
      const { data: invite, error: rpcErr } = await supabase
        .rpc('join_business', { p_code: code.trim().toUpperCase() });

      if (rpcErr) {
        if (rpcErr.code === '23505') {
          // Already a member — reload session so navigation proceeds
          const appSession = await loadSession(session.user.id);
          set({ session: appSession, loading: false });
          trackEvent('business_joined', appSession.activeBusiness?.id ?? null, session.user.id);
          return;
        }
        throw rpcErr;
      }
      if (!invite) throw new Error('Code invalide. Vérifiez le code et réessayez.');

      const { business_id } = invite as { business_id: string };

      // Persist the joined business so next cold start (and loadSession below) lands on it
      setKV(`last_business_${session.user.id}`, business_id).catch(() => { });
      // Reload the full session now that the membership exists and RLS can see the business
      const appSession = await loadSession(session.user.id);
      syncKnownBusinesses(session.user.id, appSession.memberships).catch(() => { });
      resetAllStores();

      const joinedMembership = appSession.memberships.find(m => m.business_id === business_id);
      const roleLabels: Record<string, string> = {
        administrateur: 'Administrateur', manager: 'Gérant',
        vendeur: 'Vendeur', investisseur: 'Investisseur',
      };
      notifyEvent({
        businessId: business_id,
        eventType: 'member_joined',
        payload: {
          name: appSession.user.name || appSession.user.phone || 'Nouveau membre',
          role: roleLabels[joinedMembership?.role ?? 'vendeur'] ?? 'Vendeur',
        },
        targetRoles: ['administrateur', 'manager'],
      });

      set({ session: appSession, loading: false });
      trackEvent('business_joined', business_id, session.user.id);
      // A member who joins never sees the first-run gate — joining IS their onboarding.
      trackEvent('onboarding_completed', business_id, session.user.id, { outcome: 'joined' });
    } catch (err) {
      const raw = err instanceof Error ? err.message : (err as Record<string, unknown>)?.message as string | undefined;
      set({ error: translateError(err, raw ?? 'Erreur lors de la jonction'), loading: false });
    }
  },

  // ─── Biometric-only soft lock ──────────────────────────────────────────────
  // "Verrouiller" is deliberately NOT logout(): it never touches SecureStore's
  // Supabase session, the bio refresh token, or any domain store — those are
  // exactly what let unlockWithBiometric restore the session for free below,
  // from the local session cache with no network and no WhatsApp OTP. logout()
  // remains the only path that wipes all of that, for the "fully sign out /
  // switch account" case.

  lock: async () => {
    await setLocked(true);
    set({ session: null, locked: true });
  },

  unlockWithBiometric: async (): Promise<'unlocked' | 'retryable'> => {
    // Dropped, not queued — a stacked call while one is already showing its
    // native prompt gets silently rejected by the OS with no UI at all.
    if (_biometricPromptInFlight) return 'retryable';
    _biometricPromptInFlight = true;
    try {
      const LocalAuthentication = await import('expo-local-authentication');

      // OS-native auth only. A device with no biometric AND no device
      // credential enrolled must never be shown a dead lock screen: skip the
      // prompt entirely and restore the local session cache. The app never
      // handles a fallback credential — iOS/Android own that.
      const isEnrolled = await LocalAuthentication.isEnrolledAsync();
      if (!isEnrolled) {
        const cached = await restoreSessionCache();
        await setLocked(false);
        set({ session: cached, locked: false });
        return 'unlocked';
      }

      let result;
      try {
        result = await LocalAuthentication.authenticateAsync({
          promptMessage: 'Déverrouiller Patron',
          cancelLabel: 'Annuler',
          // `false` lets iOS/Android offer their own native device-credential
          // fallback ("Enter Passcode" / system prompt) inside the same sheet.
          // The app never sees or handles that fallback credential — a success
          // flows through the same result.success branch below as a real
          // biometric match. This screen re-locks after just 2 minutes
          // backgrounded (BACKGROUND_MS, app/(app)/_layout.tsx), so routing a
          // routine Face ID miss through a full re-login would be
          // disproportionate friction.
          disableDeviceFallback: false,
        });
      } catch (err) {
        Sentry.captureMessage('biometric_authenticate_threw', { extra: { err: String(err) } });
        return 'retryable';
      }
      if (!result.success) {
        // Logged because a bare boolean/'retryable' hides the actual native
        // reason (e.g. 'missing_usage_description' — see "Biometric-only lock"
        // in CLAUDE.md). The OS renders its own retry/fallback UI, so the app
        // stays put with no duplicated error copy.
        Sentry.captureMessage('biometric_authenticate_failed', { extra: { error: result.error } });
        return 'retryable';
      }

      // OS authentication succeeded — restore from the LOCAL session cache
      // only. The lock screen must never require network.
      const cached = await restoreSessionCache();
      await setLocked(false);
      set({ session: cached, locked: false });
      return 'unlocked';
    } finally {
      _biometricPromptInFlight = false;
    }
  },

  clearJustAuthenticated: () => set({ justAuthenticated: false }),

  createPhoneVerification: async (phone) => {
    set({ loading: true, error: null });
    try {
      // If no Supabase session exists, create a fresh anonymous one so the Edge
      // Function can link the verification to a user_id. If one already exists
      // (e.g., an earlier attempt that was abandoned), reuse it — no new anonymous user needed.
      const { data: { user: currentUser } } = await supabase.auth.getUser();
      if (!currentUser) {
        const { data, error: anonErr } = await supabase.auth.signInAnonymously();
        if (anonErr) throw anonErr;
        if (!data.user) throw new Error('Connexion échouée');
        await supabase.from('profiles').upsert(
          { id: data.user.id, name: '', email: '', language: 'fr' },
          { onConflict: 'id', ignoreDuplicates: true },
        );
      }

      const { data: fnData, error: fnErr } = await supabase.functions.invoke('create-phone-verification', {
        body: { phone: phone.trim() },
      });
      if (fnErr) {
        // FunctionsHttpError hides the real message in the response body
        try {
          const body = await (fnErr as { context?: { json?: () => Promise<{ error?: string }> } }).context?.json?.();
          if (body?.error) throw new Error(body.error);
        } catch (extractErr) {
          if (extractErr !== fnErr) throw extractErr;
        }
        throw fnErr;
      }
      if (fnData?.error) throw new Error(fnData.error);

      const { verificationId } = fnData as { verificationId: string };
      set({
        pendingPhoneVerification: { verificationId, phone: phone.trim() },
        loading: false,
      });
      return { verificationId };
    } catch (err) {
      const raw = err instanceof Error ? err.message : String(err);
      set({ error: translateError(err, raw), loading: false });
      return null;
    }
  },

  loginWithPhone: async (phone) => {
    set({ loading: true, error: null });
    try {
      const { data, error: anonErr } = await supabase.auth.signInAnonymously();
      if (anonErr) throw anonErr;
      if (!data.user) throw new Error('Connexion échouée');

      await supabase.from('profiles').upsert(
        { id: data.user.id, name: '', email: '', language: 'fr' },
        { onConflict: 'id', ignoreDuplicates: true },
      );

      const { data: fnData, error: fnErr } = await supabase.functions.invoke('create-phone-verification', {
        body: { phone: phone.trim(), login: true },
      });
      if (fnErr) {
        try {
          const body = await (fnErr as { context?: { json?: () => Promise<{ error?: string }> } }).context?.json?.();
          if (body?.error) throw new Error(body.error);
        } catch (extractErr) {
          if (extractErr !== fnErr) throw extractErr;
        }
        throw fnErr;
      }
      if (fnData?.error) throw new Error(fnData.error);

      const { verificationId } = fnData as { verificationId: string };
      set({ pendingPhoneVerification: { verificationId, phone: phone.trim() }, loading: false });
      return { verificationId };
    } catch (err) {
      const raw = err instanceof Error ? err.message : String(err);
      set({ error: translateError(err, raw), loading: false });
      return null;
    }
  },

  verifyPhoneCode: async (phone, code, verificationId) => {
    set({ loading: true, error: null });
    try {
      const { data: fnData, error: fnErr } = await supabase.functions.invoke('verify-phone-code', {
        body: { phone: phone.trim(), code: code.trim(), verificationId },
      });
      if (fnErr) {
        try {
          const body = await (fnErr as { context?: { json?: () => Promise<{ error?: string }> } }).context?.json?.();
          if (body?.error) throw new Error(body.error);
        } catch (extractErr) {
          if (extractErr !== fnErr) throw extractErr;
        }
        throw fnErr;
      }
      if (fnData?.error) throw new Error(fnData.error);
      set({ loading: false });
      return true;
    } catch (err) {
      const raw = err instanceof Error ? err.message : String(err);
      set({ error: translateError(err, raw), loading: false });
      return false;
    }
  },

  upgradePhone: async (phone) => {
    set({ loading: true, error: null });
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Session introuvable');

      // The client NEVER writes profiles.phone (migration_v228 pins it in RLS):
      // upgrade_anonymous_user() takes the phone from this user's completed
      // verification server-side and sets it itself. Only non-sensitive
      // defaults are upserted here.
      await supabase.from('profiles').upsert(
        { id: user.id, name: '', email: '', language: 'fr' },
        { onConflict: 'id', ignoreDuplicates: false },
      );

      // Lift anonymous flag (and set the verified phone) — refused server-side
      // unless this user has a completed phone verification.
      const { error: upgradeErr } = await supabase.rpc('upgrade_anonymous_user');
      if (upgradeErr) {
        // create-phone-verification no longer says up front that a number is
        // already registered (it would be a phone-number directory — Phase 9).
        // The caller has just proven they hold this number, so the refusal that
        // can only mean "this number already has an account" is surfaced here as
        // the same PHONE_EXISTS the sign-up screens already render ("Ce numéro a
        // déjà un compte → Se connecter"). Every other branch of the RPC is
        // unreachable right after a successful verification for a fresh session.
        if (upgradeErr.code === 'P0001' && /Accès refusé/.test(upgradeErr.message)) {
          throw new Error('PHONE_EXISTS');
        }
        throw upgradeErr;
      }
      // Refresh the JWT so the new is_anonymous=false claim takes effect immediately.
      const { data: refreshData } = await supabase.auth.refreshSession();
      if (refreshData.session) void saveBioRefreshToken(refreshData.session.refresh_token);

      void saveLastPhone(phone.trim());
      const appSession = await loadSession(user.id);
      identifyUser(appSession);
      if (appSession.activeBusiness) void loginPurchases(appSession.activeBusiness.id);
      trackEvent('user_signed_up', appSession.activeBusiness?.id ?? null, appSession.user.id, {
        has_business: appSession.memberships.length > 0,
      });
      const removed = await syncKnownBusinesses(user.id, appSession.memberships);
      if (removed.length > 0 && appSession.memberships.length === 0) {
        set({ session: appSession, justAuthenticated: true, removedBusinessesOnLogin: removed, loading: false, pendingPhoneVerification: null });
      } else if (removed.length > 0 && appSession.memberships.length > 0) {
        set({ session: appSession, justAuthenticated: true, dismissedFromBusiness: { name: removed[0].name }, loading: false, pendingPhoneVerification: null });
      } else {
        set({ session: appSession, justAuthenticated: true, loading: false, pendingPhoneVerification: null });
      }
    } catch (err) {
      // Only the literal code is passed through, never the raw message.
      const code = err instanceof Error && err.message === 'PHONE_EXISTS' ? 'PHONE_EXISTS' : null;
      set({ error: code ?? translateError(err, 'Vérification échouée'), loading: false });
    }
  },

  restorePhoneSession: async (phone, verificationId) => {
    set({ loading: true, error: null });
    try {
      const { data: fnData, error: fnErr } = await supabase.functions.invoke('restore-phone-session', {
        body: { phone: phone.trim(), verificationId },
      });
      if (fnErr) {
        try {
          const body = await (fnErr as { context?: { json?: () => Promise<{ error?: string }> } }).context?.json?.();
          if (body?.error) throw new Error(body.error);
        } catch (extractErr) {
          if (extractErr !== fnErr) throw extractErr;
        }
        throw fnErr;
      }
      if (fnData?.error) throw new Error(fnData.error);

      const { token_hash } = fnData as { token_hash: string };

      const { data: { session }, error: otpErr } = await supabase.auth.verifyOtp({
        token_hash,
        type: 'magiclink',
      });
      if (otpErr) throw otpErr;
      if (!session) throw new Error('Session introuvable');

      void saveLastPhone(phone.trim());
      void saveBioRefreshToken(session.refresh_token);
      const appSession = await loadSession(session.user.id, session.user.phone);
      identifyUser(appSession);
      if (appSession.activeBusiness) void loginPurchases(appSession.activeBusiness.id);
      trackEvent('user_logged_in', appSession.activeBusiness?.id ?? null, appSession.user.id, {
        method: 'phone_otp',
        has_business: appSession.memberships.length > 0,
      });
      const removed = await syncKnownBusinesses(session.user.id, appSession.memberships);
      if (removed.length > 0 && appSession.memberships.length === 0) {
        set({ session: appSession, justAuthenticated: true, removedBusinessesOnLogin: removed, loading: false, pendingPhoneVerification: null });
      } else if (removed.length > 0 && appSession.memberships.length > 0) {
        set({ session: appSession, justAuthenticated: true, dismissedFromBusiness: { name: removed[0].name }, loading: false, pendingPhoneVerification: null });
      } else {
        set({ session: appSession, justAuthenticated: true, loading: false, pendingPhoneVerification: null });
      }
    } catch (err) {
      // restore-phone-session answers PHONE_NOT_FOUND once the caller has proven
      // they hold the number (create-phone-verification no longer does — Phase 9).
      const code = err instanceof Error && err.message === 'PHONE_NOT_FOUND' ? 'PHONE_NOT_FOUND' : null;
      set({ error: code ?? translateError(err, 'Connexion échouée'), loading: false });
    }
  },

  sendEmailOtp: async (email) => {
    set({ emailOtpLoading: true, error: null });
    try {
      const { data: fnData, error: fnErr } = await supabase.functions.invoke('send-email-otp', {
        body: { email: email.trim().toLowerCase() },
      });
      if (fnErr) {
        try {
          const body = await (fnErr as { context?: { json?: () => Promise<{ error?: string }> } }).context?.json?.();
          if (body?.error) throw new Error(body.error);
        } catch (extractErr) {
          if (extractErr !== fnErr) throw extractErr;
        }
        throw fnErr;
      }
      if (fnData?.error) throw new Error(fnData.error);
      set({ emailOtpLoading: false });
      return { verificationId: (fnData as { verificationId: string }).verificationId };
    } catch (err) {
      const raw = err instanceof Error ? err.message : String(err);
      set({ error: translateError(err, raw), emailOtpLoading: false });
      return null;
    }
  },

  recoverByEmail: async (email, code, verificationId) => {
    set({ loading: true, error: null });
    try {
      const { data: fnData, error: fnErr } = await supabase.functions.invoke('recover-by-email', {
        body: { email: email.trim().toLowerCase(), code: code.trim(), verificationId },
      });
      if (fnErr) {
        try {
          const body = await (fnErr as { context?: { json?: () => Promise<{ error?: string }> } }).context?.json?.();
          if (body?.error) throw new Error(body.error);
        } catch (extractErr) {
          if (extractErr !== fnErr) throw extractErr;
        }
        throw fnErr;
      }
      if (fnData?.error) throw new Error(fnData.error);

      const { token_hash } = fnData as { token_hash: string };
      const { data: { session }, error: otpErr } = await supabase.auth.verifyOtp({
        token_hash,
        type: 'magiclink',
      });
      if (otpErr) throw otpErr;
      if (!session) throw new Error('Session introuvable');

      void saveBioRefreshToken(session.refresh_token);
      const appSession = await loadSession(session.user.id, session.user.phone);
      identifyUser(appSession);
      if (appSession.activeBusiness) void loginPurchases(appSession.activeBusiness.id);
      trackEvent('user_logged_in', appSession.activeBusiness?.id ?? null, appSession.user.id, {
        method: 'email_recovery',
        has_business: appSession.memberships.length > 0,
      });
      const removed = await syncKnownBusinesses(session.user.id, appSession.memberships);
      if (removed.length > 0 && appSession.memberships.length === 0) {
        set({ session: appSession, justAuthenticated: true, removedBusinessesOnLogin: removed, loading: false });
      } else if (removed.length > 0 && appSession.memberships.length > 0) {
        set({ session: appSession, justAuthenticated: true, dismissedFromBusiness: { name: removed[0].name }, loading: false });
      } else {
        set({ session: appSession, justAuthenticated: true, loading: false });
      }
    } catch (err) {
      const raw = err instanceof Error ? err.message : 'Récupération échouée';
      set({ error: translateError(err, raw), loading: false });
    }
  },

  linkRecoveryEmail: async (email, code, verificationId) => {
    set({ emailOtpLoading: true, error: null });
    try {
      const { data: fnData, error: fnErr } = await supabase.functions.invoke('link-recovery-email', {
        body: { email: email.trim().toLowerCase(), code: code.trim(), verificationId },
      });
      if (fnErr) {
        try {
          const body = await (fnErr as { context?: { json?: () => Promise<{ error?: string }> } }).context?.json?.();
          if (body?.error) throw new Error(body.error);
        } catch (extractErr) {
          if (extractErr !== fnErr) throw extractErr;
        }
        throw fnErr;
      }
      if (fnData?.error) throw new Error(fnData.error);

      const normalizedEmail = email.trim().toLowerCase();
      set(state => {
        if (!state.session) return state;
        return {
          session: { ...state.session, user: { ...state.session.user, recovery_email: normalizedEmail } },
          emailOtpLoading: false,
        };
      });
      return true;
    } catch (err) {
      const raw = err instanceof Error ? err.message : String(err);
      set({ error: translateError(err, raw), emailOtpLoading: false });
      return false;
    }
  },

  refreshActiveBusiness: async () => {
    const { session } = get();
    if (!session?.activeBusiness) return;

    const { data } = await supabase
      .from('businesses')
      .select('subscription_status, trial_ends_at, subscription_expires_at, bonus_access_until, payment_provider, updated_at')
      .eq('id', session.activeBusiness.id)
      .single();

    if (!data) return;

    set({
      session: {
        ...session,
        activeBusiness: { ...session.activeBusiness, ...data },
        memberships: session.memberships.map(m =>
          m.business_id === session.activeBusiness!.id
            ? { ...m, business: { ...(m.business as Business), ...data } }
            : m,
        ),
      },
    });
    // Separate, best-effort query (see refreshTeamsFlag) so a server without
    // the v227 column can never break the subscription refresh above.
    await get().refreshTeamsFlag();
  },

  refreshTeamsFlag: async () => {
    const business = get().session?.activeBusiness;
    if (!business) return;
    const businessId = business.id;
    try {
      const { data, error } = await withTimeout(
        supabase.from('businesses').select('teams_enabled').eq('id', businessId).single(),
      );
      // Unknown (error, old server without the column, missing row) → leave
      // whatever we already have. Fail-open: never hide UI on an unknown flag.
      if (error || !data || typeof data.teams_enabled !== 'boolean') return;
      const flag: boolean = data.teams_enabled;
      const cur = get().session;
      // The user may have switched business while this was in flight.
      if (!cur?.activeBusiness || cur.activeBusiness.id !== businessId) return;
      if (cur.activeBusiness.teams_enabled === flag) return;
      const nextSession: AppSession = {
        ...cur,
        activeBusiness: { ...cur.activeBusiness, teams_enabled: flag },
        memberships: cur.memberships.map(m =>
          m.business_id === businessId
            ? { ...m, business: { ...(m.business as Business), teams_enabled: flag } }
            : m,
        ),
      };
      void persistSessionCache(nextSession);
      set({ session: nextSession });
    } catch {
      // Network failure / timeout — keep the cached value (fail-open).
    }
  },

  clearTrialWelcome: () => set({ showTrialWelcome: false }),
  clearError: () => set({ error: null }),

  handleMembershipRemoved: (businessName) => {
    resetAllStores();
    set(state => ({
      removedBusinessName: businessName,
      session: state.session
        ? { ...state.session, activeBusiness: null, activeMembership: null }
        : null,
    }));
  },

  handleMembershipRemovedWithFallback: (removedBusinessId, removedBusinessName, remainingMemberships) => {
    resetAllStores();
    const first = remainingMemberships[0];
    set(state => ({
      dismissedFromBusiness: { name: removedBusinessName },
      session: state.session
        ? {
          ...state.session,
          memberships: remainingMemberships,
          activeBusiness: (first.business as Business) ?? null,
          activeMembership: first,
        }
        : null,
    }));
  },

  handleRoleChanged: (newRole) => {
    set(state => {
      if (!state.session?.activeMembership) return state;
      return {
        session: {
          ...state.session,
          activeMembership: { ...state.session.activeMembership, role: newRole },
        },
      };
    });
  },

  clearRemovedBusiness: () => set({ removedBusinessName: null }),
  clearRemovedBusinessesOnLogin: () => set({ removedBusinessesOnLogin: null }),
  clearDismissedFromBusiness: () => set({ dismissedFromBusiness: null }),

  openBusinessDrawer: () => set({ businessDrawerOpen: true }),
  closeBusinessDrawer: () => set({ businessDrawerOpen: false }),
}));
