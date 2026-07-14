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

// Matches src/components/PaywallScreen.tsx's full-screen (non-inline)
// dark layout pixel-for-pixel (colors/spacing/typography pulled from
// src/theme/colors.ts, spacing.ts, typography.ts) — same header panel,
// muted radio plan tile — except the CTA reads "Payer via [Orange
// Money] Orange Money" instead of "Payer via [Apple] Pay", and the
// price is real GNF, not RevenueCat's fallback display price.
// Dark-only, no light variant — see abonnement/index.html (kept in
// sync with this by hand) for the fuller rationale.
const PAGE_HTML = `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1" />
<title>Abonnement Alpha Pro — Patron</title>
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700;800&display=swap" rel="stylesheet" />
<style>
  :root {
    --bg: #0F1117; --surface: #1A1D27; --border: rgba(255,255,255,0.08);
    --text: #F1F5F9; --text-secondary: #94A3B8; --text-inverse: #0F1117;
    --primary: #818CF8;
    --warning: #FCD34D; --warning-light: rgba(252,211,77,0.14);
  }
  * { box-sizing: border-box; }
  html, body { height: 100%; }
  body {
    margin: 0; background: var(--bg); color: var(--text);
    font-family: 'DM Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    display: flex; flex-direction: column; min-height: 100vh;
  }
  .screen { display: flex; flex-direction: column; flex: 1; min-height: 100vh; }
  .hidden { display: none !important; }

  .header-panel {
    position: relative; display: flex; flex-direction: column; align-items: center;
    background: var(--surface); border-bottom: 1px solid var(--border);
    padding: 48px 24px 24px;
  }
  .close-btn {
    position: absolute; top: 12px; left: 16px; background: none; border: none;
    color: var(--text-secondary); font-size: 22px; line-height: 1; padding: 8px; cursor: pointer;
  }
  .icon-badge {
    width: 56px; height: 56px; border-radius: 14px; background: var(--primary); color: var(--text-inverse);
    display: flex; align-items: center; justify-content: center;
    font-size: 26px; font-weight: 800; margin-bottom: 8px;
  }
  .brand-name { font-size: 12px; font-weight: 600; letter-spacing: 1.5px; color: var(--text-secondary); }
  .header-tagline {
    text-align: center; font-size: 15px; font-weight: 700; color: var(--text);
    margin-top: 8px; padding: 0 24px; max-width: 340px;
  }

  .container {
    flex: 1; display: flex; flex-direction: column;
    padding: 32px 24px; max-width: 420px; width: 100%; margin: 0 auto;
  }
  .container.center { justify-content: center; align-items: center; text-align: center; }
  /* form-view only: keeps the form group vertically centered in the space
     above the footer, while pinning the footer to the true bottom of the
     screen instead of leaving a dead gap below it on tall viewports. */
  .container-main { flex: 1; display: flex; flex-direction: column; justify-content: center; }

  .section-label { font-size: 11px; font-weight: 600; letter-spacing: 0.5px; color: var(--text-secondary); margin-bottom: 8px; }
  .plan-tile {
    display: flex; align-items: center; gap: 12px;
    border: 1px solid var(--border); border-radius: 14px; padding: 16px; margin-bottom: 16px;
  }
  .radio-outer {
    width: 20px; height: 20px; border-radius: 10px; border: 2px solid var(--text-secondary);
    display: flex; align-items: center; justify-content: center; flex-shrink: 0;
  }
  .radio-inner { width: 10px; height: 10px; border-radius: 5px; background: var(--text-secondary); }
  .plan-text { flex: 1; }
  .plan-name { font-size: 11px; font-weight: 600; letter-spacing: 0.5px; text-transform: uppercase; color: var(--text-secondary); margin-bottom: 4px; }
  .plan-price { font-size: 20px; font-weight: 600; color: var(--text); margin-bottom: 4px; }
  .plan-price span { font-size: 15px; font-weight: 400; color: var(--text-secondary); }
  .plan-limit { font-size: 12px; color: var(--text-secondary); }

  .phone-input {
    width: 100%; padding: 14px 16px; border-radius: 12px; border: 1px solid var(--border);
    background: var(--surface); color: var(--text); font-size: 16px; margin-bottom: 16px; font-family: inherit;
  }
  .phone-input::placeholder { color: var(--text-secondary); }
  .phone-input:focus { outline: none; border-color: var(--primary); }

  .cta-btn {
    width: 100%; min-height: 56px; padding: 16px 24px; border-radius: 10px; border: none;
    background: var(--primary); color: var(--text-inverse); font-size: 15px; font-weight: 600;
    letter-spacing: 0.1px; cursor: pointer; display: flex; align-items: center; justify-content: center;
    font-family: inherit;
  }
  .cta-btn:disabled { opacity: 0.6; }
  .pay-row { display: flex; align-items: center; gap: 6px; }

  .msg { font-size: 13px; margin-top: 8px; }
  .msg.warn { color: var(--warning); }
  .phone-input-tight { margin-bottom: 6px; }
  .msg.hint { margin: 0 0 16px; }

  .footer-links { display: flex; justify-content: center; padding-top: 24px; }
  .footer-links a { font-size: 11px; color: var(--text-secondary); text-decoration: none; }

  .status-title { font-size: 18px; font-weight: 700; color: var(--text); margin-bottom: 8px; }
  .status-text { font-size: 13px; color: var(--text-secondary); max-width: 320px; }
  .spinner {
    width: 28px; height: 28px; border-radius: 50%; margin: 4px auto 16px;
    border: 3px solid var(--border); border-top-color: var(--primary);
    animation: spin 0.8s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
</style>
</head>
<body>
  <div class="screen" id="form-view">
    <div class="header-panel">
      <button class="close-btn" id="close-btn" aria-label="Fermer">✕</button>
      <div class="icon-badge">A</div>
      <div class="brand-name">ALPHA PRO</div>
      <div class="header-tagline">Obtenez la réponse à votre question</div>
    </div>
    <div class="container">
      <div class="container-main">
        <div class="section-label">ABONNEMENT</div>
        <div class="plan-tile">
          <div class="radio-outer"><div class="radio-inner"></div></div>
          <div class="plan-text">
            <div class="plan-name">ALPHA PRO</div>
            <div class="plan-price">${PRICE_GNF.toLocaleString('fr-FR')} GNF<span> / mois</span></div>
            <div class="plan-limit">${PAID_DAILY_LIMIT} conversations avec Alpha, chaque jour</div>
          </div>
        </div>
        <input id="phone" class="phone-input" type="tel" inputmode="tel" placeholder="Numéro utilisé sur Patron" autocomplete="tel" />
        <input id="orange-phone" class="phone-input phone-input-tight" type="tel" inputmode="tel" placeholder="Numéro Orange Money" autocomplete="tel" />
        <div class="msg warn hint">Entrez le numéro Orange Money lié à votre compte</div>
        <button id="pay-btn" class="cta-btn">
          <span class="pay-row">
            <span>Payer via</span>
            <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true">
              <circle cx="12" cy="12" r="12" fill="#FF7900" />
              <path d="M8 16L11.5 12.5M11.5 12.5H8.7M11.5 12.5V15.3" stroke="#fff" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" fill="none" />
              <path d="M16 8L12.5 11.5M12.5 11.5H15.3M12.5 11.5V8.7" stroke="#fff" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" fill="none" />
            </svg>
            <span>Orange Money</span>
          </span>
        </button>
        <div class="msg warn hidden" id="error"></div>
      </div>
      <div class="footer-links">
        <a href="https://patron.kolilink.com/privacy.html" target="_blank" rel="noopener">Confidentialité</a>
      </div>
    </div>
  </div>

  <div class="screen hidden" id="wait-view">
    <div class="header-panel">
      <div class="icon-badge">A</div>
      <div class="brand-name">ALPHA PRO</div>
    </div>
    <div class="container center">
      <div class="spinner"></div>
      <div class="status-title">Confirmation du paiement…</div>
      <div class="status-text" id="wait-text">Merci de patienter quelques secondes pendant que nous confirmons votre paiement auprès de Djomi.</div>
    </div>
  </div>

  <div class="screen hidden" id="done-view">
    <div class="header-panel">
      <div class="icon-badge">A</div>
      <div class="brand-name">ALPHA PRO</div>
    </div>
    <div class="container center">
      <div class="status-title" id="done-title">Merci !</div>
      <div class="status-text" id="done-text"></div>
    </div>
  </div>
<script>
  const params = new URLSearchParams(location.search);
  const ref = params.get('ref');

  function show(id) {
    ['form-view', 'wait-view', 'done-view'].forEach((v) => {
      document.getElementById(v).classList.toggle('hidden', v !== id);
    });
  }

  document.getElementById('close-btn').addEventListener('click', () => {
    if (history.length > 1) history.back();
  });

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

  // Convenience prefill, not a hard link between the two fields: the
  // common case is the same person paying with their own Orange number,
  // so typing it twice would be pure friction. Only fills while the
  // Orange field is still untouched/empty, so overriding it for "pay
  // with someone else's Orange number" (a family member's, an
  // employee's) always works — see CLAUDE.md for why these are two
  // separate fields at all: the Patron-lookup number and the Djomi
  // payerNumber never had to be the same number, and forcing them to be
  // silently broke that second case entirely.
  const phoneEl = document.getElementById('phone');
  const orangePhoneEl = document.getElementById('orange-phone');
  phoneEl.addEventListener('blur', () => {
    if (!orangePhoneEl.value.trim()) {
      orangePhoneEl.value = phoneEl.value.trim();
    }
  });

  const btn = document.getElementById('pay-btn');
  const errEl = document.getElementById('error');
  btn.addEventListener('click', async () => {
    const phone = phoneEl.value.trim();
    const orangePhone = orangePhoneEl.value.trim();
    errEl.classList.add('hidden');
    if (!phone) {
      errEl.textContent = 'Entrez votre numéro de téléphone.';
      errEl.classList.remove('hidden');
      return;
    }
    if (!orangePhone) {
      errEl.textContent = 'Entrez le numéro Orange Money qui va payer.';
      errEl.classList.remove('hidden');
      return;
    }
    btn.disabled = true;
    try {
      const resp = await fetch(location.pathname, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone, payerPhone: orangePhone }),
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

    // `phone` identifies which Patron business is subscribing (looked up
    // via resolve_business_for_djomi_checkout below); `payerPhone` is the
    // actual Orange Money number Djomi will charge. These are
    // deliberately two separate values, not the same field reused twice
    // — a Patron account's login number doesn't have to be an Orange
    // number at all, and even when it is, the merchant may want to pay
    // with a different Orange line (a family member's, an employee's).
    // Conflating them into one field made that second, common case
    // impossible.
    const { phone, payerPhone, returnOrigin } = await req.json();
    if (!phone || !payerPhone) {
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
        payerNumber: formatPayerNumber(payerPhone),
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
