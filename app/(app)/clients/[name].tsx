import { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, Linking, Modal, Pressable, ScrollView, StyleSheet, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router, useLocalSearchParams } from 'expo-router';
import { Card } from '@/src/components/ui/Card';
import { Text } from '@/src/components/ui/Text';
import { Button } from '@/src/components/ui/Button';
import { Input } from '@/src/components/ui/Input';
import { palette, spacing, colors, radius } from '@/src/theme';
import { useAuthStore } from '@/stores/auth';
import { useVentesStore, type Vente } from '@/stores/ventes';
import { supabase } from '@/lib/supabase';

function fmt(n: number, cur: string) { return `${Math.round(n).toLocaleString('fr-FR')} ${cur}`; }

function methodLabel(m: string) {
  if (m === 'especes') return 'Espèces';
  if (m === 'orange') return 'Orange Money';
  if (m === 'mtn' || m === 'moov') return 'Mobile Money';
  return 'Autre';
}

function dateLabel(iso: string) {
  const d = iso.includes('T') ? new Date(iso) : new Date(iso + 'T00:00:00');
  return d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' });
}

function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const PAY_METHODS = [
  { key: 'especes', label: 'Espèces' },
  { key: 'orange', label: 'Orange Money' },
  { key: 'mtn', label: 'Mobile Money' },
  { key: 'digital', label: 'Autre' },
];

interface ClientRecord { id: string; name: string; phone: string | null; notes: string | null; }
interface LedgerPayment { id: string; order_id: string; method: string; amount: number; date: string; }
type HistoryItem =
  | { type: 'sale'; date: string; sale: Vente }
  | { type: 'payment'; date: string; payment: LedgerPayment };

// ─── Edit Client Modal ────────────────────────────────────────────────────────

function EditModal({
  visible, clientName, record, businessId, userId, onClose, onSaved,
}: {
  visible: boolean; clientName: string; record: ClientRecord | null;
  businessId: string; userId: string;
  onClose: () => void; onSaved: (r: ClientRecord) => void;
}) {
  const [phone, setPhone] = useState('');
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (visible) { setPhone(record?.phone ?? ''); setNotes(record?.notes ?? ''); }
  }, [visible, record]);

  const handleSave = async () => {
    setSaving(true);
    if (record) {
      const { error } = await supabase
        .from('clients')
        .update({ phone: phone.trim() || null, notes: notes.trim() || null, updated_at: new Date().toISOString() })
        .eq('id', record.id);
      if (!error) onSaved({ ...record, phone: phone.trim() || null, notes: notes.trim() || null });
      else Alert.alert('Erreur', 'Impossible de modifier.');
    } else {
      const { data, error } = await supabase
        .from('clients')
        .insert({ business_id: businessId, name: clientName, phone: phone.trim() || null, notes: notes.trim() || null, created_by: userId })
        .select().single();
      if (!error && data) onSaved(data as ClientRecord);
      else Alert.alert('Erreur', 'Impossible de sauvegarder.');
    }
    setSaving(false);
  };

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="formSheet" onRequestClose={onClose}>
      <SafeAreaView style={styles.modalSafe}>
        <View style={styles.hdr}>
          <Pressable onPress={onClose}><Text variant="body" color="secondary">Annuler</Text></Pressable>
          <Text variant="h4">Modifier client</Text>
          <View style={{ width: 60 }} />
        </View>
        <ScrollView contentContainerStyle={styles.pad} keyboardShouldPersistTaps="handled">
          <Text variant="label">{clientName}</Text>
          <Input label="Téléphone" value={phone} onChangeText={setPhone}
            placeholder="Ex: 620 00 00 00" keyboardType="phone-pad" />
          <Input label="Notes" value={notes} onChangeText={setNotes}
            placeholder="Informations supplémentaires…" multiline />
        </ScrollView>
        <View style={styles.footer}>
          <Button label={saving ? 'Enregistrement…' : 'Enregistrer'}
            onPress={handleSave} loading={saving} fullWidth size="lg" />
        </View>
      </SafeAreaView>
    </Modal>
  );
}

// ─── Payment Modal ────────────────────────────────────────────────────────────

function PayModal({
  visible, clientName, totalOwed, creditSales, currency, saving,
  onClose, onRecord,
}: {
  visible: boolean; clientName: string; totalOwed: number;
  creditSales: Vente[]; currency: string; saving: boolean;
  onClose: () => void;
  onRecord: (amount: number, method: string, date: string, specificSaleId?: string) => void;
}) {
  const [amountStr, setAmountStr] = useState('');
  const [method, setMethod] = useState('especes');
  const [date, setDate] = useState(todayISO());
  const [allocation, setAllocation] = useState<'fifo' | 'specific'>('fifo');
  const [specificSaleId, setSpecificSaleId] = useState('');

  useEffect(() => {
    if (visible) {
      setAmountStr(Math.round(totalOwed).toString());
      setMethod('especes');
      setDate(todayISO());
      setAllocation('fifo');
      setSpecificSaleId(creditSales[0]?.id ?? '');
    }
  }, [visible, totalOwed]);

  const amount = parseFloat(amountStr.replace(/\s/g, '')) || 0;

  const saleRemaining = (id: string) => {
    const sale = creditSales.find(s => s.id === id);
    if (!sale) return 0;
    return sale.total_amount - (sale.amount_paid ?? 0);
  };

  const handleRecord = () => {
    if (amount <= 0) { Alert.alert('Montant invalide', 'Entrez un montant supérieur à zéro.'); return; }
    if (allocation === 'fifo' && amount > totalOwed + 0.01) {
      Alert.alert('Montant trop élevé', `Le solde dû est de ${fmt(totalOwed, currency)}.`);
      return;
    }
    if (allocation === 'specific') {
      const max = saleRemaining(specificSaleId);
      if (amount > max + 0.01) {
        Alert.alert('Montant trop élevé', `Le reste à payer pour cette vente est de ${fmt(max, currency)}.`);
        return;
      }
      onRecord(amount, method, date, specificSaleId);
    } else {
      onRecord(amount, method, date);
    }
  };

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="formSheet" onRequestClose={onClose}>
      <SafeAreaView style={styles.modalSafe}>
        <View style={styles.hdr}>
          <Pressable onPress={onClose}><Text variant="body" color="secondary">Annuler</Text></Pressable>
          <Text variant="h4" style={{ flex: 1, textAlign: 'center' }} numberOfLines={1}>
            {clientName} a payé combien?
          </Text>
          <View style={{ width: 60 }} />
        </View>
        <ScrollView contentContainerStyle={styles.pad} keyboardShouldPersistTaps="handled">
          {/* Context */}
          <Card style={[styles.contextCard, { borderLeftColor: palette.warning, borderLeftWidth: 3 }]}>
            <Text variant="caption" color="secondary">Doit en total</Text>
            <Text variant="amountLarge" style={{ color: palette.warning }}>{fmt(totalOwed, currency)}</Text>
          </Card>

          {/* Amount */}
          <View style={{ gap: spacing[2] }}>
            <Text variant="label">Montant reçu</Text>
            <View style={styles.amountRow}>
              <TextInput
                style={styles.amountInput}
                value={amountStr}
                onChangeText={setAmountStr}
                keyboardType="numeric"
                placeholder="0"
                placeholderTextColor={palette.textDisabled}
                selectTextOnFocus
              />
              <Pressable
                style={styles.solderBtn}
                onPress={() => setAmountStr(Math.round(totalOwed).toString())}
              >
                <Text variant="label" style={{ color: palette.primary }}>Solder tout</Text>
              </Pressable>
            </View>
          </View>

          {/* Method */}
          <View style={{ gap: spacing[2] }}>
            <Text variant="label">Mode de paiement</Text>
            <View style={styles.chipRow}>
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

          {/* Allocation */}
          <View style={{ gap: spacing[2] }}>
            <Text variant="label">Imputer à</Text>
            <View style={styles.chipRow}>
              <Pressable style={[styles.chip, allocation === 'fifo' && styles.chipActive]}
                onPress={() => setAllocation('fifo')}>
                <Text variant="caption" style={{ color: allocation === 'fifo' ? palette.textInverse : palette.textPrimary }}>
                  Plus ancien d'abord
                </Text>
              </Pressable>
              <Pressable style={[styles.chip, allocation === 'specific' && styles.chipActive]}
                onPress={() => setAllocation('specific')}>
                <Text variant="caption" style={{ color: allocation === 'specific' ? palette.textInverse : palette.textPrimary }}>
                  Vente spécifique
                </Text>
              </Pressable>
            </View>
            {allocation === 'specific' && creditSales.length > 0 && (
              <View style={{ gap: spacing[1] }}>
                {creditSales.map(s => {
                  const rem = s.total_amount - (s.amount_paid ?? 0);
                  return (
                    <Pressable key={s.id} onPress={() => setSpecificSaleId(s.id)}
                      style={[styles.saleOption, specificSaleId === s.id && styles.saleOptionActive]}>
                      <Text variant="caption" style={{ color: specificSaleId === s.id ? palette.textInverse : palette.textPrimary }}>
                        {dateLabel(s.sale_date ?? s.created_at)} — {fmt(rem, currency)}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
            )}
          </View>
        </ScrollView>
        <View style={styles.footer}>
          <Button label={saving ? 'Enregistrement…' : 'Enregistrer'}
            onPress={handleRecord} loading={saving} fullWidth size="lg" />
        </View>
      </SafeAreaView>
    </Modal>
  );
}

// ─── Main Screen ──────────────────────────────────────────────────────────────

export default function ClientLedgerScreen() {
  const { name: encodedName } = useLocalSearchParams<{ name: string }>();
  const clientName = decodeURIComponent(encodedName ?? '');

  const session = useAuthStore(s => s.session);
  const businessId = session?.activeBusiness?.id ?? '';
  const userId = session?.user.id ?? '';
  const currency = session?.activeBusiness?.currency ?? 'GNF';
  const role = session?.activeMembership?.role;
  const canEdit = role === 'administrateur' || role === 'manager';

  const { sales, loading, saving, fetchSales, recordPayment, recordClientPayment } = useVentesStore();

  const [ledgerPayments, setLedgerPayments] = useState<LedgerPayment[]>([]);
  const [clientRecord, setClientRecord] = useState<ClientRecord | null>(null);
  const [loadingLocal, setLoadingLocal] = useState(true);
  const [showPayModal, setShowPayModal] = useState(false);
  const [showEditModal, setShowEditModal] = useState(false);

  // Load sales + client record on mount
  useEffect(() => {
    if (!businessId) return;
    if (sales.length === 0) fetchSales(businessId);
    loadClientRecord();
  }, [businessId]);

  // Reload ledger payments whenever sales change (catches new payments)
  useEffect(() => {
    if (loading) return;
    loadLedgerPayments();
  }, [sales, loading, clientName]);

  const loadClientRecord = async () => {
    const { data } = await supabase
      .from('clients').select('*').eq('business_id', businessId).eq('name', clientName).maybeSingle();
    setClientRecord(data as ClientRecord | null);
  };

  const loadLedgerPayments = async () => {
    const clientSales = sales.filter(s => s.customer_name === clientName);
    if (clientSales.length === 0) { setLoadingLocal(false); return; }

    const saleIds = clientSales.map(s => s.id);
    const { data } = await supabase
      .from('payments')
      .select('id, order_id, method, amount, date')
      .in('order_id', saleIds)
      .order('date', { ascending: true });
    setLedgerPayments((data ?? []) as LedgerPayment[]);
    setLoadingLocal(false);
  };

  const clientSales = useMemo(
    () => sales.filter(s => s.customer_name === clientName && s.status !== 'annule'),
    [sales, clientName],
  );

  const creditSales = useMemo(
    () => clientSales.filter(s => s.status === 'credit')
      .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime()),
    [clientSales],
  );

  const totalSold = clientSales.reduce((s, v) => s + v.total_amount, 0);
  const totalPaid = ledgerPayments.reduce((s, p) => s + p.amount, 0);
  const totalOwed = Math.max(0, totalSold - totalPaid);

  // Interleaved history — most recent first
  const history = useMemo<HistoryItem[]>(() => {
    const items: HistoryItem[] = [];
    for (const s of clientSales) {
      items.push({ type: 'sale', date: s.sale_date ?? s.created_at.split('T')[0], sale: s });
    }
    for (const p of ledgerPayments) {
      items.push({ type: 'payment', date: p.date, payment: p });
    }
    return items.sort((a, b) => b.date.localeCompare(a.date) || (a.type === 'payment' ? -1 : 1));
  }, [clientSales, ledgerPayments]);

  const handleRecord = useCallback(async (amount: number, method: string, date: string, specificSaleId?: string) => {
    let result: { ok: boolean; fullyPaid?: boolean; fullySettled?: boolean };
    if (specificSaleId) {
      result = await recordPayment(specificSaleId, amount, method, date);
    } else {
      result = await recordClientPayment(clientName, businessId, amount, method, date);
    }
    if (result.ok) {
      setShowPayModal(false);
      const settled = result.fullySettled ?? result.fullyPaid ?? false;
      if (settled) Alert.alert(`${clientName} est soldé(e) ✓`, 'Compte entièrement payé.');
      // Reload ledger payments to reflect changes
      loadLedgerPayments();
    }
  }, [clientName, businessId, recordPayment, recordClientPayment]);

  const openMenu = useCallback(() => {
    if (!canEdit) return;
    Alert.alert(clientName, undefined, [
      { text: 'Modifier les infos', onPress: () => setShowEditModal(true) },
      { text: 'Annuler', style: 'cancel' },
    ]);
  }, [clientName, canEdit]);

  if (loadingLocal && loading) {
    return (
      <SafeAreaView style={styles.safe} edges={['top']}>
        <View style={styles.hdr}>
          <Pressable onPress={() => router.back()}><Text variant="body" color="secondary">‹ Retour</Text></Pressable>
          <Text variant="h4" style={{ flex: 1, textAlign: 'center' }} numberOfLines={1}>{clientName}</Text>
          <View style={{ width: 60 }} />
        </View>
        <Text variant="body" color="secondary" style={{ textAlign: 'center', marginTop: spacing[8] }}>
          Chargement…
        </Text>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      {/* Header */}
      <View style={styles.hdr}>
        <Pressable onPress={() => router.back()}><Text variant="body" color="secondary">‹ Retour</Text></Pressable>
        <Text variant="h4" style={{ flex: 1, textAlign: 'center' }} numberOfLines={1}>{clientName}</Text>
        {canEdit ? (
          <Pressable onPress={openMenu} style={{ width: 60, alignItems: 'flex-end' }}>
            <Text variant="body" color="secondary">⋯</Text>
          </Pressable>
        ) : (
          <View style={{ width: 60 }} />
        )}
      </View>

      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>

        {/* Status banner */}
        {totalOwed > 0 ? (
          <View style={styles.bannerOrange}>
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text variant="caption" style={{ color: colors.warning[700] }}>⏳ Doit</Text>
              <Text
                variant="amountLarge"
                style={{ color: colors.warning[700] }}
                adjustsFontSizeToFit
                numberOfLines={1}
              >
                {fmt(totalOwed, currency)}
              </Text>
            </View>
            <Button label="+ Enregistrer un paiement" size="sm"
              onPress={() => setShowPayModal(true)} style={{ flexShrink: 0 }} />
          </View>
        ) : (
          <View style={styles.bannerGreen}>
            <Text variant="label" style={{ color: colors.success[700] }}>✓ Compte soldé</Text>
          </View>
        )}

        {/* Contact row */}
        {clientRecord?.phone && (
          <Card style={styles.contactRow}>
            <Text variant="body">{clientRecord.phone}</Text>
            <Pressable onPress={() => Linking.openURL(`tel:${clientRecord.phone}`)}>
              <Text variant="label" style={{ color: palette.primary }}>Appeler</Text>
            </Pressable>
          </Card>
        )}

        {/* Historique */}
        {history.length > 0 && (
          <View style={styles.section}>
            <Text variant="label" color="secondary" style={styles.sectionTitle}>Historique</Text>
            {history.map((item, idx) => {
              if (item.type === 'sale') {
                const s = item.sale;
                const remaining = s.total_amount - (s.amount_paid ?? 0);
                const isCredit = s.status === 'credit';
                return (
                  <Pressable key={`s-${s.id}`} onPress={() => router.push(`/ventes`)}
                    style={[styles.ledgerRow, idx < history.length - 1 && styles.rowBorder]}>
                    <View style={{ flex: 1 }}>
                      <Text variant="body" numberOfLines={1}>
                        {s.lines?.map(l => l.product_name).join(', ') || 'Vente'}
                      </Text>
                      <Text variant="caption" color="secondary">{dateLabel(item.date)}</Text>
                      {isCredit && (s.amount_paid ?? 0) > 0 && (
                        <Text variant="caption" style={{ color: palette.warning }}>
                          Payé: {fmt(s.amount_paid!, currency)} · Reste: {fmt(remaining, currency)}
                        </Text>
                      )}
                    </View>
                    <Text variant="label" style={{ color: isCredit ? palette.warning : palette.textSecondary }}>
                      +{fmt(s.total_amount, currency)}
                    </Text>
                  </Pressable>
                );
              } else {
                const p = item.payment;
                return (
                  <View key={`p-${p.id}`} style={[styles.ledgerRow, idx < history.length - 1 && styles.rowBorder]}>
                    <View style={{ flex: 1 }}>
                      <Text variant="body">{methodLabel(p.method)}</Text>
                      <Text variant="caption" color="secondary">{dateLabel(p.date)}</Text>
                    </View>
                    <Text variant="label" style={{ color: palette.success }}>−{fmt(p.amount, currency)}</Text>
                  </View>
                );
              }
            })}
          </View>
        )}

        {clientSales.length === 0 && (
          <Text variant="body" color="secondary" style={{ textAlign: 'center', marginTop: spacing[6] }}>
            Aucune vente enregistrée.
          </Text>
        )}

        {/* Footer totals */}
        {clientSales.length > 0 && (
          <Card style={{ gap: spacing[3] }}>
            <View style={styles.totalRow}>
              <Text variant="body" color="secondary">Total vendu à {clientName}</Text>
              <Text variant="label">{fmt(totalSold, currency)}</Text>
            </View>
            <View style={styles.totalRow}>
              <Text variant="body" color="secondary">Total payé</Text>
              <Text variant="label" style={{ color: palette.success }}>{fmt(totalPaid, currency)}</Text>
            </View>
            <View style={[styles.totalRow, styles.totalRowBold]}>
              <Text variant="label">Solde</Text>
              <Text variant="label" style={{ color: totalOwed > 0 ? palette.warning : palette.success }}>
                {totalOwed > 0 ? fmt(totalOwed, currency) : '✓ Soldé'}
              </Text>
            </View>
          </Card>
        )}
      </ScrollView>

      <PayModal
        visible={showPayModal}
        clientName={clientName}
        totalOwed={totalOwed}
        creditSales={creditSales}
        currency={currency}
        saving={saving}
        onClose={() => setShowPayModal(false)}
        onRecord={handleRecord}
      />

      <EditModal
        visible={showEditModal}
        clientName={clientName}
        record={clientRecord}
        businessId={businessId}
        userId={userId}
        onClose={() => setShowEditModal(false)}
        onSaved={(r) => { setClientRecord(r); setShowEditModal(false); }}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: palette.background },
  hdr: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    padding: spacing[5], borderBottomWidth: 1, borderBottomColor: palette.border,
  },
  content: { padding: spacing[5], gap: spacing[4], paddingBottom: spacing[10] },

  bannerOrange: {
    backgroundColor: colors.warning[50], borderRadius: radius.lg,
    borderWidth: 1, borderColor: colors.warning[100],
    padding: spacing[4], flexDirection: 'row',
    alignItems: 'center', justifyContent: 'space-between',
    gap: spacing[3],
  },
  bannerGreen: {
    backgroundColor: colors.success[50], borderRadius: radius.lg,
    borderWidth: 1, borderColor: colors.success[100],
    padding: spacing[4], alignItems: 'center',
  },
  contactRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },

  section: {
    backgroundColor: palette.surface, borderRadius: radius.lg,
    borderWidth: 1, borderColor: palette.border, overflow: 'hidden',
  },
  sectionTitle: {
    paddingHorizontal: spacing[4], paddingVertical: spacing[3],
    borderBottomWidth: 1, borderBottomColor: palette.border,
  },
  ledgerRow: {
    flexDirection: 'row', alignItems: 'center', gap: spacing[3],
    paddingHorizontal: spacing[4], paddingVertical: spacing[3],
  },
  rowBorder: { borderBottomWidth: 1, borderBottomColor: palette.border },

  totalRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  totalRowBold: { paddingTop: spacing[3], borderTopWidth: 1, borderTopColor: palette.border, marginTop: spacing[1] },

  // Modals
  modalSafe: { flex: 1, backgroundColor: palette.background },
  pad: { padding: spacing[5], gap: spacing[4], paddingBottom: spacing[10] },
  footer: { padding: spacing[5], borderTopWidth: 1, borderTopColor: palette.border, backgroundColor: palette.surface },

  contextCard: { gap: spacing[1] },
  amountRow: { flexDirection: 'row', gap: spacing[3], alignItems: 'center' },
  amountInput: {
    flex: 1, paddingHorizontal: spacing[4], paddingVertical: spacing[3],
    borderRadius: radius.md, borderWidth: 1, borderColor: palette.border,
    backgroundColor: palette.surface, color: palette.textPrimary,
    fontSize: 28, fontWeight: '700',
  },
  solderBtn: {
    paddingHorizontal: spacing[3], paddingVertical: spacing[3],
    borderRadius: radius.md, borderWidth: 1, borderColor: palette.primary,
  },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing[2] },
  chip: {
    paddingHorizontal: spacing[3], paddingVertical: spacing[1.5],
    borderRadius: radius.full, borderWidth: 1, borderColor: palette.border,
    backgroundColor: palette.surface,
  },
  chipActive: { backgroundColor: palette.primary, borderColor: palette.primary },
  saleOption: {
    paddingHorizontal: spacing[3], paddingVertical: spacing[2],
    borderRadius: radius.md, borderWidth: 1, borderColor: palette.border,
    backgroundColor: palette.surface,
  },
  saleOptionActive: { backgroundColor: palette.primary, borderColor: palette.primary },
});
