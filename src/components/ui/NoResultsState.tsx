import { StyleProp, StyleSheet, View, ViewStyle } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Text } from './Text';
import { Button } from './Button';
import { useTheme, spacing } from '@/src/theme';

interface NoResultsStateProps {
  query: string;
  /** The dead-end flip: "Aucun résultat pour « X »" → "+ Nouveau {type} « X »"
   *  turns a failed search into a one-tap shortcut. Omit when creation from
   *  this exact list doesn't make sense (e.g. a sales history). */
  createLabel?: string;
  onCreate?: () => void;
  style?: StyleProp<ViewStyle>;
}

// The other half of the two-state rule: a search with zero matches must
// never share copy with "no data yet" — that reads as "your data is gone."
// This always names the query back and offers spelling-check framing, so it's
// unmistakably a search problem, not a data problem.
export function NoResultsState({ query, createLabel, onCreate, style }: NoResultsStateProps) {
  const { palette } = useTheme();
  const hasCreate = Boolean(createLabel && onCreate);

  return (
    <View style={[styles.container, style]}>
      <Ionicons name="search-outline" size={40} color={palette.textDisabled} />
      <Text variant="h4" style={styles.title}>Aucun résultat pour « {query} »</Text>
      <Text variant="body" color="secondary" style={styles.subtitle}>
        Vérifiez l'orthographe ou créez-le.
      </Text>
      {hasCreate && (
        <Button
          label={createLabel!}
          onPress={onCreate}
          variant="outline"
          size="md"
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
    gap: spacing[1],
  },
  title: { textAlign: 'center', marginTop: spacing[3] },
  subtitle: { textAlign: 'center' },
  action: { marginTop: spacing[4] },
});
