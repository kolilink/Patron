import { Dimensions, StyleSheet, View } from 'react-native';
import { Text } from './Text';
import { colors, palette, spacing } from '@/src/theme';
import { formatAmount } from '@/src/utils/format';
const W = Dimensions.get('window').width;

export interface ReceiptItem {
  name: string;
  qty: number;
  unit_price: number;
  is_bulk: boolean;
}

export interface ReceiptPayment {
  method: string;
  amount: number;
}

export interface ReceiptData {
  businessName: string;
  currency: string;
  items: ReceiptItem[];
  total: number;
  payment: ReceiptPayment | null;
  customerName?: string;
  date: Date;
}

const METHOD_LABELS: Record<string, string> = {
  especes: 'Espèces',
  mobile_money: 'Mobile Money',
  carte: 'Carte',
  virement: 'Virement',
};

function formatReceiptDate(d: Date): string {
  const day = d.toLocaleDateString('fr-FR', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
  const time = d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
  return `${day} · ${time}`;
}

export function SaleReceiptView({ data }: { data: ReceiptData }) {
  const { businessName, currency, items, total, payment, customerName, date } = data;
  const isCredit = payment === null;

  return (
    <View style={styles.receipt}>
      {/* Top brand stripe */}
      <View style={styles.stripe} />

      {/* Business + date */}
      <View style={styles.header}>
        <Text variant="h3" style={styles.bizName}>{businessName}</Text>
        <Text variant="caption" style={styles.dateText}>{formatReceiptDate(date)}</Text>
      </View>

      <View style={styles.divider} />

      {/* Items */}
      <View style={styles.items}>
        {items.map((line, i) => (
          <View key={i} style={styles.itemRow}>
            <Text variant="bodySmall" style={styles.itemName} numberOfLines={2}>
              {line.name}{line.is_bulk ? ' (lot)' : ''}
            </Text>
            <Text variant="bodySmall" style={styles.itemQty}>×{line.qty}</Text>
            <Text variant="bodySmall" style={styles.itemAmount}>
              {formatAmount(line.unit_price * line.qty, currency)}
            </Text>
          </View>
        ))}
      </View>

      <View style={styles.divider} />

      {/* Total */}
      <View style={styles.totalRow}>
        <Text variant="overline" style={styles.totalLabel}>Total</Text>
        <Text variant="h2" style={styles.totalAmount}>{formatAmount(total, currency)}</Text>
      </View>

      <View style={styles.divider} />

      {/* Payment status */}
      {isCredit ? (
        <View style={styles.statusSection}>
          <View style={[styles.badge, styles.creditBadge]}>
            <Text variant="label" style={{ color: colors.warning[700] }}>💳  Crédit</Text>
          </View>
          <Text variant="h4" style={styles.creditOwed}>{formatAmount(total, currency)} dû</Text>
          {customerName ? (
            <Text variant="bodySmall" style={styles.clientLine}>Client : {customerName}</Text>
          ) : null}
        </View>
      ) : (
        <View style={styles.statusSection}>
          <View style={[styles.badge, styles.paidBadge]}>
            <Text variant="label" style={{ color: colors.success[700] }}>
              ✓  {METHOD_LABELS[payment.method] ?? payment.method}
            </Text>
          </View>
          {customerName ? (
            <Text variant="bodySmall" style={styles.clientLine}>Client : {customerName}</Text>
          ) : null}
        </View>
      )}

      {/* Footer */}
      <View style={styles.footer}>
        <Text variant="caption" style={styles.merci}>Merci pour votre achat 🤗</Text>
        <Text variant="label" style={styles.brand} numberOfLines={1} adjustsFontSizeToFit>Faites comme nous, gérez votre commerce avec Patron</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  receipt: {
    width: W,
    backgroundColor: '#ffffff',
    overflow: 'hidden',
  },
  stripe: {
    height: 6,
    backgroundColor: palette.primary,
  },
  header: {
    paddingHorizontal: spacing[6],
    paddingTop: spacing[5],
    paddingBottom: spacing[4],
    gap: spacing[1],
  },
  bizName: {
    color: palette.primary,
    fontWeight: '700',
  },
  dateText: {
    color: palette.textSecondary,
  },
  divider: {
    height: 1,
    backgroundColor: colors.neutral[200],
    marginHorizontal: spacing[6],
  },
  items: {
    paddingHorizontal: spacing[6],
    paddingVertical: spacing[4],
    gap: spacing[3],
  },
  itemRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing[3],
  },
  itemName: {
    flex: 1,
    color: palette.textPrimary,
  },
  itemQty: {
    color: palette.textSecondary,
    minWidth: 28,
    textAlign: 'right',
  },
  itemAmount: {
    color: palette.textPrimary,
    fontWeight: '600',
    minWidth: 100,
    textAlign: 'right',
  },
  totalRow: {
    paddingHorizontal: spacing[6],
    paddingVertical: spacing[4],
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  totalLabel: {
    color: palette.textSecondary,
  },
  totalAmount: {
    color: palette.textPrimary,
    fontWeight: '800',
  },
  statusSection: {
    paddingHorizontal: spacing[6],
    paddingVertical: spacing[4],
    gap: spacing[2],
  },
  badge: {
    alignSelf: 'flex-start',
    paddingHorizontal: spacing[3],
    paddingVertical: spacing[1],
    borderRadius: 6,
    borderWidth: 1,
  },
  creditBadge: {
    backgroundColor: colors.warning[50],
    borderColor: colors.warning[100],
  },
  creditOwed: {
    color: colors.warning[700],
    fontWeight: '700',
  },
  paidBadge: {
    backgroundColor: colors.success[50],
    borderColor: colors.success[100],
  },
  clientLine: {
    color: palette.textSecondary,
  },
  footer: {
    marginTop: spacing[2],
    borderTopWidth: 1,
    borderTopColor: colors.neutral[200],
    paddingHorizontal: spacing[6],
    paddingTop: spacing[4],
    paddingBottom: spacing[6],
    alignItems: 'center',
    gap: spacing[1],
  },
  merci: {
    color: palette.textSecondary,
  },
  brand: {
    color: palette.primary,
    fontWeight: '700',
    letterSpacing: 0.3,
    textAlign: 'center',
    fontSize: 11,
  },
});
