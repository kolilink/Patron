// Livraison redesign (Part 3). The old "Votre marge" step is dead: the sale
// price is no longer derived from a global margin %, it is typed per-line on
// Écran 1 as "Je vends à" (optional). The supplier is a skippable chip on
// Écran 1 (and editable post-save on Confirmé). Écran 2 is "C'est tout bon ?",
// absorbing transport + delivery date + confirm. Source-pinned at the repo's
// hermetic screen-pin convention (no component rendering):
//
//   (a) the margin % is gone — no marginInput/marginPct/computedSalePrice, no
//       MargeStep, no 48pt hero, and the RPC still books p_margin_percent=null.
//   (b) "Je vends à" maps empty → null (never 0) via amountInputToCents.
//   (c) linkProduct prefills the sale price as an UNTOUCHED hint.
//   (d) only a touched price is booked — untouched prefill never overwrites.
//   (e) variant rows show no per-line sale price field.
//   (f) the supplier chip lives on Écran 1 (QuoiStep).
//   (g) RecapStep "C'est tout bon ?" absorbs transport + date + confirm, and
//       the flow is 3 steps (quoi → recap → confirme).
//   (h) supplier dead ends: Bug A "+" header action in the Fournisseurs list;
//       Bug B inline "+ Nouveau fournisseur" form in the picker sheet.
//   (i) the transport NULL-poisoning in receive_purchase_order is guarded
//       (IF unit_cost IS NOT NULL) by migration_v221 on current main.

import { readFileSync } from 'fs';
import { join } from 'path';

import { amountInputToCents } from '@/src/utils/format';

const RECEPTION = readFileSync(join(__dirname, '..', 'app/(app)/fournisseurs/reception.tsx'), 'utf8');
const FOURNISSEURS = readFileSync(join(__dirname, '..', 'app/(app)/fournisseurs/index.tsx'), 'utf8');
const MIGRATION = readFileSync(join(__dirname, '..', 'db/migration_v221.sql'), 'utf8');

describe('Livraison redesign — (a) the margin % is dead', () => {
    it('no margin draft field, no derived price, no MargeStep, no 48pt hero remain', () => {
        // The Draft interface itself no longer carries a margin field (the only
        // remaining `marginInput` text is the legacy-draft normalisation, which
        // must keep deleting it).
        const draftInterface = RECEPTION.slice(RECEPTION.indexOf('interface Draft {'), RECEPTION.indexOf('const DRAFT_MAX_AGE_MS'));
        expect(draftInterface).not.toMatch(/marginInput/);
        expect(RECEPTION).not.toMatch(/marginPct/);
        expect(RECEPTION).not.toMatch(/computedSalePrice/);
        expect(RECEPTION).not.toMatch(/function MargeStep/);
        expect(RECEPTION).not.toMatch(/fontSize: 48/);
        expect(RECEPTION).not.toMatch(/marginBox:/);
        expect(RECEPTION).not.toMatch(/marginPercentSign:/);
        expect(RECEPTION).not.toMatch(/perLineRow:/);
    });

    it('the RPC still books p_margin_percent as null', () => {
        expect(RECEPTION).toMatch(/marginPercent: null/);
    });
});

describe('Livraison redesign — (b) "Je vends à" maps empty → null, never 0', () => {
    it('the field label is "Je vends à" with an (optionnel) hint', () => {
        expect(RECEPTION).toMatch(/Je vends à/);
        expect(RECEPTION).toMatch(/\(optionnel\)/);
    });

    it('the setter routes the typed text through amountInputToCents (empty → null)', () => {
        expect(RECEPTION).toMatch(/salePriceCents: amountInputToCents\(formatted, currency\)/);
        expect(RECEPTION).toMatch(/salePriceTouched: true/);
    });

    it('amountInputToCents never produces 0 — blank and non-positive are null', () => {
        expect(amountInputToCents('', 'GNF')).toBeNull();
        expect(amountInputToCents('0', 'GNF')).toBeNull();
        expect(amountInputToCents('10', 'GNF')).toBe(1000);
        expect(amountInputToCents('1,5', 'USD')).toBe(150);
    });
});

describe('Livraison redesign — (c)/(d) prefill as an untouched hint, booked only when touched', () => {
    it('linkProduct prefills salePriceInput/salePriceCents but leaves salePriceTouched false', () => {
        expect(RECEPTION).toMatch(/salePriceInput: product\.sale_price > 0 \? formatAmountInput\(String\(product\.sale_price\), currency\) : ''/);
        expect(RECEPTION).toMatch(/salePriceCents: product\.sale_price > 0 \? Math\.round\(product\.sale_price \* 100\) : null/);
        expect(RECEPTION).toMatch(/salePriceTouched: false/);
    });

    it('handleConfirm books sale_price_cents only for a line she actually touched', () => {
        expect(RECEPTION).toMatch(/const salePriceCents = l\.salePriceTouched \? l\.salePriceCents : null;/);
    });

    it('loadDraft normalises a pre-redesign draft: marginInput dropped, untouched prefill nulled', () => {
        expect(RECEPTION).toMatch(/delete \(d as Draft & \{ marginInput\?: string \}\)\.marginInput;/);
        expect(RECEPTION).toMatch(/salePriceCents: overridden \? l\.salePriceCents : null/);
        expect(RECEPTION).toMatch(/salePriceTouched: overridden \?\? l\.salePriceTouched \?\? false/);
    });
});

describe('Livraison redesign — (e) variant rows show no sale-price field', () => {
    it('"Je vends à" is rendered only for !line.hasVariants', () => {
        expect(RECEPTION).toMatch(/\{!line\.hasVariants && \(\s*<View style=\{\{ gap: spacing\[1\] \}\}>/);
        // The variant split row renders a qty grid and never the sale-price input.
        const variantRow = RECEPTION.slice(RECEPTION.indexOf('function VariantSplitRow'), RECEPTION.indexOf('// ─── Étape 2'));
        expect(variantRow).not.toMatch(/salePriceInput/);
        expect(variantRow).not.toMatch(/Je vends à/);
    });
});

describe('Livraison redesign — (f) the supplier chip lives on Écran 1', () => {
    it('QuoiStep carries onChangeSupplier and renders the "De :" chip', () => {
        const quoi = RECEPTION.slice(RECEPTION.indexOf('function QuoiStep'), RECEPTION.indexOf('function VariantSplitRow'));
        expect(quoi).toMatch(/onChangeSupplier: \(\) => void/);
        expect(quoi).toMatch(/<Pressable onPress=\{onChangeSupplier\} style=\{\[styles\.supplierChip/);
        expect(quoi).toMatch(/De : \{draft\.supplierName \|\| '—'\}/);
    });
});

describe('Livraison redesign — (g) RecapStep "C\'est tout bon ?" and the 3-step flow', () => {
    it('the step type is quoi | recap | confirme', () => {
        expect(RECEPTION).toMatch(/type Step = 'quoi' \| 'recap' \| 'confirme';/);
    });

    it('handleVerifyDone advances to recap, not straight to confirmé', () => {
        expect(RECEPTION).toMatch(/setStep\('recap'\);/);
    });

    it('RecapStep absorbs transport + delivery date + the confirm button', () => {
        const recap = RECEPTION.slice(RECEPTION.indexOf('function RecapStep'), RECEPTION.indexOf('// ─── Étape 3'));
        expect(recap).toMatch(/C'est tout bon \?/);
        expect(recap).toMatch(/Transport/);
        expect(recap).toMatch(/Date de réception/);
        expect(recap).toMatch(/Confirmer la livraison/);
        expect(recap).toMatch(/loadingLabel="Enregistrement"/);
    });

    it('the render wires RecapStep for recap and ConfirmeStep (original props) for confirme', () => {
        expect(RECEPTION).toMatch(/\{step === 'recap' && \(\s*<RecapStep/);
        expect(RECEPTION).toMatch(/\{step === 'confirme' && \(\s*<ConfirmeStep/);
        // ConfirmeStep keeps its original signature — no saving/onBack/onConfirm/onUpdate.
        expect(RECEPTION).toMatch(/function ConfirmeStep\(\{ draft, currency, linesTotal, pending, supplierName, onChangeSupplier, styles, palette \}/);
    });

    it('the header title is 3-way', () => {
        expect(RECEPTION).toMatch(/\{step === 'quoi' \? 'Ce qui est arrivé\.' : step === 'recap' \? 'C\\'est tout bon \?' : 'Enregistré'\}/);
    });
});

describe('Livraison redesign — (h) supplier dead ends fixed', () => {
    it('Bug A: the Fournisseurs header has a "+" action that opens the create form', () => {
        expect(FOURNISSEURS).toMatch(/accessibilityLabel="Nouveau fournisseur"/);
        expect(FOURNISSEURS).toMatch(/onPress=\{\(\) => \{ setEditF\(null\); setShowForm\(true\); \}\}/);
        expect(FOURNISSEURS).not.toMatch(/<View style=\{\{ width: 60 \}\} \/>\s*<\/View>\s*<\/View>\s*\{offline/);
    });

    it('Bug B: the picker sheet offers an inline "+ Nouveau fournisseur" form wired to createFournisseur', () => {
        expect(RECEPTION).toMatch(/\{\s*createFournisseur, saving: fSaving\s*\}/);
        expect(RECEPTION).toMatch(/>\+ Nouveau fournisseur<\/Text>/);
        expect(RECEPTION).toMatch(/await createFournisseur\(businessId, userId, \{ name: newName, phone: newPhone \}\)/);
        expect(RECEPTION).toMatch(/styles\.newSupplierForm/);
        expect(RECEPTION).toMatch(/newSupplierForm: \{ gap: spacing\[3\], paddingTop: spacing\[2\] \}/);
    });

    it('the picker sheet receives businessId + userId so the inline create can resolve a business/user', () => {
        expect(RECEPTION).toMatch(/<SupplierPickerSheet[\s\S]*?businessId=\{businessId\}[\s\S]*?userId=\{userId\}/);
    });
});

describe('Livraison redesign — (i) transport NULL-poisoning is guarded', () => {
    it('receive_purchase_order no longer nulls total_value_cents on a NULL unit_cost', () => {
        // The latest definition of receive_purchase_order (migration_v221) guards
        // the shipping-base accumulation: a "Prix inconnu" line (unit_cost NULL)
        // contributes nothing instead of NULL-poisoning total_value_cents.
        expect(MIGRATION).toMatch(
            /IF l\.unit_cost IS NOT NULL THEN\s*total_value_cents := total_value_cents \+ ROUND\(l\.unit_cost \* 100\)::bigint \* recv_qty;\s*END IF;/,
        );
        // The v218 unguarded standalone form (4-space indent, no IF guard) is gone.
        expect(MIGRATION).not.toMatch(
            /^    total_value_cents := total_value_cents \+ ROUND\(l\.unit_cost \* 100\)::bigint \* recv_qty;$/m,
        );
    });
});
