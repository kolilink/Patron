import { create } from 'zustand';
import { supabase } from '@/lib/supabase';
import { generateId, generateFallbackName } from '@/lib/id';
import { translateError } from '@/lib/errors';
import { trackEvent } from '@/lib/analytics';
import { saveVentesCache, getVentesCache, getCacheTimestamp, enqueue, getQueueCount } from '@/lib/db';
import { failureReason } from '@/src/utils/failure';
import { enqueueOnce } from '@/lib/outbox';
import { createKeyedInflightGuard } from '@/lib/inflight';
import { isNetworkError, withNetworkRetry, reportOfflineFallback } from '@/lib/sync';
import { useSyncStore } from '@/stores/sync';
import { notifyEvent } from '@/src/utils/notifications';
import { useAuthStore } from '@/stores/auth';
import { formatAmount } from '@/src/utils/format';
import { rebuildPendingOverlay, type OverlayContext } from '@/lib/pendingOverlay';

// See stores/products.ts for the full explanation — a fetch already in
// flight when the user switches businesses must not overwrite the new
// business's state once it finally resolves.
function isStaleBusiness(businessId: string): boolean {
  return useAuthStore.getState().session?.activeBusiness?.id !== businessId;
}

export interface VenteLigne {
  id: string;
  product_id: string;
  product_name: string;
  variant_id?: string | null;
  variant_name?: string | null;
  qty: number;
  unit_price: number;
  is_bulk: boolean;
  cost_price: number;
}

export interface VentePayment {
  id: string;
  method: string;
  amount: number;
  date: string;
}

// One entry per edit_sale() call — before/after are the whole-shape snapshots
// the RPC stores, in display units (already /100), so the detail screen can
// diff them directly without knowing which fields changed ahead of time.
export interface SaleEditSnapshot {
  customer_name: string | null;
  client_id: string | null;
  due_date: string | null;
  total_amount: number;
  discount_amount: number;
  lines: { line_id: string; product_name: string; unit_price: number }[];
  payments: { payment_id: string; method: string; amount: number; ref_external: string | null }[];
}

export interface SaleEdit {
  id: string;
  edit_number: number;
  edited_by: string;
  edited_by_name: string;
  edited_at: string;
  reason: string | null;
  before: SaleEditSnapshot;
  after: SaleEditSnapshot;
}

export interface Vente {
  id: string;
  business_id: string;
  customer_name: string | null;
  client_id: string | null;
  seller_id: string;
  seller_name: string;
  status: string;
  is_credit: boolean;
  total_amount: number;
  discount_amount: number;
  paid_at: string | null;
  sale_date: string | null;
  due_date?: string | null;
  created_at: string;
  cancelled_at: string | null;
  cancellation_reason: string | null;
  cancelled_by_id?: string | null;
  cancelled_by_name?: string;
  edit_count: number;
  last_edited_at: string | null;
  last_edited_by?: string | null;
  last_edited_by_name?: string;
  profit: number | null;
  amount_paid?: number;
  lines?: VenteLigne[];
  payments?: VentePayment[];
  edits?: SaleEdit[];
  // Set by lib/pendingOverlay.ts's rebuildPendingOverlay — this row (or a
  // patch already applied to it) exists only because of a still-unsynced
  // sync_queue entry. Never rendered as a badge/chrome (the standing "zero
  // sync noise" rule) — a data-layer marker only, used to know which rows
  // are safe to treat as the real synced baseline the next time the
  // overlay is rebuilt (see refreshPendingOverlay below).
  _pending?: true;
}

interface VentesStore {
  sales: Vente[];
  // Business id fetchSales last reached a terminal result for — null until
  // then. See stores/products.ts's productsFetchedFor for why this exists:
  // `sales.length === 0` can't tell "confirmed no sales" apart from "haven't
  // loaded yet," and app/(app)/_layout.tsx's activation fork needs that
  // distinction to avoid flashing for a business that already has a sale.
  salesFetchedFor: string | null;
  loading: boolean;
  saving: boolean;
  error: string | null;
  offline: boolean;
  offlineSince: number | null;
  // limit/status are additive, optional, and used only by the Ventes history
  // screen's infinite-scroll + status-tab filtering (ventes/index.tsx) —
  // every other caller (dashboard, clients screens) omits them and keeps
  // getting the exact same full, unfiltered fetch as before.
  fetchSales: (businessId: string, sellerId?: string, since?: string, limit?: number, status?: 'paye' | 'credit' | 'annule') => Promise<void>;
  // The single entry point every Phase-1 write path (stores/sales.ts's
  // submitCarnetDebt/submitQuickSale/submitSale, and this file's own
  // recordClientPayment/cancelSale) calls right after a local write
  // durably enqueues, and that §6's read-side hydration also calls on
  // mount/focus. Always recomputes from (current `sales` with any
  // previous overlay stripped out) + (whatever's currently in the durable
  // sync_queue outbox) — never incrementally patched — so it self-heals
  // across a kill, a drain success/failure, or a live fetch replacing the
  // synced baseline underneath it. See lib/pendingOverlay.ts's own header
  // comment for the full reasoning.
  refreshPendingOverlay: () => Promise<void>;
  // Read-only twin of refreshPendingOverlay for the dashboard: the synced
  // baseline (ventes_cache) and the outbox-aware list built from it, for the
  // session's default scope. Sets no state.
  readOverlayPair: () => Promise<{ baseline: Vente[]; overlay: Vente[] }>;
  loadDetail: (saleId: string) => Promise<void>;
  // `idempotencyKey` is optional: a caller that may retry after a failure passes the SAME key on every
  // attempt, so a retry can never record the payment twice (locally or at the server).
  // `reason` is the one thing worth telling her about a failure (see src/utils/failure.ts), never a raw message.
  recordPayment: (saleId: string, amount: number, method: string, date: string, idempotencyKey?: string) => Promise<{ ok: boolean; fullyPaid: boolean; paymentId?: string; reason?: string }>;
  recordClientPayment: (customerName: string, businessId: string, amount: number, method: string, date: string, idempotencyKey?: string) => Promise<{ ok: boolean; fullySettled: boolean; paymentIds?: string[]; reason?: string }>;
  // Reverses one or more payments rows created by recordPayment/recordClientPayment
  // above, via the void_payment RPC (migration_v157.sql). Not offline-queued — a
  // void is a correction that needs a live round trip, same posture as the rest
  // of this app's "compensating action" undos (cancel_sale, archiveProduct).
  voidPayments: (paymentIds: string[], businessId: string, reason?: string) => Promise<boolean>;
  cancelSale: (saleId: string, businessId: string, userId: string, reason: string) => Promise<boolean>;
  updateSaleClient: (saleId: string, customerName: string) => Promise<boolean>;
  editSale: (params: EditSaleParams) => Promise<{ ok: boolean; error?: string }>;
  clearError: () => void;
  reset: () => void;
}

// Amounts are display-unit (GNF etc, not cents) — converted to bigint cents
// right before the RPC call, same as every other amount in this store.
// lineEdits/paymentEdits only need the entries actually being corrected —
// edit_sale() recomputes total_amount from ALL of so_lines regardless of
// which lines are listed here.
export interface EditSaleParams {
  saleId: string;
  businessId: string;
  customerName: string | null;
  clientId: string | null;
  dueDate: string | null;
  discountAmount: number;
  lineEdits: { lineId: string; unitPrice: number }[];
  paymentEdits: { paymentId: string; method: string; amount: number; refExternal: string | null }[];
  reason: string | null;
}

// Shared by every Phase-1 write path's post-enqueue refresh (this file
// and stores/sales.ts) — resolved from the current session the same way
// stores/sales.ts's old submitSale offline branch already did (seller
// name for a NEW projected sale), extended to canceller name for
// cancel_sale's patch too. Kept here rather than inside
// refreshPendingOverlay itself so it's the one place this resolution
// logic lives, not duplicated at each of the 5 call sites.
function currentOverlayContext(): OverlayContext {
  const session = useAuthStore.getState().session;
  return {
    currentUserId: session?.user.id ?? null,
    currentUserName: session?.user.name ?? '',
    currentBusinessId: session?.activeBusiness?.id ?? null,
  };
}

// Vente's optional fields (?) vs OverlaySale's required-with-null ones is a
// real, structural difference — Vente is "whatever a live Supabase fetch
// happened to return," OverlaySale is "every field this module's own
// projectors always populate." Normalized explicitly, field by field,
// rather than a blanket cast, so a future field added to one side without
// the other doesn't silently paper over a real shape mismatch.
function toOverlaySale(v: Vente): import('@/lib/pendingOverlay').OverlaySale {
  return {
    id: v.id, business_id: v.business_id, customer_name: v.customer_name, client_id: v.client_id,
    seller_id: v.seller_id, seller_name: v.seller_name, status: v.status, is_credit: v.is_credit,
    total_amount: v.total_amount, discount_amount: v.discount_amount, amount_paid: v.amount_paid ?? 0,
    paid_at: v.paid_at, sale_date: v.sale_date, due_date: v.due_date ?? null,
    created_at: v.created_at, cancelled_at: v.cancelled_at, cancellation_reason: v.cancellation_reason,
    cancelled_by_id: v.cancelled_by_id ?? null, cancelled_by_name: v.cancelled_by_name ?? null,
    edit_count: v.edit_count, last_edited_at: v.last_edited_at, profit: v.profit,
    lines: (v.lines ?? []).map(l => ({ ...l, variant_id: l.variant_id ?? null, variant_name: l.variant_name ?? null })),
    payments: v.payments ?? [],
  };
}

// A payment retried after a failure carries the same idempotency key. Locally
// that must never put a second copy in the outbox (the server would dedup the
// pair, but the overlay would show it twice until then), and two taps in the
// same tick must collapse into one call.
const paymentGuard = createKeyedInflightGuard();

export const useVentesStore = create<VentesStore>((set, get) => ({
  sales: [],
  salesFetchedFor: null,
  loading: false,
  saving: false,
  error: null,
  offline: false,
  offlineSince: null,

  readOverlayPair: async () => {
    const session = useAuthStore.getState().session;
    if (!session?.activeBusiness) return { baseline: [], overlay: [] };
    const businessId = session.activeBusiness.id;
    const isVendeur = session.activeMembership?.role === 'vendeur';
    const cacheKey = `${businessId}:${isVendeur ? session.user.id : 'all'}`;
    // Baseline = the untouched synced cache, never in-memory `sales` (see
    // refreshPendingOverlay's note on why re-folding a patched list double-applies).
    const cached = (await getVentesCache(cacheKey)) as Vente[] | null;
    const baseline = (cached ?? []).map(toOverlaySale);
    const { sales } = await rebuildPendingOverlay(baseline, currentOverlayContext());
    return { baseline: (cached ?? []) as Vente[], overlay: sales as Vente[] };
  },

  refreshPendingOverlay: async () => {
    const session = useAuthStore.getState().session;
    if (!session?.activeBusiness) return;
    const businessId = session.activeBusiness.id;
    const isVendeur = session.activeMembership?.role === 'vendeur';
    // Same scoping rule fetchSales itself is always called with
    // (app/(app)/_layout.tsx: fetchSales(businessId, isVendeur ? userId :
    // undefined)) — a vendeur must never have another seller's sales
    // folded into their own view via this mechanism either. Resolved from
    // the session directly rather than threaded through all 5 write-path
    // call sites, so a caller can't accidentally get this wrong.
    const cacheKey = `${businessId}:${isVendeur ? session.user.id : 'all'}`;

    // The baseline MUST be the last genuinely-synced snapshot (ventes_cache,
    // which this overlay mechanism never writes to — see
    // lib/pendingOverlay.ts's header comment), never the CURRENT in-memory
    // `sales`. Using in-memory `sales` as the next baseline was tried first
    // and is a real bug: a previous rebuild may have already applied a
    // payment/cancellation patch to an existing, genuinely-synced sale, and
    // stripping `_pending` rows alone doesn't undo a patch already applied
    // to a non-pending row — re-folding the same still-queued payment on
    // top of its own already-applied effect would allocate it twice.
    // Re-reading the untouched cache every time avoids this class of bug
    // entirely: nothing here is ever partially-applied, because the
    // baseline never carries any prior overlay effect at all.
    const { overlay } = await get().readOverlayPair();
    set({ sales: overlay });
  },

  fetchSales: async (businessId, sellerId, since, limit, status) => {
    // status branches the cache key off into its own slot so a filtered
    // ("Payés"/"À payer"/"Annulés") fetch can never overwrite the shared,
    // unfiltered cache dashboard/clients screens rely on — omitted (the
    // "Tout" tab, and every non-Ventes caller) resolves to the exact same
    // key as before. limit deliberately does NOT affect the key: it only
    // ever grows (30, 60, 90… as the user scrolls), so the cache simply
    // holds whatever the largest loaded window was — a fine offline
    // snapshot, not a claim of completeness, same posture as every other
    // read cache in this codebase.
    const cacheKey = `${businessId}:${sellerId ?? 'all'}${status ? `:${status}` : ''}`;

    // Local-first (§6): seed from cache + the current pending-outbox
    // overlay UNCONDITIONALLY, every call — not just "if sales is still
    // empty" the way this used to be gated. That old condition meant a
    // refetch (screen refocus, pull-to-refresh) on an already-populated
    // list skipped straight to the live query, so the UI's only source of
    // truth during that round trip was whatever was already rendered —
    // fine when nothing changed underneath it, but not the guarantee
    // acceptance test #3 (cold start after a kill) actually needs: cache
    // and the outbox are re-read and re-rendered BEFORE any network call
    // starts, every time, per the approved hydration order (cache ->
    // overlay -> render -> background refresh).
    //
    // The overlay merge only applies to the plain, unfiltered, role-scoped
    // view (no status filter, sellerId matching what refreshPendingOverlay
    // itself would resolve from the session) — a status-filtered tab
    // ("Payés"/"À payer"/"Annulés") or an explicit cross-seller admin
    // query falls back to a cache-only seed, same as before. Phase 1's
    // approved scope is the default carnet/dashboard/ventes-list view;
    // extending the overlay to every filtered permutation is real,
    // separate scope, not silently attempted here.
    const isDefaultScope = !status && (sellerId === undefined || sellerId === useAuthStore.getState().session?.user.id);
    if (isDefaultScope) {
      await get().refreshPendingOverlay();
      if (isStaleBusiness(businessId)) return;
      set({ loading: false, error: null });
    } else {
      const cached = await getVentesCache(cacheKey) as Vente[] | null;
      if (isStaleBusiness(businessId)) return;
      if (cached) {
        set({ sales: cached, loading: false, error: null });
      } else {
        set({ loading: true, error: null });
      }
    }

    let query = supabase
      .from('sale_orders')
      .select('*')
      .eq('business_id', businessId)
      .order('created_at', { ascending: false });

    if (sellerId) query = query.eq('seller_id', sellerId);
    if (since) query = query.gte('sale_date', since);
    if (status) query = query.eq('status', status);
    if (limit) query = query.limit(limit);

    const { data, error: fetchErr } = await withNetworkRetry(() => query).catch(err => ({ data: null, error: err }));
    if (isStaleBusiness(businessId)) return;
    if (fetchErr) {
      if (isNetworkError(fetchErr)) {
        reportOfflineFallback('ventes.fetchSales', fetchErr);
        if (isDefaultScope) {
          // A network failure must NOT overwrite `sales` with the raw cache:
          // refreshPendingOverlay already merged the outbox at the top of
          // fetchSales, so just-written offline sales are already in `sales`
          // and would be wiped if we re-seeded from the (stale, outbox-free)
          // cache here. Re-apply the overlay instead — its baseline is the
          // untouched cache, so this also stays self-consistent — then set
          // only the offline flags.
          await get().refreshPendingOverlay();
          if (isStaleBusiness(businessId)) return;
          const ts = await getCacheTimestamp('ventes_cache', cacheKey);
          if (isStaleBusiness(businessId)) return;
          set({ loading: false, offline: true, offlineSince: ts, error: null, salesFetchedFor: businessId });
          return;
        }
        // Non-default scope (status-filtered fetches): keep the raw-cache
        // behavior — the overlay is scope-specific and must not leak into
        // filtered views.
        const cached = await getVentesCache(cacheKey) as Vente[] | null;
        if (isStaleBusiness(businessId)) return;
        if (cached) {
          const ts = await getCacheTimestamp('ventes_cache', cacheKey);
          if (isStaleBusiness(businessId)) return;
          set({ sales: cached, loading: false, offline: true, offlineSince: ts, error: null, salesFetchedFor: businessId });
          return;
        }
        set({
          error: 'Pas de connexion. Ouvrez l\'application en ligne une première fois pour activer le mode hors ligne.',
          loading: false,
          offline: true,
          salesFetchedFor: businessId,
        });
        return;
      }
      set({ loading: false, error: translateError(fetchErr, "Le chargement n'a pas abouti."), salesFetchedFor: businessId });
      return;
    }
    if (!data) { set({ loading: false, salesFetchedFor: businessId }); return; }

    const orderIds = data.map((s: Record<string, unknown>) => s.id as string);
    const sellerIds = [...new Set(data.map((s: Record<string, unknown>) => s.seller_id as string))];
    const cancellerIds = [...new Set(
      data
        .map((s: Record<string, unknown>) => s.cancelled_by_id as string | null)
        .filter((id): id is string => !!id)
    )];
    const editorIds = [...new Set(
      data
        .map((s: Record<string, unknown>) => s.last_edited_by as string | null)
        .filter((id): id is string => !!id)
    )];
    const allProfileIds = [...new Set([...sellerIds, ...cancellerIds, ...editorIds])];

    const allMemberIds = [...new Set([...sellerIds, ...cancellerIds, ...editorIds])];
    const [profilesRes, linesRes, paysRes, membershipsRes] = await Promise.all([
      supabase.from('profiles').select('id, name').in('id', allProfileIds),
      supabase
        .from('so_lines')
        .select('order_id, qty, cost_price_at_sale, product:products(cost_price), variant:product_variants(cost_price)')
        .in('order_id', orderIds),
      orderIds.length > 0
        ? supabase.from('payments').select('order_id, amount').in('order_id', orderIds)
        : Promise.resolve({ data: [] }),
      allMemberIds.length > 0
        ? supabase.from('memberships').select('user_id, display_name').eq('business_id', businessId).in('user_id', allMemberIds)
        : Promise.resolve({ data: [] }),
    ]);

    const pm: Record<string, string> = {};
    for (const p of (profilesRes.data ?? [])) {
      pm[(p as { id: string; name: string }).id] = (p as { id: string; name: string }).name;
    }

    // display_name set by manager overrides profile name for seller display
    const dm: Record<string, string> = {};
    for (const m of ((membershipsRes as { data: { user_id: string; display_name: string | null }[] | null }).data ?? [])) {
      if (m.display_name) dm[m.user_id] = m.display_name;
    }

    // Accumulate COGS per order using the snapshotted cost (added v81).
    // Falls back to current product/variant cost_price for rows written before v81.
    // Profit is then computed at the order level: (total_amount - discount_amount) - COGS.
    // This correctly handles discounts, above-catalog overrides, and cost-price changes.
    const cogsByOrder: Record<string, number> = {};
    const hasCostByOrder: Record<string, boolean> = {};
    for (const l of (linesRes.data ?? [])) {
      const line = l as unknown as {
        order_id: string;
        qty: number;
        cost_price_at_sale: number | null;
        product: { cost_price: number } | null;
        variant: { cost_price: number } | null;
      };
      const costCents = line.cost_price_at_sale ?? line.variant?.cost_price ?? line.product?.cost_price ?? 0;
      if (costCents > 0) hasCostByOrder[line.order_id] = true;
      cogsByOrder[line.order_id] = (cogsByOrder[line.order_id] ?? 0) + (costCents * line.qty) / 100;
    }

    // Sum payments per order to compute amount_paid (used for credit + discounted sales)
    const paidByOrder: Record<string, number> = {};
    for (const p of (paysRes.data ?? []) as { order_id: string; amount: number }[]) {
      paidByOrder[p.order_id] = (paidByOrder[p.order_id] ?? 0) + p.amount / 100;
    }

    const sales = data.map((s: Record<string, unknown>) => {
      const discount = ((s.discount_amount as number) ?? 0) / 100;
      const totalAmount = (s.total_amount as number) / 100;
      // Revenue = total_amount (already reflects any above-catalog override) minus discount.
      // Subtract COGS to get true gross profit per sale.
      const profit = hasCostByOrder[s.id as string]
        ? (totalAmount - discount) - (cogsByOrder[s.id as string] ?? 0)
        : null;
      return {
        ...s,
        total_amount: totalAmount,
        seller_name: dm[s.seller_id as string] || pm[s.seller_id as string] || generateFallbackName(s.seller_id as string),
        is_credit: (s.is_credit as boolean) ?? false,
        discount_amount: discount,
        client_id: (s.client_id as string | null) ?? null,
        cancelled_at: (s.cancelled_at as string | null) ?? null,
        cancellation_reason: (s.cancellation_reason as string | null) ?? null,
        cancelled_by_id: (s.cancelled_by_id as string | null) ?? null,
        cancelled_by_name: s.cancelled_by_id
          ? (dm[s.cancelled_by_id as string] || pm[s.cancelled_by_id as string] || generateFallbackName(s.cancelled_by_id as string))
          : undefined,
        edit_count: (s.edit_count as number) ?? 0,
        last_edited_at: (s.last_edited_at as string | null) ?? null,
        last_edited_by: (s.last_edited_by as string | null) ?? null,
        last_edited_by_name: s.last_edited_by
          ? (dm[s.last_edited_by as string] || pm[s.last_edited_by as string] || generateFallbackName(s.last_edited_by as string))
          : undefined,
        profit,
        // Always set: a settled (paye) sale has its own atomic payment that
        // nets to zero; credit sales and discounted sales carry whatever was
        // actually paid. This makes every caller see the same truth and is
        // what the carnet list/detail rely on for the unified "owed" formula.
        amount_paid: paidByOrder[s.id as string] ?? 0,
      } as Vente;
    });
    void saveVentesCache(cacheKey, sales as unknown[]);
    if (isStaleBusiness(businessId)) return;
    if (isDefaultScope) {
      // A live fetch landing must never silently drop a still-unsynced
      // item from view, even transiently — without this, a plain
      // `set({ sales })` here would overwrite the pending-overlay merge
      // with the server's own list, which by definition doesn't yet
      // contain anything still sitting in the local outbox. Re-running
      // the same rebuild (now against the freshly-cached, just-saved
      // server data as its baseline) restores it in the same tick.
      set({ loading: false, offline: false, offlineSince: null, salesFetchedFor: businessId });
      await get().refreshPendingOverlay();
    } else {
      set({ sales, loading: false, offline: false, offlineSince: null, salesFetchedFor: businessId });
    }
  },

  loadDetail: async (saleId) => {
    const businessId = get().sales.find(s => s.id === saleId)?.business_id;
    const [linesRes, paysRes, editsRes] = await Promise.all([
      supabase.from('so_lines').select('*, product:products(name, cost_price), variant:product_variants(cost_price)').eq('order_id', saleId),
      supabase
        .from('payments')
        .select('id, method, amount, date')
        .eq('order_id', saleId)
        .order('date', { ascending: true }),
      supabase
        .from('sale_order_edits')
        .select('id, edit_number, edited_by, edited_at, reason, before, after')
        .eq('order_id', saleId)
        .order('edit_number', { ascending: false }),
    ]);

    if (linesRes.error || paysRes.error) return;

    type ProductJoin = { name: string; cost_price: number } | null;
    type VariantJoin = { cost_price: number } | null;
    const lines: VenteLigne[] = (linesRes.data ?? []).map((l: Record<string, unknown>) => ({
      id: l.id as string,
      product_id: l.product_id as string,
      // Prefer the snapshot name stored at sale time; fall back to current product name
      product_name: (l.product_name as string | null) ?? (l.product as ProductJoin)?.name ?? '—',
      variant_id: (l.variant_id as string | null) ?? null,
      variant_name: (l.variant_name as string | null) ?? null,
      qty: l.qty as number,
      unit_price: (l.unit_price as number) / 100,
      is_bulk: (l.is_bulk as boolean) ?? false,
      // Use snapshotted cost (v81+); fall back to live variant/product cost for pre-v81 rows
      cost_price: ((l.cost_price_at_sale as number | null) ?? (l.variant as VariantJoin)?.cost_price ?? (l.product as ProductJoin)?.cost_price ?? 0) / 100,
    }));

    const payments: VentePayment[] = (paysRes.data ?? []).map((p: Record<string, unknown>) => ({
      id: p.id as string,
      method: p.method as string,
      amount: (p.amount as number) / 100,
      date: p.date as string,
    }));

    const amount_paid = payments.reduce((s, p) => s + p.amount, 0);

    // Convert a raw before/after snapshot (cents, as stored by edit_sale())
    // into display units, matching how lines/payments above are converted.
    const toDisplaySnapshot = (snap: Record<string, unknown>): SaleEditSnapshot => ({
      customer_name: (snap.customer_name as string | null) ?? null,
      client_id: (snap.client_id as string | null) ?? null,
      due_date: (snap.due_date as string | null) ?? null,
      total_amount: (snap.total_amount as number) / 100,
      discount_amount: (snap.discount_amount as number) / 100,
      lines: ((snap.lines as Record<string, unknown>[] | null) ?? []).map(l => ({
        line_id: l.line_id as string,
        product_name: l.product_name as string,
        unit_price: (l.unit_price as number) / 100,
      })),
      payments: ((snap.payments as Record<string, unknown>[] | null) ?? []).map(p => ({
        payment_id: p.payment_id as string,
        method: p.method as string,
        amount: (p.amount as number) / 100,
        ref_external: (p.ref_external as string | null) ?? null,
      })),
    });

    let edits: SaleEdit[] | undefined;
    if (!editsRes.error && editsRes.data) {
      const editorIds = [...new Set(editsRes.data.map(e => e.edited_by as string))];
      let nameMap: Record<string, string> = {};
      if (editorIds.length > 0) {
        const [{ data: profs }, { data: mems }] = await Promise.all([
          supabase.from('profiles').select('id, name').in('id', editorIds),
          businessId
            ? supabase.from('memberships').select('user_id, display_name').eq('business_id', businessId).in('user_id', editorIds)
            : Promise.resolve({ data: [] as { user_id: string; display_name: string | null }[] }),
        ]);
        const pm: Record<string, string> = {};
        for (const p of (profs ?? []) as { id: string; name: string }[]) pm[p.id] = p.name;
        const dm: Record<string, string> = {};
        for (const m of (mems ?? []) as { user_id: string; display_name: string | null }[]) {
          if (m.display_name) dm[m.user_id] = m.display_name;
        }
        nameMap = { ...pm, ...dm };
      }
      edits = editsRes.data.map(e => ({
        id: e.id as string,
        edit_number: e.edit_number as number,
        edited_by: e.edited_by as string,
        edited_by_name: nameMap[e.edited_by as string] || generateFallbackName(e.edited_by as string),
        edited_at: e.edited_at as string,
        reason: (e.reason as string | null) ?? null,
        before: toDisplaySnapshot(e.before as Record<string, unknown>),
        after: toDisplaySnapshot(e.after as Record<string, unknown>),
      }));
    }

    set(state => ({
      sales: state.sales.map(s =>
        s.id === saleId ? { ...s, lines, payments, amount_paid, edits } : s,
      ),
    }));
  },

  // Local-write-first (§5, same shape as recordClientPayment/cancelSale
  // below). record_payment now has a real idempotency key
  // (migration_v205) — required before this could safely go local-write-
  // first at all, same prerequisite migration_v203 established for
  // recordClientPayment: without it, an outbox retry of the exact same
  // payment (a drain retry after a partial network failure) could
  // double-insert real money against the sale. Unlike recordClientPayment's
  // FIFO fan-out, this always targets exactly one already-known sale_id —
  // lib/pendingOverlay.ts's applyPatchOp handles it as a plain single-sale
  // patch, not the allocateClientPayment loop.
  recordPayment: async (saleId, amount, method, date, providedKey) => {
    const idempotencyKey = providedKey ?? generateId();
    const attempt = await paymentGuard.run(idempotencyKey, async () => {
    set({ saving: true, error: null });
    const sale = get().sales.find(s => s.id === saleId);
    if (!sale) { set({ saving: false }); return { ok: false, fullyPaid: false }; }

    const alreadyPaid = sale.amount_paid ?? 0;
    const owed = sale.total_amount - (sale.discount_amount ?? 0);
    const remainingBefore = owed - alreadyPaid;
    const newAmountPaid = alreadyPaid + amount;
    const fullyPaid = newAmountPaid >= owed - 0.01;
    const amountCents = Math.round(amount * 100);
    

    // record_payment() re-checks the real remaining balance server-side and
    // rejects the insert if it would overpay — the on-device
    // `owed`/`fullyPaid` figures above are only used for the optimistic UI,
    // never trusted for the actual write. The live RPC returns the real
    // server-side payment_id (migration_v205's jsonb contract, PR #41),
    // which is what the SaveConfirmation undo voids.
    const rpcPayload = {
      p_sale_id: saleId,
      p_business_id: sale.business_id,
      p_amount: amountCents,
      p_method: method,
      p_date: date,
      p_idempotency_key: idempotencyKey,
    };

    const notifyCreditPaid = () => {
      // credit_paid notification — fired on both the live and offline
      // fallback paths (same optimistic posture as recordClientPayment;
      // a payment later rejected at drain time may rarely have already
      // notified for something that didn't ultimately apply — a pre-existing
      // characteristic of this flow). "total" states the debt that just got
      // cleared (remainingBefore, not the original sale total); "partiel"
      // states only the amount just paid.
      const currency = useAuthStore.getState().session?.activeBusiness?.currency ?? 'GNF';
      notifyEvent({
        businessId: sale.business_id,
        eventType: 'credit_paid',
        payload: fullyPaid
          ? { customer: sale.customer_name ?? '', amount: formatAmount(remainingBefore, currency), status: 'total' }
          : { customer: sale.customer_name ?? '', amount: formatAmount(amount, currency), status: 'partiel' },
        targetRoles: ['administrateur', 'manager'],
      });
    };

    let paymentId: string | undefined;

    try {
      const { data, error: rpcErr } = await supabase.rpc('record_payment', rpcPayload);
      if (rpcErr) throw rpcErr;
      const result = data as { fully_paid: boolean; payment_id: string };
      paymentId = result.payment_id;
      try {
        await get().refreshPendingOverlay();
      } catch (overlayErr) {
        console.error('[recordPayment] refreshPendingOverlay failed (write already succeeded)', overlayErr);
      }
      set({ saving: false });
      notifyCreditPaid();
      trackEvent('repayment_recorded', sale.business_id, null, { fully_settled: result.fully_paid, scope: 'sale' });
      return { ok: true, fullyPaid: result.fully_paid, paymentId };
    } catch (err) {
      if (isNetworkError(err)) {
        try {
          await enqueueOnce('record_payment', rpcPayload);
        } catch (enqErr) {
          console.error('[recordPayment] local write failed', enqErr);
          set({ saving: false, error: "Impossible d'enregistrer sur cet appareil. Réessayez." });
          return { ok: false, fullyPaid: false, reason: undefined };
        }
        // The write is durable from here on: nothing below may turn this into a failure.
        try {
          useSyncStore.setState({ pendingCount: await getQueueCount() });
        } catch { /* the count refreshes on the next sync tick */ }
        try {
          await get().refreshPendingOverlay();
        } catch (overlayErr) {
          console.error('[recordPayment] refreshPendingOverlay failed (write already succeeded)', overlayErr);
        }
        set({ saving: false });
        useSyncStore.getState().kick();
        notifyCreditPaid();
        trackEvent('repayment_recorded', sale.business_id, null, { fully_settled: fullyPaid, scope: 'sale', queued: true });
        // No server row yet in the offline fallback — paymentId stays
        // undefined until the queued RPC drains (undo unavailable until sync).
        return { ok: true, fullyPaid };
      }
      set({ saving: false, error: translateError(err, 'Paiement impossible') });
      return { ok: false, fullyPaid: false, reason: failureReason(err) };
    }
  });
    return attempt.ran ? attempt.value : { ok: false, fullyPaid: false };
  },

  // Local-write-first (§5, same shape as stores/sales.ts's three functions).
  // record_client_payment now has a real idempotency key (migration_v203,
  // §7) — required before this could safely go local-write-first at all:
  // without it, an outbox retry of the exact same payment (a drain retry
  // after a partial network failure) could double-allocate real money
  // against the client's debt. See that migration's own header comment for
  // why the mechanism is a dedicated claim table, not a column on
  // `payments` itself (this RPC's FIFO allocation can fan out into a
  // variable number of payments rows per call).
  recordClientPayment: async (customerName, businessId, amount, method, date, providedKey) => {
    const idempotencyKey = providedKey ?? generateId();
    const attempt = await paymentGuard.run(idempotencyKey, async () => {
    set({ saving: true, error: null });

    // Cheap local pre-check only (not authoritative — the RPC's own FOR
    // UPDATE row locking + idempotency claim is what actually prevents
    // double-payment). Guards against enqueueing a payment this device
    // can already tell has nothing to allocate against.
    const creditSales = get().sales.filter(s =>
      s.customer_name === customerName && s.business_id === businessId && s.status === 'credit',
    );
    if (creditSales.length === 0) {
      set({ saving: false, error: 'Aucun crédit trouvé pour ce client' });
      return { ok: false, fullySettled: false, reason: 'Aucun crédit trouvé pour ce client.' };
    }
    // Sum of what this client owed right before this payment — used for
    // the "total" credit_paid notification wording ("a totalement payé sa
    // dette de X"), the actual debt that just got cleared, not just the
    // amount of this one payment.
    const totalOwedBefore = creditSales.reduce(
      (sum, s) => sum + (s.total_amount - (s.discount_amount ?? 0) - (s.amount_paid ?? 0)), 0,
    );

    // v157 jsonb contract (PR #41): record_client_payment fans out into a
    // variable number of payments rows; the SaveConfirmation undo voids each
    // returned id. The live RPC returns those ids (migration_v203).
    let paymentIds: string[] | undefined;
    let fullySettled = false;
    
    const rpcPayload = {
      p_business_id: businessId,
      p_customer_name: customerName,
      p_amount: Math.round(amount * 100),
      p_method: method,
      p_date: date,
      p_idempotency_key: idempotencyKey,
    };

    const notifyCreditPaid = () => {
      // Fired unconditionally here (not from lib/sync.ts) — matches this
      // function's own pre-existing behavior. No double-notify risk since
      // lib/sync.ts's record_client_payment case never notifies. Optimistic
      // like every other confirmation: if the RPC is later rejected (§3,
      // failed_permanent), a notification may rarely have already gone out
      // for a payment that didn't ultimately apply. Pre-existing
      // characteristic, not introduced by this rework.
      const currency = useAuthStore.getState().session?.activeBusiness?.currency ?? 'GNF';
      notifyEvent({
        businessId,
        eventType: 'credit_paid',
        payload: fullySettled
          ? { customer: customerName, amount: formatAmount(totalOwedBefore, currency), status: 'total' }
          : { customer: customerName, amount: formatAmount(amount, currency), status: 'partiel' },
        targetRoles: ['administrateur', 'manager'],
      });
    };

    try {
      const { data: rpcData, error: rpcErr } = await supabase.rpc('record_client_payment', rpcPayload);
      if (rpcErr) throw rpcErr;
      const result = rpcData as { fully_settled: boolean; payment_ids: string[] };
      fullySettled = result.fully_settled;
      paymentIds = result.payment_ids;
      try {
        await get().refreshPendingOverlay();
      } catch (overlayErr) {
        console.error('[recordClientPayment] refreshPendingOverlay failed (write already succeeded)', overlayErr);
      }
      set({ saving: false });
      trackEvent('repayment_recorded', businessId, null, { fully_settled: fullySettled, scope: 'client' });
      notifyCreditPaid();
      return { ok: true, fullySettled, paymentIds };
    } catch (err) {
      if (isNetworkError(err)) {
        try {
          await enqueueOnce('record_client_payment', rpcPayload);
        } catch (enqErr) {
          console.error('[recordClientPayment] local write failed', enqErr);
          set({ saving: false, error: "Impossible d'enregistrer sur cet appareil. Réessayez." });
          return { ok: false, fullySettled: false };
        }
        // The write is durable from here on: nothing below may turn this into a failure.
        try {
          useSyncStore.setState({ pendingCount: await getQueueCount() });
        } catch { /* the count refreshes on the next sync tick */ }
        try {
          await get().refreshPendingOverlay();
        } catch (overlayErr) {
          console.error('[recordClientPayment] refreshPendingOverlay failed (write already succeeded)', overlayErr);
        }
        set({ saving: false });
        useSyncStore.getState().kick();
        // No server row yet in the offline fallback — paymentIds stays
        // undefined until the queued RPC drains (undo unavailable until sync).
        fullySettled = get().sales
          .filter(s => s.customer_name === customerName && s.business_id === businessId && s.status === 'credit')
          .reduce((sum, s) => sum + (s.total_amount - (s.discount_amount ?? 0) - (s.amount_paid ?? 0)), 0) < 0.01;
        trackEvent('repayment_recorded', businessId, null, { fully_settled: fullySettled, scope: 'client' });
        notifyCreditPaid();
        return { ok: true, fullySettled, paymentIds };
      }
      set({ saving: false, error: translateError(err, 'Paiement impossible') });
      return { ok: false, fullySettled: false, reason: failureReason(err) };
    }
  });
    return attempt.ran ? attempt.value : { ok: false, fullySettled: false };
  },

  voidPayments: async (paymentIds, businessId, reason) => {
    set({ saving: true, error: null });
    try {
      for (const paymentId of paymentIds) {
        const { error: rpcErr } = await supabase.rpc('void_payment', {
          p_payment_id: paymentId,
          p_business_id: businessId,
          p_reason: reason ?? null,
        });
        if (rpcErr) throw rpcErr;
      }
      // Re-fetch rather than patch optimistically — a void can revert a
      // sale's status (paye → credit) and affect any number of sales at
      // once (FIFO repayments can span several), which is simpler and
      // safer to just re-read than to reconstruct client-side.
      await get().fetchSales(businessId);
      set({ saving: false });
      return true;
    } catch (err) {
      set({ saving: false, error: translateError(err, 'Annulation impossible') });
      return false;
    }
  },

  // Local-write-first (§5). cancel_sale needed no idempotency-key migration
  // (§7 audit) — it was already naturally idempotent via a status guard
  // added in migration_v125 (`IF v_sale.status = 'annule' THEN RETURN true;
  // END IF;`), so a drain retry safely no-ops instead of double-restoring
  // stock. Verified this directly against migration_v125.sql before relying
  // on it, rather than assuming — the ORIGINAL migration_v22.sql version had
  // no such guard and would have needed one added here.
  cancelSale: async (saleId, businessId, userId, reason) => {
    set({ saving: true, error: null });
    const _cancelledSale = get().sales.find(s => s.id === saleId);

    const rpcPayload = { p_sale_id: saleId, p_business_id: businessId, p_reason: reason };
    try {
      await enqueue('cancel_sale', rpcPayload);
    } catch (err) {
      console.error('[cancelSale] local write failed', err);
      set({ saving: false, error: "Impossible d'annuler sur cet appareil. Réessayez." });
      return false;
    }

    const count = await getQueueCount();
    useSyncStore.setState({ pendingCount: count });
    try {
      await get().refreshPendingOverlay();
    } catch (err) {
      console.error('[cancelSale] refreshPendingOverlay failed (write already succeeded)', err);
    }
    set({ saving: false });
    useSyncStore.getState().kick();

    // Notify original seller (if different from canceller) and admins.
    // Fired unconditionally here now — a real, disclosed fix, not just an
    // architectural necessity: the OLD code only ever notified on the live-
    // success path; lib/sync.ts's executeOp never notified for a queued
    // cancel_sale replay either, so an offline-queued cancellation
    // previously never notified anyone at all. cancel_sale's own natural
    // idempotency (above) is what makes firing this unconditionally safe —
    // even if the drainer later retries the same cancellation, the RPC
    // itself no-ops on the second call, and this notify only ever runs
    // once per cancelSale() invocation regardless.
    if (_cancelledSale) {
      const currency = useAuthStore.getState().session?.activeBusiness?.currency ?? 'GNF';
      const targetUserIds: string[] = [];
      if (_cancelledSale.seller_id && _cancelledSale.seller_id !== userId) {
        targetUserIds.push(_cancelledSale.seller_id);
      }
      notifyEvent({
        businessId,
        eventType: 'sale_cancelled',
        // Net of discount, matching what the sale_completed notification
        // showed for this same sale — total_amount alone is the catalog
        // gross, so a discounted sale sold for e.g. 45 000 was reading back
        // as "annulée · 50 000" here. Same convention as the owed/net figure
        // used everywhere else (total_amount − discount_amount).
        payload: { amount: formatAmount(_cancelledSale.total_amount - (_cancelledSale.discount_amount ?? 0), currency), reason },
        targetUserIds: targetUserIds.length > 0 ? targetUserIds : undefined,
        targetRoles: ['administrateur'],
      });
    }
    return true;
  },

  updateSaleClient: async (saleId, customerName) => {
    set({ saving: true, error: null });
    const businessId = get().sales.find(s => s.id === saleId)?.business_id;
    try {
      const { error } = await supabase
        .from('sale_orders')
        .update({ customer_name: customerName.trim() || null })
        .eq('id', saleId)
        .eq('business_id', businessId ?? '');
      if (error) { set({ saving: false, error: translateError(error, 'Impossible de modifier') }); return false; }
      set(state => ({
        sales: state.sales.map(s =>
          s.id === saleId ? { ...s, customer_name: customerName.trim() || null } : s,
        ),
        saving: false,
      }));
      return true;
    } catch (err) {
      set({ saving: false, error: isNetworkError(err) ? 'Vérifiez votre connexion' : translateError(err, 'Impossible de modifier') });
      return false;
    }
  },

  // Admin/manager only (enforced server-side) — corrects a mistaken sale in
  // place instead of cancelling it, with a full before/after audit trail.
  // Deliberately online-only: not queued through the offline sync_queue,
  // since the 48h edit window is checked against a live server clock and a
  // queued replay after a connectivity gap could silently fail that check
  // with no clear signal to the admin. A network error here is a real,
  // immediate failure the caller should retry once back online, not
  // something to defer.
  editSale: async (params) => {
    set({ saving: true, error: null });
    const {
      saleId, businessId, customerName, clientId, dueDate,
      discountAmount, lineEdits, paymentEdits, reason,
    } = params;

    const rpcPayload = {
      p_sale_id: saleId,
      p_business_id: businessId,
      p_customer_name: customerName,
      p_client_id: clientId,
      p_due_date: dueDate,
      p_discount_amount: Math.round(discountAmount * 100),
      p_line_edits: lineEdits.map(l => ({ line_id: l.lineId, unit_price: Math.round(l.unitPrice * 100) })),
      p_payment_edits: paymentEdits.map(p => ({
        payment_id: p.paymentId, method: p.method,
        amount: Math.round(p.amount * 100), ref_external: p.refExternal,
      })),
      p_reason: reason,
    };

    try {
      const { data, error } = await supabase.rpc('edit_sale', rpcPayload);
      if (error) throw error;
      const updated = data as {
        total_amount: number; discount_amount: number; edit_count: number;
        last_edited_at: string; last_edited_by: string;
        customer_name: string | null; client_id: string | null; due_date: string | null;
      };

      const editorName = useAuthStore.getState().session?.user?.name
        || generateFallbackName(updated.last_edited_by);

      const newSales = get().sales.map(s =>
        s.id === saleId
          ? {
            ...s,
            total_amount: updated.total_amount / 100,
            discount_amount: updated.discount_amount / 100,
            edit_count: updated.edit_count,
            last_edited_at: updated.last_edited_at,
            last_edited_by: updated.last_edited_by,
            last_edited_by_name: editorName,
            customer_name: updated.customer_name,
            client_id: updated.client_id,
            due_date: updated.due_date,
          }
          : s,
      );
      set({ sales: newSales, saving: false });
      void saveVentesCache(`${businessId}:all`, newSales as unknown[]);

      // Refreshes lines/payments/edits — the RPC touched all three and the
      // headline patch above only covers the sale_orders row itself.
      await get().loadDetail(saleId);

      const currency = useAuthStore.getState().session?.activeBusiness?.currency ?? 'GNF';
      notifyEvent({
        businessId,
        eventType: 'sale_edited',
        // Net of discount (RPC returns both in cents), matching the net figure
        // sale_completed showed — not the recomputed catalog gross.
        payload: { editor: editorName, amount: formatAmount((updated.total_amount - updated.discount_amount) / 100, currency) },
        targetRoles: ['administrateur', 'manager'],
        excludeUserId: useAuthStore.getState().session?.user?.id,
      });

      return { ok: true };
    } catch (err) {
      // edit_sale() raises plain French messages (limite atteinte, délai dépassé,
      // paiement désynchronisé, etc.) — pass the raw message through as the
      // fallback so it survives instead of being swallowed by a generic one,
      // same idiom useAuthStore's joinBusiness already uses for join_business().
      const raw = err instanceof Error ? err.message : (err as Record<string, unknown>)?.message as string | undefined;
      const message = translateError(err, raw ?? 'Modification impossible');
      set({ saving: false, error: message });
      return { ok: false, error: message };
    }
  },

  clearError: () => set({ error: null }),
  reset: () => set({ sales: [], salesFetchedFor: null, loading: false, saving: false, error: null, offline: false, offlineSince: null }),
}));
