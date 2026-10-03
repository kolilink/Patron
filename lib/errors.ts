const TRANSLATIONS: [string, string][] = [
  // Auth errors from Supabase
  ['invalid login credentials', 'Email ou mot de passe incorrect'],
  ['invalid credentials', 'Email ou mot de passe incorrect'],
  ['email not confirmed', 'Veuillez confirmer votre email avant de vous connecter'],
  ['user already registered', 'Cet email est déjà utilisé'],
  ['already registered', 'Cet email est déjà utilisé'],
  ['password should be at least', 'Le mot de passe doit contenir au moins 6 caractères'],
  ['password is too short', 'Le mot de passe est trop court'],
  ['user not found', 'Aucun compte associé à cet email'],
  ['invalid email', 'Adresse email invalide'],
  ['email address is invalid', 'Adresse email invalide'],
  ['email link is invalid', 'Lien invalide ou expiré'],
  ['token has expired', 'Session expirée. Reconnectez-vous.'],
  ['token is expired', 'Session expirée. Reconnectez-vous.'],
  ['jwt expired', 'Session expirée. Reconnectez-vous.'],
  ['signup_disabled', 'Les inscriptions sont temporairement désactivées'],
  ['signups not allowed', 'Les inscriptions sont temporairement désactivées'],
  ['too many requests', 'Trop de tentatives. Réessayez dans quelques minutes.'],
  ['rate limit', 'Trop de tentatives. Réessayez plus tard.'],
  ['over_request_rate_limit', 'Trop de tentatives. Réessayez plus tard.'],
  ['anonymous sign-ins are disabled', 'Les connexions anonymes sont désactivées dans Supabase. Activez-les dans Authentication → Providers.'],
  ['anonymous logins are not enabled', 'Les connexions anonymes sont désactivées dans Supabase.'],
  ['anon sign-in', 'Les connexions anonymes sont désactivées dans Supabase.'],
  // Network errors
  ['network request failed', 'Erreur de réseau. Vérifiez votre connexion.'],
  ['failed to fetch', 'Erreur de réseau. Vérifiez votre connexion.'],
  ['networkerror', 'Erreur de réseau. Vérifiez votre connexion.'],
  ['load failed', 'Erreur de réseau. Vérifiez votre connexion.'],
  // Database / RLS errors
  ['permission denied', 'Accès refusé'],
  ['row-level security', 'Accès refusé'],
  ['violates row-level', 'Accès refusé'],
  ['duplicate key', 'Cette entrée existe déjà'],
  ['unique constraint', 'Cette entrée existe déjà'],
  ['foreign key constraint', 'Opération impossible : des données liées existent'],
  ['violates foreign key', 'Opération impossible : des données liées existent'],
  ['not-null constraint', 'Des champs obligatoires sont manquants'],
  ['violates check constraint', 'Valeur non autorisée dans la base de données'],
  ['check constraint', 'Valeur non autorisée dans la base de données'],
];

export function translateError(err: unknown, fallback: string): string {
  const message = extractRawMessage(err);
  if (!message) return fallback;
  const lower = message.toLowerCase();
  for (const [pattern, translation] of TRANSLATIONS) {
    if (lower.includes(pattern)) return translation;
  }
  return fallback;
}

/**
 * Server-authored, already-French, non-technical messages that must reach the
 * user VERBATIM — never through the English-pattern translation table. This is
 * how the non-punitive Phase 3 rate-limit message
 * ("Doucement — vous pourrez republier dans X minutes.") and the Phase 5
 * identity messages survive the client without being rewritten into a generic
 * fallback.
 */
export function extractRawMessage(err: unknown): string | null {
  return err instanceof Error
    ? err.message
    : typeof (err as Record<string, unknown>)?.message === 'string'
      ? (err as Record<string, unknown>).message as string
      : null;
}

const SERVER_FRIENDLY_PREFIXES = [
  'doucement',
  'votre pseudo',
  'participez aux discussions',
  'categorie invalide',
  'catégorie invalide',
  'ce pseudo',
  'le pseudo doit',
  'vous ne pouvez pas signaler',
  'vous avez deja signale',
  'vous avez déjà signalé',
  'post introuvable',
  'motif invalide',
  'connexion requise',
  'acces refusé',
  'accès refusé',
  'maximum un niveau',
  'ce fournisseur',
  'seul un administrateur',
  'impossible de rétrograder',
];

/**
 * Prefer the server's own French sentence when it is one we authored (raised
 * via RAISE EXCEPTION in a SECURITY DEFINER RPC), otherwise translate.
 * Prevents the client from rephrasing messages the spec demands stay intact.
 */
export function friendlyMessage(err: unknown, fallback: string): string {
  const raw = extractRawMessage(err);
  if (raw) {
    const trimmed = raw.trim();
    const lower = trimmed.toLowerCase();
    if (SERVER_FRIENDLY_PREFIXES.some(p => lower.startsWith(p))) {
      return trimmed;
    }
  }
  return translateError(err, fallback);
}
