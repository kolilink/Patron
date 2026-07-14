import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Animated, Easing, Linking, ScrollView, StyleSheet, Pressable, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import Purchases, { PurchasesPackage } from 'react-native-purchases';
import { Text } from '@/src/components/ui/Text';
import { Button } from '@/src/components/ui/Button';
import { Card } from '@/src/components/ui/Card';
import { useTheme, radius, spacing } from '@/src/theme';
import type { Palette } from '@/src/theme';
import type { Business } from '@/src/types';
import { toast } from '@/stores/toast';
import { isPurchasesConfigured } from '@/lib/purchases';
import { useAuthStore } from '@/stores/auth';

const PRIVACY_URL = 'https://patron.kolilink.com/privacy.html';

// The concrete, provable reasons Alpha is worth paying for — each one maps
// to a real mechanism in alpha-chat/get_reports_snapshot/get_stock_velocity
// (see CLAUDE.md's "Alpha" section), not a generic AI-assistant claim. Kept
// to 3: past that, a value stack stops persuading and starts diluting.
const VALUE_STACK: { icon: keyof typeof Ionicons.glyphMap; title: string; body: string }[] = [
  {
    icon: 'stats-chart-outline',
    title: 'Vos vrais chiffres, pas des suppositions',
    body: "Chaque réponse est calculée sur vos ventes et votre stock réels.",
  },
  {
    icon: 'cube-outline',
    title: "Les ruptures, vues à l'avance",
    body: 'Alpha repère les produits qui vont manquer avant que ça arrive.',
  },
  {
    icon: 'wallet-outline',
    title: 'Votre argent, expliqué simplement',
    body: 'Ventes, dépenses, profit — clairs en une phrase, chaque jour.',
  },
];

interface Props {
  business: Business;
  // Set only when this screen was opened voluntarily from the TrialBanner
  // (app/(app)/_layout.tsx) to preview pricing, or dismissed from the
  // Alpha inline upsell card below.
  onDismiss?: () => void;
  // Renders a compact embedded card instead of the full-screen layout — used
  // by the Alpha chat screen (app/(app)/alpha/index.tsx) when the free
  // ration runs out mid-conversation, so the still-visible conversation
  // stays on screen behind it instead of a route-level swap (see CLAUDE.md's
  // "trigger the upsell at the exact moment of intent").
  inline?: boolean;
  onPurchased?: () => void;
}

// Fallback display price, shown until RevenueCat Offerings are configured
// (App Store Connect + Play Console products + RevenueCat dashboard — see
// CLAUDE.md's IAP setup checklist). Once configured, the real localized
// price from Purchases.getOfferings() is used instead everywhere below.
// Deliberately has no " / mois" suffix — every render site (full-screen plan
// card, inline card) already appends " / mois" itself, same as it does for
// the real RevenueCat priceString (which also has no period suffix); baking
// it into this constant duplicated it into "2,99$ / mois / mois".
const FALLBACK_MONTHLY_PRICE = '2,99$';

// Stated honestly rather than marketed as "Illimité" — a paying user who
// eventually hits a silent cap after being sold "unlimited" is a worse trust
// break than a concrete, generous-sounding number up front (Hormozi:
// specificity sells better than vague hype, and never oversell what you
// can't back). Mirrors send_alpha_message/get_alpha_quota_status's paid-tier
// v_limit (db/migration_v135.sql) — bump this alongside that SQL constant if
// it ever changes.
const PAID_DAILY_LIMIT = 20;

// Delay before the breathing CTA (below) starts pulsing — overridden down
// from an initial reading-time-based estimate (~18s, based on ~73 words of
// copy above the CTA at ~240 wpm) to a flat 5s on explicit product direction.
const BREATHE_START_DELAY_MS = 5_000;

// "Breathing" cadence deliberately matches a resting human breath (~12-16
// breaths/min → ~4s per inhale+exhale cycle), not a fast attention-grabbing
// pulse — a quicker rhythm reads as urgent/alarming rather than inviting.
const BREATH_HALF_CYCLE_MS = 2_000;

export function PaywallScreen({ business, onDismiss, inline = false, onPurchased }: Props) {
  const { palette } = useTheme();
  const styles = useMemo(() => makeStyles(palette), [palette]);
  const [purchasing, setPurchasing] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [monthlyPkg, setMonthlyPkg] = useState<PurchasesPackage | null>(null);
  const refreshActiveBusiness = useAuthStore(s => s.refreshActiveBusiness);

  useEffect(() => {
    if (!isPurchasesConfigured()) return;
    Purchases.getOfferings()
      .then(offerings => {
        const current = offerings.current;
        if (!current) return;
        setMonthlyPkg(current.monthly ?? null);
      })
      .catch(err => {
        if (__DEV__) console.warn('[paywall] getOfferings failed:', err);
      });
  }, []);

  const monthlyPrice = monthlyPkg?.product.priceString ?? FALLBACK_MONTHLY_PRICE;

  // Breathing-CTA animation state — runs for both the full-screen paywall
  // and the inline mid-chat card, since the inline card is the one users
  // actually hit in the real quota-exhaustion flow.
  const [breathing, setBreathing] = useState(false);
  const breathScale = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    const startTimer = setTimeout(() => setBreathing(true), BREATHE_START_DELAY_MS);
    return () => clearTimeout(startTimer);
  }, []);

  useEffect(() => {
    if (!breathing) return;
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(breathScale, { toValue: 1.04, duration: BREATH_HALF_CYCLE_MS, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
        Animated.timing(breathScale, { toValue: 1, duration: BREATH_HALF_CYCLE_MS, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [breathing, breathScale]);

  // Smallest-increment framing (a well-worn pricing trick: $2.99/mo reads as
  // expensive, $0.10/day reads as free — see the "display price in the
  // smallest increment, bill on the longest" note in the pricing playbook).
  // Computed from the real store product when available so it's never a
  // stale hardcoded number; falls back to the known $2.99 fallback price.
  const dailyPrice = useMemo(() => {
    if (monthlyPkg) {
      try {
        return new Intl.NumberFormat('fr-FR', {
          style: 'currency',
          currency: monthlyPkg.product.currencyCode,
          maximumFractionDigits: 2,
        }).format(monthlyPkg.product.price / 30);
      } catch {
        return null;
      }
    }
    return '0,10$';
  }, [monthlyPkg]);

  const restore = async () => {
    if (!isPurchasesConfigured()) {
      toast.warning('Restauration indisponible pour le moment.');
      return;
    }
    setRestoring(true);
    try {
      await Purchases.restorePurchases();
      await refreshActiveBusiness();
      toast.success('Achats restaurés.');
      onPurchased?.();
    } catch {
      toast.warning('Aucun achat trouvé à restaurer sur ce compte.');
    } finally {
      setRestoring(false);
    }
  };

  const purchase = async () => {
    if (!isPurchasesConfigured() || !monthlyPkg) {
      // RevenueCat/App Store Connect/Play Console aren't fully set up yet —
      // fail loudly in dev, quietly (no crash) in production.
      if (__DEV__) {
        toast.warning('Abonnement pas encore configuré (RevenueCat) — voir CLAUDE.md.');
      } else {
        toast.warning('Abonnement indisponible pour le moment. Réessayez plus tard.');
      }
      return;
    }

    setPurchasing(true);
    try {
      await Purchases.purchasePackage(monthlyPkg);
      // subscription_status itself is written server-side by
      // supabase/functions/revenuecat-webhook, not here — refresh so
      // has_ai_access() (db/migration_v133.sql) sees it as soon as the
      // webhook lands, then let the caller (e.g. Alpha's pending-question
      // auto-send) retry.
      await refreshActiveBusiness();
      onPurchased?.();
    } catch (err) {
      const cancelled = (err as { userCancelled?: boolean })?.userCancelled;
      if (!cancelled) {
        toast.warning('Achat impossible pour le moment. Réessayez.');
      }
    } finally {
      setPurchasing(false);
    }
  };

  if (inline) {
    return (
      <Card style={styles.inlineCard}>
        <Text variant="h4" style={styles.inlineHeadline}>Obtenez la réponse à votre question</Text>
        <View style={styles.inlineValueRow}>
          <Ionicons name="chatbubbles-outline" size={16} color={palette.primary} />
          <Text variant="bodySmall" color="secondary" style={styles.inlineValueText}>
            {PAID_DAILY_LIMIT} conversations avec Alpha, chaque jour.
          </Text>
        </View>
        <Text variant="caption" color="secondary" style={styles.inlinePrice}>
          {monthlyPrice} / mois — sans engagement
        </Text>
        <Animated.View style={{ width: '100%', transform: [{ scale: breathScale }] }}>
          <Button
            label={purchasing ? 'Un instant…' : `Investir — ${monthlyPrice}`}
            onPress={purchase}
            disabled={purchasing}
            fullWidth
            size="md"
          />
        </Animated.View>
        <Text variant="caption" color="secondary" style={styles.inlineUrgency}>
          Vous aurez accès immédiatement
        </Text>
        {onDismiss && (
          <Button
            label="Plus tard"
            onPress={onDismiss}
            variant="ghost"
            size="sm"
            fullWidth
            style={styles.inlineDismiss}
          />
        )}
      </Card>
    );
  }

  return (
    <SafeAreaView style={styles.safe}>
      <ScrollView
        contentContainerStyle={styles.container}
        showsVerticalScrollIndicator={false}
      >
        <Text variant="h3" style={styles.logo}>Alpha</Text>

        <Text variant="h2" style={styles.headline}>Sachez toujours où va votre argent.</Text>

        <Text variant="body" style={styles.sub}>
          Alpha lit vos ventes, votre stock et votre trésorerie en temps réel — et vous répond en secondes, dans vos mots.
        </Text>

        <View style={styles.valueStack}>
          {VALUE_STACK.map(item => (
            <View key={item.title} style={styles.valueRow}>
              <View style={styles.valueIconWrap}>
                <Ionicons name={item.icon} size={18} color={palette.primary} />
              </View>
              <View style={styles.valueTextWrap}>
                <Text variant="label" style={styles.valueTitle}>{item.title}</Text>
                <Text variant="bodySmall" color="secondary">{item.body}</Text>
              </View>
            </View>
          ))}
        </View>

        <View style={styles.planCard}>
          <Text variant="label" style={styles.planName}>Alpha Pro</Text>
          <Text variant="h3" style={styles.planPrice}>{monthlyPrice}<Text variant="body" color="secondary"> / mois</Text></Text>
          {dailyPrice && (
            <Text variant="caption" color="secondary" style={styles.planDaily}>
              soit environ {dailyPrice} par jour
            </Text>
          )}
          <Text variant="body" style={styles.planLimit}>{PAID_DAILY_LIMIT} conversations avec Alpha, chaque jour</Text>
        </View>

        <Animated.View style={{ width: '100%', transform: [{ scale: breathScale }] }}>
          <Button
            label={purchasing ? 'Un instant…' : "Investir — Alpha Pro →"}
            onPress={purchase}
            disabled={purchasing}
            fullWidth
            size="lg"
            style={styles.cta}
          />
        </Animated.View>

        <View style={styles.guaranteeRow}>
          <Ionicons name="shield-checkmark-outline" size={15} color={palette.textSecondary} />
          <Text style={styles.guaranteeText}>Annulez en 1 clic • Paiement sécurisé Apple / Google</Text>
        </View>

        <Text style={styles.roiText}>
          Un seul conseil d'Alpha qui vous évite une rupture de stock, et l'abonnement est déjà rentable.
        </Text>

        {onDismiss && (
          <Button
            label="Plus tard"
            onPress={onDismiss}
            variant="outline"
            size="md"
            fullWidth
            style={styles.laterButton}
          />
        )}

        <View style={styles.footerLinks}>
          <Pressable onPress={restore} disabled={restoring} hitSlop={8}>
            <Text style={styles.footerLinkText}>
              {restoring ? 'Restauration…' : 'Restaurer mes achats'}
            </Text>
          </Pressable>
          <Text style={styles.footerDot}>·</Text>
          <Pressable onPress={() => Linking.openURL(PRIVACY_URL)} hitSlop={8}>
            <Text style={styles.footerLinkText}>Confidentialité</Text>
          </Pressable>
        </View>

      </ScrollView>
    </SafeAreaView>
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
      paddingHorizontal: spacing[6],
      paddingTop: spacing[12],
      paddingBottom: spacing[10],
      alignItems: 'stretch',
    },
    logo: {
      color: p.primary,
      textAlign: 'center',
      marginBottom: spacing[6],
    },
    headline: {
      textAlign: 'center',
      color: p.textPrimary,
      marginBottom: spacing[3],
    },
    sub: {
      textAlign: 'center',
      color: p.textSecondary,
      marginBottom: spacing[6],
    },
    valueStack: {
      gap: spacing[4],
      marginBottom: spacing[7],
    },
    valueRow: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      gap: spacing[3],
    },
    valueIconWrap: {
      width: 32,
      height: 32,
      borderRadius: radius.md,
      backgroundColor: p.primaryLight,
      alignItems: 'center',
      justifyContent: 'center',
      marginTop: 1,
    },
    valueTextWrap: {
      flex: 1,
      gap: 2,
    },
    valueTitle: {
      color: p.textPrimary,
    },
    planCard: {
      backgroundColor: p.surface,
      borderRadius: radius.lg,
      borderWidth: 2,
      borderColor: p.primary,
      padding: spacing[5],
      marginBottom: spacing[5],
      alignItems: 'center',
    },
    planName: {
      color: p.textSecondary,
      textTransform: 'uppercase',
      letterSpacing: 0.5,
      fontSize: 11,
      marginBottom: spacing[2],
    },
    planPrice: {
      color: p.primary,
      marginBottom: spacing[1],
    },
    planDaily: {
      marginBottom: spacing[2],
    },
    planLimit: {
      color: p.textSecondary,
    },
    cta: {
      marginTop: spacing[2],
      marginBottom: spacing[3],
    },
    guaranteeRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: spacing[1],
      marginBottom: spacing[4],
    },
    guaranteeText: {
      fontSize: 12,
      color: p.textSecondary,
    },
    roiText: {
      fontSize: 13,
      color: p.textSecondary,
      textAlign: 'center',
      lineHeight: 20,
      fontStyle: 'italic',
      marginBottom: spacing[4],
    },
    laterButton: {
      marginTop: spacing[3],
    },
    footerLinks: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: spacing[2],
      marginTop: spacing[6],
    },
    footerLinkText: {
      fontSize: 11,
      color: p.textSecondary,
    },
    footerDot: {
      fontSize: 11,
      color: p.textSecondary,
    },

    inlineCard: {
      margin: spacing[4],
      gap: spacing[2],
      alignItems: 'center',
    },
    inlineHeadline: {
      textAlign: 'center',
      color: p.textPrimary,
    },
    inlineValueRow: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      gap: spacing[2],
      paddingHorizontal: spacing[2],
      marginBottom: spacing[1],
    },
    inlineValueText: {
      flex: 1,
      textAlign: 'left',
    },
    inlinePrice: {
      textAlign: 'center',
      marginBottom: spacing[2],
    },
    inlineUrgency: {
      textAlign: 'center',
      marginTop: spacing[2],
    },
    inlineDismiss: {
      marginTop: spacing[2],
    },
  });
}
