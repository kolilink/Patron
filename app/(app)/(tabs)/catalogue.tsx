import { StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Text } from '@/src/components/ui/Text';
import { Card } from '@/src/components/ui/Card';
import { palette, spacing } from '@/src/theme';

export default function CatalogueScreen() {
  return (
    <SafeAreaView style={styles.safe}>
      <View style={styles.content}>
        <Text variant="h2">Catalogue</Text>
        <Card style={styles.placeholder}>
          <Text style={styles.icon}>📦</Text>
          <Text variant="h4">Aucun produit</Text>
          <Text variant="body" color="secondary" style={styles.desc}>
            Ajoutez vos premiers produits pour commencer à gérer votre stock.
          </Text>
        </Card>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: palette.background },
  content: { flex: 1, padding: spacing[5], gap: spacing[5] },
  placeholder: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing[3],
  },
  icon: { fontSize: 48 },
  desc: { textAlign: 'center', maxWidth: 240 },
});
