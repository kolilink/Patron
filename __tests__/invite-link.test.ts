// E2E FIX BATCH B — B2(b) token survival. TEST DB only — do not commit.
//
// lib/inviteLink.ts imports expo-linking, expo-clipboard and expo-application,
// none of which have a moduleNameMapper entry (they ship unparsed ESM), so they
// must be jest.mock'd here. '@/lib/analytics' and '@/lib/db' are mocked too so
// the module loads hermetically without pulling in posthog/SQLite.

jest.mock('expo-linking', () => ({
    getInitialURL: jest.fn(async () => null),
}));

jest.mock('expo-clipboard', () => ({
    hasStringAsync: jest.fn(async () => false),
    getStringAsync: jest.fn(async () => null),
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

import { tokenFromUrl, tokenFromReferrer } from '@/lib/inviteLink';

describe('B2(b) — invite token length threshold is 10, not 16', () => {
    it('tokenFromUrl accepts a 10-char manual CODE in the ?t= slot', () => {
        expect(tokenFromUrl('https://patron.kolilink.com/invite?t=ABCDEFGHJK')).toBe('ABCDEFGHJK');
    });

    it('tokenFromUrl accepts the long 48-char hex token on the /invite path', () => {
        const hex = 'a'.repeat(48);
        expect(tokenFromUrl(`https://patron.kolilink.com/invite?t=${hex}`)).toBe(hex);
    });

    it('tokenFromUrl accepts the custom scheme (patron://) too', () => {
        expect(tokenFromUrl('patron://invite?t=ABCDEFGHJK')).toBe('ABCDEFGHJK');
    });

    it('tokenFromUrl rejects a 9-char value — too short to be a real token', () => {
        expect(tokenFromUrl('https://patron.kolilink.com/invite?t=ABCDEFGHJ')).toBeNull();
    });

    it('tokenFromUrl rejects a foreign origin even with a 10-char ?t=', () => {
        expect(tokenFromUrl('https://evil.example.com/invite?t=ABCDEFGHJK')).toBeNull();
    });

    it('tokenFromUrl trims whitespace around the token', () => {
        expect(tokenFromUrl('https://patron.kolilink.com/invite?t=%20ABCDEFGHJK%20')).toBe('ABCDEFGHJK');
    });

    it('tokenFromReferrer accepts a 10-char patron_invite value', () => {
        expect(tokenFromReferrer('patron_invite=ABCDEFGHJK')).toBe('ABCDEFGHJK');
    });

    it('tokenFromReferrer rejects a 9-char patron_invite value', () => {
        expect(tokenFromReferrer('patron_invite=ABCDEFGHJ')).toBeNull();
    });

    it('tokenFromReferrer rejects a missing/empty referrer', () => {
        expect(tokenFromReferrer(null)).toBeNull();
        expect(tokenFromReferrer('')).toBeNull();
    });
});
