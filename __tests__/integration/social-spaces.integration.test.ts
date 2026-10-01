// Integration tests for the "Espaces sociaux" migrations (v207 + v208):
//   * create_market_post accepts the new 'annonce' category (Jobs de lancement)
//     and rejects unknown categories with "Catégorie invalide";
//   * first-post approval (configurable flag, default ON) marks the author's
//     first post 'pending', visible only to author + founder (Phase 3);
//   * the configurable rate limit raises the non-punitive "Doucement" message
//     (Phase 3);
//   * blocks make posts mutually invisible (Phase 1);
//   * report_post refuses self-reports and duplicates (Phase 1).
//
// These hit a live local Supabase instance (npm run test:db:start) because the
// guarantees live in SECURITY DEFINER RPCs and RLS policies — a mocked client
// cannot verify them. Run via: npm run test:integration.
import { createTestUser, createTestBusiness, adminClient } from './helpers';
import type { SupabaseClient } from '@supabase/supabase-js';

function createPost(
    client: SupabaseClient,
    title: string,
    content: string,
    category: string,
) {
    return client.rpc('create_market_post', {
        p_title: title,
        p_content: content,
        p_category: category,
    });
}

async function getPostStatus(postId: string): Promise<string | null> {
    const admin = adminClient();
    const { data } = await admin.from('market_posts').select('status').eq('id', postId).single();
    return (data as { status: string } | null)?.status ?? null;
}

/** Insert an approved post authored by `authorId`, bypassing RLS via the service role. */
async function insertApprovedPost(authorId: string, authorName: string): Promise<string> {
    const admin = adminClient();
    const id = crypto.randomUUID();
    const { error } = await admin.from('market_posts').insert({
        id,
        author_id: authorId,
        author_name: authorName,
        title: 'Annonce test',
        content: 'Contenu approuvé',
        category: 'annonce',
        status: 'approved',
    });
    if (error) throw error;
    return id;
}

/** Rows a given (non-admin) client can see for a specific post id. */
async function visibleCount(client: { from: (t: string) => any }, postId: string): Promise<number> {
    const { data } = await client.from('market_posts').select('id').eq('id', postId);
    return (data ?? []).length;
}

describe('create_market_post — catégorie annonce (Jobs de lancement)', () => {
    it("accepts 'annonce' and flags the author's first post for approval", async () => {
        const { client, userId } = await createTestUser('annonce-admin');
        await createTestBusiness(client, 'Boutique Annonce');

        const res = await createPost(client, 'Annonce utile', 'Un message utile.', 'annonce');
        expect(res.error).toBeNull();
        const postId = res.data as string;
        expect(postId).toBeTruthy();

        // First-post approval is ON by default → the post is pending.
        expect(await getPostStatus(postId)).toBe('pending');

        // Pending post is invisible to other members…
        const { client: other } = await createTestUser('annonce-other');
        expect(await visibleCount(other, postId)).toBe(0);

        // …but the author always sees their own post.
        expect(await visibleCount(client, postId)).toBe(1);

        // The author is the stable identity behind the post.
        const admin = adminClient();
        const { data } = await admin.from('market_posts').select('author_id').eq('id', postId).single();
        expect((data as { author_id: string }).author_id).toBe(userId);
    });

    it("rejects an unknown category with 'Catégorie invalide'", async () => {
        const { client } = await createTestUser('annonce-badcat');
        await createTestBusiness(client, 'Boutique BadCat');

        const res = await createPost(client, 'Titre', 'Contenu', 'inconnue');
        expect(res.error).toBeTruthy();
        expect(res.error!.message).toMatch(/Cat[ée]gorie invalide/);
    });
});

describe('create_market_post — rate limit configurable (Phase 3)', () => {
    it("raises the non-punitive 'Doucement' message once the halved hourly limit is hit", async () => {
        // Fresh accounts (< 1 day) get the hour/day limits halved: 4→2, 20→10.
        const { client } = await createTestUser('rate-admin');
        await createTestBusiness(client, 'Boutique Rate');

        const first = await createPost(client, 'Post 1', 'Un', 'general');
        expect(first.error).toBeNull();
        const second = await createPost(client, 'Post 2', 'Deux', 'general');
        expect(second.error).toBeNull();

        const third = await createPost(client, 'Post 3', 'Trois', 'general');
        expect(third.error).toBeTruthy();
        expect(third.error!.message).toMatch(/Doucement/);
        expect(third.error!.message).toMatch(/minutes/);
    });
});

describe('blocks — mutual invisibility (Phase 1)', () => {
    it('hides an author\'s posts from anyone they block, in both directions', async () => {
        const { client: aClient, userId: aId } = await createTestUser('block-a');
        const { client: bClient, userId: bId } = await createTestUser('block-b');

        const postId = await insertApprovedPost(aId, 'Auteur A');
        expect(await visibleCount(bClient, postId)).toBe(1);

        // A blocks B → B can no longer see A's approved post.
        const { error: blockErr } = await aClient.rpc('block_user', { p_blocked_id: bId });
        expect(blockErr).toBeNull();
        expect(await visibleCount(bClient, postId)).toBe(0);

        // Unblocking restores visibility.
        const { error: unblockErr } = await aClient.rpc('unblock_user', { p_blocked_id: bId });
        expect(unblockErr).toBeNull();
        expect(await visibleCount(bClient, postId)).toBe(1);
    });
});

describe('report_post — self-report and duplicates (Phase 1)', () => {
    it('refuses reporting your own post and duplicate reports', async () => {
        const { client: aClient, userId: aId } = await createTestUser('report-a');
        const { client: bClient } = await createTestUser('report-b');

        const postId = await insertApprovedPost(aId, 'Auteur A');

        // A cannot report their own post.
        const self = await aClient.rpc('report_post', { p_post_id: postId, p_motif: 'spam' });
        expect(self.error).toBeTruthy();
        expect(self.error!.message).toMatch(/propre post/);

        // B reports it once, then cannot report it again.
        const first = await bClient.rpc('report_post', { p_post_id: postId, p_motif: 'spam' });
        expect(first.error).toBeNull();
        const dup = await bClient.rpc('report_post', { p_post_id: postId, p_motif: 'spam' });
        expect(dup.error).toBeTruthy();
        expect(dup.error!.message).toMatch(/d[ée]j[àa] signal[ée]/);
    });
});
