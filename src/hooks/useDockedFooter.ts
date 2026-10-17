import { useCallback, useEffect, useState } from 'react';
import { Keyboard, Platform, type LayoutChangeEvent } from 'react-native';
import { footerPlacement, reservedFooterHeight, scrollBottomPadding, type FooterMode, type FooterPlacement } from '@/src/utils/ctaLayout';
import { spacing } from '@/src/theme';

/**
 * The ONE place a sheet learns about the keyboard and where its CTA lives (FormSheet and GestureSheet both
 * use it; a screen must never track the keyboard again to style its own footer — GestureSheet/FormSheet hand
 * `keyboardOpen` to a `footer` render function instead).
 *
 * `reservedPadding` is the bottom room the scroll content must keep while the CTA is docked ABOVE it
 * (an absolutely positioned dock). It is measured twice over so it is right on the first docked frame:
 * the footer is measured in the flow before the keyboard opens (`onFlowLayout`), and re-measured once docked
 * (`onDockLayout`, the footer's padding can differ with the keyboard up). The last docked height is kept
 * across keyboard cycles, so only the very first open can correct by a few points.
 */
export function useDockedFooter(o: { hasFooter: boolean; mode: FooterMode; scrollable?: boolean; gap?: number }): {
  keyboardOpen: boolean;
  placement: FooterPlacement;
  reservedPadding: number | null;
  onFlowLayout: (e: LayoutChangeEvent) => void;
  onDockLayout: (e: LayoutChangeEvent) => void;
} {
  const [keyboardOpen, setKeyboardOpen] = useState(false);
  const [flowHeight, setFlowHeight] = useState<number | null>(null);
  const [dockedHeight, setDockedHeight] = useState<number | null>(null);

  useEffect(() => {
    const show = Keyboard.addListener(Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow', () => setKeyboardOpen(true));
    const hide = Keyboard.addListener(Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide', () => setKeyboardOpen(false));
    return () => { show.remove(); hide.remove(); };
  }, []);

  const placement = footerPlacement({ hasFooter: o.hasFooter, mode: o.mode, keyboardOpen, scrollable: o.scrollable });
  const reservedPadding = scrollBottomPadding(placement, reservedFooterHeight(dockedHeight, flowHeight), o.gap ?? spacing[4]);

  // Layout events fire more than once for the same height; only a real change re-renders.
  const onFlowLayout = useCallback((e: LayoutChangeEvent) => {
    const h = Math.round(e.nativeEvent.layout.height);
    setFlowHeight(prev => (prev === h ? prev : h));
  }, []);
  const onDockLayout = useCallback((e: LayoutChangeEvent) => {
    const h = Math.round(e.nativeEvent.layout.height);
    setDockedHeight(prev => (prev === h ? prev : h));
  }, []);

  return { keyboardOpen, placement, reservedPadding, onFlowLayout, onDockLayout };
}
