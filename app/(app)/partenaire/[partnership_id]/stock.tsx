import { useEffect, useState } from 'react';
import {
  Pressable,
  SectionList,
  StyleSheet,
  View,
} from 'react-native';
import { Screen } from '@/src/components/ui/Screen';
import { router, useLocalSearchParams } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { Text } from '@/src/components/ui/Text';
import { useTheme, radius, spacing } from '@/src/theme';
import type { Palette } from '@/src/theme';
import { useAuthStore } from '@/stores/auth';
import { usePartnershipsStore } from '@/stores/partnerships';
import { supabase } from '@/lib/supabase';
import type { PartnerProduct, PartnerStockResult } from '@/src/types';

type Section = { title: string; data: PartnerProduct[] };

function buildSections(products: PartnerProduct[]): Section[] {
  const byCategory: Record<string, PartnerProduct[]> = {};
  for (const p of products) {
    const cat = p.category ?? 'Divers';
    if (!byCategory[cat]) byCategory[cat] = [];
    byCategory[cat].push(p);
  }
  return Object.entries(byCategory)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([title, data]) => ({ title, data }));
}

function formatQty(qty: number, unit: string): string {
  if (unit && unit !== 'pcs') return `${qty} ${unit}`;
  return String(qty);
}

export default function PartnerStockScreen() {
  const { partnership_id } = useLocalSearchParams<{ partnership_id: string }>();
  const { palette } = useTheme();
  const styles = makeStyles(palette);

  const session = useAuthStore(s => s.session);
  const businessId = session?.activeBusiness?.id ?? '';

  const { partners } = usePartnershipsStore();
  const partner = partners.find(p => p.partnership_id === partnership_id);
  const partnerName = partner?.partner_business_name ?? 'Partenaire';

  const [result, setResult] = useState<PartnerStockResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!partnership_id || !businessId) return;
    setLoading(true);
    setError('');
    supabase
      .rpc('get_partner_stock', {
        p_partnership_id: partnership_id,
        p_my_business_id: businessId,
      })
      .then(({ data, error: rpcErr }) => {
        if (rpcErr) {
          setError(rpcErr.message ?? 'Erreur de chargement');
        } else {
          setResult(data as PartnerStockResult);
        }
        setLoading(false);
      });
  }, [partnership_id, businessId]);

  const sections = result?.products ? buildSections(result.products) : [];
  const inStockCount = result?.products?.filter(p => p.in_stock).length ?? 0;
  const totalCount = result?.products?.length ?? 0;

  return (
    <Screen>
      {/* Header */}
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} hitSlop={8}>
          <Ionicons name="chevron-back" size={24} color={palette.primary} />
        </Pressable>
        <View style={{ flex: 1, alignItems: 'center' }}>
          <Text variant="h4" numberOfLines={1}>Stock de {partnerName}</Text>
          {!loading && result?.products && (
            <Text variant="caption" color="secondary">
              {inStockCount}/{totalCount} produits disponibles
            </Text>
          )}
        </View>
        <View style={{ width: 32 }} />
      </View>

      {loading ? (
        <View style={styles.center}>
          <Text variant="body" color="secondary">Chargement…</Text>
        </View>
      ) : error ? (
        <View style={styles.center}>
          <Ionicons name="lock-closed-outline" size={48} color={palette.textSecondary} style={{ marginBottom: 16 }} />
          <Text variant="body" color="secondary" style={{ textAlign: 'center', lineHeight: 22 }}>{error}</Text>
        </View>
      ) : sections.length === 0 ? (
        <View style={styles.center}>
          <Text variant="body" color="secondary" style={{ textAlign: 'center' }}>
            Ce partenaire n'a pas encore de produits.
          </Text>
        </View>
      ) : (
        <SectionList<PartnerProduct, Section>
          sections={sections}
          keyExtractor={(item, idx) => `${item.name}-${idx}`}
          contentContainerStyle={styles.listContent}
          stickySectionHeadersEnabled={false}
          renderSectionHeader={({ section }) => (
            <View style={styles.sectionHeader}>
              <Text variant="caption" color="secondary" style={styles.sectionHeaderText}>
                {section.title.toUpperCase()}
              </Text>
            </View>
          )}
          renderItem={({ item, index, section }) => (
            <View style={[
              styles.productRow,
              index === 0 && styles.firstRow,
              index === section.data.length - 1 && styles.lastRow,
            ]}>
              <View style={{ flex: 1 }}>
                <Text variant="body" style={styles.productName}>{item.name}</Text>
              </View>
              {item.in_stock ? (
                <Text style={[styles.qtyText, { color: palette.success }]}>
                  {formatQty(item.stock_qty, item.unit)}
                </Text>
              ) : (
                <Text style={[styles.qtyText, { color: palette.warning }]}>
                  Rupture
                </Text>
              )}
            </View>
          )}
        />
      )}
    </Screen>
  );
}

function makeStyles(p: Palette) {
  return StyleSheet.create({
    safe: { flex: 1, backgroundColor: p.background },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: spacing[4],
      paddingVertical: spacing[3],
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: p.border,
      gap: spacing[3],
    },
    center: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      padding: spacing[6],
    },
    listContent: { paddingBottom: 32 },
    sectionHeader: {
      paddingHorizontal: spacing[5],
      paddingTop: spacing[5],
      paddingBottom: spacing[2],
    },
    sectionHeaderText: {
      fontSize: 11,
      fontWeight: '600',
      letterSpacing: 0.5,
    },
    productRow: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: spacing[5],
      paddingVertical: spacing[4],
      backgroundColor: p.surface,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: p.border,
      gap: spacing[3],
      minHeight: 52,
    },
    firstRow: {
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: p.border,
    },
    lastRow: {
      borderBottomWidth: 0,
      marginBottom: spacing[1],
    },
    productName: {
      fontWeight: '500',
      lineHeight: 22,
    },
    qtyText: {
      fontSize: 15,
      fontWeight: '600',
      lineHeight: 22,
      textAlign: 'right',
      flexShrink: 0,
    },
  });
}
