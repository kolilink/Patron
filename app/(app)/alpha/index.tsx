import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FlatList, InteractionManager, KeyboardAvoidingView, Platform, Pressable, StyleSheet, TextInput, View } from 'react-native';
import { Screen } from '@/src/components/ui/Screen';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { Text } from '@/src/components/ui/Text';
import { SkeletonList } from '@/src/components/ui/SkeletonPlaceholder';
import { PaywallScreen } from '@/src/components/PaywallScreen';
import { useTheme, spacing, radius } from '@/src/theme';
import type { Palette } from '@/src/theme';
import { useAuthStore } from '@/stores/auth';
import { useAlphaStore } from '@/stores/alpha';
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
  return h > 0 ? `${h}h${String(m).padStart(2, '0')}` : `${m}min`;
}

export default function AlphaScreen() {
  const { palette } = useTheme();
  const styles = useMemo(() => makeStyles(palette), [palette]);
  const session = useAuthStore(s => s.session);
  const businessId = session?.activeBusiness?.id ?? '';
  const params = useLocalSearchParams<{ q?: string }>();

  const { messages, quota, loading, sending, error, offline, load, sendMessage } = useAlphaStore();
  const [text, setText] = useState('');
  const [pendingQuestion, setPendingQuestion] = useState<string | null>(null);
  // Set on a blocked send attempt while at the paid-tier cap — renders the
  // plain waitCard instead of the upgrade popup, since offering an upgrade
  // to someone already paying is nonsensical. Self-clears once quota is no
  // longer exhausted (see the render check below), so a stale true value
  // from before the window reset can never hide the input row.
  const [waitBlocked, setWaitBlocked] = useState(false);
  const autoSentRef = useRef(false);
  const listRef = useRef<FlatList<GroupedItem<GroupableAlphaMessage>>>(null);
  const inputRef = useRef<TextInput>(null);

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
  const freeQuotaExhausted = !!quota && !quota.in_welcome_burst && !quota.has_ai_access && quota.remaining <= 0;
  const paidQuotaExhausted = !!quota && !quota.in_welcome_burst && quota.has_ai_access && quota.remaining <= 0;

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

    setText('');
    setWaitBlocked(false);
    await sendMessage({ businessId, content: trimmed });
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

  const handlePurchased = async () => {
    const q = pendingQuestion;
    setPendingQuestion(null);
    setWaitBlocked(false);
    if (q) {
      await sendMessage({ businessId, content: q });
    }
  };

  return (
    <Screen edges={['top']}>
      <View style={styles.header}>
        <Pressable onPress={() => router.back()}>
          <Text variant="body" color="secondary">‹ Retour</Text>
        </Pressable>
        <Text variant="h4" style={{ fontWeight: '800' }}>A</Text>
        <View style={{ width: 60 }} />
      </View>

      {/* Wraps only the content below the header — a KeyboardAvoidingView
          around fixed chrome like the header above can throw off how much
          bottom padding it computes, leaving the input sitting slightly
          into the keyboard instead of snug above it. */}
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
        {offline && (
          <View style={{ paddingHorizontal: spacing[4], paddingTop: spacing[1] }}>
            <Text variant="caption" color="secondary">Pas de connexion</Text>
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

        {pendingQuestion && session?.activeBusiness ? (
          <PaywallScreen
            business={session.activeBusiness}
            inline
            onDismiss={() => { setPendingQuestion(null); setWaitBlocked(false); }}
            onPurchased={handlePurchased}
          />
        ) : waitBlocked && paidQuotaExhausted ? (
          <View style={styles.waitCard}>
            <Ionicons name="time-outline" size={18} color={palette.textSecondary} />
            <Text variant="bodySmall" color="secondary" style={styles.waitText}>
              Vous pourrez reparler à Alpha dans {formatCountdown(quota?.next_reset_at)}.
            </Text>
          </View>
        ) : (
          <>
            {quota && !quota.in_welcome_burst && !quota.has_ai_access && (
              <View style={styles.quotaRow}>
                <Text variant="caption" color="secondary">
                  {quota.remaining > 0
                    ? `${quota.remaining} question${quota.remaining > 1 ? 's' : ''} gratuite${quota.remaining > 1 ? 's' : ''} restante${quota.remaining > 1 ? 's' : ''}`
                    : `Prochaine question gratuite dans ${formatCountdown(quota.next_reset_at)}`}
                </Text>
              </View>
            )}
            <View style={styles.inputRow}>
              <TextInput
                ref={inputRef}
                style={styles.input}
                value={text}
                onChangeText={setText}
                placeholder="Parler avec Alpha…"
                placeholderTextColor={palette.textSecondary}
                multiline
                maxLength={500}
                onSubmitEditing={() => handleSend()}
                returnKeyType="send"
                blurOnSubmit={false}
                autoFocus
              />
              {text.trim().length > 0 && (
                <Pressable
                  onPress={() => handleSend()}
                  disabled={sending}
                  style={({ pressed }) => [styles.sendBtn, pressed && { opacity: 0.6 }]}
                >
                  <Ionicons name="arrow-forward" size={20} color={palette.textInverse} />
                </Pressable>
              )}
            </View>
          </>
        )}
      </KeyboardAvoidingView>
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
    input: { flex: 1, maxHeight: 100, borderRadius: radius.lg, paddingHorizontal: spacing[4], paddingVertical: spacing[3], fontSize: 15, color: p.textPrimary, backgroundColor: p.surface },
    sendBtn: { width: 44, height: 44, borderRadius: 22, backgroundColor: p.primary, alignItems: 'center', justifyContent: 'center' },
    rowOwn: { alignItems: 'flex-end', paddingHorizontal: spacing[4], marginVertical: 3 },
    rowOther: { alignItems: 'flex-start', paddingHorizontal: spacing[4], marginVertical: 3 },
    bubble: { maxWidth: '82%', borderRadius: 18, paddingHorizontal: spacing[4], paddingVertical: spacing[3] },
    bubbleOwn: { backgroundColor: p.primary },
    bubbleOther: { backgroundColor: p.surface, borderWidth: 1, borderColor: p.border },
    bubbleText: { fontSize: 15, lineHeight: 21, color: p.textPrimary },
  });
}
