// P1-3 — lock screen offline: after a SUCCESSFUL biometric prompt, a failed
// session restore must never be reported as "Non reconnu" when the real cause
// is the network. These tests guard the three post-biometric outcomes in
// loginWithBiometric ('authenticated' is the live path, 'offline-cached' the
// encrypted-cache fallback, 'offline' the honest "Hors ligne…" case,
// 'auth-failed' the only truthful "Non reconnu") plus the degradeLockToCode
// escape hatch, which must clear in-memory state WITHOUT wiping the persisted
// session cache / bio refresh token until a NEW login actually succeeds.

jest.mock('@/lib/supabase', () => ({
    supabase: {
        rpc: jest.fn(),
        from: jest.fn(),
        auth: {
            getSession: jest.fn().mockResolvedValue({ data: { session: null } }),
            onAuthStateChange: jest.fn(() => ({
                data: { subscription: { unsubscribe: jest.fn() } },
            })),
            refreshSession: jest.fn(),
        },
        functions: { invoke: jest.fn() },
    },
    clearSupabaseLocalSession: jest.fn(),
    revokeAccessToken: jest.fn(),
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

import * as SecureStore from 'expo-secure-store';
import { useAuthStore } from '@/stores/auth';
import { supabase } from '@/lib/supabase';
import { reportOfflineFallback } from '@/lib/sync';
import type { AppSession, Business, Membership } from '@/src/types';

jest.mock('@/lib/sync', () => {
    const actual = jest.requireActual('@/lib/sync');
    return {
        ...actual,
        reportOfflineFallback: jest.fn(),
    };
});

const CACHE_KEY = 'patron_session_cache_v1';
const BIO_REFRESH_KEY = 'patron_bio_refresh_token';

function makeBusiness(id: string, name: string): Business {
    return {
        id, name, type: null, currency: 'GNF', logo_url: null,
        status: 'actif', subscription_tier: 'gratuit',
        subscription_status: 'trialing', trial_ends_at: null,
        stripe_customer_id: null, subscription_expires_at: null, phone: null,
        payment_provider: null, revenuecat_customer_id: null, bonus_access_until: null,
        referred_by_business_id: null, referral_code: null, first_run_hero_completed_at: null,
        created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z', created_by: 'user-1',
    };
}

function makeMembership(id: string, businessId: string, business: Business, role: Membership['role']): Membership {
    return {
        id, user_id: 'user-1', business_id: businessId, role,
        joined_at: '2026-01-01T00:00:00Z',
        milestone_reached: false, business,
    };
}

function makeSession(): AppSession {
    const biz = makeBusiness('biz-1', 'SOL Chips');
    const mem = makeMembership('mem-1', 'biz-1', biz, 'administrateur');
    return {
        user: {
            id: 'user-1', name: 'Nick', email: '', phone: null,
            avatar_url: null, language: 'fr', recovery_email: null, notify_on_every_sale: true,
            created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
        },
        memberships: [mem],
        activeBusiness: biz,
        activeMembership: mem,
    };
}

async function seedSessionCache(session: AppSession): Promise<void> {
    const json = JSON.stringify(session);
    await SecureStore.setItemAsync(`${CACHE_KEY}_count`, '1');
    await SecureStore.setItemAsync(`${CACHE_KEY}_0`, json);
}

async function resetSecureStore(): Promise<void> {
    await SecureStore.deleteItemAsync(`${CACHE_KEY}_count`);
    await SecureStore.deleteItemAsync(`${CACHE_KEY}_0`);
    await SecureStore.deleteItemAsync(BIO_REFRESH_KEY);
}

const refreshSessionMock = supabase.auth.refreshSession as jest.Mock;

beforeEach(async () => {
    await resetSecureStore();
    useAuthStore.setState({
        session: null,
        loading: false,
        locked: true,
        error: null,
    });
    jest.clearAllMocks();
});

describe('loginWithBiometric — offline session restore', () => {
    it('falls back to the encrypted session cache and returns "offline-cached" on a network-shaped refresh failure', async () => {
        const cached = makeSession();
        await seedSessionCache(cached);
        // A plain fetch failure: isAuthRetryableFetchError sees no __isAuthError,
        // but isNetworkError() matches the "fetch" substring.
        refreshSessionMock.mockResolvedValue({ error: new Error('fetch failed'), data: { session: null } });

        const result = await useAuthStore.getState().loginWithBiometric();

        expect(result).toBe('offline-cached');
        expect(useAuthStore.getState().session).toEqual(cached);
        expect(useAuthStore.getState().loading).toBe(false);
        expect(reportOfflineFallback).not.toHaveBeenCalled();
    });

    it('recognizes a Supabase AuthRetryableFetchError-shaped failure as network-shaped too', async () => {
        const cached = makeSession();
        await seedSessionCache(cached);
        refreshSessionMock.mockResolvedValue({
            error: { __isAuthError: true, name: 'AuthRetryableFetchError', message: 'fetch failed' },
            data: { session: null },
        });

        const result = await useAuthStore.getState().loginWithBiometric();

        expect(result).toBe('offline-cached');
        expect(useAuthStore.getState().session).toEqual(cached);
    });

    it('returns "offline" (never "auth-failed") when the network is down and no cache exists', async () => {
        refreshSessionMock.mockResolvedValue({ error: new Error('network request failed'), data: { session: null } });

        const result = await useAuthStore.getState().loginWithBiometric();

        expect(result).toBe('offline');
        expect(useAuthStore.getState().session).toBeNull();
        expect(reportOfflineFallback).toHaveBeenCalledWith('auth.loginWithBiometric', expect.anything());
    });

    it('returns "auth-failed" for a genuine non-network auth rejection — the only truthful "Non reconnu"', async () => {
        const cached = makeSession();
        await seedSessionCache(cached);
        // A real invalid/revoked token rejection, NOT network-shaped: no
        // AuthRetryableFetchError name, no network keyword in the message.
        refreshSessionMock.mockResolvedValue({
            error: { __isAuthError: true, name: 'AuthInvalidCredentialsError', message: 'Invalid Refresh Token' },
            data: { session: null },
        });

        const result = await useAuthStore.getState().loginWithBiometric();

        expect(result).toBe('auth-failed');
        // A valid cache must NOT be used to paper over a genuine auth rejection.
        expect(useAuthStore.getState().session).toBeNull();
        expect(reportOfflineFallback).not.toHaveBeenCalled();
    });
});

describe('degradeLockToCode', () => {
    it('clears in-memory session/locked state without wiping the persisted session cache or bio refresh token', async () => {
        const session = makeSession();
        await seedSessionCache(session);
        await SecureStore.setItemAsync(BIO_REFRESH_KEY, 'bio-token-123');
        useAuthStore.setState({ session, locked: true });

        await useAuthStore.getState().degradeLockToCode();

        expect(useAuthStore.getState().session).toBeNull();
        expect(useAuthStore.getState().locked).toBe(false);

        // The persisted session survives so the NEXT biometric attempt can still
        // restore it for free — degradeToCode must never route through logout().
        expect(await SecureStore.getItemAsync(`${CACHE_KEY}_count`)).toBe('1');
        expect(await SecureStore.getItemAsync(`${CACHE_KEY}_0`)).toBe(JSON.stringify(session));
        expect(await SecureStore.getItemAsync(BIO_REFRESH_KEY)).toBe('bio-token-123');
    });
});
