// The ONE capture + share sequence for every receipt image (debt reminder and
// all sale receipts). Fully on-device (view-shot + expo-sharing): it never
// checks connectivity and never awaits the network, so build → edit → capture →
// share works with zero signal. wa.me URLs cannot carry an image — the system
// share sheet is the honest path to WhatsApp.
//
// Deliberately has NO auto-dismiss, timers or modal-closing of its own: the
// caller's sheet stays mounted for the whole capture and the whole share, so
// nothing can unmount the view captureRef/shareAsync still need.
import type { RefObject } from 'react';
import type { View } from 'react-native';
import { captureRef } from 'react-native-view-shot';
import * as Sharing from 'expo-sharing';
import { RECEIPT_EXPORT_HEIGHT, RECEIPT_EXPORT_WIDTH } from '@/src/utils/debtReceipt';

export type ReceiptShareResult = 'shared' | 'unavailable' | 'failed';

export async function captureAndShareReceipt(
  ref: RefObject<View | null>,
  dialogTitle: string,
): Promise<ReceiptShareResult> {
  if (!ref.current) return 'failed';
  try {
    const uri = await captureRef(ref, {
      format: 'png', quality: 1, width: RECEIPT_EXPORT_WIDTH, height: RECEIPT_EXPORT_HEIGHT,
    });
    if (!(await Sharing.isAvailableAsync())) return 'unavailable';
    await Sharing.shareAsync(uri, { mimeType: 'image/png', UTI: 'public.png', dialogTitle });
    return 'shared';
  } catch {
    return 'failed';
  }
}
