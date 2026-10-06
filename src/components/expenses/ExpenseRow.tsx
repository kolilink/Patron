import { memo, useMemo } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import Animated, { SlideInUp } from 'react-native-reanimated';
import ReanimatedSwipeable from 'react-native-gesture-handler/ReanimatedSwipeable';
import { Text } from '@/src/components/ui/Text';
import { AnimatedRow } from '@/src/components/ui/AnimatedRow';
import { useTheme, spacing, radius } from '@/src/theme';
import type { Palette } from '@/src/theme';
import { useReduceMotion } from '@/src/hooks/useReduceMotion';
import { formatAmount } from '@/src/utils/format';
import type { Expense } from '@/src/types';

const GENERIC = 'Dépense';

/** Secondary line: product first, then the note; legacy rows fall back to their description. */
export function expenseSubtitle(e: Expense): string {
  const note = (e.note ?? '').trim();
  const legacy = !note && e.description && e.description !== GENERIC && e.description !== e.product_name ? e.description : '';
  return [e.product_name, note || legacy].filter(Boolean).join(' · ');
}

interface Props {
  expense: Expense;
  currency: string;
  canModify: boolean;
  isNew: boolean;
  onPress: () => void;
  onDelete: () => void;
}

// Amount is the primary line (neutral, tabular); product/note secondary; a small
// dot when a receipt photo exists. Swipe left deletes (soft, undoable).
export const ExpenseRow = memo(function ExpenseRow({ expense, currency, canModify, isNew, onPress, onDelete }: Props) {
  const { palette } = useTheme();
  const styles = useMemo(() => makeStyles(palette), [palette]);
  const reduce = useReduceMotion();
  const subtitle = expenseSubtitle(expense);
  const rejected = expense.status === 'rejete';

  const body = (
    <Pressable onPress={onPress} style={styles.row} accessibilityRole="button">
      <View style={{ flex: 1, gap: 2 }}>
        <Text variant="label" style={[styles.amount, rejected && { color: palette.textSecondary }]}>
          {formatAmount(expense.amount, currency)}
        </Text>
        {subtitle ? <Text variant="caption" color="secondary" numberOfLines={1}>{subtitle}</Text> : null}
        {rejected ? <Text variant="caption" style={{ color: palette.textSecondary, fontWeight: '600' }}>Refusée</Text> : null}
        {expense.status === 'en_attente' ? <Text variant="caption" color="secondary">En attente</Text> : null}
      </View>
      {expense.proof_image_url ? <View style={styles.dot} accessibilityLabel="Photo du reçu" /> : null}
    </Pressable>
  );

  const wrapped = canModify ? (
    <ReanimatedSwipeable
      friction={2}
      overshootRight={false}
      rightThreshold={72}
      onSwipeableOpen={() => onDelete()}
      renderRightActions={() => (
        <View style={styles.action}>
          <Text variant="label" style={{ color: palette.textInverse }}>Supprimer</Text>
        </View>
      )}
    >
      {body}
    </ReanimatedSwipeable>
  ) : body;

  return (
    <AnimatedRow id={expense.id}>
      {isNew && !reduce ? <Animated.View entering={SlideInUp.duration(240)}>{wrapped}</Animated.View> : wrapped}
    </AnimatedRow>
  );
});

function makeStyles(p: Palette) {
  return StyleSheet.create({
    row: {
      flexDirection: 'row', alignItems: 'center', gap: spacing[3],
      paddingVertical: spacing[3], paddingHorizontal: spacing[4],
      backgroundColor: p.surface, borderRadius: radius.md,
    },
    amount: { color: p.textPrimary, fontVariant: ['tabular-nums'], fontSize: 17 },
    dot: { width: 8, height: 8, borderRadius: 4, backgroundColor: p.textSecondary },
    action: {
      justifyContent: 'center', alignItems: 'center', width: 104,
      backgroundColor: p.warning, borderRadius: radius.md, marginLeft: spacing[2],
    },
  });
}
