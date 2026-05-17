import { Platform } from 'react-native';

const fontFamily = Platform.select({
  ios: {
    regular: 'System',
    medium: 'System',
    semibold: 'System',
    bold: 'System',
  },
  android: {
    regular: 'Roboto',
    medium: 'Roboto-Medium',
    semibold: 'Roboto-Medium',
    bold: 'Roboto-Bold',
  },
  default: {
    regular: 'System',
    medium: 'System',
    semibold: 'System',
    bold: 'System',
  },
});

export const typography = {
  // Display
  display: {
    fontSize: 32,
    lineHeight: 40,
    fontWeight: '700' as const,
    letterSpacing: -0.5,
  },

  // Headings
  h1: { fontSize: 28, lineHeight: 36, fontWeight: '700' as const, letterSpacing: -0.3 },
  h2: { fontSize: 24, lineHeight: 32, fontWeight: '700' as const, letterSpacing: -0.2 },
  h3: { fontSize: 20, lineHeight: 28, fontWeight: '600' as const },
  h4: { fontSize: 18, lineHeight: 26, fontWeight: '600' as const },

  // Body
  bodyLarge: { fontSize: 17, lineHeight: 26, fontWeight: '400' as const },
  body: { fontSize: 15, lineHeight: 24, fontWeight: '400' as const },
  bodySmall: { fontSize: 13, lineHeight: 20, fontWeight: '400' as const },

  // Labels
  labelLarge: { fontSize: 15, lineHeight: 22, fontWeight: '600' as const, letterSpacing: 0.1 },
  label: { fontSize: 13, lineHeight: 20, fontWeight: '600' as const, letterSpacing: 0.1 },
  labelSmall: { fontSize: 11, lineHeight: 16, fontWeight: '600' as const, letterSpacing: 0.2 },

  // Special
  mono: { fontSize: 13, lineHeight: 20, fontWeight: '400' as const, fontVariant: ['tabular-nums'] as const },
  caption: { fontSize: 12, lineHeight: 18, fontWeight: '400' as const },
  overline: { fontSize: 11, lineHeight: 16, fontWeight: '600' as const, letterSpacing: 0.8, textTransform: 'uppercase' as const },

  // Currency/amounts — always tabular
  amount: { fontSize: 17, lineHeight: 24, fontWeight: '700' as const, fontVariant: ['tabular-nums'] as const },
  amountLarge: { fontSize: 28, lineHeight: 36, fontWeight: '700' as const, fontVariant: ['tabular-nums'] as const },
  amountSmall: { fontSize: 14, lineHeight: 20, fontWeight: '600' as const, fontVariant: ['tabular-nums'] as const },
} as const;

export { fontFamily };
