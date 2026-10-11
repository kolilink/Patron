import { useMemo, useRef, useState } from 'react';
import { Pressable, StyleSheet, TextInput, useWindowDimensions, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Button } from '@/src/components/ui/Button';
import { Text } from '@/src/components/ui/Text';
import { failAlert } from '@/src/components/ui/FailureView';
import { haptics } from '@/lib/haptics';
import { useInFlight } from '@/src/hooks/useInFlight';
import { useTheme, spacing, radius, fontFamily } from '@/src/theme';
import type { Palette } from '@/src/theme';
import { DebtReminderReceipt, RECEIPT_ASPECT } from '@/src/components/DebtReminderReceipt';
import { captureAndShareReceipt } from '@/src/components/receiptShare';
import { buildReceiptContent, type ReceiptSource } from '@/src/utils/saleReceipt';
import { formatAmountInput, minorUnits, parseAmountInput } from '@/src/utils/format';
import { editPendingCarnetDebt, editPendingQuickSale, editPendingSale, type PendingEditResult } from '@/lib/pendingReceiptEdit';

interface Props {
  source: ReceiptSource;
  /** Synced cart sale: "Modifier la vente" hands off to the live edit_sale flow (needs a connection). */
  onRequestSyncedEdit?: () => void;
  /** Fired after a pre-send correction was saved, with the corrected source. */
  onEdited?: (next: ReceiptSource) => void;
}

// A number → what the amount TextInput should hold. Whole-unit currencies are
// rounded first (a fractional value would otherwise be re-read as grouping).
const toInput = (n: number, cur: string) =>
  formatAmountInput(String(minorUnits(cur) === 0 ? Math.round(n) : n), cur);

/**
 * The receipt preview + "Partager", and — while the item is still in the
 * outbox — the pre-send correction step. Modal-free on purpose: it is rendered
 * either by SaleReceiptSheet (its own FormSheet) or swapped in-place inside a
 * host sheet (QuickCaptureSheet), never nested in a second Modal.
 */
export function ReceiptPanel({ source, onRequestSyncedEdit, onEdited }: Props) {
  const { palette } = useTheme();
  const styles = useMemo(() => makeStyles(palette), [palette]);
  const { width: windowWidth } = useWindowDimensions();
  const receiptRef = useRef<View>(null);
  const [sharing, runShare] = useInFlight();
  const [current, setCurrent] = useState<ReceiptSource>(source);
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, runSave] = useInFlight();

  const content = useMemo(() => buildReceiptContent(current), [current]);
  const previewWidth = Math.min(windowWidth - spacing[4] * 2, 360);
  const cur = current.currency;
  const editable = current.pending && !!current.key;

  // Drafts (strings, as typed).
  const [label, setLabel] = useState(current.kind === 'quick' ? current.label ?? '' : '');
  const [qty, setQty] = useState(current.kind === 'quick' ? current.qty : 1);
  const [price, setPrice] = useState(current.kind === 'quick' ? toInput(current.unitPrice, cur) : '');
  const [amount, setAmount] = useState(current.kind === 'credit' ? toInput(current.amount, cur) : '');
  const [lineQty, setLineQty] = useState<number[]>(current.kind === 'sale' ? current.lines.map(l => l.qty) : []);
  const [linePrice, setLinePrice] = useState<string[]>(current.kind === 'sale' ? current.lines.map(l => toInput(l.unitPrice, cur)) : []);
  const [discount, setDiscount] = useState(current.kind === 'sale' && current.discount > 0 ? toInput(current.discount, cur) : '');

  const handleShare = () => runShare(async () => {
    const res = await captureAndShareReceipt(receiptRef, 'Partager le reçu');
    // failure: speaks — capture or share sheet failed: receiptNotShared
    if (res !== 'shared') {
      haptics.error();
      failAlert('receiptNotShared');
    }
  });

  const handleSave = () => runSave(async () => {
    if (!current.key) return;
    setError(null);
    let res: PendingEditResult;
    let next: ReceiptSource;
    if (current.kind === 'quick') {
      const unitPrice = parseAmountInput(price, cur);
      res = await editPendingQuickSale(current.key, { unitPrice, qty, label });
      next = { ...current, unitPrice, qty, label: label.trim() || null };
    } else if (current.kind === 'credit') {
      const a = parseAmountInput(amount, cur);
      res = await editPendingCarnetDebt(current.key, { amount: a });
      next = { ...current, amount: a };
    } else {
      const lines = current.lines.map((l, i) => ({ qty: lineQty[i], unitPrice: parseAmountInput(linePrice[i] ?? '', cur) }));
      const disc = parseAmountInput(discount, cur);
      res = await editPendingSale(current.key, { lines, discount: disc });
      const netNow = lines.reduce((t, l) => t + l.qty * l.unitPrice, 0) - disc;
      next = {
        ...current,
        lines: current.lines.map((l, i) => ({ ...l, ...lines[i] })),
        discount: disc,
        // Paid in full stays paid in full at the corrected price (mirrors the outbox patch).
        paid: current.isCredit ? Math.min(current.paid, Math.max(0, netNow)) : Math.max(0, netNow),
      };
    }
    if (!res.ok) { setError(res.error); return; }
    setCurrent(next);
    setEditing(false);
    onEdited?.(next);
  });

  const input = (value: string, onChange: (v: string) => void, placeholder = '0') => (
    <TextInput
      style={[styles.input, { color: palette.textPrimary, borderColor: palette.border }]}
      value={value}
      onChangeText={v => { onChange(formatAmountInput(v, cur)); setError(null); }}
      placeholder={placeholder}
      placeholderTextColor={palette.textDisabled}
      keyboardType="numeric"
    />
  );

  const stepper = (value: number, onChange: (n: number) => void) => (
    <View style={styles.stepper}>
      <Pressable onPress={() => { onChange(Math.max(1, value - 1)); setError(null); }} hitSlop={12} style={styles.stepBtn} accessibilityLabel="Diminuer la quantité">
        <Ionicons name="remove" size={18} color={palette.textPrimary} />
      </Pressable>
      <Text variant="body" style={{ minWidth: 28, textAlign: 'center' }}>{value}</Text>
      <Pressable onPress={() => { onChange(value + 1); setError(null); }} hitSlop={12} style={styles.stepBtn} accessibilityLabel="Augmenter la quantité">
        <Ionicons name="add" size={18} color={palette.textPrimary} />
      </Pressable>
    </View>
  );

  return (
    <View style={styles.wrap}>
      <View style={[styles.previewWrap, { width: previewWidth, aspectRatio: RECEIPT_ASPECT }]}>
        <DebtReminderReceipt ref={receiptRef} content={content} width={previewWidth} />
      </View>

      {!editing ? (
        <>
          {/* Directly under the card: immediately reachable, no dead gap. */}
          <Button label="Partager" loading={sharing} loadingLabel="Préparation" fullWidth onPress={handleShare} />
          {editable ? (
            <Pressable onPress={() => setEditing(true)} hitSlop={10} style={styles.link} accessibilityRole="button">
              <Text variant="caption" style={{ color: palette.textSecondary, textDecorationLine: 'underline' }}>Modifier avant d&apos;envoyer</Text>
            </Pressable>
          ) : current.kind === 'sale' && onRequestSyncedEdit ? (
            <Pressable onPress={onRequestSyncedEdit} hitSlop={10} style={styles.link} accessibilityRole="button">
              <Text variant="caption" style={{ color: palette.textSecondary, textDecorationLine: 'underline' }}>Modifier la vente</Text>
            </Pressable>
          ) : null}
        </>
      ) : (
        <View style={styles.form}>
          {current.kind === 'quick' && (
            <>
              <View style={styles.field}>
                <Text variant="label" color="secondary">Qu&apos;avez-vous vendu ? (optionnel)</Text>
                <TextInput
                  style={[styles.input, { color: palette.textPrimary, borderColor: palette.border }]}
                  value={label}
                  onChangeText={v => { setLabel(v); setError(null); }}
                  placeholder="Riz, sac de 5kg…"
                  placeholderTextColor={palette.textDisabled}
                />
              </View>
              <View style={styles.field}><Text variant="label" color="secondary">Quantité</Text>{stepper(qty, setQty)}</View>
              <View style={styles.field}><Text variant="label" color="secondary">Prix unitaire ({cur})</Text>{input(price, setPrice)}</View>
            </>
          )}
          {current.kind === 'credit' && (
            <View style={styles.field}><Text variant="label" color="secondary">Montant ({cur})</Text>{input(amount, setAmount)}</View>
          )}
          {current.kind === 'sale' && (
            <>
              {current.lines.map((l, i) => (
                <View key={i} style={styles.field}>
                  <Text variant="label" numberOfLines={1}>{l.name}</Text>
                  <View style={styles.lineRow}>
                    {stepper(lineQty[i] ?? l.qty, n => setLineQty(q => q.map((x, j) => (j === i ? n : x))))}
                    <View style={{ flex: 1 }}>{input(linePrice[i] ?? '', v => setLinePrice(p => p.map((x, j) => (j === i ? v : x))))}</View>
                  </View>
                </View>
              ))}
              <View style={styles.field}><Text variant="label" color="secondary">Réduction ({cur})</Text>{input(discount, setDiscount)}</View>
            </>
          )}
          {error ? <Text variant="caption" style={{ color: palette.warning }}>{error}</Text> : null}
          <Button label="Enregistrer" loading={saving} loadingLabel="Enregistrement" fullWidth onPress={handleSave} />
          <Pressable onPress={() => { setEditing(false); setError(null); }} hitSlop={10} style={styles.link}>
            <Text variant="caption" style={{ color: palette.textSecondary }}>Annuler</Text>
          </Pressable>
        </View>
      )}
    </View>
  );
}

function makeStyles(p: Palette) {
  return StyleSheet.create({
    wrap: { gap: spacing[5] },
    previewWrap: { alignSelf: 'center', overflow: 'hidden', borderRadius: radius.md },
    link: { alignSelf: 'center', paddingVertical: 4 },
    form: { gap: spacing[4] },
    field: { gap: spacing[2] },
    lineRow: { flexDirection: 'row', alignItems: 'center', gap: spacing[4] },
    input: { borderWidth: 1, borderRadius: radius.md, paddingHorizontal: spacing[4], paddingVertical: spacing[3], fontSize: 17, fontFamily: fontFamily.regular },
    stepper: { flexDirection: 'row', alignItems: 'center', gap: spacing[3] },
    stepBtn: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center', backgroundColor: p.surface },
  });
}
