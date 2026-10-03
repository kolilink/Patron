// P1-3 — OS-native lock: unlockWithBiometric must restore the session from the
// LOCAL encrypted cache after the OS prompt succeeds, and must NEVER require
// network. A device with no biometric AND no device credential enrolled skips
// the prompt and passes straight through (restores the cache), so a dead lock
// screen is never shown. The OS owns all retry/fallback UI, so a failed prompt
// is simply 'retryable' — the app shows no duplicated error copy.

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

jest.mock('@/lib/sync', () => {
    const actual = jest.requireActual('@/lib/sync');
    return {
        ...actual,
        reportOfflineFallback: jest.fn(),
    };
});

import * as SecureStore from 'expo-secure-store';
import * as LocalAuthentication from 'expo-local-authentication';
import { useAuthStore } from '@/stores/auth';
import { supabase } from '@/lib/supabase';
import { reportOfflineFallback } from '@/lib/sync';
import type { AppSession, Business, Membership } from '@/src/types';

const CACHE_KEY = 'patron_session_cache_v1';
const LOCKED_KEY = 'patron_locked_v1';

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
    await SecureStore.deleteItemAsync(LOCKED_KEY);
}

const isEnrolledMock = LocalAuthentication.isEnrolledAsync as jest.Mock;
const authenticateMock = LocalAuthentication.authenticateAsync as jest.Mock;
const refreshSessionMock = supabase.auth.refreshSession as jest.Mock;

beforeEach(async () => {
    await resetSecureStore();
    useAuthStore.setState({
        session: null,
        loading: false,
        locked: true,
        error: null,
    });
    isEnrolledMock.mockResolvedValue(true);
    authenticateMock.mockResolvedValue({ success: true });
    jest.clearAllMocks();
});

describe('unlockWithBiometric — local session restore (OS-native auth)', () => {
    it('unlocks from the encrypted session cache after a successful OS prompt, with zero network calls', async () => {
        const cached = makeSession();
        await seedSessionCache(cached);

        const result = await useAuthStore.getState().unlockWithBiometric();

        expect(result).toBe('unlocked');
        expect(useAuthStore.getState().session).toEqual(cached);
        expect(useAuthStore.getState().locked).toBe(false);
        expect(authenticateMock).toHaveBeenCalledTimes(1);
        // The lock screen must NEVER require network.
        expect(refreshSessionMock).not.toHaveBeenCalled();
        expect(reportOfflineFallback).not.toHaveBeenCalled();
    });

    it('uses disableDeviceFallback: false so iOS/Android own the device-credential fallback', async () => {
        await seedSessionCache(makeSession());

        await useAuthStore.getState().unlockWithBiometric();

        expect(authenticateMock).toHaveBeenCalledWith(expect.objectContaining({
            disableDeviceFallback: false,
        }));
    });

    it('skips the prompt and passes through (unlocked) when no biometric/device credential is enrolled', async () => {
        const cached = makeSession();
        await seedSessionCache(cached);
        isEnrolledMock.mockResolvedValue(false);

        const result = await useAuthStore.getState().unlockWithBiometric();

        expect(result).toBe('unlocked');
        expect(useAuthStore.getState().session).toEqual(cached);
        expect(useAuthStore.getState().locked).toBe(false);
        // No dead lock screen: the native prompt must never even be shown.
        expect(authenticateMock).not.toHaveBeenCalled();
        expect(refreshSessionMock).not.toHaveBeenCalled();
    });

    it('returns "retryable" and stays locked when the OS prompt does not succeed', async () => {
        authenticateMock.mockResolvedValue({ success: false, error: 'user_cancel' });

        const result = await useAuthStore.getState().unlockWithBiometric();

        expect(result).toBe('retryable');
        expect(useAuthStore.getState().session).toBeNull();
        expect(useAuthStore.getState().locked).toBe(true);
    });

    it('unlocks with a null session (still passes through) when OS auth succeeds but no cache exists', async () => {
        const result = await useAuthStore.getState().unlockWithBiometric();

        expect(result).toBe('unlocked');
        expect(useAuthStore.getState().session).toBeNull();
        expect(useAuthStore.getState().locked).toBe(false);
        expect(refreshSessionMock).not.toHaveBeenCalled();
    });

    it('drops a stacked call while a native prompt is already in flight', async () => {
        // First call leaves the in-flight guard held until the prompt settles.
        let resolvePrompt: (v: unknown) => void = () => { };
        authenticateMock.mockImplementation(() => new Promise(r => { resolvePrompt = r; }));

        const first = useAuthStore.getState().unlockWithBiometric();

        // Drain the microtask queue (import → isEnrolledAsync → authenticateAsync)
        // so the first call is deterministically parked at the native prompt
        // before the stacked call is attempted.
        await new Promise(r => setTimeout(r, 0));

        const second = await useAuthStore.getState().unlockWithBiometric();

        expect(second).toBe('retryable');
        resolvePrompt({ success: true });
        await expect(first).resolves.toBe('unlocked');
    });
});
