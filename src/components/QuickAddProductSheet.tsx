import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Animated, Easing, Keyboard, Platform, Pressable, ScrollView, StyleSheet, Switch, TextInput, View } from 'react-native';
import ReAnimated, { FadeIn, FadeInDown, FadeOut, LinearTransition } from 'react-native-reanimated';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { GestureSheet } from '@/src/components/ui/GestureSheet';
import { Button } from '@/src/components/ui/Button';
import { Text } from '@/src/components/ui/Text';
import { QuantityStepper } from '@/src/components/ui/QuantityStepper';
import { useKeyboardVisible } from '@/src/hooks/useKeyboardVisible';
import { useTheme, spacing, fontFamily as FF } from '@/src/theme';
import type { Palette } from '@/src/theme';
import type { Product, ProductVariant } from '@/src/types';
import type { Fournisseur } from '@/stores/fournisseurs';
import { haptics } from '@/lib/haptics';
import { useReduceMotion } from '@/src/hooks/useReduceMotion';
import { SilentKeyboardAccessory } from '@/src/components/ui/SilentKeyboardAccessory';
import { formatAmount, formatAmountInput } from '@/src/utils/format';
import { editDraftId, newDraftId, removeQuickAddDraft, saveQuickAddDraft, type QuickAddDraft } from '@/lib/quickAddDraft';
import { isKnownOffline, useConnectivityStore } from '@/lib/connectivity';
import {
  EMPTY_QUICK_ADD,
  afterAdd,
  canSubmit,
  editingToState,
  isBlankDraft,
  addVariant,
  computeCostLine,
  derivedTotalPieces,
  nameValid,
  isEditDirty,
  patchVariant,
  priceValid,
  removeVariant,
  setModels,
  suggestProducts,
  toQuickAddPayload,
  type QuickAddPayload,
  type QuickAddState,
} from '@/src/utils/quickAddProduct';

interface Props {
  visible: boolean;
  onClose: () => void;
  /** Add: createProduct via the outbox (sheet stays open). Edit: updateProduct (host closes the sheet on ok). */
  onSubmit: (payload: QuickAddPayload) => Promise<{ ok: boolean }>;
  /** She tapped an existing product in the suggestions: open it, don't duplicate it. */
  onPickExisting: (product: Product) => void;
  saving: boolean;
  currency: string;
  products: Product[];
  fournisseurs: Fournisseur[];
  initialName?: string;
  /** Scopes the local-only "À compléter" drafts. */
  businessId: string;
  /** Edit mode: the stored product (the sheet becomes "Modifier le produit" and closes on save). */
  editing?: Product | null;
  initialVariants?: ProductVariant[];
  /** Edit mode: open with "Plus d'informations" already expanded (the "Prix d'achat ?" affordance). */
  startExpanded?: boolean;
  /** Edit mode: stock is shown as a fact; this opens the entrée/perte sheet. */
  onAdjust?: (product: Product) => void;
  /**
   * Delivery mode (opened from a reception line): name and quantity are prefilled from the line,
   * "Je vends à" starts empty and is REQUIRED, and there is no cost section — the line owns the unit
   * cost and the reception books both cost and stock at confirm. Closes on Ajouter (no loop, no draft).
   */
  delivery?: { name: string; qty: string } | null;
  /**
   * Supplier context (opened from the supplier form). `undefined` = none. Otherwise the "Fournisseur"
   * chips are hidden and the product is born with this supplier: a string bakes it into the product,
   * `null` means the supplier is not saved yet (the supplier save links the product). Closes on Ajouter.
   */
  supplierId?: string | null;
  /** Edit mode: the sheet owns archiving and restoring (Gérer rows have no buttons of their own). */
  onArchive?: (product: Product) => void;
  onRestore?: (product: Product) => void;
  /** Edit mode: opens the profitability ("Rentabilité") sheet. */
  onStats?: (product: Product) => void;
  /** Reopen an "À compléter" draft instead of starting fresh. */
  resumeDraft?: QuickAddDraft | null;
  /** Edit mode: restore this saved edit draft (kind 'edit', same product) instead of the stored product. */
  resumeEditDraft?: QuickAddDraft | null;
}

// Number pads have no return key on iOS, so the OS injects its own "Next/Done" pill above them
// unless a linked accessory claims the slot. This one is zero-height and shows nothing.
const SILENT_ID = 'quick-add-product-silent-accessory';
const IOS_SILENT = Platform.OS === 'ios' ? SILENT_ID : undefined;

const AnimatedPressable = ReAnimated.createAnimatedComponent(Pressable);

/**
 * Money field. Empty → no currency anywhere. The moment digits exist, a non-editable gray
 * lowercase currency fades in right AFTER the number ("1000 gnf"). Never used for quantities.
 */
function MoneyInput({ currency, style, inputRef, value, ...rest }: React.ComponentProps<typeof TextInput> & { currency: string; inputRef?: React.Ref<TextInput> }) {
  const { palette } = useTheme();
  const reduce = useReduceMotion();
  const flat = (StyleSheet.flatten(style) ?? {}) as { fontSize?: number; fontFamily?: string; textAlign?: string; flex?: number; minWidth?: number };
  const has = typeof value === 'string' && value.length > 0;
  const unit = currency.toLowerCase();
  const fontSize = flat.fontSize ?? 22;
  const unitSize = Math.max(fontSize - 6, 12);
  const fade = reduce ? undefined : FadeIn.duration(180);

  if (flat.textAlign === 'right') {
    return (
      <View style={{ flexDirection: 'row', alignItems: 'center', flex: flat.flex, minWidth: flat.minWidth }}>
        <TextInput ref={inputRef} value={value} inputAccessoryViewID={IOS_SILENT} {...rest} style={[style, { flex: 1, minWidth: 0 }]} />
        {has && (
          <ReAnimated.Text entering={fade} style={{ fontFamily: FF.medium, fontSize: unitSize, color: palette.textSecondary, marginLeft: 4 }}>{unit}</ReAnimated.Text>
        )}
      </View>
    );
  }
  return (
    <View style={{ justifyContent: 'center' }}>
      <TextInput ref={inputRef} value={value} inputAccessoryViewID={IOS_SILENT} {...rest} style={style} />
      {has && (
        // Overlay: a transparent copy of the typed number (same font → same width) pushes the unit
        // to sit directly after the digits. Purely visual, never intercepts touches.
        <ReAnimated.View entering={fade} pointerEvents="none" style={[StyleSheet.absoluteFill, { justifyContent: 'center' }]}>
          <Text numberOfLines={1} style={{ fontFamily: flat.fontFamily, fontSize, color: 'transparent' }}>
            {value}
            <Text style={{ fontFamily: FF.medium, fontSize: unitSize, color: palette.textSecondary }}>{` ${unit}`}</Text>
          </Text>
        </ReAnimated.View>
      )}
    </View>
  );
}

/** A card that glides when siblings above it change height. Scoped to the scroll content only. */
function Card({ style, children }: { style?: React.ComponentProps<typeof View>['style']; children: React.ReactNode }) {
  const reduce = useReduceMotion();
  return <ReAnimated.View layout={reduce ? undefined : LinearTransition.duration(220)} style={style}>{children}</ReAnimated.View>;
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
  visible, onClose, onSubmit, onPickExisting, saving, currency, products, fournisseurs, initialName, businessId,
  editing, initialVariants, startExpanded, onAdjust, resumeDraft, resumeEditDraft, delivery, supplierId,
  onArchive, onRestore, onStats,
}: Props) {
  const isEdit = !!editing;
  const isDelivery = !!delivery && !editing;
  // Drafts are for the rapid add loop only.
  // Models are saved by an online-only call: while offline they can't be created or changed.
  const offline = useConnectivityStore(() => isKnownOffline());
  const supplierCtx = supplierId !== undefined && !editing;
  const noDraft = isEdit || isDelivery;
  const { palette } = useTheme();
  const styles = useMemo(() => makeStyles(palette), [palette]);
  const insets = useSafeAreaInsets();
  const reduce = useReduceMotion();
  // With the keyboard up there is no home indicator to clear: the footer sits flush on the keyboard.
  const keyboardUp = useKeyboardVisible();

  const [s, setS] = useState<QuickAddState>(EMPTY_QUICK_ADD);
  const [expanded, setExpanded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toastName, setToastName] = useState<string | null>(null);
  const fade = useRef(new Animated.Value(1)).current;
  const sRef = useRef(s);
  sRef.current = s;
  const draftId = useRef(newDraftId());
  const added = useRef(false);
  const submitting = useRef(false);
  const editDraftSaved = useRef(false); // this session wrote an edit draft
  const editSubmitted = useRef(false);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const scrollRef = useRef<ScrollView>(null);
  const nameRef = useRef<TextInput>(null);
  const priceRef = useRef<TextInput>(null);
  const qtyRef = useRef<TextInput>(null);
  const purchaseRef = useRef<TextInput>(null);
  const feesRef = useRef<TextInput>(null);

  // Initialise whenever the sheet opens. The sheet slides up from off-screen (GestureSheet), so this
  // swap is never visible. Add mode opens FRESH (or resumes an "À compléter" draft the host hands in);
  // edit mode loads the stored product.
  useEffect(() => {
    if (!visible) return;
    added.current = false;
    setError(null);
    if (editing) {
      const resumeEdit = resumeEditDraft && resumeEditDraft.kind === 'edit' && resumeEditDraft.productId === editing.id ? resumeEditDraft : null;
      editDraftSaved.current = !!resumeEdit;
      editSubmitted.current = false;
      setS(resumeEdit ? resumeEdit.state : editingToState(editing, initialVariants ?? [], currency));
      setExpanded(!!startExpanded);
      return;
    }
    if (delivery) {
      setS({ ...EMPTY_QUICK_ADD, name: delivery.name, qty: delivery.qty.trim() || '1' });
      setExpanded(false);
      // Name and quantity are known; the price is what is missing.
      const t = setTimeout(() => priceRef.current?.focus(), 340);
      return () => clearTimeout(t);
    }
    if (resumeDraft) {
      draftId.current = resumeDraft.id;
      setS(resumeDraft.state);
    } else {
      draftId.current = newDraftId();
      setS({ ...EMPTY_QUICK_ADD, name: initialName ?? '' });
    }
    setExpanded(false);
    const t = setTimeout(() => nameRef.current?.focus(), 340);
    return () => clearTimeout(t);
  }, [visible, editing?.id, resumeEditDraft?.id, resumeDraft?.id, initialName, delivery?.name, delivery?.qty]);

  // Edit mode: a variant product's models arrive asynchronously after the sheet opens.
  useEffect(() => {
    if (!visible || !editing?.has_variants || !initialVariants?.length) return;
    setS(prev => (prev.variants.length > 0 ? prev : { ...prev, models: true, variants: editingToState(editing, initialVariants, currency).variants }));
  }, [visible, editing?.id, initialVariants]);

  // "À compléter": keep what is half-filled (debounced) so a swipe-down, Annuler or app kill never loses it.
  // Add mode only; a blank sheet removes its own draft. Never synced, never in the outbox.
  useEffect(() => {
    if (!visible || noDraft || supplierCtx) return;
    const t = setTimeout(() => { void saveQuickAddDraft(businessId, draftId.current, s).catch(() => {}); }, 400); // failure: silent — draft is best-effort
    return () => clearTimeout(t);
  }, [s, visible, noDraft, supplierCtx, businessId]);

  // Edit drafts: unsaved changes to an existing product land in "À compléter" too (one per product).
  // A clean sheet saves nothing; reverting every change takes back the draft this session wrote.
  const editDirty = isEdit && editing ? isEditDirty(s, editingToState(editing, initialVariants ?? [], currency)) : false;
  const editDirtyRef = useRef(editDirty);
  editDirtyRef.current = editDirty;
  useEffect(() => {
    if (!visible || !isEdit || !editing || editSubmitted.current) return;
    const productId = editing.id;
    if (!editDirty) {
      if (editDraftSaved.current) {
        editDraftSaved.current = false;
        void removeQuickAddDraft(businessId, editDraftId(productId)).catch(() => {}); // failure: silent — draft is best-effort
      }
      return;
    }
    const t = setTimeout(() => {
      if (editSubmitted.current) return;
      editDraftSaved.current = true;
      void saveQuickAddDraft(businessId, editDraftId(productId), s, { productId }).catch(() => {}); // failure: silent — draft is best-effort
    }, 400);
    return () => clearTimeout(t);
  }, [s, visible, isEdit, editing?.id, editDirty, businessId]);

  const handleClose = () => {
    if (isEdit && editing && editDirtyRef.current && !editSubmitted.current) {
      editDraftSaved.current = true;
      void saveQuickAddDraft(businessId, editDraftId(editing.id), sRef.current, { productId: editing.id }).catch(() => {}); // failure: silent — draft is best-effort
    }
    if (!noDraft && !supplierCtx && !added.current) void saveQuickAddDraft(businessId, draftId.current, sRef.current).catch(() => {}); // failure: silent — draft is best-effort
    onClose();
  };

  useEffect(() => () => { if (toastTimer.current) clearTimeout(toastTimer.current); }, []);

  // Lower fields: keep the focused one above the keyboard (footer stays put; content scrolls).
  const revealFocused = () => { setTimeout(() => scrollRef.current?.scrollToEnd({ animated: !reduce }), 250); };

  const nameOk = nameValid(s);
  const priceOk = priceValid(s, currency);
  const suggestions = useMemo(() => suggestProducts(s.name, products), [s.name, products]);
  const cost = computeCostLine(s, currency);
  const totalPieces = derivedTotalPieces(s.variants);

  const toggleExpanded = () => {
    const next = !expanded;
    setExpanded(next);
    haptics.toggle(next);
    if (next) setTimeout(() => scrollRef.current?.scrollToEnd({ animated: !reduce }), 120);
  };

  // Going offline with Modèles already on (toggle, resumed draft): models can't be saved, so switch them off
  // instead of letting the add succeed with them silently dropped.
  useEffect(() => {
    if (offline && !isEdit && s.models) setS(prev => setModels(prev, false));
  }, [offline, isEdit, s.models]);

  const onToggleModels = (on: boolean) => {
    haptics.toggle(on);
    setError(null);
    setS(prev => setModels(prev, on));
  };

  const showToast = (name: string) => {
    setToastName(name);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToastName(null), 2200);
  };

  // The rapid loop: the sheet stays open, fields fade-clear, Nom is focused again (keyboard never
  // dismisses). Quantité is sticky; everything else — notably the price — is cleared.
  const resetForNext = () => {
    const apply = () => {
      setS(prev => afterAdd(prev));
      setExpanded(false);
      setError(null);
      // This product is saved: its draft is done; the next entry is a new draft.
      void removeQuickAddDraft(businessId, draftId.current).catch(() => {}); // failure: silent — draft is best-effort
      draftId.current = newDraftId();
      requestAnimationFrame(() => {
        nameRef.current?.focus();
        if (reduce) fade.setValue(1);
        else Animated.timing(fade, { toValue: 1, duration: 130, useNativeDriver: true }).start();
      });
    };
    if (reduce) { apply(); return; }
    Animated.timing(fade, { toValue: 0, duration: 120, useNativeDriver: true }).start(apply);
  };

  const submit = async () => {
    if (!canSubmit(s) || (isDelivery && !priceValid(s, currency)) || submitting.current) return;
    submitting.current = true;
    setError(null);
    const name = s.name.trim();
    const payload = toQuickAddPayload(
      s, currency,
      editing ? { reorder_level: editing.reorder_level, unit: editing.unit, cost_price: editing.cost_price } : undefined,
      { delivery: isDelivery },
    );
    if (supplierCtx && supplierId) payload.data.supplier_id = supplierId;
    const res = await onSubmit(payload);
    submitting.current = false;
    if (!res.ok) return; // the failure alert is shown by the host; everything typed stays
    haptics.success();
    if (isEdit && editing) {
      editSubmitted.current = true; // no autosave may resurrect it
      editDraftSaved.current = false;
      void removeQuickAddDraft(businessId, editDraftId(editing.id)).catch(() => {}); // failure: silent — draft is best-effort
    }
    if (isEdit || isDelivery) return; // edit / delivery: the host closes the sheet and confirms
    if (supplierCtx) return; // supplier form: the host links the product and closes the sheet
    added.current = true;
    showToast(name);
    resetForNext();
  };

  const collapsedName = expanded && nameOk;
  const collapsedPrice = expanded && priceOk;

  const stagger = (i: number) => (reduce ? undefined : FadeInDown.delay(i * 60).duration(200));

  return (
    <GestureSheet
      ref={scrollRef}
      visible={visible}
      onClose={handleClose}
      title={isEdit ? 'Modifier le produit' : 'Nouveau produit'}
      contentContainerStyle={{ paddingBottom: 16 }}
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="on-drag"
      accessory={
        <>
          <SilentKeyboardAccessory nativeID={SILENT_ID} />
          {toastName != null && (
            <ReAnimated.View
              pointerEvents="none"
              entering={reduce ? undefined : FadeInDown.duration(200)}
              exiting={reduce ? undefined : FadeOut.duration(200)}
              style={styles.toast}
            >
              <Ionicons name="checkmark-circle" size={18} color={palette.success} />
              <Text style={styles.toastText} numberOfLines={1}>{`${toastName} ajouté`}</Text>
            </ReAnimated.View>
          )}
        </>
      }
      footer={
        <View style={[styles.footer, { paddingBottom: keyboardUp ? spacing[3] : Math.max(insets.bottom, spacing[5]) }]}>
          <Button label={isEdit ? 'Enregistrer' : 'Ajouter'} loadingLabel={isEdit ? 'Enregistrement' : 'Ajout'} onPress={submit} loading={saving} disabled={!canSubmit(s) || (isDelivery && !priceValid(s, currency))} fullWidth size="lg" />
        </View>
      }
    >
      <Animated.View style={{ opacity: fade }}>
      {error && (
        <View style={styles.formError}>
          <Text variant="bodySmall" color="warning">{error}</Text>
        </View>
      )}

      {/* NOM */}
      {collapsedName ? (
        <AnimatedPressable entering={reduce ? undefined : FadeIn.duration(180)} layout={reduce ? undefined : LinearTransition.duration(220)} style={styles.confirmedRow} onPress={() => { setExpanded(false); setTimeout(() => nameRef.current?.focus(), 60); }} accessibilityLabel="Modifier le nom">
          <Text style={styles.confirmedLabel}>Produit</Text>
          <Text style={styles.confirmedValue} numberOfLines={1}>{s.name.trim()}</Text>
          <ValidCheck valid color={palette.success} />
        </AnimatedPressable>
      ) : (
        <Card style={styles.fieldBlock}>
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
          {!isEdit && suggestions.length > 0 && (
            <View style={styles.suggestions}>
              <Text style={styles.suggestionsHint}>Déjà dans vos produits</Text>
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
        </Card>
      )}

      {/* MODÈLES — saved by an online-only call. Offline: never offered when adding (nothing is silently
          dropped); when editing, the section is disabled with an honest note. */}
      {offline && isEdit ? (
        <Card style={styles.toggleRow}>
          <Text variant="body" color="secondary" style={{ flex: 1, fontFamily: FF.medium }}>Modèles : connexion requise</Text>
          <Switch value={s.models} disabled trackColor={{ false: palette.border, true: palette.primary }} thumbColor={palette.surface} accessibilityLabel="Modèles" />
        </Card>
      ) : !offline && (
      <Card style={styles.toggleRow}>
        <Text variant="body" color="secondary" style={{ flex: 1, fontFamily: FF.medium }}>Modèles</Text>
        <Switch
          value={s.models}
          onValueChange={onToggleModels}
          trackColor={{ false: palette.border, true: palette.primary }}
          thumbColor={palette.surface}
          accessibilityLabel="Modèles"
        />
      </Card>
      )}

      {/* JE VENDS À */}
      {collapsedPrice ? (
        <AnimatedPressable entering={reduce ? undefined : FadeIn.duration(180)} layout={reduce ? undefined : LinearTransition.duration(220)} style={styles.confirmedRow} onPress={() => { setExpanded(false); setTimeout(() => priceRef.current?.focus(), 60); }} accessibilityLabel="Modifier le prix">
          <Text style={styles.confirmedLabel}>{s.models ? 'Prix de départ' : 'Je vends à'}</Text>
          <Text style={styles.confirmedValue} numberOfLines={1}>{s.price} {currency.toLowerCase()}</Text>
          <ValidCheck valid color={palette.success} />
        </AnimatedPressable>
      ) : (
        <Card style={styles.fieldBlock}>
          <View style={styles.labelRow}>
            <Text style={styles.fieldLabel}>Je vends à</Text>
            <ValidCheck valid={priceOk} color={palette.success} />
          </View>
          <MoneyInput currency={currency}
            inputRef={priceRef}
            style={styles.fieldInput}
            value={s.price}
            onChangeText={v => { setError(null); setS(prev => ({ ...prev, price: formatAmountInput(v, currency) })); }}
            keyboardType="decimal-pad"
            placeholderTextColor={palette.textDisabled}
            returnKeyType={s.models ? 'done' : 'next'}
            blurOnSubmit={false}
            onSubmitEditing={() => { if (s.models) Keyboard.dismiss(); else qtyRef.current?.focus(); }}
          />
        </Card>
      )}

      {/* QUANTITÉ (Modèles OFF) or the model rows (Modèles ON) */}
      {!s.models && isEdit && editing ? (
        // Edit: the stock is a FACT (it has a movement history); changing it goes through "Ajuster"
        // (entrée / perte + note) so nothing is silently rewritten here.
        <Card style={styles.fieldBlock}>
          <Text style={styles.fieldLabel}>Stock</Text>
          <View style={styles.qtyRow}>
            <Text style={[styles.fieldInput, { flex: 1 }]}>{s.qty}</Text>
            {onAdjust && (
              <Pressable onPress={() => onAdjust(editing)} hitSlop={10} accessibilityRole="button" accessibilityLabel="Ajuster le stock">
                <Text variant="label" style={{ color: palette.primary }}>Ajuster</Text>
              </Pressable>
            )}
          </View>
        </Card>
      ) : !s.models ? (
        <Card style={styles.fieldBlock}>
          <Text style={styles.fieldLabel}>Quantité</Text>
          <View style={styles.qtyRow}>
            <View style={{ flex: 1 }}>
              <QuantityStepper
                value={s.qty}
                onChange={v => setS(prev => ({ ...prev, qty: v }))}
                inputRef={qtyRef}
                compact
                inputAccessoryViewID={SILENT_ID}
                onFocus={revealFocused}
                inputStyle={styles.fieldInput}
                returnKeyType="done"
                onSubmitEditing={() => Keyboard.dismiss()}
              />
            </View>
          </View>
        </Card>
      ) : (
        <View pointerEvents={offline ? 'none' : 'auto'} style={offline ? { opacity: 0.5 } : undefined}>
        <Card style={styles.variantList}>
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
              <ReAnimated.View key={v.key} entering={stagger(i)} layout={reduce ? undefined : LinearTransition.duration(220)} style={styles.variantRow}>
                <TextInput
                  style={[styles.fieldInput, { flex: 1.3, fontSize: 17 }]}
                  value={v.name}
                  onChangeText={t => { setError(null); setS(prev => patchVariant(prev, v.key, { name: t })); }}
                  placeholder="Ex : S"
                  placeholderTextColor={palette.textDisabled}
                />
                {v.locked ? (
                  <Text style={[styles.fieldInput, { width: 60, textAlign: 'right', fontSize: 17, color: palette.textSecondary }]}>{v.qty}</Text>
                ) : (
                  <TextInput
                    style={[styles.fieldInput, { width: 60, textAlign: 'right', fontSize: 17 }]}
                    value={v.qty}
                    onChangeText={t => setS(prev => patchVariant(prev, v.key, { qty: t.replace(/[^\d]/g, '') }))}
                    keyboardType="number-pad"
                    placeholder="0"
                    placeholderTextColor={palette.textDisabled}
                    inputAccessoryViewID={IOS_SILENT}
                    onFocus={revealFocused}
                  />
                )}
                <MoneyInput currency={currency}
                  style={[
                    styles.fieldInput,
                    { flex: 1.2, minWidth: 120, textAlign: 'right', fontSize: 17 },
                    !v.touched && { color: palette.textSecondary },
                  ]}
                  value={shown}
                  onChangeText={t => setS(prev => patchVariant(prev, v.key, { price: formatAmountInput(t, currency) }))}
                  keyboardType="decimal-pad"
                  placeholderTextColor={palette.textDisabled}
                  onFocus={revealFocused}
                  accessibilityHint={v.touched ? undefined : 'Prix de départ, modifiable'}
                />
                <Pressable
                  onPress={() => { setS(prev => removeVariant(prev, v.key)); }}
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
            onPress={() => { haptics.select(); setS(prev => addVariant(prev)); }}
            accessibilityRole="button"
          >
            <Ionicons name="add-circle-outline" size={18} color={palette.primary} />
            <Text variant="label" style={{ color: palette.primary, marginLeft: 4 }}>Ajouter un modèle</Text>
          </Pressable>
          <Text style={styles.derived}>Total : {totalPieces}</Text>
        </Card>
        </View>
      )}

      {/* PLUS D'INFORMATIONS — not in delivery mode: the line already owns the unit cost */}
      {!isDelivery && (
      <Pressable onPress={toggleExpanded} style={styles.moreBtn} accessibilityRole="button" accessibilityState={{ expanded }}>
        <Text variant="body" style={{ color: palette.primary }}>Plus d'informations</Text>
        <Ionicons name={expanded ? 'chevron-up' : 'chevron-down'} size={16} color={palette.primary} style={{ marginLeft: 6 }} />
      </Pressable>
      )}

      {/* Edit mode: this sheet owns everything about the product — archive / restore / profitability. */}
      {isEdit && editing && (onStats || onArchive || onRestore) && (
        <View style={styles.manageBlock}>
          {onStats && !editing.archived && (
            <Pressable onPress={() => onStats(editing)} style={styles.manageRow} accessibilityRole="button">
              <Text variant="body" style={{ color: palette.primary }}>Voir la rentabilité</Text>
            </Pressable>
          )}
          {editing.archived ? (
            onRestore && (
              <Pressable onPress={() => onRestore(editing)} style={styles.manageRow} accessibilityRole="button" accessibilityLabel="Restaurer ce produit">
                <Text variant="body" style={{ color: palette.primary, fontFamily: FF.semibold }}>Restaurer ce produit</Text>
              </Pressable>
            )
          ) : (
            onArchive && (
              <Pressable onPress={() => onArchive(editing)} style={styles.manageRow} accessibilityRole="button" accessibilityLabel="Archiver ce produit">
                <Text variant="body" color="secondary">Archiver ce produit</Text>
              </Pressable>
            )
          )}
        </View>
      )}

      {expanded && !isDelivery && (
        <ReAnimated.View entering={reduce ? undefined : FadeInDown.duration(200)}>
          <Card style={styles.fieldBlock}>
            <Text style={styles.fieldLabel}>Prix d'achat</Text>
            <MoneyInput currency={currency}
              inputRef={purchaseRef}
              style={styles.fieldInput}
              value={s.purchasePrice}
              onChangeText={v => setS(prev => ({ ...prev, purchasePrice: formatAmountInput(v, currency) }))}
              keyboardType="decimal-pad"
              placeholderTextColor={palette.textDisabled}
              returnKeyType="next"
              blurOnSubmit={false}
              onSubmitEditing={() => feesRef.current?.focus()}
              onFocus={revealFocused}
            />
          </Card>
          <Card style={styles.fieldBlock}>
            <Text style={styles.fieldLabel}>Frais</Text>
            <MoneyInput currency={currency}
              inputRef={feesRef}
              style={styles.fieldInput}
              value={s.fees}
              onChangeText={v => setS(prev => ({ ...prev, fees: formatAmountInput(v, currency) }))}
              keyboardType="decimal-pad"
              placeholderTextColor={palette.textDisabled}
              onFocus={revealFocused}
            />
          </Card>
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
          {!supplierCtx && (
            <Card style={styles.fieldBlock}>
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
            </Card>
          )}
        </ReAnimated.View>
      )}
      </Animated.View>
    </GestureSheet>
  );
}

function makeStyles(p: Palette) {
  // Soft rounded card; whitespace (not hairlines) separates groups.
  const card = { backgroundColor: p.surface, borderRadius: 16, marginHorizontal: spacing[4], marginTop: spacing[3] } as const;
  return StyleSheet.create({
    // Transparent on purpose: the button floats over the sheet's own background — no slab, border or shadow.
    footer: { paddingHorizontal: spacing[5], paddingTop: spacing[3], backgroundColor: 'transparent' },
    toast: {
      position: 'absolute', top: 64, alignSelf: 'center', flexDirection: 'row', alignItems: 'center', gap: spacing[2],
      maxWidth: '86%', paddingHorizontal: spacing[4], paddingVertical: spacing[2.5], borderRadius: 999,
      backgroundColor: p.surface,
    },
    toastText: { fontFamily: FF.semibold, fontSize: 15, color: p.textPrimary, flexShrink: 1 },
    draftChip: { flexDirection: 'row', alignItems: 'center', gap: spacing[2], marginHorizontal: spacing[4], marginTop: spacing[3], paddingHorizontal: spacing[4], paddingVertical: spacing[2.5], borderRadius: 12, backgroundColor: p.surface },
    formError: { backgroundColor: p.warningLight, borderRadius: 12, padding: spacing[3], marginHorizontal: spacing[4], marginTop: spacing[3] },
    fieldBlock: { ...card, paddingHorizontal: spacing[4], paddingVertical: spacing[2.5], gap: 2 },
    labelRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
    fieldLabel: {
      fontFamily: FF.semibold, fontSize: 11, color: p.textSecondary,
      letterSpacing: 0.6, textTransform: 'uppercase',
    },
    fieldInput: { fontFamily: FF.semibold, fontSize: 22, color: p.textPrimary, paddingVertical: 0, minHeight: 30 },
    confirmedRow: { ...card, flexDirection: 'row', alignItems: 'center', gap: spacing[3], paddingHorizontal: spacing[4], paddingVertical: spacing[3.5] },
    confirmedLabel: { fontFamily: FF.semibold, fontSize: 11, color: p.textSecondary, letterSpacing: 0.6, textTransform: 'uppercase', width: 96 },
    confirmedValue: { flex: 1, fontFamily: FF.semibold, fontSize: 17, color: p.textPrimary },
    toggleRow: { ...card, flexDirection: 'row', alignItems: 'center', paddingHorizontal: spacing[4], paddingVertical: spacing[2] },
    qtyRow: { flexDirection: 'row', alignItems: 'center', gap: spacing[3] },
    suggestions: { marginTop: spacing[1], gap: 2 },
    suggestionsHint: { fontFamily: FF.medium, fontSize: 12, color: p.textSecondary, marginBottom: 2 },
    suggestionRow: {
      flexDirection: 'row', alignItems: 'center', gap: spacing[3],
      paddingVertical: spacing[2], paddingHorizontal: spacing[3],
      borderRadius: 10, backgroundColor: p.background,
    },
    variantList: { marginTop: spacing[3] },
    variantHeader: { flexDirection: 'row', alignItems: 'center', gap: spacing[2], paddingHorizontal: spacing[7], paddingBottom: spacing[1.5] },
    variantRow: { ...card, flexDirection: 'row', alignItems: 'center', gap: spacing[2], paddingHorizontal: spacing[4], paddingVertical: spacing[2.5], marginTop: spacing[2] },
    addVariant: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: spacing[5], paddingVertical: spacing[3] },
    derived: { fontFamily: FF.medium, fontSize: 14, color: p.textSecondary, paddingHorizontal: spacing[5] },
    manageBlock: { marginTop: spacing[2], paddingBottom: spacing[2] },
    manageRow: { alignItems: 'center', paddingVertical: spacing[3.5] },
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
