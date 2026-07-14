import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { router, useFocusEffect } from 'expo-router';
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
import { Screen } from '@/src/components/ui/Screen';
import { Ionicons } from '@expo/vector-icons';
import { Button } from '@/src/components/ui/Button';
import { Card } from '@/src/components/ui/Card';
import { Input } from '@/src/components/ui/Input';
import { Text } from '@/src/components/ui/Text';
import { PhoneInput } from '@/src/components/ui/PhoneInput';
import { SaleReceiptView, type ReceiptData, type ReceiptItem } from '@/src/components/ui/SaleReceiptView';
import { DatePickerField } from '@/src/components/ui/DatePickerField';
import { useTheme, radius, spacing, CLIENT_AVATAR_PALETTE } from '@/src/theme';
import type { Palette } from '@/src/theme';
import { formatAmount, formatAmountInput, parseAmountInput } from '@/src/utils/format';
import { todayIso } from '@/src/utils/dates';
import type { Product, ProductVariant } from '@/src/types';
import { useAuthStore } from '@/stores/auth';
import { useProductStore } from '@/stores/products';
import type { CartLine, SalePayment } from '@/stores/sales';
import { useSalesStore } from '@/stores/sales';
import { supabase } from '@/lib/supabase';
import { haptics } from '@/lib/haptics';
import { SkeletonList } from '@/src/components/ui/SkeletonPlaceholder';
import { trackEvent } from '@/lib/analytics';

function useCountUp(target: number, duration = 150): number {
  const [display, setDisplay] = useState(target);
  const displayRef = useRef(target);

  useEffect(() => {
    if (displayRef.current === target) return;
    const from = displayRef.current;
    const start = Date.now();
    let rafId: number;
    const tick = () => {
      const t = Math.min((Date.now() - start) / duration, 1);
      const eased = 1 - (1 - t) * (1 - t);
      const val = Math.round(from + (target - from) * eased);
      displayRef.current = val;
      setDisplay(val);
      if (t < 1) rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, [target]);

  return display;
}

function toISO(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function fmtDue(iso: string): string {
  const d = new Date(iso + 'T00:00:00');
  const diff = Math.round((d.getTime() - Date.now()) / 86400000);
  if (diff < 0) return `En retard de ${Math.abs(diff)} j`;
  if (diff === 0) return "Prévu aujourd'hui";
  return `Prévu le ${d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'long' })}`;
}

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
  onEditStart?: () => void;
  onLayout?: (e: import('react-native').LayoutChangeEvent) => void;
}

function CartRow({ line, currency, onInc, onDec, onRemove, onToggleBulk, onSetQty, onEditStart, onLayout }: CartRowProps) {
  const { palette } = useTheme();
  const styles = useMemo(() => makeStyles(palette), [palette]);
  const hasBulk = !!(line.product.bulk_price && line.product.bulk_min_qty);
  const [editing, setEditing] = useState(false);
  const [inputVal, setInputVal] = useState('');
  const inputRef = useRef<TextInput>(null);

  const startEdit = () => {
    setInputVal(String(line.qty));
    setEditing(true);
    onEditStart?.();
    setTimeout(() => inputRef.current?.focus(), 30);
  };

  const commitEdit = () => {
    const n = parseInt(inputVal, 10);
    if (!isNaN(n) && n > 0) onSetQty(Math.min(n, line.variant_id ? (line.variant_stock_qty ?? Infinity) : line.product.stock_qty));
    setEditing(false);
  };

  return (
    <View style={styles.cartRow} onLayout={onLayout}>
      <View style={{ flex: 1 }}>
        <Text variant="label" numberOfLines={1}>{line.product.name}{line.variant_name ? ` · ${line.variant_name}` : ''}</Text>
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
        <Pressable onPress={() => { haptics.selection(); onDec(); }} style={styles.qtyBtn}>
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
        {(() => {
          const atMax = line.qty >= (line.variant_id ? (line.variant_stock_qty ?? Infinity) : line.product.stock_qty);
          return (
            <Pressable
              onPress={() => { if (atMax) return; haptics.selection(); onInc(); }}
              style={[styles.qtyBtn, atMax && { opacity: 0.3 }]}
            >
              <Text variant="label" style={{ color: atMax ? palette.textDisabled : palette.primary }}>+</Text>
            </Pressable>
          );
        })()}
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
  onConfirm: (payment: SalePayment | null, customerName?: string, discountAmount?: number, clientId?: string, dueDate?: string | null) => void;
  submitting: boolean;
}

function PaymentModal({
  visible, initialStep, total, currency, businessId, sellerId, isVendeur,
  onClose, onConfirm, submitting,
}: PaymentModalProps) {
  const { palette } = useTheme();
  const styles = useMemo(() => makeStyles(palette), [palette]);
  const [step, setStep] = useState<PayStep>(initialStep);
  const [payMethod, setPayMethod] = useState<'especes' | 'orange' | 'mtn' | 'digital'>('especes');
  const [amountInput, setAmountInput] = useState('');
  // Defaults to 'rabais' rather than undecided — a short payment is most
  // often just a discount given at the register, not an actual credit sale.
  // The seller still sees both options and can switch to 'credit' in one tap.
  const [disambig, setDisambig] = useState<Disambig>('rabais');
  const [creditDiscountInput, setCreditDiscountInput] = useState('');
  const [creditUpfrontInput, setCreditUpfrontInput] = useState('');
  const [creditPayMethod, setCreditPayMethod] = useState<'especes' | 'orange' | 'mtn' | 'digital'>('especes');
  const [clientName, setClientName] = useState('');
  const [clientPhone, setClientPhone] = useState('');
  const [clientId, setClientId] = useState<string | undefined>();
  const [showClientSection, setShowClientSection] = useState(false);
  const [clientSearch, setClientSearch] = useState('');
  const [clients, setClients] = useState<{ id?: string; name: string; phone?: string | null }[]>([]);
  const [showNewClientForm, setShowNewClientForm] = useState(false);
  const [newClientName, setNewClientName] = useState('');
  const [newClientPhone, setNewClientPhone] = useState('');
  const [dueDatePill, setDueDatePill] = useState<'1w' | '1m' | 'custom' | null>(null);
  const [customDueDateInput, setCustomDueDateInput] = useState('');
  const clientSearchRef = useRef<TextInput>(null);
  const modalScrollRef = useRef<ScrollView>(null);
  // Clients are only needed once the user opens the client section (credit
  // sales or "Nom du client") — most sales are plain cash and never touch it,
  // so fetching them unconditionally on every modal open wastes two Supabase
  // round trips on the hottest screen in the app.
  const clientsLoadedRef = useRef(false);

  useEffect(() => {
    if (visible) {
      setStep(initialStep);
      setPayMethod('especes');
      setAmountInput(formatAmountInput(String(Math.round(total)), currency));
      setDisambig('rabais');
      setCreditDiscountInput('');
      setCreditUpfrontInput('');
      setCreditPayMethod('especes');
      setClientName('');
      setClientPhone('');
      setClientId(undefined);
      setShowClientSection(false);
      setClientSearch('');
      setShowNewClientForm(false);
      setNewClientName('');
      setNewClientPhone('');
      setDueDatePill(null);
      setCustomDueDateInput('');
      clientsLoadedRef.current = false;
    }
  }, [visible, initialStep, total]);

  const loadClients = async () => {
    const [clientsRes, salesRes] = await Promise.all([
      supabase.from('clients').select('id, name, phone').eq('business_id', businessId),
      (() => {
        let q = supabase.from('sale_orders').select('customer_name')
          .eq('business_id', businessId).not('customer_name', 'is', null);
        if (isVendeur) q = q.eq('seller_id', sellerId);
        return q;
      })(),
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
    if (showClientSection && !clientsLoadedRef.current) {
      clientsLoadedRef.current = true;
      loadClients();
    }
  }, [showClientSection]);

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
    setTimeout(() => modalScrollRef.current?.scrollTo({ y: 0, animated: true }), 100);
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

  const parsedAmount = parseAmountInput(amountInput, currency);
  const shortfall = total - parsedAmount;
  const isShort = shortfall > 0.5;

  const creditDiscount = parseAmountInput(creditDiscountInput, currency);
  const creditUpfront  = parseAmountInput(creditUpfrontInput, currency);
  const creditEffectiveTotal = total - creditDiscount;
  const creditUpfrontCoversAll = creditUpfront >= creditEffectiveTotal - 0.01 && creditUpfront > 0;

  const computedDueDate: string | null = (() => {
    if (dueDatePill === '1w') { const d = new Date(); d.setDate(d.getDate() + 7); return toISO(d); }
    if (dueDatePill === '1m') { const d = new Date(); d.setMonth(d.getMonth() + 1); return toISO(d); }
    if (dueDatePill === 'custom') return customDueDateInput || null;
    return null;
  })();

  const handleAmountChange = (val: string) => {
    setAmountInput(formatAmountInput(val, currency));
    setDisambig('rabais');
  };

  const requiresClient = disambig === 'credit';
  const canConfirmPay = !isShort || (disambig !== null && (!requiresClient || clientName.trim().length > 0));
  const canConfirmCredit = creditUpfrontCoversAll || clientName.trim().length > 0;

  const handleConfirmPay = () => {
    const discountAmount = disambig === 'rabais' ? shortfall : 0;
    const payment: SalePayment = { method: payMethod, amount: parsedAmount };
    onConfirm(payment, clientName.trim() || undefined, discountAmount, clientId);
  };

  const handleConfirmCredit = () => {
    const disc = creditDiscount > 0 ? creditDiscount : undefined;
    const dueDate = creditUpfrontCoversAll ? null : computedDueDate;
    if (creditUpfront > 0) {
      const payment: SalePayment = { method: creditPayMethod, amount: creditUpfront };
      onConfirm(payment, clientName.trim() || undefined, disc, clientId, dueDate);
    } else {
      onConfirm(null, clientName.trim() || undefined, disc, clientId, dueDate);
    }
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
            ref={modalScrollRef}
            style={{ flex: 1 }}
            contentContainerStyle={{ paddingBottom: spacing[6] }}
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}
          >
          <View style={styles.totalSection}>
            <Text variant="caption" color="secondary" style={{ textAlign: 'center' }}>
              {step === 'credit' && (creditDiscount > 0 || creditUpfront > 0) ? 'Reste à payer' : 'Total'}
            </Text>
            <Text
              style={[styles.totalBig, { color: step === 'credit' ? palette.warning : palette.primary, textAlign: 'center' }]}
              adjustsFontSizeToFit
              numberOfLines={1}
            >
              {formatAmount(step === 'credit' ? Math.max(0, creditEffectiveTotal - creditUpfront) : total, currency)}
            </Text>
            {step === 'credit' && creditDiscount > 0 && (
              <Text variant="caption" color="secondary" style={{ textAlign: 'center' }}>
                Réduction de {formatAmount(creditDiscount, currency)} appliquée
              </Text>
            )}
          </View>

          {step === 'credit' && !showClientSection && (
            <View style={styles.payContent}>
              {/* Discount */}
              <View style={{ gap: spacing[2] }}>
                <Text variant="label" style={styles.sectionLabel}>Réduction</Text>
                <TextInput
                  style={styles.amountBigInput}
                  value={creditDiscountInput}
                  onChangeText={v => setCreditDiscountInput(formatAmountInput(v, currency))}
                  keyboardType="decimal-pad"
                  placeholderTextColor={palette.textDisabled}
                  selectTextOnFocus
                />
              </View>

              {/* Upfront payment */}
              <View style={{ gap: spacing[2] }}>
                <Text variant="label" style={styles.sectionLabel}>Payé maintenant</Text>
                <TextInput
                  style={styles.amountBigInput}
                  value={creditUpfrontInput}
                  onChangeText={v => setCreditUpfrontInput(formatAmountInput(v, currency))}
                  keyboardType="decimal-pad"
                  placeholderTextColor={palette.textDisabled}
                  selectTextOnFocus
                />
              </View>

              {/* Show remaining only when upfront > 0 */}
              {creditUpfront > 0 && !creditUpfrontCoversAll && (
                <View style={[styles.disambigBox, { backgroundColor: palette.warningLight, borderColor: palette.warning }]}>
                  <Text variant="label" style={{ color: palette.warning }}>
                    Reste à payer : {formatAmount(Math.max(0, creditEffectiveTotal - creditUpfront), currency)}
                  </Text>
                </View>
              )}

              {creditUpfrontCoversAll && (
                <View style={styles.warnRow}>
                  <Text variant="caption" style={{ color: palette.warning }}>
                    Payé en entier — pas de crédit.
                  </Text>
                </View>
              )}

              {/* Payment method — only when upfront entered */}
              {creditUpfront > 0 && (
                <View style={styles.methodSection}>
                  <Text variant="label" style={[styles.sectionLabel, { marginBottom: spacing[2] }]}>Payé en</Text>
                  <View style={styles.methodGrid}>
                    {PAY_NOW_METHODS.map(m => (
                      <Pressable key={m.key} onPress={() => setCreditPayMethod(m.key)}
                        style={[styles.methodChip, creditPayMethod === m.key && styles.methodChipActive]}>
                        <Text variant="label" style={{
                          color: creditPayMethod === m.key ? palette.textInverse : palette.textSecondary,
                          textAlign: 'center', fontSize: 13,
                          opacity: creditPayMethod === m.key ? 1 : 0.45,
                        }}>
                          {m.label}
                        </Text>
                      </Pressable>
                    ))}
                  </View>
                </View>
              )}

              {/* Due date — optional, only when it's an actual credit */}
              {!creditUpfrontCoversAll && (
                <View style={{ gap: spacing[2] }}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing[2] }}>
                    <Text variant="label" style={styles.sectionLabel}>Remboursement prévu ?</Text>
                    <Text variant="caption" style={{ color: palette.textSecondary }}>(optionnel)</Text>
                  </View>
                  <View style={styles.methodGrid}>
                    {(['1w', '1m', 'custom'] as const).map(pill => (
                      <Pressable
                        key={pill}
                        onPress={() => {
                          haptics.tap();
                          const next = dueDatePill === pill ? null : pill;
                          setDueDatePill(next);
                          if (pill === 'custom' && next === 'custom' && !customDueDateInput) {
                            const d = new Date(); d.setMonth(d.getMonth() + 1);
                            setCustomDueDateInput(toISO(d));
                          }
                        }}
                        style={[styles.methodChip, dueDatePill === pill && styles.methodChipActive]}
                      >
                        <Text variant="label" style={{
                          color: dueDatePill === pill ? palette.textInverse : palette.textSecondary,
                          textAlign: 'center', fontSize: 13,
                          opacity: dueDatePill === pill ? 1 : 0.45,
                        }}>
                          {pill === '1w' ? '1 semaine' : pill === '1m' ? '1 mois' : 'Choisir'}
                        </Text>
                      </Pressable>
                    ))}
                  </View>
                  {dueDatePill === 'custom' && (
                    <DatePickerField
                      value={customDueDateInput}
                      onChange={setCustomDueDateInput}
                      minDate={toISO(new Date())}
                    />
                  )}
                  {computedDueDate !== null && (
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing[2] }}>
                      <Text variant="caption" style={{ color: palette.success }}>
                        ✓ {fmtDue(computedDueDate)}
                      </Text>
                      <Pressable
                        onPress={() => { setDueDatePill(null); setCustomDueDateInput(''); }}
                        hitSlop={8}
                      >
                        <Text variant="caption" style={{ color: palette.textSecondary }}>✕</Text>
                      </Pressable>
                    </View>
                  )}
                </View>
              )}
            </View>
          )}

          {step === 'pay' && !showClientSection && (
            <View style={styles.payContent}>
              <View style={{ gap: spacing[2] }}>
                <Text variant="label" style={styles.sectionLabel}>Vendu pour combien ?</Text>
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
                    <Text variant="caption" style={{ color: palette.textSecondary }}>
                      <Text style={{ color: palette.textPrimary, fontWeight: '600' }}>{formatAmount(shortfall, currency)}</Text>
                      {' '}de moins que le prix
                    </Text>

                    <Pressable onPress={() => setDisambig('rabais')} style={styles.radioRow}>
                      <View style={[styles.radio, disambig === 'rabais' && styles.radioActive]}>
                        {disambig === 'rabais' && <View style={styles.radioDot} />}
                      </View>
                      <View style={{ flex: 1 }}>
                        <Text variant="label" style={{ color: disambig === 'rabais' ? palette.primary : palette.textPrimary }}>Une réduction</Text>
                        <Text variant="caption" style={{ color: palette.textSecondary }}>Le client ne doit plus rien</Text>
                      </View>
                    </Pressable>

                    <View style={styles.radioSeparator} />

                    <Pressable onPress={() => setDisambig('credit')} style={styles.radioRow}>
                      <View style={[styles.radio, disambig === 'credit' && styles.radioActive]}>
                        {disambig === 'credit' && <View style={styles.radioDot} />}
                      </View>
                      <View style={{ flex: 1 }}>
                        <Text variant="label" style={{ color: disambig === 'credit' ? palette.primary : palette.textPrimary }}>Un crédit</Text>
                        <Text variant="caption" style={{ color: palette.textSecondary }}>
                          Le client paiera {formatAmount(shortfall, currency)} plus tard
                        </Text>
                      </View>
                    </Pressable>
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
                    <TextInput
                      ref={clientSearchRef}
                      value={clientSearch}
                      onChangeText={setClientSearch}
                      placeholder="Rechercher un client…"
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
                        const sum = c.name ? c.name.split('').reduce((acc, ch) => acc + ch.charCodeAt(0), 0) : 0;
                        const avatarBg = CLIENT_AVATAR_PALETTE[sum % CLIENT_AVATAR_PALETTE.length];
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
                  <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
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
                        placeholder="Mamadou Diallo"
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
              <>
                {step === 'credit' && !canConfirmCredit && !showClientSection && (
                  <Text variant="caption" style={{ color: palette.warning, textAlign: 'center', marginBottom: spacing[2] }}>
                    Ajoutez un nom de client pour enregistrer le crédit
                  </Text>
                )}
                <Button
                  label={submitting ? 'Enregistrement…' : (step === 'credit' ? (creditUpfrontCoversAll ? 'Enregistrer la vente' : 'Enregistrer le crédit') : 'Confirmer la vente')}
                  onPress={step === 'credit' ? handleConfirmCredit : handleConfirmPay}
                  loading={submitting}
                  fullWidth
                  size="lg"
                  disabled={step === 'credit' ? !canConfirmCredit : !canConfirmPay}
                />
              </>
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
  const { palette } = useTheme();
  const styles = useMemo(() => makeStyles(palette), [palette]);
  const totalInCart = cartQty + cartBulkQty;
  // Variant products always have stock_qty=0 on the parent — never treat them as out-of-stock.
  // For plain products, stock already reserved in the cart is no longer sellable this session.
  const outOfStock = !product.has_variants && product.stock_qty - totalInCart <= 0;
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
          <Text variant="caption" style={{ color: palette.warning, fontSize: 9 }}>GROS</Text>
        </View>
      )}
      <Text variant="label" numberOfLines={2} style={styles.tileName}>{product.name}</Text>
      {!product.has_variants && (
        <Text variant="caption" color="secondary" numberOfLines={1}>
          {outOfStock ? 'Épuisé' : `${product.stock_qty - totalInCart} ${product.unit}`}
        </Text>
      )}
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
        <Text variant="label" style={{ color: outOfStock ? palette.textDisabled : palette.primary }}>
          {formatAmount(product.sale_price, currency)}
        </Text>
        {product.has_variants && (
          <Text style={{ color: palette.primary, fontSize: 16 }}>›</Text>
        )}
      </View>
      {hasBulk && product.bulk_price ? (
        <Text variant="caption" style={{ color: palette.warning }}>
          Gros: {formatAmount(product.bulk_price, currency)}
        </Text>
      ) : null}
    </Pressable>
  );
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function pairUp<T>(arr: T[]): T[][] {
  const result: T[][] = [];
  for (let i = 0; i < arr.length; i += 2) result.push(arr.slice(i, i + 2));
  return result;
}

// ─── Variant Picker Sheet ─────────────────────────────────────────────────────

interface VariantPickerSheetProps {
  visible: boolean;
  product: Product | null;
  variants: ProductVariant[];
  cartQtyByVariant: Record<string, number>;
  currency: string;
  onClose: () => void;
  onPickMany: (selections: { variant: ProductVariant; qty: number }[]) => void;
}

function VariantPickerSheet({ visible, product, variants, cartQtyByVariant, currency, onClose, onPickMany }: VariantPickerSheetProps) {
  const { palette } = useTheme();
  const styles = useMemo(() => makeStyles(palette), [palette]);
  const translateY = useRef(new Animated.Value(400)).current;
  const [qtys, setQtys] = useState<Record<string, number>>({});
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editVal, setEditVal] = useState('');
  const editRef = useRef<TextInput>(null);

  useEffect(() => {
    if (visible) {
      setQtys({});
      setEditingId(null);
      Animated.spring(translateY, { toValue: 0, useNativeDriver: true, bounciness: 4 }).start();
    } else {
      translateY.setValue(400);
    }
  }, [visible]);

  if (!product) return null;

  const totalAdded = Object.values(qtys).reduce((s, q) => s + q, 0);

  const changeQty = (variantId: string, delta: number, maxStock: number) => {
    setQtys(prev => {
      const cur = prev[variantId] ?? 0;
      const next = Math.max(0, Math.min(cur + delta, maxStock));
      return { ...prev, [variantId]: next };
    });
  };

  const startEdit = (variantId: string, currentQty: number) => {
    setEditVal(String(currentQty));
    setEditingId(variantId);
    setTimeout(() => editRef.current?.focus(), 30);
  };

  const commitEdit = (variantId: string, maxStock: number) => {
    const n = parseInt(editVal, 10);
    if (!isNaN(n)) {
      setQtys(prev => ({ ...prev, [variantId]: Math.max(0, Math.min(n, maxStock)) }));
    }
    setEditingId(null);
  };

  const confirm = () => {
    const selections = variants
      .map(v => ({ variant: v, qty: qtys[v.id] ?? 0 }))
      .filter(s => s.qty > 0);
    onPickMany(selections);
    onClose();
  };

  return (
    <Modal visible={visible} transparent animationType="none" onRequestClose={onClose}>
      <Pressable style={StyleSheet.absoluteFill} onPress={onClose}>
        <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.45)' }} />
      </Pressable>
      <Animated.View style={[styles.variantSheet, { transform: [{ translateY }] }]}>
        <View style={styles.variantSheetHandle} />
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: spacing[4] }}>
          <Text variant="h4">{product.name}</Text>
          <Text variant="label" style={{ color: palette.primary }}>
            {formatAmount(product.sale_price, currency)}
          </Text>
        </View>
        <ScrollView showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
          {variants.map(v => {
            // Stock already sitting in the cart this session isn't sellable
            // again until the sale completes or the cart is cleared.
            const reserved = cartQtyByVariant[v.id] ?? 0;
            const remaining = Math.max(0, v.stock_qty - reserved);
            const outOfStock = remaining <= 0;
            const qty = qtys[v.id] ?? 0;
            const isEditing = editingId === v.id;
            const atMax = qty >= remaining;
            return (
              <View
                key={v.id}
                style={[styles.variantOption, outOfStock && { opacity: 0.4 }]}
              >
                <View style={{ flex: 1 }}>
                  <Text variant="body" style={{ fontWeight: '600' }}>{v.name}</Text>
                  <Text variant="caption" color="secondary">
                    {outOfStock ? 'Épuisé' : `${remaining} en stock`}
                    {reserved > 0 ? ` · ${reserved} déjà dans le panier` : ''}
                  </Text>
                </View>
                <View style={styles.qtyControl}>
                  <Pressable
                    onPress={() => { if (!outOfStock && qty > 0) { haptics.selection(); changeQty(v.id, -1, remaining); } }}
                    style={[styles.qtyBtn, (outOfStock || qty === 0) && { opacity: 0.3 }]}
                  >
                    <Text variant="label" style={{ color: qty === 0 ? palette.textDisabled : palette.danger }}>−</Text>
                  </Pressable>
                  {isEditing ? (
                    <TextInput
                      ref={editRef}
                      style={styles.qtyInput}
                      value={editVal}
                      onChangeText={setEditVal}
                      onBlur={() => commitEdit(v.id, remaining)}
                      onSubmitEditing={() => commitEdit(v.id, remaining)}
                      keyboardType="number-pad"
                      selectTextOnFocus
                      returnKeyType="done"
                    />
                  ) : (
                    <Pressable
                      onPress={() => !outOfStock && startEdit(v.id, qty)}
                      style={styles.qtyNumPress}
                    >
                      <Text variant="label" style={styles.qtyNum}>{qty}</Text>
                    </Pressable>
                  )}
                  <Pressable
                    onPress={() => { if (!outOfStock && !atMax) { haptics.selection(); changeQty(v.id, 1, remaining); } }}
                    style={[styles.qtyBtn, (outOfStock || atMax) && { opacity: 0.3 }]}
                  >
                    <Text variant="label" style={{ color: (outOfStock || atMax) ? palette.textDisabled : palette.primary }}>+</Text>
                  </Pressable>
                </View>
              </View>
            );
          })}
        </ScrollView>
        <View style={{ paddingTop: spacing[4] }}>
          <Button
            label={totalAdded > 0 ? `Ajouter ${totalAdded} article${totalAdded > 1 ? 's' : ''}` : 'Ajouter'}
            onPress={confirm}
            fullWidth
            size="lg"
            disabled={totalAdded === 0}
          />
        </View>
      </Animated.View>
    </Modal>
  );
}

// ─── Animated FAB ─────────────────────────────────────────────────────────────

function AnimatedFAB({ onPress }: { onPress: () => void }) {
  const { palette } = useTheme();
  const styles = useMemo(() => makeStyles(palette), [palette]);
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
  const { palette } = useTheme();
  const styles = useMemo(() => makeStyles(palette), [palette]);
  const session = useAuthStore(s => s.session);
  const business = session?.activeBusiness;
  const userId = session?.user.id ?? '';
  const businessId = business?.id ?? '';
  const currency = business?.currency ?? 'GNF';
  const role = session?.activeMembership?.role;
  const isVendeur = role === 'vendeur';

  const { products: allProducts, vendeurProductScope, variantsByProduct, loading, fetchProducts, fetchVariants } = useProductStore();

  // Apply vendeur product scope (empty = unscoped, sees everything)
  const products = useMemo(() => {
    if (!isVendeur || vendeurProductScope.length === 0) return allProducts;
    return allProducts.filter(p => vendeurProductScope.includes(p.id));
  }, [allProducts, vendeurProductScope, isVendeur]);
  const { cart, submitting, error: saleError, addToCart, addToCartVariant, removeFromCart, setQty, toggleBulk, clearCart, submitSale, submitCarnetDebt, clearError } =
    useSalesStore();

  const [mode, setMode] = useState<'vente' | 'credit'>('vente');
  const [creditName, setCreditName] = useState('');
  const [creditPhone, setCreditPhone] = useState('');
  const [creditClientId, setCreditClientId] = useState<string | undefined>();
  const [creditAmount, setCreditAmount] = useState('');
  const [clientBalance, setClientBalance] = useState<number | null>(null);
  const [creditSaving, setCreditSaving] = useState(false);
  const [creditSuccess, setCreditSuccess] = useState(false);
  const [creditError, setCreditError] = useState<string | null>(null);
  const [creditSessionCount, setCreditSessionCount] = useState(0);
  const [creditPhoneResetKey, setCreditPhoneResetKey] = useState(0);
  const [showCreditClientList, setShowCreditClientList] = useState(false);
  const [creditClientSearch, setCreditClientSearch] = useState('');
  const [creditQuickClients, setCreditQuickClients] = useState<{ id?: string; name: string; phone?: string | null }[]>([]);
  const creditNameRef = useRef<TextInput>(null);
  const creditAmountRef = useRef<TextInput>(null);
  const creditBlinkAnim = useRef(new Animated.Value(0)).current;
  const creditBlinkLoopRef = useRef<Animated.CompositeAnimation | null>(null);

  const [search, setSearch] = useState('');
  const [showPayment, setShowPayment] = useState(false);
  const [payStep, setPayStep] = useState<PayStep>('pay');
  const [showConfirmSheet, setShowConfirmSheet] = useState(false);
  // Whether the sale just confirmed was queued offline rather than synced —
  // same confirm+share sheet either way, just a small "en attente" badge.
  const [confirmQueued, setConfirmQueued] = useState(false);
  const [variantPickerProduct, setVariantPickerProduct] = useState<Product | null>(null);
  const [lastReceipt, setLastReceipt] = useState<ReceiptData | null>(null);
  const receiptViewRef = useRef<View>(null);
  const pendingReceiptRef = useRef<ReceiptData | null>(null);
  const cartScrollRef = useRef<ScrollView>(null);
  const cartRowOffsets = useRef<Record<string, number>>({});

  const membershipId = session?.activeMembership?.id;

  useEffect(() => {
    if (businessId) fetchProducts(businessId, userId, membershipId, role);
  }, [businessId]);

  useEffect(() => {
    if (!businessId || products.length === 0) return;
    products.filter(p => p.has_variants && !variantsByProduct[p.id])
      .forEach(p => fetchVariants(p.id, businessId));
  }, [products, businessId]);

  // Variant stock can change from another device or the offline queue while this
  // screen stays mounted in the background — refetch on every focus so the cart's
  // stock cap (Math.min against variant.stock_qty) isn't capping against stale data.
  useFocusEffect(
    useCallback(() => {
      if (!businessId) return;
      products.filter(p => p.has_variants).forEach(p => fetchVariants(p.id, businessId));
    }, [businessId, products, fetchVariants])
  );


  useEffect(() => {
    if (mode === 'credit' && businessId && creditQuickClients.length === 0) {
      supabase.from('clients').select('id, name, phone').eq('business_id', businessId)
        .then(({ data }) => {
          if (data) setCreditQuickClients(
            (data as { id: string; name: string; phone?: string | null }[])
              .sort((a, b) => a.name.localeCompare(b.name))
          );
        });
    }
  }, [mode, businessId]);

  useEffect(() => {
    if (creditName.trim() && !creditAmount) {
      creditBlinkLoopRef.current = Animated.loop(
        Animated.sequence([
          Animated.timing(creditBlinkAnim, { toValue: 1, duration: 700, useNativeDriver: false }),
          Animated.timing(creditBlinkAnim, { toValue: 0, duration: 700, useNativeDriver: false }),
        ])
      );
      creditBlinkLoopRef.current.start();
    } else {
      creditBlinkLoopRef.current?.stop();
      creditBlinkLoopRef.current = null;
      Animated.timing(creditBlinkAnim, { toValue: 0, duration: 150, useNativeDriver: false }).start();
    }
    return () => { creditBlinkLoopRef.current?.stop(); };
  }, [creditName, creditAmount]);

  useEffect(() => {
    // Resolve ID from direct selection or exact name match
    const resolvedId = creditClientId ?? creditQuickClients.find(
      c => c.name.toLowerCase() === creditName.trim().toLowerCase()
    )?.id;
    if (!resolvedId || !businessId) { setClientBalance(null); return; }

    // Two-step: get credit orders by client_id, then sum actual payments per order
    supabase
      .from('sale_orders')
      .select('id, total_amount, discount_amount')
      .eq('business_id', businessId)
      .eq('client_id', resolvedId)
      .eq('status', 'credit')
      .then(async ({ data: orders }) => {
        if (!orders?.length) { setClientBalance(null); return; }
        const orderIds = orders.map(o => (o as { id: string }).id);
        const { data: pays } = await supabase
          .from('payments')
          .select('order_id, amount')
          .in('order_id', orderIds);
        const paidByOrder: Record<string, number> = {};
        for (const p of (pays ?? []) as { order_id: string; amount: number }[]) {
          paidByOrder[p.order_id] = (paidByOrder[p.order_id] ?? 0) + p.amount;
        }
        const totalCents = (orders as { id: string; total_amount: number; discount_amount: number | null }[])
          .reduce((sum, s) => {
            const remaining = s.total_amount - (s.discount_amount ?? 0) - (paidByOrder[s.id] ?? 0);
            return sum + (remaining > 0 ? remaining : 0);
          }, 0);
        setClientBalance(totalCents > 0 ? totalCents / 100 : null);
      });
  }, [creditClientId, creditName, creditQuickClients, businessId]);

  const filtered = useMemo(() => {
    const q = search.toLowerCase().trim();
    const base = q
      ? products.filter(p => p.name.toLowerCase().includes(q) || (p.category?.toLowerCase().includes(q) ?? false))
      : products;
    return [...base].sort((a, b) => a.name.localeCompare(b.name, 'fr'));
  }, [products, search]);

  const inStockFiltered = useMemo(() => filtered.filter(p => {
    if (!p.has_variants) return p.stock_qty > 0;
    const variants = variantsByProduct[p.id];
    if (!variants || variants.length === 0) return true;
    return variants.some(v => v.stock_qty > 0);
  }), [filtered, variantsByProduct]);

  const cartTotal = useMemo(() => cart.reduce((s, l) => s + l.unit_price * l.qty, 0), [cart]);
  const cartCount = useMemo(() => cart.reduce((s, l) => s + l.qty, 0), [cart]);
  // How much of each variant is already reserved in the cart this session —
  // the picker must subtract this from stock_qty so it can never let the
  // merchant select more than what's actually left to sell.
  const variantCartQty = useMemo(() => {
    const map: Record<string, number> = {};
    for (const l of cart) {
      if (l.variant_id) map[l.variant_id] = (map[l.variant_id] ?? 0) + l.qty;
    }
    return map;
  }, [cart]);
  const displayTotal = useCountUp(cartTotal);

  const sheetCheckW = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (showConfirmSheet) {
      const t = setTimeout(() => {
        Animated.timing(sheetCheckW, {
          toValue: 22,
          duration: 200,
          easing: Easing.out(Easing.quad),
          useNativeDriver: false,
        }).start();
      }, 400);
      return () => clearTimeout(t);
    } else {
      sheetCheckW.setValue(0);
    }
  }, [showConfirmSheet]);

  // Confirmation sheet: pre-computed breakdown for lastReceipt
  const confirmNet       = lastReceipt ? lastReceipt.total - (lastReceipt.discountAmount ?? 0) : 0;
  const confirmUpfront   = lastReceipt?.amountPaid ?? 0;
  const confirmRemaining = Math.max(0, confirmNet - confirmUpfront);
  const confirmIsCredit  = lastReceipt
    ? lastReceipt.payment === null || confirmRemaining > 0.01
    : false;

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

  const handleCreditAdd = async () => {
    const trimmedName = creditName.trim();
    const trimmedPhone = creditPhone.trim();
    const parsed = Math.round(parseAmountInput(creditAmount, currency));
    if (!trimmedName || isNaN(parsed) || parsed <= 0) return;
    setCreditSaving(true);
    setCreditError(null);

    let resolvedClientId = creditClientId;
    if (!resolvedClientId) {
      const { data } = await supabase.from('clients').upsert(
        { business_id: businessId, name: trimmedName, phone: trimmedPhone || null },
        { onConflict: 'business_id,name' },
      ).select('id').single();
      resolvedClientId = data?.id ?? undefined;
    }

    const ok = await submitCarnetDebt(businessId, userId, trimmedName, parsed * 100);
    setCreditSaving(false);
    if (!ok) {
      setCreditError('Impossible d\'enregistrer. Vérifiez votre connexion et réessayez.');
      return;
    }
    setCreditName('');
    setCreditPhone('');
    setCreditPhoneResetKey(k => k + 1);
    setCreditAmount('');
    setCreditClientId(undefined);
    setClientBalance(null);
    setShowCreditClientList(false);
    setCreditClientSearch('');
    trackEvent('credit_debt_added', businessId, userId);
    setCreditSuccess(true);
    setCreditSessionCount(c => c + 1);
    setTimeout(() => { setCreditSuccess(false); creditNameRef.current?.focus(); }, 1200);
  };

  const handleConfirmPayment = useCallback(
    async (payment: SalePayment | null, customerName?: string, discountAmount?: number, clientId?: string, dueDate?: string | null) => {
      const total = cartTotal;
      const isCredit = payment === null;

      // When merchant sells above catalog price, use their typed amount as the actual sale total
      const effectiveTotal = payment && payment.amount > total + 0.5 ? payment.amount : total;
      // Scale item unit prices so they sum to the effective total — avoids a mismatch on the receipt
      const priceRatio = effectiveTotal > total + 0.5 && total > 0 ? effectiveTotal / total : 1;
      const receiptItems: ReceiptItem[] = cart.map(l => ({
        name: l.variant_name ? `${l.product.name} · ${l.variant_name}` : l.product.name,
        qty: l.qty,
        unit_price: priceRatio !== 1 ? Math.round(l.unit_price * priceRatio) : l.unit_price,
        is_bulk: l.is_bulk,
      }));
      pendingReceiptRef.current = {
        businessName: business?.name ?? '',
        businessPhone: business?.phone ?? null,
        currency,
        items: receiptItems,
        total: effectiveTotal,
        discountAmount: discountAmount && discountAmount > 0 ? discountAmount : undefined,
        amountPaid: payment ? payment.amount : undefined,
        payment: payment ?? null,
        customerName,
        date: new Date(),
      };

      const ok = await submitSale(businessId, userId, payment, customerName, undefined, discountAmount, clientId, effectiveTotal !== total ? effectiveTotal : undefined, dueDate ?? null);
      if (ok) {
        setLastReceipt(pendingReceiptRef.current);
        setShowPayment(false);
        setSearch('');
        const queued = useSalesStore.getState().lastSubmitQueued;
        if (!queued) fetchProducts(businessId, userId, membershipId, role);
        setConfirmQueued(queued);
        setShowConfirmSheet(true);
      } else {
        // Sale failed — show a blocking alert so the merchant knows the sale was NOT saved
        const errMsg = useSalesStore.getState().error ?? 'Une erreur est survenue. La vente n\'a pas été enregistrée.';
        if (errMsg.startsWith('Stock insuffisant')) {
          // Someone sold the same stock in the meantime (or our cached count was
          // stale). Refresh the real numbers and trim the cart down to what's
          // actually available instead of leaving a doomed line for the merchant
          // to retry blindly — mirrors how simple products can never be added
          // past their known stock.
          await fetchProducts(businessId, userId, membershipId, role);
          const variantProductIds = Array.from(new Set(cart.filter(l => l.variant_id).map(l => l.product.id)));
          await Promise.all(variantProductIds.map(id => fetchVariants(id, businessId)));
          const freshVariants = useProductStore.getState().variantsByProduct;
          const freshProducts = useProductStore.getState().products;
          cart.forEach(l => {
            const max = l.variant_id
              ? freshVariants[l.product.id]?.find(v => v.id === l.variant_id)?.stock_qty ?? 0
              : freshProducts.find(p => p.id === l.product.id)?.stock_qty ?? 0;
            if (l.qty > max) setQty(l.product.id, max, l.is_bulk, l.variant_id);
          });
        }
        Alert.alert('Vente non enregistrée', errMsg, [{ text: 'OK', onPress: clearError }]);
      }
    },
    [businessId, userId, cartTotal, currency, submitSale, fetchProducts],
  );

  const handleShareReceipt = async () => {
    if (!receiptViewRef.current || !lastReceipt) return;
    try {
      const uri = await captureRef(receiptViewRef, { format: 'png', quality: 1 });
      // Share while modal is still mounted — iOS can present share sheet on top.
      // Close only after the share sheet is dismissed (shareAsync resolves).
      await Sharing.shareAsync(uri, { mimeType: 'image/png', UTI: 'public.png', dialogTitle: 'Partager le reçu' });
      trackEvent('receipt_shared', businessId, userId, {
        is_credit: confirmIsCredit,
      });
      setShowConfirmSheet(false);
    } catch (shareErr) {
      Alert.alert('Impossible de partager le reçu pour l\'instant.');
    }
  };

  if (loading && products.length === 0) {
    return (
      <Screen tab>
        <SkeletonList count={9} />
      </Screen>
    );
  }

  return (
    <Screen tab>
      {/* Error banner */}
      {saleError ? (
        <Pressable onPress={clearError} style={styles.errorBanner}>
          <Text variant="label" style={{ color: palette.warning }}>{saleError}</Text>
          <Text variant="caption" style={{ color: palette.warning, opacity: 0.7 }}>Appuyer pour fermer</Text>
        </Pressable>
      ) : null}

      {/* Header + mode toggle */}
      <View style={styles.header}>
        <Text variant="h3">Vendre</Text>
        {mode === 'vente' && cart.length > 0 && (
          <Pressable onPress={() => Alert.alert('Vider le panier ?', '', [
            { text: 'Annuler', style: 'cancel' },
            { text: 'Vider', style: 'destructive', onPress: clearCart },
          ])}>
            <Text variant="bodySmall" color="danger">Vider</Text>
          </Pressable>
        )}
      </View>

      {/* Vente / Crédit segment */}
      <View style={[styles.modeToggle, { backgroundColor: palette.border + '55', borderColor: palette.border }]}>
        <Pressable
          style={[styles.modeBtn, mode === 'vente' && { backgroundColor: palette.surface }]}
          onPress={() => setMode('vente')}
        >
          <Text variant="label" style={{ color: mode === 'vente' ? palette.primary : palette.textSecondary }}>
            Vente
          </Text>
        </Pressable>
        <Pressable
          style={[styles.modeBtn, mode === 'credit' && { backgroundColor: palette.surface }]}
          onPress={() => setMode('credit')}
        >
          <Text variant="label" style={{ color: mode === 'credit' ? palette.primary : palette.textSecondary }}>
            Crédit
          </Text>
        </Pressable>
      </View>

      {/* Crédit rapide form */}
      {mode === 'credit' && (
        <View style={styles.creditForm}>
          {/* Client picker — shows when list is open */}
          {showCreditClientList ? (
            <View style={[styles.creditClientList, { borderColor: palette.border }]}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing[2], marginBottom: spacing[2] }}>
                <TextInput
                  style={[styles.creditClientSearch, { color: palette.textPrimary, borderColor: palette.border }]}
                  value={creditClientSearch}
                  onChangeText={setCreditClientSearch}
                  placeholder="Rechercher…"
                  placeholderTextColor={palette.textDisabled}
                  autoFocus
                />
                <Pressable onPress={() => { setShowCreditClientList(false); setCreditClientSearch(''); }} hitSlop={8}>
                  <Text variant="caption" style={{ color: palette.textSecondary }}>Annuler</Text>
                </Pressable>
              </View>
              <ScrollView style={{ maxHeight: 160 }} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
                {creditQuickClients
                  .filter(c => !creditClientSearch || c.name.toLowerCase().includes(creditClientSearch.toLowerCase()) || (c.phone ?? '').includes(creditClientSearch))
                  .map(c => (
                    <Pressable
                      key={c.id ?? c.name}
                      onPress={() => {
                        setCreditName(c.name);
                        setCreditPhone(c.phone ?? '');
                        setCreditClientId(c.id);
                        setShowCreditClientList(false);
                        setCreditClientSearch('');
                        setTimeout(() => creditAmountRef.current?.focus(), 50);
                      }}
                      style={({ pressed }) => [styles.creditClientRow, { borderBottomColor: palette.border }, pressed && { opacity: 0.55 }]}
                    >
                      <View style={{ flex: 1 }}>
                        <Text variant="label">{c.name}</Text>
                        {c.phone ? <Text variant="caption" color="secondary">{c.phone}</Text> : null}
                      </View>
                      <Ionicons name="chevron-forward" size={14} color={palette.textDisabled} />
                    </Pressable>
                  ))}
                {creditQuickClients.filter(c => !creditClientSearch || c.name.toLowerCase().includes(creditClientSearch.toLowerCase()) || (c.phone ?? '').includes(creditClientSearch)).length === 0 && (
                  <Text variant="caption" color="secondary" style={{ paddingVertical: spacing[2] }}>Aucun client trouvé</Text>
                )}
              </ScrollView>
            </View>
          ) : (
            <>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing[2] }}>
                <TextInput
                  ref={creditNameRef}
                  style={[styles.creditInput, { flex: 1, color: palette.textPrimary, borderColor: palette.border }]}
                  placeholder="Nom"
                  placeholderTextColor={palette.textDisabled}
                  value={creditName}
                  onChangeText={v => { setCreditName(v); setCreditClientId(undefined); setCreditError(null); }}
                  returnKeyType="next"
                  onSubmitEditing={() => creditAmountRef.current?.focus()}
                  autoCapitalize="words"
                  autoFocus={!creditName}
                />
                {creditQuickClients.length > 0 && (
                  <Pressable
                    onPress={() => setShowCreditClientList(true)}
                    style={[styles.creditClientBtn, { borderColor: palette.border }]}
                    hitSlop={4}
                  >
                    <Ionicons name="people-outline" size={18} color={palette.primary} />
                  </Pressable>
                )}
              </View>
              <PhoneInput
                label="Téléphone (optionnel)"
                onChange={(e164, isComplete) => { setCreditPhone(isComplete ? e164 : ''); setCreditError(null); }}
                strict={false}
                resetKey={creditPhoneResetKey}
              />
              <View>
                <Text variant="label" color="secondary" style={{ marginBottom: spacing[2] }}>
                  Combien il vous doit ?
                </Text>
                <Animated.View style={[styles.moneyAmountBox, {
                  borderColor: creditBlinkAnim.interpolate({
                    inputRange: [0, 1],
                    outputRange: [palette.border, palette.primary],
                  }),
                }]}>
                  <TextInput
                    ref={creditAmountRef}
                    style={[styles.moneyAmountInput, { color: creditAmount ? palette.textPrimary : palette.textDisabled }]}
                    placeholder="0"
                    placeholderTextColor={palette.textDisabled}
                    value={creditAmount}
                    onChangeText={v => { setCreditAmount(formatAmountInput(v, currency)); setCreditError(null); }}
                    keyboardType="numeric"
                    returnKeyType="done"
                    onSubmitEditing={handleCreditAdd}
                  />
                  <Text style={[styles.moneyAmountCurrency, { color: palette.textSecondary }]}>{currency}</Text>
                </Animated.View>
                {clientBalance !== null && clientBalance > 0 && (
                  <Text variant="caption" style={{ color: palette.textDisabled, marginTop: spacing[1], textAlign: 'center' }}>
                    Solde actuel · {formatAmount(clientBalance, currency)}
                  </Text>
                )}
              </View>
            </>
          )}
          <Button
            label={creditSuccess ? '✓ Noté !' : 'Ajouter'}
            onPress={handleCreditAdd}
            loading={creditSaving}
            fullWidth
            size="lg"
            style={creditSuccess ? { backgroundColor: palette.success } : undefined}
          />
          {creditError ? (
            <Text variant="caption" style={{ color: palette.warning, textAlign: 'center', marginTop: spacing[2] }}>
              {creditError}
            </Text>
          ) : null}
          {creditSessionCount > 0 && !creditError ? (
            <Pressable
              onPress={() => router.push('/(app)/credits')}
              style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: spacing[1], marginTop: spacing[3] }}
            >
              <Text variant="caption" style={{ color: palette.success }}>
                {creditSessionCount} crédit{creditSessionCount > 1 ? 's' : ''} enregistré{creditSessionCount > 1 ? 's' : ''}
              </Text>
              <Text variant="caption" style={{ color: palette.primary }}>· Voir →</Text>
            </Pressable>
          ) : null}
        </View>
      )}

      {/* Empty state — Vente mode, no products yet */}
      {mode === 'vente' && products.length === 0 && (
        <View style={styles.emptyFull}>
          <Ionicons name="receipt-outline" size={48} color={palette.textDisabled} />
          <Text variant="h4">Point de vente</Text>
          <Text variant="body" color="secondary" style={styles.emptyDesc}>
            {isVendeur
              ? 'Le catalogue est vide — votre responsable prépare les produits.'
              : 'Ajoutez votre premier produit au catalogue pour commencer à vendre.'}
          </Text>
        </View>
      )}

      {/* Search — only in Vente mode with 3+ products */}
      {mode === 'vente' && products.length >= 3 && (
        <View style={styles.searchRow}>
          <Input placeholder="Rechercher un produit…" value={search} onChangeText={setSearch} />
        </View>
      )}

      {/* Bulk hint — only in Vente mode with products */}
      {mode === 'vente' && products.length > 0 && products.some(p => p.bulk_price) && (
        <View style={styles.hintBanner}>
          <Ionicons name="information-circle-outline" size={14} color={palette.warning} />
          <Text variant="caption" style={{ color: palette.warning, flex: 1 }}>
            Maintenez un produit en gros pour l'ajouter en vente de gros
          </Text>
        </View>
      )}

      {/* Product grid — only in Vente mode with products */}
      {mode === 'vente' && products.length > 0 && <FlatList
        data={inStockFiltered}
        keyExtractor={p => p.id}
        numColumns={2}
        columnWrapperStyle={styles.tileRow}
        contentContainerStyle={[styles.tileList, cart.length > 0 && { paddingBottom: 300 }]}
        showsVerticalScrollIndicator={false}
        renderItem={({ item }) => (
          <ProductTile
            product={item}
            currency={currency}
            cartQty={cartQtyMap[item.id]?.unit ?? 0}
            cartBulkQty={cartQtyMap[item.id]?.bulk ?? 0}
            onAdd={() => {
              if (item.sale_price <= 0) {
                Alert.alert('Prix manquant', 'Ajoutez un prix de vente pour ce produit.');
                return;
              }
              if (item.has_variants) {
                setLastReceipt(null);
                haptics.selection();
                Keyboard.dismiss();
                setVariantPickerProduct(item);
                return;
              }
              const inCart = cartQtyMap[item.id]?.unit ?? 0;
              if (inCart >= item.stock_qty) { haptics.warning(); return; }
              setLastReceipt(null);
              if (inCart + 1 >= item.stock_qty) haptics.warning(); else haptics.selection();
              Keyboard.dismiss();
              addToCart(item, false);
            }}
            onAddBulk={item.has_variants ? undefined : () => { setLastReceipt(null); haptics.selection(); Keyboard.dismiss(); addToCart(item, true); }}
          />
        )}
        ListEmptyComponent={
          <View style={styles.emptySearch}>
            <Text variant="body" color="secondary">Aucun résultat pour "{search}"</Text>
          </View>
        }
      />}

      {/* Cart panel (floating) — only in Vente mode */}
      {mode === 'vente' && cart.length > 0 && (
        <View style={styles.cartPanel}>
          <ScrollView ref={cartScrollRef} style={styles.cartScroll} keyboardShouldPersistTaps="handled">
            {cart.map(line => {
              const rowKey = line.variant_id ?? `${line.product.id}-${line.is_bulk}`;
              return (
                <CartRow
                  key={rowKey}
                  line={line}
                  currency={currency}
                  onInc={() => setQty(line.product.id, line.qty + 1, line.is_bulk, line.variant_id)}
                  onDec={() => setQty(line.product.id, line.qty - 1, line.is_bulk, line.variant_id)}
                  onRemove={() => removeFromCart(line.product.id, line.is_bulk, line.variant_id)}
                  onToggleBulk={() => toggleBulk(line.product.id, line.is_bulk)}
                  onSetQty={(qty) => setQty(line.product.id, qty, line.is_bulk, line.variant_id)}
                  onEditStart={() => {
                    const y = cartRowOffsets.current[rowKey];
                    if (y !== undefined) cartScrollRef.current?.scrollTo({ y, animated: true });
                  }}
                  onLayout={e => { cartRowOffsets.current[rowKey] = e.nativeEvent.layout.y; }}
                />
              );
            })}
          </ScrollView>
          <View style={styles.cartFooter}>
            <View style={styles.cartTotalRow}>
              <Text variant="caption" color="secondary">
                {cartCount} article{cartCount > 1 ? 's' : ''}
              </Text>
              <Text variant="amountLarge" numberOfLines={1} style={styles.cartTotalAmount}>
                {formatAmount(displayTotal, currency)}
              </Text>
            </View>
            <Button label="Encaisser maintenant" onPress={openPay} size="lg" fullWidth />
            <Pressable onPress={openCredit} style={styles.creditLink}>
              <Text variant="caption" style={{ color: palette.primary }}>ou enregistrer à crédit</Text>
            </Pressable>
          </View>
        </View>
      )}

      {/* FAB to add first product — Vente mode, no products, not vendeur */}
      {mode === 'vente' && products.length === 0 && !isVendeur && (
        <AnimatedFAB onPress={() => router.push({ pathname: '/(app)/(tabs)/catalogue', params: { openForm: '1' } })} />
      )}

      <VariantPickerSheet
        visible={variantPickerProduct !== null}
        product={variantPickerProduct}
        variants={variantPickerProduct ? (variantsByProduct[variantPickerProduct.id] ?? []) : []}
        cartQtyByVariant={variantCartQty}
        currency={currency}
        onClose={() => setVariantPickerProduct(null)}
        onPickMany={selections => {
          if (!variantPickerProduct || selections.length === 0) return;
          setLastReceipt(null);
          haptics.selection();
          for (const { variant, qty } of selections) {
            addToCartVariant(variantPickerProduct, variant, qty);
          }
        }}
      />

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
        <View style={[StyleSheet.absoluteFill, { backgroundColor: palette.surface }]} pointerEvents="none" />
        {/* Outer container — box-none so it never consumes touches itself */}
        <View style={styles.sheetOverlay} pointerEvents="box-none">
          {/* Backdrop — sits behind the sheet in z-order (rendered first) */}
          <Pressable
            style={[StyleSheet.absoluteFill, { backgroundColor: 'rgba(0,0,0,0.45)' }]}
            onPress={() => setShowConfirmSheet(false)}
          />
          {/* Sheet — rendered after backdrop, higher z-order, captures its own touches */}
          <View style={styles.sheet}>
            <View style={styles.sheetHead}>
              <View style={styles.sheetCheckCircle}>
                <Animated.View style={[styles.sheetCheckmark, { width: sheetCheckW }]} />
              </View>
              <Text variant="h3" style={{ textAlign: 'center' }}>
                {confirmIsCredit ? 'Crédit enregistré' : 'Vente enregistrée'}
              </Text>
              {confirmQueued && (
                <Text variant="caption" color="secondary" style={{ textAlign: 'center' }}>
                  En attente de synchronisation ⏳
                </Text>
              )}
              {lastReceipt && (
                <Text variant="h4" style={{ color: palette.primary, textAlign: 'center' }}>
                  {formatAmount(confirmNet, lastReceipt.currency)}
                </Text>
              )}
              {/* Credit with upfront: show what was received vs what remains */}
              {lastReceipt && confirmIsCredit && confirmUpfront > 0.01 && (
                <Text variant="caption" color="secondary" style={{ textAlign: 'center' }}>
                  {formatAmount(confirmUpfront, lastReceipt.currency)} reçu · {formatAmount(confirmRemaining, lastReceipt.currency)} restant
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
                      ? 'Ça donne plus confiance au client 🤗'
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
    </Screen>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const TILE_GAP = spacing[3];

function makeStyles(p: Palette) {
  return StyleSheet.create({
    safe: { flex: 1, backgroundColor: p.background },
    errorBanner: {
      backgroundColor: p.warningLight, paddingHorizontal: spacing[5], paddingVertical: spacing[3],
      alignItems: 'center', gap: 2,
    },
    header: {
      flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
      paddingHorizontal: spacing[5], paddingTop: spacing[4], paddingBottom: spacing[2],
    },
    modeToggle: {
      flexDirection: 'row', marginHorizontal: spacing[5], marginBottom: spacing[3],
      borderRadius: radius.md, borderWidth: 1, overflow: 'hidden',
    },
    modeBtn: {
      flex: 1, paddingVertical: spacing[2], alignItems: 'center',
    },
    creditForm: {
      paddingHorizontal: spacing[5], paddingBottom: spacing[4], gap: spacing[3],
    },
    creditInput: {
      borderWidth: 1, borderRadius: radius.md,
      paddingHorizontal: spacing[3], paddingVertical: spacing[3],
      fontSize: 15,
    },
    creditInputAmount: {},
    creditAmountInner: {
      paddingHorizontal: spacing[3], paddingVertical: spacing[3],
      fontSize: 15,
    },
    moneyAmountBox: {
      borderWidth: 1, borderRadius: radius.md,
      flexDirection: 'row', alignItems: 'center',
      paddingHorizontal: spacing[4], paddingVertical: spacing[4],
      gap: spacing[2],
    },
    moneyAmountInput: {
      flex: 1, fontSize: 32, fontWeight: '800', textAlign: 'center',
    },
    moneyAmountCurrency: {
      fontSize: 16, fontWeight: '600',
    },
    creditClientBtn: {
      borderWidth: 1, borderRadius: radius.md,
      padding: spacing[3], alignItems: 'center', justifyContent: 'center',
    },
    creditClientList: {
      borderWidth: 1, borderRadius: radius.md, padding: spacing[3],
    },
    creditClientSearch: {
      flex: 1, borderWidth: 1, borderRadius: radius.md,
      paddingHorizontal: spacing[3], paddingVertical: spacing[2], fontSize: 15,
    },
    creditClientRow: {
      flexDirection: 'row', alignItems: 'center', gap: spacing[2],
      paddingVertical: spacing[3], borderBottomWidth: 1,
    },
    searchRow: { paddingHorizontal: spacing[5], paddingBottom: spacing[2] },
    hintBanner: {
      flexDirection: 'row', alignItems: 'center', gap: spacing[2],
      paddingHorizontal: spacing[5], paddingVertical: spacing[2],
      backgroundColor: p.warningLight, borderBottomWidth: 1, borderBottomColor: p.warning,
      marginBottom: spacing[2],
    },

    tileList: { paddingHorizontal: spacing[5], paddingBottom: spacing[6] },
    tileRow: { gap: TILE_GAP, marginBottom: TILE_GAP },
    tile: {
      flex: 1, backgroundColor: p.surface, borderRadius: radius.lg,
      borderWidth: 1, borderColor: p.border, padding: spacing[3], gap: spacing[1], position: 'relative',
    },
    tileDisabled: { opacity: 0.45 },
    tileName: { minHeight: 36 },
    tileBadge: {
      position: 'absolute', top: 8, right: 8, backgroundColor: p.primary,
      borderRadius: radius.full, width: 22, height: 22, alignItems: 'center', justifyContent: 'center', zIndex: 10,
    },
    tileGrosBadge: {
      position: 'absolute', top: 4, right: 4,
      backgroundColor: p.warningLight, borderRadius: radius.sm, paddingHorizontal: 4, paddingVertical: 2,
      borderWidth: 1, borderColor: p.warning,
    },

    cartPanel: {
      position: 'absolute', bottom: 0, left: 0, right: 0,
      backgroundColor: p.surface, borderTopWidth: 1, borderTopColor: p.border,
      shadowColor: p.shadow, shadowOffset: { width: 0, height: -4 },
      shadowOpacity: 0.1, shadowRadius: 12, elevation: 10,
    },
    sheetOverlay: { flex: 1, justifyContent: 'flex-end' },
    sheet: { backgroundColor: p.surface, borderTopLeftRadius: 24, borderTopRightRadius: 24, overflow: 'hidden' },
    sheetHead: {
      paddingHorizontal: spacing[6], paddingTop: spacing[6], paddingBottom: spacing[4],
      gap: spacing[3], alignItems: 'center',
    },
    sheetCheckCircle: {
      width: 64, height: 64, borderRadius: 32,
      backgroundColor: p.success, justifyContent: 'center', alignItems: 'center',
    },
    sheetCheckmark: {
      height: 13,
      borderLeftWidth: 3, borderBottomWidth: 3,
      borderColor: p.textInverse, borderRadius: 1,
      transform: [{ rotate: '-45deg' }], marginTop: -3,
    },
    sheetDivider: { height: 1, backgroundColor: p.border },
    sheetFoot: {
      paddingHorizontal: spacing[6], paddingTop: spacing[4], paddingBottom: spacing[10],
      gap: spacing[4], alignItems: 'center',
    },
    shareCtaBox: {
      flexDirection: 'row', alignItems: 'flex-start',
      gap: spacing[3], alignSelf: 'stretch',
      backgroundColor: p.primaryLight,
      borderRadius: radius.card, padding: spacing[4],
    },
    ignorePressable: { paddingVertical: spacing[2] },
    cartScroll: { maxHeight: 160 },
    cartRow: {
      flexDirection: 'row', alignItems: 'center', paddingHorizontal: spacing[4],
      paddingVertical: spacing[2], borderBottomWidth: 1, borderBottomColor: p.border, gap: spacing[2],
    },
    bulkToggle: {
      paddingHorizontal: spacing[2], paddingVertical: 2, borderRadius: radius.sm,
      borderWidth: 1, borderColor: p.border, backgroundColor: p.surface,
    },
    bulkToggleActive: { backgroundColor: p.warning, borderColor: p.warning },
    qtyControl: {
      flexDirection: 'row', alignItems: 'center', borderWidth: 1, borderColor: p.border,
      borderRadius: radius.md, overflow: 'hidden',
    },
    qtyBtn: { width: 32, height: 32, alignItems: 'center', justifyContent: 'center', backgroundColor: p.background },
    qtyNumPress: { minWidth: 36, alignItems: 'center', paddingHorizontal: 4 },
    qtyNum: { minWidth: 36, textAlign: 'center' },
    qtyInput: {
      minWidth: 44, width: 56, textAlign: 'center', fontWeight: '600', fontSize: 15,
      color: p.textPrimary, paddingVertical: 2,
      borderBottomWidth: 1.5, borderBottomColor: p.primary,
    },
    cartFooter: {
      padding: spacing[4], borderTopWidth: 1, borderTopColor: p.border, gap: spacing[3],
    },
    cartTotalRow: {
      flexDirection: 'row', alignItems: 'baseline',
      justifyContent: 'space-between', gap: spacing[3],
    },
    cartTotalAmount: { flexShrink: 1, textAlign: 'right' },
    creditLink: { alignItems: 'center' },

    emptyFull: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing[8], gap: spacing[3] },
    emptyDesc: { textAlign: 'center', maxWidth: 260 },
    fabContainer: { position: 'absolute', bottom: 194, right: spacing[4], zIndex: 10 },
    fab: { width: 56, height: 56, borderRadius: radius.full, backgroundColor: p.primary, alignItems: 'center', justifyContent: 'center', shadowColor: p.textPrimary, shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.18, shadowRadius: 8, elevation: 8 },
    fabIcon: { fontSize: 28, lineHeight: 32, fontWeight: '300' as const, color: p.textInverse, marginTop: -2 },
    emptySearch: { alignItems: 'center', paddingVertical: spacing[10] },
    outOfStockHeader: { flexDirection: 'row', alignItems: 'center', paddingTop: spacing[4], paddingBottom: spacing[3] },
    outOfStockLine: { flex: 1, height: StyleSheet.hairlineWidth, backgroundColor: p.border },

    modalSafe: { flex: 1, backgroundColor: p.background },
    modalHeader: {
      flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
      paddingHorizontal: spacing[5], paddingVertical: spacing[4],
      borderBottomWidth: 1, borderBottomColor: p.border, backgroundColor: p.surface,
    },
    modalCancel: { minWidth: 64 },
    modalFooter: {
      padding: spacing[5], borderTopWidth: 1, borderTopColor: p.border, backgroundColor: p.surface,
    },

    totalSection: {
      paddingHorizontal: spacing[5], paddingTop: spacing[5], paddingBottom: spacing[5],
      borderBottomWidth: 1, borderBottomColor: p.border, gap: spacing[1],
    },
    totalBig: { fontSize: 36, lineHeight: 50, fontWeight: '700', letterSpacing: -0.5 },

    payContent: { padding: spacing[5], gap: spacing[4] },

    clientSection: {
      paddingHorizontal: spacing[5],
      paddingTop: spacing[3],
      paddingBottom: spacing[2],
      borderTopWidth: 1,
      borderTopColor: p.border,
    },
    clientTrigger: {
      flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
      gap: spacing[2], paddingVertical: spacing[3],
    },
    clientResultRowNew: { borderBottomWidth: 2, borderBottomColor: p.border, marginBottom: 2 },
    clientSelectedTag: {
      flexDirection: 'row', alignItems: 'center', gap: spacing[3],
      backgroundColor: `${p.primary}12`,
      borderRadius: radius.md, paddingHorizontal: spacing[4], paddingVertical: spacing[3],
      borderWidth: 1, borderColor: `${p.primary}30`,
    },
    clientSearchRow: {
      flexDirection: 'row', alignItems: 'center',
      paddingHorizontal: spacing[3], paddingVertical: spacing[2],
      borderWidth: 1, borderColor: p.border, borderRadius: radius.md,
      backgroundColor: p.surface, marginBottom: spacing[1],
    },
    clientSearchInput: { flex: 1, fontSize: 15, color: p.textPrimary, paddingVertical: 0 },
    clientResultRow: {
      flexDirection: 'row', alignItems: 'center', gap: spacing[3],
      paddingVertical: spacing[3], paddingHorizontal: spacing[1],
      borderBottomWidth: 1, borderBottomColor: p.border,
    },
    clientAvatar: { width: 40, height: 40, borderRadius: 20, justifyContent: 'center', alignItems: 'center' },
    clientAvatarText: { fontSize: 16, fontWeight: '700', color: p.textPrimary },

    methodSection: { paddingHorizontal: spacing[5], paddingTop: spacing[3], paddingBottom: spacing[4], gap: spacing[2] },
    sectionLabel: { marginBottom: spacing[2] },
    methodGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing[3] },
    methodChip: {
      flex: 1, alignItems: 'center', justifyContent: 'center',
      paddingVertical: spacing[3], paddingHorizontal: spacing[2],
      minHeight: 56,
      borderRadius: radius.md, borderWidth: 1.5, borderColor: p.border,
      backgroundColor: p.surface, minWidth: '45%',
    },
    methodChipActive: { backgroundColor: p.primary, borderColor: p.primary },

    amountBigInput: {
      fontSize: 28, fontWeight: '700', color: p.textPrimary,
      borderBottomWidth: 2, borderBottomColor: p.primary,
      paddingVertical: spacing[2], textAlign: 'center',
    },

    disambigBox: {
      marginTop: spacing[1], gap: 0,
    },
    radioRow: {
      flexDirection: 'row', alignItems: 'center', gap: spacing[3],
      paddingVertical: spacing[3],
    },
    radioSeparator: { height: StyleSheet.hairlineWidth, backgroundColor: p.border, marginLeft: 22 + spacing[3] },
    radio: { width: 20, height: 20, borderRadius: 10, borderWidth: 1.5, borderColor: p.border, alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
    radioActive: { borderColor: p.primary, backgroundColor: p.primary },
    radioDot: { width: 7, height: 7, borderRadius: 3.5, backgroundColor: p.textInverse },
    warnRow: {
      backgroundColor: p.warningLight, borderRadius: radius.md,
      padding: spacing[3], borderWidth: 1, borderColor: p.warning,
    },

    variantSheet: {
      position: 'absolute', bottom: 0, left: 0, right: 0,
      backgroundColor: p.surface, borderTopLeftRadius: 24, borderTopRightRadius: 24,
      paddingHorizontal: spacing[5], paddingTop: spacing[4], paddingBottom: spacing[10],
      maxHeight: '70%',
      shadowColor: p.shadow, shadowOffset: { width: 0, height: -4 },
      shadowOpacity: 0.14, shadowRadius: 16, elevation: 12,
    },
    variantSheetHandle: {
      width: 40, height: 4, borderRadius: 2, backgroundColor: p.border,
      alignSelf: 'center', marginBottom: spacing[4],
    },
    variantOption: {
      flexDirection: 'row', alignItems: 'center',
      paddingVertical: spacing[4],
      borderBottomWidth: 1, borderBottomColor: p.border,
    },
  });
}
