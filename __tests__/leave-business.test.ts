// Critical path 5: leave business
// When a user leaves one of their businesses, the app must auto-switch
// to the remaining one — not kick them out to the welcome screen.

jest.mock('@/lib/supabase', () => ({
  supabase: {
    rpc: jest.fn(),
    from: jest.fn(),
    auth: {
      getSession: jest.fn().mockResolvedValue({ data: { session: null } }),
      onAuthStateChange: jest.fn(() => ({
        data: { subscription: { unsubscribe: jest.fn() } },
      })),
    },
    functions: { invoke: jest.fn() },
  },
}));

jest.mock('@/lib/db', () => ({
  enqueue: jest.fn(),
  getQueueCount: jest.fn().mockResolvedValue(0),
  openDb: jest.fn(),
}));

import { useAuthStore } from '@/stores/auth';
import type { Business, Membership } from '@/src/types';

const biz1: Business = {
  id: 'biz-1', name: 'SOL Chips', type: null, currency: 'GNF',
  logo_url: null, status: 'actif', subscription_tier: 'gratuit',
  subscription_status: 'trialing', trial_ends_at: null,
  stripe_customer_id: null, subscription_expires_at: null,
  created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z', created_by: 'user-1',
};

const biz2: Business = {
  id: 'biz-2', name: 'SOL Commerce', type: null, currency: 'GNF',
  logo_url: null, status: 'actif', subscription_tier: 'gratuit',
  subscription_status: 'trialing', trial_ends_at: null,
  stripe_customer_id: null, subscription_expires_at: null,
  created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z', created_by: 'user-1',
};

const mem1: Membership = {
  id: 'mem-1', user_id: 'user-1', business_id: 'biz-1',
  role: 'administrateur', pin_hash: null, joined_at: '2026-01-01T00:00:00Z',
  milestone_reached: false, business: biz1,
};

const mem2: Membership = {
  id: 'mem-2', user_id: 'user-1', business_id: 'biz-2',
  role: 'manager', pin_hash: null, joined_at: '2026-01-01T00:00:00Z',
  milestone_reached: false, business: biz2,
};

beforeEach(() => {
  useAuthStore.setState({
    session: {
      user: {
        id: 'user-1', name: 'Nick', email: '', phone: null,
        avatar_url: null, language: 'fr',
        created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
      },
      memberships: [mem1, mem2],
      activeBusiness: biz1,
      activeMembership: mem1,
    },
    loading: false,
    error: null,
    removedBusinessName: null,
    dismissedFromBusiness: null,
  });
  jest.clearAllMocks();
});

describe('leave business — with a remaining membership', () => {
  it('auto-switches to the remaining business instead of logging out', () => {
    useAuthStore.getState().handleMembershipRemovedWithFallback('biz-1', 'SOL Chips', [mem2]);

    const { session } = useAuthStore.getState();
    expect(session).not.toBeNull();
    expect(session?.activeBusiness?.id).toBe('biz-2');
    expect(session?.activeMembership?.id).toBe('mem-2');
    expect(session?.memberships).toHaveLength(1);
    expect(session?.memberships[0].id).toBe('mem-2');
  });

  it('sets dismissedFromBusiness so the UI can show a notification', () => {
    useAuthStore.getState().handleMembershipRemovedWithFallback('biz-1', 'SOL Chips', [mem2]);

    expect(useAuthStore.getState().dismissedFromBusiness?.name).toBe('SOL Chips');
  });
});

describe('leave business — sole membership', () => {
  it('clears activeBusiness when no memberships remain', () => {
    useAuthStore.getState().handleMembershipRemoved('SOL Chips');

    const { session } = useAuthStore.getState();
    expect(session?.activeBusiness).toBeNull();
    expect(session?.activeMembership).toBeNull();
    expect(useAuthStore.getState().removedBusinessName).toBe('SOL Chips');
  });
});
