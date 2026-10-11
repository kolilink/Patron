import { useMemo, useRef } from 'react';
import { StyleSheet, useWindowDimensions, View } from 'react-native';
import { FormSheet } from '@/src/components/ui/FormSheet';
import { Button } from '@/src/components/ui/Button';
import { failAlert } from '@/src/components/ui/FailureView';
import { useInFlight } from '@/src/hooks/useInFlight';
import { useTheme, spacing, radius } from '@/src/theme';
import type { Palette } from '@/src/theme';
import { DebtReminderReceipt, RECEIPT_ASPECT } from '@/src/components/DebtReminderReceipt';
import { captureAndShareReceipt } from '@/src/components/receiptShare';
import {
  buildDebtReceiptContent, type DebtReceiptInput,
} from '@/src/utils/debtReceipt';

interface Props {
  visible: boolean;
  onClose: () => void;
  input: DebtReceiptInput;
}

// The vendor sees exactly the image she will send. Generation is fully
// on-device (view-shot + expo-sharing), so it works offline. wa.me URLs cannot
// carry an image — the system share sheet is the honest path to WhatsApp.
export function DebtReminderSheet({ visible, onClose, input }: Props) {
  const { palette } = useTheme();
  const styles = useMemo(() => makeStyles(palette), [palette]);
  const { width: windowWidth } = useWindowDimensions();
  const receiptRef = useRef<View>(null);
  const [sharing, runShare] = useInFlight();

  const content = useMemo(() => buildDebtReceiptContent(input), [input]);
  const previewWidth = Math.min(windowWidth - spacing[4] * 2, 360);

  const handleShare = () => runShare(async () => {
    const res = await captureAndShareReceipt(receiptRef, 'Envoyer le rappel');
    // failure: speaks — capture or share sheet failed: receiptNotShared
    if (res !== 'shared') failAlert('receiptNotShared');
  });

  return (
    <FormSheet
      visible={visible}
      onClose={onClose}
      title="Rappel"
      contentContainerStyle={styles.content}
    >
      <View style={[styles.previewWrap, { width: previewWidth, aspectRatio: RECEIPT_ASPECT }]}>
        <DebtReminderReceipt ref={receiptRef} content={content} width={previewWidth} />
      </View>
      {/* Directly under the card (not pinned to the sheet bottom): immediately
          reachable, no dead gap between the receipt and its action. */}
      <Button
        label="Partager"
        loading={sharing}
        loadingLabel="Préparation"
        fullWidth
        onPress={handleShare}
      />
    </FormSheet>
  );
}

function makeStyles(p: Palette) {
  return StyleSheet.create({
    previewWrap: { alignSelf: 'center', overflow: 'hidden', borderRadius: radius.md },
    content: { padding: spacing[4], gap: spacing[5] },
  });
}
