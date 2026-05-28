import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useFocusEffect } from 'expo-router';
import {
  Alert,
  FlatList,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Button } from '@/src/components/ui/Button';
import { Card } from '@/src/components/ui/Card';
import { Input } from '@/src/components/ui/Input';
import { Text } from '@/src/components/ui/Text';
import { colors, palette, radius, spacing } from '@/src/theme';
import type { Product } from '@/src/types';
import { useAuthStore } from '@/stores/auth';
import { type CreateProductData, useProductStore } from '@/stores/products';
import { useFournisseursStore, type Fournisseur } from '@/stores/fournisseurs';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatPrice(amount: number, currency: string) {
  return `${amount.toLocaleString('fr-FR')} ${currency}`;
}

function stockColor(product: Product): string {
  if (product.stock_qty === 0) return colors.danger[600];
  if (product.stock_qty <= product.reorder_level) return colors.warning[600];
  return colors.success[600];
}

function stockBg(product: Product): string {
  if (product.stock_qty === 0) return colors.danger[50];
  if (product.stock_qty <= product.reorder_level) return colors.warning[50];
  return colors.success[50];
}

// ─── Form State ───────────────────────────────────────────────────────────────

interface FormState {
  name: string;
  purchase_price: string;
  shipping_cost: string;
  other_costs: string;
  sale_price: string;
  initial_stock: string;
  reorder_level: string;
  supplier_id: string;
}

const EMPTY_FORM: FormState = {
  name: '',
  purchase_price: '',
  shipping_cost: '',
  other_costs: '',
  sale_price: '',
  initial_stock: '0',
  reorder_level: '0',
  supplier_id: '',
};

function productToForm(p: Product): FormState {
  return {
    name: p.name,
    purchase_price: p.cost_price > 0 ? String(p.cost_price) : '',
    shipping_cost: '',
    other_costs: '',
    sale_price: String(p.sale_price),
    initial_stock: '0',
    reorder_level: String(p.reorder_level),
    supplier_id: p.supplier_id ?? '',
  };
}

function totalCost(f: FormState): number {
  return (parseFloat(f.purchase_price) || 0)
    + (parseFloat(f.shipping_cost) || 0)
    + (parseFloat(f.other_costs) || 0);
}

function validateForm(f: FormState): string | null {
  if (!f.name.trim()) return 'Le nom du produit est requis.';
  const sp = parseFloat(f.sale_price);
  if (isNaN(sp) || sp < 0) return 'Prix de vente invalide.';
  return null;
}

function formToData(f: FormState): CreateProductData {
  return {
    name: f.name,
    unit: 'pcs',
    cost_price: totalCost(f),
    sale_price: parseFloat(f.sale_price) || 0,
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
  const { createFournisseur, saving: fSaving } = useFournisseursStore();
  const selected = fournisseurs.find(f => f.id === selectedId);
  const [open, setOpen] = useState(false);
  const [showNewForm, setShowNewForm] = useState(false);
  const [newName, setNewName] = useState('');
  const [newPhone, setNewPhone] = useState('');

  const handleCreate = async () => {
    if (!newName.trim()) { Alert.alert('Nom requis'); return; }
    const ok = await createFournisseur(businessId, userId, { name: newName, phone: newPhone });
    if (ok) {
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
          <Text style={[styles.fieldInput, { flex: 1, fontSize: 17, fontWeight: '500' as const }]} numberOfLines={1}>
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
          <Input label="Nom *" value={newName} onChangeText={setNewName} placeholder="Ex: Marché Central" />
          <Input label="Téléphone (optionnel)" value={newPhone} onChangeText={setNewPhone} keyboardType="phone-pad" placeholder="Ex: 622 00 00 00" />
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
  onSave: (data: CreateProductData) => Promise<void>;
  saving: boolean;
  currency: string;
  fournisseurs: Fournisseur[];
  businessId: string;
  userId: string;
}

function ProductFormModal({ visible, editing, onClose, onSave, saving, currency, fournisseurs, businessId, userId }: ProductFormProps) {
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [formError, setFormError] = useState<string | null>(null);
  const [showDetails, setShowDetails] = useState(false);
  const nameRef = useRef<TextInput>(null);
  const scrollRef = useRef<ScrollView>(null);

  useEffect(() => {
    if (visible) {
      setForm(editing ? productToForm(editing) : EMPTY_FORM);
      setFormError(null);
      setShowDetails(false);
      setTimeout(() => nameRef.current?.focus(), 200);
    }
  }, [visible, editing]);

  const set = (key: keyof FormState) => (val: string) =>
    setForm(prev => ({ ...prev, [key]: val }));

  const handleSave = async () => {
    const err = validateForm(form);
    if (err) { setFormError(err); return; }
    setFormError(null);
    await onSave(formToData(form));
  };

  const toggleDetails = () => {
    const next = !showDetails;
    setShowDetails(next);
    if (next) {
      setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 150);
    }
  };

  const qty = parseFloat(form.initial_stock) || 0;
  const pp = parseFloat(form.purchase_price) || 0;
  const sp = parseFloat(form.sale_price) || 0;
  const liveInvested = qty * pp;
  const showLiveCalc = !editing && liveInvested > 0;
  const showProfitHint = editing && pp > 0 && sp > 0;

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
        <SafeAreaView style={styles.modalSafe} edges={['bottom']}>
          <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={{ flex: 1 }}>
            <View style={styles.modalHeader}>
              <Pressable onPress={onClose} style={styles.modalCancel}>
                <Text variant="body" color="secondary">Annuler</Text>
              </Pressable>
              <Text variant="h4">{editing ? 'Modifier le produit' : 'Nouveau produit'}</Text>
              <View style={{ width: 64 }} />
            </View>

            <ScrollView ref={scrollRef} style={{ flex: 1 }} contentContainerStyle={styles.formStack} keyboardShouldPersistTaps="handled">
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
                  onChangeText={set('name')}
                  placeholder="Ex: Sac de riz 25kg"
                  placeholderTextColor={palette.textDisabled}
                />
              </View>

              {/* 2 — Quantité achetée (new product only) */}
              {!editing && (
                <View style={styles.fieldBlock}>
                  <Text style={styles.fieldLabel}>Quantité achetée</Text>
                  <View style={styles.fieldRow}>
                    <TextInput
                      style={[styles.fieldInput, { flex: 1 }]}
                      value={form.initial_stock}
                      onChangeText={set('initial_stock')}
                      keyboardType="number-pad"
                      placeholder="0"
                      placeholderTextColor={palette.textDisabled}
                    />
                    <Text style={styles.unitTag}>pcs</Text>
                  </View>
                </View>
              )}

              {/* 3 — Prix d'achat */}
              <View style={styles.fieldBlock}>
                <Text style={styles.fieldLabel}>Prix d'achat unitaire ({currency})</Text>
                <TextInput
                  style={styles.fieldInput}
                  value={form.purchase_price}
                  onChangeText={set('purchase_price')}
                  keyboardType="decimal-pad"
                  placeholder="0"
                  placeholderTextColor={palette.textDisabled}
                />
              </View>

              {/* 4 — Prix de vente */}
              <View style={styles.fieldBlock}>
                <Text style={styles.fieldLabel}>Prix de vente unitaire ({currency})</Text>
                <TextInput
                  style={styles.fieldInput}
                  value={form.sale_price}
                  onChangeText={set('sale_price')}
                  keyboardType="decimal-pad"
                  placeholder="0"
                  placeholderTextColor={palette.textDisabled}
                />
              </View>

              {/* Live math */}
              {showLiveCalc && (
                <View style={styles.liveCalcBlock}>
                  <Text style={styles.liveCalcText}>
                    Total investi : {liveInvested.toLocaleString('fr-FR')} {currency}
                  </Text>
                </View>
              )}
              {showProfitHint && (
                <View style={styles.liveCalcBlock}>
                  <Text style={[styles.liveCalcText, { color: sp > pp ? palette.success : palette.danger }]}>
                    Marge : {(sp - pp).toLocaleString('fr-FR')} {currency} par unité
                  </Text>
                </View>
              )}

              {/* More details toggle — inline accordion, no separate Modal */}
              <Pressable onPress={toggleDetails} style={styles.detailsBtn}>
                <Text variant="body" style={{ color: palette.primary }}>
                  {showDetails ? '▲ Masquer les détails' : '▼ Plus de détails (Stock, Fournisseur…)'}
                </Text>
              </Pressable>

              {/* Inline details accordion */}
              {showDetails && (
                <>
                  <SupplierPicker
                    fournisseurs={fournisseurs}
                    selectedId={form.supplier_id}
                    onSelect={id => setForm(p => ({ ...p, supplier_id: id }))}
                    businessId={businessId}
                    userId={userId}
                  />

                  <View style={styles.fieldBlock}>
                    <Text style={styles.fieldLabel}>Frais de livraison ({currency})</Text>
                    <TextInput
                      style={styles.fieldInput}
                      value={form.shipping_cost}
                      onChangeText={set('shipping_cost')}
                      keyboardType="decimal-pad"
                      placeholder="0 — optionnel"
                      placeholderTextColor={palette.textDisabled}
                    />
                  </View>

                  <View style={styles.fieldBlock}>
                    <Text style={styles.fieldLabel}>Autres frais ({currency})</Text>
                    <TextInput
                      style={styles.fieldInput}
                      value={form.other_costs}
                      onChangeText={set('other_costs')}
                      keyboardType="decimal-pad"
                      placeholder="0 — optionnel"
                      placeholderTextColor={palette.textDisabled}
                    />
                    <Text variant="caption" color="secondary">Douanes, manutention, etc.</Text>
                  </View>

                  <View style={styles.fieldBlock}>
                    <Text style={styles.fieldLabel}>Seuil d'alerte stock</Text>
                    <TextInput
                      style={styles.fieldInput}
                      value={form.reorder_level}
                      onChangeText={set('reorder_level')}
                      keyboardType="number-pad"
                      placeholder="0"
                      placeholderTextColor={palette.textDisabled}
                    />
                    <Text variant="caption" color="secondary">Alerte quand le stock atteint ce niveau</Text>
                  </View>
                </>
              )}
            </ScrollView>

            <View style={styles.modalFooter}>
              <Button label={saving ? 'Enregistrement…' : 'Enregistrer'} onPress={handleSave}
                loading={saving} fullWidth size="lg" />
            </View>
          </KeyboardAvoidingView>
        </SafeAreaView>
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

          <Input label="Quantité" value={qty} onChangeText={setQty} keyboardType="number-pad" placeholder="1" />
          <Input label="Note (optionnel)" value={note} onChangeText={setNote}
            placeholder="Ex: Livraison fournisseur, casse…" />
        </ScrollView>

        <View style={styles.modalFooter}>
          <Button
            label={saving ? 'Enregistrement…' : 'Confirmer'}
            onPress={async () => {
              const n = parseInt(qty);
              if (isNaN(n) || n <= 0) { Alert.alert('Quantité invalide'); return; }
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

// ─── Product Row ──────────────────────────────────────────────────────────────

interface ProductRowProps {
  product: Product;
  currency: string;
  onPress: () => void;
  archived?: boolean;
  onRestore?: () => void;
}

function ProductRow({ product, currency, onPress, archived, onRestore }: ProductRowProps) {
  const sc = stockColor(product);
  const bg = stockBg(product);
  const margin = product.cost_price > 0
    ? ((product.sale_price - product.cost_price) / product.cost_price * 100).toFixed(0)
    : null;

  if (archived) {
    return (
      <View style={styles.productRow}>
        <View style={styles.productInfo}>
          <Text variant="label" numberOfLines={1}>{product.name}</Text>
          <Text variant="caption" color="secondary">
            {formatPrice(product.sale_price, currency)}
          </Text>
        </View>
        <View style={styles.productRight}>
          {onRestore && (
            <Pressable
              onPress={onRestore}
              style={({ pressed }) => [styles.restoreBtn, pressed && { opacity: 0.7 }]}
            >
              <Text variant="caption" style={{ color: palette.primary, fontWeight: '700' }}>Restaurer</Text>
            </Pressable>
          )}
        </View>
      </View>
    );
  }

  return (
    <Pressable onPress={onPress} style={({ pressed }) => [styles.productRow, pressed && { opacity: 0.65 }]}>
      <View style={styles.productInfo}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing[2] }}>
          <Text variant="label" numberOfLines={1}>{product.name}</Text>
          {product.bulk_price ? (
            <View style={styles.bulkBadge}>
              <Text variant="caption" style={{ color: colors.warning[700] }}>Disponible en gros</Text>
            </View>
          ) : null}
        </View>
        {margin && (
          <Text variant="caption" style={{ color: palette.success }}>+{margin}%</Text>
        )}
      </View>

      <View style={styles.productRight}>
        <Text variant="label" style={styles.priceText}>
          {formatPrice(product.sale_price, currency)}
        </Text>
        <View style={[styles.stockBadge, { backgroundColor: bg }]}>
          <Text variant="caption" style={{ color: sc, fontWeight: '600' }}>
            {product.stock_qty} {product.unit}
          </Text>
        </View>
      </View>
    </Pressable>
  );
}

// ─── Main Screen ──────────────────────────────────────────────────────────────

export default function CatalogueScreen() {
  const session = useAuthStore(s => s.session);
  const business = session?.activeBusiness;
  const userId = session?.user.id ?? '';
  const businessId = business?.id ?? '';
  const currency = business?.currency ?? 'GNF';
  const role = session?.activeMembership?.role;
  const canEdit = role === 'administrateur' || role === 'manager';

  const { products, archivedProducts, loading, saving, fetchProducts, fetchArchivedProducts, createProduct, updateProduct, archiveProduct, restoreProduct, adjustStock } =
    useProductStore();
  const { fournisseurs, fetchFournisseurs } = useFournisseursStore();

  const [search, setSearch] = useState('');
  const [showForm, setShowForm] = useState(false);
  const [editingProduct, setEditingProduct] = useState<Product | null>(null);
  const [showAdjust, setShowAdjust] = useState(false);
  const [adjustTarget, setAdjustTarget] = useState<Product | null>(null);
  const [tab, setTab] = useState<'actifs' | 'archives'>('actifs');
  const [successMsg, setSuccessMsg] = useState('');

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

  const activeFiltered = useMemo(() => {
    const q = search.toLowerCase().trim();
    if (!q) return products;
    return products.filter(p => p.name.toLowerCase().includes(q));
  }, [products, search]);

  const archivedFiltered = useMemo(() => {
    const q = search.toLowerCase().trim();
    if (!q) return archivedProducts;
    return archivedProducts.filter(p => p.name.toLowerCase().includes(q));
  }, [archivedProducts, search]);

  const openOptions = useCallback(
    (product: Product) => {
      const options: { text: string; style?: 'destructive' | 'cancel'; onPress?: () => void }[] = [];

      if (canEdit) {
        options.push({
          text: 'Modifier',
          onPress: () => { setEditingProduct(product); setShowForm(true); },
        });
      }
      options.push({
        text: 'Ajuster le stock',
        onPress: () => { setAdjustTarget(product); setShowAdjust(true); },
      });
      if (canEdit) {
        options.push({
          text: 'Archiver',
          style: 'destructive',
          onPress: () =>
            Alert.alert(
              'Archiver ce produit ?',
              `"${product.name}" sera retiré du catalogue actif. Vous pourrez le réactiver depuis l'onglet Archivés.`,
              [
                { text: 'Annuler', style: 'cancel' },
                { text: 'Archiver', style: 'destructive', onPress: () => archiveProduct(product.id, businessId) },
              ],
            ),
        });
      }
      options.push({ text: 'Annuler', style: 'cancel' });

      Alert.alert(product.name, `Stock: ${product.stock_qty} ${product.unit}`, options);
    },
    [canEdit, archiveProduct],
  );

  const openArchivedOptions = useCallback(
    (product: Product) => {
      Alert.alert(
        product.name,
        'Ce produit est archivé.',
        [
          {
            text: 'Réactiver',
            onPress: () =>
              Alert.alert('Réactiver ce produit ?', '', [
                { text: 'Annuler', style: 'cancel' },
                { text: 'Réactiver', onPress: () => restoreProduct(product.id, businessId, userId) },
              ]),
          },
          { text: 'Annuler', style: 'cancel' },
        ],
      );
    },
    [restoreProduct, businessId, userId],
  );

  const handleSave = useCallback(
    async (data: CreateProductData) => {
      let ok: boolean;
      if (editingProduct) {
        ok = await updateProduct(businessId, userId, editingProduct.id, data);
      } else {
        ok = await createProduct(businessId, userId, data);
      }
      if (ok) {
        setShowForm(false);
        setEditingProduct(null);
        showSuccess(editingProduct ? 'Produit mis à jour ✓' : 'Produit ajouté ✓');
      }
    },
    [editingProduct, businessId, userId, createProduct, updateProduct, showSuccess],
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

  const lowStockCount = products.filter(p => p.stock_qty <= p.reorder_level && p.reorder_level > 0).length;
  const displayList = tab === 'actifs' ? activeFiltered : archivedFiltered;

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      {/* Success banner */}
      {successMsg ? (
        <View style={styles.successBanner}>
          <Text variant="label" style={{ color: '#fff' }}>{successMsg}</Text>
        </View>
      ) : null}

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
        {canEdit && tab === 'actifs' && (
          <Button label="+ Ajouter" onPress={() => { setEditingProduct(null); setShowForm(true); }} size="sm" />
        )}
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

      {/* Alerts banner */}
      {lowStockCount > 0 && tab === 'actifs' && (
        <Pressable style={styles.alertBanner}>
          <Text variant="bodySmall" style={{ color: colors.warning[700] }}>
            ⚠️  {lowStockCount} produit{lowStockCount > 1 ? 's' : ''} en stock faible
          </Text>
        </Pressable>
      )}

      {/* Search */}
      <View style={styles.searchRow}>
        <Input placeholder="Rechercher un produit…" value={search} onChangeText={setSearch} style={{ flex: 1 }} />
      </View>

      {/* Stats row (actifs only) */}
      {products.length > 0 && tab === 'actifs' && (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.statsScroll}
          contentContainerStyle={styles.statsContent}>
          <View style={styles.statChip}>
            <Text variant="caption" color="secondary">Valeur stock</Text>
            <Text variant="label">
              {formatPrice(products.reduce((s, p) => s + p.cost_price * p.stock_qty, 0), currency)}
            </Text>
          </View>
          <View style={styles.statChip}>
            <Text variant="caption" color="secondary">En rupture</Text>
            <Text variant="label" style={{ color: products.filter(p => p.stock_qty === 0).length > 0 ? palette.danger : palette.textPrimary }}>
              {products.filter(p => p.stock_qty === 0).length}
            </Text>
          </View>
        </ScrollView>
      )}

      {/* Product list */}
      {loading && displayList.length === 0 ? (
        <View style={styles.emptyState}>
          <Text variant="body" color="secondary">Chargement…</Text>
        </View>
      ) : displayList.length === 0 ? (
        <View style={styles.emptyState}>
          {tab === 'archives' ? (
            <>
              <Text style={styles.emptyIcon}>📦</Text>
              <Text variant="body" color="secondary">Aucun produit archivé.</Text>
            </>
          ) : products.length === 0 ? (
            <>
              <Text style={styles.emptyIcon}>📦</Text>
              <Text variant="h4">Aucun produit</Text>
              <Text variant="body" color="secondary" style={styles.emptyDesc}>
                {canEdit
                  ? 'Ajoutez votre premier produit pour commencer à gérer votre stock.'
                  : 'Aucun produit dans ce commerce pour l\'instant.'}
              </Text>
              {canEdit && (
                <Button label="Ajouter un produit" onPress={() => { setEditingProduct(null); setShowForm(true); }}
                  style={{ marginTop: spacing[4] }} />
              )}
            </>
          ) : (
            <>
              <Text style={styles.emptyIcon}>🔍</Text>
              <Text variant="body" color="secondary">Aucun résultat pour "{search}"</Text>
            </>
          )}
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
              onPress={() => tab === 'archives' ? undefined : openOptions(item)}
              onRestore={tab === 'archives' ? () =>
                Alert.alert('Restaurer ce produit ?', `"${item.name}" sera remis dans le catalogue actif.`, [
                  { text: 'Annuler', style: 'cancel' },
                  { text: 'Restaurer', onPress: () => restoreProduct(item.id, businessId, userId) },
                ]) : undefined}
            />
          )}
          ItemSeparatorComponent={() => <View style={styles.separator} />}
          contentContainerStyle={styles.list}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
        />
      )}

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
    </SafeAreaView>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: palette.background },
  successBanner: {
    backgroundColor: palette.success, paddingHorizontal: spacing[5], paddingVertical: spacing[3],
    alignItems: 'center',
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
    borderRadius: radius.full, borderWidth: 1, borderColor: palette.border,
    backgroundColor: palette.surface,
  },
  tabChipActive: { backgroundColor: palette.primary, borderColor: palette.primary },
  alertBanner: {
    backgroundColor: colors.warning[50], paddingHorizontal: spacing[5], paddingVertical: spacing[2],
    borderBottomWidth: 1, borderBottomColor: colors.warning[100],
  },
  searchRow: { paddingHorizontal: spacing[5], paddingBottom: spacing[3] },
  statsScroll: { flexGrow: 0 },
  statsContent: {
    paddingHorizontal: spacing[5], paddingBottom: spacing[3], gap: spacing[2], flexDirection: 'row',
  },
  statChip: {
    backgroundColor: palette.surface, borderWidth: 1, borderColor: palette.border,
    borderRadius: radius.md, paddingHorizontal: spacing[3], paddingVertical: spacing[2],
    gap: 2, alignItems: 'center', minWidth: 100,
  },
  list: { paddingHorizontal: spacing[5], paddingBottom: spacing[10] },
  separator: { height: 1, backgroundColor: palette.border },
  productRow: {
    flexDirection: 'row', alignItems: 'center', paddingVertical: spacing[3],
    backgroundColor: palette.surface, gap: spacing[3],
  },
  productInfo: { flex: 1, gap: 4 },
  productMeta: { flexDirection: 'row', gap: spacing[2], alignItems: 'center' },
  categoryBadge: {
    backgroundColor: palette.primaryLight, borderRadius: radius.sm,
    paddingHorizontal: spacing[1.5], paddingVertical: 2,
  },
  bulkBadge: {
    backgroundColor: colors.warning[50], borderRadius: radius.sm,
    paddingHorizontal: spacing[1.5], paddingVertical: 2, borderWidth: 1, borderColor: colors.warning[100],
  },
  productRight: { alignItems: 'flex-end', gap: 4 },
  priceText: { color: palette.textPrimary },
  stockBadge: { borderRadius: radius.sm, paddingHorizontal: spacing[2], paddingVertical: 2 },
  restoreBtn: {
    borderRadius: radius.sm, paddingHorizontal: spacing[3], paddingVertical: spacing[1.5],
    borderWidth: 1.5, borderColor: palette.primary, backgroundColor: palette.primaryLight,
  },
  emptyState: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing[8], gap: spacing[3] },
  emptyIcon: { fontSize: 48 },
  emptyDesc: { textAlign: 'center', maxWidth: 260 },

  // Modal shared
  modalSafe: { flex: 1, backgroundColor: palette.background },
  modalHeader: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: spacing[5], paddingVertical: spacing[4],
    borderBottomWidth: 1, borderBottomColor: palette.border, backgroundColor: palette.surface,
  },
  modalCancel: { minWidth: 64 },
  modalContent: { padding: spacing[5], gap: spacing[4] },
  modalFooter: {
    padding: spacing[5], borderTopWidth: 1, borderTopColor: palette.border, backgroundColor: palette.surface,
  },
  formError: { backgroundColor: palette.dangerLight, borderRadius: radius.md, padding: spacing[3] },

  // 4-field primary form — compact, zero-scroll layout
  formStack: {},
  fieldBlock: {
    paddingHorizontal: spacing[5], paddingTop: spacing[2.5], paddingBottom: spacing[2.5],
    borderBottomWidth: 1, borderBottomColor: palette.border, gap: spacing[1.5],
  },
  fieldLabel: {
    fontSize: 11, fontWeight: '600' as const, color: palette.textSecondary,
    letterSpacing: 0.6, textTransform: 'uppercase' as const,
  },
  fieldInput: {
    fontSize: 22, fontWeight: '600' as const, color: palette.textPrimary,
    paddingVertical: 0, minHeight: 36,
  },
  fieldRow: { flexDirection: 'row', alignItems: 'center', gap: spacing[3] },
  unitTag: { fontSize: 15, fontWeight: '500' as const, color: palette.textSecondary },
  liveCalcBlock: {
    paddingHorizontal: spacing[5], paddingVertical: spacing[2.5],
    borderBottomWidth: 1, borderBottomColor: palette.border,
  },
  liveCalcText: { fontSize: 14, color: palette.textSecondary, fontWeight: '500' as const },
  detailsBtn: {
    paddingHorizontal: spacing[5], paddingVertical: spacing[3],
    alignItems: 'center' as const,
    borderBottomWidth: 1, borderBottomColor: palette.border,
  },

  // Supplier picker
  pickerField: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: spacing[4], paddingVertical: spacing[3],
    borderRadius: radius.md, borderWidth: 1, backgroundColor: palette.surface,
  },
  supplierDropdown: {
    borderTopWidth: 1, borderTopColor: palette.border,
    backgroundColor: palette.surface,
  },
  supplierRow: {
    paddingHorizontal: spacing[5], paddingVertical: spacing[3],
    borderBottomWidth: 1, borderBottomColor: palette.border, gap: 2,
  },
  supplierRowActive: { backgroundColor: palette.primaryLight },
  newSupplierForm: {
    paddingHorizontal: spacing[5], paddingVertical: spacing[4],
    gap: spacing[3],
    borderTopWidth: 1, borderTopColor: palette.border,
    backgroundColor: palette.surface,
  },

  // Stock adjust
  stockPreview: { alignItems: 'center', gap: spacing[1] },
  typeRow: { flexDirection: 'row', gap: spacing[3] },
  typeChip: {
    flex: 1, alignItems: 'center', paddingVertical: spacing[3],
    borderRadius: radius.md, borderWidth: 1.5, borderColor: palette.border, backgroundColor: palette.surface,
  },
  typeChipEntree: { backgroundColor: colors.success[600], borderColor: colors.success[600] },
  typeChipPerte: { backgroundColor: colors.danger[600], borderColor: colors.danger[600] },
});
