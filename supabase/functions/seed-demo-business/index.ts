import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// Scale factors relative to GNF-cent base amounts (all prices stored as value × 100).
// Chosen so that retail prices look natural in each currency group — not exact FX.
const SCALE_FACTORS: Record<string, number> = {
  GNF: 1,
  XOF: 0.1, XAF: 0.1,      // ~600–650 per USD — still high-nominal
  NGN: 0.1,                   // ~1,600 per USD
  KES: 0.01, ETB: 0.01, EGP: 0.01, DZD: 0.01, ZAR: 0.01, INR: 0.01,
  GHS: 0.001, MAD: 0.001, TND: 0.001, AED: 0.001, SAR: 0.001,
  USD: 0.001, EUR: 0.001, GBP: 0.001, CHF: 0.001, CAD: 0.001, CNY: 0.001,
};

// Apply scale factor and floor to 1 cent (100 in storage).
function m(amount: number, factor: number): number {
  return Math.max(100, Math.round(amount * factor));
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) {
      return new Response(JSON.stringify({ error: 'Non autorisé' }), {
        status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Read optional currency from request body (sent by the client after locale detection).
    const body = await req.json().catch(() => ({}));
    const rawCurrency: string = typeof body?.currency === 'string' ? body.currency.toUpperCase() : 'GNF';
    const currency = rawCurrency in SCALE_FACTORS ? rawCurrency : 'GNF';
    const factor = SCALE_FACTORS[currency];

    // User client — to verify the calling user
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
    const userId = user.id;

    // Service client — bypasses RLS for demo data seeding
    const svc = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    // Idempotency: if this user already has a demo business, return it
    const { data: existing } = await svc
      .from('memberships')
      .select('business_id, business:businesses(name)')
      .eq('user_id', userId)
      .eq('role', 'administrateur')
      .single();

    if (existing) {
      return new Response(
        JSON.stringify({ businessId: existing.business_id }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    const businessId = crypto.randomUUID();

    // Use userClient (not service role) for the businesses insert so that the
    // handle_business_created trigger fires with auth.uid() = userId and creates
    // the admin membership correctly. Service role has auth.uid() = NULL which
    // would cause the trigger to fail and roll back the whole insert.
    const { error: bizErr } = await userClient.from('businesses').insert({
      id: businessId,
      name: 'Boutique Démo',
      currency,
      status: 'actif',
      created_by: userId,
    });
    if (bizErr) throw bizErr;
    // Membership row is created by the DB trigger above — no explicit insert needed.

    // ─── Products (base prices in GNF cents ×100, scaled to target currency) ──
    const products: Array<{
      id: string;
      name: string;
      unit: string;
      cost_price: number;
      sale_price: number;
      stock_qty: number;
      reorder_level: number;
    }> = [
      { id: crypto.randomUUID(), name: 'Riz local',        unit: 'kg',    cost_price: m( 450000, factor), sale_price: m( 600000, factor), stock_qty: 80, reorder_level: 20 },
      { id: crypto.randomUUID(), name: "Huile d'arachide", unit: 'L',     cost_price: m(1200000, factor), sale_price: m(1600000, factor), stock_qty: 30, reorder_level: 10 },
      { id: crypto.randomUUID(), name: 'Farine de blé',    unit: 'sac',   cost_price: m(3500000, factor), sale_price: m(4500000, factor), stock_qty: 15, reorder_level:  5 },
      { id: crypto.randomUUID(), name: 'Sucre',            unit: 'kg',    cost_price: m( 700000, factor), sale_price: m( 900000, factor), stock_qty:  5, reorder_level: 10 }, // low-stock
      { id: crypto.randomUUID(), name: 'Pâte tomate',      unit: 'boîte', cost_price: m( 400000, factor), sale_price: m( 600000, factor), stock_qty: 40, reorder_level: 15 },
    ];

    const { error: prodErr } = await svc.from('products').insert(
      products.map(p => ({
        id: p.id,
        business_id: businessId,
        name: p.name,
        unit: p.unit,
        cost_price: p.cost_price,
        sale_price: p.sale_price,
        stock_qty: p.stock_qty,
        reorder_level: p.reorder_level,
        sku: null,
        category: null,
        archived: false,
        supplier_id: null,
        purchase_date: null,
        bulk_price: null,
        bulk_min_qty: null,
        has_variants: false,
        created_by: userId,
      })),
    );
    if (prodErr) throw prodErr;

    // ─── Sales spread over past 30 days ───────────────────────────────────────
    const customers = ['Mariam Sow', 'Ahmed Diallo', 'Fatoumata Bah', 'Ibrahima Camara', 'Kadiatou Barry'];

    type PayMethod = 'especes' | 'orange' | 'mtn' | 'moov';
    const salesSpec: Array<{
      daysAgo: number;
      productIdx: number;
      qty: number;
      customerIdx: number;
      isCredit: boolean;
      payMethod: PayMethod | null;
    }> = [
      // Today — 3 sales so revenue_today > 0
      { daysAgo: 0, productIdx: 0, qty:  5, customerIdx: 0, isCredit: false, payMethod: 'especes' },
      { daysAgo: 0, productIdx: 2, qty:  2, customerIdx: 1, isCredit: false, payMethod: 'orange'  },
      { daysAgo: 0, productIdx: 4, qty:  8, customerIdx: 2, isCredit: false, payMethod: 'especes' },
      // Yesterday
      { daysAgo: 1, productIdx: 1, qty:  3, customerIdx: 3, isCredit: false, payMethod: 'mtn'     },
      { daysAgo: 1, productIdx: 0, qty: 10, customerIdx: 4, isCredit: false, payMethod: 'especes' },
      // 3 days ago — 2 credit sales so "clients qui doivent" card shows
      { daysAgo: 3, productIdx: 3, qty:  4, customerIdx: 0, isCredit: true,  payMethod: null       },
      { daysAgo: 3, productIdx: 2, qty:  1, customerIdx: 1, isCredit: false, payMethod: 'especes' },
      // 7 days ago
      { daysAgo: 7, productIdx: 4, qty: 12, customerIdx: 2, isCredit: false, payMethod: 'especes' },
      { daysAgo: 7, productIdx: 1, qty:  2, customerIdx: 3, isCredit: true,  payMethod: null       },
      // 14 days ago
      { daysAgo: 14, productIdx: 0, qty:  8, customerIdx: 4, isCredit: false, payMethod: 'especes' },
      { daysAgo: 14, productIdx: 3, qty:  6, customerIdx: 0, isCredit: true,  payMethod: null      },
      { daysAgo: 14, productIdx: 2, qty:  3, customerIdx: 1, isCredit: false, payMethod: 'mtn'     },
    ];

    for (const sale of salesSpec) {
      const saleDate = new Date();
      saleDate.setDate(saleDate.getDate() - sale.daysAgo);
      const saleDateStr = saleDate.toISOString().split('T')[0];

      const product = products[sale.productIdx];
      const totalCents = product.sale_price * sale.qty;
      const orderId = crypto.randomUUID();
      const status = sale.isCredit ? 'credit' : 'paye';

      const { error: orderErr } = await svc.from('sale_orders').insert({
        id: orderId,
        business_id: businessId,
        seller_id: userId,
        customer_name: customers[sale.customerIdx],
        status,
        is_credit: sale.isCredit,
        total_amount: totalCents,
        discount_amount: 0,
        sale_date: saleDateStr,
        paid_at: sale.isCredit ? null : saleDate.toISOString(),
        created_at: saleDate.toISOString(),
        updated_at: saleDate.toISOString(),
        created_by: userId,
      });
      if (orderErr) throw orderErr;

      const { error: lineErr } = await svc.from('so_lines').insert({
        id: crypto.randomUUID(),
        order_id: orderId,
        product_id: product.id,
        product_name: product.name,
        qty: sale.qty,
        unit_price: product.sale_price,
        cost_price_at_sale: product.cost_price,
        is_bulk: false,
      });
      if (lineErr) throw lineErr;

      // Write the stock_move so the audit trail is complete
      const { error: moveErr } = await svc.from('stock_moves').insert({
        id: crypto.randomUUID(),
        business_id: businessId,
        product_id: product.id,
        type: 'sortie',
        qty: sale.qty,
        ref_id: orderId,
        ref_type: 'vente',
        note: 'demo',
        created_by: userId,
        created_at: saleDate.toISOString(),
        updated_at: saleDate.toISOString(),
      });
      if (moveErr) throw moveErr;

      // Decrement stock so demo product counts reflect the demo sales
      const { error: stockErr } = await svc
        .from('products')
        .update({ stock_qty: product.stock_qty - sale.qty })
        .eq('id', product.id);
      if (stockErr) throw stockErr;
      product.stock_qty -= sale.qty;

      if (!sale.isCredit && sale.payMethod) {
        const { error: payErr } = await svc.from('payments').insert({
          id: crypto.randomUUID(),
          order_id: orderId,
          business_id: businessId,
          customer_name: customers[sale.customerIdx],
          method: sale.payMethod,
          amount: totalCents,
          date: saleDateStr,
          created_at: saleDate.toISOString(),
        });
        if (payErr) throw payErr;
      }
    }

    // ─── Expenses (base amounts in GNF cents ×100, scaled to target currency) ─
    const expensesSpec = [
      { daysAgo:  2, amount: m(500000000, factor), description: 'Loyer mensuel',          category: 'Loyer'        },
      { daysAgo:  5, amount: m(150000000, factor), description: 'Transport marchandises',  category: 'Transport'    },
      { daysAgo: 10, amount: m( 80000000, factor), description: 'Facture électricité',     category: 'Électricité'  },
      { daysAgo: 15, amount: m(250000000, factor), description: 'Achat stock farine',      category: 'Stock'        },
    ];

    for (const exp of expensesSpec) {
      const expDate = new Date();
      expDate.setDate(expDate.getDate() - exp.daysAgo);

      const { error: expErr } = await svc.from('expenses').insert({
        id: crypto.randomUUID(),
        business_id: businessId,
        amount: exp.amount,
        description: exp.description,
        category: exp.category,
        date: expDate.toISOString().split('T')[0],
        due_date: null,
        note: null,
        status: 'approuve',
        created_by: userId,
        approved_by: userId,
        approved_at: expDate.toISOString(),
        created_at: expDate.toISOString(),
        updated_at: expDate.toISOString(),
      });
      if (expErr) throw expErr;
    }

    return new Response(
      JSON.stringify({ businessId }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Erreur inconnue';
    console.error('seed-demo-business crash:', msg);
    return new Response(JSON.stringify({ error: msg }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
