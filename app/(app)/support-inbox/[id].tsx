import { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, FlatList, KeyboardAvoidingView, Platform, Pressable, StyleSheet, TextInput, View } from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Screen } from '@/src/components/ui/Screen';
import { router, useLocalSearchParams } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { Text } from '@/src/components/ui/Text';
import { SupportMessageBubble } from '@/src/components/ui/SupportMessageBubble';
import { useTheme, spacing, radius } from '@/src/theme';
import type { Palette } from '@/src/theme';
import { useAuthStore } from '@/stores/auth';
import { useSupportChatStore } from '@/stores/supportChat';
import { isFounderPhone } from '@/src/utils/founder';
import { haptics } from '@/lib/haptics';
import { isSep, buildGroupedItems } from '@/src/lib/chatGrouping';
import type { SupportMessage } from '@/src/types';

export default function SupportInboxDetailScreen() {
  const { palette } = useTheme();
  const styles = useMemo(() => makeStyles(palette), [palette]);
  const insets = useSafeAreaInsets();
  const { id } = useLocalSearchParams<{ id: string }>();
  const session = useAuthStore(s => s.session);
  const isFounder = isFounderPhone(session?.user.phone);

  const {
    activeFounderConversation, founderMessages, founderDraft, founderDetailLoading,
    loadConversationDetail, sendFounderReply, sendFounderImageReply, requestAiDraft, closeConversation,
  } = useSupportChatStore();

  const [text, setText] = useState('');
  const [usedDraft, setUsedDraft] = useState(false);
  const [sending, setSending] = useState(false);
  // Synchronous lock — `sending` state doesn't commit until the next render,
  // so a fast double-tap can fire both calls before either sees it as true.
  // This is what actually stopped the duplicate-message reports.
  const sendingRef = useRef(false);

  useEffect(() => {
    // See app/(app)/support-inbox/index.tsx — router.back() with no history
    // (e.g. this screen reached directly from a cold-start notification tap)
    // used to strand the navigator on "Unmatched Route" instead of redirecting.
    if (!isFounder) {
      if (router.canGoBack()) router.back();
      else router.replace('/(app)/(tabs)/');
      return;
    }
    if (id) loadConversationDetail(id);
  }, [isFounder, id]);

  const reversedMessages = useMemo(() => founderMessages.slice().reverse(), [founderMessages]);
  const listItems = useMemo(() => buildGroupedItems(reversedMessages), [reversedMessages]);

  if (!isFounder || !id) return null;

  // A draft answers the conversation as of when it was generated — if the
  // founder has since sent a reply (from this device or another), the draft
  // no longer applies and must not be resendable, even if it's still cached
  // in state for a moment.
  const draftIsStale = founderDraft
    ? founderMessages.some(m => m.sender_role === 'founder' && new Date(m.created_at) > new Date(founderDraft.created_at))
    : false;
  const showDraftCard = !draftIsStale && founderDraft
    && (founderDraft.status === 'pending' || founderDraft.status === 'ready' || founderDraft.status === 'failed');

  const handleUseDraft = () => {
    if (!founderDraft?.draft_content) return;
    setText(founderDraft.draft_content);
    setUsedDraft(true);
  };

  const handleSendAsIs = async () => {
    if (!founderDraft?.draft_content || sendingRef.current) return;
    sendingRef.current = true;
    setSending(true);
    try {
      await sendFounderReply({ conversationId: id, content: founderDraft.draft_content, usedAiDraft: true });
    } catch {
      haptics.error();
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
  };

  const handleSend = async () => {
    const trimmed = text.trim();
    if (!trimmed || sendingRef.current) return;
    sendingRef.current = true;
    setSending(true);
    try {
      await sendFounderReply({ conversationId: id, content: trimmed, usedAiDraft: usedDraft });
      setText('');
      setUsedDraft(false);
    } catch {
      haptics.error();
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
  };

  const handlePickImage = async () => {
    const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (status !== 'granted') return;
    const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 1 });
    if (result.canceled || !result.assets?.[0]) return;
    const asset = result.assets[0];
    try {
      await sendFounderImageReply({
        conversationId: id,
        fileUri: asset.uri,
        sourceWidth: asset.width,
        sourceHeight: asset.height,
      });
    } catch {
      haptics.error();
    }
  };

  const handleClose = () => {
    Alert.alert('Marquer comme résolu ?', '', [
      { text: 'Annuler', style: 'cancel' },
      { text: 'Marquer résolu', onPress: async () => { await closeConversation(id); router.back(); } },
    ]);
  };

  return (
    <KeyboardAvoidingView style={{ flex: 1, backgroundColor: palette.background }} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
      <Screen edges={['top']}>
        <View style={styles.header}>
          <Pressable onPress={() => router.back()}>
            <Text variant="body" color="secondary">‹ Retour</Text>
          </Pressable>
          <View style={{ flex: 1, alignItems: 'center' }}>
            <Text variant="h4" numberOfLines={1}>Support</Text>
            {activeFounderConversation?.rating != null && (
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                <Ionicons name="star" size={11} color={palette.warning} />
                <Text variant="caption" color="secondary">{activeFounderConversation.rating}/5</Text>
              </View>
            )}
          </View>
          <Pressable onPress={handleClose}>
            <Text variant="caption" style={{ color: palette.primary }}>Résolu</Text>
          </Pressable>
        </View>

        {founderDetailLoading && founderMessages.length === 0 ? (
          <View style={styles.empty}><Text variant="body" color="secondary">Chargement…</Text></View>
        ) : (
          <FlatList
            data={listItems}
            keyExtractor={item => item.id}
            inverted
            style={{ flex: 1 }}
            contentContainerStyle={{ paddingVertical: spacing[3], flexGrow: 1, justifyContent: 'flex-end' }}
            renderItem={({ item }) => {
              if (isSep(item)) {
                return (
                  <View style={styles.dateSep}>
                    <Text variant="caption" color="secondary">{item.label}</Text>
                  </View>
                );
              }
              return (
                <SupportMessageBubble
                  msg={item}
                  isOwn={item.sender_role === 'founder'}
                  pos={item._pos}
                  showName={item._pos === 'standalone' || item._pos === 'first'}
                />
              );
            }}
          />
        )}

        {showDraftCard && (
          <View style={styles.draftCard}>
            <View style={styles.draftHeader}>
              <Ionicons name="sparkles-outline" size={14} color={palette.primary} />
              <Text variant="labelSmall" style={{ color: palette.primary }}>Suggestion IA</Text>
              <View style={{ flex: 1 }} />
              <Pressable onPress={() => id && requestAiDraft(id)} hitSlop={8}>
                <Ionicons name="refresh-outline" size={16} color={palette.textSecondary} />
              </Pressable>
            </View>
            {founderDraft?.status === 'pending' ? (
              <Text variant="caption" color="secondary">Génération en cours…</Text>
            ) : founderDraft?.status === 'failed' ? (
              <Text variant="caption" color="secondary">La suggestion n'a pas pu être générée.</Text>
            ) : (
              <>
                <Text variant="bodySmall" style={{ lineHeight: 20 }} numberOfLines={4}>
                  {founderDraft?.draft_content}
                </Text>
                <View style={styles.draftActions}>
                  <Pressable onPress={handleUseDraft} style={styles.draftActionBtn}>
                    <Text variant="label" style={{ color: palette.primary }}>Modifier</Text>
                  </Pressable>
                  <Pressable onPress={handleSendAsIs} disabled={sending} style={[styles.draftActionBtn, styles.draftSendBtn]}>
                    <Text variant="label" style={{ color: palette.textInverse }}>Envoyer tel quel</Text>
                  </Pressable>
                </View>
              </>
            )}
          </View>
        )}

        <View style={[styles.inputRow, { paddingBottom: Math.max(insets.bottom, spacing[3]) }]}>
          <Pressable onPress={handlePickImage} hitSlop={10} style={({ pressed }) => [styles.imgBtn, pressed && { opacity: 0.75 }]}>
            <Ionicons name="image-outline" size={22} color={palette.primary} />
          </Pressable>
          <TextInput
            style={styles.input}
            value={text}
            onChangeText={v => { setText(v); if (usedDraft) setUsedDraft(false); }}
            placeholder="Écrire une réponse…"
            placeholderTextColor={palette.textSecondary}
            multiline
            maxLength={2000}
          />
          {text.trim().length > 0 && (
            <Pressable
              onPress={handleSend}
              disabled={sending}
              style={({ pressed }) => [styles.sendBtn, pressed && { opacity: 0.6 }]}
            >
              <Ionicons name="arrow-forward" size={20} color={palette.textInverse} />
            </Pressable>
          )}
        </View>
      </Screen>
    </KeyboardAvoidingView>
  );
}

function makeStyles(p: Palette) {
  return StyleSheet.create({
    header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: spacing[5], paddingVertical: spacing[3], borderBottomWidth: 1, borderBottomColor: p.border },
    empty: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing[8] },
    dateSep: { alignItems: 'center', marginVertical: 12 },
    draftCard: { marginHorizontal: spacing[4], marginBottom: spacing[2], padding: spacing[4], borderRadius: radius.lg, backgroundColor: p.primaryLight, borderWidth: 1, borderColor: p.primary, gap: spacing[2] },
    draftHeader: { flexDirection: 'row', alignItems: 'center', gap: spacing[2] },
    draftActions: { flexDirection: 'row', gap: spacing[2], marginTop: spacing[1] },
    draftActionBtn: { flex: 1, alignItems: 'center', paddingVertical: spacing[2], borderRadius: radius.md, borderWidth: 1, borderColor: p.primary },
    draftSendBtn: { backgroundColor: p.primary, borderColor: p.primary },
    inputRow: { flexDirection: 'row', alignItems: 'flex-end', gap: spacing[3], paddingHorizontal: spacing[4], paddingTop: spacing[3], borderTopWidth: 1, borderTopColor: p.border },
    input: { flex: 1, maxHeight: 100, borderWidth: 1, borderColor: p.border, borderRadius: radius.lg, paddingHorizontal: spacing[4], paddingVertical: spacing[3], fontSize: 15, color: p.textPrimary, backgroundColor: p.surface },
    imgBtn: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
    sendBtn: { width: 44, height: 44, borderRadius: 22, backgroundColor: p.primary, alignItems: 'center', justifyContent: 'center' },
  });
}
