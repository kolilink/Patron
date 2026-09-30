// Phase 4 — transparency. Two things are locked here:
//   1. The client-side constants (src/constants/alpha.ts) must stay in exact
//      sync with the strings the edge function prefixes to the first reply
//      (supabase/functions/alpha-chat/lib.ts), so the "?" info sheet can never
//      drift from what the server actually sends.
//   2. The server emits the disclosure + warning ONLY before the first reply
//      (assistantCount === 0), so the user sees it at first contact and the
//      "?" re-shows the identical text on demand.

import * as fs from 'fs';
import * as path from 'path';

import { ALPHA_LABEL, ALPHA_DISCLOSURE, ALPHA_WARNING } from '../src/constants/alpha';
import {
    ALPHA_DISCLOSURE as SERVER_DISCLOSURE,
    ALPHA_WARNING as SERVER_WARNING,
    ALPHA_LABEL as SERVER_LABEL,
} from '../supabase/functions/alpha-chat/lib';

const INDEX_SOURCE = fs.readFileSync(
    path.resolve(__dirname, '../supabase/functions/alpha-chat/index.ts'),
    'utf-8',
);
const SCREEN_SOURCE = fs.readFileSync(
    path.resolve(__dirname, '../app/(app)/alpha/index.tsx'),
    'utf-8',
);

describe('Phase 4 — transparency label + disclosure + warning', () => {
    it('client and server transparency strings are identical', () => {
        expect(ALPHA_LABEL).toBe(SERVER_LABEL);
        expect(ALPHA_DISCLOSURE).toBe(SERVER_DISCLOSURE);
        expect(ALPHA_WARNING).toBe(SERVER_WARNING);
    });

    it('server prefixes the disclosure + warning before the FIRST reply only', () => {
        expect(INDEX_SOURCE).toContain('ALPHA_DISCLOSURE');
        expect(INDEX_SOURCE).toContain('ALPHA_WARNING');
        expect(INDEX_SOURCE).toMatch(/isFirstReply/);
        // assistantCount === 0 gates the prefix — no disclosure on later replies.
        expect(INDEX_SOURCE).toMatch(/assistantCount.*=== 0|=== 0.*assistantCount/);
    });

    it('the screen shows the permanent label and a "?" entry that re-opens the info', () => {
        expect(SCREEN_SOURCE).toContain('ALPHA_LABEL');
        expect(SCREEN_SOURCE).toContain('help-circle-outline');
        expect(SCREEN_SOURCE).toContain('showInfo');
        expect(SCREEN_SOURCE).toContain('ALPHA_DISCLOSURE');
        expect(SCREEN_SOURCE).toContain('ALPHA_WARNING');
    });
});
