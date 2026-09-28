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

  // Founder-only KPI health traffic light (FounderDashboard). Kept separate
  // from success/warning/danger above rather than reusing their [600]
  // shades — this is a deliberate, scoped exception to the "no red in
  // Patron UI" rule (that rule is about merchant-facing screens; this
  // traffic light is founder-only and the whole point is a real red for a
  // real critical reading), so it must never bleed into a shared token a
  // merchant-facing screen might reach for by habit.
  health: {
    green:  '#22C55E',
    yellow: '#EAB308',
    red:    '#EF4444',
  },

  // Apports ("Capital investi" + its "Détails" screen) design-spec palette —
  // exact WCAG-verified pairs from that spec, kept separate from the shared
  // success/warning/primary/text tokens above rather than overwriting them,
  // the same reasoning as `health` above: this is a scoped, deliberate look
  // for two specific screens, not a rebrand of the app's default palette,
  // and must never bleed into any other screen that reaches for
  // palette.primary/success/warning by habit.
  apports: {
    inkLight: '#1C1C1E', secondaryLight: '#8E8E93', purpleLight: '#6E56CF',
    greenLight: '#1F7A2E', amberLight: '#96690A', destructiveLight: '#FF3B30', screenLight: '#FFFFFF',
    inkDark: '#F2F2F7', secondaryDark: '#9A9AA0', purpleDark: '#8E7CFF',
    greenDark: '#30D158', amberDark: '#F5C044', destructiveDark: '#FF4530', screenDark: '#000000',
  },

  // Recouvrement (Clients list/detail, repayment sheet) — a deliberate,
  // scoped exception to the "no red in Patron UI" rule, the same shape as
  // `health` above: requested explicitly, with exact hex for both modes, for
  // one specific meaning — money a client still owes the merchant. Kept
  // separate from the shared danger/success/warning tokens so this doesn't
  // bleed into any other screen's "error" or "destructive" red by habit.
  recouvrement: {
    owedLight: '#B3261E', owedDark: '#FF8A80',
    paidLight: '#1B7A3D', paidDark: '#7BD88F',
    pendingLight: '#B26A00', pendingDark: '#FFB74D',
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

  // Reserved for CTA fills, the active/selected state of nav/segmented
  // controls, and real brand moments (e.g. the Alpha entry point) — not a
  // generic tint for prices/links/icons. Used that way it stops signaling
  // anything; reach for textPrimary/textSecondary by default and only use
  // primary where it's actually interactive or actually the brand.
  primary:        colors.primary[600],
  primaryLight:   colors.primary[50],
  primaryDark:    colors.primary[700],

  success:        colors.success[600],
  successLight:   colors.success[50],
  warning:        colors.warning[600],
  warningLight:   colors.warning[50],
  danger:         colors.danger[600],
  dangerLight:    colors.danger[50],

  healthGreen:    colors.health.green,
  healthYellow:   colors.health.yellow,
  healthRed:      colors.health.red,

  // "Capital investi" + "Détails" only — see colors.apports above.
  apportsInk:         colors.apports.inkLight,
  apportsSecondary:   colors.apports.secondaryLight,
  apportsPurple:      colors.apports.purpleLight,
  apportsGreen:       colors.apports.greenLight,
  apportsAmber:       colors.apports.amberLight,
  apportsDestructive: colors.apports.destructiveLight,
  apportsScreen:      colors.apports.screenLight,

  // Clients/Recouvrement only — see colors.recouvrement above.
  recouvrementOwed:    colors.recouvrement.owedLight,
  recouvrementPaid:    colors.recouvrement.paidLight,
  recouvrementPending: colors.recouvrement.pendingLight,

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

  // Same literal hex as light mode, deliberately — a traffic-light color
  // has to mean the same thing regardless of theme, unlike the softer
  // success/warning/danger tones above that get dark-mode-adjusted for
  // surface contrast.
  healthGreen:    colors.health.green,
  healthYellow:   colors.health.yellow,
  healthRed:      colors.health.red,

  apportsInk:         colors.apports.inkDark,
  apportsSecondary:   colors.apports.secondaryDark,
  apportsPurple:      colors.apports.purpleDark,
  apportsGreen:       colors.apports.greenDark,
  apportsAmber:       colors.apports.amberDark,
  apportsDestructive: colors.apports.destructiveDark,
  apportsScreen:      colors.apports.screenDark,

  recouvrementOwed:    colors.recouvrement.owedDark,
  recouvrementPaid:    colors.recouvrement.paidDark,
  recouvrementPending: colors.recouvrement.pendingDark,

  tabBar:         '#1A1D27',
  tabBarBorder:   'rgba(255,255,255,0.08)',
  tabBarActive:   '#818CF8',
  tabBarInactive: '#64748B',
} as const;

export type Palette = { readonly [K in keyof typeof paletteLight]: string };

// Keep static export for legacy imports — always resolves to light; screens use useTheme() for dynamic palette
export const palette = paletteLight;

// Business drawer avatar palette — calm bg/letter pairs (a light tint +
// a darker letter from the same hue), not a full-saturation fill with white
// text. Each business keeps one pair everywhere it appears, same
// deterministic-by-id assignment as before, just quieter. Deliberately 7
// hues, not 8: red is excluded (this app's standing no-red-in-merchant-UI
// rule — see CLAUDE.md), and teal was dropped rather than given its own
// pair because it reads too close to cyan to stay distinct at this size.
export const BUSINESS_AVATAR_PALETTE = [
  { bg: colors.primary[50],  text: colors.primary[700] },   // indigo
  { bg: colors.violet[50],   text: colors.violet[700] },    // violet
  { bg: colors.fuchsia[50],  text: colors.fuchsia[700] },   // fuchsia
  { bg: colors.warning[50],  text: colors.warning[700] },   // amber
  { bg: colors.emerald[50],  text: colors.emerald[900] },   // emerald
  { bg: colors.blue[50],     text: colors.blue[700] },      // blue
  { bg: colors.cyan[50],     text: colors.cyan[700] },      // cyan
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
