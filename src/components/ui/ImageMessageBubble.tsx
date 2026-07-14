import { useState } from 'react';
import { Image, ImageStyle, Modal, Pressable, StyleProp, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { colors } from '@/src/theme';

const THUMB_MAX_W = 220;
const THUMB_MAX_H = 280;

// Minimal shape shared by ChatMessage and SupportMessage — avoids coupling
// this component to either type specifically.
export interface ImageMessageLike {
  image_url?: string | null;
  image_width?: number | null;
  image_height?: number | null;
}

// `imageStyle` lets the caller pass the exact per-corner radius of the
// surrounding bubble group (see chatGrouping's bubbleRadius) so the image's
// own corners line up with it exactly — the image is sent "naked" (no
// padded/colored bubble around it), so its own corners ARE the bubble shape.
export function ImageMessageBubble({ msg, imageStyle }: { msg: ImageMessageLike; imageStyle?: StyleProp<ImageStyle> }) {
  const [viewerOpen, setViewerOpen] = useState(false);
  if (!msg.image_url) return null;

  // Dimensions are known up front (captured at upload time) so the bubble
  // reserves its final size immediately — no layout jank while the image loads.
  const w = msg.image_width || THUMB_MAX_W;
  const h = msg.image_height || THUMB_MAX_W;
  const ratio = w / h;
  let displayW = THUMB_MAX_W;
  let displayH = displayW / ratio;
  if (displayH > THUMB_MAX_H) {
    displayH = THUMB_MAX_H;
    displayW = displayH * ratio;
  }

  return (
    <>
      <Pressable onPress={() => setViewerOpen(true)}>
        <Image
          source={{ uri: msg.image_url }}
          style={[{ width: displayW, height: displayH, borderRadius: 12 }, imageStyle]}
          resizeMode="cover"
        />
      </Pressable>

      <Modal visible={viewerOpen} transparent animationType="fade" onRequestClose={() => setViewerOpen(false)}>
        <Pressable style={styles.backdrop} onPress={() => setViewerOpen(false)}>
          <Image source={{ uri: msg.image_url }} style={styles.fullImage} resizeMode="contain" />
          <Pressable style={styles.closeBtn} onPress={() => setViewerOpen(false)} hitSlop={12}>
            <Ionicons name="close" size={26} color={colors.neutral[0]} />
          </Pressable>
        </Pressable>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.92)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  fullImage: {
    width: '100%',
    height: '80%',
  },
  closeBtn: {
    position: 'absolute',
    top: 56,
    right: 20,
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: 'rgba(255,255,255,0.15)',
    alignItems: 'center',
    justifyContent: 'center',
  },
});
