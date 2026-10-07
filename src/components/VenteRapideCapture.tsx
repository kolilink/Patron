import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { Pressable, StyleSheet, TextInput, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Button } from '@/src/components/ui/Button';
import { Text } from '@/src/components/ui/Text';
import { useTheme, spacing, radius, fontFamily } from '@/src/theme';
import type { Palette } from '@/src/theme';
import { formatAmount, formatAmountInput, parseAmountInput } from '@/src/utils/format';
import { useSalesStore } from '@/stores/sales';
import { haptics } from '@/lib/haptics';
import { trackEvent } from '@/lib/analytics';

const CONFIRM_MS = 900;

interface VenteRapideCaptureProps {
  businessId: string;
  userId: string;
  currency: string;
  /** Called with the sale's total (cents) right after a successful save —
   * feeds the host's own session ticker (visible under the Crédit/Vente
   * toggle), which lives in the host so it survives a mode switch. */
  onAdded?: (amountCents: number) => void;
}

// Vente rapide — the quick-sale mode of the rapid capture sheet. Replaces
// the old name-typing "Nouvelle vente" screen (app/(app)/onboarding/vente-
// rapide.tsx, deleted) and, before that, replaced the amount-only-with-no-
// fields first draft of this same component — the product spec added the
// (optional) name and (real) quantity back the same week. Speed is still
// the spec: the name is skippable and the rush path is qty=1 (the default)
// + type a price + done, but she can name what she sold and set a real
// quantity when it's worth the extra few seconds.
//
// Backed by submit_quick_sale() (db/migration_v198.sql) — the same
// is_system-placeholder-product pattern CreditRapideCapture's sibling
// submit_carnet_debt() already uses on the credit side, so a real qty and
// an optional label can be recorded without ever creating a real catalog
// product or moving real inventory. "Pas de produit, pas de quantité
// [inventée]" — the quantity typed here is real and stored, it's just never
// backed by stock.
/** Imperative handle: the sheet focuses the price AFTER its entrance animation finishes. */
export interface VenteRapideCaptureHandle {
  focusPrice: () => void;
}

// The price field has NO `autoFocus`: this component remounts (key={String(visible)})
// exactly while the full-screen Modal runs its entrance animation, so autoFocus made
// the iOS keyboard animate in at the same time as the sheet — a ghost keyboard drawn
// above the real one for a moment. QuickCaptureSheet calls focusPrice() from the
// Modal's onShow instead: one animation at a time.
export const VenteRapideCapture = forwardRef<VenteRapideCaptureHandle, VenteRapideCaptureProps>(function VenteRapideCapture({ businessId, userId, currency, onAdded }, ref) {
  const { palette } = useTheme();
  const styles = useMemo(() => makeStyles(palette), [palette]);
  const submitQuickSale = useSalesStore(s => s.submitQuickSale);

  const [label, setLabel] = useState('');
  const [qty, setQty] = useState(1);
  const [priceStr, setPriceStr] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Cosmetic only — the button's own "✓ Ajouté" confirmation. Deliberately
  // independent of the form fields below: they clear the instant the save
  // succeeds, so she's free to type the next entry immediately regardless
  // of whether this is still showing. Cancelled early (see the onChangeText
  // handlers) the moment she actually starts that next entry, so the label
  // never lags behind what's really about to be submitted.
  const [success, setSuccess] = useState(false);

  const nameRef = useRef<TextInput>(null);
  const priceRef = useRef<TextInput>(null);
  useImperativeHandle(ref, () => ({ focusPrice: () => priceRef.current?.focus() }), []);
  const successTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // A Crédit↔Vente switch unmounts this component; don't let the pending
  // confirm timer outlive it.
  useEffect(() => () => {
    if (successTimerRef.current) clearTimeout(successTimerRef.current);
  }, []);

  const unitPrice = parseAmountInput(priceStr, currency);
  const total = qty * unitPrice;
  const canAdd = unitPrice > 0 && qty > 0 && !saving;

  const cancelConfirm = () => {
    if (successTimerRef.current) { clearTimeout(successTimerRef.current); successTimerRef.current = null; }
    if (success) setSuccess(false);
  };

  const handleAdd = async () => {
    if (!canAdd) return;
    const unitPriceCents = Math.round(unitPrice * 100);
    const qtyAtSubmit = qty;
    setSaving(true);
    setError(null);

    const ok = await submitQuickSale(businessId, userId, unitPriceCents, qtyAtSubmit, label);
    setSaving(false);
    if (!ok) {
      setError('Impossible d\'enregistrer. Vérifiez votre connexion et réessayez.');
      return;
    }

    const amountCents = Math.round(unitPriceCents * qtyAtSubmit);
    trackEvent('quick_capture_submitted', businessId, userId, {
      mode: 'vente', queued: useSalesStore.getState().lastQuickSaleQueued, qty: qtyAtSubmit,
    });
    haptics.success();
    onAdded?.(amountCents);

    // Button morph: "Ajouté" shows for ~900ms then reverts on its own —
    // purely cosmetic, never gates the form below.
    setSuccess(true);
    if (successTimerRef.current) clearTimeout(successTimerRef.current);
    successTimerRef.current = setTimeout(() => setSuccess(false), CONFIRM_MS);

    // Stays in the loop: everything resets to the rush defaults (qty back
    // to 1, not wherever it was left) immediately, sheet stays open — no
    // toast, no navigation, nothing that could delay the next entry.
    setLabel('');
    setQty(1);
    setPriceStr('');
    priceRef.current?.focus();
  };

  return (
    <View style={styles.content}>
      <View style={styles.field}>
        <Text variant="label" color="secondary">Qu&apos;avez-vous vendu ? (optionnel)</Text>
        <TextInput
          ref={nameRef}
          style={[styles.nameInput, { color: palette.textPrimary, borderColor: palette.border }]}
          placeholder="Riz, sac de 5kg…"
          placeholderTextColor={palette.textDisabled}
          value={label}
          onChangeText={v => { setLabel(v); setError(null); cancelConfirm(); }}
          returnKeyType="next"
          onSubmitEditing={() => priceRef.current?.focus()}
          autoCapitalize="sentences"
        />
      </View>

      <View style={styles.field}>
        <Text variant="label" color="secondary">Quantité</Text>
        <View style={styles.stepper}>
          <Pressable onPress={() => { setQty(q => Math.max(1, q - 1)); cancelConfirm(); }} hitSlop={14} style={[styles.stepperBtn, { backgroundColor: palette.surface }]} accessibilityLabel="Diminuer la quantité" accessibilityRole="button">
            <Ionicons name="remove" size={20} color={palette.textPrimary} />
          </Pressable>
          <Text variant="h3" style={styles.stepperValue}>{qty}</Text>
          <Pressable onPress={() => { setQty(q => q + 1); cancelConfirm(); }} hitSlop={14} style={[styles.stepperBtn, { backgroundColor: palette.surface }]} accessibilityLabel="Augmenter la quantité" accessibilityRole="button">
            <Ionicons name="add" size={20} color={palette.textPrimary} />
          </Pressable>
        </View>
      </View>

      <View style={styles.field}>
        <Text variant="label" color="secondary">Prix unitaire</Text>
        <View style={[styles.amountBox, { borderColor: palette.border }]}>
          <TextInput
            ref={priceRef}
            style={[styles.amountInput, { color: priceStr ? palette.textPrimary : palette.textDisabled }]}
            placeholder="0"
            placeholderTextColor={palette.textDisabled}
            value={priceStr}
            onChangeText={v => { setPriceStr(formatAmountInput(v, currency)); setError(null); cancelConfirm(); }}
            keyboardType="numeric"
            returnKeyType="done"
            onSubmitEditing={handleAdd}
          />
          <Text style={[styles.amountCurrency, { color: palette.textSecondary }]}>{currency}</Text>
        </View>
      </View>

      {/* Brand purple throughout, label swap only — the confirmation is
          "✓ Ajouté" plus the haptic already fired above, never a color
          change. Never disabled by `success` itself: canAdd already gates
          on the (just-cleared) price, so there's nothing to guard twice. */}
      <Button
        label={success ? '✓ Ajouté' : total > 0 ? `Ajouter · ${formatAmount(total, currency)}` : 'Ajouter'}
        onPress={handleAdd}
        loading={saving}
        disabled={!canAdd}
        fullWidth
        size="lg"
      />
      {error ? (
        <Text variant="caption" style={{ color: palette.warning, textAlign: 'center' }}>{error}</Text>
      ) : null}
    </View>
  );
});

function makeStyles(p: Palette) {
  return StyleSheet.create({
    content: { gap: spacing[4] },
    field: { gap: spacing[2] },
    nameInput: {
      borderWidth: 1, borderRadius: radius.md, paddingHorizontal: spacing[4], paddingVertical: spacing[3], fontSize: 17,
    },
    stepper: { flexDirection: 'row', alignItems: 'center', gap: spacing[6] },
    stepperBtn: {
      width: 40, height: 40, borderRadius: 20,
      alignItems: 'center', justifyContent: 'center',
    },
    stepperValue: { minWidth: 40, textAlign: 'center' },
    amountBox: {
      flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
      borderWidth: 1.5, borderRadius: radius.md, paddingHorizontal: spacing[4], paddingVertical: spacing[4],
    },
    amountInput: { flex: 1, fontSize: 28, lineHeight: 34, fontFamily: fontFamily.bold },
    amountCurrency: { fontSize: 16, fontFamily: fontFamily.semibold },
  });
}
