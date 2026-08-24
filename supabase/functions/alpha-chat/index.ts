import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// Alpha: the AI business advisor (db/migration_v133.sql + migration_v134.sql
// renamed it from "Mystic"). Called right after send_alpha_message() has
// already recorded the merchant's question and enforced the quota — this
// function only ever generates the reply.
//
// Grounding: get_reports_snapshot/get_stock_velocity are called with the
// CALLER's own JWT-scoped client, not service-role — both RPCs derive
// role/user_id from auth.uid() internally (migration_v121 security fix), so
// a service-role call would hit the internal-reconciliation code path
// instead of the caller's own role-gated data.
//
// Never-unanswered guarantee: any failure (Groq error, missing key, RPC
// error) still writes an assistant row with a real French fallback message
// (status: 'failed') — never left blank. Unlike generate-support-draft
// (a founder-only draft, invisible until manually regenerated), this is a
// live 1:1 conversation the user is watching, so a silent/blank failure
// would read as a stuck or broken screen.
//
// Provider fallback: Groq is tried first (free/cheap up to its shared daily
// token ceiling — see the "Billing" note above in CLAUDE.md's Alpha section,
// and the interim quota cut in migration_v135.sql). The instant a Groq call
// fails for ANY reason — daily limit hit, rate limit, outage — the same
// request falls through to OpenAI automatically. This was a deliberate
// choice over a manually-timed cutover: there's no reliable way to predict
// in advance when a same-day shared token budget will run out, so the
// failing request itself is the trigger, not a schedule or a dashboard
// watch. Free tier and paid tier both go through this same fallback path —
// nothing routes them to different providers on purpose.
//
// On-demand tool calls (added 2026-07-14): the fixed 3-snapshot data block
// below is still built and sent on every turn (cheap — parallel Postgres
// RPCs, not LLM tokens — and covers the common "how's my shop doing"
// question), but it's necessarily a fixed-shape aggregate. A merchant asking
// about ONE named product, ONE named client, an arbitrary date/period, or an
// itemized expense breakdown was previously answered by the model guessing
// from that aggregate, since nothing in the aggregate could actually answer
// those questions. TOOLS + executeTool give the model real OpenAI/Groq
// function-calling to look those up on demand, mid-reply, via the caller's
// own JWT-scoped client — so the existing RLS policies (vendeur sees only
// their own sales/expenses, admin/manager/investisseur see the full
// business) gate tool results the same way they already gate everything
// else, with no new SECURITY DEFINER RPC and no migration required. The one
// exception is get_product_stats, which (like get_best_sellers below) has no
// role gate of its own — profit/cost figures are withheld from vendeur in
// code, not by RLS. Tool-calling is bounded to MAX_TOOL_ROUNDS to guarantee
// termination and cap worst-case cost; the final round is sent WITHOUT the
// tools param so the model is forced to answer in plain text rather than
// attempt another call. Uses Groq's openai/gpt-oss-20b (switched from
// llama-3.3-70b-versatile 2026-07-16) — an OpenAI open-weight model Groq
// hosts on the same OpenAI-compatible /chat/completions endpoint, so this
// was a same-shape model swap, not a new integration: same base URL, same
// GROQ_API_KEY, same request/response shape. gpt-oss-20b is explicitly
// positioned by Groq for agentic/tool-use workloads, unlike llama-3.3-70b.
// One real difference: gpt-oss-20b is a reasoning model, so Groq's response
// also includes a `message.reasoning` field by default alongside the usual
// `message.content` — harmless here since callChatCompletions only reads
// `content`, but worth knowing if this response is ever logged/inspected
// raw. If the tools param is ever rejected for any reason, the existing
// Groq→OpenAI fallback below still degrades safely (throws and falls
// through to OpenAI), at worse cost, not incorrect behavior.

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const GROQ_MODEL = 'openai/gpt-oss-20b';
const OPENAI_MODEL = 'gpt-4o-mini';
const FALLBACK_MESSAGE = "Désolé, je n'ai pas pu répondre — réessayez dans un instant.";
const PERIOD_DAYS = 30;
// Used as p_period_days for a "since the beginning" totals snapshot — no
// business on this platform is remotely close to 10 years old, so this
// always captures true lifetime totals without needing the business's real
// creation date. Deliberately just three extra numbers (see buildLifetimeBlock),
// not a per-transaction history: that's the difference between "let Alpha see
// the whole business" and "blow the token budget dumping raw rows into every
// message" — see CLAUDE.md's Alpha section for why that tradeoff matters.
const LIFETIME_PERIOD_DAYS = 3650;
// Hard cap on tool-call round trips per reply. Each round is a full
// LLM call (resending the whole message history), so this bounds both
// worst-case latency and worst-case token cost — without it, a model that
// keeps deciding "let me check one more thing" could loop indefinitely.
const MAX_TOOL_ROUNDS = 3;
// Was 400 — too tight for what the system prompt actually requires per
// reply (bolded key figures + trend comparison + a conditional "Action à
// faire" line, in French, which tokenizes worse than English), and nothing
// checked whether the model actually finished. That combination is what
// produced real mid-word cutoffs in production ("...ce qui correspond à
// environ **1000 maill"): the API returns finish_reason: 'length' when a
// reply is cut short, but the code just shipped message.content as-is.
//
// This isn't a cost control (see CLAUDE.md's Alpha "Billing" note — even a
// paid user maxing out their daily quota all month costs ~$0.10-0.15) and
// it isn't meant to shape reply length either — that's the system prompt's
// job ("phrases courtes", one action line, max 3 bold figures). Omitting
// max_tokens entirely isn't "uncapped" — the API just falls back to its own
// default ceiling (effectively the rest of the context window), which is
// far larger and not tuned to this app. The only real reason to set an
// explicit number here is as a backstop against a genuine malfunction (a
// repetition/degeneration loop — rare but real, and this function
// auto-falls-back between two different models/providers, which doubles
// the surface for it): on a synchronous, non-streaming mobile screen over
// the low-bandwidth connections this app targets, a broken generation
// should fail in a few seconds, not run until it fills the context window.
// 1000 is picked to sit comfortably above any legitimate reply.
const MAX_REPLY_TOKENS = 1000;
// If a reply still hits the token cap, ask the model to continue exactly
// once more rather than truncating — bounded to 1 so a pathological reply
// can't multiply latency/cost indefinitely.
const MAX_CONTINUATIONS = 1;
const CONTINUE_INSTRUCTION =
  "Continue ta réponse précédente exactement où tu t'es arrêtée, sans rien répéter, sans redémarrer la phrase ou le mot en cours.";
// ventes_sur_periode is clamped to this many days so a merchant asking for
// "since the beginning" via the date-range tool can't return a payload sized
// like the very per-transaction dump depuis_le_debut was designed to avoid.
const MAX_PERIOD_QUERY_DAYS = 92;

const STATIC_INSTRUCTIONS = `Tu es Alpha, le conseiller IA de Patron, une application de gestion commerciale pour petits commerces. Ce commerce opère en Guinée / Afrique de l'Ouest, en économie très majoritairement au comptant (cash), avec des relations de crédit informel courantes entre le commerçant et ses clients réguliers — n'oublie jamais ce contexte : ne suggère jamais des outils (virements bancaires, cartes de crédit, POS en ligne) qui ne correspondent pas à ce contexte, sauf si le marchand les mentionne lui-même.

Ta mission, dans cet ordre : (1) dire la vérité — ne jamais enjoliver ni inventer un chiffre qui n'est pas dans "Données du commerce" ; (2) faire gagner plus d'argent au commerçant. Une réponse honnête mais inutile n'a pas rempli sa mission. Raisonne à partir des faits bruts de CE commerce (premiers principes), pas de conseils génériques qui "marchent en général" pour un petit commerce — si un chiffre contredit la sagesse habituelle (ex: une dépense jugée normale ailleurs est ici disproportionnée), dis-le. Chaque réponse doit aider à décider quoi faire pour vendre plus, dépenser moins, ou sécuriser la trésorerie — jamais juste "informer".

Règles :
- Vouvoie TOUJOURS le commerçant ("vous", "vos", "votre") — jamais de "tu", même une seule fois. Si des messages précédents de CETTE MÊME conversation (dans l'historique ci-dessous) ont utilisé "tu", c'était une erreur : corrige-la immédiatement et sans le mentionner, ne la reproduis jamais. Le vouvoiement est une marque de respect de base envers quelqu'un qui dirige son propre commerce — reste direct et chaleureux en vouvoyant, comme on le ferait avec un client ou un partenaire qu'on respecte.
- Réponds en français, ton direct, concret, jamais condescendant. Pas de jargon financier occidental.
- Base CHAQUE conseil sur les chiffres fournis dans "Données du commerce" ci-dessous. Cite les chiffres réels (montants, noms) plutôt que des généralités du type "vendez plus" ou "réduisez vos coûts".
- "meilleurs_vendeurs" liste des MEMBRES DE L'ÉQUIPE (des personnes — vendeurs/gérants) classés par chiffre d'affaires généré : ce ne sont jamais des produits, même si le nom ressemble à un nom de produit. "produits_les_plus_vendus" liste de vrais articles du catalogue classés par revenu. Ne confonds jamais les deux catégories.
- Le résultat de l'outil chercher_produit contient SOIT un "prix_vente"/"stock_actuel" uniques (produit simple), SOIT une liste "variantes" (produit à tailles/couleurs, chacune avec son propre prix et son propre stock) — jamais les deux. Quand "variantes" est présent, ne cite JAMAIS un seul prix ou un seul stock comme si c'était celui du produit entier : donne la fourchette de prix (ex: "entre 10 000 et 15 000 GNF selon la couleur"), ou le prix/stock exact d'une variante précise si le commerçant en a nommé une.
- Les listes "produits_stock_bas" et "produits_en_rupture" sont déjà calculées — ne recalcule jamais toi-même des jours de stock restant, ne fais aucune arithmétique sur les données fournies : utilise directement les valeurs telles quelles.
- "evolution_vs_periode_precedente" compare la période actuelle aux 30 jours précédents (déjà calculé — n'invente jamais toi-même un pourcentage). Utilise-la pour dire si les choses vont mieux ou moins bien, pas juste donner un chiffre isolé : un chiffre d'affaires stable en apparence peut être une baisse par rapport au mois dernier, et l'inverse. "evolution_pct: null" veut dire qu'il n'y avait rien à comparer sur la période précédente (pas un chiffre à zéro) — dis-le en mots ("c'est nouveau par rapport au mois dernier"), n'affiche jamais "null" ou "None".
- "depuis_le_debut" donne les totaux depuis le tout début de l'activité du commerce (pas seulement les 30 derniers jours) — utilise-le quand la question porte sur la performance globale ou l'historique complet ("comment va mon commerce depuis le début ?", "combien j'ai gagné au total ?"), pas seulement sur le mois en cours.
- Si "credit_en_cours" est élevé par rapport au chiffre d'affaires, mentionne-le comme risque de trésorerie, mais ne prétends JAMAIS savoir quel client précis est en retard, SAUF si tu as utilisé l'outil chercher_client pour ce client précis.
- Tu as accès à 4 outils pour vérifier des faits précis avant de répondre : chercher_produit (un produit nommé), chercher_client (un client nommé), ventes_sur_periode (une date ou période précise, différente du mois en cours), depenses_detail (le détail des dépenses au lieu du seul total). Utilise l'outil correspondant DÈS QUE le commerçant nomme un produit, un client, ou une date/période précise — ne réponds jamais "je ne sais pas" ou par une généralité si un outil peut vérifier le fait réel. N'utilise ces outils que quand la question le justifie ; pour une question générale ("comment va mon commerce"), les données déjà fournies ci-dessous suffisent.
- Quand le commerçant parle d'une période relative ("aujourd'hui", "hier", "cette semaine", "les 7 derniers jours", "ce mois-ci", "le mois dernier", etc.), tu connais déjà les dates exactes correspondantes : elles sont dans "Repères de dates" ci-dessous. Convertis toi-même la période en dates AAAA-MM-JJ à partir de ces repères et appelle DIRECTEMENT l'outil ventes_sur_periode. Ne demande JAMAIS au commerçant de te fournir une date ou une plage de dates au format AAAA-MM-JJ — un commerçant ne raisonne pas en plages de dates, et lui renvoyer la question est un échec. Ne demande une précision QUE si la période est réellement ambiguë (ex: "compare deux mois" sans dire lesquels), et dans ce cas propose des choix en langage courant (ex: "cette semaine, ce mois-ci, ou le mois dernier ?"), jamais des dates ISO.
- Ne cite JAMAIS un chiffre (montant, quantité, date) qui n'apparaît ni dans "Données du commerce" ci-dessous, ni dans le résultat d'un outil que tu as toi-même appelé dans cette réponse. Si tu n'as pas la donnée exacte, dis-le clairement plutôt que d'estimer ou d'arrondir un chiffre qui semble plausible.
- Si le message du commerçant est trop court ou vague pour être une vraie question (une seule lettre, un mot isolé, un salut sans question, "autre chose", "je ne sais pas", etc.), ta réponse ENTIÈRE doit être UNIQUEMENT une question de clarification courte et amicale, avec 1-2 exemples génériques de sujets (ventes, stock, dépenses, trésorerie, crédit). N'écris RIEN d'autre : pas de chiffre, pas de montant, pas de nom de produit ou de vendeur, et surtout pas le texte "Action à faire" sous aucune forme (ni rempli, ni vide, ni suivi d'un "?") — cette ligne n'existe que dans les réponses de la règle suivante. Cite des données réelles seulement une fois que le commerçant a posé une vraie question sur un sujet précis.
- Si une question sort du cadre du commerce (ventes, stock, dépenses, crédit, trésorerie), redirige poliment vers ce périmètre.
- Pas de tableaux markdown — des phrases courtes ou une courte liste à puces simples, adaptées à une lecture rapide sur mobile. Mets en **gras** (markdown, avec des doubles astérisques) les 1 à 3 chiffres les plus importants de ta réponse (montants clés, quantités critiques) pour qu'ils sautent aux yeux sur un petit écran — n'en mets pas plus, sinon plus rien ne ressort.
- Quand ta réponse donne un vrai conseil (donc PAS une question de clarification), termine-la par exactement une ligne "Action à faire cette semaine : " suivie d'une action concrète, complète et priorisée — jamais suivie d'un "?", jamais vide, jamais un placeholder. Si tu n'as pas d'action claire et spécifique à proposer, n'écris tout simplement pas cette ligne plutôt que de la laisser incomplète.`;

interface AlphaMessageRow {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  status: 'ready' | 'failed';
}

function roleLabel(role: string): string {
  if (role === 'administrateur' || role === 'manager') return 'un administrateur/gérant, avec accès aux chiffres complets du commerce';
  if (role === 'vendeur') return "un vendeur, qui n'a accès qu'à ses propres ventes — pas au chiffre d'affaires total du commerce";
  if (role === 'investisseur') return "un investisseur, avec accès aux chiffres financiers complets du commerce (comme un administrateur), en plus de son solde et ses apports personnels";
  return 'un membre du commerce';
}

// Snapshot values are BIGINT cents server-side — convert to display units
// before the model ever sees them (never let it reason about raw cents).
function cents(raw: Record<string, unknown>, key: string): number {
  return Math.round((((raw[key] as number) ?? 0) / 100));
}

// Escapes regex metacharacters in a name before it's dropped into a RegExp
// constructor — names are arbitrary user-entered text (could contain
// parentheses, dots, etc.), not a safe pattern source by default.
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Case-insensitive whole-string substitution for every (from, to) pair in
// mapping. Used both directions: real name → pseudonym before anything is
// sent to Groq/OpenAI, and pseudonym → real name on the reply before it's
// stored/shown. No \b word-boundary anchoring — JS's \b is ASCII-only and
// would misbehave around accented French names (é, à, ...), so a plain
// global replace is the more reliable choice here even though it can't rule
// out a name colliding with an unrelated substring.
function replaceNames(text: string, mapping: Map<string, string>): string {
  let result = text;
  for (const [from, to] of mapping) {
    if (!from) continue;
    result = result.replace(new RegExp(escapeRegExp(from), 'gi'), to);
  }
  return result;
}

// Precomputed so Alpha never has to do its own arithmetic on two raw
// numbers (same reasoning as "produits_stock_bas" being precomputed rather
// than left for the model to derive) — a wrong mental-math percentage would
// undercut the whole point of grounding every claim in real figures.
// previous === 0 has no meaningful percentage (division by zero) but is
// still clearly a "hausse" if current > 0, so it's reported qualitatively
// without a bogus pct.
function computeVariation(current: number, previous: number): { evolution_pct: number | null; tendance: 'hausse' | 'baisse' | 'stable' } {
  if (previous === 0) {
    return current === 0
      ? { evolution_pct: 0, tendance: 'stable' }
      : { evolution_pct: null, tendance: 'hausse' };
  }
  const pct = Math.round(((current - previous) / Math.abs(previous)) * 1000) / 10;
  const tendance = pct > 2 ? 'hausse' : pct < -2 ? 'baisse' : 'stable';
  return { evolution_pct: pct, tendance };
}

// Only period-bound flow metrics (revenue, profit, order count — computed
// from sale_orders filtered by v_period_start/p_today in get_reports_snapshot)
// are meaningfully comparable across two calls with a shifted p_today.
// credit_outstanding/cash_on_hand/stock_value are live, all-time balances
// the SQL function computes the same way regardless of p_today — calling
// twice would just return the same current-moment number both times, so
// they're deliberately left out of the trend rather than faked into one.
function buildTrendBlock(current: Record<string, unknown>, previous: Record<string, unknown>, role: string): Record<string, unknown> {
  if (role === 'vendeur') {
    return {
      mon_chiffre_affaires: computeVariation(cents(current, 'my_revenue'), cents(previous, 'my_revenue')),
      mes_ventes: computeVariation((current['my_sales_count'] as number) ?? 0, (previous['my_sales_count'] as number) ?? 0),
    };
  }
  return {
    chiffre_affaires: computeVariation(cents(current, 'revenue'), cents(previous, 'revenue')),
    profit_net: computeVariation(cents(current, 'net_profit'), cents(previous, 'net_profit')),
    nombre_ventes: computeVariation((current['period_order_count'] as number) ?? 0, (previous['period_order_count'] as number) ?? 0),
  };
}

// "Depuis le début" — lifetime totals from the LIFETIME_PERIOD_DAYS-wide
// snapshot, so Alpha can answer "how's my business doing overall" as well as
// "how's this month going," without ever seeing a per-transaction history.
function buildLifetimeBlock(lifetime: Record<string, unknown>, role: string): Record<string, unknown> {
  if (role === 'vendeur') {
    return {
      mon_chiffre_affaires_total: cents(lifetime, 'my_revenue'),
      mes_ventes_total: (lifetime['my_sales_count'] as number) ?? 0,
    };
  }
  return {
    chiffre_affaires_total: cents(lifetime, 'revenue'),
    profit_net_total: cents(lifetime, 'net_profit'),
    nombre_ventes_total: (lifetime['period_order_count'] as number) ?? 0,
  };
}

function buildDataBlock(
  snapshot: Record<string, unknown>,
  previousSnapshot: Record<string, unknown>,
  lifetimeSnapshot: Record<string, unknown>,
  role: string,
  stockVelocity: { item_name: string; days_remaining: number | null }[],
  bestSellingProducts: { product_name: string; total_qty: number; total_revenue: number }[],
): { data: Record<string, unknown>; nameToLabel: Map<string, string> } {
  // get_reports_snapshot's "top_sellers" is a STAFF revenue leaderboard (who
  // sold the most), not products — same data used as "meilleurs vendeurs" in
  // the Rapports screen. Mislabeling it "meilleurs_produits" here previously
  // made Alpha describe a salesperson by name as if they were a product (see
  // CLAUDE.md Alpha section). Real top-selling products come from
  // get_best_sellers below instead.
  //
  // Staff names are real people's names, and this data (name + individual
  // revenue) is otherwise the only personally-identifying content Alpha
  // sends anywhere — pseudonymize before it ever leaves this function.
  // nameToLabel is returned so the caller can (a) apply the same
  // substitution to resent conversation history, which is stored with real
  // names for the merchant's own chat view, and (b) reverse it on the
  // model's reply before that reply is persisted/shown.
  const SELLER_LABELS = ['A', 'B', 'C', 'D', 'E'];
  const nameToLabel = new Map<string, string>();
  const topSellers = ((snapshot['top_sellers'] as Array<{ name: string; revenue: number; count: number }>) ?? [])
    .slice(0, 5)
    .map((s, i) => {
      const label = `Vendeur ${SELLER_LABELS[i]}`;
      if (!nameToLabel.has(s.name)) nameToLabel.set(s.name, label);
      return { nom: label, revenu: Math.round(s.revenue / 100), ventes: s.count };
    });

  const meilleursProduits = bestSellingProducts
    .slice(0, 5)
    .map(p => ({ nom: p.product_name, quantite_vendue: Math.round(p.total_qty), revenu: Math.round(p.total_revenue / 100) }));

  const stockBas = stockVelocity
    .filter(v => v.days_remaining !== null && v.days_remaining >= 0 && v.days_remaining < 14)
    .slice(0, 6)
    .map(v => ({ nom: v.item_name, jours_restants: v.days_remaining }));

  const rupture = stockVelocity
    .filter(v => v.days_remaining === -1)
    .slice(0, 6)
    .map(v => v.item_name);

  const data: Record<string, unknown> = {
    chiffre_affaires: cents(snapshot, 'revenue'),
    cout_marchandises: cents(snapshot, 'cogs'),
    marge_brute: cents(snapshot, 'gross_profit'),
    depenses_exploitation: cents(snapshot, 'operating_expenses'),
    profit_net: cents(snapshot, 'net_profit'),
    credit_en_cours: cents(snapshot, 'credit_outstanding'),
    nombre_credits: (snapshot['credit_count'] as number) ?? 0,
    tresorerie_disponible: cents(snapshot, 'cash_on_hand'),
    valeur_stock: cents(snapshot, 'stock_value'),
    nombre_ventes_periode: (snapshot['period_order_count'] as number) ?? 0,
    meilleurs_vendeurs: topSellers,
    produits_les_plus_vendus: meilleursProduits,
    produits_stock_bas: stockBas,
    produits_en_rupture: rupture,
    evolution_vs_periode_precedente: buildTrendBlock(snapshot, previousSnapshot, role),
    depuis_le_debut: buildLifetimeBlock(lifetimeSnapshot, role),
  };

  if (role === 'vendeur') {
    data['mon_chiffre_affaires'] = cents(snapshot, 'my_revenue');
    data['mes_ventes'] = (snapshot['my_sales_count'] as number) ?? 0;
    data['mon_credit_en_attente'] = cents(snapshot, 'my_credit_pending');
    data['mon_nombre_credits'] = (snapshot['my_credit_count'] as number) ?? 0;
  } else if (role === 'investisseur') {
    data['solde_investisseur'] = cents(snapshot, 'investor_balance');
    data['total_investi'] = cents(snapshot, 'my_total_invested');
    data['apports_periode'] = cents(snapshot, 'my_period_apports');
  }

  return { data, nameToLabel };
}

function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

// The model never knew what "today" was, so it could not turn a relative
// period ("cette semaine", "les 7 derniers jours", "aujourd'hui") into the
// AAAA-MM-JJ range ventes_sur_periode requires — it dead-ended by asking the
// merchant to type an ISO date range (which no shopkeeper thinks in) and
// looped when the plain-language answer still gave it no dates it could use.
// Precompute the common ranges here rather than let the model do date math:
// getting a weekday or a week boundary wrong is the same class of error the
// "ne fais aucune arithmétique sur les données" rule already guards against.
// Guinea is GMT year-round (no DST), so the edge function's UTC clock IS the
// merchant's local date — no timezone conversion needed.
function buildDateContext(): string {
  const now = new Date();
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  let weekday = '';
  try {
    weekday = today.toLocaleDateString('fr-FR', { weekday: 'long', timeZone: 'UTC' });
  } catch { /* label only — non-critical if the locale is unavailable */ }

  const yesterday = new Date(today); yesterday.setUTCDate(today.getUTCDate() - 1);
  const sevenAgo = new Date(today); sevenAgo.setUTCDate(today.getUTCDate() - 6);
  // Monday of the current week (getUTCDay: 0=dim .. 6=sam).
  const monday = new Date(today); monday.setUTCDate(today.getUTCDate() - ((today.getUTCDay() + 6) % 7));
  const firstOfMonth = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1));
  // First and last day of the previous calendar month.
  const prevMonthLast = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 0));
  const prevMonthFirst = new Date(Date.UTC(prevMonthLast.getUTCFullYear(), prevMonthLast.getUTCMonth(), 1));

  return `Repères de dates (le commerçant est en Guinée, fuseau GMT) :
- aujourd'hui : ${isoDay(today)}${weekday ? ` (${weekday})` : ''}
- hier : ${isoDay(yesterday)}
- les 7 derniers jours : ${isoDay(sevenAgo)} au ${isoDay(today)}
- cette semaine (depuis lundi) : ${isoDay(monday)} au ${isoDay(today)}
- ce mois-ci : ${isoDay(firstOfMonth)} au ${isoDay(today)}
- le mois dernier : ${isoDay(prevMonthFirst)} au ${isoDay(prevMonthLast)}`;
}

function buildSystemPrompt(
  businessName: string,
  businessType: string | null,
  currency: string,
  role: string,
  data: Record<string, unknown>,
): string {
  return `${STATIC_INSTRUCTIONS}

Commerce : ${businessName} (${businessType ?? 'petit commerce'}). Devise : ${currency}. Tu t'adresses à ${roleLabel(role)}.

${buildDateContext()}

Données du commerce (déjà converties en ${currency} affichable, PAS en centimes) :
${JSON.stringify(data)}`;
}

// ─────────────────────────────────────────────────────────────────────────
// On-demand tools — see "On-demand tool calls" note at the top of this file.
// ─────────────────────────────────────────────────────────────────────────

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'chercher_produit',
      description:
        "Cherche un produit du catalogue par son nom et retourne son stock actuel et son prix — soit directement, soit (si le produit a des tailles/couleurs) sous forme d'une liste de variantes ayant chacune son propre prix et stock — et (pour un rôle qui y a accès) sa rentabilité réelle depuis le début. À utiliser dès que le commerçant nomme un produit précis.",
      parameters: {
        type: 'object',
        properties: { nom: { type: 'string', description: 'Nom (ou partie du nom) du produit' } },
        required: ['nom'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'chercher_client',
      description:
        "Cherche un client par son nom et retourne son historique d'achats réel (total acheté, nombre de commandes, date de dernière visite). À utiliser dès que le commerçant nomme un client précis.",
      parameters: {
        type: 'object',
        properties: { nom: { type: 'string', description: 'Nom (ou partie du nom) du client' } },
        required: ['nom'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'ventes_sur_periode',
      description:
        "Retourne le chiffre d'affaires et le nombre de commandes réels, jour par jour, sur une période précise (ex: une semaine donnée, un jour précis, comparer deux semaines). À utiliser pour toute question portant sur une date ou une période différente du mois en cours déjà fourni dans les données.",
      parameters: {
        type: 'object',
        properties: {
          date_debut: { type: 'string', description: 'Date de début, format AAAA-MM-JJ' },
          date_fin: { type: 'string', description: 'Date de fin, format AAAA-MM-JJ' },
        },
        required: ['date_debut', 'date_fin'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'depenses_detail',
      description:
        "Retourne la liste détaillée des dépenses réelles (date, catégorie, montant, description), au lieu du seul total déjà fourni. À utiliser quand le commerçant demande le détail ou la raison de ses dépenses.",
      parameters: {
        type: 'object',
        properties: {
          depuis: { type: 'string', description: 'Date de début AAAA-MM-JJ (optionnel, défaut: 30 derniers jours)' },
          categorie: { type: 'string', description: 'Filtrer sur une catégorie de dépense précise (optionnel)' },
        },
      },
    },
  },
] as const;

interface ToolContext {
  userClient: ReturnType<typeof createClient>;
  businessId: string;
  role: string;
}

// Every query below runs through the CALLER's own JWT-scoped client, so the
// same RLS policies that already govern the rest of the app apply here with
// no extra code: a vendeur querying sale_orders/expenses transparently only
// ever gets their own rows back (migration_v19/v20), exactly like the rest
// of Alpha's grounding data. get_product_stats is the one exception — like
// get_best_sellers elsewhere in this file, it has no role gate of its own
// (only is_member), so profit/cost figures are withheld from vendeur here in
// code rather than by RLS.
async function executeTool(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<unknown> {
  const { userClient, businessId, role } = ctx;
  try {
    switch (name) {
      case 'chercher_produit': {
        const nom = String(args.nom ?? '').trim();
        if (!nom) return { erreur: 'Nom de produit manquant' };
        const { data: products } = await userClient
          .from('products')
          .select('id, name, category, sale_price, stock_qty, has_variants')
          .eq('business_id', businessId)
          .eq('archived', false)
          .ilike('name', `%${nom}%`)
          .limit(3);
        if (!products || products.length === 0) return { trouve: false };

        const canSeeProfit = role === 'administrateur' || role === 'manager' || role === 'investisseur';
        const produits = await Promise.all(products.map(async (p) => {
          const base: Record<string, unknown> = { nom: p.name, categorie: p.category };
          // A variant product's own sale_price/stock_qty are not real,
          // sellable numbers: stock_qty is architecturally always 0 for a
          // variant parent (submit_sale/cancel_sale only ever touch
          // product_variants.stock_qty — see migration_v125), and sale_price
          // is just the template value a new variant gets pre-filled with,
          // not something anyone can actually buy at. Real numbers live per
          // variant, so this returns a "variantes" list instead of a single
          // price/stock — the prompt tells Alpha never to state one flat
          // price for a product shaped this way.
          if (p.has_variants) {
            const { data: variants } = await userClient
              .from('product_variants')
              .select('name, sale_price, stock_qty')
              .eq('product_id', p.id)
              .eq('archived', false);
            base.variantes = (variants ?? []).map(v => ({
              nom: v.name,
              prix_vente: Math.round(v.sale_price / 100),
              stock_actuel: v.stock_qty,
            }));
          } else {
            base.prix_vente = Math.round(p.sale_price / 100);
            base.stock_actuel = p.stock_qty;
          }
          if (!canSeeProfit) return base;
          const { data: stats } = await userClient.rpc('get_product_stats', {
            p_product_id: p.id, p_business_id: businessId, p_since: null,
          });
          const s = (stats ?? {}) as Record<string, number>;
          base.revenu_total_depuis_le_debut = Math.round((s.revenue ?? 0) / 100);
          base.profit_total_depuis_le_debut = Math.round((s.profit ?? 0) / 100);
          return base;
        }));
        return { trouve: true, produits };
      }

      case 'chercher_client': {
        const nom = String(args.nom ?? '').trim();
        if (!nom) return { erreur: 'Nom de client manquant' };
        const { data: clients } = await userClient
          .from('clients')
          .select('id, name')
          .eq('business_id', businessId)
          .ilike('name', `%${nom}%`)
          .limit(3);
        if (!clients || clients.length === 0) return { trouve: false };

        const resultats = await Promise.all(clients.map(async (c) => {
          const { data: orders } = await userClient
            .from('sale_orders')
            .select('total_amount, discount_amount, sale_date')
            .eq('business_id', businessId)
            .eq('client_id', c.id)
            .in('status', ['paye', 'credit']);
          const rows = orders ?? [];
          const total = rows.reduce((sum, o) => sum + (o.total_amount - (o.discount_amount ?? 0)), 0);
          const derniereVisite = rows.reduce<string | null>(
            (max, o) => (o.sale_date && (!max || o.sale_date > max) ? o.sale_date : max), null,
          );
          return {
            nom: c.name,
            total_achete: Math.round(total / 100),
            nombre_commandes: rows.length,
            derniere_visite: derniereVisite,
          };
        }));
        return { trouve: true, clients: resultats };
      }

      case 'ventes_sur_periode': {
        let dateDebut = String(args.date_debut ?? '');
        const dateFin = String(args.date_fin ?? '');
        if (!dateDebut || !dateFin) return { erreur: 'date_debut et date_fin sont requis (AAAA-MM-JJ)' };
        const earliestAllowed = new Date(new Date(dateFin).getTime() - MAX_PERIOD_QUERY_DAYS * 86_400_000)
          .toISOString().slice(0, 10);
        let borne = false;
        if (dateDebut < earliestAllowed) { dateDebut = earliestAllowed; borne = true; }

        const { data: rows } = await userClient
          .from('sale_orders')
          .select('sale_date, total_amount, discount_amount')
          .eq('business_id', businessId)
          .in('status', ['paye', 'credit'])
          .gte('sale_date', dateDebut)
          .lte('sale_date', dateFin);

        const byDay = new Map<string, { revenu: number; commandes: number }>();
        for (const o of rows ?? []) {
          const d = o.sale_date as string;
          const cur = byDay.get(d) ?? { revenu: 0, commandes: 0 };
          cur.revenu += (o.total_amount - (o.discount_amount ?? 0));
          cur.commandes += 1;
          byDay.set(d, cur);
        }
        const jours = Array.from(byDay.entries())
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([date, v]) => ({ date, chiffre_affaires: Math.round(v.revenu / 100), commandes: v.commandes }));
        return { jours, periode_limitee_a_92_jours: borne };
      }

      case 'depenses_detail': {
        const depuis = args.depuis
          ? String(args.depuis)
          : new Date(Date.now() - PERIOD_DAYS * 86_400_000).toISOString().slice(0, 10);
        let query = userClient
          .from('expenses')
          .select('date, category, amount, description')
          .eq('business_id', businessId)
          .eq('status', 'approuve')
          .gte('date', depuis)
          .order('date', { ascending: false })
          .limit(30);
        if (args.categorie) query = query.eq('category', String(args.categorie));
        const { data: rows } = await query;
        return {
          depenses: (rows ?? []).map(e => ({
            date: e.date, categorie: e.category, montant: Math.round(e.amount / 100), description: e.description,
          })),
        };
      }

      default:
        return { erreur: `Outil inconnu: ${name}` };
    }
  } catch (err) {
    // A single bad tool call must never sink the whole reply — the model
    // gets a plain error string back and can still answer from the rest of
    // its context, same "never-unanswered" posture as the outer handler.
    return { erreur: err instanceof Error ? err.message : 'Erreur outil inconnue' };
  }
}

interface ChatTurn {
  role: string;
  content: string | null;
  tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
}

// Groq and OpenAI both speak the same OpenAI-compatible chat-completions
// shape (Groq deliberately mirrors it, including tool-calling), so one
// function serves both — only the base URL, key, and model differ.
//
// Tool-calling loop: each round is sent WITH `tools` except the last, which
// is deliberately sent without — forcing the model to answer in plain text
// once MAX_TOOL_ROUNDS is reached instead of looping forever. toolCtx is
// undefined when the caller doesn't want tool-calling at all (kept as an
// escape hatch, unused today, rather than threading a boolean everywhere).
async function callChatCompletions(
  baseUrl: string,
  apiKey: string,
  model: string,
  systemPrompt: string,
  turns: { role: string; content: string }[],
  toolCtx?: ToolContext,
): Promise<string> {
  const messages: ChatTurn[] = [{ role: 'system', content: systemPrompt }, ...turns];

  const postCompletion = (allowTools: boolean) => fetch(baseUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages,
      temperature: 0.6,
      max_tokens: MAX_REPLY_TOKENS,
      ...(allowTools ? { tools: TOOLS, tool_choice: 'auto' } : {}),
    }),
  });

  for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
    const allowTools = Boolean(toolCtx && round < MAX_TOOL_ROUNDS);
    const resp = await postCompletion(allowTools);
    if (!resp.ok) {
      const errText = await resp.text().catch(() => '');
      throw new Error(`${model} error ${resp.status}: ${errText.slice(0, 300)}`);
    }
    const json = await resp.json() as {
      choices?: { message?: { content?: string; tool_calls?: ChatTurn['tool_calls'] }; finish_reason?: string }[];
    };
    const message = json.choices?.[0]?.message;
    const toolCalls = message?.tool_calls;

    if (allowTools && toolCalls && toolCalls.length > 0) {
      messages.push({ role: 'assistant', content: message?.content ?? null, tool_calls: toolCalls });
      // Cap fan-out per round too — a model requesting an unreasonable
      // number of calls in one turn shouldn't multiply the round's cost.
      for (const call of toolCalls.slice(0, 4)) {
        let args: Record<string, unknown> = {};
        try { args = JSON.parse(call.function.arguments || '{}'); } catch { /* treat as no args */ }
        const result = await executeTool(call.function.name, args, toolCtx!);
        messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) });
      }
      continue;
    }

    // Final text answer for this round. If the model hit MAX_REPLY_TOKENS
    // mid-sentence (finish_reason === 'length'), feed back the partial
    // content as an assistant turn and ask it to keep going, up to
    // MAX_CONTINUATIONS times, instead of returning a severed sentence.
    let content = message?.content ?? '';
    if (!content.trim()) throw new Error(`${model} returned no content`);
    let finishReason = json.choices?.[0]?.finish_reason;

    for (let cont = 0; finishReason === 'length' && cont < MAX_CONTINUATIONS; cont++) {
      messages.push({ role: 'assistant', content });
      messages.push({ role: 'user', content: CONTINUE_INSTRUCTION });
      const contResp = await postCompletion(false);
      if (!contResp.ok) break; // return what we already have rather than fail the whole reply
      const contJson = await contResp.json() as {
        choices?: { message?: { content?: string }; finish_reason?: string }[];
      };
      const piece = contJson.choices?.[0]?.message?.content;
      if (!piece) break;
      content += piece;
      finishReason = contJson.choices?.[0]?.finish_reason;
    }

    return content.trim();
  }
  throw new Error(`${model}: exceeded tool-call rounds without a final answer`);
}

// Groq first; OpenAI is an automatic fallback the instant Groq fails for
// any reason (daily token ceiling, rate limit, outage, or a rejected `tools`
// param if Groq's tool-calling support ever changes) — see the "Provider
// fallback" note above. Returns which model actually served the reply so
// the caller can record it instead of hardcoding GROQ_MODEL.
async function generateReply(
  systemPrompt: string,
  turns: { role: string; content: string }[],
  toolCtx: ToolContext,
): Promise<{ content: string; model: string }> {
  const groqKey = Deno.env.get('GROQ_API_KEY');
  if (groqKey) {
    try {
      const content = await callChatCompletions(
        'https://api.groq.com/openai/v1/chat/completions', groqKey, GROQ_MODEL, systemPrompt, turns, toolCtx,
      );
      return { content, model: GROQ_MODEL };
    } catch (groqErr) {
      console.warn('alpha-chat: Groq failed, falling back to OpenAI:', groqErr instanceof Error ? groqErr.message : groqErr);
    }
  }

  const openaiKey = Deno.env.get('OPENAI_API_KEY');
  if (!openaiKey) {
    throw new Error(groqKey ? 'Groq failed and OPENAI_API_KEY not configured' : 'Neither GROQ_API_KEY nor OPENAI_API_KEY configured');
  }
  const content = await callChatCompletions(
    'https://api.openai.com/v1/chat/completions', openaiKey, OPENAI_MODEL, systemPrompt, turns, toolCtx,
  );
  return { content, model: OPENAI_MODEL };
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const authHeader = req.headers.get('Authorization');
    if (!authHeader?.startsWith('Bearer ')) {
      return new Response(JSON.stringify({ error: 'Non authentifié' }), {
        status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const { conversation_id: conversationId, business_id: businessId } = await req.json() as {
      conversation_id?: string;
      business_id?: string;
    };
    if (!conversationId || !businessId) {
      return new Response(JSON.stringify({ error: 'conversation_id ou business_id manquant' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // User-JWT-scoped client — required for get_reports_snapshot/
    // get_stock_velocity, which derive role/user_id from auth.uid()
    // internally. A service-role client here would silently hit those
    // RPCs' internal-reconciliation path instead.
    const userClient = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_ANON_KEY')!,
      { global: { headers: { Authorization: authHeader } } },
    );
    const { data: { user }, error: userErr } = await userClient.auth.getUser();
    if (userErr || !user) {
      return new Response(JSON.stringify({ error: 'Session invalide' }), {
        status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    const [{ data: conv }, { data: membership }] = await Promise.all([
      supabase.from('alpha_conversations').select('id, business_id, user_id').eq('id', conversationId).maybeSingle(),
      supabase.from('memberships').select('role').eq('business_id', businessId).eq('user_id', user.id).maybeSingle(),
    ]);

    if (!conv || conv.business_id !== businessId || conv.user_id !== user.id || !membership) {
      return new Response(JSON.stringify({ error: 'Accès refusé' }), {
        status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
    const role = membership.role as string;

    // From here on, never let a failure propagate as a thrown error to the
    // caller — the user is watching this conversation live. Persist a
    // 'failed' assistant row with a real message instead of a blank/stuck UI.
    try {
      const { data: business } = await supabase
        .from('businesses')
        .select('name, type, currency')
        .eq('id', businessId)
        .maybeSingle();

      // Fetch the most recent messages (DESC + limit), then reverse back to
      // chronological order. Fetching ascending+limit here would return the
      // OLDEST N messages instead — once a conversation passes the limit,
      // that permanently excludes every newer message, including the
      // question this very call is answering (already inserted by
      // send_alpha_message() before this function runs), so Alpha would
      // silently stop reading the user's actual question forever. Limit
      // trimmed from 20 to 10 (5 exchanges) — plenty of continuity for a
      // business Q&A thread, and meaningfully cheaper per Groq call, since
      // this whole window is resent on every single turn.
      const { data: messages } = await supabase
        .from('alpha_messages')
        .select('id, role, content, status')
        .eq('conversation_id', conversationId)
        .neq('status', 'failed')
        .order('created_at', { ascending: false })
        .limit(10);

      const rows = ((messages ?? []) as AlphaMessageRow[]).reverse();
      const turns = rows.map(m => ({ role: m.role, content: m.content }));

      // get_best_sellers is business-wide (no role gate of its own, unlike
      // get_reports_snapshot's internal auth.uid()-derived branches) — only
      // fetch it for roles that already see full-business figures elsewhere
      // in the snapshot (administrateur/manager/investisseur). A vendeur
      // only ever sees their own sales; fetching it unconditionally would
      // leak every other seller's product revenue to them.
      const periodStart = new Date(Date.now() - PERIOD_DAYS * 86_400_000).toISOString().slice(0, 10);
      // Second get_reports_snapshot call, p_today shifted back by one full
      // period — get_reports_snapshot computes v_period_start := p_today -
      // p_period_days internally, so passing p_today = periodStart here
      // yields exactly the 30 days immediately BEFORE the current window
      // (today-60 .. today-30), which is what buildTrendBlock compares
      // against to say "up/down vs last period" instead of a bare snapshot.
      // Third call, LIFETIME_PERIOD_DAYS wide starting from today (no p_today
      // shift needed) — gives buildLifetimeBlock everything since the
      // business began, as a handful of aggregate numbers rather than a
      // per-transaction dump.
      const [{ data: snapshot }, { data: prevSnapshot }, { data: lifetimeSnapshot }, { data: velocity }, bestSellersResult] = await Promise.all([
        userClient.rpc('get_reports_snapshot', {
          p_business_id: businessId,
          p_period_days: PERIOD_DAYS,
          p_role: role,
          p_user_id: user.id,
        }),
        userClient.rpc('get_reports_snapshot', {
          p_business_id: businessId,
          p_period_days: PERIOD_DAYS,
          p_role: role,
          p_user_id: user.id,
          p_today: periodStart,
        }),
        userClient.rpc('get_reports_snapshot', {
          p_business_id: businessId,
          p_period_days: LIFETIME_PERIOD_DAYS,
          p_role: role,
          p_user_id: user.id,
        }),
        userClient.rpc('get_stock_velocity', { p_business_id: businessId }),
        role === 'vendeur'
          ? Promise.resolve({ data: null })
          : userClient.rpc('get_best_sellers', { p_business_id: businessId, p_month_start: periodStart, p_limit: 5 }),
      ]);

      const { data: dataBlock, nameToLabel } = buildDataBlock(
        (snapshot ?? {}) as Record<string, unknown>,
        (prevSnapshot ?? {}) as Record<string, unknown>,
        (lifetimeSnapshot ?? {}) as Record<string, unknown>,
        role,
        (velocity ?? []) as { item_name: string; days_remaining: number | null }[],
        (bestSellersResult.data ?? []) as { product_name: string; total_qty: number; total_revenue: number }[],
      );

      const systemPrompt = buildSystemPrompt(
        business?.name ?? 'Votre commerce',
        business?.type ?? null,
        business?.currency ?? 'GNF',
        role,
        dataBlock,
      );

      // Resent history (turns) is fetched straight from alpha_messages, which
      // stores real staff names for the merchant's own chat view — anonymize
      // it the same way as the fresh data block before it goes anywhere near
      // Groq/OpenAI. Reverse the mapping on the way back so the merchant only
      // ever sees real names, never "Vendeur A".
      const anonymizedTurns = turns.map(t => ({ ...t, content: replaceNames(t.content, nameToLabel) }));
      const labelToName = new Map(Array.from(nameToLabel, ([name, label]) => [label, name] as [string, string]));

      const toolCtx: ToolContext = { userClient, businessId, role };
      const { content: rawReply, model: servedByModel } = await generateReply(systemPrompt, anonymizedTurns, toolCtx);
      const replyContent = replaceNames(rawReply, labelToName);

      const { data: inserted, error: insertErr } = await supabase
        .from('alpha_messages')
        .insert({
          conversation_id: conversationId,
          role: 'assistant',
          content: replyContent,
          status: 'ready',
          model: servedByModel,
        })
        .select()
        .single();
      if (insertErr) throw insertErr;

      await supabase.from('alpha_conversations')
        .update({ last_message_at: inserted.created_at, updated_at: new Date().toISOString() })
        .eq('id', conversationId);

      return new Response(JSON.stringify({ ok: true, message: inserted }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    } catch (genErr) {
      const msg = genErr instanceof Error ? genErr.message : 'Erreur inconnue';
      console.error('alpha-chat generation failure:', msg);

      const { data: failedRow } = await supabase
        .from('alpha_messages')
        .insert({
          conversation_id: conversationId,
          role: 'assistant',
          content: FALLBACK_MESSAGE,
          status: 'failed',
          error_note: msg.slice(0, 500),
        })
        .select()
        .single();

      return new Response(JSON.stringify({ ok: false, message: failedRow ?? null, error: msg }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Erreur inconnue';
    console.error('alpha-chat crash:', msg);
    return new Response(JSON.stringify({ error: msg }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
