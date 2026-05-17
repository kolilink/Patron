export const colors = {
  // Primary — indigo, trustworthy + modern
  primary: {
    50: '#EEF2FF',
    100: '#E0E7FF',
    200: '#C7D2FE',
    300: '#A5B4FC',
    400: '#818CF8',
    500: '#6366F1',
    600: '#4F46E5',
    700: '#4338CA',
    800: '#3730A3',
    900: '#312E81',
  },

  // Success — green
  success: {
    50: '#F0FDF4',
    100: '#DCFCE7',
    500: '#22C55E',
    600: '#16A34A',
    700: '#15803D',
  },

  // Warning — amber
  warning: {
    50: '#FFFBEB',
    100: '#FEF3C7',
    500: '#F59E0B',
    600: '#D97706',
    700: '#B45309',
  },

  // Danger — red
  danger: {
    50: '#FFF1F2',
    100: '#FFE4E6',
    500: '#EF4444',
    600: '#DC2626',
    700: '#B91C1C',
  },

  // Neutrals
  neutral: {
    0: '#FFFFFF',
    50: '#F8FAFC',
    100: '#F1F5F9',
    200: '#E2E8F0',
    300: '#CBD5E1',
    400: '#94A3B8',
    500: '#64748B',
    600: '#475569',
    700: '#334155',
    800: '#1E293B',
    900: '#0F172A',
  },

  // Role colors
  role: {
    administrateur: '#4F46E5',
    manager: '#0891B2',
    vendeur: '#16A34A',
    investisseur: '#D97706',
  },

  // Transparent
  transparent: 'transparent',
} as const;

export const palette = {
  background: colors.neutral[50],
  surface: colors.neutral[0],
  surfaceElevated: colors.neutral[0],
  border: colors.neutral[200],
  borderStrong: colors.neutral[300],

  textPrimary: colors.neutral[900],
  textSecondary: colors.neutral[500],
  textDisabled: colors.neutral[300],
  textInverse: colors.neutral[0],

  primary: colors.primary[600],
  primaryLight: colors.primary[50],
  primaryDark: colors.primary[700],

  success: colors.success[600],
  successLight: colors.success[50],
  warning: colors.warning[600],
  warningLight: colors.warning[50],
  danger: colors.danger[600],
  dangerLight: colors.danger[50],

  tabBar: colors.neutral[0],
  tabBarBorder: colors.neutral[200],
  tabBarActive: colors.primary[600],
  tabBarInactive: colors.neutral[400],
} as const;
