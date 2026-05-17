import { useEffect, useMemo, useState } from 'react';
import { Alert, FlatList, Modal, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import { Card } from '@/src/components/ui/Card';
import { Text } from '@/src/components/ui/Text';
import { Button } from '@/src/components/ui/Button';
import { palette, spacing, radius, colors } from '@/src/theme';
import { useAuthStore } from '@/stores/auth';
import { useVentesStore, type Vente } from '@/stores/ventes';

function fmt(n: number, cur: string) { return `${n.toLocaleString('fr-FR')} ${cur}`; }

function methodLabel(m: string) {
  if (m === 'especes') return 'Espèces';
  if (m === 'digital') return 'Numérique';
  if (m === 'credit') return 'Crédit';
  // Legacy
  if (m === 'wave') return 'Wave';
  if (m === 'orange') return 'Orange Money';
  if (m === 'mtn') return 'MTN';
  if (m === 'moov') return 'Moov';
  return m;
}

interface Client {
  name: string;
  totalAchats: number;
  totalCredit: number;
  nbCommandes: number;
  lastOrder: string;
  orders: Vente[];
}

const PAY_METHODS = [
  { key: 'especes', label: 'Espèces' },
  { key: 'digital', label: 'Numérique' },
];

interface ClientDetailProps {
  client: Client;
  currency: string;
  onClose: () => void;
  onMarkPaid: (saleId: string, method: string) => Promise<void>;
  saving: boolean;
}

function ClientDetail({ client, currency, onClose, onMarkPaid, saving }: ClientDetailProps) {
  const [method, setMethod] = useState('especes');

  return (
    <Modal visible animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <SafeAreaView style={styles.modalSafe}>
        <View style={styles.hdr}>
          <Pressable onPress={onClose}><Text variant="body" color="secondary">Fermer</Text></Pressable>
          <Text variant="h4" numberOfLines={1} style={{ flex: 1, textAlign: 'center' }}>{client.name}</Text>
          <View style={{ width: 60 }} />
        </View>

        <ScrollView contentContainerStyle={styles.pad}>
          {/* Stats */}
          <View style={styles.statsRow}>
            <Card style={styles.statCard}>
              <Text variant="caption" color="secondary">Total achats</Text>
              <Text variant="label">{fmt(client.totalAchats, currency)}</Text>
            </Card>
            <Card style={[styles.statCard, client.totalCredit > 0 && { borderColor: palette.warning }]}>
              <Text variant="caption" color="secondary">Crédit dû</Text>
              <Text variant="label" style={{ color: client.totalCredit > 0 ? palette.warning : palette.textPrimary }}>
                {fmt(client.totalCredit, currency)}
              </Text>
            </Card>
          </View>

          {/* Payment method picker (shown if credits exist) */}
          {client.totalCredit > 0 && (
            <Card style={{ gap: spacing[3] }}>
              <Text variant="label">Mode d'encaissement</Text>
              <View style={styles.methodRow}>
                {PAY_METHODS.map(m => (
                  <Pressable key={m.key} onPress={() => setMethod(m.key)}
                    style={[styles.chip, method === m.key && styles.chipActive]}>
                    <Text variant="caption" style={{ color: method === m.key ? palette.textInverse : palette.textPrimary }}>
                      {m.label}
                    </Text>
                  </Pressable>
                ))}
              </View>
            </Card>
          )}

          {/* Orders */}
          <Text variant="label" color="secondary">Historique des commandes</Text>
          {client.orders.map(o => (
            <Card key={o.id} style={styles.orderCard}>
              <View style={styles.orderTop}>
                <Text variant="body">
                  {o.sale_date
                    ? new Date(o.sale_date).toLocaleDateString('fr-FR')
                    : new Date(o.created_at).toLocaleDateString('fr-FR')}
                </Text>
                <Text variant="label">{fmt(o.total_amount, currency)}</Text>
              </View>
              <View style={styles.orderBot}>
                <Text variant="caption" color="secondary">
                  {o.status === 'paye' ? '✅ Payé' : o.status === 'credit' ? '⏳ Crédit' : o.status}
                </Text>
                <Text variant="caption" color="secondary">Vendeur: {o.seller_name}</Text>
              </View>
              {o.status === 'credit' && (
                <Button
                  label={saving ? '…' : `Encaisser ${fmt(o.total_amount, currency)}`}
                  size="sm"
                  variant="outline"
                  onPress={() => onMarkPaid(o.id, method)}
                  loading={saving}
                />
              )}
            </Card>
          ))}
        </ScrollView>
      </SafeAreaView>
    </Modal>
  );
}

export default function ClientsScreen() {
  const session = useAuthStore(s => s.session);
  const businessId = session?.activeBusiness?.id ?? '';
  const userId = session?.user.id ?? '';
  const currency = session?.activeBusiness?.currency ?? 'GNF';
  const role = session?.activeMembership?.role;
  const isVendeur = role === 'vendeur';

  const { sales, loading, saving, fetchSales, loadDetail, markPaid } = useVentesStore();
  const [selected, setSelected] = useState<Client | null>(null);

  useEffect(() => {
    if (businessId) {
      // Vendeur sees only their own clients
      fetchSales(businessId, isVendeur ? userId : undefined);
    }
  }, [businessId]);

  const clients = useMemo<Client[]>(() => {
    const map = new Map<string, Client>();
    for (const s of sales) {
      const name = s.customer_name?.trim() || 'Anonyme';
      const existing = map.get(name) ?? {
        name,
        totalAchats: 0,
        totalCredit: 0,
        nbCommandes: 0,
        lastOrder: s.created_at,
        orders: [],
      };
      existing.totalAchats += s.total_amount;
      if (s.status === 'credit') existing.totalCredit += s.total_amount;
      existing.nbCommandes += 1;
      if (s.created_at > existing.lastOrder) existing.lastOrder = s.created_at;
      existing.orders.push(s);
      map.set(name, existing);
    }
    return Array.from(map.values()).sort((a, b) => b.totalCredit - a.totalCredit || b.totalAchats - a.totalAchats);
  }, [sales]);

  const totalCreances = clients.reduce((s, c) => s + c.totalCredit, 0);

  const openClient = async (client: Client) => {
    for (const o of client.orders) {
      if (!o.lines) await loadDetail(o.id);
    }
    setSelected(client);
  };

  const handleMarkPaid = async (saleId: string, method: string) => {
    const ok = await markPaid(saleId, method);
    if (ok) {
      Alert.alert('✅', 'Crédit encaissé.');
      const updatedSales = useVentesStore.getState().sales;
      if (selected) {
        const updated = { ...selected, orders: selected.orders.map(o => updatedSales.find(s => s.id === o.id) ?? o) };
        updated.totalCredit = updated.orders.filter(o => o.status === 'credit').reduce((s, o) => s + o.total_amount, 0);
        setSelected(updated);
      }
    }
  };

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <View style={styles.hdr}>
        <Pressable onPress={() => router.back()}><Text variant="body" color="secondary">‹ Retour</Text></Pressable>
        <Text variant="h4">{isVendeur ? 'Mes clients' : 'Clients'}</Text>
        <View style={{ width: 60 }} />
      </View>

      {totalCreances > 0 && (
        <View style={styles.alertBanner}>
          <Text variant="label" style={{ color: colors.warning[700] }}>
            ⚠️  Créances totales : {fmt(totalCreances, currency)}
          </Text>
        </View>
      )}

      {loading && clients.length === 0 ? (
        <Text variant="body" color="secondary" style={styles.center}>Chargement…</Text>
      ) : clients.length === 0 ? (
        <View style={styles.empty}>
          <Text variant="body" color="secondary">
            {isVendeur ? 'Aucun client enregistré sur vos ventes.' : 'Aucun client enregistré.'}
          </Text>
        </View>
      ) : (
        <FlatList
          data={clients}
          keyExtractor={c => c.name}
          contentContainerStyle={styles.list}
          renderItem={({ item }) => (
            <Pressable onPress={() => openClient(item)}
              style={({ pressed }) => [styles.clientRow, pressed && { opacity: 0.75 }]}>
              <View style={[styles.avatar, { backgroundColor: item.totalCredit > 0 ? colors.warning[50] : palette.primaryLight }]}>
                <Text variant="label" style={{ color: item.totalCredit > 0 ? palette.warning : palette.primary }}>
                  {item.name[0]?.toUpperCase()}
                </Text>
              </View>
              <View style={{ flex: 1, gap: 2 }}>
                <Text variant="label">{item.name}</Text>
                <Text variant="caption" color="secondary">
                  {item.nbCommandes} commande{item.nbCommandes > 1 ? 's' : ''} · Total {fmt(item.totalAchats, currency)}
                </Text>
              </View>
              {item.totalCredit > 0 && (
                <View style={styles.creditPill}>
                  <Text variant="caption" style={{ color: palette.warning, fontWeight: '700' }}>
                    {fmt(item.totalCredit, currency)}
                  </Text>
                </View>
              )}
            </Pressable>
          )}
          ItemSeparatorComponent={() => <View style={{ height: 1, backgroundColor: palette.border }} />}
        />
      )}

      {selected && (
        <ClientDetail
          client={selected}
          currency={currency}
          onClose={() => setSelected(null)}
          onMarkPaid={handleMarkPaid}
          saving={saving}
        />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: palette.background },
  hdr: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: spacing[5], borderBottomWidth: 1, borderBottomColor: palette.border },
  alertBanner: { backgroundColor: colors.warning[50], paddingHorizontal: spacing[5], paddingVertical: spacing[3], borderBottomWidth: 1, borderBottomColor: colors.warning[100] },
  list: { paddingBottom: spacing[10] },
  clientRow: { flexDirection: 'row', alignItems: 'center', gap: spacing[3], paddingHorizontal: spacing[5], paddingVertical: spacing[3], backgroundColor: palette.surface },
  avatar: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
  creditPill: { backgroundColor: colors.warning[50], paddingHorizontal: spacing[2], paddingVertical: 2, borderRadius: radius.sm },
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  center: { textAlign: 'center', marginTop: spacing[10] },
  modalSafe: { flex: 1, backgroundColor: palette.background },
  pad: { padding: spacing[5], gap: spacing[4], paddingBottom: spacing[10] },
  statsRow: { flexDirection: 'row', gap: spacing[3] },
  statCard: { flex: 1, gap: 2, alignItems: 'center' },
  methodRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing[2] },
  chip: { paddingHorizontal: spacing[3], paddingVertical: spacing[1.5], borderRadius: radius.full, borderWidth: 1, borderColor: palette.border },
  chipActive: { backgroundColor: palette.primary, borderColor: palette.primary },
  orderCard: { gap: spacing[2] },
  orderTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  orderBot: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
});
