import React, { forwardRef, useMemo, type ReactNode } from 'react';
import {
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
  type ScrollViewProps,
  type ViewStyle,
} from 'react-native';
import { SafeAreaView, type Edge } from 'react-native-safe-area-context';
import { Text } from './Text';
import { useTheme, spacing } from '@/src/theme';
import type { Palette } from '@/src/theme';

interface FormSheetProps {
  visible: boolean;
  onClose: () => void;
  title: string;
  cancelLabel?: string;
  /** Replaces the default empty right-side header spacer (e.g. a "⋯" menu button). */
  headerRight?: ReactNode;
  /** iOS-only native sheet chrome — ignored on Android, which is always full-screen. */
  presentationStyle?: 'pageSheet' | 'formSheet';
  /** Rendered below the scroll content, still inside the KeyboardAvoidingView (e.g. a submit button). */
  footer?: ReactNode;
  /** Rendered after everything else (e.g. an iOS InputAccessoryView). */
  accessory?: ReactNode;
  contentContainerStyle?: ScrollViewProps['contentContainerStyle'];
  keyboardShouldPersistTaps?: ScrollViewProps['keyboardShouldPersistTaps'];
  keyboardDismissMode?: ScrollViewProps['keyboardDismissMode'];
  /**
   * Set false when `children` renders its own scrollable list (e.g. a
   * `FlatList`) — nesting a VirtualizedList inside FormSheet's own
   * `ScrollView` breaks its windowing and triggers RN's own dev warning.
   * When false, `children` is rendered directly with no wrapping ScrollView
   * and `contentContainerStyle`/`keyboardShouldPersistTaps` are ignored.
   */
  scrollable?: boolean;
  children: ReactNode;
}

/**
 * The one correct way to build a full-screen form sheet in this app.
 *
 * Always sets `statusBarTranslucent`/`navigationBarTranslucent` on the
 * underlying Modal (Android-only props, no-op on iOS). On Android, a Modal
 * opens as its own separate native window — without these two props that
 * window isn't edge-to-edge aware while the rest of the app
 * (`edgeToEdgeEnabled: true` in app.json) is, and that mismatch is what
 * caused a real production bug: the keyboard flashing open/closed inside
 * "Nouveau produit" (catalogue.tsx). See CLAUDE.md's "Form sheets — Android
 * keyboard flicker" note.
 *
 * Every screen needing a form-style modal should use this component instead
 * of a raw `Modal` — enforced by scripts/lib/consistency-checks.js, which
 * fails `npm run check` if a new file imports `Modal` directly for a screen
 * that also contains a `TextInput`.
 */
export const FormSheet = forwardRef<ScrollView, FormSheetProps>(function FormSheet(
  {
    visible,
    onClose,
    title,
    cancelLabel = 'Annuler',
    headerRight,
    presentationStyle = 'pageSheet',
    footer,
    accessory,
    contentContainerStyle,
    keyboardShouldPersistTaps = 'handled',
    keyboardDismissMode,
    scrollable = true,
    children,
  },
  scrollRef,
) {
  const { palette } = useTheme();
  const styles = useMemo(() => makeStyles(palette), [palette]);

  // Forcing statusBarTranslucent means this window now draws behind the
  // status bar, so — unlike the pre-fix screens — the header needs its own
  // top inset on Android or it renders under the notch/status bar.
  // navigationBarTranslucent needs the same for the bottom inset, which was
  // already applied everywhere. iOS's native sheet chrome already handles
  // both, so it only ever needs 'bottom'.
  const edges: Edge[] = Platform.OS === 'android' ? ['top', 'bottom'] : ['bottom'];

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle={presentationStyle}
      onRequestClose={onClose}
      statusBarTranslucent
      navigationBarTranslucent
      backdropColor={palette.background}
    >
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        keyboardVerticalOffset={Platform.OS === 'ios' ? 46 : 0}
        style={{ flex: 1, backgroundColor: palette.background }}
      >
        <SafeAreaView style={styles.safe} edges={edges}>
          <View style={styles.header}>
            <Pressable onPress={onClose} style={styles.cancel}>
              <Text variant="body" color="secondary">{cancelLabel}</Text>
            </Pressable>
            <Text variant="h4" numberOfLines={1} style={{ flex: 1, textAlign: 'center' }}>{title}</Text>
            {headerRight ?? <View style={{ width: 64 }} />}
          </View>

          {scrollable ? (
            <ScrollView
              ref={scrollRef}
              style={{ flexGrow: 1 }}
              contentContainerStyle={contentContainerStyle}
              keyboardShouldPersistTaps={keyboardShouldPersistTaps}
              keyboardDismissMode={keyboardDismissMode}
            >
              {children}
            </ScrollView>
          ) : (
            children
          )}
        </SafeAreaView>

        {footer}
        {accessory}
      </KeyboardAvoidingView>
    </Modal>
  );
});

function makeStyles(p: Palette): { safe: ViewStyle; header: ViewStyle; cancel: ViewStyle } {
  return StyleSheet.create({
    safe: { flex: 1, backgroundColor: p.background },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: spacing[5],
      paddingVertical: spacing[4],
      borderBottomWidth: 1,
      borderBottomColor: p.border,
      backgroundColor: p.surface,
    },
    cancel: { minWidth: 64 },
  });
}
