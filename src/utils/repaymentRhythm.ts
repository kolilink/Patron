// A client's repayment rhythm — a fact, not a verdict: the median number of
// days it took them to settle the debts they have FULLY repaid. Outstanding
// debts are never timed (a race not finished has no finishing time), and a
// debt whose settlement date cannot be known is left out rather than guessed.

export interface RhythmSale {
  id: string;
  status: string;
  is_credit?: boolean;
  total_amount: number;
  discount_amount?: number | null;
  sale_date?: string | null;
  created_at: string;
  paid_at?: string | null;
}
export interface RhythmPayment { order_id: string; date?: string | null; created_at?: string | null }

export interface RepaymentRhythm { medianDays: number; settledCount: number }

const DAY_MS = 86_400_000;

// 'YYYY-MM-DD' or an ISO timestamp -> a local-calendar day number.
function dayNumber(value: string | null | undefined): number | null {
  if (!value) return null;
  const plain = /^\d{4}-\d{2}-\d{2}$/.test(value);
  const d = plain ? new Date(value + 'T00:00:00') : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return Math.floor(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / DAY_MS);
}

export function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export function repaymentRhythm(sales: RhythmSale[], payments: RhythmPayment[]): RepaymentRhythm | null {
  const days: number[] = [];
  for (const s of sales) {
    // Fully repaid debts only: a credit sale whose balance has reached zero.
    if (!s.is_credit || s.status !== 'paye') continue;
    if (s.total_amount - (s.discount_amount ?? 0) <= 0) continue;

    const start = dayNumber(s.sale_date ?? s.created_at);
    let end = dayNumber(s.paid_at);
    if (end == null) {
      // No paid_at: fall back to the last payment recorded against this debt.
      for (const p of payments) {
        if (p.order_id !== s.id) continue;
        const d = dayNumber(p.date ?? p.created_at);
        if (d != null && (end == null || d > end)) end = d;
      }
    }
    if (start == null || end == null) continue; // unknowable: never guess
    days.push(Math.max(0, end - start));
  }
  if (days.length === 0) return null;
  return { medianDays: Math.round(median(days)), settledCount: days.length };
}

export function rhythmLabel(r: RepaymentRhythm): { main: string; sub: string } {
  const n = r.medianDays;
  return {
    main: n === 0 ? 'En général, soldé le jour même' : `En général, soldé en ${n} ${n === 1 ? 'jour' : 'jours'}`,
    sub: `(${r.settledCount} ${r.settledCount === 1 ? 'crédit soldé' : 'crédits soldés'})`,
  };
}
