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
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const { phone, login = false } = await req.json() as { phone: string; login?: boolean };
    if (!phone) {
      return new Response(JSON.stringify({ error: 'Numéro requis' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Identify caller from their Supabase JWT
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) {
      return new Response(JSON.stringify({ error: 'Non authentifié' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const userClient = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_ANON_KEY')!,
      { global: { headers: { Authorization: authHeader } } },
    );

    const { data: { user }, error: userErr } = await userClient.auth.getUser();
    if (userErr || !user) {
      return new Response(JSON.stringify({ error: 'Utilisateur introuvable' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const serviceClient = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    // ── Demo / App Store review bypass ───────────────────────────────────────
    const DEMO_PHONE = Deno.env.get('DEMO_PHONE') ?? '';
    const DEMO_PHONES = (Deno.env.get('DEMO_PHONES') ?? '').split(',').map(p => p.trim()).filter(Boolean);
    const isDemo = (DEMO_PHONE !== '' && phone.trim() === DEMO_PHONE) || DEMO_PHONES.includes(phone.trim());

    // ── Rate limiting (skip for demo) ─────────────────────────────────────────
    if (!isDemo) {
      const { count } = await serviceClient
        .from('phone_verification_attempts')
        .select('*', { count: 'exact', head: true })
        .eq('phone', phone.trim())
        .gt('attempted_at', new Date(Date.now() - 10 * 60 * 1000).toISOString());

      if ((count ?? 0) >= 5) {
        return new Response(
          JSON.stringify({ error: 'Trop de tentatives. Réessayez dans 10 minutes.' }),
          { status: 429, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
        );
      }

      // Secondary limit scoped per IP — the per-phone limit above doesn't stop
      // an attacker rotating through many phone numbers to run up WhatsApp/Twilio costs.
      const clientIp = getClientIp(req);
      const { count: ipCount } = await serviceClient
        .from('ip_verification_attempts')
        .select('*', { count: 'exact', head: true })
        .eq('ip', clientIp)
        .eq('endpoint', 'phone')
        .gt('attempted_at', new Date(Date.now() - 60 * 60 * 1000).toISOString());

      if ((ipCount ?? 0) >= 20) {
        return new Response(
          JSON.stringify({ error: 'Trop de tentatives. Réessayez plus tard.' }),
          { status: 429, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
        );
      }

      await serviceClient.from('phone_verification_attempts').insert({ phone: phone.trim() });
      await serviceClient.from('ip_verification_attempts').insert({ ip: clientIp, endpoint: 'phone' });

      await serviceClient
        .from('phone_verification_attempts')
        .delete()
        .lt('attempted_at', new Date(Date.now() - 60 * 60 * 1000).toISOString());

      await serviceClient
        .from('ip_verification_attempts')
        .delete()
        .lt('attempted_at', new Date(Date.now() - 60 * 60 * 1000).toISOString());
    }

    // ── Phone existence check (skip for demo) ─────────────────────────────────
    if (!isDemo) {
      const { data: existing } = await serviceClient
        .from('profiles')
        .select('id')
        .eq('phone', phone.trim())
        .maybeSingle();

      if (!login && existing) {
        return new Response(JSON.stringify({ error: 'PHONE_EXISTS' }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      if (login && !existing) {
        return new Response(JSON.stringify({ error: 'PHONE_NOT_FOUND' }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
    }

    // ── Generate 6-digit code ─────────────────────────────────────────────────
    const token = isDemo ? '000000' : Math.floor(100000 + Math.random() * 900000).toString();

    // ── Send via WhatsApp (Meta Cloud API), fall back to Twilio Verify (skip for demo) ──
    if (!isDemo) {
      const sentViaWhatsapp = await sendWhatsappOtp(phone.trim(), token);
      if (!sentViaWhatsapp) {
        await sendViaTwilioVerify(phone.trim(), token);
      }
    }

    // ── Insert verification row ───────────────────────────────────────────────
    const { data, error: insertErr } = await serviceClient
      .from('phone_verifications')
      .insert({
        user_id:    user.id,
        phone:      phone.trim(),
        token,
        status:     'en_attente',
        expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
      })
      .select('id')
      .single();

    if (insertErr) throw insertErr;

    return new Response(JSON.stringify({ verificationId: data.id }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Erreur inconnue';
    return new Response(JSON.stringify({ error: msg }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});

// ── WhatsApp via Meta Cloud API (free for authentication templates) ─────────
async function sendWhatsappOtp(phone: string, code: string): Promise<boolean> {
  const phoneId = Deno.env.get('META_WHATSAPP_PHONE_ID')!;
  const token   = Deno.env.get('META_WHATSAPP_TOKEN')!;

  try {
    const res = await fetch(`https://graph.facebook.com/v21.0/${phoneId}/messages`, {
      method:  'POST',
      headers: {
        Authorization:  `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to:                phone.replace(/^\+/, ''),
        type:              'template',
        template: {
          name:     'whatsapp_otp',
          language: { code: 'fr' },
          components: [
            { type: 'body', parameters: [{ type: 'text', text: code }] },
            {
              type:       'button',
              sub_type:   'url',
              index:      0,
              parameters: [{ type: 'text', text: code }],
            },
          ],
        },
      }),
    });
    const resBody = await res.text();
    if (!res.ok) {
      console.error('WhatsApp send failed:', res.status, resBody);
    } else {
      console.log('WhatsApp send accepted:', resBody, 'to:', phone.replace(/^\+/, ''));
    }
    return res.ok;
  } catch (e) {
    console.error('WhatsApp send threw:', e instanceof Error ? e.message : e);
    return false;
  }
}

// ── Fallback via Twilio Verify (proven-reliable path, used when Meta WhatsApp fails) ──
async function sendViaTwilioVerify(phone: string, code: string): Promise<void> {
  const accountSid = Deno.env.get('TWILIO_ACCOUNT_SID')!;
  const authToken  = Deno.env.get('TWILIO_AUTH_TOKEN')!;
  const verifySid  = Deno.env.get('TWILIO_VERIFY_SID')!;

  const res = await fetch(
    `https://verify.twilio.com/v2/Services/${verifySid}/Verifications`,
    {
      method:  'POST',
      headers: {
        Authorization:  'Basic ' + btoa(`${accountSid}:${authToken}`),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        To:         phone,
        Channel:    'sms',
        CustomCode: code,
      }),
    },
  );

  if (!res.ok) {
    const errJson = await res.json().catch(() => ({})) as { code?: number; message?: string };
    console.error('Twilio Verify send failed:', res.status, errJson);
    if (errJson.code === 60200 || errJson.code === 21211) {
      throw new Error('Numéro de téléphone invalide. Vérifiez votre numéro et réessayez.');
    }
    throw new Error('Impossible d\'envoyer le code. Réessayez dans quelques instants.');
  }
}
