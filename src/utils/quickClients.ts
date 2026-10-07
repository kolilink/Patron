// The quick-client picker's list, built from LOCAL truth first:
//   • server  — the last ranked clients list seen online (or the live one);
//   • sales   — customer names on the sales the phone already holds (cache + the
//               outbox overlay), with when they last bought/owed;
//   • pending — names recorded OFFLINE that have not synced yet (still in the outbox).
// A name just recorded must be in the picker instantly after "✓ Ajouté" — before
// any network round trip, and with no network at all. Merged by normalized name so
// a client recorded offline, then synced, never appears twice.
export interface QuickClient {
  id?: string;
  name: string;
  phone?: string | null;
}

export interface NameActivity {
  name: string;
  /** ISO timestamp of the activity (sale created / op queued). */
  at: string;
  clientId?: string | null;
}

export const normalizeClientName = (n: string): string => n.trim().replace(/\s+/g, ' ').toLowerCase();

export function mergeQuickClients(args: {
  server: QuickClient[];
  sales: NameActivity[];
  pending: NameActivity[];
}): QuickClient[] {
  const byKey = new Map<string, QuickClient & { _at: string; _order: number }>();
  args.server.forEach((c, i) => {
    const key = normalizeClientName(c.name);
    if (key && !byKey.has(key)) byKey.set(key, { ...c, _at: '', _order: i });
  });
  const note = (a: NameActivity) => {
    const key = normalizeClientName(a.name);
    if (!key) return;
    const cur = byKey.get(key);
    if (cur) {
      if (a.at > cur._at) cur._at = a.at;
      if (!cur.id && a.clientId) cur.id = a.clientId;
    } else {
      byKey.set(key, { id: a.clientId ?? undefined, name: a.name.trim().replace(/\s+/g, ' '), _at: a.at, _order: Number.MAX_SAFE_INTEGER });
    }
  };
  args.sales.forEach(note);
  args.pending.forEach(note);
  return [...byKey.values()]
    .sort((a, b) => {
      if (a._at && b._at) return a._at < b._at ? 1 : a._at > b._at ? -1 : a._order - b._order;
      if (a._at) return -1;
      if (b._at) return 1;
      return a._order - b._order || a.name.localeCompare(b.name);
    })
    .map(({ _at, _order, ...c }) => c);
}

/** Customer names carried by the sales list (credit/ledger customers only matter, but any named buyer is a client). */
export function salesNameActivity(sales: { customer_name?: string | null; client_id?: string | null; created_at: string; status?: string }[]): NameActivity[] {
  const out: NameActivity[] = [];
  for (const s of sales) {
    if (!s.customer_name || s.status === 'annule') continue;
    out.push({ name: s.customer_name, at: s.created_at, clientId: s.client_id ?? null });
  }
  return out;
}

/** Names carried by still-queued ops (offline credits, credit sales, payments). */
export function pendingNameActivity(
  ops: { operation: string; payload: Record<string, unknown>; queuedAt: string | null; status?: string }[],
  businessId: string,
): NameActivity[] {
  const out: NameActivity[] = [];
  for (const op of ops) {
    if (op.status === 'failed_permanent' || op.status === 'failed_corrupt') continue;
    if (op.operation !== 'submit_carnet_debt' && op.operation !== 'submit_sale' && op.operation !== 'record_client_payment') continue;
    const biz = op.payload.p_business_id != null ? String(op.payload.p_business_id) : null;
    if (biz && biz !== businessId) continue;
    const name = op.payload.p_customer_name;
    if (typeof name !== 'string' || !name.trim()) continue;
    out.push({ name, at: op.queuedAt ?? new Date().toISOString(), clientId: (op.payload.p_client_id as string | null) ?? null });
  }
  return out;
}
