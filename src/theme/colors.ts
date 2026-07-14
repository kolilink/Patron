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
    50:  '#FFFBEB',
    100: '#FEF3C7',
    500: '#F59E0B',
    600: '#D97706',
    700: '#B45309',
    800: '#92400E',
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
    // Dark-mode variants (lighter for contrast on dark surfaces)
    administrateurDark: '#818CF8',
    managerDark: '#38BDF8',
    vendeurDark: '#4ADE80',
    investisseurDark: '#FCD34D',
  },

  // Sky blue (avatar palette)
  sky: {
    500: '#0EA5E9',
  },

  // Teal
  teal: {
    500: '#14B8A6',
  },

  // Extended accent colors for avatar palettes and category badges
  fuchsia: {
    50:  '#FDF4FF',
    700: '#86198F',
  },
  emerald: {
    50:  '#ECFDF5',
    500: '#10B981',
    900: '#065F46',
  },
  blue: {
    50:  '#EFF6FF',
    500: '#3B82F6',
    700: '#1D4ED8',
  },
  violet: {
    50:  '#F5F3FF',
    500: '#8B5CF6',
    700: '#6D28D9',
  },
  cyan: {
    50:  '#ECFEFF',
    500: '#06B6D4',
    700: '#0E7490',
  },
  pink: {
    400: '#EC4899',
  },

  // Transparent
  transparent: 'transparent',
} as const;

export const paletteLight = {
  background:     colors.neutral[50],
  surface:        colors.neutral[0],
  surfaceElevated:colors.neutral[0],
  border:         colors.neutral[200],
  borderStrong:   colors.neutral[300],
  shadow:         '#000',

  textPrimary:    colors.neutral[900],
  textSecondary:  colors.neutral[500],
  textDisabled:   colors.neutral[300],
  textInverse:    colors.neutral[0],

  primary:        colors.primary[600],
  primaryLight:   colors.primary[50],
  primaryDark:    colors.primary[700],

  success:        colors.success[600],
  successLight:   colors.success[50],
  warning:        colors.warning[600],
  warningLight:   colors.warning[50],
  danger:         colors.danger[600],
  dangerLight:    colors.danger[50],

  tabBar:         colors.neutral[0],
  tabBarBorder:   colors.neutral[200],
  tabBarActive:   colors.primary[600],
  tabBarInactive: colors.neutral[400],
} as const;

export const paletteDark = {
  background:     '#0F1117',
  surface:        '#1A1D27',
  surfaceElevated:'#242736',
  border:         'rgba(255,255,255,0.08)',
  borderStrong:   'rgba(255,255,255,0.15)',
  shadow:         '#000',

  textPrimary:    '#F1F5F9',
  textSecondary:  '#94A3B8',
  textDisabled:   '#475569',
  textInverse:    '#0F1117',

  primary:        '#818CF8',
  primaryLight:   'rgba(129,140,248,0.14)',
  primaryDark:    '#6366F1',

  success:        '#4ADE80',
  successLight:   'rgba(74,222,128,0.14)',
  warning:        '#FCD34D',
  warningLight:   'rgba(252,211,77,0.14)',
  danger:         '#F87171',
  dangerLight:    'rgba(248,113,113,0.14)',

  tabBar:         '#1A1D27',
  tabBarBorder:   'rgba(255,255,255,0.08)',
  tabBarActive:   '#818CF8',
  tabBarInactive: '#64748B',
} as const;

export type Palette = { readonly [K in keyof typeof paletteLight]: string };

// Keep static export for legacy imports — always resolves to light; screens use useTheme() for dynamic palette
export const palette = paletteLight;

// Business drawer avatar palette (8 colors for business-picker circles)
export const BUSINESS_AVATAR_PALETTE = [
  colors.primary[500],  // indigo
  colors.violet[500],   // violet
  colors.pink[400],     // pink
  colors.warning[500],  // amber
  colors.emerald[500],  // emerald
  colors.blue[500],     // blue
  colors.danger[500],   // red
  colors.teal[500],     // teal
] as const;

// Client list avatar palette (pastel bg tints)
export const CLIENT_AVATAR_PALETTE = [
  '#DAFCE3',              // mint pastel
  '#FDF0DA',              // warm amber pastel
  colors.primary[100],    // indigo tint
  colors.warning[100],    // amber tint
] as const;

// Product category badge palette — bg/text pairs for deterministic badge coloring
export const PRODUCT_BADGE_PALETTE = {
  bg:   ['#D1FAE5', '#EDE9FE', '#DBEAFE', colors.warning[100], colors.danger[100], '#CCFBF1'],
  text: ['#065F46', '#4C1D95', '#1E40AF', '#78350F',           '#9F1239',           '#134E4A'],
} as const;

// Role badge colors — keyed by role string for deterministic role display
export const ROLE_COLORS: Record<string, string> = {
  administrateur: colors.role.administrateur,
  manager:        colors.role.manager,
  vendeur:        colors.role.vendeur,
  investisseur:   colors.role.investisseur,
};
export const ROLE_COLORS_DARK: Record<string, string> = {
  administrateur: colors.role.administrateurDark,
  manager:        colors.role.managerDark,
  vendeur:        colors.role.vendeurDark,
  investisseur:   colors.role.investisseurDark,
};

// Info tag palette — bg/text pair for linked-product "info" indicators
export const INFO_TAG = { bg: colors.blue[50], text: colors.blue[700] } as const;

// Supplier avatar palette — bg/text pairs for deterministic fournisseur initials
export const SUPPLIER_AVATAR_PALETTE = [
  { bg: colors.primary[50],   text: colors.primary[600] },
  { bg: colors.fuchsia[50],   text: colors.fuchsia[700] },
  { bg: colors.warning[50],   text: colors.warning[800] },
  { bg: colors.emerald[50],   text: colors.emerald[900] },
  { bg: colors.blue[50],      text: colors.blue[700] },
  { bg: colors.violet[50],    text: colors.violet[700] },
  { bg: colors.danger[50],    text: colors.danger[700] },
  { bg: colors.cyan[50],      text: colors.cyan[700] },
] as const;

// Shared avatar color palette — deterministic color assignment by name
export const AVATAR_PALETTE = [
  colors.primary[500],   // indigo
  colors.sky[500],       // sky
  colors.emerald[500],   // emerald
  colors.warning[500],   // amber
  colors.violet[500],    // violet
  colors.pink[400],      // pink
] as const;
