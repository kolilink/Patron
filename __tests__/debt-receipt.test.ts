import {
  buildDebtReceiptContent, defaultReminderTone, lastPaymentFor, articleLines, firstName, type DebtReceiptInput,
} from '@/src/utils/debtReceipt';
import { formatAmount } from '@/src/utils/format';

const NOW = new Date('2026-10-06T12:00:00');

const base: DebtReceiptInput = {
  businessName: 'Boutique Aïcha',
  clientName: 'Mariam Diallo',
  currency: 'GNF',
  totalOwed: 25000,
  debts: [{ label: '2 pagnes, 1 sac de riz', date: '2026-09-28' }],
  lastPayment: { amount: 10000, date: '2026-10-02' },
  now: NOW,
};

describe('tone default by debtAgeTier', () => {
  it('>= 30 days → ferme, otherwise doux', () => {
    expect(defaultReminderTone(0)).toBe('doux');
    expect(defaultReminderTone(7)).toBe('doux');
    expect(defaultReminderTone(29)).toBe('doux');
    expect(defaultReminderTone(30)).toBe('ferme');
    expect(defaultReminderTone(90)).toBe('ferme');
  });
});

describe('exact strings', () => {
  it('doux', () => {
    const c = buildDebtReceiptContent(base, 'doux');
    expect(c.businessName).toBe('Boutique Aïcha');
    expect(c.greeting).toBe('Bonjour Mariam,');
    expect(c.context).toBe('Je fais le point sur mon carnet :');
    expect(c.articleLines).toEqual(['2 pagnes, 1 sac de riz — le 28 sept.']);
    expect(c.lastPaymentLine).toBe(`Dernier paiement reçu : ${formatAmount(10000, 'GNF')} le 2 oct.`);
    expect(c.remainingLine).toBe(`Il reste : ${formatAmount(25000, 'GNF')}`);
    expect(c.demande).toEqual(['Quand vous pouvez, même petit à petit.']);
    expect(c.trust).toBe('Je sais que vous êtes une personne de parole.');
    expect(c.close).toBe('Merci !');
    expect(c.footer).toBe('Généré par Patron');
  });

  it('ferme', () => {
    const c = buildDebtReceiptContent(base, 'ferme');
    expect(c.context).toBe('Je reviens vers vous pour ce solde :');
    expect(c.demande).toEqual([
      "J'ai besoin qu'on le règle ensemble cette semaine — dites-moi ce qui est possible pour vous.",
      "Même une partie m'aide beaucoup.",
    ]);
    expect(c.close).toBe('Merci.');
  });

  it('never says "vous devez" / "pas payé"', () => {
    for (const tone of ['doux', 'ferme'] as const) {
      const c = buildDebtReceiptContent(base, tone);
      const all = JSON.stringify(c).toLowerCase();
      expect(all).not.toContain('vous devez');
      expect(all).not.toContain("pas payé");
    }
  });
});

describe('null handling', () => {
  it('no previous payment → no "Dernier paiement" line', () => {
    expect(buildDebtReceiptContent({ ...base, lastPayment: null }, 'doux').lastPaymentLine).toBeNull();
  });
  it('no article label → "Carnet du {date}"', () => {
    const c = buildDebtReceiptContent({ ...base, debts: [{ label: null, date: '2026-09-28' }, { label: '  ', date: '2026-09-01' }] }, 'doux');
    expect(c.articleLines).toEqual(['Carnet du 28 sept.', 'Carnet du 1 sept.']);
  });
  it('empty name → plain greeting', () => {
    expect(buildDebtReceiptContent({ ...base, clientName: '  ' }, 'doux').greeting).toBe('Bonjour,');
  });
  it('previous-year dates carry the year', () => {
    expect(articleLines([{ label: null, date: '2025-12-30' }], NOW)).toEqual(['Carnet du 30 déc. 2025']);
  });
});

describe('article truncation', () => {
  const d = (n: number) => Array.from({ length: n }, (_, i) => ({ label: `Article ${i + 1}`, date: '2026-09-28' }));
  it('3 lines fit as-is', () => expect(articleLines(d(3), NOW)).toHaveLength(3));
  it('4 → 3 lines + "+ 1 autre article"', () => {
    const l = articleLines(d(4), NOW);
    expect(l).toHaveLength(4);
    expect(l[3]).toBe('+ 1 autre article');
  });
  it('7 → 3 lines + "+ 4 autres articles"', () => {
    const l = articleLines(d(7), NOW);
    expect(l.slice(0, 3)).toEqual(['Article 1 — le 28 sept.', 'Article 2 — le 28 sept.', 'Article 3 — le 28 sept.']);
    expect(l[3]).toBe('+ 4 autres articles');
  });
  it('the total is always the exact full amount whatever the summary', () => {
    const c = buildDebtReceiptContent({ ...base, debts: d(50), totalOwed: 987654321 }, 'doux');
    expect(c.remainingLine).toBe(`Il reste : ${formatAmount(987654321, 'GNF')}`);
  });
});

describe('robustness', () => {
  it('9-digit GNF amount is complete', () => {
    const c = buildDebtReceiptContent({ ...base, totalOwed: 123456789 }, 'ferme');
    expect(c.remainingLine).toBe(`Il reste : ${formatAmount(123456789, 'GNF')}`);
    expect(c.remainingLine.replace(/\D/g, '')).toBe('123456789');
  });
  it('USD decimals are complete', () => {
    const c = buildDebtReceiptContent({ ...base, currency: 'USD', totalOwed: 1234567.89 }, 'doux');
    expect(c.remainingLine).toBe(`Il reste : ${formatAmount(1234567.89, 'USD')}`);
    expect(c.remainingLine.replace(/\D/g, '')).toBe('123456789');
  });
  it('40-char name: greeting keeps the whole first word, nothing throws', () => {
    const name = 'A'.repeat(40);
    expect(buildDebtReceiptContent({ ...base, clientName: name }, 'doux').greeting).toBe(`Bonjour ${name},`);
    expect(firstName('Mariam  Diallo')).toBe('Mariam');
  });
  it('200-char article label is summarized, not thrown', () => {
    const c = buildDebtReceiptContent({ ...base, debts: [{ label: 'x'.repeat(200), date: '2026-09-28' }] }, 'doux');
    expect(c.articleLines[0].length).toBeLessThan(100);
    expect(c.articleLines[0].endsWith(' — le 28 sept.')).toBe(true);
  });
  it('zero debts does not throw', () => {
    expect(buildDebtReceiptContent({ ...base, debts: [] }, 'doux').articleLines).toEqual([]);
  });
});

describe('lastPaymentFor — only this debt, reversals netted out', () => {
  const ids = new Set(['s1']);
  const pay = (id: string, amount: number, date: string, at: string, order = 's1') => ({ order_id: order, amount, date, created_at: at });
  it('ignores payments on other sales', () => {
    expect(lastPaymentFor([pay('a', 5000, '2026-10-03', 't2', 'other')], ids)).toBeNull();
  });
  it('a reversed payment is not shown', () => {
    const rows = [pay('a', 10000, '2026-10-02', '2026-10-02T10:00'), pay('b', -10000, '2026-10-02', '2026-10-02T10:05')];
    expect(lastPaymentFor(rows, ids)).toBeNull();
  });
  it('falls back to the previous real payment after a reversal', () => {
    const rows = [
      pay('a', 4000, '2026-09-30', '2026-09-30T09:00'),
      pay('b', 10000, '2026-10-02', '2026-10-02T10:00'),
      pay('c', -10000, '2026-10-02', '2026-10-02T10:05'),
    ];
    expect(lastPaymentFor(rows, ids)).toEqual({ amount: 4000, date: '2026-09-30' });
  });
  it('sums a payment split across sales', () => {
    const rows = [pay('a', 4000, '2026-10-02', 'T', 's1'), pay('b', 6000, '2026-10-02', 'T', 's2')];
    expect(lastPaymentFor(rows, new Set(['s1', 's2']))).toEqual({ amount: 10000, date: '2026-10-02' });
  });
});
