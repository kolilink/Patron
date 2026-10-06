import * as fs from 'fs';
import * as path from 'path';
import {
  FOUNDER_CARDS,
  activationCard,
  commercesActifsCard,
  countTrend,
  parrainageCard,
  prospectionCard,
  rateTrend,
  retentionCard,
  type FounderKpis,
} from '@/src/utils/founderKpis';

function kpis(over: Partial<FounderKpis> = {}): FounderKpis {
  return {
    north_star: { weekly: [12, 9, 8, 7, 6, 5, 4, 3], total_real_businesses: 60, excluded_test: 3 },
    funnel: {
      installed: 0, otp_sent: 0, otp_verified: 0, commerce: 0, first_value: 0,
      median_s: { install_to_otp_sent: null, otp_sent_to_verified: null, verified_to_commerce: null, commerce_to_first_value: null },
      ttfv_install_median_s: null, ttfv_install_n: 0, devices_all_time: 0,
    },
    activation: {
      cohort: 20, activated: 10, ttfv_commerce_median_s: 600, ttfv_commerce_n: 10, ttfv_under_24h: 8,
      u24_cohort: 20, u24_hit: 14, u24_prev_cohort: 10, u24_prev_hit: 5,
    },
    retention: {
      w1_cohort: 30, w1_retained: 12, w4_cohort: 20, w4_retained: 4,
      w1_recent_cohort: 10, w1_recent_retained: 6, w1_prev_cohort: 10, w1_prev_retained: 3,
      w4_recent_cohort: 8, w4_recent_retained: 2, w4_prev_cohort: 8, w4_prev_retained: 2,
      lost_count: 7,
    },
    referral: {
      active_30d: 0, sharing_30d: 0, invites_created_30d: 0, invites_used_30d: 0, referred_signups_30d: 0,
      referred_n: 0, referred_activated: 0, organic_n: 0, organic_activated: 0,
      invite_installs_total: 9, invite_installs_30d: 4, invite_installs_prev_30d: 1,
    },
    outreach: { this_week: 5, prev_week: 2, total: 20 },
    ...over,
  };
}

describe('the five founder cards', () => {
  it('exactly five cards, in this order', () => {
    expect([...FOUNDER_CARDS]).toEqual(['commerces_actifs', 'retention', 'activation', 'parrainage', 'prospection']);
  });

  it('the killed cards are gone from the screen source', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src/components/FounderDashboard.tsx'), 'utf8');
    for (const killed of [
      'TTFV', 'Taux de partage', 'K-factor', 'Qualité des parrainés', 'Conversion des invitations',
      'Création → 1ʳᵉ valeur', 'Activation + TTFV', 'Frein actuel', 'Appels WhatsApp', '.toUpperCase()',
    ]) {
      expect(src).not.toContain(killed);
    }
    // the kept ones are present
    for (const kept of ['Commerces actifs cette semaine', 'Les commerces reviennent-ils', 'Premier usage dans les 24 h', 'Parrainage', 'Prospection', 'Voir les']) {
      expect(src + fs.readFileSync(path.join(__dirname, '..', 'src/utils/founderKpis.ts'), 'utf8')).toContain(kept);
    }
  });

  it('every card ships an action sentence ("so what do I do?")', () => {
    const k = kpis();
    for (const hint of [commercesActifsCard(k).hint, retentionCard(k).hint, activationCard(k).hint, parrainageCard(k, null).hint, prospectionCard(k).hint]) {
      expect(hint.length).toBeGreaterThan(20);
    }
  });
});

describe('Commerces actifs', () => {
  it('shows the current week, the delta, the 8 bars and the real-business denominator with the exclusion count', () => {
    const c = commercesActifsCard(kpis());
    expect(c.current).toBe(12);
    expect(c.trend).toEqual({ dir: 'up', label: '+3 vs la semaine précédente' });
    expect(c.bars).toHaveLength(8);
    expect(c.denominator).toBe(60);
    expect(c.caption).toBe('sur 60 commerces réels · 3 comptes test exclus');
  });

  it('survives a server that predates migration_v238 (no excluded_test)', () => {
    const k = kpis();
    delete k.north_star.excluded_test;
    expect(commercesActifsCard(k).caption).toBe('sur 60 commerces réels');
  });
});

describe('trends', () => {
  it('countTrend: no previous period → no trend; equal → stable; down uses a minus sign', () => {
    expect(countTrend(3, null, 'x')).toBeNull();
    expect(countTrend(3, 3, 'x')!.dir).toBe('flat');
    expect(countTrend(1, 4, 'x')).toEqual({ dir: 'down', label: '−3 vs x' });
  });

  it('rateTrend refuses to draw a trend from fewer than 5 units on either side', () => {
    expect(rateTrend({ hit: 3, n: 4 }, { hit: 1, n: 10 }, 'x')).toBeNull();
    expect(rateTrend({ hit: 3, n: 10 }, { hit: 1, n: 4 }, 'x')).toBeNull();
    expect(rateTrend({ hit: 7, n: 10 }, { hit: 5, n: 10 }, 'x')).toEqual({ dir: 'up', label: '+20 pts vs x' });
  });
});

describe('Rétention', () => {
  it('has Semaine 1 and Semaine 4 with their visé targets and a lost-vendors link carrying the count', () => {
    const c = retentionCard(kpis());
    expect(c.rows.map(r => r.label)).toEqual(['Semaine 1', 'Semaine 4']);
    expect(c.rows[0].caption).toBe('12 sur 30 · visé 60 %');
    expect(c.rows[1].caption).toBe('4 sur 20 · visé 40 %');
    expect(c.rows[0].trend!.dir).toBe('up');
    expect(c.lostLabel).toBe('Voir les 7 commerces perdus');
  });

  it('singular and zero wording of the lost link', () => {
    expect(retentionCard(kpis({ retention: { ...kpis().retention, lost_count: 1 } })).lostLabel).toBe('Voir les 1 commerce perdu');
    expect(retentionCard(kpis({ retention: { ...kpis().retention, lost_count: 0 } })).lostLabel).toBe('Voir les commerces perdus');
  });
});

describe('Activation', () => {
  it('is ONE number: the share reaching first value in under 24 h, with a trend', () => {
    const c = activationCard(kpis());
    expect(c.pct).toBe(70);
    expect(c.trend).toEqual({ dir: 'up', label: '+20 pts vs les 30 jours d\'avant' });
    expect(c.caption).toContain('14 sur 20');
  });

  it('is "—" (null), never a fake 0 %, with an empty cohort', () => {
    const k = kpis();
    k.activation.u24_cohort = 0; k.activation.u24_hit = 0;
    expect(activationCard(k).pct).toBeNull();
  });
});

describe('Parrainage', () => {
  it('is one number — installs par invitation — with the iOS caveat caption', () => {
    const c = parrainageCard(kpis(), null);
    expect(c.installs).toBe(9);
    expect(c.caption).toContain('iOS sous-compté');
    expect(c.trend).toEqual({ dir: 'up', label: '+3 vs les 30 jours d\'avant' });
  });

  it('falls back to get_founder_invite_installs() on a pre-v238 server', () => {
    const k = kpis();
    delete k.referral.invite_installs_total; delete k.referral.invite_installs_30d;
    const c = parrainageCard(k, 5);
    expect(c.installs).toBe(5);
    expect(c.trend).toBeNull();
  });
});

describe('Prospection', () => {
  it('shows contacts this week vs last week', () => {
    const c = prospectionCard(kpis());
    expect(c.thisWeek).toBe(5);
    expect(c.caption).toBe('vendeurs contactés cette semaine');
    expect(c.trend).toEqual({ dir: 'up', label: '+3 vs la semaine dernière' });
  });
  it('is zero (not missing) before any contact is logged, and before the migration', () => {
    const k = kpis(); delete k.outreach;
    expect(prospectionCard(k).thisWeek).toBe(0);
  });
});
