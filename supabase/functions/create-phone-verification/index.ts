import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { SafeError } from '../_shared/errors.ts';
import { handleCreatePhoneVerification, CreatePhoneVerificationDeps } from './handler.ts';

// All decision logic (rate limits, demo bypass, response shape) lives in
// handler.ts so it is unit-tested; this file only wires the real services.
// Phase 9 / Finding 1: the response never depends on whether the number is
// already registered — see handler.ts.

// Cryptographically-secure uniform 6-digit code (100000–999999).
// Rejection sampling drops the top of the u32 range so `% 900000` carries no
// modulo bias.
function generateOtpCode(): string {
  const range = 900000;
  const limit = Math.floor(0xFFFFFFFF / range) * range;
  const buf = new Uint32Array(1);
  let r: number;
  do {
    crypto.getRandomValues(buf);
    r = buf[0];
  } while (r >= limit);
  return (100000 + (r % range)).toString();
}

// SHA-256 hex digest — stored in place of the raw code so a DB read (backup,
// leaked service-role key, a future RLS mistake) can't hand out a directly
// usable, still-valid 10-minute code. Deno's edge runtime has full Web
// Crypto (unlike Hermes on the mobile client, which is why invite codes
// historically avoided it) so this needs no extra dependency.
async function hashToken(token: string): Promise<string> {
  const bytes = new TextEncoder().encode(token);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

serve((req) => {
  const serviceClient = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  // ── Demo / App Store review bypass (decided in handler.ts) ────────────────
  // ACCEPTED RISK (documented, not an oversight): Apple/Google reviewers have no
  // WhatsApp access, so ONE reserved phone number (the DEMO_PHONE /
  // DEMO_PHONES Supabase secrets — never committed to this repo) skips the
  // WhatsApp send and rate limits and gets a fixed code. Anyone who learns
  // that number AND the fixed code can log in as that reviewer account.
  // Mitigations: the number is unpublished and lives only in Supabase
  // secrets + App Store Connect review notes; the account is a throwaway
  // review business with no real data; ROTATE both whenever review ends or
  // the number may have leaked (update the secret, the demo profile's phone,
  // and the review notes together). Do NOT write the number or the code in
  // docs, comments or tests.
  const deps: CreatePhoneVerificationDeps = {
    getUser: async (authHeader) => {
      const userClient = createClient(
        Deno.env.get('SUPABASE_URL')!,
        Deno.env.get('SUPABASE_ANON_KEY')!,
        { global: { headers: { Authorization: authHeader } } },
      );
      const { data: { user }, error } = await userClient.auth.getUser();
      return error || !user ? null : { id: user.id };
    },
    countPhoneAttempts: async (phone, sinceIso) => {
      const { count } = await serviceClient
        .from('phone_verification_attempts')
        .select('*', { count: 'exact', head: true })
        .eq('phone', phone)
        .gt('attempted_at', sinceIso);
      return count ?? 0;
    },
    // Secondary limit scoped per IP — the per-phone limit doesn't stop an
    // attacker rotating through many phone numbers to run up WhatsApp/Twilio costs.
    countIpAttempts: async (ip, sinceIso) => {
      const { count } = await serviceClient
        .from('ip_verification_attempts')
        .select('*', { count: 'exact', head: true })
        .eq('ip', ip)
        .eq('endpoint', 'phone')
        .gt('attempted_at', sinceIso);
      return count ?? 0;
    },
    recordAttempts: async (phone, ip) => {
      await serviceClient.from('phone_verification_attempts').insert({ phone });
      await serviceClient.from('ip_verification_attempts').insert({ ip, endpoint: 'phone' });
    },
    purgeAttemptsBefore: async (iso) => {
      await serviceClient.from('phone_verification_attempts').delete().lt('attempted_at', iso);
      await serviceClient.from('ip_verification_attempts').delete().lt('attempted_at', iso);
    },
    // WhatsApp (Meta Cloud API), falling back to Twilio Verify.
    sendOtp: async (phone, code) => {
      const sentViaWhatsapp = await sendWhatsappOtp(phone, code);
      if (!sentViaWhatsapp) await sendViaTwilioVerify(phone, code);
    },
    // token column holds the SHA-256 hex digest of the real code, never the
    // code itself — verify-phone-code hashes the caller's guess the same way
    // and compares digests. The plaintext only ever leaves this function via
    // WhatsApp/Twilio to the user's own phone, never stored.
    insertVerification: async ({ userId, phone, tokenHash, expiresAtIso }) => {
      const { data, error } = await serviceClient
        .from('phone_verifications')
        .insert({ user_id: userId, phone, token: tokenHash, status: 'en_attente', expires_at: expiresAtIso })
        .select('id')
        .single();
      if (error) throw error;
      return data.id as string;
    },
    // CSPRNG, not Math.random() — Deno exposes crypto.getRandomValues (the
    // Hermes limitation that forces Math.random() for client-side invite codes
    // does not apply server-side). Rejection-sampled to avoid modulo bias.
    generateCode: generateOtpCode,
    hashToken,
    now: () => Date.now(),
    demoPhone: Deno.env.get('DEMO_PHONE') ?? '',
    demoPhones: Deno.env.get('DEMO_PHONES') ?? '',
  };
  return handleCreatePhoneVerification(req, deps);
});

// ── WhatsApp via Meta Cloud API (free for authentication templates) ─────────
async function sendWhatsappOtp(phone: string, code: string): Promise<boolean> {
  const phoneId = Deno.env.get('META_WHATSAPP_PHONE_ID')!;
  const token   = Deno.env.get('META_WHATSAPP_TOKEN')!;

  try {
    const res = await fetch(`https://graph.facebook.com/v21.0/${phoneId}/messages`, {
      method:  'POST',
      headers: {
        Authorization:  `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to:                phone.replace(/^\+/, ''),
        type:              'template',
        template: {
          name:     'whatsapp_otp',
          language: { code: 'fr' },
          components: [
            { type: 'body', parameters: [{ type: 'text', text: code }] },
            {
              type:       'button',
              sub_type:   'url',
              index:      0,
              parameters: [{ type: 'text', text: code }],
            },
          ],
        },
      }),
    });
    const resBody = await res.text();
    if (!res.ok) {
      console.error('WhatsApp send failed:', res.status, resBody);
    } else {
      console.log('WhatsApp send accepted:', resBody, 'to:', phone.replace(/^\+/, ''));
    }
    return res.ok;
  } catch (e) {
    console.error('WhatsApp send threw:', e instanceof Error ? e.message : e);
    return false;
  }
}

// ── Fallback via Twilio Verify (proven-reliable path, used when Meta WhatsApp fails) ──
async function sendViaTwilioVerify(phone: string, code: string): Promise<void> {
  const accountSid = Deno.env.get('TWILIO_ACCOUNT_SID')!;
  const authToken  = Deno.env.get('TWILIO_AUTH_TOKEN')!;
  const verifySid  = Deno.env.get('TWILIO_VERIFY_SID')!;

  const res = await fetch(
    `https://verify.twilio.com/v2/Services/${verifySid}/Verifications`,
    {
      method:  'POST',
      headers: {
        Authorization:  'Basic ' + btoa(`${accountSid}:${authToken}`),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        To:         phone,
        Channel:    'sms',
        CustomCode: code,
      }),
    },
  );

  if (!res.ok) {
    const errJson = await res.json().catch(() => ({})) as { code?: number; message?: string };
    console.error('Twilio Verify send failed:', res.status, errJson);
    if (errJson.code === 60200 || errJson.code === 21211) {
      throw new SafeError('Numéro de téléphone invalide. Vérifiez votre numéro et réessayez.');
    }
    throw new SafeError('Impossible d\'envoyer le code. Réessayez dans quelques instants.');
  }
}
