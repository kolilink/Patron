import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// RevenueCat webhooks authenticate via a static Authorization header
// (configured in the RevenueCat dashboard's webhook settings), not a
// per-request signature like Stripe's — see supabase/functions/
// stripe-webhook/index.ts for the signature-based sibling of this function.
const webhookAuthHeader = Deno.env.get('REVENUECAT_WEBHOOK_AUTH_HEADER')!;

// 30-day referral bonus granted to both businesses the first time a
// referred business converts to a real paid subscription. Deliberately
// separate from subscription_expires_at (see migration_v130.sql) — that
// field is fully owned by this webhook's own renewal events and would
// silently clobber the bonus on the next RENEWAL.
const REFERRAL_BONUS_DAYS = 30;

type RevenueCatStore = 'APP_STORE' | 'MAC_APP_STORE' | 'PLAY_STORE' | 'STRIPE' | 'PROMOTIONAL' | 'AMAZON' | 'ROKU';

function mapProvider(store: RevenueCatStore | undefined): 'apple' | 'google' | 'stripe' | 'promotional' | null {
  switch (store) {
    case 'APP_STORE':
    case 'MAC_APP_STORE':
      return 'apple';
    case 'PLAY_STORE':
      return 'google';
    case 'STRIPE':
      return 'stripe';
    case 'PROMOTIONAL':
      return 'promotional';
    default:
      return null;
  }
}

function addDays(base: Date, days: number): string {
  const d = new Date(base);
  d.setDate(d.getDate() + days);
  return d.toISOString();
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: { 'Access-Control-Allow-Origin': '*' } });
  }

  const auth = req.headers.get('Authorization');
  if (!webhookAuthHeader || auth !== `Bearer ${webhookAuthHeader}`) {
    return new Response('Unauthorized', { status: 401 });
  }

  try {
    const body = await req.json();
    const event = body.event;
    if (!event) {
      return new Response('Missing event', { status: 400 });
    }

    // By convention Purchases.logIn(business.id) is called from stores/auth.ts
    // right after a business is created/restored, so RevenueCat's app_user_id
    // equals businesses.id — same identity pattern stripe-webhook already uses
    // via client_reference_id. No separate mapping table needed.
    const businessId: string | undefined = event.app_user_id;
    if (!businessId) {
      console.warn(`${event.type} missing app_user_id — skipping`);
      return new Response(JSON.stringify({ received: true }), { headers: { 'Content-Type': 'application/json' } });
    }

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    switch (event.type) {
      case 'INITIAL_PURCHASE':
      case 'RENEWAL':
      case 'UNCANCELLATION':
      case 'PRODUCT_CHANGE': {
        const provider = mapProvider(event.store);
        const expiresAt = event.expiration_at_ms ? new Date(event.expiration_at_ms).toISOString() : null;

        // Referral crediting only applies to a business's genuine first-ever
        // activation. Guarded by reading payment_provider BEFORE this update:
        // if it's already set, this business has activated before (a renewal,
        // a resubscribe, a plan change) and must never be credited again.
        if (event.type === 'INITIAL_PURCHASE') {
          const { data: current } = await supabase
            .from('businesses')
            .select('payment_provider, referred_by_business_id')
            .eq('id', businessId)
            .single();

          if (current && current.payment_provider === null && current.referred_by_business_id) {
            const referrerId = current.referred_by_business_id;
            const now = new Date();

            const { data: referrer } = await supabase
              .from('businesses')
              .select('bonus_access_until')
              .eq('id', referrerId)
              .single();

            const referrerBase = referrer?.bonus_access_until && new Date(referrer.bonus_access_until) > now
              ? new Date(referrer.bonus_access_until)
              : now;

            await supabase.from('businesses').update({
              bonus_access_until: addDays(referrerBase, REFERRAL_BONUS_DAYS),
              updated_at: now.toISOString(),
            }).eq('id', referrerId);

            await supabase.from('businesses').update({
              bonus_access_until: addDays(now, REFERRAL_BONUS_DAYS),
            }).eq('id', businessId);

            console.log(`Referral bonus granted: ${referrerId} <-> ${businessId}`);
          }
        }

        const { error } = await supabase
          .from('businesses')
          .update({
            subscription_status: 'active',
            subscription_expires_at: expiresAt,
            payment_provider: provider,
            revenuecat_customer_id: event.original_app_user_id ?? businessId,
            updated_at: new Date().toISOString(),
          })
          .eq('id', businessId);

        if (error) console.error(`Error activating subscription for ${businessId}:`, error);
        else console.log(`${event.type}: activated subscription for business ${businessId}`);
        break;
      }

      case 'EXPIRATION': {
        const { error } = await supabase
          .from('businesses')
          .update({
            subscription_status: 'expired',
            updated_at: new Date().toISOString(),
          })
          .eq('id', businessId);

        if (error) console.error(`Error expiring subscription for ${businessId}:`, error);
        else console.log(`Subscription expired for business ${businessId}`);
        break;
      }

      // CANCELLATION: the merchant keeps access until the period ends —
      // RevenueCat sends EXPIRATION at that point, so no status change here.
      // BILLING_ISSUE: leave active during Apple/Google's own billing grace
      // period; rely on the eventual EXPIRATION event if it's never resolved.
      default:
        break;
    }

    return new Response(JSON.stringify({ received: true }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    console.error('RevenueCat webhook unhandled error:', err);
    return new Response(`Server error: ${err}`, { status: 500 });
  }
});
