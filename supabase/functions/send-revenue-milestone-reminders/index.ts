import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// Guinea (Patron's target market) is GMT year-round — no DST — so a plain
// UTC-hour check stands in for "local night" without needing a per-business
// timezone column, which doesn't exist. Same constant/window as every other
// cron-triggered notification function in this project.
const QUIET_HOUR_START = 21; // 9pm
const QUIET_HOUR_END = 7;    // 7am
function isQuietHours(now: Date): boolean {
  const h = now.getUTCHours();
  return h >= QUIET_HOUR_START || h < QUIET_HOUR_END;
}

// Mirrors src/utils/format.ts's formatAmount — duplicated here because this
// function runs in Deno, not the RN bundle. GNF-only call site (the RPC
// itself is GNF-scoped), but kept currency-aware for consistency with the
// same duplicated helper in send-daily-digest. Keep in sync if the display
// format ever changes.
const WHOLE_UNIT_CURRENCIES = new Set(['GNF', 'XOF', 'XAF', 'JPY', 'KRW']);
function formatAmount(n: number, currency: string): string {
  if (WHOLE_UNIT_CURRENCIES.has(currency)) {
    const formatted = Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
    return `${formatted} ${currency}`;
  }
  const [intPart, decPart = '00'] = n.toFixed(2).split('.');
  const formatted = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return `${formatted}.${decPart} ${currency}`;
}

interface RevenueMilestone {
  business_id: string;
  milestone_cents: number;
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  const cronSecret = Deno.env.get('CRON_SECRET');
  const incoming = req.headers.get('x-cron-secret');
  if (!cronSecret || incoming !== cronSecret) {
    return new Response(JSON.stringify({ error: 'Non autorisé' }), {
      status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  try {
    if (isQuietHours(new Date())) {
      return new Response(JSON.stringify({ skipped: 'quiet_hours' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    const { data, error } = await supabase.rpc('get_and_mark_revenue_milestones');
    if (error) throw error;

    const milestones = (data ?? []) as RevenueMilestone[];
    const functionsUrl = `${Deno.env.get('SUPABASE_URL')!}/functions/v1/dispatch-notification`;

    let sent = 0;
    for (const m of milestones) {
      const amount = formatAmount(m.milestone_cents / 100, 'GNF');
      const resp = await fetch(functionsUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-cron-secret': cronSecret,
        },
        body: JSON.stringify({
          business_id: m.business_id,
          event_type: 'revenue_milestone',
          payload: { amount },
          // Only administrateur/manager, same audience as every other
          // activation/retention event — vendeur/investisseur never own
          // the business-wide revenue figure being celebrated.
          target_roles: ['administrateur', 'manager'],
        }),
      });
      if (resp.ok) sent++;
    }

    return new Response(JSON.stringify({ candidates: milestones.length, sent }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Erreur inconnue';
    console.error('send-revenue-milestone-reminders crash:', msg);
    return new Response(JSON.stringify({ error: msg }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
