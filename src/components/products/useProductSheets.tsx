import React, { useCallback, useEffect, useRef, useState } from 'react';
import { QuickAddProductSheet } from '@/src/components/QuickAddProductSheet';
import { ProductStatsModal, StockAdjustModal } from '@/src/components/products/ProductSubSheets';
import { failAlert, showFailureAlert } from '@/src/components/ui/FailureView';
import { appAlert } from '@/src/utils/appAlert';
import { useSaveConfirmationStore } from '@/stores/saveConfirmation';
import { archivedConfirmation } from '@/src/utils/saveConfirmationCopy';
import { isKnownOffline } from '@/lib/connectivity';
import { haptics } from '@/lib/haptics';
import { toast } from '@/stores/toast';
import { useAuthStore } from '@/stores/auth';
import { useProductStore } from '@/stores/products';
import { useFournisseursStore } from '@/stores/fournisseurs';
import { activationPriming } from '@/stores/activationPriming';
import { buildFailure, failureReason } from '@/src/utils/failure';
import { FAILURE_COPY } from '@/src/utils/failureCopy';
import type { Product, ProductVariant } from '@/src/types';
import type { QuickAddPayload } from '@/src/utils/quickAddProduct';
import { removeQuickAddDraft, type QuickAddDraft } from '@/lib/quickAddDraft';

/** What Vendre (sell mode) and the Gérer view call to open the product sheets. */
export interface ProductSheetsApi {
  openAdd: (prefillName?: string) => void;
  /** `expandCost`: open with "Plus d'informations" already expanded (the "Prix d'achat ?" affordance). */
  openEdit: (product: Product, opts?: { expandCost?: boolean }) => void;
  openAdjust: (product: Product) => void;
  openStats: (product: Product) => void;
  /** Reopen an "À compléter" draft in the add sheet. */
  resumeDraft: (draft: QuickAddDraft) => void;
  /** Id of the product just added from the sheet — its tile/row pulses once. */
  pulseId: string | null;
  /** Bumps whenever drafts may have changed (a sheet closed) so "À compléter" re-reads them. */
  draftsVersion: number;
  /** True while ANY product sheet is open — the single derived state the floating buttons hide on. */
  anySheetOpen: boolean;
}

/**
 * The add / edit / stock-adjust / stats sheets, owned by whichever screen hosts the product surface
 * (Vendre). Returns the api plus the elements to render once. Every write goes through the product
 * store, i.e. the outbox with client-generated ids, so all of it works offline and the grid shows the
 * change immediately.
 */
export function useProductSheets(): { api: ProductSheetsApi; sheets: React.ReactElement } {
  const session = useAuthStore(s => s.session);
  const businessId = session?.activeBusiness?.id ?? '';
  const userId = session?.user.id ?? '';
  const currency = session?.activeBusiness?.currency ?? 'GNF';
  const { products, saving, variantsByProduct, createProduct, updateProduct, upsertVariants, adjustStock, fetchVariants, fetchProductStats, archiveProduct, restoreProduct } = useProductStore();
  const fournisseurs = useFournisseursStore(s => s.fournisseurs);
  const fetchFournisseurs = useFournisseursStore(s => s.fetchFournisseurs);
  const role = session?.activeMembership?.role;
  const canEdit = role === 'administrateur' || role === 'manager';
  // The edit sheet's "Fournisseur" chips need the list; only managers can open that sheet.
  useEffect(() => { if (businessId && canEdit) void fetchFournisseurs(businessId); }, [businessId, canEdit]);

  const [addOpen, setAddOpen] = useState(false);
  const [prefill, setPrefill] = useState<string | undefined>(undefined);
  const [resume, setResume] = useState<QuickAddDraft | null>(null);
  const [resumeEdit, setResumeEdit] = useState<QuickAddDraft | null>(null);
  const [editOpen, setEditOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<Product | null>(null);
  const [editExpand, setEditExpand] = useState(false);
  const [editVariants, setEditVariants] = useState<ProductVariant[]>([]);
  const [adjustTarget, setAdjustTarget] = useState<Product | null>(null);
  const [adjustOpen, setAdjustOpen] = useState(false);
  const [statsTarget, setStatsTarget] = useState<Product | null>(null);
  const [statsOpen, setStatsOpen] = useState(false);
  const [pulseId, setPulseId] = useState<string | null>(null);
  const [draftsVersion, setDraftsVersion] = useState(0);
  const addedCount = useRef(0);

  useEffect(() => {
    if (!pulseId) return;
    const t = setTimeout(() => setPulseId(null), 1600);
    return () => clearTimeout(t);
  }, [pulseId]);

  // Edit of a variant product: its models are loaded (cache first) before the sheet needs them.
  useEffect(() => {
    if (!editTarget?.has_variants || !businessId) { setEditVariants([]); return; }
    const cached = variantsByProduct[editTarget.id];
    if (cached) setEditVariants(cached);
    else void fetchVariants(editTarget.id, businessId).then(setEditVariants);
  }, [editTarget?.id, businessId]);

  const modelsNotSavedAlert = () => {
    haptics.error();
    showFailureAlert(buildFailure({
      what: FAILURE_COPY.productSavedModelsNot.what,
      action: { label: 'OK', onPress: () => {} },
    }));
  };

  const handleAdd = useCallback(
    async ({ data, hasVariants, variants }: QuickAddPayload): Promise<{ ok: boolean }> => {
      const ok = await createProduct(businessId, userId, data);
      if (!ok) {
        haptics.error();
        showFailureAlert(buildFailure({
          what: FAILURE_COPY.productNotSaved.what,
          why: failureReason(useProductStore.getState().error) ?? FAILURE_COPY.productNotSaved.why,
          action: { label: 'Réessayer', onPress: () => { /* the sheet kept everything typed: tap Ajouter again */ } },
        }));
        return { ok: false };
      }
      const nameLower = data.name.trim().toLowerCase();
      const created = useProductStore.getState().products.find(p => p.name.trim().toLowerCase() === nameLower) ?? null;
      if (created && hasVariants && variants.length > 0) {
        // Online-only call. Never assume it ran: the product is already queued, so say exactly that.
        const variantsOk = isKnownOffline() ? false : await upsertVariants(businessId, created.id, userId, variants);
        if (!variantsOk) modelsNotSavedAlert();
      }
      if (created) setPulseId(created.id);
      addedCount.current += 1;
      return { ok: true };
    },
    [businessId, userId, createProduct, upsertVariants],
  );

  const handleEdit = useCallback(
    async ({ data, hasVariants, variants }: QuickAddPayload): Promise<{ ok: boolean; modelsPending?: boolean }> => {
      if (!editTarget) return { ok: false };
      const ok = await updateProduct(businessId, userId, editTarget.id, data);
      // The models RPC is online-only: touch it ONLY when models are involved (set now, or being
      // switched off), so editing a plain product offline goes through the outbox and just works.
      const touchesModels = hasVariants || !!editTarget.has_variants;
      if (!ok) {
        haptics.error();
        showFailureAlert(buildFailure({
          what: FAILURE_COPY.productNotSaved.what,
          why: failureReason(useProductStore.getState().error) ?? FAILURE_COPY.productNotSaved.why,
          action: { label: 'Réessayer', onPress: () => { /* the sheet kept everything typed: tap Enregistrer again */ } },
        }));
        return { ok: false };
      }
      if (touchesModels) {
        const variantsOk = isKnownOffline() ? false : await upsertVariants(businessId, editTarget.id, userId, hasVariants ? variants : []);
        if (!variantsOk) {
          // The product edit is queued; only the online-only models call did not run.
          modelsNotSavedAlert();
          setEditOpen(false);
          // The product edit is saved, the models change is NOT: the sheet must keep its edit draft so
          // those unsaved model changes survive (it would otherwise delete the draft on success).
          return { ok: true, modelsPending: true };
        }
      }
      toast.success('Produit mis à jour ✓');
      setEditOpen(false);
      return { ok: true };
    },
    [editTarget, businessId, userId, updateProduct, upsertVariants],
  );

  const handleAdjust = useCallback(
    async (qty: number, type: 'entree' | 'perte', note: string) => {
      if (!adjustTarget) return;
      const ok = await adjustStock(adjustTarget.id, businessId, userId, qty, type, note);
      if (ok) {
        setAdjustOpen(false);
        toast.success('Stock ajusté ✓');
      } else {
        haptics.error();
        toast.warning(useProductStore.getState().error ?? "Erreur d'ajustement");
      }
    },
    [adjustTarget, businessId, userId, adjustStock],
  );

  // Archive / restore live in the edit sheet (Gérer rows have no buttons). Both go through the outbox, so
  // they work offline and the lists move at once.
  const handleArchive = useCallback((p: Product) => {
    appAlert(
      'Archiver ce produit ?',
      `"${p.name}" ne sera plus proposé à la vente. Vous pourrez le restaurer depuis Gérer.`,
      [
        { text: 'Annuler', style: 'cancel' },
        {
          text: 'Archiver', style: 'destructive',
          onPress: async () => {
            const done = await archiveProduct(p.id, businessId);
            if (!done) {
              haptics.error();
              failAlert('productNotArchived', {
                err: useProductStore.getState().error, label: 'Réessayer',
                onPress: () => { void archiveProduct(p.id, businessId); },
              });
              return;
            }
            haptics.destructive();
            setEditOpen(false);
            // Archiving is a flag flip, so it can be undone: Annuler = restoreProduct.
            useSaveConfirmationStore.getState().show({
              message: archivedConfirmation(p.name),
              tone: 'success',
              undo: async () => { await restoreProduct(p.id, businessId, userId); },
            });
          },
        },
      ],
    );
  }, [archiveProduct, restoreProduct, businessId, userId]);

  const handleRestore = useCallback(async (p: Product) => {
    await restoreProduct(p.id, businessId, userId);
    haptics.success();
    setEditOpen(false);
    toast.success(`${p.name} restauré ✓`);
  }, [restoreProduct, businessId, userId]);

  const api: ProductSheetsApi = {
    openAdd: name => { setResume(null); setPrefill(name); setAddOpen(true); },
    openEdit: (p, opts) => { setResumeEdit(null); setEditTarget(p); setEditExpand(!!opts?.expandCost); setEditOpen(true); },
    openAdjust: p => { setAdjustTarget(p); setAdjustOpen(true); },
    openStats: p => { setStatsTarget(p); setStatsOpen(true); },
    resumeDraft: d => {
      if (d.kind === 'edit') {
        // Unsaved changes to an existing product: reopen THAT product's edit sheet with the draft restored.
        const product = products.find(p => p.id === d.productId);
        if (!product) {
          // The product is gone (archived elsewhere / deleted): the draft has nothing to apply to.
          void removeQuickAddDraft(businessId, d.id).catch(() => {}); // failure: silent — local draft only
          setDraftsVersion(v => v + 1);
          return;
        }
        setResumeEdit(d); setEditTarget(product); setEditExpand(false); setEditOpen(true);
        return;
      }
      setPrefill(undefined); setResume(d); setAddOpen(true);
    },
    pulseId,
    draftsVersion,
    anySheetOpen: addOpen || editOpen || adjustOpen || statsOpen,
  };

  const sheets = (
    <>
      <QuickAddProductSheet
        visible={addOpen}
        onClose={() => {
          setAddOpen(false);
          setPrefill(undefined);
          setDraftsVersion(v => v + 1);
          // First value moment: fire once the loop ends, not over the open sheet.
          if (addedCount.current > 0) { addedCount.current = 0; activationPriming.maybeTrigger(); }
        }}
        businessId={businessId}
        onSubmit={handleAdd}
        onPickExisting={p => {
          setAddOpen(false);
          setPrefill(undefined);
          // Open the EXISTING product for editing instead of creating a duplicate.
          setTimeout(() => { setEditTarget(p); setEditExpand(false); setEditOpen(true); }, 350);
        }}
        saving={saving}
        currency={currency}
        products={products}
        fournisseurs={fournisseurs}
        initialName={prefill}
        resumeDraft={resume}
      />
      <QuickAddProductSheet
        visible={editOpen}
        onClose={() => { setEditOpen(false); setResumeEdit(null); setDraftsVersion(v => v + 1); }}
        businessId={businessId}
        onSubmit={handleEdit}
        onPickExisting={() => {}}
        saving={saving}
        currency={currency}
        products={products}
        fournisseurs={fournisseurs}
        editing={editTarget}
        resumeEditDraft={resumeEdit}
        initialVariants={editVariants}
        startExpanded={editExpand}
        onAdjust={p => {
          // One sheet at a time: close the edit sheet, then open the stock adjustment.
          setEditOpen(false);
          setTimeout(() => { setAdjustTarget(p); setAdjustOpen(true); }, 350);
        }}
        onArchive={handleArchive}
        onRestore={p => { void handleRestore(p); }}
        onStats={p => {
          setEditOpen(false);
          setTimeout(() => { setStatsTarget(p); setStatsOpen(true); }, 350);
        }}
      />
      <StockAdjustModal
        visible={adjustOpen}
        product={adjustTarget}
        onClose={() => setAdjustOpen(false)}
        onConfirm={handleAdjust}
        saving={saving}
        currency={currency}
      />
      <ProductStatsModal
        visible={statsOpen}
        product={statsTarget}
        onClose={() => setStatsOpen(false)}
        businessId={businessId}
        currency={currency}
        fetchStats={fetchProductStats}
      />
    </>
  );

  return { api, sheets };
}
