// Drawer feel (2026-10-16, his comparison): Patron's business drawer felt
// "resistant" next to a native drawer — it animated on fixed 260/300 ms
// timings whatever the finger did. The fix is physics: a near-critically
// damped spring that inherits the release velocity, 1:1 finger tracking in
// both directions, an edge swipe to open, and no Modal mount in the path.
// The maths lives in src/utils/drawerPhysics.ts (unit-tested below); the
// wiring in BusinessDrawer.tsx is pinned by source contracts.
import fs from 'fs';
import path from 'path';
import {
  DRAWER_SPRING,
  drawerDampingRatio,
  clampDrawerX,
  drawerReleaseTarget,
} from '../src/utils/drawerPhysics';

const read = (p: string) => fs.readFileSync(path.resolve(__dirname, '..', p), 'utf8');
const W = 300; // arbitrary drawer width for the maths

describe('drawerPhysics — spring', () => {
  it('is near-critically damped: fast settle, no visible overshoot (the old wobble was under-damping)', () => {
    const zeta = drawerDampingRatio();
    expect(zeta).toBeGreaterThanOrEqual(0.9);
    expect(zeta).toBeLessThanOrEqual(1.05);
    expect(DRAWER_SPRING.stiffness).toBeGreaterThan(0);
  });
});

describe('drawerPhysics — clampDrawerX', () => {
  it('clamps the panel between fully closed and fully open', () => {
    expect(clampDrawerX(50, W)).toBe(0);
    expect(clampDrawerX(-350, W)).toBe(-W);
    expect(clampDrawerX(-120, W)).toBe(-120);
  });
});

describe('drawerPhysics — drawerReleaseTarget', () => {
  it('started open: a drag under 35% springs back open, past 35% closes', () => {
    expect(drawerReleaseTarget(-100, 0, 0, W)).toBe(0);
    expect(drawerReleaseTarget(-106, 0, 0, W)).toBe(-W);
  });

  it('started open: a fling decides whatever the distance', () => {
    expect(drawerReleaseTarget(-50, -600, 0, W)).toBe(-W);
    expect(drawerReleaseTarget(-250, 600, 0, W)).toBe(0);
  });

  it('started closed (edge drag): opens past 20% of the travel — a natural swipe is enough', () => {
    expect(drawerReleaseTarget(-250, 0, -W, W)).toBe(-W);
    expect(drawerReleaseTarget(-230, 0, -W, W)).toBe(0);
  });

  it('started closed: a fling decides whatever the distance', () => {
    expect(drawerReleaseTarget(-280, 600, -W, W)).toBe(0);
    expect(drawerReleaseTarget(-120, -600, -W, W)).toBe(-W);
  });
});

describe('BusinessDrawer — native-feel wiring (source contracts)', () => {
  const src = read('src/components/BusinessDrawer.tsx');

  it('every settle is the tested spring, driven by the store effect — no fixed-duration timing', () => {
    expect(src).toContain('withSpring');
    expect(src).toMatch(/velocity: 0/);
    expect(src).toContain('businessDrawerOpen ? 0 : -DRAWER_WIDTH');
    expect(src).not.toContain('withTiming');
    expect(src).not.toMatch(/DRAWER_(OPEN|CLOSE)_DURATION/);
  });

  it('the spring configuration comes from the tested util, not a local copy', () => {
    expect(src).toContain("from '@/src/utils/drawerPhysics'");
    expect(src).toContain('...DRAWER_SPRING');
  });

  it('no Modal in the open path: always mounted, pointer-events gated by `interactive`', () => {
    expect(src).not.toContain('<Modal');
    expect(src).not.toContain('modalVisible');
    expect(src).toContain("pointerEvents={interactive ? 'auto' : 'none'}");
  });

  it('a settle re-checks the store before deactivating (an interrupted close strands nothing)', () => {
    expect(src).toContain('runOnJS(deactivateIfClosed)()');
    expect(src).toContain(
      'if (!useAuthStore.getState().businessDrawerOpen) setInteractive(false)',
    );
  });

  it('NO pan gesture exists on this drawer (incident 2026-10-16/17: every pan on device closed the app)', () => {
    // PR 151 shipped an edge swipe-to-open strip + a panel drag. On the
    // founder's device, every pan attempt on this component — edge or
    // panel, on every tab — coincided with the app closing, through the
    // PR 158 lifecycle hotfix and the PR 159 threshold fix; taps never
    // failed. Both GestureDetectors are gone until the mechanism is
    // proven on a dev build: open/close are commands settled by the
    // store effect's spring. The drag maths stays in drawerPhysics.ts
    // (unit-tested above) for the rebuild.
    expect(src).not.toContain('GestureDetector');
    expect(src).not.toContain('Gesture.Pan');
    expect(src).not.toContain('makeDragGesture');
    expect(src).not.toContain('edgeStrip');
    expect(src).not.toContain('dragStartX');
  });

  it('Android back closes the drawer (the removed Modal used to own this)', () => {
    expect(src).toContain("BackHandler.addEventListener('hardwareBackPress'");
    expect(src).toContain('closeBusinessDrawer();');
  });

  it('the parked drawer is fully invisible (its shadow used to leave a strip on the left edge)', () => {
    expect(src).toMatch(/opacity: translateX\.value <= -DRAWER_WIDTH \+ 1 \? 0 : 1/);
  });

  it('reduce-motion still settles instantly, with no spring', () => {
    expect(src).toMatch(/if \(reduceMotion\) \{\s+translateX\.value = target;/);
  });
});

describe('Accueil edge-swipe removed — the drawer is commands-only (after the #160 incident fix)', () => {
  const accueil = read('app/(app)/(tabs)/index.tsx');
  const drawer = read('src/components/BusinessDrawer.tsx');

  it('the old canned trigger is gone: no edgeSwipeOpenDrawer anywhere on Accueil', () => {
    expect(accueil).not.toContain('edgeSwipeOpenDrawer');
    expect(accueil).not.toContain('EDGE_SWIPE_OPEN_DISTANCE');
    expect(accueil).not.toContain('EDGE_SWIPE_OPEN_VELOCITY');
    expect(accueil).not.toContain('edgeSwipeCatcher');
  });

  it('Accueil has no gesture of any kind that opens the drawer', () => {
    expect(accueil).not.toContain('Gesture.Pan');
    expect(accueil).not.toContain('GestureDetector');
    expect(accueil).not.toContain('edgeOpenGesture');
  });

  it('the dead trigger left no unused imports behind', () => {
    expect(accueil).not.toContain("from 'react-native-gesture-handler'");
    expect(accueil).not.toContain("from 'react-native-reanimated'");
  });

  it('Accueil still opens the drawer from the header icon (tap path kept)', () => {
    expect(accueil).toContain('onPress={openBusinessPicker}');
  });

  it('BusinessDrawer stays gesture-free (post-#160 state preserved, not reintroduced)', () => {
    expect(drawer).not.toContain('GestureDetector');
    expect(drawer).not.toContain('Gesture.Pan');
    expect(drawer).not.toContain('edgeOpenGesture');
    expect(drawer).not.toContain('EDGE_STRIP_WIDTH');
    expect(drawer).not.toContain('styles.edgeStrip');
  });
});
