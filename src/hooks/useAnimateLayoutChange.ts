import { useEffect, useRef } from 'react';
import { LayoutAnimation, Platform, UIManager } from 'react-native';
import { getReduceMotion } from '@/lib/reduceMotion';

if (Platform.OS === 'android') {
  UIManager.setLayoutAnimationEnabledExperimental?.(true);
}

/** LayoutAnimation.configureNext that no-ops under reduce motion. */
export function configureLayoutNext(config: Parameters<typeof LayoutAnimation.configureNext>[0]): void {
  if (getReduceMotion()) return;
  LayoutAnimation.configureNext(config);
}

/**
 * Animates the next native layout commit whenever `dep` changes, skipping the
 * initial mount so a screen doesn't animate its own first paint. For a
 * conditionally-rendered block driven by derived/async state (e.g. a search
 * bar that appears once a list crosses a length threshold) rather than a
 * direct user action — for the latter, call LayoutAnimation.configureNext()
 * straight from the event handler instead.
 *
 * Reduce motion on → nothing is scheduled; the layout change applies instantly.
 */
export function useAnimateLayoutChange(dep: unknown) {
  const mounted = useRef(false);
  useEffect(() => {
    if (mounted.current) {
      configureLayoutNext(LayoutAnimation.Presets.easeInEaseOut);
    } else {
      mounted.current = true;
    }
  }, [dep]);
}
