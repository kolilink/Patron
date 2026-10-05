import React, { useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, Animated, StyleProp, StyleSheet, TextStyle, View } from 'react-native';
import { Text } from './Text';
import {
  DOT_COUNT, DOT_MOVE_MS, DOT_RISE_PX, dotDelay, dotRest, staticStatusText,
} from './loadingLanguage';

function useReduceMotion(): boolean {
  const [reduce, setReduce] = useState(false);
  useEffect(() => {
    let alive = true;
    AccessibilityInfo.isReduceMotionEnabled().then(v => { if (alive) setReduce(v); }).catch(() => {});
    const sub = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduce);
    return () => { alive = false; sub.remove(); };
  }, []);
  return reduce;
}

function Dot({ index, color, size }: { index: number; color: string; size: number }) {
  const y = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    // transform-only + native driver: runs on the UI thread, so the dots keep
    // moving while the JS thread is busy — a frozen dot would read as "stuck".
    const loop = Animated.loop(
      Animated.sequence([
        Animated.delay(dotDelay(index)),
        Animated.timing(y, { toValue: -DOT_RISE_PX, duration: DOT_MOVE_MS, useNativeDriver: true }),
        Animated.timing(y, { toValue: 0, duration: DOT_MOVE_MS, useNativeDriver: true }),
        Animated.delay(dotRest(index)),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [index, y]);
  return (
    <Animated.View
      style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: color, transform: [{ translateY: y }] }}
    />
  );
}

interface Props {
  /** Present-participle word, e.g. "Envoi", "Vérification". The dots are added here. */
  word: string;
  color: string;
  /** Text style for the word (size/weight). Colour comes from `color`. */
  textStyle?: StyleProp<TextStyle>;
  variant?: React.ComponentProps<typeof Text>['variant'];
  dotSize?: number;
}

/** "Word" + three bouncing dots. Reduced motion: static "Word…". */
export function LoadingStatus({ word, color, textStyle, variant, dotSize = 4 }: Props) {
  const reduceMotion = useReduceMotion();
  const label = staticStatusText(word);
  if (reduceMotion) {
    return <Text variant={variant} style={[textStyle, { color }]} accessibilityLabel={label}>{label}</Text>;
  }
  const bare = label.slice(0, -1);
  return (
    <View style={styles.row} accessible accessibilityLabel={label}>
      <Text variant={variant} style={[textStyle, { color }]}>{bare}</Text>
      <View style={styles.dots}>
        {Array.from({ length: DOT_COUNT }, (_, i) => <Dot key={i} index={i} color={color} size={dotSize} />)}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'flex-end' },
  dots: { flexDirection: 'row', alignItems: 'flex-end', gap: 3, marginLeft: 3, marginBottom: 5 },
});
