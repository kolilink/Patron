import { useMemo } from 'react';
import { View, StyleSheet } from 'react-native';
import { Text } from './Text';
import { ImageMessageBubble } from './ImageMessageBubble';
import { useTheme, spacing } from '@/src/theme';
import type { Palette } from '@/src/theme';
import { bubbleMargins, bubbleRadius, showsMeta } from '@/src/lib/chatGrouping';
import type { GroupPos } from '@/src/lib/chatGrouping';
import type { SupportMessage } from '@/src/types';

const LOCALE = Intl.DateTimeFormat().resolvedOptions().locale;

// Same clustering logic as the boutique chat (src/lib/chatGrouping.ts), applied
// to the merchant↔founder support thread: consecutive messages from the same
// sender collapse into one visual group with one shared timestamp, instead of
// the sender name and time repeating on every single line.
export function SupportMessageBubble({ msg, isOwn, pos, showName, otherName }: {
  msg: SupportMessage;
  isOwn: boolean;
  pos: GroupPos;
  showName: boolean;
  /** Label for incoming bubbles — e.g. the merchant view shows "Support Patron", the founder inbox shows the merchant's real name. */
  otherName?: string;
}) {
  const { palette } = useTheme();
  const styles = useMemo(() => makeStyles(palette), [palette]);
  const time    = new Date(msg.created_at).toLocaleTimeString(LOCALE, { hour: '2-digit', minute: '2-digit' });
  const margins = bubbleMargins(pos);
  const br      = bubbleRadius(isOwn, pos);
  const isImage = msg.message_type === 'image' && !!msg.image_url;

  return (
    <View style={[margins, isOwn ? styles.rowOwn : styles.rowOther]}>
      <View style={[styles.bubble, isImage ? null : (isOwn ? styles.bubbleOwn : styles.bubbleOther), isImage ? null : br]}>
        {showName && !isOwn && (
          <Text variant="labelSmall" style={{ color: palette.primary, marginBottom: 2 }}>
            {otherName ?? msg.sender_name}
          </Text>
        )}
        {isImage ? (
          <>
            {/* Sent "naked" — no padded/colored canvas, corners match the bubble group shape */}
            <ImageMessageBubble msg={msg} imageStyle={br} />
            {(!!msg.content || showsMeta(pos)) && (
              <View style={styles.imageCaption}>
                {!!msg.content && (
                  <Text style={styles.bubbleText}>{msg.content}</Text>
                )}
                {showsMeta(pos) && (
                  <Text style={[styles.ts, { color: palette.textSecondary }]}>{time}</Text>
                )}
              </View>
            )}
          </>
        ) : (
          <>
            <Text style={[styles.bubbleText, isOwn && { color: palette.textInverse }]}>
              {msg.content}
            </Text>
            {showsMeta(pos) && (
              <Text style={[styles.ts, { color: isOwn ? 'rgba(255,255,255,0.7)' : palette.textSecondary }]}>
                {time}
              </Text>
            )}
          </>
        )}
      </View>
    </View>
  );
}

function makeStyles(p: Palette) {
  return StyleSheet.create({
    rowOwn:   { alignItems: 'flex-end' as const, paddingHorizontal: spacing[4] },
    rowOther: { alignItems: 'flex-start' as const, paddingHorizontal: spacing[4] },
    bubble: { maxWidth: '82%' },
    bubbleOwn:   { backgroundColor: p.primary, paddingHorizontal: spacing[4], paddingVertical: spacing[3] },
    bubbleOther: { backgroundColor: p.surface, borderWidth: 1, borderColor: p.border, paddingHorizontal: spacing[4], paddingVertical: spacing[3] },
    bubbleText:  { fontSize: 15, lineHeight: 21, color: p.textPrimary },
    imageCaption: { marginTop: spacing[1] },
    ts:          { fontSize: 11, marginTop: 4, textAlign: 'right' as const },
  });
}
