import { useEffect, useMemo, useRef, useState } from 'react';
import { Animated, Modal, Pressable, StyleSheet, View } from 'react-native';
import { Button } from './Button';
import { Text } from './Text';
import { PinInput } from './PinInput';
import { useTheme } from '@/src/theme';
import { radius, spacing } from '@/src/theme';
import type { Palette } from '@/src/theme';

interface Props {
  visible: boolean;
  title: string;
  body: string;
  /** Called with the entered PIN. Return true if correct — the sheet closes; false shows an inline error. */
  onSubmit: (pin: string) => Promise<boolean>;
  onCancel: () => void;
}

// Same Modal + slide-up pattern as AppSheet, but embeds a PinInput instead of
// plain body text — AppSheet has no children slot, so this is a sibling, not a
// variant of it.
export function PinConfirmSheet({ visible, title, body, onSubmit, onCancel }: Props) {
  const { palette } = useTheme();
  const styles = useMemo(() => makeStyles(palette), [palette]);
  const slideY          = useRef(new Animated.Value(400)).current;
  const backdropOpacity = useRef(new Animated.Value(0)).current;
  const [error, setError] = useState<string | null>(null);
  const [resetSignal, setResetSignal] = useState(0);
  const [checking, setChecking] = useState(false);

  useEffect(() => {
    if (visible) {
      setError(null);
      setResetSignal(s => s + 1);
      Animated.parallel([
        Animated.spring(slideY, { toValue: 0, useNativeDriver: true, tension: 65, friction: 11 }),
        Animated.timing(backdropOpacity, { toValue: 1, duration: 200, useNativeDriver: true }),
      ]).start();
    } else {
      Animated.parallel([
        Animated.timing(slideY, { toValue: 400, duration: 220, useNativeDriver: true }),
        Animated.timing(backdropOpacity, { toValue: 0, duration: 200, useNativeDriver: true }),
      ]).start();
    }
  }, [visible]);

  async function handleComplete(pin: string) {
    setChecking(true);
    const ok = await onSubmit(pin);
    setChecking(false);
    if (!ok) {
      setError('Code incorrect. Réessayez.');
      setResetSignal(s => s + 1);
    }
  }

  return (
    <Modal visible={visible} transparent animationType="none" onRequestClose={onCancel}>
      <Animated.View style={[styles.backdrop, { opacity: backdropOpacity }]}>
        <Pressable style={StyleSheet.absoluteFill} onPress={onCancel} />
      </Animated.View>
      <View style={styles.anchor} pointerEvents="box-none">
        <Animated.View style={[styles.sheet, { transform: [{ translateY: slideY }] }]}>
          <View style={styles.handle} />
          <Text variant="h3" style={styles.title}>{title}</Text>
          <Text variant="body" color="secondary" style={styles.body}>{body}</Text>
          <View style={styles.pinWrap}>
            <PinInput
              onComplete={handleComplete}
              disabled={checking}
              autoFocus
              resetSignal={resetSignal}
            />
          </View>
          {error && <Text variant="bodySmall" color="warning" style={styles.errorText}>{error}</Text>}
          <Button label="Annuler" variant="ghost" onPress={onCancel} fullWidth />
        </Animated.View>
      </View>
    </Modal>
  );
}

function makeStyles(p: Palette) {
  return StyleSheet.create({
    backdrop: {
      ...StyleSheet.absoluteFillObject,
      backgroundColor: 'rgba(0,0,0,0.55)',
    },
    anchor: {
      flex: 1,
      justifyContent: 'flex-end',
    },
    sheet: {
      backgroundColor: p.surface,
      borderTopLeftRadius: radius.xl,
      borderTopRightRadius: radius.xl,
      paddingHorizontal: spacing[6],
      paddingTop: spacing[3],
      paddingBottom: spacing[10],
      alignItems: 'center',
      gap: spacing[3],
    },
    handle: {
      width: 40,
      height: 4,
      borderRadius: 2,
      backgroundColor: p.border,
      marginBottom: spacing[2],
    },
    title:   { textAlign: 'center' },
    body:    { textAlign: 'center', lineHeight: 22 },
    pinWrap:   { marginVertical: spacing[3] },
    errorText: { textAlign: 'center' },
  });
}
