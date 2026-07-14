import { create } from 'zustand';
import { supabase } from '@/lib/supabase';
import { translateError } from '@/lib/errors';
import { isNetworkError } from '@/lib/sync';
import type { AlphaConversation, AlphaMessage, AlphaQuotaStatus } from '@/src/types';

function dedupeAppend(messages: AlphaMessage[], msg: AlphaMessage): AlphaMessage[] {
  if (messages.some(m => m.id === msg.id)) return messages;
  const filtered = messages.filter(m => !(
    m.id.startsWith('optimistic-') &&
    m.conversation_id === msg.conversation_id &&
    m.role === msg.role &&
    m.content === msg.content &&
    Math.abs(new Date(m.created_at).getTime() - new Date(msg.created_at).getTime()) < 10_000
  ));
  return [...filtered, msg].sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
}

interface AlphaStore {
  conversation: AlphaConversation | null;
  messages: AlphaMessage[];
  quota: AlphaQuotaStatus | null;
  loading: boolean;
  sending: boolean;
  error: string | null;
  offline: boolean;

  load: (businessId: string) => Promise<void>;
  sendMessage: (params: { businessId: string; content: string }) => Promise<void>;
  appendMessage: (msg: AlphaMessage) => void;
  fetchQuota: (businessId: string) => Promise<void>;
  reset: () => void;
}

const initialState = {
  conversation: null as AlphaConversation | null,
  messages: [] as AlphaMessage[],
  quota: null as AlphaQuotaStatus | null,
  loading: false,
  sending: false,
  error: null as string | null,
  offline: false,
};

export const useAlphaStore = create<AlphaStore>((set, get) => ({
  ...initialState,

  load: async (businessId) => {
    set({ loading: get().messages.length === 0, error: null });
    try {
      const { data: conv, error: convErr } = await supabase.rpc('open_or_get_alpha_conversation', {
        p_business_id: businessId,
      });
      if (convErr) throw convErr;

      const conversation = conv as AlphaConversation;
      const { data: msgs, error: msgsErr } = await supabase
        .from('alpha_messages')
        .select('*')
        .eq('conversation_id', conversation.id)
        .order('created_at', { ascending: true })
        .limit(200);
      if (msgsErr) throw msgsErr;

      set({ conversation, messages: msgs ?? [], loading: false, offline: false });
      void get().fetchQuota(businessId);
    } catch (err) {
      if (isNetworkError(err)) {
        set({ loading: false, offline: true });
      } else {
        set({ loading: false, error: translateError(err, 'Erreur de chargement') });
      }
    }
  },

  sendMessage: async ({ businessId, content }) => {
    const trimmed = content.trim();
    if (!trimmed) return;
    set({ sending: true, error: null });

    const localId = `optimistic-${Date.now()}`;
    const optimisticMsg: AlphaMessage = {
      id: localId,
      conversation_id: get().conversation?.id ?? 'pending',
      role: 'user',
      content: trimmed,
      status: 'ready',
      error_note: null,
      model: null,
      created_at: new Date().toISOString(),
    };
    get().appendMessage(optimisticMsg);

    try {
      const { data, error } = await supabase.rpc('send_alpha_message', {
        p_business_id: businessId,
        p_content: trimmed,
      });
      if (error) throw error;

      const realMsg = data as AlphaMessage;
      set(state => ({
        messages: dedupeAppend(state.messages.filter(m => m.id !== localId), realMsg),
      }));
      void get().fetchQuota(businessId);

      // Awaited, not fire-and-forget — the user is watching this conversation
      // live, unlike generate-support-draft which is invisible until the
      // founder manually opens the inbox.
      try {
        const { data: invokeData } = await supabase.functions.invoke('alpha-chat', {
          body: { conversation_id: realMsg.conversation_id, business_id: businessId },
        });
        const replyMsg = (invokeData as { message?: AlphaMessage } | null)?.message;
        if (replyMsg) get().appendMessage(replyMsg);
        set({ sending: false });
      } catch (invokeErr) {
        // The user's own message already succeeded via the RPC above — only
        // the reply failed to generate. Never roll back the user's message here.
        set({
          sending: false,
          error: isNetworkError(invokeErr)
            ? 'Pas de connexion — réessayez.'
            : translateError(invokeErr, "Alpha n'a pas pu répondre"),
        });
      }
    } catch (err) {
      // Fallback is the raw message itself (not a fixed generic string) — a
      // custom SECURITY DEFINER RAISE EXCEPTION (e.g. the quota message from
      // send_alpha_message) is already French and should pass through
      // untranslated, same precedent as join_business in stores/auth.ts.
      // translateError only overrides it for known Supabase/auth/network
      // patterns.
      const raw = err instanceof Error ? err.message : (err as Record<string, unknown>)?.message as string | undefined;
      set(state => ({
        messages: state.messages.filter(m => m.id !== localId),
        sending: false,
        error: translateError(err, raw ?? "Erreur d'envoi"),
      }));
    }
  },

  appendMessage: (msg) => {
    set(state => ({ messages: dedupeAppend(state.messages, msg) }));
  },

  fetchQuota: async (businessId) => {
    const { data, error } = await supabase.rpc('get_alpha_quota_status', { p_business_id: businessId });
    if (error || !data) return;
    set({ quota: data as AlphaQuotaStatus });
  },

  reset: () => set(initialState),
}));
