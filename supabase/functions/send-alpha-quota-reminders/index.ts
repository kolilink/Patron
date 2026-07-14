import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// Guinea (Patron's target market) is GMT year-round — no DST — so a plain
// UTC-hour check stands in for "local night" without needing a per-business
// timezone column, which doesn't exist. 21:00–07:00 UTC ≈ 21:00–07:00 in
// Conakry. If Patron ever serves a business outside GMT, this needs a real
// per-business timezone instead of this shortcut.
const QUIET_HOUR_START = 21; // 9pm
const QUIET_HOUR_END = 7;    // 7am
function isQuietHours(now: Date): boolean {
  const h = now.getUTCHours();
  return h >= QUIET_HOUR_START || h < QUIET_HOUR_END;
}

interface QuotaReset {
  user_id: string;
  business_id: string;
  tier: 'free' | 'paid';
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  // Verify this is a legitimate cron call — same fail-closed pattern as
  // send-reconciliation-report. This function also authorizes itself to
  // dispatch-notification's alpha_quota_reset event using this same secret.
  const cronSecret = Deno.env.get('CRON_SECRET');
  const incoming = req.headers.get('x-cron-secret');
  if (!cronSecret || incoming !== cronSecret) {
    return new Response(JSON.stringify({ error: 'Non autorisé' }), {
      status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  try {
    // Skip entirely during quiet hours — don't consume/mark any resets now,
    // so anyone whose window expired overnight is still picked up (and
    // notified) on the first run once quiet hours end.
    if (isQuietHours(new Date())) {
      return new Response(JSON.stringify({ skipped: 'quiet_hours' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    const { data, error } = await supabase.rpc('get_and_mark_alpha_quota_resets');
    if (error) throw error;

    const resets = (data ?? []) as QuotaReset[];
    const functionsUrl = `${Deno.env.get('SUPABASE_URL')!}/functions/v1/dispatch-notification`;

    let sent = 0;
    for (const reset of resets) {
      const resp = await fetch(functionsUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-cron-secret': cronSecret,
        },
        body: JSON.stringify({
          business_id: reset.business_id,
          event_type: 'alpha_quota_reset',
          payload: { tier: reset.tier },
          target_user_ids: [reset.user_id],
        }),
      });
      if (resp.ok) sent++;
    }

    return new Response(JSON.stringify({ candidates: resets.length, sent }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Erreur inconnue';
    console.error('send-alpha-quota-reminders crash:', msg);
    return new Response(JSON.stringify({ error: msg }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
