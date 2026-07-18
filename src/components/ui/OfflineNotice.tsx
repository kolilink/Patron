import { StyleSheet, View } from 'react-native';
import { Text } from '@/src/components/ui/Text';
import { useTheme, spacing } from '@/src/theme';
import { useSyncStore } from '@/stores/sync';

interface Props {
  offlineSince: number | null;
}

// offlineSince is intentionally unused in the label now (kept in the props
// contract since every call site already passes it, and future callers may
// still want it) — just "Hors ligne", nothing else. Also suppressed
// whenever there are pending sync operations: the global SyncBanner
// ((app)/_layout.tsx) is already on screen at that point and says the same
// thing, so showing both stacked banners was redundant clutter.
export function OfflineNotice({ offlineSince: _offlineSince }: Props) {
  const { palette } = useTheme();
  const pendingCount = useSyncStore(s => s.pendingCount);
  if (pendingCount > 0) return null;

  return (
    <View style={[styles.bar, { backgroundColor: palette.warningLight }]}>
      <Text variant="caption" style={{ color: palette.warning }}>Hors ligne</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing[5],
    paddingVertical: spacing[1],
  },
});
