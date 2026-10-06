// Phase 9, Finding 7 — adversarial re-verification on the LOCAL TEST stack.
// (pg-role harness; the real create-phone-verification handler runs against the
// real tables with a pg-backed dependency set.)
import { randomUUID } from 'crypto';
import { handleCreatePhoneVerification, CreatePhoneVerificationDeps } from '../../supabase/functions/create-phone-verification/handler';
import { bearerMatches } from '../../supabase/functions/_shared/webhook-auth';
import { as, tryAs, seedUser, seedBusiness, seedMember, seedProduct, seedSale, user, ANON, SERVICE } from './pgrole';
import { assertLocalDb, q, withPg } from './pg';

beforeAll(() => assertLocalDb());

/* ───────────────────────── A. phone enumeration ───────────────────────── */

function pgDeps(anonUserId: string): CreatePhoneVerificationDeps {
  return {
    getUser: async () => ({ id: anonUserId }),
    countPhoneAttempts: async (phone, since) => Number((await q(`SELECT count(*) AS n FROM phone_verification_attempts WHERE phone=$1 AND attempted_at > $2`, [phone, since]))[0].n),
    countIpAttempts: async (ip, since) => Number((await q(`SELECT count(*) AS n FROM ip_verification_attempts WHERE ip=$1 AND endpoint='phone' AND attempted_at > $2`, [ip, since]))[0].n),
    recordAttempts: async (phone, ip) => {
      await q(`INSERT INTO phone_verification_attempts (phone) VALUES ($1)`, [phone]);
      await q(`INSERT INTO ip_verification_attempts (ip, endpoint) VALUES ($1,'phone')`, [ip]);
    },
    purgeAttemptsBefore: async (iso) => { await q(`DELETE FROM phone_verification_attempts WHERE attempted_at < $1`, [iso]); },
    sendOtp: async () => { /* WhatsApp/Twilio stubbed */ },
    insertVerification: async (r) => (await q(
      `INSERT INTO phone_verifications (user_id, phone, token, status, expires_at) VALUES ($1,$2,$3,'en_attente',$4) RETURNING id`,
      [r.userId, r.phone, r.tokenHash, r.expiresAtIso]))[0].id,
    generateCode: () => '654321',
    hashToken: async (t) => `h(${t})`,
    now: () => Date.now(),
    demoPhone: '', demoPhones: '',
  };
}

describe('A. enumerating phones through the fixed endpoint', () => {
  const N = 20;
  const registeredPhones: string[] = [];
  const unknownPhones: string[] = [];

  beforeAll(async () => {
    for (let i = 0; i < N; i++) {
      const id = await seedUser(`reg${i}`);
      const phone = `+2246${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`;
      await q(`UPDATE profiles SET phone = $1 WHERE id = $2`, [phone, id]);
      registeredPhones.push(phone);
      unknownPhones.push(`+2246${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`);
    }
  });

  const hit = async (phone: string, login: boolean, anon: string) => {
    const t0 = process.hrtime.bigint();
    const res = await handleCreatePhoneVerification(new Request('https://x.test', {
      method: 'POST',
      headers: { Authorization: 'Bearer j', 'Content-Type': 'application/json', 'x-forwarded-for': `10.9.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` },
      body: JSON.stringify({ phone, login }),
    }), pgDeps(anon));
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    const body = await res.json();
    return { status: res.status, keys: Object.keys(body).sort().join(','), ms, body };
  };

  it('registered vs unknown: identical status + body shape in signup AND login mode, and a verification row is written either way', async () => {
    const anon = await seedUser('enum-anon', { anonymous: true });
    const results: Record<string, { status: number; keys: string; ms: number; body: any }[]> = { regSignup: [], unkSignup: [], regLogin: [], unkLogin: [] };
    for (let i = 0; i < N; i++) {
      results.regSignup.push(await hit(registeredPhones[i], false, anon));
      results.unkSignup.push(await hit(unknownPhones[i], false, anon));
      results.regLogin.push(await hit(registeredPhones[i], true, anon));
      results.unkLogin.push(await hit(unknownPhones[i], true, anon));
    }
    const sig = (r: { status: number; keys: string }) => `${r.status}|${r.keys}`;
    const all = Object.values(results).flat();
    expect(new Set(all.map(sig))).toEqual(new Set(['200|verificationId']));
    expect(JSON.stringify(all.map(r => r.body))).not.toMatch(/PHONE_EXISTS|PHONE_NOT_FOUND/);

    const rows = await q(`SELECT phone FROM phone_verifications WHERE user_id = $1`, [anon]);
    const stored = new Set(rows.map(r => r.phone));
    for (const p of [...registeredPhones, ...unknownPhones]) expect(stored.has(p)).toBe(true);

    // timing: the two populations are indistinguishable at this resolution
    const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
    const sd = (xs: number[]) => { const m = mean(xs); return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1)); };
    for (const [a, b] of [[results.regSignup, results.unkSignup], [results.regLogin, results.unkLogin]]) {
      const ma = mean(a.map(r => r.ms)), mb = mean(b.map(r => r.ms));
      const noise = Math.max(sd(a.map(r => r.ms)), sd(b.map(r => r.ms)));
      // difference of means within 2 standard deviations of the per-request noise (5 ms absolute floor)
      expect(Math.abs(ma - mb)).toBeLessThan(Math.max(2 * noise, 5));
    }
  });

  it('what is still revealed, and only to someone who holds the number: a verified signup on a taken number is refused', async () => {
    const owner = await seedUser('owner');
    const phone = `+2246${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`;
    await q(`UPDATE profiles SET phone = $1 WHERE id = $2`, [phone, owner]);
    const attacker = await seedUser('att', { anonymous: true });
    // The attacker never proves possession -> upgrade is refused with the same generic message either way
    expect((await tryAs(user(attacker), `SELECT upgrade_anonymous_user()`)).error).toMatchObject({ code: 'P0001', message: 'Accès refusé' });
    // Even WITH a completed verification of the taken number the duplicate is refused (login ≠ right to mint an account)
    await q(`INSERT INTO phone_verifications (user_id, phone, token, status, expires_at) VALUES ($1,$2,'x','verifie', now() + interval '10 min')`, [attacker, phone]);
    expect((await tryAs(user(attacker), `SELECT upgrade_anonymous_user()`)).error).toMatchObject({ code: 'P0001', message: 'Accès refusé' });
  });
});

/* ──────────── B. report / unchecked RPCs as anon, vendeur, non-member ──────────── */

describe('B. probing every report RPC + *_unchecked twin as every unauthorized identity', () => {
  it('nobody unauthorized gets data (matrix)', async () => {
    const admin = await seedUser('adm'); const biz = await seedBusiness(admin);
    const vendeur = await seedUser('ven'); await seedMember(biz, vendeur, 'vendeur');
    const outsider = await seedUser('out'); await seedBusiness(outsider);
    const prod = await seedProduct(biz, admin); await seedSale(biz, admin, prod, 3, 100000);
    const today = new Date().toISOString().slice(0, 10); const month = today.slice(0, 8) + '01';

    const calls: [string, string, any[]][] = [
      ['get_best_sellers_unchecked', 'SELECT * FROM get_best_sellers_unchecked($1,$2,5)', [biz, month]],
      ['get_order_cogs_unchecked',   'SELECT * FROM get_order_cogs_unchecked($1,$2)', [biz, month]],
      ['get_financial_snapshot',     'SELECT * FROM get_financial_snapshot()', []],
      ['get_order_cogs',             'SELECT * FROM get_order_cogs($1,$2)', [biz, month]],
      ['get_reports_snapshot',       `SELECT get_reports_snapshot($1,30,'administrateur',NULL,$2)`, [biz, today]],
      ['get_period_report',          `SELECT get_period_report($1,$2,$3,'administrateur',NULL)`, [biz, month, today]],
      ['get_product_stats',          'SELECT get_product_stats($1,$2,NULL)', [prod, biz]],
    ];
    const verdicts: string[] = [];
    for (const [name, sql, params] of calls) {
      for (const [who, ident] of [['anon', ANON], ['outsider', user(outsider)], ['vendeur', user(vendeur)]] as const) {
        const r = await tryAs(ident, sql, params);
        const leaked = !r.error && (r.rows ?? []).length > 0;
        // vendeur may legitimately call the two own-scope/zero-field report RPCs; assert on content instead of refusal
        if (who === 'vendeur' && (name === 'get_reports_snapshot' || name === 'get_period_report')) {
          expect(r.error).toBeUndefined();
          const d = Object.values(r.rows![0])[0] as any;
          expect(d.role).toBe('vendeur');
          expect(Number(d.revenue ?? 0) + Number(d.cash_on_hand ?? 0) + Number(d.sales_count ?? 0)).toBe(0);
          verdicts.push(`${name} as vendeur: personal-only`);
          continue;
        }
        expect({ name, who, leaked }).toEqual({ name, who, leaked: false });
        verdicts.push(`${name} as ${who}: ${r.error ? (r.error.code ?? 'error') : 'empty'}`);
      }
      // service_role (reconciliation / cron) still works for the service-only ones
    }
    expect(verdicts.length).toBeGreaterThan(15);
    const svc = await tryAs(SERVICE, 'SELECT * FROM get_best_sellers_unchecked($1,$2,5)', [biz, month]);
    expect(svc.error).toBeUndefined();
  });
});

/* ───────────── C. search_path hijack on the five SECURITY DEFINER functions ───────────── */

describe('C. search_path hijack (temp-table shadowing) on the five audited functions', () => {
  // Each attack returns true when the attacker's shadow table changed the function's behaviour.
  // setup() creates the attacker's shadow table in the session's pg_temp BEFORE the role
  // switch (so the test does not depend on a particular stack granting TEMP to
  // `authenticated`; any role that can CREATE TEMP TABLE is the attacker). act() then
  // calls the victim function as `authenticated` and reports whether it was fooled.
  type Attack = { name: string; sig: string; setup: (c: any, ctx: any) => Promise<void>; act: (c: any, ctx: any) => Promise<boolean> };

  const attacks: Attack[] = [
    {
      name: 'toggle_post_like — author likes own post via shadow market_posts',
      sig: 'toggle_post_like(uuid)',
      setup: async (c, ctx) => {
        await c.query(`CREATE TEMP TABLE market_posts (id uuid, author_id uuid, likes_count int DEFAULT 0)`);
        await c.query(`INSERT INTO market_posts (id, author_id) VALUES ($1, NULL)`, [ctx.ownPost]);
      },
      act: async (c, ctx) => {
        try { await c.query(`SELECT toggle_post_like($1)`, [ctx.ownPost]); return true; } catch { return false; }
      },
    },
    {
      name: 'toggle_comment_like — author likes own comment via shadow market_comments',
      sig: 'toggle_comment_like(uuid)',
      setup: async (c, ctx) => {
        await c.query(`CREATE TEMP TABLE market_comments (id uuid, author_id uuid, likes_count int DEFAULT 0)`);
        await c.query(`INSERT INTO market_comments (id, author_id) VALUES ($1, NULL)`, [ctx.ownComment]);
      },
      act: async (c, ctx) => {
        try { await c.query(`SELECT toggle_comment_like($1)`, [ctx.ownComment]); return true; } catch { return false; }
      },
    },
    {
      name: 'create_market_post — level-1 user posts by shadowing profiles.community_level',
      sig: 'create_market_post(text,text,text)',
      setup: async (c, ctx) => {
        await c.query(`CREATE TEMP TABLE profiles (id uuid, community_level int, created_at timestamptz, pseudo text, name text)`);
        await c.query(`INSERT INTO profiles VALUES ($1, 99, now() - interval '30 days', 'Pirate', 'Pirate')`, [ctx.attacker]);
      },
      act: async (c, ctx) => {
        try { await c.query(`SELECT create_market_post('t','c','general')`); return true; } catch { return false; }
      },
    },
    {
      name: 'create_market_comment — impersonate another author via shadow profiles.pseudo',
      sig: 'create_market_comment(uuid,uuid,text)',
      setup: async (c, ctx) => {
        await c.query(`CREATE TEMP TABLE profiles (id uuid, pseudo text, name text)`);
        await c.query(`INSERT INTO profiles VALUES ($1, 'Faux Admin', 'Faux Admin')`, [ctx.attacker]);
      },
      act: async (c, ctx) => {
        try {
          const r = await c.query(`SELECT create_market_comment($1, NULL, 'salut') AS id`, [ctx.targetPost]);
          const real = await c.query(`SELECT author_name FROM public.market_comments WHERE id = $1`, [r.rows[0].id]);
          return real.rows[0]?.author_name === 'Faux Admin';
        } catch { return false; }
      },
    },
    {
      name: 'create_boutique_room — a new business ends up with no real "Ma Boutique" room (shadow chat_rooms)',
      sig: 'create_boutique_room()',
      setup: async (c) => {
        await c.query(`CREATE TEMP TABLE chat_rooms (name text, business_id uuid, is_global boolean)`);
      },
      act: async (c) => {
        const bid = randomUUID();
        await c.query(`SELECT create_business_with_membership($1,'Shadowed','commerce','GNF',NULL)`, [bid]);
        const real = await c.query(`SELECT 1 FROM public.chat_rooms WHERE business_id = $1`, [bid]);
        return real.rowCount === 0;
      },
    },
  ];

  let ctx: any;
  beforeAll(async () => {
    const author = await seedUser('mk-author');
    const attacker = await seedUser('mk-attacker');
    await q(`UPDATE profiles SET name = 'Vrai Nom', pseudo = 'Vrai Nom' WHERE id = $1`, [attacker]);
    await q(`UPDATE profiles SET name = 'Auteur', pseudo = 'Auteur' WHERE id = $1`, [author]);
    const ownPost = (await q(`INSERT INTO market_posts (author_id, author_name, title, content, category) VALUES ($1,'Vrai Nom','t','c','general') RETURNING id`, [attacker]))[0].id;
    const targetPost = (await q(`INSERT INTO market_posts (author_id, author_name, title, content, category) VALUES ($1,'Auteur','t','c','general') RETURNING id`, [author]))[0].id;
    const ownComment = (await q(`INSERT INTO market_comments (post_id, author_id, author_name, content) VALUES ($1,$2,'Vrai Nom','c') RETURNING id`, [targetPost, attacker]))[0].id;
    ctx = { attacker, ownPost, targetPost, ownComment };
  });

  const runAttack = (a: Attack, unpin: boolean) => withPg(async (c) => {
    await c.query('BEGIN');
    try {
      if (unpin) await c.query(`ALTER FUNCTION public.${a.sig} RESET search_path`);
      await a.setup(c, ctx);
      await c.query(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ role: 'authenticated', sub: ctx.attacker })]);
      await c.query('SET LOCAL ROLE authenticated');
      return await a.act(c, ctx);
    } finally { await c.query('ROLLBACK'); }
  });

  for (const a of attacks) {
    it(`${a.name}: the attack WORKS against an unpinned copy (test has teeth) and FAILS against the migrated function`, async () => {
      expect(await runAttack(a, true)).toBe(true);
      expect(await runAttack(a, false)).toBe(false);
    });
  }
});

/* ───────────────────── D. forged webhook credentials ───────────────────── */

describe('D. forged RevenueCat credentials fail closed', () => {
  const secret = 'rc_live_secret_value';
  it.each([
    ['no header', null], ['empty header', ''], ['wrong secret', 'Bearer nope'], ['secret without scheme', secret],
    ['prefix of the secret', `Bearer ${secret.slice(0, -1)}`], ['secret + suffix', `Bearer ${secret}x`],
    ['lower-case scheme', `bearer ${secret}`], ['double space', `Bearer  ${secret}`],
  ])('%s -> rejected', (_n, header) => {
    expect(bearerMatches(header as string | null, secret)).toBe(false);
  });
  it('unset secret rejects even the header an attacker would send for an empty secret', () => {
    expect(bearerMatches('Bearer ', undefined)).toBe(false);
    expect(bearerMatches('Bearer undefined', undefined)).toBe(false);
  });
});
