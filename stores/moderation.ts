import { create } from 'zustand';
import { failureLine } from '@/src/utils/failure';
import { supabase } from '@/lib/supabase';
import { translateError } from '@/lib/errors';
import { isNetworkError, withNetworkRetry, reportOfflineFallback } from '@/lib/sync';
import { toast } from '@/stores/toast';
import type { Report, ReportEtat, ReportMotif } from '@/src/types';
import { beginFetch, failFetch, IDLE, READY, type FetchStatus } from '@/lib/fetchStatus';

interface ModerationStore {
    reports: Report[];
    loading: boolean;
    /** idle → loading → ready | error. See lib/fetchStatus.ts. */
    fetchStatus: FetchStatus;
    updating: boolean;
    error: string | null;
    blockedIds: string[];
    myBlockedIds: string[];

    fetchReports: () => Promise<void>;
    setReportEtat: (reportId: string, etat: ReportEtat) => Promise<void>;
    deletePost: (postId: string) => Promise<boolean>;
    blockUser: (blockedId: string) => Promise<void>;
    unblockUser: (blockedId: string) => Promise<void>;
    fetchMyBlocks: () => Promise<void>;
    reportPost: (postId: string, motif: ReportMotif, detail?: string) => Promise<void>;
    reset: () => void;
}

const initialState = {
    reports: [] as Report[],
    ...IDLE,
    updating: false,
    error: null as string | null,
    blockedIds: [] as string[],
    myBlockedIds: [] as string[],
};

export const useModerationStore = create<ModerationStore>((set, get) => ({
    ...initialState,

    fetchReports: async () => {
        set({ ...beginFetch(get().fetchStatus), error: null });
        try {
            const { data, error } = await withNetworkRetry(() =>
                supabase.rpc('list_reports'),
            );
            if (error) throw error;
            set({ reports: (data ?? []) as Report[], ...READY });
        } catch (err) {
            if (isNetworkError(err)) {
                reportOfflineFallback('moderation.fetchReports', err);
                set({ ...failFetch(get().fetchStatus), error: 'Hors ligne — impossible de charger la file.' });
                return;
            }
            set({ ...failFetch(get().fetchStatus), error: translateError(err, "Le chargement n'a pas abouti.") });
        }
    },

    setReportEtat: async (reportId, etat) => {
        set({ updating: true });
        try {
            const { error } = await supabase.rpc('update_report_status', {
                p_report_id: reportId,
                p_etat: etat,
            });
            if (error) throw error;
            set(state => ({
                reports: state.reports.map(r => r.id === reportId ? { ...r, etat } : r),
                updating: false,
            }));
        } catch (err) {
            set({ updating: false });
            toast.warning(failureLine('postStateNotChanged', err));
            throw err;
        }
    },

    deletePost: async (postId) => {
        try {
            const { error } = await supabase.rpc('delete_market_post', { p_post_id: postId });
            if (error) throw error;
            // Drop the deleted post from the queue and local market cache.
            set(state => ({
                reports: state.reports.filter(r => r.post_id !== postId),
            }));
            return true;
        } catch (err) {
            toast.warning(failureLine('postNotDeleted', err));
            return false;
        }
    },

    blockUser: async (blockedId) => {
        try {
            const { error } = await supabase.rpc('block_user', { p_blocked_id: blockedId });
            if (error) throw error;
            set(state => ({
                myBlockedIds: state.myBlockedIds.includes(blockedId)
                    ? state.myBlockedIds
                    : [...state.myBlockedIds, blockedId],
                blockedIds: state.blockedIds.includes(blockedId)
                    ? state.blockedIds
                    : [...state.blockedIds, blockedId],
            }));
        } catch (err) {
            toast.warning(failureLine('authorNotBlocked', err));
            throw err;
        }
    },

    unblockUser: async (blockedId) => {
        try {
            const { error } = await supabase.rpc('unblock_user', { p_blocked_id: blockedId });
            if (error) throw error;
            set(state => ({
                myBlockedIds: state.myBlockedIds.filter(id => id !== blockedId),
                blockedIds: state.blockedIds.filter(id => id !== blockedId),
            }));
        } catch (err) {
            toast.warning(failureLine('authorNotUnblocked', err));
            throw err;
        }
    },

    fetchMyBlocks: async () => {
        try {
            const { data, error } = await supabase.rpc('list_my_blocks');
            if (error) throw error;
            set({ myBlockedIds: (data ?? []).map((r: { blocked_id: string }) => r.blocked_id) });
        } catch {
            // Silent — non-blocking; the list is only used to hide action affordances.
        }
    },

    reportPost: async (postId, motif, detail) => {
        try {
            const { error } = await supabase.rpc('report_post', {
                p_post_id: postId,
                p_motif: motif,
                p_detail: detail && detail.trim() ? detail.trim() : null,
            });
            if (error) throw error;
            toast.success('Merci. Votre signalement a été transmis à la modération.');
        } catch (err) {
            toast.warning(failureLine('postNotReported', err));
            throw err;
        }
    },

    reset: () => set(initialState),
}));

// Convenience hook-free helper: is this author currently blocked by me?
export function isBlockedByMe(blockedIds: string[], authorId: string): boolean {
    return blockedIds.includes(authorId);
}
