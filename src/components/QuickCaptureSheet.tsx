import { useEffect, useRef, useState } from 'react';
import { useReduceMotion } from '@/src/hooks/useReduceMotion';
import { Animated, Pressable, View } from 'react-native';
import { router } from 'expo-router';
import { FormSheet } from '@/src/components/ui/FormSheet';
import { Text } from '@/src/components/ui/Text';
import { CreditRapideCapture } from '@/src/components/CreditRapideCapture';
import { VenteRapideCapture } from '@/src/components/VenteRapideCapture';
import { useTheme, spacing, radius } from '@/src/theme';
import { formatAmount } from '@/src/utils/format';
import { useAuthStore } from '@/stores/auth';

interface QuickCaptureSheetProps {
  visible: boolean;
  onClose: () => void;
  businessId: string;
  userId: string;
  currency: string;
  /** Which segment to land on when the sheet opens — defaults to Crédit.
   * ActivationForkOverlay's "Une vente" button opens this sheet from
   * Accueil in Vente mode specifically (see requestQuickCapture in
   * stores/auth.ts); the "+" FAB's own normal open omits this and gets the
   * default. */
  initialMode?: 'credit' | 'vente';
}

const PULSE_SCALE = 1.18;
const APPEAR_MS = 250;
const APPEAR_SLIDE = 6;

// Session tally, "N vente(s)/crédit(s) de {total}" — mounted only once the
// active mode has at least one entry (the parent never renders this with a
// count of 0, so there's no "hide at zero" branch to handle in here). Every
// mount plays the same gentle fade + slight slide-up, whether that's the
// true first save of the whole sheet-opening or a mode switch revealing a
// tally that already had entries from earlier in the same sitting — kept
// deliberately simple rather than threading an extra "is this really the
// very first one" flag through, since the visible result (a quiet
// appearance) reads correctly either way. Any *subsequent* text change
// while already mounted (a real new save in the currently-viewed mode) gets
// the subtle pulse instead — the mount-time ref below is what tells the two
// apart, skipping the pulse on this component's own first render.
function SessionTicker({ text, reduceMotion }: { text: string; reduceMotion: boolean }) {
  const appearAnim = useRef(new Animated.Value(reduceMotion ? 1 : 0)).current;
  const pulseAnim = useRef(new Animated.Value(1)).current;
  const mountedRef = useRef(false);

  useEffect(() => {
    if (reduceMotion) return; // instant appearance, no animation
    Animated.timing(appearAnim, { toValue: 1, duration: APPEAR_MS, useNativeDriver: true }).start();
    // Deliberately mount-only — this is a one-time entrance, not something
    // that should replay if `reduceMotion` itself flips mid-display.
  }, []);

  useEffect(() => {
    if (!mountedRef.current) { mountedRef.current = true; return; }
    if (reduceMotion) return; // instant number swap only
    pulseAnim.setValue(PULSE_SCALE);
    Animated.spring(pulseAnim, { toValue: 1, useNativeDriver: true, friction: 5, tension: 140 }).start();
  }, [text, reduceMotion]);

  return (
    <Animated.View
      style={{
        opacity: appearAnim,
        transform: [
          { translateY: appearAnim.interpolate({ inputRange: [0, 1], outputRange: [APPEAR_SLIDE, 0] }) },
          { scale: pulseAnim },
        ],
      }}
    >
      <Text variant="caption" color="secondary" style={{ textAlign: 'center' }}>{text}</Text>
    </Animated.View>
  );
}

// One-tap entry point from Accueil — see CLAUDE.md / the "radical
// simplicity" plan this implements. Crédit is the default (see
// CreditRapideCapture for the redesign this and vendre.tsx's own Crédit tab
// share); Vente is the quick-sale redesign (see VenteRapideCapture) — both
// modes render in place, switched by the segment below, neither is a
// hand-off to a separate screen anymore. This sheet only owns the Vente/
// Crédit segment itself and the session ticker below it; the actual capture
// logic for each mode lives in its own component, not duplicated here.
export function QuickCaptureSheet({ visible, onClose, businessId, userId, currency, initialMode = 'credit' }: QuickCaptureSheetProps) {
  const { palette } = useTheme();
  const [mode, setMode] = useState<'credit' | 'vente'>(initialMode);

  // Session ticker — "the accumulation reward." Lives here, not inside
  // either capture component, specifically so it survives a Crédit↔Vente
  // switch within the same sheet-opening (each mode keeps its own running
  // tally; switching back and forth doesn't lose either one). Both reset
  // only when the sheet itself closes — this is the sitting's total, not
  // the day's, which the home cards already own.
  const [venteCount, setVenteCount] = useState(0);
  const [venteTotalCents, setVenteTotalCents] = useState(0);
  const [creditCount, setCreditCount] = useState(0);
  const [creditTotalCents, setCreditTotalCents] = useState(0);
  const reduceMotion = useReduceMotion();


  // Suppress ActivationForkOverlay for as long as this sheet is open — same
  // fix already applied to vendre.tsx's credit mode. Un-suppressing is
  // deliberately delayed (not immediate on close) — same 1200ms grace
  // window app/(app)/_layout.tsx's own beginForkNavigation() already uses
  // for the identical race: a credit/sale just added here doesn't update
  // useVentesStore.sales synchronously (Accueil's onClose→loadAll() still
  // needs a real network round trip), but suppressActivationFork used to
  // reset the instant this sheet closed — so showFork's own !forkStep3Done
  // condition could briefly still read stale (true) right as suppression
  // lifted, flashing the fork's 3-button wall in for a moment before the
  // fresh data arrived and closed it again. Reported live 2026-09-28 as "a
  // button tries to appear on the dashboard then goes away" right after
  // adding a credit or sale and closing.
  useEffect(() => {
    if (!visible) return;
    useAuthStore.setState({ suppressActivationFork: true });
    return () => {
      setTimeout(() => useAuthStore.setState({ suppressActivationFork: false }), 1200);
    };
  }, [visible]);

  // Reopen on whichever segment the caller asked for (defaults to Crédit),
  // and reset both session tallies fresh — a new opening is a new sitting.
  useEffect(() => {
    if (!visible) return;
    setMode(initialMode);
    setVenteCount(0); setVenteTotalCents(0);
    setCreditCount(0); setCreditTotalCents(0);
  }, [visible, initialMode]);

  // Still a real navigation (Clients is a full screen, not a sheet mode) —
  // this sheet is a native Modal, its own separate window, rendered above
  // the whole navigator. Pushing first and closing a beat later lets the
  // destination mount and settle invisibly underneath the still-open modal,
  // so closing just reveals a screen that's already there — one motion
  // instead of two visibly sequential transitions.
  const handleViewClients = () => {
    router.push({ pathname: '/(app)/clients', params: { filter: 'doivent' } });
    setTimeout(onClose, 50);
  };

  const tickerCount = mode === 'vente' ? venteCount : creditCount;
  const tickerTotalCents = mode === 'vente' ? venteTotalCents : creditTotalCents;
  const tickerNoun = mode === 'vente' ? 'vente' : 'crédit';
  const tickerText = `${tickerCount} ${tickerNoun}${tickerCount > 1 ? 's' : ''} de ${formatAmount(tickerTotalCents / 100, currency)}`;

  return (
    <FormSheet
      visible={visible}
      onClose={onClose}
      title={mode === 'credit' ? 'Crédit rapide' : 'Vente rapide'}
      presentationStyle="fullScreen"
      contentContainerStyle={{ padding: spacing[5], gap: spacing[4] }}
    >
      {/* Vente / Crédit segment — both modes render in place below. */}
      <View style={{ flexDirection: 'row', borderRadius: radius.full, borderWidth: 1, padding: 3, alignSelf: 'flex-start', backgroundColor: palette.border + '55', borderColor: palette.border }}>
        <Pressable
          onPress={() => setMode('credit')}
          style={[
            { paddingHorizontal: spacing[5], paddingVertical: spacing[2], borderRadius: radius.full },
            mode === 'credit' && { backgroundColor: palette.surface },
          ]}
        >
          <Text variant="label" style={{ color: mode === 'credit' ? palette.primary : palette.textSecondary }}>Crédit</Text>
        </Pressable>
        <Pressable
          onPress={() => setMode('vente')}
          style={[
            { paddingHorizontal: spacing[5], paddingVertical: spacing[2], borderRadius: radius.full },
            mode === 'vente' && { backgroundColor: palette.surface },
          ]}
        >
          <Text variant="label" style={{ color: mode === 'vente' ? palette.primary : palette.textSecondary }}>Vente</Text>
        </Pressable>
      </View>

      {/* Session ticker — does not exist in the tree at all until the active
          mode has its first entry (no reserved space beforehand); see
          SessionTicker's own comment for the mount/pulse split. */}
      {tickerCount > 0 && <SessionTicker text={tickerText} reduceMotion={reduceMotion} />}

      {/* Keyed on `visible` so each mode's own capture flow (phase/name/
          amount) resets to a fresh state on every open — FormSheet's Modal
          keeps children mounted while hidden, it doesn't unmount them. */}
      {mode === 'credit' ? (
        <CreditRapideCapture
          key={String(visible)}
          businessId={businessId}
          userId={userId}
          currency={currency}
          onViewClients={handleViewClients}
          onAdded={amountCents => {
            setCreditCount(c => c + 1);
            setCreditTotalCents(t => t + amountCents);
          }}
        />
      ) : (
        <VenteRapideCapture
          key={String(visible)}
          businessId={businessId}
          userId={userId}
          currency={currency}
          onAdded={amountCents => {
            setVenteCount(c => c + 1);
            setVenteTotalCents(t => t + amountCents);
          }}
        />
      )}
    </FormSheet>
  );
}
