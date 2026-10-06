import { forwardRef } from 'react';
import { Platform, StyleSheet, Text, View } from 'react-native';
import { colors, fontFamily } from '@/src/theme';
import { fitScale, GREETING_FIT_CHARS, REMAINING_FIT_CHARS, type DebtReceiptContent } from '@/src/utils/debtReceipt';

// Portrait 4:5 (1080×1350 when captured). Everything is laid out in design
// units on a 360×450 sheet and multiplied by width/360, so the on-screen
// preview and the captured PNG are the same drawing at different sizes.
// Always light, like paper: it reads the fixed `colors.paper` tokens, never
// the app theme — a receipt has no dark mode.
export const RECEIPT_ASPECT = 4 / 5;
export const RECEIPT_EXPORT_WIDTH = 1080;
export const RECEIPT_EXPORT_HEIGHT = 1350;
const DESIGN_W = 360;
const RULE_COUNT = 26;

const SERIF = Platform.select({ ios: 'Georgia', default: 'serif' });
const paper = colors.paper;

interface Props {
  content: DebtReceiptContent;
  width: number;
}

export const DebtReminderReceipt = forwardRef<View, Props>(function DebtReminderReceipt({ content, width }, ref) {
  const u = width / DESIGN_W;
  const height = width / RECEIPT_ASPECT;
  const t = (size: number, extra: object = {}) => ({
    fontSize: size * u,
    lineHeight: size * 1.4 * u,
    ...extra,
  });
  // allowFontScaling=false everywhere: the user's OS font size must never
  // change what she sends.
  const T = { allowFontScaling: false } as const;

  return (
    <View
      ref={ref}
      collapsable={false}
      style={{ width, height, backgroundColor: paper.sheet, overflow: 'hidden' }}
    >
      {/* Faint ruled-paper lines */}
      {Array.from({ length: RULE_COUNT }, (_, i) => (
        <View
          key={i}
          style={{
            position: 'absolute', left: 0, right: 0,
            top: (i + 1) * (height / (RULE_COUNT + 1)),
            height: StyleSheet.hairlineWidth, backgroundColor: paper.rule,
          }}
        />
      ))}

      <Text
        {...T}
        numberOfLines={1}
        adjustsFontSizeToFit
        minimumFontScale={0.4}
        style={[styles.header, t(16), { color: paper.accent, marginTop: 34 * u, marginHorizontal: 40 * u }]}
      >
        {`·  ${content.businessName}  ·`}
      </Text>

      <View style={{ flex: 1, paddingHorizontal: 35 * u, justifyContent: 'center', paddingBottom: 16 * u }}>
        <Text
          {...T}
          numberOfLines={2}
          adjustsFontSizeToFit
          minimumFontScale={0.35}
          style={[{ fontFamily: SERIF, color: paper.ink }, t(36 * fitScale(content.greeting, GREETING_FIT_CHARS, true), { lineHeight: 44 * u })]}
        >
          {content.greeting}
        </Text>
        {/* Hairline spanning the full content width, as in the approved mockup. */}
        <View style={{ height: 0.75 * u, backgroundColor: paper.accent, marginVertical: 14 * u }} />

        <Text {...T} style={[styles.sans, t(13.5), { color: paper.soft }]}>{content.context}</Text>

        <View style={{ marginTop: 14 * u }}>
          {content.articleLines.map((line, i) => (
            <Text key={i} {...T} numberOfLines={2} style={[styles.sans, t(14), { color: paper.ink }]}>{line}</Text>
          ))}
          {content.lastPaymentLine ? (
            <Text {...T} style={[styles.sans, t(14), { color: paper.ink }]}>{content.lastPaymentLine}</Text>
          ) : null}
        </View>

        {/* The anchor: exact full amount, calm neutral ink, shrinks but never truncates. */}
        <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 16 * u, marginBottom: 14 * u }}>
          <View style={{ width: 3 * u, alignSelf: 'stretch', backgroundColor: paper.accent, marginRight: 8 * u }} />
          <Text
            {...T}
            numberOfLines={1}
            adjustsFontSizeToFit
            minimumFontScale={0.2}
            style={[{ flex: 1, fontFamily: SERIF, color: paper.ink }, t(36 * fitScale(content.remainingLine, REMAINING_FIT_CHARS), { lineHeight: 46 * u })]}
          >
            {content.remainingLine}
          </Text>
        </View>

        {content.demande.map((line, i) => (
          <Text key={i} {...T} style={[styles.sans, t(14), { color: paper.ink }]}>{line}</Text>
        ))}
        <Text {...T} style={[styles.sans, t(14), { color: paper.ink }]}>{content.trust}</Text>
        <Text {...T} style={[styles.sans, t(14), { color: paper.ink }]}>{content.close}</Text>
      </View>

      <Text {...T} style={[styles.sans, t(11), { color: paper.quiet, textAlign: 'center', marginBottom: 22 * u }]}>
        {content.footer}
      </Text>
    </View>
  );
});

const styles = StyleSheet.create({
  header: { fontFamily: SERIF, textAlign: 'center' },
  sans: { fontFamily: fontFamily.regular },
});
