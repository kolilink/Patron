import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import {
  Alert,
  Animated,
  Easing,
  FlatList,
  InputAccessoryView,
  Keyboard,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleProp,
  StyleSheet,
  TextInput,
  View,
  ViewStyle,
} from 'react-native';
import { captureRef } from 'react-native-view-shot';
import * as Sharing from 'expo-sharing';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Screen } from '@/src/components/ui/Screen';
import { FormSheet } from '@/src/components/ui/FormSheet';
import { Ionicons } from '@expo/vector-icons';
import { Button } from '@/src/components/ui/Button';
import { NoResultsState } from '@/src/components/ui/NoResultsState';
import { Card } from '@/src/components/ui/Card';
import { Input } from '@/src/components/ui/Input';
import { Text } from '@/src/components/ui/Text';
import { PhoneInput } from '@/src/components/ui/PhoneInput';
import { SaleReceiptView, type ReceiptData, type ReceiptItem } from '@/src/components/ui/SaleReceiptView';
import { useTheme, radius, spacing, shadow, fontFamily, FLOATING_TAB_BAR_CLEARANCE, CLIENT_AVATAR_PALETTE, SEARCH_VISIBILITY_THRESHOLD } from '@/src/theme';
import { useAnimateLayoutChange } from '@/src/hooks/useAnimateLayoutChange';
import { useQuickClients } from '@/src/hooks/useQuickClients';
import { CreditRapideCapture } from '@/src/components/CreditRapideCapture';
import { QuickCaptureSheet } from '@/src/components/QuickCaptureSheet';
import type { Palette } from '@/src/theme';
import { formatAmount, formatAmountInput, parseAmountInput } from '@/src/utils/format';
import { todayIso } from '@/src/utils/dates';
import type { Product, ProductVariant } from '@/src/types';
import { useAuthStore } from '@/stores/auth';
import { useProductStore } from '@/stores/products';
import { OfflineNotice } from '@/src/components/ui/OfflineNotice';
import type { CartLine, SalePayment } from '@/stores/sales';
import { useSalesStore } from '@/stores/sales';
import { useVentesStore } from '@/stores/ventes';
import { supabase } from '@/lib/supabase';
import { getKV, setKV } from '@/lib/db';
import { haptics } from '@/lib/haptics';
import { toast } from '@/stores/toast';
import { SkeletonList } from '@/src/components/ui/SkeletonPlaceholder';
import { trackEvent } from '@/lib/analytics';

// Product tiles show the bare number — the currency is declared once above
// the grid instead of repeated on every card. Reuses formatAmount's own
// locale-correct number formatting (it always ends in " " + currency)
// rather than duplicating its whole-unit-vs-decimal currency branching here.
function formatPriceValue(amount: number, currency: string) {
  return formatAmount(amount, currency).slice(0, -(currency.length + 1));
}

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

// Final payment methods: Wave removed.
// 'mtn' is labeled "Mobile Money" in the UI (consolidates old mtn/moov).
const PAY_NOW_METHODS = [
  { key: 'especes' as const, label: 'Espèces' },
  { key: 'orange' as const, label: 'Orange Money' },
  { key: 'mtn' as const, label: 'Mobile Money' },
  { key: 'digital' as const, label: 'Autre' },
];

// The cart panel's own quick-checkout chips — deliberately a narrower list
// than PAY_NOW_METHODS (no "Autre"): this row exists so the merchant can see
// and correct the assumed payment method before a one-tap "Encaisser"
// submits directly, and "Autre" has no natural pre-selected meaning to
// default to. A sale actually paid by some other means still reaches
// PaymentModal via "ou enregistrer à crédit" → the Vente step there, which
// keeps every PAY_NOW_METHODS option including Autre.
const QUICK_PAY_METHODS = PAY_NOW_METHODS.filter(m => m.key !== 'digital');

// On-device rolling history of the last N quick-checkout payment methods,
// per business — used purely to pick which chip is pre-selected. Local and
// per-device on purpose: no new RPC/migration needed, and it's cheap to get
// this slightly wrong (worst case, the merchant taps a different chip once).
// A single business with multiple staff phones could see each device settle
// on a different default — acceptable for now; making it consistent across
// devices would mean reading real `payments` history server-side instead,
// a real but separate upgrade if this ever needs it.
const QUICK_PAY_HISTORY_LEN = 20;
function quickPayHistoryKey(businessId: string) {
  return `quick_pay_history_${businessId}`;
}
async function loadDefaultQuickPayMethod(businessId: string): Promise<'especes' | 'orange' | 'mtn'> {
  try {
    const raw = await getKV(quickPayHistoryKey(businessId));
    const history: string[] = raw ? JSON.parse(raw) : [];
    if (history.length === 0) return 'especes';
    const counts = new Map<string, number>();
    for (const m of history) counts.set(m, (counts.get(m) ?? 0) + 1);
    let best: string = 'especes';
    let bestCount = 0;
    for (const [m, c] of counts) if (c > bestCount) { best = m; bestCount = c; }
    return (best === 'orange' || best === 'mtn') ? best : 'especes';
  } catch {
    return 'especes';
  }
}
async function recordQuickPayMethodUsed(businessId: string, method: string) {
  try {
    const raw = await getKV(quickPayHistoryKey(businessId));
    const history: string[] = raw ? JSON.parse(raw) : [];
    history.push(method);
    await setKV(quickPayHistoryKey(businessId), JSON.stringify(history.slice(-QUICK_PAY_HISTORY_LEN)));
  } catch {
    // Best-effort — a failed write just means the default doesn't adapt this
    // time, never something the merchant needs to see or retry.
  }
}

// iOS-only: number-pad/decimal-pad keyboards have no built-in return key, so
// the OS auto-injects its own floating "Done" pill unless something else
// claims that accessory slot. Every numeric field below already sits next to
// a persistent, always-visible action button (the cart's "Encaisser", the
// credit form's "Ajouter", the variant sheet's "Confirmer", the payment
// modal's confirm button) — a keyboard "Done" would just repeat it, so these
// are blank/linked accessories that suppress the OS pill without showing
// anything. Each Modal/screen needs its own, since InputAccessoryView must
// live in the same native window as the field referencing it.
const VENDRE_SILENT_ACCESSORY_ID = 'vendre-screen-silent-accessory';
const VARIANT_SHEET_SILENT_ACCESSORY_ID = 'vendre-variant-sheet-silent-accessory';
const PAYMENT_SILENT_ACCESSORY_ID = 'vendre-payment-modal-silent-accessory';

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
              <Text variant="caption" style={{ color: line.is_bulk ? palette.textInverse : palette.textSecondary, fontFamily: fontFamily.bold }}>
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
            inputAccessoryViewID={Platform.OS === 'ios' ? VENDRE_SILENT_ACCESSORY_ID : undefined}
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
  const clientSearchRef = useRef<TextInput>(null);
  const modalScrollRef = useRef<ScrollView>(null);
  // Clients are only needed once the user opens the client section (credit
  // sales or "Nom du client") — most sales are plain cash and never touch it,
  // so fetching them unconditionally on every modal open wastes two Supabase
  // round trips on the hottest screen in the app.
  const clientsLoadedRef = useRef(false);

  // ── "Ou enregistrer à crédit" flow — Qui first, terms second ──────────
  // Deliberately its own state, not sharing showClientSection/clients above
  // (that older shared section is only ever reached today via step==='pay''s
  // short-payment "Un crédit" disambiguation — no call site opens this modal
  // with initialStep 'pay' any more since handleQuickEncaisser bypasses it
  // entirely, but it's left untouched rather than assumed dead). "client" is
  // always the first phase on a fresh open, matching the design brief's
  // three-tap target: pick a client, read the agreement, confirm.
  type CreditPhase = 'client' | 'newClient' | 'terms';
  const [creditPhase, setCreditPhase] = useState<CreditPhase>('client');
  const [creditSearch, setCreditSearch] = useState('');
  const [creditNewName, setCreditNewName] = useState('');
  const [creditNewPhone, setCreditNewPhone] = useState('');
  // Collapsed by default — "the values exist in the model but do not occupy
  // the screen until changed." A plain boolean per row, not a shared
  // "which row is open" enum, since both can legitimately be open together
  // (a discounted item paid partially up front).
  const [showUpfrontRow, setShowUpfrontRow] = useState(false);
  const [showDiscountRow, setShowDiscountRow] = useState(false);
  const { clients: quickClients } = useQuickClients(businessId, visible);

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
      setCreditPhase('client');
      setCreditSearch('');
      setCreditNewName('');
      setCreditNewPhone('');
      setShowUpfrontRow(false);
      setShowDiscountRow(false);
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

  // step === 'credit' no longer auto-opens this shared section — the
  // dedicated creditPhase machinery above owns client selection for that
  // step now. This section is only ever driven by step==='pay''s own
  // short-payment "Un crédit" disambiguation below.
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

  // "Qui" phase — recognition before recall (useQuickClients ranks by
  // recency), search-first, creation as the fallback.
  const filteredQuickClients = useMemo(() => {
    const q = creditSearch.toLowerCase().trim();
    if (!q) return quickClients;
    return quickClients.filter(c => c.name.toLowerCase().includes(q) || (c.phone ?? '').includes(q));
  }, [quickClients, creditSearch]);

  // Per-client outstanding credit, so the picker's row subtitle can say
  // "doit X USD" instead of showing a raw phone number — a debt status is
  // what a vendor mid-conversation actually needs to recognize a client by,
  // not a number they'd have to cross-reference. Batched once per picker
  // open (one query for every open credit order + one for their payments),
  // not per-row, to avoid an N+1 fetch across the recents list. There is no
  // "avance" (client credit-in-their-favor) concept anywhere in this app's
  // data model yet — that subtitle case has nothing to compute from today.
  const [clientDebtMap, setClientDebtMap] = useState<Record<string, number>>({});
  useEffect(() => {
    if (!(step === 'credit' && creditPhase === 'client')) return;
    let cancelled = false;
    (async () => {
      const { data: orders } = await supabase
        .from('sale_orders')
        .select('id, client_id, total_amount, discount_amount')
        .eq('business_id', businessId)
        .eq('status', 'credit')
        .not('client_id', 'is', null);
      if (!orders?.length) { if (!cancelled) setClientDebtMap({}); return; }
      const orderIds = orders.map((o: { id: string }) => o.id);
      const { data: pays } = await supabase
        .from('payments')
        .select('order_id, amount')
        .in('order_id', orderIds);
      if (cancelled) return;
      const paidByOrder: Record<string, number> = {};
      for (const p of (pays ?? []) as { order_id: string; amount: number }[]) {
        paidByOrder[p.order_id] = (paidByOrder[p.order_id] ?? 0) + p.amount;
      }
      const debtByClient: Record<string, number> = {};
      for (const o of orders as { id: string; client_id: string; total_amount: number; discount_amount: number | null }[]) {
        const remaining = o.total_amount - (o.discount_amount ?? 0) - (paidByOrder[o.id] ?? 0);
        if (remaining > 0.5) debtByClient[o.client_id] = (debtByClient[o.client_id] ?? 0) + remaining;
      }
      setClientDebtMap(debtByClient);
    })();
    return () => { cancelled = true; };
  }, [step, creditPhase, businessId]);

  const creditClientSubtitle = (clientId?: string): { text: string; color: string } => {
    const debtCents = clientId ? clientDebtMap[clientId] : undefined;
    if (debtCents && debtCents > 0.5) {
      return { text: `doit ${formatAmount(debtCents / 100, currency)}`, color: palette.warning };
    }
    return { text: 'rien en cours', color: palette.textSecondary };
  };

  const handleCreditSelectClient = (name: string, phone?: string | null, id?: string) => {
    setClientName(name);
    setClientPhone(phone ?? '');
    setClientId(id);
    setCreditPhase('terms');
    setCreditSearch('');
    Keyboard.dismiss();
  };

  const handleCreditAddNewClient = async () => {
    if (!creditNewName.trim()) return;
    const name = creditNewName.trim();
    const phone = creditNewPhone || null;
    const { data } = await supabase.from('clients').upsert(
      { business_id: businessId, name, phone },
      { onConflict: 'business_id,name' },
    ).select('id').single();
    handleCreditSelectClient(name, phone, data?.id ?? undefined);
  };

  // Back button is phase-aware — "Retour" from a fresh "Choisir le client"
  // closes the whole flow, but from "Changer de client" (reached mid-flow,
  // a client already exists) it should return to the agreement instead of
  // discarding it. Distinguishing the two by whether a client is already
  // set avoids needing a third piece of state just to remember how we got
  // to the client list.
  const handleCreditBack = () => {
    if (creditPhase === 'newClient') { setCreditPhase('client'); return; }
    if (creditPhase === 'client' && clientName.trim().length > 0) { setCreditPhase('terms'); return; }
    onClose();
  };

  const parsedAmount = parseAmountInput(amountInput, currency);
  const shortfall = total - parsedAmount;
  const isShort = shortfall > 0.5;

  const creditDiscount = parseAmountInput(creditDiscountInput, currency);
  const creditUpfront  = parseAmountInput(creditUpfrontInput, currency);
  const creditEffectiveTotal = total - creditDiscount;
  const creditUpfrontCoversAll = creditUpfront >= creditEffectiveTotal - 0.01 && creditUpfront > 0;
  const creditRemaining = Math.max(0, creditEffectiveTotal - creditUpfront);

  // "The interface repeats the real-world agreement: person, amount." No
  // due date in the sentence — this flow doesn't collect a repayment term.
  const creditSentence = (() => {
    const name = clientName.trim() || 'Le client';
    if (creditUpfront > 0 && !creditUpfrontCoversAll) {
      return `${name} paie ${formatAmount(creditUpfront, currency)} maintenant et te devra ${formatAmount(creditRemaining, currency)}.`;
    }
    if (creditUpfrontCoversAll) {
      return `${name} paie ${formatAmount(creditUpfront, currency)} maintenant.`;
    }
    return `${name} te devra ${formatAmount(creditRemaining, currency)}.`;
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
    if (creditUpfront > 0) {
      const payment: SalePayment = { method: creditPayMethod, amount: creditUpfront };
      onConfirm(payment, clientName.trim() || undefined, disc, clientId, null);
    } else {
      onConfirm(null, clientName.trim() || undefined, disc, clientId, null);
    }
  };

  return (
    <FormSheet
      ref={modalScrollRef}
      visible={visible}
      onClose={step === 'credit' ? handleCreditBack : onClose}
      title={step === 'credit'
        ? (creditPhase === 'client' ? 'Choisir le client' : creditPhase === 'newClient' ? 'Nouveau client' : 'Vente à crédit')
        : 'Paiement'}
      cancelLabel="Retour"
      presentationStyle="formSheet"
      // flexGrow lets the zero-clients empty state below center itself
      // vertically in the available space — a no-op for every other phase,
      // whose content already exceeds the viewport.
      contentContainerStyle={{ paddingBottom: spacing[6], flexGrow: 1 }}
      footer={
        step === 'credit' && creditPhase === 'client' ? undefined : (
        <View style={styles.modalFooter}>
          {step === 'credit' && creditPhase === 'newClient' ? (
            <Button
              label="Ajouter et continuer"
              onPress={handleCreditAddNewClient}
              fullWidth
              size="lg"
              disabled={!creditNewName.trim()}
            />
          ) : showNewClientForm ? (
            <Button
              label="Ajouter ce client"
              onPress={handleAddNewClient}
              fullWidth
              size="lg"
              disabled={!newClientName.trim()}
            />
          ) : (
            <Button
              label={submitting ? 'Enregistrement…' : (step === 'credit' ? (creditUpfrontCoversAll ? 'Enregistrer la vente' : 'Enregistrer le crédit') : 'Confirmer la vente')}
              onPress={step === 'credit' ? handleConfirmCredit : handleConfirmPay}
              loading={submitting}
              fullWidth
              size="lg"
              disabled={step === 'credit' ? !canConfirmCredit : !canConfirmPay}
            />
          )}
        </View>
        )
      }
      accessory={
        Platform.OS === 'ios' ? (
          <InputAccessoryView nativeID={PAYMENT_SILENT_ACCESSORY_ID}>
            <View style={{ height: 0 }} />
          </InputAccessoryView>
        ) : undefined
      }
    >
          {step === 'credit' && creditPhase === 'terms' && (
            <View style={styles.totalSection}>
              <Text variant="caption" color="secondary" style={{ textAlign: 'center' }}>Il devra</Text>
              <Text
                style={[styles.totalBig, { color: palette.warning, textAlign: 'center' }]}
                adjustsFontSizeToFit
                numberOfLines={1}
              >
                {formatAmount(creditRemaining, currency)}
              </Text>
            </View>
          )}
          {step === 'pay' && (
            <View style={styles.totalSection}>
              <Text variant="caption" color="secondary" style={{ textAlign: 'center' }}>Total</Text>
              <Text
                style={[styles.totalBig, { color: palette.primary, textAlign: 'center' }]}
                adjustsFontSizeToFit
                numberOfLines={1}
              >
                {formatAmount(total, currency)}
              </Text>
            </View>
          )}

          {/* ── Credit, phase "client": one search field, rendered once,
              never auto-focused (the common case is tapping a recent client
              — opening the keyboard on load would hide that list and cost
              an extra dismiss). Search empty → recents + one "Nouveau
              client" row at the bottom. Typing with matches → just the
              matches. Typing with no match → one "Créer « … »" row, search
              and create collapsed into a single gesture. ── */}
          {/* Two distinct states, not variations of one: hasNoClientsAtAll
              (no search field, no "Clients récents" header — both are false
              affordances when there's nothing to search or list) vs.
              searchHasNoMatch (handled further below, inside the populated
              branch). */}
          {step === 'credit' && creditPhase === 'client' && quickClients.length === 0 && (
            <View style={styles.creditEmptyClients}>
              <View style={styles.creditEmptyIconWrap}>
                <Ionicons name="person-add-outline" size={28} color={palette.textSecondary} />
              </View>
              <Text variant="h4" style={{ textAlign: 'center' }}>Aucun client pour le moment</Text>
              <Text variant="body" color="secondary" style={{ textAlign: 'center' }}>
                Les clients à qui vous faites crédit apparaîtront ici.
              </Text>
              <Button
                label="+ Nouveau client"
                onPress={() => setCreditPhase('newClient')}
                fullWidth
                size="lg"
                style={{ marginTop: spacing[3], alignSelf: 'stretch' }}
              />
            </View>
          )}

          {step === 'credit' && creditPhase === 'client' && quickClients.length > 0 && (
            <View style={styles.payContent}>
              <View style={styles.clientSearchRow}>
                <TextInput
                  value={creditSearch}
                  onChangeText={setCreditSearch}
                  placeholder="Rechercher un client…"
                  placeholderTextColor={palette.textDisabled}
                  style={styles.clientSearchInput}
                  returnKeyType="search"
                  clearButtonMode="while-editing"
                />
              </View>

              {creditSearch.trim().length === 0 ? (
                <>
                  <Text variant="caption" color="secondary" style={{ paddingHorizontal: spacing[2], paddingTop: spacing[2] }}>
                    Clients récents
                  </Text>
                  {quickClients.map(c => {
                    const sum = c.name ? c.name.split('').reduce((acc, ch) => acc + ch.charCodeAt(0), 0) : 0;
                    const avatarBg = CLIENT_AVATAR_PALETTE[sum % CLIENT_AVATAR_PALETTE.length];
                    const initial = c.name ? c.name.charAt(0).toUpperCase() : '?';
                    const subtitle = creditClientSubtitle(c.id);
                    return (
                      <Pressable
                        key={c.id ?? c.name}
                        onPress={() => handleCreditSelectClient(c.name, c.phone, c.id)}
                        style={({ pressed }) => [styles.clientResultRow, pressed && { opacity: 0.55 }]}
                      >
                        <View style={[styles.clientAvatar, { backgroundColor: avatarBg }]}>
                          <Text allowFontScaling={false} style={styles.clientAvatarText}>{initial}</Text>
                        </View>
                        <View style={{ flex: 1 }}>
                          <Text variant="body">{c.name}</Text>
                          <Text variant="caption" style={{ color: subtitle.color }}>{subtitle.text}</Text>
                        </View>
                        <Ionicons name="chevron-forward" size={16} color={palette.textDisabled} />
                      </Pressable>
                    );
                  })}
                  <Pressable
                    onPress={() => setCreditPhase('newClient')}
                    style={({ pressed }) => [styles.clientResultRow, styles.clientResultRowNew, pressed && { opacity: 0.55 }]}
                  >
                    <Ionicons name="add-circle-outline" size={16} color={palette.primary} />
                    <Text variant="body" style={{ color: palette.primary, fontFamily: fontFamily.semibold }}>Nouveau client</Text>
                  </Pressable>
                </>
              ) : filteredQuickClients.length > 0 ? (
                filteredQuickClients.map(c => {
                  const sum = c.name ? c.name.split('').reduce((acc, ch) => acc + ch.charCodeAt(0), 0) : 0;
                  const avatarBg = CLIENT_AVATAR_PALETTE[sum % CLIENT_AVATAR_PALETTE.length];
                  const initial = c.name ? c.name.charAt(0).toUpperCase() : '?';
                  const subtitle = creditClientSubtitle(c.id);
                  return (
                    <Pressable
                      key={c.id ?? c.name}
                      onPress={() => handleCreditSelectClient(c.name, c.phone, c.id)}
                      style={({ pressed }) => [styles.clientResultRow, pressed && { opacity: 0.55 }]}
                    >
                      <View style={[styles.clientAvatar, { backgroundColor: avatarBg }]}>
                        <Text allowFontScaling={false} style={styles.clientAvatarText}>{initial}</Text>
                      </View>
                      <View style={{ flex: 1 }}>
                        <Text variant="body">{c.name}</Text>
                        <Text variant="caption" style={{ color: subtitle.color }}>{subtitle.text}</Text>
                      </View>
                      <Ionicons name="chevron-forward" size={16} color={palette.textDisabled} />
                    </Pressable>
                  );
                })
              ) : (
                <Pressable
                  onPress={() => { setCreditNewName(creditSearch.trim()); setCreditPhase('newClient'); }}
                  style={({ pressed }) => [styles.clientResultRow, styles.clientResultRowNew, pressed && { opacity: 0.55 }]}
                >
                  <Ionicons name="add-circle-outline" size={16} color={palette.primary} />
                  <Text variant="body" style={{ color: palette.primary, fontFamily: fontFamily.semibold }}>
                    Créer « {creditSearch.trim()} » comme nouveau client
                  </Text>
                </Pressable>
              )}
            </View>
          )}

          {/* ── Credit, phase "newClient": name only required, phone
              optional, +224 Guinea default (PhoneInput's own fallback). ── */}
          {step === 'credit' && creditPhase === 'newClient' && (
            <View style={[styles.payContent, { gap: spacing[5] }]}>
              <Input
                label="Nom"
                value={creditNewName}
                onChangeText={setCreditNewName}
                placeholder="Mamadou Diallo"
                autoFocus
              />
              <PhoneInput
                label="Téléphone (optionnel)"
                onChange={setCreditNewPhone}
                strict={false}
              />
            </View>
          )}

          {/* ── Credit, phase "terms": the agreement, not a form. Discount
              and partial payment are collapsed rows — "the values exist in
              the model but do not occupy the screen until changed." ── */}
          {step === 'credit' && creditPhase === 'terms' && (
            <View style={styles.payContent}>
              <View style={styles.creditSentenceBox}>
                <Text variant="label" style={{ lineHeight: 20 }}>{creditSentence}</Text>
              </View>

              {creditUpfrontCoversAll && (
                <View style={styles.warnRow}>
                  <Text variant="caption" style={{ color: palette.warning }}>
                    Payé en entier — pas de crédit.
                  </Text>
                </View>
              )}

              <Pressable onPress={() => setShowUpfrontRow(v => !v)} style={styles.creditCollapsedRow}>
                <Text variant="body">Encaisser une partie</Text>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing[2] }}>
                  {creditUpfront > 0 && (
                    <Text variant="body" color="secondary">{formatAmount(creditUpfront, currency)}</Text>
                  )}
                  <Ionicons
                    name={creditUpfront > 0 ? 'chevron-forward' : 'add'}
                    size={18}
                    color={creditUpfront > 0 ? palette.primary : palette.textSecondary}
                  />
                </View>
              </Pressable>
              {showUpfrontRow && (
                <View style={{ gap: spacing[3] }}>
                  <TextInput
                    style={styles.amountBigInput}
                    value={creditUpfrontInput}
                    onChangeText={v => setCreditUpfrontInput(formatAmountInput(v, currency))}
                    keyboardType="decimal-pad"
                    placeholder="0"
                    placeholderTextColor={palette.textDisabled}
                    selectTextOnFocus
                    autoFocus
                    inputAccessoryViewID={Platform.OS === 'ios' ? PAYMENT_SILENT_ACCESSORY_ID : undefined}
                  />
                  {creditUpfront > 0 && (
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
                  )}
                </View>
              )}

              <Pressable onPress={() => setShowDiscountRow(v => !v)} style={styles.creditCollapsedRow}>
                <Text variant="body">Ajouter une réduction</Text>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing[2] }}>
                  {creditDiscount > 0 && (
                    <Text variant="body" color="secondary">{formatAmount(creditDiscount, currency)}</Text>
                  )}
                  <Ionicons
                    name={creditDiscount > 0 ? 'chevron-forward' : 'add'}
                    size={18}
                    color={creditDiscount > 0 ? palette.primary : palette.textSecondary}
                  />
                </View>
              </Pressable>
              {showDiscountRow && (
                <TextInput
                  style={styles.amountBigInput}
                  value={creditDiscountInput}
                  onChangeText={v => setCreditDiscountInput(formatAmountInput(v, currency))}
                  keyboardType="decimal-pad"
                  placeholder="0"
                  placeholderTextColor={palette.textDisabled}
                  selectTextOnFocus
                  autoFocus
                  inputAccessoryViewID={Platform.OS === 'ios' ? PAYMENT_SILENT_ACCESSORY_ID : undefined}
                />
              )}

              <Pressable onPress={() => { setCreditSearch(''); setCreditPhase('client'); }} style={styles.creditTermsClientRow}>
                {(() => {
                  const sum = clientName ? clientName.split('').reduce((acc, ch) => acc + ch.charCodeAt(0), 0) : 0;
                  const avatarBg = CLIENT_AVATAR_PALETTE[sum % CLIENT_AVATAR_PALETTE.length];
                  const initial = clientName ? clientName.charAt(0).toUpperCase() : '?';
                  return (
                    <View style={[styles.clientAvatar, { backgroundColor: avatarBg }]}>
                      <Text allowFontScaling={false} style={styles.clientAvatarText}>{initial}</Text>
                    </View>
                  );
                })()}
                <View style={{ flex: 1 }}>
                  <Text variant="label">{clientName}</Text>
                  <Text variant="caption" color="secondary">Changer de client</Text>
                </View>
                <Ionicons name="chevron-forward" size={16} color={palette.textDisabled} />
              </Pressable>
            </View>
          )}

          {step === 'pay' && !showClientSection && (
            <View style={styles.payContent}>
              <View style={{ gap: spacing[2] }}>
                <Text variant="label" style={styles.sectionLabel}>Payé par le client</Text>
                <TextInput
                  style={styles.amountBigInput}
                  value={amountInput}
                  onChangeText={handleAmountChange}
                  keyboardType="decimal-pad"
                  placeholder={String(total)}
                  placeholderTextColor={palette.textDisabled}
                  selectTextOnFocus
                  inputAccessoryViewID={Platform.OS === 'ios' ? PAYMENT_SILENT_ACCESSORY_ID : undefined}
                />

                {isShort && (
                  <View style={styles.disambigBox}>
                    <Text variant="caption" style={{ color: palette.textSecondary }}>
                      <Text style={{ color: palette.textPrimary, fontFamily: fontFamily.semibold }}>{formatAmount(shortfall, currency)}</Text>
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

          {/* ── Inline client section — step==='pay''s short-payment "Un
              crédit" disambiguation only; step==='credit' has its own
              dedicated Qui/Terms flow above and must never also render
              this, or client selection appears twice. ── */}
          {step === 'pay' && (
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
                      <Text variant="body" style={{ color: palette.primary, fontFamily: fontFamily.semibold }}>Nouveau client</Text>
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
                              <Text allowFontScaling={false} style={styles.clientAvatarText}>{initial}</Text>
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
          )}
    </FormSheet>
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
  /** Only meaningful when product.has_variants — undefined while still loading. */
  variants?: ProductVariant[];
}

function ProductTile({ product, currency, onAdd, onAddBulk, cartQty, cartBulkQty, variants }: ProductTileProps) {
  const { palette } = useTheme();
  const styles = useMemo(() => makeStyles(palette), [palette]);
  const totalInCart = cartQty + cartBulkQty;
  // Variant products always have stock_qty=0 on the parent, so that field alone
  // can't say whether the product is out of stock — a product whose every
  // variant is at 0 must still show/behave as out-of-stock here, or the tile
  // stays tappable and opens a picker where nothing can actually be added.
  // `variants` undefined (not loaded yet) intentionally reads as "not out of
  // stock" — same fail-open default the grid's own filtering already uses —
  // rather than flashing every tile as unavailable while variants load.
  const outOfStock = product.has_variants
    ? !!(variants && variants.length > 0 && variants.every(v => v.stock_qty <= 0))
    : product.stock_qty - totalInCart <= 0;
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
          <Text variant="caption" style={{ color: palette.textInverse, fontFamily: fontFamily.bold }}>{totalInCart}</Text>
        </View>
      )}
      {hasBulk && (
        <View style={styles.tileGrosBadge}>
          <Text variant="caption" style={{ color: palette.warning, fontSize: 9 }}>GROS</Text>
        </View>
      )}
      <Text variant="label" numberOfLines={2} style={styles.tileName}>{product.name}</Text>
      {!product.has_variants ? (
        <Text variant="caption" color="secondary" numberOfLines={1}>
          {outOfStock ? 'Fini' : `${product.stock_qty - totalInCart} ${product.unit}`}
        </Text>
      ) : outOfStock ? (
        <Text variant="caption" color="secondary" numberOfLines={1}>Fini</Text>
      ) : null}
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
        <Text variant="label" style={[styles.tilePrice, outOfStock && { color: palette.textDisabled }]}>
          {formatPriceValue(product.sale_price, currency)}
        </Text>
        {product.has_variants && (
          <Text style={{ color: palette.primary, fontSize: 16 }}>›</Text>
        )}
      </View>
      {hasBulk && product.bulk_price ? (
        <Text variant="caption" style={{ color: palette.warning }}>
          Gros: {formatPriceValue(product.bulk_price, currency)}
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
  // Tracks which product's quantities `qtys` currently holds, so closing
  // this sheet without confirming — a backdrop tap, switching apps, the
  // sheet dismissing some other way — and reopening it for the SAME
  // product keeps whatever was already typed in, instead of restarting
  // from zero. A plain "reset every time `visible` flips true" (the old
  // behavior) couldn't tell "reopened the same picker" apart from "opened
  // a different product's picker", so it wiped both cases the same way.
  const qtysForProductId = useRef<string | null>(null);

  useEffect(() => {
    if (visible) {
      if (product && product.id !== qtysForProductId.current) {
        setQtys({});
        qtysForProductId.current = product.id;
      }
      setEditingId(null);
      Animated.spring(translateY, { toValue: 0, useNativeDriver: true, bounciness: 4 }).start();
    } else {
      translateY.setValue(400);
    }
  }, [visible, product]);

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
    // These quantities are now spent into the cart — a later reopen for
    // this same product should start blank, not show what was just added
    // as if it were still an unconfirmed draft.
    setQtys({});
    onClose();
  };

  return (
    <Modal
      visible={visible}
      transparent
      animationType="none"
      onRequestClose={onClose}
      statusBarTranslucent
      navigationBarTranslucent
    >
      <Pressable style={StyleSheet.absoluteFill} onPress={onClose}>
        <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.45)' }} />
      </Pressable>
      <Animated.View style={[styles.variantSheet, { transform: [{ translateY }] }]}>
        <View style={styles.variantSheetHandle} />
        <View style={{ marginBottom: spacing[4] }}>
          <Text variant="h4">{product.name}</Text>
        </View>
        {/* flex:1 is load-bearing — without it, a ScrollView inside a
            maxHeight-constrained parent (styles.variantSheet, maxHeight:
            '70%') doesn't get a bounded region to scroll within: it just
            renders its full content height and gets silently clipped by
            the parent, with no working internal scroll at all. This is why
            scrolling stopped working the moment a product had enough
            variants to overflow the sheet. */}
        <ScrollView style={{ flex: 1 }} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
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
              <Pressable
                key={v.id}
                onPress={() => {
                  if (!outOfStock && !atMax && !isEditing) {
                    haptics.selection();
                    changeQty(v.id, 1, remaining);
                  }
                }}
                style={[styles.variantOption, outOfStock && { opacity: 0.4 }]}
              >
                <View style={{ flex: 1 }}>
                  <Text variant="body" style={{ fontFamily: fontFamily.semibold }}>{v.name}</Text>
                  <Text variant="label" style={{ color: palette.primary }}>
                    {formatAmount(v.sale_price, currency)}
                  </Text>
                  <Text variant="caption" color="secondary">
                    {outOfStock ? 'Fini' : `${remaining} en stock`}
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
                      inputAccessoryViewID={Platform.OS === 'ios' ? VARIANT_SHEET_SILENT_ACCESSORY_ID : undefined}
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
              </Pressable>
            );
          })}
        </ScrollView>
        <View style={{ paddingTop: spacing[4] }}>
          <Button
            label="Confirmer"
            onPress={confirm}
            fullWidth
            size="lg"
            disabled={totalAdded === 0}
          />
        </View>
      </Animated.View>
      {Platform.OS === 'ios' && (
        <InputAccessoryView nativeID={VARIANT_SHEET_SILENT_ACCESSORY_ID}>
          <View style={{ height: 0 }} />
        </InputAccessoryView>
      )}
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
  const insets = useSafeAreaInsets();
  const session = useAuthStore(s => s.session);
  const business = session?.activeBusiness;
  const userId = session?.user.id ?? '';
  const businessId = business?.id ?? '';
  const currency = business?.currency ?? 'GNF';
  const role = session?.activeMembership?.role;
  const isVendeur = role === 'vendeur';

  const { products: allProducts, vendeurProductScope, variantsByProduct, loading, offline, offlineSince, fetchProducts, fetchVariants } = useProductStore();

  // Apply vendeur product scope (empty = unscoped, sees everything)
  const products = useMemo(() => {
    if (!isVendeur || vendeurProductScope.length === 0) return allProducts;
    return allProducts.filter(p => vendeurProductScope.includes(p.id));
  }, [allProducts, vendeurProductScope, isVendeur]);
  const { cart, submitting, error: saleError, addToCart, addToCartVariant, removeFromCart, setQty, toggleBulk, clearCart, submitSale, submitCarnetDebt, clearError } =
    useSalesStore();

  // ActivationForkOverlay's "Une dette" button links here with ?mode=credit
  // so a brand-new merchant lands straight in the credit tab instead of the
  // product grid — same direct-open pattern catalogue.tsx's ?openForm=1 uses.
  // ActivationForkOverlay's "Une dette" button links here with ?mode=credit
  // so a brand-new merchant lands straight in the credit tab instead of the
  // product grid — same direct-open pattern catalogue.tsx's ?openForm=1 uses.
  // Vendre is a tab screen and stays mounted after the first visit, so a
  // useState initializer only ever applies the very first time — every
  // later "Une dette" tap re-delivers the same param to an already-mounted
  // screen and got silently ignored, leaving mode stuck on whatever it was
  // last (usually 'vente'). This effect re-applies it on every fresh
  // arrival, not just mount, then clears the param the same way
  // catalogue.tsx clears openForm.
  const { mode: initialMode } = useLocalSearchParams<{ mode?: string }>();
  const [mode, setMode] = useState<'vente' | 'credit'>(initialMode === 'credit' ? 'credit' : 'vente');
  // Vendre is a tab root — normally there's nothing to "go back" to, you
  // just tap a different tab. Arriving here via a push from the fork breaks
  // that assumption (no swipe-back, no visible way out) without an explicit
  // back affordance, so show one for the rest of this screen's lifetime
  // once we know that's how we got here — not just while mode === 'credit',
  // since switching back to Vente shouldn't strand them either.
  const [cameFromFork, setCameFromFork] = useState(false);
  useEffect(() => {
    if (initialMode === 'credit') {
      setMode('credit');
      setCameFromFork(true);
      router.setParams({ mode: undefined });
    }
  }, [initialMode]);

  // The activation fork (app/(app)/_layout.tsx) only knows to stay away for
  // a fixed ~1.2s after the "Une dette" tap that can land here — enough to
  // bridge the navigation, not enough to actually fill in a name, phone,
  // and amount. Suppress it for as long as credit mode is genuinely active
  // instead (same fix as catalogue.tsx's add-product form and
  // QuickCaptureSheet), and deliberately ONLY credit mode — switching to
  // Vente without finishing the debt should still bring the wall back,
  // since at that point nothing is actively in progress.
  //
  // useFocusEffect, not a plain useEffect — Vendre is a TAB, and tabs don't
  // unmount when you switch away to a different one, they just go inactive.
  // A plain useEffect's cleanup only re-runs when `mode` itself changes, so
  // leaving via the tab bar (Catalogue, Accueil, ...) while still in credit
  // mode never triggered it at all — suppressActivationFork stayed stuck
  // true forever, on every other screen, until mode happened to change
  // again. useFocusEffect's cleanup additionally fires on losing focus,
  // which switching tabs genuinely is.
  useFocusEffect(
    useCallback(() => {
      useAuthStore.setState({ suppressActivationFork: mode === 'credit' });
      return () => { useAuthStore.setState({ suppressActivationFork: false }); };
    }, [mode]),
  );

  const [search, setSearch] = useState('');
  const [showPayment, setShowPayment] = useState(false);
  const [payStep, setPayStep] = useState<PayStep>('pay');
  const [showConfirmSheet, setShowConfirmSheet] = useState(false);
  // Whether the sale just confirmed was queued offline rather than synced —
  // same confirm+share sheet either way, just a small "en attente" badge.
  const [confirmQueued, setConfirmQueued] = useState(false);
  // The just-confirmed sale's id, so "Annuler la vente" on the confirm sheet
  // can cancel it directly, in the same modal — no second dialog to open.
  // null for a queued/offline sale (no server row yet to cancel).
  const [confirmSaleId, setConfirmSaleId] = useState<string | null>(null);
  const [variantPickerProduct, setVariantPickerProduct] = useState<Product | null>(null);
  const [lastReceipt, setLastReceipt] = useState<ReceiptData | null>(null);
  const receiptViewRef = useRef<View>(null);
  const pendingReceiptRef = useRef<ReceiptData | null>(null);
  const cartScrollRef = useRef<ScrollView>(null);
  const cartRowOffsets = useRef<Record<string, number>>({});

  // Quick-checkout — just the visible, pre-selected payment method chip now.
  // This used to also carry its own inline post-sale confirmation
  // (quickSaleResult) with its own "Annuler", extending cartPanel's mount
  // condition open for it — removed on direct feedback: the full confirm
  // sheet below already shows the amount AND has its own "Annuler la
  // vente" (added the same night), so the inline block wasn't avoiding
  // duplication, it was a second, weaker path missing the one thing the
  // full sheet offers that it didn't — sharing the receipt. One
  // confirmation surface for every sale, quick or not.
  const [quickPayMethod, setQuickPayMethod] = useState<'especes' | 'orange' | 'mtn'>('especes');
  // The product grid needs to reserve exactly this much bottom padding so
  // its last row can scroll clear of the floating cartPanel sitting on top
  // of it — measured via onLayout on the panel itself, not a hardcoded
  // guess. The panel's real height moves with cart size (its own scroll
  // area caps at 160px) and with whatever's in its footer, so a fixed
  // number only stays correct until the next time either changes — which
  // is exactly what happened here (adding the payment chips + a bigger
  // button label grew the footer past what "300" was ever tuned against).
  // 220 is a rough floor (footer alone, one cart line) for the one frame
  // before onLayout fires on a fresh cart — not a return to guessing, just
  // avoiding a one-frame flash of the exact bug this is fixing; onLayout
  // overwrites it with the real number immediately after.
  const [cartPanelHeight, setCartPanelHeight] = useState(220);
  // Full itemized cart ("Panier") — the Dock summary below only ever shows
  // the last item added plus a count of the rest, so the panel's own height
  // never grows with the cart; this sheet is where a merchant actually edits
  // quantities/removes lines when they need to. Auto-closes if the cart
  // empties out from under it (last line removed while the sheet is open)
  // rather than being left open showing nothing to act on.
  const [showCartSheet, setShowCartSheet] = useState(false);
  useEffect(() => {
    if (cart.length === 0) setShowCartSheet(false);
  }, [cart.length]);
  // Rapid capture sheet, Vente mode — reached from the empty-catalog state's
  // "Vente rapide" button below. Vendre's own Vente mode is the full cart/
  // product-picker POS flow; this is the separate amount-only quick sale
  // (VenteRapideCapture), so it needs its own sheet instance here rather
  // than reusing anything already on this screen.
  const [showQuickCapture, setShowQuickCapture] = useState(false);
  // Guards the confirm sheet's auto-dismiss (below) against racing a
  // still-in-flight share — captureRef/Sharing.shareAsync need the sheet's
  // Modal to stay mounted until they finish, not close out from under them.
  const [sharingReceipt, setSharingReceipt] = useState(false);
  const cancelSale = useVentesStore(s => s.cancelSale);

  useEffect(() => {
    if (!businessId) return;
    loadDefaultQuickPayMethod(businessId).then(setQuickPayMethod);
  }, [businessId]);

  const membershipId = session?.activeMembership?.id;

  useEffect(() => {
    if (businessId) fetchProducts(businessId, userId, membershipId, role);
  }, [businessId]);

  useEffect(() => {
    if (!businessId || products.length === 0) return;
    products.filter(p => p.has_variants && !variantsByProduct[p.id])
      .forEach(p => fetchVariants(p.id, businessId));
  }, [products, businessId]);

  // Search is shown once the catalog is big enough to need it (see the render
  // below) — only relevant in Vente mode, since Crédit has no product grid.
  const searchVisible = mode === 'vente' && products.length >= SEARCH_VISIBILITY_THRESHOLD;
  useAnimateLayoutChange(searchVisible);
  // Clear any typed query when the box disappears, so a stale filter can't
  // keep silently narrowing the grid with no visible input left to clear it.
  useEffect(() => {
    if (!searchVisible) setSearch('');
  }, [searchVisible]);

  // Variant stock can change from another device or the offline queue while this
  // screen stays mounted in the background — refetch on every focus so the cart's
  // stock cap (Math.min against variant.stock_qty) isn't capping against stale data.
  useFocusEffect(
    useCallback(() => {
      if (!businessId) return;
      products.filter(p => p.has_variants).forEach(p => fetchVariants(p.id, businessId));
    }, [businessId, products, fetchVariants])
  );



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

  // Confirm sheet's own entrance/exit motion — deliberately not the Modal's
  // built-in `animationType`, which is a fixed, uncustomizable curve (the
  // reason no amount of retiming alone could make it feel calmer). Same
  // Modal-with-animationType="none" + Animated.View-with-translateY shape
  // VariantPickerSheet already uses for its own entrance below — extended
  // here to also animate the exit, which nothing in this file does yet
  // (VariantPickerSheet's own close is an instant snap, not a real
  // animation; there was no existing "calm close" to copy).
  // Entrance decelerates in (a soft spring, minimal overshoot — this is a
  // money confirmation, not a playful picker, so less bounce than
  // VariantPickerSheet's own bounciness:4). Exit is a slower, symmetric
  // ease — motion-design convention pairs deceleration on the way in with
  // acceleration or a gentle ease on the way out, and RN's default modal
  // slide gives neither. The lever here is the *quality* of the motion, not
  // its raw duration — this doesn't cost meaningfully more time than the
  // abrupt default already took, which matters for a screen used dozens of
  // times a day.
  const confirmSheetY = useRef(new Animated.Value(400)).current;
  const confirmBackdropOpacity = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (showConfirmSheet) {
      confirmSheetY.setValue(400);
      confirmBackdropOpacity.setValue(0);
      Animated.parallel([
        Animated.spring(confirmSheetY, { toValue: 0, useNativeDriver: true, bounciness: 3, speed: 14 }),
        Animated.timing(confirmBackdropOpacity, { toValue: 1, duration: 260, easing: Easing.out(Easing.cubic), useNativeDriver: true }),
      ]).start();
    }
  }, [showConfirmSheet]);
  const closeConfirmSheet = useCallback(() => {
    Animated.parallel([
      Animated.timing(confirmSheetY, { toValue: 400, duration: 380, easing: Easing.inOut(Easing.cubic), useNativeDriver: true }),
      Animated.timing(confirmBackdropOpacity, { toValue: 0, duration: 380, easing: Easing.inOut(Easing.cubic), useNativeDriver: true }),
    ]).start(() => setShowConfirmSheet(false));
  }, []);

  // Confirmation sheet: pre-computed breakdown for lastReceipt
  const confirmNet       = lastReceipt ? lastReceipt.total - (lastReceipt.discountAmount ?? 0) : 0;
  const confirmUpfront   = lastReceipt?.amountPaid ?? 0;
  const confirmRemaining = Math.max(0, confirmNet - confirmUpfront);
  const confirmIsCredit  = lastReceipt
    ? lastReceipt.payment === null || confirmRemaining > 0.01
    : false;

  // Nobody has to actively dismiss "Vente enregistrée" any more, for either
  // outcome — a plain fully-paid sale still gets the short window (it's the
  // common, low-stakes case), and credit/partial-payment sales get a longer
  // one now that "Annuler la vente" below gives them a real, direct way to
  // undo, the same safety net the quick-checkout path already relies on
  // instead of a mandatory second look. Guarded on sharingReceipt so this
  // can never fire mid-capture/mid-share — see handleShareReceipt.
  useEffect(() => {
    if (!showConfirmSheet || sharingReceipt) return;
    const t = setTimeout(() => closeConfirmSheet(), confirmIsCredit ? 7000 : 2200);
    return () => clearTimeout(t);
  }, [showConfirmSheet, confirmIsCredit, sharingReceipt]);

  const cartQtyMap = useMemo(() => {
    const map: Record<string, { unit: number; bulk: number }> = {};
    for (const l of cart) {
      if (!map[l.product.id]) map[l.product.id] = { unit: 0, bulk: 0 };
      if (l.is_bulk) map[l.product.id].bulk += l.qty;
      else map[l.product.id].unit += l.qty;
    }
    return map;
  }, [cart]);

  // Closes the full-cart sheet first (a no-op if it's already closed, e.g.
  // reached from the Dock directly) — PaymentModal is its own full-screen
  // Modal, and having two stacked at once is exactly the "two Modals racing"
  // shape this codebase has been bitten by before (see CLAUDE.md's
  // NotificationPrimer/ActivationForkOverlay note).
  const openCredit = () => { setShowCartSheet(false); setPayStep('credit'); setShowPayment(true); };

  const handleConfirmPayment = useCallback(
    // skipConfirmSheet: the quick-checkout path (handleQuickEncaisser) has
    // its own inline confirmation in cartPanel's footer (quickSaleResult) —
    // without this, every quick sale ALSO popped open this full sheet right
    // behind it, showing the same amount and a second "Annuler" a beat
    // after the first one had already closed. PaymentModal's own confirm
    // button never passes this, so nothing about that path changes.
    async (payment: SalePayment | null, customerName?: string, discountAmount?: number, clientId?: string, dueDate?: string | null, skipConfirmSheet = false) => {
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
        setShowCartSheet(false);
        setSearch('');
        const { lastSubmitQueued: queued, lastSaleId } = useSalesStore.getState();
        if (!queued) fetchProducts(businessId, userId, membershipId, role);
        setConfirmQueued(queued);
        // No real server row yet for a queued (offline) sale — cancel_sale
        // has nothing to target, same rule handleQuickEncaisser follows.
        setConfirmSaleId(queued ? null : (lastSaleId ?? null));
        if (!skipConfirmSheet) setShowConfirmSheet(true);
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

  // The default "Encaisser" tap — no modal, straight to submitSale via the
  // exact same handleConfirmPayment engine the modal's own confirm button
  // calls, just with the assumed payload (full cart total, the pre-selected
  // chip, no discount/client) instead of one built from form state. Reading
  // the store fresh right after awaiting — rather than having
  // handleConfirmPayment return a value — mirrors how it already reports its
  // own outcome to itself (`useSalesStore.getState().lastSubmitQueued`
  // a few lines up), so this doesn't need to change that function's
  // contract at all.
  const handleQuickEncaisser = async () => {
    if (cart.length === 0 || submitting) return;
    const method = quickPayMethod;
    await handleConfirmPayment({ method, amount: cartTotal }, undefined, undefined, undefined, null);
    const { cart: cartAfter } = useSalesStore.getState();
    if (cartAfter.length > 0) return; // failed — handleConfirmPayment already alerted the merchant
    recordQuickPayMethodUsed(businessId, method);
  };

  // Shared between the Dock's own footer and the full-cart sheet's footer —
  // identical content in both places (same payment chips, same "Encaisser"
  // total, same credit link) since both ultimately go through
  // handleQuickEncaisser/openCredit regardless of which one triggered it.
  // The sheet's caller overrides the border/bottom-padding via `styleOverride`
  // since it sits inside its own already-bordered/shadowed footer container.
  const renderCheckoutFooter = (styleOverride?: StyleProp<ViewStyle>) => (
    <View style={[styles.cartFooter, styleOverride]}>
      <View style={styles.payMethodChips}>
        {QUICK_PAY_METHODS.map(m => (
          <Pressable
            key={m.key}
            onPress={() => { haptics.selection(); setQuickPayMethod(m.key); }}
            style={[styles.payMethodChip, quickPayMethod === m.key && styles.payMethodChipActive]}
          >
            <Text
              variant="caption"
              style={{ color: quickPayMethod === m.key ? palette.textInverse : palette.textSecondary, fontFamily: fontFamily.semibold }}
            >
              {m.label}
            </Text>
          </Pressable>
        ))}
      </View>
      <Button
        label={`Encaisser · ${formatAmount(displayTotal, currency)}`}
        onPress={handleQuickEncaisser}
        loading={submitting}
        size="lg"
        fullWidth
        labelStyle={{ fontSize: 19, lineHeight: 24 }}
      />
      <Pressable onPress={openCredit} style={styles.creditLink}>
        <Text variant="caption" style={{ color: palette.primary }}>ou enregistrer à crédit</Text>
      </Pressable>
    </View>
  );

  // Shared by both callers that can cancel a just-submitted sale in place —
  // currently just the full confirm sheet's "Annuler la vente"
  // (handleCancelFromConfirmSheet below), kept as its own function since
  // this is real, load-bearing logic (the actual cancel_sale RPC call +
  // toast + stock refresh) that shouldn't live inline in a JSX handler.
  const cancelJustSubmittedSale = async (saleId: string) => {
    const ok = await cancelSale(saleId, businessId, userId, 'Annulée juste après l\'enregistrement');
    if (ok) {
      toast.success('Vente annulée');
      fetchProducts(businessId, userId, membershipId, role);
    } else {
      toast.warning('Connexion nécessaire pour annuler');
    }
  };

  // "Annuler la vente" on the full confirm sheet — replaces the old plain
  // "Ignorer" dismiss for a synced sale. Cancels right here, in the same
  // modal, instead of closing this sheet and opening a separate one.
  const handleCancelFromConfirmSheet = async () => {
    const saleId = confirmSaleId;
    closeConfirmSheet();
    if (saleId) await cancelJustSubmittedSale(saleId);
  };

  const handleShareReceipt = async () => {
    if (!receiptViewRef.current || !lastReceipt) return;
    // Blocks the confirm sheet's own auto-dismiss (below) for the rest of
    // this call — that timer firing mid-capture/mid-share would close the
    // Modal `captureRef`/`Sharing.shareAsync` still need mounted.
    setSharingReceipt(true);
    try {
      const uri = await captureRef(receiptViewRef, { format: 'png', quality: 1 });
      // Share while modal is still mounted — iOS can present share sheet on top.
      // Close only after the share sheet is dismissed (shareAsync resolves).
      await Sharing.shareAsync(uri, { mimeType: 'image/png', UTI: 'public.png', dialogTitle: 'Partager le reçu' });
      trackEvent('receipt_shared', businessId, userId, {
        is_credit: confirmIsCredit,
      });
      closeConfirmSheet();
    } catch (shareErr) {
      Alert.alert('Impossible de partager le reçu pour l\'instant.');
    } finally {
      setSharingReceipt(false);
    }
  };

  // Gated on mode !== 'credit' — this skeleton is shaped like the product
  // grid because that's the only thing that ever needed to wait on
  // `loading` (the product store's fetch flag). Credit mode never reads
  // products at all, so blocking it behind a product-shaped skeleton was
  // showing unrelated content before the real destination, not a genuine
  // loading state for what was actually about to render.
  if (mode !== 'credit' && loading && products.length === 0) {
    return (
      <Screen tab>
        <SkeletonList count={9} />
      </Screen>
    );
  }

  return (
    <Screen tab>
      {offline && (
        <OfflineNotice
          offlineSince={offlineSince}
          onRetry={() => fetchProducts(businessId, userId, membershipId, role)}
        />
      )}

      {/* Error banner */}
      {saleError ? (
        <Pressable onPress={clearError} style={styles.errorBanner}>
          <Text variant="label" style={{ color: palette.warning }}>{saleError}</Text>
          <Text variant="caption" style={{ color: palette.warning, opacity: 0.7 }}>Appuyer pour fermer</Text>
        </Pressable>
      ) : null}

      {/* Header + mode toggle */}
      {cameFromFork && (
        // router.replace (not back()) deliberately — arriving here is a
        // push into a tab route from a Modal, which may not always leave a
        // real "back" entry in history to pop; replacing straight to
        // Accueil is unambiguous regardless of how that navigation landed.
        <Pressable onPress={() => router.replace('/(app)/(tabs)/')} hitSlop={12} style={{ paddingHorizontal: spacing[5], paddingTop: spacing[2] }}>
          <Text variant="body" color="brand">← Retour</Text>
        </Pressable>
      )}
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
      <View style={[styles.modeToggle, { backgroundColor: palette.background, borderColor: palette.border }]}>
        <Pressable
          style={[styles.modeBtn, mode === 'vente' && { backgroundColor: palette.surface }]}
          onPress={() => setMode('vente')}
        >
          <Text
            variant="label"
            style={{ color: mode === 'vente' ? palette.primary : palette.textSecondary, fontFamily: mode === 'vente' ? fontFamily.bold : fontFamily.semibold }}
          >
            Vente
          </Text>
        </Pressable>
        <Pressable
          style={[styles.modeBtn, mode === 'credit' && { backgroundColor: palette.surface }]}
          onPress={() => setMode('credit')}
        >
          <Text
            variant="label"
            style={{ color: mode === 'credit' ? palette.primary : palette.textSecondary, fontFamily: mode === 'credit' ? fontFamily.bold : fontFamily.semibold }}
          >
            Crédit
          </Text>
        </Pressable>
      </View>

      {/* Crédit rapide — shared with Accueil's "+" (QuickCaptureSheet); see
          CreditRapideCapture for why these used to be two separately-drifting
          implementations and now are one. Conditional rendering here (not a
          Modal's `visible` prop) naturally unmounts/remounts on every
          Vente↔Crédit toggle, which is what gives this a fresh state per
          visit for free. */}
      {mode === 'credit' && (
        <View style={styles.creditTabContent}>
          <CreditRapideCapture
            businessId={businessId}
            userId={userId}
            currency={currency}
            onViewClients={() => router.push({ pathname: '/(app)/clients', params: { filter: 'doivent' } })}
          />
        </View>
      )}

      {/* Empty state — Vente mode, no products yet, offline or vendeur. The
          admin/manager-online case (the real dead end this used to be — see
          the block right below) has its own real content now instead of
          silently relying on this branch's opposite condition. */}
      {mode === 'vente' && products.length === 0 && (offline || isVendeur) && (
        <View style={styles.emptyFull}>
          <Ionicons name={offline ? 'cloud-offline-outline' : 'receipt-outline'} size={48} color={palette.textDisabled} />
          <Text variant="h4">{offline ? 'Catalogue non disponible hors ligne' : 'Point de vente'}</Text>
          <Text variant="body" color="secondary" style={styles.emptyDesc}>
            {offline
              ? 'Ouvrez l\'application en ligne une première fois pour activer le mode hors ligne.'
              : 'Le catalogue est vide — votre responsable prépare les produits.'}
          </Text>
        </View>
      )}

      {/* Empty state — Vente mode, admin/manager, online, no products. Used
          to render literally nothing here (just the small "+" FAB further
          down, easy to miss) — a real dead end: "Enregistrer une vente" from
          Accueil's empty day-card landed here with no way forward except the
          full "Nouveau produit" form. Recording a sale must never require
          creating a catalog product first, so this offers the actual quick
          sale directly, with catalog creation as the explicit second choice,
          not the only one. */}
      {mode === 'vente' && products.length === 0 && !offline && !isVendeur && (
        <View style={styles.emptyFull}>
          <Ionicons name="storefront-outline" size={48} color={palette.textDisabled} />
          <Text variant="h4">Aucun produit pour le moment.</Text>
          <Text variant="body" color="secondary" style={styles.emptyDesc}>
            Pas besoin de catalogue pour vendre.
          </Text>
          <View style={styles.emptyActions}>
            <Button label="Vente rapide" onPress={() => setShowQuickCapture(true)} fullWidth size="lg" />
            <Button
              label="Ajouter un produit"
              variant="ghost"
              onPress={() => router.push({ pathname: '/(app)/(tabs)/catalogue', params: { openForm: '1' } })}
              fullWidth
              size="lg"
            />
          </View>
        </View>
      )}

      {searchVisible && (
        <View style={styles.searchRow}>
          <Input
            placeholder="Rechercher un produit…"
            value={search}
            onChangeText={setSearch}
            placeholderTextColor={palette.textSecondary}
            leftIcon={<Ionicons name="search-outline" size={18} color={palette.textSecondary} />}
          />
        </View>
      )}

      {/* Currency declared once here instead of repeated on every tile's
          price (see formatPriceValue in ProductTile). */}
      {mode === 'vente' && products.length > 0 && (
        <View style={styles.priceHeaderRow}>
          <Text variant="caption" color="secondary">Prix en {currency}</Text>
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
        // The panel doesn't start at the true screen bottom — it floats
        // FLOATING_TAB_BAR_CLEARANCE + spacing[4] above it (to clear the
        // tab bar). cartPanelHeight is the real, load-bearing part (matches
        // the panel's own measured height so nothing overlaps); the rest
        // is margin on top of that, not more overlap-prevention — halved
        // on direct device feedback that the full amount read as a big
        // empty gap, not a small gap. Only the margin is halved, never
        // cartPanelHeight itself, so this can't reintroduce the overlap.
        contentContainerStyle={[styles.tileList, cart.length > 0 && { paddingBottom: cartPanelHeight + (FLOATING_TAB_BAR_CLEARANCE + spacing[4] + spacing[2]) / 2 }]}
        showsVerticalScrollIndicator={false}
        renderItem={({ item }) => (
          <ProductTile
            product={item}
            currency={currency}
            cartQty={cartQtyMap[item.id]?.unit ?? 0}
            cartBulkQty={cartQtyMap[item.id]?.bulk ?? 0}
            variants={variantsByProduct[item.id]}
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
          search.trim() ? <NoResultsState query={search} /> : null
        }
      />}

      {/* Cart panel (floating) — only in Vente mode. A "Dock", not a growing
          list: a fixed-height summary (the last item added, plus how many
          other lines exist) instead of every line rendered inline, so the
          panel's own height stays constant regardless of cart size while
          actively selling — the previous version's per-item rows were real,
          reported visual clutter once a cart had more than one or two
          lines. Rendered as one rounded card (summary row + checkout footer
          together) — an earlier pass had this as a full-bleed strip with a
          hairline divider, which read as a different, leftover container
          language from the rounded product cards above it; the card
          boundary now does all the grouping work on its own. Tapping the
          summary opens the full itemized "Panier" sheet below for
          edits/removal. Post-sale confirmation (amount, share, "Annuler la
          vente") lives entirely in the confirm sheet further down — this
          panel just unmounts on success like it always did, once the cart
          clears. */}
      {mode === 'vente' && cart.length > 0 && (() => {
        const lastLine = cart[cart.length - 1];
        const otherLinesCount = cart.length - 1;
        return (
          <View style={styles.cartPanel} onLayout={e => setCartPanelHeight(e.nativeEvent.layout.height)}>
            <Pressable onPress={() => setShowCartSheet(true)} style={styles.cartSummaryRow} hitSlop={4}>
              <Text variant="label" numberOfLines={1} style={{ flex: 1 }}>
                {lastLine.qty} {lastLine.product.name}{lastLine.variant_name ? ` · ${lastLine.variant_name}` : ''}
                {otherLinesCount > 0 && (
                  <Text variant="label" color="secondary"> et {otherLinesCount} autre{otherLinesCount > 1 ? 's' : ''}</Text>
                )}
              </Text>
              {/* Purple = "taps forward to more," this screen's own rule for
                  a chevron (matches the payment chip/Encaisser fill) — gray
                  undersold this as the only entry point to the full cart. */}
              <Ionicons name="chevron-forward" size={18} color={palette.primary} />
            </Pressable>
            {renderCheckoutFooter()}
          </View>
        );
      })()}

      {/* Full itemized cart — reached by tapping the Dock summary above.
          FormSheet (not a bespoke Modal) since CartRow's quantity edit uses
          a TextInput — see CLAUDE.md's "Form sheets — Android keyboard
          flicker" note on why any Modal with a keyboard field needs its
          statusBarTranslucent/navigationBarTranslucent handling. */}
      <FormSheet
        visible={showCartSheet}
        onClose={() => setShowCartSheet(false)}
        title="Panier"
        cancelLabel="Fermer"
        ref={cartScrollRef}
        keyboardShouldPersistTaps="handled"
        headerRight={
          <Pressable
            onPress={() => Alert.alert('Vider le panier ?', '', [
              { text: 'Annuler', style: 'cancel' },
              { text: 'Vider', style: 'destructive', onPress: clearCart },
            ])}
            style={{ minWidth: 64, alignItems: 'flex-end' }}
          >
            <Text variant="body" color="danger">Vider</Text>
          </Pressable>
        }
        footer={
          <View style={styles.cartSheetFooter}>
            {renderCheckoutFooter({ borderTopWidth: 0, paddingBottom: Math.max(insets.bottom, spacing[5]) })}
          </View>
        }
      >
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
      </FormSheet>

      {/* FAB to add first product — Vente mode, no products, not vendeur.
          Scoped to offline now: the online case has its own explicit
          "Ajouter un produit" button in the empty-state block above, and
          showing both would just duplicate the same action twice on one
          screen. Offline still needs it — that branch's own empty state has
          no button of its own. */}
      {mode === 'vente' && products.length === 0 && !isVendeur && offline && (
        <AnimatedFAB onPress={() => router.push({ pathname: '/(app)/(tabs)/catalogue', params: { openForm: '1' } })} />
      )}

      {/* Vente rapide — reached from the empty-catalog "Vente rapide"
          button above. Reuses the same rapid capture sheet Accueil's "+"
          opens, defaulting straight to Vente mode here since Crédit already
          has its own always-visible tab on this screen. */}
      <QuickCaptureSheet
        visible={showQuickCapture}
        onClose={() => setShowQuickCapture(false)}
        businessId={businessId}
        userId={userId}
        currency={currency}
        initialMode="vente"
      />

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

      {/* Confirm + share sheet — its own spring-in / eased-out motion below
          (confirmSheetY/confirmBackdropOpacity), not the Modal's built-in
          animationType, which is a fixed curve with no room to make the
          exit feel calmer. */}
      <Modal
        visible={showConfirmSheet}
        transparent
        animationType="none"
        onRequestClose={closeConfirmSheet}
        statusBarTranslucent
        navigationBarTranslucent
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
          <Animated.View pointerEvents="auto" style={[StyleSheet.absoluteFill, { backgroundColor: 'rgba(0,0,0,0.45)', opacity: confirmBackdropOpacity }]}>
            <Pressable style={StyleSheet.absoluteFill} onPress={closeConfirmSheet} />
          </Animated.View>
          {/* Sheet — rendered after backdrop, higher z-order, captures its own touches */}
          <Animated.View style={[styles.sheet, { transform: [{ translateY: confirmSheetY }] }]}>
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
              {/* Replaces the old plain "Ignorer" — cancels right here, in
                  this same sheet, instead of closing it to open a separate
                  cancel dialog elsewhere. Falls back to a plain dismiss for
                  a queued/offline sale, which has no server row yet to
                  cancel (confirmSaleId is null in that case). */}
              <Pressable onPress={handleCancelFromConfirmSheet} style={styles.ignorePressable}>
                <Text variant="caption" style={{ color: confirmSaleId ? palette.warning : palette.textSecondary }}>
                  {confirmSaleId ? 'Annuler la vente' : 'Ignorer'}
                </Text>
              </Pressable>
            </View>
          </Animated.View>
        </View>
      </Modal>
      {Platform.OS === 'ios' && (
        <InputAccessoryView nativeID={VENDRE_SILENT_ACCESSORY_ID}>
          <View style={{ height: 0 }} />
        </InputAccessoryView>
      )}
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
      paddingHorizontal: spacing[5], paddingTop: spacing[3], paddingBottom: spacing[2],
    },
    modeToggle: {
      flexDirection: 'row', marginHorizontal: spacing[5], marginBottom: spacing[3],
      borderRadius: radius.md, borderWidth: 1, overflow: 'hidden',
    },
    modeBtn: {
      flex: 1, paddingVertical: spacing[2], alignItems: 'center',
    },
    creditTabContent: {
      paddingHorizontal: spacing[5], paddingBottom: spacing[4],
    },
    searchRow: { paddingHorizontal: spacing[5], paddingBottom: spacing[2] },
    hintBanner: {
      flexDirection: 'row', alignItems: 'center', gap: spacing[2],
      paddingHorizontal: spacing[5], paddingVertical: spacing[2],
      backgroundColor: p.warningLight, borderBottomWidth: 1, borderBottomColor: p.warning,
      marginBottom: spacing[2],
    },

    // Base clearance includes the floating tab bar's own footprint — without
    // this, an empty cart (the common case) left the grid's last row only
    // spacing[6] (24px) clear of a ~88px floating pill. The cart-open case
    // below still fully replaces this with its own cartPanelHeight-based
    // value, so this only fixes the no-cart state.
    tileList: { paddingHorizontal: spacing[5], paddingBottom: spacing[6] + FLOATING_TAB_BAR_CLEARANCE },
    tileRow: { gap: TILE_GAP, marginBottom: TILE_GAP },
    tile: {
      flex: 1, backgroundColor: p.surface, borderRadius: radius.lg,
      borderWidth: 1, borderColor: p.border, padding: spacing[3], gap: spacing[1], position: 'relative',
    },
    tileDisabled: { opacity: 0.45 },
    tileName: { minHeight: 36 },
    // Neutral and tabular — an ordinary price is not an accent moment (see
    // the Vendre visual-refinement brief's color-hierarchy rule).
    tilePrice: { color: p.textPrimary, fontVariant: ['tabular-nums'] as ['tabular-nums'] },
    priceHeaderRow: { paddingHorizontal: spacing[5], alignItems: 'flex-end', paddingBottom: spacing[1] },
    tileBadge: {
      position: 'absolute', top: 8, right: 8, backgroundColor: p.primary,
      borderRadius: radius.full, width: 22, height: 22, alignItems: 'center', justifyContent: 'center', zIndex: 10,
    },
    tileGrosBadge: {
      position: 'absolute', top: 4, right: 4,
      backgroundColor: p.warningLight, borderRadius: radius.sm, paddingHorizontal: 4, paddingVertical: 2,
      borderWidth: 1, borderColor: p.warning,
    },

    // The Dock is one card, not a full-bleed strip — same container language
    // as the product cards above it (rounded, inset, bordered). `left`/
    // `right` sit at the same spacing[4] the Encaisser button already used
    // as its own margin before this was a card, so the button's real
    // on-screen position is unchanged, only now traced by a visible boundary
    // instead of implied by a hairline. No border/shadow direction specific
    // to "docked at the bottom" any more (the old `borderTopWidth` +
    // upward-only shadow) — it floats on all sides now, so it gets the same
    // all-around elevation treatment `Card`'s own `elevated` prop uses.
    cartPanel: {
      position: 'absolute', bottom: FLOATING_TAB_BAR_CLEARANCE + spacing[4], left: spacing[4], right: spacing[4],
      backgroundColor: p.surface, borderRadius: radius.xl, borderWidth: 1, borderColor: p.border,
      overflow: 'hidden', ...shadow.md,
    },
    // The Dock's own one-line summary — deliberately just text + a chevron,
    // no price (the total already lives on the "Encaisser" button directly
    // below, same restraint as cartFooter's own comment on not repeating
    // information twice). No border of its own — the card boundary does all
    // the grouping work; a divider here would fake structure the outer card
    // already provides.
    cartSummaryRow: {
      flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
      paddingHorizontal: spacing[4], paddingVertical: spacing[4], gap: spacing[2],
    },
    // FormSheet's `footer` prop has no styling of its own (see CLAUDE.md's
    // "Form sheets" note) — every screen supplies its own. No padding here:
    // the inner cartFooter (via renderCheckoutFooter's styleOverride) already
    // supplies it, including the insets.bottom-aware bottom edge, since this
    // View renders as a sibling of the sheet's SafeAreaView rather than
    // inside it.
    cartSheetFooter: {
      backgroundColor: p.background,
      ...shadow.md, shadowOffset: { width: 0, height: -2 },
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
    // No border here in the Dock — the card's own outer boundary (cartPanel)
    // already separates the summary row above from this footer; an internal
    // hairline on top of that would fake structure the card already
    // provides. The full-cart sheet's own call site still passes an explicit
    // `borderTopWidth: 0` override too — now redundant, kept as it's still
    // accurate and self-documenting there.
    cartFooter: {
      padding: spacing[4], gap: spacing[3],
    },
    cartTotalRow: {
      flexDirection: 'row', alignItems: 'baseline',
      justifyContent: 'space-between', gap: spacing[3],
    },
    cartTotalAmount: { flexShrink: 1, textAlign: 'right' },
    creditLink: { alignItems: 'center' },
    payMethodChips: { flexDirection: 'row', gap: spacing[2] },
    payMethodChip: {
      flex: 1, alignItems: 'center', paddingVertical: spacing[2],
      borderRadius: radius.full, borderWidth: 1, borderColor: p.border, backgroundColor: p.surface,
    },
    payMethodChipActive: { backgroundColor: p.primary, borderColor: p.primary },

    emptyFull: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing[8], gap: spacing[3] },
    emptyDesc: { textAlign: 'center', maxWidth: 260 },
    emptyActions: { width: '100%', maxWidth: 320, gap: spacing[3], marginTop: spacing[2] },
    // 194 was tuned against the old flush tab bar's flex space; the floating
    // pill no longer reserves that space, so the same clearance is added
    // here too to keep this FAB sitting exactly where it did before.
    fabContainer: { position: 'absolute', bottom: 194 + FLOATING_TAB_BAR_CLEARANCE, right: spacing[4], zIndex: 10 },
    fab: { width: 56, height: 56, borderRadius: radius.full, backgroundColor: p.primary, alignItems: 'center', justifyContent: 'center', shadowColor: p.textPrimary, shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.18, shadowRadius: 8, elevation: 8 },
    // No light-weight DM Sans file exists (see fontFamily in src/theme/typography.ts —
    // only regular/medium/semibold/bold), so the original fontWeight: '300' here was
    // always a no-op even before that was understood — regular is the closest
    // available approximation for a light "+" glyph, and is what actually rendered.
    fabIcon: { fontSize: 28, lineHeight: 32, color: p.textInverse, marginTop: -2 },
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
    totalBig: { fontFamily: fontFamily.bold, fontSize: 36, lineHeight: 50, letterSpacing: -0.5 },

    payContent: { padding: spacing[5], gap: spacing[4] },

    // "Choisir le client" with zero clients — no search field, no list
    // header, just the invitation to create the first one. Centered via the
    // FormSheet's own flexGrow'd content container (see its
    // contentContainerStyle above), not a fixed height guess.
    creditEmptyClients: {
      flex: 1, alignItems: 'center', justifyContent: 'center',
      paddingHorizontal: spacing[8], paddingVertical: spacing[10], gap: spacing[3],
    },
    creditEmptyIconWrap: {
      width: 64, height: 64, borderRadius: 32,
      borderWidth: 1.5, borderColor: p.border,
      alignItems: 'center', justifyContent: 'center',
      marginBottom: spacing[2],
    },

    // "Il devra 340 USD" agreement sentence — a plain, neutral card, not an
    // amber warning box: the big amber number above already carries the
    // "money at risk" signal, so this shouldn't double up on it.
    creditSentenceBox: {
      backgroundColor: p.background, borderRadius: radius.card,
      borderWidth: 1, borderColor: p.border, padding: spacing[4],
    },
    // "Encaisser une partie" / "Ajouter une réduction" — collapsed rows,
    // values shown in place, a plus (unused) or chevron (editable) on the
    // right per the design brief's own anatomy.
    creditCollapsedRow: {
      flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
      paddingVertical: spacing[3],
    },
    creditTermsClientRow: {
      flexDirection: 'row', alignItems: 'center', gap: spacing[3],
      paddingTop: spacing[4], marginTop: spacing[2],
      borderTopWidth: 1, borderTopColor: p.border,
    },

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
    clientAvatarText: { fontFamily: fontFamily.bold, fontSize: 16, color: p.textPrimary },

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
