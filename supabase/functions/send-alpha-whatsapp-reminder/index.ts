import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// ============================================================
// send-alpha-whatsapp-reminder — cron job (daily, not yet scheduled):
// calls get_and_mark_alpha_whatsapp_candidates() (migration_v143.sql)
// to find businesses whose administrateur has hit the free Alpha cap
// on 3+ separate days in the last week and still has no subscription,
// then sends each one the approved "patron_alpha_pro" WhatsApp
// template via Meta's Graph API directly — NOT Twilio, unlike the
// existing OTP flow (create-phone-verification/send-whatsapp-otp).
// See CLAUDE.md's "Alpha WhatsApp reminder" entry.
//
// The template's one variable is the button's dynamic URL suffix —
// filled with businesses.djomi_checkout_token (migration_v142.sql),
// so the link each business receives already identifies them; the
// checkout page shows only the Orange Money field for that link,
// never asking again for something we already know.
//
// Deploy with --no-verify-jwt; authenticates via x-cron-secret instead
// of a Supabase JWT, same pattern as send-alpha-quota-reminders.
// ============================================================

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const META_GRAPH_VERSION = 'v21.0';
const TEMPLATE_NAME = 'patron_alpha_pro';
const TEMPLATE_LANGUAGE = 'fr';

// Meta's Graph API wants digits only, country code prefixed, no leading
// "00" and no "+" — a different shape from Djomi's formatPayerNumber
// (which wants a leading "00"). Two separate normalizers on purpose,
// not shared, since the two APIs disagree on the format.
function formatWhatsAppNumber(phone: string): string {
  let clean = phone.replace(/\D/g, '');
  if (clean.length === 9) {
    clean = '224' + clean;
  } else if (clean.startsWith('00224')) {
    clean = clean.slice(2);
  } else if (!clean.startsWith('224')) {
    clean = '224' + clean;
  }
  return clean;
}

async function sendTemplate(phoneNumberId: string, accessToken: string, toPhone: string, checkoutToken: string) {
  const resp = await fetch(`https://graph.facebook.com/${META_GRAPH_VERSION}/${phoneNumberId}/messages`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to: formatWhatsAppNumber(toPhone),
      type: 'template',
      template: {
        name: TEMPLATE_NAME,
        language: { code: TEMPLATE_LANGUAGE },
        components: [
          {
            type: 'button',
            sub_type: 'url',
            index: '0',
            parameters: [{ type: 'text', text: checkoutToken }],
          },
        ],
      },
    }),
  });
  const data = await resp.json();
  if (!resp.ok) {
    throw new Error(JSON.stringify(data));
  }
  return data;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  const cronSecret = Deno.env.get('CRON_SECRET');
  const incoming = req.headers.get('x-cron-secret');
  if (!cronSecret || incoming !== cronSecret) {
    return new Response(JSON.stringify({ error: 'Non autorisé' }), {
      status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const PHONE_NUMBER_ID = Deno.env.get('META_WHATSAPP_PHONE_NUMBER_ID');
  const ACCESS_TOKEN = Deno.env.get('META_WHATSAPP_TOKEN');
  if (!PHONE_NUMBER_ID || !ACCESS_TOKEN) {
    return new Response(JSON.stringify({ error: 'Configuration WhatsApp incomplète.' }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  const { data: candidates, error } = await supabase.rpc('get_and_mark_alpha_whatsapp_candidates');
  if (error) {
    console.error('get_and_mark_alpha_whatsapp_candidates error:', error);
    return new Response(JSON.stringify({ error: 'server_error' }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  let sent = 0;
  let failed = 0;

  for (const candidate of candidates ?? []) {
    if (!candidate.checkout_token) {
      // Shouldn't happen — every business gets a token on insert/backfill
      // (migration_v142.sql) — but a missing token means the link would
      // be broken, so skip rather than send an unusable message. Already
      // marked sent by the RPC; not retried.
      console.error(`send-alpha-whatsapp-reminder: business ${candidate.business_id} has no checkout_token — skipped`);
      failed++;
      continue;
    }
    try {
      await sendTemplate(PHONE_NUMBER_ID, ACCESS_TOKEN, candidate.admin_phone, candidate.checkout_token);
      sent++;
    } catch (err) {
      console.error(`send-alpha-whatsapp-reminder: failed for business ${candidate.business_id}:`, err);
      failed++;
    }
  }

  console.log(`send-alpha-whatsapp-reminder: ${sent} sent, ${failed} failed, ${(candidates ?? []).length} candidates`);

  return new Response(JSON.stringify({ candidates: (candidates ?? []).length, sent, failed }), {
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
});
