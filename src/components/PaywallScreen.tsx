import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Animated, Easing, Linking, Platform, StyleSheet, Pressable, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import Purchases, { PurchasesPackage } from 'react-native-purchases';
import { Text } from '@/src/components/ui/Text';
import { Button } from '@/src/components/ui/Button';
import { Card } from '@/src/components/ui/Card';
import { useTheme, radius, spacing, typography } from '@/src/theme';
import type { Palette } from '@/src/theme';
import type { Business } from '@/src/types';
import { toast } from '@/stores/toast';
import { isPurchasesConfigured } from '@/lib/purchases';
import { useAuthStore } from '@/stores/auth';

const PRIVACY_URL = 'https://patron.kolilink.com/privacy.html';

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
// v_limit (db/migration_v146.sql) — bump this alongside that SQL constant if
// it ever changes.
const PAID_DAILY_LIMIT = 100;

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

  // "Google Play", not "Google Pay" — a different product. Neither label is
  // literally accurate (native IAP subscriptions never touch Apple Pay/
  // PassKit or a Google Pay wallet either), but "Google Play" at least names
  // the real billing system; "Apple Pay" doesn't have an equivalent honest
  // substitute with the same brand recognition, so it's used as requested.
  // Rendered as "Payer via [logo] Pay/Play" — Button only supports a single
  // leading icon before its whole label, not one embedded mid-sentence, so
  // this whole row is passed through Button's `icon` slot with an empty
  // label instead, rather than modifying the shared component.
  const payButtonContent = (
    <View style={styles.payRow}>
      <Text style={styles.payRowText}>Payer via</Text>
      <Ionicons
        name={Platform.OS === 'ios' ? 'logo-apple' : 'logo-google'}
        size={17}
        color={palette.textInverse}
      />
      <Text style={styles.payRowText}>{Platform.OS === 'ios' ? 'Pay' : 'Play'}</Text>
    </View>
  );

  // Silent restore check on mount — a real subscriber who lands here (e.g.
  // after a reinstall, before RevenueCat's local cache has synced) should
  // never have to remember to tap "Restaurer mes achats" themselves. Errors
  // (most commonly "nothing to restore") are swallowed on purpose — this is
  // a background check, not a user-initiated action, so it must never
  // surface a toast the way the manual restore() below does.
  useEffect(() => {
    if (!isPurchasesConfigured()) return;
    Purchases.restorePurchases()
      .then(async () => {
        await refreshActiveBusiness();
        onPurchased?.();
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
      // Purchases.purchasePackage() resolving IS Apple/Google's own proof
      // the payment succeeded — that's already enough to unlock the screen.
      // subscription_status itself is written server-side by
      // supabase/functions/revenuecat-webhook, asynchronously, so it must
      // never gate the success transition: the webhook can land a moment
      // after this promise resolves, and blocking onPurchased() on
      // refreshActiveBusiness() finishing first meant a user could pay
      // successfully and still briefly see the paywall as if nothing
      // happened, with no automatic retry. Fired in the background instead.
      setPurchasing(false);
      onPurchased?.();
      void refreshActiveBusiness();
    } catch (err) {
      const cancelled = (err as { userCancelled?: boolean })?.userCancelled;
      if (!cancelled) {
        toast.warning('Achat impossible pour le moment. Réessayez.');
      }
      setPurchasing(false);
    }
  };

  if (inline) {
    return (
      <Card style={styles.inlineCard}>
        <Text variant="h4" style={styles.inlineHeadline}>Obtenez la réponse à votre question</Text>

        <Text variant="label" color="secondary" style={styles.sectionLabel}>ABONNEMENT</Text>
        <View style={styles.planTile}>
          <View style={styles.planTileRadioOuter}>
            <View style={styles.planTileRadioInner} />
          </View>
          <View style={styles.planTileTextWrap}>
            <Text variant="label" style={styles.planName}>Alpha Pro</Text>
            <Text variant="h3" style={styles.planPrice}>{monthlyPrice}<Text variant="body" color="secondary"> / mois</Text></Text>
            <Text variant="caption" color="secondary" style={styles.planLimit}>
              {PAID_DAILY_LIMIT} conversations avec Alpha, chaque jour
            </Text>
          </View>
        </View>

        <Animated.View style={{ width: '100%', transform: [{ scale: breathScale }] }}>
          <Button
            label={purchasing ? 'Un instant…' : ''}
            icon={!purchasing ? payButtonContent : undefined}
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
      {/* Two zones, like the reference: a distinct header panel (icon + name
          + close) on its own surface with a bottom divider, then the rest
          of the content below on the plain background. */}
      <View style={styles.headerPanel}>
        {onDismiss && (
          <Pressable onPress={onDismiss} hitSlop={12} style={styles.closeBtn}>
            <Ionicons name="close" size={22} color={palette.textSecondary} />
          </Pressable>
        )}
        <View style={styles.iconBadge}>
          <Text style={styles.iconBadgeText}>A</Text>
        </View>
        <Text variant="label" style={styles.brandName}>ALPHA PRO</Text>
        <Text variant="body" style={styles.headerTagline}>Obtenez la réponse à votre question</Text>
      </View>

      <View style={styles.container}>
        {/* Selector kept, just toned down — muted/neutral instead of bold
            primary. There's only one plan, but the selected-radio affordance
            still reads well; it's the loud coloring that was the problem. */}
        <Text variant="label" color="secondary" style={styles.sectionLabel}>ABONNEMENT</Text>
        <View style={styles.planTile}>
          <View style={styles.planTileRadioOuter}>
            <View style={styles.planTileRadioInner} />
          </View>
          <View style={styles.planTileTextWrap}>
            <Text variant="label" style={styles.planName}>Alpha Pro</Text>
            <Text variant="h3" style={styles.planPrice}>{monthlyPrice}<Text variant="body" color="secondary"> / mois</Text></Text>
            <Text variant="caption" color="secondary" style={styles.planLimit}>
              {PAID_DAILY_LIMIT} conversations avec Alpha, chaque jour
            </Text>
          </View>
        </View>

        <Animated.View style={{ width: '100%', transform: [{ scale: breathScale }] }}>
          <Button
            label={purchasing ? 'Un instant…' : ''}
            icon={!purchasing ? payButtonContent : undefined}
            onPress={purchase}
            disabled={purchasing}
            fullWidth
            size="lg"
            style={styles.cta}
          />
        </Animated.View>

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
      </View>
    </SafeAreaView>
  );
}

function makeStyles(p: Palette) {
  return StyleSheet.create({
    safe: {
      flex: 1,
      backgroundColor: p.background,
    },
    // Header panel: a distinct zone (its own surface + hairline divider)
    // holding just the icon, name, and close button — mirrors the
    // reference's light banner up top, everything else sits below it.
    headerPanel: {
      alignItems: 'center',
      backgroundColor: p.surface,
      borderBottomWidth: 1,
      borderBottomColor: p.border,
      paddingTop: spacing[12],
      paddingBottom: spacing[6],
    },
    closeBtn: {
      position: 'absolute',
      top: spacing[3],
      left: spacing[4],
      zIndex: 1,
      padding: spacing[2],
    },
    container: {
      flex: 1,
      paddingHorizontal: spacing[6],
      paddingTop: spacing[8],
      paddingBottom: spacing[8],
      justifyContent: 'center',
      alignItems: 'stretch',
    },
    iconBadge: {
      width: 56,
      height: 56,
      borderRadius: radius.lg,
      backgroundColor: p.primary,
      alignItems: 'center',
      justifyContent: 'center',
      marginBottom: spacing[2],
    },
    iconBadgeText: {
      color: p.textInverse,
      fontSize: 26,
      fontWeight: '800',
    },
    brandName: {
      color: p.textSecondary,
      letterSpacing: 1.5,
      fontSize: 12,
    },
    headerTagline: {
      textAlign: 'center',
      color: p.textPrimary,
      fontWeight: '700',
      marginTop: spacing[2],
      paddingHorizontal: spacing[6],
    },
    sectionLabel: {
      letterSpacing: 0.5,
      fontSize: 11,
      marginBottom: spacing[2],
    },
    // Selector kept, deliberately muted — no bold colored border/background
    // box, just a hairline outline and a neutral-toned radio dot, so the
    // "this is selected" affordance survives without the loud coloring.
    planTile: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing[3],
      borderWidth: 1,
      borderColor: p.border,
      borderRadius: radius.lg,
      padding: spacing[4],
      marginBottom: spacing[6],
    },
    planTileRadioOuter: {
      width: 20,
      height: 20,
      borderRadius: 10,
      borderWidth: 2,
      borderColor: p.textSecondary,
      alignItems: 'center',
      justifyContent: 'center',
    },
    planTileRadioInner: {
      width: 10,
      height: 10,
      borderRadius: 5,
      backgroundColor: p.textSecondary,
    },
    planTileTextWrap: {
      flex: 1,
    },
    planName: {
      color: p.textSecondary,
      textTransform: 'uppercase',
      letterSpacing: 0.5,
      fontSize: 11,
      marginBottom: spacing[1],
    },
    planPrice: {
      color: p.textPrimary,
      marginBottom: spacing[1],
    },
    planLimit: {
      color: p.textSecondary,
    },
    cta: {
      marginTop: spacing[2],
      marginBottom: spacing[3],
    },
    payRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing[1],
    },
    payRowText: {
      ...typography.labelLarge,
      color: p.textInverse,
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
      alignItems: 'stretch',
    },
    inlineHeadline: {
      textAlign: 'center',
      color: p.textPrimary,
      marginBottom: spacing[1],
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
