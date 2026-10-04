// migration_v228, Fix D — RLS WITH CHECK gaps. Real Postgres, LOCAL TEST DB ONLY.
// Every rejection asserts the exact RLS error AND that the row is unchanged.
import { randomUUID } from 'crypto';
import { createTestUser, createTestBusiness, addMember, adminClient } from './helpers';
import { assertLocalDb, q, becomeFounder, resignFounder } from './pg';

beforeAll(() => assertLocalDb());

const RLS = expect.objectContaining({ code: '42501', message: expect.stringContaining('row-level security') });

describe('D1 — market_posts: an author edits title/content only', () => {
  async function post() {
    const author = await createTestUser('author');
    const { data, error } = await adminClient().from('market_posts').insert({
      author_id: author.userId, author_name: 'Auteur', title: 'Titre', content: 'Contenu',
      category: 'general', status: 'pending', is_pinned: false,
    }).select('id').single();
    if (error) throw error;
    return { author, id: (data as any).id as string };
  }
  const row = async (id: string) => (await q(`SELECT title, content, category, status, is_pinned, likes_count, comments_count, author_name FROM market_posts WHERE id = $1`, [id]))[0];

  it('title/content edits still work (and nothing else moves)', async () => {
    const { author, id } = await post();
    const r = await author.client.from('market_posts').update({ title: 'Nouveau titre', content: 'Nouveau contenu' }).eq('id', id).select('title, content, status');
    expect(r.error).toBeNull();
    expect(r.data).toEqual([{ title: 'Nouveau titre', content: 'Nouveau contenu', status: 'pending' }]);
  });

  it.each([
    ['status (self-approve a pending post)', { status: 'approved' }, 'status', 'pending'],
    ['category', { category: 'annonce' }, 'category', 'general'],
    ['is_pinned (pin your own post)', { is_pinned: true }, 'is_pinned', false],
    ['likes_count (inflate)', { likes_count: 999 }, 'likes_count', 0],
    ['comments_count', { comments_count: 999 }, 'comments_count', 0],
    ['author_name (impersonate)', { author_name: 'Le Fondateur' }, 'author_name', 'Auteur'],
  ])('rejects changing %s → exact RLS error, row unchanged', async (_label, patch, col, original) => {
    const { author, id } = await post();
    const before = await row(id);
    const r = await author.client.from('market_posts').update(patch).eq('id', id).select();
    expect(r.error).toEqual(RLS);
    expect(await row(id)).toEqual(before);
    expect((await row(id))[col]).toEqual(original);
  });

  it('a title edit smuggling status in the SAME statement is rejected as a whole (title not applied either)', async () => {
    const { author, id } = await post();
    const r = await author.client.from('market_posts').update({ title: 'Sneaky', status: 'approved' }).eq('id', id).select();
    expect(r.error).toEqual(RLS);
    expect((await row(id)).title).toBe('Titre');
  });

  it("another user cannot edit someone else's post at all", async () => {
    const { id } = await post();
    const other = await createTestUser('other');
    const r = await other.client.from('market_posts').update({ title: 'pwned' }).eq('id', id).select();
    expect(r.data ?? []).toHaveLength(0);
    expect((await row(id)).title).toBe('Titre');
  });

  it('moderation / counters are untouched: the founder pin RPC and the like RPC still work', async () => {
    const { id } = await post();
    const founder = await createTestUser('founder');
    await becomeFounder(founder.userId);
    const pin = await founder.client.rpc('pin_market_post', { p_post_id: id, p_pinned: true });
    expect([pin.error, pin.data]).toEqual([null, true]);
    expect((await row(id)).is_pinned).toBe(true);

    await adminClient().from('market_posts').update({ status: 'approved' }).eq('id', id); // service-side approval
    const liker = await createTestUser('liker');
    await adminClient().from('profiles').update({ points: 100, community_level: 3 }).eq('id', liker.userId);
    const like = await liker.client.rpc('toggle_post_like', { p_post_id: id });
    expect(like.error).toBeNull();
    expect((await row(id)).likes_count).toBe(1);
    await resignFounder(founder.userId);
  });
});

describe('D2 — chat_messages: a sender edits content only', () => {
  async function msg() {
    const owner = await createTestUser('owner');
    const biz = await createTestBusiness(owner.client, 'Chat');
    const room = (await q(`SELECT id FROM chat_rooms WHERE business_id = $1 AND is_global = false AND partnership_id IS NULL LIMIT 1`, [biz]))[0].id as string;
    const other = await createTestUser('other');
    const otherBiz = await createTestBusiness(other.client, 'Autre');
    const otherRoom = (await q(`SELECT id FROM chat_rooms WHERE business_id = $1 AND is_global = false AND partnership_id IS NULL LIMIT 1`, [otherBiz]))[0].id as string;
    const id = randomUUID();
    const ins = await owner.client.from('chat_messages').insert({ id, room_id: room, sender_id: owner.userId, sender_name: 'Moi', content: 'Salut' });
    expect(ins.error).toBeNull();
    return { owner, other, id, room, otherRoom };
  }
  const row = async (id: string) => (await q(`SELECT room_id, sender_id, sender_name, content, edited_at FROM chat_messages WHERE id = $1`, [id]))[0];

  it('editing content still works (and the edit stamp is set)', async () => {
    const { owner, id } = await msg();
    const r = await owner.client.from('chat_messages').update({ content: 'Salut, corrigé' }).eq('id', id).select('content');
    expect(r.error).toBeNull();
    expect(r.data).toEqual([{ content: 'Salut, corrigé' }]);
    expect((await row(id)).edited_at).not.toBeNull();
  });

  it('moving a message into ANOTHER business\'s room is rejected; the message stays put', async () => {
    const { owner, id, room, otherRoom } = await msg();
    const r = await owner.client.from('chat_messages').update({ room_id: otherRoom }).eq('id', id).select();
    expect(r.error).toEqual(RLS);
    expect((await row(id)).room_id).toBe(room);
  });

  it('changing sender_id / sender_name (impersonation) is rejected too', async () => {
    const { owner, other, id } = await msg();
    const r1 = await owner.client.from('chat_messages').update({ sender_id: other.userId }).eq('id', id).select();
    expect(r1.error).toEqual(RLS);
    const r2 = await owner.client.from('chat_messages').update({ sender_name: 'Quelqu\'un d\'autre' }).eq('id', id).select();
    expect(r2.error).toEqual(RLS);
    const after = await row(id);
    expect([after.sender_id, after.sender_name]).toEqual([owner.userId, 'Moi']);
  });

  it("chat_message_identity() (the policy's helper) returns only the caller's OWN messages' identity", async () => {
    const { owner, other, id } = await msg();
    const own = await owner.client.rpc('chat_message_identity', { p_id: id });
    expect(own.error).toBeNull();
    expect(own.data).toEqual(expect.objectContaining({ sender_id: owner.userId }));
    const foreign = await other.client.rpc('chat_message_identity', { p_id: id });
    expect([foreign.error, foreign.data]).toEqual([null, null]);
  });

  it("another user cannot edit someone else's message", async () => {
    const { other, id } = await msg();
    const r = await other.client.from('chat_messages').update({ content: 'pwned' }).eq('id', id).select();
    expect(r.data ?? []).toHaveLength(0);
    expect((await row(id)).content).toBe('Salut');
  });
});

describe('D3 — so_lines mirrors sale_orders visibility (vendeur isolation)', () => {
  async function world() {
    const admin = await createTestUser('admin');
    const biz = await createTestBusiness(admin.client, 'Commerce');
    const v1 = await createTestUser('vendeur1');
    const v2 = await createTestUser('vendeur2');
    const mgr = await createTestUser('manager');
    await addMember(biz, v1.userId, 'vendeur');
    await addMember(biz, v2.userId, 'vendeur');
    await addMember(biz, mgr.userId, 'manager');
    const sale = async (u: typeof v1, price: number) => {
      const r = await u.client.rpc('submit_quick_sale', { p_business_id: biz, p_seller_id: u.userId, p_unit_price: price });
      if (r.error) throw r.error;
      return r.data as string;
    };
    const o1 = await sale(v1, 100000);
    const o2 = await sale(v2, 200000);
    const lines = async (orderId: string) => (await q(`SELECT id, unit_price, qty FROM so_lines WHERE order_id = $1 ORDER BY id`, [orderId]));
    return { admin, biz, v1, v2, mgr, o1, o2, lines };
  }

  it('a vendeur sees ONLY the lines of their own sales', async () => {
    const w = await world();
    const mine = await w.v1.client.from('so_lines').select('order_id');
    expect(mine.error).toBeNull();
    expect([...new Set((mine.data ?? []).map((r: any) => r.order_id))]).toEqual([w.o1]);
    const theirs = await w.v1.client.from('so_lines').select('id').eq('order_id', w.o2);
    expect(theirs.data ?? []).toHaveLength(0);
  });

  it('admin and manager still see every line (same as sale_orders)', async () => {
    const w = await world();
    for (const u of [w.admin, w.mgr]) {
      const r = await u.client.from('so_lines').select('order_id').in('order_id', [w.o1, w.o2]);
      expect(r.error).toBeNull();
      expect([...new Set((r.data ?? []).map((x: any) => x.order_id))].sort()).toEqual([w.o1, w.o2].sort());
    }
  });

  it("a vendeur cannot modify or delete another seller's lines (rows unchanged)", async () => {
    const w = await world();
    const before = await w.lines(w.o2);
    expect(before.length).toBeGreaterThan(0);
    const upd = await w.v1.client.from('so_lines').update({ unit_price: 1 }).eq('order_id', w.o2).select();
    expect(upd.data ?? []).toHaveLength(0);
    const del = await w.v1.client.from('so_lines').delete().eq('order_id', w.o2).select();
    expect(del.data ?? []).toHaveLength(0);
    expect(await w.lines(w.o2)).toEqual(before);
  });

  it('the sale-detail read path is unharmed: a vendeur reads their own sale together with its lines', async () => {
    const w = await world();
    const r = await w.v1.client.from('sale_orders').select('id, so_lines(id, qty, unit_price)').eq('id', w.o1).single();
    expect(r.error).toBeNull();
    expect((r.data as any).so_lines.length).toBeGreaterThan(0);
  });

  it('a non-member sees no lines at all', async () => {
    const w = await world();
    const stranger = await createTestUser('stranger');
    const r = await stranger.client.from('so_lines').select('id').in('order_id', [w.o1, w.o2]);
    expect(r.data ?? []).toHaveLength(0);
  });
});
