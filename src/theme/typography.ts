// DM Sans weight map — weight is encoded in the font file name, not fontWeight prop
export const FF = {
  regular:  'DMSans_400Regular',
  medium:   'DMSans_500Medium',
  semibold: 'DMSans_600SemiBold',
  bold:     'DMSans_700Bold',
} as const;

// Keep legacy export name so existing `import { fontFamily }` doesn't break
export const fontFamily = FF;

export const typography = {
  // Display — tight, confident, dominant
  display: {
    fontFamily: FF.bold,
    fontSize: 34,
    lineHeight: 42,
    letterSpacing: -1.0,
  },

  // Headings — each level gets slightly more air as size decreases
  h1: { fontFamily: FF.bold,     fontSize: 28, lineHeight: 36, letterSpacing: -0.6 },
  h2: { fontFamily: FF.bold,     fontSize: 24, lineHeight: 32, letterSpacing: -0.4 },
  h3: { fontFamily: FF.semibold, fontSize: 20, lineHeight: 28, letterSpacing: -0.2 },
  h4: { fontFamily: FF.semibold, fontSize: 18, lineHeight: 26, letterSpacing: -0.1 },

  // Body — generous leading, DM Sans has a taller x-height than Inter
  bodyLarge: { fontFamily: FF.regular, fontSize: 17, lineHeight: 28 },
  body:      { fontFamily: FF.regular, fontSize: 15, lineHeight: 24 },
  bodySmall: { fontFamily: FF.regular, fontSize: 13, lineHeight: 21 },

  // Labels — semibold, optically open
  labelLarge: { fontFamily: FF.semibold, fontSize: 15, lineHeight: 22, letterSpacing: 0.1 },
  label:      { fontFamily: FF.semibold, fontSize: 13, lineHeight: 20, letterSpacing: 0.1 },
  labelSmall: { fontFamily: FF.semibold, fontSize: 11, lineHeight: 16, letterSpacing: 0.25 },

  // Special
  mono:     { fontFamily: FF.medium,   fontSize: 13, lineHeight: 20, fontVariant: ['tabular-nums'] as ['tabular-nums'] },
  caption:  { fontFamily: FF.regular,  fontSize: 12, lineHeight: 18, letterSpacing: 0.1 },
  overline: { fontFamily: FF.semibold, fontSize: 11, lineHeight: 16, letterSpacing: 1.0, textTransform: 'uppercase' as const },

  // Currency/amounts — the merchant looks here most. Tabular, unambiguous.
  amount:      { fontFamily: FF.bold, fontSize: 17, lineHeight: 24, fontVariant: ['tabular-nums'] as ['tabular-nums'] },
  amountLarge: { fontFamily: FF.bold, fontSize: 32, lineHeight: 40, letterSpacing: -0.5, fontVariant: ['tabular-nums'] as ['tabular-nums'] },
  amountSmall: { fontFamily: FF.semibold, fontSize: 14, lineHeight: 20, fontVariant: ['tabular-nums'] as ['tabular-nums'] },
} as const;
