// Growth Dashboard — benchmarks + single-constraint identification.
//
// Pure, source-agnostic module (same split this codebase already used for
// the old founderMetrics.ts): everything here takes plain numbers and
// returns a status or a sentence, no Supabase dependency, independently
// testable. src/components/FounderDashboard.tsx is the only caller — it
// fetches get_founder_growth_stats() (db/migration_v174.sql/v175.sql) and
// hands the 5 numbers to this module for both the card colors and the
// one-sentence "what's the constraint" summary.

export type HealthStatus = 'green' | 'yellow' | 'red';

interface Benchmark {
  /** value >= green → 'green' */
  green: number;
  /** green > value >= red → 'yellow'; value < red → 'red' */
  red: number;
}

// Activation + Week 1 retention benchmarks are cited external SaaS/PLG
// figures, not invented: median SaaS activation is ~17%, top-quartile B2B
// SaaS reaches 40%+ within 7 days (median range 20-35%); first-week
// retention targets are 60%+ for business applications specifically (vs.
// 40%+ for consumer apps) — Patron is unambiguously a business application.
// Month-1/Week-4 retention uses the ~48% PLG-average figure, rounded down
// to a still-aspirational-but-reachable 40%, since a single cohort's week-4
// number is naturally lower than a mature product's blended average.
export const ACTIVATION_BENCHMARK: Benchmark = { green: 40, red: 20 };
export const WEEK1_RETENTION_BENCHMARK: Benchmark = { green: 60, red: 30 };
export const WEEK4_RETENTION_BENCHMARK: Benchmark = { green: 40, red: 20 };

// No external citation for this one — "weekly transacting shops as a share
// of every real business ever created" isn't a standard named metric.
// Reasoned directly from the other three: it's roughly their product
// integrated over time, so a healthy value should land meaningfully below
// activation but well above either retention figure alone. Treated as a
// rate (not a raw count) specifically so this benchmark doesn't go stale
// as the total business count grows — a fixed absolute-count bar would
// need re-tuning by hand every time the platform doubles in size.
export const NORTH_STAR_RATE_BENCHMARK: Benchmark = { green: 25, red: 10 };

export function getHealthStatus(value: number | null, benchmark: Benchmark): HealthStatus | null {
  if (value === null) return null;
  if (value >= benchmark.green) return 'green';
  if (value < benchmark.red) return 'red';
  return 'yellow';
}

export interface GrowthStats {
  activationRatePct: number | null;
  week1RetentionPct: number | null;
  week4RetentionPct: number | null;
  weeklyTransactingShops: number;
  totalRealBusinesses: number;
}

function fmt(n: number): string {
  return `${n.toFixed(1)}%`;
}

// Theory-of-constraints identification: walk the funnel in causal order
// (activation → week 1 → week 4) and name the FIRST stage that's below its
// own green benchmark, rather than whichever stage has the numerically
// lowest ratio. A downstream stage can look "worse" in isolation purely
// because it inherits an upstream shortfall — fixing week 4 retention
// before week 1 retention is fixed doesn't make sense as an intervention,
// since week-4-retained businesses are a subset of week-1-retained ones.
// The North Star (weekly transacting shops) is deliberately excluded from
// this comparison — it's the outcome the other three drive, not a lever of
// its own, so naming it as "the constraint" would just restate the symptom.
export function identifyConstraint(stats: GrowthStats): string {
  const { activationRatePct, week1RetentionPct, week4RetentionPct, weeklyTransactingShops } = stats;

  if (activationRatePct === null) {
    return 'Pas encore assez de nouveaux commerces ce mois-ci pour identifier un frein clair.';
  }

  if (activationRatePct < ACTIVATION_BENCHMARK.green) {
    return `Le frein actuel de Patron : l'activation (${fmt(activationRatePct)} contre ${ACTIVATION_BENCHMARK.green}%+ visé) — sans plus de commerces qui démarrent vraiment, les autres leviers ne peuvent pas s'exprimer ; combler cet écart est ce qui ferait le plus progresser les commerces actifs chaque semaine (actuellement ${weeklyTransactingShops}).`;
  }

  if (week1RetentionPct === null) {
    return `L'activation est solide (${fmt(activationRatePct)}), mais pas encore assez de commerces activés ont atteint une semaine d'ancienneté pour mesurer la rétention.`;
  }

  if (week1RetentionPct < WEEK1_RETENTION_BENCHMARK.green) {
    return `Le frein actuel de Patron : la Rétention Semaine 1 (${fmt(week1RetentionPct)} contre ${WEEK1_RETENTION_BENCHMARK.green}%+ visé) — l'activation est déjà solide (${fmt(activationRatePct)}), donc combler cet écart est le levier le plus puissant pour faire progresser les commerces actifs chaque semaine (actuellement ${weeklyTransactingShops}).`;
  }

  if (week4RetentionPct === null) {
    return `L'activation (${fmt(activationRatePct)}) et la Rétention Semaine 1 (${fmt(week1RetentionPct)}) sont solides, mais pas encore assez de commerces ont atteint 4 semaines pour mesurer la suite.`;
  }

  if (week4RetentionPct < WEEK4_RETENTION_BENCHMARK.green) {
    return `Le frein actuel de Patron : la Rétention Semaine 4 (${fmt(week4RetentionPct)} contre ${WEEK4_RETENTION_BENCHMARK.green}%+ visé) — l'activation (${fmt(activationRatePct)}) et la Semaine 1 (${fmt(week1RetentionPct)}) sont déjà solides, donc combler cet écart est le levier le plus puissant pour faire progresser les commerces actifs chaque semaine (actuellement ${weeklyTransactingShops}).`;
  }

  return `Aucun frein majeur détecté : activation (${fmt(activationRatePct)}), Semaine 1 (${fmt(week1RetentionPct)}) et Semaine 4 (${fmt(week4RetentionPct)}) sont toutes au niveau visé — le prochain levier est simplement plus de nouveaux commerces.`;
}
