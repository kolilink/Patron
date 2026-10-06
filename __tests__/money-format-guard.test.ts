// Permanent guard: money is turned into text in exactly one file
// (src/utils/format.ts). Anything else that formats a number with a locale,
// toFixed, a hand-rolled thousands regex, or a manual "+" sign fails here, so
// invented precision (e.g. "333,333 GNF") cannot be reintroduced quietly.
//
// Scope: app/, src/, stores/, lib/. The Deno edge functions keep their own
// formatters (separate runtime, deployed separately) and are not scanned.
// Date formatting (toLocaleDateString/TimeString) is a different method name
// and is Phase 7's concern, not this guard's.

import fs from 'fs';
import path from 'path';

const ROOT = path.resolve(__dirname, '..');
const SCAN_DIRS = ['app', 'src', 'stores', 'lib'];
const CHOKE_POINT = path.join('src', 'utils', 'format.ts');

const RULES: { name: string; re: RegExp }[] = [
  { name: 'Number#toLocaleString', re: /\.toLocaleString\s*\(/ },
  { name: 'Intl.NumberFormat', re: /Intl\s*\.\s*NumberFormat/ },
  { name: 'toFixed/toPrecision', re: /\.(toFixed|toPrecision)\s*\(/ },
  { name: 'hand-rolled thousands grouping', re: /\\B\(\?=\(\\d\{3\}\)/ },
  { name: "manual '+' sign", re: /\?\s*['"`]\+['"`]\s*:\s*(['"`]{2}|``)/ },
];

// Files that legitimately format NON-money numbers with a flagged method.
// Each entry must still match something (asserted below) so this can't rot.
const NON_MONEY_ALLOWLIST: Record<string, { rules: string[]; reason: string }> = {
  [path.join('src', 'utils', 'founderKpis.ts')]: { rules: ['toFixed/toPrecision'], reason: 'retention percentages' },
};

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(entry.name)) out.push(full);
  }
  return out;
}

function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');
}

export function findMoneyFormatViolations(rel: string, src: string): string[] {
  if (rel === CHOKE_POINT) return [];
  const code = stripComments(src);
  const hits: string[] = [];
  code.split('\n').forEach((line, i) => {
    for (const rule of RULES) {
      if (rule.re.test(line)) hits.push(`${rel}:${i + 1} [${rule.name}] ${line.trim()}`);
    }
  });
  return hits;
}

describe('money-format guard', () => {
  it('detector works: each forbidden pattern is caught in a synthetic bad file', () => {
    const bad = [
      "const a = n.toLocaleString('fr-FR');",
      "const b = new Intl.NumberFormat('fr-FR').format(n);",
      'const c = n.toFixed(2);',
      "const d = s.replace(/\\B(?=(\\d{3})+(?!\\d))/g, ' ');",
      "const e = `${p >= 0 ? '+' : ''}${p}`;",
    ].join('\n');
    expect(findMoneyFormatViolations('app/x.tsx', bad)).toHaveLength(5);
    expect(findMoneyFormatViolations('app/x.tsx', "// n.toLocaleString('fr-FR')\n/* n.toFixed(2) */")).toHaveLength(0);
    expect(findMoneyFormatViolations('app/x.tsx', "d.toLocaleDateString('fr-FR')")).toHaveLength(0);
  });

  it('zero money-formatting bypasses outside src/utils/format.ts', () => {
    const violations: string[] = [];
    const seenAllowlisted = new Set<string>();
    for (const dir of SCAN_DIRS) {
      for (const file of walk(path.join(ROOT, dir))) {
        const rel = path.relative(ROOT, file);
        const found = findMoneyFormatViolations(rel, fs.readFileSync(file, 'utf8'));
        const allow = NON_MONEY_ALLOWLIST[rel];
        for (const v of found) {
          if (allow && allow.rules.some(r => v.includes(`[${r}]`))) { seenAllowlisted.add(rel); continue; }
          violations.push(v);
        }
      }
    }
    expect(violations).toEqual([]);
    // Allowlist entries must still be needed.
    expect([...seenAllowlisted].sort()).toEqual(Object.keys(NON_MONEY_ALLOWLIST).sort());
  });
});
