import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';

// ============================================================
// Shared between djomi-checkout (creates payments, then polls this
// right after the user returns from paying) and djomi-webhook (a
// backstop that in practice may never fire — see CLAUDE.md's "Djomi
// out-of-app subscription": the Djomi account currently in use is
// shared with a friend's project and its one webhook slot already
// points at his endpoint, not ours, so polling on return is the real
// mechanism, not the webhook).
// ============================================================

export const BASE_URL = 'https://api.djomy.africa';
export const SUBSCRIPTION_DAYS = 30;

// Read from Supabase Edge Function secrets, never hardcoded — this value
// was briefly pasted in plaintext during a chat session; committing it
// into source would have baked that exposure permanently into git
// history. Same fail-closed style as djomi_id/djomi_key.
export function partnerDomainKey(): string {
  const key = Deno.env.get('djomi_partner_domain');
  if (!key) throw new Error('Configuration Djomi incomplète (djomi_partner_domain manquant).');
  return key;
}

// Constant-time comparison of two hex strings — avoids leaking, via response
// timing, how many leading characters of a forged HMAC signature were correct.
export function timingSafeEqualHex(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const aB = enc.encode(a);
  const bB = enc.encode(b);
  let diff = aB.length ^ bB.length;
  const len = Math.max(aB.length, bB.length);
  for (let i = 0; i < len; i++) diff |= (aB[i] ?? 0) ^ (bB[i] ?? 0);
  return diff === 0;
}

export async function hmacHex(data: string, secret: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(data));
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function djomiAuthToken(clientId: string, clientSecret: string): Promise<{ accessToken: string; xApiKey: string }> {
  const signature = await hmacHex(clientId, clientSecret);
  const xApiKey = `${clientId}:${signature}`;

  const authResp = await fetch(`${BASE_URL}/v1/auth`, {
    method: 'POST',
    headers: { 'X-API-KEY': xApiKey, 'Content-Type': 'application/json', 'X-PARTNER-DOMAIN': partnerDomainKey() },
    body: JSON.stringify({}),
  });
  const authData = await authResp.json();
  if (!authResp.ok || !authData.data?.accessToken) {
    console.error('djomi auth failed:', JSON.stringify(authData));
    throw new Error('auth_failed');
  }
  return { accessToken: authData.data.accessToken, xApiKey };
}

export type DjomiStatus = 'success' | 'pending' | 'error';

// Re-checks a transaction directly against Djomi — never trusts a
// webhook payload's own status field (Djomi's own integration guidance
// is explicit about this: always re-verify server-side). Only ever
// called with a transaction_id WE stored ourselves in
// djomi_pending_payments, never one supplied directly by a client —
// see that table's comment in migration_v140.sql for why that matters.
export async function verifyDjomiTransaction(
  transactionId: string,
  clientId: string,
  clientSecret: string,
): Promise<DjomiStatus> {
  try {
    const { accessToken, xApiKey } = await djomiAuthToken(clientId, clientSecret);

    const verifyResp = await fetch(`${BASE_URL}/v1/payments/${transactionId}`, {
      headers: { Authorization: `Bearer ${accessToken}`, 'X-API-KEY': xApiKey, 'X-PARTNER-DOMAIN': partnerDomainKey() },
    });
    const verifyData = await verifyResp.json();
    console.log(`djomi verify ${transactionId}:`, JSON.stringify(verifyData));

    // SUCCESS is Djomi's documented terminal-success value; everything
    // else (PENDING, CAPTURED, or an unrecognized value) is treated as
    // "not confirmed yet" rather than failed, since a mobile money
    // charge can sit in an intermediate state for a while. The caller
    // polling this only gives up after its own timeout, never because
    // of a specific non-SUCCESS value here.
    return verifyData.data?.status === 'SUCCESS' ? 'success' : 'pending';
  } catch (err) {
    console.error('verifyDjomiTransaction error:', err);
    return 'error';
  }
}

function addDays(base: Date, days: number): string {
  const d = new Date(base);
  d.setDate(d.getDate() + days);
  return d.toISOString();
}

export function djomiServiceClient(): SupabaseClient {
  return createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
}

export type PendingPayment = {
  reference: string;
  business_id: string;
  transaction_id: string | null;
  resolved_at: string | null;
};

export async function getPendingPayment(supabase: SupabaseClient, reference: string): Promise<PendingPayment | null> {
  const { data, error } = await supabase
    .from('djomi_pending_payments')
    .select('reference, business_id, transaction_id, resolved_at')
    .eq('reference', reference)
    .maybeSingle();
  if (error) {
    console.error('getPendingPayment error:', error);
    return null;
  }
  return data;
}

// The single entry point that activates a subscription from a Djomi
// payment — used by djomi-checkout's poll, djomi-webhook, and
// djomi-sweep alike, so there is exactly one place that decides what
// "confirmed" means. Idempotent on both writes (activateDjomiSubscription
// always sets the same fields to the same values; the resolved_at update
// is a no-op the second time), so it's safe for two of these three
// callers to race on the same payment without corrupting anything.
export async function confirmDjomiPayment(
  supabase: SupabaseClient,
  pending: PendingPayment,
  transactionId: string,
): Promise<void> {
  await activateDjomiSubscription(supabase, pending.business_id, transactionId);

  const { error } = await supabase
    .from('djomi_pending_payments')
    .update({ resolved_at: new Date().toISOString(), transaction_id: transactionId })
    .eq('reference', pending.reference);
  if (error) console.error(`confirmDjomiPayment: failed to mark ${pending.reference} resolved:`, error);
}

async function activateDjomiSubscription(
  supabase: SupabaseClient,
  businessId: string,
  transactionId: string,
): Promise<void> {
  const { error } = await supabase
    .from('businesses')
    .update({
      subscription_status: 'active',
      subscription_expires_at: addDays(new Date(), SUBSCRIPTION_DAYS),
      payment_provider: 'djomi',
      djomi_transaction_id: transactionId,
      updated_at: new Date().toISOString(),
    })
    .eq('id', businessId);

  if (error) {
    console.error(`activateDjomiSubscription: failed for business ${businessId}:`, error);
    throw error;
  }
  console.log(`activateDjomiSubscription: activated Alpha Pro for business ${businessId} via transaction ${transactionId}`);
}

// Unresolved rows created within the lookback window — what djomi-sweep
// re-checks. Bounded so a genuinely abandoned attempt from days ago
// doesn't get polled against Djomi forever.
export async function listUnresolvedPendingPayments(
  supabase: SupabaseClient,
  lookbackHours: number,
): Promise<PendingPayment[]> {
  const since = new Date(Date.now() - lookbackHours * 60 * 60 * 1000).toISOString();
  const { data, error } = await supabase
    .from('djomi_pending_payments')
    .select('reference, business_id, transaction_id, resolved_at')
    .is('resolved_at', null)
    .not('transaction_id', 'is', null)
    .gte('created_at', since);
  if (error) {
    console.error('listUnresolvedPendingPayments error:', error);
    return [];
  }
  return data ?? [];
}
