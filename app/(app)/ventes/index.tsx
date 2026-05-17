import { useEffect, useState } from 'react';
import { Alert, FlatList, Modal, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import { Card } from '@/src/components/ui/Card';
import { Text } from '@/src/components/ui/Text';
import { Button } from '@/src/components/ui/Button';
import { palette, spacing, colors, radius } from '@/src/theme';
import { useAuthStore } from '@/stores/auth';
import { useVentesStore, type Vente } from '@/stores/ventes';

function fmt(n: number, cur: string) { return `${n.toLocaleString('fr-FR')} ${cur}`; }

function statusLabel(s: string) {
  return s === 'paye' ? 'Payé' : s === 'credit' ? 'Crédit' : s === 'annule' ? 'Annulé' : s;
}
function statusColor(s: string) {
  return s === 'paye' ? palette.success : s === 'credit' ? palette.warning : palette.danger;
}

function relativeDate(iso: string) {
  const d = new Date(iso);
  const now = new Date();
  const diff = now.getTime() - d.getTime();
  if (diff < 60000) return 'À l\'instant';
  if (diff < 3600000) return `Il y a ${Math.floor(diff / 60000)} min`;
  if (diff < 86400000) return `Il y a ${Math.floor(diff / 3600000)} h`;
  return d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' });
}

interface DetailModalProps {
  sale: Vente | null;
  currency: string;
  onClose: () => void;
  onMarkPaid: (method: string) => void;
  saving: boolean;
}

const PAY_METHODS = [
  { key: 'especes', label: 'Espèces' },
  { key: 'digital', label: 'Numérique' },
];

function methodLabel(m: string) {
  if (m === 'especes') return 'Espèces';
  if (m === 'digital') return 'Numérique';
  if (m === 'credit') return 'Crédit';
  if (m === 'wave') return 'Wave';
  if (m === 'orange') return 'Orange Money';
  if (m === 'mtn') return 'MTN';
  if (m === 'moov') return 'Moov';
  return m;
}

function DetailModal({ sale, currency, onClose, onMarkPaid, saving }: DetailModalProps) {
  const [method, setMethod] = useState('especes');

  if (!sale) return null;
  return (
    <Modal visible animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <SafeAreaView style={styles.modalSafe}>
        <View style={styles.modalHeader}>
          <Pressable onPress={onClose}><Text variant="body" color="secondary">Fermer</Text></Pressable>
          <Text variant="h4">Détail vente</Text>
          <View style={{ width: 60 }} />
        </View>
        <ScrollView contentContainerStyle={styles.pad}>
          {/* Meta */}
          <Card style={styles.metaCard}>
            <View style={styles.row}>
              <Text variant="caption" color="secondary">Vendeur</Text>
              <Text variant="label">{sale.seller_name}</Text>
            </View>
            <View style={styles.row}>
              <Text variant="caption" color="secondary">Client</Text>
              <Text variant="label">{sale.customer_name || 'Comptant'}</Text>
            </View>
            <View style={styles.row}>
              <Text variant="caption" color="secondary">Date</Text>
              <Text variant="label">
                {sale.sale_date
                  ? new Date(sale.sale_date).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' })
                  : new Date(sale.created_at).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' })}
              </Text>
            </View>
            <View style={styles.row}>
              <Text variant="caption" color="secondary">Statut</Text>
              <Text variant="label" style={{ color: statusColor(sale.status) }}>{statusLabel(sale.status)}</Text>
            </View>
          </Card>

          {/* Lines */}
          {sale.lines && sale.lines.length > 0 && (
            <Card style={{ gap: spacing[2] }}>
              <Text variant="label" color="secondary">Articles</Text>
              {sale.lines.map(l => (
                <View key={l.id} style={styles.lineRow}>
                  <Text variant="body" style={{ flex: 1 }}>{l.product_name}</Text>
                  <Text variant="caption" color="secondary">×{l.qty}</Text>
                  <Text variant="label">{fmt(l.unit_price * l.qty, currency)}</Text>
                </View>
              ))}
            </Card>
          )}

          {/* Payments */}
          {sale.payments && sale.payments.length > 0 && (
            <Card style={{ gap: spacing[2] }}>
              <Text variant="label" color="secondary">Paiements</Text>
              {sale.payments.map((p, i) => (
                <View key={i} style={styles.lineRow}>
                  <Text variant="body">{methodLabel(p.method)}</Text>
                  <Text variant="label">{fmt(p.amount, currency)}</Text>
                </View>
              ))}
            </Card>
          )}

          {/* Total */}
          <Card style={[styles.row, { backgroundColor: palette.primaryLight }]}>
            <Text variant="label">Total</Text>
            <Text variant="amountLarge" style={{ color: palette.primary }}>{fmt(sale.total_amount, currency)}</Text>
          </Card>

          {/* Mark paid */}
          {sale.status === 'credit' && (
            <Card style={{ gap: spacing[3] }}>
              <Text variant="label">Encaisser ce crédit</Text>
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
              <Button label={saving ? 'Enregistrement…' : 'Marquer comme payé'}
                onPress={() => onMarkPaid(method)} loading={saving} />
            </Card>
          )}
        </ScrollView>
      </SafeAreaView>
    </Modal>
  );
}

export default function VentesScreen() {
  const session = useAuthStore(s => s.session);
  const businessId = session?.activeBusiness?.id ?? '';
  const currency = session?.activeBusiness?.currency ?? 'GNF';

  const { sales, loading, saving, fetchSales, loadDetail, markPaid } = useVentesStore();
  const [selected, setSelected] = useState<Vente | null>(null);
  const [filter, setFilter] = useState<'all' | 'paye' | 'credit'>('all');

  useEffect(() => { if (businessId) fetchSales(businessId); }, [businessId]);

  const filtered = filter === 'all' ? sales : sales.filter(s => s.status === filter);

  const open = async (sale: Vente) => {
    setSelected(sale);
    if (!sale.lines) await loadDetail(sale.id);
    setSelected(s => s?.id === sale.id ? { ...s } : s);
  };

  useEffect(() => {
    if (selected) {
      const updated = sales.find(s => s.id === selected.id);
      if (updated) setSelected(updated);
    }
  }, [sales]);

  const handleMarkPaid = async (method: string) => {
    if (!selected) return;
    const ok = await markPaid(selected.id, method);
    if (ok) Alert.alert('Payé', 'Crédit marqué comme encaissé.');
  };

  const todayRevenue = sales
    .filter(s => s.status === 'paye' && new Date(s.paid_at ?? s.created_at).toDateString() === new Date().toDateString())
    .reduce((sum, s) => sum + s.total_amount, 0);

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      {/* Header */}
      <View style={styles.header}>
        <Pressable onPress={() => router.back()}><Text variant="body" color="secondary">‹ Retour</Text></Pressable>
        <Text variant="h4">Ventes</Text>
        <View style={{ width: 60 }} />
      </View>

      {/* Summary */}
      <View style={styles.summary}>
        <Card style={styles.summaryCard}>
          <Text variant="caption" color="secondary">Aujourd'hui</Text>
          <Text variant="label">{fmt(todayRevenue, currency)}</Text>
        </Card>
        <Card style={styles.summaryCard}>
          <Text variant="caption" color="secondary">Total ventes</Text>
          <Text variant="label">{sales.length}</Text>
        </Card>
        <Card style={[styles.summaryCard, { borderColor: palette.warning }]}>
          <Text variant="caption" color="secondary">Crédits</Text>
          <Text variant="label" style={{ color: palette.warning }}>
            {sales.filter(s => s.status === 'credit').length}
          </Text>
        </Card>
      </View>

      {/* Filter tabs */}
      <View style={styles.filterRow}>
        {(['all', 'paye', 'credit'] as const).map(f => (
          <Pressable key={f} onPress={() => setFilter(f)}
            style={[styles.filterTab, filter === f && styles.filterTabActive]}>
            <Text variant="caption" style={{ color: filter === f ? palette.textInverse : palette.textSecondary }}>
              {f === 'all' ? 'Tout' : f === 'paye' ? 'Payés' : 'Crédits'}
            </Text>
          </Pressable>
        ))}
      </View>

      {loading && sales.length === 0 ? (
        <Text variant="body" color="secondary" style={styles.center}>Chargement…</Text>
      ) : filtered.length === 0 ? (
        <View style={styles.emptyState}>
          <Text variant="body" color="secondary">Aucune vente trouvée.</Text>
        </View>
      ) : (
        <FlatList
          data={filtered}
          keyExtractor={s => s.id}
          contentContainerStyle={styles.list}
          renderItem={({ item }) => (
            <Pressable onPress={() => open(item)}
              style={({ pressed }) => [styles.saleRow, pressed && { opacity: 0.75 }]}>
              <View style={{ flex: 1, gap: 2 }}>
                <View style={styles.saleTop}>
                  <Text variant="label" numberOfLines={1} style={{ flex: 1 }}>
                    {item.customer_name || 'Client au comptant'}
                  </Text>
                  <Text variant="label" style={{ color: statusColor(item.status) }}>
                    {fmt(item.total_amount, currency)}
                  </Text>
                </View>
                <View style={styles.saleMeta}>
                  <Text variant="caption" color="secondary">👤 {item.seller_name}</Text>
                  <Text variant="caption" color="secondary">· {relativeDate(item.created_at)}</Text>
                  <View style={[styles.statusPill, { backgroundColor: statusColor(item.status) + '20' }]}>
                    <Text variant="caption" style={{ color: statusColor(item.status) }}>
                      {statusLabel(item.status)}
                    </Text>
                  </View>
                </View>
              </View>
            </Pressable>
          )}
          ItemSeparatorComponent={() => <View style={{ height: 1, backgroundColor: palette.border }} />}
        />
      )}

      {selected && (
        <DetailModal
          sale={selected}
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
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: spacing[5], paddingVertical: spacing[4] },
  summary: { flexDirection: 'row', paddingHorizontal: spacing[5], gap: spacing[3], marginBottom: spacing[3] },
  summaryCard: { flex: 1, gap: 2, alignItems: 'center' },
  filterRow: { flexDirection: 'row', paddingHorizontal: spacing[5], gap: spacing[2], marginBottom: spacing[3] },
  filterTab: { paddingHorizontal: spacing[3], paddingVertical: spacing[1.5], borderRadius: radius.full, backgroundColor: palette.surface, borderWidth: 1, borderColor: palette.border },
  filterTabActive: { backgroundColor: palette.primary, borderColor: palette.primary },
  list: { paddingHorizontal: spacing[5], paddingBottom: spacing[10] },
  saleRow: { paddingVertical: spacing[3], backgroundColor: palette.surface },
  saleTop: { flexDirection: 'row', alignItems: 'center', gap: spacing[2] },
  saleMeta: { flexDirection: 'row', alignItems: 'center', gap: spacing[2] },
  statusPill: { paddingHorizontal: spacing[1.5], paddingVertical: 1, borderRadius: radius.sm },
  emptyState: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  center: { textAlign: 'center', marginTop: spacing[10] },
  pad: { padding: spacing[5], gap: spacing[4] },
  modalSafe: { flex: 1, backgroundColor: palette.background },
  modalHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: spacing[5], borderBottomWidth: 1, borderBottomColor: palette.border },
  metaCard: { gap: spacing[3] },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  lineRow: { flexDirection: 'row', alignItems: 'center', gap: spacing[3] },
  methodRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing[2] },
  chip: { paddingHorizontal: spacing[3], paddingVertical: spacing[1.5], borderRadius: radius.full, borderWidth: 1, borderColor: palette.border, backgroundColor: palette.surface },
  chipActive: { backgroundColor: palette.primary, borderColor: palette.primary },
});
