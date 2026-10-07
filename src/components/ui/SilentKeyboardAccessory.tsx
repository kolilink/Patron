import { InputAccessoryView, Platform, View } from 'react-native';

/**
 * Blank, zero-height InputAccessoryView. A numeric keyboard has no return key on
 * iOS, so the OS auto-injects its own "Done" pill above it unless some linked
 * accessory claims that slot. Linking a field to this (inputAccessoryViewID) claims
 * it while showing nothing — the keyboard opens with NOTHING above it. Must be
 * rendered in the same native window as the field. Do NOT put a button in here:
 * the quick-capture sheets dismiss the keyboard by tapping empty space.
 */
export function SilentKeyboardAccessory({ nativeID }: { nativeID: string }) {
  if (Platform.OS !== 'ios') return null;
  return (
    <InputAccessoryView nativeID={nativeID}>
      <View style={{ height: 0 }} />
    </InputAccessoryView>
  );
}
