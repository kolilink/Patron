// Part 6: floating chrome positions off the REAL safe-area insets, never fixed edge margins.
import fs from 'fs';
import path from 'path';
import { floatingTabBarClearance, FLOATING_TAB_BAR_GAP, FLOATING_TAB_BAR_HEIGHT } from '@/src/theme/spacing';
const read = (p: string) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

// Device configs: [name, insets.top, insets.bottom, width]
const DEVICES: Array<[string, number, number, number]> = [
  ['iPhone 15 (Dynamic Island + home indicator)', 59, 34, 393],
  ['iPhone SE (no notch, no indicator)', 20, 0, 375],
  ['Android 3-button nav, 360dp', 24, 48, 360],
  ['Android gesture nav, punch-hole', 32, 16, 360],
];

describe('tab-bar clearance follows the live inset', () => {
  it.each(DEVICES)('%s: elements above the bar clear its top edge', (_n, _t, bottom) => {
    const barTop = bottom + FLOATING_TAB_BAR_GAP + FLOATING_TAB_BAR_HEIGHT;
    expect(floatingTabBarClearance(bottom)).toBeGreaterThanOrEqual(barTop);
  });
});

describe('no hardcoded edge margins on floating chrome', () => {
  it('Vendre (cart panel, FAB cluster, grid padding) and Gérer clear the live inset, not the bare constant', () => {
    const v = read('app/(app)/(tabs)/vendre.tsx');
    const screen = v.slice(v.indexOf('export default function VendreScreen'), v.indexOf('function makeStyles'));
    expect(screen).not.toMatch(/FLOATING_TAB_BAR_CLEARANCE/);
    expect(screen).toContain('floatingTabBarClearance(insets.bottom)');
    const pm = read('src/components/products/ProductManager.tsx');
    expect(pm).toContain('floatingTabBarClearance(insets.bottom)');
    expect(pm.slice(pm.indexOf('export function ProductManager'))).not.toMatch(/paddingBottom: FLOATING_TAB_BAR_CLEARANCE/);
  });
  it('stack-screen FABs sit at insets.bottom + spacing, not bottom: 24/194', () => {
    for (const f of ['app/(app)/clients/index.tsx', 'app/(app)/fournisseurs/index.tsx', 'app/(app)/ventes/index.tsx', 'app/(app)/depenses/index.tsx']) {
      const s = read(f);
      expect(s).toContain('bottom: insets.bottom + spacing[6]');
      expect(s).toContain('useSafeAreaInsets');
    }
  });
  it('full-screen photo viewers place the close button off insets.top on every platform', () => {
    for (const f of ['src/components/ui/ProofPhotoField.tsx', 'src/components/ui/ProofControl.tsx', 'src/components/ui/ProofThumbnail.tsx', 'src/components/ui/ImageMessageBubble.tsx']) {
      expect(read(f)).toContain('const closeTop = insets.top + 12');
    }
  });
  it('bottom sheets/CTAs that were pinned add the live bottom inset', () => {
    expect(read('app/(app)/fournisseurs/[id].tsx')).toContain('Math.max(insets.bottom, spacing[4])');
    expect(read('app/(app)/(tabs)/vendre.tsx')).toContain('paddingBottom: Math.max(insets.bottom, spacing[4]) + spacing[6]');
  });
  it('precedent components still read the real insets', () => {
    for (const f of ['src/components/ui/Toast.tsx', 'src/components/ui/FormSheet.tsx', 'src/components/ui/SyncStatusLine.tsx']) expect(read(f)).toMatch(/useSafeAreaInsets/);
  });
});
