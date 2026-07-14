import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FlatList, InteractionManager, KeyboardAvoidingView, Platform, Pressable, StyleSheet, TextInput, View } from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Screen } from '@/src/components/ui/Screen';
import { router, useFocusEffect } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { Text } from '@/src/components/ui/Text';
import { SupportMessageBubble } from '@/src/components/ui/SupportMessageBubble';
import { useTheme, spacing, radius } from '@/src/theme';
import type { Palette } from '@/src/theme';
import { useAuthStore } from '@/stores/auth';
import { useSupportChatStore } from '@/stores/supportChat';
import { supabase } from '@/lib/supabase';
import { haptics } from '@/lib/haptics';
import { isSep, buildGroupedItems } from '@/src/lib/chatGrouping';
import type { GroupedItem } from '@/src/lib/chatGrouping';
import type { SupportConversation, SupportMessage } from '@/src/types';

function RatingPrompt({ conversationId }: { conversationId: string }) {
  const { palette } = useTheme();
  const styles = useMemo(() => makeStyles(palette), [palette]);
  const submitRating = useSupportChatStore(s => s.submitRating);
  const [submitting, setSubmitting] = useState<number | null>(null);
  const [submitted, setSubmitted] = useState(false);

  const handleRate = async (rating: number) => {
    if (submitting) return;
    setSubmitting(rating);
    try {
      await submitRating(conversationId, rating);
      haptics.success();
      setSubmitted(true);
    } catch {
      haptics.error();
    } finally {
      setSubmitting(null);
    }
  };

  if (submitted) {
    return (
      <View style={styles.ratingCard}>
        <Text variant="bodySmall" color="secondary">Merci pour votre retour !</Text>
      </View>
    );
  }

  return (
    <View style={styles.ratingCard}>
      <Text variant="bodySmall" style={{ textAlign: 'center' }}>Comment évaluez-vous ce support ?</Text>
      <View style={styles.starRow}>
        {[1, 2, 3, 4, 5].map(n => (
          <Pressable key={n} onPress={() => handleRate(n)} hitSlop={8} disabled={submitting !== null}>
            <Ionicons name="star" size={30} color={palette.warning} />
          </Pressable>
        ))}
      </View>
    </View>
  );
}

export default function SupportScreen() {
  const { palette } = useTheme();
  const styles = useMemo(() => makeStyles(palette), [palette]);
  const insets = useSafeAreaInsets();
  const session = useAuthStore(s => s.session);
  const businessId = session?.activeBusiness?.id ?? '';
  const userName = session?.user.name || 'Membre';

  const { conversation, messages, loading, sending, error, offline, load, sendMessage, sendImageMessage, appendMessage, updateConversation } = useSupportChatStore();
  const [text, setText] = useState('');
  const listRef = useRef<FlatList<GroupedItem<SupportMessage>>>(null);
  const inputRef = useRef<TextInput>(null);
  const channelRef = useRef<ReturnType<typeof supabase.channel> | null>(null);

  useFocusEffect(useCallback(() => {
    if (!businessId) return;
    load(businessId);
  }, [businessId]));

  useFocusEffect(useCallback(() => {
    const task = InteractionManager.runAfterInteractions(() => {
      inputRef.current?.focus();
    });
    return () => task.cancel();
  }, []));

  useEffect(() => {
    const convId = conversation?.id;
    if (!convId) return;
    const ch = supabase
      .channel(`support:${convId}`)
      .on('postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'support_messages', filter: `conversation_id=eq.${convId}` },
        p => appendMessage(p.new as SupportMessage))
      .on('postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'support_conversations', filter: `id=eq.${convId}` },
        p => updateConversation(p.new as SupportConversation))
      .subscribe();
    channelRef.current = ch;
    return () => { supabase.removeChannel(ch); channelRef.current = null; };
  }, [conversation?.id]);

  const reversedMessages = useMemo(() => messages.slice().reverse(), [messages]);
  const listItems = useMemo(() => buildGroupedItems(reversedMessages), [reversedMessages]);

  const handleSend = async () => {
    const trimmed = text.trim();
    if (!trimmed || sending) return;
    setText('');
    await sendMessage({ businessId, senderName: userName, content: trimmed });
  };

  const handlePickImage = async () => {
    const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (status !== 'granted') return;
    const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 1 });
    if (result.canceled || !result.assets?.[0]) return;
    const asset = result.assets[0];
    await sendImageMessage({
      businessId,
      senderName: userName,
      fileUri: asset.uri,
      sourceWidth: asset.width,
      sourceHeight: asset.height,
    });
  };

  return (
    <KeyboardAvoidingView style={{ flex: 1, backgroundColor: palette.background }} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
      <Screen edges={['top']}>
        <View style={styles.header}>
          <Pressable onPress={() => router.back()}>
            <Text variant="body" color="secondary">‹ Retour</Text>
          </Pressable>
          <Text variant="h4">Support</Text>
          <View style={{ width: 60 }} />
        </View>

        {offline && (
          <View style={{ paddingHorizontal: spacing[4], paddingTop: spacing[1] }}>
            <Text variant="caption" color="secondary">Hors ligne — le message sera envoyé à la reconnexion</Text>
          </View>
        )}

        {loading && messages.length === 0 ? (
          <View style={styles.empty}>
            <Text variant="body" color="secondary">Chargement…</Text>
          </View>
        ) : messages.length === 0 ? (
          <View style={styles.empty}>
            <Text variant="body" color="secondary" style={{ textAlign: 'center', lineHeight: 22 }}>
              Décrivez votre inquiétude et un membre de l'équipe vous assistera
            </Text>
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
              const isOwn = item.sender_role === 'merchant';
              return (
                <SupportMessageBubble
                  msg={item}
                  isOwn={isOwn}
                  pos={item._pos}
                  showName={item._pos === 'standalone' || item._pos === 'first'}
                  otherName="Support Patron"
                />
              );
            }}
          />
        )}

        {error ? (
          <View style={styles.errorStrip}>
            <Text variant="caption" style={{ color: palette.danger }}>{error}</Text>
          </View>
        ) : null}

        {conversation?.status === 'closed' && conversation.rating == null && (
          <RatingPrompt conversationId={conversation.id} />
        )}

        <View style={[styles.inputRow, { paddingBottom: Math.max(insets.bottom, spacing[3]) }]}>
          <Pressable onPress={handlePickImage} hitSlop={10} style={({ pressed }) => [styles.imgBtn, pressed && { opacity: 0.75 }]}>
            <Ionicons name="image-outline" size={22} color={palette.primary} />
          </Pressable>
          <TextInput
            ref={inputRef}
            style={styles.input}
            value={text}
            onChangeText={setText}
            placeholderTextColor={palette.textSecondary}
            multiline
            maxLength={1000}
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
    errorStrip: { paddingHorizontal: spacing[4], paddingVertical: spacing[1] },
    dateSep: { alignItems: 'center', marginVertical: 12 },
    inputRow: { flexDirection: 'row', alignItems: 'flex-end', gap: spacing[3], paddingHorizontal: spacing[4], paddingTop: spacing[3], borderTopWidth: 1, borderTopColor: p.border },
    input: { flex: 1, maxHeight: 100, borderWidth: 1, borderColor: p.border, borderRadius: radius.lg, paddingHorizontal: spacing[4], paddingVertical: spacing[3], fontSize: 15, color: p.textPrimary, backgroundColor: p.surface },
    imgBtn: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
    sendBtn: { width: 44, height: 44, borderRadius: 22, backgroundColor: p.primary, alignItems: 'center', justifyContent: 'center' },
    ratingCard: { marginHorizontal: spacing[4], marginBottom: spacing[2], padding: spacing[4], borderRadius: radius.lg, backgroundColor: p.surface, borderWidth: 1, borderColor: p.border, alignItems: 'center', gap: spacing[2] },
    starRow: { flexDirection: 'row', gap: spacing[2] },
  });
}
