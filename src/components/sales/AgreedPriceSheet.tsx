import { useEffect, useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { FormSheet } from '@/src/components/ui/FormSheet';
import { Button } from '@/src/components/ui/Button';
import { Text } from '@/src/components/ui/Text';
import { Money, MoneyText } from '@/src/components/ui/Money';
import { ExpenseKeypad } from '@/src/components/expenses/ExpenseKeypad';
import { pressKey, keypadValue } from '@/src/utils/expenseUtils';
import type { KeypadKey } from '@/src/utils/expenseUtils';
import { formatAmount } from '@/src/utils/format';
import { useTheme, spacing } from '@/src/theme';

interface Props {
  visible: boolean;
  productName: string;
  qty: number;
  /** Catalogue price per piece ("Prix habituel"). */
  catalogPrice: number;
  /** Price currently charged per piece (agreed one if any) — pre-fills the amount. */
  currentPrice: number;
  currency: string;
  onValidate: (agreedUnitPrice: number) => void;
  onClose: () => void;
}

/** "Prix convenu": the price negotiated out loud for ONE cart line. Never touches the catalogue product. */
export function AgreedPriceSheet({ visible, productName, qty, catalogPrice, currentPrice, currency, onValidate, onClose }: Props) {
  const { palette } = useTheme();
  const styles = useMemo(() => makeStyles(), []);
  const [raw, setRaw] = useState('');
  // POS convention: the first digit starts a new price instead of editing the old one.
  const [fresh, setFresh] = useState(true);

  useEffect(() => {
    if (!visible) return;
    setRaw(String(Math.round(currentPrice * 100) / 100));
    setFresh(true);
  }, [visible, currentPrice]);

  const onKey = (k: KeypadKey) => {
    const base = fresh && k !== 'back' ? '' : raw;
    setFresh(false);
    setRaw(pressKey(base, k, currency));
  };

  const value = keypadValue(raw);
  const valid = value > 0;

  return (
    <FormSheet
      visible={visible}
      onClose={onClose}
      title="Prix convenu"
      cancelLabel="Fermer"
      scrollable={false}
      footer={
        <View style={styles.footer}>
          <Button label="Annuler" variant="outline" onPress={onClose} style={{ flex: 1 }} />
          <Button label="Valider" onPress={() => valid && onValidate(value)} disabled={!valid} style={{ flex: 1 }} />
        </View>
      }
    >
      <View style={styles.body}>
        <Text variant="label" numberOfLines={1}>{productName}</Text>
        <Text variant="caption" color="secondary">par pièce</Text>
        <MoneyText variant="caption" color="secondary" style={{ marginTop: spacing[1] }}>
          {`Prix habituel : ${formatAmount(catalogPrice, currency)}`}
        </MoneyText>
        <View style={styles.amountBox}>
          <Money amount={value} currency={currency} variant="amountLarge" fit="full" testID="agreed-price-amount" style={{ textAlign: 'center', color: palette.textPrimary }} />
          <MoneyText variant="body" color="secondary" style={{ textAlign: 'center' }} testID="agreed-price-total">
            {`Total : ${formatAmount(value * qty, currency)}`}
          </MoneyText>
        </View>
        <ExpenseKeypad currency={currency} onKey={onKey} />
      </View>
    </FormSheet>
  );
}

function makeStyles() {
  return StyleSheet.create({
    body: { paddingHorizontal: spacing[4], paddingTop: spacing[2], gap: spacing[1] },
    amountBox: { alignItems: 'stretch', gap: spacing[1], paddingVertical: spacing[5] },
    footer: { flexDirection: 'row', gap: spacing[3], paddingHorizontal: spacing[4] },
  });
}
