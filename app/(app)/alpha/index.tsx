import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Animated, FlatList, InteractionManager, Keyboard, KeyboardAvoidingView, Modal, Platform, Pressable, StyleSheet, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as FileSystem from 'expo-file-system/legacy';
import { Screen } from '@/src/components/ui/Screen';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { Text } from '@/src/components/ui/Text';
import { SkeletonList } from '@/src/components/ui/SkeletonPlaceholder';
import { AppSheet } from '@/src/components/ui/AppSheet';
import { PaywallScreen } from '@/src/components/PaywallScreen';
import { LiveWaveformBars } from '@/src/components/ui/VoiceMessageBubble';
import { useTheme, spacing, radius } from '@/src/theme';
import type { Palette } from '@/src/theme';
import { useAuthStore } from '@/stores/auth';
import { useAlphaStore } from '@/stores/alpha';
import { supabase } from '@/lib/supabase';
import { PAYWALL_ENABLED } from '@/lib/purchases';
import { useVoiceRecorder } from '@/src/hooks/useVoiceRecorder';
import { isSep, buildGroupedItems } from '@/src/lib/chatGrouping';
import type { GroupedItem } from '@/src/lib/chatGrouping';
import type { AlphaMessage } from '@/src/types';

// buildGroupedItems clusters by `sender_id` — Alpha only has two "senders"
// (the user and the assistant), so `role` doubles as the grouping key.
type GroupableAlphaMessage = AlphaMessage & { sender_id: string };

const SUGGESTIONS = [
  'Comment vont mes ventes ce mois-ci ?',
  'Que dois-je faire pour gagner plus ?',
  'Ai-je des produits en rupture ?',
];

// Alpha is instructed (alpha-chat/index.ts's STATIC_INSTRUCTIONS) to wrap
// its 1-3 most important figures in **bold** markdown so they stand out on
// a small screen — the bubble itself is plain RN <Text>, which has no
// markdown support, so without this split the user would see literal
// asterisks. Only applied to assistant messages; a user typing "**" is left
// as plain text.
function renderBold(content: string): React.ReactNode {
  const segments = content.split(/(\*\*[^*]+\*\*)/g).filter(s => s.length > 0);
  if (segments.length === 1) return content;
  return segments.map((seg, i) => {
    const match = seg.match(/^\*\*([^*]+)\*\*$/);
    return match ? <Text key={i} style={{ fontWeight: '800' }}>{match[1]}</Text> : seg;
  });
}

function formatCountdown(nextResetAt: string | null | undefined): string {
  if (!nextResetAt) return '';
  const ms = new Date(nextResetAt).getTime() - Date.now();
  if (ms <= 0) return 'bientôt';
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  return h > 0 ? `${h}h${String(m).padStart(2, '0')}min` : `${m}min`;
}

function formatRecDuration(s: number): string {
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${m}:${String(sec).padStart(2, '0')}`;
}

// "gratuite" tier wording only makes sense when there's a paid tier to
// contrast it with — suppressed while PAYWALL_ENABLED is false (lib/
// purchases.ts) so the remaining-count row doesn't imply an upgrade path
// that isn't actually offered right now.
function formatQuotaLabel(quota: { has_ai_access: boolean; remaining: number; next_reset_at: string | null }): string {
  const showFreeWord = PAYWALL_ENABLED && !quota.has_ai_access;
  if (quota.remaining > 0) {
    const plural = quota.remaining > 1 ? 's' : '';
    return showFreeWord
      ? `${quota.remaining} question${plural} gratuite${plural} restante${plural}`
      : `${quota.remaining} question${plural} restante${plural} aujourd'hui`;
  }
  return showFreeWord
    ? `Prochaine question gratuite dans ${formatCountdown(quota.next_reset_at)}`
    : `Prochaine question dans ${formatCountdown(quota.next_reset_at)}`;
}

export default function AlphaScreen() {
  const { palette } = useTheme();
  const styles = useMemo(() => makeStyles(palette), [palette]);
  const session = useAuthStore(s => s.session);
  const businessId = session?.activeBusiness?.id ?? '';
  const params = useLocalSearchParams<{ q?: string; autoRecord?: string }>();

  const {
    messages, quota, loading, sending, error, offline, load, sendMessage,
    checkWhatsappConsentEligibility, recordWhatsappConsent,
  } = useAlphaStore();
  const [text, setText] = useState('');
  const [pendingQuestion, setPendingQuestion] = useState<string | null>(null);
  // Shown after the paywall is dismissed WITHOUT purchasing (never after a
  // purchase — has_ai_access() becomes true then, so the eligibility check
  // would already return false on its own). Deliberately not asked on the
  // very first block, only once alpha_whatsapp_reminder_eligible_now
  // confirms the free cap was actually hit on 3+ separate days this week —
  // see db/migration_v145.sql for why an earlier ask would be a promise
  // disconnected from anything real.
  const [showWhatsappConsent, setShowWhatsappConsent] = useState(false);
  // Set on a blocked send attempt while at the paid-tier cap — renders the
  // plain waitCard instead of the upgrade popup, since offering an upgrade
  // to someone already paying is nonsensical. Self-clears once quota is no
  // longer exhausted (see the render check below), so a stale true value
  // from before the window reset can never hide the input row.
  const [waitBlocked, setWaitBlocked] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const autoSentRef = useRef(false);
  const autoRecordRef = useRef(false);
  const listRef = useRef<FlatList<GroupedItem<GroupableAlphaMessage>>>(null);
  const inputRef = useRef<TextInput>(null);
  const recorder = useVoiceRecorder();
  const pulseAnim = useRef(new Animated.Value(1)).current;
  const insets = useSafeAreaInsets();
  // Screen only reserves the top safe area (see below) so KeyboardAvoidingView
  // can own the bottom padding while the keyboard is up — the composer needs
  // its own bottom padding only when the keyboard is NOT covering it, or it
  // sits flush under the home-indicator/gesture-bar on notched phones.
  const [keyboardVisible, setKeyboardVisible] = useState(false);

  useEffect(() => {
    const showEvt = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvt = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
    const showSub = Keyboard.addListener(showEvt, () => setKeyboardVisible(true));
    const hideSub = Keyboard.addListener(hideEvt, () => setKeyboardVisible(false));
    return () => { showSub.remove(); hideSub.remove(); };
  }, []);

  useEffect(() => {
    if (!recorder.isRecording) { pulseAnim.setValue(1); return; }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulseAnim, { toValue: 0.3, duration: 600, useNativeDriver: true }),
        Animated.timing(pulseAnim, { toValue: 1, duration: 600, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [recorder.isRecording, pulseAnim]);

  useFocusEffect(useCallback(() => {
    if (!businessId) return;
    load(businessId);
  }, [businessId]));

  // Keyboard ready the instant they land here, not after an extra tap —
  // deferred until the push transition finishes so it doesn't fight the
  // screen animation (same InteractionManager pattern as verrouille.tsx's
  // biometric auto-prompt).
  useFocusEffect(useCallback(() => {
    const task = InteractionManager.runAfterInteractions(() => inputRef.current?.focus());
    return () => task.cancel();
  }, []));

  const reversedMessages = useMemo(
    () => messages.slice().reverse().map(m => ({ ...m, sender_id: m.role })),
    [messages],
  );
  const listItems = useMemo(() => buildGroupedItems<GroupableAlphaMessage>(reversedMessages), [reversedMessages]);

  // Belt-and-suspenders client-side gate — the real enforcement is always
  // send_alpha_message's server-side check (db/migration_v133.sql +
  // migration_v134.sql +  migration_v136.sql); this only avoids firing an
  // RPC call we already know will be rejected, so the exhaustion UI can
  // appear immediately instead of after a round trip.
  //
  // Free and paid exhaustion are deliberately two different UI states, not
  // one: a free user is shown the upgrade popup (they can act on it), a
  // paying user at their 20/24h cap is only ever told to wait — showing them
  // an "upgrade" offer would be nonsensical, they already pay.
  //
  // While PAYWALL_ENABLED is false (see lib/purchases.ts), freeQuotaExhausted
  // is forced to never fire — every exhausted user, regardless of
  // has_ai_access, falls into paidQuotaExhausted's plain wait-card state
  // instead, so nobody (including App Store/Play Store reviewers) can reach
  // the upgrade popup at all.
  const quotaExhausted = !!quota && !quota.in_welcome_burst && quota.remaining <= 0;
  const freeQuotaExhausted = PAYWALL_ENABLED && !!quota && quotaExhausted && !quota.has_ai_access;
  const paidQuotaExhausted = !!quota && quotaExhausted && (!PAYWALL_ENABLED || quota.has_ai_access);

  const handleSend = async (content?: string) => {
    const trimmed = (content ?? text).trim();
    if (!trimmed || sending) return;

    if (paidQuotaExhausted) {
      setWaitBlocked(true);
      return;
    }
    if (freeQuotaExhausted) {
      setPendingQuestion(trimmed);
      return;
    }

    setWaitBlocked(false);
    // Only clear the composer once the send actually succeeds — Alpha has
    // no offline queue, so clearing eagerly (as the pre-send-success code
    // used to) meant a network failure silently erased what the merchant
    // typed, forcing a retype instead of a simple retry.
    const ok = await sendMessage({ businessId, content: trimmed });
    if (ok && content === undefined) setText('');
  };

  const handleMicPress = async () => {
    if (offline) return;
    setVoiceError(null);
    await recorder.start();
  };

  const handleCancelRecording = () => {
    recorder.cancel();
  };

  // Fills the composer, never auto-sends — a bad transcription (accent,
  // background noise, a local-language word Whisper doesn't know) should be
  // catchable before it costs a quota slot. See supabase/functions/
  // alpha-transcribe/index.ts for the Groq-first/OpenAI-fallback call.
  const handleStopAndTranscribe = async () => {
    const result = await recorder.stop();
    if (!result) return;

    setIsTranscribing(true);
    setVoiceError(null);
    try {
      const base64 = await FileSystem.readAsStringAsync(result.uri, {
        encoding: FileSystem.EncodingType.Base64,
      });
      const { data, error: fnError } = await supabase.functions.invoke('alpha-transcribe', {
        body: { audio: base64, mimeType: 'audio/m4a' },
      });
      if (fnError || !data?.text) throw fnError ?? new Error('empty transcription');
      setText(t => (t.trim() ? `${t.trim()} ${data.text}` : data.text));
      inputRef.current?.focus();
    } catch {
      setVoiceError('Transcription impossible — réessayez.');
    } finally {
      setIsTranscribing(false);
    }
  };

  // Pre-filled from the home-screen "Demandez Alpha…" bar — auto-sends once
  // so the merchant doesn't have to retype what they already wrote. Routed
  // through handleSend (not a direct sendMessage call) so it's subject to
  // the same free/paid quota check a manual send gets — this used to call
  // sendMessage() directly, bypassing handleSend's exhaustion check
  // entirely, so an already-exhausted free user landing here via the pill
  // hit the raw server rejection instead of the upgrade popup / wait card.
  //
  // fetchQuota runs fire-and-forget inside load() (stores/alpha.ts), so
  // `quota` is still null on the very first render here — wait for it
  // before deciding, otherwise freeQuotaExhausted always reads false.
  // Bounded by a timeout so a failed quota fetch (fetchQuota silently
  // no-ops on error — see stores/alpha.ts) can't strand the pre-filled
  // question forever.
  useEffect(() => {
    if (autoSentRef.current) return;
    if (!businessId || !params.q) return;

    if (quota === null && !offline) {
      const timer = setTimeout(() => {
        if (autoSentRef.current) return;
        autoSentRef.current = true;
        void handleSend(params.q);
      }, 4000);
      return () => clearTimeout(timer);
    }

    autoSentRef.current = true;
    void handleSend(params.q);
  }, [businessId, params.q, quota, offline]);

  // Triggered by the home-screen mic button (mutually exclusive with the
  // `q` auto-send above — the pill only ever sends one or the other).
  // Deferred with InteractionManager so the permission prompt / recording
  // start doesn't fire mid-push-transition (same pattern as the
  // auto-focus effect below, and verrouille.tsx's biometric auto-prompt).
  // No quota gate here, unlike the q flow — recording itself doesn't spend
  // a quota slot, only the eventual send after transcription does, and
  // that already goes through handleSend's normal exhaustion check.
  useEffect(() => {
    if (autoRecordRef.current) return;
    if (params.autoRecord !== '1' || offline) return;
    autoRecordRef.current = true;
    const task = InteractionManager.runAfterInteractions(() => { void handleMicPress(); });
    return () => task.cancel();
  }, [params.autoRecord, offline]);

  const handlePurchased = async () => {
    const q = pendingQuestion;
    setPendingQuestion(null);
    setWaitBlocked(false);
    if (q) {
      await sendMessage({ businessId, content: q });
    }
  };

  // Dismissing the paywall WITHOUT purchasing is exactly "the free popup
  // alone hasn't converted this person" — the natural moment to check
  // whether they've also crossed the WhatsApp-reminder threshold and, if
  // so, offer the consent prompt as the next escalation. Not checked on
  // handlePurchased — a fresh subscriber no longer needs reminding.
  const dismissPaywall = async () => {
    setPendingQuestion(null);
    setWaitBlocked(false);
    // No WhatsApp-reminder consent ask while the paywall itself is hidden —
    // it only makes sense as a follow-up to an upgrade offer nobody is being
    // shown right now (see PAYWALL_ENABLED in lib/purchases.ts).
    if (!PAYWALL_ENABLED) return;
    if (businessId) {
      const eligible = await checkWhatsappConsentEligibility(businessId);
      if (eligible) setShowWhatsappConsent(true);
    }
  };

  return (
    <Screen edges={['top']}>
      <View style={styles.header}>
        <Pressable onPress={() => router.back()}>
          <Text variant="body" color="secondary">‹ Retour</Text>
        </Pressable>
        <Text variant="h4" style={{ fontWeight: '800' }}>{PAYWALL_ENABLED && quota?.has_ai_access ? 'ALPHA PRO' : 'ALPHA'}</Text>
        <View style={{ width: 60 }} />
      </View>

      {/* Wraps only the content below the header — a KeyboardAvoidingView
          around fixed chrome like the header above can throw off how much
          bottom padding it computes, leaving the input sitting slightly
          into the keyboard instead of snug above it. */}
      <KeyboardAvoidingView style={{ flex: 1, backgroundColor: palette.background }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        {offline && (
          <View style={{ paddingHorizontal: spacing[4], paddingTop: spacing[1] }}>
            <Text variant="caption" color="secondary">
              Pas de connexion — Alpha nécessite une connexion internet
            </Text>
          </View>
        )}

        {loading && messages.length === 0 ? (
          <SkeletonList count={4} />
        ) : messages.length === 0 ? (
          <View style={styles.empty}>
            <Text variant="h3" style={{ textAlign: 'center' }}>Parler avec Alpha</Text>
            <View style={{ gap: spacing[2], width: '100%', marginTop: spacing[8] }}>
              {SUGGESTIONS.map(s => (
                <Pressable key={s} onPress={() => handleSend(s)} style={[styles.suggestion, { backgroundColor: palette.surface }]}>
                  <Text variant="bodySmall">{s}</Text>
                </Pressable>
              ))}
            </View>
          </View>
        ) : (
          <FlatList
            ref={listRef}
            onScrollToIndexFailed={() => {}}
            data={listItems}
            keyExtractor={item => item.id}
            inverted
            style={{ flex: 1 }}
            contentContainerStyle={{ paddingVertical: spacing[3], flexGrow: 1, justifyContent: 'flex-end' }}
            keyboardShouldPersistTaps="handled"
            renderItem={({ item }) => {
              if (isSep(item)) {
                return (
                  <View style={styles.dateSep}>
                    <Text variant="caption" color="secondary">{item.label}</Text>
                  </View>
                );
              }
              const isOwn = item.role === 'user';
              return (
                <View style={isOwn ? styles.rowOwn : styles.rowOther}>
                  <View style={[styles.bubble, isOwn ? styles.bubbleOwn : styles.bubbleOther]}>
                    <Text style={[styles.bubbleText, isOwn && { color: palette.textInverse }]}>
                      {isOwn ? item.content : renderBold(item.content)}
                    </Text>
                  </View>
                </View>
              );
            }}
          />
        )}

        {sending && (
          <View style={styles.typingRow}>
            <Text style={{ fontWeight: '800', fontSize: 14 }}>A</Text>
            <Text variant="caption" color="secondary">Alpha réfléchit…</Text>
          </View>
        )}

        {error ? (
          <View style={styles.errorStrip}>
            <Text variant="caption" style={{ color: palette.danger }}>{error}</Text>
          </View>
        ) : null}

        {pendingQuestion ? null : waitBlocked && paidQuotaExhausted ? (
          <View style={styles.waitCard}>
            <Ionicons name="time-outline" size={18} color={palette.textSecondary} />
            <Text variant="bodySmall" color="secondary" style={styles.waitText}>
              Vous pourrez reparler à Alpha dans {formatCountdown(quota?.next_reset_at)}.
            </Text>
          </View>
        ) : (
          <>
            {quota && !quota.in_welcome_burst && (
              <View style={styles.quotaRow}>
                <Text variant="caption" color="secondary">{formatQuotaLabel(quota)}</Text>
              </View>
            )}
            <View style={[styles.inputRow, { paddingBottom: keyboardVisible ? spacing[3] : Math.max(insets.bottom, spacing[3]) }]}>
              {recorder.isRecording ? (
                <>
                  <Pressable onPress={handleCancelRecording} style={styles.recIconBtn} hitSlop={8}>
                    <Ionicons name="close" size={22} color={palette.textSecondary} />
                  </Pressable>
                  <View style={styles.recIndicator}>
                    <Animated.View style={[styles.recDot, { opacity: pulseAnim }]} />
                    <Text variant="bodySmall" color="secondary" style={styles.recTimer}>{formatRecDuration(recorder.duration)}</Text>
                    <View style={{ flex: 1 }}>
                      <LiveWaveformBars samples={recorder.amplitudes} />
                    </View>
                  </View>
                  <Pressable onPress={handleStopAndTranscribe} style={styles.sendBtn} hitSlop={8}>
                    <Ionicons name="checkmark" size={22} color={palette.textInverse} />
                  </Pressable>
                </>
              ) : (
                // Mic/send lives inside the input pill itself (right edge),
                // not as a separate circle floating outside it — swaps to a
                // solid send arrow the moment there's text, back to a plain
                // mic glyph once the box is empty again.
                <View style={styles.composerPill}>
                  <TextInput
                    ref={inputRef}
                    style={[styles.input, offline && { opacity: 0.5 }]}
                    value={text}
                    onChangeText={setText}
                    placeholder={offline ? 'Alpha nécessite une connexion internet…' : 'Parler avec Alpha…'}
                    placeholderTextColor={palette.textSecondary}
                    multiline
                    maxLength={500}
                    onSubmitEditing={() => handleSend()}
                    returnKeyType="send"
                    blurOnSubmit={false}
                    autoFocus
                    editable={!offline && !isTranscribing}
                  />
                  {isTranscribing ? (
                    <View style={[styles.pillIconBtn, styles.pillSendBtn]}>
                      <ActivityIndicator color={palette.textInverse} size="small" />
                    </View>
                  ) : text.trim().length > 0 ? (
                    <Pressable
                      onPress={() => handleSend()}
                      disabled={sending || offline}
                      hitSlop={8}
                      style={({ pressed }) => [styles.pillIconBtn, styles.pillSendBtn, (pressed || offline) && { opacity: 0.6 }]}
                    >
                      <Ionicons name="arrow-up" size={18} color={palette.textInverse} />
                    </Pressable>
                  ) : (
                    <Pressable
                      onPress={handleMicPress}
                      disabled={offline}
                      hitSlop={8}
                      style={({ pressed }) => [styles.pillIconBtn, (pressed || offline) && { opacity: 0.5 }]}
                    >
                      <Ionicons name="mic" size={20} color={palette.primary} />
                    </Pressable>
                  )}
                </View>
              )}
            </View>
            {voiceError && (
              <View style={{ paddingHorizontal: spacing[4], paddingTop: spacing[1] }}>
                <Text variant="caption" style={{ color: palette.warning }}>{voiceError}</Text>
              </View>
            )}
          </>
        )}
      </KeyboardAvoidingView>

      {/* Full-screen modal, not the old embedded inline card — big and
          dedicated like a real checkout screen, X-to-close via onDismiss,
          matching the reference paywall's scale rather than a small card
          tucked at the bottom of the conversation. */}
      <Modal
        visible={PAYWALL_ENABLED && !!pendingQuestion && !!session?.activeBusiness}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={dismissPaywall}
        backdropColor={palette.background}
        statusBarTranslucent
        navigationBarTranslucent
      >
        {session?.activeBusiness && (
          <PaywallScreen
            business={session.activeBusiness}
            onDismiss={dismissPaywall}
            onPurchased={handlePurchased}
          />
        )}
      </Modal>

      {/* Consent for the WhatsApp re-engagement reminder — only ever
          reachable once alpha_whatsapp_reminder_eligible_now has already
          confirmed the free cap was hit on 3+ separate days this week, so
          the promise here ("we'll message you") is grounded in something
          that already happened, not speculation. "Non merci" is a real,
          equally-weighted second choice (AppSheet's secondaryAction), not
          just a generic dismiss — declining is recorded the same way
          accepting is. */}
      <AppSheet
        visible={PAYWALL_ENABLED && showWhatsappConsent}
        onClose={() => setShowWhatsappConsent(false)}
        icon="logo-whatsapp"
        title="On vous facilite ça ?"
        body="La prochaine fois, un tap suffira : on vous envoie le lien de paiement par WhatsApp. Une seule fois."
        action={{
          label: 'Oui, prévenez-moi',
          onPress: () => { if (businessId) void recordWhatsappConsent(businessId, true); },
        }}
        secondaryAction={{
          label: 'Non merci',
          onPress: () => { if (businessId) void recordWhatsappConsent(businessId, false); },
        }}
      />
    </Screen>
  );
}

function makeStyles(p: Palette) {
  return StyleSheet.create({
    header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: spacing[5], paddingVertical: spacing[3], borderBottomWidth: 1, borderBottomColor: p.border },
    empty: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: spacing[6] },
    suggestion: { borderRadius: radius.lg, paddingHorizontal: spacing[4], paddingVertical: spacing[3] },
    errorStrip: { paddingHorizontal: spacing[4], paddingVertical: spacing[1] },
    dateSep: { alignItems: 'center', marginVertical: 12 },
    typingRow: { flexDirection: 'row', alignItems: 'center', gap: spacing[2], paddingHorizontal: spacing[4], paddingBottom: spacing[1] },
    quotaRow: { paddingHorizontal: spacing[4], paddingTop: spacing[2], alignItems: 'center' },
    waitCard: { alignItems: 'center', justifyContent: 'center', gap: spacing[2], paddingVertical: spacing[6], paddingHorizontal: spacing[6] },
    waitText: { textAlign: 'center' },
    inputRow: { flexDirection: 'row', alignItems: 'flex-end', gap: spacing[3], paddingHorizontal: spacing[4], paddingTop: spacing[3], borderTopWidth: 1, borderTopColor: p.border },
    // One rounded pill holds both the text input and the trailing mic/send
    // glyph — the glyph is a child of this pill, not a separate circle
    // floating outside it. alignItems: 'flex-end' + the button's own
    // marginBottom keeps the glyph pinned bottom-right as the input grows
    // multiline, instead of drifting to the vertical center of a tall box.
    composerPill: { flex: 1, flexDirection: 'row', alignItems: 'flex-end', borderRadius: radius.lg, backgroundColor: p.surface, paddingLeft: spacing[4], paddingRight: spacing[1], paddingVertical: spacing[1] },
    input: { flex: 1, maxHeight: 100, paddingVertical: spacing[2] + 2, fontSize: 15, color: p.textPrimary },
    pillIconBtn: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center', marginLeft: spacing[1], marginBottom: spacing[1] },
    pillSendBtn: { backgroundColor: p.primary },
    sendBtn: { width: 44, height: 44, borderRadius: 22, backgroundColor: p.primary, alignItems: 'center', justifyContent: 'center' },
    recIconBtn: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
    recIndicator: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: spacing[2], paddingHorizontal: spacing[4], height: 44, borderRadius: radius.lg, backgroundColor: p.surface },
    recDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: p.warning },
    recTimer: { minWidth: 34 },
    rowOwn: { alignItems: 'flex-end', paddingHorizontal: spacing[4], marginVertical: 3 },
    rowOther: { alignItems: 'flex-start', paddingHorizontal: spacing[4], marginVertical: 3 },
    bubble: { maxWidth: '82%', borderRadius: 18, paddingHorizontal: spacing[4], paddingVertical: spacing[3] },
    bubbleOwn: { backgroundColor: p.primary },
    bubbleOther: { backgroundColor: p.surface, borderWidth: 1, borderColor: p.border },
    bubbleText: { fontSize: 15, lineHeight: 21, color: p.textPrimary },
  });
}
