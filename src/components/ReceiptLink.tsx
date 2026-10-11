import { Pressable } from 'react-native';
import { Text } from '@/src/components/ui/Text';
import { useTheme } from '@/src/theme';

// The quiet "Reçu" text-link that sits under the "Ajouter" button once an entry
// is saved. A link, never a modal: the rush loop must not be interrupted by a
// receipt — she opens it only if she wants it.
export function ReceiptLink({ onPress, label = 'Reçu' }: { onPress: () => void; label?: string }) {
  const { palette } = useTheme();
  return (
    <Pressable onPress={onPress} hitSlop={12} accessibilityRole="button" accessibilityLabel="Voir le reçu" style={{ alignSelf: 'center', paddingVertical: 4 }}>
      <Text variant="caption" style={{ color: palette.textSecondary, textDecorationLine: 'underline' }}>{label}</Text>
    </Pressable>
  );
}
