import { useEffect, useRef, useState } from 'react';
import type { StyleProp, TextStyle } from 'react-native';
import { Text } from '@/src/components/ui/Text';
import { useReduceMotion } from '@/src/hooks/useReduceMotion';
import { formatAmount } from '@/src/utils/format';

const DURATION_MS = 450;

// A money figure that counts to its new value instead of jumping: she watches
// the month total move when an expense is added or removed. Reduce motion →
// the number simply changes. The first paint never animates.
export function CountUpAmount({ value, currency, variant = 'label', style }: {
  value: number;
  currency: string;
  variant?: 'label' | 'h2' | 'h3' | 'body';
  style?: StyleProp<TextStyle>;
}) {
  const reduce = useReduceMotion();
  const [shown, setShown] = useState(value);
  const from = useRef(value);
  const raf = useRef<ReturnType<typeof requestAnimationFrame> | null>(null);

  useEffect(() => {
    if (reduce || from.current === value) {
      from.current = value;
      setShown(value);
      return;
    }
    const start = Date.now();
    const origin = from.current;
    const tick = () => {
      const t = Math.min(1, (Date.now() - start) / DURATION_MS);
      const eased = 1 - Math.pow(1 - t, 3);
      const v = origin + (value - origin) * eased;
      from.current = v;
      setShown(v);
      if (t < 1) raf.current = requestAnimationFrame(tick);
      else { from.current = value; setShown(value); }
    };
    raf.current = requestAnimationFrame(tick);
    return () => { if (raf.current !== null) cancelAnimationFrame(raf.current); };
  }, [value, reduce]);

  return <Text variant={variant} style={style}>{formatAmount(shown, currency)}</Text>;
}
