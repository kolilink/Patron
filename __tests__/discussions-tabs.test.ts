import {
  enabledDiscussionsTabs, resolveActiveTab, showTabBar,
} from '@/src/utils/discussionsTabs';
import { AMIS_ENABLED } from '@/src/utils/featureFlags';
import { readFileSync } from 'fs';
import { join } from 'path';

const cfg = (teamsEnabled: boolean, isAdminOrManager: boolean, amisEnabled: boolean) =>
  ({ teamsEnabled, isAdminOrManager, amisEnabled });

describe('Amis flag', () => {
  it('ships OFF', () => {
    expect(AMIS_ENABLED).toBe(false);
  });
});

describe('enabledDiscussionsTabs', () => {
  it('flags off → Le Marché only', () => {
    expect(enabledDiscussionsTabs(cfg(false, true, false))).toEqual(['marche']);
    expect(enabledDiscussionsTabs(cfg(false, false, false))).toEqual(['marche']);
  });
  it('all on → existing order', () => {
    expect(enabledDiscussionsTabs(cfg(true, true, true))).toEqual(['boutique', 'amis', 'marche']);
  });
  it('subsets keep order; Amis stays admin/manager only', () => {
    expect(enabledDiscussionsTabs(cfg(true, true, false))).toEqual(['boutique', 'marche']);
    expect(enabledDiscussionsTabs(cfg(false, true, true))).toEqual(['amis', 'marche']);
    expect(enabledDiscussionsTabs(cfg(false, false, true))).toEqual(['marche']);
  });
  it('is never empty', () => {
    for (const t of [true, false]) for (const a of [true, false]) for (const m of [true, false]) {
      expect(enabledDiscussionsTabs(cfg(t, a, m)).length).toBeGreaterThan(0);
    }
  });
  it('defaults to the real AMIS_ENABLED flag', () => {
    expect(enabledDiscussionsTabs({ teamsEnabled: true, isAdminOrManager: true })).toEqual(
      AMIS_ENABLED ? ['boutique', 'amis', 'marche'] : ['boutique', 'marche'],
    );
  });
});

describe('resolveActiveTab', () => {
  it('keeps an enabled tab', () => {
    expect(resolveActiveTab('boutique', ['boutique', 'marche'])).toBe('boutique');
    expect(resolveActiveTab('marche', ['boutique', 'marche'])).toBe('marche');
  });
  it('a disabled tab (deep link / stale state) lands on Le Marché, never blank', () => {
    expect(resolveActiveTab('amis', ['marche'])).toBe('marche');
    expect(resolveActiveTab('boutique', ['marche'])).toBe('marche');
    expect(resolveActiveTab('amis', ['boutique', 'marche'])).toBe('marche');
  });
  it('unknown / missing → Le Marché', () => {
    expect(resolveActiveTab('wat', ['boutique', 'marche'])).toBe('marche');
    expect(resolveActiveTab(undefined, ['marche'])).toBe('marche');
    expect(resolveActiveTab(null, ['marche'])).toBe('marche');
  });
  it('the initial tab (boutique) is always an enabled one', () => {
    for (const t of [true, false]) for (const a of [true, false]) for (const m of [true, false]) {
      const enabled = enabledDiscussionsTabs(cfg(t, a, m));
      expect(enabled).toContain(resolveActiveTab('boutique', enabled));
    }
  });
});

describe('showTabBar', () => {
  it('no tab chrome for a single tab; shown for 2+', () => {
    expect(showTabBar(['marche'])).toBe(false);
    expect(showTabBar(['boutique', 'marche'])).toBe(true);
    expect(showTabBar(['boutique', 'amis', 'marche'])).toBe(true);
  });
});

describe('discussions.tsx is driven by the config (source guards)', () => {
  const d = readFileSync(join(__dirname, '..', 'app/(app)/discussions.tsx'), 'utf8');
  it('renders the segmented control only through showTabBar()', () => {
    expect(d).toMatch(/\{showTabBar\(enabledTabs\) && \(\s*<View style=\{styles\.tabRow\}>/);
  });
  it('each segment is gated on the enabled list; Le Marché is not', () => {
    expect(d).toMatch(/enabledTabs\.includes\('boutique'\)/);
    expect(d).toMatch(/enabledTabs\.includes\('amis'\)/);
  });
  it('the active tab is always resolved, and no consumer-invite UI remains', () => {
    expect(d).toMatch(/resolveActiveTab\(tabState, enabledTabs\)/);
    expect(d).not.toMatch(/redeemCode|consumerFriends|inviter'/);
  });
});
