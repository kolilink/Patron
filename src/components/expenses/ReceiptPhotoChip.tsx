import { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import { Ionicons } from '@expo/vector-icons';
import { Text } from '@/src/components/ui/Text';
import { useTheme, spacing, radius } from '@/src/theme';
import { attachTransactionProof } from '@/lib/proofs';
import { useSyncStore } from '@/stores/sync';
import { toast } from '@/stores/toast';
import { FAILURE_COPY } from '@/src/utils/failureCopy';

// "Ajouter une photo du reçu ?" — offered AFTER the expense is saved, never a
// gate on saving. The photo attaches to the just-saved expense (post-hoc attach
// RPC); a not-yet-synced expense is sent first, and offline we say so plainly.
export function ReceiptPhotoChip({ expenseId, businessId, offline, onDone, onDismiss }: {
  expenseId: string;
  businessId: string;
  offline: boolean;
  onDone: () => void;
  onDismiss: () => void;
}) {
  const { palette } = useTheme();
  const [busy, setBusy] = useState(false);

  const add = async () => {
    if (busy) return;
    if (offline) { toast.info('Hors ligne'); return; }
    try {
      const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (status !== 'granted') { toast.warning("Autorisez l'accès aux photos"); return; }
      const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 1 });
      if (result.canceled || !result.assets?.[0]) return;
      const a = result.assets[0];
      setBusy(true);
      // The expense must exist server-side before a proof can be attached.
      await useSyncStore.getState().sync();
      await attachTransactionProof({
        kind: 'expense', id: expenseId, businessId,
        fileUri: a.uri, sourceWidth: a.width, sourceHeight: a.height,
      });
      toast.success('Photo ajoutée');
      onDone();
    } catch {
      // failure: speaks — expense saved, photo not attached: proofNotAttached toast
      toast.info(`${FAILURE_COPY.proofNotAttached.what} ${FAILURE_COPY.proofNotAttached.why}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={[styles.chip, { backgroundColor: palette.surface, borderColor: palette.border }]}>
      <Pressable onPress={add} style={styles.main} accessibilityRole="button">
        <Ionicons name="camera-outline" size={18} color={palette.textPrimary} />
        <Text variant="bodySmall" style={{ color: palette.textPrimary }}>
          {busy ? 'Ajout…' : 'Ajouter une photo du reçu ?'}
        </Text>
      </Pressable>
      <Pressable onPress={onDismiss} hitSlop={12} accessibilityRole="button" accessibilityLabel="Fermer">
        <Ionicons name="close" size={18} color={palette.textSecondary} />
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  chip: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing[3],
    alignSelf: 'center', paddingHorizontal: spacing[4], paddingVertical: spacing[2.5],
    borderRadius: radius.full, borderWidth: 1,
  },
  main: { flexDirection: 'row', alignItems: 'center', gap: spacing[2] },
});
