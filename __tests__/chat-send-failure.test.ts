// One behaviour for every send: a message that does not go is never lost.
// The text/recording/photo stays in her hands, a failure with Réessayer shows
// above the composer, and Réessayer re-sends THE SAME message (same id), so a
// first attempt that actually landed is recognised instead of duplicated.

import fs from 'fs';
import path from 'path';

let insertImpl: (row: any) => Promise<{ data: any; error: any }>;
const inserted: any[] = [];

jest.mock('@/lib/supabase', () => ({
  supabase: {
    from: () => ({
      insert: (row: any) => {
        inserted.push(row);
        return { select: () => ({ single: () => insertImpl(row) }) };
      },
    }),
    storage: { from: () => ({ upload: async () => ({ error: null }), getPublicUrl: () => ({ data: { publicUrl: 'http://x/a.m4a' } }) }) },
    auth: { onAuthStateChange: jest.fn(() => ({ data: { subscription: { unsubscribe: jest.fn() } } })) },
  },
}));
jest.mock('@/lib/db', () => ({
  ...jest.requireActual('@/lib/db'),
  getKV: jest.fn().mockResolvedValue(null), setKV: jest.fn(), saveChatCache: jest.fn(), getChatCache: jest.fn().mockResolvedValue(null),
  getCacheTimestamp: jest.fn().mockResolvedValue(null),
}));
jest.mock('@/src/utils/notifications', () => ({ notifyEvent: jest.fn() }));
jest.mock('@/lib/chatImages', () => ({ uploadMessageImage: jest.fn().mockResolvedValue({ url: 'http://x/i.jpg', width: 10, height: 10 }) }));
jest.mock('expo-file-system/legacy', () => ({ readAsStringAsync: jest.fn().mockResolvedValue('AAAA'), EncodingType: { Base64: 'base64' } }), { virtual: true });

import { useChatStore } from '@/stores/chat';

const NETWORK_ERROR = { message: 'Failed to fetch', code: '', details: '', hint: '' };
const base = { roomId: 'room-1', senderId: 'u1', senderName: 'Fatou', content: 'Bonjour la boutique' };

beforeEach(() => {
  inserted.length = 0;
  useChatStore.setState({ messages: [], sending: false, error: null });
  insertImpl = async () => ({ data: null, error: NETWORK_ERROR });
});

describe('boutique chat text send', () => {
  it('network dies mid-send: ok:false, the bubble is removed, the store says so in the failure vocabulary', async () => {
    const r = await useChatStore.getState().sendMessage({ ...base, messageId: 'm-1' });
    expect(r.ok).toBe(false);
    expect(r.err).toBeTruthy();
    expect(useChatStore.getState().messages).toEqual([]);
    expect(useChatStore.getState().error).toBe("Le message n'a pas été envoyé.");
    expect(useChatStore.getState().sending).toBe(false);
  });

  it('Réessayer re-sends the same message: same id on both attempts, now it lands', async () => {
    await useChatStore.getState().sendMessage({ ...base, messageId: 'm-2' });
    insertImpl = async row => ({ data: { ...row, created_at: '2026-10-04T10:00:00Z' }, error: null });
    const r = await useChatStore.getState().sendMessage({ ...base, messageId: 'm-2' });
    expect(r.ok).toBe(true);
    expect(inserted.map(x => x.id)).toEqual(['m-2', 'm-2']);
    const msgs = useChatStore.getState().messages;
    expect(msgs).toHaveLength(1);
    expect(msgs[0].id).toBe('m-2');
  });

  it('the first attempt actually landed and only the answer was lost: the retry hits the primary key and counts as sent, once', async () => {
    insertImpl = async () => ({ data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint "chat_messages_pkey"' } });
    const r = await useChatStore.getState().sendMessage({ ...base, messageId: 'm-3' });
    expect(r.ok).toBe(true);
    const msgs = useChatStore.getState().messages;
    expect(msgs).toHaveLength(1);
    expect(msgs[0].id).toBe('m-3');
    expect(msgs[0].content).toBe('Bonjour la boutique');
  });

  it('without a messageId one is generated (the first attempt), and it is a real uuid-like id', async () => {
    insertImpl = async row => ({ data: row, error: null });
    await useChatStore.getState().sendMessage(base);
    expect(inserted[0].id).toEqual(expect.any(String));
    expect(inserted[0].id.length).toBeGreaterThan(10);
  });
});

describe('every send path keeps her work (source contract)', () => {
  const read = (rel: string) => fs.readFileSync(path.resolve(__dirname, '..', rel), 'utf8');

  it('discussions.tsx: boutique text is restored on failure, with a Réessayer — it used to be deleted', () => {
    const src = read('app/(app)/discussions.tsx');
    const send = src.slice(src.indexOf('const handleSend = async'), src.indexOf('const handlePickImage'));
    expect(send).toMatch(/if \(r\.ok\) \{ draftIdRef\.current = null; return; \}/);
    expect(send).toMatch(/setText\(cur => \(cur\.trim\(\) \? cur : trimmed\)\)/);
    expect(send).toMatch(/setSendFailure\(\{ reason: failureReason\(r\.err\), retry: attempt \}\)/);
    expect(send).toMatch(/messageId: id/);
    expect(src).toMatch(/action: \{ label: 'Réessayer', onPress: \(\) => \{ void sendFailure\.retry\(\); \} \}/);
  });

  it('discussions.tsx: voice and photo failures keep the recording / photo and retry the same message', () => {
    const src = read('app/(app)/discussions.tsx');
    expect(src).toMatch(/const messageId = generateId\(\);\s*const attempt = async \(\) => \{\s*setSendFailure\(null\);\s*const r = await sendVoiceMessage/);
    expect(src).toMatch(/const messageId = generateId\(\);\s*const attempt = async \(\) => \{\s*setSendFailure\(null\);\s*const r = await sendImageMessage/);
  });

  it('messages/[room_id].tsx (DM): same behaviour — text restored, same id on retry, voice and photo kept', () => {
    const src = read('app/(app)/messages/[room_id].tsx');
    expect(src).toMatch(/setText\(content\);\s*haptics\.error\(\);\s*setSendFailure\(/);
    expect(src).toMatch(/\.insert\(\{ id, room_id,/);
    expect(src).toMatch(/!== '23505'/);
    expect(src).toMatch(/voice message: the recording is kept; Réessayer re-sends the same message/);
    expect(src).toMatch(/image message: the photo is kept; Réessayer re-sends the same message/);
    expect(src).not.toMatch(/setSendError/);
  });

  it('support/index.tsx: text restored on a definite failure, photo kept, one FailureView with Réessayer', () => {
    const src = read('app/(app)/support/index.tsx');
    expect(src).toMatch(/setText\(cur => \(cur\.trim\(\) \? cur : trimmed\)\)/);
    expect(src).toMatch(/setSendFailure\(\{ reason: failureReason\(r\.err\)/);
    expect(src).toMatch(/label: 'Réessayer', onPress: sendFailure\.retry/);
  });

  it('no composer clears her text BEFORE a send that can fail without a restore path', () => {
    // The only setText('') calls left in send handlers are paired with a restore on failure.
    for (const rel of ['app/(app)/discussions.tsx', 'app/(app)/messages/[room_id].tsx', 'app/(app)/support/index.tsx', 'app/(app)/marche/[id].tsx']) {
      const src = read(rel);
      const clears = src.match(/setText\(''\)/g)?.length ?? 0;
      const restores = (src.match(/setText\((cur => \(cur\.trim\(\) \? cur : trimmed\)|content|trimmed)\)/g)?.length ?? 0);
      // cancelEdit() clears on purpose (discussions): it is not a send.
      expect(restores).toBeGreaterThanOrEqual(clears - (rel.includes('discussions') ? 1 : 0));
    }
  });
});
