import { create } from 'zustand';
import { supabase } from '@/lib/supabase';
import { translateError } from '@/lib/errors';
import { isNetworkError } from '@/lib/sync';
import { getKV, setKV, saveChatCache, getChatCache } from '@/lib/db';
import type { ChatRoom, ChatMessage } from '@/src/types';

const GLOBAL_ROOM_ID = '00000000-0000-0000-0000-000000000001';

function boutiqueKey(businessId: string) { return `chat_last_read_boutique_${businessId}`; }
const MARCHE_KEY = 'chat_last_read_marche';

function countUnread(messages: ChatMessage[], roomId: string, since: Date, currentUserId: string): number {
  return messages.filter(
    m => m.room_id === roomId && m.sender_id !== currentUserId && new Date(m.created_at) > since,
  ).length;
}

interface ChatStore {
  boutiqueRoom: ChatRoom | null;
  globalRoom: ChatRoom | null;
  messages: ChatMessage[];
  loading: boolean;
  sending: boolean;
  error: string | null;
  boutiqueUnread: number;
  marcheUnread: number;
  // Internal — cached for synchronous unread computation in appendMessage
  _currentUserId: string;
  _boutiqueLastRead: Date;
  _marcheLastRead: Date;
  load: (businessId: string, currentUserId: string) => Promise<void>;
  sendMessage: (params: { roomId: string; senderId: string; senderName: string; content: string }) => Promise<void>;
  appendMessage: (msg: ChatMessage) => void;
  markRead: (which: 'boutique' | 'marche', businessId: string) => Promise<void>;
  reset: () => void;
}

const initialState = {
  boutiqueRoom: null,
  globalRoom: null,
  messages: [],
  loading: false,
  sending: false,
  error: null,
  boutiqueUnread: 0,
  marcheUnread: 0,
  _currentUserId: '',
  _boutiqueLastRead: new Date(0),
  _marcheLastRead: new Date(0),
};

export const useChatStore = create<ChatStore>((set, get) => ({
  ...initialState,

  load: async (businessId, currentUserId) => {
    set({ loading: true, error: null });
    try {
      // 1. Fetch both accessible rooms (boutique + global)
      const { data: rooms, error: roomsErr } = await supabase
        .from('chat_rooms')
        .select('*')
        .or(`business_id.eq.${businessId},is_global.eq.true`);
      if (roomsErr) throw roomsErr;

      const boutiqueRoom = (rooms ?? []).find(r => !r.is_global && r.business_id === businessId) ?? null;
      const globalRoom   = (rooms ?? []).find(r => r.is_global) ?? null;

      // 2. Fetch last-read timestamps from KV store
      const [bTs, mTs] = await Promise.all([
        getKV(boutiqueKey(businessId)),
        getKV(MARCHE_KEY),
      ]);
      const boutiqueLastRead = bTs ? new Date(bTs) : new Date(0);
      const marcheLastRead   = mTs ? new Date(mTs) : new Date(0);

      // 3. Fetch recent messages for both rooms
      const roomIds = [boutiqueRoom?.id, globalRoom?.id].filter(Boolean) as string[];
      let messages: ChatMessage[] = [];
      if (roomIds.length > 0) {
        const { data: msgs, error: msgsErr } = await supabase
          .from('chat_messages')
          .select('*')
          .in('room_id', roomIds)
          .order('created_at', { ascending: true })
          .limit(200);
        if (msgsErr) throw msgsErr;
        messages = msgs ?? [];
      }

      // 4. Compute unread counts
      const boutiqueUnread = boutiqueRoom
        ? countUnread(messages, boutiqueRoom.id, boutiqueLastRead, currentUserId)
        : 0;
      const marcheUnread = globalRoom
        ? countUnread(messages, globalRoom.id, marcheLastRead, currentUserId)
        : 0;

      const snapshot = { boutiqueRoom, globalRoom, messages };
      void saveChatCache(businessId, snapshot);

      set({
        boutiqueRoom,
        globalRoom,
        messages,
        boutiqueUnread,
        marcheUnread,
        _currentUserId: currentUserId,
        _boutiqueLastRead: boutiqueLastRead,
        _marcheLastRead: marcheLastRead,
        loading: false,
      });
    } catch (err) {
      if (isNetworkError(err)) {
        const cached = await getChatCache(businessId) as {
          boutiqueRoom: ChatRoom | null;
          globalRoom: ChatRoom | null;
          messages: ChatMessage[];
        } | null;
        if (cached) {
          const [bTs, mTs] = await Promise.all([
            getKV(boutiqueKey(businessId)),
            getKV(MARCHE_KEY),
          ]);
          const boutiqueLastRead = bTs ? new Date(bTs) : new Date(0);
          const marcheLastRead   = mTs ? new Date(mTs) : new Date(0);
          const boutiqueUnread = cached.boutiqueRoom
            ? countUnread(cached.messages, cached.boutiqueRoom.id, boutiqueLastRead, currentUserId)
            : 0;
          const marcheUnread = cached.globalRoom
            ? countUnread(cached.messages, cached.globalRoom.id, marcheLastRead, currentUserId)
            : 0;
          set({
            boutiqueRoom: cached.boutiqueRoom,
            globalRoom: cached.globalRoom,
            messages: cached.messages,
            boutiqueUnread,
            marcheUnread,
            _currentUserId: currentUserId,
            _boutiqueLastRead: boutiqueLastRead,
            _marcheLastRead: marcheLastRead,
            loading: false,
          });
          return;
        }
        set({ loading: false });
      } else {
        set({ loading: false, error: translateError(err, 'Erreur de chargement') });
      }
    }
  },

  sendMessage: async ({ roomId, senderId, senderName, content }) => {
    set({ sending: true, error: null });
    const optimisticMsg: ChatMessage = {
      id: `optimistic-${Date.now()}`,
      room_id: roomId,
      sender_id: senderId,
      sender_name: senderName,
      content,
      created_at: new Date().toISOString(),
    };
    // Optimistic append
    get().appendMessage(optimisticMsg);
    try {
      const { data, error } = await supabase
        .from('chat_messages')
        .insert({ room_id: roomId, sender_id: senderId, sender_name: senderName, content })
        .select()
        .single();
      if (error) throw error;
      // Replace optimistic message with real one
      set(state => ({
        messages: state.messages.map(m => m.id === optimisticMsg.id ? (data as ChatMessage) : m),
        sending: false,
      }));
    } catch (err) {
      // Remove optimistic message on failure
      set(state => ({
        messages: state.messages.filter(m => m.id !== optimisticMsg.id),
        sending: false,
        error: isNetworkError(err)
          ? 'Pas de connexion — message non envoyé'
          : translateError(err, 'Erreur d\'envoi'),
      }));
    }
  },

  appendMessage: (msg) => {
    set(state => {
      // Deduplicate: skip if a real message with same id already exists
      if (state.messages.some(m => m.id === msg.id)) return state;
      // Remove optimistic duplicate (same room+sender+content within 10s)
      const filtered = state.messages.filter(m => !(
        m.id.startsWith('optimistic-') &&
        m.room_id === msg.room_id &&
        m.sender_id === msg.sender_id &&
        m.content === msg.content &&
        Math.abs(new Date(m.created_at).getTime() - new Date(msg.created_at).getTime()) < 10_000
      ));
      const newMessages = [...filtered, msg].sort((a, b) =>
        new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
      );

      // Recompute unread counts synchronously
      const { boutiqueRoom, globalRoom, _currentUserId, _boutiqueLastRead, _marcheLastRead } = state;
      const boutiqueUnread = boutiqueRoom
        ? countUnread(newMessages, boutiqueRoom.id, _boutiqueLastRead, _currentUserId)
        : state.boutiqueUnread;
      const marcheUnread = globalRoom
        ? countUnread(newMessages, globalRoom.id, _marcheLastRead, _currentUserId)
        : state.marcheUnread;

      return { messages: newMessages, boutiqueUnread, marcheUnread };
    });
  },

  markRead: async (which, businessId) => {
    const now = new Date();
    if (which === 'boutique') {
      await setKV(boutiqueKey(businessId), now.toISOString());
      set({ boutiqueUnread: 0, _boutiqueLastRead: now });
    } else {
      await setKV(MARCHE_KEY, now.toISOString());
      set({ marcheUnread: 0, _marcheLastRead: now });
    }
  },

  reset: () => set(initialState),
}));
