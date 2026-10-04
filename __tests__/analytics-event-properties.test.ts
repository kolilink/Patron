// Every analytics event carries business_id and is_test, and nothing sent
// to PostHog contains a name (measurement spec §0, docs/measurement.md).
import * as fs from 'fs';
import * as path from 'path';

const capture = jest.fn();
const register = jest.fn(() => Promise.resolve());
const identify = jest.fn();
const group = jest.fn();
const reset = jest.fn();
jest.mock('@/lib/posthog', () => ({ posthog: { capture, register, identify, group, reset } }));

const kv = new Map<string, string>();
jest.mock('@/lib/db', () => ({
  getKV: jest.fn((k: string) => Promise.resolve(kv.get(k) ?? null)),
  setKV: jest.fn((k: string, v: string) => { kv.set(k, v); return Promise.resolve(); }),
}));

// lib/analytics.ts imports isNetworkError from lib/sync.ts, which imports
// lib/supabase.ts at module top level. Without this mock, that module-level
// createClient() runs for real and instantiates a Supabase RealtimeClient —
// which throws on CI's Node 20 (no native WebSocket). Every other suite that
// imports lib/sync mocks @/lib/supabase; this one was missing it and only
// passed locally because dev machines run Node 22+/24 with native WebSocket.
jest.mock('@/lib/supabase', () => ({
  supabase: {
    rpc: jest.fn(),
    from: jest.fn(),
  },
}));

import {
  trackEvent,
  identifyUser,
  resetAnalytics,
  setAnalyticsSession,
  loadDeviceTestFlag,
  analyticsIsTest,
} from '@/lib/analytics';
import type { AppSession } from '@/src/types';

function session(opts: { phone?: string; userTest?: boolean; bizTest?: boolean } = {}): AppSession {
  const business = {
    id: 'biz-1', name: 'Boutique Aïssatou', type: 'commerce', currency: 'GNF',
    subscription_status: 'trialing', is_test: opts.bizTest ?? false,
  } as unknown as AppSession['activeBusiness'];
  return {
    user: { id: 'user-1', name: 'Aïssatou Diallo', phone: opts.phone ?? '+224620000000', is_test: opts.userTest ?? false } as AppSession['user'],
    activeBusiness: business,
    activeMembership: { role: 'administrateur' } as AppSession['activeMembership'],
    memberships: [],
  };
}

function lastProps(): Record<string, unknown> {
  return capture.mock.calls[capture.mock.calls.length - 1][1];
}

beforeEach(() => {
  capture.mockClear(); register.mockClear(); identify.mockClear(); group.mockClear();
  kv.clear();
  setAnalyticsSession(null);
});

describe('business_id + is_test on every event', () => {
  it('pre-auth events still carry both keys (business_id null, is_test false)', () => {
    trackEvent('signup_started', null, null);
    expect(lastProps()).toEqual(expect.objectContaining({ business_id: null, is_test: false }));
  });

  it('falls back to the active business when the caller passes null', () => {
    setAnalyticsSession(session());
    trackEvent('app_opened', null, null);
    expect(lastProps()).toEqual(expect.objectContaining({ business_id: 'biz-1', is_test: false }));
  });

  it('a metadata key can never override business_id / is_test', () => {
    setAnalyticsSession(session({ bizTest: true }));
    trackEvent('sale_recorded', 'biz-1', 'user-1', { is_test: false, business_id: 'other' });
    expect(lastProps()).toEqual(expect.objectContaining({ business_id: 'biz-1', is_test: true }));
  });

  it.each([
    ['the founder phone', { phone: '+1 267-242-1843' }],
    ['a test profile', { userTest: true }],
    ['a test business', { bizTest: true }],
  ])('%s → is_test true', (_label, opts) => {
    setAnalyticsSession(session(opts));
    trackEvent('sale_recorded', 'biz-1', 'user-1');
    expect(lastProps().is_test).toBe(true);
  });

  it('registers both as super properties so autocaptured events carry them too', () => {
    setAnalyticsSession(session({ bizTest: true }));
    expect(register).toHaveBeenLastCalledWith({ business_id: 'biz-1', is_test: true });
  });
});

describe('sticky device test flag', () => {
  it('a team phone stays test on the welcome/OTP screens after logout', async () => {
    setAnalyticsSession(session({ phone: '+12672421843' }));
    resetAnalytics();
    expect(analyticsIsTest()).toBe(true);
    trackEvent('signup_started', null, null);
    expect(lastProps().is_test).toBe(true);
  });

  it('is restored at cold start from storage', async () => {
    kv.set('analytics_device_is_test', '1');
    await loadDeviceTestFlag();
    expect(analyticsIsTest()).toBe(true);
  });

  it('never marks a real merchant session as test, even on a former team phone', async () => {
    kv.set('analytics_device_is_test', '1');
    await loadDeviceTestFlag();
    setAnalyticsSession(session());
    trackEvent('sale_recorded', 'biz-1', 'user-1');
    expect(lastProps().is_test).toBe(false);
  });
});

describe('no PII', () => {
  it('identify and group send no person or business name', () => {
    identifyUser(session());
    const sent = JSON.stringify([identify.mock.calls, group.mock.calls]);
    expect(sent).not.toMatch(/Aïssatou|Diallo|Boutique/);
    expect(identify.mock.calls[0][1]).toEqual(expect.objectContaining({ is_test: false, business_id: 'biz-1' }));
  });

  it('no trackEvent call site in the app passes a name, phone, or debt amount', () => {
    const root = path.resolve(__dirname, '..');
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.tsx?$/.test(e.name)) files.push(p);
      }
    };
    ['app', 'src', 'stores', 'lib'].forEach(d => walk(path.join(root, d)));

    const offenders: string[] = [];
    for (const f of files) {
      const src = fs.readFileSync(f, 'utf8');
      // Real calls only (string event name) — not prose mentioning trackEvent().
      const re = /trackEvent\(\s*['"][a-z_]+['"]([\s\S]*?)\);/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(src))) {
        if (/\b(name|phone|customer_name|client_name|owner_name|amount_cents)\s*:/.test(m[1])) {
          offenders.push(`${path.relative(root, f)}: ${m[1].slice(0, 80)}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
