import { useCallback, useEffect, useRef, useState } from 'react';
import {
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router, useLocalSearchParams, useFocusEffect } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { Text } from '@/src/components/ui/Text';
import { haptics } from '@/lib/haptics';
import { palette, radius, spacing, colors } from '@/src/theme';
import { useAuthStore } from '@/stores/auth';
import { useMarketStore } from '@/stores/market';
import { supabase } from '@/lib/supabase';
import { generateFallbackName } from '@/lib/id';
import type { MarketComment, MarketPost } from '@/src/types';

const LOCALE = Intl.DateTimeFormat().resolvedOptions().locale;

function relativeTime(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const diffMin = Math.floor((now.getTime() - d.getTime()) / 60_000);
  if (diffMin < 1) return "À l'instant";
  if (diffMin < 60) return `Il y a ${diffMin} min`;
  const diffH = Math.floor(diffMin / 60);
  if (diffH < 24) return `Il y a ${diffH} h`;
  const yesterday = new Date(now); yesterday.setDate(now.getDate() - 1);
  const sameDay = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  if (sameDay(d, now)) return "Aujourd'hui";
  if (sameDay(d, yesterday)) return 'Hier';
  return new Intl.DateTimeFormat(LOCALE, { day: 'numeric', month: 'long' }).format(d);
}

const AVATAR_PALETTE = [
  colors.primary[500],
  '#10B981',
  '#F59E0B',
  '#EC4899',
  '#8B5CF6',
];

function avatarColor(id: string) {
  return AVATAR_PALETTE[id.charCodeAt(0) % AVATAR_PALETTE.length];
}


// ─── Post header block ────────────────────────────────────────────────────────

function PostHeaderBlock({
  post, isLiked, isOwnPost, onLike,
}: {
  post: MarketPost;
  isLiked: boolean;
  isOwnPost: boolean;
  onLike: () => void;
}) {
  const authorName = post.author_name || generateFallbackName(post.author_id);
  const initial    = authorName.charAt(0).toUpperCase();
  const color      = avatarColor(post.author_id);
  const lastTapRef = useRef(0);

  const handleBodyTap = () => {
    if (isOwnPost) return;
    const now = Date.now();
    if (now - lastTapRef.current < 300) {
      lastTapRef.current = 0;
      haptics.tap();
      onLike();
    } else {
      lastTapRef.current = now;
    }
  };

  return (
    <View style={styles.postHeader}>
      {/* Author row */}
      <View style={styles.authorRow}>
        <View style={[styles.postAvatar, { backgroundColor: color }]}>
          <Text style={styles.postAvatarText}>{initial}</Text>
        </View>
        <View style={styles.authorInfo}>
          <Text style={styles.authorName}>{authorName}</Text>
          <Text style={styles.authorMeta}>Commerçant • {relativeTime(post.created_at)}</Text>
        </View>
      </View>

      {/* Title */}
      <Text style={styles.postTitle}>{post.title}</Text>

      {/* Body — double-tap to like */}
      <Pressable onPress={handleBodyTap}>
        <Text style={styles.postBody}>{post.content}</Text>
      </Pressable>

      {/* Interaction bar */}
      <View style={styles.interactionBar}>
        <Pressable
          onPress={onLike}
          disabled={isOwnPost}
          style={[
            styles.likeBtn,
            {
              borderColor: isLiked ? palette.primary : palette.border,
              backgroundColor: isLiked ? `${palette.primary}10` : 'transparent',
            },
            isOwnPost && { opacity: 0.35 },
          ]}
        >
          <Ionicons
            name={isLiked ? 'thumbs-up' : 'thumbs-up-outline'}
            size={16}
            color={isLiked ? palette.primary : palette.textSecondary}
          />
          <Text style={[styles.likeBtnText, isLiked && styles.likeBtnTextActive]}>{post.likes_count}</Text>
        </Pressable>
        <View style={styles.commentCountView}>
          <Ionicons name="chatbubble-outline" size={16} color={palette.textSecondary} />
          <Text style={styles.commentCountText}>
            {post.comments_count} commentaire{post.comments_count !== 1 ? 's' : ''}
          </Text>
        </View>
      </View>

    </View>
  );
}

// ─── Comment item ─────────────────────────────────────────────────────────────

function CommentItem({
  comment,
  isReply,
  canReply,
  onReply,
  isCommentLiked,
  onLikeComment,
  currentUserId,
}: {
  comment: MarketComment;
  isOwn: boolean;
  isReply: boolean;
  onReply?: () => void;
  canReply: boolean;
  isCommentLiked: boolean;
  onLikeComment: () => void;
  currentUserId: string;
}) {
  const authorName   = comment.author_name || generateFallbackName(comment.author_id);
  const initial      = authorName.charAt(0).toUpperCase();
  const color        = avatarColor(comment.author_id);
  const level        = comment.author_level ?? 1;
  const isSelf       = comment.author_id === currentUserId;
  const lastTapRef   = useRef(0);

  const handleBubbleTap = () => {
    if (isSelf) return;
    const now = Date.now();
    if (now - lastTapRef.current < 300) {
      lastTapRef.current = 0;
      haptics.tap();
      onLikeComment();
    } else {
      lastTapRef.current = now;
    }
  };

  return (
    <View style={[styles.commentItem, isReply && styles.commentItemReply]}>

      {/* Avatar + level badge */}
      <View style={styles.commentAvatarWrap}>
        <View style={[styles.commentAvatar, { backgroundColor: color }]}>
          <Text style={styles.commentAvatarText}>{initial}</Text>
        </View>
        <View style={styles.levelBadge}>
          <Text style={styles.levelBadgeText}>{level}</Text>
        </View>
      </View>

      <View style={styles.commentRight}>
        {/* Card bubble — double-tap to like */}
        <Pressable onPress={handleBubbleTap} style={styles.commentBubble}>
          <View style={styles.commentMeta}>
            <Text style={styles.commentAuthor}>{authorName}</Text>
            <Text style={styles.commentTime}> • {relativeTime(comment.created_at)}</Text>
          </View>
          <Text style={styles.commentContent}>{comment.content}</Text>
        </Pressable>

        {/* Action row — outside bubble */}
        <View style={styles.commentActions}>
          <Pressable
            onPress={onLikeComment}
            disabled={isSelf}
            hitSlop={8}
            style={[styles.commentActionBtn, { opacity: isSelf ? 0.3 : 1 }]}
          >
            <Ionicons
              name={isCommentLiked ? 'thumbs-up' : 'thumbs-up-outline'}
              size={13}
              color={isCommentLiked ? palette.primary : palette.textSecondary}
            />
            {comment.likes_count > 0 && (
              <Text style={[styles.commentActionText, isCommentLiked && { color: palette.primary }]}>
                {comment.likes_count}
              </Text>
            )}
          </Pressable>

          {!isReply && canReply && onReply && (
            <Pressable onPress={onReply} hitSlop={8} style={styles.commentActionBtn}>
              <Ionicons name="arrow-undo-outline" size={13} color={palette.textSecondary} />
              <Text style={styles.commentActionText}>Répondre</Text>
            </Pressable>
          )}
        </View>
      </View>

    </View>
  );
}

// ─── Screen ───────────────────────────────────────────────────────────────────

export default function PostDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const session  = useAuthStore(s => s.session);
  const userId   = session?.user.id ?? '';

  const {
    activePost, comments, loadingDetail,
    fetchPostDetail, addComment, appendComment, toggleLike,
    likedPostIds, likedCommentIds, toggleCommentLike,
  } = useMarketStore();

  const [text, setText]             = useState('');
  const [replyingTo, setReplyingTo] = useState<MarketComment | null>(null);
  const inputRef                    = useRef<TextInput>(null);
  const channelRef                  = useRef<ReturnType<typeof supabase.channel> | null>(null);

  const isLiked   = likedPostIds.includes(id ?? '');
  const isOwnPost = activePost?.author_id === userId;

  useFocusEffect(useCallback(() => {
    if (id) fetchPostDetail(id, userId);
  }, [id]));

  // Realtime: new comments on this post
  useEffect(() => {
    if (!id) return;
    const ch = supabase
      .channel(`market-comments:${id}`)
      .on('postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'market_comments', filter: `post_id=eq.${id}` },
        p => appendComment(p.new as MarketComment))
      .subscribe();
    channelRef.current = ch;
    return () => {
      supabase.removeChannel(ch);
      channelRef.current = null;
    };
  }, [id]);

  const handleSend = async () => {
    const trimmed = text.trim();
    if (!trimmed || !id) return;
    setText('');
    const parentId = replyingTo?.id ?? null;
    setReplyingTo(null);
    try {
      await addComment(id, parentId, trimmed);
      haptics.success();
    } catch {
      haptics.error();
    }
  };

  // Flat threaded list: top-level comments followed by their replies
  const threadedComments = (() => {
    const topLevel = comments.filter(c => c.parent_id === null);
    const result: Array<{ comment: MarketComment; isReply: boolean }> = [];
    for (const c of topLevel) {
      result.push({ comment: c, isReply: false });
      for (const r of comments.filter(r => r.parent_id === c.id)) {
        result.push({ comment: r, isReply: true });
      }
    }
    return result;
  })();

  return (
    <SafeAreaView style={styles.safe} edges={['top', 'bottom']}>
      {/* Header */}
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} hitSlop={8}>
          <Text variant="body" color="secondary">‹ Retour</Text>
        </Pressable>
        <Text variant="h4" numberOfLines={1} style={styles.headerTitle}>
          {activePost?.title ?? 'Post'}
        </Text>
        <View style={{ width: 60 }} />
      </View>

      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        {loadingDetail ? (
          <View style={styles.centered}>
            <Text variant="body" color="secondary">Chargement…</Text>
          </View>
        ) : !activePost ? null : (
          <FlatList
            data={threadedComments}
            keyExtractor={({ comment }) => comment.id}
            contentContainerStyle={styles.listContent}
            keyboardShouldPersistTaps="handled"
            ListHeaderComponent={() => (
              <PostHeaderBlock
                post={activePost}
                isLiked={isLiked}
                isOwnPost={isOwnPost}
                onLike={() => { if (!isOwnPost) { haptics.tap(); toggleLike(activePost.id, userId); } }}
              />
            )}
            ListEmptyComponent={() => (
              <View style={styles.emptyComments}>
                <Text variant="body" color="secondary" style={{ textAlign: 'center' }}>
                  Pas encore de commentaire.{'\n'}Soyez le premier à réagir.
                </Text>
              </View>
            )}
            renderItem={({ item: { comment, isReply } }) => (
              <CommentItem
                key={comment.id}
                comment={comment}
                isOwn={comment.author_id === userId}
                isReply={isReply}
                canReply={true}
                onReply={() => {
                  setReplyingTo(comment);
                  setTimeout(() => inputRef.current?.focus(), 100);
                }}
                isCommentLiked={likedCommentIds.includes(comment.id)}
                onLikeComment={() => { haptics.tap(); toggleCommentLike(comment.id, userId); }}
                currentUserId={userId}
              />
            )}
          />
        )}

        {/* Input bar — open to all authenticated members */}
        <View style={styles.inputWrap}>
          {replyingTo && (
            <View style={styles.replyPill}>
              <Text variant="caption" style={styles.replyPillText}>
                Réponse à {replyingTo.author_name || generateFallbackName(replyingTo.author_id)}
              </Text>
              <Pressable onPress={() => setReplyingTo(null)} hitSlop={8}>
                <Text variant="caption" style={styles.replyClose}>×</Text>
              </Pressable>
            </View>
          )}
          <View style={styles.inputRow}>
            <TextInput
              ref={inputRef}
              style={styles.input}
              value={text}
              onChangeText={setText}
              placeholder={replyingTo ? 'Écrire une réponse…' : 'Ajouter un commentaire…'}
              placeholderTextColor={palette.textSecondary}
              multiline
              maxLength={500}
            />
            <Pressable
              onPress={handleSend}
              disabled={!text.trim()}
              style={({ pressed }) => [
                styles.sendBtn,
                !text.trim() && styles.sendBtnDisabled,
                pressed && { opacity: 0.75 },
              ]}
            >
              <Text style={styles.sendIcon}>↑</Text>
            </Pressable>
          </View>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

import { StyleSheet } from 'react-native';

const styles = StyleSheet.create({
  safe:   { flex: 1, backgroundColor: palette.background },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: spacing[5],
    borderBottomWidth: 1,
    borderBottomColor: palette.border,
    gap: spacing[3],
  },
  headerTitle: { flex: 1 },
  listContent:   { paddingBottom: spacing[8] },
  centered:      { alignItems: 'center', justifyContent: 'center', padding: spacing[8] },
  emptyComments: { alignItems: 'center', padding: spacing[6] },

  // ── Post header ──
  postHeader: { padding: spacing[5] },
  authorRow:  { flexDirection: 'row', alignItems: 'center', gap: spacing[3] },
  postAvatar: {
    width: 36, height: 36, borderRadius: 18,
    alignItems: 'center', justifyContent: 'center',
  },
  postAvatarText: { fontSize: 15, fontWeight: '700' as const, color: '#fff' },
  authorInfo:     { flex: 1 },
  authorName:  { fontSize: 15, fontWeight: '600' as const, color: palette.textPrimary },
  authorMeta:  { fontSize: 13, color: palette.textSecondary, marginTop: 2 },
  postTitle:   { fontSize: 18, fontWeight: '700' as const, color: palette.textPrimary, marginTop: 14, marginBottom: 8 },
  postBody:    { fontSize: 15, lineHeight: 22, color: palette.textPrimary, marginBottom: 16 },

  interactionBar: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    borderTopWidth: 1,
    borderTopColor: palette.border,
    borderBottomWidth: 1,
    borderBottomColor: palette.border,
    paddingVertical: 10,
    marginVertical: 12,
  },
  likeBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 16,
    paddingVertical: 6,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: palette.border,
  },
  likeBtnText:       { fontSize: 14, color: palette.textSecondary, fontWeight: '500' as const },
  likeBtnTextActive: { color: palette.primary },
  commentCountView:  { flexDirection: 'row' as const, alignItems: 'center' as const, gap: 6 },
  commentCountText:  { fontSize: 13, color: palette.textSecondary },

  commentsLabel:     { borderTopWidth: 1, borderTopColor: palette.border, paddingTop: spacing[3] },
  commentsLabelText: { fontSize: 13, fontWeight: '600' as const, color: palette.textSecondary },

  // ── Comment items ──
  commentItem: {
    flexDirection: 'row' as const,
    gap: 10,
    paddingVertical: 10,
    paddingHorizontal: spacing[5],
  },
  commentItemReply: { paddingLeft: 52 },

  commentAvatarWrap: { position: 'relative' as const, width: 32, height: 32 },
  commentAvatar: {
    width: 32, height: 32, borderRadius: 16,
    alignItems: 'center' as const, justifyContent: 'center' as const,
  },
  commentAvatarText: { fontSize: 12, fontWeight: '700' as const, color: '#fff' },
  levelBadge: {
    position: 'absolute' as const,
    bottom: -2, right: -2,
    width: 14, height: 14, borderRadius: 7,
    backgroundColor: palette.primary,
    alignItems: 'center' as const, justifyContent: 'center' as const,
    borderWidth: 1.5, borderColor: palette.surface,
  },
  levelBadgeText: { fontSize: 7, fontWeight: '800' as const, color: '#fff', lineHeight: 10 },

  commentRight:  { flex: 1 },
  commentBubble: {
    backgroundColor: '#F2F4F7',
    borderRadius: 14,
    borderTopLeftRadius: 2,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  commentMeta:    { flexDirection: 'row' as const, alignItems: 'center' as const, marginBottom: 4 },
  commentAuthor:  { fontSize: 13, fontWeight: '600' as const, color: palette.textPrimary },
  commentTime:    { fontSize: 11, color: palette.textSecondary },
  commentContent: { fontSize: 14, lineHeight: 19, color: palette.textPrimary },

  commentActions:   { flexDirection: 'row' as const, alignItems: 'center' as const, gap: 16, marginTop: 6, paddingLeft: 2 },
  commentActionBtn: { flexDirection: 'row' as const, alignItems: 'center' as const, gap: 4 },
  commentActionText: { fontSize: 12, color: palette.textSecondary, fontWeight: '500' as const },

  // ── Input bar ──
  inputWrap: { borderTopWidth: 1, borderTopColor: palette.border, backgroundColor: palette.surface },
  replyPill: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing[4],
    paddingTop: spacing[2],
    gap: spacing[2],
  },
  replyPillText: { color: palette.primary, fontStyle: 'italic' as const, flex: 1 },
  replyClose:    { fontSize: 16, color: palette.textSecondary, fontWeight: '600' as const },
  inputRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: spacing[2],
    padding: spacing[3],
  },
  input: {
    flex: 1,
    minHeight: 40,
    maxHeight: 100,
    borderWidth: 1,
    borderColor: palette.border,
    borderRadius: radius.lg,
    paddingHorizontal: spacing[3],
    paddingVertical: spacing[2],
    fontSize: 15,
    color: palette.textPrimary,
    backgroundColor: palette.background,
  },
  sendBtn:         { width: 40, height: 40, borderRadius: radius.full, backgroundColor: palette.primary, alignItems: 'center', justifyContent: 'center' },
  sendBtnDisabled: { backgroundColor: palette.border },
  sendIcon:        { fontSize: 20, color: palette.textInverse, lineHeight: 24 },
  readOnlyBar: {
    paddingHorizontal: spacing[5],
    paddingVertical: spacing[4],
    borderTopWidth: 1,
    borderTopColor: palette.border,
    backgroundColor: palette.surface,
  },
});
