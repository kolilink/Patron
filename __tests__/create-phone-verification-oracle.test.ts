// Phase 9, Finding 1 — phone enumeration oracle in create-phone-verification.
//
// The endpoint is reachable by anyone who can mint a free anonymous session, so
// its response must not depend on whether a number is already registered.
// Drives the REAL handler (supabase/functions/create-phone-verification/handler.ts)
// with in-memory dependencies; the "registered" and "unknown" worlds differ ONLY
// in what the profile lookup would return.
import { handleCreatePhoneVerification, CreatePhoneVerificationDeps } from '../supabase/functions/create-phone-verification/handler';

const REGISTERED = '+224620000001';
const UNKNOWN = '+224620000002';

function makeDeps(opts: { registered: Set<string>; latencyMs?: (what: string) => number; log?: string[] }): CreatePhoneVerificationDeps {
  const log = opts.log ?? [];
  const wait = async (what: string) => {
    log.push(what);
    const ms = opts.latencyMs?.(what) ?? 0;
    if (ms) await new Promise((r) => setTimeout(r, ms));
  };
  let n = 0;
  return {
    getUser: async () => ({ id: 'user-1' }),
    countPhoneAttempts: async () => { await wait('countPhone'); return 0; },
    countIpAttempts: async () => { await wait('countIp'); return 0; },
    recordAttempts: async () => { await wait('record'); },
    purgeAttemptsBefore: async () => { await wait('purge'); },
    sendOtp: async () => { await wait('send'); },
    insertVerification: async () => { await wait('insert'); return `00000000-0000-4000-8000-00000000000${++n}`; },
    generateCode: () => '123456',
    hashToken: async (t) => `h(${t})`,
    now: () => 1_700_000_000_000,
    demoPhone: '',
    demoPhones: '',
  };
}

const call = (deps: CreatePhoneVerificationDeps, phone: string, login: boolean) =>
  handleCreatePhoneVerification(
    new Request('https://x.test/create-phone-verification', {
      method: 'POST',
      headers: { Authorization: 'Bearer anon-jwt', 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone, login }),
    }),
    deps,
  );

const shape = async (res: Response) => {
  const body = await res.json();
  return {
    status: res.status,
    keys: Object.keys(body).sort(),
    // normalise the only legitimately-varying value (the verification id)
    body: JSON.parse(JSON.stringify(body, (k, v) => (k === 'verificationId' ? '<uuid>' : v))),
    contentType: res.headers.get('content-type'),
  };
};

import * as fs from 'fs';
import * as path from 'path';

describe('create-phone-verification source: no registration lookup can creep back in', () => {
  const dir = path.join(__dirname, '../supabase/functions/create-phone-verification');
  const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  for (const f of ['handler.ts', 'index.ts']) {
    it(`${f} never returns PHONE_EXISTS / PHONE_NOT_FOUND and never queries profiles`, () => {
      const src = strip(fs.readFileSync(path.join(dir, f), 'utf8'));
      expect(src).not.toMatch(/PHONE_EXISTS|PHONE_NOT_FOUND/);
      expect(src).not.toMatch(/from\(\s*['"]profiles['"]\s*\)/);
    });
  }
});

describe('create-phone-verification does not reveal whether a number is registered', () => {
  const registered = new Set([REGISTERED]);

  it('SIGNUP with a registered number vs an unknown number: same status, same body shape', async () => {
    const a = await shape(await call(makeDeps({ registered }), REGISTERED, false));
    const b = await shape(await call(makeDeps({ registered }), UNKNOWN, false));
    expect(a).toEqual(b);
    expect(a.status).toBe(200);
    expect(a.keys).toEqual(['verificationId']);
  });

  it('LOGIN with a registered number vs an unknown number: same status, same body shape', async () => {
    const a = await shape(await call(makeDeps({ registered }), REGISTERED, true));
    const b = await shape(await call(makeDeps({ registered }), UNKNOWN, true));
    expect(a).toEqual(b);
    expect(a.keys).toEqual(['verificationId']);
  });

  it('no machine-readable existence marker appears in ANY of the four responses', async () => {
    for (const [phone, login] of [[REGISTERED, false], [UNKNOWN, false], [REGISTERED, true], [UNKNOWN, true]] as const) {
      const text = await (await call(makeDeps({ registered }), phone, login)).text();
      expect(text).not.toMatch(/PHONE_EXISTS|PHONE_NOT_FOUND/);
    }
  });

  it('the same side effects happen in every case (OTP sent + verification row written) — no early return', async () => {
    const logs: string[][] = [];
    for (const [phone, login] of [[REGISTERED, false], [UNKNOWN, false], [REGISTERED, true], [UNKNOWN, true]] as const) {
      const log: string[] = [];
      await call(makeDeps({ registered, log }), phone, login);
      logs.push(log);
    }
    for (const l of logs) {
      expect(l).toContain('send');
      expect(l).toContain('insert');
    }
    for (const l of logs.slice(1)) expect(l).toEqual(logs[0]);   // identical call sequence
  });

  it('response time does not depend on registration (every dependency call has the same simulated latency)', async () => {
    const latency = () => 15;
    const time = async (phone: string, login: boolean) => {
      const t0 = process.hrtime.bigint();
      await call(makeDeps({ registered, latencyMs: latency }), phone, login);
      return Number(process.hrtime.bigint() - t0) / 1e6;
    };
    const N = 6;
    const reg: number[] = []; const unk: number[] = [];
    for (let i = 0; i < N; i++) { reg.push(await time(REGISTERED, false)); unk.push(await time(UNKNOWN, false)); }
    const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
    // Within noise: well under one dependency round-trip apart (15 ms).
    expect(Math.abs(mean(reg) - mean(unk))).toBeLessThan(10);
  });

  it('rate limits are unchanged (per-phone 429, per-IP 429)', async () => {
    const d = makeDeps({ registered });
    d.countPhoneAttempts = async () => 5;
    expect((await call(d, UNKNOWN, false)).status).toBe(429);
    const d2 = makeDeps({ registered });
    d2.countIpAttempts = async () => 20;
    expect((await call(d2, REGISTERED, true)).status).toBe(429);
  });

  it('auth and input validation are unchanged', async () => {
    const noAuth = await handleCreatePhoneVerification(
      new Request('https://x.test', { method: 'POST', body: JSON.stringify({ phone: UNKNOWN }) }), makeDeps({ registered }));
    expect(noAuth.status).toBe(401);
    const noPhone = await call(makeDeps({ registered }), '', false);
    expect(noPhone.status).toBe(400);
  });

  it('the reviewer demo number still bypasses sending and gets the fixed code', async () => {
    const d = makeDeps({ registered });
    d.demoPhone = '+10000000000';
    let sent = false; d.sendOtp = async () => { sent = true; };
    let stored = '';
    d.insertVerification = async (r) => { stored = r.tokenHash; return '00000000-0000-4000-8000-000000000009'; };
    expect((await call(d, '+10000000000', true)).status).toBe(200);
    expect(sent).toBe(false);
    expect(stored).toBe('h(000000)');
  });
});

import { pickRestoreProfileId, isDemoPhone } from '../supabase/functions/_shared/phone';

describe('restore-phone-session profile resolution (where an unknown-number login is now refused)', () => {
  it('a number that owns a profile logs into it', () => {
    expect(pickRestoreProfileId({ profileByPhone: 'p1', profileByVerifUser: 'anon', isDemo: false })).toBe('p1');
  });
  it('an unknown number is refused — NOT logged into the caller\'s own empty anonymous profile', () => {
    expect(pickRestoreProfileId({ profileByPhone: null, profileByVerifUser: 'anon', isDemo: false })).toBeNull();
  });
  it('the reviewer demo number keeps the anonymous-profile fallback (it has no phone on file)', () => {
    expect(pickRestoreProfileId({ profileByPhone: null, profileByVerifUser: 'anon', isDemo: true })).toBe('anon');
  });
  it('isDemoPhone matches the single and list secrets, nothing else', () => {
    expect(isDemoPhone(' +1 ', '+1', '')).toBe(true);
    expect(isDemoPhone('+2', '', '+2, +3')).toBe(true);
    expect(isDemoPhone('+4', '+1', '+2,+3')).toBe(false);
    expect(isDemoPhone('+1', '', '')).toBe(false);
  });
});
