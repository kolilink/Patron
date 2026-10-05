// Patron's loading language: a status WORD (present participle: "Envoi",
// "Vérification", "Suppression") followed by three bouncing dots — never a
// lone spinner. Pure constants/helpers live here (no JSX) so they are unit
// tested; LoadingStatus.tsx renders them.

/** One full dot cycle. Every dot repeats on this period so the wave never drifts. */
export const DOT_CYCLE_MS = 1200;
/** How long a dot takes to rise (and, separately, to fall back). */
export const DOT_MOVE_MS = 300;
/** Start offset between neighbouring dots (the WhatsApp typing stagger). */
export const DOT_STAGGER_MS = 160;
export const DOT_COUNT = 3;
export const DOT_RISE_PX = 4;

/** Delay before dot `index` starts its bounce. */
export function dotDelay(index: number): number {
  return index * DOT_STAGGER_MS;
}

/** Idle time at the end of dot `index`'s cycle, so every dot's period is exactly DOT_CYCLE_MS. */
export function dotRest(index: number): number {
  return DOT_CYCLE_MS - dotDelay(index) - 2 * DOT_MOVE_MS;
}

/** What a status looks like as plain text — used for reduced-motion and accessibility labels. */
export function staticStatusText(word: string): string {
  return `${word.replace(/[….\s]+$/u, '')}…`;
}

export const DEFAULT_LOADING_WORD = 'Chargement';

/** The word a loading Button shows: its own `loadingLabel`, else the generic default. Never the idle label, never empty. */
export function resolveLoadingWord(loadingLabel?: string): string {
  const w = loadingLabel?.trim();
  return w ? w.replace(/[….\s]+$/u, '') : DEFAULT_LOADING_WORD;
}
