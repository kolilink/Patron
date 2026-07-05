import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Animated, Easing, FlatList, Linking, Modal, Pressable, ScrollView, Share, StyleSheet, TextInput, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { Screen } from '@/src/components/ui/Screen';
import { router } from 'expo-router';
import { AppSheet } from '@/src/components/ui/AppSheet';
import { SkeletonList } from '@/src/components/ui/SkeletonPlaceholder';
import { OfflineNotice } from '@/src/components/ui/OfflineNotice';
import { Button } from '@/src/components/ui/Button';
import { Card } from '@/src/components/ui/Card';
import { Text } from '@/src/components/ui/Text';
import { useTheme, spacing, radius, fontFamily as FF, AVATAR_PALETTE, ROLE_COLORS } from '@/src/theme';
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

const ROLES: Role[] = ['manager', 'vendeur', 'investisseur'];

const ROLE_LABELS: Record<Role, string> = {
  administrateur: 'Gérant', manager: 'Gérant', vendeur: 'Vendeur', investisseur: 'Observateur',
};

const ROLE_BADGE_LABELS: Record<Role, string> = {
  administrateur: 'Gérant', manager: 'Gérant', vendeur: 'Vendeur', investisseur: 'Observateur',
};

const ROLE_DESCRIPTIONS: Record<string, string> = {
  manager: 'Gère le commerce sans pouvoir le supprimer',
  vendeur: 'Enregistre les ventes uniquement',
  investisseur: 'Voit les chiffres, ne touche à rien',
};


function avatarColor(name: string): string {
  return AVATAR_PALETTE[(name.charCodeAt(0) || 0) % AVATAR_PALETTE.length];
}

function RoleBadge({ role }: { role: string }) {
  const { palette } = useTheme();
  const styles = useMemo(() => makeStyles(palette), [palette]);
  const c = ROLE_COLORS[role] ?? palette.primary;
  return (
    <View style={[styles.badge, { backgroundColor: c + '20' }]}>
      <Text variant="labelSmall" style={{ color: c, textTransform: 'capitalize' }}>
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
  const insets = useSafeAreaInsets();
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

  const toggle = (id: string) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <SafeAreaView style={[styles.modalSafe, { paddingBottom: insets.bottom }]}>
        <View style={styles.mhdr}>
          <Pressable onPress={onClose}><Text variant="body" color="secondary">Annuler</Text></Pressable>
          <Text variant="h4">Choisir les produits</Text>
          <Pressable onPress={() => onConfirm([...selected])}>
            <Text variant="label" style={{ color: palette.primary }}>Confirmer</Text>
          </Pressable>
        </View>

        {/* Search */}
        <View style={styles.pickerSearch}>
          <Ionicons name="search-outline" size={16} color={palette.textSecondary} />
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
      </SafeAreaView>
    </Modal>
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
    await updateScopeAll(membre.id, val);
    haptics.success();
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
    }
  };

  const handleSaveStakeEdits = async () => {
    const stakes = scope.map(s => ({
      productId: s.product_id,
      contribution: 0,
      profitShare: parseFloat(draftStakes[s.product_id] || '0') || 0,
    }));
    const ok = await setMemberScope(membre.id, stakes);
    if (ok) haptics.success();
  };

  const handleRemoveProduct = (productId: string, productName: string) => {
    Alert.alert(`Retirer "${productName}" ?`, 'Ce membre n\'aura plus accès aux données de ce produit.', [
      { text: 'Annuler', style: 'cancel' },
      {
        text: 'Retirer',
        style: 'destructive',
        onPress: async () => {
          haptics.error();
          await removeScopeProduct(membre.id, productId);
          const rows = await fetchMemberScope(membre.id);
          setScope(rows);
        },
      },
    ]);
  };

  const handleChangeRole = () => {
    const otherRoles = ROLES.filter(r => r !== membre.role);
    Alert.alert('Nouveau rôle', '', [
      ...otherRoles.map(r => ({
        text: ROLE_LABELS[r],
        onPress: () => {
          if (r === 'manager' && hasManager) return;
          changeRole(membre.id, r).then(ok => { if (ok) onClose(); });
        },
      })),
      { text: 'Annuler', style: 'cancel' },
    ]);
  };

  const handleRemove = () => {
    Alert.alert('Retirer ' + (membre.user_name || generateFallbackName(membre.user_id)) + ' ?', '', [
      { text: 'Annuler', style: 'cancel' },
      {
        text: 'Retirer',
        style: 'destructive',
        onPress: () => {
          haptics.error();
          removeMembre(membre.id).then(ok => { if (ok) onClose(); });
        },
      },
    ]);
  };

  const scopeIds = new Set(scope.map(s => s.product_id));
  const noScope = scope.length === 0;

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <SafeAreaView style={styles.modalSafe}>
        <View style={styles.mhdr}>
          <Pressable onPress={onClose}><Text variant="body" color="secondary">Fermer</Text></Pressable>
          <Text variant="h4" numberOfLines={1} style={{ flex: 1, textAlign: 'center' }}>
            {displayedName}
          </Text>
          <View style={{ width: 60 }} />
        </View>

        <ScrollView contentContainerStyle={styles.mpad} keyboardShouldPersistTaps="handled">
          {/* Identity */}
          <View style={styles.identityRow}>
            <View style={[styles.avatar, { backgroundColor: avatarColor(displayedName) + '20' }]}>
              <Text variant="h4" style={{ color: avatarColor(displayedName) }}>
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
              <Pressable onPress={() => setEditingName(false)}>
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
              <Pressable style={styles.actionBtn} onPress={handleChangeRole}>
                <Ionicons name="swap-horizontal-outline" size={18} color={palette.primary} />
                <Text variant="bodySmall" style={{ color: palette.primary }}>Changer le rôle</Text>
              </Pressable>
              <View style={styles.actionDivider} />
              <Pressable style={styles.actionBtn} onPress={handleRemove}>
                <Ionicons name="person-remove-outline" size={18} color={palette.danger} />
                <Text variant="bodySmall" style={{ color: palette.danger }}>Retirer</Text>
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
                    <Text style={{ fontSize: 22, fontWeight: '700', lineHeight: 30, color: palette.primary }}>
                      {formatAmount(totalInvested, currency)}
                    </Text>
                  </View>
                ) : null;
              })()}

              <View style={[styles.scopeRow, { flexDirection: 'column', alignItems: 'flex-start', gap: spacing[1] }]}>
                <Text variant="caption" color="secondary">Part des bénéfices accumulée</Text>
                <Text style={{ fontSize: 22, fontWeight: '700', lineHeight: 30, color: palette.success }}>
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
                        setPayoutAmountStr(formatAmountInput(String(pending.requested_amount)));
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
                      {new Date(p.paid_at ?? p.requested_at).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' })}
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
                    <View key={s.product_id} style={[styles.scopeRow, isInvestisseur && { flexDirection: 'column', alignItems: 'stretch', gap: spacing[3] }]}>
                      <View style={styles.scopeRowTop}>
                        <Text variant="body" style={{ flex: 1 }} numberOfLines={2}>{s.product_name}</Text>
                        <Pressable onPress={() => handleRemoveProduct(s.product_id, s.product_name)} hitSlop={8}>
                          <Ionicons name="trash-outline" size={16} color={palette.textSecondary} />
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
                    </View>
                  ))
                )
              )}

              {isInvestisseur && scope.length > 0 && (
                <Button
                  label={saving ? 'Enregistrement…' : 'Enregistrer les montants'}
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
        </ScrollView>
      </SafeAreaView>

      <ProductScopePicker
        visible={showPicker}
        onClose={() => setShowPicker(false)}
        products={products}
        selectedIds={scopeIds}
        onConfirm={handleSaveScope}
        currency={currency}
      />

      {/* Payout confirmation sheet */}
      <Modal visible={showPayoutSheet} transparent animationType="slide" onRequestClose={() => setShowPayoutSheet(false)}>
        <Pressable style={styles.payoutBackdrop} onPress={() => setShowPayoutSheet(false)}>
          <Pressable style={[styles.payoutPanel, { backgroundColor: palette.surface }]} onPress={() => {}}>
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
                  onChangeText={v => setPayoutAmountStr(formatAmountInput(v))}
                  keyboardType="numeric"
                  placeholder="0"
                  placeholderTextColor={palette.textDisabled}
                  selectTextOnFocus
                />
                <Text variant="label" color="secondary">{currency}</Text>
              </View>
            </View>

            <Button
              label={investorSaving ? 'Enregistrement…' : 'Confirmer le paiement'}
              fullWidth
              size="lg"
              loading={investorSaving}
              onPress={async () => {
                if (!pendingPayoutId) return;
                const amt = parseAmountInput(payoutAmountStr);
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
      </Modal>
    </Modal>
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
          Animated.timing(pulseAnim, { toValue: 1,    duration: 2400, useNativeDriver: true, easing: Easing.inOut(Easing.sin) }),
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
    <Modal visible={visible} animationType="slide" presentationStyle="formSheet" onRequestClose={onClose}>
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
              <Text variant="bodySmall" style={{ flex: 1, color: palette.warning, fontWeight: '600', lineHeight: 20 }}>
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
                label={saving ? 'Génération…' : 'Générer le code'}
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
  const roleColor = ROLE_COLORS[role] ?? palette.primary;
  const roleLabel = ROLE_LABELS[role];
  const shareMsg = `${businessName} vous invite à rejoindre son équipe sur Patron.\n\nCode d'accès : ${code}\n\nCe code est valable 24 heures.`;

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="formSheet" onRequestClose={onClose}>
      <SafeAreaView style={styles.modalSafe}>
        <View style={styles.mhdr}>
          <View style={{ width: 70 }} />
          <Text variant="h4">Invitation créée</Text>
          <Pressable onPress={onClose} style={{ width: 70, alignItems: 'flex-end' }}>
            <Text variant="body" color="secondary">Fermer</Text>
          </Pressable>
        </View>

        <View style={styles.revealBody}>
          <View style={[styles.badge, { backgroundColor: roleColor + '20', alignSelf: 'center' }]}>
            <Text variant="label" style={{ color: roleColor }}>{roleLabel}</Text>
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
    </Modal>
  );
}

// ─── Main Screen ──────────────────────────────────────────────────────────────

export default function EquipeScreen() {
  const { palette } = useTheme();
  const styles = useMemo(() => makeStyles(palette), [palette]);
  const session = useAuthStore(s => s.session);
  const isDemoMode = session?.isDemoMode ?? false;
  const businessId = session?.activeBusiness?.id ?? '';
  const userId = session?.user.id ?? '';
  const myMembershipId = session?.activeMembership?.id ?? '';
  const role = session?.activeMembership?.role;
  const currency = session?.activeBusiness?.currency ?? 'GNF';

  useEffect(() => {
    if (role && role !== 'administrateur') router.back();
  }, [role]);

  const { membres, codes, loading, saving, error, hasFetched, offline, offlineSince, fetchMembres, fetchCodes, createCode, revokeCode } = useEquipeStore();
  const { products, fetchProducts } = useProductStore();

  const [tab, setTab] = useState<'membres' | 'codes'>('membres');
  const [showNewCode, setShowNewCode] = useState(false);
  const [showDemoGate, setShowDemoGate] = useState(false);
  const [revealData, setRevealData] = useState<{ code: string; role: Role } | null>(null);
  const [showManagerLimit, setShowManagerLimit] = useState(false);
  const [selectedMembre, setSelectedMembre] = useState<Membre | null>(null);

  const hasManager = membres.some(m => m.role === 'manager');

  useEffect(() => {
    if (!businessId) return;
    fetchMembres(businessId);
    fetchCodes(businessId);
    if (products.length === 0) fetchProducts(businessId, userId);
  }, [businessId]);

  if (role && role !== 'administrateur') return null;

  const handleGenerateCode = async (role: Role, scopeAll: boolean, scopeProductIds: string[]) => {
    if (role === 'manager' && hasManager) {
      setShowManagerLimit(true);
      return;
    }
    const code = await createCode(businessId, userId, role, 24, scopeAll, scopeProductIds);
    if (!code) { haptics.error(); Alert.alert('Le code n\'est pas passé. On réessaie :)'); return; }
    haptics.success();
    setShowNewCode(false);
    setRevealData({ code, role });
  };

  return (
    <Screen>
      <View style={styles.hdr}>
        <Pressable onPress={() => router.back()}><Text variant="body" color="secondary">‹ Retour</Text></Pressable>
        <Text variant="h4">Équipe</Text>
        <Pressable onPress={() => isDemoMode ? setShowDemoGate(true) : setShowNewCode(true)}>
          <Text variant="label" style={{ color: palette.primary }}>+ Inviter</Text>
        </Pressable>
      </View>

      {offline && <OfflineNotice offlineSince={offlineSince} />}

      <View style={styles.tabs}>
        {(['membres', 'codes'] as const).map(t => (
          <Pressable key={t} onPress={() => setTab(t)} style={[styles.tab, tab === t && styles.tabActive]}>
            <Text variant="label" style={{ color: tab === t ? palette.textInverse : palette.textSecondary }}>
              {t === 'membres' ? 'Membres' : "Codes d'invitation"}
            </Text>
          </Pressable>
        ))}
      </View>

      {tab === 'membres' ? (
        (!hasFetched || loading) && membres.length === 0 ? (
          <SkeletonList count={5} />
        ) : !loading && membres.length === 0 && (error || offline) ? (
          <Text variant="body" color="secondary" style={styles.center}>Données non disponibles hors ligne</Text>
        ) : (
          <FlatList
            data={membres}
            keyExtractor={m => m.id}
            contentContainerStyle={styles.list}
            ListEmptyComponent={
              <View style={styles.empty}>
                <Text variant="body" color="secondary">Personne d'autre n'utilise ce commerce</Text>
                <Text variant="caption" color="secondary" style={{ textAlign: 'center', marginTop: spacing[1] }}>
                  Invitez un vendeur ou un gérant pour partager le travail
                </Text>
                <Button label="+ Inviter quelqu'un" size="sm" onPress={() => isDemoMode ? setShowDemoGate(true) : setShowNewCode(true)} style={{ marginTop: spacing[3] }} />
              </View>
            }
            renderItem={({ item }) => {
              const shownName = item.display_name ?? item.user_name;
              return (
                <Pressable
                  onPress={() => setSelectedMembre(item)}
                  style={({ pressed }) => [styles.memberRow, pressed && { opacity: 0.75 }]}
                >
                  <View style={[styles.avatar, { backgroundColor: avatarColor(shownName) + '20' }]}>
                    <Text variant="label" style={{ color: avatarColor(shownName) }}>
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
                  <RoleBadge role={item.role} />
                </Pressable>
              );
            }}
            ItemSeparatorComponent={() => <View style={{ height: 1, backgroundColor: palette.border }} />}
          />
        )
      ) : !loading && codes.length === 0 && error ? (
        <Text variant="body" color="secondary" style={styles.center}>Données non disponibles hors ligne</Text>
      ) : (
        <FlatList
          data={codes}
          keyExtractor={c => c.id}
          contentContainerStyle={styles.list}
          ListEmptyComponent={<View style={styles.empty}><Text variant="body" color="secondary">Aucun code actif.</Text></View>}
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
                        : `Valide · expire ${item.expires_at ? new Date(item.expires_at).toLocaleDateString('fr-FR') : '—'}`}
                    </Text>
                  </View>
                  <Pressable onPress={() => Alert.alert('Annuler ce code ?', '', [{ text: 'Non', style: 'cancel' }, { text: 'Oui, annuler', style: 'destructive', onPress: () => { haptics.error(); revokeCode(item.id); } }])}>
                    <Text variant="caption" color="danger">Supprimer</Text>
                  </Pressable>
                </View>
                {!expired && (
                  <Pressable
                    onPress={() => {
                      const businessName = session?.activeBusiness?.name ?? 'Un commerce';
                      Share.share({
                        message: `${businessName} vous invite à rejoindre son équipe sur Patron.\n\nVotre code d'accès : ${item.code}\n\nCe code est valable jusqu'au ${item.expires_at ? new Date(item.expires_at).toLocaleDateString('fr-FR') : '—'}.`,
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

      <AppSheet
        visible={showDemoGate}
        onClose={() => setShowDemoGate(false)}
        icon="person-add-outline"
        title="Créer mon compte pour inviter"
        body="Créez votre compte pour générer des codes d'invitation et partager votre commerce avec votre équipe."
        action={{ label: 'Créer mon compte →', onPress: () => router.push('/(welcome)/creer') }}
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
    list: { paddingBottom: spacing[10] },
    memberRow: { flexDirection: 'row', alignItems: 'center', gap: spacing[3], paddingHorizontal: spacing[5], paddingVertical: spacing[3], backgroundColor: p.surface },
    avatar: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
    nameRow: { flexDirection: 'row', alignItems: 'center', gap: spacing[2] },
    badge: { paddingHorizontal: spacing[2], paddingVertical: 2, borderRadius: 6 },
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
    revealCode: { fontSize: 36, lineHeight: 48, fontWeight: '700', color: p.textPrimary, textAlign: 'center', width: '100%' },
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
