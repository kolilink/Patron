import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ConfirmSheetHost } from '@/src/components/ui/ConfirmSheet';
import { appAlert } from '@/src/utils/appAlert';
import { AnimatedRowCell, AnimatedRow } from '@/src/components/ui/AnimatedRow';
import { useInFlight } from '@/src/hooks/useInFlight';
import { LoadingStatus } from '@/src/components/ui/LoadingStatus';
import { Animated, Easing, FlatList, InputAccessoryView, Linking, Modal, Platform, Pressable, ScrollView, Share, StyleSheet, TextInput, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Screen } from '@/src/components/ui/Screen';
import { FormSheet } from '@/src/components/ui/FormSheet';
import { router, useFocusEffect } from 'expo-router';
import { AppSheet } from '@/src/components/ui/AppSheet';
import { SkeletonList } from '@/src/components/ui/SkeletonPlaceholder';
import { DataState } from '@/src/components/ui/DataState';
import { OfflineNotice } from '@/src/components/ui/OfflineNotice';
import { EmptyState } from '@/src/components/ui/EmptyState';
import { Button } from '@/src/components/ui/Button';
import { Card } from '@/src/components/ui/Card';
import { Input } from '@/src/components/ui/Input';
import { Text } from '@/src/components/ui/Text';
import { useTheme, spacing, radius, fontFamily as FF, SEARCH_VISIBILITY_THRESHOLD } from '@/src/theme';
import { useAnimateLayoutChange } from '@/src/hooks/useAnimateLayoutChange';
import type { Palette } from '@/src/theme';
import { useAuthStore } from '@/stores/auth';
import { generateFallbackName } from '@/lib/id';
import { useEquipeStore, type Membre } from '@/stores/equipe';
import { useProductStore } from '@/stores/products';
import { useInvestorStore } from '@/stores/investor';
import { useAportsStore } from '@/stores/apports';
import { haptics } from '@/lib/haptics';
import { formatAmount, formatAmountInput, parseAmountInput } from '@/src/utils/format';
import { toast } from '@/stores/toast';
import type { Role, MemberProductStake, Product } from '@/src/types';
import { showFailureAlert } from '@/src/components/ui/FailureView';
import { buildFailure, failureReason } from '@/src/utils/failure';
import { FAILURE_COPY } from '@/src/utils/failureCopy';
import { memberRemovedConfirmation, inviteCodeRevokedConfirmation, stakeRemovedConfirmation, partnerRemovedConfirmation, supplierDeletedConfirmation, saleCancelledConfirmation } from '@/src/utils/saveConfirmationCopy';
import { failAlert } from '@/src/components/ui/FailureView';
import { formatDate } from '@/src/utils/dates';

// iOS-only: suppresses the OS's auto-injected floating "Done" pill above
// the numeric keyboard — the payout sheet's "Confirmer le paiement" button
// sits immediately after the amount field in this compact backdrop+panel
// sheet, always visible without scrolling, so the pill is redundant.
// Deliberately NOT applied to the per-product investisseur stake field
// above it — that field lives in a potentially long scrollable list, and
// "Enregistrer les montants" only appears after every row, not as a sticky
// footer, so it isn't reliably visible while editing an earlier row.
const PAYOUT_SHEET_SILENT_ACCESSORY_ID = 'equipe-payout-sheet-silent-accessory';

const ROLES: Role[] = ['manager', 'vendeur', 'investisseur'];

const ROLE_LABELS: Record<Role, string> = {
  administrateur: 'Gérant', manager: 'Gérant', vendeur: 'Vendeur', investisseur: 'Observateur',
};

const ROLE_BADGE_LABELS: Record<Role, string> = {
  administrateur: 'Gérant', manager: 'Gérant', vendeur: 'Vendeur', investisseur: 'Observateur',
};

// The member list groups by role instead of color-coding a badge per row —
// who can do what reads from which group someone is in, not from comparing
// pill colors. administrateur and manager share one group since both are
// labeled "Gérant" to the user (see ROLE_LABELS above).
const MEMBER_GROUPS: { key: string; title: string; description: string; roles: Role[] }[] = [
  { key: 'gerants', title: 'Gérants', description: 'Accès complet', roles: ['administrateur', 'manager'] },
  { key: 'vendeurs', title: 'Vendeurs', description: 'Vente et crédit', roles: ['vendeur'] },
  { key: 'observateurs', title: 'Observateurs', description: 'Lecture seule', roles: ['investisseur'] },
];

const ROLE_DESCRIPTIONS: Record<string, string> = {
  manager: 'Gère le commerce sans pouvoir le supprimer',
  vendeur: 'Enregistre les ventes uniquement',
  investisseur: 'Voit les chiffres, ne touche à rien',
};


// Neutral for every role — color used to differ per role (and the same
// "Gérant" label rendered in two different colors depending on whether the
// person was technically an administrateur or a manager, which read as a
// real inconsistency). Role is information, not a state to accent; the
// member list communicates it structurally now (grouped sections) instead.
function RoleBadge({ role }: { role: string }) {
  const { palette } = useTheme();
  const styles = useMemo(() => makeStyles(palette), [palette]);
  return (
    <View style={styles.badge}>
      <Text variant="labelSmall" color="secondary" style={{ textTransform: 'capitalize' }}>
        {ROLE_BADGE_LABELS[role as Role] ?? role}
      </Text>
    </View>
  );
}

// ─── Product Scope Picker ─────────────────────────────────────────────────────

interface ProductScopePickerProps {
  visible: boolean;
  onClose: () => void;
  products: Product[];
  selectedIds: Set<string>;
  onConfirm: (ids: string[]) => void;
  currency: string;
}

function ProductScopePicker({ visible, onClose, products, selectedIds, onConfirm, currency }: ProductScopePickerProps) {
  const { palette } = useTheme();
  const styles = useMemo(() => makeStyles(palette), [palette]);
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (visible) {
      setSelected(new Set(selectedIds));
      setSearch('');
    }
  }, [visible, selectedIds]);

  const filtered = useMemo(() => {
    const q = search.toLowerCase().trim();
    return q ? products.filter(p => p.name.toLowerCase().includes(q)) : products;
  }, [products, search]);

  const searchVisible = products.length >= SEARCH_VISIBILITY_THRESHOLD;
  useAnimateLayoutChange(searchVisible);
  useEffect(() => {
    if (!searchVisible) setSearch('');
  }, [searchVisible]);

  const toggle = (id: string) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  return (
    <FormSheet
      visible={visible}
      onClose={onClose}
      title="Choisir les produits"
      headerRight={
        <Pressable onPress={() => onConfirm([...selected])}>
          <Text variant="label" style={{ color: palette.primary }}>Confirmer</Text>
        </Pressable>
      }
      scrollable={false}
    >
      {searchVisible && (
        <View style={styles.pickerSearch}>
          <TextInput
            style={[styles.pickerSearchInput, { color: palette.textPrimary }]}
            placeholder="Rechercher un produit…"
            placeholderTextColor={palette.textDisabled}
            value={search}
            onChangeText={setSearch}
          />
          {search.length > 0 && (
            <Pressable onPress={() => setSearch('')} hitSlop={8}>
              <Ionicons name="close-circle" size={16} color={palette.textDisabled} />
            </Pressable>
          )}
        </View>
      )}

      <FlatList
        data={filtered}
        keyExtractor={p => p.id}
        renderItem={({ item }) => {
          const checked = selected.has(item.id);
          return (
            <Pressable
              onPress={() => toggle(item.id)}
              style={({ pressed }) => [styles.pickerRow, pressed && { opacity: 0.7 }]}
            >
              <View style={[styles.pickerCheck, checked && { backgroundColor: palette.primary, borderColor: palette.primary }]}>
                {checked && <Ionicons name="checkmark" size={12} color={palette.textInverse} />}
              </View>
              <View style={{ flex: 1 }}>
                <Text variant="body">{item.name}</Text>
                <Text variant="caption" color="secondary">{formatAmount(item.sale_price, currency)}</Text>
              </View>
            </Pressable>
          );
        }}
        ItemSeparatorComponent={() => <View style={{ height: 1, backgroundColor: palette.border }} />}
        contentContainerStyle={{ paddingBottom: spacing[10] }}
        ListEmptyComponent={
          <View style={{ alignItems: 'center', padding: spacing[10] }}>
            <Text variant="body" color="secondary">Aucun produit trouvé</Text>
          </View>
        }
      />
    </FormSheet>
  );
}

// ─── Member Detail Sheet ──────────────────────────────────────────────────────

interface MemberDetailSheetProps {
  visible: boolean;
  membre: Membre | null;
  myMembershipId: string;
  onClose: () => void;
  hasManager: boolean;
  businessId: string;
  currency: string;
  products: Product[];
}

function MemberDetailSheet({
  visible, membre, myMembershipId, onClose, hasManager, businessId, currency, products,
}: MemberDetailSheetProps) {
  const { palette } = useTheme();
  const styles = useMemo(() => makeStyles(palette), [palette]);
  const { saving, changeRole, removeMembre, fetchMemberScope, setMemberScope, removeScopeProduct, updateDisplayName, updateScopeAll } = useEquipeStore();
  const { balance, payouts, saving: investorSaving, offline: investorOffline, fetchBalance, fetchPayouts, confirmPayout } = useInvestorStore();
  const { apports, fetchApports } = useAportsStore();

  const [scope, setScope] = useState<MemberProductStake[]>([]);
  const [loadingScope, setLoadingScope] = useState(false);
  const [showPicker, setShowPicker] = useState(false);
  const [scopeAll, setScopeAll] = useState(true);

  // Display name editing
  const [editingName, setEditingName] = useState(false);
  const [draftName, setDraftName] = useState('');

  // Draft profit-share % per product for investisseurs
  const [draftStakes, setDraftStakes] = useState<Record<string, string>>({});

  // Payout confirmation
  // "Retirer" is the control that started the revoke: it shows the progress
  // itself and swallows further taps until the request settles. (Declared above
  // the `!membre` early return — hooks must run on every render.)
  const [removing, runRemove] = useInFlight();
  const [showPayoutSheet, setShowPayoutSheet] = useState(false);
  const [payoutAmountStr, setPayoutAmountStr] = useState('');
  const [pendingPayoutId, setPendingPayoutId] = useState<string | null>(null);

  const isInvestisseur = membre?.role === 'investisseur';

  useEffect(() => {
    if (!visible || !membre) return;
    setScopeAll(membre.scope_all_products);
    setDraftName(membre.display_name ?? '');
    setEditingName(false);
    setLoadingScope(true);
    fetchMemberScope(membre.id).then(rows => {
      setScope(rows);
      const draft: Record<string, string> = {};
      rows.forEach(r => { draft[r.product_id] = r.profit_share > 0 ? String(r.profit_share) : ''; });
      setDraftStakes(draft);
      setLoadingScope(false);
    });
    if (isInvestisseur && membre.user_id) {
      fetchBalance(businessId, membre.user_id);
      fetchPayouts(businessId, membre.user_id);
      fetchApports(businessId);
    }
  }, [visible, membre?.id]);

  if (!membre) return null;
  const isSelf = membre.id === myMembershipId;
  const displayedName = membre.display_name ?? membre.user_name;

  const handleSaveName = async () => {
    const ok = await updateDisplayName(membre.id, draftName.trim() || null);
    if (ok) { haptics.success(); setEditingName(false); }
  };

  const handleToggleScopeAll = async (val: boolean) => {
    setScopeAll(val);
    const ok = await updateScopeAll(membre.id, val);
    if (ok) {
      haptics.success();
    } else {
      haptics.error();
      showFailureAlert(buildFailure({
        what: FAILURE_COPY.memberStakesNotSaved.what,
        why: failureReason(useEquipeStore.getState().error),
        action: { label: 'Réessayer', onPress: () => { void handleToggleScopeAll(val); } },
      }));
    }
  };

  const handleSaveScope = async (ids: string[]) => {
    setShowPicker(false);
    const stakes = ids.map(pid => ({
      productId: pid,
      contribution: 0,
      profitShare: parseFloat(draftStakes[pid] || '0') || 0,
    }));
    const ok = await setMemberScope(membre.id, stakes);
    if (ok) {
      haptics.success();
      const rows = await fetchMemberScope(membre.id);
      setScope(rows);
      const draft: Record<string, string> = {};
      rows.forEach(r => { draft[r.product_id] = r.profit_share > 0 ? String(r.profit_share) : ''; });
      setDraftStakes(draft);
    } else {
      haptics.error();
      showFailureAlert(buildFailure({
        what: FAILURE_COPY.memberStakesNotSaved.what,
        why: failureReason(useEquipeStore.getState().error),
        action: { label: 'Réessayer', onPress: () => { void handleSaveScope(ids); } },
      }));
    }
  };

  const handleSaveStakeEdits = async () => {
    const stakes = scope.map(s => ({
      productId: s.product_id,
      contribution: 0,
      profitShare: parseFloat(draftStakes[s.product_id] || '0') || 0,
    }));
    const ok = await setMemberScope(membre.id, stakes);
    if (ok) {
      haptics.success();
    } else {
      haptics.error();
      showFailureAlert(buildFailure({
        what: FAILURE_COPY.memberStakesNotSaved.what,
        why: failureReason(useEquipeStore.getState().error),
        action: { label: 'Réessayer', onPress: () => { void handleSaveStakeEdits(); } },
      }));
    }
  };

  const handleRemoveProduct = (productId: string, productName: string) => {
    appAlert(`Retirer "${productName}" ?`, 'Ce membre n\'aura plus accès aux données de ce produit.', [
      { text: 'Annuler', style: 'cancel' },
      {
        text: 'Retirer',
        style: 'destructive',
        onPress: async () => {
          const ok = await removeScopeProduct(membre.id, productId);
          if (ok) {
            haptics.destructive();
            toast.success(stakeRemovedConfirmation(productName, membre.display_name ?? membre.user_name ?? generateFallbackName(membre.user_id)));
            const rows = await fetchMemberScope(membre.id);
            setScope(rows);
          } else {
            haptics.error();
            showFailureAlert(buildFailure({
              what: FAILURE_COPY.memberStakeNotRemoved.what,
              why: failureReason(useEquipeStore.getState().error),
              action: { label: 'Réessayer', onPress: () => { void removeScopeProduct(membre.id, productId).then(async ok2 => { if (ok2) setScope(await fetchMemberScope(membre.id)); }); } },
            }));
          }
        },
      },
    ]);
  };

  const handleChangeRole = () => {
    const otherRoles = ROLES.filter(r => r !== membre.role);
    appAlert('Nouveau rôle', undefined, [
      ...otherRoles.map(r => ({
        text: ROLE_LABELS[r],
        onPress: () => {
          if (r === 'manager' && hasManager) return;
          changeRole(membre.id, r).then(ok => {
            if (ok) {
              onClose();
            } else {
              haptics.error();
              toast.warning(useEquipeStore.getState().error ?? 'Impossible de modifier le rôle');
            }
          });
        },
      })),
      { text: 'Annuler', style: 'cancel' },
    ]);
  };

  const handleRemove = () => {
    appAlert('Retirer ' + (membre.user_name || generateFallbackName(membre.user_id)) + ' ?', 'Ses ventes restent enregistrées dans le commerce.', [
      { text: 'Annuler', style: 'cancel' },
      {
        text: 'Retirer',
        style: 'destructive',
        onPress: () => {
          void runRemove(async () => {
            const ok = await removeMembre(membre.id);
            if (ok) {
              haptics.destructive();
              // A removed member can only come back through a new invitation, so there is no
              // Annuler — the message names exactly who was removed.
              toast.success(memberRemovedConfirmation(membre.user_name || generateFallbackName(membre.user_id)));
              onClose();
            } else {
              haptics.error();
              failAlert('memberNotRemoved', {
                err: useEquipeStore.getState().error, label: 'Réessayer',
                onPress: () => { void removeMembre(membre.id).then(ok2 => { if (ok2) { toast.success(memberRemovedConfirmation(membre.user_name || generateFallbackName(membre.user_id))); onClose(); } }); },
              });
            }
          });
        },
      },
    ]);
  };

  const scopeIds = new Set(scope.map(s => s.product_id));
  const noScope = scope.length === 0;

  return (
    <>
      <FormSheet
        visible={visible}
        onClose={onClose}
        title={displayedName}
        cancelLabel="Fermer"
        contentContainerStyle={styles.mpad}
      >
        {/* Identity */}
        <View style={styles.identityRow}>
          <View style={styles.avatar}>
            <Text variant="h4" allowFontScaling={false} style={{ color: palette.textSecondary }}>
              {displayedName[0]?.toUpperCase()}
            </Text>
          </View>
          <View style={{ flex: 1, gap: 2 }}>
            <Text variant="label">{displayedName}</Text>
            {membre.display_name && (
              <Text variant="caption" color="secondary">Vrai nom : {membre.user_name}</Text>
            )}
            {membre.user_phone
              ? <Text variant="caption" color="secondary">{membre.user_phone}</Text>
              : <Text variant="caption" color="secondary">{membre.user_email !== '—' ? membre.user_email : 'Pas de contact'}</Text>
            }
          </View>
          <RoleBadge role={membre.role} />
        </View>

        {/* Name edit */}
        {editingName ? (
          <View style={styles.nameEditRow}>
            <TextInput
              style={[styles.nameEditInput, { color: palette.textPrimary, borderColor: palette.border }]}
              value={draftName}
              onChangeText={setDraftName}
              placeholder="Nom affiché (visible que par vous)"
              placeholderTextColor={palette.textDisabled}
              autoFocus
            />
            <Pressable onPress={handleSaveName} style={[styles.nameEditBtn, { backgroundColor: palette.primary }]}>
              <Text variant="label" style={{ color: palette.textInverse }}>OK</Text>
            </Pressable>
            <Pressable onPress={() => setEditingName(false)} accessibilityLabel="Fermer" accessibilityRole="button">
              <Ionicons name="close" size={20} color={palette.textSecondary} />
            </Pressable>
          </View>
        ) : (
          <Pressable style={styles.nameEditTrigger} onPress={() => setEditingName(true)}>
            <Ionicons name="pencil-outline" size={14} color={palette.primary} />
            <Text variant="bodySmall" style={{ color: palette.primary }}>
              {membre.display_name ? 'Modifier le surnom' : 'Donner un surnom'}
            </Text>
          </Pressable>
        )}

        {/* Role + Remove actions */}
        {!isSelf && (
          <View style={styles.actionRow}>
            <Pressable style={styles.actionBtn} onPress={handleChangeRole} disabled={removing}>
              <Ionicons name="swap-horizontal-outline" size={18} color={palette.primary} />
              <Text variant="bodySmall" style={{ color: palette.primary }}>Changer le rôle</Text>
            </Pressable>
            <View style={styles.actionDivider} />
            <Pressable style={styles.actionBtn} onPress={handleRemove} disabled={removing}>
              {removing ? (
                <LoadingStatus word="Retrait" color={palette.textSecondary} variant="bodySmall" />
              ) : (
                <>
                  <Ionicons name="person-remove-outline" size={18} color={palette.danger} />
                  <Text variant="bodySmall" style={{ color: palette.danger }}>Retirer</Text>
                </>
              )}
            </Pressable>
          </View>
        )}

        {/* Investor balance + payout section */}
        {isInvestisseur && (
          <>
            <View style={styles.sectionHdr}>
              <Text variant="label">Investissement</Text>
            </View>

            {investorOffline && (
              <Text variant="caption" color="secondary" style={{ paddingHorizontal: spacing[4] }}>
                Hors ligne — dernières données connues
              </Text>
            )}

            {(() => {
              const totalInvested = apports
                .filter(a => a.injected_by_id === membre.user_id)
                .reduce((s, a) => s + a.amount, 0);
              return totalInvested > 0 ? (
                <View style={[styles.scopeRow, { flexDirection: 'column', alignItems: 'flex-start', gap: spacing[1] }]}>
                  <Text variant="caption" color="secondary">Capital investi</Text>
                  <Text style={{ fontFamily: FF.bold, fontSize: 22, lineHeight: 30, color: palette.primary }}>
                    {formatAmount(totalInvested, currency)}
                  </Text>
                </View>
              ) : null;
            })()}

            <View style={[styles.scopeRow, { flexDirection: 'column', alignItems: 'flex-start', gap: spacing[1] }]}>
              <Text variant="caption" color="secondary">Part des bénéfices accumulée</Text>
              <Text style={{ fontFamily: FF.bold, fontSize: 22, lineHeight: 30, color: palette.textPrimary }}>
                {formatAmount(balance ?? 0, currency)}
              </Text>
            </View>

            {/* Pending payout request */}
            {(() => {
              const pending = payouts.find(p => p.status === 'en_attente');
              if (!pending) return null;
              return (
                <View style={[styles.scopeRow, { backgroundColor: palette.warning + '12', borderColor: palette.warning, gap: spacing[3] }]}>
                  <View style={{ flex: 1 }}>
                    <Text variant="label" style={{ color: palette.warning }}>Demande de retrait</Text>
                    <Text variant="caption" color="secondary">
                      {formatAmount(pending.requested_amount, currency)} demandé
                    </Text>
                  </View>
                  <Pressable
                    onPress={() => {
                      setPendingPayoutId(pending.id);
                      setPayoutAmountStr(formatAmountInput(String(Math.round(pending.requested_amount)), currency));
                      setShowPayoutSheet(true);
                    }}
                    style={[styles.assignBtn, { paddingVertical: 0 }]}
                  >
                    <Text variant="label" style={{ color: palette.primary }}>Enregistrer le paiement</Text>
                  </Pressable>
                </View>
              );
            })()}

            {/* Recent paid payouts */}
            {payouts.filter(p => p.status === 'paye').slice(0, 3).map(p => (
              <View key={p.id} style={[styles.scopeRow, { flexDirection: 'row', alignItems: 'center', gap: spacing[3] }]}>
                <Ionicons name="checkmark-circle-outline" size={16} color={palette.success} />
                <View style={{ flex: 1 }}>
                  <Text variant="body">{formatAmount(p.paid_amount ?? p.requested_amount, currency)}</Text>
                  <Text variant="caption" color="secondary">
                    {formatDate(p.paid_at ?? p.requested_at, 'short')}
                  </Text>
                </View>
              </View>
            ))}
          </>
        )}

        {/* Product scope section (vendeur or investisseur only) */}
        {(membre.role === 'vendeur' || membre.role === 'investisseur') && (
          <>
            <View style={styles.sectionHdr}>
              <Text variant="label">Produits assignés</Text>
              {!scopeAll && scope.length > 0 && (
                <View style={[styles.badge, { backgroundColor: palette.primary + '20' }]}>
                  <Text variant="labelSmall" style={{ color: palette.primary }}>{scope.length}</Text>
                </View>
              )}
            </View>

            {/* Scope all toggle — vendeur only */}
            {membre.role === 'vendeur' && (
              <Pressable
                style={[styles.scopeToggleRow, { borderColor: scopeAll ? palette.primary : palette.border }]}
                onPress={() => handleToggleScopeAll(!scopeAll)}
              >
                <View style={{ flex: 1, gap: 2 }}>
                  <Text variant="label">Accès à tous les produits</Text>
                  <Text variant="caption" color="secondary">
                    {scopeAll ? 'Ce vendeur peut vendre n\'importe quel produit' : 'Limité aux produits ci-dessous'}
                  </Text>
                </View>
                <View style={[styles.toggleTrack, { backgroundColor: scopeAll ? palette.primary : palette.border }]}>
                  <View style={[styles.toggleThumb, { left: scopeAll ? 18 : 2 }]} />
                </View>
              </Pressable>
            )}

            {!scopeAll && membre.role === 'vendeur' && scope.length === 0 && (
              <View style={[styles.scopeRow, { backgroundColor: palette.warningLight, borderColor: palette.warning }]}>
                <Ionicons name="warning-outline" size={16} color={palette.warning} />
                <Text variant="caption" style={{ flex: 1, color: palette.warning }}>
                  Aucun produit assigné — ce vendeur ne peut pas vendre tant que vous n'en ajoutez pas.
                </Text>
              </View>
            )}

            {scopeAll && membre.role !== 'vendeur' && (
              <View style={[styles.allProductsChip]}>
                <Ionicons name="cube-outline" size={14} color={palette.textSecondary} />
                <Text variant="bodySmall" color="secondary">Tous les produits</Text>
              </View>
            )}

            {(!scopeAll || isInvestisseur) && (
              loadingScope ? (
                <Text variant="caption" color="secondary">Chargement…</Text>
              ) : (
                scope.map(s => (
                  <AnimatedRow key={s.product_id} id={s.product_id} style={[styles.scopeRow, isInvestisseur && { flexDirection: 'column', alignItems: 'stretch', gap: spacing[3] }]}>
                    <View style={styles.scopeRowTop}>
                      <Text variant="body" style={{ flex: 1 }} numberOfLines={2}>{s.product_name}</Text>
                      <Pressable
                        onPress={() => handleRemoveProduct(s.product_id, s.product_name)}
                        hitSlop={8}
                        style={{ flexDirection: 'row', alignItems: 'center', gap: spacing[1] }}
                      >
                        <Ionicons name="trash-outline" size={16} color={palette.textSecondary} />
                        <Text variant="caption" color="secondary">Retirer</Text>
                      </Pressable>
                    </View>

                    {isInvestisseur && (
                      <View style={{ gap: spacing[1] }}>
                        <Text style={styles.stakeLabel}>Part des bénéfices (%)</Text>
                        <TextInput
                          style={[styles.stakeInput, { color: palette.textPrimary, borderColor: palette.border }]}
                          value={draftStakes[s.product_id] ?? ''}
                          onChangeText={v => setDraftStakes(prev => ({ ...prev, [s.product_id]: v }))}
                          keyboardType="decimal-pad"
                          placeholder="0"
                          placeholderTextColor={palette.textDisabled}
                        />
                      </View>
                    )}
                  </AnimatedRow>
                ))
              )
            )}

            {isInvestisseur && scope.length > 0 && (
              <Button
                label="Enregistrer les montants" loadingLabel="Enregistrement"
                variant="secondary"
                size="sm"
                onPress={handleSaveStakeEdits}
                loading={saving}
                style={{ marginTop: spacing[2] }}
              />
            )}

            {(!scopeAll || isInvestisseur) && (
              <Pressable style={styles.assignBtn} onPress={() => setShowPicker(true)}>
                <Ionicons name="add-circle-outline" size={16} color={palette.primary} />
                <Text variant="label" style={{ color: palette.primary }}>
                  {scope.length === 0 ? 'Assigner des produits' : 'Modifier les produits'}
                </Text>
              </Pressable>
            )}
          </>
        )}
      </FormSheet>

      <ProductScopePicker
        visible={showPicker}
        onClose={() => setShowPicker(false)}
        products={products}
        selectedIds={scopeIds}
        onConfirm={handleSaveScope}
        currency={currency}
      />

      {/* Payout confirmation sheet */}
      <Modal
        visible={showPayoutSheet}
        transparent
        animationType="slide"
        onRequestClose={() => setShowPayoutSheet(false)}
        statusBarTranslucent
        navigationBarTranslucent
      >
        <Pressable style={styles.payoutBackdrop} onPress={() => setShowPayoutSheet(false)}>
          <Pressable style={[styles.payoutPanel, { backgroundColor: palette.surface }]} onPress={() => { }}>
            <View style={[styles.payoutHandle, { backgroundColor: palette.border }]} />
            <Text variant="h4">Enregistrer le paiement</Text>
            <Text variant="caption" color="secondary" style={{ textAlign: 'center' }}>
              Montant réellement versé à {membre?.user_name ?? generateFallbackName(membre?.user_id ?? '')}
            </Text>

            <View style={{ width: '100%', gap: spacing[2] }}>
              <Text variant="label">Montant versé</Text>
              <View style={[styles.payoutInput, { borderColor: palette.border, backgroundColor: palette.background }]}>
                <TextInput
                  style={{ flex: 1, fontSize: 28, fontWeight: '700', color: palette.textPrimary }}
                  value={payoutAmountStr}
                  onChangeText={v => setPayoutAmountStr(formatAmountInput(v, currency))}
                  keyboardType="numeric"
                  placeholder="0"
                  placeholderTextColor={palette.textDisabled}
                  selectTextOnFocus
                  inputAccessoryViewID={Platform.OS === 'ios' ? PAYOUT_SHEET_SILENT_ACCESSORY_ID : undefined}
                />
                <Text variant="label" color="secondary">{currency}</Text>
              </View>
            </View>

            <Button
              label="Confirmer le paiement" loadingLabel="Enregistrement"
              fullWidth
              size="lg"
              loading={investorSaving}
              onPress={async () => {
                if (!pendingPayoutId) return;
                const amt = parseAmountInput(payoutAmountStr, currency);
                if (!amt || amt <= 0) { toast.warning('Entrez un montant valide'); return; }
                const amtCents = BigInt(Math.round(amt * 100));
                const ok = await confirmPayout(pendingPayoutId, amtCents);
                if (ok) {
                  haptics.success();
                  toast.success('Paiement enregistré');
                  setShowPayoutSheet(false);
                  setPayoutAmountStr('');
                  setPendingPayoutId(null);
                  if (membre?.user_id) {
                    fetchBalance(businessId, membre.user_id);
                    fetchPayouts(businessId, membre.user_id);
                  }
                }
              }}
            />
            <Pressable onPress={() => setShowPayoutSheet(false)}>
              <Text variant="label" color="secondary">Annuler</Text>
            </Pressable>
          </Pressable>
        </Pressable>
        {Platform.OS === 'ios' && (
          <InputAccessoryView nativeID={PAYOUT_SHEET_SILENT_ACCESSORY_ID}>
            <View style={{ height: 0 }} />
          </InputAccessoryView>
        )}
      <ConfirmSheetHost active={!!(showPayoutSheet)} />
</Modal>
    </>
  );
}

// ─── Invite Code Modals ───────────────────────────────────────────────────────

interface NewCodeModalProps {
  visible: boolean; onClose: () => void;
  onGenerate: (role: Role, scopeAll: boolean, scopeProductIds: string[]) => Promise<void>; saving: boolean;
  hasManager: boolean;
  products: Product[];
  currency: string;
}

function NewCodeModal({ visible, onClose, onGenerate, saving, hasManager, products, currency }: NewCodeModalProps) {
  const { palette } = useTheme();
  const styles = useMemo(() => makeStyles(palette), [palette]);
  const [role, setRole] = useState<Role>('vendeur');
  const [hasInteracted, setHasInteracted] = useState(false);
  const [scopeAll, setScopeAll] = useState(true);
  const [scopeProductIds, setScopeProductIds] = useState<string[]>([]);
  const [scopeError, setScopeError] = useState(false);
  const pulseAnim = useRef(new Animated.Value(1)).current;
  const pulseRef = useRef<Animated.CompositeAnimation | null>(null);

  const managerLocked = role === 'manager' && hasManager;
  const orderedRoles = hasManager ? (['vendeur', 'investisseur', 'manager'] as Role[]) : ROLES;

  useEffect(() => {
    if (visible) {
      setHasInteracted(false);
      setRole('vendeur');
      setScopeAll(true);
      setScopeProductIds([]);
      setScopeError(false);
      pulseAnim.setValue(1);
    } else {
      pulseRef.current?.stop();
    }
  }, [visible]);

  useEffect(() => {
    if (hasInteracted && !saving) {
      pulseRef.current?.stop();
      pulseRef.current = Animated.loop(
        Animated.sequence([
          Animated.timing(pulseAnim, { toValue: 1.04, duration: 1800, useNativeDriver: true, easing: Easing.inOut(Easing.sin) }),
          Animated.timing(pulseAnim, { toValue: 1, duration: 2400, useNativeDriver: true, easing: Easing.inOut(Easing.sin) }),
        ]),
      );
      pulseRef.current.start();
    } else {
      pulseRef.current?.stop();
      pulseRef.current = null;
      pulseAnim.setValue(1);
    }
    return () => { pulseRef.current?.stop(); };
  }, [hasInteracted, saving]);

  const handleSelectRole = (r: Role) => {
    setRole(r);
    if (!hasInteracted) setHasInteracted(true);
  };

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="formSheet" onRequestClose={onClose} statusBarTranslucent navigationBarTranslucent backdropColor={palette.background}>
      <SafeAreaView style={styles.modalSafe}>
        <View style={styles.mhdr}>
          <Pressable onPress={onClose}><Text variant="body" color="secondary">Annuler</Text></Pressable>
          <Text variant="h4">Inviter quelqu'un</Text>
          <View style={{ width: 60 }} />
        </View>
        <ScrollView contentContainerStyle={styles.mpad}>
          <Text variant="body" color="secondary">
            Choisissez le rôle ci-dessous et un code valable de 24h sera créé pour votre nouveau membre.
          </Text>
          <Text variant="label">Rôle</Text>
          <View style={styles.roleGrid}>
            {orderedRoles.map(r => {
              const isManagerFull = r === 'manager' && hasManager;
              const isSelected = role === r;
              return (
                <Pressable key={r} onPress={() => handleSelectRole(r)}
                  style={[
                    styles.roleChip,
                    isSelected && { backgroundColor: palette.primary, borderColor: palette.primary },
                    isManagerFull && !isSelected && { opacity: 0.5 },
                  ]}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                    <Text variant="label" style={{ color: isSelected ? palette.textInverse : palette.textPrimary }}>
                      {ROLE_LABELS[r]}
                    </Text>
                    {isManagerFull && (
                      <View style={styles.fullBadge}>
                        <Text variant="labelSmall" style={{ color: palette.textSecondary }}>1/1</Text>
                      </View>
                    )}
                  </View>
                  <Text variant="caption" style={{ color: isSelected ? palette.textInverse : palette.textSecondary }}>
                    {ROLE_DESCRIPTIONS[r]}
                  </Text>
                </Pressable>
              );
            })}
          </View>
          {managerLocked && (
            <View style={styles.lockedNote}>
              <Ionicons name="time-outline" size={18} color={palette.warning} />
              <Text variant="bodySmall" style={{ flex: 1, color: palette.warning, fontFamily: FF.semibold, lineHeight: 20 }}>
                La gestion de plusieurs gérants arrive bientôt — restez à l'écoute 🙂
              </Text>
            </View>
          )}

          {/* Product scope — vendeur only */}
          {role === 'vendeur' && hasInteracted && (
            <>
              <Text variant="label">Accès aux produits</Text>
              <Pressable
                style={[styles.scopeToggleRow, { borderColor: scopeAll ? palette.primary : palette.border }]}
                onPress={() => { setScopeAll(true); setScopeProductIds([]); setScopeError(false); }}
              >
                <View style={{ flex: 1, gap: 2 }}>
                  <Text variant="label">Tous les produits</Text>
                  <Text variant="caption" color="secondary">Peut vendre n'importe quel produit</Text>
                </View>
                <View style={[styles.radioCircle, scopeAll && { borderColor: palette.primary }]}>
                  {scopeAll && <View style={[styles.radioDot, { backgroundColor: palette.primary }]} />}
                </View>
              </Pressable>
              <Pressable
                style={[styles.scopeToggleRow, { borderColor: !scopeAll ? palette.primary : palette.border }]}
                onPress={() => { setScopeAll(false); setScopeError(false); }}
              >
                <View style={{ flex: 1, gap: 2 }}>
                  <Text variant="label">Produits spécifiques</Text>
                  <Text variant="caption" color="secondary">
                    {!scopeAll && scopeProductIds.length > 0
                      ? `${scopeProductIds.length} produit${scopeProductIds.length > 1 ? 's' : ''} sélectionné${scopeProductIds.length > 1 ? 's' : ''}`
                      : 'Choisissez les produits autorisés'}
                  </Text>
                </View>
                <View style={[styles.radioCircle, !scopeAll && { borderColor: palette.primary }]}>
                  {!scopeAll && <View style={[styles.radioDot, { backgroundColor: palette.primary }]} />}
                </View>
              </Pressable>

              {/* Inline product checklist — appears immediately when Produits spécifiques is chosen */}
              {!scopeAll && (
                <View style={[styles.inlineProductList, scopeError && { borderColor: palette.warning }]}>
                  {scopeError && (
                    <Text variant="caption" style={{ color: palette.warning, paddingHorizontal: spacing[3], paddingTop: spacing[2] }}>
                      Sélectionnez au moins un produit
                    </Text>
                  )}
                  {products.map((p, idx) => {
                    const checked = scopeProductIds.includes(p.id);
                    return (
                      <Pressable
                        key={p.id}
                        onPress={() => {
                          setScopeError(false);
                          setScopeProductIds(prev =>
                            checked ? prev.filter(id => id !== p.id) : [...prev, p.id]
                          );
                        }}
                        style={({ pressed }) => [
                          styles.inlineProductRow,
                          idx > 0 && { borderTopWidth: 1, borderTopColor: palette.border },
                          pressed && { opacity: 0.7 },
                        ]}
                      >
                        <View style={[styles.pickerCheck, checked && { backgroundColor: palette.primary, borderColor: palette.primary }]}>
                          {checked && <Ionicons name="checkmark" size={12} color={palette.textInverse} />}
                        </View>
                        <View style={{ flex: 1 }}>
                          <Text variant="body">{p.name}</Text>
                          <Text variant="caption" color="secondary">{formatAmount(p.sale_price, currency)}</Text>
                        </View>
                      </Pressable>
                    );
                  })}
                  {products.length === 0 && (
                    <View style={{ padding: spacing[4], alignItems: 'center' }}>
                      <Text variant="caption" color="secondary">Aucun produit disponible</Text>
                    </View>
                  )}
                </View>
              )}
            </>
          )}
        </ScrollView>
        {!managerLocked && hasInteracted && (
          <View style={styles.mfooter}>
            <Animated.View style={{ transform: [{ scale: pulseAnim }] }}>
              <Button
                label="Générer le code" loadingLabel="Génération"
                loading={saving}
                fullWidth
                size="lg"
                onPress={() => {
                  if (role === 'vendeur' && !scopeAll && scopeProductIds.length === 0) {
                    setScopeError(true);
                    return;
                  }
                  onGenerate(role, role === 'vendeur' ? scopeAll : true, scopeProductIds);
                }}
              />
            </Animated.View>
          </View>
        )}
      </SafeAreaView>
    <ConfirmSheetHost active={!!(visible)} />
</Modal>
  );
}

interface CodeRevealModalProps {
  visible: boolean;
  code: string;
  role: Role;
  businessName: string;
  onClose: () => void;
}

function CodeRevealModal({ visible, code, role, businessName, onClose }: CodeRevealModalProps) {
  const { palette } = useTheme();
  const styles = useMemo(() => makeStyles(palette), [palette]);
  const roleLabel = ROLE_LABELS[role];
  const shareMsg = `${businessName} vous invite à rejoindre son équipe sur Patron.\n\nCode d'accès : ${code}\n\nCe code est valable 24 heures.`;

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="formSheet" onRequestClose={onClose} statusBarTranslucent navigationBarTranslucent backdropColor={palette.background}>
      <SafeAreaView style={styles.modalSafe}>
        <View style={styles.mhdr}>
          <View style={{ width: 70 }} />
          <Text variant="h4">Invitation créée</Text>
          <Pressable onPress={onClose} style={{ width: 70, alignItems: 'flex-end' }}>
            <Text variant="body" color="secondary">Fermer</Text>
          </Pressable>
        </View>

        <View style={styles.revealBody}>
          <View style={[styles.badge, { alignSelf: 'center' }]}>
            <Text variant="label" color="secondary">{roleLabel}</Text>
          </View>

          <View style={styles.revealCodeBlock}>
            <Text variant="caption" color="secondary">Code d'invitation</Text>
            <Text style={styles.revealCode}>{code}</Text>
            <Text variant="caption" color="secondary">Valable 24 heures · usage unique</Text>
          </View>

          <View style={styles.revealActions}>
            <Button
              label="Partager par WhatsApp"
              fullWidth
              onPress={() =>
                Linking.openURL(`whatsapp://send?text=${encodeURIComponent(shareMsg)}`).catch(() =>
                  Share.share({ message: shareMsg }),
                )
              }
            />
            <Button
              label="Partager…"
              variant="secondary"
              fullWidth
              onPress={() => Share.share({ message: shareMsg })}
            />
          </View>
        </View>
      </SafeAreaView>
    <ConfirmSheetHost active={!!(visible)} />
</Modal>
  );
}

// ─── Main Screen ──────────────────────────────────────────────────────────────

export default function EquipeScreen() {
  const { palette } = useTheme();
  const styles = useMemo(() => makeStyles(palette), [palette]);
  const session = useAuthStore(s => s.session);
  const businessId = session?.activeBusiness?.id ?? '';
  const userId = session?.user.id ?? '';
  const myMembershipId = session?.activeMembership?.id ?? '';
  const role = session?.activeMembership?.role;
  const currency = session?.activeBusiness?.currency ?? 'GNF';

  useEffect(() => {
    // router.back() is a no-op when this screen is the only stack entry (e.g.
    // reached directly from a cold-start notification tap for member_joined/
    // role_changed/member_removed) — that used to strand the navigator on
    // "Unmatched Route" instead of redirecting. Fall back to the tabs root.
    if (role && role !== 'administrateur') {
      if (router.canGoBack()) router.back();
      else router.replace('/(app)/(tabs)/');
    }
  }, [role]);

  const { membres, codes, redeemedCodes, fetchStatus, codesStatus, saving, error, offline, offlineSince, fetchMembres, fetchCodes, createCode, revokeCode } = useEquipeStore();
  const { products, fetchProducts } = useProductStore();

  const [tab, setTab] = useState<'membres' | 'codes'>('membres');
  const [showNewCode, setShowNewCode] = useState(false);
  const [revealData, setRevealData] = useState<{ code: string; role: Role } | null>(null);
  const [showManagerLimit, setShowManagerLimit] = useState(false);
  const [selectedMembre, setSelectedMembre] = useState<Membre | null>(null);
  const [search, setSearch] = useState('');

  const hasManager = membres.some(m => m.role === 'manager');

  // fetchCodes already prunes expired/consumed codes, so `codes` is exactly
  // the set of active codes. With none, the "Codes d'invitation" tab and its
  // panel are hidden entirely — nothing to show — and the view falls back to
  // Membres (generating a code via "+ Inviter" brings the tab back).
  const hasCodes = codes.length > 0;
  const effectiveTab = hasCodes ? tab : 'membres';

  // Search is shown once the team is big enough to need it — irrelevant on
  // the Codes tab, which is a different list entirely (invite codes, not people).
  const searchVisible = effectiveTab === 'membres' && membres.length >= SEARCH_VISIBILITY_THRESHOLD;
  useAnimateLayoutChange(searchVisible);
  useEffect(() => {
    if (!searchVisible) setSearch('');
  }, [searchVisible]);

  const filteredMembres = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return membres;
    return membres.filter(m => {
      const name = (m.display_name ?? m.user_name ?? '').toLowerCase();
      const phone = (m.user_phone ?? '').toLowerCase();
      return name.includes(q) || phone.includes(q);
    });
  }, [membres, search]);

  useFocusEffect(
    useCallback(() => {
      if (!businessId) return;
      fetchMembres(businessId);
      fetchCodes(businessId);
      if (products.length === 0) fetchProducts(businessId, userId);
    }, [businessId]),
  );

  if (role && role !== 'administrateur') return null;

  const handleGenerateCode = async (role: Role, scopeAll: boolean, scopeProductIds: string[]) => {
    if (role === 'manager' && hasManager) {
      setShowManagerLimit(true);
      return;
    }
    const code = await createCode(businessId, userId, role, 24, scopeAll, scopeProductIds);
    if (!code) { haptics.error(); appAlert('Le code n\'est pas passé. On réessaie :)'); return; }
    haptics.success();
    setShowNewCode(false);
    setTab('codes');   // the tab reappears now that an active code exists — land on it
    setRevealData({ code, role });
  };

  // Search/no-members empty states vs the grouped list — a loaded-but-empty
  // team is the screen's own empty state, never a skeleton.
  const membersBody = filteredMembres.length === 0 ? (
          search.trim() ? (
            <View style={styles.empty}>
              <Ionicons name="search-outline" size={40} color={palette.textDisabled} />
              <Text variant="body" color="secondary" style={{ marginTop: spacing[3] }}>Aucun résultat pour « {search} »</Text>
            </View>
          ) : (
            <View style={styles.empty}>
              <Text variant="body" color="secondary">Aucun membre pour l'instant</Text>
              <Text variant="caption" color="secondary" style={{ textAlign: 'center', marginTop: spacing[1] }}>
                Invitez un vendeur ou un gérant pour partager le travail
              </Text>
              <Button label="+ Inviter quelqu'un" size="sm" onPress={() => setShowNewCode(true)} style={{ marginTop: spacing[3] }} />
            </View>
          )
  ) : (

          // Grouped by role instead of one flat list — who can do what reads
          // from which section someone is in, not from a colored badge per
          // row. A plain ScrollView (not FlatList) is deliberate: a team
          // roster is small enough that virtualization buys nothing, and
          // this shape (N independent rounded groups) isn't something
          // FlatList/SectionList render naturally.
          <ScrollView contentContainerStyle={styles.list} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
            {MEMBER_GROUPS.map(group => {
              const groupMembres = filteredMembres.filter(m => group.roles.includes(m.role));
              if (groupMembres.length === 0) return null;
              return (
                <View key={group.key} style={styles.memberGroup}>
                  <View style={styles.groupHeading}>
                    <Text style={styles.groupTitle}>{group.title}</Text>
                    <Text style={styles.groupMeta}>{group.description} · {groupMembres.length}</Text>
                  </View>
                  <View style={styles.memberGroupCard}>
                    {groupMembres.map((item, i) => {
                      const shownName = item.display_name ?? item.user_name;
                      return (
                        <AnimatedRow key={item.id} id={item.id}>
                        <Pressable
                          onPress={() => setSelectedMembre(item)}
                          style={({ pressed }) => [
                            styles.memberRow,
                            i < groupMembres.length - 1 && styles.memberRowDivider,
                            pressed && { opacity: 0.75 },
                          ]}
                        >
                          <View style={styles.avatar}>
                            <Text variant="label" allowFontScaling={false} style={{ color: palette.textSecondary }}>
                              {shownName[0]?.toUpperCase()}
                            </Text>
                          </View>
                          <View style={{ flex: 1, gap: 2 }}>
                            <View style={styles.nameRow}>
                              <Text variant="label">{shownName}</Text>
                              {item.id === myMembershipId && <Text variant="caption" color="secondary">(vous)</Text>}
                            </View>
                            {item.user_phone
                              ? <Text variant="caption" color="secondary">{item.user_phone}</Text>
                              : <Text variant="caption" color="secondary">{item.user_email !== '—' ? item.user_email : 'Pas de contact'}</Text>
                            }
                          </View>
                          <Ionicons name="chevron-forward" size={16} color={palette.textDisabled} />
                        </Pressable>
                        </AnimatedRow>
                      );
                    })}
                  </View>
                </View>
              );
            })}
          </ScrollView>
  );
  return (
    <Screen>
      <View style={styles.hdr}>
        <Pressable onPress={() => router.back()}><Text variant="body" color="secondary">‹ Retour</Text></Pressable>
        <Text variant="h4">Équipe</Text>
        <Pressable onPress={() => setShowNewCode(true)}>
          <Text variant="label" style={{ color: palette.primary }}>+ Inviter</Text>
        </Pressable>
      </View>

      {offline && (
        <OfflineNotice offlineSince={offlineSince} onRetry={() => fetchMembres(businessId)} />
      )}

      {hasCodes && (
        <View style={styles.tabs}>
          {(['membres', 'codes'] as const).map(t => (
            <Pressable key={t} onPress={() => setTab(t)} style={[styles.tab, effectiveTab === t && styles.tabActive]}>
              <Text variant="label" style={{ color: effectiveTab === t ? palette.textInverse : palette.textSecondary }}>
                {t === 'membres' ? 'Membres' : "Codes d'invitation"}
              </Text>
            </Pressable>
          ))}
        </View>
      )}

      {searchVisible && (
        <View style={styles.searchRow}>
          <Input placeholder="Rechercher un membre…" value={search} onChangeText={setSearch} />
        </View>
      )}

      {effectiveTab === 'membres' ? (
        <DataState
          status={fetchStatus}
          isEmpty={membres.length === 0}
          skeleton={<SkeletonList count={5} />}
          empty={(error || offline) ? (
          <Text variant="body" color="secondary" style={styles.center}>Données non disponibles hors ligne</Text>
          ) : membersBody}
        >
          {membersBody}
        </DataState>
        
      ) : codesStatus !== 'loading' && codes.length === 0 && error ? (
        <Text variant="body" color="secondary" style={styles.center}>Données non disponibles hors ligne</Text>
      ) : (
        <FlatList
          data={codes}
          keyExtractor={c => c.id}
          CellRendererComponent={AnimatedRowCell}
          contentContainerStyle={styles.list}
          ListEmptyComponent={<EmptyState icon="key-outline" title="Aucun code actif." />}
          ListFooterComponent={
            redeemedCodes.length > 0 ? (
              <View style={{ marginTop: spacing[5], gap: spacing[2] }}>
                <Text variant="label" color="secondary">Codes utilisés</Text>
                {redeemedCodes.map(c => (
                  <Card key={c.id} style={[styles.codeCard, { opacity: 0.75 }]}>
                    <View style={styles.codeTop}>
                      <Text variant="body" numberOfLines={1} style={{ flex: 1, color: palette.textSecondary }}>
                        {c.code}
                      </Text>
                      <RoleBadge role={c.role} />
                    </View>
                    <Text variant="caption" color="secondary">
                      {c.redeemed_by_name ? `Utilisé par ${c.redeemed_by_name}` : 'Utilisé'}
                      {c.redeemed_at ? ` · ${formatDate(c.redeemed_at, 'numeric')}` : ''}
                    </Text>
                  </Card>
                ))}
              </View>
            ) : null
          }
          renderItem={({ item }) => {
            const expired = item.expires_at ? new Date(item.expires_at) < new Date() : false;
            return (
              <Card style={styles.codeCard}>
                <View style={styles.codeTop}>
                  <Text
                    variant="h3"
                    numberOfLines={1}
                    adjustsFontSizeToFit
                    style={{ flex: 1, color: expired ? palette.textDisabled : palette.primary }}
                  >
                    {item.code}
                  </Text>
                  <RoleBadge role={item.role} />
                </View>
                <View style={styles.codeMeta}>
                  <View style={styles.codeStatus}>
                    {!expired && <View style={styles.greenDot} />}
                    <Text variant="caption" color="secondary">
                      {expired
                        ? 'Expiré'
                        : `Valide · Expire dans ${item.expires_at ? Math.max(1, Math.ceil((new Date(item.expires_at).getTime() - Date.now()) / 3600000)) : '—'} h`}
                    </Text>
                  </View>
                  <Pressable onPress={() => appAlert('Révoquer ce code ?', undefined, [{ text: 'Non', style: 'cancel' }, { text: 'Oui, révoquer', style: 'destructive', onPress: () => { revokeCode(item.id).then(ok => { if (ok) { haptics.destructive(); toast.success(inviteCodeRevokedConfirmation()); } else { haptics.error(); failAlert('codeNotRevoked', { err: useEquipeStore.getState().error, label: 'Réessayer', onPress: () => { void revokeCode(item.id).then(ok2 => { if (ok2) toast.success(inviteCodeRevokedConfirmation()); }); } }); } }); } }])}>
                    <Text variant="caption" color="danger">Révoquer</Text>
                  </Pressable>
                </View>
                {!expired && (
                  <Pressable
                    onPress={() => {
                      const businessName = session?.activeBusiness?.name ?? 'Un commerce';
                      Share.share({
                        message: `${businessName} vous invite à rejoindre son équipe sur Patron.\n\nVotre code d'accès : ${item.code}\n\nCe code est valable jusqu'au ${item.expires_at ? formatDate(item.expires_at, 'numeric') : '—'}.`,
                      });
                    }}
                    style={styles.shareRow}
                  >
                    <Ionicons name="share-outline" size={14} color={palette.primary} />
                    <Text variant="bodySmall" style={{ color: palette.primary }}>Partager ce code</Text>
                  </Pressable>
                )}
              </Card>
            );
          }}
        />
      )}

      <NewCodeModal visible={showNewCode} onClose={() => setShowNewCode(false)}
        onGenerate={handleGenerateCode} saving={saving} hasManager={hasManager}
        products={products.filter(p => !p.archived && !p.is_system)} currency={currency} />

      {revealData && (
        <CodeRevealModal
          visible
          code={revealData.code}
          role={revealData.role}
          businessName={session?.activeBusiness?.name ?? 'Un commerce'}
          onClose={() => setRevealData(null)}
        />
      )}

      <MemberDetailSheet
        visible={selectedMembre !== null}
        membre={selectedMembre}
        myMembershipId={myMembershipId}
        onClose={() => setSelectedMembre(null)}
        hasManager={hasManager}
        businessId={businessId}
        currency={currency}
        products={products.filter(p => !p.archived && !p.is_system)}
      />

      <AppSheet
        visible={showManagerLimit}
        onClose={() => setShowManagerLimit(false)}
        icon="people-outline"
        title="Un seul gérant pour l'instant"
        body="Bientôt, vous pourrez avoir plusieurs gérants dans votre commerce. Pour l'instant, invitez des vendeurs ou des observateurs."
      />

    </Screen>
  );
}

function makeStyles(p: Palette) {
  return StyleSheet.create({
    safe: { flex: 1, backgroundColor: p.background },
    hdr: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: spacing[5], borderBottomWidth: 1, borderBottomColor: p.border },
    tabs: { flexDirection: 'row', padding: spacing[4], gap: spacing[2] },
    tab: { flex: 1, paddingVertical: spacing[2], alignItems: 'center', borderRadius: radius.md, borderWidth: 1, borderColor: p.border },
    tabActive: { backgroundColor: p.primary, borderColor: p.primary },
    searchRow: { paddingHorizontal: spacing[5], paddingBottom: spacing[2] },
    list: { paddingTop: spacing[2], paddingBottom: spacing[10] },
    memberGroup: { marginHorizontal: spacing[5], marginBottom: spacing[5] },
    groupHeading: {
      flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline',
      paddingHorizontal: spacing[1], paddingBottom: spacing[2],
    },
    groupTitle: { fontFamily: FF.semibold, fontSize: 13, color: p.textPrimary },
    groupMeta: { fontSize: 12, color: p.textSecondary },
    // Same rounded-container language as the Produits list — one bordered
    // card per group, corners clipped to its own rows via overflow: 'hidden'.
    memberGroupCard: {
      borderRadius: radius.md, borderWidth: 1, borderColor: p.border,
      backgroundColor: p.surface, overflow: 'hidden',
    },
    memberRowDivider: { borderBottomWidth: 1, borderBottomColor: p.border },
    memberRow: { flexDirection: 'row', alignItems: 'center', gap: spacing[3], paddingHorizontal: spacing[4], paddingVertical: spacing[3], backgroundColor: p.surface },
    // One neutral tile for every member — role and identity no longer carry
    // color; a name/initial is enough to tell people apart in a small team.
    avatar: {
      width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center',
      backgroundColor: p.background, borderWidth: 1, borderColor: p.border,
    },
    nameRow: { flexDirection: 'row', alignItems: 'center', gap: spacing[2] },
    badge: {
      paddingHorizontal: spacing[2], paddingVertical: 2, borderRadius: 6,
      backgroundColor: p.background, borderWidth: 1, borderColor: p.border,
    },
    codeCard: { marginHorizontal: spacing[5], marginVertical: spacing[2], gap: spacing[2] },
    codeTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
    codeMeta: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
    codeStatus: { flexDirection: 'row', alignItems: 'center', gap: spacing[1] },
    greenDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: p.success },
    shareRow: { flexDirection: 'row', alignItems: 'center', gap: spacing[1] },
    empty: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing[10] },
    center: { textAlign: 'center', marginTop: spacing[10] },
    modalSafe: { flex: 1, backgroundColor: p.background },
    mhdr: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: spacing[5], borderBottomWidth: 1, borderBottomColor: p.border },
    mpad: { padding: spacing[5], gap: spacing[4] },
    mfooter: { padding: spacing[5], borderTopWidth: 1, borderTopColor: p.border },
    revealBody: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing[6], gap: spacing[8] },
    revealCodeBlock: { alignItems: 'center', gap: spacing[3] },
    revealCode: { fontFamily: FF.bold, fontSize: 36, lineHeight: 48, color: p.textPrimary, textAlign: 'center', width: '100%' },
    revealActions: { width: '100%', gap: spacing[3] },
    roleGrid: { gap: spacing[2] },
    roleChip: { padding: spacing[4], borderRadius: radius.lg, borderWidth: 1.5, borderColor: p.border, gap: 4 },
    lockedNote: { flexDirection: 'row', alignItems: 'center', gap: spacing[3], backgroundColor: p.warningLight, borderRadius: radius.md, borderWidth: 1.5, borderColor: p.warning, padding: spacing[4] },
    fullBadge: { backgroundColor: p.border, borderRadius: radius.full, paddingHorizontal: spacing[2], paddingVertical: 2 },

    // Member detail sheet
    identityRow: { flexDirection: 'row', alignItems: 'center', gap: spacing[3] },
    actionRow: { flexDirection: 'row', backgroundColor: p.surface, borderRadius: radius.md, borderWidth: 1, borderColor: p.border, overflow: 'hidden' },
    actionBtn: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: spacing[2], paddingVertical: spacing[3] },
    actionDivider: { width: 1, backgroundColor: p.border },
    sectionHdr: { flexDirection: 'row', alignItems: 'center', gap: spacing[2] },
    allProductsChip: { flexDirection: 'row', alignItems: 'center', gap: spacing[2], backgroundColor: p.surface, borderWidth: 1, borderColor: p.border, borderRadius: radius.full, paddingHorizontal: spacing[3], paddingVertical: spacing[2], alignSelf: 'flex-start' },
    scopeRow: { flexDirection: 'row', alignItems: 'center', backgroundColor: p.surface, borderRadius: radius.md, borderWidth: 1, borderColor: p.border, padding: spacing[4], gap: spacing[3] },
    scopeRowTop: { flexDirection: 'row', alignItems: 'center', gap: spacing[3] },
    scopeToggleRow: { flexDirection: 'row', alignItems: 'center', backgroundColor: p.surface, borderRadius: radius.md, borderWidth: 1.5, padding: spacing[4], gap: spacing[3] },
    toggleTrack: { width: 40, height: 24, borderRadius: 12, position: 'relative' },
    toggleThumb: { position: 'absolute', top: 3, width: 18, height: 18, borderRadius: 9, backgroundColor: p.textInverse },
    radioCircle: { width: 22, height: 22, borderRadius: 11, borderWidth: 2, borderColor: p.border, alignItems: 'center', justifyContent: 'center' },
    radioDot: { width: 10, height: 10, borderRadius: 5 },
    nameEditRow: { flexDirection: 'row', alignItems: 'center', gap: spacing[2] },
    nameEditInput: { flex: 1, borderWidth: 1, borderRadius: radius.md, paddingHorizontal: spacing[3], paddingVertical: spacing[2], fontSize: 15 },
    nameEditBtn: { paddingHorizontal: spacing[3], paddingVertical: spacing[2], borderRadius: radius.md },
    nameEditTrigger: { flexDirection: 'row', alignItems: 'center', gap: spacing[1], paddingVertical: spacing[1] },
    stakeRow: { flexDirection: 'row', gap: spacing[3] },
    stakeField: { flex: 1, gap: spacing[1] },
    stakeLabel: { fontFamily: FF.semibold, fontSize: 11, color: p.textSecondary, letterSpacing: 0.6, textTransform: 'uppercase' },
    stakeInput: { borderWidth: 1, borderRadius: radius.sm, paddingHorizontal: spacing[3], paddingVertical: spacing[2], fontFamily: FF.semibold, fontSize: 17, backgroundColor: p.background },
    assignBtn: { flexDirection: 'row', alignItems: 'center', gap: spacing[2], paddingVertical: spacing[3] },

    // Product scope picker
    pickerSearch: { flexDirection: 'row', alignItems: 'center', gap: spacing[3], marginHorizontal: spacing[5], marginVertical: spacing[3], backgroundColor: p.surface, borderWidth: 1, borderColor: p.border, borderRadius: radius.md, paddingHorizontal: spacing[3], paddingVertical: spacing[2] },
    pickerSearchInput: { flex: 1, fontSize: 16, fontFamily: FF.regular },
    pickerRow: { flexDirection: 'row', alignItems: 'center', gap: spacing[3], paddingHorizontal: spacing[5], paddingVertical: spacing[4], backgroundColor: p.surface },
    pickerCheck: { width: 22, height: 22, borderRadius: 6, borderWidth: 1.5, borderColor: p.border, alignItems: 'center', justifyContent: 'center' },
    inlineProductList: { borderWidth: 1, borderColor: p.border, borderRadius: radius.md, overflow: 'hidden', marginTop: spacing[1] },
    inlineProductRow: { flexDirection: 'row', alignItems: 'center', gap: spacing[3], paddingHorizontal: spacing[4], paddingVertical: spacing[3], backgroundColor: p.surface },

    // Payout sheet
    payoutBackdrop: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.5)' },
    payoutPanel: { borderTopLeftRadius: 24, borderTopRightRadius: 24, paddingHorizontal: spacing[6], paddingTop: spacing[3], paddingBottom: spacing[10], alignItems: 'center', gap: spacing[4] },
    payoutHandle: { width: 40, height: 4, borderRadius: 2, marginBottom: spacing[2] },
    payoutInput: { flexDirection: 'row', alignItems: 'center', gap: spacing[3], borderWidth: 1, borderRadius: radius.md, paddingHorizontal: spacing[4], paddingVertical: spacing[3] },
  });
}
