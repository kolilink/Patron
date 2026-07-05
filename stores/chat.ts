import { create } from 'zustand';
import * as FileSystem from 'expo-file-system/legacy';
import { supabase } from '@/lib/supabase';
import { translateError } from '@/lib/errors';
import { isNetworkError } from '@/lib/sync';
import { getKV, setKV, saveChatCache, getChatCache, getCacheTimestamp } from '@/lib/db';
import { notifyEvent } from '@/src/utils/notifications';
import { generateId } from '@/lib/id';
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
  offline: boolean;
  offlineSince: number | null;
  // Internal — cached for synchronous unread computation in appendMessage
  _currentUserId: string;
  _boutiqueLastRead: Date;
  _marcheLastRead: Date;
  // Voice message playback: only one plays at a time across the whole chat
  currentlyPlayingVoiceId: string | null;
  setCurrentlyPlayingVoice: (id: string | null) => void;

  load: (businessId: string, currentUserId: string) => Promise<void>;
  sendMessage: (params: { roomId: string; senderId: string; senderName: string; content: string; replyTo?: { id: string; content: string; senderName: string } | null }) => Promise<void>;
  sendVoiceMessage: (params: {
    roomId: string;
    senderId: string;
    senderName: string;
    businessId: string;
    fileUri: string;          // local file:// URI from expo-av
    duration: number;         // seconds
    waveform: number[];       // amplitude samples 0.0–1.0
  }) => Promise<void>;
  editMessage: (messageId: string, newContent: string) => Promise<void>;
  appendMessage: (msg: ChatMessage) => void;
  updateMessage: (msg: ChatMessage) => void;
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
  offline: false,
  offlineSince: null as number | null,
  _currentUserId: '',
  _boutiqueLastRead: new Date(0),
  _marcheLastRead: new Date(0),
  currentlyPlayingVoiceId: null as string | null,
};

export const useChatStore = create<ChatStore>((set, get) => ({
  ...initialState,

  setCurrentlyPlayingVoice: (id) => set({ currentlyPlayingVoiceId: id }),

  load: async (businessId, currentUserId) => {
    if (get().messages.length === 0) {
      const cached = await getChatCache(businessId) as {
        boutiqueRoom: ChatRoom | null;
        globalRoom: ChatRoom | null;
        messages: ChatMessage[];
      } | null;
      if (cached) {
        const [bTs, mTs] = await Promise.all([getKV(boutiqueKey(businessId)), getKV(MARCHE_KEY)]);
        const boutiqueLastRead = bTs ? new Date(bTs) : new Date(0);
        const marcheLastRead   = mTs ? new Date(mTs) : new Date(0);
        set({
          boutiqueRoom: cached.boutiqueRoom,
          globalRoom: cached.globalRoom,
          messages: cached.messages,
          boutiqueUnread: cached.boutiqueRoom ? countUnread(cached.messages, cached.boutiqueRoom.id, boutiqueLastRead, currentUserId) : 0,
          marcheUnread: cached.globalRoom ? countUnread(cached.messages, cached.globalRoom.id, marcheLastRead, currentUserId) : 0,
          _currentUserId: currentUserId,
          _boutiqueLastRead: boutiqueLastRead,
          _marcheLastRead: marcheLastRead,
          loading: false,
        });
      } else {
        set({ loading: true, error: null, offline: false, offlineSince: null });
      }
    } else {
      set({ error: null });
    }
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

        // Resolve current profile names so old messages reflect name changes
        const senderIds = [...new Set(messages.map(m => m.sender_id))];
        if (senderIds.length > 0) {
          const { data: profiles } = await supabase
            .from('profiles')
            .select('id, name')
            .in('id', senderIds);
          if (profiles && profiles.length > 0) {
            const nameMap: Record<string, string | null> = Object.fromEntries(
              profiles.map(p => [p.id, (p.name as string | null) ?? null]),
            );
            messages = messages.map(m => ({
              ...m,
              sender_name: nameMap[m.sender_id] ?? m.sender_name,
            }));
          }
        }
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
        offline: false,
        offlineSince: null,
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
          const ts = await getCacheTimestamp('chat_cache', businessId);
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
            offline: true,
            offlineSince: ts,
          });
          return;
        }
        set({ loading: false, offline: true, offlineSince: null });
      } else {
        set({ loading: false, error: translateError(err, 'Erreur de chargement') });
      }
    }
  },

  sendMessage: async ({ roomId, senderId, senderName, content, replyTo }) => {
    set({ sending: true, error: null });
    const optimisticMsg: ChatMessage = {
      id: `optimistic-${Date.now()}`,
      room_id: roomId,
      sender_id: senderId,
      sender_name: senderName,
      content,
      created_at: new Date().toISOString(),
      reply_to_id: replyTo?.id ?? null,
      reply_to_content: replyTo?.content ?? null,
      reply_to_sender_name: replyTo?.senderName ?? null,
    };
    // Optimistic append
    get().appendMessage(optimisticMsg);
    try {
      const insertRow = {
        room_id: roomId, sender_id: senderId, sender_name: senderName, content,
        ...(replyTo ? {
          reply_to_id: replyTo.id,
          reply_to_content: replyTo.content,
          reply_to_sender_name: replyTo.senderName,
        } : {}),
      };
      const { data, error } = await supabase
        .from('chat_messages')
        .insert(insertRow)
        .select()
        .single();
      if (error) throw error;
      // Replace optimistic message with real one
      set(state => ({
        messages: state.messages.map(m => m.id === optimisticMsg.id ? (data as ChatMessage) : m),
        sending: false,
      }));
      // Push notification for boutique (private) chat only — Le Marché is intentionally excluded
      const boutiqueRoom = get().boutiqueRoom;
      if (boutiqueRoom && roomId === boutiqueRoom.id && boutiqueRoom.business_id) {
        notifyEvent({
          businessId: boutiqueRoom.business_id,
          eventType: 'chat_message',
          payload: {
            sender: senderName,
            preview: content.slice(0, 60) + (content.length > 60 ? '…' : ''),
          },
          targetRoles: ['administrateur', 'manager', 'vendeur', 'investisseur'],
          excludeUserId: senderId,
        });
      }
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

  sendVoiceMessage: async ({ roomId, senderId, senderName, businessId, fileUri, duration, waveform }) => {
    set({ sending: true, error: null });
    const messageId = generateId();
    const storagePath = `${businessId}/${messageId}.m4a`;

    try {
      // Upload audio file to Supabase Storage.
      // fetch().blob() produces 0-byte blobs for file:// URIs in Hermes —
      // read via FileSystem as base64 and decode to Uint8Array instead.
      // Note: must import from 'expo-file-system/legacy' — the main package
      // stubs all legacy methods to throw in expo-file-system v19+.
      const base64 = await FileSystem.readAsStringAsync(fileUri, {
        encoding: FileSystem.EncodingType.Base64,
      });
      const binary = atob(base64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

      const { error: uploadErr } = await supabase.storage
        .from('voice-messages')
        .upload(storagePath, bytes, { contentType: 'audio/mp4', upsert: false });
      if (uploadErr) throw uploadErr;

      // Public bucket — permanent URL, no expiry, no tokens
      const { data: urlData } = supabase.storage
        .from('voice-messages')
        .getPublicUrl(storagePath);
      const voiceUrl = urlData.publicUrl;

      // Insert message row
      const { data, error: insertErr } = await supabase
        .from('chat_messages')
        .insert({
          id: messageId,
          room_id: roomId,
          sender_id: senderId,
          sender_name: senderName,
          content: '',            // empty for voice messages
          message_type: 'voice',
          voice_url: voiceUrl,
          voice_duration: Math.round(duration),
          voice_waveform: waveform,
        })
        .select()
        .single();
      if (insertErr) throw insertErr;

      get().appendMessage(data as ChatMessage);
      set({ sending: false });

      // Notification: "Mamadou · 🎤 0:23" format
      const boutiqueRoom = get().boutiqueRoom;
      if (boutiqueRoom && roomId === boutiqueRoom.id && boutiqueRoom.business_id) {
        const mins = Math.floor(duration / 60);
        const secs = String(Math.round(duration % 60)).padStart(2, '0');
        notifyEvent({
          businessId: boutiqueRoom.business_id,
          eventType: 'chat_message',
          payload: {
            sender: senderName,
            preview: `🎤 ${mins}:${secs}`,
          },
          targetRoles: ['administrateur', 'manager', 'vendeur', 'investisseur'],
          excludeUserId: senderId,
        });
      }
    } catch (err) {
      set({ sending: false, error: translateError(err, 'Impossible d\'envoyer le message vocal') });
    }
  },

  editMessage: async (messageId, newContent) => {
    const prevMessages = get().messages;
    // Optimistic update
    set(state => ({
      messages: state.messages.map(m =>
        m.id === messageId ? { ...m, content: newContent } : m,
      ),
    }));
    try {
      const { error } = await supabase
        .from('chat_messages')
        .update({ content: newContent })
        .eq('id', messageId);
      if (error) throw error;
    } catch (err) {
      // Revert on failure
      set({ messages: prevMessages });
      throw err;
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

  updateMessage: (msg) => {
    set(state => ({
      messages: state.messages.map(m => m.id === msg.id ? { ...m, ...msg } : m),
    }));
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
