import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// Cron job (daily, see migration_v171) that finalizes every account deletion
// request whose 30-day grace window (profiles.pending_deletion_at, set by
// delete_my_account — see migration_v170) has passed. A request is cancelled
// automatically the moment its owner establishes a real session again
// (stores/auth.ts's loadSession clears the column on every login path), so
// by the time a row is actually due here, its owner never logged back in.
//
// Each row is finalized via its own RPC call, not one big SQL loop, so a
// single bad/unexpected row (finalize_account_deletion itself also re-checks
// and no-ops rather than throwing for a stale/no-longer-due row — see that
// function's own comment) can't abort the rest of the day's batch.
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

    const { data: due, error: fetchErr } = await supabase
      .from('profiles')
      .select('id')
      .not('pending_deletion_at', 'is', null)
      .lte('pending_deletion_at', new Date().toISOString());
    if (fetchErr) throw fetchErr;

    const ids = (due ?? []).map((r: { id: string }) => r.id);
    let finalized = 0;
    const errors: { id: string; error: string }[] = [];

    for (const id of ids) {
      const { error } = await supabase.rpc('finalize_account_deletion', { p_user_id: id });
      if (error) {
        errors.push({ id, error: error.message });
      } else {
        finalized++;
      }
    }

    return new Response(JSON.stringify({ candidates: ids.length, finalized, errors }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Erreur inconnue';
    console.error('process-scheduled-account-deletions crash:', msg);
    return new Response(JSON.stringify({ error: msg }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
