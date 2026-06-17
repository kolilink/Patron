import { useEffect, useMemo, useRef } from 'react';
import { Animated, Modal, Pressable, StyleSheet, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Button } from './Button';
import { Text } from './Text';
import { useTheme } from '@/src/theme';
import { radius, spacing } from '@/src/theme';
import type { Palette } from '@/src/theme';

type IoniconName = React.ComponentProps<typeof Ionicons>['name'];

interface Props {
  visible: boolean;
  onClose: () => void;
  icon?: IoniconName;
  title: string;
  body: string;
  action?: { label: string; onPress: () => void };
}

export function AppSheet({ visible, onClose, icon, title, body, action }: Props) {
  const { palette } = useTheme();
  const styles = useMemo(() => makeStyles(palette), [palette]);
  const slideY          = useRef(new Animated.Value(400)).current;
  const backdropOpacity = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (visible) {
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

  return (
    <Modal visible={visible} transparent animationType="none" onRequestClose={onClose}>
      <Animated.View style={[styles.backdrop, { opacity: backdropOpacity }]}>
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} />
      </Animated.View>
      <View style={styles.anchor} pointerEvents="box-none">
        <Animated.View style={[styles.sheet, { transform: [{ translateY: slideY }] }]}>
          <View style={styles.handle} />
          {icon && (
            <View style={styles.iconWrap}>
              <Ionicons name={icon} size={28} color={palette.primary} />
            </View>
          )}
          <Text variant="h3" style={styles.title}>{title}</Text>
          <Text variant="body" color="secondary" style={styles.body}>{body}</Text>
          {action && (
            <Button
              label={action.label}
              onPress={() => { action.onPress(); onClose(); }}
              fullWidth
              size="lg"
              style={styles.actionBtn}
            />
          )}
          <Button label="Fermer" variant="ghost" onPress={onClose} fullWidth />
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
      borderTopLeftRadius: 24,
      borderTopRightRadius: 24,
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
    iconWrap: {
      width: 64,
      height: 64,
      borderRadius: 20,
      backgroundColor: p.primaryLight,
      alignItems: 'center',
      justifyContent: 'center',
    },
    title:     { textAlign: 'center' },
    body:      { textAlign: 'center', lineHeight: 22 },
    actionBtn: { marginTop: spacing[2] },
  });
}
