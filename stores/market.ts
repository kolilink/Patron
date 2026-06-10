import { create } from 'zustand';
import { supabase } from '@/lib/supabase';
import { translateError } from '@/lib/errors';
import { isNetworkError } from '@/lib/sync';
import { getKV, setKV, saveMarketCache, getMarketCache } from '@/lib/db';
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

  fetchPosts: (userId: string, category?: MarketCategory) => Promise<void>;
  prependPost: (post: MarketPost) => void;
  createPost: (title: string, content: string, category: MarketCategory) => Promise<void>;

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
};

export const useMarketStore = create<MarketStore>((set, get) => ({
  ...initialState,

  fetchPosts: async (userId, category) => {
    set({ loading: true, error: null });
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

      const posts = (postsRes.data ?? []) as MarketPost[];
      void saveMarketCache(posts);

      set({
        posts,
        likedPostIds: (postLikesRes.data ?? []).map(l => l.post_id),
        likedCommentIds: (commentLikesRes.data ?? []).map(l => l.comment_id),
        userPoints: profileRes.data?.points ?? 0,
        userLevel: profileRes.data?.community_level ?? 1,
        lastVisitedAt: visitTs ? new Date(visitTs) : null,
        loading: false,
      });
    } catch (err) {
      if (isNetworkError(err)) {
        const cached = await getMarketCache() as MarketPost[] | null;
        if (cached) {
          set({ posts: cached, loading: false, error: null });
          return;
        }
        set({ loading: false, error: null }); // show empty state, not an error
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

  fetchPostDetail: async (postId, userId) => {
    set({ loadingDetail: true, activePost: null, comments: [] });
    try {
      const [postRes, commentsRes, commentLikesRes] = await Promise.all([
        supabase.from('market_posts').select('*').eq('id', postId).single(),
        supabase
          .from('market_comments')
          .select('*, author:profiles!author_id(community_level)')
          .eq('post_id', postId)
          .order('created_at', { ascending: true }),
        supabase.from('comment_likes').select('comment_id').eq('user_id', userId),
      ]);
      if (postRes.error) throw postRes.error;
      if (commentsRes.error) throw commentsRes.error;
      const comments = (commentsRes.data ?? []).map((c: any) => ({
        ...c,
        author_level: c.author?.community_level ?? 1,
        author: undefined,
      })) as MarketComment[];
      set({
        activePost: postRes.data as MarketPost,
        comments,
        likedCommentIds: (commentLikesRes.data ?? []).map(l => l.comment_id),
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
    const { likedPostIds, posts } = get();
    const isLiked = likedPostIds.includes(postId);

    // Optimistic update
    set({
      likedPostIds: isLiked
        ? likedPostIds.filter(id => id !== postId)
        : [...likedPostIds, postId],
      posts: posts.map(p => p.id === postId
        ? { ...p, likes_count: Math.max(0, p.likes_count + (isLiked ? -1 : 1)) }
        : p),
      activePost: get().activePost?.id === postId
        ? {
          ...get().activePost!,
          likes_count: Math.max(0, get().activePost!.likes_count + (isLiked ? -1 : 1)),
        }
        : get().activePost,
    });

    try {
      const { error } = await supabase.rpc('toggle_post_like', { p_post_id: postId });
      if (error) {
        // Revert on error
        set({
          likedPostIds: isLiked
            ? [...get().likedPostIds, postId]
            : get().likedPostIds.filter(id => id !== postId),
          posts: get().posts.map(p => p.id === postId
            ? { ...p, likes_count: Math.max(0, p.likes_count + (isLiked ? 1 : -1)) }
            : p),
        });
      }
    } catch {
      // Revert optimistic update
      set({
        likedPostIds: isLiked
          ? [...get().likedPostIds, postId]
          : get().likedPostIds.filter(id => id !== postId),
        posts: get().posts.map(p => p.id === postId
          ? { ...p, likes_count: Math.max(0, p.likes_count + (isLiked ? 1 : -1)) }
          : p),
      });
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
