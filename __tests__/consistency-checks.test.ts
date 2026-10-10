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
  findFunctionExposureViolations,
  findResurrectedForkViolations,
  findHeroModalFadeViolations,
  findSystemAlertViolations,
  findSkeletonViolationsInSource,
  findSkeletonOutsideDataStateViolations,
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

  it('no-resurrected-fork: ActivationForkOverlay appears nowhere under app/ or src/', () => {
    expect(findResurrectedForkViolations()).toEqual([]);
  });

  it('no-system-alert: no Alert.alert( anywhere in app/src/stores/lib — use appAlert()', () => {
    expect(findSystemAlertViolations()).toEqual([]);
  });

  it('hero-modal-no-fade: FirstRunHeroOverlay Modal is animationType="none"', () => {
    expect(findHeroModalFadeViolations()).toEqual([]);
  });

  // The batch-v228 bug class: a public function with no auth check and no
  // REVOKE ... FROM anon is callable by anyone with the public anon key.
  it('no db/ function is anon-callable without an auth check or a REVOKE FROM anon', () => {
    expect(findFunctionExposureViolations()).toEqual([]);
  });

  // Data-state invariant (CLAUDE.md): a skeleton renders only as DataState's
  // `skeleton` slot, so a loaded-but-empty list can never replay one.
  it('data-state-invariant: no Skeleton* is rendered outside <DataState>', () => {
    expect(findSkeletonOutsideDataStateViolations()).toEqual([]);
  });

  describe('data-state-invariant detector', () => {
    it('fails a hand-rolled `loading && list.length === 0` skeleton gate', () => {
      const handRolled = [
        'function Screen() {',
        '  return (',
        '    <View>',
        '      {loading && products.length === 0 ? (',
        '        <SkeletonList count={8} />',
        '      ) : products.length === 0 ? <Empty /> : <List />}',
        '    </View>',
        '  );',
        '}',
      ].join('\n');
      expect(findSkeletonViolationsInSource(handRolled)).toHaveLength(1);
    });

    it('fails a bare local skeleton component usage and a ternary one-liner', () => {
      expect(findSkeletonViolationsInSource('const a = loading ? <ValueSkeleton /> : null;')).toHaveLength(1);
      expect(findSkeletonViolationsInSource('{!rows ? <View><SkeletonKpiGrid /></View> : null}')).toHaveLength(1);
    });

    it('passes a skeleton passed as <DataState>\'s skeleton slot', () => {
      const ok = [
        '<DataState',
        '  status={fetchStatus}',
        '  isEmpty={products.length === 0}',
        '  skeleton={<SkeletonList count={8} />}',
        '  empty={<Empty />}',
        '>',
        '  <List />',
        '</DataState>',
      ].join('\n');
      expect(findSkeletonViolationsInSource(ok)).toEqual([]);
    });

    it('a skeleton= prop on something that is not DataState does not count', () => {
      expect(findSkeletonViolationsInSource('<Other skeleton={<SkeletonList />} />')).toHaveLength(1);
    });

    it('allows skeleton components composing other skeletons inside their own definition', () => {
      const composed = [
        'function SkeletonLine() { return null; }',
        'function DetailSkeleton() {',
        '  return (<View><SkeletonLine width="40%" /></View>);',
        '}',
      ].join('\n');
      expect(findSkeletonViolationsInSource(composed)).toEqual([]);
    });
  });
});
