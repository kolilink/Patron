// businesses.teams_enabled (migration_v227) — real Postgres, TEST DB only.
//
// Covers: column shape + default, new-business default OFF, the BACKFILL rule
// (re-running the migration's real UPDATE statement against fixtures), and the
// "give it back" flip proving the flag is visibility-only (no data touched,
// nothing restricted server-side). Client-side visibility is asserted through
// the same pure helper the screens use (src/utils/teamsFlag.ts).
import * as fs from 'fs';
import * as path from 'path';
import { Client } from 'pg';
import { randomUUID } from 'crypto';
import { createTestUser, createTestBusiness, addMember, adminClient } from './helpers';
import { teamSurfaces } from '../../src/utils/teamsFlag';
const { splitSqlStatements } = require('../../scripts/lib/split-sql');

const DB_URL = process.env.TEST_DATABASE_URL || 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';

// Hard guard: this suite re-runs UPDATE statements — never against anything
// that is not the local test database.
function assertLocal() {
  const host = new URL(DB_URL).hostname;
  if (host !== '127.0.0.1' && host !== 'localhost') {
    throw new Error(`Refusing to run: DB host "${host}" is not the local test database`);
  }
}

async function pg<T>(fn: (c: Client) => Promise<T>): Promise<T> {
  assertLocal();
  const c = new Client({ connectionString: DB_URL });
  await c.connect();
  try { return await fn(c); } finally { await c.end(); }
}

function backfillSql(): string {
  const file = fs.readFileSync(path.join(__dirname, '../../db/migration_v227.sql'), 'utf8');
  const stmts: string[] = splitSqlStatements(file);
  const upd = stmts.find(s => /^\s*(--[^\n]*\n\s*)*UPDATE\s+businesses/i.test(s));
  if (!upd) throw new Error('backfill UPDATE not found in migration_v227.sql');
  return upd;
}

const flagOf = async (id: string): Promise<boolean> => {
  const { data, error } = await adminClient().from('businesses').select('teams_enabled').eq('id', id).single();
  if (error) throw error;
  return (data as any).teams_enabled;
};

async function boutiqueRoomId(businessId: string): Promise<string> {
  const { data, error } = await adminClient().from('chat_rooms').select('id')
    .eq('business_id', businessId).eq('is_global', false).is('partnership_id', null).limit(1).single();
  if (error) throw error;
  return (data as any).id;
}

async function runBackfill() {
  await pg(c => c.query(backfillSql()));
}

describe('teams_enabled — column shape and default', () => {
  it('is boolean NOT NULL DEFAULT false', async () => {
    const r = await pg(c => c.query(
      `SELECT data_type, is_nullable, column_default FROM information_schema.columns
       WHERE table_schema='public' AND table_name='businesses' AND column_name='teams_enabled'`));
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].data_type).toBe('boolean');
    expect(r.rows[0].is_nullable).toBe('NO');
    expect(r.rows[0].column_default).toBe('false');
  });

  it('a new business is OFF → every team surface hidden', async () => {
    const { client: owner } = await createTestUser('owner');
    const businessId = await createTestBusiness(owner, 'Commerce Solo');
    expect(await flagOf(businessId)).toBe(false);

    // The client fetches the flag with the business record (select *).
    const { data: row } = await owner.from('businesses').select('*').eq('id', businessId).single();
    expect((row as any).teams_enabled).toBe(false);
    expect(teamSurfaces(row as any)).toEqual({
      equipeEntry: false, apportsEntry: false, maBoutiqueTab: false, roleBadges: false,
      defaultDiscussionsTab: 'marche',
    });
  });
});

describe('teams_enabled — backfill (the migration\'s real UPDATE, re-run on fixtures)', () => {
  it('2-member → true; apports-only → true; team-chat-only → true; solo → false', async () => {
    // solo: one member, nothing else
    const { client: soloC } = await createTestUser('solo');
    const solo = await createTestBusiness(soloC, 'Solo');

    // 2 members
    const { client: twoC } = await createTestUser('two');
    const two = await createTestBusiness(twoC, 'Deux Membres');
    const { userId: sellerId } = await createTestUser('vendeur');
    await addMember(two, sellerId, 'vendeur');

    // apports only (one injection, one member)
    const { client: apC } = await createTestUser('ap');
    const apports = await createTestBusiness(apC, 'Apports Seuls');
    const inj = await apC.rpc('record_injection', { p_business_id: apports, p_amount: 50000 });
    expect(inj.error).toBeNull();

    // Ma Boutique chat only (one message in the business's own room, one member)
    const { client: chatC, userId: chatUid } = await createTestUser('chat');
    const chat = await createTestBusiness(chatC, 'Chat Seul');
    const msg = await adminClient().from('chat_messages').insert({
      room_id: await boutiqueRoomId(chat), sender_id: chatUid, sender_name: 'Test', content: 'Bonjour équipe',
    });
    expect(msg.error).toBeNull();

    // negative: a message only in the GLOBAL room (Le Marché) must not count
    const { client: mC, userId: mUid } = await createTestUser('marche');
    const marcheOnly = await createTestBusiness(mC, 'Marché Seul');
    const { data: globalRoom } = await adminClient().from('chat_rooms').select('id').eq('is_global', true).limit(1).single();
    const mm = await adminClient().from('chat_messages').insert({
      room_id: (globalRoom as any).id, sender_id: mUid, sender_name: 'Test', content: 'Salut le marché',
    });
    expect(mm.error).toBeNull();

    // All five start OFF (new-business default).
    for (const id of [solo, two, apports, chat, marcheOnly]) expect(await flagOf(id)).toBe(false);

    await runBackfill();

    expect(await flagOf(two)).toBe(true);        // >1 member
    expect(await flagOf(apports)).toBe(true);    // any apports row
    expect(await flagOf(chat)).toBe(true);       // any Ma Boutique message
    expect(await flagOf(solo)).toBe(false);      // solo stays off
    expect(await flagOf(marcheOnly)).toBe(false); // Le Marché isn't team chat
  });

  it('is idempotent and never turns anything OFF', async () => {
    const { client: c } = await createTestUser('idem');
    const biz = await createTestBusiness(c, 'Idem');
    await adminClient().from('businesses').update({ teams_enabled: true }).eq('id', biz);
    await runBackfill();
    await runBackfill();
    expect(await flagOf(biz)).toBe(true); // explicitly-on stays on even with no team data
  });
});

describe('teams_enabled — "give it back" (flip false → true) is visibility-only', () => {
  it('data is fully intact and readable while OFF, and every surface reappears when flipped ON', async () => {
    const { client: owner, userId: ownerId } = await createTestUser('owner');
    const biz = await createTestBusiness(owner, 'Commerce Équipe');
    const { userId: sellerId } = await createTestUser('vendeur');
    await addMember(biz, sellerId, 'vendeur');
    const inj = await owner.rpc('record_injection', { p_business_id: biz, p_amount: 75000 });
    expect(inj.error).toBeNull();
    const msg = await adminClient().from('chat_messages').insert({
      room_id: await boutiqueRoomId(biz), sender_id: ownerId, sender_name: 'Test', content: 'Historique',
    });
    expect(msg.error).toBeNull();

    // Force OFF even though the business has team data.
    const off = await adminClient().from('businesses').update({ teams_enabled: false }).eq('id', biz);
    expect(off.error).toBeNull();

    const snapshot = async () => {
      const members = await owner.from('memberships').select('id', { count: 'exact', head: true }).eq('business_id', biz);
      const apports = await owner.from('capital_injections').select('id, amount').eq('business_id', biz);
      const chats = await adminClient().from('chat_messages').select('id, content').eq('room_id', await boutiqueRoomId(biz));
      return { members: members.count, apports: apports.data, chats: chats.data };
    };

    // OFF: UI hidden, but the server still serves everything — nothing deleted, nothing restricted.
    const { data: rowOff } = await owner.from('businesses').select('*').eq('id', biz).single();
    expect(teamSurfaces(rowOff as any, true)).toEqual({
      equipeEntry: false, apportsEntry: false, maBoutiqueTab: false, roleBadges: false, defaultDiscussionsTab: 'marche',
    });
    const before = await snapshot();
    expect(before.members).toBe(2);
    expect(before.apports).toEqual([expect.objectContaining({ amount: 75000 })]);
    expect(before.chats).toEqual([expect.objectContaining({ content: 'Historique' })]);

    // Flip ON ("give it back"): every surface reappears, data identical.
    const on = await adminClient().from('businesses').update({ teams_enabled: true }).eq('id', biz);
    expect(on.error).toBeNull();
    const { data: rowOn } = await owner.from('businesses').select('*').eq('id', biz).single();
    expect(teamSurfaces(rowOn as any, true)).toEqual({
      equipeEntry: true, apportsEntry: true, maBoutiqueTab: true, roleBadges: true, defaultDiscussionsTab: 'boutique',
    });
    expect(await snapshot()).toEqual(before); // byte-for-byte the same data

    // Flip back OFF and ON again — still intact (no hidden side effects either direction).
    await adminClient().from('businesses').update({ teams_enabled: false }).eq('id', biz);
    expect(await snapshot()).toEqual(before);
  });

  it('an undefined flag (old server / stale cache) shows everything', async () => {
    const { client: owner } = await createTestUser('owner');
    const biz = await createTestBusiness(owner, 'Old Server');
    const { data: row } = await owner.from('businesses').select('*').eq('id', biz).single();
    const { teams_enabled: _drop, ...legacyRow } = row as any; // what an old server would return
    expect('teams_enabled' in legacyRow).toBe(false);
    expect(teamSurfaces(legacyRow)).toEqual({
      equipeEntry: true, apportsEntry: true, maBoutiqueTab: true, roleBadges: true, defaultDiscussionsTab: 'boutique',
    });
  });
});
