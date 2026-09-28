// Security audit 2026-09-27, checklist 1.15 (lost/stolen-phone session
// revocation). Exercises the real GoTrue `others`-scope sign-out — this
// can't be meaningfully unit-tested against a mocked supabase.auth, since
// the whole point is real server-side refresh-token invalidation.
import { createClient } from '@supabase/supabase-js';
import { randomUUID } from 'crypto';

const LOCAL_URL = process.env.TEST_SUPABASE_URL || 'http://127.0.0.1:54321';
const LOCAL_ANON_KEY = process.env.TEST_SUPABASE_ANON_KEY
  || 'sb_publishable_ACJWlzQHlZjBrEguHvfOxg_3BJgxAaH';
const LOCAL_SERVICE_KEY = process.env.TEST_SUPABASE_SERVICE_KEY
  || 'sb_secret_N7UND0UgjKTVK-Uodkm0Hg_xSvEMPvz';

describe('signOut({ scope: "others" }) — lost/stolen-phone revocation', () => {
  it("kills device B's refresh token while leaving device A's session alone", async () => {
    const email = `session-revoke-${randomUUID()}@test.local`;
    const password = 'Test1234!';

    const admin = createClient(LOCAL_URL, LOCAL_SERVICE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const { data: created, error: createErr } = await admin.auth.admin.createUser({
      email, password, email_confirm: true,
    });
    if (createErr || !created.user) throw createErr ?? new Error('createUser failed');

    // Two independent client instances signing in with the same credentials
    // — mirrors two real devices sharing one Patron account.
    const deviceA = createClient(LOCAL_URL, LOCAL_ANON_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
    const deviceB = createClient(LOCAL_URL, LOCAL_ANON_KEY, { auth: { autoRefreshToken: false, persistSession: false } });

    const { error: signInAErr } = await deviceA.auth.signInWithPassword({ email, password });
    if (signInAErr) throw signInAErr;
    const { error: signInBErr } = await deviceB.auth.signInWithPassword({ email, password });
    if (signInBErr) throw signInBErr;

    // Device A revokes every OTHER session — the exact call
    // stores/auth.ts's revokeOtherSessions() makes.
    const { error: revokeErr } = await deviceA.auth.signOut({ scope: 'others' });
    expect(revokeErr).toBeNull();

    // Device B's refresh token is now dead server-side — its next attempt
    // to actually use it (not just read the still-cached local session)
    // must fail.
    const { data: sessionB } = await deviceB.auth.getSession();
    const { error: refreshErr } = await deviceB.auth.refreshSession({
      refresh_token: sessionB.session!.refresh_token,
    });
    expect(refreshErr).not.toBeNull();

    // Device A was never touched — its own session is still fully live.
    const { data: userA, error: userAErr } = await deviceA.auth.getUser();
    expect(userAErr).toBeNull();
    expect(userA.user?.id).toBe(created.user.id);
  });
});
