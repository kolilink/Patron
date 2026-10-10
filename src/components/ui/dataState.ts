import type { FetchStatus } from '@/lib/fetchStatus';

export type DataBranch = 'skeleton' | 'error' | 'empty' | 'content';

/**
 * The one place that decides what a data-backed screen shows.
 *
 *  - skeleton: only while there is nothing to show AND the data is not known
 *    yet ('idle' = first frame before the fetch starts, 'loading' = in flight).
 *    ready + empty can NEVER reach this branch.
 *  - error: a failed first load with nothing to show.
 *  - empty: confirmed zero rows.
 *  - content: anything else (real rows win over every status).
 */
export function resolveDataState(status: FetchStatus, isEmpty: boolean): DataBranch {
  if (!isEmpty) return 'content';
  if (status === 'idle' || status === 'loading') return 'skeleton';
  if (status === 'error') return 'error';
  return 'empty';
}
