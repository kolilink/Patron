// Phase 9, Finding 5 — SECURITY DEFINER search_path. LOCAL TEST DB ONLY.
//
// A SECURITY DEFINER function with no pinned search_path resolves unqualified
// table names against the CALLER's search_path. Even `SET search_path = public`
// is not enough on its own: Postgres searches the caller's temporary schema
// (pg_temp) FIRST for relations unless pg_temp is named explicitly, so a caller
// who can create a temp table can shadow `market_posts`, `profiles`, ... inside
// the definer's body. The fix pins `public, pg_temp` (pg_temp LAST).
import { tryAs, seedUser, seedBusiness, user, ANON } from './pgrole';
import { assertLocalDb, q, withPg } from './pg';

beforeAll(() => assertLocalDb());

// The five SECURITY DEFINER functions from the audit + the non-definer ones the
// same migration pins (logic-identical).
const NAMED = [
  'create_boutique_room', 'create_market_comment', 'create_market_post', 'toggle_comment_like', 'toggle_post_like',
  'calculate_merchant_level', 'sync_community_level', 'generate_business_referral_code', 'set_business_referral_code',
  'generate_djomi_checkout_token', 'set_business_djomi_checkout_token', 'handle_comment_like', 'handle_market_comment',
  'handle_post_like', 'set_business_trial_ends_at', 'update_chat_message_edited_at', 'update_market_post_edited_at',
  'set_updated_at',
];
// receive_purchase_order(uuid,uuid,uuid) is the stale service_role-only overload (no pin before this change).
const SIGNATURES = ['receive_purchase_order(uuid,uuid,uuid)'];

describe('enumeration — no public function is left without a pinned search_path', () => {
  it('every function in schema public has a search_path in proconfig (none missed)', async () => {
    const rows = await q(`
      SELECT p.oid::regprocedure::text AS fn
      FROM pg_proc p
      WHERE p.pronamespace = 'public'::regnamespace AND p.prokind = 'f'
        AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e')
        AND NOT EXISTS (SELECT 1 FROM unnest(coalesce(p.proconfig, '{}')) c WHERE c LIKE 'search_path=%')
      ORDER BY 1`);
    expect(rows.map(r => r.fn)).toEqual([]);
  });

  it('the audited functions pin `public, pg_temp` (pg_temp LAST, so a temp table cannot shadow a real one)', async () => {
    const rows = await q(`
      SELECT p.oid::regprocedure::text AS fn, p.proconfig
      FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace
        AND (p.proname = ANY($1) OR p.oid::regprocedure::text = ANY($2))`, [NAMED, SIGNATURES]);
    expect(rows.length).toBeGreaterThanOrEqual(NAMED.length);
    for (const r of rows) {
      expect({ fn: r.fn, cfg: (r.proconfig as string[]).filter(c => c.startsWith('search_path=')) })
        .toEqual({ fn: r.fn, cfg: ['search_path=public, pg_temp'] });
    }
  });
});

describe('hijack attempts (temp-table shadowing) against the unprotected functions', () => {
  it('toggle_post_like: shadowing market_posts must NOT let an author like their own post', async () => {
    const author = await seedUser('author');
    const [{ id: postId }] = await withPg(async c => (await c.query(
      `INSERT INTO market_posts (author_id, author_name, title, content, category) VALUES ($1, 'A', 't', 'c', 'general') RETURNING id`, [author])).rows);

    let outcome: { ok?: boolean; error?: string } = {};
    try {
      await withPg(async (c) => {
        await c.query('BEGIN');
        try {
          // The attacker's shadow (created in the session's pg_temp before the role
          // switch, so this does not depend on the stack granting TEMP to authenticated).
          await c.query(`CREATE TEMP TABLE market_posts (id uuid, author_id uuid, likes_count int DEFAULT 0)`);
          await c.query(`INSERT INTO market_posts (id, author_id) VALUES ($1, NULL)`, [postId]);
          await c.query(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ role: 'authenticated', sub: author })]);
          await c.query('SET LOCAL ROLE authenticated');
          const res = await c.query(`SELECT toggle_post_like($1) AS liked`, [postId]);
          outcome = { ok: res.rows[0].liked === true };
          await c.query('COMMIT');   // keep the like row (if any) so the assertion below can see it
        } catch (e) { await c.query('ROLLBACK'); throw e; }
      });
    } catch (e: any) { outcome = { error: e.message }; }

    // After the fix the function reads the REAL market_posts, sees the caller
    // is the author, and refuses. (Before: the like is recorded.)
    expect(outcome.error).toMatch(/propre post/);
    const likes = await q(`SELECT 1 FROM post_likes WHERE post_id = $1 AND user_id = $2`, [postId, author]);
    expect(likes).toHaveLength(0);
  });
});

describe('legacy 4-arg create_market_post / create_market_comment (caller-supplied author_name)', () => {
  // migration_v44 "REVOKE ... FROM authenticated" never removed the PUBLIC /
  // anon grants, so the old signatures stayed callable and bypassed v207's
  // identity derivation, rate limits and first-post approval.
  it('are not callable by authenticated or anon', async () => {
    const u = await seedUser('poster');
    await seedBusiness(u); // administrateur => bypasses the community-level gate
    const post = await tryAs(user(u), `SELECT create_market_post('t', 'c', 'general', 'Faux Nom')`);
    expect(post.error).toMatchObject({ code: '42501' });
    const anonPost = await tryAs(ANON, `SELECT create_market_post('t', 'c', 'general', 'Faux Nom')`);
    expect(anonPost.error).toMatchObject({ code: '42501' });
    const cmt = await tryAs(user(u), `SELECT create_market_comment(gen_random_uuid(), NULL, 'c', 'Faux Nom')`);
    expect(cmt.error).toMatchObject({ code: '42501' });
  });

  it('the current 3-arg signatures are untouched and still callable', async () => {
    const acl = await q(`SELECT oid::regprocedure::text AS fn, has_function_privilege('authenticated', oid, 'EXECUTE') AS auth
                         FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname IN ('create_market_post','create_market_comment') AND pronargs = 3`);
    expect(acl.length).toBe(2);
    for (const r of acl) expect(r.auth).toBe(true);
  });
});
