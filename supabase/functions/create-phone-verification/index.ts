import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// Cryptographically secure token using Deno's Web Crypto API.
// 8 chars from 36-char alphabet = ~2.8 trillion combinations.
function generateToken(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  let token = 'PATRON-';
  for (const byte of bytes) {
    token += chars[byte % chars.length];
  }
  return token;
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    // login=true: caller wants to log in as an existing phone-verified account.
    // login=false (default): caller is registering — phone must not already exist.
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
    // If the phone matches DEMO_PHONE env var, skip WhatsApp and rate limiting.
    const DEMO_PHONE = Deno.env.get('DEMO_PHONE') ?? '';
    const isDemo = DEMO_PHONE !== '' && phone.trim() === DEMO_PHONE;

    // ── Rate limiting (skip for demo) ─────────────────────────────────────────
    // Max 3 verification requests per phone number per 10 minutes.
    if (!isDemo) {
      const { count } = await serviceClient
        .from('phone_verification_attempts')
        .select('*', { count: 'exact', head: true })
        .eq('phone', phone.trim())
        .gt('attempted_at', new Date(Date.now() - 10 * 60 * 1000).toISOString());

      if ((count ?? 0) >= 3) {
        return new Response(
          JSON.stringify({ error: 'Trop de tentatives. Réessayez dans 10 minutes.' }),
          { status: 429, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
        );
      }

      // Record this attempt before proceeding
      await serviceClient
        .from('phone_verification_attempts')
        .insert({ phone: phone.trim() });

      // Clean up attempts older than 1 hour to keep the table small
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

    const token = isDemo ? 'PATRON-000000' : generateToken();
    const status = isDemo ? 'verifie' : 'en_attente';

    const { data, error: insertErr } = await serviceClient
      .from('phone_verifications')
      .insert({
        user_id: user.id,
        phone: phone.trim(),
        token,
        status,
        expires_at: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
      })
      .select('id')
      .single();

    if (insertErr) throw insertErr;

    return new Response(JSON.stringify({ token, verificationId: data.id }), {
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
