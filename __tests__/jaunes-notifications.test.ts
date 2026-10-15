// Yellows batch (half-done audit, 2026-10-14), as corrected by evidence:
// - The dispatch-notification registry gate (`built: false` → the edge
//   function answers skipped:'not_built') was silently dropping THREE
//   live events whose senders exist: sale_edited (client dispatch in
//   stores/ventes.ts), alpha_quota_reset and revenue_milestone (edge
//   senders + pg_cron v138/v174). Entries flipped to built:true, stale
//   reasons removed; the sale_edited payload now carries sale_id so its
//   deep link resolves.
// - The placebo per-sale notification switch and the haptics master
//   switch are REMOVED from Paramètres (Sebastiao's ruling: vibrations
//   and haptics are on by default and are not a user privilege to
//   toggle). The Rappels de paiement switch stays — it is server-
//   enforced (migration_v237), a real gate, not a placebo.
// - Unblocking gets its missing UI: a « Bloqués » section in Paramètres
//   consuming fetchMyBlocks/unblockUser.
// - Every static « Chargement… » text state became <LoadingStatus>
//   (the animated loading law). NOTE the two audit findings that were
//   NOT bugs and are deliberately untouched: expense_approved/rejected
//   (dispatched by the outbox drain in lib/sync.ts for every decision)
//   and founder_new_user (server trigger pipeline, migration_v238).
import fs from 'fs';
import path from 'path';

const read = (p: string) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

describe('registry: no live event stays gated off', () => {
  const REG = read('supabase/functions/dispatch-notification/registry.ts');
  const block = (name: string) => {
    const i = REG.indexOf(`  ${name}: {`);
    return REG.slice(i, REG.indexOf('},', i));
  };

  it.each(['sale_edited', 'alpha_quota_reset', 'revenue_milestone'])('%s is built:true with no stale reason', (name) => {
    const b = block(name);
    expect(b).toContain('built: true');
    expect(b).not.toContain('notBuiltReason');
  });

  it('sale_edited accepts the keys its client actually sends', () => {
    expect(block('sale_edited')).toContain("allowedDataKeys: ['sale_id', 'editor', 'amount']");
  });

  it('the ventes edit dispatch carries sale_id for the deep link', () => {
    const v = read('stores/ventes.ts');
    expect(v).toContain("eventType: 'sale_edited'");
    expect(v).toContain('payload: { sale_id: saleId, editor: editorName');
  });
});

describe('Paramètres: toggles removed, unblock UI present', () => {
  const P = read('app/(app)/parametres/index.tsx');

  it('no per-sale notify switch, no haptics switch, no preference writes for them', () => {
    expect(P).not.toContain('Une notification à chaque vente');
    expect(P).not.toContain('Retour haptique');
    expect(P).not.toContain('notify_on_every_sale: value');
    expect(P).not.toContain('HAPTICS_KV_KEY');
  });

  it('the Rappels de paiement switch (server-enforced) is untouched', () => {
    expect(P).toContain('Rappels de paiement');
    expect(P).toContain('handleTogglePaymentReminders');
  });

  it('the Bloqués section consumes fetchMyBlocks/unblockUser', () => {
    expect(P).toContain('useModerationStore');
    expect(P).toContain('fetchMyBlocks');
    expect(P).toContain('unblockUser(id)');
    expect(P).toContain('Débloquer');
  });

  it('app startup no longer restores a persisted haptics-off', () => {
    const L = read('app/_layout.tsx');
    expect(L).not.toContain('HAPTICS_KV_KEY');
    expect(L).not.toContain('setEnabled(');
  });
});

describe('loading law: no static « Chargement… » text state remains', () => {
  const FILES = [
    'app/(app)/ventes/index.tsx',
    'app/(app)/support/index.tsx',
    'app/(app)/support-inbox/[id].tsx',
    'app/(app)/messages/[room_id].tsx',
    'app/(app)/marche/[id].tsx',
    'app/(app)/partenaire/[partnership_id]/stock.tsx',
    'app/(app)/discussions.tsx',
    'app/(app)/clients/[name].tsx',
    'app/(app)/equipe/index.tsx',
    'src/components/InviteArrival.tsx',
    'src/components/products/ProductSubSheets.tsx',
  ];

  it.each(FILES)('%s renders loading through LoadingStatus, never static text', (f) => {
    const s = read(f);
    expect(s).not.toMatch(/>[^<]*Chargement…[^<]*</);
    expect(s).toContain('LoadingStatus');
  });
});
