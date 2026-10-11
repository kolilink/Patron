import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ConfirmSheetHost } from '@/src/components/ui/ConfirmSheet';
import { appAlert } from '@/src/utils/appAlert';
import { AnimatedRowCell, AnimatedRow } from '@/src/components/ui/AnimatedRow';
import { markRowRemoved } from '@/src/utils/rowMotion';
import { Animated, FlatList, InputAccessoryView, Keyboard, Modal, Platform, Pressable, RefreshControl, ScrollView, StyleSheet, Switch, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { EmptyState } from '@/src/components/ui/EmptyState';
import { Input } from '@/src/components/ui/Input';
import { NoResultsState } from '@/src/components/ui/NoResultsState';
import { Pill } from '@/src/components/ui/Pill';
import { Text } from '@/src/components/ui/Text';
import { Ionicons } from '@expo/vector-icons';
import { useTheme, radius, spacing, shadow, fontFamily as FF, FLOATING_TAB_BAR_CLEARANCE, SEARCH_VISIBILITY_THRESHOLD } from '@/src/theme';
import { useAnimateLayoutChange } from '@/src/hooks/useAnimateLayoutChange';
import type { Palette } from '@/src/theme';
import type { Product, ProductVariant } from '@/src/types';
import { useAuthStore } from '@/stores/auth';
import { useProductStore } from '@/stores/products';
import { useSaveConfirmationStore } from '@/stores/saveConfirmation';
import { haptics } from '@/lib/haptics';
import { getKV, setKV } from '@/lib/db';
import { listQuickAddDrafts, removeQuickAddDraft, type QuickAddDraft } from '@/lib/quickAddDraft';
import { needsPurchasePrice, needsSalePrice } from '@/src/utils/quickAddProduct';
import type { ProductSheetsApi } from '@/src/components/products/useProductSheets';
import { LoadingStatus } from '@/src/components/ui/LoadingStatus';
import { formatAmount, formatAmountInput, parseAmountInput, formatAmountValue, formatSignedAmount } from '@/src/utils/format';
import { OfflineNotice } from '@/src/components/ui/OfflineNotice';
import { SkeletonList } from '@/src/components/ui/SkeletonPlaceholder';
import { failAlert } from '@/src/components/ui/FailureView';
import { archivedConfirmation } from '@/src/utils/saveConfirmationCopy';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatPrice(amount: number, currency: string) {
  return formatAmount(amount, currency);
}

// List rows show the bare number — the currency is declared once above the
// list instead of repeated on every row (see the "Prix (devise)" header).
function formatPriceValue(amount: number, currency: string) {
  return formatAmountValue(amount, currency);
}


const STOCK_ADJUST_ACCESSORY_ID = 'catalogue-stock-adjust-silent-accessory';

// ─── Product Row ──────────────────────────────────────────────────────────────

interface ProductRowProps {
  product: Product;
  currency: string;
  onPress: () => void;
  onLongPress?: () => void;
  archived?: boolean;
  /** Only meaningful when product.has_variants — undefined while still loading. */
  variants?: ProductVariant[];
  /** Deactivate call in flight: the row shows "Désactivation…" and ignores taps. */
  archiving?: boolean;
  /** Draft principle: a product born without a purchase price stays sellable; this opens the full form to complete it. */
  onFixPrice?: () => void;
  /** Purchase price unknown (the "Prix d'achat ?" affordance): opens the edit sheet on the cost fields. */
  onFixCost?: () => void;
  /** Just created via the quick-add loop: brief highlight so she sees where it landed. */
  pulse?: boolean;
}

function StockStatus({ product, variants }: { product: Product; variants?: ProductVariant[] }) {
  const { palette } = useTheme();
  const styles = useMemo(() => makeStyles(palette), [palette]);

  if (product.has_variants) {
    // Parent stock_qty is always 0 for a variant product — real stock lives
    // per-variant. Undefined (not loaded yet) intentionally shows nothing,
    // same fail-open default the Actifs/Épuisés split already uses, rather
    // than flashing "Épuisé" while variants are still being fetched.
    if (!variants || variants.length === 0) return null;
    const isOut = variants.every(v => v.stock_qty <= 0);
    if (!isOut) return null;
    return <Pill tone="warning">Fini</Pill>;
  }

  const isOut = product.stock_qty === 0;
  const isLow = !isOut && product.reorder_level > 0 && product.stock_qty <= product.reorder_level;

  if (isOut) {
    return <Pill tone="warning">Fini</Pill>;
  }
  if (isLow) {
    return (
      <Pill tone="warning" icon="leaf-outline">
        Bientôt fini · Il reste {product.stock_qty} {product.unit}
      </Pill>
    );
  }
  return (
    <Text style={styles.productStockText}>{product.stock_qty} {product.unit}</Text>
  );
}

// ─── Archive switch (Actifs / Non actifs) ────────────────────────────────────
// One sliding-pill control instead of two independent chips. The thumb slides
// (spring) ONLY from the press handler — never from an effect watching `value`:
// an effect also fires on mount, which made the pill wobble every time the
// Produits tab appeared. If `value` changes from somewhere else (not a tap),
// the thumb just snaps to it without animating. No squash/bounce.
function ArchiveSwitch({ value, onChange }: { value: 'actifs' | 'archives'; onChange: (v: 'actifs' | 'archives') => void }) {
  const { palette } = useTheme();
  const styles = useMemo(() => makeStyles(palette), [palette]);
  const [trackWidth, setTrackWidth] = useState(0);
  const target = value === 'archives' ? 1 : 0;
  const slide = useRef(new Animated.Value(target)).current;
  // The position the thumb is already at / heading to; lets the sync effect
  // tell "a tap already animated this" from "changed from elsewhere".
  const settledAt = useRef(target);

  useEffect(() => {
    if (settledAt.current !== target) {
      slide.stopAnimation();
      slide.setValue(target);
      settledAt.current = target;
    }
  }, [target, slide]);

  const handlePress = (t: 'actifs' | 'archives') => {
    if (t === value) return;
    const to = t === 'archives' ? 1 : 0;
    settledAt.current = to;
    Animated.spring(slide, { toValue: to, useNativeDriver: true, friction: 8, tension: 60 }).start();
    onChange(t);
  };

  const inset = 3;
  const thumbWidth = Math.max(trackWidth / 2 - inset, 0);
  const thumbTranslate = slide.interpolate({ inputRange: [0, 1], outputRange: [0, thumbWidth] });

  return (
    <View style={styles.switchTrack} onLayout={e => setTrackWidth(e.nativeEvent.layout.width)}>
      {trackWidth > 0 && (
        <Animated.View
          style={[
            styles.switchThumb,
            { width: thumbWidth, transform: [{ translateX: thumbTranslate }] },
          ]}
        />
      )}
      {(['actifs', 'archives'] as const).map(t => (
        <Pressable key={t} onPress={() => handlePress(t)} style={styles.switchOption} hitSlop={4}>
          <Text
            variant="caption"
            style={{
              color: value === t ? palette.textInverse : palette.textSecondary,
              fontWeight: value === t ? '700' : '500',
            }}
          >
            {t === 'actifs' ? 'Actifs' : 'Non actifs'}
          </Text>
        </Pressable>
      ))}
    </View>
  );
}

function ProductRow({ product, currency, onPress, onLongPress, archived, variants, archiving, onFixPrice, onFixCost, pulse }: ProductRowProps) {
  const { palette } = useTheme();
  const styles = useMemo(() => makeStyles(palette), [palette]);
  const initial = product.name.charAt(0).toUpperCase();
  const isOutOfStock = !archived && (
    product.has_variants
      ? !!(variants && variants.length > 0 && variants.every(v => v.stock_qty <= 0))
      : product.stock_qty === 0
  );

  // Highlight pulse for a product just added from the quick-add sheet.
  const pulseAnim = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (!pulse) return;
    pulseAnim.setValue(1);
    Animated.timing(pulseAnim, { toValue: 0, duration: 1400, useNativeDriver: true }).start();
  }, [pulse, pulseAnim]);

  if (archived) {
    return (
      <Pressable
        onPress={onPress}
        onLongPress={onLongPress}
        style={({ pressed }) => [styles.productRow, pressed && { opacity: 0.65 }]}
      >
        <View style={[styles.productBadge, { opacity: 0.5 }]}>
          <Text allowFontScaling={false} style={styles.productBadgeText}>{initial}</Text>
        </View>
        <View style={styles.productCenter}>
          <Text style={[styles.productName, { color: palette.textDisabled }]} numberOfLines={1}>{product.name}</Text>
          <Text style={styles.productStockText}>{product.stock_qty} {product.unit}</Text>
        </View>
        <View style={styles.productRight}>
          <Text style={{ fontSize: 18, color: palette.textDisabled, letterSpacing: 2 }}>···</Text>
        </View>
      </Pressable>
    );
  }

  return (
    <Pressable
      onPress={onPress}
      disabled={archiving}
      style={({ pressed }) => [styles.productRow, (pressed || archiving) && { opacity: archiving ? 0.5 : 0.65 }]}
    >
      <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, { backgroundColor: palette.primaryLight, opacity: pulseAnim }]} />
      <View style={[styles.productBadge, { opacity: isOutOfStock ? 0.38 : 1 }]}>
        <Text style={styles.productBadgeText}>{initial}</Text>
      </View>
      <View style={styles.productCenter}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing[2] }}>
          <Text
            style={[styles.productName, isOutOfStock && { color: palette.textSecondary }]}
            numberOfLines={1}
          >{product.name}</Text>
          {product.bulk_price ? (
            <View style={styles.bulkBadge}>
              <Text variant="caption" style={{ color: palette.warning }}>Gros</Text>
            </View>
          ) : null}
        </View>
        {archiving
          ? <LoadingStatus word="Désactivation" color={palette.textSecondary} variant="caption" />
          : <StockStatus product={product} variants={variants} />}
        {onFixPrice && needsSalePrice(product) ? (
          // No sale price yet (stored as 0): never shown as a price — a tappable "Prix à fixer".
          <Pressable onPress={onFixPrice} hitSlop={8} accessibilityRole="button" accessibilityLabel={`Fixer le prix de ${product.name}`}>
            <Text variant="caption" style={{ color: palette.primary }}>Prix à fixer</Text>
          </Pressable>
        ) : onFixCost && needsPurchasePrice(product) && !product.has_variants ? (
          <Pressable onPress={onFixCost} hitSlop={8} accessibilityRole="button" accessibilityLabel={`Indiquer le prix d'achat de ${product.name}`}>
            <Text variant="caption" style={{ color: palette.primary }}>Prix d'achat ?</Text>
          </Pressable>
        ) : null}
      </View>
      {/* One non-wrapping row: price, then — only for a real variant product
          — its chevron. Previously the chevron sat absolutely positioned at
          the bottom of a stretched container while the price sat at the
          top, which could visually split them onto two lines; and a second,
          unrelated chevron had been added to every non-variant row, when
          the chevron's only real meaning is "this product has varieties". */}
      <View style={styles.productRight}>
        <View style={styles.priceRow}>
          <Text
            style={[styles.priceText, isOutOfStock && { color: palette.textDisabled }]}
            numberOfLines={1}
          >
            {needsSalePrice(product) ? '—' : formatPriceValue(product.sale_price, currency)}
          </Text>
          {product.has_variants && (
            <Ionicons name="chevron-forward" size={14} color={palette.textDisabled} />
          )}
        </View>
      </View>
    </Pressable>
  );
}

// ─── Restore Action Sheet (archived products) ────────────────────────────────

function RestoreActionSheet({
  visible,
  product,
  onClose,
  onRestore,
}: {
  visible: boolean;
  product: Product | null;
  onClose: () => void;
  onRestore: () => void;
}) {
  const { palette } = useTheme();
  const insets = useSafeAreaInsets();
  const styles = useMemo(() => makeStyles(palette), [palette]);

  if (!product) return null;

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose} statusBarTranslucent navigationBarTranslucent>
      <Pressable style={styles.actionSheetOverlay} onPress={onClose} />
      <View style={[styles.actionSheet, { paddingBottom: Math.max(insets.bottom, spacing[4]) }]}>
        <View style={styles.sheetHandle} />
        <View style={styles.actionSheetHeader}>
          <Text variant="h4" numberOfLines={1}>{product.name}</Text>
          <Text variant="caption" color="secondary">Ce produit n'est plus actif</Text>
        </View>
        <Pressable
          style={({ pressed }) => [styles.actionRow, pressed && { opacity: 0.65 }]}
          onPress={onRestore}
        >
          <Ionicons name="refresh-outline" size={22} color={palette.primary} />
          <Text style={[styles.actionRowLabel, { color: palette.primary }]}>Réactiver ce produit</Text>
        </Pressable>
      </View>
      <ConfirmSheetHost active={!!(visible)} />
    </Modal>
  );
}

// ─── Product Action Sheet ─────────────────────────────────────────────────────

function ProductActionSheet({
  visible,
  product,
  canEdit,
  currency,
  onClose,
  onEdit,
  onAdjustStock,
  onStats,
  onArchive,
}: {
  visible: boolean;
  product: Product | null;
  canEdit: boolean;
  currency: string;
  onClose: () => void;
  onEdit: () => void;
  onAdjustStock: () => void;
  onStats: () => void;
  onArchive: () => void;
}) {
  const { palette } = useTheme();
  const insets = useSafeAreaInsets();
  const styles = useMemo(() => makeStyles(palette), [palette]);

  if (!product) return null;

  const stockLabel = product.has_variants
    ? 'Plusieurs tailles / couleurs'
    : `${product.stock_qty} ${product.unit} · ${formatPrice(product.sale_price, currency)}`;

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose} statusBarTranslucent navigationBarTranslucent>
      <Pressable style={styles.actionSheetOverlay} onPress={onClose} />
      <View style={[styles.actionSheet, { paddingBottom: Math.max(insets.bottom, spacing[4]) }]}>
        <View style={styles.sheetHandle} />
        <View style={styles.actionSheetHeader}>
          <Text variant="h4" numberOfLines={1}>{product.name}</Text>
          <Text variant="caption" color="secondary">{stockLabel}</Text>
        </View>

        {canEdit && (
          <Pressable
            style={({ pressed }) => [styles.actionRow, pressed && { opacity: 0.65 }]}
            onPress={onEdit}
          >
            <Ionicons name="create-outline" size={22} color={palette.textPrimary} />
            <Text style={styles.actionRowLabel}>
              {product.has_variants ? 'Modifier · Gérer les modèles' : 'Modifier'}
            </Text>
            <Ionicons name="chevron-forward" size={16} color={palette.textDisabled} />
          </Pressable>
        )}

        {canEdit && !product.has_variants && (
          <Pressable
            style={({ pressed }) => [styles.actionRow, pressed && { opacity: 0.65 }]}
            onPress={onAdjustStock}
          >
            <Ionicons name="layers-outline" size={22} color={palette.textPrimary} />
            <Text style={styles.actionRowLabel}>Ajuster le stock</Text>
            <Ionicons name="chevron-forward" size={16} color={palette.textDisabled} />
          </Pressable>
        )}

        <Pressable
          style={({ pressed }) => [styles.actionRow, pressed && { opacity: 0.65 }]}
          onPress={onStats}
        >
          <Ionicons name="bar-chart-outline" size={22} color={palette.textPrimary} />
          <Text style={styles.actionRowLabel}>Voir la rentabilité</Text>
          <Ionicons name="chevron-forward" size={16} color={palette.textDisabled} />
        </Pressable>

        {canEdit && (
          <>
            <View style={{ height: 1, backgroundColor: palette.border, marginTop: spacing[2] }} />
            <Pressable
              style={({ pressed }) => [styles.actionRow, pressed && { opacity: 0.65 }]}
              onPress={onArchive}
            >
              <Ionicons name="archive-outline" size={22} color={palette.warning} />
              <Text style={[styles.actionRowLabel, { color: palette.warning }]}>Désactiver</Text>
            </Pressable>
          </>
        )}
      </View>
      <ConfirmSheetHost active={!!(visible)} />
    </Modal>
  );
}

// ─── Gérer mode ───────────────────────────────────────────────────────────────

interface ProductManagerProps {
  sheets: ProductSheetsApi;
  /** Back to the sell grid. */
  onExit: () => void;
  /** The product she long-pressed in sell mode: its action sheet opens straight away. */
  focusProductId?: string | null;
}

const GERER_HINT_KEY = (userId: string) => `gerer_hint_seen_${userId}`;

/**
 * Management view of the product list (what used to be the Produits tab), rendered by Vendre in
 * "Gérer" mode. It never fetches over the grid: it reads the same local product store, and every
 * action (edit, archive, restore, stock adjust, price fix) goes through the outbox-backed store
 * functions, so the list reflects each change before any sync.
 */
export function ProductManager({ sheets, onExit, focusProductId }: ProductManagerProps) {
  const { palette } = useTheme();
  const insets = useSafeAreaInsets();
  const styles = useMemo(() => makeStyles(palette), [palette]);
  const session = useAuthStore(s => s.session);
  const business = session?.activeBusiness;
  const userId = session?.user.id ?? '';
  const businessId = business?.id ?? '';
  const currency = business?.currency ?? 'GNF';
  const role = session?.activeMembership?.role;
  const canEdit = role === 'administrateur' || role === 'manager';

  const { products, archivedProducts, variantsByProduct, loading, offline, offlineSince, fetchProducts, fetchArchivedProducts, fetchVariants, archiveProduct, restoreProduct, archivingIds } =
    useProductStore();

  const [search, setSearch] = useState('');
  const [tab, setTab] = useState<'actifs' | 'archives'>('actifs');
  const [successMsg, setSuccessMsg] = useState('');
  const [showOutOfStockModal, setShowOutOfStockModal] = useState(false);
  const [showActionSheet, setShowActionSheet] = useState(false);
  const [actionSheetProduct, setActionSheetProduct] = useState<Product | null>(null);
  const [showRestoreSheet, setShowRestoreSheet] = useState(false);
  const [restoreSheetProduct, setRestoreSheetProduct] = useState<Product | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  // "À compléter": half-filled products kept by the quick-add sheet (max 3, local only).
  const [drafts, setDrafts] = useState<QuickAddDraft[]>([]);
  const [draftsOpen, setDraftsOpen] = useState(true);
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

  const searchVisible = (tab === 'actifs' ? products.length : archivedProducts.length) >= SEARCH_VISIBILITY_THRESHOLD;
  useAnimateLayoutChange(searchVisible);
  useEffect(() => {
    if (!searchVisible) setSearch('');
  }, [searchVisible]);

  const showSuccess = useCallback((msg: string) => {
    setSuccessMsg(msg);
    setTimeout(() => setSuccessMsg(''), 2500);
  }, []);

  useEffect(() => {
    if (businessId) {
      // Eager so "Non actifs" can tell "zero active but some archived" from "nothing at all".
      fetchArchivedProducts(businessId);
    }
  }, [businessId]);

  useEffect(() => {
    if (businessId && tab === 'archives') fetchArchivedProducts(businessId);
  }, [tab, businessId]);

  // The last non-active product was reactivated while this view was open: the toggle just
  // disappeared, so land back on Actifs instead of an empty tab with no control to leave it.
  useEffect(() => {
    if (tab === 'archives' && archivedProducts.length === 0) setTab('actifs');
  }, [tab, archivedProducts.length]);

  const onRefresh = useCallback(async () => {
    if (!businessId) return;
    setRefreshing(true);
    await (tab === 'archives' ? fetchArchivedProducts(businessId) : fetchProducts(businessId, userId, session?.activeMembership?.id, session?.activeMembership?.role));
    setRefreshing(false);
  }, [businessId, userId, tab]);

  useEffect(() => {
    if (!businessId || products.length === 0) return;
    products.filter(p => p.has_variants && !variantsByProduct[p.id])
      .forEach(p => fetchVariants(p.id, businessId));
  }, [products, businessId]);

  const activeFiltered = useMemo(() => {
    const q = search.toLowerCase().trim();
    const base = q ? products.filter(p => p.name.toLowerCase().includes(q)) : products;
    return [...base].sort((a, b) => {
      const tierA = a.reorder_level > 0 && a.stock_qty > 0 && a.stock_qty <= a.reorder_level ? 1 : 0;
      const tierB = b.reorder_level > 0 && b.stock_qty > 0 && b.stock_qty <= b.reorder_level ? 1 : 0;
      if (tierA !== tierB) return tierA - tierB;
      return a.name.localeCompare(b.name, 'fr');
    });
  }, [products, search]);

  const inStockActive = useMemo(
    () => activeFiltered.filter(p => {
      if (!p.has_variants) return p.stock_qty > 0;
      const variants = variantsByProduct[p.id];
      if (!variants || variants.length === 0) return true;
      return variants.some(v => v.stock_qty > 0);
    }),
    [activeFiltered, variantsByProduct],
  );
  const outOfStockActive = useMemo(
    () => [...products].filter(p => {
      if (!p.has_variants) return p.stock_qty === 0;
      const variants = variantsByProduct[p.id];
      if (!variants || variants.length === 0) return false;
      return variants.every(v => v.stock_qty <= 0);
    }).sort((a, b) => a.name.localeCompare(b.name, 'fr')),
    [products, variantsByProduct],
  );

  const archivedFiltered = useMemo(() => {
    const q = search.toLowerCase().trim();
    if (!q) return archivedProducts;
    return archivedProducts.filter(p => p.name.toLowerCase().includes(q));
  }, [archivedProducts, search]);

  const openOptions = useCallback((product: Product) => {
    setActionSheetProduct(product);
    setShowActionSheet(true);
  }, []);

  // Long-press in sell mode lands here with the held product: open its actions straight away (once).
  const focusedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!focusProductId || focusedRef.current === focusProductId) return;
    const p = products.find(x => x.id === focusProductId);
    if (!p) return;
    focusedRef.current = focusProductId;
    openOptions(p);
  }, [focusProductId, products, openOptions]);

  const closeActionSheet = useCallback(() => setShowActionSheet(false), []);

  const handleActionEdit = useCallback(() => {
    if (!actionSheetProduct) return;
    const p = actionSheetProduct;
    setShowActionSheet(false);
    setTimeout(() => sheets.openEdit(p), 350);
  }, [actionSheetProduct, sheets]);

  const handleActionAdjust = useCallback(() => {
    if (!actionSheetProduct) return;
    const p = actionSheetProduct;
    setShowActionSheet(false);
    setTimeout(() => sheets.openAdjust(p), 350);
  }, [actionSheetProduct, sheets]);

  const handleActionStats = useCallback(() => {
    if (!actionSheetProduct) return;
    const p = actionSheetProduct;
    setShowActionSheet(false);
    setTimeout(() => sheets.openStats(p), 350);
  }, [actionSheetProduct, sheets]);

  const handleActionArchive = useCallback(() => {
    const product = actionSheetProduct;
    if (!product) return;
    setShowActionSheet(false);
    setTimeout(() => {
      appAlert(
        'Désactiver ce produit ?',
        `"${product.name}" ne sera plus proposé à la vente. Vous pourrez le réactiver depuis l'onglet Non actifs.`,
        [
          { text: 'Annuler', style: 'cancel' },
          {
            text: 'Désactiver', style: 'destructive',
            onPress: async () => {
              const archived = await archiveProduct(product.id, businessId);
              if (!archived) {
                haptics.error();
                failAlert('productNotArchived', {
                  err: useProductStore.getState().error, label: 'Réessayer',
                  onPress: () => { void archiveProduct(product.id, businessId); },
                });
                return;
              }
              haptics.destructive();
              markRowRemoved(product.id); // so Annuler fades the row back in
              // Archiving is a flag flip, so it can be undone: Annuler = restoreProduct.
              useSaveConfirmationStore.getState().show({
                message: archivedConfirmation(product.name),
                tone: 'success',
                undo: async () => { await restoreProduct(product.id, businessId, userId); },
              });
            },
          },
        ],
      );
    }, 350);
  }, [actionSheetProduct, archiveProduct, restoreProduct, businessId, userId]);

  const displayList = tab === 'actifs' ? inStockActive : archivedFiltered;

  // ONE derived state: every sheet/modal that can sit over this view. The floating "+" hides on it.
  const anySheetOpen = sheets.anySheetOpen || showActionSheet || showRestoreSheet || showOutOfStockModal;

  return (
    <View style={{ flex: 1 }}>
      {/* Post-action banners */}
      {successMsg ? (
        <View style={styles.successBanner}>
          <Text variant="label" style={{ color: palette.textInverse }}>{successMsg}</Text>
        </View>
      ) : null}

      {offline && (
        <OfflineNotice offlineSince={offlineSince} onRetry={() => fetchProducts(businessId, userId, session?.activeMembership?.id, session?.activeMembership?.role)} />
      )}

      {/* Header */}
      <View style={styles.header}>
        <View>
          <Text variant="h3">Gérer</Text>
          {/* Count only when the current tab's list is non-empty — never "0 produits". */}
          {(tab === 'actifs' ? products.length > 0 : archivedProducts.length > 0) && (
            <Text variant="caption" color="secondary">
              {tab === 'actifs'
                ? `${products.length} produit${products.length !== 1 ? 's' : ''}`
                : `${archivedProducts.length} non actif${archivedProducts.length !== 1 ? 's' : ''}`}
            </Text>
          )}
        </View>
        <View style={styles.headerRight}>
          {/* Currency declared once, visible in both modes (Vendre shows the same line). */}
          {tab === 'actifs' && products.length > 0 && (
            <Text variant="caption" color="secondary">Prix en {currency}</Text>
          )}
          <Pressable onPress={onExit} style={styles.exitPill} accessibilityRole="button" accessibilityLabel="Terminer la gestion">
            <Text variant="label" style={{ color: palette.primary }}>Terminé</Text>
          </Pressable>
        </View>
      </View>

      {/* One-time hint (first Gérer open): dismissible forever. */}
      {hintVisible && (
        <View style={styles.hintBanner}>
          <Ionicons name="information-circle-outline" size={16} color={palette.textSecondary} />
          <Text variant="caption" color="secondary" style={{ flex: 1 }}>Astuce : restez appuyé sur un produit pour le modifier</Text>
          <Pressable onPress={dismissHint} hitSlop={10} accessibilityRole="button" accessibilityLabel="Fermer l'astuce">
            <Ionicons name="close" size={18} color={palette.textSecondary} />
          </Pressable>
        </View>
      )}

      {/* À compléter (n): half-filled products, max 3, collapsible, each deletable. */}
      {drafts.length > 0 && (
        <View style={styles.draftsCard}>
          <Pressable onPress={() => setDraftsOpen(v => !v)} style={styles.draftsHead} accessibilityRole="button" accessibilityState={{ expanded: draftsOpen }}>
            <Text variant="label" style={{ flex: 1 }}>{`À compléter (${drafts.length})`}</Text>
            <Ionicons name={draftsOpen ? 'chevron-up' : 'chevron-down'} size={16} color={palette.textSecondary} />
          </Pressable>
          {draftsOpen && drafts.map(d => (
            <View key={d.id} style={styles.draftRow}>
              <Pressable style={{ flex: 1 }} onPress={() => sheets.resumeDraft(d)} accessibilityRole="button" accessibilityLabel={`Reprendre ${d.state.name.trim() || 'un produit sans nom'}`}>
                <Text variant="body" numberOfLines={1} style={{ fontFamily: FF.medium }}>{d.state.name.trim() || 'Sans nom'}</Text>
                <Text variant="caption" color="secondary">{d.state.price.trim() ? `${d.state.price} ${currency.toLowerCase()}` : 'Prix à fixer'}</Text>
              </Pressable>
              <Pressable onPress={() => deleteDraft(d)} hitSlop={12} accessibilityRole="button" accessibilityLabel={`Supprimer le brouillon ${d.state.name.trim() || ''}`.trim()}>
                <Ionicons name="close-circle" size={20} color={palette.textDisabled} />
              </Pressable>
            </View>
          ))}
        </View>
      )}

      {/* The "Non actifs" toggle only exists once at least one product has been deactivated. */}
      {archivedProducts.length > 0 && (
        <View style={styles.tabRow}>
          <ArchiveSwitch value={tab} onChange={setTab} />
        </View>
      )}

      {searchVisible && (
        <View style={styles.searchRow}>
          <Input placeholder="Rechercher un produit…" value={search} onChangeText={setSearch} style={{ flex: 1 }} />
        </View>
      )}

      {/* Stats row (actifs only). "Valeur du stock" is cost_price-derived. */}
      {products.length > 0 && tab === 'actifs' && (
        <View style={styles.statsCard}>
          <View style={styles.statCol}>
            <Text variant="caption" color="secondary">Valeur du stock</Text>
            <Text style={styles.statValue}>
              {formatPrice(
                products.filter(p => !p.has_variants).reduce((s, p) => s + p.cost_price * p.stock_qty, 0) +
                Object.values(variantsByProduct).flat().reduce((s, v) => s + v.cost_price * v.stock_qty, 0),
                currency,
              )}
            </Text>
          </View>
          {outOfStockActive.length > 0 && (
            <>
              <View style={styles.statDivider} />
              <Pressable style={[styles.statCol, { alignItems: 'flex-end' }]} onPress={() => setShowOutOfStockModal(true)}>
                <Text variant="caption" color="secondary" style={{ textAlign: 'right' }}>
                  {outOfStockActive.length === 1
                    ? '1 produit est fini'
                    : `${outOfStockActive.length} produits sont finis`}
                </Text>
                <Text style={[styles.statValue, { color: palette.primary }]}>Voir</Text>
              </Pressable>
            </>
          )}
        </View>
      )}

      {/* Product list — always rendered from the local store; offline + empty is the true empty state. */}
      {loading && products.length === 0 && !offline ? (
        <SkeletonList count={8} />
      ) : tab === 'actifs' && products.length === 0 ? (
        <EmptyState
          icon="cube-outline"
          title="Aucun produit pour le moment."
          subtitle="Ajoutez ce que vous vendez pour aller plus vite à la caisse."
          actionLabel="+ Ajouter un produit"
          onAction={() => sheets.openAdd()}
        />
      ) : tab === 'archives' && archivedFiltered.length === 0 ? (
        search.trim() ? (
          <NoResultsState query={search} />
        ) : (
          <EmptyState
            icon="cube-outline"
            title="Aucun produit non actif pour le moment."
            subtitle="Les produits que vous désactivez apparaîtront ici."
          />
        )
      ) : (
        <View style={styles.listContainer}>
          <FlatList
            style={{ flex: 1 }}
            data={displayList}
            keyExtractor={p => p.id}
            CellRendererComponent={AnimatedRowCell}
            renderItem={({ item }) => (
              <ProductRow
                product={item}
                currency={currency}
                archived={tab === 'archives'}
                variants={variantsByProduct[item.id]}
                archiving={archivingIds.includes(item.id)}
                pulse={sheets.pulseId === item.id}
                onFixPrice={canEdit && tab === 'actifs' ? () => sheets.openEdit(item) : undefined}
                onFixCost={canEdit && tab === 'actifs' ? () => sheets.openEdit(item, { expandCost: true }) : undefined}
                onPress={() => {
                  if (tab === 'archives') {
                    setRestoreSheetProduct(item);
                    setShowRestoreSheet(true);
                    return;
                  }
                  openOptions(item);
                }}
                onLongPress={() => tab === 'archives' ? undefined : openOptions(item)}
              />
            )}
            ItemSeparatorComponent={() => <View style={styles.separator} />}
            contentContainerStyle={styles.list}
            showsVerticalScrollIndicator={false}
            keyboardShouldPersistTaps="handled"
            refreshControl={
              <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={palette.primary} colors={[palette.primary]} />
            }
            ListEmptyComponent={
              search.trim() ? (
                <NoResultsState
                  query={search}
                  createLabel={`+ Nouveau produit « ${search.trim()} »`}
                  onCreate={() => sheets.openAdd(search.trim())}
                />
              ) : null
            }
          />
        </View>
      )}

      {/* Out-of-stock bottom sheet */}
      <Modal
        visible={showOutOfStockModal}
        animationType="slide"
        transparent
        onRequestClose={() => setShowOutOfStockModal(false)}
        statusBarTranslucent
        navigationBarTranslucent
      >
        <Pressable style={styles.outOfStockOverlay} onPress={() => setShowOutOfStockModal(false)} />
        <View style={styles.outOfStockSheet}>
          <View style={styles.sheetHandle} />
          <View style={[styles.header, { paddingTop: spacing[2] }]}>
            <View>
              <Text variant="h4">Produits finis</Text>
              <Text variant="caption" color="secondary">
                {outOfStockActive.length} produit{outOfStockActive.length !== 1 ? 's' : ''} à racheter
              </Text>
            </View>
            <Pressable onPress={() => setShowOutOfStockModal(false)} style={{ padding: spacing[2] }} accessibilityLabel="Fermer" accessibilityRole="button">
              <Ionicons name="close" size={22} color={palette.textSecondary} />
            </Pressable>
          </View>
          <FlatList
            data={outOfStockActive}
            keyExtractor={p => p.id}
            renderItem={({ item }) => (
              <ProductRow
                product={item}
                currency={currency}
                variants={variantsByProduct[item.id]}
                onPress={() => {
                  setShowOutOfStockModal(false);
                  setTimeout(() => openOptions(item), 350);
                }}
              />
            )}
            ItemSeparatorComponent={() => <View style={styles.separator} />}
            contentContainerStyle={[styles.list, { paddingBottom: insets.bottom + spacing[4] }]}
            showsVerticalScrollIndicator={false}
          />
        </View>
        <ConfirmSheetHost active={!!(showOutOfStockModal)} />
      </Modal>

      {/* Restore Action Sheet (archived products) */}
      <RestoreActionSheet
        visible={showRestoreSheet}
        product={restoreSheetProduct}
        onClose={() => setShowRestoreSheet(false)}
        onRestore={() => {
          if (!restoreSheetProduct) return;
          const p = restoreSheetProduct;
          setShowRestoreSheet(false);
          restoreProduct(p.id, businessId, userId);
          showSuccess(`${p.name} réactivé ✓`);
        }}
      />

      {/* Product Action Sheet */}
      <ProductActionSheet
        visible={showActionSheet}
        product={actionSheetProduct}
        canEdit={canEdit}
        currency={currency}
        onClose={closeActionSheet}
        onEdit={handleActionEdit}
        onAdjustStock={handleActionAdjust}
        onStats={handleActionStats}
        onArchive={handleActionArchive}
      />

      {/* Floating "+" — hidden whenever any sheet/modal is open (single derived state). */}
      {canEdit && tab === 'actifs' && products.length > 0 && !anySheetOpen && (
        <View style={styles.fabContainer}>
          <Pressable
            onPress={() => sheets.openAdd()}
            style={({ pressed }) => [styles.fabExtended, pressed && { opacity: 0.82 }]}
            accessibilityLabel="Ajouter un produit"
            accessibilityRole="button"
          >
            <Ionicons name="add" size={20} color={palette.textInverse} />
            <Text style={styles.fabExtendedLabel}>Produit</Text>
          </Pressable>
        </View>
      )}
    </View>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

function makeStyles(p: Palette) {
  return StyleSheet.create({
    safe: { flex: 1, backgroundColor: p.background },
    headerRight: { flexDirection: 'row', alignItems: 'center', gap: spacing[3] },
    exitPill: { paddingHorizontal: spacing[3], paddingVertical: spacing[1.5], borderRadius: radius.full, backgroundColor: p.primaryLight },
    hintBanner: {
      flexDirection: 'row', alignItems: 'center', gap: spacing[2],
      marginHorizontal: spacing[4], marginBottom: spacing[3], paddingHorizontal: spacing[4], paddingVertical: spacing[2.5],
      borderRadius: radius.card, backgroundColor: p.surface,
    },
    draftsCard: {
      marginHorizontal: spacing[4], marginBottom: spacing[3], borderRadius: radius.card, backgroundColor: p.surface, overflow: 'hidden',
    },
    draftsHead: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: spacing[4], paddingVertical: spacing[3] },
    draftRow: { flexDirection: 'row', alignItems: 'center', gap: spacing[3], paddingHorizontal: spacing[4], paddingVertical: spacing[2.5] },
    successBanner: {
      backgroundColor: p.success, paddingHorizontal: spacing[5], paddingVertical: spacing[3],
      alignItems: 'center',
    },
    detailPromptBanner: {
      backgroundColor: p.success, paddingHorizontal: spacing[5], paddingVertical: spacing[3],
      flexDirection: 'row', alignItems: 'center',
    },
    header: {
      flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
      paddingHorizontal: spacing[5], paddingTop: spacing[4], paddingBottom: spacing[3],
    },
    tabRow: {
      flexDirection: 'row',
      paddingHorizontal: spacing[5], paddingBottom: spacing[3],
    },
    // Fixed width, not flex/intrinsic — the two switchOption labels below
    // use flex:1 each, so they need a resolved parent width to split
    // evenly; that's also what keeps the sliding thumb's "half the track"
    // math exact regardless of which label is longer ("Non actifs" vs "Actifs").
    switchTrack: {
      flexDirection: 'row',
      width: 224, height: 40,
      borderRadius: radius.full,
      backgroundColor: p.background,
      borderWidth: 1, borderColor: p.border,
      position: 'relative',
    },
    switchThumb: {
      position: 'absolute',
      top: 3, bottom: 3, left: 3,
      borderRadius: radius.full,
      backgroundColor: p.primary,
      ...shadow.sm,
    },
    switchOption: { flex: 1, alignItems: 'center', justifyContent: 'center', zIndex: 1 },
    alertBanner: {
      backgroundColor: p.warningLight, paddingHorizontal: spacing[5], paddingVertical: spacing[2],
      borderBottomWidth: 1, borderBottomColor: p.warning,
    },
    searchRow: { paddingHorizontal: spacing[5], paddingBottom: spacing[3] },
    statsCard: {
      flexDirection: 'row',
      marginHorizontal: spacing[5],
      marginBottom: spacing[3],
      backgroundColor: p.surface,
      borderWidth: 1,
      borderColor: p.border,
      borderRadius: radius.md,
      paddingVertical: spacing[3],
      paddingHorizontal: spacing[4],
    },
    statCol: { flex: 1, gap: 3 },
    statDivider: { width: 1, backgroundColor: p.border, marginHorizontal: spacing[4] },
    statValue: { fontFamily: FF.bold, fontSize: 18, color: p.textPrimary },
    // Horizontal inset now lives on listContainer's own margin below, not
    // here — the FlatList's content spans the container's full width, with
    // each row supplying its own horizontal padding instead.
    list: { paddingBottom: spacing[10] },
    // Same radius/border/surface language as statsCard and the search
    // field above it — same radius.md token, not a one-off literal value.
    listContainer: {
      flex: 1,
      marginHorizontal: spacing[5],
      borderRadius: radius.md,
      borderWidth: 1, borderColor: p.border,
      backgroundColor: p.surface,
      overflow: 'hidden',
    },
    separator: { height: 0 },
    productRow: {
      flexDirection: 'row', alignItems: 'center',
      paddingHorizontal: spacing[4], paddingVertical: spacing[4],
      borderBottomWidth: 1, borderBottomColor: p.border,
      backgroundColor: p.surface,
    },
    // One neutral tile token for every product — no per-item hash color.
    // Swap this for the real product photo once catalogue photos ship.
    productBadge: {
      width: 44, height: 44, borderRadius: radius.md,
      alignItems: 'center', justifyContent: 'center',
      marginRight: 0,
      backgroundColor: p.background, borderWidth: 1, borderColor: p.border,
    },
    productBadgeText: { fontFamily: FF.semibold, fontSize: 16, color: p.textSecondary },
    // minWidth: 0 lets this column actually shrink below its content's
    // natural width — without it, a long product name can push the
    // trailing price/chevron group past the row's edge instead of the
    // name truncating.
    productCenter: { flex: 1, minWidth: 0, paddingLeft: 12, gap: 3 },
    productName: { fontFamily: FF.semibold, fontSize: 16, color: p.textPrimary },
    productStockText: { fontFamily: FF.regular, fontSize: 13, color: p.textSecondary },
    productMeta: { flexDirection: 'row', gap: spacing[2], alignItems: 'center' },
    categoryBadge: {
      backgroundColor: p.primaryLight, borderRadius: radius.sm,
      paddingHorizontal: spacing[1.5], paddingVertical: 2,
    },
    bulkBadge: {
      backgroundColor: p.warningLight, borderRadius: radius.sm,
      paddingHorizontal: spacing[1.5], paddingVertical: 2, borderWidth: 1, borderColor: p.warning,
    },
    // flexShrink: 0 — the trailing price+chevron group never shrinks or
    // wraps; productCenter's minWidth: 0 above is what gives it the room
    // to hold its own full width by taking space from the name instead.
    productRight: { alignItems: 'flex-end', flexShrink: 0 },
    priceRow: { flexDirection: 'row', alignItems: 'center', gap: spacing[1] },
    // Neutral, same weight as the product name — ordinary prices are not an
    // accent moment. Tabular figures keep the column aligned as it scrolls.
    priceText: {
      fontFamily: FF.semibold, fontSize: 15, color: p.textPrimary,
      fontVariant: ['tabular-nums'] as ['tabular-nums'],
    },
    // 194 was tuned against the old flush tab bar's flex space; the floating
    // pill no longer reserves that space, so the same clearance is added
    // here too to keep this FAB sitting exactly where it did before.
    fabContainer: { position: 'absolute', bottom: 194 + FLOATING_TAB_BAR_CLEARANCE, right: spacing[4], zIndex: 10 },
    // The floating "Ajouter un produit" pill — labeled instead of a bare
    // icon, per the calm-catalogue redesign. Auto-width, floating bottom-right.
    fabExtended: {
      flexDirection: 'row', alignItems: 'center', gap: spacing[2],
      height: 56, paddingHorizontal: spacing[5], borderRadius: radius.full,
      backgroundColor: p.primary,
      shadowColor: p.shadow, shadowOffset: { width: 0, height: 4 },
      shadowOpacity: 0.18, shadowRadius: 8, elevation: 8,
    },
    fabExtendedLabel: { fontFamily: FF.semibold, fontSize: 15, color: p.textInverse },

    modalSafe: { flex: 1, backgroundColor: p.background },
    modalHeader: {
      flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
      paddingHorizontal: spacing[5], paddingVertical: spacing[4],
      borderBottomWidth: 1, borderBottomColor: p.border, backgroundColor: p.surface,
    },
    modalCancel: { minWidth: 64 },
    modalContent: { padding: spacing[5], gap: spacing[4] },
    // Depth from a soft upward shadow instead of a tinted panel + hairline —
    // background matches the screen itself so there's no visible "canvas"
    // behind the button, just enough shadow to read as pinned above the
    // scrollable content on both platforms (shadow props on iOS, elevation
    // on Android — shadow.md already bundles both).
    modalFooter: {
      padding: spacing[5], backgroundColor: p.background,
      ...shadow.md, shadowOffset: { width: 0, height: -2 },
    },
    formError: { backgroundColor: p.warningLight, borderRadius: radius.md, padding: spacing[3] },

    formStack: {},
    fieldBlock: {
      paddingHorizontal: spacing[5], paddingTop: spacing[2.5], paddingBottom: spacing[2.5],
      borderBottomWidth: 1, borderBottomColor: p.border, gap: spacing[1.5],
    },
    fieldLabel: {
      fontFamily: FF.semibold, fontSize: 11, color: p.textSecondary,
      letterSpacing: 0.6, textTransform: 'uppercase' as const,
    },
    fieldInput: { fontFamily: FF.semibold, fontSize: 22, color: p.textPrimary, paddingVertical: 0, minHeight: 36 },
    fieldRow: { flexDirection: 'row', alignItems: 'center', gap: spacing[3] },
    unitTag: { fontFamily: FF.medium, fontSize: 15, color: p.textSecondary },
    liveCalcBlock: {
      paddingHorizontal: spacing[5], paddingVertical: spacing[2.5],
      borderBottomWidth: 1, borderBottomColor: p.border,
    },
    liveCalcText: { fontFamily: FF.medium, fontSize: 14, color: p.textSecondary },
    detailsBtn: {
      paddingHorizontal: spacing[5], paddingVertical: spacing[3],
      alignItems: 'center' as const,
      borderBottomWidth: 1, borderBottomColor: p.border,
    },
    priceAccessoryBar: {
      flexDirection: 'row', justifyContent: 'flex-end',
      paddingHorizontal: spacing[4], paddingVertical: spacing[2.5],
      backgroundColor: p.surface, borderTopWidth: 1, borderTopColor: p.border,
    },

    pickerField: {
      flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
      paddingHorizontal: spacing[4], paddingVertical: spacing[3],
      borderRadius: radius.md, borderWidth: 1, backgroundColor: p.surface,
    },
    supplierDropdown: { borderTopWidth: 1, borderTopColor: p.border, backgroundColor: p.surface },
    supplierRow: {
      paddingHorizontal: spacing[5], paddingVertical: spacing[3],
      borderBottomWidth: 1, borderBottomColor: p.border, gap: 2,
    },
    supplierRowActive: { backgroundColor: p.primaryLight },
    newSupplierForm: {
      paddingHorizontal: spacing[5], paddingVertical: spacing[4],
      gap: spacing[3],
      borderTopWidth: 1, borderTopColor: p.border,
      backgroundColor: p.surface,
    },

    statsRow: {
      flexDirection: 'row' as const,
      justifyContent: 'space-between' as const,
      alignItems: 'center' as const,
      paddingVertical: spacing[3],
      paddingHorizontal: spacing[4],
    },
    statsRowBorder: { borderTopWidth: 1, borderTopColor: p.border },

    stockPreview: { alignItems: 'center', gap: spacing[1] },
    typeRow: { flexDirection: 'row', gap: spacing[3] },
    typeChip: {
      flex: 1, alignItems: 'center', paddingVertical: spacing[3],
      borderRadius: radius.md, borderWidth: 1.5, borderColor: p.border, backgroundColor: p.surface,
    },
    typeChipEntree: { backgroundColor: p.success, borderColor: p.success },
    typeChipPerte: { backgroundColor: p.warning, borderColor: p.warning },

    variantBadge: {
      alignSelf: 'flex-start',
      backgroundColor: p.primaryLight,
      borderRadius: radius.full,
      paddingHorizontal: 8, paddingVertical: 3,
    },
    variantBadgeText: { fontFamily: FF.medium, fontSize: 12, color: p.primary },
    variantToggleRow: {
      flexDirection: 'row', alignItems: 'center',
      paddingHorizontal: spacing[5], paddingVertical: spacing[4],
      borderBottomWidth: 1, borderBottomColor: p.border,
      gap: spacing[3],
    },
    variantList: { borderTopWidth: 1, borderTopColor: p.border },
    variantRowHeader: {
      flexDirection: 'row', alignItems: 'center',
      paddingHorizontal: spacing[5], paddingVertical: spacing[2],
      borderBottomWidth: 1, borderBottomColor: p.border,
      gap: spacing[2],
    },
    variantExpandBtn: { paddingHorizontal: spacing[2] },
    variantListHeader: {
      flexDirection: 'row', alignItems: 'center',
      paddingHorizontal: spacing[5], paddingTop: spacing[3], paddingBottom: spacing[1],
      gap: spacing[2],
    },
    addVariantBtn: {
      flexDirection: 'row', alignItems: 'center',
      paddingHorizontal: spacing[5], paddingVertical: spacing[4],
      borderBottomWidth: 1, borderBottomColor: p.border,
    },

    outOfStockOverlay: {
      ...StyleSheet.absoluteFillObject,
      backgroundColor: 'rgba(0,0,0,0.45)',
    },
    outOfStockSheet: {
      position: 'absolute', bottom: 0, left: 0, right: 0,
      backgroundColor: p.surface,
      borderTopLeftRadius: 20, borderTopRightRadius: 20,
      maxHeight: '80%',
      shadowColor: p.shadow, shadowOffset: { width: 0, height: -4 },
      shadowOpacity: 0.12, shadowRadius: 16, elevation: 24,
    },
    sheetHandle: {
      width: 36, height: 4, borderRadius: 2, backgroundColor: p.border,
      alignSelf: 'center', marginTop: spacing[2],
    },
    actionSheetOverlay: {
      ...StyleSheet.absoluteFillObject,
      backgroundColor: 'rgba(0,0,0,0.45)',
    },
    actionSheet: {
      position: 'absolute', bottom: 0, left: 0, right: 0,
      backgroundColor: p.surface,
      borderTopLeftRadius: 20, borderTopRightRadius: 20,
      paddingTop: spacing[2],
      shadowColor: p.shadow, shadowOffset: { width: 0, height: -4 },
      shadowOpacity: 0.12, shadowRadius: 16, elevation: 24,
    },
    actionSheetHeader: {
      paddingHorizontal: spacing[5],
      paddingTop: spacing[3],
      paddingBottom: spacing[4],
      gap: spacing[1],
      borderBottomWidth: 1,
      borderBottomColor: p.border,
    },
    actionRow: {
      flexDirection: 'row' as const,
      alignItems: 'center' as const,
      paddingHorizontal: spacing[5],
      paddingVertical: spacing[4],
      gap: spacing[3],
      borderBottomWidth: 1,
      borderBottomColor: p.border,
    },
    actionRowLabel: {
      flex: 1,
      fontSize: 16,
      fontFamily: FF.regular,
      color: p.textPrimary,
    },
  });
}
