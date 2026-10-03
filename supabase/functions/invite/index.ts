import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { renderOgImage, renderOrFallback } from './lib.ts';

// ============================================================
// invite — the consumer invite smart link (patron.kolilink.com/invite?t=…)
//
// Served through a Supabase Edge Function custom domain so the branded
// URL is clean and dynamic (the repo's patron.kolilink.com is static
// GitHub Pages and cannot do server-side og:title or OS routing).
//
// One URL does everything, chosen by the visitor's User-Agent:
//   * WhatsApp/Telegram/… link crawler  → bare shell with og:tags (Phase 3)
//   * WhatsApp in-app browser           → featherweight bridge (Phase 2)
//   * normal browser                    → featherweight landing page (Phase 4)
//
// og:title is dynamic ("[Nom] t'invite sur Patron", or "Ton ami t'invite
// sur Patron" when the inviter has no personal name) via the
// preview_consumer_invite() RPC (never exposes anything but the display
// name, and only for a live, unexpired invite). og:image is a static
// branded PNG (og.png beside this file) — the name travels in text,
// per the spec's explicit fallback.
//
// Deploy with --no-verify-jwt: hit by anonymous browsers / crawlers.
// ============================================================

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? '';

const APP_STORE_URL = 'https://apps.apple.com/us/app/patron/id6772757310';
const PLAY_STORE_BASE = 'https://play.google.com/store/apps/details?id=com.awall.patron';

// App-link targets (fallbacks once Universal Links / App Links are live).
// Never the primary path — the page always offers the store link too.
const CUSTOM_SCHEME = 'patron://invite';

// og:image is served from this same function; the crawler follows an
// absolute URL, so we advertise the canonical hosted path (with the token so
// each link's image bakes in the inviter's display name).
const OG_IMAGE_PATH = '/og.png';

// Aggressive per-token caching: the card is deterministic for a given token
// (display name is snapshotted at link-generation time), so a generated image
// is cached forever. WhatsApp's own ~30-day preview cache is beaten by token
// uniqueness, not by a cache-buster.
const ogImageCache = new Map<string, Uint8Array>();

// Static branded fallback (og.png beside this file). Never served broken:
// when dynamic generation fails we silently serve this instead (HTTP 200).
let ogPngCache: Uint8Array | null = null;
async function getOgPng(): Promise<Uint8Array | null> {
    if (ogPngCache) return ogPngCache;
    try {
        ogPngCache = await Deno.readFile(new URL('./og.png', import.meta.url));
        return ogPngCache;
    } catch {
        return null;
    }
}

async function getOgImage(token: string, name: string | null, valid: boolean): Promise<Uint8Array | null> {
    // Dynamic image is only meaningful for a live invite (valid=true). For an
    // invalid/unknown token there is no name to bake in — serve the static
    // brand card directly (and cache it per token, as above).
    if (!valid) return getOgPng();

    if (ogImageCache.has(token)) return ogImageCache.get(token)!;
    const png = await renderOrFallback(
        () => renderOgImage(name, true),
        await getOgPng(),
    );
    if (png) ogImageCache.set(token, png);
    return png;
}

function baseUrl(req: Request): string {
    const url = new URL(req.url);
    return `${url.protocol}//${url.host}`;
}

function tokenFrom(req: Request): string {
    const url = new URL(req.url);
    // ?t=… query param (primary) or /invite/<token> path form.
    const q = url.searchParams.get('t')?.trim() ?? '';
    if (q) return q;
    const m = url.pathname.match(/\/([0-9a-fA-F]{32,})$/);
    return m ? m[1] : '';
}

// /invite/<CODE> — the 10-char manual code (unambiguous alphabet, no
// I/L/O/U). Case-insensitive; canonicalised to upper case. Distinct from
// the 32+ hex token path handled by tokenFrom().
function codeFrom(req: Request): string {
    const url = new URL(req.url);
    const q = url.searchParams.get('c')?.trim() ?? '';
    if (q) return q.toUpperCase();
    const m = url.pathname.match(/\/invite\/([0-9A-Za-z]{10})$/);
    return m ? m[1].toUpperCase() : '';
}

function userAgent(req: Request): string {
    return req.headers.get('user-agent') ?? '';
}

function isCrawler(ua: string): boolean {
    return /whatsapp|telegrambot|twitterbot|facebookexternalhit|facebookcatalog|slackbot|linkedinbot|discordbot|pinterest|line\//i.test(ua);
}

function isWhatsAppInAppBrowser(ua: string): boolean {
    // Real in-app browser = a full browser (has Mozilla) that is WhatsApp.
    // The bare crawler ("WhatsApp/2.x") has no Mozilla token.
    return /whatsapp/i.test(ua) && /mozilla/i.test(ua);
}

function isAndroid(ua: string): boolean {
    return /android/i.test(ua);
}

function isIOS(ua: string): boolean {
    return /iphone|ipad|ipod/i.test(ua);
}

function escapeHtml(s: string): string {
    return s
        .replace(/&/g, '&')
        .replace(/</g, '<')
        .replace(/>/g, '>')
        .replace(/"/g, '"')
        .replace(/'/g, ''');
}

// Android Play Install Referrer payload: encode the invite token so it
// survives the install and the app can read it at first launch.
function playStoreUrl(token: string): string {
    const referrer = encodeURIComponent(`patron_invite=${token}`);
    return `${PLAY_STORE_BASE}&referrer=${referrer}`;
}

function htmlResponse(html: string, status = 200): Response {
    return new Response(html, {
        status,
        headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
    });
}

// ─── og:tag builder ─────────────────────────────────────────

async function resolveInviter(
    credential: string,
    isCode: boolean,
): Promise<{ valid: boolean; name: string | null }> {
    if (!credential || !SUPABASE_URL || !SUPABASE_ANON_KEY) return { valid: false, name: null };
    try {
        const client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
        const rpc = isCode
            ? client.rpc('preview_consumer_invite_code', { p_code: credential })
            : client.rpc('preview_consumer_invite', { p_token: credential });
        const { data, error } = await rpc;
        if (error || !data) return { valid: false, name: null };
        return {
            valid: Boolean((data as { valid?: boolean }).valid),
            name: (data as { inviter_name?: string | null }).inviter_name ?? null,
        };
    } catch {
        return { valid: false, name: null };
    }
}

// Display name is resolved at link-generation time (inviter_name snapshot).
// Fallback "Ton ami" when no personal name; DEFAULT_TITLE only for invalid links.
function inviterTitle(valid: boolean, name: string | null): string {
    if (!valid) return DEFAULT_TITLE;
    return `${name && name.trim() ? name.trim() : FALLBACK_NAME} t'invite sur Patron`;
}

function ogTags(opts: { title: string; description: string; imageUrl: string }): string {
    return [
        `<meta property="og:title" content="${escapeHtml(opts.title)}" />`,
        `<meta property="og:description" content="${escapeHtml(opts.description)}" />`,
        `<meta property="og:type" content="website" />`,
        `<meta property="og:image" content="${escapeHtml(opts.imageUrl)}" />`,
        `<meta property="og:image:width" content="1200" />`,
        `<meta property="og:image:height" content="630" />`,
        `<meta name="twitter:card" content="summary_large_image" />`,
    ].join('\n    ');
}

const TAGLINE = 'Tes ventes, tes crédits — même sans internet.';
const DEFAULT_TITLE = "On t'invite sur Patron";
const FALLBACK_NAME = 'Ton ami';

// ─── Page builders ──────────────────────────────────────────

function headBlock(title: string, description: string, imageUrl: string): string {
    return `<head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1" />
    <title>${escapeHtml(title)}</title>
    <meta name="description" content="${escapeHtml(description)}" />
    ${ogTags({ title, description, imageUrl })}
  </head>`;
}

const PURPLE = '#6366F1';
const PURPLE_DARK = '#4F46E5';

function css(): string {
    return `*{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
body{margin:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;
background:${PURPLE};color:#fff;display:flex;min-height:100vh;flex-direction:column;justify-content:center;
align-items:center;text-align:center;padding:24px}
.card{max-width:420px;width:100%}
h1{font-size:26px;line-height:1.25;margin:0 0 12px;font-weight:700}
p{font-size:16px;line-height:1.5;margin:0 0 24px;opacity:.9}
.btn{display:block;width:100%;padding:16px;border-radius:14px;font-size:17px;font-weight:700;
text-decoration:none;cursor:pointer;border:none;margin-bottom:12px}
.btn-primary{background:#fff;color:${PURPLE_DARK}}
.btn-ghost{background:transparent;color:#fff;border:1.5px solid rgba(255,255,255,.55)}
.foot{margin-top:8px;font-size:13px;opacity:.75}
.note{font-size:13px;opacity:.85;margin-top:20px;text-align:left;background:rgba(255,255,255,.12);
border-radius:10px;padding:12px 14px}
.step{margin-bottom:6px}`;
}

function landingPage(opts: { title: string; description: string; imageUrl: string; storeUrl: string; openAppHref: string; token: string; isIOS: boolean; isAndroid: boolean }): string {
    const heading = opts.title;
    return `<!doctype html>
<html lang="fr">
${headBlock(heading, opts.description, opts.imageUrl)}
<style>${css()}</style>
<body>
  <div class="card">
    <h1>${escapeHtml(heading)}</h1>
    <p>Ton carnet, dans ta poche.<br/>${escapeHtml(TAGLINE)}</p>
    <a class="btn btn-primary" href="${escapeHtml(opts.storeUrl)}">Installer Patron</a>
    <a class="btn btn-ghost" href="${escapeHtml(opts.openAppHref)}">J'ai déjà Patron →</a>
    <div class="foot">Gratuit · Fait pour les commerçants</div>
  </div>
</body>
</html>`;
}

// WhatsApp in-app browser bridge. No page-level JS required beyond the
// Android intent:// auto-escape; the store link itself is the escape hatch.
function bridgePage(opts: { title: string; description: string; imageUrl: string; storeUrl: string; token: string; isAndroid: boolean; isIOS: boolean }): string {
    const intent = `intent://play.google.com/store/apps/details?id=com.awall.patron&referrer=${encodeURIComponent(`patron_invite=${opts.token}`)}#Intent;scheme=https;action=android.intent.action.VIEW;end`;
    const copyJs = opts.isIOS
        ? `function copyLink(){const u='${escapeHtml(opts.storeUrl)}';if(navigator.clipboard){navigator.clipboard.writeText(u).then(function(){document.getElementById('c').textContent='Lien copié ✓';});}}`
        : '';
    const body = opts.isAndroid
        ? `<a class="btn btn-primary" href="${escapeHtml(intent)}">Ouvrir dans Play Store</a>`
        : opts.isIOS
            ? `<button class="btn btn-primary" onclick="copyLink()">Copier le lien</button>
         <a class="btn btn-ghost" href="x-safari:${escapeHtml(opts.storeUrl)}">Ouvrir dans Safari</a>
         <div class="note" id="c">1. Appuie sur « Copier le lien ». 2. Ouvre Safari. 3. Colle et valide.</div>`
            : `<a class="btn btn-primary" href="${escapeHtml(opts.storeUrl)}">Installer Patron</a>`;
    return `<!doctype html>
<html lang="fr">
${headBlock(opts.title, opts.description, opts.imageUrl)}
<style>${css()}</style>
<script>${copyJs}</script>
<body>
  <div class="card">
    <h1>${escapeHtml(opts.title)}</h1>
    <p>${escapeHtml(TAGLINE)}</p>
    ${body}
    <div class="foot">Gratuit · Fait pour les commerçants</div>
  </div>
</body>
</html>`;
}

// Bare shell for link crawlers — they only parse og:tags, nothing else.
function crawlerShell(opts: { title: string; description: string; imageUrl: string }): string {
    return `<!doctype html>
<html lang="fr">
${headBlock(opts.title, opts.description, opts.imageUrl)}
<body></body>
</html>`;
}

// ─── Main handler ───────────────────────────────────────────

serve(async (req: Request) => {
    const url = new URL(req.url);

    // Dynamic og:image asset, keyed by token. The display name (snapshotted
    // onto the invite at link-generation time) is baked into the pixels. On
    // any generation failure — or an invalid/unknown token — the static brand
    // card is served instead (HTTP 200), never a broken image.
    if (url.pathname === OG_IMAGE_PATH || url.pathname === '/invite/og.png') {
        const token = tokenFrom(req);
        const { valid, name } = token ? await resolveInviter(token, false) : { valid: false, name: null };
        const png = await getOgImage(token, name, valid);
        if (!png) return new Response('Not found', { status: 404 });
        return new Response(png, {
            status: 200,
            headers: { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=31536000, immutable' },
        });
    }

    if (req.method !== 'GET') {
        return new Response('Method not allowed', { status: 405 });
    }

    const ua = userAgent(req);
    const token = tokenFrom(req);
    const code = codeFrom(req);
    // Prefer the ?t= token; fall back to the /invite/<CODE> path form.
    const credential = token || code;
    const isCode = !token && !!code;
    const { valid, name } = await resolveInviter(credential, isCode);
    const title = inviterTitle(valid, name);
    const description = TAGLINE;
    // The crawler follows this absolute URL, so include the credential so the
    // fetched image bakes in this inviter's name (same rule as the title).
    const imageUrl = credential
        ? `${baseUrl(req)}${OG_IMAGE_PATH}?t=${encodeURIComponent(credential)}`
        : `${baseUrl(req)}${OG_IMAGE_PATH}`;
    const storeUrl = isAndroid(ua) && credential ? playStoreUrl(credential) : APP_STORE_URL;
    const openAppHref = credential
        ? `${baseUrl(req)}/invite?t=${encodeURIComponent(credential)}`
        : CUSTOM_SCHEME;

    if (isCrawler(ua) && !isWhatsAppInAppBrowser(ua)) {
        return htmlResponse(crawlerShell({ title, description, imageUrl }));
    }

    if (isWhatsAppInAppBrowser(ua)) {
        return htmlResponse(bridgePage({ title, description, imageUrl, storeUrl, token: credential, isAndroid: isAndroid(ua), isIOS: isIOS(ua) }));
    }

    return htmlResponse(landingPage({
        title,
        description,
        imageUrl,
        storeUrl,
        openAppHref,
        token: credential,
        isIOS: isIOS(ua),
        isAndroid: isAndroid(ua),
    }));
});
