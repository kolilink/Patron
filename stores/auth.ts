import { create } from 'zustand';
import { supabase } from '@/lib/supabase';
import { translateError } from '@/lib/errors';
import { generateId } from '@/lib/id';
import { syncKnownBusinesses } from '@/lib/knownBusinesses';
import type { AppSession, Business, Membership, Role, User } from '@/src/types';
import { useProductStore } from './products';
import { useVentesStore } from './ventes';
import { useExpensesStore } from './expenses';
import { useEquipeStore } from './equipe';
import { useFournisseursStore } from './fournisseurs';
import { useSalesStore } from './sales';

function resetAllStores() {
  useProductStore.getState().reset();
  useVentesStore.getState().reset();
  useExpensesStore.getState().reset();
  useEquipeStore.getState().reset();
  useFournisseursStore.getState().reset();
  useSalesStore.getState().reset();
}

interface PendingPhoneVerification {
  verificationId: string;
  token: string;
  phone: string;
}

interface AuthStore {
  session: AppSession | null;
  loading: boolean;
  error: string | null;
  pendingPhoneVerification: PendingPhoneVerification | null;
  removedBusinessName: string | null;
  removedBusinessesOnLogin: Array<{ id: string; name: string }> | null;
  dismissedFromBusiness: { name: string } | null;

  initialize: () => Promise<void>;
  signInAnonymously: () => Promise<void>;
  login: (email: string, password: string) => Promise<void>;
  register: (name: string, email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  selectBusiness: (businessId: string) => void;
  createBusiness: (data: { name: string; type?: string; currency: string }) => Promise<void>;
  joinBusiness: (code: string) => Promise<void>;
  createPhoneVerification: (phone: string) => Promise<{ token: string; verificationId: string } | null>;
  loginWithPhone: (phone: string) => Promise<{ token: string; verificationId: string } | null>;
  upgradePhone: (phone: string) => Promise<void>;
  restorePhoneSession: (phone: string, verificationId: string) => Promise<void>;
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

async function loadSession(userId: string): Promise<AppSession> {
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
    phone: p.phone ?? null,
    avatar_url: p.avatar_url ?? null,
    language: p.language ?? 'fr',
    created_at: p.created_at,
    updated_at: p.updated_at,
  };

  const activeMembership = memberships.length >= 1 ? memberships[0] : null;
  const activeBusiness = (activeMembership?.business as Business) ?? null;

  return { user, memberships, activeBusiness, activeMembership };
}

export const useAuthStore = create<AuthStore>((set, get) => ({
  session: null,
  loading: true,
  error: null,
  pendingPhoneVerification: null,
  removedBusinessName: null,
  removedBusinessesOnLogin: null,
  dismissedFromBusiness: null,

  initialize: async () => {
    try {
      const { data: { session } } = await supabase.auth.getSession();

      if (!session) {
        set({ session: null, loading: false });
      } else {
        const appSession = await loadSession(session.user.id);
        // Anonymous user with no phone = still in the verification flow.
        // Don't set session — keep them on the welcome screen.
        if (session.user.is_anonymous && !appSession.user.phone) {
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
      set({ session: null, loading: false });
    }

    supabase.auth.onAuthStateChange(async (event, session) => {
      if (event === 'SIGNED_OUT' || !session) {
        set({ session: null });
        resetAllStores();
      }
    });
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
    await supabase.auth.signOut();
    resetAllStores();
    set({ session: null, error: null, pendingPhoneVerification: null });
  },

  selectBusiness: (businessId) => {
    const { session } = get();
    if (!session) return;

    const membership = session.memberships.find(m => m.business_id === businessId);
    if (!membership) return;

    resetAllStores();

    set({
      session: {
        ...session,
        activeBusiness: (membership.business as Business) ?? null,
        activeMembership: membership,
      },
    });
  },

  createBusiness: async ({ name, type, currency }) => {
    const { session } = get();
    if (!session) return;

    set({ loading: true, error: null });

    const businessId = generateId();

    const { error: bizErr } = await supabase
      .from('businesses')
      .insert({ id: businessId, name, type: type ?? null, currency, created_by: session.user.id });
    if (bizErr) {
      set({ error: translateError(bizErr, 'Impossible de créer le commerce'), loading: false });
      return;
    }

    // Retry up to 3x — the DB trigger creating the membership row may lag slightly
    let membership = null;
    let fetchErr = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt > 0) await new Promise<void>(r => setTimeout(r, 300));
      const res = await supabase
        .from('memberships')
        .select('*, business:businesses(*)')
        .eq('user_id', session.user.id)
        .eq('business_id', businessId)
        .single();
      if (!res.error) { membership = res.data; break; }
      fetchErr = res.error;
    }
    if (!membership) {
      set({ error: translateError(fetchErr, 'Impossible de charger le commerce'), loading: false });
      return;
    }

    const m = membership as Membership;
    const newMemberships = [...session.memberships, m];
    // Seed the cache so first-reload removal detection works immediately
    syncKnownBusinesses(session.user.id, newMemberships).catch(() => {});
    set({
      session: {
        ...session,
        memberships: newMemberships,
        activeBusiness: m.business as Business,
        activeMembership: m,
      },
      loading: false,
    });
  },

  joinBusiness: async (code) => {
    const { session } = get();
    if (!session) return;

    set({ loading: true, error: null });
    try {
      if (session.memberships.length >= 2) throw new Error('Vous ne pouvez rejoindre que 2 commerces maximum.');

      // validate_invite_code: SECURITY DEFINER — handles rate limiting (5/10 min),
      // expiry, max_uses check, and atomically increments the uses counter.
      const { data: invite, error: rpcErr } = await supabase
        .rpc('validate_invite_code', { p_code: code.trim().toUpperCase() });

      if (rpcErr) throw rpcErr;
      if (!invite) throw new Error('Code invalide, expiré, ou déjà utilisé');

      const { business_id, role } = invite as { business_id: string; role: Role };

      const { error: memErr } = await supabase
        .from('memberships')
        .insert({ user_id: session.user.id, business_id, role });

      if (memErr) {
        if (memErr.code === '23505') {
          // Already a member — reload session so navigation proceeds
          const appSession = await loadSession(session.user.id);
          set({ session: appSession, loading: false });
          return;
        }
        throw memErr;
      }

      // Reload the full session now that the membership exists and RLS can see the business
      const appSession = await loadSession(session.user.id);
      syncKnownBusinesses(session.user.id, appSession.memberships).catch(() => {});
      set({ session: appSession, loading: false });
    } catch (err) {
      const fallback = err instanceof Error ? err.message : 'Erreur lors de la jonction';
      set({ error: translateError(err, fallback), loading: false });
    }
  },

  createPhoneVerification: async (phone) => {
    set({ loading: true, error: null });
    try {
      // Create anonymous session so the Edge Function can link the verification to a user_id
      const { data, error: anonErr } = await supabase.auth.signInAnonymously();
      if (anonErr) throw anonErr;
      if (!data.user) throw new Error('Connexion échouée');

      await supabase.from('profiles').upsert(
        { id: data.user.id, name: '', email: '', language: 'fr' },
        { onConflict: 'id', ignoreDuplicates: true },
      );

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

      const { token, verificationId } = fnData as { token: string; verificationId: string };
      set({
        pendingPhoneVerification: { verificationId, token, phone: phone.trim() },
        loading: false,
      });
      return { token, verificationId };
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

      const { token, verificationId } = fnData as { token: string; verificationId: string };
      set({ pendingPhoneVerification: { verificationId, token, phone: phone.trim() }, loading: false });
      return { token, verificationId };
    } catch (err) {
      const raw = err instanceof Error ? err.message : String(err);
      set({ error: raw, loading: false });
      return null;
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
      await supabase.auth.refreshSession();

      const appSession = await loadSession(user.id);
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

      const appSession = await loadSession(session.user.id);
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
}));
