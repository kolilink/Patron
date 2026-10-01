import * as Linking from 'expo-linking';
import { trackEvent } from '@/lib/analytics';
import * as Clipboard from 'expo-clipboard';
import * as Application from 'expo-application';
import { Platform } from 'react-native';
import { getKV, setKV } from '@/lib/db';

// ─── Invite-link token capture (Phase 2 client half + Phase 5 arrival) ──────
//
// An invite token reaches a fresh install through several independent channels,
// each with its own timing:
//
//   1. Universal Link / App Link  — expo-linking initial URL
//      (`https://patron.kolilink.com/invite?t=…` or `patron://invite?t=…`).
//      Only present when the app was opened from the link while installed.
//   2. Android Play Install Referrer — the Play Store carries `referrer=…`
//      through the install; readable at first launch via expo-application's
//      getInstallReferrerAsync() before any deep link ever fires.
//   3. iOS clipboard handoff — the WhatsApp bridge page copies the store link
//      (the only "deep link" iOS gets without Universal Links); we read the
//      clipboard once at first launch and recognise our own invite URL.
//
// Each source is non-destructive and fallible (web stub, permission, cold
// cache). We read all of them exactly once, prefer whichever actually yields
// a token, and persist it in the SQLite kv_store so the OTP-onboarding flow
// (app/(welcome)/creer.tsx) can consume it *after* phone verification — long
// after this cold-start probe has run. The consumer never sees a dead end:
// no token simply means a normal sign-up into the generic Home.

const PENDING_KEY = 'invite_pending_token';

const INVITE_ORIGIN = 'patron.kolilink.com';
// Both link forms carry the token as ?t=… :
//   https://patron.kolilink.com/invite?t=<token>
//   patron://invite?t=<token>
function tokenFromUrl(url: string | null | undefined): string | null {
    if (!url) return null;
    try {
        const parsed = new URL(url);
        const t = parsed.searchParams.get('t')?.trim();
        if (!t) return null;
        // Accept only our own origins/schemes so a foreign ?t= link can't
        // plant a token. Custom scheme parses with protocol 'patron:'.
        const hostOk = parsed.hostname === INVITE_ORIGIN;
        const schemeOk = parsed.protocol === 'patron:';
        if (!hostOk && !schemeOk) return null;
        return t.length >= 16 ? t : null;
    } catch {
        return null;
    }
}

// Android Play Install Referrer payload is `patron_invite=<token>` (see the
// invite edge function's playStoreUrl()).
function tokenFromReferrer(referrer: string | null): string | null {
    if (!referrer) return null;
    try {
        const parsed = new URL(`https://x/?${referrer}`);
        const t = parsed.searchParams.get('patron_invite')?.trim();
        return t && t.length >= 16 ? t : null;
    } catch {
        return null;
    }
}

/** Read every cold-start channel once and persist the first token found. */
export async function capturePendingInviteToken(): Promise<string | null> {
    try {
        // A token may already be persisted (e.g. this is a re-launch after the
        // install-referrer read). Reuse it instead of re-reading clipboard.
        const existing = await getKV(PENDING_KEY);
        if (existing) return existing;

        let token: string | null = null;

        // 1. Deep link that opened this exact cold start.
        try {
            token = tokenFromUrl(await Linking.getInitialURL());
        } catch {
            /* ignore */
        }

        // 2. Android deferred deep link via Play Install Referrer.
        if (!token && Platform.OS === 'android') {
            try {
                token = tokenFromReferrer(await Application.getInstallReferrerAsync());
            } catch {
                /* ignore */
            }
        }

        // 3. iOS clipboard handoff (WhatsApp bridge copies the store URL).
        if (!token && Platform.OS === 'ios') {
            try {
                if (await Clipboard.hasStringAsync()) {
                    token = tokenFromUrl(await Clipboard.getStringAsync());
                }
            } catch {
                /* ignore */
            }
        }

        if (token) {
            await setKV(PENDING_KEY, token);
            // Deferred channel (install referrer / clipboard) — the link was
            // opened before the app was installed.
            trackEvent('invite_opened', null, null, { source: 'deferred' });
            return token;
        }
        return null;
    } catch {
        return null;
    }
}

/** Persist a token arriving from an already-running deep link (app/invite.tsx). */
export async function setPendingInviteToken(token: string): Promise<void> {
    try {
        await setKV(PENDING_KEY, token);
    } catch {
        /* ignore */
    }
}

/** The persisted pending token, if any — read by the post-OTP onboarding. */
export async function getPendingInviteToken(): Promise<string | null> {
    try {
        return await getKV(PENDING_KEY);
    } catch {
        return null;
    }
}

/** Clear the persisted token (KV has no delete; empty string = absent). */
export async function clearPendingInviteToken(): Promise<void> {
    try {
        await setKV(PENDING_KEY, '');
    } catch {
        /* ignore */
    }
}
