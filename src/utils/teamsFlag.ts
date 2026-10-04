// Team feature flag (businesses.teams_enabled, migration_v227).
//
// Équipe, Apports, the Ma Boutique chat tab and role badges are team
// concepts, meaningless for a solo shop — hidden while the flag is false.
// VISIBILITY ONLY: no data is touched anywhere; memberships, capital
// injections and chat history persist regardless of the flag.
//
// FAIL-OPEN: only a strict `false` hides anything. A missing/undefined/null
// flag (an old server without the column, a cached session from before the
// column existed, no business yet) shows everything — today's behavior. Never
// hide UI on an unknown flag.
export function isTeamsEnabled(
  business: { teams_enabled?: boolean | null } | null | undefined,
): boolean {
  return business?.teams_enabled !== false;
}

export type DiscussionsTab = 'boutique' | 'amis' | 'marche';

/**
 * The tab Discussions actually shows. While teams are off, Ma Boutique (the
 * team chat) can never be visible: it falls back to Amis (offered to
 * admin/manager) or Le Marché. Other tabs are never touched.
 */
export function resolveDiscussionsTab(
  requested: DiscussionsTab,
  teamsEnabled: boolean,
  isAdminOrManager: boolean,
): DiscussionsTab {
  if (requested === 'boutique' && !teamsEnabled) return isAdminOrManager ? 'amis' : 'marche';
  return requested;
}

/**
 * Every team surface the flag controls, in one place — the single source of
 * truth the screens and the tests share. All fail-open via isTeamsEnabled.
 */
export function teamSurfaces(
  business: { teams_enabled?: boolean | null } | null | undefined,
  isAdminOrManager = true,
) {
  const on = isTeamsEnabled(business);
  return {
    equipeEntry: on,        // Plus menu → Équipe
    apportsEntry: on,       // Plus menu → Apports / Mes apports
    maBoutiqueTab: on,      // Discussions → Ma Boutique
    roleBadges: on,         // "Vous êtes Gérant", drawer role labels
    defaultDiscussionsTab: resolveDiscussionsTab('boutique', on, isAdminOrManager),
  };
}
