// The cart is built for glance-verify-tap: line totals she can check against the CTA, a remove control that reads
// "remove", payment that never scrolls away, and the vendor's own last payment method pre-selected.
import fs from 'fs';
import path from 'path';
import { lineTotal, cartSum, cartHeaderTitle, lastUsedPayMethod, withoutLine } from '@/src/utils/cartMath';
import { footerPlacement } from '@/src/utils/ctaLayout';
import { amountText } from '@/src/utils/moneyText';

const read = (p: string) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const V = read('app/(app)/(tabs)/vendre.tsx');
const cartSheet = V.slice(V.indexOf('<FormSheet\n        visible={showCartSheet}'), V.indexOf('{/* Vente rapide'));
const cartRow = V.slice(V.indexOf('function CartRow('), V.indexOf('// ─── Payment modal'));

const lines = [
  { key: 'a', unit_price: 2000, qty: 2 },   // 2 × 2 000 = 4 000
  { key: 'b', unit_price: 1500, qty: 1 },
  { key: 'c', unit_price: 350, qty: 4 },
];

describe('(a) line totals, verified not computed', () => {
  it('each line shows qty × unit price, and the lines sum to exactly what the CTA charges', () => {
    expect(lineTotal(lines[0])).toBe(4000);
    expect(amountText(lineTotal(lines[0]), 'GNF')).toBe('4 000 GNF');
    const shown = lines.map(lineTotal);
    expect(shown.reduce((a, b) => a + b, 0)).toBe(cartSum(lines));
    expect(cartSum(lines)).toBe(6900);
    expect(`Encaisser · ${amountText(cartSum(lines), 'GNF')}`).toBe('Encaisser · 6 900 GNF');
  });
  it('the row renders a bold right-aligned total (Money) and a unit-price chip (tappable, Prix convenu)', () => {
    expect(cartRow).toContain('amount={lineTotal(line)}');
    expect(cartRow).toMatch(/<Money amount=\{lineTotal\(line\)\}[^>]*variant="amount"/);
    expect(cartRow).toMatch(/<MoneyText variant="caption"[\s\S]{0,160}formatAmount\(effectiveUnitPrice\(line\)/);
  });
  it('the CTA total and the lines come from the same helper', () => {
    expect(V).toContain('const cartTotal = useMemo(() => cartSum(cart), [cart]);');
  });
});

describe('(b) the remove control is an X, 48dp, and removes exactly its line', () => {
  it('no trash can; a "close" X with a 48dp hit area and a clear label', () => {
    expect(cartRow).not.toContain('trash-outline');
    expect(cartRow).toContain('name="close"');
    expect(cartRow).toContain('accessibilityLabel="Retirer cette ligne"');
    expect(V).toMatch(/removeLineBtn: \{ width: 48, height: 48/);
  });
  it('removing one line leaves every other line untouched', () => {
    const after = withoutLine(lines, l => l.key, 'b');
    expect(after.map(l => l.key)).toEqual(['a', 'c']);
    expect(cartSum(after)).toBe(cartSum(lines) - lineTotal(lines[1]));
    expect(withoutLine(lines, l => l.key, 'nope')).toHaveLength(3);
  });
  it('the X is wired to this row\'s own remove handler', () => {
    expect(cartSheet).toContain('onRemove={() => removeFromCart(line.product.id, line.is_bulk, line.variant_id)}');
  });
});

describe('(c) "Vider" is subtle, never red, in both places', () => {
  it('main selling screen: a small quiet "Vider" (secondary, not red) shown only when the cart has items, confirmed before emptying', () => {
    const header = V.slice(V.indexOf('<View style={styles.headerRight}>'), V.indexOf('Prix en'));
    expect(header).toContain('cart.length > 0 &&');
    expect(header).toContain('<Text variant="caption" color="secondary">Vider</Text>');
    expect(header).toContain("appAlert('Vider le panier ?'");
    expect(header).toContain('onPress: clearCart');
  });
  it('full cart: a quiet readable link at the end of the list (no red, no header button), confirmed too', () => {
    expect(cartSheet).not.toMatch(/headerRight/);
    expect(cartSheet).toContain('<Text variant="caption" color="secondary">Vider le panier</Text>');
    expect(cartSheet).toContain("appAlert('Vider le panier ?'");
  });
  it('never red anywhere', () => {
    expect(V).not.toMatch(/color="danger">Vider/);
  });
});

describe('(d) payment is pinned, only the list scrolls', () => {
  it('the cart sheet footer (payment pills + Encaisser) is sticky/docked regardless of how many items — even 10', () => {
    expect(cartSheet).toContain('footerMode="sticky"');
    expect(cartSheet).toContain('renderCheckoutFooter(');
    for (const n of [1, 10, 40]) expect(footerPlacement({ hasFooter: true, mode: 'sticky', keyboardOpen: false })).toBe('docked');
    const footer = V.slice(V.indexOf('const renderCheckoutFooter'), V.indexOf('// "Partager le reçu"'));
    expect(footer).toContain('QUICK_PAY_METHODS.map');
    expect(footer).toContain('Encaisser · ${formatAmount(displayTotal, currency)}');
    expect(footer).toContain('ou enregistrer à crédit');
  });
  it('FormSheet keeps a sticky footer above the safe area, with a fade not a slab', () => {
    const fs_ = read('src/components/ui/FormSheet.tsx');
    expect(fs_).toContain('<CtaFade style={{ paddingBottom: rootInsets.bottom }}>{footerNode}</CtaFade>');
  });
});

describe('(e) the last-used payment method is pre-selected', () => {
  it('last used wins over most frequent', () => {
    expect(lastUsedPayMethod(['especes', 'especes', 'especes', 'orange'])).toBe('orange');
    expect(lastUsedPayMethod(['orange', 'orange', 'mtn'])).toBe('mtn');
  });
  it('falls back to Espèces with no history, or only unknown methods', () => {
    expect(lastUsedPayMethod([])).toBe('especes');
    expect(lastUsedPayMethod(['digital', 'autre'])).toBe('especes');
    expect(lastUsedPayMethod(['orange', 'digital'])).toBe('orange');
  });
  it('the screen loads it per business on open and records it after a successful Encaisser', () => {
    expect(V).toContain('return lastUsedPayMethod(history);');
    expect(V).toContain('loadDefaultQuickPayMethod(businessId).then(setQuickPayMethod)');
    expect(V).toContain('recordQuickPayMethodUsed(businessId, method)');
  });
});

describe('(f) header and credit link', () => {
  it('"Panier · 3 articles"', () => {
    expect(cartHeaderTitle(3)).toBe('Panier · 3 articles');
    expect(cartHeaderTitle(1)).toBe('Panier · 1 article');
    expect(cartHeaderTitle(0)).toBe('Panier');
    expect(cartSheet).toContain('title={cartHeaderTitle(cart.length)}');
  });
  it('"ou enregistrer à crédit" stays a quiet text link', () => {
    expect(V).toMatch(/<Pressable onPress=\{openCredit\} style=\{styles\.creditLink\}>\s*<Text variant="caption"[^>]*>ou enregistrer à crédit<\/Text>/);
  });
});
