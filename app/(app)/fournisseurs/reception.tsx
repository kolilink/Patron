import { useEffect, useMemo, useRef, useState } from 'react';
import { useInFlight } from '@/src/hooks/useInFlight';
import { failAlert } from '@/src/components/ui/FailureView';
import { useSyncStore } from '@/stores/sync';
import { isQueued } from '@/lib/outbox';
import { generateId } from '@/lib/id';
import { QuantityStepper } from '@/src/components/ui/QuantityStepper';
import { FlatList, Modal, Platform, Pressable, ScrollView, StyleSheet, TextInput, View } from 'react-native';
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
import { formatAmountInput, parseAmountInput, formatAmount, amountInputToCents } from '@/src/utils/format';
import { DatePickerField } from '@/src/components/ui/DatePickerField';
import { FormSheet } from '@/src/components/ui/FormSheet';
import { QuickAddProductSheet } from '@/src/components/QuickAddProductSheet';
import { showFailureAlert } from '@/src/components/ui/FailureView';
import { buildFailure, failureReason } from '@/src/utils/failure';
import { FAILURE_COPY } from '@/src/utils/failureCopy';
import type { QuickAddPayload } from '@/src/utils/quickAddProduct';
import { isUnlinkedNamedLine, linkedLinePatch } from '@/src/utils/receptionLink';
import { Input } from '@/src/components/ui/Input';
import { PhoneInput } from '@/src/components/ui/PhoneInput';
import { appAlert } from '@/src/utils/appAlert';

// ── "Nouvelle livraison" — replaces the old "commande" 2-phase flow. ────────
// A livraison is what actually arrived, recorded once, atomically. There is
// no "brouillon"/"envoyé" order state anymore — she orders by phone/WhatsApp,
// not in the app; this screen only ever records the real thing. "Vous", not
// "tu", throughout — a shopkeeper being helped, not a friend being texted.
//
// The old "Qui ?" step (pick a supplier first, mandatory) is gone. The
// supplier is now a skippable chip on Écran 1, and can still be edited from
// the Confirmé step after the fact — see the Restructuration Fournisseurs
// brief. `poId` (an existing purchase_order to close out) is kept as a load
// path purely so a pre-existing pending order from before this change isn't
// permanently stranded — nothing in the new UI links to it anymore.

const ACCESSORY_ID = 'reception-silent-accessory';
const OTHER_SUPPLIER_NAME = 'Marché';

type Step = 'quoi' | 'recap' | 'confirme';

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
  // "Je vends à" — the sale price this line should book. `salePriceInput` is the
  // formatted display string; `salePriceCents` its parsed cents (null when blank —
  // never 0). `salePriceTouched` flips the moment she edits it, so an untouched
  // prefill is only a hint and never overwrites a product's real sale_price.
  salePriceInput: string;
  salePriceCents: number | null;
  salePriceTouched: boolean;
  hasVariants: boolean;
  variantSplits: VariantSplit[] | null; // non-null once the linked product's variants are loaded
}

interface Draft {
  businessId: string;
  supplierId: string | null; // null = not chosen yet (shows "—") or "Marché"
  supplierName: string;      // '' until chosen — never eagerly defaulted to "Marché"
  poId: string | null;
  lines: DraftLine[];
  transportInput: string;
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
    salePriceInput: '', salePriceCents: null, salePriceTouched: false,
    hasVariants: false, variantSplits: null,
  };
}

function emptyDraft(businessId: string, presetSupplier?: Fournisseur): Draft {
  return {
    businessId,
    supplierId: presetSupplier?.id ?? null,
    supplierName: presetSupplier?.name ?? '',
    poId: null,
    lines: [emptyLine()], transportInput: '', receivedDate: '',
    createdAt: Date.now(),
  };
}

async function loadDraft(businessId: string): Promise<Draft | null> {
  try {
    const raw = await getKV(draftKey(businessId));
    if (!raw) return null;
    const d = JSON.parse(raw) as Draft;
    if (Date.now() - d.createdAt > DRAFT_MAX_AGE_MS) { await setKV(draftKey(businessId), ''); return null; }
    // Normalize pre-redesign drafts (which carried `marginInput` and
    // `salePriceOverridden`) onto the new "Je vends à" shape. An untouched
    // prefill must never overwrite a product's real sale_price.
    delete (d as Draft & { marginInput?: string }).marginInput;
    d.lines = (d.lines ?? []).map(l => {
      const overridden = (l as DraftLine & { salePriceOverridden?: boolean }).salePriceOverridden;
      return {
        localId: l.localId, product_id: l.product_id, variant_id: l.variant_id, name: l.name,
        qty: l.qty, unitCost: l.unitCost,
        salePriceInput: l.salePriceInput ?? '',
        salePriceCents: overridden ? l.salePriceCents : null,
        salePriceTouched: overridden ?? l.salePriceTouched ?? false,
        hasVariants: l.hasVariants, variantSplits: l.variantSplits,
      };
    });
    return d;
  } catch {
    // failure: silent — draft JSON unreadable: no draft
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
  const receptionKeyRef = useRef<string | null>(null);
  // The key of the reception just confirmed, and whether it is still waiting in
  // the outbox (dead zone) — drives the honest "pas encore envoyée" line.
  const [receptionKey, setReceptionKey] = useState<string | null>(null);
  const [receptionPending, setReceptionPending] = useState(false);
  const pendingCount = useSyncStore(s => s.pendingCount);
  useEffect(() => {
    if (!receptionKey) { setReceptionPending(false); return; }
    let alive = true;
    void isQueued('confirm_reception', receptionKey).then(q => { if (alive) setReceptionPending(q); });
    return () => { alive = false; };
  }, [receptionKey, pendingCount]);
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
            salePriceInput: '', salePriceCents: null, salePriceTouched: false,
            hasVariants: false, variantSplits: null,
          }));
          const d: Draft = {
            businessId, supplierId: commande.supplier_id, supplierName: commande.supplier_name,
            poId: poIdParam, lines: lines.length ? lines : [emptyLine()],
            transportInput: '', receivedDate: '', createdAt: Date.now(),
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
    if (receptionPending) {
      // The order doesn't exist on the server yet: there is nothing to edit.
      failAlert('supplierNotChangedYet');
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
      // "Je vends à" prefilled with the product's current sale_price as a hint —
      // NOT touched, so it never overwrites the real price unless she edits it.
      salePriceInput: product.sale_price > 0 ? formatAmountInput(String(product.sale_price), currency) : '',
      salePriceCents: product.sale_price > 0 ? Math.round(product.sale_price * 100) : null,
      salePriceTouched: false,
    });
    if (product.has_variants) {
      fetchVariants(product.id, businessId).then(variants => {
        updateLine(localId, {
          variantSplits: variants.map(v => ({ variant_id: v.id, name: v.name, qty: '' })),
        });
      });
    }
  };

  // ── One flow to add a product: the QuickAddProductSheet. A delivery line never creates a product
  // by itself at confirm — it is linked to an existing one, or to one created through the sheet.
  const { createProduct, upsertVariants, saving: productSaving } = useProductStore();
  const [sheetTarget, setSheetTarget] = useState<{ localId: string; name: string; qty: string } | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [pickerLineId, setPickerLineId] = useState<string | null>(null);
  const [flagLinkId, setFlagLinkId] = useState<string | null>(null); // "choisissez un produit" flash
  const openProductSheet = (line: DraftLine) => {
    setSheetTarget({ localId: line.localId, name: line.name.trim(), qty: line.qty });
    setSheetOpen(true);
  };

  /**
   * Ajouter in the sheet: create the product phone-first (outbox, client id), then link THIS line to it.
   * The product is created with no stock and no cost — the delivery books both at confirm. The line keeps
   * its unit cost and takes the sale price from the sheet; with Modèles the line goes through the same
   * per-model split as an existing variant product.
   */
  const createForLine = async (payload: QuickAddPayload): Promise<{ ok: boolean }> => {
    if (!sheetTarget) return { ok: false };
    const { localId } = sheetTarget;
    const productId = generateId();
    const ok = await createProduct(businessId, userId, { ...payload.data, id: productId });
    if (!ok) {
      haptics.error();
      showFailureAlert(buildFailure({
        what: FAILURE_COPY.productNotSaved.what,
        why: failureReason(useProductStore.getState().error) ?? FAILURE_COPY.productNotSaved.why,
        action: { label: 'Réessayer', onPress: () => { /* everything typed is still in the sheet: tap Ajouter again */ } },
      }));
      return { ok: false };
    }
    let createdVariants: { id: string; name: string }[] = [];
    if (payload.hasVariants && payload.variants.length > 0) {
      const modelsOk = await upsertVariants(businessId, productId, userId, payload.variants);
      createdVariants = modelsOk ? await fetchVariants(productId, businessId) : [];
      if (createdVariants.length === 0) {
        toast.warning('Les modèles n\'ont pas pu être créés (connexion requise). Le produit est créé sans modèles.');
      }
    }
    updateLine(localId, linkedLinePatch({ productId, payload, createdVariants, fallbackQty: sheetTarget.qty, currency }));
    setSheetOpen(false);
    return { ok: true };
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
  function firstIssue(): { line: DraftLine; kind: 'name' | 'unlinked' | 'qty' | 'variant' } | null {
    if (!draft) return null;
    for (const l of draft.lines) {
      if (!l.name.trim()) return { line: l, kind: 'name' };
    }
    // A name without a product never reaches the server: it must be linked or created first.
    for (const l of draft.lines) {
      if (isUnlinkedNamedLine(l)) return { line: l, kind: 'unlinked' };
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
      if (isUnlinkedNamedLine(l)) return true;
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
      } else if (issue.kind === 'unlinked') {
        setFlagLinkId(issue.line.localId);
        toast.warning(`« ${issue.line.name.trim()} » n'est pas encore un produit : choisissez-le ou créez-le 👆`);
        setTimeout(() => setFlagLinkId(null), 2200);
      } else if (issue.kind === 'variant') {
        toast.warning('La répartition ne correspond pas à la quantité totale');
      } else {
        toast.warning('Un champ est incomplet — vérifiez la ligne en ambre 👆');
      }
      return;
    }
    haptics.success();
    setStep('recap');
  };

  // Confirming books a money record (stock, cost, transport): a second tap while
  // the first is in flight is swallowed, and the control shows it is working.
  const [confirming, runConfirm] = useInFlight();
  const handleConfirm = () => runConfirm(async () => {
    if (!draft) return;
    // A delivery line NEVER becomes a product by itself. If one slipped past the step gate, go back to it.
    const unlinked = draft.lines.find(isUnlinkedNamedLine);
    if (unlinked) {
      haptics.warning();
      setFlagLinkId(unlinked.localId);
      toast.warning(`« ${unlinked.name.trim()} » n'est pas encore un produit : choisissez-le ou créez-le 👆`);
      setStep('quoi');
      setTimeout(() => setFlagLinkId(null), 2200);
      return;
    }
    const rpcLines: ReceptionLine[] = [];
    for (const l of draft.lines) {
      // v221: blank cost → null (unknown), not 0.
      const unitCostDisplay = parseAmountInput(l.unitCost, currency);
      const unitCostCents = unitCostDisplay > 0 ? Math.round(unitCostDisplay * 100) : null;
      // "Je vends à": only a price she actually touched is booked. An untouched
      // prefill is a hint, not an instruction — it must never overwrite the
      // product's real sale_price (or invent one for a new product).
      const salePriceCents = l.salePriceTouched ? l.salePriceCents : null;

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
    // One key per confirmation, reused on every retry: the server books the
    // delivery once however many times it replays (migration_v229).
    if (!receptionKeyRef.current) receptionKeyRef.current = generateId();
    const key = receptionKeyRef.current;
    const poId = await confirmReception(businessId, userId, {
      supplierId: draft.supplierId, poId: draft.poId, lines: rpcLines,
      transportCostCents: transportCents, marginPercent: null,
      receivedDate: draft.receivedDate || null,
      idempotencyKey: key,
    });

    if (!poId) {
      // Only the phone's own storage can fail now (a dead zone no longer does):
      // the draft is untouched, so one tap tries again.
      haptics.error();
      failAlert('receptionNotRecorded', { label: 'Réessayer', onPress: () => { void handleConfirm(); } });
      return;
    }
    setReceptionKey(key);
    receptionKeyRef.current = null;

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
  });

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
          {step === 'quoi' ? 'Ce qui est arrivé.' : step === 'recap' ? 'C\'est tout bon ?' : 'Enregistré'}
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
          flagLinkId={flagLinkId}
          onCreateProduct={openProductSheet}
          onPickProduct={line => setPickerLineId(line.localId)}
          onLinkProduct={linkProduct}
          onAddLine={addLine}
          onRemoveLine={removeLine}
          onChangeSupplier={() => setShowSupplierPicker(true)}
          onDone={handleVerifyDone}
          styles={styles}
          palette={palette}
        />
      )}

      {step === 'recap' && (
        <RecapStep
          draft={draft}
          currency={currency}
          linesTotal={linesTotal}
          onUpdate={update}
          onBack={() => setStep('quoi')}
          onConfirm={handleConfirm}
          saving={saving || confirming}
          styles={styles}
          palette={palette}
        />
      )}

      {step === 'confirme' && (
        <ConfirmeStep
          draft={draft}
          currency={currency}
          linesTotal={linesTotal}
          pending={receptionPending}
          supplierName={confirmedSupplierName}
          onChangeSupplier={() => setShowSupplierPicker(true)}
          styles={styles}
          palette={palette}
        />
      )}

      <QuickAddProductSheet
        visible={sheetOpen}
        onClose={() => setSheetOpen(false)}
        businessId={businessId}
        onSubmit={createForLine}
        onPickExisting={p => {
          // The name she typed already belongs to a product: link it instead of creating a duplicate.
          setSheetOpen(false);
          if (sheetTarget) linkProduct(sheetTarget.localId, p);
        }}
        saving={productSaving}
        currency={currency}
        products={products}
        fournisseurs={fournisseurs}
        delivery={sheetTarget ? { name: sheetTarget.name, qty: sheetTarget.qty } : null}
      />

      <ProductPickerSheet
        visible={pickerLineId !== null}
        products={products}
        onSelect={p => { if (pickerLineId) linkProduct(pickerLineId, p); setPickerLineId(null); }}
        onClose={() => setPickerLineId(null)}
        styles={styles}
        palette={palette}
      />

      <SupplierPickerSheet
        visible={showSupplierPicker}
        fournisseurs={fournisseurs}
        businessId={businessId}
        userId={userId}
        onSelect={selectSupplier}
        onClose={() => setShowSupplierPicker(false)}
        styles={styles}
        palette={palette}
      />
    </Screen>
  );
}

// ─── Supplier picker (Écran 1 "De qui ?" chip + Confirmé chip) ───────────────

function SupplierPickerSheet({ visible, fournisseurs, businessId, userId, onSelect, onClose, styles, palette }: {
  visible: boolean;
  fournisseurs: Fournisseur[];
  businessId: string;
  userId: string;
  onSelect: (f: Fournisseur | null) => void;
  onClose: () => void;
  styles: ReturnType<typeof makeStyles>;
  palette: Palette;
}) {
  const { createFournisseur, saving: fSaving } = useFournisseursStore();
  const [showNewForm, setShowNewForm] = useState(false);
  const [newName, setNewName] = useState('');
  const [newPhone, setNewPhone] = useState('');

  const handleCreate = async () => {
    if (!newName.trim()) { appAlert('Ajoutez un nom'); return; }
    const supplierId = await createFournisseur(businessId, userId, { name: newName, phone: newPhone });
    if (supplierId) {
      haptics.success();
      const latest = useFournisseursStore.getState().fournisseurs.find(f => f.id === supplierId);
      if (latest) onSelect(latest);
      setShowNewForm(false);
      setNewName('');
      setNewPhone('');
    }
  };

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose} statusBarTranslucent navigationBarTranslucent>
      <SafeAreaView style={styles.pickerSafe} edges={['top', 'bottom']}>
        <View style={styles.pickerHeader}>
          <Text variant="h4">De qui ?</Text>
          <Pressable onPress={onClose} hitSlop={12}>
            <Text variant="body" color="secondary">Fermer</Text>
          </Pressable>
        </View>
        <ScrollView contentContainerStyle={styles.pad} keyboardShouldPersistTaps="handled">
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

          {!showNewForm ? (
            <Pressable onPress={() => setShowNewForm(true)} style={styles.addLineRow}>
              <Ionicons name="add-circle-outline" size={18} color={palette.primary} />
              <Text variant="label" style={{ color: palette.primary }}>+ Nouveau fournisseur</Text>
            </Pressable>
          ) : (
            <View style={styles.newSupplierForm}>
              <Input label="Nom *" value={newName} onChangeText={setNewName} placeholder="Alimentation, Électronique…" />
              <PhoneInput label="Téléphone (optionnel)" onChange={(e164) => setNewPhone(e164)} strict={false} />
              <View style={{ flexDirection: 'row', gap: spacing[2] }}>
                <Button label="Annuler" onPress={() => { setShowNewForm(false); setNewName(''); setNewPhone(''); }} variant="outline" style={{ flex: 1 }} />
                <Button label="Créer" loadingLabel="Création" onPress={handleCreate} loading={fSaving} style={{ flex: 1 }} disabled={!newName.trim()} />
              </View>
            </View>
          )}
        </ScrollView>
      </SafeAreaView>
    </Modal>
  );
}

// ─── Étape 1 : Ce qui est arrivé ─────────────────────────────────────────────

function QuoiStep({
  draft, currency, products, variantsByProduct, linesTotal,
  flagName, flagLinkId, scrollRef, lineRefs, onUpdateLine, onLinkProduct, onCreateProduct, onPickProduct, onAddLine, onRemoveLine,
  onChangeSupplier, onDone, styles, palette,
}: {
  draft: Draft; currency: string; products: Product[]; variantsByProduct: Record<string, { id: string; name: string }[]>;
  linesTotal: number; flagName: boolean; flagLinkId: string | null;
  onCreateProduct: (line: DraftLine) => void; onPickProduct: (line: DraftLine) => void;
  scrollRef: React.RefObject<ScrollView | null>; lineRefs: React.MutableRefObject<Record<string, View | null>>;
  onUpdateLine: (id: string, p: Partial<DraftLine>) => void;
  onLinkProduct: (id: string, product: Product) => void; onAddLine: () => void; onRemoveLine: (id: string) => void;
  onChangeSupplier: () => void;
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

        <Pressable onPress={onChangeSupplier} style={[styles.supplierChip, { alignSelf: 'flex-start' }]}>
          <Ionicons name="storefront-outline" size={14} color={palette.textSecondary} />
          <Text variant="caption" color="secondary">De : {draft.supplierName || '—'}</Text>
        </Pressable>

        {draft.lines.map(line => {
          const isNameIssue = flagName && !line.name.trim();
          const isLinkIssue = flagLinkId === line.localId;
          const unlinked = !line.product_id && line.name.trim().length > 0;
          const match = !line.product_id && line.name.trim().length > 1
            ? findCatalogueMatch(line.name, products)
            : undefined;

          return (
            <View
              key={line.localId}
              ref={r => { lineRefs.current[line.localId] = r; }}
              style={[styles.lineCard, (isNameIssue || isLinkIssue) && styles.lineCardWarn]}
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
                  <Pressable onPress={() => onCreateProduct(line)} accessibilityRole="button">
                    <Text variant="caption" color="secondary">Nouveau produit</Text>
                  </Pressable>
                </View>
              )}

              {/* No match, but a name: it is not a product yet. Resolve it here — never silently at confirm. */}
              {unlinked && !match && (
                <View style={styles.matchBanner}>
                  <Text variant="caption" style={{ color: isLinkIssue ? palette.warning : palette.textPrimary, flex: 1 }}>
                    Pas encore un produit.
                  </Text>
                  <Pressable onPress={() => onCreateProduct(line)} accessibilityRole="button" accessibilityLabel={`Créer le produit ${line.name.trim()}`}>
                    <Text variant="caption" style={{ color: palette.primary, fontFamily: fontFamily.semibold }}>Nouveau produit</Text>
                  </Pressable>
                  <Pressable onPress={() => onPickProduct(line)} accessibilityRole="button">
                    <Text variant="caption" style={{ color: palette.primary, fontFamily: fontFamily.semibold }}>Choisir un produit</Text>
                  </Pressable>
                </View>
              )}

              {line.hasVariants && line.variantSplits ? (
                <VariantSplitRow line={line} onUpdateLine={onUpdateLine} styles={styles} palette={palette} />
              ) : (
                <View style={styles.lineFieldsRow}>
                  <View style={{ flex: 1.6 }}>
                    <Text variant="caption" color="secondary">Quantité</Text>
                    <QuantityStepper
                      compact
                      value={line.qty}
                      onChange={v => onUpdateLine(line.localId, { qty: v })}
                      inputStyle={[styles.fieldInput, !parseQty(line.qty) && styles.fieldInputWarn, { color: palette.textPrimary, minHeight: 0 }]}
                      inputAccessoryViewID={ACCESSORY_ID}
                    />
                  </View>
                  <View style={{ flex: 1 }}>
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

              {!line.hasVariants && (
                <View style={{ gap: spacing[1] }}>
                  <Text variant="caption" color="secondary">Je vends à <Text variant="caption" color="secondary">(optionnel)</Text></Text>
                  <TextInput
                    value={line.salePriceInput}
                    onChangeText={v => {
                      const formatted = formatAmountInput(v, currency);
                      onUpdateLine(line.localId, {
                        salePriceInput: formatted,
                        salePriceCents: amountInputToCents(formatted, currency),
                        salePriceTouched: true,
                      });
                    }}
                    keyboardType="decimal-pad"
                    placeholder="Prix de vente"
                    placeholderTextColor={palette.textDisabled}
                    style={[styles.fieldInput, { color: palette.textPrimary }]}
                    inputAccessoryViewID={Platform.OS === 'ios' ? ACCESSORY_ID : undefined}
                  />
                </View>
              )}

              {parseQty(line.qty) && parseAmountInput(line.unitCost, currency) > 0 && !line.hasVariants && (
                <Text variant="caption" color="secondary">
                  Total : {formatAmount(parseQty(line.qty)! * parseAmountInput(line.unitCost, currency), currency)}
                </Text>
              )}

              {parseQty(line.qty) && !(parseAmountInput(line.unitCost, currency) > 0) && !line.hasVariants && (
                <Text variant="caption" color="secondary">
                  Prix inconnu — le prix de vente saisi sera quand même enregistré.
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
            <Text variant="label">{formatAmount(linesTotal, currency)}</Text>
          </View>
        </View>
      </ScrollView>

      <View style={styles.footer}>
        <Button label="Tout est bon ✓" onPress={onDone} fullWidth size="lg" />
      </View>
    </>
  );
}

// ─── Product picker ("Choisir un produit" on an unlinked line) ───────────────

function ProductPickerSheet({ visible, products, onSelect, onClose, styles, palette }: {
  visible: boolean; products: Product[]; onSelect: (p: Product) => void; onClose: () => void;
  styles: ReturnType<typeof makeStyles>; palette: Palette;
}) {
  const [q, setQ] = useState('');
  useEffect(() => { if (!visible) setQ(''); }, [visible]);
  const list = useMemo(() => {
    const n = normalizeName(q);
    const base = n ? products.filter(p => normalizeName(p.name).includes(n)) : products;
    return [...base].sort((a, b) => a.name.localeCompare(b.name, 'fr'));
  }, [products, q]);
  return (
    <FormSheet visible={visible} onClose={onClose} title="Choisir un produit" cancelLabel="Fermer" scrollable={false}>
      <View style={{ paddingHorizontal: spacing[5], paddingVertical: spacing[3] }}>
        <Input placeholder="Rechercher un produit…" value={q} onChangeText={setQ} />
      </View>
      <FlatList
        data={list}
        keyExtractor={p => p.id}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ paddingHorizontal: spacing[5], paddingBottom: spacing[8], gap: spacing[2] }}
        renderItem={({ item }) => (
          <Pressable
            onPress={() => onSelect(item)}
            style={({ pressed }) => [styles.pickerRow, pressed && { opacity: 0.65 }]}
            accessibilityRole="button"
            accessibilityLabel={`Choisir ${item.name}`}
          >
            <Text variant="body" numberOfLines={1} style={{ flex: 1, fontFamily: fontFamily.medium }}>{item.name}</Text>
            <Ionicons name="chevron-forward" size={16} color={palette.textDisabled} />
          </Pressable>
        )}
        ListEmptyComponent={<Text variant="body" color="secondary" style={{ textAlign: 'center', paddingTop: spacing[6] }}>Aucun produit.</Text>}
      />
    </FormSheet>
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
      <QuantityStepper
        value={line.qty}
        onChange={v => onUpdateLine(line.localId, { qty: v })}
        inputStyle={[styles.fieldInput, { color: palette.textPrimary, minHeight: 0 }]}
      />
      <Text variant="caption" color="secondary">Répartition par modèle</Text>
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

// ─── Étape 2 : C'est tout bon ? ───────────────────────────────────────────────
// Absorbs the old "Votre marge" step: transport + delivery date + confirm. The
// sale price is now typed per-line on Écran 1 ("Je vends à"), never derived
// from a global margin %.

function RecapStep({
  draft, currency, linesTotal, onUpdate, onBack, onConfirm, saving, styles, palette,
}: {
  draft: Draft; currency: string; linesTotal: number;
  onUpdate: (p: Partial<Draft>) => void;
  onBack: () => void; onConfirm: () => void; saving: boolean;
  styles: ReturnType<typeof makeStyles>; palette: Palette;
}) {
  return (
    <>
      <ScrollView contentContainerStyle={styles.pad} keyboardShouldPersistTaps="handled">
        <Pressable onPress={onBack} hitSlop={8} style={{ alignSelf: 'flex-start', marginBottom: spacing[3] }}>
          <Text variant="caption" color="secondary">‹ Revoir les produits</Text>
        </Pressable>

        <Text variant="h2">C'est tout bon ?</Text>

        <View style={styles.checkCard}>
          <View style={styles.checkRow}>
            <Text variant="label">Total</Text>
            <Text variant="label">{formatAmount(linesTotal, currency)}</Text>
          </View>
        </View>

        <View style={{ marginTop: spacing[4], gap: spacing[2] }}>
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
      </ScrollView>

      <View style={styles.footer}>
        <Button label="Confirmer la livraison" loadingLabel="Enregistrement" onPress={onConfirm} loading={saving} fullWidth size="lg" />
      </View>
    </>
  );
}

// ─── Étape 3 : Confirmé ──────────────────────────────────────────────────────

function ConfirmeStep({ draft, currency, linesTotal, pending, supplierName, onChangeSupplier, styles, palette }: {
  draft: Draft; currency: string; linesTotal: number; pending: boolean; supplierName: string; onChangeSupplier: () => void;
  styles: ReturnType<typeof makeStyles>; palette: Palette;
}) {
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
        stock mis à jour · Total {formatAmount(linesTotal, currency)}
      </Text>
      {pending && (
        <Text variant="caption" color="secondary" style={{ textAlign: 'center' }}>
          Pas encore envoyée. Elle partira dès que le téléphone sera connecté.
        </Text>
      )}

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
    pickerRow: { flexDirection: 'row', alignItems: 'center', gap: spacing[3], paddingHorizontal: spacing[4], paddingVertical: spacing[3.5], borderRadius: radius.card, backgroundColor: p.surface },
    addLineRow: { flexDirection: 'row', alignItems: 'center', gap: spacing[2], paddingVertical: spacing[3] },
    checkCard: {
      borderRadius: radius.card, borderWidth: 1, borderColor: p.border,
      backgroundColor: p.background, padding: spacing[4], gap: spacing[2],
    },
    checkRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
    variantGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing[2] },
    variantCell: { gap: spacing[1], minWidth: 70 },

    // Supplier picker — inline "Nouveau fournisseur" form
    newSupplierForm: { gap: spacing[3], paddingTop: spacing[2] },

    // Confirmé
    confirmWrap: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing[8], gap: spacing[3] },
    confirmCheck: {
      width: 72, height: 72, borderRadius: 36, backgroundColor: p.success,
      alignItems: 'center', justifyContent: 'center', marginBottom: spacing[3],
    },
  });
}
