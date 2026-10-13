import React from 'react';
import { StyleSheet, useWindowDimensions, type TextStyle, type StyleProp } from 'react-native';
import { Text, type TextVariant } from './Text';
import { typography } from '@/src/theme/typography';
import { amountText, childrenToText, moneyTextProps, type AmountTextOptions, type MoneyFit } from '@/src/utils/moneyText';

type TextColor = 'primary' | 'secondary' | 'disabled' | 'inverse' | 'success' | 'warning' | 'danger' | 'brand';

interface MoneyTextBase {
  variant?: TextVariant;
  color?: TextColor;
  style?: StyleProp<TextStyle>;
  /** Width this figure may use: 'full' (hero) | 'half' (beside a label, default for small text) | dp. */
  fit?: MoneyFit;
  testID?: string;
  accessibilityLabel?: string;
}

/**
 * THE way text containing money is rendered. It owns what a raw <Text> kept getting wrong: one line, never an
 * ellipsis, tabular figures (via Text), and a size chosen by the pure fitMoney() — sized from the text and the
 * screen, with a readable floor — instead of the native adjustsFontSizeToFit (unverifiable, and the suspect in
 * the microscopic "1226000GNF" Accueil debt card). A missing variant throws in dev (Text).
 * Children must be text; build the string with formatAmount()/<Money> pieces.
 */
export function MoneyText({ variant = 'body', color, style, fit, children, ...rest }: MoneyTextBase & { children?: React.ReactNode }) {
  const { width } = useWindowDimensions();
  const flat = StyleSheet.flatten(style) as TextStyle | undefined;
  const base = typography[variant];
  const baseFontSize = (flat?.fontSize as number | undefined) ?? base.fontSize;
  const baseLineHeight = (flat?.lineHeight as number | undefined) ?? (flat?.fontSize ? Math.round(flat.fontSize * 1.25) : base.lineHeight);
  const p = moneyTextProps({ text: childrenToText(children), baseFontSize, baseLineHeight, windowWidth: width, fit });
  return (
    <Text
      variant={variant}
      color={color}
      numberOfLines={1}
      ellipsizeMode="clip"
      style={[style, { fontSize: p.fontSize, lineHeight: p.lineHeight }]}
      {...rest}
    >
      {p.text}
    </Text>
  );
}

/** A single amount: formatted, grouped, sized to fit. `amount` is in display units (not cents). */
export function Money({ amount, currency, signed, valueOnly, masked, prefix, suffix, ...rest }: MoneyTextBase & AmountTextOptions & { amount: number; currency: string }) {
  return <MoneyText {...rest}>{amountText(amount, currency, { signed, valueOnly, masked, prefix, suffix })}</MoneyText>;
}
