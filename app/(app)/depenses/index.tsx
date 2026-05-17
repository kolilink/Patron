import { useEffect, useMemo, useState } from 'react';
import { Alert, FlatList, Modal, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import { Button } from '@/src/components/ui/Button';
import { Card } from '@/src/components/ui/Card';
import { Input } from '@/src/components/ui/Input';
import { Text } from '@/src/components/ui/Text';
import { DatePickerField } from '@/src/components/ui/DatePickerField';
import { palette, spacing, radius } from '@/src/theme';
import { useAuthStore } from '@/stores/auth';
import { useExpensesStore, type CreateExpenseData } from '@/stores/expenses';
import type { Expense } from '@/src/types';

function fmt(n: number, cur: string) { return `${n.toLocaleString('fr-FR')} ${cur}`; }
function todayIso() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function statusColor(s: string) {
  if (s === 'approuve') return palette.success;
  if (s === 'rejete') return palette.danger;
  return palette.warning;
}

function statusLabel(s: string) {
  if (s === 'approuve') return 'Approuvé';
  if (s === 'rejete') return 'Rejeté';
  return 'En attente';
}

const CATEGORIES = ['Loyer', 'Transport', 'Fournitures', 'Salaires', 'Marketing', 'Utilitaires', 'Autres'];

// ─── Expense Form (create + edit) ─────────────────────────────────────────────

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
  const [dueDate, setDueDate] = useState('');
  const [note, setNote] = useState('');

  useEffect(() => {
    if (visible) {
      setAmount(editing ? String(editing.amount) : '');
      setDescription(editing?.description ?? '');
      setCategory(editing?.category ?? '');
      setDate(editing?.date ?? todayIso());
      setDueDate(editing?.due_date ?? '');
      setNote(editing?.note ?? '');
    }
  }, [visible, editing]);

  const handleSave = async () => {
    const amt = parseFloat(amount);
    if (!description.trim()) { Alert.alert('Description requise'); return; }
    if (isNaN(amt) || amt <= 0) { Alert.alert('Montant invalide'); return; }
    await onSave({
      amount: amt,
      description,
      category: category || null,
      date,
      due_date: dueDate || null,
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
            label={`Montant (${currency}) *`}
            value={amount}
            onChangeText={setAmount}
            keyboardType="decimal-pad"
            placeholder="0"
          />

          <Input
            label="Description *"
            value={description}
            onChangeText={setDescription}
            placeholder="Ex: Loyer du mois, carburant…"
          />

          <DatePickerField label="Date de la dépense" value={date} onChange={setDate} maxToday />

          <DatePickerField label="Date d'échéance (optionnel)" value={dueDate} onChange={setDueDate} minDate={date} />

          <Input
            label="Note (optionnel)"
            value={note}
            onChangeText={setNote}
            placeholder="Détails supplémentaires…"
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
  const isOverdue = isPending && expense.due_date && expense.due_date < todayIso();

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
            {expense.creator_name ? ` · ${expense.creator_name}` : ''}
          </Text>
          {expense.due_date ? (
            <Text variant="caption" style={{ color: isOverdue ? palette.danger : palette.warning }}>
              Échéance : {new Date(expense.due_date + 'T00:00:00').toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' })}
              {isOverdue ? ' — EN RETARD' : ''}
            </Text>
          ) : null}
          {expense.note ? (
            <Text variant="caption" color="secondary" numberOfLines={2}>{expense.note}</Text>
          ) : null}
        </View>
        <View style={{ alignItems: 'flex-end', gap: 4 }}>
          <Text variant="label" style={{ color: palette.danger }}>{fmt(expense.amount, currency)}</Text>
          <View style={[styles.statusPill, { backgroundColor: statusColor(expense.status) + '20' }]}>
            <Text variant="caption" style={{ color: statusColor(expense.status), fontWeight: '600' }}>
              {statusLabel(expense.status)}
            </Text>
          </View>
          {canEdit ? (
            <Pressable onPress={onEdit} style={styles.editBtn}>
              <Text variant="caption" style={{ color: palette.primary }}>Modifier</Text>
            </Pressable>
          ) : null}
        </View>
      </View>

      {isManager && isPending && (
        <View style={styles.actionRow}>
          <Button label="Approuver" size="sm" onPress={onApprove} style={{ flex: 1 }} />
          <Button label="Rejeter" size="sm" variant="danger" onPress={onReject} style={{ flex: 1 }} />
        </View>
      )}
    </Card>
  );
}

// ─── Month accordion row ───────────────────────────────────────────────────────

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

  const { expenses, loading, saving, fetchExpenses, createExpense, updateExpense, approveExpense, rejectExpense } =
    useExpensesStore();

  const [showForm, setShowForm] = useState(false);
  const [editingExpense, setEditingExpense] = useState<Expense | null>(null);

  useEffect(() => {
    if (businessId) fetchExpenses(businessId);
  }, [businessId]);

  // Pending expenses — always shown at top
  const pendingExpenses = useMemo(
    () => expenses.filter(e => e.status === 'en_attente'),
    [expenses],
  );

  // All non-pending grouped by month
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

  const totalApproved = useMemo(
    () => expenses.filter(e => e.status === 'approuve').reduce((s, e) => s + e.amount, 0),
    [expenses],
  );

  const currentMonthKey = (() => {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  })();

  const handleSave = async (data: CreateExpenseData) => {
    let ok: boolean;
    if (editingExpense) {
      ok = await updateExpense(editingExpense.id, businessId, data);
    } else {
      ok = await createExpense(businessId, userId, data, isManager);
      if (ok && !isManager) {
        Alert.alert('Dépense soumise', 'En attente de validation par un manager.');
      }
    }
    if (ok) {
      setShowForm(false);
      setEditingExpense(null);
    }
  };

  const handleEdit = (expense: Expense) => {
    setEditingExpense(expense);
    setShowForm(true);
  };

  const handleAdd = () => {
    setEditingExpense(null);
    setShowForm(true);
  };

  const handleApprove = (id: string) => {
    Alert.alert('Approuver cette dépense ?', '', [
      { text: 'Annuler', style: 'cancel' },
      { text: 'Approuver', onPress: () => approveExpense(id, userId) },
    ]);
  };

  const handleReject = (id: string) => {
    Alert.alert('Rejeter cette dépense ?', '', [
      { text: 'Annuler', style: 'cancel' },
      { text: 'Rejeter', style: 'destructive', onPress: () => rejectExpense(id, userId) },
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
          <Text variant="caption" color="secondary">Total approuvé</Text>
          <Text variant="label" style={{ color: palette.danger }}>{fmt(totalApproved, currency)}</Text>
        </Card>
        <Card style={[styles.summaryCard, pendingExpenses.length > 0 && { borderColor: palette.warning, borderWidth: 1 }]}>
          <Text variant="caption" color="secondary">En attente</Text>
          <Text variant="label" style={{ color: pendingExpenses.length > 0 ? palette.warning : palette.textSecondary }}>
            {pendingExpenses.length}
          </Text>
        </Card>
      </View>

      {loading && isEmpty ? (
        <Text variant="body" color="secondary" style={styles.center}>Chargement…</Text>
      ) : isEmpty ? (
        <View style={styles.empty}>
          <View style={styles.emptyIcon}>
            <Text style={{ fontSize: 48, lineHeight: 56 }}>💸</Text>
          </View>
          <Text variant="body" color="secondary">Aucune dépense.</Text>
          <Button label="Ajouter une dépense" onPress={handleAdd} size="sm" />
        </View>
      ) : (
        <ScrollView contentContainerStyle={styles.list} showsVerticalScrollIndicator={false}>

          {/* ── Pending section — always on top ── */}
          {pendingExpenses.length > 0 && (
            <View style={styles.pendingSection}>
              <View style={styles.pendingSectionHeader}>
                <View style={styles.pendingBadge}>
                  <Text variant="caption" style={{ color: palette.warning, fontWeight: '700' }}>
                    EN ATTENTE · {pendingExpenses.length}
                  </Text>
                </View>
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

          {/* ── Monthly accordions ── */}
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
  pendingSectionHeader: { paddingHorizontal: spacing[1] },
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
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: spacing[4] },
  emptyIcon: { alignItems: 'center' },
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
