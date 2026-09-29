import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

interface NudgeCandidate {
  business_id: string;
  user_id: string;
  event_type: 'activation_nudge_1' | 'activation_nudge_2' | 'second_action_reminder';
  action_type: 'product' | 'debt' | 'sale' | null;
}

// Cron job (hourly) — finds every business currently qualifying for
// activation_nudge_1, activation_nudge_2, or second_action_reminder via
// get_and_mark_activation_nudges() (migration_v155.sql), which also marks
// each one sent atomically so an overlapping run can never double-send.
// Quiet hours / the 3-pushes/24h cap are NOT re-implemented here — both are
// already enforced inside dispatch-notification itself for every ordinary
// event, this function just forwards candidates to it.
serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

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

    const { data, error } = await supabase.rpc('get_and_mark_activation_nudges');
    if (error) throw error;

    const candidates = (data ?? []) as NudgeCandidate[];
    const functionsUrl = `${Deno.env.get('SUPABASE_URL')!}/functions/v1/dispatch-notification`;

    let sent = 0;
    for (const c of candidates) {
      const payload = c.action_type ? { action_type: c.action_type } : {};
      const resp = await fetch(functionsUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-cron-secret': cronSecret,
        },
        body: JSON.stringify({
          business_id: c.business_id,
          event_type: c.event_type,
          payload,
          target_user_ids: [c.user_id],
        }),
      });
      if (resp.ok) sent++;
    }

    return new Response(JSON.stringify({ candidates: candidates.length, sent }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Erreur inconnue';
    console.error('send-activation-nudges crash:', msg);
    return new Response(JSON.stringify({ error: msg }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
