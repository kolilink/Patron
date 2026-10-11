import React, { forwardRef, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, StyleSheet, View, useWindowDimensions, type ScrollViewProps } from 'react-native';
import { Gesture, GestureDetector, GestureHandlerRootView } from 'react-native-gesture-handler';
import Animated, { Easing, runOnJS, useAnimatedStyle, useSharedValue, withSpring, withTiming } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ConfirmSheetHost } from '@/src/components/ui/ConfirmSheet';
import { Text } from '@/src/components/ui/Text';
import { useTheme, spacing, radius } from '@/src/theme';
import { useReduceMotion } from '@/src/hooks/useReduceMotion';
import { DISMISS_FRACTION, DISMISS_VELOCITY } from '@/src/utils/sheetGesture';

interface Props {
  visible: boolean;
  /** Called AFTER the dismiss animation finishes (Annuler, backdrop tap, fling/50% drag, Android back). */
  onClose: () => void;
  title: string;
  cancelLabel?: string;
  headerRight?: ReactNode;
  footer?: ReactNode;
  /** Rendered after everything else (iOS InputAccessoryView, toasts…). */
  accessory?: ReactNode;
  contentContainerStyle?: ScrollViewProps['contentContainerStyle'];
  keyboardShouldPersistTaps?: ScrollViewProps['keyboardShouldPersistTaps'];
  keyboardDismissMode?: ScrollViewProps['keyboardDismissMode'];
  children: ReactNode;
}

/**
 * Bottom sheet with a hand-built drag-to-dismiss, because the native page sheet could not be tuned:
 *  - the sheet tracks the finger 1:1 (translation is measured from touch-down, so there is no
 *    activation-distance jump), on the UI thread;
 *  - release dismisses on a fling OR past 50% of the sheet's height, otherwise springs back open;
 *  - the backdrop dim is derived from the same shared value as the sheet, so they cannot drift;
 *  - the sheet is opaque and everything inside it moves with it, so nothing from behind (or from
 *    the sheet's own content) can overlap mid-transition.
 * The drag handle is the header (grabber + title row): the body scrolls and holds text inputs, so a
 * body-wide pan would fight both. Modal flags mirror FormSheet (Android edge-to-edge keyboard fix).
 */
export const GestureSheet = forwardRef<ScrollView, Props>(function GestureSheet(
  { visible, onClose, title, cancelLabel = 'Annuler', headerRight, footer, accessory, contentContainerStyle, keyboardShouldPersistTaps = 'handled', keyboardDismissMode, children },
  scrollRef,
) {
  const { palette } = useTheme();
  const insets = useSafeAreaInsets();
  const { height: screenH } = useWindowDimensions();
  const reduce = useReduceMotion();
  const styles = useMemo(() => makeStyles(palette), [palette]);

  const [rendered, setRendered] = useState(visible);
  const translateY = useSharedValue(screenH);
  const sheetHeight = useSharedValue(screenH);
  const closing = useRef(false);

  const finishClose = useCallback(() => {
    closing.current = false;
    onClose();
  }, [onClose]);

  // Opening: mount off-screen (translateY starts at screenH), then slide up.
  useEffect(() => {
    if (visible) {
      closing.current = false;
      setRendered(true);
      translateY.value = withTiming(0, { duration: reduce ? 0 : 300, easing: Easing.out(Easing.cubic) });
    } else if (rendered) {
      // Closed by the parent (e.g. after a save): slide away, then unmount. No onClose echo.
      translateY.value = withTiming(screenH, { duration: reduce ? 0 : 240, easing: Easing.in(Easing.cubic) }, finished => {
        if (finished) runOnJS(setRendered)(false);
      });
    }
  }, [visible]);

  const requestClose = useCallback(() => {
    if (closing.current) return;
    closing.current = true;
    if (reduce) {
      translateY.value = screenH;
      finishClose();
      return;
    }
    translateY.value = withTiming(screenH, { duration: 240, easing: Easing.in(Easing.cubic) }, finished => {
      if (finished) runOnJS(finishClose)();
    });
  }, [finishClose, reduce, screenH, translateY]);

  // Parent flipped visible=false from inside onClose → unmount once the slide-out has finished.
  useEffect(() => {
    if (!visible && !rendered) translateY.value = screenH;
  }, [visible, rendered, screenH, translateY]);

  const pan = useMemo(
    () => Gesture.Pan()
      .activeOffsetY([-6, 6])
      .failOffsetX([-24, 24])
      .onUpdate(e => {
        // 1:1 with the finger; never above the open position.
        translateY.value = e.translationY > 0 ? e.translationY : 0;
      })
      .onEnd(e => {
        const h = sheetHeight.value;
        if (e.velocityY >= DISMISS_VELOCITY || translateY.value >= h * DISMISS_FRACTION) {
          translateY.value = withTiming(screenH, { duration: 200, easing: Easing.out(Easing.quad) }, finished => {
            if (finished) runOnJS(finishClose)();
          });
        } else {
          translateY.value = withSpring(0, { damping: 24, stiffness: 260, mass: 0.9 });
        }
      }),
    [finishClose, screenH, sheetHeight, translateY],
  );

  const sheetStyle = useAnimatedStyle(() => ({ transform: [{ translateY: translateY.value }] }));
  const backdropStyle = useAnimatedStyle(() => {
    const h = sheetHeight.value > 0 ? sheetHeight.value : screenH;
    const t = Math.min(Math.max(translateY.value / h, 0), 1);
    // Same maths as backdropOpacity() in utils/sheetGesture: dim fades 1:1 with the drag.
    return { opacity: 1 - t };
  });

  return (
    <Modal
      visible={rendered}
      transparent
      animationType="none"
      onRequestClose={requestClose}
      statusBarTranslucent
      navigationBarTranslucent
    >
      <GestureHandlerRootView style={styles.root}>
        <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, styles.backdrop, backdropStyle]} />
        <Pressable style={StyleSheet.absoluteFill} onPress={requestClose} accessibilityLabel="Fermer" />
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          style={styles.kav}
          pointerEvents="box-none"
        >
          <Animated.View
            style={[styles.sheet, { marginTop: insets.top + spacing[3] }, sheetStyle]}
            onLayout={e => { sheetHeight.value = e.nativeEvent.layout.height; }}
          >
            <GestureDetector gesture={pan}>
              <View style={styles.dragArea}>
                <View style={styles.grabber} />
                <View style={styles.header}>
                  <Pressable onPress={requestClose} style={styles.cancel} hitSlop={8}>
                    <Text variant="body" color="secondary">{cancelLabel}</Text>
                  </Pressable>
                  <Text variant="h4" numberOfLines={1} style={{ flex: 1, textAlign: 'center' }}>{title}</Text>
                  {headerRight ?? <View style={{ width: 64 }} />}
                </View>
              </View>
            </GestureDetector>
            <ScrollView
              ref={scrollRef}
              style={{ flex: 1 }}
              contentContainerStyle={contentContainerStyle}
              keyboardShouldPersistTaps={keyboardShouldPersistTaps}
              keyboardDismissMode={keyboardDismissMode}
            >
              {children}
            </ScrollView>
            {footer}
            {accessory}
          </Animated.View>
        </KeyboardAvoidingView>
        <ConfirmSheetHost active={rendered} />
      </GestureHandlerRootView>
    </Modal>
  );
});

function makeStyles(p: ReturnType<typeof useTheme>['palette']) {
  return StyleSheet.create({
    root: { flex: 1 },
    backdrop: { backgroundColor: 'rgba(0,0,0,0.45)' },
    kav: { flex: 1 },
    sheet: {
      flex: 1,
      backgroundColor: p.background,
      borderTopLeftRadius: radius.xl,
      borderTopRightRadius: radius.xl,
      overflow: 'hidden',
    },
    dragArea: { backgroundColor: p.surface },
    grabber: { alignSelf: 'center', width: 36, height: 5, borderRadius: 3, marginTop: spacing[2], backgroundColor: p.border },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: spacing[5],
      paddingVertical: spacing[3],
      backgroundColor: p.surface,
    },
    cancel: { minWidth: 64 },
  });
}
