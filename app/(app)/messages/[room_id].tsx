import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Animated as RNAnimated,
  FlatList,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  TextInput,
  View,
} from 'react-native';
import type { Audio } from 'expo-av';
import * as FileSystem from 'expo-file-system/legacy';
import * as ImagePicker from 'expo-image-picker';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Screen } from '@/src/components/ui/Screen';
import { router, useLocalSearchParams } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { Text } from '@/src/components/ui/Text';
import { VoiceMessageBubble, LiveWaveformBars } from '@/src/components/ui/VoiceMessageBubble';
import { ImageMessageBubble } from '@/src/components/ui/ImageMessageBubble';
import { uploadMessageImage } from '@/lib/chatImages';
import { useTheme, radius, spacing } from '@/src/theme';
import type { Palette } from '@/src/theme';
import { useAuthStore } from '@/stores/auth';
import { usePartnershipsStore } from '@/stores/partnerships';
import { supabase } from '@/lib/supabase';
import { notifyEvent } from '@/src/utils/notifications';
import { translateError } from '@/lib/errors';
import { generateId } from '@/lib/id';
import type { ChatMessage } from '@/src/types';

// expo-av's native module only exists once the app has been rebuilt with this
// dependency linked in — requiring it eagerly would crash older binaries that
// receive this code via an OTA update. Load it lazily so they degrade silently.
function getAudio(): typeof Audio | null {
  try {
    return require('expo-av').Audio;
  } catch {
    return null;
  }
}

// ─── Date helpers ──────────────────────────────────────────────────────────────

function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear()
    && a.getMonth() === b.getMonth()
    && a.getDate() === b.getDate();
}

function dateLabel(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  if (sameDay(d, now)) return "Aujourd'hui";
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (sameDay(d, yesterday)) return 'Hier';
  return d.toLocaleDateString('fr', { weekday: 'long', day: 'numeric', month: 'long' });
}

function timeLabel(iso: string): string {
  return new Date(iso).toLocaleTimeString('fr', { hour: '2-digit', minute: '2-digit' });
}

// ─── Message grouping ──────────────────────────────────────────────────────────

type GroupPos = 'standalone' | 'first' | 'middle' | 'last';

interface GroupedMessage extends ChatMessage {
  _pos: GroupPos;
  _showDate: boolean;
  _dateLabel: string;
  _senderChanged: boolean; // true when this message's sender differs from the previous message
}

function buildGrouped(messages: ChatMessage[]): GroupedMessage[] {
  const result: GroupedMessage[] = [];
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    const prev = i > 0 ? messages[i - 1] : null;
    const next = i < messages.length - 1 ? messages[i + 1] : null;
    // Time-based grouping for bubble corner shaping (unchanged)
    const prevSame = prev?.sender_id === msg.sender_id
      && Math.abs(new Date(msg.created_at).getTime() - new Date(prev.created_at).getTime()) < 5 * 60_000;
    const nextSame = next?.sender_id === msg.sender_id
      && Math.abs(new Date(next.created_at).getTime() - new Date(msg.created_at).getTime()) < 5 * 60_000;
    let pos: GroupPos;
    if (!prevSame && !nextSame) pos = 'standalone';
    else if (!prevSame) pos = 'first';
    else if (!nextSame) pos = 'last';
    else pos = 'middle';
    const showDate = !prev || !sameDay(new Date(prev.created_at), new Date(msg.created_at));
    // Sender-change is independent of time — only identity matters for name/spacing
    const senderChanged = !prev || prev.sender_id !== msg.sender_id;
    result.push({ ...msg, _pos: pos, _showDate: showDate, _dateLabel: dateLabel(msg.created_at), _senderChanged: senderChanged });
  }
  return result;
}

// ─── Component ─────────────────────────────────────────────────────────────────

export default function DmChatScreen() {
  const { room_id, partnership_id } = useLocalSearchParams<{ room_id: string; partnership_id: string }>();
  const { palette } = useTheme();
  const insets = useSafeAreaInsets();
  const styles = makeStyles(palette);

  const session = useAuthStore(s => s.session);
  const userId = session?.user.id ?? '';
  const userName = session?.user.name ?? '';
  const businessId = session?.activeBusiness?.id ?? '';
  const businessName = session?.activeBusiness?.name ?? '';

  const { partners, markDmRead, updatePartnerSettings, removePartner } = usePartnershipsStore();
  const partner = partners.find(p => p.partnership_id === partnership_id);
  const partnerName = partner?.display_name ?? 'Partenaire';
  const partnerBizId = partner?.partner_business_id ?? '';

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState('');

  // Partner settings modal state
  const [showSettings, setShowSettings] = useState(false);
  // Empty when no custom nickname — placeholder shows the business name
  const [nicknameInput, setNicknameInput] = useState(
    partner && partner.display_name !== partner.partner_business_name ? partner.display_name : '',
  );
  const [shareStockToggle, setShareStockToggle] = useState(partner?.i_share_stock ?? true);
  const [settingsSaving, setSettingsSaving] = useState(false);

  // Voice recording
  const [isRecording, setIsRecording] = useState(false);
  const [recDuration, setRecDuration] = useState(0);
  const [recAmplitudes, setRecAmplitudes] = useState<number[]>([]);
  const recordingRef   = useRef<Audio.Recording | null>(null);
  const recTimerRef    = useRef<ReturnType<typeof setInterval> | null>(null);
  const pulseAnim      = useRef(new RNAnimated.Value(1)).current;

  const flatListRef = useRef<FlatList<GroupedMessage>>(null);
  const channelRef = useRef<ReturnType<typeof supabase.channel> | null>(null);

  // ─── Load messages ─────────────────────────────────────────────────────────
  useEffect(() => {
    if (!room_id) return;
    setLoading(true);
    supabase
      .from('chat_messages')
      .select('*')
      .eq('room_id', room_id)
      .order('created_at', { ascending: true })
      .limit(200)
      .then(({ data }) => {
        setMessages((data ?? []) as ChatMessage[]);
        setLoading(false);
      });
  }, [room_id]);

  // ─── Real-time subscription ────────────────────────────────────────────────
  useEffect(() => {
    if (!room_id) return;
    const ch = supabase
      .channel(`dm:${room_id}`)
      .on('postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'chat_messages', filter: `room_id=eq.${room_id}` },
        payload => {
          const msg = payload.new as ChatMessage;
          setMessages(prev => {
            if (prev.some(m => m.id === msg.id)) return prev;
            return [...prev, msg];
          });
        })
      .subscribe();
    channelRef.current = ch;
    return () => { supabase.removeChannel(ch); };
  }, [room_id]);

  // ─── Mark as read when screen opens ───────────────────────────────────────
  useEffect(() => {
    if (room_id && partnership_id) {
      markDmRead(room_id, partnership_id);
    }
  }, [room_id, partnership_id]);

  // ─── Sync settings modal state with store ──────────────────────────────────
  useEffect(() => {
    if (partner) {
      setNicknameInput(partner.display_name !== partner.partner_business_name ? partner.display_name : '');
      setShareStockToggle(partner.i_share_stock);
    }
  }, [partner?.display_name, partner?.i_share_stock]);

  // ─── Pulsing dot animation while recording ─────────────────────────────────
  useEffect(() => {
    if (!isRecording) { pulseAnim.setValue(1); return; }
    const loop = RNAnimated.loop(RNAnimated.sequence([
      RNAnimated.timing(pulseAnim, { toValue: 0.3, duration: 600, useNativeDriver: true }),
      RNAnimated.timing(pulseAnim, { toValue: 1,   duration: 600, useNativeDriver: true }),
    ]));
    loop.start();
    return () => loop.stop();
  }, [isRecording]);

  // ─── Send message ──────────────────────────────────────────────────────────
  const handleSend = useCallback(async () => {
    const content = text.trim();
    if (!content || sending) return;
    setSending(true);
    setSendError('');
    const optimisticId = `opt-${Date.now()}`;
    const optimistic: ChatMessage = {
      id: optimisticId,
      room_id,
      sender_id: userId,
      sender_name: userName,
      content,
      created_at: new Date().toISOString(),
    };
    setMessages(prev => [...prev, optimistic]);
    setText('');
    setTimeout(() => flatListRef.current?.scrollToEnd({ animated: true }), 50);

    try {
      const { data, error } = await supabase
        .from('chat_messages')
        .insert({ room_id, sender_id: userId, sender_name: userName, content })
        .select()
        .single();
      if (error) throw error;
      setMessages(prev => prev.map(m => m.id === optimisticId ? (data as ChatMessage) : m));

      // Notify partner's business
      if (partnerBizId) {
        notifyEvent({
          businessId: partnerBizId,
          eventType: 'chat_message',
          payload: {
            sender: businessName,
            preview: content.slice(0, 60) + (content.length > 60 ? '…' : ''),
            route: `/(app)/messages/${room_id}?partnership_id=${partnership_id}`,
          },
          targetRoles: ['administrateur', 'manager'],
          excludeUserId: userId,
        });
      }
    } catch (err) {
      setMessages(prev => prev.filter(m => m.id !== optimisticId));
      setText(content);
      setSendError(translateError(err, 'Message non envoyé'));
    } finally {
      setSending(false);
    }
  }, [text, sending, room_id, userId, userName, businessName, partnerBizId]);

  // ─── Partner settings save ─────────────────────────────────────────────────
  const handleSaveSettings = useCallback(async () => {
    if (!partnership_id) return;
    setSettingsSaving(true);
    try {
      await updatePartnerSettings(
        partnership_id,
        businessId,
        nicknameInput.trim() || null,
        shareStockToggle,
      );
      setShowSettings(false);
    } catch {
      // silent
    } finally {
      setSettingsSaving(false);
    }
  }, [partnership_id, businessId, nicknameInput, shareStockToggle, updatePartnerSettings]);

  // ─── Voice recording ───────────────────────────────────────────────────────
  const startRecording = async () => {
    try {
      const A = getAudio();
      if (!A) return;
      const { granted } = await A.requestPermissionsAsync();
      if (!granted) return;
      await A.setAudioModeAsync({ allowsRecordingIOS: true, playsInSilentModeIOS: true });
      const rec = new A.Recording();
      await rec.prepareToRecordAsync({
        isMeteringEnabled: true,
        android: { extension: '.m4a', outputFormat: A.AndroidOutputFormat.MPEG_4, audioEncoder: A.AndroidAudioEncoder.AAC, sampleRate: 16000, numberOfChannels: 1, bitRate: 32000 },
        ios:     { extension: '.m4a', outputFormat: A.IOSOutputFormat.MPEG4AAC, audioQuality: A.IOSAudioQuality.MEDIUM, sampleRate: 16000, numberOfChannels: 1, bitRate: 32000, linearPCMBitDepth: 16, linearPCMIsBigEndian: false, linearPCMIsFloat: false },
        web:     {},
      });
      rec.setOnRecordingStatusUpdate(s => {
        if (s.metering != null) setRecAmplitudes(prev => [...prev.slice(-39), Math.max(0, (s.metering! + 60) / 60)]);
      });
      await rec.startAsync();
      recordingRef.current = rec;
      setIsRecording(true);
      setRecDuration(0);
      setRecAmplitudes([]);
      recTimerRef.current = setInterval(() => setRecDuration(d => d + 1), 1000);
    } catch { /* permission denied or hardware error */ }
  };

  const stopRecording = async (send: boolean) => {
    if (recTimerRef.current) { clearInterval(recTimerRef.current); recTimerRef.current = null; }
    const rec = recordingRef.current;
    if (!rec) return;
    recordingRef.current = null;
    setIsRecording(false);
    try {
      await rec.stopAndUnloadAsync();
      await getAudio()?.setAudioModeAsync({ allowsRecordingIOS: false });
      if (!send) { setRecDuration(0); setRecAmplitudes([]); return; }
      const uri = rec.getURI();
      if (!uri) return;
      const duration = recDuration;
      const waveform = recAmplitudes;
      setRecDuration(0); setRecAmplitudes([]);
      setSending(true);
      const messageId = generateId();
      const storagePath = `${businessId}/${messageId}.m4a`;
      const base64 = await FileSystem.readAsStringAsync(uri, { encoding: FileSystem.EncodingType.Base64 });
      const binary = atob(base64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      const { error: uploadErr } = await supabase.storage.from('voice-messages').upload(storagePath, bytes, { contentType: 'audio/mp4', upsert: false });
      if (uploadErr) throw uploadErr;
      const { data: urlData } = supabase.storage.from('voice-messages').getPublicUrl(storagePath);
      const { data, error } = await supabase.from('chat_messages').insert({
        id: messageId, room_id, sender_id: userId, sender_name: userName, content: '',
        message_type: 'voice', voice_url: urlData.publicUrl, voice_duration: Math.round(duration), voice_waveform: waveform,
      }).select().single();
      if (error) throw error;
      setMessages(prev => prev.some(m => m.id === messageId) ? prev : [...prev, data as ChatMessage]);
      setTimeout(() => flatListRef.current?.scrollToEnd({ animated: true }), 50);
      if (partnerBizId) {
        const mins = Math.floor(duration / 60);
        const secs = String(Math.round(duration % 60)).padStart(2, '0');
        notifyEvent({ businessId: partnerBizId, eventType: 'chat_message', payload: { sender: businessName, preview: `Message vocal · ${mins}:${secs}`, route: `/(app)/messages/${room_id}?partnership_id=${partnership_id}` }, targetRoles: ['administrateur', 'manager'], excludeUserId: userId });
      }
    } catch (err) {
      setSendError(translateError(err, 'Impossible d\'envoyer le message vocal'));
    } finally {
      setSending(false);
    }
  };

  // ─── Image sharing ──────────────────────────────────────────────────────────
  const handlePickImage = async () => {
    const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (status !== 'granted') return;
    const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 1 });
    if (result.canceled || !result.assets?.[0]) return;
    const asset = result.assets[0];

    setSending(true);
    const messageId = generateId();
    try {
      const { url, width, height } = await uploadMessageImage({
        fileUri: asset.uri,
        sourceWidth: asset.width,
        sourceHeight: asset.height,
        storagePath: `chat/${room_id}/${messageId}.jpg`,
      });
      const { data, error } = await supabase.from('chat_messages').insert({
        id: messageId, room_id, sender_id: userId, sender_name: userName, content: '',
        message_type: 'image', image_url: url, image_width: width, image_height: height,
      }).select().single();
      if (error) throw error;
      setMessages(prev => prev.some(m => m.id === messageId) ? prev : [...prev, data as ChatMessage]);
      setTimeout(() => flatListRef.current?.scrollToEnd({ animated: true }), 50);
      if (partnerBizId) {
        notifyEvent({ businessId: partnerBizId, eventType: 'chat_message', payload: { sender: businessName, preview: 'Photo', route: `/(app)/messages/${room_id}?partnership_id=${partnership_id}` }, targetRoles: ['administrateur', 'manager'], excludeUserId: userId });
      }
    } catch (err) {
      setSendError(translateError(err, 'Impossible d\'envoyer l\'image'));
    } finally {
      setSending(false);
    }
  };

  const handleRemovePartner = useCallback(async () => {
    if (!partnership_id) return;
    try {
      await removePartner(partnership_id, businessId);
      router.back();
    } catch {
      // silent
    }
  }, [partnership_id, businessId, removePartner]);

  const confirmRemovePartner = useCallback(() => {
    setShowSettings(false);
    setTimeout(() => {
      Alert.alert(
        `Retirer ${partnerName} ?`,
        'La conversation et le partage de stock seront supprimés des deux côtés.',
        [
          { text: 'Annuler', style: 'cancel' },
          { text: 'Retirer', style: 'destructive', onPress: handleRemovePartner },
        ],
      );
    }, 350);
  }, [partnerName, handleRemovePartner]);

  // ─── Render ────────────────────────────────────────────────────────────────
  const grouped = useMemo(() => buildGrouped(messages), [messages]);

  return (
    <KeyboardAvoidingView
      style={{ flex: 1, backgroundColor: palette.background }}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
    >
      <Screen edges={['top']}>
        {/* Header */}
        <View style={styles.header}>
          <Pressable onPress={() => router.back()} hitSlop={8}>
            <Ionicons name="chevron-back" size={24} color={palette.primary} />
          </Pressable>
          <Pressable onPress={() => setShowSettings(true)} style={{ flex: 1, alignItems: 'center' }}>
            <Text variant="h4" numberOfLines={1}>{partnerName}</Text>
            {partner?.they_share_stock === false ? (
              <Text variant="caption" color="secondary">Stock non partagé</Text>
            ) : (
              <Pressable onPress={() => router.push(`/(app)/partenaire/${partnership_id}/stock`)}>
                <Text variant="caption" style={{ color: palette.primary }}>Voir leur stock →</Text>
              </Pressable>
            )}
          </Pressable>
          <Pressable onPress={() => setShowSettings(true)} hitSlop={8}>
            <Ionicons name="ellipsis-horizontal" size={22} color={palette.textSecondary} />
          </Pressable>
        </View>

        {/* Message list */}
        {loading ? (
          <View style={styles.empty}>
            <Text variant="body" color="secondary">Chargement…</Text>
          </View>
        ) : grouped.length === 0 ? (
          <View style={styles.empty}>
            <Text variant="h4" style={{ textAlign: 'center', marginBottom: 8 }}>Début de la conversation</Text>
            <Text variant="body" color="secondary" style={{ textAlign: 'center', lineHeight: 22 }}>
              Écrivez votre premier message à {partnerName}.
            </Text>
          </View>
        ) : (
          <FlatList<GroupedMessage>
            ref={flatListRef}
            data={grouped}
            keyExtractor={m => m.id}
            style={{ flex: 1 }}
            contentContainerStyle={styles.listContent}
            onContentSizeChange={() => flatListRef.current?.scrollToEnd({ animated: false })}
            renderItem={({ item }) => (
              <>
                {item._showDate && (
                  <View style={styles.dateSep}>
                    <Text variant="caption" style={styles.dateSepText}>{item._dateLabel}</Text>
                  </View>
                )}
                <DmBubble msg={item} isOwn={item.sender_id === userId} pos={item._pos} palette={palette} />
              </>
            )}
          />
        )}

        {sendError ? (
          <View style={styles.errorStrip}>
            <Text variant="caption" style={{ color: palette.warning }}>{sendError}</Text>
          </View>
        ) : null}

        {/* Input row */}
        {isRecording ? (
          <View style={[styles.inputRow, styles.recordingRow, { paddingBottom: Math.max(insets.bottom, spacing[3]) }]}>
            <Pressable onPress={() => stopRecording(false)} hitSlop={10}>
              <Ionicons name="trash-outline" size={22} color={palette.warning} />
            </Pressable>
            <RNAnimated.View style={{ opacity: pulseAnim, width: 8, height: 8, borderRadius: 4, backgroundColor: palette.warning }} />
            <Text style={{ fontSize: 15, fontWeight: '600', minWidth: 36, textAlign: 'center', color: palette.textPrimary }}>
              {Math.floor(recDuration / 60)}:{String(recDuration % 60).padStart(2, '0')}
            </Text>
            <View style={{ flex: 1 }}>
              <LiveWaveformBars samples={recAmplitudes} />
            </View>
            <Pressable onPress={() => stopRecording(true)} style={styles.sendBtn}>
              <Ionicons name="arrow-forward" size={20} color={palette.textInverse} />
            </Pressable>
          </View>
        ) : (
          <View style={[styles.inputRow, { paddingBottom: Math.max(insets.bottom, spacing[3]) }]}>
            <Pressable onPress={handlePickImage} hitSlop={10} style={({ pressed }) => [styles.imgBtn, pressed && { opacity: 0.75 }]}>
              <Ionicons name="image-outline" size={22} color={palette.primary} />
            </Pressable>
            <TextInput
              style={styles.input}
              value={text}
              onChangeText={t => { setText(t); setSendError(''); }}
              placeholder="Écrire un message…"
              placeholderTextColor={palette.textSecondary}
              multiline
              maxLength={1000}
            />
            {text.trim() ? (
              <Pressable
                onPress={handleSend}
                disabled={sending}
                style={({ pressed }) => [styles.sendBtn, sending && { opacity: 0.4 }, pressed && { opacity: 0.75 }]}
              >
                <Ionicons name="arrow-forward" size={20} color={palette.textInverse} />
              </Pressable>
            ) : (
              <Pressable
                onPress={startRecording}
                style={({ pressed }) => [styles.sendBtn, styles.micBtn, pressed && { opacity: 0.75 }]}
              >
                <Ionicons name="mic-outline" size={20} color={palette.primary} />
              </Pressable>
            )}
          </View>
        )}
      </Screen>

      {/* Partner settings modal */}
      <Modal visible={showSettings} animationType="slide" onRequestClose={() => setShowSettings(false)}>
        <View style={styles.safe}>
          <View style={[styles.header, { paddingTop: insets.top + spacing[3] }]}>
            <Pressable onPress={() => setShowSettings(false)} hitSlop={12}>
              <Text variant="body" color="secondary">Fermer</Text>
            </Pressable>
            <Text variant="h4">Options</Text>
            <Pressable onPress={handleSaveSettings} disabled={settingsSaving} hitSlop={12}>
              <Text variant="body" style={{ color: settingsSaving ? palette.textDisabled : palette.primary, fontWeight: '600' }}>
                {settingsSaving ? '…' : 'OK'}
              </Text>
            </Pressable>
          </View>

          <ScrollView
            style={{ flex: 1 }}
            contentContainerStyle={[styles.settingsContent, { paddingBottom: insets.bottom + spacing[6] }]}
            keyboardShouldPersistTaps="handled"
            alwaysBounceVertical={false}
          >
            {/* Nickname */}
            <Text variant="caption" color="secondary" style={styles.settingsLabel}>NOM AFFICHÉ</Text>
            <View style={styles.settingsField}>
              <TextInput
                style={styles.settingsInput}
                value={nicknameInput}
                onChangeText={setNicknameInput}
                placeholder={partner?.partner_business_name ?? 'Nom personnalisé'}
                placeholderTextColor={palette.textSecondary}
                maxLength={40}
              />
            </View>

            {/* Stock share toggle */}
            <Text variant="caption" color="secondary" style={[styles.settingsLabel, { marginTop: 32 }]}>PARTAGE DE STOCK</Text>
            <View style={styles.settingsRow}>
              <View style={{ flex: 1 }}>
                <Text variant="body">Partager mon stock</Text>
                <Text variant="caption" color="secondary">
                  {shareStockToggle
                    ? `${partner?.partner_business_name ?? 'Votre ami'} peut voir votre catalogue`
                    : 'Stock masqué pour cet ami'}
                </Text>
              </View>
              <Switch
                value={shareStockToggle}
                onValueChange={setShareStockToggle}
                trackColor={{ true: palette.primary }}
              />
            </View>

            {/* View partner stock */}
            {partner?.they_share_stock && (
              <Pressable
                style={({ pressed }) => [styles.settingsRow, pressed && { opacity: 0.7 }]}
                onPress={() => { setShowSettings(false); router.push(`/(app)/partenaire/${partnership_id}/stock`); }}
              >
                <Text variant="body" style={{ color: palette.primary }}>Voir le stock de {partnerName}</Text>
                <Ionicons name="chevron-forward" size={18} color={palette.primary} />
              </Pressable>
            )}

            {/* Remove partner — always reachable at the bottom */}
            <Pressable
              style={({ pressed }) => [styles.settingsRemoveRow, pressed && { opacity: 0.7 }]}
              onPress={confirmRemovePartner}
            >
              <Text variant="body" style={{ color: palette.warning }}>Retirer cet ami</Text>
            </Pressable>
          </ScrollView>
        </View>
      </Modal>
    </KeyboardAvoidingView>
  );
}

// ─── DmBubble ─────────────────────────────────────────────────────────────────

function DmBubble({ msg, isOwn, pos, palette }: {
  msg: GroupedMessage;
  isOwn: boolean;
  pos: GroupPos;
  palette: Palette;
}) {
  // Name shows only when sender changes — never on consecutive messages from same person
  const showName = !isOwn && msg._senderChanged;
  // 20px breathing room on sender change, 4px tight grouping within a run
  const marginTop = msg._senderChanged ? 20 : 4;

  const br = 18;
  const br0 = 4;
  const ownRadius = {
    borderTopLeftRadius: br,
    borderTopRightRadius: pos === 'standalone' || pos === 'first' ? br : br0,
    borderBottomRightRadius: pos === 'standalone' || pos === 'last' ? br : br0,
    borderBottomLeftRadius: br,
  };
  const theirRadius = {
    borderTopLeftRadius: pos === 'standalone' || pos === 'first' ? br : br0,
    borderTopRightRadius: br,
    borderBottomRightRadius: br,
    borderBottomLeftRadius: pos === 'standalone' || pos === 'last' ? br : br0,
  };
  const bubbleRadius = isOwn ? ownRadius : theirRadius;

  const renderContent = () => {
    if (msg.message_type === 'voice') {
      if (msg.voice_url) {
        // Pill container gives VoiceMessageBubble a proper surface
        return (
          <View style={{
            maxWidth: '75%',
            backgroundColor: isOwn ? palette.primary : palette.surface,
            paddingHorizontal: 10,
            paddingVertical: 8,
            ...bubbleRadius,
          }}>
            <VoiceMessageBubble msg={msg} isOwn={isOwn} />
          </View>
        );
      }
      return (
        <View style={{ maxWidth: '70%', paddingHorizontal: 14, paddingVertical: 10, backgroundColor: isOwn ? palette.primary : palette.surface, ...bubbleRadius }}>
          <Text style={{ color: isOwn ? palette.textInverse : palette.textSecondary, fontSize: 13 }}>
            Message vocal · {timeLabel(msg.created_at)}
          </Text>
        </View>
      );
    }
    if (msg.message_type === 'image' && msg.image_url) {
      // Sent "naked" — no padded/colored canvas, corners match the bubble radius
      return (
        <View style={{ maxWidth: '75%', overflow: 'hidden', ...bubbleRadius }}>
          <ImageMessageBubble msg={msg} imageStyle={bubbleRadius} />
          <View style={{ paddingHorizontal: 4, paddingTop: 4, paddingBottom: 4 }}>
            {!!msg.content && (
              <Text style={{ color: palette.textPrimary, fontSize: 15, lineHeight: 21 }}>
                {msg.content}
              </Text>
            )}
            <Text style={{ color: palette.textSecondary, fontSize: 11, marginTop: 2, textAlign: 'right' }}>
              {timeLabel(msg.created_at)}
            </Text>
          </View>
        </View>
      );
    }
    return (
      <View style={{ maxWidth: '70%', paddingHorizontal: 14, paddingVertical: 8, backgroundColor: isOwn ? palette.primary : palette.surface, ...bubbleRadius }}>
        <Text style={{ color: isOwn ? palette.textInverse : palette.textPrimary, fontSize: 15, lineHeight: 21 }}>
          {msg.content}
        </Text>
        <Text style={{ color: isOwn ? `${palette.textInverse}99` : palette.textSecondary, fontSize: 11, marginTop: 2, textAlign: 'right' }}>
          {timeLabel(msg.created_at)}
        </Text>
      </View>
    );
  };

  return (
    <View style={{ alignItems: isOwn ? 'flex-end' : 'flex-start', marginHorizontal: 12, marginTop }}>
      {showName && (
        <Text variant="caption" style={{ color: palette.textSecondary, marginLeft: 4, marginBottom: 2 }}>
          {msg.sender_name}
        </Text>
      )}
      {renderContent()}
    </View>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

function makeStyles(p: Palette) {
  return StyleSheet.create({
    safe: { flex: 1, backgroundColor: p.background },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: spacing[4],
      paddingVertical: spacing[3],
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: p.border,
      gap: spacing[3],
    },
    empty: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      padding: spacing[6],
    },
    listContent: { paddingVertical: spacing[4] },
    dateSep: {
      alignItems: 'center',
      marginVertical: spacing[3],
    },
    dateSepText: {
      color: p.textSecondary,
      fontSize: 12,
      backgroundColor: p.background,
      paddingHorizontal: spacing[3],
      paddingVertical: 2,
      borderRadius: radius.full,
      overflow: 'hidden',
    },
    errorStrip: {
      paddingHorizontal: spacing[4],
      paddingVertical: spacing[2],
      backgroundColor: p.warningLight,
    },
    inputRow: {
      flexDirection: 'row',
      alignItems: 'flex-end',
      gap: spacing[2],
      paddingHorizontal: spacing[4],
      paddingTop: spacing[3],
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: p.border,
      backgroundColor: p.surface,
    },
    input: {
      flex: 1,
      minHeight: 40,
      maxHeight: 120,
      borderWidth: 1,
      borderColor: p.border,
      borderRadius: radius.lg,
      paddingHorizontal: spacing[3],
      paddingVertical: spacing[2],
      fontSize: 15,
      color: p.textPrimary,
      backgroundColor: p.background,
    },
    imgBtn: {
      width: 40,
      height: 40,
      alignItems: 'center',
      justifyContent: 'center',
    },
    sendBtn: {
      width: 40,
      height: 40,
      borderRadius: radius.full,
      backgroundColor: p.primary,
      alignItems: 'center',
      justifyContent: 'center',
    },
    micBtn: {
      backgroundColor: `${p.primary}18`,
    },
    recordingRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing[3],
    },
    // Settings modal
    settingsContent: {
      paddingHorizontal: spacing[5],
      paddingTop: spacing[4],
    },
    settingsLabel: {
      fontSize: 11,
      fontWeight: '600',
      letterSpacing: 0.5,
      textTransform: 'uppercase',
      marginBottom: 6,
    },
    settingsField: {
      borderWidth: 1,
      borderColor: p.border,
      borderRadius: radius.lg,
      backgroundColor: p.surface,
      paddingHorizontal: spacing[3],
    },
    settingsInput: {
      height: 48,
      fontSize: 16,
      color: p.textPrimary,
    },
    settingsRow: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingVertical: spacing[4],
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: p.border,
      gap: spacing[3],
    },
    settingsRemoveRow: {
      paddingVertical: spacing[5],
      marginTop: spacing[6],
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: p.border,
    },
  });
}
