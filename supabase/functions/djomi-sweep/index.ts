import { verifyDjomiTransaction, confirmDjomiPayment, djomiServiceClient, listUnresolvedPendingPayments } from '../_shared/djomi.ts';

// ============================================================
// djomi-sweep — closes the one real gap in the Djomi flow: a merchant
// who pays but never returns to the djomi-checkout tab within its
// ~2-minute poll window. Neither the poll nor djomi-webhook (dormant —
// see that file) ever re-checks that payment again on their own.
//
// Cron job, not yet scheduled — needs an hourly Supabase dashboard
// Cron Job pointed at this function with the x-cron-secret header, same
// setup style as send-alpha-quota-reminders / send-daily-digest.
//
// Deploy with --no-verify-jwt; authenticates via x-cron-secret instead
// of a Supabase JWT, same fail-closed pattern as those functions.
// ============================================================

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// Bounds how far back the sweep looks — matches listUnresolvedPendingPayments'
// intent of not polling Djomi forever for a genuinely abandoned attempt.
const LOOKBACK_HOURS = 24;

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  const cronSecret = Deno.env.get('CRON_SECRET');
  const incoming = req.headers.get('x-cron-secret');
  if (!cronSecret || incoming !== cronSecret) {
    return new Response(JSON.stringify({ error: 'Non autorisé' }), {
      status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const CLIENT_ID = Deno.env.get('djomi_id');
  const CLIENT_SECRET = Deno.env.get('djomi_key');
  if (!CLIENT_ID || !CLIENT_SECRET) {
    return new Response(JSON.stringify({ error: 'Configuration Djomi incomplète.' }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const supabase = djomiServiceClient();
  const pendingList = await listUnresolvedPendingPayments(supabase, LOOKBACK_HOURS);

  let confirmed = 0;
  let stillPending = 0;
  let errors = 0;

  for (const pending of pendingList) {
    // listUnresolvedPendingPayments already filters transaction_id IS NOT
    // NULL, but the type is still nullable — narrow it for TS.
    if (!pending.transaction_id) continue;

    const status = await verifyDjomiTransaction(pending.transaction_id, CLIENT_ID, CLIENT_SECRET);
    if (status === 'success') {
      try {
        await confirmDjomiPayment(supabase, pending, pending.transaction_id);
        confirmed++;
      } catch {
        errors++;
      }
    } else if (status === 'pending') {
      stillPending++;
    } else {
      errors++;
    }
  }

  console.log(`djomi-sweep: checked ${pendingList.length}, confirmed ${confirmed}, still pending ${stillPending}, errors ${errors}`);

  return new Response(JSON.stringify({ checked: pendingList.length, confirmed, stillPending, errors }), {
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
});
