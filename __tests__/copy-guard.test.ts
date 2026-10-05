// Audience-hardening guards (phase 7):
//  (a) one date system: toLocaleDateString lives only in src/utils/dates.ts;
//  (b) banned copy literals never come back in UI strings.

import fs from 'fs';
import path from 'path';

const ROOT = path.resolve(__dirname, '..');
const SCAN = ['app', 'src', 'stores', 'lib'];

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(e.name)) out.push(full);
  }
  return out;
}

function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');
}

const files = SCAN.flatMap(d => walk(path.join(ROOT, d)));
const rel = (f: string) => path.relative(ROOT, f);

export function findPatternHits(src: string, re: RegExp): string[] {
  const hits: string[] = [];
  stripComments(src).split('\n').forEach((line, i) => { if (re.test(line)) hits.push(`${i + 1}: ${line.trim()}`); });
  return hits;
}

describe('one date system', () => {
  it('bans toLocaleDateString outside src/utils/dates.ts', () => {
    const offenders = files
      .filter(f => rel(f) !== path.join('src', 'utils', 'dates.ts'))
      .flatMap(f => findPatternHits(fs.readFileSync(f, 'utf8'), /toLocaleDateString\s*\(/).map(h => `${rel(f)}:${h}`));
    expect(offenders).toEqual([]);
  });

  it('the guard catches a violation', () => {
    expect(findPatternHits("const s = d.toLocaleDateString('fr-FR');", /toLocaleDateString\s*\(/)).toHaveLength(1);
  });
});

describe('banned copy literals', () => {
  const BANNED = /Créer mon commerce|Créer un commerce|[mM]a boutique|Pas de connexion/;
  // The settled failure vocabulary owns its own "Pas de connexion." wording
  // (the *why* of a failed write) and the three read-cache messages in stores.
  const EXEMPT = new Set([
    path.join('src', 'utils', 'failureCopy.ts'),
    path.join('src', 'utils', 'failure.ts'),
    path.join('stores', 'expenses.ts'),
    path.join('stores', 'ventes.ts'),
    path.join('stores', 'products.ts'),
  ]);

  it('never appears in a UI string (tsx)', () => {
    const offenders = files
      .filter(f => f.endsWith('.tsx') && !EXEMPT.has(rel(f)))
      .flatMap(f => findPatternHits(fs.readFileSync(f, 'utf8'), BANNED).map(h => `${rel(f)}:${h}`));
    expect(offenders).toEqual([]);
  });

  it('the guard catches a violation', () => {
    expect(findPatternHits('label="Créer mon commerce"', BANNED)).toHaveLength(1);
  });
});
