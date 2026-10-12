import fs from 'fs';
import path from 'path';
const root = path.join(__dirname, '..');
const walk = (d: string, out: string[] = []) => { for (const e of fs.readdirSync(path.join(root, d), { withFileTypes: true })) { const r = `${d}/${e.name}`; if (e.isDirectory()) walk(r, out); else if (/\.tsx?$/.test(e.name)) out.push(r); } return out; };
const files = ['app', 'src'].flatMap(d => walk(d));

describe('Part 4: loading is words + dots, never a lone spinner', () => {
  it('zero ActivityIndicator usages', () => {
    expect(files.filter(f => /ActivityIndicator/.test(fs.readFileSync(path.join(root, f), 'utf8')))).toEqual([]);
  });
});

describe('Part 5: motion must mean something', () => {
  it('every infinite loop carries a `motion-means:` reason, and only meaningful ones remain', () => {
    const loops: string[] = [];
    for (const f of files) {
      const lines = fs.readFileSync(path.join(root, f), 'utf8').split('\n');
      lines.forEach((l, i) => {
        if (/Animated\.loop\(|withRepeat\(/.test(l)) {
          const ok = /motion-means:\s*\S{3,}/.test(lines.slice(Math.max(0, i - 4), i).join('\n'));
          loops.push(`${f}:${i + 1}${ok ? '' : ' MISSING-REASON'}`);
        }
      });
    }
    expect(loops.filter(l => l.includes('MISSING'))).toEqual([]);
    expect(loops.map(l => l.split(':')[0]).sort()).toEqual([
      'app/(app)/alpha/index.tsx', 'app/(app)/discussions.tsx', 'app/(app)/messages/[room_id].tsx',
      'app/(app)/rapports/index.tsx', 'app/(app)/ventes/index.tsx',
      'src/components/ui/LoadingStatus.tsx', 'src/components/ui/PhoneInput.tsx', 'src/components/ui/SkeletonPlaceholder.tsx',
    ]);
  });
});
