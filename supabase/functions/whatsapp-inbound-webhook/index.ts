import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// Called by Twilio Studio when a WhatsApp message arrives.
// Twilio sends: { from: "whatsapp:+224...", body: "Patron-AB12CD", secret: "<WHATSAPP_WEBHOOK_SECRET>" }
// Secret is in the JSON body (not URL — query params appear in server logs).

// Constant-time comparison — prevents timing-based brute-force of the webhook secret.
function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const aBytes = enc.encode(a);
  const bBytes = enc.encode(b);
  // Always compare full length to prevent short-circuit leaks
  const len = Math.max(aBytes.length, bBytes.length);
  let diff = aBytes.length ^ bBytes.length;
  for (let i = 0; i < len; i++) {
    diff |= (aBytes[i] ?? 0) ^ (bBytes[i] ?? 0);
  }
  return diff === 0;
}

serve(async (req) => {
  try {
    // Twilio Studio sends JSON; Twilio direct webhook sends form-encoded — try JSON first
    let payload: Record<string, string>;
    const bodyText = await req.text();
    try {
      payload = JSON.parse(bodyText) as Record<string, string>;
    } catch {
      const params = new URLSearchParams(bodyText);
      payload = Object.fromEntries(params.entries()) as Record<string, string>;
    }

    // Secret must be in the JSON body — never in URL query params (they appear in logs)
    const secret = payload.secret ?? '';
    const expected = Deno.env.get('WHATSAPP_WEBHOOK_SECRET') ?? '';
    if (!secret || !timingSafeEqual(secret, expected)) {
      return new Response('Unauthorized', { status: 401 });
    }

    // Twilio sends capitalized keys (From, Body); accept both cases
    const rawFrom = payload.From ?? payload.from ?? '';
    const rawBody = payload.Body ?? payload.body ?? '';

    if (!rawFrom || !rawBody) {
      return new Response('Bad Request', { status: 400 });
    }

    // Twilio sends the sender as "whatsapp:+224622112233" — strip prefix
    const phone = rawFrom.replace(/^whatsapp:/i, '').trim();
    const token = rawBody.trim().toUpperCase();

    // Ignore messages that are not verification tokens
    if (!token.startsWith('PATRON-')) {
      return new Response(JSON.stringify({ verified: false }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const serviceClient = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    // Find a matching pending, unexpired row where BOTH phone AND token match.
    // This is the security check — an attacker would need to know both values.
    const { data: row, error: fetchErr } = await serviceClient
      .from('phone_verifications')
      .select('id')
      .eq('phone', phone)
      .eq('token', token)
      .eq('status', 'en_attente')
      .gt('expires_at', new Date().toISOString())
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (fetchErr || !row) {
      return new Response(JSON.stringify({ verified: false }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Flip status — the client's Realtime subscription will detect this change
    const { error: updateErr } = await serviceClient
      .from('phone_verifications')
      .update({ status: 'verifie' })
      .eq('id', row.id);

    if (updateErr) throw updateErr;

    return new Response(JSON.stringify({ verified: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Erreur inconnue';
    console.error('whatsapp-inbound-webhook error:', msg);
    return new Response('Internal Error', { status: 500 });
  }
});
