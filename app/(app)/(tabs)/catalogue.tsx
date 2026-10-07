import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ConfirmSheetHost } from '@/src/components/ui/ConfirmSheet';
import { appAlert } from '@/src/utils/appAlert';
import { AnimatedRowCell, AnimatedRow } from '@/src/components/ui/AnimatedRow';
import { markRowRemoved } from '@/src/utils/rowMotion';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { Animated, FlatList, InputAccessoryView, Keyboard, Modal, Platform, Pressable, RefreshControl, ScrollView, StyleSheet, Switch, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Screen } from '@/src/components/ui/Screen';
import { FormSheet } from '@/src/components/ui/FormSheet';
import { Button } from '@/src/components/ui/Button';
import { Card } from '@/src/components/ui/Card';
import { EmptyState } from '@/src/components/ui/EmptyState';
import { Input } from '@/src/components/ui/Input';
import { NoResultsState } from '@/src/components/ui/NoResultsState';
import { Pill } from '@/src/components/ui/Pill';
import { Text } from '@/src/components/ui/Text';
import { PhoneInput } from '@/src/components/ui/PhoneInput';
import { Ionicons } from '@expo/vector-icons';
import { useTheme, radius, spacing, shadow, fontFamily as FF, FLOATING_TAB_BAR_CLEARANCE, SEARCH_VISIBILITY_THRESHOLD } from '@/src/theme';
import { useAnimateLayoutChange } from '@/src/hooks/useAnimateLayoutChange';
import type { Palette } from '@/src/theme';
import type { Product, ProductVariant } from '@/src/types';
import { useAuthStore } from '@/stores/auth';
import { type CreateProductData, type DraftVariant, type ProductStats, useProductStore } from '@/stores/products';
import { useSaveConfirmationStore } from '@/stores/saveConfirmation';
import { productConfirmation } from '@/src/utils/saveConfirmationCopy';
import { useFournisseursStore, type Fournisseur } from '@/stores/fournisseurs';
import { haptics } from '@/lib/haptics';
import { toast } from '@/stores/toast';
import { QuantityStepper } from '@/src/components/ui/QuantityStepper';
import { LoadingStatus } from '@/src/components/ui/LoadingStatus';
import { perUnitCost, totalInvested, unitProfit } from '@/src/utils/productPricing';
import { formatAmount, formatAmountInput, parseAmountInput, formatAmountValue, formatSignedAmount } from '@/src/utils/format';
import { OfflineNotice } from '@/src/components/ui/OfflineNotice';
import { SkeletonList } from '@/src/components/ui/SkeletonPlaceholder';
import { activationPriming } from '@/stores/activationPriming';
import { showFailureAlert, failAlert } from '@/src/components/ui/FailureView';
import { buildFailure, failureReason } from '@/src/utils/failure';
import { FAILURE_COPY } from '@/src/utils/failureCopy';
import { archivedConfirmation } from '@/src/utils/saveConfirmationCopy';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatPrice(amount: number, currency: string) {
  return formatAmount(amount, currency);
}

// List rows show the bare number — the currency is declared once above the
// list instead of repeated on every row (see the "Prix (devise)" header).
function formatPriceValue(amount: number, currency: string) {
  return formatAmountValue(amount, currency);
}


// ─── Form State ───────────────────────────────────────────────────────────────

interface FormState {
  name: string;
  purchase_price: string;
  extra_fees: string;
  sale_price: string;
  initial_stock: string;
  purchase_qty: string;
  reorder_level: string;
  supplier_id: string;
}

const EMPTY_FORM: FormState = {
  name: '',
  purchase_price: '',
  extra_fees: '',
  sale_price: '',
  initial_stock: '',
  purchase_qty: '1',
  reorder_level: '',
  supplier_id: '',
};

function productToForm(p: Product, currency: string): FormState {
  return {
    name: p.name,
    purchase_price: p.cost_price > 0 ? formatAmountInput(String(Math.round(p.cost_price)), currency) : '',
    extra_fees: '',
    sale_price: formatAmountInput(String(Math.round(p.sale_price)), currency),
    initial_stock: '',
    // Defaults to the product's real current stock, not a flat '1' — this is
    // the divisor for "Frais supplémentaires" below, and a merchant editing
    // an existing product almost always means to spread a new fee across
    // what she already has in stock, not across a single mystery unit.
    // Dividing by 1 by default silently inflates cost_price by the full fee
    // amount instead of the intended per-unit share. p.stock_qty is always 0
    // for a has_variants product (documented invariant) — Math.max(...,1)
    // falls back to the old safe default there, since variants track their
    // own cost independently and this field's output isn't meaningful for them.
    purchase_qty: String(Math.max(p.stock_qty || 0, 1)),
    reorder_level: p.reorder_level > 0 ? String(p.reorder_level) : '',
    supplier_id: p.supplier_id ?? '',
  };
}

function totalCost(f: FormState, currency: string): number {
  const qty = Math.max(parseFloat(f.initial_stock) || parseFloat(f.purchase_qty) || 1, 1);
  const fees = parseAmountInput(f.extra_fees, currency);
  return perUnitCost(parseAmountInput(f.purchase_price, currency), fees, qty);
}

function validateForm(f: FormState, currency: string): string | null {
  if (!f.name.trim()) return 'Indiquez le nom';
  const sp = parseAmountInput(f.sale_price, currency);
  if (isNaN(sp) || sp <= 0) return 'Le prix de vente doit être supérieur à 0';
  return null;
}

function formToData(f: FormState, currency: string): CreateProductData {
  return {
    name: f.name,
    unit: 'pcs',
    cost_price: totalCost(f, currency),
    sale_price: parseAmountInput(f.sale_price, currency),
    reorder_level: parseInt(f.reorder_level) || 0,
    initial_stock: parseInt(f.initial_stock) || 0,
    supplier_id: f.supplier_id || null,
  };
}

// ─── Supplier Picker (inline dropdown + inline create — no nested Modal) ────────

interface SupplierPickerProps {
  fournisseurs: Fournisseur[];
  selectedId: string;
  onSelect: (id: string) => void;
  businessId: string;
  userId: string;
}

function SupplierPicker({ fournisseurs, selectedId, onSelect, businessId, userId }: SupplierPickerProps) {
  const { palette } = useTheme();
  const styles = useMemo(() => makeStyles(palette), [palette]);
  const { createFournisseur, saving: fSaving } = useFournisseursStore();
  const selected = fournisseurs.find(f => f.id === selectedId);
  const [open, setOpen] = useState(false);
  const [showNewForm, setShowNewForm] = useState(false);
  const [newName, setNewName] = useState('');
  const [newPhone, setNewPhone] = useState('');

  const handleCreate = async () => {
    if (!newName.trim()) { appAlert('Ajoutez un nom'); return; }
    const ok = await createFournisseur(businessId, userId, { name: newName, phone: newPhone });
    if (ok) {
      haptics.success();
      const latest = useFournisseursStore.getState().fournisseurs.find(f => f.name.trim() === newName.trim());
      if (latest) onSelect(latest.id);
      setShowNewForm(false);
      setNewName('');
      setNewPhone('');
    }
  };

  return (
    <View>
      <Pressable onPress={() => setOpen(v => !v)} style={styles.fieldBlock}>
        <Text style={styles.fieldLabel}>Fournisseur</Text>
        <View style={{ flexDirection: 'row', alignItems: 'center' }}>
          <Text style={[styles.fieldInput, { flex: 1, fontFamily: FF.medium, fontSize: 17 }]} numberOfLines={1}>
            {selected ? selected.name : 'Aucun'}
          </Text>
          <Text style={{ color: palette.textSecondary, fontSize: 13 }}>{open ? '▲' : '▼'}</Text>
        </View>
      </Pressable>
      {open && (
        <View style={styles.supplierDropdown}>
          <Pressable
            onPress={() => { onSelect(''); setOpen(false); }}
            style={[styles.supplierRow, !selectedId && styles.supplierRowActive]}
          >
            <Text variant="body" style={{ color: !selectedId ? palette.primary : palette.textSecondary }}>
              Aucun fournisseur
            </Text>
          </Pressable>
          {fournisseurs.map(f => (
            <Pressable
              key={f.id}
              onPress={() => { onSelect(f.id); setOpen(false); }}
              style={[styles.supplierRow, selectedId === f.id && styles.supplierRowActive]}
            >
              <Text variant="body" style={{ color: selectedId === f.id ? palette.primary : palette.textPrimary }}>
                {f.name}
              </Text>
              {f.phone ? <Text variant="caption" color="secondary">{f.phone}</Text> : null}
            </Pressable>
          ))}
          <Pressable onPress={() => { setOpen(false); setShowNewForm(true); }} style={styles.supplierRow}>
            <Text variant="label" style={{ color: palette.primary }}>+ Ajouter un fournisseur</Text>
          </Pressable>
        </View>
      )}
      {showNewForm && (
        <View style={styles.newSupplierForm}>
          <Input label="Nom *" value={newName} onChangeText={setNewName} placeholder="Alimentation, Électronique…" />
          <PhoneInput label="Téléphone (optionnel)" onChange={(e164) => setNewPhone(e164)} strict={false} />
          <View style={{ flexDirection: 'row', gap: spacing[2] }}>
            <Button label="Annuler" onPress={() => { setShowNewForm(false); setNewName(''); setNewPhone(''); }} variant="outline" style={{ flex: 1 }} />
            <Button label="Créer" loadingLabel="Création" onPress={handleCreate} loading={fSaving} style={{ flex: 1 }} disabled={!newName.trim()} />
          </View>
        </View>
      )}
    </View>
  );
}

// ─── Product Form Modal ───────────────────────────────────────────────────────

interface ProductFormProps {
  visible: boolean;
  editing: Product | null;
  onClose: () => void;
  onSave: (data: CreateProductData, hasVariants: boolean, variants: DraftVariant[]) => Promise<void>;
  saving: boolean;
  currency: string;
  fournisseurs: Fournisseur[];
  businessId: string;
  userId: string;
  initialVariants?: ProductVariant[];
  /** Seeds a fresh (non-editing) form's name field — the "no search match"
   *  dead-end flip: "+ Nouveau produit « X »" opens straight to a form with
   *  the searched name already typed, instead of a blank one. */
  initialName?: string;
}

function generateLocalKey() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

// iOS-only: decimal-pad/number-pad keyboards have no built-in return key, so the
// "Suivant" chain for those fields needs a shared accessory bar above the keyboard.
const PRICE_ACCESSORY_ID = 'catalogue-product-form-price-accessory';

// The product form's "Plus d'informations" fields (purchase_qty, extra_fees,
// reorder_level) and each variant row's qty/price cells are numeric but have
// no natural "next field" to chain to the way purchase→sale→quantity does —
// and this modal's "Enregistrer" button is always visible (FormSheet footer,
// never scrolls away), so a keyboard "Done" affordance would just repeat it.
// A blank, linked accessory suppresses iOS's own auto-injected Done pill
// without showing anything in its place.
const SILENT_ACCESSORY_ID = 'catalogue-product-form-silent-accessory';
const STOCK_ADJUST_ACCESSORY_ID = 'catalogue-stock-adjust-silent-accessory';

// _touched: has the merchant directly typed into THIS row's price field at
// least once (even if they cleared it back to empty)? Distinct from
// sale_price===0 alone — an untouched row at 0 is still silently tracking
// the top price (see VariantRow), while a touched row at 0 was deliberately
// cleared and must never be auto-filled again or silently resolved at save.
type VariantDraftItem = DraftVariant & { _key: string; _touched: boolean };

interface VariantRowProps {
  variant: VariantDraftItem;
  currency: string;
  // The top "Prix de vente unitaire" field's current value (display units).
  // A variant row still at sale_price=0 tracks this live — see VariantRow.
  fallbackPrice: number;
  onChange: (patch: Partial<VariantDraftItem>) => void;
  onRemove: () => void;
}

// Column widths shared with the header row (variantListHeader below) so the
// two stay visually aligned — name/price flex, qty and the trailing remove
// button are fixed. Price gets the larger flex share and a minWidth floor:
// it's the one field that must never visually truncate (a merchant editing
// a single variant's price needs to see every digit, not just base products).
const VARIANT_QTY_WIDTH = 60;
const VARIANT_REMOVE_WIDTH = 28;
const VARIANT_NAME_FLEX = 1.3;
const VARIANT_PRICE_FLEX = 1.2;
const VARIANT_PRICE_MIN_WIDTH = 118;

function VariantRow({ variant, currency, fallbackPrice, onChange, onRemove }: VariantRowProps) {
  const { palette } = useTheme();
  const styles = useMemo(() => makeStyles(palette), [palette]);
  // Local formatted text buffer, same pattern as the top-level "Prix de vente"
  // field — formatAmountInput must run on the raw keystroke string, not on a
  // round-trip through the stored number, or an in-progress "12," GNF grouping
  // separator gets clobbered mid-type.
  const stillTracking = !variant._touched && variant.sale_price === 0;
  const effectiveInitial = stillTracking ? fallbackPrice : variant.sale_price;
  const [priceText, setPriceText] = useState(
    effectiveInitial > 0 ? formatAmountInput(String(Math.round(effectiveInitial)), currency) : ''
  );
  // The "Modèles" toggle sits above the price field in this form,
  // so the first variant row is always created before a price exists to
  // pre-fill from — it's born at sale_price=0. A row that's never been
  // directly typed into keeps tracking the top field live, right up until
  // the merchant types their own value — at that point onChangeText below
  // marks it _touched and this effect stops firing for good, even if they
  // clear it back to empty afterward. A deliberate clear must never snap
  // back to the auto price — that's the merchant's own choice to leave it
  // blank (handleSave then blocks the save with a clear error instead of
  // silently substituting the top price).
  useEffect(() => {
    if (!variant._touched && variant.sale_price === 0) {
      setPriceText(fallbackPrice > 0 ? formatAmountInput(String(Math.round(fallbackPrice)), currency) : '');
    }
  }, [fallbackPrice, variant.sale_price, variant._touched, currency]);
  return (
    <View style={styles.variantRowHeader}>
      <TextInput
        style={[styles.fieldInput, { flex: VARIANT_NAME_FLEX, fontSize: 17 }]}
        value={variant.name}
        onChangeText={v => onChange({ name: v })}
        placeholder="S, M, L, Rouge, 1L…"
        placeholderTextColor={palette.textDisabled}
      />
      <TextInput
        style={[styles.fieldInput, { width: VARIANT_QTY_WIDTH, textAlign: 'right', fontSize: 17 }]}
        value={variant.stock_qty > 0 ? String(variant.stock_qty) : ''}
        onChangeText={v => onChange({ stock_qty: parseInt(v) || 0 })}
        keyboardType="number-pad"
        placeholder="0"
        placeholderTextColor={palette.textDisabled}
        inputAccessoryViewID={Platform.OS === 'ios' ? SILENT_ACCESSORY_ID : undefined}
      />
      <TextInput
        style={[
          styles.fieldInput,
          { flex: VARIANT_PRICE_FLEX, minWidth: VARIANT_PRICE_MIN_WIDTH, textAlign: 'right', fontSize: 17 },
        ]}
        value={priceText}
        onChangeText={v => {
          const formatted = formatAmountInput(v, currency);
          setPriceText(formatted);
          onChange({ sale_price: parseAmountInput(formatted, currency), _touched: true });
        }}
        keyboardType="decimal-pad"
        placeholder="0"
        placeholderTextColor={palette.textDisabled}
        inputAccessoryViewID={Platform.OS === 'ios' ? SILENT_ACCESSORY_ID : undefined}
      />
      <Pressable onPress={onRemove} hitSlop={10} style={{ width: VARIANT_REMOVE_WIDTH, alignItems: 'flex-end' }} accessibilityLabel="Retirer ce modèle" accessibilityRole="button">
        <Ionicons name="close-circle" size={20} color={palette.textDisabled} />
      </Pressable>
    </View>
  );
}

function makeVariantItem(form: FormState, currency: string, overrides?: Partial<VariantDraftItem>): VariantDraftItem {
  return {
    _key: generateLocalKey(),
    _touched: false,
    name: '',
    // Always starts at 0, never a one-time snapshot of the top price — every
    // new row (the first auto-created one or a later "Ajouter un modèle")
    // tracks the top field live via VariantRow's fallbackPrice until the
    // merchant actually types their own value into it. See VariantRow.
    sale_price: 0,
    cost_price: totalCost(form, currency),
    stock_qty: 0,
    reorder_level: 0,
    ...overrides,
  };
}

function ProductFormModal({ visible, editing, onClose, onSave, saving, currency, fournisseurs, businessId, userId, initialVariants, initialName }: ProductFormProps) {
  const { palette } = useTheme();
  const styles = useMemo(() => makeStyles(palette), [palette]);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [formError, setFormError] = useState<string | null>(null);
  const [showDetails, setShowDetails] = useState(false);
  const [hasVariants, setHasVariants] = useState(false);
  const [variantDraft, setVariantDraft] = useState<VariantDraftItem[]>([]);
  const nameRef = useRef<TextInput>(null);
  const raf2Ref = useRef<number | null>(null);
  const purchasePriceRef = useRef<TextInput>(null);
  const salePriceRef = useRef<TextInput>(null);
  const initialStockRef = useRef<TextInput>(null);
  const [focusedPriceField, setFocusedPriceField] = useState<'purchase_price' | 'sale_price' | 'quantity' | null>(null);
  const scrollRef = useRef<ScrollView>(null);
  const insets = useSafeAreaInsets();

  useEffect(() => {
    if (visible) {
      const f = editing ? productToForm(editing, currency) : { ...EMPTY_FORM, name: initialName ?? '' };
      setForm(f);
      setFormError(null);
      setShowDetails(false);
      const isVariant = editing?.has_variants ?? false;
      setHasVariants(isVariant);
      if (isVariant && initialVariants && initialVariants.length > 0) {
        setVariantDraft(initialVariants.map(v => ({
          _key: v.id,
          _touched: true, // already has its own saved state — not a fresh auto-tracking row
          name: v.name,
          sale_price: v.sale_price,
          cost_price: v.cost_price,
          stock_qty: v.stock_qty,
          reorder_level: v.reorder_level,
        })));
      } else {
        setVariantDraft([]);
      }
      // Focus as soon as the native TextInput node actually exists, not on a
      // flat guessed delay — the old 200ms fired well after the sheet's own
      // slide-up had mostly finished, so the keyboard's rise started as a
      // separate, later beat instead of overlapping the sheet's motion. Two
      // rAFs: the first lets this render's commit flush, the second lets the
      // native node mount off the back of that — the earliest frame it's
      // actually safe to call .focus(), so the keyboard starts rising
      // together with the sheet instead of after it settles.
      const raf1 = requestAnimationFrame(() => {
        raf2Ref.current = requestAnimationFrame(() => {
          nameRef.current?.focus();
        });
      });
      return () => {
        cancelAnimationFrame(raf1);
        if (raf2Ref.current !== null) cancelAnimationFrame(raf2Ref.current);
      };
    }
  }, [visible, editing, initialVariants, initialName]);

  const setField = (key: keyof FormState) => (val: string) =>
    setForm(prev => ({ ...prev, [key]: val }));

  const handleSave = async () => {
    const err = validateForm(form, currency);
    if (err) { setFormError(err); return; }
    if (hasVariants && variantDraft.length === 0) {
      setFormError('Ajoutez au moins une version');
      return;
    }
    if (hasVariants && variantDraft.some(v => !v.name.trim())) {
      setFormError('Chaque version doit avoir un nom');
      return;
    }
    // An untouched row still at 0 has never been directly typed into — it's
    // been silently tracking the top price on screen (see VariantRow's
    // fallbackPrice), so resolve it to that same current value here rather
    // than writing a literal 0. A row the merchant DID touch — even if they
    // left it empty on purpose — is never auto-resolved: it passes through
    // as-is, so the check below can correctly catch it as missing instead of
    // silently substituting a price the merchant deliberately cleared.
    const resolvedVariants = variantDraft.map(v =>
      (!v._touched && v.sale_price === 0)
        ? { ...v, sale_price: parseAmountInput(form.sale_price, currency) }
        : v,
    );
    if (hasVariants && resolvedVariants.some(v => v.sale_price <= 0)) {
      setFormError('Entrez tous les prix de vente');
      return;
    }
    setFormError(null);
    await onSave(
      formToData(form, currency),
      hasVariants,
      resolvedVariants.map(({ _key: _k, _touched: _t, ...v }) => v),
    );
  };

  const toggleDetails = () => {
    const next = !showDetails;
    setShowDetails(next);
    if (next) {
      setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 150);
    }
  };

  const qty = parseFloat(form.initial_stock) || 0;
  const pp = parseAmountInput(form.purchase_price, currency);
  const sp = parseAmountInput(form.sale_price, currency);
  const computedCost = totalCost(form, currency);
  const fees = parseAmountInput(form.extra_fees, currency);
  const liveInvested = totalInvested(qty, pp, fees);
  const totalVariantStock = variantDraft.reduce((s, v) => s + (v.stock_qty || 0), 0);
  const showLiveCalc = !editing && !hasVariants && liveInvested > 0;
  const showProfitHint = (pp > 0 || computedCost > 0) && sp > 0;
  // Whether the single plain "Quantité achetée" field is on screen to chain into —
  // it's replaced by the variant list when hasVariants, and hidden entirely when editing.
  const quantityFieldVisible = !editing && !hasVariants;

  const handlePriceAccessoryNext = () => {
    if (focusedPriceField === 'purchase_price') {
      salePriceRef.current?.focus();
    } else if (focusedPriceField === 'sale_price' && quantityFieldVisible) {
      initialStockRef.current?.focus();
    } else {
      // Last field in the chain — dismiss only, never auto-submit.
      Keyboard.dismiss();
    }
  };
  const priceAccessoryLabel =
    focusedPriceField === 'purchase_price' || (focusedPriceField === 'sale_price' && quantityFieldVisible)
      ? 'Suivant'
      : 'Terminé';

  return (
    <FormSheet
      ref={scrollRef}
      visible={visible}
      onClose={onClose}
      title={editing ? 'Modifier le produit' : 'Nouveau produit'}
      contentContainerStyle={[styles.formStack, { paddingBottom: 16 }]}
      footer={
        <View style={[styles.modalFooter, { paddingBottom: Math.max(insets.bottom, spacing[5]) }]}>
          <Button label={editing ? 'Enregistrer' : 'Ajouter'} loadingLabel={editing ? 'Enregistrement' : 'Ajout'} onPress={handleSave}
            loading={saving} fullWidth size="lg" />
        </View>
      }
      accessory={
        // decimal-pad/number-pad have no built-in return key on iOS — this bar
        // stands in for it so Prix d'achat → Prix de vente → Quantité can chain
        // the same way "Suivant" on the keyboard would. Never wired to handleSave.
        Platform.OS === 'ios' ? (
          <>
            <InputAccessoryView nativeID={PRICE_ACCESSORY_ID}>
              <View style={styles.priceAccessoryBar}>
                <Pressable onPress={handlePriceAccessoryNext} hitSlop={8}>
                  <Text variant="body" style={{ color: palette.primary, fontFamily: FF.semibold }}>
                    {priceAccessoryLabel}
                  </Text>
                </Pressable>
              </View>
            </InputAccessoryView>
            <InputAccessoryView nativeID={SILENT_ACCESSORY_ID}>
              <View style={{ height: 0 }} />
            </InputAccessoryView>
          </>
        ) : undefined
      }
    >
      {formError && (
        <View style={styles.formError}>
          <Text variant="bodySmall" color="warning">{formError}</Text>
        </View>
      )}

      {/* 1 — Nom du produit */}
      <View style={styles.fieldBlock}>
        <Text style={styles.fieldLabel}>Nom du produit</Text>
        <TextInput
          ref={nameRef}
          style={styles.fieldInput}
          value={form.name}
          onChangeText={setField('name')}
          placeholder="Nom du produit"
          placeholderTextColor={palette.textDisabled}
          returnKeyType="next"
          blurOnSubmit={false}
          onSubmitEditing={() => purchasePriceRef.current?.focus()}
        />
      </View>

      {/* 2 — Variant toggle (early, before prices) */}
      <View style={styles.variantToggleRow}>
        <View style={{ flex: 1 }}>
          <Text variant="body" color="secondary" style={{ fontFamily: FF.medium }}>Modèles</Text>
        </View>
        <Switch
          value={hasVariants}
          onValueChange={v => {
            haptics.toggle(v);
            setHasVariants(v);
            if (v && variantDraft.length === 0) {
              setVariantDraft([makeVariantItem(form, currency)]);
            }
          }}
          trackColor={{ false: palette.border, true: palette.primary }}
          thumbColor={palette.surface}
        />
      </View>

      {/* 3 — Prix d'achat */}
      <View style={styles.fieldBlock}>
        <Text style={styles.fieldLabel}>
          {`Prix d'achat unitaire (${currency})`}
        </Text>
        <TextInput
          ref={purchasePriceRef}
          style={styles.fieldInput}
          value={form.purchase_price}
          onChangeText={v => setForm(prev => ({ ...prev, purchase_price: formatAmountInput(v, currency) }))}
          keyboardType="decimal-pad"
          placeholderTextColor={palette.textDisabled}
          returnKeyType="next"
          blurOnSubmit={false}
          onSubmitEditing={() => salePriceRef.current?.focus()}
          onFocus={() => setFocusedPriceField('purchase_price')}
          inputAccessoryViewID={Platform.OS === 'ios' ? PRICE_ACCESSORY_ID : undefined}
        />
      </View>

      {/* 4 — Prix de vente */}
      <View style={styles.fieldBlock}>
        <Text style={styles.fieldLabel}>
          {`Prix de vente unitaire (${currency})`}
        </Text>
        <TextInput
          ref={salePriceRef}
          style={styles.fieldInput}
          value={form.sale_price}
          onChangeText={v => setForm(prev => ({ ...prev, sale_price: formatAmountInput(v, currency) }))}
          keyboardType="decimal-pad"
          placeholderTextColor={palette.textDisabled}
          returnKeyType={quantityFieldVisible ? 'next' : 'done'}
          blurOnSubmit={false}
          onSubmitEditing={() => {
            if (quantityFieldVisible) initialStockRef.current?.focus();
            else Keyboard.dismiss();
          }}
          onFocus={() => setFocusedPriceField('sale_price')}
          inputAccessoryViewID={Platform.OS === 'ios' ? PRICE_ACCESSORY_ID : undefined}
        />
        {(() => {
          const sp = parseAmountInput(form.sale_price, currency);
          const cp = totalCost(form, currency);
          if (cp > 0 && sp > 0 && sp < cp) {
            return (
              <Text style={{ fontSize: 12, color: palette.warning, marginTop: 4 }}>
                Le prix est inférieur au coût d'achat
              </Text>
            );
          }
          return null;
        })()}
      </View>

      {/* 5a — Quantity (plain products, new only) */}
      {!editing && !hasVariants && (
        <View style={styles.fieldBlock}>
          <Text style={styles.fieldLabel}>Quantité achetée</Text>
          <View style={styles.fieldRow}>
            <View style={{ flex: 1 }}>
              <QuantityStepper
                value={form.initial_stock}
                onChange={setField('initial_stock')}
                inputRef={initialStockRef}
                inputStyle={styles.fieldInput}
                returnKeyType="done"
                onSubmitEditing={() => Keyboard.dismiss()}
                onFocus={() => setFocusedPriceField('quantity')}
                inputAccessoryViewID={PRICE_ACCESSORY_ID}
              />
            </View>
            <Text style={styles.unitTag}>pièces</Text>
          </View>
        </View>
      )}

      {/* 5b — Variant list */}
      {hasVariants && (
        <View style={styles.variantList}>
          <View style={styles.variantListHeader}>
            <Text
              style={[styles.fieldLabel, { flex: VARIANT_NAME_FLEX, fontSize: 10, letterSpacing: 0 }]}
              numberOfLines={1}
            >
              Modèles
            </Text>
            <Text style={[styles.fieldLabel, { width: VARIANT_QTY_WIDTH, textAlign: 'right' }]}>Qté</Text>
            <Text
              style={[styles.fieldLabel, { flex: VARIANT_PRICE_FLEX, minWidth: VARIANT_PRICE_MIN_WIDTH, textAlign: 'right' }]}
            >
              Prix
            </Text>
            <View style={{ width: VARIANT_REMOVE_WIDTH }} />
          </View>
          {variantDraft.map((v, i) => (
            <VariantRow
              key={v._key}
              variant={v}
              currency={currency}
              fallbackPrice={sp}
              onChange={patch => setVariantDraft(prev => prev.map((item, idx) => idx === i ? { ...item, ...patch } : item))}
              onRemove={() => setVariantDraft(prev => prev.filter((_, idx) => idx !== i))}
            />
          ))}
          <Pressable
            style={styles.addVariantBtn}
            onPress={() => setVariantDraft(prev => [...prev, makeVariantItem(form, currency)])}
          >
            <Ionicons name="add-circle-outline" size={18} color={palette.primary} />
            <Text variant="label" style={{ color: palette.primary, marginLeft: 4 }}>Ajouter un modèle</Text>
          </Pressable>
          {totalVariantStock > 0 && (
            <View style={[styles.liveCalcBlock, { borderTopWidth: 0 }]}>
              <Text style={styles.liveCalcText}>
                Stock total : {totalVariantStock} pièces sur {variantDraft.length} modèle{variantDraft.length !== 1 ? 's' : ''}
              </Text>
            </View>
          )}
        </View>
      )}

      {/* Live math (plain products) */}
      {showLiveCalc && (
        <View style={styles.liveCalcBlock}>
          <Text style={styles.liveCalcText}>
            Total investi : {formatAmount(liveInvested, currency)}
          </Text>
        </View>
      )}
      {showProfitHint && (
        <View style={styles.liveCalcBlock}>
          <Text style={[styles.liveCalcText, { color: sp > computedCost ? palette.success : palette.warning }]}>
            Bénéfice : {formatAmount(unitProfit(sp, computedCost), currency)} par pièce
          </Text>
        </View>
      )}

      {/* Frais & détails — always accessible (not gated on editing) */}
      <Pressable onPress={toggleDetails} style={styles.detailsBtn}>
        <Text variant="body" style={{ color: palette.primary }}>
          {showDetails ? '▲ Masquer' : '▼ Plus d\'informations'}
        </Text>
      </Pressable>

      {showDetails && (
        <>
          <SupplierPicker
            fournisseurs={fournisseurs}
            selectedId={form.supplier_id}
            onSelect={id => setForm(p => ({ ...p, supplier_id: id }))}
            businessId={businessId}
            userId={userId}
          />

          {editing && (
            <View style={styles.fieldBlock}>
              <Text style={styles.fieldLabel}>Quantité de la livraison</Text>
              <TextInput
                style={styles.fieldInput}
                value={form.purchase_qty}
                onChangeText={setField('purchase_qty')}
                keyboardType="number-pad"
                placeholderTextColor={palette.textDisabled}
                inputAccessoryViewID={Platform.OS === 'ios' ? SILENT_ACCESSORY_ID : undefined}
              />
              <Text variant="caption" color="secondary">Pour répartir les frais sur chaque pièce.</Text>
            </View>
          )}

          <View style={styles.fieldBlock}>
            <Text style={styles.fieldLabel}>Frais supplémentaires ({currency})</Text>
            <TextInput
              style={styles.fieldInput}
              value={form.extra_fees}
              onChangeText={v => setForm(prev => ({ ...prev, extra_fees: formatAmountInput(v, currency) }))}
              keyboardType="decimal-pad"
              placeholder="0"
              placeholderTextColor={palette.textDisabled}
              inputAccessoryViewID={Platform.OS === 'ios' ? SILENT_ACCESSORY_ID : undefined}
            />
          </View>

          {!hasVariants && (
            <View style={styles.fieldBlock}>
              <Text style={styles.fieldLabel}>Stock minimum</Text>
              <TextInput
                style={styles.fieldInput}
                value={form.reorder_level}
                onChangeText={setField('reorder_level')}
                keyboardType="number-pad"
                placeholderTextColor={palette.textDisabled}
                inputAccessoryViewID={Platform.OS === 'ios' ? SILENT_ACCESSORY_ID : undefined}
              />
              <Text variant="caption" color="secondary">Me prévenir quand le stock est bas</Text>
            </View>
          )}
        </>
      )}
    </FormSheet>
  );
}

// ─── Stock Adjust Modal ───────────────────────────────────────────────────────

interface StockAdjustProps {
  visible: boolean;
  product: Product | null;
  onClose: () => void;
  onConfirm: (qty: number, type: 'entree' | 'perte', note: string) => Promise<void>;
  saving: boolean;
  currency: string;
}

function StockAdjustModal({ visible, product, onClose, onConfirm, saving, currency }: StockAdjustProps) {
  const { palette } = useTheme();
  const styles = useMemo(() => makeStyles(palette), [palette]);
  const [qty, setQty] = useState('1');
  const [type, setType] = useState<'entree' | 'perte'>('entree');
  const [note, setNote] = useState('');

  useEffect(() => {
    if (visible) { setQty('1'); setType('entree'); setNote(''); }
  }, [visible]);

  if (!product) return null;

  return (
    <FormSheet
      visible={visible}
      onClose={onClose}
      title="Ajuster le stock"
      presentationStyle="formSheet"
      contentContainerStyle={styles.modalContent}
      footer={
        <View style={styles.modalFooter}>
          <Button
            label="Confirmer" loadingLabel="Enregistrement"
            onPress={async () => {
              const n = parseInt(qty);
              if (isNaN(n) || n <= 0) { appAlert('Entrez une quantité'); return; }
              await onConfirm(n, type, note);
            }}
            loading={saving} fullWidth size="lg"
            variant={type === 'perte' ? 'danger' : 'primary'}
          />
        </View>
      }
      accessory={
        Platform.OS === 'ios' ? (
          <InputAccessoryView nativeID={STOCK_ADJUST_ACCESSORY_ID}>
            <View style={{ height: 0 }} />
          </InputAccessoryView>
        ) : undefined
      }
    >
      <Card style={styles.stockPreview}>
        <Text variant="label">{product.name}</Text>
        <Text variant="amountLarge">{product.stock_qty} {product.unit}</Text>
        <Text variant="caption" color="secondary">Stock actuel</Text>
      </Card>

      <View style={styles.typeRow}>
        <Pressable onPress={() => setType('entree')}
          style={[styles.typeChip, type === 'entree' && styles.typeChipEntree]}>
          <Text variant="label" style={{ color: type === 'entree' ? palette.textInverse : palette.textPrimary }}>
            + Entrée
          </Text>
        </Pressable>
        <Pressable onPress={() => setType('perte')}
          style={[styles.typeChip, type === 'perte' && styles.typeChipPerte]}>
          <Text variant="label" style={{ color: type === 'perte' ? palette.textInverse : palette.textPrimary }}>
            − Perte / Retrait
          </Text>
        </Pressable>
      </View>

      <Text variant="label" color="secondary">Quantité</Text>
      <QuantityStepper
        value={qty}
        onChange={setQty}
        inputStyle={{ fontSize: 18 }}
        inputAccessoryViewID={STOCK_ADJUST_ACCESSORY_ID}
      />
      <Input label="Note (optionnel)" value={note} onChangeText={setNote}
        placeholder="Livraison, retour client, casse" />
    </FormSheet>
  );
}

// ─── Product Stats Modal ──────────────────────────────────────────────────────

type StatsPeriod = 'mois' | 'tout';

interface ProductStatsModalProps {
  visible: boolean;
  product: Product | null;
  onClose: () => void;
  businessId: string;
  currency: string;
  fetchStats: (productId: string, businessId: string, since?: string) => Promise<ProductStats | null>;
}

function ProductStatsModal({ visible, product, onClose, businessId, currency, fetchStats }: ProductStatsModalProps) {
  const { palette } = useTheme();
  const styles = useMemo(() => makeStyles(palette), [palette]);
  const [period, setPeriod] = useState<StatsPeriod>('mois');
  const [stats, setStats] = useState<ProductStats | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!visible || !product) return;
    setStats(null);
    setPeriod('mois');
  }, [visible, product]);

  useEffect(() => {
    if (!visible || !product) return;
    let cancelled = false;
    setLoading(true);
    const since = period === 'mois'
      ? new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString()
      : undefined;
    fetchStats(product.id, businessId, since).then(result => {
      if (!cancelled) { setStats(result); setLoading(false); }
    });
    return () => { cancelled = true; };
  }, [visible, product, period, businessId]);

  if (!product) return null;

  const profitColor = stats && stats.profit != null && stats.profit >= 0 ? palette.success : palette.warning;

  return (
    <FormSheet
      visible={visible}
      onClose={onClose}
      title="Bénéfices"
      cancelLabel="Fermer"
      presentationStyle="formSheet"
      contentContainerStyle={styles.modalContent}
    >
      <Text variant="label" color="secondary" style={{ textAlign: 'center' }}>{product.name}</Text>

      {/* Period toggle */}
      <View style={styles.typeRow}>
        <Pressable onPress={() => setPeriod('mois')}
          style={[styles.typeChip, period === 'mois' && styles.typeChipEntree]}>
          <Text variant="label" style={{ color: period === 'mois' ? palette.textInverse : palette.textPrimary }}>
            Ce mois
          </Text>
        </Pressable>
        <Pressable onPress={() => setPeriod('tout')}
          style={[styles.typeChip, period === 'tout' && styles.typeChipEntree]}>
          <Text variant="label" style={{ color: period === 'tout' ? palette.textInverse : palette.textPrimary }}>
            Depuis le début
          </Text>
        </Pressable>
      </View>

      {loading ? (
        <View style={{ alignItems: 'center', paddingVertical: 32 }}>
          <Text variant="body" color="secondary">Chargement…</Text>
        </View>
      ) : stats ? (
        <Card style={{ gap: 0 }}>
          <View style={styles.statsRow}>
            <Text variant="body" color="secondary">Encaissé</Text>
            <Text variant="body" style={{ fontFamily: 'System', fontWeight: '600' }}>
              {formatAmount(stats.revenue, currency)}
            </Text>
          </View>
          <View style={[styles.statsRow, styles.statsRowBorder]}>
            <Text variant="body" color="secondary">Coût d'achat</Text>
            <Text variant="body" style={{ fontFamily: 'System', fontWeight: '600' }}>
              {formatAmount(stats.capital, currency)}
            </Text>
          </View>
          {stats.linkedExpenses > 0 && (
            <View style={[styles.statsRow, styles.statsRowBorder]}>
              <Text variant="body" color="secondary">Dépenses liées</Text>
              <Text variant="body" style={{ fontFamily: 'System', fontWeight: '600' }}>
                {formatAmount(stats.linkedExpenses, currency)}
              </Text>
            </View>
          )}
          <View style={[styles.statsRow, styles.statsRowBorder]}>
            <Text variant="body">Bénéfice</Text>
            <Text variant="body" style={{ fontFamily: 'System', fontWeight: '700', color: profitColor }}>
              {stats.profit == null ? '—' : formatSignedAmount(stats.profit, currency)}
            </Text>
          </View>
        </Card>
      ) : (
        <View style={{ alignItems: 'center', paddingVertical: 32 }}>
          <Text variant="body" color="secondary">Aucune donnée disponible.</Text>
        </View>
      )}
    </FormSheet>
  );
}

// ─── Product Row ──────────────────────────────────────────────────────────────

interface ProductRowProps {
  product: Product;
  currency: string;
  onPress: () => void;
  onLongPress?: () => void;
  archived?: boolean;
  /** Only meaningful when product.has_variants — undefined while still loading. */
  variants?: ProductVariant[];
  /** Deactivate call in flight: the row shows "Désactivation…" and ignores taps. */
  archiving?: boolean;
}

function StockStatus({ product, variants }: { product: Product; variants?: ProductVariant[] }) {
  const { palette } = useTheme();
  const styles = useMemo(() => makeStyles(palette), [palette]);

  if (product.has_variants) {
    // Parent stock_qty is always 0 for a variant product — real stock lives
    // per-variant. Undefined (not loaded yet) intentionally shows nothing,
    // same fail-open default the Actifs/Épuisés split already uses, rather
    // than flashing "Épuisé" while variants are still being fetched.
    if (!variants || variants.length === 0) return null;
    const isOut = variants.every(v => v.stock_qty <= 0);
    if (!isOut) return null;
    return <Pill tone="warning">Fini</Pill>;
  }

  const isOut = product.stock_qty === 0;
  const isLow = !isOut && product.reorder_level > 0 && product.stock_qty <= product.reorder_level;

  if (isOut) {
    return <Pill tone="warning">Fini</Pill>;
  }
  if (isLow) {
    return (
      <Pill tone="warning" icon="leaf-outline">
        Bientôt fini · Il reste {product.stock_qty} {product.unit}
      </Pill>
    );
  }
  return (
    <Text style={styles.productStockText}>{product.stock_qty} {product.unit}</Text>
  );
}

// ─── Archive switch (Actifs / Non actifs) ────────────────────────────────────
// One sliding-pill control instead of two independent chips sitting side by
// side — same binary choice, but reads as a single switch with a satisfying
// slide + settle bounce, not "two buttons that happen to be next to each
// other". Labels are the real state names (Actifs/Non actifs), never a
// generic ON/OFF baked into the control itself.
function ArchiveSwitch({ value, onChange }: { value: 'actifs' | 'archives'; onChange: (v: 'actifs' | 'archives') => void }) {
  const { palette } = useTheme();
  const styles = useMemo(() => makeStyles(palette), [palette]);
  const [trackWidth, setTrackWidth] = useState(0);
  const slide = useRef(new Animated.Value(value === 'archives' ? 1 : 0)).current;
  const bounce = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    Animated.parallel([
      Animated.spring(slide, {
        toValue: value === 'archives' ? 1 : 0,
        useNativeDriver: true,
        friction: 8,
        tension: 60,
      }),
      // A tiny squash-and-settle on the thumb itself — the "cool" tactile
      // feedback on top of the slide, not just a flat linear move.
      Animated.sequence([
        Animated.timing(bounce, { toValue: 0.92, duration: 90, useNativeDriver: true }),
        Animated.spring(bounce, { toValue: 1, useNativeDriver: true, friction: 5, tension: 140 }),
      ]),
    ]).start();
  }, [value, slide, bounce]);

  const inset = 3;
  const thumbWidth = Math.max(trackWidth / 2 - inset, 0);
  const thumbTranslate = slide.interpolate({ inputRange: [0, 1], outputRange: [0, thumbWidth] });

  return (
    <View style={styles.switchTrack} onLayout={e => setTrackWidth(e.nativeEvent.layout.width)}>
      {trackWidth > 0 && (
        <Animated.View
          style={[
            styles.switchThumb,
            { width: thumbWidth, transform: [{ translateX: thumbTranslate }, { scale: bounce }] },
          ]}
        />
      )}
      {(['actifs', 'archives'] as const).map(t => (
        <Pressable key={t} onPress={() => onChange(t)} style={styles.switchOption} hitSlop={4}>
          <Text
            variant="caption"
            style={{
              color: value === t ? palette.textInverse : palette.textSecondary,
              fontWeight: value === t ? '700' : '500',
            }}
          >
            {t === 'actifs' ? 'Actifs' : 'Non actifs'}
          </Text>
        </Pressable>
      ))}
    </View>
  );
}

function ProductRow({ product, currency, onPress, onLongPress, archived, variants, archiving }: ProductRowProps) {
  const { palette } = useTheme();
  const styles = useMemo(() => makeStyles(palette), [palette]);
  const initial = product.name.charAt(0).toUpperCase();
  const isOutOfStock = !archived && (
    product.has_variants
      ? !!(variants && variants.length > 0 && variants.every(v => v.stock_qty <= 0))
      : product.stock_qty === 0
  );

  if (archived) {
    return (
      <Pressable
        onPress={onPress}
        onLongPress={onLongPress}
        style={({ pressed }) => [styles.productRow, pressed && { opacity: 0.65 }]}
      >
        <View style={[styles.productBadge, { opacity: 0.5 }]}>
          <Text allowFontScaling={false} style={styles.productBadgeText}>{initial}</Text>
        </View>
        <View style={styles.productCenter}>
          <Text style={[styles.productName, { color: palette.textDisabled }]} numberOfLines={1}>{product.name}</Text>
          <Text style={styles.productStockText}>{product.stock_qty} {product.unit}</Text>
        </View>
        <View style={styles.productRight}>
          <Text style={{ fontSize: 18, color: palette.textDisabled, letterSpacing: 2 }}>···</Text>
        </View>
      </Pressable>
    );
  }

  return (
    <Pressable
      onPress={onPress}
      disabled={archiving}
      style={({ pressed }) => [styles.productRow, (pressed || archiving) && { opacity: archiving ? 0.5 : 0.65 }]}
    >
      <View style={[styles.productBadge, { opacity: isOutOfStock ? 0.38 : 1 }]}>
        <Text style={styles.productBadgeText}>{initial}</Text>
      </View>
      <View style={styles.productCenter}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing[2] }}>
          <Text
            style={[styles.productName, isOutOfStock && { color: palette.textSecondary }]}
            numberOfLines={1}
          >{product.name}</Text>
          {product.bulk_price ? (
            <View style={styles.bulkBadge}>
              <Text variant="caption" style={{ color: palette.warning }}>Gros</Text>
            </View>
          ) : null}
        </View>
        {archiving
          ? <LoadingStatus word="Désactivation" color={palette.textSecondary} variant="caption" />
          : <StockStatus product={product} variants={variants} />}
      </View>
      {/* One non-wrapping row: price, then — only for a real variant product
          — its chevron. Previously the chevron sat absolutely positioned at
          the bottom of a stretched container while the price sat at the
          top, which could visually split them onto two lines; and a second,
          unrelated chevron had been added to every non-variant row, when
          the chevron's only real meaning is "this product has varieties". */}
      <View style={styles.productRight}>
        <View style={styles.priceRow}>
          <Text
            style={[styles.priceText, isOutOfStock && { color: palette.textDisabled }]}
            numberOfLines={1}
          >
            {formatPriceValue(product.sale_price, currency)}
          </Text>
          {product.has_variants && (
            <Ionicons name="chevron-forward" size={14} color={palette.textDisabled} />
          )}
        </View>
      </View>
    </Pressable>
  );
}

// ─── Restore Action Sheet (archived products) ────────────────────────────────

function RestoreActionSheet({
  visible,
  product,
  onClose,
  onRestore,
}: {
  visible: boolean;
  product: Product | null;
  onClose: () => void;
  onRestore: () => void;
}) {
  const { palette } = useTheme();
  const insets = useSafeAreaInsets();
  const styles = useMemo(() => makeStyles(palette), [palette]);

  if (!product) return null;

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose} statusBarTranslucent navigationBarTranslucent>
      <Pressable style={styles.actionSheetOverlay} onPress={onClose} />
      <View style={[styles.actionSheet, { paddingBottom: Math.max(insets.bottom, spacing[4]) }]}>
        <View style={styles.sheetHandle} />
        <View style={styles.actionSheetHeader}>
          <Text variant="h4" numberOfLines={1}>{product.name}</Text>
          <Text variant="caption" color="secondary">Ce produit n'est plus actif</Text>
        </View>
        <Pressable
          style={({ pressed }) => [styles.actionRow, pressed && { opacity: 0.65 }]}
          onPress={onRestore}
        >
          <Ionicons name="refresh-outline" size={22} color={palette.primary} />
          <Text style={[styles.actionRowLabel, { color: palette.primary }]}>Réactiver ce produit</Text>
        </Pressable>
      </View>
    <ConfirmSheetHost active={!!(visible)} />
</Modal>
  );
}

// ─── Product Action Sheet ─────────────────────────────────────────────────────

function ProductActionSheet({
  visible,
  product,
  canEdit,
  currency,
  onClose,
  onEdit,
  onAdjustStock,
  onStats,
  onArchive,
}: {
  visible: boolean;
  product: Product | null;
  canEdit: boolean;
  currency: string;
  onClose: () => void;
  onEdit: () => void;
  onAdjustStock: () => void;
  onStats: () => void;
  onArchive: () => void;
}) {
  const { palette } = useTheme();
  const insets = useSafeAreaInsets();
  const styles = useMemo(() => makeStyles(palette), [palette]);

  if (!product) return null;

  const stockLabel = product.has_variants
    ? 'Plusieurs tailles / couleurs'
    : `${product.stock_qty} ${product.unit} · ${formatPrice(product.sale_price, currency)}`;

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose} statusBarTranslucent navigationBarTranslucent>
      <Pressable style={styles.actionSheetOverlay} onPress={onClose} />
      <View style={[styles.actionSheet, { paddingBottom: Math.max(insets.bottom, spacing[4]) }]}>
        <View style={styles.sheetHandle} />
        <View style={styles.actionSheetHeader}>
          <Text variant="h4" numberOfLines={1}>{product.name}</Text>
          <Text variant="caption" color="secondary">{stockLabel}</Text>
        </View>

        {canEdit && (
          <Pressable
            style={({ pressed }) => [styles.actionRow, pressed && { opacity: 0.65 }]}
            onPress={onEdit}
          >
            <Ionicons name="create-outline" size={22} color={palette.textPrimary} />
            <Text style={styles.actionRowLabel}>
              {product.has_variants ? 'Modifier · Gérer les modèles' : 'Modifier'}
            </Text>
            <Ionicons name="chevron-forward" size={16} color={palette.textDisabled} />
          </Pressable>
        )}

        {canEdit && !product.has_variants && (
          <Pressable
            style={({ pressed }) => [styles.actionRow, pressed && { opacity: 0.65 }]}
            onPress={onAdjustStock}
          >
            <Ionicons name="layers-outline" size={22} color={palette.textPrimary} />
            <Text style={styles.actionRowLabel}>Ajuster le stock</Text>
            <Ionicons name="chevron-forward" size={16} color={palette.textDisabled} />
          </Pressable>
        )}

        <Pressable
          style={({ pressed }) => [styles.actionRow, pressed && { opacity: 0.65 }]}
          onPress={onStats}
        >
          <Ionicons name="bar-chart-outline" size={22} color={palette.textPrimary} />
          <Text style={styles.actionRowLabel}>Voir la rentabilité</Text>
          <Ionicons name="chevron-forward" size={16} color={palette.textDisabled} />
        </Pressable>

        {canEdit && (
          <>
            <View style={{ height: 1, backgroundColor: palette.border, marginTop: spacing[2] }} />
            <Pressable
              style={({ pressed }) => [styles.actionRow, pressed && { opacity: 0.65 }]}
              onPress={onArchive}
            >
              <Ionicons name="archive-outline" size={22} color={palette.warning} />
              <Text style={[styles.actionRowLabel, { color: palette.warning }]}>Désactiver</Text>
            </Pressable>
          </>
        )}
      </View>
    <ConfirmSheetHost active={!!(visible)} />
</Modal>
  );
}

// ─── Main Screen ──────────────────────────────────────────────────────────────

export default function CatalogueScreen() {
  const { palette } = useTheme();
  const insets = useSafeAreaInsets();
  const styles = useMemo(() => makeStyles(palette), [palette]);
  const session = useAuthStore(s => s.session);
  const business = session?.activeBusiness;
  const userId = session?.user.id ?? '';
  const businessId = business?.id ?? '';
  const currency = business?.currency ?? 'GNF';
  const role = session?.activeMembership?.role;
  const canEdit = role === 'administrateur' || role === 'manager';

  const { products, archivedProducts, variantsByProduct, loading, saving, offline, offlineSince, fetchProducts, fetchArchivedProducts, fetchVariants, upsertVariants, createProduct, updateProduct, archiveProduct, restoreProduct, adjustStock, fetchProductStats, archivingIds } =
    useProductStore();
  const { fournisseurs, fetchFournisseurs } = useFournisseursStore();

  // Mirrors showFork's 24h boundary in app/(app)/_layout.tsx: the
  // activation fork guides a brand-new merchant to their first product for
  // the first 24h, then stops showing anywhere. If the catalogue is still
  // completely empty (no active AND no archived product — archived alone
  // would mean they've actually used the app before) at that point, this
  // screen needs its own way forward instead of quietly rendering nothing.
  const noProductsAtAll = products.length === 0 && archivedProducts.length === 0;
  const businessAgeMs = business?.created_at
    ? Date.now() - new Date(business.created_at).getTime()
    : Infinity;
  const showActivationEmptyState = canEdit && !offline && noProductsAtAll && businessAgeMs >= 24 * 60 * 60 * 1000;

  const [search, setSearch] = useState('');
  // Initialized straight from the param (not via an effect that fires after
  // the first render) — an effect-driven open meant the bare catalogue
  // screen was visible for a frame before the form slid up on top of it,
  // reading as "arrive, then it opens" instead of one direct motion.
  const { openForm, prefillName } = useLocalSearchParams<{ openForm?: string; prefillName?: string }>();
  const [showForm, setShowForm] = useState(openForm === '1');
  const [editingProduct, setEditingProduct] = useState<Product | null>(null);
  // Set only by the "no search match" create-shortcut below; cleared on every
  // other way of opening the form so a stale searched name never leaks into
  // an unrelated "Ajouter un produit" tap.
  const [prefillProductName, setPrefillProductName] = useState<string | undefined>(undefined);

  // Catalogue is a tab screen and stays mounted after the first visit, so
  // the useState initializer above only ever fires the very first time —
  // this effect re-applies openForm on every fresh arrival too (same fix
  // vendre.tsx needed for its mode param), or every "Un produit" tap after
  // the first one on an already-mounted Catalogue silently did nothing.
  useEffect(() => {
    if (openForm === '1') {
      setEditingProduct(null);
      setPrefillProductName(prefillName ?? undefined);
      setShowForm(true);
      router.setParams({ openForm: undefined, prefillName: undefined });
    }
  }, [openForm, prefillName]);

  const [showAdjust, setShowAdjust] = useState(false);
  const [adjustTarget, setAdjustTarget] = useState<Product | null>(null);
  const [tab, setTab] = useState<'actifs' | 'archives'>('actifs');

  // Search is shown once the CURRENT tab's own list is big enough to need it
  // — an active catalogue of 3 products with 40 archived items shouldn't get
  // a search box just because the archive is long.
  const searchVisible = (tab === 'actifs' ? products.length : archivedProducts.length) >= SEARCH_VISIBILITY_THRESHOLD;
  useAnimateLayoutChange(searchVisible);
  // Clear a typed query when the box disappears (list shrank, or a tab
  // switch landed on a shorter list) so it can't silently keep narrowing
  // whichever tab is current with no visible input left to clear it.
  useEffect(() => {
    if (!searchVisible) setSearch('');
  }, [searchVisible]);
  const [successMsg, setSuccessMsg] = useState('');
  const [showStats, setShowStats] = useState(false);
  const [statsTarget, setStatsTarget] = useState<Product | null>(null);
  const [showOutOfStockModal, setShowOutOfStockModal] = useState(false);
  const [initialVariants, setInitialVariants] = useState<import('@/src/types').ProductVariant[]>([]);
  const [showActionSheet, setShowActionSheet] = useState(false);
  const [actionSheetProduct, setActionSheetProduct] = useState<Product | null>(null);
  const [showRestoreSheet, setShowRestoreSheet] = useState(false);
  const [restoreSheetProduct, setRestoreSheetProduct] = useState<Product | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    if (editingProduct?.has_variants && businessId) {
      const cached = variantsByProduct[editingProduct.id];
      if (cached) {
        setInitialVariants(cached);
      } else {
        fetchVariants(editingProduct.id, businessId).then(v => setInitialVariants(v));
      }
    } else {
      setInitialVariants([]);
    }
  }, [editingProduct, businessId]);

  const showSuccess = useCallback((msg: string) => {
    setSuccessMsg(msg);
    setTimeout(() => setSuccessMsg(''), 2500);
  }, []);

  useEffect(() => {
    if (businessId) {
      fetchProducts(businessId, userId, session?.activeMembership?.id, session?.activeMembership?.role);
      fetchFournisseurs(businessId);
      // Also needed on mount (not just on tab switch, see the effect below)
      // so showActivationEmptyState can tell "truly zero products anywhere"
      // apart from "zero active, but some archived" without waiting for the
      // merchant to visit the Non actifs tab first.
      fetchArchivedProducts(businessId);
    }
  }, [businessId]);

  useFocusEffect(
    useCallback(() => {
      if (businessId) fetchProducts(businessId, userId, session?.activeMembership?.id, session?.activeMembership?.role);
    }, [businessId, userId]),
  );

  useEffect(() => {
    if (businessId && tab === 'archives') {
      fetchArchivedProducts(businessId);
    }
  }, [tab, businessId]);

  // The last non-active product was reactivated while this tab was open: the
  // toggle just disappeared, so land back on Actifs instead of an empty tab
  // with no control to leave it.
  useEffect(() => {
    if (tab === 'archives' && archivedProducts.length === 0) setTab('actifs');
  }, [tab, archivedProducts.length]);

  const onRefresh = useCallback(async () => {
    if (!businessId) return;
    setRefreshing(true);
    await (tab === 'archives' ? fetchArchivedProducts(businessId) : fetchProducts(businessId, userId, session?.activeMembership?.id, session?.activeMembership?.role));
    setRefreshing(false);
  }, [businessId, userId, tab]);

  useEffect(() => {
    if (!businessId || products.length === 0) return;
    products.filter(p => p.has_variants && !variantsByProduct[p.id])
      .forEach(p => fetchVariants(p.id, businessId));
  }, [products, businessId]);

  const activeFiltered = useMemo(() => {
    const q = search.toLowerCase().trim();
    const base = q ? products.filter(p => p.name.toLowerCase().includes(q)) : products;
    return [...base].sort((a, b) => {
      const tierA = a.reorder_level > 0 && a.stock_qty > 0 && a.stock_qty <= a.reorder_level ? 1 : 0;
      const tierB = b.reorder_level > 0 && b.stock_qty > 0 && b.stock_qty <= b.reorder_level ? 1 : 0;
      if (tierA !== tierB) return tierA - tierB;
      return a.name.localeCompare(b.name, 'fr');
    });
  }, [products, search]);

  const inStockActive = useMemo(
    () => activeFiltered.filter(p => {
      if (!p.has_variants) return p.stock_qty > 0;
      const variants = variantsByProduct[p.id];
      if (!variants || variants.length === 0) return true;
      return variants.some(v => v.stock_qty > 0);
    }),
    [activeFiltered, variantsByProduct],
  );
  const outOfStockActive = useMemo(
    () => [...products].filter(p => {
      if (!p.has_variants) return p.stock_qty === 0;
      const variants = variantsByProduct[p.id];
      if (!variants || variants.length === 0) return false;
      return variants.every(v => v.stock_qty <= 0);
    }).sort((a, b) => a.name.localeCompare(b.name, 'fr')),
    [products, variantsByProduct],
  );

  const archivedFiltered = useMemo(() => {
    const q = search.toLowerCase().trim();
    if (!q) return archivedProducts;
    return archivedProducts.filter(p => p.name.toLowerCase().includes(q));
  }, [archivedProducts, search]);

  const openOptions = useCallback((product: Product) => {
    setActionSheetProduct(product);
    setShowActionSheet(true);
  }, []);

  const closeActionSheet = useCallback(() => setShowActionSheet(false), []);

  const handleActionEdit = useCallback(() => {
    if (!actionSheetProduct) return;
    setShowActionSheet(false);
    setEditingProduct(actionSheetProduct);
    setShowForm(true);
  }, [actionSheetProduct]);

  const handleActionAdjust = useCallback(() => {
    if (!actionSheetProduct) return;
    setShowActionSheet(false);
    setAdjustTarget(actionSheetProduct);
    setShowAdjust(true);
  }, [actionSheetProduct]);

  const handleActionStats = useCallback(() => {
    if (!actionSheetProduct) return;
    setShowActionSheet(false);
    setStatsTarget(actionSheetProduct);
    setShowStats(true);
  }, [actionSheetProduct]);

  const handleActionArchive = useCallback(() => {
    const product = actionSheetProduct;
    if (!product) return;
    setShowActionSheet(false);
    setTimeout(() => {
      appAlert(
        'Désactiver ce produit ?',
        `"${product.name}" sera retiré du catalogue actif. Vous pourrez le réactiver depuis l'onglet Non actifs.`,
        [
          { text: 'Annuler', style: 'cancel' },
          {
            text: 'Désactiver', style: 'destructive',
            onPress: async () => {
              const archived = await archiveProduct(product.id, businessId);
              if (!archived) {
                haptics.error();
                failAlert('productNotArchived', {
                  err: useProductStore.getState().error, label: 'Réessayer',
                  onPress: () => { void archiveProduct(product.id, businessId); },
                });
                return;
              }
              haptics.destructive();
              markRowRemoved(product.id); // so Annuler fades the row back in
              // Archiving is a flag flip, so it can be undone: Annuler = restoreProduct.
              useSaveConfirmationStore.getState().show({
                message: archivedConfirmation(product.name),
                tone: 'success',
                undo: async () => { await restoreProduct(product.id, businessId, userId); },
              });
            },
          },
        ],
      );
    }, 350);
  }, [actionSheetProduct, archiveProduct, restoreProduct, businessId, userId]);

  const handleSave = useCallback(
    async (data: CreateProductData, hasVariants: boolean, variants: DraftVariant[]) => {
      let ok: boolean;
      let createdProduct: Product | null = null;
      if (editingProduct) {
        ok = await updateProduct(businessId, userId, editingProduct.id, data);
        if (ok) {
          await upsertVariants(businessId, editingProduct.id, userId, hasVariants ? variants : []);
        }
      } else {
        ok = await createProduct(businessId, userId, data);
        if (ok) {
          const nameLower = data.name.trim().toLowerCase();
          createdProduct = useProductStore.getState().products.find(
            p => p.name.trim().toLowerCase() === nameLower,
          ) ?? null;
          if (createdProduct && hasVariants && variants.length > 0) {
            await upsertVariants(businessId, createdProduct.id, userId, variants);
          }
        }
      }
      if (ok) {
        haptics.success();
        setShowForm(false);
        const wasNewProduct = !editingProduct;
        setEditingProduct(null);
        if (wasNewProduct) {
          const savedProduct = createdProduct;
          useSaveConfirmationStore.getState().show({
            message: productConfirmation(data.name.trim()),
            tone: 'success',
            // Compensating action: a just-created product has no sales/stock
            // history yet, so archiving it is safe regardless of whether the
            // create already synced or is still queued offline (archiveProduct
            // is a plain flag flip either way, not a delete — see stores/products.ts).
            undo: savedProduct
              ? async () => { await archiveProduct(savedProduct.id, businessId); }
              : undefined,
            onEdit: savedProduct
              ? () => { setEditingProduct(savedProduct); setShowForm(true); }
              : undefined,
          });
        } else {
          showSuccess('Produit mis à jour ✓');
        }
        // First value moment (or a later one, capped at twice) — only for a
        // genuinely new product, not an edit.
        if (wasNewProduct) activationPriming.maybeTrigger();
      } else {
        haptics.error();
        // The sheet stays open with everything typed; one action re-fires the same save.
        showFailureAlert(buildFailure({
          what: FAILURE_COPY.productNotSaved.what,
          why: failureReason(useProductStore.getState().error) ?? FAILURE_COPY.productNotSaved.why,
          action: { label: 'Réessayer', onPress: () => { void handleSaveRef.current?.(data, hasVariants, variants); } },
        }));
      }
    },
    [editingProduct, businessId, userId, createProduct, updateProduct, upsertVariants, showSuccess, archiveProduct],
  );

  const handleSaveRef = useRef<typeof handleSave>(handleSave);
  handleSaveRef.current = handleSave;

  const handleAdjust = useCallback(
    async (qty: number, type: 'entree' | 'perte', note: string) => {
      if (!adjustTarget) return;
      const ok = await adjustStock(adjustTarget.id, businessId, userId, qty, type, note);
      if (ok) {
        setShowAdjust(false);
        setAdjustTarget(null);
        showSuccess('Stock ajusté ✓');
      } else {
        haptics.error();
        toast.warning(useProductStore.getState().error ?? 'Erreur d\'ajustement');
      }
    },
    [adjustTarget, businessId, userId, adjustStock, showSuccess],
  );

  const displayList = tab === 'actifs' ? inStockActive : archivedFiltered;

  return (
    <Screen tab>
      {/* Post-action banners */}
      {successMsg ? (
        <View style={styles.successBanner}>
          <Text variant="label" style={{ color: palette.textInverse }}>{successMsg}</Text>
        </View>
      ) : null}

      {offline && (
        <OfflineNotice offlineSince={offlineSince} onRetry={() => fetchProducts(businessId, userId, session?.activeMembership?.id, session?.activeMembership?.role)} />
      )}

      {/* Header */}
      <View style={styles.header}>
        <View>
          <Text variant="h3">Produits</Text>
          {/* Count only when the current tab's list is non-empty — never "0 produits"
              / "0 non actif", and nothing while the first fetch is still in flight. */}
          {!showActivationEmptyState && (tab === 'actifs' ? products.length > 0 : archivedProducts.length > 0) && (
            <Text variant="caption" color="secondary">
              {tab === 'actifs'
                ? `${products.length} produit${products.length !== 1 ? 's' : ''}`
                : `${archivedProducts.length} non actif${archivedProducts.length !== 1 ? 's' : ''}`}
            </Text>
          )}
        </View>
        {/* Currency declared once here instead of repeated on every row's
            price (see formatPriceValue in ProductRow) — archived rows don't
            show a price at all, so this only applies to Actifs. */}
        {!showActivationEmptyState && tab === 'actifs' && products.length > 0 && (
          <Text variant="caption" color="secondary">Prix ({currency})</Text>
        )}
      </View>

      {/* Tabs — hidden once the 24h onboarding window has closed on a still
          completely empty catalogue; nothing to switch between yet. */}
      {/* The "Non actifs" toggle only exists once at least one product has been
          deactivated — with none, there is nothing to switch to and the control
          is pure noise. (archivedProducts is fetched eagerly on mount, so this
          is reliable before it is ever evaluated; while that fetch is in flight
          the toggle is simply absent, never flashing in and out.) */}
      {!showActivationEmptyState && archivedProducts.length > 0 && (
        <View style={styles.tabRow}>
          <ArchiveSwitch value={tab} onChange={setTab} />
        </View>
      )}

      {searchVisible && (
        <View style={styles.searchRow}>
          <Input placeholder="Rechercher un produit…" value={search} onChangeText={setSearch} style={{ flex: 1 }} />
        </View>
      )}

      {/* Stats row (actifs only). "Valeur du stock" is cost_price-derived —
          hidden for vendeur to match the real data-level gate (cost_price is
          always 0 in their own fetched data as of migration_v193.sql; this
          is the display-side complement, not a substitute for it, since a
          raw "0 GNF" would just look like a bug rather than actually hidden). */}
      {products.length > 0 && tab === 'actifs' && (
        <View style={styles.statsCard}>
          {role !== 'vendeur' && (
            <View style={styles.statCol}>
              <Text variant="caption" color="secondary">Valeur du stock</Text>
              <Text style={styles.statValue}>
                {formatPrice(
                  products.filter(p => !p.has_variants).reduce((s, p) => s + p.cost_price * p.stock_qty, 0) +
                  Object.values(variantsByProduct).flat().reduce((s, v) => s + v.cost_price * v.stock_qty, 0),
                  currency,
                )}
              </Text>
            </View>
          )}
          {outOfStockActive.length > 0 && (
            <>
              <View style={styles.statDivider} />
              <Pressable style={[styles.statCol, { alignItems: 'flex-end' }]} onPress={() => setShowOutOfStockModal(true)}>
                <Text variant="caption" color="secondary" style={{ textAlign: 'right' }}>
                  {outOfStockActive.length === 1
                    ? '1 produit est fini'
                    : `${outOfStockActive.length} produits sont finis`}
                </Text>
                <Text style={[styles.statValue, { color: palette.primary }]}>Voir</Text>
              </Pressable>
            </>
          )}
        </View>
      )}

      {/* Product list */}
      {loading && products.length === 0 ? (
        <SkeletonList count={8} />
      ) : tab === 'actifs' && products.length === 0 ? (
        !offline && canEdit ? (
          // One consistent empty state regardless of the 24h activation-fork
          // window — the fork is a modal that overlays whatever's behind it
          // when it shows, so there's no real conflict with also having a
          // real inline action here. The floating FAB stays hidden while the
          // list is empty (see fabContainer below) so it can never collide
          // with this block's own button.
          <EmptyState
            icon="cube-outline"
            title="Aucun produit pour le moment."
            subtitle="Ajoutez ce que vous vendez pour aller plus vite à la caisse."
            actionLabel="+ Ajouter un produit"
            onAction={() => { setEditingProduct(null); setPrefillProductName(undefined); setShowForm(true); }}
          />
        ) : (
          <EmptyState
            icon={offline ? 'cloud-offline-outline' : 'cube-outline'}
            title={offline ? 'Catalogue non disponible hors ligne' : 'Catalogue vide'}
            subtitle={offline
              ? 'Ouvrez l\'application en ligne une première fois pour activer le mode hors ligne.'
              : 'Votre responsable ajoutera les produits bientôt.'}
          />
        )
      ) : tab === 'archives' && archivedFiltered.length === 0 ? (
        // Two distinct states, never conflated: a search with no match must
        // never read as "your archive is empty" — that would make a merchant
        // fear her archived products are gone, when they simply don't match
        // what she typed.
        search.trim() ? (
          <NoResultsState query={search} />
        ) : (
          <EmptyState
            icon="cube-outline"
            title="Aucun produit non actif pour le moment."
            subtitle="Les produits que vous désactivez apparaîtront ici."
          />
        )
      ) : (
        // Inset, rounded container matching the search field / "Valeur du
        // stock" card above it — the list used to be a full-width, sharp-
        // edged block with no visual relationship to those. overflow:
        // 'hidden' is what clips the first/last row's corners to the
        // container's own radius instead of them staying square.
        <View style={styles.listContainer}>
          <FlatList
            style={{ flex: 1 }}
            data={displayList}
            keyExtractor={p => p.id}
            CellRendererComponent={AnimatedRowCell}
            renderItem={({ item }) => (
              <ProductRow
                product={item}
                currency={currency}
                archived={tab === 'archives'}
                variants={variantsByProduct[item.id]}
                archiving={archivingIds.includes(item.id)}
                onPress={() => {
                  if (tab === 'archives') {
                    setRestoreSheetProduct(item);
                    setShowRestoreSheet(true);
                    return;
                  }
                  openOptions(item);
                }}
                onLongPress={() => tab === 'archives' ? undefined : openOptions(item)}
              />
            )}
            ItemSeparatorComponent={() => <View style={styles.separator} />}
            contentContainerStyle={styles.list}
            showsVerticalScrollIndicator={false}
            keyboardShouldPersistTaps="handled"
            refreshControl={
              <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={palette.primary} colors={[palette.primary]} />
            }
            ListEmptyComponent={
              search.trim() ? (
                <NoResultsState
                  query={search}
                  createLabel={`+ Nouveau produit « ${search.trim()} »`}
                  onCreate={() => {
                    setEditingProduct(null);
                    setPrefillProductName(search.trim());
                    setShowForm(true);
                  }}
                />
              ) : null
            }
          />
        </View>
      )}

      {/* Out-of-stock bottom sheet */}
      <Modal
        visible={showOutOfStockModal}
        animationType="slide"
        transparent
        onRequestClose={() => setShowOutOfStockModal(false)}
        statusBarTranslucent
        navigationBarTranslucent
      >
        <Pressable style={styles.outOfStockOverlay} onPress={() => setShowOutOfStockModal(false)} />
        <View style={styles.outOfStockSheet}>
          <View style={styles.sheetHandle} />
          <View style={[styles.header, { paddingTop: spacing[2] }]}>
            <View>
              <Text variant="h4">Produits finis</Text>
              <Text variant="caption" color="secondary">
                {outOfStockActive.length} produit{outOfStockActive.length !== 1 ? 's' : ''} à racheter
              </Text>
            </View>
            <Pressable onPress={() => setShowOutOfStockModal(false)} style={{ padding: spacing[2] }} accessibilityLabel="Fermer" accessibilityRole="button">
              <Ionicons name="close" size={22} color={palette.textSecondary} />
            </Pressable>
          </View>
          <FlatList
            data={outOfStockActive}
            keyExtractor={p => p.id}
            renderItem={({ item }) => (
              <ProductRow
                product={item}
                currency={currency}
                variants={variantsByProduct[item.id]}
                onPress={() => {
                  setShowOutOfStockModal(false);
                  setTimeout(() => openOptions(item), 350);
                }}
              />
            )}
            ItemSeparatorComponent={() => <View style={styles.separator} />}
            contentContainerStyle={[styles.list, { paddingBottom: insets.bottom + spacing[4] }]}
            showsVerticalScrollIndicator={false}
          />
        </View>
      <ConfirmSheetHost active={!!(showOutOfStockModal)} />
</Modal>

      {/* Restore Action Sheet (archived products) */}
      <RestoreActionSheet
        visible={showRestoreSheet}
        product={restoreSheetProduct}
        onClose={() => setShowRestoreSheet(false)}
        onRestore={() => {
          if (!restoreSheetProduct) return;
          const p = restoreSheetProduct;
          setShowRestoreSheet(false);
          restoreProduct(p.id, businessId, userId);
          showSuccess(`${p.name} réactivé ✓`);
        }}
      />

      {/* Product Action Sheet */}
      <ProductActionSheet
        visible={showActionSheet}
        product={actionSheetProduct}
        canEdit={canEdit}
        currency={currency}
        onClose={closeActionSheet}
        onEdit={handleActionEdit}
        onAdjustStock={handleActionAdjust}
        onStats={handleActionStats}
        onArchive={handleActionArchive}
      />

      {/* Product Form Modal */}
      <ProductFormModal
        visible={showForm}
        editing={editingProduct}
        onClose={() => { setShowForm(false); setEditingProduct(null); setPrefillProductName(undefined); }}
        onSave={handleSave}
        saving={saving}
        currency={currency}
        fournisseurs={fournisseurs}
        businessId={businessId}
        userId={userId}
        initialVariants={initialVariants}
        initialName={prefillProductName}
      />

      {/* Stock Adjust Modal */}
      <StockAdjustModal
        visible={showAdjust}
        product={adjustTarget}
        onClose={() => { setShowAdjust(false); setAdjustTarget(null); }}
        onConfirm={handleAdjust}
        saving={saving}
        currency={currency}
      />

      {/* Product Stats Modal */}
      <ProductStatsModal
        visible={showStats}
        product={statsTarget}
        onClose={() => { setShowStats(false); setStatsTarget(null); }}
        businessId={businessId}
        currency={currency}
        fetchStats={fetchProductStats}
      />

      {canEdit && tab === 'actifs' && products.length > 0 && (
        <View style={styles.fabContainer}>
          <Pressable
            onPress={() => { setEditingProduct(null); setPrefillProductName(undefined); setShowForm(true); }}
            style={({ pressed }) => [styles.fabExtended, pressed && { opacity: 0.82 }]}
            accessibilityLabel="Ajouter un produit"
            accessibilityRole="button"
          >
            <Ionicons name="add" size={20} color={palette.textInverse} />
            <Text style={styles.fabExtendedLabel}>Produit</Text>
          </Pressable>
        </View>
      )}
    </Screen>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

function makeStyles(p: Palette) {
  return StyleSheet.create({
    safe: { flex: 1, backgroundColor: p.background },
    successBanner: {
      backgroundColor: p.success, paddingHorizontal: spacing[5], paddingVertical: spacing[3],
      alignItems: 'center',
    },
    detailPromptBanner: {
      backgroundColor: p.success, paddingHorizontal: spacing[5], paddingVertical: spacing[3],
      flexDirection: 'row', alignItems: 'center',
    },
    header: {
      flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
      paddingHorizontal: spacing[5], paddingTop: spacing[4], paddingBottom: spacing[3],
    },
    tabRow: {
      flexDirection: 'row',
      paddingHorizontal: spacing[5], paddingBottom: spacing[3],
    },
    // Fixed width, not flex/intrinsic — the two switchOption labels below
    // use flex:1 each, so they need a resolved parent width to split
    // evenly; that's also what keeps the sliding thumb's "half the track"
    // math exact regardless of which label is longer ("Non actifs" vs "Actifs").
    switchTrack: {
      flexDirection: 'row',
      width: 224, height: 40,
      borderRadius: radius.full,
      backgroundColor: p.background,
      borderWidth: 1, borderColor: p.border,
      position: 'relative',
    },
    switchThumb: {
      position: 'absolute',
      top: 3, bottom: 3, left: 3,
      borderRadius: radius.full,
      backgroundColor: p.primary,
      ...shadow.sm,
    },
    switchOption: { flex: 1, alignItems: 'center', justifyContent: 'center', zIndex: 1 },
    alertBanner: {
      backgroundColor: p.warningLight, paddingHorizontal: spacing[5], paddingVertical: spacing[2],
      borderBottomWidth: 1, borderBottomColor: p.warning,
    },
    searchRow: { paddingHorizontal: spacing[5], paddingBottom: spacing[3] },
    statsCard: {
      flexDirection: 'row',
      marginHorizontal: spacing[5],
      marginBottom: spacing[3],
      backgroundColor: p.surface,
      borderWidth: 1,
      borderColor: p.border,
      borderRadius: radius.md,
      paddingVertical: spacing[3],
      paddingHorizontal: spacing[4],
    },
    statCol: { flex: 1, gap: 3 },
    statDivider: { width: 1, backgroundColor: p.border, marginHorizontal: spacing[4] },
    statValue: { fontFamily: FF.bold, fontSize: 18, color: p.textPrimary },
    // Horizontal inset now lives on listContainer's own margin below, not
    // here — the FlatList's content spans the container's full width, with
    // each row supplying its own horizontal padding instead.
    list: { paddingBottom: spacing[10] },
    // Same radius/border/surface language as statsCard and the search
    // field above it — same radius.md token, not a one-off literal value.
    listContainer: {
      flex: 1,
      marginHorizontal: spacing[5],
      borderRadius: radius.md,
      borderWidth: 1, borderColor: p.border,
      backgroundColor: p.surface,
      overflow: 'hidden',
    },
    separator: { height: 0 },
    productRow: {
      flexDirection: 'row', alignItems: 'center',
      paddingHorizontal: spacing[4], paddingVertical: spacing[4],
      borderBottomWidth: 1, borderBottomColor: p.border,
      backgroundColor: p.surface,
    },
    // One neutral tile token for every product — no per-item hash color.
    // Swap this for the real product photo once catalogue photos ship.
    productBadge: {
      width: 44, height: 44, borderRadius: radius.md,
      alignItems: 'center', justifyContent: 'center',
      marginRight: 0,
      backgroundColor: p.background, borderWidth: 1, borderColor: p.border,
    },
    productBadgeText: { fontFamily: FF.semibold, fontSize: 16, color: p.textSecondary },
    // minWidth: 0 lets this column actually shrink below its content's
    // natural width — without it, a long product name can push the
    // trailing price/chevron group past the row's edge instead of the
    // name truncating.
    productCenter: { flex: 1, minWidth: 0, paddingLeft: 12, gap: 3 },
    productName: { fontFamily: FF.semibold, fontSize: 16, color: p.textPrimary },
    productStockText: { fontFamily: FF.regular, fontSize: 13, color: p.textSecondary },
    productMeta: { flexDirection: 'row', gap: spacing[2], alignItems: 'center' },
    categoryBadge: {
      backgroundColor: p.primaryLight, borderRadius: radius.sm,
      paddingHorizontal: spacing[1.5], paddingVertical: 2,
    },
    bulkBadge: {
      backgroundColor: p.warningLight, borderRadius: radius.sm,
      paddingHorizontal: spacing[1.5], paddingVertical: 2, borderWidth: 1, borderColor: p.warning,
    },
    // flexShrink: 0 — the trailing price+chevron group never shrinks or
    // wraps; productCenter's minWidth: 0 above is what gives it the room
    // to hold its own full width by taking space from the name instead.
    productRight: { alignItems: 'flex-end', flexShrink: 0 },
    priceRow: { flexDirection: 'row', alignItems: 'center', gap: spacing[1] },
    // Neutral, same weight as the product name — ordinary prices are not an
    // accent moment. Tabular figures keep the column aligned as it scrolls.
    priceText: {
      fontFamily: FF.semibold, fontSize: 15, color: p.textPrimary,
      fontVariant: ['tabular-nums'] as ['tabular-nums'],
    },
    // 194 was tuned against the old flush tab bar's flex space; the floating
    // pill no longer reserves that space, so the same clearance is added
    // here too to keep this FAB sitting exactly where it did before.
    fabContainer: { position: 'absolute', bottom: 194 + FLOATING_TAB_BAR_CLEARANCE, right: spacing[4], zIndex: 10 },
    // The floating "Ajouter un produit" pill — labeled instead of a bare
    // icon, per the calm-catalogue redesign. Auto-width, floating bottom-right.
    fabExtended: {
      flexDirection: 'row', alignItems: 'center', gap: spacing[2],
      height: 56, paddingHorizontal: spacing[5], borderRadius: radius.full,
      backgroundColor: p.primary,
      shadowColor: p.shadow, shadowOffset: { width: 0, height: 4 },
      shadowOpacity: 0.18, shadowRadius: 8, elevation: 8,
    },
    fabExtendedLabel: { fontFamily: FF.semibold, fontSize: 15, color: p.textInverse },

    modalSafe: { flex: 1, backgroundColor: p.background },
    modalHeader: {
      flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
      paddingHorizontal: spacing[5], paddingVertical: spacing[4],
      borderBottomWidth: 1, borderBottomColor: p.border, backgroundColor: p.surface,
    },
    modalCancel: { minWidth: 64 },
    modalContent: { padding: spacing[5], gap: spacing[4] },
    // Depth from a soft upward shadow instead of a tinted panel + hairline —
    // background matches the screen itself so there's no visible "canvas"
    // behind the button, just enough shadow to read as pinned above the
    // scrollable content on both platforms (shadow props on iOS, elevation
    // on Android — shadow.md already bundles both).
    modalFooter: {
      padding: spacing[5], backgroundColor: p.background,
      ...shadow.md, shadowOffset: { width: 0, height: -2 },
    },
    formError: { backgroundColor: p.warningLight, borderRadius: radius.md, padding: spacing[3] },

    formStack: {},
    fieldBlock: {
      paddingHorizontal: spacing[5], paddingTop: spacing[2.5], paddingBottom: spacing[2.5],
      borderBottomWidth: 1, borderBottomColor: p.border, gap: spacing[1.5],
    },
    fieldLabel: {
      fontFamily: FF.semibold, fontSize: 11, color: p.textSecondary,
      letterSpacing: 0.6, textTransform: 'uppercase' as const,
    },
    fieldInput: { fontFamily: FF.semibold, fontSize: 22, color: p.textPrimary, paddingVertical: 0, minHeight: 36 },
    fieldRow: { flexDirection: 'row', alignItems: 'center', gap: spacing[3] },
    unitTag: { fontFamily: FF.medium, fontSize: 15, color: p.textSecondary },
    liveCalcBlock: {
      paddingHorizontal: spacing[5], paddingVertical: spacing[2.5],
      borderBottomWidth: 1, borderBottomColor: p.border,
    },
    liveCalcText: { fontFamily: FF.medium, fontSize: 14, color: p.textSecondary },
    detailsBtn: {
      paddingHorizontal: spacing[5], paddingVertical: spacing[3],
      alignItems: 'center' as const,
      borderBottomWidth: 1, borderBottomColor: p.border,
    },
    priceAccessoryBar: {
      flexDirection: 'row', justifyContent: 'flex-end',
      paddingHorizontal: spacing[4], paddingVertical: spacing[2.5],
      backgroundColor: p.surface, borderTopWidth: 1, borderTopColor: p.border,
    },

    pickerField: {
      flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
      paddingHorizontal: spacing[4], paddingVertical: spacing[3],
      borderRadius: radius.md, borderWidth: 1, backgroundColor: p.surface,
    },
    supplierDropdown: { borderTopWidth: 1, borderTopColor: p.border, backgroundColor: p.surface },
    supplierRow: {
      paddingHorizontal: spacing[5], paddingVertical: spacing[3],
      borderBottomWidth: 1, borderBottomColor: p.border, gap: 2,
    },
    supplierRowActive: { backgroundColor: p.primaryLight },
    newSupplierForm: {
      paddingHorizontal: spacing[5], paddingVertical: spacing[4],
      gap: spacing[3],
      borderTopWidth: 1, borderTopColor: p.border,
      backgroundColor: p.surface,
    },

    statsRow: {
      flexDirection: 'row' as const,
      justifyContent: 'space-between' as const,
      alignItems: 'center' as const,
      paddingVertical: spacing[3],
      paddingHorizontal: spacing[4],
    },
    statsRowBorder: { borderTopWidth: 1, borderTopColor: p.border },

    stockPreview: { alignItems: 'center', gap: spacing[1] },
    typeRow: { flexDirection: 'row', gap: spacing[3] },
    typeChip: {
      flex: 1, alignItems: 'center', paddingVertical: spacing[3],
      borderRadius: radius.md, borderWidth: 1.5, borderColor: p.border, backgroundColor: p.surface,
    },
    typeChipEntree: { backgroundColor: p.success, borderColor: p.success },
    typeChipPerte: { backgroundColor: p.warning, borderColor: p.warning },

    variantBadge: {
      alignSelf: 'flex-start',
      backgroundColor: p.primaryLight,
      borderRadius: radius.full,
      paddingHorizontal: 8, paddingVertical: 3,
    },
    variantBadgeText: { fontFamily: FF.medium, fontSize: 12, color: p.primary },
    variantToggleRow: {
      flexDirection: 'row', alignItems: 'center',
      paddingHorizontal: spacing[5], paddingVertical: spacing[4],
      borderBottomWidth: 1, borderBottomColor: p.border,
      gap: spacing[3],
    },
    variantList: { borderTopWidth: 1, borderTopColor: p.border },
    variantRowHeader: {
      flexDirection: 'row', alignItems: 'center',
      paddingHorizontal: spacing[5], paddingVertical: spacing[2],
      borderBottomWidth: 1, borderBottomColor: p.border,
      gap: spacing[2],
    },
    variantExpandBtn: { paddingHorizontal: spacing[2] },
    variantListHeader: {
      flexDirection: 'row', alignItems: 'center',
      paddingHorizontal: spacing[5], paddingTop: spacing[3], paddingBottom: spacing[1],
      gap: spacing[2],
    },
    addVariantBtn: {
      flexDirection: 'row', alignItems: 'center',
      paddingHorizontal: spacing[5], paddingVertical: spacing[4],
      borderBottomWidth: 1, borderBottomColor: p.border,
    },

    outOfStockOverlay: {
      ...StyleSheet.absoluteFillObject,
      backgroundColor: 'rgba(0,0,0,0.45)',
    },
    outOfStockSheet: {
      position: 'absolute', bottom: 0, left: 0, right: 0,
      backgroundColor: p.surface,
      borderTopLeftRadius: 20, borderTopRightRadius: 20,
      maxHeight: '80%',
      shadowColor: p.shadow, shadowOffset: { width: 0, height: -4 },
      shadowOpacity: 0.12, shadowRadius: 16, elevation: 24,
    },
    sheetHandle: {
      width: 36, height: 4, borderRadius: 2, backgroundColor: p.border,
      alignSelf: 'center', marginTop: spacing[2],
    },
    actionSheetOverlay: {
      ...StyleSheet.absoluteFillObject,
      backgroundColor: 'rgba(0,0,0,0.45)',
    },
    actionSheet: {
      position: 'absolute', bottom: 0, left: 0, right: 0,
      backgroundColor: p.surface,
      borderTopLeftRadius: 20, borderTopRightRadius: 20,
      paddingTop: spacing[2],
      shadowColor: p.shadow, shadowOffset: { width: 0, height: -4 },
      shadowOpacity: 0.12, shadowRadius: 16, elevation: 24,
    },
    actionSheetHeader: {
      paddingHorizontal: spacing[5],
      paddingTop: spacing[3],
      paddingBottom: spacing[4],
      gap: spacing[1],
      borderBottomWidth: 1,
      borderBottomColor: p.border,
    },
    actionRow: {
      flexDirection: 'row' as const,
      alignItems: 'center' as const,
      paddingHorizontal: spacing[5],
      paddingVertical: spacing[4],
      gap: spacing[3],
      borderBottomWidth: 1,
      borderBottomColor: p.border,
    },
    actionRowLabel: {
      flex: 1,
      fontSize: 16,
      fontFamily: FF.regular,
      color: p.textPrimary,
    },
  });
}
