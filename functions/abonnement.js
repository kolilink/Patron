// Cloudflare Pages Function — makes https://patron.kolilink.com/abonnement
// transparently proxy the djomi-checkout Supabase Edge Function, so the
// URL shared with merchants stays branded instead of the raw
// https://<project-ref>.supabase.co/functions/v1/djomi-checkout address.
//
// This is a proxy, not a redirect: the browser's address bar never
// changes, because the response body/status/content-type are streamed
// straight through rather than sending a 3xx. No CORS handling is
// needed here — since the page's own client-side JS calls
// fetch(location.pathname, ...) for both the payment-creation POST and
// the ?verify=1&ref=... poll, and location.pathname is now /abonnement
// (same origin as the page itself), those calls never leave
// patron.kolilink.com in the first place.
//
// Plain .js on purpose, not .ts — Cloudflare Pages Functions' global
// types (PagesFunction, etc.) aren't part of this project's TS setup,
// and this directory is excluded from tsc for the same reason
// supabase/functions is (see tsconfig.json).
const DJOMI_CHECKOUT_URL = 'https://jnxpujsyvbenqgjbvifh.supabase.co/functions/v1/djomi-checkout';

export async function onRequest(context) {
  const { request } = context;
  const url = new URL(request.url);
  const target = new URL(DJOMI_CHECKOUT_URL);
  target.search = url.search; // forwards ?verify=1&ref=... on the poll GET

  const init = { method: request.method };
  if (request.method === 'POST') {
    init.headers = { 'Content-Type': request.headers.get('Content-Type') || 'application/json' };
    init.body = await request.text();
  }

  const resp = await fetch(target.toString(), init);
  return new Response(resp.body, {
    status: resp.status,
    headers: { 'Content-Type': resp.headers.get('Content-Type') || 'text/html; charset=utf-8' },
  });
}
