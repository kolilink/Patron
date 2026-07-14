export interface CurrencyOption {
  code: string;
  flag: string;
  name: string;
  sub: string;
}

export const CURRENCY_LIST: CurrencyOption[] = [
  // West Africa
  { code: 'GNF', flag: '🇬🇳', name: 'Franc Guinéen',       sub: 'Guinée' },
  { code: 'XOF', flag: '🌍',  name: 'Franc CFA (UEMOA)',   sub: "Sénégal · Mali · Côte d'Ivoire…" },
  { code: 'XAF', flag: '🌍',  name: 'Franc CFA (CEMAC)',   sub: 'Cameroun · Congo · Gabon…' },
  { code: 'NGN', flag: '🇳🇬', name: 'Naira',               sub: 'Nigeria' },
  { code: 'GHS', flag: '🇬🇭', name: 'Cedi',                sub: 'Ghana' },
  // North Africa
  { code: 'MAD', flag: '🇲🇦', name: 'Dirham marocain',    sub: 'Maroc' },
  { code: 'DZD', flag: '🇩🇿', name: 'Dinar algérien',     sub: 'Algérie' },
  { code: 'TND', flag: '🇹🇳', name: 'Dinar tunisien',     sub: 'Tunisie' },
  { code: 'EGP', flag: '🇪🇬', name: 'Livre égyptienne',   sub: 'Égypte' },
  // East & Southern Africa
  { code: 'KES', flag: '🇰🇪', name: 'Shilling kényan',    sub: 'Kenya' },
  { code: 'ZAR', flag: '🇿🇦', name: 'Rand',               sub: 'Afrique du Sud' },
  { code: 'ETB', flag: '🇪🇹', name: 'Birr éthiopien',     sub: 'Éthiopie' },
  // Middle East
  { code: 'AED', flag: '🇦🇪', name: 'Dirham (EAU)',       sub: 'Émirats arabes unis' },
  { code: 'SAR', flag: '🇸🇦', name: 'Riyal saoudien',     sub: 'Arabie Saoudite' },
  // International
  { code: 'USD', flag: '🇺🇸', name: 'Dollar américain',   sub: 'États-Unis · diaspora…' },
  { code: 'EUR', flag: '🇪🇺', name: 'Euro',                sub: 'Europe' },
  { code: 'GBP', flag: '🇬🇧', name: 'Livre sterling',     sub: 'Royaume-Uni' },
  { code: 'CNY', flag: '🇨🇳', name: 'Yuan',               sub: 'Chine' },
  { code: 'CAD', flag: '🇨🇦', name: 'Dollar canadien',    sub: 'Canada' },
  { code: 'CHF', flag: '🇨🇭', name: 'Franc suisse',       sub: 'Suisse' },
  { code: 'INR', flag: '🇮🇳', name: 'Roupie indienne',    sub: 'Inde' },
];

const CODES = CURRENCY_LIST.map(c => c.code);

// Ordered longest-prefix-first so +224 matches before +2
const PREFIX_MAP: [string, string][] = [
  ['+352', 'EUR'], // Luxembourg
  ['+971', 'AED'], // EAU
  ['+966', 'SAR'], // Arabie Saoudite
  ['+254', 'KES'], // Kenya
  ['+251', 'ETB'], // Éthiopie
  ['+224', 'GNF'], // Guinée
  ['+221', 'XOF'], // Sénégal
  ['+223', 'XOF'], // Mali
  ['+225', 'XOF'], // Côte d'Ivoire
  ['+226', 'XOF'], // Burkina Faso
  ['+227', 'XOF'], // Niger
  ['+228', 'XOF'], // Togo
  ['+229', 'XOF'], // Bénin
  ['+237', 'XAF'], // Cameroun
  ['+236', 'XAF'], // Centrafrique
  ['+241', 'XAF'], // Gabon
  ['+242', 'XAF'], // Congo Brazzaville
  ['+235', 'XAF'], // Tchad
  ['+240', 'XAF'], // Guinée équatoriale
  ['+234', 'NGN'], // Nigeria
  ['+233', 'GHS'], // Ghana
  ['+212', 'MAD'], // Maroc
  ['+213', 'DZD'], // Algérie
  ['+216', 'TND'], // Tunisie
  ['+20',  'EGP'], // Égypte
  ['+27',  'ZAR'], // Afrique du Sud
  ['+33',  'EUR'], // France
  ['+32',  'EUR'], // Belgique
  ['+41',  'CHF'], // Suisse
  ['+44',  'GBP'], // Royaume-Uni
  ['+86',  'CNY'], // Chine
  ['+91',  'INR'], // Inde
  ['+1',   'USD'], // États-Unis / Canada
];

export function inferCurrency(phone: string | null | undefined): string {
  if (!phone) return 'GNF';
  for (const [prefix, code] of PREFIX_MAP) {
    if (phone.startsWith(prefix) && CODES.includes(code)) return code;
  }
  return 'GNF';
}
