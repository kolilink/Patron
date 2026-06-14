import { StyleSheet, View } from 'react-native';
import { Text } from '@/src/components/ui/Text';
import { useTheme } from '@/src/theme';
import { spacing } from '@/src/theme';

interface Props {
  offlineSince: number | null;
}

function fmtTs(ts: number): string {
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const day = d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' });
  return `${day} à ${hh}:${mm}`;
}

export function OfflineNotice({ offlineSince }: Props) {
  const { palette } = useTheme();
  return (
    <View style={[styles.bar, { backgroundColor: palette.warning }]}>
      <Text variant="caption" style={styles.text}>
        {offlineSince
          ? `Hors ligne — données du ${fmtTs(offlineSince)}`
          : 'Hors ligne — données locales'}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    paddingHorizontal: spacing[5],
    paddingVertical: spacing[1],
    alignItems: 'center',
  },
  text: { color: '#fff' },
});
