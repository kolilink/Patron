import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Animated, Easing, Keyboard, LayoutAnimation, Platform, Pressable, ScrollView, StyleSheet, Switch, TextInput, View } from 'react-native';
import ReAnimated, { FadeInDown } from 'react-native-reanimated';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { FormSheet } from '@/src/components/ui/FormSheet';
import { Button } from '@/src/components/ui/Button';
import { Text } from '@/src/components/ui/Text';
import { QuantityStepper } from '@/src/components/ui/QuantityStepper';
import { useTheme, spacing, fontFamily as FF } from '@/src/theme';
import type { Palette } from '@/src/theme';
import type { Product } from '@/src/types';
import type { Fournisseur } from '@/stores/fournisseurs';
import { haptics } from '@/lib/haptics';
import { useReduceMotion } from '@/src/hooks/useReduceMotion';
import { configureLayoutNext } from '@/src/hooks/useAnimateLayoutChange';
import { formatAmount, formatAmountInput } from '@/src/utils/format';
import {
  EMPTY_QUICK_ADD,
  addVariant,
  computeCostLine,
  derivedTotalPieces,
  nameValid,
  patchVariant,
  priceValid,
  removeVariant,
  setModels,
  suggestProducts,
  toQuickAddPayload,
  validateQuickAdd,
  type QuickAddPayload,
  type QuickAddState,
} from '@/src/utils/quickAddProduct';

interface Props {
  visible: boolean;
  onClose: () => void;
  /** Same save path as the full form (offline outbox, variants, undo banner). */
  onSubmit: (payload: QuickAddPayload) => Promise<void>;
  /** She tapped an existing product in the suggestions: open it, don't duplicate it. */
  onPickExisting: (product: Product) => void;
  saving: boolean;
  currency: string;
  products: Product[];
  fournisseurs: Fournisseur[];
  initialName?: string;
}

/** Checkmark that scales/fades in over ~200ms the moment its field becomes valid. */
function ValidCheck({ valid, color }: { valid: boolean; color: string }) {
  const reduce = useReduceMotion();
  const anim = useRef(new Animated.Value(valid ? 1 : 0)).current;
  useEffect(() => {
    if (reduce) { anim.setValue(valid ? 1 : 0); return; }
    Animated.timing(anim, { toValue: valid ? 1 : 0, duration: 200, easing: Easing.out(Easing.cubic), useNativeDriver: true }).start();
  }, [valid, reduce, anim]);
  return (
    <Animated.View
      pointerEvents="none"
      style={{ opacity: anim, transform: [{ scale: anim.interpolate({ inputRange: [0, 1], outputRange: [0.6, 1] }) }] }}
    >
      <Ionicons name="checkmark-circle" size={20} color={color} />
    </Animated.View>
  );
}

export function QuickAddProductSheet({
  visible, onClose, onSubmit, onPickExisting, saving, currency, products, fournisseurs, initialName,
}: Props) {
  const { palette } = useTheme();
  const styles = useMemo(() => makeStyles(palette), [palette]);
  const insets = useSafeAreaInsets();
  const reduce = useReduceMotion();

  const [s, setS] = useState<QuickAddState>(EMPTY_QUICK_ADD);
  const [expanded, setExpanded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const scrollRef = useRef<ScrollView>(null);
  const nameRef = useRef<TextInput>(null);
  const priceRef = useRef<TextInput>(null);
  const qtyRef = useRef<TextInput>(null);
  const purchaseRef = useRef<TextInput>(null);
  const feesRef = useRef<TextInput>(null);

  useEffect(() => {
    if (visible) {
      setS({ ...EMPTY_QUICK_ADD, name: initialName ?? '' });
      setExpanded(false);
      setError(null);
    }
  }, [visible, initialName]);

  const animate = useCallback(() => configureLayoutNext(LayoutAnimation.Presets.easeInEaseOut), []);

  const nameOk = nameValid(s);
  const priceOk = priceValid(s, currency);
  const suggestions = useMemo(() => suggestProducts(s.name, products), [s.name, products]);
  const cost = computeCostLine(s, currency);
  const totalPieces = derivedTotalPieces(s.variants);

  const toggleExpanded = () => {
    animate();
    const next = !expanded;
    setExpanded(next);
    haptics.toggle(next);
    if (next) setTimeout(() => scrollRef.current?.scrollToEnd({ animated: !reduce }), 120);
  };

  const onToggleModels = (on: boolean) => {
    animate();
    haptics.toggle(on);
    setError(null);
    setS(prev => setModels(prev, on));
  };

  const submit = async () => {
    const err = validateQuickAdd(s, currency);
    if (err) { setError(err); haptics.error(); return; }
    setError(null);
    await onSubmit(toQuickAddPayload(s, currency));
  };

  const priceLabel = s.models ? `Je vends à (prix de départ) · ${currency}` : `Je vends à · ${currency}`;
  const collapsedName = expanded && nameOk;
  const collapsedPrice = expanded && priceOk;

  const stagger = (i: number) => (reduce ? undefined : FadeInDown.delay(i * 60).duration(200));

  return (
    <FormSheet
      ref={scrollRef}
      visible={visible}
      onClose={onClose}
      onShow={() => nameRef.current?.focus()}
      title="Nouveau produit"
      contentContainerStyle={{ paddingBottom: 16 }}
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="on-drag"
      footer={
        <View style={[styles.footer, { paddingBottom: Math.max(insets.bottom, spacing[5]) }]}>
          <Button label="Ajouter" loadingLabel="Ajout" onPress={submit} loading={saving} fullWidth size="lg" />
        </View>
      }
    >
      {error && (
        <View style={styles.formError}>
          <Text variant="bodySmall" color="warning">{error}</Text>
        </View>
      )}

      {/* NOM */}
      {collapsedName ? (
        <Pressable style={styles.confirmedRow} onPress={() => { animate(); setExpanded(false); setTimeout(() => nameRef.current?.focus(), 60); }} accessibilityLabel="Modifier le nom">
          <Text style={styles.confirmedLabel}>Produit</Text>
          <Text style={styles.confirmedValue} numberOfLines={1}>{s.name.trim()}</Text>
          <ValidCheck valid color={palette.success} />
        </Pressable>
      ) : (
        <View style={styles.fieldBlock}>
          <View style={styles.labelRow}>
            <Text style={styles.fieldLabel}>Nom du produit</Text>
            <ValidCheck valid={nameOk} color={palette.success} />
          </View>
          <TextInput
            ref={nameRef}
            style={styles.fieldInput}
            value={s.name}
            onChangeText={v => { setError(null); setS(prev => ({ ...prev, name: v })); }}
            placeholder="Nom du produit"
            placeholderTextColor={palette.textDisabled}
            returnKeyType="next"
            blurOnSubmit={false}
            onSubmitEditing={() => priceRef.current?.focus()}
            autoFocus={false}
          />
          {suggestions.length > 0 && (
            <View style={styles.suggestions}>
              <Text style={styles.suggestionsHint}>Déjà dans votre catalogue</Text>
              {suggestions.map(p => (
                <Pressable
                  key={p.id}
                  style={({ pressed }) => [styles.suggestionRow, pressed && { opacity: 0.6 }]}
                  onPress={() => { haptics.select(); Keyboard.dismiss(); onPickExisting(p); }}
                  accessibilityRole="button"
                  accessibilityLabel={`Ouvrir ${p.name}`}
                >
                  <Text variant="body" style={{ flex: 1, fontFamily: FF.medium }} numberOfLines={1}>{p.name}</Text>
                  <Text variant="caption" color="secondary">{formatAmount(p.sale_price, currency)}</Text>
                </Pressable>
              ))}
            </View>
          )}
        </View>
      )}

      {/* MODÈLES */}
      <View style={styles.toggleRow}>
        <Text variant="body" color="secondary" style={{ flex: 1, fontFamily: FF.medium }}>Modèles</Text>
        <Switch
          value={s.models}
          onValueChange={onToggleModels}
          trackColor={{ false: palette.border, true: palette.primary }}
          thumbColor={palette.surface}
          accessibilityLabel="Modèles"
        />
      </View>

      {/* JE VENDS À */}
      {collapsedPrice ? (
        <Pressable style={styles.confirmedRow} onPress={() => { animate(); setExpanded(false); setTimeout(() => priceRef.current?.focus(), 60); }} accessibilityLabel="Modifier le prix">
          <Text style={styles.confirmedLabel}>{s.models ? 'Prix de départ' : 'Je vends à'}</Text>
          <Text style={styles.confirmedValue} numberOfLines={1}>{s.price} {currency}</Text>
          <ValidCheck valid color={palette.success} />
        </Pressable>
      ) : (
        <View style={styles.fieldBlock}>
          <View style={styles.labelRow}>
            <Text style={styles.fieldLabel}>{priceLabel}</Text>
            <ValidCheck valid={priceOk} color={palette.success} />
          </View>
          <TextInput
            ref={priceRef}
            style={styles.fieldInput}
            value={s.price}
            onChangeText={v => { setError(null); setS(prev => ({ ...prev, price: formatAmountInput(v, currency) })); }}
            keyboardType="decimal-pad"
            placeholderTextColor={palette.textDisabled}
            returnKeyType={s.models ? 'done' : 'next'}
            blurOnSubmit={false}
            onSubmitEditing={() => { if (s.models) Keyboard.dismiss(); else qtyRef.current?.focus(); }}
          />
        </View>
      )}

      {/* QUANTITÉ (Modèles OFF) or the model rows (Modèles ON) */}
      {!s.models ? (
        <View style={styles.fieldBlock}>
          <Text style={styles.fieldLabel}>Quantité</Text>
          <View style={styles.qtyRow}>
            <View style={{ flex: 1 }}>
              <QuantityStepper
                value={s.qty}
                onChange={v => setS(prev => ({ ...prev, qty: v }))}
                inputRef={qtyRef}
                inputStyle={styles.fieldInput}
                returnKeyType="done"
                onSubmitEditing={() => Keyboard.dismiss()}
              />
            </View>
            <Text style={styles.unitTag}>pièces</Text>
          </View>
        </View>
      ) : (
        <View style={styles.variantList}>
          <View style={styles.variantHeader}>
            <Text style={[styles.fieldLabel, { flex: 1.3 }]}>Modèle</Text>
            <Text style={[styles.fieldLabel, { width: 60, textAlign: 'right' }]}>Qté</Text>
            <Text style={[styles.fieldLabel, { flex: 1.2, minWidth: 110, textAlign: 'right' }]}>Prix</Text>
            <View style={{ width: 28 }} />
          </View>
          {s.variants.map((v, i) => {
            // Untouched rows show the starting price as a quiet "prefilled" value.
            const shown = v.touched ? v.price : s.price;
            return (
              <ReAnimated.View key={v.key} entering={stagger(i)} style={styles.variantRow}>
                <TextInput
                  style={[styles.fieldInput, { flex: 1.3, fontSize: 17 }]}
                  value={v.name}
                  onChangeText={t => { setError(null); setS(prev => patchVariant(prev, v.key, { name: t })); }}
                  placeholder="S, M, Rouge…"
                  placeholderTextColor={palette.textDisabled}
                />
                <TextInput
                  style={[styles.fieldInput, { width: 60, textAlign: 'right', fontSize: 17 }]}
                  value={v.qty}
                  onChangeText={t => setS(prev => patchVariant(prev, v.key, { qty: t.replace(/[^\d]/g, '') }))}
                  keyboardType="number-pad"
                  placeholder="0"
                  placeholderTextColor={palette.textDisabled}
                />
                <TextInput
                  style={[
                    styles.fieldInput,
                    { flex: 1.2, minWidth: 110, textAlign: 'right', fontSize: 17 },
                    !v.touched && { color: palette.textSecondary },
                  ]}
                  value={shown}
                  onChangeText={t => setS(prev => patchVariant(prev, v.key, { price: formatAmountInput(t, currency) }))}
                  keyboardType="decimal-pad"
                  placeholder="0"
                  placeholderTextColor={palette.textDisabled}
                  accessibilityHint={v.touched ? undefined : 'Prix de départ, modifiable'}
                />
                <Pressable
                  onPress={() => { animate(); setS(prev => removeVariant(prev, v.key)); }}
                  hitSlop={10}
                  style={{ width: 28, alignItems: 'flex-end' }}
                  accessibilityLabel="Retirer ce modèle"
                  accessibilityRole="button"
                >
                  <Ionicons name="close-circle" size={20} color={palette.textDisabled} />
                </Pressable>
              </ReAnimated.View>
            );
          })}
          <Pressable
            style={styles.addVariant}
            onPress={() => { animate(); haptics.select(); setS(prev => addVariant(prev)); }}
            accessibilityRole="button"
          >
            <Ionicons name="add-circle-outline" size={18} color={palette.primary} />
            <Text variant="label" style={{ color: palette.primary, marginLeft: 4 }}>Ajouter un modèle</Text>
          </Pressable>
          <Text style={styles.derived}>Total : {totalPieces} pièce{totalPieces > 1 ? 's' : ''}</Text>
        </View>
      )}

      {/* PLUS D'INFORMATIONS */}
      <Pressable onPress={toggleExpanded} style={styles.moreBtn} accessibilityRole="button" accessibilityState={{ expanded }}>
        <Text variant="body" style={{ color: palette.primary }}>Plus d'informations</Text>
        <Ionicons name={expanded ? 'chevron-up' : 'chevron-down'} size={16} color={palette.primary} style={{ marginLeft: 6 }} />
      </Pressable>

      {expanded && (
        <ReAnimated.View entering={reduce ? undefined : FadeInDown.duration(200)}>
          <View style={styles.fieldBlock}>
            <Text style={styles.fieldLabel}>{`Coût · prix d'achat unitaire (${currency})`}</Text>
            <TextInput
              ref={purchaseRef}
              style={styles.fieldInput}
              value={s.purchasePrice}
              onChangeText={v => setS(prev => ({ ...prev, purchasePrice: formatAmountInput(v, currency) }))}
              keyboardType="decimal-pad"
              placeholderTextColor={palette.textDisabled}
              returnKeyType="next"
              blurOnSubmit={false}
              onSubmitEditing={() => feesRef.current?.focus()}
            />
          </View>
          <View style={styles.fieldBlock}>
            <Text style={styles.fieldLabel}>{`Frais (transport, etc.) · ${currency}`}</Text>
            <TextInput
              ref={feesRef}
              style={styles.fieldInput}
              value={s.fees}
              onChangeText={v => setS(prev => ({ ...prev, fees: formatAmountInput(v, currency) }))}
              keyboardType="decimal-pad"
              placeholderTextColor={palette.textDisabled}
            />
          </View>
          {cost && (
            <View style={styles.costLine}>
              <Text style={[styles.costText, { color: cost.profit != null && cost.profit < 0 ? palette.warning : palette.success }]}>
                {`Coût réel par pièce : ${formatAmount(cost.unitCost, currency)}`}
                {cost.profit != null
                  ? cost.profit >= 0
                    ? ` · Vous gagnez ${formatAmount(cost.profit, currency)}`
                    : ` · Vous perdez ${formatAmount(-cost.profit, currency)}`
                  : ''}
              </Text>
            </View>
          )}
          <View style={styles.fieldBlock}>
            <Text style={styles.fieldLabel}>Fournisseur</Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} keyboardShouldPersistTaps="handled" contentContainerStyle={{ gap: spacing[2], paddingVertical: spacing[1] }}>
              {[{ id: '', name: 'Marché' }, ...fournisseurs.map(f => ({ id: f.id, name: f.name }))].map(opt => {
                const active = s.supplierId === opt.id;
                return (
                  <Pressable
                    key={opt.id || 'marche'}
                    onPress={() => { haptics.select(); setS(prev => ({ ...prev, supplierId: opt.id })); }}
                    style={[styles.chip, active && styles.chipActive]}
                    accessibilityRole="button"
                    accessibilityState={{ selected: active }}
                  >
                    <Text variant="label" style={{ color: active ? palette.textInverse : palette.textPrimary }}>{opt.name}</Text>
                  </Pressable>
                );
              })}
            </ScrollView>
          </View>
        </ReAnimated.View>
      )}
    </FormSheet>
  );
}

function makeStyles(p: Palette) {
  // Soft rounded card; whitespace (not hairlines) separates groups.
  const card = { backgroundColor: p.surface, borderRadius: 16, marginHorizontal: spacing[4], marginTop: spacing[3] } as const;
  return StyleSheet.create({
    footer: { padding: spacing[5], backgroundColor: p.background },
    formError: { backgroundColor: p.warningLight, borderRadius: 12, padding: spacing[3], marginHorizontal: spacing[4], marginTop: spacing[3] },
    fieldBlock: { ...card, paddingHorizontal: spacing[4], paddingVertical: spacing[3], gap: spacing[1.5] },
    labelRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
    fieldLabel: {
      fontFamily: FF.semibold, fontSize: 11, color: p.textSecondary,
      letterSpacing: 0.6, textTransform: 'uppercase',
    },
    fieldInput: { fontFamily: FF.semibold, fontSize: 22, color: p.textPrimary, paddingVertical: 0, minHeight: 36 },
    confirmedRow: { ...card, flexDirection: 'row', alignItems: 'center', gap: spacing[3], paddingHorizontal: spacing[4], paddingVertical: spacing[3.5] },
    confirmedLabel: { fontFamily: FF.semibold, fontSize: 11, color: p.textSecondary, letterSpacing: 0.6, textTransform: 'uppercase', width: 96 },
    confirmedValue: { flex: 1, fontFamily: FF.semibold, fontSize: 17, color: p.textPrimary },
    toggleRow: { ...card, flexDirection: 'row', alignItems: 'center', paddingHorizontal: spacing[4], paddingVertical: spacing[2] },
    qtyRow: { flexDirection: 'row', alignItems: 'center', gap: spacing[3] },
    unitTag: { fontFamily: FF.medium, fontSize: 15, color: p.textSecondary },
    suggestions: { marginTop: spacing[1], gap: 2 },
    suggestionsHint: { fontFamily: FF.medium, fontSize: 12, color: p.textSecondary, marginBottom: 2 },
    suggestionRow: {
      flexDirection: 'row', alignItems: 'center', gap: spacing[3],
      paddingVertical: spacing[2], paddingHorizontal: spacing[3],
      borderRadius: 10, backgroundColor: p.surface,
    },
    variantList: { marginTop: spacing[3] },
    variantHeader: { flexDirection: 'row', alignItems: 'center', gap: spacing[2], paddingHorizontal: spacing[7], paddingBottom: spacing[1.5] },
    variantRow: { ...card, flexDirection: 'row', alignItems: 'center', gap: spacing[2], paddingHorizontal: spacing[4], paddingVertical: spacing[2.5], marginTop: spacing[2] },
    addVariant: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: spacing[5], paddingVertical: spacing[3] },
    derived: { fontFamily: FF.medium, fontSize: 14, color: p.textSecondary, paddingHorizontal: spacing[5] },
    moreBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', paddingVertical: spacing[4] },
    costLine: { paddingHorizontal: spacing[5], paddingVertical: spacing[3] },
    costText: { fontFamily: FF.medium, fontSize: 14 },
    chip: {
      paddingHorizontal: spacing[3.5], paddingVertical: spacing[2], borderRadius: 999,
      borderWidth: 1, borderColor: p.border, backgroundColor: p.surface,
    },
    chipActive: { backgroundColor: p.textPrimary, borderColor: p.textPrimary },
  });
}
