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
  /** Inline, directly under the subtitle — never a floating FAB. A screen's
   *  own FAB (if any) must stay hidden while its list is empty; this button
   *  is the one and only primary action for the empty state. */
  actionLabel?: string;
  onAction?: () => void;
  actionVariant?: 'primary' | 'outline';
  /** A second, lower-priority action — a quiet centered text link below the
   *  button, never a second filled button (see Vendre/Vente's "Vente
   *  rapide" + "Ajouter un produit" for the reference shape). */
  linkLabel?: string;
  onLink?: () => void;
  style?: StyleProp<ViewStyle>;
}

// Shared zero-data empty state — the NN/g triad (what / why / next) in one
// place so every screen's "nothing here yet" reads as the same considered
// moment: icon → title → subtitle → button, optically centered a little
// above the true middle of the content area (not dead center — that reads
// low once the header/tabs above are accounted for). Never used for a "no
// search match" state, which needs its own distinct copy (see
// NoResultsState) so a filtered search never reads as "your data is gone."
export function EmptyState({
  icon,
  title,
  subtitle,
  actionLabel,
  onAction,
  actionVariant = 'primary',
  linkLabel,
  onLink,
  style,
}: EmptyStateProps) {
  const { palette } = useTheme();
  const hasAction = Boolean(actionLabel && onAction);
  const hasLink = Boolean(linkLabel && onLink);

  return (
    <View style={[styles.container, style]}>
      <View style={{ flex: 42 }} />
      <View style={styles.content}>
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
            labelStyle={styles.actionLabel}
            style={styles.action}
          />
        )}
        {hasLink && (
          <Text
            variant="label"
            style={[styles.link, { color: palette.primary }]}
            onPress={onLink}
          >
            {linkLabel}
          </Text>
        )}
      </View>
      <View style={{ flex: 58 }} />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, paddingHorizontal: spacing[5] },
  content: { alignItems: 'center' },
  iconWrap: {
    width: 64,
    height: 64,
    borderRadius: 32,
    borderWidth: 1.5,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing[5],
  },
  title: { textAlign: 'center', marginBottom: spacing[2] },
  subtitle: { textAlign: 'center', maxWidth: 300 },
  action: { marginTop: spacing[6], alignSelf: 'stretch' },
  actionLabel: { fontSize: 17 },
  link: { marginTop: spacing[4] },
});
