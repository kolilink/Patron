import {
  careMessage,
  contactRows,
  dueStep,
  shopNumber,
  todayCount,
  type CareContact,
  type CareStep,
} from '@/src/utils/founderCare';
import type { DirectoryRow } from '@/src/utils/founderDirectory';

const DAY = 86400000;
const NOW = new Date('2026-10-17T09:00:00Z').getTime();
const ago = (days: number) => new Date(NOW - days * DAY).toISOString();

function row(over: Partial<DirectoryRow> = {}): DirectoryRow {
  return {
    business_id: 'b1',
    business_name: 'Boutique Aminata',
    owner_name: 'Aminata Camara',
    owner_phone: '+224600000001',
    created_at: ago(0),
    first_value_at: null,
    last_action_at: null,
    actions_7d: 0,
    lost: false,
    ...over,
  };
}
const c = (step: CareStep, daysAgo: number): CareContact => ({ step, contacted_at: ago(daysAgo) });

describe('dueStep', () => {
  it('j0 is due for an uncontacted vendor whatever her age', () => {
    for (const age of [0, 1, 7, 30, 200]) {
      expect(dueStep(row({ created_at: ago(age) }), [], NOW)).toBe('j0');
    }
  });

  it('j1 waits for one day of age and for j0', () => {
    expect(dueStep(row({ created_at: ago(0.5) }), [c('j0', 0.1)], NOW)).toBeNull();
    expect(dueStep(row({ created_at: ago(1) }), [c('j0', 0.1)], NOW)).toBe('j1');
  });

  it('j7 waits for seven days of age and for j1', () => {
    const j0j1 = [c('j0', 6), c('j1', 5)];
    expect(dueStep(row({ created_at: ago(6.9) }), j0j1, NOW)).toBeNull();
    expect(dueStep(row({ created_at: ago(7) }), j0j1, NOW)).toBe('j7');
    // an old vendor with only j0 done is asked j1 first, never j7
    expect(dueStep(row({ created_at: ago(10) }), [c('j0', 9)], NOW)).toBe('j1');
  });

  it('repos only when j7 is 7+ days old AND she did nothing since', () => {
    const base = [c('j0', 20), c('j1', 19), c('j7', 8)];
    const created = ago(20);
    expect(dueStep(row({ created_at: created, last_action_at: null }), base, NOW)).toBe('repos');
    expect(dueStep(row({ created_at: created, last_action_at: ago(9) }), base, NOW)).toBe('repos'); // before the j7 contact
    expect(dueStep(row({ created_at: created, last_action_at: ago(2) }), base, NOW)).toBeNull(); // active again
    // j7 contact too recent
    expect(dueStep(row({ created_at: created }), [c('j0', 20), c('j1', 19), c('j7', 3)], NOW)).toBeNull();
  });

  it('j30 comes 30 days after signup, once the chain is done, and never repos if she is active', () => {
    const chain = [c('j0', 40), c('j1', 39), c('j7', 33)];
    const active = row({ created_at: ago(30), last_action_at: ago(1) });
    expect(dueStep(active, chain, NOW)).toBe('j30');
    expect(dueStep(row({ created_at: ago(29), last_action_at: ago(1) }), chain, NOW)).toBeNull();
    // inactive at 30 days: repos is owed before j30
    expect(dueStep(row({ created_at: ago(30), last_action_at: null }), chain, NOW)).toBe('repos');
  });

  it('nothing is ever due after repos or j30 was contacted', () => {
    const r = row({ created_at: ago(100), last_action_at: ago(1) });
    expect(dueStep(r, [c('j0', 99), c('j1', 98), c('j7', 90), c('repos', 80)], NOW)).toBeNull();
    expect(dueStep(r, [c('j0', 99), c('j1', 98), c('j7', 90), c('j30', 60)], NOW)).toBeNull();
  });
});

describe('shopNumber', () => {
  it('ranks by created_at, from 1, stable on ties by business_id', () => {
    const rows = [
      row({ business_id: 'c', created_at: ago(1) }),
      row({ business_id: 'a', created_at: ago(5) }),
      row({ business_id: 'b', created_at: ago(1) }),
    ];
    expect(shopNumber(rows, 'a')).toBe(1);
    expect(shopNumber(rows, 'b')).toBe(2);
    expect(shopNumber(rows, 'c')).toBe(3);
    expect(shopNumber([...rows].reverse(), 'b')).toBe(2);
  });
});

describe('todayCount / contactRows', () => {
  const rows = [
    row({ business_id: 'new', created_at: ago(0) }), // j0
    row({ business_id: 'day1', created_at: ago(2) }), // j1
    row({ business_id: 'done', created_at: ago(100) }), // finished
    row({ business_id: 'wait', created_at: ago(0.2) }), // j0 done, too young
  ];
  const by = {
    day1: [c('j0', 1.5)],
    done: [c('j0', 99), c('j1', 98), c('j7', 90), c('repos', 80)],
    wait: [c('j0', 0.1)],
  };

  it('counts only vendors with a step due', () => {
    expect(todayCount(rows, by, NOW)).toBe(2);
  });

  it('orders by step then oldest first', () => {
    expect(contactRows(rows, by, NOW).map(x => [x.row.business_id, x.step])).toEqual([
      ['new', 'j0'],
      ['day1', 'j1'],
    ]);
  });
});

describe('careMessage', () => {
  const ctx = { number: 12, total: 40, sales7d: 5, credits7d: 3 };
  const r = row();

  it('fills every value and separates blocks with a blank line', () => {
    const j0 = careMessage('j0', r, ctx);
    expect(j0).toContain('Bonjour Aminata. C\'est Sebastiao. J\'ai créé Patron.');
    expect(j0).toContain('Votre commerce porte le numéro 12.');
    expect(j0.split('\n\n')).toHaveLength(3);

    const j1 = careMessage('j1', r, ctx);
    expect(j1).toContain('le n° 12 sur Patron');
    expect(j1.split('\n\n')).toHaveLength(3);

    const j7a = careMessage('j7', r, ctx);
    expect(j7a).toContain('vous avez noté 5 ventes et 3 crédits');
    expect(j7a.split('\n\n')).toHaveLength(4);

    const j7q = careMessage('j7', r, { ...ctx, sales7d: 0, credits7d: 0 });
    expect(j7q).toContain('Votre numéro 12 vous attend.');
    expect(j7q).not.toContain('ventes et');
    expect(j7q.split('\n\n')).toHaveLength(3);

    const repos = careMessage('repos', r, ctx);
    expect(repos).toContain('Votre numéro 12 reste le vôtre.');
    expect(repos.split('\n\n')).toHaveLength(4);

    const j30 = careMessage('j30', r, ctx);
    expect(j30).toContain('le n° 12');
    expect(j30).toContain('vous êtes 40 boutiques');
    expect(j30.split('\n\n')).toHaveLength(5);
  });

  it('treats a vendor with activity in the last 7 days as active even with only credits', () => {
    expect(careMessage('j7', r, { ...ctx, sales7d: 0, credits7d: 2 })).toContain('0 ventes et 2 crédits');
  });

  it('never says Salam and always uses vous', () => {
    for (const step of ['j0', 'j1', 'j7', 'repos', 'j30'] as CareStep[]) {
      const m = careMessage(step, r, ctx);
      expect(m).not.toMatch(/salam/i);
      expect(m).not.toMatch(/(?<!\p{L})(tu|ton|ta|tes|toi)(?!\p{L})/iu);
      expect(m).toMatch(/vous|votre|vos/i);
    }
  });

  it('without a first name: plain "Bonjour." and the shop line carries the number', () => {
    const anon = row({ owner_name: null });
    const j0 = careMessage('j0', anon, ctx);
    expect(j0.startsWith('Bonjour. C\'est Sebastiao.')).toBe(true);
    expect(j0).not.toContain('Bonjour .');
    expect(j0).toContain('Votre boutique « Boutique Aminata » porte le numéro 12.');
    expect(careMessage('j1', anon, ctx).startsWith('Bonjour. ')).toBe(true);
    const noShop = careMessage('j0', row({ owner_name: '  ', business_name: null }), ctx);
    expect(noShop).toContain('Votre boutique porte le numéro 12.');
  });
});
