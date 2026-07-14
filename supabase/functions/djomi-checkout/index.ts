import {
  partnerDomainKey, BASE_URL, djomiAuthToken, verifyDjomiTransaction,
  confirmDjomiPayment, djomiServiceClient, getPendingPayment,
} from '../_shared/djomi.ts';

// ============================================================
// djomi-checkout — the ONLY page in this whole flow, and deliberately
// never linked from inside the Patron app itself. See CLAUDE.md's
// "Djomi out-of-app subscription" entry for why: Apple/Google's rules
// against in-app steering to alternative payment methods only apply
// to what the app does — a merchant reaching this page on their own
// (via a WhatsApp message, a shared link, etc.) and paying here is a
// completely separate, compliant channel.
//
// Payment confirmation is done by POLLING right after the user returns
// from paying (?verify=1&ref=...), not by waiting on djomi-webhook —
// the Djomi account currently in use is shared with a friend's project
// and its single webhook slot already points at his endpoint, so our
// webhook realistically never fires. See djomi-webhook/index.ts, kept
// as a backstop in case that ever changes.
//
// Deploy with --no-verify-jwt: this is hit by an anonymous browser
// with no Supabase session at all.
// ============================================================

const PRICE_GNF = 24000;
const PAID_DAILY_LIMIT = 20; // mirrors src/components/PaywallScreen.tsx

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'content-type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};

// patron.kolilink.com is a static GitHub Pages site (see abonnement/
// index.html at the repo root) that calls this function cross-origin
// with its own branded UI, so the post-payment redirect can land back
// on that branded page instead of this function's raw *.supabase.co
// URL. A fixed allowlist, not "trust whatever origin the client sends"
// — this value only ever ends up as Djomi's returnUrl, and accepting
// an arbitrary client-supplied origin there would be an open-redirect
// hole in a payment flow.
const ALLOWED_RETURN_ORIGINS = ['https://patron.kolilink.com'];

// Same 00224-prefixed international format Djomi requires — see the
// original integration draft this was built from.
function formatPayerNumber(phone: string): string {
  let clean = phone.replace(/\D/g, '');
  if (clean.length === 9) {
    clean = '00224' + clean;
  } else if (clean.length === 12 && clean.startsWith('224')) {
    clean = '00' + clean;
  } else if (!clean.startsWith('00')) {
    clean = '00' + clean;
  }
  return clean;
}

const PAGE_HTML = `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1" />
<title>Abonnement Alpha Pro — Patron</title>
<style>
  :root {
    --bg: #F8FAFC; --surface: #FFFFFF; --border: #E2E8F0;
    --text: #0F172A; --text-secondary: #64748B;
    --primary: #4F46E5; --primary-light: #EEF2FF;
    --warning: #D97706; --warning-light: #FFFBEB;
    --success: #16A34A; --success-light: #F0FDF4;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #0F1117; --surface: #1A1D27; --border: rgba(255,255,255,0.08);
      --text: #F1F5F9; --text-secondary: #94A3B8;
      --primary: #818CF8; --primary-light: rgba(129,140,248,0.14);
      --warning: #FCD34D; --warning-light: rgba(252,211,77,0.14);
      --success: #4ADE80; --success-light: rgba(74,222,128,0.14);
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
    background: var(--bg); color: var(--text); padding: 24px;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  }
  .card {
    width: 100%; max-width: 400px; background: var(--surface); border: 1px solid var(--border);
    border-radius: 20px; padding: 28px 24px; text-align: center;
  }
  .wordmark { font-size: 15px; font-weight: 700; color: var(--text-secondary); margin-bottom: 20px; letter-spacing: 0.5px; }
  .label { font-size: 12px; font-weight: 700; color: var(--text-secondary); letter-spacing: 0.5px; margin-bottom: 8px; }
  .plan { font-size: 20px; font-weight: 700; margin-bottom: 4px; }
  .price { font-size: 28px; font-weight: 800; margin-bottom: 2px; }
  .price span { font-size: 15px; font-weight: 400; color: var(--text-secondary); }
  .limit { font-size: 13px; color: var(--text-secondary); margin-bottom: 24px; }
  input {
    width: 100%; padding: 14px 16px; border-radius: 12px; border: 1px solid var(--border);
    background: var(--bg); color: var(--text); font-size: 16px; margin-bottom: 12px;
  }
  input:focus { outline: none; border-color: var(--primary); }
  button {
    width: 100%; padding: 14px; border-radius: 12px; border: none; background: var(--primary);
    color: #fff; font-size: 16px; font-weight: 700; cursor: pointer;
  }
  button:disabled { opacity: 0.6; }
  .hint { font-size: 12px; color: var(--text-secondary); margin-top: 12px; }
  .msg { font-size: 13px; border-radius: 10px; padding: 10px 12px; margin-top: 12px; }
  .msg.warn { color: var(--warning); background: var(--warning-light); }
  .hidden { display: none !important; }
  .spinner {
    width: 28px; height: 28px; border-radius: 50%; margin: 4px auto 16px;
    border: 3px solid var(--border); border-top-color: var(--primary);
    animation: spin 0.8s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
</style>
</head>
<body>
  <div class="card" id="form-view">
    <div class="wordmark">Patron</div>
    <div class="label">ABONNEMENT</div>
    <div class="plan">Alpha Pro</div>
    <div class="price">${PRICE_GNF.toLocaleString('fr-FR')} GNF<span> / mois</span></div>
    <div class="limit">${PAID_DAILY_LIMIT} conversations avec Alpha, chaque jour</div>
    <input id="phone" type="tel" inputmode="tel" placeholder="Numéro utilisé sur Patron" autocomplete="tel" />
    <button id="pay-btn">Investir</button>
    <div class="hint">Paiement sécurisé via Orange Money (Djomi)</div>
    <div class="msg warn hidden" id="error"></div>
  </div>
  <div class="card hidden" id="wait-view">
    <div class="wordmark">Patron</div>
    <div class="spinner"></div>
    <div class="plan">Confirmation du paiement…</div>
    <div class="limit" id="wait-text">Merci de patienter quelques secondes pendant que nous confirmons votre paiement auprès de Djomi.</div>
  </div>
  <div class="card hidden" id="done-view">
    <div class="wordmark">Patron</div>
    <div class="plan" id="done-title">Merci !</div>
    <div class="limit" id="done-text"></div>
  </div>
<script>
  const params = new URLSearchParams(location.search);
  const ref = params.get('ref');

  function show(id) {
    ['form-view', 'wait-view', 'done-view'].forEach((v) => {
      document.getElementById(v).classList.toggle('hidden', v !== id);
    });
  }

  if (ref) {
    show('wait-view');
    let attempts = 0;
    const maxAttempts = 24; // ~2 minutes at 5s intervals
    const poll = async () => {
      attempts++;
      try {
        const resp = await fetch(location.pathname + '?verify=1&ref=' + encodeURIComponent(ref));
        const data = await resp.json();
        if (data.status === 'success') {
          document.getElementById('done-title').textContent = 'Paiement confirmé';
          document.getElementById('done-text').textContent = "Alpha Pro est maintenant actif. Ouvrez l'application Patron pour en profiter.";
          show('done-view');
          return;
        }
        // 'pending' or 'error' both keep polling — a transient error
        // here shouldn't stop the loop before the timeout below.
      } catch (e) {
        // network hiccup — keep polling
      }
      if (attempts >= maxAttempts) {
        document.getElementById('done-title').textContent = 'Confirmation en cours';
        document.getElementById('done-text').textContent = "Cela prend plus de temps que prévu. Si le paiement a bien été effectué, l'accès sera activé automatiquement dès sa confirmation.";
        show('done-view');
        return;
      }
      setTimeout(poll, 5000);
    };
    poll();
  }

  const btn = document.getElementById('pay-btn');
  const errEl = document.getElementById('error');
  btn.addEventListener('click', async () => {
    const phone = document.getElementById('phone').value.trim();
    errEl.classList.add('hidden');
    if (!phone) {
      errEl.textContent = 'Entrez votre numéro de téléphone.';
      errEl.classList.remove('hidden');
      return;
    }
    btn.disabled = true;
    btn.textContent = 'Un instant…';
    try {
      const resp = await fetch(location.pathname, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone }),
      });
      const data = await resp.json();
      if (!resp.ok || !data.payment_url) {
        throw new Error(data.error || 'Erreur inconnue');
      }
      location.href = data.payment_url;
    } catch (e) {
      errEl.textContent = e.message === 'business_not_found'
        ? "Aucun commerce administrateur trouvé avec ce numéro. Vérifiez que c'est bien le numéro utilisé sur Patron."
        : 'Une erreur est survenue. Réessayez.';
      errEl.classList.remove('hidden');
      btn.disabled = false;
      btn.textContent = 'Investir';
    }
  });
</script>
</body>
</html>`;

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  const url = new URL(req.url);

  // ─── Poll endpoint: ?verify=1&ref=<our own reference> ───────
  // `ref` is client-supplied (round-tripped through Djomi's redirect),
  // but it can only ever name one of OUR OWN previously-created
  // djomi_pending_payments rows — the transaction_id actually checked
  // against Djomi always comes from that row, never from the client.
  // See migration_v140.sql's table comment for the full reasoning.
  if (req.method === 'GET' && url.searchParams.get('verify') === '1') {
    const reference = url.searchParams.get('ref');
    if (!reference) {
      return new Response(JSON.stringify({ status: 'error' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const CLIENT_ID = Deno.env.get('djomi_id');
    const CLIENT_SECRET = Deno.env.get('djomi_key');
    if (!CLIENT_ID || !CLIENT_SECRET) {
      return new Response(JSON.stringify({ status: 'error' }), {
        status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const supabase = djomiServiceClient();
    const pending = await getPendingPayment(supabase, reference);
    if (!pending || !pending.transaction_id) {
      // Row missing entirely, or the payment-creation call's follow-up
      // update (below) hasn't landed yet — both read as "not yet",
      // not an error, so the poll loop just keeps trying.
      return new Response(JSON.stringify({ status: 'pending' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const status = await verifyDjomiTransaction(pending.transaction_id, CLIENT_ID, CLIENT_SECRET);
    if (status === 'success') {
      try {
        await confirmDjomiPayment(supabase, pending, pending.transaction_id);
      } catch {
        return new Response(JSON.stringify({ status: 'error' }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
    }

    return new Response(JSON.stringify({ status }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  if (req.method === 'GET') {
    return new Response(PAGE_HTML, {
      headers: { ...corsHeaders, 'Content-Type': 'text/html; charset=utf-8' },
    });
  }

  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405, headers: corsHeaders });
  }

  try {
    const CLIENT_ID = Deno.env.get('djomi_id');
    const CLIENT_SECRET = Deno.env.get('djomi_key');
    if (!CLIENT_ID || !CLIENT_SECRET) {
      throw new Error('Configuration Djomi incomplète.');
    }

    const { phone, returnOrigin } = await req.json();
    if (!phone) {
      return new Response(JSON.stringify({ error: 'Numéro manquant.' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const supabase = djomiServiceClient();

    // Resolves to the business this phone administers — see
    // resolve_business_for_djomi_checkout in migration_v140.sql.
    // NULL covers both "no match" and "ambiguous match" on purpose,
    // so this page never has to explain which case occurred.
    const { data: businessId, error: rpcError } = await supabase
      .rpc('resolve_business_for_djomi_checkout', { p_phone: phone });

    if (rpcError) {
      console.error('resolve_business_for_djomi_checkout error:', rpcError);
      throw new Error('server_error');
    }
    if (!businessId) {
      return new Response(JSON.stringify({ error: 'business_not_found' }), {
        status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Generated BEFORE we call Djomi, specifically so it can be
    // embedded in returnUrl even though Djomi's own transactionId
    // isn't known until that call's response — see migration_v140.sql.
    const reference = `${businessId}__${Date.now()}`;

    const { error: insertError } = await supabase
      .from('djomi_pending_payments')
      .insert({ reference, business_id: businessId });
    if (insertError) {
      console.error('djomi_pending_payments insert error:', insertError);
      throw new Error('server_error');
    }

    const { accessToken, xApiKey } = await djomiAuthToken(CLIENT_ID, CLIENT_SECRET);
    const returnBase = ALLOWED_RETURN_ORIGINS.includes(returnOrigin)
      ? `${returnOrigin}/abonnement`
      : `${url.origin}${url.pathname}`;
    const returnUrl = `${returnBase}?ref=${encodeURIComponent(reference)}`;

    const paymentResp = await fetch(`${BASE_URL}/v1/payments/gateway`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'X-API-KEY': xApiKey,
        'Content-Type': 'application/json',
        'X-PARTNER-DOMAIN': partnerDomainKey(),
      },
      body: JSON.stringify({
        merchantPaymentReference: reference,
        amount: PRICE_GNF,
        currency: 'GNF',
        countryCode: 'GN',
        description: 'Abonnement Patron — Alpha Pro (1 mois)',
        returnUrl,
        cancelUrl: returnUrl,
        payerNumber: formatPayerNumber(phone),
      }),
    });
    const paymentData = await paymentResp.json();
    console.log('djomi-checkout payment creation response:', JSON.stringify(paymentData));
    if (!paymentResp.ok) {
      console.error('Djomi payment gateway refused:', JSON.stringify(paymentData));
      throw new Error('server_error');
    }

    const redirectLink = paymentData.data?.redirectUrl;
    // Field name guessed defensively (transactionId/id/paymentId) — see
    // the payment creation log line above to confirm the real one and
    // correct this if needed. If none of these match, the row's
    // transaction_id stays NULL and the poll loop above will report
    // 'pending' forever rather than crash — visible in logs, not a
    // silent failure for the merchant mid-payment.
    const transactionId: string | undefined =
      paymentData.data?.transactionId ?? paymentData.data?.id ?? paymentData.data?.paymentId;

    if (!redirectLink) {
      throw new Error('server_error');
    }

    if (transactionId) {
      const { error: updateError } = await supabase
        .from('djomi_pending_payments')
        .update({ transaction_id: transactionId })
        .eq('reference', reference);
      if (updateError) console.error('djomi_pending_payments transaction_id update failed:', updateError);
    } else {
      console.error('djomi-checkout: no transactionId found in payment creation response — see logged response above');
    }

    return new Response(JSON.stringify({ payment_url: redirectLink }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (err: any) {
    console.error('djomi-checkout error:', err);
    return new Response(JSON.stringify({ error: err.message || 'server_error' }), {
      status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
