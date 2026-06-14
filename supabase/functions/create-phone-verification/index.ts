import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

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
    const isDemo = DEMO_PHONE !== '' && phone.trim() === DEMO_PHONE;

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

      await serviceClient.from('phone_verification_attempts').insert({ phone: phone.trim() });

      await serviceClient
        .from('phone_verification_attempts')
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

    // ── Send via Twilio Verify with custom code (skip for demo) ─────────────
    if (!isDemo) {
      const accountSid = Deno.env.get('TWILIO_ACCOUNT_SID')!;
      const authToken  = Deno.env.get('TWILIO_AUTH_TOKEN')!;
      const verifySid  = Deno.env.get('TWILIO_VERIFY_SID')!;

      const verifyRes = await fetch(
        `https://verify.twilio.com/v2/Services/${verifySid}/Verifications`,
        {
          method:  'POST',
          headers: {
            Authorization:  'Basic ' + btoa(`${accountSid}:${authToken}`),
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: new URLSearchParams({
            To:         phone.trim(),
            Channel:    'sms',
            CustomCode: token,
          }),
        },
      );

      if (!verifyRes.ok) {
        const errJson = await verifyRes.json().catch(() => ({})) as { code?: number; message?: string };
        if (errJson.code === 60200 || errJson.code === 21211) {
          throw new Error('Numéro de téléphone invalide. Vérifiez votre numéro et réessayez.');
        }
        throw new Error('Impossible d\'envoyer le code. Réessayez dans quelques instants.');
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
        expires_at: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
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
