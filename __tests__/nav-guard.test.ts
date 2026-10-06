// Welcome → Connexion froze mid-transition (device video 2026-10-06). See src/utils/navGuard.ts.
import fs from 'fs';
import path from 'path';
import { createTapGuard, scheduleSessionRedirect } from '@/src/utils/navGuard';

const read = (p: string) => fs.readFileSync(path.resolve(__dirname, '..', p), 'utf8');

describe('createTapGuard — a fast double-tap yields ONE transition', () => {
  it('accepts the first tap and drops the second inside the window', () => {
    let t = 1000;
    const g = createTapGuard(900, () => t);
    expect(g.allow()).toBe(true);
    t += 120;
    expect(g.allow()).toBe(false);
    t += 500;
    expect(g.allow()).toBe(false);
  });
  it('accepts again once the window has passed (coming back and tapping later)', () => {
    let t = 0;
    const g = createTapGuard(900, () => t);
    expect(g.allow()).toBe(true);
    t += 901;
    expect(g.allow()).toBe(true);
  });
});

describe('scheduleSessionRedirect — never mid-transition, never stranded', () => {
  function harness() {
    let interactionCb: (() => void) | null = null;
    let timerCb: (() => void) | null = null;
    const calls = { run: 0, taskCancelled: 0, timerCleared: 0 };
    const cancel = scheduleSessionRedirect({
      run: () => { calls.run++; },
      runAfterInteractions: cb => { interactionCb = cb; return { cancel: () => { calls.taskCancelled++; } }; },
      setTimeoutFn: (cb) => { timerCb = cb; return 'timer'; },
      clearTimeoutFn: () => { calls.timerCleared++; },
    });
    return { calls, cancel, finishInteractions: () => interactionCb?.(), fireTimer: () => timerCb?.() };
  }

  it('does NOT redirect immediately — it waits for the transition to settle', () => {
    const h = harness();
    expect(h.calls.run).toBe(0);
  });
  it('redirects once, when the interactions finish', () => {
    const h = harness();
    h.finishInteractions();
    h.fireTimer();           // the fallback arriving later is a no-op
    expect(h.calls.run).toBe(1);
  });
  it('a never-clearing interaction handle cannot strand a logged-in user: the fallback timer redirects', () => {
    const h = harness();
    h.fireTimer();
    h.finishInteractions();  // late completion is a no-op
    expect(h.calls.run).toBe(1);
  });
  it('cleanup cancels both, and a cancelled redirect never fires', () => {
    const h = harness();
    h.cancel();
    h.finishInteractions(); h.fireTimer();
    expect(h.calls).toEqual({ run: 0, taskCancelled: 1, timerCleared: 1 });
  });
});

describe('wiring', () => {
  const index = read('app/(welcome)/index.tsx');
  it('the three welcome buttons go through one guarded handler', () => {
    expect(index).toMatch(/const go = \(path:/);
    expect(index).toMatch(/if \(useAuthStore\.getState\(\)\.session\) return;/);
    expect(index).toMatch(/if \(!tapGuard\.allow\(\)\) return;/);
    for (const route of ['creer', 'rejoindre', 'connexion']) {
      expect(index).toMatch(new RegExp(`onPress=\\{\\(\\) => go\\('/\\(welcome\\)/${route}'\\)\\}`));
    }
    expect(index).not.toMatch(/onPress=\{\(\) => router\.push\(/);
  });
  it.each(['index', 'connexion', 'recuperation'])('%s uses the deferred session redirect, not an inline replace in an effect', f => {
    const src = read(`app/(welcome)/${f}.tsx`);
    expect(src).toMatch(/useSessionRedirect\(\);/);
    expect(src).not.toMatch(/if \(!session\) return;[\s\S]{0,200}router\.replace\('\/\(app\)/);
  });
  it('the hook defers via InteractionManager, re-reads the session at fire time and cleans up', () => {
    const hook = read('src/hooks/useSessionRedirect.ts');
    expect(hook).toMatch(/InteractionManager\.runAfterInteractions\(cb\)/);
    expect(hook).toMatch(/const s = useAuthStore\.getState\(\)\.session;\s*if \(!s\) return;/);
    expect(hook).toMatch(/return scheduleSessionRedirect\(/);
  });
});
