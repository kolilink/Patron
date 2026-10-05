import { AccessibilityInfo } from 'react-native';

// ---------------------------------------------------------------------------
// Reduce motion — one source of truth for the whole app.
//
// A single module-level value fed by ONE AccessibilityInfo subscription, read
// by the `useReduceMotion` hook (src/hooks) and by imperative call sites
// (event handlers that call LayoutAnimation directly). When it is true, state
// changes apply instantly: zero animation scheduled.
// ---------------------------------------------------------------------------

let reduceMotion = false;
let started = false;
const listeners = new Set<() => void>();

function set(value: boolean): void {
  if (value === reduceMotion) return;
  reduceMotion = value;
  listeners.forEach(l => l());
}

function start(): void {
  if (started) return;
  started = true;
  AccessibilityInfo.isReduceMotionEnabled().then(set).catch(() => {});
  AccessibilityInfo.addEventListener('reduceMotionChanged', set);
}

export function getReduceMotion(): boolean {
  start();
  return reduceMotion;
}

export function subscribeReduceMotion(onChange: () => void): () => void {
  start();
  listeners.add(onChange);
  return () => { listeners.delete(onChange); };
}

/** Duration helper: 0 under reduce motion. */
export function motionMs(ms: number): number {
  return getReduceMotion() ? 0 : ms;
}

// Test hook: forget cached state so a test can re-run start().
export function __resetReduceMotionForTests(): void {
  reduceMotion = false;
  started = false;
  listeners.clear();
}
