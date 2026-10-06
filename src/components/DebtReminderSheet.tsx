import { useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, StyleSheet, useWindowDimensions, View } from 'react-native';
import { captureRef } from 'react-native-view-shot';
import * as Sharing from 'expo-sharing';
import { FormSheet } from '@/src/components/ui/FormSheet';
import { Button } from '@/src/components/ui/Button';
import { Text } from '@/src/components/ui/Text';
import { failAlert } from '@/src/components/ui/FailureView';
import { useInFlight } from '@/src/hooks/useInFlight';
import { useTheme, spacing, radius } from '@/src/theme';
import type { Palette } from '@/src/theme';
import {
  DebtReminderReceipt, RECEIPT_ASPECT, RECEIPT_EXPORT_HEIGHT, RECEIPT_EXPORT_WIDTH,
} from '@/src/components/DebtReminderReceipt';
import {
  buildDebtReceiptContent, defaultReminderTone, type DebtReceiptInput, type ReminderTone,
} from '@/src/utils/debtReceipt';

interface Props {
  visible: boolean;
  onClose: () => void;
  input: DebtReceiptInput;
  /** Age in days of the oldest open debt — picks the default tone. */
  daysOldestDebt: number;
}

const TONES: { key: ReminderTone; label: string }[] = [
  { key: 'doux', label: 'Doux' },
  { key: 'ferme', label: 'Ferme' },
];

// The vendor sees exactly the image she will send. Generation is fully
// on-device (view-shot + expo-sharing), so it works offline. wa.me URLs cannot
// carry an image — the system share sheet is the honest path to WhatsApp.
export function DebtReminderSheet({ visible, onClose, input, daysOldestDebt }: Props) {
  const { palette } = useTheme();
  const styles = useMemo(() => makeStyles(palette), [palette]);
  const { width: windowWidth } = useWindowDimensions();
  const receiptRef = useRef<View>(null);
  const [tone, setTone] = useState<ReminderTone>(defaultReminderTone(daysOldestDebt));
  const [sharing, runShare] = useInFlight();

  // Re-seed the default each time the sheet opens (age may have changed).
  useEffect(() => {
    if (visible) setTone(defaultReminderTone(daysOldestDebt));
  }, [visible, daysOldestDebt]);

  const content = useMemo(() => buildDebtReceiptContent(input, tone), [input, tone]);
  const previewWidth = Math.min(windowWidth - spacing[4] * 2, 360);

  const handleShare = () => runShare(async () => {
    if (!receiptRef.current) return;
    try {
      const uri = await captureRef(receiptRef, {
        format: 'png', quality: 1, width: RECEIPT_EXPORT_WIDTH, height: RECEIPT_EXPORT_HEIGHT,
      });
      if (!(await Sharing.isAvailableAsync())) { failAlert('receiptNotShared'); return; }
      await Sharing.shareAsync(uri, { mimeType: 'image/png', UTI: 'public.png', dialogTitle: 'Envoyer le rappel' });
    } catch {
      // failure: speaks — capture or share sheet failed: receiptNotShared
      failAlert('receiptNotShared');
    }
  });

  return (
    <FormSheet
      visible={visible}
      onClose={onClose}
      title="Rappel"
      footer={
        <View style={styles.footer}>
          <Button
            label="Partager"
            loading={sharing}
            loadingLabel="Préparation"
            fullWidth
            onPress={handleShare}
          />
        </View>
      }
    >
      <View style={styles.toggle}>
        {TONES.map(t => {
          const active = t.key === tone;
          return (
            <Pressable
              key={t.key}
              onPress={() => setTone(t.key)}
              style={[styles.toggleItem, active && styles.toggleItemActive]}
            >
              <Text variant="label" style={{ color: active ? palette.textInverse : palette.textPrimary }}>{t.label}</Text>
            </Pressable>
          );
        })}
      </View>

      <View style={[styles.previewWrap, { width: previewWidth, aspectRatio: RECEIPT_ASPECT }]}>
        <DebtReminderReceipt ref={receiptRef} content={content} width={previewWidth} />
      </View>
    </FormSheet>
  );
}

function makeStyles(p: Palette) {
  return StyleSheet.create({
    toggle: {
      flexDirection: 'row', alignSelf: 'center', borderRadius: radius.full,
      borderWidth: 1, borderColor: p.border, padding: 3, marginBottom: spacing[4],
    },
    toggleItem: { paddingHorizontal: spacing[5], paddingVertical: spacing[2], borderRadius: radius.full },
    toggleItemActive: { backgroundColor: p.textPrimary },
    previewWrap: { alignSelf: 'center', overflow: 'hidden', borderRadius: radius.md },
    footer: { padding: spacing[4], backgroundColor: p.background },
  });
}
