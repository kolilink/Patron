// Audited notification registry — the single source of truth for every event
// type dispatch-notification is allowed to push. An event_type not listed
// here is rejected outright (see index.ts). Plain TS, no Deno-only APIs, so
// it can be unit-tested under the app's normal Jest/ts-jest setup.
//
// Lock-screen rule: `body`/`subtitle` are FIXED templates. The only payload
// fields ever allowed to appear in a template, or in the `data` object sent
// to Expo (which some Android/lock-screen configurations do surface), are
// listed in `allowedDataKeys` — always just IDs for deep-linking, plus the
// three named exceptions: {product} (low_stock), {business} (partnership),
// {sender}/{preview} (chat_message). No client name and no amount is ever
// allowed to leave the server for any event type.

export type EventCategory = 'security' | 'money' | 'ordinary';

export interface EventDef {
  // false = accepted, logged, never actually sent — reserves the slot (copy
  // + route) for an engine that doesn't exist yet (no schema/cron/client UI).
  built: boolean;
  category: EventCategory;
  subtitle: string | null;
  body: (p: Record<string, unknown>) => string;
  route: (p: Record<string, unknown>) => string;
  urgent: boolean;
  // Keys allowed to survive into the Expo `data` payload. Never a name or
  // an amount — see the lock-screen rule above.
  allowedDataKeys: string[];
  notBuiltReason?: string;
}

const generic = (text: string) => () => text;
const routeWithId = (base: string, idKey: string) =>
  (p: Record<string, unknown>) => p[idKey] ? `${base}/${p[idKey]}` : base;

export const EVENT_REGISTRY: Record<string, EventDef> = {
  // ── 1-4, money/ordinary, admin+manager ──────────────────────────────────
  sale_completed: {
    built: true,
    category: 'money',
    subtitle: null,
    body: generic('Touchez pour voir le détail.'),
    route: routeWithId('/(app)/ventes', 'sale_id'),
    urgent: false,
    allowedDataKeys: ['sale_id'],
  },
  sale_cancelled: {
    built: true,
    category: 'money',
    subtitle: null,
    body: generic('Une vente a été annulée. Touchez pour vérifier.'),
    route: routeWithId('/(app)/ventes', 'sale_id'),
    urgent: true,
    allowedDataKeys: ['sale_id'],
  },
  sale_edited: {
    built: false,
    notBuiltReason: 'No client caller for edit_sale exists in this repo — edit-sale UI is not built.',
    category: 'money',
    subtitle: null,
    body: generic('Une vente a été modifiée. Touchez pour voir.'),
    route: routeWithId('/(app)/ventes', 'sale_id'),
    urgent: false,
    allowedDataKeys: ['sale_id'],
  },
  low_stock: {
    built: true,
    category: 'ordinary',
    subtitle: null,
    body: () => 'Pensez à recommander.',
    route: routeWithId('/(app)/catalogue', 'product_id'),
    urgent: true,
    allowedDataKeys: ['product_id', 'product'], // {product} is a named exception
  },
  // price_changed is deliberately absent from push entirely — demoted to an
  // in-app activity feed item. Registered as built:false so any future call
  // site can never accidentally push it.
  price_changed: {
    built: false,
    notBuiltReason: 'Demoted to in-app activity feed only — never a push, by design.',
    category: 'ordinary',
    subtitle: null,
    body: () => '',
    route: routeWithId('/(app)/catalogue', 'product_id'),
    urgent: false,
    allowedDataKeys: ['product_id'],
  },

  // ── 6-7 partnership ──────────────────────────────────────────────────────
  partnership_request: {
    built: true,
    category: 'ordinary',
    subtitle: null,
    body: (p) => `${p.business ?? 'Une boutique'} veut se connecter. Touchez pour répondre.`,
    route: () => '/(app)/discussions',
    urgent: false,
    allowedDataKeys: ['business'], // {business} is a named exception
  },
  partnership_accepted: {
    built: true,
    category: 'ordinary',
    subtitle: null,
    body: (p) => `${p.business ?? 'Une boutique'} a accepté. Touchez pour voir.`,
    route: () => '/(app)/discussions',
    urgent: false,
    allowedDataKeys: ['business'],
  },

  // ── 8-9 support ──────────────────────────────────────────────────────────
  support_message: {
    built: true,
    category: 'ordinary',
    subtitle: null,
    body: generic('Un commerçant vous a écrit. Touchez pour répondre.'),
    route: () => '/(app)/support-inbox',
    urgent: true,
    allowedDataKeys: [],
  },
  support_reply: {
    built: true,
    category: 'ordinary',
    subtitle: null,
    body: generic('Patron vous a répondu. Touchez pour lire.'),
    route: () => '/(app)/support',
    urgent: true,
    allowedDataKeys: [],
  },

  // ── 10 chat ──────────────────────────────────────────────────────────────
  chat_message: {
    built: true,
    category: 'ordinary',
    subtitle: null,
    // {sender} in the title and {snippet} in the body are the named
    // exceptions — the title is handled specially in index.ts (uses sender
    // instead of the business name) since it's the one event where that's
    // the whole point of the notification.
    body: (p) => String(p.snippet ?? '').slice(0, 80),
    route: () => '/(app)/discussions',
    urgent: true,
    allowedDataKeys: ['sender'],
  },

  // ── 11-17 dormant — no engine exists yet, copy/route reserved ──────────
  alpha_quota_reset: {
    built: false,
    notBuiltReason: 'No schema/cron exists — alpha_quota tracking + reset detection never built.',
    category: 'ordinary',
    subtitle: null,
    body: generic('Vous pouvez parler à Alpha maintenant.'),
    route: () => '/(app)/alpha',
    urgent: false,
    allowedDataKeys: [],
  },
  daily_digest: {
    // The aggregation RPC and edge function already exist (migration_v139.sql,
    // send-daily-digest) — the only missing piece was the pg_cron schedule
    // (migration_v152.sql adds it). Deploy note: send-daily-digest and
    // learn-digest-send-hours must be deployed with --no-verify-jwt and
    // smoke-tested (see CLAUDE.md's OTA/cron deploy gate) before this is
    // truly live — that deploy step is outside what this pass can execute.
    built: true,
    category: 'ordinary',
    subtitle: null,
    body: (p) => p.tier === 'bonne'
      ? 'La journée est bonne. Touchez pour voir vos chiffres.'
      : 'La journée était calme. On se retrouve demain.',
    route: () => '/(app)/rapports',
    urgent: false,
    allowedDataKeys: [],
  },
  activation_nudge_1: {
    built: false,
    notBuiltReason: 'No signup-timestamp-driven activation engine/cron exists.',
    category: 'ordinary',
    subtitle: null,
    body: generic('Notez-le, ça prend environ 30 secondes.'),
    route: () => '/(app)/(tabs)/vendre?mode=credit',
    urgent: false,
    allowedDataKeys: [],
  },
  activation_nudge_2: {
    built: false,
    notBuiltReason: 'No signup-timestamp-driven activation engine/cron exists.',
    category: 'ordinary',
    subtitle: null,
    body: generic('Notez votre première vente — Patron s\'occupe du reste.'),
    route: () => '/(app)/(tabs)/vendre',
    urgent: false,
    allowedDataKeys: [],
  },
  second_action_reminder: {
    built: false,
    notBuiltReason: 'No first-action classification engine exists.',
    category: 'ordinary',
    subtitle: null,
    body: (p) => {
      if (p.action_type === 'product') return 'Vous pouvez aussi noter vos ventes.';
      if (p.action_type === 'debt') return 'Vous pouvez aussi noter vos ventes.';
      return 'Prêt pour la suivante ?';
    },
    route: () => '/(app)/(tabs)/vendre',
    urgent: false,
    allowedDataKeys: ['action_type'],
  },
  revenue_milestone: {
    built: false,
    notBuiltReason: 'No cumulative-sales/threshold-ladder tracking exists.',
    category: 'ordinary',
    subtitle: null,
    body: generic('Fier de vous, patron — continuez comme ça.'),
    route: () => '/(app)/rapports',
    urgent: false,
    allowedDataKeys: [],
  },
  debt_aging_reminder: {
    built: false,
    notBuiltReason: 'No debt-age computation/per-debt throttle exists; Rappeler sheet does not exist.',
    category: 'ordinary',
    subtitle: null,
    body: generic('Touchez pour le relancer en un message.'),
    route: routeWithId('/(app)/clients', 'client_id'),
    urgent: false,
    allowedDataKeys: ['client_id'],
  },

  // ── Grandfathered — already live, unchanged copy/audience, added only so
  // the "unlisted types cannot send" rule doesn't retroactively break them ──
  credit_paid: {
    built: true, category: 'money', subtitle: 'Crédit soldé',
    body: (p) => `${p.customer} — ${p.amount}`,
    route: () => '/(app)/ventes', urgent: false, allowedDataKeys: ['customer', 'amount'],
  },
  expense_submitted: {
    built: true, category: 'ordinary', subtitle: 'Dépense en attente',
    body: (p) => `${p.name} · ${p.amount} — ${p.description}`,
    route: () => '/(app)/depenses', urgent: false, allowedDataKeys: ['name', 'amount', 'description'],
  },
  expense_approved: {
    built: true, category: 'ordinary', subtitle: 'Dépense validée',
    body: (p) => `${p.amount} — ${p.description}`,
    route: () => '/(app)/depenses', urgent: true, allowedDataKeys: ['amount', 'description'],
  },
  expense_rejected: {
    built: true, category: 'ordinary', subtitle: 'Dépense refusée',
    body: (p) => `${p.amount} — ${p.description}`,
    route: () => '/(app)/depenses', urgent: true, allowedDataKeys: ['amount', 'description'],
  },
  member_joined: {
    built: true, category: 'ordinary', subtitle: 'Équipe',
    body: (p) => `${p.name} · ${p.role}`,
    route: () => '/(app)/equipe', urgent: false, allowedDataKeys: ['name', 'role'],
  },
  role_changed: {
    built: true, category: 'security', subtitle: 'Votre compte',
    body: (p) => `Vous êtes maintenant ${p.role}`,
    route: () => '/(app)/equipe', urgent: true, allowedDataKeys: ['role'],
  },
  member_removed: {
    built: true, category: 'security', subtitle: 'Votre compte',
    body: generic('Vous avez été retiré'),
    route: () => '/(app)/equipe', urgent: true, allowedDataKeys: ['business'],
  },
  po_received: {
    built: true, category: 'ordinary', subtitle: 'Livraison',
    body: (p) => `${p.N} article${Number(p.N) > 1 ? 's' : ''} de ${p.supplier}`,
    route: () => '/(app)/fournisseurs', urgent: false, allowedDataKeys: ['N', 'supplier'],
  },
};

export const ORDINARY_CAP = 3; // max ordinary/money pushes per user per rolling 24h
export const QUIET_HOURS_START = 21; // local-hour window, 21:00-07:00
export const QUIET_HOURS_END = 7;
// Backward-compatible aliases — the window was originally documented as a
// flat UTC constant (correct only because Guinea has no DST and is UTC+0).
export const QUIET_HOURS_START_UTC = QUIET_HOURS_START;
export const QUIET_HOURS_END_UTC = QUIET_HOURS_END;

export const DEFAULT_TIMEZONE = 'UTC';

// Returns the recipient's local hour (0-23) in `timezone`, falling back to
// UTC when unknown/invalid — `timezone` is expected to be a device-reported
// IANA zone (device_tokens.timezone, migration_v154.sql), null for any
// token registered before that shipped. Never throws: an invalid zone
// string (a device reporting garbage) degrades to UTC rather than crashing
// the whole dispatch.
export function localHour(date: Date, timezone?: string | null): number {
  const tz = timezone || DEFAULT_TIMEZONE;
  try {
    const hourStr = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hour: 'numeric', hour12: false,
    }).format(date);
    // Intl can format midnight as "24" in some environments — normalize.
    return parseInt(hourStr, 10) % 24;
  } catch {
    return date.getUTCHours();
  }
}

// Takes the recipient's device timezone (IANA string) as a parameter,
// defaulting to UTC when unknown — this is what makes the 21:00-07:00
// wind-down window mean the recipient's actual local night, not a flat UTC
// window that's only correct for Guinea. Passing no timezone (or null,
// the value every pre-migration_v154 device_tokens row has) reproduces the
// exact original UTC-only behavior — no change for current users until
// their device re-registers with a real zone.
export function isQuietHours(date: Date, timezone?: string | null): boolean {
  const h = localHour(date, timezone);
  return h >= QUIET_HOURS_START || h < QUIET_HOURS_END;
}

// Security bypasses both the cap and quiet hours. Money movement is capped
// like everything else but may still send during quiet hours. Ordinary is
// subject to both.
export function bypassesCap(category: EventCategory): boolean {
  return category === 'security';
}
export function bypassesQuietHours(category: EventCategory): boolean {
  return category === 'security' || category === 'money';
}

export function sanitizeDataPayload(
  eventType: string,
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const def = EVENT_REGISTRY[eventType];
  if (!def) return {};
  const out: Record<string, unknown> = {};
  for (const key of def.allowedDataKeys) {
    if (payload[key] !== undefined) out[key] = payload[key];
  }
  return out;
}
