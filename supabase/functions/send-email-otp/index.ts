import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// Client IP as seen by the edge (Supabase forwards this header).
function getClientIp(req: Request): string {
  const fwd = req.headers.get('x-forwarded-for');
  return fwd ? fwd.split(',')[0].trim() : 'unknown';
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const { email } = await req.json() as { email: string };

    if (!email || !email.includes('@')) {
      return new Response(JSON.stringify({ error: 'Adresse email invalide' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const normalizedEmail = email.trim().toLowerCase();

    const serviceClient = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    // Rate limit: 5 attempts per email per 10 minutes
    const { count } = await serviceClient
      .from('email_verification_attempts')
      .select('*', { count: 'exact', head: true })
      .eq('email', normalizedEmail)
      .gt('attempted_at', new Date(Date.now() - 10 * 60 * 1000).toISOString());

    if ((count ?? 0) >= 5) {
      return new Response(
        JSON.stringify({ error: 'Trop de tentatives. Réessayez dans 10 minutes.' }),
        { status: 429, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    // Secondary limit scoped per IP — the per-email limit above doesn't stop
    // an attacker rotating through many email addresses to run up email costs.
    const clientIp = getClientIp(req);
    const { count: ipCount } = await serviceClient
      .from('ip_verification_attempts')
      .select('*', { count: 'exact', head: true })
      .eq('ip', clientIp)
      .eq('endpoint', 'email')
      .gt('attempted_at', new Date(Date.now() - 60 * 60 * 1000).toISOString());

    if ((ipCount ?? 0) >= 20) {
      return new Response(
        JSON.stringify({ error: 'Trop de tentatives. Réessayez plus tard.' }),
        { status: 429, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    await serviceClient.from('email_verification_attempts').insert({ email: normalizedEmail });
    await serviceClient.from('ip_verification_attempts').insert({ ip: clientIp, endpoint: 'email' });

    // Clean up old attempts older than 1 hour
    await serviceClient
      .from('email_verification_attempts')
      .delete()
      .lt('attempted_at', new Date(Date.now() - 60 * 60 * 1000).toISOString());

    await serviceClient
      .from('ip_verification_attempts')
      .delete()
      .lt('attempted_at', new Date(Date.now() - 60 * 60 * 1000).toISOString());

    const token = Math.floor(100000 + Math.random() * 900000).toString();

    const { data, error: insertErr } = await serviceClient
      .from('email_verifications')
      .insert({
        email: normalizedEmail,
        token,
        status: 'en_attente',
        expires_at: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
      })
      .select('id')
      .single();

    if (insertErr) throw insertErr;

    const resendKey = Deno.env.get('RESEND_API_KEY')!;
    const emailRes = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${resendKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: 'Patron <noreply@patron.kolilink.com>',
        to: [normalizedEmail],
        subject: `${token} est votre code Patron`,
        html: `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f9fafb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f9fafb;padding:48px 16px;">
    <tr><td align="center">
      <table width="100%" cellpadding="0" cellspacing="0" style="max-width:440px;background:#ffffff;border-radius:16px;overflow:hidden;">
        <tr><td style="padding:40px 40px 8px;">
          <p style="margin:0;font-size:13px;font-weight:600;letter-spacing:0.08em;color:#6366f1;text-transform:uppercase;">Patron</p>
        </td></tr>
        <tr><td style="padding:8px 40px 32px;">
          <p style="margin:0 0 24px;font-size:20px;font-weight:600;color:#111827;line-height:1.3;">Votre code de vérification</p>
          <table width="100%" cellpadding="0" cellspacing="0">
            <tr><td align="center" style="background:#f3f4f6;border-radius:12px;padding:28px 0;">
              <span style="font-size:44px;font-weight:700;letter-spacing:12px;color:#111827;">${token}</span>
            </td></tr>
          </table>
          <p style="margin:24px 0 0;font-size:13px;color:#9ca3af;text-align:center;">Valable 30 minutes · Ne le partagez pas</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`,
      }),
    });

    if (!emailRes.ok) {
      const errBody = await emailRes.json().catch(() => ({})) as { message?: string };
      throw new Error(errBody.message ?? 'Impossible d\'envoyer l\'email');
    }

    return new Response(
      JSON.stringify({ verificationId: data.id }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Erreur inconnue';
    console.error('send-email-otp crash:', msg);
    return new Response(JSON.stringify({ error: msg }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
