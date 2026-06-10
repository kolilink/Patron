import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { router } from 'expo-router';
import {
  Alert,
  Animated,
  Easing,
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
import { captureRef } from 'react-native-view-shot';
import * as Sharing from 'expo-sharing';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { Button } from '@/src/components/ui/Button';
import { Card } from '@/src/components/ui/Card';
import { Input } from '@/src/components/ui/Input';
import { Text } from '@/src/components/ui/Text';
import { PhoneInput } from '@/src/components/ui/PhoneInput';
import { SaleSuccessOverlay } from '@/src/components/ui/SaleSuccessOverlay';
import { SaleReceiptView, type ReceiptData, type ReceiptItem } from '@/src/components/ui/SaleReceiptView';
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
  onConfirm: (payment: SalePayment | null, customerName?: string, discountAmount?: number, clientId?: string) => void;
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
  const [clientPhone, setClientPhone] = useState('');
  const [clientId, setClientId] = useState<string | undefined>();
  const [showClientSection, setShowClientSection] = useState(false);
  const [clientSearch, setClientSearch] = useState('');
  const [clients, setClients] = useState<{ id?: string; name: string; phone?: string | null }[]>([]);
  const [showNewClientForm, setShowNewClientForm] = useState(false);
  const [newClientName, setNewClientName] = useState('');
  const [newClientPhone, setNewClientPhone] = useState('');
  const clientSearchRef = useRef<TextInput>(null);

  useEffect(() => {
    if (visible) {
      setStep(initialStep);
      setPayMethod('especes');
      setAmountInput(String(total));
      setDisambig(null);
      setClientName('');
      setClientPhone('');
      setClientId(undefined);
      setShowClientSection(false);
      setClientSearch('');
      setShowNewClientForm(false);
      setNewClientName('');
      setNewClientPhone('');
      loadClients();
    }
  }, [visible, initialStep, total]);

  const loadClients = async () => {
    const [clientsRes, salesRes] = await Promise.all([
      supabase.from('clients').select('id, name, phone').eq('business_id', businessId),
      supabase.from('sale_orders').select('customer_name')
        .eq('business_id', businessId).not('customer_name', 'is', null),
    ]);
    const fromClients = (clientsRes.data ?? []).map((r: { id: string; name: string; phone?: string | null }) => ({
      id: r.id, name: r.name, phone: r.phone,
    }));
    const knownNames = new Set(fromClients.map(c => c.name));
    const fromSales = (salesRes.data ?? [])
      .map((r: { customer_name: string }) => r.customer_name?.trim())
      .filter((n): n is string => Boolean(n) && !knownNames.has(n))
      .map(name => ({ name, phone: null }));
    const all = [...fromClients, ...fromSales].sort((a, b) => a.name.localeCompare(b.name));
    const seen = new Set<string>();
    setClients(all.filter(c => { if (seen.has(c.name)) return false; seen.add(c.name); return true; }));
  };

  const filteredClients = useMemo(() => {
    const q = clientSearch.toLowerCase().trim();
    if (!q) return clients;
    return clients.filter(c =>
      c.name.toLowerCase().includes(q) || (c.phone ?? '').includes(q)
    );
  }, [clientSearch, clients]);

  useEffect(() => {
    if (showClientSection && !showNewClientForm) setTimeout(() => clientSearchRef.current?.focus(), 80);
  }, [showClientSection, showNewClientForm]);

  useEffect(() => {
    if (step === 'credit' && visible && !clientName) setShowClientSection(true);
  }, [step]);

  useEffect(() => {
    if (disambig === 'credit' && !clientName) setShowClientSection(true);
  }, [disambig]);

  const handleSelectClient = (name: string, phone?: string | null, id?: string) => {
    setClientName(name);
    setClientPhone(phone ?? '');
    setClientId(id);
    setShowClientSection(false);
    setClientSearch('');
    setShowNewClientForm(false);
    setNewClientName('');
    setNewClientPhone('');
    Keyboard.dismiss();
  };

  const handleAddNewClient = async () => {
    if (!newClientName.trim()) return;
    const name = newClientName.trim();
    const phone = newClientPhone || null;
    const { data } = await supabase.from('clients').upsert(
      { business_id: businessId, name, phone },
      { onConflict: 'business_id,name' },
    ).select('id').single();
    handleSelectClient(name, phone, data?.id ?? undefined);
  };

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
    onConfirm(payment, clientName.trim() || undefined, discountAmount, clientId);
  };

  const handleConfirmCredit = () => {
    onConfirm(null, clientName.trim(), undefined, clientId);
  };

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="formSheet" onRequestClose={onClose}>
      <SafeAreaView style={styles.modalSafe} edges={['bottom']}>

        {/* Header */}
        <View style={styles.modalHeader}>
          <Pressable onPress={onClose} style={styles.modalCancel}>
            <Text variant="body" color="secondary">Retour</Text>
          </Pressable>
          <Text variant="h4">{step === 'credit' ? 'Vente à crédit' : 'Paiement'}</Text>
          <View style={{ width: 64 }} />
        </View>

        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
          style={{ flex: 1 }}
          keyboardVerticalOffset={Platform.OS === 'ios' ? 44 : 0}
        >
          {/* Single scroll for all content — keyboard pushes footer up, scroll handles the rest */}
          <ScrollView
            style={{ flex: 1 }}
            contentContainerStyle={{ paddingBottom: spacing[6] }}
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}
          >
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

          {step === 'pay' && !showClientSection && (
            <View style={styles.payContent}>
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
                        <Text variant="label">Une réduction</Text>
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
                      Le montant dépasse le prix de vente. Vérifiez.
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
            </View>
          )}

          {/* ── Inline client section ── */}
          <View style={styles.clientSection}>
            {clientName ? (
              /* ── Selected tag ── */
              <View style={styles.clientSelectedTag}>
                <Ionicons name="person-circle-outline" size={28} color={palette.primary} />
                <View style={{ flex: 1 }}>
                  <Text variant="caption" color="secondary">Client</Text>
                  <Text variant="label">{clientName}</Text>
                  {clientPhone ? (
                    <Text variant="caption" color="secondary">{clientPhone}</Text>
                  ) : null}
                </View>
                <Pressable
                  onPress={() => { setClientName(''); setClientPhone(''); setClientId(undefined); setClientSearch(''); }}
                  hitSlop={12}
                >
                  <Ionicons name="close-circle" size={20} color={palette.textSecondary} />
                </Pressable>
              </View>

            ) : showClientSection ? (
              /* ── Expanded section ── */
              <View>
                {/* Search bar — hidden while new client form is open */}
                {!showNewClientForm && (
                  <View style={styles.clientSearchRow}>
                    <Ionicons name="search-outline" size={15} color={palette.textSecondary} />
                    <TextInput
                      ref={clientSearchRef}
                      value={clientSearch}
                      onChangeText={setClientSearch}
                      placeholder="Rechercher un client..."
                      placeholderTextColor={palette.textDisabled}
                      style={styles.clientSearchInput}
                      returnKeyType="search"
                      clearButtonMode="while-editing"
                    />
                    <Pressable
                      onPress={() => { setShowClientSection(false); setClientSearch(''); setShowNewClientForm(false); Keyboard.dismiss(); }}
                      hitSlop={8}
                    >
                      <Text variant="caption" style={{ color: palette.textSecondary }}>Annuler</Text>
                    </Pressable>
                  </View>
                )}

                {!showNewClientForm ? (
                  <>
                    {/* Nouveau client — always first */}
                    <Pressable
                      onPress={() => { setShowNewClientForm(true); Keyboard.dismiss(); }}
                      style={({ pressed }) => [styles.clientResultRow, styles.clientResultRowNew, pressed && { opacity: 0.55 }]}
                    >
                      <Ionicons name="add-circle-outline" size={16} color={palette.primary} />
                      <Text variant="body" style={{ color: palette.primary, fontWeight: '600' }}>Nouveau client</Text>
                    </Pressable>

                    {filteredClients.length === 0 && clientSearch.length > 0 ? (
                      <View style={{ paddingVertical: spacing[3], paddingHorizontal: spacing[2] }}>
                        <Text variant="caption" color="secondary">Aucun résultat pour « {clientSearch} »</Text>
                      </View>
                    ) : (
                      filteredClients.map(c => {
                        const AVATAR_COLORS = ['#DAFCE3', '#FDF0DA', '#E0E7FF', '#FEF3C7'];
                        const sum = c.name ? c.name.split('').reduce((acc, ch) => acc + ch.charCodeAt(0), 0) : 0;
                        const avatarBg = AVATAR_COLORS[sum % AVATAR_COLORS.length];
                        const initial = c.name ? c.name.charAt(0).toUpperCase() : '?';
                        return (
                          <Pressable
                            key={c.id ?? c.name}
                            onPress={() => handleSelectClient(c.name, c.phone, c.id)}
                            style={({ pressed }) => [styles.clientResultRow, pressed && { opacity: 0.55 }]}
                          >
                            <View style={[styles.clientAvatar, { backgroundColor: avatarBg }]}>
                              <Text style={styles.clientAvatarText}>{initial}</Text>
                            </View>
                            <View style={{ flex: 1 }}>
                              <Text variant="body">{c.name}</Text>
                              {c.phone ? (
                                <Text variant="caption" color="secondary">{c.phone}</Text>
                              ) : null}
                            </View>
                          </Pressable>
                        );
                      })
                    )}
                  </>
                ) : (
                  /* ── New client form ── */
                  <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing[2], paddingTop: spacing[2], marginBottom: spacing[1] }}>
                      <Pressable onPress={() => setShowNewClientForm(false)} hitSlop={8}>
                        <Ionicons name="arrow-back" size={18} color={palette.textSecondary} />
                      </Pressable>
                      <Text variant="label">Nouveau client</Text>
                    </View>
                    <ScrollView
                      contentContainerStyle={{ paddingHorizontal: 16, paddingTop: 12, paddingBottom: 32 }}
                      showsVerticalScrollIndicator={false}
                      keyboardShouldPersistTaps="handled"
                    >
                      <Input
                        label="Nom"
                        value={newClientName}
                        onChangeText={setNewClientName}
                        placeholder="ex : Mamadou Diallo"
                        autoFocus
                      />
                      <PhoneInput
                        label="Téléphone (optionnel)"
                        onChange={setNewClientPhone}
                        strict={false}
                      />
                    </ScrollView>
                  </KeyboardAvoidingView>
                )}
              </View>

            ) : (
              /* ── Trigger ── */
              <Pressable
                onPress={() => setShowClientSection(true)}
                style={({ pressed }) => [styles.clientTrigger, pressed && { opacity: 0.55 }]}
              >
                <Ionicons name="person-add-outline" size={18} color={palette.textSecondary} />
                <Text variant="body" style={{ color: palette.textSecondary }}>Nom du client</Text>
              </Pressable>
            )}
          </View>
          </ScrollView>

          {/* Footer — morphs based on state, always above keyboard */}
          <View style={styles.modalFooter}>
            {showNewClientForm ? (
              <Button
                label="Ajouter ce client"
                onPress={handleAddNewClient}
                fullWidth
                size="lg"
                disabled={!newClientName.trim()}
              />
            ) : (
              <Button
                label={submitting ? 'Enregistrement…' : (step === 'credit' ? 'Enregistrer le crédit' : 'Confirmer la vente')}
                onPress={step === 'credit' ? handleConfirmCredit : handleConfirmPay}
                loading={submitting}
                fullWidth
                size="lg"
                disabled={step === 'credit' ? !canConfirmCredit : !canConfirmPay}
              />
            )}
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
        {outOfStock ? 'Ce produit est fini' : `${product.stock_qty} ${product.unit}`}
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

// ─── Animated FAB ─────────────────────────────────────────────────────────────

function AnimatedFAB({ onPress }: { onPress: () => void }) {
  const scale   = useRef(new Animated.Value(1)).current;
  const opacity = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    const easing = Easing.inOut(Easing.sin);
    const loop = Animated.loop(
      Animated.sequence([
        Animated.parallel([
          Animated.timing(scale,   { toValue: 1.06, duration: 2000, easing, useNativeDriver: true }),
          Animated.timing(opacity, { toValue: 0.85, duration: 2000, easing, useNativeDriver: true }),
        ]),
        Animated.parallel([
          Animated.timing(scale,   { toValue: 1,    duration: 2000, easing, useNativeDriver: true }),
          Animated.timing(opacity, { toValue: 1,    duration: 2000, easing, useNativeDriver: true }),
        ]),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, []);

  return (
    <Animated.View style={[styles.fabContainer, { transform: [{ scale }], opacity }]}>
      <Pressable
        onPress={onPress}
        style={({ pressed }) => [styles.fab, pressed && { opacity: 0.82 }]}
        accessibilityLabel="Ajouter un produit"
        accessibilityRole="button"
      >
        <Text style={styles.fabIcon}>+</Text>
      </Pressable>
    </Animated.View>
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
  const [offlineMsg, setOfflineMsg] = useState('');
  const [showConfirmSheet, setShowConfirmSheet] = useState(false);
  const [lastReceipt, setLastReceipt] = useState<ReceiptData | null>(null);
  const currencyConfirmedRef = useRef(false);
  const receiptViewRef = useRef<View>(null);
  const pendingReceiptRef = useRef<ReceiptData | null>(null);

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
    async (payment: SalePayment | null, customerName?: string, discountAmount?: number, clientId?: string) => {
      const total = cartTotal;
      const isCredit = payment === null;

      // Before the very first sale, confirm the currency lock
      if (!currencyConfirmedRef.current) {
        const { count } = await supabase
          .from('sale_orders')
          .select('id', { count: 'exact', head: true })
          .eq('business_id', businessId);

        if ((count ?? 1) === 0) {
          const confirmed = await new Promise<boolean>(resolve =>
            Alert.alert(
              `Confirmer votre monnaie :)`,
              `Ceci sera votre monnaie officielle — ${currency} :)`,
              [
                { text: 'Annuler', style: 'cancel', onPress: () => resolve(false) },
                { text: `Continuer en ${currency}`, onPress: () => resolve(true) },
              ],
            ),
          );
          if (!confirmed) return;
        }
        currencyConfirmedRef.current = true;
      }

      // Snapshot cart before submitSale clears it
      const receiptItems: ReceiptItem[] = cart.map(l => ({
        name: l.product.name,
        qty: l.qty,
        unit_price: l.unit_price,
        is_bulk: l.is_bulk,
      }));
      pendingReceiptRef.current = {
        businessName: business?.name ?? '',
        currency,
        items: receiptItems,
        total: cartTotal,
        payment: payment ?? null,
        customerName,
        date: new Date(),
      };

      const ok = await submitSale(businessId, userId, payment, customerName, undefined, discountAmount, clientId);
      if (ok) {
        setLastReceipt(pendingReceiptRef.current);
        setShowPayment(false);
        setSearch('');
        const queued = useSalesStore.getState().lastSubmitQueued;
        if (!queued) {
          fetchProducts(businessId, userId);
          setShowConfirmSheet(true);
        } else {
          setOfflineMsg('Vente enregistrée hors ligne ⏳');
          setTimeout(() => setOfflineMsg(''), 4000);
        }
      }
    },
    [businessId, userId, cartTotal, currency, submitSale, fetchProducts],
  );

  const handleShareReceipt = async () => {
    if (!receiptViewRef.current || !lastReceipt) return;
    try {
      const uri = await captureRef(receiptViewRef, { format: 'png', quality: 1 });
      setShowConfirmSheet(false);
      // Wait for modal close animation before presenting the share sheet
      await new Promise<void>(r => setTimeout(r, 350));
      await Sharing.shareAsync(uri, { mimeType: 'image/png', UTI: 'public.png', dialogTitle: 'Partager le reçu' });
    } catch {
      Alert.alert('Impossible de partager le reçu pour l\'instant.');
    }
  };

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
          <Text variant="body" color="secondary" style={styles.emptyDesc}>
            {isVendeur
              ? 'Le catalogue est vide pour l\'instant — votre responsable prépare les produits.'
              : 'Ajoutez votre premier produit au catalogue pour commencer à vendre.'}
          </Text>
        </View>
        {!isVendeur && (
          <AnimatedFAB onPress={() => router.push({ pathname: '/(app)/(tabs)/catalogue', params: { openForm: '1' } })} />
        )}
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
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
            onAdd={() => { setLastReceipt(null); haptics.tap(); Keyboard.dismiss(); addToCart(item, false); }}
            onAddBulk={() => { setLastReceipt(null); haptics.tap(); Keyboard.dismiss(); addToCart(item, true); }}
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

      {/* Confirm + share sheet — slides up immediately after each online sale */}
      <Modal
        visible={showConfirmSheet}
        transparent
        animationType="slide"
        onRequestClose={() => setShowConfirmSheet(false)}
      >
        <View style={styles.sheetOverlay}>
          {/* Receipt at (0,0) — within modal bounds so GPU composites it; captureRef reads it directly */}
          {lastReceipt && (
            <View
              ref={receiptViewRef}
              collapsable={false}
              pointerEvents="none"
              style={{ position: 'absolute', top: 0, left: 0 }}
            >
              <SaleReceiptView data={lastReceipt} />
            </View>
          )}
          {/* Solid white layer hides the receipt from the user */}
          <View style={[StyleSheet.absoluteFill, { backgroundColor: '#fff' }]} pointerEvents="none" />
          {/* Semi-transparent dark overlay + dismiss tap — renders on top of white */}
          <Pressable style={[StyleSheet.absoluteFill, { backgroundColor: 'rgba(0,0,0,0.45)' }]} onPress={() => setShowConfirmSheet(false)} />

          <View style={styles.sheet}>
            <View style={styles.sheetHead}>
              <View style={styles.sheetCheckCircle}>
                <View style={styles.sheetCheckmark} />
              </View>
              <Text variant="h3" style={{ textAlign: 'center' }}>
                {lastReceipt?.payment === null ? 'Crédit enregistré' : 'Vente enregistrée'}
              </Text>
              {lastReceipt && (
                <Text variant="h4" style={{ color: palette.primary, textAlign: 'center' }}>
                  {formatAmount(lastReceipt.total, lastReceipt.currency)}
                </Text>
              )}
            </View>

            <View style={styles.sheetDivider} />

            <View style={styles.sheetFoot}>
              <View style={styles.shareCtaBox}>
                <Ionicons name="shield-checkmark-outline" size={20} color={palette.primary} />
                <View style={{ flex: 1, gap: 3 }}>
                  <Text variant="label">Partagez le reçu</Text>
                  <Text variant="bodySmall" color="secondary">
                    {lastReceipt?.payment === null
                      ? 'Envoyez la preuve du crédit — évitez les disputes plus tard.'
                      : 'Ça donne plus confiance au client 🤗'}
                  </Text>
                </View>
              </View>
              <Button label="Partager le reçu" onPress={handleShareReceipt} fullWidth size="lg" />
              <Pressable onPress={() => setShowConfirmSheet(false)} style={styles.ignorePressable}>
                <Text variant="caption" color="secondary">Ignorer</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>

      {/* Offline-only fallback overlay */}
      <SaleSuccessOverlay visible={!!offlineMsg} message={offlineMsg} />
    </SafeAreaView>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const TILE_GAP = spacing[3];

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: palette.background },
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
    position: 'absolute', top: 8, right: 8, backgroundColor: palette.primary,
    borderRadius: radius.full, width: 22, height: 22, alignItems: 'center', justifyContent: 'center', zIndex: 10,
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
  sheetOverlay: {
    flex: 1, justifyContent: 'flex-end',
  },
  sheet: {
    backgroundColor: palette.surface,
    borderTopLeftRadius: 24, borderTopRightRadius: 24,
    overflow: 'hidden',
  },
  sheetHead: {
    paddingHorizontal: spacing[6], paddingTop: spacing[6], paddingBottom: spacing[4],
    gap: spacing[3], alignItems: 'center',
  },
  sheetCheckCircle: {
    width: 64, height: 64, borderRadius: 32,
    backgroundColor: '#22c55e',
    justifyContent: 'center', alignItems: 'center',
  },
  sheetCheckmark: {
    width: 22, height: 13,
    borderLeftWidth: 3, borderBottomWidth: 3,
    borderColor: '#fff', borderRadius: 1,
    transform: [{ rotate: '-45deg' }], marginTop: -3,
  },
  sheetDivider: {
    height: 1, backgroundColor: palette.border,
  },
  sheetFoot: {
    paddingHorizontal: spacing[6], paddingTop: spacing[4], paddingBottom: spacing[10],
    gap: spacing[4], alignItems: 'center',
  },
  shareCtaBox: {
    flexDirection: 'row', alignItems: 'flex-start',
    gap: spacing[3], alignSelf: 'stretch',
    backgroundColor: palette.primaryLight,
    borderRadius: 12, padding: spacing[4],
  },
  ignorePressable: {
    paddingVertical: spacing[2],
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
  fabContainer: { position: 'absolute', bottom: 194, right: spacing[4], zIndex: 10 },
  fab: { width: 56, height: 56, borderRadius: radius.full, backgroundColor: palette.primary, alignItems: 'center', justifyContent: 'center', shadowColor: colors.neutral[900], shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.18, shadowRadius: 8, elevation: 8 },
  fabIcon: { fontSize: 28, lineHeight: 32, fontWeight: '300' as const, color: palette.textInverse, marginTop: -2 },
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

  // Inline client section
  clientSection: {
    paddingHorizontal: spacing[5],
    paddingTop: spacing[3],
    paddingBottom: spacing[2],
    borderTopWidth: 1,
    borderTopColor: palette.border,
  },
  clientTrigger: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing[2],
    paddingVertical: spacing[3],
  },
  clientResultRowNew: {
    borderBottomWidth: 2,
    borderBottomColor: palette.border,
    marginBottom: 2,
  },
  clientSelectedTag: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[3],
    backgroundColor: `${palette.primary}12`,
    borderRadius: radius.md,
    paddingHorizontal: spacing[4],
    paddingVertical: spacing[3],
    borderWidth: 1,
    borderColor: `${palette.primary}30`,
  },
  clientSearchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[2],
    paddingHorizontal: spacing[3],
    paddingVertical: spacing[2],
    borderWidth: 1,
    borderColor: palette.border,
    borderRadius: radius.md,
    backgroundColor: palette.surface,
    marginBottom: spacing[1],
  },
  clientSearchInput: {
    flex: 1,
    fontSize: 15,
    color: palette.textPrimary,
    paddingVertical: 0,
  },
  clientResultRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[3],
    paddingVertical: spacing[3],
    paddingHorizontal: spacing[1],
    borderBottomWidth: 1,
    borderBottomColor: palette.border,
  },
  clientAvatar: {
    width: 36,
    height: 36,
    borderRadius: 18,
    justifyContent: 'center',
    alignItems: 'center',
  },
  clientAvatarText: {
    fontSize: 16,
    fontWeight: '700',
    color: '#111827',
  },

  // Method grid — outside scroll, always below client card
  methodSection: {
    paddingHorizontal: spacing[5], paddingTop: spacing[3], paddingBottom: spacing[4], gap: spacing[2],
  },

  sectionLabel: { marginBottom: spacing[2] },
  methodGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing[3] },
  methodChip: {
    flex: 1, alignItems: 'center', justifyContent: 'center',
    paddingVertical: spacing[3], paddingHorizontal: spacing[2],
    minHeight: 56,
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

});
