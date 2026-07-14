import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Animated, Easing, Modal, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Screen } from '@/src/components/ui/Screen';
import { router } from 'expo-router';
import { Button } from '@/src/components/ui/Button';
import { Card } from '@/src/components/ui/Card';
import { Input } from '@/src/components/ui/Input';
import { Text } from '@/src/components/ui/Text';
import { DatePickerField } from '@/src/components/ui/DatePickerField';
import { OfflineNotice } from '@/src/components/ui/OfflineNotice';
import { useTheme, spacing, radius, INFO_TAG } from '@/src/theme';
import type { Palette } from '@/src/theme';
import { useAuthStore } from '@/stores/auth';
import { useExpensesStore, type CreateExpenseData } from '@/stores/expenses';
import { useProductStore } from '@/stores/products';
import type { Expense } from '@/src/types';
import { haptics } from '@/lib/haptics';
import { toast } from '@/stores/toast';
import { SkeletonList } from '@/src/components/ui/SkeletonPlaceholder';
import { formatAmountInput, parseAmountInput } from '@/src/utils/format';

function fmt(n: number, cur: string) { return `${n.toLocaleString('fr-FR')} ${cur}`; }
function todayIso() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function yesterdayIso() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// ─── Expense Form ─────────────────────────────────────────────────────────────

interface ExpenseFormProps {
  visible: boolean;
  editing: Expense | null;
  onClose: () => void;
  onSave: (data: CreateExpenseData) => Promise<void>;
  saving: boolean;
  currency: string;
  businessId: string;
  userId: string;
}

function ExpenseFormModal({ visible, editing, onClose, onSave, saving, currency, businessId, userId }: ExpenseFormProps) {
  const { palette } = useTheme();
  const styles = useMemo(() => makeStyles(palette), [palette]);
  const [amount, setAmount] = useState('');
  const [description, setDescription] = useState('');
  const [date, setDate] = useState(todayIso());
  const [dateMode, setDateMode] = useState<'hier' | 'aujourdhui' | 'autre'>('aujourdhui');
  const [selectedProductId, setSelectedProductId] = useState<string | null>(null);

  const { products, fetchProducts } = useProductStore();
  const activeProducts = useMemo(
    () => products.filter(p => !p.archived),
    [products],
  );

  useEffect(() => {
    if (visible && products.length === 0 && businessId) {
      void fetchProducts(businessId, userId);
    }
  }, [visible, businessId]);

  useEffect(() => {
    if (visible) {
      setAmount(editing ? formatAmountInput(String(editing.amount), currency) : '');
      setDescription(editing?.description ?? '');
      setSelectedProductId(editing?.product_id ?? null);
      const today = todayIso();
      const yesterday = yesterdayIso();
      const d = editing?.date ?? today;
      setDate(d);
      setDateMode(d === today ? 'aujourdhui' : d === yesterday ? 'hier' : 'autre');
    }
  }, [visible, editing]);

  const handleSave = async () => {
    const amt = parseAmountInput(amount, currency);
    if (!description.trim()) { Alert.alert('Écrivez un petit mot :)'); return; }
    if (!amt || amt <= 0) { Alert.alert('Vérifiez le montant :)'); return; }
    await onSave({ amount: amt, description, category: null, date, due_date: null, note: null, product_id: selectedProductId });
  };

  const isEdit = !!editing;

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <SafeAreaView style={styles.modalSafe}>
        <View style={styles.modalHeader}>
          <Pressable onPress={onClose}><Text variant="body" color="secondary">Annuler</Text></Pressable>
          <Text variant="h4">{isEdit ? 'Modifier la dépense' : 'Nouvelle dépense'}</Text>
          <View style={{ width: 64 }} />
        </View>

        <ScrollView contentContainerStyle={styles.modalContent} keyboardShouldPersistTaps="handled">
          <Input
            label={`Montant (${currency})`}
            value={amount}
            onChangeText={v => setAmount(formatAmountInput(v, currency))}
            keyboardType="decimal-pad"
          />

          <Input
            label="Description"
            value={description}
            onChangeText={setDescription}
            placeholder="Carburant, loyer, salaire du gardien"
          />

          {activeProducts.length > 0 && (
            <View style={{ gap: spacing[2] }}>
              <Text variant="label">Produit concerné <Text variant="caption" color="secondary">(optionnel)</Text></Text>
              <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ flexGrow: 0 }}>
                {activeProducts.map(p => {
                  const active = selectedProductId === p.id;
                  return (
                    <Pressable
                      key={p.id}
                      onPress={() => setSelectedProductId(active ? null : p.id)}
                      style={[styles.productChip, active && styles.productChipActive]}
                    >
                      <Text
                        variant="caption"
                        numberOfLines={1}
                        style={{ color: active ? palette.textInverse : palette.textPrimary }}
                      >
                        {p.name}
                      </Text>
                    </Pressable>
                  );
                })}
              </ScrollView>
            </View>
          )}

          <View style={{ gap: spacing[2] }}>
            <Text variant="label">Date de la dépense</Text>
            <View style={styles.datePills}>
              {(['hier', 'aujourdhui', 'autre'] as const).map(mode => (
                <Pressable
                  key={mode}
                  onPress={() => {
                    setDateMode(mode);
                    if (mode === 'hier') setDate(yesterdayIso());
                    else if (mode === 'aujourdhui') setDate(todayIso());
                  }}
                  style={[styles.datePill, dateMode === mode && styles.datePillActive]}
                >
                  <Text variant="label" style={{ color: dateMode === mode ? palette.textInverse : palette.textSecondary }}>
                    {mode === 'hier' ? 'Hier' : mode === 'aujourdhui' ? "Aujourd'hui" : 'Autre date'}
                  </Text>
                </Pressable>
              ))}
            </View>
            {dateMode === 'autre' && (
              <DatePickerField value={date} onChange={setDate} maxToday />
            )}
          </View>
        </ScrollView>

        <View style={styles.modalFooter}>
          <Button
            label={saving ? 'Enregistrement…' : (isEdit ? 'Enregistrer les modifications' : 'Enregistrer')}
            onPress={handleSave}
            loading={saving}
            fullWidth
            size="lg"
          />
        </View>
      </SafeAreaView>
    </Modal>
  );
}

// ─── Single expense card ───────────────────────────────────────────────────────

interface ExpenseCardProps {
  expense: Expense;
  currency: string;
  isManager: boolean;
  canEdit: boolean;
  onApprove: () => void;
  onReject: () => void;
  onEdit: () => void;
}

function ExpenseCard({ expense, currency, isManager, canEdit, onApprove, onReject, onEdit }: ExpenseCardProps) {
  const { palette } = useTheme();
  const styles = useMemo(() => makeStyles(palette), [palette]);
  const isPending = expense.status === 'en_attente';
  const [confirmAction, setConfirmAction] = useState<'approve' | 'reject' | null>(null);

  const handleConfirm = () => {
    if (confirmAction === 'approve') onApprove();
    else if (confirmAction === 'reject') onReject();
    setConfirmAction(null);
  };

  return (
    <Card style={[styles.expRow, isPending && styles.expRowPending]}>
      <View style={styles.expTop}>
        <View style={{ flex: 1 }}>
          <Text variant="label" numberOfLines={1}>{expense.description}</Text>
          {expense.category === 'transport_achat' ? (
            <View style={[styles.productTag, { backgroundColor: INFO_TAG.bg, flexDirection: 'row', alignItems: 'center', gap: 4 }]}>
              <Ionicons name="cube-outline" size={11} color={INFO_TAG.text} />
              <Text variant="caption" style={{ color: INFO_TAG.text }}>
                {expense.product_name ? `Fret · ${expense.product_name}` : 'Fret'}
              </Text>
            </View>
          ) : expense.product_name ? (
            <View style={styles.productTag}>
              <Text variant="caption" style={{ color: palette.primary }}>{expense.product_name}</Text>
            </View>
          ) : null}
          {expense.note ? (
            <Text variant="caption" color="secondary" numberOfLines={2}>{expense.note}</Text>
          ) : null}
        </View>
        <View style={{ alignItems: 'flex-end', alignSelf: 'stretch' }}>
          <Text variant="label" style={{ color: palette.warning }}>{fmt(expense.amount, currency)}</Text>
          {canEdit ? (
            <Pressable onPress={onEdit} style={[styles.editBtn, { marginTop: 4 }]}>
              <Text variant="caption" style={{ color: palette.primary }}>Modifier</Text>
            </Pressable>
          ) : null}
          <Text variant="caption" color="secondary" style={{ marginTop: 'auto' }}>
            {new Date(expense.date + 'T00:00:00').toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' })}
          </Text>
        </View>
      </View>

      {isManager && isPending && (
        confirmAction ? (
          <View style={styles.actionRow}>
            <Pressable
              onPress={handleConfirm}
              style={[styles.confirmBtn, { backgroundColor: confirmAction === 'approve' ? palette.success : palette.warning }]}
            >
              <Text variant="label" style={{ color: palette.textInverse }}>
                {confirmAction === 'approve' ? '✓ Confirmer' : '✕ Confirmer le refus'}
              </Text>
            </Pressable>
            <Pressable onPress={() => setConfirmAction(null)} style={styles.cancelBtn}>
              <Text variant="label" color="secondary">Annuler</Text>
            </Pressable>
          </View>
        ) : (
          <View style={styles.actionRow}>
            <Button label="Accepter" size="sm" onPress={() => { haptics.tap(); setConfirmAction('approve'); }} style={{ flex: 1 }} />
            <Button label="Refuser" size="sm" variant="outline" onPress={() => { haptics.tap(); setConfirmAction('reject'); }} style={{ flex: 1 }} />
          </View>
        )
      )}
    </Card>
  );
}

// ─── Month accordion ───────────────────────────────────────────────────────────

interface MonthGroupProps {
  label: string;
  total: number;
  items: Expense[];
  currency: string;
  isManager: boolean;
  userId: string;
  onApprove: (id: string) => void;
  onReject: (id: string) => void;
  onEdit: (e: Expense) => void;
  defaultOpen: boolean;
}

function MonthGroup({ label, total, items, currency, isManager, userId, onApprove, onReject, onEdit, defaultOpen }: MonthGroupProps) {
  const { palette } = useTheme();
  const styles = useMemo(() => makeStyles(palette), [palette]);
  const [open, setOpen] = useState(defaultOpen);

  useEffect(() => {
    if (defaultOpen) setOpen(true);
  }, [defaultOpen, items.length]);

  return (
    <View style={styles.monthBlock}>
      <Pressable onPress={() => { haptics.selection(); setOpen(o => !o); }} style={styles.monthHeader}>
        <Text variant="label" style={styles.monthLabel}>{label}</Text>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing[2] }}>
          <Text variant="label" style={{ color: palette.warning }}>{fmt(total, currency)}</Text>
          <Text variant="caption" color="secondary">{open ? '▲' : '▼'}</Text>
        </View>
      </Pressable>

      {open && (
        <View style={styles.monthItems}>
          {items.map(e => (
            <ExpenseCard
              key={e.id}
              expense={e}
              currency={currency}
              isManager={isManager}
              canEdit={e.status === 'en_attente' && e.created_by === userId}
              onApprove={() => onApprove(e.id)}
              onReject={() => onReject(e.id)}
              onEdit={() => onEdit(e)}
            />
          ))}
        </View>
      )}
    </View>
  );
}

// ─── Main Screen ──────────────────────────────────────────────────────────────

export default function DepensesScreen() {
  const { palette } = useTheme();
  const styles = useMemo(() => makeStyles(palette), [palette]);
  const session = useAuthStore(s => s.session);
  const businessId = session?.activeBusiness?.id ?? '';
  const userId = session?.user.id ?? '';
  const currency = session?.activeBusiness?.currency ?? 'GNF';
  const role = session?.activeMembership?.role;
  const isManager = role === 'administrateur' || role === 'manager';

  const { expenses, loading, saving, error, offline, offlineSince, fetchExpenses, createExpense, updateExpense, approveExpense, rejectExpense } =
    useExpensesStore();

  const [showForm, setShowForm] = useState(false);
  const [editingExpense, setEditingExpense] = useState<Expense | null>(null);

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

  useEffect(() => {
    if (businessId) fetchExpenses(businessId);
  }, [businessId]);

  const pendingExpenses = useMemo(
    () => expenses.filter(e => e.status === 'en_attente'),
    [expenses],
  );

  const groupedNonPending = useMemo(() => {
    const nonPending = expenses.filter(e => e.status !== 'en_attente');
    const map = new Map<string, { label: string; total: number; items: Expense[] }>();
    for (const e of nonPending) {
      const d = new Date(e.date + 'T00:00:00');
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      const label = d.toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' });
      const group = map.get(key) ?? { label, total: 0, items: [] };
      if (e.status === 'approuve') group.total += e.amount;
      group.items.push(e);
      map.set(key, group);
    }
    return Array.from(map.entries())
      .sort((a, b) => b[0].localeCompare(a[0]))
      .map(([key, g]) => ({ key, ...g }));
  }, [expenses]);

  const handleSave = useCallback(async (data: CreateExpenseData) => {
    let ok: boolean;
    if (editingExpense) {
      ok = await updateExpense(editingExpense.id, businessId, data);
    } else {
      ok = await createExpense(businessId, userId, data, isManager);
    }
    if (!ok) {
      Alert.alert('La dépense n\'est pas passée :)');
      return;
    }
    setShowForm(false);
    setEditingExpense(null);
    if (editingExpense) {
      toast.success('Dépense mise à jour');
    } else if (!isManager) {
      toast.info('Dépense enregistrée — en attente du gérant');
    } else {
      haptics.success();
    }
  }, [editingExpense, businessId, userId, isManager, updateExpense, createExpense]);

  const handleEdit = (expense: Expense) => { setEditingExpense(expense); setShowForm(true); };
  const handleAdd = () => { setEditingExpense(null); setShowForm(true); };

  const handleApprove = useCallback(async (id: string) => {
    const ok = await approveExpense(id, userId);
    if (ok) haptics.success(); else haptics.error();
  }, [approveExpense, userId]);

  const handleReject = useCallback(async (id: string) => {
    const ok = await rejectExpense(id, userId);
    if (ok) haptics.error();
  }, [rejectExpense, userId]);

  const isEmpty = expenses.length === 0;

  return (
    <Screen>
      <View style={styles.hdr}>
        <Pressable onPress={() => router.back()}><Text variant="body" color="secondary">‹ Retour</Text></Pressable>
        <Text variant="h4">Dépenses</Text>
        <View style={{ width: 64 }} />
      </View>

      {offline && <OfflineNotice offlineSince={offlineSince} />}

      {loading && isEmpty ? (
        <SkeletonList count={6} />
      ) : !loading && isEmpty && error ? (
        <View style={styles.empty}>
          <Text variant="body" color="secondary" style={{ textAlign: 'center' }}>Données non disponibles hors ligne</Text>
        </View>
      ) : isEmpty ? (
        <View style={styles.empty}>
          <Text variant="body" color="secondary" style={{ textAlign: 'center', fontWeight: '600' }}>Aucune dépense ce mois — c'est bon signe.</Text>
          <Text variant="caption" color="secondary" style={{ textAlign: 'center' }}>Ajoutez-en une dès qu'elle se présente.</Text>
        </View>
      ) : (
        <ScrollView contentContainerStyle={styles.list} showsVerticalScrollIndicator={false}>
          {pendingExpenses.length > 0 && (
            <View style={styles.pendingSection}>
              <View style={styles.pendingBadge}>
                <Text variant="caption" style={{ color: palette.warning, fontWeight: '700' }}>
                  EN ATTENTE · {pendingExpenses.length}
                </Text>
              </View>
              {pendingExpenses.map(e => (
                <ExpenseCard
                  key={e.id}
                  expense={e}
                  currency={currency}
                  isManager={isManager}
                  canEdit={e.created_by === userId}
                  onApprove={() => handleApprove(e.id)}
                  onReject={() => handleReject(e.id)}
                  onEdit={() => handleEdit(e)}
                />
              ))}
            </View>
          )}

          {groupedNonPending.map(group => (
            <MonthGroup
              key={group.key}
              label={group.label}
              total={group.total}
              items={group.items}
              currency={currency}
              isManager={isManager}
              userId={userId}
              onApprove={handleApprove}
              onReject={handleReject}
              onEdit={handleEdit}
              defaultOpen={false}
            />
          ))}
        </ScrollView>
      )}

      <ExpenseFormModal
        visible={showForm}
        editing={editingExpense}
        onClose={() => { setShowForm(false); setEditingExpense(null); }}
        onSave={handleSave}
        saving={saving}
        currency={currency}
        businessId={businessId}
        userId={userId}
      />

      <Animated.View style={[styles.fabContainer, { opacity: fabOpacity, transform: [{ scale: fabScale }] }]}>
        <Pressable
          onPress={handleAdd}
          style={({ pressed }) => [styles.fab, pressed && { opacity: 0.82 }]}
          accessibilityLabel="Ajouter une dépense"
          accessibilityRole="button"
        >
          <Text style={styles.fabIcon}>+</Text>
        </Pressable>
      </Animated.View>
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
  list: { padding: spacing[5], gap: spacing[4], paddingBottom: spacing[24] },

  // Pending section
  pendingSection: { gap: spacing[2] },
  pendingBadge: {
    alignSelf: 'flex-start',
    backgroundColor: p.warning + '20',
    borderRadius: radius.sm,
    paddingHorizontal: spacing[2],
    paddingVertical: spacing[1],
    borderWidth: 1,
    borderColor: p.warning + '60',
  },

  // Month accordion
  monthBlock: { gap: 0 },
  monthHeader: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    paddingVertical: spacing[3], paddingHorizontal: spacing[1],
    borderBottomWidth: 1, borderBottomColor: p.border,
  },
  monthLabel: { textTransform: 'capitalize' },
  monthItems: { gap: spacing[2], paddingTop: spacing[2] },

  // Expense card
  expRow: { gap: spacing[2] },
  expRowPending: { borderLeftWidth: 3, borderLeftColor: p.warning },
  expTop: { flexDirection: 'row', gap: spacing[3], alignItems: 'flex-start' },
  statusPill: { paddingHorizontal: spacing[2], paddingVertical: 2, borderRadius: radius.sm },
  editBtn: {
    paddingHorizontal: spacing[2], paddingVertical: 2,
    borderRadius: radius.sm, borderWidth: 1, borderColor: p.primary + '50',
  },
  actionRow: { flexDirection: 'row', gap: spacing[2] },

  // Inline confirm buttons
  confirmBtn: {
    flex: 1, paddingVertical: spacing[2.5], borderRadius: radius.md,
    alignItems: 'center', justifyContent: 'center',
  },
  cancelBtn: {
    paddingHorizontal: spacing[4], paddingVertical: spacing[2.5],
    borderRadius: radius.md, borderWidth: 1, borderColor: p.border,
    alignItems: 'center', justifyContent: 'center',
  },

  // Empty
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: spacing[3] },

  // Product chip picker
  productChip: {
    paddingHorizontal: spacing[3], paddingVertical: spacing[2],
    marginRight: spacing[2], borderRadius: radius.full,
    borderWidth: 1.5, borderColor: p.border, backgroundColor: p.surface, maxWidth: 160,
  },
  productChipActive: { backgroundColor: p.primary, borderColor: p.primary },
  productTag: {
    alignSelf: 'flex-start', marginTop: 2,
    paddingHorizontal: spacing[2], paddingVertical: 1,
    borderRadius: radius.sm, backgroundColor: p.primaryLight,
  },

  // Date pills
  datePills: { flexDirection: 'row', gap: spacing[2] },
  datePill: {
    flex: 1, paddingVertical: spacing[2.5], alignItems: 'center',
    borderRadius: radius.full, borderWidth: 1.5, borderColor: p.border,
    backgroundColor: p.surface,
  },
  datePillActive: { backgroundColor: p.primary, borderColor: p.primary },

  // FAB
  fabContainer: { position: 'absolute', bottom: 194, right: spacing[4], zIndex: 10 },
  fab: {
    width: 56, height: 56, borderRadius: radius.full,
    backgroundColor: p.primary, alignItems: 'center', justifyContent: 'center',
    shadowColor: p.textPrimary, shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.18, shadowRadius: 8, elevation: 8,
  },
  fabIcon: { fontSize: 28, lineHeight: 32, fontWeight: '300' as const, color: p.textInverse, marginTop: -2 },

  // Form modal
  modalSafe: { flex: 1, backgroundColor: p.background },
  modalHeader: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    padding: spacing[5], borderBottomWidth: 1, borderBottomColor: p.border,
    backgroundColor: p.surface,
  },
  modalContent: { padding: spacing[5], gap: spacing[4] },
  modalFooter: {
    padding: spacing[5], borderTopWidth: 1, borderTopColor: p.border,
    backgroundColor: p.surface,
  },
  });
}
