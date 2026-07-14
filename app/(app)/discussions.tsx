import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Animated as RNAnimated,
  FlatList,
  Keyboard,
  KeyboardAvoidingView,
  Linking,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  Share,
  StyleSheet,
  TextInput,
  useWindowDimensions,
  View,
} from 'react-native';
import type { Audio } from 'expo-av';
import * as ImagePicker from 'expo-image-picker';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withSpring,
  withTiming,
  runOnJS,
} from 'react-native-reanimated';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { Screen } from '@/src/components/ui/Screen';
import { router, useFocusEffect } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { Text } from '@/src/components/ui/Text';
import { VoiceMessageBubble, LiveWaveformBars } from '@/src/components/ui/VoiceMessageBubble';
import { ImageMessageBubble } from '@/src/components/ui/ImageMessageBubble';
import { haptics } from '@/lib/haptics';
import { useTheme, fontFamily as FF, radius, spacing, AVATAR_PALETTE } from '@/src/theme';
import type { Palette } from '@/src/theme';
import {
  isSep, buildGroupedItems, bubbleMargins, bubbleRadius, showsMeta,
} from '@/src/lib/chatGrouping';
import type { GroupPos, GroupedItem } from '@/src/lib/chatGrouping';
import { useAuthStore } from '@/stores/auth';
import { useChatStore } from '@/stores/chat';
import { useMarketStore } from '@/stores/market';
import { usePartnershipsStore } from '@/stores/partnerships';
import { useEquipeStore } from '@/stores/equipe';
import { SkeletonList } from '@/src/components/ui/SkeletonPlaceholder';
import { supabase } from '@/lib/supabase';
import { generateFallbackName } from '@/lib/id';
import type { ChatMessage, MarketPost, MarketCategory } from '@/src/types';

// expo-av's native module only exists once the app has been rebuilt with this
// dependency linked in — requiring it eagerly would crash older binaries that
// receive this code via an OTA update. Load it lazily so they degrade silently.
function getAudio(): typeof Audio | null {
  try {
    return require('expo-av').Audio;
  } catch {
    return null;
  }
}

// ─── Forum constants ──────────────────────────────────────────────────────────

const MARKET_CATS: MarketCategory[] = ['suggestion', 'entraide', 'general'];

const CAT_LABEL: Record<string, string> = {
  tout: 'Tout',
  suggestion: 'Suggestion',
  entraide: 'Entraide',
  general: 'Général',
  annonce: 'Annonce',
};
function catBg(category: string, p: Palette): string {
  const map: Record<string, string> = { suggestion: p.primaryLight, entraide: p.successLight, general: p.surface, annonce: p.warningLight };
  return map[category] ?? p.surface;
}
function catFg(category: string, p: Palette): string {
  const map: Record<string, string> = { suggestion: p.primaryDark, entraide: p.success, general: p.textSecondary, annonce: p.warning };
  return map[category] ?? p.textSecondary;
}

// ─── Types ────────────────────────────────────────────────────────────────────

type Tab = 'boutique' | 'amis' | 'marche';

type ChatBubbleItem = ChatMessage & { _pos: GroupPos };
type ListItem = GroupedItem<ChatMessage>;

// ─── Date helpers ─────────────────────────────────────────────────────────────

const LOCALE = Intl.DateTimeFormat().resolvedOptions().locale;

// Relative time for forum post cards (device-locale calendar format).
function relativeTime(iso: string): string {
  const d      = new Date(iso);
  const diffMs = Date.now() - d.getTime();
  const diffM  = Math.floor(diffMs / 60_000);
  const diffH  = Math.floor(diffMs / 3_600_000);
  const diffD  = Math.floor(diffMs / 86_400_000);
  if (diffM < 1)  return 'maintenant';
  if (diffM < 60) return `${diffM}min`;
  if (diffH < 24) return `${diffH}h`;
  if (diffD <= 7) return `${diffD}j`;
  return new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'short' }).format(d);
}

// ─── Sender colour palette ────────────────────────────────────────────────────

function senderColor(senderId: string): string {
  let h = 0;
  for (let i = 0; i < senderId.length; i++) h = (h * 31 + senderId.charCodeAt(i)) & 0xFFFFFF;
  return AVATAR_PALETTE[Math.abs(h) % AVATAR_PALETTE.length];
}

// ─── MessageBubble ────────────────────────────────────────────────────────────

const SWIPE_THRESHOLD = 52;

function MessageBubble({
  msg, isOwn, pos, isRead, onReply, onEdit, onScrollToReply, isHighlighted, displayedName,
}: {
  msg: ChatMessage;
  isOwn: boolean;
  pos: GroupPos;
  isRead: boolean | null;
  onReply: () => void;
  onEdit: (() => void) | null;
  onScrollToReply?: () => void;
  isHighlighted?: boolean;
  displayedName?: string;
}) {
  const { palette } = useTheme();
  const styles = useMemo(() => makeStyles(palette), [palette]);
  const time       = new Date(msg.created_at).toLocaleTimeString(LOCALE, { hour: '2-digit', minute: '2-digit' });
  const br         = bubbleRadius(isOwn, pos);
  const margins    = bubbleMargins(pos);
  const showAvatar = !isOwn && (pos === 'standalone' || pos === 'last');
  const showName   = !isOwn && (pos === 'standalone' || pos === 'first');
  // One timestamp per cluster, not one per bubble — shown only on the last
  // (visually bottommost) message of a group, same place WhatsApp/iMessage put it.
  const showMeta   = showsMeta(pos);
  const name       = displayedName || msg.sender_name || generateFallbackName(msg.sender_id);
  const initial    = name.charAt(0).toUpperCase();
  const color      = senderColor(msg.sender_id);
  const isImage    = msg.message_type === 'image' && !!msg.image_url;

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

  // Double-tap the bubble to edit (own text messages, within the 15-minute window).
  // Raced against `pan` so a horizontal swipe still wins for the reply gesture.
  const doubleTap = Gesture.Tap()
    .enabled(!!onEdit)
    .numberOfTaps(2)
    .maxDuration(250)
    .onEnd(() => {
      if (!onEdit) return;
      runOnJS(onEdit)();
      runOnJS(haptics.tap)();
    });

  const bubbleGesture = Gesture.Race(pan, doubleTap);

  const slideAnim = useAnimatedStyle(() => ({
    transform: [{ translateX: translateX.value }],
  }));

  const iconAnim = useAnimatedStyle(() => ({
    opacity: Math.min(translateX.value / (SWIPE_THRESHOLD * 0.7), 1),
    transform: [{ scale: 0.5 + Math.min(translateX.value / SWIPE_THRESHOLD, 1) * 0.5 }],
  }));

  return (
    // Outer detector: swipe-to-reply raced against double-tap-to-edit
    <GestureDetector gesture={bubbleGesture}>
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

          {/* Bubble — double-tap to edit (own messages, within the 15-minute window) */}
          <View style={[
            styles.bubble,
            isImage ? (isOwn ? styles.bubbleImageOwn : styles.bubbleImageOther) : (isOwn ? styles.bubbleOwn : styles.bubbleOther),
            isImage && styles.bubbleImage,
            br,
            isHighlighted && styles.bubbleHighlighted,
          ]}>
            {showName && (
              <Text style={[styles.senderName, { color }, isImage && styles.imageHeaderPad]}>{name}</Text>
            )}

            {msg.reply_to_id ? (
              <Pressable
                onPress={onScrollToReply}
                style={({ pressed }) => [
                  styles.replyPill,
                  isOwn ? styles.replyPillOwn : styles.replyPillOther,
                  isImage && !showName && styles.imageReplyPad,
                  pressed && { opacity: 0.65 },
                ]}
              >
                <View style={[styles.replyAccent, { backgroundColor: isOwn ? 'rgba(255,255,255,0.6)' : color }]} />
                <View style={styles.replyPillContent}>
                  <Text style={[styles.replyPillName, isOwn ? styles.replyPillNameOwn : { color }]} numberOfLines={1}>
                    {msg.reply_to_sender_name || '—'}
                  </Text>
                  <Text style={[styles.replyPillText, isOwn && styles.replyPillTextOwn]} numberOfLines={2}>
                    {msg.reply_to_content}
                  </Text>
                </View>
              </Pressable>
            ) : null}

            {msg.message_type === 'voice' ? (
              <>
                <VoiceMessageBubble msg={msg} isOwn={isOwn} />
                {showMeta && (
                  <View style={styles.bubbleMeta}>
                    {msg.edited_at ? (
                      <Text style={[styles.ts, isOwn ? styles.tsOwn : styles.tsOther]}>modifié · </Text>
                    ) : null}
                    <Text style={[styles.ts, isOwn ? styles.tsOwn : styles.tsOther]}>{time}</Text>
                  </View>
                )}
              </>
            ) : isImage ? (
              <>
                {/* Sent "naked" — no padded/colored canvas, corners match the bubble group shape */}
                <ImageMessageBubble msg={msg} imageStyle={br} />
                {(!!msg.content || showMeta) && (
                  <View style={styles.imageCaptionWrap}>
                    {!!msg.content && (
                      <Text style={[styles.bubbleText, isOwn && styles.bubbleTextOwn]}>
                        {msg.content}
                      </Text>
                    )}
                    {showMeta && (
                      <View style={[styles.bubbleMeta, !msg.content && { marginTop: 0 }]}>
                        <Text style={[styles.ts, isOwn ? styles.tsOwn : styles.tsOther]}>{time}</Text>
                      </View>
                    )}
                  </View>
                )}
              </>
            ) : (
              <>
                <Text style={[styles.bubbleText, isOwn && styles.bubbleTextOwn]}>
                  {msg.content}
                </Text>
                {showMeta && (
                  <View style={styles.bubbleMeta}>
                    {msg.edited_at ? (
                      <Text style={[styles.ts, isOwn ? styles.tsOwn : styles.tsOther]}>modifié · </Text>
                    ) : null}
                    <Text style={[styles.ts, isOwn ? styles.tsOwn : styles.tsOther]}>{time}</Text>
                    {isOwn && isRead !== null && (
                      <Text style={[styles.receipt, isRead && styles.receiptRead]}>
                        {isRead ? ' ✓✓' : ' ✓'}
                      </Text>
                    )}
                  </View>
                )}
              </>
            )}
          </View>

        </Animated.View>
      </View>
    </GestureDetector>
  );
}

// ─── PostCard ─────────────────────────────────────────────────────────────────

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
            <View style={[styles.catBadge, { backgroundColor: catBg(post.category, palette) }]}>
              <Text style={[styles.catBadgeText, { color: catFg(post.category, palette) }]}>
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
          <Ionicons name="arrow-undo-outline" size={17} color={palette.primary} />
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
  const { width: screenWidth } = useWindowDimensions();
  const session     = useAuthStore(s => s.session);
  const businessId   = session?.activeBusiness?.id ?? '';
  const userId       = session?.user.id ?? '';
  const userName     = session?.user.name || generateFallbackName(userId);
  const businessName = session?.activeBusiness?.name ?? '';
  const role         = session?.activeMembership?.role;
  const isAdminOrManager = role === 'administrateur' || role === 'manager';
  const membres     = useEquipeStore(s => s.membres);

  // ─── Chat store (Ma Boutique — untouched) ─────────────────────────────────
  const {
    boutiqueRoom, globalRoom, messages,
    loading, sending, error,
    boutiqueUnread,
    offline: chatOffline,
    load, sendMessage, sendVoiceMessage, sendImageMessage, editMessage, appendMessage, updateMessage, markRead,
  } = useChatStore();

  // ─── Partnerships store (Amis tab) ─────────────────────────────────────────
  const {
    partners, pending: partnerPending,
    loading: partnersLoading, error: partnersError,
    inviteCode, inviteCodeLoading,
    offline: partnersOffline,
    loadPartnerships, loadInviteCode, regenerateInviteCode,
    sendPartnerRequest, acceptRequest, declineRequest,
  } = usePartnershipsStore();

  // ─── Market store (Le Marché forum — independent) ─────────────────────────
  const {
    posts, loading: marketLoading, creating, error: marketError,
    fetchPosts, createPost, prependPost, markVisited,
    likedPostIds, lastVisitedAt, toggleLike,
    userLevel, offline: marketOffline,
  } = useMarketStore();

  // ─── Shared state ─────────────────────────────────────────────────────────
  const [activeTab, setActiveTab] = useState<Tab>('boutique');

  // ─── Boutique state ───────────────────────────────────────────────────────
  const [text, setText] = useState('');
  const [replyingTo, setReplyingTo] = useState<ChatMessage | null>(null);
  const [editingMsg, setEditingMsg] = useState<ChatMessage | null>(null);
  const [partnerLastRead, setPartnerLastRead] = useState<Date | null>(null);
  const [highlightedMsgId, setHighlightedMsgId] = useState<string | null>(null);
  const [keyboardVisible, setKeyboardVisible] = useState(false);
  const boutiqueFlatListRef = useRef<FlatList<ListItem>>(null);
  const boutiqueChannelRef = useRef<ReturnType<typeof supabase.channel> | null>(null);
  const marcheChannelRef   = useRef<ReturnType<typeof supabase.channel> | null>(null);

  // ─── Voice recording state ────────────────────────────────────────────────
  const [isRecording, setIsRecording]       = useState(false);
  const [recDuration, setRecDuration]       = useState(0); // seconds
  const [recAmplitudes, setRecAmplitudes]   = useState<number[]>([]);
  const recordingRef   = useRef<Audio.Recording | null>(null);
  const recTimerRef    = useRef<ReturnType<typeof setInterval> | null>(null);
  const pulseAnim      = useRef(new RNAnimated.Value(1)).current;

  // Pulsing red dot animation while recording
  useEffect(() => {
    if (!isRecording) { pulseAnim.setValue(1); return; }
    const loop = RNAnimated.loop(
      RNAnimated.sequence([
        RNAnimated.timing(pulseAnim, { toValue: 0.3, duration: 600, useNativeDriver: true }),
        RNAnimated.timing(pulseAnim, { toValue: 1,   duration: 600, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [isRecording]);

  // ─── Forum state ──────────────────────────────────────────────────────────
  const [selectedCat, setSelectedCat] = useState<'tout' | MarketCategory>('tout');
  const [showNewPost, setShowNewPost] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [newContent, setNewContent] = useState('');
  const [newCategory, setNewCategory] = useState<MarketCategory | null>(null);
  const [postError, setPostError] = useState('');
  const marketChannelRef = useRef<ReturnType<typeof supabase.channel> | null>(null);

  // ─── Amis state ───────────────────────────────────────────────────────────
  const [showAddPartner, setShowAddPartner] = useState(false);
  const [partnerCodeInput, setPartnerCodeInput] = useState('');
  const [addPartnerLoading, setAddPartnerLoading] = useState(false);
  const [addPartnerError, setAddPartnerError] = useState('');
  const [addPartnerSuccess, setAddPartnerSuccess] = useState('');

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

  // ─── Load partnerships + invite code when amis tab becomes active ──────────
  useEffect(() => {
    if (activeTab !== 'amis' || !businessId || !userId || !isAdminOrManager) return;
    loadPartnerships(businessId, userId);
    loadInviteCode(businessId);
  }, [activeTab, businessId, userId, isAdminOrManager]);

  // ─── Mark chat read when rooms load ──────────────────────────────────────
  useEffect(() => {
    if (!boutiqueRoom || !globalRoom || !businessId) return;
    if (activeTab === 'boutique' || activeTab === 'marche') markRead(activeTab, businessId);
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
    if (businessId && (tab === 'boutique' || tab === 'marche')) markRead(tab as 'boutique' | 'marche', businessId);
    contentAlpha.value = withTiming(1, { duration: 140 });
  }, [businessId]);

  const handleTabChange = useCallback((tab: Tab) => {
    contentAlpha.value = withTiming(0, { duration: 80 }, (finished) => {
      if (finished) runOnJS(switchTabAndFadeIn)(tab);
    });
  }, [switchTabAndFadeIn]);

  const scrollToMessage = useCallback((msgId: string) => {
    const index = listItems.findIndex(item => !isSep(item) && item.id === msgId);
    if (index === -1) return;
    boutiqueFlatListRef.current?.scrollToIndex({ index, animated: true, viewPosition: 0.5 });
    setHighlightedMsgId(msgId);
    setTimeout(() => setHighlightedMsgId(null), 1500);
  }, [listItems]);

  const cancelEdit = () => {
    setEditingMsg(null);
    setText('');
  };

  // ─── Amis handlers ────────────────────────────────────────────────────────
  const handleShareMyCode = useCallback(async () => {
    const code = inviteCode?.code ?? '';
    if (!code) return;
    const msg = `Salut 👋 Je t'invite sur mon Patron.\n\nPour m'ajouter → ouvre Discussions, onglet Amis, puis le + en haut à droite. Entre ce code :\n\n${code}\n\n⏱ Il expire dans 24h.`;
    try {
      await Linking.openURL(`whatsapp://send?text=${encodeURIComponent(msg)}`);
    } catch {
      Share.share({ message: msg });
    }
  }, [inviteCode?.code]);

  const handleSendPartnerRequest = useCallback(async () => {
    if (!partnerCodeInput.trim()) return;
    setAddPartnerLoading(true);
    setAddPartnerError('');
    setAddPartnerSuccess('');
    try {
      const partnerName = await sendPartnerRequest(partnerCodeInput, businessId, businessName);
      setAddPartnerSuccess(`Demande envoyée à ${partnerName} !`);
      setPartnerCodeInput('');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Erreur lors de l\'envoi';
      setAddPartnerError(msg);
    } finally {
      setAddPartnerLoading(false);
    }
  }, [partnerCodeInput, businessId, businessName, sendPartnerRequest]);

  const handleAcceptRequest = useCallback(async (partnershipId: string, requesterBusinessId: string, requesterName: string) => {
    try {
      await acceptRequest(partnershipId, businessId, businessName, requesterBusinessId);
      await loadPartnerships(businessId, userId);
    } catch {
      // silent — user can retry
    }
  }, [businessId, businessName, userId, acceptRequest, loadPartnerships]);

  const handleDeclineRequest = useCallback(async (partnershipId: string) => {
    try {
      await declineRequest(partnershipId, businessId);
    } catch {
      // silent
    }
  }, [businessId, declineRequest]);

  const startRecording = async () => {
    try {
      const A = getAudio();
      if (!A) return;

      const { granted } = await A.requestPermissionsAsync();
      if (!granted) return;

      await A.setAudioModeAsync({ allowsRecordingIOS: true, playsInSilentModeIOS: true });

      const rec = new A.Recording();
      await rec.prepareToRecordAsync({
        isMeteringEnabled: true,
        android: {
          extension: '.m4a',
          outputFormat: A.AndroidOutputFormat.MPEG_4,
          audioEncoder: A.AndroidAudioEncoder.AAC,
          sampleRate: 16000,   // voice range — enables codec-level voice filtering
          numberOfChannels: 1,
          bitRate: 32000,      // ample for speech; smaller file, faster upload
        },
        ios: {
          extension: '.m4a',
          outputFormat: A.IOSOutputFormat.MPEG4AAC,
          audioQuality: A.IOSAudioQuality.MEDIUM,
          sampleRate: 16000,
          numberOfChannels: 1,
          bitRate: 32000,
          linearPCMBitDepth: 16,
          linearPCMIsBigEndian: false,
          linearPCMIsFloat: false,
        },
        web: {},
      });

      // Sample amplitude every 100ms for waveform
      rec.setOnRecordingStatusUpdate(status => {
        if (status.isRecording && status.metering !== undefined) {
          // Map -50 dB (floor) → 0 dB (max) to 0–1, then compress with power curve
          // so normal speech (~-20 dB) sits at ~45% height instead of 80%
          const raw = Math.max(0, Math.min(1, (status.metering + 50) / 50));
          const amp = Math.pow(raw, 1.5);
          setRecAmplitudes(prev => [...prev, amp]);
        }
      });
      await rec.setProgressUpdateInterval(100);
      await rec.startAsync();

      recordingRef.current = rec;
      setIsRecording(true);
      setRecDuration(0);
      setRecAmplitudes([]);

      // Tick every second for the timer display
      recTimerRef.current = setInterval(() => setRecDuration(d => d + 1), 1000);
      haptics.tap();
    } catch {
      // Permission denied or device error — silent
    }
  };

  const stopRecording = async (send: boolean) => {
    if (recTimerRef.current) { clearInterval(recTimerRef.current); recTimerRef.current = null; }
    const rec = recordingRef.current;
    recordingRef.current = null;

    if (!rec) { setIsRecording(false); return; }

    try {
      await rec.stopAndUnloadAsync();
    } catch { /* already stopped */ }

    await getAudio()?.setAudioModeAsync({ allowsRecordingIOS: false, playsInSilentModeIOS: true });

    const finalDuration = recDuration;
    const finalAmplitudes = recAmplitudes;
    setIsRecording(false);
    setRecDuration(0);
    setRecAmplitudes([]);

    if (!send || finalDuration < 1 || !boutiqueRoom?.id) return;

    const uri = rec.getURI();
    if (!uri) return;

    haptics.success();
    await sendVoiceMessage({
      roomId:     boutiqueRoom.id,
      senderId:   userId,
      senderName: userName,
      businessId,
      fileUri:    uri,
      duration:   finalDuration,
      waveform:   finalAmplitudes,
    });
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

  const handlePickImage = async () => {
    if (!boutiqueRoom?.id) return;
    const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (status !== 'granted') return;
    const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 1 });
    if (result.canceled || !result.assets?.[0]) return;
    const asset = result.assets[0];
    haptics.success();
    await sendImageMessage({
      roomId: boutiqueRoom.id,
      senderId: userId,
      senderName: userName,
      fileUri: asset.uri,
      sourceWidth: asset.width,
      sourceHeight: asset.height,
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

  if (session?.isDemoMode) {
    return (
      <Screen style={{ justifyContent: 'center', alignItems: 'center', gap: spacing[4], paddingHorizontal: spacing[8] }}>
        <Text style={{ fontSize: 36 }}>💬</Text>
        <Text variant="h3" style={{ textAlign: 'center' }}>Les discussions sont réservées aux vrais commerces</Text>
        <Text variant="body" color="secondary" style={{ textAlign: 'center', lineHeight: 22 }}>
          Créez votre commerce gratuitement pour discuter avec votre équipe et rejoindre la communauté Patron.
        </Text>
        <Pressable
          onPress={() => router.push('/(welcome)/creer')}
          style={{ backgroundColor: palette.primary, borderRadius: 14, paddingVertical: spacing[4], paddingHorizontal: spacing[8], marginTop: spacing[2] }}
        >
          <Text style={{ color: palette.textInverse, fontWeight: '700', fontSize: 16 }}>Sauvegarder ma boutique →</Text>
        </Pressable>
        <Pressable onPress={() => router.back()}>
          <Text variant="bodySmall" color="secondary">Retour</Text>
        </Pressable>
      </Screen>
    );
  }

  return (
    <KeyboardAvoidingView
      style={{ flex: 1, backgroundColor: palette.background }}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
    >
    <Screen edges={['top']}>

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
          {isAdminOrManager && (
            <Pressable
              onPress={() => handleTabChange('amis')}
              style={[styles.tabSeg, activeTab === 'amis' && styles.tabSegActive]}
            >
              <View style={styles.tabLabelRow}>
                <Text style={[styles.tabSegText, activeTab === 'amis' && styles.tabSegTextActive]}>
                  Amis
                </Text>
                {partners.some(p => p.unread_count > 0) && <View style={styles.unreadDot} />}
              </View>
            </Pressable>
          )}
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
      {activeTab === 'marche' && marketOffline && (
        <View style={{ paddingHorizontal: spacing[4], paddingTop: spacing[1] }}>
          <Text variant="caption" color="secondary">Hors ligne — dernières données connues</Text>
        </View>
      )}

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
          {canPost && (
            <Pressable
              onPress={() => setShowNewPost(true)}
              style={({ pressed }) => [styles.composeBtn, pressed && { opacity: 0.65 }]}
            >
              <Ionicons name="create-outline" size={20} color={palette.primary} />
            </Pressable>
          )}
        </View>
      )}

        {activeTab === 'boutique' ? (
          /* ── Ma Boutique ── */
          <>
            {chatOffline && (
              <View style={{ paddingHorizontal: spacing[4], paddingTop: spacing[1] }}>
                <Text variant="caption" color="secondary">Hors ligne — dernières données connues</Text>
              </View>
            )}
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
                ref={boutiqueFlatListRef}
                onScrollToIndexFailed={() => {}}
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

                  // Editable if own text message sent within the last 15 minutes (WhatsApp rule)
                  // Voice notes are never editable — there's no content to change
                  const canEdit = isOwn &&
                    msg.message_type !== 'voice' &&
                    Date.now() - new Date(msg.created_at).getTime() < 15 * 60 * 1000;

                  const senderMembre = membres.find(mb => mb.user_id === msg.sender_id);
                  return (
                    <MessageBubble
                      msg={msg}
                      isOwn={isOwn}
                      pos={msg._pos}
                      isRead={isRead}
                      isHighlighted={msg.id === highlightedMsgId}
                      displayedName={senderMembre?.display_name ?? undefined}
                      onReply={() => setReplyingTo(msg)}
                      onScrollToReply={msg.reply_to_id ? () => scrollToMessage(msg.reply_to_id!) : undefined}
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

            {isRecording ? (
              /* ── Recording UI ── */
              <View style={[styles.inputRow, styles.recordingRow, { paddingBottom: keyboardVisible ? spacing[3] : Math.max(insets.bottom, spacing[3]) }]}>
                {/* Cancel */}
                <Pressable onPress={() => stopRecording(false)} hitSlop={10}>
                  <Ionicons name="trash-outline" size={22} color={palette.warning} />
                </Pressable>

                {/* Breathing dot + timer + live waveform — amber, not red: recording isn't an alarm */}
                <RNAnimated.View style={{ opacity: pulseAnim, width: 8, height: 8, borderRadius: 4, backgroundColor: palette.warning }} />
                <Text style={[styles.recTimer, { color: palette.textPrimary }]}>
                  {Math.floor(recDuration / 60)}:{String(recDuration % 60).padStart(2, '0')}
                </Text>
                <View style={{ flex: 1 }}>
                  <LiveWaveformBars samples={recAmplitudes} />
                </View>

                {/* Send */}
                <Pressable
                  onPress={() => stopRecording(true)}
                  style={[styles.sendBtn, { backgroundColor: palette.success }]}
                >
                  <Ionicons name="checkmark" size={20} color={palette.textInverse} />
                </Pressable>
              </View>
            ) : (
              /* ── Normal input row ── */
              <View style={[styles.inputRow, { paddingBottom: keyboardVisible ? spacing[3] : Math.max(insets.bottom, spacing[3]) }]}>
                {!editingMsg && (
                  <Pressable onPress={handlePickImage} hitSlop={10} style={({ pressed }) => [styles.imgBtn, pressed && { opacity: 0.75 }]}>
                    <Ionicons name="image-outline" size={22} color={palette.primary} />
                  </Pressable>
                )}
                <TextInput
                  style={styles.input}
                  value={text}
                  onChangeText={setText}
                  autoFocus
                  multiline
                  maxLength={1000}
                  returnKeyType="default"
                />
                {(!!text.trim() || !!editingMsg) ? (
                  <Pressable
                    onPress={handleSend}
                    disabled={sending}
                    style={({ pressed }) => [styles.sendBtn, pressed && { opacity: 0.75 }]}
                  >
                    <Ionicons name={editingMsg ? 'checkmark' : 'arrow-forward'} size={20} color={palette.textInverse} />
                  </Pressable>
                ) : (
                  /* Mic button — only when nothing typed */
                  <Pressable
                    onPress={startRecording}
                    style={({ pressed }) => [styles.sendBtn, styles.micBtn, pressed && { opacity: 0.75 }]}
                  >
                    <Ionicons name="mic-outline" size={20} color={palette.primary} />
                  </Pressable>
                )}
              </View>
            )}
          </>
        ) : activeTab === 'amis' ? (
          /* ── Amis ── */
          <>
            {partnersOffline && (
              <View style={{ paddingHorizontal: spacing[4], paddingTop: spacing[1] }}>
                <Text variant="caption" color="secondary">Hors ligne — dernières données connues</Text>
              </View>
            )}
            {/* Minimal toolbar: add partner only */}
            <View style={styles.amisHeader}>
              <View style={styles.amisIconBtn} />
              <View style={{ flex: 1 }} />
              <Pressable
                onPress={() => { setShowAddPartner(true); setAddPartnerError(''); setAddPartnerSuccess(''); }}
                style={styles.amisIconBtn}
                hitSlop={8}
              >
                <Ionicons name="person-add-outline" size={22} color={palette.primary} />
              </Pressable>
            </View>

            {partnersLoading && partners.length === 0 && partnerPending.length === 0 ? (
              <View style={styles.empty}>
                <Text variant="body" color="secondary">Chargement…</Text>
              </View>
            ) : partners.length === 0 && partnerPending.length === 0 ? (
              /* ── Empty: code is the hero ── */
              <View style={{ flex: 1 }}>
                {/* Optical center: 38% from top */}
                <View style={{ flex: 38 }} />
                <View style={styles.amisInviteState}>
                  <Text style={[styles.amisCodeLabel, { color: palette.textSecondary }]}>Mon code</Text>
                  <Text
                    style={[styles.amisCodeValue, {
                      color: palette.textPrimary,
                      width: screenWidth - spacing[5] * 4,
                    }]}
                    adjustsFontSizeToFit
                    minimumFontScale={0.4}
                    numberOfLines={1}
                  >
                    {inviteCodeLoading ? '…' : (inviteCode?.code ? '* * * * * * * *' : '…')}
                  </Text>
                  <Text style={[styles.amisCodeMeta, { color: palette.textSecondary }]}>
                    24h · usage unique
                  </Text>

                  <Pressable
                    onPress={handleShareMyCode}
                    disabled={!inviteCode?.code || inviteCodeLoading}
                    style={({ pressed }) => [
                      styles.amisShareBtn,
                      (!inviteCode?.code || inviteCodeLoading) && { opacity: 0.4 },
                      pressed && { opacity: 0.7 },
                    ]}
                  >
                    <Ionicons name="logo-whatsapp" size={18} color={palette.textInverse} />
                    <Text style={{ color: palette.textInverse, fontWeight: '600', fontSize: 16 }}>Partager</Text>
                  </Pressable>

                  <Pressable
                    onPress={() => regenerateInviteCode(businessId)}
                    disabled={inviteCodeLoading}
                    hitSlop={12}
                  >
                    <Text style={[styles.amisRenewLink, { color: palette.textSecondary }]}>
                      Renouveler le code
                    </Text>
                  </Pressable>
                </View>
                <View style={{ flex: 62 }} />
              </View>
            ) : (
              /* ── Has partners ── */
              <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingBottom: 32 }}>
                {partnerPending.length > 0 && (
                  <>
                    <Text variant="caption" color="secondary" style={styles.amisSectionLabel}>
                      Demandes reçues
                    </Text>
                    {partnerPending.map(req => (
                      <View key={req.id} style={styles.amisRequestRow}>
                        <View style={[styles.amisAvatar, { backgroundColor: `${palette.primary}22` }]}>
                          <Text style={[styles.amisAvatarText, { color: palette.primary }]}>
                            {req.requester_business_name.charAt(0).toUpperCase()}
                          </Text>
                        </View>
                        <View style={{ flex: 1 }}>
                          <Text variant="body" style={{ fontWeight: '600' }}>{req.requester_business_name}</Text>
                          <Text variant="caption" color="secondary">Demande de connexion</Text>
                        </View>
                        <View style={styles.amisRequestBtns}>
                          <Pressable
                            onPress={() => handleAcceptRequest(req.id, req.requester_business_id, req.requester_business_name)}
                            style={({ pressed }) => [styles.amisAcceptBtn, pressed && { opacity: 0.75 }]}
                          >
                            <Text variant="caption" style={{ color: palette.textInverse, fontWeight: '600' }}>Accepter</Text>
                          </Pressable>
                          <Pressable
                            onPress={() => handleDeclineRequest(req.id)}
                            style={({ pressed }) => [styles.amisDeclineBtn, pressed && { opacity: 0.6 }]}
                          >
                            <Text variant="caption" color="secondary">Refuser</Text>
                          </Pressable>
                        </View>
                      </View>
                    ))}
                  </>
                )}

                {partners.length > 0 && (
                  <>
                    {partnerPending.length > 0 && (
                      <Text variant="caption" color="secondary" style={styles.amisSectionLabel}>
                        Mes amis
                      </Text>
                    )}
                    {partners.map(p => (
                      <Pressable
                        key={p.partnership_id}
                        style={({ pressed }) => [styles.amisPartnerRow, pressed && { opacity: 0.7 }]}
                        onPress={async () => {
                          try {
                            const { getOrCreateDmRoom } = usePartnershipsStore.getState();
                            const roomId = await getOrCreateDmRoom(p.partnership_id, businessId);
                            router.push(`/(app)/messages/${roomId}?partnership_id=${p.partnership_id}`);
                          } catch { /* silent */ }
                        }}
                      >
                        <View style={[styles.amisAvatar, { backgroundColor: `${palette.primary}22` }]}>
                          <Text style={[styles.amisAvatarText, { color: palette.primary }]}>
                            {p.display_name.charAt(0).toUpperCase()}
                          </Text>
                        </View>
                        <View style={{ flex: 1, minWidth: 0 }}>
                          <Text variant="body" style={{ fontWeight: '600' }} numberOfLines={1}>{p.display_name}</Text>
                          <Text variant="caption" color="secondary" numberOfLines={1}>
                            {p.last_message ?? 'Appuyez pour écrire'}
                          </Text>
                        </View>
                        <View style={{ alignItems: 'flex-end', gap: 4 }}>
                          {p.last_message_at && (
                            <Text variant="caption" color="secondary">{relativeTime(p.last_message_at)}</Text>
                          )}
                          {p.unread_count > 0 && <View style={styles.unreadDot} />}
                        </View>
                      </Pressable>
                    ))}
                  </>
                )}

                {partnersError ? (
                  <View style={styles.errorStrip}>
                    <Text variant="caption" style={{ color: palette.warning }}>{partnersError}</Text>
                  </View>
                ) : null}
              </ScrollView>
            )}
          </>
        ) : (
          /* ── Le Marché (forum) ── */
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

            {!canPost && (
              <View style={styles.minimalUnlockBanner}>
                <Text style={styles.minimalUnlockText}>
                  Participez aux discussions ! Vous pourrez bientôt publier vos propres messages.
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

      {/* ── Add partner modal ── */}
      <Modal visible={showAddPartner} animationType="slide" onRequestClose={() => setShowAddPartner(false)}>
        <KeyboardAvoidingView style={{ flex: 1, backgroundColor: palette.background }} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
          <SafeAreaView style={styles.modalSafe} edges={['bottom']}>
            <View style={[styles.modalHeader, { paddingTop: insets.top + spacing[4] }]}>
              <Pressable onPress={() => { setShowAddPartner(false); setPartnerCodeInput(''); setAddPartnerError(''); setAddPartnerSuccess(''); }} hitSlop={8}>
                <Text variant="body" color="secondary">Fermer</Text>
              </Pressable>
              <Text variant="h4">Ajouter un ami</Text>
              <View style={{ width: 60 }} />
            </View>
            <View style={styles.modalContent}>
              <TextInput
                style={styles.amisCodeInput}
                value={partnerCodeInput}
                onChangeText={t => { setPartnerCodeInput(t.toLowerCase().trim()); setAddPartnerError(''); setAddPartnerSuccess(''); }}
                placeholder="Code de votre ami"
                placeholderTextColor={palette.textSecondary}
                autoCapitalize="none"
                autoCorrect={false}
                autoFocus
                returnKeyType="send"
                onSubmitEditing={handleSendPartnerRequest}
              />
              {addPartnerError ? (
                <Text variant="caption" style={{ color: palette.warning }}>{addPartnerError}</Text>
              ) : null}
              {addPartnerSuccess ? (
                <Text variant="caption" style={{ color: palette.success }}>{addPartnerSuccess}</Text>
              ) : null}
              <Pressable
                onPress={handleSendPartnerRequest}
                disabled={addPartnerLoading || !partnerCodeInput.trim()}
                style={({ pressed }) => [
                  styles.amisModalBtn,
                  (addPartnerLoading || !partnerCodeInput.trim()) && { opacity: 0.4 },
                  pressed && { opacity: 0.75 },
                ]}
              >
                <Text style={{ color: palette.textInverse, fontWeight: '600', fontSize: 16 }}>
                  {addPartnerLoading ? 'Envoi…' : 'Envoyer la demande'}
                </Text>
              </Pressable>
            </View>
          </SafeAreaView>
        </KeyboardAvoidingView>
      </Modal>

    </Screen>
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
    backgroundColor: p.warning,
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
  avatarText: { fontSize: 12, fontWeight: '700' as const, color: p.textInverse },
  avatarSpacer: { width: 28 },

  senderName: { fontSize: 12, fontWeight: '700' as const, marginBottom: 3 },

  // Bubble
  bubble: { borderRadius: 18, marginHorizontal: 4 },
  bubbleOwn: { backgroundColor: p.primary, maxWidth: '68%', paddingVertical: 9, paddingHorizontal: 12 },
  bubbleOther: {
    backgroundColor: p.surface,
    borderWidth: 1,
    borderColor: p.border,
    maxWidth: '72%',
    paddingVertical: 9,
    paddingHorizontal: 12,
  },
  // Image messages get no padded/colored canvas — the image itself IS the bubble.
  bubbleImage: { overflow: 'hidden' as const },
  bubbleImageOwn: { maxWidth: '68%' },
  bubbleImageOther: { maxWidth: '72%' },
  imageHeaderPad: { paddingHorizontal: 12, paddingTop: 9 },
  imageReplyPad: { marginHorizontal: 12, marginTop: 9 },
  imageCaptionWrap: { paddingHorizontal: 12, paddingTop: 6, paddingBottom: 8 },
  bubbleHighlighted: { borderWidth: 2, borderColor: p.primary },
  bubbleText:    { fontSize: 15, lineHeight: 21, color: p.textPrimary },
  bubbleTextOwn: { color: p.textInverse },

  // Timestamp inside bubble
  bubbleMeta: { flexDirection: 'row' as const, justifyContent: 'flex-end' as const, marginTop: 4, gap: 2 },
  ts:      { fontSize: 11 },
  tsOther: { color: p.textSecondary },
  tsOwn:   { color: 'rgba(255,255,255,0.7)' },
  receipt:     { fontSize: 11, color: 'rgba(255,255,255,0.7)' },
  receiptRead: { color: p.textInverse, fontWeight: '600' as const },

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
  imgBtn: {
    width: 40, height: 40,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sendBtn: {
    width: 40, height: 40,
    borderRadius: radius.full,
    backgroundColor: p.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  micBtn: {
    backgroundColor: `${p.primary}18`,
  },
  recordingRow: {
    gap: spacing[3],
    alignItems: 'center',
  },
  recTimer: {
    fontSize: 15,
    fontWeight: '600' as const,
    minWidth: 36,
    textAlign: 'center' as const,
  },

  // Forum: category filter wrapper
  catScrollWrap: {
    height: 48,
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    backgroundColor: p.background,
    borderBottomWidth: 1,
    borderBottomColor: p.border,
    marginBottom: 8,
  },
  catScroll: { flex: 1 },
  composeBtn: {
    width: 44,
    height: 44,
    alignItems: 'center' as const,
    justifyContent: 'center' as const,
    paddingRight: spacing[1],
  },
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
    backgroundColor: p.successLight,
    borderRadius: radius.full,
    paddingHorizontal: spacing[2],
    paddingVertical: 1,
  },
  newBadgeText: { fontSize: 10, color: p.success, fontWeight: '700' as const },
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
  pcAvatarText: { fontSize: 14, fontWeight: '700' as const, color: p.textInverse },
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

  // Amis tab
  amisHeader: {
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    paddingHorizontal: spacing[4],
    paddingVertical: spacing[3],
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: p.border,
    backgroundColor: p.background,
  },
  amisIconBtn: {
    width: 40,
    height: 40,
    alignItems: 'center' as const,
    justifyContent: 'center' as const,
  },
  amisSectionLabel: {
    paddingHorizontal: spacing[5],
    paddingTop: spacing[4],
    paddingBottom: spacing[2],
    textTransform: 'uppercase' as const,
    letterSpacing: 0.5,
  },
  amisRequestRow: {
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    gap: spacing[3],
    paddingHorizontal: spacing[5],
    paddingVertical: spacing[3],
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: p.border,
    backgroundColor: p.background,
  },
  amisPartnerRow: {
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    gap: spacing[3],
    paddingHorizontal: spacing[5],
    paddingVertical: spacing[4],
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: p.border,
    backgroundColor: p.background,
  },
  amisAvatar: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center' as const,
    justifyContent: 'center' as const,
    flexShrink: 0,
  },
  amisAvatarText: {
    fontSize: 18,
    fontWeight: '700' as const,
  },
  amisRequestBtns: {
    flexDirection: 'row' as const,
    gap: spacing[2],
    flexShrink: 0,
  },
  // Accept is the one bold action here; decline stays quiet — one clear
  // affordance per decision instead of two competing outlined pills.
  amisAcceptBtn: {
    paddingHorizontal: spacing[4],
    paddingVertical: spacing[2],
    borderRadius: radius.full,
    backgroundColor: p.primary,
  },
  amisDeclineBtn: {
    paddingHorizontal: spacing[3],
    paddingVertical: spacing[2],
    borderRadius: radius.full,
  },
  amisInviteState: {
    alignItems: 'center' as const,
    paddingHorizontal: spacing[5],
  },
  amisCodeLabel: {
    fontSize: 13,
    fontWeight: '500' as const,
    letterSpacing: 0.5,
    marginBottom: spacing[3],
  },
  amisCodeValue: {
    fontFamily: 'DMSans_700Bold',
    fontSize: 32,
    letterSpacing: 0,
    marginBottom: spacing[2],
    textAlign: 'center' as const,
  },
  amisCodeMeta: {
    fontSize: 12,
    marginBottom: spacing[8],
  },
  amisShareBtn: {
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    gap: spacing[2],
    backgroundColor: p.primary,
    borderRadius: radius.full,
    paddingHorizontal: spacing[7],
    paddingVertical: spacing[4],
    marginBottom: spacing[5],
  },
  amisRenewLink: {
    fontSize: 13,
    textDecorationLine: 'underline' as const,
  },
  amisCodeInput: {
    height: 56,
    borderWidth: 1,
    borderColor: p.border,
    borderRadius: radius.xl,
    paddingHorizontal: spacing[5],
    fontSize: 18,
    letterSpacing: 2,
    color: p.textPrimary,
    backgroundColor: p.surface,
  },
  amisModalBtn: {
    height: 52,
    borderRadius: radius.full,
    backgroundColor: p.primary,
    alignItems: 'center' as const,
    justifyContent: 'center' as const,
  },
  });
}
