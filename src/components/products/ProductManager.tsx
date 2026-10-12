import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Animated, FlatList, Pressable, RefreshControl, StyleSheet, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { EmptyState } from '@/src/components/ui/EmptyState';
import { Input } from '@/src/components/ui/Input';
import { NoResultsState } from '@/src/components/ui/NoResultsState';
import { OfflineNotice } from '@/src/components/ui/OfflineNotice';
import { SkeletonList } from '@/src/components/ui/SkeletonPlaceholder';
import { Text } from '@/src/components/ui/Text';
import { useTheme, radius, spacing, fontFamily as FF, FLOATING_TAB_BAR_CLEARANCE, floatingTabBarClearance, SEARCH_VISIBILITY_THRESHOLD } from '@/src/theme';
import type { Palette } from '@/src/theme';
import type { Product, ProductVariant } from '@/src/types';
import { useAuthStore } from '@/stores/auth';
import { useProductStore } from '@/stores/products';
import { haptics } from '@/lib/haptics';
import { getKV, setKV } from '@/lib/db';
import { listQuickAddDrafts, removeQuickAddDraft, type QuickAddDraft } from '@/lib/quickAddDraft';
import { formatAmountValue } from '@/src/utils/format';
import { needsPurchasePrice, needsSalePrice } from '@/src/utils/quickAddProduct';
import { buildGererSections, productPieces, type GererSection } from '@/src/utils/gererSections';
import type { ProductSheetsApi } from '@/src/components/products/useProductSheets';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

// Gérer mode: plain rows. À compléter (pending drafts, only when there are some) · ONE "Produits" list ·
// a quiet "Archivés (n)" link at the bottom. No cards, no tabs, no switches, no per-row buttons: tapping a row opens the add/edit sheet, which owns edit, "Ajuster",
// archiver / restaurer. Everything renders from the local product store (cache + queued ops), so it
// works offline and every change shows at once.

interface ProductManagerProps {
  sheets: ProductSheetsApi;
  /** Back to the sell grid ("< Vendre" and "Terminé" both do this). */
  onExit: () => void;
}

const GERER_HINT_KEY = (userId: string) => `gerer_hint_seen_${userId}`;

// ─── Row ──────────────────────────────────────────────────────────────────────

function ManagerRow({ product, variants, currency, archived, canEdit, pulse, onPress }: {
  product: Product; variants?: ProductVariant[]; currency: string; archived: boolean; canEdit: boolean;
  pulse: boolean; onPress: () => void;
}) {
  const { palette } = useTheme();
  const styles = useMemo(() => makeStyles(palette), [palette]);
  const pcs = productPieces(product, variants);
  const noPrice = needsSalePrice(product);
  const costMissing = canEdit && !archived && !product.has_variants && needsPurchasePrice(product);

  // Brief highlight for a product just added from the sheet.
  const pulseAnim = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (!pulse) return;
    pulseAnim.setValue(1);
    Animated.timing(pulseAnim, { toValue: 0, duration: 1400, useNativeDriver: true }).start();
  }, [pulse, pulseAnim]);

  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [styles.row, pressed && { opacity: 0.65 }, archived && { opacity: 0.7 }]}
      accessibilityRole="button"
      accessibilityLabel={`Modifier ${product.name}`}
    >
      <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, { backgroundColor: palette.primaryLight, opacity: pulseAnim }]} />
      <View style={{ flex: 1, gap: 2 }}>
        <Text variant="body" numberOfLines={1} style={{ fontFamily: FF.medium }}>{product.name}</Text>
        <Text variant="caption" color="secondary" numberOfLines={1}>
          {pcs !== null ? `${pcs} pcs` : 'Modèles'}
          {' · '}
          {noPrice
            ? <Text variant="caption" style={{ color: palette.primary }}>Prix à fixer</Text>
            : `${formatAmountValue(product.sale_price, currency)} ${currency.toLowerCase()}`}
          {costMissing ? ' · Prix d\'achat ?' : ''}
        </Text>
      </View>
      <Ionicons name="chevron-forward" size={16} color={palette.textDisabled} />
    </Pressable>
  );
}

// ─── Gérer ────────────────────────────────────────────────────────────────────

type Item =
  | { kind: 'header'; key: string; section: GererSection }
  | { kind: 'row'; key: string; product: Product; archived: boolean };

/** A pending draft, in the same visual language as a product row (name + subtext), × deletes it. */
function DraftRow({ draft, currency, onResume, onDelete }: { draft: QuickAddDraft; currency: string; onResume: () => void; onDelete: () => void }) {
  const { palette } = useTheme();
  const styles = useMemo(() => makeStyles(palette), [palette]);
  const name = draft.state.name.trim() || 'Sans nom'; // defence only: nameless add drafts are never persisted
  return (
    <View style={styles.row}>
      <Pressable style={{ flex: 1, gap: 2 }} onPress={onResume} accessibilityRole="button" accessibilityLabel={`Reprendre ${name}`}>
        <Text variant="body" numberOfLines={1} style={{ fontFamily: FF.medium }}>{name}</Text>
        <Text variant="caption" color="secondary" numberOfLines={1}>
          {draft.kind === 'edit' ? 'Modifications non enregistrées' : draft.state.price.trim() ? `${draft.state.price} ${currency.toLowerCase()}` : 'Prix à fixer'}
        </Text>
      </Pressable>
      <Pressable onPress={onDelete} hitSlop={12} accessibilityRole="button" accessibilityLabel={`Supprimer le brouillon ${name}`}>
        <Ionicons name="close-circle" size={20} color={palette.textDisabled} />
      </Pressable>
    </View>
  );
}

export function ProductManager({ sheets, onExit }: ProductManagerProps) {
  const insets = useSafeAreaInsets();
  const tabClearance = floatingTabBarClearance(insets.bottom); // live inset, not the bare constant
  const { palette } = useTheme();
  const styles = useMemo(() => makeStyles(palette), [palette]);
  const session = useAuthStore(s => s.session);
  const business = session?.activeBusiness;
  const userId = session?.user.id ?? '';
  const businessId = business?.id ?? '';
  const currency = business?.currency ?? 'GNF';
  const role = session?.activeMembership?.role;
  const canEdit = role === 'administrateur' || role === 'manager';

  const { products, archivedProducts, variantsByProduct, loading, offline, offlineSince, fetchProducts, fetchArchivedProducts, fetchVariants } =
    useProductStore();

  const [search, setSearch] = useState('');
  const [refreshing, setRefreshing] = useState(false);

  // "À compléter": half-filled products kept by the quick-add sheet (max 3, local only).
  const [drafts, setDrafts] = useState<QuickAddDraft[]>([]);
  const [archivesOpen, setArchivesOpen] = useState(false); // "Archivés (n)" starts collapsed
  useEffect(() => {
    if (!businessId) return;
    void listQuickAddDrafts(businessId).then(setDrafts).catch(() => setDrafts([])); // failure: silent — no drafts shown
  }, [businessId, sheets.draftsVersion]);
  const deleteDraft = (d: QuickAddDraft) => {
    haptics.select();
    setDrafts(prev => prev.filter(x => x.id !== d.id));
    void removeQuickAddDraft(businessId, d.id).catch(() => {}); // failure: silent — it is only a local draft
  };

  // One-time hint on the first Gérer open: dismissible forever.
  const [hintVisible, setHintVisible] = useState(false);
  useEffect(() => {
    if (!userId) return;
    void getKV(GERER_HINT_KEY(userId)).then(v => { if (!v) setHintVisible(true); }).catch(() => {}); // failure: silent — hint is cosmetic
  }, [userId]);
  const dismissHint = () => {
    setHintVisible(false);
    if (userId) void setKV(GERER_HINT_KEY(userId), '1').catch(() => {}); // failure: silent — worst case it shows once more
  };

  // The archived section reads the local cache first (see the store), so it is there offline too.
  useEffect(() => {
    if (businessId) void fetchArchivedProducts(businessId);
  }, [businessId]);

  useEffect(() => {
    if (!businessId || products.length === 0) return;
    products.filter(p => p.has_variants && !variantsByProduct[p.id])
      .forEach(p => fetchVariants(p.id, businessId));
  }, [products, businessId]);

  const onRefresh = useCallback(async () => {
    if (!businessId) return;
    setRefreshing(true);
    await Promise.all([
      fetchProducts(businessId, userId, session?.activeMembership?.id, session?.activeMembership?.role),
      fetchArchivedProducts(businessId),
    ]);
    setRefreshing(false);
  }, [businessId, userId]);

  const { sections, archives, total } = useMemo(
    () => buildGererSections({ products, archived: archivedProducts, query: search }),
    [products, archivedProducts, search],
  );

  const data = useMemo<Item[]>(() => sections.flatMap<Item>(sec => [
    { kind: 'header', key: `h-${sec.key}`, section: sec },
    ...sec.products.map<Item>(p => ({ kind: 'row', key: `${sec.key}-${p.id}`, product: p, archived: false })),
  ]), [sections]);

  const searchVisible = total >= SEARCH_VISIBILITY_THRESHOLD;
  useEffect(() => { if (!searchVisible) setSearch(''); }, [searchVisible]);

  const nothingAtAll = products.length === 0 && archivedProducts.length === 0;

  const header = (
    <>
      {hintVisible && (
        <View style={styles.hintBanner}>
          <Ionicons name="information-circle-outline" size={16} color={palette.textSecondary} />
          <Text variant="caption" color="secondary" style={{ flex: 1 }}>Astuce : restez appuyé sur un produit pour le modifier</Text>
          <Pressable onPress={dismissHint} hitSlop={10} accessibilityRole="button" accessibilityLabel="Fermer l'astuce">
            <Ionicons name="close" size={18} color={palette.textSecondary} />
          </Pressable>
        </View>
      )}

      {/* À compléter (n): plain rows, only when something is waiting. Max 3, newest first. */}
      {drafts.length > 0 && (
        <>
          <Text style={styles.sectionHeader}>{`À compléter (${drafts.length})`}</Text>
          {drafts.map((d, i) => (
            <React.Fragment key={d.id}>
              {i > 0 && <View style={styles.separator} />}
              <DraftRow draft={d} currency={currency} onResume={() => sheets.resumeDraft(d)} onDelete={() => deleteDraft(d)} />
            </React.Fragment>
          ))}
        </>
      )}

      {searchVisible && (
        <View style={styles.searchRow}>
          <Input placeholder="Rechercher un produit…" value={search} onChangeText={setSearch} />
        </View>
      )}
    </>
  );

  return (
    <View style={{ flex: 1 }}>
      {offline && (
        <OfflineNotice offlineSince={offlineSince} onRetry={() => fetchProducts(businessId, userId, session?.activeMembership?.id, session?.activeMembership?.role)} />
      )}

      {/* Header: "< Vendre" · Gérer · Terminé. */}
      <View style={styles.header}>
        <Pressable onPress={onExit} style={styles.headerSide} hitSlop={10} accessibilityRole="button" accessibilityLabel="Retour à Vendre">
          <Ionicons name="chevron-back" size={18} color={palette.primary} />
          <Text variant="body" style={{ color: palette.primary }}>Vendre</Text>
        </Pressable>
        <Text variant="h4" style={styles.headerTitle}>Gérer</Text>
        <Pressable onPress={onExit} style={[styles.headerSide, { justifyContent: 'flex-end' }]} hitSlop={10} accessibilityRole="button" accessibilityLabel="Terminer">
          <Text variant="body" style={{ color: palette.primary, fontFamily: FF.semibold }}>Terminé</Text>
        </Pressable>
      </View>

      {loading && nothingAtAll && !offline ? (
        <SkeletonList count={8} />
      ) : nothingAtAll ? (
        <>
          {header}
          <EmptyState
            icon="cube-outline"
            title="Aucun produit pour le moment."
            subtitle="Ajoutez ce que vous vendez pour aller plus vite à la caisse."
            actionLabel="+ Ajouter un produit"
            onAction={() => sheets.openAdd()}
          />
        </>
      ) : (
        <FlatList
          style={{ flex: 1 }}
          data={data}
          keyExtractor={i => i.key}
          ListHeaderComponent={header}
          renderItem={({ item }) => item.kind === 'header' ? (
            <Text style={styles.sectionHeader}>{item.section.label}</Text>
          ) : (
            <ManagerRow
              product={item.product}
              variants={variantsByProduct[item.product.id]}
              currency={currency}
              archived={item.archived}
              canEdit={canEdit}
              pulse={sheets.pulseId === item.product.id}
              // Rows open the one add/edit sheet. A product missing its purchase price opens straight on the cost field.
              onPress={() => sheets.openEdit(item.product, { expandCost: canEdit && !item.archived && !item.product.has_variants && needsPurchasePrice(item.product) && !needsSalePrice(item.product) })}
            />
          )}
          ItemSeparatorComponent={() => <View style={styles.separator} />}
          ListEmptyComponent={
            search.trim() && archives.length === 0
              ? <NoResultsState query={search} createLabel={`+ Nouveau produit « ${search.trim()} »`} onCreate={() => sheets.openAdd(search.trim())} />
              : products.length === 0
                ? <Text variant="caption" color="secondary" style={{ textAlign: 'center', paddingTop: spacing[6] }}>Aucun produit pour le moment.</Text>
                : null
          }
          // Archived products stay out of the way: a muted link at the bottom, collapsed until tapped.
          ListFooterComponent={archives.length > 0 ? (
            <>
              <Pressable onPress={() => { haptics.select(); setArchivesOpen(v => !v); }} style={styles.archivesLink} accessibilityRole="button" accessibilityState={{ expanded: archivesOpen }}>
                <Text variant="caption" color="secondary">{`Archivés (${archives.length})`}</Text>
                <Ionicons name={archivesOpen ? 'chevron-up' : 'chevron-down'} size={14} color={palette.textDisabled} />
              </Pressable>
              {archivesOpen && archives.map((p, i) => (
                <React.Fragment key={p.id}>
                  {i > 0 && <View style={styles.separator} />}
                  <ManagerRow
                    product={p}
                    variants={variantsByProduct[p.id]}
                    currency={currency}
                    archived
                    canEdit={canEdit}
                    pulse={false}
                    onPress={() => sheets.openEdit(p)}
                  />
                </React.Fragment>
              ))}
            </>
          ) : null}
          contentContainerStyle={{ paddingBottom: tabClearance + spacing[16] }}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={palette.primary} colors={[palette.primary]} />}
        />
      )}

      {/* Floating "+" — hidden whenever any sheet is open (single derived state). */}
      {canEdit && !nothingAtAll && !sheets.anySheetOpen && (
        <View style={[styles.fabContainer, { bottom: tabClearance + spacing[4] }]}>
          <Pressable hitSlop={12}
            onPress={() => sheets.openAdd()}
            style={({ pressed }) => [styles.fab, pressed && { opacity: 0.82 }]}
            accessibilityLabel="Ajouter un produit"
            accessibilityRole="button"
          >
            <Ionicons name="add" size={26} color={palette.textInverse} />
          </Pressable>
        </View>
      )}
    </View>
  );
}

function makeStyles(p: Palette) {
  return StyleSheet.create({
    header: {
      flexDirection: 'row', alignItems: 'center',
      paddingHorizontal: spacing[5], paddingTop: spacing[3], paddingBottom: spacing[2],
    },
    headerSide: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 2 },
    headerTitle: { textAlign: 'center' },
    archivesLink: {
      flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: spacing[1],
      paddingVertical: spacing[5],
    },
    hintBanner: {
      flexDirection: 'row', alignItems: 'center', gap: spacing[2],
      marginHorizontal: spacing[4], marginBottom: spacing[3], paddingHorizontal: spacing[4], paddingVertical: spacing[2.5],
      borderRadius: radius.card, backgroundColor: p.surface,
    },
    sectionHeader: {
      fontFamily: FF.semibold, fontSize: 11, color: p.textSecondary, letterSpacing: 0.6, textTransform: 'uppercase',
      paddingHorizontal: spacing[5], paddingTop: spacing[5], paddingBottom: spacing[2],
    },
    searchRow: { paddingHorizontal: spacing[5], paddingBottom: spacing[3] },
    row: {
      flexDirection: 'row', alignItems: 'center', gap: spacing[3],
      paddingHorizontal: spacing[5], paddingVertical: spacing[3.5], backgroundColor: p.surface,
    },
    separator: { height: StyleSheet.hairlineWidth, backgroundColor: p.border, marginLeft: spacing[5] },
    fabContainer: { position: 'absolute', right: spacing[5], bottom: FLOATING_TAB_BAR_CLEARANCE + spacing[4] },
    fab: {
      width: 52, height: 52, borderRadius: radius.full, alignItems: 'center', justifyContent: 'center',
      backgroundColor: p.primary,
    },
  });
}
