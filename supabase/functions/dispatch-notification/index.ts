import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';

// ─── Deep-link routing ───────────────────────────────────────────────────────
const ROUTE_MAP: Record<string, string> = {
  sale_completed:    '/(app)/ventes',
  sale_cancelled:    '/(app)/ventes',
  credit_paid:       '/(app)/ventes',
  expense_submitted: '/(app)/depenses',
  expense_approved:  '/(app)/depenses',
  expense_rejected:  '/(app)/depenses',
  low_stock:         '/(app)/catalogue',
  member_joined:     '/(app)/equipe',
  role_changed:      '/(app)/equipe',
  member_removed:    '/(app)/equipe',
  chat_message:          '/(app)/discussions',
  partnership_request:   '/(app)/discussions',
  partnership_accepted:  '/(app)/discussions',
  po_received:           '/(app)/fournisseurs',
  support_message:       '/(app)/support-inbox',
  support_reply:         '/(app)/support',
  alpha_quota_reset:     '/(app)/alpha',
  daily_digest:          '/(app)/rapports',
};

// ─── Three-line format ───────────────────────────────────────────────────────
// Title   = business name  (set in message construction, not here)
// Subtitle = event category in French (context — what kind of event)
// Body     = the core fact (who/what + the key number + brief context)

const SUBTITLE_MAP: Record<string, string | null> = {
  sale_completed:    null, // body already says "a vendu" — a "Vente" subtitle was redundant
  sale_cancelled:    'Vente annulée',
  credit_paid:       'Crédit soldé',
  expense_submitted: 'Dépense en attente',
  expense_approved:  'Dépense validée',
  expense_rejected:  'Dépense refusée',
  low_stock:         'Stock critique',
  member_joined:     'Équipe',
  role_changed:      'Votre compte',
  member_removed:    'Votre compte',
  chat_message:          null, // sender name IS the context — no subtitle needed
  partnership_request:   'Amis',
  partnership_accepted:  'Amis',
  po_received:           'Livraison',
  support_message:       null, // body is a self-explanatory full sentence — no subtitle needed
  support_reply:         null, // body is a self-explanatory full sentence — no subtitle needed
  alpha_quota_reset:     null, // body is a self-explanatory full sentence — no subtitle needed
  daily_digest:          null, // body is a self-explanatory full sentence — no subtitle needed
};

function buildBody(eventType: string, p: Record<string, string | number>): string {
  switch (eventType) {
    // Subtitle carries the "Vente" label — body is: seller a vendu {desc} pour {amount}
    case 'sale_completed':
      return `${p.seller} a vendu ${p.desc} pour ${p.amount}`;
    // Subtitle carries "Vente annulée" — body is: amount and reason if any
    case 'sale_cancelled':
      return `${p.amount}${p.reason ? ` — ${p.reason}` : ''}`;
    // Subtitle carries "Crédit soldé" — body: client and amount
    case 'credit_paid':
      return `${p.customer} — ${p.amount}`;
    // Subtitle carries "Dépense en attente" — body: who · amount — description
    case 'expense_submitted':
      return `${p.name} · ${p.amount} — ${p.description}`;
    // Subtitle carries result — body: amount and description
    case 'expense_approved':
    case 'expense_rejected':
      return `${p.amount} — ${p.description}`;
    // Subtitle carries "Stock critique" — body: flat, no pronoun, fast to scan
    case 'low_stock':
      return `Il reste ${p.qty} ${p.product} en stock`;
    // Subtitle carries "Équipe" — body: name and role
    case 'member_joined':
      return `${p.name} · ${p.role}`;
    // Subtitle carries "Votre compte" — body: direct statement
    case 'role_changed':
      return `Vous êtes maintenant ${p.role}`;
    case 'member_removed':
      return 'Vous avez été retiré';
    // No subtitle — body carries everything: sender · preview
    case 'chat_message':
      return `${p.sender} · ${p.preview}`;
    case 'partnership_request':
      return `${p.sender_name} vous a envoyé une demande d'ami`;
    case 'partnership_accepted':
      return `${p.acceptor_name} a accepté votre demande`;
    // Subtitle carries "Livraison" — body: count and supplier
    case 'po_received':
      return `${p.N} article${Number(p.N) > 1 ? 's' : ''} de ${p.supplier}`;
    // No subtitle — generic full sentence (never the merchant's name or raw
    // message text, same posture as support_reply below)
    case 'support_message':
    case 'support_reply':
      return String(p.preview ?? '');
    // No subtitle — full sentence, tier-specific ("Pro" only for paid)
    case 'alpha_quota_reset':
      return p.tier === 'paid'
        ? 'Vous pouvez parler à Alpha Pro maintenant.'
        : 'Vous pouvez parler à Alpha maintenant.';
    // No subtitle — full sentence. "bonne" states the revenue; "calme" never
    // reports a number at all, deliberately — see migration_v139.sql.
    case 'daily_digest':
      return p.tier === 'bonne'
        ? `La journée est bonne, vous avez fait : ${p.amount}.`
        : 'La journée était calme. On se retrouve demain.';
    default:
      return String(p.body ?? '');
  }
}

// ─── Sound & urgency classification ─────────────────────────────────────────

// Urgent sound (patron_urgent.wav) + time-sensitive interruption level
// = breaks through Focus modes. Only for events that need eyes now.
const URGENT_EVENTS = new Set([
  'chat_message',
  'low_stock',
  'sale_cancelled',
  'role_changed',
  'member_removed',
  'support_message',
  'support_reply',
]);

// Time-sensitive interruption: also includes approved/rejected (person is waiting)
// but with the default (softer) sound — important, not alarming
const TIME_SENSITIVE_EVENTS = new Set([
  ...URGENT_EVENTS,
  'expense_approved',
  'expense_rejected',
]);

// ─── iOS notification action categories ─────────────────────────────────────
// categoryIdentifier must match what's registered in NotificationSetup.tsx
const CATEGORY_MAP: Record<string, string> = {
  expense_submitted: 'expense_pending',
  chat_message:      'chat_incoming',
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
const CRON_EVENTS = new Set(['alpha_quota_reset', 'daily_digest']);

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

    // Fetch device tokens (with owning user_id — needed to stamp each push
    // with that user's own running unread count, not a shared value)
    const { data: tokenRows } = await supabase
      .from('device_tokens')
      .select('token, user_id')
      .in('user_id', userIds);
    const tokens = (tokenRows ?? []) as { token: string; user_id: string }[];

    if (tokens.length === 0) {
      await supabase.from('notification_log').insert({ business_id, event_type, payload, recipient_count: 0 });
      return new Response(JSON.stringify({ sent: 0 }), {
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

    // Build notification fields
    const body            = buildBody(event_type, payload as Record<string, string | number>);
    const subtitle        = SUBTITLE_MAP[event_type] ?? null;
    const route           = ROUTE_MAP[event_type] ?? '/(app)';
    const isUrgent        = URGENT_EVENTS.has(event_type);
    const isTimeSensitive = TIME_SENSITIVE_EVENTS.has(event_type);
    const soundFile       = isUrgent ? 'patron_urgent.wav' : 'patron_default.wav';
    const channelId       = isUrgent ? 'patron_urgent' : 'patron_default';
    const categoryId      = CATEGORY_MAP[event_type];

    const CHUNK = 100;
    const staleTokens: string[] = [];

    for (let i = 0; i < tokens.length; i += CHUNK) {
      const chunk = tokens.slice(i, i + CHUNK);
      const messages = chunk.map(({ token: to, user_id }) => ({
        to,
        title: bizName,                               // business name — always
        ...(subtitle ? { subtitle } : {}),            // event category in French
        body,                                         // the core fact
        data: { route, event_type, business_id, ...payload },
        sound: soundFile,
        channelId,
        badge: badgeByUser.get(user_id) ?? 1,
        ...(categoryId ? { categoryIdentifier: categoryId } : {}),
        ...(isTimeSensitive ? { _interruptionLevel: 'time-sensitive' } : {}),
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
