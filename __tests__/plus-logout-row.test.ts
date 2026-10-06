// Plus tab: the big red "Se déconnecter" button became a quiet row (Meta-style).
// Only the visual changed — handleLogout and its confirmation Alert are untouched.
import fs from 'fs';
import path from 'path';

const src = fs.readFileSync(path.resolve(__dirname, '../app/(app)/(tabs)/plus.tsx'), 'utf8');
const code = src.split('\n').filter(l => !l.trim().startsWith('//') && !l.trim().startsWith('{/*') && !l.trim().startsWith('*')).join('\n');

describe('Plus tab logout row', () => {
  it('the full-width danger Button is gone', () => {
    expect(code).not.toMatch(/variant="danger"/);
    expect(code).not.toMatch(/<Button\b/);
    expect(src).not.toMatch(/import \{ Button \}/);
  });
  it('is one plain Pressable row inside the same elevated, un-padded card as the other sections', () => {
    expect(src).toMatch(/<Card padded=\{false\} elevated style=\{styles\.menuGroup\}>\s*<Pressable\s+onPress=\{handleLogout\}\s+style=\{\(\{ pressed \}\) => \[styles\.menuRow, pressed && styles\.menuRowPressed\]\}/);
  });
  it('shows "Se déconnecter" in the danger text color, with NO icon and NO chevron', () => {
    const m = src.match(/onPress=\{handleLogout\}[\s\S]*?<\/Pressable>/);
    expect(m).not.toBeNull();
    const row = m![0];
    expect(row).toMatch(/<Text variant="label" color="danger">Se déconnecter<\/Text>/);
    expect(row).not.toMatch(/Ionicons/);
  });
  it('the confirmation Alert flow is unchanged', () => {
    expect(src).toMatch(/'Se déconnecter \?'/);
    expect(src).toMatch(/\{ text: 'Se déconnecter', style: 'destructive', onPress: \(\) => \{ void logout\(\); \} \}/);
    expect(src).toMatch(/Vous devrez recevoir un nouveau code WhatsApp/);
  });
});
