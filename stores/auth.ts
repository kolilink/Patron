import { create } from 'zustand';
import { supabase } from '@/lib/supabase';
import type { AppSession, Business, Membership, User } from '@/src/types';

interface AuthStore {
  session: AppSession | null;
  loading: boolean;
  error: string | null;

  initialize: () => Promise<void>;
  login: (email: string, password: string) => Promise<void>;
  register: (name: string, email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  selectBusiness: (businessId: string) => void;
  createBusiness: (data: { name: string; type?: string; currency: string }) => Promise<void>;
  joinBusiness: (code: string) => Promise<void>;
  clearError: () => void;
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
    name: p.name,
    email: p.email,
    phone: p.phone ?? null,
    avatar_url: p.avatar_url ?? null,
    language: p.language ?? 'fr',
    created_at: p.created_at,
    updated_at: p.updated_at,
  };

  // Auto-select the single business if user only has one
  const activeMembership = memberships.length === 1 ? memberships[0] : null;
  const activeBusiness = (activeMembership?.business as Business) ?? null;

  return { user, memberships, activeBusiness, activeMembership };
}

export const useAuthStore = create<AuthStore>((set, get) => ({
  session: null,
  loading: true,
  error: null,

  initialize: async () => {
    try {
      const { data: { session } } = await supabase.auth.getSession();

      if (!session) {
        set({ session: null, loading: false });
        return;
      }

      const appSession = await loadSession(session.user.id);
      set({ session: appSession, loading: false });
    } catch {
      set({ session: null, loading: false });
    }

    supabase.auth.onAuthStateChange(async (event, session) => {
      if (event === 'SIGNED_OUT' || !session) {
        set({ session: null });
      }
    });
  },

  login: async (email, password) => {
    set({ loading: true, error: null });
    try {
      const { data, error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) throw error;

      const appSession = await loadSession(data.user.id);
      set({ session: appSession, loading: false });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Erreur de connexion';
      set({ error: msg, loading: false });
    }
  },

  register: async (name, email, password) => {
    set({ loading: true, error: null });
    try {
      const { data, error } = await supabase.auth.signUp({
        email,
        password,
        options: { data: { name } }, // trigger uses this to create profile
      });
      if (error) throw error;
      if (!data.user) throw new Error('Inscription échouée');

      if (!data.session) {
        // Email confirmation is enabled — user must confirm before logging in
        set({
          loading: false,
          error: 'Un email de confirmation a été envoyé. Vérifiez votre boîte mail puis connectez-vous.',
        });
        return;
      }

      // Session exists (email confirmation disabled) — create profile via upsert
      // so it's idempotent if the DB trigger already created it
      await supabase.from('profiles').upsert({
        id: data.user.id,
        name,
        email,
        language: 'fr',
      });

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
      const msg = err instanceof Error ? err.message : "Erreur d'inscription";
      set({ error: msg, loading: false });
    }
  },

  logout: async () => {
    await supabase.auth.signOut();
    set({ session: null, error: null });
  },

  selectBusiness: (businessId) => {
    const { session } = get();
    if (!session) return;

    const membership = session.memberships.find(m => m.business_id === businessId);
    if (!membership) return;

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
    try {
      const { data: business, error: bizErr } = await supabase
        .from('businesses')
        .insert({ name, type: type ?? null, currency, created_by: session.user.id })
        .select()
        .single();
      if (bizErr) throw bizErr;

      const { data: membership, error: memErr } = await supabase
        .from('memberships')
        .insert({ user_id: session.user.id, business_id: business.id, role: 'administrateur' })
        .select('*, business:businesses(*)')
        .single();
      if (memErr) throw memErr;

      const m = membership as Membership;
      set({
        session: {
          ...session,
          memberships: [...session.memberships, m],
          activeBusiness: business as Business,
          activeMembership: m,
        },
        loading: false,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Erreur lors de la création';
      set({ error: msg, loading: false });
    }
  },

  joinBusiness: async (code) => {
    const { session } = get();
    if (!session) return;

    set({ loading: true, error: null });
    try {
      const { data: invite, error: invErr } = await supabase
        .from('invite_codes')
        .select('*, business:businesses(*)')
        .eq('code', code.trim().toUpperCase())
        .single();

      if (invErr || !invite) throw new Error('Code invalide ou introuvable');
      if (invite.expires_at && new Date(invite.expires_at) < new Date()) {
        throw new Error('Ce code a expiré');
      }
      if (invite.max_uses != null && invite.uses >= invite.max_uses) {
        throw new Error("Ce code a atteint sa limite d'utilisation");
      }

      const { data: membership, error: memErr } = await supabase
        .from('memberships')
        .insert({ user_id: session.user.id, business_id: invite.business_id, role: invite.role })
        .select('*, business:businesses(*)')
        .single();

      if (memErr) {
        if (memErr.code === '23505') throw new Error('Vous êtes déjà membre de ce commerce');
        throw memErr;
      }

      // Increment uses (best-effort, don't fail the join if this fails)
      supabase
        .from('invite_codes')
        .update({ uses: (invite.uses ?? 0) + 1 })
        .eq('id', invite.id)
        .then(() => {});

      const m = membership as Membership;
      set({
        session: {
          ...session,
          memberships: [...session.memberships, m],
          activeBusiness: invite.business as Business,
          activeMembership: m,
        },
        loading: false,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Erreur lors de la jonction';
      set({ error: msg, loading: false });
    }
  },

  clearError: () => set({ error: null }),
}));
