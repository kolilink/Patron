import { useEffect, useRef, useState, useMemo } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
} from 'react-native';
import { router } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { Screen } from '@/src/components/ui/Screen';
import { Button } from '@/src/components/ui/Button';
import { Text } from '@/src/components/ui/Text';
import { useTheme, spacing } from '@/src/theme';
import type { Palette } from '@/src/theme';
import { formatAmount, formatAmountInput, parseAmountInput } from '@/src/utils/format';
import { useAuthStore } from '@/stores/auth';
import { useSalesStore } from '@/stores/sales';
import { useProductStore } from '@/stores/products';

type PayChoice = 'cash' | 'credit';

// The "Une vente" destination from ActivationForkOverlay — a merchant's
// very first sale, with no catalog to sell from yet. Three plain questions,
// stacked, one per row: what, how many, how much — no shared row (qty and
// price sharing a row read as "why is there a +/- next to a price" and
// wasn't self-explanatory), no separate "add to list" step (filling the
// three fields IS the sale — this records one item, not a cart).
//
// On save, that one item first becomes a real, minimal product (name +
// price + starting stock = the qty about to be sold) before the normal
// submit_sale RPC runs completely unmodified. That's what lets stock
// deduction, cost tracking, and every existing reconciliation check keep
// working untouched — nothing about a sale recorded here is actually
// "product-less" in the data, only in how fast the merchant had to get here.
export default function VenteRapideScreen() {
  const { palette } = useTheme();
  const styles = useMemo(() => makeStyles(palette), [palette]);
  const session = useAuthStore(s => s.session);
  const businessId = session?.activeBusiness?.id ?? '';
  const userId = session?.user.id ?? '';
  const currency = session?.activeBusiness?.currency ?? 'GNF';
  const { addToCart, setQty, clearCart, submitSale } = useSalesStore();
  const createProduct = useProductStore(s => s.createProduct);

  // The activation fork (app/(app)/_layout.tsx) is evaluated globally and
  // only knows to stay away for a fixed ~1.2s after the button that sent
  // someone here — enough to bridge the navigation itself, not enough to
  // fill in a real sale. Suppress it for as long as this screen is mounted
  // instead, lifting the moment it isn't (completing the sale navigates
  // away; "← Retour" does too) — same fix already applied to catalogue.tsx's
  // add-product form, same reason: don't guess how long someone takes.
  useEffect(() => {
    useAuthStore.setState({ suppressActivationFork: true });
    return () => { useAuthStore.setState({ suppressActivationFork: false }); };
  }, []);

  const [description, setDescription] = useState('');
  const [qty, setQtyDraft] = useState(1);
  const [priceStr, setPriceStr] = useState('');
  const [payChoice, setPayChoice] = useState<PayChoice>('cash');
  const [customerName, setCustomerName] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const priceRef = useRef<TextInput>(null);

  const price = parseAmountInput(priceStr, currency);
  const total = qty * price;
  const canSave =
    description.trim().length > 0 &&
    price > 0 &&
    qty > 0 &&
    (payChoice === 'cash' || customerName.trim().length > 0) &&
    !saving;

  const handleSave = async () => {
    if (!canSave) return;
    setSaving(true);
    setError(null);
    clearCart();

    const trimmedDesc = description.trim();
    const unitPrice = Math.round(price);

    const ok = await createProduct(businessId, userId, {
      name: trimmedDesc,
      unit: 'pcs',
      cost_price: 0,
      sale_price: unitPrice,
      reorder_level: 0,
      initial_stock: qty,
    });
    const created = useProductStore.getState().products.find(
      p => p.name.trim().toLowerCase() === trimmedDesc.toLowerCase(),
    );
    if (!ok || !created) {
      setSaving(false);
      setError("La vente n'a pas pu être enregistrée. Réessayez.");
      return;
    }
    addToCart(created);
    setQty(created.id, qty);

    const payment = payChoice === 'cash' ? { method: 'especes' as const, amount: qty * unitPrice } : null;
    const okSale = await submitSale(businessId, userId, payment, payChoice === 'credit' ? customerName.trim() : undefined);
    setSaving(false);
    if (!okSale) {
      setError(useSalesStore.getState().error ?? "La vente n'a pas pu être enregistrée. Réessayez.");
      return;
    }
    router.replace('/(app)/(tabs)/');
  };

  return (
    <Screen>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={{ flex: 1, backgroundColor: palette.background }}
      >
        <View style={styles.header}>
          <Pressable onPress={() => router.back()} hitSlop={12}>
            <Text variant="body" color="brand">← Retour</Text>
          </Pressable>
          <Text variant="h3">Nouvelle vente</Text>
        </View>

        <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
          <View style={styles.question}>
            <Text variant="label" color="secondary">Qu'avez-vous vendu ?</Text>
            <TextInput
              style={[styles.inputLine, { color: palette.textPrimary, borderBottomColor: palette.border }]}
              placeholder="Riz, sac de 5kg…"
              placeholderTextColor={palette.textDisabled}
              value={description}
              onChangeText={setDescription}
              returnKeyType="next"
              onSubmitEditing={() => priceRef.current?.focus()}
              autoFocus
            />
          </View>

          <View style={styles.question}>
            <Text variant="label" color="secondary">Quantité</Text>
            <View style={styles.stepper}>
              <Pressable onPress={() => setQtyDraft(q => Math.max(1, q - 1))} hitSlop={14} style={styles.stepperBtn}>
                <Ionicons name="remove" size={22} color={palette.textPrimary} />
              </Pressable>
              <Text variant="h3" style={styles.stepperValue}>{qty}</Text>
              <Pressable onPress={() => setQtyDraft(q => q + 1)} hitSlop={14} style={styles.stepperBtn}>
                <Ionicons name="add" size={22} color={palette.textPrimary} />
              </Pressable>
            </View>
          </View>

          <View style={styles.question}>
            <Text variant="label" color="secondary">Prix</Text>
            <View style={styles.priceRow}>
              <TextInput
                ref={priceRef}
                style={[styles.inputLine, { flex: 1, color: palette.textPrimary, borderBottomColor: palette.border }]}
                placeholder="Prix unitaire"
                placeholderTextColor={palette.textDisabled}
                value={priceStr}
                onChangeText={v => setPriceStr(formatAmountInput(v, currency))}
                keyboardType="numeric"
                returnKeyType="done"
              />
              {priceStr.length > 0 && (
                <Text variant="body" color="secondary" style={styles.priceCurrency}>{currency}</Text>
              )}
            </View>
          </View>

          {total > 0 && (
            <Text variant="body" color="secondary">Total : {formatAmount(total, currency)}</Text>
          )}

          <View style={styles.payBlock}>
            <View style={styles.payChoices}>
              <Pressable onPress={() => setPayChoice('cash')} style={styles.payOption}>
                <Ionicons
                  name={payChoice === 'cash' ? 'radio-button-on' : 'radio-button-off'}
                  size={18}
                  color={payChoice === 'cash' ? palette.primary : palette.textDisabled}
                />
                <Text variant="body" color={payChoice === 'cash' ? 'primary' : 'secondary'}>Payé</Text>
              </Pressable>
              <Pressable onPress={() => setPayChoice('credit')} style={styles.payOption}>
                <Ionicons
                  name={payChoice === 'credit' ? 'radio-button-on' : 'radio-button-off'}
                  size={18}
                  color={payChoice === 'credit' ? palette.primary : palette.textDisabled}
                />
                <Text variant="body" color={payChoice === 'credit' ? 'primary' : 'secondary'}>Crédit</Text>
              </Pressable>
            </View>
            {payChoice === 'credit' && (
              <TextInput
                style={[styles.inputLine, { color: palette.textPrimary, borderBottomColor: palette.border }]}
                placeholder="Nom du client"
                placeholderTextColor={palette.textDisabled}
                value={customerName}
                onChangeText={setCustomerName}
                autoCapitalize="words"
              />
            )}
          </View>
        </ScrollView>

        <View style={styles.footer}>
          {error && (
            <Text variant="caption" color="danger" style={{ textAlign: 'center', marginBottom: spacing[2] }}>
              {error}
            </Text>
          )}
          <Button
            label="Enregistrer la vente"
            onPress={handleSave}
            loading={saving}
            disabled={!canSave}
            fullWidth
            size="lg"
          />
        </View>
      </KeyboardAvoidingView>
    </Screen>
  );
}

function makeStyles(p: Palette) {
  return StyleSheet.create({
    header: {
      flexDirection: 'row', alignItems: 'center', gap: spacing[4],
      paddingHorizontal: spacing[5], paddingTop: spacing[4], paddingBottom: spacing[5],
    },
    scroll: { paddingHorizontal: spacing[5], paddingBottom: spacing[6], gap: spacing[7] },
    question: { gap: spacing[2] },
    inputLine: {
      borderBottomWidth: 1,
      paddingVertical: spacing[3],
      fontSize: 17,
    },
    stepper: { flexDirection: 'row', alignItems: 'center', gap: spacing[6] },
    stepperBtn: {
      width: 44, height: 44, borderRadius: 22,
      alignItems: 'center', justifyContent: 'center',
      backgroundColor: p.surface,
    },
    stepperValue: { minWidth: 40, textAlign: 'center' },
    priceRow: { flexDirection: 'row', alignItems: 'flex-end', gap: spacing[3] },
    priceCurrency: { paddingBottom: spacing[3] },
    payBlock: { gap: spacing[4] },
    payChoices: { flexDirection: 'row', gap: spacing[6] },
    payOption: { flexDirection: 'row', alignItems: 'center', gap: spacing[2] },
    footer: {
      paddingHorizontal: spacing[5], paddingBottom: spacing[4], paddingTop: spacing[4],
    },
  });
}
