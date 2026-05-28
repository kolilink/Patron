import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// Called by Twilio Studio when a WhatsApp message arrives.
// Twilio sends: { from: "whatsapp:+224...", body: "Patron-AB12CD" }
// Studio must include the header: x-patron-secret: <WHATSAPP_WEBHOOK_SECRET>

serve(async (req) => {
  try {
    // Validate that the request is from our Twilio Studio flow.
    // Twilio Studio passes this as a URL query parameter (?secret=...).
    const url = new URL(req.url);
    const secret = url.searchParams.get('secret');
    if (!secret || secret !== Deno.env.get('WHATSAPP_WEBHOOK_SECRET')) {
      return new Response('Unauthorized', { status: 401 });
    }

    const payload = await req.json() as Record<string, string>;
    console.log('PAYLOAD KEYS:', Object.keys(payload));
    console.log('PAYLOAD:', JSON.stringify(payload));

    // Twilio Studio sends capitalized keys (From, Body); accept both cases
    const rawFrom = payload.From ?? payload.from ?? '';
    const rawBody = payload.Body ?? payload.body ?? '';
    console.log('rawFrom:', rawFrom, '| rawBody:', rawBody);

    if (!rawFrom || !rawBody) {
      console.log('MISSING from or body — returning 400');
      return new Response('Bad Request', { status: 400 });
    }

    // Twilio sends the sender as "whatsapp:+224622112233" — strip prefix
    const phone = rawFrom.replace(/^whatsapp:/i, '').trim();
    const token = rawBody.trim().toUpperCase();
    console.log('phone:', phone, '| token:', token);

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
      console.log('NO MATCH — fetchErr:', fetchErr?.message ?? 'none', '| row:', row);
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
