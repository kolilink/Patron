import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

function err(msg: string, status = 400) {
  return new Response(JSON.stringify({ error: msg }), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

const MAX_FAILED_ATTEMPTS = 5;

// Constant-time comparison — prevents timing-based brute-force of the code.
function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const aBytes = enc.encode(a);
  const bBytes = enc.encode(b);
  const len = Math.max(aBytes.length, bBytes.length);
  let diff = aBytes.length ^ bBytes.length;
  for (let i = 0; i < len; i++) {
    diff |= (aBytes[i] ?? 0) ^ (bBytes[i] ?? 0);
  }
  return diff === 0;
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const { phone, code, verificationId } = await req.json() as {
      phone: string;
      code: string;
      verificationId: string;
    };

    if (!phone || !code || !verificationId) return err('Paramètres manquants');

    const serviceClient = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    // Find the pending verification row
    const { data: verif } = await serviceClient
      .from('phone_verifications')
      .select('id, token, failed_attempts')
      .eq('id', verificationId)
      .eq('phone', phone.trim())
      .eq('status', 'en_attente')
      .gt('expires_at', new Date().toISOString())
      .maybeSingle();

    if (!verif) {
      return err('Code expiré. Demandez un nouveau code.');
    }

    if (verif.failed_attempts >= MAX_FAILED_ATTEMPTS) {
      return err('Trop de tentatives incorrectes. Demandez un nouveau code.');
    }

    // Check code against stored token (constant-time to avoid leaking match position)
    if (!timingSafeEqual(verif.token, code.trim())) {
      await serviceClient
        .from('phone_verifications')
        .update({ failed_attempts: verif.failed_attempts + 1 })
        .eq('id', verificationId);
      return err('Code incorrect. Vérifiez et réessayez.');
    }

    // Mark our row as verified
    await serviceClient
      .from('phone_verifications')
      .update({ status: 'verifie' })
      .eq('id', verificationId);

    return new Response(JSON.stringify({ verified: true }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Erreur inconnue';
    return new Response(JSON.stringify({ error: msg }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
