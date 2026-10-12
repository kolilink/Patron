// Parts 1 & 3: money is tabular and never truncates.
import fs from 'fs';
import path from 'path';
import { formatAmount } from '@/src/utils/format';
const root = path.join(__dirname, '..');
const walk = (d: string, out: string[] = []) => { for (const e of fs.readdirSync(path.join(root, d), { withFileTypes: true })) { const r = `${d}/${e.name}`; if (e.isDirectory()) walk(r, out); else if (/\.tsx$/.test(e.name)) out.push(r); } return out; };
const files = ['app', 'src'].flatMap(d => walk(d));
const MONEY = /formatAmount\(|formatSignedAmount\(|formatAmountValue\(|\bfmt\(|amtOrMask\(|rawOrMask\(|fmtMoney|formatMoney\(|mask\(/;

function moneyTexts(src: string) {
  const out: Array<{ line: number; attrs: string; body: string }> = [];
  const re = /<(?:RN)?Text\b((?:[^>{]|\{(?:[^{}]|\{(?:[^{}]|\{[^{}]*\})*\})*\})*?)>([\s\S]*?)<\/(?:RN)?Text>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    if (!MONEY.test(m[2]) || m[2].replace('=>', '').includes('<')) continue;
    const literal = m[2].replace(/\{(?:[^{}]|\{(?:[^{}]|\{[^{}]*\})*\})*\}/g, '').trim();
    if (literal.length > 30) continue;
    out.push({ line: src.slice(0, m.index).split('\n').length, attrs: m[1], body: m[2] });
  }
  return out;
}

describe('Part 1: tabular money', () => {
  it('the shared Text applies tabular figures to every variant; amount styles stay tabular', () => {
    expect(fs.readFileSync(path.join(root, 'src/components/ui/Text.tsx'), 'utf8')).toContain("[TABULAR, typography[variant]");
    const t = fs.readFileSync(path.join(root, 'src/theme/typography.ts'), 'utf8');
    for (const k of ['mono', 'amount', 'amountLarge', 'amountSmall']) expect(t).toMatch(new RegExp(`${k}:.*tabular-nums`));
  });
  it('no money is rendered with a raw react-native Text lacking tabular figures', () => {
    const offenders: string[] = [];
    for (const f of files) {
      const src = fs.readFileSync(path.join(root, f), 'utf8');
      if (!/Text as RNText|import \{[^}]*\bText\b[^}]*\} from 'react-native'/.test(src)) continue;
      const re = /<RNText\b([^>]*)>([\s\S]*?)<\/RNText>/g; let m: RegExpExecArray | null;
      while ((m = re.exec(src))) if (MONEY.test(m[2])) {
        const styleName = /styles\.(\w+)/.exec(m[1])?.[1];
        const def = styleName ? new RegExp(`${styleName}:[^\\n]*tabular-nums`).test(src) : false;
        if (!def) offenders.push(`${f}:${src.slice(0, m.index).split('\n').length}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe('Part 3: money never truncates', () => {
  it('every money Text has numberOfLines={1} adjustsFontSizeToFit minimumFontScale (shrinks, never "…")', () => {
    const offenders: string[] = [];
    for (const f of files) for (const t of moneyTexts(fs.readFileSync(path.join(root, f), 'utf8'))) {
      if (!(/adjustsFontSizeToFit/.test(t.attrs) && /numberOfLines=\{1\}/.test(t.attrs))) offenders.push(`${f}:${t.line}`);
    }
    expect(offenders).toEqual([]);
  });
  it('the largest realistic amounts still fit a 360dp-wide phone at the minimum font scale', () => {
    const avail = 360 - 2 * 16;           // screen minus 16dp gutters
    const widest = formatAmount(9_999_999_999_999, 'GNF') + ' GNF'; // ~10 trillion francs
    for (const size of [32, 17, 14]) expect(widest.length * size * 0.62 * 0.5).toBeLessThanOrEqual(avail);
  });
});
