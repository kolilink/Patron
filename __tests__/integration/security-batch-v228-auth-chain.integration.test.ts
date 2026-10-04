// migration_v228, Fix C — the auth chain. Real Postgres + GoTrue on the LOCAL
// TEST stack. Every refusal asserts the EXACT error and that nothing changed.
//
//   C2 upgrade_anonymous_user(): only for a caller with a completed phone
//      verification; the phone comes FROM that verification, never the client.
//   C3 profiles.phone: immutable from the client (UPDATE pinned, INSERT with a
//      phone denied); only server-side writers (service_role / definer) set it.
//
// The "end-to-end" block drives the REAL create-phone-verification /
// verify-phone-code / restore-phone-session edge functions (served locally with
// reserved TEST-ONLY demo numbers so no WhatsApp is sent) through signup AND
// login, and checks the JWT's is_anonymous claim flips. It needs
//     npm run test:functions:serve        (separate terminal)
// and runs only when E2E_FUNCTIONS=1 (set by `npm run test:integration:e2e`
// and by the full-suite script) so a plain run without the functions server
// skips it visibly instead of failing.
import { createClient } from '@supabase/supabase-js';
import { randomUUID } from 'crypto';
import { createTestUser, adminClient, anonClient, localSupabaseUrl, localAnonKey } from './helpers';
import { assertLocalDb, q } from './pg';

beforeAll(() => assertLocalDb());

const E2E = process.env.E2E_FUNCTIONS === '1';
const e2e = E2E ? describe : describe.skip;
const REFUSED = expect.objectContaining({ code: 'P0001', message: 'Accès refusé' });
const RLS = expect.objectContaining({ code: '42501', message: expect.stringContaining('row-level security') });

// Reserved TEST-ONLY numbers served as demo-bypass numbers by scripts/test-functions.env.
const REG_PHONE = '+15550000002';
const LOGIN_PHONE = '+15550000003';
const TEST_PHONES = [REG_PHONE, LOGIN_PHONE, '+15550000004', '+15550000005'];

const claims = (jwt: string) => JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString());

async function resetPhones() {
  await q(`UPDATE profiles SET phone = NULL WHERE phone = ANY($1)`, [TEST_PHONES]);
  await q(`DELETE FROM phone_verifications WHERE phone = ANY($1)`, [TEST_PHONES]);
}

/** A real GoTrue user flipped to is_anonymous = true (anonymous sign-in is disabled locally);
 *  its JWT then carries is_anonymous: true, exactly like the app's pre-OTP session. */
async function makeAnonymousUser() {
  const { client, userId } = await createTestUser('anon');
  await q(`UPDATE auth.users SET is_anonymous = true WHERE id = $1`, [userId]);
  const { data, error } = await client.auth.refreshSession();
  if (error) throw error;
  return { client, userId, jwt: data.session!.access_token };
}

const isAnon = async (id: string) => (await q(`SELECT is_anonymous FROM auth.users WHERE id = $1`, [id]))[0].is_anonymous as boolean;
const phoneOf = async (id: string) => (await q(`SELECT phone FROM profiles WHERE id = $1`, [id]))[0]?.phone as string | null;

async function addVerification(userId: string, phone: string, status: 'en_attente' | 'verifie') {
  await adminClient().from('phone_verifications').insert({
    user_id: userId, phone, token: 'x', status, expires_at: new Date(Date.now() + 600_000).toISOString(),
  });
}

describe('C2 — upgrade_anonymous_user() is gated on a completed phone verification', () => {
  it('the anon KEY (no session) is refused at the privilege layer', async () => {
    const r = await anonClient().rpc('upgrade_anonymous_user');
    expect(r.error).toEqual(expect.objectContaining({ code: '42501', message: expect.stringContaining('permission denied for function upgrade_anonymous_user') }));
  });

  it('a fresh anonymous user calling it directly → Accès refusé; flag and phone unchanged', async () => {
    const u = await makeAnonymousUser();
    const r = await u.client.rpc('upgrade_anonymous_user');
    expect(r.error).toEqual(REFUSED);
    expect(await isAnon(u.userId)).toBe(true);
    expect(await phoneOf(u.userId)).toBeFalsy();
  });

  it('a verification that is only en_attente (code not yet proven) is not enough', async () => {
    const u = await makeAnonymousUser();
    await addVerification(u.userId, '+15550001001', 'en_attente');
    const r = await u.client.rpc('upgrade_anonymous_user');
    expect(r.error).toEqual(REFUSED);
    expect(await isAnon(u.userId)).toBe(true);
    expect(await phoneOf(u.userId)).toBeFalsy();
  });

  it("someone else's verified verification does not count", async () => {
    const victim = await makeAnonymousUser();
    await addVerification(victim.userId, '+15550001002', 'verifie');
    const attacker = await makeAnonymousUser();
    const r = await attacker.client.rpc('upgrade_anonymous_user');
    expect(r.error).toEqual(REFUSED);
    expect(await isAnon(attacker.userId)).toBe(true);
    expect(await isAnon(victim.userId)).toBe(true); // victim untouched too
  });

  it('a verified number that already belongs to another account is refused (no duplicate-phone account)', async () => {
    const owner = await createTestUser('owner');
    await adminClient().from('profiles').update({ phone: '+15550001003' }).eq('id', owner.userId);
    const u = await makeAnonymousUser();
    await addVerification(u.userId, '+15550001003', 'verifie');
    const r = await u.client.rpc('upgrade_anonymous_user');
    expect(r.error).toEqual(REFUSED);
    expect(await isAnon(u.userId)).toBe(true);
    expect(await phoneOf(owner.userId)).toBe('+15550001003'); // the real owner is untouched
    expect(await phoneOf(u.userId)).toBeFalsy();
    await adminClient().from('profiles').update({ phone: null }).eq('id', owner.userId);
  });

  it('with a completed verification it succeeds: flag flips and the phone comes FROM the verification', async () => {
    const u = await makeAnonymousUser();
    expect(claims(u.jwt).is_anonymous).toBe(true);
    await addVerification(u.userId, '+15550001004', 'verifie');
    const r = await u.client.rpc('upgrade_anonymous_user');
    expect(r.error).toBeNull();
    expect(await isAnon(u.userId)).toBe(false);
    expect(await phoneOf(u.userId)).toBe('+15550001004');
    // JWT flips on refresh
    const { data } = await u.client.auth.refreshSession();
    expect(claims(data.session!.access_token).is_anonymous).toBe(false);
    await adminClient().from('profiles').update({ phone: null }).eq('id', u.userId);
  });

  it('is idempotent for an already-permanent user (no error, nothing changes)', async () => {
    const { client, userId } = await createTestUser('perm');
    const r = await client.rpc('upgrade_anonymous_user');
    expect(r.error).toBeNull();
    expect(await isAnon(userId)).toBe(false);
  });

  it('OLD-client compatibility: a client that still upserts its own phone is rejected, but the RPC still completes signup', async () => {
    const u = await makeAnonymousUser();
    await addVerification(u.userId, '+15550001005', 'verifie');
    const up = await u.client.from('profiles').upsert({ id: u.userId, name: '', email: '', phone: '+15559999999', language: 'fr' }, { onConflict: 'id', ignoreDuplicates: false });
    expect(up.error).toEqual(RLS);                    // the client-written phone is rejected...
    expect(await phoneOf(u.userId)).toBeFalsy();
    const r = await u.client.rpc('upgrade_anonymous_user');
    expect(r.error).toBeNull();                       // ...and the signup still completes
    expect(await phoneOf(u.userId)).toBe('+15550001005'); // with the VERIFIED number, not the forged one
    await adminClient().from('profiles').update({ phone: null }).eq('id', u.userId);
  });
});

describe('C3 — profiles.phone is immutable from the client', () => {
  it('direct UPDATE of phone is rejected and the phone is unchanged', async () => {
    const { client, userId } = await createTestUser('real');
    await adminClient().from('profiles').update({ phone: '+15550002001' }).eq('id', userId);
    const r = await client.from('profiles').update({ phone: '+15550002999' }).eq('id', userId).select();
    expect(r.error).toEqual(RLS);
    expect(await phoneOf(userId)).toBe('+15550002001');
    await adminClient().from('profiles').update({ phone: null }).eq('id', userId);
  });

  it('clearing the phone (NULL) is rejected too', async () => {
    const { client, userId } = await createTestUser('real');
    await adminClient().from('profiles').update({ phone: '+15550002002' }).eq('id', userId);
    const r = await client.from('profiles').update({ phone: null }).eq('id', userId).select();
    expect(r.error).toEqual(RLS);
    expect(await phoneOf(userId)).toBe('+15550002002');
    await adminClient().from('profiles').update({ phone: null }).eq('id', userId);
  });

  it('NAME and other profile edits still work, and leave the phone alone', async () => {
    const { client, userId } = await createTestUser('real');
    await adminClient().from('profiles').update({ phone: '+15550002003' }).eq('id', userId);
    const r = await client.from('profiles').update({ name: 'Aïssatou Diallo', notify_on_every_sale: false }).eq('id', userId).select('name, notify_on_every_sale, phone');
    expect(r.error).toBeNull();
    expect(r.data).toEqual([{ name: 'Aïssatou Diallo', notify_on_every_sale: false, phone: '+15550002003' }]);
    await adminClient().from('profiles').update({ phone: null }).eq('id', userId);
  });

  it("the app's own phone-less upserts keep working; an upsert that carries a phone is rejected", async () => {
    const { client, userId } = await createTestUser('real');
    const ok = await client.from('profiles').upsert({ id: userId, name: 'Nouveau nom', email: '', language: 'fr' }, { onConflict: 'id' });
    expect(ok.error).toBeNull();
    const bad = await client.from('profiles').upsert({ id: userId, name: 'x', email: '', phone: '+15550002004', language: 'fr' }, { onConflict: 'id' });
    expect(bad.error).toEqual(RLS);
    expect(await phoneOf(userId)).toBeFalsy();
  });

  it('a client may create its own profile row only WITHOUT a phone', async () => {
    const { client, userId } = await createTestUser('noprofile');
    await adminClient().from('profiles').delete().eq('id', userId); // no row, so INSERT is the real path
    const withPhone = await client.from('profiles').insert({ id: userId, name: 'x', email: '', phone: '+15550002005', language: 'fr' });
    expect(withPhone.error).toEqual(RLS);
    expect(await q(`SELECT 1 FROM profiles WHERE id = $1`, [userId])).toHaveLength(0);
    const without = await client.from('profiles').insert({ id: userId, name: 'x', email: '', language: 'fr' });
    expect(without.error).toBeNull();
    expect(await phoneOf(userId)).toBeFalsy();
  });

  it("a user cannot edit someone else's profile at all", async () => {
    const a = await createTestUser('a');
    const b = await createTestUser('b');
    const r = await b.client.from('profiles').update({ name: 'pwned' }).eq('id', a.userId).select();
    expect(r.data ?? []).toHaveLength(0);
    expect((await q(`SELECT name FROM profiles WHERE id = $1`, [a.userId]))[0].name).not.toBe('pwned');
  });

  it("profile_phone() (the policy's helper) can never leak another user's number", async () => {
    const a = await createTestUser('a');
    const b = await createTestUser('b');
    await adminClient().from('profiles').update({ phone: '+15550002010' }).eq('id', a.userId);
    const own = await a.client.rpc('profile_phone', { p_id: a.userId });
    expect([own.error, own.data]).toEqual([null, '+15550002010']);
    const other = await b.client.rpc('profile_phone', { p_id: a.userId });
    expect([other.error, other.data]).toEqual([null, null]);          // NULL, not the number
    const anon = await anonClient().rpc('profile_phone', { p_id: a.userId });
    expect(anon.error).toEqual(expect.objectContaining({ code: '42501' }));
    await adminClient().from('profiles').update({ phone: null }).eq('id', a.userId);
  });

  it('server-side writers are unaffected: service_role can set the phone', async () => {
    const { userId } = await createTestUser('svc');
    const r = await adminClient().from('profiles').update({ phone: '+15550002006' }).eq('id', userId);
    expect(r.error).toBeNull();
    expect(await phoneOf(userId)).toBe('+15550002006');
    await adminClient().from('profiles').update({ phone: null }).eq('id', userId);
  });
});

async function fn(name: string, body: any, jwt: string) {
  const res = await fetch(`${localSupabaseUrl()}/functions/v1/${name}`, {
    method: 'POST',
    headers: { apikey: localAnonKey(), Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, json, text };
}

e2e('end-to-end through the REAL edge functions (signup AND login)', () => {
  beforeEach(resetPhones);
  afterAll(resetPhones);

  it('SIGNUP: request code → wrong code refused → verify → reuse refused → upgrade → JWT flips; phone server-set and then immutable', async () => {
    const u = await makeAnonymousUser();
    expect(claims(u.jwt).is_anonymous).toBe(true);

    // 1. request code
    const created = await fn('create-phone-verification', { phone: REG_PHONE }, u.jwt);
    expect([created.status, typeof created.json?.verificationId]).toEqual([200, 'string']);
    const vid = created.json.verificationId as string;
    const row = (await q(`SELECT status, user_id, phone, token FROM phone_verifications WHERE id = $1`, [vid]))[0];
    expect([row.status, row.user_id, row.phone]).toEqual(['en_attente', u.userId, REG_PHONE]);
    expect(row.token).not.toBe('000000');             // only the hash is stored

    // 2. upgrading BEFORE the code is proven is refused
    expect((await u.client.rpc('upgrade_anonymous_user')).error).toEqual(REFUSED);
    expect(await isAnon(u.userId)).toBe(true);

    // 3. a wrong code is refused with the exact message and changes nothing
    const wrong = await fn('verify-phone-code', { phone: REG_PHONE, code: '123456', verificationId: vid }, u.jwt);
    expect([wrong.status, wrong.json?.error]).toEqual([400, 'Code incorrect. Vérifiez et réessayez.']);
    expect((await q(`SELECT status FROM phone_verifications WHERE id = $1`, [vid]))[0].status).toBe('en_attente');

    // 4. the right code verifies; replaying it is refused with the exact message
    const ok = await fn('verify-phone-code', { phone: REG_PHONE, code: '000000', verificationId: vid }, u.jwt);
    expect([ok.status, ok.json]).toEqual([200, { verified: true }]);
    const replay = await fn('verify-phone-code', { phone: REG_PHONE, code: '000000', verificationId: vid }, u.jwt);
    expect(replay.json?.error).toBe('Code déjà utilisé.');

    // 5. the client's signup step (profile upsert WITHOUT phone, then the RPC)
    const up = await u.client.from('profiles').upsert({ id: u.userId, name: '', email: '', language: 'fr' }, { onConflict: 'id', ignoreDuplicates: false });
    expect(up.error).toBeNull();
    const upgrade = await u.client.rpc('upgrade_anonymous_user');
    expect(upgrade.error).toBeNull();

    // 6. JWT flips, phone was set server-side from the verification
    const { data: refreshed } = await u.client.auth.refreshSession();
    expect(claims(refreshed.session!.access_token).is_anonymous).toBe(false);
    expect(await isAnon(u.userId)).toBe(false);
    expect(await phoneOf(u.userId)).toBe(REG_PHONE);

    // 7. the new account's phone is now immutable from the client, name edits still work
    const set = await u.client.from('profiles').update({ phone: '+15550003999' }).eq('id', u.userId).select();
    expect(set.error).toEqual(RLS);
    expect(await phoneOf(u.userId)).toBe(REG_PHONE);
    const name = await u.client.from('profiles').update({ name: 'Nouveau Commerçant' }).eq('id', u.userId).select('name');
    expect(name.data).toEqual([{ name: 'Nouveau Commerçant' }]);
  });

  it('LOGIN: existing account → request code (login) → verify → restore-phone-session → verifyOtp → the REAL user\'s session', async () => {
    const real = await createTestUser('returning');
    await adminClient().from('profiles').update({ phone: LOGIN_PHONE }).eq('id', real.userId);
    const u = await makeAnonymousUser();                      // the pre-login anonymous session

    const created = await fn('create-phone-verification', { phone: LOGIN_PHONE, login: true }, u.jwt);
    expect([created.status, typeof created.json?.verificationId]).toEqual([200, 'string']);
    const vid = created.json.verificationId as string;

    const ok = await fn('verify-phone-code', { phone: LOGIN_PHONE, code: '000000', verificationId: vid }, u.jwt);
    expect([ok.status, ok.json]).toEqual([200, { verified: true }]);

    const restored = await fn('restore-phone-session', { phone: LOGIN_PHONE, verificationId: vid }, u.jwt);
    expect([restored.status, typeof restored.json?.token_hash]).toEqual([200, 'string']);

    const fresh = createClient(localSupabaseUrl(), localAnonKey(), { auth: { autoRefreshToken: false, persistSession: false } });
    const { data, error } = await fresh.auth.verifyOtp({ token_hash: restored.json.token_hash, type: 'magiclink' });
    expect(error).toBeNull();
    expect(data.session!.user.id).toBe(real.userId);          // logged in as the REAL account
    expect(claims(data.session!.access_token).is_anonymous).toBe(false);
    expect(await phoneOf(real.userId)).toBe(LOGIN_PHONE);     // login never touches the phone

    // the anonymous session that requested the code gained nothing
    expect(await isAnon(u.userId)).toBe(true);
    expect((await u.client.rpc('upgrade_anonymous_user')).error).toEqual(REFUSED); // login verification ≠ right to mint a 2nd account
    expect(await phoneOf(u.userId)).toBeFalsy();
  });
});
