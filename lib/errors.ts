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
  if (!(err instanceof Error)) return fallback;
  const lower = err.message.toLowerCase();
  for (const [pattern, translation] of TRANSLATIONS) {
    if (lower.includes(pattern)) return translation;
  }
  return fallback;
}
