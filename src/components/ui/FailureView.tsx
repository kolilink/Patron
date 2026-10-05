import React, { useMemo } from 'react';
import { Alert, StyleSheet, View } from 'react-native';
import { useTheme, spacing, radius } from '@/src/theme';
import type { Palette } from '@/src/theme';
import { Text } from './Text';
import { Button } from './Button';
import { buildFailure, failureReason, type FailureShape } from '@/src/utils/failure';
import { FAILURE_COPY, type FailureKey } from '@/src/utils/failureCopy';

/**
 * The one failure surface. Inline and persistent (never an auto-dismissing
 * toast: in sunlight, 3 seconds is not enough to read it), static text (no
 * animation on an error), exactly one action. No red — warning tokens only.
 */
export function FailureView({ failure, busy }: { failure: FailureShape; busy?: boolean }) {
  const { palette } = useTheme();
  const styles = useMemo(() => makeStyles(palette), [palette]);
  return (
    <View style={styles.box} accessibilityRole="alert">
      <Text variant="label" style={{ color: palette.textPrimary }}>{failure.what}</Text>
      {failure.why ? <Text variant="caption" color="secondary">{failure.why}</Text> : null}
      <Button
        label={failure.action.label}
        loadingLabel="Envoi"
        loading={busy}
        onPress={failure.action.onPress}
        variant="outline"
        size="md"
        fullWidth
      />
      {failure.supportDetail ? (
        <Text variant="caption" style={{ color: palette.textDisabled }}>Réf. support : {failure.supportDetail}</Text>
      ) : null}
    </View>
  );
}

/**
 * Same shape, as a system alert — for moments with no room for an inline view
 * (a handler that already closed its sheet). Title = what, message = why, a
 * single button = the one action.
 */
export function showFailureAlert(failure: FailureShape): void {
  Alert.alert(failure.what, failure.why, [{ text: failure.action.label, onPress: failure.action.onPress }]);
}

/**
 * Shorthand for the common case: a registered failure sentence, an optional
 * reason (from the error, or an explicit one), one action (default "Retour").
 */
export function failAlert(
  key: FailureKey,
  opts: { err?: unknown; why?: string; label?: string; onPress?: () => void } = {},
): void {
  const copy = FAILURE_COPY[key] as { what: string; why?: string };
  showFailureAlert(buildFailure({
    what: copy.what,
    why: opts.why ?? (opts.err !== undefined ? failureReason(opts.err) : undefined) ?? copy.why,
    action: { label: opts.label ?? 'Retour', onPress: opts.onPress ?? (() => {}) },
  }));
}

function makeStyles(p: Palette) {
  return StyleSheet.create({
    box: {
      backgroundColor: p.warningLight, borderRadius: radius.md, padding: spacing[4], gap: spacing[2],
    },
  });
}
