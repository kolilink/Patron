// No silent deletes: undo where it can exist (archive is a flag flip, so
// Annuler = restoreProduct), otherwise a message naming exactly what went.

import fs from 'fs';
import path from 'path';
import {
  archivedConfirmation, saleCancelledConfirmation, supplierDeletedConfirmation, memberRemovedConfirmation,
  inviteCodeRevokedConfirmation, stakeRemovedConfirmation, partnerRemovedConfirmation,
} from '@/src/utils/saveConfirmationCopy';
import { vocabularyProblems } from '@/src/utils/failure';
import { FAILURE_COPY } from '@/src/utils/failureCopy';

const read = (rel: string) => fs.readFileSync(path.resolve(__dirname, '..', rel), 'utf8');

describe('messages name exactly what was deleted', () => {
  const nbsp = (s: string) => s.replace(/ /g, ' ');
  it('every kind', () => {
    expect(archivedConfirmation('Riz 5kg')).toBe('Riz 5kg désactivé.');
    expect(nbsp(saleCancelledConfirmation(45000, 'GNF', 'Aïssatou'))).toBe('Vente annulée : Aïssatou, 45 000 GNF.');
    expect(nbsp(saleCancelledConfirmation(45000, 'GNF'))).toBe('Vente annulée : 45 000 GNF.');
    expect(supplierDeletedConfirmation('Mamadou Diallo')).toBe('Fournisseur supprimé : Mamadou Diallo.');
    expect(memberRemovedConfirmation('Fatou')).toBe("Fatou retiré de l'équipe.");
    expect(inviteCodeRevokedConfirmation()).toBe("Code d'invitation révoqué.");
    expect(stakeRemovedConfirmation('Riz', 'Fatou')).toBe('Riz retiré pour Fatou.');
    expect(partnerRemovedConfirmation('Boutique B')).toBe('Partenaire retiré : Boutique B.');
  });
  it('the failure side of each delete follows the failure vocabulary', () => {
    for (const k of ['productNotArchived', 'saleNotCancelled', 'supplierNotDeleted', 'memberNotRemoved', 'codeNotRevoked'] as const) {
      expect(vocabularyProblems({ what: FAILURE_COPY[k].what })).toEqual([]);
    }
  });
});

describe('where each delete says something (source contract)', () => {
  it('product archive: Annuler = restoreProduct; a failure speaks with Réessayer', () => {
    const src = read('app/(app)/(tabs)/catalogue.tsx');
    expect(src).toMatch(/message: archivedConfirmation\(product\.name\),[\s\S]*?undo: async \(\) => \{ await restoreProduct\(product\.id, businessId, userId\); \}/);
    expect(src).toMatch(/failAlert\('productNotArchived'/);
    expect(read('stores/products.ts')).toMatch(/archiveProduct: \(id: string, businessId: string\) => Promise<boolean>/);
  });
  it('supplier (detail and list): a toast naming the supplier; no pretend undo', () => {
    const detail = read('app/(app)/fournisseurs/[id].tsx');
    expect(detail).toMatch(/toast\.success\(supplierDeletedConfirmation\(supplierName\)\)/);
    expect(detail).toMatch(/failAlert\('supplierNotDeleted'/);
    const list = read('app/(app)/fournisseurs/index.tsx');
    expect(list).toMatch(/if \(ok\) toast\.success\(supplierDeletedConfirmation\(item\.name\)\)/);
  });
  it('team: revoking a member / a code / a product stake names what went', () => {
    const src = read('app/(app)/equipe/index.tsx');
    expect(src).toMatch(/toast\.success\(memberRemovedConfirmation\(/);
    expect(src).toMatch(/toast\.success\(inviteCodeRevokedConfirmation\(\)\)/);
    expect(src).toMatch(/toast\.success\(stakeRemovedConfirmation\(/);
    expect(src).toMatch(/failAlert\('memberNotRemoved'/);
    expect(src).toMatch(/failAlert\('codeNotRevoked'/);
  });
  it('sale cancellation: names the sale; a failure speaks (it used to do nothing)', () => {
    const src = read('app/(app)/ventes/index.tsx');
    expect(src).toMatch(/toast\.success\(saleCancelledConfirmation\(/);
    expect(src).toMatch(/failAlert\('saleNotCancelled'/);
  });
  it('partner removal names the partner', () => {
    expect(read('app/(app)/messages/[room_id].tsx')).toMatch(/toast\.success\(partnerRemovedConfirmation\(/);
  });
});
