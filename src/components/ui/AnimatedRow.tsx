import React, { useState } from 'react';
import { StyleProp, ViewProps, ViewStyle } from 'react-native';
import Animated, { FadeIn, LinearTransition, withTiming } from 'react-native-reanimated';
import { useReduceMotion } from '@/src/hooks/useReduceMotion';
import { consumeRowRestored } from '@/src/utils/rowMotion';

const EXIT_FADE_MS = 140;
const EXIT_COLLAPSE_MS = 180;

// Quick fade + collapse. Reanimated layout-animation worklet — runs on the UI
// thread, nothing bouncy.
function rowExiting(values: { currentHeight: number }) {
  'worklet';
  return {
    initialValues: { opacity: 1, height: values.currentHeight },
    animations: {
      opacity: withTiming(0, { duration: EXIT_FADE_MS }),
      height: withTiming(0, { duration: EXIT_COLLAPSE_MS }),
    },
  };
}

/**
 * List row wrapper for rows that can be deleted: fades + collapses on removal,
 * siblings slide up; a row restored via Annuler fades back in. Never animates
 * on first paint. Reduce motion → plain View behavior, zero animation.
 */
export function AnimatedRow({ id, children, style, onLayout }: { id: string; children: React.ReactNode; style?: StyleProp<ViewStyle>; onLayout?: ViewProps['onLayout'] }) {
  const reduceMotion = useReduceMotion();
  const [restored] = useState(() => consumeRowRestored(id));
  if (reduceMotion) return <Animated.View style={style} onLayout={onLayout}>{children}</Animated.View>;
  return (
    <Animated.View
      style={style}
      onLayout={onLayout}
      exiting={rowExiting}
      layout={LinearTransition.duration(EXIT_COLLAPSE_MS)}
      entering={restored ? FadeIn.duration(160) : undefined}
    >
      {children}
    </Animated.View>
  );
}

/**
 * FlatList `CellRendererComponent` that gives every row the same exit/enter
 * motion without touching renderItem. Wrapping the cell (not its content) is
 * what lets the list itself collapse the gap. Module-level so its identity is
 * stable across renders.
 */
export function AnimatedRowCell({ item, children, style, onLayout }: {
  item: { id?: string; key?: string; sale?: { id: string } };
  children: React.ReactNode;
  style?: StyleProp<ViewStyle>;
  onLayout?: ViewProps['onLayout'];
}) {
  return <AnimatedRow id={String(item?.id ?? item?.sale?.id ?? item?.key ?? '')} style={style} onLayout={onLayout}>{children}</AnimatedRow>;
}
