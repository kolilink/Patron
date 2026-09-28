import { StyleProp, StyleSheet, View, ViewStyle } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Text } from './Text';
import { Button } from './Button';
import { useTheme, spacing } from '@/src/theme';

interface EmptyStateProps {
  icon: React.ComponentProps<typeof Ionicons>['name'];
  title: string;
  /** Answers "why it matters" — paints the future state ("Ici, vous verrez…")
   *  rather than describing the current absence a second time. Omit only
   *  when there's genuinely nothing to add (e.g. a read-only archive). */
  subtitle?: string;
  /** Omit both when the screen already has its own persistent "+" (a FAB) —
   *  a second button fighting the FAB violates the one-primary-action rule. */
  actionLabel?: string;
  onAction?: () => void;
  actionVariant?: 'primary' | 'outline';
  style?: StyleProp<ViewStyle>;
}

// Shared zero-data empty state — the NN/g triad (what / why / next) in one
// place so every screen's "nothing here yet" reads as the same considered
// moment instead of a per-screen guess. Never used for a "no search match"
// state, which needs its own distinct copy (see NoResultsState) so a filtered
// search never reads as "your data is gone."
export function EmptyState({
  icon,
  title,
  subtitle,
  actionLabel,
  onAction,
  actionVariant = 'primary',
  style,
}: EmptyStateProps) {
  const { palette } = useTheme();
  const hasAction = Boolean(actionLabel && onAction);

  return (
    <View style={[styles.container, style]}>
      <View style={[styles.iconWrap, { borderColor: palette.border }]}>
        <Ionicons name={icon} size={30} color={palette.textSecondary} />
      </View>
      <Text variant="h4" style={styles.title}>{title}</Text>
      {subtitle ? (
        <Text variant="body" color="secondary" style={styles.subtitle}>{subtitle}</Text>
      ) : null}
      {hasAction && (
        <Button
          label={actionLabel!}
          onPress={onAction}
          variant={actionVariant}
          size="lg"
          fullWidth
          style={styles.action}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing[8],
    paddingVertical: spacing[10],
  },
  iconWrap: {
    width: 64,
    height: 64,
    borderRadius: 32,
    borderWidth: 1.5,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing[4],
  },
  title: { textAlign: 'center', marginBottom: spacing[2] },
  subtitle: { textAlign: 'center', maxWidth: 280 },
  action: { marginTop: spacing[5], alignSelf: 'stretch' },
});
