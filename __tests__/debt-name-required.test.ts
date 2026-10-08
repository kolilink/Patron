// A debt needs a debtor and a positive amount — the UI and the outbox validator
// must agree, so there is no dead end and no nameless debt.
import fs from 'fs';
import path from 'path';

const runAsync = jest.fn(async (..._a: unknown[]) => ({}));
jest.mock('expo-sqlite', () => ({
  openDatabaseAsync: async () => ({
    execAsync: async () => {}, runAsync: (...a: unknown[]) => runAsync(...a),
    getFirstAsync: async () => ({ version: 9999 }), getAllAsync: async () => [],
  }),
}));
jest.mock('@/lib/encryption', () => ({ encrypt: async (s: string) => s, decrypt: async (s: string) => s }));
const toastShow = jest.fn();
jest.mock('@/stores/toast', () => ({ useToastStore: { getState: () => ({ show: toastShow }) } }));

import { enqueue } from '@/lib/db';
import { OutboxValidationError } from '@/lib/outboxValidation';
import { readyDebtEntry, nextWalkInLabel, WALK_IN_LABEL } from '@/src/utils/debtEntry';

const read = (p: string) => fs.readFileSync(path.resolve(__dirname, '..', p), 'utf8');
const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

describe('the shared gate: button enabled <=> entry ready', () => {
  it.each([['', '1 000'], ['   ', '1 000'], ['\t\n', '5000']])('disabled for blank/whitespace name %j', (name, amount) => {
    expect(readyDebtEntry(name, amount, 'GNF')).toBeNull();
  });
  it.each([['Aïssatou', ''], ['Aïssatou', '0'], ['Aïssatou', '000'], ['Aïssatou', 'abc']])('disabled for non-positive amount %j', (name, amount) => {
    expect(readyDebtEntry(name, amount, 'GNF')).toBeNull();
  });
  it('a fraction that rounds to zero cents is not ready either (button and handler cannot disagree)', () => {
    expect(readyDebtEntry('Aïssatou', '0,004', 'USD')).toBeNull();
  });
  it('enabled with a trimmed name and a positive amount; decimals are kept in cents', () => {
    expect(readyDebtEntry('  Aïssatou ', '1 000', 'GNF')).toEqual({ name: 'Aïssatou', amountCents: 100000 });
    expect(readyDebtEntry('Aïssatou', '10,99', 'USD')).toEqual({ name: 'Aïssatou', amountCents: 1099 });
  });
  it('both screens drive `disabled` AND the handler from that one function (no early-enable state)', () => {
    const sheet = read('src/components/CreditRapideCapture.tsx');
    expect(sheet).toMatch(/const canSubmit = readyDebtEntry\(name, amount, currency\) !== null;/);
    expect(sheet).toMatch(/disabled=\{saving \|\| !canSubmit\}/);
    expect(sheet).toMatch(/const ready = readyDebtEntry\(name, amount, currency\);\s*[^\n]*\n\s*if \(!ready\) return;/);
    const onboarding = read('app/(app)/onboarding/carnet.tsx');
    expect(onboarding).toMatch(/const canAdd = readyDebtEntry\(name, amount, currency\) !== null;/);
    expect(onboarding).toMatch(/const ready = readyDebtEntry\(name, amount, currency\);\s*if \(!ready\) return;/);
    expect(onboarding).toMatch(/disabled=\{!canAdd\}/);
    // nothing else decides enablement
    expect(sheet).not.toMatch(/disabled=\{!name\.trim\(\)/);
  });
});

describe('"Je ne connais pas son nom" chip', () => {
  it('first unknown is the plain label, then numbered — one ledger per unknown person', () => {
    expect(nextWalkInLabel([])).toBe(WALK_IN_LABEL);
    expect(nextWalkInLabel(['Aïssatou'])).toBe(WALK_IN_LABEL);
    expect(nextWalkInLabel([WALK_IN_LABEL])).toBe('Client de passage 2');
    expect(nextWalkInLabel([WALK_IN_LABEL, 'Client de passage 2', 'client de passage 5'])).toBe('Client de passage 6');
  });
  it('the label it fills enables the button, and the outbox accepts the payload', async () => {
    const label = nextWalkInLabel([]);
    expect(readyDebtEntry(label, '2 500', 'GNF')).not.toBeNull();
    await expect(enqueue('submit_carnet_debt', {
      p_business_id: U(1), p_seller_id: U(2), p_customer_name: label, p_amount: 250000,
      p_client_id: null, p_idempotency_key: U(3), p_sale_date: '2026-10-07',
    })).resolves.toBeUndefined();
  });
  it('is offered under the Nom field only for a new client with no name typed, and focuses the amount', () => {
    const sheet = read('src/components/CreditRapideCapture.tsx');
    expect(sheet).toMatch(/\{isNew && !name\.trim\(\) \? \(/);
    expect(sheet).toMatch(/setName\(nextWalkInLabel\(clients\.map\(c => c\.name\)\)\)/);
    expect(sheet).toMatch(/amountRef\.current\?\.focus\(\)/);
  });
});

describe('last line of defense: blank-name payloads still throw at enqueue, zero writes', () => {
  beforeEach(() => { runAsync.mockClear(); toastShow.mockClear(); jest.spyOn(console, 'error').mockImplementation(() => {}); });
  afterEach(() => jest.restoreAllMocks());
  const debt = (name: unknown) => ({ p_business_id: U(1), p_seller_id: U(2), p_customer_name: name, p_amount: 1000, p_client_id: null, p_idempotency_key: U(3), p_sale_date: '2026-10-07' });
  const pay = (name: unknown) => ({ p_business_id: U(1), p_customer_name: name, p_amount: 1000, p_method: 'especes', p_date: '2026-10-07', p_idempotency_key: U(3) });

  it.each([['', 'empty'], ['   ', 'whitespace'], [null, 'null'], [undefined, 'missing']])('submit_carnet_debt with %j (%s)', async (name, _label) => {
    await expect(enqueue('submit_carnet_debt', debt(name))).rejects.toBeInstanceOf(OutboxValidationError);
    expect(runAsync).not.toHaveBeenCalled();
  });
  it.each([['', 'empty'], ['  ', 'whitespace']])('record_client_payment with %j (%s)', async (name) => {
    await expect(enqueue('record_client_payment', pay(name))).rejects.toBeInstanceOf(OutboxValidationError);
    expect(runAsync).not.toHaveBeenCalled();
  });
  it('the single toast says what to DO: "Ajoutez le nom du client."', async () => {
    await expect(enqueue('submit_carnet_debt', debt('  '))).rejects.toBeInstanceOf(OutboxValidationError);
    expect(toastShow).toHaveBeenCalledTimes(1);
    expect(toastShow.mock.calls[0][0]).toBe('Ajoutez le nom du client.');
  });
  it('a bad amount also gets an actionable sentence', async () => {
    await expect(enqueue('submit_carnet_debt', { ...debt('Aïssatou'), p_amount: -5 })).rejects.toBeInstanceOf(OutboxValidationError);
    expect(toastShow.mock.calls[0][0]).toBe('Entrez un montant valide.');
  });
});
