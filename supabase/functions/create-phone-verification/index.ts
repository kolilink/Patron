import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

function generateToken(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let token = 'PATRON-';
  for (let i = 0; i < 6; i++) {
    token += chars[Math.floor(Math.random() * chars.length)];
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
    // If the phone matches DEMO_PHONE env var, skip WhatsApp entirely.
    // The row is inserted already-verified with a fixed code so the reviewer
    // can tap "J'ai envoyé le message" and get straight in — no WhatsApp needed.
    const DEMO_PHONE = Deno.env.get('DEMO_PHONE') ?? '';
    const isDemo = DEMO_PHONE !== '' && phone.trim() === DEMO_PHONE;

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
    // Demo rows are pre-marked verified so no WhatsApp relay is needed.
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
