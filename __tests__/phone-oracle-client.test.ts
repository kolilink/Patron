// Phase 9, Finding 1 (client half). create-phone-verification stopped saying up
// front whether a number is registered, so the two screens that depended on it
// get the same answers AFTER the caller proves they hold the number:
//  - login on an unknown number  -> restore-phone-session 404 PHONE_NOT_FOUND
//  - signup on a taken number    -> upgrade_anonymous_user refusal -> PHONE_EXISTS
// The sign-up / login screens already render both codes; these tests pin that the
// store still produces exactly those strings (not a generic fallback).
jest.mock('@/lib/supabase', () => ({
  supabase: {
    rpc: jest.fn(),
    from: jest.fn(),
    auth: {
      getSession: jest.fn().mockResolvedValue({ data: { session: null } }),
      getUser: jest.fn(),
      onAuthStateChange: jest.fn(() => ({ data: { subscription: { unsubscribe: jest.fn() } } })),
      refreshSession: jest.fn(),
      verifyOtp: jest.fn(),
    },
    functions: { invoke: jest.fn() },
  },
  clearSupabaseLocalSession: jest.fn(),
  revokeAccessToken: jest.fn(),
}));
jest.mock('@/lib/db', () => ({
  enqueue: jest.fn(), getQueueCount: jest.fn().mockResolvedValue(0), openDb: jest.fn(),
  setKV: jest.fn().mockResolvedValue(undefined), getKV: jest.fn().mockResolvedValue(null),
}));
jest.mock('@/lib/analytics', () => ({ trackEvent: jest.fn(), classifyAuthError: jest.fn() }));
jest.mock('@/lib/posthog', () => ({ posthog: null }));

import { useAuthStore } from '@/stores/auth';
import { supabase } from '@/lib/supabase';

const mocked = supabase as unknown as {
  rpc: jest.Mock; from: jest.Mock; auth: { getUser: jest.Mock };
  functions: { invoke: jest.Mock };
};

beforeEach(() => { jest.clearAllMocks(); useAuthStore.setState({ error: null, loading: false }); });

describe('login on an unknown number', () => {
  it('surfaces PHONE_NOT_FOUND (not a generic "Connexion échouée") from restore-phone-session', async () => {
    mocked.functions.invoke.mockResolvedValue({
      data: null,
      error: { message: 'Edge Function returned a non-2xx status code', context: { json: async () => ({ error: 'PHONE_NOT_FOUND' }) } },
    });
    await useAuthStore.getState().restorePhoneSession('+224620000002', 'verif-1');
    expect(useAuthStore.getState().error).toBe('PHONE_NOT_FOUND');
  });
});

describe('signup on an already-registered number', () => {
  it('surfaces PHONE_EXISTS when upgrade_anonymous_user refuses the verified number', async () => {
    mocked.auth.getUser.mockResolvedValue({ data: { user: { id: 'u1' } } });
    mocked.from.mockReturnValue({ upsert: jest.fn().mockResolvedValue({ error: null }) });
    mocked.rpc.mockResolvedValue({ error: { code: 'P0001', message: 'Accès refusé' } });
    await useAuthStore.getState().upgradePhone('+224620000001');
    expect(useAuthStore.getState().error).toBe('PHONE_EXISTS');
  });

  it('other RPC failures are NOT relabelled as PHONE_EXISTS', async () => {
    mocked.auth.getUser.mockResolvedValue({ data: { user: { id: 'u1' } } });
    mocked.from.mockReturnValue({ upsert: jest.fn().mockResolvedValue({ error: null }) });
    mocked.rpc.mockResolvedValue({ error: { code: '42501', message: 'permission denied for function x' } });
    await useAuthStore.getState().upgradePhone('+224620000001');
    expect(useAuthStore.getState().error).not.toBe('PHONE_EXISTS');
  });
});
