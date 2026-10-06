// Decision logic for send-debt-reminders, dependency-injected so it runs
// under Jest (no Deno, no network). index.ts only wires Supabase + fetch in.
//
// The one rule this file exists to enforce: a digest is CONFIRMED (and its
// debts permanently marked fired) only when dispatch-notification's response
// BODY says a push was actually sent. HTTP 200 is not evidence — the
// dispatcher answers 200 for { skipped: 'not_built' | 'cap' | 'quiet_hours' }
// and for { sent: 0 } (no recipients / no device tokens). The old code marked
// on `resp.ok` alone and recorded reminders that never happened.

export interface DigestItem { sale_order_id: string; threshold_days: number }

export interface Digest {
  business_id: string;
  local_date: string;
  count_7d: number;
  count_30d: number;
  single_client_id: string | null;
  recipient_user_ids: string[];
  items: DigestItem[];
}

export interface DispatchRequest {
  business_id: string;
  event_type: 'debt_aging_reminder';
  // Counts only (+ an opaque client id when every due debt is one client's).
  // Never a debtor name, never an amount.
  payload: { count_7d: number; count_30d: number; client_id?: string };
  target_user_ids: string[];
}

export interface DispatchResult { ok: boolean; body: Record<string, unknown> | null }

export interface Deps {
  getDigests(nowIso: string | null): Promise<Digest[]>;
  confirm(d: Digest): Promise<boolean>;
  dispatch(req: DispatchRequest): Promise<DispatchResult>;
  sleep(ms: number): Promise<void>;
  nowIso?: string | null;
}

export interface RunSummary {
  due: number;
  sent: number;
  notSent: number; // dispatcher answered but nothing went out — left due, retried later
  failed: number;  // threw — left due, retried later
}

// A tight fetch loop trips Supabase's outbound rate limit (see
// migration_v202.sql's history); a flat gap keeps a normal batch under it.
export const THROTTLE_MS = 300;

export function wasSent(r: DispatchResult): boolean {
  if (!r.ok || !r.body) return false;
  if (r.body.skipped) return false;
  return typeof r.body.sent === 'number' && r.body.sent > 0;
}

export async function runDebtReminders(deps: Deps): Promise<RunSummary> {
  const digests = await deps.getDigests(deps.nowIso ?? null);
  const summary: RunSummary = { due: digests.length, sent: 0, notSent: 0, failed: 0 };

  for (const d of digests) {
    try {
      const req: DispatchRequest = {
        business_id: d.business_id,
        event_type: 'debt_aging_reminder',
        payload: {
          count_7d: d.count_7d,
          count_30d: d.count_30d,
          ...(d.single_client_id ? { client_id: d.single_client_id } : {}),
        },
        target_user_ids: d.recipient_user_ids,
      };
      const result = await deps.dispatch(req);
      if (wasSent(result)) {
        // The push is out — a failed confirm would re-send it next hour, so
        // try twice before giving up (then it counts as failed, loudly).
        try { await deps.confirm(d); } catch { await deps.confirm(d); }
        summary.sent++;
      } else {
        summary.notSent++;
      }
    } catch {
      // One digest's failure must never abort the batch; left unconfirmed it
      // is simply due again on the next run.
      summary.failed++;
    }
    await deps.sleep(THROTTLE_MS);
  }
  return summary;
}
