import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { safeErrorResponse } from '../_shared/errors.ts';
import { isDemoPhone, pickRestoreProfileId } from '../_shared/phone.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const { phone, verificationId } = await req.json() as { phone: string; verificationId: string };

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
      .select('status, phone, user_id')
      .eq('id', verificationId)
      .eq('status', 'verifie')
      .gt('expires_at', new Date().toISOString())
      .maybeSingle();

    if (!verif || verif.phone !== phone.trim()) {
      return new Response(JSON.stringify({ error: 'Vérification invalide ou expirée' }), {
        status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Defense-in-depth: confirm the caller is the same anon session that initiated the
    // verification. verif.user_id is set for all rows created by the current app version.
    if (verif.user_id) {
      const authHeader = req.headers.get('Authorization') ?? '';
      if (!authHeader.startsWith('Bearer ')) {
        return new Response(JSON.stringify({ error: 'Accès refusé' }), {
          status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      const callerJwt = authHeader.substring(7);
      const { data: { user: callerUser }, error: jwtErr } = await serviceClient.auth.getUser(callerJwt);
      if (jwtErr || !callerUser || callerUser.id !== verif.user_id) {
        return new Response(JSON.stringify({ error: 'Accès refusé' }), {
          status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
    }

    // Look up by phone first (normal returning-user login). The fallback to the
    // verifying anonymous session's own profile exists for the reviewer demo
    // account only (it has no phone on file) — see pickRestoreProfileId.
    const { data: profileByPhone } = await serviceClient
      .from('profiles')
      .select('id')
      .eq('phone', phone.trim())
      .maybeSingle();

    let profileByVerifUser: string | null = null;
    if (!profileByPhone && verif.user_id) {
      const { data: profileByUser } = await serviceClient
        .from('profiles')
        .select('id')
        .eq('id', verif.user_id)
        .maybeSingle();
      profileByVerifUser = profileByUser?.id ?? null;
    }

    const profileId = pickRestoreProfileId({
      profileByPhone: profileByPhone?.id ?? null,
      profileByVerifUser,
      isDemo: isDemoPhone(phone, Deno.env.get('DEMO_PHONE') ?? '', Deno.env.get('DEMO_PHONES') ?? ''),
    });

    if (!profileId) {
      // The caller has just proven they hold this number, so telling them it has
      // no account is not an enumeration oracle. The app maps this code to its
      // "Aucun compte associé à ce numéro → Créer un compte" prompt.
      return new Response(JSON.stringify({ error: 'PHONE_NOT_FOUND' }), {
        status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const profile = { id: profileId };

    // Consume the verification row now — before generating the magic link.
    // If link generation fails the row is gone and the user must re-verify,
    // which is correct: a verified-but-unconsumed row could otherwise be
    // replayed indefinitely.
    await serviceClient.from('phone_verifications').delete().eq('id', verificationId);

    const { data: { user }, error: userErr } = await serviceClient.auth.admin.getUserById(profile.id);

    if (!user) {
      return new Response(JSON.stringify({ error: 'Compte introuvable' }), {
        status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    let email = user.email;
    if (!email) {
      email = `patron-${profile.id}@patron.internal`;
      const { error: updateErr } = await serviceClient.auth.admin.updateUserById(profile.id, {
        email,
        email_confirm: true,
      });
      if (updateErr) console.error('updateUser error:', updateErr.message);
    }

    const { data: linkData, error: linkErr } = await serviceClient.auth.admin.generateLink({
      type: 'magiclink',
      email,
    });

    if (linkErr || !linkData?.properties?.hashed_token) {
      console.error('restore-phone-session: generateLink failed:', linkErr?.message);
      return new Response(JSON.stringify({ error: 'Impossible de générer le lien de connexion' }), {
        status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    return new Response(
      JSON.stringify({ token_hash: linkData.properties.hashed_token }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  } catch (err) {
    return safeErrorResponse(err, corsHeaders, 'restore-phone-session');
  }
});
