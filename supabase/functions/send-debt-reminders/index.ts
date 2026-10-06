import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { safeErrorResponse } from '../_shared/errors.ts';
import { runDebtReminders, type Digest } from './handler.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// Hourly cron (migration_v201/v202). Everything time-related — the
// Africa/Conakry 08:00-21:00 delivery window, quiet hours, the Conakry-local
// debt age, the one-push-per-business-per-day cap, the permanent per-debt
// per-threshold dedupe — lives in get_due_debt_reminder_digests() /
// confirm_debt_reminder_digest() (migration_v237.sql). This function only
// ships what the database says is due and confirms what actually went out.
serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  const cronSecret = Deno.env.get('CRON_SECRET');
  if (!cronSecret || req.headers.get('x-cron-secret') !== cronSecret) {
    return new Response(JSON.stringify({ error: 'Non autorisé' }), {
      status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  try {
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );
    const functionsUrl = `${Deno.env.get('SUPABASE_URL')!}/functions/v1/dispatch-notification`;

    const summary = await runDebtReminders({
      getDigests: async (nowIso) => {
        const { data, error } = await supabase.rpc('get_due_debt_reminder_digests',
          nowIso ? { p_now: nowIso } : {});
        if (error) throw error;
        return (data ?? []) as Digest[];
      },
      confirm: async (d) => {
        const { data, error } = await supabase.rpc('confirm_debt_reminder_digest', {
          p_business_id: d.business_id,
          p_local_date: d.local_date,
          p_items: d.items,
        });
        if (error) throw error;
        return data === true;
      },
      dispatch: async (body) => {
        const resp = await fetch(functionsUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-cron-secret': cronSecret },
          body: JSON.stringify(body),
        });
        let parsed: Record<string, unknown> | null = null;
        try { parsed = await resp.json(); } catch { parsed = null; }
        return { ok: resp.ok, body: parsed };
      },
      sleep: (ms) => new Promise(resolve => setTimeout(resolve, ms)),
    });

    return new Response(JSON.stringify(summary), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (e) {
    return safeErrorResponse(e, corsHeaders, 'send-debt-reminders');
  }
});
