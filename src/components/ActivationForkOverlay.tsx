import { useEffect, useMemo, useRef } from 'react';
import { Animated, BackHandler, Modal, Pressable, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { Button } from '@/src/components/ui/Button';
import { Text } from '@/src/components/ui/Text';
import { useTheme, spacing } from '@/src/theme';
import type { Palette } from '@/src/theme';
import { useAuthStore } from '@/stores/auth';

interface Props {
  userName?: string | null;
  onSelectProduct: () => void;
  onSelectSale: () => void;
  onSelectDebt: () => void;
}

// Full-screen, non-dismissible overlay shown the moment a business is
// created, and again on any return visit while it's still completely empty
// and under 24h old (see the showFork condition in app/(app)/_layout.tsx,
// which derives this purely from product/sale counts + business age — no
// stored flag to arm/clear, so it reappears on its own if the merchant
// backs out of a sub-flow without finishing, and disappears on its own the
// moment any of the three actions is actually completed). Evaluated at the
// root layout, not any one screen, specifically so it can show on top of
// ANY screen the merchant ends up on, not just Accueil.
//
// Three buttons, no "not now" — forcing one real choice here is what gets a
// merchant to their first product/sale/debt instead of landing on an empty
// dashboard they can quietly ignore. But "no bail-out" was originally
// designed around someone with exactly one business — anyone administering
// more than one (the founder's test businesses, but also any real admin or
// team member who joins/creates a second one) could land on an empty
// business and be fully trapped, with no way to even reach their OTHER,
// real businesses. The business-name row below is the deliberate exception:
// switching businesses isn't "avoiding the fork" the way dismissing it
// would be — it's a legitimate different action, and the fork for THIS
// business is still exactly as forced as before once they're back on it.
export function ActivationForkOverlay({ userName, onSelectProduct, onSelectSale, onSelectDebt }: Props) {
  const { palette } = useTheme();
  const insets = useSafeAreaInsets();
  const styles = useMemo(() => makeStyles(palette), [palette]);
  const businessName = useAuthStore(s => s.session?.activeBusiness?.name);
  const hasOtherBusinesses = useAuthStore(s => (s.session?.memberships.length ?? 0) > 1);
  const businessDrawerFullyClosed = useAuthStore(s => s.businessDrawerFullyClosed);
  const openBusinessDrawer = useAuthStore(s => s.openBusinessDrawer);

  // One-time staggered entrance — each button settles ~90ms after the
  // previous one, then everything sits still. Not a loop: this screen may
  // sit on-screen for a few seconds while they decide, and continuous
  // motion would just burn battery/CPU on a low-end device for no one still
  // watching it.
  const anims = useRef([0, 1, 2].map(() => new Animated.Value(0))).current;
  useEffect(() => {
    Animated.stagger(
      90,
      anims.map(v => Animated.timing(v, { toValue: 1, duration: 260, useNativeDriver: true })),
    ).start();
  }, [anims]);

  // No dismiss path on this screen — block Android hardware back to match.
  // Only while this Modal is actually the visible one, though: while the
  // drawer is open OR still mid-close-animation, a lingering unconditional
  // listener here would keep swallowing back-press events and silently
  // block the drawer's own standard "back closes it" behavior.
  useEffect(() => {
    if (!businessDrawerFullyClosed) return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => true);
    return () => sub.remove();
  }, [businessDrawerFullyClosed]);

  const buttonStyle = (i: number) => ({
    opacity: anims[i],
    transform: [{ translateY: anims[i].interpolate({ inputRange: [0, 1], outputRange: [16, 0] }) }],
  });

  return (
    <Modal
      animationType="fade"
      transparent={false}
      // Two independent <Modal>s both visible at once is unreliable — most
      // visibly on Android, where a second RN Modal doesn't reliably stack
      // on top of (or receive touches over) a first one that's still shown.
      // Gated on businessDrawerFullyClosed, not the raw open/close intent —
      // BusinessDrawer's own close has a ~300ms slide-out animation, so its
      // Modal is still genuinely visible for a moment after close is first
      // requested. Flipping this Modal to visible=true during that window
      // put two Modals on screen simultaneously: touches got swallowed by
      // whichever one the OS considered topmost, while neither one clearly
      // rendered — the drawer was sliding away, the fork hadn't taken over
      // yet. Waiting for the real "fully closed" signal closes that gap.
      visible={businessDrawerFullyClosed}
      statusBarTranslucent
      navigationBarTranslucent
      backdropColor={palette.background}
    >
      <View style={[styles.safe, { paddingBottom: insets.bottom }]}>
        {businessName && hasOtherBusinesses && (
          // Explicit insets.top + a real buffer on top of it, not just
          // SafeAreaView's default inset plus a small fixed padding — the
          // bare inset alone wasn't enough clearance for cases where the
          // Dynamic Island itself is taller than resting state (an active
          // call or recording widget expands it), which briefly overlapped
          // this row with the status bar/island on a real device.
          <Pressable
            onPress={openBusinessDrawer}
            style={[styles.switcher, { paddingTop: insets.top + spacing[4] }]}
            hitSlop={8}
          >
            <Text variant="label" color="secondary" numberOfLines={1} style={{ flex: 1 }}>{businessName}</Text>
            <Ionicons name="chevron-down" size={16} color={palette.textSecondary} />
          </Pressable>
        )}
        <View style={styles.container}>
          <View style={styles.topSpacer} />
          <View style={{ gap: spacing[8] }}>
            <View style={styles.header}>
              {userName ? <Text variant="body" color="secondary">Bonjour, {userName}</Text> : null}
              <Text variant="h2">On enregistre quoi aujourd'hui ?</Text>
            </View>

            <View style={styles.buttons}>
              <Animated.View style={buttonStyle(0)}>
                <Button
                  label="Un produit"
                  icon={<Ionicons name="bag-handle-outline" size={20} color={palette.textInverse} />}
                  onPress={onSelectProduct}
                  size="lg"
                  fullWidth
                />
              </Animated.View>
              <Animated.View style={buttonStyle(1)}>
                <Button
                  label="Une vente"
                  icon={<MaterialCommunityIcons name="hand-coin-outline" size={20} color={palette.textInverse} />}
                  onPress={onSelectSale}
                  size="lg"
                  fullWidth
                />
              </Animated.View>
              <Animated.View style={buttonStyle(2)}>
                <Button
                  label="Une dette"
                  icon={<Ionicons name="book-outline" size={20} color={palette.textInverse} />}
                  onPress={onSelectDebt}
                  size="lg"
                  fullWidth
                />
              </Animated.View>
            </View>
          </View>
          <View style={styles.bottomSpacer} />
        </View>
      </View>
    </Modal>
  );
}

function makeStyles(p: Palette) {
  return StyleSheet.create({
    safe: { flex: 1, backgroundColor: p.background },
    switcher: {
      flexDirection: 'row', alignItems: 'center', gap: spacing[1],
      paddingHorizontal: spacing[7],
    },
    container: { flex: 1, paddingHorizontal: spacing[7] },
    // Dead-center read as "floating in too much empty space" once tried —
    // this leans the same centered block slightly above true center instead
    // of pinning it near the top, closer to where a centered dialog is
    // normally expected to sit.
    topSpacer: { flex: 0.8 },
    bottomSpacer: { flex: 1.2 },
    header: { gap: spacing[2] },
    buttons: { gap: spacing[3] },
  });
}
