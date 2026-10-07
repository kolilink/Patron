import { buildDebtReceiptContent, lastPaymentFor, firstName, type DebtReceiptInput } from '@/src/utils/debtReceipt';
import { formatAmount } from '@/src/utils/format';

const NOW = new Date('2026-10-07T12:00:00');
const base: DebtReceiptInput = { businessName: ' Essaie ', clientName: 'Mariam Diallo', currency: 'GNF', totalOwed: 2450000, now: NOW };

describe('the one reminder copy (v6)', () => {
  it('exact strings', () => {
    const c = buildDebtReceiptContent(base);
    expect(c.businessName).toBe('Essaie');
    expect(c.greeting).toBe('Bonjour Mariam,');
    expect(c.context).toEqual(['Petit rappel sur votre crédit', 'Solde du 7 oct.']);
    expect(c.remainingLine).toBe(`Il reste : ${formatAmount(2450000, 'GNF')}`);
    expect(c.demande).toBe('Quand vous pouvez, même petit à petit.');
    expect(c.close).toBe('Merci.');
    expect(c.footer).toBe('Généré par Patron');
  });
  it('empty name → plain greeting; firstName takes the first word', () => {
    expect(buildDebtReceiptContent({ ...base, clientName: ' ' }).greeting).toBe('Bonjour,');
    expect(firstName('Mariam  Diallo')).toBe('Mariam');
  });
  it.each([3, 25000, 2450000, 150000000])('amount %i is complete on one string', n => {
    const c = buildDebtReceiptContent({ ...base, totalOwed: n });
    expect(c.remainingLine).toBe(`Il reste : ${formatAmount(n, 'GNF')}`);
    expect(c.remainingLine.replace(/\D/g, '')).toBe(String(n));
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
