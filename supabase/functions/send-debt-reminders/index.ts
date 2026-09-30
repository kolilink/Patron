import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { safeErrorResponse } from '../_shared/errors.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// Mirrors src/utils/format.ts's formatAmount — duplicated here because this
// is a Deno edge function and can't import RN app code. Keep in sync if the
// display format ever changes.
const WHOLE_UNIT_CURRENCIES = new Set(['GNF', 'XOF', 'XAF', 'JPY', 'KRW']);
function formatAmount(n: number, currency: string): string {
  if (WHOLE_UNIT_CURRENCIES.has(currency)) {
    const formatted = Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
    return `${formatted} ${currency}`;
  }
  const [intPart, decPart] = n.toFixed(2).split('.');
  const formatted = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return `${formatted}.${decPart} ${currency}`;
}

// customer_name is a full name ("Mamadou Diallo") — the notification's copy
// wants just the first name ("Rappel : Mamadou vous doit …").
function firstName(fullName: string): string {
  return fullName.trim().split(/\s+/)[0] || fullName;
}

// A tight loop of fetch() calls to another edge function trips Supabase's
// own platform outbound-fetch rate limit almost immediately — found live on
// this feature's first production run (488-item historical backlog):
// "RateLimitError: Rate limit exceeded for function. Retry after 54099ms",
// thrown uncaught, which crashed the whole function after
// get_and_mark_debt_reminders() (migration_v200.sql, since replaced by
// migration_v202.sql) had already marked every one of those 488 debts as
// reminded — permanently starving all of them of an actual notification.
// This delay is what keeps a normal-sized batch under that limit in the
// first place; the per-item try/catch below is what keeps any remaining
// failure contained to one item instead of the whole run.
const THROTTLE_MS = 300;

interface DueReminder {
  business_id: string;
  sale_order_id: string;
  client_name: string;
  client_id: string | null;
  remaining_cents: number;
  currency: string;
  threshold_days: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  // Same fail-closed cron-secret pattern as send-daily-digest /
  // send-second-action-reminders. This secret also authorizes the call this
  // function makes to dispatch-notification's debt_aging_reminder event.
  const cronSecret = Deno.env.get('CRON_SECRET');
  const incoming = req.headers.get('x-cron-secret');
  if (!cronSecret || incoming !== cronSecret) {
    return new Response(JSON.stringify({ error: 'Non autorisé' }), {
      status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  try {
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    // Read-only — marks nothing. A debt is only ever marked reminded by
    // mark_debt_reminder_sent below, and only once its own notification has
    // actually been confirmed sent, never eagerly.
    const { data, error } = await supabase.rpc('get_due_debt_reminders');
    if (error) throw error;

    const due = (data ?? []) as DueReminder[];
    const functionsUrl = `${Deno.env.get('SUPABASE_URL')!}/functions/v1/dispatch-notification`;

    let sent = 0;
    let failed = 0;
    for (const reminder of due) {
      try {
        // Deep link straight to that client's carnet (Historique) screen —
        // the same route clients/index.tsx's own row tap uses (client_id
        // when the customer is a real clients row, else the raw name).
        const routeParam = encodeURIComponent(reminder.client_id ?? reminder.client_name);

        const resp = await fetch(functionsUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-cron-secret': cronSecret,
          },
          body: JSON.stringify({
            business_id: reminder.business_id,
            event_type: 'debt_aging_reminder',
            payload: {
              name: firstName(reminder.client_name),
              // Currency is already baked into this string (matches every
              // other event type's `amount` field in dispatch-notification)
              // — there is no separate currency token in the body.
              amount: formatAmount(reminder.remaining_cents / 100, reminder.currency),
              days: reminder.threshold_days,
              route: `/(app)/clients/${routeParam}`,
            },
            target_roles: ['administrateur', 'manager'],
          }),
        });

        if (resp.ok) {
          // Mark only now — after a confirmed successful send, never before.
          const { error: markErr } = await supabase.rpc('mark_debt_reminder_sent', {
            p_sale_order_id: reminder.sale_order_id,
            p_threshold_days: reminder.threshold_days,
          });
          if (markErr) throw markErr;
          sent++;
        } else {
          failed++;
        }
      } catch {
        // Isolated per-item, same posture as
        // process-scheduled-account-deletions' per-row calls — one item's
        // failure (rate limit, network blip, a bad row) must never abort
        // the rest of the batch. Left unmarked, it's simply retried next hour.
        failed++;
      }
      await sleep(THROTTLE_MS);
    }

    return new Response(JSON.stringify({ due: due.length, sent, failed }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (e) {
    return safeErrorResponse(e, corsHeaders, 'send-debt-reminders');
  }
});
