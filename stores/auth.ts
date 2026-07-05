import { create } from 'zustand';
import * as SecureStore from 'expo-secure-store';
import * as Localization from 'expo-localization';
import { supabase, clearSupabaseLocalSession, revokeAccessToken } from '@/lib/supabase';
import { translateError } from '@/lib/errors';
import { generateId } from '@/lib/id';
import { syncKnownBusinesses } from '@/lib/knownBusinesses';
import { getKV, setKV } from '@/lib/db';
import { isLocked, setLocked, clearPin, verifyPin, incrementPinFailCount, resetPinFailCount } from '@/lib/pin';
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
import { trackEvent, identifyUser, resetAnalytics } from '@/lib/analytics';
import { notifyEvent, deleteDeviceToken } from '@/src/utils/notifications';

// ─── Last phone + biometric refresh token (quick-login) ──────────────────────

const LAST_PHONE_KEY      = 'patron_last_phone';
const BIO_REFRESH_KEY     = 'patron_bio_refresh_token';

async function saveLastPhone(phone: string): Promise<void> {
  try { await SecureStore.setItemAsync(LAST_PHONE_KEY, phone); } catch {}
}

export async function getLastPhone(): Promise<string | null> {
  try { return await SecureStore.getItemAsync(LAST_PHONE_KEY); } catch { return null; }
}

async function saveBioRefreshToken(token: string): Promise<void> {
  try { await SecureStore.setItemAsync(BIO_REFRESH_KEY, token); } catch {}
}

async function getBioRefreshToken(): Promise<string | null> {
  try { return await SecureStore.getItemAsync(BIO_REFRESH_KEY); } catch { return null; }
}

async function clearBioRefreshToken(): Promise<void> {
  try { await SecureStore.deleteItemAsync(BIO_REFRESH_KEY); } catch {}
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
  } catch {}
}

async function restoreSessionCache(): Promise<AppSession | null> {
  try {
    const countStr = await SecureStore.getItemAsync(`${SESSION_CACHE_KEY}_count`);
    if (!countStr) return null;
    const count = parseInt(countStr, 10);
    let json = '';
    for (let i = 0; i < count; i++) {
      const chunk = await SecureStore.getItemAsync(`${SESSION_CACHE_KEY}_${i}`);
      if (!chunk) return null;
      json += chunk;
    }
    return JSON.parse(json) as AppSession;
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
  } catch {}
}

// If logout() couldn't reach the server to revoke the session (offline, or
// killed before the background attempt finished), the access token it was
// trying to revoke is stashed here so the next launch can retry — otherwise
// that refresh token would stay valid on Supabase's side indefinitely.
async function retryPendingSignOut(): Promise<void> {
  const pending = await getKV(PENDING_SIGNOUT_TOKEN_KEY).catch(() => null);
  if (!pending) return;
  const ok = await revokeAccessToken(pending);
  if (ok) await setKV(PENDING_SIGNOUT_TOKEN_KEY, '').catch(() => {});
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
}

interface PendingPhoneVerification {
  verificationId: string;
  phone: string;
}

interface AuthStore {
  session: AppSession | null;
  loading: boolean;
  locked: boolean;
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
  logout: () => Promise<void>;
  selectBusiness: (businessId: string) => void;
  createBusiness: (data: { name: string; type?: string; currency: string }) => Promise<void>;
  joinBusiness: (code: string) => Promise<void>;
  loginWithBiometric: () => Promise<boolean>;
  lock: () => Promise<void>;
  // 'wrong-pin' counts against the attempt limit; 'restore-failed' means the PIN
  // was correct but the underlying session couldn't be refreshed (e.g. offline)
  // — that must never be reported to the user as an incorrect code.
  unlockWithPin: (pin: string) => Promise<'unlocked' | 'wrong-pin' | 'restore-failed'>;
  unlockWithBiometric: () => Promise<boolean>;
  createPhoneVerification: (phone: string) => Promise<{ verificationId: string } | null>;
  loginWithPhone: (phone: string) => Promise<{ verificationId: string } | null>;
  verifyPhoneCode: (phone: string, code: string, verificationId: string) => Promise<boolean>;
  upgradePhone: (phone: string) => Promise<void>;
  restorePhoneSession: (phone: string, verificationId: string) => Promise<void>;
  businessDrawerOpen: boolean;
  openBusinessDrawer: () => void;
  closeBusinessDrawer: () => void;

  sendEmailOtp: (email: string) => Promise<{ verificationId: string } | null>;
  recoverByEmail: (email: string, code: string, verificationId: string) => Promise<void>;
  linkRecoveryEmail: (email: string, code: string, verificationId: string) => Promise<boolean>;

  startDemoMode: () => Promise<void>;

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
  const [profileRes, membershipsRes] = await Promise.all([
    supabase.from('profiles').select('*').eq('id', userId).single(),
    supabase
      .from('memberships')
      .select('*, business:businesses(*)')
      .eq('user_id', userId),
  ]);

  if (profileRes.error) throw profileRes.error;
  if (membershipsRes.error) throw membershipsRes.error;

  const p = profileRes.data;
  const memberships = membershipsRes.data as Membership[];

  const user: User = {
    id: userId,
    name: p.name ?? '',
    email: p.email ?? '',
    phone: p.phone ?? authPhone ?? null,
    avatar_url: p.avatar_url ?? null,
    language: p.language ?? 'fr',
    recovery_email: p.recovery_email ?? null,
    created_at: p.created_at,
    updated_at: p.updated_at,
  };

  const lastBusinessId = await getKV(`last_business_${userId}`).catch(() => null);
  const preferred = lastBusinessId ? memberships.find(m => m.business_id === lastBusinessId) : null;
  const activeMembership = preferred ?? (memberships.length >= 1 ? memberships[0] : null);
  const activeBusiness = (activeMembership?.business as Business) ?? null;

  const session: AppSession = { user, memberships, activeBusiness, activeMembership };
  if (!skipCache) void persistSessionCache(session);
  return session;
}

export const useAuthStore = create<AuthStore>((set, get) => ({
  session: null,
  loading: true,
  locked: false,
  emailOtpLoading: false,
  error: null,
  pendingPhoneVerification: null,
  removedBusinessName: null,
  removedBusinessesOnLogin: null,
  dismissedFromBusiness: null,
  showTrialWelcome: false,
  businessDrawerOpen: false,

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
    // yet, ask for the PIN first." Honor that before hydrating anything, so a
    // killed-and-relaunched app lands on the PIN screen instead of silently
    // back inside.
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
      const { data: { session } } = await supabase.auth.getSession();
      _currentAccessToken = session?.access_token ?? _currentAccessToken;

      // Retry any server-side sign-out that couldn't reach the network last
      // time (see logout()) — best-effort, never blocks startup.
      void retryPendingSignOut();

      if (!session) {
        if (!cachedSession) set({ session: null, loading: false });
        // Offline (or genuinely logged out) with a cached session already
        // rendered above — nothing more to do here.
      } else {
        // Belt-and-suspenders: save the token we got from getSession() directly,
        // in case the TOKEN_REFRESHED event fired before the listener was ready.
        void saveBioRefreshToken(session.refresh_token);

        // Cache is written explicitly below, once we know whether this is a
        // genuine login — not unconditionally inside loadSession() — so an
        // abandoned anonymous/phone-verification session never gets persisted
        // and later restored offline as if it were a real logged-in user.
        const appSession = await loadSession(session.user.id, session.user.phone, true);
        // Anonymous user with no phone = either still in the verification flow
        // OR a returning demo user. Check KV to distinguish the two cases.
        if (session.user.is_anonymous && !appSession.user.phone) {
          const demoFlag = await getKV(`demo_mode_${session.user.id}`).catch(() => null);
          if (demoFlag === 'true') {
            const demoSession = { ...appSession, isDemoMode: true };
            void persistSessionCache(demoSession);
            set({ session: demoSession, loading: false });
          } else {
            // Genuinely incomplete session (verification abandoned mid-flow) —
            // do not cache it. Nothing is persisted, so an offline cold start
            // later won't resurrect this half-finished login.
            set({ session: null, loading: false });
          }
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

  logout: async () => {
    const { session } = get();
    const userId = session?.user.id;
    const accessTokenToRevoke = _currentAccessToken;
    trackEvent('user_logged_out', session?.activeBusiness?.id ?? null, userId ?? null);
    resetAnalytics();

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
    void clearPin();
    await setLocked(false);
    if (userId) setKV(`demo_mode_${userId}`, 'false').catch(() => {});
    resetAllStores();
    set({ session: null, locked: false, error: null, pendingPhoneVerification: null });

    void (async () => {
      // Unsubscribe Realtime channels before signOut() disconnects the
      // WebSocket — otherwise channel error callbacks can fire after the
      // socket closes and become unhandled rejections that crash Hermes.
      try { await supabase.removeAllChannels(); } catch {}
      let signOutOk = true;
      try { await supabase.auth.signOut(); } catch { signOutOk = false; }
      // signOut() throwing means we can't be sure the server ever heard about
      // this — revoke directly with the token captured before the local wipe.
      // If that also fails (offline), stash it so the next launch retries;
      // otherwise this refresh token would stay valid on Supabase's side.
      if (!signOutOk && accessTokenToRevoke) {
        const ok = await revokeAccessToken(accessTokenToRevoke);
        if (!ok) await setKV(PENDING_SIGNOUT_TOKEN_KEY, accessTokenToRevoke).catch(() => {});
      }
      _explicitLogout = false;
    })();

    // Remove push token fire-and-forget — must not block or crash the logout.
    if (!session?.isDemoMode) {
      void (async () => {
        try {
          const { getExpoPushTokenAsync } = await import('expo-notifications');
          const tokenResult = await getExpoPushTokenAsync({ projectId: '9cd0ec2b-0dc9-49f3-ba97-999bb31a0252' });
          const { Platform } = await import('react-native');
          await deleteDeviceToken(tokenResult.data, Platform.OS as 'ios' | 'android');
        } catch {}
      })();
    }
  },

  selectBusiness: (businessId) => {
    const { session } = get();
    if (!session) return;

    const membership = session.memberships.find(m => m.business_id === businessId);
    if (!membership) return;

    setKV(`last_business_${session.user.id}`, businessId).catch(() => {});
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
  },

  createBusiness: async ({ name, type, currency }) => {
    const { session } = get();
    if (!session) return;

    const alreadyOwns = session.memberships.some(m => m.role === 'administrateur');
    if (alreadyOwns) {
      set({ error: 'Vous avez déjà un commerce actif. Bientôt, vous pourrez en gérer plusieurs.', loading: false });
      return;
    }

    set({ loading: true, error: null });

    const businessId = generateId();

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
    const newMemberships = [...session.memberships, m];
    // Persist so next cold start lands on the newly created business
    setKV(`last_business_${session.user.id}`, businessId).catch(() => {});
    // Seed the cache so first-reload removal detection works immediately
    syncKnownBusinesses(session.user.id, newMemberships).catch(() => {});
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
  },

  joinBusiness: async (code) => {
    const { session } = get();
    if (!session) return;

    set({ loading: true, error: null });
    try {
      const joinedCount = session.memberships.filter(m => m.role !== 'administrateur').length;
      if (joinedCount >= 3) throw new Error('Vous avez atteint la limite de 3 commerces rejoints. Bientôt, vous pourrez en rejoindre davantage.');

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
          return;
        }
        throw rpcErr;
      }
      if (!invite) throw new Error('Code invalide. Vérifiez le code et réessayez.');

      const { business_id } = invite as { business_id: string };

      // Persist the joined business so next cold start (and loadSession below) lands on it
      setKV(`last_business_${session.user.id}`, business_id).catch(() => {});
      // Reload the full session now that the membership exists and RLS can see the business
      const appSession = await loadSession(session.user.id);
      syncKnownBusinesses(session.user.id, appSession.memberships).catch(() => {});
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
    } catch (err) {
      const raw = err instanceof Error ? err.message : (err as Record<string, unknown>)?.message as string | undefined;
      set({ error: translateError(err, raw ?? 'Erreur lors de la jonction'), loading: false });
    }
  },

  loginWithBiometric: async () => {
    set({ loading: true, error: null });
    try {
      // First try Supabase's own stored session.
      let result = await supabase.auth.refreshSession();

      // If that failed (Supabase storage was cleared/expired), fall back to our
      // separately stored refresh token — it survives Supabase storage resets.
      if (result.error || !result.data.session) {
        const storedToken = await getBioRefreshToken();
        if (storedToken) {
          result = await supabase.auth.refreshSession({ refresh_token: storedToken });
        }
      }

      if (result.error || !result.data.session) {
        set({ loading: false });
        return false;
      }

      // Keep our stored token up to date with the newly rotated one.
      void saveBioRefreshToken(result.data.session.refresh_token);

      const appSession = await loadSession(result.data.session.user.id);
      const removed = await syncKnownBusinesses(result.data.session.user.id, appSession.memberships);
      if (removed.length > 0 && appSession.memberships.length === 0) {
        set({ session: appSession, removedBusinessesOnLogin: removed, loading: false });
      } else if (removed.length > 0 && appSession.memberships.length > 0) {
        set({ session: appSession, dismissedFromBusiness: { name: removed[0].name }, loading: false });
      } else {
        set({ session: appSession, loading: false });
      }
      return true;
    } catch {
      set({ loading: false });
      return false;
    }
  },

  // ─── PIN-based soft lock ───────────────────────────────────────────────────
  // "Verrouiller" is deliberately NOT logout(): it never touches SecureStore's
  // Supabase session, the bio refresh token, or any domain store — those are
  // exactly what let unlockWithPin/unlockWithBiometric restore the session for
  // free below, with no WhatsApp OTP. logout() remains the only path that
  // wipes all of that, for the rarer "fully sign out / switch account" case.

  lock: async () => {
    await setLocked(true);
    set({ session: null, locked: true });
  },

  unlockWithPin: async (pin) => {
    const ok = await verifyPin(pin);
    if (!ok) {
      await incrementPinFailCount();
      return 'wrong-pin';
    }
    // The PIN itself is correct from here on — nothing below should ever
    // count against the wrong-attempt limit or be reported as a bad code.
    await resetPinFailCount();
    const restored = await get().loginWithBiometric();
    if (!restored) return 'restore-failed';
    await setLocked(false);
    set({ locked: false });
    return 'unlocked';
  },

  unlockWithBiometric: async () => {
    try {
      const LocalAuthentication = await import('expo-local-authentication');
      const [hasHardware, isEnrolled] = await Promise.all([
        LocalAuthentication.hasHardwareAsync(),
        LocalAuthentication.isEnrolledAsync(),
      ]);
      if (!hasHardware || !isEnrolled) return false;

      const result = await LocalAuthentication.authenticateAsync({
        promptMessage: 'Confirmez votre identité pour continuer',
        cancelLabel: 'Annuler',
      });
      if (!result.success) return false;
    } catch {
      return false;
    }

    const restored = await get().loginWithBiometric();
    if (restored) {
      await setLocked(false);
      set({ locked: false });
    }
    return restored;
  },

  createPhoneVerification: async (phone) => {
    set({ loading: true, error: null });
    try {
      // If no Supabase session exists, create a fresh anonymous one so the Edge
      // Function can link the verification to a user_id. If one already exists
      // (e.g., converting from demo mode), reuse it — no new anonymous user needed.
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
      set({ error: raw, loading: false });
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
      set({ error: raw, loading: false });
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
      set({ error: raw, loading: false });
      return false;
    }
  },

  upgradePhone: async (phone) => {
    set({ loading: true, error: null });
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Session introuvable');

      await supabase.from('profiles').upsert(
        { id: user.id, name: '', email: '', phone: phone.trim(), language: 'fr' },
        { onConflict: 'id', ignoreDuplicates: false },
      );

      // Lift anonymous flag so RLS policies that block anonymous users allow this user through.
      await supabase.rpc('upgrade_anonymous_user');
      // Refresh the JWT so the new is_anonymous=false claim takes effect immediately.
      const { data: refreshData } = await supabase.auth.refreshSession();
      if (refreshData.session) void saveBioRefreshToken(refreshData.session.refresh_token);

      void saveLastPhone(phone.trim());
      // Clear demo mode flag — this user is now a real account
      setKV(`demo_mode_${user.id}`, 'false').catch(() => {});
      const appSession = await loadSession(user.id);
      identifyUser(appSession);
      trackEvent('user_signed_up', appSession.activeBusiness?.id ?? null, appSession.user.id, {
        has_business: appSession.memberships.length > 0,
      });
      const removed = await syncKnownBusinesses(user.id, appSession.memberships);
      if (removed.length > 0 && appSession.memberships.length === 0) {
        set({ session: appSession, removedBusinessesOnLogin: removed, loading: false, pendingPhoneVerification: null });
      } else if (removed.length > 0 && appSession.memberships.length > 0) {
        set({ session: appSession, dismissedFromBusiness: { name: removed[0].name }, loading: false, pendingPhoneVerification: null });
      } else {
        set({ session: appSession, loading: false, pendingPhoneVerification: null });
      }
    } catch (err) {
      set({ error: translateError(err, 'Vérification échouée'), loading: false });
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
      trackEvent('user_logged_in', appSession.activeBusiness?.id ?? null, appSession.user.id, {
        method: 'phone_otp',
        has_business: appSession.memberships.length > 0,
      });
      const removed = await syncKnownBusinesses(session.user.id, appSession.memberships);
      if (removed.length > 0 && appSession.memberships.length === 0) {
        set({ session: appSession, removedBusinessesOnLogin: removed, loading: false, pendingPhoneVerification: null });
      } else if (removed.length > 0 && appSession.memberships.length > 0) {
        set({ session: appSession, dismissedFromBusiness: { name: removed[0].name }, loading: false, pendingPhoneVerification: null });
      } else {
        set({ session: appSession, loading: false, pendingPhoneVerification: null });
      }
    } catch (err) {
      set({ error: translateError(err, 'Connexion échouée'), loading: false });
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
      set({ error: raw, emailOtpLoading: false });
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
      trackEvent('user_logged_in', appSession.activeBusiness?.id ?? null, appSession.user.id, {
        method: 'email_recovery',
        has_business: appSession.memberships.length > 0,
      });
      const removed = await syncKnownBusinesses(session.user.id, appSession.memberships);
      if (removed.length > 0 && appSession.memberships.length === 0) {
        set({ session: appSession, removedBusinessesOnLogin: removed, loading: false });
      } else if (removed.length > 0 && appSession.memberships.length > 0) {
        set({ session: appSession, dismissedFromBusiness: { name: removed[0].name }, loading: false });
      } else {
        set({ session: appSession, loading: false });
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
      set({ error: raw, emailOtpLoading: false });
      return false;
    }
  },

  startDemoMode: async () => {
    set({ loading: true, error: null });
    try {
      const { data, error: anonErr } = await supabase.auth.signInAnonymously();
      if (anonErr) throw anonErr;
      if (!data.user) throw new Error('Connexion anonyme échouée');
      const userId = data.user.id;

      await supabase.from('profiles').upsert(
        { id: userId, name: 'Démo', email: '', language: 'fr' },
        { onConflict: 'id', ignoreDuplicates: true },
      );

      // Detect the device's local currency so the demo business reflects it.
      const SUPPORTED_CURRENCIES = new Set([
        'GNF', 'XOF', 'XAF', 'NGN', 'GHS', 'MAD', 'DZD', 'TND', 'EGP',
        'KES', 'ZAR', 'ETB', 'AED', 'SAR', 'USD', 'EUR', 'GBP', 'CNY', 'CAD', 'CHF', 'INR',
      ]);
      let demoCurrency = 'USD'; // fallback for unrecognized locales
      try {
        const code = Localization.getLocales()[0]?.currencyCode;
        if (code && SUPPORTED_CURRENCIES.has(code)) demoCurrency = code;
      } catch {}

      const { data: fnData, error: fnErr } = await supabase.functions.invoke('seed-demo-business', {
        body: { currency: demoCurrency },
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

      const { businessId } = fnData as { businessId: string };
      await setKV(`last_business_${userId}`, businessId).catch(() => {});
      await setKV(`demo_mode_${userId}`, 'true').catch(() => {});

      const appSession = await loadSession(userId);
      set({ session: { ...appSession, isDemoMode: true }, loading: false });
    } catch (err) {
      set({ error: translateError(err, 'Erreur lors du démarrage de la démo'), loading: false });
    }
  },

  refreshActiveBusiness: async () => {
    const { session } = get();
    if (!session?.activeBusiness) return;

    const { data } = await supabase
      .from('businesses')
      .select('subscription_status, trial_ends_at, subscription_expires_at, updated_at')
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
