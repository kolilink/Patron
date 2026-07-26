import { useState } from 'react';
import { ActivityIndicator, Modal, Pressable, StyleSheet, View } from 'react-native';
import { Image } from 'expo-image';
import * as ImagePicker from 'expo-image-picker';
import { Ionicons } from '@expo/vector-icons';
import { Text } from '@/src/components/ui/Text';
import { useTheme, spacing, radius, colors } from '@/src/theme';
import type { Palette } from '@/src/theme';
import { toast } from '@/stores/toast';

export type PickedImage = { uri: string; width: number; height: number };

// The photo well: recording a receipt as a natural field of the form, like
// the amount or the date — not a button bolted on after. Empty, it's a calm
// invitation; filled, it simply becomes the photo. An already-attached proof
// is shown immutable (add once, never replace — the DB enforces it too).
interface ProofPhotoFieldProps {
  existingUrl?: string | null;
  existingWidth?: number | null;
  existingHeight?: number | null;
  value: PickedImage | null;
  onChange: (v: PickedImage | null) => void;
  disabled?: boolean;   // offline — can't upload
}

// Show the receipt at its own proportions (never a fixed-height crop, which
// looked awkward on tall screenshots), capped so a very tall image can't run
// off the sheet.
const MAX_PREVIEW_H = 420;
function aspectOf(w?: number | null, h?: number | null): number {
  return w && h && w > 0 && h > 0 ? w / h : 4 / 3;
}

export function ProofPhotoField({ existingUrl, existingWidth, existingHeight, value, onChange, disabled }: ProofPhotoFieldProps) {
  const { palette } = useTheme();
  const styles = makeStyles(palette);
  const [viewerOpen, setViewerOpen] = useState(false);
  const [picking, setPicking] = useState(false);

  const pick = async () => {
    if (picking) return;
    try {
      const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (status !== 'granted') {
        toast.warning('Autorisez l\'accès aux photos');
        return;
      }
      setPicking(true);
      const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 1 });
      if (result.canceled || !result.assets?.[0]) return;
      const a = result.assets[0];
      onChange({ uri: a.uri, width: a.width, height: a.height });
    } finally {
      setPicking(false);
    }
  };

  // ── Already attached: immutable, view-only ────────────────────────────────
  if (existingUrl) {
    return (
      <View style={{ gap: spacing[2] }}>
        <Text variant="label">Image</Text>
        <Pressable onPress={() => setViewerOpen(true)}>
          <Image
            source={{ uri: existingUrl }}
            style={[styles.preview, { aspectRatio: aspectOf(existingWidth, existingHeight) }]}
            contentFit="contain"
          />
        </Pressable>
        <Modal visible={viewerOpen} transparent animationType="fade" onRequestClose={() => setViewerOpen(false)}>
          <Pressable style={styles.backdrop} onPress={() => setViewerOpen(false)}>
            <Image source={{ uri: existingUrl }} style={styles.full} contentFit="contain" />
            <Pressable style={styles.close} onPress={() => setViewerOpen(false)} hitSlop={12}>
              <Ionicons name="close" size={26} color={colors.neutral[0]} />
            </Pressable>
          </Pressable>
        </Modal>
      </View>
    );
  }

  // ── Locally picked, not yet saved ─────────────────────────────────────────
  if (value) {
    return (
      <View style={{ gap: spacing[2] }}>
        <Text variant="label">Image</Text>
        <Image
          source={{ uri: value.uri }}
          style={[styles.preview, { aspectRatio: aspectOf(value.width, value.height) }]}
          contentFit="contain"
        />

        <View style={styles.actionsRow}>
          <Pressable onPress={pick} hitSlop={6}><Text variant="label" style={{ color: palette.primary }}>Changer</Text></Pressable>
          <Pressable onPress={() => onChange(null)} hitSlop={6}><Text variant="label" color="secondary">Retirer</Text></Pressable>
        </View>
      </View>
    );
  }

  // ── Offline: can't upload ─────────────────────────────────────────────────
  if (disabled) {
    return (
      <View style={{ gap: spacing[2] }}>
        <Text variant="label">Image <Text variant="caption" color="secondary">(optionnel)</Text></Text>
        <View style={[styles.well, styles.wellDisabled]}>
          <Ionicons name="cloud-offline-outline" size={20} color={palette.textDisabled} />
          <Text variant="caption" color="secondary">Indisponible hors ligne</Text>
        </View>
      </View>
    );
  }

  // ── Empty: the invitation ─────────────────────────────────────────────────
  return (
    <View style={{ gap: spacing[2] }}>
      <Text variant="label">Photo <Text variant="caption" color="secondary">(optionnel)</Text></Text>
      <Pressable onPress={pick} style={styles.well} disabled={picking}>
        {picking
          ? <ActivityIndicator size="small" color={palette.textSecondary} />
          : <Ionicons name="image-outline" size={22} color={palette.textSecondary} />}
        <Text variant="body" color="secondary">Ajouter une image</Text>
      </Pressable>
    </View>
  );
}

function makeStyles(p: Palette) {
  return StyleSheet.create({
    well: {
      height: 96,
      borderRadius: radius.lg,
      borderWidth: 1,
      borderColor: p.border,
      backgroundColor: p.surface,
      alignItems: 'center',
      justifyContent: 'center',
      gap: spacing[2],
    },
    wellDisabled: { backgroundColor: p.background },
    preview: {
      width: '100%',
      maxHeight: MAX_PREVIEW_H,
      borderRadius: radius.lg,
      backgroundColor: colors.neutral[100],
    },
    actionsRow: { flexDirection: 'row', gap: spacing[5], paddingHorizontal: spacing[1] },
    backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.92)', alignItems: 'center', justifyContent: 'center' },
    full: { width: '100%', height: '80%' },
    close: {
      position: 'absolute', top: 56, right: 20,
      width: 40, height: 40, borderRadius: 20,
      backgroundColor: 'rgba(255,255,255,0.15)',
      alignItems: 'center', justifyContent: 'center',
    },
  });
}
