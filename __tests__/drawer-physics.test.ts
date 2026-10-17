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

  it('started closed (edge drag): opens only past 35% of the travel', () => {
    expect(drawerReleaseTarget(-200, 0, -W, W)).toBe(-W);
    expect(drawerReleaseTarget(-190, 0, -W, W)).toBe(0);
  });

  it('started closed: a fling decides whatever the distance', () => {
    expect(drawerReleaseTarget(-280, 600, -W, W)).toBe(0);
    expect(drawerReleaseTarget(-120, -600, -W, W)).toBe(-W);
  });
});

describe('BusinessDrawer — native-feel wiring (source contracts)', () => {
  const src = read('src/components/BusinessDrawer.tsx');

  it('every settle is a spring that can inherit velocity — no fixed-duration timing remains', () => {
    expect(src).toContain('withSpring');
    expect(src).toMatch(/velocity: 0/);
    expect(src).toMatch(/springTo\(target, e\.velocityX\)/);
    expect(src).not.toContain('withTiming');
    expect(src).not.toMatch(/DRAWER_(OPEN|CLOSE)_DURATION/);
  });

  it('the spring configuration comes from the tested util, not a local copy', () => {
    expect(src).toContain("from '@/src/utils/drawerPhysics'");
    expect(src).toContain('...DRAWER_SPRING');
  });

  it('the drag follows the finger 1:1 in both directions (clamp, never one-way)', () => {
    expect(src).toContain('clampDrawerX(dragStartX.value + e.translationX, DRAWER_WIDTH)');
    expect(src).not.toContain('if (e.translationX < 0)');
  });

  it('release target is the tested rule, fed position + velocity + drag start', () => {
    expect(src).toContain(
      'drawerReleaseTarget(translateX.value, e.velocityX, dragStartX.value, DRAWER_WIDTH)',
    );
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

  it('a gesture settle is not restarted by the store effect (velocity survives the flag flip)', () => {
    expect(src).toContain('gestureTargetRef.current === target');
    expect(src).toContain('gestureTargetRef.current = target');
  });

  it('closed state offers a left-edge swipe to open; open state drags the panel', () => {
    expect(src).toContain('edgeOpenGesture');
    expect(src).toContain('panelDragGesture');
    // The strip is never unmounted: unmounting its GestureDetector as a
    // direct consequence of its own gesture's completion raced the native
    // handler teardown and hard-crashed the app on device. It is gated by
    // enabled + pointerEvents instead, with a real [-10, 10] dead zone.
    expect(src).not.toContain('{!businessDrawerOpen && (');
    expect(src).toContain('styles.edgeStrip');
    expect(src).toContain("pointerEvents={businessDrawerOpen ? 'none' : 'auto'}");
    expect(src).toContain(
      'const edgeOpenGesture = makeDragGesture()\n    .enabled(!businessDrawerOpen)\n    .activeOffsetX([-10, 10])',
    );
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
