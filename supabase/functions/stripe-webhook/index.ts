import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import Stripe from 'https://esm.sh/stripe@14.21.0?target=deno';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY')!, {
  apiVersion: '2024-04-10',
  httpClient: Stripe.createFetchHttpClient(),
});

const webhookSecret = Deno.env.get('STRIPE_WEBHOOK_SECRET')!;

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', {
      headers: { 'Access-Control-Allow-Origin': '*' },
    });
  }

  try {
    const body = await req.text();
    const sig = req.headers.get('stripe-signature');

    if (!sig) {
      return new Response('Missing stripe-signature header', { status: 400 });
    }

    let event: Stripe.Event;
    try {
      event = await stripe.webhooks.constructEventAsync(body, sig, webhookSecret);
    } catch (err) {
      console.error('Webhook signature verification failed:', err);
      return new Response(`Webhook signature verification failed: ${err}`, { status: 400 });
    }

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object as Stripe.Checkout.Session;
        const businessId = session.client_reference_id;

        if (!businessId) {
          console.warn('checkout.session.completed missing client_reference_id — skipping');
          break;
        }

        const customerId = typeof session.customer === 'string' ? session.customer : session.customer?.id;
        const subscriptionId = typeof session.subscription === 'string' ? session.subscription : session.subscription?.id;

        let expiresAt: string | null = null;
        if (subscriptionId) {
          const subscription = await stripe.subscriptions.retrieve(subscriptionId);
          expiresAt = new Date(subscription.current_period_end * 1000).toISOString();
        }

        const { error } = await supabase
          .from('businesses')
          .update({
            subscription_status: 'active',
            stripe_customer_id: customerId ?? null,
            stripe_subscription_id: subscriptionId ?? null,
            subscription_expires_at: expiresAt,
            updated_at: new Date().toISOString(),
          })
          .eq('id', businessId);

        if (error) console.error('Error activating subscription:', error);
        else console.log(`Activated subscription for business ${businessId}`);
        break;
      }

      case 'customer.subscription.updated': {
        const sub = event.data.object as Stripe.Subscription;
        const customerId = typeof sub.customer === 'string' ? sub.customer : sub.customer.id;
        const expiresAt = new Date(sub.current_period_end * 1000).toISOString();

        let newStatus: string;
        if (sub.status === 'active' || sub.status === 'trialing') {
          newStatus = 'active';
        } else if (sub.status === 'canceled') {
          newStatus = 'cancelled';
        } else {
          newStatus = 'expired';
        }

        const { error } = await supabase
          .from('businesses')
          .update({
            subscription_status: newStatus,
            stripe_subscription_id: sub.id,
            subscription_expires_at: expiresAt,
            updated_at: new Date().toISOString(),
          })
          .eq('stripe_customer_id', customerId);

        if (error) console.error('Error updating subscription:', error);
        break;
      }

      case 'customer.subscription.deleted': {
        const sub = event.data.object as Stripe.Subscription;
        const customerId = typeof sub.customer === 'string' ? sub.customer : sub.customer.id;

        const { error } = await supabase
          .from('businesses')
          .update({
            subscription_status: 'expired',
            updated_at: new Date().toISOString(),
          })
          .eq('stripe_customer_id', customerId);

        if (error) console.error('Error expiring subscription:', error);
        else console.log(`Subscription expired for customer ${customerId}`);
        break;
      }

      default:
        // Ignore unhandled events
        break;
    }

    return new Response(JSON.stringify({ received: true }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    console.error('Stripe webhook unhandled error:', err);
    return new Response(`Server error: ${err}`, { status: 500 });
  }
});
