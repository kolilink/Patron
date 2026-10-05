// Request handler for create-phone-verification, with every side effect behind
// an injected interface so Jest can exercise the real decision logic (status
// codes, response shape, call sequence) without Deno, Supabase or WhatsApp.
// index.ts wires the Deno / supabase-js / Meta / Twilio implementations.
import { safeErrorResponse } from '../_shared/errors.ts';
import { isDemoPhone } from '../_shared/phone.ts';

export interface CreatePhoneVerificationDeps {
  /** Caller identity from the Authorization header's JWT, or null. */
  getUser(authHeader: string): Promise<{ id: string } | null>;
  countPhoneAttempts(phone: string, sinceIso: string): Promise<number>;
  countIpAttempts(ip: string, sinceIso: string): Promise<number>;
  recordAttempts(phone: string, ip: string): Promise<void>;
  purgeAttemptsBefore(iso: string): Promise<void>;
  /** Sends the OTP (WhatsApp, falling back to SMS). May throw SafeError. */
  sendOtp(phone: string, code: string): Promise<void>;
  insertVerification(row: { userId: string; phone: string; tokenHash: string; expiresAtIso: string }): Promise<string>;
  generateCode(): string;
  hashToken(token: string): Promise<string>;
  now(): number;
  demoPhone: string;
  demoPhones: string;
}

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

function getClientIp(req: Request): string {
  const fwd = req.headers.get('x-forwarded-for');
  return fwd ? fwd.split(',')[0].trim() : 'unknown';
}

export async function handleCreatePhoneVerification(req: Request, deps: CreatePhoneVerificationDeps): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const { phone, login = false } = await req.json() as { phone: string; login?: boolean };
    if (!phone) return json({ error: 'Numéro requis' }, 400);

    const authHeader = req.headers.get('Authorization');
    if (!authHeader) return json({ error: 'Non authentifié' }, 401);
    const user = await deps.getUser(authHeader);
    if (!user) return json({ error: 'Utilisateur introuvable' }, 401);

    const isDemo = isDemoPhone(phone, deps.demoPhone, deps.demoPhones);

    if (!isDemo) {
      const hourAgo = new Date(deps.now() - 60 * 60 * 1000).toISOString();
      if ((await deps.countPhoneAttempts(phone.trim(), new Date(deps.now() - 10 * 60 * 1000).toISOString())) >= 5) {
        return json({ error: 'Trop de tentatives. Réessayez dans 10 minutes.' }, 429);
      }
      const clientIp = getClientIp(req);
      if ((await deps.countIpAttempts(clientIp, hourAgo)) >= 20) {
        return json({ error: 'Trop de tentatives. Réessayez plus tard.' }, 429);
      }
      await deps.recordAttempts(phone.trim(), clientIp);
      await deps.purgeAttemptsBefore(hourAgo);
    }

    // Phase 9 (Finding 1): there is deliberately NO "is this number registered?"
    // lookup here, and no response/timing that depends on it. This endpoint is
    // callable by anyone who can mint a free anonymous session, so answering
    // PHONE_EXISTS / PHONE_NOT_FOUND turned it into a phone-number directory of
    // Patron's users. Signup and login now follow ONE path: send a code, record
    // a verification, return its id — for every number. Whether an account
    // exists is only revealed AFTER the caller proves they hold the number
    // (OTP verified): restore-phone-session answers PHONE_NOT_FOUND to a login,
    // upgrade_anonymous_user refuses a signup on a taken number. `login` is
    // still accepted (older clients send it) and ignored.
    void login;

    const token = isDemo ? '000000' : deps.generateCode();
    if (!isDemo) await deps.sendOtp(phone.trim(), token);

    const verificationId = await deps.insertVerification({
      userId: user.id,
      phone: phone.trim(),
      tokenHash: await deps.hashToken(token),
      expiresAtIso: new Date(deps.now() + 10 * 60 * 1000).toISOString(),
    });
    return json({ verificationId });
  } catch (err) {
    return safeErrorResponse(err, corsHeaders, 'create-phone-verification');
  }
}

