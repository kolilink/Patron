import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// Generates a founder-only draft reply for a support conversation
// (db/migration_v126.sql). Triggered fire-and-forget right after a merchant
// sends a message (stores/supportChat.ts sendMessage), and on-demand via the
// founder inbox's "Régénérer" action.
//
// Human-in-the-loop guarantee: this function only ever writes to
// support_ai_drafts, which RLS restricts to is_founder() SELECT — there is
// no path from here to a merchant's client. The only way draft text reaches
// a merchant is send_founder_support_reply(), a SECURITY DEFINER RPC
// callable only from a real founder session. See migration_v126.sql.
//
// Uses Groq (free tier, open-weight Llama 3.3 70B) rather than a paid model —
// acceptable here because the founder reviews/edits every draft before
// anything is sent. Request-building is isolated in callGroq() so swapping
// providers later only touches this one function.

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const GROQ_MODEL = 'llama-3.3-70b-versatile';

const SYSTEM_PROMPT = `Tu rédiges un brouillon de réponse pour Sebastiao, le fondateur de Patron (une application de gestion commerciale pour petits commerces). Ce brouillon est relu, corrigé si besoin, puis envoyé par Sebastiao lui-même — il n'est JAMAIS envoyé directement au marchand tel quel.

Règles :
- Réponds en français, sur un ton chaleureux, direct et professionnel.
- Commence par reformuler brièvement ce que le marchand a dit, avec ses propres mots, pour montrer que tu as compris son problème.
- Si le marchand semble frustré, en colère ou stressé, reste calme et empathique — ne reflète jamais son ton, désamorce-le.
- Ne prétends JAMAIS avoir vérifié, corrigé, remboursé ou résolu quoi que ce soit dans son compte : tu n'as accès à aucune donnée réelle de son compte (stock, ventes, paiements). Si une information précise manque pour répondre, pose une question de clarification au lieu d'inventer une réponse ou une action.
- Ne mets ni formatage markdown, ni méta-commentaire, ni guillemets autour du message : uniquement le texte à envoyer tel quel.`;

interface SupportMessageRow {
  id: string;
  sender_role: 'merchant' | 'founder';
  content: string;
}

async function callGroq(apiKey: string, turns: { role: string; content: string }[]): Promise<string> {
  const resp = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: GROQ_MODEL,
      messages: [{ role: 'system', content: SYSTEM_PROMPT }, ...turns],
      temperature: 0.6,
      max_tokens: 400,
    }),
  });
  if (!resp.ok) {
    const errText = await resp.text().catch(() => '');
    throw new Error(`Groq API error ${resp.status}: ${errText.slice(0, 300)}`);
  }
  const json = await resp.json() as { choices?: { message?: { content?: string } }[] };
  const content = json.choices?.[0]?.message?.content?.trim();
  if (!content) throw new Error('Groq returned no content');
  return content;
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

    const { conversation_id: conversationId } = await req.json() as { conversation_id?: string };
    if (!conversationId) {
      return new Response(JSON.stringify({ error: 'conversation_id manquant' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

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

    const { data: conv } = await supabase
      .from('support_conversations')
      .select('id, business_id')
      .eq('id', conversationId)
      .maybeSingle();
    if (!conv) {
      return new Response(JSON.stringify({ error: 'Conversation introuvable' }), {
        status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Authorized as either: a member of this conversation's business (the
    // fire-and-forget call right after a merchant sends a message), or the
    // founder (the manual "Régénérer" action in the inbox).
    const { data: membership } = await supabase
      .from('memberships')
      .select('id')
      .eq('business_id', conv.business_id)
      .eq('user_id', user.id)
      .maybeSingle();

    let isFounder = false;
    if (!membership) {
      const { data: profile } = await supabase
        .from('profiles')
        .select('phone')
        .eq('id', user.id)
        .maybeSingle();
      const digits = (profile?.phone ?? '').replace(/\D/g, '');
      isFounder = digits === '12672421843';
    }

    if (!membership && !isFounder) {
      return new Response(JSON.stringify({ error: 'Accès refusé' }), {
        status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // From here on, never let a failure propagate as a thrown error — this
    // is invoked fire-and-forget right after a merchant's send, and must
    // never affect that send. Persist a 'failed' draft row instead.
    try {
      const { data: messages } = await supabase
        .from('support_messages')
        .select('id, sender_role, content')
        .eq('conversation_id', conversationId)
        .order('created_at', { ascending: true })
        .limit(20);

      const rows = (messages ?? []) as SupportMessageRow[];
      if (rows.length === 0) {
        return new Response(JSON.stringify({ ok: false, error: 'no messages' }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      const turns = rows.map(m => ({
        role: m.sender_role === 'founder' ? 'assistant' : 'user',
        content: m.content,
      }));
      const lastMessage = rows[rows.length - 1];

      const groqKey = Deno.env.get('GROQ_API_KEY');
      if (!groqKey) throw new Error('GROQ_API_KEY not configured');

      const draftContent = await callGroq(groqKey, turns);

      await supabase.from('support_ai_drafts').insert({
        conversation_id: conversationId,
        based_on_message_id: lastMessage.id,
        draft_content: draftContent,
        status: 'ready',
        model: GROQ_MODEL,
      });

      return new Response(JSON.stringify({ ok: true }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    } catch (genErr) {
      const msg = genErr instanceof Error ? genErr.message : 'Erreur inconnue';
      console.error('generate-support-draft generation failure:', msg);
      await supabase.from('support_ai_drafts').insert({
        conversation_id: conversationId,
        status: 'failed',
        error_note: msg.slice(0, 500),
      });
      return new Response(JSON.stringify({ ok: false, error: msg }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Erreur inconnue';
    console.error('generate-support-draft crash:', msg);
    return new Response(JSON.stringify({ error: msg }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
