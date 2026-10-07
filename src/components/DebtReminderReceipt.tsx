import { forwardRef } from 'react';
import { Text, View } from 'react-native';
import { colors, fontFamily } from '@/src/theme';
import type { DebtReceiptContent } from '@/src/utils/debtReceipt';

// Portrait 4:5 (1080×1350 when captured). Laid out in design units on a
// 360×450 sheet and multiplied by width/360, so the preview and the captured
// PNG are the same drawing at different sizes. Always light, like paper: fixed
// `colors.paper` tokens, never the app theme. Black ink only, left-aligned, no
// marks or decoration.
export const RECEIPT_ASPECT = 4 / 5;
export const RECEIPT_EXPORT_WIDTH = 1080;
export const RECEIPT_EXPORT_HEIGHT = 1350;
const DESIGN_W = 360;
const paper = colors.paper;

interface Props {
  content: DebtReceiptContent;
  width: number;
}

export const DebtReminderReceipt = forwardRef<View, Props>(function DebtReminderReceipt({ content, width }, ref) {
  const u = width / DESIGN_W;
  const height = width / RECEIPT_ASPECT;
  // allowFontScaling=false: the user's OS font size must never change what she sends.
  const T = { allowFontScaling: false } as const;
  const size = (n: number, lh = 1.35) => ({ fontSize: n * u, lineHeight: n * lh * u });

  return (
    <View
      ref={ref}
      collapsable={false}
      style={{ width, height, backgroundColor: paper.sheet, overflow: 'hidden', paddingHorizontal: 36 * u }}
    >
      <Text
        {...T}
        numberOfLines={1}
        adjustsFontSizeToFit
        minimumFontScale={0.5}
        style={[{ fontFamily: fontFamily.regular, color: paper.quiet, marginTop: 34 * u }, size(14)]}
      >
        {content.businessName}
      </Text>

      <View style={{ flex: 1, justifyContent: 'center' }}>
        <Text
          {...T}
          numberOfLines={2}
          adjustsFontSizeToFit
          minimumFontScale={0.5}
          style={[{ fontFamily: fontFamily.regular, color: paper.soft }, size(36, 1.2)]}
        >
          {content.greeting}
        </Text>

        <View style={{ marginTop: 18 * u }}>
          {content.context.map((line, i) => (
            <Text key={i} {...T} style={[{ fontFamily: fontFamily.regular, color: paper.quiet }, size(18)]}>{line}</Text>
          ))}
        </View>

        {/* The anchor: the finished string from fmt(), shrinks but never truncates. */}
        <Text
          {...T}
          numberOfLines={1}
          adjustsFontSizeToFit
          minimumFontScale={0.5}
          style={[{ fontFamily: fontFamily.bold, color: paper.ink, marginTop: 22 * u, marginBottom: 24 * u }, size(32, 1.25)]}
        >
          {content.remainingLine}
        </Text>

        <Text {...T} style={[{ fontFamily: fontFamily.regular, color: paper.soft }, size(17)]}>{content.demande}</Text>
        <Text {...T} style={[{ fontFamily: fontFamily.regular, color: paper.soft }, size(17)]}>{content.close}</Text>
      </View>

      <Text
        {...T}
        style={[{ fontFamily: fontFamily.regular, color: paper.quiet, textAlign: 'right', marginBottom: 26 * u }, size(11)]}
      >
        {content.footer}
      </Text>
    </View>
  );
});
