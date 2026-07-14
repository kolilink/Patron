import { create } from 'zustand';
import { supabase } from '@/lib/supabase';
import { translateError } from '@/lib/errors';
import { isNetworkError } from '@/lib/sync';
import { getKV, setKV } from '@/lib/db';
import { notifyEvent } from '@/src/utils/notifications';
import { uploadMessageImage } from '@/lib/chatImages';
import { generateId } from '@/lib/id';
import type { SupportConversation, SupportMessage, SupportAiDraft } from '@/src/types';

const PENDING_KEY = 'support_pending_messages';

interface PendingSupportMessage {
  localId: string;
  businessId: string;
  senderName: string;
  content: string;
  createdAt: string;
}

async function getPendingQueue(): Promise<PendingSupportMessage[]> {
  const raw = await getKV(PENDING_KEY);
  if (!raw) return [];
  try {
    return JSON.parse(raw) as PendingSupportMessage[];
  } catch {
    return [];
  }
}

async function setPendingQueue(items: PendingSupportMessage[]): Promise<void> {
  await setKV(PENDING_KEY, JSON.stringify(items));
}

interface SupportChatStore {
  // ─── Merchant slice ──────────────────────────────────────────────────────
  conversation: SupportConversation | null;
  messages: SupportMessage[];
  loading: boolean;
  sending: boolean;
  error: string | null;
  offline: boolean;

  load: (businessId: string) => Promise<void>;
  sendMessage: (params: { businessId: string; senderName: string; content: string }) => Promise<void>;
  sendImageMessage: (params: {
    businessId: string;
    senderName: string;
    fileUri: string;
    sourceWidth?: number;
    sourceHeight?: number;
    caption?: string;
  }) => Promise<void>;
  appendMessage: (msg: SupportMessage) => void;
  updateConversation: (conv: SupportConversation) => void;
  submitRating: (conversationId: string, rating: number) => Promise<void>;
  drainSupportQueue: () => Promise<void>;

  // ─── Founder slice ───────────────────────────────────────────────────────
  founderConversations: SupportConversation[];
  founderLoading: boolean;
  founderError: string | null;
  founderUnreadTotal: number;

  activeFounderConversation: SupportConversation | null;
  founderMessages: SupportMessage[];
  founderDraft: SupportAiDraft | null;
  founderDetailLoading: boolean;

  loadFounderConversations: () => Promise<void>;
  loadConversationDetail: (conversationId: string) => Promise<void>;
  sendFounderReply: (params: { conversationId: string; content: string; usedAiDraft: boolean }) => Promise<void>;
  sendFounderImageReply: (params: {
    conversationId: string;
    fileUri: string;
    sourceWidth?: number;
    sourceHeight?: number;
    caption?: string;
  }) => Promise<void>;
  requestAiDraft: (conversationId: string) => Promise<void>;
  closeConversation: (conversationId: string) => Promise<void>;

  reset: () => void;
}

function dedupeAppend(messages: SupportMessage[], msg: SupportMessage): SupportMessage[] {
  if (messages.some(m => m.id === msg.id)) return messages;
  const filtered = messages.filter(m => !(
    m.id.startsWith('optimistic-') &&
    m.conversation_id === msg.conversation_id &&
    m.sender_id === msg.sender_id &&
    m.content === msg.content &&
    Math.abs(new Date(m.created_at).getTime() - new Date(msg.created_at).getTime()) < 10_000
  ));
  return [...filtered, msg].sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
}

const initialState = {
  conversation: null as SupportConversation | null,
  messages: [] as SupportMessage[],
  loading: false,
  sending: false,
  error: null as string | null,
  offline: false,

  founderConversations: [] as SupportConversation[],
  founderLoading: false,
  founderError: null as string | null,
  founderUnreadTotal: 0,

  activeFounderConversation: null as SupportConversation | null,
  founderMessages: [] as SupportMessage[],
  founderDraft: null as SupportAiDraft | null,
  founderDetailLoading: false,
};

export const useSupportChatStore = create<SupportChatStore>((set, get) => ({
  ...initialState,

  load: async (businessId) => {
    set({ loading: get().messages.length === 0, error: null });
    try {
      const { data: conv, error: convErr } = await supabase
        .from('support_conversations')
        .select('*')
        .eq('business_id', businessId)
        .order('last_message_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (convErr) throw convErr;

      let messages: SupportMessage[] = [];
      if (conv) {
        const { data: msgs, error: msgsErr } = await supabase
          .from('support_messages')
          .select('*')
          .eq('conversation_id', conv.id)
          .order('created_at', { ascending: true })
          .limit(200);
        if (msgsErr) throw msgsErr;
        messages = msgs ?? [];
      }

      set({ conversation: conv ?? null, messages, loading: false, offline: false });
      void get().drainSupportQueue();
    } catch (err) {
      if (isNetworkError(err)) {
        set({ loading: false, offline: true });
      } else {
        set({ loading: false, error: translateError(err, 'Erreur de chargement') });
      }
    }
  },

  sendMessage: async ({ businessId, senderName, content }) => {
    const trimmed = content.trim();
    if (!trimmed) return;
    set({ sending: true, error: null });

    const localId = `optimistic-${Date.now()}`;
    const optimisticMsg: SupportMessage = {
      id: localId,
      conversation_id: get().conversation?.id ?? 'pending',
      business_id: businessId,
      sender_id: 'me',
      sender_role: 'merchant',
      sender_name: senderName,
      content: trimmed,
      used_ai_draft: false,
      created_at: new Date().toISOString(),
    };
    get().appendMessage(optimisticMsg);

    try {
      const { data, error } = await supabase.rpc('send_support_message', {
        p_business_id: businessId,
        p_content: trimmed,
      });
      if (error) throw error;

      const realMsg = data as SupportMessage;
      set(state => ({
        messages: state.messages.map(m => (m.id === localId ? realMsg : m)),
        conversation: state.conversation && state.conversation.id === realMsg.conversation_id
          ? { ...state.conversation, status: 'open', last_message_at: realMsg.created_at, last_message_preview: trimmed.slice(0, 120) }
          : {
            id: realMsg.conversation_id, business_id: businessId,
            merchant_user_id: realMsg.sender_id, merchant_name: senderName,
            status: 'open', last_message_at: realMsg.created_at, last_message_preview: trimmed.slice(0, 120),
            founder_last_read_at: null, merchant_last_read_at: null, rating: null, rated_at: null,
            created_at: realMsg.created_at, updated_at: realMsg.created_at,
          },
        sending: false,
      }));

      // Generic on purpose — mirrors the founder→merchant support_reply
      // notifications below ("L'équipe de Patron vous a envoyé un message"),
      // never the raw sender name + message preview.
      notifyEvent({
        businessId,
        eventType: 'support_message',
        payload: { preview: 'Un client vous a envoyé un message' },
      });

      // Fire-and-forget — a founder-only draft is ready by the time the
      // inbox is opened. Never awaited, never blocks or fails the send.
      void supabase.functions.invoke('generate-support-draft', {
        body: { conversation_id: realMsg.conversation_id },
      });
    } catch (err) {
      if (isNetworkError(err)) {
        const queue = await getPendingQueue();
        queue.push({ localId, businessId, senderName, content: trimmed, createdAt: optimisticMsg.created_at });
        await setPendingQueue(queue);
        set({ sending: false, offline: true });
      } else {
        set(state => ({
          messages: state.messages.filter(m => m.id !== localId),
          sending: false,
          error: translateError(err, 'Erreur d\'envoi'),
        }));
      }
    }
  },

  // Images are deliberately not offline-queueable, unlike sendMessage above —
  // the lightweight KV queue (support_pending_messages) is sized for short
  // text, and re-uploading a multi-hundred-KB file on reconnect belongs in
  // the real sync_queue if this ever needs it. For now: require connectivity,
  // surface the error, let the user retry manually once back online.
  sendImageMessage: async ({ businessId, senderName, fileUri, sourceWidth, sourceHeight, caption }) => {
    set({ sending: true, error: null });
    const messageId = generateId();
    const trimmedCaption = (caption ?? '').trim();

    try {
      const { url, width, height } = await uploadMessageImage({
        fileUri,
        sourceWidth,
        sourceHeight,
        storagePath: `support/${businessId}/${messageId}.jpg`,
      });

      const { data, error } = await supabase.rpc('send_support_message', {
        p_business_id: businessId,
        p_content: trimmedCaption,
        p_image_url: url,
        p_image_width: width,
        p_image_height: height,
      });
      if (error) throw error;

      const realMsg = data as SupportMessage;
      set(state => ({
        messages: dedupeAppend(state.messages, realMsg),
        conversation: state.conversation && state.conversation.id === realMsg.conversation_id
          ? { ...state.conversation, status: 'open', last_message_at: realMsg.created_at, last_message_preview: '📷 Photo' }
          : {
            id: realMsg.conversation_id, business_id: businessId,
            merchant_user_id: realMsg.sender_id, merchant_name: senderName,
            status: 'open', last_message_at: realMsg.created_at, last_message_preview: '📷 Photo',
            founder_last_read_at: null, merchant_last_read_at: null, rating: null, rated_at: null,
            created_at: realMsg.created_at, updated_at: realMsg.created_at,
          },
        sending: false,
      }));

      notifyEvent({
        businessId,
        eventType: 'support_message',
        payload: { preview: 'Un client vous a envoyé une photo' },
      });

      void supabase.functions.invoke('generate-support-draft', {
        body: { conversation_id: realMsg.conversation_id },
      });
    } catch (err) {
      set({
        sending: false,
        error: isNetworkError(err)
          ? 'Pas de connexion — réessayez l\'envoi de la photo'
          : translateError(err, 'Erreur d\'envoi'),
      });
    }
  },

  appendMessage: (msg) => {
    set(state => ({ messages: dedupeAppend(state.messages, msg) }));
  },

  updateConversation: (conv) => {
    set(state => ({
      conversation: state.conversation && state.conversation.id === conv.id ? { ...state.conversation, ...conv } : state.conversation,
    }));
  },

  submitRating: async (conversationId, rating) => {
    try {
      const { error } = await supabase.rpc('submit_support_rating', {
        p_conversation_id: conversationId,
        p_rating: rating,
      });
      if (error) throw error;
      set(state => ({
        conversation: state.conversation && state.conversation.id === conversationId
          ? { ...state.conversation, rating, rated_at: new Date().toISOString() }
          : state.conversation,
      }));
    } catch (err) {
      set({ error: translateError(err, 'Erreur lors de l\'envoi de la note') });
      throw err;
    }
  },

  drainSupportQueue: async () => {
    const queue = await getPendingQueue();
    if (queue.length === 0) return;
    const remaining: PendingSupportMessage[] = [];
    let sentAny = false;

    for (const item of queue) {
      try {
        const { data, error } = await supabase.rpc('send_support_message', {
          p_business_id: item.businessId,
          p_content: item.content,
        });
        if (error) throw error;
        const realMsg = data as SupportMessage;
        get().appendMessage(realMsg);
        void supabase.functions.invoke('generate-support-draft', {
          body: { conversation_id: realMsg.conversation_id },
        });
        sentAny = true;
      } catch (err) {
        if (isNetworkError(err)) {
          // still offline — keep this and everything after it queued, stop trying
          remaining.push(item, ...queue.slice(queue.indexOf(item) + 1));
          break;
        }
        // Non-network failure — drop this one, it's not recoverable by retrying
      }
    }

    await setPendingQueue(remaining);
    if (sentAny) set({ offline: false });
  },

  // ─── Founder slice ───────────────────────────────────────────────────────

  // Across every business, not just the founder's own — is_founder() grants
  // cross-business RLS read access on support_conversations/businesses
  // specifically so this inbox can surface every merchant's questions in one
  // list (see migration_v126.sql). businesses(name) is a FK embed, not a
  // second round trip per conversation.
  loadFounderConversations: async () => {
    set({ founderLoading: true, founderError: null });
    try {
      const { data: convs, error: convErr } = await supabase
        .from('support_conversations')
        .select('*, businesses(name)')
        .order('last_message_at', { ascending: false })
        .limit(200);
      if (convErr) throw convErr;

      const withNames = (convs ?? []).map(c => {
        const { businesses, ...rest } = c as SupportConversation & { businesses: { name: string } | null };
        return { ...rest, business_name: businesses?.name ?? '—' };
      });
      const unreadTotal = withNames.filter(c =>
        !c.founder_last_read_at || new Date(c.last_message_at) > new Date(c.founder_last_read_at),
      ).length;

      set({ founderConversations: withNames, founderUnreadTotal: unreadTotal, founderLoading: false });
    } catch (err) {
      set({ founderLoading: false, founderError: translateError(err, 'Erreur de chargement') });
    }
  },

  loadConversationDetail: async (conversationId) => {
    set({ founderDetailLoading: true, founderError: null, founderDraft: null });
    try {
      const [{ data: conv, error: convErr }, { data: msgs, error: msgsErr }, { data: draft, error: draftErr }] = await Promise.all([
        supabase.from('support_conversations').select('*').eq('id', conversationId).single(),
        supabase.from('support_messages').select('*').eq('conversation_id', conversationId).order('created_at', { ascending: true }),
        supabase.from('support_ai_drafts').select('*').eq('conversation_id', conversationId).order('created_at', { ascending: false }).limit(1).maybeSingle(),
      ]);
      if (convErr) throw convErr;
      if (msgsErr) throw msgsErr;
      if (draftErr) throw draftErr;

      const cached = get().founderConversations.find(c => c.id === conversationId);
      let businessName = cached?.business_name;
      if (!businessName) {
        const { data: biz } = await supabase.from('businesses').select('name').eq('id', (conv as SupportConversation).business_id).maybeSingle();
        businessName = (biz as { name: string } | null)?.name ?? '—';
      }

      set({
        activeFounderConversation: { ...(conv as SupportConversation), business_name: businessName },
        founderMessages: msgs ?? [],
        founderDraft: (draft as SupportAiDraft) ?? null,
        founderDetailLoading: false,
      });

      await supabase.rpc('mark_support_read', { p_conversation_id: conversationId, p_as_founder: true });
    } catch (err) {
      set({ founderDetailLoading: false, founderError: translateError(err, 'Erreur de chargement') });
    }
  },

  sendFounderReply: async ({ conversationId, content, usedAiDraft }) => {
    const trimmed = content.trim();
    if (!trimmed) return;
    try {
      const { data, error } = await supabase.rpc('send_founder_support_reply', {
        p_conversation_id: conversationId,
        p_content: trimmed,
        p_used_ai_draft: usedAiDraft,
      });
      if (error) throw error;

      const realMsg = data as SupportMessage;
      set(state => ({
        founderMessages: dedupeAppend(state.founderMessages, realMsg),
        founderDraft: null,
      }));

      // Targets the sender specifically — this thread is private to them, not
      // broadcast to the rest of their team (see migration_v127.sql).
      const conv = get().founderConversations.find(c => c.id === conversationId) ?? get().activeFounderConversation;
      if (conv?.merchant_user_id) {
        // The notification never echoes the actual reply content — just a
        // fixed "the team sent you a message" phrase — same generic template
        // the image-reply path below uses for photos.
        notifyEvent({
          businessId: conv.business_id,
          eventType: 'support_reply',
          payload: { preview: "L'équipe de Patron vous a envoyé un message" },
          targetUserIds: [conv.merchant_user_id],
        });
      }
    } catch (err) {
      set({ founderError: translateError(err, 'Erreur d\'envoi') });
      throw err;
    }
  },

  sendFounderImageReply: async ({ conversationId, fileUri, sourceWidth, sourceHeight, caption }) => {
    const trimmedCaption = (caption ?? '').trim();
    const messageId = generateId();
    try {
      const { url, width, height } = await uploadMessageImage({
        fileUri,
        sourceWidth,
        sourceHeight,
        storagePath: `support/${conversationId}/${messageId}.jpg`,
      });

      const { data, error } = await supabase.rpc('send_founder_support_reply', {
        p_conversation_id: conversationId,
        p_content: trimmedCaption,
        p_used_ai_draft: false,
        p_image_url: url,
        p_image_width: width,
        p_image_height: height,
      });
      if (error) throw error;

      const realMsg = data as SupportMessage;
      set(state => ({
        founderMessages: dedupeAppend(state.founderMessages, realMsg),
        founderDraft: null,
      }));

      const conv = get().founderConversations.find(c => c.id === conversationId) ?? get().activeFounderConversation;
      if (conv?.merchant_user_id) {
        notifyEvent({
          businessId: conv.business_id,
          eventType: 'support_reply',
          payload: { preview: "L'équipe de Patron vous a envoyé une photo" },
          targetUserIds: [conv.merchant_user_id],
        });
      }
    } catch (err) {
      set({ founderError: translateError(err, 'Erreur d\'envoi') });
      throw err;
    }
  },

  requestAiDraft: async (conversationId) => {
    set({ founderDraft: { id: 'pending', conversation_id: conversationId, based_on_message_id: null, draft_content: null, status: 'pending', error_note: null, model: null, created_at: new Date().toISOString(), updated_at: new Date().toISOString() } });
    try {
      await supabase.functions.invoke('generate-support-draft', { body: { conversation_id: conversationId } });
    } catch {
      // Fall through — even on a non-2xx response the function may have
      // persisted a 'failed' draft row worth showing, so still re-fetch below.
    }
    try {
      const { data: draft } = await supabase
        .from('support_ai_drafts')
        .select('*')
        .eq('conversation_id', conversationId)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      set({ founderDraft: (draft as SupportAiDraft) ?? null });
    } catch {
      set({ founderDraft: null });
    }
  },

  closeConversation: async (conversationId) => {
    try {
      const { error } = await supabase.rpc('close_support_conversation', { p_conversation_id: conversationId });
      if (error) throw error;
      set(state => ({
        founderConversations: state.founderConversations.filter(c => c.id !== conversationId),
        activeFounderConversation: state.activeFounderConversation && state.activeFounderConversation.id === conversationId
          ? { ...state.activeFounderConversation, status: 'closed' }
          : state.activeFounderConversation,
      }));
    } catch (err) {
      set({ founderError: translateError(err, 'Erreur') });
      throw err;
    }
  },

  reset: () => set(initialState),
}));
