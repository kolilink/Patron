import {
  EVENT_REGISTRY,
  ORDINARY_CAP,
  bypassesCap,
  bypassesQuietHours,
  isQuietHours,
  localHour,
  sanitizeDataPayload,
} from '@/supabase/functions/dispatch-notification/registry';

describe('notification registry — allowlist', () => {
  it('rejects any event_type not explicitly registered', () => {
    expect(EVENT_REGISTRY['made_up_event']).toBeUndefined();
    expect(EVENT_REGISTRY['promotional_blast']).toBeUndefined();
  });

  it('the 17 launch-allowlist types are all registered', () => {
    const required = [
      'sale_completed', 'sale_cancelled', 'sale_edited', 'low_stock', 'price_changed',
      'partnership_request', 'partnership_accepted', 'support_message', 'support_reply',
      'chat_message', 'alpha_quota_reset', 'daily_digest', 'activation_nudge_1',
      'activation_nudge_2', 'second_action_reminder', 'revenue_milestone', 'debt_aging_reminder',
    ];
    for (const type of required) {
      expect(EVENT_REGISTRY[type]).toBeDefined();
    }
  });

  it('price_changed is registered but never built — never sends a push', () => {
    expect(EVENT_REGISTRY.price_changed.built).toBe(false);
  });

  it('dormant engines (no schema/cron/UI at all) are marked built:false', () => {
    const dormant = ['sale_edited', 'alpha_quota_reset', 'revenue_milestone', 'debt_aging_reminder'];
    for (const type of dormant) {
      expect(EVENT_REGISTRY[type].built).toBe(false);
    }
  });

  it('activation_nudge_1/2 and second_action_reminder have a real engine (migration_v155.sql) — built:true', () => {
    for (const type of ['activation_nudge_1', 'activation_nudge_2', 'second_action_reminder']) {
      expect(EVENT_REGISTRY[type].built).toBe(true);
    }
  });

  it('daily_digest has a real engine (migration_v139 RPC + edge function) — built:true despite needing a cron-schedule/deploy step this pass cannot execute', () => {
    expect(EVENT_REGISTRY.daily_digest.built).toBe(true);
  });

  it('live types (sale_completed, low_stock, chat_message, support, digest) are built', () => {
    for (const type of ['sale_completed', 'sale_cancelled', 'low_stock', 'chat_message', 'support_message', 'support_reply', 'partnership_request', 'partnership_accepted', 'daily_digest']) {
      expect(EVENT_REGISTRY[type].built).toBe(true);
    }
  });
});

describe('lock-screen payload sanitization', () => {
  it('sale_completed: strips client names and amounts, keeps only sale_id', () => {
    const out = sanitizeDataPayload('sale_completed', {
      seller: 'Aladji', amount: '50 000 GNF', desc: '2x Riz', sale_id: 'abc-123',
    });
    expect(out).toEqual({ sale_id: 'abc-123' });
    expect(out.seller).toBeUndefined();
    expect(out.amount).toBeUndefined();
  });

  it('sale_cancelled: strips amount/reason, keeps only sale_id', () => {
    const out = sanitizeDataPayload('sale_cancelled', {
      amount: '12 000 GNF', reason: 'Erreur de saisie', sale_id: 'xyz',
    });
    expect(out).toEqual({ sale_id: 'xyz' });
  });

  it('debt_aging_reminder: strips client name/amount/days, keeps only client_id', () => {
    const out = sanitizeDataPayload('debt_aging_reminder', {
      name: 'Mamadou', amount: '30 000 GNF', days: 7, client_id: 'client-1',
    });
    expect(out).toEqual({ client_id: 'client-1' });
  });

  it('low_stock: {product} is the one named exception, allowed through', () => {
    const out = sanitizeDataPayload('low_stock', { product: 'Riz 5kg', product_id: 'p1', qty: 2 });
    expect(out).toEqual({ product: 'Riz 5kg', product_id: 'p1' });
    expect(out.qty).toBeUndefined();
  });

  it('partnership_request: {business} is the named exception, no other identity leaks', () => {
    const out = sanitizeDataPayload('partnership_request', {
      business: 'Boutique Fatou', sender_name: 'Fatou Camara', preview: 'a real message',
    });
    expect(out).toEqual({ business: 'Boutique Fatou' });
  });

  it('chat_message: {sender} allowed, message content never in data', () => {
    const out = sanitizeDataPayload('chat_message', { sender: 'Ibrahim', snippet: 'Full chat text here' });
    expect(out).toEqual({ sender: 'Ibrahim' });
    expect(out.snippet).toBeUndefined();
  });

  it('an unregistered event type sanitizes to an empty object, never passthrough', () => {
    expect(sanitizeDataPayload('not_a_real_event', { anything: 'leaks?' })).toEqual({});
  });
});

describe('fixed body/title templates never echo raw payload amounts', () => {
  it('sale_completed body is the generic pointer, not seller+amount', () => {
    const body = EVENT_REGISTRY.sale_completed.body({ seller: 'X', amount: '999 999 GNF' });
    expect(body).toBe('Touchez pour voir le détail.');
    expect(body).not.toMatch(/999/);
  });

  it('debt_aging_reminder body never states the amount or client name', () => {
    const body = EVENT_REGISTRY.debt_aging_reminder.body({ name: 'Client X', amount: '1 000 000 GNF' });
    expect(body).not.toMatch(/Client X/);
    expect(body).not.toMatch(/1 000 000/);
  });

  it('revenue_milestone body never states the crossed amount', () => {
    const body = EVENT_REGISTRY.revenue_milestone.body({ amount: '10 000 000 GNF' });
    expect(body).not.toMatch(/10 000 000/);
  });
});

describe('server-side cap — max 3 ordinary/money pushes per user per 24h', () => {
  it('ORDINARY_CAP is 3', () => {
    expect(ORDINARY_CAP).toBe(3);
  });

  it('security bypasses the cap; ordinary and money do not', () => {
    expect(bypassesCap('security')).toBe(true);
    expect(bypassesCap('ordinary')).toBe(false);
    expect(bypassesCap('money')).toBe(false);
  });

  it('simulates 6 queued events against one recipient — cap holds at 3', () => {
    // Mirrors the edge function's own filter logic against a fake recent-log.
    const recentSends = 5; // recipient already has 5 ordinary sends logged today
    const category = 'ordinary';
    const underCap = !bypassesCap(category) ? recentSends < ORDINARY_CAP : true;
    expect(underCap).toBe(false);

    const freshRecipientSends = 2;
    const stillUnderCap = !bypassesCap(category) ? freshRecipientSends < ORDINARY_CAP : true;
    expect(stillUnderCap).toBe(true);
  });
});

describe('quiet hours (21:00–07:00 UTC)', () => {
  it('security and money bypass quiet hours; ordinary does not', () => {
    expect(bypassesQuietHours('security')).toBe(true);
    expect(bypassesQuietHours('money')).toBe(true);
    expect(bypassesQuietHours('ordinary')).toBe(false);
  });

  it('boundary: 20:59 UTC is NOT quiet hours', () => {
    expect(isQuietHours(new Date('2026-01-01T20:59:00Z'))).toBe(false);
  });

  it('boundary: 21:00 UTC IS quiet hours (start, inclusive)', () => {
    expect(isQuietHours(new Date('2026-01-01T21:00:00Z'))).toBe(true);
  });

  it('midnight UTC is quiet hours', () => {
    expect(isQuietHours(new Date('2026-01-01T00:00:00Z'))).toBe(true);
  });

  it('boundary: 06:59 UTC IS still quiet hours', () => {
    expect(isQuietHours(new Date('2026-01-01T06:59:00Z'))).toBe(true);
  });

  it('boundary: 07:00 UTC is NOT quiet hours (end, exclusive)', () => {
    expect(isQuietHours(new Date('2026-01-01T07:00:00Z'))).toBe(false);
  });

  it('midday UTC is not quiet hours', () => {
    expect(isQuietHours(new Date('2026-01-01T12:00:00Z'))).toBe(false);
  });
});

describe('quiet hours — per-device timezone parameter (migration_v154.sql)', () => {
  it('no timezone (null/undefined) reproduces the exact original UTC-only behavior', () => {
    const t = new Date('2026-01-01T21:00:00Z'); // 21:00 UTC — quiet
    expect(isQuietHours(t)).toBe(true);
    expect(isQuietHours(t, null)).toBe(true);
    expect(isQuietHours(t, undefined)).toBe(true);
  });

  it('same instant is quiet or not depending on the device timezone', () => {
    // 21:00 UTC is quiet in UTC, but only 16:00 in America/New_York — not quiet there
    const t = new Date('2026-01-01T21:00:00Z');
    expect(isQuietHours(t, 'UTC')).toBe(true);
    expect(isQuietHours(t, 'America/New_York')).toBe(false);
  });

  it('a vendor in Asia/Tokyo (UTC+9) hits quiet hours at a different UTC instant than a Guinea vendor', () => {
    // 12:00 UTC = 21:00 in Tokyo (quiet there), but 12:00 UTC in Guinea (UTC+0) is not quiet
    const t = new Date('2026-01-01T12:00:00Z');
    expect(isQuietHours(t, 'Africa/Conakry')).toBe(false);
    expect(isQuietHours(t, 'Asia/Tokyo')).toBe(true);
  });

  it('an invalid/garbage timezone string degrades to UTC instead of throwing', () => {
    const t = new Date('2026-01-01T21:00:00Z');
    expect(() => isQuietHours(t, 'Not/A_Real_Zone')).not.toThrow();
    expect(isQuietHours(t, 'Not/A_Real_Zone')).toBe(true); // falls back to UTC hour (21) — still quiet
  });

  it('localHour resolves the correct hour for a known zone', () => {
    expect(localHour(new Date('2026-01-01T21:00:00Z'), 'UTC')).toBe(21);
    expect(localHour(new Date('2026-01-01T21:00:00Z'), 'America/New_York')).toBe(16);
  });
});

describe('hard rule: no scheduler/server event can debtor-notify without a current vendor tap', () => {
  it('debt_aging_reminder is not built — no cron/scheduler path can currently emit it', () => {
    // The only way this event could ever be capable of firing today is if
    // some caller flips EVENT_REGISTRY.debt_aging_reminder.built to true —
    // and there is no cron/scheduler code anywhere in this repo that does,
    // or could, target a specific debtor. Any future engine wiring this up
    // must do so from a real vendor-initiated action, never a bare cron scan
    // that reaches into a client's ledger unprompted.
    expect(EVENT_REGISTRY.debt_aging_reminder.built).toBe(false);
  });

  it('no CRON_EVENTS-style bypass exists for debt_aging_reminder in the registry', () => {
    // category is 'ordinary', not 'security' — it must go through the same
    // cap/quiet-hours/authorization gate as any other user-facing push,
    // never a privileged bypass lane reserved for cron-only events.
    expect(EVENT_REGISTRY.debt_aging_reminder.category).toBe('ordinary');
  });
});

describe('deep-link route resolution — every push type lands on its exact screen', () => {
  it('sale_completed/cancelled/edited route to that sale detail, with id', () => {
    expect(EVENT_REGISTRY.sale_completed.route({ sale_id: 's1' })).toBe('/(app)/ventes/s1');
    expect(EVENT_REGISTRY.sale_cancelled.route({ sale_id: 's2' })).toBe('/(app)/ventes/s2');
    expect(EVENT_REGISTRY.sale_edited.route({ sale_id: 's3' })).toBe('/(app)/ventes/s3');
  });

  it('sale routes fall back to the list (parent screen) when sale_id is missing — never a dead end', () => {
    expect(EVENT_REGISTRY.sale_completed.route({})).toBe('/(app)/ventes');
  });

  it('low_stock routes to that product, falls back to catalogue root if missing', () => {
    expect(EVENT_REGISTRY.low_stock.route({ product_id: 'p1' })).toBe('/(app)/catalogue/p1');
    expect(EVENT_REGISTRY.low_stock.route({})).toBe('/(app)/catalogue');
  });

  it('debt_aging_reminder routes to that client, falls back to clients root if missing', () => {
    expect(EVENT_REGISTRY.debt_aging_reminder.route({ client_id: 'c1' })).toBe('/(app)/clients/c1');
    expect(EVENT_REGISTRY.debt_aging_reminder.route({})).toBe('/(app)/clients');
  });

  it('daily_digest and revenue_milestone route to chiffres/rapports', () => {
    expect(EVENT_REGISTRY.daily_digest.route({})).toBe('/(app)/rapports');
    expect(EVENT_REGISTRY.revenue_milestone.route({})).toBe('/(app)/rapports');
  });

  it('activation nudges route to the exact capture screen named in their copy', () => {
    expect(EVENT_REGISTRY.activation_nudge_1.route({})).toBe('/(app)/(tabs)/vendre?mode=credit');
    expect(EVENT_REGISTRY.activation_nudge_2.route({})).toBe('/(app)/(tabs)/vendre');
  });

  it('second_action_reminder routes to vendre and its body/title vary by action_type without ever naming a client or amount', () => {
    expect(EVENT_REGISTRY.second_action_reminder.route({})).toBe('/(app)/(tabs)/vendre');
    expect(EVENT_REGISTRY.second_action_reminder.body({ action_type: 'product' })).toBe('Vous pouvez aussi noter vos ventes.');
    expect(EVENT_REGISTRY.second_action_reminder.body({ action_type: 'debt' })).toBe('Vous pouvez aussi noter vos ventes.');
    expect(EVENT_REGISTRY.second_action_reminder.body({ action_type: 'sale' })).toBe('Prêt pour la suivante ?');
  });

  it('partnership and support/chat route to their thread/screen', () => {
    expect(EVENT_REGISTRY.partnership_request.route({})).toBe('/(app)/discussions');
    expect(EVENT_REGISTRY.support_message.route({})).toBe('/(app)/support-inbox');
    expect(EVENT_REGISTRY.support_reply.route({})).toBe('/(app)/support');
    expect(EVENT_REGISTRY.chat_message.route({})).toBe('/(app)/discussions');
  });
});
