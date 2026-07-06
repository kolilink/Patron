import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Animated, Linking, Modal, Pressable, ScrollView, StyleSheet, Text as RNText, TextInput, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { haptics } from '@/lib/haptics';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Screen } from '@/src/components/ui/Screen';
import { router, useLocalSearchParams } from 'expo-router';
import { Card } from '@/src/components/ui/Card';
import { Text } from '@/src/components/ui/Text';
import { Button } from '@/src/components/ui/Button';
import { Input } from '@/src/components/ui/Input';
import { useTheme, spacing, radius } from '@/src/theme';
import type { Palette } from '@/src/theme';
import { useAuthStore } from '@/stores/auth';
import { useVentesStore, type Vente } from '@/stores/ventes';
import { supabase } from '@/lib/supabase';
import { formatAmountInput, parseAmountInput } from '@/src/utils/format';

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

function fmtDueDate(iso: string): string {
  const d = new Date(iso + 'T00:00:00');
  const diff = Math.round((d.getTime() - Date.now()) / 86400000);
  if (diff < 0) return `En retard de ${Math.abs(diff)} j`;
  if (diff === 0) return "Prévu aujourd'hui";
  if (diff <= 3) return `Dans ${diff} jour${diff > 1 ? 's' : ''}`;
  return `Prévu le ${d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' })}`;
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
interface DayGroup {
  dateKey: string;
  label: string;
  sales: Vente[];
  payments: LedgerPayment[];
  salesTotal: number;
  paymentsTotal: number;
  unpaidCount: number;
  unpaidTotal: number;
}

// ─── Edit Client Modal ────────────────────────────────────────────────────────

function EditModal({
  visible, displayName, record, businessId, userId, onClose, onSaved,
}: {
  visible: boolean; displayName: string; record: ClientRecord | null;
  businessId: string; userId: string;
  onClose: () => void; onSaved: (r: ClientRecord) => void;
}) {
  const { palette } = useTheme();
  const styles = useMemo(() => makeStyles(palette), [palette]);
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
      else Alert.alert('Pas enregistré. On reprend :)');
    } else {
      const { data, error } = await supabase
        .from('clients')
        .insert({ business_id: businessId, name: displayName, phone: phone.trim() || null, notes: notes.trim() || null, created_by: userId })
        .select().single();
      if (!error && data) onSaved(data as ClientRecord);
      else Alert.alert('Pas enregistré. On reprend :)');
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
          <Text variant="label">{displayName}</Text>
          <Input label="Téléphone" value={phone} onChangeText={setPhone}
            placeholder="620 00 00 00" keyboardType="phone-pad" />
          <Input label="Notes" value={notes} onChangeText={setNotes}
            placeholder="Notes sur ce client" multiline />
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
  visible, displayName, totalOwed, creditSales, currency, saving,
  onClose, onRecord,
}: {
  visible: boolean; displayName: string; totalOwed: number;
  creditSales: Vente[]; currency: string; saving: boolean;
  onClose: () => void;
  onRecord: (amount: number, method: string, date: string, specificSaleId?: string) => void;
}) {
  const { palette } = useTheme();
  const styles = useMemo(() => makeStyles(palette), [palette]);
  const [amountStr, setAmountStr] = useState('');
  const [method, setMethod] = useState('especes');
  const [date, setDate] = useState(todayISO());
  const [allocation, setAllocation] = useState<'fifo' | 'specific'>('fifo');
  const [specificSaleId, setSpecificSaleId] = useState('');

  useEffect(() => {
    if (visible) {
      setAmountStr(formatAmountInput(String(Math.round(totalOwed))));
      setMethod('especes');
      setDate(todayISO());
      setAllocation('fifo');
      setSpecificSaleId(creditSales[0]?.id ?? '');
    }
  }, [visible, totalOwed]);

  const amount = parseAmountInput(amountStr);

  const saleRemaining = (id: string) => {
    const sale = creditSales.find(s => s.id === id);
    if (!sale) return 0;
    return sale.total_amount - (sale.discount_amount ?? 0) - (sale.amount_paid ?? 0);
  };

  const handleRecord = () => {
    if (amount <= 0) { Alert.alert('Vérifiez le montant :)'); return; }
    if (allocation === 'fifo' && amount > totalOwed + 0.01) {
      Alert.alert('Le montant dépasse le total :)');
      return;
    }
    if (allocation === 'specific') {
      const max = saleRemaining(specificSaleId);
      if (amount > max + 0.01) {
        Alert.alert('Le montant dépasse le total :)');
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
          <Pressable onPress={onClose} style={{ minWidth: 60 }}>
            <Text variant="body" color="secondary">Annuler</Text>
          </Pressable>
          <Text variant="h4" style={{ flex: 1, textAlign: 'center' }} numberOfLines={1}>
            {displayName} a payé combien ?
          </Text>
          <View style={{ width: 60 }} />
        </View>
        <ScrollView contentContainerStyle={styles.pad} keyboardShouldPersistTaps="handled">
          {/* Context */}
          <Card style={[styles.contextCard, { borderLeftColor: palette.warning, borderLeftWidth: 3 }]}>
            <Text variant="caption" color="secondary">{displayName} vous doit</Text>
            <Text variant="amountLarge" style={{ color: palette.warning }}>{fmt(totalOwed, currency)}</Text>
          </Card>

          {/* Amount */}
          <View style={{ gap: spacing[2] }}>
            <Text variant="label">Combien {displayName} vous donne ?</Text>
            <View style={styles.amountRow}>
              <TextInput
                style={styles.amountInput}
                value={amountStr}
                onChangeText={v => setAmountStr(formatAmountInput(v))}
                keyboardType="numeric"
                placeholderTextColor={palette.textDisabled}
                selectTextOnFocus
              />
              <Pressable
                style={styles.solderBtn}
                onPress={() => setAmountStr(formatAmountInput(String(Math.round(totalOwed))))}
              >
                <Text variant="label" style={{ color: palette.primary }}>Tout régler</Text>
              </Pressable>
            </View>
          </View>

          {/* Method */}
          <View style={{ gap: spacing[2] }}>
            <Text variant="label">Payé par :</Text>
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
            <Text variant="label">Déduire de :</Text>
            <View style={styles.chipRow}>
              <Pressable style={[styles.chip, allocation === 'fifo' && styles.chipActive]}
                onPress={() => setAllocation('fifo')}>
                <Text variant="caption" style={{ color: allocation === 'fifo' ? palette.textInverse : palette.textPrimary }}>
                  Dette la plus ancienne
                </Text>
              </Pressable>
              <Pressable style={[styles.chip, allocation === 'specific' && styles.chipActive]}
                onPress={() => setAllocation('specific')}>
                <Text variant="caption" style={{ color: allocation === 'specific' ? palette.textInverse : palette.textPrimary }}>
                  Choisir une dette
                </Text>
              </Pressable>
            </View>
            {allocation === 'specific' && creditSales.length > 0 && (
              <View style={{ gap: spacing[1] }}>
                {creditSales.map(s => {
                  const rem = s.total_amount - (s.discount_amount ?? 0) - (s.amount_paid ?? 0);
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
          <Button label={saving ? 'Enregistrement…' : 'Confirmer le paiement'}
            onPress={handleRecord} loading={saving} fullWidth size="lg" />
        </View>
      </SafeAreaView>
    </Modal>
  );
}

// ─── Main Screen ──────────────────────────────────────────────────────────────

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default function ClientLedgerScreen() {
  const { palette } = useTheme();
  const styles = useMemo(() => makeStyles(palette), [palette]);
  const { name: encodedName } = useLocalSearchParams<{ name: string }>();
  const routeParam = decodeURIComponent(encodedName ?? '');
  const isClientId = UUID_RE.test(routeParam);

  const session = useAuthStore(s => s.session);
  const businessId = session?.activeBusiness?.id ?? '';
  const userId = session?.user.id ?? '';
  const currency = session?.activeBusiness?.currency ?? 'GNF';
  const role = session?.activeMembership?.role;
  const canEdit = role === 'administrateur' || role === 'manager';

  const { sales, loading, saving, fetchSales, recordPayment, recordClientPayment } = useVentesStore();

  // displayName is resolved after clientRecord loads when routing by UUID
  const [displayName, setDisplayName] = useState(isClientId ? '' : routeParam);
  const [ledgerPayments, setLedgerPayments] = useState<LedgerPayment[]>([]);
  const [clientRecord, setClientRecord] = useState<ClientRecord | null>(null);
  const [loadingLocal, setLoadingLocal] = useState(true);
  const [showPayModal, setShowPayModal] = useState(false);
  const [showEditModal, setShowEditModal] = useState(false);
  const [successPayment, setSuccessPayment] = useState<{ amount: number } | null>(null);
  const checkScale = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (successPayment) {
      checkScale.setValue(0);
      Animated.spring(checkScale, { toValue: 1, useNativeDriver: true, tension: 65, friction: 8 }).start();
    }
  }, [successPayment]);

  // Load sales + client record on mount — always refresh to catch new credit sales
  useEffect(() => {
    if (!businessId) return;
    fetchSales(businessId);
    loadClientRecord();
  }, [businessId]);

  // Reload ledger payments whenever sales change (catches new payments)
  useEffect(() => {
    if (loading) return;
    loadLedgerPayments();
  }, [sales, loading, displayName]);

  const loadClientRecord = async () => {
    let query = supabase.from('clients').select('*').eq('business_id', businessId);
    if (isClientId) {
      query = query.eq('id', routeParam);
    } else {
      query = query.eq('name', routeParam);
    }
    const { data } = await query.maybeSingle();
    const record = data as ClientRecord | null;
    setClientRecord(record);
    if (isClientId && record) setDisplayName(record.name);
  };

  const loadLedgerPayments = async () => {
    const name = isClientId ? displayName : routeParam;
    const clientSales = isClientId
      ? sales.filter(s => s.client_id === routeParam || (s.client_id == null && s.customer_name === name))
      : sales.filter(s => s.customer_name === routeParam);
    if (clientSales.length === 0) { setLoadingLocal(false); return; }

    const saleIds = clientSales.map(s => s.id);
    const { data, error } = await supabase
      .from('payments')
      .select('id, order_id, method, amount, date')
      .in('order_id', saleIds)
      .order('date', { ascending: true });
    if (error) { setLoadingLocal(false); return; }
    setLedgerPayments((data ?? []).map(p => ({ ...(p as object), amount: (p as { amount: number }).amount / 100 })) as LedgerPayment[]);
    setLoadingLocal(false);
  };

  const clientSales = useMemo(() => {
    const name = isClientId ? displayName : routeParam;
    return sales.filter(s =>
      s.status !== 'annule' &&
      (isClientId
        ? s.client_id === routeParam || (s.client_id == null && name && s.customer_name === name)
        : s.customer_name === routeParam)
    );
  }, [sales, routeParam, isClientId, displayName]);

  const creditSales = useMemo(
    () => clientSales.filter(s => s.status === 'credit')
      .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime()),
    [clientSales],
  );

  const everHadCredit = useMemo(
    () => clientSales.some(s => s.is_credit),
    [clientSales],
  );

  const debtAge = useMemo(() => {
    if (creditSales.length === 0) return 0;
    const oldest = creditSales[0].sale_date ?? creditSales[0].created_at.split('T')[0];
    return Math.floor((Date.now() - new Date(oldest + 'T00:00:00').getTime()) / 86400000);
  }, [creditSales]);

  const totalSold = clientSales.reduce((s, v) => s + v.total_amount - (v.discount_amount ?? 0), 0);
  const totalPaid = ledgerPayments.reduce((s, p) => s + p.amount, 0);
  const totalOwed = Math.max(0, totalSold - totalPaid);

  // Group all events by calendar day — newest day first
  const dayGroups = useMemo<DayGroup[]>(() => {
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    const toKey = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    const todayKey = toKey(now);
    const yest = new Date(now); yest.setDate(now.getDate() - 1);
    const yestKey = toKey(yest);

    const getLabel = (key: string) => {
      if (key === todayKey) return "Aujourd'hui";
      if (key === yestKey) return 'Hier';
      const d = new Date(key + 'T00:00:00');
      const opts: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'long' };
      if (d.getFullYear() !== now.getFullYear()) opts.year = 'numeric';
      const s = d.toLocaleDateString('fr-FR', opts);
      return s.charAt(0).toUpperCase() + s.slice(1);
    };

    const map = new Map<string, DayGroup>();
    const ensure = (key: string) => {
      if (!map.has(key)) map.set(key, { dateKey: key, label: getLabel(key), sales: [], payments: [], salesTotal: 0, paymentsTotal: 0, unpaidCount: 0, unpaidTotal: 0 });
      return map.get(key)!;
    };

    for (const s of clientSales) {
      const key = s.sale_date ?? s.created_at.split('T')[0];
      const g = ensure(key);
      g.sales.push(s);
      const net = s.total_amount - (s.discount_amount ?? 0);
      g.salesTotal += net;
      if (s.status === 'credit') {
        g.unpaidCount++;
        g.unpaidTotal += net;
      }
    }
    for (const p of ledgerPayments) {
      const g = ensure(p.date);
      g.payments.push(p);
      g.paymentsTotal += p.amount;
    }

    return Array.from(map.values()).sort((a, b) => b.dateKey.localeCompare(a.dateKey));
  }, [clientSales, ledgerPayments]);

  // Auto-expand today + yesterday; user can toggle any day
  const [expandedDays, setExpandedDays] = useState<Set<string>>(() => {
    const n = new Date();
    const pad = (x: number) => String(x).padStart(2, '0');
    const today = `${n.getFullYear()}-${pad(n.getMonth() + 1)}-${pad(n.getDate())}`;
    return new Set([today]);
  });

  const toggleDay = (key: string) => setExpandedDays(prev => {
    const next = new Set(prev);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });

  const handleRecord = useCallback(async (amount: number, method: string, date: string, specificSaleId?: string) => {
    let result: { ok: boolean; fullyPaid?: boolean; fullySettled?: boolean };
    if (specificSaleId) {
      result = await recordPayment(specificSaleId, amount, method, date);
    } else {
      result = await recordClientPayment(displayName, businessId, amount, method, date);
    }
    if (result.ok) {
      setShowPayModal(false);
      haptics.success();
      const paidInFull = specificSaleId ? result.fullyPaid : result.fullySettled;
      if (!paidInFull) setSuccessPayment({ amount });
      loadLedgerPayments();
    }
  }, [displayName, businessId, recordPayment, recordClientPayment]);

  const openMenu = useCallback(() => {
    if (!canEdit) return;
    Alert.alert(displayName, undefined, [
      { text: 'Modifier les infos', onPress: () => setShowEditModal(true) },
      { text: 'Annuler', style: 'cancel' },
    ]);
  }, [displayName, canEdit]);

  if (loadingLocal && loading) {
    return (
      <Screen>
        <View style={styles.hdr}>
          <Pressable onPress={() => router.back()}><Text variant="body" color="secondary">‹ Retour</Text></Pressable>
          <Text variant="h4" style={{ flex: 1, textAlign: 'center' }} numberOfLines={1}>{displayName}</Text>
          <View style={{ width: 60 }} />
        </View>
        <Text variant="body" color="secondary" style={{ textAlign: 'center', marginTop: spacing[8] }}>
          Chargement…
        </Text>
      </Screen>
    );
  }

  return (
    <Screen>
      {/* Header */}
      <View style={styles.hdr}>
        <Pressable onPress={() => router.back()}><Text variant="body" color="secondary">‹ Retour</Text></Pressable>
        <Text variant="h4" style={{ flex: 1, textAlign: 'center' }} numberOfLines={1}>{displayName}</Text>
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
          <View style={styles.debtCard}>
            <Text style={styles.bannerLabel}>{displayName} vous doit</Text>
            <Text style={styles.bannerAmount}>{fmt(totalOwed, currency)}</Text>
            <RNText style={[styles.bannerAge, debtAge >= 30 && { color: palette.warning }]}>
              {debtAge === 0 ? "depuis aujourd'hui" : `depuis ${debtAge} jour${debtAge > 1 ? 's' : ''}`}
            </RNText>
            {totalPaid > 0 && (
              <RNText style={styles.repaidLine}>
                {fmt(totalPaid, currency)} remboursé sur {fmt(totalSold, currency)}
              </RNText>
            )}
            <Pressable
              onPress={() => setShowPayModal(true)}
              style={({ pressed }) => [styles.bannerBtn, pressed && { opacity: 0.85 }]}
            >
              <Text style={styles.bannerBtnText}>Enregistrer un paiement</Text>
            </Pressable>
          </View>
        ) : everHadCredit ? (
          <View style={styles.bannerGreen}>
            <Ionicons name="checkmark-circle" size={22} color={palette.success} />
            <View style={{ flex: 1 }}>
              <RNText style={{ fontSize: 14, fontWeight: '700', color: palette.success }}>{displayName} ne vous doit plus rien</RNText>
              <RNText style={{ fontSize: 12, color: palette.success, marginTop: 2 }}>Compte soldé · tout est à jour</RNText>
            </View>
          </View>
        ) : null}

        {/* Contact row */}
        {clientRecord?.phone && (
          <Card style={styles.contactRow}>
            <Text variant="body">{clientRecord.phone}</Text>
            <Pressable onPress={() => Linking.openURL(`tel:${clientRecord.phone}`)}>
              <Text variant="label" style={{ color: palette.primary }}>Appeler</Text>
            </Pressable>
          </Card>
        )}

        {/* Historique par jour */}
        {dayGroups.length > 0 && (
          <View style={{ gap: spacing[3] }}>
            <Text variant="label" color="secondary">Historique</Text>
            {dayGroups.map(group => {
              const expanded = expandedDays.has(group.dateKey);
              const total = group.sales.length + group.payments.length;
              return (
                <View key={group.dateKey} style={styles.dayCard}>
                  {/* Day header — tap to expand/collapse */}
                  <Pressable
                    style={styles.dayHeader}
                    onPress={() => toggleDay(group.dateKey)}
                  >
                    <Text variant="label">{group.label}</Text>
                    <Ionicons
                      name={expanded ? 'chevron-up' : 'chevron-down'}
                      size={16}
                      color={palette.textSecondary}
                    />
                  </Pressable>

                  {/* Day summary */}
                  <View style={styles.daySummary}>
                    {group.sales.length > 0 && (
                      <View style={styles.summaryRow}>
                        <View style={[styles.summaryIcon, { backgroundColor: palette.background }]}>
                          <Ionicons name="cart-outline" size={12} color={palette.textSecondary} />
                        </View>
                        <Text style={[styles.summaryText, { color: palette.textSecondary }]}>
                          {group.sales.length} vente{group.sales.length > 1 ? 's' : ''} · {fmt(group.salesTotal, currency)}
                        </Text>
                      </View>
                    )}
                    {group.unpaidCount > 0 && (
                      <View style={styles.summaryRow}>
                        <View style={[styles.summaryIcon, { backgroundColor: palette.warningLight }]}>
                          <Ionicons name="alert-circle-outline" size={12} color={palette.warning} />
                        </View>
                        <Text style={[styles.summaryText, { color: palette.warning }]}>
                          {group.unpaidCount} impayé{group.unpaidCount > 1 ? 's' : ''} · {fmt(group.unpaidTotal, currency)}
                        </Text>
                      </View>
                    )}
                  </View>

                  {/* "Voir le détail" toggle when collapsed */}
                  {!expanded && total > 0 && (
                    <Pressable style={styles.seeDetailBtn} onPress={() => toggleDay(group.dateKey)}>
                      <Text style={styles.seeDetailText}>
                        {total === 1 ? 'Voir la transaction ›' : `Voir les ${total} transactions ›`}
                      </Text>
                    </Pressable>
                  )}

                  {/* Expanded transaction rows */}
                  {expanded && (
                    <View style={styles.detailList}>
                      {group.sales.map((s, idx) => {
                        const isCredit = s.status === 'credit';
                        const isLast = idx === group.sales.length - 1 && group.payments.length === 0;
                        return (
                          <View key={`s-${s.id}`} style={[styles.detailRow, !isLast && styles.detailBorder]}>
                            <View style={[styles.rowIcon, { backgroundColor: isCredit ? palette.warningLight : palette.background }]}>
                              <Ionicons name="cart-outline" size={14} color={isCredit ? palette.warning : palette.textDisabled} />
                            </View>
                            <View style={{ flex: 1 }}>
                              <Text variant="body" numberOfLines={1} style={!isCredit && { textDecorationLine: 'line-through', color: palette.textSecondary }}>
                                {s.lines?.map(l => l.product_name).join(', ') || 'Achat à crédit'}
                              </Text>
                              {isCredit && s.due_date ? (
                                <Text variant="caption" style={{
                                  color: new Date(s.due_date + 'T00:00:00') < new Date() ? palette.warning : palette.textSecondary,
                                }}>
                                  {fmtDueDate(s.due_date)}
                                </Text>
                              ) : null}
                            </View>
                            <Text variant="label" style={{ color: isCredit ? palette.warning : palette.textSecondary, ...((!isCredit) && { textDecorationLine: 'line-through' }) }}>
                              {fmt(s.total_amount - (s.discount_amount ?? 0), currency)}
                            </Text>
                          </View>
                        );
                      })}
                      {group.payments.map((p, idx) => {
                        const isLast = idx === group.payments.length - 1;
                        return (
                          <View key={`p-${p.id}`} style={[styles.detailRow, !isLast && styles.detailBorder]}>
                            <View style={[styles.rowIcon, { backgroundColor: palette.successLight }]}>
                              <Ionicons name="arrow-down-circle-outline" size={14} color={palette.success} />
                            </View>
                            <View style={{ flex: 1 }}>
                              <Text variant="body">{methodLabel(p.method)}</Text>
                            </View>
                            <Text variant="label" style={{ color: palette.success }}>+{fmt(p.amount, currency)}</Text>
                          </View>
                        );
                      })}
                    </View>
                  )}
                </View>
              );
            })}
          </View>
        )}

        {clientSales.length === 0 && (
          <Text variant="body" color="secondary" style={{ textAlign: 'center', marginTop: spacing[6] }}>
            Aucune vente enregistrée.
          </Text>
        )}
      </ScrollView>

      <PayModal
        visible={showPayModal}
        displayName={displayName}
        totalOwed={totalOwed}
        creditSales={creditSales}
        currency={currency}
        saving={saving}
        onClose={() => setShowPayModal(false)}
        onRecord={handleRecord}
      />

      <EditModal
        visible={showEditModal}
        displayName={displayName}
        record={clientRecord}
        businessId={businessId}
        userId={userId}
        onClose={() => setShowEditModal(false)}
        onSaved={(r) => { setClientRecord(r); setShowEditModal(false); }}
      />

      {/* Payment success overlay */}
      {successPayment && (
        <View style={styles.successOverlay}>
          <Animated.View style={[styles.successBadge, { transform: [{ scale: checkScale }] }]}>
            <Ionicons name="checkmark" size={44} color={palette.success} />
          </Animated.View>
          <Text style={styles.successHeadline}>C'est réglé !</Text>
          <Text style={styles.successSubtitle}>
            {displayName} vous a payé {fmt(successPayment.amount, currency)}.
          </Text>
          <Pressable
            style={({ pressed }) => [styles.successBtn, pressed && { opacity: 0.85 }]}
            onPress={() => setSuccessPayment(null)}
          >
            <Text style={styles.successBtnText}>Continuer</Text>
          </Pressable>
        </View>
      )}
    </Screen>
  );
}

function makeStyles(p: Palette) {
  return StyleSheet.create({
    safe: { flex: 1, backgroundColor: p.background },
    hdr: {
      flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
      padding: spacing[5], borderBottomWidth: 1, borderBottomColor: p.border,
    },
    content: { paddingHorizontal: spacing[5], paddingTop: 12, paddingBottom: spacing[10], gap: spacing[4] },

    debtCard: {
      backgroundColor: p.surface, borderRadius: radius.lg,
      borderWidth: 1, borderColor: p.border,
      alignItems: 'center', paddingHorizontal: 20, paddingTop: 24, paddingBottom: 20,
    },
    bannerLabel: { fontSize: 14, color: p.textSecondary, textAlign: 'center', fontWeight: '400', marginBottom: 4 },
    bannerAmount: { fontSize: 40, fontWeight: '700', lineHeight: 52, color: p.textPrimary, textAlign: 'center' },
    bannerBtn: {
      width: '100%', backgroundColor: p.primary, borderRadius: 12,
      paddingVertical: 14, alignItems: 'center', justifyContent: 'center', marginTop: 16,
    },
    bannerBtnText: { fontSize: 16, fontWeight: '600', color: p.textInverse },
    bannerGreen: {
      backgroundColor: p.successLight, borderRadius: radius.lg,
      borderWidth: 1, borderColor: p.success,
      padding: spacing[4], flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-start', gap: 8,
    },
    bannerAge: { fontSize: 12, color: p.textSecondary, textAlign: 'center', marginTop: 4, marginBottom: 8 },
    repaidLine: { fontSize: 13, color: p.textSecondary, textAlign: 'center', marginBottom: 4 },
    rowIcon: { width: 28, height: 28, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
    contactRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },

    // Day-grouped history
    dayCard: {
      backgroundColor: p.surface, borderRadius: radius.lg,
      borderWidth: 1, borderColor: p.border, overflow: 'hidden',
    },
    dayHeader: {
      flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
      paddingHorizontal: spacing[4], paddingVertical: spacing[3],
      borderBottomWidth: 1, borderBottomColor: p.border,
    },
    daySummary: {
      paddingHorizontal: spacing[4], paddingVertical: spacing[3], gap: spacing[2],
    },
    summaryRow: { flexDirection: 'row', alignItems: 'center', gap: spacing[2] },
    summaryIcon: { width: 22, height: 22, borderRadius: 6, alignItems: 'center', justifyContent: 'center' },
    summaryText: { fontSize: 13, fontWeight: '500' },
    seeDetailBtn: {
      paddingHorizontal: spacing[4], paddingBottom: spacing[3],
    },
    seeDetailText: { fontSize: 13, color: p.primary, fontWeight: '500' },
    detailList: { borderTopWidth: 1, borderTopColor: p.border },
    detailRow: {
      flexDirection: 'row', alignItems: 'center', gap: spacing[3],
      paddingHorizontal: spacing[4], paddingVertical: spacing[3],
    },
    detailBorder: { borderBottomWidth: 1, borderBottomColor: p.border },

    // Modals
    modalSafe: { flex: 1, backgroundColor: p.background },
    pad: { padding: spacing[5], gap: spacing[4], paddingBottom: spacing[10] },
    footer: { padding: spacing[5], borderTopWidth: 1, borderTopColor: p.border, backgroundColor: p.surface },

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
    chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing[2] },
    chip: {
      paddingHorizontal: spacing[3], paddingVertical: spacing[1.5],
      borderRadius: radius.full, borderWidth: 1, borderColor: p.border,
      backgroundColor: p.surface,
    },
    chipActive: { backgroundColor: p.primary, borderColor: p.primary },
    successOverlay: {
      ...StyleSheet.absoluteFillObject,
      backgroundColor: p.background,
      alignItems: 'center',
      justifyContent: 'center',
      padding: 32,
      zIndex: 100,
    },
    successBadge: {
      width: 80, height: 80, borderRadius: 40,
      backgroundColor: p.successLight,
      alignItems: 'center', justifyContent: 'center',
      marginBottom: 24,
    },
    successHeadline: {
      fontSize: 28, fontWeight: '700', lineHeight: 40, color: p.success,
      textAlign: 'center', marginBottom: 8,
    },
    successSubtitle: {
      fontSize: 18, color: p.textPrimary,
      textAlign: 'center', marginTop: 8, marginBottom: 40,
    },
    successBtn: {
      width: '100%', backgroundColor: p.primary, borderRadius: 14,
      paddingVertical: 16, alignItems: 'center',
    },
    successBtnText: { fontSize: 16, fontWeight: '600', color: p.textInverse },
    saleOption: {
      paddingHorizontal: spacing[3], paddingVertical: spacing[2],
      borderRadius: radius.md, borderWidth: 1, borderColor: p.border,
      backgroundColor: p.surface,
    },
    saleOptionActive: { backgroundColor: p.primary, borderColor: p.primary },
  });
}
