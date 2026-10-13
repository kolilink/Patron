// Part 2: every tappable is >= 48dp; where the visual is smaller, hitSlop bridges the gap.
import fs from 'fs';
import path from 'path';
const root = path.join(__dirname, '..');
const walk = (d: string, out: string[] = []) => { for (const e of fs.readdirSync(path.join(root, d), { withFileTypes: true })) { const r = `${d}/${e.name}`; if (e.isDirectory()) walk(r, out); else if (/\.tsx$/.test(e.name)) out.push(r); } return out; };

describe('touch targets', () => {
  it('Button never goes below 48dp', () => {
    const b = fs.readFileSync(path.join(root, 'src/components/ui/Button.tsx'), 'utf8');
    for (const m of b.matchAll(/size_\w+:[^\n]*minHeight:\s*(\d+)/g)) expect(Number(m[1])).toBeGreaterThanOrEqual(48);
  });
  it('no Pressable with an explicit size under 48dp (or an icon-only body) lacks a bridging hitSlop', () => {
    const offenders: string[] = [];
    for (const f of ['app', 'src'].flatMap(d => walk(d))) {
      const s = fs.readFileSync(path.join(root, f), 'utf8');
      const re = /<(Pressable|TouchableOpacity)\b((?:[^>{]|\{(?:[^{}]|\{(?:[^{}]|\{[^{}]*\})*\})*\})*?)>([\s\S]*?)<\/\1>/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(s))) {
        const [, , attrs, body] = m;
        const hs = /hitSlop=\{(\d+)\}/.exec(attrs); const slop = hs ? Number(hs[1]) : /hitSlop/.test(attrs) ? 99 : 0;
        const defs = [...attrs.matchAll(/styles\.(\w+)/g)].map(x => new RegExp(`${x[1]}:\\s*\\{([^}]*)\\}`).exec(s)?.[1] ?? '');
        const dims = [...(defs.join(' ') + ' ' + attrs).matchAll(/\b(?:width|height|minWidth|minHeight)\s*:\s*(\d+)/g)].map(x => Number(x[1])).filter(n => n < 48 && n > 4);
        const iconOnly = /Ionicons|Icon/.test(body) && !/<(?:Text|MoneyText|Money|Button)\b/.test(body);
        if ((dims.length && slop < (48 - Math.min(...dims)) / 2) || (iconOnly && !dims.length && slop === 0)) {
          offenders.push(`${f}:${s.slice(0, m.index).split('\n').length}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
