import { createElement, Fragment, type ReactElement, type ReactNode } from 'react';
import type { FetchStatus } from '@/lib/fetchStatus';
import { resolveDataState } from './dataState';

interface DataStateProps {
  status: FetchStatus;
  /** True when there are no rows to render (an empty list, or a null payload). */
  isEmpty: boolean;
  /** The screen's existing skeleton UI — the only place one may be rendered. */
  skeleton: ReactNode;
  /** The screen's existing empty / no-results UI. */
  empty: ReactNode;
  /** The screen's existing error UI. Falls back to `empty` when omitted. */
  error?: ReactNode;
  children: ReactNode;
}

/**
 * Enforces the data-state invariant (CLAUDE.md "Data-state invariant"): a
 * skeleton renders only for an unresolved fetch with nothing to show, never
 * for a loaded-but-empty list. Screens must not render a Skeleton* component
 * anywhere else — scripts/lib/consistency-checks.js fails CI if they do.
 */
export function DataState({ status, isEmpty, skeleton, empty, error, children }: DataStateProps): ReactElement {
  // createElement (not JSX) so the gate stays importable from the repo's
  // JSX-less Jest setup and is covered by __tests__/data-state.test.ts.
  switch (resolveDataState(status, isEmpty)) {
    case 'skeleton': return createElement(Fragment, null, skeleton);
    case 'error': return createElement(Fragment, null, error ?? empty);
    case 'empty': return createElement(Fragment, null, empty);
    default: return createElement(Fragment, null, children);
  }
}
