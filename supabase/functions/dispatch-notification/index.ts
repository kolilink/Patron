import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import {
  EVENT_REGISTRY,
  ORDINARY_CAP,
  bypassesCap,
  bypassesQuietHours,
  isQuietHours,
  sanitizeDataPayload,
} from './registry.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';

// ─── Titles ───────────────────────────────────────────────────────────────
// Every event's title is the business name, EXCEPT chat_message, where the
// sender name IS the point (named exception to the lock-screen rule).
const EVENT_TITLES: Record<string, string> = {
  sale_completed: '✅ Vente enregistrée',
  sale_cancelled: '⚠️ Vente annulée',
  sale_edited: '✏️ Vente modifiée',
  low_stock: '📦 Stock bas', // product name is appended, e.g. "📦 Stock bas : Riz"
  partnership_request: '🤝 Demande de partenariat',
  partnership_accepted: '🤝 Partenariat accepté',
  support_message: '💬 Nouveau message',
  support_reply: '💬 Réponse du support',
  alpha_quota_reset: '✨ Alpha',
  daily_digest: '🌙 Votre journée',
  activation_nudge_1: '💰 Un client vous doit de l\'argent ?',
  activation_nudge_2: '⏰ Une minute suffit',
  // second_action_reminder's title is contextual (product/debt/sale) — see
  // SECOND_ACTION_TITLES and buildTitle below, not this fixed map.
  revenue_milestone: '🎉 Nouveau cap franchi',
  debt_aging_reminder: '💰 Un crédit vieillit',
};

const SECOND_ACTION_TITLES: Record<string, string> = {
  product: '📦 Premier produit ajouté',
  debt: '💰 Première dette notée',
  sale: '✅ Première vente notée',
};

function buildTitle(eventType: string, bizName: string, p: Record<string, unknown>): string {
  if (eventType === 'chat_message') return String(p.sender ?? bizName);
  if (eventType === 'low_stock') return `📦 Stock bas : ${p.product ?? ''}`;
  if (eventType === 'second_action_reminder') {
    return SECOND_ACTION_TITLES[String(p.action_type)] ?? '✅ Première action notée';
  }
  return EVENT_TITLES[eventType] ?? bizName;
}

// ─── iOS notification action categories ─────────────────────────────────────
// categoryIdentifier must match what's registered in NotificationSetup.tsx
const CATEGORY_MAP: Record<string, string> = {
  expense_submitted: 'expense_pending',
  chat_message: 'chat_incoming',
};

interface DispatchInput {
  business_id: string;
  event_type: string;
  payload: Record<string, unknown>;
  target_roles?: string[];
  target_user_ids?: string[];
  exclude_user_id?: string;
}

interface ExpoTicket {
  status: 'ok' | 'error';
  details?: { error?: string };
}

// Events where the caller legitimately dispatches to a business they are NOT
// a member of — the two partnership handshake notifications, sent to the
// *other* business in the relationship. Authorized instead via an actual
// business_partnerships row linking that business to one of the caller's own.
const CROSS_BUSINESS_EVENTS = new Set(['partnership_request', 'partnership_accepted']);

// The founder replying to a support thread is never a member of the
// merchant's business — authorized instead by matching profiles.phone,
// mirroring is_founder() in db/migration_v126.sql.
const FOUNDER_EVENTS = new Set(['support_reply']);

// Events dispatched by a background job, not a logged-in user — there is no
// session to hold a Bearer JWT, so these authenticate via a shared secret
// instead (see send-alpha-quota-reminders and send-daily-digest).
const CRON_EVENTS = new Set([
  'alpha_quota_reset', 'daily_digest',
  'activation_nudge_1', 'activation_nudge_2', 'second_action_reminder',
  'revenue_milestone', 'debt_aging_reminder',
]);

async function callerIsFounder(supabase: ReturnType<typeof createClient>, userId: string): Promise<boolean> {
  const { data: profile } = await supabase.from('profiles').select('phone').eq('id', userId).maybeSingle();
  const digits = ((profile as { phone: string | null } | null)?.phone ?? '').replace(/\D/g, '');
  return digits === '12672421843';
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const input = await req.json() as DispatchInput;
    let { payload } = input;
    const { business_id, event_type, target_roles, target_user_ids, exclude_user_id } = input;

    if (!business_id || !event_type) {
      return new Response(JSON.stringify({ error: 'Paramètres manquants' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Registry gate — an event_type not in EVENT_REGISTRY can never send,
    // full stop. This is the audited allowlist: every push this function is
    // capable of sending is named in registry.ts, with its audience,
    // category (for cap/quiet-hours), and fixed lock-screen copy.
    const eventDef = EVENT_REGISTRY[event_type];
    if (!eventDef) {
      return new Response(JSON.stringify({ error: `event_type non enregistré: ${event_type}` }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
    if (!eventDef.built) {
      // Reserved slot — copy/route exist for when the engine ships, but
      // nothing is ever sent. Logged as skipped, not an error, so a caller
      // that doesn't yet know an event is dormant doesn't see a failure.
      return new Response(JSON.stringify({ skipped: 'not_built' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // business_id is later string-interpolated into a PostgREST .or() filter
    // (the partnership authorization check). Reject anything that isn't a plain
    // UUID up front so no filter metacharacters can ever reach that expression
    // — defense-in-depth; a valid UUID has none.
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!UUID_RE.test(business_id)) {
      return new Response(JSON.stringify({ error: 'business_id invalide' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    // Cron-dispatched events (see CRON_EVENTS) skip the user-session check
    // entirely — a background job never holds a Bearer JWT. Fail closed: an
    // unset CRON_SECRET must never make isCronCall true.
    const cronSecret = Deno.env.get('CRON_SECRET');
    const isCronCall = CRON_EVENTS.has(event_type)
      && !!cronSecret
      && req.headers.get('x-cron-secret') === cronSecret;

    let callerUserId: string | null = null;
    if (!isCronCall) {
      const authHeader = req.headers.get('Authorization');
      if (!authHeader?.startsWith('Bearer ')) {
        return new Response(JSON.stringify({ error: 'Non authentifié' }), {
          status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      const userClient = createClient(
        Deno.env.get('SUPABASE_URL')!,
        Deno.env.get('SUPABASE_ANON_KEY')!,
        { global: { headers: { Authorization: authHeader } } },
      );
      const { data: { user }, error: userErr } = await userClient.auth.getUser();
      if (userErr || !user) {
        return new Response(JSON.stringify({ error: 'Session invalide' }), {
          status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      callerUserId = user.id;
    }

    // Caller must either belong to the business they're dispatching for, or
    // (for the partnership handshake events only) have an actual partnership
    // row linking one of their own businesses to this one — unless it's a
    // trusted cron call, which is authorized by the secret alone.
    let authorized = isCronCall;
    if (!authorized) {
      const { data: callerMemberships } = await supabase
        .from('memberships')
        .select('business_id')
        .eq('user_id', callerUserId!);
      const callerBusinessIds = (callerMemberships ?? []).map((m: { business_id: string }) => m.business_id);

      authorized = callerBusinessIds.includes(business_id);
      if (!authorized && CROSS_BUSINESS_EVENTS.has(event_type) && callerBusinessIds.length > 0) {
        const { count } = await supabase
          .from('business_partnerships')
          .select('id', { count: 'exact', head: true })
          .or(
            `and(requester_id.eq.${business_id},recipient_id.in.(${callerBusinessIds.join(',')})),`
            + `and(recipient_id.eq.${business_id},requester_id.in.(${callerBusinessIds.join(',')}))`,
          );
        authorized = (count ?? 0) > 0;
      }
      if (!authorized && FOUNDER_EVENTS.has(event_type)) {
        authorized = await callerIsFounder(supabase, callerUserId!);
      }
    }
    if (!authorized) {
      return new Response(JSON.stringify({ error: 'Accès refusé' }), {
        status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Validate business + get name for the notification title
    const { data: biz } = await supabase
      .from('businesses')
      .select('id, name')
      .eq('id', business_id)
      .maybeSingle();
    if (!biz) {
      return new Response(JSON.stringify({ error: 'Business introuvable' }), {
        status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const bizName = (biz as { name: string }).name || 'Patron';

    // Auto-inject business name for member_removed
    if (event_type === 'member_removed' && !payload.business) {
      payload = { ...payload, business: bizName };
    }

    // Low stock: 24h cooldown per product per business
    if (event_type === 'low_stock' && payload.product_id) {
      const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const { count } = await supabase
        .from('notification_log')
        .select('*', { count: 'exact', head: true })
        .eq('business_id', business_id)
        .eq('event_type', 'low_stock')
        .contains('payload', { product_id: payload.product_id })
        .gte('sent_at', since);
      if ((count ?? 0) > 0) {
        return new Response(JSON.stringify({ skipped: 'cooldown' }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
    }

    // Resolve recipients
    let userIds: string[] = target_user_ids ?? [];
    if (event_type === 'support_message') {
      // Always routes to the founder himself, regardless of any target_roles/
      // target_user_ids the caller passed — he is not a member of business_id,
      // so the memberships-based resolution below can never find him.
      const { data: founderId } = await supabase.rpc('get_founder_id');
      userIds = founderId ? [founderId as string] : [];
    } else if (userIds.length === 0 && target_roles?.length) {
      const { data: members } = await supabase
        .from('memberships')
        .select('user_id')
        .eq('business_id', business_id)
        .in('role', target_roles);
      userIds = (members ?? []).map((m: { user_id: string }) => m.user_id);
    } else if (userIds.length > 0) {
      // Caller-supplied recipient list — restrict to real members of this
      // business so a caller can never target an arbitrary user_id.
      const { data: members } = await supabase
        .from('memberships')
        .select('user_id')
        .eq('business_id', business_id)
        .in('user_id', userIds);
      userIds = (members ?? []).map((m: { user_id: string }) => m.user_id);
    }
    if (exclude_user_id) userIds = userIds.filter(id => id !== exclude_user_id);
    if (userIds.length === 0) {
      return new Response(JSON.stringify({ sent: 0 }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Server-side cap: max ORDINARY_CAP ordinary/money pushes per recipient
    // per rolling 24h. Security events always bypass it. Recipients already
    // at their cap are dropped from this send (not the whole dispatch) —
    // everyone else still gets notified.
    if (!bypassesCap(eventDef.category)) {
      const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const { data: recentRows } = await supabase
        .from('push_recipient_log')
        .select('user_id')
        .in('user_id', userIds)
        .in('category', ['ordinary', 'money'])
        .gte('sent_at', since);
      const countByUser = new Map<string, number>();
      for (const row of (recentRows ?? []) as { user_id: string }[]) {
        countByUser.set(row.user_id, (countByUser.get(row.user_id) ?? 0) + 1);
      }
      userIds = userIds.filter(id => (countByUser.get(id) ?? 0) < ORDINARY_CAP);
    }
    if (userIds.length === 0) {
      return new Response(JSON.stringify({ sent: 0, skipped: 'cap' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Fetch device tokens (with owning user_id — needed to stamp each push
    // with that user's own running unread count, not a shared value — and
    // timezone, needed for the per-device quiet-hours check below)
    const { data: tokenRows } = await supabase
      .from('device_tokens')
      .select('token, user_id, timezone')
      .in('user_id', userIds);
    let tokens = (tokenRows ?? []) as { token: string; user_id: string; timezone: string | null }[];

    // Quiet hours (21:00–07:00 in the RECIPIENT'S OWN device timezone,
    // falling back to UTC — a null timezone means the device predates
    // migration_v154.sql and reproduces the exact original UTC-only
    // behavior). Checked per-device, not once for the whole dispatch, since
    // two recipients of the same push can be in different timezones.
    // Non-security, non-money events are dropped outright for a device
    // whose local time falls in the window, rather than held for
    // redelivery — there is no deferred-delivery queue/cron built yet (see
    // registry.ts's dormant engines). Security bypasses this entirely;
    // money movement (a completed/cancelled/edited sale, a paid credit) is
    // allowed through so it isn't silently lost.
    if (!bypassesQuietHours(eventDef.category)) {
      const now = new Date();
      tokens = tokens.filter(t => !isQuietHours(now, t.timezone));
    }

    if (tokens.length === 0) {
      await supabase.from('notification_log').insert({ business_id, event_type, payload, recipient_count: 0 });
      return new Response(JSON.stringify({ sent: 0, skipped: 'quiet_hours' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Atomically bump each recipient's server-tracked unread count and use
    // the real running total as that user's badge number (see migration_v137.sql —
    // this used to be hardcoded to 1 on every push, which reset the OS icon
    // instead of accumulating it).
    const recipientUserIds = [...new Set(tokens.map(t => t.user_id))];
    const { data: badgeRows } = await supabase.rpc('increment_unread_notifications', {
      p_user_ids: recipientUserIds,
    });
    const badgeByUser = new Map(
      ((badgeRows ?? []) as { id: string; unread_notification_count: number }[])
        .map(r => [r.id, r.unread_notification_count]),
    );

    // Build notification fields — title/body/route/urgency all come from the
    // registry's FIXED templates (lock-screen rule: no client name or amount
    // ever leaves the server for these). `data` is whitelist-sanitized too —
    // it is never just `...payload` anymore.
    const title = buildTitle(event_type, bizName, payload);
    const subtitle = eventDef.subtitle;
    const body = eventDef.body(payload);
    const route = eventDef.route(payload);
    const safeData = sanitizeDataPayload(event_type, payload);
    const isUrgent = eventDef.urgent;
    const soundFile = isUrgent ? 'patron_urgent.wav' : 'patron_default.wav';
    const channelId = isUrgent ? 'patron_urgent' : 'patron_default';
    const categoryId = CATEGORY_MAP[event_type];

    const CHUNK = 100;
    const staleTokens: string[] = [];

    for (let i = 0; i < tokens.length; i += CHUNK) {
      const chunk = tokens.slice(i, i + CHUNK);
      const messages = chunk.map(({ token: to, user_id }) => ({
        to,
        title,
        ...(subtitle ? { subtitle } : {}),
        body,
        data: { route, event_type, business_id, ...safeData },
        sound: soundFile,
        channelId,
        badge: badgeByUser.get(user_id) ?? 1,
        ...(categoryId ? { categoryIdentifier: categoryId } : {}),
        ...(isUrgent ? { _interruptionLevel: 'time-sensitive' } : {}),
      }));

      const resp = await fetch(EXPO_PUSH_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(messages),
      });

      if (resp.ok) {
        const result = await resp.json() as { data: ExpoTicket[] };
        result.data?.forEach((ticket, idx) => {
          if (ticket.status === 'error' && ticket.details?.error === 'DeviceNotRegistered') {
            staleTokens.push(chunk[idx].token);
          }
        });
      }
    }

    if (staleTokens.length > 0) {
      await supabase.from('device_tokens').delete().in('token', staleTokens);
    }

    await supabase.from('notification_log').insert({
      business_id, event_type, payload, recipient_count: tokens.length,
    });

    // Per-recipient rows feed the cap check above — only recorded for
    // categories the cap actually applies to (ordinary/money); security
    // bypasses the cap so there's nothing useful to log against it.
    if (eventDef.category !== 'security') {
      await supabase.from('push_recipient_log').insert(
        [...new Set(tokens.map(t => t.user_id))].map(user_id => ({
          user_id, event_type, category: eventDef.category,
        })),
      );
    }

    return new Response(JSON.stringify({ sent: tokens.length }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Erreur inconnue';
    console.error('dispatch-notification crash:', msg);
    return new Response(JSON.stringify({ error: msg }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
