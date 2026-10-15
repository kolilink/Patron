// Audit 2026-10-14 (the « Effacer » class): labels and states must never
// promise what the tap doesn't do, and unknown money must never render as 0.
// Sebastiao ordered every finding fixed, with its interconnections. These
// contracts pin the vendor-visible shape of each fix.
import fs from 'fs';
import path from 'path';

const read = (p: string) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const HOME = read('app/(app)/(tabs)/index.tsx');
const EQUIPE = read('app/(app)/equipe/index.tsx');
const NO_RESULTS = read('src/components/ui/NoResultsState.tsx');
const FIRST_RUN = read('src/components/FirstRunHeroOverlay.tsx');
const DRAWER = read('src/components/BusinessDrawer.tsx');
const VENDRE = read('app/(app)/(tabs)/vendre.tsx');

const slice = (src: string, start: string, end: string) => {
  const i = src.indexOf(start);
  return src.slice(i, src.indexOf(end, i));
};

describe('unknown money never renders as 0 (HIGH x2 + MEDIUM)', () => {
  it('no screen coerces the investor balance to 0 anymore', () => {
    expect(HOME).not.toContain('balance ?? 0');
    expect(EQUIPE).not.toContain('balance ?? 0');
  });

  it('both balance heroes pass the unknown through to the « — » guard', () => {
    expect(HOME).toContain('amount={balance ?? NaN}');
    expect(EQUIPE).toContain('amount={balance ?? NaN}');
  });

  it('the withdraw button shows only for a KNOWN positive balance', () => {
    expect(HOME).toContain('balance !== null && balance > 0');
  });

  it('the withdraw sheet Disponible line goes through amountText (— when unknown)', () => {
    expect(HOME).toContain('Disponible : {amountText(balance, currency)}');
  });

  it('the payout submit never validates against a fabricated 0 balance', () => {
    expect(HOME).toContain("if (balance === null) { toast.warning('Solde indisponible — réessayez'); return; }");
    expect(HOME).toContain('if (amt > balance)');
  });
});

describe('NoResultsState never promises a creation it does not offer', () => {
  it('the « ou créez-le » half of the subtitle is gated on a create action', () => {
    expect(NO_RESULTS).toContain('hasCreate ? "Vérifiez l\'orthographe ou créez-le." : "Vérifiez l\'orthographe."');
  });
});

describe('first-run credit button names its effect (MEDIUM)', () => {
  it('the bare « Enregistrer » is gone; the button says what it commits', () => {
    expect(FIRST_RUN).toContain('label="Enregistrer ce crédit"');
    expect(FIRST_RUN).not.toContain('label="Enregistrer"');
  });
});

describe('Équipe › Membres uses the shared states with the locked copy (MEDIUM x2)', () => {
  it('no-results goes through NoResultsState', () => {
    expect(EQUIPE).toContain('<NoResultsState query={search} />');
  });

  it('the empty state goes through EmptyState, titled « pour le moment »', () => {
    expect(EQUIPE).toContain('title="Aucun membre pour le moment"');
    expect(EQUIPE).toContain('actionLabel="+ Inviter quelqu\'un"');
    const membresBlock = slice(EQUIPE, "effectiveTab === 'membres'", 'MEMBER_GROUPS');
    expect(membresBlock).not.toContain("pour l'instant");
  });
});

describe('BusinessDrawer no-results uses the shared component (LOW)', () => {
  it('renders NoResultsState and no hand-rolled copy remains', () => {
    expect(DRAWER).toContain('<NoResultsState query={search} />');
    expect(DRAWER).not.toContain('Aucun résultat pour');
    expect(DRAWER).not.toContain('emptySearch');
  });
});

describe('variant sheet button names its effect (LOW)', () => {
  it('« Confirmer » became « Ajouter au panier » on the variant sheet', () => {
    expect(VENDRE).toContain('label="Ajouter au panier"');
    expect(VENDRE).not.toContain('label="Confirmer"');
  });
});
