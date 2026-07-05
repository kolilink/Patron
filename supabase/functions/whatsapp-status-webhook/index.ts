import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';

// Diagnostic-only webhook for Meta WhatsApp Cloud API.
// Logs every delivery status callback (sent/delivered/read/failed) so we can see
// the real reason messages aren't reaching recipients, instead of guessing from
// the dashboard's delayed/incomplete stats.

serve(async (req) => {
  const url = new URL(req.url);

  if (req.method === 'GET') {
    const mode      = url.searchParams.get('hub.mode');
    const token     = url.searchParams.get('hub.verify_token');
    const challenge = url.searchParams.get('hub.challenge');
    const expected  = Deno.env.get('META_WEBHOOK_VERIFY_TOKEN') ?? '';

    if (mode === 'subscribe' && token === expected) {
      return new Response(challenge ?? '', { status: 200 });
    }
    return new Response('Forbidden', { status: 403 });
  }

  if (req.method === 'POST') {
    const body = await req.text();
    console.log('META WEBHOOK EVENT:', body);
    return new Response('EVENT_RECEIVED', { status: 200 });
  }

  return new Response('Method Not Allowed', { status: 405 });
});
