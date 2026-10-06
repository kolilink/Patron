// Hermetic unit tests for send-debt-reminders' decision logic. The DB-backed
// end-to-end proof lives in __tests__/integration/debt-reminders.integration.test.ts.
import { runDebtReminders, wasSent, type Deps, type Digest, type DispatchResult } from '@/supabase/functions/send-debt-reminders/handler';

const digest = (over: Partial<Digest> = {}): Digest => ({
  business_id: 'b1', local_date: '2026-10-06', count_7d: 2, count_30d: 0,
  single_client_id: null, recipient_user_ids: ['u1'],
  items: [{ sale_order_id: 's1', threshold_days: 7 }, { sale_order_id: 's2', threshold_days: 7 }], ...over,
});

function deps(digests: Digest[], result: DispatchResult | (() => DispatchResult)) {
  const confirm = jest.fn(async () => true);
  const dispatch = jest.fn(async () => (typeof result === 'function' ? result() : result));
  const d: Deps = { getDigests: async () => digests, confirm, dispatch, sleep: async () => {} };
  return { d, confirm, dispatch };
}

describe('wasSent — HTTP 200 is not evidence of a push', () => {
  it.each([
    [{ ok: true, body: { sent: 1 } }, true],
    [{ ok: true, body: { sent: 3 } }, true],
    [{ ok: true, body: { skipped: 'not_built' } }, false],
    [{ ok: true, body: { sent: 0, skipped: 'cap' } }, false],
    [{ ok: true, body: { sent: 0, skipped: 'quiet_hours' } }, false],
    [{ ok: true, body: { sent: 0 } }, false],
    [{ ok: true, body: { sent: 2, skipped: 'x' } }, false],
    [{ ok: true, body: null }, false],
    [{ ok: false, body: { sent: 1 } }, false],
  ] as [DispatchResult, boolean][])('%j -> %s', (r, expected) => {
    expect(wasSent(r)).toBe(expected);
  });
});

describe('runDebtReminders', () => {
  it('confirms a digest only after a body-confirmed send, and sends counts only', async () => {
    const { d, confirm, dispatch } = deps([digest()], { ok: true, body: { sent: 1 } });
    const summary = await runDebtReminders(d);
    expect(summary).toEqual({ due: 1, sent: 1, notSent: 0, failed: 0 });
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledWith({
      business_id: 'b1', event_type: 'debt_aging_reminder',
      payload: { count_7d: 2, count_30d: 0 }, target_user_ids: ['u1'],
    });
  });

  it('forwards the client id only when the digest is a single client', async () => {
    const { d, dispatch } = deps([digest({ single_client_id: 'c9' })], { ok: true, body: { sent: 1 } });
    await runDebtReminders(d);
    expect((dispatch.mock.calls[0] as unknown as [{ payload: object }])[0].payload).toEqual({ count_7d: 2, count_30d: 0, client_id: 'c9' });
  });

  it('never confirms on skipped / sent:0 (the original bug)', async () => {
    for (const body of [{ skipped: 'not_built' }, { sent: 0, skipped: 'cap' }, { sent: 0 }]) {
      const { d, confirm } = deps([digest()], { ok: true, body });
      const summary = await runDebtReminders(d);
      expect(summary).toMatchObject({ sent: 0, notSent: 1 });
      expect(confirm).not.toHaveBeenCalled();
    }
  });

  it('a throwing digest is isolated; the rest of the batch still goes out', async () => {
    let n = 0;
    const { d, confirm } = deps([digest({ business_id: 'b1' }), digest({ business_id: 'b2' })],
      () => { if (n++ === 0) throw new Error('rate limit'); return { ok: true, body: { sent: 1 } }; });
    const summary = await runDebtReminders(d);
    expect(summary).toEqual({ due: 2, sent: 1, notSent: 0, failed: 1 });
    expect(confirm).toHaveBeenCalledTimes(1);
  });

  it('retries confirm once after a successful send, so a blip does not cause a re-send next hour', async () => {
    const { d, confirm } = deps([digest()], { ok: true, body: { sent: 1 } });
    confirm.mockRejectedValueOnce(new Error('blip'));
    expect(await runDebtReminders(d)).toMatchObject({ sent: 1, failed: 0 });
    expect(confirm).toHaveBeenCalledTimes(2);
  });

  it('nothing due -> no dispatch at all', async () => {
    const { d, dispatch } = deps([], { ok: true, body: { sent: 1 } });
    expect(await runDebtReminders(d)).toEqual({ due: 0, sent: 0, notSent: 0, failed: 0 });
    expect(dispatch).not.toHaveBeenCalled();
  });
});
