// E2E FIX BATCH B — B2(b) token survival. TEST DB only — do not commit.
//
// lib/inviteLink.ts imports expo-linking and expo-application,
// none of which have a moduleNameMapper entry (they ship unparsed ESM), so they
// must be jest.mock'd here. '@/lib/analytics' and '@/lib/db' are mocked too so
// the module loads hermetically without pulling in posthog/SQLite.

jest.mock('expo-linking', () => ({
    getInitialURL: jest.fn(async () => null),
}));

jest.mock('expo-application', () => ({
    getInstallReferrerAsync: jest.fn(async () => null),
}));

jest.mock('@/lib/db', () => ({
    getKV: jest.fn(async () => ''),
    setKV: jest.fn(async () => { }),
}));

jest.mock('@/lib/analytics', () => ({
    trackEvent: jest.fn(),
}));

import { inviterIdFromUrl, inviterIdFromReferrer, isInviterId } from '@/lib/inviteLink';

const ID = '3f2b8c1e-9a4d-4e57-8b6a-1c2d3e4f5a6b';

describe('word-of-mouth invite link capture', () => {
    it('reads the inviter id from the https link', () => {
        expect(inviterIdFromUrl(`https://patron.kolilink.com/invite/${ID}`)).toBe(ID);
    });

    it('reads it from the custom scheme too', () => {
        expect(inviterIdFromUrl(`patron://invite/${ID}`)).toBe(ID);
    });

    it('lower-cases and tolerates a trailing slash', () => {
        expect(inviterIdFromUrl(`https://patron.kolilink.com/invite/${ID.toUpperCase()}/`)).toBe(ID);
    });

    it('rejects a foreign origin', () => {
        expect(inviterIdFromUrl(`https://evil.example.com/invite/${ID}`)).toBeNull();
    });

    it('rejects non-uuid segments, the bare /invite and old ?t= links', () => {
        expect(inviterIdFromUrl('https://patron.kolilink.com/invite/ABCDEFGHJK')).toBeNull();
        expect(inviterIdFromUrl('https://patron.kolilink.com/invite')).toBeNull();
        expect(inviterIdFromUrl('https://patron.kolilink.com/invite?t=ABCDEFGHJK')).toBeNull();
        expect(inviterIdFromUrl(null)).toBeNull();
    });

    it('install referrer carries patron_invite=<id>', () => {
        expect(inviterIdFromReferrer(`patron_invite=${ID}`)).toBe(ID);
        expect(inviterIdFromReferrer('patron_invite=ABCDEFGHJK')).toBeNull();
        expect(inviterIdFromReferrer(null)).toBeNull();
        expect(inviterIdFromReferrer('')).toBeNull();
    });

    it('isInviterId only accepts uuids', () => {
        expect(isInviterId(ID)).toBe(true);
        expect(isInviterId('nope')).toBe(false);
        expect(isInviterId('')).toBe(false);
    });
});
