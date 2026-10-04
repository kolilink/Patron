import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { SafeError, safeErrorResponse } from '../_shared/errors.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// Client IP as seen by the edge (Supabase forwards this header).
function getClientIp(req: Request): string {
  const fwd = req.headers.get('x-forwarded-for');
  return fwd ? fwd.split(',')[0].trim() : 'unknown';
}

// Cryptographically-secure uniform 6-digit code (100000–999999).
// Rejection sampling drops the top of the u32 range so `% 900000` carries no
// modulo bias.
function generateOtpCode(): string {
  const range = 900000;
  const limit = Math.floor(0xFFFFFFFF / range) * range;
  const buf = new Uint32Array(1);
  let r: number;
  do {
    crypto.getRandomValues(buf);
    r = buf[0];
  } while (r >= limit);
  return (100000 + (r % range)).toString();
}

// SHA-256 hex digest — stored in place of the raw code so a DB read (backup,
// leaked service-role key, a future RLS mistake) can't hand out a directly
// usable, still-valid 10-minute code. Deno's edge runtime has full Web
// Crypto (unlike Hermes on the mobile client, which is why invite codes
// historically avoided it) so this needs no extra dependency.
async function hashToken(token: string): Promise<string> {
  const bytes = new TextEncoder().encode(token);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
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
    // ACCEPTED RISK (documented, not an oversight): Apple/Google reviewers have no
    // WhatsApp access, so ONE reserved phone number (the DEMO_PHONE /
    // DEMO_PHONES Supabase secrets — never committed to this repo) skips the
    // WhatsApp send and rate limits and gets a fixed code. Anyone who learns
    // that number AND the fixed code can log in as that reviewer account.
    // Mitigations: the number is unpublished and lives only in Supabase
    // secrets + App Store Connect review notes; the account is a throwaway
    // review business with no real data; ROTATE both whenever review ends or
    // the number may have leaked (update the secret, the demo profile's phone,
    // and the review notes together). Do NOT write the number or the code in
    // docs, comments or tests.
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
    // CSPRNG, not Math.random() — Deno exposes crypto.getRandomValues (the
    // Hermes limitation that forces Math.random() for client-side invite codes
    // does not apply server-side). Rejection-sampled to avoid modulo bias.
    const token = isDemo ? '000000' : generateOtpCode();

    // ── Send via WhatsApp (Meta Cloud API), fall back to Twilio Verify (skip for demo) ──
    if (!isDemo) {
      const sentViaWhatsapp = await sendWhatsappOtp(phone.trim(), token);
      if (!sentViaWhatsapp) {
        await sendViaTwilioVerify(phone.trim(), token);
      }
    }

    // ── Insert verification row ───────────────────────────────────────────────
    // token column holds the SHA-256 hex digest of the real code, never the
    // code itself — verify-phone-code hashes the caller's guess the same way
    // and compares digests. The plaintext `token` only ever leaves this
    // function via WhatsApp/Twilio to the user's own phone, never stored.
    const { data, error: insertErr } = await serviceClient
      .from('phone_verifications')
      .insert({
        user_id:    user.id,
        phone:      phone.trim(),
        token:      await hashToken(token),
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
    return safeErrorResponse(err, corsHeaders, 'create-phone-verification');
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
      throw new SafeError('Numéro de téléphone invalide. Vérifiez votre numéro et réessayez.');
    }
    throw new SafeError('Impossible d\'envoyer le code. Réessayez dans quelques instants.');
  }
}
