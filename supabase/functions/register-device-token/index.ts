import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

function ok(body: unknown) {
  return new Response(JSON.stringify(body), {
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

function err(msg: string, status = 400) {
  return new Response(JSON.stringify({ error: msg }), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const authHeader = req.headers.get('Authorization');
    if (!authHeader?.startsWith('Bearer ')) return err('Non authentifié', 401);

    const { token, platform, action } = await req.json() as {
      token: string | null;
      platform: 'ios' | 'android';
      action?: 'delete';
    };

    // Silently succeed if the user denied permission (null token)
    if (!token) return ok({ success: true });

    // Validate Expo push token format
    if (!token.startsWith('ExponentPushToken[')) {
      return err('Token invalide');
    }

    if (!['ios', 'android'].includes(platform)) return err('Plateforme invalide');

    const userClient = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_ANON_KEY')!,
      { global: { headers: { Authorization: authHeader } } },
    );
    const { data: { user }, error: userErr } = await userClient.auth.getUser();
    if (userErr || !user) return err('Session invalide', 401);

    const serviceClient = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    if (action === 'delete') {
      await serviceClient
        .from('device_tokens')
        .delete()
        .eq('user_id', user.id)
        .eq('token', token);
      return ok({ success: true });
    }

    // Upsert — update updated_at on re-registration (token rotation)
    const { error: upsertErr } = await serviceClient
      .from('device_tokens')
      .upsert(
        { user_id: user.id, token, platform, updated_at: new Date().toISOString() },
        { onConflict: 'user_id,token' },
      );

    if (upsertErr) throw upsertErr;

    return ok({ success: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Erreur inconnue';
    console.error('register-device-token crash:', msg);
    return new Response(JSON.stringify({ error: msg }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
