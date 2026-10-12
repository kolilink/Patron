import * as fs from 'fs';
import * as path from 'path';
const read = (p: string) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

describe('Fournisseurs: no draft banner, draft still resumable', () => {
  const idx = read('app/(app)/fournisseurs/index.tsx');
  const rec = read('app/(app)/fournisseurs/reception.tsx');
  it('banner, its state, style and peek import are gone', () => {
    expect(idx).not.toMatch(/draftBanner|draftPeek|peekReceptionDraft|Brouillon —|fmtDraftDate/);
  });
  it('Livraison FAB and "Nouvelle livraison" link still route to /reception (no params)', () => {
    expect(idx.match(/router\.push\('\/\(app\)\/fournisseurs\/reception'\)/g)!.length).toBeGreaterThanOrEqual(2);
  });
  it('draft save/load logic is untouched: reception auto-loads the draft', () => {
    expect(rec).toContain('loadDraft');
    expect(rec).toContain('export async function peekReceptionDraft');
  });
});
