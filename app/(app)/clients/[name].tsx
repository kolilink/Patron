import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { TRUST_LINE } from '@/src/utils/trustLine';
import { Alert, Animated, InputAccessoryView, Linking, Platform, Pressable, ScrollView, StyleSheet, Text as RNText, TextInput, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { haptics } from '@/lib/haptics';
import { Screen } from '@/src/components/ui/Screen';
import { FormSheet } from '@/src/components/ui/FormSheet';
import { router, useLocalSearchParams } from 'expo-router';
import { Text } from '@/src/components/ui/Text';
import { Button } from '@/src/components/ui/Button';
import { Input } from '@/src/components/ui/Input';
import { DatePickerField } from '@/src/components/ui/DatePickerField';
import { useTheme, spacing, radius, fontFamily } from '@/src/theme';
import type { Palette } from '@/src/theme';
import { useAuthStore } from '@/stores/auth';
import { useVentesStore } from '@/stores/ventes';
import { CreditRapideCapture } from '@/src/components/CreditRapideCapture';
import { supabase } from '@/lib/supabase';
import { formatAmountInput, parseAmountInput, formatAmount } from '@/src/utils/format';
import { useSaveConfirmationStore } from '@/stores/saveConfirmation';
import { repaymentConfirmation } from '@/src/utils/saveConfirmationCopy';
import { paymentOverlayCopy } from '@/src/utils/paymentOverlayCopy';
import { saveClientLedgerCache, getClientLedgerCache, getVentesCache } from '@/lib/db';
import { rebuildPendingOverlay, pendingLedgerPayments, type OverlaySale, type PendingLedgerPayment } from '@/lib/pendingOverlay';
import { isNetworkError, withTimeout } from '@/lib/sync';
import { OfflineNotice } from '@/src/components/ui/OfflineNotice';
import { FailureView } from '@/src/components/ui/FailureView';
import { buildFailure } from '@/src/utils/failure';
import { FAILURE_COPY } from '@/src/utils/failureCopy';
import { generateId } from '@/lib/id';
import { selectClientSales, clientBalance } from '@/src/utils/salesTotals';
import { formatDebtAge, debtAgeTier } from '@/src/utils/clientReminder';
import { DebtReminderSheet } from '@/src/components/DebtReminderSheet';
import type { DebtReceiptInput } from '@/src/utils/debtReceipt';
import { formatDate } from '@/src/utils/dates';

// iOS-only: suppresses the OS's auto-injected floating "Done" pill above
// the numeric keyboard — the payment sheet already has a persistent,
// always-visible "Confirmer le paiement" footer button.
const PAYMENT_SHEET_SILENT_ACCESSORY_ID = 'client-ledger-payment-sheet-silent-accessory';

function fmt(n: number, cur: string) { return formatAmount(n, cur); }

// Maps the shared age tier to this screen's actual palette tokens — kept
// here rather than in clientReminder.ts since that file has no theme context.
function debtAgeColor(days: number, palette: Palette): string {
  const tier = debtAgeTier(days);
  if (tier === 'urgent') return palette.recouvrementOwed;
  if (tier === 'attention') return palette.recouvrementPending;
  return palette.textSecondary;
}

function methodLabel(m: string) {
  if (m === 'especes') return 'Espèces';
  if (m === 'orange') return 'Orange Money';
  if (m === 'mtn' || m === 'moov') return 'Mobile Money';
  return 'Autre';
}

function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const PAY_METHODS = [
  { key: 'especes', label: 'Espèces' },
  { key: 'orange', label: 'Orange Money' },
  { key: 'mtn', label: 'Mobile Money' },
  { key: 'digital', label: 'Autre' },
];

interface ClientRecord { id: string; name: string; phone: string | null; notes: string | null; }
interface LedgerPayment { id: string; order_id: string; method: string; amount: number; date: string; created_at: string; _pending?: true }

// One line on the carnet page — a credit given ("Donné") or a payment
// received ("Reçu"). Built fresh from clientSales + ledgerPayments below,
// never persisted as its own shape.
interface LedgerEntry {
  key: string;
  dateKey: string;
  createdAt: string;
  kind: 'credit' | 'payment';
  amount: number;
  // Second gray line under "Donné" — the sale's real product label, or null
  // for a bare carnet debt (submit_carnet_debt's hidden "Solde reporté"
  // placeholder, which is never shown as if it were a real product).
  saleLabel: string | null;
  method: string | null;
  // Running balance AFTER this entry, in true chronological (creation)
  // order — see ledgerEntries' own comment for why this can't be computed
  // from display order alone.
  reste: number;
  sourceType: 'sale' | 'payment';
  sourceId: string;
}

// ─── Edit Client Modal ────────────────────────────────────────────────────────

function EditModal({
  visible, displayName, record, businessId, userId, onClose, onSaved,
}: {
  visible: boolean; displayName: string; record: ClientRecord | null;
  businessId: string; userId: string;
  onClose: () => void; onSaved: (r: ClientRecord) => void;
}) {
  const { palette } = useTheme();
  const styles = useMemo(() => makeStyles(palette), [palette]);
  const [phone, setPhone] = useState('');
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (visible) { setPhone(record?.phone ?? ''); setNotes(record?.notes ?? ''); }
  }, [visible, record]);

  const handleSave = async () => {
    setSaving(true);
    if (record) {
      const { error } = await supabase
        .from('clients')
        .update({ phone: phone.trim() || null, notes: notes.trim() || null, updated_at: new Date().toISOString() })
        .eq('id', record.id);
      if (!error) onSaved({ ...record, phone: phone.trim() || null, notes: notes.trim() || null });
      else Alert.alert('Pas enregistré. On reprend :)');
    } else {
      const { data, error } = await supabase
        .from('clients')
        .insert({ business_id: businessId, name: displayName, phone: phone.trim() || null, notes: notes.trim() || null, created_by: userId })
        .select().single();
      if (!error && data) onSaved(data as ClientRecord);
      else Alert.alert('Pas enregistré. On reprend :)');
    }
    setSaving(false);
  };

  return (
    <FormSheet
      visible={visible}
      onClose={onClose}
      title="Modifier le client"
      presentationStyle="formSheet"
      contentContainerStyle={styles.pad}
      footer={
        <View style={styles.footer}>
          <Button label="Enregistrer" loadingLabel="Enregistrement"
            onPress={handleSave} loading={saving} fullWidth size="lg" />
        </View>
      }
    >
      <Text variant="label">{displayName}</Text>
      <Input label="Téléphone" value={phone} onChangeText={setPhone}
        placeholder="620 00 00 00" keyboardType="phone-pad" />
      <Input label="Notes" value={notes} onChangeText={setNotes}
        placeholder="Notes sur ce client" multiline />
      <Text variant="caption" color="secondary" style={{ textAlign: 'center' }}>{TRUST_LINE}</Text>
    </FormSheet>
  );
}

// ─── Payment Modal ────────────────────────────────────────────────────────────

function PayModal({
  visible, displayName, totalOwed, currency, saving, failed,
  onClose, onRecord,
}: {
  visible: boolean; displayName: string; totalOwed: number;
  currency: string; saving: boolean;
  /** Set when the last attempt did not record. The sheet stays open with her input untouched. */
  failed: { reason?: string } | null;
  onClose: () => void;
  onRecord: (amount: number, method: string, date: string) => void;
}) {
  const { palette } = useTheme();
  const styles = useMemo(() => makeStyles(palette), [palette]);
  const [amountStr, setAmountStr] = useState('');
  const [method, setMethod] = useState('especes');
  const [date, setDate] = useState(todayISO());

  // Starts empty, deliberately — "Tout régler" below is the explicit
  // tap-to-fill shortcut for the common case; prefilling the full amount by
  // default made every payment silently assume "paid in full" unless she
  // noticed and edited it down.
  useEffect(() => {
    if (visible) {
      setAmountStr('');
      setMethod('especes');
      setDate(todayISO());
    }
  }, [visible, totalOwed]);

  const amount = parseAmountInput(amountStr, currency);
  const remaining = totalOwed - amount;

  const handleRecord = () => {
    if (amount <= 0) { Alert.alert('Vérifiez le montant :)'); return; }
    if (amount > totalOwed + 0.01) {
      Alert.alert('Le montant dépasse le total :)');
      return;
    }
    onRecord(amount, method, date);
  };

  // The one failure surface: persistent and inline (never a 3-second toast —
  // unreadable in sunlight), her amount/method/date stay exactly as typed, and
  // Réessayer re-fires THE SAME data under the SAME idempotency key (see
  // handleRecord), so retrying can never record the payment twice.
  const failure = failed
    ? buildFailure({
        what: FAILURE_COPY.paymentNotRecorded.what,
        why: failed.reason ?? FAILURE_COPY.paymentNotRecorded.why,
        action: { label: 'Réessayer', onPress: handleRecord },
      })
    : null;

  return (
    <FormSheet
      visible={visible}
      onClose={onClose}
      title={`${displayName} vous doit ${fmt(totalOwed, currency)}`}
      presentationStyle="formSheet"
      contentContainerStyle={styles.pad}
      footer={
        <View style={styles.footer}>
          {failure && <FailureView failure={failure} busy={saving} />}
          {!failure && <Button
            label={amount > 0 ? `Enregistrer : ${displayName} a payé ${fmt(amount, currency)}` : 'Confirmer le paiement'} loadingLabel="Enregistrement"
            onPress={handleRecord} loading={saving} fullWidth size="lg" disabled={amount <= 0}
          />}
        </View>
      }
      accessory={
        Platform.OS === 'ios' ? (
          <InputAccessoryView nativeID={PAYMENT_SHEET_SILENT_ACCESSORY_ID}>
            <View style={{ height: 0 }} />
          </InputAccessoryView>
        ) : undefined
      }
    >
      {/* Amount */}
      <View style={{ gap: spacing[2] }}>
        <Text variant="label">Combien {displayName} vous donne ?</Text>
        <View style={styles.amountRow}>
          <TextInput
            style={styles.amountInput}
            value={amountStr}
            onChangeText={v => setAmountStr(formatAmountInput(v, currency))}
            keyboardType="numeric"
            placeholder="0"
            placeholderTextColor={palette.textDisabled}
            selectTextOnFocus
            autoFocus
            inputAccessoryViewID={Platform.OS === 'ios' ? PAYMENT_SHEET_SILENT_ACCESSORY_ID : undefined}
          />
          <Pressable
            style={styles.solderBtn}
            onPress={() => setAmountStr(formatAmountInput(String(Math.round(totalOwed)), currency))}
          >
            <Text variant="label" style={{ color: palette.primary }}>Tout régler : {fmt(totalOwed, currency)}</Text>
          </Pressable>
        </View>
        {amount > 0 && (
          <Text variant="caption" style={{ color: remaining > 0 ? palette.recouvrementPending : palette.recouvrementPaid }}>
            {remaining > 0
              ? `Il restera ${fmt(remaining, currency)} à régler.`
              : 'Tout sera réglé.'}
          </Text>
        )}
      </View>

      {/* Method */}
      <View style={{ gap: spacing[2] }}>
        <Text variant="label">Payé par :</Text>
        <View style={styles.chipRow}>
          {PAY_METHODS.map(m => (
            <Pressable key={m.key} onPress={() => setMethod(m.key)}
              style={[styles.chip, method === m.key && styles.chipActive]}>
              <Text variant="caption" style={{ color: method === m.key ? palette.textInverse : palette.textPrimary }}>
                {m.label}
              </Text>
            </Pressable>
          ))}
        </View>
      </View>

      <DatePickerField label="Date" value={date} onChange={setDate} maxToday />
    </FormSheet>
  );
}

// ─── Main Screen ──────────────────────────────────────────────────────────────

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default function ClientLedgerScreen() {
  const { palette } = useTheme();
  const styles = useMemo(() => makeStyles(palette), [palette]);
  const { name: encodedName, remind } = useLocalSearchParams<{ name: string; remind?: string }>();
  const routeParam = decodeURIComponent(encodedName ?? '');
  const isClientId = UUID_RE.test(routeParam);

  const session = useAuthStore(s => s.session);
  const businessId = session?.activeBusiness?.id ?? '';
  const userId = session?.user.id ?? '';
  const currency = session?.activeBusiness?.currency ?? 'GNF';
  const role = session?.activeMembership?.role;
  const canEdit = role === 'administrateur' || role === 'manager';

  const { sales, loading, saving, offline, offlineSince, fetchSales, recordPayment, recordClientPayment, voidPayments } = useVentesStore();

  // Shared key for this client's cached reads (payments + record) — prefixed by
  // route type since routeParam can be either a client UUID or a raw name.
  const clientKey = isClientId ? `id:${routeParam}` : `name:${routeParam}`;

  // displayName is resolved after clientRecord loads when routing by UUID
  const [displayName, setDisplayName] = useState(isClientId ? '' : routeParam);
  const [ledgerPayments, setLedgerPayments] = useState<LedgerPayment[]>([]);
  // Payments still in the outbox, projected as the same per-sale rows the server will create.
  const [pendingLedger, setPendingLedger] = useState<PendingLedgerPayment[]>([]);
  // order_id -> real product label ('Riz, sac de 5kg'), or '' for a bare
  // carnet debt (all lines are the "Solde reporté" placeholder). Absent key
  // = not loaded yet, which the carnet renders identically to bare (no
  // second line) until it resolves — same fail-open-then-self-correct
  // posture this codebase already uses for variant stock/fork-data-ready.
  const [ledgerLines, setLedgerLines] = useState<Record<string, string>>({});
  const [clientRecord, setClientRecord] = useState<ClientRecord | null>(null);
  const [loadingLocal, setLoadingLocal] = useState(true);
  const [showPayModal, setShowPayModal] = useState(false);
  const [payFailed, setPayFailed] = useState<{ reason?: string } | null>(null);
  // One idempotency key per LOGICAL payment: reused when she retries the same
  // amount/method/date/target, replaced the moment any of them changes.
  const payAttempt = useRef<{ sig: string; key: string } | null>(null);
  const [showEditModal, setShowEditModal] = useState(false);
  const [showNewCreditSheet, setShowNewCreditSheet] = useState(false);
  const [showReminder, setShowReminder] = useState(false);
  const [detailEntry, setDetailEntry] = useState<LedgerEntry | null>(null);
  const [successPayment, setSuccessPayment] = useState<{ amount: number; remaining: number } | null>(null);
  const checkScale = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (successPayment) {
      checkScale.setValue(0);
      Animated.spring(checkScale, { toValue: 1, useNativeDriver: true, tension: 65, friction: 8 }).start();
    }
  }, [successPayment]);

  // Load sales + client record on mount — always refresh to catch new credit sales
  useEffect(() => {
    if (!businessId) return;
    fetchSales(businessId);
    loadClientRecord();
  }, [businessId]);

  // Reload ledger payments + line labels whenever sales change (catches new
  // credits/payments, including one just added via "+ Nouveau crédit").
  useEffect(() => {
    if (loading) return;
    loadLedgerPayments();
    loadLedgerLines();
  }, [sales, loading, displayName]);

  const loadClientRecord = async () => {
    const recordCacheKey = `${businessId}:record:${clientKey}`;

    // Seed from cache immediately (mainly matters for the isClientId route,
    // where displayName has nothing else to resolve from until this loads).
    if (!clientRecord) {
      const cached = await getClientLedgerCache(recordCacheKey) as ClientRecord | null;
      if (cached) {
        setClientRecord(cached);
        if (isClientId) setDisplayName(cached.name);
      }
    }

    let query = supabase.from('clients').select('*').eq('business_id', businessId);
    if (isClientId) {
      query = query.eq('id', routeParam);
    } else {
      query = query.eq('name', routeParam);
    }
    // A genuine timeout REJECTS (unlike a returned Supabase {error}) — must be
    // caught here, not just checked, or it surfaces as an unhandled promise
    // rejection (this is what Sentry's "Network timeout after 12000ms" reports
    // on this screen were: this call had no try/catch and no .catch() at its
    // fire-and-forget call site in the mount useEffect).
    try {
      const { data, error } = await withTimeout(query.maybeSingle());
      if (error) return; // offline (or any other failure) — cached value above already applied
      const record = data as ClientRecord | null;
      setClientRecord(record);
      if (isClientId && record) setDisplayName(record.name);
      if (record) void saveClientLedgerCache(recordCacheKey, record);
    } catch {
      // failure: control-flow — timeout = network error: cached ledger already applied, offline notice speaks
      // timeout — cached value above already applied
    }
  };

  // Pending payments → ledger rows (id = idempotency key). Allocation runs against
  // the SYNCED cache baseline (never the overlay-patched store sales, which would
  // apply each payment twice).
  const readPendingLedger = async (): Promise<PendingLedgerPayment[]> => {
    try {
      const session = useAuthStore.getState().session;
      const isVend = session?.activeMembership?.role === 'vendeur';
      const baseline = ((await getVentesCache(`${businessId}:${isVend ? session?.user.id : 'all'}`)) ?? []) as unknown as OverlaySale[];
      const { payments } = await rebuildPendingOverlay(baseline, {
        currentUserId: session?.user.id ?? null,
        currentUserName: session?.user.name ?? '',
        currentBusinessId: businessId,
      });
      const ids = new Set(selectClientSales(useVentesStore.getState().sales, routeParam, isClientId, displayName).map(x => x.id));
      return pendingLedgerPayments(payments, ids);
    } catch {
      // failure: silent — cache read failure is treated as no cache
      return [];
    }
  };

  // Pairing with the server read: pending rows are read before AND after it, and
  // only rows present at both ends are kept. A payment that drained during the
  // fetch is dropped here (the server value is trusted) so it can never be
  // counted twice; the post-sync refetch repairs the rare transient gap.
  const loadLedgerPayments = async () => {
    const before = await readPendingLedger();
    await loadLedgerPaymentsServer();
    const after = await readPendingLedger();
    const stillThere = new Set(after.map(r => r.id));
    setPendingLedger(before.filter(r => stillThere.has(r.id)));
  };

  const loadLedgerPaymentsServer = async () => {
    const name = isClientId ? displayName : routeParam;
    const clientSales = isClientId
      ? sales.filter(s => s.client_id === routeParam || (s.client_id == null && s.customer_name === name))
      : sales.filter(s => s.customer_name === routeParam);
    if (clientSales.length === 0) { setLoadingLocal(false); return; }

    const paymentsCacheKey = `${businessId}:payments:${clientKey}`;

    // Seed from cache immediately so the ledger (and the real totalOwed it
    // drives) is correct while the network call runs, not just once it
    // resolves. §6 of the offline-first rewrite: unconditional now, not
    // just "if nothing's loaded yet" — a refocus/refetch on an
    // already-populated screen must still re-show the latest local truth
    // before the network round trip starts, matching fetchSales's own
    // hydration-order fix (stores/ventes.ts).
    {
      const cached = await getClientLedgerCache(paymentsCacheKey) as LedgerPayment[] | null;
      if (cached) setLedgerPayments(cached);
    }

    const saleIds = clientSales.map(s => s.id);
    // Same reject-vs-return distinction as loadClientRecord above: a genuine
    // timeout rejects withTimeout() rather than resolving with {error}, and
    // this function is also called fire-and-forget from a useEffect, so an
    // uncaught rejection here becomes an unhandled promise rejection.
    try {
      const { data, error } = await withTimeout(
        supabase
          .from('payments')
          .select('id, order_id, method, amount, date, created_at')
          .in('order_id', saleIds)
          .order('date', { ascending: true }),
      );
      if (error) {
        // Network failure: fall back to cache so a client's real debt (sales minus
        // payments) doesn't silently inflate to their full lifetime sale total —
        // this is what happened before this cache existed (payments = [] offline).
        if (isNetworkError(error)) {
          const cached = await getClientLedgerCache(paymentsCacheKey) as LedgerPayment[] | null;
          if (cached) setLedgerPayments(cached);
        }
        setLoadingLocal(false);
        return;
      }
      const payments = (data ?? []).map(p => ({ ...(p as object), amount: (p as { amount: number }).amount / 100 })) as LedgerPayment[];
      setLedgerPayments(payments);
      void saveClientLedgerCache(paymentsCacheKey, payments);
      setLoadingLocal(false);
    } catch {
      // failure: control-flow — timeout = network error: cache fallback, offline notice speaks
      // timeout — treat exactly like a returned network error above
      const cached = await getClientLedgerCache(paymentsCacheKey) as LedgerPayment[] | null;
      if (cached) setLedgerPayments(cached);
      setLoadingLocal(false);
    }
  };

  // Real product labels for credit sales, keyed by order_id — this is what
  // lets the carnet show a second gray line ("Riz, sac de 5kg") for a real
  // credit sale while showing nothing at all for a bare carnet debt.
  // fetchSales() itself never populates Vente.lines (only loadDetail() does,
  // on demand, for ventes/index.tsx's own detail modal) — so without this
  // dedicated fetch every credit entry here would read as bare regardless of
  // whether it actually came from a real cart sale. Same cache-fallback
  // shape as loadLedgerPayments/loadClientRecord above, not a new pattern.
  const loadLedgerLines = async () => {
    const name = isClientId ? displayName : routeParam;
    const creditSaleIds = sales
      .filter(s =>
        s.status === 'credit' &&
        (isClientId
          ? s.client_id === routeParam || (s.client_id == null && name && s.customer_name === name)
          : s.customer_name === routeParam),
      )
      .map(s => s.id);
    if (creditSaleIds.length === 0) return;

    const linesCacheKey = `${businessId}:lines:${clientKey}`;

    // Unconditional for the same reason as loadLedgerPayments above (§6).
    {
      const cached = await getClientLedgerCache(linesCacheKey) as Record<string, string> | null;
      if (cached) setLedgerLines(cached);
    }

    try {
      const { data, error } = await withTimeout(
        supabase.from('so_lines').select('order_id, product_name').in('order_id', creditSaleIds),
      );
      if (error) return; // offline (or any other failure) — cached value above already applied

      const byOrder = new Map<string, string[]>();
      for (const l of (data ?? []) as { order_id: string; product_name: string | null }[]) {
        const arr = byOrder.get(l.order_id) ?? [];
        arr.push(l.product_name ?? '');
        byOrder.set(l.order_id, arr);
      }
      const labels: Record<string, string> = {};
      for (const [orderId, names] of byOrder) {
        // A bare carnet debt is always exactly one line named "Solde
        // reporté" (submit_carnet_debt's hidden is_system placeholder) —
        // never shown as if it were a real product. Anything else (a real
        // cart sale marked as credit) shows its real line names.
        const isBare = names.length === 1 && names[0] === 'Solde reporté';
        labels[orderId] = isBare ? '' : names.filter(Boolean).join(', ');
      }
      setLedgerLines(labels);
      void saveClientLedgerCache(linesCacheKey, labels);
    } catch {
      // failure: control-flow — timeout = network error: cached labels already applied
      // timeout — cached value above already applied
    }
  };

  const clientSales = useMemo(() => {
    return selectClientSales(sales, routeParam, isClientId, displayName);
  }, [sales, routeParam, isClientId, displayName]);

  const creditSales = useMemo(
    () => clientSales.filter(s => s.status === 'credit')
      .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime()),
    [clientSales],
  );

  const everHadCredit = useMemo(
    () => clientSales.some(s => s.is_credit),
    [clientSales],
  );

  // Clamped to zero — see the identical fix + explanation in clients/index.tsx's
  // getDaysAgo. Same root cause: a UTC-date-substring reconstructed as local
  // midnight can land in the future relative to Date.now() on a device west
  // of UTC, which otherwise produced a real, reported "-1 jour".
  const debtAge = useMemo(() => {
    if (creditSales.length === 0) return 0;
    const oldest = creditSales[0].sale_date ?? creditSales[0].created_at.split('T')[0];
    return Math.max(0, Math.floor((Date.now() - new Date(oldest + 'T00:00:00').getTime()) / 86400000));
  }, [creditSales]);

  // (Historical note: a payment recorded offline used to leave this total
  // overstated until it synced. pendingLedger below closes that — queued payments
  // are projected into ledger rows via lib/pendingOverlay.ts.)
  // ONE combined ledger (server rows + still-queued payments) feeds the banner total AND
  // the rows below, so they cannot contradict each other.
  const allPayments = useMemo<LedgerPayment[]>(() => [...ledgerPayments, ...pendingLedger], [ledgerPayments, pendingLedger]);
  const { totalSold, totalPaid, totalOwed } = clientBalance(clientSales, allPayments);

  // The carnet page — one row per real entry, newest first. Cash ('paye')
  // sales are deliberately excluded entirely, not just hidden: a cash sale
  // always creates its own atomic payment for the exact same amount at
  // submit_sale() time (migration_v195+), so it nets to zero against
  // totalOwed above and was never really a "carnet" event — showing it (or
  // its own self-payment) as a bare "Reçu" line with no matching "Donné"
  // would be both confusing and wrong for a screen that's supposed to
  // mirror what she'd actually write on paper. Only sales with
  // status='credit', and only payments whose order_id points at one of
  // those credit sales, become lines here.
  const ledgerEntries = useMemo<LedgerEntry[]>(() => {
    const creditSalesForLedger = clientSales.filter(s => s.status === 'credit');
    const creditSaleIds = new Set(creditSalesForLedger.map(s => s.id));

    type RawEntry = Omit<LedgerEntry, 'reste'>;
    const raw: RawEntry[] = [];

    for (const s of creditSalesForLedger) {
      raw.push({
        key: `s-${s.id}`,
        dateKey: s.sale_date ?? s.created_at.split('T')[0],
        createdAt: s.created_at,
        kind: 'credit',
        amount: s.total_amount - (s.discount_amount ?? 0),
        saleLabel: ledgerLines[s.id] || null,
        method: null,
        sourceType: 'sale',
        sourceId: s.id,
      });
    }
    for (const p of allPayments) {
      if (!creditSaleIds.has(p.order_id)) continue; // a cash sale's own self-payment, not a carnet event
      raw.push({
        key: `p-${p.id}`,
        dateKey: p.date,
        createdAt: p.created_at,
        kind: 'payment',
        amount: p.amount,
        saleLabel: null,
        method: p.method,
        sourceType: 'payment',
        sourceId: p.id,
      });
    }

    // True chronological (creation) order, not the user-editable date field —
    // "Reste" answers "where did we stand the moment this was recorded," and
    // created_at can never be backdated the way a payment's own date can.
    raw.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());

    let running = 0;
    const withBalance: LedgerEntry[] = raw.map(e => {
      running += e.kind === 'credit' ? e.amount : -e.amount;
      // Clamped the same way totalOwed above is — guarantees the top line's
      // Reste always exactly equals the header total, never off by a
      // floating-point hair.
      return { ...e, reste: Math.max(0, running) };
    });

    return withBalance.reverse(); // newest first — see the ORDER NOTE in the spec this implements
  }, [clientSales, allPayments, ledgerLines]);

  // Everything the reminder receipt shows comes from the same records as the
  // ledger above: open credit lines (newest first), the most recent payment
  // against them, and the exact remaining total. Nothing is invented.
  const reminderInput = useMemo<DebtReceiptInput>(() => {
    const openCredits = clientSales
      .filter(s => s.status === 'credit')
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
    const creditIds = new Set(openCredits.map(s => s.id));
    const lastPay = allPayments
      .filter(p => creditIds.has(p.order_id))
      .sort((a, b) => (b.date.localeCompare(a.date)) || b.created_at.localeCompare(a.created_at))[0];
    return {
      businessName: session?.activeBusiness?.name ?? '',
      clientName: displayName,
      currency,
      totalOwed,
      debts: openCredits.map(s => ({
        label: ledgerLines[s.id] || null,
        date: s.sale_date ?? s.created_at.split('T')[0],
      })),
      lastPayment: lastPay ? { amount: lastPay.amount, date: lastPay.date } : null,
    };
  }, [clientSales, allPayments, ledgerLines, session?.activeBusiness?.name, displayName, currency, totalOwed]);

  // Arrived from the list's "Rappeler": open the preview once the ledger has
  // loaded, so the receipt never shows a half-loaded balance.
  const remindHandled = useRef(false);
  useEffect(() => {
    if (remind !== '1' || remindHandled.current || loadingLocal || loading || !displayName) return;
    remindHandled.current = true;
    if (totalOwed > 0) setShowReminder(true);
  }, [remind, loadingLocal, loading, displayName, totalOwed]);

  // "Aujourd'hui" / "Hier" / "27 sept." — day-level only, never a timestamp.
  // Deliberately shorter than the old day-group header's own date format
  // (which spelled the month out in full) — a carnet line is compact by
  // nature.
  const entryDateLabel = useMemo(() => {
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    const toKey = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    const todayKey = toKey(now);
    const yest = new Date(now); yest.setDate(now.getDate() - 1);
    const yestKey = toKey(yest);
    return (key: string) => {
      if (key === todayKey) return "Aujourd'hui";
      if (key === yestKey) return 'Hier';
      const d = new Date(key + 'T00:00:00');
      return formatDate(d, d.getFullYear() !== now.getFullYear() ? 'short' : 'dayMonth');
    };
  }, []);

  const handleRecord = useCallback(async (amount: number, method: string, date: string, specificSaleId?: string) => {
    let result: { ok: boolean; fullyPaid?: boolean; fullySettled?: boolean; paymentId?: string; paymentIds?: string[]; reason?: string };
    const sig = `${specificSaleId ?? 'client'}|${amount}|${method}|${date}`;
    if (!payAttempt.current || payAttempt.current.sig !== sig) payAttempt.current = { sig, key: generateId() };
    const idempotencyKey = payAttempt.current.key;
    setPayFailed(null);
    if (specificSaleId) {
      result = await recordPayment(specificSaleId, amount, method, date, idempotencyKey);
    } else {
      result = await recordClientPayment(displayName, businessId, amount, method, date, idempotencyKey);
    }
    if (!result.ok) {
      // Nothing moved (the write never happened), and her input is still in the
      // sheet. Say so plainly, in place, and offer the one retry.
      haptics.error();
      setPayFailed({ reason: result.reason });
      return;
    }
    if (result.ok) {
      payAttempt.current = null;
      setPayFailed(null);
      setShowPayModal(false);
      haptics.success();

      // Remaining balance is read synchronously from the store's own
      // post-write state — recordPayment/recordClientPayment already applied
      // their optimistic update before resolving (see stores/ventes.ts), so
      // no extra fetch is needed here.
      const reste = useVentesStore.getState().sales
        .filter(s => s.business_id === businessId && s.customer_name === displayName && s.status === 'credit')
        .reduce((sum, s) => sum + (s.total_amount - (s.discount_amount ?? 0) - (s.amount_paid ?? 0)), 0);
      setSuccessPayment({ amount, remaining: reste });
      loadLedgerPayments();
      const { text, settled } = repaymentConfirmation(displayName, Math.max(0, reste), currency);
      // Undo via void_payment (migration_v157.sql), one call per payments
      // row this write actually created — specificSaleId creates exactly
      // one (paymentId), the FIFO client-wide path can fan out across
      // several sale_orders at once (paymentIds). Neither is present when
      // the write only got as far as the offline queue (record_payment/
      // record_client_payment haven't actually run yet, so there's no real
      // payment id to void) — undo is unavailable for that case.
      const idsToVoid = specificSaleId
        ? (result.paymentId ? [result.paymentId] : [])
        : (result.paymentIds ?? []);
      useSaveConfirmationStore.getState().show({
        message: text,
        tone: settled ? 'settled' : 'success',
        undo: idsToVoid.length > 0
          ? async () => { await useVentesStore.getState().voidPayments(idsToVoid, businessId, 'Annulée depuis la confirmation'); }
          : undefined,
      });
    }
  }, [displayName, businessId, currency, recordPayment, recordClientPayment]);

  const openMenu = useCallback(() => {
    if (!canEdit) return;
    Alert.alert(displayName, undefined, [
      { text: 'Modifier le client', onPress: () => setShowEditModal(true) },
      { text: 'Annuler', style: 'cancel' },
    ]);
  }, [displayName, canEdit]);

  if (loadingLocal && loading) {
    return (
      <Screen>
        <View style={styles.hdr}>
          <Pressable onPress={() => router.back()}><Text variant="body" color="secondary">‹ Retour</Text></Pressable>
          <Text variant="h4" style={{ flex: 1, textAlign: 'center' }} numberOfLines={1}>{displayName}</Text>
          <View style={{ width: 60 }} />
        </View>
        <Text variant="body" color="secondary" style={{ textAlign: 'center', marginTop: spacing[8] }}>
          Chargement…
        </Text>
      </Screen>
    );
  }

  return (
    <Screen>
      {/* Header */}
      <View style={styles.hdr}>
        <Pressable onPress={() => router.back()}><Text variant="body" color="secondary">‹ Retour</Text></Pressable>
        <Text variant="h4" style={{ flex: 1, textAlign: 'center' }} numberOfLines={1}>{displayName}</Text>
        {canEdit ? (
          <Pressable onPress={openMenu} style={{ width: 60, alignItems: 'flex-end' }} accessibilityLabel="Plus d'options" accessibilityRole="button">
            <Text variant="body" color="secondary">⋯</Text>
          </Pressable>
        ) : (
          <View style={{ width: 60 }} />
        )}
      </View>

      {offline && (
        <OfflineNotice
          offlineSince={offlineSince}
          onRetry={() => { fetchSales(businessId); void loadClientRecord(); }}
        />
      )}

      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>

        {/* Status banner */}
        {totalOwed > 0 ? (
          <View style={styles.debtCard}>
            <Text style={styles.bannerLabel}>{displayName} vous doit</Text>
            {/* Plain, calm foreground — this is her own receivable, not a
                loss; color lives on the age line below, not the amount. */}
            <Text style={styles.bannerAmount}>{fmt(totalOwed, currency)}</Text>
            <RNText style={[styles.bannerAge, { color: debtAgeColor(debtAge, palette) }]}>
              {formatDebtAge(debtAge)}
            </RNText>
            {totalPaid > 0 && (
              <RNText style={styles.repaidLine}>
                {fmt(totalPaid, currency)} payé sur {fmt(totalSold, currency)}
              </RNText>
            )}
            <Pressable
              onPress={() => setShowPayModal(true)}
              style={({ pressed }) => [styles.bannerBtn, pressed && { opacity: 0.85 }]}
            >
              <Text style={styles.bannerBtnText}>Enregistrer un paiement</Text>
            </Pressable>
          </View>
        ) : everHadCredit ? (
          // Same header shape as the non-zero case above (label/amount/
          // sub-line), not a separate one-off banner — the carnet doesn't
          // look fundamentally different at zero, it just says "0" and
          // confirms the last entry settled it.
          <View style={styles.debtCard}>
            <Text style={styles.bannerLabel}>{displayName} vous doit</Text>
            <Text style={styles.bannerAmount}>{fmt(0, currency)}</Text>
            <View style={styles.regleRow}>
              <Ionicons name="checkmark-circle" size={16} color={palette.recouvrementPaid} />
              <RNText style={[styles.bannerAge, { color: palette.recouvrementPaid, fontFamily: fontFamily.bold, marginTop: 0, marginBottom: 0 }]}>
                Réglé ✓
              </RNText>
            </View>
          </View>
        ) : null}

        {/* The carnet's other pen stroke — "Enregistrer un paiement" above
            is "reçu"; this is "donné". Deliberately not gated on totalOwed:
            a new credit can be the very next thing written on the page
            regardless of the current balance, including right at 0. */}
        <Pressable
          onPress={() => setShowNewCreditSheet(true)}
          style={({ pressed }) => [styles.newCreditBtn, { borderColor: palette.primary }, pressed && { opacity: 0.7 }]}
        >
          <Text variant="label" style={{ color: palette.primary }}>+ Crédit</Text>
        </Pressable>

        {/* Secondary contact row — Rappeler sur WhatsApp + Appeler. Only the
            call half needs a real number on file; the WhatsApp reminder
            still only makes sense while there's an actual debt to mention. */}
        <View style={styles.contactRow}>
          {totalOwed > 0 && (
            <Pressable
              onPress={() => setShowReminder(true)}
              style={[styles.contactBtn, { borderColor: palette.border }]}
            >
              <Ionicons name="logo-whatsapp" size={16} color={palette.primary} />
              <Text variant="label" style={{ color: palette.primary }}>Rappeler</Text>
            </Pressable>
          )}
          {clientRecord?.phone && (
            <Pressable
              onPress={() => Linking.openURL(`tel:${clientRecord.phone}`).catch(() => { })}
              style={[styles.contactBtn, { borderColor: palette.border }]}
            >
              <Ionicons name="call-outline" size={16} color={palette.primary} />
              <Text variant="label" style={{ color: palette.primary }}>Appeler</Text>
            </Pressable>
          )}
        </View>

        {/* The carnet page — one continuous list of lines, newest first.
            No day-grouping, no collapsible sections, no summary rows: a
            paper page never folds. Each line answers "where did we stand
            here?" on its own — the whole point of a carnet. */}
        {ledgerEntries.length > 0 && (
          <View>
            {ledgerEntries.map(entry => {
              const isSettled = entry.reste === 0;
              return (
                <Pressable
                  key={entry.key}
                  style={[styles.carnetRow, { borderBottomColor: palette.border }]}
                  onPress={() => setDetailEntry(entry)}
                >
                  <Text variant="caption" color="secondary" style={styles.carnetDate}>
                    {entryDateLabel(entry.dateKey)}
                  </Text>
                  <View style={styles.carnetMiddle}>
                    <Text variant="body">{entry.kind === 'credit' ? 'Donné' : 'Reçu'}</Text>
                    {entry.saleLabel ? (
                      <Text variant="caption" color="secondary" numberOfLines={1}>{entry.saleLabel}</Text>
                    ) : null}
                  </View>
                  <View style={styles.carnetAmountCol}>
                    <RNText style={[styles.carnetAmount, { color: palette.textPrimary }]}>
                      {fmt(entry.amount, currency)}
                    </RNText>
                    {isSettled ? (
                      <View style={styles.regleTagRow}>
                        <Text variant="caption" color="secondary">Reste : {fmt(0, currency)}</Text>
                        <Text variant="caption" style={{ color: palette.recouvrementPaid, fontFamily: fontFamily.bold }}> · Réglé ✓</Text>
                      </View>
                    ) : (
                      <Text variant="caption" color="secondary">Reste : {fmt(entry.reste, currency)}</Text>
                    )}
                  </View>
                </Pressable>
              );
            })}
          </View>
        )}

        {ledgerEntries.length === 0 && (
          <Text variant="body" color="secondary" style={{ textAlign: 'center', marginTop: spacing[6] }}>
            Aucun crédit pour le moment.
          </Text>
        )}
      </ScrollView>

      <PayModal
        visible={showPayModal}
        displayName={displayName}
        totalOwed={totalOwed}
        currency={currency}
        saving={saving}
        failed={payFailed}
        onClose={() => { setShowPayModal(false); setPayFailed(null); }}
        onRecord={handleRecord}
      />

      <EditModal
        visible={showEditModal}
        displayName={displayName}
        record={clientRecord}
        businessId={businessId}
        userId={userId}
        onClose={() => setShowEditModal(false)}
        onSaved={(r) => { setClientRecord(r); setShowEditModal(false); }}
      />

      {/* "+ Nouveau crédit" — the carnet's "donné" stroke, opening the same
          Crédit rapide capture Accueil's "+" and vendre.tsx's Crédit tab
          use, pre-scoped to this one customer (no client grid, no way to
          pick someone else). Keyed on visibility so it always starts fresh,
          same convention QuickCaptureSheet's own children use. */}
      <DebtReminderSheet
        visible={showReminder}
        onClose={() => setShowReminder(false)}
        input={reminderInput}
        daysOldestDebt={debtAge}
      />

      <FormSheet
        visible={showNewCreditSheet}
        onClose={() => setShowNewCreditSheet(false)}
        title="Crédit rapide"
        contentContainerStyle={styles.pad}
      >
        {showNewCreditSheet && (
          <CreditRapideCapture
            key={String(showNewCreditSheet)}
            businessId={businessId}
            userId={userId}
            currency={currency}
            initialClient={{ id: clientRecord?.id, name: displayName }}
            onDone={() => {
              setShowNewCreditSheet(false);
              // Ledger data doesn't refresh itself — fetchSales() re-running
              // is what re-triggers loadLedgerPayments/loadLedgerLines above.
              fetchSales(businessId);
            }}
          />
        )}
      </FormSheet>

      {/* Tap a carnet line to see its source — read-only, no edit/cancel
          actions (those belong to ventes/index.tsx's own detail modal, a
          different surface with a different job). Just enough to answer
          "what was this line," which is all a paper carnet page could ever
          show anyway. */}
      <FormSheet
        visible={!!detailEntry}
        onClose={() => setDetailEntry(null)}
        title={detailEntry?.kind === 'credit' ? 'Donné' : 'Reçu'}
        contentContainerStyle={styles.pad}
      >
        {detailEntry && (
          <View style={{ gap: spacing[3] }}>
            <Text variant="label" color="secondary">{entryDateLabel(detailEntry.dateKey)}</Text>
            <Text variant="h2">{fmt(detailEntry.amount, currency)}</Text>
            {detailEntry.saleLabel ? (
              <Text variant="body" color="secondary">{detailEntry.saleLabel}</Text>
            ) : null}
            {detailEntry.method ? (
              <Text variant="body" color="secondary">{methodLabel(detailEntry.method)}</Text>
            ) : null}
            <Text variant="caption" color="secondary">
              Reste après cette ligne : {fmt(detailEntry.reste, currency)}
            </Text>
          </View>
        )}
      </FormSheet>

      {/* Payment success overlay */}
      {successPayment && (() => {
        const overlayCopy = paymentOverlayCopy(successPayment.remaining, currency);
        return (
          <View style={styles.successOverlay}>
            <Animated.View style={[styles.successBadge, { transform: [{ scale: checkScale }] }]}>
              <Ionicons name="checkmark" size={44} color={palette.textPrimary} />
            </Animated.View>
            <Text style={styles.successHeadline}>{overlayCopy.headline}</Text>
            <Text style={styles.successSubtitle}>
              {displayName} vous a payé {fmt(successPayment.amount, currency)}.
            </Text>
            {overlayCopy.reste && (
              <Text style={styles.successReste}>{overlayCopy.reste}</Text>
            )}
            <Pressable
              style={({ pressed }) => [styles.successBtn, pressed && { opacity: 0.85 }]}
              onPress={() => setSuccessPayment(null)}
            >
              <Text style={styles.successBtnText}>Continuer</Text>
            </Pressable>
          </View>
        );
      })()}
    </Screen>
  );
}

function makeStyles(p: Palette) {
  return StyleSheet.create({
    safe: { flex: 1, backgroundColor: p.background },
    hdr: {
      flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
      padding: spacing[5], borderBottomWidth: 1, borderBottomColor: p.border,
    },
    content: { paddingHorizontal: spacing[5], paddingTop: 12, paddingBottom: spacing[10], gap: spacing[4] },

    debtCard: {
      backgroundColor: p.surface, borderRadius: radius.lg,
      borderWidth: 1, borderColor: p.border,
      alignItems: 'center', paddingHorizontal: 20, paddingTop: 24, paddingBottom: 20,
    },
    bannerLabel: { fontSize: 14, color: p.textSecondary, textAlign: 'center', fontWeight: '400', marginBottom: 4 },
    bannerAmount: { fontSize: 40, fontWeight: '700', lineHeight: 52, color: p.textPrimary, textAlign: 'center' },
    bannerBtn: {
      // Sunlight/one-handed audit: bumped to the app's 56dp primary-money-
      // action floor (minHeight, not just padding — a highest-frequency
      // action per CLAUDE.md's own thumb-zone priority list).
      width: '100%', backgroundColor: p.primary, borderRadius: 12, minHeight: 56,
      paddingVertical: 14, alignItems: 'center', justifyContent: 'center', marginTop: 16,
    },
    bannerBtnText: { fontSize: 16, fontWeight: '600', color: p.textInverse },
    bannerAge: { fontSize: 12, color: p.textSecondary, textAlign: 'center', marginTop: 4, marginBottom: 8 },
    repaidLine: { fontSize: 13, color: p.textSecondary, textAlign: 'center', marginBottom: 4 },
    // Zero-balance header's "Réglé ✓" sub-line — same slot bannerAge fills
    // for the non-zero case, just an icon+label row instead of plain text.
    regleRow: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 4, marginBottom: 8 },
    newCreditBtn: {
      alignSelf: 'center', borderWidth: 1, borderRadius: radius.md,
      paddingVertical: spacing[2], paddingHorizontal: spacing[4],
    },
    contactRow: { flexDirection: 'row', gap: spacing[2] },
    contactBtn: {
      flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: spacing[1],
      borderWidth: 1, borderRadius: radius.md, paddingVertical: spacing[3], paddingHorizontal: spacing[3],
    },

    // Carnet — one continuous list of lines, no cards, no grouping. A thin
    // bottom hairline between rows is the only structure, same as a ruled
    // paper page.
    carnetRow: {
      flexDirection: 'row', alignItems: 'flex-start', gap: spacing[3],
      paddingVertical: spacing[3], borderBottomWidth: StyleSheet.hairlineWidth,
    },
    carnetDate: { width: 68 },
    carnetMiddle: { flex: 1, gap: 2 },
    carnetAmountCol: { alignItems: 'flex-end', gap: 2 },
    carnetAmount: { fontSize: 16, fontFamily: fontFamily.semibold, fontVariant: ['tabular-nums'] },
    regleTagRow: { flexDirection: 'row', alignItems: 'center' },

    // Modals
    modalSafe: { flex: 1, backgroundColor: p.background },
    pad: { padding: spacing[5], gap: spacing[4], paddingBottom: spacing[10] },
    footer: { padding: spacing[5], backgroundColor: p.background },

    amountRow: { flexDirection: 'row', gap: spacing[3], alignItems: 'center' },
    amountInput: {
      flex: 1, paddingHorizontal: spacing[4], paddingVertical: spacing[3],
      borderRadius: radius.md, borderWidth: 1, borderColor: p.border,
      backgroundColor: p.surface, color: p.textPrimary,
      // Custom fontSize needs an explicit lineHeight or the glyph clips at
      // the top (RN default line-height is too tight at this size) — see
      // feedback_text_variant_over_custom_style memory.
      fontSize: 28, lineHeight: 34, fontWeight: '700',
    },
    solderBtn: {
      paddingHorizontal: spacing[3], paddingVertical: spacing[3],
      borderRadius: radius.md, borderWidth: 1, borderColor: p.primary,
    },
    chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing[2] },
    chip: {
      paddingHorizontal: spacing[3], paddingVertical: spacing[1.5],
      borderRadius: radius.full, borderWidth: 1, borderColor: p.border,
      backgroundColor: p.surface,
    },
    chipActive: { backgroundColor: p.primary, borderColor: p.primary },
    successOverlay: {
      ...StyleSheet.absoluteFillObject,
      backgroundColor: p.background,
      alignItems: 'center',
      justifyContent: 'center',
      padding: 32,
      zIndex: 100,
    },
    successBadge: {
      width: 80, height: 80, borderRadius: 40,
      // Neutral, not green — this overlay fires for a partial payment, and
      // green on these screens is reserved for the one "Tout est réglé ✓"
      // zero state, nowhere else.
      backgroundColor: p.border + '55',
      alignItems: 'center', justifyContent: 'center',
      marginBottom: 24,
    },
    successHeadline: {
      fontSize: 28, fontWeight: '700', lineHeight: 40, color: p.textPrimary,
      textAlign: 'center', marginBottom: 8,
    },
    successSubtitle: {
      fontSize: 18, color: p.textPrimary,
      textAlign: 'center', marginTop: 8, marginBottom: 16,
    },
    // Plain remaining-balance line under the partial-payment celebration —
    // same "Reste : …" wording the carnet lines already use, so a partial
    // payment never reads as if the debt were settled.
    successReste: {
      fontSize: 18, fontWeight: '600', color: p.textSecondary,
      textAlign: 'center', marginBottom: 40,
      fontVariant: ['tabular-nums'],
    },
    successBtn: {
      width: '100%', backgroundColor: p.primary, borderRadius: 14,
      paddingVertical: 16, alignItems: 'center',
    },
    successBtnText: { fontSize: 16, fontWeight: '600', color: p.textInverse },
  });
}
