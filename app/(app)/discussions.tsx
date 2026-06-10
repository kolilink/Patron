import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  FlatList,
  Keyboard,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router, useFocusEffect } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { Text } from '@/src/components/ui/Text';
import { haptics } from '@/lib/haptics';
import { colors, palette, radius, spacing } from '@/src/theme';
import { useAuthStore } from '@/stores/auth';
import { useChatStore } from '@/stores/chat';
import { useMarketStore } from '@/stores/market';
import { supabase } from '@/lib/supabase';
import { generateFallbackName } from '@/lib/id';
import type { ChatMessage, MarketPost, MarketCategory } from '@/src/types';

// ─── Forum constants ──────────────────────────────────────────────────────────

const MARKET_CATS: MarketCategory[] = ['suggestion', 'entraide', 'general'];

const CAT_LABEL: Record<string, string> = {
  tout: 'Tout',
  suggestion: 'Suggestion',
  entraide: 'Entraide',
  general: 'Général',
  annonce: 'Annonce',
};
const CAT_BG: Record<string, string> = {
  suggestion: colors.primary[100],
  entraide:   colors.success[50],
  general:    '#F3F4F6',
  annonce:    '#FEF3C7',
};
const CAT_FG: Record<string, string> = {
  suggestion: colors.primary[700],
  entraide:   '#166534',
  general:    '#374151',
  annonce:    '#92400E',
};

// ─── Types ────────────────────────────────────────────────────────────────────

type Tab       = 'boutique' | 'marche';
type GroupPos  = 'standalone' | 'first' | 'middle' | 'last';

type SeparatorItem  = { _sep: true; label: string; id: string };
type ChatBubbleItem = ChatMessage & { _pos: GroupPos };
type ListItem = ChatBubbleItem | SeparatorItem;

function isSep(item: ListItem): item is SeparatorItem {
  return '_sep' in item;
}

// ─── Date helpers ─────────────────────────────────────────────────────────────

const LOCALE = Intl.DateTimeFormat().resolvedOptions().locale;

function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear()
    && a.getMonth() === b.getMonth()
    && a.getDate() === b.getDate();
}

// Relative time for forum post cards (device-locale calendar format).
function relativeTime(iso: string): string {
  const d   = new Date(iso);
  const now = new Date();
  const diffMin = Math.floor((now.getTime() - d.getTime()) / 60_000);
  if (diffMin < 1) return "À l'instant";
  if (diffMin < 60) return `Il y a ${diffMin} min`;
  const diffH = Math.floor(diffMin / 60);
  if (diffH < 24) return `Il y a ${diffH} h`;
  const yesterday = new Date(now); yesterday.setDate(now.getDate() - 1);
  if (sameDay(d, now)) return "Aujourd'hui";
  if (sameDay(d, yesterday)) return 'Hier';
  return new Intl.DateTimeFormat(LOCALE, { day: 'numeric', month: 'long' }).format(d);
}

// ─── Message grouping ─────────────────────────────────────────────────────────

const GROUP_GAP_MS = 5  * 60_000; // same group if < 5 min apart
const SEP_GAP_MS   = 15 * 60_000; // show time chip if gap >= 15 min

function sameGroup(a: ChatMessage, b: ChatMessage): boolean {
  return a.sender_id === b.sender_id
    && Math.abs(new Date(a.created_at).getTime() - new Date(b.created_at).getTime()) < GROUP_GAP_MS;
}

function timeSepLabel(iso: string): string {
  const d         = new Date(iso);
  const today     = new Date();
  const yesterday = new Date(today); yesterday.setDate(today.getDate() - 1);
  const time      = d.toLocaleTimeString(LOCALE, { hour: '2-digit', minute: '2-digit' });
  if (sameDay(d, today))     return `Aujourd'hui ${time}`;
  if (sameDay(d, yesterday)) return `Hier ${time}`;
  return `${new Intl.DateTimeFormat(LOCALE, { day: 'numeric', month: 'short' }).format(d)} ${time}`;
}

// msgs is newest-first; FlatList is inverted so index 0 renders at the bottom.
// Visual order: 'first' = topmost (oldest in group), 'last' = bottommost (newest).
function buildGroupedItems(msgs: ChatMessage[]): ListItem[] {
  if (msgs.length === 0) return [];

  const bubbles: ChatBubbleItem[] = msgs.map((msg, i) => {
    const newer    = msgs[i - 1]; // lower index → newer → visually below
    const older    = msgs[i + 1]; // higher index → older → visually above
    const withNewer = newer ? sameGroup(msg, newer) : false;
    const withOlder = older ? sameGroup(msg, older) : false;
    let pos: GroupPos;
    if (!withNewer && !withOlder)  pos = 'standalone';
    else if (!withNewer && withOlder) pos = 'last';   // visually bottom of group
    else if (withNewer && !withOlder) pos = 'first';  // visually top of group
    else                              pos = 'middle';
    return { ...msg, _pos: pos } as ChatBubbleItem;
  });

  const out: ListItem[] = [];
  for (let i = 0; i < bubbles.length; i++) {
    out.push(bubbles[i]);
    const nextMsg = msgs[i + 1];
    if (nextMsg) {
      const gapMs = new Date(msgs[i].created_at).getTime() - new Date(nextMsg.created_at).getTime();
      if (gapMs >= SEP_GAP_MS) {
        out.push({ _sep: true, label: timeSepLabel(nextMsg.created_at), id: `tsep-${nextMsg.id}` });
      }
    }
  }
  return out;
}

// ─── Bubble geometry ──────────────────────────────────────────────────────────

function bubbleMargins(pos: GroupPos): { marginTop: number; marginBottom: number } {
  switch (pos) {
    case 'standalone': return { marginTop: 8, marginBottom: 8 };
    case 'first':      return { marginTop: 8, marginBottom: 2 };
    case 'middle':     return { marginTop: 2, marginBottom: 2 };
    case 'last':       return { marginTop: 2, marginBottom: 8 };
  }
}

function bubbleRadius(isOwn: boolean, pos: GroupPos) {
  if (pos === 'standalone') return { borderRadius: 16 };
  if (isOwn) {
    return {
      borderTopLeftRadius:     16,
      borderBottomLeftRadius:  16,
      borderTopRightRadius:    pos === 'first' ? 16 : 4,
      borderBottomRightRadius: pos === 'last'  ? 16 : 4,
    };
  }
  return {
    borderTopLeftRadius:     pos === 'first' ? 16 : 4,
    borderBottomLeftRadius:  pos === 'last'  ? 16 : 4,
    borderTopRightRadius:    16,
    borderBottomRightRadius: 16,
  };
}

// ─── MessageBubble ────────────────────────────────────────────────────────────

function MessageBubble({
  msg, isOwn, pos, showSender, isRead,
}: {
  msg: ChatMessage;
  isOwn: boolean;
  pos: GroupPos;
  showSender: boolean;
  isRead: boolean | null;
}) {
  const time     = new Date(msg.created_at).toLocaleTimeString(LOCALE, { hour: '2-digit', minute: '2-digit' });
  const br       = bubbleRadius(isOwn, pos);
  const margins  = bubbleMargins(pos);
  // Show timestamp only on the bottom-most bubble of a group (or standalone) — keeps the stream clean
  const showTime = pos === 'standalone' || pos === 'last';

  return (
    <View style={[styles.row, isOwn && styles.rowOwn, margins]}>
      {showSender && (
        <View style={styles.senderRow}>
          <Text variant="caption" style={styles.senderName}>
            {msg.sender_name || generateFallbackName(msg.sender_id)}
          </Text>
        </View>
      )}
      <View style={[styles.bubble, isOwn ? styles.bubbleOwn : styles.bubbleOther, br]}>
        <Text style={[styles.bubbleText, isOwn && styles.bubbleTextOwn]}>{msg.content}</Text>
      </View>
      {showTime && (
        <View style={styles.metaRow}>
          <Text variant="caption" style={[styles.ts, isOwn && styles.tsOwn]}>{time}</Text>
          {isOwn && isRead !== null && (
            <Text variant="caption" style={[styles.receipt, isRead && styles.receiptRead]}>
              {isRead ? '✓✓ Vu' : '✓'}
            </Text>
          )}
        </View>
      )}
    </View>
  );
}

// ─── PostCard ─────────────────────────────────────────────────────────────────

const AVATAR_PALETTE = [
  colors.primary[500],
  '#10B981',
  '#F59E0B',
  '#EC4899',
  '#8B5CF6',
];

function PostCard({ post, isNew, isLiked, isOwnPost, onPress, onLike }: {
  post: MarketPost;
  isNew: boolean;
  isLiked: boolean;
  isOwnPost: boolean;
  onPress: () => void;
  onLike: () => void;
}) {
  const authorName  = post.author_name || generateFallbackName(post.author_id);
  const initial     = authorName.charAt(0).toUpperCase();
  const avatarColor = AVATAR_PALETTE[post.author_id.charCodeAt(0) % AVATAR_PALETTE.length];

  return (
    <Pressable onPress={onPress} style={({ pressed }) => [styles.pcCard, pressed && { opacity: 0.88 }]}>

      {/* Top row: avatar+author (left) | category+timestamp (right) */}
      <View style={styles.pcTopRow}>
        <View style={styles.pcAuthorBlock}>
          <View style={[styles.pcAvatar, { backgroundColor: avatarColor }]}>
            <Text style={styles.pcAvatarText}>{initial}</Text>
          </View>
          <View style={styles.pcAuthorInfo}>
            <Text style={styles.pcAuthorName}>{authorName}</Text>
            <Text style={styles.pcAuthorRank}>Commerçant</Text>
          </View>
        </View>
        <View style={styles.pcMetaBlock}>
          <View style={[styles.catBadge, { backgroundColor: CAT_BG[post.category] ?? '#F3F4F6' }]}>
            <Text style={[styles.catBadgeText, { color: CAT_FG[post.category] ?? '#374151' }]}>
              {CAT_LABEL[post.category] ?? post.category}
            </Text>
          </View>
          <Text style={styles.pcTimestamp}>{relativeTime(post.created_at)}</Text>
        </View>
      </View>

      {/* Title */}
      <Text style={styles.pcTitle} numberOfLines={1}>{post.title}</Text>

      {/* Excerpt */}
      <Text style={styles.pcExcerpt} numberOfLines={2}>{post.content}</Text>

      {/* Footer: like (interactive) + comment count + action button */}
      <View style={styles.pcFooter}>
        {isNew && (
          <View style={styles.newBadge}>
            <Text style={styles.newBadgeText}>Nouveau</Text>
          </View>
        )}

        {/* Like toggle — optimistic update in store; disabled for own posts */}
        <Pressable
          onPress={e => { e.stopPropagation(); if (!isOwnPost) onLike(); }}
          hitSlop={8}
          disabled={isOwnPost}
          style={({ pressed }) => [
            styles.pcLikeBtn,
            {
              borderColor: isLiked ? palette.primary : palette.border,
              backgroundColor: isLiked ? `${palette.primary}10` : 'transparent',
              opacity: isOwnPost ? 0.3 : pressed ? 0.6 : 1,
            },
          ]}
        >
          <Ionicons
            name={isLiked ? 'thumbs-up' : 'thumbs-up-outline'}
            size={16}
            color={isLiked ? palette.primary : palette.textSecondary}
          />
          <Text style={[styles.pcStat, isLiked && styles.pcStatLiked]}>{post.likes_count}</Text>
        </Pressable>

        <View style={styles.pcStatRow}>
          <Ionicons name="chatbubble-outline" size={16} color={palette.textSecondary} />
          <Text style={styles.pcStat}>{post.comments_count}</Text>
        </View>

        {/* Push action button to far right */}
        <View style={{ flex: 1 }} />

        <Pressable
          onPress={e => { e.stopPropagation(); onPress(); }}
          hitSlop={8}
        >
          <Text style={styles.pcActionVerified}>Répondre</Text>
        </Pressable>
      </View>

    </Pressable>
  );
}

// ─── Screen ───────────────────────────────────────────────────────────────────

export default function DiscussionsScreen() {
  const session     = useAuthStore(s => s.session);
  const businessId  = session?.activeBusiness?.id ?? '';
  const userId      = session?.user.id ?? '';
  const userName    = session?.user.name || generateFallbackName(userId);
  const role        = session?.activeMembership?.role;

  // ─── Chat store (Ma Boutique — untouched) ─────────────────────────────────
  const {
    boutiqueRoom, globalRoom, messages,
    loading, sending, error,
    boutiqueUnread,
    load, sendMessage, appendMessage, markRead,
  } = useChatStore();

  // ─── Market store (Le Marché forum — independent) ─────────────────────────
  const {
    posts, loading: marketLoading, creating, error: marketError,
    fetchPosts, createPost, prependPost, markVisited,
    likedPostIds, lastVisitedAt, toggleLike,
    userLevel,
  } = useMarketStore();

  // ─── Shared state ─────────────────────────────────────────────────────────
  const [activeTab, setActiveTab] = useState<Tab>('boutique');

  // ─── Boutique state ───────────────────────────────────────────────────────
  const [text, setText] = useState('');
  const [partnerLastRead, setPartnerLastRead] = useState<Date | null>(null);
  const boutiqueChannelRef = useRef<ReturnType<typeof supabase.channel> | null>(null);
  const marcheChannelRef   = useRef<ReturnType<typeof supabase.channel> | null>(null);

  // ─── Forum state ──────────────────────────────────────────────────────────
  const [selectedCat, setSelectedCat] = useState<'tout' | MarketCategory>('tout');
  const [showNewPost, setShowNewPost] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [newContent, setNewContent] = useState('');
  const [newCategory, setNewCategory] = useState<MarketCategory>('general');
  const marketChannelRef = useRef<ReturnType<typeof supabase.channel> | null>(null);

  // ─── Load on focus (chat always, forum posts if marche tab is active) ────
  useFocusEffect(useCallback(() => {
    if (!businessId || !userId) return;
    load(businessId, userId);
    if (activeTab === 'marche') {
      fetchPosts(userId, selectedCat !== 'tout' ? selectedCat : undefined);
    }
  }, [businessId, userId, activeTab, selectedCat]));

  // ─── Load forum posts when marche tab is active ───────────────────────────
  useEffect(() => {
    if (activeTab !== 'marche' || !userId) return;
    fetchPosts(userId, selectedCat !== 'tout' ? selectedCat : undefined);
    markVisited();
  }, [activeTab, userId]);

  useEffect(() => {
    if (activeTab !== 'marche' || !userId) return;
    fetchPosts(userId, selectedCat !== 'tout' ? selectedCat : undefined);
  }, [selectedCat]);

  // ─── Mark chat read when rooms load ──────────────────────────────────────
  useEffect(() => {
    if (!boutiqueRoom || !globalRoom || !businessId) return;
    markRead(activeTab, businessId);
  }, [boutiqueRoom?.id, globalRoom?.id]);

  // ─── Chat channels (both always active for unread counting) ───────────────
  useEffect(() => {
    if (!boutiqueRoom || !globalRoom) return;

    const bCh = supabase
      .channel(`chat:b:${boutiqueRoom.id}`)
      .on('postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'chat_messages', filter: `room_id=eq.${boutiqueRoom.id}` },
        p => appendMessage(p.new as ChatMessage))
      .subscribe();

    const mCh = supabase
      .channel(`chat:m:${globalRoom.id}`)
      .on('postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'chat_messages', filter: `room_id=eq.${globalRoom.id}` },
        p => appendMessage(p.new as ChatMessage))
      .subscribe();

    boutiqueChannelRef.current = bCh;
    marcheChannelRef.current   = mCh;

    return () => {
      supabase.removeChannel(bCh);
      supabase.removeChannel(mCh);
      boutiqueChannelRef.current = null;
      marcheChannelRef.current   = null;
    };
  }, [boutiqueRoom?.id, globalRoom?.id]);

  // ─── Forum realtime: new posts while on marche tab ────────────────────────
  useEffect(() => {
    if (activeTab !== 'marche') {
      if (marketChannelRef.current) {
        supabase.removeChannel(marketChannelRef.current);
        marketChannelRef.current = null;
      }
      return;
    }
    const ch = supabase
      .channel('market-posts-insert')
      .on('postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'market_posts' },
        p => prependPost(p.new as MarketPost))
      .subscribe();
    marketChannelRef.current = ch;
    return () => {
      supabase.removeChannel(ch);
      marketChannelRef.current = null;
    };
  }, [activeTab]);

  // ─── Read receipt (boutique only) ─────────────────────────────────────────
  const boutiqueRoomId = boutiqueRoom?.id;
  useEffect(() => {
    if (!boutiqueRoomId || !userId) return;

    setPartnerLastRead(null);

    const upsertRead = () =>
      supabase.from('chat_room_reads').upsert(
        { user_id: userId, room_id: boutiqueRoomId, last_read_at: new Date().toISOString() },
        { onConflict: 'user_id,room_id' },
      ).then(() => {});

    upsertRead();

    supabase
      .from('chat_room_reads')
      .select('last_read_at')
      .eq('room_id', boutiqueRoomId)
      .neq('user_id', userId)
      .order('last_read_at', { ascending: false })
      .limit(1)
      .then(({ data }) => {
        if (data && data.length > 0) setPartnerLastRead(new Date(data[0].last_read_at));
      });

    const refetchPartner = () =>
      supabase
        .from('chat_room_reads')
        .select('last_read_at')
        .eq('room_id', boutiqueRoomId)
        .neq('user_id', userId)
        .order('last_read_at', { ascending: false })
        .limit(1)
        .then(({ data }) => {
          if (data && data.length > 0) {
            const d = new Date(data[0].last_read_at);
            setPartnerLastRead(prev => (!prev || d > prev) ? d : prev);
          }
        });

    const readCh = supabase
      .channel(`reads:${boutiqueRoomId}`)
      .on('postgres_changes',
        { event: '*', schema: 'public', table: 'chat_room_reads', filter: `room_id=eq.${boutiqueRoomId}` },
        refetchPartner)
      .subscribe();

    return () => { supabase.removeChannel(readCh); };
  }, [boutiqueRoomId, userId]);

  const boutiqueMessages = useMemo(() => {
    if (!boutiqueRoomId) return [];
    return messages.filter(m => m.room_id === boutiqueRoomId).slice().reverse();
  }, [messages, boutiqueRoomId]);

  // Refresh own read cursor when new boutique messages arrive
  useEffect(() => {
    if (!boutiqueRoomId || !userId || boutiqueMessages.length === 0) return;
    supabase.from('chat_room_reads').upsert(
      { user_id: userId, room_id: boutiqueRoomId, last_read_at: new Date().toISOString() },
      { onConflict: 'user_id,room_id' },
    ).then(() => {});
  }, [boutiqueMessages.length, boutiqueRoomId]);

  const lastOwnMsgId = useMemo(() => {
    for (const m of boutiqueMessages) {
      if (m.sender_id === userId) return m.id;
    }
    return null;
  }, [boutiqueMessages, userId]);

  const partnerRepliedAfterLastOwn = useMemo(() => {
    if (!lastOwnMsgId) return false;
    const lastOwn = boutiqueMessages.find(m => m.id === lastOwnMsgId);
    if (!lastOwn) return false;
    return boutiqueMessages.some(
      m => m.sender_id !== userId && new Date(m.created_at) > new Date(lastOwn.created_at),
    );
  }, [boutiqueMessages, lastOwnMsgId, userId]);

  const listItems = useMemo(() => buildGroupedItems(boutiqueMessages), [boutiqueMessages]);

  // ─── Forum computed values ─────────────────────────────────────────────────
  const filteredPosts = useMemo(() => {
    if (selectedCat === 'tout') return posts;
    return posts.filter(p => p.category === selectedCat);
  }, [posts, selectedCat]);

  const isNewPost = useCallback((post: MarketPost) => {
    if (!lastVisitedAt) return false;
    return new Date(post.created_at) > lastVisitedAt;
  }, [lastVisitedAt]);

  // ─── Handlers ─────────────────────────────────────────────────────────────
  const handleTabChange = useCallback(async (tab: Tab) => {
    setActiveTab(tab);
    if (businessId) await markRead(tab, businessId);
  }, [businessId]);

  const handleSend = async () => {
    const trimmed = text.trim();
    if (!trimmed || !boutiqueRoom?.id || sending) return;
    setText('');
    Keyboard.dismiss();
    await sendMessage({
      roomId: boutiqueRoom.id,
      senderId: userId,
      senderName: userName,
      content: trimmed,
    });
  };

  const handleCreatePost = async () => {
    if (!newTitle.trim() || !newContent.trim()) return;
    try {
      await createPost(newTitle.trim(), newContent.trim(), newCategory);
      haptics.success();
      setShowNewPost(false);
      setNewTitle('');
      setNewContent('');
      setNewCategory('general');
    } catch {
      haptics.error();
    }
  };

  const isAdmin = role === 'administrateur';
  const canPost = isAdmin || userLevel >= 2;

  const boutiqueLabel = boutiqueUnread > 0 ? `Ma Boutique (${boutiqueUnread})` : 'Ma Boutique';

  return (
    <SafeAreaView style={styles.safe} edges={['top', 'bottom']}>

      <View style={styles.header}>
        <Pressable onPress={() => router.back()}>
          <Text variant="body" color="secondary">‹ Retour</Text>
        </Pressable>
        <Text variant="h4">Discussions</Text>
        <View style={{ width: 60 }} />
      </View>

      <View style={styles.tabRow}>
        {(['boutique', 'marche'] as Tab[]).map(t => (
          <Pressable
            key={t}
            onPress={() => handleTabChange(t)}
            style={[styles.tabChip, activeTab === t && styles.tabChipActive]}
          >
            <Text variant="caption" style={{ color: activeTab === t ? palette.textInverse : palette.textSecondary }}>
              {t === 'boutique' ? boutiqueLabel : 'Le Marché'}
            </Text>
          </Pressable>
        ))}
      </View>

      {/* Category chips — outside KAV so they sit flush under the tab row */}
      {activeTab === 'marche' && (
        <View style={styles.catScrollWrap}>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.catScrollContent}
            style={styles.catScroll}
          >
            {(['tout', ...MARKET_CATS] as const).map(cat => (
              <Pressable
                key={cat}
                onPress={() => setSelectedCat(cat)}
                style={[styles.catChip, selectedCat === cat && styles.catChipActive]}
              >
                <Text
                  variant="caption"
                  style={{ color: selectedCat === cat ? palette.textInverse : palette.textSecondary }}
                >
                  {CAT_LABEL[cat]}
                </Text>
              </Pressable>
            ))}
          </ScrollView>
        </View>
      )}

      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>

        {activeTab === 'boutique' ? (
          /* ── Ma Boutique (chat — completely unchanged) ── */
          <>
            {loading && boutiqueMessages.length === 0 ? (
              <View style={styles.empty}>
                <Text variant="body" color="secondary">Chargement…</Text>
              </View>
            ) : listItems.length === 0 ? (
              <View style={styles.empty}>
                <Text variant="body" color="secondary" style={{ textAlign: 'center' }}>
                  Pas encore de message.{'\n'}Écrivez le premier à votre équipe.
                </Text>
              </View>
            ) : (
              <FlatList<ListItem>
                data={listItems}
                keyExtractor={item => item.id}
                inverted
                contentContainerStyle={styles.listContent}
                keyboardShouldPersistTaps="handled"
                renderItem={({ item }) => {
                  if (isSep(item)) {
                    return (
                      <View style={styles.dateSep}>
                        <Text variant="caption" style={styles.dateSepText}>{item.label}</Text>
                      </View>
                    );
                  }
                  const msg        = item as ChatBubbleItem;
                  const isOwn      = msg.sender_id === userId;
                  const showSender = !isOwn && (msg._pos === 'first' || msg._pos === 'standalone');

                  let isRead: boolean | null = null;
                  if (isOwn && msg.id === lastOwnMsgId && !partnerRepliedAfterLastOwn) {
                    isRead = partnerLastRead !== null
                      && new Date(msg.created_at) <= partnerLastRead;
                  }

                  return (
                    <MessageBubble
                      msg={msg}
                      isOwn={isOwn}
                      pos={msg._pos}
                      showSender={showSender}
                      isRead={isRead}
                    />
                  );
                }}
              />
            )}

            {error ? (
              <View style={styles.errorStrip}>
                <Text variant="caption" style={{ color: palette.danger }}>{error}</Text>
              </View>
            ) : null}

            <View style={styles.inputRow}>
              <TextInput
                style={styles.input}
                value={text}
                onChangeText={setText}
                placeholder="Écrire un message…"
                placeholderTextColor={palette.textSecondary}
                multiline
                maxLength={1000}
                returnKeyType="default"
              />
              <Pressable
                onPress={handleSend}
                disabled={!text.trim() || sending}
                style={({ pressed }) => [
                  styles.sendBtn,
                  (!text.trim() || sending) && styles.sendBtnDisabled,
                  pressed && { opacity: 0.75 },
                ]}
              >
                <Text style={styles.sendIcon}>↑</Text>
              </Pressable>
            </View>
          </>
        ) : (
          /* ── Le Marché (forum — new) ── */
          <>
            {/* Post list */}
            {marketLoading && posts.length === 0 ? (
              <View style={styles.empty}>
                <Text variant="body" color="secondary">Chargement…</Text>
              </View>
            ) : filteredPosts.length === 0 ? (
              <View style={styles.empty}>
                <Text variant="body" color="secondary" style={{ textAlign: 'center' }}>
                  {selectedCat === 'tout'
                    ? 'Le Marché est calme pour l\'instant.\nSoyez le premier à publier.'
                    : 'Aucun post dans cette catégorie.'}
                </Text>
              </View>
            ) : (
              <FlatList<MarketPost>
                data={filteredPosts}
                keyExtractor={p => p.id}
                contentContainerStyle={styles.marketListContent}
                renderItem={({ item }) => (
                  <PostCard
                    post={item}
                    isNew={isNewPost(item)}
                    isLiked={likedPostIds.includes(item.id)}
                    isOwnPost={item.author_id === userId}
                    onPress={() => router.push(`/(app)/marche/${item.id}`)}
                    onLike={() => { haptics.tap(); toggleLike(item.id, userId); }}
                  />
                )}
              />
            )}

            {marketError ? (
              <View style={styles.errorStrip}>
                <Text variant="caption" style={{ color: palette.danger }}>{marketError}</Text>
              </View>
            ) : null}

            {/* Bottom bar */}
            {canPost ? (
              <Pressable onPress={() => setShowNewPost(true)} style={styles.newPostBtn}>
                <Text style={styles.newPostBtnText}>+ Nouveau post</Text>
              </Pressable>
            ) : (
              <View style={styles.minimalUnlockBanner}>
                <Text style={styles.minimalUnlockText}>
                  💬 Participez aux discussions ! Vous pourrez bientôt publier vos propres messages.
                </Text>
              </View>
            )}
          </>
        )}
      </KeyboardAvoidingView>

      {/* ── New post modal ── */}
      <Modal visible={showNewPost} animationType="slide" onRequestClose={() => setShowNewPost(false)}>
        <SafeAreaView style={styles.modalSafe} edges={['top', 'bottom']}>
          <View style={styles.modalHeader}>
            <Pressable onPress={() => { setShowNewPost(false); setNewTitle(''); setNewContent(''); setNewCategory('general'); }} hitSlop={8}>
              <Text variant="body" color="secondary">Annuler</Text>
            </Pressable>
            <Text variant="h4">Nouveau post</Text>
            <View style={{ width: 60 }} />
          </View>

          <ScrollView contentContainerStyle={styles.modalContent} keyboardShouldPersistTaps="handled">
            <Text variant="label" style={styles.fieldLabel}>Catégorie</Text>
            <View style={styles.modalCatRow}>
              {MARKET_CATS.map(cat => (
                <Pressable
                  key={cat}
                  onPress={() => setNewCategory(cat)}
                  style={[styles.modalCatChip, newCategory === cat && styles.modalCatChipActive]}
                >
                  <Text
                    variant="caption"
                    style={{ color: newCategory === cat ? palette.textInverse : palette.textSecondary }}
                  >
                    {CAT_LABEL[cat]}
                  </Text>
                </Pressable>
              ))}
            </View>

            <Text variant="label" style={styles.fieldLabel}>Titre</Text>
            <TextInput
              style={styles.modalInput}
              value={newTitle}
              onChangeText={setNewTitle}
              placeholder="Titre de votre post…"
              placeholderTextColor={palette.textSecondary}
              maxLength={100}
              returnKeyType="next"
            />

            <Text variant="label" style={styles.fieldLabel}>Message</Text>
            <TextInput
              style={[styles.modalInput, styles.modalInputMulti]}
              value={newContent}
              onChangeText={setNewContent}
              placeholder="Partagez votre idée, question ou annonce…"
              placeholderTextColor={palette.textSecondary}
              multiline
              maxLength={1000}
            />

            <Pressable
              onPress={handleCreatePost}
              disabled={creating || !newTitle.trim() || !newContent.trim()}
              style={[
                styles.newPostBtn,
                { marginTop: spacing[2] },
                (creating || !newTitle.trim() || !newContent.trim()) && { backgroundColor: palette.border },
              ]}
            >
              <Text style={styles.newPostBtnText}>
                {creating ? 'Publication…' : 'Publier'}
              </Text>
            </Pressable>
          </ScrollView>
        </SafeAreaView>
      </Modal>

    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: palette.background },

  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: spacing[5],
    borderBottomWidth: 1,
    borderBottomColor: palette.border,
  },

  tabRow: {
    flexDirection: 'row',
    gap: spacing[2],
    paddingHorizontal: spacing[5],
    paddingTop: spacing[3],
    paddingBottom: spacing[2],
  },
  tabChip: {
    flex: 1,
    paddingHorizontal: spacing[4],
    paddingVertical: spacing[1.5],
    borderRadius: radius.full,
    borderWidth: 1,
    borderColor: palette.border,
    backgroundColor: palette.surface,
    alignItems: 'center',
  },
  tabChipActive: { backgroundColor: palette.primary, borderColor: palette.primary },

  listContent: { paddingHorizontal: spacing[4], paddingVertical: spacing[3] },
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing[6] },

  // Boutique chat
  dateSep: { alignItems: 'center', marginVertical: 12 },
  dateSepText: { color: palette.textSecondary },

  row: {},
  rowOwn: { alignItems: 'flex-end' },

  senderRow: { flexDirection: 'row', alignItems: 'center', gap: spacing[2], marginBottom: 2, marginLeft: 12 },
  senderName: { color: palette.textSecondary, fontWeight: '600' },

  bubble: { maxWidth: '75%', borderRadius: 16, paddingVertical: 8, paddingHorizontal: 12 },
  bubbleOwn: { alignSelf: 'flex-end', marginRight: 12, backgroundColor: palette.primary },
  bubbleOther: {
    alignSelf: 'flex-start',
    marginLeft: 12,
    backgroundColor: palette.surface,
    borderWidth: 1,
    borderColor: palette.border,
  },
  bubbleText:    { fontSize: 15, lineHeight: 22, color: palette.textPrimary },
  bubbleTextOwn: { color: palette.textInverse },

  metaRow: { flexDirection: 'row', alignItems: 'center', gap: spacing[2], marginTop: 2 },
  ts:      { fontSize: 11, color: palette.textSecondary },
  tsOwn:   { alignSelf: 'flex-end' },
  receipt:     { fontSize: 11, color: palette.textSecondary },
  receiptRead: { color: palette.primary, fontWeight: '600' },

  errorStrip: {
    paddingHorizontal: spacing[4],
    paddingVertical: spacing[2],
    backgroundColor: '#FFF1F2',
  },

  readOnlyBar: {
    paddingHorizontal: spacing[5],
    paddingVertical: spacing[4],
    borderTopWidth: 1,
    borderTopColor: palette.border,
    backgroundColor: palette.surface,
  },
  minimalUnlockBanner: {
    borderTopWidth: 1,
    borderTopColor: palette.border,
    backgroundColor: palette.surface,
    paddingHorizontal: spacing[5],
    paddingVertical: 14,
    alignItems: 'center' as const,
  },
  minimalUnlockText: {
    fontSize: 13,
    color: palette.textSecondary,
    textAlign: 'center' as const,
    lineHeight: 18,
  },

  inputRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: spacing[2],
    paddingHorizontal: spacing[4],
    paddingVertical: spacing[3],
    borderTopWidth: 1,
    borderTopColor: palette.border,
    backgroundColor: palette.surface,
  },
  input: {
    flex: 1,
    minHeight: 40,
    maxHeight: 120,
    borderWidth: 1,
    borderColor: palette.border,
    borderRadius: radius.lg,
    paddingHorizontal: spacing[3],
    paddingVertical: spacing[2],
    fontSize: 15,
    color: palette.textPrimary,
    backgroundColor: palette.background,
  },
  sendBtn: {
    width: 40, height: 40,
    borderRadius: radius.full,
    backgroundColor: palette.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sendBtnDisabled: { backgroundColor: palette.border },
  sendIcon: { fontSize: 20, color: palette.textInverse, lineHeight: 24 },

  // Forum: category filter wrapper
  catScrollWrap: {
    height: 48,
    justifyContent: 'center' as const,
    backgroundColor: palette.background,
    borderBottomWidth: 1,
    borderBottomColor: palette.border,
    marginBottom: 8,
  },
  catScroll: { flexGrow: 0 },
  catScrollContent: {
    paddingHorizontal: spacing[4],
    paddingRight: spacing[8],
    gap: spacing[2],
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
  },
  catChip: {
    paddingHorizontal: spacing[3],
    paddingVertical: spacing[1.5],
    borderRadius: radius.full,
    borderWidth: 1,
    borderColor: palette.border,
    backgroundColor: palette.surface,
  },
  catChipActive: { backgroundColor: palette.primary, borderColor: palette.primary },

  // Forum: shared badge styles
  newBadge: {
    backgroundColor: colors.success[100],
    borderRadius: radius.full,
    paddingHorizontal: spacing[2],
    paddingVertical: 1,
  },
  newBadgeText: { fontSize: 10, color: '#166534', fontWeight: '700' as const },
  catBadge: { borderRadius: radius.full, paddingHorizontal: spacing[2], paddingVertical: 2 },
  catBadgeText: { fontSize: 11, fontWeight: '600' as const },

  // Forum: compact high-density card
  pcCard: {
    backgroundColor: palette.surface,
    borderRadius: 12,
    padding: 12,
    marginHorizontal: 16,
    marginVertical: 6,
    borderWidth: 1,
    borderColor: palette.border,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.05,
    shadowRadius: 4,
    elevation: 2,
  },
  pcTopRow: {
    flexDirection: 'row' as const,
    justifyContent: 'space-between' as const,
    alignItems: 'center' as const,
  },
  pcAuthorBlock: {
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    flex: 1,
  },
  pcMetaBlock: {
    alignItems: 'flex-end' as const,
    gap: 2,
  },
  pcAvatar: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: 'center' as const,
    justifyContent: 'center' as const,
  },
  pcAvatarText: { fontSize: 13, fontWeight: '700' as const, color: '#fff' },
  pcAuthorInfo: { marginLeft: 8 },
  pcAuthorName: { fontSize: 14, fontWeight: '600' as const, color: palette.textPrimary },
  pcAuthorRank: { fontSize: 12, color: colors.primary[600], fontWeight: '500' as const },
  pcTimestamp: { fontSize: 11, color: palette.textSecondary, marginTop: 2 },
  pcTitle: { fontSize: 15, fontWeight: '700' as const, color: palette.textPrimary, marginTop: 8 },
  pcExcerpt: { fontSize: 13, color: palette.textSecondary, lineHeight: 18, marginTop: 2, marginBottom: 8 },
  pcFooter: {
    flexDirection: 'row' as const,
    justifyContent: 'flex-start' as const,
    alignItems: 'center' as const,
    gap: 16,
  },
  pcLikeBtn: {
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    gap: 6,
    borderWidth: 1,
    borderRadius: 6,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  pcStatRow: { flexDirection: 'row' as const, alignItems: 'center' as const, gap: 6 },
  pcStat: { fontSize: 13, color: palette.textSecondary, fontWeight: '500' as const },
  pcStatLiked: { color: palette.primary },
  pcActionVerified: { fontSize: 13, color: palette.primary, fontWeight: '600' as const },
  pcActionSave: { fontSize: 13, color: palette.textSecondary, fontWeight: '500' as const },
  marketListContent: { paddingBottom: spacing[6] },

  // Forum: new post button
  newPostBtn: {
    margin: spacing[4],
    borderRadius: radius.md,
    backgroundColor: palette.primary,
    paddingVertical: spacing[3],
    alignItems: 'center',
  },
  newPostBtnText: { color: palette.textInverse, fontWeight: '600', fontSize: 15 },

  // Modal
  modalSafe: { flex: 1, backgroundColor: palette.background },
  modalHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: spacing[5],
    borderBottomWidth: 1,
    borderBottomColor: palette.border,
  },
  modalContent: { padding: spacing[5], gap: spacing[3] },
  fieldLabel: { marginBottom: spacing[1] },
  modalCatRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing[2], marginBottom: spacing[2] },
  modalCatChip: {
    paddingHorizontal: spacing[3],
    paddingVertical: spacing[1.5],
    borderRadius: radius.full,
    borderWidth: 1,
    borderColor: palette.border,
    backgroundColor: palette.surface,
  },
  modalCatChipActive: { backgroundColor: palette.primary, borderColor: palette.primary },
  modalInput: {
    borderWidth: 1,
    borderColor: palette.border,
    borderRadius: radius.md,
    paddingHorizontal: spacing[3],
    paddingVertical: spacing[2.5],
    fontSize: 15,
    color: palette.textPrimary,
    backgroundColor: palette.background,
  },
  modalInputMulti: { minHeight: 140, textAlignVertical: 'top' },
});
