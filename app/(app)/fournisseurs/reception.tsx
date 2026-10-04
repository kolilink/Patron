import { useEffect, useMemo, useRef, useState } from 'react';
import { Modal, Platform, Pressable, ScrollView, StyleSheet, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router, useLocalSearchParams } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { Screen } from '@/src/components/ui/Screen';
import { Button } from '@/src/components/ui/Button';
import { Text } from '@/src/components/ui/Text';
import { useTheme, spacing, radius, fontFamily, SUPPLIER_AVATAR_PALETTE } from '@/src/theme';
import type { Palette } from '@/src/theme';
import type { Product } from '@/src/types';
import { useAuthStore } from '@/stores/auth';
import { useProductStore } from '@/stores/products';
import { OfflineNotice } from '@/src/components/ui/OfflineNotice';
import { useFournisseursStore, type Fournisseur, type ReceptionLine } from '@/stores/fournisseurs';
import { getKV, setKV } from '@/lib/db';
import { haptics } from '@/lib/haptics';
import { toast } from '@/stores/toast';
import { trackEvent } from '@/lib/analytics';
import { formatAmountInput, parseAmountInput } from '@/src/utils/format';
import { DatePickerField } from '@/src/components/ui/DatePickerField';

// ── "Nouvelle livraison" — replaces the old "commande" 2-phase flow. ────────
// A livraison is what actually arrived, recorded once, atomically. There is
// no "brouillon"/"envoyé" order state anymore — she orders by phone/WhatsApp,
// not in the app; this screen only ever records the real thing. "Vous", not
// "tu", throughout — a shopkeeper being helped, not a friend being texted.
//
// The old "Qui ?" step (pick a supplier first, mandatory) is gone. The
// supplier is now a skippable chip on the Confirmé step only — see the
// Restructuration Fournisseurs brief. `poId` (an existing purchase_order to
// close out) is kept as a load path purely so a pre-existing pending order
// from before this change isn't permanently stranded — nothing in the new UI
// links to it anymore.

const ACCESSORY_ID = 'reception-silent-accessory';
const OTHER_SUPPLIER_NAME = 'Marché';

type Step = 'quoi' | 'marge' | 'confirme';

interface VariantSplit {
  variant_id: string;
  name: string;
  qty: string;
}

interface DraftLine {
  localId: string;
  product_id: string | null;
  variant_id: string | null; // set once a single existing variant is chosen directly (rare path)
  name: string;
  qty: string;
  unitCost: string;
  salePriceCents: number | null;
  salePriceOverridden: boolean;
  hasVariants: boolean;
  variantSplits: VariantSplit[] | null; // non-null once the linked product's variants are loaded
  dismissedMatchId: string | null; // "nouveau produit quand même" for this name
}

interface Draft {
  businessId: string;
  supplierId: string | null; // null = not chosen yet (shows "—") or "Marché"
  supplierName: string;      // '' until chosen — never eagerly defaulted to "Marché"
  poId: string | null;
  lines: DraftLine[];
  transportInput: string;
  marginInput: string;
  receivedDate: string;      // 'YYYY-MM-DD' real/backdated delivery date ('' = today)
  createdAt: number;
}

const DRAFT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

function draftKey(businessId: string) {
  return `reception_draft_${businessId}`;
}

function newLocalId() {
  return `l_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function emptyLine(): DraftLine {
  return {
    localId: newLocalId(), product_id: null, variant_id: null, name: '', qty: '', unitCost: '',
    salePriceCents: null, salePriceOverridden: false, hasVariants: false, variantSplits: null,
    dismissedMatchId: null,
  };
}

function emptyDraft(businessId: string, presetSupplier?: Fournisseur): Draft {
  return {
    businessId,
    supplierId: presetSupplier?.id ?? null,
    supplierName: presetSupplier?.name ?? '',
    poId: null,
    lines: [emptyLine()], transportInput: '', marginInput: '', receivedDate: '',
    createdAt: Date.now(),
  };
}

async function loadDraft(businessId: string): Promise<Draft | null> {
  try {
    const raw = await getKV(draftKey(businessId));
    if (!raw) return null;
    const d = JSON.parse(raw) as Draft;
    if (Date.now() - d.createdAt > DRAFT_MAX_AGE_MS) { await setKV(draftKey(businessId), ''); return null; }
    return d;
  } catch {
    return null;
  }
}

function saveDraft(d: Draft) {
  setKV(draftKey(d.businessId), JSON.stringify(d)).catch(() => { });
}

function clearDraft(businessId: string) {
  setKV(draftKey(businessId), '').catch(() => { });
}

// Exported so the Fournisseurs list can show "Brouillon — 12 produits · 24
// sept." without duplicating the read logic. No supplier name — it's often
// not chosen yet at draft time (skippable, picked last on Confirmé).
export async function peekReceptionDraft(businessId: string): Promise<{ lineCount: number; createdAt: number } | null> {
  const d = await loadDraft(businessId);
  if (!d) return null;
  const lineCount = d.lines.filter(l => l.name.trim()).length;
  if (lineCount === 0) return null;
  return { lineCount, createdAt: d.createdAt };
}

function normalizeName(s: string): string {
  return s.trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
}

// Exact-match only, deliberately — a substring/fuzzy match risks silently
// linking the wrong one of two similarly-named products (a real, worse
// mistake than just asking the vendor to type the name once more).
function findCatalogueMatch(name: string, products: Product[]): Product | undefined {
  const n = normalizeName(name);
  if (!n) return undefined;
  return products.find(p => !p.archived && normalizeName(p.name) === n);
}

function parseQty(s: string): number | null {
  const n = parseFloat(s.replace(',', '.').trim());
  return isNaN(n) || n <= 0 ? null : n;
}

export default function ReceptionScreen() {
  const { palette } = useTheme();
  const styles = useMemo(() => makeStyles(palette), [palette]);
  const session = useAuthStore(s => s.session);
  const businessId = session?.activeBusiness?.id ?? '';
  const userId = session?.user.id ?? '';
  const currency = session?.activeBusiness?.currency ?? 'GNF';
  const { poId: poIdParam, supplierId: supplierIdParam } = useLocalSearchParams<{ poId?: string; supplierId?: string }>();

  const { fournisseurs, commandes, loadCommandeLines, confirmReception, updateReceptionSupplier, saving, offline, offlineSince, fetchFournisseurs } = useFournisseursStore();
  const { products, variantsByProduct, fetchVariants } = useProductStore();

  const [step, setStep] = useState<Step>('quoi');
  const [draft, setDraft] = useState<Draft | null>(null);
  const [ready, setReady] = useState(false);
  const [flagName, setFlagName] = useState(false); // "il manque le nom" flash
  const [showSupplierPicker, setShowSupplierPicker] = useState(false);
  // Set once confirmReception has actually saved the livraison — the "De :"
  // chip on Confirmé edits an already-saved record at that point (the RPC
  // already ran and already linked any new product to whatever supplier was
  // set before the call), so picking a different one there has to be a real
  // UPDATE (updateReceptionSupplier), never just a client-side draft patch.
  const [confirmedPoId, setConfirmedPoId] = useState<string | null>(null);
  const [confirmedSupplierName, setConfirmedSupplierName] = useState('');
  const scrollRef = useRef<ScrollView>(null);
  const lineRefs = useRef<Record<string, View | null>>({});

  // ── Load: resume a saved draft, pre-link from a legacy pending order,
  // preset a supplier from the fiche fournisseur entry point, or start fresh.
  useEffect(() => {
    if (!businessId) return;
    (async () => {
      const existing = await loadDraft(businessId);
      if (existing && !poIdParam) {
        setDraft(existing);
        setReady(true);
        return;
      }
      if (poIdParam) {
        const commande = commandes.find(c => c.id === poIdParam);
        if (commande) {
          await loadCommandeLines(poIdParam);
          const withLines = useFournisseursStore.getState().commandes.find(c => c.id === poIdParam);
          const lines: DraftLine[] = (withLines?.lines ?? []).map(l => ({
            localId: newLocalId(),
            product_id: l.product_id,
            variant_id: l.variant_id,
            name: l.variant_name ? `${l.product_name} · ${l.variant_name}` : l.product_name,
            qty: String(l.qty_ordered - l.qty_received),
            // v221: unit_cost may be NULL ("Prix inconnu") — pre-fill blank.
            unitCost: l.unit_cost !== null ? String(Math.round(l.unit_cost)) : '',
            salePriceCents: null, salePriceOverridden: false,
            hasVariants: false, variantSplits: null, dismissedMatchId: null,
          }));
          const d: Draft = {
            businessId, supplierId: commande.supplier_id, supplierName: commande.supplier_name,
            poId: poIdParam, lines: lines.length ? lines : [emptyLine()],
            transportInput: '', marginInput: '', receivedDate: '', createdAt: Date.now(),
          };
          setDraft(d);
          setReady(true);
          return;
        }
      }
      const presetSupplier = supplierIdParam ? fournisseurs.find(f => f.id === supplierIdParam) : undefined;
      setDraft(emptyDraft(businessId, presetSupplier));
      setReady(true);
    })();
    // Only ever run once per mount — route params/commandes/fournisseurs are
    // read at that moment, not re-applied if they change later underneath an
    // in-progress draft.
  }, [businessId]);

  // Auto-save on every change — she is interrupted constantly at the market.
  useEffect(() => {
    if (!ready || !draft) return;
    saveDraft(draft);
  }, [ready, draft]);

  const update = (patch: Partial<Draft>) => setDraft(d => d ? { ...d, ...patch } : d);
  const updateLine = (localId: string, patch: Partial<DraftLine>) =>
    setDraft(d => d ? { ...d, lines: d.lines.map(l => l.localId === localId ? { ...l, ...patch } : l) } : d);

  const selectSupplier = async (f: Fournisseur | null) => {
    setShowSupplierPicker(false);
    if (!confirmedPoId) {
      // Still pre-save (shouldn't currently happen — the picker only opens
      // from the Confirmé step — kept as a safe fallback).
      update({ supplierId: f?.id ?? null, supplierName: f?.name ?? OTHER_SUPPLIER_NAME });
      return;
    }
    const ok = await updateReceptionSupplier(confirmedPoId, businessId, userId, f?.id ?? null);
    if (ok) {
      haptics.success();
      setConfirmedSupplierName(f?.name ?? OTHER_SUPPLIER_NAME);
    } else {
      toast.warning('Le changement de fournisseur n\'a pas pu être enregistré.');
    }
  };

  const linkProduct = (localId: string, product: Product) => {
    updateLine(localId, {
      product_id: product.id, name: product.name, hasVariants: product.has_variants,
      // NULL cost_price = "Prix inconnu" (v221) — pre-fill blank so the user
      // can leave it unknown instead of inheriting a false 0.
      unitCost: product.cost_price ? String(Math.round(product.cost_price)) : '',
    });
    if (product.has_variants) {
      fetchVariants(product.id, businessId).then(variants => {
        updateLine(localId, {
          variantSplits: variants.map(v => ({ variant_id: v.id, name: v.name, qty: '' })),
        });
      });
    }
  };

  const addLine = () => setDraft(d => d ? { ...d, lines: [...d.lines, emptyLine()] } : d);
  const removeLine = (localId: string) =>
    setDraft(d => d ? { ...d, lines: d.lines.length > 1 ? d.lines.filter(l => l.localId !== localId) : d.lines } : d);

  // ── Arithmetic: one total, no separate manual verification input. ──────────
  const linesTotal = useMemo(() => {
    if (!draft) return 0;
    return draft.lines.reduce((sum, l) => {
      const qty = parseQty(l.qty) ?? 0;
      const cost = parseAmountInput(l.unitCost, currency) || 0;
      return sum + qty * cost;
    }, 0);
  }, [draft, currency]);

  // ── Validation: find the first thing blocking "Tout est bon ✓" ──────────
  // v221: a blank purchase cost is no longer an error — it means "Prix inconnu".
  // Only name and qty (and variant-split arithmetic) block the next step.
  function firstIssue(): { line: DraftLine; kind: 'name' | 'qty' | 'variant' } | null {
    if (!draft) return null;
    for (const l of draft.lines) {
      if (!l.name.trim()) return { line: l, kind: 'name' };
    }
    for (const l of draft.lines) {
      if (l.hasVariants && l.variantSplits) {
        const sum = l.variantSplits.reduce((s, v) => s + (parseQty(v.qty) ?? 0), 0);
        const target = parseQty(l.qty);
        if (!target || sum !== target) return { line: l, kind: 'variant' };
        continue;
      }
      if (parseQty(l.qty) === null) return { line: l, kind: 'qty' };
    }
    return null;
  }

  const remainingCount = draft
    ? draft.lines.filter(l => {
      if (!l.name.trim()) return true;
      if (l.hasVariants && l.variantSplits) {
        const sum = l.variantSplits.reduce((s, v) => s + (parseQty(v.qty) ?? 0), 0);
        return sum !== parseQty(l.qty);
      }
      return parseQty(l.qty) === null;
    }).length
    : 0;

  const handleVerifyDone = () => {
    const issue = firstIssue();
    if (issue) {
      haptics.warning();
      const node = lineRefs.current[issue.line.localId];
      node?.measure?.((_x, _y, _w, _h, _px, py) => {
        scrollRef.current?.scrollTo({ y: Math.max(0, py - 120), animated: true });
      });
      if (issue.kind === 'name') {
        setFlagName(true);
        toast.warning('Il manque le nom d\'un produit 👆');
        setTimeout(() => setFlagName(false), 2000);
      } else if (issue.kind === 'variant') {
        toast.warning('La répartition ne correspond pas à la quantité totale');
      } else {
        toast.warning('Un champ est incomplet — vérifiez la ligne en ambre 👆');
      }
      return;
    }
    haptics.success();
    setStep('marge');
  };

  // ── Margin ───────────────────────────────────────────────────────────────
  const marginPct = draft ? parseFloat(draft.marginInput.replace(',', '.')) || 0 : 0;
  const computedSalePrice = (unitCostDisplay: number) => Math.round(unitCostDisplay * (1 + marginPct / 100) * 100);

  const [showPerLine, setShowPerLine] = useState(false);

  const handleConfirm = async () => {
    if (!draft) return;
    const rpcLines: ReceptionLine[] = [];
    for (const l of draft.lines) {
      // v221: blank cost → null (unknown), not 0. A sale price is only
      // computed when a cost is actually known.
      const unitCostDisplay = parseAmountInput(l.unitCost, currency);
      const unitCostCents = unitCostDisplay > 0 ? Math.round(unitCostDisplay * 100) : null;
      const salePriceCents = l.salePriceOverridden && l.salePriceCents !== null
        ? l.salePriceCents
        : (unitCostCents !== null ? computedSalePrice(unitCostDisplay) : null);

      if (l.hasVariants && l.variantSplits) {
        for (const v of l.variantSplits) {
          const qty = parseQty(v.qty);
          if (!qty) continue;
          rpcLines.push({
            product_id: l.product_id, variant_id: v.variant_id, name: `${l.name} · ${v.name}`,
            qty, unit_cost_cents: unitCostCents, sale_price_cents: null, // variant sale_price out of scope this pass
          });
        }
      } else {
        const qty = parseQty(l.qty);
        if (!qty) continue;
        rpcLines.push({
          product_id: l.product_id, variant_id: l.variant_id, name: l.name,
          qty, unit_cost_cents: unitCostCents, sale_price_cents: salePriceCents,
        });
      }
    }

    const transportCents = Math.round((parseAmountInput(draft.transportInput, currency) || 0) * 100);
    const poId = await confirmReception(businessId, userId, {
      supplierId: draft.supplierId, poId: draft.poId, lines: rpcLines,
      transportCostCents: transportCents, marginPercent: draft.marginInput ? marginPct : null,
      receivedDate: draft.receivedDate || null,
    });

    if (!poId) {
      toast.warning('La livraison n\'a pas pu être enregistrée. Réessayez.');
      return;
    }

    haptics.success();
    clearDraft(businessId);
    trackEvent('reception_confirmed', businessId, userId, {
      line_count: rpcLines.length, linked_order: !!draft.poId,
    });
    // The supplier is whatever confirmReception itself resolved server-side
    // (draft.supplierName if set, "Marché" otherwise) — the Confirmé chip
    // below edits this real, already-saved value, not the pre-save draft.
    setConfirmedPoId(poId);
    setConfirmedSupplierName(draft.supplierName || OTHER_SUPPLIER_NAME);
    setStep('confirme');
  };

  if (!ready || !draft) {
    return <Screen><View style={styles.center}><Text variant="body" color="secondary">…</Text></View></Screen>;
  }

  return (
    <Screen>
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} hitSlop={12}>
          <Text variant="body" color="secondary">‹ Retour</Text>
        </Pressable>
        <Text variant="h4" numberOfLines={1}>
          {step === 'quoi' ? 'Ce qui est arrivé.'
            : step === 'marge' ? 'Votre marge'
              : 'Enregistré'}
        </Text>
        <View style={{ width: 60 }} />
      </View>
      {offline && (
        <OfflineNotice offlineSince={offlineSince} onRetry={() => fetchFournisseurs(businessId)} />
      )}

      {step === 'quoi' && (
        <QuoiStep
          draft={draft}
          currency={currency}
          products={products}
          variantsByProduct={variantsByProduct}
          linesTotal={linesTotal}
          flagName={flagName}
          scrollRef={scrollRef}
          lineRefs={lineRefs}
          onUpdateLine={updateLine}
          onLinkProduct={linkProduct}
          onAddLine={addLine}
          onRemoveLine={removeLine}
          onDone={handleVerifyDone}
          styles={styles}
          palette={palette}
        />
      )}

      {step === 'marge' && (
        <MargeStep
          draft={draft}
          currency={currency}
          marginPct={marginPct}
          computedSalePrice={computedSalePrice}
          showPerLine={showPerLine}
          setShowPerLine={setShowPerLine}
          onUpdate={update}
          onUpdateLine={updateLine}
          onBack={() => setStep('quoi')}
          onConfirm={handleConfirm}
          saving={saving}
          styles={styles}
          palette={palette}
        />
      )}

      {step === 'confirme' && (
        <ConfirmeStep
          draft={draft}
          currency={currency}
          linesTotal={linesTotal}
          supplierName={confirmedSupplierName}
          onChangeSupplier={() => setShowSupplierPicker(true)}
          styles={styles}
          palette={palette}
        />
      )}

      <SupplierPickerSheet
        visible={showSupplierPicker}
        fournisseurs={fournisseurs}
        onSelect={selectSupplier}
        onClose={() => setShowSupplierPicker(false)}
        styles={styles}
        palette={palette}
      />
    </Screen>
  );
}

// ─── Supplier picker (Confirmé step's "De :" chip) ──────────────────────────

function SupplierPickerSheet({ visible, fournisseurs, onSelect, onClose, styles, palette }: {
  visible: boolean;
  fournisseurs: Fournisseur[];
  onSelect: (f: Fournisseur | null) => void;
  onClose: () => void;
  styles: ReturnType<typeof makeStyles>;
  palette: Palette;
}) {
  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <SafeAreaView style={styles.pickerSafe} edges={['top', 'bottom']}>
        <View style={styles.pickerHeader}>
          <Text variant="h4">De qui ?</Text>
          <Pressable onPress={onClose} hitSlop={12}>
            <Text variant="body" color="secondary">Fermer</Text>
          </Pressable>
        </View>
        <ScrollView contentContainerStyle={styles.pad}>
          {fournisseurs.map(f => {
            const ac = SUPPLIER_AVATAR_PALETTE[f.name.charCodeAt(0) % SUPPLIER_AVATAR_PALETTE.length];
            const initials = f.name.split(/\s+/).slice(0, 2).map(w => w[0]?.toUpperCase() ?? '').join('');
            return (
              <Pressable
                key={f.id}
                onPress={() => onSelect(f)}
                style={({ pressed }) => [styles.quiRow, pressed && { opacity: 0.6 }]}
              >
                <View style={[styles.quiAvatar, { backgroundColor: ac.bg }]}>
                  <Text style={{ fontFamily: fontFamily.bold, fontSize: 15, color: ac.text }}>{initials}</Text>
                </View>
                <Text variant="body" style={{ flex: 1 }}>{f.name}</Text>
                <Ionicons name="chevron-forward" size={18} color={palette.textDisabled} />
              </Pressable>
            );
          })}
          <Pressable
            onPress={() => onSelect(null)}
            style={({ pressed }) => [styles.quiRow, pressed && { opacity: 0.6 }]}
          >
            <View style={[styles.quiAvatar, { backgroundColor: palette.background, borderWidth: 1, borderColor: palette.border }]}>
              <Ionicons name="storefront-outline" size={18} color={palette.textSecondary} />
            </View>
            <Text variant="body" style={{ flex: 1 }}>{OTHER_SUPPLIER_NAME}</Text>
            <Ionicons name="chevron-forward" size={18} color={palette.textDisabled} />
          </Pressable>
        </ScrollView>
      </SafeAreaView>
    </Modal>
  );
}

// ─── Étape 1 : Ce qui est arrivé ─────────────────────────────────────────────

function QuoiStep({
  draft, currency, products, variantsByProduct, linesTotal,
  flagName, scrollRef, lineRefs, onUpdateLine, onLinkProduct, onAddLine, onRemoveLine,
  onDone, styles, palette,
}: {
  draft: Draft; currency: string; products: Product[]; variantsByProduct: Record<string, { id: string; name: string }[]>;
  linesTotal: number; flagName: boolean;
  scrollRef: React.RefObject<ScrollView | null>; lineRefs: React.MutableRefObject<Record<string, View | null>>;
  onUpdateLine: (id: string, p: Partial<DraftLine>) => void;
  onLinkProduct: (id: string, product: Product) => void; onAddLine: () => void; onRemoveLine: (id: string) => void;
  onDone: () => void; styles: ReturnType<typeof makeStyles>; palette: Palette;
}) {
  // Plain running count as the list grows — no "à vérifier"/"vérifié" wording.
  // She's typing what arrived herself; there's nothing to verify here, that
  // word belongs to the future AI-import screen where a stagiaire's draft
  // genuinely needs checking. Nothing shown at all until she's typed a name.
  const typedCount = draft.lines.filter(l => l.name.trim()).length;

  return (
    <>
      <ScrollView ref={scrollRef} contentContainerStyle={styles.pad} keyboardShouldPersistTaps="handled">
        {typedCount > 0 && (
          <Text variant="caption" color="secondary">
            {typedCount} produit{typedCount > 1 ? 's' : ''}.
          </Text>
        )}

        {draft.lines.map(line => {
          const isNameIssue = flagName && !line.name.trim();
          const match = !line.product_id && line.name.trim().length > 1 && line.dismissedMatchId !== line.name
            ? findCatalogueMatch(line.name, products)
            : undefined;

          return (
            <View
              key={line.localId}
              ref={r => { lineRefs.current[line.localId] = r; }}
              style={[styles.lineCard, (isNameIssue) && styles.lineCardWarn]}
            >
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing[2] }}>
                <TextInput
                  value={line.name}
                  onChangeText={v => onUpdateLine(line.localId, { name: v, product_id: null, hasVariants: false, variantSplits: null })}
                  placeholder="Nom du produit"
                  placeholderTextColor={palette.textDisabled}
                  style={[styles.nameInput, !line.name.trim() && styles.nameInputEmpty, { color: palette.textPrimary }]}
                />
                {draft.lines.length > 1 && (
                  <Pressable onPress={() => onRemoveLine(line.localId)} hitSlop={8}>
                    <Ionicons name="close-circle-outline" size={20} color={palette.textDisabled} />
                  </Pressable>
                )}
              </View>

              {line.product_id && (
                <View style={styles.tagRow}>
                  <Ionicons name="checkmark-circle" size={13} color={palette.success} />
                  <Text variant="caption" style={{ color: palette.success }}>Produit existant lié</Text>
                </View>
              )}

              {match && (
                <View style={styles.matchBanner}>
                  <Text variant="caption" style={{ color: palette.textPrimary, flex: 1 }}>
                    « {match.name} » existe déjà.
                  </Text>
                  <Pressable onPress={() => onLinkProduct(line.localId, match)}>
                    <Text variant="caption" style={{ color: palette.primary, fontFamily: fontFamily.semibold }}>Ajouter au stock</Text>
                  </Pressable>
                  <Pressable onPress={() => onUpdateLine(line.localId, { dismissedMatchId: line.name })}>
                    <Text variant="caption" color="secondary">Nouveau produit</Text>
                  </Pressable>
                </View>
              )}

              {line.hasVariants && line.variantSplits ? (
                <VariantSplitRow line={line} onUpdateLine={onUpdateLine} styles={styles} palette={palette} />
              ) : (
                <View style={styles.lineFieldsRow}>
                  <View style={{ flex: 1 }}>
                    <Text variant="caption" color="secondary">Quantité</Text>
                    <TextInput
                      value={line.qty}
                      onChangeText={v => onUpdateLine(line.localId, { qty: v.replace(/[^0-9]/g, '') })}
                      keyboardType="number-pad"
                      placeholderTextColor={palette.textDisabled}
                      style={[styles.fieldInput, !parseQty(line.qty) && styles.fieldInputWarn, { color: palette.textPrimary }]}
                      inputAccessoryViewID={Platform.OS === 'ios' ? ACCESSORY_ID : undefined}
                    />
                  </View>
                  <View style={{ flex: 1.4 }}>
                    <Text variant="caption" color="secondary">Prix d'achat ({currency})</Text>
                    <TextInput
                      value={line.unitCost}
                      onChangeText={v => onUpdateLine(line.localId, { unitCost: formatAmountInput(v, currency) })}
                      keyboardType="decimal-pad"
                      placeholder="Prix inconnu"
                      placeholderTextColor={palette.textDisabled}
                      style={[styles.fieldInput, { color: palette.textPrimary }]}
                      inputAccessoryViewID={Platform.OS === 'ios' ? ACCESSORY_ID : undefined}
                    />
                  </View>
                </View>
              )}

              {parseQty(line.qty) && parseAmountInput(line.unitCost, currency) > 0 && !line.hasVariants && (
                <Text variant="caption" color="secondary">
                  Total : {Math.round(parseQty(line.qty)! * parseAmountInput(line.unitCost, currency)).toLocaleString('fr-FR')} {currency}
                </Text>
              )}

              {parseQty(line.qty) && !(parseAmountInput(line.unitCost, currency) > 0) && !line.hasVariants && (
                <Text variant="caption" color="secondary">
                  Prix inconnu — la marge ne sera pas calculée pour ce produit.
                </Text>
              )}
            </View>
          );
        })}

        <Pressable onPress={onAddLine} style={styles.addLineRow}>
          <Ionicons name="add-circle-outline" size={18} color={palette.primary} />
          <Text variant="label" style={{ color: palette.primary }}>Ajouter un produit</Text>
        </Pressable>

        <View style={styles.checkCard}>
          <View style={styles.checkRow}>
            <Text variant="label">Total</Text>
            <Text variant="label">{Math.round(linesTotal).toLocaleString('fr-FR')} {currency}</Text>
          </View>
        </View>
      </ScrollView>

      <View style={styles.footer}>
        <Button label="Tout est bon ✓" onPress={onDone} fullWidth size="lg" />
      </View>
    </>
  );
}

function VariantSplitRow({ line, onUpdateLine, styles, palette }: {
  line: DraftLine; onUpdateLine: (id: string, p: Partial<DraftLine>) => void;
  styles: ReturnType<typeof makeStyles>; palette: Palette;
}) {
  const splits = line.variantSplits ?? [];
  const sum = splits.reduce((s, v) => s + (parseQty(v.qty) ?? 0), 0);
  const target = parseQty(line.qty);
  const ok = target !== null && sum === target;

  const setSplitQty = (variant_id: string, qty: string) => {
    onUpdateLine(line.localId, {
      variantSplits: splits.map(v => v.variant_id === variant_id ? { ...v, qty: qty.replace(/[^0-9]/g, '') } : v),
    });
  };

  return (
    <View style={{ gap: spacing[2] }}>
      <Text variant="caption" color="secondary">Quantité totale reçue</Text>
      <TextInput
        value={line.qty}
        onChangeText={v => onUpdateLine(line.localId, { qty: v.replace(/[^0-9]/g, '') })}
        keyboardType="number-pad"
        placeholderTextColor={palette.textDisabled}
        style={[styles.fieldInput, { color: palette.textPrimary }]}
      />
      <Text variant="caption" color="secondary">Répartition par variante</Text>
      <View style={styles.variantGrid}>
        {splits.map(v => (
          <View key={v.variant_id} style={styles.variantCell}>
            <Text variant="caption" color="secondary">{v.name}</Text>
            <TextInput
              value={v.qty}
              onChangeText={t => setSplitQty(v.variant_id, t)}
              keyboardType="number-pad"
              placeholderTextColor={palette.textDisabled}
              style={[styles.fieldInput, { textAlign: 'center', color: palette.textPrimary }]}
            />
          </View>
        ))}
      </View>
      <View style={styles.tagRow}>
        <Ionicons name={ok ? 'checkmark-circle' : 'alert-circle'} size={13} color={ok ? palette.success : palette.warning} />
        <Text variant="caption" style={{ color: ok ? palette.success : palette.warning }}>
          {sum}/{target ?? 0} {ok ? '✓' : ''}
        </Text>
      </View>
    </View>
  );
}

// ─── Étape 2 : Votre marge ───────────────────────────────────────────────────

function MargeStep({
  draft, currency, marginPct, computedSalePrice, showPerLine, setShowPerLine,
  onUpdate, onUpdateLine, onBack, onConfirm, saving, styles, palette,
}: {
  draft: Draft; currency: string; marginPct: number; computedSalePrice: (c: number) => number;
  showPerLine: boolean; setShowPerLine: (v: boolean) => void;
  onUpdate: (p: Partial<Draft>) => void; onUpdateLine: (id: string, p: Partial<DraftLine>) => void;
  onBack: () => void; onConfirm: () => void; saving: boolean;
  styles: ReturnType<typeof makeStyles>; palette: Palette;
}) {
  const exampleLine = draft.lines.find(l => parseAmountInput(l.unitCost, currency) > 0);
  const exampleCost = exampleLine ? parseAmountInput(exampleLine.unitCost, currency) : 0;
  const exampleSale = exampleCost > 0 ? computedSalePrice(exampleCost) / 100 : 0;
  const exampleGain = exampleCost > 0 ? Math.round(exampleSale - exampleCost) : 0;

  return (
    <>
      <ScrollView contentContainerStyle={styles.pad}>
        <Pressable onPress={onBack} hitSlop={8} style={{ alignSelf: 'flex-start', marginBottom: spacing[3] }}>
          <Text variant="caption" color="secondary">‹ Revoir les produits</Text>
        </Pressable>

        <View style={styles.marginBox}>
          <TextInput
            value={draft.marginInput}
            onChangeText={v => onUpdate({ marginInput: v.replace(/[^0-9.,]/g, '') })}
            keyboardType="decimal-pad"
            placeholder="0"
            placeholderTextColor={palette.textDisabled}
            style={styles.marginInput}
            inputAccessoryViewID={Platform.OS === 'ios' ? ACCESSORY_ID : undefined}
          />
          <Text style={styles.marginPercentSign}>%</Text>
        </View>

        {exampleCost > 0 ? (
          <>
            <Text variant="body" color="secondary">
              Prix d'achat {Math.round(exampleCost).toLocaleString('fr-FR')} → vous vendez à{' '}
              <Text variant="body" style={{ color: palette.textPrimary, fontFamily: fontFamily.semibold }}>
                {Math.round(exampleSale).toLocaleString('fr-FR')} {currency}
              </Text>
            </Text>
            <Text variant="body" style={{ color: palette.success, fontFamily: fontFamily.semibold }}>
              Vous gagnez {exampleGain.toLocaleString('fr-FR')} {currency} par produit.
            </Text>
          </>
        ) : (
          <Text variant="body" color="secondary">
            Marge non calculable — renseignez un prix d'achat pour la voir.
          </Text>
        )}

        <View style={{ marginTop: spacing[6], gap: spacing[2] }}>
          <Text variant="label">Transport <Text variant="caption" color="secondary">(optionnel)</Text></Text>
          <TextInput
            value={draft.transportInput}
            onChangeText={v => onUpdate({ transportInput: formatAmountInput(v, currency) })}
            keyboardType="decimal-pad"
            placeholder="0"
            placeholderTextColor={palette.textDisabled}
            style={[styles.fieldInput, { color: palette.textPrimary }]}
            inputAccessoryViewID={Platform.OS === 'ios' ? ACCESSORY_ID : undefined}
          />
          <Text variant="caption" color="secondary">Ajouté au prix d'achat de chaque produit.</Text>
        </View>

        <View style={{ marginTop: spacing[4], gap: spacing[2] }}>
          <Text variant="label">Date de réception <Text variant="caption" color="secondary">(aujourd'hui par défaut)</Text></Text>
          <DatePickerField
            value={draft.receivedDate}
            onChange={iso => onUpdate({ receivedDate: iso })}
            maxToday
          />
        </View>

        <Pressable onPress={() => setShowPerLine(!showPerLine)} style={{ marginTop: spacing[6] }}>
          <Text variant="caption" style={{ color: palette.primary }}>
            {showPerLine ? 'Masquer' : 'Modifier'} le prix par produit
          </Text>
        </Pressable>

        {showPerLine && draft.lines.filter(l => l.name.trim() && !l.hasVariants).map(l => {
          const cost = parseAmountInput(l.unitCost, currency) || 0;
          const current = l.salePriceOverridden && l.salePriceCents !== null ? l.salePriceCents : computedSalePrice(cost);
          return (
            <View key={l.localId} style={styles.perLineRow}>
              <Text variant="body" numberOfLines={1} style={{ flex: 1 }}>{l.name}</Text>
              <TextInput
                value={String(Math.round(current / 100))}
                onChangeText={v => onUpdateLine(l.localId, {
                  salePriceOverridden: true,
                  salePriceCents: Math.round((parseFloat(v.replace(/[^0-9]/g, '')) || 0) * 100),
                })}
                keyboardType="number-pad"
                style={[styles.fieldInput, { width: 110, textAlign: 'right', color: palette.textPrimary }]}
              />
            </View>
          );
        })}
      </ScrollView>

      <View style={styles.footer}>
        <Button label={saving ? 'Enregistrement…' : 'Confirmer la livraison'} onPress={onConfirm} loading={saving} fullWidth size="lg" />
      </View>
    </>
  );
}

// ─── Étape 3 : Confirmé ──────────────────────────────────────────────────────

function ConfirmeStep({ draft, currency, linesTotal, supplierName, onChangeSupplier, styles, palette }: {
  draft: Draft; currency: string; linesTotal: number; supplierName: string; onChangeSupplier: () => void;
  styles: ReturnType<typeof makeStyles>; palette: Palette;
}) {
  const newProductCount = draft.lines.filter(l => !l.product_id && l.name.trim()).length;
  const itemCount = draft.lines.reduce((s, l) => {
    if (l.hasVariants && l.variantSplits) return s + l.variantSplits.reduce((ss, v) => ss + (parseQty(v.qty) ?? 0), 0);
    return s + (parseQty(l.qty) ?? 0);
  }, 0);

  return (
    <View style={styles.confirmWrap}>
      <View style={styles.confirmCheck}>
        <Ionicons name="checkmark" size={36} color={palette.textInverse} />
      </View>
      <Text variant="h2" style={{ textAlign: 'center' }}>{itemCount} produit{itemCount > 1 ? 's' : ''} enregistré{itemCount > 1 ? 's' : ''}</Text>
      <Text variant="body" color="secondary" style={{ textAlign: 'center' }}>
        {newProductCount > 0 ? `+${newProductCount} produit${newProductCount > 1 ? 's' : ''} · ` : ''}
        stock mis à jour · Total {Math.round(linesTotal).toLocaleString('fr-FR')} {currency}
      </Text>

      <Pressable onPress={onChangeSupplier} style={[styles.supplierChip, { marginTop: spacing[6] }]}>
        <Ionicons name="storefront-outline" size={14} color={palette.textSecondary} />
        <Text variant="caption" color="secondary">De : {supplierName || '—'}</Text>
      </Pressable>

      <Button
        label="Terminé"
        onPress={() => router.replace('/(app)/fournisseurs')}
        fullWidth size="lg"
        style={{ marginTop: spacing[8] }}
      />
    </View>
  );
}

function makeStyles(p: Palette) {
  return StyleSheet.create({
    center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
    header: {
      flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
      paddingHorizontal: spacing[5], paddingVertical: spacing[3],
    },
    pad: { padding: spacing[5], paddingBottom: spacing[10], gap: spacing[3] },
    footer: { padding: spacing[5], borderTopWidth: 1, borderTopColor: p.border, backgroundColor: p.surface },

    // Supplier picker sheet
    pickerSafe: { flex: 1, backgroundColor: p.background },
    pickerHeader: {
      flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
      paddingHorizontal: spacing[5], paddingVertical: spacing[4],
      borderBottomWidth: 1, borderBottomColor: p.border,
    },
    quiRow: { flexDirection: 'row', alignItems: 'center', gap: spacing[3], paddingVertical: spacing[3] },
    quiAvatar: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },

    // Quoi ?
    supplierChip: {
      flexDirection: 'row', alignItems: 'center', gap: spacing[2],
      paddingVertical: spacing[2], paddingHorizontal: spacing[3],
      borderRadius: radius.md, borderWidth: 1, borderColor: p.border, backgroundColor: p.surface,
    },
    lineCard: {
      borderRadius: radius.card, borderWidth: 1, borderColor: p.border,
      backgroundColor: p.surface, padding: spacing[4], gap: spacing[2],
    },
    lineCardWarn: { borderColor: p.warning, borderWidth: 1.5 },
    nameInput: { flex: 1, fontFamily: fontFamily.semibold, fontSize: 16, paddingVertical: spacing[1] },
    nameInputEmpty: {
      borderWidth: 1, borderStyle: 'dashed', borderColor: p.warning,
      borderRadius: radius.sm, paddingHorizontal: spacing[2],
    },
    lineFieldsRow: { flexDirection: 'row', gap: spacing[3] },
    fieldInput: {
      borderWidth: 1, borderColor: p.border, borderRadius: radius.md,
      paddingHorizontal: spacing[3], paddingVertical: spacing[2], fontSize: 15,
      fontVariant: ['tabular-nums'] as ['tabular-nums'],
    },
    fieldInputWarn: { borderColor: p.warning },
    tagRow: { flexDirection: 'row', alignItems: 'center', gap: spacing[1] },
    matchBanner: {
      flexDirection: 'row', alignItems: 'center', gap: spacing[3],
      backgroundColor: p.warningLight, borderRadius: radius.md, padding: spacing[3],
    },
    addLineRow: { flexDirection: 'row', alignItems: 'center', gap: spacing[2], paddingVertical: spacing[3] },
    checkCard: {
      borderRadius: radius.card, borderWidth: 1, borderColor: p.border,
      backgroundColor: p.background, padding: spacing[4], gap: spacing[2],
    },
    checkRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
    variantGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing[2] },
    variantCell: { gap: spacing[1], minWidth: 70 },

    // Votre marge
    marginBox: { flexDirection: 'row', alignItems: 'baseline', gap: spacing[2], marginVertical: spacing[4] },
    marginInput: {
      fontFamily: fontFamily.bold, fontSize: 48, lineHeight: 58, color: p.textPrimary,
      borderBottomWidth: 2, borderBottomColor: p.primary, minWidth: 100,
      fontVariant: ['tabular-nums'] as ['tabular-nums'],
    },
    marginPercentSign: { fontFamily: fontFamily.bold, fontSize: 28, lineHeight: 34, color: p.textSecondary },
    perLineRow: { flexDirection: 'row', alignItems: 'center', gap: spacing[3], paddingVertical: spacing[2] },

    // Confirmé
    confirmWrap: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing[8], gap: spacing[3] },
    confirmCheck: {
      width: 72, height: 72, borderRadius: 36, backgroundColor: p.success,
      alignItems: 'center', justifyContent: 'center', marginBottom: spacing[3],
    },
  });
}
