// Clients → "En dette" with nobody owing: the empty state is a small
// celebration (the header already carries "Tout est réglé ✓"), not a dead
// end. It used to render a big « Effacer » button whose handler only reset
// the filter to 'tous' — the label promised a deletion the tap never did,
// in a money app, under the words "Aucune dette". Sebastiao flagged it from
// a device screenshot (2026-10-14) and chose: remove the button. The FAB
// (+ Client) already carries this screen's action. These contracts pin the
// vendor-visible shape so the lying button cannot come back.
import fs from 'fs';
import path from 'path';

const read = (p: string) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const CLIENTS = read('app/(app)/clients/index.tsx');

const slice = (src: string, start: string, end: string) => {
  const i = src.indexOf(start);
  return src.slice(i, src.indexOf(end, i));
};

describe('the "Aucune dette" empty state carries no action', () => {
  const block = slice(CLIENTS, 'title="Aucune dette"', '/>');

  it('the state itself is still there (icon, title, subtitle)', () => {
    expect(block).toContain('Aucun client ne vous doit.');
    expect(CLIENTS).toContain('checkmark-circle-outline');
  });

  it('renders no button — no actionLabel, no onAction', () => {
    expect(block).not.toContain('actionLabel');
    expect(block).not.toContain('onAction');
  });

  it('the word « Effacer » appears nowhere on the Clients screen', () => {
    expect(CLIENTS).not.toContain('Effacer');
  });
});
