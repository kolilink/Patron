// P1-4 — support drain: a drained support message must only be appended to the
// visible message list when its conversation_id still matches the conversation
// actually loaded on screen. A stale/other-conversation item was sent
// successfully (and must leave the queue), but appending it unconditionally
// polluted the wrong thread when the merchant had navigated away or switched
// business while offline.

const mockKv: Record<string, string> = {};

jest.mock('@/lib/db', () => ({
    getKV: jest.fn(async (key: string) => mockKv[key] ?? null),
    setKV: jest.fn(async (key: string, value: string) => { mockKv[key] = value; }),
}));

jest.mock('@/lib/supabase', () => ({
    supabase: {
        rpc: jest.fn(),
        from: jest.fn(),
        auth: {
            getSession: jest.fn().mockResolvedValue({ data: { session: null } }),
            onAuthStateChange: jest.fn(() => ({
                data: { subscription: { unsubscribe: jest.fn() } },
            })),
        },
        functions: { invoke: jest.fn().mockResolvedValue({}) },
    },
}));

import { useSupportChatStore } from '@/stores/supportChat';
import { supabase } from '@/lib/supabase';
import type { SupportConversation, SupportMessage } from '@/src/types';

const PENDING_KEY = 'support_pending_messages';

function makeSupportMessage(overrides: Partial<SupportMessage> = {}): SupportMessage {
    return {
        id: 'msg-1',
        conversation_id: 'conv-1',
        business_id: 'biz-1',
        sender_id: 'me',
        sender_role: 'merchant',
        sender_name: 'Nick',
        content: 'bonjour',
        used_ai_draft: false,
        created_at: '2026-01-01T00:00:00Z',
        ...overrides,
    };
}

function makeConversation(id: string): SupportConversation {
    return {
        id,
        business_id: 'biz-1',
        merchant_user_id: 'me',
        merchant_name: 'Nick',
        status: 'open',
        last_message_at: '2026-01-01T00:00:00Z',
        last_message_preview: null,
        founder_last_read_at: null,
        merchant_last_read_at: null,
        rating: null,
        rated_at: null,
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
    };
}

function seedQueue(items: Array<Record<string, unknown>>): void {
    mockKv[PENDING_KEY] = JSON.stringify(items);
}

const rpcMock = supabase.rpc as jest.Mock;

beforeEach(() => {
    Object.keys(mockKv).forEach(k => delete mockKv[k]);
    useSupportChatStore.setState({
        conversation: null,
        messages: [],
        loading: false,
        sending: false,
        error: null,
        offline: true,
    });
    jest.clearAllMocks();
});

describe('drainSupportQueue — conversation_id match', () => {
    it('appends a drained message when it belongs to the currently loaded conversation', async () => {
        useSupportChatStore.setState({ conversation: makeConversation('conv-1') });
        seedQueue([{ localId: 'local-1', businessId: 'biz-1', senderName: 'Nick', content: 'bonjour', createdAt: '2026-01-01T00:00:00Z' }]);
        rpcMock.mockResolvedValue({ data: makeSupportMessage({ conversation_id: 'conv-1' }), error: null });

        await useSupportChatStore.getState().drainSupportQueue();

        expect(useSupportChatStore.getState().messages.map(m => m.id)).toContain('msg-1');
        expect(useSupportChatStore.getState().offline).toBe(false);
        expect(mockKv[PENDING_KEY]).toBe('[]');
    });

    it('does NOT append a drained message whose conversation_id no longer matches the loaded conversation', async () => {
        // The merchant was on conv-1 when they wrote the message, but has since
        // navigated to conv-2 (or switched business). The item still drains.
        useSupportChatStore.setState({ conversation: makeConversation('conv-2') });
        seedQueue([{ localId: 'local-1', businessId: 'biz-1', senderName: 'Nick', content: 'bonjour', createdAt: '2026-01-01T00:00:00Z' }]);
        rpcMock.mockResolvedValue({ data: makeSupportMessage({ conversation_id: 'conv-1' }), error: null });

        await useSupportChatStore.getState().drainSupportQueue();

        expect(useSupportChatStore.getState().messages).toHaveLength(0);
        // Still sent successfully — the queue is cleared and the offline flag drops.
        expect(mockKv[PENDING_KEY]).toBe('[]');
        expect(useSupportChatStore.getState().offline).toBe(false);
    });

    it('appends nothing when the conversation is null (never loaded) but still drains the item', async () => {
        seedQueue([{ localId: 'local-1', businessId: 'biz-1', senderName: 'Nick', content: 'bonjour', createdAt: '2026-01-01T00:00:00Z' }]);
        rpcMock.mockResolvedValue({ data: makeSupportMessage({ conversation_id: 'conv-1' }), error: null });

        await useSupportChatStore.getState().drainSupportQueue();

        expect(useSupportChatStore.getState().messages).toHaveLength(0);
        expect(mockKv[PENDING_KEY]).toBe('[]');
    });
});
