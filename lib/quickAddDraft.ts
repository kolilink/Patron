// TEMPORARY — quick-add draft persistence.
// When the catalogue → Vendre merge lands, in-progress products move to the "À compléter" home in
// Gérer mode and the quick-add sheet opens FRESH every time. At that point this whole file and the
// restore-on-open behaviour in QuickAddProductSheet are REPLACED, not layered on.
//
// Local-only by design: stored in the device's SQLite kv_store (survives an app restart, wiped on
// account deletion with every other kv row). A draft is never synced and never touches the outbox.

import { getKV, setKV } from '@/lib/db';
import { isBlankDraft, type QuickAddState } from '@/src/utils/quickAddProduct';

const keyFor = (businessId: string) => `quick_add_draft_${businessId}`;

function isState(x: unknown): x is QuickAddState {
  const o = x as Partial<QuickAddState> | null;
  return !!o && typeof o === 'object' && typeof o.name === 'string' && typeof o.price === 'string' &&
    typeof o.qty === 'string' && typeof o.models === 'boolean' && Array.isArray(o.variants);
}

/** Last draft wins. A blank state clears the stored draft (there is no kv delete: '' means none). */
export async function saveQuickAddDraft(businessId: string, state: QuickAddState): Promise<void> {
  if (!businessId) return;
  await setKV(keyFor(businessId), isBlankDraft(state) ? '' : JSON.stringify(state));
}

export async function loadQuickAddDraft(businessId: string): Promise<QuickAddState | null> {
  if (!businessId) return null;
  const raw = await getKV(keyFor(businessId));
  if (!raw) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return null; } // corrupt draft = no draft
  return isState(parsed) && !isBlankDraft(parsed) ? parsed : null;
}

export async function clearQuickAddDraft(businessId: string): Promise<void> {
  if (!businessId) return;
  await setKV(keyFor(businessId), '');
}
