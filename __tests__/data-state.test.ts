// DataState / resolveDataState — the single gate that decides skeleton vs
// error vs empty vs content. The load-bearing rule: a loaded ('ready') but
// empty list can NEVER render the skeleton. DataState is a hook-free function
// component, so it is called directly and the returned element tree inspected.

import { DataState } from '@/src/components/ui/DataState';
import { resolveDataState } from '@/src/components/ui/dataState';
import { beginFetch, failFetch, abandonFetch, READY, IDLE } from '@/lib/fetchStatus';
import type { FetchStatus } from '@/lib/fetchStatus';

const SKELETON = { tag: 'skeleton' };
const EMPTY = { tag: 'empty' };
const ERROR = { tag: 'error' };
const CONTENT = { tag: 'content' };

// The fragment DataState returns wraps exactly one child slot.
function rendered(status: FetchStatus, isEmpty: boolean, withError = true): unknown {
  const el: any = DataState({
    status,
    isEmpty,
    skeleton: SKELETON as any,
    empty: EMPTY as any,
    error: withError ? (ERROR as any) : undefined,
    children: CONTENT as any,
  });
  return el.props.children;
}

describe('DataState — all four branches', () => {
  it('loading + nothing to show → skeleton slot', () => {
    expect(rendered('loading', true)).toBe(SKELETON);
  });

  it('idle (first frame before the fetch starts) + nothing to show → skeleton slot', () => {
    expect(rendered('idle', true)).toBe(SKELETON);
  });

  it('error + nothing to show → error slot', () => {
    expect(rendered('error', true)).toBe(ERROR);
  });

  it('error without an error slot falls back to the empty slot', () => {
    expect(rendered('error', true, false)).toBe(EMPTY);
  });

  it('ready + empty → empty slot', () => {
    expect(rendered('ready', true)).toBe(EMPTY);
  });

  it('ready + rows → children', () => {
    expect(rendered('ready', false)).toBe(CONTENT);
  });
});

describe('ready + empty NEVER renders the skeleton', () => {
  it('for every status the skeleton is reachable only from idle/loading', () => {
    const statuses: FetchStatus[] = ['idle', 'loading', 'ready', 'error'];
    for (const status of statuses) {
      for (const isEmpty of [true, false]) {
        const out = rendered(status, isEmpty);
        const skeletonShown = out === SKELETON;
        expect(skeletonShown).toBe(isEmpty && (status === 'idle' || status === 'loading'));
      }
    }
    expect(rendered('ready', true)).not.toBe(SKELETON);
  });

  it('real rows always win over a skeleton, even while loading or after an error', () => {
    expect(rendered('loading', false)).toBe(CONTENT);
    expect(rendered('idle', false)).toBe(CONTENT);
    expect(rendered('error', false)).toBe(CONTENT);
  });

  it('resolveDataState agrees', () => {
    expect(resolveDataState('ready', true)).toBe('empty');
    expect(resolveDataState('loading', true)).toBe('skeleton');
    expect(resolveDataState('error', true)).toBe('error');
    expect(resolveDataState('ready', false)).toBe('content');
  });
});

describe('fetchStatus transitions', () => {
  it('idle and error enter loading; loading stays loading', () => {
    expect(beginFetch('idle')).toEqual({ fetchStatus: 'loading', loading: true });
    expect(beginFetch('error')).toEqual({ fetchStatus: 'loading', loading: true });
    expect(beginFetch('loading')).toEqual({ fetchStatus: 'loading', loading: true });
  });

  it('ready never re-enters loading — a refetch is silent', () => {
    expect(beginFetch('ready')).toEqual({ fetchStatus: 'ready', loading: false });
  });

  it('a failure with nothing shown is error; with data on screen it stays ready', () => {
    expect(failFetch('loading')).toEqual({ fetchStatus: 'error', loading: false });
    expect(failFetch('idle')).toEqual({ fetchStatus: 'error', loading: false });
    expect(failFetch('ready')).toEqual({ fetchStatus: 'ready', loading: false });
  });

  it('an abandoned (stale-business) fetch cannot strand a loading status', () => {
    expect(abandonFetch('loading')).toEqual(IDLE);
    expect(abandonFetch('ready')).toEqual({});
  });

  it('the loading boolean is always exactly status === loading', () => {
    for (const s of ['idle', 'loading', 'ready', 'error'] as FetchStatus[]) {
      for (const patch of [beginFetch(s), failFetch(s), READY, IDLE]) {
        expect(patch.loading).toBe(patch.fetchStatus === 'loading');
      }
    }
  });
});
