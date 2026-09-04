import { useState } from 'react';
import { ActivityIndicator, Alert, Modal, Platform, Pressable, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Image } from 'expo-image';
import * as ImagePicker from 'expo-image-picker';
import { Ionicons } from '@expo/vector-icons';
import { Text } from '@/src/components/ui/Text';
import { useTheme, spacing, radius, colors } from '@/src/theme';
import type { Palette } from '@/src/theme';
import { attachTransactionProof, deleteTransactionProof, type ProofKind } from '@/lib/proofs';
import { translateError } from '@/lib/errors';
import { toast } from '@/stores/toast';
import { haptics } from '@/lib/haptics';
import { useAuthStore } from '@/stores/auth';

const DELETE_WINDOW_MS = 24 * 60 * 60 * 1000;

// Shared "preuve" (photo proof) affordance for apports, expenses and
// purchase orders — see db/migration_v155.sql and lib/proofs.ts.
//   · Has a proof   → a view control that opens a full-screen viewer.
//   · No proof, may attach, online → an "add" control (library picker →
//     upload → attach_transaction_proof RPC → onAttached refetch).
//   · No proof, may attach, offline → disabled with a hint.
//   · No proof, may NOT attach → renders nothing (keeps rows clean).
// Two shapes: `inline` (a bare icon, for the tight apport list rows) and
// `row` (a labeled full-width control, for the expense card + PO detail).

interface ProofControlProps {
  kind: ProofKind;
  id: string;
  businessId: string;
  imageUrl?: string | null;
  imageWidth?: number | null;
  imageHeight?: number | null;
  // Who attached the current proof, and when — drives the delete button in
  // the full-screen viewer. Both must be present and match the current user
  // (within DELETE_WINDOW_MS) for it to show at all; see db/migration_v168.sql
  // for the same rule enforced server-side, which is the real gate.
  attachedBy?: string | null;
  attachedAt?: string | null;
  canAttach: boolean;
  offline?: boolean;
  onAttached?: (proof: { url: string; width: number; height: number }) => void;
  onDeleted?: () => void;
  variant?: 'inline' | 'row';
}

export function ProofControl({
  kind, id, businessId, imageUrl, imageWidth, imageHeight,
  attachedBy, attachedAt, canAttach, offline, onAttached, onDeleted, variant = 'row',
}: ProofControlProps) {
  const { palette } = useTheme();
  const styles = makeStyles(palette);
  const currentUserId = useAuthStore(s => s.session?.user.id);
  const [uploading, setUploading] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [viewerOpen, setViewerOpen] = useState(false);
  const insets = useSafeAreaInsets();
  // statusBarTranslucent (below) draws the viewer Modal behind the status
  // bar on Android — nudge the close button down by the real inset so it
  // doesn't end up under/near the status bar or a camera cutout.
  const closeTop = Platform.OS === 'android' ? styles.closeBtn.top + insets.top : styles.closeBtn.top;

  const hasProof = !!imageUrl;
  const canDelete = hasProof
    && !!attachedBy && attachedBy === currentUserId
    && !!attachedAt && (Date.now() - new Date(attachedAt).getTime()) < DELETE_WINDOW_MS;

  const handleDelete = () => {
    Alert.alert(
      'Supprimer cette image ?',
      'Cette action est définitive.',
      [
        { text: 'Annuler', style: 'cancel' },
        {
          text: 'Supprimer',
          style: 'destructive',
          onPress: () => {
            void (async () => {
              setDeleting(true);
              try {
                await deleteTransactionProof({ kind, id });
                haptics.success();
                toast.success('Image supprimée');
                setViewerOpen(false);
                onDeleted?.();
              } catch (err) {
                toast.warning(translateError(err, 'Impossible de supprimer l\'image'));
              } finally {
                setDeleting(false);
              }
            })();
          },
        },
      ],
    );
  };

  const handleAttach = async () => {
    if (uploading) return;
    try {
      const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (status !== 'granted') {
        toast.warning('Autorisez l\'accès aux photos pour ajouter une image');
        return;
      }
      const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 1 });
      if (result.canceled || !result.assets?.[0]) return;
      const asset = result.assets[0];

      setUploading(true);
      const proof = await attachTransactionProof({
        kind, id, businessId,
        fileUri: asset.uri,
        sourceWidth: asset.width,
        sourceHeight: asset.height,
      });
      haptics.success();
      toast.success('Image ajoutée');
      onAttached?.(proof);
    } catch (err) {
      toast.warning(translateError(err, 'Impossible d\'ajouter l\'image'));
    } finally {
      setUploading(false);
    }
  };

  // Nothing to show: no proof and the viewer can't attach one.
  if (!hasProof && !canAttach) return null;

  const viewer = hasProof ? (
    <Modal visible={viewerOpen} transparent animationType="fade" onRequestClose={() => setViewerOpen(false)} statusBarTranslucent navigationBarTranslucent>
      <Pressable style={styles.backdrop} onPress={() => setViewerOpen(false)}>
        <Image source={{ uri: imageUrl! }} style={styles.fullImage} contentFit="contain" />
        <Pressable style={[styles.closeBtn, { top: closeTop }]} onPress={() => setViewerOpen(false)} hitSlop={12}>
          <Ionicons name="close" size={26} color={colors.neutral[0]} />
        </Pressable>
        {canDelete && (
          <Pressable
            style={[styles.deleteBtn, { bottom: Math.max(insets.bottom, spacing[5]) + spacing[4] }]}
            onPress={(e) => { e.stopPropagation(); if (!deleting) handleDelete(); }}
            disabled={deleting}
          >
            {deleting
              ? <ActivityIndicator size="small" color={colors.neutral[0]} />
              : <Ionicons name="trash-outline" size={18} color={colors.danger[500]} />}
            <Text variant="label" style={{ color: colors.danger[500] }}>
              {deleting ? 'Suppression…' : 'Supprimer'}
            </Text>
          </Pressable>
        )}
      </Pressable>
    </Modal>
  ) : null;

  // ── Inline (icon only) ──────────────────────────────────────────────────────
  if (variant === 'inline') {
    if (hasProof) {
      return (
        <>
          <Pressable onPress={() => setViewerOpen(true)} hitSlop={10} style={styles.iconBtn}>
            <Ionicons name="image" size={20} color={palette.primary} />
          </Pressable>
          {viewer}
        </>
      );
    }
    // canAttach === true here
    if (offline) {
      return (
        <View style={styles.iconBtn}>
          <Ionicons name="cloud-offline-outline" size={20} color={palette.textDisabled} />
        </View>
      );
    }
    return (
      <Pressable onPress={handleAttach} hitSlop={10} style={styles.iconBtn} disabled={uploading}>
        {uploading
          ? <ActivityIndicator size="small" color={palette.textSecondary} />
          : <Ionicons name="camera-outline" size={20} color={palette.textSecondary} />}
      </Pressable>
    );
  }

  // ── Row (labeled) ───────────────────────────────────────────────────────────
  if (hasProof) {
    const w = imageWidth || 1;
    const h = imageHeight || 1;
    const thumbH = Math.min(48, Math.round(48 * (h / w)) || 48);
    return (
      <>
        <Pressable onPress={() => setViewerOpen(true)} style={styles.rowBtn}>
          <Image
            source={{ uri: imageUrl! }}
            style={{ width: 48, height: thumbH, borderRadius: radius.sm }}
            contentFit="cover"
          />
          <Ionicons name="eye-outline" size={16} color={palette.primary} />
          <Text variant="label" style={{ color: palette.primary }}>Voir l'image</Text>
        </Pressable>
        {viewer}
      </>
    );
  }
  // canAttach === true here
  if (offline) {
    return (
      <View style={[styles.rowBtn, { borderColor: palette.border }]}>
        <Ionicons name="cloud-offline-outline" size={16} color={palette.textDisabled} />
        <Text variant="label" color="secondary">Image indisponible hors ligne</Text>
      </View>
    );
  }
  return (
    <Pressable onPress={handleAttach} style={[styles.rowBtn, { borderColor: palette.border }]} disabled={uploading}>
      {uploading
        ? <ActivityIndicator size="small" color={palette.textSecondary} />
        : <Ionicons name="camera-outline" size={16} color={palette.textSecondary} />}
      <Text variant="label" color="secondary">{uploading ? 'Envoi…' : 'Ajouter une image'}</Text>
    </Pressable>
  );
}

function makeStyles(p: Palette) {
  return StyleSheet.create({
    iconBtn: { padding: 4, alignItems: 'center', justifyContent: 'center' },
    rowBtn: {
      flexDirection: 'row', alignItems: 'center', gap: spacing[2],
      paddingVertical: spacing[2], paddingHorizontal: spacing[3],
      borderRadius: radius.md, borderWidth: 1, borderColor: 'transparent',
      alignSelf: 'flex-start',
    },
    backdrop: {
      flex: 1, backgroundColor: 'rgba(0,0,0,0.92)',
      alignItems: 'center', justifyContent: 'center',
    },
    fullImage: { width: '100%', height: '80%' },
    closeBtn: {
      position: 'absolute', top: 56, right: 20,
      width: 40, height: 40, borderRadius: 20,
      backgroundColor: 'rgba(255,255,255,0.15)',
      alignItems: 'center', justifyContent: 'center',
    },
    deleteBtn: {
      position: 'absolute', alignSelf: 'center',
      flexDirection: 'row', alignItems: 'center', gap: spacing[2],
      paddingHorizontal: spacing[5], paddingVertical: spacing[3],
      borderRadius: radius.full,
      backgroundColor: 'rgba(255,255,255,0.12)',
      borderWidth: 1, borderColor: 'rgba(248,113,113,0.4)',
    },
  });
}
