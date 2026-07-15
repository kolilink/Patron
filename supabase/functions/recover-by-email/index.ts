import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

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
    const { email, code, verificationId } = await req.json() as {
      email: string;
      code: string;
      verificationId: string;
    };

    if (!email || !code || !verificationId) {
      return new Response(JSON.stringify({ error: 'Paramètres manquants' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const normalizedEmail = email.trim().toLowerCase();
    const normalizedCode  = code.trim();

    console.log('recover-by-email: verificationId=', verificationId, 'email=', normalizedEmail, 'codeLen=', normalizedCode.length);

    const serviceClient = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    // Fetch by ID only — check each condition separately for clear errors
    const { data: verif, error: verifErr } = await serviceClient
      .from('email_verifications')
      .select('id, email, token, status, expires_at, failed_attempts')
      .eq('id', verificationId)
      .maybeSingle();

    // Never log verif in full — it contains the plaintext OTP `token`, which
    // would put valid, in-window account-recovery codes into edge logs.
    console.log('recover-by-email: rowFound=', !!verif, 'status=', verif?.status, 'err=', verifErr?.message);

    if (verifErr) throw verifErr;

    if (!verif) {
      return new Response(JSON.stringify({ error: 'Lien introuvable. Renvoyez le code.' }), {
        status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    if (verif.status !== 'en_attente') {
      return new Response(JSON.stringify({ error: 'Code déjà utilisé. Renvoyez le code.' }), {
        status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    if (new Date(verif.expires_at) < new Date()) {
      return new Response(JSON.stringify({ error: 'Code expiré. Renvoyez le code.' }), {
        status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    if (verif.failed_attempts >= MAX_FAILED_ATTEMPTS) {
      return new Response(JSON.stringify({ error: 'Trop de tentatives incorrectes. Renvoyez le code.' }), {
        status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    if (verif.email !== normalizedEmail) {
      console.error('recover-by-email: email mismatch stored=', verif.email, 'got=', normalizedEmail);
      return new Response(JSON.stringify({ error: 'Code invalide.' }), {
        status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    if (!timingSafeEqual(verif.token, normalizedCode)) {
      console.error('recover-by-email: token mismatch for verificationId=', verificationId);
      await serviceClient
        .from('email_verifications')
        .update({ failed_attempts: verif.failed_attempts + 1 })
        .eq('id', verificationId);
      return new Response(JSON.stringify({ error: 'Code incorrect. Réessayez.' }), {
        status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Find profile with this recovery email
    const { data: profile } = await serviceClient
      .from('profiles')
      .select('id')
      .eq('recovery_email', normalizedEmail)
      .maybeSingle();

    if (!profile) {
      return new Response(
        JSON.stringify({ error: 'Aucun compte associé à cet email.' }),
        { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    // Consume the verification row before generating session
    await serviceClient.from('email_verifications').delete().eq('id', verificationId);

    const { data: { user }, error: userErr } = await serviceClient.auth.admin.getUserById(profile.id);

    if (userErr || !user) {
      return new Response(JSON.stringify({ error: 'Compte introuvable.' }), {
        status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    let authEmail = user.email;
    if (!authEmail) {
      authEmail = `patron-${profile.id}@patron.internal`;
      await serviceClient.auth.admin.updateUserById(profile.id, {
        email: authEmail,
        email_confirm: true,
      });
    }

    const { data: linkData, error: linkErr } = await serviceClient.auth.admin.generateLink({
      type: 'magiclink',
      email: authEmail,
    });

    if (linkErr || !linkData?.properties?.hashed_token) {
      throw new Error(linkErr?.message ?? 'Impossible de générer la session.');
    }

    return new Response(
      JSON.stringify({ token_hash: linkData.properties.hashed_token }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Erreur inconnue';
    console.error('recover-by-email crash:', msg);
    return new Response(JSON.stringify({ error: msg }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
