import { create } from 'zustand';
import { supabase } from '@/lib/supabase';
import type { Role } from '@/src/types';

function generateId(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

function generateCode(): string {
  return Math.random().toString(36).slice(2, 8).toUpperCase();
}

export interface Membre {
  id: string;
  user_id: string;
  business_id: string;
  role: Role;
  joined_at: string;
  user_name: string;
  user_email: string;
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

  fetchMembres: (businessId: string) => Promise<void>;
  fetchCodes: (businessId: string) => Promise<void>;
  createCode: (businessId: string, userId: string, role: Role, expiresInDays?: number) => Promise<string | null>;
  revokeCode: (codeId: string) => Promise<void>;
  removeMembre: (membreId: string) => Promise<void>;
  changeRole: (membreId: string, newRole: Role) => Promise<void>;
}

export const useEquipeStore = create<EquipeStore>((set, get) => ({
  membres: [],
  codes: [],
  loading: false,
  saving: false,

  fetchMembres: async (businessId) => {
    set({ loading: true });
    const { data } = await supabase
      .from('memberships')
      .select('*, user:profiles(name, email)')
      .eq('business_id', businessId)
      .order('joined_at');

    set({
      membres: (data ?? []).map((m: Record<string, unknown>) => ({
        id: m.id as string,
        user_id: m.user_id as string,
        business_id: m.business_id as string,
        role: m.role as Role,
        joined_at: m.joined_at as string,
        user_name: (m.user as { name: string; email: string } | null)?.name ?? '—',
        user_email: (m.user as { name: string; email: string } | null)?.email ?? '—',
      })),
      loading: false,
    });
  },

  fetchCodes: async (businessId) => {
    const { data } = await supabase
      .from('invite_codes')
      .select('*')
      .eq('business_id', businessId)
      .order('created_at', { ascending: false });

    set({ codes: (data ?? []) as CodeInvitation[] });
  },

  createCode: async (businessId, userId, role, expiresInDays = 7) => {
    set({ saving: true });
    const code = generateCode();
    const expiresAt = new Date(Date.now() + expiresInDays * 86400000).toISOString();

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

    if (error) { set({ saving: false }); return null; }
    await get().fetchCodes(businessId);
    set({ saving: false });
    return code;
  },

  revokeCode: async (codeId) => {
    await supabase.from('invite_codes').delete().eq('id', codeId);
    set(state => ({ codes: state.codes.filter(c => c.id !== codeId) }));
  },

  removeMembre: async (membreId) => {
    await supabase.from('memberships').delete().eq('id', membreId);
    set(state => ({ membres: state.membres.filter(m => m.id !== membreId) }));
  },

  changeRole: async (membreId, newRole) => {
    await supabase.from('memberships').update({ role: newRole }).eq('id', membreId);
    set(state => ({
      membres: state.membres.map(m => m.id === membreId ? { ...m, role: newRole } : m),
    }));
  },
}));
