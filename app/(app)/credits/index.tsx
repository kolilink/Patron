import { useEffect, useMemo, useState } from 'react';
import { Alert, FlatList, Pressable, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import { Card } from '@/src/components/ui/Card';
import { Text } from '@/src/components/ui/Text';
import { Button } from '@/src/components/ui/Button';
import { palette, spacing, radius, colors } from '@/src/theme';
import { useAuthStore } from '@/stores/auth';
import { useVentesStore } from '@/stores/ventes';

function fmt(n: number, cur: string) { return `${n.toLocaleString('fr-FR')} ${cur}`; }

const PAY_METHODS = [
  { key: 'especes', label: 'Espèces' },
  { key: 'digital', label: 'Numérique' },
];

export default function CreditsScreen() {
  const session = useAuthStore(s => s.session);
  const businessId = session?.activeBusiness?.id ?? '';
  const userId = session?.user.id ?? '';
  const currency = session?.activeBusiness?.currency ?? 'GNF';
  const role = session?.activeMembership?.role;
  const isVendeur = role === 'vendeur';

  const { sales, loading, saving, fetchSales, markPaid } = useVentesStore();
  const [selectedMethod, setSelectedMethod] = useState<Record<string, string>>({});

  useEffect(() => {
    if (businessId) fetchSales(businessId, isVendeur ? userId : undefined);
  }, [businessId]);

  const credits = useMemo(() =>
    sales
      .filter(s => s.status === 'credit')
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()),
    [sales],
  );

  const totalOutstanding = useMemo(() =>
    credits.reduce((sum, s) => sum + s.total_amount, 0),
    [credits],
  );

  const getMethod = (id: string) => selectedMethod[id] ?? 'especes';
  const setMethod = (id: string, m: string) =>
    setSelectedMethod(prev => ({ ...prev, [id]: m }));

  const handleMarkPaid = async (saleId: string) => {
    const method = getMethod(saleId);
    Alert.alert(
      'Marquer comme payé ?',
      `Mode de paiement: ${PAY_METHODS.find(m => m.key === method)?.label ?? method}`,
      [
        { text: 'Annuler', style: 'cancel' },
        {
          text: 'Confirmer',
          onPress: async () => {
            const ok = await markPaid(saleId, method);
            if (ok) Alert.alert('Crédit encaissé', 'Le paiement a été enregistré.');
          },
        },
      ],
    );
  };

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <View style={styles.header}>
        <Pressable onPress={() => router.back()}><Text variant="body" color="secondary">‹ Retour</Text></Pressable>
        <Text variant="h4">Crédits clients</Text>
        <View style={{ width: 60 }} />
      </View>

      {/* Total outstanding */}
      <Card style={styles.totalCard}>
        <Text variant="caption" color="secondary">Total des créances</Text>
        <Text variant="amountLarge" style={{ color: credits.length > 0 ? palette.warning : palette.textPrimary }}>
          {fmt(totalOutstanding, currency)}
        </Text>
        <Text variant="caption" color="secondary">
          {credits.length} crédit{credits.length !== 1 ? 's' : ''} en attente
        </Text>
      </Card>

      {loading && credits.length === 0 ? (
        <Text variant="body" color="secondary" style={styles.center}>Chargement…</Text>
      ) : credits.length === 0 ? (
        <View style={styles.empty}>
          <Text variant="body" color="secondary" style={{ textAlign: 'center' }}>
            Aucun crédit en attente.{'\n'}Tous les paiements sont à jour.
          </Text>
        </View>
      ) : (
        <FlatList
          data={credits}
          keyExtractor={s => s.id}
          contentContainerStyle={styles.list}
          renderItem={({ item }) => (
            <Card style={styles.creditCard}>
              {/* Client + amount */}
              <View style={styles.cardTop}>
                <View style={[styles.avatar, { backgroundColor: colors.warning[50] }]}>
                  <Text variant="label" style={{ color: palette.warning }}>
                    {(item.customer_name || '?')[0]?.toUpperCase()}
                  </Text>
                </View>
                <View style={{ flex: 1 }}>
                  <Text variant="label">{item.customer_name || 'Client inconnu'}</Text>
                  <Text variant="caption" color="secondary">
                    {item.sale_date
                      ? new Date(item.sale_date).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long' })
                      : new Date(item.created_at).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long' })}
                  </Text>
                  <Text variant="caption" color="secondary">Vendeur: {item.seller_name}</Text>
                </View>
                <Text variant="label" style={{ color: palette.warning }}>
                  {fmt(item.total_amount, currency)}
                </Text>
              </View>

              {/* Payment method picker */}
              <View style={styles.methodRow}>
                {PAY_METHODS.map(m => (
                  <Pressable
                    key={m.key}
                    onPress={() => setMethod(item.id, m.key)}
                    style={[styles.chip, getMethod(item.id) === m.key && styles.chipActive]}
                  >
                    <Text variant="caption" style={{
                      color: getMethod(item.id) === m.key ? palette.textInverse : palette.textPrimary,
                    }}>
                      {m.label}
                    </Text>
                  </Pressable>
                ))}
              </View>

              <Button
                label={saving ? 'Enregistrement…' : `Marquer payé — ${fmt(item.total_amount, currency)}`}
                onPress={() => handleMarkPaid(item.id)}
                loading={saving}
                size="sm"
              />
            </Card>
          )}
          ItemSeparatorComponent={() => <View style={{ height: spacing[3] }} />}
        />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: palette.background },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: spacing[5], paddingVertical: spacing[4],
    borderBottomWidth: 1, borderBottomColor: palette.border,
  },
  totalCard: {
    marginHorizontal: spacing[5], marginVertical: spacing[4],
    alignItems: 'center', gap: spacing[1],
    borderColor: palette.warning + '40', borderWidth: 1,
  },
  list: { paddingHorizontal: spacing[5], paddingBottom: spacing[10] },
  creditCard: { gap: spacing[3] },
  cardTop: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing[3] },
  avatar: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
  methodRow: { flexDirection: 'row', gap: spacing[2] },
  chip: {
    paddingHorizontal: spacing[3], paddingVertical: spacing[1.5],
    borderRadius: radius.full, borderWidth: 1, borderColor: palette.border, backgroundColor: palette.surface,
  },
  chipActive: { backgroundColor: palette.primary, borderColor: palette.primary },
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing[8] },
  center: { textAlign: 'center', marginTop: spacing[10] },
});
