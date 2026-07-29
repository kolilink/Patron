import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// Dedicated handler for the Supabase Database Webhook on chat_messages INSERT.
// The webhook payload uses { type, table, record, old_record } format (not a client request).
// This function must be registered in the Supabase dashboard as a Database Webhook:
//   Table: chat_messages | Event: INSERT
//   URL: <project-url>/functions/v1/dispatch-chat-notification
//   Authorization header with service_role key
//
// That header is now actually enforced below (it wasn't before — anyone with
// the app's public anon key could POST an arbitrary { room_id, user_id,
// sender_name, content } payload directly and spoof a push to every member
// of that room's business). Same constant-time-compare pattern as
// whatsapp-inbound-webhook's WHATSAPP_WEBHOOK_SECRET check.

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// Constant-time comparison — prevents timing-based brute-force of the service role key.
function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const aBytes = enc.encode(a);
  const bBytes = enc.encode(b);
  const len = Math.max(aBytes.length, bBytes.length);
  let diff = aBytes.length ^ bBytes.length;
  for (let i = 0; i < len; i++) {
    diff |= (aBytes[i] ?? 0) ^ (bBytes[i] ?? 0);
  }
  return diff === 0;
}

interface ChatMessageRecord {
  id: string;
  room_id: string;
  user_id: string;
  sender_name: string;
  content: string;
}

interface ExpoTicket {
  status: 'ok' | 'error';
  details?: { error?: string };
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const authHeader = req.headers.get('Authorization') ?? '';
    const bearerToken = authHeader.replace(/^Bearer /, '');
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
    if (!serviceKey || !timingSafeEqual(bearerToken, serviceKey)) {
      return new Response(JSON.stringify({ error: 'Non autorisé' }), {
        status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const webhook = await req.json() as { type: string; record: ChatMessageRecord };

    // Only handle INSERT events
    if (webhook.type !== 'INSERT') {
      return new Response(JSON.stringify({ skipped: true }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const msg = webhook.record;
    if (!msg?.room_id || !msg?.user_id) {
      return new Response(JSON.stringify({ error: 'Payload invalide' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    // Resolve business_id from the chat room
    const { data: room } = await supabase
      .from('chat_rooms')
      .select('business_id')
      .eq('id', msg.room_id)
      .maybeSingle();

    if (!room?.business_id) {
      // Global Le Marché room has no business_id — skip silently
      return new Response(JSON.stringify({ skipped: 'global_room' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const business_id = room.business_id;

    // Fetch all members of the business except the sender
    const { data: members } = await supabase
      .from('memberships')
      .select('user_id')
      .eq('business_id', business_id)
      .neq('user_id', msg.user_id);

    const userIds = (members ?? []).map((m: { user_id: string }) => m.user_id);
    if (userIds.length === 0) {
      return new Response(JSON.stringify({ sent: 0 }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Fetch device tokens
    const { data: tokenRows } = await supabase
      .from('device_tokens')
      .select('token')
      .in('user_id', userIds);

    const tokens = (tokenRows ?? []).map((r: { token: string }) => r.token);
    if (tokens.length === 0) {
      return new Response(JSON.stringify({ sent: 0 }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const preview = msg.content.slice(0, 60) + (msg.content.length > 60 ? '…' : '');
    const notifBody = `${msg.sender_name} · ${preview}`;

    const CHUNK = 100;
    const staleTokens: string[] = [];

    for (let i = 0; i < tokens.length; i += CHUNK) {
      const chunk = tokens.slice(i, i + CHUNK);
      const messages = chunk.map((to) => ({
        to,
        title: 'Patron',
        body: notifBody,
        data: {
          route: '/(app)/discussions',
          event_type: 'chat_message',
          room_id: msg.room_id,
          sender_name: msg.sender_name,
          preview,
        },
        sound: 'default',
        channelId: 'default',
      }));

      const resp = await fetch(EXPO_PUSH_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(messages),
      });

      if (resp.ok) {
        const result = await resp.json() as { data: ExpoTicket[] };
        result.data?.forEach((ticket, idx) => {
          if (ticket.status === 'error' && ticket.details?.error === 'DeviceNotRegistered') {
            staleTokens.push(chunk[idx]);
          }
        });
      }
    }

    if (staleTokens.length > 0) {
      await supabase.from('device_tokens').delete().in('token', staleTokens);
    }

    return new Response(JSON.stringify({ sent: tokens.length }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Erreur inconnue';
    console.error('dispatch-chat-notification crash:', msg);
    return new Response(JSON.stringify({ error: msg }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
