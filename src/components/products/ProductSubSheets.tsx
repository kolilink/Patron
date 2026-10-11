import React, { useEffect, useMemo, useState } from 'react';
import { InputAccessoryView, Keyboard, Platform, Pressable, StyleSheet, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { FormSheet } from '@/src/components/ui/FormSheet';
import { Button } from '@/src/components/ui/Button';
import { Card } from '@/src/components/ui/Card';
import { Input } from '@/src/components/ui/Input';
import { appAlert } from '@/src/utils/appAlert';
import { Text } from '@/src/components/ui/Text';
import { QuantityStepper } from '@/src/components/ui/QuantityStepper';
import { Ionicons } from '@expo/vector-icons';
import { useTheme, radius, spacing, shadow, fontFamily as FF } from '@/src/theme';
import type { Palette } from '@/src/theme';
import type { Product } from '@/src/types';
import type { ProductStats } from '@/stores/products';
import { haptics } from '@/lib/haptics';
import { LoadingStatus } from '@/src/components/ui/LoadingStatus';
import { formatAmount, formatAmountValue, formatSignedAmount } from '@/src/utils/format';

// Stock adjustment ("Ajuster") and per-product profitability ("Rentabilité") sheets — moved
// verbatim from the old Produits tab; they are opened from Gérer mode and from the edit sheet.

const STOCK_ADJUST_ACCESSORY_ID = 'catalogue-stock-adjust-silent-accessory';

// ─── Stock Adjust Modal ───────────────────────────────────────────────────────

interface StockAdjustProps {
  visible: boolean;
  product: Product | null;
  onClose: () => void;
  onConfirm: (qty: number, type: 'entree' | 'perte', note: string) => Promise<void>;
  saving: boolean;
  currency: string;
}

export function StockAdjustModal({ visible, product, onClose, onConfirm, saving, currency }: StockAdjustProps) {
  const { palette } = useTheme();
  const styles = useMemo(() => makeStyles(palette), [palette]);
  const [qty, setQty] = useState('1');
  const [type, setType] = useState<'entree' | 'perte'>('entree');
  const [note, setNote] = useState('');

  useEffect(() => {
    if (visible) { setQty('1'); setType('entree'); setNote(''); }
  }, [visible]);

  if (!product) return null;

  return (
    <FormSheet
      visible={visible}
      onClose={onClose}
      title="Ajuster le stock"
      presentationStyle="formSheet"
      contentContainerStyle={styles.modalContent}
      footer={
        <View style={styles.modalFooter}>
          <Button
            label="Confirmer" loadingLabel="Enregistrement"
            onPress={async () => {
              const n = parseInt(qty);
              if (isNaN(n) || n <= 0) { appAlert('Entrez une quantité'); return; }
              await onConfirm(n, type, note);
            }}
            loading={saving} fullWidth size="lg"
            variant={type === 'perte' ? 'danger' : 'primary'}
          />
        </View>
      }
      accessory={
        Platform.OS === 'ios' ? (
          <InputAccessoryView nativeID={STOCK_ADJUST_ACCESSORY_ID}>
            <View style={{ height: 0 }} />
          </InputAccessoryView>
        ) : undefined
      }
    >
      <Card style={styles.stockPreview}>
        <Text variant="label">{product.name}</Text>
        <Text variant="amountLarge">{product.stock_qty} {product.unit}</Text>
        <Text variant="caption" color="secondary">Stock actuel</Text>
      </Card>

      <View style={styles.typeRow}>
        <Pressable onPress={() => setType('entree')}
          style={[styles.typeChip, type === 'entree' && styles.typeChipEntree]}>
          <Text variant="label" style={{ color: type === 'entree' ? palette.textInverse : palette.textPrimary }}>
            + Entrée
          </Text>
        </Pressable>
        <Pressable onPress={() => setType('perte')}
          style={[styles.typeChip, type === 'perte' && styles.typeChipPerte]}>
          <Text variant="label" style={{ color: type === 'perte' ? palette.textInverse : palette.textPrimary }}>
            − Perte / Retrait
          </Text>
        </Pressable>
      </View>

      <Text variant="label" color="secondary">Quantité</Text>
      <QuantityStepper
        value={qty}
        onChange={setQty}
        inputStyle={{ fontSize: 18 }}
        inputAccessoryViewID={STOCK_ADJUST_ACCESSORY_ID}
      />
      <Input label="Note (optionnel)" value={note} onChangeText={setNote}
        placeholder="Livraison, retour client, casse" />
    </FormSheet>
  );
}

// ─── Product Stats Modal ──────────────────────────────────────────────────────

type StatsPeriod = 'mois' | 'tout';

interface ProductStatsModalProps {
  visible: boolean;
  product: Product | null;
  onClose: () => void;
  businessId: string;
  currency: string;
  fetchStats: (productId: string, businessId: string, since?: string) => Promise<ProductStats | null>;
}

export function ProductStatsModal({ visible, product, onClose, businessId, currency, fetchStats }: ProductStatsModalProps) {
  const { palette } = useTheme();
  const styles = useMemo(() => makeStyles(palette), [palette]);
  const [period, setPeriod] = useState<StatsPeriod>('mois');
  const [stats, setStats] = useState<ProductStats | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!visible || !product) return;
    setStats(null);
    setPeriod('mois');
  }, [visible, product]);

  useEffect(() => {
    if (!visible || !product) return;
    let cancelled = false;
    setLoading(true);
    const since = period === 'mois'
      ? new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString()
      : undefined;
    fetchStats(product.id, businessId, since).then(result => {
      if (!cancelled) { setStats(result); setLoading(false); }
    });
    return () => { cancelled = true; };
  }, [visible, product, period, businessId]);

  if (!product) return null;

  const profitColor = stats && stats.profit != null && stats.profit >= 0 ? palette.success : palette.warning;

  return (
    <FormSheet
      visible={visible}
      onClose={onClose}
      title="Bénéfices"
      cancelLabel="Fermer"
      presentationStyle="formSheet"
      contentContainerStyle={styles.modalContent}
    >
      <Text variant="label" color="secondary" style={{ textAlign: 'center' }}>{product.name}</Text>

      {/* Period toggle */}
      <View style={styles.typeRow}>
        <Pressable onPress={() => setPeriod('mois')}
          style={[styles.typeChip, period === 'mois' && styles.typeChipEntree]}>
          <Text variant="label" style={{ color: period === 'mois' ? palette.textInverse : palette.textPrimary }}>
            Ce mois
          </Text>
        </Pressable>
        <Pressable onPress={() => setPeriod('tout')}
          style={[styles.typeChip, period === 'tout' && styles.typeChipEntree]}>
          <Text variant="label" style={{ color: period === 'tout' ? palette.textInverse : palette.textPrimary }}>
            Depuis le début
          </Text>
        </Pressable>
      </View>

      {loading ? (
        <View style={{ alignItems: 'center', paddingVertical: 32 }}>
          <Text variant="body" color="secondary">Chargement…</Text>
        </View>
      ) : stats ? (
        <Card style={{ gap: 0 }}>
          <View style={styles.statsRow}>
            <Text variant="body" color="secondary">Encaissé</Text>
            <Text variant="body" style={{ fontFamily: 'System', fontWeight: '600' }}>
              {formatAmount(stats.revenue, currency)}
            </Text>
          </View>
          <View style={[styles.statsRow, styles.statsRowBorder]}>
            <Text variant="body" color="secondary">Coût d'achat</Text>
            <Text variant="body" style={{ fontFamily: 'System', fontWeight: '600' }}>
              {formatAmount(stats.capital, currency)}
            </Text>
          </View>
          {stats.linkedExpenses > 0 && (
            <View style={[styles.statsRow, styles.statsRowBorder]}>
              <Text variant="body" color="secondary">Dépenses liées</Text>
              <Text variant="body" style={{ fontFamily: 'System', fontWeight: '600' }}>
                {formatAmount(stats.linkedExpenses, currency)}
              </Text>
            </View>
          )}
          <View style={[styles.statsRow, styles.statsRowBorder]}>
            <Text variant="body">Bénéfice</Text>
            <Text variant="body" style={{ fontFamily: 'System', fontWeight: '700', color: profitColor }}>
              {stats.profit == null ? '—' : formatSignedAmount(stats.profit, currency)}
            </Text>
          </View>
        </Card>
      ) : (
        <View style={{ alignItems: 'center', paddingVertical: 32 }}>
          <Text variant="body" color="secondary">Aucune donnée disponible.</Text>
        </View>
      )}
    </FormSheet>
  );
}


function makeStyles(p: Palette) {
  return StyleSheet.create({
    modalContent: { padding: spacing[5], gap: spacing[4] },
    modalFooter: {
      padding: spacing[5], backgroundColor: p.background,
      ...shadow.md, shadowOffset: { width: 0, height: -2 },
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
  });
}
