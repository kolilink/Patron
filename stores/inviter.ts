import { create } from 'zustand';
import { trackEvent } from '@/lib/analytics';
import { supabase } from '@/lib/supabase';
import { translateError } from '@/lib/errors';
import { NO_CONNECTION_MESSAGE } from '@/src/utils/failureCopy';
import { isNetworkError, withTimeout } from '@/lib/sync';
import { notifyEvent } from '@/src/utils/notifications';
import { useAuthStore } from '@/stores/auth';

// ─── "Inviter" — consumer invite-a-friend journey ───────────────────────────
// Distinct from the team invite (stores/equipe.ts), the B2B partnership invite
// (stores/partnerships.ts), and the business referral code (auth.createBusiness).
// This one is person-to-person: an existing user shares a single-use 24h smart
// link + fallback code; the invited friend lands in Amis with the inviter
// already listed (Phase 5).
//
// Server invariants live in db/migration_v206.sql (HMAC-hashed token/code,
// 24h expiry, atomic single-use, rate limit, one generic error, revoke).

export interface ConsumerInvite {
    id: string;
    status: 'active' | 'used' | 'revoked';
    created_at: string;
    expires_at: string;
    used_at: string | null;
    used_by: string | null;
    used_by_name: string | null;
    revoked_at: string | null;
}

export interface ConsumerFriend {
    id: string;
    friend_id: string;
    friend_name: string;
    invited_at: string;
}

// The smart-link base. Served by the `invite` Supabase Edge Function through
// a custom domain (patron.kolilink.com) — the repo's own patron.kolilink.com
// is static GitHub Pages and cannot do dynamic og:title / OS routing.
const INVITE_BASE_URL = 'https://patron.kolilink.com/invite';

/** Build the unique per-invite smart link from its token. */
export function buildInviteLink(token: string): string {
    return `${INVITE_BASE_URL}?t=${encodeURIComponent(token)}`;
}

/** The prefilled, editable French "tu" share message (link first — only the first link unfurls). */
export function buildInviteMessage(link: string, code: string): string {
    return `Je note mes ventes et mes crédits avec Patron, même sans internet. C'est gratuit : ${link}\nCode : ${code}, au cas où.`;
}

/**
 * Normalize a typed invite code for submission. The server hashes
 * `upper(btrim(code))` — it uppercases and trims outer whitespace, but NOT
 * internal spaces. The codes we mint are space-free (alphabet
 * 0123456789ABCDEFGHJKMNPQRSTVWXYZ), so a human typing one may insert spaces
 * (or paste a "1 2 3 4" display form). Stripping every whitespace run before
 * the RPC makes typed entry match exactly what the server hashes.
 */
export function normalizeInviteCode(raw: string): string {
    return raw.replace(/\s+/g, '').toUpperCase();
}

interface InviterStore {
    invites: ConsumerInvite[];
    friends: ConsumerFriend[];
    loading: boolean;
    error: string | null;
    /** Machine-readable failure kind — callers branch on THIS, never on the human copy in `error`. */
    errorCode: 'network' | 'invalid' | null;

    createInvite: () => Promise<{ id: string; token: string; code: string; expires_at: string } | null>;
    fetchMyInvites: () => Promise<void>;
    fetchMyFriends: () => Promise<void>;
    revokeInvite: (inviteId: string) => Promise<boolean>;
    resolveInvite: (token: string, code: string) => Promise<{ inviter_id: string; inviter_name: string; newly_used?: boolean } | null>;
    redeemCode: (rawCode: string) => Promise<{ inviter_id: string; inviter_name: string; newly_used?: boolean } | null>;
    clearError: () => void;
    reset: () => void;
}

export const useInviterStore = create<InviterStore>((set, get) => ({
    invites: [],
    friends: [],
    loading: false,
    error: null,
    errorCode: null,

    createInvite: async () => {
        set({ loading: true, error: null });
        try {
            const { data, error } = await withTimeout(supabase.rpc('create_consumer_invite'));
            if (error) {
                set({ loading: false, error: translateError(error, "Impossible de créer l'invitation") });
                return null;
            }
            const invite = data as { id: string; token: string; code: string; expires_at: string };
            // Prepend to the hygiene list (Phase 6) without a refetch round-trip.
            set(state => ({
                loading: false,
                invites: [
                    {
                        id: invite.id,
                        status: 'active',
                        created_at: new Date().toISOString(),
                        expires_at: invite.expires_at,
                        used_at: null,
                        used_by: null,
                        used_by_name: null,
                        revoked_at: null,
                    },
                    ...state.invites,
                ],
            }));
            return invite;
        } catch (err) {
            const msg = isNetworkError(err) ? NO_CONNECTION_MESSAGE : "Impossible de créer l'invitation";
            set({ loading: false, error: msg });
            return null;
        }
    },

    fetchMyInvites: async () => {
        set({ loading: true, error: null });
        try {
            const { data, error } = await withTimeout(supabase.rpc('list_my_consumer_invites'));
            if (error) {
                set({ loading: false, error: translateError(error, 'Impossible de charger vos invitations') });
                return;
            }
            const rows = (data ?? []) as Array<{
                id: string;
                status: string;
                created_at: string;
                expires_at: string;
                used_at: string | null;
                used_by: string | null;
                used_by_name: string | null;
                revoked_at: string | null;
            }>;
            // Revoked invites no longer exist from the user's point of view —
            // they are deleted server-side by revoke_consumer_invite, so any
            // stale row the RPC still returns is dropped here.
            set({
                loading: false,
                invites: rows
                    .map(r => ({
                        id: r.id,
                        status: r.status as ConsumerInvite['status'],
                        created_at: r.created_at,
                        expires_at: r.expires_at,
                        used_at: r.used_at,
                        used_by: r.used_by,
                        used_by_name: r.used_by_name,
                        revoked_at: r.revoked_at,
                    }))
                    .filter(i => i.status !== 'revoked'),
            });
        } catch (err) {
            set({ loading: false, error: isNetworkError(err) ? NO_CONNECTION_MESSAGE : 'Impossible de charger vos invitations' });
        }
    },

    fetchMyFriends: async () => {
        set({ error: null });
        try {
            const { data, error } = await supabase.rpc('list_my_consumer_friends');
            if (error) {
                set({ error: translateError(error, 'Impossible de charger vos amis') });
                return;
            }
            const rows = (data ?? []) as Array<{
                id: string;
                friend_id: string;
                friend_name: string;
                invited_at: string;
            }>;
            set({
                friends: rows.map(r => ({
                    id: r.id,
                    friend_id: r.friend_id,
                    friend_name: r.friend_name,
                    invited_at: r.invited_at,
                })),
            });
        } catch (err) {
            set({ error: isNetworkError(err) ? NO_CONNECTION_MESSAGE : 'Impossible de charger vos amis' });
        }
    },

    revokeInvite: async (inviteId) => {
        set({ error: null });
        try {
            const { data, error } = await supabase.rpc('revoke_consumer_invite', { p_invite_id: inviteId });
            if (error) {
                set({ error: translateError(error, "Impossible de révoquer l'invitation") });
                return false;
            }
            const revoked = Boolean(data);
            if (revoked) {
                // Revoked means deleted: drop the row entirely so it leaves the
                // screen the instant the user revokes it — not a "Révoquée"
                // badge lingering behind.
                set(state => ({
                    invites: state.invites.filter(i => i.id !== inviteId),
                }));
            }
            return revoked;
        } catch (err) {
            set({ error: isNetworkError(err) ? NO_CONNECTION_MESSAGE : "Impossible de révoquer l'invitation" });
            return false;
        }
    },

    resolveInvite: async (token, code) => {
        set({ error: null, errorCode: null });
        try {
            // Attempt logging is its own top-level RPC so a failed guess is
            // actually rate-limited — a raise inside resolve_consumer_invite
            // rolls back the whole call including any INSERT it made itself
            // (see db/migration_v124.sql for the original bug this mirrors).
            // withTimeout so a hung network can never strand the deep-link
            // route on "Chargement…" — it resolves null and the caller lands
            // on a usable screen.
            await withTimeout(supabase.rpc('record_invite_attempt'));
            const { data, error } = await withTimeout(supabase.rpc('resolve_consumer_invite', { p_token: token, p_code: code }));
            if (error) {
                set({ error: translateError(error, 'Invitation invalide'), errorCode: isNetworkError(error) ? 'network' : 'invalid' });
                return null;
            }
            const result = data as { inviter_id: string; inviter_name: string; newly_used?: boolean };
            // No inviter name in the event (spec §0) — the id alone links the loop.
            trackEvent('invite_signup_completed', null, null, {
                inviter_id: result.inviter_id,
            });
            // B1 — on a FRESH redemption (not an idempotent re-fire), tell the
            // inviter via push that their friend joined. The inviter is not a
            // member of the joiner's business, so the edge function resolves
            // the recipient from the redeemed invite itself (CONSUMER_EVENTS).
            if (result.newly_used !== false) {
                const businessId = useAuthStore.getState().session?.activeBusiness?.id;
                if (businessId) {
                    notifyEvent({
                        businessId,
                        eventType: 'consumer_invite_accepted',
                        payload: {},
                        targetUserIds: [result.inviter_id],
                    });
                }
            }
            return result;
        } catch (err) {
            set({ error: isNetworkError(err) ? NO_CONNECTION_MESSAGE : 'Invitation invalide', errorCode: isNetworkError(err) ? 'network' : 'invalid' });
            return null;
        }
    },

    redeemCode: async (rawCode) => {
        // Typed entry path: a code (not a smart-link token) goes in p_code, with
        // the token slot empty. Normalization is client-side because the server
        // only uppercases + trims — it does not strip internal spaces.
        return get().resolveInvite('', normalizeInviteCode(rawCode));
    },

    clearError: () => set({ error: null }),

    reset: () => set({ invites: [], friends: [], loading: false, error: null }),
}));
