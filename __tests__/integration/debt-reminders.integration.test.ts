// Debt-aging reminder pipeline — LOCAL TEST DB ONLY (pg-role harness; no
// PostgREST, no Deno). Drives the REAL Postgres functions of
// db/migration_v237.sql and the REAL handler (send-debt-reminders/handler.ts),
// with the one thing that cannot run here — dispatch-notification's HTTP
// shell — replaced by a dispatcher that applies the same registry gate
// (unknown / built:false) and the same composePush() the real function uses
// to build every push a device receives. So "a notification was actually
// built and sent, not skipped" is asserted against the real registry copy,
// title, route and sanitized data, not against a stub that always says yes.
import { randomUUID } from 'crypto';
import { as, tryAs, seedUser, seedBusiness, seedMember, SERVICE, ANON, user } from './pgrole';
import { assertLocalDb, q } from './pg';
import { runDebtReminders, type Deps, type Digest, type DispatchRequest, type DispatchResult } from '@/supabase/functions/send-debt-reminders/handler';
import { EVENT_REGISTRY } from '@/supabase/functions/dispatch-notification/registry';
import { composePush, type ComposedPush } from '@/supabase/functions/dispatch-notification/compose';

beforeAll(() => assertLocalDb());

// Africa/Conakry is UTC+0 with no DST, so these ISO-Z instants are also the
// Conakry wall-clock times.
const DAY = '2026-10-06';
const at = (hhmm: string, day = DAY) => `${day}T${hhmm}:00Z`;
const shiftDay = (day: string, days: number) => {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

interface Seeded { admin: string; biz: string }
async function newBusiness(): Promise<Seeded> {
  const admin = await seedUser('debt-admin');
  const biz = await seedBusiness(admin, 'Boutique Mamadou Diallo');
  return { admin, biz };
}

async function newClient(biz: string, name: string): Promise<string> {
  const id = randomUUID();
  await q(`INSERT INTO clients (id, business_id, name) VALUES ($1,$2,$3)`, [id, biz, name]);
  return id;
}

/** An unpaid credit sale, `ageDays` old on the Conakry calendar of `DAY`. */
async function seedDebt(s: Seeded, ageDays: number, o: {
  clientId?: string; name?: string; status?: string; amount?: number; paid?: number; saleDay?: string;
} = {}): Promise<string> {
  const id = randomUUID();
  const amount = o.amount ?? 123456000;
  await q(
    `INSERT INTO sale_orders (id, business_id, seller_id, created_by, status, total_amount, discount_amount,
                              sale_date, is_credit, customer_name, client_id)
     VALUES ($1,$2,$3,$3,$4,$5,0,$6,true,$7,$8)`,
    [id, s.biz, s.admin, o.status ?? 'credit', amount, o.saleDay ?? shiftDay(DAY, -ageDays),
      o.name ?? 'Aminata Camara', o.clientId ?? null]);
  if (o.paid) {
    await q(`INSERT INTO payments (order_id, business_id, amount, method, date) VALUES ($1,$2,$3,'especes',CURRENT_DATE)`,
      [id, s.biz, o.paid]);
  }
  return id;
}

interface Run { pushes: { req: DispatchRequest; push: ComposedPush }[]; dispatchResults: DispatchResult[]; summary: Awaited<ReturnType<typeof runDebtReminders>> }

/** One cron tick at `nowIso`, restricted to `bizIds` so suites don't see each other's businesses. */
async function tick(nowIso: string, bizIds: string[], opts: { dispatchResponse?: (req: DispatchRequest) => DispatchResult; sessionTz?: string } = {}): Promise<Run> {
  const pushes: Run['pushes'] = [];
  const dispatchResults: DispatchResult[] = [];
  const deps: Deps = {
    nowIso,
    getDigests: async (n) => {
      const rows = await as(SERVICE, async (c) => {
        if (opts.sessionTz) await c.query(`SET LOCAL timezone = '${opts.sessionTz}'`);
        return (await c.query(
          `SELECT business_id, local_date::text AS local_date, count_7d, count_30d, single_client_id, recipient_user_ids, items
             FROM get_due_debt_reminder_digests($1)`, [n])).rows;
      });
      return (rows as Digest[]).filter(r => bizIds.includes(r.business_id));
    },
    confirm: async (d) => as(SERVICE, async (c) => (await c.query(
      `SELECT confirm_debt_reminder_digest($1,$2,$3::jsonb) AS ok`, [d.business_id, d.local_date, JSON.stringify(d.items)])).rows[0].ok, true),
    dispatch: async (req) => {
      let r: DispatchResult;
      if (opts.dispatchResponse) {
        r = opts.dispatchResponse(req);
      } else {
        // Same gate as dispatch-notification/index.ts: unregistered -> 400, built:false -> skipped.
        const def = EVENT_REGISTRY[req.event_type];
        if (!def) r = { ok: false, body: { error: 'event_type non enregistré' } };
        else if (!def.built) r = { ok: true, body: { skipped: 'not_built' } };
        else {
          const push = composePush(req.event_type, 'Boutique Mamadou Diallo', req.payload, req.business_id);
          pushes.push({ req, push });
          r = { ok: true, body: { sent: req.target_user_ids.length } };
        }
      }
      dispatchResults.push(r);
      return r;
    },
    sleep: async () => {},
  };
  return { pushes, dispatchResults, summary: await runDebtReminders(deps) };
}

const firedFor = (saleId: string) => q(`SELECT threshold_days FROM debt_reminder_fired WHERE sale_order_id = $1 ORDER BY 1`, [saleId]);

describe('debt-aging reminder pipeline', () => {
  it('a debt aged 8 days is built and sent (not skipped) and marked reminded', async () => {
    const s = await newBusiness();
    const debt = await seedDebt(s, 8);

    const run = await tick(at('08:15'), [s.biz]);

    expect(run.summary).toEqual({ due: 1, sent: 1, notSent: 0, failed: 0 });
    expect(run.dispatchResults[0].body).toEqual({ sent: 1 });
    expect(run.dispatchResults[0].body).not.toHaveProperty('skipped');
    expect(run.pushes).toHaveLength(1);
    expect(run.pushes[0].req.target_user_ids).toEqual([s.admin]);
    expect(run.pushes[0].push.body).toBe('Un crédit a une semaine.');
    expect(await firedFor(debt)).toEqual([{ threshold_days: 7 }]);
  });

  it('second run does not re-fire the same debt/threshold (same day, later hour, next day)', async () => {
    const s = await newBusiness();
    const debt = await seedDebt(s, 8);
    expect((await tick(at('08:15'), [s.biz])).pushes).toHaveLength(1);

    expect((await tick(at('08:15'), [s.biz])).pushes).toHaveLength(0);
    expect((await tick(at('14:00'), [s.biz])).pushes).toHaveLength(0);
    // Next day the debt is 9 days old — still the 7-day threshold, already fired, forever.
    expect((await tick(at('08:15', shiftDay(DAY, 1)), [s.biz])).pushes).toHaveLength(0);
    expect((await tick(at('08:15', shiftDay(DAY, 20)), [s.biz])).pushes).toHaveLength(0);
    expect(await firedFor(debt)).toEqual([{ threshold_days: 7 }]);
  });

  it('three debts crossing 7 days the same day roll into exactly ONE push with n = 3', async () => {
    const s = await newBusiness();
    await seedDebt(s, 8, { name: 'Fatou Bah' });
    await seedDebt(s, 7, { name: 'Ibrahima Sow' });
    await seedDebt(s, 12, { name: 'Kadiatou Barry' });

    const run = await tick(at('08:30'), [s.biz]);

    expect(run.summary.sent).toBe(1);
    expect(run.pushes).toHaveLength(1);
    expect(run.pushes[0].req.payload).toMatchObject({ count_7d: 3, count_30d: 0 });
    expect(run.pushes[0].push.body).toBe('3 crédits ont une semaine.');
  });

  it('at 03:00 Conakry nothing is sent; the debt stays queued and goes out at 08:00', async () => {
    const s = await newBusiness();
    const debt = await seedDebt(s, 8);

    for (const hhmm of ['03:00', '00:00', '06:59', '07:30', '07:59']) {
      const run = await tick(at(hhmm), [s.biz]);
      expect(run.pushes).toHaveLength(0);
      expect(run.dispatchResults).toHaveLength(0);
      expect(run.summary.due).toBe(0);
    }
    expect(await firedFor(debt)).toEqual([]); // queued, not consumed

    const run = await tick(at('08:00'), [s.biz]);
    expect(run.pushes).toHaveLength(1);
    expect(await firedFor(debt)).toEqual([{ threshold_days: 7 }]);
  });

  it('quiet hours 21:00+ send nothing either', async () => {
    const s = await newBusiness();
    await seedDebt(s, 8);
    expect((await tick(at('20:59'), [s.biz])).pushes).toHaveLength(1); // still allowed (retry safety net)
    const s2 = await newBusiness();
    await seedDebt(s2, 8);
    expect((await tick(at('21:00'), [s2.biz])).pushes).toHaveLength(0);
    expect((await tick(at('23:30'), [s2.biz])).pushes).toHaveLength(0);
  });

  it('the zone is Africa/Conakry, not the session/server zone', async () => {
    const s = await newBusiness();
    await seedDebt(s, 8);
    // 03:00Z is 03:00 in Conakry (UTC+0) but 16:00 in Auckland: a function that
    // read the session zone would wrongly deliver here.
    expect((await tick(at('03:00'), [s.biz], { sessionTz: 'Pacific/Auckland' })).pushes).toHaveLength(0);
    expect((await tick(at('03:00'), [s.biz], { sessionTz: 'America/Los_Angeles' })).pushes).toHaveLength(0);
    // And 08:15Z is delivered no matter what the session zone says.
    expect((await tick(at('08:15'), [s.biz], { sessionTz: 'Pacific/Auckland' })).pushes).toHaveLength(1);
  });

  it('debt age is a Conakry calendar-day difference (6 days: no; 7 days: yes)', async () => {
    const s = await newBusiness();
    await seedDebt(s, 6);
    expect((await tick(at('08:15'), [s.biz])).summary.due).toBe(0);
    await seedDebt(s, 7);
    expect((await tick(at('08:15'), [s.biz])).pushes).toHaveLength(1);
  });

  it('payload carries no debtor name and no amount anywhere in title / body / data / request', async () => {
    const s = await newBusiness();
    const clientId = await newClient(s.biz, 'Mamadou Diallo');
    await seedDebt(s, 8, { clientId, name: 'Mamadou Diallo', amount: 98765432100 });
    await seedDebt(s, 9, { clientId, name: 'Mamadou Diallo', amount: 55500000 });

    const run = await tick(at('08:15'), [s.biz]);
    expect(run.pushes).toHaveLength(1);
    const wire = JSON.stringify(run.pushes[0]); // request + composed title/subtitle/body/route/data
    for (const forbidden of ['Mamadou', 'Diallo', 'Aminata', 'Camara', '987654321', '555000', '9876543', 'GNF', 'XOF']) {
      expect(wire).not.toContain(forbidden);
    }
    const { req, push } = run.pushes[0];
    expect(Object.keys(req.payload).sort()).toEqual(['client_id', 'count_30d', 'count_7d']);
    expect(Object.keys(push.data).sort()).toEqual(['business_id', 'client_id', 'count_30d', 'count_7d', 'event_type', 'route'].sort());
    // Only counts are numeric payload; nothing money-shaped.
    expect(push.data.count_7d).toBe(2);
  });

  it('deep link: one client -> that client; several -> the "doivent" list', async () => {
    const one = await newBusiness();
    const c1 = await newClient(one.biz, 'Client Un');
    await seedDebt(one, 8, { clientId: c1 });
    await seedDebt(one, 10, { clientId: c1 });
    const r1 = await tick(at('08:15'), [one.biz]);
    expect(r1.pushes[0].push.route).toBe(`/(app)/clients/${c1}`);

    const many = await newBusiness();
    const a = await newClient(many.biz, 'Client A');
    const b = await newClient(many.biz, 'Client B');
    await seedDebt(many, 8, { clientId: a });
    await seedDebt(many, 8, { clientId: b });
    const r2 = await tick(at('08:15'), [many.biz]);
    expect(r2.pushes[0].push.route).toBe('/(app)/clients?filter=doivent');
    expect(r2.pushes[0].req.payload).not.toHaveProperty('client_id');
  });

  it('settings switch OFF: nothing fires and nothing is consumed; ON again: it fires', async () => {
    const s = await newBusiness();
    const debt = await seedDebt(s, 8);
    await q(`UPDATE profiles SET debt_reminders_enabled = false WHERE id = $1`, [s.admin]);

    for (const hhmm of ['08:05', '12:00', '20:00']) {
      const run = await tick(at(hhmm), [s.biz]);
      expect(run.pushes).toHaveLength(0);
      expect(run.dispatchResults).toHaveLength(0);
    }
    expect(await firedFor(debt)).toEqual([]);

    await q(`UPDATE profiles SET debt_reminders_enabled = true WHERE id = $1`, [s.admin]);
    expect((await tick(at('08:05', shiftDay(DAY, 1)), [s.biz])).pushes).toHaveLength(1);
  });

  it('only recipients with the switch on are targeted (admin + manager; vendeur never)', async () => {
    const s = await newBusiness();
    const manager = await seedUser('debt-manager');
    const optedOut = await seedUser('debt-manager-off');
    const vendeur = await seedUser('debt-vendeur');
    await seedMember(s.biz, manager, 'manager');
    await seedMember(s.biz, optedOut, 'manager');
    await seedMember(s.biz, vendeur, 'vendeur');
    await q(`UPDATE profiles SET debt_reminders_enabled = false WHERE id = $1`, [optedOut]);
    await seedDebt(s, 8);

    const run = await tick(at('08:15'), [s.biz]);
    expect([...run.pushes[0].req.target_user_ids].sort()).toEqual([s.admin, manager].sort());
  });

  it('30-day threshold: a debt aged 31 days fires the month copy once, never a backdated week copy', async () => {
    const s = await newBusiness();
    const debt = await seedDebt(s, 31);

    const run = await tick(at('08:15'), [s.biz]);
    expect(run.pushes).toHaveLength(1);
    expect(run.pushes[0].push.body).toBe('Un crédit a un mois.');
    expect(run.pushes[0].req.payload).toMatchObject({ count_7d: 0, count_30d: 1 });
    expect(await firedFor(debt)).toEqual([{ threshold_days: 30 }]);

    expect((await tick(at('08:15', shiftDay(DAY, 1)), [s.biz])).pushes).toHaveLength(0);
    expect((await tick(at('08:15', shiftDay(DAY, 60)), [s.biz])).pushes).toHaveLength(0);
  });

  it('a debt gets at most two pushes in its lifetime: week at 7 days, month at 30', async () => {
    const s = await newBusiness();
    const debt = await seedDebt(s, 0);
    const pushesAt = async (daysAfter: number) => (await tick(at('08:15', shiftDay(DAY, daysAfter)), [s.biz])).pushes;

    for (let d = 0; d < 7; d++) expect(await pushesAt(d)).toHaveLength(0);
    const week = await pushesAt(7);
    expect(week).toHaveLength(1);
    expect(week[0].push.body).toBe('Un crédit a une semaine.');
    for (let d = 8; d < 30; d += 3) expect(await pushesAt(d)).toHaveLength(0);
    const month = await pushesAt(30);
    expect(month).toHaveLength(1);
    expect(month[0].push.body).toBe('Un crédit a un mois.');
    for (const d of [31, 45, 90, 365]) expect(await pushesAt(d)).toHaveLength(0);
    expect(await firedFor(debt)).toEqual([{ threshold_days: 7 }, { threshold_days: 30 }]);
  });

  it('both thresholds the same day: one push, combined copy', async () => {
    const s = await newBusiness();
    await seedDebt(s, 8);
    await seedDebt(s, 31);
    await seedDebt(s, 40);

    const run = await tick(at('08:15'), [s.biz]);
    expect(run.pushes).toHaveLength(1);
    expect(run.pushes[0].push.body).toBe('Un crédit a une semaine, 2 crédits ont un mois.');
  });

  it('max ONE push per business per day: a later-arriving due debt waits for tomorrow', async () => {
    const s = await newBusiness();
    await seedDebt(s, 8);
    expect((await tick(at('08:15'), [s.biz])).pushes).toHaveLength(1);

    const late = await seedDebt(s, 9); // e.g. a backdated debt entered after the morning push
    expect((await tick(at('15:00'), [s.biz])).pushes).toHaveLength(0);
    expect(await firedFor(late)).toEqual([]);

    const next = await tick(at('08:15', shiftDay(DAY, 1)), [s.biz]);
    expect(next.pushes).toHaveLength(1);
    expect(next.pushes[0].push.body).toBe('Un crédit a une semaine.');
  });

  it('marks reminded ONLY when the dispatcher body confirms sent — never on skipped / sent:0 / non-2xx', async () => {
    const s = await newBusiness();
    const debt = await seedDebt(s, 8);
    const responses: DispatchResult[] = [
      { ok: true, body: { skipped: 'not_built' } },
      { ok: true, body: { sent: 0, skipped: 'cap' } },
      { ok: true, body: { sent: 0, skipped: 'quiet_hours' } },
      { ok: true, body: { sent: 0 } },
      { ok: true, body: null },
      { ok: false, body: { error: 'boom' } },
    ];
    for (const r of responses) {
      const run = await tick(at('08:15'), [s.biz], { dispatchResponse: () => r });
      expect(run.summary).toMatchObject({ due: 1, sent: 0, notSent: 1 });
      expect(await firedFor(debt)).toEqual([]);
    }
    // Still due; a real send now succeeds and marks.
    expect((await tick(at('08:15'), [s.biz])).pushes).toHaveLength(1);
    expect(await firedFor(debt)).toEqual([{ threshold_days: 7 }]);
  });

  it('with the registry entry flipped back to built:false the pipeline would consume nothing (regression guard)', async () => {
    const def = EVENT_REGISTRY.debt_aging_reminder;
    expect(def.built).toBe(true);
    const s = await newBusiness();
    const debt = await seedDebt(s, 8);
    def.built = false;
    try {
      const run = await tick(at('08:15'), [s.biz]);
      expect(run.dispatchResults[0].body).toEqual({ skipped: 'not_built' });
      expect(run.summary.sent).toBe(0);
      expect(await firedFor(debt)).toEqual([]);
    } finally {
      def.built = true;
    }
  });

  it('a throwing dispatch is isolated and leaves the debt due', async () => {
    const s = await newBusiness();
    const debt = await seedDebt(s, 8);
    const run = await tick(at('08:15'), [s.biz], { dispatchResponse: () => { throw new Error('rate limited'); } });
    expect(run.summary).toMatchObject({ due: 1, sent: 0, failed: 1 });
    expect(await firedFor(debt)).toEqual([]);
  });

  it('paid, cancelled, fully-paid-by-payments and young debts never qualify', async () => {
    const s = await newBusiness();
    await seedDebt(s, 40, { status: 'paye' });
    await seedDebt(s, 40, { status: 'annule' });
    await seedDebt(s, 40, { paid: 123456000 });   // credit status but nothing left to collect
    await seedDebt(s, 3);
    expect((await tick(at('08:15'), [s.biz])).summary.due).toBe(0);
  });

  it('a partially-paid debt still qualifies (balance remains)', async () => {
    const s = await newBusiness();
    await seedDebt(s, 8, { paid: 1000 });
    expect((await tick(at('08:15'), [s.biz])).pushes).toHaveLength(1);
  });

  it('honors the legacy v200/v202 sent_at columns as already-fired', async () => {
    const s = await newBusiness();
    const debt = await seedDebt(s, 8);
    await q(`UPDATE sale_orders SET debt_reminder_7d_sent_at = now() WHERE id = $1`, [debt]);
    expect((await tick(at('08:15'), [s.biz])).summary.due).toBe(0);
  });

  it('confirm_debt_reminder_digest is idempotent and refuses a second push for the same business/day', async () => {
    const s = await newBusiness();
    const d1 = await seedDebt(s, 8);
    const d2 = await seedDebt(s, 9);
    const call = (item: string) => as(SERVICE, async (c) => (await c.query(
      `SELECT confirm_debt_reminder_digest($1,$2,$3::jsonb) AS ok`,
      [s.biz, DAY, JSON.stringify([{ sale_order_id: item, threshold_days: 7 }])])).rows[0].ok, true);
    expect(await call(d1)).toBe(true);
    expect(await call(d1)).toBe(false);
    expect(await call(d2)).toBe(false); // same business, same day
    expect(await firedFor(d2)).toEqual([]);
  });

  it('confirm cannot mark another business\'s debts', async () => {
    const a = await newBusiness();
    const b = await newBusiness();
    const foreign = await seedDebt(b, 8);
    await as(SERVICE, c => c.query(`SELECT confirm_debt_reminder_digest($1,$2,$3::jsonb)`,
      [a.biz, DAY, JSON.stringify([{ sale_order_id: foreign, threshold_days: 7 }])]), true);
    expect(await firedFor(foreign)).toEqual([]);
  });
});

describe('exposure', () => {
  const DENIED = { code: '42501' };
  it('anon and authenticated cannot call the pipeline RPCs or read the tables', async () => {
    const u = await seedUser('debt-rando');
    for (const who of [ANON, user(u)]) {
      expect((await tryAs(who, `SELECT * FROM get_due_debt_reminder_digests()`)).error).toMatchObject(DENIED);
      expect((await tryAs(who, `SELECT confirm_debt_reminder_digest(gen_random_uuid(), CURRENT_DATE, '[]'::jsonb)`)).error).toMatchObject(DENIED);
      expect((await tryAs(who, `SELECT * FROM debt_reminder_fired`)).error).toMatchObject(DENIED);
      expect((await tryAs(who, `SELECT * FROM debt_reminder_days`)).error).toMatchObject(DENIED);
    }
  });

  it('the v202 per-debt functions are gone — one pipeline, not two', async () => {
    const rows = await q(`SELECT proname FROM pg_proc WHERE proname IN ('get_due_debt_reminders','mark_debt_reminder_sent','get_and_mark_debt_reminders')`);
    expect(rows).toEqual([]);
  });
});
