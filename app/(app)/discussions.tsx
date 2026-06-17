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
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withSpring,
  withTiming,
  runOnJS,
} from 'react-native-reanimated';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { router, useFocusEffect } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { Text } from '@/src/components/ui/Text';
import { haptics } from '@/lib/haptics';
import { colors, useTheme, fontFamily as FF, radius, spacing } from '@/src/theme';
import type { Palette } from '@/src/theme';
import { useAuthStore } from '@/stores/auth';
import { useChatStore } from '@/stores/chat';
import { useMarketStore } from '@/stores/market';
import { SkeletonList } from '@/src/components/ui/SkeletonPlaceholder';
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
  const d      = new Date(iso);
  const diffMs = Date.now() - d.getTime();
  const diffH  = Math.floor(diffMs / 3_600_000);
  const diffD  = Math.floor(diffMs / 86_400_000);
  if (diffH < 1)  return '1h';
  if (diffH < 24) return `${diffH}h`;
  if (diffD <= 7) return `${diffD}j`;
  return new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'short' }).format(d);
}

// ─── Message grouping ─────────────────────────────────────────────────────────

const GROUP_GAP_MS = 5 * 60_000; // same group if < 5 min apart

function sameGroup(a: ChatMessage, b: ChatMessage): boolean {
  return a.sender_id === b.sender_id
    && Math.abs(new Date(a.created_at).getTime() - new Date(b.created_at).getTime()) < GROUP_GAP_MS;
}

const FR_DAYS   = ['Dimanche', 'Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi'];
const FR_MONTHS = ['jan', 'fév', 'mars', 'avr', 'mai', 'juin', 'juil', 'août', 'sept', 'oct', 'nov', 'déc'];

function timeSepLabel(iso: string): string {
  const d         = new Date(iso);
  const today     = new Date();
  const yesterday = new Date(today); yesterday.setDate(today.getDate() - 1);
  if (sameDay(d, today))     return "Aujourd'hui";
  if (sameDay(d, yesterday)) return 'Hier';
  const daysDiff = Math.floor((today.getTime() - d.getTime()) / (24 * 60 * 60 * 1000));
  if (daysDiff < 7) return FR_DAYS[d.getDay()];
  return `${d.getDate()} ${FR_MONTHS[d.getMonth()]}`;
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
    // Insert one separator per calendar-day boundary.
    // Label is msgs[i]'s day (the newer side) — separator marks the top of that day's section.
    if (nextMsg && !sameDay(new Date(msgs[i].created_at), new Date(nextMsg.created_at))) {
      out.push({ _sep: true, label: timeSepLabel(msgs[i].created_at), id: `tsep-${msgs[i].id}` });
    }
  }
  // Always cap the top with a label for the oldest day group
  out.push({ _sep: true, label: timeSepLabel(msgs[msgs.length - 1].created_at), id: 'tsep-oldest' });
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

// ─── Sender colour palette ────────────────────────────────────────────────────

const SENDER_COLORS = ['#6366F1', '#10B981', '#F59E0B', '#8B5CF6', '#06B6D4', '#EC4899'];

function senderColor(senderId: string): string {
  let h = 0;
  for (let i = 0; i < senderId.length; i++) h = (h * 31 + senderId.charCodeAt(i)) & 0xFFFFFF;
  return SENDER_COLORS[Math.abs(h) % SENDER_COLORS.length];
}

// ─── MessageBubble ────────────────────────────────────────────────────────────

const SWIPE_THRESHOLD = 52;

function MessageBubble({
  msg, isOwn, pos, isRead, onReply, onEdit,
}: {
  msg: ChatMessage;
  isOwn: boolean;
  pos: GroupPos;
  isRead: boolean | null;
  onReply: () => void;
  onEdit: (() => void) | null;
}) {
  const { palette } = useTheme();
  const styles = useMemo(() => makeStyles(palette), [palette]);
  const time       = new Date(msg.created_at).toLocaleTimeString(LOCALE, { hour: '2-digit', minute: '2-digit' });
  const br         = bubbleRadius(isOwn, pos);
  const margins    = bubbleMargins(pos);
  const showAvatar = !isOwn && (pos === 'standalone' || pos === 'last');
  const showName   = !isOwn && (pos === 'standalone' || pos === 'first');
  const name       = msg.sender_name || generateFallbackName(msg.sender_id);
  const initial    = name.charAt(0).toUpperCase();
  const color      = senderColor(msg.sender_id);

  const translateX = useSharedValue(0);

  const pan = Gesture.Pan()
    .activeOffsetX([6, 999])
    .failOffsetY([-10, 10])
    .onUpdate(e => {
      if (e.translationX > 0) {
        // 1:1 movement up to threshold, then resistance
        translateX.value = e.translationX < SWIPE_THRESHOLD
          ? e.translationX
          : SWIPE_THRESHOLD + (e.translationX - SWIPE_THRESHOLD) * 0.2;
      }
    })
    .onEnd(e => {
      if (e.translationX >= SWIPE_THRESHOLD) {
        runOnJS(onReply)();
        runOnJS(haptics.tap)();
      }
      translateX.value = withSpring(0, { damping: 20, stiffness: 400 });
    });


  const slideAnim = useAnimatedStyle(() => ({
    transform: [{ translateX: translateX.value }],
  }));

  const iconAnim = useAnimatedStyle(() => ({
    opacity: Math.min(translateX.value / (SWIPE_THRESHOLD * 0.7), 1),
    transform: [{ scale: 0.5 + Math.min(translateX.value / SWIPE_THRESHOLD, 1) * 0.5 }],
  }));

  return (
    // Outer detector: pan only — type is always Pan, never changes between renders
    <GestureDetector gesture={pan}>
      <View style={[margins, { overflow: 'visible' }]}>

        {/* Reply icon — absolute, revealed as row slides right */}
        <Animated.View style={[styles.swipeIcon, { position: 'absolute', left: 8, top: '50%', marginTop: -16 }, iconAnim]}>
          <Ionicons name="arrow-undo-outline" size={18} color={palette.primary} />
        </Animated.View>

        {/* The entire row slides right on swipe */}
        <Animated.View style={[isOwn ? styles.rowOwn : styles.rowOther, slideAnim]}>

          {/* Avatar — incoming only, no width consumed by icon */}
          {!isOwn && (
            <View style={styles.avatarCol}>
              {showAvatar ? (
                <View style={[styles.avatar, { backgroundColor: color }]}>
                  <Text style={styles.avatarText}>{initial}</Text>
                </View>
              ) : (
                <View style={styles.avatarSpacer} />
              )}
            </View>
          )}

          {/* Bubble — tap the pencil icon to edit (onPress works inside GestureDetector; onLongPress doesn't) */}
          <View style={[styles.bubble, isOwn ? styles.bubbleOwn : styles.bubbleOther, br]}>
            {showName && (
              <Text style={[styles.senderName, { color }]}>{name}</Text>
            )}

            {msg.reply_to_id ? (
              <View style={[styles.replyPill, isOwn ? styles.replyPillOwn : styles.replyPillOther]}>
                <View style={[styles.replyAccent, { backgroundColor: isOwn ? 'rgba(255,255,255,0.6)' : color }]} />
                <View style={styles.replyPillContent}>
                  <Text style={[styles.replyPillName, isOwn ? styles.replyPillNameOwn : { color }]} numberOfLines={1}>
                    {msg.reply_to_sender_name || '—'}
                  </Text>
                  <Text style={[styles.replyPillText, isOwn && styles.replyPillTextOwn]} numberOfLines={2}>
                    {msg.reply_to_content}
                  </Text>
                </View>
              </View>
            ) : null}

            <Text style={[styles.bubbleText, isOwn && styles.bubbleTextOwn]}>{msg.content}</Text>

            <View style={styles.bubbleMeta}>
              {msg.edited_at ? (
                <Text style={[styles.ts, isOwn ? styles.tsOwn : styles.tsOther]}>modifié · </Text>
              ) : null}
              <Text style={[styles.ts, isOwn ? styles.tsOwn : styles.tsOther]}>{time}</Text>
              {onEdit && (
                <Pressable onPress={onEdit} hitSlop={10} style={{ marginLeft: 4 }}>
                  <Ionicons name="pencil-outline" size={11} color="rgba(255,255,255,0.55)" />
                </Pressable>
              )}
              {isOwn && isRead !== null && (
                <Text style={[styles.receipt, isRead && styles.receiptRead]}>
                  {isRead ? ' ✓✓' : ' ✓'}
                </Text>
              )}
            </View>
          </View>

        </Animated.View>
      </View>
    </GestureDetector>
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
  const { palette } = useTheme();
  const styles = useMemo(() => makeStyles(palette), [palette]);
  const authorName  = post.author_name || generateFallbackName(post.author_id);
  const initial     = authorName.charAt(0).toUpperCase();
  const avatarColor = AVATAR_PALETTE[post.author_id.charCodeAt(0) % AVATAR_PALETTE.length];

  return (
    <Pressable onPress={onPress} style={({ pressed }) => [styles.pcCard, pressed && { opacity: 0.88 }]}>

      {/* Top row: avatar + author name · time · category (all inline left) */}
      <View style={styles.pcTopRow}>
        <View style={[styles.pcAvatar, { backgroundColor: avatarColor }]}>
          <Text style={styles.pcAvatarText}>{initial}</Text>
        </View>
        <View style={styles.pcAuthorInfo}>
          <Text style={styles.pcAuthorName} numberOfLines={1}>{authorName}</Text>
          <View style={styles.pcMeta}>
            <Text style={styles.pcTimestamp}>{relativeTime(post.created_at)}</Text>
            <Text style={styles.pcMetaDot}>·</Text>
            <View style={[styles.catBadge, { backgroundColor: CAT_BG[post.category] ?? '#F3F4F6' }]}>
              <Text style={[styles.catBadgeText, { color: CAT_FG[post.category] ?? '#374151' }]}>
                {CAT_LABEL[post.category] ?? post.category}
              </Text>
            </View>
          </View>
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

        <Pressable
          onPress={e => { e.stopPropagation(); if (!isOwnPost) onLike(); }}
          hitSlop={8}
          disabled={isOwnPost}
          style={({ pressed }) => ({
            flexDirection: 'row' as const,
            alignItems: 'center' as const,
            gap: 5,
            opacity: isOwnPost ? 0.3 : pressed ? 0.55 : 1,
          })}
        >
          <Ionicons
            name={isLiked ? 'heart' : 'heart-outline'}
            size={16}
            color={isLiked ? palette.primary : palette.textSecondary}
          />
          {post.likes_count > 0 && (
            <Text style={[styles.pcStat, isLiked && styles.pcStatLiked]}>{post.likes_count}</Text>
          )}
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
  const { palette } = useTheme();
  const styles = useMemo(() => makeStyles(palette), [palette]);
  const insets      = useSafeAreaInsets();
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
    load, sendMessage, editMessage, appendMessage, updateMessage, markRead,
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
  const [replyingTo, setReplyingTo] = useState<ChatMessage | null>(null);
  const [editingMsg, setEditingMsg] = useState<ChatMessage | null>(null);
  const [partnerLastRead, setPartnerLastRead] = useState<Date | null>(null);
  const boutiqueChannelRef = useRef<ReturnType<typeof supabase.channel> | null>(null);
  const marcheChannelRef   = useRef<ReturnType<typeof supabase.channel> | null>(null);

  // ─── Forum state ──────────────────────────────────────────────────────────
  const [selectedCat, setSelectedCat] = useState<'tout' | MarketCategory>('tout');
  const [showNewPost, setShowNewPost] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [newContent, setNewContent] = useState('');
  const [newCategory, setNewCategory] = useState<MarketCategory | null>(null);
  const [postError, setPostError] = useState('');
  const marketChannelRef = useRef<ReturnType<typeof supabase.channel> | null>(null);

  // ─── Fade transition between tabs ─────────────────────────────────────────
  const contentAlpha = useSharedValue(1);
  const contentStyle = useAnimatedStyle(() => ({ opacity: contentAlpha.value }));

  // ─── Load chat on screen focus only — not on every tab switch ───────────
  useFocusEffect(useCallback(() => {
    if (!businessId || !userId) return;
    load(businessId, userId);
  }, [businessId, userId]));

  // ─── Load forum posts when marche tab becomes active or category changes ──
  useEffect(() => {
    if (activeTab !== 'marche' || !userId) return;
    fetchPosts(userId, selectedCat !== 'tout' ? selectedCat : undefined);
    markVisited();
  }, [activeTab, userId, selectedCat]);

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
      .on('postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'chat_messages', filter: `room_id=eq.${boutiqueRoom.id}` },
        p => updateMessage(p.new as ChatMessage))
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
  const switchTabAndFadeIn = useCallback((tab: Tab) => {
    setActiveTab(tab);
    if (businessId) markRead(tab, businessId);
    contentAlpha.value = withTiming(1, { duration: 140 });
  }, [businessId]);

  const handleTabChange = useCallback((tab: Tab) => {
    contentAlpha.value = withTiming(0, { duration: 80 }, (finished) => {
      if (finished) runOnJS(switchTabAndFadeIn)(tab);
    });
  }, [switchTabAndFadeIn]);

  const cancelEdit = () => {
    setEditingMsg(null);
    setText('');
  };

  const handleSend = async () => {
    const trimmed = text.trim();
    if (!trimmed || sending) return;

    if (editingMsg) {
      const msg = editingMsg;
      setText('');
      setEditingMsg(null);
      Keyboard.dismiss();
      try {
        await editMessage(msg.id, trimmed);
        haptics.success();
      } catch {
        haptics.error();
      }
      return;
    }

    if (!boutiqueRoom?.id) return;
    const reply = replyingTo;
    setText('');
    setReplyingTo(null);
    Keyboard.dismiss();
    await sendMessage({
      roomId: boutiqueRoom.id,
      senderId: userId,
      senderName: userName,
      content: trimmed,
      replyTo: reply ? { id: reply.id, content: reply.content, senderName: reply.sender_name || generateFallbackName(reply.sender_id) } : null,
    });
  };

  const closeNewPost = () => {
    setShowNewPost(false);
    setNewTitle('');
    setNewContent('');
    setNewCategory(null);
    setPostError('');
  };

  const handleCreatePost = async () => {
    if (!newCategory) { setPostError('Veuillez sélectionner une catégorie'); return; }
    if (!newTitle.trim()) { setPostError('Veuillez ajouter un titre'); return; }
    if (!newContent.trim()) { setPostError('Veuillez écrire votre message'); return; }
    setPostError('');
    try {
      await createPost(newTitle.trim(), newContent.trim(), newCategory);
      haptics.success();
      closeNewPost();
    } catch {
      haptics.error();
    }
  };

  const isAdmin = role === 'administrateur';
  const canPost = isAdmin || userLevel >= 2;

  return (
    <KeyboardAvoidingView
      style={{ flex: 1, backgroundColor: palette.background }}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
    >
    <SafeAreaView style={styles.safe} edges={['top']}>

      <View style={styles.header}>
        <Pressable onPress={() => router.back()}>
          <Text variant="body" color="secondary">‹ Retour</Text>
        </Pressable>
        <Text variant="h4">Discussions</Text>
        <View style={{ width: 60 }} />
      </View>

      <View style={styles.tabRow}>
        <View style={styles.tabTrack}>
          <Pressable
            onPress={() => handleTabChange('boutique')}
            style={[styles.tabSeg, activeTab === 'boutique' && styles.tabSegActive]}
          >
            <View style={styles.tabLabelRow}>
              <Text style={[styles.tabSegText, activeTab === 'boutique' && styles.tabSegTextActive]}>
                Ma Boutique
              </Text>
              {boutiqueUnread > 0 && <View style={styles.unreadDot} />}
            </View>
          </Pressable>
          <Pressable
            onPress={() => handleTabChange('marche')}
            style={[styles.tabSeg, activeTab === 'marche' && styles.tabSegActive]}
          >
            <Text style={[styles.tabSegText, activeTab === 'marche' && styles.tabSegTextActive]}>
              Le Marché
            </Text>
          </Pressable>
        </View>
      </View>

      <Animated.View style={[{ flex: 1 }, contentStyle]}>
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

        {activeTab === 'boutique' ? (
          /* ── Ma Boutique (chat — completely unchanged) ── */
          <>
            {loading && !boutiqueRoom ? (
              <SkeletonList count={6} />
            ) : !boutiqueRoom ? (
              <View style={styles.empty}>
                <Text variant="body" color="secondary">Chargement…</Text>
              </View>
            ) : listItems.length === 0 ? (
              <View style={styles.empty}>
                <Text variant="h4" style={{ textAlign: 'center', marginBottom: 8 }}>Votre espace privé</Text>
                <Text variant="body" color="secondary" style={{ textAlign: 'center', lineHeight: 22 }}>
                  Ce que vous écrivez ici reste entre vous et votre équipe uniquement.
                </Text>
              </View>
            ) : (
              <FlatList<ListItem>
                data={listItems}
                keyExtractor={item => item.id}
                inverted
                style={{ flex: 1 }}
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
                  const msg    = item as ChatBubbleItem;
                  const isOwn  = msg.sender_id === userId;

                  let isRead: boolean | null = null;
                  if (isOwn && msg.id === lastOwnMsgId && !partnerRepliedAfterLastOwn) {
                    isRead = partnerLastRead !== null
                      && new Date(msg.created_at) <= partnerLastRead;
                  }

                  // Editable if own message AND sent within the last 15 minutes (WhatsApp rule)
                  const canEdit = isOwn &&
                    Date.now() - new Date(msg.created_at).getTime() < 15 * 60 * 1000;

                  return (
                    <MessageBubble
                      msg={msg}
                      isOwn={isOwn}
                      pos={msg._pos}
                      isRead={isRead}
                      onReply={() => setReplyingTo(msg)}
                      onEdit={canEdit ? () => {
                        setReplyingTo(null);
                        setEditingMsg(msg);
                        setText(msg.content);
                      } : null}
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

            {/* Docked edit preview */}
            {editingMsg ? (
              <View style={styles.editDock}>
                <Ionicons name="pencil" size={15} color={palette.primary} />
                <View style={styles.replyDockBody}>
                  <Text style={styles.editDockLabel}>Modifier le message</Text>
                  <Text style={styles.replyDockText} numberOfLines={1}>{editingMsg.content}</Text>
                </View>
                <Pressable onPress={cancelEdit} hitSlop={12}>
                  <Ionicons name="close" size={18} color={palette.textSecondary} />
                </Pressable>
              </View>
            ) : replyingTo ? (
              <View style={styles.replyDock}>
                <View style={[styles.replyDockAccent, { backgroundColor: senderColor(replyingTo.sender_id) }]} />
                <View style={styles.replyDockBody}>
                  <Text style={[styles.replyDockName, { color: senderColor(replyingTo.sender_id) }]}>
                    {replyingTo.sender_name || generateFallbackName(replyingTo.sender_id)}
                  </Text>
                  <Text style={styles.replyDockText} numberOfLines={1}>{replyingTo.content}</Text>
                </View>
                <Pressable onPress={() => setReplyingTo(null)} hitSlop={12}>
                  <Ionicons name="close" size={18} color={palette.textSecondary} />
                </Pressable>
              </View>
            ) : null}

            <View style={[styles.inputRow, { paddingBottom: Math.max(insets.bottom, spacing[3]) }]}>
              <TextInput
                style={styles.input}
                value={text}
                onChangeText={setText}
                placeholder="Écrire à l'équipe…"
                placeholderTextColor={palette.textSecondary}
                multiline
                maxLength={1000}
                returnKeyType="default"
              />
              {(!!text.trim() || !!editingMsg) && (
                <Pressable
                  onPress={handleSend}
                  disabled={sending}
                  style={({ pressed }) => [
                    styles.sendBtn,
                    pressed && { opacity: 0.75 },
                  ]}
                >
                  <Ionicons name={editingMsg ? 'checkmark' : 'arrow-forward'} size={20} color={palette.textInverse} />
                </Pressable>
              )}
            </View>
          </>
        ) : (
          /* ── Le Marché (forum — new) ── */
          <>
            {/* Post list */}
            {marketLoading && posts.length === 0 ? (
              <SkeletonList count={5} />
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
      </Animated.View>

      {/* ── New post modal ── */}
      <Modal visible={showNewPost} animationType="slide" onRequestClose={closeNewPost}>
        <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
          <SafeAreaView style={styles.modalSafe} edges={['bottom']}>
            <View style={[styles.modalHeader, { paddingTop: insets.top + spacing[4] }]}>
              <Pressable onPress={closeNewPost} hitSlop={8}>
                <Text variant="body" color="secondary">Annuler</Text>
              </Pressable>
              <Text variant="h4">Nouveau post</Text>
              {(() => {
                const hasContent = newTitle.trim().length > 0 || newContent.trim().length > 0;
                return (
                  <Pressable onPress={handleCreatePost} disabled={creating || !hasContent} hitSlop={8}>
                    <Text variant="body" style={{ color: (creating || !hasContent) ? palette.textDisabled : palette.primary, fontWeight: '600' }}>
                      {creating ? '…' : 'Publier'}
                    </Text>
                  </Pressable>
                );
              })()}
            </View>

            <ScrollView style={{ flex: 1 }} contentContainerStyle={styles.modalContent} keyboardShouldPersistTaps="handled">
              <View style={styles.composerCard}>
                <TextInput
                  style={styles.composerTitle}
                  value={newTitle}
                  onChangeText={t => { setNewTitle(t); setPostError(''); }}
                  placeholder="Titre"
                  placeholderTextColor={palette.textSecondary}
                  maxLength={100}
                  returnKeyType="next"
                  autoFocus
                />
                <View style={styles.composerDivider} />
                <TextInput
                  style={styles.composerBody}
                  value={newContent}
                  onChangeText={t => { setNewContent(t); setPostError(''); }}
                  placeholder="Partagez votre expérience"
                  placeholderTextColor={palette.textSecondary}
                  multiline
                  scrollEnabled={false}
                  maxLength={1000}
                  textAlignVertical="top"
                />
              <Text variant="caption" color="secondary" style={styles.charCount}>
                {newContent.length}/1000
              </Text>
              <View style={styles.composerDivider} />
              <View style={styles.composerBottom}>
                <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.composerCatRow}>
                  {MARKET_CATS.map(cat => (
                    <Pressable
                      key={cat}
                      onPress={() => { setNewCategory(cat); setPostError(''); }}
                      style={[styles.modalCatChip, newCategory === cat && styles.modalCatChipActive]}
                    >
                      <Text variant="caption" style={{ color: newCategory === cat ? palette.textInverse : palette.textSecondary }}>
                        {CAT_LABEL[cat]}
                      </Text>
                    </Pressable>
                  ))}
                </ScrollView>
                <Text variant="caption" style={[styles.composerError, { opacity: postError ? 1 : 0 }]}>
                  {postError || ' '}
                </Text>
              </View>
            </View>
            </ScrollView>
          </SafeAreaView>
        </KeyboardAvoidingView>
      </Modal>

    </SafeAreaView>
    </KeyboardAvoidingView>
  );
}

function makeStyles(p: Palette) {
  return StyleSheet.create({
  safe: { flex: 1, backgroundColor: p.background },

  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: spacing[5],
    borderBottomWidth: 1,
    borderBottomColor: p.border,
  },

  tabRow: {
    paddingHorizontal: spacing[5],
    paddingTop: spacing[3],
    paddingBottom: spacing[2],
  },
  tabTrack: {
    flexDirection: 'row' as const,
    backgroundColor: p.surface,
    borderRadius: radius.full,
    borderWidth: 1,
    borderColor: p.border,
    padding: 3,
  },
  tabSeg: {
    flex: 1,
    paddingVertical: 7,
    borderRadius: radius.full,
    alignItems: 'center' as const,
    justifyContent: 'center' as const,
  },
  tabSegActive: { backgroundColor: p.primary },
  tabLabelRow: { flexDirection: 'row' as const, alignItems: 'center' as const, gap: 5 },
  tabSegText: { fontSize: 13, color: p.textSecondary, fontWeight: '500' as const },
  tabSegTextActive: { color: p.textInverse, fontWeight: '600' as const },
  unreadDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: colors.warning[500],
  },

  listContent: { paddingHorizontal: 6, paddingVertical: spacing[3] },
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing[6] },

  // Boutique chat
  dateSep: { alignItems: 'center', marginVertical: 12 },
  dateSepText: { color: p.textSecondary },

  rowOther: { flexDirection: 'row', alignItems: 'flex-end', paddingLeft: 2 },
  rowOwn:   { flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'flex-end', paddingRight: 4 },

  // Avatar
  avatarCol: { width: 36, alignItems: 'center', justifyContent: 'flex-end' },
  avatar: { width: 28, height: 28, borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
  avatarText: { fontSize: 12, fontWeight: '700' as const, color: '#fff' },
  avatarSpacer: { width: 28 },

  senderName: { fontSize: 12, fontWeight: '700' as const, marginBottom: 3 },

  // Bubble
  bubble: { borderRadius: 16, paddingVertical: 8, paddingHorizontal: 10, marginHorizontal: 4 },
  bubbleOwn: { backgroundColor: p.primary, maxWidth: '72%' },
  bubbleOther: {
    backgroundColor: p.surface,
    borderWidth: 1,
    borderColor: p.border,
    maxWidth: '82%',
  },
  bubbleText:    { fontSize: 15, lineHeight: 21, color: p.textPrimary },
  bubbleTextOwn: { color: '#fff' },

  // Timestamp inside bubble
  bubbleMeta: { flexDirection: 'row' as const, justifyContent: 'flex-end' as const, marginTop: 4, gap: 2 },
  ts:      { fontSize: 11 },
  tsOther: { color: p.textSecondary },
  tsOwn:   { color: 'rgba(255,255,255,0.7)' },
  receipt:     { fontSize: 11, color: 'rgba(255,255,255,0.7)' },
  receiptRead: { color: '#fff', fontWeight: '600' as const },

  // Reply pill inside bubble
  replyPill: {
    flexDirection: 'row' as const,
    borderRadius: 8,
    marginBottom: 6,
    overflow: 'hidden' as const,
    minWidth: 180,
  },
  replyPillOwn:   { backgroundColor: 'rgba(255,255,255,0.15)' },
  replyPillOther: { backgroundColor: p.border },
  replyAccent: { width: 4 },
  replyPillContent: { flex: 1, paddingVertical: 4, paddingHorizontal: 8 },
  replyPillName: { fontSize: 12, fontWeight: '700' as const, marginBottom: 1 },
  replyPillNameOwn: { color: 'rgba(255,255,255,0.9)' },
  replyPillText: { fontSize: 12, color: p.textSecondary },
  replyPillTextOwn: { color: 'rgba(255,255,255,0.7)' },

  // Docked edit preview above input
  editDock: {
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    paddingHorizontal: spacing[4],
    paddingVertical: spacing[2],
    backgroundColor: `${p.primary}0C`,
    borderTopWidth: 1,
    borderTopColor: `${p.primary}40`,
    gap: spacing[2],
  },
  editDockLabel: { fontSize: 12, fontWeight: '700' as const, color: p.primary },

  // Docked reply preview above input
  replyDock: {
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    paddingHorizontal: spacing[4],
    paddingVertical: spacing[2],
    backgroundColor: p.surface,
    borderTopWidth: 1,
    borderTopColor: p.border,
    gap: spacing[2],
  },
  replyDockAccent: { width: 3, height: 36, borderRadius: 2 },
  replyDockBody: { flex: 1 },
  replyDockName: { fontSize: 12, fontWeight: '700' as const },
  replyDockText: { fontSize: 13, color: p.textSecondary },

  // Swipe-to-reply icon
  swipeIcon: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: `${p.primary}18`,
    alignItems: 'center' as const,
    justifyContent: 'center' as const,
    marginRight: 4,
  },

  errorStrip: {
    paddingHorizontal: spacing[4],
    paddingVertical: spacing[2],
    backgroundColor: p.warningLight,
  },

  readOnlyBar: {
    paddingHorizontal: spacing[5],
    paddingVertical: spacing[4],
    borderTopWidth: 1,
    borderTopColor: p.border,
    backgroundColor: p.surface,
  },
  minimalUnlockBanner: {
    borderTopWidth: 1,
    borderTopColor: p.border,
    backgroundColor: p.surface,
    paddingHorizontal: spacing[5],
    paddingVertical: 14,
    alignItems: 'center' as const,
  },
  minimalUnlockText: {
    fontSize: 13,
    color: p.textSecondary,
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
    borderTopColor: p.border,
    backgroundColor: p.surface,
  },
  input: {
    flex: 1,
    minHeight: 40,
    maxHeight: 120,
    borderWidth: 1,
    borderColor: p.border,
    borderRadius: radius.lg,
    paddingHorizontal: spacing[3],
    paddingVertical: spacing[2],
    fontSize: 15,
    color: p.textPrimary,
    backgroundColor: p.background,
  },
  sendBtn: {
    width: 40, height: 40,
    borderRadius: radius.full,
    backgroundColor: p.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },

  // Forum: category filter wrapper
  catScrollWrap: {
    height: 48,
    justifyContent: 'center' as const,
    backgroundColor: p.background,
    borderBottomWidth: 1,
    borderBottomColor: p.border,
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
    borderColor: p.border,
    backgroundColor: p.surface,
  },
  catChipActive: { backgroundColor: p.primary, borderColor: p.primary },

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

  // Forum: flat surface — hairline separator, no card chrome
  pcCard: {
    backgroundColor: p.background,
    paddingHorizontal: spacing[5],
    paddingTop: spacing[4],
    paddingBottom: spacing[3],
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: p.border,
  },
  pcTopRow: {
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    gap: 8,
  },
  pcAvatar: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center' as const,
    justifyContent: 'center' as const,
    flexShrink: 0,
  },
  pcAvatarText: { fontSize: 14, fontWeight: '700' as const, color: '#fff' },
  pcAuthorInfo: { flex: 1, minWidth: 0 },
  pcAuthorName: { fontSize: 14, fontWeight: '600' as const, color: p.textPrimary },
  pcMeta: { flexDirection: 'row' as const, alignItems: 'center' as const, gap: 4, marginTop: 1, flexWrap: 'wrap' as const },
  pcMetaDot: { fontSize: 11, color: p.textSecondary },
  pcTimestamp: { fontSize: 11, color: p.textSecondary },
  pcTitle: { fontFamily: FF.bold, fontSize: 15, color: p.textPrimary, marginTop: 8 },
  pcExcerpt: { fontSize: 13, color: p.textSecondary, lineHeight: 18, marginTop: 2, marginBottom: 8 },
  pcFooter: {
    flexDirection: 'row' as const,
    justifyContent: 'flex-start' as const,
    alignItems: 'center' as const,
    gap: 16,
  },
  pcStatRow: { flexDirection: 'row' as const, alignItems: 'center' as const, gap: 6 },
  pcStat: { fontSize: 13, color: p.textSecondary, fontWeight: '500' as const },
  pcStatLiked: { color: p.primary },
  pcActionVerified: { fontSize: 13, color: p.primary, fontWeight: '600' as const },
  pcActionSave: { fontSize: 13, color: p.textSecondary, fontWeight: '500' as const },
  marketListContent: { paddingBottom: spacing[6] },

  // Forum: new post button
  newPostBtn: {
    margin: spacing[4],
    borderRadius: radius.md,
    backgroundColor: p.primary,
    paddingVertical: spacing[3],
    alignItems: 'center',
  },
  newPostBtnText: { color: p.textInverse, fontWeight: '600', fontSize: 15 },

  // Modal
  modalSafe: { flex: 1, backgroundColor: p.background },
  modalHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: spacing[5],
    borderBottomWidth: 1,
    borderBottomColor: p.border,
  },
  modalContent: { padding: spacing[5], gap: spacing[3] },
  composerCard: {
    borderWidth: 1,
    borderColor: p.border,
    borderRadius: radius.lg,
    backgroundColor: p.surface,
    overflow: 'hidden',
  },
  composerTitle: {
    paddingHorizontal: spacing[4],
    paddingTop: spacing[4],
    paddingBottom: spacing[3],
    fontSize: 18,
    fontWeight: '600',
    color: p.textPrimary,
  },
  composerDivider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: p.border,
    marginHorizontal: spacing[4],
  },
  composerBody: {
    paddingHorizontal: spacing[4],
    paddingTop: spacing[3],
    paddingBottom: spacing[4],
    fontSize: 15,
    color: p.textPrimary,
    minHeight: 180,
  },
  charCount: { textAlign: 'right', paddingHorizontal: spacing[4], paddingBottom: spacing[2] },
  composerBottom: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingRight: spacing[4] },
  composerCatRow: { flexDirection: 'row', gap: spacing[2], paddingHorizontal: spacing[4], paddingVertical: spacing[3] },
  composerError: { color: p.warning, flexShrink: 1, textAlign: 'right', paddingLeft: spacing[2] },
  modalCatChip: {
    paddingHorizontal: spacing[3],
    paddingVertical: spacing[1.5],
    borderRadius: radius.full,
    borderWidth: 1,
    borderColor: p.border,
    backgroundColor: p.surface,
  },
  modalCatChipActive: { backgroundColor: p.primary, borderColor: p.primary },
  });
}
