import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { safeErrorResponse } from '../_shared/errors.ts';
import {
  ALPHA_DISCLOSURE,
  ALPHA_WARNING,
  IDK_MESSAGE,
  computeDataHash,
  emptyAnswerFor,
  estimateCost,
  isEnvelopeEmpty,
  routeIntent,
  buildSystemPrompt,
  type SkillIntention,
} from './lib.ts';

// Alpha: the AI business advisor (db/migration_v133.sql + migration_v134.sql
// renamed it from "Mystic"). Called right after send_alpha_message() has
// already recorded the merchant's question and enforced the quota — this
// function only ever generates the reply.
//
// GLASS WALL (migration_v210, Phase 1): Alpha no longer sees a broad snapshot
// and no longer calls tools. A deterministic intent router (routeIntent, a
// fixed keyword table — NEVER the model) maps the merchant's question to ONE
// of exactly 5 read-only skills. Each skill is a SECURITY DEFINER RPC that
// (a) checks is_member first, (b) derives the caller's role server-side, and
// (c) filters every query by business_id AND role — so no multi-business data
// can ever reach the prompt. The prompt receives ONLY the skill's envelope
// plus system instructions. There are ZERO write operations exposed to the
// model (no tools), and the model never selects its data source.
//
// Phase 2: "tu" voice, one idea per message, exact "Je n'ai pas cette
// information." when data is absent. An empty envelope short-circuits to a
// deterministic answer WITHOUT a model call, so a missing figure can never be
// embellished into an invented one.
//
// Phase 4: the first assistant reply is prefixed with the transparency
// disclosure + warning.
//
// Phase 6: every interaction records intention/params/data_hash/cost/token
// counts on the assistant row and writes one alpha_audit_trail row (service
// role only).

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const GROQ_MODEL = 'openai/gpt-oss-20b';
const OPENAI_MODEL = 'gpt-4o-mini';
const FALLBACK_MESSAGE = "Désolé, je n'ai pas pu répondre — réessaie dans un instant.";
const MAX_REPLY_TOKENS = 1000;
const MAX_CONTINUATIONS = 1;
const CONTINUE_INSTRUCTION =
  "Continue ta réponse précédente exactement où tu t'es arrêtée, sans rien répéter, sans redémarrer la phrase ou le mot en cours.";
// Small rolling window of conversation history resent to the model each turn —
// the skill envelope is now the sole data source, so history only carries
// continuity, not figures.
const HISTORY_TURNS = 6;

// Which RPC backs each intention, and whether the skill is period-bound.
const SKILL_RPC: Record<SkillIntention, string> = {
  ventes_periode: 'alpha_skill_ventes_periode',
  creances: 'alpha_skill_creances',
  stock_bas: 'alpha_skill_stock_bas',
  top_produits: 'alpha_skill_top_produits',
  top_clients: 'alpha_skill_top_clients',
};

interface AlphaMessageRow {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  status: 'ready' | 'failed';
}

// A deterministic answer for an empty/unauthorized envelope. This runs WITHOUT
// a model call, so a missing figure can never be invented (Phase 2). When the
// role is denied (autorise=false), the envelope's own `raison` is appended.
function deterministicAnswer(env: Record<string, unknown>): string {
  if (env.autorise === false) {
    const raison = typeof env.raison === 'string' && env.raison.trim() ? env.raison.trim() : '';
    return raison ? `${IDK_MESSAGE} ${raison}` : IDK_MESSAGE;
  }
  const intention = String(env.intention ?? '');
  return emptyAnswerFor(intention) ?? IDK_MESSAGE;
}

interface ChatTurn {
  role: string;
  content: string | null;
}

// Groq and OpenAI both speak the same OpenAI-compatible chat-completions
// shape. No tools — the model has no write path and no lookup path (Phase 3).
async function callChatCompletions(
  baseUrl: string,
  apiKey: string,
  model: string,
  systemPrompt: string,
  turns: { role: string; content: string }[],
): Promise<{ content: string; promptTokens: number; completionTokens: number }> {
  const messages: ChatTurn[] = [{ role: 'system', content: systemPrompt }, ...turns];

  const postCompletion = () => fetch(baseUrl, {
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
    }),
  });

  const resp = await postCompletion();
  if (!resp.ok) {
    const errText = await resp.text().catch(() => '');
    throw new Error(`${model} error ${resp.status}: ${errText.slice(0, 300)}`);
  }
  const json = await resp.json() as {
    choices?: { message?: { content?: string }; finish_reason?: string }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  const message = json.choices?.[0]?.message;

  let content = message?.content ?? '';
  if (!content.trim()) throw new Error(`${model} returned no content`);
  let finishReason = json.choices?.[0]?.finish_reason;

  for (let cont = 0; finishReason === 'length' && cont < MAX_CONTINUATIONS; cont++) {
    messages.push({ role: 'assistant', content });
    messages.push({ role: 'user', content: CONTINUE_INSTRUCTION });
    const contResp = await postCompletion();
    if (!contResp.ok) break; // return what we already have rather than fail the whole reply
    const contJson = await contResp.json() as {
      choices?: { message?: { content?: string }; finish_reason?: string }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const piece = contJson.choices?.[0]?.message?.content;
    if (!piece) break;
    content += piece;
    finishReason = contJson.choices?.[0]?.finish_reason;
    json.usage = json.usage ?? {};
    json.usage.prompt_tokens = (json.usage.prompt_tokens ?? 0) + (contJson.usage?.prompt_tokens ?? 0);
    json.usage.completion_tokens = (json.usage.completion_tokens ?? 0) + (contJson.usage?.completion_tokens ?? 0);
  }

  return {
    content: content.trim(),
    promptTokens: json.usage?.prompt_tokens ?? 0,
    completionTokens: json.usage?.completion_tokens ?? 0,
  };
}

// Groq first; OpenAI is an automatic fallback the instant Groq fails for any
// reason (daily token ceiling, rate limit, outage).
async function generateReply(
  systemPrompt: string,
  turns: { role: string; content: string }[],
): Promise<{ content: string; model: string; promptTokens: number; completionTokens: number }> {
  const groqKey = Deno.env.get('GROQ_API_KEY');
  if (groqKey) {
    try {
      const r = await callChatCompletions(
        'https://api.groq.com/openai/v1/chat/completions', groqKey, GROQ_MODEL, systemPrompt, turns,
      );
      return { content: r.content, model: GROQ_MODEL, promptTokens: r.promptTokens, completionTokens: r.completionTokens };
    } catch (groqErr) {
      console.warn('alpha-chat: Groq failed, falling back to OpenAI:', groqErr instanceof Error ? groqErr.message : groqErr);
    }
  }

  const openaiKey = Deno.env.get('OPENAI_API_KEY');
  if (!openaiKey) {
    throw new Error(groqKey ? 'Groq failed and OPENAI_API_KEY not configured' : 'Neither GROQ_API_KEY nor OPENAI_API_KEY configured');
  }
  const r = await callChatCompletions(
    'https://api.openai.com/v1/chat/completions', openaiKey, OPENAI_MODEL, systemPrompt, turns,
  );
  return { content: r.content, model: OPENAI_MODEL, promptTokens: r.promptTokens, completionTokens: r.completionTokens };
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

    // User-JWT-scoped client — required for the skill RPCs, which derive
    // role/user_id from auth.uid() internally (migration_v210 security fix).
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
      const currency = business?.currency ?? 'GNF';

      const { data: messages } = await supabase
        .from('alpha_messages')
        .select('id, role, content, status')
        .eq('conversation_id', conversationId)
        .neq('status', 'failed')
        .order('created_at', { ascending: false })
        .limit(HISTORY_TURNS);

      const rows = ((messages ?? []) as AlphaMessageRow[]).reverse();
      const turns = rows.map(m => ({ role: m.role, content: m.content }));

      // The merchant's question is the most recent user message (inserted by
      // send_alpha_message before this function runs).
      const questionRow = [...rows].reverse().find(r => r.role === 'user');
      const question = questionRow?.content ?? '';

      // Whether this is the very first assistant reply in the conversation
      // (drives the Phase 4 first-contact disclosure prefix).
      const { count: assistantCount } = await supabase
        .from('alpha_messages')
        .select('id', { count: 'exact', head: true })
        .eq('conversation_id', conversationId)
        .eq('role', 'assistant');

      // ── Deterministic router (glass wall) ──
      const routed = routeIntent(question);
      const intention = routed.intention;
      // creances and stock_bas are current-state, not period-bound.
      const periodBound = intention === 'ventes_periode' || intention === 'top_produits' || intention === 'top_clients';
      const params = periodBound ? { debut: routed.debut, fin: routed.fin } : { debut: null, fin: null };

      // One skill RPC, via the CALLER's own JWT-scoped client.
      const rpcArgs: Record<string, unknown> = { p_business_id: businessId };
      if (periodBound) {
        rpcArgs.p_debut = routed.debut;
        rpcArgs.p_fin = routed.fin;
      }
      const { data: rawEnvelope, error: rpcErr } = await userClient.rpc(SKILL_RPC[intention], rpcArgs);
      if (rpcErr) {
        // Security-definer RPCs raise 'Accès refusé' for non-members. The
        // membership check above already guards this, but never leak the
        // exception text to the model.
        throw rpcErr;
      }
      const envelope = (rawEnvelope ?? {}) as Record<string, unknown>;
      const dataHash = computeDataHash(envelope);
      const detailsPath = typeof envelope.chemin_details === 'object' && envelope.chemin_details !== null
        ? JSON.stringify(envelope.chemin_details)
        : null;

      // Phase 4 transparency prefix for the very first assistant reply.
      const isFirstReply = (assistantCount ?? 0) === 0;
      const transparencyPrefix = isFirstReply ? `${ALPHA_DISCLOSURE}\n\n${ALPHA_WARNING}\n\n` : '';

      // Phase 2: empty/unauthorized envelope → deterministic answer, no model.
      let replyContent: string;
      let servedByModel: string | null = null;
      let promptTokens = 0;
      let completionTokens = 0;

      if (isEnvelopeEmpty(envelope)) {
        replyContent = transparencyPrefix + deterministicAnswer(envelope);
      } else {
        const systemPrompt = buildSystemPrompt({
          businessName: business?.name ?? 'Ton commerce',
          businessType: business?.type ?? null,
          currency,
          role,
          envelope,
        });
        const generated = await generateReply(systemPrompt, turns);
        servedByModel = generated.model;
        promptTokens = generated.promptTokens;
        completionTokens = generated.completionTokens;
        replyContent = transparencyPrefix + generated.content;
      }

      const cost = servedByModel ? estimateCost(servedByModel, promptTokens, completionTokens) : 0;

      const { data: inserted, error: insertErr } = await supabase
        .from('alpha_messages')
        .insert({
          conversation_id: conversationId,
          role: 'assistant',
          content: replyContent,
          status: 'ready',
          model: servedByModel,
          intention,
          params,
          details_path: detailsPath,
          data_hash: dataHash,
          cost,
          prompt_tokens: promptTokens,
          completion_tokens: completionTokens,
        })
        .select()
        .single();
      if (insertErr) throw insertErr;

      await supabase.from('alpha_conversations')
        .update({ last_message_at: inserted.created_at, updated_at: new Date().toISOString() })
        .eq('id', conversationId);

      // Phase 6 audit trail — service role only, never merchant-visible.
      await supabase.rpc('write_alpha_audit_trail', {
        p_business_id: businessId,
        p_user_id: user.id,
        p_role: role,
        p_conversation_id: conversationId,
        p_message_id: inserted.id,
        p_question: question,
        p_intention: intention,
        p_params: params,
        p_data_hash: dataHash,
        p_response: replyContent,
        p_model: servedByModel,
        p_prompt_tokens: promptTokens,
        p_completion_tokens: completionTokens,
        p_cost: cost,
      });

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

      return new Response(JSON.stringify({ ok: false, message: failedRow ?? null, error: 'Génération impossible' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
  } catch (e) {
    return safeErrorResponse(e, corsHeaders, 'alpha-chat');
  }
});
