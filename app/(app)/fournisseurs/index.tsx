import { useEffect, useMemo, useRef, useState } from 'react';
import { appAlert } from '@/src/utils/appAlert';
import { AnimatedRowCell, AnimatedRow } from '@/src/components/ui/AnimatedRow';
import { configureLayoutNext } from '@/src/hooks/useAnimateLayoutChange';
import { FlatList, InputAccessoryView, LayoutAnimation, Platform, Pressable, ScrollView, StyleSheet, UIManager, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Screen } from '@/src/components/ui/Screen';
import { FormSheet } from '@/src/components/ui/FormSheet';
import { OfflineNotice } from '@/src/components/ui/OfflineNotice';
import { SkeletonList } from '@/src/components/ui/SkeletonPlaceholder';
import { router } from 'expo-router';
import { Button } from '@/src/components/ui/Button';
import { Input } from '@/src/components/ui/Input';
import { Text } from '@/src/components/ui/Text';
import { PhoneInput } from '@/src/components/ui/PhoneInput';
import { DatePickerField } from '@/src/components/ui/DatePickerField';
import { EmptyState } from '@/src/components/ui/EmptyState';
import { useTheme, spacing, radius, shadow, fontFamily, SUPPLIER_AVATAR_PALETTE } from '@/src/theme';
import type { Palette } from '@/src/theme';
import type { Product } from '@/src/types';
import { useAuthStore } from '@/stores/auth';
import { useProductStore } from '@/stores/products';
import { useFournisseursStore, type CommandeAchat, type Fournisseur } from '@/stores/fournisseurs';
import { haptics } from '@/lib/haptics';
import { toast } from '@/stores/toast';
import { formatAmountInput, parseAmountInput, formatAmount } from '@/src/utils/format';
import { showFailureAlert } from '@/src/components/ui/FailureView';
import { buildFailure } from '@/src/utils/failure';
import { FAILURE_COPY } from '@/src/utils/failureCopy';
import { supplierDeletedConfirmation } from '@/src/utils/saveConfirmationCopy';
import { failAlert } from '@/src/components/ui/FailureView';
import { formatDate } from '@/src/utils/dates';
import { QuickAddProductSheet } from '@/src/components/QuickAddProductSheet';
import type { QuickAddPayload } from '@/src/utils/quickAddProduct';
import { generateId } from '@/lib/id';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { MoneyText } from '@/src/components/ui/Money';

// iOS-only: number-pad/decimal-pad keyboards have no built-in return key, so
// the OS auto-injects its own floating "Done" pill above the keyboard when
// nothing else claims that role. Each form below already has a persistent,
// always-visible footer button — a blank, linked accessory suppresses the OS
// pill without repeating it.
const DEBT_MODAL_SILENT_ACCESSORY_ID = 'fournisseurs-debt-modal-silent-accessory';

function fmt(n: number, cur: string) { return formatAmount(n, cur); }
function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const AVATAR_PALETTE = SUPPLIER_AVATAR_PALETTE;

// Debt recorded-date caption (there's no due_date on supplier_debts to
// count down to, unlike client credit) — neutral, never an alarm color.
function debtAgeDays(iso: string): number {
  return Math.max(0, Math.round((Date.now() - new Date(iso + 'T00:00:00').getTime()) / 86400000));
}
function fmtDebtAge(iso: string): string {
  if (debtAgeDays(iso) === 0) return "Aujourd'hui";
  return `Enregistrée le ${formatDate(iso, 'dayMonth')}`;
}

interface FournisseurFormData {
  name: string; phone: string; country: string; notes: string; leadDays: string;
  linkedProductIds: string[];
}

// ─── Fournisseur Form ──────────────────────────────────────────────────────────

function FournisseurForm({ visible, editing, products, fournisseurs, businessId, userId, currency, onClose, onSave, saving }: {
  visible: boolean; editing: Fournisseur | null; products: Product[]; fournisseurs: Fournisseur[];
  businessId: string; userId: string; currency: string;
  onClose: () => void; onSave: (d: FournisseurFormData) => Promise<void>; saving: boolean;
}) {
  const { palette } = useTheme();
  const styles = useMemo(() => makeStyles(palette), [palette]);
  const { createProduct, saving: productSaving } = useProductStore();
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [linkedIds, setLinkedIds] = useState<Set<string>>(new Set());
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);

  useEffect(() => {
    if (Platform.OS === 'android') UIManager.setLayoutAnimationEnabledExperimental?.(true);
  }, []);

  useEffect(() => {
    if (visible) {
      setName(editing?.name ?? '');
      setPhone(editing?.phone ?? '');
      setDropdownOpen(false);
      setSheetOpen(false);
      setLinkedIds(
        new Set(editing ? products.filter(p => p.supplier_id === editing.id).map(p => p.id) : []),
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, editing]);

  const toggleProduct = (id: string) =>
    setLinkedIds(prev => { const s = new Set(prev); s.has(id) ? s.delete(id) : s.add(id); return s; });

  // The one flow to create a product: QuickAddProductSheet. The id is generated here so it can join
  // linkedIds at save. A supplier that exists on the server bakes its id into the product; a new
  // (or still-queued) supplier cannot be referenced yet, so the supplier save links the product.
  const sheetSupplierId = editing && !editing._pending ? editing.id : null;
  const createForSupplier = async (payload: QuickAddPayload): Promise<{ ok: boolean }> => {
    const productId = generateId();
    const ok = await createProduct(businessId, userId, { ...payload.data, id: productId });
    if (!ok) {
      haptics.error();
      showFailureAlert(buildFailure({
        what: FAILURE_COPY.productNotSaved.what,
        err: null,
        why: useProductStore.getState().error ?? undefined,
        action: { label: 'Réessayer', onPress: () => {} },
      }));
      return { ok: false };
    }
    setLinkedIds(prev => new Set([...prev, productId]));
    setSheetOpen(false);
    return { ok: true };
  };

  const linkedProducts = products.filter(p => linkedIds.has(p.id));

  return (
    <>
    <FormSheet
      visible={visible && !sheetOpen}
      onClose={onClose}
      title={editing ? 'Modifier fournisseur' : 'Nouveau fournisseur'}
      contentContainerStyle={styles.mpad}
      footer={
        <View style={styles.mfooter}>
          <Button
            label="Enregistrer" loadingLabel="Enregistrement"
            loading={saving} fullWidth size="lg"
            onPress={() => {
              if (!name.trim()) { appAlert('Ajoutez un nom :)'); return; }
              onSave({
                name, phone,
                country: editing?.country ?? '',
                notes: editing?.notes ?? '',
                leadDays: editing?.lead_days != null ? String(editing.lead_days) : '',
                linkedProductIds: [...linkedIds],
              });
            }}
          />
        </View>
      }
    >
      <Input label="Nom du fournisseur" value={name} onChangeText={setName} placeholder="Diallo Import" />
      <PhoneInput label="Téléphone" onChange={(e164) => setPhone(e164)} strict={false} />

      <View style={{ gap: spacing[2] }}>
        <Text variant="label">Produits fournis</Text>

        <Pressable
          onPress={() => {
            configureLayoutNext(LayoutAnimation.Presets.easeInEaseOut);
            setDropdownOpen(prev => !prev);
          }}
          style={styles.dropdownTrigger}>
          <Text variant="body" numberOfLines={1} style={{ flex: 1, color: palette.textDisabled }}>
            Sélectionner des produits
          </Text>
          <Ionicons name={dropdownOpen ? 'chevron-up' : 'chevron-down'} size={16} color={palette.textSecondary} />
        </Pressable>

        {dropdownOpen && (
          <ScrollView style={styles.prodDropdown} nestedScrollEnabled keyboardShouldPersistTaps="handled">
            {products.length === 0 ? (
              <View style={{ padding: spacing[3] }}>
                <Text variant="caption" color="secondary">Aucun produit pour le moment.</Text>
              </View>
            ) : products.map(p => {
              const selected = linkedIds.has(p.id);
              return (
                <Pressable
                  key={p.id}
                  onPress={() => {
                    toggleProduct(p.id);
                    configureLayoutNext(LayoutAnimation.Presets.easeInEaseOut);
                    setDropdownOpen(false);
                  }}
                  style={styles.prodDropdownItem}>
                  <Text variant="body" numberOfLines={1} style={{ flex: 1 }}>{p.name}</Text>
                  {selected && <Ionicons name="checkmark" size={16} color={palette.primary} />}
                </Pressable>
              );
            })}
          </ScrollView>
        )}

        {linkedProducts.map(p => (
          <Pressable
            key={p.id}
            onPress={() => { configureLayoutNext(LayoutAnimation.Presets.easeInEaseOut); setDropdownOpen(true); }}
            style={styles.prodDropdownItem}>
            <MoneyText variant="body" style={{ flex: 1 }}>
              {`${p.name} · ${p.sale_price > 0 ? formatAmount(p.sale_price, currency) : 'Prix à fixer'}`}
            </MoneyText>
            <Ionicons name="chevron-forward" size={16} color={palette.textSecondary} />
          </Pressable>
        ))}

        <Pressable
          onPress={() => { setDropdownOpen(false); setSheetOpen(true); }}
          style={styles.outlineBtn}
          accessibilityRole="button">
          <Text variant="label" style={{ color: palette.primary }}>+ Nouveau produit</Text>
        </Pressable>
      </View>
    </FormSheet>

    <QuickAddProductSheet
      visible={visible && sheetOpen}
      onClose={() => setSheetOpen(false)}
      businessId={businessId}
      onSubmit={createForSupplier}
      onPickExisting={p => {
        setLinkedIds(prev => new Set([...prev, p.id]));
        setSheetOpen(false);
      }}
      saving={productSaving}
      currency={currency}
      products={products}
      fournisseurs={fournisseurs}
      supplierId={sheetSupplierId}
    />
    </>
  );
}

// ─── Success Sheet ─────────────────────────────────────────────────────────────

function SuccessSheet({ visible, fournisseur, onLivraison, onDette, onDismiss }: {
  visible: boolean; fournisseur: Fournisseur | null;
  onLivraison: () => void; onDette: () => void; onDismiss: () => void;
}) {
  const { palette } = useTheme();
  const styles = useMemo(() => makeStyles(palette), [palette]);
  return (
    <FormSheet
      visible={visible}
      onClose={onDismiss}
      title={`${fournisseur?.name ?? ''} ajouté`}
      contentContainerStyle={styles.mpad}
    >
      <View style={styles.successTop}>
        <View style={styles.successBadge}>
          <Ionicons name="checkmark" size={32} color={palette.success} />
        </View>
        <Text variant="caption" color="secondary" style={{ textAlign: 'center' }}>
          Que souhaitez-vous faire maintenant ?
        </Text>
      </View>
      <Button label="Nouvelle livraison" onPress={onLivraison} fullWidth size="lg"
        style={{ marginBottom: spacing[3] }} />
      <Pressable onPress={onDette} style={styles.outlineBtn}>
        <Text variant="label" style={{ color: palette.primary }}>Enregistrer une dette fournisseur</Text>
      </Pressable>
    </FormSheet>
  );
}

// ─── Debt Modal ────────────────────────────────────────────────────────────────

function DebtModal({ visible, fournisseur, currency, saving, onClose, onSave }: {
  visible: boolean; fournisseur: Fournisseur | null; currency: string; saving: boolean;
  onClose: () => void; onSave: (amount: number, description: string, date: string) => Promise<void>;
}) {
  const { palette } = useTheme();
  const styles = useMemo(() => makeStyles(palette), [palette]);
  const [amount, setAmount] = useState('');
  const [description, setDescription] = useState('');
  const [date, setDate] = useState(todayISO());

  useEffect(() => {
    if (visible) { setAmount(''); setDescription(''); setDate(todayISO()); }
  }, [visible]);

  return (
    <FormSheet
      visible={visible}
      onClose={onClose}
      title="Dette fournisseur"
      presentationStyle="formSheet"
      contentContainerStyle={styles.mpad}
      footer={
        <View style={styles.mfooter}>
          <Button
            label="Enregistrer la dette" loadingLabel="Enregistrement"
            loading={saving} fullWidth size="lg"
            onPress={() => {
              const amt = parseAmountInput(amount, currency);
              if (isNaN(amt) || amt <= 0) { appAlert('Vérifiez le montant :)'); return; }
              onSave(amt, description.trim(), date);
            }}
          />
        </View>
      }
      accessory={
        Platform.OS === 'ios' ? (
          <InputAccessoryView nativeID={DEBT_MODAL_SILENT_ACCESSORY_ID}>
            <View style={{ height: 0 }} />
          </InputAccessoryView>
        ) : undefined
      }
    >
      {fournisseur && (
        <View style={[styles.debtCtx, { borderLeftWidth: 3, borderLeftColor: palette.textSecondary }]}>
          <Text variant="caption" color="secondary">Vous devez à</Text>
          <Text variant="label">{fournisseur.name}</Text>
        </View>
      )}
      <Input label={`Montant (${currency})`} value={amount} onChangeText={v => setAmount(formatAmountInput(v, currency))}
        keyboardType="decimal-pad" inputAccessoryViewID={Platform.OS === 'ios' ? DEBT_MODAL_SILENT_ACCESSORY_ID : undefined} />
      <Input label="Description (optionnel)" value={description} onChangeText={setDescription}
        placeholder="50 sacs de riz, livraison du 5 juin" />
      <DatePickerField label="Date" value={date} onChange={setDate} maxToday />
    </FormSheet>
  );
}

// ─── Main Screen ──────────────────────────────────────────────────────────────

export default function FournisseursScreen() {
  const insets = useSafeAreaInsets();
  const { palette } = useTheme();
  const styles = useMemo(() => makeStyles(palette), [palette]);
  const session = useAuthStore(s => s.session);
  const businessId = session?.activeBusiness?.id ?? '';
  const currency = session?.activeBusiness?.currency ?? 'GNF';
  const userId = session?.user.id ?? '';

  const { products, fetchProducts } = useProductStore();
  const {
    fournisseurs, commandes, debts, loading, saving, offline, offlineSince,
    fetchFournisseurs, createFournisseur, updateFournisseur, deleteFournisseur,
    fetchCommandes, fetchDebts, createDebt,
  } = useFournisseursStore();

  const [isSaving, setIsSaving] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [editF, setEditF] = useState<Fournisseur | null>(null);
  const [showSuccessSheet, setShowSuccessSheet] = useState(false);
  const [createdFournisseur, setCreatedFournisseur] = useState<Fournisseur | null>(null);
  const [showDebtModal, setShowDebtModal] = useState(false);
  const [debtTarget, setDebtTarget] = useState<Fournisseur | null>(null);

  useEffect(() => {
    if (!businessId) return;
    fetchFournisseurs(businessId);
    fetchCommandes(businessId);
    fetchProducts(businessId, userId, session?.activeMembership?.id, session?.activeMembership?.role);
    fetchDebts(businessId);
  }, [businessId]);

  const supplierDebtMap = useMemo(() => {
    const map: Record<string, number> = {};
    for (const d of debts) {
      const remaining = d.amount - d.amount_paid;
      if (remaining > 0) map[d.supplier_id] = (map[d.supplier_id] ?? 0) + remaining;
    }
    return map;
  }, [debts]);

  // Supplier debts have no due_date column (unlike sale_orders' client-credit
  // due_date) — there's nothing to schedule against. This tracks the oldest
  // still-unpaid debt's recorded date instead, as a same-spirit urgency
  // signal, mirroring Clients' nearestDueDate coloring without a schema change.
  const oldestDebtDateMap = useMemo(() => {
    const map: Record<string, string> = {};
    for (const d of debts) {
      if (d.amount - d.amount_paid <= 0) continue;
      if (!map[d.supplier_id] || d.date < map[d.supplier_id]) map[d.supplier_id] = d.date;
    }
    return map;
  }, [debts]);

  const reorderMap = useMemo(() => {
    const map: Record<string, number> = {};
    for (const p of products) {
      if (!p.supplier_id || p.has_variants) continue;
      if (p.stock_qty === 0 || (p.reorder_level > 0 && p.stock_qty <= p.reorder_level)) {
        map[p.supplier_id] = (map[p.supplier_id] ?? 0) + 1;
      }
    }
    return map;
  }, [products]);

  const totalDebtsCount = useMemo(() => Object.keys(supplierDebtMap).length, [supplierDebtMap]);

  // A livraison = a purchase_order that made it all the way to 'recu' — no
  // 'brouillon'/'envoyé'/'recu_partiel' order is ever created going forward,
  // so this is a straightforward "most recent, per supplier" lookup.
  const lastLivraisonMap = useMemo(() => {
    const map: Record<string, CommandeAchat> = {};
    for (const c of commandes) {
      if (c.status !== 'recu') continue;
      const existing = map[c.supplier_id];
      if (!existing || c.ordered_at > existing.ordered_at) map[c.supplier_id] = c;
    }
    return map;
  }, [commandes]);

  const openDebt = (f: Fournisseur) => {
    setDebtTarget(f); setShowDebtModal(true); setShowSuccessSheet(false);
  };

  const handleSaveFournisseur = async (d: FournisseurFormData) => {
    if (isSaving) return;
    setIsSaving(true);

    const isEdit = !!editF;
    const leadDaysNum = parseInt(d.leadDays) || null;

    // One shared code path for the list-view form and the picker inline form
    // (design point 6): everything below routes through the store, which is
    // phone-first (offline create/update enqueue into the outbox, migration_v244).
    const draft = {
      name: d.name,
      phone: d.phone,
      country: d.country,
      notes: d.notes,
      lead_days: leadDaysNum,
      linkedProductIds: d.linkedProductIds,
      // Editing: unlink products that were deselected. Computed from the local
      // product list (no server fetch — that would fail offline).
      unlinkedProductIds: isEdit
        ? products.filter(p => p.supplier_id === editF?.id && !d.linkedProductIds.includes(p.id)).map(p => p.id)
        : [],
    };

    try {
      if (isEdit) {
        const ok = await updateFournisseur(editF!.id, businessId, userId, draft);
        if (!ok) return;
      } else {
        const supplierId = await createFournisseur(businessId, userId, draft);
        if (!supplierId) {
          haptics.error();
          showFailureAlert(buildFailure({
            what: FAILURE_COPY.supplierNotCreated.what,
            err: null,
            why: useFournisseursStore.getState().error ?? FAILURE_COPY.supplierNotCreated.why,
            action: { label: 'Réessayer', onPress: () => { void handleSaveFournisseur(d); } },
          }));
          return;
        }
        await fetchFournisseurs(businessId);
        const f = useFournisseursStore.getState().fournisseurs.find(x => x.id === supplierId);
        if (f) { setCreatedFournisseur(f); setShowSuccessSheet(true); }
      }

      await fetchProducts(businessId, userId, session?.activeMembership?.id, session?.activeMembership?.role);
      haptics.success();
      setShowForm(false);
      setEditF(null);
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <Screen>
      <View style={styles.hdr}>
        <Pressable onPress={() => router.back()}><Text variant="body" color="secondary">‹ Retour</Text></Pressable>
        <Text variant="h4">Fournisseurs</Text>
        <Pressable
          onPress={() => { setEditF(null); setShowForm(true); }}
          hitSlop={12}
          accessibilityLabel="Nouveau fournisseur"
          accessibilityRole="button"
        >
          <Ionicons name="add" size={24} color={palette.primary} />
        </Pressable>
      </View>

      {offline && (
        <OfflineNotice
          offlineSince={offlineSince}
          onRetry={() => { fetchFournisseurs(businessId); fetchCommandes(businessId); }}
        />
      )}

      {fournisseurs.length > 0 && (
        <View style={styles.summaryBar}>
          <Text variant="caption" color="secondary">
            {fournisseurs.length} fournisseur{fournisseurs.length > 1 ? 's' : ''}
            {totalDebtsCount > 0 ? `  ·  ${totalDebtsCount} avec une dette en cours` : ''}
          </Text>
        </View>
      )}

      {loading && fournisseurs.length === 0 ? (
        <SkeletonList count={6} />
      ) : !loading && fournisseurs.length === 0 && offline ? (
        <View style={styles.empty}><Text variant="body" color="secondary" style={{ textAlign: 'center' }}>Données non disponibles hors ligne. Ouvrez l'application en ligne une première fois pour activer le mode hors ligne.</Text></View>
      ) : fournisseurs.length === 0 ? (
        <EmptyState
          icon="cube-outline"
          title="Aucun fournisseur pour le moment."
          subtitle="Ajoutez ceux qui vous livrent pour suivre vos achats."
          actionLabel="+ Ajouter un fournisseur"
          onAction={() => { setEditF(null); setShowForm(true); }}
          // The "Livraison" FAB is hidden while this empty state shows (never a FAB beside
          // an empty state's own actions), so a delivery stays reachable from here.
          linkLabel="Nouvelle livraison"
          onLink={() => router.push('/(app)/fournisseurs/reception')}
        />
      ) : (
        <FlatList
          data={fournisseurs}
          keyExtractor={f => f.id}
          CellRendererComponent={AnimatedRowCell}
          contentContainerStyle={styles.list}
          renderItem={({ item }) => {
            const ac = AVATAR_PALETTE[item.name.charCodeAt(0) % AVATAR_PALETTE.length];
            const initials = item.name.split(/\s+/).slice(0, 2).map((w: string) => w[0]?.toUpperCase() ?? '').join('');
            const owedAmount = supplierDebtMap[item.id] ?? 0;
            const reorderCount = reorderMap[item.id] ?? 0;
            const lastLivraison = lastLivraisonMap[item.id];
            return (
              <Pressable
                onLongPress={() => appAlert(item.name, undefined, [
                  { text: 'Modifier', onPress: () => { setEditF(item); setShowForm(true); } },
                  { text: 'Enregistrer une dette', onPress: () => openDebt(item) },
                  {
                    text: 'Supprimer', style: 'destructive', onPress: () =>
                      appAlert('Supprimer ?', 'Les produits liés seront dissociés. Cette action est irréversible.', [
                        { text: 'Annuler', style: 'cancel' },
                        {
                          text: 'Supprimer', style: 'destructive', onPress: async () => {
                            const { ok, message } = await deleteFournisseur(item.id, businessId);
                            if (ok) haptics.destructive(); else haptics.error();
                            if (ok) toast.success(supplierDeletedConfirmation(item.name));
                            else failAlert('supplierNotDeleted', { why: message ?? undefined });
                          }
                        },
                      ])
                  },
                  { text: 'Annuler', style: 'cancel' },
                ])}
                onPress={() => router.push(`/fournisseurs/${item.id}`)}
                style={({ pressed }) => [
                  styles.fRow,
                  owedAmount > 0 && styles.fRowDebt,
                  pressed && { opacity: 0.7 },
                ]}>

                {/* Avatar + reorder badge */}
                <View>
                  <View style={[styles.fAvatar, { backgroundColor: ac.bg }]}>
                    <Text allowFontScaling={false} style={[styles.fInitials, { color: ac.text }]}>{initials}</Text>
                  </View>
                  {reorderCount > 0 && (
                    <View style={styles.reorderBadge}>
                      <Text style={styles.reorderBadgeText}>{reorderCount}</Text>
                    </View>
                  )}
                </View>

                <View style={{ flex: 1, gap: 3 }}>
                  <Text variant="label" numberOfLines={1}>{item.name}</Text>
                  <MoneyText variant="caption" color="secondary">
                    {lastLivraison
                      ? `${formatDate(lastLivraison.ordered_at, 'dayMonth')} · ${fmt(lastLivraison.total_cost, currency)}`
                      : 'Aucune livraison'}
                  </MoneyText>
                  {owedAmount > 0 && oldestDebtDateMap[item.id] ? (
                    <Text
                      variant="caption"
                      color="secondary"
                    >
                      {fmtDebtAge(oldestDebtDateMap[item.id])}
                    </Text>
                  ) : null}
                </View>

                <View style={{ alignItems: 'flex-end', gap: 4 }}>
                  {owedAmount > 0 && (
                    <MoneyText variant="label" style={{ color: palette.warning }}>
                      − {fmt(owedAmount, currency)}
                    </MoneyText>
                  )}
                </View>

                <Ionicons name="chevron-forward" size={16} color={palette.textDisabled} />
              </Pressable>
            );
          }}
        />
      )}

      <FournisseurForm
        visible={showForm} editing={editF} products={products} fournisseurs={fournisseurs}
        businessId={businessId} userId={userId} currency={currency}
        onClose={() => { setShowForm(false); setEditF(null); }}
        saving={isSaving} onSave={handleSaveFournisseur}
      />

      <SuccessSheet
        visible={showSuccessSheet} fournisseur={createdFournisseur}
        onLivraison={() => {
          setShowSuccessSheet(false);
          if (createdFournisseur) router.push({ pathname: '/(app)/fournisseurs/reception', params: { supplierId: createdFournisseur.id } });
        }}
        onDette={() => createdFournisseur && openDebt(createdFournisseur)}
        onDismiss={() => { setShowSuccessSheet(false); setCreatedFournisseur(null); }}
      />

      <DebtModal
        visible={showDebtModal} fournisseur={debtTarget} currency={currency} saving={saving}
        onClose={() => { setShowDebtModal(false); setDebtTarget(null); }}
        onSave={async (amount, description, date) => {
          if (!debtTarget) return;
          const ok = await createDebt(businessId, userId, { supplierId: debtTarget.id, amount, description, date });
          if (ok) {
            haptics.success();
            setShowDebtModal(false);
            setDebtTarget(null);
          } else {
            haptics.error();
            toast.warning(useFournisseursStore.getState().error ?? 'Impossible d\'enregistrer la dette');
          }
        }}
      />

      {fournisseurs.length > 0 && (
        <View style={[styles.fabContainer, { bottom: insets.bottom + spacing[6] }]}>
          <Pressable
            onPress={() => router.push('/(app)/fournisseurs/reception')}
            style={({ pressed }) => [styles.fabExtended, pressed && { opacity: 0.82 }]}
            accessibilityLabel="Nouvelle livraison"
            accessibilityRole="button"
          >
            <Ionicons name="add" size={20} color={palette.textInverse} />
            <Text style={styles.fabExtendedLabel}>Livraison</Text>
          </Pressable>
        </View>
      )}
    </Screen>
  );
}

function makeStyles(p: Palette) {
  return StyleSheet.create({
    safe: { flex: 1, backgroundColor: p.background },
    hdr: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: spacing[5], borderBottomWidth: 1, borderBottomColor: p.border },
    list: { paddingTop: spacing[2], paddingBottom: spacing[10] },
    fRow: {
      flexDirection: 'row', alignItems: 'center', gap: spacing[3],
      marginHorizontal: spacing[4], marginTop: spacing[3],
      paddingHorizontal: spacing[4], paddingVertical: spacing[4],
      backgroundColor: p.surface,
      borderRadius: 16,
      borderWidth: StyleSheet.hairlineWidth, borderColor: p.border,
      shadowColor: p.shadow, shadowOffset: { width: 0, height: 2 },
      shadowOpacity: 0.06, shadowRadius: 8, elevation: 3,
    },
    fRowDebt: {
      borderLeftWidth: 3,
      borderLeftColor: p.warning,
    },
    fAvatar: { width: 46, height: 46, borderRadius: 23, alignItems: 'center', justifyContent: 'center' },
    fInitials: { fontFamily: fontFamily.bold, fontSize: 17 },
    reorderBadge: {
      position: 'absolute', top: -4, right: -4,
      width: 18, height: 18, borderRadius: 9,
      backgroundColor: p.warning,
      alignItems: 'center', justifyContent: 'center',
      borderWidth: 2, borderColor: p.background,
    },
    reorderBadgeText: { fontFamily: fontFamily.bold, fontSize: 10, color: p.textInverse },
    summaryBar: {
      paddingHorizontal: spacing[5], paddingTop: spacing[3], paddingBottom: spacing[1],
    },
    empty: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: spacing[4] },
    center: { textAlign: 'center', marginTop: spacing[10] },

    // Modals shared
    modalSafe: { flex: 1, backgroundColor: p.background },
    mhdr: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: spacing[5], borderBottomWidth: 1, borderBottomColor: p.border },
    mpad: { padding: spacing[5], gap: spacing[4], paddingBottom: spacing[10] },
    // Soft upward shadow instead of a hard top border — matches
    // catalogue.tsx's product-form footer (see CLAUDE.md); a flat border
    // read as a stray rectangle sitting behind the button.
    mfooter: { padding: spacing[5] }, // no slab: the button's own fill is the button

    // Form — product selector
    dropdownTrigger: {
      flex: 1, flexDirection: 'row', alignItems: 'center', gap: spacing[2],
      paddingHorizontal: spacing[3], paddingVertical: spacing[2.5],
      borderRadius: radius.md, borderWidth: 1, borderColor: p.border,
      backgroundColor: p.surface,
    },
    prodDropdown: {
      maxHeight: 150,
      borderWidth: 1, borderColor: p.border, borderRadius: radius.md,
      backgroundColor: p.surface,
    },
    prodDropdownItem: {
      flexDirection: 'row', alignItems: 'center', gap: spacing[2],
      paddingHorizontal: spacing[3], paddingVertical: spacing[3],
      borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: p.border,
    },
    // FAB — main screen. Extended (icon + label), never a bare "+": an
    // icon-only action button can't be recognized by name, only by shape.
    fabContainer: { position: 'absolute', bottom: 194, right: spacing[4], zIndex: 10 },
    fabExtended: {
      flexDirection: 'row', alignItems: 'center', gap: spacing[2],
      height: 56, paddingHorizontal: spacing[5], borderRadius: radius.full,
      backgroundColor: p.primary,
      shadowColor: p.shadow, shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.18, shadowRadius: 8, elevation: 8,
    },
    fabExtendedLabel: { fontFamily: fontFamily.semibold, fontSize: 15, color: p.textInverse },
    // Success sheet
    successTop: { alignItems: 'center', paddingVertical: spacing[4] },
    successBadge: { width: 64, height: 64, borderRadius: 32, backgroundColor: p.successLight, alignItems: 'center', justifyContent: 'center', marginBottom: spacing[4] },
    outlineBtn: { width: '100%', borderWidth: 1, borderColor: p.primary, borderRadius: radius.md, paddingVertical: 14, alignItems: 'center', marginBottom: spacing[2] },

    // Debt modal
    debtCtx: { gap: spacing[1], paddingVertical: spacing[2] },
    dr: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  });
}
