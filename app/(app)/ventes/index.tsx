import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Animated, Easing, FlatList, Modal, Pressable, ScrollView, StyleSheet, TextInput, View } from 'react-native';
import { captureRef } from 'react-native-view-shot';
import * as Sharing from 'expo-sharing';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { router, useFocusEffect } from 'expo-router';
import { Card } from '@/src/components/ui/Card';
import { Text } from '@/src/components/ui/Text';
import { Button } from '@/src/components/ui/Button';
import { DatePickerField } from '@/src/components/ui/DatePickerField';
import { OfflineNotice } from '@/src/components/ui/OfflineNotice';
import { useTheme, spacing, radius, colors } from '@/src/theme';
import type { Palette } from '@/src/theme';
import { formatAmount } from '@/src/utils/format';
import { useAuthStore } from '@/stores/auth';
import { useVentesStore, type Vente } from '@/stores/ventes';
import { SaleReceiptView, type ReceiptData, type ReceiptItem } from '@/src/components/ui/SaleReceiptView';
import { haptics } from '@/lib/haptics';
import { SkeletonList } from '@/src/components/ui/SkeletonPlaceholder';

function fmt(n: number, cur: string) { return formatAmount(n, cur); }

function SkeletonLine({ width = '100%', height = 14 }: { width?: string | number; height?: number }) {
  const { palette } = useTheme();
  const pulse = useRef(new Animated.Value(0.4)).current;
  useEffect(() => {
    Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 1, duration: 700, useNativeDriver: true, easing: Easing.inOut(Easing.ease) }),
        Animated.timing(pulse, { toValue: 0.4, duration: 700, useNativeDriver: true, easing: Easing.inOut(Easing.ease) }),
      ])
    ).start();
  }, [pulse]);
  return (
    <View style={{ height, width: width as any, overflow: 'hidden', borderRadius: 6 }}>
      <Animated.View style={{ flex: 1, backgroundColor: palette.border, opacity: pulse }} />
    </View>
  );
}

function DetailSkeleton() {
  return (
    <>
      <Card style={{ gap: spacing[3] }}>
        <SkeletonLine width="40%" height={12} />
        <View style={{ gap: spacing[2] }}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
            <SkeletonLine width="55%" />
            <SkeletonLine width="20%" />
          </View>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
            <SkeletonLine width="45%" />
            <SkeletonLine width="25%" />
          </View>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
            <SkeletonLine width="50%" />
            <SkeletonLine width="22%" />
          </View>
        </View>
      </Card>
      <Card style={{ gap: spacing[3] }}>
        <SkeletonLine width="30%" height={12} />
        <View style={{ gap: spacing[2] }}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
            <SkeletonLine width="25%" />
            <SkeletonLine width="35%" />
          </View>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
            <SkeletonLine width="20%" />
            <SkeletonLine width="40%" />
          </View>
        </View>
      </Card>
    </>
  );
}

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
  const creditSales = active.filter(s => s.status === 'credit' && (s.total_amount - (s.discount_amount ?? 0) - (s.amount_paid ?? 0)) > 0.01);

  switch (filter) {
    case 'all': {
      const total = active.reduce((s, v) => s + v.total_amount - (v.discount_amount ?? 0), 0);
      const n = active.length;
      const c = creditSales.length;
      return `${n} vente${n !== 1 ? 's' : ''} · ${fmt(total, currency)} · ${c} à payer`;
    }
    case 'paye': {
      const paid = filtered;
      const total = paid.reduce((s, v) => s + v.total_amount - (v.discount_amount ?? 0), 0);
      const n = paid.length;
      return `${n} vente${n !== 1 ? 's' : ''} payée${n !== 1 ? 's' : ''} · ${fmt(total, currency)}`;
    }
    case 'credit': {
      const total = filtered.reduce((s, v) => s + (v.total_amount - (v.discount_amount ?? 0) - (v.amount_paid ?? 0)), 0);
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
  | { type: 'header'; label: string; key: string; count: number; total: number; hasCredit: boolean }
  | { type: 'sale'; sale: Vente; dateKey: string };

// Build a YYYY-MM-DD key from LOCAL date components — avoids UTC offset shifting the day
function localDateKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function buildGroupedList(sales: Vente[], currency: string): ListItem[] {
  const now = new Date();
  const todayKey = localDateKey(now);
  const yesterday = new Date(now); yesterday.setDate(now.getDate() - 1);
  const yesterdayKey = localDateKey(yesterday);
  const currentYear = now.getFullYear();

  const dayOrder: string[] = [];
  const dayStats = new Map<string, { label: string; count: number; total: number; hasCredit: boolean }>();
  const daysSales = new Map<string, Vente[]>();

  for (const sale of sales) {
    const raw = sale.sale_date ?? sale.created_at;
    // Parse into LOCAL date — append T00:00:00 (no Z) so JS treats it as local time
    const d = raw.includes('T') ? new Date(raw) : new Date(raw + 'T00:00:00');
    const key = localDateKey(d);

    if (!dayStats.has(key)) {
      let label: string;
      if (key === todayKey) {
        label = "Aujourd'hui";
      } else if (key === yesterdayKey) {
        label = 'Hier';
      } else {
        const opts: Intl.DateTimeFormatOptions = { weekday: 'long', day: 'numeric', month: 'long' };
        if (d.getFullYear() !== currentYear) opts.year = 'numeric';
        const s = d.toLocaleDateString('fr-FR', opts);
        label = s.charAt(0).toUpperCase() + s.slice(1);
      }
      dayStats.set(key, { label, count: 0, total: 0, hasCredit: false });
      daysSales.set(key, []);
      dayOrder.push(key);
    }

    const stats = dayStats.get(key)!;
    const ds = getSaleDisplayState(sale);
    stats.count++;
    if (ds !== 'annule') stats.total += sale.total_amount - (sale.discount_amount ?? 0);
    if (ds === 'credit' || ds === 'partiel') stats.hasCredit = true;
    daysSales.get(key)!.push(sale);
  }

  const items: ListItem[] = [];
  for (const key of dayOrder) {
    items.push({ type: 'header', key, ...dayStats.get(key)! });
    for (const sale of daysSales.get(key)!) {
      items.push({ type: 'sale', sale, dateKey: key });
    }
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
  const { palette } = useTheme();
  const styles = useMemo(() => makeStyles(palette), [palette]);
  const amountPaid = sale.amount_paid ?? 0;
  const remaining = sale.total_amount - (sale.discount_amount ?? 0) - amountPaid;

  const [amountStr, setAmountStr] = useState('');
  const [method, setMethod] = useState('especes');
  const [date, setDate] = useState(todayISO());

  useEffect(() => {
    if (visible) {
      setAmountStr(String(Math.round(remaining)));
      setMethod('especes');
      setDate(todayISO());
    }
  }, [visible]);

  const handleConfirm = () => {
    const amt = parseFloat(amountStr.replace(/\s/g, '').replace(',', '.'));
    if (!amt || amt <= 0) { Alert.alert('Vérifiez le montant :)'); return; }
    if (amt > remaining + 0.01) {
      Alert.alert('Le montant dépasse le total :)');
      return;
    }
    onConfirm(amt, method, date);
  };

  const clientName = sale.customer_name ?? 'le client';

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="formSheet" onRequestClose={onClose}>
      <SafeAreaView style={styles.modalSafe} edges={['bottom']}>
        <View style={styles.sheetHeader}>
          <Pressable onPress={onClose} style={{ minWidth: 60 }}>
            <Text variant="body" color="secondary">Annuler</Text>
          </Pressable>
          <Text variant="h4" style={{ flex: 1, textAlign: 'center' }} numberOfLines={1}>
            {clientName} a payé combien ?
          </Text>
          <View style={{ width: 60 }} />
        </View>

        <ScrollView style={{ flex: 1 }} contentContainerStyle={styles.sheetContent} keyboardShouldPersistTaps="handled">
          {/* Debt context card */}
          <Card style={[styles.contextCard, { borderLeftColor: palette.warning, borderLeftWidth: 3 }]}>
            <Text variant="caption" color="secondary">{clientName} vous doit</Text>
            <Text variant="amountLarge" style={{ color: palette.warning }}>{fmt(remaining, currency)}</Text>
          </Card>

          {/* Amount */}
          <View style={{ gap: spacing[2] }}>
            <Text variant="label">Combien {clientName} vous donne ?</Text>
            <View style={styles.amountRow}>
              <TextInput
                style={styles.amountInput}
                value={amountStr}
                onChangeText={setAmountStr}
                keyboardType="numeric"
                placeholderTextColor={palette.textSecondary}
                selectTextOnFocus
              />
              <Pressable
                style={styles.solderBtn}
                onPress={() => setAmountStr(String(Math.round(remaining)))}
              >
                <Text variant="label" style={{ color: palette.primary }}>Tout régler</Text>
              </Pressable>
            </View>
          </View>

          {/* Method */}
          <View style={{ gap: spacing[2] }}>
            <Text variant="label">Payé par :</Text>
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
            label={saving ? 'Enregistrement…' : 'Confirmer le paiement'}
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
  businessName: string;
  singleVendor: boolean;
  role: string | undefined;
  onClose: () => void;
  onRecordPayment: (amount: number, method: string, date: string) => Promise<{ ok: boolean; fullyPaid: boolean }>;
  onCancel: (reason: string) => void;
  onUpdateClient: (name: string) => void;
  saving: boolean;
}

function DetailModal({ sale, currency, businessName, singleVendor, role, onClose, onRecordPayment, onCancel, onUpdateClient, saving }: DetailModalProps) {
  const { palette } = useTheme();
  const styles = useMemo(() => makeStyles(palette), [palette]);
  const [showPaymentSheet, setShowPaymentSheet] = useState(false);
  const [showCancelForm, setShowCancelForm] = useState(false);
  const [showEditClient, setShowEditClient] = useState(false);
  const [editedClient, setEditedClient] = useState('');
  const [cancelReason, setCancelReason] = useState('');
  const [toast, setToast] = useState('');
  const receiptRef = useRef<View>(null);

  const handleShareReceipt = async () => {
    if (!sale || !receiptRef.current) return;
    try {
      const uri = await captureRef(receiptRef, { format: 'png', quality: 1 });
      await new Promise<void>(r => setTimeout(r, 350));
      await Sharing.shareAsync(uri, { mimeType: 'image/png', UTI: 'public.png', dialogTitle: 'Partager le reçu' });
    } catch {
      Alert.alert('Impossible de partager le reçu pour l\'instant.');
    }
  };

  const receiptData: ReceiptData | null = sale?.lines?.length
    ? {
        businessName,
        currency,
        items: sale.lines.map((l): ReceiptItem => ({
          name: l.product_name,
          qty: l.qty,
          unit_price: l.unit_price,
          is_bulk: false,
        })),
        total: sale.total_amount,
        discountAmount: sale.discount_amount ?? 0,
        amountPaid: sale.amount_paid,
        payment: sale.is_credit ? null : (sale.payments?.[0] ? { method: sale.payments[0].method, amount: sale.payments[0].amount } : null),
        customerName: sale.customer_name ?? undefined,
        date: new Date(sale.created_at),
        receiptId: sale.id.slice(0, 8).toUpperCase(),
      }
    : null;

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
  const remaining = sale.total_amount - discount - amountPaid;
  const displayState = getSaleDisplayState(sale);

  const saleIso = sale.sale_date ?? sale.created_at;
  const shortDate = fmtDate(saleIso);
  const longDate = fmtDateLong(saleIso);

  const hasProfit = !!(sale.lines?.some(l => l.cost_price > 0));
  const totalCost = sale.lines?.reduce((s, l) => s + l.cost_price * l.qty, 0) ?? 0;
  // For fully-paid sales with amount_paid set (discounted/credit), use the actual payment.
  // Otherwise use sale.total_amount which reflects the actual sold price (including above-catalog overrides).
  const effectiveRevenue = sale.status === 'paye' && sale.amount_paid != null
    ? sale.amount_paid
    : sale.total_amount - discount;
  const totalProfit = effectiveRevenue - totalCost;
  const margin = effectiveRevenue > 0 ? (totalProfit / effectiveRevenue) * 100 : 0;

  const showToast = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(''), 2500);
  };

  const handlePaymentSubmit = async (amount: number, method: string, date: string) => {
    const { ok, fullyPaid } = await onRecordPayment(amount, method, date);
    if (ok) {
      haptics.success();
      setShowPaymentSheet(false);
      const clientName = sale.customer_name ?? 'Client';
      showToast(fullyPaid ? `${clientName} est soldé(e) ✓` : 'Paiement enregistré');
    } else {
      haptics.error();
    }
  };

  const handleCancel = () => {
    if (!cancelReason.trim()) {
      Alert.alert('Précisez la raison :)');
      return;
    }
    Alert.alert(
      'Annuler cette vente ?',
      'Le stock sera restauré. Cette action est irréversible.',
      [
        { text: 'Retour', style: 'cancel' },
        { text: 'Annuler la vente', style: 'destructive', onPress: () => { haptics.error(); onCancel(cancelReason); } },
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
          {(role === 'administrateur' || role === 'manager') && (
            <Pressable onPress={showMenu} style={{ minWidth: 40, alignItems: 'flex-end' }}>
              <Text variant="body" color="secondary">⋯</Text>
            </Pressable>
          )}
          {role !== 'administrateur' && role !== 'manager' && (
            <View style={{ minWidth: 40 }} />
          )}
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
                  {fmt(displayState === 'partiel' ? remaining : sale.total_amount - discount, currency)}
                </Text>
                {displayState === 'partiel' && (
                  <Text variant="caption" style={{ color: palette.warning }}>
                    sur {fmt(sale.total_amount - discount, currency)}
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

          {!sale.lines ? <DetailSkeleton /> : (
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

            {/* Bénéfice — shown only when cost data exists */}
            {hasProfit && (
              (displayState === 'credit' || displayState === 'partiel') ? (
                <Card style={{ gap: spacing[2] }}>
                  <Text variant="label" color="secondary">Bénéfice</Text>
                  <Text variant="caption" style={{ color: palette.warning }}>
                    ⏳ En attente de paiement
                  </Text>
                </Card>
              ) : (
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
              )
            )}

            {/* Cancel — hidden for investisseurs who have no write access */}
            {displayState !== 'annule' && role !== 'investisseur' && (
              showCancelForm ? (
                <Card style={{ gap: spacing[3], borderColor: palette.danger + '40', borderWidth: 1 }}>
                  <Text variant="caption" color="secondary">
                    Le stock sera restauré. Entrez un motif.
                  </Text>
                  <TextInput
                    style={styles.textInput}
                    value={cancelReason}
                    onChangeText={setCancelReason}
                    placeholder="Raison de l'annulation"
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
          )}

          {/* Share receipt — only when lines are loaded */}
          {receiptData && (
            <View style={styles.receiptSection}>
              <View style={styles.receiptDivider} />
              <View ref={receiptRef} collapsable={false}>
                <SaleReceiptView data={receiptData} />
              </View>
              <View style={{ paddingHorizontal: spacing[5] }}>
                <Button label="Partager le reçu" onPress={handleShareReceipt} fullWidth variant="outline" />
              </View>
            </View>
          )}
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
  const { palette } = useTheme();
  const styles = useMemo(() => makeStyles(palette), [palette]);
  const session = useAuthStore(s => s.session);
  const businessId = session?.activeBusiness?.id ?? '';
  const userId = session?.user.id ?? '';
  const currency = session?.activeBusiness?.currency ?? 'GNF';
  const role = session?.activeMembership?.role;
  const isVendeur = role === 'vendeur';
  const isInvestisseur = role === 'investisseur';
  const canSell = !isInvestisseur;

  const fabScale   = useRef(new Animated.Value(1)).current;
  const fabOpacity = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    const easing = Easing.inOut(Easing.sin);
    const loop = Animated.loop(
      Animated.sequence([
        Animated.parallel([
          Animated.timing(fabScale,   { toValue: 1.06, duration: 2000, easing, useNativeDriver: true }),
          Animated.timing(fabOpacity, { toValue: 0.85, duration: 2000, easing, useNativeDriver: true }),
        ]),
        Animated.parallel([
          Animated.timing(fabScale,   { toValue: 1,    duration: 2000, easing, useNativeDriver: true }),
          Animated.timing(fabOpacity, { toValue: 1,    duration: 2000, easing, useNativeDriver: true }),
        ]),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, []);

  const { sales, loading, saving, error, offline, offlineSince, fetchSales, loadDetail, recordPayment, cancelSale, updateSaleClient } = useVentesStore();
  const [selected, setSelected] = useState<Vente | null>(null);
  const [filter, setFilter] = useState<'all' | 'paye' | 'credit' | 'annule'>('all');
  const [showAll, setShowAll] = useState(false);

  const [expandedDays, setExpandedDays] = useState<Set<string>>(() => new Set());
  const toggleDay = (key: string) => setExpandedDays(prev => {
    const next = new Set(prev);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });

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

  const listItems = useMemo(() => buildGroupedList(filtered, currency), [filtered, currency]);
  const visibleItems = useMemo(
    () => listItems.filter(item => item.type === 'header' || expandedDays.has(item.dateKey)),
    [listItems, expandedDays],
  );

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

      {offline && <OfflineNotice offlineSince={offlineSince} />}

      {loading && sales.length === 0 ? (
        <SkeletonList count={7} />
      ) : !loading && sales.length === 0 && error ? (
        <View style={styles.emptyState}>
          <Text variant="body" color="secondary" style={{ textAlign: 'center' }}>Données non disponibles hors ligne</Text>
        </View>
      ) : filtered.length === 0 ? (
        <View style={styles.emptyState}>
          <Text variant="body" color="secondary" style={{ textAlign: 'center' }}>
            {sales.length === 0
              ? 'Prêt pour la première vente ? Elle apparaîtra ici.'
              : 'Pas de vente sur cette période.'}
          </Text>
          {sales.length > 0 && (
            <Pressable onPress={() => setShowAll(v => !v)} style={{ marginTop: spacing[4] }}>
              <Text variant="caption" style={{ color: palette.primary }}>
                {showAll ? 'Voir les 90 derniers jours' : "Voir tout l'historique"}
              </Text>
            </Pressable>
          )}
        </View>
      ) : (
        <FlatList
          data={visibleItems}
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
              const expanded = expandedDays.has(item.key);
              return (
                <Pressable
                  onPress={() => toggleDay(item.key)}
                  style={({ pressed }) => [styles.dayHeader, pressed && { opacity: 0.7 }]}
                >
                  <View style={{ flex: 1 }}>
                    <Text variant="label" style={styles.dayLabel}>{item.label}</Text>
                    <Text variant="caption" color="secondary">
                      {item.count} vente{item.count !== 1 ? 's' : ''} · {fmt(item.total, currency)}
                      {item.hasCredit ? ' · crédit' : ''}
                    </Text>
                  </View>
                  <Ionicons
                    name={expanded ? 'chevron-down' : 'chevron-forward'}
                    size={16}
                    color={palette.textSecondary}
                  />
                </Pressable>
              );
            }

            const { sale } = item;
            const ds = getSaleDisplayState(sale);
            const rowColor = ds === 'paye' ? palette.success : ds === 'annule' ? palette.danger : palette.warning;
            const isCredit = ds === 'credit' || ds === 'partiel';
            const remaining = sale.total_amount - (sale.discount_amount ?? 0) - (sale.amount_paid ?? 0);

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
                      {isCredit ? `Reste ${fmt(remaining, currency)}` : fmt(sale.total_amount - (sale.discount_amount ?? 0), currency)}
                    </Text>
                  </View>
                  <Text variant="caption" color="secondary">
                    {isCredit
                      ? `Crédit · sur ${fmt(sale.total_amount - (sale.discount_amount ?? 0), currency)}`
                      : ds === 'annule'
                      ? 'Annulé'
                      : (sale.discount_amount ?? 0) > 0 ? 'Payé · rabais' : 'Payé'}
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
          businessName={session?.activeBusiness?.name ?? ''}
          singleVendor={singleVendor}
          role={role}
          onClose={() => setSelected(null)}
          onRecordPayment={handleRecordPayment}
          onCancel={handleCancel}
          onUpdateClient={handleUpdateClient}
          saving={saving}
        />
      )}

      {canSell && !selected && (
        <Animated.View style={[styles.fabContainer, { transform: [{ scale: fabScale }], opacity: fabOpacity }]}>
          <Pressable
            onPress={() => router.push('/(app)/(tabs)/vendre')}
            style={({ pressed }) => [styles.fab, pressed && { opacity: 0.82 }]}
            accessibilityLabel="Nouvelle vente"
            accessibilityRole="button"
          >
            <Text style={styles.fabIcon}>+</Text>
          </Pressable>
        </Animated.View>
      )}
    </SafeAreaView>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

function makeStyles(p: Palette) {
  return StyleSheet.create({
  safe: { flex: 1, backgroundColor: p.background },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: spacing[5], paddingVertical: spacing[4] },
  summaryLine: { paddingHorizontal: spacing[5], paddingBottom: spacing[2] },
  filterRow: { flexDirection: 'row', paddingHorizontal: spacing[5], gap: spacing[2], marginBottom: spacing[3] },
  filterTab: { flex: 1, alignItems: 'center', paddingHorizontal: spacing[2], paddingVertical: spacing[1.5], borderRadius: radius.full, backgroundColor: p.surface, borderWidth: 1, borderColor: p.border },
  filterTabActive: { backgroundColor: p.primary, borderColor: p.primary },
  list: { paddingHorizontal: spacing[5], paddingBottom: spacing[10] },
  dayHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingTop: spacing[4],
    paddingBottom: spacing[3],
    paddingHorizontal: spacing[1],
    gap: spacing[2],
  },
  dayLabel: { marginBottom: 2 },
  saleRow: { paddingVertical: spacing[3], backgroundColor: p.surface },
  saleTop: { flexDirection: 'row', alignItems: 'center', gap: spacing[2] },
  offlineBanner: { alignItems: 'center', justifyContent: 'center', paddingVertical: spacing[1], borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: p.border },
  emptyState: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  center: { textAlign: 'center', marginTop: spacing[10] },
  showAllBtn: { alignItems: 'center', paddingVertical: spacing[5] },
  fabContainer: { position: 'absolute', bottom: 194, right: spacing[4], zIndex: 10 },
  fab: {
    width: 56, height: 56, borderRadius: radius.full,
    backgroundColor: p.primary,
    alignItems: 'center', justifyContent: 'center',
    shadowColor: colors.neutral[900],
    shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.18, shadowRadius: 8,
    elevation: 8,
  },
  fabIcon: { fontSize: 28, lineHeight: 32, fontWeight: '300', color: p.textInverse, marginTop: -2 },

  // Detail modal
  modalSafe: { flex: 1, backgroundColor: p.background },
  receiptSection: { marginHorizontal: -spacing[5], paddingBottom: spacing[6], gap: spacing[3] },
  receiptDivider: { height: 1, backgroundColor: p.border },
  modalHeader: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: spacing[5], paddingVertical: spacing[4],
    borderBottomWidth: 1, borderBottomColor: p.border,
  },
  pad: { padding: spacing[5], gap: spacing[4], paddingBottom: spacing[10] },

  banner: {
    borderRadius: radius.lg, padding: spacing[4], gap: spacing[3],
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
  },
  bannerGreen: { backgroundColor: p.success + '20', borderWidth: 1, borderColor: p.success + '40' },
  bannerOrange: { backgroundColor: p.warning + '15', borderWidth: 1, borderColor: p.warning + '40' },
  bannerRed: { backgroundColor: p.danger + '15', borderWidth: 1, borderColor: p.danger + '40', flexDirection: 'column', alignItems: 'flex-start' },

  toast: {
    backgroundColor: p.primary, paddingHorizontal: spacing[5], paddingVertical: spacing[3],
    alignItems: 'center',
  },

  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  lineRow: { flexDirection: 'row', alignItems: 'center', gap: spacing[3] },
  divider: { height: 1, backgroundColor: p.border, marginVertical: spacing[1] },

  textInput: {
    paddingHorizontal: spacing[4], paddingVertical: spacing[3],
    borderRadius: radius.md, borderWidth: 1, borderColor: p.border,
    backgroundColor: p.surface, color: p.textPrimary, fontSize: 16,
  },

  // Payment sheet
  sheetHeader: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: spacing[5], paddingVertical: spacing[4],
    borderBottomWidth: 1, borderBottomColor: p.border,
  },
  sheetContent: { padding: spacing[5], gap: spacing[4] },
  sheetFooter: {
    padding: spacing[5], borderTopWidth: 1, borderTopColor: p.border,
    backgroundColor: p.surface,
  },
  contextCard: { gap: spacing[1] },
  amountRow: { flexDirection: 'row', gap: spacing[3], alignItems: 'center' },
  amountInput: {
    flex: 1, paddingHorizontal: spacing[4], paddingVertical: spacing[3],
    borderRadius: radius.md, borderWidth: 1, borderColor: p.border,
    backgroundColor: p.surface, color: p.textPrimary,
    fontSize: 28, fontWeight: '700',
  },
  solderBtn: {
    paddingHorizontal: spacing[3], paddingVertical: spacing[3],
    borderRadius: radius.md, borderWidth: 1, borderColor: p.primary,
  },
  methodRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing[2] },
  chip: { paddingHorizontal: spacing[3], paddingVertical: spacing[1.5], borderRadius: radius.full, borderWidth: 1, borderColor: p.border, backgroundColor: p.surface },
  chipActive: { backgroundColor: p.primary, borderColor: p.primary },
  });
}
