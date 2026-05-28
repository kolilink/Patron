import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const { phone, verificationId } = await req.json() as { phone: string; verificationId: string };
    console.log('restore-phone-session called | phone:', phone, '| verificationId:', verificationId);

    if (!phone || !verificationId) {
      return new Response(JSON.stringify({ error: 'Paramètres manquants' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const serviceClient = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    const { data: verif } = await serviceClient
      .from('phone_verifications')
      .select('status, phone')
      .eq('id', verificationId)
      .eq('status', 'verifie')
      .maybeSingle();

    console.log('verif row:', JSON.stringify(verif));

    if (!verif || verif.phone !== phone.trim()) {
      console.log('FAIL: verif mismatch | verif.phone:', verif?.phone, '| phone:', phone.trim());
      return new Response(JSON.stringify({ error: 'Vérification invalide ou expirée' }), {
        status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const { data: profile } = await serviceClient
      .from('profiles')
      .select('id')
      .eq('phone', phone.trim())
      .maybeSingle();

    console.log('profile:', JSON.stringify(profile));

    if (!profile) {
      return new Response(JSON.stringify({ error: 'Aucun compte trouvé pour ce numéro' }), {
        status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const { data: { user }, error: userErr } = await serviceClient.auth.admin.getUserById(profile.id);
    console.log('user email:', user?.email, '| userErr:', userErr?.message);

    if (!user) {
      return new Response(JSON.stringify({ error: 'Compte introuvable' }), {
        status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    let email = user.email;
    if (!email) {
      email = `patron-${profile.id}@patron.internal`;
      console.log('assigning synthetic email:', email);
      const { error: updateErr } = await serviceClient.auth.admin.updateUserById(profile.id, {
        email,
        email_confirm: true,
      });
      console.log('updateUser error:', updateErr?.message ?? 'none');
    }

    console.log('calling generateLink for email:', email);
    const { data: linkData, error: linkErr } = await serviceClient.auth.admin.generateLink({
      type: 'magiclink',
      email,
    });
    console.log('linkErr:', linkErr?.message ?? 'none');
    console.log('hashed_token present:', !!linkData?.properties?.hashed_token);

    if (linkErr || !linkData?.properties?.hashed_token) {
      const errMsg = linkErr?.message ?? 'Impossible de générer le lien de connexion';
      return new Response(JSON.stringify({ error: errMsg }), {
        status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    await serviceClient.from('phone_verifications').delete().eq('id', verificationId);

    return new Response(
      JSON.stringify({ token_hash: linkData.properties.hashed_token }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Erreur inconnue';
    console.error('restore-phone-session crash:', msg);
    return new Response(JSON.stringify({ error: msg }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
