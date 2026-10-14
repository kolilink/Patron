// Regression: "Partager le reçu" on the Ventes sale-detail sheet looked dead.
// The detail is a FormSheet (a React Native Modal); the receipt was opened as
// SaleReceiptSheet — a SECOND Modal presented while the first was still up.
// Two Modals must never be presenting at once (the same rule vendre.tsx
// documents at its own receipt hand-off): on iOS the second sheet silently
// never appears. The receipt now renders IN PLACE inside the detail sheet via
// ReceiptPanel, the component built for in-place hosting (QuickCaptureSheet).
import fs from 'fs';
import path from 'path';

const read = (p: string) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const VENTES = read('app/(app)/ventes/index.tsx');
const VENDRE = read('app/(app)/(tabs)/vendre.tsx');

describe('ventes sale-detail receipt: in place, never a nested Modal', () => {
  it('does not import or render SaleReceiptSheet (the second Modal)', () => {
    expect(VENTES).not.toContain("from '@/src/components/SaleReceiptSheet'");
    expect(VENTES).not.toMatch(/<SaleReceiptSheet[\s>]/);
  });

  it('renders ReceiptPanel in place, gated on showReceipt + a built source', () => {
    expect(VENTES).toContain("import { ReceiptPanel } from '@/src/components/ReceiptPanel';");
    expect(VENTES).toMatch(/\{showReceipt && receiptSource \? \(\s*<ReceiptPanel/);
  });

  it('the sheet steps BACK to the detail on close while the receipt is shown', () => {
    expect(VENTES).toContain('onClose={showReceipt ? () => setShowReceipt(false) : onClose}');
    expect(VENTES).toContain("title={showReceipt ? 'Reçu' : `Vente du ${headerDate}`}");
  });

  it('the "Partager le reçu" button still opens the receipt from the detail body', () => {
    expect(VENTES).toContain('<Button label="Partager le reçu" onPress={() => setShowReceipt(true)}');
  });

  it('the synced-edit hand-off still leaves the receipt before opening the edit form', () => {
    const panel = VENTES.slice(VENTES.indexOf('<ReceiptPanel'), VENTES.indexOf('</>', VENTES.indexOf('<ReceiptPanel')));
    expect(panel).toContain('setShowReceipt(false);');
    expect(panel).toContain('openEditSale();');
  });
});

describe('vendre receipt hand-off: the sequencing rule stays intact', () => {
  it('still drops the confirm sheet before opening the receipt sheet', () => {
    expect(VENDRE).toContain('two Modals must\n  // never be presenting at once');
    expect(VENDRE).toMatch(/setShowConfirmSheet\(false\);\s*setTimeout\(\(\) => setReceiptOpen\(src\), 350\);/);
  });
});
