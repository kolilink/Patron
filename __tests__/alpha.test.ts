// stores/alpha.ts — the Alpha AI advisor's optimistic send/reconcile flow
// and quota-exceeded error surfacing. Mocks supabase.rpc/functions.invoke
// entirely (see CLAUDE.md: this suite verifies the client calls the right
// thing with the right params, not that send_alpha_message's SQL is
// correct — that's __tests__/integration/alpha-chat.integration.test.ts).

jest.mock('@/lib/supabase', () => ({
  supabase: {
    rpc: jest.fn(),
    from: jest.fn(),
    functions: { invoke: jest.fn() },
  },
}));

import { supabase } from '@/lib/supabase';
import { useAlphaStore } from '@/stores/alpha';
import type { AlphaMessage } from '@/src/types';

const rpc = supabase.rpc as jest.Mock;
const invoke = supabase.functions.invoke as jest.Mock;

function makeAssistantMsg(overrides: Partial<AlphaMessage> = {}): AlphaMessage {
  return {
    id: 'real-assistant-1',
    conversation_id: 'conv-1',
    role: 'assistant',
    content: 'Vos ventes sont en hausse de 12% ce mois-ci.',
    status: 'ready',
    error_note: null,
    model: 'llama-3.3-70b-versatile',
    created_at: '2026-07-13T12:00:05Z',
    ...overrides,
  };
}

beforeEach(() => {
  useAlphaStore.setState({
    conversation: { id: 'conv-1', business_id: 'biz-1', user_id: 'user-1', last_message_at: '', created_at: '', updated_at: '' },
    messages: [],
    quota: null,
    loading: false,
    sending: false,
    error: null,
    offline: false,
  });
  jest.clearAllMocks();
});

describe('sendMessage', () => {
  it('optimistically appends the user message, then reconciles with the real row and the AI reply', async () => {
    rpc.mockImplementation((fn: string) => {
      if (fn === 'send_alpha_message') {
        return Promise.resolve({
          data: {
            id: 'real-user-1', conversation_id: 'conv-1', role: 'user',
            content: 'Comment vont mes ventes ?', status: 'ready',
            error_note: null, model: null, created_at: '2026-07-13T12:00:00Z',
          },
          error: null,
        });
      }
      if (fn === 'get_alpha_quota_status') {
        return Promise.resolve({ data: { has_ai_access: false, limit: 3, remaining: 2, next_reset_at: null, in_welcome_burst: true, burst_messages_remaining: 9 }, error: null });
      }
      return Promise.resolve({ data: null, error: null });
    });
    invoke.mockResolvedValue({ data: { ok: true, message: makeAssistantMsg() }, error: null });

    const sendPromise = useAlphaStore.getState().sendMessage({ businessId: 'biz-1', content: 'Comment vont mes ventes ?' });

    // Optimistic message visible immediately, before the RPC resolves.
    expect(useAlphaStore.getState().messages.some(m => m.id.startsWith('optimistic-'))).toBe(true);

    await sendPromise;

    const { messages, sending, error } = useAlphaStore.getState();
    expect(sending).toBe(false);
    expect(error).toBeNull();
    expect(messages.some(m => m.id.startsWith('optimistic-'))).toBe(false);
    expect(messages.find(m => m.role === 'user')?.id).toBe('real-user-1');
    expect(messages.find(m => m.role === 'assistant')?.content).toMatch(/hausse/);
  });

  it('surfaces the RPC quota-exceeded message verbatim and rolls back the optimistic message', async () => {
    rpc.mockImplementation((fn: string) => {
      if (fn === 'send_alpha_message') {
        return Promise.resolve({
          data: null,
          error: { message: "Limite de questions atteinte pour l'instant. Réessayez plus tard ou passez à Alpha Illimité." },
        });
      }
      return Promise.resolve({ data: null, error: null });
    });

    await useAlphaStore.getState().sendMessage({ businessId: 'biz-1', content: 'Encore une question ?' });

    const { messages, sending, error } = useAlphaStore.getState();
    expect(sending).toBe(false);
    expect(messages.length).toBe(0); // optimistic message rolled back, nothing persisted
    expect(error).toMatch(/Limite de questions atteinte/);
    expect(invoke).not.toHaveBeenCalled(); // never asks Groq for a reply to a rejected message
  });

  it('rolls back the optimistic message on a network failure calling send_alpha_message', async () => {
    rpc.mockImplementation((fn: string) => {
      if (fn === 'send_alpha_message') {
        return Promise.resolve({ data: null, error: { message: 'Network request failed' } });
      }
      return Promise.resolve({ data: null, error: null });
    });

    await useAlphaStore.getState().sendMessage({ businessId: 'biz-1', content: 'Une question ?' });

    const { messages, sending } = useAlphaStore.getState();
    expect(sending).toBe(false);
    expect(messages.length).toBe(0);
  });

  it('does nothing for an empty/whitespace-only message', async () => {
    await useAlphaStore.getState().sendMessage({ businessId: 'biz-1', content: '   ' });
    expect(rpc).not.toHaveBeenCalled();
    expect(useAlphaStore.getState().messages.length).toBe(0);
  });
});
