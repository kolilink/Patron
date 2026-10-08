import { useEffect, useMemo, useRef, useState } from 'react';
import { TRUST_LINE } from '@/src/utils/trustLine';
import { useReduceMotion } from '@/src/hooks/useReduceMotion';
import {
  Animated,
  Keyboard,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Button } from '@/src/components/ui/Button';
import { Input } from '@/src/components/ui/Input';
import { Text } from '@/src/components/ui/Text';
import { useTheme, spacing, radius, fontFamily } from '@/src/theme';
import type { Palette } from '@/src/theme';
import { formatAmount, formatAmountInput, parseAmountInput } from '@/src/utils/format';
import { useSalesStore } from '@/stores/sales';
import { useAuthStore } from '@/stores/auth';
import { supabase } from '@/lib/supabase';
import { haptics } from '@/lib/haptics';
import { trackEvent } from '@/lib/analytics';

interface Props {
  businessId: string;
  userId: string;
  currency: string;
  onDone: () => void;
}

// First-run hero action ("Qui vous doit de l'argent ?") — replaces landing
// on an empty dashboard right after "Ouvrir mon commerce". Soft gate, per
// business: see markFirstRunHeroCompleted (stores/auth.ts) for how it's
// persisted and CLAUDE.md for the full policy (backfill, invite-join
// carve-out). Deliberately its own minimal flow, not a
// reuse of CreditRapideCapture — no client picker (nobody exists yet on a
// brand-new business), no Vente/Crédit toggle, no phone field. Reuses only
// the underlying save (submitCarnetDebt) and the same "upsert a client by
// name" step CreditRapideCapture's own new-client path already does, so
// this first entry is a real client + real credit sale, not a toy — it
// shows up in Clients/Crédits like any other from the moment it's saved.
export function FirstRunHeroOverlay({ businessId, userId, currency, onDone }: Props) {
  const { palette } = useTheme();
  const insets = useSafeAreaInsets();
  const styles = useMemo(() => makeStyles(palette), [palette]);
  const submitCarnetDebt = useSalesStore(s => s.submitCarnetDebt);
  const markFirstRunHeroCompleted = useAuthStore(s => s.markFirstRunHeroCompleted);

  type Phase = 'ask' | 'payoff';

  // Rehydrate from useAuthStore's heroDraft when it belongs to THIS
  // business — the lock screen is a real navigation (see
  // app/(app)/_layout.tsx's `if (locked) return <Redirect .../>`), not an
  // overlay on top of this Modal, so a lock mid-flow unmounts this component
  // for real. Without this, whatever the merchant had typed (or the payoff
  // screen they were looking at) would silently reset to a blank form on
  // unlock. draftMatches is computed once at mount — this component remounts
  // fresh every time it becomes eligible to show, so there's no case where
  // the businessId prop changes under an already-mounted instance.
  const initialDraft = useAuthStore.getState().heroDraft;
  const draftMatches = initialDraft?.businessId === businessId;

  const [phase, setPhase] = useState<Phase>(draftMatches ? initialDraft!.phase : 'ask');
  const [name, setName] = useState(draftMatches ? initialDraft!.name : '');
  const [amount, setAmount] = useState(draftMatches ? initialDraft!.amount : '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [totalCents, setTotalCents] = useState(draftMatches ? initialDraft!.totalCents : 0);
  const [lastEntry, setLastEntry] = useState<{ name: string; amountCents: number } | null>(
    draftMatches ? initialDraft!.lastEntry : null,
  );
  const reduceMotion = useReduceMotion();

  const nameRef = useRef<TextInput>(null);
  const fadeAnim = useRef(new Animated.Value(1)).current;
  // The one-time flag write is idempotent server-side (join_business's own
  // stamp only ever moves NULL -> now(), and this one always wins by being
  // the most recent write) but there's no reason to fire it more than once
  // per mount either way — "Ajouter une autre dette" loops back to 'ask'
  // without needing a second network call. Also correctly true-on-remount
  // after a lock/unlock past the first successful save, via draftMatches
  // above implying the flag was already stamped this session.
  const stampedRef = useRef(draftMatches && initialDraft!.phase === 'payoff');


  // Mirror every in-progress change straight into useAuthStore.heroDraft so
  // a lock mid-flow has nothing to lose — see the rehydration comment above.
  // Runs on mount too (writing back what was just read, a harmless no-op)
  // and on every phase/name/amount/total/lastEntry change thereafter.
  useEffect(() => {
    useAuthStore.setState({ heroDraft: { businessId, phase, name, amount, totalCents, lastEntry } });
  }, [businessId, phase, name, amount, totalCents, lastEntry]);

  const crossfadeTo = (next: Phase) => {
    // Dismiss before the fade starts, not after — letting the keyboard's own
    // closing animation run *after* the crossfade settles reads as a second,
    // separate jump instead of one clean transition.
    Keyboard.dismiss();
    setPhase(next);
    if (reduceMotion) {
      fadeAnim.setValue(1);
      return;
    }
    fadeAnim.setValue(0);
    Animated.timing(fadeAnim, { toValue: 1, duration: 220, useNativeDriver: true }).start();
  };

  const stampCompleted = (outcome: 'hero_saved' | 'hero_skipped') => {
    if (stampedRef.current) return;
    stampedRef.current = true;
    void markFirstRunHeroCompleted(businessId);
    // Once per business, whichever exit came first.
    trackEvent('onboarding_completed', businessId, userId, { outcome });
  };

  const clearDraft = () => {
    // Only clear if it's still this business's draft — cheap defense against
    // a stale write racing this call (shouldn't happen in practice, since
    // this component is the only writer, but a no-op check costs nothing).
    if (useAuthStore.getState().heroDraft?.businessId === businessId) {
      useAuthStore.setState({ heroDraft: null });
    }
  };

  const handleSkip = () => {
    trackEvent('first_run_hero_skipped', businessId, userId);
    stampCompleted('hero_skipped');
    clearDraft();
    onDone();
  };

  const handleFinish = () => {
    clearDraft();
    onDone();
  };

  const nameValid = name.trim().length > 0;
  const amountValid = parseAmountInput(amount, currency) > 0;
  const canSubmit = nameValid && amountValid && !saving;

  const handleSave = async () => {
    if (!canSubmit) return;
    const trimmedName = name.trim();
    const amountCents = Math.round(parseAmountInput(amount, currency) * 100);
    setSaving(true);
    setError(null);

    // Same best-effort "upsert then submit" shape as CreditRapideCapture's
    // own new-client path — a failure/timeout here must never block the
    // debt itself, submitCarnetDebt already accepts a null client id.
    let resolvedClientId: string | undefined;
    try {
      const { data } = await supabase.from('clients').upsert(
        { business_id: businessId, name: trimmedName },
        { onConflict: 'business_id,name' },
      ).select('id').single();
      resolvedClientId = data?.id ?? undefined;
    } catch {
      resolvedClientId = undefined;
    }

    const submitted = await submitCarnetDebt(businessId, userId, trimmedName, amountCents, resolvedClientId ?? null);
    setSaving(false);
    if (!submitted.ok) {
      setError('Impossible d\'enregistrer. Vérifiez votre connexion et réessayez.');
      return;
    }

    haptics.success();
    trackEvent('first_run_hero_completed', businessId, userId, { has_debt: true });
    stampCompleted('hero_saved');
    setTotalCents(c => c + amountCents);
    setLastEntry({ name: trimmedName, amountCents });
    crossfadeTo('payoff');
  };

  const handleAddAnother = () => {
    setName('');
    setAmount('');
    setError(null);
    crossfadeTo('ask');
    setTimeout(() => nameRef.current?.focus(), 80);
  };

  return (
    <Modal
      animationType="none"
      transparent={false}
      visible
      statusBarTranslucent
      navigationBarTranslucent
      backdropColor={palette.background}
      onRequestClose={handleSkip}
    >
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={[styles.safe, { paddingTop: insets.top, paddingBottom: insets.bottom }]}
      >
        <View style={styles.header}>
          <View style={{ flex: 1 }} />
          {phase === 'ask' && (
            // The save already happened by the time the payoff screen shows
            // — there is nothing left to skip, so the exit affordance
            // disappears with it rather than sitting there meaninglessly.
            <Pressable onPress={handleSkip} hitSlop={12} style={styles.skip}>
              <Text variant="label" color="secondary">Passer</Text>
            </Pressable>
          )}
        </View>

        <ScrollView
          contentContainerStyle={styles.scrollContent}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          {/* flex: 1 here (not just on the ScrollView's contentContainerStyle)
              is what lets the payoff phase's own internal spacer below
              actually push its button block toward the bottom third — a
              flexGrow'd content container alone doesn't propagate that
              growth to a non-flexed child. Harmless for the ask phase, which
              never uses a spacer and just renders top-down at its natural
              height either way. */}
          <Animated.View style={{ opacity: fadeAnim, flex: 1 }}>
            {phase === 'ask' ? (
              <View style={styles.content}>
                <View style={styles.titleBlock}>
                  <Text variant="h2">Qui vous doit de l&apos;argent ?</Text>
                  <Text variant="body" color="secondary" style={styles.sub}>
                    Écrivez son nom et le montant. Patron s&apos;en souvient pour vous.
                  </Text>
                </View>

                <View style={styles.form}>
                  <Input
                    ref={nameRef}
                    label="Nom du client"
                    placeholder="Nom du client"
                    accessibilityLabel="Nom du client"
                    value={name}
                    onChangeText={v => { setName(v); setError(null); }}
                    autoFocus
                    autoCapitalize="words"
                    returnKeyType="next"
                  />

                  <View>
                    <Text variant="label" color="secondary" style={{ marginBottom: spacing[2] }}>Montant</Text>
                    <View style={[styles.amountBox, { borderColor: palette.border }]}>
                      <TextInput
                        style={[styles.amountInput, { color: amount ? palette.textPrimary : palette.textDisabled }]}
                        placeholder="0"
                        placeholderTextColor={palette.textDisabled}
                        value={amount}
                        onChangeText={v => { setAmount(formatAmountInput(v, currency)); setError(null); }}
                        keyboardType="numeric"
                        returnKeyType="done"
                        accessibilityLabel="Montant"
                        onSubmitEditing={handleSave}
                      />
                      <Text style={[styles.amountCurrency, { color: palette.textSecondary }]}>{currency}</Text>
                    </View>
                  </View>

                  <Button
                    label="Enregistrer"
                    onPress={handleSave}
                    loading={saving}
                    disabled={!canSubmit}
                    fullWidth
                    size="lg"
                  />
                  {error ? (
                    <Text variant="caption" style={{ color: palette.warning, textAlign: 'center' }}>{error}</Text>
                  ) : null}
                  <Text variant="caption" color="secondary" style={{ textAlign: 'center' }}>{TRUST_LINE}</Text>
                </View>
              </View>
            ) : (
              // Deliberately its own structure, not styles.content — the
              // title block still starts at the identical top offset as the
              // ask phase (same paddingHorizontal/paddingTop values below),
              // so the crossfade transforms in place with no downward jump,
              // but the button block is bottom-anchored via the flex spacer
              // rather than following the text immediately, landing it in
              // the lower third (thumb zone) instead of a tightly-centered
              // clump — that's what turns "no dead top third" into "button
              // still reachable one-handed."
              <View style={styles.payoffContent}>
                <View style={styles.payoffHeader}>
                  <Text variant="h2">
                    Noté <Text variant="h2" style={{ color: palette.primary }}>✓</Text>
                  </Text>
                  {lastEntry && (
                    <Text variant="body" style={styles.sub}>
                      {lastEntry.name} vous doit {formatAmount(lastEntry.amountCents / 100, currency)}.
                    </Text>
                  )}
                </View>
                <Text variant="body" color="secondary" style={[styles.sub, styles.totalLine]}>
                  Total à recevoir : {formatAmount(totalCents / 100, currency)}
                </Text>

                <View style={styles.payoffSpacer} />

                <View style={styles.form}>
                  <Button
                    label="Voir mon commerce"
                    onPress={handleFinish}
                    fullWidth
                    size="lg"
                  />
                  <Pressable onPress={handleAddAnother} hitSlop={8} style={{ alignSelf: 'center' }}>
                    <Text variant="label" color="secondary">Ajouter une autre dette</Text>
                  </Pressable>
                </View>
              </View>
            )}
          </Animated.View>
        </ScrollView>
      </KeyboardAvoidingView>
    </Modal>
  );
}

function makeStyles(p: Palette) {
  return StyleSheet.create({
    safe: { flex: 1, backgroundColor: p.background },
    header: { flexDirection: 'row', paddingHorizontal: spacing[6], paddingTop: spacing[3] },
    skip: { minHeight: 48, minWidth: 48, alignItems: 'flex-end', justifyContent: 'center' },
    // Top-aligned, not centered — load-bearing for the crossfade. Both
    // phases share this same container and the identical top padding in
    // `content`/`payoffContent` below, so their title blocks land at the
    // same Y regardless of how much content follows. Centering here (the
    // original approach) recentered each phase independently around its own
    // content height, which is exactly what produced the downward jump on
    // the shorter payoff screen.
    scrollContent: { flexGrow: 1 },
    content: { paddingHorizontal: spacing[6], paddingVertical: spacing[8], gap: spacing[8] },
    // Same horizontal/top padding as `content` above (deliberately, see the
    // scrollContent comment) but flex: 1 + the trailing payoffSpacer instead
    // of a single top-to-bottom gap — that's what lets the button block
    // settle in the lower third instead of following the text immediately.
    payoffContent: { flex: 1, paddingHorizontal: spacing[6], paddingTop: spacing[8], paddingBottom: spacing[8] },
    titleBlock: { gap: spacing[3] },
    payoffHeader: { gap: spacing[3] },
    // Sits below payoffHeader with its own larger top margin — the debt
    // line and the running total are two different weights of information
    // (what just happened vs. a quieter cumulative fact), not one paragraph.
    totalLine: { marginTop: spacing[6] },
    payoffSpacer: { flex: 1 },
    // No hardcoded color here — every caller passes its own `color` prop
    // ("secondary" for both subtitles, the default "primary" for the ink
    // debt line) and relies on it actually taking effect. A hardcoded color
    // in this style object would sit after Text's own color-prop style in
    // the merge order and silently win regardless of what's passed in —
    // exactly the bug this shape had until now.
    sub: { lineHeight: 22 },
    form: { gap: spacing[4] },
    amountBox: {
      flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
      borderWidth: 1.5, borderRadius: radius.md, paddingHorizontal: spacing[4], paddingVertical: spacing[4],
      minHeight: 48,
    },
    amountInput: { flex: 1, fontSize: 28, lineHeight: 34, fontFamily: fontFamily.bold },
    amountCurrency: { fontSize: 16, fontFamily: fontFamily.semibold },
  });
}
