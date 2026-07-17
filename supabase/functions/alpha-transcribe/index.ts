import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// Voice input for Alpha (db/migration_v133.sql's AI advisor). Audio is
// recorded locally (src/hooks/useVoiceRecorder.ts) and sent here as base64
// to be transcribed; the result fills the composer for the merchant to
// review before sending — it is never auto-sent, since a bad transcription
// would otherwise silently burn a quota slot (send_alpha_message's 5/24h
// free or 100/24h paid cap) with no chance to fix it first.
//
// Known limitation, not fixed by this function: Whisper (Groq's or
// OpenAI's — this isn't vendor-specific) transcribes French well but is
// genuinely weak on Guinea's local languages (Susu, Malinké, Pular). See
// CLAUDE.md's Alpha section — this was previously deferred for exactly that
// reason. `language: 'fr'` is passed as a decoding hint since the app's UI
// and merchant base are French-primary; it does not solve the local-language
// gap, only reduces misclassification into unrelated languages for French
// speech.
//
// Same Groq-first, OpenAI-fallback posture as alpha-chat/index.ts's
// generateReply — the instant Groq fails for any reason, the same audio is
// retried against OpenAI automatically. Deliberately reuses the two API keys
// already configured for Alpha's chat replies; no new secrets needed.

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const GROQ_MODEL = 'whisper-large-v3-turbo';
const OPENAI_MODEL = 'gpt-4o-mini-transcribe';
// Generous for a 60s mono 32kbps voice clip (~250KB) — guards against an
// oversized/malformed payload burning provider cost on a bogus request.
const MAX_AUDIO_BYTES = 10 * 1024 * 1024;

async function transcribeWith(
  url: string, apiKey: string, model: string, bytes: Uint8Array, mimeType: string,
): Promise<string> {
  const form = new FormData();
  form.append('file', new Blob([bytes], { type: mimeType }), 'audio.m4a');
  form.append('model', model);
  form.append('language', 'fr');

  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  });
  if (!res.ok) throw new Error(`${model} transcription failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  const text = (data.text ?? '').trim();
  if (!text) throw new Error(`${model} returned empty transcription`);
  return text;
}

async function transcribe(bytes: Uint8Array, mimeType: string): Promise<string> {
  const groqKey = Deno.env.get('GROQ_API_KEY');
  if (groqKey) {
    try {
      return await transcribeWith(
        'https://api.groq.com/openai/v1/audio/transcriptions', groqKey, GROQ_MODEL, bytes, mimeType,
      );
    } catch (err) {
      console.error('Groq transcription failed, falling back to OpenAI:', err);
    }
  }

  const openaiKey = Deno.env.get('OPENAI_API_KEY');
  if (!openaiKey) {
    throw new Error(groqKey ? 'Groq failed and OPENAI_API_KEY not configured' : 'Neither GROQ_API_KEY nor OPENAI_API_KEY configured');
  }
  return await transcribeWith(
    'https://api.openai.com/v1/audio/transcriptions', openaiKey, OPENAI_MODEL, bytes, mimeType,
  );
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

    // Only needs to confirm the caller is a genuine authenticated app user —
    // transcription touches no business-scoped data (no RPC, no table read),
    // so there's nothing to role-gate; this check exists purely to keep
    // Groq/OpenAI cost off an open/unauthenticated endpoint.
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

    const { audio, mimeType } = await req.json() as { audio?: string; mimeType?: string };
    if (!audio) {
      return new Response(JSON.stringify({ error: 'audio manquant' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const bytes = Uint8Array.from(atob(audio), c => c.charCodeAt(0));
    if (bytes.byteLength > MAX_AUDIO_BYTES) {
      return new Response(JSON.stringify({ error: 'Audio trop volumineux' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const text = await transcribe(bytes, mimeType || 'audio/m4a');

    return new Response(JSON.stringify({ text }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (err) {
    console.error('alpha-transcribe error:', err);
    return new Response(JSON.stringify({ error: 'La transcription a échoué — réessayez.' }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
