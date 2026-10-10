// Data-state invariant (see CLAUDE.md "Data-state invariant").
//
// A store's fetch status is one of four values. A skeleton may render ONLY
// while a screen has no data AND the status is not 'ready'; `loading` may ONLY
// be entered from 'idle' (never fetched for the current business) or 'error'
// (a retry with nothing to show). An empty array is valid data: it means
// 'ready', never 'loading'. Any fetch while 'ready' is a silent background
// refresh and never touches the status.
//
// Stores keep their legacy `loading` boolean, but only ever write it through
// the patches below, so it is always exactly `fetchStatus === 'loading'`.

export type FetchStatus = 'idle' | 'loading' | 'ready' | 'error';

export interface StatusPatch {
  fetchStatus: FetchStatus;
  loading: boolean;
}

/** Entering a fetch: idle/error -> loading; loading stays loading; ready is untouched (silent refresh). */
export function beginFetch(current: FetchStatus): StatusPatch {
  if (current === 'ready') return READY;
  return LOADING;
}

/** A fetch resolved with data — including a genuinely empty list. */
export const READY: StatusPatch = { fetchStatus: 'ready', loading: false };

const LOADING: StatusPatch = { fetchStatus: 'loading', loading: true };

/**
 * A fetch failed. With nothing ever shown the screen needs its error UI; once
 * the store is 'ready' a failed background refresh keeps the data on screen
 * (the store's `error` string still carries the reason).
 */
export function failFetch(current: FetchStatus): StatusPatch {
  if (current === 'ready') return READY;
  return { fetchStatus: 'error', loading: false };
}

/** Initial / post-reset value. */
export const IDLE: StatusPatch = { fetchStatus: 'idle', loading: false };

/**
 * The business was switched while a fetch was in flight: this result belongs to
 * another business and must not be written, but a fetch left at 'loading' would
 * strand the screen on a skeleton — so it falls back to 'idle' (never fetched
 * for what is now active). 'ready' / 'error' / 'idle' are left alone.
 */
export function abandonFetch(current: FetchStatus): Partial<StatusPatch> {
  return current === 'loading' ? IDLE : {};
}
