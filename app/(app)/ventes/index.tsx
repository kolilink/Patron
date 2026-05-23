import { useEffect, useState } from 'react';
import { Alert, FlatList, Modal, Pressable, ScrollView, StyleSheet, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import { Card } from '@/src/components/ui/Card';
import { Text } from '@/src/components/ui/Text';
import { Button } from '@/src/components/ui/Button';
import { Input } from '@/src/components/ui/Input';
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

function saleDate(iso: string) {
  const d = iso.includes('T') ? new Date(iso) : new Date(iso + 'T00:00:00');
  return d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' });
}

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

const PAY_METHODS = [
  { key: 'especes', label: 'Espèces' },
  { key: 'digital', label: 'Numérique' },
];

interface DetailModalProps {
  sale: Vente | null;
  currency: string;
  businessId: string;
  userId: string;
  onClose: () => void;
  onMarkPaid: (method: string) => void;
  onCancel: (reason: string) => void;
  onUpdateClient: (name: string) => void;
  saving: boolean;
}

function DetailModal({ sale, currency, businessId, userId, onClose, onMarkPaid, onCancel, onUpdateClient, saving }: DetailModalProps) {
  const [method, setMethod] = useState('especes');
  const [showCancelForm, setShowCancelForm] = useState(false);
  const [cancelReason, setCancelReason] = useState('');
  const [showEditClient, setShowEditClient] = useState(false);
  const [editedClient, setEditedClient] = useState('');

  useEffect(() => {
    if (sale) {
      setEditedClient(sale.customer_name ?? '');
      setShowCancelForm(false);
      setShowEditClient(false);
      setCancelReason('');
    }
  }, [sale]);

  if (!sale) return null;

  const canCancel = sale.status !== 'annule';
  const canEdit = sale.status !== 'annule';

  const handleCancel = () => {
    if (!cancelReason.trim()) {
      Alert.alert('Motif requis', 'Entrez un motif pour annuler cette vente.');
      return;
    }
    Alert.alert(
      'Annuler cette vente ?',
      'Le stock sera restauré. Cette action est irréversible.',
      [
        { text: 'Retour', style: 'cancel' },
        { text: 'Annuler la vente', style: 'destructive', onPress: () => onCancel(cancelReason) },
      ],
    );
  };

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
            {sale.cancellation_reason ? (
              <View style={styles.row}>
                <Text variant="caption" color="secondary">Motif annulation</Text>
                <Text variant="caption" style={{ flex: 1, textAlign: 'right', color: palette.danger }}>{sale.cancellation_reason}</Text>
              </View>
            ) : null}
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

          {/* Mark paid (credit only) */}
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

          {/* Edit client name */}
          {canEdit && (
            <Card style={{ gap: spacing[3] }}>
              <Pressable onPress={() => setShowEditClient(v => !v)} style={styles.row}>
                <Text variant="label">Modifier le client</Text>
                <Text variant="caption" color="secondary">{showEditClient ? '▲' : '▼'}</Text>
              </Pressable>
              {showEditClient && (
                <>
                  <TextInput
                    style={styles.textInput}
                    value={editedClient}
                    onChangeText={setEditedClient}
                    placeholder="Nom du client"
                    placeholderTextColor={palette.textDisabled}
                  />
                  <Button
                    label={saving ? 'Enregistrement…' : 'Enregistrer le nom'}
                    onPress={() => onUpdateClient(editedClient)}
                    loading={saving}
                    variant="outline"
                  />
                </>
              )}
            </Card>
          )}

          {/* Cancel sale */}
          {canCancel && (
            <Card style={{ gap: spacing[3], borderColor: palette.danger + '40', borderWidth: 1 }}>
              <Pressable onPress={() => setShowCancelForm(v => !v)} style={styles.row}>
                <Text variant="label" style={{ color: palette.danger }}>Annuler la vente</Text>
                <Text variant="caption" color="secondary">{showCancelForm ? '▲' : '▼'}</Text>
              </Pressable>
              {showCancelForm && (
                <>
                  <Text variant="caption" color="secondary">
                    Le stock sera restauré. Entrez un motif d'annulation.
                  </Text>
                  <TextInput
                    style={styles.textInput}
                    value={cancelReason}
                    onChangeText={setCancelReason}
                    placeholder="Motif (requis)"
                    placeholderTextColor={palette.textDisabled}
                    multiline
                  />
                  <Button
                    label={saving ? 'Annulation…' : 'Confirmer l\'annulation'}
                    onPress={handleCancel}
                    loading={saving}
                    variant="danger"
                  />
                </>
              )}
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
  const userId = session?.user.id ?? '';
  const currency = session?.activeBusiness?.currency ?? 'GNF';

  const { sales, loading, saving, fetchSales, loadDetail, markPaid, cancelSale, updateSaleClient } = useVentesStore();
  const [selected, setSelected] = useState<Vente | null>(null);
  const [filter, setFilter] = useState<'all' | 'paye' | 'credit' | 'annule'>('all');

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

  const handleCancel = async (reason: string) => {
    if (!selected) return;
    const ok = await cancelSale(selected.id, businessId, userId, reason);
    if (ok) Alert.alert('Vente annulée', 'Le stock a été restauré.');
  };

  const handleUpdateClient = async (name: string) => {
    if (!selected) return;
    const ok = await updateSaleClient(selected.id, name);
    if (ok) Alert.alert('', 'Nom client mis à jour.');
  };

  const todayRevenue = sales
    .filter(s => s.status === 'paye' && new Date(s.paid_at ?? s.created_at).toDateString() === new Date().toDateString())
    .reduce((sum, s) => sum + s.total_amount, 0);

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <View style={styles.header}>
        <Pressable onPress={() => router.back()}><Text variant="body" color="secondary">‹ Retour</Text></Pressable>
        <Text variant="h4">Ventes</Text>
        <View style={{ width: 60 }} />
      </View>

      <View style={styles.summary}>
        <Card style={styles.summaryCard}>
          <Text variant="caption" color="secondary">Aujourd'hui</Text>
          <Text variant="label">{fmt(todayRevenue, currency)}</Text>
        </Card>
        <Card style={styles.summaryCard}>
          <Text variant="caption" color="secondary">Total</Text>
          <Text variant="label">{sales.filter(s => s.status !== 'annule').length}</Text>
        </Card>
        <Card style={[styles.summaryCard, { borderColor: palette.warning }]}>
          <Text variant="caption" color="secondary">Crédits</Text>
          <Text variant="label" style={{ color: palette.warning }}>
            {sales.filter(s => s.status === 'credit').length}
          </Text>
        </Card>
      </View>

      <View style={styles.filterRow}>
        {(['all', 'paye', 'credit', 'annule'] as const).map(f => (
          <Pressable key={f} onPress={() => setFilter(f)}
            style={[styles.filterTab, filter === f && styles.filterTabActive]}>
            <Text variant="caption" style={{ color: filter === f ? palette.textInverse : palette.textSecondary }}>
              {f === 'all' ? 'Tout' : f === 'paye' ? 'Payés' : f === 'credit' ? 'Crédits' : 'Annulés'}
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
                  <Text variant="caption" color="secondary">{item.seller_name}</Text>
                  <Text variant="caption" color="secondary">· {saleDate(item.sale_date ?? item.created_at)}</Text>
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
          businessId={businessId}
          userId={userId}
          onClose={() => setSelected(null)}
          onMarkPaid={handleMarkPaid}
          onCancel={handleCancel}
          onUpdateClient={handleUpdateClient}
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
  filterTab: { flex: 1, alignItems: 'center', paddingHorizontal: spacing[2], paddingVertical: spacing[1.5], borderRadius: radius.full, backgroundColor: palette.surface, borderWidth: 1, borderColor: palette.border },
  filterTabActive: { backgroundColor: palette.primary, borderColor: palette.primary },
  list: { paddingHorizontal: spacing[5], paddingBottom: spacing[10] },
  saleRow: { paddingVertical: spacing[3], backgroundColor: palette.surface },
  saleTop: { flexDirection: 'row', alignItems: 'center', gap: spacing[2] },
  saleMeta: { flexDirection: 'row', alignItems: 'center', gap: spacing[2] },
  statusPill: { paddingHorizontal: spacing[1.5], paddingVertical: 1, borderRadius: radius.sm },
  emptyState: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  center: { textAlign: 'center', marginTop: spacing[10] },
  pad: { padding: spacing[5], gap: spacing[4], paddingBottom: spacing[10] },
  modalSafe: { flex: 1, backgroundColor: palette.background },
  modalHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: spacing[5], borderBottomWidth: 1, borderBottomColor: palette.border },
  metaCard: { gap: spacing[3] },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  lineRow: { flexDirection: 'row', alignItems: 'center', gap: spacing[3] },
  methodRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing[2] },
  chip: { paddingHorizontal: spacing[3], paddingVertical: spacing[1.5], borderRadius: radius.full, borderWidth: 1, borderColor: palette.border, backgroundColor: palette.surface },
  chipActive: { backgroundColor: palette.primary, borderColor: palette.primary },
  textInput: {
    paddingHorizontal: spacing[4], paddingVertical: spacing[3],
    borderRadius: radius.md, borderWidth: 1, borderColor: palette.border,
    backgroundColor: palette.surface, color: palette.textPrimary, fontSize: 16,
  },
});
