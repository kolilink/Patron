// Phase 6 — cost capture, daily cap, anomaly alert, cache keys, audit trail.
// The live DB behaviour (daily cap enforcement, revision-counter bump, audit
// writes) is covered by integration tests; this suite locks the hermetic
// logic and the shipped surface so a refactor can't silently drop the cap,
// the cost capture, or the audit write.

import * as fs from 'fs';
import * as path from 'path';

import {
    ANOMALY_MULTIPLIER,
    MODEL_PRICING,
    computeDataHash,
    estimateCost,
} from '../supabase/functions/alpha-chat/lib';

const INDEX_SOURCE = fs.readFileSync(
    path.resolve(__dirname, '../supabase/functions/alpha-chat/index.ts'),
    'utf-8',
);
const MIGRATION_SOURCE = fs.readFileSync(
    path.resolve(__dirname, '../db/migration_v210.sql'),
    'utf-8',
);

describe('Phase 6 — cost capture', () => {
    it('captures cost only when a model actually served the reply', () => {
        // servedByModel is null for deterministic (empty-envelope) answers.
        expect(INDEX_SOURCE).toContain('estimateCost');
        expect(INDEX_SOURCE).toMatch(/servedByModel \? estimateCost/);
    });

    it('records prompt/completion token counts and cost on the assistant row', () => {
        expect(INDEX_SOURCE).toContain('prompt_tokens');
        expect(INDEX_SOURCE).toContain('completion_tokens');
        expect(INDEX_SOURCE).toContain('cost');
    });

    it('prices both supported models', () => {
        expect(MODEL_PRICING['openai/gpt-oss-20b']).toBeTruthy();
        expect(MODEL_PRICING['gpt-4o-mini']).toBeTruthy();
    });

    it('estimates a positive cost for a known model and zero for unknown', () => {
        expect(estimateCost('gpt-4o-mini', 1000, 500)).toBeGreaterThan(0);
        expect(estimateCost('unknown', 1000, 500)).toBe(0);
    });
});

describe('Phase 6 — daily hard cap (default 30, configurable)', () => {
    it('seeds alpha_daily_cap to 30', () => {
        expect(MIGRATION_SOURCE).toMatch(/'alpha_daily_cap',\s*30/);
    });

    it('enforces the cap in send_alpha_message BEFORE the tier quota', () => {
        expect(MIGRATION_SOURCE).toContain('alpha_daily_usage');
        // Cap is checked first, then the tier quota.
        const dailyIdx = MIGRATION_SOURCE.indexOf('Daily hard cap');
        const tierIdx = MIGRATION_SOURCE.indexOf('Tier quota');
        expect(dailyIdx).toBeGreaterThan(-1);
        expect(tierIdx).toBeGreaterThan(dailyIdx);
    });

    it('rejects the cap at zero and is service-role only', () => {
        expect(MIGRATION_SOURCE).toMatch(/p_cap < 1/);
        expect(MIGRATION_SOURCE).toContain('REVOKE EXECUTE ON FUNCTION set_alpha_daily_cap');
    });
});

describe('Phase 6 — anomaly detection (3× rolling baseline)', () => {
    it('uses a 3× multiplier and a 7-day baseline', () => {
        expect(ANOMALY_MULTIPLIER).toBe(3);
        expect(MIGRATION_SOURCE).toMatch(/3 \* v_baseline/);
        expect(MIGRATION_SOURCE).toMatch(/interval '7 days'/);
    });
});

describe('Phase 6 — cache keys on data version', () => {
    it('every write bumps a per-business revision counter', () => {
        expect(MIGRATION_SOURCE).toContain('bump_business_data_version');
        expect(MIGRATION_SOURCE).toContain('business_data_versions');
        // Triggers on all 8 tables the skills read from.
        for (const t of ['sale_orders', 'so_lines', 'payments', 'stock_moves', 'products', 'product_variants', 'clients', 'businesses']) {
            expect(MIGRATION_SOURCE).toContain(`ON ${t}`);
        }
    });

    it('the skill envelopes carry the data version', () => {
        expect(MIGRATION_SOURCE).toMatch(/'version_donnees'/);
    });
});

describe('Phase 6 — audit trail', () => {
    it('writes one audit row per interaction, service-role only', () => {
        expect(MIGRATION_SOURCE).toContain('write_alpha_audit_trail');
        expect(MIGRATION_SOURCE).toContain('REVOKE EXECUTE ON FUNCTION write_alpha_audit_trail');
        expect(INDEX_SOURCE).toContain("rpc('write_alpha_audit_trail'");
    });

    it('the audit row records question, intention, params, data_hash, response, model, tokens, cost', () => {
        for (const f of ['p_question', 'p_intention', 'p_params', 'p_data_hash', 'p_response', 'p_model', 'p_prompt_tokens', 'p_completion_tokens', 'p_cost']) {
            expect(INDEX_SOURCE).toContain(f);
        }
    });

    it('computeDataHash is deterministic and fingerprints the retrieved envelope', () => {
        expect(computeDataHash({ a: 1 })).toBe(computeDataHash({ a: 1 }));
        expect(computeDataHash({ a: 1 })).not.toBe(computeDataHash({ a: 2 }));
    });
});
