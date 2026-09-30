import { useEffect, useRef } from 'react';
import { LayoutAnimation, Platform, UIManager } from 'react-native';

if (Platform.OS === 'android') {
  UIManager.setLayoutAnimationEnabledExperimental?.(true);
}

/**
 * Animates the next native layout commit whenever `dep` changes, skipping the
 * initial mount so a screen doesn't animate its own first paint. For a
 * conditionally-rendered block driven by derived/async state (e.g. a search
 * bar that appears once a list crosses a length threshold) rather than a
 * direct user action — for the latter, call LayoutAnimation.configureNext()
 * straight from the event handler instead.
 */
export function useAnimateLayoutChange(dep: unknown) {
  const mounted = useRef(false);
  useEffect(() => {
    if (mounted.current) {
      LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    } else {
      mounted.current = true;
    }
  }, [dep]);
}
