import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  FlatList,
  Keyboard,
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
import { Ionicons } from '@expo/vector-icons';
import { Button } from '@/src/components/ui/Button';
import { Card } from '@/src/components/ui/Card';
import { Input } from '@/src/components/ui/Input';
import { Text } from '@/src/components/ui/Text';
import { colors, palette, radius, spacing } from '@/src/theme';
import { formatAmount } from '@/src/utils/format';
import { todayIso } from '@/src/utils/dates';
import type { Product } from '@/src/types';
import { useAuthStore } from '@/stores/auth';
import { useProductStore } from '@/stores/products';
import type { CartLine, SalePayment } from '@/stores/sales';
import { useSalesStore } from '@/stores/sales';
import { supabase } from '@/lib/supabase';
import { haptics } from '@/lib/haptics';

// Final payment methods: Wave removed.
// 'mtn' is labeled "Mobile Money" in the UI (consolidates old mtn/moov).
const PAY_NOW_METHODS = [
  { key: 'especes' as const, label: 'Espèces' },
  { key: 'orange' as const, label: 'Orange Money' },
  { key: 'mtn' as const, label: 'Mobile Money' },
  { key: 'digital' as const, label: 'Autre' },
];

// ─── Cart line row ────────────────────────────────────────────────────────────

interface CartRowProps {
  line: CartLine;
  currency: string;
  onInc: () => void;
  onDec: () => void;
  onRemove: () => void;
  onToggleBulk: () => void;
  onSetQty: (qty: number) => void;
}

function CartRow({ line, currency, onInc, onDec, onRemove, onToggleBulk, onSetQty }: CartRowProps) {
  const hasBulk = !!(line.product.bulk_price && line.product.bulk_min_qty);
  const [editing, setEditing] = useState(false);
  const [inputVal, setInputVal] = useState('');
  const inputRef = useRef<TextInput>(null);

  const startEdit = () => {
    setInputVal(String(line.qty));
    setEditing(true);
    setTimeout(() => inputRef.current?.focus(), 30);
  };

  const commitEdit = () => {
    const n = parseInt(inputVal, 10);
    if (!isNaN(n) && n > 0) onSetQty(n);
    setEditing(false);
  };

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
        <Pressable onPress={() => { haptics.tap(); onDec(); }} style={styles.qtyBtn}>
          <Text variant="label" style={{ color: line.qty === 1 ? palette.danger : palette.textPrimary }}>−</Text>
        </Pressable>
        {editing ? (
          <TextInput
            ref={inputRef}
            style={styles.qtyInput}
            value={inputVal}
            onChangeText={setInputVal}
            onBlur={commitEdit}
            onSubmitEditing={commitEdit}
            keyboardType="number-pad"
            selectTextOnFocus
            returnKeyType="done"
          />
        ) : (
          <Pressable onPress={startEdit} style={styles.qtyNumPress}>
            <Text variant="label" style={styles.qtyNum}>{line.qty}</Text>
          </Pressable>
        )}
        <Pressable onPress={() => { haptics.tap(); onInc(); }} style={styles.qtyBtn}>
          <Text variant="label" style={{ color: palette.primary }}>+</Text>
        </Pressable>
      </View>
      <View style={{ minWidth: 80, alignItems: 'flex-end' }}>
        <Text variant="label">{formatAmount(line.unit_price * line.qty, currency)}</Text>
      </View>
    </View>
  );
}

// ─── Inline client picker ─────────────────────────────────────────────────────

interface InlineClientPickerProps {
  businessId: string;
  sellerId: string;
  isVendeur: boolean;
  value: string;
  onChange: (name: string) => void;
  required: boolean;
  expanded: boolean;
  onExpandChange: (v: boolean) => void;
}

function InlineClientPicker({
  businessId, sellerId, isVendeur,
  value, onChange, required, expanded, onExpandChange,
}: InlineClientPickerProps) {
  const [clientNames, setClientNames] = useState<string[]>([]);
  const [showList, setShowList] = useState(false);
  const [showNewForm, setShowNewForm] = useState(false);
  const [newName, setNewName] = useState('');
  const [newPhone, setNewPhone] = useState('');

  useEffect(() => { loadClients(); }, [businessId]);

  const loadClients = async () => {
    const [clientsRes, salesRes] = await Promise.all([
      supabase.from('clients').select('name').eq('business_id', businessId),
      supabase
        .from('sale_orders')
        .select('customer_name')
        .eq('business_id', businessId)
        .not('customer_name', 'is', null),
    ]);
    const fromClients = (clientsRes.data ?? []).map((r: { name: string }) => r.name);
    const fromSales = (salesRes.data ?? [])
      .map((r: { customer_name: string }) => r.customer_name?.trim())
      .filter(Boolean) as string[];
    setClientNames([...new Set([...fromClients, ...fromSales])].sort());
  };

  const suggestions = useMemo(() => {
    const q = value.toLowerCase().trim();
    if (!q) return clientNames;
    return clientNames.filter(n => n.toLowerCase().includes(q));
  }, [value, clientNames]);

  const handleAddNewClient = async () => {
    if (!newName.trim()) return;
    const name = newName.trim();
    await supabase.from('clients').upsert(
      { business_id: businessId, name, phone: newPhone.trim() || null },
      { onConflict: 'business_id,name' },
    );
    setClientNames(prev => [...new Set([...prev, name])].sort());
    onChange(name);
    setShowNewForm(false);
    setNewName('');
    setNewPhone('');
    onExpandChange(false);
  };

  // Client already selected — show name + change link
  if (value && !expanded && !showNewForm) {
    return (
      <View style={styles.clientSelectedRow}>
        <Text variant="body">
          Client : <Text variant="label">{value}</Text>
        </Text>
        <Pressable onPress={() => { onChange(''); onExpandChange(true); }}>
          <Text variant="caption" style={{ color: palette.primary }}>× changer</Text>
        </Pressable>
      </View>
    );
  }

  // Not expanded and optional — show link only
  if (!expanded && !required) {
    return (
      <Pressable onPress={() => onExpandChange(true)} style={styles.attachLink}>
        <Text variant="body" style={{ color: palette.primary }}>+ Attacher un client (optionnel)</Text>
      </Pressable>
    );
  }

  // Expanded or required — show search input + suggestions
  return (
    <View style={{ zIndex: 50, elevation: 50 }}>
      {required && !value && (
        <Text variant="caption" color="secondary" style={{ marginBottom: spacing[2] }}>
          Qui prend à crédit ?
        </Text>
      )}
      <TextInput
        style={styles.clientInput}
        value={value}
        onChangeText={v => { onChange(v); setShowList(true); }}
        onFocus={() => setShowList(true)}
        placeholder="Rechercher un client…"
        placeholderTextColor={palette.textDisabled}
        autoFocus={expanded && !required}
      />
      {showList && !showNewForm && (suggestions.length > 0 || value.trim().length >= 1) && (
        <View style={styles.suggestionList}>
          <ScrollView keyboardShouldPersistTaps="handled" style={{ maxHeight: 160 }} nestedScrollEnabled>
            {suggestions.map(name => (
              <Pressable
                key={name}
                onPress={() => { onChange(name); setShowList(false); onExpandChange(false); Keyboard.dismiss(); }}
                style={styles.suggestionRow}
              >
                <Text variant="body">{name}</Text>
              </Pressable>
            ))}
            <Pressable
              onPress={() => { setShowNewForm(true); setShowList(false); }}
              style={[styles.suggestionRow, { flexDirection: 'row', alignItems: 'center', gap: spacing[2] }]}
            >
              <Ionicons name="add-circle-outline" size={16} color={palette.primary} />
              <Text variant="body" style={{ color: palette.primary }}>Nouveau client</Text>
            </Pressable>
          </ScrollView>
        </View>
      )}
      {showNewForm && (
        <View style={styles.newClientForm}>
          <Input label="Nom" value={newName} onChangeText={setNewName} placeholder="Nom du client" />
          <Input
            label="Téléphone (optionnel)"
            value={newPhone}
            onChangeText={setNewPhone}
            keyboardType="phone-pad"
            placeholder="Ex: 622 00 00 00"
          />
          <View style={{ flexDirection: 'row', gap: spacing[2] }}>
            <Button label="Annuler" onPress={() => setShowNewForm(false)} variant="outline" style={{ flex: 1 }} />
            <Button label="Ajouter" onPress={handleAddNewClient} style={{ flex: 1 }} disabled={!newName.trim()} />
          </View>
        </View>
      )}
    </View>
  );
}

// ─── Payment modal ────────────────────────────────────────────────────────────

type PayStep = 'pay' | 'credit';
type Disambig = 'rabais' | 'credit' | null;

interface PaymentModalProps {
  visible: boolean;
  initialStep: PayStep;
  total: number;
  currency: string;
  businessId: string;
  sellerId: string;
  isVendeur: boolean;
  onClose: () => void;
  onConfirm: (payment: SalePayment | null, customerName?: string, discountAmount?: number) => void;
  submitting: boolean;
}

function PaymentModal({
  visible, initialStep, total, currency, businessId, sellerId, isVendeur,
  onClose, onConfirm, submitting,
}: PaymentModalProps) {
  const [step, setStep] = useState<PayStep>(initialStep);
  const [payMethod, setPayMethod] = useState<'especes' | 'orange' | 'mtn' | 'digital'>('especes');
  const [amountInput, setAmountInput] = useState('');
  const [disambig, setDisambig] = useState<Disambig>(null);
  const [clientName, setClientName] = useState('');
  const [clientExpanded, setClientExpanded] = useState(false);

  useEffect(() => {
    if (visible) {
      setStep(initialStep);
      setPayMethod('especes');
      setAmountInput(String(total));
      setDisambig(null);
      setClientName('');
      setClientExpanded(false);
    }
  }, [visible, initialStep, total]);

  // When step changes to credit, always show client picker expanded
  useEffect(() => {
    if (step === 'credit') setClientExpanded(true);
  }, [step]);

  // When disambig becomes 'credit' and no client yet, expand picker
  useEffect(() => {
    if (disambig === 'credit' && !clientName) setClientExpanded(true);
  }, [disambig]);

  const parsedAmount = parseFloat(amountInput.replace(/\s/g, '').replace(',', '.')) || 0;
  const shortfall = total - parsedAmount;
  const isShort = shortfall > 0.5;
  const isOver = parsedAmount > total + 0.5;

  const handleAmountChange = (val: string) => {
    setAmountInput(val);
    setDisambig(null);
  };

  const requiresClient = disambig === 'credit';
  const canConfirmPay = !isShort || (disambig !== null && (!requiresClient || clientName.trim().length > 0));
  const canConfirmCredit = clientName.trim().length > 0;

  const handleConfirmPay = () => {
    const discountAmount = disambig === 'rabais' ? shortfall : 0;
    const payment: SalePayment = { method: payMethod, amount: parsedAmount };
    onConfirm(payment, clientName.trim() || undefined, discountAmount);
  };

  const handleConfirmCredit = () => {
    onConfirm(null, clientName.trim());
  };

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="formSheet" onRequestClose={onClose}>
      <SafeAreaView style={styles.modalSafe} edges={['bottom']}>
        {/* Header — always visible at top */}
        <View style={styles.modalHeader}>
          <Pressable onPress={onClose} style={styles.modalCancel}>
            <Text variant="body" color="secondary">Retour</Text>
          </Pressable>
          <Text variant="h4">{step === 'credit' ? 'Vente à crédit' : 'Paiement'}</Text>
          <View style={{ width: 64 }} />
        </View>

        {/* KAV pushes the footer up when keyboard appears; flex:1 fills remaining space */}
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
          style={{ flex: 1 }}
          keyboardVerticalOffset={0}
        >
          {/* Total — full-width so adjustsFontSizeToFit has room to work */}
          <View style={styles.totalSection}>
            <Text variant="caption" color="secondary" style={{ textAlign: 'center' }}>Total</Text>
            <Text
              style={[styles.totalBig, { color: step === 'credit' ? palette.warning : palette.primary, textAlign: 'center' }]}
              adjustsFontSizeToFit
              numberOfLines={1}
            >
              {formatAmount(total, currency)}
            </Text>
          </View>

          {/* Scrollable middle: amount input + disambig + methods (pay step) */}
          {step === 'pay' && (
            <ScrollView style={{ flex: 1 }} contentContainerStyle={styles.payContent} keyboardShouldPersistTaps="handled">
              <View style={{ gap: spacing[2] }}>
                <Text variant="label" style={styles.sectionLabel}>Combien le client a payé ?</Text>
                <TextInput
                  style={styles.amountBigInput}
                  value={amountInput}
                  onChangeText={handleAmountChange}
                  keyboardType="decimal-pad"
                  placeholder={String(total)}
                  placeholderTextColor={palette.textDisabled}
                  selectTextOnFocus
                />

                {isShort && (
                  <View style={styles.disambigBox}>
                    <Text variant="label" style={{ color: colors.warning[700] }}>
                      ⚠️ {formatAmount(shortfall, currency)} de moins que le prix.
                    </Text>
                    <Text variant="label" style={{ marginTop: spacing[3] }}>C'est :</Text>

                    <Pressable onPress={() => setDisambig('rabais')} style={styles.radioRow}>
                      <View style={[styles.radio, disambig === 'rabais' && styles.radioActive]} />
                      <View style={{ flex: 1 }}>
                        <Text variant="label">Un rabais</Text>
                        <Text variant="caption" color="secondary">Le client ne doit plus rien</Text>
                      </View>
                    </Pressable>

                    <Pressable onPress={() => setDisambig('credit')} style={styles.radioRow}>
                      <View style={[styles.radio, disambig === 'credit' && styles.radioActive]} />
                      <View style={{ flex: 1 }}>
                        <Text variant="label">Un crédit</Text>
                        <Text variant="caption" color="secondary">
                          Le client paiera {formatAmount(shortfall, currency)} plus tard
                        </Text>
                      </View>
                    </Pressable>
                  </View>
                )}

                {isOver && (
                  <View style={styles.warnRow}>
                    <Text variant="caption" style={{ color: colors.warning[700] }}>
                      Le montant dépasse le prix de vente. Vérifie.
                    </Text>
                  </View>
                )}
              </View>

              {/* Payment method grid — inside scroll so all 4 chips are always reachable */}
              <View style={styles.methodSection}>
                <Text variant="label" style={[styles.sectionLabel, { marginBottom: spacing[2] }]}>Payé en</Text>
                <View style={styles.methodGrid}>
                  {PAY_NOW_METHODS.map(m => (
                    <Pressable
                      key={m.key}
                      onPress={() => setPayMethod(m.key)}
                      style={[styles.methodChip, payMethod === m.key && styles.methodChipActive]}
                    >
                      <Text
                        variant="label"
                        style={{
                          color: payMethod === m.key ? palette.textInverse : palette.textSecondary,
                          textAlign: 'center', fontSize: 13,
                          opacity: payMethod === m.key ? 1 : 0.45,
                        }}
                      >
                        {m.label}
                      </Text>
                    </Pressable>
                  ))}
                </View>
              </View>
            </ScrollView>
          )}

          {/* Client picker — fixed above confirm button, outside scroll so dropdown zIndex works */}
          <View style={styles.clientSection}>
            <InlineClientPicker
              businessId={businessId}
              sellerId={sellerId}
              isVendeur={isVendeur}
              value={clientName}
              onChange={setClientName}
              required={step === 'credit' || disambig === 'credit'}
              expanded={clientExpanded}
              onExpandChange={setClientExpanded}
            />
          </View>

          {/* Confirm button — pinned to bottom */}
          <View style={styles.modalFooter}>
            <Button
              label={submitting ? 'Enregistrement…' : (step === 'credit' ? 'Enregistrer le crédit' : 'Confirmer la vente')}
              onPress={step === 'credit' ? handleConfirmCredit : handleConfirmPay}
              loading={submitting}
              fullWidth
              size="lg"
              disabled={step === 'credit' ? !canConfirmCredit : !canConfirmPay}
            />
          </View>
        </KeyboardAvoidingView>
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
  const { cart, submitting, error: saleError, addToCart, removeFromCart, setQty, toggleBulk, clearCart, submitSale, clearError } =
    useSalesStore();

  const [search, setSearch] = useState('');
  const [showPayment, setShowPayment] = useState(false);
  const [payStep, setPayStep] = useState<PayStep>('pay');
  const [successMsg, setSuccessMsg] = useState('');

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

  const openPay = () => { setPayStep('pay'); setShowPayment(true); };
  const openCredit = () => { setPayStep('credit'); setShowPayment(true); };

  const handleConfirmPayment = useCallback(
    async (payment: SalePayment | null, customerName?: string, discountAmount?: number) => {
      const total = cartTotal;
      const isCredit = payment === null;
      const ok = await submitSale(businessId, userId, payment, customerName, undefined, discountAmount);
      if (ok) {
        setShowPayment(false);
        setSearch('');
        const queued = useSalesStore.getState().lastSubmitQueued;
        if (!queued) fetchProducts(businessId, userId);
        const msg = queued
          ? 'Vente enregistrée hors ligne  ⏳'
          : isCredit
          ? 'Crédit enregistré ✓'
          : `Vente enregistrée ✓  ${formatAmount(total, currency)}`;
        setSuccessMsg(msg);
        setTimeout(() => setSuccessMsg(''), queued ? 4000 : 2500);
      }
    },
    [businessId, userId, cartTotal, currency, submitSale, fetchProducts],
  );

  if (loading && products.length === 0) {
    return (
      <SafeAreaView style={styles.safe} edges={['top']}>
        <View style={styles.emptyFull}>
          <Text variant="body" color="secondary">Chargement…</Text>
        </View>
      </SafeAreaView>
    );
  }

  if (products.length === 0) {
    return (
      <SafeAreaView style={styles.safe} edges={['top']}>
        <View style={styles.emptyFull}>
          <Ionicons name="receipt-outline" size={48} color={palette.textDisabled} />
          <Text variant="h4">Point de vente</Text>
          {isVendeur ? (
            <Text variant="body" color="secondary" style={styles.emptyDesc}>
              Aucun produit disponible pour l'instant.{'\n\n'}Vous avez été ajouté comme vendeur. Un administrateur ou manager doit d'abord ajouter des produits avant que vous puissiez vendre.
            </Text>
          ) : (
            <Text variant="body" color="secondary" style={styles.emptyDesc}>
              Ajoutez des produits dans votre catalogue pour commencer à enregistrer des ventes.
            </Text>
          )}
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      {/* Success banner */}
      {successMsg ? (
        <View style={styles.successBanner}>
          <Text variant="label" style={{ color: '#fff' }}>{successMsg}</Text>
        </View>
      ) : null}

      {/* Error banner */}
      {saleError ? (
        <Pressable onPress={clearError} style={styles.errorBanner}>
          <Text variant="label" style={{ color: '#fff' }}>{saleError}</Text>
          <Text variant="caption" style={{ color: '#ffffff99' }}>Appuyer pour fermer</Text>
        </Pressable>
      ) : null}

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
            onAdd={() => { haptics.tap(); Keyboard.dismiss(); addToCart(item, false); }}
            onAddBulk={() => { haptics.tap(); Keyboard.dismiss(); addToCart(item, true); }}
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
                onSetQty={(qty) => setQty(line.product.id, qty, line.is_bulk)}
              />
            ))}
          </ScrollView>
          <View style={styles.cartFooter}>
            <View style={{ flexShrink: 1, minWidth: 0 }}>
              <Text variant="caption" color="secondary">
                {cartCount} article{cartCount > 1 ? 's' : ''}
              </Text>
              <Text
                variant="amountLarge"
                adjustsFontSizeToFit
                numberOfLines={1}
              >
                {formatAmount(cartTotal, currency)}
              </Text>
            </View>
            <View style={styles.cartActions}>
              <Button
                label="Encaisser maintenant"
                onPress={openPay}
                size="lg"
                fullWidth
              />
              <Pressable onPress={openCredit} style={styles.creditLink}>
                <Text variant="caption" style={{ color: palette.primary }}>ou enregistrer à crédit</Text>
              </Pressable>
            </View>
          </View>
        </View>
      )}

      <PaymentModal
        visible={showPayment}
        initialStep={payStep}
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
  successBanner: {
    backgroundColor: palette.success, paddingHorizontal: spacing[5], paddingVertical: spacing[3],
    alignItems: 'center',
  },
  errorBanner: {
    backgroundColor: palette.danger, paddingHorizontal: spacing[5], paddingVertical: spacing[3],
    alignItems: 'center', gap: 2,
  },
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
    maxHeight: 300, shadowColor: '#0F172A', shadowOffset: { width: 0, height: -4 },
    shadowOpacity: 0.1, shadowRadius: 12, elevation: 10,
  },
  cartScroll: { maxHeight: 160 },
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
  qtyNumPress: { minWidth: 28, alignItems: 'center', paddingHorizontal: 2 },
  qtyNum: { width: 28, textAlign: 'center' },
  qtyInput: {
    width: 44, textAlign: 'center', fontWeight: '600', fontSize: 15,
    color: palette.textPrimary, paddingVertical: 2,
    borderBottomWidth: 1.5, borderBottomColor: palette.primary,
  },
  cartFooter: {
    flexDirection: 'row', alignItems: 'center', padding: spacing[4],
    borderTopWidth: 1, borderTopColor: palette.border, gap: spacing[3],
  },
  cartActions: { flex: 1, gap: 0 },
  creditLink: { alignItems: 'center', paddingTop: spacing[2] },

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
  modalFooter: {
    padding: spacing[5], borderTopWidth: 1, borderTopColor: palette.border, backgroundColor: palette.surface,
  },

  // Total — sits outside scroll so it has full width for adjustsFontSizeToFit
  totalSection: {
    paddingHorizontal: spacing[5], paddingTop: spacing[5], paddingBottom: spacing[5],
    borderBottomWidth: 1, borderBottomColor: palette.border, gap: spacing[1],
  },
  totalBig: { fontSize: 36, lineHeight: 50, fontWeight: '700', letterSpacing: -0.5 },

  // Pay step scrollable content
  payContent: { padding: spacing[5], gap: spacing[4] },

  // Client picker — fixed layer between scroll and method grid
  clientSection: {
    paddingHorizontal: spacing[5], paddingVertical: spacing[3],
    borderTopWidth: 1, borderTopColor: palette.border,
    zIndex: 50, elevation: 50,
  },

  // Method grid — outside scroll, always below client section
  methodSection: {
    paddingHorizontal: spacing[5], paddingTop: spacing[3], paddingBottom: spacing[4], gap: spacing[2],
  },

  sectionLabel: { marginBottom: spacing[2] },
  methodGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing[3] },
  methodChip: {
    flex: 1, alignItems: 'center', justifyContent: 'center',
    paddingVertical: spacing[4], paddingHorizontal: spacing[2],
    borderRadius: radius.md, borderWidth: 1.5, borderColor: palette.border,
    backgroundColor: palette.surface, minWidth: '45%',
  },
  methodChipActive: { backgroundColor: palette.primary, borderColor: palette.primary },

  // Amount input
  amountBigInput: {
    fontSize: 28, fontWeight: '700', color: palette.textPrimary,
    borderBottomWidth: 2, borderBottomColor: palette.primary,
    paddingVertical: spacing[2], textAlign: 'center',
  },

  // Shortfall disambiguation
  disambigBox: {
    backgroundColor: colors.warning[50], borderRadius: radius.md,
    borderWidth: 1, borderColor: colors.warning[100],
    padding: spacing[4], gap: spacing[2],
  },
  radioRow: {
    flexDirection: 'row', alignItems: 'flex-start', gap: spacing[3],
    paddingVertical: spacing[2],
  },
  radio: {
    width: 20, height: 20, borderRadius: 10, borderWidth: 2,
    borderColor: palette.border, marginTop: 2,
  },
  radioActive: { borderColor: palette.primary, backgroundColor: palette.primary },
  warnRow: {
    backgroundColor: colors.warning[50], borderRadius: radius.md,
    padding: spacing[3], borderWidth: 1, borderColor: colors.warning[100],
  },

  // Client picker
  clientSelectedRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingVertical: spacing[2],
  },
  attachLink: {
    paddingVertical: spacing[3], alignItems: 'center',
  },
  clientInput: {
    paddingHorizontal: spacing[4], paddingVertical: spacing[3],
    borderRadius: radius.md, borderWidth: 1, borderColor: palette.border,
    backgroundColor: palette.surface, color: palette.textPrimary, fontSize: 16,
  },
  suggestionList: {
    position: 'absolute',
    top: 50,
    left: 0,
    right: 0,
    backgroundColor: palette.surface, borderWidth: 1, borderColor: palette.border,
    borderRadius: radius.md, overflow: 'hidden',
    zIndex: 100,
    elevation: 100,
    shadowColor: '#0F172A',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.12,
    shadowRadius: 8,
  },
  suggestionRow: {
    paddingHorizontal: spacing[4], paddingVertical: spacing[3],
    borderBottomWidth: 1, borderBottomColor: palette.border,
  },
  newClientForm: {
    backgroundColor: palette.surface, borderRadius: radius.md,
    borderWidth: 1, borderColor: palette.border,
    padding: spacing[4], gap: spacing[3], marginTop: spacing[2],
  },
});
