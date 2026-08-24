import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// Guinea (Patron's target market) is GMT year-round — no DST — so a plain
// UTC-hour check stands in for "local night" without needing a per-business
// timezone column, which doesn't exist. Same constant/window as
// send-alpha-quota-reminders and send-daily-digest.
const QUIET_HOUR_START = 21; // 9pm
const QUIET_HOUR_END = 7;    // 7am
function isQuietHours(now: Date): boolean {
  const h = now.getUTCHours();
  return h >= QUIET_HOUR_START || h < QUIET_HOUR_END;
}

interface ActivationReminder {
  business_id: string;
  nudge: 1 | 2;
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  // Verify this is a legitimate cron call — same fail-closed pattern as
  // every other cron-triggered function in this project.
  const cronSecret = Deno.env.get('CRON_SECRET');
  const incoming = req.headers.get('x-cron-secret');
  if (!cronSecret || incoming !== cronSecret) {
    return new Response(JSON.stringify({ error: 'Non autorisé' }), {
      status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  try {
    // Skip entirely during quiet hours — don't consume/mark any reminders
    // now, so any business that crossed a nudge threshold overnight is still
    // picked up (and nudged) on the first run once quiet hours end.
    if (isQuietHours(new Date())) {
      return new Response(JSON.stringify({ skipped: 'quiet_hours' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    const { data, error } = await supabase.rpc('get_and_mark_activation_reminders');
    if (error) throw error;

    const reminders = (data ?? []) as ActivationReminder[];
    const functionsUrl = `${Deno.env.get('SUPABASE_URL')!}/functions/v1/dispatch-notification`;

    let sent = 0;
    for (const reminder of reminders) {
      const resp = await fetch(functionsUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-cron-secret': cronSecret,
        },
        body: JSON.stringify({
          business_id: reminder.business_id,
          event_type: reminder.nudge === 1 ? 'activation_nudge_1' : 'activation_nudge_2',
          payload: {},
          // Only administrateur/manager can act on any of the three fork
          // actions — a vendeur/investisseur can't create the first product
          // or sale, so nudging them would be pointless (same audience
          // ActivationForkOverlay's own forkIsOwner check already targets).
          target_roles: ['administrateur', 'manager'],
        }),
      });
      if (resp.ok) sent++;
    }

    return new Response(JSON.stringify({ candidates: reminders.length, sent }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Erreur inconnue';
    console.error('send-activation-reminders crash:', msg);
    return new Response(JSON.stringify({ error: msg }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
