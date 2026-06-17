// Role and session management in useAuthStore.
// These tests guard the business-switching logic and role updates
// that control what every user can see and do in the app.

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
  setKV: jest.fn().mockResolvedValue(undefined),
  getKV: jest.fn().mockResolvedValue(null),
}));

jest.mock('@/lib/analytics', () => ({ trackEvent: jest.fn() }));
jest.mock('@/lib/posthog', () => ({ posthog: null }));

import { useAuthStore } from '@/stores/auth';
import type { Business, Membership } from '@/src/types';

function makeBusiness(id: string, name: string): Business {
  return {
    id, name, type: null, currency: 'GNF', logo_url: null,
    status: 'actif', subscription_tier: 'gratuit',
    subscription_status: 'trialing', trial_ends_at: null,
    stripe_customer_id: null, subscription_expires_at: null, phone: null,
    created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z', created_by: 'user-1',
  };
}

function makeMembership(id: string, businessId: string, business: Business, role: Membership['role']): Membership {
  return {
    id, user_id: 'user-1', business_id: businessId, role,
    pin_hash: null, joined_at: '2026-01-01T00:00:00Z',
    milestone_reached: false, business,
  };
}

const biz1 = makeBusiness('biz-1', 'SOL Chips');
const biz2 = makeBusiness('biz-2', 'SOL Commerce');
const mem1 = makeMembership('mem-1', 'biz-1', biz1, 'administrateur');
const mem2 = makeMembership('mem-2', 'biz-2', biz2, 'vendeur');

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

describe('selectBusiness', () => {
  it('switches activeBusiness to the selected one', () => {
    useAuthStore.getState().selectBusiness('biz-2');
    expect(useAuthStore.getState().session?.activeBusiness?.id).toBe('biz-2');
    expect(useAuthStore.getState().session?.activeBusiness?.name).toBe('SOL Commerce');
  });

  it('preserves the correct role for the newly selected business', () => {
    useAuthStore.getState().selectBusiness('biz-2');
    expect(useAuthStore.getState().session?.activeMembership?.role).toBe('vendeur');
  });

  it('does nothing when the businessId is not in memberships', () => {
    useAuthStore.getState().selectBusiness('biz-unknown');
    // activeBusiness should remain biz-1
    expect(useAuthStore.getState().session?.activeBusiness?.id).toBe('biz-1');
  });

  it('does nothing when there is no session', () => {
    useAuthStore.setState({ session: null });
    useAuthStore.getState().selectBusiness('biz-2');
    expect(useAuthStore.getState().session).toBeNull();
  });
});

describe('handleRoleChanged', () => {
  it('updates the role on the active membership', () => {
    useAuthStore.getState().handleRoleChanged('manager');
    expect(useAuthStore.getState().session?.activeMembership?.role).toBe('manager');
  });

  it('does not change activeBusiness when role is updated', () => {
    useAuthStore.getState().handleRoleChanged('manager');
    expect(useAuthStore.getState().session?.activeBusiness?.id).toBe('biz-1');
  });

  it('does nothing when there is no activeMembership', () => {
    useAuthStore.setState(state => ({
      session: state.session ? { ...state.session, activeMembership: null } : null,
    }));
    useAuthStore.getState().handleRoleChanged('manager');
    expect(useAuthStore.getState().session?.activeMembership).toBeNull();
  });
});
