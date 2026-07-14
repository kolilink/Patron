import { create } from 'zustand';
import { supabase } from '@/lib/supabase';
import { generateId, generateFallbackName } from '@/lib/id';
import { translateError } from '@/lib/errors';
import { notifyEvent } from '@/src/utils/notifications';
import { saveEquipeCache, getEquipeCache, getCacheTimestamp } from '@/lib/db';
import { isNetworkError } from '@/lib/sync';
import type { Role, MemberProductStake } from '@/src/types';

const ROLE_LABELS: Record<string, string> = {
  administrateur: 'Administrateur',
  manager: 'Gérant',
  vendeur: 'Vendeur',
  investisseur: 'Investisseur',
};

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
  display_name: string | null;
  scope_all_products: boolean;
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
  hasFetched: boolean;
  offline: boolean;
  offlineSince: number | null;

  fetchMembres: (businessId: string) => Promise<void>;
  fetchCodes: (businessId: string) => Promise<void>;
  createCode: (businessId: string, userId: string, role: Role, expiresInHours?: number, scopeAllProducts?: boolean, scopeProductIds?: string[]) => Promise<string | null>;
  revokeCode: (codeId: string) => Promise<boolean>;
  removeMembre: (membreId: string) => Promise<boolean>;
  changeRole: (membreId: string, newRole: Role) => Promise<boolean>;
  updateDisplayName: (membershipId: string, name: string | null) => Promise<boolean>;
  updateScopeAll: (membershipId: string, scopeAll: boolean) => Promise<boolean>;
  fetchMemberScope: (membershipId: string) => Promise<MemberProductStake[]>;
  setMemberScope: (membershipId: string, stakes: { productId: string; contribution: number; profitShare: number }[]) => Promise<boolean>;
  removeScopeProduct: (membershipId: string, productId: string) => Promise<boolean>;
  clearError: () => void;
  reset: () => void;
}

export const useEquipeStore = create<EquipeStore>((set, get) => ({
  membres: [],
  codes: [],
  loading: false,
  saving: false,
  error: null,
  hasFetched: false,
  offline: false,
  offlineSince: null,

  fetchMembres: async (businessId) => {
    set({ loading: true });

    const { data: mData, error: mErr } = await supabase
      .from('memberships')
      .select('id, user_id, business_id, role, joined_at, display_name, scope_all_products')
      .eq('business_id', businessId)
      .order('joined_at');

    if (mErr) {
      if (isNetworkError(mErr)) {
        const cached = await getEquipeCache(businessId);
        if (cached) {
          const ts = await getCacheTimestamp('equipe_cache', businessId);
          set({ membres: cached as Membre[], loading: false, hasFetched: true, offline: true, offlineSince: ts });
          return;
        }
        set({ loading: false, hasFetched: true, offline: true, offlineSince: null });
        return;
      }
      console.error('[fetchMembres memberships]', mErr instanceof Error ? mErr.message : (mErr as { message?: string })?.message ?? JSON.stringify(mErr));
      set({ loading: false, error: translateError(mErr, 'Erreur de chargement'), hasFetched: true });
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
        profilesMap[p.id] = { name: p.name || null, email: p.email ?? '—', phone: p.phone ?? null };
      }
    }

    const membres: Membre[] = rows.map(m => ({
      id: m.id as string,
      user_id: m.user_id as string,
      business_id: m.business_id as string,
      role: m.role as Role,
      joined_at: m.joined_at as string,
      user_name: profilesMap[m.user_id as string]?.name ?? generateFallbackName(m.user_id as string),
      user_email: profilesMap[m.user_id as string]?.email ?? '—',
      user_phone: profilesMap[m.user_id as string]?.phone ?? null,
      display_name: (m.display_name as string | null) ?? null,
      scope_all_products: (m.scope_all_products as boolean) ?? true,
    }));
    void saveEquipeCache(businessId, membres);
    set({
      membres,
      loading: false,
      hasFetched: true,
      offline: false,
      offlineSince: null,
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

  createCode: async (businessId, userId, role, expiresInHours = 24, scopeAllProducts = true, scopeProductIds = []) => {
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
      scope_all_products: scopeAllProducts,
      scope_product_ids: !scopeAllProducts && scopeProductIds.length > 0 ? scopeProductIds : null,
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
    // Notify BEFORE deleting — after deletion the membership row is gone and dispatch can't validate
    const _membre = get().membres.find(m => m.id === membreId);
    if (_membre) {
      notifyEvent({
        businessId: _membre.business_id,
        eventType: 'member_removed',
        payload: { business: '' }, // dispatch-notification auto-injects business name from business_id
        targetUserIds: [_membre.user_id],
      });
    }
    const { error } = await supabase.from('memberships').delete().eq('id', membreId);
    if (error) { set({ saving: false, error: translateError(error, "Impossible de retirer ce membre") }); return false; }
    set(state => ({ membres: state.membres.filter(m => m.id !== membreId), saving: false }));
    return true;
  },

  updateDisplayName: async (membershipId, name) => {
    set({ saving: true, error: null });
    const { error } = await supabase
      .from('memberships')
      .update({ display_name: name || null })
      .eq('id', membershipId);
    if (error) { set({ saving: false, error: translateError(error, 'Impossible de modifier le nom') }); return false; }
    set(state => ({
      membres: state.membres.map(m => m.id === membershipId ? { ...m, display_name: name || null } : m),
      saving: false,
    }));
    return true;
  },

  updateScopeAll: async (membershipId, scopeAll) => {
    set({ saving: true, error: null });
    const { error } = await supabase
      .from('memberships')
      .update({ scope_all_products: scopeAll })
      .eq('id', membershipId);
    if (error) { set({ saving: false, error: translateError(error, 'Impossible de modifier l\'accès') }); return false; }
    set(state => ({
      membres: state.membres.map(m => m.id === membershipId ? { ...m, scope_all_products: scopeAll } : m),
      saving: false,
    }));
    return true;
  },

  changeRole: async (membreId, newRole) => {
    set({ saving: true, error: null });
    const _membre = get().membres.find(m => m.id === membreId);
    const businessId = _membre?.business_id ?? '';
    const { error } = await supabase.from('memberships').update({ role: newRole }).eq('id', membreId);
    if (error) { set({ saving: false, error: translateError(error, "Impossible de modifier le rôle") }); return false; }
    // Notify the affected member of their new role (before fetchMembres updates state)
    if (_membre?.user_id) {
      notifyEvent({
        businessId,
        eventType: 'role_changed',
        payload: { role: ROLE_LABELS[newRole] ?? newRole },
        targetUserIds: [_membre.user_id],
      });
    }
    // Re-fetch from DB to confirm the write landed (not an optimistic update)
    if (businessId) await get().fetchMembres(businessId);
    else set({ saving: false });
    return true;
  },

  fetchMemberScope: async (membershipId) => {
    const { data, error } = await supabase
      .from('membership_product_scope')
      .select('id, membership_id, product_id, contribution, profit_share, products(name)')
      .eq('membership_id', membershipId);
    if (error || !data) return [];
    return (data as any[]).map(row => ({
      id: row.id as string,
      membership_id: row.membership_id as string,
      product_id: row.product_id as string,
      product_name: (row.products as any)?.name ?? '—',
      contribution: (row.contribution as number) / 100,
      profit_share: row.profit_share as number,
    }));
  },

  setMemberScope: async (membershipId, stakes) => {
    set({ saving: true, error: null });
    const { error: delErr } = await supabase
      .from('membership_product_scope')
      .delete()
      .eq('membership_id', membershipId);
    if (delErr) { set({ saving: false, error: translateError(delErr, 'Erreur de mise à jour') }); return false; }
    if (stakes.length > 0) {
      const rows = stakes.map(s => ({
        membership_id: membershipId,
        product_id: s.productId,
        contribution: Math.round(s.contribution * 100),
        profit_share: s.profitShare,
      }));
      const { error: insErr } = await supabase.from('membership_product_scope').insert(rows);
      if (insErr) { set({ saving: false, error: translateError(insErr, 'Erreur de mise à jour') }); return false; }
    }
    set({ saving: false });
    return true;
  },

  removeScopeProduct: async (membershipId, productId) => {
    set({ saving: true, error: null });
    const { error } = await supabase
      .from('membership_product_scope')
      .delete()
      .eq('membership_id', membershipId)
      .eq('product_id', productId);
    if (error) { set({ saving: false, error: translateError(error, 'Erreur de suppression') }); return false; }
    set({ saving: false });
    return true;
  },

  clearError: () => set({ error: null }),
  reset: () => set({ membres: [], codes: [], loading: false, saving: false, error: null, hasFetched: false, offline: false, offlineSince: null }),
}));
