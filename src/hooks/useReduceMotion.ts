import { useSyncExternalStore } from 'react';
import { getReduceMotion, subscribeReduceMotion } from '@/lib/reduceMotion';

/** True when the OS "reduce motion" setting is on. Live-updating. */
export function useReduceMotion(): boolean {
  return useSyncExternalStore(subscribeReduceMotion, getReduceMotion, () => false);
}
