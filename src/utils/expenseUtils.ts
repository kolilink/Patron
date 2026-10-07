// Pure helpers for the expense flow (keypad, grouping, recents, product search).
// No React, no Supabase — everything here is unit-tested in
// __tests__/expense-utils.test.ts.
//
// Totals rule (reconciliation by construction): every total is a live SUM over
// the rows handed in — nothing is cached or stored. The database already hides
// soft-deleted rows (migration_v234), so "visible rows" and "rows in the list"
// are the same set.
import { minorUnits } from './format';
import { formatDate } from './dates';
import type { Expense } from '@/src/types';

// ── Keypad ───────────────────────────────────────────────────────────────────

export type KeypadKey = '0' | '1' | '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9' | '000' | 'dot' | 'back';

const MAX_DIGITS = 12;

/**
 * Applies one key press to the raw (unformatted) amount string, e.g. "2500".
 * "000" is the GNF thousands key; for currencies with decimals the keypad
 * offers "dot" instead and the string may carry one separator.
 */
export function pressKey(raw: string, key: KeypadKey, currency: string): string {
  const decimals = minorUnits(currency);
  if (key === 'back') return raw.slice(0, -1);
  if (key === 'dot') {
    if (decimals === 0 || raw.includes('.')) return raw;
    return (raw === '' ? '0' : raw) + '.';
  }
  const digits = key === '000' ? '000' : key;
  let next = raw + digits;
  if (decimals > 0 && next.includes('.')) {
    const [, frac = ''] = next.split('.');
    if (frac.length > decimals) return raw;
  }
  // No leading zeros ("0" then "5" is "5"; "000" on empty stays empty).
  if (!next.includes('.')) next = next.replace(/^0+/, '');
  if (next.replace('.', '').length > MAX_DIGITS) return raw;
  return next;
}

/** Raw keypad string → number in display units (0 when empty). */
export function keypadValue(raw: string): number {
  if (!raw || raw === '.') return 0;
  const n = parseFloat(raw);
  return Number.isFinite(n) ? n : 0;
}

// ── Day / month grouping ─────────────────────────────────────────────────────

function isoOf(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** "Aujourd'hui", "Hier", else "5 oct. 2026". */
export function dayLabel(dateIso: string, now: Date = new Date()): string {
  const today = isoOf(now);
  const y = new Date(now);
  y.setDate(y.getDate() - 1);
  if (dateIso === today) return "Aujourd'hui";
  if (dateIso === isoOf(y)) return 'Hier';
  return formatDate(dateIso, 'short');
}

/** Only approved expenses count toward money totals (pending/rejected do not). */
export function sumApproved(items: Expense[]): number {
  return items.reduce((s, e) => (e.status === 'approuve' ? s + e.amount : s), 0);
}

export interface DayGroup { key: string; label: string; items: Expense[] }
export interface MonthGroup { key: string; label: string; total: number; days: DayGroup[] }

/** Newest month first, newest day first. `total` is a live sum over the rows. */
export function groupByMonthAndDay(expenses: Expense[], now: Date = new Date()): MonthGroup[] {
  const months = new Map<string, Map<string, Expense[]>>();
  for (const e of expenses) {
    const mKey = e.date.slice(0, 7);
    const days = months.get(mKey) ?? new Map<string, Expense[]>();
    const list = days.get(e.date) ?? [];
    list.push(e);
    days.set(e.date, list);
    months.set(mKey, days);
  }
  return Array.from(months.entries())
    .sort((a, b) => b[0].localeCompare(a[0]))
    .map(([key, days]) => {
      const dayGroups = Array.from(days.entries())
        .sort((a, b) => b[0].localeCompare(a[0]))
        .map(([dKey, items]) => ({
          key: dKey,
          label: dayLabel(dKey, now),
          items: [...items].sort((a, b) => b.created_at.localeCompare(a.created_at)),
        }));
      return {
        key,
        label: formatDate(`${key}-01`, 'monthYear'),
        total: dayGroups.reduce((s, d) => s + sumApproved(d.items), 0),
        days: dayGroups,
      };
    });
}

// ── Répéter (recent expenses) ────────────────────────────────────────────────

export interface RepeatTemplate {
  amount: number;
  product_id: string | null;
  product_name: string | null;
  note: string | null;
}

/** Up to `limit` distinct recent (amount, product/note) pairs, newest first. */
export function recentTemplates(expenses: Expense[], limit = 4): RepeatTemplate[] {
  const seen = new Set<string>();
  const out: RepeatTemplate[] = [];
  const newestFirst = [...expenses].sort((a, b) => b.created_at.localeCompare(a.created_at));
  for (const e of newestFirst) {
    const note = (e.note ?? '').trim() || null;
    const key = `${e.amount}|${e.product_id ?? ''}|${note ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ amount: e.amount, product_id: e.product_id ?? null, product_name: e.product_name ?? null, note });
    if (out.length >= limit) break;
  }
  return out;
}

// ── Product picker ───────────────────────────────────────────────────────────

/** Lowercase, accent-free, for forgiving search ("huile" finds "Huile d'arachide", "ete" finds "Été"). */
export function normalizeSearch(s: string): string {
  return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
}

/** Top `limit` matches, names starting with the query first. Empty query → []. */
export function searchProducts<T extends { id: string; name: string }>(products: T[], query: string, limit = 20): T[] {
  const q = normalizeSearch(query);
  if (!q) return [];
  const starts: T[] = [];
  const contains: T[] = [];
  for (const p of products) {
    const n = normalizeSearch(p.name);
    if (n.startsWith(q)) starts.push(p);
    else if (n.includes(q)) contains.push(p);
  }
  const byName = (a: T, b: T) => a.name.localeCompare(b.name, 'fr');
  return [...starts.sort(byName), ...contains.sort(byName)].slice(0, limit);
}

/** Product ids ranked by how often they are linked to a live expense. */
export function rankLinkedProducts(expenses: Expense[]): string[] {
  const counts = new Map<string, number>();
  for (const e of expenses) {
    if (e.product_id) counts.set(e.product_id, (counts.get(e.product_id) ?? 0) + 1);
  }
  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([id]) => id);
}

/**
 * "Récents" is PINNED: ids already shown keep their slot; a newcomer is appended
 * only when there is room or a pinned id has fallen out of the ranking entirely.
 * It never reshuffles just because counts moved.
 */
export function pinRecents(stored: string[], ranked: string[], limit = 6): string[] {
  const alive = new Set(ranked);
  const kept = stored.filter(id => alive.has(id)).slice(0, limit);
  for (const id of ranked) {
    if (kept.length >= limit) break;
    if (!kept.includes(id)) kept.push(id);
  }
  return kept;
}

/**
 * Whether the optional "Produit (facultatif)" row is shown in the expense sheet.
 * - products exist → shown as always;
 * - a product is already linked → shown, so its chip (and × to remove) stays
 *   even if that product was archived since;
 * - no active product and nothing linked → hidden (including while products
 *   are still loading: the row appears once a product exists, never a dead
 *   picker with nothing in it).
 */
export function showProductRow(o: {
  activeProductCount: number;
  productId: string | null;
  productsFetchedFor: string | null;
  businessId: string;
}): boolean {
  return o.activeProductCount > 0 || !!o.productId;
}
