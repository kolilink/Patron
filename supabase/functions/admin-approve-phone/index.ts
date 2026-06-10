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
    // Only callable with the service role key — not exposed to regular users.
    const authHeader = req.headers.get('Authorization') ?? '';
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
    const bearerToken = authHeader.replace('Bearer ', '');

    if (bearerToken !== serviceKey) {
      return new Response(JSON.stringify({ error: 'Non autorisé' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const { phone } = await req.json() as { phone: string };
    if (!phone) {
      return new Response(JSON.stringify({ error: 'Numéro requis' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const serviceClient = createClient(
      Deno.env.get('SUPABASE_URL')!,
      serviceKey,
    );

    // Mark the most recent pending verification for this phone as verified.
    const { data, error } = await serviceClient
      .from('phone_verifications')
      .update({ status: 'verifie' })
      .eq('phone', phone.trim())
      .eq('status', 'en_attente')
      .order('created_at', { ascending: false })
      .limit(1)
      .select('id, phone, status')
      .single();

    if (error) {
      return new Response(JSON.stringify({ error: 'Aucune vérification en attente pour ce numéro' }), {
        status: 404,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    return new Response(JSON.stringify({ success: true, verification: data }), {
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
