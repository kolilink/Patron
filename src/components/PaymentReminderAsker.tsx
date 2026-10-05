import { useCallback, useEffect, useRef, useState } from 'react';
import { Dimensions, Pressable, StyleSheet, View } from 'react-native';
import { useFocusEffect } from 'expo-router';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withTiming,
  withSpring,
  withDelay,
  withSequence,
  runOnJS,
  Easing,
} from 'react-native-reanimated';
import { useReduceMotion } from '@/src/hooks/useReduceMotion';
import { Ionicons } from '@expo/vector-icons';
import { Text } from '@/src/components/ui/Text';
import { Button } from '@/src/components/ui/Button';
import { useTheme, radius, spacing } from '@/src/theme';
import { useAuthStore } from '@/stores/auth';
import { supabase } from '@/lib/supabase';
import { getKV, setKV } from '@/lib/db';
import { toast } from '@/stores/toast';
import { checkNotificationPermission, requestNotificationPermission } from '@/src/components/NotificationSetup';

const SCREEN_HEIGHT = Dimensions.get('window').height;
const SHEET_MAX_HEIGHT = SCREEN_HEIGHT * 0.6;

const SETTLE_MS = 1500;
const FOCUS_WINDOW_MS = 10 * 60_000; // no credit recorded in this session or the last 10 minutes
const MAX_DISMISSALS = 3;
const DISMISS_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;

function dismissCountKey(userId: string) { return `debt_asker_dismiss_count_${userId}`; }
function lastDismissKey(userId: string) { return `debt_asker_last_dismiss_at_${userId}`; }
// Read by the inline denied-explainer card (see DebtReminderDeniedCard below)
// — set here the instant the OS prompt actually comes back denied, so the
// card knows to show itself even though it lives in a completely separate
// part of the Accueil tree.
export function deniedExplainerPendingKey(userId: string) { return `debt_asker_denied_pending_${userId}`; }

interface Props {
  businessId: string;
  userId: string;
  // Only administrateur/manager ever receive debt_aging_reminder pushes
  // (see send-debt-reminders' target_roles) — asking a vendeur/investisseur
  // to grant notification permission for a reminder they'll never get would
  // be pointless, so the parent only renders this for those two roles.
  active: boolean;
  // True while any of Accueil's own sheets (QuickCaptureSheet, the debt-CTA
  // capture) are open. Checked live, right before actually showing — not
  // just at the moment the fresh-session token changes — since one of those
  // can open at any point during the 1.5s settle wait. This is the same
  // "two Modals racing" bug class NotificationPrimer's own notifPrimerBlocking
  // and ActivationForkOverlay's suppressActivationFork already exist to
  // avoid elsewhere in this app; this sheet only ever appears on Accueil, so
  // checking Accueil's own two sheet-open flags covers the realistic cases.
  blocked: boolean;
  // Called right after a real OS denial. DebtReminderDeniedCard mounts
  // alongside this component at Accueil's very first render, long before any
  // denial can happen — its own mount-time check would find nothing pending
  // and never look again on its own (denial doesn't cause a real
  // react-navigation focus change, so a useFocusEffect wouldn't catch it
  // either). This callback is what actually tells it to re-check right now.
  onDenied?: () => void;
}

// The permission-priming sheet for the one v1 notification type this app
// sends on a schedule rather than in direct response to an action: a payment
// reminder when a client's debt crosses the 7-day ("attention") or 30-day
// ("urgent") aging tier already established in src/utils/clientReminder.ts.
//
// Deliberately a second, independent priming surface from NotificationPrimer
// (shown once, right after onboarding, with a generic digest/milestone
// pitch) — not a replacement. If that first ask was dismissed with "Plus
// tard" (which never touches the OS permission at all, by design — see its
// own comment), the real OS status stays "not determined" and this sheet is
// free to make a second, better-timed, more specific ask once there's
// actually a debt story to tell. Both independently check the LIVE OS
// permission status before ever showing themselves, so whichever one
// successfully resolves it (granted or denied) makes the other permanently
// inert going forward — no coordination between them is needed beyond that.
export function PaymentReminderAsker({ businessId, userId, active, blocked, onDenied }: Props) {
  const { palette } = useTheme();
  const [visible, setVisible] = useState(false);
  const freshSessionToken = useAuthStore(s => s.freshSessionToken);
  const lastTokenRef = useRef<number | null>(null);
  const isFocusedRef = useRef(false);
  const blockedRef = useRef(blocked);
  useEffect(() => { blockedRef.current = blocked; }, [blocked]);
  const evaluatingRef = useRef(false);

  useFocusEffect(
    useCallback(() => {
      isFocusedRef.current = true;
      return () => { isFocusedRef.current = false; };
    }, []),
  );

  const evaluate = useCallback(async () => {
    if (evaluatingRef.current) return;
    evaluatingRef.current = true;
    try {
      // OS permission must be genuinely undetermined — already granted,
      // already hard-denied, or the native module not being linked yet all
      // mean there's nothing this sheet could productively ask for. This
      // also naturally covers Android <= 13, where the OS itself reports
      // notifications as already granted with no runtime prompt involved.
      const perm = await checkNotificationPermission();
      if (!perm || perm.granted || !perm.canAskAgain) return;

      const [countStr, lastDismissStr] = await Promise.all([
        getKV(dismissCountKey(userId)),
        getKV(lastDismissKey(userId)),
      ]);
      const count = parseInt(countStr ?? '0', 10);
      if (count >= MAX_DISMISSALS) return;
      if (lastDismissStr) {
        const last = parseInt(lastDismissStr, 10);
        if (!Number.isNaN(last) && Date.now() - last < DISMISS_COOLDOWN_MS) return;
      }

      // One query covers two conditions at once: at least 2 rows returned
      // means "≥ 2 credits ever recorded" (is_credit is a permanent flag,
      // set at creation, that survives a later status flip to 'paye' —
      // see migration_v6.sql — so this reads lifetime credits, not just
      // currently-outstanding ones); the newest row's created_at covers
      // "no credit recorded in this session or the last 10 minutes."
      const { data, error } = await supabase
        .from('sale_orders')
        .select('created_at')
        .eq('business_id', businessId)
        .eq('is_credit', true)
        .order('created_at', { ascending: false })
        .limit(2);
      if (error) return;
      const rows = data ?? [];
      if (rows.length < 2) return;
      const mostRecent = new Date((rows[0] as { created_at: string }).created_at).getTime();
      if (Date.now() - mostRecent < FOCUS_WINDOW_MS) return;

      // Re-check focus and other-overlay state — the async work above could
      // have taken a moment during which the user navigated away, or opened
      // one of Accueil's own sheets.
      if (!isFocusedRef.current || blockedRef.current) return;
      setVisible(true);
    } finally {
      evaluatingRef.current = false;
    }
  }, [businessId, userId]);

  useEffect(() => {
    if (freshSessionToken === lastTokenRef.current) return;
    lastTokenRef.current = freshSessionToken;
    if (!active) return;

    let cancelled = false;
    const timer = setTimeout(() => {
      if (cancelled || !isFocusedRef.current || blockedRef.current) return;
      void evaluate();
    }, SETTLE_MS);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [freshSessionToken, active, evaluate]);

  const recordDismissal = useCallback(async () => {
    const countStr = await getKV(dismissCountKey(userId));
    const count = parseInt(countStr ?? '0', 10);
    await Promise.all([
      setKV(dismissCountKey(userId), String(count + 1)),
      setKV(lastDismissKey(userId), String(Date.now())),
    ]);
  }, [userId]);

  const handleLater = useCallback(() => {
    setVisible(false);
    void recordDismissal();
  }, [recordDismissal]);

  const handleActivate = useCallback(async () => {
    const granted = await requestNotificationPermission();
    setVisible(false);
    if (granted) {
      toast.success('Rappels activés ✓');
    } else {
      await setKV(deniedExplainerPendingKey(userId), 'true');
      onDenied?.();
    }
  }, [userId, onDenied]);

  return (
    <ReminderSheet
      visible={visible}
      onLater={handleLater}
      onActivate={handleActivate}
      palette={palette}
    />
  );
}

// ─── The sheet itself — split out so the animation values below are only
// ever mounted while genuinely visible, never carried by the always-mounted
// gate component above. ───────────────────────────────────────────────────

interface SheetProps {
  visible: boolean;
  onLater: () => void;
  onActivate: () => void;
  palette: ReturnType<typeof useTheme>['palette'];
}

const STAGGER_MS = 50;
const ITEM_ENTER_MS = 260;

function ReminderSheet({ visible, onLater, onActivate, palette }: SheetProps) {
  const reduceMotion = useReduceMotion();
  const scrimOpacity = useSharedValue(0);
  const sheetY = useSharedValue(SHEET_MAX_HEIGHT + 40);
  const dragStartY = useSharedValue(0);
  const bellRotate = useSharedValue(0);

  const itemOpacity = [useSharedValue(0), useSharedValue(0), useSharedValue(0), useSharedValue(0), useSharedValue(0)];
  const itemY = [useSharedValue(8), useSharedValue(8), useSharedValue(8), useSharedValue(8), useSharedValue(8)];

  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    if (visible) {
      setMounted(true);
      if (reduceMotion) {
        // State changes apply instantly: sheet in place, items shown, no bell swing.
        scrimOpacity.value = 1;
        sheetY.value = 0;
        itemOpacity.forEach(v => { v.value = 1; });
        itemY.forEach(v => { v.value = 0; });
        bellRotate.value = 0;
      } else {
        scrimOpacity.value = withTiming(1, { duration: 250, easing: Easing.out(Easing.ease) });
        sheetY.value = withSpring(0, { damping: 16, stiffness: 180, mass: 0.9 });

        itemOpacity.forEach((v, i) => {
          v.value = withDelay(i * STAGGER_MS, withTiming(1, { duration: ITEM_ENTER_MS, easing: Easing.out(Easing.ease) }));
        });
        itemY.forEach((v, i) => {
          v.value = withDelay(i * STAGGER_MS, withTiming(0, { duration: ITEM_ENTER_MS, easing: Easing.out(Easing.ease) }));
        });

        // One gentle swing, after the icon has faded in — never loops.
        bellRotate.value = withDelay(
          STAGGER_MS + ITEM_ENTER_MS * 0.4,
          withSequence(
            withTiming(12, { duration: 220, easing: Easing.out(Easing.ease) }),
            withTiming(-12, { duration: 260, easing: Easing.inOut(Easing.ease) }),
            withTiming(0, { duration: 220, easing: Easing.out(Easing.ease) }),
          ),
        );
      }
    } else if (mounted) {
      if (reduceMotion) {
        scrimOpacity.value = 0;
        sheetY.value = SHEET_MAX_HEIGHT + 40;
        setMounted(false);
      } else {
        scrimOpacity.value = withTiming(0, { duration: 250, easing: Easing.in(Easing.ease) });
        sheetY.value = withTiming(SHEET_MAX_HEIGHT + 40, { duration: 300, easing: Easing.in(Easing.ease) }, (finished) => {
          if (finished) runOnJS(setMounted)(false);
        });
      }
      itemOpacity.forEach(v => { v.value = 0; });
      itemY.forEach(v => { v.value = 8; });
      bellRotate.value = 0;
    }
  }, [visible]);

  const dismissGesture = Gesture.Pan()
    .activeOffsetY([-1000, 10])
    .failOffsetX([-15, 15])
    .onStart(() => { dragStartY.value = sheetY.value; })
    .onUpdate((e) => {
      if (e.translationY > 0) sheetY.value = dragStartY.value + e.translationY;
    })
    .onEnd((e) => {
      const shouldDismiss = sheetY.value > 80 || e.velocityY > 800;
      if (shouldDismiss) {
        runOnJS(onLater)();
      } else {
        sheetY.value = reduceMotion ? 0 : withSpring(0, { damping: 16, stiffness: 180, mass: 0.9 });
      }
    });

  const scrimStyle = useAnimatedStyle(() => ({ opacity: scrimOpacity.value }));
  const sheetStyle = useAnimatedStyle(() => ({ transform: [{ translateY: sheetY.value }] }));
  const bellStyle = useAnimatedStyle(() => ({ transform: [{ rotate: `${bellRotate.value}deg` }] }));
  // Five separate useAnimatedStyle calls, not a loop/helper-function
  // invocation — each has to be its own literal hook call, called
  // unconditionally in the same order every render.
  const item0Style = useAnimatedStyle(() => ({ opacity: itemOpacity[0].value, transform: [{ translateY: itemY[0].value }] }));
  const item1Style = useAnimatedStyle(() => ({ opacity: itemOpacity[1].value, transform: [{ translateY: itemY[1].value }] }));
  const item2Style = useAnimatedStyle(() => ({ opacity: itemOpacity[2].value, transform: [{ translateY: itemY[2].value }] }));
  const item3Style = useAnimatedStyle(() => ({ opacity: itemOpacity[3].value, transform: [{ translateY: itemY[3].value }] }));
  const item4Style = useAnimatedStyle(() => ({ opacity: itemOpacity[4].value, transform: [{ translateY: itemY[4].value }] }));
  const itemStyles = [item0Style, item1Style, item2Style, item3Style, item4Style];

  if (!mounted) return null;

  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="box-none">
      <Animated.View style={[styles.scrim, scrimStyle]}>
        <Pressable style={StyleSheet.absoluteFill} onPress={onLater} accessibilityLabel="Fermer" accessibilityRole="button" />
      </Animated.View>
      <View style={styles.anchor} pointerEvents="box-none">
        <GestureDetector gesture={dismissGesture}>
          <Animated.View style={[styles.sheet, { backgroundColor: palette.surface, maxHeight: SHEET_MAX_HEIGHT }, sheetStyle]}>
            <View style={[styles.handle, { backgroundColor: palette.border }]} />

            <Animated.View style={[styles.iconWrap, { borderColor: palette.border }, itemStyles[0], bellStyle]}>
              <Ionicons name="notifications-outline" size={30} color={palette.textSecondary} />
            </Animated.View>

            <Animated.View style={itemStyles[1]}>
              <Text variant="h3" style={styles.title}>Ne ratez aucun paiement</Text>
            </Animated.View>

            <Animated.View style={itemStyles[2]}>
              <Text variant="body" color="secondary" style={styles.body}>
                Quand un client vous doit de l'argent depuis 7 jours, Patron vous envoie un rappel. Rien d'autre — jamais de publicité.
              </Text>
            </Animated.View>

            <Animated.View style={[itemStyles[3], styles.actionBlock]}>
              <Button label="Activer les rappels" onPress={onActivate} fullWidth size="lg" />
            </Animated.View>

            <Animated.View style={itemStyles[4]}>
              <Text
                variant="label"
                style={[styles.laterLink, { color: palette.textSecondary }]}
                onPress={onLater}
              >
                Plus tard
              </Text>
            </Animated.View>
          </Animated.View>
        </GestureDetector>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  scrim: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.55)' },
  anchor: { flex: 1, justifyContent: 'flex-end' },
  sheet: {
    borderTopLeftRadius: radius.card,
    borderTopRightRadius: radius.card,
    paddingHorizontal: spacing[6],
    paddingTop: spacing[3],
    paddingBottom: spacing[10],
    alignItems: 'center',
    gap: spacing[3],
  },
  handle: { width: 40, height: 4, borderRadius: 2, marginBottom: spacing[2] },
  iconWrap: {
    width: 64, height: 64, borderRadius: 32,
    borderWidth: 1.5,
    alignItems: 'center', justifyContent: 'center',
    marginBottom: spacing[2],
  },
  title: { textAlign: 'center' },
  body: { textAlign: 'center', lineHeight: 22 },
  actionBlock: { alignSelf: 'stretch', marginTop: spacing[2] },
  laterLink: { textAlign: 'center', paddingVertical: spacing[2] },
});
