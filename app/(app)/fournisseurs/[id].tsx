import { useEffect, useRef, useState } from 'react';
import {
  Alert, KeyboardAvoidingView, Linking, Modal,
  Platform, Pressable, ScrollView, StyleSheet, View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router, useLocalSearchParams } from 'expo-router';
import { Button } from '@/src/components/ui/Button';
import { Card } from '@/src/components/ui/Card';
import { Input } from '@/src/components/ui/Input';
import { Text } from '@/src/components/ui/Text';
import { palette, spacing, radius } from '@/src/theme';
import { useAuthStore } from '@/stores/auth';
import { useProductStore } from '@/stores/products';
import {
  useFournisseursStore,
  type CommandeAchat,
  type Fournisseur,
} from '@/stores/fournisseurs';
import type { Product } from '@/src/types';

function fmt(n: number, cur: string) {
  return `${Math.round(n).toLocaleString('fr-FR')} ${cur}`;
}

const STATUS_LABEL: Record<string, string> = {
  brouillon: 'Non confirmé', envoye: 'Envoyé',
  recu_partiel: 'Partiel', recu: 'Reçu', annule: 'Annulé',
};
const STATUS_COLOR: Record<string, string> = {
  brouillon: palette.textSecondary, envoye: palette.primary,
  recu_partiel: palette.warning, recu: palette.success, annule: palette.danger,
};

// ── Commande Form ─────────────────────────────────────────────────────────────

function CommandeForm({
  visible, fournisseur, products, currency, saving, onClose, onSave,
}: {
  visible: boolean; fournisseur: Fournisseur; products: Product[];
  currency: string; saving: boolean; onClose: () => void;
  onSave: (lines: { product_id: string; product_name: string; qty: number; unit_cost: number }[], amountPaid: number) => Promise<void>;
}) {
  const [lines, setLines] = useState<{ product_id: string; product_name: string; qty: string; unit_cost: string }[]>([]);
  const [showPicker, setShowPicker] = useState(false);
  const [paymentInput, setPaymentInput] = useState('');
  const seededRef = useRef<string | null>(null);

  useEffect(() => {
    if (!visible) { seededRef.current = null; setPaymentInput(''); return; }
    const fId = fournisseur.id;
    if (seededRef.current === fId && lines.length > 0) return;
    seededRef.current = fId;
    setShowPicker(false);
    const linked = products.filter(p => p.supplier_id === fId && !p.archived);
    setLines(linked.map(p => ({ product_id: p.id, product_name: p.name, qty: '1', unit_cost: String(p.cost_price) })));
  }, [visible, products, fournisseur.id]);

  const total = lines.reduce((s, l) => s + (parseInt(l.qty) || 0) * (parseFloat(l.unit_cost) || 0), 0);
  const parsedPaid = paymentInput.trim() === ''
    ? total
    : (parseFloat(paymentInput.replace(/\s/g, '').replace(',', '.')) || 0);
  const owed = Math.max(0, total - parsedPaid);
  const lineIds = new Set(lines.map(l => l.product_id));
  const pickerProducts = [...products]
    .filter(p => !lineIds.has(p.id) && !p.archived)
    .sort((a, b) => (a.supplier_id === fournisseur.id ? -1 : 0) - (b.supplier_id === fournisseur.id ? -1 : 0));

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <SafeAreaView style={styles.modalSafe} edges={['bottom']}>
        <View style={styles.mhdr}>
          <Pressable onPress={onClose}><Text variant="body" color="secondary">Annuler</Text></Pressable>
          <Text variant="h4">Nouvelle commande</Text>
          <View style={{ width: 60 }} />
        </View>
        <ScrollView contentContainerStyle={styles.mpad} keyboardShouldPersistTaps="handled">
          <Text variant="label" color="secondary">{fournisseur.name}</Text>

          {(lines.length === 0 || showPicker) && (
            <>
              <Text variant="label">{lines.length === 0 ? 'Produits à commander' : 'Ajouter depuis le catalogue'}</Text>
              {pickerProducts.length > 0 ? (
                <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ flexGrow: 0 }}>
                  {pickerProducts.map(p => (
                    <Pressable
                      key={p.id}
                      onPress={() => {
                        setLines(prev => [...prev, { product_id: p.id, product_name: p.name, qty: '1', unit_cost: String(p.cost_price) }]);
                        setShowPicker(false);
                      }}
                      style={[styles.prodChip, p.supplier_id === fournisseur.id && styles.prodChipLinked]}>
                      <Text variant="caption" numberOfLines={1}
                        style={{ color: p.supplier_id === fournisseur.id ? palette.primary : palette.textPrimary }}>
                        {p.name}
                      </Text>
                    </Pressable>
                  ))}
                </ScrollView>
              ) : (
                <Text variant="caption" color="secondary">Tous les produits sont déjà dans la commande.</Text>
              )}
            </>
          )}

          {lines.map((l, i) => (
            <Card key={i} style={styles.lineCard}>
              <View style={styles.lineTop}>
                <Text variant="label" style={{ flex: 1 }} numberOfLines={1}>{l.product_name}</Text>
                <Pressable onPress={() => setLines(prev => prev.filter((_, j) => j !== i))}>
                  <Text variant="caption" color="danger">Retirer</Text>
                </Pressable>
              </View>
              <View style={styles.lineInputs}>
                <View style={{ flex: 1, minWidth: 80 }}>
                  <Input label="Qté" value={l.qty}
                    onChangeText={v => setLines(prev => prev.map((x, j) => j === i ? { ...x, qty: v } : x))}
                    keyboardType="number-pad" />
                </View>
                <View style={{ flex: 2 }}>
                  <Input label={`Coût (${currency})`} value={l.unit_cost}
                    onChangeText={v => setLines(prev => prev.map((x, j) => j === i ? { ...x, unit_cost: v } : x))}
                    keyboardType="decimal-pad" />
                </View>
              </View>
            </Card>
          ))}

          {lines.length > 0 && !showPicker && (
            <Pressable onPress={() => setShowPicker(true)} style={styles.addMoreBtn}>
              <Ionicons name="add-circle-outline" size={18} color={palette.primary} />
              <Text variant="label" style={{ color: palette.primary, marginLeft: 6 }}>Ajouter un autre produit</Text>
            </Pressable>
          )}

          {lines.length > 0 && (
            <>
              <Card style={styles.totalRow}>
                <Text variant="label">Total de la commande</Text>
                <Text variant="amountLarge" style={{ color: palette.primary }}>{fmt(total, currency)}</Text>
              </Card>

              <Input
                label={`Montant payé (${currency})`}
                value={paymentInput}
                onChangeText={setPaymentInput}
                keyboardType="decimal-pad"
                placeholder={total > 0 ? String(Math.round(total)) : '0'}
              />

              {owed > 0 && (
                <Card style={styles.owedBanner}>
                  <Ionicons name="time-outline" size={16} color="#92400E" />
                  <Text style={styles.owedText}>
                    Ce solde de {fmt(owed, currency)} sera enregistré comme crédit auprès de ce fournisseur
                  </Text>
                </Card>
              )}
              {paymentInput.trim() !== '' && owed === 0 && parsedPaid >= total && total > 0 && (
                <Card style={styles.paidBanner}>
                  <Ionicons name="checkmark-circle-outline" size={16} color="#065F46" />
                  <Text style={styles.paidText}>Commande entièrement payée</Text>
                </Card>
              )}
            </>
          )}
        </ScrollView>
        <View style={styles.mfooter}>
          <Button
            label={saving ? '…' : 'Passer la commande'} loading={saving} fullWidth size="lg"
            disabled={lines.length === 0}
            onPress={() => {
              const parsed = lines.map(l => ({
                product_id: l.product_id, product_name: l.product_name,
                qty: parseInt(l.qty) || 0, unit_cost: parseFloat(l.unit_cost) || 0,
              }));
              const invalid = parsed.find(l => l.qty <= 0 || l.unit_cost <= 0);
              if (invalid) { Alert.alert(`Un petit contrôle sur la quantité et le coût :)`, `"${invalid.product_name}"`); return; }
              const effectivePaid = paymentInput.trim() === '' ? total : parsedPaid;
              onSave(parsed, effectivePaid);
            }}
          />
        </View>
      </SafeAreaView>
    </Modal>
  );
}

// ── Order detail modal ─────────────────────────────────────────────────────────

function OrderDetail({ order, currency, onClose }: {
  order: CommandeAchat; currency: string; onClose: () => void;
}) {
  return (
    <Modal visible animationType="slide" presentationStyle="formSheet" onRequestClose={onClose}>
      <SafeAreaView style={styles.modalSafe} edges={['bottom']}>
        <View style={styles.mhdr}>
          <Pressable onPress={onClose}><Text variant="body" color="secondary">Fermer</Text></Pressable>
          <Text variant="h4">Commande</Text>
          <View style={{ width: 60 }} />
        </View>
        <ScrollView contentContainerStyle={styles.mpad}>
          <Card style={{ gap: spacing[2] }}>
            <View style={styles.dr}><Text variant="caption" color="secondary">Statut</Text>
              <Text variant="label" style={{ color: STATUS_COLOR[order.status] }}>{STATUS_LABEL[order.status]}</Text></View>
            <View style={styles.dr}><Text variant="caption" color="secondary">Date</Text>
              <Text variant="label">{new Date(order.ordered_at).toLocaleDateString('fr-FR')}</Text></View>
            <View style={styles.dr}><Text variant="caption" color="secondary">Total</Text>
              <Text variant="label">{fmt(order.total_cost, currency)}</Text></View>
          </Card>
          {order.lines?.map(l => (
            <Card key={l.id} style={{ gap: 2 }}>
              <Text variant="body">{l.product_name}</Text>
              <View style={styles.dr}>
                <Text variant="caption" color="secondary">×{l.qty_ordered} × {fmt(l.unit_cost, currency)}/u</Text>
                <Text variant="label">{fmt(l.qty_ordered * l.unit_cost, currency)}</Text>
              </View>
            </Card>
          ))}
        </ScrollView>
      </SafeAreaView>
    </Modal>
  );
}

// ── Profile screen ────────────────────────────────────────────────────────────

export default function FournisseurProfile() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const session    = useAuthStore(s => s.session);
  const businessId = session?.activeBusiness?.id ?? '';
  const currency   = session?.activeBusiness?.currency ?? 'GNF';
  const userId     = session?.user.id ?? '';

  const { products, fetchProducts } = useProductStore();
  const {
    fournisseurs, commandes, debts, saving,
    fetchFournisseurs, fetchCommandes, fetchDebts,
    createCommande, loadCommandeLines, deleteFournisseur, payDebt,
  } = useFournisseursStore();

  const fournisseur    = fournisseurs.find(f => f.id === id);
  const linkedProducts = products.filter(p => p.supplier_id === id && !p.archived);
  const supplierOrders = commandes
    .filter(c => c.supplier_id === id)
    .sort((a, b) => new Date(b.ordered_at).getTime() - new Date(a.ordered_at).getTime());
  const totalOwed = debts
    .filter(d => d.supplier_id === id)
    .reduce((s, d) => s + Math.max(0, d.amount - d.amount_paid), 0);

  const [showCommande, setShowCommande] = useState(false);
  const [showPay, setShowPay]           = useState(false);
  const [payAmount, setPayAmount]       = useState('');
  const [paying, setPaying]             = useState(false);
  const [detailOrder, setDetailOrder]   = useState<CommandeAchat | null>(null);

  useEffect(() => {
    if (!businessId) return;
    if (fournisseurs.length === 0) fetchFournisseurs(businessId);
    if (products.length === 0) fetchProducts(businessId, userId);
    fetchDebts(businessId);
    fetchCommandes(businessId);
  }, [businessId]);

  const handleDelete = () => {
    Alert.alert(
      `Supprimer ${fournisseur?.name ?? ''} ?`,
      'Les produits liés seront dissociés. Cette action est irréversible.',
      [
        { text: 'Annuler', style: 'cancel' },
        {
          text: 'Supprimer', style: 'destructive',
          onPress: async () => {
            const ok = await deleteFournisseur(id, businessId);
            if (ok) router.back();
            else Alert.alert('Ce fournisseur a des commandes enregistrées — retirez-les d\'abord :)');
          },
        },
      ]
    );
  };

  const handlePay = async () => {
    const amount = parseFloat(payAmount.replace(/\s/g, '').replace(',', '.'));
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

  const openOrderDetail = async (order: CommandeAchat) => {
    if (!order.lines) await loadCommandeLines(order.id);
    const updated = useFournisseursStore.getState().commandes.find(c => c.id === order.id) ?? order;
    setDetailOrder(updated);
  };

  if (!fournisseur) {
    return (
      <SafeAreaView style={styles.safe} edges={['top', 'bottom']}>
        <View style={styles.header}>
          <Pressable onPress={() => router.back()}>
            <Text variant="body" color="secondary">‹ Retour</Text>
          </Pressable>
        </View>
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
          <Text variant="body" color="secondary">Fournisseur introuvable</Text>
        </View>
      </SafeAreaView>
    );
  }

  const initials = fournisseur.name
    .split(/\s+/).slice(0, 2)
    .map(w => w[0]?.toUpperCase() ?? '')
    .join('');

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>

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
          style={styles.headerBtn}>
          <Ionicons name="ellipsis-horizontal" size={22} color={palette.textSecondary} />
        </Pressable>
      </View>

      <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>

        {/* ── Hero ── */}
        <View style={styles.hero}>
          <View style={styles.avatar}>
            <Text style={styles.initials}>{initials}</Text>
          </View>
          <Text style={styles.heroName}>{fournisseur.name}</Text>
          {fournisseur.phone ? (
            <Pressable
              onPress={() => Linking.openURL(`tel:${fournisseur.phone}`)}
              style={styles.callBtn}>
              <Ionicons name="call-outline" size={15} color={palette.primary} />
              <Text style={styles.callText}>Appeler</Text>
            </Pressable>
          ) : (
            <Text variant="caption" color="secondary" style={{ marginTop: 8 }}>Pas de numéro</Text>
          )}
        </View>

        {/* ── Products ── */}
        <View style={styles.section}>
          <Text variant="label" color="secondary" style={{ marginBottom: spacing[3] }}>Produits fournis</Text>
          {linkedProducts.length === 0 ? (
            <Text variant="caption" color="secondary">Aucun produit lié</Text>
          ) : (
            <View style={styles.chipWrap}>
              {linkedProducts.map(p => (
                <View key={p.id} style={styles.chip}>
                  <Text style={styles.chipText}>{p.name}</Text>
                </View>
              ))}
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

        {/* ── Order history ── */}
        <View style={styles.section}>
          <Text variant="label" color="secondary" style={{ marginBottom: spacing[3] }}>Historique des commandes</Text>
          {supplierOrders.length === 0 ? (
            <Text variant="caption" color="secondary">Aucune commande enregistrée</Text>
          ) : supplierOrders.map(order => (
            <Pressable
              key={order.id}
              onPress={() => openOrderDetail(order)}
              style={({ pressed }) => [styles.orderRow, pressed && { opacity: 0.6 }]}>
              <View style={{ flex: 1 }}>
                <Text variant="body">
                  {new Date(order.ordered_at).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' })}
                </Text>
                <Text variant="caption" color="secondary">{fmt(order.total_cost, currency)}</Text>
              </View>
              <View style={[styles.statusPill, { backgroundColor: STATUS_COLOR[order.status] + '22' }]}>
                <Text style={[styles.statusText, { color: STATUS_COLOR[order.status] }]}>
                  {STATUS_LABEL[order.status]}
                </Text>
              </View>
              <Ionicons name="chevron-forward" size={14} color={palette.textDisabled} style={{ marginLeft: 4 }} />
            </Pressable>
          ))}
        </View>

      </ScrollView>

      {/* ── Pinned CTA ── */}
      <View style={styles.footer}>
        <Button label="Passer une commande" onPress={() => setShowCommande(true)} fullWidth size="lg" />
      </View>

      {/* ── Modals ── */}
      <CommandeForm
        visible={showCommande}
        fournisseur={fournisseur}
        products={products}
        currency={currency}
        saving={saving}
        onClose={() => setShowCommande(false)}
        onSave={async (lines, amountPaid) => {
          const ok = await createCommande(businessId, userId, { supplierId: fournisseur.id, lines, amountPaid });
          if (ok) setShowCommande(false);
        }}
      />

      <Modal
        visible={showPay}
        animationType="slide"
        presentationStyle="formSheet"
        onRequestClose={() => { setShowPay(false); setPayAmount(''); }}>
        <SafeAreaView style={styles.modalSafe} edges={['bottom']}>
          <View style={styles.mhdr}>
            <Pressable onPress={() => { setShowPay(false); setPayAmount(''); }}>
              <Text variant="body" color="secondary">Annuler</Text>
            </Pressable>
            <Text variant="h4">Paiement fournisseur</Text>
            <View style={{ width: 60 }} />
          </View>
          <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1 }}>
            <ScrollView contentContainerStyle={styles.mpad} keyboardShouldPersistTaps="handled">
              <Card style={{ padding: spacing[4], gap: spacing[1] }}>
                <Text variant="caption" color="secondary">Solde dû à {fournisseur.name}</Text>
                <Text style={[styles.debtAmt, { color: palette.danger }]}>{fmt(totalOwed, currency)}</Text>
              </Card>
              <Input
                label={`Montant payé (${currency})`}
                value={payAmount}
                onChangeText={setPayAmount}
                keyboardType="decimal-pad"
                placeholder="0"
              />
            </ScrollView>
            <View style={styles.mfooter}>
              <Button
                label={paying ? '…' : 'Confirmer le paiement'}
                loading={paying} fullWidth size="lg"
                onPress={handlePay}
              />
            </View>
          </KeyboardAvoidingView>
        </SafeAreaView>
      </Modal>

      {detailOrder && (
        <OrderDetail order={detailOrder} currency={currency} onClose={() => setDetailOrder(null)} />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe:      { flex: 1, backgroundColor: palette.background },
  header:    { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: spacing[5], paddingVertical: spacing[4], borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: palette.border },
  headerBtn: { padding: 4 },
  scroll:    { paddingBottom: 120 },

  // Hero
  hero:     { alignItems: 'center', paddingTop: spacing[8], paddingBottom: spacing[6], paddingHorizontal: spacing[5] },
  avatar:   { width: 70, height: 70, borderRadius: 35, backgroundColor: '#EEF2FF', alignItems: 'center', justifyContent: 'center' },
  initials: { fontSize: 26, fontWeight: '700' as const, color: '#4F46E5' },
  heroName: { fontSize: 22, fontWeight: '700' as const, color: '#1F2937', marginTop: 12, textAlign: 'center' },
  callBtn:  { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 10, paddingHorizontal: 18, paddingVertical: 8, borderRadius: 20, borderWidth: 1.5, borderColor: palette.primary },
  callText: { fontSize: 14, fontWeight: '600' as const, color: palette.primary },

  // Sections
  section: { paddingHorizontal: spacing[5], paddingTop: spacing[5], paddingBottom: spacing[2] },

  // Products
  chipWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing[2] },
  chip:     { backgroundColor: '#EEF2FF', paddingHorizontal: 12, paddingVertical: 6, borderRadius: 16 },
  chipText: { fontSize: 13, fontWeight: '500' as const, color: '#4F46E5' },

  // Debt
  debtCard: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  debtAmt:  { fontSize: 20, fontWeight: '700' as const, color: palette.danger, marginTop: 2 },

  // Orders
  orderRow:   { flexDirection: 'row', alignItems: 'center', paddingVertical: spacing[3], borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: palette.border },
  statusPill: { paddingHorizontal: spacing[2], paddingVertical: 2, borderRadius: radius.sm },
  statusText: { fontSize: 12, fontWeight: '500' as const },

  // Footer
  footer: {
    position: 'absolute', bottom: 0, left: 0, right: 0,
    padding: spacing[5], paddingBottom: spacing[8],
    backgroundColor: palette.background,
    borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: palette.border,
  },

  // Shared modal styles
  modalSafe: { flex: 1, backgroundColor: palette.background },
  mhdr:      { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: spacing[5], borderBottomWidth: 1, borderBottomColor: palette.border },
  mpad:      { padding: spacing[5], gap: spacing[4], paddingBottom: spacing[10] },
  mfooter:   { padding: spacing[5], borderTopWidth: 1, borderTopColor: palette.border },

  // CommandeForm
  prodChip:       { paddingHorizontal: spacing[3], paddingVertical: spacing[2], marginRight: spacing[2], borderRadius: radius.md, borderWidth: 1, borderColor: palette.border, backgroundColor: palette.surface, maxWidth: 140 },
  prodChipLinked: { borderColor: palette.primary, backgroundColor: '#EEF2FF' },
  lineCard:       { gap: spacing[2] },
  lineTop:        { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  lineInputs:     { flexDirection: 'row', gap: spacing[3] },
  totalRow:       { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  addMoreBtn:     { flexDirection: 'row', alignItems: 'center', paddingVertical: spacing[3] },
  owedBanner:     { flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: '#FEF3C7', borderColor: '#FCD34D', borderWidth: 1 },
  owedText:       { flex: 1, fontSize: 13, color: '#92400E' },
  paidBanner:     { flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: '#D1FAE5', borderColor: '#6EE7B7', borderWidth: 1 },
  paidText:       { flex: 1, fontSize: 13, color: '#065F46' },

  // OrderDetail
  dr: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
});
