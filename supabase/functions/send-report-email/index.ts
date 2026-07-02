import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';

// Generic email relay for scheduled reporting agents (Claude Code routines)
// that have no Gmail "send" capability, only "create draft". Those routines
// POST here instead of going through Gmail MCP, so reports actually land in
// the inbox instead of piling up as unsent drafts.
//
// Auth: shared secret header, same pattern as send-reconciliation-report.
// Always sends to FOUNDER_EMAIL — this is intentionally not an open relay,
// it only ever delivers to the founder's own inbox.

serve(async (req: Request) => {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  const relaySecret = Deno.env.get('REPORT_RELAY_SECRET');
  const incoming = req.headers.get('x-relay-secret');
  if (!relaySecret || incoming !== relaySecret) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  let body: { subject?: string; html?: string; text?: string };
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: 'invalid JSON body' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const { subject, html, text } = body;
  if (!subject || (!html && !text)) {
    return new Response(
      JSON.stringify({ error: 'subject and (html or text) are required' }),
      { status: 400, headers: { 'Content-Type': 'application/json' } },
    );
  }

  const founderEmail = Deno.env.get('FOUNDER_EMAIL') ?? 'mdousebastiao@gmail.com';
  const resendKey = Deno.env.get('RESEND_API_KEY')!;

  const emailRes = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${resendKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: 'Patron <noreply@patron.kolilink.com>',
      to: [founderEmail],
      subject,
      html: html ?? `<pre>${text}</pre>`,
      text: text ?? undefined,
    }),
  });

  if (!emailRes.ok) {
    const detail = await emailRes.text();
    return new Response(JSON.stringify({ error: 'resend_failed', detail }), {
      status: 502,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const result = await emailRes.json();
  return new Response(JSON.stringify({ status: 'sent', id: result.id }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
});
