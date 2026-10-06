// Reduce motion goes global: one shared source (lib/reduceMotion) that every
// motion surface reads. On → nothing is scheduled; off → normal.
import { AccessibilityInfo, LayoutAnimation } from 'react-native';
import {
  getReduceMotion, subscribeReduceMotion, motionMs, __resetReduceMotionForTests,
} from '@/lib/reduceMotion';
import { configureLayoutNext } from '@/src/hooks/useAnimateLayoutChange';
import { markRowRemoved, consumeRowRestored } from '@/src/utils/rowMotion';

const a11y = AccessibilityInfo as unknown as { __set: (v: boolean) => void; __reset: () => void };
const flush = () => new Promise<void>(r => setImmediate(r));

beforeEach(() => {
  a11y.__reset();
  __resetReduceMotionForTests();
  jest.clearAllMocks();
});

describe('reduce motion source', () => {
  it('defaults off and reads the OS value once resolved', async () => {
    expect(getReduceMotion()).toBe(false);
    await flush(); // initial OS read settles first
    a11y.__set(true);
    expect(getReduceMotion()).toBe(true);
  });

  it('picks up the OS value present at startup', async () => {
    a11y.__reset();
    (AccessibilityInfo as any).isReduceMotionEnabled = () => Promise.resolve(true);
    getReduceMotion();
    await flush();
    expect(getReduceMotion()).toBe(true);
    (AccessibilityInfo as any).isReduceMotionEnabled = () => Promise.resolve(false);
  });

  it('notifies subscribers on change, not on repeats', () => {
    const cb = jest.fn();
    const off = subscribeReduceMotion(cb);
    a11y.__set(true);
    a11y.__set(true);
    expect(cb).toHaveBeenCalledTimes(1);
    off();
    a11y.__set(false);
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('motionMs is 0 when on, unchanged when off', () => {
    getReduceMotion();
    expect(motionMs(250)).toBe(250);
    a11y.__set(true);
    expect(motionMs(250)).toBe(0);
  });
});

describe('layout animation', () => {
  it('off → schedules the layout animation', () => {
    getReduceMotion();
    configureLayoutNext(LayoutAnimation.Presets.easeInEaseOut);
    expect(LayoutAnimation.configureNext).toHaveBeenCalledTimes(1);
  });

  it('on → schedules nothing', () => {
    getReduceMotion();
    a11y.__set(true);
    configureLayoutNext(LayoutAnimation.Presets.easeInEaseOut);
    expect(LayoutAnimation.configureNext).not.toHaveBeenCalled();
  });
});

describe('row restore (undo) window', () => {
  it('only a recently removed row animates back, once', () => {
    markRowRemoved('p1', 1000);
    expect(consumeRowRestored('p1', 2000)).toBe(true);
    expect(consumeRowRestored('p1', 2001)).toBe(false);
  });
  it('a row never removed does not animate in (no first-paint motion)', () => {
    expect(consumeRowRestored('never')).toBe(false);
  });
  it('an expired removal does not animate', () => {
    markRowRemoved('p2', 0);
    expect(consumeRowRestored('p2', 60_000)).toBe(false);
  });
});
