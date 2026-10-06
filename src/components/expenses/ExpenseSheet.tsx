import { useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { Image } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import { FormSheet } from '@/src/components/ui/FormSheet';
import { Button } from '@/src/components/ui/Button';
import { Input } from '@/src/components/ui/Input';
import { Text } from '@/src/components/ui/Text';
import { DatePickerField } from '@/src/components/ui/DatePickerField';
import { ExpenseKeypad } from './ExpenseKeypad';
import { useTheme, spacing, radius } from '@/src/theme';
import type { Palette } from '@/src/theme';
import { useProductStore } from '@/stores/products';
import { getKV, setKV } from '@/lib/db';
import { haptics } from '@/lib/haptics';
import { formatAmount, formatAmountInput } from '@/src/utils/format';
import { formatDate } from '@/src/utils/dates';
import {
  pressKey, keypadValue, recentTemplates, searchProducts, rankLinkedProducts, pinRecents,
  type KeypadKey, type RepeatTemplate,
} from '@/src/utils/expenseUtils';
import type { CreateExpenseData } from '@/stores/expenses';
import type { Expense } from '@/src/types';

export type SheetMode = 'add' | 'detail' | 'edit';

function iso(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
const todayIso = () => iso(new Date());
const yesterdayIso = () => { const d = new Date(); d.setDate(d.getDate() - 1); return iso(d); };

const GENERIC_DESCRIPTION = 'Dépense';
const RECENTS_LIMIT = 6;

/** What the form's note field starts with when editing (legacy rows kept their text in `description`). */
function noteOf(e: Expense | null): string {
  if (!e) return '';
  if (e.note) return e.note;
  return e.description && e.description !== GENERIC_DESCRIPTION && e.description !== e.product_name ? e.description : '';
}

/** description is NOT NULL in the table: it is derived, never asked for. */
export function descriptionFor(note: string, productName: string | null): string {
  return note.trim() || productName || GENERIC_DESCRIPTION;
}

interface Props {
  visible: boolean;
  mode: SheetMode;
  expense: Expense | null;
  expenses: Expense[];
  currency: string;
  businessId: string;
  userId: string;
  saving: boolean;
  canModify: boolean;
  canReview: boolean;
  onClose: () => void;
  onSave: (data: CreateExpenseData, editingId: string | null) => Promise<boolean>;
  onEditRequest: () => void;
  onDelete: (e: Expense) => void;
  onApprove: (e: Expense) => void;
  onReject: (e: Expense) => void;
}

export function ExpenseSheet(props: Props) {
  const { visible, mode, expense, expenses, currency, businessId, userId, saving, canModify, canReview, onClose, onSave, onEditRequest, onDelete, onApprove, onReject } = props;
  const { palette } = useTheme();
  const styles = useMemo(() => makeStyles(palette), [palette]);

  const [raw, setRaw] = useState('');
  const [note, setNote] = useState('');
  const [productId, setProductId] = useState<string | null>(null);
  const [productName, setProductName] = useState<string | null>(null);
  const [date, setDate] = useState(todayIso());
  const [dateMode, setDateMode] = useState<'hier' | 'aujourdhui' | 'autre'>('aujourdhui');
  const [picking, setPicking] = useState(false);
  const [query, setQuery] = useState('');
  const [saved, setSaved] = useState(false);
  const [pinned, setPinned] = useState<string[]>([]);
  const closing = useRef(false);

  const { products, fetchProducts } = useProductStore();
  const activeProducts = useMemo(() => products.filter(p => !p.archived), [products]);

  useEffect(() => {
    if (visible && products.length === 0 && businessId) void fetchProducts(businessId, userId);
  }, [visible, businessId]);

  // Reset whenever the sheet (re)opens or switches record/mode.
  useEffect(() => {
    if (!visible) return;
    closing.current = false;
    setSaved(false);
    setPicking(false);
    setQuery('');
    const e = mode === 'add' ? null : expense;
    setRaw(e ? String(Math.round(e.amount * 100) / 100) : '');
    setNote(noteOf(e));
    setProductId(e?.product_id ?? null);
    setProductName(e?.product_name ?? null);
    const d = e?.date ?? todayIso();
    setDate(d);
    setDateMode(d === todayIso() ? 'aujourdhui' : d === yesterdayIso() ? 'hier' : 'autre');
  }, [visible, mode, expense?.id]);

  // "Récents" — pinned order, persisted so it never reshuffles between visits.
  useEffect(() => {
    if (!visible || !businessId) return;
    const key = `expense_recent_products_${businessId}`;
    let alive = true;
    void (async () => {
      let stored: string[] = [];
      try { stored = JSON.parse((await getKV(key)) ?? '[]'); } catch { stored = []; }
      const next = pinRecents(stored, rankLinkedProducts(expenses), RECENTS_LIMIT);
      if (!alive) return;
      setPinned(next);
      if (JSON.stringify(next) !== JSON.stringify(stored)) void setKV(key, JSON.stringify(next)).catch(() => {});
    })();
    return () => { alive = false; };
  }, [visible, businessId, expenses.length]);

  const amount = keypadValue(raw);
  const templates = useMemo(() => recentTemplates(expenses), [expenses]);
  const results = useMemo(() => searchProducts(activeProducts, query, 20), [activeProducts, query]);
  const pinnedProducts = useMemo(
    () => pinned.map(id => activeProducts.find(p => p.id === id)).filter((p): p is NonNullable<typeof p> => !!p),
    [pinned, activeProducts],
  );

  const onKey = (k: KeypadKey) => setRaw(r => pressKey(r, k, currency));

  const applyTemplate = (t: RepeatTemplate) => {
    haptics.tap();
    setRaw(String(Math.round(t.amount * 100) / 100));
    setProductId(t.product_id);
    setProductName(t.product_name);
    setNote(t.note ?? '');
  };

  const pickProduct = (id: string, name: string) => {
    haptics.select();
    setProductId(id);
    setProductName(name);
    setPicking(false);
    setQuery('');
  };

  const handleSave = async () => {
    if (amount <= 0 || saving || saved) return;
    const ok = await onSave(
      {
        amount, category: null, due_date: null, date,
        description: descriptionFor(note, productName),
        note: note.trim() || null,
        product_id: productId,
      },
      mode === 'edit' && expense ? expense.id : null,
    );
    if (!ok) return;
    setSaved(true);
    haptics.success();
    // ~300ms: let the check on the button register, then close.
    setTimeout(() => { if (!closing.current) { closing.current = true; onClose(); } }, 300);
  };

  // ── Detail ─────────────────────────────────────────────────────────────────
  if (mode === 'detail' && expense) {
    const label = [expense.product_name, expense.note || (expense.description !== GENERIC_DESCRIPTION && expense.description !== expense.product_name ? expense.description : null)].filter(Boolean).join(' · ');
    const pending = expense.status === 'en_attente';
    return (
      <FormSheet
        visible={visible}
        onClose={onClose}
        title="Dépense"
        contentContainerStyle={styles.content}
        footer={
          <View style={styles.footer}>
            {canReview && pending ? (
              <View style={{ flexDirection: 'row', gap: spacing[2] }}>
                <Button label="Accepter" onPress={() => onApprove(expense)} style={{ flex: 1 }} />
                <Button label="Refuser" variant="outline" onPress={() => onReject(expense)} style={{ flex: 1 }} />
              </View>
            ) : null}
            {canModify ? (
              <>
                <Button label="Modifier" onPress={onEditRequest} fullWidth size="lg" />
                <Pressable onPress={() => onDelete(expense)} style={styles.deleteBtn} accessibilityRole="button">
                  <Text variant="label" style={{ color: palette.warning }}>Supprimer</Text>
                </Pressable>
              </>
            ) : null}
          </View>
        }
      >
        <View style={styles.detailHead}>
          <Text variant="h1" style={styles.bigAmount} numberOfLines={1} adjustsFontSizeToFit>
            {formatAmount(expense.amount, currency)}
          </Text>
          {pending ? <Text variant="caption" color="secondary">En attente du gérant</Text> : null}
          {expense.status === 'rejete' ? <Text variant="caption" color="secondary">Refusée</Text> : null}
        </View>
        {label ? <Text variant="body" style={{ textAlign: 'center' }}>{label}</Text> : null}
        <Text variant="bodySmall" color="secondary" style={{ textAlign: 'center' }}>{formatDate(expense.date, 'long')}</Text>
        {expense.proof_image_url ? (
          <Image
            source={{ uri: expense.proof_image_url }}
            style={[styles.photo, { aspectRatio: expense.proof_image_width && expense.proof_image_height ? expense.proof_image_width / expense.proof_image_height : 4 / 3 }]}
            contentFit="contain"
          />
        ) : null}
      </FormSheet>
    );
  }

  // ── Product picker (same Modal — no nested sheets) ─────────────────────────
  if (picking) {
    return (
      <FormSheet
        visible={visible}
        onClose={() => { setPicking(false); setQuery(''); }}
        title="Produit"
        cancelLabel="Retour"
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
      >
        <Input
          value={query}
          onChangeText={setQuery}
          placeholder="Rechercher un produit"
          autoFocus
          autoCorrect={false}
          returnKeyType="search"
        />
        {query.trim() === '' ? (
          pinnedProducts.length > 0 ? (
            <View style={{ gap: spacing[2] }}>
              <Text variant="label" color="secondary">Récents</Text>
              {pinnedProducts.map(p => (
                <ProductRow key={p.id} name={p.name} onPress={() => pickProduct(p.id, p.name)} styles={styles} />
              ))}
            </View>
          ) : null
        ) : results.length > 0 ? (
          <View style={{ gap: spacing[2] }}>
            {results.map(p => (
              <ProductRow key={p.id} name={p.name} onPress={() => pickProduct(p.id, p.name)} styles={styles} />
            ))}
          </View>
        ) : (
          <View style={{ gap: spacing[1], paddingTop: spacing[4] }}>
            <Text variant="body" style={{ textAlign: 'center' }}>{`Aucun produit « ${query.trim()} »`}</Text>
            <Text variant="bodySmall" color="secondary" style={{ textAlign: 'center' }}>Utilisez la note ci-dessous.</Text>
          </View>
        )}
      </FormSheet>
    );
  }

  // ── Add / edit ─────────────────────────────────────────────────────────────
  const isEdit = mode === 'edit';
  return (
    <FormSheet
      visible={visible}
      onClose={onClose}
      title={isEdit ? 'Modifier la dépense' : 'Nouvelle dépense'}
      contentContainerStyle={styles.content}
      keyboardShouldPersistTaps="handled"
      footer={
        <View style={styles.footer}>
          <Button
            label={saved ? 'Enregistré' : 'Enregistrer'}
            loadingLabel="Enregistrement"
            icon={saved ? <Ionicons name="checkmark" size={20} color={palette.textInverse} /> : undefined}
            onPress={handleSave}
            loading={saving}
            disabled={amount <= 0}
            fullWidth
            size="lg"
          />
        </View>
      }
    >
      <View style={styles.amountBox}>
        <Text variant="h1" style={styles.bigAmount} numberOfLines={1} adjustsFontSizeToFit accessibilityLabel="Montant">
          {raw === '' ? `0 ${currency}` : `${formatAmountInput(raw, currency)} ${currency}`}
        </Text>
      </View>

      <ExpenseKeypad currency={currency} onKey={onKey} />

      {!isEdit && templates.length > 0 ? (
        <View style={{ gap: spacing[2] }}>
          <Text variant="label" color="secondary">Répéter</Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} keyboardShouldPersistTaps="handled" contentContainerStyle={{ gap: spacing[2] }}>
            {templates.map((t, i) => (
              <Pressable key={i} onPress={() => applyTemplate(t)} style={styles.chip} accessibilityRole="button">
                <Text variant="label" style={{ color: palette.textPrimary }}>{formatAmount(t.amount, currency)}</Text>
                {(t.product_name || t.note) ? (
                  <Text variant="caption" color="secondary" numberOfLines={1}>{t.product_name ?? t.note}</Text>
                ) : null}
              </Pressable>
            ))}
          </ScrollView>
        </View>
      ) : null}

      <View style={{ gap: spacing[2] }}>
        <Text variant="label">Produit (facultatif)</Text>
        {productId ? (
          <View style={styles.selectedChip}>
            <Text variant="label" numberOfLines={1} style={{ color: palette.textInverse, flexShrink: 1 }}>{productName}</Text>
            <Pressable onPress={() => { setProductId(null); setProductName(null); }} hitSlop={10} accessibilityRole="button" accessibilityLabel="Retirer le produit">
              <Ionicons name="close" size={16} color={palette.textInverse} />
            </Pressable>
          </View>
        ) : (
          <Pressable onPress={() => setPicking(true)} style={styles.pickerRow} accessibilityRole="button">
            <Text variant="body" color="secondary">Choisir un produit</Text>
            <Ionicons name="chevron-forward" size={18} color={palette.textSecondary} />
          </Pressable>
        )}
      </View>

      <View style={{ gap: spacing[2] }}>
        <Text variant="label">Date</Text>
        <View style={styles.datePills}>
          {(['hier', 'aujourdhui', 'autre'] as const).map(m => (
            <Pressable
              key={m}
              onPress={() => {
                setDateMode(m);
                if (m === 'hier') setDate(yesterdayIso());
                else if (m === 'aujourdhui') setDate(todayIso());
              }}
              style={[styles.datePill, dateMode === m && styles.datePillActive]}
            >
              <Text variant="label" style={{ color: dateMode === m ? palette.textInverse : palette.textSecondary }}>
                {m === 'hier' ? 'Hier' : m === 'aujourdhui' ? "Aujourd'hui" : 'Autre date'}
              </Text>
            </Pressable>
          ))}
        </View>
        {dateMode === 'autre' && <DatePickerField value={date} onChange={setDate} maxToday />}
      </View>

      <Input
        label="Note (facultatif)"
        value={note}
        onChangeText={setNote}
        placeholder="Carburant, loyer, salaire du gardien"
      />
    </FormSheet>
  );
}

function ProductRow({ name, onPress, styles }: { name: string; onPress: () => void; styles: ReturnType<typeof makeStyles> }) {
  return (
    <Pressable onPress={onPress} style={styles.productRow} accessibilityRole="button">
      <Text variant="body" numberOfLines={1}>{name}</Text>
    </Pressable>
  );
}

function makeStyles(p: Palette) {
  return StyleSheet.create({
    content: { padding: spacing[5], gap: spacing[4] },
    footer: { padding: spacing[5], gap: spacing[3], backgroundColor: p.background },
    amountBox: { alignItems: 'center', paddingVertical: spacing[3] },
    detailHead: { alignItems: 'center', gap: spacing[1], paddingVertical: spacing[4] },
    bigAmount: { fontSize: 44, lineHeight: 52, color: p.textPrimary, textAlign: 'center' },
    photo: { width: '100%', maxHeight: 360, borderRadius: radius.md, marginTop: spacing[2] },
    deleteBtn: { alignItems: 'center', paddingVertical: spacing[3] },
    chip: {
      paddingHorizontal: spacing[3], paddingVertical: spacing[2], borderRadius: radius.lg,
      borderWidth: 1, borderColor: p.border, backgroundColor: p.surface, maxWidth: 180, gap: 2,
    },
    selectedChip: {
      flexDirection: 'row', alignItems: 'center', gap: spacing[2], alignSelf: 'flex-start',
      paddingHorizontal: spacing[3], paddingVertical: spacing[2], borderRadius: radius.full,
      backgroundColor: p.textPrimary, maxWidth: '100%',
    },
    pickerRow: {
      flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
      paddingHorizontal: spacing[4], minHeight: 52, borderRadius: radius.lg,
      borderWidth: 1, borderColor: p.border, backgroundColor: p.surface,
    },
    productRow: {
      minHeight: 56, justifyContent: 'center', paddingHorizontal: spacing[4],
      borderRadius: radius.lg, borderWidth: 1, borderColor: p.border, backgroundColor: p.surface,
    },
    datePills: { flexDirection: 'row', gap: spacing[2] },
    datePill: {
      flex: 1, paddingVertical: spacing[2.5], alignItems: 'center',
      borderRadius: radius.full, borderWidth: 1.5, borderColor: p.border, backgroundColor: p.surface,
    },
    datePillActive: { backgroundColor: p.textPrimary, borderColor: p.textPrimary },
  });
}
