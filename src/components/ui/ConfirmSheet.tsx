import { useEffect, useId, useMemo } from 'react';
import { BackHandler, Pressable, StyleSheet, View } from 'react-native';
import { Text } from '@/src/components/ui/Text';
import { useTheme, spacing, radius } from '@/src/theme';
import type { Palette } from '@/src/theme';
import { useAlertStore } from '@/src/utils/appAlert';

/**
 * The app's one confirmation dialog (appAlert → ConfirmSheet), identical on iOS
 * and Android and theme-aware. Rendered as an in-window overlay (never a nested
 * <Modal>: iOS can't present a Modal over an already-presented one). One host is
 * mounted at the root and one inside every native Modal window (FormSheet,
 * AppSheet); only the TOPMOST registered host shows the request.
 *
 * `active` lets a Modal host register only while its Modal is visible.
 */
export function ConfirmSheetHost({ active = true, root = false }: { active?: boolean; root?: boolean }) {
  const { palette } = useTheme();
  const styles = useMemo(() => makeStyles(palette), [palette]);
  const reactId = useId();
  const id = root ? 'root' : reactId;
  const current = useAlertStore(s => s.current);
  const topHost = useAlertStore(s => s.hosts[s.hosts.length - 1]);

  useEffect(() => {
    if (!active) return;
    useAlertStore.getState().registerHost(id);
    return () => useAlertStore.getState().unregisterHost(id);
  }, [active, id]);

  const shown = !!current && topHost === id;

  useEffect(() => {
    if (!shown) return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => { useAlertStore.getState().dismiss(); return true; });
    return () => sub.remove();
  }, [shown]);

  if (!shown || !current) return null;

  const { title, message: body } = current;
  const dismiss = () => useAlertStore.getState().dismiss();
  const run = (b: (typeof current.buttons)[number]) => {
    dismiss();
    void b.onPress?.();
  };
  // Cancel last, destructive first among the rest — same order as the iOS logout sheet.
  const cancel = current.buttons.filter(b => b.style === 'cancel');
  const others = current.buttons.filter(b => b.style !== 'cancel');
  const ordered = [...others, ...cancel];

  return (
    <View style={styles.overlay} pointerEvents="box-none">
      <Pressable style={styles.backdrop} onPress={dismiss} accessibilityLabel="Fermer" />
      <View style={styles.card} accessibilityViewIsModal>
        <Text variant="h4" style={styles.center}>{title}</Text>
        {body ? <Text variant="body" color="secondary" style={styles.center}>{body}</Text> : null}
        <View style={styles.buttons}>
          {ordered.map((b, i) => {
            const destructive = b.style === 'destructive';
            const isCancel = b.style === 'cancel';
            return (
              <Pressable
                key={`${b.text}-${i}`}
                onPress={() => run(b)}
                accessibilityRole="button"
                style={({ pressed }) => [
                  styles.pill,
                  destructive ? styles.pillDestructive : isCancel ? styles.pillCancel : styles.pillDefault,
                  pressed && { opacity: 0.8 },
                ]}
              >
                <Text
                  variant="label"
                  style={{ color: destructive ? palette.textInverse : palette.textPrimary }}
                >
                  {b.text}
                </Text>
              </Pressable>
            );
          })}
        </View>
      </View>
    </View>
  );
}

function makeStyles(p: Palette) {
  return StyleSheet.create({
    overlay: { ...StyleSheet.absoluteFillObject, justifyContent: 'flex-end', zIndex: 10000, elevation: 10000 },
    backdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.55)' },
    card: {
      backgroundColor: p.surface,
      borderTopLeftRadius: 24,
      borderTopRightRadius: 24,
      paddingHorizontal: spacing[6],
      paddingTop: spacing[6],
      paddingBottom: spacing[8],
      gap: spacing[3],
    },
    center: { textAlign: 'center' },
    buttons: { gap: spacing[2], marginTop: spacing[2] },
    pill: { minHeight: 48, borderRadius: radius.full, alignItems: 'center', justifyContent: 'center', paddingHorizontal: spacing[4] },
    pillDestructive: { backgroundColor: p.danger },
    pillDefault: { backgroundColor: p.primaryLight },
    pillCancel: { backgroundColor: p.surfaceElevated, borderWidth: 1, borderColor: p.border },
  });
}
