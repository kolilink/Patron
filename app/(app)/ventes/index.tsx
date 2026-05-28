import { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, FlatList, Modal, Pressable, ScrollView, StyleSheet, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router, useFocusEffect } from 'expo-router';
import { Card } from '@/src/components/ui/Card';
import { Text } from '@/src/components/ui/Text';
import { Button } from '@/src/components/ui/Button';
import { Input } from '@/src/components/ui/Input';
import { DatePickerField } from '@/src/components/ui/DatePickerField';
import { palette, spacing, radius, colors } from '@/src/theme';
import { formatAmount } from '@/src/utils/format';
import { useAuthStore } from '@/stores/auth';
import { useVentesStore, type Vente } from '@/stores/ventes';

function fmt(n: number, cur: string) { return formatAmount(n, cur); }

type SaleDisplayState = 'paye' | 'partiel' | 'credit' | 'annule';

function getSaleDisplayState(sale: Vente): SaleDisplayState {
  if (sale.status === 'annule') return 'annule';
  if (sale.status === 'paye') return 'paye';
  const amountPaid = sale.amount_paid ?? 0;
  if (amountPaid > 0.005) return 'partiel';
  return 'credit';
}

function methodLabel(m: string) {
  if (m === 'especes') return 'Espèces';
  if (m === 'orange') return 'Orange Money';
  if (m === 'mtn' || m === 'moov') return 'Mobile Money';
  return 'Autre';
}

function fmtDate(iso: string) {
  const d = iso.includes('T') ? new Date(iso) : new Date(iso + 'T00:00:00');
  return d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' });
}

function fmtDateLong(iso: string) {
  const d = iso.includes('T') ? new Date(iso) : new Date(iso + 'T00:00:00');
  return d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' });
}

function todayISO() { return new Date().toISOString().split('T')[0]; }

const PAY_METHODS = [
  { key: 'especes', label: 'Espèces' },
  { key: 'orange', label: 'Orange Money' },
  { key: 'mtn', label: 'Mobile Money' },
  { key: 'digital', label: 'Autre' },
];

// ─── Summary line ──────────────────────────────────────────────────────────────

function buildSummaryLine(all: Vente[], filtered: Vente[], filter: string, currency: string): string {
  const active = all.filter(s => s.status !== 'annule');
  const creditSales = active.filter(s => s.status === 'credit' && (s.total_amount - (s.amount_paid ?? 0)) > 0.01);

  switch (filter) {
    case 'all': {
      const total = active.reduce((s, v) => s + v.total_amount, 0);
      const n = active.length;
      const c = creditSales.length;
      return `${n} vente${n !== 1 ? 's' : ''} · ${fmt(total, currency)} · ${c} à payer`;
    }
    case 'paye': {
      const paid = filtered;
      const total = paid.reduce((s, v) => s + v.total_amount, 0);
      const n = paid.length;
      return `${n} vente${n !== 1 ? 's' : ''} payée${n !== 1 ? 's' : ''} · ${fmt(total, currency)}`;
    }
    case 'credit': {
      const total = filtered.reduce((s, v) => s + (v.total_amount - (v.amount_paid ?? 0)), 0);
      const n = filtered.length;
      return `${n} vente${n !== 1 ? 's' : ''} à payer · ${fmt(total, currency)}`;
    }
    case 'annule': {
      const n = filtered.length;
      return `${n} vente${n !== 1 ? 's' : ''} annulée${n !== 1 ? 's' : ''}`;
    }
    default:
      return '';
  }
}

// ─── Day-grouped list ──────────────────────────────────────────────────────────

type ListItem =
  | { type: 'header'; label: string; key: string }
  | { type: 'sale'; sale: Vente };

function buildGroupedList(sales: Vente[]): ListItem[] {
  const todayMs = (() => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); })();
  const yesterdayMs = todayMs - 86400000;

  const items: ListItem[] = [];
  let lastKey = '';

  for (const sale of sales) {
    const raw = sale.sale_date ?? sale.created_at;
    const d = raw.includes('T') ? new Date(raw) : new Date(raw + 'T00:00:00');
    d.setHours(0, 0, 0, 0);
    const key = d.toISOString().split('T')[0];

    if (key !== lastKey) {
      const label =
        d.getTime() === todayMs ? "AUJOURD'HUI" :
        d.getTime() === yesterdayMs ? 'HIER' :
        d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' }).toUpperCase();
      items.push({ type: 'header', label, key });
      lastKey = key;
    }

    items.push({ type: 'sale', sale });
  }

  return items;
}

// ─── Payment sheet ──────────────────────────────────────────────────────────────

interface PaymentSheetProps {
  visible: boolean;
  sale: Vente;
  currency: string;
  onClose: () => void;
  onConfirm: (amount: number, method: string, date: string) => void;
  saving: boolean;
}

function PaymentSheet({ visible, sale, currency, onClose, onConfirm, saving }: PaymentSheetProps) {
  const amountPaid = sale.amount_paid ?? 0;
  const remaining = sale.total_amount - amountPaid;

  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState('especes');
  const [date, setDate] = useState(todayISO());

  useEffect(() => {
    if (visible) {
      setAmount(String(Math.round(remaining)));
      setMethod('especes');
      setDate(todayISO());
    }
  }, [visible]);

  const handleConfirm = () => {
    const amt = parseFloat(amount.replace(/\s/g, '').replace(',', '.'));
    if (!amt || amt <= 0) { Alert.alert('Montant invalide', 'Entrez un montant valide.'); return; }
    if (amt > remaining + 0.01) {
      Alert.alert('Montant trop élevé', `Le reste dû est ${Math.round(remaining).toLocaleString('fr-FR')} ${currency}.`);
      return;
    }
    onConfirm(amt, method, date);
  };

  const clientName = sale.customer_name ?? 'le client';

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="formSheet" onRequestClose={onClose}>
      <SafeAreaView style={styles.modalSafe} edges={['bottom']}>
        <View style={styles.sheetHeader}>
          <View style={{ width: 60 }} />
          <Text variant="h4">Paiement</Text>
          <Pressable onPress={onClose} style={{ minWidth: 60, alignItems: 'flex-end' }}>
            <Text variant="body" color="secondary">Annuler</Text>
          </Pressable>
        </View>

        <ScrollView style={{ flex: 1 }} contentContainerStyle={styles.sheetContent} keyboardShouldPersistTaps="handled">
          <Text variant="h4" style={{ textAlign: 'center' }}>
            Combien a payé {clientName} ?
          </Text>
          <Text variant="caption" color="secondary" style={{ textAlign: 'center' }}>
            Reste à payer : {fmt(remaining, currency)}
          </Text>

          <View style={{ gap: spacing[2] }}>
            <Input
              label="Montant"
              value={amount}
              onChangeText={setAmount}
              keyboardType="decimal-pad"
              placeholder={String(Math.round(remaining))}
            />
            <Pressable onPress={() => setAmount(String(Math.round(remaining)))}>
              <Text variant="caption" style={{ color: palette.primary }}>
                Solder tout ({fmt(remaining, currency)})
              </Text>
            </Pressable>
          </View>

          <View>
            <Text variant="label" style={{ marginBottom: spacing[2] }}>Mode de paiement</Text>
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
          </View>

          <DatePickerField label="Date" value={date} onChange={setDate} maxToday />
        </ScrollView>

        <View style={styles.sheetFooter}>
          <Button
            label={saving ? 'Enregistrement…' : 'Enregistrer'}
            onPress={handleConfirm}
            loading={saving}
            fullWidth
            size="lg"
          />
        </View>
      </SafeAreaView>
    </Modal>
  );
}

// ─── Detail modal ──────────────────────────────────────────────────────────────

interface DetailModalProps {
  sale: Vente | null;
  currency: string;
  singleVendor: boolean;
  onClose: () => void;
  onRecordPayment: (amount: number, method: string, date: string) => Promise<{ ok: boolean; fullyPaid: boolean }>;
  onCancel: (reason: string) => void;
  onUpdateClient: (name: string) => void;
  saving: boolean;
}

function DetailModal({ sale, currency, singleVendor, onClose, onRecordPayment, onCancel, onUpdateClient, saving }: DetailModalProps) {
  const [showPaymentSheet, setShowPaymentSheet] = useState(false);
  const [showCancelForm, setShowCancelForm] = useState(false);
  const [showEditClient, setShowEditClient] = useState(false);
  const [editedClient, setEditedClient] = useState('');
  const [cancelReason, setCancelReason] = useState('');
  const [toast, setToast] = useState('');

  useEffect(() => {
    if (sale) {
      setEditedClient(sale.customer_name ?? '');
      setShowCancelForm(false);
      setShowEditClient(false);
      setCancelReason('');
      setShowPaymentSheet(false);
    }
  }, [sale?.id]);

  if (!sale) return null;

  const amountPaid = sale.amount_paid ?? 0;
  const discount = sale.discount_amount ?? 0;
  const remaining = sale.total_amount - amountPaid;
  const displayState = getSaleDisplayState(sale);

  const saleIso = sale.sale_date ?? sale.created_at;
  const shortDate = fmtDate(saleIso);
  const longDate = fmtDateLong(saleIso);

  const hasProfit = !!(sale.lines?.some(l => l.cost_price > 0));
  const catalogRevenue = sale.lines?.reduce((s, l) => s + l.unit_price * l.qty, 0) ?? 0;
  const totalCost = sale.lines?.reduce((s, l) => s + l.cost_price * l.qty, 0) ?? 0;
  // Bénéfice uses amount actually received, not catalog total
  const effectiveRevenue = catalogRevenue - discount;
  const totalProfit = effectiveRevenue - totalCost;
  const margin = effectiveRevenue > 0 ? (totalProfit / effectiveRevenue) * 100 : 0;

  const showToast = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(''), 2500);
  };

  const handlePaymentSubmit = async (amount: number, method: string, date: string) => {
    const { ok, fullyPaid } = await onRecordPayment(amount, method, date);
    if (ok) {
      setShowPaymentSheet(false);
      const clientName = sale.customer_name ?? 'Client';
      showToast(fullyPaid ? `${clientName} est soldé(e) ✓` : 'Paiement enregistré');
    }
  };

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

  const showMenu = () => {
    Alert.alert('Options', undefined, [
      { text: 'Modifier le client', onPress: () => setShowEditClient(true) },
      { text: 'Fermer', style: 'cancel' },
    ]);
  };

  const realPayments = sale.payments?.filter(p => p.method !== 'credit') ?? [];

  return (
    <Modal visible animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <SafeAreaView style={styles.modalSafe} edges={['bottom']}>
        {toast ? (
          <View style={styles.toast}>
            <Text variant="label" style={{ color: '#fff' }}>{toast}</Text>
          </View>
        ) : null}

        <View style={styles.modalHeader}>
          <Pressable onPress={onClose}>
            <Text variant="body" color="secondary">Fermer</Text>
          </Pressable>
          <Text variant="h4">Vente du {shortDate}</Text>
          <Pressable onPress={showMenu} style={{ minWidth: 40, alignItems: 'flex-end' }}>
            <Text variant="body" color="secondary">⋯</Text>
          </Pressable>
        </View>

        <ScrollView contentContainerStyle={styles.pad}>
          {/* Status banner */}
          {displayState === 'paye' && (
            <View style={[styles.banner, styles.bannerGreen]}>
              <Text variant="label" style={{ color: palette.success }}>✓ Payé en entier</Text>
            </View>
          )}

          {(displayState === 'credit' || displayState === 'partiel') && (
            <View style={[styles.banner, styles.bannerOrange]}>
              <View style={{ gap: spacing[1], flex: 1, minWidth: 0 }}>
                <Text variant="caption" style={{ color: palette.warning }}>⏳ Reste à payer</Text>
                <Text
                  variant="amountLarge"
                  style={{ color: palette.warning }}
                  adjustsFontSizeToFit
                  numberOfLines={1}
                >
                  {fmt(displayState === 'partiel' ? remaining : sale.total_amount, currency)}
                </Text>
                {displayState === 'partiel' && (
                  <Text variant="caption" style={{ color: palette.warning }}>
                    sur {fmt(sale.total_amount, currency)}
                  </Text>
                )}
              </View>
              <Button
                label="+ Enregistrer un paiement"
                onPress={() => setShowPaymentSheet(true)}
                variant="outline"
                style={{ flexShrink: 0 }}
              />
            </View>
          )}

          {displayState === 'annule' && (
            <View style={[styles.banner, styles.bannerRed]}>
              <Text variant="label" style={{ color: palette.danger }}>✕ Vente annulée</Text>
              {sale.cancellation_reason ? (
                <Text variant="caption" style={{ color: palette.danger, opacity: 0.8 }}>
                  {sale.cancellation_reason}
                </Text>
              ) : null}
            </View>
          )}

          <View style={displayState === 'annule' ? { opacity: 0.5 } : undefined}>
            {/* Articles + rabais */}
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

                {/* Rabais line — only when a discount was applied */}
                {discount > 0 && (
                  <>
                    <View style={styles.divider} />
                    <View style={styles.lineRow}>
                      <Text variant="body" style={{ flex: 1, color: colors.warning[600] }}>Rabais accordé</Text>
                      <Text variant="label" style={{ color: colors.warning[600] }}>
                        − {fmt(discount, currency)}
                      </Text>
                    </View>
                    <View style={styles.divider} />
                    <View style={styles.lineRow}>
                      <Text variant="label" style={{ flex: 1 }}>Payé</Text>
                      <Text variant="label" style={{ color: palette.success }}>
                        {fmt(amountPaid, currency)}
                      </Text>
                    </View>
                  </>
                )}
              </Card>
            )}

            {/* Info block */}
            <Card style={{ gap: spacing[2] }}>
              {sale.customer_name ? (
                <View style={styles.row}>
                  <Text variant="caption" color="secondary">Client</Text>
                  <Text variant="label">{sale.customer_name}</Text>
                </View>
              ) : null}
              <View style={styles.row}>
                <Text variant="caption" color="secondary">Date</Text>
                <Text variant="label">{longDate}</Text>
              </View>
              {!singleVendor && (
                <View style={styles.row}>
                  <Text variant="caption" color="secondary">Vendeur</Text>
                  <Text variant="label">{sale.seller_name}</Text>
                </View>
              )}
            </Card>

            {/* Paiements reçus */}
            {realPayments.length > 0 && (
              <Card style={{ gap: spacing[2] }}>
                <Text variant="label" color="secondary">Paiements reçus</Text>
                {realPayments.map((p, i) => (
                  <View key={i} style={styles.lineRow}>
                    <Text variant="body" style={{ flex: 1 }}>{methodLabel(p.method)}</Text>
                    <Text variant="caption" color="secondary">{fmtDate(p.date)}</Text>
                    <Text variant="label">{fmt(p.amount, currency)}</Text>
                  </View>
                ))}
              </Card>
            )}

            {/* Edit client inline */}
            {showEditClient && (
              <Card style={{ gap: spacing[3] }}>
                <Text variant="label">Modifier le client</Text>
                <TextInput
                  style={styles.textInput}
                  value={editedClient}
                  onChangeText={setEditedClient}
                  placeholder="Nom du client"
                  placeholderTextColor={palette.textDisabled}
                />
                <View style={{ flexDirection: 'row', gap: spacing[2] }}>
                  <Button label="Annuler" onPress={() => setShowEditClient(false)} variant="outline" style={{ flex: 1 }} />
                  <Button
                    label={saving ? 'Enregistrement…' : 'Enregistrer'}
                    onPress={() => onUpdateClient(editedClient)}
                    loading={saving}
                    style={{ flex: 1 }}
                  />
                </View>
              </Card>
            )}

            {/* Bénéfice — always visible when cost data exists */}
            {hasProfit && (
              <Card style={{ gap: spacing[2] }}>
                <Text variant="label" color="secondary">Bénéfice</Text>
                <View style={styles.row}>
                  <Text variant="caption" color="secondary">Coût d'achat</Text>
                  <Text variant="label">{fmt(totalCost, currency)}</Text>
                </View>
                {discount > 0 && (
                  <View style={styles.row}>
                    <Text variant="caption" color="secondary">Rabais accordé</Text>
                    <Text variant="label" style={{ color: colors.warning[600] }}>− {fmt(discount, currency)}</Text>
                  </View>
                )}
                <View style={[styles.row, { paddingTop: spacing[1], borderTopWidth: 1, borderTopColor: palette.border }]}>
                  <Text variant="label">Bénéfice net</Text>
                  <Text variant="label" style={{ color: totalProfit >= 0 ? palette.success : palette.danger }}>
                    {totalProfit >= 0 ? '+' : ''}{fmt(totalProfit, currency)} ({margin.toFixed(0)}%)
                  </Text>
                </View>
              </Card>
            )}

            {/* Cancel */}
            {displayState !== 'annule' && (
              showCancelForm ? (
                <Card style={{ gap: spacing[3], borderColor: palette.danger + '40', borderWidth: 1 }}>
                  <Text variant="caption" color="secondary">
                    Le stock sera restauré. Entrez un motif.
                  </Text>
                  <TextInput
                    style={styles.textInput}
                    value={cancelReason}
                    onChangeText={setCancelReason}
                    placeholder="Motif (requis)"
                    placeholderTextColor={palette.textDisabled}
                    multiline
                  />
                  <View style={{ flexDirection: 'row', gap: spacing[2] }}>
                    <Button label="Retour" onPress={() => setShowCancelForm(false)} variant="outline" style={{ flex: 1 }} />
                    <Button
                      label={saving ? 'Annulation…' : "Confirmer l'annulation"}
                      onPress={handleCancel}
                      loading={saving}
                      variant="danger"
                      style={{ flex: 1 }}
                    />
                  </View>
                </Card>
              ) : (
                <Pressable onPress={() => setShowCancelForm(true)} style={{ alignItems: 'center', paddingVertical: spacing[3] }}>
                  <Text variant="caption" style={{ color: palette.danger }}>Annuler cette vente</Text>
                </Pressable>
              )
            )}
          </View>
        </ScrollView>

        <PaymentSheet
          visible={showPaymentSheet}
          sale={sale}
          currency={currency}
          onClose={() => setShowPaymentSheet(false)}
          onConfirm={handlePaymentSubmit}
          saving={saving}
        />
      </SafeAreaView>
    </Modal>
  );
}

// ─── Main screen ───────────────────────────────────────────────────────────────

export default function VentesScreen() {
  const session = useAuthStore(s => s.session);
  const businessId = session?.activeBusiness?.id ?? '';
  const userId = session?.user.id ?? '';
  const currency = session?.activeBusiness?.currency ?? 'GNF';
  const role = session?.activeMembership?.role;
  const isVendeur = role === 'vendeur';

  const { sales, loading, saving, fetchSales, loadDetail, recordPayment, cancelSale, updateSaleClient } = useVentesStore();
  const [selected, setSelected] = useState<Vente | null>(null);
  const [filter, setFilter] = useState<'all' | 'paye' | 'credit' | 'annule'>('all');
  const [showAll, setShowAll] = useState(false);

  const since90 = useMemo(() => {
    const d = new Date();
    d.setDate(d.getDate() - 90);
    return d.toISOString().split('T')[0];
  }, []);

  useFocusEffect(
    useCallback(() => {
      if (businessId) fetchSales(businessId, isVendeur ? userId : undefined, showAll ? undefined : since90);
    }, [businessId, isVendeur, userId, showAll]),
  );

  useEffect(() => {
    if (businessId) fetchSales(businessId, isVendeur ? userId : undefined, showAll ? undefined : since90);
  }, [showAll]);

  const filtered = useMemo(() => {
    if (filter === 'all') return sales;
    if (filter === 'credit') {
      // Credit filter: both full-credit and partial sales
      return sales.filter(s => s.status === 'credit');
    }
    return sales.filter(s => s.status === filter);
  }, [sales, filter]);

  // Hide vendor column when all sales belong to the same seller
  const singleVendor = useMemo(() => new Set(sales.map(s => s.seller_id)).size <= 1, [sales]);

  const listItems = useMemo(() => buildGroupedList(filtered), [filtered]);

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

  const handleRecordPayment = async (amount: number, method: string, date: string): Promise<{ ok: boolean; fullyPaid: boolean }> => {
    if (!selected) return { ok: false, fullyPaid: false };
    return await recordPayment(selected.id, amount, method, date);
  };

  const handleCancel = async (reason: string) => {
    if (!selected) return;
    const ok = await cancelSale(selected.id, businessId, userId, reason);
    if (ok) setSelected(null);
  };

  const handleUpdateClient = async (name: string) => {
    if (!selected) return;
    const ok = await updateSaleClient(selected.id, name);
    if (ok) setSelected(null);
  };

  const summaryLine = useMemo(
    () => buildSummaryLine(sales, filtered, filter, currency),
    [sales, filtered, filter, currency],
  );

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <View style={styles.header}>
        <Pressable onPress={() => router.back()}><Text variant="body" color="secondary">‹ Retour</Text></Pressable>
        <Text variant="h4">Ventes</Text>
        <View style={{ width: 60 }} />
      </View>

      {/* Inline summary line */}
      {sales.length > 0 && (
        <View style={styles.summaryLine}>
          <Text
            variant="caption"
            color="secondary"
            numberOfLines={1}
            adjustsFontSizeToFit
            style={{ flex: 1 }}
          >
            {summaryLine}
          </Text>
        </View>
      )}

      {/* Filter tabs */}
      <View style={styles.filterRow}>
        {(['all', 'paye', 'credit', 'annule'] as const).map(f => (
          <Pressable key={f} onPress={() => setFilter(f)}
            style={[styles.filterTab, filter === f && styles.filterTabActive]}>
            <Text variant="caption" style={{ color: filter === f ? palette.textInverse : palette.textSecondary }}>
              {f === 'all' ? 'Tout' : f === 'paye' ? 'Payés' : f === 'credit' ? 'À payer' : 'Annulés'}
            </Text>
          </Pressable>
        ))}
      </View>

      {loading && sales.length === 0 ? (
        <Text variant="body" color="secondary" style={styles.center}>Chargement…</Text>
      ) : filtered.length === 0 ? (
        <View style={styles.emptyState}>
          <Text variant="body" color="secondary">Aucune vente trouvée.</Text>
          <Pressable onPress={() => setShowAll(v => !v)} style={{ marginTop: spacing[4] }}>
            <Text variant="caption" style={{ color: palette.primary }}>
              {showAll ? 'Voir les 90 derniers jours' : "Voir tout l'historique"}
            </Text>
          </Pressable>
        </View>
      ) : (
        <FlatList
          data={listItems}
          keyExtractor={item => item.type === 'header' ? `hdr-${item.key}` : item.sale.id}
          contentContainerStyle={styles.list}
          ListFooterComponent={() => (
            <Pressable onPress={() => setShowAll(v => !v)} style={styles.showAllBtn}>
              <Text variant="caption" style={{ color: palette.primary }}>
                {showAll ? 'Voir les 90 derniers jours' : "Voir tout l'historique"}
              </Text>
            </Pressable>
          )}
          renderItem={({ item }) => {
            if (item.type === 'header') {
              return (
                <View style={styles.dayHeader}>
                  <Text variant="overline" color="secondary">{item.label}</Text>
                </View>
              );
            }

            const { sale } = item;
            const ds = getSaleDisplayState(sale);
            const rowColor = ds === 'paye' ? palette.success : ds === 'annule' ? palette.danger : palette.warning;
            const isCredit = ds === 'credit' || ds === 'partiel';
            const remaining = sale.total_amount - (sale.amount_paid ?? 0);

            return (
              <Pressable
                onPress={() => open(sale)}
                style={({ pressed }) => [styles.saleRow, pressed && { opacity: 0.75 }, ds === 'annule' && { opacity: 0.6 }]}
              >
                <View style={{ flex: 1, gap: 2 }}>
                  <View style={styles.saleTop}>
                    {/* Hide "Client au comptant" label — only show real client names */}
                    {sale.customer_name ? (
                      <Text variant="label" numberOfLines={1} style={{ flex: 1 }}>
                        {sale.customer_name}
                      </Text>
                    ) : (
                      <View style={{ flex: 1 }} />
                    )}
                    <Text
                      variant="label"
                      style={{ color: rowColor }}
                      adjustsFontSizeToFit
                      numberOfLines={1}
                    >
                      {isCredit ? `Reste ${fmt(remaining, currency)}` : fmt(sale.total_amount, currency)}
                    </Text>
                  </View>
                  <Text variant="caption" color="secondary">
                    {isCredit
                      ? `Crédit · sur ${fmt(sale.total_amount, currency)}`
                      : ds === 'annule'
                      ? 'Annulé'
                      : 'Payé'}
                    {sale.discount_amount > 0 && ds === 'paye' ? ' · rabais' : ''}
                  </Text>
                </View>
              </Pressable>
            );
          }}
          ItemSeparatorComponent={() => <View style={{ height: 1, backgroundColor: palette.border }} />}
        />
      )}

      {selected && (
        <DetailModal
          sale={selected}
          currency={currency}
          singleVendor={singleVendor}
          onClose={() => setSelected(null)}
          onRecordPayment={handleRecordPayment}
          onCancel={handleCancel}
          onUpdateClient={handleUpdateClient}
          saving={saving}
        />
      )}
    </SafeAreaView>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: palette.background },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: spacing[5], paddingVertical: spacing[4] },
  summaryLine: { paddingHorizontal: spacing[5], paddingBottom: spacing[2] },
  filterRow: { flexDirection: 'row', paddingHorizontal: spacing[5], gap: spacing[2], marginBottom: spacing[3] },
  filterTab: { flex: 1, alignItems: 'center', paddingHorizontal: spacing[2], paddingVertical: spacing[1.5], borderRadius: radius.full, backgroundColor: palette.surface, borderWidth: 1, borderColor: palette.border },
  filterTabActive: { backgroundColor: palette.primary, borderColor: palette.primary },
  list: { paddingHorizontal: spacing[5], paddingBottom: spacing[10] },
  dayHeader: { paddingTop: spacing[4], paddingBottom: spacing[2] },
  saleRow: { paddingVertical: spacing[3], backgroundColor: palette.surface },
  saleTop: { flexDirection: 'row', alignItems: 'center', gap: spacing[2] },
  emptyState: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  center: { textAlign: 'center', marginTop: spacing[10] },
  showAllBtn: { alignItems: 'center', paddingVertical: spacing[5] },

  // Detail modal
  modalSafe: { flex: 1, backgroundColor: palette.background },
  modalHeader: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: spacing[5], paddingVertical: spacing[4],
    borderBottomWidth: 1, borderBottomColor: palette.border,
  },
  pad: { padding: spacing[5], gap: spacing[4], paddingBottom: spacing[10] },

  banner: {
    borderRadius: radius.lg, padding: spacing[4], gap: spacing[3],
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
  },
  bannerGreen: { backgroundColor: palette.success + '20', borderWidth: 1, borderColor: palette.success + '40' },
  bannerOrange: { backgroundColor: palette.warning + '15', borderWidth: 1, borderColor: palette.warning + '40' },
  bannerRed: { backgroundColor: palette.danger + '15', borderWidth: 1, borderColor: palette.danger + '40', flexDirection: 'column', alignItems: 'flex-start' },

  toast: {
    backgroundColor: palette.primary, paddingHorizontal: spacing[5], paddingVertical: spacing[3],
    alignItems: 'center',
  },

  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  lineRow: { flexDirection: 'row', alignItems: 'center', gap: spacing[3] },
  divider: { height: 1, backgroundColor: palette.border, marginVertical: spacing[1] },

  textInput: {
    paddingHorizontal: spacing[4], paddingVertical: spacing[3],
    borderRadius: radius.md, borderWidth: 1, borderColor: palette.border,
    backgroundColor: palette.surface, color: palette.textPrimary, fontSize: 16,
  },

  // Payment sheet
  sheetHeader: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: spacing[5], paddingVertical: spacing[4],
    borderBottomWidth: 1, borderBottomColor: palette.border,
  },
  sheetContent: { padding: spacing[5], gap: spacing[4] },
  sheetFooter: {
    padding: spacing[5], borderTopWidth: 1, borderTopColor: palette.border,
    backgroundColor: palette.surface,
  },
  methodRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing[2] },
  chip: { paddingHorizontal: spacing[3], paddingVertical: spacing[1.5], borderRadius: radius.full, borderWidth: 1, borderColor: palette.border, backgroundColor: palette.surface },
  chipActive: { backgroundColor: palette.primary, borderColor: palette.primary },
});
