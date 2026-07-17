import { StyleSheet, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Text } from '@/src/components/ui/Text';
import { useTheme, spacing } from '@/src/theme';

interface Props {
  offlineSince: number | null;
}

// Offline is a supported mode now, not an error — so the banner reads as a
// quiet fact ("here's how fresh this is"), not an alarm. Relative time is
// both shorter and more immediately meaningful than a full date+time string;
// falls back to a weekday name only in the rare case of being offline a
// full day or more.
function relativeTime(ts: number): string {
  const min = Math.floor((Date.now() - ts) / 60000);
  if (min < 1) return "à l'instant";
  if (min < 60) return `il y a ${min} min`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `il y a ${hr} h`;
  return `depuis ${new Date(ts).toLocaleDateString('fr-FR', { weekday: 'long' })}`;
}

export function OfflineNotice({ offlineSince }: Props) {
  const { palette } = useTheme();
  return (
    <View style={[styles.bar, { backgroundColor: palette.warningLight }]}>
      <Ionicons name="cloud-offline-outline" size={13} color={palette.warning} />
      <Text variant="caption" style={{ color: palette.warning }}>
        {offlineSince ? `Hors ligne · ${relativeTime(offlineSince)}` : 'Hors ligne'}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingHorizontal: spacing[5],
    paddingVertical: spacing[1],
  },
});
