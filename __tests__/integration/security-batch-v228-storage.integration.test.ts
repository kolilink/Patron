// migration_v228, Fix B — storage object policies. Real Supabase Storage on the
// LOCAL TEST stack. Two users in two businesses:
//   B must not read, delete, overwrite or upload into A's objects (proofs, chat
//   images, support images, voice notes), and every "denied" assertion also
//   proves A's object is byte-for-byte unchanged afterwards.
//
// (All three buckets are public, so a public-URL GET bypasses RLS by design;
// these tests cover the authenticated API surface the policies actually gate.)
import { randomUUID } from 'crypto';
import { createHash } from 'crypto';
import { createTestUser, createTestBusiness, anonClient, adminClient } from './helpers';
import { assertLocalDb, q, becomeFounder, resignFounder } from './pg';

beforeAll(() => assertLocalDb());

const RLS = /row-level security|Unauthorized/i;

const bytes = (tag: string) => Buffer.from(`${tag}-${randomUUID()}`);
const md5 = (b: Buffer | Uint8Array) => createHash('md5').update(b).digest('hex');

async function world() {
  const { client: a, userId: aId } = await createTestUser('ownerA');
  const bizA = await createTestBusiness(a, 'Commerce A');
  const { client: b, userId: bId } = await createTestUser('ownerB');
  const bizB = await createTestBusiness(b, 'Commerce B');
  const room = async (biz: string) =>
    (await q(`SELECT id FROM chat_rooms WHERE business_id = $1 AND is_global = false AND partnership_id IS NULL LIMIT 1`, [biz]))[0].id as string;
  const { data: conv, error } = await adminClient().from('support_conversations')
    .insert({ business_id: bizA, merchant_user_id: aId }).select('id').single();
  if (error) throw error;
  return { a, aId, bizA, b, bId, bizB, roomA: await room(bizA), roomB: await room(bizB), convA: (conv as any).id as string };
}

async function put(client: any, bucket: string, p: string, body: Buffer) {
  return client.storage.from(bucket).upload(p, body, { contentType: 'application/octet-stream', upsert: false });
}
async function fetchBytes(client: any, bucket: string, p: string): Promise<Buffer | null> {
  const { data, error } = await client.storage.from(bucket).download(p);
  if (error || !data) return null;
  return Buffer.from(await data.arrayBuffer());
}

/** Common cross-business matrix for one bucket/path layout. */
async function expectIsolated(
  w: Awaited<ReturnType<typeof world>>, bucket: string, ownPath: string, foreignFolderPath: (id: string) => string,
  opts: { hasDelete: boolean },
) {
  const original = bytes('original');
  const up = await put(w.a, bucket, ownPath, original);
  expect(up.error).toBeNull();                                     // owner can upload
  expect(md5((await fetchBytes(w.a, bucket, ownPath))!)).toBe(md5(original)); // ...and read
  const folder = ownPath.split('/').slice(0, -1).join('/');
  const leaf = ownPath.split('/').pop()!;
  const listed = async (c: any) => ((await c.storage.from(bucket).list(folder)).data ?? []).map((o: any) => o.name);
  expect(await listed(w.a)).toContain(leaf);                       // A sees it in the read surface

  // B: the READ surface (list/info under the SELECT policy) shows nothing of A's
  expect(await listed(w.b)).toEqual([]);
  // B: cannot upload into A's folder
  const intruder = await put(w.b, bucket, foreignFolderPath(randomUUID()), bytes('intruder'));
  expect(intruder.error?.message).toMatch(RLS);
  // B: cannot overwrite A's object (upsert)
  const over = await w.b.storage.from(bucket).upload(ownPath, bytes('overwrite'), { contentType: 'application/octet-stream', upsert: true });
  expect(over.error).not.toBeNull();
  // B: cannot delete A's object — RLS hides it, so nothing is removed
  const rm = await w.b.storage.from(bucket).remove([ownPath]);
  expect(rm.data ?? []).toHaveLength(0);
  // anon key: nothing in the read surface
  expect(await listed(anonClient())).toEqual([]);
  const anonUp = await put(anonClient(), bucket, foreignFolderPath(randomUUID()), bytes('anon'));
  expect(anonUp.error).not.toBeNull();

  // A's object is byte-for-byte unchanged after every attempt.
  expect(md5((await fetchBytes(w.a, bucket, ownPath))!)).toBe(md5(original));

  if (opts.hasDelete) {
    const own = await w.a.storage.from(bucket).remove([ownPath]);
    expect(own.error).toBeNull();
    expect(own.data).toHaveLength(1);                              // the owner CAN delete their own
  }
}

describe('transaction-proofs  ({kind}/{business_id}/{id}.jpg)', () => {
  it('isolated per business: B cannot read / overwrite / upload / delete; A can read & upload', async () => {
    const w = await world();
    await expectIsolated(w, 'transaction-proofs', `apport/${w.bizA}/${randomUUID()}.jpg`, id => `apport/${w.bizA}/${id}.jpg`, { hasDelete: false });
  });

  it('B can use their OWN business folder (positive control) and a malformed folder is simply denied', async () => {
    const w = await world();
    const mine = await put(w.b, 'transaction-proofs', `expense/${w.bizB}/${randomUUID()}.jpg`, bytes('mine'));
    expect(mine.error).toBeNull();
    const bad = await put(w.b, 'transaction-proofs', `expense/not-a-uuid/${randomUUID()}.jpg`, bytes('bad'));
    expect(bad.error?.message).toMatch(RLS); // a clean denial, not a uuid-cast crash
  });

  it('there is still NO delete path for proofs (add-once is preserved): even the owner cannot remove', async () => {
    const w = await world();
    const p = `purchase_order/${w.bizA}/${randomUUID()}.jpg`;
    const original = bytes('keep');
    expect((await put(w.a, 'transaction-proofs', p, original)).error).toBeNull();
    const rm = await w.a.storage.from('transaction-proofs').remove([p]);
    expect(rm.data ?? []).toHaveLength(0);
    expect(md5((await fetchBytes(w.a, 'transaction-proofs', p))!)).toBe(md5(original));
  });
});

describe('message-images — chat/{room_id}/…', () => {
  it('isolated per business room: B cannot read / overwrite / upload / delete; A can read, upload, delete', async () => {
    const w = await world();
    await expectIsolated(w, 'message-images', `chat/${w.roomA}/${randomUUID()}.jpg`, id => `chat/${w.roomA}/${id}.jpg`, { hasDelete: true });
  });

  it('a global (Le Marché) room has no business owner: image objects there are denied for everyone', async () => {
    const w = await world();
    const globalRoom = (await q(`SELECT id FROM chat_rooms WHERE is_global = true LIMIT 1`))[0].id;
    const r = await put(w.a, 'message-images', `chat/${globalRoom}/${randomUUID()}.jpg`, bytes('marche'));
    expect(r.error?.message).toMatch(RLS);
  });

  it('B can use their own room (positive control)', async () => {
    const w = await world();
    expect((await put(w.b, 'message-images', `chat/${w.roomB}/${randomUUID()}.jpg`, bytes('mine'))).error).toBeNull();
  });
});

describe('message-images — support/{conversation_id | business_id}/…', () => {
  it('merchant A: both path variants work; B is denied on both; A\'s object is unchanged', async () => {
    const w = await world();
    for (const folder of [w.convA, w.bizA]) {
      await expectIsolated(w, 'message-images', `support/${folder}/${randomUUID()}.jpg`, id => `support/${folder}/${id}.jpg`, { hasDelete: true });
    }
  });

  it('the founder (profile phone) can read and upload support images across businesses', async () => {
    const w = await world();
    const { client: founder, userId: fId } = await createTestUser('founder');
    await becomeFounder(fId);
    const original = bytes('support');
    const p = `support/${w.convA}/${randomUUID()}.jpg`;
    expect((await put(w.a, 'message-images', p, original)).error).toBeNull();
    expect(md5((await fetchBytes(founder, 'message-images', p))!)).toBe(md5(original));
    expect((await put(founder, 'message-images', `support/${w.convA}/${randomUUID()}.jpg`, bytes('reply'))).error).toBeNull();
    await resignFounder(fId); // leave no founder behind
  });
});

describe('voice-messages — {uploader business_id}/{id}.m4a', () => {
  it('B cannot upload into A\'s folder or delete A\'s voice note; A can upload and delete their own', async () => {
    const w = await world();
    const p = `${w.bizA}/${randomUUID()}.m4a`;
    const original = bytes('voice');
    expect((await put(w.a, 'voice-messages', p, original)).error).toBeNull();

    const intruder = await put(w.b, 'voice-messages', `${w.bizA}/${randomUUID()}.m4a`, bytes('intruder'));
    expect(intruder.error?.message).toMatch(RLS);

    const rm = await w.b.storage.from('voice-messages').remove([p]);
    expect(rm.data ?? []).toHaveLength(0);
    // Still there (public bucket: playback is by URL, which these policies never gate).
    const { data: pub } = w.a.storage.from('voice-messages').getPublicUrl(p);
    const res = await fetch(pub.publicUrl);
    expect(res.status).toBe(200);
    expect(md5(Buffer.from(await res.arrayBuffer()))).toBe(md5(original));

    // positive controls
    expect((await put(w.b, 'voice-messages', `${w.bizB}/${randomUUID()}.m4a`, bytes('mine'))).error).toBeNull();
    const own = await w.a.storage.from('voice-messages').remove([p]);
    expect(own.error).toBeNull();
    expect(own.data).toHaveLength(1);
  });

  it('anon key cannot upload', async () => {
    const w = await world();
    const r = await put(anonClient(), 'voice-messages', `${w.bizA}/${randomUUID()}.m4a`, bytes('anon'));
    expect(r.error).not.toBeNull();
  });
});

describe('KNOWN LIMITATION (documented, out of scope for v228): public-bucket downloads bypass RLS', () => {
  // Supabase Storage serves downloads from PUBLIC buckets without evaluating the
  // SELECT policy, on the public AND authenticated routes. So B (or anyone)
  // holding the exact object URL can still fetch A's bytes. The policies above
  // gate list / upload / overwrite / delete — not this. When the buckets are
  // made private (signed URLs), this test MUST flip to expect denial.
  it('B can still download A\'s object by exact path while the bucket is public', async () => {
    const w = await world();
    const p = `apport/${w.bizA}/${randomUUID()}.jpg`;
    const original = bytes('public-bucket');
    expect((await put(w.a, 'transaction-proofs', p, original)).error).toBeNull();
    const got = await fetchBytes(w.b, 'transaction-proofs', p);
    expect(got).not.toBeNull();
    expect(md5(got!)).toBe(md5(original));
    const buckets = await q(`SELECT id, public FROM storage.buckets WHERE id IN ('transaction-proofs','message-images','voice-messages') ORDER BY id`);
    expect(buckets.map((b: any) => b.public)).toEqual([true, true, true]); // the reason
  });
});

describe('the policies are the scoped ones (metadata)', () => {
  it('no storage.objects policy is the old auth.uid() IS NOT NULL-only check, and all are TO authenticated', async () => {
    const rows = await q(`SELECT policyname, roles::text AS roles, coalesce(qual,'') || ' ' || coalesce(with_check,'') AS expr
                          FROM pg_policies WHERE schemaname='storage' AND tablename='objects'
                          AND policyname ~ '^(transaction proofs|message images|voice)'`);
    expect(rows.map((r: any) => r.policyname).sort()).toEqual([
      'message images delete', 'message images read', 'message images upload',
      'transaction proofs read', 'transaction proofs upload',
      'voice delete', 'voice read', 'voice upload',
    ]);
    for (const r of rows) {
      expect([r.policyname, r.roles]).toEqual([r.policyname, '{authenticated}']);
      expect(r.expr).toMatch(/is_member|message_image_allowed/);
      expect(r.expr.replace(/\s+/g, ' ')).not.toMatch(/^\(?\(?bucket_id = '[a-z-]+'::text\)? AND \(?auth\.uid\(\) IS NOT NULL\)?\)? ?$/);
    }
  });
});
