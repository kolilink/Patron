// Phase 6 intent wiring, checked at the source level (this repo has no
// component-render tests): switches fire toggle(newValue), FailureView files
// fire error exactly once per failure site, expo-haptics stays behind
// lib/haptics, and the removed tap() sites stay removed.
import * as fs from 'fs';
import * as path from 'path';

const root = path.resolve(__dirname, '..');
const read = (f: string) => fs.readFileSync(path.join(root, f), 'utf8');
const lines = (f: string) => read(f).split('\n');

describe('item 1 — switches fire haptics.toggle with the new value', () => {
  it('parametres: haptics master sets state first, then toggles', () => {
    const s = read('app/(app)/parametres/index.tsx');
    const body = s.slice(s.indexOf('const handleToggleHaptics'), s.indexOf('Per-sale push opt-out'));
    expect(body.indexOf('setEnabled(value)')).toBeGreaterThan(-1);
    expect(body.indexOf('haptics.toggle(value)')).toBeGreaterThan(body.indexOf('setEnabled(value)'));
  });
  it('parametres: notify-every-sale and payment reminders toggle', () => {
    const s = read('app/(app)/parametres/index.tsx');
    expect(s).toMatch(/setNotifyEverySale\(value\);\s*haptics\.toggle\(value\)/);
    expect(s).toMatch(/savePaymentRemindersPref\(true\)\) \{ haptics\.toggle\(true\)/);
  });
  it('catalogue variants + partner share-stock switches', () => {
    expect(read('app/(app)/(tabs)/catalogue.tsx')).toMatch(/onValueChange=\{v => \{\s*haptics\.toggle\(v\);/);
    expect(read('app/(app)/messages/[room_id].tsx')).toMatch(/onValueChange=\{v => \{ haptics\.toggle\(v\);/);
  });
});

describe('item 3 — FailureView files fire error exactly once per failure site', () => {
  const files = [
    'src/components/FounderDashboard.tsx',
    'app/(app)/(tabs)/vendre.tsx',
    'app/(app)/fournisseurs/[id].tsx',
  ];
  for (const f of files) {
    it(`${f}: every failure surface is directly preceded by one haptics.error()`, () => {
      const ls = lines(f);
      let sites = 0;
      ls.forEach((l, i) => {
        if (/^\s*import /.test(l)) return;
        if (/\b(failAlert|showFailureAlert)\(/.test(l)) {
          sites++;
          const sameLine = /haptics\.error\(\)/.test(l);
          const prev = ls.slice(Math.max(0, i - 2), i).join('\n');
          const hits = (sameLine ? 1 : 0) + (prev.match(/haptics\.error\(\)/g)?.length ?? 0);
          expect(`${f}:${i + 1} ${hits}`).toBe(`${f}:${i + 1} 1`);
        }
      });
      expect(sites).toBeGreaterThan(0);
      // …and no stray error haptic elsewhere in the file.
      expect((read(f).match(/haptics\.error\(\)/g) ?? []).length).toBe(sites);
    });
  }

  it('delete handlers fire destructive on commit and error on failure, never both up front', () => {
    for (const f of ['app/(app)/(tabs)/catalogue.tsx', 'app/(app)/ventes/index.tsx', 'app/(app)/fournisseurs/index.tsx', 'app/(app)/fournisseurs/[id].tsx', 'app/(app)/equipe/index.tsx']) {
      const ls = lines(f);
      ls.forEach((l, i) => {
        if (!/haptics\.destructive\(\)/.test(l)) return;
        const next = ls.slice(i + 1, i + 3).join('\n');
        // destructive must never be followed (before the result) by an awaited op on the same tap
        expect(`${f}:${i + 1} ${/await (archiveProduct|deleteFournisseur|removeMembre|removeScopeProduct|revokeCode)/.test(next)}`)
          .toBe(`${f}:${i + 1} false`);
      });
    }
  });
});

describe('contract', () => {
  it('expo-haptics is imported only by lib/haptics.ts', () => {
    const offenders: string[] = [];
    const walk = (d: string) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        if (['node_modules', '.git', '__tests__', '__mocks__'].includes(e.name)) continue;
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.tsx?$/.test(e.name) && /from 'expo-haptics'/.test(fs.readFileSync(p, 'utf8'))) offenders.push(path.relative(root, p));
      }
    };
    walk(root);
    expect(offenders).toEqual(['lib/haptics.ts']);
  });

  it('item 5: removed tap() sites stay removed (marche double-tap bodies, discussions copy)', () => {
    const m = read('app/(app)/marche/[id].tsx');
    expect(m).not.toMatch(/haptics\.tap\(\);\s*onLike(Comment)?\(\);/);
    expect(read('app/(app)/discussions.tsx')).not.toMatch(/setStringAsync\(code\);\s*haptics\.tap/);
  });
});
