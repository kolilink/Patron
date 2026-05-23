import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  FlatList,
  Keyboard,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { Button } from '@/src/components/ui/Button';
import { Card } from '@/src/components/ui/Card';
import { Input } from '@/src/components/ui/Input';
import { Text } from '@/src/components/ui/Text';
import { DatePickerField } from '@/src/components/ui/DatePickerField';
import { colors, palette, radius, spacing } from '@/src/theme';
import type { Product } from '@/src/types';
import { useAuthStore } from '@/stores/auth';
import { useProductStore } from '@/stores/products';
import type { CartLine, SalePayment } from '@/stores/sales';
import { useSalesStore } from '@/stores/sales';
import { supabase } from '@/lib/supabase';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatAmount(n: number, currency: string) {
  return `${n.toLocaleString('fr-FR')} ${currency}`;
}

function todayIso() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const PAYMENT_METHODS = [
  { key: 'especes' as const, label: 'Espèces' },
  { key: 'digital' as const, label: 'Numérique' },
  { key: 'credit' as const, label: 'Crédit client' },
];

// ─── Cart line row ────────────────────────────────────────────────────────────

interface CartRowProps {
  line: CartLine;
  currency: string;
  onInc: () => void;
  onDec: () => void;
  onRemove: () => void;
  onToggleBulk: () => void;
}

function CartRow({ line, currency, onInc, onDec, onRemove, onToggleBulk }: CartRowProps) {
  const hasBulk = !!(line.product.bulk_price && line.product.bulk_min_qty);

  return (
    <View style={styles.cartRow}>
      <View style={{ flex: 1 }}>
        <Text variant="label" numberOfLines={1}>{line.product.name}</Text>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing[2] }}>
          <Text variant="caption" color="secondary">
            {formatAmount(line.unit_price, currency)} / {line.is_bulk ? 'lot' : line.product.unit}
          </Text>
          {hasBulk && (
            <Pressable onPress={onToggleBulk} style={[styles.bulkToggle, line.is_bulk && styles.bulkToggleActive]}>
              <Text variant="caption" style={{ color: line.is_bulk ? palette.textInverse : palette.textSecondary, fontWeight: '700' }}>
                {line.is_bulk ? 'GROS' : 'DÉTAIL'}
              </Text>
            </Pressable>
          )}
        </View>
      </View>
      <View style={styles.qtyControl}>
        <Pressable onPress={onDec} style={styles.qtyBtn}>
          <Text variant="label" style={{ color: line.qty === 1 ? palette.danger : palette.textPrimary }}>−</Text>
        </Pressable>
        <Text variant="label" style={styles.qtyNum}>{line.qty}</Text>
        <Pressable onPress={onInc} style={styles.qtyBtn}>
          <Text variant="label" style={{ color: palette.primary }}>+</Text>
        </Pressable>
      </View>
      <View style={{ minWidth: 80, alignItems: 'flex-end' }}>
        <Text variant="label">{formatAmount(line.unit_price * line.qty, currency)}</Text>
      </View>
    </View>
  );
}

// ─── Client picker ────────────────────────────────────────────────────────────

interface ClientPickerProps {
  businessId: string;
  sellerId: string;
  isVendeur: boolean;
  value: string;
  onChange: (name: string) => void;
}

function ClientPicker({ businessId, sellerId, isVendeur, value, onChange }: ClientPickerProps) {
  const [clientNames, setClientNames] = useState<string[]>([]);
  const [showList, setShowList] = useState(false);

  useEffect(() => {
    loadClients();
  }, [businessId]);

  const loadClients = async () => {
    let query = supabase
      .from('sale_orders')
      .select('customer_name')
      .eq('business_id', businessId)
      .not('customer_name', 'is', null);

    if (isVendeur) query = query.eq('seller_id', sellerId);

    const { data } = await query;
    if (data) {
      const names = [...new Set(
        (data as { customer_name: string }[])
          .map(r => r.customer_name?.trim())
          .filter(Boolean) as string[],
      )].sort();
      setClientNames(names);
    }
  };

  const suggestions = useMemo(() => {
    if (!value.trim()) return clientNames;
    const q = value.toLowerCase();
    return clientNames.filter(n => n.toLowerCase().includes(q));
  }, [value, clientNames]);

  return (
    <View>
      <Text variant="label" style={{ marginBottom: spacing[1] }}>Client</Text>
      <TextInput
        style={styles.clientInput}
        value={value}
        onChangeText={v => { onChange(v); setShowList(true); }}
        onFocus={() => setShowList(true)}
        placeholder="Nom du client (optionnel)"
        placeholderTextColor={palette.textDisabled}
      />
      {showList && suggestions.length > 0 && (
        <View style={styles.suggestionList}>
          <ScrollView keyboardShouldPersistTaps="handled" style={{ maxHeight: 160 }}>
            {suggestions.map(name => (
              <Pressable
                key={name}
                onPress={() => { onChange(name); setShowList(false); Keyboard.dismiss(); }}
                style={styles.suggestionRow}
              >
                <Text variant="body">{name}</Text>
              </Pressable>
            ))}
          </ScrollView>
        </View>
      )}
    </View>
  );
}

// ─── Payment modal ────────────────────────────────────────────────────────────

interface PaymentModalProps {
  visible: boolean;
  total: number;
  currency: string;
  businessId: string;
  sellerId: string;
  isVendeur: boolean;
  onClose: () => void;
  onConfirm: (payment: SalePayment, customerName?: string, saleDate?: string) => void;
  submitting: boolean;
}

function PaymentModal({
  visible, total, currency, businessId, sellerId, isVendeur,
  onClose, onConfirm, submitting,
}: PaymentModalProps) {
  const [method, setMethod] = useState<'especes' | 'digital' | 'credit'>('especes');
  const [customerName, setCustomerName] = useState('');
  const [amountGiven, setAmountGiven] = useState('');
  const [saleDate, setSaleDate] = useState(todayIso());

  useEffect(() => {
    if (visible) {
      setMethod('especes');
      setCustomerName('');
      setAmountGiven(String(total));
      setSaleDate(todayIso());
    }
  }, [visible, total]);

  const change = useMemo(() => {
    const given = parseFloat(amountGiven) || 0;
    return given - total;
  }, [amountGiven, total]);

  const handleConfirm = () => {
    if (method === 'credit' && !customerName.trim()) {
      Alert.alert('Nom requis', 'Entrez le nom du client pour enregistrer un crédit.');
      return;
    }
    onConfirm({ method, amount: total }, customerName || undefined, saleDate);
  };

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="formSheet" onRequestClose={onClose}>
      <SafeAreaView style={styles.modalSafe}>
        <View style={styles.modalHeader}>
          <Pressable onPress={onClose} style={styles.modalCancel}>
            <Text variant="body" color="secondary">Retour</Text>
          </Pressable>
          <Text variant="h4">Encaisser</Text>
          <View style={{ width: 64 }} />
        </View>

        <ScrollView contentContainerStyle={styles.modalContent} keyboardShouldPersistTaps="handled">
          <Card style={styles.totalCard}>
            <Text variant="caption" color="secondary">Total à encaisser</Text>
            <Text variant="amountLarge" style={styles.totalAmount}>
              {formatAmount(total, currency)}
            </Text>
          </Card>

          <DatePickerField
            label="Date de la vente"
            value={saleDate}
            onChange={setSaleDate}
            maxToday
          />

          <View>
            <Text variant="label" style={styles.sectionLabel}>Mode de paiement</Text>
            <View style={styles.methodGrid}>
              {PAYMENT_METHODS.map(m => (
                <Pressable key={m.key} onPress={() => setMethod(m.key)}
                  style={[styles.methodChip, method === m.key && styles.methodChipActive]}>
                  <Text variant="label"
                    style={{ color: method === m.key ? palette.textInverse : palette.textPrimary, textAlign: 'center' }}>
                    {m.label}
                  </Text>
                </Pressable>
              ))}
            </View>
          </View>

          {method === 'credit' ? (
            <View>
              <Text variant="label" style={{ marginBottom: spacing[1] }}>Client * <Text variant="caption" color="danger">(requis)</Text></Text>
              <ClientPicker
                businessId={businessId}
                sellerId={sellerId}
                isVendeur={isVendeur}
                value={customerName}
                onChange={setCustomerName}
              />
            </View>
          ) : (
            <ClientPicker
              businessId={businessId}
              sellerId={sellerId}
              isVendeur={isVendeur}
              value={customerName}
              onChange={setCustomerName}
            />
          )}

          {method === 'especes' && (
            <View style={{ gap: spacing[3] }}>
              <Input label="Montant donné par le client" value={amountGiven}
                onChangeText={setAmountGiven} keyboardType="decimal-pad"
                placeholder={String(total)} />
              {change !== 0 && (
                <View style={[styles.changeRow, { backgroundColor: change >= 0 ? colors.success[50] : colors.danger[50] }]}>
                  <Text variant="label" style={{ color: change >= 0 ? palette.success : palette.danger }}>
                    {change >= 0
                      ? `Rendu monnaie: ${formatAmount(change, currency)}`
                      : `Manque: ${formatAmount(Math.abs(change), currency)}`}
                  </Text>
                </View>
              )}
            </View>
          )}
        </ScrollView>

        <View style={styles.modalFooter}>
          <Button
            label={submitting ? 'Enregistrement…' : (method === 'credit' ? 'Enregistrer le crédit' : 'Confirmer le paiement')}
            onPress={handleConfirm}
            loading={submitting}
            fullWidth
            size="lg"
            variant={method === 'credit' ? 'outline' : 'primary'}
          />
        </View>
      </SafeAreaView>
    </Modal>
  );
}

// ─── Product tile ─────────────────────────────────────────────────────────────

interface ProductTileProps {
  product: Product;
  currency: string;
  onAdd: () => void;
  onAddBulk?: () => void;
  cartQty: number;
  cartBulkQty: number;
}

function ProductTile({ product, currency, onAdd, onAddBulk, cartQty, cartBulkQty }: ProductTileProps) {
  const outOfStock = product.stock_qty === 0;
  const totalInCart = cartQty + cartBulkQty;
  const hasBulk = !!(product.bulk_price && product.bulk_min_qty);

  return (
    <Pressable
      onPress={outOfStock ? undefined : onAdd}
      onLongPress={hasBulk && !outOfStock ? onAddBulk : undefined}
      style={({ pressed }) => [
        styles.tile,
        outOfStock && styles.tileDisabled,
        pressed && !outOfStock && { opacity: 0.75 },
      ]}
    >
      {totalInCart > 0 && (
        <View style={styles.tileBadge}>
          <Text variant="caption" style={{ color: palette.textInverse, fontWeight: '700' }}>{totalInCart}</Text>
        </View>
      )}
      {hasBulk && (
        <View style={styles.tileGrosBadge}>
          <Text variant="caption" style={{ color: colors.warning[700], fontSize: 9 }}>GROS</Text>
        </View>
      )}
      <Text variant="label" numberOfLines={2} style={styles.tileName}>{product.name}</Text>
      <Text variant="caption" color="secondary" numberOfLines={1}>
        {outOfStock ? 'Rupture de stock' : `${product.stock_qty} ${product.unit}`}
      </Text>
      <Text variant="label" style={{ color: outOfStock ? palette.textDisabled : palette.primary }}>
        {formatAmount(product.sale_price, currency)}
      </Text>
      {hasBulk && product.bulk_price ? (
        <Text variant="caption" style={{ color: colors.warning[700] }}>
          Gros: {formatAmount(product.bulk_price, currency)}
        </Text>
      ) : null}
    </Pressable>
  );
}

// ─── Main Screen ──────────────────────────────────────────────────────────────

export default function VendreScreen() {
  const session = useAuthStore(s => s.session);
  const business = session?.activeBusiness;
  const userId = session?.user.id ?? '';
  const businessId = business?.id ?? '';
  const currency = business?.currency ?? 'GNF';
  const role = session?.activeMembership?.role;
  const isVendeur = role === 'vendeur';

  const { products, loading, fetchProducts } = useProductStore();
  const { cart, submitting, addToCart, removeFromCart, setQty, toggleBulk, clearCart, submitSale } =
    useSalesStore();

  const [search, setSearch] = useState('');
  const [showPayment, setShowPayment] = useState(false);

  useEffect(() => {
    if (businessId) fetchProducts(businessId, userId);
  }, [businessId]);

  const filtered = useMemo(() => {
    const q = search.toLowerCase().trim();
    if (!q) return products;
    return products.filter(
      p =>
        p.name.toLowerCase().includes(q) ||
        (p.category?.toLowerCase().includes(q) ?? false),
    );
  }, [products, search]);

  const cartTotal = useMemo(() => cart.reduce((s, l) => s + l.unit_price * l.qty, 0), [cart]);
  const cartCount = useMemo(() => cart.reduce((s, l) => s + l.qty, 0), [cart]);

  const cartQtyMap = useMemo(() => {
    const map: Record<string, { unit: number; bulk: number }> = {};
    for (const l of cart) {
      if (!map[l.product.id]) map[l.product.id] = { unit: 0, bulk: 0 };
      if (l.is_bulk) map[l.product.id].bulk += l.qty;
      else map[l.product.id].unit += l.qty;
    }
    return map;
  }, [cart]);

  const handleConfirmPayment = useCallback(
    async (payment: SalePayment, customerName?: string, saleDate?: string) => {
      const total = cartTotal;
      const ok = await submitSale(businessId, userId, payment, customerName, saleDate);
      if (ok) {
        setShowPayment(false);
        fetchProducts(businessId, userId);
        Alert.alert(
          'Vente enregistrée',
          formatAmount(total, currency),
          [{ text: 'OK', onPress: () => setSearch('') }],
        );
      }
    },
    [businessId, userId, cartTotal, currency, submitSale, fetchProducts],
  );

  if (products.length === 0 && !loading) {
    return (
      <SafeAreaView style={styles.safe} edges={['top']}>
        <View style={styles.emptyFull}>
          <Ionicons name="receipt-outline" size={48} color={palette.textDisabled} />
          <Text variant="h4">Point de vente</Text>
          <Text variant="body" color="secondary" style={styles.emptyDesc}>
            Ajoutez des produits dans votre catalogue pour commencer à enregistrer des ventes.
          </Text>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      {/* Header */}
      <View style={styles.header}>
        <Text variant="h3">Vendre</Text>
        {cart.length > 0 && (
          <Pressable onPress={() => Alert.alert('Vider le panier ?', '', [
            { text: 'Annuler', style: 'cancel' },
            { text: 'Vider', style: 'destructive', onPress: clearCart },
          ])}>
            <Text variant="bodySmall" color="danger">Vider</Text>
          </Pressable>
        )}
      </View>

      {/* Search */}
      <View style={styles.searchRow}>
        <Input placeholder="Rechercher un produit…" value={search} onChangeText={setSearch} />
      </View>

      {/* Bulk hint */}
      {products.some(p => p.bulk_price) && (
        <View style={styles.hintBanner}>
          <Ionicons name="information-circle-outline" size={14} color={colors.warning[700]} />
          <Text variant="caption" style={{ color: colors.warning[700], flex: 1 }}>
            Maintenez un produit en gros pour l'ajouter en vente de gros
          </Text>
        </View>
      )}

      {/* Product grid */}
      <FlatList
        data={filtered}
        keyExtractor={p => p.id}
        numColumns={2}
        columnWrapperStyle={styles.tileRow}
        contentContainerStyle={[styles.tileList, cart.length > 0 && { paddingBottom: 240 }]}
        showsVerticalScrollIndicator={false}
        renderItem={({ item }) => (
          <ProductTile
            product={item}
            currency={currency}
            cartQty={cartQtyMap[item.id]?.unit ?? 0}
            cartBulkQty={cartQtyMap[item.id]?.bulk ?? 0}
            onAdd={() => { Keyboard.dismiss(); addToCart(item, false); }}
            onAddBulk={() => { Keyboard.dismiss(); addToCart(item, true); }}
          />
        )}
        ListEmptyComponent={
          <View style={styles.emptySearch}>
            <Text variant="body" color="secondary">Aucun résultat pour "{search}"</Text>
          </View>
        }
      />

      {/* Cart panel (floating) */}
      {cart.length > 0 && (
        <View style={styles.cartPanel}>
          <ScrollView style={styles.cartScroll} keyboardShouldPersistTaps="handled">
            {cart.map(line => (
              <CartRow
                key={`${line.product.id}-${line.is_bulk}`}
                line={line}
                currency={currency}
                onInc={() => setQty(line.product.id, line.qty + 1, line.is_bulk)}
                onDec={() => setQty(line.product.id, line.qty - 1, line.is_bulk)}
                onRemove={() => removeFromCart(line.product.id, line.is_bulk)}
                onToggleBulk={() => toggleBulk(line.product.id, line.is_bulk)}
              />
            ))}
          </ScrollView>
          <View style={styles.cartFooter}>
            <View>
              <Text variant="caption" color="secondary">{cartCount} article{cartCount > 1 ? 's' : ''}</Text>
              <Text variant="amountLarge">{formatAmount(cartTotal, currency)}</Text>
            </View>
            <Button
              label="Encaisser →"
              onPress={() => setShowPayment(true)}
              size="lg"
              style={{ flex: 1, marginLeft: spacing[3] }}
            />
          </View>
        </View>
      )}

      <PaymentModal
        visible={showPayment}
        total={cartTotal}
        currency={currency}
        businessId={businessId}
        sellerId={userId}
        isVendeur={isVendeur}
        onClose={() => setShowPayment(false)}
        onConfirm={handleConfirmPayment}
        submitting={submitting}
      />
    </SafeAreaView>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const TILE_GAP = spacing[3];

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: palette.background },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: spacing[5], paddingTop: spacing[4], paddingBottom: spacing[2],
  },
  searchRow: { paddingHorizontal: spacing[5], paddingBottom: spacing[2] },
  hintBanner: {
    flexDirection: 'row', alignItems: 'center', gap: spacing[2],
    paddingHorizontal: spacing[5], paddingVertical: spacing[2],
    backgroundColor: colors.warning[50], borderBottomWidth: 1, borderBottomColor: colors.warning[100],
    marginBottom: spacing[2],
  },

  // Product tiles
  tileList: { paddingHorizontal: spacing[5], paddingBottom: spacing[6] },
  tileRow: { gap: TILE_GAP, marginBottom: TILE_GAP },
  tile: {
    flex: 1, backgroundColor: palette.surface, borderRadius: radius.lg,
    borderWidth: 1, borderColor: palette.border, padding: spacing[3], gap: spacing[1], position: 'relative',
  },
  tileDisabled: { opacity: 0.5 },
  tileName: { minHeight: 36 },
  tileBadge: {
    position: 'absolute', top: -6, right: -6, backgroundColor: palette.primary,
    borderRadius: radius.full, width: 22, height: 22, alignItems: 'center', justifyContent: 'center', zIndex: 1,
  },
  tileGrosBadge: {
    position: 'absolute', top: 4, right: 4,
    backgroundColor: colors.warning[50], borderRadius: radius.sm, paddingHorizontal: 4, paddingVertical: 2,
    borderWidth: 1, borderColor: colors.warning[100],
  },

  // Cart panel
  cartPanel: {
    position: 'absolute', bottom: 0, left: 0, right: 0,
    backgroundColor: palette.surface, borderTopWidth: 1, borderTopColor: palette.border,
    maxHeight: 280, shadowColor: '#0F172A', shadowOffset: { width: 0, height: -4 },
    shadowOpacity: 0.1, shadowRadius: 12, elevation: 10,
  },
  cartScroll: { maxHeight: 180 },
  cartRow: {
    flexDirection: 'row', alignItems: 'center', paddingHorizontal: spacing[4],
    paddingVertical: spacing[2], borderBottomWidth: 1, borderBottomColor: palette.border, gap: spacing[2],
  },
  bulkToggle: {
    paddingHorizontal: spacing[2], paddingVertical: 2, borderRadius: radius.sm,
    borderWidth: 1, borderColor: palette.border, backgroundColor: palette.surface,
  },
  bulkToggleActive: { backgroundColor: colors.warning[500], borderColor: colors.warning[500] },
  qtyControl: {
    flexDirection: 'row', alignItems: 'center', borderWidth: 1, borderColor: palette.border,
    borderRadius: radius.md, overflow: 'hidden',
  },
  qtyBtn: {
    width: 32, height: 32, alignItems: 'center', justifyContent: 'center',
    backgroundColor: palette.background,
  },
  qtyNum: { width: 28, textAlign: 'center' },
  cartFooter: {
    flexDirection: 'row', alignItems: 'center', padding: spacing[4],
    borderTopWidth: 1, borderTopColor: palette.border,
  },

  // Empty states
  emptyFull: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing[8], gap: spacing[3] },
  emptyDesc: { textAlign: 'center', maxWidth: 260 },
  emptySearch: { alignItems: 'center', paddingVertical: spacing[10] },

  // Payment modal
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
  totalCard: { alignItems: 'center', gap: spacing[1] },
  totalAmount: { color: palette.primary },
  sectionLabel: { marginBottom: spacing[2] },
  methodGrid: { flexDirection: 'row', gap: spacing[2] },
  methodChip: {
    flex: 1, alignItems: 'center', justifyContent: 'center',
    paddingVertical: spacing[3], paddingHorizontal: spacing[2],
    borderRadius: radius.md, borderWidth: 1.5, borderColor: palette.border,
    backgroundColor: palette.surface,
  },
  methodChipActive: { backgroundColor: palette.primary, borderColor: palette.primary },
  changeRow: { borderRadius: radius.md, padding: spacing[3], alignItems: 'center' },
  // Client picker
  clientInput: {
    paddingHorizontal: spacing[4], paddingVertical: spacing[3],
    borderRadius: radius.md, borderWidth: 1, borderColor: palette.border,
    backgroundColor: palette.surface, color: palette.textPrimary, fontSize: 16,
  },
  suggestionList: {
    backgroundColor: palette.surface, borderWidth: 1, borderColor: palette.border,
    borderRadius: radius.md, marginTop: spacing[1], overflow: 'hidden',
  },
  suggestionRow: {
    paddingHorizontal: spacing[4], paddingVertical: spacing[3],
    borderBottomWidth: 1, borderBottomColor: palette.border,
  },
});
