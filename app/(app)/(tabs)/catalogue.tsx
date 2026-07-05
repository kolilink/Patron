import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import {
  Alert,
  Animated,
  Easing,
  FlatList,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { Screen } from '@/src/components/ui/Screen';
import { Button } from '@/src/components/ui/Button';
import { Card } from '@/src/components/ui/Card';
import { Input } from '@/src/components/ui/Input';
import { Text } from '@/src/components/ui/Text';
import { PhoneInput } from '@/src/components/ui/PhoneInput';
import { Ionicons } from '@expo/vector-icons';
import { useTheme, radius, spacing, fontFamily as FF, PRODUCT_BADGE_PALETTE } from '@/src/theme';
import type { Palette } from '@/src/theme';
import type { Product, ProductVariant } from '@/src/types';
import { useAuthStore } from '@/stores/auth';
import { type CreateProductData, type DraftVariant, type ProductStats, useProductStore } from '@/stores/products';
import { useFournisseursStore, type Fournisseur } from '@/stores/fournisseurs';
import { haptics } from '@/lib/haptics';
import { formatAmount, formatAmountInput, parseAmountInput } from '@/src/utils/format';
import { OfflineNotice } from '@/src/components/ui/OfflineNotice';
import { SkeletonList } from '@/src/components/ui/SkeletonPlaceholder';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatPrice(amount: number, currency: string) {
  return `${amount.toLocaleString('fr-FR')} ${currency}`;
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

function productToForm(p: Product): FormState {
  return {
    name: p.name,
    purchase_price: p.cost_price > 0 ? formatAmountInput(String(p.cost_price)) : '',
    extra_fees: '',
    sale_price: formatAmountInput(String(p.sale_price)),
    initial_stock: '',
    purchase_qty: '1',
    reorder_level: p.reorder_level > 0 ? String(p.reorder_level) : '',
    supplier_id: p.supplier_id ?? '',
  };
}

function totalCost(f: FormState): number {
  const qty = Math.max(parseFloat(f.initial_stock) || parseFloat(f.purchase_qty) || 1, 1);
  const fees = parseAmountInput(f.extra_fees);
  return parseAmountInput(f.purchase_price) + fees / qty;
}

function validateForm(f: FormState): string | null {
  if (!f.name.trim()) return 'Indiquez le nom :)';
  const sp = parseAmountInput(f.sale_price);
  if (isNaN(sp) || sp <= 0) return 'Le prix de vente doit être supérieur à 0';
  return null;
}

function formToData(f: FormState): CreateProductData {
  return {
    name: f.name,
    unit: 'pcs',
    cost_price: totalCost(f),
    sale_price: parseAmountInput(f.sale_price),
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
    if (!newName.trim()) { Alert.alert('Ajoutez un nom :)'); return; }
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
            <Text variant="label" style={{ color: palette.primary }}>+ Créer un nouveau fournisseur</Text>
          </Pressable>
        </View>
      )}
      {showNewForm && (
        <View style={styles.newSupplierForm}>
          <Input label="Nom *" value={newName} onChangeText={setNewName} placeholder="Alimentation, Électronique…" />
          <PhoneInput label="Téléphone (optionnel)" onChange={(e164) => setNewPhone(e164)} strict={false} />
          <View style={{ flexDirection: 'row', gap: spacing[2] }}>
            <Button label="Annuler" onPress={() => { setShowNewForm(false); setNewName(''); setNewPhone(''); }} variant="outline" style={{ flex: 1 }} />
            <Button label={fSaving ? '…' : 'Créer'} onPress={handleCreate} loading={fSaving} style={{ flex: 1 }} disabled={!newName.trim()} />
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
}

function generateLocalKey() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

// Extended local type — _overridePrice tracks whether this variant has custom prices
type VariantDraftItem = DraftVariant & { _key: string; _overridePrice: boolean };

interface VariantRowProps {
  variant: VariantDraftItem;
  currency: string;
  onChange: (patch: Partial<VariantDraftItem>) => void;
  onRemove: () => void;
}

function VariantRow({ variant, onChange, onRemove }: Omit<VariantRowProps, 'currency'>) {
  const { palette } = useTheme();
  const styles = useMemo(() => makeStyles(palette), [palette]);
  return (
    <View style={styles.variantRowHeader}>
      <TextInput
        style={[styles.fieldInput, { flex: 1, fontSize: 17 }]}
        value={variant.name}
        onChangeText={v => onChange({ name: v })}
        placeholder="S, M, L, Rouge, 1L…"
        placeholderTextColor={palette.textDisabled}
      />
      <TextInput
        style={[styles.fieldInput, { width: 60, textAlign: 'right', fontSize: 17 }]}
        value={variant.stock_qty > 0 ? String(variant.stock_qty) : ''}
        onChangeText={v => onChange({ stock_qty: parseInt(v) || 0 })}
        keyboardType="number-pad"
        placeholder="0"
        placeholderTextColor={palette.textDisabled}
      />
      <Text style={[styles.unitTag, { marginLeft: 4 }]}>pcs</Text>
      <Pressable onPress={onRemove} hitSlop={10} style={{ paddingHorizontal: 4 }}>
        <Ionicons name="close-circle" size={20} color={palette.textDisabled} />
      </Pressable>
    </View>
  );
}

function makeVariantItem(form: FormState, overrides?: Partial<VariantDraftItem>): VariantDraftItem {
  return {
    _key: generateLocalKey(),
    _overridePrice: false,
    name: '',
    sale_price: parseAmountInput(form.sale_price),
    cost_price: totalCost(form),
    stock_qty: 0,
    reorder_level: 0,
    ...overrides,
  };
}

function ProductFormModal({ visible, editing, onClose, onSave, saving, currency, fournisseurs, businessId, userId, initialVariants }: ProductFormProps) {
  const { palette } = useTheme();
  const styles = useMemo(() => makeStyles(palette), [palette]);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [formError, setFormError] = useState<string | null>(null);
  const [showDetails, setShowDetails] = useState(false);
  const [hasVariants, setHasVariants] = useState(false);
  const [variantDraft, setVariantDraft] = useState<VariantDraftItem[]>([]);
  const nameRef = useRef<TextInput>(null);
  const scrollRef = useRef<ScrollView>(null);
  const insets = useSafeAreaInsets();

  useEffect(() => {
    if (visible) {
      const f = editing ? productToForm(editing) : EMPTY_FORM;
      setForm(f);
      setFormError(null);
      setShowDetails(false);
      const isVariant = editing?.has_variants ?? false;
      setHasVariants(isVariant);
      if (isVariant && initialVariants && initialVariants.length > 0) {
        setVariantDraft(initialVariants.map(v => ({
          _key: v.id,
          _overridePrice: false,
          name: v.name,
          sale_price: v.sale_price,
          cost_price: v.cost_price,
          stock_qty: v.stock_qty,
          reorder_level: v.reorder_level,
        })));
      } else {
        setVariantDraft([]);
      }
      setTimeout(() => nameRef.current?.focus(), 200);
    }
  }, [visible, editing, initialVariants]);

  const setField = (key: keyof FormState) => (val: string) =>
    setForm(prev => ({ ...prev, [key]: val }));

  const handleSave = async () => {
    const err = validateForm(form);
    if (err) { setFormError(err); return; }
    if (hasVariants && variantDraft.length === 0) {
      setFormError('Ajoutez au moins une version');
      return;
    }
    if (hasVariants && variantDraft.some(v => !v.name.trim())) {
      setFormError('Chaque version doit avoir un nom');
      return;
    }
    setFormError(null);
    // Each variant keeps its own loaded price — a new variant already defaults
    // to the parent form's price at creation time (see makeVariantItem), and an
    // existing variant's distinct price must not be clobbered by an unrelated edit.
    await onSave(
      formToData(form),
      hasVariants,
      variantDraft.map(({ _key: _k, _overridePrice: _op, ...v }) => v),
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
  const pp = parseAmountInput(form.purchase_price);
  const sp = parseAmountInput(form.sale_price);
  const computedCost = totalCost(form);
  const fees = parseAmountInput(form.extra_fees);
  const liveInvested = qty * pp + fees;
  const totalVariantStock = variantDraft.reduce((s, v) => s + (v.stock_qty || 0), 0);
  const showLiveCalc = !editing && !hasVariants && liveInvested > 0;
  const showProfitHint = (pp > 0 || computedCost > 0) && sp > 0;

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
          keyboardVerticalOffset={Platform.OS === 'ios' ? 46 : 0}
          style={{ flex: 1 }}
        >
          <SafeAreaView style={styles.modalSafe} edges={['bottom']}>
            <View style={styles.modalHeader}>
              <Pressable onPress={onClose} style={styles.modalCancel}>
                <Text variant="body" color="secondary">Annuler</Text>
              </Pressable>
              <Text variant="h4">{editing ? 'Modifier le produit' : 'Nouveau produit'}</Text>
              <View style={{ width: 64 }} />
            </View>

            <ScrollView
              ref={scrollRef}
              style={{ flexGrow: 1 }}
              contentContainerStyle={[styles.formStack, { paddingBottom: 16 }]}
              keyboardShouldPersistTaps="handled"
            >
              {formError && (
                <View style={styles.formError}>
                  <Text variant="bodySmall" color="danger">{formError}</Text>
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
                />
              </View>

              {/* 2 — Variant toggle (early, before prices) */}
              <View style={styles.variantToggleRow}>
                <View style={{ flex: 1 }}>
                  <Text variant="body" style={{ fontFamily: FF.medium }}>Ce produit a des variétés ?</Text>
                  <Text variant="caption" color="secondary">Tailles, couleurs, volumes…</Text>
                </View>
                <Switch
                  value={hasVariants}
                  onValueChange={v => {
                    setHasVariants(v);
                    if (v && variantDraft.length === 0) {
                      setVariantDraft([makeVariantItem(form)]);
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
                  style={styles.fieldInput}
                  value={form.purchase_price}
                  onChangeText={v => setForm(prev => ({ ...prev, purchase_price: formatAmountInput(v) }))}
                  keyboardType="decimal-pad"
                  placeholderTextColor={palette.textDisabled}
                />
              </View>

              {/* 4 — Prix de vente */}
              <View style={styles.fieldBlock}>
                <Text style={styles.fieldLabel}>
                  {`Prix de vente unitaire (${currency})`}
                </Text>
                <TextInput
                  style={styles.fieldInput}
                  value={form.sale_price}
                  onChangeText={v => setForm(prev => ({ ...prev, sale_price: formatAmountInput(v) }))}
                  keyboardType="decimal-pad"
                  placeholderTextColor={palette.textDisabled}
                />
                {(() => {
                  const sp = parseAmountInput(form.sale_price);
                  const cp = totalCost(form);
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
                    <TextInput
                      style={[styles.fieldInput, { flex: 1 }]}
                      value={form.initial_stock}
                      onChangeText={setField('initial_stock')}
                      keyboardType="number-pad"
                      placeholderTextColor={palette.textDisabled}
                    />
                    <Text style={styles.unitTag}>pcs</Text>
                  </View>
                </View>
              )}

              {/* 5b — Variant list */}
              {hasVariants && (
                <View style={styles.variantList}>
                  <View style={styles.variantListHeader}>
                    <Text style={[styles.fieldLabel, { flex: 1 }]}>Variantes</Text>
                    <Text style={[styles.fieldLabel, { width: 60, textAlign: 'right' }]}>Qté</Text>
                    <View style={{ width: 72 }} />
                  </View>
                  {variantDraft.map((v, i) => (
                    <VariantRow
                      key={v._key}
                      variant={v}
                      onChange={patch => setVariantDraft(prev => prev.map((item, idx) => idx === i ? { ...item, ...patch } : item))}
                      onRemove={() => setVariantDraft(prev => prev.filter((_, idx) => idx !== i))}
                    />
                  ))}
                  <Pressable
                    style={styles.addVariantBtn}
                    onPress={() => setVariantDraft(prev => [...prev, makeVariantItem(form)])}
                  >
                    <Ionicons name="add-circle-outline" size={18} color={palette.primary} />
                    <Text variant="label" style={{ color: palette.primary, marginLeft: 4 }}>Ajouter une variante</Text>
                  </Pressable>
                  {totalVariantStock > 0 && (
                    <View style={[styles.liveCalcBlock, { borderTopWidth: 0 }]}>
                      <Text style={styles.liveCalcText}>
                        Stock total : {totalVariantStock} pcs sur {variantDraft.length} variante{variantDraft.length !== 1 ? 's' : ''}
                      </Text>
                    </View>
                  )}
                </View>
              )}

              {/* Live math (plain products) */}
              {showLiveCalc && (
                <View style={styles.liveCalcBlock}>
                  <Text style={styles.liveCalcText}>
                    Total investi : {liveInvested.toLocaleString('fr-FR')} {currency}
                  </Text>
                </View>
              )}
              {showProfitHint && (
                <View style={styles.liveCalcBlock}>
                  <Text style={[styles.liveCalcText, { color: sp > computedCost ? palette.success : palette.danger }]}>
                    Gain : {(sp - computedCost).toLocaleString('fr-FR')} {currency} par unité
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
                      />
                      <Text variant="caption" color="secondary">Utilisé pour répartir les frais par unité</Text>
                    </View>
                  )}

                  <View style={styles.fieldBlock}>
                    <Text style={styles.fieldLabel}>Frais supplémentaires ({currency})</Text>
                    <TextInput
                      style={styles.fieldInput}
                      value={form.extra_fees}
                      onChangeText={v => setForm(prev => ({ ...prev, extra_fees: formatAmountInput(v) }))}
                      keyboardType="decimal-pad"
                      placeholder="0"
                      placeholderTextColor={palette.textDisabled}
                    />
                  </View>

                  {!hasVariants && (
                    <View style={styles.fieldBlock}>
                      <Text style={styles.fieldLabel}>Seuil d'alerte stock</Text>
                      <TextInput
                        style={styles.fieldInput}
                        value={form.reorder_level}
                        onChangeText={setField('reorder_level')}
                        keyboardType="number-pad"
                        placeholderTextColor={palette.textDisabled}
                      />
                      <Text variant="caption" color="secondary">Vous serez alerté à ce niveau de stock</Text>
                    </View>
                  )}
                </>
              )}
            </ScrollView>
          </SafeAreaView>

          {/* Footer outside ScrollView+SafeAreaView so KAV lifts it cleanly above the keyboard */}
          <View style={[styles.modalFooter, { paddingBottom: Math.max(insets.bottom, spacing[5]) }]}>
            <Button label={saving ? (editing ? 'Enregistrement…' : 'Ajout…') : (editing ? 'Enregistrer' : 'Ajouter')} onPress={handleSave}
              loading={saving} fullWidth size="lg" />
          </View>
        </KeyboardAvoidingView>
      </Modal>
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
    <Modal visible={visible} animationType="slide" presentationStyle="formSheet" onRequestClose={onClose}>
      <SafeAreaView style={styles.modalSafe} edges={['bottom']}>
        <View style={styles.modalHeader}>
          <Pressable onPress={onClose} style={styles.modalCancel}>
            <Text variant="body" color="secondary">Annuler</Text>
          </Pressable>
          <Text variant="h4">Ajuster le stock</Text>
          <View style={{ width: 64 }} />
        </View>

        <ScrollView contentContainerStyle={styles.modalContent} keyboardShouldPersistTaps="handled">
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

          <Input label="Quantité" value={qty} onChangeText={setQty} keyboardType="number-pad" />
          <Input label="Note (optionnel)" value={note} onChangeText={setNote}
            placeholder="Livraison, retour client, casse" />
        </ScrollView>

        <View style={styles.modalFooter}>
          <Button
            label={saving ? 'Enregistrement…' : 'Confirmer'}
            onPress={async () => {
              const n = parseInt(qty);
              if (isNaN(n) || n <= 0) { Alert.alert('Entrez une quantité :)'); return; }
              await onConfirm(n, type, note);
            }}
            loading={saving} fullWidth size="lg"
            variant={type === 'perte' ? 'danger' : 'primary'}
          />
        </View>
      </SafeAreaView>
    </Modal>
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

  const profitColor = stats && stats.profit >= 0 ? palette.success : palette.danger;

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="formSheet" onRequestClose={onClose}>
      <SafeAreaView style={styles.modalSafe} edges={['bottom']}>
        <View style={styles.modalHeader}>
          <Pressable onPress={onClose} style={styles.modalCancel}>
            <Text variant="body" color="secondary">Fermer</Text>
          </Pressable>
          <Text variant="h4" numberOfLines={1} style={{ flex: 1, textAlign: 'center' }}>Rentabilité</Text>
          <View style={{ width: 64 }} />
        </View>

        <ScrollView contentContainerStyle={styles.modalContent}>
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
                  {stats.profit >= 0 ? '+' : ''}{formatAmount(stats.profit, currency)}
                </Text>
              </View>
            </Card>
          ) : (
            <View style={{ alignItems: 'center', paddingVertical: 32 }}>
              <Text variant="body" color="secondary">Aucune donnée disponible.</Text>
            </View>
          )}
        </ScrollView>
      </SafeAreaView>
    </Modal>
  );
}

// ─── Product Row ──────────────────────────────────────────────────────────────

interface ProductRowProps {
  product: Product;
  currency: string;
  onPress: () => void;
  onLongPress?: () => void;
  archived?: boolean;
}

function StockStatus({ product }: { product: Product }) {
  const { palette } = useTheme();
  const styles = useMemo(() => makeStyles(palette), [palette]);

  if (product.has_variants) {
    return null;
  }

  const isOut = product.stock_qty === 0;
  const isLow = !isOut && product.reorder_level > 0 && product.stock_qty <= product.reorder_level;

  if (isOut) {
    return (
      <View style={styles.stockOutRow}>
        <Text style={styles.stockOutText}>Épuisé</Text>
      </View>
    );
  }
  if (isLow) {
    return (
      <View style={styles.stockLowRow}>
        <Ionicons name="leaf-outline" size={11} color={palette.warning} />
        <Text style={styles.stockLowText}>
          Bientôt fini · Il reste {product.stock_qty} {product.unit}
        </Text>
      </View>
    );
  }
  return (
    <Text style={styles.productStockText}>{product.stock_qty} {product.unit}</Text>
  );
}

function productBadgeColor(name: string) {
  const sum = name.split('').reduce((acc, ch) => acc + ch.charCodeAt(0), 0);
  return PRODUCT_BADGE_PALETTE.bg[sum % PRODUCT_BADGE_PALETTE.bg.length];
}

function productBadgeTextColor(name: string) {
  const sum = name.split('').reduce((acc, ch) => acc + ch.charCodeAt(0), 0);
  return PRODUCT_BADGE_PALETTE.text[sum % PRODUCT_BADGE_PALETTE.text.length];
}

function ProductRow({ product, currency, onPress, onLongPress, archived }: ProductRowProps) {
  const { palette } = useTheme();
  const styles = useMemo(() => makeStyles(palette), [palette]);
  const badgeBg = productBadgeColor(product.name);
  const badgeTextColor = productBadgeTextColor(product.name);
  const initial = product.name.charAt(0).toUpperCase();
  const isOutOfStock = !archived && !product.has_variants && product.stock_qty === 0;

  if (archived) {
    return (
      <Pressable
        onPress={onPress}
        onLongPress={onLongPress}
        style={({ pressed }) => [styles.productRow, pressed && { opacity: 0.65 }]}
      >
        <View style={[styles.productBadge, { backgroundColor: badgeBg, opacity: 0.5 }]}>
          <Text style={[styles.productBadgeText, { color: badgeTextColor }]}>{initial}</Text>
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
    <Pressable onPress={onPress} style={({ pressed }) => [styles.productRow, pressed && { opacity: 0.65 }]}>
      <View style={[styles.productBadge, { backgroundColor: badgeBg, opacity: isOutOfStock ? 0.38 : 1 }]}>
        <Text style={[styles.productBadgeText, { color: badgeTextColor }]}>{initial}</Text>
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
        <StockStatus product={product} />
      </View>
      <View style={[styles.productRight, product.has_variants && { alignSelf: 'stretch' }]}>
        <Text style={[styles.priceText, isOutOfStock && { color: palette.textDisabled }]}>
          {formatPrice(product.sale_price, currency)}
        </Text>
        {product.has_variants ? (
          <Ionicons
            name="chevron-forward"
            size={14}
            color={palette.primary}
            style={{ position: 'absolute', bottom: 0, right: 0 }}
          />
        ) : null}
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
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.actionSheetOverlay} onPress={onClose} />
      <View style={[styles.actionSheet, { paddingBottom: Math.max(insets.bottom, spacing[4]) }]}>
        <View style={styles.sheetHandle} />
        <View style={styles.actionSheetHeader}>
          <Text variant="h4" numberOfLines={1}>{product.name}</Text>
          <Text variant="caption" color="secondary">Ce produit est archivé</Text>
        </View>
        <Pressable
          style={({ pressed }) => [styles.actionRow, pressed && { opacity: 0.65 }]}
          onPress={onRestore}
        >
          <Ionicons name="refresh-outline" size={22} color={palette.primary} />
          <Text style={[styles.actionRowLabel, { color: palette.primary }]}>Réactiver ce produit</Text>
        </Pressable>
      </View>
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
    ? 'Produit avec variantes'
    : `${product.stock_qty} ${product.unit} · ${formatPrice(product.sale_price, currency)}`;

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
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
              {product.has_variants ? 'Modifier · Gérer les variantes' : 'Modifier'}
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
              <Text style={[styles.actionRowLabel, { color: palette.warning }]}>Archiver</Text>
            </Pressable>
          </>
        )}
      </View>
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

  const { products, archivedProducts, variantsByProduct, loading, saving, offline, offlineSince, fetchProducts, fetchArchivedProducts, fetchVariants, upsertVariants, createProduct, updateProduct, archiveProduct, restoreProduct, adjustStock, fetchProductStats } =
    useProductStore();
  const { fournisseurs, fetchFournisseurs } = useFournisseursStore();

  const [search, setSearch] = useState('');
  const [showForm, setShowForm] = useState(false);
  const [editingProduct, setEditingProduct] = useState<Product | null>(null);

  const { openForm } = useLocalSearchParams<{ openForm?: string }>();
  useEffect(() => {
    if (openForm === '1') {
      setEditingProduct(null);
      setShowForm(true);
      router.setParams({ openForm: undefined });
    }
  }, [openForm]);
  const [showAdjust, setShowAdjust] = useState(false);
  const [adjustTarget, setAdjustTarget] = useState<Product | null>(null);
  const [tab, setTab] = useState<'actifs' | 'archives'>('actifs');
  const [successMsg, setSuccessMsg] = useState('');
  const [showStats, setShowStats] = useState(false);
  const [statsTarget, setStatsTarget] = useState<Product | null>(null);
  const [showOutOfStockModal, setShowOutOfStockModal] = useState(false);
  const [initialVariants, setInitialVariants] = useState<import('@/src/types').ProductVariant[]>([]);
  const [showActionSheet, setShowActionSheet] = useState(false);
  const [actionSheetProduct, setActionSheetProduct] = useState<Product | null>(null);
  const [showRestoreSheet, setShowRestoreSheet] = useState(false);
  const [restoreSheetProduct, setRestoreSheetProduct] = useState<Product | null>(null);

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

  const fabScale   = useRef(new Animated.Value(1)).current;
  const fabOpacity = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    const easing = Easing.inOut(Easing.sin);
    const loop = Animated.loop(
      Animated.sequence([
        Animated.parallel([
          Animated.timing(fabScale,   { toValue: 1.06, duration: 2000, easing, useNativeDriver: true }),
          Animated.timing(fabOpacity, { toValue: 0.85, duration: 2000, easing, useNativeDriver: true }),
        ]),
        Animated.parallel([
          Animated.timing(fabScale,   { toValue: 1,    duration: 2000, easing, useNativeDriver: true }),
          Animated.timing(fabOpacity, { toValue: 1,    duration: 2000, easing, useNativeDriver: true }),
        ]),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, []);

  const showSuccess = useCallback((msg: string) => {
    setSuccessMsg(msg);
    setTimeout(() => setSuccessMsg(''), 2500);
  }, []);

  useEffect(() => {
    if (businessId) {
      fetchProducts(businessId, userId);
      fetchFournisseurs(businessId);
    }
  }, [businessId]);

  useFocusEffect(
    useCallback(() => {
      if (businessId) fetchProducts(businessId, userId);
    }, [businessId, userId]),
  );

  useEffect(() => {
    if (businessId && tab === 'archives') {
      fetchArchivedProducts(businessId);
    }
  }, [tab, businessId]);

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
      Alert.alert(
        'Archiver ce produit ?',
        `"${product.name}" sera retiré du catalogue actif. Vous pourrez le réactiver depuis l'onglet Archivés.`,
        [
          { text: 'Annuler', style: 'cancel' },
          { text: 'Archiver', style: 'destructive', onPress: () => { haptics.error(); archiveProduct(product.id, businessId); } },
        ],
      );
    }, 350);
  }, [actionSheetProduct, archiveProduct, businessId]);

  const handleSave = useCallback(
    async (data: CreateProductData, hasVariants: boolean, variants: DraftVariant[]) => {
      let ok: boolean;
      if (editingProduct) {
        ok = await updateProduct(businessId, userId, editingProduct.id, data);
        if (ok) {
          await upsertVariants(businessId, editingProduct.id, userId, hasVariants ? variants : []);
        }
      } else {
        ok = await createProduct(businessId, userId, data);
        if (ok && hasVariants && variants.length > 0) {
          const nameLower = data.name.trim().toLowerCase();
          const created = useProductStore.getState().products.find(
            p => p.name.trim().toLowerCase() === nameLower,
          ) ?? null;
          if (created) {
            await upsertVariants(businessId, created.id, userId, variants);
          }
        }
      }
      if (ok) {
        haptics.success();
        setShowForm(false);
        setEditingProduct(null);
        showSuccess(editingProduct ? 'Produit mis à jour ✓' : 'Produit ajouté ✓');
      }
    },
    [editingProduct, businessId, userId, createProduct, updateProduct, upsertVariants, showSuccess],
  );

  const handleAdjust = useCallback(
    async (qty: number, type: 'entree' | 'perte', note: string) => {
      if (!adjustTarget) return;
      await adjustStock(adjustTarget.id, businessId, userId, qty, type, note);
      setShowAdjust(false);
      setAdjustTarget(null);
      showSuccess('Stock ajusté ✓');
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

      {offline && <OfflineNotice offlineSince={offlineSince} />}

      {/* Header */}
      <View style={styles.header}>
        <View>
          <Text variant="h3">Produits</Text>
          <Text variant="caption" color="secondary">
            {tab === 'actifs'
              ? `${products.length} produit${products.length !== 1 ? 's' : ''}`
              : `${archivedProducts.length} archivé${archivedProducts.length !== 1 ? 's' : ''}`}
          </Text>
        </View>
      </View>

      {/* Tabs */}
      <View style={styles.tabRow}>
        {(['actifs', 'archives'] as const).map(t => (
          <Pressable key={t} onPress={() => setTab(t)} style={[styles.tabChip, tab === t && styles.tabChipActive]}>
            <Text variant="caption" style={{ color: tab === t ? palette.textInverse : palette.textSecondary }}>
              {t === 'actifs' ? 'Actifs' : 'Archivés'}
            </Text>
          </Pressable>
        ))}
      </View>

      {/* Search */}
      <View style={styles.searchRow}>
        <Input placeholder="Rechercher un produit…" value={search} onChangeText={setSearch} style={{ flex: 1 }} />
      </View>

      {/* Stats row (actifs only) */}
      {products.length > 0 && tab === 'actifs' && (
        <View style={styles.statsCard}>
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
          {outOfStockActive.length > 0 && (
            <>
              <View style={styles.statDivider} />
              <Pressable style={[styles.statCol, { alignItems: 'flex-end' }]} onPress={() => setShowOutOfStockModal(true)}>
                <Text variant="caption" color="secondary" style={{ textAlign: 'right' }}>
                  {outOfStockActive.length === 1
                    ? '1 produit est fini'
                    : `${outOfStockActive.length} produits sont finis`}
                </Text>
                <Text style={[styles.statValue, { color: palette.primary }]}>Voir →</Text>
              </Pressable>
            </>
          )}
        </View>
      )}

      {/* Product list */}
      {loading && products.length === 0 ? (
        <SkeletonList count={8} />
      ) : tab === 'actifs' && products.length === 0 ? (
        <View style={styles.emptyState}>
          <Ionicons name="cube-outline" size={72} color={palette.textDisabled} />
          <Text variant="h4">Catalogue vide</Text>
          <Text variant="body" color="secondary" style={styles.emptyDesc}>
            {!canEdit
              ? 'Votre responsable ajoutera les produits bientôt.'
              : 'Ajoutez votre premier produit pour démarrer.'}
          </Text>
        </View>
      ) : tab === 'archives' && archivedFiltered.length === 0 ? (
        <View style={styles.emptyState}>
          <Ionicons name="cube-outline" size={48} color={palette.textDisabled} />
          <Text variant="body" color="secondary">Aucun produit archivé.</Text>
        </View>
      ) : (
        <FlatList
          data={displayList}
          keyExtractor={p => p.id}
          renderItem={({ item }) => (
            <ProductRow
              product={item}
              currency={currency}
              archived={tab === 'archives'}
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
          ListEmptyComponent={
            search.trim() ? (
              <View style={[styles.emptyState, { paddingTop: spacing[10] }]}>
                <Ionicons name="search-outline" size={48} color={palette.textDisabled} />
                <Text variant="body" color="secondary">Aucun résultat pour "{search}"</Text>
              </View>
            ) : null
          }
        />
      )}

      {/* Out-of-stock bottom sheet */}
      <Modal
        visible={showOutOfStockModal}
        animationType="slide"
        transparent
        onRequestClose={() => setShowOutOfStockModal(false)}
      >
        <Pressable style={styles.outOfStockOverlay} onPress={() => setShowOutOfStockModal(false)} />
        <View style={styles.outOfStockSheet}>
          <View style={styles.sheetHandle} />
          <View style={[styles.header, { paddingTop: spacing[2] }]}>
            <View>
              <Text variant="h4">Produits épuisés</Text>
              <Text variant="caption" color="secondary">
                {outOfStockActive.length} produit{outOfStockActive.length !== 1 ? 's' : ''} à réapprovisionner
              </Text>
            </View>
            <Pressable onPress={() => setShowOutOfStockModal(false)} style={{ padding: spacing[2] }}>
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
        onClose={() => { setShowForm(false); setEditingProduct(null); }}
        onSave={handleSave}
        saving={saving}
        currency={currency}
        fournisseurs={fournisseurs}
        businessId={businessId}
        userId={userId}
        initialVariants={initialVariants}
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

      {canEdit && tab === 'actifs' && (
        <Animated.View style={[styles.fabContainer, { opacity: fabOpacity, transform: [{ scale: fabScale }] }]}>
          <Pressable
            onPress={() => { setEditingProduct(null); setShowForm(true); }}
            style={({ pressed }) => [styles.fab, pressed && { opacity: 0.82 }]}
            accessibilityLabel="Ajouter un produit"
            accessibilityRole="button"
          >
            <Text style={styles.fabIcon}>+</Text>
          </Pressable>
        </Animated.View>
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
      flexDirection: 'row', gap: spacing[2],
      paddingHorizontal: spacing[5], paddingBottom: spacing[3],
    },
    tabChip: {
      paddingHorizontal: spacing[4], paddingVertical: spacing[1.5],
      borderRadius: radius.full, borderWidth: 1, borderColor: p.border,
      backgroundColor: p.surface,
    },
    tabChipActive: { backgroundColor: p.primary, borderColor: p.primary },
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
    list: { paddingHorizontal: spacing[5], paddingBottom: spacing[10] },
    separator: { height: 0 },
    productRow: {
      flexDirection: 'row', alignItems: 'center',
      paddingVertical: spacing[4],
      borderBottomWidth: 1, borderBottomColor: p.border,
      backgroundColor: p.surface,
    },
    productBadge: {
      width: 44, height: 44, borderRadius: radius.md,
      alignItems: 'center', justifyContent: 'center',
      marginRight: 0,
    },
    productBadgeText: { fontFamily: FF.semibold, fontSize: 16 },
    productCenter: { flex: 1, paddingLeft: 12, gap: 3 },
    productName: { fontFamily: FF.semibold, fontSize: 16, color: p.textPrimary },
    productStockText: { fontFamily: FF.regular, fontSize: 13, color: p.textSecondary },
    stockLowRow: {
      flexDirection: 'row', alignItems: 'center', gap: 4,
      alignSelf: 'flex-start',
      backgroundColor: p.warningLight,
      borderRadius: radius.full,
      paddingHorizontal: 8, paddingVertical: 3,
    },
    stockLowText: { fontFamily: FF.medium, fontSize: 12, color: p.warning },
    stockOutRow: {
      flexDirection: 'row', alignItems: 'center', gap: 4,
      alignSelf: 'flex-start',
      backgroundColor: p.warningLight,
      borderRadius: radius.full,
      paddingHorizontal: 8, paddingVertical: 3,
    },
    stockOutText: { fontFamily: FF.semibold, fontSize: 12, color: p.warning },
    productMeta: { flexDirection: 'row', gap: spacing[2], alignItems: 'center' },
    categoryBadge: {
      backgroundColor: p.primaryLight, borderRadius: radius.sm,
      paddingHorizontal: spacing[1.5], paddingVertical: 2,
    },
    bulkBadge: {
      backgroundColor: p.warningLight, borderRadius: radius.sm,
      paddingHorizontal: spacing[1.5], paddingVertical: 2, borderWidth: 1, borderColor: p.warning,
    },
    productRight: { alignItems: 'flex-end' },
    priceText: { fontFamily: FF.semibold, fontSize: 15, color: p.primary },
    emptyState: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing[8], gap: spacing[3] },
    emptyDesc: { textAlign: 'center', maxWidth: 260 },

    fabContainer: { position: 'absolute', bottom: 194, right: spacing[4], zIndex: 10 },
    fab: {
      width: 56, height: 56, borderRadius: radius.full,
      backgroundColor: p.primary, alignItems: 'center', justifyContent: 'center',
      shadowColor: p.textPrimary, shadowOffset: { width: 0, height: 4 },
      shadowOpacity: 0.18, shadowRadius: 8, elevation: 8,
    },
    fabIcon: { fontSize: 28, lineHeight: 32, fontWeight: '300' as const, color: p.textInverse, marginTop: -2 },

    modalSafe: { flex: 1, backgroundColor: p.background },
    modalHeader: {
      flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
      paddingHorizontal: spacing[5], paddingVertical: spacing[4],
      borderBottomWidth: 1, borderBottomColor: p.border, backgroundColor: p.surface,
    },
    modalCancel: { minWidth: 64 },
    modalContent: { padding: spacing[5], gap: spacing[4] },
    modalFooter: {
      padding: spacing[5], borderTopWidth: 1, borderTopColor: p.border, backgroundColor: p.surface,
    },
    formError: { backgroundColor: p.dangerLight, borderRadius: radius.md, padding: spacing[3] },

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
    typeChipPerte: { backgroundColor: p.danger, borderColor: p.danger },

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
    },
    variantPriceOverride: {
      flexDirection: 'row',
      paddingHorizontal: spacing[5], paddingVertical: spacing[2],
      gap: spacing[4],
      borderBottomWidth: 1, borderBottomColor: p.border,
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
