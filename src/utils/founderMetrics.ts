// Founder Dashboard — First Principles growth metrics.
//
// Pure, source-agnostic calculation module: everything here operates on a
// plain UserActivityRecord[] and has no Supabase/network dependency, so it's
// independently testable and reusable regardless of where the raw records
// come from. `src/components/FounderDashboard.tsx` is the only caller that
// wires this to real data (via the get_founder_activity_raw() RPC).

export type HealthStatus = 'green' | 'yellow' | 'red';

export interface UserActivityRecord {
  userId: string;
  /** ISO 8601 timestamp of account creation. */
  signupAt: string;
  /** ISO 8601 timestamps, one per transaction this user has logged, any order. */
  transactionTimestamps: string[];
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function isSameCalendarDay(a: Date, b: Date): boolean {
  return (
    a.getUTCFullYear() === b.getUTCFullYear() &&
    a.getUTCMonth() === b.getUTCMonth() &&
    a.getUTCDate() === b.getUTCDate()
  );
}

function transactionsOn(record: UserActivityRecord, day: Date): number {
  return record.transactionTimestamps.filter(t => isSameCalendarDay(new Date(t), day)).length;
}

// ─── 1. D7 Active Retention Rate ────────────────────────────────────────────
// Day-7 retention, evaluated per-user on their OWN day-7 date (signup + 7
// days), not a single shared calendar date. An earlier version required
// everyone in the cohort to have signed up on the exact same calendar day —
// mathematically the "textbook" Day-N definition, but at this app's real
// signup volume (0-2 sign-ups on most individual days) that single-day
// cohort is almost always empty, so the metric showed "--" on most days even
// with a large population of users who'd genuinely crossed day 7. Rolling
// windowDays forward instead means: take everyone whose day-7 has already
// arrived within the last windowDays days, check each against their own
// day-7 date. windowDays bounds the cohort to a "recent" retention read
// rather than blending in accounts from indefinitely far back — 90 is
// deliberately generous rather than a tight "last month" window: this app's
// oldest real user is currently ~89 days old, so 90 days covers effectively
// every eligible user today (verified against production: 99/99), giving
// full accuracy while the platform is this young. It will naturally start
// excluding old cohorts and become a genuine "recent" read on its own, with
// no further code change, once the app has more than ~90 days of history —
// don't shrink this preemptively, let real growth make it tighter.
// Returns null when nobody's day-7 falls in that window — there is no
// cohort to evaluate yet, not a 0%.
export function calculateD7Retention(
  records: UserActivityRecord[],
  referenceDate: Date = new Date(),
  windowDays: number = 90,
): number | null {
  const eligible = records
    .map(r => ({ record: r, day7: new Date(new Date(r.signupAt).getTime() + 7 * MS_PER_DAY) }))
    .filter(({ day7 }) =>
      day7.getTime() <= referenceDate.getTime() &&
      day7.getTime() >= referenceDate.getTime() - windowDays * MS_PER_DAY,
    );
  if (eligible.length === 0) return null;

  const retained = eligible.filter(({ record, day7 }) => transactionsOn(record, day7) > 0);
  return (retained.length / eligible.length) * 100;
}

// ─── 2. Daily Active Transacting Rate ───────────────────────────────────────
// (users who logged >=1 transaction on referenceDate) / (all users) * 100.
// `totalUsersOverride` lets a caller pass the true total registered-user
// count when `records` itself is a windowed subset (e.g. only recent
// signups) — without it, `records.length` is used, which is correct as long
// as the full user base was passed in.
export function calculateDailyActiveTransactingRate(
  records: UserActivityRecord[],
  referenceDate: Date = new Date(),
  totalUsersOverride?: number,
): number | null {
  const totalUsers = totalUsersOverride ?? records.length;
  if (totalUsers === 0) return null;
  const activeToday = records.filter(r => transactionsOn(r, referenceDate) > 0);
  return (activeToday.length / totalUsers) * 100;
}

// ─── 3. Time to First Record (TTFR) ─────────────────────────────────────────
// Average seconds from signup to each user's first-ever transaction, across
// every user who has converted at least once. Users with zero transactions
// are excluded (there is no "first transaction" to measure yet) rather than
// treated as an infinite/zero duration, which would distort the average.
export function calculateAverageTTFR(records: UserActivityRecord[]): number | null {
  const durations: number[] = [];

  for (const r of records) {
    if (r.transactionTimestamps.length === 0) continue;
    const firstTransactionMs = Math.min(...r.transactionTimestamps.map(t => new Date(t).getTime()));
    const seconds = (firstTransactionMs - new Date(r.signupAt).getTime()) / 1000;
    if (seconds >= 0) durations.push(seconds); // guards against bad data (transaction logged before signup)
  }

  if (durations.length === 0) return null;
  return durations.reduce((sum, s) => sum + s, 0) / durations.length;
}

// ─── 4. Average Transactions per Active User ────────────────────────────────
// (total transactions logged on referenceDate) / (distinct users active that
// day) — deliberately scoped to *active* users only, so a large inactive
// user base never dilutes this into a meaningless number.
export function calculateAvgTransactionsPerActiveUser(
  records: UserActivityRecord[],
  referenceDate: Date = new Date(),
): number | null {
  const activeToday = records.filter(r => transactionsOn(r, referenceDate) > 0);
  if (activeToday.length === 0) return null;

  const totalToday = activeToday.reduce((sum, r) => sum + transactionsOn(r, referenceDate), 0);
  return totalToday / activeToday.length;
}

// ─── Health status thresholds ───────────────────────────────────────────────
// TTFR is the one metric where *lower* is better — every other threshold
// function reads "higher is healthier."

export function getD7RetentionStatus(ratePct: number): HealthStatus {
  if (ratePct >= 30) return 'green';
  if (ratePct >= 15) return 'yellow';
  return 'red';
}

export function getDailyActiveTransactingStatus(ratePct: number): HealthStatus {
  if (ratePct >= 40) return 'green';
  if (ratePct >= 20) return 'yellow';
  return 'red';
}

export function getTTFRStatus(seconds: number): HealthStatus {
  if (seconds <= 30) return 'green';
  if (seconds <= 60) return 'yellow';
  return 'red';
}

export function getAvgTransactionsPerActiveUserStatus(count: number): HealthStatus {
  if (count >= 5) return 'green';
  if (count >= 2) return 'yellow';
  return 'red';
}

// ─── KPI assembly ────────────────────────────────────────────────────────────

export type FounderKpiKey =
  | 'd7Retention'
  | 'dailyActiveTransacting'
  | 'ttfr'
  | 'avgTransactionsPerActiveUser';

export interface FounderKpi {
  key: FounderKpiKey;
  label: string;
  /** Raw numeric value (% points, seconds, or a plain count) — null when there's not enough data to compute it. */
  value: number | null;
  /** Pre-formatted for display, including the "—" placeholder for null. */
  displayValue: string;
  /** null exactly when value is null — there's no health reading without a number. */
  status: HealthStatus | null;
}

// Rolls up to the largest unit that keeps the number readable — a raw
// minutes/seconds pair looked broken once the average crossed roughly an
// hour (e.g. "3985min 3s" for a ~2.8 day average), even though the math
// behind it was correct.
function formatTTFR(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const totalMinutes = Math.floor(seconds / 60);
  if (totalMinutes < 60) return `${totalMinutes}min ${Math.round(seconds % 60)}s`;
  const totalHours = Math.floor(totalMinutes / 60);
  if (totalHours < 24) return `${totalHours}h ${totalMinutes % 60}min`;
  const days = Math.floor(totalHours / 24);
  return `${days}j ${totalHours % 24}h`;
}

export function buildFounderKpis(
  records: UserActivityRecord[],
  referenceDate: Date = new Date(),
  totalUsersOverride?: number,
): FounderKpi[] {
  const d7 = calculateD7Retention(records, referenceDate);
  const dailyActive = calculateDailyActiveTransactingRate(records, referenceDate, totalUsersOverride);
  const ttfr = calculateAverageTTFR(records);
  const avgTx = calculateAvgTransactionsPerActiveUser(records, referenceDate);

  return [
    {
      key: 'd7Retention',
      label: 'Rétention D7',
      value: d7,
      displayValue: d7 === null ? '—' : `${d7.toFixed(1)}%`,
      status: d7 === null ? null : getD7RetentionStatus(d7),
    },
    {
      key: 'dailyActiveTransacting',
      label: 'Actifs transactionnels (jour)',
      value: dailyActive,
      displayValue: dailyActive === null ? '—' : `${dailyActive.toFixed(1)}%`,
      status: dailyActive === null ? null : getDailyActiveTransactingStatus(dailyActive),
    },
    {
      key: 'ttfr',
      label: 'Délai avant 1ère vente (TTFR)',
      value: ttfr,
      displayValue: ttfr === null ? '—' : formatTTFR(ttfr),
      status: ttfr === null ? null : getTTFRStatus(ttfr),
    },
    {
      key: 'avgTransactionsPerActiveUser',
      label: 'Ventes / utilisateur actif',
      value: avgTx,
      displayValue: avgTx === null ? '—' : avgTx.toFixed(1),
      status: avgTx === null ? null : getAvgTransactionsPerActiveUserStatus(avgTx),
    },
  ];
}
