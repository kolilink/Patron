import { supabase } from '@/lib/supabase';
import { isNetworkError, withTimeout } from '@/lib/sync';
import { getPendingInviterId, clearPendingInviterId } from '@/lib/inviteLink';

// ─── Word-of-mouth invite ───────────────────────────────────────────────────
// "I love this app, try it." The invite is a plain link carrying the sharer's
// own user id — no code, no expiry, no single use. The server side is
// db/migration_v236.sql (preview_inviter for the landing page,
// record_invite_attribution for the silent attribution below). Distinct from
// the staff join codes (stores/equipe.ts → rejoindre), which are untouched.

const INVITE_BASE_URL = 'https://patron.kolilink.com/invite';

/**
 * The share link for a given inviter (their own user id), in the `?i=` form:
 *   https://patron.kolilink.com/invite/?i=<uuid>
 * NOT the bare path /invite/<uuid>: the site is GitHub Pages, which has no
 * file at that path and answers HTTP 404, and WhatsApp's crawler will not
 * build a preview card for a non-200 URL (og tags are irrelevant on a 404).
 * The ?i= form is a real page (invite/index.html) that returns 200 with the
 * og tags. Old path-form links still work for people (404.html forwards them
 * to ?i=) and in the app (lib/inviteLink.ts accepts both forms).
 */
export function buildInviteLink(inviterId: string): string {
    return `${INVITE_BASE_URL}/?i=${encodeURIComponent(inviterId)}`;
}

/** The prefilled, editable share message. */
export function buildInviteMessage(link: string): string {
    return `Je note mes ventes et mes crédits avec Patron, même sans internet et c’est gratuit : ${link}`;
}

/**
 * Record, silently, who invited this user. Safe to call on every launch: it
 * does nothing without a pending inviter id, clears the id on any definitive
 * server answer (recorded, self-invite, unknown inviter), and keeps it only
 * on a network failure so the next launch retries. Never throws, never shows
 * UI — attribution must not be able to interrupt onboarding.
 */
export async function recordPendingInviteAttribution(): Promise<void> {
    try {
        const inviterId = await getPendingInviterId();
        if (!inviterId) return;
        const { error } = await withTimeout(
            supabase.rpc('record_invite_attribution', { p_inviter_id: inviterId }),
        );
        if (error) {
            if (isNetworkError(error)) return;
            // failure: silent — attribution is best-effort and never user-facing
        }
        await clearPendingInviterId();
    } catch {
        // failure: silent — network/timeout keeps the id for the next launch
    }
}
