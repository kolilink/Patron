import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
import { DatePickerField } from '@/src/components/ui/DatePickerField';
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

const UNITS = ['pcs', 'kg', 'g', 'L', 'mL', 'boîte', 'sac', 'carton', 'paire', 'lot'];

function todayIso() {
  return new Date().toISOString().split('T')[0];
}

// ─── Form State ───────────────────────────────────────────────────────────────

interface FormState {
  name: string;
  sku: string;
  category: string;
  unit: string;
  cost_price: string;
  sale_price: string;
  reorder_level: string;
  initial_stock: string;
  supplier_id: string;
  purchase_date: string;
  has_bulk: boolean;
  bulk_price: string;
  bulk_min_qty: string;
}

const EMPTY_FORM: FormState = {
  name: '',
  sku: '',
  category: '',
  unit: 'pcs',
  cost_price: '0',
  sale_price: '0',
  reorder_level: '0',
  initial_stock: '0',
  supplier_id: '',
  purchase_date: todayIso(),
  has_bulk: false,
  bulk_price: '0',
  bulk_min_qty: '2',
};

function productToForm(p: Product): FormState {
  return {
    name: p.name,
    sku: p.sku ?? '',
    category: p.category ?? '',
    unit: p.unit,
    cost_price: String(p.cost_price),
    sale_price: String(p.sale_price),
    reorder_level: String(p.reorder_level),
    initial_stock: '0',
    supplier_id: p.supplier_id ?? '',
    purchase_date: p.purchase_date ?? todayIso(),
    has_bulk: !!p.bulk_price,
    bulk_price: p.bulk_price ? String(p.bulk_price) : '0',
    bulk_min_qty: p.bulk_min_qty ? String(p.bulk_min_qty) : '2',
  };
}

function validateForm(f: FormState): string | null {
  if (!f.name.trim()) return 'Le nom du produit est requis.';
  const sp = parseFloat(f.sale_price);
  if (isNaN(sp) || sp < 0) return 'Prix de vente invalide.';
  const cp = parseFloat(f.cost_price);
  if (isNaN(cp) || cp < 0) return "Prix d'achat invalide.";
  if (f.has_bulk) {
    const bp = parseFloat(f.bulk_price);
    if (isNaN(bp) || bp <= 0) return 'Prix en gros invalide.';
    const bq = parseInt(f.bulk_min_qty);
    if (isNaN(bq) || bq < 2) return 'Quantité min. en gros doit être ≥ 2.';
  }
  return null;
}

function formToData(f: FormState): CreateProductData {
  return {
    name: f.name,
    sku: f.sku || null,
    category: f.category || null,
    unit: f.unit,
    cost_price: parseFloat(f.cost_price) || 0,
    sale_price: parseFloat(f.sale_price) || 0,
    reorder_level: parseInt(f.reorder_level) || 0,
    initial_stock: parseInt(f.initial_stock) || 0,
    supplier_id: f.supplier_id || null,
    purchase_date: f.purchase_date || null,
    bulk_price: f.has_bulk ? (parseFloat(f.bulk_price) || null) : null,
    bulk_min_qty: f.has_bulk ? (parseInt(f.bulk_min_qty) || null) : null,
  };
}

// ─── Quick Supplier Create Modal ──────────────────────────────────────────────

interface QuickSupplierModalProps {
  visible: boolean;
  onClose: () => void;
  onCreated: (id: string, name: string) => void;
  businessId: string;
  userId: string;
}

function QuickSupplierModal({ visible, onClose, onCreated, businessId, userId }: QuickSupplierModalProps) {
  const { saving, createFournisseur } = useFournisseursStore();
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');

  useEffect(() => {
    if (visible) { setName(''); setPhone(''); }
  }, [visible]);

  const handleCreate = async () => {
    if (!name.trim()) { Alert.alert('Nom requis'); return; }
    const ok = await createFournisseur(businessId, userId, { name, phone });
    if (ok) {
      const { fournisseurs } = useFournisseursStore.getState();
      const created = fournisseurs.find(f => f.name.trim() === name.trim());
      if (created) onCreated(created.id, created.name);
      onClose();
    }
  };

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="formSheet" onRequestClose={onClose}>
      <SafeAreaView style={styles.modalSafe}>
        <View style={styles.modalHeader}>
          <Pressable onPress={onClose}><Text variant="body" color="secondary">Annuler</Text></Pressable>
          <Text variant="h4">Nouveau fournisseur</Text>
          <View style={{ width: 64 }} />
        </View>
        <ScrollView contentContainerStyle={styles.modalContent} keyboardShouldPersistTaps="handled">
          <Input label="Nom *" value={name} onChangeText={setName} placeholder="Ex: Marché Central" />
          <Input label="Téléphone" value={phone} onChangeText={setPhone} placeholder="Optionnel" keyboardType="phone-pad" />
        </ScrollView>
        <View style={styles.modalFooter}>
          <Button label={saving ? 'Création…' : 'Créer le fournisseur'} onPress={handleCreate} loading={saving} fullWidth size="lg" />
        </View>
      </SafeAreaView>
    </Modal>
  );
}

// ─── Supplier Picker ──────────────────────────────────────────────────────────

interface SupplierPickerProps {
  fournisseurs: Fournisseur[];
  selectedId: string;
  onSelect: (id: string) => void;
  onCreateNew: () => void;
}

function SupplierPicker({ fournisseurs, selectedId, onSelect, onCreateNew }: SupplierPickerProps) {
  const selected = fournisseurs.find(f => f.id === selectedId);
  const [open, setOpen] = useState(false);

  return (
    <View>
      <Text variant="label" style={{ marginBottom: spacing[1] }}>Fournisseur</Text>
      <Pressable
        onPress={() => setOpen(true)}
        style={[styles.pickerField, { borderColor: palette.border }]}
      >
        <Text variant="body" style={{ color: selected ? palette.textPrimary : palette.textDisabled }}>
          {selected ? selected.name : 'Sélectionner un fournisseur…'}
        </Text>
        <Text variant="caption" color="secondary">›</Text>
      </Pressable>

      <Modal visible={open} animationType="slide" presentationStyle="formSheet" onRequestClose={() => setOpen(false)}>
        <SafeAreaView style={styles.modalSafe}>
          <View style={styles.modalHeader}>
            <Pressable onPress={() => setOpen(false)}><Text variant="body" color="secondary">Annuler</Text></Pressable>
            <Text variant="h4">Fournisseur</Text>
            <View style={{ width: 64 }} />
          </View>
          <ScrollView contentContainerStyle={{ paddingVertical: spacing[2] }}>
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
            <Pressable onPress={() => { setOpen(false); onCreateNew(); }} style={styles.supplierRow}>
              <Text variant="label" style={{ color: palette.primary }}>+ Créer un nouveau fournisseur</Text>
            </Pressable>
          </ScrollView>
        </SafeAreaView>
      </Modal>
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
  const [showQuickSupplier, setShowQuickSupplier] = useState(false);
  const nameRef = useRef<TextInput>(null);

  useEffect(() => {
    if (visible) {
      setForm(editing ? productToForm(editing) : EMPTY_FORM);
      setFormError(null);
      setTimeout(() => nameRef.current?.focus(), 200);
    }
  }, [visible, editing]);

  const set = (key: keyof FormState) => (val: string | boolean) =>
    setForm(prev => ({ ...prev, [key]: val }));

  const handleSave = async () => {
    const err = validateForm(form);
    if (err) { setFormError(err); return; }
    setFormError(null);
    await onSave(formToData(form));
  };

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <SafeAreaView style={styles.modalSafe}>
        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1 }}>
          <View style={styles.modalHeader}>
            <Pressable onPress={onClose} style={styles.modalCancel}>
              <Text variant="body" color="secondary">Annuler</Text>
            </Pressable>
            <Text variant="h4">{editing ? 'Modifier le produit' : 'Nouveau produit'}</Text>
            <View style={{ width: 64 }} />
          </View>

          <ScrollView contentContainerStyle={styles.modalContent} keyboardShouldPersistTaps="handled">
            {formError && (
              <View style={styles.formError}>
                <Text variant="bodySmall" color="danger">{formError}</Text>
              </View>
            )}

            <Input label="Nom du produit *" value={form.name} onChangeText={set('name')}
              placeholder="Ex: Riz local 25kg" ref={nameRef} returnKeyType="next" />

            <View style={styles.row}>
              <View style={{ flex: 1 }}>
                <Input label="SKU / Référence" value={form.sku} onChangeText={set('sku')}
                  placeholder="Optionnel" autoCapitalize="characters" />
              </View>
              <View style={{ flex: 1 }}>
                <Input label="Catégorie" value={form.category} onChangeText={set('category')}
                  placeholder="Ex: Alimentation" />
              </View>
            </View>

            {/* Supplier */}
            <SupplierPicker
              fournisseurs={fournisseurs}
              selectedId={form.supplier_id}
              onSelect={id => setForm(p => ({ ...p, supplier_id: id }))}
              onCreateNew={() => setShowQuickSupplier(true)}
            />

            {/* Purchase date */}
            <DatePickerField
              label="Date d'achat"
              value={form.purchase_date}
              onChange={d => setForm(p => ({ ...p, purchase_date: d }))}
              maxToday
            />

            {/* Unit */}
            <View>
              <Text variant="label" style={styles.unitLabel}>Unité</Text>
              <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.unitScroll}>
                {UNITS.map(u => (
                  <Pressable key={u} onPress={() => setForm(p => ({ ...p, unit: u }))}
                    style={[styles.unitChip, form.unit === u && styles.unitChipActive]}>
                    <Text variant="bodySmall"
                      style={{ color: form.unit === u ? palette.textInverse : palette.textPrimary }}>
                      {u}
                    </Text>
                  </Pressable>
                ))}
              </ScrollView>
            </View>

            <View style={styles.row}>
              <View style={{ flex: 1 }}>
                <Input label={`Prix d'achat (${currency})`} value={form.cost_price}
                  onChangeText={set('cost_price')} keyboardType="decimal-pad" placeholder="0" />
              </View>
              <View style={{ flex: 1 }}>
                <Input label={`Prix de vente (${currency}) *`} value={form.sale_price}
                  onChangeText={set('sale_price')} keyboardType="decimal-pad" placeholder="0" />
              </View>
            </View>

            <View style={styles.row}>
              <View style={{ flex: 1 }}>
                <Input label="Seuil d'alerte stock" value={form.reorder_level}
                  onChangeText={set('reorder_level')} keyboardType="number-pad"
                  placeholder="0" hint="Alerte si stock ≤ ce seuil" />
              </View>
              {!editing && (
                <View style={{ flex: 1 }}>
                  <Input label="Stock initial" value={form.initial_stock}
                    onChangeText={set('initial_stock')} keyboardType="number-pad"
                    placeholder="0" hint="Quantité en stock aujourd'hui" />
                </View>
              )}
            </View>

            {/* Bulk toggle */}
            <Pressable
              onPress={() => setForm(p => ({ ...p, has_bulk: !p.has_bulk }))}
              style={[styles.toggleRow, form.has_bulk && styles.toggleRowActive]}
            >
              <View style={{ flex: 1 }}>
                <Text variant="label">Vente en gros disponible</Text>
                <Text variant="caption" color="secondary">Prix spécial pour les achats en quantité</Text>
              </View>
              <View style={[styles.toggle, form.has_bulk && styles.toggleOn]}>
                <Text variant="caption" style={{ color: form.has_bulk ? palette.textInverse : palette.textSecondary }}>
                  {form.has_bulk ? 'OUI' : 'NON'}
                </Text>
              </View>
            </Pressable>

            {form.has_bulk && (
              <View style={styles.row}>
                <View style={{ flex: 1 }}>
                  <Input label={`Prix en gros (${currency})`} value={form.bulk_price}
                    onChangeText={set('bulk_price')} keyboardType="decimal-pad"
                    placeholder="0" hint="Prix par unité en gros" />
                </View>
                <View style={{ flex: 1 }}>
                  <Input label="Qté min. en gros" value={form.bulk_min_qty}
                    onChangeText={set('bulk_min_qty')} keyboardType="number-pad"
                    placeholder="2" hint="À partir de combien d'unités" />
                </View>
              </View>
            )}

            {form.cost_price && form.sale_price && parseFloat(form.cost_price) > 0 && (
              <View style={styles.marginPreview}>
                <Text variant="caption" color="secondary">Marge brute estimée</Text>
                <Text variant="label" style={{ color: palette.success }}>
                  {(((parseFloat(form.sale_price) - parseFloat(form.cost_price)) / parseFloat(form.cost_price)) * 100).toFixed(1)}%
                  {' '}(+{(parseFloat(form.sale_price) - parseFloat(form.cost_price)).toLocaleString('fr-FR')} {currency})
                </Text>
              </View>
            )}
          </ScrollView>

          <View style={styles.modalFooter}>
            <Button label={saving ? 'Enregistrement…' : 'Enregistrer'} onPress={handleSave}
              loading={saving} fullWidth size="lg" />
          </View>
        </KeyboardAvoidingView>
      </SafeAreaView>

      <QuickSupplierModal
        visible={showQuickSupplier}
        onClose={() => setShowQuickSupplier(false)}
        onCreated={(id) => setForm(p => ({ ...p, supplier_id: id }))}
        businessId={businessId}
        userId={userId}
      />
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
      <SafeAreaView style={styles.modalSafe}>
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
        <View style={styles.productMeta}>
          {product.category && (
            <View style={styles.categoryBadge}>
              <Text variant="caption" color="secondary">{product.category}</Text>
            </View>
          )}
          {margin && (
            <Text variant="caption" style={{ color: palette.success }}>+{margin}%</Text>
          )}
        </View>
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

  useEffect(() => {
    if (businessId) {
      fetchProducts(businessId, userId);
      fetchFournisseurs(businessId);
    }
  }, [businessId]);

  useEffect(() => {
    if (businessId && tab === 'archives') {
      fetchArchivedProducts(businessId);
    }
  }, [tab, businessId]);

  const activeFiltered = useMemo(() => {
    const q = search.toLowerCase().trim();
    if (!q) return products;
    return products.filter(
      p =>
        p.name.toLowerCase().includes(q) ||
        (p.category?.toLowerCase().includes(q) ?? false) ||
        (p.sku?.toLowerCase().includes(q) ?? false),
    );
  }, [products, search]);

  const archivedFiltered = useMemo(() => {
    const q = search.toLowerCase().trim();
    if (!q) return archivedProducts;
    return archivedProducts.filter(p => p.name.toLowerCase().includes(q));
  }, [archivedProducts, search]);

  const categories = useMemo(() => {
    const cats = new Set(products.map(p => p.category).filter(Boolean) as string[]);
    return Array.from(cats).sort();
  }, [products]);

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
                { text: 'Archiver', style: 'destructive', onPress: () => archiveProduct(product.id) },
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
      if (ok) { setShowForm(false); setEditingProduct(null); }
    },
    [editingProduct, businessId, userId, createProduct, updateProduct],
  );

  const handleAdjust = useCallback(
    async (qty: number, type: 'entree' | 'perte', note: string) => {
      if (!adjustTarget) return;
      await adjustStock(adjustTarget.id, businessId, userId, qty, type, note);
      setShowAdjust(false);
      setAdjustTarget(null);
    },
    [adjustTarget, businessId, userId, adjustStock],
  );

  const lowStockCount = products.filter(p => p.stock_qty <= p.reorder_level && p.reorder_level > 0).length;
  const displayList = tab === 'actifs' ? activeFiltered : archivedFiltered;

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      {/* Header */}
      <View style={styles.header}>
        <View>
          <Text variant="h3">Catalogue</Text>
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
          {categories.length > 0 && (
            <View style={styles.statChip}>
              <Text variant="caption" color="secondary">Catégories</Text>
              <Text variant="label">{categories.length}</Text>
            </View>
          )}
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
  row: { flexDirection: 'row', gap: spacing[3] },
  unitLabel: { marginBottom: spacing[2], color: palette.textPrimary },
  unitScroll: { flexGrow: 0, marginBottom: spacing[1] },
  unitChip: {
    paddingHorizontal: spacing[3], paddingVertical: spacing[1.5], borderRadius: radius.full,
    borderWidth: 1, borderColor: palette.border, marginRight: spacing[2], backgroundColor: palette.surface,
  },
  unitChipActive: { backgroundColor: palette.primary, borderColor: palette.primary },
  marginPreview: { backgroundColor: colors.success[50], borderRadius: radius.md, padding: spacing[3], gap: 4 },

  // Bulk toggle
  toggleRow: {
    flexDirection: 'row', alignItems: 'center', gap: spacing[3],
    padding: spacing[4], borderRadius: radius.md, borderWidth: 1.5, borderColor: palette.border,
    backgroundColor: palette.surface,
  },
  toggleRowActive: { borderColor: palette.primary, backgroundColor: palette.primaryLight },
  toggle: {
    paddingHorizontal: spacing[3], paddingVertical: spacing[1.5],
    borderRadius: radius.full, borderWidth: 1, borderColor: palette.border, backgroundColor: palette.surface,
  },
  toggleOn: { backgroundColor: palette.primary, borderColor: palette.primary },

  // Supplier picker
  pickerField: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: spacing[4], paddingVertical: spacing[3],
    borderRadius: radius.md, borderWidth: 1, backgroundColor: palette.surface,
  },
  supplierRow: {
    paddingHorizontal: spacing[5], paddingVertical: spacing[3],
    borderBottomWidth: 1, borderBottomColor: palette.border, gap: 2,
  },
  supplierRowActive: { backgroundColor: palette.primaryLight },

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
