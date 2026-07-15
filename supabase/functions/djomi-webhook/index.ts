import { hmacHex, timingSafeEqualHex, verifyDjomiTransaction, confirmDjomiPayment, djomiServiceClient, getPendingPayment } from '../_shared/djomi.ts';

// ============================================================
// djomi-webhook — a BACKSTOP, not the primary confirmation path.
//
// The Djomi account currently in use is shared with a friend's project,
// and Djomi's dashboard only allows one webhook URL per account — his
// project already claims that slot, so Djomi has no way to call this
// function's URL under the current setup. The real confirmation
// mechanism is djomi-checkout polling Djomi's transaction-status
// endpoint directly right after the merchant returns from paying (see
// that file). This function is kept deployed in case the webhook slot
// situation ever changes (a separate Djomi account, or Djomi adds
// support for multiple webhooks) — if it never fires, nothing is lost;
// djomi-checkout's polling already does the same job independently.
//
// NOTE ON FIELD NAMES: Djomi's exact webhook JSON shape wasn't
// available from public docs when this was written (their dev docs
// are auth-gated). The field lookups below try the most likely key
// paths based on what IS documented (payment.success event, a
// verify_payment-by-transactionId pattern). The first time a real
// webhook fires, log the raw body (already done below) and correct
// the lookups if they don't match reality.
//
// Deploy with --no-verify-jwt (Djomi can't send a Supabase JWT) and
// authenticate via signature instead, same shape as stripe-webhook.
// ============================================================

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: { 'Access-Control-Allow-Origin': '*' } });
  }
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  try {
    const CLIENT_ID = Deno.env.get('djomi_id');
    const CLIENT_SECRET = Deno.env.get('djomi_key');
    if (!CLIENT_ID || !CLIENT_SECRET) {
      throw new Error('Configuration Djomi incomplète.');
    }

    // ─── Signature verification ───────────────────────────────
    // X-Webhook-Signature: "v1:<hex>", hex = HMAC-SHA256(rawBody, clientSecret).
    const rawBody = await req.text();
    const sigHeader = req.headers.get('X-Webhook-Signature') ?? '';
    const [version, providedHex] = sigHeader.split(':');
    if (version !== 'v1' || !providedHex) {
      console.warn('djomi-webhook: missing/malformed signature header');
      return new Response('Unauthorized', { status: 401 });
    }
    const expectedHex = await hmacHex(rawBody, CLIENT_SECRET);
    if (!timingSafeEqualHex(providedHex, expectedHex)) {
      console.warn('djomi-webhook: signature mismatch');
      return new Response('Unauthorized', { status: 401 });
    }

    const body = JSON.parse(rawBody);
    console.log('djomi-webhook raw payload:', rawBody);

    const eventType: string | undefined = body.event ?? body.type;
    const status: string | undefined = body.data?.status ?? body.status;
    const transactionId: string | undefined =
      body.data?.transactionId ?? body.transactionId ?? body.data?.id ?? body.id;
    const reference: string | undefined =
      body.data?.merchantPaymentReference ?? body.merchantPaymentReference ??
      body.data?.reference ?? body.reference;

    if (!reference) {
      console.warn('djomi-webhook: missing reference — skipping', { eventType, transactionId });
      return new Response(JSON.stringify({ received: true }), { headers: { 'Content-Type': 'application/json' } });
    }

    // Never trust the payload's own status field for activation — only
    // to decide whether it's worth looking up our pending-payment row
    // at all. Real confirmation still requires djomi-checkout's own
    // GET /v1/payments/{transactionId} lookup, which happens below via
    // the same trust boundary the poll path uses: business_id always
    // comes from OUR djomi_pending_payments row for this reference,
    // never parsed out of anything the webhook itself claims.
    if (status !== 'SUCCESS' && eventType !== 'payment.success') {
      console.log(`djomi-webhook: ${eventType ?? 'event'} for ${reference} is not a success — skipping`);
      return new Response(JSON.stringify({ received: true }), { headers: { 'Content-Type': 'application/json' } });
    }
    if (!transactionId) {
      console.warn('djomi-webhook: success event but no transactionId — skipping', reference);
      return new Response(JSON.stringify({ received: true }), { headers: { 'Content-Type': 'application/json' } });
    }

    const supabase = djomiServiceClient();
    const pending = await getPendingPayment(supabase, reference);
    if (!pending) {
      console.warn(`djomi-webhook: no djomi_pending_payments row for reference ${reference} — skipping`);
      return new Response(JSON.stringify({ received: true }), { headers: { 'Content-Type': 'application/json' } });
    }
    if (pending.resolved_at) {
      // Already confirmed by djomi-checkout's poll (or djomi-sweep) —
      // this is the expected common case if the webhook ever does fire,
      // not an error.
      return new Response(JSON.stringify({ received: true }), { headers: { 'Content-Type': 'application/json' } });
    }

    // Never trust the webhook's own status field to ACTIVATE — re-verify the
    // transaction directly against Djomi first (same GET /v1/payments/{id}
    // lookup djomi-checkout's poll uses), using the transaction_id from OUR
    // pending row, never one parsed out of the webhook body. Matches the trust
    // boundary documented at the top of this file and in migration_v140.sql.
    const verified = await verifyDjomiTransaction(pending.transaction_id ?? transactionId, CLIENT_ID, CLIENT_SECRET);
    if (verified !== 'success') {
      console.log(`djomi-webhook: ${reference} not confirmed by Djomi (status=${verified}) — not activating`);
      return new Response(JSON.stringify({ received: true }), { headers: { 'Content-Type': 'application/json' } });
    }

    await confirmDjomiPayment(supabase, pending, pending.transaction_id ?? transactionId);

    return new Response(JSON.stringify({ received: true }), { headers: { 'Content-Type': 'application/json' } });
  } catch (err) {
    console.error('djomi-webhook unhandled error:', err);
    // Still 200: per Djomi's guidance a non-200 is treated as delivery
    // failure and retried — an unhandled error here is our bug to fix
    // from the logs, not something a retry storm will resolve.
    return new Response(JSON.stringify({ received: true, error: String(err) }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    });
  }
});
