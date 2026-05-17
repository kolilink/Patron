import { ScrollView, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Card } from '@/src/components/ui/Card';
import { Text } from '@/src/components/ui/Text';
import { palette, spacing } from '@/src/theme';
import { useAuthStore } from '@/stores/auth';

function KpiCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <Card style={styles.kpiCard}>
      <Text variant="caption" color="secondary">{label}</Text>
      <Text variant="amountLarge">{value}</Text>
      {sub ? <Text variant="caption" color="secondary">{sub}</Text> : null}
    </Card>
  );
}

export default function AccueilScreen() {
  const session = useAuthStore(s => s.session);
  const business = session?.activeBusiness;
  const role = session?.activeMembership?.role;

  return (
    <SafeAreaView style={styles.safe}>
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.header}>
          <View>
            <Text variant="h3">{business?.name}</Text>
            <Text variant="bodySmall" color="secondary" style={{ textTransform: 'capitalize' }}>
              {role}
            </Text>
          </View>
        </View>

        <View style={styles.kpiGrid}>
          <KpiCard label="Ventes aujourd'hui" value="—" sub={business?.currency} />
          <KpiCard label="Ventes ce mois" value="—" sub={business?.currency} />
          <KpiCard label="Marge brute" value="—%" />
          <KpiCard label="Stock faible" value="—" sub="produits" />
        </View>

        <Card style={styles.placeholder}>
          <Text variant="body" color="secondary" style={styles.placeholderText}>
            Le tableau de bord sera disponible une fois que vous aurez ajouté des produits et enregistré des ventes.
          </Text>
        </Card>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: palette.background },
  content: { padding: spacing[5], gap: spacing[5] },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingBottom: spacing[2],
  },
  kpiGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing[3],
  },
  kpiCard: {
    flex: 1,
    minWidth: '45%',
    gap: spacing[1],
  },
  placeholder: {
    alignItems: 'center',
    paddingVertical: spacing[8],
  },
  placeholderText: { textAlign: 'center', maxWidth: 260 },
});
