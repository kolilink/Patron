import React, { useEffect, useRef, useMemo, useState } from 'react';
import { Animated, Modal, ScrollView, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Purchases from 'react-native-purchases';
import { Text } from '@/src/components/ui/Text';
import { Button } from '@/src/components/ui/Button';
import { useTheme, colors, radius, spacing } from '@/src/theme';
import type { Palette } from '@/src/theme';
import { isPurchasesConfigured } from '@/lib/purchases';

interface Props {
  businessName: string;
  trialEndsAt: string | null;
  onStart: () => void;
}

// Shown until RevenueCat Offerings are configured — see PaywallScreen.tsx's
// identical fallback and CLAUDE.md's IAP setup checklist.
const FALLBACK_MONTHLY_PRICE = '2,99$';

export function TrialWelcomeOverlay({ businessName, onStart }: Props) {
  const { palette } = useTheme();
  const styles = useMemo(() => makeStyles(palette), [palette]);
  const breathAnim = useRef(new Animated.Value(1)).current;
  const [monthlyPrice, setMonthlyPrice] = useState(FALLBACK_MONTHLY_PRICE);

  useEffect(() => {
    if (!isPurchasesConfigured()) return;
    Purchases.getOfferings()
      .then(offerings => {
        const price = offerings.current?.monthly?.product.priceString;
        if (price) setMonthlyPrice(price);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    const pulse = Animated.loop(
      Animated.sequence([
        Animated.timing(breathAnim, { toValue: 1.04, duration: 900, useNativeDriver: true }),
        Animated.timing(breathAnim, { toValue: 1,    duration: 900, useNativeDriver: true }),
      ]),
    );
    pulse.start();
    return () => pulse.stop();
  }, []);

  return (
    <Modal animationType="fade" transparent={false} visible>
      <SafeAreaView style={styles.safe}>
        <ScrollView
          contentContainerStyle={styles.container}
          showsVerticalScrollIndicator={false}
        >

          {/* Green checkmark — first thing the eye sees */}
          <View style={styles.checkCircle}>
            <Text style={styles.checkMark}>✓</Text>
          </View>

          {/* Identity */}
          <Text style={styles.bizName}>Félicitations 🎉</Text>
          <Text style={styles.bizSub}>{businessName} est en ligne</Text>

          {/* Single-line gift card */}
          <View style={styles.giftCard}>
            <Text style={styles.giftTitle}>🎁  Votre premier mois est offert</Text>
          </View>

          {/* Breathing CTA */}
          <Animated.View style={[styles.ctaWrapper, { transform: [{ scale: breathAnim }] }]}>
            <Button
              label="Découvrir ma boutique →"
              onPress={onStart}
              fullWidth
              size="lg"
            />
          </Animated.View>

          {/* Hero ROI line */}
          <Text style={styles.roiText}>
            Une seule dette récupérée ce mois et Patron se paye tout seul
          </Text>
          <Text style={styles.priceText}>
            Ensuite : {monthlyPrice} / mois — sans engagement
          </Text>

        </ScrollView>
      </SafeAreaView>
    </Modal>
  );
}

function makeStyles(p: Palette) {
  return StyleSheet.create({
    safe: {
      flex: 1,
      backgroundColor: p.background,
    },
    container: {
      flexGrow: 1,
      paddingHorizontal: spacing[7],
      paddingTop: spacing[16],
      paddingBottom: spacing[10],
      alignItems: 'center',
      justifyContent: 'center',
      gap: spacing[4],
    },

    checkCircle: {
      width: 72,
      height: 72,
      borderRadius: 36,
      borderWidth: 2.5,
      borderColor: colors.success[600],
      backgroundColor: colors.success[50],
      alignItems: 'center',
      justifyContent: 'center',
      marginBottom: spacing[2],
    },
    checkMark: {
      fontSize: 30,
      color: colors.success[600],
      fontWeight: '800',
    },

    bizName: {
      fontSize: 24,
      fontWeight: '800',
      color: p.textPrimary,
      textAlign: 'center',
      width: '100%',
    },
    bizSub: {
      fontSize: 15,
      color: p.textSecondary,
      marginTop: -spacing[2],
      marginBottom: spacing[2],
    },

    giftCard: {
      width: '100%',
      backgroundColor: colors.success[50],
      borderRadius: radius.xl,
      borderWidth: 1,
      borderColor: colors.success[100],
      paddingVertical: spacing[5],
      paddingHorizontal: spacing[6],
      alignItems: 'center',
    },
    giftTitle: {
      fontSize: 16,
      fontWeight: '700',
      color: colors.success[700],
    },

    ctaWrapper: {
      width: '100%',
      marginTop: spacing[2],
    },

    roiText: {
      fontSize: 13,
      color: p.textSecondary,
      textAlign: 'center',
      lineHeight: 20,
      fontStyle: 'italic',
    },
    priceText: {
      fontSize: 12,
      color: p.textSecondary,
      textAlign: 'center',
      marginTop: -spacing[2],
    },
  });
}
