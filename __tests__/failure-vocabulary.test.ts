// The failure vocabulary: every registered failure sentence, the reason
// extraction, and the control-flow rule (branch on codes, never on human copy).

import fs from 'fs';
import path from 'path';
import { FAILURE_COPY } from '@/src/utils/failureCopy';
import {
  buildFailure, failureReason, vocabularyProblems, sentenceProblems, serverSentence, classifyFailure, NO_CONNECTION_WHY,
} from '@/src/utils/failure';
import { translateError } from '@/lib/errors';

jest.mock('@/lib/supabase', () => ({ supabase: { rpc: jest.fn(), from: jest.fn() } }));

const read = (rel: string) => fs.readFileSync(path.resolve(__dirname, '..', rel), 'utf8');

describe('every registered failure sentence follows the vocabulary', () => {
  for (const [key, copy] of Object.entries(FAILURE_COPY)) {
    it(key, () => {
      expect(vocabularyProblems({ what: copy.what, why: (copy as { why?: string }).why })).toEqual([]);
    });
  }
  it('there are no duplicate sentences (one failure, one wording)', () => {
    const whats = Object.values(FAILURE_COPY).map(c => c.what);
    expect(new Set(whats).size).toBe(whats.length);
  });
});

describe('what the vocabulary bans', () => {
  it.each([
    ['Erreur', 'headline'],
    ['Erreur lors de l\'envoi.', 'error word'],
    ["L'opération a échoué.", 'failed wording'],
    ['Code 42501.', 'raw code'],
    ['Votre faute, vous avez mal saisi.', 'blame'],
    ['Alerte critique : données perdues.', 'alarm'],
    ['null', 'null leak'],
  ])('%s (%s)', (text) => {
    expect(vocabularyProblems({ what: text }).length).toBeGreaterThan(0);
  });
  it('a sentence that is too long for a second-language reader is flagged', () => {
    expect(sentenceProblems('x'.repeat(95)).join()).toMatch(/too long/);
  });
  it('a good sentence passes', () => {
    expect(vocabularyProblems({ what: "Le paiement n'a pas été enregistré.", why: 'Vos données sont en sécurité.' })).toEqual([]);
  });
});

describe('failureReason — only a reason she can act on', () => {
  it('no connection is told plainly', () => {
    expect(failureReason(new Error('Network request failed'))).toBe(NO_CONNECTION_WHY);
    expect(failureReason('Failed to fetch')).toBe(NO_CONNECTION_WHY);
  });
  it('a sentence the server authored (P0001) passes verbatim', () => {
    const e = { code: 'P0001', message: 'Le montant dépasse le solde restant dû' };
    expect(serverSentence(e)).toBe('Le montant dépasse le solde restant dû');
    expect(failureReason(e)).toBe('Le montant dépasse le solde restant dû');
  });
  it('raw technical text is never a reason', () => {
    expect(failureReason(new Error('TypeError: Cannot read properties of undefined'))).toBeUndefined();
    expect(failureReason({ code: '42501', message: 'new row violates something' })).toBeUndefined();
    expect(failureReason(null)).toBeUndefined();
  });
  it('a P0001 message is only sanctioned for P0001 (a code-less message is not "authored")', () => {
    expect(serverSentence({ message: 'Le montant dépasse' })).toBeUndefined();
  });
  it('known technical failures are translated, and no translation says "Erreur"', () => {
    for (const raw of ['network request failed', 'failed to fetch', 'load failed', 'permission denied', 'duplicate key', 'jwt expired']) {
      expect(translateError(new Error(raw), 'x')).not.toMatch(/\berreur\b/i);
    }
  });
});

describe('buildFailure — exactly one action, static text', () => {
  it('shape: what, optional why, one action', () => {
    const f = buildFailure({ what: "Le produit n'a pas été lié.", action: { label: 'Réessayer', onPress: () => {} } });
    expect(Object.keys(f).sort()).toEqual(['action', 'what']);
    expect(f.action.label).toBe('Réessayer');
  });
  it('derives why from the error when asked, never from its raw message', () => {
    const f = buildFailure({ what: "Le produit n'a pas été lié.", err: new Error('Failed to fetch'), action: { label: 'Réessayer', onPress: () => {} } });
    expect(f.why).toBe(NO_CONNECTION_WHY);
    const g = buildFailure({ what: "Le produit n'a pas été lié.", err: new Error('boom: stack at line 3'), action: { label: 'Retour', onPress: () => {} } });
    expect(g.why).toBeUndefined();
  });
  it('FailureView is static: no animation on an error', () => {
    const view = read('src/components/ui/FailureView.tsx');
    expect(view).not.toMatch(/Animated|useNativeDriver|LoadingStatus/);
  });
});

describe('control flow uses codes, never human copy', () => {
  it('classifyFailure is code-based', () => {
    expect(classifyFailure(new Error('Network request failed'))).toBe('network');
    expect(classifyFailure({ code: 'P0001', message: 'x' })).toBe('rejected');
    expect(classifyFailure(new Error('whatever'))).toBe('unknown');
  });
  it('invite attribution branches on isNetworkError(), never on a French sentence', () => {
    const src = read('stores/inviter.ts');
    expect(src).toMatch(/isNetworkError\(error\)/);
    expect(src).not.toMatch(/===\s*['"`][^'"`]*(connexion|réseau|invalide)[^'"`]*['"`]/i);
  });

});
