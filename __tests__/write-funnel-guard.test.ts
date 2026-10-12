// No file outside the write pipeline writes to a Supabase table directly.
import fs from 'fs';
import path from 'path';
const { findDirectWriteViolations, LEGACY } = require('../scripts/lib/write-funnel.js');
const read = (p: string) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

describe('write funnel guard', () => {
  const r = findDirectWriteViolations();
  it('no direct .from().insert/update/upsert/delete outside the pipeline (exemptions carry a `funnel-exempt:` reason)', () => {
    expect(r.violations).toEqual([]);
  });
  it('the legacy ledger can only shrink: a ceiling above the real count must be lowered', () => {
    for (const [file, ceiling] of Object.entries(LEGACY)) expect((r.perFile[file] ?? []).length).toBe(ceiling);
  });
  it('every funnel-exempt comment names a reason', () => {
    for (const f of ['app/(app)/discussions.tsx', 'app/(app)/messages/[room_id].tsx', 'stores/chat.ts', 'src/utils/notifications.ts']) {
      for (const m of read(f).matchAll(/funnel-exempt:([^\n]*)/g)) expect(m[1].trim().length).toBeGreaterThan(10);
    }
  });
  it('the formerly-direct screens now go through the funnel', () => {
    const expects: Array<[string, RegExp]> = [
      ['app/(app)/(tabs)/vendre.tsx', /ensureClient\(/],
      ['app/(app)/onboarding/carnet.tsx', /ensureClient\(/],
      ['src/components/FirstRunHeroOverlay.tsx', /ensureClient\(/],
      ['src/components/CreditRapideCapture.tsx', /ensureClient\(/],
      ['app/(app)/clients/[name].tsx', /writeRow\(/],
      ['app/(app)/fournisseurs/[id].tsx', /writeRow\(/],
      ['app/(app)/parametres/index.tsx', /writeRow\(/],
    ];
    for (const [f, re] of expects) expect(read(f)).toMatch(re);
  });
  it('stores/components import enqueue/enqueueOnce from the funnel, not from lib/db / lib/outbox', () => {
    const offenders: string[] = [];
    const walk = (d: string) => { for (const e of fs.readdirSync(path.join(__dirname, '..', d), { withFileTypes: true })) {
      const rel = `${d}/${e.name}`;
      if (e.isDirectory()) walk(rel);
      else if (/\.tsx?$/.test(e.name)) {
        const s = read(rel);
        if (/import \{[^}]*\benqueue(Once)?\b[^}]*\} from '@\/lib\/(db|outbox)'/.test(s)) offenders.push(rel);
      }
    } };
    for (const d of ['app', 'src', 'stores']) walk(d);
    expect(offenders).toEqual([]);
  });
});
