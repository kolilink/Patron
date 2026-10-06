import { useMemo } from 'react';
import { InputAccessoryView, Keyboard, Platform, Pressable, StyleSheet, View } from 'react-native';
import { Text } from '@/src/components/ui/Text';
import { useTheme, spacing } from '@/src/theme';
import type { Palette } from '@/src/theme';

// iOS-only toolbar above the keyboard with a real "Terminé" button. A
// keyboardType="numeric" field has no return key on iOS, so without this there
// is no way to dismiss the keyboard from the keyboard itself (and the old
// empty `<View style={{height:0}}/>` accessory left a dead strip above it).
//
// Wire a field to it with `inputAccessoryViewID={Platform.OS === 'ios' ? ID : undefined}`
// and render `<KeyboardDoneBar nativeID={ID} />` once beside it. Renders nothing
// on Android, where inputAccessoryViewID doesn't exist.
export const KEYBOARD_DONE_BAR_HEIGHT = 44;

export function KeyboardDoneBar({ nativeID }: { nativeID: string }) {
  const { palette } = useTheme();
  const styles = useMemo(() => makeStyles(palette), [palette]);
  if (Platform.OS !== 'ios') return null;
  return (
    <InputAccessoryView nativeID={nativeID}>
      <View style={styles.bar}>
        <Pressable
          onPress={() => Keyboard.dismiss()}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel="Terminé"
          style={styles.button}
        >
          <Text variant="label" color="primary">Terminé</Text>
        </Pressable>
      </View>
    </InputAccessoryView>
  );
}

function makeStyles(p: Palette) {
  return StyleSheet.create({
    bar: {
      height: KEYBOARD_DONE_BAR_HEIGHT,
      flexDirection: 'row',
      justifyContent: 'flex-end',
      alignItems: 'center',
      paddingHorizontal: spacing[4],
      backgroundColor: p.surface,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: p.border,
    },
    button: { height: KEYBOARD_DONE_BAR_HEIGHT, justifyContent: 'center' },
  });
}
