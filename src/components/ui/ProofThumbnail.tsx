import { useState } from 'react';
import { Image, Modal, Pressable, StyleSheet, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { radius, colors } from '@/src/theme';

// A small, view-only glimpse of an attached proof — the receipt shown as
// itself, not an icon standing in for it. Sits quietly in a list row; tap
// opens the real thing full screen. Deliberately tiny and calm so it never
// competes with the amount it accompanies.
export function ProofThumbnail({
  url, size = 34,
}: {
  url: string;
  width?: number | null;
  height?: number | null;
  size?: number;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Pressable onPress={() => setOpen(true)} hitSlop={8}>
        <Image
          source={{ uri: url }}
          style={{ width: size, height: size, borderRadius: radius.sm, backgroundColor: colors.neutral[100] }}
          resizeMode="cover"
        />
      </Pressable>

      <Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)}>
        <Pressable style={styles.backdrop} onPress={() => setOpen(false)}>
          <Image source={{ uri: url }} style={styles.full} resizeMode="contain" />
          <Pressable style={styles.close} onPress={() => setOpen(false)} hitSlop={12}>
            <Ionicons name="close" size={26} color={colors.neutral[0]} />
          </Pressable>
        </Pressable>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.92)', alignItems: 'center', justifyContent: 'center' },
  full: { width: '100%', height: '80%' },
  close: {
    position: 'absolute', top: 56, right: 20,
    width: 40, height: 40, borderRadius: 20,
    backgroundColor: 'rgba(255,255,255,0.15)',
    alignItems: 'center', justifyContent: 'center',
  },
});
