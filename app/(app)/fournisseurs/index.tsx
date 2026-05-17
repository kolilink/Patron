import { useEffect, useState } from 'react';
import { Alert, FlatList, KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import { Button } from '@/src/components/ui/Button';
import { Card } from '@/src/components/ui/Card';
import { Input } from '@/src/components/ui/Input';
import { Text } from '@/src/components/ui/Text';
import { palette, spacing, radius } from '@/src/theme';
import { useAuthStore } from '@/stores/auth';
import { useProductStore } from '@/stores/products';
import { useFournisseursStore, type CommandeAchat, type Fournisseur } from '@/stores/fournisseurs';
import { supabase } from '@/lib/supabase';
import type { Product } from '@/src/types';

function fmt(n: number, cur: string) { return `${n.toLocaleString('fr-FR')} ${cur}`; }

const STATUS_LABEL: Record<string, string> = {
  brouillon: 'Brouillon', envoye: 'Envoyé', recu_partiel: 'Partiel', recu: 'Reçu', annule: 'Annulé',
};
const STATUS_COLOR: Record<string, string> = {
  brouillon: palette.textSecondary, envoye: palette.primary, recu_partiel: palette.warning, recu: palette.success, annule: palette.danger,
};

// ─── Fournisseur Form ─────────────────────────────────────────────────────────

interface FournisseurFormProps {
  visible: boolean;
  editing: Fournisseur | null;
  products: Product[];
  onClose: () => void;
  onSave: (d: { name: string; phone: string; country: string; notes: string; linkedProductIds: string[] }) => Promise<void>;
  saving: boolean;
}

function FournisseurForm({ visible, editing, products, onClose, onSave, saving }: FournisseurFormProps) {
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [country, setCountry] = useState('');
  const [notes, setNotes] = useState('');
  const [linkedIds, setLinkedIds] = useState<string[]>([]);

  useEffect(() => {
    if (visible) {
      setName(editing?.name ?? '');
      setPhone(editing?.phone ?? '');
      setCountry(editing?.country ?? '');
      setNotes(editing?.notes ?? '');
      // Pre-select products already linked to this supplier
      if (editing) {
        const preSelected = products.filter(p => p.supplier_id === editing.id).map(p => p.id);
        setLinkedIds(preSelected);
      } else {
        setLinkedIds([]);
      }
    }
  }, [visible, editing, products]);

  const toggleProduct = (id: string) => {
    setLinkedIds(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);
  };

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <SafeAreaView style={styles.modalSafe}>
        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1 }}>
          <View style={styles.mhdr}>
            <Pressable onPress={onClose}><Text variant="body" color="secondary">Annuler</Text></Pressable>
            <Text variant="h4">{editing ? 'Modifier fournisseur' : 'Nouveau fournisseur'}</Text>
            <View style={{ width: 60 }} />
          </View>

          <ScrollView contentContainerStyle={styles.mpad} keyboardShouldPersistTaps="handled">
            <Input label="Nom *" value={name} onChangeText={setName} placeholder="Ex: Diallo Import" />
            <Input label="Téléphone" value={phone} onChangeText={setPhone} keyboardType="phone-pad" placeholder="+224…" />
            <Input label="Pays" value={country} onChangeText={setCountry} placeholder="Ex: Guinée" />
            <Input label="Notes" value={notes} onChangeText={setNotes} placeholder="Délais, conditions…" multiline />

            {/* Product binding */}
            <View style={{ gap: spacing[2] }}>
              <Text variant="label">Produits fournis</Text>
              {products.length === 0 ? (
                <Text variant="caption" color="secondary">Aucun produit disponible.</Text>
              ) : (
                <View style={styles.productGrid}>
                  {products.map(p => {
                    const selected = linkedIds.includes(p.id);
                    return (
                      <Pressable key={p.id} onPress={() => toggleProduct(p.id)}
                        style={[styles.productChip, selected && styles.productChipActive]}>
                        <Text variant="caption" numberOfLines={1}
                          style={{ color: selected ? palette.textInverse : palette.textPrimary }}>
                          {p.name}
                        </Text>
                        {selected && (
                          <Text variant="caption" style={{ color: palette.textInverse, marginLeft: 4 }}>✓</Text>
                        )}
                      </Pressable>
                    );
                  })}
                </View>
              )}
              {linkedIds.length > 0 && (
                <Text variant="caption" color="secondary">{linkedIds.length} produit(s) sélectionné(s)</Text>
              )}
            </View>
          </ScrollView>

          <View style={styles.mfooter}>
            <Button
              label={saving ? '…' : 'Enregistrer'}
              loading={saving}
              fullWidth
              size="lg"
              onPress={() => {
                if (!name.trim()) { Alert.alert('Nom requis'); return; }
                onSave({ name, phone, country, notes, linkedProductIds: linkedIds });
              }}
            />
          </View>
        </KeyboardAvoidingView>
      </SafeAreaView>
    </Modal>
  );
}

// ─── Commande Form ────────────────────────────────────────────────────────────

interface CommandeFormProps {
  visible: boolean;
  fournisseur: Fournisseur | null;
  currency: string;
  onClose: () => void;
  onSave: (lines: { product_id: string; product_name: string; qty: number; unit_cost: number }[]) => Promise<void>;
  saving: boolean;
}

function CommandeForm({ visible, fournisseur, currency, onClose, onSave, saving }: CommandeFormProps) {
  const { products } = useProductStore();
  const [lines, setLines] = useState<{ product_id: string; product_name: string; qty: string; unit_cost: string }[]>([]);
  useEffect(() => { if (visible) setLines([]); }, [visible]);

  const addLine = (p: { id: string; name: string; cost_price: number }) =>
    setLines(prev => [...prev, { product_id: p.id, product_name: p.name, qty: '1', unit_cost: String(p.cost_price) }]);

  const total = lines.reduce((s, l) => s + (parseInt(l.qty) || 0) * (parseFloat(l.unit_cost) || 0), 0);

  // Show products linked to this supplier first
  const sortedProducts = fournisseur
    ? [...products].sort((a, b) => {
        const aLinked = a.supplier_id === fournisseur.id ? -1 : 0;
        const bLinked = b.supplier_id === fournisseur.id ? -1 : 0;
        return aLinked - bLinked;
      })
    : products;

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <SafeAreaView style={styles.modalSafe}>
        <View style={styles.mhdr}>
          <Pressable onPress={onClose}><Text variant="body" color="secondary">Annuler</Text></Pressable>
          <Text variant="h4">Bon de commande</Text>
          <View style={{ width: 60 }} />
        </View>
        <ScrollView contentContainerStyle={styles.mpad} keyboardShouldPersistTaps="handled">
          {fournisseur && <Text variant="label" color="secondary">{fournisseur.name}</Text>}

          <Text variant="label">Produits à commander</Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ flexGrow: 0 }}>
            {sortedProducts.map(p => (
              <Pressable key={p.id} onPress={() => addLine(p)}
                style={[styles.prodChip, p.supplier_id === fournisseur?.id && styles.prodChipLinked]}>
                <Text variant="caption" numberOfLines={1}
                  style={{ color: p.supplier_id === fournisseur?.id ? palette.primary : palette.textPrimary }}>
                  {p.name}
                </Text>
              </Pressable>
            ))}
          </ScrollView>

          {lines.length === 0 ? (
            <Text variant="caption" color="secondary">Touchez un produit pour l'ajouter.</Text>
          ) : (
            lines.map((l, i) => (
              <Card key={i} style={styles.lineCard}>
                <View style={styles.lineTop}>
                  <Text variant="label" style={{ flex: 1 }} numberOfLines={1}>{l.product_name}</Text>
                  <Pressable onPress={() => setLines(prev => prev.filter((_, j) => j !== i))}>
                    <Text variant="caption" color="danger">Retirer</Text>
                  </Pressable>
                </View>
                <View style={styles.lineInputs}>
                  <Input label="Qté" value={l.qty}
                    onChangeText={v => setLines(prev => prev.map((x, j) => j === i ? { ...x, qty: v } : x))}
                    keyboardType="number-pad" style={{ flex: 1 }} />
                  <Input label={`Coût (${currency})`} value={l.unit_cost}
                    onChangeText={v => setLines(prev => prev.map((x, j) => j === i ? { ...x, unit_cost: v } : x))}
                    keyboardType="decimal-pad" style={{ flex: 1 }} />
                </View>
              </Card>
            ))
          )}

          {lines.length > 0 && (
            <Card style={styles.totalRow}>
              <Text variant="label">Total estimé</Text>
              <Text variant="amountLarge" style={{ color: palette.primary }}>{fmt(total, currency)}</Text>
            </Card>
          )}
        </ScrollView>
        <View style={styles.mfooter}>
          <Button label={saving ? '…' : 'Créer la commande'} loading={saving} fullWidth size="lg"
            disabled={lines.length === 0}
            onPress={() => {
              const parsed = lines.map(l => ({
                product_id: l.product_id, product_name: l.product_name,
                qty: parseInt(l.qty) || 0, unit_cost: parseFloat(l.unit_cost) || 0,
              }));
              const invalid = parsed.find(l => l.qty <= 0 || l.unit_cost <= 0);
              if (invalid) {
                Alert.alert('Données invalides', `Vérifiez la quantité et le coût pour "${invalid.product_name}".`);
                return;
              }
              onSave(parsed);
            }} />
        </View>
      </SafeAreaView>
    </Modal>
  );
}

// ─── Commande Detail Modal ────────────────────────────────────────────────────

interface CommandeDetailProps {
  commande: CommandeAchat;
  currency: string;
  onClose: () => void;
  onRecevoir: () => void;
  saving: boolean;
}

function CommandeDetail({ commande, currency, onClose, onRecevoir, saving }: CommandeDetailProps) {
  return (
    <Modal visible animationType="slide" presentationStyle="formSheet" onRequestClose={onClose}>
      <SafeAreaView style={styles.modalSafe}>
        <View style={styles.mhdr}>
          <Pressable onPress={onClose}><Text variant="body" color="secondary">Fermer</Text></Pressable>
          <Text variant="h4">{commande.supplier_name}</Text>
          <View style={{ width: 60 }} />
        </View>
        <ScrollView contentContainerStyle={styles.mpad}>
          <Card style={{ gap: spacing[2] }}>
            <View style={styles.dr}><Text variant="caption" color="secondary">Statut</Text><Text variant="label" style={{ color: STATUS_COLOR[commande.status] }}>{STATUS_LABEL[commande.status]}</Text></View>
            <View style={styles.dr}><Text variant="caption" color="secondary">Date</Text><Text variant="label">{new Date(commande.ordered_at).toLocaleDateString('fr-FR')}</Text></View>
            <View style={styles.dr}><Text variant="caption" color="secondary">Total</Text><Text variant="label">{fmt(commande.total_cost, currency)}</Text></View>
          </Card>
          {commande.lines && commande.lines.map(l => (
            <Card key={l.id} style={{ gap: 2 }}>
              <Text variant="body">{l.product_name}</Text>
              <View style={styles.dr}>
                <Text variant="caption" color="secondary">×{l.qty_ordered} × {fmt(l.unit_cost, currency)}/u</Text>
                <Text variant="label">{fmt(l.qty_ordered * l.unit_cost, currency)}</Text>
              </View>
            </Card>
          ))}
          {commande.status === 'brouillon' && (
            <Button label={saving ? '…' : 'Marquer comme reçu'} loading={saving} variant="primary" fullWidth onPress={onRecevoir} />
          )}
        </ScrollView>
      </SafeAreaView>
    </Modal>
  );
}

// ─── Main Screen ──────────────────────────────────────────────────────────────

export default function FournisseursScreen() {
  const session = useAuthStore(s => s.session);
  const businessId = session?.activeBusiness?.id ?? '';
  const currency = session?.activeBusiness?.currency ?? 'GNF';
  const userId = session?.user.id ?? '';

  const { products, fetchProducts } = useProductStore();
  const {
    fournisseurs, commandes, loading, saving,
    fetchFournisseurs, createFournisseur, updateFournisseur, deleteFournisseur,
    fetchCommandes, createCommande, loadCommandeLines, recevoirCommande,
  } = useFournisseursStore();

  const [tab, setTab] = useState<'fournisseurs' | 'commandes'>('fournisseurs');
  const [showForm, setShowForm] = useState(false);
  const [editF, setEditF] = useState<Fournisseur | null>(null);
  const [showCommande, setShowCommande] = useState(false);
  const [commandeTarget, setCommandeTarget] = useState<Fournisseur | null>(null);
  const [detailCommande, setDetailCommande] = useState<CommandeAchat | null>(null);

  useEffect(() => {
    if (!businessId) return;
    fetchFournisseurs(businessId);
    fetchCommandes(businessId);
    fetchProducts(businessId, userId);
  }, [businessId]);

  const openCommandeDetail = async (c: CommandeAchat) => {
    if (!c.lines) await loadCommandeLines(c.id);
    setDetailCommande(useFournisseursStore.getState().commandes.find(x => x.id === c.id) ?? c);
  };

  const handleRecevoir = async () => {
    if (!detailCommande) return;
    const ok = await recevoirCommande(detailCommande.id, businessId, userId);
    if (ok) {
      Alert.alert('Commande reçue. Stock mis à jour.');
      setDetailCommande(null);
      fetchProducts(businessId, userId);
    } else {
      Alert.alert('Erreur', 'Impossible de réceptionner la commande.');
    }
  };

  const handleSaveFournisseur = async (d: { name: string; phone: string; country: string; notes: string; linkedProductIds: string[] }) => {
    let supplierId: string | null = editF?.id ?? null;
    let ok: boolean;

    if (editF) {
      ok = await updateFournisseur(editF.id, d);
      supplierId = editF.id;
    } else {
      const result = await createFournisseur(businessId, userId, d);
      ok = result;
      if (ok) {
        // Get the newly created supplier id
        const latest = useFournisseursStore.getState().fournisseurs.find(f => f.name.trim() === d.name.trim());
        supplierId = latest?.id ?? null;
      }
    }

    if (ok && supplierId) {
      // 1. Clear supplier_id for products previously linked to this supplier but now unselected
      if (d.linkedProductIds.length > 0) {
        await supabase.from('products')
          .update({ supplier_id: null })
          .eq('supplier_id', supplierId)
          .not('id', 'in', `(${d.linkedProductIds.join(',')})`);
      } else {
        await supabase.from('products')
          .update({ supplier_id: null })
          .eq('supplier_id', supplierId);
      }

      // 2. Set supplier_id for newly selected products
      if (d.linkedProductIds.length > 0) {
        await supabase.from('products')
          .update({ supplier_id: supplierId })
          .in('id', d.linkedProductIds);
      }

      await fetchProducts(businessId, userId);
      setShowForm(false);
      setEditF(null);
    }
  };

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <View style={styles.hdr}>
        <Pressable onPress={() => router.back()}><Text variant="body" color="secondary">‹ Retour</Text></Pressable>
        <Text variant="h4">Fournisseurs</Text>
        <Pressable onPress={() => { setEditF(null); setShowForm(true); }}>
          <Text variant="label" style={{ color: palette.primary }}>+ Ajouter</Text>
        </Pressable>
      </View>

      {/* Tabs */}
      <View style={styles.tabs}>
        {(['fournisseurs', 'commandes'] as const).map(t => (
          <Pressable key={t} onPress={() => setTab(t)} style={[styles.tab, tab === t && styles.tabActive]}>
            <Text variant="label" style={{ color: tab === t ? palette.textInverse : palette.textSecondary }}>
              {t === 'fournisseurs' ? 'Fournisseurs' : 'Commandes'}
            </Text>
          </Pressable>
        ))}
      </View>

      {tab === 'fournisseurs' ? (
        loading && fournisseurs.length === 0 ? (
          <Text variant="body" color="secondary" style={styles.center}>Chargement…</Text>
        ) : fournisseurs.length === 0 ? (
          <View style={styles.empty}><Text variant="body" color="secondary">Aucun fournisseur. Ajoutez-en un.</Text></View>
        ) : (
          <FlatList
            data={fournisseurs}
            keyExtractor={f => f.id}
            contentContainerStyle={styles.list}
            renderItem={({ item }) => {
              const linkedCount = products.filter(p => p.supplier_id === item.id).length;
              return (
                <Pressable
                  onLongPress={() => Alert.alert(item.name, '', [
                    { text: 'Modifier', onPress: () => { setEditF(item); setShowForm(true); } },
                    { text: 'Commander', onPress: () => { setCommandeTarget(item); setShowCommande(true); } },
                    { text: 'Supprimer', style: 'destructive', onPress: () => Alert.alert('Supprimer ?', '', [
                      { text: 'Annuler', style: 'cancel' },
                      { text: 'Supprimer', style: 'destructive', onPress: () => deleteFournisseur(item.id, businessId) },
                    ]) },
                    { text: 'Annuler', style: 'cancel' },
                  ])}
                  onPress={() => { setCommandeTarget(item); setShowCommande(true); }}
                  style={({ pressed }) => [styles.fRow, pressed && { opacity: 0.75 }]}>
                  <View style={styles.fIcon}>
                    <Text style={{ fontSize: 20 }}>🏭</Text>
                  </View>
                  <View style={{ flex: 1, gap: 2 }}>
                    <Text variant="label">{item.name}</Text>
                    <Text variant="caption" color="secondary">
                      {[item.phone, item.country].filter(Boolean).join(' · ') || 'Appuyez long pour options'}
                    </Text>
                    {linkedCount > 0 && (
                      <Text variant="caption" style={{ color: palette.primary }}>
                        {linkedCount} produit(s) lié(s)
                      </Text>
                    )}
                  </View>
                  <Text variant="caption" color="secondary">Commander ›</Text>
                </Pressable>
              );
            }}
            ItemSeparatorComponent={() => <View style={{ height: 1, backgroundColor: palette.border }} />}
          />
        )
      ) : (
        commandes.length === 0 ? (
          <View style={styles.empty}><Text variant="body" color="secondary">Aucune commande.</Text></View>
        ) : (
          <FlatList
            data={commandes}
            keyExtractor={c => c.id}
            contentContainerStyle={styles.list}
            renderItem={({ item }) => (
              <Pressable onPress={() => openCommandeDetail(item)}
                style={({ pressed }) => [styles.cRow, pressed && { opacity: 0.75 }]}>
                <View style={{ flex: 1, gap: 2 }}>
                  <Text variant="label">{item.supplier_name}</Text>
                  <Text variant="caption" color="secondary">
                    {new Date(item.ordered_at).toLocaleDateString('fr-FR')} · {fmt(item.total_cost, currency)}
                  </Text>
                </View>
                <View style={[styles.statusPill, { backgroundColor: STATUS_COLOR[item.status] + '20' }]}>
                  <Text variant="caption" style={{ color: STATUS_COLOR[item.status] }}>{STATUS_LABEL[item.status]}</Text>
                </View>
              </Pressable>
            )}
            ItemSeparatorComponent={() => <View style={{ height: 1, backgroundColor: palette.border }} />}
          />
        )
      )}

      <FournisseurForm
        visible={showForm}
        editing={editF}
        products={products}
        onClose={() => { setShowForm(false); setEditF(null); }}
        saving={saving}
        onSave={handleSaveFournisseur}
      />

      <CommandeForm
        visible={showCommande}
        fournisseur={commandeTarget}
        currency={currency}
        onClose={() => setShowCommande(false)}
        saving={saving}
        onSave={async (lines) => {
          if (!commandeTarget) return;
          const ok = await createCommande(businessId, userId, { supplierId: commandeTarget.id, lines });
          if (ok) { setShowCommande(false); setTab('commandes'); }
        }}
      />

      {detailCommande && (
        <CommandeDetail
          commande={detailCommande}
          currency={currency}
          onClose={() => setDetailCommande(null)}
          onRecevoir={handleRecevoir}
          saving={saving}
        />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: palette.background },
  hdr: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: spacing[5], borderBottomWidth: 1, borderBottomColor: palette.border },
  tabs: { flexDirection: 'row', padding: spacing[4], gap: spacing[2] },
  tab: { flex: 1, paddingVertical: spacing[2], alignItems: 'center', borderRadius: radius.md, borderWidth: 1, borderColor: palette.border },
  tabActive: { backgroundColor: palette.primary, borderColor: palette.primary },
  list: { paddingBottom: spacing[10] },
  fRow: { flexDirection: 'row', alignItems: 'center', gap: spacing[3], paddingHorizontal: spacing[5], paddingVertical: spacing[3], backgroundColor: palette.surface },
  fIcon: { width: 36, height: 36, borderRadius: 18, backgroundColor: palette.primaryLight, alignItems: 'center', justifyContent: 'center' },
  cRow: { flexDirection: 'row', alignItems: 'center', gap: spacing[3], paddingHorizontal: spacing[5], paddingVertical: spacing[3], backgroundColor: palette.surface },
  statusPill: { paddingHorizontal: spacing[2], paddingVertical: 2, borderRadius: radius.sm },
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  center: { textAlign: 'center', marginTop: spacing[10] },

  // Modals
  modalSafe: { flex: 1, backgroundColor: palette.background },
  mhdr: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: spacing[5], borderBottomWidth: 1, borderBottomColor: palette.border },
  mpad: { padding: spacing[5], gap: spacing[4], paddingBottom: spacing[10] },
  mfooter: { padding: spacing[5], borderTopWidth: 1, borderTopColor: palette.border },

  // Product binding chips
  productGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing[2] },
  productChip: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: spacing[3], paddingVertical: spacing[1.5],
    borderRadius: radius.full, borderWidth: 1, borderColor: palette.border, backgroundColor: palette.surface,
    maxWidth: 160,
  },
  productChipActive: { backgroundColor: palette.primary, borderColor: palette.primary },

  prodChip: {
    paddingHorizontal: spacing[3], paddingVertical: spacing[2], marginRight: spacing[2],
    borderRadius: radius.md, borderWidth: 1, borderColor: palette.border, backgroundColor: palette.surface, maxWidth: 140,
  },
  prodChipLinked: { borderColor: palette.primary, backgroundColor: palette.primaryLight },
  lineCard: { gap: spacing[2] },
  lineTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  lineInputs: { flexDirection: 'row', gap: spacing[3] },
  totalRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  dr: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
});
