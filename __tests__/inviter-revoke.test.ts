// stores/inviter.ts — revoked invites must disappear entirely.
//
// The user's rule: a revoked link no longer exists, so it must leave the
// screen the instant they revoke it (not linger as a "Révoquée" badge), and
// any stale revoked row the server still returns must be dropped on fetch.

jest.mock('@/lib/analytics', () => ({ trackEvent: jest.fn() }));
jest.mock('@/lib/errors', () => ({ translateError: jest.fn((e: unknown) => 'err') }));
jest.mock('@/lib/sync', () => ({
    isNetworkError: jest.fn(() => false),
    withTimeout: jest.fn((p: unknown) => p),
}));

const mockRpc = jest.fn();
jest.mock('@/lib/supabase', () => ({ supabase: { rpc: mockRpc } }));

import { useInviterStore } from '@/stores/inviter';

const activeInvite = {
    id: 'inv-1',
    status: 'active' as const,
    created_at: '2026-10-03T00:00:00.000Z',
    expires_at: '2026-10-04T00:00:00.000Z',
    used_at: null,
    used_by: null,
    used_by_name: null,
    revoked_at: null,
};

beforeEach(() => {
    jest.clearAllMocks();
    useInviterStore.setState({ invites: [], friends: [], loading: false, error: null });
});

describe('revokeInvite — revoked means deleted', () => {
    it('removes the invite from the store entirely, not a "revoked" badge', async () => {
        useInviterStore.setState({ invites: [activeInvite] });
        mockRpc.mockResolvedValue({ data: true, error: null });

        const ok = await useInviterStore.getState().revokeInvite('inv-1');

        expect(ok).toBe(true);
        expect(useInviterStore.getState().invites).toHaveLength(0);
    });

    it('keeps other active invites untouched', async () => {
        const other = { ...activeInvite, id: 'inv-2' };
        useInviterStore.setState({ invites: [activeInvite, other] });
        mockRpc.mockResolvedValue({ data: true, error: null });

        await useInviterStore.getState().revokeInvite('inv-1');

        expect(useInviterStore.getState().invites.map(i => i.id)).toEqual(['inv-2']);
    });
});

describe('fetchMyInvites — stale revoked rows are dropped', () => {
    it('filters out revoked rows returned by the server', async () => {
        mockRpc.mockResolvedValue({
            data: [
                activeInvite,
                { ...activeInvite, id: 'inv-2', status: 'revoked', revoked_at: '2026-10-03T01:00:00.000Z' },
                { ...activeInvite, id: 'inv-3', status: 'used', used_at: '2026-10-03T01:00:00.000Z' },
            ],
            error: null,
        });

        await useInviterStore.getState().fetchMyInvites();

        expect(useInviterStore.getState().invites.map(i => i.id)).toEqual(['inv-1', 'inv-3']);
    });
});
