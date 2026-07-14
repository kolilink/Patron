import { create } from 'zustand';
import { supabase } from '@/lib/supabase';
import { translateError } from '@/lib/errors';
import { isNetworkError } from '@/lib/sync';
import { getKV, setKV, saveMarketCache, getMarketCache, getCacheTimestamp } from '@/lib/db';
import { toast } from '@/stores/toast';
import type { MarketPost, MarketComment, MarketCategory } from '@/src/types';

const MARKET_VISIT_KEY = 'market_last_visit';

interface MarketStore {
  posts: MarketPost[];
  loading: boolean;
  creating: boolean;
  error: string | null;
  likedPostIds: string[];
  likedCommentIds: string[];
  userPoints: number;
  userLevel: number;
  lastVisitedAt: Date | null;

  activePost: MarketPost | null;
  comments: MarketComment[];
  loadingDetail: boolean;
  sendingComment: boolean;
  offline: boolean;
  offlineSince: number | null;

  fetchPosts: (userId: string, category?: MarketCategory) => Promise<void>;
  prependPost: (post: MarketPost) => void;
  createPost: (title: string, content: string, category: MarketCategory) => Promise<void>;
  editPost: (postId: string, title: string, content: string) => Promise<void>;

  fetchPostDetail: (postId: string, userId: string) => Promise<void>;
  addComment: (postId: string, parentId: string | null, content: string) => Promise<void>;
  appendComment: (comment: MarketComment) => void;
  toggleLike: (postId: string, userId: string) => Promise<void>;
  toggleCommentLike: (commentId: string, userId: string) => Promise<void>;

  markVisited: () => Promise<void>;
  reset: () => void;
}

const initialState = {
  posts: [],
  loading: false,
  creating: false,
  error: null,
  likedPostIds: [],
  likedCommentIds: [],
  userPoints: 0,
  userLevel: 1,
  lastVisitedAt: null,
  activePost: null,
  comments: [],
  loadingDetail: false,
  sendingComment: false,
  offline: false,
  offlineSince: null as number | null,
};

export const useMarketStore = create<MarketStore>((set, get) => ({
  ...initialState,

  fetchPosts: async (userId, category) => {
    if (get().posts.length === 0) {
      const cached = await getMarketCache() as MarketPost[] | null;
      if (cached) {
        set({ posts: cached, loading: false, error: null });
      } else {
        set({ loading: true, error: null });
      }
    } else {
      set({ error: null });
    }
    try {
      let q = supabase
        .from('market_posts')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(50);
      if (category) q = q.eq('category', category);

      const [postsRes, postLikesRes, commentLikesRes, profileRes, visitTs] = await Promise.all([
        q,
        supabase.from('post_likes').select('post_id').eq('user_id', userId),
        supabase.from('comment_likes').select('comment_id').eq('user_id', userId),
        supabase.from('profiles').select('points, community_level').eq('id', userId).single(),
        getKV(MARKET_VISIT_KEY),
      ]);

      if (postsRes.error) throw postsRes.error;

      let posts = (postsRes.data ?? []) as MarketPost[];

      // Resolve current author names so old posts reflect name changes
      const authorIds = [...new Set(posts.map(p => p.author_id))];
      if (authorIds.length > 0) {
        const { data: authorProfiles } = await supabase
          .from('profiles')
          .select('id, name')
          .in('id', authorIds);
        if (authorProfiles && authorProfiles.length > 0) {
          const nameMap: Record<string, string | null> = Object.fromEntries(
            authorProfiles.map(p => [p.id, (p.name as string | null) ?? null]),
          );
          posts = posts.map(p => ({
            ...p,
            author_name: nameMap[p.author_id] ?? p.author_name,
          }));
        }
      }

      void saveMarketCache(posts);

      set({
        posts,
        likedPostIds: (postLikesRes.data ?? []).map(l => l.post_id),
        likedCommentIds: (commentLikesRes.data ?? []).map(l => l.comment_id),
        userPoints: profileRes.data?.points ?? 0,
        userLevel: profileRes.data?.community_level ?? 1,
        lastVisitedAt: visitTs ? new Date(visitTs) : null,
        loading: false,
        offline: false,
        offlineSince: null,
      });
    } catch (err) {
      if (isNetworkError(err)) {
        const cached = await getMarketCache() as MarketPost[] | null;
        if (cached) {
          const ts = await getCacheTimestamp('market_cache');
          set({ posts: cached, loading: false, error: null, offline: true, offlineSince: ts });
          return;
        }
        set({ loading: false, error: null, offline: true, offlineSince: null }); // show empty state, not an error
        return;
      }
      set({ loading: false, error: translateError(err, 'Erreur de chargement') });
    }
  },

  prependPost: (post) => {
    set(state => ({
      posts: [post, ...state.posts.filter(p => p.id !== post.id)],
    }));
  },

  createPost: async (title, content, category) => {
    set({ creating: true, error: null });
    try {
      const { data, error } = await supabase.rpc('create_market_post', {
        p_title: title,
        p_content: content,
        p_category: category,
      });
      if (error) throw error;
      // Fetch the newly created post to prepend it
      const { data: post, error: fetchErr } = await supabase
        .from('market_posts')
        .select('*')
        .eq('id', data)
        .single();
      if (fetchErr) throw fetchErr;
      get().prependPost(post as MarketPost);
      set({ creating: false });
    } catch (err) {
      set({ creating: false, error: translateError(err, 'Erreur de création') });
      throw err;
    }
  },

  editPost: async (postId, title, content) => {
    // Optimistic update
    const update = (p: MarketPost) => p.id === postId ? { ...p, title, content } : p;
    set(state => ({
      posts: state.posts.map(update),
      activePost: state.activePost?.id === postId ? update(state.activePost) : state.activePost,
    }));
    try {
      const { error } = await supabase
        .from('market_posts')
        .update({ title, content })
        .eq('id', postId);
      if (error) throw error;
    } catch (err) {
      throw err;
    }
  },

  fetchPostDetail: async (postId, userId) => {
    set({ loadingDetail: true, activePost: null, comments: [] });
    try {
      const [postRes, commentsRes, commentLikesRes, postLikesRes] = await Promise.all([
        supabase.from('market_posts').select('*').eq('id', postId).single(),
        supabase
          .from('market_comments')
          .select('*, author:profiles!author_id(community_level)')
          .eq('post_id', postId)
          .order('created_at', { ascending: true }),
        supabase.from('comment_likes').select('comment_id').eq('user_id', userId),
        supabase.from('post_likes').select('post_id').eq('user_id', userId),
      ]);
      if (postRes.error) throw postRes.error;
      if (commentsRes.error) throw commentsRes.error;
      let comments = (commentsRes.data ?? []).map((c: any) => ({
        ...c,
        author_level: c.author?.community_level ?? 1,
        author: undefined,
      })) as MarketComment[];

      // Resolve current names for post + comments
      const allAuthorIds = [...new Set([
        (postRes.data as MarketPost).author_id,
        ...comments.map(c => c.author_id),
      ])];
      if (allAuthorIds.length > 0) {
        const { data: authorProfiles } = await supabase
          .from('profiles')
          .select('id, name')
          .in('id', allAuthorIds);
        if (authorProfiles && authorProfiles.length > 0) {
          const nameMap: Record<string, string | null> = Object.fromEntries(
            authorProfiles.map(p => [p.id, (p.name as string | null) ?? null]),
          );
          const post = postRes.data as MarketPost;
          (post as any).author_name = nameMap[post.author_id] ?? post.author_name;
          comments = comments.map(c => ({
            ...c,
            author_name: nameMap[c.author_id] ?? c.author_name,
          }));
        }
      }

      set({
        activePost: postRes.data as MarketPost,
        comments,
        likedCommentIds: (commentLikesRes.data ?? []).map(l => l.comment_id),
        likedPostIds: (postLikesRes.data ?? []).map(l => l.post_id),
        loadingDetail: false,
      });
    } catch (err) {
      set({ loadingDetail: false });
    }
  },

  addComment: async (postId, parentId, content) => {
    set({ sendingComment: true });
    try {
      const { data: newId, error } = await supabase.rpc('create_market_comment', {
        p_post_id: postId,
        p_parent_id: parentId,
        p_content: content,
      });
      if (error) throw error;
      // Immediately fetch + append so the sender sees it without relying on realtime.
      // appendComment deduplicates, so the realtime event is safely ignored if it arrives later.
      const { data: newComment } = await supabase
        .from('market_comments')
        .select('*, author:profiles!author_id(community_level)')
        .eq('id', newId)
        .single();
      if (newComment) {
        const mapped = {
          ...(newComment as any),
          author_level: (newComment as any).author?.community_level ?? 1,
          author: undefined,
        };
        get().appendComment(mapped as MarketComment);
      }
      set({ sendingComment: false });
    } catch (err) {
      set({ sendingComment: false });
      throw err;
    }
  },

  appendComment: (comment) => {
    set(state => {
      if (state.comments.some(c => c.id === comment.id)) return state;
      const newComments = [...state.comments, comment];
      // Keep activePost.comments_count in sync
      const activePost = state.activePost
        ? { ...state.activePost, comments_count: state.activePost.comments_count + 1 }
        : null;
      return { comments: newComments, activePost };
    });
  },

  toggleLike: async (postId, userId) => {
    const { likedPostIds, posts, activePost } = get();
    const isLiked = likedPostIds.includes(postId);
    const delta = isLiked ? -1 : 1;

    // Snapshots for revert
    const prevLikedPostIds = likedPostIds;
    const prevPosts = posts;
    const prevActivePost = activePost;

    // Optimistic update
    set({
      likedPostIds: isLiked ? likedPostIds.filter(id => id !== postId) : [...likedPostIds, postId],
      posts: posts.map(p => p.id === postId
        ? { ...p, likes_count: Math.max(0, p.likes_count + delta) } : p),
      activePost: activePost?.id === postId
        ? { ...activePost, likes_count: Math.max(0, activePost.likes_count + delta) }
        : activePost,
    });

    try {
      const { error } = await supabase.rpc('toggle_post_like', { p_post_id: postId });
      if (error) throw error;
    } catch (err) {
      set({ likedPostIds: prevLikedPostIds, posts: prevPosts, activePost: prevActivePost });
      const msg = err instanceof Error ? err.message : '';
      if (msg.includes('quotidienne')) {
        toast.warning('Limite atteinte — vous avez déjà beaucoup aimé ce contributeur aujourd\'hui.');
      } else if (!msg.includes('Auto-upvotes')) {
        toast.warning('Impossible d\'enregistrer le like. Réessayez.');
      }
    }
  },

  toggleCommentLike: async (commentId, _userId) => {
    const { likedCommentIds, comments, userPoints } = get();
    const isLiked = likedCommentIds.includes(commentId);
    const delta = isLiked ? -1 : 1;

    // Snapshot for revert
    const prevLikedCommentIds = likedCommentIds;
    const prevComments = comments;
    const prevUserPoints = userPoints;

    // Optimistic update
    set({
      likedCommentIds: isLiked
        ? likedCommentIds.filter(id => id !== commentId)
        : [...likedCommentIds, commentId],
      comments: comments.map(c =>
        c.id === commentId
          ? { ...c, likes_count: Math.max(0, c.likes_count + delta) }
          : c,
      ),
      userPoints: Math.max(0, userPoints + delta),
    });

    try {
      const { error } = await supabase.rpc('toggle_comment_like', { p_comment_id: commentId });
      if (error) throw error;
    } catch {
      // Revert all three on any error (including self-like exception from DB)
      set({
        likedCommentIds: prevLikedCommentIds,
        comments: prevComments,
        userPoints: prevUserPoints,
      });
    }
  },

  markVisited: async () => {
    const now = new Date();
    await setKV(MARKET_VISIT_KEY, now.toISOString());
    set({ lastVisitedAt: now });
  },

  reset: () => set(initialState),
}));
