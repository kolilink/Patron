import { useEffect, useMemo, useState } from 'react';
import {
  Alert, InputAccessoryView, Linking, Modal,
  Platform, Pressable, ScrollView, StyleSheet, View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Screen } from '@/src/components/ui/Screen';
import { FormSheet } from '@/src/components/ui/FormSheet';
import { router, useLocalSearchParams } from 'expo-router';
import { Button } from '@/src/components/ui/Button';
import { Card } from '@/src/components/ui/Card';
import { Input } from '@/src/components/ui/Input';
import { Text } from '@/src/components/ui/Text';
import { ProofControl } from '@/src/components/ui/ProofControl';
import { useTheme, spacing, shadow, fontFamily } from '@/src/theme';
import type { Palette } from '@/src/theme';
import { useAuthStore } from '@/stores/auth';
import { useProductStore } from '@/stores/products';
import {
  useFournisseursStore,
  type CommandeAchat,
  type Fournisseur,
  type SupplierPayment,
} from '@/stores/fournisseurs';
import { supabase } from '@/lib/supabase';
import { formatAmountInput, parseAmountInput } from '@/src/utils/format';

// iOS-only: suppresses the OS's auto-injected floating "Done" pill above
// number-pad/decimal-pad keyboards — the pay form below already has a
// persistent, always-visible footer button, so the pill is redundant.
const PAY_FORM_SILENT_ACCESSORY_ID = 'fournisseurs-id-pay-form-silent-accessory';

function fmt(n: number, cur: string) {
  return `${Math.round(n).toLocaleString('fr-FR')} ${cur}`;
}

function digitsOnly(phone: string): string {
  return phone.replace(/[^0-9]/g, '');
}

// ── Livraison detail — one unified sheet, replacing the two divergent ones
// this screen and the Fournisseurs list used to each maintain independently
// (one titled "Commande" with a photo control, one titled with the supplier's
// name and a "Confirmer la réception" button). Under the new model every
// livraison shown here is already status='recu' — there is nothing left to
// confirm, only to look at. ──────────────────────────────────────────────────

function LivraisonDetail({ livraison, fournisseurName, currency, businessId, canAttach, offline, onClose, onProofAttached, onProofDeleted }: {
  livraison: CommandeAchat; fournisseurName: string; currency: string; businessId: string;
  canAttach: boolean; offline: boolean;
  onClose: () => void;
  onProofAttached: (proof: { url: string; width: number; height: number }) => void;
  onProofDeleted: () => void;
}) {
  const { palette } = useTheme();
  const styles = useMemo(() => makeStyles(palette), [palette]);
  const dateLabel = new Date(livraison.ordered_at).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' });
  return (
    <Modal visible animationType="slide" presentationStyle="formSheet" onRequestClose={onClose} statusBarTranslucent navigationBarTranslucent backdropColor={palette.background}>
      <SafeAreaView style={styles.modalSafe} edges={Platform.OS === 'android' ? ['top', 'bottom'] : ['bottom']}>
        <View style={styles.mhdr}>
          <Pressable onPress={onClose}><Text variant="body" color="secondary">Fermer</Text></Pressable>
          <Text variant="h4" numberOfLines={1}>{fournisseurName} · {dateLabel}</Text>
          <View style={{ width: 60 }} />
        </View>
        <ScrollView contentContainerStyle={styles.mpad}>
          <Card style={{ gap: spacing[2] }}>
            <View style={styles.dr}><Text variant="caption" color="secondary">Total</Text>
              <Text variant="label">{fmt(livraison.total_cost, currency)}</Text></View>
          </Card>
          {livraison.lines?.map(l => (
            <Card key={l.id} style={{ gap: 2 }}>
              <Text variant="body">{l.product_name}</Text>
              <View style={styles.dr}>
                <Text variant="caption" color="secondary">×{l.qty_ordered} · {fmt(l.unit_cost, currency)}/u</Text>
                <Text variant="label">{fmt(l.qty_ordered * l.unit_cost, currency)}</Text>
              </View>
            </Card>
          ))}

          <View style={{ gap: spacing[2], marginTop: spacing[2] }}>
            <Text variant="label" color="secondary">Photo</Text>
            <ProofControl
              variant="row"
              kind="purchase_order"
              id={livraison.id}
              businessId={businessId}
              imageUrl={livraison.proof_image_url}
              imageWidth={livraison.proof_image_width}
              imageHeight={livraison.proof_image_height}
              attachedBy={livraison.proof_attached_by}
              attachedAt={livraison.proof_attached_at}
              canAttach={canAttach}
              offline={offline}
              onAttached={onProofAttached}
              onDeleted={onProofDeleted}
            />
          </View>
        </ScrollView>
      </SafeAreaView>
    </Modal>
  );
}

// ── Profile screen ────────────────────────────────────────────────────────────

export default function FournisseurProfile() {
  const { palette } = useTheme();
  const styles = useMemo(() => makeStyles(palette), [palette]);
  const { id } = useLocalSearchParams<{ id: string }>();
  const session = useAuthStore(s => s.session);
  const businessId = session?.activeBusiness?.id ?? '';
  const currency = session?.activeBusiness?.currency ?? 'GNF';
  const userId = session?.user.id ?? '';
  const role = session?.activeMembership?.role;

  const { products, fetchProducts } = useProductStore();
  const {
    fournisseurs, commandes, debts, payments, offline,
    fetchFournisseurs, fetchCommandes, fetchPayments,
    loadCommandeLines, deleteFournisseur, payDebt,
  } = useFournisseursStore();
  const canWrite = role === 'administrateur' || role === 'manager';

  const fournisseur = fournisseurs.find(f => f.id === id);

  // Extra product links from the many-to-many product_suppliers table
  const [extraProductIds, setExtraProductIds] = useState<Set<string>>(new Set());
  const [showProductLink, setShowProductLink] = useState(false);
  const [linkingProducts, setLinkingProducts] = useState(false);

  const linkedProducts = products.filter(p =>
    (p.supplier_id === id || extraProductIds.has(p.id)) && !p.archived,
  );

  // A livraison is a purchase_order that made it all the way to 'recu' — no
  // pending/partial order is ever created going forward under the new model,
  // so anything else simply isn't shown here.
  const supplierLivraisons = commandes
    .filter(c => c.supplier_id === id && c.status === 'recu')
    .sort((a, b) => new Date(b.ordered_at).getTime() - new Date(a.ordered_at).getTime());
  const totalOwed = debts
    .filter(d => d.supplier_id === id)
    .reduce((s, d) => s + Math.max(0, d.amount - d.amount_paid), 0);

  const [showPay, setShowPay] = useState(false);
  const [payAmount, setPayAmount] = useState('');
  const [paying, setPaying] = useState(false);
  const [detailLivraison, setDetailLivraison] = useState<CommandeAchat | null>(null);

  useEffect(() => {
    if (!businessId || !id) return;
    if (fournisseurs.length === 0) fetchFournisseurs(businessId);
    if (products.length === 0) fetchProducts(businessId, userId, session?.activeMembership?.id, session?.activeMembership?.role);
    fetchCommandes(businessId);
    fetchPayments(businessId, id);
  }, [businessId, id]);

  useEffect(() => {
    if (!id) return;
    supabase.from('product_suppliers').select('product_id').eq('supplier_id', id)
      .then(({ data }) => {
        setExtraProductIds(new Set((data ?? []).map(r => r.product_id as string)));
      });
  }, [id]);

  const linkProduct = async (productId: string) => {
    setLinkingProducts(true);
    try {
      const { error } = await supabase.from('product_suppliers').insert({ product_id: productId, supplier_id: id });
      if (!error) setExtraProductIds(prev => new Set([...prev, productId]));
    } catch {
      // A network timeout here must never leave `linkingProducts` stuck
      // true (it permanently disables the link chip) — see CLAUDE.md's
      // withTimeout() sweep for the established shape of this fix.
    } finally {
      setLinkingProducts(false);
      setShowProductLink(false);
    }
  };

  const unlinkProduct = async (productId: string) => {
    try {
      const { error } = await supabase.from('product_suppliers')
        .delete().eq('product_id', productId).eq('supplier_id', id);
      if (!error) setExtraProductIds(prev => { const s = new Set(prev); s.delete(productId); return s; });
    } catch {
      // best-effort — no loading flag depends on this
    }
  };

  const handleDelete = () => {
    Alert.alert(
      `Supprimer ${fournisseur?.name ?? ''} ?`,
      'Les produits liés seront dissociés. Cette action est irréversible.',
      [
        { text: 'Annuler', style: 'cancel' },
        {
          text: 'Supprimer', style: 'destructive',
          onPress: async () => {
            const { ok, message } = await deleteFournisseur(id, businessId);
            if (ok) router.back();
            else Alert.alert(message ?? 'Impossible de supprimer le fournisseur');
          },
        },
      ]
    );
  };

  const handlePay = async () => {
    const amount = parseAmountInput(payAmount, currency);
    if (isNaN(amount) || amount <= 0) { Alert.alert('Vérifiez le montant :)'); return; }
    if (amount > totalOwed + 0.01) {
      Alert.alert('Montant trop élevé', `Vous ne devez que ${fmt(totalOwed, currency)}.`);
      return;
    }
    setPaying(true);
    const ok = await payDebt(businessId, id, amount);
    setPaying(false);
    if (ok) { setShowPay(false); setPayAmount(''); }
    else Alert.alert('Le paiement n\'est pas passé :)');
  };

  const openLivraisonDetail = async (livraison: CommandeAchat) => {
    if (!livraison.lines) await loadCommandeLines(livraison.id);
    const updated = useFournisseursStore.getState().commandes.find(c => c.id === livraison.id) ?? livraison;
    setDetailLivraison(updated);
  };

  if (!fournisseur) {
    return (
      <Screen>
        <View style={styles.header}>
          <Pressable onPress={() => router.back()}>
            <Text variant="body" color="secondary">‹ Retour</Text>
          </Pressable>
        </View>
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
          <Text variant="body" color="secondary">Fournisseur introuvable</Text>
        </View>
      </Screen>
    );
  }

  const initials = fournisseur.name
    .split(/\s+/).slice(0, 2)
    .map(w => w[0]?.toUpperCase() ?? '')
    .join('');

  return (
    <Screen>

      {/* ── Header ── */}
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} style={styles.headerBtn}>
          <Text variant="body" color="secondary">‹ Retour</Text>
        </Pressable>
        <Pressable
          onPress={() => Alert.alert('', '', [
            { text: 'Supprimer', style: 'destructive', onPress: handleDelete },
            { text: 'Annuler', style: 'cancel' },
          ])}
          style={styles.headerBtn}
          accessibilityLabel="Plus d'options"
          accessibilityRole="button">
          <Ionicons name="ellipsis-horizontal" size={22} color={palette.textSecondary} />
        </Pressable>
      </View>

      <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>

        {/* ── Hero ── */}
        <View style={styles.hero}>
          <View style={styles.avatar}>
            <Text allowFontScaling={false} style={styles.initials}>{initials}</Text>
          </View>
          <Text style={styles.heroName}>{fournisseur.name}</Text>
          {fournisseur.phone ? (
            <View style={styles.contactRow}>
              <Pressable
                onPress={() => Linking.openURL(`tel:${fournisseur.phone}`).catch(() => { })}
                style={styles.callBtn}>
                <Ionicons name="call-outline" size={15} color={palette.primary} />
                <Text style={styles.callText}>Appeler</Text>
              </Pressable>
              <Pressable
                onPress={() => Linking.openURL(`https://wa.me/${digitsOnly(fournisseur.phone!)}`).catch(() => { })}
                style={styles.callBtn}>
                <Ionicons name="logo-whatsapp" size={15} color={palette.primary} />
                <Text style={styles.callText}>WhatsApp</Text>
              </Pressable>
            </View>
          ) : (
            <Text variant="caption" color="secondary" style={{ marginTop: 8 }}>Pas de numéro</Text>
          )}
        </View>

        {/* ── Products ── */}
        <View style={styles.section}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: spacing[3] }}>
            <Text variant="label" color="secondary">Produits fournis</Text>
            {(role === 'administrateur' || role === 'manager') && (
              <Pressable onPress={() => setShowProductLink(v => !v)} hitSlop={8}>
                <Text variant="caption" style={{ color: palette.primary }}>
                  {showProductLink ? 'Fermer' : '+ Ajouter un produit'}
                </Text>
              </Pressable>
            )}
          </View>

          {showProductLink && (
            <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ flexGrow: 0, marginBottom: spacing[3] }}>
              {products.filter(p => !p.archived && !linkedProducts.some(lp => lp.id === p.id)).map(p => (
                <Pressable
                  key={p.id}
                  onPress={() => { void linkProduct(p.id); }}
                  disabled={linkingProducts}
                  style={[styles.chip, { marginRight: spacing[2], opacity: linkingProducts ? 0.5 : 1 }]}>
                  <Text style={styles.chipText}>{p.name}</Text>
                </Pressable>
              ))}
            </ScrollView>
          )}

          {linkedProducts.length === 0 ? (
            <Text variant="caption" color="secondary">Aucun produit lié</Text>
          ) : (
            <View style={styles.chipWrap}>
              {linkedProducts.map(p => {
                const isPrimary = p.supplier_id === id;
                const canUnlink = !isPrimary && (role === 'administrateur' || role === 'manager');
                return (
                  <View key={p.id} style={[styles.chip, canUnlink && { paddingRight: 6 }]}>
                    <Text style={styles.chipText}>{p.name}</Text>
                    {canUnlink && (
                      <Pressable onPress={() => { void unlinkProduct(p.id); }} hitSlop={14} style={{ marginLeft: 4 }}>
                        <Text style={{ color: palette.primary, fontSize: 13, fontFamily: fontFamily.bold }}>×</Text>
                      </Pressable>
                    )}
                  </View>
                );
              })}
            </View>
          )}
        </View>

        {/* ── Outstanding debt ── */}
        {totalOwed > 0 && (
          <View style={styles.section}>
            <Card style={styles.debtCard}>
              <View>
                <Text variant="caption" color="secondary">Montant dû</Text>
                <Text style={styles.debtAmt}>{fmt(totalOwed, currency)}</Text>
              </View>
              <Button label="Payer" onPress={() => setShowPay(true)} size="sm" />
            </Card>
          </View>
        )}

        {/* ── Payment history ── */}
        {(() => {
          const supplierPayments = payments.filter((p: SupplierPayment) => p.supplier_id === id);
          if (supplierPayments.length === 0) return null;
          return (
            <View style={styles.section}>
              <Text variant="label" color="secondary" style={{ marginBottom: spacing[3] }}>Paiements effectués</Text>
              {supplierPayments.map((p: SupplierPayment) => (
                <View key={p.id} style={styles.orderRow}>
                  <View style={{ flex: 1 }}>
                    <Text variant="body">
                      {new Date(p.paid_at).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' })}
                    </Text>
                    {p.note ? <Text variant="caption" color="secondary">{p.note}</Text> : null}
                  </View>
                  <Text variant="label" style={{ color: palette.success }}>{fmt(p.amount, currency)}</Text>
                </View>
              ))}
            </View>
          );
        })()}

        {/* ── Livraisons ── */}
        {supplierLivraisons.length > 0 && <View style={styles.section}>
          <Text variant="label" color="secondary" style={{ marginBottom: spacing[3] }}>Livraisons</Text>
          {supplierLivraisons.map(livraison => (
            <Pressable
              key={livraison.id}
              onPress={() => openLivraisonDetail(livraison)}
              style={({ pressed }) => [styles.orderRow, pressed && { opacity: 0.6 }]}>
              <View style={{ flex: 1 }}>
                <Text variant="body">
                  {new Date(livraison.ordered_at).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' })}
                </Text>
                <Text variant="caption" color="secondary">{fmt(livraison.total_cost, currency)}</Text>
              </View>
              <Ionicons name="chevron-forward" size={14} color={palette.textDisabled} style={{ marginLeft: 4 }} />
            </Pressable>
          ))}
        </View>}

      </ScrollView>

      {/* ── Pinned CTA ── */}
      <View style={styles.footer}>
        <Button
          label="Nouvelle livraison"
          onPress={() => router.push({ pathname: '/(app)/fournisseurs/reception', params: { supplierId: fournisseur.id } })}
          fullWidth size="lg"
        />
      </View>

      {/* ── Modals ── */}
      <FormSheet
        visible={showPay}
        onClose={() => { setShowPay(false); setPayAmount(''); }}
        title="Paiement fournisseur"
        presentationStyle="formSheet"
        contentContainerStyle={styles.mpad}
        footer={
          <View style={styles.mfooter}>
            <Button
              label={paying ? '…' : 'Confirmer le paiement'}
              loading={paying} fullWidth size="lg"
              onPress={handlePay}
            />
          </View>
        }
        accessory={
          Platform.OS === 'ios' ? (
            <InputAccessoryView nativeID={PAY_FORM_SILENT_ACCESSORY_ID}>
              <View style={{ height: 0 }} />
            </InputAccessoryView>
          ) : undefined
        }
      >
        <Card style={{ padding: spacing[4], gap: spacing[1] }}>
          <Text variant="caption" color="secondary">Solde dû à {fournisseur.name}</Text>
          <Text style={[styles.debtAmt, { color: palette.danger }]}>{fmt(totalOwed, currency)}</Text>
        </Card>
        <Input
          label={`Montant payé (${currency})`}
          value={payAmount}
          onChangeText={v => setPayAmount(formatAmountInput(v, currency))}
          keyboardType="decimal-pad"
          inputAccessoryViewID={Platform.OS === 'ios' ? PAY_FORM_SILENT_ACCESSORY_ID : undefined}
        />
      </FormSheet>

      {detailLivraison && (
        <LivraisonDetail
          livraison={detailLivraison}
          fournisseurName={fournisseur.name}
          currency={currency}
          businessId={businessId}
          canAttach={canWrite}
          offline={offline}
          onClose={() => setDetailLivraison(null)}
          onProofAttached={(proof) => {
            setDetailLivraison(prev => prev ? {
              ...prev,
              proof_image_url: proof.url,
              proof_image_width: proof.width,
              proof_image_height: proof.height,
            } : prev);
            void fetchCommandes(businessId);
          }}
          onProofDeleted={() => {
            setDetailLivraison(prev => prev ? {
              ...prev,
              proof_image_url: null,
              proof_image_width: null,
              proof_image_height: null,
              proof_attached_by: null,
              proof_attached_at: null,
            } : prev);
            void fetchCommandes(businessId);
          }}
        />
      )}
    </Screen>
  );
}

function makeStyles(p: Palette) {
  return StyleSheet.create({
    safe: { flex: 1, backgroundColor: p.background },
    header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: spacing[5], paddingVertical: spacing[4], borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: p.border },
    headerBtn: { padding: 4 },
    scroll: { paddingBottom: 120 },

    // Hero
    hero: { alignItems: 'center', paddingTop: spacing[8], paddingBottom: spacing[6], paddingHorizontal: spacing[5] },
    avatar: { width: 70, height: 70, borderRadius: 35, backgroundColor: p.primaryLight, alignItems: 'center', justifyContent: 'center' },
    initials: { fontFamily: fontFamily.bold, fontSize: 26, lineHeight: 26, color: p.primary, includeFontPadding: false },
    heroName: { fontFamily: fontFamily.bold, fontSize: 22, color: p.textPrimary, marginTop: 12, textAlign: 'center' },
    contactRow: { flexDirection: 'row', gap: spacing[2], marginTop: 10 },
    callBtn: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 18, paddingVertical: 8, borderRadius: 20, borderWidth: 1.5, borderColor: p.primary },
    callText: { fontFamily: fontFamily.semibold, fontSize: 14, color: p.primary },

    // Sections
    section: { paddingHorizontal: spacing[5], paddingTop: spacing[5], paddingBottom: spacing[2] },

    // Products
    chipWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing[2] },
    chip: { flexDirection: 'row' as const, alignItems: 'center' as const, backgroundColor: p.primaryLight, paddingHorizontal: 12, paddingVertical: 6, borderRadius: 16 },
    chipText: { fontFamily: fontFamily.medium, fontSize: 13, color: p.primary },

    // Debt
    debtCard: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
    debtAmt: { fontFamily: fontFamily.bold, fontSize: 20, color: p.danger, marginTop: 2 },

    // Livraisons
    orderRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: spacing[3], borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: p.border },

    // Footer
    footer: {
      position: 'absolute', bottom: 0, left: 0, right: 0,
      padding: spacing[5], paddingBottom: spacing[8],
      backgroundColor: p.background,
      borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: p.border,
    },

    // Shared modal styles
    modalSafe: { flex: 1, backgroundColor: p.background },
    mhdr: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: spacing[5], borderBottomWidth: 1, borderBottomColor: p.border },
    mpad: { padding: spacing[5], gap: spacing[4], paddingBottom: spacing[10] },
    // Soft upward shadow instead of a hard top border — matches catalogue.tsx's
    // product-form footer (see CLAUDE.md), which replaced the same harder-edged
    // bordered-panel look for the identical reason: it read as a stray
    // rectangle sitting behind the button rather than part of the sheet.
    mfooter: { padding: spacing[5], backgroundColor: p.background, ...shadow.md, shadowOffset: { width: 0, height: -2 } },

    dr: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  });
}
