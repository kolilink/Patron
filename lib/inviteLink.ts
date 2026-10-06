import * as Linking from 'expo-linking';
import { trackEvent } from '@/lib/analytics';
import * as Application from 'expo-application';
import { Platform } from 'react-native';
import { getKV, setKV } from '@/lib/db';

// ─── Invite-link capture (word-of-mouth) ────────────────────────────────────
//
// A shared link is https://patron.kolilink.com/invite/?i=<inviter-id> (the
// sharer's own user id). The id reaches a fresh install through independent
// channels, each fallible and non-destructive:
//
//   1. Universal Link / App Link / custom scheme — expo-linking initial URL.
//      Only present when the app was opened from the link while installed.
//   2. Android Play Install Referrer — `referrer=patron_invite=<id>` survives
//      the Play Store install and is readable at first launch.
//   No clipboard handoff: nothing writes to or reads the clipboard, so iOS
//   cold installs (App Store, link never opened in-app) are unattributable.
//
// The first id found is persisted in the SQLite kv_store and attributed
// silently after onboarding (stores/inviter.ts). No id simply means a normal
// sign-up — never a dead end.

const PENDING_KEY = 'invite_pending_inviter';
const INVITE_ORIGIN = 'patron.kolilink.com';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isInviterId(value: string | null | undefined): value is string {
  return !!value && UUID_RE.test(value.trim());
}

// Accepted forms (our own origin/scheme only, so a foreign link can't plant an id):
//   https://patron.kolilink.com/invite/?i=<id>   (what the app shares — a 200 page, so WhatsApp previews it)
//   https://patron.kolilink.com/invite/<id>      (older shared links)
//   patron://invite/<id>   and   patron://invite?i=<id>
export function inviterIdFromUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    const hostOk = parsed.hostname === INVITE_ORIGIN;
    const schemeOk = parsed.protocol === 'patron:';
    if (!hostOk && !schemeOk) return null;
    // https → pathname "/invite/<id>"; custom scheme → host "invite", pathname "/<id>".
    const segments = [schemeOk ? parsed.hostname : '', ...parsed.pathname.split('/')].filter(Boolean);
    const i = segments.indexOf('invite');
    if (i < 0) return null;
    // Path form first, then the ?i= query form. Only read under the /invite
    // path, so `?i=` on some other page of ours can't plant an id.
    const fromPath = segments[i + 1]?.trim().toLowerCase();
    if (isInviterId(fromPath)) return fromPath;
    const fromQuery = parsed.searchParams.get('i')?.trim().toLowerCase();
    return isInviterId(fromQuery) ? fromQuery : null;
  } catch {
    return null;
  }
}

// Android Play Install Referrer payload is `patron_invite=<id>`.
export function inviterIdFromReferrer(referrer: string | null): string | null {
  if (!referrer) return null;
  try {
    const parsed = new URL(`https://x/?${referrer}`);
    const id = parsed.searchParams.get('patron_invite')?.trim().toLowerCase();
    return isInviterId(id) ? id : null;
  } catch {
    return null;
  }
}

/** Read every cold-start channel once and persist the first inviter id found. */
export async function capturePendingInviterId(): Promise<string | null> {
  try {
    const existing = await getKV(PENDING_KEY);
    if (existing) return existing;

    let id: string | null = null;

    try {
      id = inviterIdFromUrl(await Linking.getInitialURL());
    } catch {
      /* ignore */
    }

    if (!id && Platform.OS === 'android') {
      try {
        id = inviterIdFromReferrer(await Application.getInstallReferrerAsync());
      } catch {
        /* ignore */
      }
    }

    if (id) {
      await setKV(PENDING_KEY, id);
      trackEvent('invite_opened', null, null, { source: 'deferred' });
      return id;
    }
    return null;
  } catch {
    return null;
  }
}

/** Persist an id arriving from an already-running deep link (app/invite). */
export async function setPendingInviterId(id: string): Promise<void> {
  try {
    await setKV(PENDING_KEY, id);
  } catch {
    /* ignore */
  }
}

/** The persisted pending inviter id, if any. */
export async function getPendingInviterId(): Promise<string | null> {
  try {
    const v = await getKV(PENDING_KEY);
    return isInviterId(v) ? v : null;
  } catch {
    return null;
  }
}

/** Clear the persisted id (KV has no delete; empty string = absent). */
export async function clearPendingInviterId(): Promise<void> {
  try {
    await setKV(PENDING_KEY, '');
  } catch {
    /* ignore */
  }
}
