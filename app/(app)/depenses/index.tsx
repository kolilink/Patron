import { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, FlatList, Modal, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import { Button } from '@/src/components/ui/Button';
import { Card } from '@/src/components/ui/Card';
import { Input } from '@/src/components/ui/Input';
import { Text } from '@/src/components/ui/Text';
import { DatePickerField } from '@/src/components/ui/DatePickerField';
import { OfflineNotice } from '@/src/components/ui/OfflineNotice';
import { palette, spacing, radius } from '@/src/theme';
import { useAuthStore } from '@/stores/auth';
import { useExpensesStore, type CreateExpenseData } from '@/stores/expenses';
import type { Expense } from '@/src/types';
import { haptics } from '@/lib/haptics';

function fmt(n: number, cur: string) { return `${n.toLocaleString('fr-FR')} ${cur}`; }
function todayIso() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function statusLabel(s: string) {
  if (s === 'approuve') return 'Enregistré';
  if (s === 'rejete') return 'Refusé';
  return 'Pas encore accepté';
}

function statusColor(s: string) {
  if (s === 'approuve') return palette.success;
  if (s === 'rejete') return palette.danger;
  return palette.warning;
}

const CATEGORIES = ['Loyer', 'Transport', 'Achats', 'Salaires', 'Pub', 'Factures', 'Autres'];

// ─── Expense Form ─────────────────────────────────────────────────────────────

interface ExpenseFormProps {
  visible: boolean;
  editing: Expense | null;
  onClose: () => void;
  onSave: (data: CreateExpenseData) => Promise<void>;
  saving: boolean;
  currency: string;
}

function ExpenseFormModal({ visible, editing, onClose, onSave, saving, currency }: ExpenseFormProps) {
  const [amount, setAmount] = useState('');
  const [description, setDescription] = useState('');
  const [category, setCategory] = useState('');
  const [date, setDate] = useState(todayIso());
  const [note, setNote] = useState('');

  useEffect(() => {
    if (visible) {
      setAmount(editing ? String(editing.amount) : '');
      setDescription(editing?.description ?? '');
      setCategory(editing?.category ?? '');
      setDate(editing?.date ?? todayIso());
      setNote(editing?.note ?? '');
    }
  }, [visible, editing]);

  const handleSave = async () => {
    const amt = parseFloat(amount);
    if (!description.trim()) { Alert.alert('Écrivez un petit mot :)'); return; }
    if (isNaN(amt) || amt <= 0) { Alert.alert('Vérifiez le montant :)'); return; }
    await onSave({
      amount: amt,
      description,
      category: category || null,
      date,
      due_date: null,
      note: note || null,
    });
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
            onChangeText={setAmount}
            keyboardType="decimal-pad"
            placeholder="0"
          />

          <Input
            label="Description"
            value={description}
            onChangeText={setDescription}
            placeholder="Ex: sac de riz, taxi, facture…"
          />

          <DatePickerField label="Date de la dépense" value={date} onChange={setDate} maxToday />

          <Input
            label="Note (optionnel)"
            value={note}
            onChangeText={setNote}
            placeholder="Notes…"
            multiline
          />

          <View>
            <Text variant="label" style={{ marginBottom: spacing[2] }}>Catégorie</Text>
            <View style={styles.catGrid}>
              {CATEGORIES.map(c => (
                <Pressable key={c} onPress={() => setCategory(category === c ? '' : c)}
                  style={[styles.catChip, category === c && styles.catChipActive]}>
                  <Text variant="caption" style={{ color: category === c ? palette.textInverse : palette.textPrimary }}>
                    {c}
                  </Text>
                </Pressable>
              ))}
            </View>
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
  const isPending = expense.status === 'en_attente';

  return (
    <Card style={[styles.expRow, isPending && styles.expRowPending]}>
      <View style={styles.expTop}>
        <View style={{ flex: 1 }}>
          <Text variant="label" numberOfLines={1}>{expense.description}</Text>
          {expense.category ? (
            <View style={styles.catPill}>
              <Text variant="caption" color="secondary">{expense.category}</Text>
            </View>
          ) : null}
          <Text variant="caption" color="secondary">
            {new Date(expense.date + 'T00:00:00').toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' })}
          </Text>
          {expense.note ? (
            <Text variant="caption" color="secondary" numberOfLines={2}>{expense.note}</Text>
          ) : null}
        </View>
        <View style={{ alignItems: 'flex-end', gap: 4 }}>
          <Text variant="label" style={{ color: palette.danger }}>{fmt(expense.amount, currency)}</Text>
          {isPending && (
            <View style={[styles.statusPill, { backgroundColor: statusColor(expense.status) + '20' }]}>
              <Text variant="caption" style={{ color: statusColor(expense.status), fontWeight: '600' }}>
                {statusLabel(expense.status)}
              </Text>
            </View>
          )}
          {canEdit ? (
            <Pressable onPress={onEdit} style={styles.editBtn}>
              <Text variant="caption" style={{ color: palette.primary }}>Modifier</Text>
            </Pressable>
          ) : null}
        </View>
      </View>

      {isManager && isPending && (
        <View style={styles.actionRow}>
          <Button label="Accepter" size="sm" onPress={onApprove} style={{ flex: 1 }} />
          <Button label="Refuser" size="sm" variant="danger" onPress={onReject} style={{ flex: 1 }} />
        </View>
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
  const [open, setOpen] = useState(defaultOpen);

  useEffect(() => {
    if (defaultOpen) setOpen(true);
  }, [defaultOpen, items.length]);

  return (
    <View style={styles.monthBlock}>
      <Pressable onPress={() => setOpen(o => !o)} style={styles.monthHeader}>
        <Text variant="label" style={styles.monthLabel}>{label}</Text>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing[2] }}>
          <Text variant="label" style={{ color: palette.danger }}>{fmt(total, currency)}</Text>
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

  const thisMonthApproved = useMemo(() => {
    const now = new Date();
    const monthStart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
    return expenses.filter(e => e.status === 'approuve' && e.date >= monthStart).reduce((s, e) => s + e.amount, 0);
  }, [expenses]);

  const currentMonthKey = (() => {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  })();

  const handleSave = useCallback(async (data: CreateExpenseData) => {
    let ok: boolean;
    if (editingExpense) {
      ok = await updateExpense(editingExpense.id, businessId, data);
      if (ok) Alert.alert('Dépense mise à jour');
    } else {
      ok = await createExpense(businessId, userId, data, isManager);
      if (ok && !isManager) {
        Alert.alert('Dépense enregistrée', 'Pas encore acceptée par le gérant.');
      }
    }
    if (!ok) {
      const msg = useExpensesStore.getState().error;
      Alert.alert('La dépense n\'est pas passée :)');
    }
    if (ok) {
      setShowForm(false);
      setEditingExpense(null);
    }
  }, [editingExpense, businessId, userId, isManager, updateExpense, createExpense]);

  const handleEdit = (expense: Expense) => { setEditingExpense(expense); setShowForm(true); };
  const handleAdd = () => { setEditingExpense(null); setShowForm(true); };

  const handleApprove = (id: string) => {
    Alert.alert('Accepter cette dépense ?', '', [
      { text: 'Annuler', style: 'cancel' },
      { text: 'Accepter', onPress: async () => {
        const ok = await approveExpense(id, userId);
        if (ok) haptics.success(); else haptics.error();
      }},
    ]);
  };

  const handleReject = (id: string) => {
    Alert.alert('Refuser cette dépense ?', '', [
      { text: 'Annuler', style: 'cancel' },
      { text: 'Refuser', style: 'destructive', onPress: async () => {
        const ok = await rejectExpense(id, userId);
        if (ok) haptics.error();
      }},
    ]);
  };

  const isEmpty = expenses.length === 0;

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      {/* Header */}
      <View style={styles.hdr}>
        <Pressable onPress={() => router.back()}><Text variant="body" color="secondary">‹ Retour</Text></Pressable>
        <Text variant="h4">Dépenses</Text>
        <Pressable onPress={handleAdd}>
          <Text variant="label" style={{ color: palette.primary }}>+ Ajouter</Text>
        </Pressable>
      </View>

      {/* Summary bar */}
      <View style={styles.summary}>
        <Card style={styles.summaryCard}>
          <Text variant="caption" color="secondary">Ce mois, vous avez déjà dépensé</Text>
          <Text variant="label">{fmt(thisMonthApproved, currency)}</Text>
        </Card>
        {pendingExpenses.length > 0 && (
          <Card style={[styles.summaryCard, { borderColor: palette.warning, borderWidth: 1 }]}>
            <Text variant="caption" color="secondary">Pas encore accepté</Text>
            <Text variant="label" style={{ color: palette.warning }}>{pendingExpenses.length}</Text>
          </Card>
        )}
      </View>

      {offline && <OfflineNotice offlineSince={offlineSince} />}

      {loading && isEmpty ? (
        <Text variant="body" color="secondary" style={styles.center}>Chargement…</Text>
      ) : !loading && isEmpty && error ? (
        <View style={styles.empty}>
          <Text variant="body" color="secondary" style={{ textAlign: 'center' }}>Données non disponibles hors ligne</Text>
        </View>
      ) : isEmpty ? (
        <View style={styles.empty}>
          <Text variant="body" color="secondary" style={{ textAlign: 'center', fontWeight: '600' }}>Aucune dépense ce mois — c'est bon signe.</Text>
          <Text variant="caption" color="secondary" style={{ textAlign: 'center' }}>Ajoutez-en une dès qu'elle se présente.</Text>
          <Button label="+ Ajouter une dépense" onPress={handleAdd} size="sm" style={{ marginTop: spacing[2] }} />
        </View>
      ) : (
        <ScrollView contentContainerStyle={styles.list} showsVerticalScrollIndicator={false}>

          {/* Pending section */}
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
              defaultOpen={group.key === currentMonthKey}
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
  summary: { flexDirection: 'row', padding: spacing[5], gap: spacing[3] },
  summaryCard: { flex: 1, gap: 2 },
  list: { padding: spacing[5], gap: spacing[4], paddingBottom: spacing[12] },

  // Pending section
  pendingSection: { gap: spacing[2] },
  pendingBadge: {
    alignSelf: 'flex-start',
    backgroundColor: palette.warning + '20',
    borderRadius: radius.sm,
    paddingHorizontal: spacing[2],
    paddingVertical: spacing[1],
    borderWidth: 1,
    borderColor: palette.warning + '60',
  },

  // Month accordion
  monthBlock: { gap: 0 },
  monthHeader: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    paddingVertical: spacing[3], paddingHorizontal: spacing[1],
    borderBottomWidth: 1, borderBottomColor: palette.border,
  },
  monthLabel: { textTransform: 'capitalize' },
  monthItems: { gap: spacing[2], paddingTop: spacing[2] },

  // Expense card
  expRow: { gap: spacing[2] },
  expRowPending: { borderLeftWidth: 3, borderLeftColor: palette.warning },
  expTop: { flexDirection: 'row', gap: spacing[3], alignItems: 'flex-start' },
  catPill: {
    alignSelf: 'flex-start', backgroundColor: palette.primaryLight,
    borderRadius: radius.sm, paddingHorizontal: spacing[1.5], paddingVertical: 2, marginTop: 2,
  },
  statusPill: { paddingHorizontal: spacing[2], paddingVertical: 2, borderRadius: radius.sm },
  editBtn: {
    paddingHorizontal: spacing[2], paddingVertical: 2,
    borderRadius: radius.sm, borderWidth: 1, borderColor: palette.primary + '50',
  },
  actionRow: { flexDirection: 'row', gap: spacing[2] },

  // Empty
  offlineBanner: { alignItems: 'center', justifyContent: 'center', paddingVertical: spacing[1], borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: palette.border },
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: spacing[3] },
  center: { textAlign: 'center', marginTop: spacing[10] },

  // Categories
  catGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing[2] },
  catChip: {
    paddingHorizontal: spacing[3], paddingVertical: spacing[1.5],
    borderRadius: radius.full, borderWidth: 1, borderColor: palette.border, backgroundColor: palette.surface,
  },
  catChipActive: { backgroundColor: palette.primary, borderColor: palette.primary },

  // Form modal
  modalSafe: { flex: 1, backgroundColor: palette.background },
  modalHeader: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    padding: spacing[5], borderBottomWidth: 1, borderBottomColor: palette.border,
    backgroundColor: palette.surface,
  },
  modalContent: { padding: spacing[5], gap: spacing[4] },
  modalFooter: {
    padding: spacing[5], borderTopWidth: 1, borderTopColor: palette.border,
    backgroundColor: palette.surface,
  },
});
