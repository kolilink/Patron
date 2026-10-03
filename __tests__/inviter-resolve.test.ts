// stores/inviter.ts — B1 push on fresh redemption + B5 state reset.
//
// resolveInvite must fire the "un ami t'a rejoint" push ONLY on a FRESH
// redemption (newly_used !== false) — never on an idempotent re-fire — and
// reset() must wipe invites + friends so a second account on the same device
// sees zero trace of the first (B5).

jest.mock('@/lib/analytics', () => ({ trackEvent: jest.fn() }));
jest.mock('@/lib/errors', () => ({ translateError: jest.fn((e: unknown) => 'err') }));
jest.mock('@/lib/sync', () => ({
    isNetworkError: jest.fn(() => false),
    withTimeout: jest.fn((p: unknown) => p),
}));

const notifyEvent = jest.fn();
jest.mock('@/src/utils/notifications', () => ({ notifyEvent }));

const mockAuthGetState = jest.fn(() => ({ session: { activeBusiness: { id: 'biz-1' } } }));
jest.mock('@/stores/auth', () => ({
    useAuthStore: { getState: mockAuthGetState },
}));

const mockRpc = jest.fn();
jest.mock('@/lib/supabase', () => ({ supabase: { rpc: mockRpc } }));

import { useInviterStore } from '@/stores/inviter';

beforeEach(() => {
    jest.clearAllMocks();
    useInviterStore.setState({ invites: [], friends: [], loading: false, error: null });
});

describe('resolveInvite — B1 push on fresh redemption only', () => {
    it('fires consumer_invite_accepted to the inviter when newly_used=true', async () => {
        mockRpc
            .mockResolvedValueOnce({ data: null, error: null }) // record_invite_attempt
            .mockResolvedValueOnce({
                data: { inviter_id: 'inviter-1', inviter_name: 'Awa', newly_used: true },
                error: null,
            });

        const result = await useInviterStore.getState().resolveInvite('tok', '');

        expect(result?.inviter_id).toBe('inviter-1');
        expect(notifyEvent).toHaveBeenCalledWith({
            businessId: 'biz-1',
            eventType: 'consumer_invite_accepted',
            payload: {},
            targetUserIds: ['inviter-1'],
        });
    });

    it('does NOT re-fire the push on an idempotent re-fire (newly_used=false)', async () => {
        mockRpc
            .mockResolvedValueOnce({ data: null, error: null })
            .mockResolvedValueOnce({
                data: { inviter_id: 'inviter-1', inviter_name: 'Awa', newly_used: false },
                error: null,
            });

        const result = await useInviterStore.getState().resolveInvite('tok', '');

        expect(result?.inviter_id).toBe('inviter-1');
        expect(notifyEvent).not.toHaveBeenCalled();
    });
});

describe('reset — B5 no cross-account leakage', () => {
    it('wipes invites and friends in one call', () => {
        useInviterStore.setState({
            invites: [{ id: 'inv-1', status: 'active', created_at: '', expires_at: '', used_at: null, used_by: null, used_by_name: null, revoked_at: null }],
            friends: [{ id: 'f-1', friend_id: 'u-1', friend_name: 'Awa', invited_at: '2026-10-03T00:00:00.000Z' }],
            error: 'stale',
        });

        useInviterStore.getState().reset();

        const s = useInviterStore.getState();
        expect(s.invites).toEqual([]);
        expect(s.friends).toEqual([]);
        expect(s.error).toBeNull();
    });
});
