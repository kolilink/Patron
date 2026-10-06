import { readFileSync } from 'fs';
import { join } from 'path';

jest.mock('@/lib/supabase', () => ({ supabase: { rpc: jest.fn() } }));
jest.mock('@/lib/sync', () => ({
  isNetworkError: (e: any) => !!e && /network|timeout|fetch/i.test(String(e.message)),
  withTimeout: (p: any) => p,
}));
jest.mock('@/lib/inviteLink', () => ({
  getPendingInviterId: jest.fn(),
  clearPendingInviterId: jest.fn(async () => { }),
}));

import { supabase } from '@/lib/supabase';
import { getPendingInviterId, clearPendingInviterId } from '@/lib/inviteLink';
import { buildInviteLink, buildInviteMessage, recordPendingInviteAttribution } from '@/stores/inviter';

const ID = '3f2b8c1e-9a4d-4e57-8b6a-1c2d3e4f5a6b';
const read = (rel: string) => readFileSync(join(__dirname, '..', rel), 'utf8');

describe('share link + message', () => {
  it('link is patron.kolilink.com/invite/<inviter-id>, no code or expiry', () => {
    expect(buildInviteLink(ID)).toBe(`https://patron.kolilink.com/invite/${ID}`);
  });
  it('message is the exact word-of-mouth copy, link last, no code line', () => {
    const m = buildInviteMessage(buildInviteLink(ID));
    expect(m).toBe(`Je note mes ventes et mes crédits avec Patron, même sans internet et c’est gratuit : https://patron.kolilink.com/invite/${ID}`);
    expect(m).not.toMatch(/Code/);
  });
});

describe('recordPendingInviteAttribution (silent)', () => {
  beforeEach(() => jest.clearAllMocks());

  it('does nothing without a pending id', async () => {
    (getPendingInviterId as jest.Mock).mockResolvedValue(null);
    await recordPendingInviteAttribution();
    expect(supabase.rpc).not.toHaveBeenCalled();
  });
  it('records and clears on success', async () => {
    (getPendingInviterId as jest.Mock).mockResolvedValue(ID);
    (supabase.rpc as jest.Mock).mockResolvedValue({ data: { recorded: true }, error: null });
    await recordPendingInviteAttribution();
    expect(supabase.rpc).toHaveBeenCalledWith('record_invite_attribution', { p_inviter_id: ID });
    expect(clearPendingInviterId).toHaveBeenCalled();
  });
  it('keeps the id on a network failure so the next launch retries', async () => {
    (getPendingInviterId as jest.Mock).mockResolvedValue(ID);
    (supabase.rpc as jest.Mock).mockResolvedValue({ data: null, error: { message: 'Network request failed' } });
    await recordPendingInviteAttribution();
    expect(clearPendingInviterId).not.toHaveBeenCalled();
  });
  it('clears on a definitive refusal; never throws', async () => {
    (getPendingInviterId as jest.Mock).mockResolvedValue(ID);
    (supabase.rpc as jest.Mock).mockResolvedValue({ data: null, error: { code: 'P0001', message: 'x' } });
    await expect(recordPendingInviteAttribution()).resolves.toBeUndefined();
    expect(clearPendingInviterId).toHaveBeenCalled();
    (supabase.rpc as jest.Mock).mockRejectedValue(new Error('boom'));
    await expect(recordPendingInviteAttribution()).resolves.toBeUndefined();
  });
});

describe('no dead buttons, badges or routes', () => {
  it('Accueil share uses the plain link and no server round trip', () => {
    const a = read('app/(app)/(tabs)/index.tsx');
    expect(a).toMatch(/buildInviteMessage\(buildInviteLink\(userId\)\)/);
    expect(a).not.toMatch(/createInvite/);
  });
  it('drawer has no Invitations entry; the invitations route is gone', () => {
    expect(read('src/components/BusinessDrawer.tsx')).not.toMatch(/nvitations/);
    expect(() => read('app/(app)/invitations.tsx')).toThrow();
  });
  it('nothing routes to the Amis tab any more', () => {
    for (const f of ['app/_layout.tsx', 'app/(app)/_layout.tsx', 'app/(welcome)/creer.tsx', 'app/(welcome)/connexion.tsx',
      'app/(welcome)/rejoindre.tsx', 'app/(app)/onboarding/creer.tsx', 'app/(app)/onboarding/rejoindre.tsx',
      'src/components/InviteArrival.tsx', 'app/invite.tsx', 'app/invite/[id].tsx']) {
      expect(read(f)).not.toMatch(/tab=amis/);
    }
  });
  it('staff join-by-code is untouched (equipe codes → joinBusiness / join_business)', () => {
    expect(read('stores/auth.ts')).toMatch(/record_invite_attempt/);
    expect(read('stores/auth.ts')).toMatch(/joinBusiness/);
  });
});

describe('landing page copy', () => {
  const html = read('invite/index.html');
  it('has exactly the specified strings', () => {
    expect(html).toContain("On t'invite sur Patron.");
    expect(html).toContain('Note tes ventes, suis tes crédits avec ou sans internet');
    expect(html).toContain("Télécharger sur l'App Store");
    expect(html).toContain('Télécharger sur Play Store');
    expect(html).toContain('Gratuit et fait pour les commerçants');
    expect(html).toMatch(/\\u00AB ' \+ name \+ ' \\u00BB t\\u2019invite sur Patron\./);
  });
  it('is gone: clipboard button, 3-step instructions, code/token flows', () => {
    expect(html).not.toMatch(/Copier le lien|Lien copié|J'ai déjà Patron|id="bridge"|preview_consumer_invite/);
  });
  it('OG card matches, and 404.html forwards /invite/<id>', () => {
    for (const f of ['invite/index.html', '404.html']) {
      const h = read(f);
      expect(h).toContain('<meta property="og:description" content="Note tes ventes, suis tes crédits avec ou sans internet" />');
      expect(h).toContain('<meta property="og:image" content="https://patron.kolilink.com/invite/og.png" />');
    }
    expect(read('404.html')).toMatch(/\/invite\?i=/);
  });
});
