import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Screen } from '@/src/components/ui/Screen';
import { router } from 'expo-router';
import { Text } from '@/src/components/ui/Text';
import { OfflineNotice } from '@/src/components/ui/OfflineNotice';
import { SkeletonList } from '@/src/components/ui/SkeletonPlaceholder';
import { EmptyState } from '@/src/components/ui/EmptyState';
import { ExpenseRow } from '@/src/components/expenses/ExpenseRow';
import { ExpenseSheet, type SheetMode } from '@/src/components/expenses/ExpenseSheet';
import { CountUpAmount } from '@/src/components/expenses/CountUpAmount';
import { ReceiptPhotoChip } from '@/src/components/expenses/ReceiptPhotoChip';
import { toast } from '@/stores/toast';
import { useTheme, spacing, radius } from '@/src/theme';
import type { Palette } from '@/src/theme';
import { useAuthStore } from '@/stores/auth';
import { useExpensesStore, type CreateExpenseData } from '@/stores/expenses';
import { useSyncStore } from '@/stores/sync';
import type { Expense } from '@/src/types';
import { haptics } from '@/lib/haptics';
import { formatAmount } from '@/src/utils/format';
import { groupByMonthAndDay } from '@/src/utils/expenseUtils';
import { expenseSubtitle } from '@/src/components/expenses/ExpenseRow';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

// ─── Main Screen ──────────────────────────────────────────────────────────────

/** How long the « Annuler » on a save/delete confirmation stays available. */
const EXPENSE_UNDO_MS = 10_000;

type Sheet = { mode: SheetMode; id: string | null } | null;

export default function DepensesScreen() {
  const insets = useSafeAreaInsets();
  const { palette } = useTheme();
  const styles = useMemo(() => makeStyles(palette), [palette]);
  const session = useAuthStore(s => s.session);
  const businessId = session?.activeBusiness?.id ?? '';
  const userId = session?.user.id ?? '';
  const currency = session?.activeBusiness?.currency ?? 'GNF';
  const role = session?.activeMembership?.role;
  const isManager = role === 'administrateur' || role === 'manager';

  const {
    expenses, loading, expensesFetchedFor, saving, error, offline, offlineSince,
    fetchExpenses, createExpense, updateExpense, deleteExpense, restoreExpense, approveExpense, rejectExpense,
  } = useExpensesStore();
  const lastSyncedAt = useSyncStore(s => s.lastSyncedAt);

  const [sheet, setSheet] = useState<Sheet>(null);
  const [photoChip, setPhotoChip] = useState<string | null>(null);
  const [newId, setNewId] = useState<string | null>(null);
  const [openMonths, setOpenMonths] = useState<Record<string, boolean>>({});
  // After the undo window closes on a fresh create, offer the receipt photo.
  const pendingPhotoFor = useRef<{ expenseId: string } | null>(null);
  const photoTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (businessId) fetchExpenses(businessId);
  }, [businessId]);

  // Once the outbox has drained, show what the server now holds.
  useEffect(() => {
    if (businessId && lastSyncedAt) void fetchExpenses(businessId);
  }, [lastSyncedAt]);

  const canModify = useCallback(
    (e: Expense) => isManager || (e.created_by === userId && e.status === 'en_attente'),
    [isManager, userId],
  );

  const pendingExpenses = useMemo(() => expenses.filter(e => e.status === 'en_attente'), [expenses]);
  // Month header + total, then day groups. Every total is a live sum over the
  // rows below it — nothing stored, so it can never disagree with the list.
  const months = useMemo(
    () => groupByMonthAndDay(expenses.filter(e => e.status !== 'en_attente')),
    [expenses],
  );

  const clearPendingPhoto = useCallback(() => {
    if (photoTimer.current) clearTimeout(photoTimer.current);
    photoTimer.current = null;
    pendingPhotoFor.current = null;
  }, []);

  // Confirmations ride the shared toast — the floating pill designed for the whole
  // app: the result in words + a real « Annuler » for the action window. On a fresh
  // create, when that window closes WITHOUT an undo, the receipt-photo offer takes
  // the pill's place — and only if the expense still exists by then (an undo, or a
  // delete from elsewhere, must never resurrect the offer for a gone expense).
  const showUndoToast = useCallback((message: string, onUndo: () => void | Promise<void>, photoFor?: string) => {
    clearPendingPhoto();
    if (photoFor) {
      pendingPhotoFor.current = { expenseId: photoFor };
      photoTimer.current = setTimeout(() => {
        photoTimer.current = null;
        const p = pendingPhotoFor.current;
        pendingPhotoFor.current = null;
        if (!p) return;
        if (!useExpensesStore.getState().expenses.some(e => e.id === p.expenseId)) return;
        setPhotoChip(p.expenseId);
      }, EXPENSE_UNDO_MS);
    }
    toast.show({
      message,
      tone: 'success',
      action: {
        label: 'Annuler',
        windowMs: EXPENSE_UNDO_MS,
        run: async () => { clearPendingPhoto(); await onUndo(); },
      },
    });
  }, [clearPendingPhoto]);

  useEffect(() => () => clearPendingPhoto(), [clearPendingPhoto]);

  const barLabel = (e: Expense | null, data: CreateExpenseData) => {
    const detail = e ? expenseSubtitle(e) : (data.note ?? '');
    return `Dépense ${formatAmount(data.amount, currency)}${detail ? ` · ${detail}` : ''}`;
  };

  const handleSave = useCallback(async (data: CreateExpenseData, editingId: string | null): Promise<boolean> => {
    if (editingId) {
      const prev = expenses.find(e => e.id === editingId);
      const ok = await updateExpense(editingId, businessId, data);
      if (!ok) return false;
      if (prev) {
        const prior: CreateExpenseData = {
          amount: prev.amount, description: prev.description, category: prev.category, date: prev.date,
          due_date: prev.due_date, note: prev.note, product_id: prev.product_id ?? null,
        };
        showUndoToast('Dépense modifiée', async () => { await updateExpense(editingId, businessId, prior); });
      }
      return true;
    }
    const id = await createExpense(businessId, userId, data, isManager);
    if (!id) return false;
    setNewId(id);
    // Same code path as a delete: Annuler soft-deletes the row just created.
    const productLine = useExpensesStore.getState().expenses.find(e => e.id === id);
    showUndoToast(barLabel(productLine ?? null, data), async () => {
      await deleteExpense(id, businessId);
    }, id);
    return true;
  }, [expenses, businessId, userId, isManager, createExpense, updateExpense, deleteExpense, showUndoToast]);

  const handleDelete = useCallback(async (e: Expense) => {
    setSheet(null);
    const ok = await deleteExpense(e.id, businessId);
    if (!ok) { haptics.error(); return; }
    haptics.tap();
    if (photoChip === e.id) setPhotoChip(null);
    if (pendingPhotoFor.current?.expenseId === e.id) clearPendingPhoto();
    showUndoToast('Dépense supprimée', async () => { await restoreExpense(e.id, businessId); });
  }, [businessId, deleteExpense, restoreExpense, showUndoToast, photoChip, clearPendingPhoto]);

  const handleApprove = useCallback(async (e: Expense) => {
    setSheet(null);
    const ok = await approveExpense(e.id, userId);
    if (ok) haptics.success(); else haptics.error();
  }, [approveExpense, userId]);

  const handleReject = useCallback(async (e: Expense) => {
    setSheet(null);
    await rejectExpense(e.id, userId);
  }, [rejectExpense, userId]);

  const handleAdd = () => setSheet({ mode: 'add', id: null });
  const sheetExpense = sheet?.id ? expenses.find(e => e.id === sheet.id) ?? null : null;

  const isEmpty = expenses.length === 0;

  const renderRow = (e: Expense) => (
    <ExpenseRow
      key={e.id}
      expense={e}
      currency={currency}
      canModify={canModify(e)}
      isNew={e.id === newId}
      onPress={() => setSheet({ mode: 'detail', id: e.id })}
      onDelete={() => handleDelete(e)}
    />
  );

  return (
    <Screen>
      <View style={styles.hdr}>
        <Pressable onPress={() => router.back()}><Text variant="body" color="secondary">‹ Retour</Text></Pressable>
        <Text variant="h4">Dépenses</Text>
        <View style={{ width: 64 }} />
      </View>

      {offline && (
        <OfflineNotice offlineSince={offlineSince} onRetry={() => fetchExpenses(businessId)} />
      )}

      {(loading || expensesFetchedFor !== businessId) && isEmpty ? (
        <SkeletonList count={6} />
      ) : !loading && isEmpty && error ? (
        <View style={styles.empty}>
          <Text variant="body" color="secondary" style={{ textAlign: 'center' }}>Données non disponibles hors ligne</Text>
        </View>
      ) : isEmpty ? (
        <EmptyState
          icon="wallet-outline"
          title="Aucune dépense pour le moment"
          subtitle="Vos dépenses apparaîtront ici, jour par jour."
          actionLabel="+ Dépense"
          onAction={handleAdd}
        />
      ) : (
        <ScrollView contentContainerStyle={styles.list} showsVerticalScrollIndicator={false}>
          {pendingExpenses.length > 0 && (
            <View style={styles.pendingSection}>
              <View style={styles.pendingBadge}>
                <Text variant="caption" style={{ color: palette.warning, fontWeight: '700' }}>
                  EN ATTENTE · {pendingExpenses.length}
                </Text>
              </View>
              {pendingExpenses.map(renderRow)}
            </View>
          )}

          {months.map(m => {
            const open = openMonths[m.key] ?? false;
            return (
              <View key={m.key} style={styles.monthBlock}>
                <Pressable
                  onPress={() => { haptics.toggle(!open); setOpenMonths(o => ({ ...o, [m.key]: !open })); }}
                  style={styles.monthHeader}
                >
                  <Text variant="label" style={styles.monthLabel}>{m.label}</Text>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing[2] }}>
                    <CountUpAmount value={m.total} currency={currency} style={{ color: palette.textPrimary }} />
                    <Text variant="caption" color="secondary">{open ? '▲' : '▼'}</Text>
                  </View>
                </Pressable>
                {open && m.days.map(d => (
                  <View key={d.key} style={styles.dayBlock}>
                    <Text variant="caption" color="secondary" style={styles.dayLabel}>{d.label}</Text>
                    {d.items.map(renderRow)}
                  </View>
                ))}
              </View>
            );
          })}
        </ScrollView>
      )}

      <ExpenseSheet
        visible={!!sheet}
        mode={sheet?.mode ?? 'add'}
        expense={sheetExpense}
        expenses={expenses}
        currency={currency}
        businessId={businessId}
        userId={userId}
        saving={saving}
        canModify={sheetExpense ? canModify(sheetExpense) : false}
        canReview={isManager}
        onClose={() => setSheet(null)}
        onSave={handleSave}
        onEditRequest={() => sheetExpense && setSheet({ mode: 'edit', id: sheetExpense.id })}
        onDelete={handleDelete}
        onApprove={handleApprove}
        onReject={handleReject}
      />

      {!isEmpty && (
        <View style={[styles.fabContainer, { bottom: insets.bottom + spacing[6] }]}>
          <Pressable
            onPress={handleAdd}
            style={({ pressed }) => [styles.fabExtended, pressed && { opacity: 0.82 }]}
            accessibilityLabel="Ajouter une dépense"
            accessibilityRole="button"
          >
            <Ionicons name="add" size={20} color={palette.textInverse} />
            <Text style={styles.fabExtendedLabel}>Dépense</Text>
          </Pressable>
        </View>
      )}

      {photoChip ? (
        <View style={[styles.chipWrap, { bottom: insets.bottom + spacing[6] }]} pointerEvents="box-none">
          <ReceiptPhotoChip
            expenseId={photoChip}
            businessId={businessId}
            offline={offline}
            onDone={() => { setPhotoChip(null); void fetchExpenses(businessId); }}
            onDismiss={() => setPhotoChip(null)}
          />
        </View>
      ) : null}
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

    dayBlock: { gap: spacing[2], paddingTop: spacing[3] },
    dayLabel: { paddingHorizontal: spacing[1] },
    chipWrap: { position: 'absolute', left: 0, right: 0, bottom: spacing[6], alignItems: 'center' },

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

    // FAB — extended (icon + label), never a bare "+": an icon-only action
    // button can't be recognized by name, only by shape.
    fabContainer: { position: 'absolute', bottom: 194, right: spacing[4], zIndex: 10 },
    fabExtended: {
      flexDirection: 'row', alignItems: 'center', gap: spacing[2],
      height: 56, paddingHorizontal: spacing[5], borderRadius: radius.full,
      backgroundColor: p.primary,
      shadowColor: p.shadow, shadowOffset: { width: 0, height: 4 },
      shadowOpacity: 0.18, shadowRadius: 8, elevation: 8,
    },
    fabExtendedLabel: { fontSize: 15, fontWeight: '600' as const, color: p.textInverse },

    // Form modal
    modalSafe: { flex: 1, backgroundColor: p.background },
    modalHeader: {
      flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
      padding: spacing[5], borderBottomWidth: 1, borderBottomColor: p.border,
      backgroundColor: p.surface,
    },
    modalContent: { padding: spacing[5], gap: spacing[4] },
    modalFooter: { padding: spacing[5] }, // no slab
  });
}
