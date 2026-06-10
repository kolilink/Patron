import { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Animated, Easing, FlatList, KeyboardAvoidingView, LayoutAnimation, Modal, Platform, Pressable, ScrollView, StyleSheet, TextInput, UIManager, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import { Button } from '@/src/components/ui/Button';
import { Card } from '@/src/components/ui/Card';
import { Input } from '@/src/components/ui/Input';
import { Text } from '@/src/components/ui/Text';
import { PhoneInput } from '@/src/components/ui/PhoneInput';
import { DatePickerField } from '@/src/components/ui/DatePickerField';
import { palette, spacing, radius } from '@/src/theme';
import { useAuthStore } from '@/stores/auth';
import { useProductStore } from '@/stores/products';
import { useFournisseursStore, type CommandeAchat, type Fournisseur } from '@/stores/fournisseurs';
import { translateError } from '@/lib/errors';
import { generateId } from '@/lib/id';
import { supabase } from '@/lib/supabase';
import type { Product } from '@/src/types';

function fmt(n: number, cur: string) { return `${Math.round(n).toLocaleString('fr-FR')} ${cur}`; }
function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const AVATAR_PALETTE = [
  { bg: '#EEF2FF', text: '#4F46E5' },
  { bg: '#FDF4FF', text: '#86198F' },
  { bg: '#FFFBEB', text: '#92400E' },
  { bg: '#ECFDF5', text: '#065F46' },
  { bg: '#EFF6FF', text: '#1D4ED8' },
  { bg: '#F5F3FF', text: '#6D28D9' },
  { bg: '#FEF2F2', text: '#991B1B' },
  { bg: '#ECFEFF', text: '#0E7490' },
];

function relativeTime(dateStr: string): string {
  const days = Math.floor((Date.now() - new Date(dateStr).getTime()) / 86_400_000);
  if (days === 0) return "aujourd'hui";
  if (days === 1) return 'hier';
  if (days < 7) return `il y a ${days} jours`;
  if (days < 14) return 'la semaine dernière';
  if (days < 60) return `il y a ${Math.floor(days / 7)} semaines`;
  return new Date(dateStr).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long' });
}

const STATUS_LABEL: Record<string, string> = {
  brouillon: 'Non confirmé', envoye: 'Envoyé', recu_partiel: 'Partiel', recu: 'Reçu', annule: 'Annulé',
};
const STATUS_COLOR: Record<string, string> = {
  brouillon: palette.textSecondary, envoye: palette.primary,
  recu_partiel: palette.warning, recu: palette.success, annule: palette.danger,
};

interface FournisseurFormData {
  name: string; phone: string; country: string; notes: string; leadDays: string;
  linkedProductIds: string[];
  newProducts: { name: string; unit: string }[];
}

// ─── Fournisseur Form ──────────────────────────────────────────────────────────

function FournisseurForm({ visible, editing, products, onClose, onSave, saving }: {
  visible: boolean; editing: Fournisseur | null; products: Product[];
  onClose: () => void; onSave: (d: FournisseurFormData) => Promise<void>; saving: boolean;
}) {
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [linkedIds, setLinkedIds] = useState<Set<string>>(new Set());
  const [localProducts, setLocalProducts] = useState<{ id: string; name: string }[]>([]);
  const [showCreate, setShowCreate] = useState(false);
  const [newProductName, setNewProductName] = useState('');
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const pulseAnim = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    if (Platform.OS === 'android') UIManager.setLayoutAnimationEnabledExperimental?.(true);
  }, []);

  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.delay(3000),
        Animated.timing(pulseAnim, { toValue: 1.08, duration: 300, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
        Animated.timing(pulseAnim, { toValue: 1.0,  duration: 300, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
      ])
    );
    if (visible) { pulseAnim.setValue(1); loop.start(); }
    return () => loop.stop();
  }, [visible]);

  useEffect(() => {
    if (visible) {
      setName(editing?.name ?? '');
      setPhone(editing?.phone ?? '');
      setLocalProducts([]);
      setShowCreate(false);
      setNewProductName('');
      setDropdownOpen(false);
      setLinkedIds(
        new Set(editing ? products.filter(p => p.supplier_id === editing.id).map(p => p.id) : []),
      );
    }
  }, [visible, editing, products]);

  const toggleProduct = (id: string) =>
    setLinkedIds(prev => { const s = new Set(prev); s.has(id) ? s.delete(id) : s.add(id); return s; });

  const handleToggleCreate = () => {
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    if (showCreate) setNewProductName('');
    setShowCreate(prev => !prev);
  };

  const confirmNew = () => {
    const trimmed = newProductName.trim();
    if (!trimmed) return;
    const tempId = `temp_${Date.now()}`;
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    setLocalProducts(prev => [...prev, { id: tempId, name: trimmed }]);
    setLinkedIds(prev => new Set([...prev, tempId]));
    setNewProductName('');
    setShowCreate(false);
  };

  const allProducts = [...products, ...localProducts];

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <SafeAreaView style={styles.modalSafe} edges={['bottom']}>
        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1 }}
          keyboardVerticalOffset={Platform.OS === 'ios' ? 44 : 0}>
          <View style={styles.mhdr}>
            <Pressable onPress={onClose}><Text variant="body" color="secondary">Annuler</Text></Pressable>
            <Text variant="h4">{editing ? 'Modifier fournisseur' : 'Nouveau fournisseur'}</Text>
            <View style={{ width: 60 }} />
          </View>

          <ScrollView contentContainerStyle={styles.mpad} keyboardShouldPersistTaps="handled">
            <Input label="Nom du fournisseur" value={name} onChangeText={setName} placeholder="Ex: Diallo Import" />
            <PhoneInput label="Téléphone" onChange={(e164) => setPhone(e164)} strict={false} />

            <View style={{ gap: spacing[2] }}>
              <Text variant="label">Produits fournis</Text>

              {/* Selector row */}
              <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', width: '100%', gap: 10 }}>
                {/* Dropdown trigger — flex: 1 */}
                <Pressable
                  onPress={() => {
                    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
                    if (showCreate) { setShowCreate(false); setNewProductName(''); }
                    setDropdownOpen(prev => !prev);
                  }}
                  style={styles.dropdownTrigger}>
                  <Text variant="body" numberOfLines={1} style={{ flex: 1, color: linkedIds.size > 0 ? palette.textPrimary : palette.textDisabled }}>
                    {linkedIds.size === 0
                      ? 'Sélectionner des produits'
                      : linkedIds.size === 1
                        ? allProducts.find(p => linkedIds.has(p.id))?.name ?? '1 produit'
                        : `${linkedIds.size} produits liés`}
                  </Text>
                  <Ionicons name={dropdownOpen ? 'chevron-up' : 'chevron-down'} size={16} color={palette.textSecondary} />
                </Pressable>

                {/* Pulsing circular + badge — right side, never moves */}
                <Pressable
                  onPress={() => {
                    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
                    if (dropdownOpen) setDropdownOpen(false);
                    setShowCreate(prev => !prev);
                    if (showCreate) setNewProductName('');
                  }}>
                  <Animated.View style={[styles.addBadge, showCreate && styles.addBadgeActive, { transform: [{ scale: pulseAnim }] }]}>
                    <Text style={[styles.addBadgePlus, showCreate && { color: '#fff' }]}>+</Text>
                  </Animated.View>
                </Pressable>
              </View>

              {/* Dropdown list — slides in below the row */}
              {dropdownOpen && (
                <ScrollView style={styles.prodDropdown} nestedScrollEnabled keyboardShouldPersistTaps="handled">
                  {allProducts.length === 0 ? (
                    <View style={{ padding: spacing[3] }}>
                      <Text variant="caption" color="secondary">Utilisez + pour créer votre premier produit.</Text>
                    </View>
                  ) : allProducts.map(p => {
                    const selected = linkedIds.has(p.id);
                    return (
                      <Pressable
                        key={p.id}
                        onPress={() => {
                          toggleProduct(p.id);
                          LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
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

              {/* Slide-in create row — anchored below the + button */}
              {showCreate && (
                <View style={styles.newProdRow}>
                  <TextInput
                    style={styles.newProdInput}
                    value={newProductName}
                    onChangeText={setNewProductName}
                    placeholder="Nom du nouveau produit…"
                    placeholderTextColor={palette.textDisabled}
                    autoFocus
                    returnKeyType="done"
                    onSubmitEditing={confirmNew}
                  />
                  <Pressable onPress={confirmNew} style={styles.confirmBtn}>
                    <Ionicons name="checkmark" size={20}
                      color={newProductName.trim() ? palette.success : palette.textDisabled} />
                  </Pressable>
                </View>
              )}
            </View>
          </ScrollView>

          <View style={styles.mfooter}>
            <Button
              label={saving ? '…' : 'Enregistrer'}
              loading={saving} fullWidth size="lg"
              onPress={() => {
                if (!name.trim()) { Alert.alert('Ajoutez un nom :)'); return; }

                // Auto-commit any product name typed but not yet confirmed with the checkmark
                let finalLocalProducts = localProducts;
                let finalLinkedIds = linkedIds;
                if (showCreate && newProductName.trim()) {
                  const trimmed = newProductName.trim();
                  const tempId = `temp_${Date.now()}`;
                  finalLocalProducts = [...localProducts, { id: tempId, name: trimmed }];
                  finalLinkedIds = new Set([...linkedIds, tempId]);
                }

                const existingIds = [...finalLinkedIds].filter(id => !id.startsWith('temp_'));
                const newProds = finalLocalProducts.filter(p => finalLinkedIds.has(p.id));
                onSave({
                  name, phone,
                  country: editing?.country ?? '',
                  notes: editing?.notes ?? '',
                  leadDays: editing?.lead_days != null ? String(editing.lead_days) : '',
                  linkedProductIds: existingIds,
                  newProducts: newProds.map(p => ({ name: p.name, unit: 'pcs' })),
                });
              }}
            />
          </View>
        </KeyboardAvoidingView>
      </SafeAreaView>
    </Modal>
  );
}

// ─── Success Sheet ─────────────────────────────────────────────────────────────

function SuccessSheet({ visible, fournisseur, onCommander, onDette, onDismiss }: {
  visible: boolean; fournisseur: Fournisseur | null;
  onCommander: () => void; onDette: () => void; onDismiss: () => void;
}) {
  return (
    <Modal visible={visible} animationType="slide" presentationStyle="formSheet" onRequestClose={onDismiss}>
      <SafeAreaView style={[styles.modalSafe, styles.successSheetSafe]} edges={['bottom']}>

        {/* Top-third — badge + confirmation copy */}
        <View style={styles.successTop}>
          <View style={styles.successBadge}>
            <Ionicons name="checkmark" size={32} color={palette.success} />
          </View>
          <Text variant="h4" style={{ textAlign: 'center', marginBottom: 4 }}>
            {fournisseur?.name} ajouté
          </Text>
          <Text variant="caption" color="secondary" style={{ textAlign: 'center' }}>
            Que souhaitez-vous faire maintenant ?
          </Text>
        </View>

        {/* Lower — actions separated from the read zone */}
        <View style={styles.successActions}>
          <Button label="Passer une commande" onPress={onCommander} fullWidth size="lg"
            style={{ marginBottom: spacing[3] }} />
          <Pressable onPress={onDette} style={styles.outlineBtn}>
            <Text variant="label" style={{ color: palette.primary }}>Enregistrer une dette fournisseur</Text>
          </Pressable>
          <Pressable onPress={onDismiss} style={{ paddingVertical: spacing[3], alignItems: 'center' }}>
            <Text variant="body" color="secondary">Retour</Text>
          </Pressable>
        </View>

      </SafeAreaView>
    </Modal>
  );
}

// ─── Debt Modal ────────────────────────────────────────────────────────────────

function DebtModal({ visible, fournisseur, currency, saving, onClose, onSave }: {
  visible: boolean; fournisseur: Fournisseur | null; currency: string; saving: boolean;
  onClose: () => void; onSave: (amount: number, description: string, date: string) => Promise<void>;
}) {
  const [amount, setAmount] = useState('');
  const [description, setDescription] = useState('');
  const [date, setDate] = useState(todayISO());

  useEffect(() => {
    if (visible) { setAmount(''); setDescription(''); setDate(todayISO()); }
  }, [visible]);

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="formSheet" onRequestClose={onClose}>
      <SafeAreaView style={styles.modalSafe} edges={['bottom']}>
        <View style={styles.mhdr}>
          <Pressable onPress={onClose}><Text variant="body" color="secondary">Annuler</Text></Pressable>
          <Text variant="h4">Dette fournisseur</Text>
          <View style={{ width: 60 }} />
        </View>
        <ScrollView contentContainerStyle={styles.mpad} keyboardShouldPersistTaps="handled">
          {fournisseur && (
            <Card style={[styles.debtCtx, { borderLeftWidth: 3, borderLeftColor: palette.danger }]}>
              <Text variant="caption" color="secondary">Vous devez à</Text>
              <Text variant="label">{fournisseur.name}</Text>
            </Card>
          )}
          <Input label={`Montant (${currency})`} value={amount} onChangeText={setAmount}
            keyboardType="decimal-pad" placeholder="0" />
          <Input label="Description (optionnel)" value={description} onChangeText={setDescription}
            placeholder="Ex: 50 sacs de riz, livraison du 5 juin…" />
          <DatePickerField label="Date" value={date} onChange={setDate} maxToday />
        </ScrollView>
        <View style={styles.mfooter}>
          <Button
            label={saving ? '…' : 'Enregistrer la dette'}
            loading={saving} fullWidth size="lg"
            onPress={() => {
              const amt = parseFloat(amount.replace(/\s/g, ''));
              if (isNaN(amt) || amt <= 0) { Alert.alert('Vérifiez le montant :)'); return; }
              onSave(amt, description.trim(), date);
            }}
          />
        </View>
      </SafeAreaView>
    </Modal>
  );
}

// ─── Commande Form ────────────────────────────────────────────────────────────

function CommandeForm({ visible, fournisseur, currency, onClose, onSave, saving }: {
  visible: boolean; fournisseur: Fournisseur | null; currency: string;
  onClose: () => void;
  onSave: (lines: { product_id: string; product_name: string; qty: number; unit_cost: number }[]) => Promise<void>;
  saving: boolean;
}) {
  const { products } = useProductStore();
  const [lines, setLines] = useState<{ product_id: string; product_name: string; qty: string; unit_cost: string }[]>([]);
  const [showPicker, setShowPicker] = useState(false);
  const seededForRef = useRef<string | null>(null);

  useEffect(() => {
    if (!visible) {
      seededForRef.current = null;
      return;
    }
    const fId = fournisseur?.id ?? null;
    // Seed when the modal first opens for a given supplier, or when products update before the user
    // has touched any line (lines.length check avoids wiping edits on incidental store ticks)
    if (seededForRef.current === fId && lines.length > 0) return;
    seededForRef.current = fId;
    setShowPicker(false);
    const linked = fId
      ? products.filter(p => p.supplier_id === fId && !p.archived)
      : [];
    setLines(linked.map(p => ({ product_id: p.id, product_name: p.name, qty: '1', unit_cost: String(p.cost_price) })));
  }, [visible, products, fournisseur?.id]);

  const addLine = (p: Product) =>
    setLines(prev => [...prev, { product_id: p.id, product_name: p.name, qty: '1', unit_cost: String(p.cost_price) }]);

  const total = lines.reduce((s, l) => s + (parseInt(l.qty) || 0) * (parseFloat(l.unit_cost) || 0), 0);

  // Picker only shows products not already in lines, supplier-linked ones first
  const lineIds = new Set(lines.map(l => l.product_id));
  const pickerProducts = [...products]
    .filter(p => !lineIds.has(p.id) && !p.archived)
    .sort((a, b) => (a.supplier_id === fournisseur?.id ? -1 : 0) - (b.supplier_id === fournisseur?.id ? -1 : 0));

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <SafeAreaView style={styles.modalSafe} edges={['bottom']}>
        <View style={styles.mhdr}>
          <Pressable onPress={onClose}><Text variant="body" color="secondary">Annuler</Text></Pressable>
          <Text variant="h4">Nouvelle commande</Text>
          <View style={{ width: 60 }} />
        </View>
        <ScrollView contentContainerStyle={styles.mpad} keyboardShouldPersistTaps="handled">
          {fournisseur && <Text variant="label" color="secondary">{fournisseur.name}</Text>}

          {/* Picker: shown when empty or user opens it to add more */}
          {(lines.length === 0 || showPicker) && (
            <>
              <Text variant="label">
                {lines.length === 0 ? 'Produits à commander' : 'Ajouter depuis le catalogue'}
              </Text>
              {pickerProducts.length > 0 ? (
                <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ flexGrow: 0 }}>
                  {pickerProducts.map(p => (
                    <Pressable key={p.id} onPress={() => { addLine(p); setShowPicker(false); }}
                      style={[styles.prodChip, p.supplier_id === fournisseur?.id && styles.prodChipLinked]}>
                      <Text variant="caption" numberOfLines={1}
                        style={{ color: p.supplier_id === fournisseur?.id ? palette.primary : palette.textPrimary }}>
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
              <Text variant="label" style={{ color: palette.primary, marginLeft: 6 }}>
                Ajouter un autre produit
              </Text>
            </Pressable>
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
              if (invalid) { Alert.alert(`Un petit contrôle sur la quantité et le coût :)`, `"${invalid.product_name}"`); return; }
              onSave(parsed);
            }} />
        </View>
      </SafeAreaView>
    </Modal>
  );
}

// ─── Commande Detail ──────────────────────────────────────────────────────────

function CommandeDetail({ commande, currency, onClose, onRecevoir, saving }: {
  commande: CommandeAchat; currency: string;
  onClose: () => void; onRecevoir: () => void; saving: boolean;
}) {
  return (
    <Modal visible animationType="slide" presentationStyle="formSheet" onRequestClose={onClose}>
      <SafeAreaView style={styles.modalSafe} edges={['bottom']}>
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
          {commande.lines?.map(l => (
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
    fournisseurs, commandes, debts, loading, saving, error, offline,
    fetchFournisseurs, updateFournisseur, deleteFournisseur,
    fetchCommandes, createCommande, loadCommandeLines, recevoirCommande,
    fetchDebts, createDebt,
  } = useFournisseursStore();

  const [isSaving, setIsSaving] = useState(false);
  const [tab, setTab] = useState<'fournisseurs' | 'commandes'>('fournisseurs');
  const [showForm, setShowForm] = useState(false);
  const [editF, setEditF] = useState<Fournisseur | null>(null);
  const [showCommande, setShowCommande] = useState(false);
  const [commandeTarget, setCommandeTarget] = useState<Fournisseur | null>(null);
  const [detailCommande, setDetailCommande] = useState<CommandeAchat | null>(null);
  const [showSuccessSheet, setShowSuccessSheet] = useState(false);
  const [createdFournisseur, setCreatedFournisseur] = useState<Fournisseur | null>(null);
  const [showDebtModal, setShowDebtModal] = useState(false);
  const [debtTarget, setDebtTarget] = useState<Fournisseur | null>(null);

  useEffect(() => {
    if (!businessId) return;
    fetchFournisseurs(businessId);
    fetchCommandes(businessId);
    fetchProducts(businessId, userId);
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

  const reorderMap = useMemo(() => {
    const map: Record<string, number> = {};
    for (const p of products) {
      if (!p.supplier_id) continue;
      if (p.stock_qty === 0 || (p.reorder_level > 0 && p.stock_qty <= p.reorder_level)) {
        map[p.supplier_id] = (map[p.supplier_id] ?? 0) + 1;
      }
    }
    return map;
  }, [products]);

  const lastOrderMap = useMemo(() => {
    const map: Record<string, string> = {};
    for (const c of commandes) {
      if (!map[c.supplier_id] || c.ordered_at > map[c.supplier_id]) {
        map[c.supplier_id] = c.ordered_at;
      }
    }
    return map;
  }, [commandes]);

  const totalDebtsCount = useMemo(() => Object.keys(supplierDebtMap).length, [supplierDebtMap]);

  const openCommande = (f: Fournisseur) => {
    setCommandeTarget(f);
    setShowCommande(true);
    setShowSuccessSheet(false);
  };
  const openDebt = (f: Fournisseur) => {
    setDebtTarget(f); setShowDebtModal(true); setShowSuccessSheet(false);
  };

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
      Alert.alert('La commande n\'est pas passée :)');
    }
  };

  const handleSaveFournisseur = async (d: FournisseurFormData) => {
    if (isSaving) return;
    setIsSaving(true);

    const isEdit = !!editF;
    const leadDaysNum = parseInt(d.leadDays) || null;

    // Client-side UUID eliminates fragile post-create name lookup (same pattern as business creation)
    const supplierId: string = editF?.id ?? generateId();

    try {
      if (isEdit) {
        const ok = await updateFournisseur(supplierId, {
          name: d.name, phone: d.phone, country: d.country, notes: d.notes, lead_days: leadDaysNum,
        });
        if (!ok) return;
      } else {
        const { error: sErr } = await supabase.from('suppliers').insert({
          id: supplierId,
          business_id: businessId,
          name: d.name.trim(),
          phone: d.phone?.trim() || null,
          country: d.country?.trim() || null,
          notes: d.notes?.trim() || null,
          lead_days: leadDaysNum,
          created_by: userId,
        });
        if (sErr) {
          Alert.alert('Erreur', translateError(sErr, 'Impossible de créer le fournisseur'));
          return;
        }
        await fetchFournisseurs(businessId);
      }

      // Insert inline-created products with supplier_id baked into the INSERT row
      const newProductIds: string[] = [];
      for (const np of d.newProducts) {
        const newId = generateId();
        const { error: pErr } = await supabase.from('products').insert({
          id: newId,
          business_id: businessId,
          name: np.name,
          unit: np.unit,
          cost_price: 0,
          sale_price: 0,
          stock_qty: 0,
          reorder_level: 0,
          archived: false,
          created_by: userId,
          supplier_id: supplierId,
        });
        if (pErr) {
          Alert.alert('Produit non enregistré', `"${np.name}" : ${translateError(pErr, pErr.message)}`);
        } else {
          newProductIds.push(newId);
        }
      }

      // When editing: explicitly unlink products that were deselected (fetch current → diff → unlink)
      // When creating: nothing to unlink — the inserted products already carry supplier_id
      if (isEdit) {
        const { data: currentLinked } = await supabase
          .from('products').select('id').eq('supplier_id', supplierId);
        const keepIds = new Set([...d.linkedProductIds, ...newProductIds]);
        const toUnlink = (currentLinked ?? []).map(r => r.id as string).filter(id => !keepIds.has(id));
        if (toUnlink.length > 0) {
          await supabase.from('products').update({ supplier_id: null }).in('id', toUnlink);
        }
      }

      // Link any existing products selected from the dropdown
      if (d.linkedProductIds.length > 0) {
        await supabase.from('products').update({ supplier_id: supplierId }).in('id', d.linkedProductIds);
      }

      await fetchProducts(businessId, userId);
      setShowForm(false);
      setEditF(null);

      if (!isEdit) {
        const f = useFournisseursStore.getState().fournisseurs.find(x => x.id === supplierId);
        if (f) { setCreatedFournisseur(f); setShowSuccessSheet(true); }
      }
    } finally {
      setIsSaving(false);
    }
  };

  const fabScale   = useRef(new Animated.Value(1)).current;
  const fabOpacity = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    const easing = Easing.inOut(Easing.sin);
    const loop = Animated.loop(
      Animated.sequence([
        Animated.parallel([
          Animated.timing(fabScale,   { toValue: 1.06, duration: 2000, easing, useNativeDriver: true }),
          Animated.timing(fabOpacity, { toValue: 0.85, duration: 2000, easing, useNativeDriver: true }),
        ]),
        Animated.parallel([
          Animated.timing(fabScale,   { toValue: 1,    duration: 2000, easing, useNativeDriver: true }),
          Animated.timing(fabOpacity, { toValue: 1,    duration: 2000, easing, useNativeDriver: true }),
        ]),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, []);

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <View style={styles.hdr}>
        <Pressable onPress={() => router.back()}><Text variant="body" color="secondary">‹ Retour</Text></Pressable>
        <Text variant="h4">Fournisseurs</Text>
        <View style={{ width: 60 }} />
      </View>

      {offline && (
        <View style={styles.offlineBanner}>
          <Text variant="caption" color="secondary">Pas de réseau · Informations non actualisées</Text>
        </View>
      )}

      {tab === 'fournisseurs' && fournisseurs.length > 0 && (
        <View style={styles.summaryBar}>
          <Text variant="caption" color="secondary">
            {fournisseurs.length} partenaire{fournisseurs.length > 1 ? 's' : ''}
            {totalDebtsCount > 0 ? `  ·  ${totalDebtsCount} avec une dette en cours` : ''}
          </Text>
        </View>
      )}

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
        ) : !loading && fournisseurs.length === 0 && error ? (
          <View style={styles.empty}><Text variant="body" color="secondary" style={{ textAlign: 'center' }}>Données non disponibles hors ligne</Text></View>
        ) : fournisseurs.length === 0 ? (
          <View style={styles.empty}>
            <View style={styles.emptyIconWrap}>
              <Ionicons name="storefront-outline" size={40} color={palette.primary} />
            </View>
            <Text variant="h4" style={{ textAlign: 'center', marginBottom: spacing[2] }}>Vos partenaires</Text>
            <Text variant="body" color="secondary" style={{ textAlign: 'center', lineHeight: 22, paddingHorizontal: spacing[6] }}>
              Ajoutez vos fournisseurs pour suivre commandes, dettes et réapprovisionnements en un seul endroit.
            </Text>
          </View>
        ) : (
          <FlatList
            data={fournisseurs}
            keyExtractor={f => f.id}
            contentContainerStyle={styles.list}
            renderItem={({ item }) => {
              const ac = AVATAR_PALETTE[item.name.charCodeAt(0) % AVATAR_PALETTE.length];
              const initials = item.name.split(/\s+/).slice(0, 2).map((w: string) => w[0]?.toUpperCase() ?? '').join('');
              const owedAmount = supplierDebtMap[item.id] ?? 0;
              const reorderCount = reorderMap[item.id] ?? 0;
              const lastOrder = lastOrderMap[item.id];
              return (
                <Pressable
                  onLongPress={() => Alert.alert(item.name, '', [
                    { text: 'Modifier', onPress: () => { setEditF(item); setShowForm(true); } },
                    { text: 'Enregistrer une dette', onPress: () => openDebt(item) },
                    { text: 'Supprimer', style: 'destructive', onPress: () =>
                      Alert.alert('Supprimer ?', 'Les produits liés seront dissociés.', [
                        { text: 'Annuler', style: 'cancel' },
                        { text: 'Supprimer', style: 'destructive', onPress: async () => {
                          const ok = await deleteFournisseur(item.id, businessId);
                          if (!ok) Alert.alert('Ce fournisseur a des commandes enregistrées — retirez-les d\'abord :)');
                        }},
                      ])
                    },
                    { text: 'Annuler', style: 'cancel' },
                  ])}
                  onPress={() => router.push(`/fournisseurs/${item.id}`)}
                  style={({ pressed }) => [styles.fRow, pressed && { opacity: 0.7 }]}>

                  {/* Avatar + reorder badge */}
                  <View>
                    <View style={[styles.fAvatar, { backgroundColor: ac.bg }]}>
                      <Text style={[styles.fInitials, { color: ac.text }]}>{initials}</Text>
                    </View>
                    {reorderCount > 0 && (
                      <View style={styles.reorderBadge}>
                        <Text style={styles.reorderBadgeText}>{reorderCount}</Text>
                      </View>
                    )}
                  </View>

                  <View style={{ flex: 1, gap: 3 }}>
                    <Text variant="label" numberOfLines={1}>{item.name}</Text>
                    {item.phone
                      ? <Text variant="caption" color="secondary" numberOfLines={1}>{item.phone}</Text>
                      : null}
                    {lastOrder
                      ? <Text variant="caption" color="secondary">Commande {relativeTime(lastOrder)}</Text>
                      : null}
                    {owedAmount > 0 && (
                      <View style={styles.debtPill}>
                        <Ionicons name="time-outline" size={11} color="#92400E" />
                        <Text style={styles.debtPillText}>Doit {fmt(owedAmount, currency)}</Text>
                      </View>
                    )}
                  </View>

                  <Ionicons name="chevron-forward" size={16} color={palette.textDisabled} />
                </Pressable>
              );
            }}
          />
        )
      ) : (
        loading && commandes.length === 0 ? (
          <Text variant="body" color="secondary" style={styles.center}>Chargement…</Text>
        ) : commandes.length === 0 ? (
          <View style={styles.empty}><Text variant="body" color="secondary">Pas encore de commande fournisseur.</Text></View>
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
        visible={showForm} editing={editF} products={products}
        onClose={() => { setShowForm(false); setEditF(null); }}
        saving={isSaving} onSave={handleSaveFournisseur}
      />

      <SuccessSheet
        visible={showSuccessSheet} fournisseur={createdFournisseur}
        onCommander={() => createdFournisseur && openCommande(createdFournisseur)}
        onDette={() => createdFournisseur && openDebt(createdFournisseur)}
        onDismiss={() => { setShowSuccessSheet(false); setCreatedFournisseur(null); }}
      />

      <DebtModal
        visible={showDebtModal} fournisseur={debtTarget} currency={currency} saving={saving}
        onClose={() => { setShowDebtModal(false); setDebtTarget(null); }}
        onSave={async (amount, description, date) => {
          if (!debtTarget) return;
          const ok = await createDebt(businessId, userId, { supplierId: debtTarget.id, amount, description, date });
          if (ok) { setShowDebtModal(false); setDebtTarget(null); }
        }}
      />

      <CommandeForm
        visible={showCommande} fournisseur={commandeTarget} currency={currency}
        onClose={() => setShowCommande(false)} saving={saving}
        onSave={async (lines) => {
          if (!commandeTarget) return;
          const ok = await createCommande(businessId, userId, { supplierId: commandeTarget.id, lines });
          if (ok) { setShowCommande(false); setTab('commandes'); }
        }}
      />

      {detailCommande && (
        <CommandeDetail commande={detailCommande} currency={currency}
          onClose={() => setDetailCommande(null)} onRecevoir={handleRecevoir} saving={saving} />
      )}

      {tab === 'fournisseurs' && (
        <Animated.View style={[styles.fabContainer, { opacity: fabOpacity, transform: [{ scale: fabScale }] }]}>
          <Pressable
            onPress={() => { setEditF(null); setShowForm(true); }}
            style={({ pressed }) => [styles.fab, pressed && { opacity: 0.82 }]}
            accessibilityLabel="Ajouter un fournisseur"
            accessibilityRole="button"
          >
            <Text style={styles.fabIcon}>+</Text>
          </Pressable>
        </Animated.View>
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
  list: { paddingTop: spacing[2], paddingBottom: spacing[10] },
  fRow: {
    flexDirection: 'row', alignItems: 'center', gap: spacing[3],
    marginHorizontal: spacing[4], marginTop: spacing[3],
    paddingHorizontal: spacing[4], paddingVertical: spacing[4],
    backgroundColor: palette.surface,
    borderRadius: 16,
    borderWidth: StyleSheet.hairlineWidth, borderColor: palette.border,
    shadowColor: '#000', shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.06, shadowRadius: 8, elevation: 3,
  },
  fAvatar: { width: 46, height: 46, borderRadius: 23, alignItems: 'center', justifyContent: 'center' },
  fInitials: { fontSize: 17, fontWeight: '700' as const },
  reorderBadge: {
    position: 'absolute', top: -4, right: -4,
    width: 18, height: 18, borderRadius: 9,
    backgroundColor: palette.danger,
    alignItems: 'center', justifyContent: 'center',
    borderWidth: 2, borderColor: palette.background,
  },
  reorderBadgeText: { fontSize: 10, fontWeight: '700' as const, color: '#fff' },
  debtPill: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    alignSelf: 'flex-start',
    paddingHorizontal: 8, paddingVertical: 3,
    borderRadius: 20, backgroundColor: '#FEF3C7',
  },
  debtPillText: { fontSize: 12, fontWeight: '600' as const, color: '#92400E' },
  summaryBar: {
    paddingHorizontal: spacing[5], paddingTop: spacing[3], paddingBottom: spacing[1],
  },
  emptyIconWrap: {
    width: 72, height: 72, borderRadius: 36, backgroundColor: '#EEF2FF',
    alignItems: 'center', justifyContent: 'center', marginBottom: spacing[4],
  },
  cRow: { flexDirection: 'row', alignItems: 'center', gap: spacing[3], paddingHorizontal: spacing[5], paddingVertical: spacing[3], backgroundColor: palette.surface },
  statusPill: { paddingHorizontal: spacing[2], paddingVertical: 2, borderRadius: radius.sm },
  offlineBanner: { alignItems: 'center', justifyContent: 'center', paddingVertical: spacing[1], borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: palette.border },
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: spacing[4] },
  center: { textAlign: 'center', marginTop: spacing[10] },

  // Modals shared
  modalSafe: { flex: 1, backgroundColor: palette.background },
  mhdr: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: spacing[5], borderBottomWidth: 1, borderBottomColor: palette.border },
  mpad: { padding: spacing[5], gap: spacing[4], paddingBottom: spacing[10] },
  mfooter: { padding: spacing[5], borderTopWidth: 1, borderTopColor: palette.border },

  // Form — product selector
  dropdownTrigger: {
    flex: 1, flexDirection: 'row', alignItems: 'center', gap: spacing[2],
    paddingHorizontal: spacing[3], paddingVertical: spacing[2.5],
    borderRadius: radius.md, borderWidth: 1, borderColor: palette.border,
    backgroundColor: palette.surface,
  },
  prodDropdown: {
    maxHeight: 150,
    borderWidth: 1, borderColor: palette.border, borderRadius: radius.md,
    backgroundColor: palette.surface,
  },
  prodDropdownItem: {
    flexDirection: 'row', alignItems: 'center', gap: spacing[2],
    paddingHorizontal: spacing[3], paddingVertical: spacing[3],
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: palette.border,
  },
  // FAB — main screen (mirrors catalogue.tsx)
  fabContainer: { position: 'absolute', bottom: 194, right: spacing[4], zIndex: 10 },
  fab: {
    width: 56, height: 56, borderRadius: radius.full, backgroundColor: palette.primary,
    alignItems: 'center', justifyContent: 'center',
    shadowColor: '#000', shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.18, shadowRadius: 8, elevation: 8,
  },
  fabIcon: { fontSize: 28, lineHeight: 32, fontWeight: '300' as const, color: palette.textInverse, marginTop: -2 },

  // Circular pulsing badge — inside the form product row
  addBadge: { width: 44, height: 44, borderRadius: 22, backgroundColor: '#E0E7FF', justifyContent: 'center', alignItems: 'center' },
  addBadgeActive: { backgroundColor: palette.primary },
  addBadgePlus: { fontSize: 24, color: palette.primary, lineHeight: 28, fontWeight: '300' as const },

  newProdRow: {
    flexDirection: 'row', alignItems: 'center', gap: spacing[2],
    borderWidth: 1, borderColor: palette.border, borderRadius: radius.md,
    paddingHorizontal: spacing[3], paddingVertical: spacing[2],
    backgroundColor: palette.surface,
  },
  newProdInput: { flex: 1, fontSize: 15, color: palette.textPrimary, padding: 0 },
  confirmBtn: { padding: spacing[1] },

  // Success sheet
  successSheetSafe: { flex: 1 },
  successTop: { alignItems: 'center', paddingTop: '15%' as unknown as number, paddingHorizontal: spacing[6] },
  successBadge: { width: 64, height: 64, borderRadius: 32, backgroundColor: '#DCFCE7', alignItems: 'center', justifyContent: 'center', marginBottom: spacing[4] },
  successActions: { marginTop: 'auto' as unknown as number, width: '100%', paddingHorizontal: spacing[6], paddingBottom: spacing[8] },
  outlineBtn: { width: '100%', borderWidth: 1, borderColor: palette.primary, borderRadius: radius.md, paddingVertical: 14, alignItems: 'center', marginBottom: spacing[2] },

  // Commande form — add-more row
  addMoreBtn: { flexDirection: 'row', alignItems: 'center', paddingVertical: spacing[3], paddingHorizontal: spacing[1] },

  // Debt modal
  debtCtx: { gap: spacing[1] },

  // Commande form
  prodChip: { paddingHorizontal: spacing[3], paddingVertical: spacing[2], marginRight: spacing[2], borderRadius: radius.md, borderWidth: 1, borderColor: palette.border, backgroundColor: palette.surface, maxWidth: 140 },
  prodChipLinked: { borderColor: palette.primary, backgroundColor: palette.primaryLight },
  lineCard: { gap: spacing[2] },
  lineTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  lineInputs: { flexDirection: 'row', gap: spacing[3] },
  totalRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  dr: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
});
