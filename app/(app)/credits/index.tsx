import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FlatList, KeyboardAvoidingView, Linking, Platform, Pressable, StyleSheet, TextInput, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Screen } from '@/src/components/ui/Screen';
import { router, useFocusEffect } from 'expo-router';
import { Button } from '@/src/components/ui/Button';
import { Card } from '@/src/components/ui/Card';
import { Text } from '@/src/components/ui/Text';
import { useTheme, spacing, radius } from '@/src/theme';
import type { Palette } from '@/src/theme';
import { useAuthStore } from '@/stores/auth';
import { useVentesStore } from '@/stores/ventes';
import { useSalesStore } from '@/stores/sales';
import { formatAmountInput, parseAmountInput } from '@/src/utils/format';
import { SkeletonList } from '@/src/components/ui/SkeletonPlaceholder';

function fmt(n: number, cur: string) { return `${Math.round(n).toLocaleString('fr-FR')} ${cur}`; }

function getDaysAgo(dateStr: string): number {
  const d = dateStr.includes('T') ? new Date(dateStr) : new Date(dateStr + 'T00:00:00');
  return Math.floor((Date.now() - d.getTime()) / (1000 * 60 * 60 * 24));
}

function fmtDue(iso: string): string {
  const d = new Date(iso + 'T00:00:00');
  const diff = Math.round((d.getTime() - Date.now()) / 86400000);
  if (diff < 0) return `En retard de ${Math.abs(diff)} j`;
  if (diff === 0) return "Prévu aujourd'hui";
  if (diff <= 3) return `Dans ${diff} jour${diff > 1 ? 's' : ''}`;
  return `Prévu le ${d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' })}`;
}

interface DebtorClient {
  name: string;
  totalOwed: number;
  nbSales: number;
  oldestDate: string;
  daysOldest: number;
  sellers: string[];
  nearestDueDate: string | null;
}

export default function CreditsScreen() {
  const { palette } = useTheme();
  const styles = useMemo(() => makeStyles(palette), [palette]);
  const session = useAuthStore(s => s.session);
  const businessId = session?.activeBusiness?.id ?? '';
  const userId = session?.user.id ?? '';
  const currency = session?.activeBusiness?.currency ?? 'GNF';
  const role = session?.activeMembership?.role;
  const isVendeur = role === 'vendeur';
  const isInvestisseur = role === 'investisseur';

  const businessName = session?.activeBusiness?.name ?? 'notre boutique';
  const { sales, loading, error, fetchSales } = useVentesStore();
  const { submitCarnetDebt } = useSalesStore();

  const [showAddForm, setShowAddForm] = useState(false);
  const [addName, setAddName] = useState('');
  const [addAmount, setAddAmount] = useState('');
  const [addSaving, setAddSaving] = useState(false);
  const addNameRef = useRef<TextInput>(null);
  const addAmountRef = useRef<TextInput>(null);

  const handleAddDebt = async () => {
    const trimmedName = addName.trim();
    const parsed = Math.round(parseAmountInput(addAmount));
    if (!trimmedName || isNaN(parsed) || parsed <= 0) return;
    setAddSaving(true);
    const ok = await submitCarnetDebt(businessId, userId, trimmedName, parsed * 100);
    setAddSaving(false);
    if (ok) {
      setAddName('');
      setAddAmount('');
      setShowAddForm(false);
      fetchSales(businessId, isVendeur ? userId : undefined);
    }
  };

  const sendWhatsAppReminder = (debtor: DebtorClient) => {
    const msg = [
      `Bonjour ${debtor.name},`,
      ``,
      `J'espère que tout va bien de votre côté.`,
      ``,
      `Votre solde chez nous est de *${fmt(debtor.totalOwed, currency)}* — dès que c'est possible pour vous, on est là.`,
      ``,
      `${businessName}`,
    ].join('\n');
    Linking.openURL(`https://wa.me/?text=${encodeURIComponent(msg)}`).catch(() => {});
  };

  useFocusEffect(
    useCallback(() => {
      if (businessId) fetchSales(businessId, isVendeur ? userId : undefined);
    }, [businessId, isVendeur, userId]),
  );

  const debtors = useMemo<DebtorClient[]>(() => {
    const map = new Map<string, DebtorClient>();

    for (const s of sales) {
      if (s.status !== 'credit') continue;
      const name = s.customer_name?.trim() || 'Client inconnu';
      const remaining = s.total_amount - (s.discount_amount ?? 0) - (s.amount_paid ?? 0);
      if (remaining < 0.01) continue;

      const saleDate = s.sale_date ?? s.created_at.split('T')[0];
      const existing = map.get(name);
      if (existing) {
        existing.totalOwed += remaining;
        existing.nbSales += 1;
        if (saleDate < existing.oldestDate) {
          existing.oldestDate = saleDate;
          existing.daysOldest = getDaysAgo(saleDate);
        }
        if (s.seller_name && !existing.sellers.includes(s.seller_name)) {
          existing.sellers.push(s.seller_name);
        }
        const dd = s.due_date ?? null;
        if (dd && (!existing.nearestDueDate || dd < existing.nearestDueDate)) {
          existing.nearestDueDate = dd;
        }
      } else {
        map.set(name, {
          name,
          totalOwed: remaining,
          nbSales: 1,
          oldestDate: saleDate,
          daysOldest: getDaysAgo(saleDate),
          sellers: s.seller_name ? [s.seller_name] : [],
          nearestDueDate: s.due_date ?? null,
        });
      }
    }

    // Sort: oldest debt first (most urgent)
    return Array.from(map.values()).sort((a, b) => b.daysOldest - a.daysOldest);
  }, [sales]);

  const totalOutstanding = debtors.reduce((s, c) => s + c.totalOwed, 0);

  const navToLedger = (name: string) =>
    router.push(`/clients/${encodeURIComponent(name)}`);

  return (
    <Screen>
      <View style={styles.header}>
        <Pressable onPress={() => router.back()}><Text variant="body" color="secondary">‹ Retour</Text></Pressable>
        <Text variant="h4">Clients qui vous doivent</Text>
        <View style={{ width: 60 }} />
      </View>

      {/* Total outstanding — hidden when nothing is owed */}
      {debtors.length > 0 && <Card style={styles.totalCard}>
        <Text variant="caption" color="secondary">Crédit total</Text>
        <Text variant="amountLarge" style={{ color: debtors.length > 0 ? palette.warning : palette.textPrimary }}>
          {fmt(totalOutstanding, currency)}
        </Text>
        <Text variant="caption" color="secondary">
          {debtors.length} client{debtors.length !== 1 ? 's' : ''} vous {debtors.length !== 1 ? 'doivent' : 'doit'} de l'argent
        </Text>
      </Card>}

      {loading && debtors.length === 0 ? (
        <SkeletonList count={5} />
      ) : !loading && debtors.length === 0 && error ? (
        <View style={styles.empty}>
          <Text variant="body" color="secondary" style={{ textAlign: 'center' }}>
            Données non disponibles
          </Text>
          <Pressable
            onPress={() => fetchSales(businessId, isVendeur ? userId : undefined)}
            style={{ marginTop: spacing[4] }}
          >
            <Text variant="label" style={{ color: palette.primary }}>Réessayer</Text>
          </Pressable>
        </View>
      ) : debtors.length === 0 ? (
        <View style={styles.empty}>
          {!showAddForm ? (
            <>
              <View style={styles.emptyBadge}>
                <Ionicons name="checkmark-circle" size={36} color={palette.success} />
              </View>
              <Text variant="h4" style={{ textAlign: 'center', marginBottom: spacing[4] }}>Tout est soldé</Text>
              <Pressable
                onPress={() => { setShowAddForm(true); setTimeout(() => addNameRef.current?.focus(), 80); }}
                style={({ pressed }) => [styles.carnetCta, { opacity: pressed ? 0.7 : 1, borderColor: palette.primary }]}
              >
                <Text variant="label" style={{ color: palette.primary }}>Ajouter une dette</Text>
              </Pressable>
            </>
          ) : (
            <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={{ width: '100%' }}>
              <View style={{ gap: spacing[3] }}>
                <Text variant="label" color="secondary" style={{ textAlign: 'center', marginBottom: spacing[1] }}>
                  Qui vous doit de l'argent ?
                </Text>
                <View style={{ flexDirection: 'row', gap: spacing[2] }}>
                  <TextInput
                    ref={addNameRef}
                    style={[styles.addInput, { flex: 1, color: palette.textPrimary, borderColor: palette.border }]}
                    placeholder="Nom"
                    placeholderTextColor={palette.textDisabled}
                    value={addName}
                    onChangeText={setAddName}
                    returnKeyType="next"
                    onSubmitEditing={() => addAmountRef.current?.focus()}
                    autoCapitalize="words"
                  />
                  <TextInput
                    ref={addAmountRef}
                    style={[styles.addInput, { width: 110, color: palette.textPrimary, borderColor: palette.border }]}
                    placeholder="Montant"
                    placeholderTextColor={palette.textDisabled}
                    value={addAmount}
                    onChangeText={v => setAddAmount(formatAmountInput(v))}
                    keyboardType="numeric"
                    returnKeyType="done"
                    onSubmitEditing={handleAddDebt}
                  />
                </View>
                <Button
                  label={addSaving ? '…' : 'Ajouter'}
                  onPress={handleAddDebt}
                  loading={addSaving}
                  fullWidth
                  size="lg"
                  disabled={!addName.trim() || parseAmountInput(addAmount) <= 0}
                />
                <Pressable
                  onPress={() => { setShowAddForm(false); setAddName(''); setAddAmount(''); }}
                  style={{ alignItems: 'center', paddingVertical: spacing[2] }}
                >
                  <Text variant="caption" color="secondary">Annuler</Text>
                </Pressable>
              </View>
            </KeyboardAvoidingView>
          )}
        </View>
      ) : (
        <FlatList
          data={debtors}
          keyExtractor={c => c.name}
          contentContainerStyle={styles.list}
          renderItem={({ item }) => {
            const urgent = item.daysOldest >= 7;
            return (
              <Pressable onPress={() => navToLedger(item.name)}
                style={({ pressed }) => [styles.row, pressed && { opacity: 0.75 }]}>
                <View style={[styles.avatar, { backgroundColor: palette.warningLight }]}>
                  <Text variant="label" style={{ color: palette.warning }}>
                    {item.name[0]?.toUpperCase()}
                  </Text>
                </View>
                <View style={{ flex: 1, gap: 2 }}>
                  <Text variant="label" numberOfLines={1}>{item.name}</Text>
                  {item.nearestDueDate && (
                    <Text variant="caption" style={{
                      color: new Date(item.nearestDueDate + 'T00:00:00') < new Date() ? palette.warning : palette.textSecondary,
                    }}>
                      {fmtDue(item.nearestDueDate)}
                    </Text>
                  )}
                  {!isVendeur && item.sellers.length > 0 && (
                    <Text variant="caption" color="secondary">
                      {item.sellers.join(', ')} à fait cette vente
                    </Text>
                  )}
                </View>
                <View style={{ alignItems: 'flex-end', gap: 6 }}>
                  <Text variant="label" style={{ color: palette.warning }}>{fmt(item.totalOwed, currency)}</Text>
                  {!isInvestisseur && (
                    <Pressable
                      onPress={() => sendWhatsAppReminder(item)}
                      hitSlop={8}
                      style={({ pressed }) => [styles.waBtn, { opacity: pressed ? 0.6 : 1 }]}
                    >
                      <Ionicons name="logo-whatsapp" size={14} color={palette.primary} />
                      <Text variant="caption" style={styles.waBtnText}>Rappeler</Text>
                    </Pressable>
                  )}
                </View>
              </Pressable>
            );
          }}
          ItemSeparatorComponent={() => <View style={{ height: 1, backgroundColor: palette.border }} />}
        />
      )}
    </Screen>
  );
}

function makeStyles(p: Palette) {
  return StyleSheet.create({
  safe: { flex: 1, backgroundColor: p.background },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: spacing[5], paddingVertical: spacing[4],
    borderBottomWidth: 1, borderBottomColor: p.border,
  },
  totalCard: {
    marginHorizontal: spacing[5], marginVertical: spacing[4],
    alignItems: 'center', gap: spacing[1],
    borderColor: p.warning + '40', borderWidth: 1,
  },
  list: { paddingBottom: spacing[10] },
  row: {
    flexDirection: 'row', alignItems: 'center', gap: spacing[3],
    paddingHorizontal: spacing[5], paddingVertical: spacing[3],
    backgroundColor: p.surface,
  },
  avatar: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: spacing[8] },
  emptyBadge: { width: 88, height: 88, borderRadius: 44, backgroundColor: p.successLight, alignItems: 'center', justifyContent: 'center', marginBottom: spacing[5] },
  carnetCta: {
    paddingVertical: spacing[3], paddingHorizontal: spacing[6],
    borderWidth: 1, borderRadius: radius.md,
  },
  addInput: {
    borderWidth: 1, borderRadius: radius.md,
    paddingHorizontal: spacing[3], paddingVertical: spacing[3],
    fontSize: 15,
  },
  center: { textAlign: 'center', marginTop: spacing[10] },
  waBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    paddingHorizontal: spacing[2], paddingVertical: 3,
    borderRadius: radius.sm, borderWidth: 1, borderColor: p.primary + '40',
    backgroundColor: p.primary + '12',
  },
  waBtnText: { color: p.primary, fontSize: 11 },
  });
}
