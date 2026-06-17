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
      .select('id, token')
      .eq('id', verificationId)
      .eq('phone', phone.trim())
      .eq('status', 'en_attente')
      .gt('expires_at', new Date().toISOString())
      .maybeSingle();

    if (!verif) {
      return err('Code expiré. Demandez un nouveau code.');
    }

    // Check code against stored token
    if (verif.token !== code.trim()) {
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
