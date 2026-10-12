// P0: offline add/edit must never silently lose Modèles (variants). Source-level (no component-render harness here).
import * as fs from 'fs';
import * as path from 'path';
import { FAILURE_COPY } from '@/src/utils/failureCopy';
import { vocabularyProblems } from '@/src/utils/failure';

const read = (f: string) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const sheet = read('src/components/QuickAddProductSheet.tsx');
const hook = read('src/components/products/useProductSheets.tsx');

describe('Modèles toggle offline', () => {
  it('add flow (any mode): the toggle is not rendered while offline', () => {
    expect(sheet).toContain('const offline = useConnectivityStore(() => isKnownOffline());');
    expect(sheet).toMatch(/\{offline && isEdit \? \([\s\S]*?\) : !offline && \(\s*\n\s*<Card style=\{styles\.toggleRow\}>[\s\S]*?onValueChange=\{onToggleModels\}/);
  });
  it('Modèles already on when the connection drops is switched off, never saved silently', () => {
    expect(sheet).toMatch(/if \(offline && !isEdit && s\.models\) setS\(prev => setModels\(prev, false\)\)/);
  });
  it('edit flow: switch disabled with the honest note, model rows not interactive', () => {
    expect(sheet).toContain('Modèles : connexion requise');
    expect(sheet).toMatch(/<Switch value=\{s\.models\} disabled/);
    expect(sheet).toContain("pointerEvents={offline ? 'none' : 'auto'}");
  });
});

describe('the variant RPC is never attempted offline and its result is never ignored', () => {
  it('add and edit both short-circuit on isKnownOffline() before upsertVariants', () => {
    const calls = hook.match(/isKnownOffline\(\) \? false : await upsertVariants\(/g) ?? [];
    expect(calls).toHaveLength(2);
    expect(hook).not.toMatch(/^\s*await upsertVariants\(/m);
  });
  it('edit: product queued but models not saved → honest alert, not "productNotSaved"', () => {
    expect(hook).toMatch(/if \(!variantsOk\) \{[\s\S]*?modelsNotSavedAlert\(\);[\s\S]*?return \{ ok: true \};/);
    expect(hook).toMatch(/what: FAILURE_COPY\.productSavedModelsNot\.what/);
  });
});

describe('alert copy', () => {
  it('is exact and passes the failure vocabulary', () => {
    expect(FAILURE_COPY.productSavedModelsNot.what).toBe('Produit enregistré. Modèles non enregistrés — connexion requise.');
    expect(vocabularyProblems({ what: FAILURE_COPY.productSavedModelsNot.what })).toEqual([]);
  });
});
