import React, { useState } from 'react';
import { Linking, ScrollView, StyleSheet, Pressable, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Text } from '@/src/components/ui/Text';
import { Button } from '@/src/components/ui/Button';
import { colors, palette, radius, spacing } from '@/src/theme';
import type { Business } from '@/src/types';

const STRIPE_ANNUAL_LINK  = 'https://buy.stripe.com/6oU6oH0Bedks9mU7n7d3i01';
const STRIPE_MONTHLY_LINK = 'https://buy.stripe.com/4gM5kD5Vy8081UsePzd3i02';

type Plan = 'annual' | 'monthly';

interface Props {
  business: Business;
}

export function PaywallScreen({ business }: Props) {
  const [selected, setSelected] = useState<Plan>('monthly');

  const openStripe = () => {
    const base = selected === 'annual' ? STRIPE_ANNUAL_LINK : STRIPE_MONTHLY_LINK;
    Linking.openURL(`${base}?client_reference_id=${business.id}`);
  };

  return (
    <SafeAreaView style={styles.safe}>
      <ScrollView
        contentContainerStyle={styles.container}
        showsVerticalScrollIndicator={false}
      >
        <Text variant="h2" style={styles.logo}>Patron</Text>

        <Text variant="h3" style={styles.headline}>Ravi de vous revoir ! 🌟</Text>

        <Text variant="body" style={styles.sub}>
          Toutes vos données sont bien en sécurité.
        </Text>

        {/* Monthly — default hero */}
        <Pressable
          style={[styles.planCard, selected === 'monthly' && styles.planCardSelected]}
          onPress={() => setSelected('monthly')}
        >
          <View style={styles.planCardHeader}>
            <View style={styles.popularBadge}>
              <Text style={styles.popularText}>★  LE PLUS POPULAIRE</Text>
            </View>
            {selected === 'monthly' && <Text style={styles.selectedCheck}>✓</Text>}
          </View>
          <Text variant="h3" style={[styles.planPrice, selected === 'monthly' && styles.planPriceSelected]}>
            4,99$ / mois
          </Text>
          <Text variant="body" style={styles.planSub}>Facturé chaque mois — sans engagement</Text>
        </Pressable>

        {/* Annual — secondary */}
        <Pressable
          style={[styles.planCard, selected === 'annual' && styles.planCardSelected]}
          onPress={() => setSelected('annual')}
        >
          <View style={styles.planCardHeader}>
            <View style={{ flex: 1 }} />
            {selected === 'annual' && <Text style={styles.selectedCheck}>✓</Text>}
          </View>
          <Text variant="h3" style={[styles.planPrice, selected === 'annual' && styles.planPriceSelected]}>
            39,99$ / an
          </Text>
          <Text variant="body" style={styles.planSub}>Soit 3,33$ par mois</Text>
          <Text variant="caption" style={styles.planBonus}>3 mois offerts</Text>
        </Pressable>

        <Button
          label="Continuer l'aventure →"
          onPress={openStripe}
          fullWidth
          size="lg"
          style={styles.cta}
        />

        <Text style={styles.roiText}>
          Une seule dette récupérée ce mois, et Patron se paye tout seul.
        </Text>
        <Text style={styles.secureText}>Paiement sécurisé via Stripe · Annulez à tout moment</Text>

      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: palette.background,
  },
  container: {
    flexGrow: 1,
    paddingHorizontal: spacing[6],
    paddingTop: spacing[12],
    paddingBottom: spacing[10],
    alignItems: 'stretch',
  },
  logo: {
    color: palette.primary,
    textAlign: 'center',
    marginBottom: spacing[8],
  },
  headline: {
    textAlign: 'center',
    color: palette.textPrimary,
    marginBottom: spacing[3],
  },
  sub: {
    textAlign: 'center',
    color: palette.textSecondary,
    marginBottom: spacing[8],
  },
  planCard: {
    backgroundColor: palette.surface,
    borderRadius: radius.lg,
    borderWidth: 2,
    borderColor: palette.border,
    padding: spacing[5],
    marginBottom: spacing[4],
  },
  planCardSelected: {
    borderColor: palette.primary,
    backgroundColor: colors.primary[50],
  },
  planCardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: spacing[2],
    minHeight: 24,
  },
  popularBadge: { flex: 1 },
  popularText: {
    fontSize: 11,
    fontWeight: '700',
    color: palette.primary,
    letterSpacing: 0.5,
  },
  selectedCheck: {
    color: palette.primary,
    fontSize: 18,
    fontWeight: '700',
  },
  planPrice: {
    color: palette.textPrimary,
    marginBottom: spacing[1],
  },
  planPriceSelected: {
    color: palette.primary,
  },
  planSub: {
    color: palette.textSecondary,
  },
  planBonus: {
    color: palette.success,
    fontWeight: '700',
    marginTop: spacing[1],
  },
  cta: {
    marginTop: spacing[4],
    marginBottom: spacing[5],
  },
  roiText: {
    fontSize: 13,
    color: palette.textSecondary,
    textAlign: 'center',
    lineHeight: 20,
    fontStyle: 'italic',
    marginBottom: spacing[3],
  },
  secureText: {
    fontSize: 12,
    color: palette.textSecondary,
    textAlign: 'center',
  },
});
