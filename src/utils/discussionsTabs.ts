import { AMIS_ENABLED } from '@/src/utils/featureFlags';

export type DiscussionsTab = 'boutique' | 'amis' | 'marche';

// Display order of the segmented control. Le Marché is always last and always
// enabled, so the enabled list is never empty.
export const DISCUSSIONS_TAB_ORDER: DiscussionsTab[] = ['boutique', 'amis', 'marche'];

export interface DiscussionsTabConfig {
  /** Ma Boutique visibility — businesses.teams_enabled (fail-open). */
  teamsEnabled: boolean;
  /** Amis offered to this user (admin/manager only, today). */
  isAdminOrManager: boolean;
  /** Build-time Amis flag; injectable for tests. */
  amisEnabled?: boolean;
}

/** The tabs actually offered, in display order. Never empty (Le Marché stays). */
export function enabledDiscussionsTabs(cfg: DiscussionsTabConfig): DiscussionsTab[] {
  const amis = cfg.amisEnabled ?? AMIS_ENABLED;
  return DISCUSSIONS_TAB_ORDER.filter(t => {
    if (t === 'boutique') return cfg.teamsEnabled;
    if (t === 'amis') return amis && cfg.isAdminOrManager;
    return true;
  });
}

/**
 * The tab to show for a requested one. Anything not enabled — a stale state, a
 * deep link to a disabled tab, an unknown string — falls back to Le Marché.
 */
export function resolveActiveTab(requested: string | null | undefined, enabled: DiscussionsTab[]): DiscussionsTab {
  return enabled.includes(requested as DiscussionsTab) ? (requested as DiscussionsTab) : 'marche';
}

/** The segmented control is only chrome when there is something to switch between. */
export function showTabBar(enabled: DiscussionsTab[]): boolean {
  return enabled.length > 1;
}
