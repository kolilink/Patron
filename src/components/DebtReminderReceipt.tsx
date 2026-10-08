import { forwardRef } from 'react';
import type { ReactNode, Ref } from 'react';
import { Text, View } from 'react-native';
import { colors, fontFamily } from '@/src/theme';
import type { DebtReceiptContent } from '@/src/utils/debtReceipt';
import { RECEIPT_ASPECT } from '@/src/utils/debtReceipt';
import { linedBodyScale } from '@/src/utils/saleReceipt';

// Portrait 4:5 (1080×1350 when captured). Laid out in design units on a
// 360×450 sheet and multiplied by width/360, so the preview and the captured
// PNG are the same drawing at different sizes. Always light, like paper: fixed
// `colors.paper` tokens, never the app theme. Black ink only, left-aligned, no
// marks or decoration.
export { RECEIPT_ASPECT, RECEIPT_EXPORT_WIDTH, RECEIPT_EXPORT_HEIGHT } from '@/src/utils/debtReceipt';
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

  if (content.variant) return renderSale(ref, content, width, height, u, T, size);

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

type SizeFn = (n: number, lh?: number) => { fontSize: number; lineHeight: number };
const TABULAR = { fontVariant: ['tabular-nums' as const] };

// Sale receipts (variants A lined / B quick / C credit). Same sheet, same ink,
// same footer as the reminder above — only the body differs. The view never
// formats: every amount arrives as a finished string.
function renderSale(
  ref: Ref<View>,
  c: DebtReceiptContent,
  width: number,
  height: number,
  u: number,
  T: { allowFontScaling: false },
  size: SizeFn,
) {
  const shrink = { numberOfLines: 1, adjustsFontSizeToFit: true, minimumFontScale: 0.5 } as const;
  const reg = { fontFamily: fontFamily.regular };

  const header = (
    <Text {...T} {...shrink} style={[{ ...reg, color: paper.quiet, marginTop: 34 * u }, size(14)]}>
      {c.businessName}
    </Text>
  );
  const footer = (
    <Text {...T} style={[{ ...reg, color: paper.quiet, textAlign: 'right', marginBottom: 26 * u }, size(11)]}>
      {c.footer}
    </Text>
  );
  const frame = (body: ReactNode) => (
    <View
      ref={ref}
      collapsable={false}
      style={{ width, height, backgroundColor: paper.sheet, overflow: 'hidden', paddingHorizontal: 36 * u }}
    >
      {header}
      {body}
      {footer}
    </View>
  );

  const paidLine = c.payment?.kind === 'paid'
    ? `Payé ✓${c.payment.methodLabel ? ` · ${c.payment.methodLabel}` : ''}`
    : null;

  // ── B: quick sale ──
  if (c.variant === 'quick') {
    return frame(
      <View style={{ flex: 1, justifyContent: 'center' }}>
        <Text {...T} style={[{ ...reg, color: paper.quiet }, size(18)]}>{c.contextLine}</Text>
        {c.label ? (
          <Text {...T} {...shrink} style={[{ ...reg, color: paper.soft, marginTop: 6 * u }, size(20)]}>{c.label}</Text>
        ) : null}
        <Text {...T} {...shrink} style={[{ fontFamily: fontFamily.bold, color: paper.ink, marginTop: 22 * u, marginBottom: 24 * u }, size(32, 1.25)]}>
          {c.hero}
        </Text>
        {paidLine ? <Text {...T} style={[{ ...reg, color: paper.soft }, size(17)]}>{paidLine}</Text> : null}
        <Text {...T} style={[{ ...reg, color: paper.soft, marginTop: 8 * u }, size(17)]}>{c.close}</Text>
      </View>,
    );
  }

  // ── C: credit ──
  if (c.variant === 'credit') {
    return frame(
      <View style={{ flex: 1, justifyContent: 'center' }}>
        <Text {...T} numberOfLines={2} adjustsFontSizeToFit minimumFontScale={0.5} style={[{ ...reg, color: paper.soft }, size(36, 1.2)]}>
          {c.greeting}
        </Text>
        <Text {...T} style={[{ ...reg, color: paper.quiet, marginTop: 18 * u }, size(18)]}>{c.contextLine}</Text>
        <Text {...T} {...shrink} style={[{ fontFamily: fontFamily.bold, color: paper.ink, marginTop: 22 * u, marginBottom: 24 * u }, size(32, 1.25)]}>
          {c.hero}
        </Text>
        <Text {...T} style={[{ ...reg, color: paper.soft }, size(17)]}>{c.close}</Text>
      </View>,
    );
  }

  // ── A: lined ──  Laid out at a uniform scale so a long / discounted /
  // credit sale still fits the 4:5 card.
  const k = u * linedBodyScale(c);
  const sz = (n: number, lh = 1.35) => ({ fontSize: n * k, lineHeight: n * lh * k });
  const row = { flexDirection: 'row' as const, alignItems: 'baseline' as const, justifyContent: 'space-between' as const };
  const t = c.totals;
  const pay = c.payment;
  return frame(
    <View style={{ flex: 1 }}>
      <Text {...T} style={[{ ...reg, color: paper.quiet, marginTop: 10 * k }, sz(15)]}>{c.contextLine}</Text>

      {c.lines && c.lines.length > 0 ? (
        <View style={{ marginTop: 20 * k }}>
          {c.lines.map((l, i) => (
            <View key={i} style={[row, { marginBottom: 10 * k }]}>
              <Text {...T} {...shrink} style={[{ ...reg, color: paper.soft, flex: 1, marginRight: 12 * k }, sz(17)]}>
                {`${l.name} × ${l.qty}`}
              </Text>
              <Text {...T} {...shrink} style={[{ ...reg, ...TABULAR, color: paper.soft }, sz(17)]}>{l.lineTotal}</Text>
            </View>
          ))}
          {c.moreLines ? (
            <Text {...T} style={[{ ...reg, color: paper.quiet, marginBottom: 10 * k }, sz(17)]}>{c.moreLines}</Text>
          ) : null}
          <View style={{ height: 1, backgroundColor: paper.quiet, opacity: 0.25, marginVertical: 16 * k }} />
        </View>
      ) : null}

      {t ? (
        <View style={{ alignItems: 'flex-end' }}>
          {t.discount ? (
            <>
              <Text {...T} style={[{ ...reg, ...TABULAR, color: paper.soft, marginBottom: 6 * k }, sz(17)]}>{`Sous-total ${t.subtotal}`}</Text>
              <Text {...T} style={[{ ...reg, ...TABULAR, color: paper.soft, marginBottom: 6 * k }, sz(17)]}>{`Réduction ${t.discount}`}</Text>
            </>
          ) : null}
          <Text {...T} {...shrink} style={[{ fontFamily: fontFamily.bold, ...TABULAR, color: paper.ink, marginTop: 8 * k }, sz(20)]}>
            {`Net à payer ${t.net}`}
          </Text>
        </View>
      ) : null}

      {pay ? (
        <View style={{ marginTop: 20 * k }}>
          {pay.kind === 'paid' ? (
            <Text {...T} {...shrink} style={[{ fontFamily: fontFamily.semibold, color: paper.ink }, sz(20)]}>{paidLine}</Text>
          ) : (
            <>
              <Text {...T} style={[{ fontFamily: fontFamily.semibold, color: paper.ink }, sz(20)]}>Crédit</Text>
              {pay.received ? (
                <Text {...T} {...shrink} style={[{ ...reg, ...TABULAR, color: paper.quiet }, sz(17)]}>{`Reçu : ${pay.received}`}</Text>
              ) : null}
              <Text {...T} {...shrink} style={[{ fontFamily: fontFamily.bold, ...TABULAR, color: paper.ink }, sz(24, 1.3)]}>{`Reste : ${pay.remaining}`}</Text>
              {c.clientName ? (
                <Text {...T} {...shrink} style={[{ ...reg, color: paper.soft }, sz(17)]}>{`Pour ${c.clientName}`}</Text>
              ) : null}
            </>
          )}
        </View>
      ) : null}

      <Text {...T} style={[{ ...reg, color: paper.soft, marginTop: 16 * k }, sz(17)]}>{c.close}</Text>
    </View>,
  );
}
