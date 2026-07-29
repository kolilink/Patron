// Runs the pre-merge consistency checks (scripts/lib/consistency-checks.js)
// as a Jest test too, not just via `npm run check`'s separate script step —
// so CI configs that only run `npm test` (this project's currently do, see
// .github/workflows/ci.yml) still catch a regression, not only a local
// `npm run check`.

const {
  findHexViolations,
  findScreenViolations,
  findUnprotectedFetchViolations,
  findRawModalWithTextInputViolations,
} = require('../scripts/lib/consistency-checks');

describe('consistency checks', () => {
  it('has no hardcoded hex colors outside src/theme/', () => {
    expect(findHexViolations()).toEqual([]);
  });

  it('every screen under app/ uses <Screen> as its root', () => {
    expect(findScreenViolations()).toEqual([]);
  });

  // Regression guard for the exact bug class documented in CLAUDE.md under
  // "Offline read caches": a store fetch function can have a perfectly
  // correct isNetworkError()-gated cache fallback and still leave the
  // screen stuck loading forever, because on some real network conditions
  // the underlying fetch hangs instead of rejecting — the catch block that
  // would fall back to cache never runs unless the call is wrapped in
  // withTimeout(). This shipped more than once (products, ventes, apports,
  // fournisseurs, rapports, then a second wave across auth/investor/chat/
  // market/partnerships/supportChat/alpha) before withTimeout() existed
  // specifically to close it. A new store fetch that reintroduces the same
  // gap should fail here, not get discovered again via a live device report.
  it('every store fetch with an offline-cache fallback is wrapped in withTimeout()', () => {
    expect(findUnprotectedFetchViolations()).toEqual([]);
  });

  // Regression guard for the Android keyboard-flicker bug (see FormSheet.tsx
  // and CLAUDE.md): a raw <Modal> containing a <TextInput> opens a separate
  // native window that isn't edge-to-edge aware unless
  // statusBarTranslucent/navigationBarTranslucent are set. <FormSheet> is the
  // one place that sets both, so every form-style modal must go through it
  // instead of a bare <Modal> — this fails if a future screen reaches for
  // raw <Modal> for a form the way "Nouveau produit" originally did.
  it('every <Modal> containing a <TextInput> uses <FormSheet> instead of a raw Modal', () => {
    expect(findRawModalWithTextInputViolations()).toEqual([]);
  });
});
