// Patron's loading language: a status word + three bouncing dots, never a lone
// spinner. Pure helpers are tested directly; the components are guarded by
// source checks (this repo has no JSX transform for component tests).

import fs from 'fs';
import path from 'path';
import {
  DOT_COUNT, DOT_CYCLE_MS, DOT_MOVE_MS, dotDelay, dotRest, staticStatusText, resolveLoadingWord, DEFAULT_LOADING_WORD,
} from '@/src/components/ui/loadingLanguage';

const read = (rel: string) => fs.readFileSync(path.resolve(__dirname, '..', rel), 'utf8');

describe('dot timing', () => {
  it('three dots, every one on the same ~1.2s period (so the wave never drifts)', () => {
    expect(DOT_COUNT).toBe(3);
    expect(DOT_CYCLE_MS).toBeGreaterThanOrEqual(1100);
    expect(DOT_CYCLE_MS).toBeLessThanOrEqual(1300);
    for (let i = 0; i < DOT_COUNT; i++) {
      expect(dotDelay(i) + 2 * DOT_MOVE_MS + dotRest(i)).toBe(DOT_CYCLE_MS);
      expect(dotRest(i)).toBeGreaterThanOrEqual(0);
    }
  });
  it('dots are staggered, left to right', () => {
    expect(dotDelay(0)).toBe(0);
    expect(dotDelay(1)).toBeGreaterThan(dotDelay(0));
    expect(dotDelay(2)).toBeGreaterThan(dotDelay(1));
  });
});

describe('words', () => {
  it('reduced motion text is the word + a static ellipsis, however it was typed', () => {
    expect(staticStatusText('Envoi')).toBe('Envoi…');
    expect(staticStatusText('Envoi…')).toBe('Envoi…');
    expect(staticStatusText('Vérification...')).toBe('Vérification…');
  });
  it('a loading button always has a word: its own, else the generic default — never empty', () => {
    expect(resolveLoadingWord('Suppression')).toBe('Suppression');
    expect(resolveLoadingWord('Envoi…')).toBe('Envoi');
    expect(resolveLoadingWord(undefined)).toBe(DEFAULT_LOADING_WORD);
    expect(resolveLoadingWord('  ')).toBe(DEFAULT_LOADING_WORD);
  });
});

describe('Button / LoadingStatus source contract', () => {
  const button = read('src/components/ui/Button.tsx');
  const status = read('src/components/ui/LoadingStatus.tsx');

  it('Button has no lone spinner and renders the status word while loading', () => {
    expect(button).not.toMatch(/ActivityIndicator/);
    expect(button).toMatch(/<LoadingStatus/);
    expect(button).toMatch(/resolveLoadingWord\(loadingLabel\)/);
    expect(button).toMatch(/isDisabled = disabled \|\| loading/);
  });
  it('dots animate on the native thread with transforms only', () => {
    expect(status).toMatch(/useNativeDriver: true/);
    expect(status).toMatch(/translateY/);
    expect(status).not.toMatch(/useNativeDriver: false/);
  });
  it('reduced motion renders static text', () => {
    expect(status).toMatch(/isReduceMotionEnabled/);
    expect(status).toMatch(/reduceMotionChanged/);
    expect(status).toMatch(/if \(reduceMotion\)/);
  });
  it('no Button label is a dead loading ternary (label={x ? "Word…" : ...} next to loading=)', () => {
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(path.resolve(__dirname, '..', dir), { withFileTypes: true })) {
        const rel = path.join(dir, e.name);
        if (e.isDirectory()) walk(rel);
        else if (/\.tsx$/.test(e.name)) {
          read(rel).split('\n').forEach((line, i) => {
            if (/<Button[^>]*label=\{\w+ \? '[^']*…'/.test(line) || /^\s*label=\{[\w.]+ \? '[^']*…' :/.test(line)) offenders.push(`${rel}:${i + 1}`);
          });
        }
      }
    };
    walk('app'); walk('src');
    expect(offenders).toEqual([]);
  });
});

describe('OTP verification screen contract', () => {
  const otp = read('src/components/ui/OtpInput.tsx');
  it('one state (steady border on all boxes) + one motion (caption beneath); no spinner', () => {
    expect(otp).toMatch(/boxVerifying/);
    expect(otp).toMatch(/verifying && styles\.boxVerifying/);
    expect(otp).toMatch(/word="Vérification"/);
    expect(otp).not.toMatch(/ActivityIndicator/);
  });
  it('input is inert while verifying', () => {
    expect(otp).toMatch(/if \(verifying\) return;/);
    expect(otp).toMatch(/editable=\{!disabled && !verifying\}/);
  });
  const screens = ['connexion', 'rejoindre', 'creer', 'recuperation'].map(n => [n, read(`app/(welcome)/${n}.tsx`)] as const);
  it.each(screens)('%s: resend shows the cooldown, is untappable mid-flight and never carries the spinner', (_n, src) => {
    expect(src).toMatch(/Renvoyer le code dans \$\{resendCooldown\.secondsLeft\} s/);
    expect(src).toMatch(/disabled=\{!resendCooldown\.isDone \|\| loading\}/);
    expect(src).not.toMatch(/ActivityIndicator/);
    const resend = src.slice(src.indexOf('Renvoyer le code'), src.indexOf('Renvoyer le code') + 400);
    expect(resend).not.toMatch(/loading=\{loading\}/);
  });
  it.each(screens.filter(([n]) => n !== 'recuperation'))('%s: "Changer de numéro" is inert during the flight', (_n, src) => {
    expect(src).toMatch(/label="Changer de numéro"\s+variant="ghost"\s+disabled=\{loading\}/);
  });
  it('milestone phone: "Changer de numéro" is inert during the flight', () => {
    expect(read('app/(app)/milestone/phone.tsx')).toMatch(/label="Changer de numéro"\s+variant="ghost"\s+disabled=\{loading\}/);
  });
});
