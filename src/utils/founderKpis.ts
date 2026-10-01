// Pure logic for the founder KPI screen (FounderDashboard.tsx): the shape
// get_founder_kpis() returns (db/migration_v209.sql), the numbers derived
// from it, and the "frein actuel" rule. No network, no React — unit-tested
// in __tests__/founder-kpis.test.ts.
//
// Every count here already excludes is_test traffic server-side; this file
// never has to filter anything.

export type HealthStatus = 'green' | 'yellow' | 'red';

export interface FounderKpis {
  north_star: { weekly: number[]; total_real_businesses: number };
  funnel: {
    installed: number;
    otp_sent: number;
    otp_verified: number;
    commerce: number;
    first_value: number;
    median_s: {
      install_to_otp_sent: number | null;
      otp_sent_to_verified: number | null;
      verified_to_commerce: number | null;
      commerce_to_first_value: number | null;
    };
    ttfv_install_median_s: number | null;
    ttfv_install_n: number;
    devices_all_time: number;
  };
  activation: {
    cohort: number;
    activated: number;
    ttfv_commerce_median_s: number | null;
    ttfv_commerce_n: number;
    ttfv_under_24h: number;
  };
  retention: { w1_cohort: number; w1_retained: number; w4_cohort: number; w4_retained: number };
  referral: {
    active_30d: number;
    sharing_30d: number;
    invites_created_30d: number;
    invites_used_30d: number;
    referred_signups_30d: number;
    referred_n: number;
    referred_activated: number;
    organic_n: number;
    organic_activated: number;
  };
}

export interface CallListRow {
  business_id: string;
  business_name: string | null;
  owner_name: string | null;
  owner_phone: string | null;
  created_at: string;
  first_value_at: string | null;
  last_action_at: string | null;
  actions_7d: number;
  active_days_7d: number;
}

export interface CallLists {
  welcome: CallListRow[];
  interview: CallListRow[];
  referral: CallListRow[];
}

/** Percentage, or null when the denominator is 0 (never a fake 0%). */
export function pct(numerator: number, denominator: number): number | null {
  return denominator > 0 ? (numerator / denominator) * 100 : null;
}

// ─── Targets ("visé") ─────────────────────────────────────────────────────
//
// Directional at n<100 (spec §2): trends over absolutes. W1 60% is the
// world-class stretch the spec asks to keep. Each also carries a leverage
// weight — how much moving that stage moves the North Star — which the
// frein rule multiplies the gap by. Earlier funnel stages and the first
// week weigh most: everything downstream is capped by them.
export interface Target {
  /** ≥ green → green */
  green: number;
  /** < red → red, between → yellow */
  red: number;
  leverage: number;
}

export const TARGETS = {
  installToVerified:  { green: 60, red: 30, leverage: 0.8 },
  verifiedToCommerce: { green: 80, red: 50, leverage: 0.9 },
  activation:         { green: 40, red: 20, leverage: 1.0 },
  ttfvUnder24h:       { green: 80, red: 50, leverage: 0.6 },
  week1:              { green: 60, red: 30, leverage: 0.9 },
  week4:              { green: 40, red: 20, leverage: 0.7 },
  shareRate:          { green: 20, red: 5,  leverage: 0.5 },
  referralConversion: { green: 30, red: 10, leverage: 0.5 },
  northStarRate:      { green: 25, red: 10, leverage: 0 },
} satisfies Record<string, Target>;

/** Below this many units, a rate is noise — never name it the frein. */
export const MIN_SAMPLE = 5;

export function getHealthStatus(value: number | null, target: Pick<Target, 'green' | 'red'>): HealthStatus | null {
  if (value === null) return null;
  if (value >= target.green) return 'green';
  if (value < target.red) return 'red';
  return 'yellow';
}

// ─── Derived numbers ──────────────────────────────────────────────────────

export interface FunnelStep {
  key: 'installed' | 'otp_sent' | 'otp_verified' | 'commerce' | 'first_value';
  label: string;
  count: number;
  /** % of the previous step; null for the first step or an empty previous step */
  conversionPct: number | null;
  /** median seconds from the previous step */
  medianFromPreviousS: number | null;
}

export function funnelSteps(f: FounderKpis['funnel']): FunnelStep[] {
  const rows: Array<Omit<FunnelStep, 'conversionPct'>> = [
    { key: 'installed',    label: 'Installé',           count: f.installed,    medianFromPreviousS: null },
    { key: 'otp_sent',     label: 'Code envoyé',        count: f.otp_sent,     medianFromPreviousS: f.median_s.install_to_otp_sent },
    { key: 'otp_verified', label: 'Code vérifié',       count: f.otp_verified, medianFromPreviousS: f.median_s.otp_sent_to_verified },
    { key: 'commerce',     label: 'Commerce créé',      count: f.commerce,     medianFromPreviousS: f.median_s.verified_to_commerce },
    { key: 'first_value',  label: '1ʳᵉ vente ou dette', count: f.first_value,  medianFromPreviousS: f.median_s.commerce_to_first_value },
  ];
  return rows.map((r, i) => ({
    ...r,
    conversionPct: i === 0 ? null : pct(r.count, rows[i - 1].count),
  }));
}

export interface NorthStar {
  current: number;
  previous: number | null;
  /** current − previous, null when there's no previous week */
  delta: number | null;
  /** oldest → newest, for the mini trend */
  trend: number[];
  ratePct: number | null;
}

export function northStar(n: FounderKpis['north_star']): NorthStar {
  const weekly = n.weekly ?? [];
  const current = weekly[0] ?? 0;
  const previous = weekly.length > 1 ? weekly[1] : null;
  return {
    current,
    previous,
    delta: previous === null ? null : current - previous,
    trend: [...weekly].reverse(),
    ratePct: pct(current, n.total_real_businesses),
  };
}

export interface Referral {
  shareRatePct: number | null;
  conversionPct: number | null;
  /** referred sign-ups per active business — i × c */
  kFactor: number | null;
  referredActivationPct: number | null;
  organicActivationPct: number | null;
}

export function referral(r: FounderKpis['referral']): Referral {
  return {
    shareRatePct: pct(r.sharing_30d, r.active_30d),
    conversionPct: pct(r.invites_used_30d, r.invites_created_30d),
    kFactor: r.active_30d > 0 ? r.referred_signups_30d / r.active_30d : null,
    referredActivationPct: pct(r.referred_activated, r.referred_n),
    organicActivationPct: pct(r.organic_activated, r.organic_n),
  };
}

// ─── Frein actuel ─────────────────────────────────────────────────────────

interface Candidate {
  key: keyof typeof TARGETS;
  label: string;
  valuePct: number | null;
  n: number;
  action: string;
}

function candidates(k: FounderKpis): Candidate[] {
  const ref = referral(k.referral);
  return [
    {
      key: 'installToVerified',
      label: 'installation → code vérifié',
      valuePct: pct(k.funnel.otp_verified, k.funnel.installed),
      n: k.funnel.installed,
      action: "revoir l'écran d'inscription et la réception du code WhatsApp : c'est là que les nouveaux installés décrochent.",
    },
    {
      key: 'verifiedToCommerce',
      label: 'code vérifié → commerce créé',
      valuePct: pct(k.funnel.commerce, k.funnel.otp_verified),
      n: k.funnel.otp_verified,
      action: "appeler la liste « Bienvenue » : ils ont validé leur code mais n'ont pas ouvert leur commerce.",
    },
    {
      key: 'activation',
      label: "l'activation (1ʳᵉ vente ou dette, 30 j)",
      valuePct: pct(k.activation.activated, k.activation.cohort),
      n: k.activation.cohort,
      action: 'appeler chaque commerce de la liste « Bienvenue » et noter sa première vente ou dette au téléphone avec lui.',
    },
    {
      key: 'ttfvUnder24h',
      label: '1ʳᵉ valeur en moins de 24 h',
      valuePct: pct(k.activation.ttfv_under_24h, k.activation.ttfv_commerce_n),
      n: k.activation.ttfv_commerce_n,
      action: "réduire le chemin jusqu'à la première dette : « Qui vous doit de l'argent ? » doit être la toute première chose faite.",
    },
    {
      key: 'week1',
      label: 'la rétention Semaine 1',
      valuePct: pct(k.retention.w1_retained, k.retention.w1_cohort),
      n: k.retention.w1_cohort,
      action: 'appeler la liste « Entretien » : demander à chaque commerce silencieux pourquoi il ne revient pas, et noter ses mots exacts.',
    },
    {
      key: 'week4',
      label: 'la rétention Semaine 4',
      valuePct: pct(k.retention.w4_retained, k.retention.w4_cohort),
      n: k.retention.w4_cohort,
      action: "appeler la liste « Entretien » : comprendre ce qui fait décrocher après le premier mois.",
    },
    {
      key: 'shareRate',
      label: 'le taux de partage',
      valuePct: ref.shareRatePct,
      n: k.referral.active_30d,
      action: 'appeler la liste « Parrainage » et demander à chaque commerce très actif d\'inviter un ami commerçant.',
    },
    {
      key: 'referralConversion',
      label: 'la conversion des invitations',
      valuePct: ref.conversionPct,
      n: k.referral.invites_created_30d,
      action: "tester le lien d'invitation de bout en bout sur un téléphone neuf : les invitations partent mais ne convertissent pas.",
    },
  ];
}

export interface Bottleneck {
  key: keyof typeof TARGETS | null;
  sentence: string;
}

function fmtPct(v: number): string {
  return `${v.toFixed(0)} %`;
}

/**
 * The current bottleneck: the stage with the biggest (relative gap to its
 * target) × leverage, among stages with at least MIN_SAMPLE units. One
 * paragraph, one next action.
 */
export function identifyBottleneck(k: FounderKpis): Bottleneck {
  const eligible = candidates(k).filter(c => c.valuePct !== null && c.n >= MIN_SAMPLE);

  if (eligible.length === 0) {
    return {
      key: null,
      sentence: "Pas encore assez de données pour nommer un frein (moins de 5 commerces à chaque étape). Prochaine action : appeler chaque commerce de la liste « Bienvenue » — à cette taille, chaque conversation compte plus qu'un chiffre.",
    };
  }

  let best: { c: Candidate; score: number } | null = null;
  for (const c of eligible) {
    const target = TARGETS[c.key];
    const gap = Math.max(0, (target.green - (c.valuePct as number)) / target.green);
    const score = gap * target.leverage;
    if (score > 0 && (best === null || score > best.score)) best = { c, score };
  }

  if (best === null) {
    return {
      key: null,
      sentence: 'Aucun frein majeur : chaque étape mesurée atteint sa cible. Prochaine action : plus de nouveaux commerces — appeler la liste « Parrainage ».',
    };
  }

  const { c } = best;
  const target = TARGETS[c.key];
  return {
    key: c.key,
    sentence: `Le frein actuel : ${c.label} — ${fmtPct(c.valuePct as number)} contre ${target.green} % visé (sur ${c.n}). Prochaine action : ${c.action}`,
  };
}

// ─── Formatting ───────────────────────────────────────────────────────────

export function formatDuration(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds)) return '—';
  const s = Math.max(0, seconds);
  if (s < 60) return `${Math.round(s)} s`;
  if (s < 3600) return `${Math.round(s / 60)} min`;
  if (s < 86400) return `${Math.round(s / 3600)} h`;
  return `${Math.round(s / 86400)} j`;
}

export function formatPct(value: number | null): string {
  return value === null ? '—' : `${value.toFixed(0)} %`;
}
