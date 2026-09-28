import { StyleProp, StyleSheet, View, ViewStyle } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Text } from './Text';
import { Button } from './Button';
import { useTheme, spacing } from '@/src/theme';

interface NoResultsStateProps {
  query: string;
  /** The dead-end flip: "Aucun résultat pour « X »" → "+ Nouveau {type} « X »"
   *  turns a failed search into a one-tap shortcut. Omit only when creation
   *  from this exact list genuinely has nowhere sensible to go. */
  createLabel?: string;
  onCreate?: () => void;
  style?: StyleProp<ViewStyle>;
}

// The other half of the two-state rule: a search with zero matches must
// never share copy with "no data yet" — that reads as "your data is gone."
// This always names the query back and offers spelling-check framing, so
// it's unmistakably a search problem, not a data problem.
export function NoResultsState({ query, createLabel, onCreate, style }: NoResultsStateProps) {
  const { palette } = useTheme();
  const hasCreate = Boolean(createLabel && onCreate);

  return (
    <View style={[styles.container, style]}>
      <View style={{ flex: 42 }} />
      <View style={styles.content}>
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
            size="lg"
            fullWidth
            labelStyle={styles.actionLabel}
            style={styles.action}
          />
        )}
      </View>
      <View style={{ flex: 58 }} />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, paddingHorizontal: spacing[5] },
  content: { alignItems: 'center' },
  title: { textAlign: 'center', marginTop: spacing[5], marginBottom: spacing[2] },
  subtitle: { textAlign: 'center' },
  action: { marginTop: spacing[6], alignSelf: 'stretch' },
  actionLabel: { fontSize: 17 },
});
