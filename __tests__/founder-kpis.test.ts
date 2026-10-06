import {
  funnelSteps,
  identifyBottleneck,
  northStar,
  referral,
  formatDuration,
  pct,
  type FounderKpis,
} from '@/src/utils/founderKpis';

function kpis(overrides: Partial<{
  funnel: Partial<FounderKpis['funnel']>;
  activation: Partial<FounderKpis['activation']>;
  retention: Partial<FounderKpis['retention']>;
  referral: Partial<FounderKpis['referral']>;
  north_star: Partial<FounderKpis['north_star']>;
}> = {}): FounderKpis {
  return {
    north_star: { weekly: [10, 8, 7, 6, 5, 4, 3, 2], total_real_businesses: 40, ...overrides.north_star },
    funnel: {
      installed: 0, otp_sent: 0, otp_verified: 0, commerce: 0, first_value: 0,
      median_s: { install_to_otp_sent: null, otp_sent_to_verified: null, verified_to_commerce: null, commerce_to_first_value: null },
      ttfv_install_median_s: null, ttfv_install_n: 0, devices_all_time: 0,
      ...overrides.funnel,
    },
    activation: { cohort: 0, activated: 0, ttfv_commerce_median_s: null, ttfv_commerce_n: 0, ttfv_under_24h: 0, ...overrides.activation },
    retention: { w1_cohort: 0, w1_retained: 0, w4_cohort: 0, w4_retained: 0, ...overrides.retention },
    referral: {
      active_30d: 0, sharing_30d: 0, invites_created_30d: 0, invites_used_30d: 0, referred_signups_30d: 0,
      referred_n: 0, referred_activated: 0, organic_n: 0, organic_activated: 0,
      ...overrides.referral,
    },
  };
}

describe('pct', () => {
  it('returns null, never 0, when there is nothing to divide by', () => {
    expect(pct(0, 0)).toBeNull();
    expect(pct(1, 4)).toBe(25);
  });
});

describe('northStar', () => {
  it('reads index 0 as the current week and gives an oldest→newest trend', () => {
    const ns = northStar({ weekly: [10, 8, 1, 1, 1, 1, 1, 2], total_real_businesses: 40 });
    expect(ns.current).toBe(10);
    expect(ns.delta).toBe(2);
    expect(ns.trend[ns.trend.length - 1]).toBe(10);
    expect(ns.trend[0]).toBe(2);
    expect(ns.ratePct).toBe(25);
  });

  it('has no delta when there is only one week', () => {
    expect(northStar({ weekly: [3], total_real_businesses: 0 }).delta).toBeNull();
    expect(northStar({ weekly: [3], total_real_businesses: 0 }).ratePct).toBeNull();
  });
});

describe('funnelSteps', () => {
  it('computes each conversion against the previous step', () => {
    const steps = funnelSteps(kpis({ funnel: { installed: 20, otp_sent: 10, otp_verified: 8, commerce: 4, first_value: 2 } }).funnel);
    expect(steps.map(s => s.conversionPct)).toEqual([null, 50, 80, 50, 50]);
  });

  it('never divides by an empty step', () => {
    const steps = funnelSteps(kpis().funnel);
    expect(steps.every(s => s.conversionPct === null)).toBe(true);
  });
});

describe('referral four numbers', () => {
  it('share rate, K-factor and referred quality', () => {
    const r = referral(kpis({ referral: {
      active_30d: 20, sharing_30d: 4, invites_created_30d: 10, invites_used_30d: 3, referred_signups_30d: 3,
      referred_n: 3, referred_activated: 3, organic_n: 10, organic_activated: 4,
    } }).referral);
    expect(r.shareRatePct).toBe(20);
    expect(r).not.toHaveProperty('conversionPct');
    expect(r.kFactor).toBeCloseTo(0.15);
    expect(r.referredActivationPct).toBe(100);
    expect(r.organicActivationPct).toBe(40);
  });
});

describe('identifyBottleneck (frein actuel)', () => {
  it('says there is not enough data, with an action, when no stage has 5+ units', () => {
    const b = identifyBottleneck(kpis({ activation: { cohort: 3, activated: 0 } }));
    expect(b.key).toBeNull();
    expect(b.sentence).toMatch(/Prochaine action/);
  });

  it('picks the biggest gap × leverage, not just the lowest number', () => {
    // activation: 30% vs 40% → gap 0.25 × 1.0 = 0.25
    // share rate: 10% vs 20% → gap 0.5 × 0.5 = 0.25 … tie-breaker needs a clear winner:
    // week1: 15% vs 60% → gap 0.75 × 0.9 = 0.675  ← biggest
    const b = identifyBottleneck(kpis({
      activation: { cohort: 10, activated: 3 },
      retention: { w1_cohort: 20, w1_retained: 3 },
      referral: { active_30d: 10, sharing_30d: 1 },
    }));
    expect(b.key).toBe('week1');
    expect(b.sentence).toMatch(/Semaine 1/);
    expect(b.sentence).toMatch(/Entretien/);
  });

  it('ignores a terrible stage with too few units to mean anything', () => {
    const b = identifyBottleneck(kpis({
      activation: { cohort: 10, activated: 3 },     // 30%, eligible
      retention: { w1_cohort: 2, w1_retained: 0 },  // 0% but n=2
    }));
    expect(b.key).toBe('activation');
  });

  it('reports no major brake when every measured stage hits its target', () => {
    const b = identifyBottleneck(kpis({
      activation: { cohort: 10, activated: 6 },
      retention: { w1_cohort: 10, w1_retained: 7, w4_cohort: 10, w4_retained: 5 },
    }));
    expect(b.key).toBeNull();
    expect(b.sentence).toMatch(/Aucun frein majeur/);
  });
});

describe('formatDuration', () => {
  it('rolls up into the largest sensible unit', () => {
    expect(formatDuration(null)).toBe('—');
    expect(formatDuration(42)).toBe('42 s');
    expect(formatDuration(300)).toBe('5 min');
    expect(formatDuration(7200)).toBe('2 h');
    expect(formatDuration(3 * 86400)).toBe('3 j');
  });
});
