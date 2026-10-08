import { StyleSheet } from 'react-native';
import { FormSheet } from '@/src/components/ui/FormSheet';
import { ReceiptPanel } from '@/src/components/ReceiptPanel';
import { spacing } from '@/src/theme';
import type { ReceiptSource } from '@/src/utils/saleReceipt';

interface Props {
  /** Null = closed. The panel is keyed on the source so each opening starts from fresh drafts. */
  source: ReceiptSource | null;
  onClose: () => void;
  onRequestSyncedEdit?: () => void;
}

// "Reçu": the one place a sale receipt is previewed, corrected (while still
// queued) and shared — same shape as the debt reminder's sheet. Stays mounted
// for the whole capture and share; nothing here auto-dismisses.
export function SaleReceiptSheet({ source, onClose, onRequestSyncedEdit }: Props) {
  return (
    <FormSheet
      visible={!!source}
      onClose={onClose}
      title="Reçu"
      keyboardShouldPersistTaps="handled"
      contentContainerStyle={styles.content}
    >
      {source ? (
        <ReceiptPanel key={`${source.kind}:${source.key ?? source.date.getTime()}`} source={source} onRequestSyncedEdit={onRequestSyncedEdit} />
      ) : null}
    </FormSheet>
  );
}

const styles = StyleSheet.create({
  content: { padding: spacing[4], gap: spacing[5] },
});
