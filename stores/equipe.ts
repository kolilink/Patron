import { create } from 'zustand';
import { supabase } from '@/lib/supabase';
import { generateId } from '@/lib/id';
import { translateError } from '@/lib/errors';
import type { Role } from '@/src/types';

// 32-char alphabet (removes ambiguous O, I, L, U) — ~40 bits of entropy per 8-char code
const CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function generateCode(): string {
  return Array.from({ length: 8 }, () => CODE_ALPHABET[Math.floor(Math.random() * 32)]).join('');
}

export interface Membre {
  id: string;
  user_id: string;
  business_id: string;
  role: Role;
  joined_at: string;
  user_name: string;
  user_email: string;
  user_phone: string | null;
}

export interface CodeInvitation {
  id: string;
  code: string;
  role: Role;
  expires_at: string | null;
  max_uses: number | null;
  uses: number;
  created_at: string;
}

interface EquipeStore {
  membres: Membre[];
  codes: CodeInvitation[];
  loading: boolean;
  saving: boolean;
  error: string | null;

  fetchMembres: (businessId: string) => Promise<void>;
  fetchCodes: (businessId: string) => Promise<void>;
  createCode: (businessId: string, userId: string, role: Role, expiresInHours?: number) => Promise<string | null>;
  revokeCode: (codeId: string) => Promise<boolean>;
  removeMembre: (membreId: string) => Promise<boolean>;
  changeRole: (membreId: string, newRole: Role) => Promise<boolean>;
  clearError: () => void;
  reset: () => void;
}

export const useEquipeStore = create<EquipeStore>((set, get) => ({
  membres: [],
  codes: [],
  loading: false,
  saving: false,
  error: null,

  fetchMembres: async (businessId) => {
    set({ loading: true });

    const { data: mData, error: mErr } = await supabase
      .from('memberships')
      .select('id, user_id, business_id, role, joined_at')
      .eq('business_id', businessId)
      .order('joined_at');

    if (mErr) {
      console.error('[fetchMembres memberships]', mErr instanceof Error ? mErr.message : (mErr as { message?: string })?.message ?? JSON.stringify(mErr));
      set({ loading: false, error: translateError(mErr, 'Erreur de chargement') });
      return;
    }

    const rows = mData ?? [];
    const userIds = rows.map(m => m.user_id as string);

    const profilesMap: Record<string, { name: string; email: string; phone: string | null }> = {};
    if (userIds.length > 0) {
      const { data: pData, error: pErr } = await supabase
        .from('profiles')
        .select('id, name, email, phone')
        .in('id', userIds);
      if (pErr) console.error('[fetchMembres profiles]', pErr instanceof Error ? pErr.message : (pErr as { message?: string })?.message ?? JSON.stringify(pErr));
      for (const p of pData ?? []) {
        profilesMap[p.id] = { name: p.name ?? '—', email: p.email ?? '—', phone: p.phone ?? null };
      }
    }

    set({
      membres: rows.map(m => ({
        id: m.id as string,
        user_id: m.user_id as string,
        business_id: m.business_id as string,
        role: m.role as Role,
        joined_at: m.joined_at as string,
        user_name: profilesMap[m.user_id as string]?.name ?? '—',
        user_email: profilesMap[m.user_id as string]?.email ?? '—',
        user_phone: profilesMap[m.user_id as string]?.phone ?? null,
      })),
      loading: false,
    });
  },

  fetchCodes: async (businessId) => {
    set({ loading: true });
    const { data, error } = await supabase
      .from('invite_codes')
      .select('*')
      .eq('business_id', businessId)
      .order('created_at', { ascending: false });
    if (error) { set({ loading: false, error: translateError(error, 'Erreur de chargement') }); return; }

    const all = (data ?? []) as CodeInvitation[];
    const now = new Date();

    // Delete consumed and expired codes — they can't be used and shouldn't show
    const staleIds = all
      .filter(c =>
        (c.max_uses != null && c.uses >= c.max_uses) ||
        (c.expires_at != null && new Date(c.expires_at) <= now)
      )
      .map(c => c.id);
    if (staleIds.length > 0) {
      await supabase.from('invite_codes').delete().in('id', staleIds);
    }

    set({
      codes: all.filter(c =>
        (c.max_uses == null || c.uses < c.max_uses) &&
        (c.expires_at == null || new Date(c.expires_at) > now)
      ),
      loading: false,
    });
  },

  createCode: async (businessId, userId, role, expiresInHours = 24) => {
    set({ saving: true, error: null });
    const code = generateCode();
    const expiresAt = new Date(Date.now() + expiresInHours * 3600000).toISOString();

    const { error } = await supabase.from('invite_codes').insert({
      id: generateId(),
      business_id: businessId,
      code,
      role,
      created_by: userId,
      expires_at: expiresAt,
      max_uses: 1,
      uses: 0,
    });

    if (error) { set({ saving: false, error: translateError(error, "Impossible de créer le code") }); return null; }
    await get().fetchCodes(businessId);
    set({ saving: false });
    return code;
  },

  revokeCode: async (codeId) => {
    set({ saving: true, error: null });
    const { error } = await supabase.from('invite_codes').delete().eq('id', codeId);
    if (error) { set({ saving: false, error: translateError(error, "Impossible de révoquer le code") }); return false; }
    set(state => ({ codes: state.codes.filter(c => c.id !== codeId), saving: false }));
    return true;
  },

  removeMembre: async (membreId) => {
    set({ saving: true, error: null });
    const { error } = await supabase.from('memberships').delete().eq('id', membreId);
    if (error) { set({ saving: false, error: translateError(error, "Impossible de retirer ce membre") }); return false; }
    set(state => ({ membres: state.membres.filter(m => m.id !== membreId), saving: false }));
    return true;
  },

  changeRole: async (membreId, newRole) => {
    set({ saving: true, error: null });
    const businessId = get().membres.find(m => m.id === membreId)?.business_id ?? '';
    const { error } = await supabase.from('memberships').update({ role: newRole }).eq('id', membreId);
    if (error) { set({ saving: false, error: translateError(error, "Impossible de modifier le rôle") }); return false; }
    // Re-fetch from DB to confirm the write landed (not an optimistic update)
    if (businessId) await get().fetchMembres(businessId);
    else set({ saving: false });
    return true;
  },

  clearError: () => set({ error: null }),
  reset: () => set({ membres: [], codes: [], loading: false, saving: false, error: null }),
}));
